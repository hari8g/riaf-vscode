/*---------------------------------------------------------------------------
 * GatewayRouteIndexer — parses Spring Cloud Gateway routes from
 * application.yml files. Looks for the standard spring.cloud.gateway.routes
 * configuration block.
 *---------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { GatewayRoute } from './repoIntelligenceDb.js';

function findGatewayConfigFiles(workspaceRoot: string): string[] {
	const SKIP = new Set(['node_modules', '.git', 'target', 'build']);
	const results: string[] = [];

	function walk(dir: string, depth = 0) {
		if (depth > 8) return;
		let entries: string[];
		try { entries = readdirSync(dir); } catch { return; }
		for (const entry of entries) {
			if (SKIP.has(entry)) continue;
			const full = join(dir, entry);
			let stat;
			try { stat = statSync(full); } catch { continue; }
			if (stat.isDirectory()) walk(full, depth + 1);
			else if ((entry === 'application.yml' || entry === 'application.yaml')) {
				results.push(full);
			}
		}
	}

	walk(workspaceRoot);
	return results;
}

export function indexGatewayRoutes(workspaceRoot: string): GatewayRoute[] {
	const configFiles = findGatewayConfigFiles(workspaceRoot);
	const routes: GatewayRoute[] = [];

	for (const filePath of configFiles) {
		let content: string;
		try { content = readFileSync(filePath, 'utf8'); } catch { continue; }

		if (!content.includes('spring.cloud.gateway') && !content.includes('cloud:\n    gateway:')) continue;

		const routeBlockRegex = /- id:\s*([^\n]+)\s*\n\s+uri:\s*([^\n]+)\s*(?:\n\s+.*?)*?predicates:\s*\n(\s+- [^\n]+\n)*/g;
		let match: RegExpExecArray | null;

		while ((match = routeBlockRegex.exec(content)) !== null) {
			const routeId = match[1].trim();
			const uri = match[2].trim();
			const restBlock = match[0];

			const pathMatch = restBlock.match(/Path=([^,\n\]]+)/);
			if (!pathMatch) continue;
			const pathPredicate = pathMatch[1].trim();

			const stripPrefix = /StripPrefix/.test(restBlock);
			const targetService = uri.replace(/^lb:\/\//, '');

			routes.push({ routeId, pathPredicate, targetService, stripPrefix });
		}

		if (routes.length === 0) {
			const simpleRoutes = content.matchAll(/id:\s*([^\n]+)\s*\n.*?uri:\s*(lb:\/\/[^\n]+)\s*\n.*?Path=([^\n,\]]+)/gs);
			for (const m of simpleRoutes) {
				routes.push({
					routeId: m[1].trim(),
					pathPredicate: m[3].trim(),
					targetService: m[2].trim().replace(/^lb:\/\//, ''),
					stripPrefix: false,
				});
			}
		}
	}

	return routes;
}
