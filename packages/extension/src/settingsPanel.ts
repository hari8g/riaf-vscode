import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupClaudeCode } from './claudeCodeSetup.js';
import { readSettings } from './config.js';
import type { IndexManager } from './indexManager.js';
import { createTransport, type ModelTransport } from './modelTransport.js';
import { RULES_FILENAME, readRules, writeRules } from './rules.js';
import type { UsageMeter } from './usage.js';

/**
 * Settings panel host: a WebviewPanel running the React UI from webview/, talking over a tiny
 * request/response protocol. Replaces Trove's 14 DI services with one function, `handle`.
 */

export type HostRequest = { type: string; key?: string; value?: unknown; force?: boolean; text?: string };
export type HostResponse = Record<string, unknown>;

/** All `riaf.*` settings that the UI edits — resolved from VS Code configuration. */
export const SETTING_KEYS = [
	'index.autoIndexOnStartup', 'index.watch', 'index.respectGitignore', 'index.treeSitter', 'index.excludeGlobs',
	'embeddings.enabled', 'embeddings.model',
	'gateway.url', 'gateway.model', 'gateway.auth', 'gateway.ssoScopes', 'gateway.headers', 'gateway.promptCache', 'gateway.stream',
	'agent.maxIterations', 'agent.maxReadOnlyCalls', 'agent.generatePlan', 'agent.autoVerify', 'agent.requireEditApproval', 'agent.allowRunCommand', 'agent.contextWindowRatio',
	'agent.diagnosticsAfterEdit', 'agent.autoApproveDetectedTestCommand', 'agent.preApprovedCommands', 'agent.denyCommandPatterns',
	'agent.sandbox', 'agent.hooks', 'agent.summarizeHistory', 'agent.exploreSubagent', 'agent.checkpoints',
] as const;

export interface PanelDeps {
	ctx: vscode.ExtensionContext;
	indexes: IndexManager;
	usage: UsageMeter;
	transport: () => ModelTransport | undefined;
}

export function snapshotSettings(): Record<string, unknown> {
	const c = vscode.workspace.getConfiguration('riaf');
	return Object.fromEntries(SETTING_KEYS.map(k => [k, c.get(k)]));
}

async function statusBlock(d: PanelDeps): Promise<HostResponse> {
	const folder = d.indexes.folderFor(vscode.window.activeTextEditor?.document.uri);
	const out: HostResponse = { settings: snapshotSettings(), usage: { session: d.usage.session, allTime: d.usage.allTime }, transportId: d.transport()?.id };
	if (folder) {
		try {
			const idx = await d.indexes.get(folder);
			out.index = { ...idx.getStatus(), dbPath: d.indexes.dbPathFor(folder), folder: folder.name, embeddings: idx.embeddingsEnabled };
		} catch (e) { out.error = `index: ${(e as Error).message}`; }
		out.rules = await readRules(folder);
		out.rulesPath = RULES_FILENAME;
		const root = folder.uri.fsPath;
		let mcpJson = false;
		try { mcpJson = Boolean(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers?.riaf); } catch { /* absent */ }
		out.claudeCode = {
			mcpJson, commands: existsSync(join(root, '.claude', 'commands', 'riaf-plan.md')),
			rules: existsSync(join(root, 'CLAUDE.md')) && readFileSync(join(root, 'CLAUDE.md'), 'utf8').includes('<!-- riaf:rules -->'),
			mcpEntry: join(d.ctx.extensionPath, 'dist', 'mcp.mjs'),
		};
	}
	if (!readSettings().gateway.url) {
		try { out.models = (await vscode.lm.selectChatModels()).map(m => `${m.vendor}/${m.id}`); } catch { out.models = []; }
	}
	return out;
}

