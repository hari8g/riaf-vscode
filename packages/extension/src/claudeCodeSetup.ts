import * as vscode from 'vscode';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IndexManager } from './indexManager.js';
import { readSettings } from './config.js';
import { buildClaudeEnv, detectCaCert, detectProxy, nodeNeedsExplicitCa, redactProxyUrl, splitProxyCredentials, withProxyCredentials, writeClaudeUserSettings } from './claudeCodeNetwork.js';

export const PROXY_SECRET_USER = 'riaf.claudeCode.proxyUsername';
export const PROXY_SECRET_PASS = 'riaf.claudeCode.proxyPassword';

/** Proxy URL for Claude Code with credentials: from the URL itself if it has them, else from SecretStorage. */
export async function resolveProxyWithCredentials(ctx: vscode.ExtensionContext, detectedUrl: string): Promise<{ url: string; credentialSource: 'url' | 'secrets' | 'none' }> {
	const parts = splitProxyCredentials(detectedUrl);
	if (parts.username) { return { url: withProxyCredentials(parts.url, parts.username, parts.password), credentialSource: 'url' }; }
	const user = await ctx.secrets.get(PROXY_SECRET_USER);
	const pass = await ctx.secrets.get(PROXY_SECRET_PASS);
	if (user) { return { url: withProxyCredentials(parts.url, user, pass ?? ''), credentialSource: 'secrets' }; }
	return { url: parts.url, credentialSource: 'none' };
}

/** "RIAF: Set Claude Code proxy credentials" — masked prompt, stored in the OS keychain via SecretStorage. */
export async function setProxyCredentials(ctx: vscode.ExtensionContext): Promise<boolean> {
	const current = await ctx.secrets.get(PROXY_SECRET_USER);
	const username = await vscode.window.showInputBox({ title: 'Proxy username (1/2)', prompt: 'User name for the corporate proxy (Bosch NT user, without domain unless the proxy needs it)', value: current ?? '', ignoreFocusOut: true });
	if (username === undefined) { return false; }
	if (!username.trim()) {
		await ctx.secrets.delete(PROXY_SECRET_USER); await ctx.secrets.delete(PROXY_SECRET_PASS);
		vscode.window.showInformationMessage('RIAF: proxy credentials cleared.');
		return true;
	}
	const password = await vscode.window.showInputBox({ title: 'Proxy password (2/2)', prompt: 'Stored in the OS credential store, never in settings.json. Special characters are encoded automatically.', password: true, ignoreFocusOut: true });
	if (password === undefined) { return false; }
	await ctx.secrets.store(PROXY_SECRET_USER, username.trim());
	await ctx.secrets.store(PROXY_SECRET_PASS, password);
	vscode.window.showInformationMessage('RIAF: proxy credentials saved. Run "RIAF: Set up Claude Code" to write them for Claude Code.');
	return true;
}

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
				const { url: proxyUrl, credentialSource } = await resolveProxyWithCredentials(ctx, proxy.value);
				const env = buildClaudeEnv({ proxy: proxyUrl, noProxy: s.claudeCode.noProxy, caCertPath: ca?.value });
				const r = writeClaudeUserSettings(env);
				userSettingsPath = r.path;
				networkNote = r.changedKeys.length
					? ` Proxy ${redactProxyUrl(proxyUrl)} (from ${proxy.source}${credentialSource === 'secrets' ? ' + stored credentials' : ''})${ca ? ` and CA ${ca.value}` : ''} written to ${r.path}.`
					: ` Proxy configuration in ${r.path} already up to date.`;
				if (credentialSource === 'none') { networkNote += ' No proxy credentials: if the proxy needs a user name and password, run "RIAF: Set Claude Code proxy credentials" and re-run setup.'; }
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
