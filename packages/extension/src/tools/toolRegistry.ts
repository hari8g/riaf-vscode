import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { relative, isAbsolute, join, posix } from 'node:path';
import type { RiafIndex } from '@bosch-mps/riaf-core';
import { removeAnsiEscapeCodes } from '@bosch-mps/token-opt';
import type { ToolSpec } from '../modelTransport.js';
import { proposeEdit } from './editApproval.js';
import { shellArgv } from './shell.js';
import { executeOrgTool, executeSearchTool, ORG_TOOL_NAMES, ORG_TOOL_SPECS, SEARCH_TOOL_NAMES, SEARCH_TOOL_SPECS } from './orgTools.js';
import { executeGraphTool, formatReferences, GRAPH_TOOL_NAMES, GRAPH_TOOL_SPECS } from './graphTools.js';
import type { SymbolEdge } from '@bosch-mps/riaf-core';
import { evaluateCommand, seatbeltAvailable, wrapInSeatbelt, type CommandPolicy } from './commandPolicy.js';
import { runPostEditHooks, runPreToolHooks, type HookConfig } from './hooks.js';
import { EXPLORE_SPEC, EXPLORE_TOOL_NAME, runExplore } from '../exploreAgent.js';
import type { ModelTransport } from '../modelTransport.js';
import type { Checkpoint, CheckpointStore } from '../checkpoints.js';
import type { SandboxMode } from '../config.js';

/* ───────────────────────────── tool catalogue ───────────────────────────── */

export const READ_ONLY_TOOLS = new Set([
	'read_file', 'search_codebase', 'search_symbols', 'get_file_outline', 'get_context_profile', 'ls_dir', 'search_in_file', 'get_import_graph', 'get_tests_for_file',
	...SEARCH_TOOL_NAMES,
	...GRAPH_TOOL_NAMES,
	...ORG_TOOL_NAMES,
	EXPLORE_TOOL_NAME,
]);
export const EDIT_TOOLS = new Set(['edit_file', 'rewrite_file', 'create_file_or_folder', 'delete_file_or_folder']);
export const COMMAND_TOOLS = new Set(['run_command', 'run_tests']);

const str = (d: string) => ({ type: 'string', description: d });
const num = (d: string) => ({ type: 'number', description: d });
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required });

export const TOOL_SPECS: ToolSpec[] = [
	{ name: 'search_codebase', description: 'Hybrid BM25+semantic search over the indexed repository. Returns ranked code chunks (path, lines, content). Use this FIRST instead of reading files blindly.', inputSchema: obj({ query: str('Identifiers, concepts or error text'), limit: num('Max results, default 8'), pathPrefix: str('Restrict to a relative path prefix') }, ['query']) },
	{ name: 'search_symbols', description: 'Find exported symbols (function/class/type) by name across the workspace.', inputSchema: obj({ query: str('Symbol name or part of it'), limit: num('default 15') }, ['query']) },
	{ name: 'get_context_profile', description: 'For a file: imports, importers, covering tests, plus the workspace profile (languages, frameworks, build/test commands). Call once before editing a file.', inputSchema: obj({ filePath: str('Workspace-relative path (optional)') }) },
	{ name: 'get_file_outline', description: 'Symbols defined in a file with line numbers — cheaper than reading the whole file.', inputSchema: obj({ filePath: str('Workspace-relative path') }, ['filePath']) },
	{ name: 'read_file', description: 'Read a file, optionally a line range. Do not re-read a file already in context.', inputSchema: obj({ filePath: str('Workspace-relative path'), startLine: num('1-based, optional'), endLine: num('inclusive, optional') }, ['filePath']) },
	{ name: 'search_in_file', description: 'Regex search within one file; returns matching lines with numbers.', inputSchema: obj({ filePath: str('Workspace-relative path'), pattern: str('JavaScript regex') }, ['filePath', 'pattern']) },
	{ name: 'ls_dir', description: 'List a directory (non-recursive).', inputSchema: obj({ dirPath: str('Workspace-relative path, "" for root') }) },
	{ name: 'get_import_graph', description: 'Files imported by and importing a file (from the Universal Context Graph).', inputSchema: obj({ filePath: str('Workspace-relative path') }, ['filePath']) },
	{ name: 'get_tests_for_file', description: 'Test files that cover a source file.', inputSchema: obj({ filePath: str('Workspace-relative path') }, ['filePath']) },
	...SEARCH_TOOL_SPECS,
	...GRAPH_TOOL_SPECS,
	EXPLORE_SPEC,
	{ name: 'edit_file', description: 'Replace an exact text block in a file. `search` must match exactly once. Combine multiple changes to the same file into ONE call using several blocks.', inputSchema: obj({ filePath: str('Workspace-relative path'), edits: { type: 'array', description: 'Search/replace blocks', items: obj({ search: str('Exact existing text'), replace: str('Replacement text') }, ['search', 'replace']) } }, ['filePath', 'edits']) },
	{ name: 'rewrite_file', description: 'Replace the entire content of an existing file (prefer edit_file for small changes).', inputSchema: obj({ filePath: str('Workspace-relative path'), content: str('Full new content') }, ['filePath', 'content']) },
	{ name: 'create_file_or_folder', description: 'Create a new file (with content) or folder. Do not read a path that does not exist yet.', inputSchema: obj({ path: str('Workspace-relative path; trailing / for a folder'), content: str('File content (ignored for folders)') }, ['path']) },
	{ name: 'delete_file_or_folder', description: 'Delete a file or folder (moves to trash).', inputSchema: obj({ path: str('Workspace-relative path') }, ['path']) },
	{ name: 'run_command', description: 'Run a shell command in the workspace root and return its output (the developer is asked to approve).', inputSchema: obj({ command: str('Shell command'), timeoutSec: num('default 120') }, ['command']) },
	{ name: 'run_tests', description: 'Run the project\'s detected test command (or the given one) and return the trimmed output.', inputSchema: obj({ command: str('Override test command (optional)') }) },
	...ORG_TOOL_SPECS,
];

