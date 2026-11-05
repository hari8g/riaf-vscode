/**
 * riafd — the local daemon behind the RIAF Console (Design D). Plain Node `http`, loopback only, a
 * per-start bearer token in `.riaf/daemon.json`. Wraps the SAME Riaf2Host the MCP server and the
 * extension use, so packs, instructions, the governor and the tool cache are shared, not duplicated.
 *
 * No `vscode` import: the extension starts it in-process (daemonManager.ts), the CLI runs it as
 * `node dist/daemon.mjs --workspace <repo>` (daemon/cli.ts). Static console assets are served from
 * `dist/console/`; every /api route answers JSON.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import {
	formatRouteLine, INTENT_TYPES, listInstructions, loadIntentFeedback, recordIntentFeedback, render, RENDER_TARGETS, ROUTING_TABLE,
	findRuleFiles, type IntentType, type RenderTarget,
} from '@bosch-mps/riaf-core';
import { DEFAULT_POLICY_YAML, parsePolicy } from '@bosch-mps/token-opt';
import type { Riaf2Host } from '../riaf2Host.js';
import { ADAPTER_IDS, adapterSettings, allAdapters, getAdapter, isEnabled, missingCredentials, type AdapterEnv, type AdapterId, type IntegrationsConfig } from '../integrations/index.js';
import { readAudit } from '../integrations/audit.js';
import { mcpJsonStatus } from '../claudeCodeStatus.js';
import { claudeLaunchCommand, writeInstructionForClaude } from '../instructionFlow.pure.js';

export interface DaemonIntegrations {
	config(): IntegrationsConfig;
	saveConfig(cfg: IntegrationsConfig): void;
	getSecret(key: string): Promise<string | undefined>;
	/** `undefined` deletes. Absent = credentials are read-only from this surface. */
	setSecret?(key: string, value: string | undefined): Promise<void>;
	fetch: AdapterEnv['fetch'];
	embed?: AdapterEnv['embed'];
}

export interface DaemonDeps {
	root: string;
	host: Riaf2Host;
	version: string;
	/** Absolute path of the built console (index.html + console.js). */
	consoleDir?: string;
	/** Where this daemon runs: inside VS Code or standalone. */
	surface: 'vscode' | 'cli';
	extensionPath?: string;
	integrations?: DaemonIntegrations;
	/** Optional richer status from the host (Doctor in VS Code). */
	extraStatus?: () => Promise<Record<string, unknown>>;
	/** Optional: run the Claude Code setup (VS Code only). */
	setupClaudeCode?: () => Promise<string[]>;
	reindex?: (force: boolean) => Promise<unknown>;
	log?: (m: string) => void;
}

export interface DaemonInfo { port: number; token: string; pid: number; root: string; url: string; surface: string; startedAt: number }

export const daemonInfoPath = (root: string): string => join(root, '.riaf', 'daemon.json');

export function readDaemonInfo(root: string): DaemonInfo | null {
	try { return JSON.parse(readFileSync(daemonInfoPath(root), 'utf8')) as DaemonInfo; } catch { return null; }
}

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const isTestPath = (p: string) => /\.(test|spec)\.[a-z]+$|Test\.(java|kt)$|_test\.(py|go|rs)$|(^|\/)test_[^/]+\.py$|(^|\/)(__tests__|tests?)\//i.test(p);

async function readBody(req: IncomingMessage, limit = 2_000_000): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const c of req) { size += (c as Buffer).length; if (size > limit) throw new HttpError(413, 'body too large'); chunks.push(c as Buffer); }
	if (!chunks.length) return {};
	try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { throw new HttpError(400, 'invalid JSON body'); }
}

export class RiafDaemon {
	private server: Server | null = null;
	readonly token = randomBytes(24).toString('hex');
	private readonly startedAt = Date.now();
	private info: DaemonInfo | null = null;
	private readonly log: (m: string) => void;

	constructor(private readonly d: DaemonDeps) { this.log = d.log ?? (() => { }); }

	get root(): string { return this.d.root; }
	get url(): string { return this.info?.url ?? ''; }

