/**
 * Pillar 2 — intent-to-context compiler. request → ParsedIntent → seeds (lexical, semantic, structural,
 * intent tier) fused with RRF → 1–2 hop graph expansion (imports, importers, tests, co-change, callers,
 * manifests) → ranking (relevance, centrality, history, task prior) → budgeted selection of forms
 * (body → signatures → summary) → assembled Context Pack with `why` per item and `known_facts`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RiafIndex } from '../riafIndex.js';
import type { ExtractedSymbol } from '../repoIntelligenceTypes.js';
import { formatHistoryCard, GitHistory, isVendored, type IntentClass } from './gitHistory.js';
import { parseIntent, type IntentType, type ParsedIntent } from './intent.js';
import { PACK_SCHEMA_VERSION, type ContextPack, type PackItem, type PackItemForm, type PackItemKind } from './packTypes.js';
import type { V2Store } from './store.js';
import type { SummaryTree } from './summaries.js';
import { estimateTokens } from './tokens.js';
import { globToRegExp, manifestKind, type ArchitectureFacts } from './architecture.js';

export const RANKER_VERSION = 'r2-rank-1';
/** RRF constant. Lower than the classic 60 because the lists are short (≤ 40) and top ranks must stay distinct. */
const RRF_K = 10;
const DAY = 86_400_000;

export interface CompileOptions {
	budget?: number;
	modelHint?: string;
	activeFile?: string;
	selection?: string;
	/** Restrict candidates to a path prefix (child packs for sub-agents). */
	scope?: string;
	/** Stage checkpoint name (explore | plan | implement | verify). */
	stage?: string;
	/** Output to append (e.g. failing test output) when re-using the previous pack for a stage. */
	appendOutput?: string;
	/** Force a full recompile even when an identical pack exists for this HEAD. */
	fresh?: boolean;
	/** Show author names instead of roles (local sessions only). */
	showAuthorNames?: boolean;
	/** Evaluation: only use history strictly before this timestamp (held-out commits). */
	historyBeforeTs?: number;
	/** Do not record the pack as the current pack (evaluation runs). */
	persist?: boolean;
}

export interface CompilerDeps {
	index: RiafIndex;
	store: V2Store;
	history?: GitHistory;
	summaries?: SummaryTree;
	architecture: () => Promise<ArchitectureFacts>;
	head: () => Promise<string | null>;
	branch?: () => Promise<string>;
	log?: (m: string) => void;
}

interface Candidate {
	path: string;
	rel: number;           // fused relevance (unnormalised)
	reasons: string[];
	ranges: [number, number][];
	symbols: ExtractedSymbol[];
	isSeed: boolean;
	explicit: boolean;
	hop: number;
	coChange: number;
	kind: PackItemKind;
	final?: number;
}

const contentHash = (content: string): string => createHash('sha256').update(content).digest('hex').slice(0, 32);
const isTest = (p: string) => /\.(test|spec)\.[a-z]+$|Test\.(java|kt)$|_test\.(py|go|rs)$|(^|\/)test_[^/]+\.py$|(^|\/)(__tests__|tests?)\//i.test(p);
const isDoc = (p: string) => /\.(md|rst|adoc|txt)$/i.test(p);
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

const TASK_PRIOR: Record<IntentType, { test: number; manifest: number; doc: number; source: number }> = {
	bugfix: { test: 0.8, manifest: 0.15, doc: 0.1, source: 0.7 },
	feature: { test: 0.5, manifest: 0.3, doc: 0.2, source: 0.7 },
	refactor: { test: 0.65, manifest: 0.2, doc: 0.1, source: 0.7 },
	explain: { test: 0.3, manifest: 0.3, doc: 0.8, source: 0.7 },
	test: { test: 1.0, manifest: 0.3, doc: 0.1, source: 0.7 },
	migrate: { test: 0.5, manifest: 1.0, doc: 0.4, source: 0.6 },
	review: { test: 0.6, manifest: 0.2, doc: 0.2, source: 0.7 },
};

const INTENT_TO_COMMIT: Record<IntentType, IntentClass | undefined> = { bugfix: 'fix', feature: 'feature', refactor: 'refactor', explain: undefined, test: 'test', migrate: 'chore', review: undefined };