/* ───────────────────────────── execution ───────────────────────────── */

export interface ToolContext {
	folder: vscode.WorkspaceFolder;
	index: RiafIndex;
	requireEditApproval: boolean;
	allowRunCommand: boolean;
	/** When true, edit and command tools are refused even if the model calls them (plan / explain). */
	readOnly?: boolean;
	/** Stream progress text into the chat. */
	progress?: (text: string) => void;
	token?: vscode.CancellationToken;
	/** Shell policy: allowlist / deny / workspace-write sandbox. Without it every command asks. */
	commandPolicy?: Omit<CommandPolicy, 'workspaceRoot' | 'detected'>;
	sandbox?: SandboxMode;
	/** Project + settings hooks (preTool can block, postEdit runs formatters). */
	hooks?: HookConfig;
	/** Collect pre-edit snapshots for RIAF: Rewind. */
	checkpoint?: { store: CheckpointStore; current: Checkpoint };
	/** Read language-server diagnostics for a file after it was written (ms to wait; 0 = read once, undefined = off). */
	diagnosticsSettleMs?: number;
	/** Needed by the `explore` subagent; absent in MCP / tests that do not exercise it. */
	transport?: ModelTransport;
	onSubagentUsage?: (usage: NonNullable<import('../modelTransport.js').TransportResult['usage']>, purpose: string) => void;
	log?: (msg: string) => void;
}

export type ToolOutcome = { ok: true; result: string; meta?: Record<string, unknown> } | { ok: false; error: string; meta?: Record<string, unknown> };

const MAX_OUTPUT_CHARS = 12_000;
const clip = (s: string, n = MAX_OUTPUT_CHARS) => s.length > n ? `${s.slice(0, n)}\n…[${s.length - n} more chars omitted]` : s;

function resolveInWorkspace(ctx: ToolContext, p: string | undefined): vscode.Uri {
	const rel = (p ?? '').replace(/^[\\/]+/, '');
	const abs = isAbsolute(rel) ? rel : join(ctx.folder.uri.fsPath, rel);
	const r = relative(ctx.folder.uri.fsPath, abs);
	if (r.startsWith('..')) { throw new Error(`path escapes the workspace: ${p}`); }
	return vscode.Uri.file(abs);
}
const relPath = (ctx: ToolContext, uri: vscode.Uri) => relative(ctx.folder.uri.fsPath, uri.fsPath).split('\\').join(posix.sep);

