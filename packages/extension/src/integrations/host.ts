/**
 * VS Code side of the integrations: builds the AdapterEnv (proxied fetch, SecretStorage, settings,
 * gateway embeddings), gates write tools behind an approval dialog, audits them, and owns the
 * "Set Integration Credentials" flow. Everything that needs `vscode` lives here.
 */
import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createEmbedder } from '@bosch-mps/riaf-core';
import { readSettings } from '../config.js';
import { getGatewayHeaders } from '../modelTransport.js';
import { outboundFetch } from '../proxiedFetch.js';
import { appendAudit, type AuditConsumer } from './audit.js';
import { ADAPTER_IDS, adapterForTool, adapterSettings, allAdapters, executeIntegrationTool, getAdapter, isEnabled, missingCredentials, previewArgs, secretKey, type AdapterEnv, type AdapterId, type Health, type IntegrationAdapter, type IntegrationCall, type IntegrationsConfig } from './index.js';
import { credentialsFilePath, writeCredentialsFile, writeIntegrationsConfig } from './mcpConfig.js';

let secrets: vscode.SecretStorage | undefined;
let output: vscode.OutputChannel | undefined;
const sessionApproved = new Set<AdapterId>();
/** Honour "stop asking this session" without touching settings. */
export const isSessionApproved = (id: AdapterId): boolean => sessionApproved.has(id);

export function initIntegrationsHost(ctx: vscode.ExtensionContext): void {
	secrets = ctx.secrets;
	output ??= vscode.window.createOutputChannel('RIAF Integrations');
	ctx.subscriptions.push(output);
	// keep .riaf/integrations.json (what the MCP server reads) in step with the settings
	ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('riaf.integrations')) { syncIntegrationsConfigFiles(); } }));
	syncIntegrationsConfigFiles();
}

/** `riaf.integrations.*` as the registry wants it. */
export function readIntegrationsConfig(): IntegrationsConfig {
	const c = vscode.workspace.getConfiguration('riaf');
	const out: IntegrationsConfig = {};
	for (const id of ADAPTER_IDS) { out[id] = c.get<Record<string, unknown>>(`integrations.${id}`, {}) ?? {}; }
	return out;
}

export const approveIntegrationWrites = (): boolean => vscode.workspace.getConfiguration('riaf').get<boolean>('agent.approveIntegrationWrites', true);
export const shareCredentialsWithClaudeCode = (): boolean => vscode.workspace.getConfiguration('riaf').get<boolean>('integrations.shareCredentialsWithClaudeCode', false);

/** Write the non-secret config into every open workspace folder that already has a `.riaf` directory or is set up for Claude Code. */
export function syncIntegrationsConfigFiles(): void {
	const cfg = readIntegrationsConfig();
	const anyEnabled = ADAPTER_IDS.some(id => isEnabled(cfg, id));
	for (const f of vscode.workspace.workspaceFolders ?? []) {
		try {
			const root = f.uri.fsPath;
			if (anyEnabled || existsSync(join(root, '.riaf', 'integrations.json'))) { writeIntegrationsConfig(root, cfg); }
		} catch (e) { output?.appendLine(`[integrations] could not write .riaf/integrations.json: ${(e as Error).message}`); }
	}
}

const getSecret = async (key: string): Promise<string | undefined> => secrets?.get(key);

/** Query embedder from the gateway embeddings endpoint (same config as the index), when configured. */
function queryEmbedder(): AdapterEnv['embed'] | undefined {
	const s = readSettings();
	if (!s.embeddings.enabled || !s.gateway.url) { return undefined; }
	const embedder = createEmbedder({
		enabled: true, url: `${s.gateway.url}/embeddings`, model: s.embeddings.model,
		headers: () => getGatewayHeaders(),
		fetchImpl: async (url: string, init: RequestInit) => (await outboundFetch())(url, init),
	} as Parameters<typeof createEmbedder>[0]);
	if (!embedder) { return undefined; }
	return async (text: string) => {
		const v = await embedder.embedText(text);
		if (!v) { throw new Error('embeddings endpoint returned nothing (riaf.embeddings / gateway)'); }
		return Array.from(v);
	};
}

export async function integrationEnv(adapter: IntegrationAdapter, workspaceRoot?: string): Promise<AdapterEnv> {
	const cfg = readIntegrationsConfig();
	return {
		fetch: await outboundFetch(),
		getSecret,
		settings: adapterSettings(cfg, adapter),
		workspaceRoot,
		embed: adapter.id === 'knowledge' ? queryEmbedder() : undefined,
		log: m => output?.appendLine(`[${adapter.id}] ${m}`),
	};
}

export type RunOptions = { consumer: AuditConsumer; workspaceRoot?: string; /** Skip the dialog (caller already approved, e.g. the panel). */ preApproved?: boolean; readOnly?: boolean };

/**
 * Execute an integration tool for any front. Write tools ask the developer first (modal dialog,
 * `riaf.agent.approveIntegrationWrites`) and are appended to `.riaf/audit.jsonl` either way.
 */
