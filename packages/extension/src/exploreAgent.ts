/**
 * Read-only explore subagent: a side loop with search/read tools only. It burns its own context
 * on grep hits and file bodies and hands the parent a short report, so the main thread keeps
 * the budget for editing. Edits and shell commands are never available to it.
 */
import type { ModelTransport, ToolCall, TransportMessage, TransportResult, ToolSpec } from './modelTransport.js';
import type { ToolContext, ToolOutcome } from './tools/toolRegistry.js';

export const EXPLORE_TOOL_NAME = 'explore';
export const EXPLORE_MAX_STEPS = 8;
export const EXPLORE_REPORT_MAX_CHARS = 6_000;

/** Tools the subagent may use — a strict subset of the parent's read-only set. */
export const EXPLORE_TOOLS: ReadonlySet<string> = new Set([
	'search_codebase', 'grep', 'glob', 'read_file', 'get_file_outline', 'search_symbols', 'find_references', 'get_neighbors',
	'ls_dir', 'search_in_file', 'get_import_graph', 'get_tests_for_file',
]);

export const EXPLORE_SPEC: ToolSpec = {
	name: EXPLORE_TOOL_NAME,
	description: 'Delegate a read-only investigation to a subagent that searches and reads on its own context, then returns a concise report (paths, line ranges, findings). Use for open-ended questions ("how does X flow through the code?", "where is Y configured?") so the large search output never enters this conversation. It cannot edit or run commands.',
	inputSchema: { type: 'object', properties: { task: { type: 'string', description: 'What to find out, with any names/paths already known' }, maxSteps: { type: 'number', description: `Tool calls allowed, default ${EXPLORE_MAX_STEPS}` } }, required: ['task'] },
};

const EXPLORE_SYSTEM = `You are RIAF's explore subagent: a read-only investigator inside a code repository.
Goal: answer the task below using the tools, then write a report for the main agent.
- Start with grep (exact identifiers) or search_codebase (concepts) plus glob; read files only where needed, in line ranges.
- You cannot edit files or run commands. Do not propose edits as tool calls.
- Finish with a report under 400 words: bullet points, each with file path and line range; list the key definitions, how they connect, and what remains uncertain. No preamble.`;

export type ExploreDeps = {
	transport: ModelTransport;
	ctx: ToolContext;
	allSpecs: ToolSpec[];
	executeTool: (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>;
	onUsage?: (usage: NonNullable<TransportResult['usage']>) => void;
	log?: (msg: string) => void;
};

export type ExploreResult = { report: string; steps: number; toolCalls: number; refused: number };

export async function runExplore(task: string, deps: ExploreDeps, maxSteps = EXPLORE_MAX_STEPS): Promise<ExploreResult> {
	const tools = deps.allSpecs.filter(t => EXPLORE_TOOLS.has(t.name));
	const subCtx: ToolContext = { ...deps.ctx, readOnly: true, progress: undefined };
	const messages: TransportMessage[] = [{ role: 'user', text: `Task: ${task}` }];
	let steps = 0, toolCalls = 0, refused = 0;
	let lastText = '';
	const cap = Math.max(1, Math.min(20, maxSteps));

	const abort = new AbortController();
	const cancelSub = subCtx.token?.onCancellationRequested(() => abort.abort());
	try {
	while (steps < cap) {
		steps++;
		if (abort.signal.aborted || subCtx.token?.isCancellationRequested) { break; }
		const res = await deps.transport.call({ systemMessage: EXPLORE_SYSTEM, messages, tools, signal: abort.signal });
		if (res.usage) { deps.onUsage?.(res.usage); }
		if (res.text) { lastText = res.text; }
		if (!res.toolCalls.length) { break; }
		messages.push({ role: 'assistant', text: res.text, toolCalls: res.toolCalls });
		for (const call of res.toolCalls as ToolCall[]) {
			toolCalls++;
			let text: string;
			if (!EXPLORE_TOOLS.has(call.name)) {
				refused++;
				text = `ERROR: ${call.name} is not available to the explore subagent (read-only: ${[...EXPLORE_TOOLS].join(', ')}). Finish with your report instead.`;
			} else {
				const out = await deps.executeTool(call.name, call.args ?? {}, subCtx);
				text = out.ok ? out.result : `ERROR: ${out.error}`;
			}
			messages.push({ role: 'tool', toolCallId: call.id, name: call.name, text });
		}
		if (steps === cap) {
			// one last call without tools so the subagent writes its report
			messages.push({ role: 'user', text: 'Step budget reached. Write the report now from what you have.' });
			if (abort.signal.aborted) { break; }
			const fin = await deps.transport.call({ systemMessage: EXPLORE_SYSTEM, messages, tools: [], signal: abort.signal });
			if (fin.usage) { deps.onUsage?.(fin.usage); }
			if (fin.text) { lastText = fin.text; }
		}
	}
	} finally { cancelSub?.dispose(); }
	const cancelled = abort.signal.aborted || !!subCtx.token?.isCancellationRequested;
	const report = (lastText.trim() || (cancelled ? 'Explore cancelled.' : 'The explore subagent produced no report.')).slice(0, EXPLORE_REPORT_MAX_CHARS);
	deps.log?.(`explore: ${steps} steps, ${toolCalls} tool calls, ${refused} refused`);
	return { report, steps, toolCalls, refused };
}
