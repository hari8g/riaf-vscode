/*---------------------------------------------------------------------------
 * GitlabCiIndexer — parses .gitlab-ci.yml and auto-merge-template files
 * to build a pipeline stage DAG for blast-radius estimation.
 *---------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'dist']);

export type PipelineJob = {
	name: string;
	stage: string;
	needs: string[];
	filePath: string;
};

export type PipelineStage = {
	name: string;
	jobs: string[];
};

export type PipelineIndexResult = {
	jobs: PipelineJob[];
	stages: PipelineStage[];
	hasManualGates: boolean;
	fileCount: number;
};

function collectCiFiles(dir: string, results: string[] = [], depth = 0): string[] {
	if (depth > 6) return results;
	let entries: string[];
	try { entries = readdirSync(dir); } catch { return results; }
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		let stat;
		try { stat = statSync(full); } catch { continue; }
		if (stat.isDirectory()) collectCiFiles(full, results, depth + 1);
		else if (entry === '.gitlab-ci.yml' || entry.endsWith('-ci.yml') || entry.endsWith('-pipeline.yml')) {
			results.push(full);
		}
	}
	return results;
}

function extractJobBlocks(content: string): Map<string, string> {
	const jobs = new Map<string, string>();
	const RESERVED = new Set(['stages', 'variables', 'include', 'workflow', 'default', 'image', 'services', 'before_script', 'after_script', 'cache']);
	const topLevelKeys = [...content.matchAll(/^([a-zA-Z][\w:.-]+):\s*$/gm)];

	for (let i = 0; i < topLevelKeys.length; i++) {
		const keyMatch = topLevelKeys[i];
		const keyName = keyMatch[1];
		if (RESERVED.has(keyName)) continue;

		const startIdx = keyMatch.index! + keyMatch[0].length;
		const endIdx = i + 1 < topLevelKeys.length ? topLevelKeys[i + 1].index! : content.length;
		jobs.set(keyName, content.slice(startIdx, endIdx));
	}
	return jobs;
}

export function indexGitlabPipelines(workspaceRoot: string): PipelineIndexResult {
	const ciFiles = collectCiFiles(workspaceRoot);
	const allJobs: PipelineJob[] = [];
	const stageSet = new Map<string, Set<string>>();
	let hasManualGates = false;

	for (const filePath of ciFiles) {
		let content: string;
		try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
		const relPath = relative(workspaceRoot, filePath);

		const stagesMatch = content.match(/^stages:\s*\n((?:\s+-\s+\w[\w-]*\n)+)/m);
		if (stagesMatch) {
			for (const stageMatch of stagesMatch[1].matchAll(/- ([\w-]+)/g)) {
				if (!stageSet.has(stageMatch[1])) stageSet.set(stageMatch[1], new Set());
			}
		}

		if (/when:\s*manual/.test(content)) hasManualGates = true;

		const jobBlocks = extractJobBlocks(content);
		for (const [jobName, block] of jobBlocks.entries()) {
			const stageMatch = block.match(/^\s+stage:\s*(.+)$/m);
			const stage = stageMatch?.[1]?.trim() ?? 'test';

			const needsMatch = block.match(/^\s+needs:\s*\n((?:\s+-\s+\S+\n)+)/m);
			const needs: string[] = [];
			if (needsMatch) {
				for (const n of needsMatch[1].matchAll(/- ([\w:"-]+)/g)) {
					needs.push(n[1].replace(/^["']|["']$/g, ''));
				}
			}

			if (!stageSet.has(stage)) stageSet.set(stage, new Set());
			stageSet.get(stage)!.add(jobName);
			allJobs.push({ name: jobName, stage, needs, filePath: relPath });
		}
	}

	const stages: PipelineStage[] = Array.from(stageSet.entries()).map(([name, jobs]) => ({
		name,
		jobs: Array.from(jobs),
	}));

	return { jobs: allJobs, stages, hasManualGates, fileCount: ciFiles.length };
}
