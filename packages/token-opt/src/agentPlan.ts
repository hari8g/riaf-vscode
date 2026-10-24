/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from './shim/vsBase.js';
import type {
	ChatMessage,
	ChatMode,
	ModelSelection,
	ModelSelectionOptions,
	OverridesOfModel,
	PlanMessage,
	ToolCallParams,
	ToolName,
} from './types.js';
import { getModelCapabilities } from './modelCapabilities.js';
import type { FileReadRecord } from './fileReadDedup.js';
import type { LLMCallPort, UsageMeterPort } from './ports.js';

export const PLAN_OUTPUT_TOKEN_CAP = 300;
export const PLAN_MIN_BULLETS = 3;
export const PLAN_MAX_BULLETS = 8;
export const PLAN_GENERATION_TIMEOUT_MS = 45_000;

const PLAN_SYSTEM_MESSAGE = [
	'You help a coding agent plan its work before using tools.',
	`In ${PLAN_MIN_BULLETS}-${PLAN_MAX_BULLETS} bullet points, list the concrete steps you will take to complete the user task.`,
	'Use infinitive verb form (e.g. "Read Sidebar.tsx", "Create Spinner.tsx", "Run tests").',
	'For NEW files: plan create_file_or_folder (or write) directly — do NOT plan a read_file step for paths that do not exist yet.',
	'For EXISTING files: plan ONE read (or outline lookup) before editing — never multiple reads of the same file.',
	'For styling/theming or multi-section updates to one file, plan ONE read and ONE combined edit — never multiple separate edits to the same file.',
	'Prefer fewer, larger steps over many tiny tool calls.',
	'If session context lists completed or skipped steps, do NOT repeat them — plan only remaining work.',
	'Output only the bullet list — no intro, no prose, no markdown headings.',
	'One step per line, prefixed with "- ".',
].join('\n');

const CONTINUATION_USER_MESSAGE = /^(?:continue|go on|keep going|carry on|proceed|resume|please continue|pick up where|finish(?:\s+the\s+task)?|complete(?:\s+the\s+task)?)\b[\s.!?,]*$/i;

export type AgentPlanRunResolution =
	| { action: 'reuse' }
	| { action: 'reactivate'; plan: PlanMessage; planMessageIdx: number }
	| { action: 'generate'; plan: PlanMessage; priorPlanMessageIdx?: number }
	| { action: 'none' };

const READ_VERBS = ['read', 'open', 'inspect', 'view', 'look', 'examine', 'review', 'load'];
const SEARCH_VERBS = ['locate', 'find', 'search', 'identify', 'discover', 'resolve'];
const EDIT_VERBS = ['add', 'edit', 'write', 'modify', 'update', 'insert', 'change', 'fix', 'comment', 'append', 'prepend', 'replace', 'create'];
const SAVE_VERBS = ['save', 'persist', 'commit', 'apply'];
const VERIFY_VERBS = ['verify', 'confirm', 'check', 'test', 'ensure', 'validate', 'run'];
const CREATE_VERBS = ['create', 'add', 'make', 'generate', 'scaffold'];
const RUN_VERBS = ['run', 'execute', 'start', 'launch', 'test', 'build', 'install'];

type ToolCategory = 'read' | 'search' | 'edit' | 'create' | 'run' | 'delete' | 'other';

export const parsePlanBulletItems = (text: string): { text: string; status: 'pending' }[] => {
	const items: { text: string; status: 'pending' }[] = [];
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (!line) continue;
		const match = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
		const text = (match?.[1] ?? line).trim();
		if (!text || /^done\.?$/i.test(text)) continue;
		items.push({ text, status: 'pending' });
		if (items.length >= PLAN_MAX_BULLETS) break;
	}
	return items;
};

const withPlanTokenCap = (
	overridesOfModel: OverridesOfModel | undefined,
	modelSelection: ModelSelection,
): OverridesOfModel => {
	const { providerName, modelName } = modelSelection;
	return {
		...(overridesOfModel ?? {}),
		[providerName]: {
			...(overridesOfModel?.[providerName] ?? {}),
			[modelName]: {
				...(overridesOfModel?.[providerName]?.[modelName] ?? {}),
				reservedOutputTokenSpace: PLAN_OUTPUT_TOKEN_CAP,
			},
		},
	} as OverridesOfModel;
};

