#!/usr/bin/env node
/**
 * RIAF MCP server (stdio) — gives Claude Code (or any MCP client) the same retrieval tools the
 * VS Code extension exposes to Copilot. Shares the SQLite index file with the extension, so one
 * index serves both. Read-only: editing stays with the client's own tools.
 *
 *   node dist/mcp.mjs --workspace /path/to/repo [--db /path/to/index.sqlite] [--reindex] [--no-govern] [--no-guard]
 *
 * RIAF 2.0: also serves riaf_compile / riaf_lookup / riaf_expand / riaf_history / riaf_search, the
 * riaf://pack/current resources, and a local governor endpoint for the Claude Code hooks (.riaf/governor.json).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { RiafIndex, Riaf2, setSqliteModuleLoader, setTreeSitterWasmDir } from '@bosch-mps/riaf-core';
import { Riaf2Host } from './riaf2Host.js';
import { recordToolCall, toolStatsPathFor } from './toolStats.js';
import { FileLedger, nextReadySubtasks, renderLedger, verifySubtask } from '@bosch-mps/riaf-engine';
import { executeOrgTool, executeSearchTool, ORG_TOOL_SPECS, SEARCH_TOOL_SPECS } from './tools/orgTools.js';
import { executeGraphTool, GRAPH_TOOL_SPECS } from './tools/graphTools.js';
import { ADAPTER_IDS, allAdapters, enabledIntegrationTools, executeIntegrationTool, isEnabled, adapterSettings, adapterForTool } from './integrations/index.js';
import { mcpSecretGetter, readIntegrationsConfig } from './integrations/mcpConfig.js';
import { appendAudit } from './integrations/audit.js';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const workspaceRoot = resolve(flag('workspace') ?? process.cwd());
const dbPath = flag('db') ?? join(workspaceRoot, '.riaf', 'index.sqlite');
const log = (m: string) => process.stderr.write(`[riaf-mcp] ${m}\n`);

// sqlite-wasm lives next to this bundle (dist/vendor) or in node_modules when run from source.
const here = dirname(fileURLToPath(import.meta.url));
const wasmEntry = [join(here, 'vendor', 'sqlite-wasm', 'node.mjs'), join(here, '..', '..', '..', 'node_modules', '@sqlite.org', 'sqlite-wasm', 'dist', 'node.mjs')].find(existsSync);
if (wasmEntry) { setSqliteModuleLoader(() => import(pathToFileURL(wasmEntry).href)); }
const tsDir = [join(here, 'vendor', 'tree-sitter'), join(here, '..', '..', '..', 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')].find(d => existsSync(join(d, 'tree-sitter.wasm')));
if (tsDir) { setTreeSitterWasmDir(tsDir); }

const index = await RiafIndex.open({ workspaceRoot, dbPath, log });
if (!index.getStatus().indexed || args.includes('--reindex')) {
	log(`indexing ${workspaceRoot}…`);
	await index.reindex({ onProgress: p => p.done === p.total && log(`${p.phase} done`) });
}
index.startWatching();

// RIAF 2.0: history mining, summaries, pack compiler and the tool-call governor share this index.
const riaf2 = Riaf2.fromIndex(index, { log, llmSummaries: false });
const host = new Riaf2Host(riaf2, { host: 'claude-code', log, governEnabled: !args.includes('--no-guard') });
void (async () => {
	try {
		const mined = await riaf2.history?.mine();
		const sums = await riaf2.summaries.build();
		log(`history: ${mined?.totalCommits ?? 0} commits (${mined?.newCommits ?? 0} new); summaries: ${sums.regenerated} regenerated`);
	} catch (e) { log(`history/summaries skipped: ${String(e)}`); }
})();
if (!args.includes('--no-govern')) {
	host.startGovernor().then(ep => log(`governor endpoint ${ep}`), e => log(`governor endpoint not started: ${String(e)}`));
}

const server = new McpServer({ name: 'riaf', version: '0.4.0' });
const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

// "Tools served" metrics for the Usage tab: wrap registration so every call is counted (best-effort, never fails the call).
{
	const statsPath = toolStatsPathFor(dbPath);
	const original = server.tool.bind(server);
	(server as unknown as { tool: unknown }).tool = (name: string, ...rest: unknown[]) => {
		const idx = rest.findIndex(x => typeof x === 'function');
		if (idx >= 0) {
			const handler = rest[idx] as (...a: unknown[]) => Promise<{ content?: { text?: string }[]; isError?: boolean }>;
			rest[idx] = async (...a: unknown[]) => {
				let res: Awaited<ReturnType<typeof handler>> | undefined; let ok = true;
				try { res = await handler(...a); ok = !res?.isError; }
				catch (e) { ok = false; try { recordToolCall({ statsPath, workspaceRoot, consumer: 'claude-code', toolName: name, args: (a[0] as Record<string, unknown>) ?? {}, result: String((e as Error).message ?? e), ok }); } catch { /* ignore */ } throw e; }
				const out = res?.content?.map(c => c.text ?? '').join('') ?? '';
				try { recordToolCall({ statsPath, workspaceRoot, consumer: 'claude-code', toolName: name, args: (a[0] as Record<string, unknown>) ?? {}, result: out, ok }); } catch { /* ignore */ }
				return res;
			};
		}
		return (original as (...x: unknown[]) => unknown)(name, ...rest);
	};
}

