/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { ImportEdge } from './universalImportExtractor.js';

export type UCGFileNodeInput = {
	filePath: string;
	language: string;
	nodeType: string;
	archLayer: string;
	isEntryPoint: boolean;
	importCount: number;
	importedByCount: number;
};

export type GraphMetrics = {
	totalNodes: number;
	totalEdges: number;
	entryPoints: string[];
	cycleCount: number;
	cycles: string[][];
	maxDepth: number;
	orphanFiles: string[];
	hotFiles: string[];
	externalDeps: Map<string, number>;
};

/** Tarjan's SCC for cycle detection. */
export function detectCycles(
	nodes: string[],
	edges: ImportEdge[],
): string[][] {
	const adj = new Map<string, string[]>();
	for (const n of nodes) {
		adj.set(n, []);
	}
	for (const e of edges) {
		if (e.resolvedFile) {
			adj.get(e.fromFile)?.push(e.resolvedFile);
		}
	}

	const index = new Map<string, number>();
	const lowlink = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const SCCs: string[][] = [];
	let counter = 0;

	function strongConnect(v: string) {
		index.set(v, counter);
		lowlink.set(v, counter);
		counter++;
		stack.push(v);
		onStack.add(v);

		for (const w of (adj.get(v) ?? [])) {
			if (!index.has(w)) {
				strongConnect(w);
				lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
			} else if (onStack.has(w)) {
				lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
			}
		}

		if (lowlink.get(v) === index.get(v)) {
			const scc: string[] = [];
			let w: string;
			do {
				w = stack.pop()!;
				onStack.delete(w);
				scc.push(w);
			} while (w !== v);
			if (scc.length > 1) {
				SCCs.push(scc);
			}
		}
	}

	for (const n of nodes) {
		if (!index.has(n)) {
			strongConnect(n);
		}
	}

	return SCCs;
}

export function computeMetrics(
	nodes: UCGFileNodeInput[],
	edges: ImportEdge[],
): GraphMetrics {
	const nodeSet = new Set(nodes.map(n => n.filePath));
	const inDegree = new Map<string, number>();
	const outDegree = new Map<string, number>();
	const externalDeps = new Map<string, number>();

	for (const n of nodes) {
		inDegree.set(n.filePath, 0);
		outDegree.set(n.filePath, 0);
	}

	for (const e of edges) {
		if (e.isExternal) {
			externalDeps.set(e.toModule, (externalDeps.get(e.toModule) ?? 0) + 1);
		} else if (e.resolvedFile && nodeSet.has(e.resolvedFile)) {
			inDegree.set(e.resolvedFile, (inDegree.get(e.resolvedFile) ?? 0) + 1);
			outDegree.set(e.fromFile, (outDegree.get(e.fromFile) ?? 0) + 1);
		}
	}

	const entryPoints = [...inDegree.entries()]
		.filter(([, deg]) => deg === 0)
		.map(([f]) => f);

	const orphanFiles = nodes
		.filter(n => (inDegree.get(n.filePath) ?? 0) === 0 && (outDegree.get(n.filePath) ?? 0) === 0)
		.map(n => n.filePath);

	const hotFiles = [...inDegree.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([f]) => f);

	const cycles = detectCycles(nodes.map(n => n.filePath), edges);

	return {
		totalNodes: nodes.length,
		totalEdges: edges.length,
		entryPoints,
		cycleCount: cycles.length,
		cycles,
		maxDepth: computeMaxDepth(nodeSet, edges, entryPoints),
		orphanFiles,
		hotFiles,
		externalDeps,
	};
}

/**
 * Depth of the import graph: multi-source BFS from every entry point (in-degree 0) along resolved
 * import edges; the result is the largest number of hops any file sits away from the nearest entry
 * point. Cycles are handled by the visited set. Files unreachable from an entry point (only inside
 * cycles) are seeded afterwards so they still contribute.
 */
export function computeMaxDepth(nodeSet: Set<string>, edges: ImportEdge[], entryPoints: string[]): number {
	const adj = new Map<string, string[]>();
	for (const e of edges) {
		if (e.resolvedFile && nodeSet.has(e.resolvedFile) && nodeSet.has(e.fromFile)) {
			(adj.get(e.fromFile) ?? adj.set(e.fromFile, []).get(e.fromFile)!).push(e.resolvedFile);
		}
	}
	const dist = new Map<string, number>();
	let max = 0;
	const bfs = (seeds: string[]) => {
		const queue: string[] = [];
		for (const s of seeds) { if (!dist.has(s)) { dist.set(s, 0); queue.push(s); } }
		let head = 0;
		while (head < queue.length) {
			const v = queue[head++];
			const d = dist.get(v)!;
			for (const w of adj.get(v) ?? []) {
				if (dist.has(w)) continue;
				dist.set(w, d + 1);
				if (d + 1 > max) max = d + 1;
				queue.push(w);
			}
		}
	};
	bfs(entryPoints);
	// nodes only reachable through a cycle have no entry point: seed them one at a time
	for (const n of nodeSet) if (!dist.has(n)) bfs([n]);
	return max;
}
