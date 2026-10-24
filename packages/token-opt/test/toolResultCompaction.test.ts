/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'node:assert';
import { describe, it } from 'vitest';
import { URI } from '../src/shim/vsBase.js';
import { ChatMessage } from '../src/types.js';
import { compactStaleToolResults, isCompactableToolName } from '../src/toolResultCompaction.js';

describe('Trove - toolResultCompaction', () => {

	it('isCompactableToolName identifies read and search tools', () => {
		assert.strictEqual(isCompactableToolName('read_file'), true);
		assert.strictEqual(isCompactableToolName('search_codebase'), true);
		assert.strictEqual(isCompactableToolName('edit_file'), false);
	});

	it('compactStaleToolResults compacts old read_file results', () => {
		const fileUri = URI.file('/proj/foo.ts');
		const messages: ChatMessage[] = [
			{
				role: 'user',
				content: 'first',
				displayContent: 'first',
				selections: null,
				state: { stagingSelections: [], isBeingEdited: false },
			},
			{
				role: 'tool',
				type: 'success',
				name: 'read_file',
				content: 'line1\nline2\nline3',
				id: 't1',
				rawParams: {},
				mcpServerName: undefined,
				compactable: true,
				params: { uri: fileUri, startLine: 1, endLine: 3, pageNumber: 1 },
				result: { fileContents: 'line1\nline2\nline3', totalFileLen: 18, totalNumLines: 3, hasNextPage: false, totalPages: 1 },
			},
			{
				role: 'user',
				content: 'second',
				displayContent: 'second',
				selections: null,
				state: { stagingSelections: [], isBeingEdited: false },
			},
			{
				role: 'user',
				content: 'third',
				displayContent: 'third',
				selections: null,
				state: { stagingSelections: [], isBeingEdited: false },
			},
		];

		const compacted = compactStaleToolResults(messages);
		const tool = compacted[1];
		assert.strictEqual(tool.role, 'tool');
		if (tool.role === 'tool') {
			assert.ok(tool.content.includes('read_file('));
			assert.ok(tool.content.includes('re-read if needed'));
			assert.ok(!tool.content.includes('line1'));
		}
	});

	it('compactStaleToolResults compacts older read_file results within a single agent turn', () => {
		const fileUri = URI.file('/proj/style.css');
		const bigContent = 'line\n'.repeat(200);
		const messages: ChatMessage[] = [
			{
				role: 'user',
				content: 'theme it',
				displayContent: 'theme it',
				selections: null,
				state: { stagingSelections: [], isBeingEdited: false },
			},
			{
				role: 'tool',
				type: 'success',
				name: 'read_file',
				content: bigContent,
				id: 't1',
				rawParams: {},
				mcpServerName: undefined,
				compactable: true,
				params: { uri: fileUri, startLine: 1, endLine: 200, pageNumber: 1 },
				result: { fileContents: bigContent, totalFileLen: bigContent.length, totalNumLines: 200, hasNextPage: false, totalPages: 1 },
			},
			{
				role: 'tool',
				type: 'success',
				name: 'read_file',
				content: bigContent,
				id: 't2',
				rawParams: {},
				mcpServerName: undefined,
				compactable: true,
				params: { uri: fileUri, startLine: 1, endLine: 200, pageNumber: 1 },
				result: { fileContents: bigContent, totalFileLen: bigContent.length, totalNumLines: 200, hasNextPage: false, totalPages: 1 },
			},
			{
				role: 'tool',
				type: 'success',
				name: 'read_file',
				content: bigContent,
				id: 't3',
				rawParams: {},
				mcpServerName: undefined,
				compactable: true,
				params: { uri: fileUri, startLine: 1, endLine: 200, pageNumber: 1 },
				result: { fileContents: bigContent, totalFileLen: bigContent.length, totalNumLines: 200, hasNextPage: false, totalPages: 1 },
			},
		];

		const compacted = compactStaleToolResults(messages);
		const firstRead = compacted[1];
		const lastRead = compacted[3];
		assert.strictEqual(firstRead.role, 'tool');
		assert.strictEqual(lastRead.role, 'tool');
		if (firstRead.role === 'tool' && lastRead.role === 'tool') {
			assert.ok(!firstRead.content.includes('line\nline'));
			assert.ok(lastRead.content.includes('line\nline'));
		}
	});

	it('compactStaleToolResults keeps only latest read per file in agent turn', () => {
		const clockUri = URI.file('/proj/clock.js');
		const otherUri = URI.file('/proj/other.ts');
		const contentA = 'a\n'.repeat(50);
		const contentB = 'b\n'.repeat(50);
		const messages: ChatMessage[] = [
			{
				role: 'user',
				content: 'fix clock',
				displayContent: 'fix clock',
				selections: null,
				state: { stagingSelections: [], isBeingEdited: false },
			},
			{
				role: 'tool',
				type: 'success',
				name: 'read_file',
				content: contentA,
				id: 't1',
				rawParams: {},
				mcpServerName: undefined,
				compactable: true,
				params: { uri: clockUri, startLine: 1, endLine: 120, pageNumber: 1 },
				result: { fileContents: contentA, totalFileLen: contentA.length, totalNumLines: 50, hasNextPage: false, totalPages: 1 },
			},
			{
				role: 'tool',
				type: 'success',
				name: 'read_file',
				content: contentB,
				id: 't2',
				rawParams: {},
				mcpServerName: undefined,
				compactable: true,
				params: { uri: clockUri, startLine: 270, endLine: 380, pageNumber: 1 },
				result: { fileContents: contentB, totalFileLen: contentB.length, totalNumLines: 50, hasNextPage: false, totalPages: 1 },
			},
			{
				role: 'tool',
				type: 'success',
				name: 'read_file',
				content: 'export const x = 1;\n',
				id: 't3',
				rawParams: {},
				mcpServerName: undefined,
				compactable: true,
				params: { uri: otherUri, startLine: 1, endLine: 1, pageNumber: 1 },
				result: { fileContents: 'export const x = 1;\n', totalFileLen: 18, totalNumLines: 1, hasNextPage: false, totalPages: 1 },
			},
		];

		const compacted = compactStaleToolResults(messages);
		const firstClock = compacted[1];
		const secondClock = compacted[2];
		assert.strictEqual(firstClock.role, 'tool');
		assert.strictEqual(secondClock.role, 'tool');
		if (firstClock.role === 'tool' && secondClock.role === 'tool') {
			assert.ok(!firstClock.content.includes('a\na'));
			assert.ok(secondClock.content.includes('b\nb'));
		}
	});
});
