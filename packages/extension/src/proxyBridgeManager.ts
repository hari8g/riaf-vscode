import * as vscode from 'vscode';
import { PROXY_SECRET_PASS, PROXY_SECRET_USER } from './claudeCodeSetup.js';
import { detectProxy, redactProxyUrl, splitProxyCredentials } from './claudeCodeNetwork.js';
import { readSettings } from './config.js';
import { parseUpstream, startProxyBridge, type ProxyBridge } from './proxyBridge.js';

/**
 * Runs the local proxy bridge inside the extension host while VS Code is open. Credentials come
 * from SecretStorage (or from the detected proxy URL if it already carries them); the bridge is
 * what Claude Code and the gateway transport are pointed at, so no password is ever written down.
 */
export class ProxyBridgeManager implements vscode.Disposable {
	private _bridge: ProxyBridge | undefined;
	private _starting: Promise<ProxyBridge | undefined> | undefined;
	private _lastError: string | undefined;
	private readonly _out: vscode.OutputChannel;
	private readonly _disposables: vscode.Disposable[] = [];

	constructor(private readonly _ctx: vscode.ExtensionContext) {
		this._out = vscode.window.createOutputChannel('RIAF proxy bridge');
		this._disposables.push(this._out);
		this._disposables.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('riaf.claudeCode') || e.affectsConfiguration('http.proxy')) { void this.restart(); } }));
		this._disposables.push(_ctx.secrets.onDidChange(e => { if (e.key === PROXY_SECRET_USER || e.key === PROXY_SECRET_PASS) { void this.restart(); } }));
	}

	get bridge(): ProxyBridge | undefined { return this._bridge; }
	get url(): string | undefined { return this._bridge?.url; }
	get lastError(): string | undefined { return this._lastError; }
	get enabled(): boolean { return readSettings().claudeCode.proxyBridge; }
	get output(): vscode.OutputChannel { return this._out; }

	/** The corporate proxy the bridge would forward to (redacted for display). */
	upstreamDescription(): string {
		const s = readSettings();
		const d = detectProxy({ settingProxy: s.claudeCode.proxyUrl, vscodeProxy: vscode.workspace.getConfiguration('http').get<string>('proxy') });
		return d ? `${redactProxyUrl(d.value)} [${d.source}]` : 'none detected';
	}

	/** Start if enabled and an upstream proxy is known. Resolves with the bridge or undefined (reason in lastError). */
	async ensureStarted(): Promise<ProxyBridge | undefined> {
		if (this._bridge) { return this._bridge; }
		if (this._starting) { return this._starting; }
		this._starting = this._start().finally(() => { this._starting = undefined; });
		return this._starting;
	}

	private async _start(): Promise<ProxyBridge | undefined> {
		const s = readSettings();
		this._lastError = undefined;
		if (!s.claudeCode.proxyBridge) { this._lastError = 'disabled (riaf.claudeCode.proxyBridge)'; return undefined; }
		const d = detectProxy({ settingProxy: s.claudeCode.proxyUrl, vscodeProxy: vscode.workspace.getConfiguration('http').get<string>('proxy') });
		if (!d) { this._lastError = 'no upstream proxy detected (set riaf.claudeCode.proxyUrl)'; return undefined; }
		const parts = splitProxyCredentials(d.value);
		const up = parseUpstream(parts.url);
		up.username = parts.username ?? (await this._ctx.secrets.get(PROXY_SECRET_USER)) ?? undefined;
		up.password = parts.password ?? (await this._ctx.secrets.get(PROXY_SECRET_PASS)) ?? undefined;
		try {
			this._bridge = await startProxyBridge({
				listenPort: s.claudeCode.proxyBridgePort, upstream: up, noProxy: s.claudeCode.noProxy,
				log: m => this._out.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${m}`),
			});
			return this._bridge;
		} catch (e) {
			this._lastError = (e as Error).message;
			this._out.appendLine(`failed to start: ${this._lastError}`);
			return undefined;
		}
	}

	async stop(): Promise<void> {
		const b = this._bridge; this._bridge = undefined;
		if (b) { await b.close(); this._out.appendLine('stopped'); }
	}

	async restart(): Promise<ProxyBridge | undefined> { await this.stop(); return this.ensureStarted(); }

	status(): { enabled: boolean; running: boolean; url?: string; upstream: string; stats?: ProxyBridge['stats']; error?: string } {
		return { enabled: this.enabled, running: !!this._bridge, url: this._bridge?.url, upstream: this.upstreamDescription(), stats: this._bridge?.stats, error: this._lastError };
	}

	dispose(): void { void this.stop(); this._disposables.forEach(d => d.dispose()); }
}
