/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { describe, it } from 'vitest';
import {
	isAnthropicRoutedModel,
	applyRoutedAnthropicPromptCache,
	applyRoutedAnthropicConversationCache,
} from '../src/promptCache.js';

describe('Trove - promptCache', () => {

	it('isAnthropicRoutedModel detects Claude via OpenRouter', () => {
		assert.strictEqual(isAnthropicRoutedModel('openRouter', 'anthropic/claude-3.5-sonnet'), true);
		assert.strictEqual(isAnthropicRoutedModel('openAI', 'gpt-4o'), false);
	});

	it('applyRoutedAnthropicPromptCache produces cache_control without ttl', () => {
		const msgs = [{ role: 'user', content: 'hello' }];
		const result = applyRoutedAnthropicPromptCache(
			msgs, 'stable system', true, 'openRouter', 'anthropic/claude-3.5-sonnet',
		);
		const sysMsg = result[0] as { role: string; content: { cache_control: unknown }[] };
		assert.ok(Array.isArray(sysMsg.content));
		const cc = sysMsg.content[0].cache_control as Record<string, unknown>;
		assert.strictEqual(cc['type'], 'ephemeral');
		assert.strictEqual('ttl' in cc, false, 'cache_control must not contain ttl');
	});

	it('applyRoutedAnthropicConversationCache adds breakpoints on second-to-last user msg', () => {
		const msgs = [
			{ role: 'user', content: 'turn 1' },
			{ role: 'assistant', content: 'reply 1' },
			{ role: 'user', content: 'turn 2' },
			{ role: 'assistant', content: 'reply 2' },
			{ role: 'user', content: 'turn 3 (current)' },
		];
		const result = applyRoutedAnthropicConversationCache(
			msgs, true, 'openRouter', 'anthropic/claude-3.5-sonnet',
		);
		const bp4Msg = result[2] as { role: string; content: { cache_control: unknown }[] };
		assert.ok(Array.isArray(bp4Msg.content));
		assert.deepStrictEqual(bp4Msg.content[0].cache_control, { type: 'ephemeral' });
		const lastMsg = result[4] as { role: string; content: string };
		assert.strictEqual(typeof lastMsg.content, 'string',
			'current user turn must remain as plain string (uncached)');
	});

	it('applyRoutedAnthropicConversationCache is no-op when cache disabled', () => {
		const msgs = [
			{ role: 'user', content: 'a' },
			{ role: 'assistant', content: 'b' },
			{ role: 'user', content: 'c' },
			{ role: 'assistant', content: 'd' },
			{ role: 'user', content: 'e' },
		];
		const result = applyRoutedAnthropicConversationCache(
			msgs, false, 'openRouter', 'anthropic/claude-3.5-sonnet',
		);
		assert.strictEqual(result, msgs, 'should return same reference when disabled');
	});

	it('applyRoutedAnthropicConversationCache is no-op for non-Anthropic routed models', () => {
		const msgs = [
			{ role: 'user', content: 'a' },
			{ role: 'assistant', content: 'b' },
			{ role: 'user', content: 'c' },
			{ role: 'assistant', content: 'd' },
			{ role: 'user', content: 'e' },
		];
		const result = applyRoutedAnthropicConversationCache(
			msgs, true, 'openRouter', 'gpt-4o',
		);
		assert.strictEqual(result, msgs);
	});
});
