/**
 * RIAF 2.0 host wiring (no VS Code dependency): Riaf2 (index + history + compiler) ↔ ToolGovernor
 * (token-opt) ↔ governor endpoint for Claude Code hooks. Used by the MCP server; testable in Node.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { blobHash, rebudget, render, Riaf2, type ContextPack, type RenderTarget } from '@bosch-mps/riaf-core';
import {
	formatMetrics, GovernorServer, handleClaudeHook, loadPolicyFile, ToolGovernor,
	type CacheEntry, type CacheStore, type ClaudeHookPayload, type GovernorBackend, type GovernorMetrics, type GovernorPolicy,
} from '@bosch-mps/token-opt';

export interface Riaf2HostOptions {
	host?: string;
	log?: (m: string) => void;
	/** Tokens for the pack injected by the UserPromptSubmit hook. */
	hookPackBudget?: number;
	/** Disable governance (escape hatch `--no-guard`). */
	governEnabled?: boolean;
}

/** tool_cache table as the governor's CacheStore. */
export function dbCacheStore(riaf: Riaf2): CacheStore {
	const raw = riaf.store.raw;
	return {
		load: () => raw.all<{ key_hash: string; tool: string; args_norm: string; blob_hashes: string; result: string; ts: number }>('SELECT * FROM tool_cache ORDER BY ts DESC LIMIT 2000')
			.map(r => ({ key: r.key_hash, tool: r.tool, argsNorm: r.args_norm, blobs: JSON.parse(r.blob_hashes), result: r.result, ts: r.ts }) as CacheEntry),
		put: e => raw.run('INSERT OR REPLACE INTO tool_cache(key_hash, tool, args_norm, blob_hashes, result, ts) VALUES (?,?,?,?,?,?)', [e.key, e.tool, e.argsNorm, JSON.stringify(e.blobs), e.result.slice(0, 200_000), e.ts]),
		delete: keys => { for (const k of keys) raw.run('DELETE FROM tool_cache WHERE key_hash = ?', [k]); },
	};
}

