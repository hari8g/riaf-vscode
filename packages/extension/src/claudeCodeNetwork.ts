/**
 * Route A for Claude Code behind a corporate proxy: Claude Code reads HTTPS_PROXY / NO_PROXY /
 * NODE_EXTRA_CA_CERTS from the `env` block of ~/.claude/settings.json (it does NOT read npm's
 * proxy config or the Windows certificate store on Node < 22.15). "RIAF: Set up Claude Code"
 * detects the values this machine already uses and writes them there.
 *
 * Detection order (first non-empty wins):
 *   proxy : riaf.claudeCode.proxyUrl → VS Code http.proxy → HTTPS_PROXY/https_proxy/HTTP_PROXY → npm config https-proxy/proxy
 *   CA    : riaf.claudeCode.caCertPath → NODE_EXTRA_CA_CERTS → npm config cafile
 *
 * The pure functions take their inputs as arguments so they are testable without vscode.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type ProxyInputs = {
	/** riaf.claudeCode.proxyUrl */
	settingProxy?: string;
	/** VS Code http.proxy */
	vscodeProxy?: string;
	env?: NodeJS.ProcessEnv;
	/** npm config lookup; defaults to running `npm config get <key>` */
	npmConfig?: (key: string) => string | undefined;
};

export type CaInputs = {
	/** riaf.claudeCode.caCertPath */
	settingCaPath?: string;
	env?: NodeJS.ProcessEnv;
	npmConfig?: (key: string) => string | undefined;
};

export type Detected<T = string> = { value: T; source: string } | undefined;

export function npmConfigGet(key: string): string | undefined {
	try {
		const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
		const v = execFileSync(npm, ['config', 'get', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8_000, shell: process.platform === 'win32' }).trim();
		return v && v !== 'null' && v !== 'undefined' ? v : undefined;
	} catch { return undefined; }
}

const clean = (v: unknown): string => typeof v === 'string' ? v.trim() : '';

/** Claude Code refuses a proxy URL without a scheme, so normalise `host:port` → `http://host:port`. */
export const normaliseProxyUrl = (u: string): string => {
	const s = u.trim();
	if (!s) { return ''; }
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
};

export function detectProxy(i: ProxyInputs): Detected {
	const env = i.env ?? process.env;
	const npm = i.npmConfig ?? npmConfigGet;
	const candidates: [string, string][] = [
		[clean(i.settingProxy), 'riaf.claudeCode.proxyUrl'],
		[clean(i.vscodeProxy), 'VS Code http.proxy'],
		[clean(env.HTTPS_PROXY), 'HTTPS_PROXY'], [clean(env.https_proxy), 'https_proxy'],
		[clean(env.HTTP_PROXY), 'HTTP_PROXY'], [clean(env.http_proxy), 'http_proxy'],
	];
	for (const [v, source] of candidates) { if (v) { return { value: normaliseProxyUrl(v), source }; } }
	for (const key of ['https-proxy', 'proxy']) { const v = clean(npm(key)); if (v) { return { value: normaliseProxyUrl(v), source: `npm config ${key}` }; } }
	return undefined;
}

export function detectCaCert(i: CaInputs): Detected {
	const env = i.env ?? process.env;
	const npm = i.npmConfig ?? npmConfigGet;
	const candidates: [string, string][] = [
		[clean(i.settingCaPath), 'riaf.claudeCode.caCertPath'],
		[clean(env.NODE_EXTRA_CA_CERTS), 'NODE_EXTRA_CA_CERTS'],
	];
	for (const [v, source] of candidates) { if (v) { return { value: v, source }; } }
	const cafile = clean(npm('cafile'));
	if (cafile) { return { value: cafile, source: 'npm config cafile' }; }
	return undefined;
}

export type ClaudeNetworkEnv = { HTTPS_PROXY?: string; HTTP_PROXY?: string; NO_PROXY?: string; NODE_EXTRA_CA_CERTS?: string };

export function buildClaudeEnv(opts: { proxy?: string; noProxy?: string[]; caCertPath?: string }): ClaudeNetworkEnv {
	const env: ClaudeNetworkEnv = {};
	if (opts.proxy) { env.HTTPS_PROXY = opts.proxy; env.HTTP_PROXY = opts.proxy; }
	const noProxy = (opts.noProxy ?? []).map(s => s.trim()).filter(Boolean);
	if (opts.proxy && noProxy.length) { env.NO_PROXY = noProxy.join(','); }
	if (opts.caCertPath) { env.NODE_EXTRA_CA_CERTS = opts.caCertPath; }
	return env;
}

/** Merge into an existing ~/.claude/settings.json: keep every other key, add/overwrite only the keys we set. */
export function mergeClaudeSettings(existing: string | undefined, env: ClaudeNetworkEnv): { json: string; changedKeys: string[] } {
	let obj: Record<string, unknown> = {};
	if (existing && existing.trim()) {
		try { obj = JSON.parse(existing) as Record<string, unknown>; } catch { throw new Error('~/.claude/settings.json is not valid JSON; fix it by hand first'); }
	}
	const cur = (obj.env && typeof obj.env === 'object' ? obj.env : {}) as Record<string, unknown>;
	const next = { ...cur };
	const changedKeys: string[] = [];
	for (const [k, v] of Object.entries(env)) {
		if (v && cur[k] !== v) { next[k] = v; changedKeys.push(k); }
	}
	obj.env = next;
	return { json: JSON.stringify(obj, null, 2) + '\n', changedKeys };
}

export const claudeUserSettingsPath = (): string => join(homedir(), '.claude', 'settings.json');

export function readClaudeUserSettingsEnv(): Record<string, string> {
	try {
		const obj = JSON.parse(readFileSync(claudeUserSettingsPath(), 'utf8')) as { env?: Record<string, string> };
		return obj.env ?? {};
	} catch { return {}; }
}

/** Write the merged file; returns which env keys changed (empty when already up to date). */
export function writeClaudeUserSettings(env: ClaudeNetworkEnv): { path: string; changedKeys: string[] } {
	const path = claudeUserSettingsPath();
	const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
	const { json, changedKeys } = mergeClaudeSettings(existing, env);
	if (changedKeys.length) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, json); }
	return { path, changedKeys };
}

/** Node < 22.15 can't read the OS certificate store, so a TLS-inspecting proxy needs NODE_EXTRA_CA_CERTS. */
export function nodeNeedsExplicitCa(version = process.versions.node): boolean {
	const [maj, min] = version.split('.').map(Number);
	return maj < 22 || (maj === 22 && min < 15);
}
