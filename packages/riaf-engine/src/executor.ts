import { FileLedger } from './ledger.js';
import { verifySubtask, type VerifyEnv } from './verifier.js';
import type { RunLedger, RunSpend, Subtask } from './types.js';

export type SubtaskResult = { ok: boolean; digest: string[]; notes: string; spend?: Partial<RunSpend> };

export async function assembleContext(subtask: Subtask, readFile: VerifyEnv['readFile']): Promise<string> {
	const parts = [`Goal: ${subtask.goal}`];
	for (const file of subtask.files.slice(0, 8)) {
		const text = await readFile(file);
		parts.push(text == null ? `\n# ${file}\n(file not found)` : `\n# ${file}\n${text.slice(0, 8_000)}`);
	}
	if (subtask.notes) { parts.push(`\nNotes from the previous attempt:\n${subtask.notes}`); }
	const checks = subtask.acceptance.map(c => c.kind === 'grep' ? `grep /${c.pattern}/ ${c.path ?? ''}` : c.kind === 'command' ? `command: ${c.command}` : `diagnostics ${c.path}`);
	if (checks.length) { parts.push(`\nAcceptance:\n- ${checks.join('\n- ')}`); }
	return parts.join('\n');
}

const disjoint = (tasks: Subtask[]): boolean => {
	const seen = new Set<string>();
	for (const t of tasks) {
		for (const f of t.files) {
			if (!f) { continue; }
			if (seen.has(f)) { return false; }
			seen.add(f);
		}
	}
	return true;
};

/**
 * Run every ready subtask, verify it, and allow at most `maxFixes` extra attempts.
 * Independent subtasks (no shared files) run together when `parallel` is set.
 */
export async function executeRun(opts: {
	ledger: FileLedger;
	run: RunLedger;
	runSubtask: (subtask: Subtask, context: string) => Promise<SubtaskResult>;
	env: VerifyEnv;
	maxFixes?: number;
	parallel?: boolean;
}): Promise<RunLedger> {
	const maxFixes = opts.maxFixes ?? 2;
	let guard = 0;
	while (guard++ < 200) {
		const ready = opts.run.subtasks.filter(s => s.status === 'pending' && s.dependsOn.every(d => {
			const dep = opts.run.subtasks.find(x => x.id === d);
			return !!dep && (dep.status === 'done' || dep.status === 'skipped');
		}));
		const missing = opts.run.subtasks.filter(s => s.status === 'pending' && s.dependsOn.some(d => !opts.run.subtasks.some(x => x.id === d)));
		for (const s of missing) { opts.ledger.setSubtaskStatus(opts.run, s.id, 'blocked', `missing dependency`); }
		if (!ready.length) { break; }
		const batch = opts.parallel && disjoint(ready) ? ready : [ready[0]];
		await Promise.all(batch.map(subtask => runOne(opts, subtask, maxFixes)));
	}
	return opts.run;
}

async function runOne(opts: { ledger: FileLedger; run: RunLedger; runSubtask: (subtask: Subtask, context: string) => Promise<SubtaskResult>; env: VerifyEnv }, subtask: Subtask, maxFixes: number): Promise<void> {
	let fixes = 0;
	for (;;) {
		opts.ledger.setSubtaskStatus(opts.run, subtask.id, 'running', subtask.goal);
		const context = await assembleContext(subtask, opts.env.readFile);
		const result = await opts.runSubtask(subtask, context);
		for (const line of result.digest) { opts.ledger.appendToolDigest(opts.run, subtask.id, line); }
		if (result.spend) { opts.ledger.recordSpend(opts.run, result.spend); }
		const verified = await verifySubtask(subtask, opts.env);
		if (result.ok && verified.ok) {
			opts.ledger.setSubtaskStatus(opts.run, subtask.id, 'done', result.notes || 'verified');
			return;
		}
		const why = [result.ok ? '' : result.notes, ...verified.failures].filter(Boolean).join('\n');
		if (fixes >= maxFixes) {
			subtask.notes = why;
			opts.ledger.setSubtaskStatus(opts.run, subtask.id, 'blocked', why.slice(0, 500));
			return;
		}
		fixes++;
		subtask.notes = why;
		subtask.status = 'pending';
	}
}
