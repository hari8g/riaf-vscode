/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { ProviderName } from './types.js';
import type { LLMMessageUsage } from './llmMessageUsage.js';

export interface ModelPricing {
	inputPer1M: number;
	outputPer1M: number;
	cacheReadPer1M: number;
	cacheWritePer1M: number;
}

const PRICING: Partial<Record<ProviderName, Record<string, ModelPricing>>> = {
	anthropic: {
		'claude-opus-4-8': { inputPer1M: 15.00, outputPer1M: 75.00, cacheReadPer1M: 1.50, cacheWritePer1M: 18.75 },
		'claude-opus-4-7': { inputPer1M: 15.00, outputPer1M: 75.00, cacheReadPer1M: 1.50, cacheWritePer1M: 18.75 },
		'claude-sonnet-4-6': { inputPer1M: 3.00, outputPer1M: 15.00, cacheReadPer1M: 0.30, cacheWritePer1M: 3.75 },
		'claude-haiku-4-5': { inputPer1M: 0.80, outputPer1M: 4.00, cacheReadPer1M: 0.08, cacheWritePer1M: 1.00 },
	},
	openAI: {
		'gpt-5.5': { inputPer1M: 5.00, outputPer1M: 20.00, cacheReadPer1M: 2.50, cacheWritePer1M: 0 },
		'gpt-5.4': { inputPer1M: 5.00, outputPer1M: 20.00, cacheReadPer1M: 2.50, cacheWritePer1M: 0 },
		'gpt-5.4-mini': { inputPer1M: 0.15, outputPer1M: 0.60, cacheReadPer1M: 0.075, cacheWritePer1M: 0 },
		'gpt-5.3-chat-latest': { inputPer1M: 5.00, outputPer1M: 20.00, cacheReadPer1M: 2.50, cacheWritePer1M: 0 },
	},
	gemini: {
		'gemini-2.5-pro-preview-05-06': { inputPer1M: 1.25, outputPer1M: 10.00, cacheReadPer1M: 0.31, cacheWritePer1M: 0 },
		'gemini-2.5-flash-preview-04-17': { inputPer1M: 0.075, outputPer1M: 0.30, cacheReadPer1M: 0.018, cacheWritePer1M: 0 },
		'gemini-2.0-flash': { inputPer1M: 0.10, outputPer1M: 0.40, cacheReadPer1M: 0.025, cacheWritePer1M: 0 },
		'gemini-2.0-flash-lite': { inputPer1M: 0.075, outputPer1M: 0.30, cacheReadPer1M: 0.018, cacheWritePer1M: 0 },
	},
	deepseek: {
		'deepseek-chat': { inputPer1M: 0.14, outputPer1M: 0.28, cacheReadPer1M: 0.014, cacheWritePer1M: 0 },
		'deepseek-reasoner': { inputPer1M: 0.55, outputPer1M: 2.19, cacheReadPer1M: 0.055, cacheWritePer1M: 0 },
	},
	groq: {
		'qwen-qwq-32b': { inputPer1M: 0.29, outputPer1M: 0.39, cacheReadPer1M: 0, cacheWritePer1M: 0 },
		'llama-3.3-70b-versatile': { inputPer1M: 0.59, outputPer1M: 0.79, cacheReadPer1M: 0, cacheWritePer1M: 0 },
		'llama-3.1-8b-instant': { inputPer1M: 0.05, outputPer1M: 0.08, cacheReadPer1M: 0, cacheWritePer1M: 0 },
	},
	mistral: {
		'codestral-latest': { inputPer1M: 0.30, outputPer1M: 0.90, cacheReadPer1M: 0, cacheWritePer1M: 0 },
		'mistral-large-latest': { inputPer1M: 2.00, outputPer1M: 6.00, cacheReadPer1M: 0, cacheWritePer1M: 0 },
		'devstral-small-latest': { inputPer1M: 0.10, outputPer1M: 0.30, cacheReadPer1M: 0, cacheWritePer1M: 0 },
		'ministral-8b-latest': { inputPer1M: 0.10, outputPer1M: 0.10, cacheReadPer1M: 0, cacheWritePer1M: 0 },
	},
	xAI: {
		'grok-3': { inputPer1M: 3.00, outputPer1M: 15.00, cacheReadPer1M: 0, cacheWritePer1M: 0 },
		'grok-3-mini': { inputPer1M: 0.30, outputPer1M: 0.50, cacheReadPer1M: 0, cacheWritePer1M: 0 },
		'grok-3-fast': { inputPer1M: 5.00, outputPer1M: 25.00, cacheReadPer1M: 0, cacheWritePer1M: 0 },
		'grok-2': { inputPer1M: 2.00, outputPer1M: 10.00, cacheReadPer1M: 0, cacheWritePer1M: 0 },
	},
	openRouter: {},
	ollama: {},
	vLLM: {},
	lmStudio: {},
	liteLLM: {},
	openAICompatible: {},
	googleVertex: {},
	microsoftAzure: {},
	awsBedrock: {},
};

export const getModelPricing = (
	providerName: ProviderName,
	modelName: string,
): ModelPricing | null => {
	const table = PRICING[providerName];
	if (!table) {
		return null;
	}

	if (modelName in table) {
		return table[modelName];
	}

	for (const [key, pricing] of Object.entries(table)) {
		if (modelName.startsWith(key)) {
			return pricing;
		}
	}

	return null;
};

export const calculateTurnCostUSD = (
	usage: LLMMessageUsage,
	providerName: ProviderName,
	modelName: string,
): number => {
	const pricing = getModelPricing(providerName, modelName);
	if (!pricing) {
		return 0;
	}

	return (
		(usage.inputTokens / 1_000_000) * pricing.inputPer1M +
		(usage.outputTokens / 1_000_000) * pricing.outputPer1M +
		(usage.cacheReadTokens / 1_000_000) * pricing.cacheReadPer1M +
		((usage.cacheWriteTokens ?? 0) / 1_000_000) * pricing.cacheWritePer1M
	);
};

export const hasKnownPricing = (providerName: ProviderName): boolean => {
	const table = PRICING[providerName];
	return table !== undefined && Object.keys(table).length > 0;
};

export const PRICING_TABLE_DATE = '2026-06-18';
