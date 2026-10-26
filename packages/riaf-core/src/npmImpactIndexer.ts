/*---------------------------------------------------------------------------
 * NpmImpactIndexer — builds an NPM package dependency graph across all
 * package.json files in the workspace. Tracks @mobilitystore/* and @bosch/*
 * scoped packages for STaaS shared library impact analysis.
 *---------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { DEFAULT_ORG_EXTENSION_NPM_SCOPES } from './staasIndexerDefaults.js';
import { NpmPackageEdge } from './repoIntelligenceDb.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);

function findPackageJsonFiles(dir: string, results: string[] = [], depth = 0): string[] {
	if (depth > 8) return results;
	let entries: string[];
	try { entries = readdirSync(dir); } catch { return results; }
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		let stat;
		try { stat = statSync(full); } catch { continue; }
		if (stat.isDirectory()) findPackageJsonFiles(full, results, depth + 1);
		else if (entry === 'package.json') results.push(full);
	}
	return results;
}

export type NpmImpactResult = {
	edges: NpmPackageEdge[];
	packageJsonCount: number;
};

export function indexNpmDependencies(workspaceRoot: string, scopeFilter?: string[]): NpmImpactResult {
	const packageJsonFiles = findPackageJsonFiles(workspaceRoot);
	const edges: NpmPackageEdge[] = [];
	const defaultScopes = scopeFilter ?? [...DEFAULT_ORG_EXTENSION_NPM_SCOPES];

	for (const pkgPath of packageJsonFiles) {
		let pkg: any;
		try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { continue; }
		const relPath = relative(workspaceRoot, pkgPath).replace(/\\/g, '/');

		for (const depType of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
			const deps = pkg[depType] ?? {};
			for (const [packageName, version] of Object.entries<string>(deps)) {
				const isScoped = defaultScopes.some(s => packageName.startsWith(s));
				if (!isScoped) continue;
				edges.push({ consumerPath: relPath, packageName, version, depType });
			}
		}
	}

	return { edges, packageJsonCount: packageJsonFiles.length };
}
