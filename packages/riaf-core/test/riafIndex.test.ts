import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { RiafIndex, type IndexProgress } from '../src/riafIndex.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');

describe('RiafIndex end-to-end on the sample repo', () => {
	let dir: string;
	let workspaceRoot: string;
	let dbPath: string;
	let index: RiafIndex;
	const logs: string[] = [];
	const progress: IndexProgress[] = [];

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'riaf-index-'));
		workspaceRoot = join(dir, 'repo');
		cpSync(FIXTURE, workspaceRoot, { recursive: true });
		dbPath = join(dir, 'riaf.sqlite');
		index = await RiafIndex.open({
			workspaceRoot,
			dbPath,
			excludeGlobs: ['generated/'],
			log: m => logs.push(m),
			persistDebounceMs: 50,
		});
		expect(index.getStatus().indexed).toBe(false);
		await index.reindex({ onProgress: p => progress.push(p) });
	});

	afterAll(async () => {
		await index.close();
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	});

	it('reports progress across the pipeline phases', () => {
		const phases = [...new Set(progress.map(p => p.phase))];
		expect(phases).toEqual(expect.arrayContaining(['scan', 'chunks', 'symbols', 'org-extensions', 'graph', 'done']));
		// No embeddings configured → no embeddings phase.
		expect(phases).not.toContain('embeddings');
	});

	it('builds a workspace profile with languages, frameworks and commands', async () => {
		const profile = await index.getWorkspaceProfile();
		expect(profile).toBeDefined();
		expect(profile!.languageStack).toEqual(expect.arrayContaining(['TypeScript', 'Python', 'Java']));
		expect(profile!.frameworks.map(f => f.name)).toContain('Express');
		expect(profile!.buildCommands.some(c => c.command.includes('tsc'))).toBe(true);
		expect(profile!.testCommands.some(c => c.command.includes('vitest'))).toBe(true);
		expect(profile!.isStale).toBe(false);
		// Spring endpoints from the Java service were picked up by the org-extension indexer.
		expect(profile!.serviceTopologySummary?.totalEndpoints).toBe(2);
		// summaries are skipped when no `summarize` hook is configured
		expect(profile!.projectPurpose).toBeNull();
	});

	it('honours excludeGlobs', async () => {
		const status = index.getStatus();
		expect(status.indexed).toBe(true);
		expect(status.chunks).toBeGreaterThan(5);
		expect(status.symbols).toBeGreaterThan(5);
		const hits = await index.searchBM25('generatedHelperZq');
		expect(hits).toEqual([]);
		const graph = await index.getGraph();
		expect(graph.nodes.some(n => n.filePath.startsWith('generated/'))).toBe(false);
	});

	it('searchHybrid finds a known chunk (BM25 fallback without embeddings)', async () => {
		expect(index.embeddingsEnabled).toBe(false);
		const results = await index.searchHybrid('capture payment order', { limit: 5 });
		expect(results.length).toBeGreaterThan(0);
		const hit = results.find(r => r.filePath === 'src/orderService.ts');
		expect(hit).toBeDefined();
		expect(hit!.content).toContain('capturePayment');
		expect(hit!.language).toBe('TypeScript');
		expect(hit!.startLine).toBeGreaterThan(0);
		expect(hit!.endLine).toBeGreaterThanOrEqual(hit!.startLine);
		// bm25 scores are negative; results are ordered best-first
		for (let i = 1; i < results.length; i++) expect(results[i - 1].score).toBeLessThanOrEqual(results[i].score);
	});

	it('searchHybrid matches identifiers split from camelCase and snake_case', async () => {
		const ts = await index.searchHybrid('order service create');
		expect(ts.map(r => r.filePath)).toContain('src/orderService.ts');
		const py = await index.searchHybrid('add numbers');
		expect(py[0].filePath).toBe('py/utils.py');
	});

	it('searchHybrid respects filePathPrefix and maxChars', async () => {
		const results = await index.searchHybrid('order', { filePathPrefix: 'java/', maxChars: 40 });
		expect(results.length).toBeGreaterThan(0);
		for (const r of results) {
			expect(r.filePath.startsWith('java/')).toBe(true);
			expect(r.content.length).toBeLessThanOrEqual(41); // 40 chars + ellipsis
		}
		expect(results.some(r => r.language === 'Java')).toBe(true);
	});

	it('searchSymbols finds exported symbols', async () => {
		const symbols = await index.searchSymbols('OrderService');
		expect(symbols.some(s => s.name === 'OrderService' && s.kind === 'class' && s.filePath === 'src/orderService.ts')).toBe(true);
		const outline = await index.getFileOutline('src/models/order.ts');
		// enums and methods are outline entries now that the AST chunker is in place
		expect(outline.map(s => s.name)).toEqual(expect.arrayContaining(['Order', 'isOpenOrder', 'OrderStatus']));
		expect((await index.searchSymbols('capturePayment')).some(s => s.filePath === 'src/orderService.ts' && s.kind === 'function')).toBe(true);
	});

	it('getGraph returns resolved import edges', async () => {
		const { nodes, edges } = await index.getGraph();
		expect(nodes.length).toBeGreaterThanOrEqual(8);
		expect(edges.length).toBeGreaterThan(0);
		const resolved = edges.filter(e => !e.isExternal && e.resolvedFile);
		expect(resolved).toEqual(expect.arrayContaining([
			expect.objectContaining({ fromFile: 'src/index.ts', resolvedFile: 'src/orderService.ts' }),
			expect.objectContaining({ fromFile: 'src/orderService.ts', resolvedFile: 'src/models/order.ts' }),
			expect.objectContaining({ fromFile: 'py/app.py', resolvedFile: 'py/utils.py' }),
		]));
		expect(edges.some(e => e.isExternal && e.toModule === 'express')).toBe(true);
		const orderService = nodes.find(n => n.filePath === 'src/orderService.ts')!;
		expect(orderService.importedByCount).toBe(2); // index.ts + orderService.test.ts
		const metrics = await index.getGraphMetrics();
		expect(metrics?.totalNodes).toBe(nodes.length);
	});

	it('getContextualProfile returns related files, covering tests and profile text', async () => {
		const ctx = await index.getContextualProfile('src/orderService.ts');
		expect(ctx.activeFile).toBe('src/orderService.ts');
		expect(ctx.relatedFiles).toEqual(expect.arrayContaining(['src/logger.ts', 'src/models/order.ts', 'src/index.ts']));
		expect(ctx.tests).toContain('src/orderService.test.ts');
		expect(ctx.profileText).toContain('Languages:');
		expect(ctx.profileText).toContain('Active file: src/orderService.ts');

		// Absolute paths inside the workspace are accepted too.
		const abs = await index.getContextualProfile(join(workspaceRoot, 'src', 'logger.ts'));
		expect(abs.activeFile).toBe('src/logger.ts');
		expect(abs.relatedFiles).toContain('src/orderService.ts');

		const none = await index.getContextualProfile();
		expect(none.activeFile).toBeUndefined();
		expect(none.profileText.length).toBeGreaterThan(20);
	});

	it('getIndexingReport renders markdown', async () => {
		const report = await index.getIndexingReport();
		expect(report).toContain('# Repository Intelligence Index Report');
		expect(report).toContain('TypeScript');
	});

	it('exposes org-extension data (Maven, Spring)', async () => {
		expect(await index.getMavenImpact('ms-data-model')).toEqual(['java/pom.xml']);
		const contract = await index.resolveApiContract('post', '/api/orders');
		expect(contract?.controllerClass).toBe('OrderController');
		expect(contract?.handlerMethod).toBe('createOrder');
		expect(contract?.requestDto).toBe('CreateOrderRequest');
		const topology = await index.getServiceTopology();
		expect(topology?.totalEndpoints).toBe(2);
	});

	it('indexFiles / removeFiles update the index incrementally', async () => {
		const newRel = 'src/refundService.ts';
		writeFileSync(join(workspaceRoot, newRel), [
			"import { OrderService } from './orderService';",
			'',
			'export class RefundService {',
			'  constructor(private readonly orders: OrderService) {}',
			'  issueRefundVoucher(orderId: string): string {',
			"    return `voucher-${orderId}`;",
			'  }',
			'}',
			'',
		].join('\n'));

		const before = index.getStatus();
		await index.indexFiles([newRel]);
		expect(index.getStatus().chunks).toBeGreaterThan(before.chunks);

		const hits = await index.searchBM25('issue refund voucher');
		expect(hits[0]?.filePath).toBe(newRel);
		expect((await index.searchSymbols('RefundService')).some(s => s.filePath === newRel)).toBe(true);

		const graph = await index.getGraph();
		expect(graph.edges.some(e => e.fromFile === newRel && e.resolvedFile === 'src/orderService.ts')).toBe(true);
		expect(graph.nodes.find(n => n.filePath === 'src/orderService.ts')!.importedByCount).toBe(3);

		rmSync(join(workspaceRoot, newRel));
		await index.removeFiles([newRel]);
		expect(await index.searchBM25('issue refund voucher')).toEqual([]);
		const after = await index.getGraph();
		expect(after.nodes.some(n => n.filePath === newRel)).toBe(false);
		expect(after.nodes.find(n => n.filePath === 'src/orderService.ts')!.importedByCount).toBe(2);
	});

	it('persists to dbPath and re-opens without reindexing', async () => {
		await index.flush();
		expect(existsSync(dbPath)).toBe(true);
		const reopened = await RiafIndex.open({ workspaceRoot, dbPath });
		try {
			const status = reopened.getStatus();
			expect(status.indexed).toBe(true);
			expect(status.chunks).toBe(index.getStatus().chunks);
			expect(status.lastIndexedAt).toBeDefined();
			const results = await reopened.searchHybrid('capture payment');
			expect(results.map(r => r.filePath)).toContain('src/orderService.ts');
		} finally {
			await reopened.close();
		}
	});

	it('a second reindex is incremental (no files re-chunked) and force rebuilds', async () => {
		const p2: IndexProgress[] = [];
		await index.reindex({ onProgress: p => p2.push(p) });
		const chunkDone = p2.filter(p => p.phase === 'chunks').at(-1);
		expect(chunkDone?.message).toBe('up to date');

		const p3: IndexProgress[] = [];
		const stats = await index.reindex({ force: true, onProgress: p => p3.push(p) });
		const forced = p3.filter(p => p.phase === 'chunks').at(-1);
		expect(forced?.message).toMatch(/files → \d+ chunks/);
		expect(stats.chunkCount).toBe(index.getStatus().chunks);
	});
});

