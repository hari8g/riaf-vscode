/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { CommandEntry, CommandPurpose } from './repoIntelligenceTypes.js';

const classifyScriptName = (name: string): CommandPurpose => {
	const lower = name.toLowerCase();
	if (/^(build|compile|bundle|dist|production)/.test(lower)) return 'build';
	if (/^(test|spec|e2e|unit|integration)/.test(lower)) return 'test';
	if (/^(lint|eslint|stylelint|biome)/.test(lower)) return 'lint';
	if (/^(typecheck|type-check|tsc|check-types)/.test(lower)) return 'typecheck';
	if (/^(start|dev|serve|watch|preview)/.test(lower)) return 'start';
	if (/^(format|fmt|prettier)/.test(lower)) return 'format';
	return 'build';
};

const classifyRunCommand = (cmd: string): CommandPurpose => {
	const lower = cmd.toLowerCase();
	if (/\b(test|pytest|jest|vitest|mocha|cargo test|go test)\b/.test(lower)) return 'test';
	if (/\b(lint|eslint|ruff|clippy|golangci)\b/.test(lower)) return 'lint';
	if (/\b(typecheck|tsc|mypy|pyright)\b/.test(lower)) return 'typecheck';
	if (/\b(build|compile|webpack|vite build|cargo build|go build|make)\b/.test(lower)) return 'build';
	if (/\b(format|prettier|black)\b/.test(lower)) return 'format';
	return 'build';
};

const detectPackageManager = (workspaceRoot: string): string => {
	if (existsSync(join(workspaceRoot, 'pnpm-lock.yaml'))) return 'pnpm';
	if (existsSync(join(workspaceRoot, 'yarn.lock'))) return 'yarn';
	if (existsSync(join(workspaceRoot, 'bun.lockb')) || existsSync(join(workspaceRoot, 'bun.lock'))) return 'bun';
	return 'npm';
};

const parsePackageJsonScripts = (workspaceRoot: string): CommandEntry[] => {
	const pkgPath = join(workspaceRoot, 'package.json');
	if (!existsSync(pkgPath)) return [];
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
		const scripts = pkg.scripts ?? {};
		const pm = detectPackageManager(workspaceRoot);
		const entries: CommandEntry[] = [];
		for (const [name, script] of Object.entries(scripts)) {
			const purpose = classifyScriptName(name);
			entries.push({
				command: `${pm} run ${name}`,
				purpose,
				confidence: 'high',
				source: `package.json#scripts.${name}`,
			});
			// also store raw script for reference
			if (typeof script === 'string' && script.length < 200) {
				entries.push({
					command: script,
					purpose,
					confidence: 'medium',
					source: `package.json#scripts.${name} (raw)`,
				});
			}
		}
		return entries;
	} catch {
		return [];
	}
};

const parseMakefile = (workspaceRoot: string): CommandEntry[] => {
	const makefilePath = join(workspaceRoot, 'Makefile');
	if (!existsSync(makefilePath)) return [];
	try {
		const content = readFileSync(makefilePath, 'utf8');
		const entries: CommandEntry[] = [];
		const targetRegex = /^([a-zA-Z0-9_.-]+)\s*:/gm;
		let match;
		while ((match = targetRegex.exec(content)) !== null) {
			const target = match[1];
			if (target.startsWith('.') || target === 'PHONY') continue;
			entries.push({
				command: `make ${target}`,
				purpose: classifyScriptName(target),
				confidence: 'high',
				source: `Makefile#${target}`,
			});
		}
		return entries;
	} catch {
		return [];
	}
};

const parsePyproject = (workspaceRoot: string): CommandEntry[] => {
	const entries: CommandEntry[] = [];
	const pyprojectPath = join(workspaceRoot, 'pyproject.toml');
	if (!existsSync(pyprojectPath)) return entries;
	try {
		const content = readFileSync(pyprojectPath, 'utf8');
		if (content.includes('[tool.pytest')) {
			entries.push({ command: 'pytest', purpose: 'test', confidence: 'high', source: 'pyproject.toml#tool.pytest' });
		}
		if (content.includes('[tool.ruff')) {
			entries.push({ command: 'ruff check .', purpose: 'lint', confidence: 'high', source: 'pyproject.toml#tool.ruff' });
		}
		if (content.includes('[tool.mypy')) {
			entries.push({ command: 'mypy .', purpose: 'typecheck', confidence: 'high', source: 'pyproject.toml#tool.mypy' });
		}
	} catch { /* ignore */ }
	return entries;
};

