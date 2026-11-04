/**
 * RIAF 2.0 façade: the framework's riaf-core API —
 * index(repo), update(paths), search(query), expand(node, hops), history(node), compile(intent, budget), render(pack, target),
 * plus lookup() (the read-side of the governor: answers file / symbol / grep questions from the index).
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RiafIndex, type RiafConfig, type ChunkSearchResult, type IndexProgress } from '../riafIndex.js';
import { deriveArchitecture, formatArchitecture, formatConventions, listDir, type ArchitectureFacts } from './architecture.js';
import { PackCompiler, slicePack, type CompileOptions } from './compiler.js';
import { formatHistoryCard, GitHistory, type HistoryOptions, type HistoryCard } from './gitHistory.js';
import type { ContextPack } from './packTypes.js';
import { render, type RenderTarget } from './render.js';
import { V2Store } from './store.js';
import { SummaryTree, type Summarize } from './summaries.js';

export interface Riaf2Config extends RiafConfig {
	history?: HistoryOptions | false;
	/** Summariser for file/dir summaries (defaults to `summarize` from RiafConfig when `llmSummaries` is true). */
	llmSummaries?: boolean;
}

export interface LookupResult {
	hit: boolean;
	kind: 'file' | 'range' | 'symbol' | 'search' | 'listing' | 'miss';
	path?: string;
	blob?: string;
	content: string;
	/** Best indexed alternative on a miss. */
	alternatives?: string[];
}

export interface ExpandResult {
	node: string;
	imports: string[];
	importedBy: string[];
	tests: string[];
	callers: string[];
	callees: string[];
	coChanges: { path: string; support: number; confidence: number }[];
	outline: string[];
	text: string;
}

export const blobHash = (content: string): string => createHash('sha256').update(content).digest('hex').slice(0, 32);

const gitOut = (root: string, args: string[]): Promise<string> => new Promise(res => execFile('git', args, { cwd: root, windowsHide: true }, (e, out) => res(e ? '' : out.trim())));

export class Riaf2 {
	readonly store: V2Store;
	readonly history?: GitHistory;
	readonly summaries: SummaryTree;
	readonly compiler: PackCompiler;
	private _arch: { at: number; facts: ArchitectureFacts } | null = null;

	private constructor(readonly index: RiafIndex, readonly cfg: Riaf2Config) {
		this.store = new V2Store(index.db);
		this.history = cfg.history === false ? undefined : new GitHistory(this.store, index.workspaceRoot, { log: cfg.log, ...(cfg.history ?? {}) });
		const summarize: Summarize | undefined = cfg.llmSummaries && cfg.summarize ? cfg.summarize : undefined;
		this.summaries = new SummaryTree(this.store, index, summarize);
		this.compiler = new PackCompiler({
			index, store: this.store, history: this.history, summaries: this.summaries,
			architecture: () => this.architecture(),
			head: () => this.head(),
			branch: () => gitOut(index.workspaceRoot, ['branch', '--show-current']),
			log: cfg.log,
		});
	}

	static async open(cfg: Riaf2Config): Promise<Riaf2> {
		return new Riaf2(await RiafIndex.open(cfg), cfg);
	}

	/** Wrap an already-open index (the MCP server and the extension own theirs). */
	static fromIndex(index: RiafIndex, cfg: Partial<Riaf2Config> = {}): Riaf2 {
		return new Riaf2(index, { workspaceRoot: index.workspaceRoot, dbPath: '', ...cfg });
	}

	get root(): string { return this.index.workspaceRoot; }

	async head(): Promise<string | null> { return (await gitOut(this.root, ['rev-parse', 'HEAD'])) || null; }

	/** index(repo): full or incremental index + history mining + summary tree. */
	async indexRepo(opts: { force?: boolean; onProgress?: (p: IndexProgress) => void } = {}): Promise<{ files: number; chunks: number; commits: number; summaries: number; ms: number }> {
		const t0 = Date.now();
		const stats = await this.index.reindex({ force: opts.force, onProgress: opts.onProgress });
		const mined = this.history ? await this.history.mine().catch(e => { this.cfg.log?.(`[history] ${String(e)}`); return { totalCommits: 0 }; }) : { totalCommits: 0 };
		const sums = await this.summaries.build();
		this._arch = null;
		return { files: stats.indexedFileCount, chunks: stats.chunkCount, commits: mined.totalCommits, summaries: sums.regenerated, ms: Date.now() - t0 };
	}

