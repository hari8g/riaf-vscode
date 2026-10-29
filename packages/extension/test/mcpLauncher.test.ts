import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpJsonStatus } from '../src/claudeCodeSetup.js';

const launcher = join(__dirname, '..', 'plugin', 'riaf-mcp.mjs');

describe('version-independent MCP launcher', () => {
	it('picks the newest installed extension folder and passes arguments through', () => {
		const home = mkdtempSync(join(tmpdir(), 'riaf-launcher-'));
		const exts = join(home, 'exts');
		for (const v of ['0.1.0', '0.10.0', '0.2.0']) {   // 0.10.0 must beat 0.2.0 numerically, not lexically
			const dir = join(exts, `bosch-mps.riaf-vscode-${v}`, 'dist'); mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, 'mcp.mjs'), `console.log(JSON.stringify({ version: ${JSON.stringify(v)}, args: process.argv.slice(2) }));\n`);
		}
		mkdirSync(join(exts, 'bosch-mps.riaf-vscode-9.9.9'), { recursive: true });            // no dist → ignored
		const out = execFileSync(process.execPath, [launcher, '--workspace', '/w', '--db', '/d.sqlite'], { env: { ...process.env, VSCODE_EXTENSIONS: exts, RIAF_EXTENSION_DIR: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		expect(JSON.parse(out.trim())).toEqual({ version: '0.10.0', args: ['--workspace', '/w', '--db', '/d.sqlite'] });
	});

	it('honours RIAF_EXTENSION_DIR and fails clearly when nothing is installed', () => {
		const home = mkdtempSync(join(tmpdir(), 'riaf-launcher-'));
		const pinned = join(home, 'pinned', 'dist'); mkdirSync(pinned, { recursive: true });
		writeFileSync(join(pinned, 'mcp.mjs'), `console.log('pinned');\n`);
		const out = execFileSync(process.execPath, [launcher], { env: { ...process.env, VSCODE_EXTENSIONS: join(home, 'none'), RIAF_EXTENSION_DIR: join(home, 'pinned') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		expect(out.trim()).toBe('pinned');
		let code = 0; let err = '';
		try { execFileSync(process.execPath, [launcher], { env: { ...process.env, VSCODE_EXTENSIONS: join(home, 'none'), RIAF_EXTENSION_DIR: '', HOME: home, USERPROFILE: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
		catch (e) { code = (e as { status: number }).status; err = String((e as { stderr: string }).stderr); }
		expect(code).toBe(2);
		expect(err).toMatch(/RIAF extension not found/);
	});
});

describe('.mcp.json status', () => {
	it('reports absent, launcher-based, versioned-current, versioned-old and missing paths', () => {
		const root = mkdtempSync(join(tmpdir(), 'riaf-mcpjson-'));
		const extNew = join(root, 'exts', 'bosch-mps.riaf-vscode-0.2.0'); mkdirSync(join(extNew, 'dist'), { recursive: true });
		const extOld = join(root, 'exts', 'bosch-mps.riaf-vscode-0.1.0'); mkdirSync(join(extOld, 'dist'), { recursive: true });
		writeFileSync(join(extNew, 'dist', 'mcp.mjs'), ''); writeFileSync(join(extOld, 'dist', 'mcp.mjs'), '');
		const write = (entry?: string) => writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: entry ? { riaf: { command: 'node', args: [entry, '--workspace', root] } } : {} }));
		expect(mcpJsonStatus(root, extNew).present).toBe(false);                               // no file
		write(); expect(mcpJsonStatus(root, extNew).present).toBe(false);                      // no riaf server
		mkdirSync(join(root, '.riaf')); writeFileSync(join(root, '.riaf', 'riaf-mcp.mjs'), '');
		write(join(root, '.riaf', 'riaf-mcp.mjs')); expect(mcpJsonStatus(root, extNew)).toEqual({ present: true, entry: join(root, '.riaf', 'riaf-mcp.mjs') });
		write(join(extNew, 'dist', 'mcp.mjs')); expect(mcpJsonStatus(root, extNew).stale).toMatch(/versioned extension folder/);
		write(join(extOld, 'dist', 'mcp.mjs')); expect(mcpJsonStatus(root, extNew).stale).toMatch(/older extension version/);
		write(join(root, 'gone', 'mcp.mjs')); expect(mcpJsonStatus(root, extNew).stale).toMatch(/no longer exists/);
	});
});
