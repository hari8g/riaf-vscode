import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeCli, FileLedger, parseCriticResponse, parseGitNameOnly, parsePlanDocument, parseTestOutput, pipelineBlastRadius, runTask, scanSecurity, verifySubtask, coChangeCounts } from '../src/index.js';

const planJson = JSON.stringify({
	subtasks: [
		{ id: 's1', goal: 'fix add', files: ['src/calc.ts'], dependsOn: [], acceptance: [{ kind: 'grep', pattern: 'a \\+ b', path: 'src/calc.ts' }], budget: { maxIterations: 4, maxTokens: 1000 } },
		{ id: 's2', goal: 'cover it', files: ['src/calc.test.ts'], dependsOn: ['s1'], acceptance: [], budget: { maxIterations: 4, maxTokens: 1000 } },
	],
});

describe('plan, execute, verify', () => {
	it('rejects a cycle and a missing dependency', () => {
		expect(() => parsePlanDocument('{"subtasks":[{"id":"a","goal":"g","dependsOn":["b"]},{"id":"b","goal":"h","dependsOn":["a"]}]}')).toThrow(/cycle/);
		expect(() => parsePlanDocument('{"subtasks":[{"id":"a","goal":"g","dependsOn":["missing"]}]}')).toThrow(/unknown/);
	});

	it('runs the DAG, verifies a grep check, and records the critic pass', async () => {
		const root = mkdtempSync(join(tmpdir(), 'riaf-eng-'));
		writeFileSync(join(root, 'src-calc.ts'), 'return a - b;');
		// workspace-relative path used by the plan
		const { mkdirSync } = await import('node:fs');
		mkdirSync(join(root, 'src'));
		writeFileSync(join(root, 'src', 'calc.ts'), 'return a - b;\n');
		writeFileSync(join(root, 'src', 'calc.test.ts'), 'test\n');
		const ledger = new FileLedger(root, { now: () => 5_000 });
		const calls: string[] = [];
		const run = await runTask({
			ledger, goal: 'fix add', callLLM: async system => {
				calls.push(system.slice(0, 12));
				if (system.startsWith('You decompose')) { return { text: planJson, inputTokens: 3, outputTokens: 4 }; }
				return { text: '{"pass":true}' };
			},
			runSubtask: async subtask => {
				if (subtask.id === 's1') { writeFileSync(join(root, 'src', 'calc.ts'), 'return a + b;\n'); }
				return { ok: true, digest: [`touched ${subtask.id}`], notes: '' };
			},
			env: { readFile: async path => { try { return readFileSync(join(root, path), 'utf8'); } catch { return null; } } },
		});
		expect(run.status).toBe('done');
		expect(run.subtasks.map(s => s.status)).toEqual(['done', 'done']);
		expect(run.spend.inputTokens).toBe(3);
		expect(run.events.some(e => e.type === 'critic' && e.message === 'pass')).toBe(true);
		expect(calls[0]).toContain('You decompo');
	});

	it('blocks a subtask after two failed fixes', async () => {
		const root = mkdtempSync(join(tmpdir(), 'riaf-eng-'));
		const ledger = new FileLedger(root);
		const run = ledger.create({
			id: 'run-block', goal: 'nope',
			subtasks: [{ id: 's', goal: 'g', files: [], dependsOn: [], acceptance: [{ kind: 'grep', pattern: 'MISSING', path: 'nope.ts' }], budget: { maxIterations: 2, maxTokens: 10 } }],
		});
		const { executeRun } = await import('../src/executor.js');
		await executeRun({
			ledger, run, maxFixes: 2,
			runSubtask: async () => ({ ok: true, digest: [], notes: '' }),
			env: { readFile: async () => 'nothing' },
		});
		expect(run.subtasks[0].status).toBe('blocked');
		expect(run.subtasks[0].attempts).toBe(3);
	});
});

describe('verifier and parsers', () => {
	it('parses vitest, pytest, go and surefire output', () => {
		const v = parseTestOutput('RUN v3\nFAIL src/a.test.ts > adds\nTests 1 failed | 2 passed');
		expect(v.runner).toBe('vitest');
		expect(v.passed).toBe(2);
		expect(v.failed.length).toBeGreaterThan(0);
		expect(parseTestOutput('FAILED tests/test_add.py::test_add\n1 failed, 3 passed').failed[0].name).toContain('test_add');
		expect(parseTestOutput('--- PASS: TestAdd\n--- FAIL: TestSub\n').failed.map(f => f.name)).toEqual(['TestSub']);
		const sure = parseTestOutput('<testsuite tests="2" failures="1" errors="0"><testcase name="adds"><failure message="x"/></testcase></testsuite>');
		expect(sure.runner).toBe('surefire');
		expect(sure.failed.map(f => f.name)).toEqual(['adds']);
	});

	it('fails a command check when the parser sees failures', async () => {
		const result = await verifySubtask({
			id: 's', goal: 'g', files: [], dependsOn: [], status: 'pending', attempts: 0, toolDigest: [], notes: '',
			budget: { maxIterations: 1, maxTokens: 1 },
			acceptance: [{ kind: 'command', command: 'npm test' }],
		}, { readFile: async () => null, runCommand: async () => ({ code: 1, output: 'FAIL src/a.test.ts\nTests 1 failed | 0 passed' }) });
		expect(result.ok).toBe(false);
	});

	it('reads a critic fix and ignores prose when the review passes', () => {
		expect(parseCriticResponse('looks good {"pass":true}')).toEqual({ pass: true });
		const fix = parseCriticResponse('{"pass":false,"fix":{"id":"critic-fix","goal":"rename","files":["a.ts"],"dependsOn":[],"acceptance":[]}}');
		expect(fix.fix?.goal).toBe('rename');
	});
});

describe('analysis helpers', () => {
	it('walks pipeline dependents, co-change, and the security rules', () => {
		expect(pipelineBlastRadius([
			{ name: 'build', needs: [] },
			{ name: 'test', needs: ['build'] },
			{ name: 'deploy', needs: ['test'] },
		], 'build')).toEqual(['test', 'deploy']);
		const commits = parseGitNameOnly('commit a\n\nsrc/a.ts\nsrc/b.ts\n\ncommit b\n\nsrc/a.ts\n');
		expect(coChangeCounts(commits).get('src/a.ts')?.get('src/b.ts')).toBe(1);
		const findings = scanSecurity([{ path: 'src/a.ts', text: 'const password = "hunter2";\neval(x);\n' }]);
		expect(findings.map(f => f.rule)).toEqual(['password-assign', 'eval']);
	});
});

describe('cli', () => {
	it('plans, applies a patch, and exits 0 when the critic passes', async () => {
		const root = mkdtempSync(join(tmpdir(), 'riaf-cli-'));
		const { mkdirSync } = await import('node:fs');
		mkdirSync(join(root, 'src'));
		writeFileSync(join(root, 'src', 'calc.ts'), 'return a - b;\n');
		const lines: string[] = [];
		const code = await executeCli(['run', 'fix add', '--repo', root], {
			log: line => lines.push(line),
			callLLM: async (system, user) => {
				if (system.startsWith('You decompose')) { return { text: planJson }; }
				if (system.startsWith('Apply')) {
					return { text: user.includes('cover it') ? '[]' : '[{"path":"src/calc.ts","search":"a - b","replace":"a + b"}]' };
				}
				return { text: '{"pass":true}' };
			},
		});
		expect(code).toBe(0);
		expect(readFileSync(join(root, 'src', 'calc.ts'), 'utf8')).toContain('a + b');
		expect(lines.join('\n')).toContain('fix add');
	});
});
