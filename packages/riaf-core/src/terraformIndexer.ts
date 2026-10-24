/*---------------------------------------------------------------------------
 * TerraformIndexer — regex-based parser for .tf (Terraform HCL) files.
 *---------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.terraform', 'target', 'build', '.terraform.lock.hcl']);

export type TerraformResource = {
	filePath: string;
	resourceType: string;
	resourceName: string;
	provider: string;
};

export type TerraformModule = {
	filePath: string;
	moduleName: string;
	source: string;
};

export type TerraformIndexResult = {
	resources: TerraformResource[];
	modules: TerraformModule[];
	providers: string[];
	fileCount: number;
};

function collectTfFiles(dir: string, results: string[] = [], depth = 0): string[] {
	if (depth > 6) return results;
	let entries: string[];
	try { entries = readdirSync(dir); } catch { return results; }
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry) || entry.endsWith('.tfstate') || entry.endsWith('.tfvars')) continue;
		const full = join(dir, entry);
		let stat;
		try { stat = statSync(full); } catch { continue; }
		if (stat.isDirectory()) collectTfFiles(full, results, depth + 1);
		else if (entry.endsWith('.tf')) results.push(full);
	}
	return results;
}

export function indexTerraformResources(workspaceRoot: string): TerraformIndexResult {
	const tfFiles = collectTfFiles(workspaceRoot);
	const resources: TerraformResource[] = [];
	const modules: TerraformModule[] = [];
	const providerSet = new Set<string>();

	for (const filePath of tfFiles) {
		let content: string;
		try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
		const relPath = relative(workspaceRoot, filePath);

		const resourceRegex = /^resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/gm;
		let match: RegExpExecArray | null;
		while ((match = resourceRegex.exec(content)) !== null) {
			const resourceType = match[1];
			const resourceName = match[2];
			const provider = resourceType.split('_')[0];
			providerSet.add(provider);
			resources.push({ filePath: relPath, resourceType, resourceName, provider });
		}

		const moduleRegex = /^module\s+"([^"]+)"\s*\{[^}]*source\s*=\s*"([^"]+)"/gms;
		let modMatch: RegExpExecArray | null;
		while ((modMatch = moduleRegex.exec(content)) !== null) {
			modules.push({ filePath: relPath, moduleName: modMatch[1], source: modMatch[2] });
		}

		const providerRegex = /^provider\s+"([^"]+)"/gm;
		let provMatch: RegExpExecArray | null;
		while ((provMatch = providerRegex.exec(content)) !== null) {
			providerSet.add(provMatch[1]);
		}
	}

	return {
		resources,
		modules,
		providers: Array.from(providerSet),
		fileCount: tfFiles.length,
	};
}
