import { join } from 'node:path';

type HookCommand = { type: string; command: string };
type HookGroup = { matcher?: string; hooks?: HookCommand[] };

function hasCommand(groups: unknown, command: string): boolean {
	if (!Array.isArray(groups)) { return false; }
	return groups.some(group => Array.isArray((group as HookGroup).hooks) && (group as HookGroup).hooks!.some(hook => hook.command === command));
}

/** Add the RIAF Stop and PreToolUse hooks without dropping hooks the repo already has. */
export function mergeClaudeHooks(settings: unknown, repo: string): Record<string, unknown> {
	const base = settings && typeof settings === 'object' ? { ...(settings as Record<string, unknown>) } : {};
	const hooks = { ...((base.hooks as Record<string, unknown> | undefined) ?? {}) };
	const gate = join(repo, '.claude', 'hooks', 'gate.mjs');
	const stop = `node "${gate}" stop "${repo}"`;
	const pretool = `node "${gate}" pretool`;
	const stopGroups = Array.isArray(hooks.Stop) ? [...hooks.Stop as HookGroup[]] : [];
	if (!hasCommand(stopGroups, stop)) { stopGroups.push({ hooks: [{ type: 'command', command: stop }] }); }
	const preGroups = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse as HookGroup[]] : [];
	if (!hasCommand(preGroups, pretool)) { preGroups.push({ matcher: 'Bash', hooks: [{ type: 'command', command: pretool }] }); }
	return { ...base, hooks: { ...hooks, Stop: stopGroups, PreToolUse: preGroups } };
}