server.tool('search_codebase',
	'Hybrid BM25 + semantic search over the indexed repository. Returns ranked code chunks with path and line range. Use this before reading files blindly.',
	{ query: z.string(), limit: z.number().optional(), pathPrefix: z.string().optional() },
	async ({ query, limit, pathPrefix }) => {
		const hits = await index.searchHybrid(query, { limit: limit ?? 8, filePathPrefix: pathPrefix });
		return text(hits.length ? hits.map(h => `### ${h.filePath}:${h.startLine}-${h.endLine} (score ${h.score.toFixed(3)})\n${h.content}`).join('\n\n') : 'No matches.');
	});

server.tool('search_symbols', 'Find exported symbols by (partial) name.', { query: z.string(), limit: z.number().optional() },
	async ({ query, limit }) => {
		const syms = await index.searchSymbols(query, limit ?? 15) as Array<{ name: string; kind?: string; filePath: string; line?: number; startLine?: number }>;
		return text(syms.length ? syms.map(s => `${s.kind ?? 'symbol'} ${s.name} — ${s.filePath}:${s.line ?? s.startLine ?? '?'}`).join('\n') : 'No symbols found.');
	});

server.tool('get_context_profile', 'Imports, importers and covering tests for a file, plus the workspace profile (languages, frameworks, build/test commands).',
	{ filePath: z.string().optional() },
	async ({ filePath }) => {
		const p = await index.getContextualProfile(filePath);
		const lines = [p.profileText];
		if (p.activeFile) { lines.push(`\nRelated files for ${p.activeFile}:`, ...p.relatedFiles.map(f => `- ${f}`), 'Tests:', ...(p.tests.length ? p.tests.map(t => `- ${t}`) : ['- (none)'])); }
		if (p.neighborhood) { lines.push('', p.neighborhood); }
		return text(lines.join('\n'));
	});

server.tool('get_file_outline', 'Symbols defined in a file with line numbers.', { filePath: z.string() },
	async ({ filePath }) => {
		const o = await (index as unknown as { getFileOutline?: (p: string) => Promise<unknown> }).getFileOutline?.(filePath);
		const items = Array.isArray(o) ? o : (o as { symbols?: unknown[] } | undefined)?.symbols ?? [];
		return text(items.length ? (items as Array<{ line?: number; startLine?: number; kind?: string; name: string }>).map(s => `${s.line ?? s.startLine ?? '?'}: ${s.kind ?? ''} ${s.name}`).join('\n') : 'No symbols indexed for this file.');
	});

server.tool('get_import_graph', 'Files imported by / importing a file (Universal Context Graph).', { filePath: z.string() },
	async ({ filePath }) => text(JSON.stringify(await (index as unknown as { getImportGraph: (p: string) => Promise<unknown> }).getImportGraph(filePath), null, 1)));

