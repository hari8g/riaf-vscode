/**
 * Shell-command policy for the agent: deny list → allowlist → ask. Plus a workspace-write
 * sandbox: a lexical check that refuses writes outside the workspace, and — on macOS — an
 * optional Seatbelt (`sandbox-exec`) wrapper that enforces it at the OS level.
 *
 * No `vscode` import: unit-testable and reusable by the MCP process.
 */
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

export type CommandVerdict = { verdict: 'allow'; reason: string } | { verdict: 'ask'; reason: string } | { verdict: 'deny'; reason: string };

export interface CommandPolicy {
	/** Exact commands or command prefixes (first tokens) the developer pre-approved, e.g. "npm test", "npx vitest". */
	preApproved: string[];
	/** Detected project commands (test / typecheck / lint) that may run without a prompt when `autoApproveDetected` is set. */
	detected: string[];
	autoApproveDetected: boolean;
	/** Extra regexes (source strings) that always deny. */
	denyPatterns: string[];
	/** Absolute workspace root; writes outside it are refused. */
	workspaceRoot: string;
	/** Extra directories writes may target (caches, tmp). */
	extraWritableDirs?: string[];
}

/** Commands no agent should run unattended, whatever the allowlist says. */
export const BUILTIN_DENY: { pattern: RegExp; reason: string }[] = [
	{ pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)[a-zA-Z]*\s+(\/|~|\$HOME|\.\.)(\s|$|\/)/, reason: 'recursive delete of a root, home or parent directory' },
	{ pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+\/\s*$/, reason: 'recursive delete of /' },
	{ pattern: /\bsudo\b|\bdoas\b/, reason: 'privilege escalation' },
	{ pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, reason: 'piping a download into a shell' },
	{ pattern: /\bgit\s+push\b.*(--force|-f\b|\+[\w/]+:)/, reason: 'force push' },
	{ pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s+\.)/, reason: 'discarding working-tree changes' },
	{ pattern: /\bchmod\s+(-R\s+)?[0-7]*777\b/, reason: 'world-writable permissions' },
	{ pattern: /\bchown\s+-R\b/, reason: 'recursive ownership change' },
	{ pattern: /\bmkfs\b|\bdd\s+if=|\bfdisk\b|\bdiskutil\s+erase/, reason: 'disk-level operation' },
	{ pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: 'power control' },
	{ pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: 'fork bomb' },
	{ pattern: />\s*\/dev\/(sd|disk|nvme)/, reason: 'writing to a block device' },
	{ pattern: /\bkill\s+-9\s+-1\b|\bpkill\s+-9\s+\.\b/, reason: 'killing all processes' },
	{ pattern: /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/, reason: 'publishing a package' },
	{ pattern: /\bdocker\s+(system\s+prune|rm\s+-f\s+\$\(docker\s+ps)/, reason: 'destructive docker cleanup' },
	{ pattern: /\b(aws|gcloud|az)\s+\S*\s*(delete|rm|destroy|terminate)\b|\bterraform\s+(destroy|apply\s+-auto-approve)/, reason: 'destructive cloud operation' },
	{ pattern: /\bhistory\s+-c\b|\bunset\s+HISTFILE\b/, reason: 'tampering with shell history' },
];

const WRITE_VERBS = /(^|[;&|]\s*|\s)(rm|rmdir|mv|cp|tee|touch|mkdir|ln|chmod|chown|truncate|install|rsync|unzip|tar|dd|sed\s+-i[^\s]*|git\s+init|git\s+clone|npm\s+init|cargo\s+new|cargo\s+init)\s/;

/** Split a command line into shell-ish tokens (quotes respected, operators kept). */
export function tokenize(command: string): string[] {
	const out: string[] = [];
	let cur = '';
	let quote: string | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) { if (ch === quote) { quote = null; } else { cur += ch; } continue; }
		if (ch === '"' || ch === "'") { quote = ch; continue; }
		if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
		if (ch === '>' || ch === '<' || ch === '|' || ch === ';' || ch === '&') {
			if (cur) { out.push(cur); cur = ''; }
			if (out.length && /^[><|;&]+$/.test(out[out.length - 1]) && ch === out[out.length - 1][0]) { out[out.length - 1] += ch; } else { out.push(ch); }
			continue;
		}
		cur += ch;
	}
	if (cur) { out.push(cur); }
	return out;
}

