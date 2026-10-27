/**
 * Outbound HTTP for the gateway and the embeddings client.
 *
 * Claude Code reaches Anthropic through the local proxy bridge (or HTTPS_PROXY). The extension's
 * own `fetch` did not, so a corporate proxy that the bridge already knew about still broke
 * gateway chat and embeddings. This module sends those calls through the bridge when it is
 * running, otherwise through the same detected upstream proxy, and skips the proxy for loopback
 * and noProxy hosts.
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import * as vscode from 'vscode';
import { detectProxy } from './claudeCodeNetwork.js';
import { readSettings } from './config.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const agents = new Map<string, ProxyAgent>();
let ensureBridge: (() => Promise<string | undefined>) | undefined;

/** Called from activate so gateway and embeddings follow the running bridge. */
export function setOutboundProxy(ensure: () => Promise<string | undefined>): void {
	ensureBridge = ensure;
}

/** Loopback and noProxy hosts go direct, so a local gateway is not sent back through the bridge. */
export function shouldBypassProxy(targetUrl: string, noProxy: string[] = []): boolean {
	let host = '';
	try { host = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
	if (host === 'localhost' || host === '127.0.0.1' || host === '::1') { return true; }
	for (const raw of noProxy) {
		const bare = raw.trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, '');
		if (!bare) { continue; }
		if (host === bare || host.endsWith(`.${bare}`)) { return true; }
	}
	return false;
}

/** Bridge URL when the bridge is up; otherwise the detected corporate proxy (may include credentials). */
export async function resolveOutboundProxyUrl(): Promise<string | undefined> {
	const bridged = await ensureBridge?.().catch(() => undefined);
	if (bridged) { return bridged; }
	const s = readSettings();
	try {
		return detectProxy({
			settingProxy: s.claudeCode.proxyUrl,
			vscodeProxy: vscode.workspace.getConfiguration('http').get<string>('proxy'),
		})?.value;
	} catch {
		return undefined;
	}
}

export function createProxiedFetch(proxyUrl: string | undefined, noProxy: string[] = []): FetchLike {
	return (url, init) => {
		if (!proxyUrl || shouldBypassProxy(url, noProxy)) { return fetch(url, init); }
		let agent = agents.get(proxyUrl);
		if (!agent) { agent = new ProxyAgent(proxyUrl); agents.set(proxyUrl, agent); }
		return undiciFetch(url, { ...init, dispatcher: agent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
	};
}

/** Fetch for one outbound call: resolve the proxy, then honour noProxy against the target URL. */
export async function outboundFetch(): Promise<FetchLike> {
	const s = readSettings();
	return createProxiedFetch(await resolveOutboundProxyUrl(), s.claudeCode.noProxy);
}