	/** update(paths): incremental re-index of changed files (write-aware invalidation calls this). */
	async update(paths: string[]): Promise<void> {
		await this.index.indexFiles(paths);
		await this.summaries.build({ maxLlmCalls: 5 }).catch(() => undefined);
		this.compiler.refreshCurrent(paths);
	}

	async architecture(): Promise<ArchitectureFacts> {
		const at = this.index.getStatus().lastIndexedAt ?? 0;
		if (!this._arch || this._arch.at !== at) this._arch = { at, facts: await deriveArchitecture(this.index) };
		return this._arch.facts;
	}

	async conventionsText(): Promise<string> { return formatConventions(await this.architecture()); }
	async architectureText(): Promise<string> { return formatArchitecture(await this.architecture()); }

	/** search(query, {lexical, semantic, structural}). */
	async search(query: string, opts: { limit?: number; pathPrefix?: string; mode?: 'hybrid' | 'lexical' | 'structural' } = {}): Promise<ChunkSearchResult[] | { name: string; kind: string; filePath: string; startLine: number; signature: string }[]> {
		if (opts.mode === 'structural') return (await this.index.searchSymbols(query, opts.limit ?? 15)).map(s => ({ name: s.name, kind: s.kind, filePath: s.filePath, startLine: s.startLine, signature: s.signature }));
		if (opts.mode === 'lexical') return this.index.searchBM25(query, { limit: opts.limit ?? 10, filePathPrefix: opts.pathPrefix });
		return this.index.searchHybrid(query, { limit: opts.limit ?? 10, filePathPrefix: opts.pathPrefix });
	}

