import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
	ADAPTER_IDS, INTEGRATION_TOOL_SPECS, adapterForTool, adapterSettings, allAdapters, enabledIntegrationTools, executeIntegrationTool,
	isIntegrationReadTool, missingCredentials, previewArgs, redactSecrets,
} from '../../src/integrations/index.js';
import { appendAudit, readAudit, auditPathFor } from '../../src/integrations/audit.js';
import { envVarForSecret, mcpSecretGetter, readCredentialsFile, readIntegrationsConfig, sanitizeIntegrationsConfig, writeCredentialsFile, writeIntegrationsConfig } from '../../src/integrations/mcpConfig.js';

const tmp: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'riaf-fw-')); tmp.push(d); return d; };
afterEach(() => { for (const d of tmp.splice(0)) { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } });

describe('integration registry', () => {
	it('registers the four adapters with globally unique tool names and labels', () => {
		expect(allAdapters().map(a => a.id).sort()).toEqual([...ADAPTER_IDS].sort());
		const names = INTEGRATION_TOOL_SPECS.map(t => t.name);
		expect(new Set(names).size).toBe(names.length);
		for (const t of INTEGRATION_TOOL_SPECS) { expect(t.label.length, t.name).toBeGreaterThan(3); expect(['read', 'write']).toContain(t.kind); }
		expect(names.length).toBeGreaterThan(40);
		expect(adapterForTool('jira_search')?.id).toBe('jira');
		expect(adapterForTool('kg_query')?.id).toBe('knowledge');
		expect(isIntegrationReadTool('gitlab_get_mr')).toBe(true);
		expect(isIntegrationReadTool('gitlab_create_mr')).toBe(false);
	});

	it('exposes only enabled adapters, and only read tools in read-only mode', () => {
		expect(enabledIntegrationTools({})).toEqual([]);
		const jiraOnly = enabledIntegrationTools({ jira: { enabled: true } });
		expect(jiraOnly.every(t => t.name.startsWith('jira_'))).toBe(true);
		expect(jiraOnly.some(t => t.kind === 'write')).toBe(true);
		expect(enabledIntegrationTools({ jira: { enabled: true } }, { readOnly: true }).every(t => t.kind === 'read')).toBe(true);
		// knowledge adapter has no write tools at all
		expect(enabledIntegrationTools({ knowledge: { enabled: true } }).every(t => t.kind === 'read')).toBe(true);
	});

	it('merges schema defaults with developer settings and drops the enabled flag', () => {
		const gitlab = allAdapters().find(a => a.id === 'gitlab')!;
		const s = adapterSettings({ gitlab: { enabled: true, baseUrl: 'https://gitlab.example.com', maxResults: '' } }, gitlab);
		expect(s.baseUrl).toBe('https://gitlab.example.com');
		expect(s.maxResults).toBe(20);        // '' falls back to the default
		expect('enabled' in s).toBe(false);
	});

	it('refuses tools of disabled adapters with a message naming the setting', async () => {
		const r = await executeIntegrationTool('jira_search', { jql: 'x' }, {}, () => { throw new Error('env must not be built'); });
		expect(r.ok).toBe(false);
		if (!r.ok) { expect(r.error).toMatch(/riaf\.integrations\.jira\.enabled/); }
	});

	it('runs an enabled tool through the adapter and redacts secrets in errors', async () => {
		const calls: string[] = [];
		const env = {
			fetch: async (url: string) => { calls.push(url); return new Response('{"error":"Authorization: Bearer abcdef123456 was rejected"}', { status: 401, statusText: 'Unauthorized' }); },
			getSecret: async () => 'tok-secret-123456',
			settings: { baseUrl: 'https://gitlab.example.com', defaultProject: 'g/p' },
		};
		const r = await executeIntegrationTool('gitlab_project', {}, { gitlab: { enabled: true } }, () => env);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.adapter).toBe('gitlab');
			expect(r.error).toContain('401');
			expect(r.error).not.toContain('abcdef123456');
			expect(r.error).not.toContain('tok-secret-123456');
		}
		expect(calls[0]).toContain('/api/v4/');
	});

	it('reports missing credentials by key', async () => {
		const jira = allAdapters().find(a => a.id === 'jira')!;
		expect(await missingCredentials(jira, async () => undefined)).toEqual(jira.credentials.map(c => c.key));
		expect(await missingCredentials(jira, async k => k.endsWith('.token') ? 't' : undefined)).toEqual(jira.credentials.filter(c => c.key !== 'token').map(c => c.key));
	});

	it('redacts credentials in text and argument previews', () => {
		expect(redactSecrets('PRIVATE-TOKEN: glpat-abcdefghij')).toBe('PRIVATE-TOKEN: ***');
		expect(redactSecrets('https://user:p4ssw0rd@proxy.example.com:8080')).toBe('https://user:***@proxy.example.com:8080');
		expect(redactSecrets('"password": "hunter22"')).toContain('***');
		expect(redactSecrets('Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==')).toBe('Authorization: Basic ***');
		const p = previewArgs({ summary: 'x'.repeat(500), apiToken: 'secret', n: 3 });
		expect(p).toContain('"apiToken":"***"');
		expect(p).toContain('…(500 chars)');
		expect(p.length).toBeLessThanOrEqual(401);
	});
});

