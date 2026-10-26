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

import { redactProxyUrl, splitProxyCredentials, withProxyCredentials } from '../src/claudeCodeNetwork.js';

describe('proxy credentials', () => {
	const bosch = 'http://rb-proxy-unix-apac.bosch.com:8080';

	it('composes user:password@host and percent-encodes awkward characters', () => {
		expect(withProxyCredentials(bosch, 'hpg5ban', 'plain')).toBe('http://hpg5ban:plain@rb-proxy-unix-apac.bosch.com:8080');
		const tricky = withProxyCredentials(bosch, 'DE\\hpg5ban', 'p@ss:w/rd#1 %');
		expect(tricky).toBe('http://DE%5Chpg5ban:p%40ss%3Aw%2Frd%231%20%25@rb-proxy-unix-apac.bosch.com:8080');
		expect(new URL(tricky).password).toBe('p%40ss%3Aw%2Frd%231%20%25');       // URL still parses
		expect(withProxyCredentials(bosch)).toBe(bosch);                           // no user → unchanged
		expect(withProxyCredentials('rb-proxy-unix-apac.bosch.com:8080', 'u', 'p')).toBe('http://u:p@rb-proxy-unix-apac.bosch.com:8080');
	});

	it('round-trips through split (decoding) and keeps the bare URL', () => {
		const full = withProxyCredentials(bosch, 'hpg5ban', 'p@ss#1');
		const parts = splitProxyCredentials(full);
		expect(parts).toEqual({ url: bosch, username: 'hpg5ban', password: 'p@ss#1' });
		expect(splitProxyCredentials(bosch)).toEqual({ url: bosch });
		expect(splitProxyCredentials('')).toEqual({ url: '' });
	});

	it('redacts the password everywhere it could be displayed', () => {
		expect(redactProxyUrl('http://hpg5ban:secret@rb-proxy-unix-apac.bosch.com:8080')).toBe('http://hpg5ban:***@rb-proxy-unix-apac.bosch.com:8080');
		expect(redactProxyUrl(bosch)).toBe(bosch);
		expect(redactProxyUrl('')).toBe('');
		expect(redactProxyUrl('http://u:p%40ss@h:1')).not.toContain('p%40ss');
	});

	it('detectProxy keeps credentials that came from the environment, so they reach Claude Code', () => {
		const d = detectProxy({ env: { HTTPS_PROXY: 'http://hpg5ban:secret@rb-proxy-unix-apac.bosch.com:8080' }, npmConfig: () => undefined });
		expect(d?.value).toBe('http://hpg5ban:secret@rb-proxy-unix-apac.bosch.com:8080');
		expect(splitProxyCredentials(d!.value).username).toBe('hpg5ban');
	});
});

import { validateProxyUrl } from '../src/claudeCodeNetwork.js';
describe('proxy URL validation (pasted-settings-line protection)', () => {
	it('accepts real URLs and tolerates pasted quotes', () => {
		expect(validateProxyUrl('')).toBeUndefined();
		expect(validateProxyUrl('http://rb-proxy-unix-apac.bosch.com:8080')).toBeUndefined();
		expect(validateProxyUrl('rb-proxy-unix-apac.bosch.com:8080')).toBeUndefined();
		expect(validateProxyUrl('"http://rb-proxy-unix-apac.bosch.com:8080",')).toBeUndefined();
		expect(normaliseProxyUrl('"http://p:1",')).toBe('http://p:1');
	});
	it('rejects a whole settings line and other junk, and detectProxy surfaces it', () => {
		expect(validateProxyUrl('"riaf.claudeCode.proxyUrl": "http://rb-proxy-unix-apac.bosch.com:8080"')).toMatch(/just the URL/);
		expect(validateProxyUrl('ftp://p:1')).toMatch(/http/);
		expect(validateProxyUrl('http://p:1/some/path')).toMatch(/path/);
		expect(() => detectProxy({ settingProxy: '"riaf.claudeCode.proxyUrl": "http://x:1"', env: {}, npmConfig: () => undefined })).toThrow(/riaf\.claudeCode\.proxyUrl/);
	});
});
