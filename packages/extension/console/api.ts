/** Typed fetch wrapper over riafd's /api routes. The page got its token from index.html (same origin). */
export const boot = (window as unknown as { __RIAF__: { token: string; root: string; surface: string } }).__RIAF__ ?? { token: '', root: '', surface: 'cli' };

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`/api${path}`, { method, headers: { authorization: `Bearer ${boot.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
	const text = await res.text();
	let json: unknown = {};
	try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text }; }
	if (!res.ok) throw new ApiError(res.status, (json as { error?: string }).error ?? `${res.status} ${res.statusText}`);
	return json as T;
}

export const api = {
	get: <T>(path: string) => call<T>('GET', path),
	post: <T>(path: string, body: unknown) => call<T>('POST', path, body),
	put: <T>(path: string, body: unknown) => call<T>('PUT', path, body),
};

/* ───────── shapes (mirror daemon/server.ts) ───────── */
export interface Status {
	daemon: { port: number; pid: number; url: string; surface: string; version: string; uptimeMs: number; startedAt: number };
	repo: { root: string; head: string | null; branch: string };
	index: { indexed: boolean; chunks: number; files: number; symbols: number; lastIndexedAt?: number; embeddings: boolean; dbPath?: string };
	history: { commits: number; hotspots: { path: string; commits365: number; fixRatio: number }[] } | null;
	instruction: { id: string; type: string; confidence: number; generated_at: string; request: string; tokens: number; planGate: boolean } | null;
	instructions: { id: string; generated_at: number; request?: string; type?: string }[];
	governance: { sessions: number; proposed: number; served: number; blocked: number; tokensServed: number; tokensExecuted: number; week: { sessions: number; proposed: number; served: number; blocked: number; tokensServed: number }; policyPhases: string[] };
	claude: ClaudeSetup;
	feedback: number;
	adapters: { id: string; enabled: boolean }[];
	vscode?: { gateway: string | null; model: string; embeddings: boolean; classifyModel: string | null; instruction: Record<string, unknown> };
}
export interface ClaudeSetup { mcpJson: boolean; mcpStale: string | null; mcpEntry: string | null; commands: string[]; governHook: boolean; gateHook: boolean; settingsJson: boolean; policy: boolean; claudeMdRules: boolean; claudeMdInstruction: boolean; instructionCurrent: boolean }
export interface TreeFile { path: string; lang: string; sizeBytes: number; symbols: number; importedBy: number; imports: number; isTest: boolean; hot: boolean; lastChanged: number | null }
export interface FileDetail {
	path: string; summary: string; lines: number; content: string; historyText: string;
	expand: { imports: string[]; importedBy: string[]; tests: string[]; callers: string[]; callees: string[]; coChanges: { path: string; support: number; confidence: number }[]; outline: string[] };
	history: { hotspot?: { commits365: number; fixRatio: number } | null; owners?: { role: string; share: number }[] } | null;
}
export interface Route {
	type: string; secondaryType?: string; confidence: number; source: string; mode: string; tools: string; budget: number; stage: string; planGate: boolean; askFirst: boolean; questions: string[]; scope?: string;
	intent: { entities: { kind: string; value: string; resolved?: string[] }[]; constraints: string[]; acceptance: string[]; open_questions: string[] };
	line: string; arbiter?: { used: boolean; ms?: number; error?: string };
}
export interface PackItem { kind: string; path: string; range?: [number, number]; form?: string; score: number; tokens: number; why: string; preview: string }
export interface PackMeta { pack_id: string; head: string | null; budget: { max_tokens: number; used_tokens: number }; items: PackItem[]; plan_skeleton: string[]; verification: string[]; provenance: { retrievers: Record<string, number>; compile_ms: number; generated_at: string }; history: { related_commits: unknown[]; hotspots: unknown[]; decisions: unknown[] } }
export interface Instruction { instruction_id: string; pack_id: string; head: string | null; generated_at: string; request: string; intent: { type: string; confidence: number; source?: string }; route: { mode: string; tools: string; budget: number; stage: string; planGate: boolean }; plan: string[]; verification: string[]; findings: string[]; rules_sources: string[]; tokens: number; stable_hash: string; markdown: string }
export interface AdapterView { id: string; displayName: string; enabled: boolean; settings: Record<string, unknown>; settingsSchema: Record<string, { type: string; description: string; default?: unknown; enum?: string[] }>; credentials: { key: string; label: string; secret: boolean; hint?: string; present: boolean }[]; tools: { name: string; kind: 'read' | 'write'; label: string; description: string }[] }
export interface SessionRow { sessionId: string; host: string; startedAt: number; updatedAt: number; counters: Record<string, number | string> }
export interface SessionEvent { id: number; ts: number; event: string; tool: string | null; path: string | null; decision: string | null; reason: string | null }

export const fmtK = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
export const ago = (ts: number) => { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
