import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateProjectDirNames, findProjectDir, readClaudeUsage } from '../src/claudeUsage.js';
import { estimateSavedTokens, filesReferencedInResult, readToolStats, recordToolCall, resetToolStats, summarizeToolStats } from '../src/toolStats.js';

const line = (o: unknown) => JSON.stringify(o) + '\n';

describe('Claude Code transcript usage', () => {
	it('encodes the repo path the way Claude Code names project folders', () => {
		expect(candidateProjectDirNames('/home/claude')).toContain('-home-claude');
		expect(candidateProjectDirNames('C:\\Users\\hpg5ban\\workspace\\riaf-vscode')).toContain('C--Users-hpg5ban-workspace-riaf-vscode');
		expect(candidateProjectDirNames('/Users/harig/my.repo')).toContain('-Users-harig-my-repo');
	});

	it('sums usage per repo, de-duplicates streamed message ids, prices by model, computes cache efficiency', () => {
		const home = mkdtempSync(join(tmpdir(), 'riaf-claude-home-'));
		const repo = '/work/demo';
		const dir = join(home, 'projects', '-work-demo'); mkdirSync(dir, { recursive: true });
		const sub = join(dir, 'abc'); mkdirSync(sub);                      // subagent transcripts live one level down
		const usage = (i: number, o: number, cr = 0, cw = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
		writeFileSync(join(dir, 's1.jsonl'),
			line({ type: 'user', message: { role: 'user', content: 'hi' } }) +
			line({ type: 'assistant', timestamp: '2026-10-28T10:00:00Z', message: { id: 'm1', model: 'claude-sonnet-4-6', usage: usage(1000, 10, 4000, 500) } }) +   // partial flush
			line({ type: 'assistant', timestamp: '2026-10-28T10:00:05Z', message: { id: 'm1', model: 'claude-sonnet-4-6', usage: usage(1000, 200, 4000, 500) } }) +  // complete
			line({ type: 'assistant', timestamp: '2026-10-28T10:01:00Z', message: { id: 'm2', model: 'claude-sonnet-4-6', usage: usage(500, 100, 5000, 0) } }) +
			'not json\n');
		writeFileSync(join(sub, 'agent.jsonl'), line({ type: 'assistant', timestamp: '2026-10-28T10:02:00Z', message: { id: 'm3', model: 'claude-future-9', usage: usage(100, 50) } }));

		expect(findProjectDir(repo, home)).toBe(dir);
		const u = readClaudeUsage(repo, home);
		expect(u.projectDir).toBe(dir);
		expect(u.sessions).toBe(2);
		expect(u.calls).toBe(3);                                            // m1 counted once
		expect(u.inputTokens).toBe(1600);
		expect(u.outputTokens).toBe(350);                                   // 200 (not 10) + 100 + 50
		expect(u.cacheReadTokens).toBe(9000);
		expect(u.cacheWriteTokens).toBe(500);
		expect(u.cacheEfficiency).toBeCloseTo(9000 / (1600 + 9000 + 500), 5);
		// sonnet-4-6 is priced: 1500 in @3, 300 out @15, 9000 cache read @0.3, 500 cache write @3.75 (per 1M)
		expect(u.byModel['claude-sonnet-4-6'].costUSD).toBeCloseTo((1500 * 3 + 300 * 15 + 9000 * 0.3 + 500 * 3.75) / 1e6, 8);
		expect(u.unpricedModels).toEqual(['claude-future-9']);
		expect(u.firstAt).toBe(Date.parse('2026-10-28T10:00:00Z'));
		expect(u.lastAt).toBe(Date.parse('2026-10-28T10:02:00Z'));
		// unknown repo → empty, no projectDir
		expect(readClaudeUsage('/work/other', home).projectDir).toBeUndefined();
	});
});

describe('tools served metrics', () => {
	it('estimates saved tokens from the files a result drew on', () => {
		const root = mkdtempSync(join(tmpdir(), 'riaf-toolstats-'));
		writeFileSync(join(root, 'big.ts'), 'x'.repeat(40_000));
		writeFileSync(join(root, 'small.ts'), 'y'.repeat(400));
		const result = '### big.ts:10-40 (score 1.0)\nchunk\n\n### small.ts:1-5 (score 0.5)\nchunk2';
		expect(filesReferencedInResult('search_codebase', {}, result)).toEqual(['big.ts', 'small.ts']);
		expect(estimateSavedTokens(root, 'search_codebase', {}, result)).toBe(Math.round((40_400 - result.length) / 4));
		expect(estimateSavedTokens(root, 'get_file_outline', { filePath: 'big.ts' }, 'outline')).toBe(Math.round((40_000 - 7) / 4));
		expect(estimateSavedTokens(root, 'grep', { pattern: 'x' }, 'anything')).toBe(0);     // no whole-file alternative
		expect(estimateSavedTokens(root, 'search_codebase', {}, '### gone.ts:1-2 (score 1)\n')).toBe(0);
	});

	it('persists per consumer and per tool, survives both processes writing, and resets', () => {
		const root = mkdtempSync(join(tmpdir(), 'riaf-toolstats-'));
		writeFileSync(join(root, 'a.ts'), 'z'.repeat(8000));
		const statsPath = join(root, 'index.sqlite.tools.json');
		const res = '### a.ts:1-9 (score 1)\nsome chunk';
		recordToolCall({ statsPath, workspaceRoot: root, consumer: 'copilot', toolName: 'search_codebase', args: { query: 'q' }, result: res, ok: true });
		recordToolCall({ statsPath, workspaceRoot: root, consumer: 'claude-code', toolName: 'search_codebase', args: { query: 'q' }, result: res, ok: true });
		recordToolCall({ statsPath, workspaceRoot: root, consumer: 'claude-code', toolName: 'get_symbol', args: {}, result: 'ERROR', ok: false });
		const s = summarizeToolStats(readToolStats(statsPath));
		expect(s.total.calls).toBe(3);
		expect(s.byConsumer.copilot.calls).toBe(1);
		expect(s.byConsumer['claude-code'].calls).toBe(2);
		expect(s.byConsumer['claude-code'].errors).toBe(1);
		expect(s.byConsumer['claude-code'].tools.search_codebase.savedTokensEst).toBe(Math.round((8000 - res.length) / 4));
		expect(s.byConsumer['claude-code'].tools.get_symbol.charsReturned).toBe(0);
		resetToolStats(statsPath);
		expect(summarizeToolStats(readToolStats(statsPath)).total.calls).toBe(0);
	});
});
