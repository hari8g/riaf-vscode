/**
 * Integration registry entry point — host-neutral (no `vscode`), shared by the extension host,
 * the MCP server and tests. Registers the built-in adapters and exposes the tool catalogue plus
 * one `executeIntegrationTool` that the three fronts (agent, Copilot LM tools, MCP) call.
 */
import { adapterForTool, allAdapters, registerAdapter, type AdapterEnv, type AdapterId, type IntegrationAdapter, type IntegrationToolSpec, IntegrationError } from './adapter.js';
import { jiraAdapter } from './jira.js';
import { confluenceAdapter } from './confluence.js';
import { gitlabAdapter } from './gitlab.js';
import { knowledgeAdapter } from './knowledge.js';

for (const a of [jiraAdapter, confluenceAdapter, gitlabAdapter, knowledgeAdapter]) { registerAdapter(a); }

export { adapterForTool, allAdapters, getAdapter, integrationToolSpec, secretKey, IntegrationError } from './adapter.js';
export type { AdapterEnv, AdapterId, CredentialField, Health, IntegrationAdapter, IntegrationToolSpec, ToolKind } from './adapter.js';

export const ADAPTER_IDS: AdapterId[] = ['jira', 'confluence', 'gitlab', 'knowledge'];

/** Per-adapter settings object `riaf.integrations.<id>` as the host stores it: `enabled` + the adapter's own keys. */
export type IntegrationSettings = Record<string, unknown> & { enabled?: boolean };
export type IntegrationsConfig = Partial<Record<AdapterId, IntegrationSettings>>;

export const isEnabled = (cfg: IntegrationsConfig, id: AdapterId): boolean => cfg[id]?.enabled === true;

/** Every integration tool, enabled or not. */
export const INTEGRATION_TOOL_SPECS: IntegrationToolSpec[] = allAdapters().flatMap(a => a.tools);
export const INTEGRATION_TOOL_NAMES: ReadonlySet<string> = new Set(INTEGRATION_TOOL_SPECS.map(t => t.name));
export const isIntegrationTool = (name: string): boolean => INTEGRATION_TOOL_NAMES.has(name);
export const isIntegrationReadTool = (name: string): boolean => INTEGRATION_TOOL_SPECS.some(t => t.name === name && t.kind === 'read');

/** Tools of the adapters the developer switched on; `readOnly` drops the write tools. */
export function enabledIntegrationTools(cfg: IntegrationsConfig, opts: { readOnly?: boolean } = {}): IntegrationToolSpec[] {
	return allAdapters().filter(a => isEnabled(cfg, a.id)).flatMap(a => a.tools).filter(t => !opts.readOnly || t.kind === 'read');
}

/** Settings the adapter sees: its schema defaults overlaid with what the developer set. */
export function adapterSettings(cfg: IntegrationsConfig, adapter: IntegrationAdapter): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(adapter.settingsSchema)) { if (v.default !== undefined) { out[k] = v.default; } }
	for (const [k, v] of Object.entries(cfg[adapter.id] ?? {})) { if (k !== 'enabled' && v !== undefined && v !== '') { out[k] = v; } }
	return out;
}

/** Names of credential fields that are not stored yet — the Integrations tab and Doctor show these. */
export async function missingCredentials(adapter: IntegrationAdapter, getSecret: AdapterEnv['getSecret']): Promise<string[]> {
	const out: string[] = [];
	for (const c of adapter.credentials) { if (!(await getSecret(`riaf.integration.${adapter.id}.${c.key}`))) { out.push(c.key); } }
	return out;
}

export type IntegrationCall = { ok: true; result: string; adapter: AdapterId; kind: 'read' | 'write'; ms: number } | { ok: false; error: string; adapter?: AdapterId; kind?: 'read' | 'write'; ms: number };

/**
 * Run one integration tool. `envFor` builds the adapter environment lazily (fetch through the proxy,
 * secrets, settings). Disabled adapters refuse with a message that names the setting.
 */
export async function executeIntegrationTool(name: string, args: Record<string, unknown>, cfg: IntegrationsConfig, envFor: (adapter: IntegrationAdapter) => Promise<AdapterEnv> | AdapterEnv): Promise<IntegrationCall> {
	const t0 = Date.now();
	const adapter = adapterForTool(name);
	if (!adapter) { return { ok: false, error: `unknown integration tool ${name}`, ms: 0 }; }
	const spec = adapter.tools.find(t => t.name === name)!;
	if (!isEnabled(cfg, adapter.id)) { return { ok: false, error: `${adapter.displayName} integration is off — enable it under RIAF Settings → Integrations (riaf.integrations.${adapter.id}.enabled)`, adapter: adapter.id, kind: spec.kind, ms: 0 }; }
	try {
		const env = await envFor(adapter);
		const result = await adapter.execute(name, args, env);
		return { ok: true, result, adapter: adapter.id, kind: spec.kind, ms: Date.now() - t0 };
	} catch (e) {
		const msg = e instanceof IntegrationError ? e.message : (e as Error).message ?? String(e);
		return { ok: false, error: `${adapter.displayName}: ${redactSecrets(msg)}`, adapter: adapter.id, kind: spec.kind, ms: Date.now() - t0 };
	}
}

/** Scrub anything that looks like a credential before a message reaches the model, a log or a dialog. */
export function redactSecrets(s: string): string {
	return s
		.replace(/(authorization\s*[:=]\s*)(basic|bearer)\s+\S+/gi, '$1$2 ***')
		.replace(/(private-token|api-key|x-api-key|token|password|secret)(["']?\s*[:=]\s*["']?)([^\s"',;&]{4,})/gi, '$1$2***')
		.replace(/\/\/([^/\s:@]+):([^/\s@]+)@/g, '//$1:***@');
}

/** Short, redacted argument preview for approval dialogs and the audit log. */
export function previewArgs(args: Record<string, unknown>, max = 400): string {
	const safe: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args)) {
		if (/token|password|secret|apikey|api_key/i.test(k)) { safe[k] = '***'; continue; }
		safe[k] = typeof v === 'string' && v.length > 160 ? `${v.slice(0, 160)}…(${v.length} chars)` : v;
	}
	const s = JSON.stringify(safe);
	return s.length > max ? `${s.slice(0, max)}…` : s;
}
