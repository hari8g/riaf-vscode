/**
 * Enterprise integration adapters — the contract every system adapter (Jira, Confluence, GitLab,
 * knowledge stores, …) implements, plus the shared plumbing: HTTP with auth, rate limiting,
 * result clipping, write audit, and the registry the agent / Copilot / MCP fronts read from.
 *
 * Design rules
 *  - No `vscode` import in this file or in adapters: they run in the extension host AND in the
 *    MCP server process (Claude Code). The host supplies credentials and fetch through `AdapterEnv`.
 *  - Read tools ground the agent; write tools are `kind: 'write'` and the host gates them behind
 *    approval and records them in the audit log.
 *  - Credentials never appear in settings files; they come from `env.getSecret(key)` (SecretStorage
 *    in VS Code, an opt-in credentials file for the MCP server).
 *  - Every tool result is a string the model reads; keep it compact and stable in shape.
 */
import type { ToolSpec } from '../modelTransport.js';

export type AdapterId = 'jira' | 'confluence' | 'gitlab' | 'knowledge';

export type ToolKind = 'read' | 'write';

export type IntegrationToolSpec = ToolSpec & {
	kind: ToolKind;
	/** Short label for approval dialogs and the audit log, e.g. "create Jira issue". */
	label: string;
};

export type AuthKind = 'none' | 'basic' | 'bearer' | 'header';

export type CredentialField = { key: string; label: string; secret: boolean; hint?: string };

export type Health = { ok: boolean; message: string; detail?: Record<string, unknown>; latencyMs?: number };

/** What the host provides to an adapter. */
export interface AdapterEnv {
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	getSecret: (key: string) => Promise<string | undefined>;
	/** Per-adapter settings object from `riaf.integrations.<id>`. */
	settings: Record<string, unknown>;
	/** Workspace root (for git-remote resolution, relative paths). */
	workspaceRoot?: string;
	/** Query → embedding vector, when the gateway/provider embeddings are configured. */
	embed?: (text: string) => Promise<number[]>;
	log?: (msg: string) => void;
}

export interface IntegrationAdapter {
	readonly id: AdapterId;
	readonly displayName: string;
	/** Settings keys under riaf.integrations.<id> that the Integrations tab renders. */
	readonly settingsSchema: Record<string, { type: 'string' | 'boolean' | 'number' | 'enum'; description: string; default?: unknown; enum?: string[] }>;
	/** Credentials the host must collect (SecretStorage keys are `riaf.integration.<id>.<key>`). */
	readonly credentials: CredentialField[];
	readonly tools: IntegrationToolSpec[];
	/** Cheap connectivity + auth check for the Integrations tab and Doctor. */
	health(env: AdapterEnv): Promise<Health>;
	execute(tool: string, args: Record<string, unknown>, env: AdapterEnv): Promise<string>;
}

/* ───────────────────────────── shared helpers for adapters ───────────────────────────── */

export const MAX_RESULT_CHARS = 12_000;
export const clip = (s: string, n = MAX_RESULT_CHARS): string => s.length > n ? `${s.slice(0, n)}\n…[${s.length - n} more chars omitted]` : s;

export const secretKey = (id: AdapterId, key: string): string => `riaf.integration.${id}.${key}`;

export class IntegrationError extends Error {
	constructor(message: string, readonly status?: number, readonly body?: string) { super(message); this.name = 'IntegrationError'; }
}

