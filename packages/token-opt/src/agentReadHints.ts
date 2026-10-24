/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { RawToolParamsObj } from './types.js';
import { ToolName } from './types.js';
import { isReadOnlyBatchTool, toolCallDedupKey } from './parallelReadToolBatch.js';
import { DEFAULT_MAX_READONLY_CALLS } from './agentLoopLimits.js';
import { getEffectiveMaxReadOnlyCalls } from './lightAgent.js';
import {
	extractReadFileUriFromRawParams,
	FileReadRecord,
	trackFileRead,
} from './fileReadDedup.js';
import type { GlobalSettings } from './types.js';

export const REPEAT_READ_THRESHOLD = 2;

export type ReadOnlyCallCounts = {
	signatures: Map<string, number>;
	total: number;
	fileReads: Map<string, FileReadRecord>;
};

export const createReadOnlyCallCounts = (): ReadOnlyCallCounts => ({
	signatures: new Map(),
	total: 0,
	fileReads: new Map(),
});

export const trackReadOnlyCall = (
	counts: ReadOnlyCallCounts,
	toolName: ToolName,
	rawParams: RawToolParamsObj,
	userTurn?: number,
): void => {
	if (!isReadOnlyBatchTool(toolName)) {
		return;
	}
	const key = toolCallDedupKey(toolName, rawParams);
	counts.signatures.set(key, (counts.signatures.get(key) ?? 0) + 1);
	counts.total += 1;

	if (toolName === 'read_file') {
		const uriKey = extractReadFileUriFromRawParams(rawParams);
		if (uriKey) {
			const startLine = rawParams.startLine != null ? Number(rawParams.startLine) : null;
			const endLine = rawParams.endLine != null ? Number(rawParams.endLine) : null;
			trackFileRead(counts.fileReads, uriKey, Number.isFinite(startLine) ? startLine : null, Number.isFinite(endLine) ? endLine : null, undefined, userTurn);
		}
	}
};

export const buildRepeatReadHint = (counts: ReadOnlyCallCounts): string => {
	const repeated = [...counts.signatures.entries()]
		.filter(([, count]) => count >= REPEAT_READ_THRESHOLD)
		.map(([key]) => key.split(':')[0]);
	if (repeated.length === 0) {
		return '';
	}
	const uniqueTools = [...new Set(repeated)].join(', ');
	return `\n\n<agent_hints>
You already ran the same read/search tool(s) this run (${uniqueTools}). Use the results you already have, or try a different approach — do not repeat identical calls.
</agent_hints>`;
};

export const buildExplorationBudgetHint = (
	counts: ReadOnlyCallCounts,
	maxReadOnlyCalls = DEFAULT_MAX_READONLY_CALLS,
	settings?: GlobalSettings,
): string => {
	const budget = settings ? getEffectiveMaxReadOnlyCalls(settings) : maxReadOnlyCalls;
	if (counts.total < budget) {
		return '';
	}
	return `\n\n<agent_hints>
You have made ${counts.total} read/search calls this run. Stop exploring — use what you have learned to act (edit, run commands) or conclude with your findings.
</agent_hints>`;
};

/**
 * Emits a one-shot hint on the very first turn of a new query when the thread
 * already has file-read history from previous queries.  This tells the model
 * upfront which files it has already seen so it does not re-read them.
 * Only fires on the first message of a new run (nMessagesSent === 1).
 */
export const buildCrossQueryFileReadHint = (
	fileReads: Map<string, FileReadRecord>,
	nMessagesSent: number,
): string => {
	if (nMessagesSent !== 1) return '';
	// Only list files that were read in a previous run (count is carried over from history,
	// so any entry with count >= 1 that exists before this run starts was pre-seeded).
	// We suppress the hint when fileReads is empty (first-ever query in thread).
	if (fileReads.size === 0) return '';
	const files = [...fileReads.keys()]
		.map(k => k.split(/[/\\]/).pop() ?? k)
		.slice(0, 20) // cap to avoid prompt bloat
		.join(', ');
	return `\n\n<agent_hints>
Files already read in this thread earlier: ${files}.
Their content is likely still in the conversation above. Search the thread before calling read_file on these paths again.
</agent_hints>`;
};

export const buildAgentTailHints = (opts: {
	repeatEditHint: string;
	repeatReadHint: string;
	repeatFileReadHint: string;
	largeFileEditHint?: string;
	explorationBudgetHint: string;
	sandboxVerificationHint?: string;
	editCompletionHint?: string;
	crossQueryFileReadHint?: string;
}): string => {
	return (opts.repeatEditHint + opts.repeatReadHint + opts.repeatFileReadHint + (opts.largeFileEditHint ?? '') + opts.explorationBudgetHint + (opts.sandboxVerificationHint ?? '') + (opts.editCompletionHint ?? '') + (opts.crossQueryFileReadHint ?? '')).trim();
};
