/**
 * Runs riafd inside the extension host (same process as the index → no second SQLite writer) and
 * owns the "RIAF: Open Console" command. Credentials go through SecretStorage, settings through
 * `riaf.integrations.*`, so the console and the settings panel edit the same values.
 */
import * as vscode from 'vscode';
import { join } from 'node:path';
import { readSettings } from './config.js';
import { RiafDaemon, type DaemonInfo } from './daemon/server.js';
import type { IndexManager } from './indexManager.js';
import { hostFor } from './instructionFlow.js';
import { ADAPTER_IDS, type IntegrationsConfig } from './integrations/index.js';
import { readIntegrationsConfig, syncIntegrationsConfigFiles } from './integrations/host.js';
import { outboundFetch } from './proxiedFetch.js';
import { setupClaudeCode } from './claudeCodeSetup.js';
import type { ProxyBridgeManager } from './proxyBridgeManager.js';

export class DaemonManager {
	private daemon: RiafDaemon | null = null;
	private info: DaemonInfo | null = null;
	private root: string | null = null;

	constructor(private readonly ctx: vscode.ExtensionContext, private readonly indexes: IndexManager, private readonly bridge?: ProxyBridgeManager) { }

	get url(): string | null { return this.info?.url ?? null; }

	async ensure(folder: vscode.WorkspaceFolder): Promise<DaemonInfo> {
		if (this.daemon && this.root === folder.uri.fsPath && this.info) { return this.info; }
		await this.stop();
		const host = await hostFor(this.indexes, folder);
		const s = readSettings();
		const c = () => vscode.workspace.getConfiguration('riaf');
		this.daemon = new RiafDaemon({
			root: folder.uri.fsPath, host, version: String(this.ctx.extension.packageJSON.version ?? ''), surface: 'vscode',
			consoleDir: join(this.ctx.extensionPath, 'dist', 'console'), extensionPath: this.ctx.extensionPath,
			integrations: {
				config: () => readIntegrationsConfig(),
				saveConfig: async (cfg: IntegrationsConfig) => { for (const id of ADAPTER_IDS) { if (cfg[id]) { await c().update(`integrations.${id}`, cfg[id], vscode.ConfigurationTarget.Global); } } syncIntegrationsConfigFiles(); },
				getSecret: async k => this.ctx.secrets.get(k),
				setSecret: async (k, v) => { if (v === undefined) { await this.ctx.secrets.delete(k); } else { await this.ctx.secrets.store(k, v); } },
				fetch: async (u, i) => (await outboundFetch())(u, i),
			},
			setupClaudeCode: async () => { await setupClaudeCode(this.ctx, this.indexes, this.bridge); return ['.mcp.json', '.claude/', 'CLAUDE.md']; },
			reindex: force => this.indexes.reindex(folder, force),
			extraStatus: async () => ({ vscode: { gateway: s.gateway.url || null, model: s.gateway.model || s.models.main || 'copilot', embeddings: s.embeddings.enabled, classifyModel: s.models.classify || null, instruction: s.instruction } }),
			log: m => this.indexes.log(`[riafd] ${m}`),
		});
		this.root = folder.uri.fsPath;
		this.info = await this.daemon.start(c().get<number>('console.port', 7421));
		return this.info;
	}

	async stop(): Promise<void> { await this.daemon?.stop(); this.daemon = null; this.info = null; this.root = null; }

	register(): void {
		this.ctx.subscriptions.push(
			vscode.commands.registerCommand('riaf.openConsole', async () => {
				const folder = this.indexes.folderFor(vscode.window.activeTextEditor?.document.uri);
				if (!folder) { return vscode.window.showWarningMessage('RIAF: open a workspace folder first.'); }
				const info = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'RIAF: starting the console…' }, () => this.ensure(folder));
				await vscode.env.openExternal(vscode.Uri.parse(info.url));
			}),
			vscode.commands.registerCommand('riaf.consoleUrl', async () => this.info?.url ?? null),
			{ dispose: () => { void this.stop(); } },
		);
		if (vscode.workspace.getConfiguration('riaf').get<boolean>('console.autoStart', false)) {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (folder) { void this.ensure(folder).catch(e => this.indexes.log(`console auto-start failed: ${String(e)}`)); }
		}
	}
}