	/** expand(node, hops): structural + history neighbourhood of a file or `path#Symbol`. */
	async expand(node: string, hops = 1): Promise<ExpandResult> {
		const [path, symbol] = node.split('#');
		const rel = path.replace(/^\.?\//, '');
		const g = await this.index.getImportGraph(rel).catch(() => ({ imports: [] as string[], importedBy: [] as string[], externalDeps: [] as string[] }));
		const tests = (await this.index.getTestsForFile(rel).catch(() => [])).map(t => t.testFile);
		const nb = await this.index.getNeighbors(rel, symbol).catch(() => null);
		const callers = [...new Set((nb?.inbound ?? []).filter(e => e.fromFile !== rel && e.edgeType !== 'imports').map(e => `${e.fromFile}${e.fromSymbol ? `#${e.fromSymbol}` : ''} ${e.edgeType} ${e.toName}`))].slice(0, 20);
		const callees = [...new Set((nb?.outbound ?? []).filter(e => e.toFile && e.toFile !== rel && e.edgeType !== 'imports').map(e => `${e.toName} (${e.toFile}) ${e.edgeType}`))].slice(0, 20);
		const coChanges = this.history?.coChanged(rel, 8).map(c => ({ path: c.path, support: c.support, confidence: Math.round(c.confidence * 100) / 100 })) ?? [];
		const outline = (await this.index.getFileOutline(rel).catch(() => [])).map(s => `${s.startLine}: ${s.kind} ${s.signature?.replace(/\s+/g, ' ').slice(0, 140) || s.name}`);
		let imports = g.imports; let importedBy = g.importedBy;
		if (hops >= 2) {
			const second = await Promise.all(g.imports.slice(0, 6).map(p => this.index.getImportGraph(p).catch(() => ({ imports: [] as string[], importedBy: [] as string[] }))));
			imports = [...new Set([...imports, ...second.flatMap(s => s.imports.map(x => `${x} (2 hops)`))])].slice(0, 30);
			const secondIn = await Promise.all(g.importedBy.slice(0, 6).map(p => this.index.getImportGraph(p).catch(() => ({ imports: [] as string[], importedBy: [] as string[] }))));
			importedBy = [...new Set([...importedBy, ...secondIn.flatMap(s => s.importedBy.map(x => `${x} (2 hops)`))])].slice(0, 30);
		}
		const sec = (title: string, list: string[]) => list.length ? `${title}:\n${list.map(x => `- ${x}`).join('\n')}` : '';
		const text = [
			`Neighbourhood of ${node}${hops > 1 ? ` (${hops} hops)` : ''}`,
			this.summaries.get('file', rel) ? `Summary: ${this.summaries.get('file', rel)}` : '',
			sec('Outline', outline.slice(0, 40)), sec('Imports', imports), sec('Imported by', importedBy), sec('Tests', tests),
			sec('Callers', callers), sec('Callees', callees), sec('Co-changes (history)', coChanges.map(c => `${c.path} (${c.support}×, ${Math.round(c.confidence * 100)}%)`)),
		].filter(Boolean).join('\n\n');
		return { node, imports, importedBy, tests, callers, callees, coChanges, outline, text };
	}

	/** history(node): history card for a file (roles by default). */
	historyCard(path: string, showNames = false): { card: HistoryCard; text: string } | null {
		if (!this.history) return null;
		const card = this.history.card(path.replace(/^\.?\//, ''));
		return { card, text: formatHistoryCard(card, { showNames }) };
	}

	/** compile(intent, budget) → Pack. */
	compile(request: string, opts: CompileOptions = {}): Promise<ContextPack> { return this.compiler.compile(request, opts); }

	currentPack(scope?: string): ContextPack | undefined {
		const p = this.compiler.currentPack();
		return p && scope ? slicePack(p, scope) : p;
	}

	render(pack: ContextPack, target: RenderTarget, opts: { budget?: number } = {}): string { return render(pack, target, opts); }

	/**
	 * lookup: answer a read question from the index before a tool runs.
	 *   { path, range? } → file content (from disk, verified by blob hash) or the range
	 *   { symbol }       → definition source + location
	 *   { query }        → indexed search results
	 *   { dir }          → directory listing
	 */
	async lookup(q: { path?: string; range?: [number, number]; symbol?: string; query?: string; dir?: string; limit?: number }): Promise<LookupResult> {
		if (q.path) {
			const rel = q.path.replace(/^\.?\//, '').replace(this.root.replace(/\\/g, '/') + '/', '');
			let text: string;
			try { text = readFileSync(join(this.root, rel), 'utf8'); } catch {
				const alts = (await this.index.searchSymbols(rel.split('/').pop()!.replace(/\.\w+$/, ''), 5)).map(s => s.filePath);
				return { hit: false, kind: 'miss', content: `No file ${rel} in the workspace.`, alternatives: [...new Set(alts)] };
			}
			const blob = blobHash(text);
			if (q.range) {
				const lines = text.split('\n');
				const [a, b] = [Math.max(1, q.range[0]), Math.min(lines.length, q.range[1])];
				return { hit: true, kind: 'range', path: rel, blob, content: lines.slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join('\n') };
			}
			return { hit: true, kind: 'file', path: rel, blob, content: text };
		}
		if (q.symbol) {
			const name = q.symbol.split('.').pop()!;
			const syms = (await this.index.searchSymbols(name, 10)).filter(s => s.name === name);
			if (!syms.length) {
				const alts = (await this.index.searchSymbols(name, 5)).map(s => `${s.name} (${s.filePath}:${s.startLine})`);
				return { hit: false, kind: 'miss', content: `Symbol ${q.symbol} not found in the index.`, alternatives: alts };
			}
			const parts: string[] = [];
			for (const s of syms.slice(0, 3)) {
				let body = '';
				try { body = readFileSync(join(this.root, s.filePath), 'utf8').split('\n').slice(s.startLine - 1, Math.min(s.endLine, s.startLine + 150)).join('\n'); } catch { /* deleted */ }
				parts.push(`### ${s.kind} ${s.name} — ${s.filePath}:${s.startLine}-${s.endLine}\n${body}`);
			}
			return { hit: true, kind: 'symbol', path: syms[0].filePath, content: parts.join('\n\n') };
		}
		if (q.dir !== undefined) {
			const rel = q.dir.replace(/^\.?\//, '').replace(/\/$/, '');
			const entries = listDir(this.root, rel);
			return entries.length ? { hit: true, kind: 'listing', path: rel || '.', content: entries.join('\n') } : { hit: false, kind: 'miss', content: `No directory ${rel}.` };
		}
		if (q.query) {
			const hits = await this.index.searchHybrid(q.query, { limit: q.limit ?? 8 });
			return hits.length
				? { hit: true, kind: 'search', content: hits.map(h => `### ${h.filePath}:${h.startLine}-${h.endLine}\n${h.content}`).join('\n\n') }
				: { hit: false, kind: 'miss', content: `No indexed matches for "${q.query}".` };
		}
		return { hit: false, kind: 'miss', content: 'lookup needs path, symbol, dir or query' };
	}

	async close(): Promise<void> { await this.index.close(); }
}