server.tool('get_indexing_report', 'Markdown report of what is indexed (languages, frameworks, commands, graph metrics).', {},
	async () => text(await index.getIndexingReport()));

server.tool('reindex', 'Rebuild the index (use after large refactors or branch switches).', { force: z.boolean().optional() },
	async ({ force }) => text(JSON.stringify(await index.reindex({ force: force ?? true }))));

// ── RIAF 2.0 tools: compile → lookup / expand / history / search; governance status ─────────────
server.tool('riaf_compile',
	'Compile a Context Pack for a task: the ranked, token-budgeted files, symbols, tests, history and conventions needed, each with why it is included. Call once at the start of a task (or with stage "verify" + appendOutput after a failing run; or plan=[steps] to record your plan for sub-agents). Files listed under "Already in context" need no further reads.',
	{
		request: z.string().optional().describe('The task in natural language (omit with plan= to update the current pack)'),
		budget: z.number().optional().describe('Token budget, default 24000'),
		scope: z.string().optional().describe('Path prefix for a sub-agent child pack'),
		stage: z.enum(['explore', 'plan', 'implement', 'verify']).optional(),
		appendOutput: z.string().optional().describe('Stage output (e.g. failing tests) to append to the previous pack'),
		plan: z.array(z.string()).optional().describe('Plan steps to store in the current pack'),
		format: z.enum(['claude', 'markdown', 'json', 'copilot', 'openai', 'gemini', 'agents-md']).optional(),
		fresh: z.boolean().optional(),
	},
	async ({ request, budget, scope, stage, appendOutput, plan, format, fresh }) => {
		if (plan?.length && !request) {
			const p = host.setPlan(plan);
			return text(p ? `Plan recorded in pack ${p.pack_id.slice(0, 8)} (${p.plan_skeleton.length} steps). Sub-agents reading riaf://pack/current inherit it.` : 'No current pack — call riaf_compile with a request first.');
		}
		if (!request) { return { ...text('riaf_compile needs a request (or plan=[…] to update the current pack).'), isError: true }; }
		const { pack, text: out } = await host.compile(request, { budget, scope, stage, appendOutput, fresh, format });
		if (plan?.length) { host.setPlan(plan); }
		log(`compiled pack ${pack.pack_id.slice(0, 8)}: ${pack.items.length} items, ${pack.budget.used_tokens}/${pack.budget.max_tokens} tokens`);
		return text(out);
	});

server.tool('riaf_lookup',
	'Answer a read from the index before using Read/Grep/LS: a file (optionally a line range), a symbol definition, a directory listing, or an indexed search. Returns the content or a miss with the best indexed alternatives.',
	{ path: z.string().optional(), startLine: z.number().optional(), endLine: z.number().optional(), symbol: z.string().optional(), dir: z.string().optional(), query: z.string().optional(), limit: z.number().optional() },
	async ({ path, startLine, endLine, symbol, dir, query, limit }) => {
		const r = await riaf2.lookup({ path, range: path && startLine ? [startLine, endLine ?? startLine + 80] : undefined, symbol, dir, query, limit });
		const head = r.hit ? `[RIAF ${r.kind}${r.path ? ` ${r.path}` : ''}${r.blob ? ` blob ${r.blob.slice(0, 8)}` : ''}]` : '[RIAF miss]';
		return text(`${head}\n${r.content}${r.alternatives?.length ? `\nIndexed alternatives:\n${r.alternatives.map(a => `- ${a}`).join('\n')}` : ''}`);
	});

server.tool('riaf_expand',
	'Structural + history neighbourhood of a file or symbol in one call (outline, imports, importers, tests, callers, callees, co-changing files). Use instead of walking directories. node = "path" or "path#Symbol".',
	{ node: z.string(), hops: z.number().optional() },
	async ({ node, hops }) => text((await riaf2.expand(node, hops ?? 1)).text));

