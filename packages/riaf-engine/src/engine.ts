import { reviewRun, replanOpenSubtasks } from './critic.js';
import { executeRun, type SubtaskResult } from './executor.js';
import { deriveRunStatus, FileLedger } from './ledger.js';
import { decideRunAction, reactivateRun, skipOpenSubtasks } from './planText.js';
import { planTask, type LlmCall } from './planner.js';
import type { VerifyEnv } from './verifier.js';
import type { RunLedger } from './types.js';

export function renderLedger(run: RunLedger): string {
	const mark = (status: string) => status === 'done' ? 'x' : status === 'blocked' ? '!' : status === 'skipped' ? '-' : status === 'running' ? '>' : ' ';
	const lines = [
		`**${run.id}** — ${run.status} — ${run.goal}`,
		...run.subtasks.map(s => `- [${mark(s.status)}] ${s.id}: ${s.goal}${s.status === 'blocked' && s.notes ? ` — ${s.notes.split('\n')[0]}` : ''}`),
		``,
		`${run.spend.inputTokens} in / ${run.spend.outputTokens} out · $${run.spend.costUSD.toFixed(4)}`,
	];
	return lines.join('\n');
}

export async function runTask(opts: {
	ledger: FileLedger;
	goal: string;
	userText?: string;
	existing?: RunLedger | null;
	callLLM: LlmCall;
	runSubtask: (subtask: RunLedger['subtasks'][number], context: string) => Promise<SubtaskResult>;
	env: VerifyEnv;
	context?: string;
	search?: (query: string) => Promise<string[]>;
	diffSummary?: string;
	parallel?: boolean;
	replan?: boolean;
	maxFixes?: number;
}): Promise<RunLedger> {
	const text = opts.userText ?? opts.goal;
	const action = decideRunAction(opts.existing ?? null, text);
	let run: RunLedger;
	if (action === 'reuse' && opts.existing) {
		run = opts.existing;
	} else if (action === 'reactivate' && opts.existing) {
		reactivateRun(opts.existing);
		run = opts.existing;
		opts.ledger.appendEvent(run, 'replanned', 'reactivated blocked subtasks');
	} else {
		if (opts.existing && opts.existing.status !== 'done' && opts.existing.status !== 'cancelled') {
			skipOpenSubtasks(opts.existing);
			opts.existing.status = deriveRunStatus(opts.existing);
			opts.ledger.save(opts.existing);
		}
		const planned = await planTask({ goal: opts.goal, callLLM: opts.callLLM, context: opts.context, search: opts.search });
		run = opts.ledger.create({ goal: opts.goal, subtasks: planned.subtasks });
		opts.ledger.recordSpend(run, { inputTokens: planned.usage.inputTokens, outputTokens: planned.usage.outputTokens });
	}
	await executeRun({ ledger: opts.ledger, run, runSubtask: opts.runSubtask, env: opts.env, parallel: opts.parallel, maxFixes: opts.maxFixes });
	if (opts.replan && run.subtasks.some(s => s.status === 'blocked')) {
		const reason = run.subtasks.filter(s => s.status === 'blocked').map(s => `${s.id}: ${s.notes}`).join('\n');
		const next = await replanOpenSubtasks({ run, callLLM: opts.callLLM, reason, context: opts.context });
		skipOpenSubtasks(run);
		for (const s of next) { run.subtasks.push({ ...s, status: 'pending', attempts: 0, toolDigest: [], notes: s.notes ?? '' }); }
		run.status = deriveRunStatus(run);
		opts.ledger.save(run);
		await executeRun({ ledger: opts.ledger, run, runSubtask: opts.runSubtask, env: opts.env, parallel: opts.parallel, maxFixes: opts.maxFixes });
	}
	const verdict = await reviewRun({ run, callLLM: opts.callLLM, diffSummary: opts.diffSummary ?? '' });
	const already = run.events.some(e => e.type === 'critic' && e.message.startsWith('fix:'));
	if (!verdict.pass && verdict.fix && !already) {
		const id = run.subtasks.some(s => s.id === verdict.fix!.id) ? `${verdict.fix.id}-2` : verdict.fix.id;
		opts.ledger.appendEvent(run, 'critic', `fix:${id}`);
		run.subtasks.push({
			...verdict.fix, id, status: 'pending', attempts: 0, toolDigest: [], notes: '',
			dependsOn: run.subtasks.filter(s => s.status === 'done').map(s => s.id),
		});
		opts.ledger.save(run);
		await executeRun({ ledger: opts.ledger, run, runSubtask: opts.runSubtask, env: opts.env, maxFixes: opts.maxFixes });
	} else {
		opts.ledger.appendEvent(run, 'critic', verdict.pass ? 'pass' : 'no-fix');
	}
	return run;
}
