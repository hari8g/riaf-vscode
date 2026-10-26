import { describe, expect, it } from 'vitest';
import { buildClaudeEnv, detectCaCert, detectProxy, mergeClaudeSettings, nodeNeedsExplicitCa, normaliseProxyUrl } from '../src/claudeCodeNetwork.js';

const npm = (table: Record<string, string>) => (k: string) => table[k];

describe('Claude Code network config (Route A)', () => {
	it('proxy detection precedence: setting → VS Code http.proxy → env → npm config', () => {
		const env = { HTTPS_PROXY: 'http://env:1' };
		const n = npm({ 'https-proxy': 'http://npm:2' });
		expect(detectProxy({ settingProxy: 'http://set:0', vscodeProxy: 'http://vs:3', env, npmConfig: n })).toEqual({ value: 'http://set:0', source: 'riaf.claudeCode.proxyUrl' });
		expect(detectProxy({ vscodeProxy: 'http://vs:3', env, npmConfig: n })).toEqual({ value: 'http://vs:3', source: 'VS Code http.proxy' });
		expect(detectProxy({ env, npmConfig: n })).toEqual({ value: 'http://env:1', source: 'HTTPS_PROXY' });
		expect(detectProxy({ env: {}, npmConfig: n })).toEqual({ value: 'http://npm:2', source: 'npm config https-proxy' });
		expect(detectProxy({ env: {}, npmConfig: npm({ proxy: 'proxy.corp:8080' }) })).toEqual({ value: 'http://proxy.corp:8080', source: 'npm config proxy' });
		expect(detectProxy({ env: {}, npmConfig: npm({}) })).toBeUndefined();
	});

	it('adds a scheme when the proxy has none (Claude Code rejects schemeless URLs)', () => {
		expect(normaliseProxyUrl('proxy.corp:8080')).toBe('http://proxy.corp:8080');
		expect(normaliseProxyUrl('https://p:1')).toBe('https://p:1');
		expect(normaliseProxyUrl('http://user:pw@p:1')).toBe('http://user:pw@p:1');
		expect(normaliseProxyUrl('  ')).toBe('');
	});

	it('CA detection precedence: setting → NODE_EXTRA_CA_CERTS → npm cafile', () => {
		expect(detectCaCert({ settingCaPath: 'C:\\ca.pem', env: { NODE_EXTRA_CA_CERTS: '/e.pem' }, npmConfig: npm({ cafile: '/n.pem' }) })?.value).toBe('C:\\ca.pem');
		expect(detectCaCert({ env: { NODE_EXTRA_CA_CERTS: '/e.pem' }, npmConfig: npm({ cafile: '/n.pem' }) })?.source).toBe('NODE_EXTRA_CA_CERTS');
		expect(detectCaCert({ env: {}, npmConfig: npm({ cafile: '/n.pem' }) })).toEqual({ value: '/n.pem', source: 'npm config cafile' });
		expect(detectCaCert({ env: {}, npmConfig: npm({}) })).toBeUndefined();
	});

	it('builds the env block Claude Code expects', () => {
		expect(buildClaudeEnv({ proxy: 'http://p:1', noProxy: ['localhost', ' .corp.com ', ''], caCertPath: '/ca.pem' }))
			.toEqual({ HTTPS_PROXY: 'http://p:1', HTTP_PROXY: 'http://p:1', NO_PROXY: 'localhost,.corp.com', NODE_EXTRA_CA_CERTS: '/ca.pem' });
		expect(buildClaudeEnv({ noProxy: ['localhost'] })).toEqual({});           // no proxy → nothing (NO_PROXY alone is meaningless)
		expect(buildClaudeEnv({ caCertPath: '/ca.pem' })).toEqual({ NODE_EXTRA_CA_CERTS: '/ca.pem' });
	});

	it('merges into ~/.claude/settings.json without touching other keys or unrelated env vars', () => {
		const existing = JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, env: { ANTHROPIC_MODEL: 'claude-sonnet-4-5', HTTPS_PROXY: 'http://old:1' }, model: 'opus' });
		const { json, changedKeys } = mergeClaudeSettings(existing, { HTTPS_PROXY: 'http://p:1', HTTP_PROXY: 'http://p:1', NODE_EXTRA_CA_CERTS: '/ca.pem' });
		const out = JSON.parse(json);
		expect(out.permissions).toEqual({ allow: ['Bash(npm test)'] });
		expect(out.model).toBe('opus');
		expect(out.env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-5');
		expect(out.env.HTTPS_PROXY).toBe('http://p:1');
		expect(out.env.NODE_EXTRA_CA_CERTS).toBe('/ca.pem');
		expect(changedKeys.sort()).toEqual(['HTTPS_PROXY', 'HTTP_PROXY', 'NODE_EXTRA_CA_CERTS'].sort());
		// idempotent
		expect(mergeClaudeSettings(json, { HTTPS_PROXY: 'http://p:1', HTTP_PROXY: 'http://p:1', NODE_EXTRA_CA_CERTS: '/ca.pem' }).changedKeys).toEqual([]);
		// fresh file
		expect(JSON.parse(mergeClaudeSettings(undefined, { HTTPS_PROXY: 'http://p:1' }).json)).toEqual({ env: { HTTPS_PROXY: 'http://p:1' } });
		// malformed file is an error, not silently overwritten
		expect(() => mergeClaudeSettings('{ not json', { HTTPS_PROXY: 'x' })).toThrow(/not valid JSON/);
	});

	it('knows which Node versions cannot read the OS certificate store', () => {
		expect(nodeNeedsExplicitCa('20.18.2')).toBe(true);
		expect(nodeNeedsExplicitCa('22.14.0')).toBe(true);
		expect(nodeNeedsExplicitCa('22.15.0')).toBe(false);
		expect(nodeNeedsExplicitCa('24.1.0')).toBe(false);
	});
});
