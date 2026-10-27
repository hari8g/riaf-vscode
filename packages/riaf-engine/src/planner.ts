import { parsePlanDocument, PLAN_SYSTEM } from './planText.js';
import type { NewSubtask } from './types.js';

export type LlmText = { text: string; inputTokens?: number; outputTokens?: number };
export type LlmCall = (system: string, user: string) => Promise<LlmText>;

/** Ask the model for a DAG, retry once on a bad document, then attach files from search when the model named none. */
export async function planTask(opts: {
	goal: string;
	callLLM: LlmCall;
	context?: string;
	search?: (query: string) => Promise<string[]>;
}): Promise<{ subtasks: NewSubtask[]; usage: { inputTokens: number; outputTokens: number } }> {
	const user = [`Task: ${opts.goal}`, opts.context ? `Repository context:\n${opts.context}` : ''].filter(Boolean).join('\n\n');
	let usage = { inputTokens: 0, outputTokens: 0 };
	let last = '';
	let subtasks: NewSubtask[] | undefined;
	for (let attempt = 0; attempt < 2 && !subtasks; attempt++) {
		const prompt = attempt === 0 ? user : `${user}\n\nThe previous reply could not be used (${last}). Return only the JSON object.`;
		const res = await opts.callLLM(PLAN_SYSTEM, prompt);
		usage.inputTokens += res.inputTokens ?? 0;
		usage.outputTokens += res.outputTokens ?? 0;
		try { subtasks = parsePlanDocument(res.text); }
		catch (e) { last = (e as Error).message; }
	}
	if (!subtasks) { throw new Error(last || 'planner failed'); }
	if (opts.search) {
		for (const s of subtasks) {
			if (s.files.length) { continue; }
			const hits = await opts.search(s.goal).catch(() => []);
			s.files = [...new Set(hits)].slice(0, 3);
		}
	}
	return { subtasks, usage };
}
