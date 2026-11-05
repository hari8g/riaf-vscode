import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Riaf2 } from '@bosch-mps/riaf-core';
import { Riaf2Host, RUN_MAX_IDLE_MS } from '../src/riaf2Host.js';
import { RiafDaemon } from '../src/daemon/server.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@x' } });

describe('every prompt is a fresh run: earlier runs are switched off, saved and cleared', () => {
	let dir: string; let root: string; let riaf: Riaf2; let host: Riaf2Host; let keep: Riaf2Host; let daemon: RiafDaemon; let base: string; let token: string;
	const consoleDir = join(tmpdir(), `riaf-console-life-${process.pid}`);
	const call = async (path: string) => {
		const res = await fetch(`${base}api${path}`, { headers: { authorization: `Bearer ${token}` } });
		return { status: res.status, json: await res.json() as Record<string, any> };
	};
	const hook = (h: Riaf2Host, p: Record<string, unknown>) => h.handleHook({ session_id: 'A', cwd: root, ...p } as never);
	const ids = (h: Riaf2Host) => h.runSummaries().map(r => r.sessionId);
	const edit = (h: Riaf2Host, sid: string, file = 'src/math.ts') => hook(h, { session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(root, file), old_string: 'a', new_string: 'a\nb' }, tool_response: {} });

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'riaf-life-')); root = join(dir, 'repo');
		mkdirSync(join(root, 'src'), { recursive: true });
		writeFileSync(join(root, 'src', 'math.ts'), 'export const add = (a: number, b: number) => a + b;\n');
		git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'init');
		mkdirSync(consoleDir, { recursive: true });
		writeFileSync(join(consoleDir, 'index.html'), '<html></html>'); writeFileSync(join(consoleDir, 'console.js'), '1');
		riaf = await Riaf2.open({ workspaceRoot: root, dbPath: join(dir, 'index.sqlite'), persistDebounceMs: 20 });
		await riaf.indexRepo();
		host = new Riaf2Host(riaf, { host: 'test' });
		daemon = new RiafDaemon({ root, host, version: 'test', surface: 'cli', consoleDir, extensionPath: join(dir, 'ext'), integrations: { config: () => ({}), saveConfig: () => undefined, getSecret: async () => undefined, setSecret: async () => undefined, fetch: async () => new Response('{}') } });
		const info = await daemon.start(0); base = info.url; token = info.token;
	}, 60_000);
	afterAll(async () => { await daemon.stop(); await host.stop(); await riaf.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); rmSync(consoleDir, { recursive: true, force: true }); });

	it('the first prompt opens the run; SessionStart before it belongs to the same run', async () => {
		await hook(host, { hook_event_name: 'SessionStart' });
		await hook(host, { hook_event_name: 'UserPromptSubmit', prompt: 'add a multiply function to src/math.ts please' });
		expect(ids(host)).toEqual(['A']);
		const kinds = host.runEvents('A').map(e => e.kind);
		expect(kinds).toEqual(expect.arrayContaining(['start', 'briefing', 'prompt']));
	});

	it('a second prompt in the same Claude session starts a clean run and clears the first (saving its report)', async () => {
		await edit(host, 'A');
		await hook(host, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npx vitest run' }, tool_response: { stdout: ' Tests  1 passed (1)\n', stderr: '' } });
		await hook(host, { hook_event_name: 'Stop' });
		expect(host.runSummaries()[0].status).toBe('waiting');

		await hook(host, { hook_event_name: 'UserPromptSubmit', prompt: 'now explain how the add function is used' });
		const rows = host.runSummaries();
		expect(rows).toHaveLength(1);
		expect(rows[0].sessionId).toMatch(/^A~[0-9a-z]+$/);
		expect(rows[0].status).toBe('running');
		expect(rows[0].filesEdited).toBe(0); // nothing of the first run leaks in
		expect(host.runEvents('A')).toEqual([]); // first run deleted
		expect(host.runEvents(rows[0].sessionId).filter(e => e.kind === 'prompt').map(e => e.label).join()).toMatch(/explain how the add function/);

		const saved = host.savedReports();
		expect(saved).toHaveLength(1);
		const md = host.savedReport(saved[0].name)!;
		expect(md).toContain('# Run report'); expect(md).toContain('src/math.ts');
	});

	it('the later run still carries a git baseline, and events of the same prompt join it', async () => {
		const id = ids(host)[0];
		await edit(host, 'A', 'src/math.ts');
		await hook(host, { hook_event_name: 'Stop' });
		expect(host.runEvents(id).some(e => e.event === 'UserPromptSubmit' && e.detail?.head)).toBe(true);
		const rep = host.runReport(id);
		expect(rep.git?.startHead).toMatch(/^[0-9a-f]{40}$/);
		expect(rep.files.edited.map(f => f.path)).toEqual(['src/math.ts']);
	});

	it('a prompt from another Claude session switches the old session off: its stragglers are not recorded', async () => {
		await hook(host, { session_id: 'B', hook_event_name: 'UserPromptSubmit', prompt: 'review the whole repository for dead code' });
		expect(ids(host)).toEqual(['B']);
		await hook(host, { session_id: 'A', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(root, 'src', 'math.ts') }, tool_response: {} });
		expect(ids(host)).toEqual(['B']); // still only B
		expect(host.latestSessionId()).toBe('B');
		// when A speaks again with a prompt, it takes over
		await hook(host, { session_id: 'A', hook_event_name: 'UserPromptSubmit', prompt: 'back to the multiply function task' });
		expect(ids(host)).toHaveLength(1); expect(ids(host)[0]).toMatch(/^A/);
	});

	it('the activity feed hides a finished run from before the window was armed, but follows a running one', async () => {
		await hook(host, { hook_event_name: 'Stop' });
		expect(host.activity(0, null, Date.now() - 60_000).sessionId).not.toBeNull(); // finished after arming: shown
		expect(host.activity(0, null, Date.now() + 1000)).toMatchObject({ sessionId: null, events: [], summary: null }); // armed after it ended: clean window
		await hook(host, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(root, 'src', 'math.ts') }, tool_response: {} });
		expect(host.activity(0, null, Date.now() + 1000).summary?.status).toBe('running'); // opened mid-run: follow it
		expect(host.activity(0, ids(host)[0], Date.now() + 1000).sessionId).toBe(ids(host)[0]); // an explicit session is never hidden
		const r = await call(`/activity?since=0&after=${Date.now() + 5000}`);
		expect(r.json.summary.status).toBe('running');
	});

	it('runs idle for more than 12 hours are archived and swept; saved reports are served and path-safe', async () => {
		const old = Date.now() - RUN_MAX_IDLE_MS - 60_000;
		const raw = host.riaf.store.raw;
		raw.run("INSERT INTO session_event(session_id, ts, event, decision) VALUES ('OLD', ?, 'UserPromptSubmit', 'allow')", [old]);
		raw.run("INSERT INTO session_event(session_id, ts, event, tool, path, decision, detail) VALUES ('OLD', ?, 'PostToolUse', 'Edit', 'src/math.ts', 'allow', ?)", [old + 1000, JSON.stringify({ file: 'src/math.ts', added: 1, removed: 0 })]);
		expect(ids(host)).toContain('OLD');
		const before = host.savedReports().length;
		expect(host.sweepRuns()).toBe(1);
		expect(ids(host)).not.toContain('OLD');
		expect(host.savedReports().length).toBe(before + 1);

		const list = await call('/reports');
		expect(list.json.reports.length).toBe(before + 1);
		const file = await call(`/reports/file?name=${encodeURIComponent(list.json.reports[0].name)}`);
		expect(file.status).toBe(200); expect(file.json.markdown).toContain('# Run report');
		expect((await call(`/reports/file?name=${encodeURIComponent('../../etc/passwd')}`)).status).toBe(404);
		expect((await call(`/reports/file?name=${encodeURIComponent('..%2Fx.md')}`)).status).toBe(404);
		expect(readdirSync(join(root, '.riaf', 'reports')).every(f => f.endsWith('.md'))).toBe(true);
	});

	it('keepRuns keeps the previous run as a closed, finished entry', async () => {
		keep = new Riaf2Host(riaf, { host: 'test', keepRuns: 1 });
		riaf.store.raw.run('DELETE FROM session_event'); riaf.store.raw.run('DELETE FROM session_metric');
		await hook(keep, { session_id: 'K', hook_event_name: 'UserPromptSubmit', prompt: 'first task for the keep test' });
		await hook(keep, { session_id: 'K', hook_event_name: 'UserPromptSubmit', prompt: 'second task for the keep test' });
		await hook(keep, { session_id: 'K', hook_event_name: 'UserPromptSubmit', prompt: 'third task for the keep test' });
		const rows = keep.runSummaries();
		expect(rows).toHaveLength(2);
		expect(rows[0].status).toBe('running');
		expect(rows[1].status).toBe('finished');
		expect(keep.runEvents(rows[1].sessionId).at(-1)?.event).toBe('Superseded');
		expect(existsSync(join(root, '.riaf', 'reports'))).toBe(true);
		expect(readFileSync(join(root, '.riaf', 'reports', readdirSync(join(root, '.riaf', 'reports'))[0]), 'utf8').length).toBeGreaterThan(10);
		await keep.stop();
	});

	it('a pasted RIAF brief keeps its own id and request and is not compiled again', async () => {
		const { instruction } = await host.instruct('add a multiply function to src/math.ts please');
		await hook(host, { session_id: 'P', hook_event_name: 'UserPromptSubmit', prompt: instruction.markdown });
		const rows = host.runSummaries().filter(r => r.sessionId.startsWith('P'));
		expect(rows).toHaveLength(1);
		const submit = host.runEvents(rows[0].sessionId).find(e => e.event === 'UserPromptSubmit')!;
		expect(submit.detail?.instruction).toBe(instruction.instruction_id);
		expect(submit.detail?.brief).toBe(instruction.instruction_id);
		expect(submit.detail?.prompt).not.toMatch(/^# RIAF Prompt Instruction/);
		expect(host.currentInstruction()?.instruction_id).toBe(instruction.instruction_id);
		const rep = host.runReport(rows[0].sessionId);
		expect(rep.task.instruction?.id).toBe(instruction.instruction_id);
		expect(rep.task.instruction?.plan.length).toBeGreaterThan(0);
	});

	it('a background-task notification joins the running run instead of replacing it', async () => {
		await hook(host, { session_id: 'N', hook_event_name: 'UserPromptSubmit', prompt: 'add a divide function to src/math.ts please' });
		await edit(host, 'N');
		const before = ids(host);
		await hook(host, { session_id: 'N', hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>x1</task-id>\n<status>failed</status>\n</task-notification>' });
		expect(ids(host)).toEqual(before);
		const rep = host.runReport(before[0]);
		expect(rep.files.edited.map(f => f.path)).toEqual(['src/math.ts']);
		expect(rep.task.prompts).toHaveLength(1);
		expect(rep.task.prompts[0].text).toMatch(/divide function/);
	});
});

import { spawn } from 'node:child_process';
import { liveGovernorOwner } from '../src/riaf2Host.js';

describe('who owns the hooks', () => {
	it('startGovernor is idempotent, and a background process leaves a live owner alone but replaces a dead one', async () => {
		const d = mkdtempSync(join(tmpdir(), 'riaf-own-')); mkdirSync(join(d, '.riaf'), { recursive: true });
		const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { stdio: 'ignore' });
		try {
			expect(liveGovernorOwner(d)).toBeNull(); // no file
			writeFileSync(join(d, '.riaf', 'governor.json'), JSON.stringify({ pid: sleeper.pid }));
			expect(liveGovernorOwner(d)).toBe(sleeper.pid); // a live console owns it: do not take it
			expect(liveGovernorOwner(d, sleeper.pid)).toBeNull(); // that is us
			sleeper.kill(); await new Promise(r => sleeper.once('exit', r));
			expect(liveGovernorOwner(d)).toBeNull(); // the owner died: take over
			writeFileSync(join(d, '.riaf', 'governor.json'), 'not json');
			expect(liveGovernorOwner(d)).toBeNull();
		} finally { sleeper.kill(); rmSync(d, { recursive: true, force: true }); }
	});

	it('a host asked twice to listen keeps one endpoint', async () => {
		const d = mkdtempSync(join(tmpdir(), 'riaf-gov-')); const r = join(d, 'repo'); mkdirSync(join(r, 'src'), { recursive: true });
		writeFileSync(join(r, 'src', 'a.ts'), 'export const a = 1;\n'); git(r, 'init', '-q', '-b', 'main'); git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'i');
		const rf = await Riaf2.open({ workspaceRoot: r, dbPath: join(d, 'i.sqlite'), persistDebounceMs: 20 });
		const h = new Riaf2Host(rf, { host: 'test' });
		try {
			const a = await h.startGovernor(); const b = await h.startGovernor();
			expect(b).toBe(a); expect(h.governing).toBe(true);
			expect(JSON.parse(readFileSync(join(r, '.riaf', 'governor.json'), 'utf8')).pid).toBe(process.pid);
		} finally { await h.stop(); await rf.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
	});
});
