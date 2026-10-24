import { describe, it } from 'vitest';
import assert from 'node:assert';
import { detectCycles, computeMetrics } from '../src/universalGraphAnalyzer.js';

describe('UniversalGraphAnalyzer', () => {
	it('detects import cycles', () => {
		const nodes = ['a.ts', 'b.ts', 'c.ts'];
		const edges = [
			{ fromFile: 'a.ts', toModule: './b', resolvedFile: 'b.ts', isExternal: false, edgeType: 'import' as const },
			{ fromFile: 'b.ts', toModule: './c', resolvedFile: 'c.ts', isExternal: false, edgeType: 'import' as const },
			{ fromFile: 'c.ts', toModule: './a', resolvedFile: 'a.ts', isExternal: false, edgeType: 'import' as const },
		];
		const cycles = detectCycles(nodes, edges);
		assert.ok(cycles.length >= 1);
	});

	it('computes entry points and hot files', () => {
		const nodes = [
			{ filePath: 'main.ts', language: 'TypeScript', nodeType: 'entry', archLayer: 'entry', isEntryPoint: false, importCount: 1, importedByCount: 0 },
			{ filePath: 'util.ts', language: 'TypeScript', nodeType: 'util', archLayer: 'service', isEntryPoint: false, importCount: 0, importedByCount: 0 },
			{ filePath: 'a.ts', language: 'TypeScript', nodeType: 'service', archLayer: 'service', isEntryPoint: false, importCount: 1, importedByCount: 0 },
			{ filePath: 'b.ts', language: 'TypeScript', nodeType: 'service', archLayer: 'service', isEntryPoint: false, importCount: 0, importedByCount: 0 },
		];
		const edges = [
			{ fromFile: 'main.ts', toModule: './util', resolvedFile: 'util.ts', isExternal: false, edgeType: 'import' as const },
			{ fromFile: 'a.ts', toModule: './b', resolvedFile: 'b.ts', isExternal: false, edgeType: 'import' as const },
			{ fromFile: 'main.ts', toModule: 'react', resolvedFile: null, isExternal: true, edgeType: 'import' as const },
		];
		const metrics = computeMetrics(nodes, edges);
		assert.ok(metrics.entryPoints.includes('main.ts'));
		assert.ok(metrics.hotFiles.includes('util.ts') || metrics.hotFiles.includes('b.ts'));
		assert.strictEqual(metrics.externalDeps.get('react'), 1);
	});
});
