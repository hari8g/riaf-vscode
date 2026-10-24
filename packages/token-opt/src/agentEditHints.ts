/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from './shim/vsBase.js';
import { ToolName } from './types.js';

export const REPEAT_EDIT_THRESHOLD = 2;

/** Files larger than this should use chunked edit_file, not rewrite_file or one big edit. */
export const LARGE_FILE_EDIT_THRESHOLD_CHARS = 3_000;

export const trackFileEdit = (
	counts: Map<string, number>,
	toolName: ToolName,
	toolParams: Record<string, unknown>,
): void => {
	if (toolName !== 'edit_file' && toolName !== 'rewrite_file') {
		return;
	}
	const uri = toolParams.uri;
	const path = uri instanceof URI ? uri.fsPath : typeof uri === 'string' ? uri : undefined;
	if (!path) {
		return;
	}
	counts.set(path, (counts.get(path) ?? 0) + 1);
};

export const buildRepeatEditHint = (fileEditCounts: Map<string, number>): string => {
	const repeated = [...fileEditCounts.entries()]
		.filter(([, count]) => count >= REPEAT_EDIT_THRESHOLD)
		.map(([path]) => path);
	if (repeated.length === 0) {
		return '';
	}
	const fileList = repeated.map(p => p.split(/[/\\]/).pop() ?? p).join(', ');
	return `\n\n<agent_hints>
You have edited the same file(s) multiple times this run (${fileList}). Stop making incremental edits.
Read the current file state once, then apply remaining related changes in one or two edit_file calls with multiple SEARCH/REPLACE blocks (keep each call small — 1–3 blocks).
</agent_hints>`;
};

export const buildLargeFileEditHint = (fileReads: Map<string, { totalFileLen?: number }>): string => {
	const large = [...fileReads.entries()]
		.filter(([, record]) => (record.totalFileLen ?? 0) >= LARGE_FILE_EDIT_THRESHOLD_CHARS)
		.map(([path]) => path.split(/[/\\]/).pop() ?? path);
	if (large.length === 0) {
		return '';
	}
	const fileList = large.join(', ');
	return `\n\n<agent_hints>
You read large file(s) this run (${fileList}, ≥${LARGE_FILE_EDIT_THRESHOLD_CHARS} chars). Do NOT use rewrite_file on them — output will truncate.
Apply theme/styling changes with several small edit_file calls (1–3 SEARCH/REPLACE blocks each, one section at a time).
</agent_hints>`;
};
