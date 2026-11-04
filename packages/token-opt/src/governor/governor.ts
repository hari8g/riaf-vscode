/**
 * ToolGovernor — RIAF 2.0 Pillar 3. One rule: a tool runs only when its answer is not already in the
 * Context Pack, the session, or the cache. Host-agnostic: Claude Code hooks, Copilot LM tool wrappers
 * and RIAF's own loop all call guard() before a tool and record() after it.
 */
import { cacheKey, normaliseArgs, ToolCache } from './cache.js';
import { DEFAULT_POLICY, PHASES, type GovernorPolicy, type Phase } from './policy.js';
import type { CacheStore, CallClass, GovernorBackend, GovernorCounters, GovernorMetrics, GuardDecision, KnownFacts, PrefetchItem, ServeSource, ToolCall } from './types.js';

export const estimateGovTokens = (s: string): number => Math.ceil((s ?? '').length / 4);

const READ_TOOLS = /^(read|read_file|view|view_file|open_file|readfile)$/i;
const SEARCH_TOOLS = /^(grep|search|search_for_text|grep_search|codebase_search|search_in_files)$/i;
const GLOB_TOOLS = /^(glob|file_search|search_pathnames_only|find_files)$/i;
const LIST_TOOLS = /^(ls|list_dir|list_directory|ls_dir)$/i;
const SHELL_TOOLS = /^(bash|shell|run_command|run_in_terminal|terminal|execute_command)$/i;
const WRITE_TOOLS = /^(edit|write|multiedit|notebookedit|edit_file|create_file|write_file|rewrite_file|apply_patch|str_replace_editor|replace_string_in_file|insert_edit_into_file)$/i;

const SHELL_TEST = /\b(npm (run )?test|npx (vitest|jest|mocha)|vitest|jest|pytest|python -m pytest|mvn( -\S+)* (test|verify)|gradle(w)? (test|check)|go test|cargo test|dotnet test|ctest|make (test|check)|yarn test|pnpm test)\b/;
const SHELL_WRITE = /(^|[;&|]\s*)(sed\s+-i|perl\s+-pi|mv|rm|cp|tee|touch|mkdir|rmdir|chmod|git\s+(checkout|switch|reset|apply|commit|merge|rebase|pull|stash|restore|cherry-pick))\b|[^<>2&]>{1,2}\s*[^&\s]/;
const SHELL_READ = /^\s*(git\s+(--no-pager\s+)?(log|blame|show|grep|diff|status|ls-files)|rg|grep|egrep|find|ls|cat|head|tail|wc|tree|fd)\b/;

export interface GovernorOptions {
	backend: GovernorBackend;
	policy?: GovernorPolicy;
	cacheStore?: CacheStore;
	sessionId?: string;
	host?: string;
	now?: () => number;
	/** Called after every counter change (hosts persist metrics, debounced). */
	onMetrics?: (m: GovernorMetrics) => void;
	/** Escape hatch: when false every call is allowed and only counted. */
	enabled?: boolean;
}

interface SessionRead { blob: string; full: boolean; ranges: [number, number][]; at: number }

export function classifyCall(call: ToolCall): CallClass {
	const t = call.tool;
	if (READ_TOOLS.test(t)) return 'read';
	if (SEARCH_TOOLS.test(t)) return 'search';
	if (GLOB_TOOLS.test(t)) return 'search';
	if (LIST_TOOLS.test(t)) return 'list';
	if (WRITE_TOOLS.test(t)) return 'write';
	if (SHELL_TOOLS.test(t)) {
		const cmd = String(call.args.command ?? call.args.cmd ?? '');
		if (SHELL_TEST.test(cmd)) return 'test';
		if (SHELL_WRITE.test(cmd)) return 'shell';
		if (SHELL_READ.test(cmd) && !/\|\s*(sh|bash|xargs\s+(rm|mv|sed))\b/.test(cmd)) return 'shell-read';
		return 'shell';
	}
	return 'other';
}

const pathArg = (args: Record<string, unknown>): string | undefined => {
	for (const k of ['file_path', 'filePath', 'path', 'notebook_path', 'target_file', 'file']) if (typeof args[k] === 'string' && args[k]) return args[k] as string;
	return undefined;
};

