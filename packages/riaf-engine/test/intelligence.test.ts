import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileLedger, applySearchBoosts, conventionalTestPaths, decorateGraph, renderContextDocument, runTask, testSourceMap, verifySubtask } from '../src/index.js';

const subtask = (acceptance: { kind: 'command'; command: string }[]) => ({
	id: 't', goal: 'g', files: [], dependsOn: [], acceptance, budget: { maxIterations: 1, maxTokens: 1 },
	status: 'pending' as const, attempts: 0, toolDigest: [], notes: '',
});

describe('phase C verifier and replanner', () => {
	it('fails a command check on a non-zero exit and passes a clean one', async () => {
		const task = subtask([{ kind: 'command', command: 'npm test' }]);
		const bad = await verifySubtask(task, { readFile: async () => null, runCommand: async () => ({ code: 1, output: 'FAIL src/a.test.ts\nTests 1 failed' }) });
		expect(bad.ok).toBe(false);
		expect(bad.failures[0]).toMatch(/exit 1/);
		const good = await verifySubtask(task, { readFile: async () => null, runCommand: async () => ({ code: 0, output: 'Tests 3 passed' }) });
		expect(good.ok).toBe(true);
	});

	it('replaces a blocked subtask when replan is on', async () => {
		const root = mkdtempSync(join(tmpdir(), 'riaf-replan-'));
		const ledger = new FileLedger(root);
		const run = await runTask({
			ledger, goal: 'fix', replan: true, maxFixes: 0,
			callLLM: async system => {
				if (system.startsWith('You decompose')) { return { text: '{"subtasks":[{"id":"s1","goal":"miss","files":[],"dependsOn":[],"acceptance":[{"kind":"grep","pattern":"PRESENT","path":"a.ts"}]}]}' }; }
				if (system.startsWith('Replace')) { return { text: '{"subtasks":[{"id":"s2","goal":"done","files":[],"dependsOn":[],"acceptance":[]}]}' }; }
				return { text: '{"pass":true}' };
			},
			runSubtask: async () => ({ ok: true, digest: [], notes: '' }),
			env: { readFile: async () => 'absent' },
		});
		expect(run.subtasks.find(s => s.id === 's1')?.status).toBe('skipped');
		expect(run.subtasks.find(s => s.id === 's2')?.status).toBe('done');
	});
});

describe('phase E intelligence', () => {
	it('maps tests, boosts co-changed files, and renders a context document', () => {
		expect(conventionalTestPaths('src/calc.ts')).toEqual(['src/calc.test.ts', 'src/calc.spec.ts']);
		expect(testSourceMap(['src/calc.ts', 'src/calc.test.ts', 'src/FooTest.java'])).toEqual([
			{ testFile: 'src/calc.test.ts', sourceFile: 'src/calc.ts', present: true },
			{ testFile: 'src/FooTest.java', sourceFile: 'src/Foo.java', present: false },
		]);
		const boosted = applySearchBoosts(
			[{ filePath: 'src/a.ts', score: 1 }, { filePath: 'src/b.ts', score: 1 }],
			{ activeFile: 'src/a.ts', recent: ['src/b.ts'], coChange: { 'src/a.ts': { 'src/b.ts': 4 } } },
		);
		expect(boosted[0].filePath).toBe('src/b.ts');
		expect(boosted[0].score).toBeCloseTo(1.13);
		const doc = renderContextDocument({ name: 'demo', report: 'indexed', summary: 'a small repo', pairs: [{ testFile: 'src/calc.test.ts', sourceFile: 'src/calc.ts' }] });
		expect(doc).toContain('## Summary');
		expect(doc).toContain('src/calc.test.ts');
		expect(doc).toContain('## Index');
	});

	it('assigns package and depth, and stops at a cycle', () => {
		const view = decorateGraph(
			[{ id: 'src/app/main.ts', layer: 'entry' }, { id: 'src/app/util.ts', layer: 'service' }, { id: 'loop.ts' }],
			[{ from: 'src/app/main.ts', to: 'src/app/util.ts' }, { from: 'loop.ts', to: 'loop.ts' }],
		);
		expect(view.find(n => n.id === 'src/app/util.ts')).toMatchObject({ packageName: 'src/app', depth: 1, layer: 'service' });
		expect(view.find(n => n.id === 'loop.ts')?.depth).toBe(0);
	});
});
