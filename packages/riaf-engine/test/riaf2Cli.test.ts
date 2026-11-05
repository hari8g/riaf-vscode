import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCli } from '../src/cli.js';
import { findDaemon, parseArgs } from '../src/riaf2Cli.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@x' } });

describe('riaf CLI (RIAF 2.0 commands)', () => {
	let dir: string;
	const out: string[] = [];
	const run = (...argv: string[]) => executeCli([...argv, '--repo', dir], { log: l => out.push(l) });

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'riaf-cli-'));
		mkdirSync(join(dir, 'src'));
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'cli-demo', scripts: { test: 'vitest run' } }));
		writeFileSync(join(dir, 'src', 'auth.ts'), 'export function login(user: string): boolean {\n\treturn user.length > 0;\n}\n');
		writeFileSync(join(dir, 'src', 'auth.test.ts'), "import { login } from './auth';\ntest('login', () => expect(login('a')).toBe(true));\n");
		git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'feat: login');
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

	it('parses flags with values, inline values and booleans', () => {
		expect(parseArgs(['pack', '--intent', 'fix x', '--budget=32k', '--fresh'])).toEqual({ positional: ['pack'], flags: { intent: 'fix x', budget: '32k', fresh: true } });
	});

	it('indexes, searches, compiles packs in several formats and shows history', async () => {
		expect(await run('index')).toBe(0);
		expect(out.join('\n')).toMatch(/indexed \d+ files/);
		out.length = 0;
		expect(await run('search', 'login', '--mode', 'structural')).toBe(0);
		expect(out.join('\n')).toMatch(/src\/auth\.ts:1/);
		out.length = 0;
		expect(await run('pack', '--intent', 'Fix login so empty user names are rejected', '--format', 'md', '--budget', '4k')).toBe(0);
		expect(out.join('\n')).toMatch(/# RIAF Context Pack[\s\S]*src\/auth\.ts/);
		out.length = 0;
		expect(await run('pack', '--intent', 'Fix login', '--format', 'openai')).toBe(0);
		expect(JSON.parse(out.join('\n')).messages).toHaveLength(2);
		out.length = 0;
		expect(await run('pack', '--intent', 'Fix login', '--format', 'agents-md')).toBe(0);
		expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toMatch(/Working agreement/);
		out.length = 0;
		expect(await run('history', 'src/auth.ts')).toBe(0);
		expect(out.join('\n')).toMatch(/History card — src\/auth\.ts/);
		out.length = 0;
		expect(await run('pack', '--intent', 'x', '--format', 'nope')).toBe(2);
	}, 60_000);

	it('writes the Claude Code integration with init --host claude', async () => {
		expect(await run('init', '--host', 'claude', '--mcp-command', 'node /opt/riaf/mcp.mjs')).toBe(0);
		expect(existsSync(join(dir, '.claude', 'hooks', 'riaf-govern.mjs'))).toBe(true);
		const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
		expect(mcp.mcpServers.riaf).toEqual({ command: 'node', args: ['/opt/riaf/mcp.mjs', '--workspace', dir], env: {} });
		expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toMatch(/riaf_lookup/);
	});
});

describe('riaf CLI (intent + instruction + serve)', () => {
	let dir: string;
	const out: string[] = [];
	const run = (...argv: string[]) => executeCli([...argv, '--repo', dir], { log: l => out.push(l) });
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'riaf-cli2-'));
		mkdirSync(join(dir, 'src'));
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'cli-demo', scripts: { test: 'vitest run' } }));
		writeFileSync(join(dir, 'src', 'auth.ts'), 'export function login(user: string): boolean {\n\treturn user.length > 0;\n}\n');
		git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'feat: login');
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

	it('classify prints the route; instruct saves current.md', async () => {
		expect(await run('index')).toBe(0); out.length = 0;
		expect(await run('classify', 'Fix login so empty user names are rejected')).toBe(0);
		expect(out.join('\n')).toMatch(/^Intent: bugfix/);
		out.length = 0;
		expect(await run('classify', 'fix it')).toBe(0);
		expect(out.join('\n')).toMatch(/Would ask first/);
		out.length = 0;
		expect(await run('instruct', 'Fix login so empty user names are rejected', '--budget', '4k', '--quiet')).toBe(0);
		expect(out.join('\n')).toMatch(/pack: \d+ items/);
		expect(existsSync(join(dir, '.claude', 'riaf', 'instructions', 'current.md'))).toBe(true);
		expect(readFileSync(join(dir, '.claude', 'riaf', 'instructions', 'current.md'), 'utf8')).toMatch(/## Plan/);
	});

	it('findDaemon prefers the explicit path and falls back to the extension dist', () => {
		expect(findDaemon('/nonexistent/x.mjs')).not.toBe('/nonexistent/x.mjs');
		const ext = join(__dirname, '..', '..', 'extension', 'dist', 'daemon.mjs');
		if (existsSync(ext)) { expect(findDaemon()).toBe(ext); }
	});
});
