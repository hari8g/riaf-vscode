/*--------------------------------------------------------------------------------------
 *  budget.ts — one-call composition of the token-optimisation pipeline for a host
 *  agent runner:  compactStaleToolResults → trimChatMessagesForContextWindow →
 *  sanitizeToolMessagePairing.
 *--------------------------------------------------------------------------------------*/

import type { URI } from './shim/vsBase.js';
import type { ChatMessage, ChatMode, FileReadRecord } from './types.js';
import { compactStaleToolResults } from './toolResultCompaction.js';
import {
	estimateChatHistoryTokens,
	getAgentEffectiveContextWindow,
	sanitizeToolMessagePairing,
	trimChatMessagesForContextWindow,
} from './contextWindowTrim.js';
import { invalidateFileRead } from './fileReadDedup.js';

export type PrepareMessagesOptions = {
	messages: ChatMessage[];
	/** Model context window (input tokens). */
	contextWindow: number;
	/** Tokens to keep free for the model's output (incl. any safety margin). */
	reservedOutputTokens: number;
	chatMode: ChatMode;
	/**
	 * Thread-level file-read history. When supplied, any read_file result that gets
	 * compacted has its record invalidated so a later identical read is not skipped
	 * by `shouldSkipDuplicateFileRead` (the content is no longer in context).
	 */
	fileReads?: Map<string, FileReadRecord>;
	/** System prompt text, counted toward the budget when provided. */
	systemMessage?: string;
	/** Extra instructions counted toward the budget when provided. */
	aiInstructions?: string;
	/** Provider name — enables the per-provider agent input cap (e.g. Anthropic TPM) in agent mode. */
	providerName?: string;
	/** Use the tighter trim ratios (after a context-overflow or rate-limit retry). */
	forceAggressiveTrim?: boolean;
};

export type PrepareMessagesResult = {
	messages: ChatMessage[];
	/** Estimated prompt tokens after preparation (system + instructions + messages). */
	estimatedTokens: number;
	/** True when at least one message was dropped by the context-window trimmer. */
	trimmed: boolean;
	/** Number of tool results whose body was replaced by a short reference. */
	compacted: number;
};

/**
 * Prepare a chat history for the model within a token budget.
 *
 * 1. `compactStaleToolResults` — replace stale read/search/terminal bodies with one-line refs.
 * 2. `trimChatMessagesForContextWindow` — drop oldest assistant/tool messages until the
 *    estimate fits `(contextWindow - reservedOutputTokens) * ratio`.
 * 3. `sanitizeToolMessagePairing` — drop tool messages left without a preceding assistant turn.
 */
export function prepareMessagesForModel(opts: PrepareMessagesOptions): PrepareMessagesResult {
	const systemMessage = opts.systemMessage ?? '';
	const aiInstructions = opts.aiInstructions ?? '';

	// 1. compaction
	let compacted = 0;
	const compactedMessages = compactStaleToolResults(opts.messages, (uri: URI) => {
		if (opts.fileReads) {
			invalidateFileRead(opts.fileReads, uri);
		}
	});
	for (let i = 0; i < opts.messages.length; i++) {
		if (compactedMessages[i] !== opts.messages[i]) {
			compacted += 1;
		}
	}

	// 2. trim to the input budget
	const effectiveWindow = getAgentEffectiveContextWindow({
		chatMode: opts.chatMode,
		providerName: opts.providerName ?? '',
		contextWindow: opts.contextWindow,
		forceAggressiveTrim: opts.forceAggressiveTrim,
	});
	const inputWindow = Math.max(1, effectiveWindow - Math.max(0, opts.reservedOutputTokens));

	const { messages: trimmedMessages, contextWasTrimmed } = trimChatMessagesForContextWindow({
		chatMessages: compactedMessages,
		systemMessage,
		aiInstructions,
		contextWindow: inputWindow,
		forceAggressiveTrim: opts.forceAggressiveTrim,
	});

	// 3. pairing sanity (trim already sanitises when it removes something; run again for the no-op path)
	const messages = contextWasTrimmed ? trimmedMessages : sanitizeToolMessagePairing(trimmedMessages);

	const estimatedTokens = estimateChatHistoryTokens({
		chatMessages: messages,
		systemMessage,
		aiInstructions,
	});

	return { messages, estimatedTokens, trimmed: contextWasTrimmed, compacted };
}
