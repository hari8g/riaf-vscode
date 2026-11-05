/**
 * Run telemetry for the RIAF Console: turns Claude Code hook payloads into readable activity events
 * and, once a session has run, into a report of what was done. Pure (no node, no vscode) so the host,
 * the daemon and the tests share it.
 */
import { extractBriefRequest } from '@bosch-mps/riaf-core';


/* ───────── test output ───────── */

export interface TestRun { framework: string; passed: number; failed: number; skipped: number; errors: number; total: number; ok: boolean; durationMs?: number }

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

const TEST_CMD = /\b(pytest|py\.test|unittest|tox|nox|jest|vitest|mocha|ava|tap|playwright test|cypress run|go test|cargo (?:test|nextest)|dotnet test|mvn(?:w)?\s+(?:\S+\s+)*test|gradlew?\s+(?:\S+\s+)*test|rspec|phpunit|ctest|deno test|bun test|npm (?:run )?(?:test|t)\b|npm run [\w:-]*test[\w:-]*|yarn (?:run )?[\w:-]*test[\w:-]*|pnpm (?:run )?[\w:-]*test[\w:-]*|make (?:\S+ )?test)\b/i;

const PROBE_FIRST = /^(?:ls|cat|grep|rg|find|echo|which|command|type|sed|head|tail|pip3?|brew|printf|wc|awk|test|\[|env|printenv|pwd|cd|source|export)$/;
/**
 * Is some segment of this command itself a test run (`pytest`, `npm test`, `X=1 python -m pytest`), as opposed to a command that merely
 * mentions a runner (`ls ~/envs; pytest --version`, `which pytest`)? Only the first earns a "failed test run" when the output has no summary.
 */
export function isTestInvocation(command: string): boolean {
	return command.split(/&&|\|\||;|\n|\|/).some(raw => {
		const seg = raw.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, '').trim();
		if (!seg || /--version|--help|\s-h(?:\s|$)/.test(seg)) return false;
		const first = seg.split(/\s+/)[0].replace(/^.*\//, '');
		if (PROBE_FIRST.test(first)) return false;
		return TEST_CMD.test(seg);
	});
}

export const looksLikeTestCommand = (command: string): boolean => TEST_CMD.test(command);

const num = (s: string | undefined): number => (s ? Number(s) : 0);
const count = (text: string, re: RegExp): number => { const m = re.exec(text); return m ? Number(m[1]) : 0; };

/** Parse a test runner's summary out of command output. Returns null when no known summary is present. */
export function parseTestRun(command: string, rawOutput: string): TestRun | null {
	const out = rawOutput.replace(ANSI, '').slice(-60_000);
	const make = (framework: string, p: number, f: number, s: number, e: number, durationMs?: number, totalOverride?: number): TestRun => {
		const total = totalOverride ?? p + f + s + e;
		return { framework, passed: p, failed: f, skipped: s, errors: e, total, ok: f === 0 && e === 0 && total > 0, ...(durationMs !== undefined ? { durationMs } : {}) };
	};

	// pytest: "== 2 failed, 12 passed, 1 skipped in 1.23s ==" or "12 passed in 0.5s"
	const lines = out.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i];
		const m = /^[=\s-]*(.*?\b(?:passed|failed|error|errors|skipped|xfailed|xpassed|deselected)\b.*?)\s+in\s+([\d.]+)s\b/.exec(l);
		if (m && /\b\d+\s+(passed|failed|errors?|skipped)/.test(m[1])) {
			const seg = m[1];
			return make('pytest', count(seg, /(\d+) passed/), count(seg, /(\d+) failed/), count(seg, /(\d+) skipped/), count(seg, /(\d+) errors?/), Math.round(Number(m[2]) * 1000));
		}
	}
	// jest: "Tests:       1 failed, 2 passed, 3 total"
	let m = /^\s*Tests:\s+(.*?)(\d+) total/m.exec(out);
	if (m) {
		const seg = m[1];
		const t = /^\s*Time:\s+([\d.]+)\s*s/m.exec(out);
		return make('jest', count(seg, /(\d+) passed/), count(seg, /(\d+) failed/), count(seg, /(\d+) (?:skipped|todo)/), 0, t ? Math.round(Number(t[1]) * 1000) : undefined, Number(m[2]));
	}
	// vitest: "      Tests  1 failed | 235 passed | 1 skipped (237)"
	m = /^\s*Tests\s+([^\n(]*)\((\d+)\)/m.exec(out);
	if (m) {
		const seg = m[1];
		const d = /^\s*Duration\s+([\d.]+)(ms|s)\b/m.exec(out);
		return make('vitest', count(seg, /(\d+) passed/), count(seg, /(\d+) failed/), count(seg, /(\d+) (?:skipped|todo)/), 0, d ? Math.round(Number(d[1]) * (d[2] === 's' ? 1000 : 1)) : undefined, Number(m[2]));
	}
	// node:test / tap: "ℹ pass 3" "ℹ fail 0"
	if (/^\s*[ℹ#]\s+pass\s+\d+/m.test(out)) {
		return make('node:test', count(out, /^\s*[ℹ#]\s+pass\s+(\d+)/m), count(out, /^\s*[ℹ#]\s+fail\s+(\d+)/m), count(out, /^\s*[ℹ#]\s+skipped\s+(\d+)/m), 0);
	}
	// mocha: "12 passing (3s)" "1 failing" "2 pending"
	if (/^\s*\d+\s+passing\b/m.test(out) || /^\s*\d+\s+failing\b/m.test(out)) {
		return make('mocha', count(out, /^\s*(\d+)\s+passing/m), count(out, /^\s*(\d+)\s+failing/m), count(out, /^\s*(\d+)\s+pending/m), 0);
	}
	// cargo: "test result: ok. 5 passed; 0 failed; 1 ignored;" (one per crate)
	if (/test result:/.test(out)) {
		let p = 0, f = 0, s = 0;
		for (const r of out.matchAll(/test result: \w+\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored/g)) { p += num(r[1]); f += num(r[2]); s += num(r[3]); }
		return make('cargo', p, f, s, 0);
	}
	// go: per-package "ok  \tpkg" / "FAIL\tpkg"
	if (/^(ok|FAIL)\s+\S+/m.test(out) && /go test/.test(command)) {
		const ok = [...out.matchAll(/^ok\s+\S+/gm)].length, bad = [...out.matchAll(/^FAIL\s+\S+/gm)].length;
		return make('go', ok, bad, 0, 0);
	}
	// python unittest: "Ran 5 tests in 0.002s" then "OK" / "FAILED (failures=1, errors=1)"
	m = /^Ran (\d+) tests? in ([\d.]+)s/m.exec(out);
	if (m) {
		const total = Number(m[1]);
		const f = count(out, /failures=(\d+)/), e = count(out, /errors=(\d+)/), s = count(out, /skipped=(\d+)/);
		return make('unittest', Math.max(0, total - f - e - s), f, s, e, Math.round(Number(m[2]) * 1000), total);
	}
	return null;
}

/* ───────── hook payload → event detail ───────── */

export interface EventDetail {
	prompt?: string;
	file?: string; added?: number; removed?: number; created?: boolean; write?: boolean;
	command?: string; failed?: boolean; tests?: TestRun; tail?: string;
	head?: string; branch?: string; dirty?: string[];
	instruction?: string; intent?: string; request?: string; pack?: string[]; plan?: string[]; verify?: string[];
	desc?: string; brief?: string;
}

export interface HookLike { hook_event_name?: string; tool_name?: string; tool_input?: Record<string, unknown>; tool_response?: unknown; prompt?: string; error?: unknown }

const lineCount = (s: unknown): number => typeof s === 'string' && s.length ? s.replace(/\n$/, '').split('\n').length : 0;

/** Text of a tool response (stdout/stderr/content/error), whatever shape the Claude Code version sends. */
export function responseText(r: unknown): string {
	if (r == null) return '';
	if (typeof r === 'string') return r;
	if (Array.isArray(r)) return r.map(responseText).join('\n');
	const o = r as Record<string, unknown>;
	const parts: string[] = [];
	for (const k of ['stdout', 'stderr', 'output', 'error', 'text']) if (typeof o[k] === 'string') parts.push(o[k] as string);
	if (typeof o.content === 'string') parts.push(o.content);
	else if (Array.isArray(o.content)) parts.push(o.content.map(c => (c && typeof c === 'object' && 'text' in (c as object) ? String((c as { text: unknown }).text) : '')).join('\n'));
	return parts.join('\n');
}

const MULTI = (input: Record<string, unknown>): { old: unknown; neu: unknown }[] => Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]).map(e => ({ old: e.old_string, neu: e.new_string })) : [];

/** Compact, display-ready facts about one hook event; null when there is nothing worth keeping. */
export function eventDetail(p: HookLike, rel: (path: string) => string): EventDetail | null {
	const ev = p.hook_event_name ?? '';
	const input = p.tool_input ?? {};
	const tool = p.tool_name ?? '';
	if (ev === 'UserPromptSubmit') {
		if (!p.prompt) return null;
		const brief = extractBriefRequest(p.prompt); // a pasted RIAF brief: the task is the request inside it
		return brief ? { prompt: brief.request.slice(0, 600), brief: brief.id } : { prompt: p.prompt.replace(/\s+/g, ' ').trim().slice(0, 600) };
	}
	if (ev !== 'PostToolUse' && ev !== 'PostToolUseFailure' && ev !== 'PreToolUse') return null;
	const failed = ev === 'PostToolUseFailure' || !!(p.tool_response && typeof p.tool_response === 'object' && ((p.tool_response as Record<string, unknown>).is_error || (p.tool_response as Record<string, unknown>).isError));
	if (ev === 'PreToolUse') return null; // the Post event carries the facts; Pre is kept for the governor's serve/block decisions
	if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'NotebookEdit') {
		const file = typeof input.file_path === 'string' ? rel(input.file_path) : typeof input.notebook_path === 'string' ? rel(input.notebook_path) : undefined;
		if (!file) return null;
		if (tool === 'Write') return { file, added: lineCount(input.content), removed: 0, write: true, ...(failed ? { failed } : {}) };
		if (tool === 'NotebookEdit') return { file, added: lineCount(input.new_source), removed: 0, ...(failed ? { failed } : {}) };
		const edits = tool === 'MultiEdit' ? MULTI(input) : [{ old: input.old_string, neu: input.new_string }];
		return { file, added: edits.reduce((a, e) => a + lineCount(e.neu), 0), removed: edits.reduce((a, e) => a + lineCount(e.old), 0), ...(failed ? { failed } : {}) };
	}
	if (tool === 'Bash') {
		const command = typeof input.command === 'string' ? input.command.trim() : '';
		const text = responseText(ev === 'PostToolUseFailure' ? (p.error ?? p.tool_response) : p.tool_response);
		const tests = looksLikeTestCommand(command) || /\d+ (passed|failed)|Tests:|test result:|\bpassing\b/.test(text) ? parseTestRun(command, text) : null;
		const d: EventDetail = { command: command.slice(0, 400), ...(failed ? { failed } : {}) };
		if (tests) d.tests = tests;
		else if (failed && isTestInvocation(command)) d.tests = { framework: 'unknown', passed: 0, failed: 0, skipped: 0, errors: 1, total: 0, ok: false };
		if (failed || tests) d.tail = text.replace(ANSI, '').trim().split('\n').slice(-6).join('\n').slice(-500);
		return d;
	}
	if (tool === 'Task') return { desc: String(input.description ?? input.subagent_type ?? 'sub-agent').slice(0, 160) };
	if (tool.startsWith('mcp__riaf__')) {
		const arg = ['path', 'file_path', 'symbol', 'query', 'pattern', 'request', 'dir'].map(k => input[k]).find(v => typeof v === 'string' && v) as string | undefined;
		return { desc: `${tool.slice('mcp__riaf__'.length)}${arg ? ` ${arg}` : ''}`.slice(0, 160), ...(failed ? { failed } : {}) };
	}
	return null;
}

/* ───────── event classification ───────── */

export type EventKind = 'start' | 'prompt' | 'read' | 'search' | 'edit' | 'command' | 'test' | 'served' | 'blocked' | 'briefing' | 'subagent' | 'turn-end' | 'end' | 'riaf' | 'other';

export interface RunEvent {
	id: number; sessionId: string; ts: number; event: string; tool: string | null; path: string | null; decision: string | null; reason: string | null;
	detail: EventDetail | null; kind: EventKind; label: string;
}

const short = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function classifyEvent(e: { event: string; tool: string | null; path: string | null; decision: string | null; reason: string | null; detail: EventDetail | null }): { kind: EventKind; label: string } {
	const d = e.detail;
	switch (e.event) {
		case 'SessionStart': return { kind: 'start', label: 'Session started' };
		case 'SessionEnd': return { kind: 'end', label: 'Session ended' };
		case 'PromptReceived': return { kind: 'briefing', label: 'Task received. RIAF is preparing the brief…' };
		case 'Superseded': return { kind: 'end', label: 'Closed: a newer prompt started a new run' };
		case 'Stop': return { kind: 'turn-end', label: 'Claude Code finished its turn' };
		case 'SubagentStop': return { kind: 'subagent', label: 'A sub-agent finished' };
		case 'UserPromptSubmit': return { kind: 'prompt', label: d?.prompt ? `Task: ${short(d.prompt, 140)}` : 'Prompt submitted' };
		default: break;
	}
	if (e.event === 'PreToolUse') {
		if (e.decision === 'deny') {
			const blocked = /repeat|already|loop|blocked/i.test(e.reason ?? '') && !/served|index|pack|cache/i.test(e.reason ?? '');
			return blocked ? { kind: 'blocked', label: `Blocked a repeat ${e.tool ?? 'call'}${e.path ? ` of ${short(e.path, 60)}` : ''}` } : { kind: 'served', label: `Answered ${e.tool ?? 'call'}${e.path ? ` ${short(e.path, 60)}` : ''} from the index, no tool call needed` };
		}
		return { kind: 'other', label: `Wants to ${e.tool === 'Bash' ? 'run' : (e.tool ?? 'call').toLowerCase()} ${short(e.path ?? '', 70)}`.trim() };
	}
	const tool = e.tool ?? '';
	if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'Write' || tool === 'NotebookEdit') {
		const f = d?.file ?? e.path ?? 'a file';
		const delta = d && (d.added || d.removed) ? ` +${d.added ?? 0} −${d.removed ?? 0}` : '';
		return { kind: 'edit', label: `${tool === 'Write' ? 'Wrote' : 'Edited'} ${f}${delta}${d?.failed ? ' (failed)' : ''}` };
	}
	if (tool === 'Bash') {
		if (d?.tests) {
			const t = d.tests;
			return { kind: 'test', label: t.total ? `Ran tests (${t.framework}): ${t.passed} passed${t.failed ? `, ${t.failed} failed` : ''}${t.errors ? `, ${t.errors} errors` : ''}${t.skipped ? `, ${t.skipped} skipped` : ''}` : `Ran tests: ${d.command ? short(d.command, 60) : 'no summary found'} ${t.ok ? '' : '(failed)'}`.trim() };
		}
		return { kind: 'command', label: `Ran ${short(d?.command ?? e.path ?? 'a command', 100)}${d?.failed ? ' (failed)' : ''}` };
	}
	if (tool === 'Read') return { kind: 'read', label: `Read ${short(e.path ?? 'a file', 80)}` };
	if (tool === 'Grep' || tool === 'Glob' || tool === 'LS') return { kind: 'search', label: `${tool === 'LS' ? 'Listed' : 'Searched'} ${short(e.path ?? '', 80)}`.trim() };
	if (tool === 'Task') return { kind: 'subagent', label: `Started a sub-agent: ${d?.desc ?? ''}`.trim() };
	if (tool.startsWith('mcp__riaf__')) return { kind: 'riaf', label: `RIAF ${short(d?.desc ?? tool.slice('mcp__riaf__'.length), 90)}${d?.failed ? ' (failed)' : ''}` };
	if (e.decision === 'context') return { kind: 'briefing', label: e.reason ? short(e.reason, 100) : 'RIAF added context' };
	return { kind: 'other', label: `${e.event} ${tool}`.trim() };
}

