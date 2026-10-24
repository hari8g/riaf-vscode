import assert from 'node:assert';
import { describe, it } from 'vitest';
import { URI } from '../src/shim/vsBase.js';
import type { ChatMessage, FileReadRecord } from '../src/types.js';
import { prepareMessagesForModel } from '../src/budget.js';
import { readFileUriKey, trackFileRead } from '../src/fileReadDedup.js';

const user = (content: string): ChatMessage => ({
	role: 'user',
	content,
	displayContent: content,
	selections: null,
	state: { stagingSelections: [], isBeingEdited: false },
});

const assistant = (text: string): ChatMessage => ({
	role: 'assistant',
	displayContent: text,
	reasoning: '',
	anthropicReasoning: null,
});

const readTool = (id: string, path: string, content: string): ChatMessage => ({
	role: 'tool',
	type: 'success',
	name: 'read_file',
	id,
	content,
	rawParams: { uri: path },
	compactable: true,
	params: { uri: URI.file(path), startLine: null, endLine: null, pageNumber: 1 },
	result: { fileContents: content, totalFileLen: content.length, totalNumLines: content.split('\n').length, hasNextPage: false, totalPages: 1 },
	mcpServerName: undefined,
});

describe('token-opt - budget.prepareMessagesForModel', () => {
	it('passes small histories through untouched', () => {
		const messages = [user('hi'), assistant('hello')];
		const result = prepareMessagesForModel({
			messages,
			contextWindow: 200_000,
			reservedOutputTokens: 8_000,
			chatMode: 'normal',
		});
		assert.strictEqual(result.trimmed, false);
		assert.strictEqual(result.compacted, 0);
		assert.strictEqual(result.messages.length, 2);
		assert.ok(result.estimatedTokens > 0);
	});

	it('compacts stale read results, keeps the latest two, and invalidates compacted file reads', () => {
		const big = 'x'.repeat(4_000);
		const fileReads = new Map<string, FileReadRecord>();
		for (const p of ['/w/a.ts', '/w/b.ts', '/w/c.ts', '/w/d.ts']) {
			trackFileRead(fileReads, URI.file(p), null, null, big.length);
		}
		// a.ts / b.ts were read in an earlier user turn (prefix) -> compacted;
		// c.ts / d.ts are in the protected tail (last two user turns) and are the latest read of each file -> kept full.
		const messages: ChatMessage[] = [
			user('first task'),
			assistant('reading'),
			readTool('1', '/w/a.ts', big),
			readTool('2', '/w/b.ts', big),
			user('second task'),
			assistant('reading more'),
			readTool('3', '/w/c.ts', big),
			readTool('4', '/w/d.ts', big),
			user('third task'),
		];
		const result = prepareMessagesForModel({
			messages,
			contextWindow: 200_000,
			reservedOutputTokens: 8_000,
			chatMode: 'normal',
			fileReads,
		});
		assert.strictEqual(result.trimmed, false);
		assert.strictEqual(result.compacted, 2);
		const contents = result.messages.filter(m => m.role === 'tool').map(m => (m as { content: string }).content);
		assert.ok(contents[0].startsWith('read_file('));
		assert.ok(contents[1].startsWith('read_file('));
		assert.strictEqual(contents[2], big);
		assert.strictEqual(contents[3], big);
		// compacted reads are dropped from the dedup history so a re-read is allowed
		assert.strictEqual(fileReads.has(readFileUriKey(URI.file('/w/a.ts'))), false);
		assert.strictEqual(fileReads.has(readFileUriKey(URI.file('/w/b.ts'))), false);
		assert.strictEqual(fileReads.has(readFileUriKey(URI.file('/w/c.ts'))), true);
		assert.strictEqual(fileReads.has(readFileUriKey(URI.file('/w/d.ts'))), true);
	});

	it('trims oldest assistant/tool messages when over budget and keeps the protected tail', () => {
		const big = 'y'.repeat(8_000); // ~2k tokens each
		const messages: ChatMessage[] = [
			user('first task'),
			assistant(big),
			assistant(big),
			assistant(big),
			user('second task'),
			assistant(big),
			user('third task'),
		];
		const result = prepareMessagesForModel({
			messages,
			contextWindow: 8_000,
			reservedOutputTokens: 1_000,
			chatMode: 'normal',
		});
		assert.strictEqual(result.trimmed, true);
		assert.ok(result.messages.length < messages.length);
		// last two user turns and everything after are preserved
		const userTexts = result.messages.filter(m => m.role === 'user').map(m => (m as { content: string }).content);
		assert.ok(userTexts.includes('second task'));
		assert.ok(userTexts.includes('third task'));
		assert.ok(result.estimatedTokens <= 8_000);
	});

	it('drops tool messages orphaned from their assistant turn', () => {
		const messages: ChatMessage[] = [
			user('go'),
			readTool('1', '/w/a.ts', 'orphan'),
			assistant('ok'),
			readTool('2', '/w/b.ts', 'paired'),
		];
		const result = prepareMessagesForModel({
			messages,
			contextWindow: 100_000,
			reservedOutputTokens: 4_000,
			chatMode: 'normal',
		});
		const toolIds = result.messages.filter(m => m.role === 'tool').map(m => (m as { id: string }).id);
		assert.deepStrictEqual(toolIds, ['2']);
	});

	it('applies the Anthropic agent input cap in agent mode', () => {
		const big = 'z'.repeat(20_000); // 5k tokens each
		const messages: ChatMessage[] = [
			user('a'), assistant(big), assistant(big), assistant(big), assistant(big), user('b'), assistant(big), user('c'),
		];
		const agent = prepareMessagesForModel({
			messages, contextWindow: 200_000, reservedOutputTokens: 4_000, chatMode: 'agent', providerName: 'anthropic',
		});
		const normal = prepareMessagesForModel({
			messages, contextWindow: 200_000, reservedOutputTokens: 4_000, chatMode: 'normal', providerName: 'anthropic',
		});
		assert.strictEqual(agent.trimmed, true);
		assert.strictEqual(normal.trimmed, false);
	});
});
