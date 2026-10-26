/**
 * Agent hooks — project-defined shell commands that run around tool calls.
 *
 *   .riaf/hooks.json
 *   {
 *     "preTool":  [{ "matcher": "edit_file|rewrite_file|run_command", "command": "node scripts/guard.mjs" }],
 *     "postEdit": [{ "matcher": "\\.(ts|tsx)$", "command": "npx prettier --write \"$RIAF_FILE\"" }]
 *   }
 *
 * preTool hooks receive the event as JSON on stdin ({ tool, args, workspace }) and can block the
 * call: exit code 2, or stdout JSON { "decision": "block", "reason": "…" }. Anything else allows.
 * postEdit hooks run after a file was written; their failure is reported, never fatal.
 *
 * No `vscode` import.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellArgv } from './shell.js';

export type HookEntry = { matcher?: string; command: string; timeoutMs?: number };
export type HookConfig = { preTool: HookEntry[]; postEdit: HookEntry[] };

export type PreToolEvent = { tool: string; args: Record<string, unknown>; workspace: string };
export type HookDecision = { allow: true; notes: string[] } | { allow: false; reason: string; notes: string[] };

const HOOK_TIMEOUT_MS = 10_000;
export const HOOK_BLOCK_EXIT_CODE = 2;

const asEntries = (v: unknown): HookEntry[] => Array.isArray(v) ? v.filter((e): e is HookEntry => !!e && typeof e === 'object' && typeof (e as HookEntry).command === 'string') : [];

/** Merge workspace `.riaf/hooks.json` with settings-provided hooks (settings first). */
export function loadHooks(workspaceRoot: string, fromSettings: Partial<HookConfig> = {}): HookConfig {
	const cfg: HookConfig = { preTool: [...asEntries(fromSettings.preTool)], postEdit: [...asEntries(fromSettings.postEdit)] };
	const file = join(workspaceRoot, '.riaf', 'hooks.json');
	if (existsSync(file)) {
		try {
			const json = JSON.parse(readFileSync(file, 'utf8')) as Partial<HookConfig>;
			cfg.preTool.push(...asEntries(json.preTool));
			cfg.postEdit.push(...asEntries(json.postEdit));
		} catch { /* malformed: ignore, the doctor command reports it */ }
	}
	return cfg;
}

const matches = (entry: HookEntry, subject: string): boolean => {
	if (!entry.matcher) { return true; }
	try { return new RegExp(entry.matcher).test(subject); } catch { return entry.matcher === subject; }
};

type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean; launchError?: string };

function runHook(entry: HookEntry, cwd: string, env: Record<string, string>, stdin?: string): Promise<RunResult> {
	return new Promise(resolve => {
		const { file, args } = shellArgv(entry.command);
		const child = execFile(file, args, { cwd, env: { ...process.env, ...env }, timeout: entry.timeoutMs ?? HOOK_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
			const e = err as (Error & { code?: number | string; killed?: boolean; signal?: string }) | null;
			// A string code (ENOENT, EACCES) means the shell itself could not be started — not a hook verdict.
			const launchError = e && typeof e.code === 'string' ? `${e.code}: cannot start ${file}` : undefined;
			resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), timedOut: !!e?.killed || e?.signal === 'SIGTERM', launchError });
		});
		child.on('error', () => { /* surfaced through the callback's err */ });
		// A hook may exit without reading stdin (e.g. `echo …`); the resulting EPIPE must not escape as an uncaught exception.
		child.stdin?.on('error', () => { });
		if (stdin !== undefined) { child.stdin?.end(stdin); }
	});
}

/** Run every matching preTool hook; the first block wins. */
export async function runPreToolHooks(cfg: HookConfig, event: PreToolEvent): Promise<HookDecision> {
	const notes: string[] = [];
	for (const entry of cfg.preTool) {
		if (!matches(entry, event.tool)) { continue; }
		const r = await runHook(entry, event.workspace, { RIAF_TOOL: event.tool, RIAF_WORKSPACE: event.workspace }, JSON.stringify(event));
		if (r.timedOut) { notes.push(`hook "${entry.command}" timed out; allowed`); continue; }
		// Fail closed: a guard that cannot run must not silently allow.
		if (r.launchError) { return { allow: false, reason: `pre-tool hook "${entry.command}" could not run (${r.launchError}); set RIAF_SHELL or install Git Bash`, notes }; }
		let decision: { decision?: string; reason?: string } | null = null;
		const line = r.stdout.trim().split('\n').reverse().find(l => l.trim().startsWith('{'));
		if (line) { try { decision = JSON.parse(line); } catch { /* not JSON */ } }
		if (r.code === HOOK_BLOCK_EXIT_CODE || decision?.decision === 'block') {
			return { allow: false, reason: decision?.reason || r.stderr.trim() || r.stdout.trim() || `blocked by hook "${entry.command}"`, notes };
		}
		if (r.code !== 0) { notes.push(`hook "${entry.command}" exited ${r.code}; allowed`); }
		else if (decision?.reason) { notes.push(decision.reason); }
	}
	return { allow: true, notes };
}

/** Run matching postEdit hooks for a written file (e.g. a formatter). Returns one line per hook that ran. */
export async function runPostEditHooks(cfg: HookConfig, workspaceRoot: string, relPath: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of cfg.postEdit) {
		if (!matches(entry, relPath)) { continue; }
		const r = await runHook(entry, workspaceRoot, { RIAF_FILE: relPath, RIAF_WORKSPACE: workspaceRoot });
		out.push(r.code === 0 ? `post-edit hook ok: ${entry.command}` : `post-edit hook failed (${r.launchError ?? (r.timedOut ? 'timeout' : `exit ${r.code}`)}): ${entry.command}${r.stderr.trim() ? ` — ${r.stderr.trim().slice(0, 200)}` : ''}`);
	}
	return out;
}