export const summarizeUserTask = (chatMessages: ChatMessage[]): string => {
	for (let i = chatMessages.length - 1; i >= 0; i--) {
		const m = chatMessages[i];
		if (m.role === 'user') {
			const text = m.content?.trim() || m.displayContent?.trim();
			if (text) return text.slice(0, 2000);
		}
	}
	return '(No user message found)';
};

export const isContinuationUserMessage = (text: string): boolean => {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (CONTINUATION_USER_MESSAGE.test(trimmed)) return true;
	if (trimmed.length <= 24 && /\b(continue|resume|go on|keep going|proceed)\b/i.test(trimmed)) return true;
	return false;
};

/** True when the user is clearly starting a different task (not resuming). */
export const isLikelyNewTaskUserMessage = (text: string): boolean => {
	const trimmed = text.trim();
	if (!trimmed || isContinuationUserMessage(trimmed)) return false;
	if (trimmed.length >= 120) return true;
	if (/\b(instead|rather than|forget (?:that|the|about)|ignore (?:the )?previous|new task|different task|start over|from scratch)\b/i.test(trimmed)) {
		return true;
	}
	return false;
};

export const getLatestPlanMessage = (messages: ChatMessage[]): PlanMessage | null => {
	const idx = findLatestPlanMessageIdx(messages);
	if (idx === -1) return null;
	const message = messages[idx];
	return message.role === 'plan' ? message : null;
};

export const planHasPendingItems = (plan: PlanMessage): boolean =>
	plan.items.some(item => item.status === 'pending');

export const planHasSkippedItems = (plan: PlanMessage): boolean =>
	plan.items.some(item => item.status === 'skipped');

export const reactivateAbortedPlan = (plan: PlanMessage): PlanMessage | null => {
	if (planHasPendingItems(plan) || !planHasSkippedItems(plan)) {
		return null;
	}
	return {
		role: 'plan',
		items: plan.items.map(item => item.status === 'skipped' ? { ...item, status: 'pending' } : item),
	};
};

export const buildPlanSessionContext = (opts: {
	chatMessages: ChatMessage[];
	planMessageIdx: number;
	fileReadHistory?: Map<string, FileReadRecord>;
}): string => {
	const parts: string[] = [];

	if (opts.planMessageIdx !== -1) {
		const plan = opts.chatMessages[opts.planMessageIdx];
		if (plan.role === 'plan') {
			const lines = plan.items.map(item => `- [${item.status}] ${item.text}`);
			parts.push(`Previous plan in this thread:\n${lines.join('\n')}`);
		}
	}

	if (opts.fileReadHistory && opts.fileReadHistory.size > 0) {
		const files = [...opts.fileReadHistory.keys()]
			.map(key => key.split(/[/\\]/).pop() ?? key)
			.slice(0, 20)
			.join(', ');
		parts.push(`Files already read in this thread (content likely in conversation history): ${files}`);
	}

	const recentTools = summarizeRecentToolActivity(opts.chatMessages, opts.planMessageIdx);
	if (recentTools) {
		parts.push(recentTools);
	}

	return parts.join('\n\n');
};

const summarizeRecentToolActivity = (chatMessages: ChatMessage[], planMessageIdx: number): string | undefined => {
	const startIdx = planMessageIdx !== -1 ? planMessageIdx + 1 : 0;
	const labels: string[] = [];
	for (let i = chatMessages.length - 1; i >= startIdx && labels.length < 8; i--) {
		const message = chatMessages[i];
		if (message.role !== 'tool') continue;
		if (message.type !== 'success' && message.type !== 'running_now') continue;
		const params = 'params' in message ? message.params as Record<string, unknown> | undefined : undefined;
		const uri = params?.uri;
		const pathSuffix = uri instanceof URI
			? ` · ${uri.fsPath.split(/[/\\]/).pop()}`
			: typeof uri === 'object' && uri !== null && 'fsPath' in uri
				? ` · ${String((uri as { fsPath: string }).fsPath).split(/[/\\]/).pop()}`
				: '';
		labels.unshift(`${message.name}${pathSuffix}`);
	}
	if (labels.length === 0) return undefined;
	return `Recent tool activity since the plan:\n${labels.map(l => `- ${l}`).join('\n')}`;
};

