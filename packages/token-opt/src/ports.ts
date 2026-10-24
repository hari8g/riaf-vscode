/*--------------------------------------------------------------------------------------
 *  Narrow, function-typed ports that replace the VS Code DI services
 *  (ILLMMessageService, IConvertToLLMMessageService, IUsageMeteringService)
 *  the fork's agentPlan.ts / parallelReadToolBatch.ts depended on.
 *
 *  The host (VS Code extension, CLI, test) supplies implementations; this library
 *  never talks to a provider itself.
 *--------------------------------------------------------------------------------------*/

import type {
	ChatMessage,
	ChatMode,
	InternalToolInfo,
	LLMMessageUsage,
	ModelSelection,
	ModelSelectionOptions,
	OverridesOfModel,
	ProviderName,
	RawToolCallObj,
} from './types.js';

/** One LLM request as this library issues it. */
export type LLMCallRequest = {
	/** Conversation to send. For side-calls (plan / discovery) this is a single user message. */
	messages: ChatMessage[];
	/** System prompt; the host decides how to place it for the provider (separate field, system role, ...). */
	systemMessage: string;
	/** Hard cap on generated tokens for this call (e.g. PLAN_OUTPUT_TOKEN_CAP). Host maps to max_tokens / reservedOutputTokenSpace. */
	maxOutputTokens?: number;
	/** Tool definitions, when the call should be allowed to emit tool calls. */
	tools?: InternalToolInfo[];
	signal?: AbortSignal;

	// Routing hints — echo what the fork passed to sendLLMMessage so a host can pick the model.
	modelSelection?: ModelSelection;
	modelSelectionOptions?: ModelSelectionOptions;
	overridesOfModel?: OverridesOfModel;
	chatMode?: ChatMode;
	/** Free-form label for logging (fork: logging.loggingName). */
	purpose?: string;
};

export type LLMCallResult = {
	text: string;
	usage?: LLMMessageUsage;
	toolCalls?: RawToolCallObj[];
};

/**
 * Single-shot LLM call. Resolve with the final text; reject on provider error or abort.
 * Implementations should honour `signal` and `maxOutputTokens`.
 */
export interface LLMCallPort {
	(req: LLMCallRequest): Promise<LLMCallResult>;
}

/** Sink for per-turn token usage (fork: IUsageMeteringService.recordTurn). */
export interface UsageMeterPort {
	record(usage: LLMMessageUsage, meta: { provider: ProviderName; model: string; purpose: string; threadId?: string }): void;
}

/** Convenience: a UsageMeterPort that drops everything. */
export const noopUsageMeter: UsageMeterPort = { record: () => { } };
