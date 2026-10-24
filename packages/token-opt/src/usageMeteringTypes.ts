/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

export interface TurnCostRecord {
	timestamp: number;
	providerName: string;
	modelName: string;
	threadId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUSD: number;
}

export interface ProviderTotals {
	costUSD: number;
	turns: number;
}

export interface MeteringSession {
	startedAt: number;
	totalCostUSD: number;
	totalTurns: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	byProvider: Record<string, ProviderTotals>;
	byThread: Record<string, ProviderTotals>;
	dailyUSD: Record<string, number>;
}
