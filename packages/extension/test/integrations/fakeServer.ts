import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AdapterEnv } from '../../src/integrations/adapter.js';

export type Recorded = { method: string; path: string; query: URLSearchParams; headers: Record<string, string | string[] | undefined>; body: any };
export type Route = (req: Recorded) => { status?: number; json?: unknown; text?: string } | undefined;

export class FakeServer {
	readonly requests: Recorded[] = [];
	private routes: Array<{ method?: string; path: string | RegExp; handler: Route }> = [];
	private server?: Server;
	port = 0;

	on(method: string | undefined, path: string | RegExp, handler: Route | unknown): this {
		const h: Route = typeof handler === 'function' ? handler as Route : () => ({ json: handler });
		this.routes.push({ method, path, handler: h });
		return this;
	}
	reset(): void { this.requests.length = 0; this.routes.length = 0; }

	async start(): Promise<number> {
		this.server = createServer((req, res) => void this.handle(req, res));
		await new Promise<void>(r => this.server!.listen(0, '127.0.0.1', () => r()));
		const addr = this.server.address();
		this.port = typeof addr === 'object' && addr ? addr.port : 0;
		return this.port;
	}
	async stop(): Promise<void> { await new Promise<void>(r => this.server ? this.server.close(() => r()) : r()); }

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const chunks: Buffer[] = [];
		for await (const ch of req) { chunks.push(ch as Buffer); }
		const raw = Buffer.concat(chunks).toString('utf8');
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		let body: any = undefined;
		if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
		const rec: Recorded = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body };
		this.requests.push(rec);
		const route = this.routes.find(r => (!r.method || r.method === rec.method) && (typeof r.path === 'string' ? r.path === rec.path : r.path.test(rec.path)));
		const out = route?.handler(rec);
		if (!out) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ errorMessages: [`no route ${rec.method} ${rec.path}`] })); return; }
		res.writeHead(out.status ?? 200, { 'content-type': out.text !== undefined ? 'text/plain' : 'application/json' });
		res.end(out.text !== undefined ? out.text : JSON.stringify(out.json ?? {}));
	}
}

export function envFor(server: FakeServer, settings: Record<string, unknown>, secrets: Record<string, string | undefined>): AdapterEnv {
	return {
		fetch: (url, init) => globalThis.fetch(url, init),
		getSecret: async (key) => secrets[key],
		settings: { baseUrl: `http://127.0.0.1:${server.port}`, ...settings },
	};
}

export const decodeBasic = (auth: string | undefined): string => auth?.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString('utf8') : '';
