import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RiafIndex } from '@bosch-mps/riaf-core';
import { runAgent } from '../src/agentLoop.js';
import { mergeClaudeMd } from '../src/claudeCodeSetup.js';
import { runExplore } from '../src/exploreAgent.js';
import { LM_TOOLS } from '../src/lmToolCatalog.js';
import { appendMemory, extractRememberedFact, memoryPromptBlock, readMemory } from '../src/memory.js';
import { loadThread, saveThread } from '../src/threadStore.js';
import { executeTool, READ_ONLY_TOOLS, TOOL_SPECS } from '../src/tools/toolRegistry.js';
import { readSettings } from '../src/config.js';
import type { ModelTransport, TransportRequest, TransportResult } from '../src/modelTransport.js';
import { UsageMeter } from '../src/usage.js';

const scripted = (responses: TransportResult[], providerName: ModelTransport['providerName'] = 'liteLLM'): ModelTransport & { seen: TransportRequest[] } => {
	const seen: TransportRequest[] = [];
	return {
		id: 'fake', providerName, modelName: 'claude-sonnet-4-6', contextWindow: 200_000, maxOutputTokens: 8192, seen,
		async call(req) { seen.push(req); const r = responses.shift(); if (!r) { throw new Error('script exhausted'); } r.usage ??= { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 }; return r; },
	};
};
const stream = () => { const md: string[] = []; return { md, markdown: (s: string) => md.push(s), progress: () => { }, reference: () => { }, button: () => { }, anchor: () => { }, filetree: () => { }, push: () => { } } as any; };
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() { } }) } as any;
const memento = () => { const m = new Map<string, unknown>(); return { get: (k: string, d: unknown) => m.get(k) ?? d, update: async (k: string, v: unknown) => { m.set(k, v); }, keys: () => [...m.keys()] } as any; };

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'riaf-a-'));
	mkdirSync(join(root, 'src'));
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', scripts: { test: 'node -e "process.exit(0)"' } }));
	writeFileSync(join(root, 'src', 'calc.ts'), 'export function add(a: number, b: number) {\n  return a - b; // bug\n}\n');
	const index = await RiafIndex.open({ workspaceRoot: root, dbPath: ':memory:' });
	await index.reindex();
	return { root, index, folder: { uri: { fsPath: root }, name: 'fx', index: 0 } as any };
}

const quiet = (s: ReturnType<typeof readSettings>) => { s.agent.generatePlan = false; s.agent.autoVerify = false; s.agent.summarizeHistory = false; return s; };