/* ───────── session status ───────── */

export type RunStatus = 'running' | 'waiting' | 'finished' | 'stale';
export const RUNNING_WINDOW_MS = 3 * 60_000;

/** `events` in chronological order. */
export function runStatus(events: { event: string; ts: number }[], now: number): RunStatus {
	const last = events[events.length - 1];
	if (!last) return 'stale';
	if (last.event === 'SessionEnd' || last.event === 'Superseded') return 'finished';
	if (last.event === 'Stop') return now - last.ts > 6 * 3600_000 ? 'finished' : 'waiting';
	return now - last.ts <= RUNNING_WINDOW_MS ? 'running' : 'stale';
}

export interface RunSummary {
	sessionId: string; status: RunStatus; startedAt: number; updatedAt: number; durationMs: number;
	title: string | null; turns: number; filesRead: number; filesEdited: number; commands: number;
	linesAdded: number; linesRemoved: number;
	tests: { runs: number; passed: number; failed: number; lastOk: boolean | null };
}

export function summarizeRun(sessionId: string, events: RunEvent[], now: number): RunSummary {
	const read = new Set<string>(), edited = new Set<string>();
	let commands = 0, turns = 0, added = 0, removed = 0;
	const runs: TestRun[] = [];
	let title: string | null = null;
	for (const e of events) {
		if (e.kind === 'prompt') { turns++; if (!title && e.detail?.prompt) title = e.detail.prompt; }
		else if (e.kind === 'read' && e.path && e.event === 'PostToolUse') read.add(e.path);
		else if (e.kind === 'edit' && e.detail?.file) { edited.add(e.detail.file); added += e.detail.added ?? 0; removed += e.detail.removed ?? 0; }
		else if (e.kind === 'command') commands++;
		else if (e.kind === 'test' && e.detail?.tests) runs.push(e.detail.tests);
	}
	const last = runs[runs.length - 1];
	const startedAt = events[0]?.ts ?? now, updatedAt = events[events.length - 1]?.ts ?? now;
	return {
		sessionId, status: runStatus(events, now), startedAt, updatedAt, durationMs: Math.max(0, updatedAt - startedAt),
		title: title ? short(title, 140) : null, turns, filesRead: read.size, filesEdited: edited.size, commands, linesAdded: added, linesRemoved: removed,
		tests: { runs: runs.length, passed: last?.passed ?? 0, failed: last ? last.failed + last.errors : 0, lastOk: last ? last.ok : null },
	};
}

