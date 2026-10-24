/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { AnthropicLLMChatMessage, OpenAILLMChatMessage } from './types.js';
import { ToolName } from './types.js';
import { RawToolParamsObj } from './types.js';

export const EMPTY_ANTHROPIC_CONTINUATION = '(continue)';

type SimpleLLMMessage = {
	role: 'tool';
	content: string;
	id: string;
	name: ToolName;
	rawParams: RawToolParamsObj;
} | {
	role: 'user';
	content: string;
} | {
	role: 'assistant';
	content: string;
	anthropicReasoning: unknown;
};

type AnthropicOrOpenAILLMMessage = AnthropicLLMChatMessage | OpenAILLMChatMessage;

/** Anthropic requires the final message to be role=user (no assistant prefill on most models). */
export const ensureAnthropicConversationEndsWithUser = (messages: AnthropicOrOpenAILLMMessage[]): void => {
	if (messages.length === 0) {
		return;
	}
	const last = messages[messages.length - 1];
	if (last.role === 'assistant') {
		messages.push({ role: 'user', content: EMPTY_ANTHROPIC_CONTINUATION });
	}
};

/** Append agent hints without ending on an assistant message (Anthropic prefill error). */
export const appendAgentTailHintsToMessages = (messages: SimpleLLMMessage[], hints: string | undefined): void => {
	if (!hints?.trim() || messages.length === 0) {
		return;
	}
	const last = messages[messages.length - 1];
	if (last.role === 'assistant') {
		messages.push({ role: 'user', content: hints });
		return;
	}
	last.content = last.content + hints;
};