const PLAN: Record<IntentType, string[]> = {
	bugfix: ['Reproduce: find or write a failing test for the reported behaviour', 'Locate the root cause in the seed items (follow callers/callees in the pack before reading more files)', 'Fix with the smallest change that respects the constraints', 'Run the covering tests and the linter'],
	feature: ['Confirm where the feature belongs (packages / entry points in the architecture block)', 'Extend the public API surface first, then the implementation', 'Add tests next to the existing ones', 'Run build, tests and lint'],
	refactor: ['List every caller of the symbols being changed (pack items marked "called by")', 'Change the definition and all callers in one pass', 'Keep behaviour identical: run the full covering test set', 'Check co-changing files listed in the history block'],
	explain: ['Start from the entry points and the seed items', 'Follow the call/import edges in the pack', 'Answer with file:line references from the pack'],
	test: ['Read the unit under test (seed items) and its existing tests', 'Add cases for the uncovered behaviour and edge cases', 'Run only the affected test files, then the full suite'],
	migrate: ['Inventory affected manifests and call sites (manifest items)', 'Upgrade the manifest / dependency first, then fix compile errors', 'Follow decisions in the history block (do not reintroduce rejected approaches)', 'Run build and full tests'],
	review: ['Read the changed files and their co-changing partners', 'Check constraints, conventions and hot-spot warnings', 'Verify tests cover the change'],
};

export class PackCompiler {
	constructor(private readonly d: CompilerDeps) { }

	private get root(): string { return this.d.index.workspaceRoot; }

	private readFile(path: string): string | null {
		try { return readFileSync(join(this.root, path), 'utf8'); } catch { return null; }
	}

