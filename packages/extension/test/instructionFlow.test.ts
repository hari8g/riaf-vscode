import { afterEach, describe, expect, it } from 'vitest';
import { clearProviderRateLimitCooldown } from '@bosch-mps/token-opt';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInstruction, RiafIndex, Riaf2, routeIntent, saveInstruction } from '@bosch-mps/riaf-core';
import { runAgent } from '../src/agentLoop.js';
import { claudeLaunchCommand, planGateApplies, writeInstructionForClaude } from '../src/instructionFlow.js';
import type { ModelTransport, TransportRequest, TransportResult } from '../src/modelTransport.js';
import { UsageMeter } from '../src/usage.js';
import { readSettings } from '../src/config.js';

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
	const root = mkdtempSync(join(tmpdir(), 'riaf-instr-ext-'));
	mkdirSync(join(root, 'src'));
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', scripts: { test: 'node -e "process.exit(0)"' } }));
	writeFileSync(join(root, 'src', 'calc.ts'), 'export function add(a: number, b: number) {\n  return a - b; // bug\n}\n');
	const index = await RiafIndex.open({ workspaceRoot: root, dbPath: ':memory:' });
	await index.reindex();
	return { root, index, folder: { uri: { fsPath: root }, name: 'fx', index: 0 } as any };
}

describe('instruction flow (extension side)', () => {
	afterEach(() => { clearProviderRateLimitCooldown('liteLLM', 'claude-sonnet-4-5'); });

	it('planGateApplies follows the setting', async () => {
		const s = readSettings();
		const feature = await routeIntent('Add a CSV export to the settlement report');
		const bugfix = await routeIntent('Fix the TypeError in `Cart.total`');
		s.instruction.planGate = 'default';
		expect(planGateApplies(feature, s)).toBe(true);
		expect(planGateApplies(bugfix, s)).toBe(false);
		s.instruction.planGate = 'all';
		expect(planGateApplies(bugfix, s)).toBe(true);
		expect(planGateApplies(await routeIntent('Explain the cart'), s)).toBe(false);
		s.instruction.planGate = 'off';
		expect(planGateApplies(feature, s)).toBe(false);
	});

	it('writes the instruction through every Claude Code door and builds a launch command', async () => {
		const { root, index } = await fixture();
		const riaf = Riaf2.fromIndex(index, { history: false });
		const pack = await riaf.compile('Fix the add() bug in src/calc.ts', { budget: 4_000 });
		const instr = buildInstruction(pack, { route: await routeIntent('Fix the add() bug in src/calc.ts'), root });
		saveInstruction(root, instr);
		writeFileSync(join(root, 'CLAUDE.md'), '# fx\n\nteam notes\n');
		const written = writeInstructionForClaude(root, instr);
		expect(written.map(p => p.replace(root, ''))).toEqual([
			'/.claude/riaf/instructions/current.md', '/.claude/commands/riaf-task.md', '/.claude/commands/riaf-instruction.md', '/CLAUDE.md',
		]);
		expect(readFileSync(join(root, '.claude', 'commands', 'riaf-task.md'), 'utf8')).toContain('riaf_instruction');
		const md = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
		expect(md).toContain('team notes');
		expect(md).toContain('<!-- riaf:begin'); // protocol block
		expect(md).toContain(`Current RIAF instruction: \`${instr.instruction_id}\``);
		// idempotent
		writeInstructionForClaude(root, instr);
		expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8').match(/riaf:instruction:begin/g)).toHaveLength(1);
		expect(claudeLaunchCommand(root)).toMatch(/^claude /);
		expect(claudeLaunchCommand(root, { headless: true })).toContain('-p');
		expect(existsSync(join(root, '.claude', 'riaf', 'instructions', 'current.json'))).toBe(true);
		await index.close();
		rmSync(root, { recursive: true, force: true });
	});

	it('runAgent prepends the context prelude and runs the explore lane concurrently with planning', async () => {
		const { index, folder } = await fixture();
		const transport = scripted([
			// Order is deterministic here: the explore lane's first call is issued before the plan side-call awaits.
			{ text: '', toolCalls: [{ id: 'x1', name: 'search_codebase', args: { query: 'add' } }], stopReason: 'tool_calls' }, // explore lane step 1
			{ text: '- Edit src/calc.ts', toolCalls: [], stopReason: 'end' },                                                   // plan side-call
			{ text: '- src/calc.ts:2 — subtraction instead of addition', toolCalls: [], stopReason: 'end' },                    // explore lane report
			{ text: 'Done.', toolCalls: [], stopReason: 'end' },                                                                 // main loop
		]);
		const s = readSettings(); s.agent.autoVerify = false;
		let explored = '';
		const st = stream();
		const r = await runAgent({
			transport, index, folder, settings: s, usage: new UsageMeter(memento()), mode: 'agent', userPrompt: 'fix the add bug', history: [], stream: st, token, log: () => { },
			contextPrelude: '# RIAF Prompt Instruction test\n## Plan\n1. Edit src/calc.ts',
			exploreLane: { task: 'find add()', maxSteps: 2, onExplored: report => { explored = report; return `# RIAF Prompt Instruction test (with findings)\n${report}`; } },
		});
		expect(r.stopped).toBe('done');
		expect(explored).toContain('src/calc.ts:2');
		const mainCall = transport.seen[transport.seen.length - 1];
		const userText = mainCall.messages.find(m => m.role === 'user')?.text ?? '';
		expect(userText).toContain('<riaf_context>');
		expect(userText).toContain('(with findings)');
		expect(userText).toContain('fix the add bug');
		expect(st.md.join('')).toContain('Exploration lane report');
		// The lane used the explore system prompt, not the agent's.
		expect(transport.seen[0].systemMessage).toContain('explore subagent');
		await index.close();
	});
});
