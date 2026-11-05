/**
 * Project rules for the system prompt: AGENTS.md at the workspace root (and in the active file's
 * nearest parent directories), plus every markdown file under .riaf/rules/. Bounded so a verbose
 * rules folder cannot crowd out the conversation. No `vscode` import.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

export const RULES_MAX_CHARS = 12_000;

export type ProjectRules = { text: string; sources: string[] };

const read = (abs: string): string => { try { return readFileSync(abs, 'utf8').trim(); } catch { return ''; } };

/** Rule files that apply: root AGENTS.md, .riaf/rules/*.md (sorted), nested AGENTS.md on the active file's path. */
export function findRuleFiles(workspaceRoot: string, activeFile?: string): string[] {
	const files: string[] = [];
	for (const name of ['AGENTS.md', '.riaf/AGENTS.md']) { if (existsSync(join(workspaceRoot, name))) { files.push(name); } }
	const rulesDir = join(workspaceRoot, '.riaf', 'rules');
	if (existsSync(rulesDir) && statSync(rulesDir).isDirectory()) {
		for (const f of readdirSync(rulesDir).filter(f => /\.(md|mdc|txt)$/i.test(f)).sort()) { files.push(posix.join('.riaf', 'rules', f)); }
	}
	if (activeFile) {
		// nearest-first nested AGENTS.md between the file and the root (root one already included)
		let dir = dirname(activeFile.replace(/\\/g, '/'));
		const nested: string[] = [];
		while (dir && dir !== '.' && dir !== '/') {
			const candidate = posix.join(dir, 'AGENTS.md');
			if (existsSync(join(workspaceRoot, candidate))) { nested.push(candidate); }
			dir = dirname(dir);
		}
		files.push(...nested.reverse());
	}
	return [...new Set(files)];
}

export function loadProjectRules(workspaceRoot: string, activeFile?: string, maxChars = RULES_MAX_CHARS): ProjectRules {
	const sources = findRuleFiles(workspaceRoot, activeFile);
	const parts: string[] = [];
	let used = 0;
	for (const rel of sources) {
		const body = read(join(workspaceRoot, rel));
		if (!body) { continue; }
		const budget = maxChars - used;
		if (budget <= 200) { parts.push(`<!-- ${rel} omitted: rules budget exhausted -->`); break; }
		const clipped = body.length > budget ? `${body.slice(0, budget - 1)}…` : body;
		parts.push(`### ${rel}\n${clipped}`);
		used += clipped.length + rel.length + 6;
	}
	return { text: parts.join('\n\n'), sources };
}
