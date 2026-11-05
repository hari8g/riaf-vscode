import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveRiafMcp, mcpApproval, mcpJsonStatus, writeMcpJson } from '../src/claudeCodeStatus.js';

describe('registering and approving the riaf MCP server', () => {
	const dir = mkdtempSync(join(tmpdir(), 'riaf-mcp-'));
	const ext = join(dir, 'ext'), root = join(dir, 'repo');
	mkdirSync(join(ext, 'plugin'), { recursive: true }); mkdirSync(root, { recursive: true });
	writeFileSync(join(ext, 'plugin', 'riaf-mcp.mjs'), '// launcher\n');
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('writes .mcp.json and the launcher, keeping other servers', () => {
		writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
		expect(writeMcpJson(root, ext, join(root, '.riaf', 'index.sqlite'))).toBe(join(root, '.mcp.json'));
		const j = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
		expect(Object.keys(j.mcpServers).sort()).toEqual(['other', 'riaf']);
		expect(j.mcpServers.riaf.args).toEqual([join(root, '.riaf', 'riaf-mcp.mjs'), '--workspace', root, '--db', join(root, '.riaf', 'index.sqlite')]);
		expect(existsSync(join(root, '.riaf', 'riaf-mcp.mjs'))).toBe(true);
		expect(mcpJsonStatus(root, ext).present).toBe(true);
	});
	it('does nothing when the extension has no launcher', () => { expect(writeMcpJson(root, join(dir, 'nowhere'), 'x')).toBeNull(); });
	it('approves the server for this user without touching the shared settings', () => {
		expect(mcpApproval(root)).toEqual({ enabled: false, allowed: false });
		writeFileSync(join(root, '.claude-keep'), '');
		mkdirSync(join(root, '.claude'), { recursive: true });
		writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
		approveRiafMcp(root); approveRiafMcp(root);
		const local = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
		expect(local.enabledMcpjsonServers).toEqual(['riaf']);
		expect(local.permissions.allow).toEqual(['Bash(ls)', 'mcp__riaf']);
		expect(mcpApproval(root)).toEqual({ enabled: true, allowed: true });
		expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(false);
	});
});
