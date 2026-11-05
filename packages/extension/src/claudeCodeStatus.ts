/** Claude Code setup status helpers with no `vscode` dependency (shared by the panel, Doctor, tests and riafd). */
import { existsSync, readFileSync } from 'node:fs';
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