export async function runIntegrationTool(name: string, args: Record<string, unknown>, o: RunOptions): Promise<IntegrationCall> {
	const adapter = adapterForTool(name);
	if (!adapter) { return { ok: false, error: `unknown integration tool ${name}`, ms: 0 }; }
	const spec = adapter.tools.find(t => t.name === name)!;
	if (spec.kind === 'write' && o.readOnly) { return { ok: false, error: `${name} is a write tool and this mode is read-only`, adapter: adapter.id, kind: 'write', ms: 0 }; }
	let approved: 'dialog' | 'setting' | 'none' = 'none';
	if (spec.kind === 'write') {
		if (o.preApproved || sessionApproved.has(adapter.id)) { approved = 'dialog'; }
		else if (!approveIntegrationWrites()) { approved = 'setting'; }
		else {
			const base = String(adapterSettings(readIntegrationsConfig(), adapter).baseUrl ?? '');
			const choice = await vscode.window.showWarningMessage(
				`RIAF wants to ${spec.label} in ${adapter.displayName}${base ? ` (${base})` : ''}`,
				{ modal: true, detail: `Requested by ${o.consumer}.\n\n${previewArgs(args, 600)}\n\nThis changes data in ${adapter.displayName}. It is recorded in .riaf/audit.jsonl.` },
				'Run', 'Run and stop asking this session');
			if (!choice) {
				const out: IntegrationCall = { ok: false, error: `developer rejected ${spec.label}`, adapter: adapter.id, kind: 'write', ms: 0 };
				if (o.workspaceRoot) { appendAudit(o.workspaceRoot, { consumer: o.consumer, adapter: adapter.id, tool: name, kind: 'write', args, ok: false, ms: 0, approved: 'none', error: out.error }); }
				return out;
			}
			if (choice.startsWith('Run and stop')) { sessionApproved.add(adapter.id); }
			approved = 'dialog';
		}
	}
	const r = await executeIntegrationTool(name, args, readIntegrationsConfig(), a => integrationEnv(a, o.workspaceRoot));
	if (spec.kind === 'write' && o.workspaceRoot) {
		appendAudit(o.workspaceRoot, { consumer: o.consumer, adapter: adapter.id, tool: name, kind: 'write', args, ok: r.ok, ms: r.ms, approved, result: r.ok ? r.result : undefined, error: r.ok ? undefined : r.error });
	}
	output?.appendLine(`[${adapter.id}] ${o.consumer} ${name} ${r.ok ? 'ok' : 'FAILED'} ${r.ms} ms${r.ok ? '' : ` — ${r.error}`}`);
	return r;
}

/** Health for the Integrations tab and Doctor: disabled adapters are reported, not probed. */
export async function integrationHealth(id: AdapterId, workspaceRoot?: string): Promise<Health & { enabled: boolean; missingCredentials: string[] }> {
	const adapter = getAdapter(id)!;
	const cfg = readIntegrationsConfig();
	const missing = await missingCredentials(adapter, getSecret);
	if (!isEnabled(cfg, id)) { return { ok: false, enabled: false, missingCredentials: missing, message: 'disabled' }; }
	const t0 = Date.now();
	try {
		const h = await adapter.health(await integrationEnv(adapter, workspaceRoot));
		return { ...h, enabled: true, missingCredentials: missing, latencyMs: h.latencyMs ?? Date.now() - t0 };
	} catch (e) { return { ok: false, enabled: true, missingCredentials: missing, message: (e as Error).message, latencyMs: Date.now() - t0 }; }
}

/** `RIAF: Set Integration Credentials` — SecretStorage only; optionally mirrored to ~/.riaf/credentials.json for the MCP server. */
export async function setIntegrationCredentials(preselect?: AdapterId): Promise<void> {
	if (!secrets) { return; }
	const id = preselect ?? await vscode.window.showQuickPick(allAdapters().map(a => ({ label: a.displayName, description: a.id, id: a.id })), { placeHolder: 'Which integration?' }).then(p => p?.id as AdapterId | undefined);
	if (!id) { return; }
	const adapter = getAdapter(id)!;
	const written: string[] = [];
	for (const field of adapter.credentials) {
		const key = secretKey(id, field.key);
		const existing = await secrets.get(key);
		const value = await vscode.window.showInputBox({
			title: `${adapter.displayName}: ${field.label}`, prompt: `${field.hint ?? ''}${existing ? ' (leave empty to keep the stored value; type "-" to delete it)' : ' (leave empty to skip)'}`,
			password: field.secret, ignoreFocusOut: true,
		});
		if (value === undefined) { return; }
		if (value === '-') { await secrets.delete(key); if (shareCredentialsWithClaudeCode()) { writeCredentialsFile({ [key]: undefined }); } written.push(`${field.key} (deleted)`); continue; }
		if (!value) { continue; }
		await secrets.store(key, value);
		if (shareCredentialsWithClaudeCode()) { writeCredentialsFile({ [key]: value }); }
		written.push(field.key);
	}
	if (written.length) {
		void vscode.window.showInformationMessage(`RIAF stored ${adapter.displayName} ${written.join(', ')} in the OS credential store${shareCredentialsWithClaudeCode() ? ` and ${credentialsFilePath()} for Claude Code` : ''}.`);
	}
}

/** When the developer turns credential sharing on, copy what SecretStorage has; when off, remove the file's integration entries. */
export async function syncSharedCredentials(): Promise<void> {
	if (!secrets) { return; }
	const entries: Record<string, string | undefined> = {};
	for (const a of allAdapters()) {
		for (const c of a.credentials) { const k = secretKey(a.id, c.key); entries[k] = shareCredentialsWithClaudeCode() ? await secrets.get(k) : undefined; }
	}
	writeCredentialsFile(entries);
}
