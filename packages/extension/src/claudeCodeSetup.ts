import * as vscode from 'vscode';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IndexManager } from './indexManager.js';
import { readSettings } from './config.js';
import { buildClaudeEnv, detectCaCert, detectProxy, nodeNeedsExplicitCa, writeClaudeUserSettings } from './claudeCodeNetwork.js';

/**
 * "RIAF: Set up Claude Code" — makes the same index available to Claude Code users:
 *   1. writes/merges `<workspace>/.mcp.json` with a `riaf` stdio server (dist/mcp.mjs + this folder's DB)
 *   2. copies plugin/ (CLAUDE.md rules, /riaf-plan, /riaf-verify commands) into `<workspace>/.claude/`
 *   3. writes the corporate proxy / CA configuration into ~/.claude/settings.json (env block), so
 *      Claude Code itself can reach Anthropic through the proxy ("Route A"); see claudeCodeNetwork.ts
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

	// 3. network: proxy + CA for Claude Code itself (user-level ~/.claude/settings.json)
	const s = readSettings();
	let networkNote = '';
	let userSettingsPath: string | undefined;
	if (s.claudeCode.writeUserSettings) {
		const proxy = detectProxy({ settingProxy: s.claudeCode.proxyUrl, vscodeProxy: vscode.workspace.getConfiguration('http').get<string>('proxy') });
		const ca = detectCaCert({ settingCaPath: s.claudeCode.caCertPath });
		if (proxy) {
			try {
				const env = buildClaudeEnv({ proxy: proxy.value, noProxy: s.claudeCode.noProxy, caCertPath: ca?.value });
				const r = writeClaudeUserSettings(env);
				userSettingsPath = r.path;
				networkNote = r.changedKeys.length
					? ` Proxy ${proxy.value} (from ${proxy.source})${ca ? ` and CA ${ca.value}` : ''} written to ${r.path}.`
					: ` Proxy configuration in ${r.path} already up to date.`;
				if (!ca && nodeNeedsExplicitCa()) {
					networkNote += ' No CA bundle found: if the proxy inspects TLS, set riaf.claudeCode.caCertPath to the corporate root CA (.pem) and re-run — Node < 22.15 cannot read the Windows certificate store.';
				}
			} catch (e) { networkNote = ` Could not update ~/.claude/settings.json: ${(e as Error).message}`; }
		} else {
			networkNote = ' No proxy detected (VS Code http.proxy, HTTPS_PROXY, npm config) — if Claude Code reports ECONNREFUSED, set riaf.claudeCode.proxyUrl and re-run.';
		}
	}

	const actions = ['Open .mcp.json', ...(userSettingsPath ? ['Open ~/.claude/settings.json'] : [])];
	const open = await vscode.window.showInformationMessage(
		`RIAF: Claude Code is set up for ${folder.name}. Restart Claude Code in this folder; it will see the "riaf" MCP tools and /riaf-plan, /riaf-verify commands.${networkNote}`,
		...actions);
	if (open === 'Open .mcp.json') { await vscode.window.showTextDocument(vscode.Uri.file(mcpPath)); }
	else if (open && userSettingsPath) { await vscode.window.showTextDocument(vscode.Uri.file(userSettingsPath)); }
}
