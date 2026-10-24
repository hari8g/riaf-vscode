/*---------------------------------------------------------------------------
 * KubernetesYamlIndexer — parses K8s manifest YAML files.
 * Regex-based (no js-yaml) for minimal dependency footprint.
 *---------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { K8sResource } from './repoIntelligenceDb.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build']);
const K8S_KINDS = new Set([
	'Deployment', 'Service', 'Ingress', 'ConfigMap', 'Secret',
	'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'HorizontalPodAutoscaler',
]);

function collectYamlFiles(dir: string, results: string[] = [], depth = 0): string[] {
	if (depth > 6) return results;
	let entries: string[];
	try { entries = readdirSync(dir); } catch { return results; }
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		let stat;
		try { stat = statSync(full); } catch { continue; }
		if (stat.isDirectory()) collectYamlFiles(full, results, depth + 1);
		else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) results.push(full);
	}
	return results;
}

function inferEnvLabel(filePath: string): string | undefined {
	const lower = filePath.toLowerCase();
	for (const env of ['prod', 'stage', 'qa', 'dev']) {
		if (lower.includes(env)) return env;
	}
	return undefined;
}

function extractYamlScalar(content: string, key: string): string | undefined {
	const regex = new RegExp(`^${key}:\\s*(.+)$`, 'm');
	return content.match(regex)?.[1]?.trim();
}

function extractMetadataName(block: string): string | undefined {
	const nameMatch = block.match(/^metadata:\s*\n(?:(?:  [^\n]*)\n)*\s+name:\s*(.+)/m);
	return nameMatch?.[1]?.trim();
}

function extractNamespace(block: string): string | undefined {
	const nsMatch = block.match(/namespace:\s*(.+)/);
	return nsMatch?.[1]?.trim();
}

function extractImage(block: string): string | undefined {
	const imageMatch = block.match(/^\s+image:\s*(.+)$/m);
	return imageMatch?.[1]?.trim();
}

export function indexKubernetesManifests(workspaceRoot: string, configDir?: string): K8sResource[] {
	const searchDir = configDir ?? workspaceRoot;
	const yamlFiles = collectYamlFiles(searchDir);
	const resources: K8sResource[] = [];

	for (const filePath of yamlFiles) {
		let content: string;
		try { content = readFileSync(filePath, 'utf8'); } catch { continue; }

		const relPath = relative(workspaceRoot, filePath);
		const envLabel = inferEnvLabel(filePath);

		const documents = content.split(/^---\s*$/m).filter(d => d.trim().length > 0);

		for (const doc of documents) {
			const kind = extractYamlScalar(doc, 'kind');
			if (!kind || !K8S_KINDS.has(kind)) continue;

			const name = extractMetadataName(doc);
			if (!name) continue;

			const namespace = extractNamespace(doc);
			const imageTag = kind === 'Deployment' ? extractImage(doc) : undefined;

			resources.push({ filePath: relPath, kind, name, namespace, envLabel, imageTag });
		}
	}

	return resources;
}
