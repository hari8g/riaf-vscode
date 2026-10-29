/**
 * P0 maturity work: content-hash incremental reindex, partial-embedding completion,
 * .gitignore handling (no blanket dot-dir skip), derived-data refresh after incremental
 * updates, and per-request embedding auth headers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { RiafIndex, orgSlicesForPath, type IndexProgress } from '../src/riafIndex.js';
import { buildExcludeMatcher, compileGitignore, scanWorkspace } from '../src/workspaceScanner.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');
const tmpDirs: string[] = [];
const freshRepo = (): string => {
	const dir = mkdtempSync(join(tmpdir(), 'riaf-p0-'));
	tmpDirs.push(dir);
	const root = join(dir, 'repo');
	cpSync(FIXTURE, root, { recursive: true });
	return root;
};
afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

const lastPhase = (progress: IndexProgress[], phase: string) => progress.filter(p => p.phase === phase).at(-1);

describe('compileGitignore', () => {
	it('matches directories, globs and anchored paths; last match wins with negation', () => {
		const m = compileGitignore([
			'# build output',
			'dist/',
			'*.log',
			'!keep.log',
			'/config/local.yml',
			'docs/**/*.tmp',
			'',
		]);
		expect(m('dist/bundle.js')).toBe(true);
		expect(m('dist')).toBe(true);
		expect(m('app/dist/x.js')).toBe(true);
		expect(m('server.log')).toBe(true);
		expect(m('logs/server.log')).toBe(true);
		expect(m('keep.log')).toBe(false);          // negated
		expect(m('config/local.yml')).toBe(true);
		expect(m('other/config/local.yml')).toBeUndefined(); // anchored to root → no rule applies
		expect(m('docs/a/b/notes.tmp')).toBe(true);
		expect(m('src/index.ts')).toBeUndefined();
	});

	it('scopes a nested .gitignore to its directory', () => {
		const m = compileGitignore(['*.snap', '/fixtures/'], 'packages/app');
		expect(m('packages/app/test/a.snap')).toBe(true);
		expect(m('packages/app/fixtures/x.json')).toBe(true);
		expect(m('packages/other/test/a.snap')).toBeUndefined();
		expect(m('fixtures/x.json')).toBeUndefined();
	});
});

describe('scanWorkspace with .gitignore', () => {
	it('drops gitignored paths, keeps dot-directories like .github, still skips .git and node_modules', () => {
		const root = freshRepo();
		mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
		writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'name: ci\non: push\njobs: {}\n');
		mkdirSync(join(root, '.git', 'objects'), { recursive: true });
		writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
		mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
		writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
		mkdirSync(join(root, 'tmp'), { recursive: true });
		writeFileSync(join(root, 'tmp', 'scratch.ts'), 'export const scratch = 1;\n');
		writeFileSync(join(root, 'debug.log'), 'noise\n');
		// nested ignore file + a root rule for logs
		writeFileSync(join(root, '.gitignore'), 'generated/\nnode_modules/\n*.log\n');
		mkdirSync(join(root, 'py', 'cache'), { recursive: true });
		writeFileSync(join(root, 'py', 'cache', 'x.py'), 'x = 1\n');
		writeFileSync(join(root, 'py', '.gitignore'), 'cache/\n');

		const paths = scanWorkspace(root).fileMeta.map(f => f.filePath);
		expect(paths).toContain('.github/workflows/ci.yml');
		expect(paths).toContain('tmp/scratch.ts');
		expect(paths).toContain('py/app.py');
		expect(paths.some(p => p.startsWith('.git/'))).toBe(false);
		expect(paths.some(p => p.startsWith('node_modules/'))).toBe(false);
		expect(paths.some(p => p.startsWith('generated/'))).toBe(false);
		expect(paths).not.toContain('debug.log');
		expect(paths).not.toContain('py/cache/x.py');

		// opt-out keeps the gitignored files (but hard-skipped dirs stay out)
		const all = scanWorkspace(root, { respectGitignore: false }).fileMeta.map(f => f.filePath);
		expect(all).toContain('generated/client.ts');
		expect(all).toContain('debug.log');
		expect(all.some(p => p.startsWith('node_modules/'))).toBe(false);
	});

	it('buildExcludeMatcher agrees with the scanner (used by the watcher and indexFiles)', () => {
		const root = freshRepo();
		writeFileSync(join(root, '.gitignore'), 'generated/\n*.log\n!important.log\n');
		const excluded = buildExcludeMatcher(root, ['py/']);
		expect(excluded('generated/client.ts')).toBe(true);
		expect(excluded('src/x.log')).toBe(true);
		expect(excluded('important.log')).toBe(false);
		expect(excluded('py/app.py')).toBe(true);           // user glob
		expect(excluded('node_modules/a/b.js')).toBe(true); // hard skip
		expect(excluded('.github/workflows/ci.yml')).toBe(false);
		expect(excluded('src/index.ts')).toBe(false);
		// no root → gitignore not consulted
		expect(buildExcludeMatcher(null, [])('generated/client.ts')).toBe(false);
	});
});

