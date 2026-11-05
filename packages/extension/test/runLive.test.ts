import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Riaf2 } from '@bosch-mps/riaf-core';
import { Riaf2Host } from '../src/riaf2Host.js';
import { RiafDaemon } from '../src/daemon/server.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@x' } });

describe('live run feed, sessions list and run report (hook payloads in, console API out)', () => {
	let dir: string; let root: string; let riaf: Riaf2; let host: Riaf2Host; let daemon: RiafDaemon; let base: string; let token: string;
	const consoleDir = join(tmpdir(), `riaf-console-live-${process.pid}`);
	const call = async (method: string, path: string, body?: unknown) => {
		const res = await fetch(`${base}api${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
		return { status: res.status, json: await res.json() as Record<string, any> };
	};
	const hook = (p: Record<string, unknown>) => host.handleHook({ session_id: 'S1', cwd: root, ...p } as never);

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'riaf-live-')); root = join(dir, 'repo');
		mkdirSync(join(root, 'src'), { recursive: true });
		writeFileSync(join(root, 'src', 'math.ts'), 'export const add = (a: number, b: number) => a + b;\n');
		writeFileSync(join(root, 'src', 'math.test.ts'), "import { add } from './math';\ntest('add', () => expect(add(1, 2)).toBe(3));\n");
		git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'init');
		writeFileSync(join(root, 'notes.txt'), 'untracked before the session began\n');
		mkdirSync(consoleDir, { recursive: true });
		writeFileSync(join(consoleDir, 'index.html'), '<html></html>'); writeFileSync(join(consoleDir, 'console.js'), '1');
		riaf = await Riaf2.open({ workspaceRoot: root, dbPath: join(dir, 'index.sqlite'), persistDebounceMs: 20 });
		await riaf.indexRepo();
		host = new Riaf2Host(riaf, { host: 'test' });
		daemon = new RiafDaemon({ root, host, version: 'test', surface: 'cli', consoleDir, extensionPath: join(dir, 'ext'), integrations: { config: () => ({}), saveConfig: () => undefined, getSecret: async () => undefined, setSecret: async () => undefined, fetch: async () => new Response('{}') } });
		const info = await daemon.start(0); base = info.url; token = info.token;
	}, 60_000);
	afterAll(async () => { await daemon.stop(); await host.stop(); await riaf.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); rmSync(consoleDir, { recursive: true, force: true }); });

	it('a session that only sent a prompt still appears in the list (the old list needed governor counters)', async () => {
		await hook({ session_id: 'ONLY', hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
		const r = await call('GET', '/sessions');
		const row = (r.json.sessions as any[]).find(s => s.sessionId === 'ONLY');
		expect(row).toBeTruthy(); expect(row.status).toBe('running'); expect(row.counters).toEqual({});
	});

	it('streams a full run and the cursor only returns new events', async () => {
		await hook({ hook_event_name: 'SessionStart' });
		await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'add a multiply function to src/math.ts with a test' });
		await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(root, 'src', 'math.ts') } });
		await hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(root, 'src', 'math.ts') }, tool_response: { type: 'text', file: { content: 'export const add...' } } });

		const first = await call('GET', '/activity?session=S1&since=0');
		expect(first.json.sessionId).toBe('S1');
		expect(first.json.events.map((e: any) => e.kind)).toContain('prompt');
		expect(first.json.summary.status).toBe('running');
		const cursor = first.json.cursor as number;
		expect((await call('GET', `/activity?session=S1&since=${cursor}`)).json.events).toEqual([]);

		// the agent edits (really, so git can verify) and runs tests: red, then green
		writeFileSync(join(root, 'src', 'math.ts'), 'export const add = (a: number, b: number) => a + b;\nexport const multiply = (a: number, b: number) => a * b;\n');
		writeFileSync(join(root, 'src', 'multiply.test.ts'), "import { multiply } from './math';\ntest('mul', () => expect(multiply(2, 3)).toBe(6));\n");
		await hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(root, 'src', 'math.ts'), old_string: 'x', new_string: 'x\ny' }, tool_response: {} });
		await hook({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(root, 'src', 'multiply.test.ts'), content: 'a\nb\n' }, tool_response: {} });
		await hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npx vitest run' }, error: 'Exit code 1\n Tests  1 failed | 1 passed (2)\n Duration  1.2s' });
		await hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npx vitest run' }, tool_response: { stdout: ' Tests  2 passed (2)\n Duration  1.1s', stderr: '' } });

		const next = await call('GET', `/activity?session=S1&since=${cursor}`);
		const labels = (next.json.events as any[]).map(e => e.label);
		expect(labels.some(l => /^Edited src\/math\.ts/.test(l))).toBe(true);
		expect(labels).toContain('Wrote src/multiply.test.ts +2 −0');
		expect(labels.filter(l => /^Ran tests/.test(l))).toEqual(['Ran tests (vitest): 1 passed, 1 failed', 'Ran tests (vitest): 2 passed']);
		expect(next.json.summary.tests).toMatchObject({ runs: 2, lastOk: true });
		expect(next.json.summary.filesEdited).toBe(2);
	});

	it('Stop marks the run as done, and "latest" follows the newest session', async () => {
		await hook({ hook_event_name: 'Stop' });
		const a = await call('GET', '/activity?since=0');
		expect(a.json.sessionId).toBe('S1'); expect(a.json.summary.status).toBe('waiting');
		await hook({ session_id: 'NEWER', hook_event_name: 'UserPromptSubmit', prompt: 'something else' });
		expect((await call('GET', '/activity?since=0')).json.sessionId).toBe('NEWER');
	});

	it('builds the report: verdict, red to green, files verified against git, markdown', async () => {
		const r = await call('GET', '/session/report?id=S1');
		expect(r.status).toBe(200);
		const rep = r.json.report;
		expect(rep.verdict).toBe('tests-passing'); expect(rep.tests.redToGreen).toBe(true); expect(rep.tests.final).toMatchObject({ passed: 2, ok: true });
		expect(rep.files.edited.map((f: any) => f.path).sort()).toEqual(['src/math.ts', 'src/multiply.test.ts']);
		expect(rep.tests.testFilesTouched).toEqual(['src/multiply.test.ts']);
		expect(rep.git.changed.some((c: any) => c.file === 'src/math.ts')).toBe(true);
		expect(rep.git.untracked).toContain('src/multiply.test.ts');
		expect(rep.git.untracked).not.toContain('notes.txt'); // already there when the session started: not the run's doing
		expect(rep.files.edited.find((f: any) => f.path === 'src/multiply.test.ts')).toMatchObject({ isNew: true });
		expect(rep.git.startHead).toMatch(/^[0-9a-f]{40}$/);
		expect(r.json.markdown).toContain('# Run report — Finished with passing tests');
		expect((await call('GET', '/session/report?id=S1&format=md')).json.markdown).toContain('## Tests');
		expect((await call('GET', '/session/report?id=nope')).json.report.verdict).toBe('no-tests');
	});

	it('diagnoses the connection and installs the hooks, including Stop', async () => {
		let h = (await call('GET', '/hooks/health')).json;
		expect(h.missing).toContain('Stop'); expect(h.hookScript).toBe(false); expect(h.eventsTotal).toBeGreaterThan(0);
		const inst = await call('POST', '/hooks/install', {});
		expect(inst.status).toBe(200);
		h = (await call('GET', '/hooks/health')).json;
		expect(h.missing).toEqual([]); expect(h.hookScript).toBe(true);
		const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
		for (const e of ['Stop', 'SessionEnd', 'PostToolUseFailure']) expect(JSON.stringify(settings.hooks[e])).toContain('riaf-govern.mjs');
		expect(existsSync(join(root, '.riaf', 'policy.yaml'))).toBe(true);
	});

	it('the sessions list carries counters for governed sessions and is newest first', async () => {
		const rows = (await call('GET', '/sessions')).json.sessions as any[];
		expect(rows[0].sessionId).toBe('NEWER');
		const s1 = rows.find(r => r.sessionId === 'S1');
		expect(s1.counters.proposed).toBeGreaterThan(0); expect(s1.title).toMatch(/multiply/);
	});
});
