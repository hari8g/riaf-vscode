/**
 * Agentic search primitives: exact/regex grep and file globbing over the workspace.
 *
 * Grep uses ripgrep when a binary can be found (VS Code ships one; `RIAF_RG_PATH` or an explicit
 * candidate list override discovery) and falls back to a pure-JS walker otherwise — same output
 * shape either way. Both honour the index's exclusion rules (`.gitignore`, hard-skipped dirs,
 * user globs) so the agent sees the same universe the index does.
 */
import { spawn } from 'child_process';
import { accessSync, constants, readdirSync, readFileSync, statSync } from 'fs';
import { delimiter, join, relative } from 'path';
import { compileFileGlob, SKIP_DIRS } from './workspaceScanner.js';

export type GrepOptions = {
	/** Treat `pattern` as a regular expression (default: literal / fixed string). */
	regex?: boolean;
	caseSensitive?: boolean;
	/** Only search files matching these globs (`src/**\/*.ts`). */
	include?: readonly string[];
	/** Cap on returned matches (default 200). */
	maxResults?: number;
	/** Lines of context around each match (default 0). */
	context?: number;
	/** Exclusion predicate over forward-slash relative paths (defaults to the hard-skip set). */
	isExcluded?: (relPath: string) => boolean;
	/** Explicit ripgrep binary candidates to try first. */
	rgCandidates?: readonly string[];
	/** Force the pure-JS engine (tests). */
	engine?: 'auto' | 'rg' | 'js';
	timeoutMs?: number;
};

export type GrepMatch = {
	filePath: string;
	line: number;
	text: string;
	/** Context lines (when requested), with their line numbers. */
	before?: { line: number; text: string }[];
	after?: { line: number; text: string }[];
};

export type GrepResult = {
	matches: GrepMatch[];
	truncated: boolean;
	engine: 'rg' | 'js';
	filesSearched?: number;
};

export type GlobOptions = {
	maxResults?: number;
	isExcluded?: (relPath: string) => boolean;
	/** Include directories in the result (default: files only). */
	includeDirs?: boolean;
};

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 400;
const DEFAULT_MAX_RESULTS = 200;

/* ───────────────────────────── ripgrep discovery ───────────────────────────── */

let rgCache: { key: string; path: string | null } | null = null;

const isExecutable = (p: string): boolean => {
	try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; }
};

/** Locate a ripgrep binary: explicit candidates → `RIAF_RG_PATH` → PATH. Cached. */
export const findRipgrep = (candidates: readonly string[] = []): string | null => {
	const key = candidates.join('|');
	if (rgCache && rgCache.key === key) return rgCache.path;
	const names = process.platform === 'win32' ? ['rg.exe', 'rg'] : ['rg'];
	const all: string[] = [...candidates];
	if (process.env.RIAF_RG_PATH) all.push(process.env.RIAF_RG_PATH);
	for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) for (const n of names) all.push(join(dir, n));
	const found = all.find(isExecutable) ?? null;
	rgCache = { key, path: found };
	return found;
};

/* ───────────────────────────── grep ───────────────────────────── */

const defaultExcluded = (relPath: string): boolean => relPath.split('/').some(seg => SKIP_DIRS.has(seg));

export async function grepWorkspace(root: string, pattern: string, options: GrepOptions = {}): Promise<GrepResult> {
	if (!pattern) return { matches: [], truncated: false, engine: 'js', filesSearched: 0 };
	const engine = options.engine ?? 'auto';
	const rg = engine === 'js' ? null : findRipgrep(options.rgCandidates);
	if (rg) {
		try { return await grepWithRipgrep(rg, root, pattern, options); } catch { if (engine === 'rg') throw new Error('ripgrep failed'); }
	} else if (engine === 'rg') {
		throw new Error('ripgrep not found');
	}
	return grepWithJs(root, pattern, options);
}

