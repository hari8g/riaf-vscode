import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeClaudeHooks } from '../src/claudeHooks.js';
import { buildFimPrompt } from '../src/fim.js';
import { formatNotes, selectNotes } from '../src/notes.js';
import { buildProviderRequest, ollamaModelNames, parseProviderResponse, probeOllama, visibleModels } from '../src/providerHttp.js';
import { UsageMeter } from '../src/usage.js';

const memento = () => { const m = new Map<string, unknown>(); return { get: (k: string, d: unknown) => m.get(k) ?? d, update: async (k: string, v: unknown) => { m.set(k, v); } } as any; };

describe('phase D providers, hooks, and usage', () => {
	it('builds Anthropic, OpenAI, and Gemini requests and parses their replies', () => {
		const anthropic = buildProviderRequest({
			kind: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk', system: 'be brief',
			messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: '', toolCalls: [{ id: 't1', name: 'read_file', args: { filePath: 'a.ts' } }] }, { role: 'tool', text: 'contents', toolCallId: 't1' }],
			tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }],
			maxOutputTokens: 128,
			reasoning: { enabled: true, budget: 200 }, overrides: { temperature: 0 },
		});
		expect(anthropic.url).toBe('https://api.anthropic.com/v1/messages');
		expect(anthropic.headers['anthropic-beta']).toContain('output-128k');
		expect(anthropic.headers['x-api-key']).toBe('sk');
		expect(anthropic.body.thinking).toEqual({ type: 'enabled', budget_tokens: 200 });
		expect(anthropic.body.temperature).toBe(0);
		expect(anthropic.body.max_tokens).toBe(456);
		const parsed = parseProviderResponse('anthropic', { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'read_file', input: { filePath: 'a.ts' } }], stop_reason: 'tool_use', usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 2 } });
		expect(parsed.toolCalls[0]).toMatchObject({ name: 'read_file' });
		expect(parsed.cacheReadTokens).toBe(2);

		const openai = buildProviderRequest({ kind: 'openai', model: 'gpt-4.1', apiKey: 'k', system: 's', messages: [{ role: 'user', text: 'hi' }], reasoning: { enabled: true, effort: 'low' } });
		expect(openai.url).toBe('https://api.openai.com/v1/chat/completions');
		expect(openai.body.reasoning_effort).toBe('low');
		expect(parseProviderResponse('openai', { choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }).text).toBe('pong');

		const gemini = buildProviderRequest({ kind: 'gemini', model: 'gemini-2.5-pro', apiKey: 'g', system: 's', messages: [{ role: 'user', text: 'hi' }] });
		expect(gemini.url).toContain('generativelanguage.googleapis.com');
		expect(parseProviderResponse('gemini', { candidates: [{ content: { parts: [{ functionCall: { name: 'grep', args: { pattern: 'a' } } }] }, finishReason: 'STOP' }] }).toolCalls[0].name).toBe('grep');
	});

	it('lists Ollama models, hides ids, and reports cache efficiency per provider', async () => {
		expect(ollamaModelNames({ models: [{ name: 'qwen2.5-coder:7b' }, { name: '' }] })).toEqual(['qwen2.5-coder:7b']);
		expect(visibleModels(['a', 'b'], ['b'], ['c'])).toEqual(['a', 'c']);
		const names = await probeOllama('http://ollama.test', (async () => new Response(JSON.stringify({ models: [{ name: 'llama3' }] }), { status: 200 })) as typeof fetch);
		expect(names).toEqual(['llama3']);
		const usage = new UsageMeter(memento());
		usage.record({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 30 }, { provider: 'anthropic', model: 'claude', purpose: 'agent' });
		expect(usage.byProvider['anthropic:claude'].calls).toBe(1);
		expect(usage.cacheEfficiency()).toBeCloseTo(0.75);
		const once = mergeClaudeHooks({ env: { A: '1' } }, '/repo');
		const twice = mergeClaudeHooks(once, '/repo');
		expect(JSON.stringify(twice).match(/gate\.mjs/g)).toHaveLength(2);
		expect((twice as { env: { A: string } }).env.A).toBe('1');
	});
});

describe('phase F editor prompts', () => {
	it('builds a FIM prompt and selects notepads', () => {
		const prompt = buildFimPrompt({ prefix: 'const a = ', suffix: ';', context: 'src/util.ts', instruction: 'add one' });
		expect(prompt).toContain('<fim_prefix>');
		expect(prompt).toContain('src/util.ts');
		expect(prompt.endsWith('<fim_middle>')).toBe(true);
		const notes = [{ name: 'api.md', text: 'use the client' }, { name: 'other.md', text: 'no' }];
		expect(selectNotes('see #riafNote:api', notes).map(n => n.name)).toEqual(['api.md']);
		expect(selectNotes('see #riafNote', notes)).toHaveLength(2);
		expect(selectNotes('no marker', notes)).toEqual([]);
		expect(formatNotes(selectNotes('#riafNote:api', notes))).toContain('use the client');
	});
});

describe('phase C stop hook', () => {
	it('exits 2 while a run is open and blocks a denied command', () => {
		const repo = mkdtempSync(join(tmpdir(), 'riaf-gate-'));
		mkdirSync(join(repo, '.riaf', 'runs'), { recursive: true });
		writeFileSync(join(repo, '.riaf', 'runs', 'r1.json'), JSON.stringify({ id: 'r1', status: 'running', updatedAt: 1 }));
		const gate = join(__dirname, '../plugin/hooks/gate.mjs');
		const open = spawnSync(process.execPath, [gate, 'stop', repo], { encoding: 'utf8' });
		expect(open.status).toBe(2);
		writeFileSync(join(repo, '.riaf', 'runs', 'r1.json'), JSON.stringify({ id: 'r1', status: 'done', updatedAt: 2 }));
		expect(spawnSync(process.execPath, [gate, 'stop', repo], { encoding: 'utf8' }).status).toBe(0);
		const denied = spawnSync(process.execPath, [gate, 'pretool'], { input: JSON.stringify({ tool_input: { command: 'sudo ls' } }), encoding: 'utf8' });
		expect(denied.status).toBe(2);
		const allowed = spawnSync(process.execPath, [gate, 'pretool'], { input: JSON.stringify({ tool_input: { command: 'npm test' } }), encoding: 'utf8' });
		expect(allowed.status).toBe(0);
	});
});
