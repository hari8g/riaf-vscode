/*---------------------------------------------------------------------------
 * MavenDependencyIndexer — parses all pom.xml files in a workspace and builds
 * a dependency graph for shared library impact analysis.
 * Uses a small purpose-built POM parser (no XML library dependency): only
 * <project>/<dependencies> and <project>/<dependencyManagement> are read.
 *---------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { MavenDep } from './repoIntelligenceDb.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'out', '.gradle']);

function findPomFiles(dir: string, results: string[] = [], depth = 0): string[] {
	if (depth > 6) return results;
	let entries: string[];
	try { entries = readdirSync(dir); } catch { return results; }
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		let stat;
		try { stat = statSync(full); } catch { continue; }
		if (stat.isDirectory()) findPomFiles(full, results, depth + 1);
		else if (entry === 'pom.xml') results.push(full);
	}
	return results;
}

const stripXmlComments = (xml: string): string => xml.replace(/<!--[\s\S]*?-->/g, '');

/** Extract the text of the first `<tag>…</tag>` child (non-greedy, first match only). */
const childText = (xml: string, tag: string): string => {
	const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
	return m ? m[1].trim() : '';
};

/** Return the inner XML of the first top-level `<tag>` block, and the input with that block removed. */
const takeBlock = (xml: string, tag: string): { inner: string; rest: string } => {
	const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`);
	const m = re.exec(xml);
	if (!m) return { inner: '', rest: xml };
	return { inner: m[1], rest: xml.slice(0, m.index) + xml.slice(m.index + m[0].length) };
};

type RawDep = { groupId: string; artifactId: string; version: string; scope: string };

const parseDependencyBlocks = (xml: string): RawDep[] => {
	const deps: RawDep[] = [];
	const re = /<dependency(?:\s[^>]*)?>([\s\S]*?)<\/dependency>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml)) !== null) {
		deps.push({
			groupId: childText(m[1], 'groupId'),
			artifactId: childText(m[1], 'artifactId'),
			version: childText(m[1], 'version'),
			scope: childText(m[1], 'scope'),
		});
	}
	return deps;
};

/**
 * Parse `<project><dependencies>` and `<project><dependencyManagement>` from a POM.
 * Plugin-level and profile-level dependency blocks are ignored, matching the
 * behaviour of the previous xml2js-based implementation.
 */
export const parsePomDependencies = (xml: string): { deps: RawDep[]; managed: RawDep[] } | null => {
	const cleaned = stripXmlComments(xml);
	const project = takeBlock(cleaned, 'project');
	if (!project.inner) return null;

	let body = project.inner;
	// Remove nested scopes that can contain their own <dependencies> blocks.
	body = takeBlock(body, 'build').rest;
	body = takeBlock(body, 'profiles').rest;
	body = takeBlock(body, 'reporting').rest;

	const management = takeBlock(body, 'dependencyManagement');
	const managed = parseDependencyBlocks(takeBlock(management.inner, 'dependencies').inner);
	const deps = parseDependencyBlocks(takeBlock(management.rest, 'dependencies').inner);
	return { deps, managed };
};

export type MavenIndexResult = {
	deps: MavenDep[];
	pomCount: number;
};

export async function indexMavenDependencies(workspaceRoot: string): Promise<MavenIndexResult> {
	const pomFiles = findPomFiles(workspaceRoot);
	const deps: MavenDep[] = [];

	for (const pomPath of pomFiles) {
		let content: string;
		try { content = readFileSync(pomPath, 'utf8'); } catch { continue; }

		const parsed = parsePomDependencies(content);
		if (!parsed) continue;

		const relPath = relative(workspaceRoot, pomPath).replace(/\\/g, '/');

		for (const dep of parsed.deps) {
			if (!dep.groupId || !dep.artifactId) continue;
			deps.push({
				consumerPath: relPath,
				groupId: dep.groupId,
				artifactId: dep.artifactId,
				version: dep.version || undefined,
				scope: dep.scope || undefined,
			});
		}

		for (const dep of parsed.managed) {
			if (!dep.groupId || !dep.artifactId) continue;
			deps.push({
				consumerPath: relPath,
				groupId: dep.groupId,
				artifactId: dep.artifactId,
				version: dep.version || undefined,
				scope: 'management',
			});
		}
	}

	return { deps, pomCount: pomFiles.length };
}
