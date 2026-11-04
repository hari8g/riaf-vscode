import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
	classifyCall, DEFAULT_POLICY, formatLines, formatMetrics, GOVERN_HOOK_SOURCE, GovernorServer, handleClaudeHook, mergeGovernHooks,
	parsePolicy, parseYamlSubset, DEFAULT_POLICY_YAML, requestGovernor, resolvePolicy, toolResponseText, ToolGovernor,
	type CacheEntry, type CacheStore, type GovernorBackend, type GovernorPolicy,
} from '../src/governor/index.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

function makeBackend(root: string, extra: Partial<GovernorBackend> = {}): GovernorBackend & { writes: string[][]; tree: number } {
	const b: GovernorBackend & { writes: string[][]; tree: number } = {
		writes: [] as string[][],
		tree: 1,
		relative: (p: string) => (p.startsWith(root) ? relative(root, p) : p).replace(/\\/g, '/').replace(/^\.\//, ''),
		readFile: (p: string) => { try { return readFileSync(join(root, p), 'utf8'); } catch { return null; } },
		blobHash: (p: string) => { try { return hash(readFileSync(join(root, p), 'utf8')); } catch { return null; } },
		treeVersion: (): string => String(b.tree),
		prefetchCandidates: (p: string) => (p === 'src/a.ts' ? [{ path: 'src/a.test.ts', reason: 'tests src/a.ts' }, { path: 'src/b.ts', reason: 'co-changes 80%' }] : []),
		outline: (p: string) => `outline of ${p}`,
		onWrite: (paths: string[]) => { b.writes.push(paths); b.tree++; },
		...extra,
	};
	return b;
}

const policy = (patch: (p: GovernorPolicy) => void): GovernorPolicy => { const p = JSON.parse(JSON.stringify(DEFAULT_POLICY)) as GovernorPolicy; patch(p); return p; };

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'riaf-gov-'));
	mkdirSync(join(dir, 'src'), { recursive: true });
	writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
	writeFileSync(join(dir, 'src', 'b.ts'), 'export const z = 1;\n');
	writeFileSync(join(dir, 'src', 'a.test.ts'), 'test("a", () => {});\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

describe('policy', () => {
	it('parses the default YAML to the defaults', () => {
		expect(parsePolicy(DEFAULT_POLICY_YAML)).toEqual(DEFAULT_POLICY);
	});
	it('parses nested maps, flow maps, comments and k-suffixes; ignores bad values', () => {
		const y = parseYamlSubset('a:\n  b: 1 # c\n  d: { e: 2k, f: "x" }\ng: true\n');
		expect(y).toEqual({ a: { b: 1, d: { e: 2000, f: 'x' } }, g: true });
		const p = resolvePolicy({ phases: { explore: { soft_calls: 999, max_calls: 10 } }, guard: { loop_threshold: 'x' } });
		expect(p.phases.explore.soft_calls).toBe(10);
		expect(p.guard.loop_threshold).toBe(3);
		expect(() => parseYamlSubset('just text')).toThrow(/line 1/);
	});
});

describe('classifyCall', () => {
	it('classifies Claude Code and generic tool names', () => {
		expect(classifyCall({ tool: 'Read', args: {} })).toBe('read');
		expect(classifyCall({ tool: 'Grep', args: {} })).toBe('search');
		expect(classifyCall({ tool: 'Glob', args: {} })).toBe('search');
		expect(classifyCall({ tool: 'LS', args: {} })).toBe('list');
		expect(classifyCall({ tool: 'Edit', args: {} })).toBe('write');
		expect(classifyCall({ tool: 'Bash', args: { command: 'git log --oneline -5 src/a.ts' } })).toBe('shell-read');
		expect(classifyCall({ tool: 'Bash', args: { command: 'npm test' } })).toBe('test');
		expect(classifyCall({ tool: 'Bash', args: { command: 'sed -i s/a/b/ x.ts' } })).toBe('shell');
		expect(classifyCall({ tool: 'Bash', args: { command: 'cat a.ts > b.ts' } })).toBe('shell');
		expect(classifyCall({ tool: 'Bash', args: { command: 'grep -rn foo src' } })).toBe('shell-read');
	});
	it('formats lines like the Read tool', () => {
		expect(formatLines('x\ny\nz\n', 2, 1)).toBe('     2\ty');
	});
});

describe('ToolGovernor', () => {
	it('allows the first read and serves an unchanged repeat read from the session', async () => {
		const g = new ToolGovernor({ backend: makeBackend(dir), host: 'test' });
		const call = { tool: 'Read', args: { file_path: join(dir, 'src', 'a.ts') } };
		const first = await g.guard(call);
		expect(first.decision).toBe('allow');
		await g.record(call, 'export const a = 1;…');
		const second = await g.guard(call);
		expect(second.decision).toBe('serve');
		if (second.decision === 'serve') { expect(second.source).toBe('session'); expect(second.content).toMatch(/^\s+1\texport const a = 1;/); }
		// A sub-range of a full read is also served.
		const ranged = await g.guard({ tool: 'Read', args: { file_path: 'src/a.ts', offset: 2, limit: 1 } });
		expect(ranged.decision === 'serve' && ranged.content).toBe('     2\texport const b = 2;');
		const m = g.metrics();
		expect(m.served).toBe(2); expect(m.proposed).toBe(3); expect(m.callsAvoidedRate).toBeCloseTo(2 / 3);
	});

	it('never serves stale content: a write invalidates the session read and triggers re-index', async () => {
		const backend = makeBackend(dir);
		const g = new ToolGovernor({ backend });
		const read = { tool: 'Read', args: { file_path: 'src/b.ts' } };
		await g.guard(read); await g.record(read, 'x');
		writeFileSync(join(dir, 'src', 'b.ts'), 'export const z = 2;\n');
		expect((await g.guard(read)).decision).toBe('allow'); // blob changed on disk
		await g.record(read, 'y');
		const edit = { tool: 'Edit', args: { file_path: 'src/b.ts', old_string: '2', new_string: '3' } };
		await g.guard(edit); await g.record(edit, 'ok');
		expect(backend.writes).toEqual([['src/b.ts']]);
		expect(g.phase).toBe('implement');
		expect((await g.guard(read)).decision).toBe('allow');
	});

	it('serves first reads from the pack only when the policy allows it', async () => {
		const blob = hash(readFileSync(join(dir, 'src', 'a.test.ts'), 'utf8'));
		const strict = new ToolGovernor({ backend: makeBackend(dir) });
		strict.setKnownFacts({ files_read: [{ path: 'src/a.test.ts', blob }], files_listed: [] });
		expect((await strict.guard({ tool: 'Read', args: { file_path: 'src/a.test.ts' } })).decision).toBe('allow');
		const loose = new ToolGovernor({ backend: makeBackend(dir), policy: policy(p => { p.guard.serve_first_reads = true; }) });
		loose.setKnownFacts({ files_read: [{ path: 'src/a.test.ts', blob }], files_listed: [] });
		const d = await loose.guard({ tool: 'Read', args: { file_path: 'src/a.test.ts' } });
		expect(d.decision === 'serve' && d.source).toBe('pack');
		// A pack entry with a different blob is stale and must not be served.
		const stale = new ToolGovernor({ backend: makeBackend(dir), policy: policy(p => { p.guard.serve_first_reads = true; }) });
		stale.setKnownFacts({ files_read: [{ path: 'src/a.test.ts', blob: 'stale' }], files_listed: [] });
		expect((await stale.guard({ tool: 'Read', args: { file_path: 'src/a.test.ts' } })).decision).toBe('allow');
	});

	it('caches searches against the tree version and detects loops', async () => {
		const backend = makeBackend(dir);
		const store: CacheEntry[] = [];
		const cacheStore: CacheStore = { load: () => [...store], put: e => { store.push(e); }, delete: keys => { for (const k of keys) { const i = store.findIndex(e => e.key === k); if (i >= 0) store.splice(i, 1); } } };
		const g = new ToolGovernor({ backend, cacheStore });
		const grep = { tool: 'Grep', args: { pattern: 'export', path: 'src' } };
		expect((await g.guard(grep)).decision).toBe('allow');
		await g.record(grep, 'src/a.ts\nsrc/b.ts');
		const second = await g.guard(grep);
		expect(second.decision === 'serve' && second.source).toBe('cache');
		const third = await g.guard(grep);
		expect(third.decision === 'serve' && third.source).toBe('loop');
		expect(third.decision === 'serve' && third.note).toMatch(/loop warning/);
		// Persisted: a new session on the same tree starts warm.
		const g2 = new ToolGovernor({ backend, cacheStore });
		expect((await g2.guard(grep)).decision).toBe('serve');
		// Any write changes the tree → the cached search is no longer served.
		backend.tree++;
		expect((await g2.guard(grep)).decision).toBe('allow');
	});

	it('prefetches neighbours of an allowed read and delivers them after the read; tracks precision', async () => {
		const g = new ToolGovernor({ backend: makeBackend(dir) });
		const call = { tool: 'Read', args: { file_path: 'src/a.ts' } };
		const d = await g.guard(call);
		expect(d.decision === 'allow' && d.prefetch?.map(p => p.path)).toEqual(['src/a.test.ts', 'src/b.ts']);
		if (d.decision === 'allow') g.stashPrefetch(call, d.prefetch);
		const r = await g.record(call, 'content');
		expect(r.additionalContext).toMatch(/outline of src\/a\.test\.ts/);
		await g.guard({ tool: 'Read', args: { file_path: 'src/b.ts' } });
		expect(g.metrics().prefetchPrecision).toBeCloseTo(0.5);
	});

	it('reflects at the soft ceiling and blocks exploration at the hard ceiling', async () => {
		const g = new ToolGovernor({ backend: makeBackend(dir), policy: policy(p => { p.phases.explore.soft_calls = 2; p.phases.explore.max_calls = 3; p.prefetch.enabled = false; }) });
		const grep = (i: number) => ({ tool: 'Grep', args: { pattern: `p${i}` } });
		await g.guard(grep(1)); expect((await g.record(grep(1), 'x')).additionalContext).toBeUndefined();
		await g.guard(grep(2)); expect((await g.record(grep(2), 'x')).additionalContext).toMatch(/soft ceiling 2/);
		await g.guard(grep(3)); await g.record(grep(3), 'x');
		const blocked = await g.guard(grep(4));
		expect(blocked.decision).toBe('block');
		expect(blocked.decision === 'block' && blocked.reason).toMatch(/hard ceiling/);
		// Writes still run; a plan phase resets the budget.
		expect((await g.guard({ tool: 'Edit', args: { file_path: 'src/a.ts' } })).decision).toBe('allow');
		g.setPhase('plan');
		expect((await g.guard(grep(5))).decision).toBe('allow');
		expect(formatMetrics(g.metrics())).toMatch(/1 blocked/);
	});

	it('moves to the verify phase on test commands and is a no-op when disabled', async () => {
		const g = new ToolGovernor({ backend: makeBackend(dir) });
		await g.guard({ tool: 'Bash', args: { command: 'npx vitest run' } });
		expect(g.phase).toBe('verify');
		const off = new ToolGovernor({ backend: makeBackend(dir), enabled: false });
		const call = { tool: 'Read', args: { file_path: 'src/a.ts' } };
		await off.guard(call); await off.record(call, 'x');
		expect((await off.guard(call)).decision).toBe('allow');
	});
});

describe('Claude Code hook bridge', () => {
	it('maps decisions to hook outputs', async () => {
		const g = new ToolGovernor({ backend: makeBackend(dir), policy: policy(p => { p.prefetch.enabled = false; }) });
		const deps = { governorFor: () => g, onUserPrompt: async (p: string) => `pack for ${p}` };
		const pre = { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } };
		expect(await handleClaudeHook(pre, deps)).toEqual({});
		await handleClaudeHook({ ...pre, hook_event_name: 'PostToolUse', tool_response: { type: 'text', file: { content: 'abc' } } }, deps);
		const served = await handleClaudeHook(pre, deps) as { hookSpecificOutput: Record<string, string> };
		expect(served.hookSpecificOutput.permissionDecision).toBe('deny');
		expect(served.hookSpecificOutput.permissionDecisionReason).toMatch(/^\[RIAF\] Served from the RIAF index/);
		const prompt = await handleClaudeHook({ hook_event_name: 'UserPromptSubmit', prompt: 'fix x' }, deps) as { hookSpecificOutput: Record<string, string> };
		expect(prompt.hookSpecificOutput.additionalContext).toBe('pack for fix x');
		expect(toolResponseText({ stdout: 'a', stderr: 'b' })).toBe('a\nb');
		expect(toolResponseText({ filenames: ['x', 'y'] })).toBe('x\ny');
	});

	it('merges governance hooks idempotently into settings.json', () => {
		const once = mergeGovernHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }, 'node "/r/.claude/hooks/riaf-govern.mjs"');
		const twice = mergeGovernHooks(once, 'node "/other/.claude/hooks/riaf-govern.mjs"');
		const h = twice.hooks as Record<string, unknown[]>;
		expect(h.Stop).toHaveLength(1);
		expect(h.PreToolUse).toHaveLength(1);
		expect(JSON.stringify(h.PreToolUse)).toMatch(/other/);
		expect(Object.keys(h)).toEqual(expect.arrayContaining(['PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit']));
	});

	it('runs the real hook script against a live governor endpoint (and fails open without one)', async () => {
		const repo = join(dir, 'repo');
		mkdirSync(join(repo, 'src'), { recursive: true });
		writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
		const hookPath = join(dir, 'riaf-govern.mjs');
		writeFileSync(hookPath, GOVERN_HOOK_SOURCE);
		const runHook = (payload: object) => spawnSync(process.execPath, [hookPath], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: repo } });

		// No governor.json yet → fail open.
		const none = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'src/a.ts' }, cwd: repo });
		expect(none.status).toBe(0); expect(none.stdout).toBe('');

		const g = new ToolGovernor({ backend: makeBackend(repo), policy: policy(p => { p.prefetch.enabled = false; }) });
		const server = new GovernorServer(repo, async msg => ({ output: await handleClaudeHook((msg as { payload: object }).payload, { governorFor: () => g }) }));
		const info = await server.start();
		try {
			expect(existsSync(join(repo, '.riaf', 'governor.json'))).toBe(true);
			expect(await requestGovernor(info.endpoint, { type: 'claude-hook', payload: { hook_event_name: 'Noop' } })).toEqual({ output: {} });
			const pre = { session_id: 's', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(repo, 'src', 'a.ts') } };
			// spawnSync would block the event loop that serves the socket, so run the hook asynchronously.
			const { spawn } = await import('node:child_process');
			const runAsync = (p: object) => new Promise<{ code: number | null; out: string }>(res => {
				const c = spawn(process.execPath, [hookPath], { env: { ...process.env, CLAUDE_PROJECT_DIR: repo } });
				let out = ''; c.stdout.on('data', d => { out += d; }); c.on('close', code => res({ code, out }));
				c.stdin.end(JSON.stringify(p));
			});
			const first = await runAsync(pre);
			expect(first).toEqual({ code: 0, out: '' });
			await runAsync({ ...pre, hook_event_name: 'PostToolUse', tool_response: { file: { content: 'export const a = 1;' } } });
			const second = await runAsync(pre);
			expect(second.code).toBe(0);
			const out = JSON.parse(second.out);
			expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
			expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/export const a = 1;/);
			// Escape hatch.
			const c = await new Promise<string>(res => {
				import('node:child_process').then(({ spawn: sp }) => {
					const ch = sp(process.execPath, [hookPath], { env: { ...process.env, CLAUDE_PROJECT_DIR: repo, RIAF_NO_GUARD: '1' } });
					let o = ''; ch.stdout.on('data', d => { o += d; }); ch.on('close', () => res(o)); ch.stdin.end(JSON.stringify(pre));
				});
			});
			expect(c).toBe('');
		} finally {
			await server.stop();
		}
		expect(existsSync(join(repo, '.riaf', 'governor.json'))).toBe(false);
	}, 20_000);
});
