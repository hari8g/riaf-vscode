import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROXY_SECRET_USER, mcpJsonStatus, setProxyCredentials, setupClaudeCode } from './claudeCodeSetup.js';
import { claudeUserSettingsPath, detectCaCert, detectProxy, nodeNeedsExplicitCa, readClaudeUserSettingsEnv, redactProxyUrl, splitProxyCredentials } from './claudeCodeNetwork.js';
import { findRuleFiles } from './projectRules.js';
import { probeOllama } from './providerHttp.js';
import { loadMcpServers } from './mcpConfig.js';
import { discoverMcpTools } from './mcpClient.js';
import { readSettings } from './config.js';
import { readClaudeUsageCached, type ClaudeUsageTotals } from './claudeUsage.js';
import { readToolStats, resetToolStats, summarizeToolStats, toolStatsPathFor, type ToolStatsSummary } from './toolStats.js';
import type { IndexManager } from './indexManager.js';
import { createTransport, type ModelTransport } from './modelTransport.js';
import { RULES_FILENAME, readRules, writeRules } from './rules.js';
import type { UsageMeter, UsageTotals } from './usage.js';

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
	'agent.maxConsecutiveToolFails', 'agent.llmStreamStallTimeoutMs', 'agent.exploreMaxSteps', 'agent.diagnosticsSettleMs',
	'agent.enableLightAgent', 'agent.enableParallelReadBatching', 'agent.sessionBudgetUsd', 'agent.sandboxVerificationNudge',
	'usage.readClaudeCodeTranscripts',
	'claudeCode.writeUserSettings', 'claudeCode.proxyUrl', 'claudeCode.noProxy', 'claudeCode.caCertPath', 'claudeCode.proxyBridge', 'claudeCode.proxyBridgePort',
	'models.main', 'models.plan', 'models.summary', 'models.explore', 'models.critic', 'models.commit', 'models.autocomplete',
	'general.aiInstructions', 'general.disableSystemPrompt', 'general.metricsOptOut',
	'webSearch.enabled', 'webSearch.provider', 'security.extraRules', 'mcp.disabledServers',
	'providers', 'agent.approveTerminal', 'agent.approveMcp',
] as const;

import type { ProxyBridgeManager } from './proxyBridgeManager.js';

export interface PanelDeps {
	ctx: vscode.ExtensionContext;
	bridge?: ProxyBridgeManager;
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
	const out: HostResponse = { settings: snapshotSettings(), usage: usageBlock(d), transportId: d.transport()?.id };
	if (folder) {
		try {
			const idx = await d.indexes.get(folder);
			out.index = { ...idx.getStatus(), dbPath: d.indexes.dbPathFor(folder), folder: folder.name, embeddings: idx.embeddingsEnabled };
		} catch (e) { out.error = `index: ${(e as Error).message}`; }
		out.rules = await readRules(folder);
		out.rulesPath = RULES_FILENAME;
		const root = folder.uri.fsPath;
		const mcpSt = mcpJsonStatus(root, d.ctx.extensionPath);
		const mcpJson = mcpSt.present; const mcpStale = mcpSt.stale;
		out.claudeCode = {
			mcpJson, mcpStale, commands: existsSync(join(root, '.claude', 'commands', 'riaf-plan.md')),
			rules: existsSync(join(root, 'CLAUDE.md')) && readFileSync(join(root, 'CLAUDE.md'), 'utf8').includes('<!-- riaf:rules -->'),
			mcpEntry: join(d.ctx.extensionPath, 'dist', 'mcp.mjs'),
			network: await claudeCodeNetworkStatus(d.ctx),
			bridge: d.bridge?.status(),
		};
	}
	out.mcp = mcpBlock(folder?.uri.fsPath ?? '');
	if (folder) {
		const sources = findRuleFiles(folder.uri.fsPath);
		if (existsSync(join(folder.uri.fsPath, '.riafrules'))) { sources.unshift('.riafrules'); }
		out.ruleSources = sources;
	}
	if (!readSettings().gateway.url) {
		try { out.models = (await vscode.lm.selectChatModels()).map(m => `${m.vendor}/${m.id}`); } catch { out.models = []; }
	}
	return out;
}

/** What Claude Code will use for the network, from ~/.claude/settings.json, plus what we would detect now. */
export async function claudeCodeNetworkStatus(ctx: vscode.ExtensionContext) {
	const s = readSettings();
	const written = readClaudeUserSettingsEnv();
	let proxy: ReturnType<typeof detectProxy>; let proxyError: string | undefined;
	try { proxy = detectProxy({ settingProxy: s.claudeCode.proxyUrl, vscodeProxy: vscode.workspace.getConfiguration('http').get<string>('proxy') }); }
	catch (e) { proxyError = (e as Error).message; }
	const ca = detectCaCert({ settingCaPath: s.claudeCode.caCertPath });
	const writtenRaw = written.HTTPS_PROXY ?? written.https_proxy ?? written.HTTP_PROXY ?? '';
	const storedUser = await ctx.secrets.get(PROXY_SECRET_USER);
	const detectedHasCreds = !!(proxy && splitProxyCredentials(proxy.value).username);
	return {
		settingsPath: claudeUserSettingsPath(),
		proxyError,
		// redacted everywhere: these strings go to the webview, Doctor and logs
		writtenProxy: redactProxyUrl(writtenRaw),
		writtenHasCredentials: !!splitProxyCredentials(writtenRaw).username,
		writtenCa: written.NODE_EXTRA_CA_CERTS ?? '',
		detectedProxy: proxy ? redactProxyUrl(proxy.value) : '', detectedProxySource: proxy?.source ?? '',
		/** True when what Claude Code has matches what we would write now (compared without credentials; a bridge URL counts as matching when the bridge is on). */
		upToDate: !proxy || splitProxyCredentials(writtenRaw).url === splitProxyCredentials(proxy.value).url || (s.claudeCode.proxyBridge && /^http:\/\/127\.0\.0\.1:\d+$/.test(writtenRaw)),
		credentialSource: detectedHasCreds ? 'url' as const : storedUser ? 'secrets' as const : 'none' as const,
		credentialUser: detectedHasCreds ? (splitProxyCredentials(proxy!.value).username ?? '') : (storedUser ?? ''),
		detectedCa: ca?.value ?? '', detectedCaSource: ca?.source ?? '',
		caRequiredHint: nodeNeedsExplicitCa(),
	};
}

