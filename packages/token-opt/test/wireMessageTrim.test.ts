/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { describe, it } from 'vitest';
import {
	CHARS_PER_TOKEN,
	computeEffectiveOutputReserve,
	elideOldestToolResultsFirst,
	TOOL_OUTPUT_OMISSION,
} from '../src/wireMessageTrim.js';

describe('Trove - wireMessageTrim', () => {

	it('computeEffectiveOutputReserve adds safety margin', () => {
		assert.strictEqual(computeEffectiveOutputReserve(4_096), 4_096 + 2_000);
		assert.strictEqual(computeEffectiveOutputReserve(null), 4_096 + 2_000);
	});

	it('elideOldestToolResultsFirst omits oldest tool bodies first', () => {
		const messages = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'older user turn' },
			{ role: 'tool', content: 'old tool output '.repeat(100) },
			{ role: 'assistant', content: 'a0' },
			{ role: 'user', content: 'u1' },
			{ role: 'tool', content: 'mid tool 1' },
			{ role: 'tool', content: 'mid tool 2' },
			{ role: 'user', content: 'u2' },
			{ role: 'tool', content: 'recent tool' },
		];
		const totalBefore = messages.reduce((sum, m) => sum + m.content.length, 0);
		const budget = totalBefore - 500;
		elideOldestToolResultsFirst(messages, budget);
		assert.strictEqual(messages[2].content, TOOL_OUTPUT_OMISSION);
		assert.strictEqual(messages[8].content, 'recent tool');
	});

	it('CHARS_PER_TOKEN is 4', () => {
		assert.strictEqual(CHARS_PER_TOKEN, 4);
	});
});