server.tool('riaf_history',
	'Git-history intelligence: a history card for a file (creation, intents, recent changes, owners as roles, hot-spot flag, co-change partners); or commits since a ref/date under a path; or the hot spots.',
	{ path: z.string().optional(), since: z.string().optional().describe('Tag, branch, sha or ISO date'), pathPrefix: z.string().optional(), hotspots: z.boolean().optional() },
	async ({ path, since, pathPrefix, hotspots }) => {
		if (!riaf2.history) { return text('History is disabled.'); }
		await riaf2.history.mine().catch(() => undefined);
		if (since) {
			const rows = await riaf2.history.changedSince(since, pathPrefix ?? path ?? '');
			return text(rows.length ? rows.map(c => `${new Date(c.ts).toISOString().slice(0, 10)} ${c.sha.slice(0, 8)} [${c.intent}] ${c.why}\n  ${c.files.slice(0, 8).join(', ')}`).join('\n') : `No commits since ${since}.`);
		}
		if (hotspots || !path) {
			return text(riaf2.history.hotspots(15, pathPrefix ?? '').map(h => `${h.path}: score ${h.score}, ${h.commits365} commits/12 mo, fix ratio ${Math.round(h.fixRatio * 100)}%`).join('\n') || 'No history mined.');
		}
		return text(riaf2.historyCard(path)?.text ?? 'No history for this path.');
	});

server.tool('riaf_search',
	'Search the index: mode "hybrid" (BM25 + embeddings), "lexical" (BM25 only) or "structural" (symbol definitions).',
	{ query: z.string(), mode: z.enum(['hybrid', 'lexical', 'structural']).optional(), limit: z.number().optional(), pathPrefix: z.string().optional() },
	async ({ query, mode, limit, pathPrefix }) => {
		const hits = await riaf2.search(query, { mode, limit, pathPrefix }) as Array<Record<string, unknown>>;
		if (!hits.length) { return text('No matches.'); }
		return text(hits.map(h => 'signature' in h ? `${h.kind} ${h.name} — ${h.filePath}:${h.startLine}\n  ${String(h.signature).replace(/\s+/g, ' ').slice(0, 160)}` : `### ${h.filePath}:${h.startLine}-${h.endLine}\n${h.content}`).join('\n\n'));
	});

server.tool('riaf_governor_status', 'Tool-call governance metrics: calls proposed / served from index / executed / blocked, tokens saved, cache hit rate, prefetch precision.', {},
	async () => text(host.statusText()));

server.registerResource('riaf-pack-current', 'riaf://pack/current', { title: 'Current RIAF Context Pack', mimeType: 'text/markdown' },
	async uri => {
		const pack = riaf2.currentPack();
		return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: pack ? riaf2.render(pack, 'claude') : 'No pack compiled yet — call riaf_compile.' }] };
	});
server.registerResource('riaf-pack-scoped', new ResourceTemplate('riaf://pack/current{?scope}', { list: undefined }), { title: 'Child pack for a path scope (sub-agents)', mimeType: 'text/markdown' },
	async (uri, vars) => {
		const scope = Array.isArray(vars.scope) ? vars.scope[0] : vars.scope;
		const pack = riaf2.currentPack(scope ? decodeURIComponent(scope) : undefined);
		return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: pack ? riaf2.render(pack, 'claude') : 'No pack compiled yet — call riaf_compile.' }] };
	});
server.registerResource('riaf-conventions', 'riaf://repo/conventions', { title: 'Repository conventions', mimeType: 'text/markdown' },
	async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await riaf2.conventionsText() }] }));
server.registerResource('riaf-architecture', 'riaf://repo/architecture', { title: 'Repository architecture', mimeType: 'text/markdown' },
	async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await riaf2.architectureText() }] }));
server.registerPrompt('riaf-briefing', { title: 'RIAF briefing', description: 'Compile a Context Pack for a task and brief the model with it.', argsSchema: { task: z.string(), budget: z.string().optional() } },
	async ({ task, budget }) => {
		const { text: out } = await host.compile(task, { budget: budget ? Number(budget) || undefined : undefined });
		return { messages: [{ role: 'user', content: { type: 'text', text: `${out}\n\n---\nTask: ${task}\nStart from the pack above; use riaf_lookup / riaf_expand before reading other files.` } }] };
	});

