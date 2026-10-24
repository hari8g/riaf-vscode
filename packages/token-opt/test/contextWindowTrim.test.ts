/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { describe, it } from 'vitest';
import { ChatMessage } from '../src/types.js';
import {
	estimateChatHistoryTokens,
	estimateTokens,
	getProtectedTailStartIndex,
	sanitizeToolMessagePairing,
	trimChatMessagesForContextWindow,
} from '../src/contextWindowTrim.js';

describe('Trove - contextWindowTrim', () => {

	it('estimateTokens uses length / 4', () => {
		assert.strictEqual(estimateTokens('abcd'), 1);
		assert.strictEqual(estimateTokens('abcdefgh'), 2);
	});

	it('getProtectedTailStartIndex preserves last two user turns', () => {
		const messages: ChatMessage[] = [
			{ role: 'user', content: 'a', displayContent: 'a', selections: null, state: { stagingSelections: [], isBeingEdited: false } },
			{ role: 'assistant', displayContent: 'b', reasoning: '', anthropicReasoning: null },
			{ role: 'user', content: 'c', displayContent: 'c', selections: null, state: { stagingSelections: [], isBeingEdited: false } },
			{ role: 'assistant', displayContent: 'd', reasoning: '', anthropicReasoning: null },
		];
		assert.strictEqual(getProtectedTailStartIndex(messages), 0);
	});

	it('trimChatMessagesForContextWindow removes oldest assistant/tool messages first', () => {
		const oldAssistant: ChatMessage = { role: 'assistant', displayContent: 'x'.repeat(4000), reasoning: '', anthropicReasoning: null };
		const user1: ChatMessage = { role: 'user', content: 'first', displayContent: 'first', selections: null, state: { stagingSelections: [], isBeingEdited: false } };
		const user2: ChatMessage = { role: 'user', content: 'second', displayContent: 'second', selections: null, state: { stagingSelections: [], isBeingEdited: false } };
		const recentAssistant: ChatMessage = { role: 'assistant', displayContent: 'recent', reasoning: '', anthropicReasoning: null };

		const chatMessages: ChatMessage[] = [oldAssistant, user1, user2, recentAssistant];
		const { messages, contextWasTrimmed } = trimChatMessagesForContextWindow({
			chatMessages,
			systemMessage: 'system',
			aiInstructions: '',
			contextWindow: 800,
		});

		assert.strictEqual(contextWasTrimmed, true);
		assert.ok(!messages.includes(oldAssistant));
		assert.ok(messages.includes(user1));
		assert.ok(messages.includes(user2));
		assert.ok(messages.includes(recentAssistant));
	});

	it('trimChatMessagesForContextWindow keeps checkpoints and does not trim under budget', () => {
		const messages: ChatMessage[] = [
			{ role: 'checkpoint', type: 'user_edit', voidFileSnapshotOfURI: {}, userModifications: { voidFileSnapshotOfURI: {} } },
			{ role: 'user', content: 'hi', displayContent: 'hi', selections: null, state: { stagingSelections: [], isBeingEdited: false } },
		];
		const result = trimChatMessagesForContextWindow({
			chatMessages: messages,
			systemMessage: 'sys',
			aiInstructions: '',
			contextWindow: 128_000,
		});
		assert.strictEqual(result.contextWasTrimmed, false);
		assert.strictEqual(result.messages.length, 2);
		assert.strictEqual(estimateChatHistoryTokens({
			chatMessages: result.messages,
			systemMessage: 'sys',
			aiInstructions: '',
		}), estimateChatHistoryTokens({
			chatMessages: messages,
			systemMessage: 'sys',
			aiInstructions: '',
		}));
	});

	it('sanitizeToolMessagePairing removes orphaned tool messages', () => {
		const user: ChatMessage = { role: 'user', content: 'hi', displayContent: 'hi', selections: null, state: { stagingSelections: [], isBeingEdited: false } };
		const tool: ChatMessage = {
			role: 'tool',
			type: 'success',
			name: 'read_file',
			params: { uri: null as any, startLine: null, endLine: null, pageNumber: 1 },
			content: 'file contents',
			result: null as any,
			id: 't1',
			rawParams: {},
			mcpServerName: undefined,
		};
		const sanitized = sanitizeToolMessagePairing([user, tool]);
		assert.strictEqual(sanitized.length, 1);
		assert.strictEqual(sanitized[0].role, 'user');
	});
});
