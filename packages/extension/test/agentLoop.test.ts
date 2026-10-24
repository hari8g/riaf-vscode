import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RiafIndex } from '@bosch-mps/riaf-core';
import { runAgent } from '../src/agentLoop.js';
import type { ModelTransport, TransportRequest, TransportResult } from '../src/modelTransport.js';
import { UsageMeter } from '../src/usage.js';
import { readSettings } from '../src/config.js';

/** Scripted model: each call pops the next canned response; records what it was sent. */
const scripted = (responses: TransportResult[]): ModelTransport & { seen: TransportRequest[] } => {
	const seen: TransportRequest[] = [];
	return {
		id: 'fake', providerName: 'liteLLM', modelName: 'claude-sonnet-4-5', contextWindow: 200_000, maxOutputTokens: 8192, seen,
		async call(req) { seen.push(req); const r = responses.shift(); if (!r) { throw new Error('script exhausted'); } r.usage ??= { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 }; return r; },
	};
};
const stream = () => { const md: string[] = []; return { md, markdown: (s: string) => md.push(s), progress: () => { }, reference: () => { }, button: () => { }, anchor: () => { }, filetree: () => { }, push: () => { } } as any; };
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() { } }) } as any;
const memento = () => { const m = new Map<string, unknown>(); return { get: (k: string, d: unknown) => m.get(k) ?? d, update: async (k: string, v: unknown) => { m.set(k, v); }, keys: () => [...m.keys()] } as any; };

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'riaf-ext-'));
	mkdirSync(join(root, 'src'));
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', scripts: { test: 'node -e "process.exit(0)"' } }));
	writeFileSync(join(root, 'src', 'calc.ts'), 'export function add(a: number, b: number) {\n  return a - b; // bug\n}\n');
	const index = await RiafIndex.open({ workspaceRoot: root, dbPath: ':memory:' });
	await index.reindex();
	return { root, index, folder: { uri: { fsPath: root }, name: 'fx', index: 0 } as any };
}

describe('runAgent', () => {
	it('plans, searches, edits with one combined edit_file call, verifies, and stops', async () => {
		const { root, index, folder } = await fixture();
		const edit = { id: 't2', name: 'edit_file', args: { filePath: 'src/calc.ts', edits: [{ search: 'return a - b; // bug', replace: 'return a + b;' }] } };
		const transport = scripted([
			{ text: '- Search for add\n- Edit src/calc.ts\n- Run tests', toolCalls: [], stopReason: 'end' },           // plan side-call
			{ text: '', toolCalls: [{ id: 't1', name: 'search_codebase', args: { query: 'add' } }], stopReason: 'tool_calls' },
			{ text: 'Fixing the operator.', toolCalls: [edit], stopReason: 'tool_calls' },
			{ text: 'Done: fixed add() in src/calc.ts.', toolCalls: [], stopReason: 'end' },                       // → auto-verify runs
		]);
		const s = readSettings(); s.agent.requireEditApproval = false;
		const st = stream();
		const r = await runAgent({ transport, index, folder, settings: s, usage: new UsageMeter(memento()), mode: 'agent', userPrompt: 'fix the add bug', history: [], stream: st, token, log: () => { } });
		expect(r.stopped).toBe('done');
		expect(r.editedFiles).toEqual(['src/calc.ts']);
		expect(readFileSync(join(root, 'src/calc.ts'), 'utf8')).toContain('return a + b;');
		// verification result was fed back into history
		expect(r.history.some(m => m.role === 'tool' && m.name === 'run_tests')).toBe(true);
		// plan ticked off in the final render
		expect(st.md.join('')).toMatch(/\[x\] Edit src\/calc\.ts/);
		// the stable system prompt carries the workspace profile; hints go in the volatile part
		expect(transport.seen[1].systemMessage).toContain('<workspace_profile>');
		expect(transport.seen[1].volatileSystemMessage).toContain('Plan status');
		await index.close();
	});

	it('skips a duplicate read_file and credits the saving', async () => {
		const { index, folder } = await fixture();
		const read = (id: string) => ({ id, name: 'read_file', args: { filePath: 'src/calc.ts' } });
		const transport = scripted([
			{ text: '', toolCalls: [read('a')], stopReason: 'tool_calls' },
			{ text: '', toolCalls: [read('b')], stopReason: 'tool_calls' },
			{ text: 'ok', toolCalls: [], stopReason: 'end' },
		]);
		const s = readSettings(); s.agent.generatePlan = false; s.agent.autoVerify = false;
		const usage = new UsageMeter(memento());
		const r = await runAgent({ transport, index, folder, settings: s, usage, mode: 'explain', userPrompt: 'explain calc', history: [], stream: stream(), token, log: () => { } });
		const toolMsgs = r.history.filter(m => m.role === 'tool') as any[];
		expect(toolMsgs).toHaveLength(2);
		expect(toolMsgs[0].type).toBe('success');
		expect(toolMsgs[1].type).toBe('tool_error');          // duplicate blocked locally, never hit the FS
		expect(usage.session.savedTokens).toBeGreaterThan(0);
		await index.close();
	});

	it('plan/explain modes expose read-only tools only', async () => {
		const { index, folder } = await fixture();
		const transport = scripted([{ text: 'plan', toolCalls: [], stopReason: 'end' }]);
		const s = readSettings(); s.agent.generatePlan = false;
		await runAgent({ transport, index, folder, settings: s, usage: new UsageMeter(memento()), mode: 'plan', userPrompt: 'x', history: [], stream: stream(), token, log: () => { } });
		const names = transport.seen[0].tools!.map(t => t.name);
		expect(names).toContain('search_codebase');
		expect(names).not.toContain('edit_file');
		expect(names).not.toContain('run_command');
		await index.close();
	});
});