// Search + org-index + git tools: same specs and formatting as the VS Code agent (tools/orgTools.ts).
const zodFromJsonSchema = (schema: Record<string, unknown>): Record<string, z.ZodTypeAny> => {
	const props = (schema.properties ?? {}) as Record<string, { type?: string; enum?: string[] }>;
	const required = new Set((schema.required ?? []) as string[]);
	const out: Record<string, z.ZodTypeAny> = {};
	for (const [k, p] of Object.entries(props)) {
		let t: z.ZodTypeAny = p.enum ? z.enum(p.enum as [string, ...string[]]) : p.type === 'number' ? z.number() : p.type === 'boolean' ? z.boolean() : z.string();
		if (!required.has(k)) { t = t.optional(); }
		out[k] = t;
	}
	return out;
};
for (const spec of SEARCH_TOOL_SPECS) {
	server.tool(spec.name, spec.description, zodFromJsonSchema(spec.inputSchema),
		async (args: Record<string, unknown>) => text((await executeSearchTool(index, spec.name, args)) ?? `unknown tool ${spec.name}`));
}
for (const spec of GRAPH_TOOL_SPECS) {
	server.tool(spec.name, spec.description, zodFromJsonSchema(spec.inputSchema),
		async (args: Record<string, unknown>) => text((await executeGraphTool(index, spec.name, args)) ?? `unknown tool ${spec.name}`));
}
for (const spec of ORG_TOOL_SPECS) {
	server.tool(spec.name, spec.description, zodFromJsonSchema(spec.inputSchema),
		async (args: Record<string, unknown>) => text((await executeOrgTool(index, spec.name, args)) ?? `unknown tool ${spec.name}`));
}

// Enterprise integrations (Jira, Confluence, GitLab, knowledge stores): enabled flags and base URLs come from
// .riaf/integrations.json (written by the extension), credentials from RIAF_INTEGRATION_* env vars or ~/.riaf/credentials.json.
{
	const cfg = readIntegrationsConfig(workspaceRoot);
	const getSecret = mcpSecretGetter();
	const proxyFetch = await integrationFetch();
	const envFor = async (adapter: ReturnType<typeof allAdapters>[number]) => ({ fetch: proxyFetch, getSecret, settings: adapterSettings(cfg, adapter), workspaceRoot, log });
	const tools = enabledIntegrationTools(cfg);
	for (const spec of tools) {
		server.tool(spec.name, `${spec.kind === 'write' ? '[writes to ' + adapterForTool(spec.name)!.displayName + '] ' : ''}${spec.description}`, zodFromJsonSchema(spec.inputSchema),
			async (a: Record<string, unknown>) => {
				const r = await executeIntegrationTool(spec.name, a, cfg, envFor);
				if (spec.kind === 'write') { appendAudit(workspaceRoot, { consumer: 'claude-code', adapter: r.adapter ?? '?', tool: spec.name, kind: 'write', args: a, ok: r.ok, ms: r.ms, approved: 'none', result: r.ok ? r.result : undefined, error: r.ok ? undefined : r.error }); }
				return r.ok ? text(r.result) : { ...text(r.error), isError: true };
			});
	}
	const on = ADAPTER_IDS.filter(id => isEnabled(cfg, id));
	log(on.length ? `integrations: ${on.join(', ')} (${tools.length} tools)` : 'integrations: none enabled (.riaf/integrations.json)');
}

