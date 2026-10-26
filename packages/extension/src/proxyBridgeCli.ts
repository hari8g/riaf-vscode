#!/usr/bin/env node
/**
 * Standalone proxy bridge for use outside VS Code (e.g. Claude Code in a terminal when VS Code is closed).
 *
 *   node dist/proxy-bridge.mjs --upstream http://proxy.example.com:8080 [--port 3128] [--no-proxy localhost,.example.com]
 *
 * Credentials: RIAF_PROXY_USER / RIAF_PROXY_PASS environment variables, or an interactive masked prompt.
 * Then point the client at it:  HTTPS_PROXY=http://127.0.0.1:3128
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseUpstream, startProxyBridge } from './proxyBridge.js';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const upstreamUrl = flag('upstream') ?? process.env.RIAF_UPSTREAM_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
if (!upstreamUrl) { console.error('usage: proxy-bridge --upstream http://proxy:8080 [--port 3128] [--no-proxy a,b]'); process.exit(2); }

const ask = (q: string, mask = false): Promise<string> => new Promise(resolve => {
	const muted = new Writable({ write(_c, _e, cb) { cb(); } });
	const rl = createInterface({ input: process.stdin, output: mask ? muted : process.stdout, terminal: true });
	process.stdout.write(q);
	rl.question('', a => { rl.close(); if (mask) { process.stdout.write('\n'); } resolve(a); });
});

const up = parseUpstream(upstreamUrl);
if (!up.username) { up.username = process.env.RIAF_PROXY_USER || await ask('proxy user: '); }
if (up.username && !up.password) { up.password = process.env.RIAF_PROXY_PASS || await ask('proxy password: ', true); }

const bridge = await startProxyBridge({
	listenPort: Number(flag('port') ?? process.env.RIAF_BRIDGE_PORT ?? 3128),
	upstream: up,
	noProxy: (flag('no-proxy') ?? process.env.NO_PROXY ?? 'localhost,127.0.0.1').split(','),
	log: m => console.error(`[bridge] ${m}`),
});
console.error(`[bridge] set HTTPS_PROXY=${bridge.url} HTTP_PROXY=${bridge.url} for the client; Ctrl+C to stop`);
const stop = async () => { await bridge.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