function grepWithRipgrep(rg: string, root: string, pattern: string, o: GrepOptions): Promise<GrepResult> {
	const max = o.maxResults ?? DEFAULT_MAX_RESULTS;
	const args = ['--json', '--no-messages', '--hidden', '--max-columns', String(MAX_LINE_CHARS), '--max-filesize', `${MAX_FILE_BYTES}`];
	if (!o.regex) args.push('--fixed-strings');
	args.push(o.caseSensitive ? '--case-sensitive' : '--ignore-case');
	if (o.context) args.push('--context', String(o.context));
	for (const seg of SKIP_DIRS) args.push('--glob', `!${seg}`);
	for (const g of o.include ?? []) args.push('--glob', g);
	args.push('--regexp', pattern, '--', '.');

	return new Promise((resolve, reject) => {
		const child = spawn(rg, args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
		const matches: GrepMatch[] = [];
		let truncated = false;
		let buf = '';
		let pendingBefore: { line: number; text: string }[] = [];
		let last: GrepMatch | null = null;
		const timer = setTimeout(() => { truncated = true; child.kill(); }, o.timeoutMs ?? 20_000);

		const handle = (line: string) => {
			if (!line) return;
			let ev: any;
			try { ev = JSON.parse(line); } catch { return; }
			if (ev.type === 'begin') { pendingBefore = []; last = null; return; }
			if (ev.type !== 'match' && ev.type !== 'context') return;
			const file = String(ev.data.path?.text ?? '').replace(/^\.\//, '').replace(/\\/g, '/');
			if (o.isExcluded?.(file)) return;
			const text = String(ev.data.lines?.text ?? '').replace(/\r?\n$/, '').slice(0, MAX_LINE_CHARS);
			const lineNo = Number(ev.data.line_number ?? 0);
			if (ev.type === 'context') {
				if (last && lineNo > last.line) { (last.after ??= []).push({ line: lineNo, text }); }
				else { pendingBefore.push({ line: lineNo, text }); if (pendingBefore.length > (o.context ?? 0)) pendingBefore.shift(); }
				return;
			}
			if (matches.length >= max) { truncated = true; child.kill(); return; }
			const m: GrepMatch = { filePath: file, line: lineNo, text };
			if (o.context) { m.before = pendingBefore; m.after = []; pendingBefore = []; }
			matches.push(m);
			last = m;
		};
		child.stdout.on('data', (d: Buffer) => {
			buf += d.toString('utf8');
			let nl: number;
			while ((nl = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
		});
		child.on('error', err => { clearTimeout(timer); reject(err); });
		child.on('close', code => {
			clearTimeout(timer);
			handle(buf);
			// rg exits 1 for "no matches", 2 for errors (but partial output is still fine after a kill)
			if (code === 2 && matches.length === 0 && !truncated) { reject(new Error('rg exit 2')); return; }
			resolve({ matches, truncated, engine: 'rg' });
		});
	});
}

const looksBinary = (buf: Buffer): boolean => {
	const n = Math.min(buf.length, 8000);
	for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
	return false;
};

/** Recursively list files under `root` (forward-slash relative), honouring the exclusion predicate. */
export function walkFiles(root: string, isExcluded: (relPath: string) => boolean = defaultExcluded, includeDirs = false): string[] {
	const out: string[] = [];
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop()!;
		let entries: string[];
		try { entries = readdirSync(dir); } catch { continue; }
		for (const entry of entries) {
			const abs = join(dir, entry);
			const rel = relative(root, abs).replace(/\\/g, '/');
			if (isExcluded(rel) || defaultExcluded(rel)) continue;
			let st;
			try { st = statSync(abs); } catch { continue; }
			if (st.isDirectory()) { if (includeDirs) out.push(`${rel}/`); stack.push(abs); }
			else if (st.isFile()) out.push(rel);
		}
	}
	return out.sort();
}

function grepWithJs(root: string, pattern: string, o: GrepOptions): GrepResult {
	const max = o.maxResults ?? DEFAULT_MAX_RESULTS;
	const flags = o.caseSensitive ? 'g' : 'gi';
	const source = o.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(source, flags);
	const includes = (o.include ?? []).map(compileFileGlob);
	const matches: GrepMatch[] = [];
	let truncated = false;
	let filesSearched = 0;
	const files = walkFiles(root, o.isExcluded);
	outer: for (const rel of files) {
		if (includes.length && !includes.some(m => m(rel))) continue;
		let buf: Buffer;
		try {
			if (statSync(join(root, rel)).size > MAX_FILE_BYTES) continue;
			buf = readFileSync(join(root, rel));
		} catch { continue; }
		if (looksBinary(buf)) continue;
		filesSearched++;
		const lines = buf.toString('utf8').split('\n');
		for (let i = 0; i < lines.length; i++) {
			re.lastIndex = 0;
			if (!re.test(lines[i])) continue;
			if (matches.length >= max) { truncated = true; break outer; }
			const m: GrepMatch = { filePath: rel, line: i + 1, text: lines[i].replace(/\r$/, '').slice(0, MAX_LINE_CHARS) };
			if (o.context) {
				m.before = lines.slice(Math.max(0, i - o.context), i).map((t, k) => ({ line: i - Math.min(i, o.context!) + k + 1, text: t.replace(/\r$/, '') }));
				m.after = lines.slice(i + 1, i + 1 + o.context).map((t, k) => ({ line: i + 2 + k, text: t.replace(/\r$/, '') }));
			}
			matches.push(m);
		}
	}
	return { matches, truncated, engine: 'js', filesSearched };
}

/* ───────────────────────────── glob ───────────────────────────── */

/** Files (sorted) matching `pattern`, e.g. `src/**\/*.test.ts` or `*.yaml`. */
export function globWorkspace(root: string, pattern: string, options: GlobOptions = {}): { files: string[]; truncated: boolean } {
	const max = options.maxResults ?? 500;
	const match = compileFileGlob(pattern);
	const all = walkFiles(root, options.isExcluded, options.includeDirs ?? false);
	const files: string[] = [];
	for (const f of all) {
		if (!match(f) && !(f.endsWith('/') && match(f.slice(0, -1)))) continue;
		if (files.length >= max) return { files, truncated: true };
		files.push(f);
	}
	return { files, truncated: false };
}

/** Compact, model-friendly rendering: grouped by file, `line: text`. */
export function formatGrepResult(r: GrepResult, maxChars = 12_000): string {
	if (!r.matches.length) return 'No matches.';
	const byFile = new Map<string, GrepMatch[]>();
	for (const m of r.matches) { (byFile.get(m.filePath) ?? byFile.set(m.filePath, []).get(m.filePath)!).push(m); }
	const out: string[] = [];
	let size = 0;
	for (const [file, ms] of byFile) {
		const block = [`${file}`, ...ms.flatMap(m => [
			...(m.before ?? []).map(c => `  ${c.line}- ${c.text}`),
			`  ${m.line}: ${m.text}`,
			...(m.after ?? []).map(c => `  ${c.line}- ${c.text}`),
		])].join('\n');
		if (size + block.length > maxChars) { out.push(`… ${r.matches.length - out.length} more matches omitted`); break; }
		out.push(block);
		size += block.length;
	}
	if (r.truncated) out.push(`(results capped at ${r.matches.length}; narrow the pattern or add an include glob)`);
	return out.join('\n');
}
