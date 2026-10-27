import * as vscode from 'vscode';
import {
	applyRoutedAnthropicConversationCache, applyRoutedAnthropicPromptCache, getModelCapabilities,
	usageFromOpenAIResponse, type LLMMessageUsage, type ProviderName,
} from '@bosch-mps/token-opt';
import { readSettings, type ProviderKind, type RiafSettings } from './config.js';
import { buildProviderRequest, parseProviderResponse, type ProviderMessage } from './providerHttp.js';
import { outboundFetch } from './proxiedFetch.js';

/* ───────────────────────────── transport-neutral message model ───────────────────────────── */

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

export type TransportMessage =
	| { role: 'user'; text: string }
	| { role: 'assistant'; text: string; toolCalls?: ToolCall[] }
	| { role: 'tool'; toolCallId: string; name: string; text: string };

export interface TransportRequest {
	systemMessage: string;
	/** Volatile part of the system prompt (per-turn hints) — kept out of the cached prefix. */
	volatileSystemMessage?: string;
	messages: TransportMessage[];
	tools?: ToolSpec[];
	maxOutputTokens?: number;
	signal?: AbortSignal;
	onText?: (delta: string) => void;
}

export interface TransportResult {
	text: string;
	toolCalls: ToolCall[];
	usage?: LLMMessageUsage;
	stopReason: 'end' | 'tool_calls' | 'length' | 'other';
}

export interface ModelTransport {
	readonly id: string;
	readonly providerName: ProviderName;
	readonly modelName: string;
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
	call(req: TransportRequest): Promise<TransportResult>;
}

/* ───────────────────────────── Copilot / vscode.lm transport ───────────────────────────── */

/**
 * Borrows the models the user's Copilot (or any vscode.lm provider) exposes — and with them,
 * the organisation's existing SSO. Nothing to configure.
 */
export class VscodeLmTransport implements ModelTransport {
	readonly id: string;
	readonly providerName: ProviderName = 'openAICompatible';
	readonly modelName: string;
	readonly contextWindow: number;
	readonly maxOutputTokens: number;

	private constructor(private readonly _model: vscode.LanguageModelChat) {
		this.id = `vscode.lm:${_model.vendor}/${_model.id}`;
		this.modelName = _model.id;
		this.contextWindow = _model.maxInputTokens || 128_000;
		this.maxOutputTokens = 8_192;
	}

	static async create(preferred?: vscode.LanguageModelChat): Promise<VscodeLmTransport | undefined> {
		const model = preferred ?? (await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' }))[0]
			?? (await vscode.lm.selectChatModels({ vendor: 'copilot' }))[0]
			?? (await vscode.lm.selectChatModels())[0];
		return model ? new VscodeLmTransport(model) : undefined;
	}

	async call(req: TransportRequest): Promise<TransportResult> {
		const msgs: vscode.LanguageModelChatMessage[] = [];
		// vscode.lm has no system role; the first user message carries the system prompt.
		const sys = [req.systemMessage, req.volatileSystemMessage ?? ''].filter(Boolean).join('\n\n');
		msgs.push(vscode.LanguageModelChatMessage.User(`<system>\n${sys}\n</system>`));
		for (const m of req.messages) {
			if (m.role === 'user') { msgs.push(vscode.LanguageModelChatMessage.User(m.text)); }
			else if (m.role === 'assistant') {
				const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
				if (m.text) { parts.push(new vscode.LanguageModelTextPart(m.text)); }
				for (const tc of m.toolCalls ?? []) { parts.push(new vscode.LanguageModelToolCallPart(tc.id, tc.name, tc.args)); }
				msgs.push(vscode.LanguageModelChatMessage.Assistant(parts));
			} else {
				msgs.push(vscode.LanguageModelChatMessage.User([
					new vscode.LanguageModelToolResultPart(m.toolCallId, [new vscode.LanguageModelTextPart(m.text)]),
				]));
			}
		}
		const cts = new vscode.CancellationTokenSource();
		req.signal?.addEventListener('abort', () => cts.cancel(), { once: true });
		const options: vscode.LanguageModelChatRequestOptions = {
			justification: 'RIAF agent',
			tools: req.tools?.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
			toolMode: vscode.LanguageModelChatToolMode.Auto,
		};
		const res = await this._model.sendRequest(msgs, options, cts.token);
		let text = '';
		const toolCalls: ToolCall[] = [];
		for await (const part of res.stream) {
			if (part instanceof vscode.LanguageModelTextPart) { text += part.value; req.onText?.(part.value); }
			else if (part instanceof vscode.LanguageModelToolCallPart) { toolCalls.push({ id: part.callId, name: part.name, args: part.input as Record<string, unknown> }); }
		}
		// vscode.lm does not report usage; estimate so the meter still moves.
		const usage: LLMMessageUsage = {
			inputTokens: await this._countTokens(msgs),
			outputTokens: Math.ceil((text.length + JSON.stringify(toolCalls).length) / 4),
			cacheReadTokens: 0,
		};
		return { text, toolCalls, usage, stopReason: toolCalls.length ? 'tool_calls' : 'end' };
	}

	private async _countTokens(msgs: vscode.LanguageModelChatMessage[]): Promise<number> {
		let n = 0;
		for (const m of msgs) { try { n += await this._model.countTokens(m); } catch { n += 0; } }
		return n;
	}
}

/* ───────────────────────────── internal gateway transport (OpenAI wire + SSO) ───────────────────────────── */

let _cachedHeaders: Record<string, string> = {};
/** Headers last resolved by the gateway transport (used by riaf-core's embedding client too). */
export const getGatewayHeaders = (): Record<string, string> => ({ ..._cachedHeaders });

async function resolveAuthHeaders(s: RiafSettings): Promise<Record<string, string>> {
	const h: Record<string, string> = { 'content-type': 'application/json', ...s.gateway.headers };
	if (s.gateway.auth === 'microsoft-sso' || s.gateway.auth === 'github-sso') {
		const provider = s.gateway.auth === 'microsoft-sso' ? 'microsoft' : 'github';
		const session = await vscode.authentication.getSession(provider, s.gateway.ssoScopes, { createIfNone: true });
		h['authorization'] = `Bearer ${session.accessToken}`;
	}
	_cachedHeaders = h;
	return h;
}

export class GatewayTransport implements ModelTransport {
	readonly id: string;
	readonly providerName: ProviderName;
	readonly modelName: string;
	readonly contextWindow: number;
	readonly maxOutputTokens: number;