const parseGithubWorkflows = (workspaceRoot: string): CommandEntry[] => {
	const workflowsDir = join(workspaceRoot, '.github', 'workflows');
	if (!existsSync(workflowsDir)) return [];
	const entries: CommandEntry[] = [];
	try {
		for (const file of readdirSync(workflowsDir)) {
			if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
			const content = readFileSync(join(workflowsDir, file), 'utf8');
			const runRegex = /^\s*run:\s*(.+)$/gm;
			let match;
			while ((match = runRegex.exec(content)) !== null) {
				const cmd = match[1].trim().replace(/\|/g, '').trim();
				if (!cmd || cmd.length > 300) continue;
				entries.push({
					command: cmd,
					purpose: classifyRunCommand(cmd),
					confidence: 'medium',
					source: `.github/workflows/${file}`,
				});
			}
		}
	} catch { /* ignore */ }
	return entries;
};

const parseVscodeTasks = (workspaceRoot: string): CommandEntry[] => {
	const tasksPath = join(workspaceRoot, '.vscode', 'tasks.json');
	if (!existsSync(tasksPath)) return [];
	try {
		const tasks = JSON.parse(readFileSync(tasksPath, 'utf8'));
		const entries: CommandEntry[] = [];
		for (const task of tasks.tasks ?? []) {
			const cmd = task.command ?? task.args?.join(' ') ?? '';
			if (!cmd) continue;
			const label = task.label ?? 'task';
			entries.push({
				command: typeof cmd === 'string' ? cmd : String(cmd),
				purpose: classifyScriptName(label),
				confidence: 'high',
				source: `.vscode/tasks.json#${label}`,
			});
		}
		return entries;
	} catch {
		return [];
	}
};

const parseJustfile = (workspaceRoot: string): CommandEntry[] => {
	const justPath = join(workspaceRoot, 'justfile');
	if (!existsSync(justPath)) return [];
	try {
		const content = readFileSync(justPath, 'utf8');
		const entries: CommandEntry[] = [];
		const recipeRegex = /^([a-zA-Z0-9_-]+)\s*:/gm;
		let match;
		while ((match = recipeRegex.exec(content)) !== null) {
			const recipe = match[1];
			entries.push({
				command: `just ${recipe}`,
				purpose: classifyScriptName(recipe),
				confidence: 'high',
				source: `justfile#${recipe}`,
			});
		}
		return entries;
	} catch {
		return [];
	}
};

const parseTaskfile = (workspaceRoot: string): CommandEntry[] => {
	const taskfilePath = join(workspaceRoot, 'Taskfile.yml');
	if (!existsSync(taskfilePath)) return [];
	try {
		const content = readFileSync(taskfilePath, 'utf8');
		const entries: CommandEntry[] = [];
		const taskRegex = /^\s{2}([a-zA-Z0-9_-]+):\s*$/gm;
		let match;
		while ((match = taskRegex.exec(content)) !== null) {
			const task = match[1];
			entries.push({
				command: `task ${task}`,
				purpose: classifyScriptName(task),
				confidence: 'high',
				source: `Taskfile.yml#${task}`,
			});
		}
		return entries;
	} catch {
		return [];
	}
};

const dedupeCommands = (entries: CommandEntry[]): CommandEntry[] => {
	const seen = new Set<string>();
	return entries.filter(e => {
		const key = `${e.purpose}:${e.command}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
};

const filterByPurpose = (entries: CommandEntry[], purpose: CommandPurpose): CommandEntry[] => {
	const filtered = entries.filter(e => e.purpose === purpose);
	const confidenceOrder = { high: 0, medium: 1, low: 2 };
	return filtered.sort((a, b) => confidenceOrder[a.confidence] - confidenceOrder[b.confidence]);
};

export type DetectedCommands = {
	buildCommands: CommandEntry[];
	startCommands: CommandEntry[];
	testCommands: CommandEntry[];
	lintCommands: CommandEntry[];
	typecheckCommands: CommandEntry[];
};

export const detectCommands = (workspaceRoot: string): DetectedCommands => {
	const all = dedupeCommands([
		...parsePackageJsonScripts(workspaceRoot),
		...parseMakefile(workspaceRoot),
		...parsePyproject(workspaceRoot),
		...parseGithubWorkflows(workspaceRoot),
		...parseVscodeTasks(workspaceRoot),
		...parseJustfile(workspaceRoot),
		...parseTaskfile(workspaceRoot),
	]);

	return {
		buildCommands: filterByPurpose(all, 'build'),
		startCommands: filterByPurpose(all, 'start'),
		testCommands: filterByPurpose(all, 'test'),
		lintCommands: filterByPurpose(all, 'lint'),
		typecheckCommands: filterByPurpose(all, 'typecheck'),
	};
};