const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, homedir()).replace(/^\$HOME(?=$|\/)/, homedir()).replace(/^\$\{HOME\}(?=$|\/)/, homedir());

function isUnder(path: string, dir: string): boolean {
	const p = resolve(path), d = resolve(dir);
	return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}

/** Directories a build or test may legitimately write to besides the workspace. */
export function defaultWritableDirs(): string[] {
	const home = homedir();
	return [
		tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/dev/null', '/dev/stdout', '/dev/stderr',
		`${home}/.npm`, `${home}/.cache`, `${home}/.yarn`, `${home}/.pnpm-store`, `${home}/.local/share/pnpm`, `${home}/.bun`,
		`${home}/.m2`, `${home}/.gradle`, `${home}/.cargo`, `${home}/go/pkg`, `${home}/.nuget`, `${home}/.pub-cache`,
		`${home}/Library/Caches`, `${home}/.config/configstore`, `${home}/.vscode`, `${home}/.npmrc`,
	];
}

/**
 * Lexical workspace-write check: absolute (or home-relative) paths that appear as targets of a
 * writing verb or an output redirection must live inside the workspace or a known cache dir.
 * `cd /elsewhere && …` is refused too, because the rest of the line would run outside the sandbox.
 */
export function findWriteOutsideWorkspace(command: string, workspaceRoot: string, extraWritable: string[] = []): string | null {
	const writable = [workspaceRoot, ...defaultWritableDirs(), ...extraWritable];
	const tokens = tokenize(command);
	const outside = (raw: string): boolean => {
		const p = expandHome(raw);
		if (!isAbsolute(p)) { return false; }
		return !writable.some(d => isUnder(p, d));
	};
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === 'cd' && tokens[i + 1]) {
			const target = expandHome(tokens[i + 1]);
			if (isAbsolute(target) && !isUnder(target, workspaceRoot)) { return `cd ${tokens[i + 1]}`; }
			if (/^\.\.(\/|$)/.test(target)) { return `cd ${tokens[i + 1]}`; }
		}
		if ((t === '>' || t === '>>') && tokens[i + 1] && outside(tokens[i + 1])) { return `${t} ${tokens[i + 1]}`; }
	}
	// paths that follow a writing verb (any argument until the next operator)
	const segments = command.split(/\s*(?:\|\||&&|;|\|)\s*/);
	for (const seg of segments) {
		if (!WRITE_VERBS.test(` ${seg} `)) { continue; }
		for (const tok of tokenize(seg).slice(1)) {
			if (/^[><|;&]+$/.test(tok) || tok.startsWith('-')) { continue; }
			if (outside(tok) || /^\.\.(\/|$)/.test(tok)) { return tok; }
		}
	}
	// writes relative to the parent of the workspace
	if (/(^|\s)(rm|mv|cp|tee|touch|mkdir|sed\s+-i\S*)\s+(-\S+\s+)*\.\.(\/|\s|$)/.test(command) || />\s*\.\.\//.test(command)) { return '../'; }
	return null;
}

const normalize = (c: string) => c.trim().replace(/\s+/g, ' ');

const matchesOne = (segment: string, entries: string[]): string | null => {
	const c = normalize(segment);
	if (!c) { return null; }
	for (const e of entries) {
		const n = normalize(e);
		if (n && (c === n || c.startsWith(`${n} `))) { return n; }
	}
	return null;
};

/**
 * Does `command` match the allowlist? Exact, or an entry is a prefix at a token boundary. A chain
 * (`a && b`, `a; b`, `a | b`) is allowed only when *every* segment matches; command substitution
 * (`$(…)`, backticks) and redirections into other commands never match.
 */
