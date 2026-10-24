/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { ChatMode } from './types.js';

/** Anthropic beta header for extended max_tokens (up to 128k output). */
export const ANTHROPIC_EXTENDED_OUTPUT_BETA = 'output-128k-2025-02-19';

/** Agent edit_file / rewrite_file payloads often exceed the default 8k output cap. */
export const AGENT_ANTHROPIC_OUTPUT_TOKENS = 32_768;

export const getEffectiveMaxOutputTokens = (
	providerName: string,
	chatMode: ChatMode | null | undefined,
	baseMaxTokens: number | null | undefined,
): number => {
	const base = baseMaxTokens ?? 4_096;
	if (chatMode === 'agent' && providerName === 'anthropic') {
		return Math.max(base, AGENT_ANTHROPIC_OUTPUT_TOKENS);
	}
	return base;
};

/** Prompt caching is GA since late 2024 and requires no beta header. */
export const getAnthropicBetaHeaders = (opts: {
	chatMode: ChatMode | null | undefined;
}): string | undefined => {
	const betas: string[] = [];
	if (opts.chatMode === 'agent') {
		betas.push(ANTHROPIC_EXTENDED_OUTPUT_BETA);
	}
	return betas.length ? betas.join(',') : undefined;
};

/** True when the model likely hit max_tokens before finishing tool JSON. */
export const isLikelyOutputTruncated = (outputTokens: number | undefined, maxOutputTokens: number): boolean => {
	if (!outputTokens || !maxOutputTokens) {
		return false;
	}
	return outputTokens >= maxOutputTokens - 32;
};