describe('RiafIndex incremental reindex by content hash', () => {
	it('re-chunks a file edited between runs and skips a file that was only touched', async () => {
		const root = freshRepo();
		const index = await RiafIndex.open({ workspaceRoot: root, dbPath: ':memory:' });
		try {
			await index.reindex();
			expect((await index.searchBM25('frobnicateLedgerEntry')).length).toBe(0);

			// 1. content change → the non-force reindex must pick it up
			const target = join(root, 'src', 'logger.ts');
			writeFileSync(target, 'export function frobnicateLedgerEntry(): string {\n  return "ledger";\n}\n');
			const p1: IndexProgress[] = [];
			await index.reindex({ onProgress: p => p1.push(p) });
			expect(lastPhase(p1, 'chunks')?.message).toMatch(/1 files → \d+ chunks/);
			const hits = await index.searchBM25('frobnicateLedgerEntry');
			expect(hits[0]?.filePath).toBe('src/logger.ts');
			expect((await index.searchSymbols('frobnicateLedgerEntry')).some(s => s.filePath === 'src/logger.ts')).toBe(true);

			// 2. same content, new mtime (touch / checkout) → ledger refreshed, nothing re-chunked
			const later = new Date(Date.now() + 5_000);
			utimesSync(target, later, later);
			const p2: IndexProgress[] = [];
			await index.reindex({ onProgress: p => p2.push(p) });
			expect(lastPhase(p2, 'chunks')?.message).toBe('up to date');

			// 3. and a third run with nothing changed at all is still a no-op
			const p3: IndexProgress[] = [];
			await index.reindex({ onProgress: p => p3.push(p) });
			expect(lastPhase(p3, 'chunks')?.message).toBe('up to date');
		} finally {
			await index.close();
		}
	});

	it('honours .gitignore through RiafIndex (scan + indexFiles) and indexes .github', async () => {
		const root = freshRepo();
		mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
		writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'name: ci\njobs:\n  build:\n    runs-on: ubuntu\n');
		const index = await RiafIndex.open({ workspaceRoot: root, dbPath: ':memory:' });
		try {
			await index.reindex();
			const graph = await index.getGraph();
			expect(graph.nodes.some(n => n.filePath.startsWith('generated/'))).toBe(false); // from .gitignore, no excludeGlobs
			expect((await index.searchBM25('generatedHelperZq'))).toEqual([]);
			const ctx = await index.getContextualProfile('.github/workflows/ci.yml');
			expect(ctx.activeFile).toBe('.github/workflows/ci.yml');

			// a watcher event for an ignored file must not slip in through indexFiles
			writeFileSync(join(root, 'generated', 'late.ts'), 'export const lateGeneratedZq = 1;\n');
			await index.indexFiles(['generated/late.ts']);
			expect(await index.searchBM25('lateGeneratedZq')).toEqual([]);
		} finally {
			await index.close();
		}
	});
});

describe('RiafIndex derived data after incremental updates', () => {
	it('maps changed paths to org slices', () => {
		expect(orgSlicesForPath('java/pom.xml')).toEqual(expect.arrayContaining(['maven', 'spring']));
		expect(orgSlicesForPath('svc/src/main/java/A.java')).toEqual(['spring']);
		expect(orgSlicesForPath('web/package.json')).toEqual(['npm']);
		expect(orgSlicesForPath('deploy/app-deployment.yaml')).toEqual(expect.arrayContaining(['k8s', 'config']));
		expect(orgSlicesForPath('gateway/src/main/resources/application-prod.yml')).toContain('gateway');
		expect(orgSlicesForPath('.gitlab-ci.yml')).toContain('ci');
		expect(orgSlicesForPath('infra/main.tf')).toEqual(['terraform']);
		expect(orgSlicesForPath('src/index.ts')).toEqual([]);
	});

	it('refreshes Spring endpoints and graph metrics after indexFiles / removeFiles', async () => {
		const root = freshRepo();
		const index = await RiafIndex.open({ workspaceRoot: root, dbPath: ':memory:', derivedRefreshDebounceMs: 10 });
		try {
			await index.reindex();
			expect((await index.getServiceTopology())?.totalEndpoints).toBe(2);
			const metricsBefore = await index.getGraphMetrics();

			const rel = 'java/src/main/java/com/example/orders/RefundController.java';
			writeFileSync(join(root, rel), [
				'package com.example.orders;',
				'import org.springframework.web.bind.annotation.*;',
				'@RestController',
				'@RequestMapping("/api/refunds")',
				'public class RefundController {',
				'    @PostMapping',
				'    public RefundDto createRefund(@RequestBody RefundRequest request) { return null; }',
				'}',
				'',
			].join('\n'));
			await index.indexFiles([rel]);
			await index.refreshDerived();                       // what the debounce timer would do
			expect((await index.getServiceTopology())?.totalEndpoints).toBe(3);
			const contract = await index.resolveApiContract('POST', '/api/refunds');
			expect(contract?.controllerClass).toBe('RefundController');
			const metricsAfter = await index.getGraphMetrics();
			expect(metricsAfter!.totalNodes).toBe(metricsBefore!.totalNodes + 1);
			expect(metricsAfter!.computedAt).toBeGreaterThanOrEqual(metricsBefore!.computedAt);

			rmSync(join(root, rel));
			await index.removeFiles([rel]);
			await index.refreshDerived();
			expect((await index.getServiceTopology())?.totalEndpoints).toBe(2);
			expect((await index.getGraphMetrics())!.totalNodes).toBe(metricsBefore!.totalNodes);
		} finally {
			await index.close();
		}
	});

	it('removing an imported file leaves the importers\' edges unresolved instead of dangling', async () => {
		const root = freshRepo();
		const index = await RiafIndex.open({ workspaceRoot: root, dbPath: ':memory:' });
		try {
			await index.reindex();
			rmSync(join(root, 'src', 'models', 'order.ts'));
			await index.removeFiles(['src/models/order.ts']);
			const { edges, nodes } = await index.getGraph();
			expect(nodes.some(n => n.filePath === 'src/models/order.ts')).toBe(false);
			const fromService = edges.filter(e => e.fromFile === 'src/orderService.ts' && e.toModule.includes('models/order'));
			expect(fromService.length).toBeGreaterThan(0);
			for (const e of fromService) expect(e.resolvedFile).toBeNull();
		} finally {
			await index.close();
		}
	});
});

