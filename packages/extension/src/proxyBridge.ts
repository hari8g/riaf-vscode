/**
 * Local proxy bridge: an unauthenticated HTTP proxy on 127.0.0.1 that forwards every request to
 * an authenticated upstream (corporate) proxy, adding `Proxy-Authorization: Basic …` itself.
 *
 * Why: some clients (Claude Code's native build among them, as observed against the Bosch proxy)
 * fail to complete a CONNECT through a basic-auth proxy that curl and browsers handle fine. With
 * the bridge, the client is configured with `http://127.0.0.1:<port>` — no credentials in any URL
 * or settings file — and the bridge speaks to the corporate proxy on its behalf. It also logs the
 * upstream's answer to each CONNECT, which is the diagnostic you otherwise cannot get.
 *
 * Supports CONNECT (HTTPS tunnels) and plain HTTP forwarding. No `vscode` import: used by the
 * extension host and by the standalone `dist/proxy-bridge.mjs` CLI.
 */
import * as http from 'node:http';
import * as net from 'node:net';
import { URL } from 'node:url';

export type UpstreamProxy = { host: string; port: number; username?: string; password?: string };

export type BridgeOptions = {
	listenHost?: string;          // default 127.0.0.1
	listenPort?: number;          // default 3128; 0 = any free port
	upstream: UpstreamProxy;
	/** Hosts (suffix match, case-insensitive) to connect directly, bypassing the upstream. */
	noProxy?: string[];
	log?: (msg: string) => void;
	connectTimeoutMs?: number;    // default 15000
};

export type BridgeStats = { connects: number; upstreamOk: number; upstreamRejected: number; lastUpstreamStatus?: string; lastError?: string };

export type ProxyBridge = {
	port: number;
	host: string;
	url: string;                  // http://127.0.0.1:port
	stats: BridgeStats;
	close(): Promise<void>;
};

export function parseUpstream(proxyUrl: string): UpstreamProxy {
	const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(proxyUrl) ? proxyUrl : `http://${proxyUrl}`);
	return {
		host: u.hostname,
		port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
		username: u.username ? decodeURIComponent(u.username) : undefined,
		password: u.password ? decodeURIComponent(u.password) : undefined,
	};
}

export const basicAuthHeader = (username?: string, password?: string): string | undefined =>
	username ? `Basic ${Buffer.from(`${username}:${password ?? ''}`, 'utf8').toString('base64')}` : undefined;

const matchesNoProxy = (host: string, list: string[] = []): boolean => {
	const h = host.toLowerCase();
	return list.some(e => {
		const x = e.trim().toLowerCase().replace(/^\*?\./, '.');
		if (!x) { return false; }
		if (x === '*') { return true; }
		return x.startsWith('.') ? h.endsWith(x) || h === x.slice(1) : h === x;
	});
};