describe('Phase A — loop hardening', () => {
	it('reuses a pending plan on "continue" and does not generate another', async () => {
		const { index, folder } = await fixture();
		const plan = { role: 'plan' as const, items: [{ text: 'Search', status: 'pending' as const }, { text: 'Edit', status: 'pending' as const }, { text: 'Verify', status: 'pending' as const }] };
		const transport = scripted([{ text: 'Continuing the plan.', toolCalls: [], stopReason: 'end' }]);
		const s = readSettings(); s.agent.autoVerify = false; s.agent.summarizeHistory = false;
		const r = await runAgent({ transport, index, folder, settings: s, usage: new UsageMeter(memento()), mode: 'agent', userPrompt: 'continue', history: [plan], stream: stream(), token, log: () => { } });
		expect(transport.seen).toHaveLength(1);
		expect(transport.seen[0].systemMessage).toContain('You are RIAF');
		expect(r.history.some(m => m.role === 'plan' && (m as any).items[0].status === 'pending')).toBe(true);
		await index.close();
	});

	it('stops after the configured consecutive-failure cap', async () => {
		const { index, folder } = await fixture();
		const transport = scripted([{ text: '', toolCalls: [{ id: 'b', name: 'read_file', args: {} }], stopReason: 'tool_calls' }]);
		const s = quiet(readSettings()); s.agent.maxConsecutiveToolFails = 1;
		const r = await runAgent({ transport, index, folder, settings: s, usage: new UsageMeter(memento()), mode: 'agent', userPrompt: 'read it', history: [], stream: stream(), token, log: () => { }, diagnosticsSettleMs: 0 });
		expect(r.stopped).toBe('tool_fail_cap');
		await index.close();
	});

	it('refuses a turn once the session USD budget is spent', async () => {
		const { index, folder } = await fixture();
		const usage = new UsageMeter(memento());
		usage.record({ inputTokens: 2_000_000, outputTokens: 0, cacheReadTokens: 0 }, { provider: 'anthropic', model: 'claude-sonnet-4-6', purpose: 'agent' });
		expect(usage.session.costUSD).toBeGreaterThan(1);
		const transport = scripted([]);
		const s = quiet(readSettings()); s.agent.sessionBudgetUsd = 1;
		const st = stream();
		const r = await runAgent({ transport, index, folder, settings: s, usage, mode: 'agent', userPrompt: 'do more', history: [], stream: st, token, log: () => { } });
		expect(r.stopped).toBe('budget');
		expect(transport.seen).toHaveLength(0);
		expect(st.md.join('')).toMatch(/session budget reached/);
		await index.close();
	});

	it('treats an output-token-at-cap reply as truncated even when stopReason is end', async () => {
		const { index, folder } = await fixture();
		const transport = scripted([
			{ text: 'partial edit', toolCalls: [], stopReason: 'end', usage: { inputTokens: 10, outputTokens: 100, cacheReadTokens: 0 } },
			{ text: 'done', toolCalls: [], stopReason: 'end' },
			{ text: 'finished', toolCalls: [], stopReason: 'end' },
		]);
		transport.maxOutputTokens = 100;
		const r = await runAgent({ transport, index, folder, settings: quiet(readSettings()), usage: new UsageMeter(memento()), mode: 'agent', userPrompt: 'fix add', history: [], stream: stream(), token, log: () => { } });
		expect(r.stopped).toBe('done');
		expect(JSON.stringify(transport.seen[1].messages)).toContain('cut off by the output limit');
		await index.close();
	});

	it('retries a stalled stream without ending the run', async () => {
		const { index, folder } = await fixture();
		let calls = 0;
		const seen: TransportRequest[] = [];
		const transport: ModelTransport = {
			id: 'fake', providerName: 'liteLLM', modelName: 'm', contextWindow: 200_000, maxOutputTokens: 8192, seen,
			async call(req) {
				seen.push(req); calls++;
				if (calls === 1) { await new Promise((_, rej) => req.signal?.addEventListener('abort', () => rej(new Error('aborted')))); }
				return { text: 'recovered', toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } };
			},
		} as ModelTransport & { seen: TransportRequest[] };
		const r = await runAgent({ transport, index, folder, settings: quiet(readSettings()), usage: new UsageMeter(memento()), mode: 'agent', userPrompt: 'hi', history: [], stream: stream(), token, log: () => { }, stallTimeoutMs: 30, retryDelayMs: 1 });
		expect(r.stopped).toBe('done');
		expect(calls).toBe(2);
		expect(r.history.some(m => m.role === 'assistant' && (m as any).displayContent === 'recovered')).toBe(true);
		await index.close();
	});

	it('skips planning in light mode and nudges verification instead of running tests', async () => {
		const { index, folder } = await fixture();
		const edit = { id: 'e', name: 'edit_file', args: { filePath: 'src/calc.ts', edits: [{ search: 'return a - b; // bug', replace: 'return a + b;' }] } };
		const transport = scripted([
			{ text: '', toolCalls: [edit], stopReason: 'tool_calls' },
			{ text: 'edited', toolCalls: [], stopReason: 'end' },
			{ text: 'verified by hand', toolCalls: [], stopReason: 'end' },
		]);
		const s = quiet(readSettings());
		s.agent.generatePlan = true;
		s.agent.enableLightAgent = true;
		s.agent.sandboxVerificationNudge = true;
		s.agent.requireEditApproval = false;
		const r = await runAgent({ transport, index, folder, settings: s, usage: new UsageMeter(memento()), mode: 'agent', userPrompt: 'fix add', history: [], stream: stream(), token, log: () => { }, diagnosticsSettleMs: 0 });
		expect(transport.seen[0].systemMessage).toContain('You are RIAF');
		expect(transport.seen[0].systemMessage!.length).toBeLessThan(8_000);
		expect(r.history.some(m => m.role === 'user' && String((m as any).content).includes('SANDBOX VERIFICATION'))).toBe(true);
		expect(r.history.some(m => m.role === 'tool' && (m as any).name === 'run_tests')).toBe(false);
		await index.close();
	});

	it('saves a remember-request and injects the memory file later', async () => {
		expect(extractRememberedFact('please remember that we use pnpm')).toBe('we use pnpm');
		expect(extractRememberedFact('remember that we use pnpm and fix the bug')).toBeNull();
		const home = mkdtempSync(join(tmpdir(), 'riaf-mem-'));
		const { index, folder } = await fixture();
		const s = quiet(readSettings());
		const saved = await runAgent({ transport: scripted([]), index, folder, settings: s, usage: new UsageMeter(memento()), mode: 'agent', userPrompt: 'remember that we use pnpm', history: [], stream: stream(), token, log: () => { }, memoryHome: home });
		expect(saved.stopped).toBe('done');
		expect(saved.iterations).toBe(0);
		expect(readMemory(home)).toContain('we use pnpm');
		const transport = scripted([{ text: 'ok', toolCalls: [], stopReason: 'end' }]);
		await runAgent({ transport, index, folder, settings: s, usage: new UsageMeter(memento()), mode: 'explain', userPrompt: 'what package manager?', history: [], stream: stream(), token, log: () => { }, memoryHome: home });
		expect(transport.seen[0].systemMessage).toContain('<user_memory>');
		expect(transport.seen[0].systemMessage).toContain('we use pnpm');
		expect(memoryPromptBlock('')).toBe('');
		appendMemory('tabs not spaces', home);
		expect(readMemory(home)).toContain('tabs not spaces');
		await index.close();
	});
});

