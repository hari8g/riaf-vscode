import type { LlmCall } from './planner.js';
import { parsePlanDocument } from './planText.js';
import type { NewSubtask, RunLedger } from './types.js';

const CRITIC_SYSTEM = `You review a finished coding run against its goal. Reply with JSON only.
{"pass":true} when the work meets the goal.
{"pass":false,"fix":{"id":"critic-fix","goal":"the one remaining change","files":["path"],"dependsOn":[],"acceptance":[{"kind":"grep","pattern":"text","path":"path"}]}} when one concrete fix is still required. Do not invent a second fix.`;

export function parseCriticResponse(text: string): { pass: boolean; fix?: NewSubtask } {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) { return { pass: true }; }
	let raw: { pass?: boolean; fix?: unknown };
	try { raw = JSON.parse(text.slice(start, end + 1)); }
	catch { return { pass: true }; }
	if (raw.pass !== false) { return { pass: true }; }
	if (!raw.fix) { return { pass: false }; }
	try {
		const [fix] = parsePlanDocument(JSON.stringify({ subtasks: [raw.fix] }));
		return { pass: false, fix };
	} catch { return { pass: false }; }
}

export function criticAlreadyAddedFix(run: RunLedger): boolean {
	return run.events.some(e => e.type === 'critic' && e.message.startsWith('fix:'));
}

/** One review. A failing review may add a single fix subtask; a second call will not add another. */
export async function reviewRun(opts: { run: RunLedger; callLLM: LlmCall; diffSummary: string }): Promise<{ pass: boolean; fix?: NewSubtask }> {
	const outline = opts.run.subtasks.map(s => `- [${s.status}] ${s.id}: ${s.goal}`).join('\n');
	const res = await opts.callLLM(CRITIC_SYSTEM, `Goal: ${opts.run.goal}\n\nSubtasks:\n${outline}\n\nDiff summary:\n${opts.diffSummary || '(none)'}`);
	return parseCriticResponse(res.text);
}

export async function replanOpenSubtasks(opts: { run: RunLedger; callLLM: LlmCall; reason: string; context?: string }): Promise<NewSubtask[]> {
	const open = opts.run.subtasks.filter(s => s.status === 'pending' || s.status === 'blocked');
	const done = opts.run.subtasks.filter(s => s.status === 'done').map(s => s.id);
	const res = await opts.callLLM(
		'Replace the unfinished subtasks. Reply with the same JSON shape as a plan. Do not repeat subtasks that are already done. dependsOn may name done ids.',
		`Goal: ${opts.run.goal}\nReason: ${opts.reason}\nDone: ${done.join(', ') || '(none)'}\nUnfinished:\n${open.map(s => `${s.id}: ${s.goal} (${s.status})`).join('\n')}\n${opts.context ?? ''}`,
	);
	return parsePlanDocument(res.text);
}
