/**
 * RIAF 2.0 host wiring (no VS Code dependency): Riaf2 (index + history + compiler) ↔ ToolGovernor
 * (token-opt) ↔ governor endpoint for Claude Code hooks. Used by the MCP server; testable in Node.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import {
	blobHash, buildInstruction, formatRouteLine, loadCurrentInstruction, rebudget, render, Riaf2, routeIntent, saveInstruction,
	type BuildInstructionOptions, type ContextPack, type IntentRoute, type PromptInstruction, type RenderTarget, type RouteOptions,
} from '@bosch-mps/riaf-core';
import {
	formatMetrics, GovernorServer, handleClaudeHook, loadPolicyFile, ToolGovernor,
	type CacheEntry, type CacheStore, type ClaudeHookPayload, type GovernorBackend, type GovernorMetrics, type GovernorPolicy,
} from '@bosch-mps/token-opt';
import { buildRunReport, classifyEvent, eventDetail, reportToMarkdown, summarizeRun, type EventDetail, type RunEvent, type RunReport, type RunSummary } from './runReport.js';

export interface Riaf2HostOptions {
	host?: string;
	log?: (m: string) => void;
	/** Tokens for the pack injected by the UserPromptSubmit hook. */
	hookPackBudget?: number;
	/** Disable governance (escape hatch `--no-guard`). */
	governEnabled?: boolean;
	/** Tier-2 intent arbiter (one small model call); absent = lexicon only. */
	classify?: RouteOptions['classify'];
	/** Earlier runs kept (closed, not live) when a new prompt starts. Default 0: every new prompt starts from a clean slate. */
	keepRuns?: number;
}

