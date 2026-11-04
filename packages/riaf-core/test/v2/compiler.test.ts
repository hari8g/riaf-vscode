import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Riaf2 } from '../../src/v2/riaf2.js';
import { parseIntent } from '../../src/v2/intent.js';
import { validatePack } from '../../src/v2/packTypes.js';
import { render, RENDER_TARGETS, upsertClaudeMd } from '../../src/v2/render.js';
import { rebudget, slicePack } from '../../src/v2/compiler.js';
import { runEval, formatEvalReport } from '../../src/v2/eval.js';
import { makeHistoryRepo, NOW } from './gitRepo.js';

describe('parseIntent', () => {
	it('classifies task types', () => {
		expect(parseIntent('Fix the crash in OrderService.capturePayment when the order is refunded').type).toBe('bugfix');
		expect(parseIntent('Add a refund endpoint to the orders API').type).toBe('feature');
		expect(parseIntent('Refactor the logger into its own module').type).toBe('refactor');
		expect(parseIntent('How does payment capture work?').type).toBe('explain');
		expect(parseIntent('Write unit tests for createOrder').type).toBe('test');
		expect(parseIntent('Migrate from express 4 to express 5').type).toBe('migrate');
		expect(parseIntent('Review the changes in src/orderService.ts').type).toBe('review');
	});
	it('extracts entities, constraints and acceptance criteria', () => {
		const p = parseIntent('Fix `capturePayment` in src/orderService.ts:30 — it throws "TypeError: cannot read status". Do not change the public API. It should return false for refunded orders. See PAY-12.');
		const kinds = Object.fromEntries(p.entities.map(e => [e.value, e.kind]));
		expect(kinds['capturePayment']).toBe('symbol');
		expect(kinds['src/orderService.ts:30']).toBe('file');
		expect(kinds['PAY-12']).toBe('ticket');
		expect(p.entities.some(e => e.kind === 'error' && /TypeError/.test(e.value))).toBe(true);
		expect(p.constraints.join(' ')).toMatch(/Do not change the public API/);
		expect(p.acceptance.join(' ')).toMatch(/should return false/);
		expect(p.terms).toContain('capture');
	});
	it('asks a clarifying question instead of guessing when the request is vague', () => {
		expect(parseIntent('make it better').open_questions.length).toBeGreaterThan(0);
	});
});

