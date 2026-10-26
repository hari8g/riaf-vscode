/*---------------------------------------------------------------------------
 * ConfigEnvIndexer — parses application-{env}.yml files across all Spring
 * Boot services and identifies property drift between environments.
 *---------------------------------------------------------------------------*/

import { DEFAULT_ORG_EXTENSION_CONFIG_SERVER_DIRS } from './staasIndexerDefaults.js';

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build']);

// Spring Boot local config style: application-dev.yml
const ENV_PATTERN_LOCAL = /application-(\w+)\.(yml|yaml)$/;

// Spring Cloud Config server style: {service-name}-{env}.yml
// Matches anything ending in a known env name suffix
const KNOWN_ENV_SUFFIX = '(?:dev|qa|sit|uat|staging|stage|prod|production|local|test|int)';
const ENV_PATTERN_CLOUD = new RegExp(`[\\w-]+-(${ KNOWN_ENV_SUFFIX })\\.(yml|yaml)$`, 'i');

export type ConfigProperty = {
	filePath: string;
	serviceName: string;
	env: string;
	key: string;
	value: string;
};

export type EnvDrift = {
	key: string;
	serviceName: string;
	envValues: Record<string, string>;
};

function collectConfigFiles(dir: string, results: string[] = [], depth = 0): string[] {
	if (depth > 8) return results;
	let entries: string[];
	try { entries = readdirSync(dir); } catch { return results; }
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		let stat;
		try { stat = statSync(full); } catch { continue; }
		if (stat.isDirectory()) collectConfigFiles(full, results, depth + 1);
		else if (ENV_PATTERN_LOCAL.test(entry) || ENV_PATTERN_CLOUD.test(entry)) results.push(full);
	}
	return results;
}

function deriveServiceName(filePath: string): string {
	const normalized = filePath.split(sep).join('/');
	const parts = normalized.split('/');
	for (let i = parts.length - 1; i >= 0; i--) {
		if (parts[i].startsWith('staas-') || parts[i].includes('-service') || parts[i].includes('-management')) {
			return parts[i];
		}
	}
	return parts[parts.length - 3] ?? 'unknown';
}

function flatParseYaml(content: string): Record<string, string> {
	const results: Record<string, string> = {};
	const lines = content.split('\n');
	const stack: { indent: number; key: string }[] = [];

	for (const line of lines) {
		if (!line.trim() || line.trim().startsWith('#')) continue;
		const indent = line.length - line.trimStart().length;
		const keyValueMatch = line.match(/^(\s*)([^:]+):\s*(.*)$/);
		if (!keyValueMatch) continue;

		const key = keyValueMatch[2].trim();
		const value = keyValueMatch[3].trim();

		while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
		const fullKey = [...stack.map(s => s.key), key].join('.');

		if (value && !value.startsWith('{') && !value.startsWith('[')) {
			results[fullKey] = value;
		} else {
			stack.push({ indent, key });
		}
	}
	return results;
}

export type ConfigIndexResult = {
	properties: ConfigProperty[];
	envDrift: EnvDrift[];
	fileCount: number;
};

export type ConfigIndexOptions = {
	configServerDirs?: readonly string[];
};

export function indexConfigEnvironments(workspaceRoot: string, options?: ConfigIndexOptions): ConfigIndexResult {
	const configFiles = collectConfigFiles(workspaceRoot);

	const configServiceCandidates = (options?.configServerDirs ?? DEFAULT_ORG_EXTENSION_CONFIG_SERVER_DIRS)
		.map(dir => join(workspaceRoot, dir));
	for (const candidate of configServiceCandidates) {
		try {
			statSync(candidate);
			collectConfigFiles(candidate, configFiles, 0);
		} catch { /* directory doesn't exist */ }
	}

	// Deduplicate in case the config service dir was already scanned by root traversal
	const uniqueConfigFiles = [...new Set(configFiles)];

	const allProperties: ConfigProperty[] = [];

	for (const filePath of uniqueConfigFiles) {
		const fileName = filePath.split(/[/\\]/).at(-1) ?? '';
		const localMatch = fileName.match(ENV_PATTERN_LOCAL);
		const cloudMatch = fileName.match(ENV_PATTERN_CLOUD);
		const env = localMatch ? localMatch[1] : cloudMatch ? cloudMatch[1].toLowerCase() : undefined;
		if (!env) continue;
		const serviceName = deriveServiceName(filePath);

		let content: string;
		try { content = readFileSync(filePath, 'utf8'); } catch { continue; }

		const parsed = flatParseYaml(content);
		const relPath = relative(workspaceRoot, filePath).replace(/\\/g, '/');

		for (const [key, value] of Object.entries(parsed)) {
			allProperties.push({ filePath: relPath, serviceName, env, key, value });
		}
	}

	const grouped = new Map<string, Map<string, string>>();
	for (const prop of allProperties) {
		const compositeKey = `${prop.serviceName}::${prop.key}`;
		if (!grouped.has(compositeKey)) grouped.set(compositeKey, new Map());
		grouped.get(compositeKey)!.set(prop.env, prop.value);
	}

	const envDrift: EnvDrift[] = [];
	for (const [compositeKey, envValues] of grouped.entries()) {
		if (envValues.size < 2) continue;
		const values = Array.from(envValues.values());
		const hasDrift = values.some(v => v !== values[0]);
		if (!hasDrift) continue;
		const [serviceName, ...keyParts] = compositeKey.split('::');
		envDrift.push({
			key: keyParts.join('::'),
			serviceName,
			envValues: Object.fromEntries(envValues),
		});
	}

	return { properties: allProperties, envDrift, fileCount: configFiles.length };
}
