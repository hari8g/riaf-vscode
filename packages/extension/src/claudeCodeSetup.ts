import * as vscode from 'vscode';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IndexManager } from './indexManager.js';

/**
 * "RIAF: Set up Claude Code" — makes the same index available to Claude Code users:
 *   1. writes/merges `<workspace>/.mcp.json` with a `riaf` stdio server (dist/mcp.mjs + this folder's DB)
 *   2. copies plugin/ (CLAUDE.md rules, /riaf-plan, /riaf-verify commands) into `<workspace>/.claude/`
 * Everything is local files; nothing is fetched, so it works behind the corporate proxy.
 */
export async function setupClaudeCode(ctx: vscode.ExtensionContext, indexes: IndexManager): Promise<void> {
	const folder = indexes.folderFor(vscode.window.activeTextEditor?.document.uri);
	if (!folder) { vscode.window.showErrorMessage('RIAF: open a workspace folder first.'); return; }
	const root = folder.uri.fsPath;
	const mcpEntry = join(ctx.extensionPath, 'dist', 'mcp.mjs');
	if (!existsSync(mcpEntry)) { vscode.window.showErrorMessage(`RIAF: MCP server bundle missing at ${mcpEntry}`); return; }

	// 1. .mcp.json (project-scoped; Claude Code reads it automatically)
	const mcpPath = join(root, '.mcp.json');
	let mcp: { mcpServers?: Record<string, unknown> } = {};
	if (existsSync(mcpPath)) { try { mcp = JSON.parse(readFileSync(mcpPath, 'utf8')); } catch { /* overwrite malformed */ } }
	mcp.mcpServers = {
		...(mcp.mcpServers ?? {}),
		riaf: {
			command: 'node',
			args: [mcpEntry, '--workspace', root, '--db', indexes.dbPathFor(folder)],
			env: {},
		},
	};
	writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');

	// 2. plugin files → .claude/
	const src = join(ctx.extensionPath, 'plugin');
	const dst = join(root, '.claude');
	mkdirSync(join(dst, 'commands'), { recursive: true });
	cpSync(join(src, 'commands'), join(dst, 'commands'), { recursive: true });
	const rulesSrc = readFileSync(join(src, 'CLAUDE.md'), 'utf8');
	const claudeMd = join(root, 'CLAUDE.md');
	const marker = '<!-- riaf:rules -->';
	if (existsSync(claudeMd)) {
		const cur = readFileSync(claudeMd, 'utf8');
		if (!cur.includes(marker)) { writeFileSync(claudeMd, `${cur.trimEnd()}\n\n${marker}\n${rulesSrc}`); }
	} else {
		writeFileSync(claudeMd, `${marker}\n${rulesSrc}`);
	}

	const open = await vscode.window.showInformationMessage(
		`RIAF: Claude Code is set up for ${folder.name}. Restart Claude Code in this folder; it will see the "riaf" MCP tools and /riaf-plan, /riaf-verify commands.`,
		'Open .mcp.json');
	if (open) { await vscode.window.showTextDocument(vscode.Uri.file(mcpPath)); }
}