function mcpBlock(root: string, probed?: { errors: Map<string, string>; tools: Map<string, string[]> }): { servers: { name: string; transport: string; target: string; enabled: boolean; tools: string[]; error?: string }[] } {
	const disabled = new Set(readSettings().mcp.disabledServers);
	return {
		servers: loadMcpServers(root).map(server => ({
			name: server.name,
			transport: server.transport,
			target: server.url ?? [server.command, ...server.args].filter(Boolean).join(' '),
			enabled: !disabled.has(server.name),
			tools: probed?.tools.get(server.name) ?? [],
			error: probed?.errors.get(server.name),
		})),
	};
}

/** Everything the Usage tab shows: RIAF's own model calls, tools served to Copilot / Claude Code, and Claude Code's real usage for this repo. */
export type UsageBlock = {
	session: UsageTotals; allTime: UsageTotals;
	days: ReturnType<UsageMeter['history']>; byProvider: UsageMeter['byProvider']; cacheEfficiency: number;
	tools?: ToolStatsSummary; claudeCode?: ClaudeUsageTotals; repo?: string;
};
export function usageBlock(d: PanelDeps): UsageBlock {
	const folder = d.indexes.folderFor(vscode.window.activeTextEditor?.document.uri);
	const base: UsageBlock = { session: d.usage.session, allTime: d.usage.allTime, days: d.usage.history(), byProvider: d.usage.byProvider, cacheEfficiency: d.usage.cacheEfficiency() };
	if (!folder) { return base; }
	let tools: ToolStatsSummary | undefined;
	try { tools = summarizeToolStats(readToolStats(toolStatsPathFor(d.indexes.dbPathFor(folder)))); } catch { /* metrics are best-effort */ }
	let claudeCode: ClaudeUsageTotals | undefined;
	try { claudeCode = readSettings().usage.readClaudeCodeTranscripts ? readClaudeUsageCached(folder.uri.fsPath) : undefined; } catch { /* best-effort */ }
	return { ...base, tools, claudeCode, repo: folder.name };
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
		case 'setupClaudeCode': await setupClaudeCode(d.ctx, d.indexes, d.bridge); return statusBlock(d);
		case 'bridgeStart': await d.bridge?.restart(); return statusBlock(d);
		case 'bridgeStop': await d.bridge?.stop(); return statusBlock(d);
		case 'bridgeLog': d.bridge?.output.show(true); return {};
		case 'setProxyCredentials': await setProxyCredentials(d.ctx); return statusBlock(d);
		case 'openNativeSettings': await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:bosch-mps.riaf-vscode'); return {};
		case 'openOutput': d.indexes.output.show(true); return {};
		case 'openReport': await vscode.commands.executeCommand('riaf.showReport'); return {};
		case 'openGraph': await vscode.commands.executeCommand('riaf.showContextGraph'); return {};
		case 'resetUsage': {
			d.usage.resetAllTime();
			const f = d.indexes.folderFor(vscode.window.activeTextEditor?.document.uri);
			if (f) { try { resetToolStats(toolStatsPathFor(d.indexes.dbPathFor(f))); } catch { /* ignore */ } }
			return { usage: usageBlock(d) };
		}
		case 'refreshUsage': return { usage: usageBlock(d) };
		case 'detectProviders': {
			const base = readSettings().providers.ollamaUrl || 'http://127.0.0.1:11434';
			try { return { detected: { ollama: await probeOllama(base, globalThis.fetch) } }; }
			catch { return { detected: { ollama: [] } }; }
		}
		case 'mcpRefresh': {
			const root = folder?.uri.fsPath ?? '';
			const found = await discoverMcpTools(root, readSettings().mcp.disabledServers);
			const tools = new Map<string, string[]>();
			for (const binding of found.bindings) {
				const list = tools.get(binding.server) ?? [];
				list.push(binding.tool);
				tools.set(binding.server, list);
			}
			return { mcp: mcpBlock(root, { errors: found.errors, tools }) };
		}
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
	subs.push(d.usage.onDidChange(() => void panel?.webview.postMessage({ push: { usage: usageBlock(d) } })));
	// tools served and Claude Code transcripts change outside the extension host: poll while the panel is open
	const poll = setInterval(() => { if (panel?.visible) { void panel.webview.postMessage({ push: { usage: usageBlock(d) } }); } }, 10_000);
	subs.push({ dispose: () => clearInterval(poll) });
	subs.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('riaf')) { void panel?.webview.postMessage({ push: { settings: snapshotSettings() } }); } }));
	panel.onDidDispose(() => { subs.forEach(s => s.dispose()); panel = undefined; });
}
