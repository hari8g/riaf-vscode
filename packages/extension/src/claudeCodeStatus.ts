/** Claude Code setup status helpers with no `vscode` dependency (shared by the panel, Doctor, tests and riafd). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Is <root>/.mcp.json set up for RIAF, and does it still point somewhere valid? (pure: used by the panel, Doctor and tests) */
export function mcpJsonStatus(root: string, extensionPath: string): { present: boolean; stale?: string; entry?: string } {
	try {
		const riafSrv = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers?.riaf as { args?: string[] } | undefined;
		if (!riafSrv) { return { present: false }; }
		const entry = riafSrv.args?.[0];
		if (!entry) { return { present: true, stale: 'has no server path' }; }
		if (!existsSync(entry)) { return { present: true, entry, stale: `server path no longer exists (${entry})` }; }
		if (/riaf-vscode-\d/.test(entry)) {
			return { present: true, entry, stale: entry.startsWith(extensionPath) ? 'points at a versioned extension folder; re-run setup to use the version-independent launcher' : `points at an older extension version (${entry})` };
		}
		return { present: true, entry };
	} catch { return { present: false }; }
}


/** Register the `riaf` MCP server in <root>/.mcp.json (merging whatever is there) and drop the version-independent launcher next to the index. */
export function writeMcpJson(root: string, extensionPath: string, dbPath: string): string | null {
	const launcherSrc = join(extensionPath, 'plugin', 'riaf-mcp.mjs');
	if (!existsSync(launcherSrc)) { return null; }
	const launcher = join(root, '.riaf', 'riaf-mcp.mjs');
	mkdirSync(join(root, '.riaf'), { recursive: true });
	writeFileSync(launcher, readFileSync(launcherSrc, 'utf8'));
	const mcpPath = join(root, '.mcp.json');
	let mcp: { mcpServers?: Record<string, unknown> } = {};
	if (existsSync(mcpPath)) { try { mcp = JSON.parse(readFileSync(mcpPath, 'utf8')); } catch { /* overwrite malformed */ } }
	mcp.mcpServers = { ...(mcp.mcpServers ?? {}), riaf: { command: 'node', args: [launcher, '--workspace', root, '--db', dbPath], env: {} } };
	writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
	return mcpPath;
}

/** Does Claude Code's project settings approve the riaf MCP server (and allow its tools without a prompt per call)? */
export function mcpApproval(root: string): { enabled: boolean; allowed: boolean } {
	let enabled = false, allowed = false;
	for (const f of ['settings.json', 'settings.local.json']) {
		try {
			const j = JSON.parse(readFileSync(join(root, '.claude', f), 'utf8')) as { enableAllProjectMcpServers?: boolean; enabledMcpjsonServers?: string[]; permissions?: { allow?: string[] } };
			if (j.enableAllProjectMcpServers || j.enabledMcpjsonServers?.includes('riaf')) { enabled = true; }
			if (j.permissions?.allow?.some(a => a === 'mcp__riaf' || a.startsWith('mcp__riaf__'))) { allowed = true; }
		} catch { /* missing or malformed */ }
	}
	return { enabled, allowed };
}

/**
 * Approve the riaf server for this user in <root>/.claude/settings.local.json (the per-user file Claude Code does not commit), so Claude Code
 * does not silently skip an unapproved project server, and let its read-only index tools run without a permission prompt each time.
 */
export function approveRiafMcp(root: string): string {
	const file = join(root, '.claude', 'settings.local.json');
	let j: { enabledMcpjsonServers?: string[]; permissions?: { allow?: string[] } } = {};
	if (existsSync(file)) { try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { j = {}; } }
	j.enabledMcpjsonServers = [...new Set([...(j.enabledMcpjsonServers ?? []), 'riaf'])];
	j.permissions = { ...(j.permissions ?? {}), allow: [...new Set([...(j.permissions?.allow ?? []), 'mcp__riaf'])] };
	mkdirSync(join(root, '.claude'), { recursive: true });
	writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
	return file;
}