const planUserMessage = (content: string): ChatMessage => ({
	role: 'user',
	content,
	displayContent: content,
	selections: null,
	state: { stagingSelections: [], isBeingEdited: false },
});

export type GenerateAgentPlanOpts = {
	/** Host-supplied single-shot LLM call. */
	callLLM: LLMCallPort;
	/** Optional sink for the plan call's token usage. */
	usageMeter?: UsageMeterPort;
	modelSelection: ModelSelection;
	modelSelectionOptions?: ModelSelectionOptions | undefined;
	overridesOfModel?: OverridesOfModel | undefined;
	chatMode: ChatMode;
	chatMessages: ChatMessage[];
	threadId: string;
	sessionContext?: string;
	signal?: AbortSignal;
	/** Override for tests; defaults to PLAN_GENERATION_TIMEOUT_MS. */
	timeoutMs?: number;
};

/** Generate a 3-8 bullet plan via a capped side-call. Returns null on failure, timeout or too few bullets. */
export const generateAgentPlan = async (opts: GenerateAgentPlanOpts): Promise<PlanMessage | null> => {
	const userTask = summarizeUserTask(opts.chatMessages);
	const sessionBlock = opts.sessionContext?.trim()
		? `\n\nSession context (do not repeat completed work; continue from here):\n${opts.sessionContext.trim()}`
		: '';
	const messages: ChatMessage[] = [
		planUserMessage(`User task:\n${userTask}${sessionBlock}\n\nList the steps you will take.`),
	];

	const planOverrides = withPlanTokenCap(opts.overridesOfModel, opts.modelSelection);

	const { reasoningCapabilities } = getModelCapabilities(
		opts.modelSelection.providerName,
		opts.modelSelection.modelName,
		planOverrides,
	);
	const reasoningSlider = reasoningCapabilities === false ? undefined : reasoningCapabilities?.reasoningSlider;
	const defaultBudget = reasoningSlider?.type === 'budget_slider' ? reasoningSlider.default : undefined;
	const effectiveBudget = opts.modelSelectionOptions?.reasoningBudget ?? defaultBudget;
	const planModelOptions: ModelSelectionOptions = {
		...opts.modelSelectionOptions,
		...(effectiveBudget ? { reasoningBudget: Math.min(effectiveBudget, 2048) } : {}),
	};

	let fullText = '';
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		fullText = await Promise.race([
			opts.callLLM({
				messages,
				systemMessage: PLAN_SYSTEM_MESSAGE,
				maxOutputTokens: PLAN_OUTPUT_TOKEN_CAP,
				modelSelection: opts.modelSelection,
				modelSelectionOptions: planModelOptions,
				overridesOfModel: planOverrides,
				chatMode: opts.chatMode,
				purpose: 'Agent Plan',
				signal: opts.signal,
			}).then(({ text, usage }) => {
				if (usage && opts.usageMeter) {
					opts.usageMeter.record(usage, {
						provider: opts.modelSelection.providerName,
						model: opts.modelSelection.modelName,
						purpose: 'Agent Plan',
						threadId: opts.threadId,
					});
				}
				return text;
			}),
			new Promise<string>((_, reject) => {
				timer = setTimeout(() => reject(new Error('Plan generation timed out')), opts.timeoutMs ?? PLAN_GENERATION_TIMEOUT_MS);
			}),
		]);
	} catch {
		return null;
	} finally {
		if (timer) clearTimeout(timer);
	}

	const items = parsePlanBulletItems(fullText);
	if (items.length < PLAN_MIN_BULLETS) {
		return null;
	}
	return { role: 'plan', items };
};

export type ResolveAgentPlanOpts = Omit<GenerateAgentPlanOpts, 'sessionContext'> & {
	fileReadHistory?: Map<string, FileReadRecord>;
};

