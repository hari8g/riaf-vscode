/**
 * P0: gateway SSE streaming, and org-index / git queries exposed as agent tools.
 */
import { describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RiafIndex } from '@bosch-mps/riaf-core';
import { OpenAIStreamAccumulator, parseOpenAIResponse } from '../src/modelTransport.js';
import { executeTool, READ_ONLY_TOOLS, TOOL_SPECS } from '../src/tools/toolRegistry.js';
import { ORG_TOOL_SPECS } from '../src/tools/orgTools.js';

const SAMPLE_REPO = join(__dirname, '..', '..', 'riaf-core', 'test', 'fixtures', 'sample-repo');

const sse = (events: unknown[]) => events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');

describe('OpenAIStreamAccumulator', () => {
	it('stitches text deltas, tool-call fragments and usage from an SSE stream split at arbitrary points', () => {
		const deltas: string[] = [];
		const acc = new OpenAIStreamAccumulator(d => deltas.push(d));
		const raw = sse([
			{ choices: [{ index: 0, delta: { role: 'assistant', content: 'Fixing ' } }] },
			{ choices: [{ index: 0, delta: { content: 'the operator.' } }] },
			{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'edit_file', arguments: '{"filePath":' } }] } }] },
			{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"src/calc.ts","edits":[]}' } }] } }] },
			{ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'run_tests', arguments: '{}' } }] } }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
			{ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 1000 } } },
			'[DONE]',
		]);
		// feed in uneven pieces to exercise line buffering
		for (let i = 0; i < raw.length; i += 17) { acc.feed(raw.slice(i, i + 17)); }
		acc.end();
		const r = acc.result();
		expect(r.text).toBe('Fixing the operator.');
		expect(deltas.join('')).toBe('Fixing the operator.');
		expect(r.toolCalls).toEqual([
			{ id: 'call_1', name: 'edit_file', args: { filePath: 'src/calc.ts', edits: [] } },
			{ id: 'call_2', name: 'run_tests', args: {} },
		]);
		expect(r.stopReason).toBe('tool_calls');
		expect(r.usage?.inputTokens).toBe(1200);
		expect(r.usage?.outputTokens).toBe(40);
		expect(r.usage?.cacheReadTokens).toBe(1000);
	});

	it('reports `length` even when tool calls are present and keeps unparsable arguments as _raw', () => {
		const acc = new OpenAIStreamAccumulator();
		acc.feed(sse([
			{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'rewrite_file', arguments: '{"filePath":"a.ts","content":"partial' } }] } }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
		]));
		acc.end();
		const r = acc.result();
		expect(r.stopReason).toBe('length');
		expect(r.toolCalls[0].args).toEqual({ _raw: '{"filePath":"a.ts","content":"partial' });
	});

	it('ignores comments, blank keep-alives and malformed events; handles CRLF', () => {
		const acc = new OpenAIStreamAccumulator();
		acc.feed(': keep-alive\r\n\r\ndata: {not json}\r\n\r\n');
		acc.feed(sse([{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }]).replace(/\n/g, '\r\n'));
		acc.end();
		expect(acc.result()).toMatchObject({ text: 'ok', toolCalls: [], stopReason: 'end' });
	});

	it('parseOpenAIResponse handles the non-streaming body the same way', () => {
		const texts: string[] = [];
		const r = parseOpenAIResponse({
			choices: [{ message: { content: 'hello', tool_calls: [{ id: 'x', function: { name: 'ls_dir', arguments: '{"dirPath":"src"}' } }] }, finish_reason: 'tool_calls' }],
			usage: { prompt_tokens: 10, completion_tokens: 5 },
		}, d => texts.push(d));
		expect(r.text).toBe('hello');
		expect(texts).toEqual(['hello']);
		expect(r.toolCalls).toEqual([{ id: 'x', name: 'ls_dir', args: { dirPath: 'src' } }]);
		expect(r.stopReason).toBe('tool_calls');
		expect(r.usage?.inputTokens).toBe(10);
	});
});

