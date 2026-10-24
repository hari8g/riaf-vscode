/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export const CHARS_PER_TOKEN = 4;
export const OUTPUT_RESERVE_SAFETY_MARGIN = 2_000;
export const AGGRESSIVE_WIRE_TRIM_RATIO = 0.75;
export const TOOL_OUTPUT_OMISSION = '[earlier tool output omitted to fit context]';

type WireMessage = { role: string; content: string };

export const computeEffectiveOutputReserve = (
	reservedOutputTokenSpace: number | null | undefined,
): number => {
	return (reservedOutputTokenSpace ?? 4_096) + OUTPUT_RESERVE_SAFETY_MARGIN;
};

/** Drop oldest tool bodies first when over the char budget; preserve system, last 2 user turns, last 3 tools. */
export const elideOldestToolResultsFirst = (messages: WireMessage[], charBudget: number): void => {
	let totalLen = 0;
	for (const m of messages) {
		totalLen += m.content.length;
	}
	if (totalLen <= charBudget) {
		return;
	}

	const protectedIndices = new Set<number>();
	if (messages.length > 0) {
		protectedIndices.add(0); // system message (unshifted to index 0)
	}

	const userIndices: number[] = [];
	const toolIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === 'user') {
			userIndices.push(i);
		} else if (messages[i].role === 'tool') {
			toolIndices.push(i);
		}
	}

	if (userIndices.length >= 2) {
		for (let i = userIndices[userIndices.length - 2]; i < messages.length; i++) {
			protectedIndices.add(i);
		}
	} else if (userIndices.length === 1) {
		for (let i = userIndices[0]; i < messages.length; i++) {
			protectedIndices.add(i);
		}
	}

	for (const idx of toolIndices.slice(-3)) {
		protectedIndices.add(idx);
	}

	for (const idx of toolIndices) {
		if (totalLen <= charBudget) {
			break;
		}
		if (protectedIndices.has(idx)) {
			continue;
		}
		const m = messages[idx];
		if (m.content === TOOL_OUTPUT_OMISSION) {
			continue;
		}
		totalLen -= m.content.length;
		m.content = TOOL_OUTPUT_OMISSION;
		totalLen += TOOL_OUTPUT_OMISSION.length;
	}
};