describe('Pack compiler on the sample repository with history', () => {
	let dir: string; let riaf: Riaf2;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'riaf-pack-'));
		const { repo } = makeHistoryRepo(dir);
		writeFileSync(join(repo, '.gitattributes'), 'generated/** linguist-generated\n');
		riaf = await Riaf2.open({ workspaceRoot: repo, dbPath: join(dir, 'index.sqlite'), persistDebounceMs: 20, history: { now: () => NOW } });
		const r = await riaf.indexRepo();
		expect(r.commits).toBe(8);
		expect(r.summaries).toBeGreaterThan(0);
	}, 60_000);
	afterAll(async () => { await riaf.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

	it('compiles a bugfix pack that contains the seed, its test and its imports, within budget', async () => {
		const pack = await riaf.compile('Fix capturePayment in OrderService: it returns true for refunded orders. Do not change the public API.', { budget: 12_000 });
		expect(validatePack(pack)).toEqual([]);
		expect(pack.intent.type).toBe('bugfix');
		const paths = pack.items.map(i => i.path);
		expect(paths).toContain('src/orderService.ts');
		expect(paths).toContain('src/orderService.test.ts');
		expect(paths.some(p => p === 'src/models/order.ts' || p === 'src/logger.ts')).toBe(true);
		expect(paths).not.toContain('generated/client.ts');
		expect(pack.budget.used_tokens).toBeLessThanOrEqual(12_000);
		for (const it of pack.items) expect(it.why.length).toBeGreaterThan(0);
		expect(pack.known_facts.files_read.map(f => f.path)).toContain('src/orderService.ts');
		expect(pack.known_facts.symbols_resolved.some(s => s.name === 'capturePayment' || s.name === 'OrderService')).toBe(true);
		expect(pack.verification.join('\n')).toMatch(/vitest|test/);
		expect(pack.verification.join('\n')).toMatch(/public API/);
		expect(pack.history.related_commits.length).toBeGreaterThan(0);
		expect(pack.history.decisions.some(d => /controller/.test(d.text))).toBe(true);
		expect(pack.items.some(i => i.kind === 'history_card')).toBe(true);
		expect(pack.provenance.compile_ms).toBeLessThan(2_000);
	});

	it('degrades bodies to signatures under a tight budget', async () => {
		const pack = await riaf.compile('Explain how orders are created and logged', { budget: 1_500, fresh: true });
		expect(validatePack(pack)).toEqual([]);
		expect(pack.budget.used_tokens).toBeLessThanOrEqual(1_500);
	});

	it('returns the stored pack for an identical request on the same HEAD and diffs on recompile', async () => {
		const a = await riaf.compile('Add refund support to OrderService', { budget: 8_000 });
		const b = await riaf.compile('Add refund support to OrderService', { budget: 8_000 });
		expect(b.pack_id).toBe(a.pack_id);
		const c = await riaf.compile('Add refund support to OrderService', { budget: 8_000, fresh: true });
		expect(c.diff?.previous_pack).toBe(a.pack_id);
		expect(riaf.currentPack()?.pack_id).toBe(c.pack_id);
	});

	it('appends stage output to the previous pack instead of recompiling', async () => {
		const base = await riaf.compile('Add refund support to OrderService', { budget: 8_000 });
		const next = await riaf.compile('Add refund support to OrderService', { budget: 8_000, stage: 'verify', appendOutput: 'FAIL src/orderService.test.ts > refunds' });
		expect(next.provenance.parent_pack).toBe(base.pack_id);
		expect(next.items[0].content).toMatch(/FAIL/);
	});

	it('slices child packs by scope and rebudgets', async () => {
		const pack = await riaf.compile('Fix capturePayment in OrderService', { budget: 12_000 });
		const child = slicePack(pack, 'src/models/');
		expect(child.items.every(i => i.path.startsWith('src/models/'))).toBe(true);
		expect(child.known_facts).toEqual(pack.known_facts);
		const small = rebudget(JSON.parse(JSON.stringify(pack)), 2_000);
		expect(small.budget.used_tokens).toBeLessThanOrEqual(2_000);
	});

	it('renders every target', async () => {
		const pack = await riaf.compile('Fix capturePayment in OrderService', { budget: 12_000 });
		for (const t of RENDER_TARGETS) expect(render(pack, t).length).toBeGreaterThan(200);
		expect(JSON.parse(render(pack, 'openai')).messages[0].role).toBe('system');
		expect(JSON.parse(render(pack, 'gemini')).systemInstruction.parts[0].text).toMatch(/Repository conventions/);
		const md = render(pack, 'claude');
		expect(md.indexOf('Repository conventions')).toBeLessThan(md.indexOf('Context items'));
		expect(md).toMatch(/riaf_lookup/);
		expect(render(pack, 'markdown')).toMatch(/_why: /);
		const once = upsertClaudeMd('# Project\n');
		expect(upsertClaudeMd(once)).toBe(once);
	});

	it('looks up files, ranges, symbols, listings and search from the index', async () => {
		const f = await riaf.lookup({ path: 'src/orderService.ts' });
		expect(f.hit).toBe(true); expect(f.blob).toHaveLength(32);
		const r = await riaf.lookup({ path: 'src/orderService.ts', range: [1, 3] });
		expect(r.content.split('\n')).toHaveLength(3);
		const s = await riaf.lookup({ symbol: 'OrderService' });
		expect(s.content).toMatch(/class OrderService/);
		const d = await riaf.lookup({ dir: 'src' });
		expect(d.content).toMatch(/models\//);
		const miss = await riaf.lookup({ symbol: 'NoSuchThing' });
		expect(miss.hit).toBe(false);
	});

	it('expands a node with structural and history neighbours', async () => {
		const e = await riaf.expand('src/orderService.ts');
		expect(e.tests).toContain('src/orderService.test.ts');
		expect(e.coChanges.map(c => c.path)).toContain('src/orderService.test.ts');
		expect(e.text).toMatch(/Co-changes/);
		expect(riaf.historyCard('src/orderService.ts')?.text).toMatch(/History card/);
	});

	it('derives architecture facts and conventions', async () => {
		const a = await riaf.architecture();
		expect(a.packages.some(p => p.kind === 'npm')).toBe(true);
		expect(a.packages.some(p => p.kind === 'maven')).toBe(true);
		expect(a.generatedPatterns).toContain('generated/**');
		expect(a.testLayout).toBe('co-located');
	});

	it('rebuilds only changed summaries', async () => {
		const again = await riaf.summaries.build();
		expect(again.regenerated).toBe(0);
		expect(riaf.summaries.get('file', 'src/orderService.ts')).toMatch(/OrderService/);
		expect(riaf.summaries.get('repo', '.')).toBeTruthy();
	});

	it('runs the history-based evaluation with held-out history', async () => {
		const report = await runEval(riaf, { samples: 3, budget: 12_000 });
		expect(report.samples.length).toBeGreaterThan(0);
		expect(report.packRecall).toBeGreaterThan(0);
		expect(formatEvalReport(report)).toMatch(/Pack recall/);
	}, 30_000);
});
