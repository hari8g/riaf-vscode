import { describe, expect, it } from 'vitest';
import { buildRunReport, classifyEvent, eventDetail, isTestPath, looksLikeTestCommand, parseTestRun, reportToMarkdown, runStatus, summarizeRun, type RunEvent } from '../src/runReport.js';

describe('parseTestRun', () => {
	it('pytest, with and without failures', () => {
		expect(parseTestRun('pytest -q', '....F.\n=========== 1 failed, 12 passed, 2 skipped in 3.41s ===========')).toMatchObject({ framework: 'pytest', passed: 12, failed: 1, skipped: 2, total: 15, ok: false, durationMs: 3410 });
		expect(parseTestRun('python -m pytest', '============ 37 passed in 0.52s ============')).toMatchObject({ framework: 'pytest', passed: 37, failed: 0, ok: true });
		expect(parseTestRun('pytest', '2 failed, 1 error in 1.0s')).toMatchObject({ failed: 2, errors: 1, ok: false });
	});
	it('jest and vitest', () => {
		expect(parseTestRun('npx jest', 'Tests:       1 failed, 4 passed, 5 total\nTime:        2.5 s')).toMatchObject({ framework: 'jest', passed: 4, failed: 1, total: 5, ok: false, durationMs: 2500 });
		expect(parseTestRun('npm test', '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m236 passed\x1b[39m\x1b[22m | 1 skipped (237)\n   Duration  8.21s')).toMatchObject({ framework: 'vitest', passed: 236, skipped: 1, total: 237, ok: true, durationMs: 8210 });
	});
	it('mocha, cargo, go, unittest, node:test', () => {
		expect(parseTestRun('mocha', '  12 passing (30ms)\n  2 failing')).toMatchObject({ framework: 'mocha', passed: 12, failed: 2, ok: false });
		expect(parseTestRun('cargo test', 'test result: ok. 5 passed; 0 failed; 1 ignored; 0 measured\ntest result: FAILED. 2 passed; 1 failed; 0 ignored')).toMatchObject({ framework: 'cargo', passed: 7, failed: 1, skipped: 1, ok: false });
		expect(parseTestRun('go test ./...', 'ok  \tpkg/a\t0.2s\nFAIL\tpkg/b\t0.1s')).toMatchObject({ framework: 'go', passed: 1, failed: 1, ok: false });
		expect(parseTestRun('python -m unittest', 'Ran 5 tests in 0.004s\n\nFAILED (failures=1, errors=1)')).toMatchObject({ framework: 'unittest', passed: 3, failed: 1, errors: 1, total: 5, ok: false });
		expect(parseTestRun('node --test', 'ℹ tests 3\nℹ pass 3\nℹ fail 0')).toMatchObject({ framework: 'node:test', passed: 3, ok: true });
	});
	it('returns null when there is no summary', () => { expect(parseTestRun('ls', 'a.txt b.txt')).toBeNull(); });
	it('recognises test commands', () => {
		for (const c of ['pytest tests/', 'npm test', 'npm run test:unit', 'npx vitest run', 'go test ./...', 'cargo test', 'pnpm test', 'python -m pytest -x', 'mvn -q test']) expect(looksLikeTestCommand(c), c).toBe(true);
		for (const c of ['npm install', 'git status', 'ls tests']) expect(looksLikeTestCommand(c), c).toBe(false);
	});
	it('recognises test files', () => {
		for (const f of ['tests/unit/test_hotlist.py', 'src/cart.test.ts', 'pkg/a_test.go', 'src/__tests__/x.ts', 'test/foo.js']) expect(isTestPath(f), f).toBe(true);
		for (const f of ['src/cart.ts', 'latest/readme.md', 'contest.py']) expect(isTestPath(f), f).toBe(false);
	});
});

