import * as vscode from 'vscode';
import { exec } from 'node:child_process';
import { relative, isAbsolute, join, posix } from 'node:path';
import type { RiafIndex } from '@bosch-mps/riaf-core';
import { removeAnsiEscapeCodes } from '@bosch-mps/token-opt';
import type { ToolSpec } from '../modelTransport.js';
import { proposeEdit } from './editApproval.js';

/* ───────────────────────────── tool catalogue ───────────────────────────── */

export const READ_ONLY_TOOLS = new Set([
	'read_file', 'search_codebase', 'search_symbols', 'get_file_outline', 'get_context_profile', 'ls_dir', 'search_in_file', 'get_import_graph', 'get_tests_for_file',
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
	{ name: 'edit_file', description: 'Replace an exact text block in a file. `search` must match exactly once. Combine multiple changes to the same file into ONE call using several blocks.', inputSchema: obj({ filePath: str('Workspace-relative path'), edits: { type: 'array', description: 'Search/replace blocks', items: obj({ search: str('Exact existing text'), replace: str('Replacement text') }, ['search', 'replace']) } }, ['filePath', 'edits']) },
	{ name: 'rewrite_file', description: 'Replace the entire content of an existing file (prefer edit_file for small changes).', inputSchema: obj({ filePath: str('Workspace-relative path'), content: str('Full new content') }, ['filePath', 'content']) },
	{ name: 'create_file_or_folder', description: 'Create a new file (with content) or folder. Do not read a path that does not exist yet.', inputSchema: obj({ path: str('Workspace-relative path; trailing / for a folder'), content: str('File content (ignored for folders)') }, ['path']) },
	{ name: 'delete_file_or_folder', description: 'Delete a file or folder (moves to trash).', inputSchema: obj({ path: str('Workspace-relative path') }, ['path']) },
	{ name: 'run_command', description: 'Run a shell command in the workspace root and return its output (the developer is asked to approve).', inputSchema: obj({ command: str('Shell command'), timeoutSec: num('default 120') }, ['command']) },
	{ name: 'run_tests', description: 'Run the project\'s detected test command (or the given one) and return the trimmed output.', inputSchema: obj({ command: str('Override test command (optional)') }) },
];

/* ───────────────────────────── execution ───────────────────────────── */

export interface ToolContext {
	folder: vscode.WorkspaceFolder;
	index: RiafIndex;
	requireEditApproval: boolean;
	allowRunCommand: boolean;
	/** Stream progress text into the chat. */
	progress?: (text: string) => void;
	token?: vscode.CancellationToken;
}

export type ToolOutcome = { ok: true; result: string; meta?: Record<string, unknown> } | { ok: false; error: string };

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
		switch (name) {
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
				return { ok: true, result: clip(lines.join('\n')) };
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
				let next = original;
				const edits: { search: string; replace: string }[] = Array.isArray(a.edits) ? a.edits : [];
				if (!edits.length) { return { ok: false, error: 'edit_file needs a non-empty `edits` array of {search, replace}.' }; }
				for (const e of edits) {
					const n = next.split(e.search).length - 1;
					if (n === 0) { return { ok: false, error: `search block not found in ${relPath(ctx, uri)}:\n${e.search.slice(0, 300)}` }; }
					if (n > 1) { return { ok: false, error: `search block matches ${n} times; include more surrounding context.` }; }
					next = next.replace(e.search, () => e.replace);
				}
				return applyProposed(ctx, uri, original, next, `edit ${relPath(ctx, uri)} (${edits.length} block${edits.length > 1 ? 's' : ''})`);
			}
			case 'rewrite_file': {
				const uri = resolveInWorkspace(ctx, a.filePath);
				const original = await readText(uri);
				return applyProposed(ctx, uri, original, String(a.content ?? ''), `rewrite ${relPath(ctx, uri)}`);
			}
			case 'create_file_or_folder': {
				const p = String(a.path ?? '');
				const uri = resolveInWorkspace(ctx, p);
				if (p.endsWith('/') || p.endsWith('\\')) { await vscode.workspace.fs.createDirectory(uri); return { ok: true, result: `created folder ${relPath(ctx, uri)}/` }; }
				try { await vscode.workspace.fs.stat(uri); return { ok: false, error: `${relPath(ctx, uri)} already exists — use edit_file or rewrite_file.` }; } catch { /* not found: good */ }
				return applyProposed(ctx, uri, '', String(a.content ?? ''), `create ${relPath(ctx, uri)}`, true);
			}
			case 'delete_file_or_folder': {
				const uri = resolveInWorkspace(ctx, a.path);
				const ok = ctx.requireEditApproval ? (await vscode.window.showWarningMessage(`RIAF agent wants to delete ${relPath(ctx, uri)}`, { modal: true }, 'Delete')) === 'Delete' : true;
				if (!ok) { return { ok: false, error: 'developer rejected the deletion' }; }
				await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
				return { ok: true, result: `deleted ${relPath(ctx, uri)}` };
			}
			case 'run_command':
			case 'run_tests': {
				if (!ctx.allowRunCommand) { return { ok: false, error: 'running commands is disabled (riaf.agent.allowRunCommand).' }; }
				let command = String(a.command ?? '');
				if (name === 'run_tests' && !command) {
					const wp = await ctx.index.getWorkspaceProfile();
					const pick = (list?: { command: string; confidence: string }[]) => list?.find(c => c.confidence === 'high')?.command ?? list?.[0]?.command;
					command = pick(wp?.testCommands) ?? pick(wp?.typecheckCommands) ?? '';
					if (!command) { return { ok: false, error: 'no test or typecheck command detected; pass `command` explicitly.' }; }
				}
				const approved = (await vscode.window.showInformationMessage(`RIAF agent wants to run:\n\n${command}`, { modal: true }, 'Run')) === 'Run';
				if (!approved) { return { ok: false, error: 'developer rejected the command' }; }
				ctx.progress?.(`$ ${command}`);
				const out = await runShell(command, ctx.folder.uri.fsPath, (Number(a.timeoutSec) || 120) * 1000, ctx.token);
				return { ok: out.code === 0, ...(out.code === 0 ? { result: clip(out.output) || '(no output, exit 0)' } : { error: `exit ${out.code}\n${clip(out.output)}` }) } as ToolOutcome;
			}
			default:
				return { ok: false, error: `unknown tool ${name}` };
		}
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

async function applyProposed(ctx: ToolContext, uri: vscode.Uri, original: string, next: string, label: string, isNew = false): Promise<ToolOutcome> {
	if (original === next) { return { ok: true, result: `no change: ${label}` }; }
	if (ctx.requireEditApproval) {
		const accepted = await proposeEdit(uri, original, next, label);
		if (!accepted) { return { ok: false, error: `developer rejected: ${label}` }; }
	}
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
	await ctx.index.indexFiles([relPath(ctx, uri)]).catch(() => { });
	return { ok: true, result: `applied: ${label}`, meta: { uri: uri.toString(), chars: next.length } };
}

function runShell(command: string, cwd: string, timeoutMs: number, token?: vscode.CancellationToken): Promise<{ code: number; output: string }> {
	return new Promise(resolve => {
		const child = exec(command, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } }, (err, stdout, stderr) => {
			const output = removeAnsiEscapeCodes(`${stdout}${stderr ? `\n${stderr}` : ''}`).trim();
			resolve({ code: err ? ((err as any).code ?? 1) : 0, output });
		});
		token?.onCancellationRequested(() => child.kill());
	});
}