/** Render file lines the way Claude Code's Read tool does (`cat -n`), 1-based. */
export function formatLines(text: string, from = 1, count?: number): string {
	const lines = text.split('\n');
	if (lines.length && lines[lines.length - 1] === '') lines.pop();
	const start = Math.max(1, from);
	const end = count ? Math.min(lines.length, start + count - 1) : lines.length;
	const out: string[] = [];
	for (let i = start; i <= end; i++) out.push(`${String(i).padStart(6, ' ')}\t${lines[i - 1]}`);
	return out.join('\n');
}

const emptyPhase = (now: number) => ({ calls: 0, tokens: 0, startedAt: now });

export class ToolGovernor {
	readonly backend: GovernorBackend;
	policy: GovernorPolicy;
	readonly sessionId: string;
	readonly host: string;
	enabled: boolean;
	private readonly now: () => number;
	private readonly cache: ToolCache;
	private readonly reads = new Map<string, SessionRead>();
	private readonly callCounts = new Map<string, number>();
	private readonly pendingPrefetch = new Map<string, PrefetchItem[]>();
	private readonly prefetched = new Set<string>();
	private readonly prefetchCounted = new Set<string>();
	private readonly reflected = new Set<Phase>();
	private readonly pendingNotes = new Map<string, string[]>();
	private known: KnownFacts = { files_read: [], files_listed: [] };
	private epoch = 0;
	private _phase: Phase = 'explore';
	private readonly startedAt: number;
	private readonly c: GovernorCounters;
	private readonly onMetrics?: (m: GovernorMetrics) => void;

	constructor(o: GovernorOptions) {
		this.backend = o.backend;
		this.policy = o.policy ?? DEFAULT_POLICY;
		this.now = o.now ?? (() => Date.now());
		this.sessionId = o.sessionId ?? `s-${this.now().toString(36)}`;
		this.host = o.host ?? 'unknown';
		this.enabled = o.enabled ?? true;
		this.cache = new ToolCache(o.cacheStore);
		this.onMetrics = o.onMetrics;
		this.startedAt = this.now();
		this.c = {
			proposed: 0, served: 0, servedBy: { session: 0, pack: 0, cache: 0, loop: 0 }, executed: 0, blocked: 0, repeats: 0, loops: 0, writes: 0,
			tokensServed: 0, tokensExecuted: 0, cacheHits: 0, cacheMisses: 0, prefetchIssued: 0, prefetchUsed: 0, reflections: 0,
			byPhase: Object.fromEntries(PHASES.map(p => [p, emptyPhase(this.startedAt)])) as GovernorCounters['byPhase'],
		};
	}

	get phase(): Phase { return this._phase; }

	setPhase(p: Phase): void {
		if (p === this._phase) return;
		this._phase = p;
		this.c.byPhase[p] = emptyPhase(this.now());
		this.reflected.delete(p);
		this.emit();
	}

	/** Install the current pack's known facts (from riaf_compile / SessionStart). */
	setKnownFacts(k: KnownFacts | undefined): void {
		this.known = k ? { files_read: k.files_read ?? [], ranges_read: k.ranges_read ?? [], files_listed: k.files_listed ?? [], symbols_resolved: k.symbols_resolved ?? [] } : { files_read: [], files_listed: [] };
	}

	private treeDep(): string { return `${this.backend.treeVersion()}#${this.epoch}`; }

	private depHash = (dep: string): string | null => (dep === '*' ? this.treeDep() : this.backend.blobHash(dep));

	private keyOf(call: ToolCall): { key: string; argsNorm: string } {
		const args = { ...call.args };
		const p = pathArg(args);
		if (p) for (const k of ['file_path', 'filePath', 'path', 'notebook_path', 'target_file', 'file']) if (args[k] === p) args[k] = this.backend.relative(p);
		const argsNorm = normaliseArgs(args);
		return { key: cacheKey(call.tool.toLowerCase(), argsNorm), argsNorm };
	}

	private serve(content: string, source: ServeSource, note: string): GuardDecision {
		const tokens = estimateGovTokens(content);
		this.c.served++; this.c.servedBy[source]++; this.c.tokensServed += tokens;
		this.emit();
		return { decision: 'serve', content, source, note, tokens };
	}

	private exploratory(cls: CallClass): boolean { return cls === 'read' || cls === 'search' || cls === 'list' || cls === 'shell-read'; }

