/**
 * P2: find_references / get_neighbors tools, language-server preference, and the one-hop
 * neighbourhood that precedes an edit in the agent loop.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { RiafIndex } from '@bosch-mps/riaf-core';
import { executeTool, READ_ONLY_TOOLS, TOOL_SPECS } from '../src/tools/toolRegistry.js';
import { executeGraphTool, GRAPH_TOOL_SPECS } from '../src/tools/graphTools.js';
import { runAgent } from '../src/agentLoop.js';
import type { ModelTransport, TransportRequest, TransportResult } from '../src/modelTransport.js';
import { UsageMeter } from '../src/usage.js';
import { readSettings } from '../src/config.js';

const SAMPLE_REPO = join(__dirname, '..', '..', 'riaf-core', 'test', 'fixtures', 'sample-repo');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); (vscode.commands as any).executeCommand = async () => undefined; });

async function sampleIndex() {
	const root = mkdtempSync(join(tmpdir(), 'riaf-p2-'));
	dirs.push(root);
	cpSync(SAMPLE_REPO, root, { recursive: true });
	const index = await RiafIndex.open({ workspaceRoot: root, dbPath: ':memory:' });
	await index.reindex();
	const folder = { uri: { fsPath: root }, name: 'sample', index: 0 } as any;
	return { root, index, folder, ctx: { folder, index, requireEditApproval: false, allowRunCommand: false } };
}

describe('graph tools', () => {
	it('are registered as read-only tools for the agent and share one implementation with MCP', async () => {
		for (const spec of GRAPH_TOOL_SPECS) {
			expect(TOOL_SPECS.some(t => t.name === spec.name)).toBe(true);
			expect(READ_ONLY_TOOLS.has(spec.name)).toBe(true);
		}
		const { index, ctx } = await sampleIndex();
		const viaRegistry = await executeTool('get_neighbors', { filePath: 'src/orderService.ts' }, ctx);
		const viaMcp = await executeGraphTool(index, 'get_neighbors', { filePath: 'src/orderService.ts' });
		expect(viaRegistry.ok && viaRegistry.result).toBe(viaMcp);
		expect(viaMcp).toContain('capturePayment called by src/orderService.test.ts:');
		expect(viaMcp).toMatch(/uses: .*from src\/logger\.ts/);
		await index.close();
	});

	it('find_references answers from the static graph with definitions, call sites and enclosing symbols', async () => {
		const { index, ctx } = await sampleIndex();
		const r = await executeTool('find_references', { name: 'OrderService' }, ctx);
		expect(r.ok).toBe(true);
		const text = r.ok ? r.result : '';
		expect(text).toMatch(/Definitions of OrderService:\n- class src\/orderService\.ts:\d+/);
		expect(text).toContain('(static graph)');
		expect(text).toMatch(/- src\/index\.ts:\d+ instantiates/);
		expect(text).toMatch(/- src\/orderService\.test\.ts:\d+ instantiates/);
		expect(text).toMatch(/- src\/index\.ts:\d+ imports/);
		const none = await executeTool('find_references', { name: 'doesNotExistAnywhere' }, ctx);
		expect(none.ok && none.result).toMatch(/No definition .* symbol index/);
		const bad = await executeTool('find_references', {}, ctx);
		expect(bad.ok).toBe(false);
		await index.close();
	});

	it('prefers language-server references when a provider answers, and ignores the definition itself', async () => {
		const { root, index, ctx } = await sampleIndex();
		const calls: unknown[][] = [];
		(vscode.commands as any).executeCommand = async (...args: unknown[]) => {
			calls.push(args);
			if (args[0] !== 'vscode.executeReferenceProvider') { return undefined; }
			const mk = (rel: string, line: number) => new vscode.Location(vscode.Uri.file(join(root, rel)), new vscode.Range(new vscode.Position(line, 4), new vscode.Position(line, 20)));
			// the LSP returns the declaration + two usages, one of which the static graph does not know about
			return [mk('src/orderService.ts', 28), mk('src/orderService.test.ts', 8), mk('scripts/replay.ts', 3)];
		};
		const r = await executeTool('find_references', { name: 'capturePayment', filePath: 'src/orderService.ts' }, ctx);
		expect(r.ok).toBe(true);
		const text = r.ok ? r.result : '';
		expect(text).toContain('(language server)');
		expect(text).toContain('- src/orderService.test.ts:9 calls');
		expect(text).toContain('- scripts/replay.ts:4 calls');
		expect(text).not.toContain('src/orderService.ts:29 calls');
		// positioned at the symbol's definition (0-based line of `capturePayment(id: string)`), not at the doc comment
		const [, uri, pos] = calls[0] as [string, vscode.Uri, vscode.Position];
		expect(uri.fsPath).toBe(join(root, 'src/orderService.ts'));
		expect(pos.line).toBe(28);
		expect(pos.character).toBeGreaterThan(0);

		// provider present but silent → static graph
		(vscode.commands as any).executeCommand = async () => [];
		const fallback = await executeTool('find_references', { name: 'capturePayment' }, ctx);
		expect(fallback.ok && fallback.result).toContain('(static graph)');
		await index.close();
	});

	it('get_context_profile for a file includes its one-hop neighbourhood', async () => {
		const { index, ctx } = await sampleIndex();
		const r = await executeTool('get_context_profile', { filePath: 'src/orderService.ts' }, ctx);
		expect(r.ok && r.result).toContain('Dependents and dependencies of src/orderService.ts');
		await index.close();
	});
});

/* ───────────── agent loop: one hop before the edit ───────────── */

