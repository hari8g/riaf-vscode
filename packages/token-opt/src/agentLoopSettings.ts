/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { GlobalSettings } from './types.js';
import { getEffectiveMaxReadOnlyCalls } from './lightAgent.js';
import {
	DEFAULT_LLM_STREAM_STALL_TIMEOUT_MS,
	DEFAULT_MAX_AGENT_ITERATIONS,
	DEFAULT_MAX_CONSECUTIVE_TOOL_FAILS,
	DEFAULT_MAX_READONLY_CALLS,
} from './agentLoopLimits.js';

export type AgentLoopLimits = {
	maxAgentIterations: number;
	maxReadOnlyCalls: number;
	maxConsecutiveToolFails: number;
	llmStreamStallTimeoutMs: number;
};

const clamp = (value: number, min: number, max: number): number => {
	if (!Number.isFinite(value)) {
		return min;
	}
	return Math.min(max, Math.max(min, Math.round(value)));
};

export const getAgentLoopLimits = (settings: GlobalSettings): AgentLoopLimits => ({
	maxAgentIterations: clamp(settings.maxAgentIterations, 1, 100),
	maxReadOnlyCalls: clamp(getEffectiveMaxReadOnlyCalls(settings), 1, 100),
	maxConsecutiveToolFails: clamp(settings.maxConsecutiveToolFails, 1, 10),
	llmStreamStallTimeoutMs: clamp(settings.llmStreamStallTimeoutMs, 10_000, 300_000),
});

export const agentLoopLimitDefaults = {
	maxAgentIterations: DEFAULT_MAX_AGENT_ITERATIONS,
	maxReadOnlyCalls: DEFAULT_MAX_READONLY_CALLS,
	maxConsecutiveToolFails: DEFAULT_MAX_CONSECUTIVE_TOOL_FAILS,
	llmStreamStallTimeoutMs: DEFAULT_LLM_STREAM_STALL_TIMEOUT_MS,
} as const;
