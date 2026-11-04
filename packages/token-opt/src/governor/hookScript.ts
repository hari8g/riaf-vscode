/**
 * Source of `.claude/hooks/riaf-govern.mjs` — the Claude Code hook client. Single source of truth:
 * `riaf init --host claude` and the extension's "Set up Claude Code" both write this text.
 *
 * It forwards the hook payload to the governor endpoint advertised in `<repo>/.riaf/governor.json`
 * and prints the reply. Fail-open: no endpoint, timeout or error → exit 0 with no output (the tool runs).
 * `RIAF_NO_GUARD=1` disables governance for a session.
 */
export const GOVERN_HOOK_FILENAME = 'riaf-govern.mjs';

export const GOVERN_HOOK_SOURCE = `#!/usr/bin/env node
// RIAF tool-call governance hook for Claude Code (generated — do not edit; regenerate with \`riaf init --host claude\`).
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const done = (out) => { if (out && Object.keys(out).length) process.stdout.write(JSON.stringify(out)); process.exit(0); };
if (process.env.RIAF_NO_GUARD === '1') done();
let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { done(); }
let payload;
try { payload = JSON.parse(raw || '{}'); } catch { done(); }
const root = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
let info;
try { info = JSON.parse(readFileSync(join(root, '.riaf', 'governor.json'), 'utf8')); } catch { done(); }
const timeoutMs = Number(process.env.RIAF_HOOK_TIMEOUT_MS || (payload.hook_event_name === 'UserPromptSubmit' || payload.hook_event_name === 'SessionStart' ? 8000 : 1500));
const sock = createConnection(info.endpoint);
let buf = '';
const timer = setTimeout(() => { sock.destroy(); done(); }, timeoutMs);
sock.setEncoding('utf8');
sock.on('connect', () => sock.write(JSON.stringify({ type: 'claude-hook', payload }) + '\\n'));
sock.on('data', (d) => {
	buf += d;
	const nl = buf.indexOf('\\n');
	if (nl < 0) return;
	clearTimeout(timer);
	sock.end();
	let res = {};
	try { res = JSON.parse(buf.slice(0, nl)); } catch { done(); }
	done(res && res.output ? res.output : undefined);
});
sock.on('error', () => { clearTimeout(timer); done(); });
`;

/** Claude Code settings.json hook groups that route tool calls through the governor. */
export function governHookGroups(hookCommand: string): Record<string, { matcher?: string; hooks: { type: 'command'; command: string; timeout?: number }[] }[]> {
	const h = (timeout?: number) => [{ type: 'command' as const, command: hookCommand, ...(timeout ? { timeout } : {}) }];
	return {
		PreToolUse: [{ matcher: 'Read|Grep|Glob|LS|Bash', hooks: h(5) }],
		PostToolUse: [{ matcher: 'Read|Grep|Glob|LS|Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: h(5) }],
		SessionStart: [{ hooks: h(15) }],
		UserPromptSubmit: [{ hooks: h(15) }],
	};
}

/** Merge the governance hook groups into a settings object without dropping existing hooks. */
export function mergeGovernHooks(settings: unknown, hookCommand: string): Record<string, unknown> {
	const base = settings && typeof settings === 'object' ? { ...(settings as Record<string, unknown>) } : {};
	const hooks = { ...((base.hooks as Record<string, unknown> | undefined) ?? {}) };
	for (const [event, groups] of Object.entries(governHookGroups(hookCommand))) {
		const existing = Array.isArray(hooks[event]) ? [...(hooks[event] as { matcher?: string; hooks?: { command?: string }[] }[])] : [];
		// Replace an older RIAF governance entry (any path to riaf-govern.mjs) rather than duplicating it.
		const kept = existing.filter(g => !(g.hooks ?? []).some(x => typeof x.command === 'string' && x.command.includes(GOVERN_HOOK_FILENAME)));
		hooks[event] = [...kept, ...groups];
	}
	return { ...base, hooks };
}
