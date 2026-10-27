import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { basicAuthHeader, parseUpstream, startProxyBridge, type ProxyBridge } from '../src/proxyBridge.js';

/** A fake corporate proxy: requires `Proxy-Authorization: Basic` for CONNECT and plain requests, then tunnels. */
function fakeUpstream(user: string, pass: string): Promise<{ port: number; seen: string[]; close: () => void }> {
	const seen: string[] = [];
	const expected = basicAuthHeader(user, pass);
	const srv = http.createServer((req, res) => {
		seen.push(`${req.method} ${req.url} auth=${req.headers['proxy-authorization'] ?? 'none'}`);
		if (req.headers['proxy-authorization'] !== expected) { res.writeHead(407, { 'Proxy-Authenticate': 'BASIC realm="Bosch NT Account"' }); res.end(); return; }
		const u = new URL(req.url!);
		const fwd = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: req.method }, r => { res.writeHead(r.statusCode!, r.headers); r.pipe(res); });
		req.pipe(fwd);
	});
	srv.on('connect', (req, sock, head) => {
		seen.push(`CONNECT ${req.url} auth=${req.headers['proxy-authorization'] ?? 'none'}`);
		if (req.headers['proxy-authorization'] !== expected) { sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: BASIC realm="Bosch NT Account"\r\nContent-Length: 0\r\n\r\n'); return; }
		const [h, p] = req.url!.split(':');
		const target = net.connect(Number(p), h, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) { target.write(head); } target.pipe(sock); sock.pipe(target); });
		target.on('error', () => sock.destroy());
	});
	return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ port: (srv.address() as net.AddressInfo).port, seen, close: () => srv.close() })));
}

/** Target "origin" server (plain HTTP; the tunnel is opaque so this stands in for api.anthropic.com:443). */
function targetServer(): Promise<{ port: number; close: () => void }> {
	const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`hello ${req.url}`); });
	return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close() })));
}

/** Do a CONNECT through `proxyPort`, then an HTTP GET over the tunnel. Returns the CONNECT status and the body. */
function connectThrough(proxyPort: number, targetHostPort: string, path: string): Promise<{ connectStatus: number; body: string }> {
	return new Promise((resolve, reject) => {
		const s = net.connect(proxyPort, '127.0.0.1', () => s.write(`CONNECT ${targetHostPort} HTTP/1.1\r\nHost: ${targetHostPort}\r\n\r\n`));
		let buf = ''; let phase: 'connect' | 'body' = 'connect'; let connectStatus = 0;
		s.on('data', d => {
			buf += d.toString();
			if (phase === 'connect') {
				const i = buf.indexOf('\r\n\r\n'); if (i === -1) { return; }
				connectStatus = Number(buf.split(' ')[1]);
				if (connectStatus !== 200) { s.destroy(); resolve({ connectStatus, body: '' }); return; }
				buf = buf.slice(i + 4); phase = 'body';
				s.write(`GET ${path} HTTP/1.1\r\nHost: ${targetHostPort}\r\nConnection: close\r\n\r\n`);
			}
		});
		s.on('close', () => resolve({ connectStatus, body: buf }));
		s.on('error', reject);
	});
}

describe('local proxy bridge', () => {
	let up: Awaited<ReturnType<typeof fakeUpstream>>; let target: Awaited<ReturnType<typeof targetServer>>; let bridge: ProxyBridge; const log: string[] = [];
	beforeAll(async () => {
		up = await fakeUpstream('hpg5ban', 'p@ss#1');
		target = await targetServer();
		bridge = await startProxyBridge({ listenPort: 0, upstream: { host: '127.0.0.1', port: up.port, username: 'hpg5ban', password: 'p@ss#1' }, noProxy: ['direct.invalid'], log: m => log.push(m) });
	});
	afterAll(async () => { await bridge.close(); up.close(); target.close(); });

	it('tunnels CONNECT through the authenticated upstream, adding the credentials itself', async () => {
		const r = await connectThrough(bridge.port, `127.0.0.1:${target.port}`, '/ping');
		expect(r.connectStatus).toBe(200);
		expect(r.body).toMatch(/^HTTP\/1\.1 200 OK/);
		expect(r.body).toContain('hello /ping');
		expect(up.seen.at(-1)).toMatch(/^CONNECT 127\.0\.0\.1:\d+ auth=Basic /);           // upstream saw Basic auth
		expect(bridge.stats.upstreamOk).toBe(1);
		expect(log.some(l => /CONNECT .* → HTTP\/1\.1 200/.test(l))).toBe(true);
	});

	it('forwards plain HTTP with Proxy-Authorization', async () => {
		const body = await new Promise<string>((res, rej) => {
			http.get({ host: '127.0.0.1', port: bridge.port, path: `http://127.0.0.1:${target.port}/plain` }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); }).on('error', rej);
		});
		expect(body).toBe('hello /plain');
	});

	it('relays an upstream 407 to the client and records it, instead of closing the socket', async () => {
		const wrong = await startProxyBridge({ listenPort: 0, upstream: { host: '127.0.0.1', port: up.port, username: 'hpg5ban', password: 'nope' }, log: m => log.push(m) });
		try {
			const r = await connectThrough(wrong.port, `127.0.0.1:${target.port}`, '/x');
			expect(r.connectStatus).toBe(407);
			expect(wrong.stats.upstreamRejected).toBe(1);
			expect(wrong.stats.lastUpstreamStatus).toMatch(/407/);
			expect(log.some(l => /credentials rejected/.test(l))).toBe(true);
		} finally { await wrong.close(); }
	});

	it('bypasses the upstream for NO_PROXY hosts', async () => {
		// ".invalid" is reserved and does not resolve. ".local" is mDNS on macOS and can stall the lookup past the test timeout.
		const before = up.seen.length;
		const r = await connectThrough(bridge.port, 'direct.invalid:1', '/');
		expect(r.connectStatus).toBe(502);
		expect(up.seen.length).toBe(before);
	});

	it('parses upstream URLs with and without credentials', () => {
		expect(parseUpstream('http://rb-proxy-unix-apac.bosch.com:8080')).toEqual({ host: 'rb-proxy-unix-apac.bosch.com', port: 8080, username: undefined, password: undefined });
		expect(parseUpstream('rb-proxy-unix-apac.bosch.com:8080').port).toBe(8080);
		expect(parseUpstream('http://u:p%40ss@h:1')).toEqual({ host: 'h', port: 1, username: 'u', password: 'p@ss' });
		expect(basicAuthHeader('hpg5ban', 'p@ss#1')).toBe(`Basic ${Buffer.from('hpg5ban:p@ss#1').toString('base64')}`);
	});
});
