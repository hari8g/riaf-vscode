import * as vscode from 'vscode';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { iacTopology, pipelineBlastRadius, scanSecurity } from '@bosch-mps/riaf-engine';
import type { ToolSpec } from '../modelTransport.js';
import { readSettings } from '../config.js';
import { outboundFetch } from '../proxiedFetch.js';
import { loadMcpServers, prefixMcpTool } from '../mcpConfig.js';
import { cachedMcpStatus, callMcpTool } from '../mcpClient.js';
import { disposePersistentTerminal, runPersistentCommand } from './persistentTerminals.js';
import type { ToolContext } from './toolRegistry.js';

const str = (d: string) => ({ type: 'string', description: d });
const num = (d: string) => ({ type: 'number', description: d });
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required });

export const EXTRA_TOOL_SPECS: ToolSpec[] = [
	{ name: 'get_symbol', description: 'One indexed symbol in a file: kind, signature and line. Cheaper than reading the file.', inputSchema: obj({ filePath: str('Workspace-relative path'), name: str('Symbol name') }, ['filePath', 'name']) },
	{ name: 'get_dir_tree', description: 'Directory tree up to a depth (default 2). Skips node_modules and .git.', inputSchema: obj({ dirPath: str('Workspace-relative, empty for root'), depth: num('default 2') }) },
	{ name: 'read_lint_errors', description: 'Language-server diagnostics for a file or the whole workspace. A file path waits briefly for the diagnostics to settle.', inputSchema: obj({ filePath: str('Optional workspace-relative path') }) },
	{ name: 'search_web', description: 'Web search via the configured provider (Tavily, or the gateway /search route).', inputSchema: obj({ query: str('Search query') }, ['query']) },
	{ name: 'verify_security_compliance', description: 'Scan files for the built-in secret and unsafe-API rules, plus riaf.security.extraRules.', inputSchema: obj({ dirPath: str('Directory to scan, default src') }) },
	{ name: 'get_pipeline_blast_radius', description: 'CI jobs that depend on a job, directly or through other jobs.', inputSchema: obj({ job: str('Job name') }, ['job']) },
	{ name: 'get_iac_topology', description: 'Terraform resources grouped by type.', inputSchema: obj({ resourceType: str('Optional type filter') }) },
	{ name: 'open_persistent_terminal', description: 'Open a named terminal in the workspace. Dev-server commands stay open so later calls can read them.', inputSchema: obj({ name: str('Terminal name'), command: str('Optional command to run immediately') }, ['name']) },
	{ name: 'run_persistent_command', description: 'Send a command to a named terminal and report whether a dev server looks ready.', inputSchema: obj({ name: str('Terminal name'), command: str('Shell command') }, ['name', 'command']) },
	{ name: 'kill_persistent_terminal', description: 'Dispose a named terminal opened by RIAF.', inputSchema: obj({ name: str('Terminal name') }, ['name']) },
	{ name: 'list_mcp_tools', description: 'MCP servers declared in .mcp.json and the tool names they would be called as (mcp_<server>_<tool> is resolved by mcp_call).', inputSchema: obj({}) },
	{ name: 'mcp_call', description: 'Call a tool on an MCP server from .mcp.json or the user mcp.json. Stdio, streamable HTTP and SSE are supported. Prefer the prefixed mcp_<server>_<tool> tools when they are listed.', inputSchema: obj({ server: str('Server name'), tool: str('Tool name'), args: str('JSON object of arguments') }, ['server', 'tool']) },
];

export const EXTRA_TOOL_NAMES = EXTRA_TOOL_SPECS.map(t => t.name);

function tree(root: string, dir: string, depth: number, prefix = ''): string[] {
	if (depth < 0) { return []; }
	let entries: string[] = [];
	try { entries = readdirSync(dir); } catch { return [`${prefix}(unreadable)`]; }
	const lines: string[] = [];
	for (const name of entries.sort()) {
		if (name === 'node_modules' || name === '.git') { continue; }
		const abs = join(dir, name);
		let isDir = false;
		try { isDir = statSync(abs).isDirectory(); } catch { continue; }
		lines.push(`${prefix}${name}${isDir ? '/' : ''}`);
		if (isDir && depth > 0) { lines.push(...tree(root, abs, depth - 1, `${prefix}  `)); }
	}
	return lines;
}