async function readText(uri: vscode.Uri): Promise<string> {
	const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
	if (open) { return open.getText(); }
	return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
	try {
		const a = args as Record<string, any>;
		if (ctx.readOnly && (EDIT_TOOLS.has(name) || COMMAND_TOOLS.has(name))) {
			return { ok: false, error: `${name} is not available in this mode (read-only). Describe the change instead of applying it.` };
		}
		// Tool-call JSON that did not parse (output truncated mid-arguments) arrives as `_raw`.
		if (typeof a._raw === 'string' && Object.keys(a).length === 1) {
			return { ok: false, error: `${name}: arguments were not valid JSON (the call was probably truncated). Re-issue the call with complete, smaller arguments.`, meta: { truncated: true } };
		}
		// project / settings pre-tool hooks may block the call
		if (ctx.hooks?.preTool.length) {
			const decision = await runPreToolHooks(ctx.hooks, { tool: name, args: a, workspace: ctx.folder.uri.fsPath });
			if (!decision.allow) { return { ok: false, error: `blocked by project hook: ${decision.reason}`, meta: { hookBlocked: true } }; }
			for (const n of decision.notes) { ctx.log?.(`[hook] ${n}`); }
		}
		switch (name) {
			case EXPLORE_TOOL_NAME: {
				if (!ctx.transport) { return { ok: false, error: 'explore is unavailable here (no model transport); use grep / search_codebase directly.' }; }
				const task = String(a.task ?? '').trim();
				if (!task) { return { ok: false, error: 'explore needs a `task`.' }; }
				ctx.progress?.(`explore: ${task.slice(0, 80)}`);
				const r = await runExplore(task, {
					transport: ctx.transport, ctx, allSpecs: TOOL_SPECS, executeTool,
					onUsage: u => ctx.onSubagentUsage?.(u, 'agent:explore'), log: ctx.log,
				}, Number(a.maxSteps) || undefined);
				return { ok: true, result: clip(r.report), meta: { steps: r.steps, toolCalls: r.toolCalls, refused: r.refused } };
			}
			case 'search_codebase': {
				const hits = await ctx.index.searchHybrid(String(a.query ?? ''), { limit: Number(a.limit) || 8, filePathPrefix: a.pathPrefix || undefined });
				if (!hits.length) { return { ok: true, result: 'No matches. Try different identifiers or search_symbols.' }; }
				return { ok: true, result: clip(hits.map(h => `### ${h.filePath}:${h.startLine}-${h.endLine} (score ${h.score.toFixed(3)})\n${h.content}`).join('\n\n')), meta: { count: hits.length } };
			}
			case 'search_symbols': {
				const syms = await ctx.index.searchSymbols(String(a.query ?? ''), Number(a.limit) || 15);
				return { ok: true, result: syms.length ? syms.map((s: any) => `${s.kind ?? 'symbol'} ${s.name} — ${s.filePath}:${s.line ?? s.startLine ?? '?'}`).join('\n') : 'No symbols found.' };
			}
			case 'get_context_profile': {
				const p = await ctx.index.getContextualProfile(a.filePath || undefined);
				const lines = [p.profileText];
				if (p.activeFile) { lines.push(`\nRelated files for ${p.activeFile}:`, ...p.relatedFiles.map(f => `- ${f}`), `Tests:`, ...(p.tests.length ? p.tests.map(t => `- ${t}`) : ['- (none found)'])); }
				if (p.neighborhood) { lines.push('', p.neighborhood); }
				return { ok: true, result: clip(lines.join('\n')) };
			}
			case 'find_references': {
				// Prefer the editor's language server when one answers; fall back to the static symbol graph.
				const sym = String(a.name ?? '').trim();
				if (!sym) { return { ok: false, error: 'find_references needs a `name`.' }; }
				const limit = Math.max(1, Math.min(200, Number(a.limit) || 50));
				const { definitions, references } = await ctx.index.findReferences(sym, { filePath: a.filePath || undefined, limit: limit * 2 });
				const lsp = await languageServerReferences(ctx, sym, definitions);
				if (lsp) { return { ok: true, result: clip(formatReferences(sym, definitions, lsp, 'language server', limit)) }; }
				return { ok: true, result: clip(formatReferences(sym, definitions, references, 'static graph', limit)) };
			}
			case 'get_file_outline': {
				const outline = await (ctx.index as any).getFileOutline?.(String(a.filePath));
				if (!outline || (Array.isArray(outline) && !outline.length)) { return { ok: true, result: 'No symbols indexed for this file (it may be excluded or unsupported); use read_file.' }; }
				const items = Array.isArray(outline) ? outline : outline.symbols ?? [];
				return { ok: true, result: items.map((s: any) => `${s.line ?? s.startLine ?? '?'}: ${s.kind ?? ''} ${s.name}`).join('\n') };
			}
			case 'read_file': {
				const uri = resolveInWorkspace(ctx, a.filePath);
				const text = await readText(uri);
				const lines = text.split('\n');
				const start = Math.max(1, Number(a.startLine) || 1);
				const end = Math.min(lines.length, Number(a.endLine) || lines.length);
				const slice = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)} | ${l}`).join('\n');
				return { ok: true, result: clip(`${relPath(ctx, uri)} (lines ${start}-${end} of ${lines.length})\n${slice}`), meta: { totalFileLen: text.length, startLine: start, endLine: end, uri: uri.toString() } };
			}
			case 'search_in_file': {
				const uri = resolveInWorkspace(ctx, a.filePath);
				const re = new RegExp(String(a.pattern), 'g');
				const out = (await readText(uri)).split('\n').flatMap((l, i) => re.test(l) ? [`${i + 1}: ${l}`] : (re.lastIndex = 0, []));
				return { ok: true, result: out.length ? clip(out.join('\n')) : 'No matches.' };
			}
			case 'ls_dir': {
				const uri = resolveInWorkspace(ctx, a.dirPath ?? '');
				const entries = await vscode.workspace.fs.readDirectory(uri);
				return { ok: true, result: entries.map(([n, t]) => t === vscode.FileType.Directory ? `${n}/` : n).sort().join('\n') || '(empty)' };
			}
			case 'get_import_graph': {
				const g = await (ctx.index as any).getImportGraph?.(String(a.filePath));
				return { ok: true, result: g ? clip(JSON.stringify(g, null, 1)) : 'File not in the context graph.' };
			}
			case 'get_tests_for_file': {
				const t = await (ctx.index as any).getTestsForFile?.(String(a.filePath));
				return { ok: true, result: t?.length ? t.map((x: any) => typeof x === 'string' ? x : x.filePath).join('\n') : 'No covering tests found.' };
			}
			case 'edit_file': {
				const uri = resolveInWorkspace(ctx, a.filePath);
				const original = await readText(uri);
				const edits: { search: string; replace: string }[] = Array.isArray(a.edits) ? a.edits : [];
				if (!edits.length) { return { ok: false, error: 'edit_file needs a non-empty `edits` array of {search, replace}.', meta: { truncated: true } }; }
				const eol = original.includes('\r\n') ? '\r\n' : '\n';
				let next = original.split('\r\n').join('\n');
				for (const [i, e] of edits.entries()) {
					if (typeof e?.search !== 'string' || typeof e?.replace !== 'string') { return { ok: false, error: `edit ${i + 1}: both \`search\` and \`replace\` must be strings.`, meta: { truncated: true } }; }
					const r = applySearchReplace(next, e.search.split('\r\n').join('\n'), e.replace.split('\r\n').join('\n'));
					if (!r.ok) { return { ok: false, error: `edit ${i + 1} of ${edits.length} in ${relPath(ctx, uri)}: ${r.error}`, meta: { editFailed: true } }; }
					next = r.text;
				}
				if (eol !== '\n') { next = next.split('\n').join(eol); }
				return applyProposed(ctx, uri, original, next, `edit ${relPath(ctx, uri)} (${edits.length} block${edits.length > 1 ? 's' : ''})`);
			}
			case 'rewrite_file': {
				const uri = resolveInWorkspace(ctx, a.filePath);
				if (typeof a.content !== 'string') { return { ok: false, error: 'rewrite_file: `content` is missing (the call was probably truncated). Use edit_file with small search/replace blocks instead.', meta: { truncated: true } }; }
				const original = await readText(uri);
				return applyProposed(ctx, uri, original, a.content, `rewrite ${relPath(ctx, uri)}`);
			}
			case 'create_file_or_folder': {
				const p = String(a.path ?? '');
				const uri = resolveInWorkspace(ctx, p);
				if (p.endsWith('/') || p.endsWith('\\')) { await vscode.workspace.fs.createDirectory(uri); return { ok: true, result: `created folder ${relPath(ctx, uri)}/` }; }
				try { await vscode.workspace.fs.stat(uri); return { ok: false, error: `${relPath(ctx, uri)} already exists — use edit_file or rewrite_file.` }; } catch { /* not found: good */ }
				if (typeof a.content !== 'string') { return { ok: false, error: 'create_file_or_folder: `content` is missing for a file (the call was probably truncated). Re-issue with the full content, or create the file empty with content "".', meta: { truncated: true } }; }
				return applyProposed(ctx, uri, '', a.content, `create ${relPath(ctx, uri)}`, true);
			}
			case 'delete_file_or_folder': {
				const uri = resolveInWorkspace(ctx, a.path);
				const ok = ctx.requireEditApproval ? (await vscode.window.showWarningMessage(`RIAF agent wants to delete ${relPath(ctx, uri)}`, { modal: true }, 'Delete')) === 'Delete' : true;
				if (!ok) { return { ok: false, error: 'developer rejected the deletion' }; }
				// checkpoint the file so a rewind brings it back (folders are trashed, not snapshotted)
				if (ctx.checkpoint) { try { const st = await vscode.workspace.fs.stat(uri); if (st.type !== vscode.FileType.Directory) { ctx.checkpoint.store.record(ctx.checkpoint.current, relPath(ctx, uri), await readText(uri)); } } catch { /* ignore */ } }
				await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
				return { ok: true, result: `deleted ${relPath(ctx, uri)}` };
			}
			case 'run_command':
			case 'run_tests': {
				if (!ctx.allowRunCommand) { return { ok: false, error: 'running commands is disabled (riaf.agent.allowRunCommand).' }; }
				let command = String(a.command ?? '');
				const wp = await ctx.index.getWorkspaceProfile();
				const detected = [...(wp?.testCommands ?? []), ...(wp?.typecheckCommands ?? []), ...(wp?.lintCommands ?? [])].map(c => c.command);
				if (name === 'run_tests' && !command) {
					const pick = (list?: { command: string; confidence: string }[]) => list?.find(c => c.confidence === 'high')?.command ?? list?.[0]?.command;
					command = pick(wp?.testCommands) ?? pick(wp?.typecheckCommands) ?? '';
					if (!command) { return { ok: false, error: 'no test or typecheck command detected; pass `command` explicitly.' }; }
				}
				// policy: deny list → allowlist / pre-approved project command → ask
				const policy: CommandPolicy = {
					preApproved: ctx.commandPolicy?.preApproved ?? [], denyPatterns: ctx.commandPolicy?.denyPatterns ?? [],
					autoApproveDetected: ctx.commandPolicy?.autoApproveDetected ?? false, extraWritableDirs: ctx.commandPolicy?.extraWritableDirs,
					detected, workspaceRoot: ctx.folder.uri.fsPath,
				};
				const sandboxOn = (ctx.sandbox ?? 'auto') !== 'off';
				const verdict = sandboxOn ? evaluateCommand(command, policy) : evaluateCommand(command, { ...policy, workspaceRoot: '/' });
				if (verdict.verdict === 'deny') { return { ok: false, error: `command refused: ${verdict.reason}\n$ ${command}`, meta: { denied: true } }; }
				if (verdict.verdict === 'ask') {
					const approved = (await vscode.window.showInformationMessage(`RIAF agent wants to run:\n\n${command}`, { modal: true }, 'Run')) === 'Run';
					if (!approved) { return { ok: false, error: 'developer rejected the command' }; }
				} else { ctx.log?.(`[policy] ${verdict.reason}: ${command}`); }
				ctx.progress?.(`$ ${command}`);
				const useSeatbelt = sandboxOn && (ctx.sandbox === 'seatbelt' || ((ctx.sandbox ?? 'auto') === 'auto' && seatbeltAvailable()));
				const out = await runShell(command, ctx.folder.uri.fsPath, (Number(a.timeoutSec) || 120) * 1000, ctx.token, useSeatbelt ? wrapInSeatbelt(command, ctx.folder.uri.fsPath, ctx.commandPolicy?.extraWritableDirs) : undefined);
				const notes: string[] = [];
				if (/(^|[\s;&|])(rm|rmdir|git\s+(clean|checkout|restore|reset))\b/.test(command)) { notes.push('(files removed or reverted by shell commands are not covered by RIAF checkpoints — recover them with git)'); }
				if (out.sandboxDenied) { notes.push('(a write outside the workspace was blocked by the sandbox)'); }
				const body = `${clip(out.output) || (out.code === 0 ? '(no output, exit 0)' : '')}${notes.length ? `\n${notes.join('\n')}` : ''}`;
				return out.code === 0 ? { ok: true, result: body } : { ok: false, error: `exit ${out.code}\n${body}` };
			}
			default: {
				const search = await executeSearchTool(ctx.index, name, a);
				if (search !== undefined) { return { ok: true, result: clip(search) }; }
				const graph = await executeGraphTool(ctx.index, name, a);
				if (graph !== undefined) { return { ok: true, result: clip(graph) }; }
				const org = await executeOrgTool(ctx.index, name, a);
				if (org !== undefined) { return { ok: true, result: clip(org) }; }
				return { ok: false, error: `unknown tool ${name}` };
			}
		}
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

