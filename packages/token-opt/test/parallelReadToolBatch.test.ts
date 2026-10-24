/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { describe, it } from 'vitest';
import {
	buildReadToolBatch,
	discoverAdditionalReadTools,
	isReadOnlyBatchTool,
	parseDiscoveryToolLines,
	toolCallDedupKey,
} from '../src/parallelReadToolBatch.js';
import type { RawToolCallObj } from '../src/types.js';

describe('Trove - parallelReadToolBatch', () => {

	it('isReadOnlyBatchTool identifies read-only builtins', () => {
		assert.strictEqual(isReadOnlyBatchTool('read_file'), true);
		assert.strictEqual(isReadOnlyBatchTool('search_codebase'), true);
		assert.strictEqual(isReadOnlyBatchTool('edit_file'), false);
		assert.strictEqual(isReadOnlyBatchTool('run_command'), false);
	});

	it('parseDiscoveryToolLines parses JSON lines and stops at DONE', () => {
		const text = [
			'{"name":"read_file","rawParams":{"uri":"src/a.ts"}}',
			'{"name":"search_codebase","rawParams":{"query":"auth flow"}}',
			'DONE',
			'{"name":"read_file","rawParams":{"uri":"src/b.ts"}}',
		].join('\n');

		const parsed = parseDiscoveryToolLines(text);
		assert.strictEqual(parsed.length, 2);
		assert.strictEqual(parsed[0].name, 'read_file');
		assert.strictEqual(parsed[1].name, 'search_codebase');
	});

	it('parseDiscoveryToolLines skips destructive tools', () => {
		const parsed = parseDiscoveryToolLines('{"name":"edit_file","rawParams":{"uri":"x.ts","search_replace_blocks":""}}');
		assert.strictEqual(parsed.length, 0);
	});

	it('buildReadToolBatch deduplicates primary and additional', () => {
		const primary: RawToolCallObj = {
			name: 'read_file',
			rawParams: { uri: 'src/a.ts' },
			doneParams: ['uri'],
			id: '1',
			isDone: true,
		};
		const additional: RawToolCallObj[] = [{
			name: 'read_file',
			rawParams: { uri: 'src/a.ts' },
			doneParams: ['uri'],
			id: '2',
			isDone: true,
		}, {
			name: 'read_file',
			rawParams: { uri: 'src/b.ts' },
			doneParams: ['uri'],
			id: '3',
			isDone: true,
		}];

		const batch = buildReadToolBatch(primary, additional);
		assert.strictEqual(batch.length, 2);
		assert.strictEqual(toolCallDedupKey(batch[0].name, batch[0].rawParams), toolCallDedupKey('read_file', { uri: 'src/a.ts' }));
	});

	it('discoverAdditionalReadTools parses LLM discovery output', async () => {
		const primary: RawToolCallObj = {
			name: 'read_file',
			rawParams: { uri: 'src/a.ts' },
			doneParams: ['uri'],
			id: '1',
			isDone: true,
		};

		const additional = await discoverAdditionalReadTools({
			callLLM: async () => ({ text: '{"name":"read_file","rawParams":{"uri":"src/b.ts"}}\nDONE' }),
			modelSelection: { providerName: 'anthropic', modelName: 'claude-sonnet-4-6' },
			modelSelectionOptions: undefined,
			overridesOfModel: undefined,
			chatMode: 'agent',
			primaryToolCall: primary,
			recentMessages: [{ role: 'user', content: 'Find auth flow', displayContent: 'Find auth flow' }],
			excludeKeys: new Set([toolCallDedupKey(primary.name, primary.rawParams)]),
		});

		assert.strictEqual(additional.length, 1);
		assert.strictEqual(additional[0].name, 'read_file');
		assert.strictEqual(additional[0].rawParams.uri, 'src/b.ts');
	});

	it('discoverAdditionalReadTools rejects when discovery LLM fails', async () => {
		const primary: RawToolCallObj = {
			name: 'search_codebase',
			rawParams: { query: 'auth' },
			doneParams: ['query'],
			id: '1',
			isDone: true,
		};

		await assert.rejects(
			() => discoverAdditionalReadTools({
				callLLM: async () => { throw new Error('rate limited'); },
				modelSelection: { providerName: 'anthropic', modelName: 'claude-sonnet-4-6' },
				modelSelectionOptions: undefined,
				overridesOfModel: undefined,
				chatMode: 'agent',
				primaryToolCall: primary,
				recentMessages: [{ role: 'user', content: 'Find auth flow' }],
				excludeKeys: new Set([toolCallDedupKey(primary.name, primary.rawParams)]),
			}),
			/rate limited/,
		);
	});

});
