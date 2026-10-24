/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { generateUuid } from './shim/vsBase.js';
import { isABuiltinToolName } from './types.js';
import type {
	BuiltinToolName,
	ChatMessage,
	ChatMode,
	ModelSelection,
	ModelSelectionOptions,
	OverridesOfModel,
	RawToolCallObj,
	RawToolParamsObj,
	ToolName,
} from './types.js';
import type { LLMCallPort } from './ports.js';

export const READ_ONLY_BATCH_TOOL_NAMES: ReadonlySet<BuiltinToolName> = new Set<BuiltinToolName>([
	'read_file',
	'ls_dir',
	'get_dir_tree',
	'search_pathnames_only',
	'search_for_files',
	'search_in_file',
	'search_codebase',
	'get_file_outline',
	'get_symbol',
	'search_symbols',
	'search_web',
]);

export const MAX_ADDITIONAL_READ_TOOLS = 4;
export const DISCOVERY_OUTPUT_TOKEN_CAP = 200;

export const isReadOnlyBatchTool = (toolName: ToolName): boolean => {
	return isABuiltinToolName(toolName) && READ_ONLY_BATCH_TOOL_NAMES.has(toolName);
};

export const toolCallDedupKey = (name: string, rawParams: RawToolParamsObj): string => {
	const sorted = Object.keys(rawParams).sort().reduce<RawToolParamsObj>((acc, key) => {
		acc[key] = rawParams[key];
		return acc;
	}, {});
	return `${name}:${JSON.stringify(sorted)}`;
};

export type ParsedDiscoveryToolCall = {
	name: BuiltinToolName;
	rawParams: RawToolParamsObj;
};

/** Parse discovery LLM output — one JSON tool call per line, or DONE. */
export const parseDiscoveryToolLines = (text: string): ParsedDiscoveryToolCall[] => {
	const results: ParsedDiscoveryToolCall[] = [];
	const seen = new Set<string>();

	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('//') || line.startsWith('#')) {
			continue;
		}
		if (/^done\.?$/i.test(line)) {
			break;
		}

		const jsonStart = line.indexOf('{');
		const jsonSlice = jsonStart >= 0 ? line.slice(jsonStart) : line;

		try {
			const parsed = JSON.parse(jsonSlice) as { name?: string; rawParams?: RawToolParamsObj; params?: RawToolParamsObj };
			const name = parsed.name;
			const rawParams = parsed.rawParams ?? parsed.params;
			if (!name || !rawParams || typeof rawParams !== 'object') {
				continue;
			}
			if (!isReadOnlyBatchTool(name)) {
				continue;
			}

			const key = toolCallDedupKey(name, rawParams);
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);

			results.push({ name: name as BuiltinToolName, rawParams });
			if (results.length >= MAX_ADDITIONAL_READ_TOOLS) {
				break;
			}
		} catch {
			// ignore malformed lines
		}
	}

	return results;
};

const buildDiscoverySystemMessage = (primary: RawToolCallObj): string => {
	return [
		'You help a coding agent batch read-only workspace tools.',
		`The agent is already calling: ${primary.name} with params ${JSON.stringify(primary.rawParams)}.`,
		'',
		'List up to ' + MAX_ADDITIONAL_READ_TOOLS + ' ADDITIONAL read-only tool calls to make in parallel at this step.',
		'Allowed tools: read_file, ls_dir, get_dir_tree, search_pathnames_only, search_for_files, search_in_file, search_codebase, search_web.',
		'',
		'Output ONE JSON object per line (no markdown, no prose):',
		'{"name":"read_file","rawParams":{"uri":"src/foo.ts"}}',
		'Prefer workspace-relative paths (e.g. "src/foo.ts") or absolute paths. Do not invent paths outside the workspace.',
		'',
		'If no additional reads are needed, output exactly: DONE',
	].join('\n');
};

/** Minimal message shape accepted for `recentMessages` — a full ChatMessage[] also satisfies it. */
export type RecentMessageLike = { role: string; content?: string; displayContent?: string };

const summarizeUserTask = (messages: readonly RecentMessageLike[]): string => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === 'user') {
			const text = ('displayContent' in m && m.displayContent) ? m.displayContent : m.content;
			if (text?.trim()) {
				return text.trim().slice(0, 1200);
			}
		}
	}
	return '(No user message found)';
};

/** Apply the discovery output-token cap into an OverridesOfModel copy (mirrors the fork's reservedOutputTokenSpace override). */
export const withDiscoveryTokenCap = (
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
				reservedOutputTokenSpace: DISCOVERY_OUTPUT_TOKEN_CAP,
			},
		},
	} as OverridesOfModel;
};

const userMessage = (content: string): ChatMessage => ({
	role: 'user',
	content,
	displayContent: content,
	selections: null,
	state: { stagingSelections: [], isBeingEdited: false },
});

/**
 * Ask a small side-call LLM for up to MAX_ADDITIONAL_READ_TOOLS extra read-only tool
 * calls to run in parallel with `primaryToolCall`. Rejects if the LLM call fails.
 */
export const discoverAdditionalReadTools = async (opts: {
	callLLM: LLMCallPort;
	modelSelection?: ModelSelection;
	modelSelectionOptions?: ModelSelectionOptions | undefined;
	overridesOfModel?: OverridesOfModel | undefined;
	chatMode?: ChatMode;
	primaryToolCall: RawToolCallObj;
	recentMessages: readonly RecentMessageLike[];
	excludeKeys: Set<string>;
	signal?: AbortSignal;
}): Promise<RawToolCallObj[]> => {
	const userTask = summarizeUserTask(opts.recentMessages);
	const systemMessage = buildDiscoverySystemMessage(opts.primaryToolCall);

	const discoveryOverrides = opts.modelSelection
		? withDiscoveryTokenCap(opts.overridesOfModel, opts.modelSelection)
		: opts.overridesOfModel;

	const { text: fullText } = await opts.callLLM({
		messages: [userMessage('User task:\n' + userTask + '\n\nList additional read-only tools needed now (or DONE).')],
		systemMessage,
		maxOutputTokens: DISCOVERY_OUTPUT_TOKEN_CAP,
		modelSelection: opts.modelSelection,
		modelSelectionOptions: opts.modelSelectionOptions,
		overridesOfModel: discoveryOverrides,
		chatMode: opts.chatMode,
		purpose: 'Read Tool Batch Discovery',
		signal: opts.signal,
	});

	const parsed = parseDiscoveryToolLines(fullText);
	const additional: RawToolCallObj[] = [];

	for (const item of parsed) {
		const key = toolCallDedupKey(item.name, item.rawParams);
		if (opts.excludeKeys.has(key)) {
			continue;
		}
		additional.push({
			name: item.name,
			rawParams: item.rawParams,
			doneParams: Object.keys(item.rawParams),
			id: `batch-${generateUuid()}`,
			isDone: true,
		});
		if (additional.length >= MAX_ADDITIONAL_READ_TOOLS) {
			break;
		}
	}

	return additional;
};

export const buildReadToolBatch = (
	primary: RawToolCallObj,
	additional: RawToolCallObj[],
): RawToolCallObj[] => {
	const batch: RawToolCallObj[] = [primary];
	const seen = new Set([toolCallDedupKey(primary.name, primary.rawParams)]);

	for (const tool of additional) {
		const key = toolCallDedupKey(tool.name, tool.rawParams);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		batch.push(tool);
	}

	return batch.slice(0, 1 + MAX_ADDITIONAL_READ_TOOLS);
};
