/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ChatMessage } from './types.js';
import type { ChatMode } from './types.js';
import { getAgentInputTokenCap } from './llmRateLimit.js';

export const CONTEXT_WINDOW_USE_RATIO = 0.85;
export const AGGRESSIVE_CONTEXT_WINDOW_USE_RATIO = 0.70;
/** Extra-tight ratio when agent hits provider TPM caps or retries after rate limit. */
export const TPM_CAP_CONTEXT_WINDOW_USE_RATIO = 0.55;

export const getAgentEffectiveContextWindow = (opts: {
	chatMode: ChatMode;
	providerName: string;
	contextWindow: number;
	forceAggressiveTrim?: boolean;
}): number => {
	const cap = opts.chatMode === 'agent' ? getAgentInputTokenCap(opts.providerName) : undefined;
	if (!cap) {
		return opts.contextWindow;
	}
	return Math.min(opts.contextWindow, cap);
};

/** Fast token estimate — ~4 characters per token. */
export const estimateTokens = (text: string | null | undefined): number => {
	if (!text) {
		return 0;
	}
	return Math.ceil(text.length / 4);
};

const isRemovableMessage = (message: ChatMessage): boolean => {
	return message.role === 'assistant' || message.role === 'tool' || message.role === 'interrupted_streaming_tool';
};

export const estimateChatMessageTokens = (message: ChatMessage): number => {
	if (message.role === 'checkpoint') {
		return 0;
	}
	if (message.role === 'assistant') {
		return estimateTokens(message.displayContent) + estimateTokens(message.reasoning);
	}
	if (message.role === 'user') {
		return estimateTokens(message.content);
	}
	if (message.role === 'tool') {
		return estimateTokens(message.content);
	}
	if (message.role === 'interrupted_streaming_tool') {
		return estimateTokens(message.name);
	}
	return 0;
};

export const estimateChatHistoryTokens = (opts: {
	chatMessages: ChatMessage[];
	systemMessage: string;
	aiInstructions: string;
}): number => {
	let total = estimateTokens(opts.systemMessage) + estimateTokens(opts.aiInstructions);
	for (const message of opts.chatMessages) {
		total += estimateChatMessageTokens(message);
	}
	return total;
};

/** Index from which the last two user turns (and everything after) are preserved. */
export const getProtectedTailStartIndex = (chatMessages: ChatMessage[]): number => {
	const userIndices: number[] = [];
	for (let i = 0; i < chatMessages.length; i++) {
		if (chatMessages[i].role === 'user') {
			userIndices.push(i);
		}
	}
	if (userIndices.length >= 2) {
		return userIndices[userIndices.length - 2];
	}
	if (userIndices.length === 1) {
		return userIndices[0];
	}
	return chatMessages.length;
};

/**
 * Remove oldest non-user, non-checkpoint messages from the prefix of history until
 * the estimated token count fits within contextWindow * 0.85.
 */
export const trimChatMessagesForContextWindow = (opts: {
	chatMessages: ChatMessage[];
	systemMessage: string;
	aiInstructions: string;
	contextWindow: number;
	forceAggressiveTrim?: boolean;
}): { messages: ChatMessage[]; contextWasTrimmed: boolean } => {
	const useRatio = opts.forceAggressiveTrim
		? (opts.contextWindow <= 25_000 ? TPM_CAP_CONTEXT_WINDOW_USE_RATIO : AGGRESSIVE_CONTEXT_WINDOW_USE_RATIO)
		: CONTEXT_WINDOW_USE_RATIO;
	const tokenBudget = Math.floor(opts.contextWindow * useRatio);
	const messages = [...opts.chatMessages];

	if (estimateChatHistoryTokens({ ...opts, chatMessages: messages }) <= tokenBudget) {
		return { messages, contextWasTrimmed: false };
	}

	const tailStart = getProtectedTailStartIndex(messages);
	const removableIndices = messages
		.map((message, index) => ({ message, index }))
		.filter(({ message, index }) => index < tailStart && isRemovableMessage(message))
		.map(({ index }) => index);

	const indicesToRemove = new Set<number>();
	for (const index of removableIndices) {
		if (estimateChatHistoryTokens({
			chatMessages: messages.filter((_, i) => !indicesToRemove.has(i)),
			systemMessage: opts.systemMessage,
			aiInstructions: opts.aiInstructions,
		}) <= tokenBudget) {
			break;
		}
		indicesToRemove.add(index);
	}

	if (indicesToRemove.size === 0) {
		return { messages, contextWasTrimmed: false };
	}

	return {
		messages: sanitizeToolMessagePairing(messages.filter((_, index) => !indicesToRemove.has(index))),
		contextWasTrimmed: true,
	};
};

/** Drop tool messages that no longer have a preceding assistant in the same turn. */
export const sanitizeToolMessagePairing = (chatMessages: ChatMessage[]): ChatMessage[] => {
	const result: ChatMessage[] = [];

	for (const message of chatMessages) {
		if (message.role !== 'tool') {
			result.push(message);
			continue;
		}

		let hasAssistant = false;
		for (let j = result.length - 1; j >= 0; j--) {
			const prev = result[j];
			if (prev.role === 'assistant') {
				hasAssistant = true;
				break;
			}
			if (prev.role === 'user') {
				break;
			}
		}

		if (hasAssistant) {
			result.push(message);
		}
	}

	return result;
};
