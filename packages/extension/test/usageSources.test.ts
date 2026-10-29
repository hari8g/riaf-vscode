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

describe('RIAF effect inside Claude Code', () => {
	it('compares sessions with and without riaf tools and estimates direct savings from riaf results', () => {
		const home = mkdtempSync(join(tmpdir(), 'riaf-effect-home-'));
		const repo = mkdtempSync(join(tmpdir(), 'riaf-effect-repo-'));
		writeFileSync(join(repo, 'big.ts'), 'q'.repeat(20_000));                       // the file RIAF's search drew on
		const dir = join(home, 'projects', repo.replace(/[^A-Za-z0-9]/g, '-')); mkdirSync(dir, { recursive: true });
		const u = (i: number, o: number, cr = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: 0 });
		const asst = (id: string, usage: unknown, content: unknown[]) => line({ type: 'assistant', message: { id, model: 'claude-sonnet-4-6', usage, content } });
		const user = (content: unknown) => line({ type: 'user', message: { role: 'user', content } });

		// session A: uses RIAF — 2 turns, 3 calls, one riaf search whose result is a small chunk of big.ts, one native Read
		const searchResult = '### big.ts:1-10 (score 1)\n' + 'q'.repeat(400);
		writeFileSync(join(dir, 'a.jsonl'),
			user('fix the bug') +
			asst('a1', u(1000, 50), [{ type: 'tool_use', id: 't1', name: 'mcp__riaf__search_codebase', input: { query: 'bug' } }]) +
			user([{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: searchResult }] }]) +
			asst('a2', u(1500, 80), [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'big.ts' } }]) +
			user([{ type: 'tool_result', tool_use_id: 't2', content: 'x' }]) +
			user([{ type: 'text', text: 'now add a test' }]) +
			asst('a3', u(2000, 120, 500), [{ type: 'text', text: 'done' }]));
		// session B: no RIAF — 1 turn, 2 calls, three native reads, bigger prompts
		writeFileSync(join(dir, 'b.jsonl'),
			user('explain the module') +
			asst('b1', u(6000, 100), [{ type: 'tool_use', id: 'r1', name: 'Grep', input: {} }, { type: 'tool_use', id: 'r2', name: 'Read', input: {} }]) +
			user([{ type: 'tool_result', tool_use_id: 'r1', content: 'x' }, { type: 'tool_result', tool_use_id: 'r2', content: 'y' }]) +
			asst('b2', u(9000, 300), [{ type: 'tool_use', id: 'r3', name: 'Read', input: {} }]));

		const e = readClaudeUsage(repo, home).riafEffect!;
		expect(e.with).toMatchObject({ sessions: 1, userTurns: 2, calls: 3, promptTokens: 5000, outputTokens: 250, nativeReads: 1, riafCalls: 1 });
		expect(e.without).toMatchObject({ sessions: 1, userTurns: 1, calls: 2, promptTokens: 15000, outputTokens: 400, nativeReads: 3, riafCalls: 0 });
		expect(e.with.avgPromptPerCall).toBeCloseTo(5000 / 3, 5);
		expect(e.without.avgPromptPerCall).toBe(7500);
		expect(e.promptPerCallSavedPct).toBeCloseTo(1 - (5000 / 3) / 7500, 5);          // ≈ 78 % lower per call with RIAF
		expect(e.outputPerCallSavedPct).toBeCloseTo(1 - (250 / 3) / 200, 5);
		expect(e.readsPerTurnSavedPct).toBeCloseTo(1 - (1 / 2) / 3, 5);
		expect(e.directSavedTokens).toBe(Math.round((20_000 - searchResult.length) / 4));
		expect(e.directSavedPct).toBeCloseTo(e.directSavedTokens / (5000 + e.directSavedTokens), 5);
		expect(e.byTool).toEqual({ search_codebase: { calls: 1, savedTokens: e.directSavedTokens } });
	});

	it('leaves the percentages undefined when one side has no sessions', () => {
		const home = mkdtempSync(join(tmpdir(), 'riaf-effect-home-'));
		const repo = '/work/only-riaf';
		const dir = join(home, 'projects', '-work-only-riaf'); mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'a.jsonl'),
			line({ type: 'user', message: { role: 'user', content: 'hi' } }) +
			line({ type: 'assistant', message: { id: 'x', model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 't', name: 'mcp__riaf__grep', input: {} }] } }));
		const e = readClaudeUsage(repo, home).riafEffect!;
		expect(e.with.calls).toBe(1); expect(e.without.calls).toBe(0);
		expect(e.promptPerCallSavedPct).toBeUndefined();
		expect(e.byTool).toEqual({});                                                   // no tool_result line → nothing to estimate
	});
});
