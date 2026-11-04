/**
 * Claude Code adapter for the governor: hook payload → ToolCall, GuardDecision → hook JSON output.
 *
 *   PreToolUse   serve → permissionDecision "deny" with the indexed content as the reason (Claude reads it
 *                         instead of running the tool); block → deny with the reflection prompt; allow → no output.
 *   PostToolUse  records the result; returns additionalContext (prefetched outlines, loop warnings, reflections).
 *   SessionStart / UserPromptSubmit  inject the compiled pack briefing as additionalContext.
 */
import type { ToolGovernor } from './governor.js';
import type { ToolCall } from './types.js';

export interface ClaudeHookPayload {
	session_id?: string;
	cwd?: string;
	hook_event_name?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_response?: unknown;
	prompt?: string;
	source?: string;
}

export type ClaudeHookOutput = { hookSpecificOutput: Record<string, unknown> } | Record<string, never>;

export interface ClaudeHookHandlerDeps {
	/** One governor per Claude session id (created lazily by the host). */
	governorFor(sessionId: string): ToolGovernor;
	/** SessionStart: briefing for the current branch/task (e.g. the current pack rendered for Claude). */
	onSessionStart?(payload: ClaudeHookPayload): Promise<string | undefined>;
	/** UserPromptSubmit: compile a pack for the prompt (first prompt of a session) and return its briefing. */
	onUserPrompt?(prompt: string, payload: ClaudeHookPayload): Promise<string | undefined>;
	log?(m: string): void;
}

/** Text the model saw for a tool result (Claude Code's tool_response shapes vary by tool). */
export function toolResponseText(r: unknown): string {
	if (r == null) return '';
	if (typeof r === 'string') return r;
	if (Array.isArray(r)) return r.map(toolResponseText).join('\n');
	const o = r as Record<string, unknown>;
	if (typeof o.stdout === 'string' || typeof o.stderr === 'string') return `${o.stdout ?? ''}${o.stderr ? `\n${o.stderr}` : ''}`;
	if (o.file && typeof (o.file as Record<string, unknown>).content === 'string') return (o.file as Record<string, unknown>).content as string;
	if (typeof o.content === 'string') return o.content;
	if (Array.isArray(o.content)) return (o.content as unknown[]).map(c => (c && typeof c === 'object' && 'text' in (c as object) ? String((c as { text: unknown }).text) : toolResponseText(c))).join('\n');
	if (Array.isArray(o.filenames)) return (o.filenames as string[]).join('\n');
	if (typeof o.text === 'string') return o.text;
	return JSON.stringify(r);
}

export const hookCall = (p: ClaudeHookPayload): ToolCall => ({ tool: p.tool_name ?? 'unknown', args: p.tool_input ?? {}, sessionId: p.session_id });

const MAX_REASON = 60_000;

export async function handleClaudeHook(p: ClaudeHookPayload, deps: ClaudeHookHandlerDeps): Promise<ClaudeHookOutput> {
	const event = p.hook_event_name ?? '';
	const sid = p.session_id ?? 'default';
	if (event === 'PreToolUse') {
		const gov = deps.governorFor(sid);
		const call = hookCall(p);
		const d = await gov.guard(call);
		if (d.decision === 'serve') {
			const body = d.content.length > MAX_REASON ? `${d.content.slice(0, MAX_REASON)}\n… (truncated; use offset/limit or riaf_lookup for the rest)` : d.content;
			deps.log?.(`serve ${call.tool} (${d.source}, ~${d.tokens} tokens)`);
			return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[RIAF] ${d.note}\n\n${body}` } };
		}
		if (d.decision === 'block') {
			deps.log?.(`block ${call.tool}`);
			return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[RIAF] ${d.reason}` } };
		}
		gov.stashPrefetch(call, d.prefetch);
		return {};
	}
	if (event === 'PostToolUse') {
		const gov = deps.governorFor(sid);
		const out = toolResponseText(p.tool_response);
		const isError = !!(p.tool_response && typeof p.tool_response === 'object' && ((p.tool_response as Record<string, unknown>).is_error || (p.tool_response as Record<string, unknown>).isError));
		const r = await gov.record(hookCall(p), out, { isError });
		return r.additionalContext ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: r.additionalContext } } : {};
	}
	if (event === 'SessionStart' && deps.onSessionStart) {
		const ctx = await deps.onSessionStart(p).catch(() => undefined);
		return ctx ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } } : {};
	}
	if (event === 'UserPromptSubmit' && deps.onUserPrompt && p.prompt) {
		const ctx = await deps.onUserPrompt(p.prompt, p).catch(() => undefined);
		return ctx ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } } : {};
	}
	return {};
}
