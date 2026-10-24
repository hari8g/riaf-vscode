import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RepoIntelligenceDb, buildFtsQuery, hashWorkspaceRoot, splitIdentifiers } from '../src/repoIntelligenceDb.js';
import type { WorkspaceProfile } from '../src/repoIntelligenceTypes.js';

const emptyProfile = (workspaceRoot: string): WorkspaceProfile => ({
	workspaceRoot,
	lastScannedAt: Date.now(),
	languageStack: ['TypeScript'],
	frameworks: [],
	packageManagers: [],
	buildCommands: [],
	testCommands: [],
	lintCommands: [],
	typecheckCommands: [],
	projectPurpose: null,
	architectureSummary: null,
	fileCount: 3,
	totalLoc: 30,
	isStale: false,
});

describe('RepoIntelligenceDb (sqlite-wasm driver)', () => {
	let dir: string;
	let dbPath: string;
	let db: RepoIntelligenceDb;
	const hash = hashWorkspaceRoot('/tmp/riaf-db-test');

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'riaf-db-'));
		dbPath = join(dir, 'nested', 'riaf.sqlite');
		db = new RepoIntelligenceDb(dbPath, { persistDebounceMs: 50 });
		await db.init();
		await db.upsertProfile(hash, emptyProfile('/tmp/riaf-db-test'), [
			{ filePath: 'src/auth/login.ts', language: 'TypeScript', lastModified: 1, sizeBytes: 10 },
			{ filePath: 'src/orders/OrderController.ts', language: 'TypeScript', lastModified: 1, sizeBytes: 10 },
			{ filePath: 'src/util/math.py', language: 'Python', lastModified: 1, sizeBytes: 10 },
		]);
		await db.replaceChunks(hash, [
			{
				id: 'c1', filePath: 'src/auth/login.ts', startLine: 1, endLine: 3, chunkType: 'function',
				chunkText: 'export async function authenticateUser(credentials: Credentials) {\n  return validateSession(credentials);\n}',
			},
			{
				id: 'c2', filePath: 'src/orders/OrderController.ts', startLine: 5, endLine: 12, chunkType: 'class',
				chunkText: 'export class OrderController {\n  createOrder(dto: CreateOrderDto) {\n    return this.orderService.create(dto);\n  }\n}',
			},
			{
				id: 'c3', filePath: 'src/util/math.py', startLine: 1, endLine: 4, chunkType: 'function',
				chunkText: 'def add_numbers(a, b):\n    """Add two numbers."""\n    return a + b\n',
			},
		]);
	});

	afterAll(async () => {
		await db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it('supports FTS5 + bm25 and ranks the best match first', async () => {
		const results = await db.searchChunks(hash, 'authenticate session', 5);
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0].filePath).toBe('src/auth/login.ts');
		// bm25() returns negative scores; the best match has the lowest value.
		for (let i = 1; i < results.length; i++) {
			expect(results[i - 1].score).toBeLessThanOrEqual(results[i].score);
		}
	});

	it('splits camelCase identifiers so multi-word queries match', async () => {
		const results = await db.searchChunks(hash, 'order controller', 5);
		expect(results[0].filePath).toBe('src/orders/OrderController.ts');

		const py = await db.searchChunks(hash, 'add numbers', 5);
		expect(py[0].filePath).toBe('src/util/math.py');
	});

	it('returns nothing for a nonsense query', async () => {
		expect(await db.searchChunks(hash, 'xyzzy quantum entanglement', 5)).toEqual([]);
	});

	it('hybrid search falls back to BM25 when no query embedding is given', async () => {
		const results = await db.searchChunksHybrid(hash, 'authenticate', null, 5);
		expect(results.length).toBe(1);
		expect(results[0].filePath).toBe('src/auth/login.ts');
	});

	it('hybrid search fuses BM25 and vector ranks with RRF (K=60)', async () => {
		await db.upsertChunkEmbedding(hash, 'src/auth/login.ts', 1, [1, 0, 0]);
		await db.upsertChunkEmbedding(hash, 'src/orders/OrderController.ts', 5, [0, 1, 0]);
		await db.upsertChunkEmbedding(hash, 'src/util/math.py', 1, [0, 0, 1]);

		// Query text matches OrderController by BM25; query vector points at math.py.
		const results = await db.searchChunksHybrid(hash, 'order controller', [0, 0, 1], 5);
		const keys = results.map(r => r.filePath);
		expect(keys).toContain('src/orders/OrderController.ts');
		expect(keys).toContain('src/util/math.py');
		// math.py: vector rank 1 only → 1/(60+1). OrderController: BM25 rank 1 + vector rank 3
		// (every embedded chunk lands in the vector top-K) → 1/61 + 1/63, so it ranks first.
		const orderScore = results.find(r => r.filePath === 'src/orders/OrderController.ts')!.score;
		const mathScore = results.find(r => r.filePath === 'src/util/math.py')!.score;
		expect(mathScore).toBeCloseTo(1 / 61, 10);
		expect(orderScore).toBeCloseTo(1 / 61 + 1 / 63, 10);
		expect(results[0].filePath).toBe('src/orders/OrderController.ts');
	});

	it('reports indexing stats from the database', async () => {
		const stats = await db.getIndexingStats(hash);
		expect(stats.chunkCount).toBe(3);
		expect(stats.indexedFileCount).toBe(3);
		expect(stats.totalFileCount).toBe(3);
		expect(stats.chunksByType).toEqual({ function: 2, class: 1 });
		expect(stats.filesByLanguage).toEqual({ TypeScript: 2, Python: 1 });
		expect(stats.statsSource).toBe('database');
	});

	it('persists to disk (debounced) and round-trips through export/load', async () => {
		await db.flush();
		expect(existsSync(dbPath)).toBe(true);
		const bytes = readFileSync(dbPath);
		expect(bytes.subarray(0, 15).toString('utf8')).toBe('SQLite format 3');

		const exported = await db.export();
		expect(exported.length).toBe(bytes.length);

		// Re-open from the file in a second instance and query it.
		const db2 = new RepoIntelligenceDb(dbPath);
		await db2.init();
		try {
			expect(await db2.getChunkCount(hash)).toBe(3);
			const results = await db2.searchChunks(hash, 'authenticate', 5);
			expect(results[0].filePath).toBe('src/auth/login.ts');
			const profile = await db2.getProfile(hash);
			expect(profile?.workspaceRoot).toBe('/tmp/riaf-db-test');
		} finally {
			await db2.close();
		}
	});

	it('writes the image automatically after the debounce window', async () => {
		const freshDir = mkdtempSync(join(tmpdir(), 'riaf-db-auto-'));
		const freshPath = join(freshDir, 'auto.sqlite');
		const auto = new RepoIntelligenceDb(freshPath, { persistDebounceMs: 20 });
		await auto.init();
		await auto.upsertProfile(hash, emptyProfile('/x'), []);
		await new Promise(r => setTimeout(r, 120));
		expect(existsSync(freshPath)).toBe(true);
		await auto.close();
		rmSync(freshDir, { recursive: true, force: true });
	});

	it('never touches disk for in-memory databases', async () => {
		const mem = new RepoIntelligenceDb(':memory:');
		await mem.init();
		await mem.upsertProfile(hash, emptyProfile('/mem'), []);
		await mem.flush();
		expect(await mem.getProfile(hash)).not.toBeNull();
		await mem.close();
	});
});

describe('FTS query helpers', () => {
	it('splitIdentifiers handles camelCase, snake_case, kebab-case and dots', () => {
		expect(splitIdentifiers('OrderController')).toBe('Order Controller');
		expect(splitIdentifiers('parseHTTPResponse')).toBe('parse HTTP Response');
		expect(splitIdentifiers('snake_case_name')).toBe('snake case name');
		expect(splitIdentifiers('kebab-case')).toBe('kebab case');
		expect(splitIdentifiers('foo.bar')).toBe('foo bar');
	});

	it('buildFtsQuery produces OR-ed prefix terms and drops short tokens', () => {
		expect(buildFtsQuery('OrderController a')).toBe('"order"* OR "controller"*');
		expect(buildFtsQuery('x')).toBeNull();
		expect(buildFtsQuery('"quoted" (parens)')).toBe('"quoted"* OR "parens"*');
	});
});