/** Outbound fetch for integrations: honours HTTPS_PROXY / HTTP_PROXY (Claude Code already sets these for the corporate proxy). */
async function integrationFetch(): Promise<(url: string, init?: RequestInit) => Promise<Response>> {
	const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
	if (!proxy) { return (u, i) => fetch(u, i); }
	try {
		const { ProxyAgent, fetch: ufetch } = await import('undici');
		const agent = new ProxyAgent(proxy);
		const noProxy = (process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
		return (u, i) => {
			let host = ''; try { host = new URL(u).hostname.toLowerCase(); } catch { /* ignore */ }
			const bypass = host === 'localhost' || host === '127.0.0.1' || noProxy.some(n => host === n.replace(/^\./, '') || host.endsWith(`.${n.replace(/^\./, '')}`));
			return bypass ? fetch(u, i) : ufetch(u, { ...(i as object), dispatcher: agent } as Parameters<typeof ufetch>[1]) as unknown as Promise<Response>;
		};
	} catch { return (u, i) => fetch(u, i); }
}

const ledger = new FileLedger(workspaceRoot);
const latest = () => { const rows = ledger.list(); return rows[0] ? ledger.load(rows[0].id) : undefined; };
server.tool('plan_create', 'Write a run ledger from a JSON plan (subtasks array). Claude Code is the planner; RIAF stores the DAG.', { goal: z.string(), planJson: z.string() },
	async ({ goal, planJson }) => {
		const { parsePlanDocument } = await import('@bosch-mps/riaf-engine');
		const subtasks = parsePlanDocument(planJson);
		const run = ledger.create({ goal, subtasks });
		return text(renderLedger(run));
	});
server.tool('plan_status', 'Render the latest run, or one id.', { id: z.string().optional() },
	async ({ id }) => { const run = id ? ledger.load(id) : latest(); return text(run ? renderLedger(run) : 'No runs.'); });
server.tool('plan_next', 'Subtasks whose dependencies are done.', { id: z.string().optional() },
	async ({ id }) => { const run = id ? ledger.load(id) : latest(); return text(run ? nextReadySubtasks(run).map(s => `${s.id}: ${s.goal}`).join('\n') || 'none ready' : 'No runs.'); });
server.tool('plan_mark', 'Set a subtask status: running, done, blocked, skipped.', { id: z.string().optional(), subtaskId: z.string(), status: z.enum(['running', 'done', 'blocked', 'skipped']), message: z.string().optional() },
	async ({ id, subtaskId, status, message }) => {
		const run = id ? ledger.load(id) : latest();
		if (!run) { return text('No runs.'); }
		ledger.setSubtaskStatus(run, subtaskId, status, message ?? status);
		return text(renderLedger(run));
	});
server.tool('verify_subtask', 'Run the subtask acceptance checks against the working tree.', { id: z.string().optional(), subtaskId: z.string() },
	async ({ id, subtaskId }) => {
		const run = id ? ledger.load(id) : latest();
		const sub = run?.subtasks.find(s => s.id === subtaskId);
		if (!sub) { return text('subtask not found'); }
		const result = await verifySubtask(sub, {
			readFile: async p => { try { return (await import('node:fs')).readFileSync(join(workspaceRoot, p), 'utf8'); } catch { return null; } },
			runCommand: command => new Promise(resolve => {
				execFile(process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'sh', process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command], { cwd: workspaceRoot, timeout: 120_000, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
					const raw = (err as { code?: unknown } | null)?.code;
					const code = typeof raw === 'number' ? raw : err ? 1 : 0;
					resolve({ code, output: `${stdout}\n${stderr}`.slice(0, 8_000) });
				});
			}),
		});
		return text(result.ok ? 'pass' : result.failures.join('\n'));
	});
server.tool('run_critic', 'Record a critic result. pass=false with fixJson adds one fix subtask.', { id: z.string().optional(), pass: z.boolean(), summary: z.string().optional(), fixJson: z.string().optional() },
	async ({ id, pass, summary, fixJson }) => {
		const run = id ? ledger.load(id) : latest();
		if (!run) { return text('No runs.'); }
		ledger.appendEvent(run, 'critic', pass ? 'pass' : `fix:${summary ?? ''}`);
		if (!pass && fixJson) {
			const { parsePlanDocument } = await import('@bosch-mps/riaf-engine');
			const [fix] = parsePlanDocument(fixJson.includes('subtasks') ? fixJson : JSON.stringify({ subtasks: [JSON.parse(fixJson)] }));
			run.subtasks.push({ ...fix, status: 'pending', attempts: 0, toolDigest: [], notes: '' });
			ledger.save(run);
		}
		return text(renderLedger(run));
	});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready — ${index.getStatus().chunks} chunks for ${workspaceRoot}`);

const shutdown = async () => { await host.stop().catch(() => { }); await index.close().catch(() => { }); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);