/** Working-tree version: HEAD + dirty files and their mtimes (memoised briefly). Changes on any edit. */
export function treeVersionFn(root: string, memoMs = 400): () => string {
	let last = { at: 0, v: '' };
	let counter = 0;
	return () => {
		const now = Date.now();
		if (now - last.at < memoMs) return last.v;
		let v: string;
		try {
			const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
			const status = execFileSync('git', ['status', '--porcelain', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
			const mt = status.split('\0').filter(Boolean).map(l => l.slice(3)).map(p => { try { return `${p}:${statSync(join(root, p)).mtimeMs}`; } catch { return `${p}:gone`; } }).join('|');
			v = createHash('sha256').update(`${head}\n${mt}`).digest('hex').slice(0, 16);
		} catch { v = `nogit-${++counter}`; }
		last = { at: now, v };
		return v;
	};
}

export class Riaf2Host {
	private readonly governors = new Map<string, ToolGovernor>();
	private readonly promptsSeen = new Set<string>();
	private server: GovernorServer | null = null;
	private readonly treeVersion: () => string;
	private policy: GovernorPolicy;
	private readonly log: (m: string) => void;
	private metricsTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly dirtyMetrics = new Map<string, GovernorMetrics>();

	constructor(readonly riaf: Riaf2, private readonly o: Riaf2HostOptions = {}) {
		this.treeVersion = treeVersionFn(riaf.root);
		this.policy = loadPolicyFile(riaf.root);
		this.log = o.log ?? (() => { });
	}

	get root(): string { return this.riaf.root; }

	relative = (p: string): string => {
		const n = p.replace(/\\/g, '/');
		const rootN = this.root.replace(/\\/g, '/');
		const rel = isAbsolute(p) ? relative(this.root, p).replace(/\\/g, '/') : n.startsWith(rootN + '/') ? n.slice(rootN.length + 1) : n;
		return rel.replace(/^\.\//, '') || '.';
	};

	backend(): GovernorBackend {
		const read = (p: string) => { try { return readFileSync(join(this.root, p), 'utf8'); } catch { return null; } };
		return {
			relative: this.relative,
			readFile: read,
			blobHash: p => { const t = read(p); return t === null ? null : blobHash(t); },
			treeVersion: this.treeVersion,
			prefetchCandidates: async (path, minCoupling) => {
				const out: { path: string; reason: string }[] = [];
				for (const c of this.riaf.history?.coChanged(path, 5, minCoupling) ?? []) out.push({ path: c.path, reason: `co-changes with ${path} in ${Math.round(c.confidence * 100)}% of its changes` });
				for (const t of (await this.riaf.index.getTestsForFile(path).catch(() => [])).slice(0, 2)) out.push({ path: t.testFile, reason: `tests ${path}` });
				const g = await this.riaf.index.getImportGraph(path).catch(() => ({ imports: [] as string[] }));
				for (const i of g.imports.slice(0, 2)) out.push({ path: i, reason: `imported by ${path}` });
				return out.filter((x, i, a) => a.findIndex(y => y.path === x.path) === i);
			},
			outline: async p => {
				const syms = await this.riaf.index.getFileOutline(p).catch(() => []);
				const sum = this.riaf.summaries.get('file', p);
				const lines = syms.slice(0, 25).map(s => `${s.startLine}: ${(s.signature || `${s.kind} ${s.name}`).replace(/\s+/g, ' ').slice(0, 140)}`);
				return [sum, ...lines].filter(Boolean).join('\n');
			},
			onWrite: async paths => { if (paths.length) await this.riaf.update(paths).catch(e => this.log(`re-index after write failed: ${String(e)}`)); },
		};
	}

	governorFor = (sessionId: string): ToolGovernor => {
		let g = this.governors.get(sessionId);
		if (!g) {
			g = new ToolGovernor({
				backend: this.backend(), policy: this.policy, cacheStore: dbCacheStore(this.riaf), sessionId, host: this.o.host ?? 'claude-code',
				enabled: this.o.governEnabled !== false && process.env.RIAF_NO_GUARD !== '1',
				onMetrics: m => this.queueMetrics(m),
			});
			const pack = this.riaf.currentPack();
			if (pack) g.setKnownFacts(pack.known_facts);
			this.governors.set(sessionId, g);
		}
		return g;
	};

	private queueMetrics(m: GovernorMetrics): void {
		this.dirtyMetrics.set(m.sessionId, m);
		if (this.metricsTimer) return;
		this.metricsTimer = setTimeout(() => this.flushMetrics(), 500);
		(this.metricsTimer as { unref?: () => void }).unref?.();
	}

	flushMetrics(): void {
		if (this.metricsTimer) { clearTimeout(this.metricsTimer); this.metricsTimer = null; }
		for (const m of this.dirtyMetrics.values()) {
			this.riaf.store.raw.run('INSERT INTO session_metric(session_id, host, started_at, updated_at, counters) VALUES (?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at, counters = excluded.counters',
				[m.sessionId, m.host, m.startedAt, Date.now(), JSON.stringify(m)]);
		}
		this.dirtyMetrics.clear();
	}

	/** Install the current pack's known facts on every live governor. */
	private shareKnownFacts(pack: ContextPack): void {
		for (const g of this.governors.values()) g.setKnownFacts(pack.known_facts);
	}

	/** Write `.claude/riaf/pack.md` so Claude Code (and humans) can open the current pack. */
	writePackFile(pack: ContextPack): string {
		const dir = join(this.root, '.claude', 'riaf');
		mkdirSync(dir, { recursive: true });
		const p = join(dir, 'pack.md');
		writeFileSync(p, render(pack, 'claude'));
		return p;
	}

	async compile(request: string, opts: Parameters<Riaf2['compile']>[1] & { format?: RenderTarget } = {}): Promise<{ pack: ContextPack; text: string }> {
		const pack = await this.riaf.compile(request, opts);
		this.shareKnownFacts(pack);
		try { this.writePackFile(pack); } catch (e) { this.log(`could not write pack file: ${String(e)}`); }
		if (opts.stage === 'plan') for (const g of this.governors.values()) g.setPhase('plan');
		return { pack, text: render(pack, opts.format ?? 'claude') };
	}

	/** Record a plan into the current pack so sub-agents inherit it; moves governors to the plan phase. */
	setPlan(steps: string[]): ContextPack | undefined {
		const pack = this.riaf.currentPack();
		if (!pack) return undefined;
		pack.plan_skeleton = steps.filter(s => s.trim());
		this.riaf.store.raw.run('UPDATE pack SET json = ? WHERE pack_id = ?', [JSON.stringify(pack), pack.pack_id]);
		for (const g of this.governors.values()) g.setPhase('plan');
		try { this.writePackFile(pack); } catch { /* ignore */ }
		return pack;
	}

	statusText(): string {
		this.flushMetrics();
		const live = [...this.governors.values()].map(g => formatMetrics(g.metrics()));
		const rows = this.riaf.store.raw.all<{ counters: string }>('SELECT counters FROM session_metric ORDER BY updated_at DESC LIMIT 200').map(r => JSON.parse(r.counters) as GovernorMetrics);
		const sum = (k: keyof GovernorMetrics) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
		const proposed = sum('proposed');
		const totals = rows.length
			? `All recorded sessions (${rows.length}): ${proposed} calls proposed, ${sum('served')} served from index, ${sum('blocked')} blocked — ${proposed ? Math.round((sum('served') + sum('blocked')) / proposed * 100) : 0}% avoided; ~${sum('tokensServed')} tokens served vs ~${sum('tokensExecuted')} executed.`
			: 'No governed sessions recorded yet.';
		return [...live, totals].join('\n\n');
	}

	/** Claude Code hook entry point (called by the governor endpoint). */
	async handleHook(payload: ClaudeHookPayload): Promise<unknown> {
		return handleClaudeHook(payload, {
			governorFor: this.governorFor,
			log: m => this.log(`[govern] ${m}`),
			onSessionStart: async () => {
				const pack = this.riaf.currentPack();
				if (pack && pack.repo.head === await this.riaf.head()) {
					const small = rebudget(JSON.parse(JSON.stringify(pack)) as ContextPack, Math.min(6_000, this.o.hookPackBudget ?? 12_000));
					return `RIAF: the Context Pack from the previous task on this branch is still current.\n\n${render(small, 'claude')}`;
				}
				return [`RIAF repository intelligence is active for this repository.`, await this.riaf.conventionsText(), await this.riaf.architectureText()].join('\n\n');
			},
			onUserPrompt: async (prompt, p) => {
				const sid = p.session_id ?? 'default';
				const text = prompt.trim();
				if (this.promptsSeen.has(sid) || text.startsWith('/') || text.split(/\s+/).length < 4) return undefined;
				this.promptsSeen.add(sid);
				const { pack } = await this.compile(text, { budget: this.o.hookPackBudget ?? 12_000 });
				return `RIAF compiled a Context Pack for this task (${pack.items.length} items, ${pack.budget.used_tokens} tokens; also at .claude/riaf/pack.md and riaf://pack/current).\n\n${render(pack, 'claude')}`;
			},
		});
	}

	async startGovernor(): Promise<string> {
		this.server = new GovernorServer(this.root, async msg => {
			if (msg.type === 'claude-hook') return { output: await this.handleHook((msg.payload ?? {}) as ClaudeHookPayload) };
			if (msg.type === 'status') return { text: this.statusText() };
			return { error: `unknown message type ${String(msg.type)}` };
		}, { log: this.log });
		const info = await this.server.start();
		return info.endpoint;
	}

	async stop(): Promise<void> {
		this.flushMetrics();
		await this.server?.stop().catch(() => undefined);
		this.server = null;
	}
}