/** Read the HTTP response head from a socket; resolves with status line, headers text and any leftover body bytes. */
function readResponseHead(sock: net.Socket, timeoutMs: number): Promise<{ statusLine: string; statusCode: number; rest: Buffer }> {
	return new Promise((resolve, reject) => {
		let buf = Buffer.alloc(0);
		const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for upstream proxy response (${timeoutMs} ms)`)); }, timeoutMs);
		const onData = (d: Buffer) => {
			buf = Buffer.concat([buf, d]);
			const idx = buf.indexOf('\r\n\r\n');
			if (idx === -1) { return; }
			cleanup();
			const head = buf.subarray(0, idx).toString('latin1');
			const statusLine = head.split('\r\n')[0] ?? '';
			const statusCode = Number(statusLine.split(' ')[1]) || 0;
			resolve({ statusLine, statusCode, rest: buf.subarray(idx + 4) });
		};
		const onErr = (e: Error) => { cleanup(); reject(e); };
		const onEnd = () => { cleanup(); reject(new Error(`upstream proxy closed the connection before answering${buf.length ? ` (got: ${buf.toString('latin1').slice(0, 120)})` : ''}`)); };
		const cleanup = () => { clearTimeout(timer); sock.off('data', onData); sock.off('error', onErr); sock.off('end', onEnd); sock.off('close', onEnd); };
		sock.on('data', onData); sock.on('error', onErr); sock.on('end', onEnd); sock.on('close', onEnd);
	});
}

export function startProxyBridge(opts: BridgeOptions): Promise<ProxyBridge> {
	const listenHost = opts.listenHost ?? '127.0.0.1';
	const log = opts.log ?? (() => { });
	const timeoutMs = opts.connectTimeoutMs ?? 15_000;
	const auth = basicAuthHeader(opts.upstream.username, opts.upstream.password);
	const stats: BridgeStats = { connects: 0, upstreamOk: 0, upstreamRejected: 0 };

	const server = http.createServer();

	// HTTPS (and anything else) goes through CONNECT tunnels.
	server.on('connect', (req, clientSock, head) => {
		stats.connects++;
		const target = req.url ?? '';
		const [tHost, tPortStr] = target.split(':');
		const direct = matchesNoProxy(tHost ?? '', opts.noProxy);
		const up = direct
			? net.connect({ host: tHost, port: Number(tPortStr) || 443 })
			: net.connect({ host: opts.upstream.host, port: opts.upstream.port });
		up.setTimeout(timeoutMs);
		up.once('error', e => { stats.lastError = `${target}: ${e.message}`; log(`CONNECT ${target} → upstream error: ${e.message}`); clientSock.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n`); });
		up.once('timeout', () => { up.destroy(new Error('connect timeout')); });
		up.once('connect', async () => {
			if (direct) {
				stats.upstreamOk++;
				clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				if (head?.length) { up.write(head); }
				up.pipe(clientSock); clientSock.pipe(up);
				return;
			}
			const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`, 'Proxy-Connection: Keep-Alive', 'User-Agent: riaf-proxy-bridge/0.1'];
			if (auth) { lines.push(`Proxy-Authorization: ${auth}`); }
			up.write(lines.join('\r\n') + '\r\n\r\n');
			try {
				const res = await readResponseHead(up, timeoutMs);
				stats.lastUpstreamStatus = res.statusLine;
				if (res.statusCode === 200) {
					stats.upstreamOk++;
					log(`CONNECT ${target} → ${res.statusLine}`);
					clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
					if (res.rest.length) { clientSock.write(res.rest); }
					if (head?.length) { up.write(head); }
					up.pipe(clientSock); clientSock.pipe(up);
				} else {
					stats.upstreamRejected++;
					log(`CONNECT ${target} → upstream refused: ${res.statusLine}${res.statusCode === 407 ? ' (credentials rejected — check "RIAF: Set Claude Code proxy credentials")' : ''}`);
					clientSock.end(`HTTP/1.1 ${res.statusCode} ${res.statusLine.split(' ').slice(2).join(' ') || 'Upstream Proxy Error'}\r\nContent-Length: 0\r\n\r\n`);
					up.destroy();
				}
			} catch (e) {
				stats.lastError = `${target}: ${(e as Error).message}`;
				log(`CONNECT ${target} → ${(e as Error).message}`);
				clientSock.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
				up.destroy();
			}
		});
		clientSock.once('error', () => up.destroy());
		clientSock.once('close', () => up.destroy());
	});

	// Plain HTTP: forward the absolute-URI request to the upstream with the auth header.
	server.on('request', (req, res) => {
		let target: URL;
		try { target = new URL(req.url ?? ''); } catch { res.writeHead(400); res.end('proxy bridge: absolute URL required'); return; }
		const direct = matchesNoProxy(target.hostname, opts.noProxy);
		const headers: http.OutgoingHttpHeaders = { ...req.headers };
		delete headers['proxy-connection'];
		if (!direct && auth) { headers['proxy-authorization'] = auth; }
		const upReq = http.request({
			host: direct ? target.hostname : opts.upstream.host,
			port: direct ? (Number(target.port) || 80) : opts.upstream.port,
			method: req.method, path: direct ? `${target.pathname}${target.search}` : req.url, headers, timeout: timeoutMs,
		}, upRes => {
			if (!direct) { stats.lastUpstreamStatus = `HTTP/${upRes.httpVersion} ${upRes.statusCode}`; if (upRes.statusCode === 407) { stats.upstreamRejected++; } }
			res.writeHead(upRes.statusCode ?? 502, upRes.headers);
			upRes.pipe(res);
		});
		upReq.on('error', e => { stats.lastError = e.message; log(`${req.method} ${req.url} → ${e.message}`); if (!res.headersSent) { res.writeHead(502); } res.end(); });
		req.pipe(upReq);
	});

	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(opts.listenPort ?? 3128, listenHost, () => {
			const addr = server.address() as net.AddressInfo;
			log(`proxy bridge listening on http://${listenHost}:${addr.port} → ${opts.upstream.host}:${opts.upstream.port}${auth ? ' (basic auth)' : ' (no auth)'}`);
			resolve({
				port: addr.port, host: listenHost, url: `http://${listenHost}:${addr.port}`, stats,
				close: () => new Promise<void>(r => { server.closeAllConnections?.(); server.close(() => r()); }),
			});
		});
	});
}
