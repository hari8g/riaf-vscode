/**
 * Which shell runs agent commands and project hooks.
 *
 * The model writes POSIX commands (`rm -f`, `$VAR`, `>&2`, `a && b`) and `.riaf/hooks.json` is
 * shared by the whole team, so on Windows we prefer a POSIX shell when one is present — Git Bash
 * ships with Git for Windows and is on nearly every developer machine — and fall back to cmd.exe
 * only when none is found. On macOS/Linux this is always /bin/sh.
 *
 * No `vscode` import (shared by tests and the MCP server).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type ShellSpec = {
	/** Executable to spawn. */
	file: string;
	/** Arguments that precede the command string. */
	args: string[];
	/** `posix` understands sh syntax; `cmd` is Windows cmd.exe. */
	kind: 'posix' | 'cmd';
	/** Where it came from, for Doctor. */
	source: string;
};

let cached: ShellSpec | undefined;

const WINDOWS_BASH_CANDIDATES = (): string[] => {
	const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
	const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
	const local = process.env['LOCALAPPDATA'] ?? '';
	return [
		process.env['RIAF_SHELL'] ?? '',
		join(pf, 'Git', 'bin', 'bash.exe'),
		join(pf, 'Git', 'usr', 'bin', 'bash.exe'),
		join(pf86, 'Git', 'bin', 'bash.exe'),
		join(local, 'Programs', 'Git', 'bin', 'bash.exe'),
	].filter(Boolean);
};

/** Resolve once per process; `RIAF_SHELL=<path to bash.exe>` overrides on Windows. */
export function resolveShell(): ShellSpec {
	if (cached) { return cached; }
	if (process.platform !== 'win32') {
		return (cached = { file: '/bin/sh', args: ['-c'], kind: 'posix', source: '/bin/sh' });
	}
	for (const p of WINDOWS_BASH_CANDIDATES()) {
		if (existsSync(p)) { return (cached = { file: p, args: ['-c'], kind: 'posix', source: p }); }
	}
	// Git Bash somewhere on PATH?
	try {
		const found = execFileSync('where.exe', ['bash.exe'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
			.split(/\r?\n/).map(s => s.trim()).find(s => s && !/\\System32\\/i.test(s));  // skip the WSL launcher
		if (found) { return (cached = { file: found, args: ['-c'], kind: 'posix', source: `${found} (PATH)` }); }
	} catch { /* no where.exe or no bash */ }
	const cmd = process.env['ComSpec'] ?? 'C:\\Windows\\System32\\cmd.exe';
	return (cached = { file: cmd, args: ['/d', '/s', '/c'], kind: 'cmd', source: `${cmd} (no Git Bash found — POSIX commands and hooks will not work)` });
}

/** For tests: forget the cached resolution. */
export const resetShellCache = (): void => { cached = undefined; };

/** argv for running `command` in the resolved shell. */
export const shellArgv = (command: string, shell = resolveShell()): { file: string; args: string[] } =>
	({ file: shell.file, args: [...shell.args, command] });

/** Convert a Windows path to the form Git Bash expects when it appears inside a command (C:\a\b → /c/a/b). */
export const toPosixPath = (p: string): string =>
	process.platform === 'win32' ? p.replace(/^([A-Za-z]):[\\/]/, (_m, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, '/') : p;