describe('RiafIndex summaries and embeddings hooks', () => {
	it('calls the summarize hook and stores both summaries', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'riaf-sum-'));
		const workspaceRoot = join(dir, 'repo');
		cpSync(FIXTURE, workspaceRoot, { recursive: true });
		const prompts: string[] = [];
		const index = await RiafIndex.open({
			workspaceRoot,
			dbPath: ':memory:',
			summarize: async prompt => {
				prompts.push(prompt);
				return prompt.includes('software architect') ? 'Layered Express + Spring sample.' : 'Order management sample.';
			},
		});
		try {
			await index.reindex();
			expect(prompts.length).toBe(2);
			expect(prompts[0]).toContain('"languages"');
			const profile = await index.getWorkspaceProfile();
			expect(profile?.architectureSummary).toBe('Layered Express + Spring sample.');
			expect(profile?.projectPurpose).toBe('Order management sample.');
			const ctx = await index.getContextualProfile();
			expect(ctx.profileText).toContain('Purpose: Order management sample.');
		} finally {
			await index.close();
			rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	});

	it('uses embeddings from a mocked endpoint and fuses them into hybrid search', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'riaf-emb-'));
		const workspaceRoot = join(dir, 'repo');
		cpSync(FIXTURE, workspaceRoot, { recursive: true });

		// Deterministic toy embedder: a bag-of-characters vector, served over a fake fetch.
		const toyEmbed = (text: string): number[] => {
			const v = new Array(26).fill(0);
			for (const ch of text.toLowerCase()) {
				const i = ch.charCodeAt(0) - 97;
				if (i >= 0 && i < 26) v[i] += 1;
			}
			return v;
		};
		const originalFetch = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			calls++;
			const body = JSON.parse(String(init?.body)) as { input: string[] };
			return new Response(JSON.stringify({ data: body.input.map((t, i) => ({ index: i, embedding: toyEmbed(t) })) }), {
				status: 200, headers: { 'Content-Type': 'application/json' },
			});
		}) as typeof fetch;

		const progress: IndexProgress[] = [];
		const index = await RiafIndex.open({
			workspaceRoot,
			dbPath: ':memory:',
			embeddings: { enabled: true, url: 'http://embeddings.test/v1/embeddings', model: 'toy', headers: { Authorization: 'Bearer x' } },
		});
		try {
			await index.reindex({ onProgress: p => progress.push(p) });
			expect(calls).toBeGreaterThan(0);
			const emb = progress.filter(p => p.phase === 'embeddings').at(-1);
			expect(emb?.done).toBe(emb?.total);
			expect(index.embeddingsEnabled).toBe(true);

			const results = await index.searchHybrid('capture payment', { limit: 5 });
			expect(results.length).toBeGreaterThan(0);
			expect(results.map(r => r.filePath)).toContain('src/orderService.ts');
			// RRF scores are positive sums of 1/(60+rank), unlike raw negative bm25 values.
			expect(results[0].score).toBeGreaterThan(0);
			expect(results[0].score).toBeLessThanOrEqual(2 / 61 + 1e-9);
		} finally {
			globalThis.fetch = originalFetch;
			await index.close();
			rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	});
});
