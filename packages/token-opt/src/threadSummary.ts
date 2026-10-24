/*--------------------------------------------------------------------------------------
 *  threadSummary.ts — replace the middle of a long thread with a model-written summary.
 *
 *  Past a token threshold, the oldest turns (everything before the protected tail) are
 *  summarised by one side-call and replaced with a single user message. If that call fails,
 *  times out or returns nothing, the caller keeps today's compact-and-trim path.
 *--------------------------------------------------------------------------------------*/

import type { LLMCallPort } from './ports.js';
import type { ChatMessage, UserMessage } from './types.js';
import { estimateChatHistoryTokens, estimateChatMessageTokens, getProtectedTailStartIndex } from './contextWindowTrim.js';

export const SUMMARY_MARKER = '[Summary of earlier conversation]';
export const SUMMARY_OUTPUT_TOKEN_CAP = 600;
export const SUMMARY_TIMEOUT_MS = 30_000;
/** Fraction of the input budget at which summarisation kicks in. */
export const SUMMARY_TRIGGER_RATIO = 0.6;
/** Do not bother summarising fewer tokens than this — trimming is cheaper. */
export const SUMMARY_MIN_TOKENS = 4_000;

export const SUMMARY_SYSTEM_PROMPT = `You compress the earlier part of a coding-agent conversation so the agent can continue without it.
Write a dense summary (max ~400 words) with these sections, omitting empty ones:
- Task: what the user asked for, in one or two sentences, including constraints.
- Done: files created/edited (paths) and what changed in each; commands run and their outcomes.
- Learned: key facts about the codebase found so far (paths, function names, how things connect, test commands).
- Open: what is still to do, known failures, and decisions pending.
Use exact file paths and identifiers. No preamble, no markdown headings beyond the four labels.`;

export type SummarizeThreadOptions = {
	messages: ChatMessage[];
	callLLM: LLMCallPort;
	/** Input-token budget the prepared prompt must fit (context window minus output reserve, times the use ratio). */
	inputBudget: number;
	systemMessage?: string;
	triggerRatio?: number;
	minTokens?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** For logging: called with the reason when summarisation is skipped or fails. */
	onSkip?: (reason: string) => void;
};

export type SummarizeThreadResult = {
	messages: ChatMessage[];
	summarized: boolean;
	/** Tokens of the replaced messages minus the summary (≥ 0 when it helped). */
	tokensSaved: number;
	/** Messages replaced by the summary. */
	replaced: number;
};

const userMsg = (text: string): UserMessage => ({ role: 'user', content: text, displayContent: text, selections: null, state: { stagingSelections: [], isBeingEdited: false } });

/** Flatten messages into a plain transcript the summariser can read. */
export const renderTranscriptForSummary = (messages: ChatMessage[], maxChars = 60_000): string => {
	const parts: string[] = [];
	for (const m of messages) {
		if (m.role === 'user') { parts.push(`USER: ${m.content}`); }
		else if (m.role === 'assistant') { if (m.displayContent) { parts.push(`ASSISTANT: ${m.displayContent}`); } }
		else if (m.role === 'tool') {
			const args = Object.entries(m.rawParams ?? {}).map(([k, v]) => `${k}=${String(v).slice(0, 120)}`).join(' ');
			const body = (m.content ?? '').slice(0, 1_500);
			parts.push(`TOOL ${m.name} ${args}\n${body}${(m.content ?? '').length > 1_500 ? '\n…' : ''}`);
		}
		else if (m.role === 'plan') { parts.push(`PLAN: ${m.items.map(i => `[${i.status}] ${i.text}`).join('; ')}`); }
	}
	const text = parts.join('\n\n');
	// keep the *end* of the transcript when it is too long: the most recent part is the most relevant
	return text.length > maxChars ? `…\n${text.slice(text.length - maxChars)}` : text;
};

/** Is this message a summary we produced earlier? (Re-summarising folds it in.) */
export const isSummaryMessage = (m: ChatMessage): boolean => m.role === 'user' && m.content.startsWith(SUMMARY_MARKER);

/**
 * Summarise everything before the protected tail when the thread is past the trigger ratio.
 * Returns the original messages (summarized=false) whenever summarising is not worth it or fails.
 */
export async function summarizeThreadMiddle(opts: SummarizeThreadOptions): Promise<SummarizeThreadResult> {
	const { messages } = opts;
	const noop = (reason: string): SummarizeThreadResult => { opts.onSkip?.(reason); return { messages, summarized: false, tokensSaved: 0, replaced: 0 }; };
	const total = estimateChatHistoryTokens({ chatMessages: messages, systemMessage: opts.systemMessage ?? '', aiInstructions: '' });
	const trigger = Math.floor(opts.inputBudget * (opts.triggerRatio ?? SUMMARY_TRIGGER_RATIO));
	if (total <= trigger) { return noop(`below trigger (${total} ≤ ${trigger})`); }

	const tailStart = getProtectedTailStartIndex(messages);
	// summarise whole turns only: everything before the last two user turns
	const head = messages.slice(0, tailStart);
	const summarizable = head.filter(m => m.role !== 'checkpoint' && m.role !== 'interrupted_streaming_tool');
	const headTokens = summarizable.reduce((n, m) => n + estimateChatMessageTokens(m), 0);
	if (headTokens < (opts.minTokens ?? SUMMARY_MIN_TOKENS)) { return noop(`head too small (${headTokens} tokens)`); }

	const transcript = renderTranscriptForSummary(summarizable);
	let text = '';
	try {
		const call = opts.callLLM({
			systemMessage: SUMMARY_SYSTEM_PROMPT,
			messages: [userMsg(`Conversation to summarise:\n\n${transcript}`)],
			maxOutputTokens: SUMMARY_OUTPUT_TOKEN_CAP,
			signal: opts.signal,
			purpose: 'thread-summary',
		});
		const timeout = new Promise<null>(resolve => { const t = setTimeout(() => resolve(null), opts.timeoutMs ?? SUMMARY_TIMEOUT_MS); (t as { unref?: () => void }).unref?.(); });
		const r = await Promise.race([call, timeout]);
		text = (r?.text ?? '').trim();
	} catch (e) {
		return noop(`summary call failed: ${(e as Error).message ?? String(e)}`);
	}
	if (!text) { return noop('summary call returned nothing'); }

	const summary = userMsg(`${SUMMARY_MARKER}\n${text}\n[End of summary — the conversation continues below.]`);
	const summaryTokens = estimateChatMessageTokens(summary);
	if (summaryTokens >= headTokens) { return noop(`summary not smaller (${summaryTokens} ≥ ${headTokens})`); }

	// keep plan / checkpoint messages from the head (UI-only, zero or near-zero tokens), drop the rest
	const kept = head.filter(m => m.role === 'plan' || m.role === 'checkpoint');
	return {
		messages: [summary, ...kept, ...messages.slice(tailStart)],
		summarized: true,
		tokensSaved: headTokens - summaryTokens,
		replaced: summarizable.length,
	};
}