/* ───────── the report ───────── */

export const isTestPath = (p: string): boolean => /(^|\/)(tests?|__tests__|spec|specs)\//i.test(p) || /(^|\/)test_[^/]+\.py$|_test\.(py|go)$|\.(test|spec)\.[cm]?[jt]sx?$|Tests?\.(java|cs|kt)$/i.test(p);

export interface ReportInput {
	sessionId: string;
	events: RunEvent[];                // chronological
	metrics?: Record<string, unknown> | null;
	instruction?: { id: string; request: string; intent: string; plan: string[]; verification: string[]; packPaths: string[] } | null;
	git?: { branch?: string; startHead?: string; endHead?: string; changed: { file: string; added: number; removed: number }[]; untracked: string[] } | null;
	now: number;
}

export interface RunReport {
	sessionId: string; status: RunStatus; startedAt: number; endedAt: number; durationMs: number;
	verdict: 'tests-passing' | 'tests-failing' | 'no-tests' | 'in-progress';
	headline: string;
	summary: string[];
	task: { prompts: { ts: number; text: string }[]; instruction: ReportInput['instruction'] };
	phases: { phase: string; calls: number; tokens: number }[];
	steps: { ts: number; kind: EventKind; label: string; count: number }[];
	files: { outside: { path: string; edited: boolean }[]; read: { path: string; count: number }[]; edited: { path: string; edits: number; added: number; removed: number; isTest: boolean; isNew: boolean; inPack: boolean | null; firstTs: number; lastTs: number }[] };
	tests: { runs: { ts: number; command: string; framework: string; passed: number; failed: number; skipped: number; errors: number; total: number; ok: boolean; durationMs?: number }[]; redToGreen: boolean; testFilesTouched: string[]; newTestFiles: string[]; final: TestRun | null };
	commands: { ts: number; command: string; failed: boolean }[];
	governance: { proposed: number; served: number; blocked: number; avoidedRate: number; tokensServed: number; tokensExecuted: number; riafToolCalls: number; shellExploration: number };
	context: { packItems: number; touched: number; touchedInPack: number; hitRate: number | null; missed: string[]; unused: string[] } | null;
	git: { branch?: string; startHead?: string; endHead?: string; changed: { file: string; added: number; removed: number }[]; untracked: string[] } | null;
	notes: string[];
}

