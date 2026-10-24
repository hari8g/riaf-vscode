/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { describe, it } from 'vitest';
import {
	AGENT_ANTHROPIC_OUTPUT_TOKENS,
	getAnthropicBetaHeaders,
	getEffectiveMaxOutputTokens,
	isLikelyOutputTruncated,
} from '../src/agentOutputTokenLimits.js';

describe('Trove - agentOutputTokenLimits', () => {

	it('getEffectiveMaxOutputTokens bumps anthropic agent output', () => {
		assert.strictEqual(getEffectiveMaxOutputTokens('anthropic', 'agent', 8192), AGENT_ANTHROPIC_OUTPUT_TOKENS);
		assert.strictEqual(getEffectiveMaxOutputTokens('anthropic', 'gather', 8192), 8192);
	});

	it('getAnthropicBetaHeaders includes extended output for agent', () => {
		const beta = getAnthropicBetaHeaders({ chatMode: 'agent' });
		assert.ok(beta?.includes('output-128k-2025-02-19'));
		assert.strictEqual(beta?.includes('prompt-caching-2024-07-31'), false);
	});

	it('isLikelyOutputTruncated detects output at cap', () => {
		assert.strictEqual(isLikelyOutputTruncated(8192, 8192), true);
		assert.strictEqual(isLikelyOutputTruncated(4000, 8192), false);
	});
});
