/** Request/response bridge between the settings webview and the extension host. */
export type SettingsSnapshot = Record<string, unknown>;
export type IndexStatus = { indexed: boolean; files: number; chunks: number; symbols: number; lastIndexedAt?: number; dbPath?: string; folder?: string; embeddings: boolean };
export type UsageTotals = { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUSD: number; savedTokens: number };
export type ToolCounters = { calls: number; charsReturned: number; savedTokensEst: number; errors: number; lastAt?: number };
export type ToolsServed = { byConsumer: Record<string, { calls: number; charsReturned: number; savedTokensEst: number; errors: number; tools: Record<string, ToolCounters>; lastAt?: number }>; total: { calls: number; savedTokensEst: number; charsReturned: number } };
export type EffectSide = { sessions: number; userTurns: number; calls: number; promptTokens: number; outputTokens: number; nativeReads: number; riafCalls: number; avgPromptPerCall: number; avgOutputPerCall: number; avgCallsPerTurn: number; avgReadsPerTurn: number };
export type RiafEffect = { with: EffectSide; without: EffectSide; promptPerCallSavedPct?: number; outputPerCallSavedPct?: number; readsPerTurnSavedPct?: number; directSavedTokens: number; directSavedPct: number; byTool: Record<string, { calls: number; savedTokens: number }> };
export type ClaudeCodeUsage = { riafEffect?: RiafEffect; calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUSD: number; cacheEfficiency: number; byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUSD: number }>; sessions: number; firstAt?: number; lastAt?: number; projectDir?: string; unpricedModels: string[] };
export type UsageBlock = { session: UsageTotals; allTime: UsageTotals; days?: { day: string; inputTokens: number }[]; byProvider?: Record<string, { calls: number; inputTokens: number }>; cacheEfficiency?: number; tools?: ToolsServed; claudeCode?: ClaudeCodeUsage; repo?: string };
export type ClaudeCodeNetwork = { settingsPath: string; proxyError?: string; writtenProxy: string; writtenHasCredentials: boolean; writtenCa: string; detectedProxy: string; detectedProxySource: string; detectedCa: string; detectedCaSource: string; caRequiredHint: boolean; upToDate: boolean; credentialSource: 'url' | 'secrets' | 'none'; credentialUser: string };
export type ClaudeCodeStatus = { mcpJson: boolean; mcpStale?: string; commands: boolean; rules: boolean; mcpEntry?: string; network?: ClaudeCodeNetwork };
export type BridgeStatus = { enabled: boolean; running: boolean; url?: string; upstream: string; stats?: { connects: number; upstreamOk: number; upstreamRejected: number; lastUpstreamStatus?: string; lastError?: string }; error?: string };
export type ConnectionTest = { ok: boolean; message: string; transportId?: string; latencyMs?: number };

export type HostRequest =
	| { type: 'getAll' }
	| { type: 'set'; key: string; value: unknown; scope?: 'user' | 'workspace' }
	| { type: 'testConnection' }
	| { type: 'reindex'; force?: boolean }
	| { type: 'getRules' } | { type: 'setRules'; text: string }
	| { type: 'setupClaudeCode' } | { type: 'setProxyCredentials' } | { type: 'bridgeStart' } | { type: 'bridgeStop' } | { type: 'bridgeLog' }
	| { type: 'openNativeSettings' } | { type: 'openOutput' } | { type: 'openReport' } | { type: 'openGraph' }
	| { type: 'resetUsage' } | { type: 'refreshUsage' }
	| { type: 'mcpRefresh' }
	| { type: 'detectProviders' }
	| { type: 'integrationHealth'; id?: string } | { type: 'setIntegrationCredentials'; id?: string } | { type: 'clearIntegrationCredentials'; id: string }
	| { type: 'syncSharedCredentials' } | { type: 'openAudit' };

export type IntegrationHealth = { ok: boolean; enabled: boolean; message: string; latencyMs?: number; missingCredentials: string[]; detail?: Record<string, unknown> };
export type IntegrationAdapterInfo = {
	id: string; displayName: string;
	settingsSchema: Record<string, { type: 'string' | 'boolean' | 'number' | 'enum'; description: string; default?: unknown; enum?: string[] }>;
	credentials: { key: string; label: string; secret: boolean; hint?: string; stored: boolean }[];
	tools: { name: string; kind: 'read' | 'write'; label: string }[];
	health?: IntegrationHealth;
};
export type AuditEntry = { at: string; consumer: string; adapter: string; tool: string; kind: 'read' | 'write'; args: string; ok: boolean; ms: number; approved?: string; error?: string };
export type IntegrationsBlock = { adapters: IntegrationAdapterInfo[]; audit: AuditEntry[]; auditPath?: string; configPath?: string; credentialsFile: string };

export type HostResponse = {
	settings?: SettingsSnapshot; index?: IndexStatus; usage?: UsageBlock; claudeCode?: ClaudeCodeStatus;
	rules?: string; rulesPath?: string; bridge?: BridgeStatus; connection?: ConnectionTest; transportId?: string; models?: string[]; error?: string;
	mcp?: { servers: { name: string; transport: string; target: string; enabled: boolean; tools: string[]; error?: string }[] };
	ruleSources?: string[];
	detected?: { ollama: string[] };
	integrations?: IntegrationsBlock;
};

type Envelope = { id: number; req?: HostRequest; res?: HostResponse; push?: HostResponse };

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: (m: unknown) => console.log('post', m), getState: () => undefined, setState: () => { } };

let seq = 0;
const pending = new Map<number, (r: HostResponse) => void>();
const pushListeners = new Set<(r: HostResponse) => void>();

window.addEventListener('message', ev => {
	const m = ev.data as Envelope;
	if (m?.push) { pushListeners.forEach(l => l(m.push!)); return; }
	if (typeof m?.id === 'number' && m.res) { pending.get(m.id)?.(m.res); pending.delete(m.id); }
});

export function request(req: HostRequest): Promise<HostResponse> {
	const id = ++seq;
	return new Promise(resolve => { pending.set(id, resolve); vscode.postMessage({ id, req } satisfies Envelope); });
}
export function onPush(l: (r: HostResponse) => void): () => void { pushListeners.add(l); return () => pushListeners.delete(l); }
