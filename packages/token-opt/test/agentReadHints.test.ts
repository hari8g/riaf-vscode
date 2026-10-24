/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { describe, it } from 'vitest';
import { DEFAULT_MAX_READONLY_CALLS } from '../src/agentLoopLimits.js';
import {
	buildExplorationBudgetHint,
	buildRepeatReadHint,
	createReadOnlyCallCounts,
	trackReadOnlyCall,
} from '../src/agentReadHints.js';

describe('Trove - agentReadHints', () => {

	it('buildRepeatReadHint is empty until threshold', () => {
		const counts = createReadOnlyCallCounts();
		assert.strictEqual(buildRepeatReadHint(counts), '');
		trackReadOnlyCall(counts, 'read_file', { uri: '/proj/a.ts' });
		assert.strictEqual(buildRepeatReadHint(counts), '');
		trackReadOnlyCall(counts, 'read_file', { uri: '/proj/a.ts' });
		const hint = buildRepeatReadHint(counts);
		assert.ok(hint.includes('read_file'));
		assert.ok(hint.includes('already ran'));
	});

	it('buildExplorationBudgetHint appears at budget', () => {
		const counts = createReadOnlyCallCounts();
		for (let i = 0; i < DEFAULT_MAX_READONLY_CALLS - 1; i++) {
			trackReadOnlyCall(counts, 'search_codebase', { query: `q${i}` });
		}
		assert.strictEqual(buildExplorationBudgetHint(counts), '');
		trackReadOnlyCall(counts, 'search_codebase', { query: 'final' });
		const hint = buildExplorationBudgetHint(counts);
		assert.ok(hint.includes(`${DEFAULT_MAX_READONLY_CALLS}`));
		assert.ok(hint.includes('Stop exploring'));
	});
});