export function matchesAllowlist(command: string, entries: string[]): string | null {
	if (/\$\(|`|<\(|>\(/.test(command)) { return null; }
	const segments: string[][] = [[]];
	for (const tok of tokenize(command)) {
		if (/^(&&|\|\||;|\||&)$/.test(tok)) { segments.push([]); continue; }
		segments[segments.length - 1].push(tok);
	}
	const matched: string[] = [];
	for (const seg of segments) {
		// drop output redirections before matching (`npm test > out.log` ≙ `npm test`)
		const cleaned: string[] = [];
		for (let i = 0; i < seg.length; i++) { if (/^>>?$|^<$|^\d?>&?\d?$/.test(seg[i])) { i++; continue; } cleaned.push(seg[i]); }
		const m = matchesOne(cleaned.join(' '), entries);
		if (!m) { return null; }
		matched.push(m);
	}
	return matched.length ? [...new Set(matched)].join(' && ') : null;
}

export function evaluateCommand(command: string, policy: CommandPolicy): CommandVerdict {
	const c = command.trim();
	if (!c) { return { verdict: 'deny', reason: 'empty command' }; }
	for (const d of BUILTIN_DENY) { if (d.pattern.test(c)) { return { verdict: 'deny', reason: d.reason }; } }
	for (const src of policy.denyPatterns) {
		try { if (new RegExp(src).test(c)) { return { verdict: 'deny', reason: `matches deny pattern /${src}/` }; } } catch { /* bad regex: ignore */ }
	}
	const outside = findWriteOutsideWorkspace(c, policy.workspaceRoot, policy.extraWritableDirs);
	if (outside) { return { verdict: 'deny', reason: `writes outside the workspace (${outside}); the shell is sandboxed to ${policy.workspaceRoot}` }; }
	const pre = matchesAllowlist(c, policy.preApproved);
	if (pre) { return { verdict: 'allow', reason: `pre-approved: ${pre}` }; }
	if (policy.autoApproveDetected) {
		const det = matchesAllowlist(c, policy.detected);
		if (det) { return { verdict: 'allow', reason: `detected project command: ${det}` }; }
	}
	return { verdict: 'ask', reason: 'not on the allowlist' };
}

/* ───────────────────────────── macOS Seatbelt ───────────────────────────── */

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const seatbeltAvailable = (): boolean => process.platform === 'darwin' && existsSync(SANDBOX_EXEC);

const sbEscape = (p: string) => p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Seatbelt profile: read anything, write only under the workspace and the cache/tmp dirs.
 * Network stays open (package installs / test servers); the lexical policy handles the rest.
 */
export function seatbeltProfile(workspaceRoot: string, extraWritable: string[] = []): string {
	const dirs = [...new Set([workspaceRoot, ...defaultWritableDirs(), ...extraWritable].map(d => resolve(expandHome(d))))];
	const realDirs = dirs.flatMap(d => d.startsWith('/tmp') || d.startsWith('/var/') ? [d, `/private${d}`] : [d]);
	return [
		'(version 1)',
		'(allow default)',
		'(deny file-write*)',
		...realDirs.map(d => `(allow file-write* (subpath "${sbEscape(d)}"))`),
		'(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty"))',
		'(allow file-write* (regex #"^/dev/ttys[0-9]+$") (regex #"^/private/var/folders/.*"))',
		'(allow file-write* (regex #"^/Users/[^/]+/Library/(Caches|Logs|Saved Application State|Application Support/(Code|Cursor))/"))',
	].join('\n');
}

/** argv to run `command` through Seatbelt: sandbox-exec -p <profile> /bin/sh -c <command>. */
export function wrapInSeatbelt(command: string, workspaceRoot: string, extraWritable: string[] = []): { file: string; args: string[] } {
	return { file: SANDBOX_EXEC, args: ['-p', seatbeltProfile(workspaceRoot, extraWritable), '/bin/sh', '-c', command] };
}
