/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { ChatMode } from './types.js';

export const MAX_EDIT_COMPLETION_NUDGES = 2;

export type EditCompletionTracker = {
	/** edit_file / rewrite_file started streaming but never completed */
	interruptedEditTool: boolean;
	/** tool JSON arrived but content param was missing (usually output token truncation) */
	truncatedEditTool: boolean;
	nudgeCount: number;
};

export const createEditCompletionTracker = (): EditCompletionTracker => ({
	interruptedEditTool: false,
	truncatedEditTool: false,
	nudgeCount: 0,
});

export const markInterruptedEditTool = (tracker: EditCompletionTracker): void => {
	tracker.interruptedEditTool = true;
};

export const markTruncatedEditTool = (tracker: EditCompletionTracker): void => {
	tracker.truncatedEditTool = true;
};

export const isMissingEditContentError = (toolName: string, errorMessage: string): boolean =>
	isEditToolName(toolName) && (
		errorMessage.includes('searchReplaceBlocks')
		|| errorMessage.includes('search_replace_blocks')
		|| errorMessage.includes('newContent')
	);

const EDIT_INTENT_PATTERN = /\b(edit|modify|update|change|restyle|styling|theme|rewrite|implement|fix|add|introduce|adapt|convert|apply)\b/i;

export const detectEditIntentFromText = (text: string): boolean => {
	if (!text.trim()) {
		return false;
	}
	const lower = text.toLowerCase();
	if (EDIT_INTENT_PATTERN.test(lower)) {
		return true;
	}
	return /\.(css|js|ts|tsx|jsx|html|json|scss)\b/.test(lower)
		&& /\b(file|styling|theme|color|style)\b/i.test(lower);
};

export const isEditToolName = (name: string): boolean =>
	name === 'edit_file' || name === 'rewrite_file';

export const needsEditCompletion = (opts: {
	tracker: EditCompletionTracker;
	fileEditCounts: Map<string, number>;
	readOnlyCallCount: number;
	userMessage: string;
	chatMode: ChatMode;
}): boolean => {
	if (opts.chatMode !== 'agent') {
		return false;
	}
	if (opts.fileEditCounts.size > 0) {
		return false;
	}
	if (opts.tracker.nudgeCount >= MAX_EDIT_COMPLETION_NUDGES) {
		return false;
	}
	const hasEditIntent = detectEditIntentFromText(opts.userMessage)
		|| opts.tracker.interruptedEditTool
		|| opts.tracker.truncatedEditTool;
	if (!hasEditIntent) {
		return false;
	}
	return opts.tracker.interruptedEditTool || opts.tracker.truncatedEditTool || opts.readOnlyCallCount >= 1;
};

export const buildEditCompletionHint = (opts: {
	interruptedEditTool: boolean;
	truncatedEditTool?: boolean;
}): string => {
	if (opts.truncatedEditTool) {
		return `\n\n<agent_hints>
MANDATORY — your previous edit_file or rewrite_file call was TRUNCATED (output token limit). Content params were NOT received — the file was NOT modified.
Use several small edit_file calls (1–3 SEARCH/REPLACE blocks each). Do NOT use rewrite_file on large files. Do NOT describe changes in prose — call the tool.
</agent_hints>`;
	}
	if (opts.interruptedEditTool) {
		return `\n\n<agent_hints>
MANDATORY — your previous edit_file or rewrite_file call was interrupted before it completed. The file was NOT modified.
Call edit_file NOW with complete parameters (small chunks for large files). Do not describe changes in prose — use the tool.
</agent_hints>`;
	}
	return `\n\n<agent_hints>
MANDATORY — you explored the codebase but have NOT applied any file edits yet. The user's request requires code changes.
Call edit_file or rewrite_file NOW. Do not end your turn with a summary — use the tool to write the changes.
</agent_hints>`;
};
