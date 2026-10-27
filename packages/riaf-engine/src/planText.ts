import type { AcceptanceCheck, NewSubtask, RunLedger, SubtaskBudget } from './types.js';

const DEFAULT_BUDGET: SubtaskBudget = { maxIterations: 8, maxTokens: 40_000 };

export function isContinuationUserMessage(text: string): boolean {
	return /^(continue|go on|keep going|resume|carry on|proceed|do it|yes|ok)\b/i.test(text.trim());
}

export function isLikelyNewTaskUserMessage(text: string): boolean {
	return /^(now |instead |new task\b|forget |stop and |switch to )/i.test(text.trim());
}

/** Reuse a live run, reopen blocked work, or start a new plan. */
export function decideRunAction(run: RunLedger | null, userText: string): 'reuse' | 'reactivate' | 'generate' {
	if (!run || run.status === 'done' || run.status === 'cancelled') { return 'generate'; }
	const text = userText.trim();
	if (isLikelyNewTaskUserMessage(text)) { return 'generate'; }
	const open = run.subtasks.some(s => s.status === 'pending' || s.status === 'running');
	const stuck = run.subtasks.some(s => s.status === 'blocked' || s.status === 'skipped');
	if (isContinuationUserMessage(text) && open) { return 'reuse'; }
	if (isContinuationUserMessage(text) && stuck) { return 'reactivate'; }
	if (open && text.length > 0 && text.length < 32 && !isLikelyNewTaskUserMessage(text)) { return 'reuse'; }
	return 'generate';
}

export function reactivateRun(run: RunLedger): void {
	for (const s of run.subtasks) {
		if (s.status === 'blocked' || s.status === 'skipped') { s.status = 'pending'; s.notes = s.notes ? `${s.notes}\nreopened` : 'reopened'; }
	}
	if (run.status !== 'cancelled') { run.status = deriveLoose(run); }
}

function deriveLoose(run: RunLedger): RunLedger['status'] {
	if (run.subtasks.some(s => s.status === 'running')) { return 'running'; }
	if (run.subtasks.some(s => s.status === 'pending')) { return 'planned'; }
	return run.status;
}

export function skipOpenSubtasks(run: RunLedger): void {
	for (const s of run.subtasks) {
		if (s.status === 'pending' || s.status === 'blocked' || s.status === 'running') { s.status = 'skipped'; }
	}
}

function extractJson(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = fenced ? fenced[1] : text;
	const start = body.indexOf('{');
	const end = body.lastIndexOf('}');
	if (start < 0 || end <= start) { throw new Error('planner did not return a JSON object'); }
	try { return JSON.parse(body.slice(start, end + 1)); }
	catch (e) { throw new Error(`planner JSON is invalid: ${(e as Error).message}`); }
}

function asAcceptance(raw: unknown): AcceptanceCheck[] {
	if (!Array.isArray(raw)) { return []; }
	const out: AcceptanceCheck[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') { continue; }
		const k = item as { kind?: string; command?: string; pattern?: string; path?: string };
		if (k.kind === 'command' && typeof k.command === 'string') { out.push({ kind: 'command', command: k.command }); }
		else if (k.kind === 'grep' && typeof k.pattern === 'string') { out.push({ kind: 'grep', pattern: k.pattern, ...(k.path ? { path: k.path } : {}) }); }
		else if (k.kind === 'diagnostics' && typeof k.path === 'string') { out.push({ kind: 'diagnostics', path: k.path }); }
	}
	return out;
}

function hasCycle(nodes: { id: string; dependsOn: string[] }[]): boolean {
	const byId = new Map(nodes.map(n => [n.id, n]));
	const color = new Map<string, number>();
	const visit = (id: string): boolean => {
		const c = color.get(id) ?? 0;
		if (c === 1) { return true; }
		if (c === 2) { return false; }
		color.set(id, 1);
		for (const d of byId.get(id)?.dependsOn ?? []) { if (byId.has(d) && visit(d)) { return true; } }
		color.set(id, 2);
		return false;
	};
	return nodes.some(n => visit(n.id));
}

/** Turn a model reply into a DAG. Throws when the document is unusable. */
export function parsePlanDocument(text: string): NewSubtask[] {
	const raw = extractJson(text) as { subtasks?: unknown };
	if (!Array.isArray(raw.subtasks) || raw.subtasks.length === 0) { throw new Error('planner JSON has no subtasks'); }
	const subtasks: NewSubtask[] = [];
	const seen = new Set<string>();
	for (const item of raw.subtasks) {
		if (!item || typeof item !== 'object') { throw new Error('subtask is not an object'); }
		const s = item as { id?: unknown; goal?: unknown; files?: unknown; dependsOn?: unknown; acceptance?: unknown; budget?: { maxIterations?: unknown; maxTokens?: unknown } };
		const id = typeof s.id === 'string' && s.id.trim() ? s.id.trim() : `s${subtasks.length + 1}`;
		if (seen.has(id)) { throw new Error(`duplicate subtask id ${id}`); }
		seen.add(id);
		const goal = typeof s.goal === 'string' ? s.goal.trim() : '';
		if (!goal) { throw new Error(`subtask ${id} has no goal`); }
		const dependsOn = Array.isArray(s.dependsOn) ? s.dependsOn.filter((d): d is string => typeof d === 'string') : [];
		subtasks.push({
			id, goal, dependsOn,
			files: Array.isArray(s.files) ? s.files.filter((f): f is string => typeof f === 'string') : [],
			acceptance: asAcceptance(s.acceptance),
			budget: {
				maxIterations: Number(s.budget?.maxIterations) || DEFAULT_BUDGET.maxIterations,
				maxTokens: Number(s.budget?.maxTokens) || DEFAULT_BUDGET.maxTokens,
			},
		});
	}
	for (const s of subtasks) {
		for (const d of s.dependsOn) { if (!seen.has(d)) { throw new Error(`subtask ${s.id} depends on unknown ${d}`); } }
	}
	if (hasCycle(subtasks)) { throw new Error('plan has a dependency cycle'); }
	return subtasks;
}

export const PLAN_SYSTEM = `You decompose a coding task into a small DAG. Reply with JSON only, no prose:
{"subtasks":[{"id":"s1","goal":"one concrete change","files":["relative/path"],"dependsOn":[],"acceptance":[{"kind":"grep","pattern":"expected text","path":"relative/path"}],"budget":{"maxIterations":8,"maxTokens":40000}}]}
Rules: 2-8 subtasks; ids unique; dependsOn only earlier ids; files are workspace-relative paths you were given or are confident exist; acceptance is grep, command, or diagnostics; do not mark anything done.`;
