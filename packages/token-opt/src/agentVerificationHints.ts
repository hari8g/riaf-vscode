/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import {
	buildVerificationReminder,
	isDevServerCommand,
	isLongRunningTerminalCommand,
	isPackageInstallCommand,
	terminalCommandLooksSuccessful,
} from './terminalHeuristics.js';
import type { WorkspaceProfile } from './types.js';
import type { TerminalResolveReason } from './types.js';

const LOCALHOST_CURL_COMMAND_PATTERN = /\b(curl|wget|httpie|httpx)\b/i;
const LOCALHOST_HOST_PATTERN = /\b(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)\b/i;
const TEST_COMMAND_PATTERN = /\b(npm|pnpm|yarn|node)\s+(test|run\s+test)\b|\b(jest|vitest|mocha)\b/i;

export const MAX_SANDBOX_VERIFICATION_NUDGES = 1;

export type SandboxVerificationTracker = {
	codeChangesMade: boolean;
	sandboxVerified: boolean;
	nudgeCount: number;
};

export const createSandboxVerificationTracker = (): SandboxVerificationTracker => ({
	codeChangesMade: false,
	sandboxVerified: false,
	nudgeCount: 0,
});

export const isLocalhostCurlCommand = (command: string): boolean =>
	LOCALHOST_CURL_COMMAND_PATTERN.test(command) && LOCALHOST_HOST_PATTERN.test(command);

export const isSandboxVerificationCommand = (command: string): boolean => {
	const trimmed = command.trim();
	if (isLocalhostCurlCommand(trimmed)) {
		return true;
	}
	if (isDevServerCommand(trimmed)) {
		return true;
	}
	if (TEST_COMMAND_PATTERN.test(trimmed)) {
		return true;
	}
	if (isLongRunningTerminalCommand(trimmed) && !isPackageInstallCommand(trimmed)) {
		return true;
	}
	return false;
};

export const markSandboxCodeChange = (tracker: SandboxVerificationTracker): void => {
	tracker.codeChangesMade = true;
};

export const markSandboxVerified = (
	tracker: SandboxVerificationTracker,
	command: string,
	output: string,
	resolveReason: TerminalResolveReason,
): void => {
	if (!isSandboxVerificationCommand(command)) {
		return;
	}
	if (resolveReason.type === 'server_ready') {
		tracker.sandboxVerified = true;
		return;
	}
	if (resolveReason.type !== 'done') {
		return;
	}
	if (terminalCommandLooksSuccessful(command, output, resolveReason.exitCode)) {
		tracker.sandboxVerified = true;
	}
};

export const needsSandboxVerification = (
	tracker: SandboxVerificationTracker,
	fileEditCounts: Map<string, number>,
	profile: WorkspaceProfile | null,
): boolean => {
	const hasEdits = fileEditCounts.size > 0 || tracker.codeChangesMade;
	if (!hasEdits || tracker.sandboxVerified) {
		return false;
	}
	const hasVerificationPath = Boolean(
		profile?.testCommands?.length
		|| profile?.buildCommands.some(c => c.purpose === 'start' || c.purpose === 'build')
	);
	return hasVerificationPath;
};

export const buildSandboxVerificationHint = (profile: WorkspaceProfile | null): string => {
	const reminder = buildVerificationReminder(profile).replace(/^\n\n/, '');
	return `\n\n<agent_hints>
SANDBOX VERIFICATION REQUIRED — you made code changes but have NOT verified them in the terminal sandbox yet.
${reminder}
Do NOT respond to the user until you complete the verification path above via run_tests or run_command. This is mandatory.
</agent_hints>`;
};