	constructor(private readonly _s: RiafSettings) {
		this.modelName = _s.gateway.model;
		// Treat the gateway as LiteLLM-style routing; promptCache.isAnthropicRoutedModel keys off the model name.
		this.providerName = 'liteLLM';
		this.id = `gateway:${this.modelName}`;
		const caps = getModelCapabilities(this.providerName, this.modelName, undefined);
		this.contextWindow = caps.contextWindow ?? 200_000;
		this.maxOutputTokens = caps.reservedOutputTokenSpace ?? 8_192;
	}

	async call(req: TransportRequest): Promise<TransportResult> {
		const headers = await resolveAuthHeaders(this._s);
		let wire: { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string; name?: string }[] = [];
		for (const m of req.messages) {
			if (m.role === 'user') { wire.push({ role: 'user', content: m.text }); }
			else if (m.role === 'assistant') {
				wire.push({
					role: 'assistant', content: m.text || null,
					...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } })) } : {}),
				});
			} else { wire.push({ role: 'tool', tool_call_id: m.toolCallId, name: m.name, content: m.text }); }
		}
		// Prompt caching for Claude-routed models: cache system prefix + conversation breakpoints.
		wire = applyRoutedAnthropicPromptCache(wire, req.systemMessage, this._s.gateway.promptCache, this.providerName, this.modelName, req.volatileSystemMessage) as typeof wire;
		wire = applyRoutedAnthropicConversationCache(wire, this._s.gateway.promptCache, this.providerName, this.modelName) as typeof wire;
		if (!wire.some(m => m.role === 'system')) {
			wire.unshift({ role: 'system', content: [req.systemMessage, req.volatileSystemMessage ?? ''].filter(Boolean).join('\n\n') });
		}

		const stream = this._s.gateway.stream !== false;
		const body = {
			model: this.modelName,
			messages: wire,
			max_tokens: req.maxOutputTokens ?? this.maxOutputTokens,
			stream,
			...(stream ? { stream_options: { include_usage: true } } : {}),
			...(req.tools?.length ? { tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })), tool_choice: 'auto' } : {}),
		};
		const doFetch = await outboundFetch();
		const res = await doFetch(`${this._s.gateway.url}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal });
		if (!res.ok) { throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 500)}`); }
		const contentType = res.headers.get('content-type') ?? '';
		if (stream && res.body && contentType.includes('text/event-stream')) {
			return readOpenAIStream(res.body, req.onText);
		}
		// Gateway answered with a plain JSON body (streaming disabled or not supported upstream).
		return parseOpenAIResponse(await res.json(), req.onText);
	}
}

