import { describe, expect, it } from 'vitest';
import { URI } from '../src/shim/vsBase.js';
import type { ChatMessage } from '../src/types.js';
import type { LLMCallPort } from '../src/ports.js';
import { estimateChatHistoryTokens } from '../src/contextWindowTrim.js';
import { prepareMessagesForModel } from '../src/budget.js';
import { isSummaryMessage, renderTranscriptForSummary, SUMMARY_MARKER, summarizeThreadMiddle } from '../src/threadSummary.js';

const user = (content: string): ChatMessage => ({ role: 'user', content, displayContent: content, selections: null, state: { stagingSelections: [], isBeingEdited: false } });
const assistant = (text: string): ChatMessage => ({ role: 'assistant', displayContent: text, reasoning: '', anthropicReasoning: null });
const readTool = (id: string, path: string, content: string): ChatMessage => ({
	role: 'tool', type: 'success', name: 'read_file', id, content, rawParams: { uri: path }, compactable: true,
	params: { uri: URI.file(path), startLine: null, endLine: null, pageNumber: 1 },
	result: { fileContents: content, totalFileLen: content.length, totalNumLines: 1, hasNextPage: false, totalPages: 1 }, mcpServerName: undefined,
});

/** A long thread: 3 user turns, each followed by a big read and an answer. */
const longThread = (): ChatMessage[] => {
	const big = 'x'.repeat(20_000);           // ~5k tokens each
	return [
		user('Add retries to the HTTP client'), assistant('Looking.'), readTool('t1', 'src/http.ts', big), assistant('Found fetchWithRetry in src/http.ts.'),
		user('Also log each retry'), assistant('Reading logger.'), readTool('t2', 'src/logger.ts', big), assistant('Edited src/http.ts to log.'),
		user('Now run the tests'), assistant('Running.'), readTool('t3', 'package.json', big),
	];
};

const scriptedLLM = (text: string, calls: unknown[] = []): LLMCallPort => async req => { calls.push(req); return { text }; };

describe('token-opt - threadSummary', () => {
	it('does nothing below the trigger ratio', async () => {
		const messages = longThread();
		const r = await summarizeThreadMiddle({ messages, callLLM: scriptedLLM('should not be called'), inputBudget: 1_000_000 });
		expect(r.summarized).toBe(false);
		expect(r.messages).toBe(messages);
	});

	it('replaces the head of the thread with one summary message and keeps the protected tail intact', async () => {
		const messages = longThread();
		const calls: any[] = [];
		const summary = 'Task: add retries with logging to the HTTP client.\nDone: edited src/http.ts (fetchWithRetry logs each retry).\nLearned: logger lives in src/logger.ts.\nOpen: run the tests.';
		const before = estimateChatHistoryTokens({ chatMessages: messages, systemMessage: '', aiInstructions: '' });
		const r = await summarizeThreadMiddle({ messages, callLLM: scriptedLLM(summary, calls), inputBudget: 20_000 });
		expect(r.summarized).toBe(true);
		expect(r.replaced).toBe(4);                             // first user turn: user, assistant, tool, assistant
		expect(isSummaryMessage(r.messages[0])).toBe(true);
		expect((r.messages[0] as any).content).toContain(SUMMARY_MARKER);
		expect((r.messages[0] as any).content).toContain('src/http.ts');
		// tail = last two user turns, untouched
		expect(r.messages.slice(1)).toEqual(messages.slice(4));
		const after = estimateChatHistoryTokens({ chatMessages: r.messages, systemMessage: '', aiInstructions: '' });
		expect(after).toBeLessThan(before);
		expect(r.tokensSaved).toBeGreaterThan(2_000);
		// the side-call saw the transcript of the head only, with tool bodies clipped
		expect(calls).toHaveLength(1);
		expect(calls[0].purpose).toBe('thread-summary');
		expect(calls[0].messages[0].content).toContain('USER: Add retries to the HTTP client');
		expect(calls[0].messages[0].content).toContain('TOOL read_file uri=src/http.ts');
		expect(calls[0].messages[0].content).not.toContain('Also log each retry');
		expect(calls[0].maxOutputTokens).toBeLessThanOrEqual(600);
	});

	it('falls back to the original messages when the summary call throws, times out or is empty — trimming still works', async () => {
		const messages = longThread();
		const skips: string[] = [];
		const throwing: LLMCallPort = async () => { throw new Error('429 rate limited'); };
		let r = await summarizeThreadMiddle({ messages, callLLM: throwing, inputBudget: 20_000, onSkip: s => skips.push(s) });
		expect(r.summarized).toBe(false);
		expect(r.messages).toBe(messages);
		expect(skips[0]).toMatch(/summary call failed: 429/);

		const slow: LLMCallPort = () => new Promise(resolve => setTimeout(() => resolve({ text: 'late' }), 200));
		r = await summarizeThreadMiddle({ messages, callLLM: slow, inputBudget: 20_000, timeoutMs: 20, onSkip: s => skips.push(s) });
		expect(r.summarized).toBe(false);
		expect(skips[1]).toMatch(/returned nothing/);

		r = await summarizeThreadMiddle({ messages, callLLM: scriptedLLM('   '), inputBudget: 20_000, onSkip: s => skips.push(s) });
		expect(r.summarized).toBe(false);

		// the deletion path remains available on the unchanged messages
		const prepared = prepareMessagesForModel({ messages: r.messages, contextWindow: 14_000, reservedOutputTokens: 1_000, chatMode: 'agent' });
		expect(prepared.trimmed || prepared.compacted > 0).toBe(true);
	});

	it('refuses a summary that is not smaller than what it replaces', async () => {
		const messages = longThread();
		const r = await summarizeThreadMiddle({ messages, callLLM: scriptedLLM('y'.repeat(60_000)), inputBudget: 20_000 });
		expect(r.summarized).toBe(false);
	});

	it('renders a transcript that keeps the most recent part when over the cap', () => {
		const t = renderTranscriptForSummary([user('first'), assistant('a'.repeat(100)), user('last')], 60);
		expect(t.startsWith('…')).toBe(true);
		expect(t).toContain('USER: last');
	});
});