const scripted = (responses: TransportResult[]): ModelTransport & { seen: TransportRequest[] } => {
	const seen: TransportRequest[] = [];
	return {
		id: 'fake', providerName: 'liteLLM', modelName: 'claude-sonnet-4-5', contextWindow: 200_000, maxOutputTokens: 8192, seen,
		async call(req) { seen.push(req); const r = responses.shift(); if (!r) { throw new Error('script exhausted'); } r.usage ??= { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 }; return r; },
	};
};
const stream = () => ({ md: [] as string[], markdown(s: string) { this.md.push(s); }, progress() { }, reference() { }, button() { }, anchor() { }, filetree() { }, push() { } }) as any;
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() { } }) } as any;
const memento = () => { const m = new Map<string, unknown>(); return { get: (k: string, d: unknown) => m.get(k) ?? d, update: async (k: string, v: unknown) => { m.set(k, v); }, keys: () => [...m.keys()] } as any; };

describe('runAgent: neighbourhood preamble', () => {
	it('puts the active file\'s callers in the stable prompt and attaches <dependents> to the first read of a file only', async () => {
		const { index, folder } = await sampleIndex();
		const transport = scripted([
			{ text: '', toolCalls: [{ id: 'r1', name: 'read_file', args: { filePath: 'src/logger.ts' } }], stopReason: 'tool_calls' },
			{ text: '', toolCalls: [{ id: 'r2', name: 'read_file', args: { filePath: 'src/logger.ts', startLine: 1, endLine: 3 } }], stopReason: 'tool_calls' },
			{ text: 'done', toolCalls: [], stopReason: 'end' },
		]);
		const s = readSettings(); s.agent.generatePlan = false; s.agent.autoVerify = false;
		const r = await runAgent({ transport, index, folder, settings: s, usage: new UsageMeter(memento()), mode: 'agent', userPrompt: 'rename createOrder', history: [], activeFile: 'src/orderService.ts', stream: stream(), token, log: () => { } });
		// stable prefix: who depends on the active file
		expect(transport.seen[0].systemMessage).toContain('<active_file_neighborhood>');
		expect(transport.seen[0].systemMessage).toContain('createOrder called by src/index.ts:');
		expect(transport.seen[0].systemMessage).toContain('find_references');
		// first read of logger.ts carries its dependents; the second (range) read does not repeat them
		const reads = r.history.filter(m => m.role === 'tool' && (m as any).name === 'read_file') as any[];
		expect(reads).toHaveLength(2);
		expect(reads[0].content).toContain('<dependents>');
		expect(reads[0].content).toMatch(/createLogger called by src\/index\.ts:\d+/);
		expect(reads[1].content).not.toContain('<dependents>');
		await index.close();
	});

	it('does not add the preamble in explain mode', async () => {
		const { index, folder } = await sampleIndex();
		const transport = scripted([
			{ text: '', toolCalls: [{ id: 'r1', name: 'read_file', args: { filePath: 'src/logger.ts' } }], stopReason: 'tool_calls' },
			{ text: 'explained', toolCalls: [], stopReason: 'end' },
		]);
		const s = readSettings(); s.agent.generatePlan = false; s.agent.autoVerify = false;
		const r = await runAgent({ transport, index, folder, settings: s, usage: new UsageMeter(memento()), mode: 'explain', userPrompt: 'explain logger', history: [], stream: stream(), token, log: () => { } });
		const read = r.history.find(m => m.role === 'tool') as any;
		expect(read.content).not.toContain('<dependents>');
		await index.close();
	});
});