const n = (v: unknown): number => Number(v) || 0;
const plural = (k: number, w: string): string => `${k} ${w}${k === 1 ? '' : 's'}`;
export const fmtDuration = (ms: number): string => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };

export function buildRunReport(inp: ReportInput): RunReport {
	const ev = inp.events;
	const sum = summarizeRun(inp.sessionId, ev, inp.now);
	const startedAt = ev[0]?.ts ?? inp.now, endedAt = ev[ev.length - 1]?.ts ?? inp.now;
	const pack = inp.instruction ? new Set(inp.instruction.packPaths) : null;

	const prompts = ev.filter(e => e.kind === 'prompt' && e.detail?.prompt).map(e => ({ ts: e.ts, text: e.detail!.prompt! }));

	// Files. Reads come from PostToolUse (what actually executed); served reads are counted under governance.
	const readMap = new Map<string, number>();
	const editMap = new Map<string, { edits: number; added: number; removed: number; firstTs: number; lastTs: number }>();
	const commands: RunReport['commands'] = [];
	const testRuns: RunReport['tests']['runs'] = [];
	const outsideMap = new Map<string, boolean>();
	const isOutside = (f: string): boolean => f.startsWith('../') || f.startsWith('/') || /^[A-Za-z]:[\\/]/.test(f) || f.startsWith('~');
	const readBefore = new Set<string>(), wroteNew = new Set<string>();
	let riafToolCalls = 0, shellExploration = 0;
	for (const e of ev) {
		if (e.kind === 'riaf' && e.event === 'PostToolUse') riafToolCalls++;
		if (e.kind === 'command' && e.detail?.command && /^\s*(?:cd\s+\S+\s*&&\s*)?(?:grep|rg|sed|cat|head|tail|find|ls|awk|wc)\b/.test(e.detail.command)) shellExploration++;
		if (e.event === 'PostToolUse' && e.kind === 'read' && e.path && isOutside(e.path)) { if (!outsideMap.has(e.path)) outsideMap.set(e.path, false); continue; }
		if (e.event === 'PostToolUse' && e.kind === 'read' && e.path) { readMap.set(e.path, (readMap.get(e.path) ?? 0) + 1); readBefore.add(e.path); }
		if (e.kind === 'edit' && e.detail?.file && !e.detail.failed && isOutside(e.detail.file)) { outsideMap.set(e.detail.file, true); continue; }
		if (e.kind === 'edit' && e.detail?.file && !e.detail.failed && e.detail.write && !readBefore.has(e.detail.file) && !editMap.has(e.detail.file)) wroteNew.add(e.detail.file);
		if (e.kind === 'edit' && e.detail?.file && !e.detail.failed) {
			const x = editMap.get(e.detail.file) ?? { edits: 0, added: 0, removed: 0, firstTs: e.ts, lastTs: e.ts };
			x.edits++; x.added += e.detail.added ?? 0; x.removed += e.detail.removed ?? 0; x.lastTs = e.ts; editMap.set(e.detail.file, x);
		}
		if (e.kind === 'command' && e.detail?.command) commands.push({ ts: e.ts, command: e.detail.command, failed: !!e.detail.failed });
		if (e.kind === 'test' && e.detail?.tests) testRuns.push({ ts: e.ts, command: e.detail.command ?? '', ...e.detail.tests });
	}
	// A file Claude created can't have been in a pack compiled before it existed, so it is neither a hit nor a miss.
	// Without git there is no untracked list: a Write to a file that was never read first is taken as a created file.
	const created = new Set(inp.git ? inp.git.untracked : [...wroteNew]);
	const edited = [...editMap.entries()].map(([path, x]) => ({ path, ...x, isTest: isTestPath(path), isNew: created.has(path), inPack: pack && !created.has(path) ? pack.has(path) : null })).sort((a, b) => a.firstTs - b.firstTs);
	const reads = [...readMap.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count);

	// Tests
	const final = testRuns.length ? testRuns[testRuns.length - 1] : null;
	const firstBad = testRuns.findIndex(t => !t.ok);
	const redToGreen = firstBad >= 0 && testRuns.slice(firstBad + 1).some(t => t.ok) && !!final?.ok;
	const testFilesTouched = edited.filter(f => f.isTest).map(f => f.path);
	const untracked = inp.git ? inp.git.untracked : [...created];
	const newTestFiles = untracked.filter(isTestPath);

	// Governance
	const m = inp.metrics ?? {};
	const proposed = n(m.proposed), served = n(m.served), blocked = n(m.blocked);
	const governance = { proposed, served, blocked, avoidedRate: proposed ? (served + blocked) / proposed : 0, tokensServed: n(m.tokensServed), tokensExecuted: n(m.tokensExecuted), riafToolCalls, shellExploration };

	// Phases (from the governor's own phase accounting)
	const by = (m.byPhase ?? {}) as Record<string, { calls?: number; tokens?: number }>;
	const phases = ['explore', 'plan', 'implement', 'verify'].map(p => ({ phase: p, calls: n(by[p]?.calls), tokens: n(by[p]?.tokens) }));

	// Context quality: did Claude work on the files RIAF packed?
	let context: RunReport['context'] = null;
	if (pack) {
		const touchedAll = new Set<string>([...readMap.keys(), ...editMap.keys()]);
		for (const e of ev) if (e.event === 'PreToolUse' && e.decision === 'deny' && e.path) touchedAll.add(e.path);
		const existing = [...touchedAll].filter(t => !created.has(t));
		const filePacks = new Set([...pack].filter(p => !p.startsWith('(') && !p.endsWith('/')));
		const inPack = existing.filter(t => filePacks.has(t));
		context = {
			packItems: filePacks.size, touched: existing.length, touchedInPack: inPack.length,
			hitRate: existing.length ? inPack.length / existing.length : null,
			missed: existing.filter(t => !filePacks.has(t)).slice(0, 12),
			unused: [...filePacks].filter(p => !touchedAll.has(p)).slice(0, 12),
		};
	}

	// Condensed timeline: collapse runs of the same kind (e.g. 9 reads in a row → "Read 9 files").
	const steps: RunReport['steps'] = [];
	for (const e of ev) {
		if (e.event === 'PreToolUse' && e.decision !== 'deny') continue; // allowed Pre events duplicate their Post event
		if (e.kind === 'other' && e.decision !== 'deny') continue;
		const last = steps[steps.length - 1];
		if (last && last.kind === e.kind && (e.kind === 'read' || e.kind === 'search' || e.kind === 'served')) { last.count++; last.label = `${e.kind === 'read' ? 'Read' : e.kind === 'search' ? 'Searched' : 'Answered from the index:'} ${last.count} ${e.kind === 'served' ? 'calls' : e.kind === 'search' ? 'times' : 'files'}`; continue; }
		steps.push({ ts: e.ts, kind: e.kind, label: e.label, count: 1 });
	}

	// Verdict + narrative
	const verdict: RunReport['verdict'] = sum.status === 'running' ? 'in-progress' : !final ? 'no-tests' : final.ok ? 'tests-passing' : 'tests-failing';
	const addedTotal = edited.reduce((a, f) => a + f.added, 0), removedTotal = edited.reduce((a, f) => a + f.removed, 0);
	const headline = verdict === 'in-progress' ? 'Claude Code is still working'
		: verdict === 'no-tests' ? 'Finished, but no test run was observed'
		: verdict === 'tests-passing' ? `Finished with passing tests${final?.total ? ` (${final.passed} of ${final.total})` : ''}`
		: `Finished with failing tests${final ? ` (${final.failed + final.errors} failing)` : ''}`;
	const summary: string[] = [];
	if (prompts[0]) summary.push(`Task: ${short(prompts[0].text, 200)}`);
	summary.push(`Explored ${plural(readMap.size, 'file')}${served + blocked ? `; RIAF answered ${plural(served, 'call')} from the index and blocked ${plural(blocked, 'repeat')}, saving about ${governance.tokensServed.toLocaleString()} tokens` : ''}.`);
	summary.push(edited.length ? `Edited ${plural(edited.length, 'file')} (+${addedTotal} −${removedTotal} lines)${testFilesTouched.length ? `, including ${plural(testFilesTouched.length, 'test file')}` : ''}.` : 'Made no file edits.');
	if (testRuns.length) summary.push(`Ran tests ${plural(testRuns.length, 'time')}; last run ${final!.ok ? 'passed' : 'failed'}: ${final!.passed} passed, ${final!.failed + final!.errors} failing${final!.skipped ? `, ${final!.skipped} skipped` : ''}${redToGreen ? '. It went from failing to passing during the run' : ''}.`);
	else summary.push('No test command was observed. If it ran tests outside the hooks, they are not counted here.');
	if (riafToolCalls) summary.push(`Used RIAF tools ${plural(riafToolCalls, 'time')} (index lookups instead of shell searches).`);
	else if (pack || inp.instruction) summary.push(`Never called a RIAF tool${shellExploration ? `; explored with ${plural(shellExploration, 'shell command')} (grep/sed/cat/find) that the index could have answered` : ''}.`);
	if (context && context.hitRate !== null) summary.push(`${context.touchedInPack} of the ${context.touched} existing files it touched were in the compiled context pack (${Math.round(context.hitRate * 100)}%).`);

	const notes: string[] = [];
	if (!inp.git) notes.push('This folder is not a git repository, so file changes could not be verified against git. New files are inferred from Write calls to files that were never read; run `git init` and commit a baseline for exact results.');
	if (outsideMap.size) notes.push(`${plural(outsideMap.size, 'path')} outside the repository ${outsideMap.size === 1 ? 'was' : 'were'} touched and left out of the file counts.`);

	return {
		sessionId: inp.sessionId, status: sum.status, startedAt, endedAt, durationMs: Math.max(0, endedAt - startedAt),
		verdict, headline, summary,
		task: { prompts, instruction: inp.instruction ?? null },
		phases, steps,
		files: { outside: [...outsideMap.entries()].map(([path, edited]) => ({ path, edited })), read: reads, edited },
		tests: { runs: testRuns, redToGreen, testFilesTouched, newTestFiles, final },
		commands, governance, context,
		git: inp.git ?? null, notes,
	};
}