/** Resume an in-progress plan or generate a context-aware plan. Never throws — returns `none` on failure. */
export const resolveAgentPlanForRun = async (opts: ResolveAgentPlanOpts): Promise<AgentPlanRunResolution> => {
	try {
		const userTask = summarizeUserTask(opts.chatMessages);
		const planMessageIdx = findLatestPlanMessageIdx(opts.chatMessages);
		const latestPlan = planMessageIdx !== -1 ? getLatestPlanMessage(opts.chatMessages) : null;

		if (latestPlan) {
			if (planHasPendingItems(latestPlan)) {
				if (isLikelyNewTaskUserMessage(userTask)) {
					// Fall through — generate a fresh plan and retire the old one.
				} else {
					return { action: 'reuse' };
				}
			} else if (isContinuationUserMessage(userTask)) {
				const reactivated = reactivateAbortedPlan(latestPlan);
				if (reactivated) {
					return { action: 'reactivate', plan: reactivated, planMessageIdx };
				}
			}
		}

		const sessionContext = buildPlanSessionContext({
			chatMessages: opts.chatMessages,
			planMessageIdx,
			fileReadHistory: opts.fileReadHistory,
		});

		const plan = await generateAgentPlan({
			...opts,
			sessionContext,
		});

		if (!plan) {
			return { action: 'none' };
		}

		const priorPlanMessageIdx = latestPlan && planHasPendingItems(latestPlan) && isLikelyNewTaskUserMessage(userTask)
			? planMessageIdx
			: undefined;

		return { action: 'generate', plan, priorPlanMessageIdx };
	} catch {
		return { action: 'none' };
	}
};

export const getToolSummaryForPlanMatch = (toolName: ToolName, toolParams: ToolCallParams<ToolName>): string => {
	const parts = [toolName];
	const params = toolParams as Record<string, unknown>;
	const uri = params.uri;
	if (uri instanceof URI) {
		parts.push(uri.fsPath);
	} else if (typeof uri === 'string') {
		parts.push(uri);
	}
	if (typeof params.query === 'string') parts.push(params.query);
	if (typeof params.query_regex === 'string') parts.push(params.query_regex);
	if (typeof params.command === 'string') parts.push(params.command);
	return parts.join(' ').toLowerCase();
};

const basenameFromToolParams = (toolParams: ToolCallParams<ToolName>): string | undefined => {
	const params = toolParams as Record<string, unknown>;
	const uri = params.uri;
	if (uri instanceof URI) {
		return uri.fsPath.replace(/\\/g, '/').split('/').pop();
	}
	if (typeof uri === 'string') {
		return uri.replace(/\\/g, '/').split('/').pop();
	}
	return undefined;
};

const planMentionsFile = (planText: string, basename: string): boolean => {
	const plan = planText.toLowerCase();
	const file = basename.toLowerCase();
	if (plan.includes(file)) return true;
	const stem = file.replace(/\.[^.]+$/, '');
	return stem.length > 2 && plan.includes(stem);
};

const planHasVerb = (planText: string, verbs: string[]): boolean => {
	const plan = planText.toLowerCase();
	return verbs.some(v => plan.includes(v));
};

const getToolCategory = (toolName: ToolName): ToolCategory => {
	switch (toolName) {
		case 'read_file':
		case 'ls_dir':
		case 'get_dir_tree':
		case 'read_lint_errors':
		case 'search_in_file':
			return 'read';
		case 'search_pathnames_only':
		case 'search_for_files':
		case 'search_codebase':
		case 'search_web':
			return 'search';
		case 'edit_file':
		case 'rewrite_file':
			return 'edit';
		case 'create_file_or_folder':
			return 'create';
		case 'delete_file_or_folder':
			return 'delete';
		case 'run_command':
		case 'run_tests':
		case 'run_persistent_command':
		case 'open_persistent_terminal':
		case 'kill_persistent_terminal':
			return 'run';
		default:
			return 'other';
	}
};

const textMatchesTool = (planText: string, toolSummary: string): boolean => {
	const plan = planText.toLowerCase();
	const tool = toolSummary.toLowerCase();
	if (plan.includes(tool) || tool.includes(plan)) return true;
	const tokens = tool.split(/[\s/\\._-]+/).filter(t => t.length > 3);
	return tokens.some(t => plan.includes(t));
};

