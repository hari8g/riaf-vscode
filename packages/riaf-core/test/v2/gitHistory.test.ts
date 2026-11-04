import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoIntelligenceDb } from '../../src/repoIntelligenceDb.js';
import { V2Store } from '../../src/v2/store.js';
import { classifyCommit, extractDecisionSentences, extractTickets, extractWhy, formatHistoryCard, GitHistory, hashAuthor, noiseReason, parseRenamePath } from '../../src/v2/gitHistory.js';
import { append, commit, makeHistoryRepo, NOW } from './gitRepo.js';

describe('history helpers', () => {
	it('classifies commit intents from conventional prefixes, lexicon and file sets', () => {
		expect(classifyCommit('feat(api): add refunds')).toBe('feature');
		expect(classifyCommit('Fix crash when order is null')).toBe('fix');
		expect(classifyCommit('Speed up search by caching tokens')).toBe('perf');
		expect(classifyCommit('Sanitize input to prevent XSS')).toBe('security');
		expect(classifyCommit('Rename OrderRepo to OrderRepository')).toBe('refactor');
		expect(classifyCommit('Update things', '', ['src/a.test.ts', 'test/b.spec.ts'])).toBe('test');
		expect(classifyCommit('Update guide', '', ['docs/guide.md'])).toBe('docs');
	});
	it('extracts tickets, why and decisions', () => {
		expect(extractTickets('PAY-12 and #34, see !7; UTF-8 is not a ticket')).toEqual(['PAY-12', '#34', '!7']);
		expect(extractWhy('fix: guard refunds', 'Refunded orders kept Pending because the flag was never reset.')).toMatch(/guard refunds — .*because/);
		expect(extractDecisionSentences('We moved retries to the client instead of the server. Minor tweak.')).toHaveLength(1);
	});
	it('detects noise commits', () => {
		expect(noiseReason('Run prettier on all files', ['a.ts'], 1, 50)).toBe('formatter');
		expect(noiseReason('chore: bump deps', ['package.json'], 1, 50)).toBe('dependency bump');
		expect(noiseReason('fix: order total', ['src/order.ts'], 1, 50)).toBeUndefined();
		expect(noiseReason('update', ['package-lock.json'], 1, 50)).toBe('lockfile-only');
		expect(noiseReason('Merge branch x', ['a.ts'], 2, 50)).toBe('merge');
		expect(noiseReason('big change', Array.from({ length: 60 }, (_, i) => `f${i}.ts`), 1, 50)).toMatch(/outlier/);
		expect(noiseReason('Bump dependencies via renovate', ['package.json'], 1, 50)).toBe('dependency bump');
	});
	it('parses rename notation', () => {
		expect(parseRenamePath('py/{utils.py => helpers.py}')).toEqual({ path: 'py/helpers.py', oldPath: 'py/utils.py' });
		expect(parseRenamePath('src/{ => log}/logger.ts')).toEqual({ path: 'src/log/logger.ts', oldPath: 'src/logger.ts' });
		expect(parseRenamePath('a.ts => b.ts')).toEqual({ path: 'b.ts', oldPath: 'a.ts' });
	});
});

describe('GitHistory mining on a scripted repository', () => {
	let dir: string; let repo: string; let shas: Record<string, string>;
	let db: RepoIntelligenceDb; let history: GitHistory;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'riaf-hist-'));
		({ repo, shas } = makeHistoryRepo(dir));
		db = new RepoIntelligenceDb(join(dir, 'index.sqlite'), { persistDebounceMs: 20 });
		await db.init();
		history = new GitHistory(new V2Store(db), repo, { now: () => NOW });
		const r = await history.mine();
		expect(r.full).toBe(true);
		expect(r.newCommits).toBe(8);
	});
	afterAll(async () => { await db.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

	const row = (sha: string) => db.raw.get<{ is_noise: number; noise_reason: string; intent_class: string; unit_id: string; ticket_ids: string; author_hash: string; author_name: string | null }>('SELECT * FROM git_commit WHERE sha = ?', [sha])!;

	it('flags noise and classifies intents', () => {
		expect(row(shas.prettier).is_noise).toBe(1);
		expect(row(shas.prettier).noise_reason).toBe('formatter');
		expect(row(shas.fix1).intent_class).toBe('fix');
		expect(row(shas.feat).intent_class).toBe('feature');
		expect(row(shas.rename).intent_class).toBe('refactor');
		expect(JSON.parse(row(shas.fix1).ticket_ids)).toContain('PAY-12');
	});

	it('groups commits sharing a ticket into one logical change unit', () => {
		expect(row(shas.fix1).unit_id).toBe('T:PAY-12');
		expect(row(shas.fix1b).unit_id).toBe('T:PAY-12');
		expect(row(shas.feat).unit_id).toBe(shas.feat);
	});

	it('hashes author identities by default', () => {
		expect(row(shas.fix1).author_hash).toBe(hashAuthor('bob@example.com'));
		expect(row(shas.fix1).author_name).toBeNull();
	});

	it('builds a co-change graph over logical units, excluding noise', () => {
		const nb = history.coChanged('src/orderService.ts', 10);
		const test = nb.find(n => n.path === 'src/orderService.test.ts');
		expect(test?.support).toBeGreaterThanOrEqual(3); // initial, PAY-12 unit, feat
		const model = nb.find(n => n.path === 'src/models/order.ts');
		expect(model?.support).toBeGreaterThanOrEqual(3); // initial, feat, fix2 (prettier is noise)
		expect(nb.find(n => n.path === 'package-lock.json')).toBeUndefined();
	});

	it('computes ownership roles and bus factor', () => {
		const owners = history.owners('src/orderService.ts');
		expect(owners.length).toBeGreaterThanOrEqual(2);
		expect(owners[0].role).toMatch(/owner|contributor/);
		expect(history.busFactor('src/')).toBeGreaterThanOrEqual(1);
	});

	it('mines design decisions from commit bodies', () => {
		const decs = history.decisions(['src/orderService.ts']);
		expect(decs.some(d => /instead of the controller/.test(d.text))).toBe(true);
	});

	it('follows renames to the newest path', () => {
		expect(history.canonical('py/utils.py')).toBe('py/helpers.py');
		expect(history.commitsForFile('py/helpers.py').length).toBeGreaterThanOrEqual(2);
	});

	it('produces a history card and finds commits by intent text', () => {
		const card = history.card('src/orderService.ts');
		expect(card.created?.sha).toBe(shas.initial);
		expect(card.intents.fix).toBeGreaterThanOrEqual(2);
		const text = formatHistoryCard(card);
		expect(text).toMatch(/usually changes with/);
		expect(text).not.toMatch(/Bob|Alice|Carol/);
		const found = history.searchCommits(['refunds'], 5);
		expect(found[0].sha).toBe(shas.feat);
	});

	it('answers temporal queries', async () => {
		const since = await history.changedSince('2026-05-15', 'src/');
		expect(since.map(c => c.sha)).toContain(shas.fix2);
		expect(since.map(c => c.sha)).not.toContain(shas.feat);
	});

	it('mines incrementally from the last indexed commit', async () => {
		const sha = commit(repo, 'bob', '2026-06-20T10:00:00Z', 'fix: logger drops messages', { 'src/logger.ts': append('// flush') });
		const r = await history.mine();
		expect(r.full).toBe(false);
		expect(r.newCommits).toBe(1);
		expect(row(sha).intent_class).toBe('fix');
		const again = await history.mine();
		expect(again.newCommits).toBe(0);
	});
});
