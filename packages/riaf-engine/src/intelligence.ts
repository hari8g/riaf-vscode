/** Search boosts, test/source pairs, context documents, and graph grouping. No VS Code dependency. */

export function sourceForTest(file: string): string | null {
	const path = file.replace(/\\/g, '/');
	if (path.endsWith('Test.java')) {
		const source = path.replace(/Test\.java$/, '.java');
		return source === path ? null : source;
	}
	const match = path.match(/^(.*?)(?:\.test|\.spec|_test)(\.[^.]+)$/);
	if (!match) { return null; }
	const source = `${match[1]}${match[2]}`;
	return source === path ? null : source;
}

export function conventionalTestPaths(source: string): string[] {
	const path = source.replace(/\\/g, '/');
	const match = path.match(/^(.*)(\.[^.]+)$/);
	if (!match) { return []; }
	if (match[2] === '.java') { return [`${match[1]}Test.java`]; }
	if (match[2] === '.go') { return [`${match[1]}_test.go`]; }
	return [`${match[1]}.test${match[2]}`, `${match[1]}.spec${match[2]}`];
}

/** Pairs a test file with the source file it most likely covers. */
export function testSourceMap(files: string[]): { testFile: string; sourceFile: string; present: boolean }[] {
	const known = new Set(files.map(f => f.replace(/\\/g, '/')));
	const pairs: { testFile: string; sourceFile: string; present: boolean }[] = [];
	for (const file of known) {
		const source = sourceForTest(file);
		if (!source) { continue; }
		pairs.push({ testFile: file, sourceFile: source, present: known.has(source) });
	}
	return pairs;
}

export function rememberInteraction(entries: string[], file: string, limit = 40): string[] {
	const path = file.replace(/\\/g, '/');
	if (!path) { return entries; }
	return [path, ...entries.filter(e => e !== path)].slice(0, limit);
}

export function readInteractionList(text: string): string[] {
	try {
		const raw = JSON.parse(text);
		return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
	} catch { return []; }
}

type CoChange = Map<string, Map<string, number>> | Record<string, Record<string, number>>;

function coChangeCount(table: CoChange | undefined, active: string | undefined, file: string): number {
	if (!table || !active) { return 0; }
	if (table instanceof Map) { return table.get(active)?.get(file) ?? 0; }
	return table[active]?.[file] ?? 0;
}

/** Raise files that changed with the active file, and files the session has already opened. */
export function applySearchBoosts<T extends { filePath: string; score: number }>(
	hits: T[],
	opts: { activeFile?: string; recent?: string[]; coChange?: CoChange },
): T[] {
	const recent = new Set((opts.recent ?? []).map(f => f.replace(/\\/g, '/')));
	const active = opts.activeFile?.replace(/\\/g, '/');
	return hits.map(hit => {
		const path = hit.filePath.replace(/\\/g, '/');
		const together = Math.min(5, coChangeCount(opts.coChange, active, path));
		const score = hit.score + together * 0.02 + (recent.has(path) ? 0.05 : 0);
		return { ...hit, score };
	}).sort((a, b) => b.score - a.score);
}

export function renderContextDocument(opts: { name: string; report: string; summary?: string; pairs?: { testFile: string; sourceFile: string }[] }): string {
	const lines = [`# ${opts.name} context`, ''];
	if (opts.summary?.trim()) { lines.push('## Summary', '', opts.summary.trim(), ''); }
	if (opts.pairs?.length) {
		lines.push('## Tests', '', ...opts.pairs.slice(0, 40).map(p => `- \`${p.testFile}\` covers \`${p.sourceFile}\``), '');
	}
	lines.push('## Index', '', opts.report.trim(), '');
	return lines.join('\n');
}

export type GraphNodeIn = { id: string; layer?: string; filePath?: string };
export type GraphEdgeIn = { from: string; to: string };

export function packageOf(filePath: string): string {
	const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
	if (parts.length <= 1) { return '(root)'; }
	if (parts[0] === 'src' || parts[0] === 'packages') { return parts.slice(0, 2).join('/'); }
	return parts[0];
}

/** Layer label, package bucket, and import depth for the context graph. Cycles stay at depth 0. */
export function decorateGraph(nodes: GraphNodeIn[], edges: GraphEdgeIn[]): { id: string; layer: string; packageName: string; depth: number }[] {
	const incoming = new Map<string, string[]>();
	for (const node of nodes) { incoming.set(node.id, []); }
	for (const edge of edges) { incoming.get(edge.to)?.push(edge.from); }
	const depth = new Map<string, number>();
	const visiting = new Set<string>();
	const walk = (id: string): number => {
		const known = depth.get(id);
		if (known !== undefined) { return known; }
		if (visiting.has(id)) { return 0; }
		visiting.add(id);
		const parents = (incoming.get(id) ?? []).filter(parent => !visiting.has(parent));
		const value = parents.length ? 1 + Math.max(...parents.map(walk)) : 0;
		visiting.delete(id);
		depth.set(id, value);
		return value;
	};
	for (const node of nodes) { walk(node.id); }
	return nodes.map(node => ({
		id: node.id,
		layer: node.layer || 'unknown',
		packageName: packageOf(node.filePath || node.id),
		depth: depth.get(node.id) ?? 0,
	}));
}
