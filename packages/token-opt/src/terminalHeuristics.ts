/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Terminal-command heuristics lifted from common/prompt/prompts.ts (the only parts of
// that 1.6k-line prompt module the token-optimisation layer depends on).

import { removeAnsiEscapeCodes } from './shim/vsBase.js';
import type { WorkspaceProfile } from './types.js';

export const MAX_TERMINAL_INACTIVE_TIME = 30; // seconds
export const MAX_TERMINAL_INACTIVE_TIME_LONG = 600; // seconds (10 minutes)
export const MAX_TERMINAL_COMMAND_TIME = 1800; // seconds (30 minutes)
export const MAX_TERMINAL_BG_COMMAND_TIME = 45;

const LONG_RUNNING_TERMINAL_COMMAND_PATTERN = /\b(npm|pnpm|yarn|npx|node)\s+(run\s+)?(compile|build|test|watch|ci|lint|typecheck|check|hygiene|dist|install)\b|\b(gulp|tsc|webpack|vite\s+build|cargo\s+(build|test)|make\b|cmake|gradle|mvn)\b|\bnpm\s+(ci|install)\b|\bpnpm\s+(i|install|add)\b|\byarn\s+(install|add)\b/i;

export const DEV_SERVER_COMMAND_PATTERN = /\b(npm|pnpm|yarn)\s+(run\s+)?(server|dev|start|serve)\b|\bnpx\s+(tsx|ts-node|nodemon)\b|\b(tsx|nodemon)\s+\S|\bnode\s+\S*(server|index)\./i;

export const SERVER_READY_OUTPUT_PATTERN = /\b(listening|running|ready|started)\b.*\b(port|localhost|http|127\.0\.0\.1)\b|\blocalhost:\d+\b|\b127\.0\.0\.1:\d+\b|\bServer running at\b/i;

export const isLongRunningTerminalCommand = (command: string): boolean =>
	LONG_RUNNING_TERMINAL_COMMAND_PATTERN.test(command.trim());

export const isBackgroundShellCommand = (command: string): boolean =>
	/\s&\s*$/.test(command.trim());

export const stripBackgroundShellSuffix = (command: string): string =>
	command.trim().replace(/\s&\s*$/, '');

export const isDevServerCommand = (command: string): boolean => {
	const trimmed = stripBackgroundShellSuffix(command);
	return DEV_SERVER_COMMAND_PATTERN.test(trimmed) || isBackgroundShellCommand(command);
};

/** Shell heredoc (cat << EOF) — cannot complete via single-line terminal.sendText; hangs waiting for delimiter. */
export const isHeredocTerminalCommand = (command: string): boolean =>
	/<<\s*-?\s*['"]?\w*['"]?/.test(command.trim());

/** Package manager install/ci/add commands — must verify output, not just exit code. */
export const isPackageInstallCommand = (command: string): boolean =>
	/\b(npm|pnpm|yarn|bun)\s+(install|ci|add)\b|\bpnpm\s+i\b|\byarn\s+install\b/i.test(command.trim());

export const getTerminalInactiveTimeoutSeconds = (command: string): number => {
	// Heredocs wait for interactive input — fail fast instead of hanging for minutes
	if (isHeredocTerminalCommand(command)) return 15;
	// Fast npm/pnpm install often finishes in seconds then goes silent — don't wait 10 minutes
	if (isPackageInstallCommand(command)) return 20;
	if (isLongRunningTerminalCommand(command)) return MAX_TERMINAL_INACTIVE_TIME_LONG;
	return MAX_TERMINAL_INACTIVE_TIME;
};

/** Heuristic: npm/pnpm/yarn install output indicates packages were actually installed. */
export const packageInstallLooksSuccessful = (output: string): boolean => {
	const plain = removeAnsiEscapeCodes(output);
	if (!plain.trim()) return false;
	if (/\bnpm ERR!|\bERR! code |\bcommand failed\b|\bELIFECYCLE\b|\bE404\b|\bgyp ERR!/i.test(plain)) return false;
	return /\badded \d+ packages\b/i.test(plain)
		|| /\bup to date,?\s+audited\b/i.test(plain)
		|| /\bup to date in \d+/i.test(plain)
		|| /\baudited \d+ packages?\b/i.test(plain)
		|| /\bfound 0 vulnerabilities\b/i.test(plain)
		|| (/\bnpm\s+install\b/i.test(plain) && /\bpackages?\b/i.test(plain) && !/\berror\b/i.test(plain));
};

/** Whether terminal output + exit code indicate the command truly succeeded (guards false OSC/cmdCap positives). */
export const terminalCommandLooksSuccessful = (command: string, output: string, exitCode: number): boolean => {
	if (exitCode !== 0) return false;
	if (isPackageInstallCommand(command)) return packageInstallLooksSuccessful(output);
	const plain = removeAnsiEscapeCodes(output);
	if (/\bnpm ERR!|\bERR! code |\bcommand failed\b|\bELIFECYCLE\b|\berror TS\d+/i.test(plain)) return false;
	return true;
};

/** Minimal verification path derived from the workspace profile's build/test commands. */
export function buildVerificationReminder(profile: WorkspaceProfile | null): string {
	const build = profile?.buildCommands.find(c => c.purpose === 'build')?.command ?? profile?.buildCommands[0]?.command;
	const start = profile?.buildCommands.find(c => c.purpose === 'start')?.command;
	const test = profile?.testCommands[0]?.command;

	const steps: string[] = [];
	if (build) steps.push(`run \`${build}\` via run_command (skip if trivial UI-only change)`);
	if (start) {
		steps.push(`start server with \`${start}\` via run_command (auto-routes to persistent terminal)`);
		steps.push(`verify with ONE run_command curl against localhost`);
	} else if (test) {
		steps.push(`run \`${test}\` via run_tests`);
	} else {
		steps.push('run one compile/test command via run_tests if this project has one');
	}
	steps.push('STOP after curl succeeds — Trove opens localhost in the editor. Server runs in Trove Agent terminal (background). User should only preview the app — never ask them to run install/build/start.');

	return `\n\nVERIFICATION (minimal path): ${steps.join('; ')}. Skip only for comment/doc-only edits.`;
}
