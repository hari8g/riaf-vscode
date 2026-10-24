/**
 * Symbol-graph tools (who calls / extends / imports what) — vscode-free so the MCP server can
 * expose them too. The VS Code tool registry layers language-server references on top.
 */
import { formatNeighborhood, type RiafIndex, type SymbolEdge } from '@bosch-mps/riaf-core';
import type { ToolSpec } from '../modelTransport.js';

const str = (d: string) => ({ type: 'string', description: d });
const num = (d: string) => ({ type: 'number', description: d });
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required });

export const GRAPH_TOOL_SPECS: ToolSpec[] = [
	{ name: 'find_references', description: 'Who uses a symbol: callers, instantiations, subclasses/implementors and importers across the workspace, with file:line and the enclosing function. Uses the language server when one is running, otherwise the static symbol graph. Call before changing a function signature or a class.', inputSchema: obj({ name: str('Function / class / type name (simple or Class.method)'), filePath: str('File that defines it, to disambiguate (optional)'), limit: num('Max references, default 50') }, ['name']) },
	{ name: 'get_neighbors', description: 'One-hop neighbourhood of a file or of one symbol in it: what calls into it (and from where), what it calls out to, and the import links. Cheaper than reading the dependents yourself.', inputSchema: obj({ filePath: str('Workspace-relative path'), symbol: str('Restrict to one symbol in that file (optional)') }, ['filePath']) },
];

export const GRAPH_TOOL_NAMES: ReadonlySet<string> = new Set(GRAPH_TOOL_SPECS.map(t => t.name));

const MAX_REFS = 50;

export function formatReferences(name: string, definitions: { filePath: string; startLine: number; kind: string; signature?: string }[], references: SymbolEdge[], source: 'language server' | 'static graph', limit = MAX_REFS): string {
	const lines: string[] = [];
	if (definitions.length) lines.push(`Definitions of ${name}:`, ...definitions.slice(0, 5).map(d => `- ${d.kind} ${d.filePath}:${d.startLine}${d.signature ? ` — ${d.signature.slice(0, 100)}` : ''}`));
	else lines.push(`No definition of ${name} in the symbol index.`);
	if (!references.length) { lines.push(`No references found (${source}).`); return lines.join('\n'); }
	const byFile = new Map<string, SymbolEdge[]>();
	for (const r of references) (byFile.get(r.fromFile) ?? byFile.set(r.fromFile, []).get(r.fromFile)!).push(r);
	lines.push(`${references.length} reference${references.length === 1 ? '' : 's'} in ${byFile.size} file${byFile.size === 1 ? '' : 's'} (${source}):`);
	let shown = 0;
	for (const [file, list] of byFile) {
		for (const r of list) {
			if (shown++ >= limit) break;
			lines.push(`- ${file}:${r.line} ${r.edgeType}${r.fromSymbol ? ` in ${r.fromSymbol}` : ''}`);
		}
	}
	if (references.length > limit) lines.push(`… ${references.length - limit} more; narrow with filePath`);
	return lines.join('\n');
}

/** Run one graph tool with the static index only. Returns `undefined` when `name` is not a graph tool. */
export async function executeGraphTool(index: RiafIndex, name: string, a: Record<string, any>): Promise<string | undefined> {
	switch (name) {
		case 'find_references': {
			const sym = String(a.name ?? '').trim();
			if (!sym) { return 'find_references needs a `name`.'; }
			const limit = Math.max(1, Math.min(200, Number(a.limit) || MAX_REFS));
			const { definitions, references } = await index.findReferences(sym, { filePath: a.filePath || undefined, limit: limit * 2 });
			return formatReferences(sym, definitions, references, 'static graph', limit);
		}
		case 'get_neighbors': {
			const filePath = String(a.filePath ?? '').trim();
			if (!filePath) { return 'get_neighbors needs a `filePath`.'; }
			return formatNeighborhood(await index.getNeighbors(filePath, a.symbol || undefined), 6_000);
		}
		default:
			return undefined;
	}
}
