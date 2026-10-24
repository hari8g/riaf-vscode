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

	/** Session calls per purpose (agent, agent:explore, agent:summary, plan, …) for the usage report. */
	private readonly _byPurpose = new Map<string, { calls: number; inputTokens: number; outputTokens: number }>();

	record(usage: LLMMessageUsage, meta: { provider: ProviderName; model: string; purpose: string }): void {
		const cost = calculateTurnCostUSD(usage, meta.provider, meta.model) ?? 0;
		const p = this._byPurpose.get(meta.purpose) ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
		p.calls++; p.inputTokens += usage.inputTokens; p.outputTokens += usage.outputTokens;
		this._byPurpose.set(meta.purpose, p);
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
	get byPurpose(): Record<string, { calls: number; inputTokens: number; outputTokens: number }> { return Object.fromEntries(this._byPurpose); }

	summaryMarkdown(): string {
		const row = (n: string, t: UsageTotals) => `| ${n} | ${t.calls} | ${t.inputTokens.toLocaleString()} | ${t.outputTokens.toLocaleString()} | ${t.cacheReadTokens.toLocaleString()} | ${t.savedTokens.toLocaleString()} | $${t.costUSD.toFixed(4)} |`;
		const lines = ['| scope | calls | input | output | cache read | saved by RIAF | est. cost |', '|---|---|---|---|---|---|---|', row('this session', this._session), row('all time', this._allTime)];
		if (this._byPurpose.size) {
			lines.push('', '| this session by purpose | calls | input | output |', '|---|---|---|---|');
			for (const [k, v] of [...this._byPurpose].sort((a, b) => b[1].inputTokens - a[1].inputTokens)) { lines.push(`| ${k} | ${v.calls} | ${v.inputTokens.toLocaleString()} | ${v.outputTokens.toLocaleString()} |`); }
		}
		return lines.join('\n');
	}
}