	private reflectionPrompt(kind: 'soft' | 'hard'): string {
		const p = this.c.byPhase[this._phase];
		const ceil = this.policy.phases[this._phase];
		const head = kind === 'hard'
			? `RIAF budget: hard ceiling reached in the ${this._phase} phase (${p.calls}/${ceil.max_calls} tool calls, ~${p.tokens} tokens). Further exploratory reads are blocked.`
			: `RIAF budget: you have made ${p.calls} tool calls (~${p.tokens} tokens) in the ${this._phase} phase (soft ceiling ${ceil.soft_calls}).`;
		return `${head} Summarise what you know, list the open questions, and write a plan (riaf_compile with stage "plan", or your plan tool) so sub-agents inherit it — then continue with targeted calls only.`;
	}

	/** Decide before a tool runs. Never throws: any internal error allows the call. */
	async guard(call: ToolCall): Promise<GuardDecision> {
		try { return await this._guard(call); } catch (e) { return { decision: 'allow', note: `governor error: ${String((e as Error)?.message ?? e)}` }; }
	}

	private async _guard(call: ToolCall): Promise<GuardDecision> {
		const cls = classifyCall(call);
		this.c.proposed++;
		if (!this.enabled) { this.emit(); return { decision: 'allow', note: 'governance disabled' }; }
		const { key } = this.keyOf(call);
		const count = (this.callCounts.get(key) ?? 0) + 1;
		this.callCounts.set(key, count);
		if (count > 1) this.c.repeats++;
		const isLoop = count >= this.policy.guard.loop_threshold;
		if (isLoop) this.c.loops++;

		// Budget: hard ceilings block exploration (writes, tests and other calls still run).
		const ph = this.c.byPhase[this._phase];
		const ceil = this.policy.phases[this._phase];
		const minutes = (this.now() - ph.startedAt) / 60_000;
		if (this.exploratory(cls) && (ph.calls >= ceil.max_calls || ph.tokens >= ceil.max_tokens || minutes >= ceil.max_minutes)) {
			this.c.blocked++; this.emit();
			return { decision: 'block', reason: this.reflectionPrompt('hard') };
		}

		if (cls === 'read') {
			const raw = pathArg(call.args);
			if (!raw) return this.allow(cls);
			const path = this.backend.relative(raw);
			if (this.prefetched.has(path) && !this.prefetchCounted.has(path)) { this.prefetchCounted.add(path); this.c.prefetchUsed++; }
			const offset = Number(call.args.offset ?? 0) || 0;
			const limit = Number(call.args.limit ?? 0) || 0;
			const from = offset > 0 ? offset : 1;
			const blob = this.backend.blobHash(path);
			if (blob === null) return this.allow(cls);
			const prev = this.reads.get(path);
			const covered = (r: SessionRead) => r.blob === blob && (r.full || (limit > 0 && r.ranges.some(([a, b]) => a <= from && from + limit - 1 <= b)));
			if (prev && covered(prev) && (this.policy.guard.serve_repeat_reads || isLoop)) {
				const text = this.backend.readFile(path);
				if (text !== null) {
					const body = formatLines(text, from, limit || undefined);
					return this.serve(body, isLoop ? 'loop' : 'session', `${isLoop ? `RIAF loop warning: this exact Read was requested ${count} times. ` : ''}Served from the RIAF index — ${path} is unchanged since you read it (blob ${blob.slice(0, 8)}); no tool call was needed. Do not re-read unchanged files.`);
				}
			}
			if (this.policy.guard.serve_first_reads) {
				const inPack = this.known.files_read.some(f => f.path === path && (!f.blob || f.blob === blob))
					|| (limit > 0 && (this.known.ranges_read ?? []).some(r => r.path === path && (!r.blob || r.blob === blob) && r.range[0] <= from && from + limit - 1 <= r.range[1]));
				if (inPack) {
					const text = this.backend.readFile(path);
					if (text !== null) {
						this.reads.set(path, { blob, full: !limit, ranges: limit ? [[from, from + limit - 1]] : [], at: this.now() });
						return this.serve(formatLines(text, from, limit || undefined), 'pack', `Served from the RIAF Context Pack — ${path} (blob ${blob.slice(0, 8)}) is already in your context.`);
					}
				}
			}
			return this.allow(cls, path);
		}

		if ((cls === 'search' || cls === 'list' || cls === 'shell-read') && this.policy.guard.cache_searches) {
			if (cls === 'list') {
				const p = this.backend.relative(pathArg(call.args) ?? '.').replace(/\/$/, '') || '.';
				if (this.known.files_listed.includes(p) && this.policy.guard.serve_first_reads) {
					const hit = this.cache.get(key, this.depHash);
					if (hit) return this.serve(hit.result, 'pack', `Served from the RIAF Context Pack — the listing of ${p} is already in your context.`);
				}
			}
			const hit = this.cache.get(key, this.depHash);
			if (hit) {
				this.c.cacheHits++;
				return this.serve(hit.result, isLoop ? 'loop' : 'cache', `${isLoop ? `RIAF loop warning: this exact call was made ${count} times. ` : ''}Served from the RIAF tool cache — no file under the search scope changed since this exact ${call.tool} ran (${new Date(hit.ts).toISOString().slice(11, 19)}).`);
			}
			this.c.cacheMisses++;
		}
		if (cls === 'write' || cls === 'shell') { /* phase transitions happen in record() */ }
		if (cls === 'test' && this._phase !== 'verify') this.setPhase('verify');
		if (isLoop) {
			this.note(key, `RIAF loop warning: this exact ${call.tool} call has been made ${count} times. Change approach instead of repeating it.`);
		}
		return this.allow(cls);
	}

