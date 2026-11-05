import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Riaf2 } from '../../src/v2/riaf2.js';
import { routeIntent } from '../../src/v2/intentRouter.js';
import { buildInstruction, claudeMdInstructionBlock, listInstructions, loadCurrentInstruction, saveInstruction, upsertClaudeMdInstruction } from '../../src/v2/instruction.js';
import { makeHistoryRepo, NOW } from './gitRepo.js';

describe('Prompt Instruction', () => {
	let dir: string; let repo: string; let riaf: Riaf2;
	const request = 'Fix capturePayment in OrderService: it returns true for refunded orders. Do not change the public API.';

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'riaf-instr-'));
		repo = makeHistoryRepo(dir).repo;
		writeFileSync(join(repo, '.riafrules'), '- Use the shared logger; never console.log.\n');
		mkdirSync(join(repo, '.riaf', 'rules'), { recursive: true });
		writeFileSync(join(repo, '.riaf', 'rules', '10-tests.md'), 'Tests live beside the source as *.test.ts.');
		riaf = await Riaf2.open({ workspaceRoot: repo, dbPath: join(dir, 'index.sqlite'), persistDebounceMs: 20, history: { now: () => NOW } });
		await riaf.indexRepo();
	}, 60_000);
	afterAll(async () => { await riaf.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

	it('assembles stable → task → plan → verification → budgets → volatile, with rules and route', async () => {
		const route = await routeIntent(request, { root: repo });
		const pack = await riaf.compile(request, { budget: route.budget, stage: route.stage });
		const instr = buildInstruction(pack, {
			route, root: repo,
			policy: { phases: { explore: { soft_calls: 40, max_calls: 80, soft_tokens: 120_000, max_tokens: 250_000 } } },
			findings: ['2: src/orderService.ts:31 — refunded check missing', 'orderService.test.ts has no refunded case'],
		});
		expect(instr.intent.type).toBe('bugfix');
		expect(instr.route.mode).toBe('agent');
		expect(instr.rules_sources).toEqual(['.riafrules', '.riaf/rules/10-tests.md']);
		const md = instr.markdown;
		const order = ['## Repository conventions', '## Architecture', '## Project rules', '## Protocol', '## Task (bugfix', '## Plan', '## Verification', '## Budgets', '## Context items'].map(h => md.indexOf(h));
		expect(order.every(i => i >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(md).toContain('never console.log');
		expect(md).toContain('Do not change the public API');
		expect(md).toContain('    - evidence: src/orderService.ts:31');
		expect(md).toContain('Findings from exploration:\n- orderService.test.ts has no refunded case');
		expect(md).toContain('| explore | 40 | 80 |');
		expect(md).toContain('- [ ] confirm constraint holds');
		expect(instr.tokens).toBeGreaterThan(200);
		expect(instr.stable_hash).toHaveLength(16);
	});

	it('the stable half is identical across two instructions on the same HEAD', async () => {
		const a = buildInstruction(await riaf.compile(request, { budget: 8_000 }), { root: repo });
		const b = buildInstruction(await riaf.compile('How does createOrder reach the logger?', { budget: 8_000 }), { root: repo });
		expect(a.stable_hash).toBe(b.stable_hash);
		expect(a.markdown.split('\n## Task')[0].split('\n').slice(1).join('\n')).toBe(b.markdown.split('\n## Task')[0].split('\n').slice(1).join('\n'));
	});

	it('saves, lists and reloads; writes a managed CLAUDE.md block', async () => {
		const pack = await riaf.compile(request, { budget: 8_000 });
		const instr = buildInstruction(pack, { root: repo, host: 'claude' });
		const saved = saveInstruction(repo, instr);
		expect(existsSync(saved.path)).toBe(true);
		expect(readFileSync(saved.currentPath, 'utf8')).toBe(instr.markdown);
		const back = loadCurrentInstruction(repo);
		expect(back?.instruction_id).toBe(instr.instruction_id);
		expect(back?.markdown).toBe(instr.markdown);
		const list = listInstructions(repo);
		expect(list[0].id).toBe(instr.instruction_id);
		expect(list[0].type).toBe('bugfix');

		const md1 = upsertClaudeMdInstruction('# My project\n\nnotes\n', instr);
		expect(md1).toContain('# My project');
		expect(md1).toContain(`Current RIAF instruction: \`${instr.instruction_id}\``);
		expect(md1).toContain('## Repository conventions');
		expect(md1).not.toContain('## Context items'); // stable half only
		const md2 = upsertClaudeMdInstruction(md1, null);
		expect(md2.match(/riaf:instruction:begin/g)).toHaveLength(1);
		expect(md2).toContain('No RIAF instruction compiled yet');
		expect(claudeMdInstructionBlock(null)).toContain('/riaf-task');
	});
});