/** Trim trailing slashes; reject obviously wrong base URLs early with a readable message. */
export function baseUrlOf(settings: Record<string, unknown>, adapter: string): string {
	const raw = String(settings.baseUrl ?? '').trim().replace(/\/+$/, '');
	if (!raw) { throw new IntegrationError(`${adapter}: baseUrl is not set (Settings → Integrations)`); }
	if (!/^https?:\/\//i.test(raw)) { throw new IntegrationError(`${adapter}: baseUrl must start with http:// or https:// (got ${raw})`); }
	return raw;
}

/** Simple token bucket so an eager agent cannot hammer an enterprise API. */
export class RateLimiter {
	private tokens: number; private last = Date.now();
	constructor(private readonly perSecond: number, private readonly burst = perSecond * 2) { this.tokens = burst; }
	async take(): Promise<void> {
		for (; ;) {
			const now = Date.now();
			this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
			this.last = now;
			if (this.tokens >= 1) { this.tokens -= 1; return; }
			await new Promise(r => setTimeout(r, Math.ceil((1 - this.tokens) / this.perSecond * 1000)));
		}
	}
}

export type JsonRequest = { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number; accept?: 'json' | 'text' };

/** fetch + JSON with auth headers, timeout, and errors that carry status and body excerpt. */
export async function requestJson<T = unknown>(env: AdapterEnv, url: string, authHeaders: Record<string, string>, req: JsonRequest = {}, limiter?: RateLimiter): Promise<T> {
	if (limiter) { await limiter.take(); }
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), req.timeoutMs ?? 30_000);
	try {
		const res = await env.fetch(url, {
			method: req.method ?? (req.body !== undefined ? 'POST' : 'GET'),
			headers: { accept: req.accept === 'text' ? 'text/plain, */*' : 'application/json', ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}), ...authHeaders, ...(req.headers ?? {}) },
			body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
			signal: ctl.signal,
		});
		const text = await res.text();
		if (!res.ok) {
			const hint = res.status === 401 ? ' (credentials rejected — run "RIAF: Set Integration Credentials")' : res.status === 403 ? ' (forbidden — the account lacks permission)' : res.status === 404 ? ' (not found — check baseUrl / key)' : res.status === 429 ? ' (rate limited)' : '';
			throw new IntegrationError(`${res.status} ${res.statusText}${hint}: ${text.slice(0, 300)}`, res.status, text.slice(0, 2000));
		}
		if (req.accept === 'text') { return text as unknown as T; }
		if (!text) { return undefined as unknown as T; }
		try { return JSON.parse(text) as T; } catch { throw new IntegrationError(`non-JSON response from ${url}: ${text.slice(0, 200)}`); }
	} catch (e) {
		if ((e as Error).name === 'AbortError') { throw new IntegrationError(`timeout after ${req.timeoutMs ?? 30_000} ms: ${url}`); }
		throw e;
	} finally { clearTimeout(timer); }
}

export const basicAuth = (user: string, secret: string): Record<string, string> => ({ authorization: `Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}` });
export const bearerAuth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/** Very small HTML → text for Confluence storage format, wiki descriptions etc. No deps. */
export function htmlToText(html: string): string {
	return html
		.replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
		.replace(/<\s*li[^>]*>/gi, '• ')
		.replace(/<\s*\/t[dh]\s*>/gi, '\t')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
		.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Atlassian Document Format (Jira Cloud descriptions/comments) → plain text. */
export function adfToText(node: unknown): string {
	if (!node || typeof node !== 'object') { return ''; }
	const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown> };
	if (n.type === 'text') { return n.text ?? ''; }
	const inner = (n.content ?? []).map(adfToText).join(n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem' || n.type === 'codeBlock' ? '' : '');
	switch (n.type) {
		case 'paragraph': case 'heading': return inner + '\n';
		case 'listItem': return '• ' + inner;
		case 'codeBlock': return '```\n' + inner + '\n```\n';
		case 'hardBreak': return '\n';
		case 'mention': return String(n.attrs?.text ?? '@user');
		default: return inner;
	}
}

/** Plain text → minimal ADF document (for Jira Cloud create/comment). */
export const textToAdf = (text: string) => ({ type: 'doc', version: 1, content: text.split(/\n{2,}/).map(p => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })) });

/* ───────────────────────────── schema helpers (same shapes as toolRegistry) ───────────────────────────── */

export const str = (d: string) => ({ type: 'string', description: d });
export const num = (d: string) => ({ type: 'number', description: d });
export const bool = (d: string) => ({ type: 'boolean', description: d });
export const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required });
export const tool = (name: string, kind: ToolKind, label: string, description: string, inputSchema: Record<string, unknown>): IntegrationToolSpec => ({ name, kind, label, description, inputSchema });

/* ───────────────────────────── registry ───────────────────────────── */

const adapters = new Map<AdapterId, IntegrationAdapter>();
export const registerAdapter = (a: IntegrationAdapter): void => { adapters.set(a.id, a); };
export const getAdapter = (id: AdapterId): IntegrationAdapter | undefined => adapters.get(id);
export const allAdapters = (): IntegrationAdapter[] => [...adapters.values()];
/** Which adapter owns a tool name (tools are globally unique: jira_*, confluence_*, gitlab_*, kb_*, kg_*). */
export const adapterForTool = (toolName: string): IntegrationAdapter | undefined => allAdapters().find(a => a.tools.some(t => t.name === toolName));
export const integrationToolSpec = (toolName: string): IntegrationToolSpec | undefined => allAdapters().flatMap(a => a.tools).find(t => t.name === toolName);
