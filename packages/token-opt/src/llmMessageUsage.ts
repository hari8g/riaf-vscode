/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/** Normalized token usage from any LLM provider path. */
export type LLMMessageUsage = {
	inputTokens: number;
	outputTokens: number;
	/** Anthropic cache_read_input_tokens, OpenAI cached_tokens, Gemini cachedContentTokenCount */
	cacheReadTokens: number;
	/** Anthropic cache_creation_input_tokens only */
	cacheWriteTokens?: number;
};

export type AgentRunTokenTotals = {
	turns: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
};

export const emptyAgentRunTokenTotals = (): AgentRunTokenTotals => ({
	turns: 0,
	totalInputTokens: 0,
	totalOutputTokens: 0,
	totalCacheReadTokens: 0,
	totalCacheWriteTokens: 0,
});

export const addUsageToRunTotals = (totals: AgentRunTokenTotals, usage: LLMMessageUsage | undefined): void => {
	if (!usage) {
		return;
	}
	totals.turns += 1;
	totals.totalInputTokens += usage.inputTokens;
	totals.totalOutputTokens += usage.outputTokens;
	totals.totalCacheReadTokens += usage.cacheReadTokens;
	totals.totalCacheWriteTokens += usage.cacheWriteTokens ?? 0;
};

export const formatAgentRunTokenSummary = (totals: AgentRunTokenTotals): string => {
	const cacheReadRatio = totals.totalInputTokens > 0
		? totals.totalCacheReadTokens / totals.totalInputTokens
		: 0;
	return `[Trove agent token usage] turns=${totals.turns} input=${totals.totalInputTokens} output=${totals.totalOutputTokens} cache_read=${totals.totalCacheReadTokens} cache_read_ratio=${cacheReadRatio.toFixed(3)}`;
};

type AnthropicUsage = {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
	cache_read_input_tokens?: number | null;
};

type OpenAIUsage = {
	prompt_tokens?: number;
	completion_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number };
};

type GeminiUsageMetadata = {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	cachedContentTokenCount?: number;
};

export const usageFromAnthropicResponse = (usage: AnthropicUsage | null | undefined): LLMMessageUsage | undefined => {
	if (!usage) {
		return undefined;
	}
	return {
		inputTokens: usage.input_tokens ?? 0,
		outputTokens: usage.output_tokens ?? 0,
		cacheReadTokens: usage.cache_read_input_tokens ?? 0,
		cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
	};
};

export const usageFromOpenAIResponse = (usage: OpenAIUsage | null | undefined): LLMMessageUsage | undefined => {
	if (!usage) {
		return undefined;
	}
	return {
		inputTokens: usage.prompt_tokens ?? 0,
		outputTokens: usage.completion_tokens ?? 0,
		cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
	};
};

export const usageFromGeminiMetadata = (usageMetadata: GeminiUsageMetadata | null | undefined): LLMMessageUsage | undefined => {
	if (!usageMetadata) {
		return undefined;
	}
	return {
		inputTokens: usageMetadata.promptTokenCount ?? 0,
		outputTokens: usageMetadata.candidatesTokenCount ?? 0,
		cacheReadTokens: usageMetadata.cachedContentTokenCount ?? 0,
	};
};
