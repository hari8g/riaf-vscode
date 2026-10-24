/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { describe, it } from 'vitest';
import {
	calculateTurnCostUSD,
	getModelPricing,
	hasKnownPricing,
} from '../src/llmPricing.js';

describe('Trove - llmPricing', () => {

	it('calculateTurnCostUSD returns 0 for Ollama', () => {
		const cost = calculateTurnCostUSD(
			{ inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0 },
			'ollama',
			'llama3',
		);
		assert.strictEqual(cost, 0);
	});

	it('calculateTurnCostUSD for Claude Sonnet matches guide example', () => {
		const cost = calculateTurnCostUSD(
			{ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 },
			'anthropic',
			'claude-sonnet-4-6',
		);
		assert.ok(Math.abs(cost - 0.0045) < 1e-10);
	});

	it('prefix matching resolves version-suffixed model names', () => {
		const pricing = getModelPricing('anthropic', 'claude-opus-4-8-20250514');
		assert.ok(pricing);
		assert.strictEqual(pricing!.inputPer1M, 15.00);
	});

	it('hasKnownPricing distinguishes self-hosted from cloud providers', () => {
		assert.strictEqual(hasKnownPricing('ollama'), false);
		assert.strictEqual(hasKnownPricing('anthropic'), true);
	});

	it('unknown model on known provider returns 0 cost', () => {
		const cost = calculateTurnCostUSD(
			{ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 },
			'anthropic',
			'unknown-model-xyz',
		);
		assert.strictEqual(cost, 0);
	});
});