describe('Phase A — persistence, Claude rules, LM tools, explore cancel', () => {
	it('round-trips a thread through disk', () => {
		const dir = mkdtempSync(join(tmpdir(), 'riaf-th-'));
		const thread = { history: [{ role: 'user', content: 'hi', displayContent: 'hi', selections: null, state: { stagingSelections: [], isBeingEdited: false } }] as any, turnStarts: [[]], root: '/w' };
		saveThread(dir, 'thread/1', thread);
		expect(loadThread(dir, 'thread/1')?.history).toHaveLength(1);
		expect(loadThread(dir, 'missing')).toBeUndefined();
	});

	it('merges plugin rules and project rules into CLAUDE.md without dropping an existing preface', () => {
		const first = mergeClaudeMd(undefined, 'plugin rules', '# use pnpm');
		expect(first).toContain('<!-- riaf:rules -->');
		expect(first).toContain('plugin rules');
		expect(first).toContain('<!-- riaf:project-rules -->\n# use pnpm');
		const withPreface = mergeClaudeMd('# Team notes\n', 'plugin rules', 'AGENTS body');
		expect(withPreface.startsWith('# Team notes')).toBe(true);
		expect(withPreface).toContain('AGENTS body');
		const updated = mergeClaudeMd(withPreface, 'plugin rules', 'new rules');
		expect(updated).toContain('new rules');
		expect(updated).not.toContain('AGENTS body');
		expect(updated.startsWith('# Team notes')).toBe(true);
	});

	it('registers every catalogued read-only tool as a Copilot LM tool', () => {
		const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
		const names = new Set<string>(pkg.contributes.languageModelTools.map((t: { name: string }) => t.name));
		for (const t of LM_TOOLS) { expect(names.has(`riaf_${t.name}`), t.name).toBe(true); }
		expect(names.has('riaf_search_codebase')).toBe(true);
		for (const n of READ_ONLY_TOOLS) { if (n !== 'explore') { expect(TOOL_SPECS.some(t => t.name === n), n).toBe(true); } }
		expect(pkg.contributes.commands.some((c: { command: string }) => c.command === 'riaf.rememberThis')).toBe(true);
	});

	it('stops the explore subagent when the parent token is cancelled and passes the abort signal', async () => {
		const { index, folder } = await fixture();
		let signal: AbortSignal | undefined;
		const transport: ModelTransport = {
			id: 'fake', providerName: 'liteLLM', modelName: 'm', contextWindow: 8_000, maxOutputTokens: 100,
			async call(req) { signal = req.signal; return { text: '', toolCalls: [{ id: 'g', name: 'grep', args: { pattern: 'add' } }], stopReason: 'tool_calls' }; },
		};
		const cancelled = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() { } }) } as any;
		const r = await runExplore('find add', { transport, ctx: { folder, index, requireEditApproval: true, allowRunCommand: false, token: cancelled } as any, allSpecs: TOOL_SPECS, executeTool });
		expect(r.report).toBe('Explore cancelled.');
		expect(signal).toBeUndefined();
		await index.close();
	});
});
