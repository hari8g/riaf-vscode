/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { describe, it } from 'vitest';
import { defaultGlobalSettings } from '../src/types.js';
import { getAgentLoopLimits } from '../src/agentLoopSettings.js';
import {
	EDIT_LLM_STREAM_STALL_TIMEOUT_MS,
	REASONING_LLM_STREAM_STALL_TIMEOUT_MS,
	TOOL_LLM_STREAM_STALL_TIMEOUT_MS,
	getLlmStreamStallTimeoutMs,
} from '../src/agentLoopLimits.js';

describe('Trove - agentLoopSettings', () => {

	it('getAgentLoopLimits returns defaults', () => {
		const limits = getAgentLoopLimits(defaultGlobalSettings);
		assert.strictEqual(limits.maxAgentIterations, 25);
		assert.strictEqual(limits.maxReadOnlyCalls, 12);
		assert.strictEqual(limits.maxConsecutiveToolFails, 3);
		assert.strictEqual(limits.llmStreamStallTimeoutMs, 120_000);
	});

	it('getAgentLoopLimits clamps out-of-range values', () => {
		const limits = getAgentLoopLimits({
			...defaultGlobalSettings,
			maxAgentIterations: 500,
			maxReadOnlyCalls: 0,
			llmStreamStallTimeoutMs: 1_000,
		});
		assert.strictEqual(limits.maxAgentIterations, 100);
		assert.strictEqual(limits.maxReadOnlyCalls, 1);
		assert.strictEqual(limits.llmStreamStallTimeoutMs, 10_000);
	});

	it('getLlmStreamStallTimeoutMs extends timeout while edit tool is streaming', () => {
		assert.strictEqual(getLlmStreamStallTimeoutMs(120_000, { editToolStreaming: false }), 120_000);
		assert.strictEqual(getLlmStreamStallTimeoutMs(120_000, { editToolStreaming: true }), EDIT_LLM_STREAM_STALL_TIMEOUT_MS);
	});

	it('getLlmStreamStallTimeoutMs extends timeout for reasoning and tool streaming', () => {
		assert.strictEqual(getLlmStreamStallTimeoutMs(120_000, { reasoningEnabled: true }), REASONING_LLM_STREAM_STALL_TIMEOUT_MS);
		assert.strictEqual(getLlmStreamStallTimeoutMs(120_000, { toolStreaming: true }), TOOL_LLM_STREAM_STALL_TIMEOUT_MS);
		assert.strictEqual(getLlmStreamStallTimeoutMs(120_000, true), EDIT_LLM_STREAM_STALL_TIMEOUT_MS);
	});
});
