/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/** Default hard cap on agent loop iterations (LLM turns) per user message. */
export const DEFAULT_MAX_AGENT_ITERATIONS = 25;

/** Default read-only tool calls before injecting an exploration budget hint. */
export const DEFAULT_MAX_READONLY_CALLS = 12;

/** Default consecutive tool failures before stopping the agent loop. */
export const DEFAULT_MAX_CONSECUTIVE_TOOL_FAILS = 3;

/** Default silence window before aborting a stalled LLM stream. */
export const DEFAULT_LLM_STREAM_STALL_TIMEOUT_MS = 120_000;

/** Large rewrite_file / edit_file tool JSON can take several minutes to stream. */
export const EDIT_LLM_STREAM_STALL_TIMEOUT_MS = 300_000;

/** Extended thinking (budget/effort sliders) can be silent for minutes before text/tool tokens arrive. */
export const REASONING_LLM_STREAM_STALL_TIMEOUT_MS = 600_000;

/** Any streaming tool call (JSON args) can pause between chunks on slow proxies. */
export const TOOL_LLM_STREAM_STALL_TIMEOUT_MS = 300_000;

export type LlmStreamStallTimeoutOpts = {
	editToolStreaming?: boolean;
	toolStreaming?: boolean;
	reasoningEnabled?: boolean;
};

export const getLlmStreamStallTimeoutMs = (
	baseTimeoutMs: number,
	opts: LlmStreamStallTimeoutOpts | boolean = {},
): number => {
	const normalized: LlmStreamStallTimeoutOpts = typeof opts === 'boolean'
		? { editToolStreaming: opts }
		: opts;
	let timeoutMs = baseTimeoutMs;
	if (normalized.reasoningEnabled) {
		timeoutMs = Math.max(timeoutMs, REASONING_LLM_STREAM_STALL_TIMEOUT_MS);
	}
	if (normalized.toolStreaming) {
		timeoutMs = Math.max(timeoutMs, TOOL_LLM_STREAM_STALL_TIMEOUT_MS);
	}
	if (normalized.editToolStreaming) {
		timeoutMs = Math.max(timeoutMs, EDIT_LLM_STREAM_STALL_TIMEOUT_MS);
	}
	return timeoutMs;
};