	async start(port = 7421, bindHost = '127.0.0.1'): Promise<DaemonInfo> {
		const server = createServer((req, res) => { this.handle(req, res).catch(e => this.fail(res, e)); });
		this.server = server;
		const listen = (p: number) => new Promise<void>((ok, err) => { server.once('error', err); server.listen(p, bindHost, () => { server.off('error', err); ok(); }); });
		try { await listen(port); } catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
			this.log(`port ${port} busy — picking a free one`);
			await listen(0);
		}
		const actual = (server.address() as AddressInfo).port;
		this.info = { port: actual, token: this.token, pid: process.pid, root: this.d.root, url: `http://${bindHost}:${actual}/`, surface: this.d.surface, startedAt: this.startedAt };
		mkdirSync(join(this.d.root, '.riaf'), { recursive: true });
		writeFileSync(daemonInfoPath(this.d.root), JSON.stringify(this.info, null, 2) + '\n', { mode: 0o600 });
		this.log(`console at ${this.info.url}`);
		return this.info;
	}

	async stop(): Promise<void> {
		const s = this.server; this.server = null;
		if (s) await new Promise<void>(res => s.close(() => res()));
		try { const cur = readDaemonInfo(this.d.root); if (cur?.pid === process.pid) writeFileSync(daemonInfoPath(this.d.root), '{}\n'); } catch { /* ignore */ }
	}

	private fail(res: ServerResponse, e: unknown): void {
		const status = e instanceof HttpError ? e.status : 500;
		if (status >= 500) this.log(`error: ${(e as Error).stack ?? String(e)}`);
		this.json(res, { error: (e as Error).message ?? String(e) }, status);
	}

	private json(res: ServerResponse, body: unknown, status = 200): void {
		res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
		res.end(JSON.stringify(body));
	}

	private authorised(req: IncomingMessage): boolean {
		const h = req.headers.authorization ?? '';
		if (h === `Bearer ${this.token}`) return true;
		const url = new URL(req.url ?? '/', 'http://x');
		return url.searchParams.get('token') === this.token;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (!url.pathname.startsWith('/api/')) return this.serveStatic(url.pathname, res);
		// Same-origin only: a cross-origin page cannot read the answer anyway, but refuse early.
		const origin = req.headers.origin;
		if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) throw new HttpError(403, 'cross-origin request refused');
		if (!this.authorised(req)) throw new HttpError(401, 'missing or wrong token (see .riaf/daemon.json)');
		const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {};
		const out = await this.route(req.method ?? 'GET', url, body);
		this.json(res, out ?? {});
	}

	private serveStatic(pathname: string, res: ServerResponse): void {
		const dir = this.d.consoleDir;
		if (!dir || !existsSync(dir)) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><title>riafd</title><body style="font-family:system-ui;padding:24px"><h2>riafd is running</h2><p>Console assets not built (run <code>npm run build -w packages/extension</code>). API is live at <code>/api/status</code>.</p>`); return; }
		const rel = pathname === '/' || !extname(pathname) ? 'index.html' : pathname.slice(1);
		const file = resolve(dir, normalize(rel));
		if (!file.startsWith(resolve(dir) + sep) && file !== resolve(dir, 'index.html')) { res.writeHead(403); res.end(); return; }
		if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
		if (rel === 'index.html') {
			// Same-origin page: hand it the token so it never has to read .riaf/daemon.json.
			const html = readFileSync(file, 'utf8').replace('__RIAF_TOKEN__', this.token).replace('__RIAF_ROOT__', this.d.root.replace(/\\/g, '\\\\')).replace('__RIAF_SURFACE__', this.d.surface);
			res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
			res.end(html);
			return;
		}
		res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
		res.end(readFileSync(file));
	}

	/* ───────────────────────────── routes ───────────────────────────── */

	private async route(method: string, url: URL, body: Record<string, unknown>): Promise<unknown> {
		const p = url.pathname.slice(4); // strip /api
		const q = (k: string) => url.searchParams.get(k) ?? undefined;
		const host = this.d.host, riaf = host.riaf, root = this.d.root;
		const str = (k: string): string | undefined => typeof body[k] === 'string' ? body[k] as string : undefined;
		const num = (k: string): number | undefined => typeof body[k] === 'number' ? body[k] as number : undefined;

		switch (`${method} ${p}`) {
			case 'GET /status': return this.status();
			case 'POST /reindex': if (this.d.reindex) return { result: await this.d.reindex(body.force === true) }; return { result: await riaf.indexRepo({ force: body.force === true }) };

			/* repository */
			case 'GET /repo/tree': return this.tree();
			case 'GET /repo/file': {
				const path = q('path'); if (!path) throw new HttpError(400, 'path required');
				const rel = host.relative(path);
				const [expand, content] = await Promise.all([riaf.expand(rel, 1), riaf.lookup({ path: rel })]);
				const history = riaf.historyCard(rel);
				return { path: rel, expand, history: history?.card ?? null, historyText: history?.text ?? '', content: content.hit ? content.content.slice(0, 200_000) : '', lines: content.hit ? content.content.split('\n').length : 0, summary: riaf.summaries.get('file', rel) ?? '' };
			}
			case 'GET /repo/search': {
				const query = q('q'); if (!query) throw new HttpError(400, 'q required');
				const mode = (q('mode') ?? 'lexical') as 'hybrid' | 'lexical' | 'structural';
				const hits = await riaf.search(query, { mode: riaf.index.embeddingsEnabled || mode !== 'hybrid' ? mode : 'lexical', limit: Number(q('limit') ?? 20), pathPrefix: q('scope') });
				return { mode, hits };
			}
			case 'GET /repo/graph': {
				const g = await riaf.index.getGraph();
				return { nodes: g.nodes.slice(0, 2_000), edges: (g as { edges?: unknown[] }).edges?.slice(0, 6_000) ?? [] };
			}
			case 'GET /repo/report': return { markdown: await riaf.index.getIndexingReport() };
			case 'GET /repo/hotspots': return { hotspots: riaf.history?.hotspots(20, q('scope') ?? '') ?? [] };

			/* pack studio */
			case 'POST /classify': {
				const request = str('request'); if (!request) throw new HttpError(400, 'request required');
				const r = await host.route(request, { activeFile: str('activeFile'), command: str('command') });
				return { ...r, line: formatRouteLine(r), table: ROUTING_TABLE[r.type] };
			}
			case 'POST /instruction': {
				const request = str('request'); if (!request) throw new HttpError(400, 'request required');
				const findings = Array.isArray(body.findings) ? (body.findings as unknown[]).map(String) : undefined;
				const { route, pack, instruction, path } = await host.instruct(request, { activeFile: str('activeFile'), command: str('command'), budget: num('budget'), findings, fresh: body.fresh === true, host: (str('host') as 'claude' | 'copilot' | 'generic' | undefined) ?? 'claude' });
				return { route: { ...route, line: formatRouteLine(route, { items: pack.items.length, tokens: pack.budget.used_tokens }) }, pack: packMeta(pack), instruction, path };
			}
			case 'GET /instruction/current': return { instruction: host.currentInstruction(), pack: riaf.currentPack() ? packMeta(riaf.currentPack()!) : null };
			case 'GET /instructions': return { instructions: listInstructions(root, 100) };
			case 'GET /instruction': {
				const id = q('id'); if (!id || !/^[0-9a-f]{8}$/.test(id)) throw new HttpError(400, 'id required');
				const f = join(root, '.claude', 'riaf', 'instructions', `${id}.md`);
				if (!existsSync(f)) throw new HttpError(404, 'no such instruction');
				return { id, markdown: readFileSync(f, 'utf8') };
			}
			case 'POST /pack/render': {
				const format = (str('format') ?? 'claude') as RenderTarget;
				if (!RENDER_TARGETS.includes(format)) throw new HttpError(400, `format must be one of ${RENDER_TARGETS.join(', ')}`);
				const pack = riaf.currentPack(str('scope'));
				if (!pack) throw new HttpError(404, 'no pack compiled yet');
				return { format, text: render(pack, format, { budget: num('budget') }) };
			}
			case 'POST /feedback': {
				const request = str('request'), predicted = str('predicted') as IntentType, corrected = str('corrected') as IntentType;
				if (!request || !INTENT_TYPES.includes(corrected) || !INTENT_TYPES.includes(predicted)) throw new HttpError(400, 'request, predicted, corrected required');
				recordIntentFeedback(root, { request, predicted, corrected });
				return { ok: true, count: loadIntentFeedback(root).length };
			}
			case 'GET /feedback': return { feedback: loadIntentFeedback(root).slice(-100).reverse() };
			case 'POST /send-to-claude': {
				const instr = host.currentInstruction(); if (!instr) throw new HttpError(404, 'no instruction yet');
				const written = writeInstructionForClaude(root, instr, { pluginDir: this.d.extensionPath ? join(this.d.extensionPath, 'plugin') : undefined });
				return { written: written.map(w => host.relative(w)), command: claudeLaunchCommand(root), headless: claudeLaunchCommand(root, { headless: true }) };
			}

			/* governance */
			case 'GET /policy': { const f = join(root, '.riaf', 'policy.yaml'); return { path: '.riaf/policy.yaml', exists: existsSync(f), yaml: existsSync(f) ? readFileSync(f, 'utf8') : DEFAULT_POLICY_YAML, parsed: host.currentPolicy }; }
			case 'PUT /policy': {
				const yaml = str('yaml'); if (yaml === undefined) throw new HttpError(400, 'yaml required');
				parsePolicy(yaml); // throws on garbage
				mkdirSync(join(root, '.riaf'), { recursive: true });
				writeFileSync(join(root, '.riaf', 'policy.yaml'), yaml.endsWith('\n') ? yaml : yaml + '\n');
				return { ok: true, parsed: host.reloadPolicy() };
			}
			case 'GET /rules': {
				const files = findRuleFiles(root).map(rel => ({ path: rel, text: safeRead(join(root, rel)) }));
				return { riafrules: safeRead(join(root, '.riafrules')), files };
			}
			case 'PUT /rules': {
				const path = str('path') ?? '.riafrules';
				if (!/^(\.riafrules|AGENTS\.md|\.riaf\/AGENTS\.md|\.riaf\/rules\/[\w.-]+\.(md|mdc|txt))$/.test(path)) throw new HttpError(400, 'only .riafrules, AGENTS.md and .riaf/rules/*.md can be written');
				const text = str('text') ?? '';
				mkdirSync(join(root, path, '..'), { recursive: true });
				writeFileSync(join(root, path), text);
				return { ok: true };
			}
			case 'GET /hooks': {
				const settings = safeJson(join(root, '.claude', 'settings.json'));
				const riafHooks = safeJson(join(root, '.riaf', 'hooks.json'));
				return { claude: (settings as { hooks?: unknown }).hooks ?? {}, riaf: riafHooks, governHookPresent: existsSync(join(root, '.claude', 'hooks', 'riaf-govern.mjs')) };
			}
			case 'GET /claude-setup': return this.claudeSetupStatus();
			case 'POST /claude-setup': { if (!this.d.setupClaudeCode) throw new HttpError(501, 'Claude Code setup runs from VS Code (RIAF: Set up Claude Code) or `riaf init --host claude`'); return { written: await this.d.setupClaudeCode() }; }

			/* sessions */
			case 'GET /sessions': return { sessions: host.sessions(Number(q('limit') ?? 100)), status: host.statusText() };
			case 'GET /session': { const id = q('id'); if (!id) throw new HttpError(400, 'id required'); return { id, events: host.sessionEvents(id, Number(q('limit') ?? 500)), metrics: host.sessions(500).find(s => s.sessionId === id) ?? null }; }
			case 'GET /audit': return { entries: readAudit(root, Number(q('limit') ?? 100)) };

			/* adapters */
			case 'GET /adapters': return this.adapters();
			case 'PUT /adapter': {
				const i = this.integrations();
				const id = str('id') as AdapterId; if (!ADAPTER_IDS.includes(id)) throw new HttpError(400, 'unknown adapter');
				const cfg = i.config();
				const settings = (body.settings && typeof body.settings === 'object' ? body.settings : {}) as Record<string, unknown>;
				cfg[id] = { ...(cfg[id] ?? {}), ...settings };
				i.saveConfig(cfg);
				return { ok: true, adapter: (await this.adapters()).adapters.find(a => a.id === id) };
			}
			case 'PUT /adapter/credentials': {
				const i = this.integrations();
				if (!i.setSecret) throw new HttpError(501, 'credentials are managed in VS Code (RIAF: Set Integration Credentials) on this surface');
				const id = str('id') as AdapterId; const adapter = getAdapter(id); if (!adapter) throw new HttpError(400, 'unknown adapter');
				const values = (body.values && typeof body.values === 'object' ? body.values : {}) as Record<string, unknown>;
				for (const f of adapter.credentials) { if (f.key in values) await i.setSecret(`riaf.integration.${id}.${f.key}`, typeof values[f.key] === 'string' && values[f.key] ? values[f.key] as string : undefined); }
				return { ok: true, missing: await missingCredentials(adapter, i.getSecret) };
			}
			case 'POST /adapter/health': {
				const i = this.integrations();
				const id = str('id') as AdapterId; const adapter = getAdapter(id); if (!adapter) throw new HttpError(400, 'unknown adapter');
				const t0 = Date.now();
				try {
					const h = await adapter.health({ fetch: i.fetch, getSecret: i.getSecret, settings: adapterSettings(i.config(), adapter), workspaceRoot: root, embed: i.embed, log: this.log });
					return { ...h, latencyMs: h.latencyMs ?? Date.now() - t0 };
				} catch (e) { return { ok: false, message: (e as Error).message, latencyMs: Date.now() - t0 }; }
			}
		}
		throw new HttpError(404, `no route ${method} ${p}`);
	}

	private integrations(): DaemonIntegrations {
		if (!this.d.integrations) throw new HttpError(501, 'integrations are not available on this surface');
		return this.d.integrations;
	}

	private async status(): Promise<Record<string, unknown>> {
		const host = this.d.host, riaf = host.riaf;
		const st = riaf.index.getStatus();
		const head = await riaf.head().catch(() => null);
		let branch = '';
		try { branch = execFileSync('git', ['branch', '--show-current'], { cwd: this.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a git repo */ }
		const instr = host.currentInstruction();
		const sessions = host.sessions(500);
		const sum = (k: string) => sessions.reduce((s, r) => s + (Number((r.counters as unknown as Record<string, unknown>)[k]) || 0), 0);
		const week = Date.now() - 7 * 86_400_000;
		const recent = sessions.filter(s => s.updatedAt >= week);
		const sumRecent = (k: string) => recent.reduce((s, r) => s + (Number((r.counters as unknown as Record<string, unknown>)[k]) || 0), 0);
		return {
			daemon: { ...this.info, token: undefined, version: this.d.version, uptimeMs: Date.now() - this.startedAt },
			repo: { root: this.root, head, branch },
			index: { ...st, embeddings: riaf.index.embeddingsEnabled, dbPath: (riaf.index as unknown as { dbPath?: string }).dbPath },
			history: riaf.history ? { commits: riaf.history.commitCount(), hotspots: riaf.history.hotspots(5) } : null,
			instruction: instr ? { id: instr.instruction_id, type: instr.intent.type, confidence: instr.intent.confidence, generated_at: instr.generated_at, request: instr.request.slice(0, 200), tokens: instr.tokens, planGate: instr.route.planGate } : null,
			instructions: listInstructions(this.root, 8),
			governance: { sessions: sessions.length, proposed: sum('proposed'), served: sum('served'), blocked: sum('blocked'), tokensServed: sum('tokensServed'), tokensExecuted: sum('tokensExecuted'), week: { sessions: recent.length, proposed: sumRecent('proposed'), served: sumRecent('served'), blocked: sumRecent('blocked'), tokensServed: sumRecent('tokensServed') }, policyPhases: Object.keys(host.currentPolicy.phases) },
			claude: this.claudeSetupStatus(),
			feedback: loadIntentFeedback(this.root).length,
			adapters: this.d.integrations ? ADAPTER_IDS.map(id => ({ id, enabled: isEnabled(this.d.integrations!.config(), id) })) : [],
			...(this.d.extraStatus ? await this.d.extraStatus().catch(() => ({})) : {}),
		};
	}

	private claudeSetupStatus(): Record<string, unknown> {
		const root = this.root;
		const mcp = mcpJsonStatus(root, this.d.extensionPath ?? '');
		const commandsDir = join(root, '.claude', 'commands');
		const commands = existsSync(commandsDir) ? readdirSync(commandsDir).filter(f => f.startsWith('riaf-')) : [];
		const claudeMd = safeRead(join(root, 'CLAUDE.md'));
		return {
			mcpJson: mcp.present, mcpStale: mcp.stale ?? null, mcpEntry: mcp.entry ?? null,
			commands, governHook: existsSync(join(root, '.claude', 'hooks', 'riaf-govern.mjs')), gateHook: existsSync(join(root, '.claude', 'hooks', 'gate.mjs')),
			settingsJson: existsSync(join(root, '.claude', 'settings.json')), policy: existsSync(join(root, '.riaf', 'policy.yaml')),
			claudeMdRules: claudeMd.includes('riaf:begin') || claudeMd.includes('<!-- riaf:rules -->'), claudeMdInstruction: claudeMd.includes('riaf:instruction:begin'),
			instructionCurrent: existsSync(join(root, '.claude', 'riaf', 'instructions', 'current.md')),
		};
	}

	private async tree(): Promise<{ files: TreeFile[]; total: number }> {
		const riaf = this.d.host.riaf;
		const metas = await riaf.index.db.getFileMetadata(riaf.index.workspaceHash);
		const nodes = new Map<string, { importedBy: number; imports: number }>();
		try { for (const n of (await riaf.index.getGraph()).nodes) nodes.set(n.filePath, { importedBy: n.importedByCount, imports: (n as { importsCount?: number }).importsCount ?? 0 }); } catch { /* no graph */ }
		const churn = new Map<string, { last: number; hot: number }>();
		try { for (const r of riaf.store.raw.all<{ path: string; last_ts: number; hotspot: number }>('SELECT path, last_ts, hotspot FROM file_churn')) churn.set(r.path, { last: r.last_ts, hot: r.hotspot }); } catch { /* no history */ }
		const hotThreshold = riaf.history?.hotspotThreshold() ?? Infinity;
		const symbolCounts = new Map<string, number>();
		try { for (const r of riaf.store.raw.all<{ file_path: string; n: number }>('SELECT file_path, COUNT(*) n FROM symbols GROUP BY file_path')) symbolCounts.set(r.file_path, r.n); } catch { /* table name differs */ }
		const files: TreeFile[] = metas.map(m => {
			const path = m.filePath;
			const g = nodes.get(path); const c = churn.get(path);
			return {
				path, lang: m.language ?? extname(path).slice(1), sizeBytes: m.sizeBytes,
				symbols: symbolCounts.get(path) ?? 0, importedBy: g?.importedBy ?? 0, imports: g?.imports ?? 0,
				isTest: isTestPath(path), hot: !!c && c.hot >= hotThreshold, lastChanged: c?.last ?? m.lastModified ?? null,
			};
		}).sort((a, b) => a.path.localeCompare(b.path));
		return { files, total: files.length };
	}

	private async adapters(): Promise<{ adapters: AdapterView[]; credentialsEditable: boolean; audit: unknown[] }> {
		const i = this.integrations();
		const cfg = i.config();
		const adapters: AdapterView[] = [];
		for (const a of allAdapters()) {
			const missing = await missingCredentials(a, i.getSecret);
			adapters.push({
				id: a.id, displayName: a.displayName, enabled: isEnabled(cfg, a.id), settings: adapterSettings(cfg, a), settingsSchema: a.settingsSchema,
				credentials: a.credentials.map(c => ({ ...c, present: !missing.includes(c.key) })),
				tools: a.tools.map(t => ({ name: t.name, kind: t.kind, label: t.label, description: t.description })),
			});
		}
		return { adapters, credentialsEditable: !!i.setSecret, audit: readAudit(this.root, 30) };
	}
}

export interface TreeFile { path: string; lang: string; sizeBytes: number; symbols: number; importedBy: number; imports: number; isTest: boolean; hot: boolean; lastChanged: number | null }
export interface AdapterView {
	id: AdapterId; displayName: string; enabled: boolean; settings: Record<string, unknown>;
	settingsSchema: Record<string, { type: string; description: string; default?: unknown; enum?: string[] }>;
	credentials: { key: string; label: string; secret: boolean; hint?: string; present: boolean }[];
	tools: { name: string; kind: 'read' | 'write'; label: string; description: string }[];
}

function packMeta(pack: import('@bosch-mps/riaf-core').ContextPack) {
	return {
		pack_id: pack.pack_id, head: pack.repo.head, branch: pack.repo.branch, budget: pack.budget, intent: pack.intent, plan_skeleton: pack.plan_skeleton, verification: pack.verification,
		history: pack.history, provenance: pack.provenance, conventions: pack.conventions, architecture: pack.architecture,
		items: pack.items.map(it => ({ kind: it.kind, path: it.path, range: it.range, form: it.form, score: Math.round(it.score * 1000) / 1000, tokens: it.tokens, why: it.why, preview: it.content.slice(0, 400) })),
	};
}

const safeRead = (p: string): string => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const safeJson = (p: string): Record<string, unknown> => { try { return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { return {}; } };
export const fileMtime = (p: string): number => { try { return statSync(p).mtimeMs; } catch { return 0; } };
