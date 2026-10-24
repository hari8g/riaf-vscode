import * as vscode from 'vscode';
import { calculateTurnCostUSD, type LLMMessageUsage, type ProviderName, type UsageMeterPort } from '@bosch-mps/token-opt';

export interface UsageTotals { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUSD: number; savedTokens: number }

const zero = (): UsageTotals => ({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0, savedTokens: 0 });

/**
 * Session + persisted token meter. `savedTokens` counts what compaction/trim/dedup kept out of
 * prompts — the number developers see in the status bar and the rollout argument.
 */
export class UsageMeter implements UsageMeterPort {
	private _session = zero();
	private _allTime: UsageTotals;
	private readonly _onChange = new vscode.EventEmitter<UsageTotals>();
	readonly onDidChange = this._onChange.event;

	constructor(private readonly _state: vscode.Memento) {
		this._allTime = _state.get<UsageTotals>('riaf.usage.allTime', zero());
	}

	record(usage: LLMMessageUsage, meta: { provider: ProviderName; model: string; purpose: string }): void {
		const cost = calculateTurnCostUSD(usage, meta.provider, meta.model) ?? 0;
		for (const t of [this._session, this._allTime]) {
			t.calls++;
			t.inputTokens += usage.inputTokens;
			t.outputTokens += usage.outputTokens;
			t.cacheReadTokens += usage.cacheReadTokens ?? 0;
			t.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
			t.costUSD += cost;
		}
		void this._state.update('riaf.usage.allTime', this._allTime);
		this._onChange.fire(this._session);
	}

	recordSaved(tokens: number): void {
		if (tokens <= 0) { return; }
		this._session.savedTokens += tokens;
		this._allTime.savedTokens += tokens;
		void this._state.update('riaf.usage.allTime', this._allTime);
		this._onChange.fire(this._session);
	}

	resetAllTime(): void { this._allTime = zero(); void this._state.update('riaf.usage.allTime', this._allTime); this._onChange.fire(this._session); }

	get session(): UsageTotals { return { ...this._session }; }
	get allTime(): UsageTotals { return { ...this._allTime }; }

	summaryMarkdown(): string {
		const row = (n: string, t: UsageTotals) => `| ${n} | ${t.calls} | ${t.inputTokens.toLocaleString()} | ${t.outputTokens.toLocaleString()} | ${t.cacheReadTokens.toLocaleString()} | ${t.savedTokens.toLocaleString()} | $${t.costUSD.toFixed(4)} |`;
		return ['| scope | calls | input | output | cache read | saved by RIAF | est. cost |', '|---|---|---|---|---|---|---|', row('this session', this._session), row('all time', this._allTime)].join('\n');
	}
}
