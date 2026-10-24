/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ProviderName } from './types.js';

export const isAnthropicRoutedModel = (providerName: ProviderName, modelName: string): boolean => {
	const lower = modelName.toLowerCase();
	if (!lower.includes('claude')) {
		return false;
	}
	return providerName === 'openRouter'
		|| providerName === 'awsBedrock'
		|| providerName === 'liteLLM'
		|| providerName === 'microsoftAzure';
};

type OpenAIWireMessage = { role: string; content?: unknown };

/** OpenRouter/Bedrock Claude over the OpenAI wire format needs system content blocks with cache_control. */
export const applyRoutedAnthropicPromptCache = (
	messages: OpenAIWireMessage[],
	separateSystemMessage: string | undefined,
	enablePromptCache: boolean,
	providerName: ProviderName,
	modelName: string,
	volatileSystemMessage?: string,
): OpenAIWireMessage[] => {
	if (!enablePromptCache || !isAnthropicRoutedModel(providerName, modelName)) {
		return messages;
	}

	const result = [...messages];
	const cacheBlock = (text: string) => ([{
		type: 'text',
		text,
		cache_control: { type: 'ephemeral' } as const,
	}]);

	if (separateSystemMessage || volatileSystemMessage) {
		const content: { type: string; text: string; cache_control?: { type: 'ephemeral' } }[] = [];
		if (separateSystemMessage) {
			content.push(...cacheBlock(separateSystemMessage));
		}
		if (volatileSystemMessage) {
			content.push({ type: 'text', text: volatileSystemMessage });
		}
		result.unshift({ role: 'system', content });
		return result;
	}

	if (result[0]?.role === 'system' && typeof result[0].content === 'string') {
		result[0] = { role: 'system', content: cacheBlock(result[0].content) };
	}

	return result;
};

/**
 * For routed Anthropic Claude models (OpenRouter/Bedrock/LiteLLM/Azure),
 * adds conversation-level cache breakpoints using the same 2-breakpoint strategy
 * as the native Anthropic path.
 */
export const applyRoutedAnthropicConversationCache = (
	messages: OpenAIWireMessage[],
	enablePromptCache: boolean,
	providerName: ProviderName,
	modelName: string,
): OpenAIWireMessage[] => {
	if (!enablePromptCache || !isAnthropicRoutedModel(providerName, modelName)) {
		return messages;
	}

	const userIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === 'user') {
			userIndices.push(i);
		}
	}

	if (userIndices.length < 3) {
		return messages;
	}

	const bp4Idx = userIndices[userIndices.length - 2];
	const midpoint = Math.floor((userIndices.length - 2) / 2);
	const bp3Idx = userIndices[midpoint];
	const targets = bp3Idx !== bp4Idx ? [bp3Idx, bp4Idx] : [bp4Idx];

	const result = [...messages];

	for (const targetIdx of targets) {
		const msg = result[targetIdx];
		if (typeof msg.content === 'string') {
			result[targetIdx] = {
				...msg,
				content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } as const }],
			};
		} else if (Array.isArray(msg.content) && msg.content.length > 0) {
			const blocks = [...(msg.content as Record<string, unknown>[])];
			blocks[blocks.length - 1] = {
				...blocks[blocks.length - 1],
				cache_control: { type: 'ephemeral' } as const,
			};
			result[targetIdx] = { ...msg, content: blocks };
		}
	}

	return result;
};
