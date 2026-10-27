/** Native provider HTTP bodies and parsers. Fetch is injected so tests never touch the network. */

export type ProviderKind = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'openaiCompatible';

export type ProviderMessage = {
	role: 'user' | 'assistant' | 'tool';
	text: string;
	toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
	toolCallId?: string;
	name?: string;
};

export type ProviderTool = { name: string; description: string; inputSchema: Record<string, unknown> };

export type ProviderCall = {
	kind: ProviderKind;
	model: string;
	url?: string;
	apiKey?: string;
	system: string;
	messages: ProviderMessage[];
	tools?: ProviderTool[];
	maxOutputTokens?: number;
	reasoning?: { enabled?: boolean; budget?: number; effort?: string };
	overrides?: Record<string, unknown>;
};

export type ProviderHttpRequest = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

const openAIMessages = (system: string, messages: ProviderMessage[]) => [
	{ role: 'system', content: system },
	...messages.map(message => {
		if (message.role === 'tool') { return { role: 'tool', tool_call_id: message.toolCallId, name: message.name, content: message.text }; }
		if (message.role === 'assistant' && message.toolCalls?.length) {
			return {
				role: 'assistant', content: message.text || null,
				tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })),
			};
		}
		return { role: message.role, content: message.text };
	}),
];

export function buildProviderRequest(call: ProviderCall): ProviderHttpRequest {
	const maxTokens = call.maxOutputTokens ?? 1024;
	if (call.kind === 'anthropic') {
		const messages: { role: string; content: unknown }[] = [];
		for (const message of call.messages) {
			if (message.role === 'tool') {
				const block = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.text };
				const last = messages[messages.length - 1];
				if (last?.role === 'user' && Array.isArray(last.content)) { last.content.push(block); }
				else { messages.push({ role: 'user', content: [block] }); }
			} else if (message.toolCalls?.length) {
				messages.push({
					role: 'assistant',
					content: [
						...(message.text ? [{ type: 'text', text: message.text }] : []),
						...message.toolCalls.map(tool => ({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.args })),
					],
				});
			} else { messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.text }); }
		}
		const body: Record<string, unknown> = {
			model: call.model,
			max_tokens: maxTokens,
			system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
			messages,
		};
		if (call.tools?.length) {
			body.tools = call.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
		}
		if (call.reasoning?.enabled && (call.reasoning.budget ?? 0) > 0) {
			body.thinking = { type: 'enabled', budget_tokens: call.reasoning.budget };
			body.max_tokens = Math.max(maxTokens, (call.reasoning.budget ?? 0) + 256);
		}
		return {
			url: 'https://api.anthropic.com/v1/messages',
			headers: {
				'content-type': 'application/json',
				'x-api-key': call.apiKey ?? '',
				'anthropic-version': '2023-06-01',
				'anthropic-beta': 'prompt-caching-2024-07-31,output-128k-2025-02-19',
			},
			body: { ...body, ...(call.overrides ?? {}) },
		};
	}
	if (call.kind === 'gemini') {
		const body: Record<string, unknown> = {
			systemInstruction: { parts: [{ text: call.system }] },
			contents: call.messages.filter(m => m.role !== 'tool').map(message => ({
				role: message.role === 'assistant' ? 'model' : 'user',
				parts: message.toolCalls?.length
					? message.toolCalls.map(tool => ({ functionCall: { name: tool.name, args: tool.args } }))
					: [{ text: message.text }],
			})),
			generationConfig: { maxOutputTokens: maxTokens },
		};
		if (call.tools?.length) {
			body.tools = [{ functionDeclarations: call.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })) }];
		}
		const key = encodeURIComponent(call.apiKey ?? '');
		return {
			url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(call.model)}:generateContent?key=${key}`,
			headers: { 'content-type': 'application/json' },
			body: { ...body, ...(call.overrides ?? {}) },
		};
	}
	const base = (call.url || (call.kind === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
	const path = call.kind === 'ollama' ? '/api/chat' : '/chat/completions';
	const body: Record<string, unknown> = {
		model: call.model,
		messages: openAIMessages(call.system, call.messages),
		stream: false,
	};
	if (call.kind === 'ollama') { body.options = { num_predict: maxTokens }; }
	else { body.max_tokens = maxTokens; }
	if (call.tools?.length && call.kind !== 'ollama') {
		body.tools = call.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
		body.tool_choice = 'auto';
	}
	if (call.reasoning?.enabled && call.reasoning.effort) { body.reasoning_effort = call.reasoning.effort; }
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (call.apiKey && call.kind !== 'ollama') { headers.authorization = `Bearer ${call.apiKey}`; }
	return { url: `${base}${path}`, headers, body: { ...body, ...(call.overrides ?? {}) } };
}

export type ParsedProvider = { text: string; toolCalls: { id: string; name: string; args: Record<string, unknown> }[]; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; stopReason: 'end' | 'tool_calls' | 'length' | 'other' };

export function parseProviderResponse(kind: ProviderKind, json: unknown): ParsedProvider {
	const body = (json ?? {}) as Record<string, any>;
	if (kind === 'anthropic') {
		const blocks = Array.isArray(body.content) ? body.content : [];
		const text = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text ?? '').join('');
		const toolCalls = blocks.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ id: String(b.id ?? ''), name: String(b.name ?? ''), args: (b.input ?? {}) as Record<string, unknown> }));
		const stop = body.stop_reason === 'max_tokens' ? 'length' : toolCalls.length ? 'tool_calls' : body.stop_reason === 'end_turn' ? 'end' : 'other';
		return { text, toolCalls, inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens, cacheReadTokens: body.usage?.cache_read_input_tokens, stopReason: stop };
	}
	if (kind === 'gemini') {
		const parts = body.candidates?.[0]?.content?.parts ?? [];
		const text = parts.filter((p: any) => typeof p.text === 'string').map((p: any) => p.text).join('');
		const toolCalls = parts.filter((p: any) => p.functionCall).map((p: any, i: number) => ({ id: `gemini_${i}`, name: String(p.functionCall.name ?? ''), args: (p.functionCall.args ?? {}) as Record<string, unknown> }));
		const finish = body.candidates?.[0]?.finishReason;
		return { text, toolCalls, inputTokens: body.usageMetadata?.promptTokenCount, outputTokens: body.usageMetadata?.candidatesTokenCount, stopReason: finish === 'MAX_TOKENS' ? 'length' : toolCalls.length ? 'tool_calls' : 'end' };
	}
	if (kind === 'ollama' && !body.choices) {
		const message = body.message ?? {};
		const toolCalls = (message.tool_calls ?? []).map((tool: any, i: number) => ({ id: `ollama_${i}`, name: String(tool.function?.name ?? ''), args: (tool.function?.arguments ?? {}) as Record<string, unknown> }));
		return { text: message.content ?? '', toolCalls, inputTokens: body.prompt_eval_count, outputTokens: body.eval_count, stopReason: toolCalls.length ? 'tool_calls' : 'end' };
	}
	const choice = body.choices?.[0];
	const text = choice?.message?.content ?? '';
	const toolCalls = (choice?.message?.tool_calls ?? []).map((tool: any) => {
		let args: Record<string, unknown> = {};
		try { args = JSON.parse(tool.function?.arguments ?? '{}'); } catch { args = { _raw: tool.function?.arguments }; }
		return { id: String(tool.id ?? ''), name: String(tool.function?.name ?? ''), args };
	});
	const finish = choice?.finish_reason;
	return { text, toolCalls, inputTokens: body.usage?.prompt_tokens, outputTokens: body.usage?.completion_tokens, stopReason: finish === 'length' ? 'length' : toolCalls.length ? 'tool_calls' : finish === 'stop' ? 'end' : 'other' };
}

export function ollamaModelNames(json: unknown): string[] {
	const models = (json as { models?: { name?: string }[] })?.models ?? [];
	return models.map(model => model.name ?? '').filter(Boolean);
}

export function visibleModels(discovered: string[], hidden: string[], custom: string[]): string[] {
	const hide = new Set(hidden);
	return [...new Set([...discovered, ...custom])].filter(id => id && !hide.has(id));
}

export async function probeOllama(base: string, fetchImpl: typeof fetch): Promise<string[]> {
	const res = await fetchImpl(`${base.replace(/\/+$/, '')}/api/tags`);
	if (!res.ok) { return []; }
	return ollamaModelNames(await res.json());
}