describe('audit log', () => {
	it('appends redacted JSON lines and reads them newest first', () => {
		const root = mk();
		appendAudit(root, { consumer: 'riaf-agent', adapter: 'jira', tool: 'jira_comment', kind: 'write', args: { key: 'ABC-1', body: 'hello', token: 'nope' }, ok: true, ms: 12, approved: 'dialog', result: 'ok' });
		appendAudit(root, { consumer: 'claude-code', adapter: 'gitlab', tool: 'gitlab_mr_approve', kind: 'write', args: { iid: 7 }, ok: false, ms: 3, approved: 'none', error: '403 forbidden' });
		const raw = readFileSync(auditPathFor(root), 'utf8');
		expect(raw.split('\n').filter(Boolean)).toHaveLength(2);
		expect(raw).not.toContain('nope');
		const rows = readAudit(root);
		expect(rows[0].tool).toBe('gitlab_mr_approve');
		expect(rows[0].ok).toBe(false);
		expect(rows[1].args).toContain('"token":"***"');
		expect(readAudit(root, 1)).toHaveLength(1);
		expect(readAudit(mk())).toEqual([]);
	});
});

describe('MCP-side config and credentials', () => {
	it('writes .riaf/integrations.json without anything that looks like a credential', () => {
		const root = mk();
		const path = writeIntegrationsConfig(root, { jira: { enabled: true, baseUrl: 'https://j', token: 'LEAK', apiKey: 'LEAK2' }, gitlab: { enabled: false } });
		const text = readFileSync(path, 'utf8');
		expect(text).not.toContain('LEAK');
		expect(text).toContain('$comment');
		expect(readIntegrationsConfig(root)).toEqual({ jira: { enabled: true, baseUrl: 'https://j' }, gitlab: { enabled: false } });
		expect(readIntegrationsConfig(mk())).toEqual({});
		expect(sanitizeIntegrationsConfig({ knowledge: { vectorApiKey: 'x', vectorUrl: 'u' } })).toEqual({ knowledge: { vectorUrl: 'u' } });
	});

	it('maps secret keys to env vars and prefers env over the credentials file', async () => {
		expect(envVarForSecret('riaf.integration.jira.token')).toBe('RIAF_INTEGRATION_JIRA_TOKEN');
		expect(envVarForSecret('riaf.integration.knowledge.vectorApiKey')).toBe('RIAF_INTEGRATION_KNOWLEDGE_VECTORAPIKEY');
		const home = mk();
		const prev = process.env.RIAF_CREDENTIALS_FILE; process.env.RIAF_CREDENTIALS_FILE = join(home, 'credentials.json');
		try {
			const p = writeCredentialsFile({ 'riaf.integration.jira.token': 'file-token', 'riaf.integration.jira.email': 'me@example.com' });
			expect(existsSync(p)).toBe(true);
			if (process.platform !== 'win32') { expect(statSync(p).mode & 0o777).toBe(0o600); }
			process.env.RIAF_INTEGRATION_JIRA_TOKEN = 'env-token';
			const get = mcpSecretGetter();
			expect(await get('riaf.integration.jira.token')).toBe('env-token');
			expect(await get('riaf.integration.jira.email')).toBe('me@example.com');
			expect(await get('riaf.integration.gitlab.token')).toBeUndefined();
			writeCredentialsFile({ 'riaf.integration.jira.email': undefined });
			expect(readCredentialsFile()).toEqual({ 'riaf.integration.jira.token': 'file-token' });
		} finally {
			delete process.env.RIAF_INTEGRATION_JIRA_TOKEN;
			if (prev === undefined) { delete process.env.RIAF_CREDENTIALS_FILE; } else { process.env.RIAF_CREDENTIALS_FILE = prev; }
		}
	});
});

describe('package.json contributions', () => {
	it('stays in sync with the adapters (settings schema + Copilot read tools)', () => {
		const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
		const props = pkg.contributes.configuration.properties;
		for (const a of allAdapters()) {
			const p = props[`riaf.integrations.${a.id}`];
			expect(p, a.id).toBeDefined();
			expect(Object.keys(p.properties).sort()).toEqual(['enabled', ...Object.keys(a.settingsSchema)].sort());
			expect(p.default).toEqual({ enabled: false });
		}
		expect(props['riaf.agent.approveIntegrationWrites'].default).toBe(true);
		expect(props['riaf.integrations.shareCredentialsWithClaudeCode'].default).toBe(false);
		const lm = new Set<string>(pkg.contributes.languageModelTools.map((t: { name: string }) => t.name));
		for (const t of INTEGRATION_TOOL_SPECS) { expect(lm.has(`riaf_${t.name}`), t.name).toBe(t.kind === 'read'); }
		for (const c of ['riaf.setIntegrationCredentials', 'riaf.testIntegrations', 'riaf.showIntegrationAudit']) { expect(pkg.contributes.commands.some((x: { command: string }) => x.command === c), c).toBe(true); }
		// the generator agrees that nothing is stale
		execFileSync(process.execPath, [join(__dirname, '..', '..', 'scripts', 'sync-integrations.mjs'), '--check'], { stdio: 'pipe' });
	}, 30_000);
});