export function reportToMarkdown(r: RunReport): string {
	const L: string[] = [];
	const when = (t: number) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
	L.push(`# Run report — ${r.headline}`, '', `Session \`${r.sessionId}\` · ${when(r.startedAt)} → ${when(r.endedAt)} (${fmtDuration(r.durationMs)}) · status ${r.status}`, '');
	L.push('## Summary', '', ...r.summary.map(s => `- ${s}`), '');
	if (r.notes.length) L.push('> Notes', ...r.notes.map(x => `> - ${x}`), '');
	if (r.task.instruction) { const i = r.task.instruction; L.push('## Task and brief', '', `Brief \`${i.id}\` (${i.intent}): ${i.request}`, ''); if (i.plan.length) L.push('Planned steps:', ...i.plan.map((p, k) => `${k + 1}. ${p}`), ''); if (i.verification.length) L.push('Planned verification:', ...i.verification.map(v => `- ${v}`), ''); }
	else if (r.task.prompts.length) L.push('## Task', '', ...r.task.prompts.map(p => `- ${p.text}`), '');
	L.push('## How it was done', '');
	if (r.phases.some(p => p.calls)) L.push(`Phases (tool calls): ${r.phases.map(p => `${p.phase} ${p.calls}`).join(' → ')}`, '');
	L.push(...r.steps.map(s => `- ${new Date(s.ts).toISOString().slice(11, 19)} ${s.label}`), '');
	L.push('## Files changed', '');
	if (r.files.edited.length) { L.push('| File | Edits | Lines | Test file | In context pack |', '|---|---:|---:|:---:|:---:|', ...r.files.edited.map(f => `| \`${f.path}\` | ${f.edits} | +${f.added} −${f.removed} | ${f.isTest ? 'yes' : ''} | ${f.isNew ? 'new file' : f.inPack === null ? '' : f.inPack ? 'yes' : 'no'} |`), ''); } else L.push('None.', '');
	if (r.files.outside.length) L.push('Outside the repository:', ...r.files.outside.map(f => `- \`${f.path}\` (${f.edited ? 'edited' : 'read'})`), '');
	if (r.git?.changed.length) L.push('Verified against git:', ...r.git.changed.map(f => `- \`${f.file}\` +${f.added} −${f.removed}`), ...r.git.untracked.map(f => `- \`${f}\` (new, untracked)`), '');
	L.push('## Tests', '');
	if (r.tests.runs.length) { L.push('| Time | Command | Runner | Passed | Failed | Skipped | Result |', '|---|---|---|---:|---:|---:|:---:|', ...r.tests.runs.map(t => `| ${new Date(t.ts).toISOString().slice(11, 19)} | \`${short(t.command, 60)}\` | ${t.framework} | ${t.passed} | ${t.failed + t.errors} | ${t.skipped} | ${t.ok ? 'pass' : 'FAIL'} |`), ''); if (r.tests.redToGreen) L.push('The suite went from failing to passing during the run.', ''); }
	else L.push('No test run was observed.', '');
	if (r.tests.testFilesTouched.length || r.tests.newTestFiles.length) L.push(`Test files touched: ${[...new Set([...r.tests.testFilesTouched, ...r.tests.newTestFiles])].map(f => `\`${f}\``).join(', ')}`, '');
	if (r.commands.length) L.push('## Other commands', '', ...r.commands.map(c => `- \`${short(c.command, 100)}\`${c.failed ? ' (failed)' : ''}`), '');
	L.push('## Governance and context', '', `- Calls proposed ${r.governance.proposed}, answered from the index ${r.governance.served}, repeats blocked ${r.governance.blocked} (${Math.round(r.governance.avoidedRate * 100)}% avoided)`, `- Tokens served instead of executed ${r.governance.tokensServed.toLocaleString()}, executed ${r.governance.tokensExecuted.toLocaleString()}`);
	L.push(`- RIAF tool calls ${r.governance.riafToolCalls}; shell searches (grep/sed/cat/find) ${r.governance.shellExploration}`);
	if (r.context) L.push(`- Context pack hit rate ${r.context.hitRate === null ? 'n/a' : Math.round(r.context.hitRate * 100) + '%'}; touched but not packed: ${r.context.missed.map(f => `\`${f}\``).join(', ') || 'none'}; packed but unused: ${r.context.unused.length}`);
	return L.join('\n') + '\n';
}
