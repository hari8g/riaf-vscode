/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { promisify } from 'util';
import { exec as _exec } from 'child_process';

const exec = promisify(_exec);

const git = async (command: string, cwd: string): Promise<string> => {
	try {
		const { stdout } = await exec(command, { cwd, timeout: 5000 });
		return stdout.trim();
	} catch {
		return '';
	}
};

export interface GitFileStats {
	file: string;
	changeCount: number;
	lastChanged: string; // ISO date string
}

/** Returns the git diff --stat for the current HEAD (≤ 20 lines), or null if not a git repo. */
export async function getGitDiffStat(workspaceRoot: string): Promise<string | null> {
	const diffStat = await git('git diff HEAD --stat', workspaceRoot);
	if (!diffStat) return null;
	// Limit to 20 lines
	const lines = diffStat.split('\n');
	if (lines.length > 20) {
		return lines.slice(0, 20).join('\n') + `\n... (${lines.length - 20} more files)`;
	}
	return diffStat;
}

/** Returns git status --short. */
export async function getGitStatus(workspaceRoot: string): Promise<string> {
	return git('git status --short', workspaceRoot);
}

/** Returns the current branch name. */
export async function getGitBranch(workspaceRoot: string): Promise<string> {
	return git('git branch --show-current', workspaceRoot);
}

/** Returns git log for the last N commits (oneline format). */
export async function getGitLog(workspaceRoot: string, n = 10): Promise<string> {
	return git(`git log --oneline -${n}`, workspaceRoot);
}

/** Returns recently changed files (by commit frequency over the last 100 commits). */
export async function getRecentlyChangedFiles(workspaceRoot: string, limit = 20): Promise<GitFileStats[]> {
	// Get files changed in the last 100 commits with dates
	const raw = await git(
		'git log --pretty=format:"%ad" --date=short --name-only --no-merges -100',
		workspaceRoot
	);
	if (!raw) return [];

	const fileCounts: Map<string, { count: number; lastDate: string }> = new Map();
	let currentDate = '';

	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		// Date lines look like "2025-01-15"
		if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
			currentDate = trimmed;
		} else if (trimmed) {
			const entry = fileCounts.get(trimmed);
			if (entry) {
				entry.count++;
				if (!entry.lastDate || currentDate > entry.lastDate) {
					entry.lastDate = currentDate;
				}
			} else {
				fileCounts.set(trimmed, { count: 1, lastDate: currentDate });
			}
		}
	}

	return Array.from(fileCounts.entries())
		.sort((a, b) => b[1].count - a[1].count)
		.slice(0, limit)
		.map(([file, { count, lastDate }]) => ({
			file,
			changeCount: count,
			lastChanged: lastDate,
		}));
}

/** Full git context block for injection into the system prompt. */
export async function buildGitContextBlock(workspaceRoot: string): Promise<string | null> {
	const [branch, diffStat, status] = await Promise.all([
		getGitBranch(workspaceRoot),
		getGitDiffStat(workspaceRoot),
		getGitStatus(workspaceRoot),
	]);

	if (!branch && !diffStat && !status) return null;

	const parts: string[] = [];
	if (branch) parts.push(`Branch: ${branch}`);
	if (status) parts.push(`Changed files:\n${status}`);
	if (diffStat) parts.push(`Diff summary:\n${diffStat}`);

	return parts.join('\n\n');
}
