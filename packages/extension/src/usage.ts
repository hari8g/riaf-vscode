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
	private readonly _byProvider = new Map<string, { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }>();

	record(usage: LLMMessageUsage, meta: { provider: ProviderName; model: string; purpose: string }): void {
		const cost = calculateTurnCostUSD(usage, meta.provider, meta.model) ?? 0;
		const p = this._byPurpose.get(meta.purpose) ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
		p.calls++; p.inputTokens += usage.inputTokens; p.outputTokens += usage.outputTokens;
		this._byPurpose.set(meta.purpose, p);
		const providerKey = `${meta.provider}:${meta.model}`;
		const provider = this._byProvider.get(providerKey) ?? { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
		provider.calls++; provider.inputTokens += usage.inputTokens; provider.outputTokens += usage.outputTokens; provider.cacheReadTokens += usage.cacheReadTokens ?? 0;
		this._byProvider.set(providerKey, provider);
		for (const t of [this._session, this._allTime]) {
			t.calls++;
			t.inputTokens += usage.inputTokens;
			t.outputTokens += usage.outputTokens;
			t.cacheReadTokens += usage.cacheReadTokens ?? 0;
			t.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
			t.costUSD += cost;
		}
		void this._state.update('riaf.usage.allTime', this._allTime);
		this._rememberDay(usage.inputTokens, usage.outputTokens, cost);
		this._onChange.fire(this._session);
	}

	/** Last 7 local days, oldest first. Missing days are zeros so a chart can render gaps. */
	history(now = new Date()): { day: string; inputTokens: number; outputTokens: number; costUSD: number }[] {
		const stored = this._state.get<Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>>('riaf.usage.days', {});
		const days: { day: string; inputTokens: number; outputTokens: number; costUSD: number }[] = [];
		for (let i = 6; i >= 0; i--) {
			const d = new Date(now);
			d.setDate(d.getDate() - i);
			const key = d.toISOString().slice(0, 10);
			days.push({ day: key, ...(stored[key] ?? { inputTokens: 0, outputTokens: 0, costUSD: 0 }) });
		}
		return days;
	}

	private _rememberDay(inputTokens: number, outputTokens: number, costUSD: number): void {
		const key = new Date().toISOString().slice(0, 10);
		const stored = this._state.get<Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>>('riaf.usage.days', {});
		const prev = stored[key] ?? { inputTokens: 0, outputTokens: 0, costUSD: 0 };
		stored[key] = { inputTokens: prev.inputTokens + inputTokens, outputTokens: prev.outputTokens + outputTokens, costUSD: prev.costUSD + costUSD };
		const keys = Object.keys(stored).sort();
		for (const old of keys.slice(0, Math.max(0, keys.length - 14))) { delete stored[old]; }
		void this._state.update('riaf.usage.days', stored);
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
	get byProvider(): Record<string, { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }> { return Object.fromEntries(this._byProvider); }
	/** Share of this session's prompt tokens served from a provider cache. */
	cacheEfficiency(): number {
		const denom = this._session.inputTokens + this._session.cacheReadTokens;
		return denom ? this._session.cacheReadTokens / denom : 0;
	}

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
