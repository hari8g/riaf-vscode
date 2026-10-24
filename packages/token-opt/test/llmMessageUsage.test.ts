/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { describe, it } from 'vitest';
import {
	addUsageToRunTotals,
	emptyAgentRunTokenTotals,
	formatAgentRunTokenSummary,
	usageFromAnthropicResponse,
	usageFromGeminiMetadata,
	usageFromOpenAIResponse,
} from '../src/llmMessageUsage.js';

describe('Trove - llmMessageUsage', () => {

	it('usageFromAnthropicResponse maps cache fields', () => {
		const usage = usageFromAnthropicResponse({
			input_tokens: 10_000,
			output_tokens: 500,
			cache_creation_input_tokens: 8_000,
			cache_read_input_tokens: 2_000,
		});
		assert.deepStrictEqual(usage, {
			inputTokens: 10_000,
			outputTokens: 500,
			cacheReadTokens: 2_000,
			cacheWriteTokens: 8_000,
		});
	});

	it('usageFromOpenAIResponse maps cached_tokens', () => {
		const usage = usageFromOpenAIResponse({
			prompt_tokens: 5_000,
			completion_tokens: 200,
			prompt_tokens_details: { cached_tokens: 4_000 },
		});
		assert.deepStrictEqual(usage, {
			inputTokens: 5_000,
			outputTokens: 200,
			cacheReadTokens: 4_000,
		});
	});

	it('usageFromGeminiMetadata maps cachedContentTokenCount', () => {
		const usage = usageFromGeminiMetadata({
			promptTokenCount: 3_000,
			candidatesTokenCount: 150,
			cachedContentTokenCount: 2_500,
		});
		assert.deepStrictEqual(usage, {
			inputTokens: 3_000,
			outputTokens: 150,
			cacheReadTokens: 2_500,
		});
	});

	it('addUsageToRunTotals and formatAgentRunTokenSummary', () => {
		const totals = emptyAgentRunTokenTotals();
		addUsageToRunTotals(totals, { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 8_000 });
		addUsageToRunTotals(totals, { inputTokens: 10_000, outputTokens: 300, cacheReadTokens: 9_500, cacheWriteTokens: 100 });
		assert.strictEqual(totals.turns, 2);
		assert.strictEqual(totals.totalInputTokens, 20_000);
		assert.strictEqual(totals.totalOutputTokens, 800);
		assert.strictEqual(totals.totalCacheReadTokens, 17_500);
		assert.strictEqual(totals.totalCacheWriteTokens, 100);
		const summary = formatAgentRunTokenSummary(totals);
		assert.ok(summary.includes('turns=2'));
		assert.ok(summary.includes('cache_read_ratio=0.875'));
	});

	it('usage parsers return undefined for missing usage', () => {
		assert.strictEqual(usageFromAnthropicResponse(undefined), undefined);
		assert.strictEqual(usageFromOpenAIResponse(null), undefined);
		assert.strictEqual(usageFromGeminiMetadata(undefined), undefined);
	});
});
