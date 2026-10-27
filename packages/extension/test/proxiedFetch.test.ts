import { createServer, type Server } from 'node:http';
import { connect as netConnect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createProxiedFetch, shouldBypassProxy } from '../src/proxiedFetch.js';

const listen = (server: Server) => new Promise<number>(resolve => {
	server.listen(0, '127.0.0.1', () => {
		const addr = server.address();
		resolve(typeof addr === 'object' && addr ? addr.port : 0);
	});
});

describe('shouldBypassProxy', () => {
	it('skips loopback and noProxy suffixes, and sends other hosts through the proxy', () => {
		expect(shouldBypassProxy('http://127.0.0.1:4000/v1/embeddings')).toBe(true);
		expect(shouldBypassProxy('http://localhost/chat')).toBe(true);
		expect(shouldBypassProxy('https://gateway.example.com/v1', ['.example.com'])).toBe(true);
		expect(shouldBypassProxy('https://api.anthropic.com/v1/messages', ['localhost'])).toBe(false);
	});
});

describe('createProxiedFetch', () => {
	it('tunnels a non-loopback request through an HTTP proxy and leaves loopback direct', async () => {
		const origin = createServer((req, res) => {
			res.writeHead(200, { 'content-type': 'text/plain' });
			res.end(`origin ${req.url}`);
		});
		const originPort = await listen(origin);

		const seen: string[] = [];
		const proxy = createServer();
		proxy.on('connect', (req, client, head) => {
			seen.push(String(req.url));
			const upstream = netConnect(originPort, '127.0.0.1', () => {
				client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				if (head?.length) { upstream.write(head); }
				upstream.pipe(client);
				client.pipe(upstream);
			});
			upstream.on('error', () => client.destroy());
		});
		const proxyPort = await listen(proxy);

		try {
			const viaProxy = createProxiedFetch(`http://127.0.0.1:${proxyPort}`, ['localhost']);
			const proxied = await viaProxy(`http://riaf.test:${originPort}/chat`);
			expect(await proxied.text()).toBe('origin /chat');
			expect(seen).toEqual([`riaf.test:${originPort}`]);

			seen.length = 0;
			const direct = await viaProxy(`http://127.0.0.1:${originPort}/embeddings`);
			expect(await direct.text()).toBe('origin /embeddings');
			expect(seen).toEqual([]);
		} finally {
			origin.close();
			proxy.close();
		}
	});
});
