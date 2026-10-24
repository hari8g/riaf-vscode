import * as vscode from 'vscode';
import {
	applyRoutedAnthropicConversationCache, applyRoutedAnthropicPromptCache, getModelCapabilities,
	usageFromOpenAIResponse, type LLMMessageUsage, type ProviderName,
} from '@bosch-mps/token-opt';
import { readSettings, type RiafSettings } from './config.js';

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

		const body = {
			model: this.modelName,
			messages: wire,
			max_tokens: req.maxOutputTokens ?? this.maxOutputTokens,
			stream: false,
			...(req.tools?.length ? { tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })), tool_choice: 'auto' } : {}),
		};
		const res = await fetch(`${this._s.gateway.url}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal });
		if (!res.ok) { throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 500)}`); }
		const json = await res.json() as any;
		const choice = json.choices?.[0];
		const text: string = choice?.message?.content ?? '';
		if (text) { req.onText?.(text); }
		const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((tc: any) => ({
			id: tc.id, name: tc.function?.name, args: safeJson(tc.function?.arguments),
		}));
		const finish = choice?.finish_reason;
		return {
			text, toolCalls, usage: usageFromOpenAIResponse(json.usage),
			stopReason: finish === 'tool_calls' || toolCalls.length ? 'tool_calls' : finish === 'length' ? 'length' : finish === 'stop' ? 'end' : 'other',
		};
	}
}

const safeJson = (s: unknown): Record<string, unknown> => {
	if (typeof s !== 'string') { return (s as Record<string, unknown>) ?? {}; }
	try { return JSON.parse(s); } catch { return { _raw: s }; }
};

/** Pick the transport from settings: gateway if configured, else whatever vscode.lm offers. */
export async function createTransport(preferred?: vscode.LanguageModelChat): Promise<ModelTransport | undefined> {
	const s = readSettings();
	if (s.gateway.url && s.gateway.model) { return new GatewayTransport(s); }
	return VscodeLmTransport.create(preferred);
}
