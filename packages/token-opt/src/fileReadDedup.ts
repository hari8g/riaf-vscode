/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from './shim/vsBase.js';
import { isWindows } from './shim/vsBase.js';
import { RawToolParamsObj } from './types.js';

export type FileReadRecord = {
	count: number;
	ranges: string[];
	totalFileLen?: number;
	/** User-turn index when this file was last read (for cross-turn eviction). */
	lastReadTurn?: number;
};

export const readFileUriKey = (uri: URI | string): string => {
	let key: string;
	if (uri instanceof URI) {
		key = uri.toString();
	} else {
		const s = String(uri);
		if (s.includes('://')) {
			try {
				key = URI.parse(s).toString();
			} catch {
				key = s;
			}
		} else {
			// Normalize bare paths to file:// so they match URI.file(...).toString() keys.
			key = URI.file(s).toString();
		}
	}
	return isWindows ? key.toLowerCase() : key;
};

/** Drop a file's read record — call whenever its content may have changed. */
export const invalidateFileRead = (
	fileReads: Map<string, FileReadRecord>,
	uri: URI | string,
): void => {
	fileReads.delete(readFileUriKey(uri));
};

export const formatReadFileRange = (startLine: number | null | undefined, endLine: number | null | undefined): string => {
	if (startLine == null && endLine == null) {
		return 'full file';
	}
	const start = startLine ?? 1;
	const end = endLine == null ? 'end' : String(endLine);
	return `lines ${start}-${end}`;
};

export const extractReadFileUriFromRawParams = (rawParams: RawToolParamsObj): string | undefined => {
	const uri = rawParams.uri;
	if (!uri) {
		return undefined;
	}
	if (typeof uri === 'string') {
		return readFileUriKey(uri);
	}
	if (typeof uri === 'object' && uri !== null && 'fsPath' in uri && typeof (uri as { fsPath?: string }).fsPath === 'string') {
		return readFileUriKey((uri as { fsPath: string }).fsPath);
	}
	return undefined;
};

export const trackFileRead = (
	fileReads: Map<string, FileReadRecord>,
	uri: URI | string,
	startLine: number | null | undefined,
	endLine: number | null | undefined,
	totalFileLen?: number,
	turn?: number,
): void => {
	const key = readFileUriKey(uri);
	const range = formatReadFileRange(startLine, endLine);
	const prev = fileReads.get(key) ?? { count: 0, ranges: [] };
	prev.count += 1;
	if (!prev.ranges.includes(range)) {
		prev.ranges.push(range);
	}
	if (totalFileLen != null && totalFileLen > 0) {
		prev.totalFileLen = Math.max(prev.totalFileLen ?? 0, totalFileLen);
	}
	if (turn != null) {
		prev.lastReadTurn = turn;
	}
	fileReads.set(key, prev);
};

export const recordFileReadSize = (
	fileReads: Map<string, FileReadRecord>,
	uri: URI | string,
	totalFileLen: number,
): void => {
	if (!totalFileLen || totalFileLen <= 0) {
		return;
	}
	const key = readFileUriKey(uri);
	const prev = fileReads.get(key);
	if (!prev) {
		return;
	}
	prev.totalFileLen = Math.max(prev.totalFileLen ?? 0, totalFileLen);
	fileReads.set(key, prev);
};

/** True if [start, end] is fully contained within any single prior range. */
const isRangeCovered = (
	priorRanges: string[],
	startLine: number | null,
	endLine: number | null,
): boolean => {
	if (priorRanges.includes('full file')) {
		return true;
	}
	if (startLine === null && endLine === null) {
		return priorRanges.includes('full file');
	}

	const reqStart = startLine ?? 1;
	const reqEnd = endLine ?? Infinity;

	for (const range of priorRanges) {
		if (range === 'full file') {
			return true;
		}
		const m = range.match(/^lines (\d+)-(\w+)$/);
		if (!m) {
			continue;
		}
		const rStart = parseInt(m[1], 10);
		const rEnd = m[2] === 'end' ? Infinity : parseInt(m[2], 10);
		if (rStart <= reqStart && rEnd >= reqEnd) {
			return true;
		}
	}
	return false;
};

export const shouldSkipDuplicateFileRead = (
	fileReads: Map<string, FileReadRecord>,
	uri: URI,
	startLine: number | null,
	endLine: number | null,
): { skip: boolean; message?: string } => {
	const key = readFileUriKey(uri);
	const record = fileReads.get(key);
	if (!record || record.count < 1) {
		return { skip: false };
	}

	if (!isRangeCovered(record.ranges, startLine, endLine)) {
		return { skip: false };
	}

	const path = uri.fsPath;
	const requested = formatReadFileRange(startLine, endLine);
	const prior = record.ranges.join(', ');
	return {
		skip: true,
		message: [
			`${path}`,
			'```',
			`[read_file skipped — this exact range was already read in this thread]`,
			`Requested: ${requested}. Already have: ${prior}.`,
			`If that content is no longer visible in the conversation above, it was compacted.`,
			`In that case call read_file again with a DIFFERENT line range (e.g. a narrower`,
			`window around the part you need), or use get_file_outline / get_symbol instead.`,
			'```',
		].join('\n'),
	};
};

export const buildRepeatFileReadHint = (fileReads: Map<string, FileReadRecord>): string => {
	const repeated = [...fileReads.entries()].filter(([, record]) => record.count >= 2);
	if (repeated.length === 0) {
		return '';
	}
	const files = repeated.map(([key]) => key.split(/[/\\]/).pop() ?? key).join(', ');
	return `\n\n<agent_hints>
You already read the same file(s) more than once this run (${files}). Use prior read results in the thread — do not call read_file again on paths you already have. Edit or answer with existing context.
</agent_hints>`;
};