/* ───────────────────────────── language-server references ───────────────────────────── */

/**
 * Ask the running language server (if any) for references to `sym`, positioned at its indexed
 * definition. Returns null when no provider answers, so the caller uses the static graph.
 */
async function languageServerReferences(ctx: ToolContext, sym: string, definitions: { filePath: string; startLine: number; name: string }[]): Promise<SymbolEdge[] | null> {
	const def = definitions[0];
	if (!def) { return null; }
	try {
		const uri = resolveInWorkspace(ctx, def.filePath);
		const text = await readText(uri);
		const lines = text.split('\n');
		const simple = sym.includes('.') ? sym.split('.').pop()! : sym;
		// the definition may start at a doc comment: find the first line in range that names the symbol
		let line = -1, col = -1;
		for (let i = Math.max(0, def.startLine - 1); i < Math.min(lines.length, def.startLine + 8); i++) {
			const m = new RegExp(`(?<![\\w$])${simple.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).exec(lines[i]);
			if (m) { line = i; col = m.index; break; }
		}
		if (line < 0) { return null; }
		const locations = await vscode.commands.executeCommand<vscode.Location[] | undefined>('vscode.executeReferenceProvider', uri, new vscode.Position(line, col));
		if (!Array.isArray(locations) || !locations.length) { return null; }
		const defSet = new Set(definitions.map(d => `${d.filePath}:${d.startLine}`));
		const out: SymbolEdge[] = [];
		for (const loc of locations) {
			const target = (loc as { uri?: vscode.Uri; targetUri?: vscode.Uri }).uri ?? (loc as { targetUri?: vscode.Uri }).targetUri;
			const range = (loc as { range?: vscode.Range; targetRange?: vscode.Range }).range ?? (loc as { targetRange?: vscode.Range }).targetRange;
			if (!target || !range) { continue; }
			const rel = relPath(ctx, target);
			if (rel.startsWith('..')) { continue; }
			const refLine = range.start.line + 1;
			if (rel === def.filePath && refLine === line + 1) { continue; }       // the definition itself
			if (defSet.has(`${rel}:${refLine}`)) { continue; }
			out.push({ fromFile: rel, fromSymbol: null, toName: simple, toFile: def.filePath, edgeType: 'calls', line: refLine });
		}
		return out;
	} catch {
		return null;
	}
}

/* ───────────────────────────── search/replace matching ───────────────────────────── */

type MatchResult = { ok: true; text: string } | { ok: false; error: string };

const trimEnd = (s: string) => s.replace(/[ \t]+$/, '');
const normalizeWs = (s: string) => s.trim().replace(/\s+/g, ' ');

/**
 * Three passes, strictest first:
 *  1. exact;
 *  2. line-wise with trailing whitespace ignored;
 *  3. line-wise with all indentation ignored — the file's indentation of the first matched
 *     line is re-applied to the replacement so the model's tabs/spaces choice does not leak in.
 * A block that matches more than once is rejected at every pass. On failure the error carries
 * the closest region of the file so the model can correct the block without a full re-read.
 */
function applySearchReplace(text: string, search: string, replace: string): MatchResult {
	if (!search.trim()) { return { ok: false, error: 'the `search` block is empty; it must contain the exact existing text to replace.' }; }

	// 1. exact
	const exact = text.split(search).length - 1;
	if (exact === 1) { return { ok: true, text: text.replace(search, () => replace) }; }
	if (exact > 1) { return { ok: false, error: `search block matches ${exact} times; include more surrounding lines so it is unique.` }; }

	// 2 + 3. line-wise
	const fileLines = text.split('\n');
	const searchLines = stripOuterBlankLines(search.split('\n'));
	const replaceLines = replace.split('\n');
	if (!searchLines.length) { return { ok: false, error: 'the `search` block is empty.' }; }

	for (const pass of ['trailing', 'indent'] as const) {
		const norm = pass === 'trailing' ? trimEnd : (s: string) => normalizeWs(s);
		const target = searchLines.map(norm);
		const hits: number[] = [];
		for (let i = 0; i + target.length <= fileLines.length; i++) {
			let all = true;
			for (let j = 0; j < target.length; j++) { if (norm(fileLines[i + j]) !== target[j]) { all = false; break; } }
			if (all) { hits.push(i); }
		}
		if (hits.length > 1) { return { ok: false, error: `search block matches ${hits.length} times (ignoring whitespace); include more surrounding lines so it is unique.` }; }
		if (hits.length === 1) {
			const start = hits[0];
			let out = replaceLines;
			if (pass === 'indent') {
				// re-indent: shift the replacement by (file indent − model indent) of the first non-blank line
				const fileIndent = leadingWs(fileLines[start]);
				const modelIndent = leadingWs(searchLines.find(l => l.trim()) ?? '');
				out = replaceLines.map(l => l.trim() ? reindent(l, modelIndent, fileIndent) : l);
			}
			return { ok: true, text: [...fileLines.slice(0, start), ...out, ...fileLines.slice(start + target.length)].join('\n') };
		}
	}

	// nothing matched: find the closest region by the first distinctive search line
	const anchor = searchLines.map(normalizeWs).find(l => l.length >= 8) ?? normalizeWs(searchLines[0]);
	let best = -1, bestScore = 0;
	for (let i = 0; i < fileLines.length; i++) {
		const s = similarity(normalizeWs(fileLines[i]), anchor);
		if (s > bestScore) { bestScore = s; best = i; }
	}
	const hint = best >= 0 && bestScore >= 0.5
		? `\nClosest region (lines ${best + 1}-${Math.min(fileLines.length, best + Math.max(3, searchLines.length))}):\n${fileLines.slice(best, best + Math.max(3, searchLines.length)).map((l, k) => `${String(best + 1 + k).padStart(5)} | ${l}`).join('\n')}\nCopy the search block from these exact lines.`
		: '\nNo similar text found; the file may have changed since you read it — read the relevant range again and retry.';
	return { ok: false, error: `search block not found:\n${search.slice(0, 300)}${hint}` };
}

const stripOuterBlankLines = (lines: string[]): string[] => {
	let a = 0, b = lines.length;
	while (a < b && !lines[a].trim()) { a++; }
	while (b > a && !lines[b - 1].trim()) { b--; }
	return lines.slice(a, b);
};
const leadingWs = (s: string) => /^[ \t]*/.exec(s)?.[0] ?? '';
const reindent = (line: string, from: string, to: string) => line.startsWith(from) ? to + line.slice(from.length) : to + line.trimStart();

/** Dice coefficient over character bigrams — cheap, good enough to pick a "closest line". */
function similarity(a: string, b: string): number {
	if (!a || !b) { return 0; }
	if (a === b) { return 1; }
	const grams = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
	const ga = grams(a), gb = grams(b);
	let inter = 0;
	for (const [g, n] of ga) { inter += Math.min(n, gb.get(g) ?? 0); }
	return (2 * inter) / (Math.max(1, a.length - 1) + Math.max(1, b.length - 1));
}

async function applyProposed(ctx: ToolContext, uri: vscode.Uri, original: string, next: string, label: string, isNew = false): Promise<ToolOutcome> {
	if (original === next) { return { ok: true, result: `no change: ${label}` }; }
	if (ctx.requireEditApproval) {
		const accepted = await proposeEdit(uri, original, next, label);
		if (!accepted) { return { ok: false, error: `developer rejected: ${label}` }; }
	}
	const rel = relPath(ctx, uri);
	ctx.checkpoint?.store.record(ctx.checkpoint.current, rel, isNew ? null : original);
	const edit = new vscode.WorkspaceEdit();
	if (isNew) { edit.createFile(uri, { ignoreIfExists: true, contents: Buffer.from(next, 'utf8') }); }
	else {
		const doc = await vscode.workspace.openTextDocument(uri);
		edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), next);
	}
	const ok = await vscode.workspace.applyEdit(edit);
	if (!ok) { return { ok: false, error: `workspace edit failed: ${label}` }; }
	const doc = await vscode.workspace.openTextDocument(uri);
	if (doc.isDirty) { await doc.save(); }
	await ctx.index.indexFiles([rel]).catch(() => { });
	const extra: string[] = [];
	if (ctx.hooks?.postEdit.length) { extra.push(...await runPostEditHooks(ctx.hooks, ctx.folder.uri.fsPath, rel)); }
	let diagnostics: { errors: number; warnings: number } | undefined;
	if (ctx.diagnosticsSettleMs !== undefined) {
		const d = await collectDiagnostics(uri, ctx.diagnosticsSettleMs);
		diagnostics = { errors: d.errors, warnings: d.warnings };
		if (d.text) { extra.push(d.text); }
	}
	return { ok: true, result: `applied: ${label}${extra.length ? `\n${extra.join('\n')}` : ''}`, meta: { uri: uri.toString(), chars: next.length, ...(diagnostics ? { diagnostics } : {}) } };
}

/* ───────────────────────────── diagnostics after an edit ───────────────────────────── */

const DIAG_MAX_LINES = 12;

/**
 * Give the language server a moment to re-check the saved file, then return its problems as a
 * compact block for the tool result. Polls until the set stops changing or `settleMs` elapses.
 */
export async function collectDiagnostics(uri: vscode.Uri, settleMs: number): Promise<{ errors: number; warnings: number; text: string }> {
	const read = () => { try { return vscode.languages.getDiagnostics(uri) ?? []; } catch { return [] as vscode.Diagnostic[]; } };
	let list = read();
	const deadline = Date.now() + Math.max(0, settleMs);
	let stable = 0;
	while (Date.now() < deadline) {
		await new Promise(r => setTimeout(r, Math.min(150, Math.max(1, deadline - Date.now()))));
		const next = read();
		const same = next.length === list.length && next.every((d, i) => d.message === list[i].message && d.range.start.line === list[i].range.start.line);
		list = next;
		if (same) { if (++stable >= 2 && list.length) { break; } } else { stable = 0; }
	}
	const sev = (d: vscode.Diagnostic) => d.severity;
	const errors = list.filter(d => sev(d) === vscode.DiagnosticSeverity.Error);
	const warnings = list.filter(d => sev(d) === vscode.DiagnosticSeverity.Warning);
	if (!errors.length && !warnings.length) { return { errors: 0, warnings: 0, text: '' }; }
	const fmt = (d: vscode.Diagnostic) => `  L${d.range.start.line + 1}:${d.range.start.character + 1} ${sev(d) === vscode.DiagnosticSeverity.Error ? 'error' : 'warning'}${d.source ? ` [${d.source}]` : ''}: ${String(d.message).split('\n')[0].slice(0, 200)}`;
	const shown = [...errors, ...warnings].slice(0, DIAG_MAX_LINES).map(fmt);
	const more = errors.length + warnings.length - shown.length;
	return { errors: errors.length, warnings: warnings.length, text: `Diagnostics after edit (${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}):\n${shown.join('\n')}${more > 0 ? `\n  … ${more} more` : ''}${errors.length ? '\nFix the errors above before running tests.' : ''}` };
}

function runShell(command: string, cwd: string, timeoutMs: number, token?: vscode.CancellationToken, wrapper?: { file: string; args: string[] }): Promise<{ code: number; output: string; sandboxDenied: boolean }> {
	return new Promise(resolve => {
		const opts = { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } };
		const done = (err: Error | null, stdout: string, stderr: string) => {
			const output = removeAnsiEscapeCodes(`${stdout}${stderr ? `\n${stderr}` : ''}`).trim();
			const sandboxDenied = !!wrapper && /sandbox|Operation not permitted|EPERM/i.test(stderr);
			resolve({ code: err ? ((err as any).code ?? 1) : 0, output, sandboxDenied });
		};
		const argv = wrapper ?? shellArgv(command);
		const child = execFile(argv.file, argv.args, opts, done);
		token?.onCancellationRequested(() => child.kill());
	});
}
