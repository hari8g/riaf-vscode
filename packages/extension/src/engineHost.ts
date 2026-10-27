import { FileLedger, renderLedger, runTask, type LlmCall } from '@bosch-mps/riaf-engine';
import type { VerifyEnv } from '@bosch-mps/riaf-engine';
import type { SubtaskResult } from '@bosch-mps/riaf-engine';

export type EngineCommand = 'run' | 'status' | 'resume';

/** Shared by @riaf /run /status /resume and the CLI. The host supplies the model and the subtask runner. */
export async function handleEngineCommand(opts: {
	command: EngineCommand;
	repo: string;
	goal: string;
	callLLM: LlmCall;
	runSubtask: (subtask: { id: string; goal: string; files: string[]; notes: string }, context: string) => Promise<SubtaskResult>;
	env: VerifyEnv;
	markdown: (s: string) => void;
	progress?: (s: string) => void;
}): Promise<{ status: string; id?: string }> {
	const ledger = new FileLedger(opts.repo);
	if (opts.command === 'status') {
		const rows = ledger.list();
		if (!rows.length) { opts.markdown('No RIAF runs yet. Use `/run` with a task.'); return { status: 'empty' }; }
		const run = ledger.load(rows[0].id);
		opts.markdown(renderLedger(run));
		return { status: run.status, id: run.id };
	}
	const existing = opts.command === 'resume' ? (() => { const rows = ledger.list(); return rows[0] ? ledger.load(rows[0].id) : null; })() : null;
	if (opts.command === 'resume' && !existing) { opts.markdown('Nothing to resume.'); return { status: 'empty' }; }
	opts.progress?.('Planning…');
	const run = await runTask({
		ledger,
		goal: existing?.goal ?? opts.goal,
		userText: opts.command === 'resume' ? 'continue' : opts.goal,
		existing,
		callLLM: opts.callLLM,
		runSubtask: (subtask, context) => opts.runSubtask(subtask, context),
		env: opts.env,
		replan: true,
	});
	opts.markdown(renderLedger(run));
	return { status: run.status, id: run.id };
}
