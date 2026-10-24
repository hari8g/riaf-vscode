import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RiafIndex, type IndexProgress, type RepoIntelligenceIndexingStats } from '@bosch-mps/riaf-core';
import { readSettings, type RiafSettings } from './config.js';
import type { ModelTransport } from './modelTransport.js';
import { getGatewayHeaders } from './modelTransport.js';

/** VS Code ships ripgrep under its app root; use it so `grep` works without anything on PATH. */
function bundledRipgrep(): string | undefined {
	const bin = process.platform === 'win32' ? 'rg.exe' : 'rg';
	const candidates = [
		join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', bin),
		join(vscode.env.appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', bin),
	];
	return candidates.find(p => existsSync(p));
}

/**
 * One RiafIndex per workspace folder, a status-bar item, and the reindex command.
 * Everything that touches the index from the LM tools, the agent or the MCP setup goes
 * through here so there is exactly one DB handle per folder.
 */
export class IndexManager implements vscode.Disposable {
	private readonly _indexes = new Map<string, Promise<RiafIndex>>();
	private readonly _status: vscode.StatusBarItem;
	private readonly _output: vscode.OutputChannel;
	private readonly _disposables: vscode.Disposable[] = [];
	private _indexing = false;

	constructor(
		private readonly _ctx: vscode.ExtensionContext,
		private readonly _transport: () => ModelTransport | undefined,
	) {
		this._output = vscode.window.createOutputChannel('RIAF');
		this._status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
		this._status.command = 'riaf.showReport';
		this._status.text = '$(database) RIAF';
		this._status.tooltip = 'RIAF repository index — click for report';
		this._status.show();
		this._disposables.push(this._status, this._output);

		this._disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(async e => {
			for (const removed of e.removed) {
				const key = removed.uri.fsPath;
				const p = this._indexes.get(key);
				this._indexes.delete(key);
				if (p) { (await p).close().catch(() => { }); }
			}
			if (e.added.length && readSettings().index.autoIndexOnStartup) { void this.reindexAll(); }
		}));
	}

	get output(): vscode.OutputChannel { return this._output; }
	log(msg: string): void { this._output.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }

	/** Resolve the workspace folder for a URI (or the first folder). */
	folderFor(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
		if (uri) { return vscode.workspace.getWorkspaceFolder(uri); }
		return vscode.workspace.workspaceFolders?.[0];
	}

	dbPathFor(folder: vscode.WorkspaceFolder): string {
		const dir = this._ctx.globalStorageUri.fsPath;
		mkdirSync(dir, { recursive: true });
		const hash = createHash('sha1').update(folder.uri.fsPath).digest('hex').slice(0, 16);
		return join(dir, `riaf-${hash}.sqlite`);
	}

	/** Open (or reuse) the index for a folder. */
	async get(folder?: vscode.WorkspaceFolder): Promise<RiafIndex> {
		folder ??= this.folderFor();
		if (!folder) { throw new Error('RIAF: no workspace folder is open.'); }
		const key = folder.uri.fsPath;
		let p = this._indexes.get(key);
		if (!p) {
			p = this._open(folder);
			this._indexes.set(key, p);
			p.catch(() => this._indexes.delete(key));
		}
		return p;
	}

	private async _open(folder: vscode.WorkspaceFolder): Promise<RiafIndex> {
		const s = readSettings();
		const idx = await RiafIndex.open({
			workspaceRoot: folder.uri.fsPath,
			dbPath: this.dbPathFor(folder),
			excludeGlobs: s.index.excludeGlobs,
			respectGitignore: s.index.respectGitignore,
			treeSitter: s.index.treeSitter,
			ripgrepPath: bundledRipgrep(),
			embeddings: this._embeddingConfig(s),
			summarize: this._summarizeHook(),
			log: m => this.log(m),
		});
		this.log(`opened index for ${folder.name} (${idx.getStatus().chunks} chunks)`);
		if (s.index.watch) { idx.startWatching(); }
		this._refreshStatus();
		return idx;
	}

	private _embeddingConfig(s: RiafSettings) {
		if (!s.embeddings.enabled || !s.gateway.url) { return undefined; }
		return {
			enabled: true,
			url: `${s.gateway.url}/embeddings`,
			model: s.embeddings.model,
			// resolved per request so a refreshed SSO token is picked up without reopening the index
			headers: () => getGatewayHeaders(),
		};
	}

	/** Use the active model transport (Copilot or gateway) for file/profile summaries, if any. */
	private _summarizeHook(): ((prompt: string) => Promise<string>) | undefined {
		return async (prompt: string) => {
			const t = this._transport();
			if (!t) { throw new Error('no model transport'); }
			const r = await t.call({ systemMessage: 'You summarise code concisely.', messages: [{ role: 'user', text: prompt }], maxOutputTokens: 400 });
			return r.text;
		};
	}

	async reindexAll(force = false): Promise<void> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		for (const f of folders) { await this.reindex(f, force); }
	}

	async reindex(folder: vscode.WorkspaceFolder, force = false): Promise<RepoIntelligenceIndexingStats | undefined> {
		if (this._indexing) { vscode.window.showInformationMessage('RIAF: indexing already in progress.'); return; }
		this._indexing = true;
		try {
			const idx = await this.get(folder);
			return await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Window, title: `RIAF: indexing ${folder.name}` },
				async progress => {
					let last = '';
					const stats = await idx.reindex({
						force,
						onProgress: (p: IndexProgress) => {
							const msg = `${p.phase} ${p.done}/${p.total}`;
							if (msg !== last) { progress.report({ message: msg }); last = msg; }
							this._status.text = `$(sync~spin) RIAF ${p.phase}`;
						},
					});
					this.log(`indexed ${folder.name}: ${JSON.stringify(stats)}`);
					this._refreshStatus();
					return stats;
				});
		} catch (e) {
			this.log(`reindex failed: ${(e as Error).stack ?? e}`);
			vscode.window.showErrorMessage(`RIAF: indexing failed — ${(e as Error).message}`);
			this._status.text = '$(warning) RIAF error';
			return undefined;
		} finally {
			this._indexing = false;
		}
	}

	private async _refreshStatus(): Promise<void> {
		const folder = this.folderFor();
		if (!folder) { this._status.text = '$(database) RIAF'; return; }
		const p = this._indexes.get(folder.uri.fsPath);
		if (!p) { return; }
		const st = (await p).getStatus();
		this._status.text = st.indexed ? `$(database) RIAF ${st.chunks} chunks` : '$(database) RIAF not indexed';
		this._status.tooltip = st.indexed
			? `RIAF: ${st.files} files, ${st.chunks} chunks, ${st.symbols} symbols${st.lastIndexedAt ? ` — ${new Date(st.lastIndexedAt).toLocaleString()}` : ''}`
			: 'RIAF: run "RIAF: Reindex Workspace"';
	}

	async dispose(): Promise<void> {
		for (const d of this._disposables) { d.dispose(); }
		for (const p of this._indexes.values()) { try { (await p).close(); } catch { /* ignore */ } }
		this._indexes.clear();
	}
}
