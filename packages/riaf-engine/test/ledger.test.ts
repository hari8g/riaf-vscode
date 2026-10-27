import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileLedger, LedgerBus, migrateLedger, nextReadySubtasks } from '../src/index.js';

const sub = (id: string, dependsOn: string[] = []) => ({
	id, goal: `do ${id}`, files: [`src/${id}.ts`], dependsOn,
	acceptance: [{ kind: 'grep' as const, pattern: id, path: `src/${id}.ts` }],
	budget: { maxIterations: 4, maxTokens: 1000 },
});

describe('FileLedger', () => {
	it('round-trips a run, advances the DAG, and keeps spend and the tool digest', () => {
		const root = mkdtempSync(join(tmpdir(), 'riaf-ledger-'));
		const events: string[] = [];
		const bus = new LedgerBus();
		bus.subscribe(e => events.push(`${e.runId}:${e.type}`));
		const now = { t: 1_000 };
		const ledger = new FileLedger(root, { now: () => now.t, bus });

		const run = ledger.create({ id: 'run-1', goal: 'fix add', subtasks: [sub('a'), sub('b', ['a'])] });
		expect(events).toEqual(['run-1:planned']);
		expect(nextReadySubtasks(run).map(s => s.id)).toEqual(['a']);

		now.t = 2_000;
		ledger.setSubtaskStatus(run, 'a', 'running', 'start a');
		ledger.appendToolDigest(run, 'a', 'edit_file src/a.ts');
		ledger.recordSpend(run, { inputTokens: 10, outputTokens: 2, costUSD: 0.01 });
		ledger.setSubtaskStatus(run, 'a', 'done', 'a verified');
		expect(nextReadySubtasks(run).map(s => s.id)).toEqual(['b']);

		ledger.setSubtaskStatus(run, 'b', 'blocked', 'tests red');
		expect(run.status).toBe('blocked');

		const loaded = ledger.load('run-1');
		expect(loaded.version).toBe(1);
		expect(loaded.goal).toBe('fix add');
		expect(loaded.subtasks[0].toolDigest).toEqual(['edit_file src/a.ts']);
		expect(loaded.subtasks[0].attempts).toBe(1);
		expect(loaded.spend).toEqual({ inputTokens: 10, outputTokens: 2, costUSD: 0.01 });
		expect(loaded.events.map(e => e.type)).toEqual(['planned', 'subtask_running', 'spend', 'subtask_done', 'subtask_blocked']);
		expect(ledger.list()).toEqual([{ id: 'run-1', goal: 'fix add', status: 'blocked', updatedAt: 2_000 }]);
	});

	it('refuses a run id that would escape the runs directory', () => {
		const ledger = new FileLedger(mkdtempSync(join(tmpdir(), 'riaf-ledger-')));
		expect(() => ledger.create({ id: '../outside', goal: 'x', subtasks: [] })).toThrow(/invalid run id/);
		expect(() => ledger.load('../outside')).toThrow(/invalid run id/);
	});

	it('migrates a version-less file and rejects an unknown version', () => {
		const migrated = migrateLedger({ id: 'old1', goal: 'legacy', subtasks: [{ id: 's', goal: 'step' }] });
		expect(migrated.version).toBe(1);
		expect(migrated.subtasks[0].status).toBe('pending');
		expect(migrated.subtasks[0].budget.maxIterations).toBe(8);
		expect(() => migrateLedger({ version: 99, id: 'x', goal: 'y', subtasks: [] })).toThrow(/unsupported ledger version 99/);
	});
});