const safeJson = (s: unknown): Record<string, unknown> => {
	if (typeof s !== 'string') { return (s as Record<string, unknown>) ?? {}; }
	try { return JSON.parse(s); } catch { return { _raw: s }; }
};

const stopReasonFrom = (finish: unknown, hasToolCalls: boolean): TransportResult['stopReason'] =>
	// `length` wins even when tool calls are present: their arguments were cut mid-JSON.
	finish === 'length' ? 'length'
		: finish === 'tool_calls' || hasToolCalls ? 'tool_calls'
			: finish === 'stop' ? 'end' : 'other';

/** Parse a non-streaming OpenAI chat-completions body. */
export function parseOpenAIResponse(json: any, onText?: (delta: string) => void): TransportResult {
	const choice = json?.choices?.[0];
	const text: string = choice?.message?.content ?? '';
	if (text) { onText?.(text); }
	const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((tc: any) => ({
		id: tc.id, name: tc.function?.name, args: safeJson(tc.function?.arguments),
	}));
	return { text, toolCalls, usage: usageFromOpenAIResponse(json?.usage), stopReason: stopReasonFrom(choice?.finish_reason, toolCalls.length > 0) };
}

/**
 * Incremental accumulator for OpenAI-style SSE chat chunks. Text deltas are forwarded to
 * `onText` as they arrive; tool-call argument fragments are stitched by `index`; the final
 * `usage` chunk (from `stream_options.include_usage`) is kept.
 */
export class OpenAIStreamAccumulator {
	text = '';
	finish: unknown = undefined;
	usage: unknown = undefined;
	private readonly _tools = new Map<number, { id: string; name: string; args: string }>();
	private _buffer = '';

	constructor(private readonly _onText?: (delta: string) => void) { }

	/** Feed raw SSE bytes/text; complete `data:` events are consumed, partial lines are kept. */
	feed(chunk: string): void {
		this._buffer += chunk;
		let nl: number;
		while ((nl = this._buffer.indexOf('\n')) >= 0) {
			const line = this._buffer.slice(0, nl).replace(/\r$/, '');
			this._buffer = this._buffer.slice(nl + 1);
			this._line(line);
		}
	}

	/** Flush whatever remains in the buffer (a final event without trailing newline). */
	end(): void {
		if (this._buffer.trim()) { this._line(this._buffer); }
		this._buffer = '';
	}

	private _line(line: string): void {
		if (!line.startsWith('data:')) { return; }
		const payload = line.slice(5).trim();
		if (!payload || payload === '[DONE]') { return; }
		let json: any;
		try { json = JSON.parse(payload); } catch { return; }
		if (json.usage) { this.usage = json.usage; }
		const choice = json.choices?.[0];
		if (!choice) { return; }
		const delta = choice.delta ?? {};
		if (typeof delta.content === 'string' && delta.content) {
			this.text += delta.content;
			this._onText?.(delta.content);
		}
		for (const tc of delta.tool_calls ?? []) {
			const idx: number = typeof tc.index === 'number' ? tc.index : this._tools.size;
			let acc = this._tools.get(idx);
			if (!acc) { acc = { id: '', name: '', args: '' }; this._tools.set(idx, acc); }
			if (tc.id) { acc.id = tc.id; }
			if (tc.function?.name) { acc.name = tc.function.name; }
			if (typeof tc.function?.arguments === 'string') { acc.args += tc.function.arguments; }
		}
		if (choice.finish_reason) { this.finish = choice.finish_reason; }
	}

	result(): TransportResult {
		const toolCalls: ToolCall[] = [...this._tools.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([i, t]) => ({ id: t.id || `call_${i}`, name: t.name, args: safeJson(t.args) }));
		return { text: this.text, toolCalls, usage: usageFromOpenAIResponse(this.usage as any), stopReason: stopReasonFrom(this.finish, toolCalls.length > 0) };
	}
}

async function readOpenAIStream(body: ReadableStream<Uint8Array>, onText?: (delta: string) => void): Promise<TransportResult> {
	const acc = new OpenAIStreamAccumulator(onText);
	const reader = body.getReader();
	const decoder = new TextDecoder();
	for (; ;) {
		const { done, value } = await reader.read();
		if (done) { break; }
		acc.feed(decoder.decode(value, { stream: true }));
	}
	acc.feed(decoder.decode());
	acc.end();
	return acc.result();
}

const PROVIDER_SECRET: Record<ProviderKind, string> = {
	anthropic: 'riaf.provider.anthropic', openai: 'riaf.provider.openai', gemini: 'riaf.provider.gemini',
	ollama: '', openaiCompatible: 'riaf.provider.openaiCompatible',
};

