/**
 * P1: pure-TS HNSW index — recall against brute force, incremental updates, rebuild — and the
 * content-addressed embedding cache + full-chunk embedding text in RiafIndex.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { bruteForceTopK, HnswIndex } from '../src/hnsw.js';
import { RiafIndex, type IndexProgress } from '../src/riafIndex.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');

/** Deterministic pseudo-random vectors. */
const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const randomVectors = (n: number, dim: number, seed = 42): number[][] => {
	const r = rng(seed);
	return Array.from({ length: n }, () => Array.from({ length: dim }, () => r() * 2 - 1));
};

describe('HnswIndex', () => {
	it('matches brute-force top-k with high recall on 2k random vectors', () => {
		const dim = 32, n = 2000, k = 10;
		const vecs = randomVectors(n, dim);
		const idx = new HnswIndex({ M: 16, efConstruction: 200, efSearch: 128, seed: 7 });
		vecs.forEach((v, i) => idx.add(i, v));
		expect(idx.size).toBe(n);
		expect(idx.dimension).toBe(dim);

		const queries = randomVectors(50, dim, 99);
		let hits = 0;
		for (const q of queries) {
			const exact = new Set(bruteForceTopK(q, vecs.map((v, i) => [i, v] as [number, number[]]), k).map(h => h.id));
			const approx = idx.search(q, k);
			expect(approx).toHaveLength(k);
			// scores are descending cosine similarities
			for (let i = 1; i < approx.length; i++) expect(approx[i - 1].score).toBeGreaterThanOrEqual(approx[i].score);
			hits += approx.filter(h => exact.has(h.id)).length;
		}
		const recall = hits / (queries.length * k);
		expect(recall).toBeGreaterThan(0.9);
	});

	it('is exact on tiny sets and returns the identical vector first', () => {
		const idx = new HnswIndex({ seed: 1 });
		const vecs = randomVectors(20, 8);
		vecs.forEach((v, i) => idx.add(i + 100, v));
		const top = idx.search(vecs[5], 3);
		expect(top[0].id).toBe(105);
		expect(top[0].score).toBeCloseTo(1, 5);
		expect(idx.search(vecs[0], 0)).toEqual([]);
		expect(idx.search([1, 2, 3], 3), 'dimension mismatch → no hits').toEqual([]);
	});

	it('supports remove, replace and rebuild without losing live vectors', () => {
		const idx = new HnswIndex({ seed: 3 });
		const vecs = randomVectors(300, 16);
		vecs.forEach((v, i) => idx.add(i, v));
		for (let i = 0; i < 300; i += 3) idx.remove(i);
		expect(idx.size).toBe(200);
		expect(idx.deletedRatio).toBeCloseTo(1 / 3, 2);
		expect(idx.has(0)).toBe(false);
		expect(idx.has(1)).toBe(true);
		// deleted ids never come back from a search
		for (const q of randomVectors(20, 16, 5)) for (const h of idx.search(q, 10)) expect(h.id % 3).not.toBe(0);
		// re-adding a removed id replaces it
		idx.add(0, vecs[1]);
		expect(idx.has(0)).toBe(true);
		expect(idx.search(vecs[1], 2).map(h => h.id).sort()).toEqual([0, 1]);
		// rebuild compacts and keeps results
		const before = idx.search(vecs[7], 5).map(h => h.id);
		idx.rebuild();
		expect(idx.deletedRatio).toBe(0);
		expect(idx.size).toBe(201);
		expect(idx.search(vecs[7], 5).map(h => h.id)).toEqual(before);
		expect(idx.ids()).toHaveLength(201);
		// removing the entry point keeps the index searchable
		const allIds = idx.ids();
		for (const id of allIds.slice(0, 150)) idx.remove(id);
		expect(idx.search(vecs[allIds[180]], 1)[0].id).toBe(allIds[180]);
	});

	it('rejects vectors of a different dimension', () => {
		const idx = new HnswIndex();
		idx.add(1, [1, 0, 0]);
		expect(() => idx.add(2, [1, 0])).toThrow(/dimension/);
	});
});

describe('RiafIndex embeddings: cache + full-chunk text', () => {
	const dirs: string[] = [];
	afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
	const toyEmbed = (text: string): number[] => {
		const v = new Array(26).fill(0);
		for (const ch of text.toLowerCase()) { const i = ch.charCodeAt(0) - 97; if (i >= 0 && i < 26) v[i] += 1; }
		return v;
	};

	it('sends the whole chunk with a path header, caches by content hash, and reuses vectors across runs and files', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'riaf-cache-'));
		dirs.push(dir);
		const root = join(dir, 'repo');
		cpSync(FIXTURE, root, { recursive: true });
		const dbPath = join(dir, 'idx.sqlite');
		const sent: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { input: string[] };
			sent.push(...body.input);
			return new Response(JSON.stringify({ data: body.input.map((t, i) => ({ index: i, embedding: toyEmbed(t) })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
		}) as typeof fetch;
		const cfg = { workspaceRoot: root, dbPath, embeddings: { enabled: true, url: 'http://e.test/v1/embeddings', model: 'toy' } };
		try {
			const a = await RiafIndex.open(cfg);
			await a.reindex();
			const firstPass = sent.length;
			expect(firstPass).toBeGreaterThan(0);
			// full chunk text (not a 512-char prefix) with the file path as the first line
			const svc = sent.find(t => t.startsWith('// src/orderService.ts\n'))!;
			expect(svc).toBeDefined();
			expect(svc).toContain('capturePayment(id: string): boolean');
			expect(svc.length).toBeGreaterThan(512);
			expect((await a.searchHybrid('capture payment')).map(r => r.filePath)).toContain('src/orderService.ts');
			expect(sent.length).toBe(firstPass + 1);                       // the query itself
			expect((await a.searchHybrid('capture payment')).length).toBeGreaterThan(0);
			expect(sent.length, 'repeated query served from cache').toBe(firstPass + 1);
			await a.flush();
			await a.close();

			// force reindex re-chunks everything, but every embedding comes from the cache
			const b = await RiafIndex.open(cfg);
			const progress: IndexProgress[] = [];
			await b.reindex({ force: true, onProgress: p => progress.push(p) });
			expect(sent.length).toBe(firstPass + 1);
			expect(progress.filter(p => p.phase === 'embeddings').at(-1)?.message).toMatch(/from cache/);
			// the query cache is persisted too: same query in a new process → no request
			expect((await b.searchHybrid('capture payment')).map(r => r.filePath)).toContain('src/orderService.ts');
			expect(sent.length).toBe(firstPass + 1);

			// a copied file produces identical chunk text only if the path header matches — a *moved*
			// chunk with the same text under a new path is a miss once, then cached
			writeFileSync(join(root, 'src', 'logger2.ts'), await import('fs').then(m => m.readFileSync(join(root, 'src', 'logger.ts'), 'utf8')));
			await b.indexFiles(['src/logger2.ts']);
			const afterCopy = sent.length;
			expect(afterCopy).toBeGreaterThan(firstPass + 1);
			await b.indexFiles(['src/logger2.ts']);   // unchanged → no chunk rewrite, no request
			expect(sent.length).toBe(afterCopy);
			// and the ANN index answers for the new file
			expect((await b.searchHybrid('logger info', { limit: 10 })).map(r => r.filePath)).toContain('src/logger2.ts');
			await b.close();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
