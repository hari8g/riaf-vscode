/**
 * Local governor endpoint: a unix socket (named pipe on Windows) speaking newline-delimited JSON.
 * The long-lived host (riaf-mcp) owns the governor, cache and index; per-call hook processes connect,
 * send one request and print the reply — a few milliseconds instead of loading the index per hook.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createServer, createConnection, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface GovernorEndpointInfo { endpoint: string; pid: number; startedAt: number; version: number }

export const governorInfoPath = (workspaceRoot: string): string => join(workspaceRoot, '.riaf', 'governor.json');

export function endpointFor(workspaceRoot: string, pid = process.pid, platform = process.platform): string {
	const h = createHash('sha256').update(resolve(workspaceRoot)).digest('hex').slice(0, 10);
	return platform === 'win32' ? `\\\\.\\pipe\\riaf-gov-${h}-${pid}` : join(tmpdir(), `riaf-gov-${h}-${pid}.sock`);
}

export type RequestHandler = (msg: Record<string, unknown>) => Promise<unknown>;

export class GovernorServer {
	private server: Server | null = null;
	readonly endpoint: string;

	constructor(private readonly workspaceRoot: string, private readonly handler: RequestHandler, opts: { endpoint?: string; log?: (m: string) => void } = {}) {
		this.endpoint = opts.endpoint ?? endpointFor(workspaceRoot);
		this.log = opts.log ?? (() => { });
	}
	private readonly log: (m: string) => void;

	async start(): Promise<GovernorEndpointInfo> {
		if (process.platform !== 'win32' && existsSync(this.endpoint)) rmSync(this.endpoint, { force: true });
		this.server = createServer(sock => {
			let buf = '';
			sock.setEncoding('utf8');
			sock.on('data', chunk => {
				buf += chunk;
				let nl: number;
				while ((nl = buf.indexOf('\n')) >= 0) {
					const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
					if (!line.trim()) continue;
					let msg: Record<string, unknown>;
					try { msg = JSON.parse(line); } catch { sock.write(JSON.stringify({ error: 'bad json' }) + '\n'); continue; }
					this.handler(msg).then(
						res => { if (!sock.destroyed) sock.write(JSON.stringify(res ?? {}) + '\n'); },
						err => { this.log(`handler error: ${String(err)}`); if (!sock.destroyed) sock.write(JSON.stringify({ error: String(err) }) + '\n'); },
					);
				}
			});
			sock.on('error', () => { /* client went away */ });
		});
		await new Promise<void>((res, rej) => { this.server!.once('error', rej); this.server!.listen(this.endpoint, () => res()); });
		this.server.unref();
		const info: GovernorEndpointInfo = { endpoint: this.endpoint, pid: process.pid, startedAt: Date.now(), version: 1 };
		mkdirSync(join(this.workspaceRoot, '.riaf'), { recursive: true });
		writeFileSync(governorInfoPath(this.workspaceRoot), JSON.stringify(info, null, 2));
		return info;
	}

	async stop(): Promise<void> {
		const s = this.server; this.server = null;
		if (s) await new Promise<void>(res => s.close(() => res()));
		try {
			const cur = JSON.parse(readFileSync(governorInfoPath(this.workspaceRoot), 'utf8')) as GovernorEndpointInfo;
			if (cur.pid === process.pid) rmSync(governorInfoPath(this.workspaceRoot), { force: true });
		} catch { /* ignore */ }
		if (process.platform !== 'win32') rmSync(this.endpoint, { force: true });
	}
}

/** Client used by tests and by hosts that are not the hook script (one request, one reply). */
export function requestGovernor(endpoint: string, msg: unknown, timeoutMs = 2_000): Promise<unknown> {
	return new Promise((resolveP, reject) => {
		const sock = createConnection(endpoint);
		let buf = '';
		const timer = setTimeout(() => { sock.destroy(); reject(new Error('governor timeout')); }, timeoutMs);
		sock.setEncoding('utf8');
		sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'));
		sock.on('data', d => {
			buf += d;
			const nl = buf.indexOf('\n');
			if (nl >= 0) { clearTimeout(timer); sock.end(); try { resolveP(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); } }
		});
		sock.on('error', e => { clearTimeout(timer); reject(e); });
	});
}