describe('RiafIndex embeddings: completion and auth headers', () => {
	const toyEmbed = (text: string): number[] => {
		const v = new Array(26).fill(0);
		for (const ch of text.toLowerCase()) { const i = ch.charCodeAt(0) - 97; if (i >= 0 && i < 26) v[i] += 1; }
		return v;
	};

	it('finishes embeddings left incomplete by an outage on the next reindex, chunk by chunk', async () => {
		const root = freshRepo();
		const originalFetch = globalThis.fetch;
		let mode: 'half-then-fail' | 'ok' = 'half-then-fail';
		let calls = 0;
		const seenAuth: string[] = [];
		let token = 'token-1';
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			calls++;
			seenAuth.push(String((init?.headers as Record<string, string>)?.Authorization ?? ''));
			const body = JSON.parse(String(init?.body)) as { input: string[] };
			if (mode === 'half-then-fail') {
				// first batch succeeds, everything after that is an outage
				if (calls > 1) return new Response('upstream down', { status: 503 });
			}
			return new Response(JSON.stringify({ data: body.input.map((t, i) => ({ index: i, embedding: toyEmbed(t) })) }), {
				status: 200, headers: { 'Content-Type': 'application/json' },
			});
		}) as typeof fetch;

		const index = await RiafIndex.open({
			workspaceRoot: root,
			dbPath: ':memory:',
			embeddings: { enabled: true, url: 'http://embeddings.test/v1/embeddings', model: 'toy', batchSize: 4, headers: () => ({ Authorization: `Bearer ${token}` }) },
		});
		try {
			const p1: IndexProgress[] = [];
			await index.reindex({ onProgress: p => p1.push(p) });
			const emb1 = lastPhase(p1, 'embeddings');
			expect(emb1?.message).toBe('endpoint unavailable');
			expect(emb1!.done).toBeLessThan(emb1!.total);
			// BM25 still answers while embeddings are partial
			expect((await index.searchHybrid('capture payment')).map(r => r.filePath)).toContain('src/orderService.ts');

			// outage over, token rotated: a plain (non-force) reindex completes only the missing chunks
			mode = 'ok';
			token = 'token-2';
			const callsBefore = calls;
			const p2: IndexProgress[] = [];
			await index.reindex({ onProgress: p => p2.push(p) });
			const emb2 = lastPhase(p2, 'embeddings');
			expect(emb2?.done).toBe(emb2?.total);
			expect(lastPhase(p2, 'chunks')?.message).toBe('up to date');
			const total = emb2!.total;
			// 4 chunks already embedded by the one good batch → fewer requests than a full pass
			expect(calls - callsBefore).toBeLessThan(Math.ceil(total / 4) + 1);
			expect(calls - callsBefore).toBeGreaterThan(0);
			// header resolver was consulted per request: the new token is what went out
			expect(seenAuth.slice(callsBefore)).toEqual(expect.arrayContaining(['Bearer token-2']));
			expect(seenAuth.slice(callsBefore)).not.toContain('Bearer token-1');

			// and a third run has nothing left to embed
			const p3: IndexProgress[] = [];
			const c3 = calls;
			await index.reindex({ onProgress: p => p3.push(p) });
			expect(calls).toBe(c3);
		} finally {
			globalThis.fetch = originalFetch;
			await index.close();
		}
	});
});