/** Pure-ish request handler (exported for tests). */
export async function handle(req: HostRequest, d: PanelDeps): Promise<HostResponse> {
	const folder = d.indexes.folderFor(vscode.window.activeTextEditor?.document.uri);
	switch (req.type) {
		case 'getAll': return statusBlock(d);
		case 'set': {
			if (!req.key || !(SETTING_KEYS as readonly string[]).includes(req.key)) { return { error: `unknown setting ${req.key}` }; }
			await vscode.workspace.getConfiguration('riaf').update(req.key, req.value, vscode.ConfigurationTarget.Global);
			return { settings: snapshotSettings() };
		}
		case 'testConnection': {
			const t0 = Date.now();
			try {
				const t = await createTransport();
				if (!t) { return { connection: { ok: false, message: 'no model available (sign in to Copilot or set a gateway URL + model)' } }; }
				const r = await t.call({ systemMessage: 'Reply with the single word OK.', messages: [{ role: 'user', text: 'ping' }], maxOutputTokens: 5 });
				return { connection: { ok: true, message: `${t.id} → "${r.text.trim().slice(0, 20)}"`, transportId: t.id, latencyMs: Date.now() - t0 }, transportId: t.id };
			} catch (e) { return { connection: { ok: false, message: (e as Error).message.slice(0, 200), latencyMs: Date.now() - t0 } }; }
		}
		case 'reindex': {
			if (!folder) { return { error: 'no workspace folder open' }; }
			await d.indexes.reindex(folder, Boolean(req.force));
			return statusBlock(d);
		}
		case 'getRules': return folder ? { rules: await readRules(folder), rulesPath: RULES_FILENAME } : { rules: '' };
		case 'setRules': {
			if (!folder) { return { error: 'no workspace folder open' }; }
			await writeRules(folder, req.text ?? '');
			return { rules: req.text ?? '' };
		}
		case 'setupClaudeCode': await setupClaudeCode(d.ctx, d.indexes); return statusBlock(d);
		case 'openNativeSettings': await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:bosch-mps.riaf-vscode'); return {};
		case 'openOutput': d.indexes.output.show(true); return {};
		case 'openReport': await vscode.commands.executeCommand('riaf.showReport'); return {};
		case 'openGraph': await vscode.commands.executeCommand('riaf.showContextGraph'); return {};
		case 'resetUsage': d.usage.resetAllTime(); return { usage: { session: d.usage.session, allTime: d.usage.allTime } };
		default: return { error: `unknown request ${req.type}` };
	}
}

let panel: vscode.WebviewPanel | undefined;

export function openSettingsPanel(d: PanelDeps): void {
	if (panel) { panel.reveal(); return; }
	panel = vscode.window.createWebviewPanel('riaf.settings', 'RIAF Settings', vscode.ViewColumn.Active, {
		enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(d.ctx.extensionUri, 'dist')],
	});
	panel.iconPath = vscode.Uri.joinPath(d.ctx.extensionUri, 'media', 'icon.png');
	const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(d.ctx.extensionUri, 'dist', 'webview.js'));
	const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
	panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${panel.webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${panel.webview.cspSource} data:;">
<style>html,body{margin:0;padding:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}code{font-family:var(--vscode-editor-font-family);font-size:.92em}a{color:var(--vscode-textLink-foreground)}</style>
</head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;

	const subs: vscode.Disposable[] = [];
	subs.push(panel.webview.onDidReceiveMessage(async (m: { id: number; req: HostRequest }) => {
		let res: HostResponse;
		try { res = await handle(m.req, d); } catch (e) { res = { error: (e as Error).message }; }
		void panel?.webview.postMessage({ id: m.id, res });
	}));
	// live pushes: usage ticks and settings edited elsewhere
	subs.push(d.usage.onDidChange(() => void panel?.webview.postMessage({ push: { usage: { session: d.usage.session, allTime: d.usage.allTime } } })));
	subs.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('riaf')) { void panel?.webview.postMessage({ push: { settings: snapshotSettings() } }); } }));
	panel.onDidDispose(() => { subs.forEach(s => s.dispose()); panel = undefined; });
}