	async compile(request: string, opts: CompileOptions = {}): Promise<ContextPack> {
		const t0 = Date.now();
		const budget = Math.max(512, opts.budget ?? 24_000);
		const head = await this.d.head();
		const intent = parseIntent(request, { activeFile: opts.activeFile, selection: opts.selection });
		const intentKey = createHash('sha256').update(`${request.trim().toLowerCase()}\u0000${opts.scope ?? ''}\u0000${budget}`).digest('hex').slice(0, 24);
		const previous = opts.persist === false ? undefined : this.latestPack(intentKey);

		// Stage checkpoint: re-use the previous pack on the same HEAD and append the stage output.
		if (previous && opts.appendOutput && previous.repo.head === head) {
			const out = opts.appendOutput.slice(-6_000);
			const item: PackItem = { kind: 'summary', path: `(stage:${opts.stage ?? 'verify'} output)`, content: out, score: 1, tokens: estimateTokens(out), why: `output of the ${opts.stage ?? 'verify'} stage, appended to the previous pack instead of recompiling` };
			const next: ContextPack = { ...previous, pack_id: randomUUID(), items: [item, ...previous.items], provenance: { ...previous.provenance, stage: opts.stage ?? 'verify', parent_pack: previous.pack_id, generated_at: new Date().toISOString(), compile_ms: Date.now() - t0 } };
			rebudget(next, budget);
			this.savePack(next, intentKey);
			return next;
		}
		if (previous && !opts.fresh && previous.repo.head === head && !opts.stage && this.d.index.getStatus().lastIndexedAt && Date.parse(previous.provenance.generated_at) >= (this.d.index.getStatus().lastIndexedAt ?? 0)) {
			return previous;
		}

		const arch = await this.d.architecture();
		const generated = arch.generatedPatterns.map(globToRegExp);
		const isGenerated = (p: string) => isVendored(p) || /(^|\/)generated\//.test(p) || generated.some(re => re.test(p));
		const inScope = (p: string) => !opts.scope || p.startsWith(opts.scope.replace(/^\.\//, ''));
		const allFiles = new Set((await this.d.index.db.getFileMetadata(this.d.index.workspaceHash)).map(f => f.filePath));
		const retrievers: Record<string, number> = {};
		const cands = new Map<string, Candidate>();
		const cand = (path: string, kind: PackItemKind = 'file'): Candidate => {
			let c = cands.get(path);
			if (!c) { c = { path, rel: 0, reasons: [], ranges: [], symbols: [], isSeed: false, explicit: false, hop: 0, coChange: 0, kind }; cands.set(path, c); }
			return c;
		};
		const rrf = (list: { path: string; range?: [number, number]; why: string }[], name: string, weight = 1) => {
			retrievers[name] = list.length;
			// Rank files, not chunks: a file's first hit sets its rank, further chunks add a small bonus.
			const fileRank = new Map<string, number>();
			list.forEach(h => { if (!fileRank.has(h.path)) fileRank.set(h.path, fileRank.size); });
			const seenFile = new Set<string>();
			list.forEach(h => {
				if (!inScope(h.path)) return;
				const c = cand(h.path);
				const rank = fileRank.get(h.path)!;
				const docPenalty = isDoc(h.path) && intent.type !== 'explain' ? 0.5 : 1;
				c.rel += (seenFile.has(h.path) ? 0.1 : 1) * docPenalty * weight / (RRF_K + rank + 1);
				seenFile.add(h.path);
				c.isSeed = true;
				if (h.range && !c.ranges.some(r => r[0] === h.range![0])) c.ranges.push(h.range);
				if (!c.reasons.includes(h.why)) c.reasons.push(h.why);
			});
		};

		// 1. Entity resolution (structural retriever).
		const structural: { path: string; range?: [number, number]; why: string }[] = [];
		const symbolsResolved: { name: string; path: string; line: number }[] = [];
		for (const e of intent.entities) {
			if (e.kind === 'file') {
				const [p, line] = e.value.split(':');
				const norm = p.replace(/^\.?\//, '');
				const hit = allFiles.has(norm) ? norm : [...allFiles].find(f => f.endsWith(`/${norm}`) || f.endsWith(norm));
				if (hit) {
					e.resolved = [hit];
					const ln = Number(line);
					structural.push({ path: hit, range: ln ? [Math.max(1, ln - 20), ln + 20] : undefined, why: `named in the request (${e.value})` });
				}
			} else if (e.kind === 'symbol') {
				const name = e.value.split('.').pop()!;
				const syms = (await this.d.index.searchSymbols(name, 10)).filter(s => s.name === name || s.name.toLowerCase() === name.toLowerCase());
				if (syms.length) {
					e.resolved = syms.map(s => `${s.filePath}:${s.startLine}`);
					for (const s of syms.slice(0, 4)) {
						structural.push({ path: s.filePath, range: [s.startLine, s.endLine], why: `defines ${s.kind} ${s.name} named in the request` });
						symbolsResolved.push({ name: s.name, path: s.filePath, line: s.startLine });
						cand(s.filePath).symbols.push(s);
					}
				}
			}
		}
		for (const s of structural) cand(s.path).explicit = true;
		rrf(structural, 'structural', 2);

		// 2. Lexical + semantic seeds.
		// Prefix-matched FTS terms: drop short fragments ("pre", "get") that match half the repo.
		const lexTerms = intent.terms.filter(t => t.length >= 4 || /^[A-Z]+-\d+$/.test(t)).slice(0, 12);
		const lexical = lexTerms.length ? await this.d.index.searchBM25(lexTerms.join(' '), { limit: 40, filePathPrefix: opts.scope, maxChars: 0 }).catch(() => []) : [];
		rrf(lexical.map(h => ({ path: h.filePath, range: [h.startLine, h.endLine] as [number, number], why: `matches the request text (BM25)` })), 'lexical');
		// Distinctive identifiers get their own query so common words cannot drown them.
		const ids = intent.entities.filter(e => e.kind === 'symbol').map(e => e.value.split('.').pop()!).filter(v => v.length >= 4);
		if (ids.length) {
			const idHits = await this.d.index.searchBM25(ids.join(' '), { limit: 15, filePathPrefix: opts.scope, maxChars: 0 }).catch(() => []);
			rrf(idHits.map(h => ({ path: h.filePath, range: [h.startLine, h.endLine] as [number, number], why: `mentions ${ids.join(', ')}` })), 'identifier', 1.2);
		}
		for (const e of intent.entities.filter(x => x.kind === 'error')) {
			const hits = await this.d.index.searchBM25(e.value, { limit: 5, filePathPrefix: opts.scope, maxChars: 0 }).catch(() => []);
			if (hits.length) e.resolved = hits.map(h => `${h.filePath}:${h.startLine}`);
			rrf(hits.map(h => ({ path: h.filePath, range: [h.startLine, h.endLine] as [number, number], why: `contains the error text "${e.value.slice(0, 40)}"` })), 'error', 1.5);
		}
		if (this.d.index.embeddingsEnabled) {
			const sem = await this.d.index.searchHybrid(request, { limit: 20, filePathPrefix: opts.scope, maxChars: 0 }).catch(() => []);
			rrf(sem.map(h => ({ path: h.filePath, range: [h.startLine, h.endLine] as [number, number], why: 'semantically similar to the request' })), 'semantic');
		}

		// 3. Intent tier: past commits with matching intent text.
		const relatedCommits = this.d.history ? this.d.history.searchCommits([...intent.terms, ...intent.entities.filter(e => e.kind === 'ticket').map(e => e.value)], 6, INTENT_TO_COMMIT[intent.type], opts.historyBeforeTs) : [];
		const hist0 = this.d.history;
		const heldOut = hist0 && opts.historyBeforeTs !== undefined ? hist0.computeCoChange(hist0.loadCommits({ beforeTs: opts.historyBeforeTs })) : null;
		const coChanged = (p: string) => !hist0 ? [] : heldOut ? GitHistory.neighborsFrom(heldOut, p, 6, 2).filter(n => n.confidence >= 0.3) : hist0.coChanged(p, 6, 0.3);
		const intentHits: { path: string; why: string }[] = [];
		for (const c of relatedCommits.slice(0, 4)) {
			if (c.files.length > 12) continue; // broad commits say little about where this task lives
			for (const f of c.files) if (allFiles.has(f) && !intentHits.some(h => h.path === f)) intentHits.push({ path: f, why: `changed in related commit ${c.sha.slice(0, 8)} (${c.intent}: ${c.subject.slice(0, 60)})` });
		}
		rrf(intentHits.slice(0, 12), 'intent_tier', 0.35);

		// Drop non-indexed / generated seeds.
		for (const [p, c] of cands) if (!allFiles.has(p) || (isGenerated(p) && !c.explicit)) cands.delete(p);

		// 4. Graph expansion (1–2 hops).
		const nodes = new Map<string, number>();
		try { for (const n of (await this.d.index.getGraph()).nodes) nodes.set(n.filePath, n.importedByCount); } catch { /* no graph */ }
		const seeds = [...cands.values()].sort((a, b) => b.rel - a.rel).slice(0, 10);
		const topRel = seeds[0]?.rel ?? 1;
		const expand = async (from: Candidate, hop: number) => {
			const base = from.rel * Math.pow(0.6, hop);
			const push = (path: string, w: number, why: string, kind: PackItemKind = 'file') => {
				if (path === from.path || !allFiles.has(path) || !inScope(path) || isGenerated(path)) return;
				const c = cand(path, kind);
				// Neighbours never outrank the seed that found them; a second parent adds a small bonus.
				const add = Math.min(base * w, from.rel * 0.9);
				if (c.isSeed) c.rel += kind === 'test' ? add * 0.15 : 0;
				else c.rel = c.rel ? Math.max(c.rel, add) + 0.15 * Math.min(c.rel, add) : add;
				c.hop = c.hop === 0 && !c.isSeed ? hop : Math.min(c.hop || hop, hop);
				if (c.reasons.length < 4 && !c.reasons.includes(why)) c.reasons.push(why);
				if (kind === 'test') c.kind = 'test';
				if (kind === 'manifest') c.kind = 'manifest';
			};
			const g = await this.d.index.getImportGraph(from.path).catch(() => ({ imports: [], importedBy: [], externalDeps: [] }));
			for (const p of g.imports.slice(0, 12)) push(p, 0.55, `imported by ${from.path}`);
			for (const p of g.importedBy.slice(0, 12)) push(p, 0.45, `imports ${from.path}`);
			const tests = await this.d.index.getTestsForFile(from.path).catch(() => []);
			for (const t of tests.slice(0, 4)) push(t.testFile, t.confidence === 'high' ? 0.8 : 0.6, `tests ${from.path}`, 'test');
			for (const n of coChanged(from.path)) {
				push(n.path, 0.35 + 0.5 * Math.min(1, n.confidence), `co-changes with ${from.path} in ${n.support} change units (${Math.round(n.confidence * 100)}%)`);
				const c = cands.get(n.path); if (c) c.coChange = Math.max(c.coChange, n.confidence);
			}
			if (hop === 1) {
				const nb = await this.d.index.getNeighbors(from.path).catch(() => null);
				const callers = new Set((nb?.inbound ?? []).filter(e => e.fromFile !== from.path && e.edgeType !== 'imports').map(e => e.fromFile));
				for (const p of [...callers].slice(0, 8)) push(p, 0.5, `calls into ${from.path}`);
				// Manifest that builds the seed.
				let d = dirOf(from.path);
				while (true) {
					const m = [...allFiles].find(f => dirOf(f) === d && manifestKind(f) && !/BUILD|CMakeLists/.test(f));
					if (m) { push(m, intent.type === 'migrate' ? 0.9 : 0.3, `manifest that builds ${from.path}`, 'manifest'); break; }
					if (!d) break;
					d = dirOf(d);
				}
			}
		};
		for (const s of seeds) await expand(s, 1);
		const hop2 = [...cands.values()].filter(c => !c.isSeed && c.rel > topRel * 0.35).sort((a, b) => b.rel - a.rel).slice(0, 4);
		for (const c of hop2) await expand(c, 2);
		retrievers.expansion = [...cands.values()].filter(c => !c.isSeed).length;

		// 5. Ranking.
		const prior = TASK_PRIOR[intent.type];
		const now = Date.now();
		const churn = new Map<string, { last: number; hot: number }>();
		for (const r of this.d.store.raw.all<{ path: string; last_ts: number; hotspot: number }>('SELECT path, last_ts, hotspot FROM file_churn')) churn.set(r.path, { last: r.last_ts, hot: r.hotspot });
		const maxRel = Math.max(...[...cands.values()].map(c => c.rel), 1e-9);
		for (const c of cands.values()) {
			if (isTest(c.path) && c.kind === 'file') c.kind = 'test';
			if (manifestKind(c.path) && c.kind === 'file') c.kind = 'manifest';
			const rel = c.rel / maxRel;
			const centrality = Math.min(1, Math.log1p(nodes.get(c.path) ?? 0) / Math.log(20));
			const ch = churn.get(c.path);
			const recency = ch ? Math.pow(0.5, Math.max(0, now - ch.last) / (180 * DAY)) : 0;
			const history = 0.4 * c.coChange + 0.3 * recency + 0.3 * Math.min(1, (ch?.hot ?? 0) / 3);
			const p = c.kind === 'test' ? prior.test : c.kind === 'manifest' ? prior.manifest : isDoc(c.path) ? prior.doc : prior.source;
			c.final = 0.55 * rel + 0.1 * centrality + 0.15 * history + 0.2 * p + (c.explicit ? 0.15 : 0);
		}
		const ranked = [...cands.values()].sort((a, b) => (b.final ?? 0) - (a.final ?? 0)).slice(0, 80);
		if (process.env.RIAF_DEBUG_RANK) for (const c of ranked.slice(0, 25)) this.d.log?.(`[rank] ${c.final?.toFixed(3)} rel=${(c.rel / maxRel).toFixed(3)} seed=${c.isSeed} ${c.kind} ${c.path} :: ${c.reasons.join(' | ')}`);

		// 6. Fixed sections (measured first so items get the remainder).
		const hist = this.d.history;
		const topPaths = ranked.slice(0, 8).map(c => c.path);
		const commits = new Map<string, { sha: string; date: string; intent: string; why: string; tickets: string[] }>();
		for (const c of relatedCommits) commits.set(c.sha, { sha: c.sha.slice(0, 12), date: new Date(c.ts).toISOString().slice(0, 10), intent: c.intent, why: c.why, tickets: c.tickets });
		if (hist) for (const p of topPaths.slice(0, 3)) for (const c of hist.commitsForFile(p, 2)) if (!commits.has(c.sha)) commits.set(c.sha, { sha: c.sha.slice(0, 12), date: new Date(c.ts).toISOString().slice(0, 10), intent: c.intent, why: c.why, tickets: c.tickets });
		const owners = hist ? topPaths.slice(0, 3).flatMap(p => hist.owners(p, 2).map(o => ({ path: p, role: o.role, share: o.share, ...(opts.showAuthorNames && o.authorName ? { name: o.authorName } : {}) }))) : [];
		const hotThreshold = hist ? hist.hotspotThreshold() : Infinity;
		const hotspots = hist ? ranked.slice(0, 20).map(c => ({ c, h: churn.get(c.path) })).filter(x => (x.h?.hot ?? 0) >= hotThreshold).slice(0, 3)
			.map(x => { const card = hist.card(x.c.path); return { path: x.c.path, commits365: card.hotspot?.commits365 ?? 0, fixRatio: card.hotspot?.fixRatio ?? 0 }; }) : [];
		const decisions = hist ? hist.decisions(topPaths, 3).map(d => ({ source: d.source, ref: d.source === 'commit' ? d.ref.slice(0, 12) : d.ref, text: d.text })) : [];

		const verification: string[] = [];
		const testItems = ranked.filter(c => c.kind === 'test').slice(0, 4).map(c => c.path);
		if (arch.test) verification.push(testItems.length ? `run ${arch.test} (covering tests: ${testItems.join(', ')})` : `run ${arch.test}`);
		if (arch.typecheck) verification.push(`run ${arch.typecheck}`);
		if (arch.lint) verification.push(`run ${arch.lint}`);
		for (const c of intent.constraints) verification.push(`confirm constraint holds: ${c}`);
		for (const a of intent.acceptance) verification.push(`confirm: ${a}`);
		if (!verification.length) verification.push('build the project and run its tests');

		const pack: ContextPack = {
			schema: PACK_SCHEMA_VERSION,
			pack_id: randomUUID(),
			repo: { root: this.root, head, branch: await this.d.branch?.().catch(() => undefined), index_version: `riaf-core/${this.d.index.getStatus().lastIndexedAt ?? 0}` },
			intent: { type: intent.type, summary: intent.summary, request, entities: intent.entities, constraints: intent.constraints, acceptance: intent.acceptance, open_questions: intent.open_questions, confidence: intent.confidence },
			budget: { max_tokens: budget, used_tokens: 0, model_hint: opts.modelHint ?? 'claude' },
			conventions: { languages: arch.languages, frameworks: arch.frameworks, build: arch.build, test_cmd: arch.test, lint: arch.lint, typecheck: arch.typecheck, style_notes: arch.styleNotes },
			architecture: { packages: arch.packages.slice(0, 25).map(p => ({ name: p.name, path: p.path, kind: p.kind })), entry_points: arch.entryPoints, summary: arch.summary, monorepo: arch.monorepo },
			items: [],
			history: { related_commits: [...commits.values()].slice(0, 8), owners, hotspots, decisions },
			plan_skeleton: PLAN[intent.type],
			verification,
			known_facts: { files_listed: [], files_read: [], ranges_read: [], symbols_resolved: symbolsResolved },
			provenance: { retrievers, ranker_version: RANKER_VERSION, generated_at: new Date().toISOString(), compile_ms: 0, scope: opts.scope, stage: opts.stage },
		};
		const fixedTokens = estimateTokens(JSON.stringify({ ...pack, items: [] })) + 200;
		let remaining = budget - fixedTokens;

		// 7. Item selection: preferred form first, degrade body → signatures → summary.
		const items: PackItem[] = [];
		const summaryOf = (p: string) => this.d.summaries?.get('file', p);
		const outlineCache = new Map<string, ExtractedSymbol[]>();
		const outline = async (p: string) => { if (!outlineCache.has(p)) outlineCache.set(p, await this.d.index.getFileOutline(p).catch(() => [])); return outlineCache.get(p)!; };
		for (const [i, c] of ranked.entries()) {
			if (remaining < 40 || items.length >= 60) break;
			const text = this.readFile(c.path);
			if (text === null) continue;
			const blob = contentHash(text);
			const lines = text.split('\n');
			const why = c.reasons.slice(0, 3).join('; ') || 'related by the index';
			const forms: { form: PackItemForm; content: string; range?: [number, number]; kind: PackItemKind }[] = [];
			const bodyTokens = estimateTokens(text);
			const sig = (await outline(c.path)).map(s => `${s.startLine}: ${(s.signature || `${s.kind} ${s.name}`).replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
			const summary = summaryOf(c.path) ?? '';
			const sigForm = sig ? `${summary ? `${summary}\n` : ''}${sig}` : '';
			const wantBody = c.explicit || i < 3 || c.kind === 'test' && bodyTokens < 1_500 || c.kind === 'manifest' || bodyTokens <= 150;
			// Quality rule: prefer signature+summary when the body is large and the item is not a top seed.
			if (c.kind === 'manifest') forms.push({ form: 'body', content: lines.slice(0, 80).join('\n'), range: [1, Math.min(lines.length, 80)], kind: 'manifest' });
			else if (wantBody && bodyTokens <= Math.max(1_200, remaining * 0.35)) forms.push({ form: 'body', content: text, range: [1, lines.length], kind: c.kind });
			else if (wantBody && c.ranges.length) {
				const merged = mergeRanges(c.ranges.map(r => [Math.max(1, r[0] - 3), Math.min(lines.length, r[1] + 3)] as [number, number]));
				for (const m of merged.slice(0, 3)) { const r: [number, number] = [m[0], Math.min(m[1], m[0] + 119)]; forms.push({ form: 'body', content: lines.slice(r[0] - 1, r[1]).join('\n'), range: r, kind: c.symbols.length ? 'symbol' : c.kind }); }
			}
			if (sigForm) forms.push({ form: 'signatures', content: sigForm, kind: c.kind });
			forms.push({ form: 'summary', content: summary || (sig ? sig.split('\n').slice(0, 3).join('; ') : lines.slice(0, 3).join(' ').slice(0, 200)), kind: c.kind });
			// Pick: all body ranges if they fit, else the first form that fits.
			const bodies = forms.filter(f => f.form === 'body');
			const bodyCost = bodies.reduce((s, f) => s + estimateTokens(f.content) + 30, 0);
			let chosen = bodies.length && bodyCost <= remaining ? bodies : [];
			if (!chosen.length) { const f = forms.find(f => f.form !== 'body' && estimateTokens(f.content) + 30 <= remaining); if (f) chosen = [f]; }
			for (const f of chosen) {
				const tokens = estimateTokens(f.content) + 30;
				const whole = f.form === 'body' && f.range && f.range[0] === 1 && f.range[1] === lines.length;
				items.push({ kind: f.kind, path: c.path, range: f.form === 'body' ? f.range : undefined, blob, form: f.form, content: f.content, score: Math.round((c.final ?? 0) * 1000) / 1000, tokens, why: f.form === 'body' ? why : `${why} (${f.form} only${bodies.length ? ' — body did not fit the budget' : ''})` });
				remaining -= tokens;
				if (whole) pack.known_facts.files_read.push({ path: c.path, blob });
				else if (f.form === 'body' && f.range) pack.known_facts.ranges_read.push({ path: c.path, range: f.range, blob });
				if (f.form === 'signatures') for (const s of await outline(c.path)) if (!pack.known_facts.symbols_resolved.some(x => x.name === s.name && x.path === c.path)) pack.known_facts.symbols_resolved.push({ name: s.name, path: c.path, line: s.startLine });
			}
		}
		// Upgrade pass: spend leftover budget turning top signature items into bodies.
		for (const it of items) {
			if (it.form !== 'signatures' || remaining < 200) continue;
			const text = this.readFile(it.path); if (!text) continue;
			const t = estimateTokens(text) + 30;
			if (t - it.tokens <= remaining) {
				remaining -= t - it.tokens;
				const n = text.split('\n').length;
				Object.assign(it, { form: 'body', content: text, range: [1, n], tokens: t, why: it.why.replace(/ \(signatures only[^)]*\)$/, '') });
				pack.known_facts.files_read.push({ path: it.path, blob: it.blob });
			}
		}
		// History cards for the top two seed files, and the directory listing of the top seed.
		if (hist) for (const c of ranked.filter(x => x.isSeed).slice(0, 2)) {
			const content = formatHistoryCard(hist.card(c.path), { showNames: opts.showAuthorNames });
			const tokens = estimateTokens(content) + 20;
			if (content.split('\n').length > 1 && tokens <= remaining) { items.push({ kind: 'history_card', path: c.path, content, score: 0, tokens, why: `history of seed ${c.path}` }); remaining -= tokens; }
		}
		const topDir = ranked[0] ? dirOf(ranked[0].path) : '';
		if (ranked[0]) {
			const entries = [...allFiles].filter(f => dirOf(f) === topDir).map(f => f.slice(topDir ? topDir.length + 1 : 0));
			const subdirs = [...new Set([...allFiles].filter(f => f.startsWith(topDir ? `${topDir}/` : '') && dirOf(f) !== topDir).map(f => f.slice(topDir ? topDir.length + 1 : 0).split('/')[0] + '/'))];
			const content = `${this.d.summaries?.get(topDir ? 'dir' : 'repo', topDir || '.') ?? ''}\nEntries (indexed): ${[...subdirs, ...entries].sort().join(', ')}`.trim();
			const tokens = estimateTokens(content) + 20;
			if (tokens <= remaining && entries.length) { items.push({ kind: 'summary', path: `${topDir || '.'}/`, content, score: 0, tokens, why: 'directory of the top seed (listing already known)' }); remaining -= tokens; pack.known_facts.files_listed.push(topDir || '.'); }
		}
		dedupeItems(items);
		pack.items = items;
		pack.budget.used_tokens = Math.min(budget, budget - remaining);
		pack.provenance.compile_ms = Date.now() - t0;
		if (previous) {
			const before = new Set(previous.items.map(i => i.path)); const after = new Set(items.map(i => i.path));
			pack.diff = { previous_pack: previous.pack_id, added: [...after].filter(p => !before.has(p)), removed: [...before].filter(p => !after.has(p)) };
		}
		if (opts.persist !== false) this.savePack(pack, intentKey);
		this.d.log?.(`[compile] ${intent.type} pack ${pack.items.length} items, ${pack.budget.used_tokens}/${budget} tokens in ${pack.provenance.compile_ms} ms`);
		return pack;
	}

	savePack(pack: ContextPack, intentKey: string): void {
		this.d.store.raw.tx(() => {
			this.d.store.raw.run('INSERT OR REPLACE INTO pack(pack_id, intent_key, head, created_at, intent_json, budget, used, json) VALUES (?,?,?,?,?,?,?,?)',
				[pack.pack_id, intentKey, pack.repo.head, Date.now(), JSON.stringify(pack.intent), pack.budget.max_tokens, pack.budget.used_tokens, JSON.stringify(pack)]);
			pack.items.forEach((it, i) => this.d.store.raw.run('INSERT OR REPLACE INTO pack_item(pack_id, ord, kind, path, score, tokens, why) VALUES (?,?,?,?,?,?,?)', [pack.pack_id, i, it.kind, it.path, it.score, it.tokens, it.why]));
			// Keep the last 50 packs.
			this.d.store.raw.run('DELETE FROM pack_item WHERE pack_id IN (SELECT pack_id FROM pack ORDER BY created_at DESC LIMIT -1 OFFSET 50)');
			this.d.store.raw.run('DELETE FROM pack WHERE pack_id IN (SELECT pack_id FROM pack ORDER BY created_at DESC LIMIT -1 OFFSET 50)');
		});
		this.d.store.setKv('pack.current', pack.pack_id);
	}

	latestPack(intentKey: string): ContextPack | undefined {
		const r = this.d.store.raw.get<{ json: string }>('SELECT json FROM pack WHERE intent_key = ? ORDER BY created_at DESC LIMIT 1', [intentKey]);
		return r ? JSON.parse(r.json) as ContextPack : undefined;
	}

	currentPack(): ContextPack | undefined {
		const id = this.d.store.getKv('pack.current');
		const r = id ? this.d.store.raw.get<{ json: string }>('SELECT json FROM pack WHERE pack_id = ?', [id]) : undefined;
		return r ? JSON.parse(r.json) as ContextPack : undefined;
	}

	/** Refresh items of the current pack whose file changed (write-aware invalidation). */
	refreshCurrent(paths: string[]): ContextPack | undefined {
		const pack = this.currentPack();
		if (!pack) return undefined;
		let changed = false;
		for (const it of pack.items) {
			if (!paths.includes(it.path) || it.form !== 'body') continue;
			const text = this.readFile(it.path);
			if (text === null) continue;
			const lines = text.split('\n');
			const whole = it.range?.[0] === 1;
			it.content = whole ? text : lines.slice((it.range?.[0] ?? 1) - 1, it.range?.[1]).join('\n');
			if (whole) it.range = [1, lines.length];
			it.blob = contentHash(text); it.tokens = estimateTokens(it.content) + 30; changed = true;
		}
		if (!changed) return pack;
		pack.known_facts.files_read = pack.known_facts.files_read.map(f => paths.includes(f.path) ? { path: f.path, blob: pack.items.find(i => i.path === f.path)?.blob } : f);
		pack.known_facts.ranges_read = pack.known_facts.ranges_read.map(f => paths.includes(f.path) ? { ...f, blob: pack.items.find(i => i.path === f.path)?.blob } : f);
		pack.budget.used_tokens = Math.min(pack.budget.max_tokens, pack.items.reduce((s, i) => s + i.tokens, 0) + estimateTokens(JSON.stringify({ ...pack, items: [] })));
		this.d.store.raw.run('UPDATE pack SET json = ? WHERE pack_id = ?', [JSON.stringify(pack), pack.pack_id]);
		return pack;
	}
}

export function mergeRanges(ranges: [number, number][]): [number, number][] {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
	const out: [number, number][] = [];
	for (const r of sorted) {
		const last = out[out.length - 1];
		if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else out.push([r[0], r[1]]);
	}
	return out;
}

/** Remove range items covered by a whole-file body of the same path; merge duplicate summaries. */
export function dedupeItems(items: PackItem[]): void {
	const whole = new Set(items.filter(i => i.form === 'body' && i.range?.[0] === 1 && i.kind !== 'manifest' && i.content.split('\n').length === i.range[1]).map(i => i.path));
	for (let i = items.length - 1; i >= 0; i--) {
		const it = items[i];
		if (whole.has(it.path) && it.kind !== 'history_card' && !(it.form === 'body' && it.range?.[0] === 1)) items.splice(i, 1);
	}
	const seen = new Set<string>();
	for (let i = 0; i < items.length; i++) {
		const k = `${items[i].path}|${items[i].form}|${items[i].range?.join('-') ?? ''}|${items[i].kind}`;
		if (seen.has(k)) { items.splice(i, 1); i--; } else seen.add(k);
	}
}

/** Shrink a pack to `max` tokens: downgrade bodies to their first lines, then drop lowest-scored items. */
export function rebudget(pack: ContextPack, max: number): ContextPack {
	const fixed = estimateTokens(JSON.stringify({ ...pack, items: [] })) + 200;
	let used = fixed + pack.items.reduce((s, i) => s + i.tokens, 0);
	const order = [...pack.items].sort((a, b) => a.score - b.score);
	for (const it of order) {
		if (used <= max) break;
		if (it.form === 'body' && it.tokens > 300 && it.kind !== 'summary') {
			const head = it.content.split('\n').slice(0, 25).join('\n') + '\n…';
			const t = estimateTokens(head) + 30;
			used -= it.tokens - t;
			it.content = head; it.tokens = t; it.form = 'summary'; it.why += ' (trimmed to fit the target budget)';
			pack.known_facts.files_read = pack.known_facts.files_read.filter(f => f.path !== it.path);
			pack.known_facts.ranges_read = pack.known_facts.ranges_read.filter(f => f.path !== it.path);
		}
	}
	while (used > max && pack.items.length) {
		let idx = 0;
		for (let i = 1; i < pack.items.length; i++) if (pack.items[i].score < pack.items[idx].score) idx = i;
		const [gone] = pack.items.splice(idx, 1);
		used -= gone.tokens;
		pack.known_facts.files_read = pack.known_facts.files_read.filter(f => f.path !== gone.path);
		pack.known_facts.ranges_read = pack.known_facts.ranges_read.filter(f => f.path !== gone.path);
	}
	pack.budget = { ...pack.budget, max_tokens: max, used_tokens: Math.min(max, used) };
	return pack;
}

/** Child pack for a sub-agent: items under `scope`, parent known_facts inherited. */
export function slicePack(pack: ContextPack, scope: string): ContextPack {
	const prefix = scope.replace(/^\.\//, '');
	const items = pack.items.filter(i => i.path.startsWith(prefix));
	return {
		...pack,
		pack_id: randomUUID(),
		items,
		budget: { ...pack.budget, used_tokens: Math.min(pack.budget.max_tokens, items.reduce((s, i) => s + i.tokens, 0) + estimateTokens(JSON.stringify({ ...pack, items: [] }))) },
		provenance: { ...pack.provenance, scope: prefix, parent_pack: pack.pack_id },
	};
}

export { parseIntent, type ParsedIntent };