	private note(key: string, text: string): void {
		const l = this.pendingNotes.get(key) ?? [];
		l.push(text); this.pendingNotes.set(key, l);
	}

	private async allow(cls: CallClass, readPath?: string): Promise<GuardDecision> {
		let prefetch: PrefetchItem[] | undefined;
		if (readPath && this.policy.prefetch.enabled && this.backend.prefetchCandidates && this.backend.outline) {
			const cands = await this.backend.prefetchCandidates(readPath, this.policy.prefetch.min_coupling);
			const fresh = cands.filter(c => c.path !== readPath && !this.reads.has(c.path) && !this.prefetched.has(c.path) && !this.known.files_read.some(f => f.path === c.path)).slice(0, this.policy.prefetch.max_files);
			if (fresh.length) {
				prefetch = [];
				for (const c of fresh) {
					const content = await this.backend.outline(c.path);
					if (!content) continue;
					prefetch.push({ path: c.path, reason: c.reason, content });
					this.prefetched.add(c.path);
				}
				this.c.prefetchIssued += prefetch.length;
				if (!prefetch.length) prefetch = undefined;
			}
		}
		this.emit();
		void cls;
		return { decision: 'allow', prefetch };
	}

	/**
	 * Record a tool result (after it ran). Returns extra context for the agent: prefetched neighbours,
	 * loop warnings and soft-budget reflections.
	 */
	async record(call: ToolCall, output: string, opts: { isError?: boolean; prefetch?: PrefetchItem[] } = {}): Promise<{ additionalContext?: string }> {
		try { return await this._record(call, output, opts); } catch { return {}; }
	}

