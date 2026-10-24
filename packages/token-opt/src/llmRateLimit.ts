/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

type LLMErrorLike = { message: string; fullError: Error | null };

type SerializedApiError = {
	status?: number;
	headers?: Record<string, string | string[] | undefined>;
};

/** Per-provider agent input caps — keeps requests under common org TPM limits (e.g. Anthropic 30k/min). */
export const AGENT_INPUT_TOKEN_CAPS: Readonly<Record<string, number>> = {
	anthropic: 22_000,
};

export const getAgentInputTokenCap = (providerName: string): number | undefined =>
	AGENT_INPUT_TOKEN_CAPS[providerName];

const rateLimitCooldownUntilByProvider = new Map<string, number>();

const providerKey = (providerName: string, modelName?: string): string =>
	modelName ? `${providerName}:${modelName}` : providerName;

export const recordProviderRateLimitHit = (
	providerName: string,
	error: LLMErrorLike,
	modelName?: string,
): void => {
	const untilMs = parseRateLimitCooldownUntilMs(error);
	if (untilMs > Date.now()) {
		rateLimitCooldownUntilByProvider.set(providerKey(providerName, modelName), untilMs);
	}
};

export const getProviderRateLimitCooldownMs = (
	providerName: string,
	modelName?: string,
): number => {
	const until = rateLimitCooldownUntilByProvider.get(providerKey(providerName, modelName));
	if (!until) {
		return 0;
	}
	return Math.max(0, until - Date.now());
};

export const clearProviderRateLimitCooldown = (providerName: string, modelName?: string): void => {
	rateLimitCooldownUntilByProvider.delete(providerKey(providerName, modelName));
};

/** Parse retry-after (seconds) or Anthropic reset timestamp from error headers. */
export const parseRateLimitCooldownUntilMs = (error: LLMErrorLike): number => {
	const serialized = getSerializedError(error.fullError);
	const headers = serialized?.headers;
	if (!headers) {
		return Date.now() + 90_000;
	}

	const retryAfterRaw = headers['retry-after'];
	const retryAfterHeader = Array.isArray(retryAfterRaw) ? retryAfterRaw[0] : retryAfterRaw;
	if (retryAfterHeader) {
		const seconds = parseInt(retryAfterHeader, 10);
		if (!Number.isNaN(seconds) && seconds > 0) {
			return Date.now() + seconds * 1000 + 500;
		}
	}

	const resetRaw = headers['anthropic-ratelimit-input-tokens-reset']
		?? headers['x-ratelimit-reset-requests'];
	const resetHeader = Array.isArray(resetRaw) ? resetRaw[0] : resetRaw;
	if (resetHeader) {
		const resetMs = Date.parse(resetHeader);
		if (!Number.isNaN(resetMs)) {
			return resetMs + 500;
		}
	}

	return Date.now() + 90_000;
};

export const formatRateLimitCooldownMessage = (cooldownMs: number): string => {
	const seconds = Math.ceil(cooldownMs / 1000);
	return `Anthropic rate limit reached (30k input tokens/min). Wait ${seconds}s for the limit to reset, then send your message again. Tip: start a new chat thread to reduce context size.`;
};

const getSerializedError = (fullError: Error | null): SerializedApiError | null => {
	if (!fullError || typeof fullError !== 'object') {
		return null;
	}
	return fullError as SerializedApiError;
};

export const isRateLimitLLMError = (error: LLMErrorLike): boolean => {
	const message = error.message.toLowerCase();
	if (message.includes('429') || message.includes('rate_limit') || message.includes('rate limit')) {
		return true;
	}
	const serialized = getSerializedError(error.fullError);
	return serialized?.status === 429;
};

export const isContextOverflowLLMError = (error: LLMErrorLike): boolean => {
	const message = error.message.toLowerCase();
	return message.includes('context_length')
		|| message.includes('context length')
		|| message.includes('context_length_exceeded')
		|| message.includes('token limit')
		|| message.includes('maximum context')
		|| message.includes('too many tokens')
		|| message.includes('prompt is too long')
		|| message.includes('request too large');
};

export const isStreamStallLLMError = (error: LLMErrorLike): boolean => {
	return error.message.toLowerCase().includes('stream stalled');
};

export const isFatalLLMError = (error: LLMErrorLike): boolean => {
	if (isContextOverflowLLMError(error)) {
		return false;
	}
	const serialized = getSerializedError(error.fullError);
	const status = serialized?.status;
	if (status === 401 || status === 403 || status === 404) {
		return true;
	}
	if (status === 400) {
		return true;
	}
	const message = error.message.toLowerCase();
	return message.includes('unauthorized')
		|| message.includes('invalid api key')
		|| message.includes('authentication')
		|| message.includes('forbidden')
		|| message.includes('not found');
};

/** Max retries for generic LLM errors vs rate-limit errors. */
export const getMaxLLMRetryAttempts = (error: LLMErrorLike): number => {
	if (isFatalLLMError(error)) {
		return 0;
	}
	if (isContextOverflowLLMError(error)) {
		return 2;
	}
	if (isRateLimitLLMError(error)) {
		return 2;
	}
	if (isStreamStallLLMError(error)) {
		return 3;
	}
	const serialized = getSerializedError(error.fullError);
	if (serialized?.status && serialized.status >= 500) {
		return 3;
	}
	return 3;
};

export const shouldForceAggressiveTrimOnRetry = (error: LLMErrorLike): boolean => {
	return isContextOverflowLLMError(error) || isRateLimitLLMError(error);
};

/** Prefer provider retry-after header; otherwise exponential backoff for rate limits. */
export const getLLMRetryDelayMs = (error: LLMErrorLike, attempt: number, defaultDelayMs: number): number => {
	const serialized = getSerializedError(error.fullError);
	const retryAfterRaw = serialized?.headers?.['retry-after'];
	const retryAfterHeader = Array.isArray(retryAfterRaw) ? retryAfterRaw[0] : retryAfterRaw;
	if (retryAfterHeader) {
		const seconds = parseInt(retryAfterHeader, 10);
		if (!Number.isNaN(seconds) && seconds > 0) {
			return seconds * 1000 + 500;
		}
	}

	if (isRateLimitLLMError(error)) {
		return Math.min(120_000, defaultDelayMs * Math.pow(2, attempt));
	}
	return defaultDelayMs;
};