describe('org-index and git tools', () => {
	const open = async () => {
		const dir = mkdtempSync(join(tmpdir(), 'riaf-orgtools-'));
		const root = join(dir, 'repo');
		cpSync(SAMPLE_REPO, root, { recursive: true });
		const index = await RiafIndex.open({ workspaceRoot: root, dbPath: ':memory:' });
		await index.reindex();
		const ctx = { folder: { uri: { fsPath: root }, name: 'repo', index: 0 } as any, index, requireEditApproval: false, allowRunCommand: false, readOnly: true };
		return { dir, index, ctx };
	};

	it('are registered as read-only tools with matching specs', () => {
		for (const spec of ORG_TOOL_SPECS) {
			expect(READ_ONLY_TOOLS.has(spec.name), spec.name).toBe(true);
			expect(TOOL_SPECS.find(t => t.name === spec.name)).toBe(spec);
		}
		expect(ORG_TOOL_SPECS.map(t => t.name)).toEqual([
			'get_service_topology', 'resolve_api_contract', 'get_dependency_impact', 'get_config_drift', 'get_infra_resources', 'get_git_context',
		]);
	});

	it('answer from the org index (topology, contract, dependency impact) even in read-only mode', async () => {
		const { dir, index, ctx } = await open();
		try {
			const topo = await executeTool('get_service_topology', {}, ctx);
			expect(topo.ok).toBe(true);
			expect((topo as any).result).toContain('2 endpoints');
			expect((topo as any).result).toContain('POST /api/orders');

			const contract = await executeTool('resolve_api_contract', { httpMethod: 'post', pathPattern: '/api/orders' }, ctx);
			expect((contract as any).result).toContain('OrderController.createOrder');
			expect((contract as any).result).toContain('CreateOrderRequest');

			const miss = await executeTool('resolve_api_contract', { httpMethod: 'GET', pathPattern: '/nope' }, ctx);
			expect((miss as any).result).toMatch(/No endpoint matches/);

			const impact = await executeTool('get_dependency_impact', { name: 'ms-data-model' }, ctx);
			expect((impact as any).result).toContain('java/pom.xml');
			const none = await executeTool('get_dependency_impact', { name: 'left-pad-zz' }, ctx);
			expect((none as any).result).toMatch(/Nothing in this repo depends/);

			const drift = await executeTool('get_config_drift', { serviceName: 'orders' }, ctx);
			expect(drift.ok).toBe(true);

			const infra = await executeTool('get_infra_resources', { kind: 'pipeline' }, ctx);
			expect((infra as any).result).toMatch(/No CI pipeline jobs indexed/);
			const badKind = await executeTool('get_infra_resources', { kind: 'helm' }, ctx);
			expect((badKind as any).result).toMatch(/kind must be one of/);
		} finally {
			await index.close();
			rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	});

	it('grep and glob tools are read-only and answer through the index exclusions', async () => {
		const { dir, index, ctx } = await open();
		try {
			expect(READ_ONLY_TOOLS.has('grep') && READ_ONLY_TOOLS.has('glob')).toBe(true);
			const g = await executeTool('grep', { pattern: 'capturePayment', include: 'src/**/*.ts' }, ctx);
			expect(g.ok).toBe(true);
			expect((g as any).result).toMatch(/src\/orderService\.ts\n\s+29: /);
			expect((g as any).result).not.toContain('generated/');
			const re = await executeTool('grep', { pattern: 'class \\w+Service', regex: true, context: 1 }, ctx);
			expect((re as any).result).toContain('export class OrderService');
			const files = await executeTool('glob', { pattern: '**/*.java' }, ctx);
			expect((files as any).result.split('\n')).toEqual(expect.arrayContaining([expect.stringMatching(/OrderController\.java$/)]));
			const empty = await executeTool('grep', { pattern: '   ' }, ctx);
			expect((empty as any).result).toMatch(/non-empty/);
		} finally {
			await index.close();
			rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	});

	it('get_git_context degrades gracefully outside a git repository', async () => {
		const { dir, index, ctx } = await open();
		try {
			const r = await executeTool('get_git_context', {}, ctx);
			expect(r.ok).toBe(true);
			expect((r as any).result).toMatch(/Not a git repository/);
		} finally {
			await index.close();
			rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	});
});
