import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { configStore, mockSecrets } from './vscode-mock.js';
import { SETTING_KEYS, handle, snapshotSettings } from '../src/settingsPanel.js';
import { readRules, writeRules, rulesForPrompt } from '../src/rules.js';
import { UsageMeter } from '../src/usage.js';

const memento = () => { const m = new Map<string, unknown>(); return { get: (k: string, d: unknown) => m.get(k) ?? d, update: async (k: string, v: unknown) => { m.set(k, v); } } as any; };
const deps = (folder?: unknown) => ({ ctx: { extensionPath: '/ext', secrets: mockSecrets } as any, usage: new UsageMeter(memento()), transport: () => undefined, indexes: { folderFor: () => folder, output: { show() { } } } as any });

describe('settings panel host', () => {
	it('set: accepts known keys and rejects unknown ones', async () => {
		const r = await handle({ type: 'set', key: 'agent.maxIterations', value: 7 }, deps());
		expect(configStore.get('agent.maxIterations')).toBe(7);
		expect((r.settings as any)['agent.maxIterations']).toBe(7);
		const bad = await handle({ type: 'set', key: 'telemetry.sendEverything', value: true }, deps());
		expect(bad.error).toMatch(/unknown setting/);
		expect(configStore.has('telemetry.sendEverything')).toBe(false);
	});
	it('snapshot covers every manifest key', () => {
		const pkg = JSON.parse(require('node:fs').readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
		const manifestKeys = Object.keys(pkg.contributes.configuration.properties).map((k: string) => k.replace(/^riaf\./, ''));
		expect([...SETTING_KEYS].sort()).toEqual(manifestKeys.sort());
		expect(Object.keys(snapshotSettings())).toHaveLength(SETTING_KEYS.length);
	});
	it('rules round-trip through .riafrules and are wrapped for the prompt', async () => {
		const root = mkdtempSync(join(tmpdir(), 'riaf-rules-'));
		const folder = { uri: { fsPath: root }, name: 'x', index: 0 } as any;
		expect(await readRules(folder)).toBe('');
		const r = await handle({ type: 'setRules', text: '- never use console.log' }, deps(folder));
		expect(r.rules).toBe('- never use console.log');
		expect(await readRules(folder)).toBe('- never use console.log');
		expect(rulesForPrompt('- a')).toBe('<project_rules>\n- a\n</project_rules>');
		expect(rulesForPrompt('   ')).toBe('');
		expect(rulesForPrompt('x'.repeat(9000))).toContain('[rules truncated]');
		await writeRules(folder, '');
		expect(rulesForPrompt(await readRules(folder))).toBe('');
	});
	it('resetUsage clears all-time but keeps the session', async () => {
		const d = deps();
		d.usage.record({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 }, { provider: 'liteLLM', model: 'm', purpose: 't' });
		const r = await handle({ type: 'resetUsage' }, d);
		expect((r.usage as any).allTime.calls).toBe(0);
		expect((r.usage as any).session.calls).toBe(1);
	});
});

import { resolveProxyWithCredentials } from '../src/claudeCodeSetup.js';
describe('proxy credentials from SecretStorage', () => {
	it('fills credentials from secrets only when the detected URL has none', async () => {
		const ctx = { extensionPath: '/ext', secrets: mockSecrets } as any;
		expect(await resolveProxyWithCredentials(ctx, 'http://proxy:8080')).toEqual({ url: 'http://proxy:8080', credentialSource: 'none' });
		await mockSecrets.store('riaf.claudeCode.proxyUsername', 'hpg5ban'); await mockSecrets.store('riaf.claudeCode.proxyPassword', 'p@ss');
		expect(await resolveProxyWithCredentials(ctx, 'http://proxy:8080')).toEqual({ url: 'http://hpg5ban:p%40ss@proxy:8080', credentialSource: 'secrets' });
		// credentials already in the URL win over stored ones
		expect(await resolveProxyWithCredentials(ctx, 'http://other:x@proxy:8080')).toEqual({ url: 'http://other:x@proxy:8080', credentialSource: 'url' });
	});
});
