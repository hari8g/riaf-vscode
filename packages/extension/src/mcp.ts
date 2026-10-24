#!/usr/bin/env node
/**
 * RIAF MCP server (stdio) — gives Claude Code (or any MCP client) the same retrieval tools the
 * VS Code extension exposes to Copilot. Shares the SQLite index file with the extension, so one
 * index serves both. Read-only: editing stays with the client's own tools.
 *
 *   node dist/mcp.mjs --workspace /path/to/repo [--db /path/to/index.sqlite] [--reindex]
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { RiafIndex, setSqliteModuleLoader, setTreeSitterWasmDir } from '@bosch-mps/riaf-core';
import { executeOrgTool, executeSearchTool, ORG_TOOL_SPECS, SEARCH_TOOL_SPECS } from './tools/orgTools.js';
import { executeGraphTool, GRAPH_TOOL_SPECS } from './tools/graphTools.js';

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

const server = new McpServer({ name: 'riaf', version: '0.1.0' });
const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

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

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready — ${index.getStatus().chunks} chunks for ${workspaceRoot}`);

const shutdown = async () => { await index.close().catch(() => { }); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);
