import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Riaf2 } from '@bosch-mps/riaf-core';
import { Riaf2Host } from '../src/riaf2Host.js';
import { RiafDaemon, readDaemonInfo } from '../src/daemon/server.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@x' } });

function makeRepo(root: string): void {
	mkdirSync(join(root, 'src'), { recursive: true });
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }, null, 2));
	writeFileSync(join(root, 'src', 'cart.ts'), `import { price } from './price';\n\nexport class Cart {\n\tprivate items: number[] = [];\n\tadd(cents: number): void { this.items.push(cents); }\n\ttotal(): number { return price(this.items); }\n}\n`);
	writeFileSync(join(root, 'src', 'price.ts'), `export function price(items: number[]): number {\n\treturn items.reduce((a, b) => a + b, 0);\n}\n`);
	writeFileSync(join(root, 'src', 'cart.test.ts'), `import { Cart } from './cart';\ntest('total', () => { const c = new Cart(); c.add(1); expect(c.total()).toBe(1); });\n`);
	writeFileSync(join(root, 'CLAUDE.md'), '# demo\n\nteam notes\n');
	git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'feat: cart');
}

describe('riafd (daemon behind the RIAF Console)', () => {
	let dir: string; let root: string; let riaf: Riaf2; let host: Riaf2Host; let daemon: RiafDaemon; let base: string; let token: string;
	const secrets = new Map<string, string>();
	let cfg: Record<string, Record<string, unknown>> = {};
	const consoleDir = join(tmpdir(), `riaf-console-${process.pid}`);

	const call = async (method: string, path: string, body?: unknown, auth = true) => {
		const res = await fetch(`${base}api${path}`, { method, headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
		return { status: res.status, json: await res.json() as Record<string, unknown> };
	};

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'riaf-daemon-'));
		root = join(dir, 'repo'); makeRepo(root);
		mkdirSync(consoleDir, { recursive: true });
		writeFileSync(join(consoleDir, 'index.html'), '<html><script>window.__RIAF__={token:"__RIAF_TOKEN__",root:"__RIAF_ROOT__",surface:"__RIAF_SURFACE__"}</script></html>');
		writeFileSync(join(consoleDir, 'console.js'), 'console.log(1)');
		riaf = await Riaf2.open({ workspaceRoot: root, dbPath: join(dir, 'index.sqlite'), persistDebounceMs: 20 });
		await riaf.indexRepo();
		host = new Riaf2Host(riaf, { host: 'test' });
		daemon = new RiafDaemon({
			root, host, version: 'test', surface: 'cli', consoleDir, extensionPath: join(dir, 'ext'),
			integrations: { config: () => cfg, saveConfig: c => { cfg = c as typeof cfg; }, getSecret: async k => secrets.get(k), setSecret: async (k, v) => { if (v === undefined) secrets.delete(k); else secrets.set(k, v); }, fetch: async () => new Response('{}', { status: 200 }) },
		});
		const info = await daemon.start(0);
		base = info.url; token = info.token;
	}, 60_000);
	afterAll(async () => { await daemon.stop(); await host.stop(); await riaf.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); rmSync(consoleDir, { recursive: true, force: true }); });

	it('writes .riaf/daemon.json, requires the token, and injects it into index.html only', async () => {
		const info = readDaemonInfo(root)!;
		expect(info.token).toBe(token);
		expect(info.pid).toBe(process.pid);
		expect((await call('GET', '/status', undefined, false)).status).toBe(401);
		const html = await (await fetch(base)).text();
		expect(html).toContain(`token:"${token}"`);
		expect(html).toContain('surface:"cli"');
		const js = await (await fetch(`${base}console.js`)).text();
		expect(js).toBe('console.log(1)');
		expect((await fetch(`${base}missing.txt`)).status).toBe(404);
	});

	it('GET /status describes index, repo, governance and Claude setup', async () => {
		const { status, json } = await call('GET', '/status');
		expect(status).toBe(200);
		const index = json.index as { indexed: boolean; files: number; chunks: number };
		expect(index.indexed).toBe(true);
		expect(index.files).toBeGreaterThanOrEqual(3);
		expect((json.repo as { branch: string }).branch).toBe('main');
		expect((json.claude as { mcpJson: boolean }).mcpJson).toBe(false);
		expect((json.governance as { policyPhases: string[] }).policyPhases).toContain('explore');
		expect((json.daemon as { token?: string }).token).toBeUndefined();
	});

	it('repository: tree, file detail and search', async () => {
		const tree = (await call('GET', '/repo/tree')).json as { files: { path: string; isTest: boolean; importedBy: number; symbols: number }[] };
		const cart = tree.files.find(f => f.path === 'src/cart.ts')!;
		expect(cart.symbols).toBeGreaterThan(0);
		expect(tree.files.find(f => f.path === 'src/cart.test.ts')!.isTest).toBe(true);
		expect(tree.files.find(f => f.path === 'src/price.ts')!.importedBy).toBe(1);
		const file = (await call('GET', '/repo/file?path=src/cart.ts')).json as { lines: number; expand: { imports: string[]; tests: string[] }; content: string };
		expect(file.lines).toBeGreaterThan(3);
		expect(file.expand.imports).toContain('src/price.ts');
		expect(file.expand.tests).toContain('src/cart.test.ts');
		expect(file.content).toContain('class Cart');
		const search = (await call('GET', '/repo/search?q=price&mode=structural')).json as { hits: { filePath: string }[] };
		expect(search.hits.map(h => h.filePath)).toContain('src/price.ts');
		expect((await call('GET', '/repo/file')).status).toBe(400);
	});

	it('pack studio: classify → instruction → render → send-to-claude', async () => {
		const c = (await call('POST', '/classify', { request: 'Fix the Cart.total rounding bug' })).json as { type: string; line: string; table: { mode: string } };
		expect(c.type).toBe('bugfix');
		expect(c.line).toMatch(/^Intent: bugfix/);
		expect(c.table.mode).toBe('agent');
		const i = (await call('POST', '/instruction', { request: 'Fix the Cart.total rounding bug', budget: 4000 })).json as { route: { line: string }; pack: { items: { path: string; why: string }[]; budget: { used_tokens: number } }; instruction: { instruction_id: string; markdown: string } };
		expect(i.pack.items.map(x => x.path)).toContain('src/cart.ts');
		expect(i.pack.items[0].why).toBeTruthy();
		expect(i.pack.budget.used_tokens).toBeLessThanOrEqual(4000);
		expect(i.instruction.markdown).toContain('## Plan');
		const cur = (await call('GET', '/instruction/current')).json as { instruction: { instruction_id: string } };
		expect(cur.instruction.instruction_id).toBe(i.instruction.instruction_id);
		const list = (await call('GET', '/instructions')).json as { instructions: { id: string }[] };
		expect(list.instructions[0].id).toBe(i.instruction.instruction_id);
		const one = (await call('GET', `/instruction?id=${i.instruction.instruction_id}`)).json as { markdown: string };
		expect(one.markdown).toBe(i.instruction.markdown);
		const r = (await call('POST', '/pack/render', { format: 'agents-md' })).json as { text: string };
		expect(r.text).toMatch(/^# AGENTS\.md/);
		expect((await call('POST', '/pack/render', { format: 'nope' })).status).toBe(400);
		const s = (await call('POST', '/send-to-claude', {})).json as { written: string[]; command: string };
		expect(s.written).toContain('CLAUDE.md');
		expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain('team notes');
		expect(existsSync(join(root, '.claude', 'commands', 'riaf-task.md'))).toBe(true);
		expect(s.command).toMatch(/^claude /);
		const fb = (await call('POST', '/feedback', { request: 'Fix the Cart.total rounding bug', predicted: 'bugfix', corrected: 'refactor' })).json as { count: number };
		expect(fb.count).toBe(1);
		expect(((await call('POST', '/classify', { request: 'Fix the Cart.total rounding bug' })).json as { source: string }).source).toBe('feedback');
	});

	it('governance: policy and rules round-trip through the files the governor reads', async () => {
		const before = (await call('GET', '/policy')).json as { exists: boolean; yaml: string };
		expect(before.exists).toBe(false);
		const put = await call('PUT', '/policy', { yaml: 'version: 1\nphases:\n  explore: { soft_calls: 7, max_calls: 9 }\n' });
		expect(put.status).toBe(200);
		expect(((put.json as { parsed: { phases: { explore: { soft_calls: number } } } }).parsed).phases.explore.soft_calls).toBe(7);
		expect(host.currentPolicy.phases.explore.max_calls).toBe(9);
		await call('PUT', '/rules', { path: '.riafrules', text: '- never console.log\n' });
		await call('PUT', '/rules', { path: '.riaf/rules/10-tests.md', text: 'tests beside source' });
		expect((await call('PUT', '/rules', { path: '../outside.md', text: 'x' })).status).toBe(400);
		const rules = (await call('GET', '/rules')).json as { riafrules: string; files: { path: string }[] };
		expect(rules.riafrules).toContain('never console.log');
		expect(rules.files.map(f => f.path)).toContain('.riaf/rules/10-tests.md');
		const hooks = (await call('GET', '/hooks')).json as { governHookPresent: boolean };
		expect(hooks.governHookPresent).toBe(false);
	});

	it('sessions: hook traffic shows up as sessions with per-call events', async () => {
		await host.handleHook({ session_id: 'cs1', hook_event_name: 'UserPromptSubmit', prompt: 'Explain how Cart computes the total' });
		const read = { session_id: 'cs1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(root, 'src', 'price.ts') } };
		await host.handleHook(read);
		await host.handleHook({ ...read, hook_event_name: 'PostToolUse', tool_response: { file: { content: 'x' } } });
		await host.handleHook(read); // served from the index → deny
		const s = (await call('GET', '/sessions')).json as { sessions: { sessionId: string }[] };
		expect(s.sessions.map(x => x.sessionId)).toContain('cs1');
		const ev = (await call('GET', '/session?id=cs1')).json as { events: { event: string; tool: string | null; decision: string | null; path: string | null }[] };
		expect(ev.events.some(e => e.event === 'UserPromptSubmit' && e.decision === 'context')).toBe(true);
		expect(ev.events.some(e => e.tool === 'Read' && e.decision === 'deny' && e.path === 'src/price.ts')).toBe(true);
	});

	it('adapters: list, settings and credentials through the supplied integration hooks', async () => {
		const a = (await call('GET', '/adapters')).json as { adapters: { id: string; enabled: boolean; credentials: { key: string; present: boolean }[] }[]; credentialsEditable: boolean };
		expect(a.credentialsEditable).toBe(true);
		const jira = a.adapters.find(x => x.id === 'jira')!;
		expect(jira.enabled).toBe(false);
		expect(jira.credentials.every(c => !c.present)).toBe(true);
		await call('PUT', '/adapter', { id: 'jira', settings: { enabled: true, baseUrl: 'https://jira.example.com' } });
		expect(cfg.jira).toEqual({ enabled: true, baseUrl: 'https://jira.example.com' });
		const creds = (await call('PUT', '/adapter/credentials', { id: 'jira', values: { [jira.credentials[0].key]: 'secret-value' } })).json as { missing: string[] };
		expect(secrets.get(`riaf.integration.jira.${jira.credentials[0].key}`)).toBe('secret-value');
		expect(creds.missing).not.toContain(jira.credentials[0].key);
		expect((await call('PUT', '/adapter', { id: 'nope', settings: {} })).status).toBe(400);
		const h = (await call('POST', '/adapter/health', { id: 'jira' })).json as { ok: boolean; message: string };
		expect(typeof h.ok).toBe('boolean');
		expect(h.message).toBeTruthy();
	});
});