/** A run is one prompt: `<claude session id>~<base36 time>`. Hooks of the same prompt share it; the next prompt gets a new one. */
export const runKeyRaw = (key: string): string => key.split('~')[0];
/** Runs idle longer than this are archived and deleted when the daemon starts or a prompt begins. */
export const RUN_MAX_IDLE_MS = 12 * 3600_000;
const MAX_ARCHIVED_REPORTS = 25;

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
	/** Last route per Claude session: a new pack is compiled only when the intent type or entities change. */
	private readonly lastRoute = new Map<string, { type: string; entities: string }>();
	/** Brief attached to each Claude session's latest prompt (recorded on the event so reports survive later recompiles). */
	private readonly lastInstruction = new Map<string, { id: string; intent: string; request: string; plan: string[]; verify: string[]; pack: string[] }>();
	private server: GovernorServer | null = null;
	private endpoint: string | null = null;
	private readonly treeVersion: () => string;
	private policy: GovernorPolicy;
	private readonly log: (m: string) => void;
	private metricsTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly dirtyMetrics = new Map<string, GovernorMetrics>();
	/** Claude session id → the run (prompt) currently being recorded. */
	private readonly runKeys = new Map<string, string>();
	private readonly runHasPrompt = new Set<string>();
	/** Claude sessions replaced by a newer one: their stragglers are governed but no longer recorded. */
	private readonly switchedOff = new Set<string>();
	private lastHookAt: number | null = null;

	constructor(readonly riaf: Riaf2, private readonly o: Riaf2HostOptions = {}) {
		this.treeVersion = treeVersionFn(riaf.root);
		this.policy = loadPolicyFile(riaf.root);
		this.log = o.log ?? (() => { });
		try { riaf.store.raw.run('CREATE TABLE IF NOT EXISTS session_event(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts INTEGER NOT NULL, event TEXT NOT NULL, tool TEXT, path TEXT, decision TEXT, reason TEXT)'); riaf.store.raw.run('CREATE INDEX IF NOT EXISTS session_event_sid ON session_event(session_id, ts)'); } catch (e) { this.log(`session_event table: ${String(e)}`); }
		// Older databases predate the per-event detail column (what changed, test results, ...).
		try { riaf.store.raw.run('ALTER TABLE session_event ADD COLUMN detail TEXT'); } catch { /* already there */ }
	}

	/** Re-read .riaf/policy.yaml (the console edits it). */
	reloadPolicy(): GovernorPolicy { this.policy = loadPolicyFile(this.riaf.root); return this.policy; }
	get currentPolicy(): GovernorPolicy { return this.policy; }

	/** Raw per-call rows of a session (newest first); the console's run views use `runEvents`. */
	sessionEvents(sessionId: string, limit = 500): { id: number; ts: number; event: string; tool: string | null; path: string | null; decision: string | null; reason: string | null }[] {
		return this.riaf.store.raw.all('SELECT id, ts, event, tool, path, decision, reason FROM session_event WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT ?', [sessionId, limit]);
	}

	sessions(limit = 200): { sessionId: string; host: string; startedAt: number; updatedAt: number; counters: GovernorMetrics }[] {
		this.flushMetrics();
		return this.riaf.store.raw.all<{ session_id: string; host: string; started_at: number; updated_at: number; counters: string }>('SELECT session_id, host, started_at, updated_at, counters FROM session_metric ORDER BY updated_at DESC LIMIT ?', [limit])
			.map(r => ({ sessionId: r.session_id, host: r.host, startedAt: r.started_at, updatedAt: r.updated_at, counters: JSON.parse(r.counters) as GovernorMetrics }));
	}

	/* ───────── live run views (console) ───────── */

	private toRunEvent(r: { id: number; session_id: string; ts: number; event: string; tool: string | null; path: string | null; decision: string | null; reason: string | null; detail: string | null }): RunEvent {
		let detail: EventDetail | null = null;
		if (r.detail) { try { detail = JSON.parse(r.detail) as EventDetail; } catch { detail = null; } }
		const base = { event: r.event, tool: r.tool, path: r.path, decision: r.decision, reason: r.reason, detail };
		return { id: r.id, sessionId: r.session_id, ts: r.ts, ...base, ...classifyEvent(base) };
	}

	/** Events of one session in chronological order; `since` returns only newer rows (the live feed's cursor). */
	runEvents(sessionId: string, opts: { since?: number; limit?: number } = {}): RunEvent[] {
		const limit = opts.limit ?? 4000;
		const rows = opts.since
			? this.riaf.store.raw.all<Parameters<Riaf2Host['toRunEvent']>[0]>('SELECT id, session_id, ts, event, tool, path, decision, reason, detail FROM session_event WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?', [sessionId, opts.since, limit])
			: this.riaf.store.raw.all<Parameters<Riaf2Host['toRunEvent']>[0]>('SELECT id, session_id, ts, event, tool, path, decision, reason, detail FROM (SELECT * FROM session_event WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC', [sessionId, limit]);
		return rows.map(r => this.toRunEvent(r));
	}

	latestSessionId(): string | null {
		return this.riaf.store.raw.all<{ session_id: string }>('SELECT session_id FROM session_event ORDER BY id DESC LIMIT 1')[0]?.session_id ?? null;
	}

	/** Every session that produced hook events (not only those the governor kept metrics for), newest activity first. */
	runSummaries(limit = 50): (RunSummary & { host: string; counters: Record<string, unknown> })[] {
		const ids = this.riaf.store.raw.all<{ session_id: string }>('SELECT session_id FROM session_event GROUP BY session_id ORDER BY MAX(id) DESC LIMIT ?', [limit]).map(r => r.session_id);
		const metrics = new Map(this.sessions(500).map(m => [m.sessionId, m]));
		const now = Date.now();
		return ids.map(id => {
			const sum = summarizeRun(id, this.runEvents(id, { limit: 4000 }), now);
			const m = metrics.get(id);
			return { ...sum, host: m?.host ?? 'claude', counters: (m?.counters as unknown as Record<string, unknown>) ?? {} };
		});
	}

	/** One poll of the live feed: new events for a session (default: the most recent one) plus its summary. */
	activity(since: number, sessionId?: string | null, after = 0): { sessionId: string | null; events: RunEvent[]; cursor: number; summary: RunSummary | null; now: number } {
		const sid = sessionId || this.latestSessionId();
		const now = Date.now();
		if (!sid) return { sessionId: null, events: [], cursor: since, summary: null, now };
		// A page opened (or a task armed) after this run ended does not inherit it: it starts from a clean window.
		if (!sessionId && after) {
			const sum = summarizeRun(sid, this.runEvents(sid, { limit: 4000 }), now);
			if (sum.status !== 'running' && sum.updatedAt < after) return { sessionId: null, events: [], cursor: since, summary: null, now };
		}
		const events = this.runEvents(sid, since ? { since } : { limit: 400 });
		const all = since ? this.runEvents(sid, { limit: 4000 }) : events;
		return { sessionId: sid, events, cursor: events.length ? events[events.length - 1].id : since, summary: summarizeRun(sid, all, now), now };
	}

	private git(args: string[]): string {
		try { return execFileSync('git', args, { cwd: this.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000, maxBuffer: 16 * 1024 * 1024 }).trim(); } catch { return ''; }
	}

	/** Files already modified or untracked right now: the baseline that keeps a run's report from claiming them. */
	private dirtyFiles(): string[] {
		const names = (out: string) => out.split('\n').filter(Boolean);
		return [...new Set([...names(this.git(['diff', '--name-only', 'HEAD'])), ...names(this.git(['ls-files', '--others', '--exclude-standard']))])].slice(0, 400);
	}

	private gitFacts(startHead?: string, dirtyAtStart: string[] = [], editedByRun: string[] = []): NonNullable<RunReport['git']> | null {
		const endHead = this.git(['rev-parse', 'HEAD']);
		if (!endHead) return null;
		const own = (f: string) => /^(\.riaf\/|\.claude\/riaf\/)/.test(f);
		const changed = this.git(['diff', '--numstat', startHead || 'HEAD']).split('\n').filter(Boolean).map(l => { const [a, r, ...f] = l.split('\t'); return { file: f.join('\t'), added: Number(a) || 0, removed: Number(r) || 0 }; }).filter(c => c.file && !own(c.file));
		const untracked = this.git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(f => f && !own(f)).slice(0, 200);
		// Only what changed during the run: skip files that were already dirty when the session began, unless the run edited them.
		const before = new Set(dirtyAtStart), mine = new Set(editedByRun);
		const attributable = (f: string) => !before.has(f) || mine.has(f);
		return { branch: this.git(['rev-parse', '--abbrev-ref', 'HEAD']) || undefined, startHead, endHead, changed: changed.filter(c => attributable(c.file)), untracked: untracked.filter(attributable) };
	}

	/** What a session did: files, tests, governor effect, context quality, verified against git. */
	runReport(sessionId: string): RunReport {
		const events = this.runEvents(sessionId, { limit: 6000 });
		const start = events.find(e => (e.event === 'SessionStart' || e.event === 'UserPromptSubmit') && e.detail?.head)?.detail;
		const startHead = start?.head;
		const editedByRun = events.filter(e => e.kind === 'edit' && e.detail?.file).map(e => e.detail!.file!);
		const promptWithBrief = [...events].reverse().find(e => e.kind === 'prompt' && e.detail?.instruction)?.detail;
		this.flushMetrics();
		const metrics = this.sessions(500).find(m => m.sessionId === sessionId)?.counters as unknown as Record<string, unknown> | undefined;
		return buildRunReport({
			sessionId, events, metrics: metrics ?? null, now: Date.now(), git: this.gitFacts(startHead, start?.dirty, editedByRun),
			instruction: promptWithBrief?.instruction ? { id: promptWithBrief.instruction, request: promptWithBrief.request ?? '', intent: promptWithBrief.intent ?? '', plan: promptWithBrief.plan ?? [], verification: promptWithBrief.verify ?? [], packPaths: promptWithBrief.pack ?? [] } : null,
		});
	}

	/** Is Claude Code actually connected to this process? Used by the console to explain an empty Sessions page. */
	hookHealth(): { governor: { listening: boolean; endpoint: string | null; fileEndpoint: string | null; ownedByThisProcess: boolean; otherPid: number | null }; hookScript: boolean; settingsPresent: boolean; events: Record<string, boolean>; missing: string[]; lastEventAt: number | null; eventsTotal: number } {
		const required = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'];
		let settings: { hooks?: Record<string, { hooks?: { command?: string }[] }[]> } = {};
		const settingsFile = join(this.root, '.claude', 'settings.json');
		try { settings = JSON.parse(readFileSync(settingsFile, 'utf8')); } catch { /* none */ }
		const events: Record<string, boolean> = {};
		for (const e of required) events[e] = (settings.hooks?.[e] ?? []).some(g => (g.hooks ?? []).some(h => typeof h.command === 'string' && h.command.includes('riaf-govern.mjs')));
		let fileEndpoint: string | null = null, otherPid: number | null = null;
		try { const g = JSON.parse(readFileSync(join(this.root, '.riaf', 'governor.json'), 'utf8')) as { endpoint?: string; pid?: number }; fileEndpoint = g.endpoint ?? null; if (g.pid && g.pid !== process.pid) otherPid = g.pid; } catch { /* none */ }
		const last = this.riaf.store.raw.all<{ ts: number; n: number }>('SELECT MAX(ts) AS ts, COUNT(*) AS n FROM session_event')[0];
		return {
			governor: { listening: this.server !== null, endpoint: this.endpoint, fileEndpoint, ownedByThisProcess: !!this.endpoint && this.endpoint === fileEndpoint, otherPid },
			hookScript: existsSync(join(this.root, '.claude', 'hooks', 'riaf-govern.mjs')), settingsPresent: existsSync(settingsFile),
			events, missing: required.filter(e => !events[e]), lastEventAt: last?.ts ?? this.lastHookAt, eventsTotal: last?.n ?? 0,
		};
	}

	private recordEvent(p: ClaudeHookPayload, out: unknown): void {
		try {
			const hso = (out as { hookSpecificOutput?: Record<string, unknown> } | undefined)?.hookSpecificOutput;
			const decision = hso ? (typeof hso.permissionDecision === 'string' ? hso.permissionDecision : hso.additionalContext ? 'context' : 'allow') : 'allow';
			const reason = hso && typeof hso.permissionDecisionReason === 'string' ? hso.permissionDecisionReason.slice(0, 300) : hso && typeof hso.additionalContext === 'string' ? hso.additionalContext.split('\n')[0].slice(0, 300) : null;
			const input = (p.tool_input ?? {}) as Record<string, unknown>;
			const path = typeof input.file_path === 'string' ? this.relative(input.file_path) : typeof input.pattern === 'string' ? String(input.pattern).slice(0, 200) : typeof input.command === 'string' ? String(input.command).slice(0, 200) : null;
			const sid = p.session_id ?? 'default';
			let detail: EventDetail | null = eventDetail(p, this.relative);
			if (p.hook_event_name === 'SessionStart') detail = { ...(detail ?? {}), head: this.git(['rev-parse', 'HEAD']) || undefined, branch: this.git(['rev-parse', '--abbrev-ref', 'HEAD']) || undefined, dirty: this.dirtyFiles() };
			if (p.hook_event_name === 'UserPromptSubmit') { if (!this.baselineRecorded(sid)) detail = { ...(detail ?? {}), head: this.git(['rev-parse', 'HEAD']) || undefined, branch: this.git(['rev-parse', '--abbrev-ref', 'HEAD']) || undefined, dirty: this.dirtyFiles() }; const li = this.lastInstruction.get(runKeyRaw(sid)); if (li) detail = { ...(detail ?? {}), instruction: li.id, intent: li.intent, request: li.request, plan: li.plan, verify: li.verify, pack: li.pack }; }
			this.riaf.store.raw.run('INSERT INTO session_event(session_id, ts, event, tool, path, decision, reason, detail) VALUES (?,?,?,?,?,?,?,?)', [sid, Date.now(), p.hook_event_name ?? 'unknown', p.tool_name ?? null, path, decision, reason, detail ? JSON.stringify(detail) : null]);
		} catch (e) { this.log(`recordEvent: ${String(e)}`); }
	}

	/** Does this run already carry a git baseline (from SessionStart)? */
	private baselineRecorded(key: string): boolean {
		return this.riaf.store.raw.all<{ n: number }>("SELECT COUNT(*) AS n FROM session_event WHERE session_id = ? AND event = 'SessionStart'", [key])[0]?.n > 0;
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

	/** Route a request (tier 1 + optional arbiter + per-repo feedback). */
	async route(request: string, opts: Omit<RouteOptions, 'root' | 'classify' | 'architectureSummary'> = {}): Promise<IntentRoute> {
		const arch = await this.riaf.architecture().catch(() => null);
		return routeIntent(request, { ...opts, root: this.root, classify: this.o.classify, architectureSummary: arch?.summary });
	}

	/** Route → compile (budget / stage / scope from the route) → Prompt Instruction, saved under .claude/riaf/instructions. */
	async instruct(request: string, opts: { route?: IntentRoute; command?: string; activeFile?: string; selection?: string; budget?: number; findings?: string[]; host?: BuildInstructionOptions['host']; fresh?: boolean; pinned?: string[]; excluded?: string[]; scope?: string } = {}): Promise<{ route: IntentRoute; pack: ContextPack; instruction: PromptInstruction; path: string }> {
		const route = opts.route ?? await this.route(request, { command: opts.command, activeFile: opts.activeFile, selection: opts.selection });
		const { pack } = await this.compile(request, { budget: opts.budget ?? route.budget, stage: route.stage, scope: opts.scope ?? route.scope, activeFile: opts.activeFile, selection: opts.selection, fresh: opts.fresh, pinned: opts.pinned, excluded: opts.excluded });
		const instruction = buildInstruction(pack, { route, root: this.root, activeFile: opts.activeFile, policy: this.policy, findings: opts.findings, host: opts.host ?? 'claude' });
		const saved = saveInstruction(this.root, instruction);
		this.log(`instruction ${instruction.instruction_id}: ${formatRouteLine(route, { items: pack.items.length, tokens: pack.budget.used_tokens })}`);
		return { route, pack, instruction, path: saved.currentPath };
	}

	currentInstruction(): PromptInstruction | null { return loadCurrentInstruction(this.root); }

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
		const raw = payload.session_id ?? 'default';
		const isPrompt = payload.hook_event_name === 'UserPromptSubmit';
		this.lastHookAt = Date.now();
		if (isPrompt) this.switchedOff.delete(raw);
		const key = this.runFor(raw, isPrompt);
		const p: ClaudeHookPayload = key === raw ? payload : { ...payload, session_id: key };
		// Show the new run at once; compiling the brief can take a moment.
		if (isPrompt) { try { this.riaf.store.raw.run('INSERT INTO session_event(session_id, ts, event, decision) VALUES (?,?,?,?)', [key, Date.now(), 'PromptReceived', 'allow']); } catch { /* best effort */ } }
		const out = await this.handleHookInner(p);
		if (!this.switchedOff.has(raw)) this.recordEvent(p, out);
		return out;
	}

	/**
	 * Which run does this hook belong to? A prompt opens a fresh run (except the first prompt after SessionStart,
	 * which continues the run SessionStart opened) and switches every other run off.
	 */
	private runFor(raw: string, isPrompt: boolean): string {
		let key = this.runKeys.get(raw);
		if (!key) {
			const last = this.riaf.store.raw.all<{ session_id: string }>('SELECT session_id FROM session_event WHERE session_id = ? OR session_id LIKE ? ORDER BY id DESC LIMIT 1', [raw, `${raw}~%`])[0]?.session_id;
			if (last) { key = last; this.runKeys.set(raw, key); if (this.hasPromptEvent(last)) this.runHasPrompt.add(last); }
		}
		if (!isPrompt) { if (!key) { key = raw; this.runKeys.set(raw, key); } return key; }
		if (!key) { key = raw; this.runKeys.set(raw, key); this.runHasPrompt.add(key); this.retireOthers(key); return key; }
		if (!this.runHasPrompt.has(key)) { this.runHasPrompt.add(key); this.retireOthers(key); return key; }
		key = `${raw}~${Date.now().toString(36)}`;
		this.runKeys.set(raw, key); this.runHasPrompt.add(key);
		this.retireOthers(key);
		return key;
	}

	private hasPromptEvent(key: string): boolean {
		return this.riaf.store.raw.all<{ n: number }>("SELECT COUNT(*) AS n FROM session_event WHERE session_id = ? AND event = 'UserPromptSubmit'", [key])[0]?.n > 0;
	}

	/** Every run except `current`: save a report for the ones that did something, switch them off, delete them (keeping `keepRuns` most recent as closed). */
	private retireOthers(current: string): void {
		try {
			const others = this.riaf.store.raw.all<{ session_id: string }>('SELECT session_id FROM session_event WHERE session_id != ? GROUP BY session_id ORDER BY MAX(id) DESC', [current]).map(r => r.session_id);
			const keep = Math.max(0, this.o.keepRuns ?? 0);
			others.forEach((id, i) => {
				const raw = runKeyRaw(id);
				if (raw !== runKeyRaw(current)) this.switchedOff.add(raw);
				for (const [k, v] of this.runKeys) if (v === id) this.runKeys.delete(k);
				if (i < keep) { this.closeRun(id); return; }
				this.archiveRun(id);
				this.deleteRun(id);
			});
			if (others.length) this.log(`new prompt: ${others.length} earlier run(s) switched off`);
		} catch (e) { this.log(`retireOthers: ${String(e)}`); }
	}

	private closeRun(id: string): void {
		const last = this.riaf.store.raw.all<{ event: string }>('SELECT event FROM session_event WHERE session_id = ? ORDER BY id DESC LIMIT 1', [id])[0];
		if (last && last.event !== 'Superseded' && last.event !== 'SessionEnd') this.riaf.store.raw.run('INSERT INTO session_event(session_id, ts, event, decision) VALUES (?,?,?,?)', [id, Date.now(), 'Superseded', 'allow']);
	}

	private deleteRun(id: string): void {
		this.riaf.store.raw.run('DELETE FROM session_event WHERE session_id = ?', [id]);
		this.riaf.store.raw.run('DELETE FROM session_metric WHERE session_id = ?', [id]);
		this.dirtyMetrics.delete(id); this.governors.delete(id); this.runHasPrompt.delete(id);
	}

	/** Runs that edited files, ran commands or tests keep a markdown report under .riaf/reports before they are deleted. */
	private archiveRun(id: string): void {
		try {
			const events = this.runEvents(id, { limit: 6000 });
			if (!events.some(e => e.kind === 'edit' || e.kind === 'test' || e.kind === 'command')) return;
			const dir = join(this.root, '.riaf', 'reports');
			mkdirSync(dir, { recursive: true });
			const when = new Date(events[0].ts).toISOString().replace(/[:T]/g, '-').slice(0, 19);
			writeFileSync(join(dir, `${when}-${runKeyRaw(id).slice(0, 8)}.md`), reportToMarkdown(this.runReport(id)));
			const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
			for (const f of files.slice(0, Math.max(0, files.length - MAX_ARCHIVED_REPORTS))) { try { unlinkSync(join(dir, f)); } catch { /* ignore */ } }
		} catch (e) { this.log(`archiveRun: ${String(e)}`); }
	}

	/** Saved reports of deleted runs, newest first. */
	savedReports(): { name: string; ts: number; bytes: number }[] {
		const dir = join(this.root, '.riaf', 'reports');
		try { return readdirSync(dir).filter(f => f.endsWith('.md')).map(name => { const st = statSync(join(dir, name)); return { name, ts: st.mtimeMs, bytes: st.size }; }).sort((a, b) => b.ts - a.ts); } catch { return []; }
	}
	savedReport(name: string): string | null {
		if (!/^[\w.-]+\.md$/.test(name)) return null;
		try { return readFileSync(join(this.root, '.riaf', 'reports', name), 'utf8'); } catch { return null; }
	}

	/** Archive and delete runs nobody has touched for RUN_MAX_IDLE_MS, plus metric rows with no events. */
	sweepRuns(now = Date.now()): number {
		try {
			const stale = this.riaf.store.raw.all<{ session_id: string }>('SELECT session_id FROM session_event GROUP BY session_id HAVING MAX(ts) < ?', [now - RUN_MAX_IDLE_MS]).map(r => r.session_id);
			for (const id of stale) { this.archiveRun(id); this.deleteRun(id); for (const [k, v] of this.runKeys) if (v === id) this.runKeys.delete(k); }
			this.riaf.store.raw.run('DELETE FROM session_metric WHERE updated_at < ? AND session_id NOT IN (SELECT DISTINCT session_id FROM session_event)', [now - RUN_MAX_IDLE_MS]);
			return stale.length;
		} catch (e) { this.log(`sweepRuns: ${String(e)}`); return 0; }
	}

	private async handleHookInner(payload: ClaudeHookPayload): Promise<unknown> {
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
				const sid = runKeyRaw(p.session_id ?? 'default');
				const text = prompt.trim();
				if (text.startsWith('/') || text.split(/\s+/).length < 4) return undefined;
				const route = await this.route(text);
				const key = { type: route.type, entities: route.intent.entities.filter(e => e.kind !== 'term').map(e => e.value).sort().join('|') };
				const last = this.lastRoute.get(sid);
				// Same intent and entities as the last prompt of this session → the current instruction still applies.
				if (last && last.type === key.type && (last.entities === key.entities || !key.entities)) return undefined;
				this.lastRoute.set(sid, key);
				this.promptsSeen.add(sid);
				if (route.askFirst) return `RIAF could not classify this request confidently (${route.type}, ${route.confidence}). Before exploring, ask the developer:\n${route.questions.map(q => `- ${q}`).join('\n')}`;
				const { pack, instruction } = await this.instruct(text, { route, budget: Math.min(route.budget, this.o.hookPackBudget ?? 12_000) });
				this.lastInstruction.set(sid, { id: instruction.instruction_id, intent: route.type, request: text.slice(0, 300), plan: instruction.plan.slice(0, 12), verify: instruction.verification.slice(0, 12), pack: pack.items.map(i => i.path).slice(0, 40) });
				return `RIAF compiled instruction ${instruction.instruction_id} for this task (${formatRouteLine(route, { items: pack.items.length, tokens: pack.budget.used_tokens })}; also at .claude/riaf/instructions/current.md and riaf://instruction/current).\n\n${instruction.markdown}`;
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
		this.endpoint = info.endpoint;
		this.sweepRuns();
		return info.endpoint;
	}

	async stop(): Promise<void> {
		this.flushMetrics();
		await this.server?.stop().catch(() => undefined);
		this.server = null;
	}
}
