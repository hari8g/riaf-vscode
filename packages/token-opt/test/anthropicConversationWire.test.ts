/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { describe, it } from 'vitest';
import {
	appendAgentTailHintsToMessages,
	ensureAnthropicConversationEndsWithUser,
} from '../src/anthropicConversationWire.js';

describe('Trove - anthropicConversationWire', () => {

	it('appendAgentTailHintsToMessages adds user message when last is assistant', () => {
		const messages = [
			{ role: 'user' as const, content: 'edit style.css' },
			{ role: 'assistant' as const, content: 'I will edit the file.', anthropicReasoning: null },
		];
		appendAgentTailHintsToMessages(messages, '\n\n<agent_hints>MANDATORY edit</agent_hints>');
		assert.strictEqual(messages.length, 3);
		assert.strictEqual(messages[2].role, 'user');
		assert.ok(messages[2].content.includes('MANDATORY edit'));
		assert.strictEqual(messages[1].content, 'I will edit the file.');
	});

	it('appendAgentTailHintsToMessages appends to tool message', () => {
		const messages = [
			{ role: 'assistant' as const, content: '', anthropicReasoning: null },
			{ role: 'tool' as const, content: 'error', id: 't1', name: 'rewrite_file' as const, rawParams: {} },
		];
		appendAgentTailHintsToMessages(messages, '\nhint');
		assert.ok(messages[1].content.endsWith('\nhint'));
	});

	it('ensureAnthropicConversationEndsWithUser appends user continuation', () => {
		const messages = [
			{ role: 'user' as const, content: 'hello' },
			{ role: 'assistant' as const, content: 'hi' },
		];
		ensureAnthropicConversationEndsWithUser(messages);
		assert.strictEqual(messages[messages.length - 1].role, 'user');
	});

	it('tool-only turn keeps empty assistant content for wire pairing', () => {
		const messages = [
			{ role: 'user' as const, content: 'read foo' },
			{ role: 'assistant' as const, content: '', anthropicReasoning: null },
			{ role: 'tool' as const, content: 'file body', id: 't1', name: 'read_file' as const, rawParams: {} },
		];
		appendAgentTailHintsToMessages(messages, '\nhint');
		assert.strictEqual(messages[1].role, 'assistant');
		assert.ok(messages[2].content.endsWith('\nhint'));
	});
});