export async function executeExtraTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ ok: boolean; result?: string; error?: string } | undefined> {
	if (!EXTRA_TOOL_NAMES.includes(name)) { return undefined; }
	const root = ctx.folder.uri.fsPath;
	const rel = (p: string) => p.replace(/\\/g, '/');
	try {
		switch (name) {
			case 'get_symbol': {
				const sym = await ctx.index.getSymbol(String(args.filePath ?? ''), String(args.name ?? ''));
				return sym ? { ok: true, result: JSON.stringify(sym, null, 1) } : { ok: false, error: 'symbol not indexed' };
			}
			case 'get_dir_tree': {
				const dir = join(root, String(args.dirPath ?? ''));
				return { ok: true, result: tree(root, dir, Number(args.depth ?? 2)).slice(0, 400).join('\n') || '(empty)' };
			}
			case 'read_lint_errors': {
				const want = String(args.filePath ?? '');
				const lines: string[] = [];
				const push = (path: string, diags: readonly vscode.Diagnostic[]) => {
					for (const d of diags) { lines.push(`${d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warn'} ${path}:${d.range.start.line + 1} ${d.message}`); }
				};
				if (want) {
					const uri = vscode.Uri.joinPath(ctx.folder.uri, want);
					const settleMs = Math.min(1_500, readSettings().agent.diagnosticsSettleMs);
					const deadline = Date.now() + Math.max(0, settleMs);
					let list = vscode.languages.getDiagnostics(uri);
					let stable = 0;
					while (Date.now() < deadline) {
						await new Promise(r => setTimeout(r, 40));
						const next = vscode.languages.getDiagnostics(uri);
						const same = next.length === list.length && next.every((d, i) => d.message === list[i]?.message && d.range.start.line === list[i]?.range.start.line);
						list = next;
						if (same && ++stable >= 2) { break; }
					}
					push(want, list);
				} else {
					for (const [uri, diags] of vscode.languages.getDiagnostics()) { push(rel(relative(root, uri.fsPath)), diags); }
				}
				return { ok: true, result: lines.slice(0, 40).join('\n') || 'no diagnostics' };
			}
			case 'search_web': {
				const s = readSettings();
				if (!s.webSearch.enabled) { return { ok: false, error: 'web search is off (riaf.webSearch.enabled)' }; }
				const query = String(args.query ?? '');
				const doFetch = await outboundFetch();
				if (s.webSearch.provider === 'gateway') {
					if (!s.gateway.url) { return { ok: false, error: 'no gateway URL for web search' }; }
					const res = await doFetch(`${s.gateway.url}/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
					return { ok: res.ok, result: await res.text(), error: res.ok ? undefined : `search ${res.status}` };
				}
				const key = await ctx.secrets?.get('riaf.webSearch.tavily');
				if (!key) { return { ok: false, error: 'no Tavily key — run RIAF: Set Web Search Key' }; }
				const res = await doFetch('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: key, query, max_results: 5 }) });
				const json = await res.json() as { results?: { title?: string; url?: string; content?: string }[] };
				const text = (json.results ?? []).map(r => `- ${r.title ?? ''} ${r.url ?? ''}\n  ${(r.content ?? '').slice(0, 240)}`).join('\n');
				return { ok: res.ok, result: text || 'no results', error: res.ok ? undefined : `tavily ${res.status}` };
			}
			case 'verify_security_compliance': {
				const dir = join(root, String(args.dirPath ?? 'src'));
				const files: { path: string; text: string }[] = [];
				const walk = (d: string, depth: number) => {
					if (depth < 0 || files.length > 80) { return; }
					let names: string[] = [];
					try { names = readdirSync(d); } catch { return; }
					for (const n of names) {
						if (n === 'node_modules' || n === '.git') { continue; }
						const abs = join(d, n);
						let st;
						try { st = statSync(abs); } catch { continue; }
						if (st.isDirectory()) { walk(abs, depth - 1); }
						else if (/\.(ts|tsx|js|jsx|py|go|java|cs|yml|yaml|json|env)$/.test(n)) {
							try { files.push({ path: relative(root, abs), text: readFileSync(abs, 'utf8').slice(0, 20_000) }); } catch { /* skip */ }
						}
					}
				};
				walk(dir, 3);
				const findings = scanSecurity(files, readSettings().security.extraRules);
				return { ok: true, result: findings.length ? findings.map(f => `${f.path}:${f.line} ${f.rule}: ${f.message}`).join('\n') : `no findings in ${files.length} files` };
			}
			case 'get_pipeline_blast_radius': {
				const jobs = await ctx.index.getPipelineJobs();
				const names = pipelineBlastRadius(jobs, String(args.job ?? ''));
				return { ok: true, result: names.length ? names.join('\n') : 'no downstream jobs' };
			}
			case 'get_iac_topology': {
				const resources = await ctx.index.getTerraformResources(args.resourceType ? String(args.resourceType) : undefined);
				return { ok: true, result: JSON.stringify(iacTopology(resources.map(r => ({ resourceType: r.resourceType, name: r.resourceName, filePath: r.filePath }))), null, 1) };
			}
			case 'open_persistent_terminal':
			case 'run_persistent_command':
				return runPersistentCommand({ name: String(args.name ?? 'riaf'), command: String(args.command ?? ''), cwd: root, timeoutMs: Number(args.timeoutSec) > 0 ? Number(args.timeoutSec) * 1000 : undefined });
			case 'kill_persistent_terminal':
				return { ok: true, result: disposePersistentTerminal(String(args.name ?? '')) ? 'disposed' : 'no such terminal' };
			case 'list_mcp_tools': {
				const disabled = new Set(readSettings().mcp.disabledServers);
				const known = cachedMcpStatus(root);
				const servers = loadMcpServers(root);
				if (!servers.length) { return { ok: true, result: 'no MCP servers in .mcp.json, .vscode/mcp.json, or the user mcp.json' }; }
				return {
					ok: true,
					result: servers.map(s => {
						const tools = known?.toolsByServer.get(s.name);
						const error = known?.errors.get(s.name);
						const state = disabled.has(s.name) ? 'disabled' : error ? `error: ${error}` : tools ? tools.join(', ') : 'not listed yet';
						return `${s.name} (${s.transport}${disabled.has(s.name) ? ', off' : ''}): ${s.url ?? `${s.command ?? ''} ${s.args.join(' ')}`.trim()} → ${prefixMcpTool(s.name, '<tool>')} [${state}]`;
					}).join('\n'),
				};
			}
			case 'mcp_call': {
				if (readSettings().agent.approveMcp) {
					const approved = (await vscode.window.showInformationMessage(`RIAF agent wants to call MCP ${args.server}/${args.tool}`, { modal: true }, 'Run')) === 'Run';
					if (!approved) { return { ok: false, error: 'developer rejected the MCP call' }; }
				}
				const parsed = typeof args.args === 'string' && args.args ? JSON.parse(String(args.args)) as Record<string, unknown> : {};
				return callMcpTool(root, String(args.server ?? ''), String(args.tool ?? ''), parsed, readSettings().mcp.disabledServers);
			}
			default: return undefined;
		}
	} catch (e) { return { ok: false, error: (e as Error).message }; }
}