describe('eventDetail', () => {
	const rel = (p: string) => p.replace('/repo/', '');
	it('counts lines for Edit, MultiEdit and Write', () => {
		expect(eventDetail({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/repo/a.ts', old_string: 'a\nb', new_string: 'a\nb\nc\nd' } }, rel)).toMatchObject({ file: 'a.ts', added: 4, removed: 2 });
		expect(eventDetail({ hook_event_name: 'PostToolUse', tool_name: 'MultiEdit', tool_input: { file_path: '/repo/a.ts', edits: [{ old_string: 'x', new_string: 'y\nz' }, { old_string: 'p', new_string: 'q' }] } }, rel)).toMatchObject({ added: 3, removed: 2 });
		expect(eventDetail({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/repo/new.py', content: 'l1\nl2\nl3\n' } }, rel)).toMatchObject({ file: 'new.py', added: 3 });
	});
	it('parses test output from a Bash result and from a failure payload', () => {
		const ok = eventDetail({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'pytest -q' }, tool_response: { stdout: '5 passed in 0.1s', stderr: '' } }, rel);
		expect(ok?.tests).toMatchObject({ passed: 5, ok: true });
		const bad = eventDetail({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'pytest' }, error: 'Exit code 1\n2 failed, 3 passed in 0.2s' }, rel);
		expect(bad).toMatchObject({ failed: true }); expect(bad?.tests).toMatchObject({ passed: 3, failed: 2, ok: false }); expect(bad?.tail).toContain('2 failed');
	});
	it('a failing test command with unreadable output still counts as a failed run', () => {
		const d = eventDetail({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 127 command not found' }, rel);
		expect(d?.tests).toMatchObject({ ok: false, framework: 'unknown' });
	});
	it('keeps the prompt, ignores PreToolUse', () => {
		expect(eventDetail({ hook_event_name: 'UserPromptSubmit', prompt: '  add   a\nfeature ' }, rel)).toEqual({ prompt: 'add a feature' });
		expect(eventDetail({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/a.ts' } }, rel)).toBeNull();
	});
});

let id = 0;
const ev = (event: string, o: Partial<RunEvent> & { tool?: string | null } = {}, ts = 1_000 + id * 1000): RunEvent => {
	const base = { event, tool: o.tool ?? null, path: o.path ?? null, decision: o.decision ?? 'allow', reason: o.reason ?? null, detail: o.detail ?? null };
	return { id: ++id, sessionId: 's', ts, ...base, ...classifyEvent(base) };
};
const T = (command: string, t: Partial<{ passed: number; failed: number; ok: boolean }>) => ev('PostToolUse', { tool: 'Bash', path: command, detail: { command, tests: { framework: 'pytest', passed: t.passed ?? 0, failed: t.failed ?? 0, skipped: 0, errors: 0, total: (t.passed ?? 0) + (t.failed ?? 0), ok: t.ok ?? !(t.failed) } } });

describe('classifyEvent and runStatus', () => {
	it('words events for people', () => {
		expect(ev('PostToolUse', { tool: 'Edit', detail: { file: 'src/a.ts', added: 3, removed: 1 } }).label).toBe('Edited src/a.ts +3 −1');
		expect(ev('PreToolUse', { tool: 'Read', path: 'src/a.ts', decision: 'deny', reason: '[RIAF] served from the pack' }).kind).toBe('served');
		expect(ev('PreToolUse', { tool: 'Read', path: 'src/a.ts', decision: 'deny', reason: '[RIAF] you already read this: repeat blocked' }).kind).toBe('blocked');
		expect(ev('Stop').kind).toBe('turn-end');
		expect(T('pytest', { passed: 4 }).label).toBe('Ran tests (pytest): 4 passed');
	});
	it('status follows the last event', () => {
		const now = 10_000_000;
		expect(runStatus([{ event: 'PostToolUse', ts: now - 5_000 }], now)).toBe('running');
		expect(runStatus([{ event: 'PostToolUse', ts: now - 10 * 60_000 }], now)).toBe('stale');
		expect(runStatus([{ event: 'PostToolUse', ts: now - 1_000 }, { event: 'Stop', ts: now }], now)).toBe('waiting');
		expect(runStatus([{ event: 'Stop', ts: now - 5 }, { event: 'SessionEnd', ts: now }], now)).toBe('finished');
		expect(runStatus([], now)).toBe('stale');
	});
});

describe('buildRunReport', () => {
	const prompt = ev('UserPromptSubmit', { decision: 'context', detail: { prompt: 'add a multiply function', instruction: 'abc12345', pack: ['src/math.ts', 'src/math.test.ts', 'src/unused.ts'] } });
	const events: RunEvent[] = [
		ev('SessionStart', { decision: 'context' }), prompt,
		ev('PreToolUse', { tool: 'Read', path: 'src/math.ts', decision: 'deny', reason: '[RIAF] served from the pack' }),
		ev('PostToolUse', { tool: 'Read', path: 'src/other.ts' }),
		ev('PostToolUse', { tool: 'Edit', path: 'src/math.ts', detail: { file: 'src/math.ts', added: 4, removed: 0 } }),
		ev('PostToolUse', { tool: 'Write', path: 'src/math.test.ts', detail: { file: 'src/math.test.ts', added: 12, removed: 0 } }),
		T('pytest -q', { passed: 3, failed: 1, ok: false }),
		ev('PostToolUse', { tool: 'Edit', path: 'src/math.ts', detail: { file: 'src/math.ts', added: 1, removed: 1 } }),
		T('pytest -q', { passed: 4 }),
		ev('Stop'),
	];
	const now = events[events.length - 1].ts + 1000;
	const metrics = { proposed: 4, served: 1, blocked: 0, tokensServed: 900, tokensExecuted: 300, byPhase: { explore: { calls: 2, tokens: 100 }, implement: { calls: 3, tokens: 200 }, verify: { calls: 2, tokens: 50 } } };
	const r = buildRunReport({ sessionId: 's', events, metrics, now, instruction: { id: 'abc12345', request: 'add a multiply function', intent: 'feature', plan: ['a', 'b'], verification: ['run tests'], packPaths: ['src/math.ts', 'src/math.test.ts', 'src/unused.ts', 'src/', '(plan)'] }, git: { changed: [{ file: 'src/math.ts', added: 5, removed: 1 }], untracked: ['src/math.test.ts'] } });

	it('says the run ended on green and went red to green', () => {
		expect(r.verdict).toBe('tests-passing'); expect(r.headline).toMatch(/passing tests/);
		expect(r.tests.runs).toHaveLength(2); expect(r.tests.redToGreen).toBe(true); expect(r.tests.final?.passed).toBe(4);
	});
	it('aggregates edits and flags test files', () => {
		const m = r.files.edited.find(f => f.path === 'src/math.ts')!;
		expect(m).toMatchObject({ edits: 2, added: 5, removed: 1, isTest: false, inPack: true });
		expect(r.files.edited.find(f => f.path === 'src/math.test.ts')).toMatchObject({ isTest: true });
		expect(r.tests.testFilesTouched).toEqual(['src/math.test.ts']); expect(r.tests.newTestFiles).toEqual(['src/math.test.ts']);
	});
	it('scores context quality against the pack', () => {
		// math.test.ts is a file the run created, so it is neither a hit nor a miss; math.ts hit, other.ts missed.
		expect(r.context).toMatchObject({ touched: 2, touchedInPack: 1, hitRate: 0.5 });
		expect(r.context!.missed).toEqual(['src/other.ts']); expect(r.context!.unused).toEqual(['src/unused.ts']);
		expect(r.files.edited.find(f => f.path === 'src/math.test.ts')).toMatchObject({ isNew: true, inPack: null });
		expect(r.files.edited.find(f => f.path === 'src/math.ts')).toMatchObject({ isNew: false, inPack: true });
	});
	it('reports governance and phases from the governor counters', () => {
		expect(r.governance).toMatchObject({ proposed: 4, served: 1, avoidedRate: 0.25, tokensServed: 900 });
		expect(r.phases.find(p => p.phase === 'implement')).toMatchObject({ calls: 3 });
	});
	it('collapses the timeline and writes markdown with every section', () => {
		expect(r.steps.some(s => s.kind === 'turn-end')).toBe(true);
		const md = reportToMarkdown(r);
		for (const h of ['# Run report', '## Summary', '## How it was done', '## Files changed', '## Tests', '## Governance and context']) expect(md).toContain(h);
		expect(md).toContain('| `src/math.ts` | 2 | +5 −1');
		expect(md).toContain('went from failing to passing');
	});
	it('does not claim success when no test ran, and is in-progress while running', () => {
		const none = buildRunReport({ sessionId: 's', events: events.filter(e => e.kind !== 'test'), now, metrics: null });
		expect(none.verdict).toBe('no-tests'); expect(none.headline).toMatch(/no test run/i);
		const live = buildRunReport({ sessionId: 's', events: events.slice(0, 6), now: events[5].ts + 1000, metrics: null });
		expect(live.verdict).toBe('in-progress');
		const failing = buildRunReport({ sessionId: 's', events: [prompt, T('pytest', { passed: 1, failed: 2, ok: false }), ev('Stop')], now, metrics: null });
		expect(failing.verdict).toBe('tests-failing'); expect(failing.headline).toMatch(/2 failing/);
	});
	it('summarizeRun gives the list row', () => {
		const s = summarizeRun('s', events, now);
		expect(s).toMatchObject({ status: 'waiting', turns: 1, filesRead: 1, filesEdited: 2, linesAdded: 17, title: 'add a multiply function', tests: { runs: 2, passed: 4, failed: 0, lastOk: true } });
	});
});