const scorePlanItemForTool = (
	planText: string,
	category: ToolCategory,
	toolSummary: string,
	basename?: string,
): number => {
	const plan = planText.toLowerCase();
	let score = 0;

	if (basename && planMentionsFile(planText, basename)) {
		score += 12;
	}

	const categoryVerbs: Record<ToolCategory, string[]> = {
		read: READ_VERBS,
		search: SEARCH_VERBS,
		edit: [...EDIT_VERBS, ...SAVE_VERBS],
		create: CREATE_VERBS,
		run: [...RUN_VERBS, ...VERIFY_VERBS],
		delete: ['delete', 'remove'],
		other: [],
	};
	for (const verb of categoryVerbs[category]) {
		if (plan.includes(verb)) score += 4;
	}

	const tokens = toolSummary.split(/[\s/\\._-]+/).filter(t => t.length > 3);
	score += tokens.filter(t => plan.includes(t)).length * 2;

	if (textMatchesTool(planText, toolSummary)) {
		score += 3;
	}

	return score;
};

const firstPendingIndex = (items: PlanMessage['items']): number =>
	items.findIndex(item => item.status === 'pending');

const skipRedundantReadPlanSteps = (items: PlanMessage['items'], basename: string): void => {
	for (let i = 0; i < items.length; i++) {
		if (items[i].status !== 'pending') continue;
		const text = items[i].text;
		if (planMentionsFile(text, basename) && planHasVerb(text, READ_VERBS)) {
			items[i] = { ...items[i], status: 'skipped' };
		}
	}
};

export const markPlanItemDoneForTool = (plan: PlanMessage, toolName: ToolName, toolParams: ToolCallParams<ToolName>): PlanMessage => {
	const toolSummary = getToolSummaryForPlanMatch(toolName, toolParams);
	const basename = basenameFromToolParams(toolParams);
	const category = getToolCategory(toolName);
	const items = plan.items.map(item => ({ ...item }));
	const markIndices = new Set<number>();

	if (category === 'edit') {
		for (let i = 0; i < items.length; i++) {
			if (items[i].status !== 'pending') continue;
			const text = items[i].text;
			const fileMatch = !basename || planMentionsFile(text, basename);
			const editMatch = planHasVerb(text, EDIT_VERBS) || planHasVerb(text, SAVE_VERBS);
			if (fileMatch && editMatch) {
				markIndices.add(i);
			}
		}
	}

	if (category === 'create') {
		for (let i = 0; i < items.length; i++) {
			if (items[i].status !== 'pending') continue;
			const text = items[i].text;
			const fileMatch = !basename || planMentionsFile(text, basename);
			const createMatch = planHasVerb(text, CREATE_VERBS) || planHasVerb(text, EDIT_VERBS);
			if (fileMatch && createMatch) {
				markIndices.add(i);
			}
		}
	}

	if (category === 'run' && basename) {
		for (let i = 0; i < items.length; i++) {
			if (items[i].status !== 'pending') continue;
			const text = items[i].text;
			if (planMentionsFile(text, basename) && planHasVerb(text, VERIFY_VERBS)) {
				markIndices.add(i);
			}
		}
	}

	if (markIndices.size === 0) {
		let bestIdx = -1;
		let bestScore = 0;
		for (let i = 0; i < items.length; i++) {
			if (items[i].status !== 'pending') continue;
			const score = scorePlanItemForTool(items[i].text, category, toolSummary, basename);
			if (score > bestScore) {
				bestScore = score;
				bestIdx = i;
			}
		}

		if (bestIdx !== -1 && bestScore >= 4) {
			markIndices.add(bestIdx);
		} else {
			const looseIdx = items.findIndex(item => item.status === 'pending' && textMatchesTool(item.text, toolSummary));
			const idx = looseIdx !== -1 ? looseIdx : firstPendingIndex(items);
			if (idx !== -1) markIndices.add(idx);
		}
	}

	for (const idx of markIndices) {
		items[idx] = { ...items[idx], status: 'done' };
	}

	if (category === 'create' && basename) {
		skipRedundantReadPlanSteps(items, basename);
	}

	return { role: 'plan', items };
};

export const completeRemainingPlanItems = (plan: PlanMessage): PlanMessage => ({
	role: 'plan',
	items: plan.items.map(item => item.status === 'pending' ? { ...item, status: 'done' } : item),
});

export const skipRemainingPlanItems = (plan: PlanMessage): PlanMessage => ({
	role: 'plan',
	items: plan.items.map(item => item.status === 'pending' ? { ...item, status: 'skipped' } : item),
});

export const findLatestPlanMessageIdx = (messages: ChatMessage[]): number => {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'plan') return i;
	}
	return -1;
};
