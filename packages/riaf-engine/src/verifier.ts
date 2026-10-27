import { parseTestOutput } from './testParsers.js';
import type { AcceptanceCheck, Subtask } from './types.js';

export type VerifyEnv = {
	readFile: (path: string) => Promise<string | null>;
	runCommand?: (command: string) => Promise<{ code: number; output: string }>;
	diagnostics?: (path: string) => Promise<{ message: string; severity: string }[]>;
};

export async function verifySubtask(subtask: Subtask, env: VerifyEnv): Promise<{ ok: boolean; failures: string[] }> {
	const failures: string[] = [];
	for (const check of subtask.acceptance) {
		const message = await checkOne(check, subtask, env);
		if (message) { failures.push(message); }
	}
	return { ok: failures.length === 0, failures };
}

async function checkOne(check: AcceptanceCheck, subtask: Subtask, env: VerifyEnv): Promise<string | null> {
	if (check.kind === 'grep') {
		const paths = check.path ? [check.path] : subtask.files;
		if (!paths.length) { return `grep ${check.pattern}: no file to search`; }
		let re: RegExp | null = null;
		try { re = new RegExp(check.pattern); } catch { re = null; }
		for (const path of paths) {
			const text = await env.readFile(path);
			if (text == null) { continue; }
			if (re ? re.test(text) : text.includes(check.pattern)) { return null; }
		}
		return `grep ${check.pattern} did not match ${paths.join(', ')}`;
	}
	if (check.kind === 'diagnostics') {
		const diags = await env.diagnostics?.(check.path) ?? [];
		const errors = diags.filter(d => /error/i.test(d.severity));
		return errors.length ? `diagnostics ${check.path}: ${errors.map(e => e.message).join('; ')}` : null;
	}
	if (!env.runCommand) { return `command check has no runner: ${check.command}`; }
	if (!check.command.trim()) { return 'command check is empty'; }
	const ran = await env.runCommand(check.command);
	const parsed = parseTestOutput(ran.output);
	if (ran.code !== 0 || parsed.failed.length) {
		const names = parsed.failed.slice(0, 5).map(f => f.name).join(', ');
		return `command failed (exit ${ran.code})${names ? `: ${names}` : ''}\n${parsed.tail}`;
	}
	return null;
}