let providerSecret: (key: string) => PromiseLike<string | undefined> = async () => undefined;
export function setProviderSecrets(get: (key: string) => PromiseLike<string | undefined>): void { providerSecret = get; }

class NativeProviderTransport implements ModelTransport {
	readonly id: string;
	readonly providerName: ProviderName;
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
	constructor(private readonly kind: ProviderKind, readonly modelName: string, private readonly baseUrl: string, private readonly apiKey: string, private readonly settings: RiafSettings) {
		const name = kind === 'openai' || kind === 'openaiCompatible' ? 'openAI' : kind;
		this.providerName = name === 'openAI' && kind === 'openaiCompatible' ? 'openAICompatible' : name;
		this.id = `${kind}:${modelName}`;
		const caps = getModelCapabilities(this.providerName, modelName, undefined);
		this.contextWindow = caps.contextWindow ?? 128_000;
		this.maxOutputTokens = caps.reservedOutputTokenSpace ?? 8_192;
	}
	async call(req: TransportRequest): Promise<TransportResult> {
		const messages: ProviderMessage[] = req.messages.map(message => {
			if (message.role === 'tool') { return { role: 'tool', text: message.text, toolCallId: message.toolCallId, name: message.name }; }
			if (message.role === 'assistant') { return { role: 'assistant', text: message.text, toolCalls: message.toolCalls }; }
			return { role: 'user', text: message.text };
		});
		const built = buildProviderRequest({
			kind: this.kind, model: this.modelName, url: this.baseUrl, apiKey: this.apiKey,
			system: [req.systemMessage, req.volatileSystemMessage ?? ''].filter(Boolean).join('\n\n'),
			messages, tools: req.tools, maxOutputTokens: req.maxOutputTokens ?? this.maxOutputTokens,
			reasoning: { enabled: this.settings.providers.reasoningEnabled, budget: this.settings.providers.reasoningBudget, effort: this.settings.providers.reasoningEffort },
			overrides: this.settings.providers.overrides,
		});
		const doFetch = await outboundFetch();
		const res = await doFetch(built.url, { method: 'POST', headers: built.headers, body: JSON.stringify(built.body), signal: req.signal });
		if (!res.ok) { throw new Error(`${this.kind} ${res.status}: ${(await res.text()).slice(0, 500)}`); }
		const parsed = parseProviderResponse(this.kind, await res.json());
		if (parsed.text) { req.onText?.(parsed.text); }
		return {
			text: parsed.text, toolCalls: parsed.toolCalls, stopReason: parsed.stopReason,
			usage: { inputTokens: parsed.inputTokens ?? 0, outputTokens: parsed.outputTokens ?? 0, cacheReadTokens: parsed.cacheReadTokens ?? 0 },
		};
	}
}

function nativeSelection(s: RiafSettings, modelOverride?: string): { kind: ProviderKind; model: string; url: string } | undefined {
	const active = s.providers.active;
	if (!active || active === 'gateway') { return undefined; }
	const configured = active === 'anthropic' ? s.providers.anthropicModel : active === 'openai' ? s.providers.openaiModel : active === 'gemini' ? s.providers.geminiModel : active === 'ollama' ? s.providers.ollamaModel : s.providers.compatibleModel;
	const model = modelOverride || configured;
	if (!model) { return undefined; }
	const url = active === 'ollama' ? s.providers.ollamaUrl : active === 'openaiCompatible' ? s.providers.compatibleUrl : '';
	return { kind: active, model, url };
}

/** Pick the transport from settings: a native provider, else the gateway, else whatever vscode.lm offers.
 *  `modelOverride` (a per-purpose model id) wins over the provider model, `riaf.models.main`, and `riaf.gateway.model`. */
export async function createTransport(preferred?: vscode.LanguageModelChat, modelOverride?: string): Promise<ModelTransport | undefined> {
	const s = readSettings();
	const native = nativeSelection(s, modelOverride);
	if (native) {
		const key = native.kind === 'ollama' ? '' : (await providerSecret(PROVIDER_SECRET[native.kind])) ?? '';
		if (native.kind !== 'ollama' && native.kind !== 'openaiCompatible' && !key) { return undefined; }
		return new NativeProviderTransport(native.kind, native.model, native.url, key, s);
	}
	const model = modelOverride || s.models.main || s.gateway.model;
	if (s.gateway.url && model) { return new GatewayTransport({ ...s, gateway: { ...s.gateway, model } }); }
	return VscodeLmTransport.create(preferred);
}