	private async _record(call: ToolCall, output: string, opts: { isError?: boolean; prefetch?: PrefetchItem[] }): Promise<{ additionalContext?: string }> {
		const cls = classifyCall(call);
		const { key, argsNorm } = this.keyOf(call);
		const tokens = estimateGovTokens(output);
		this.c.executed++; this.c.tokensExecuted += tokens;
		const ph = this.c.byPhase[this._phase];
		ph.calls++; ph.tokens += tokens;
		const extra: string[] = [];

		if (cls === 'read' && !opts.isError) {
			const raw = pathArg(call.args);
			if (raw) {
				const path = this.backend.relative(raw);
				const blob = this.backend.blobHash(path);
				if (blob) {
					const offset = Number(call.args.offset ?? 0) || 0;
					const limit = Number(call.args.limit ?? 0) || 0;
					const prev = this.reads.get(path);
					const same = prev && prev.blob === blob ? prev : { blob, full: false, ranges: [] as [number, number][], at: this.now() };
					if (!limit && !offset) same.full = true;
					else same.ranges.push([offset || 1, (offset || 1) + (limit || 2000) - 1]);
					same.at = this.now();
					this.reads.set(path, same);
				}
			}
		}
		if ((cls === 'search' || cls === 'list' || cls === 'shell-read') && !opts.isError && this.policy.guard.cache_searches) {
			this.cache.put({ key, tool: call.tool, argsNorm, blobs: { '*': this.treeDep() }, result: output, ts: this.now() });
		}
		if (cls === 'write' || cls === 'shell') {
			const raw = pathArg(call.args);
			const paths = raw ? [this.backend.relative(raw)] : [];
			if (cls === 'write' || SHELL_WRITE.test(String(call.args.command ?? ''))) {
				this.c.writes++;
				this.epoch++;
				for (const p of paths) this.reads.delete(p);
				this.cache.invalidate(paths);
				if (cls === 'write' && (this._phase === 'explore' || this._phase === 'plan' || this._phase === 'verify')) this.setPhase('implement');
				try { await this.backend.onWrite?.(paths); } catch { /* re-index is best-effort */ }
			}
		}

		const pf = opts.prefetch ?? this.pendingPrefetch.get(key);
		this.pendingPrefetch.delete(key);
		if (pf?.length) extra.push(`RIAF prefetched files that usually change or are read together with this one (outlines only — use riaf_lookup for bodies):\n${pf.map(p => `### ${p.path} — ${p.reason}\n${p.content}`).join('\n\n')}`);
		const notes = this.pendingNotes.get(key);
		if (notes) { extra.push(...notes); this.pendingNotes.delete(key); }

		const ceil = this.policy.phases[this._phase];
		if (!this.reflected.has(this._phase) && (ph.calls >= ceil.soft_calls || ph.tokens >= ceil.soft_tokens)) {
			this.reflected.add(this._phase); this.c.reflections++;
			extra.push(this.reflectionPrompt('soft'));
		}
		this.emit();
		return extra.length ? { additionalContext: extra.join('\n\n') } : {};
	}

	/** Stash prefetch items produced by guard() for delivery by record() (hosts with separate pre/post hooks). */
	stashPrefetch(call: ToolCall, items: PrefetchItem[] | undefined): void {
		if (items?.length) this.pendingPrefetch.set(this.keyOf(call).key, items);
	}

	/** External write notification (file watcher, extension save) — invalidates without counting a call. */
	invalidate(paths: string[]): void {
		this.epoch++;
		for (const p of paths) this.reads.delete(this.backend.relative(p));
		this.cache.invalidate(paths.map(p => this.backend.relative(p)));
	}

	metrics(): GovernorMetrics {
		const c = this.c;
		const lookups = c.cacheHits + c.cacheMisses;
		return {
			...JSON.parse(JSON.stringify(c)) as GovernorCounters,
			sessionId: this.sessionId, host: this.host, phase: this._phase, startedAt: this.startedAt,
			callsAvoidedRate: c.proposed ? (c.served + c.blocked) / c.proposed : 0,
			tokensSavedRate: c.tokensServed + c.tokensExecuted ? c.tokensServed / (c.tokensServed + c.tokensExecuted) : 0,
			cacheHitRate: lookups ? c.cacheHits / lookups : 0,
			prefetchPrecision: c.prefetchIssued ? c.prefetchUsed / c.prefetchIssued : 0,
		};
	}

	private emit(): void {
		if (!this.onMetrics) return;
		try { this.onMetrics(this.metrics()); } catch { /* ignore */ }
	}
}

export function formatMetrics(m: GovernorMetrics): string {
	const pct = (x: number) => `${Math.round(x * 100)}%`;
	return [
		`RIAF governance — session ${m.sessionId} (${m.host}), phase ${m.phase}`,
		`- calls: ${m.proposed} proposed, ${m.served} served from index (session ${m.servedBy.session}, pack ${m.servedBy.pack}, cache ${m.servedBy.cache}, loop ${m.servedBy.loop}), ${m.executed} executed, ${m.blocked} blocked`,
		`- calls avoided: ${pct(m.callsAvoidedRate)} · tokens saved: ${pct(m.tokensSavedRate)} (~${m.tokensServed} served vs ~${m.tokensExecuted} executed)`,
		`- cache hit rate: ${pct(m.cacheHitRate)} · prefetch precision: ${pct(m.prefetchPrecision)} (${m.prefetchUsed}/${m.prefetchIssued})`,
		`- repeats ${m.repeats}, loops ${m.loops}, writes ${m.writes}, reflections ${m.reflections}`,
	].join('\n');
}
