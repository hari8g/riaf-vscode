/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from './shim/vsBase.js';
import { ChatMessage } from './types.js';
import { BuiltinToolCallParams, ToolName } from './types.js';
import { getProtectedTailStartIndex } from './contextWindowTrim.js';
import { readFileUriKey } from './fileReadDedup.js';

/** How many recent compactable tool results stay at full size within the current agent run. */
export const RECENT_FULL_TOOL_RESULTS = 2;

export const COMPACTABLE_TOOL_NAMES: ReadonlySet<ToolName> = new Set([
	'read_file',
	'search_codebase',
	'get_file_outline',
	'get_symbol',
	'search_symbols',
	'search_web',
	'search_for_files',
	'search_in_file',
	'search_pathnames_only',
	'get_dir_tree',
	'ls_dir',
	'run_command',
	'run_tests',
	'run_persistent_command',
]);

export const isCompactableToolName = (toolName: ToolName): boolean => {
	return COMPACTABLE_TOOL_NAMES.has(toolName);
};

const formatReadFileCompact = (params: BuiltinToolCallParams['read_file'], content: string): string => {
	const path = params.uri instanceof URI ? params.uri.fsPath : String(params.uri);
	const lineCount = content.split('\n').length;
	const start = params.startLine ?? 1;
	const end = params.endLine ?? start + lineCount - 1;
	return `read_file(${path}) → <${lineCount} lines, lines ${start}-${end}>; re-read if needed`;
};

const formatGenericCompact = (toolName: ToolName, content: string): string => {
	const lineCount = content.split('\n').length;
	return `${toolName}(...) → <${lineCount} lines>; re-run if needed`;
};

const formatTerminalCommandCompact = (
	params: BuiltinToolCallParams['run_command'] | BuiltinToolCallParams['run_persistent_command'],
	content: string,
): string => {
	const command = (params as { command: string }).command;
	const lineCount = content.split('\n').length;
	const exitMatch = content.match(/\(exit code (\d+)\)/);
	const statusSuffix = exitMatch ? `, exit ${exitMatch[1]}` : '';
	return `run_command(${JSON.stringify(command)}) → <${lineCount} lines${statusSuffix}>; re-run if needed`;
};

const getReadFileUriKey = (message: ChatMessage): string | undefined => {
	if (message.role !== 'tool' || message.name !== 'read_file' || message.type !== 'success') {
		return undefined;
	}
	const uri = (message.params as BuiltinToolCallParams['read_file']).uri;
	return readFileUriKey(uri);
};

/** Replace stale compactable tool bodies with short references before wire conversion. */
export const compactStaleToolResults = (
	chatMessages: ChatMessage[],
	onCompactedFileRead?: (uri: URI) => void,
): ChatMessage[] => {
	const tailStart = getProtectedTailStartIndex(chatMessages);

	const compactableIndices = chatMessages
		.map((message, index) => ({ message, index }))
		.filter(({ message }) => {
			return message.role === 'tool'
				&& message.compactable
				&& message.type === 'success';
		})
		.map(({ index }) => index);

	// Within the protected tail (typical single-turn agent runs), still compact all but the last N read/search results.
	const tailCompactable = compactableIndices.filter(index => index >= tailStart);
	const latestReadByFile = new Map<string, number>();
	for (const index of tailCompactable) {
		const fileKey = getReadFileUriKey(chatMessages[index]);
		if (fileKey) {
			latestReadByFile.set(fileKey, index);
		}
	}

	const keepFullIndices = new Set(tailCompactable.slice(-RECENT_FULL_TOOL_RESULTS));
	for (const [, latestIndex] of latestReadByFile) {
		keepFullIndices.add(latestIndex);
	}

	const staleTailIndices = new Set(
		tailCompactable.filter(index => !keepFullIndices.has(index)),
	);
	const stalePrefixIndices = new Set(compactableIndices.filter(index => index < tailStart));

	return chatMessages.map((message, index) => {
		if (message.role !== 'tool') {
			return message;
		}
		if (!message.compactable || message.type !== 'success') {
			return message;
		}
		if (!stalePrefixIndices.has(index) && !staleTailIndices.has(index)) {
			return message;
		}

		let compactContent: string;
		if (message.name === 'read_file') {
			compactContent = formatReadFileCompact(
				message.params as BuiltinToolCallParams['read_file'],
				message.content,
			);
			const uri = (message.params as BuiltinToolCallParams['read_file']).uri;
			onCompactedFileRead?.(uri);
		} else if (message.name === 'run_command' || message.name === 'run_persistent_command') {
			compactContent = formatTerminalCommandCompact(
				message.params as BuiltinToolCallParams['run_command'] | BuiltinToolCallParams['run_persistent_command'],
				message.content,
			);
		} else {
			compactContent = formatGenericCompact(message.name, message.content);
		}

		if (compactContent === message.content) {
			return message;
		}
		return { ...message, content: compactContent };
	});
};
