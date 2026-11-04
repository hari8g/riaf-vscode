import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Riaf2 } from '@bosch-mps/riaf-core';
import { GOVERN_HOOK_SOURCE } from '@bosch-mps/token-opt';
import { Riaf2Host } from '../src/riaf2Host.js';
import { mergeClaudeHooks, writeClaudeGovernance } from '../src/claudeHooks.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@x' } });

function makeRepo(root: string): void {
	mkdirSync(join(root, 'src'), { recursive: true });
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }, null, 2));
	writeFileSync(join(root, 'src', 'cart.ts'), `import { price } from './price';\n\n/** Shopping cart. */\nexport class Cart {\n\tprivate items: number[] = [];\n\tadd(cents: number): void { this.items.push(cents); }\n\ttotal(): number { return price(this.items); }\n}\n`);
	writeFileSync(join(root, 'src', 'price.ts'), `/** Sum prices in cents. */\nexport function price(items: number[]): number {\n\treturn items.reduce((a, b) => a + b, 0);\n}\n`);
	writeFileSync(join(root, 'src', 'cart.test.ts'), `import { Cart } from './cart';\ntest('total', () => { const c = new Cart(); c.add(1); expect(c.total()).toBe(1); });\n`);
	git(root, 'init', '-q', '-b', 'main');
	git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'feat: cart with totals');
	writeFileSync(join(root, 'src', 'price.ts'), readFileSync(join(root, 'src', 'price.ts'), 'utf8') + '// rounding\n');
	writeFileSync(join(root, 'src', 'cart.ts'), readFileSync(join(root, 'src', 'cart.ts'), 'utf8') + '// rounding\n');
	git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'fix: cart total rounding because prices were floats');
}

describe('Riaf2Host (MCP-side wiring of index, compiler and governor)', () => {
	let dir: string; let root: string; let riaf: Riaf2; let host: Riaf2Host;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'riaf-host-'));
		root = join(dir, 'repo');
		makeRepo(root);
		riaf = await Riaf2.open({ workspaceRoot: root, dbPath: join(dir, 'index.sqlite'), persistDebounceMs: 20 });
		await riaf.indexRepo();
		host = new Riaf2Host(riaf, { host: 'test', hookPackBudget: 6_000 });
	}, 60_000);
	afterAll(async () => { await host.stop(); await riaf.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

	it('compiles a pack on the first substantive prompt and writes .claude/riaf/pack.md', async () => {
		const out = await host.handleHook({ session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'Fix the Cart total so it rounds to whole cents' }) as { hookSpecificOutput: { additionalContext: string } };
		expect(out.hookSpecificOutput.additionalContext).toMatch(/RIAF compiled a Context Pack/);
		expect(out.hookSpecificOutput.additionalContext).toMatch(/src\/cart\.ts/);
		expect(existsSync(join(root, '.claude', 'riaf', 'pack.md'))).toBe(true);
		// Only once per session.
		expect(await host.handleHook({ session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'and also check the price helper please' })).toEqual({});
		const start = await host.handleHook({ session_id: 's2', hook_event_name: 'SessionStart', source: 'startup' }) as { hookSpecificOutput: { additionalContext: string } };
		expect(start.hookSpecificOutput.additionalContext).toMatch(/still current/);
	});

	it('serves repeat reads, re-indexes after an Edit, and persists cache + metrics', async () => {
		const read = { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(root, 'src', 'price.ts') } };
		expect(await host.handleHook(read)).toEqual({});
		const post = await host.handleHook({ ...read, hook_event_name: 'PostToolUse', tool_response: { file: { content: 'x' } } }) as { hookSpecificOutput?: { additionalContext: string } };
		// price.ts co-changes with cart.ts and is imported by it → the prefetcher offers neighbours (if any qualify).
		void post;
		const again = await host.handleHook(read) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
		expect(again.hookSpecificOutput.permissionDecision).toBe('deny');
		expect(again.hookSpecificOutput.permissionDecisionReason).toMatch(/export function price/);

		writeFileSync(join(root, 'src', 'price.ts'), `/** Sum prices in cents, rounded. */\nexport function priceRounded(items: number[]): number {\n\treturn Math.round(items.reduce((a, b) => a + b, 0));\n}\n`);
		await host.handleHook({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(root, 'src', 'price.ts'), content: '…' }, tool_response: {} });
		expect(await host.handleHook(read)).toEqual({}); // changed → must be read again
		const syms = await riaf.index.searchSymbols('priceRounded');
		expect(syms.map(s => s.name)).toContain('priceRounded');

		const grep = { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'Cart', path: 'src' } };
		await host.handleHook(grep);
		await host.handleHook({ ...grep, hook_event_name: 'PostToolUse', tool_response: { mode: 'files_with_matches', filenames: ['src/cart.ts', 'src/cart.test.ts'] } });
		const cached = await host.handleHook(grep) as { hookSpecificOutput: { permissionDecisionReason: string } };
		expect(cached.hookSpecificOutput.permissionDecisionReason).toMatch(/tool cache[\s\S]*src\/cart\.test\.ts/);
		expect(riaf.store.raw.all('SELECT * FROM tool_cache').length).toBeGreaterThan(0);

		const status = host.statusText();
		expect(status).toMatch(/served from index/);
		expect(riaf.store.raw.all('SELECT * FROM session_metric').length).toBeGreaterThan(0);
	}, 30_000);

	it('records a plan into the current pack for sub-agents', () => {
		const p = host.setPlan(['round in price()', 'update Cart.total', 'run tests']);
		expect(riaf.currentPack()?.plan_skeleton).toEqual(p?.plan_skeleton);
		expect(host.governorFor('s1').phase).toBe('plan');
	});

	it('governs through the real hook script and endpoint', async () => {
		await host.startGovernor();
		const hookPath = join(dir, 'riaf-govern.mjs');
		writeFileSync(hookPath, GOVERN_HOOK_SOURCE);
		const run = (p: object) => new Promise<string>(res => {
			const c = spawn(process.execPath, [hookPath], { env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
			let out = ''; c.stdout.on('data', d => { out += d; }); c.on('close', () => res(out)); c.stdin.end(JSON.stringify(p));
		});
		const pre = { session_id: 's9', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(root, 'src', 'cart.ts') } };
		expect(await run(pre)).toBe('');
		await run({ ...pre, hook_event_name: 'PostToolUse', tool_response: { file: { content: 'class Cart' } } });
		const served = JSON.parse(await run(pre));
		expect(served.hookSpecificOutput.permissionDecisionReason).toMatch(/export class Cart/);
		await host.stop();
		expect(await run(pre)).toBe(''); // endpoint gone → fail open
	}, 30_000);

	it('writes the Claude Code governance integration idempotently', () => {
		const files = writeClaudeGovernance(root);
		writeClaudeGovernance(root);
		expect(files.some(f => f.endsWith('riaf-govern.mjs'))).toBe(true);
		const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
		expect(settings.hooks.PreToolUse).toHaveLength(1);
		expect(settings.hooks.PostToolUse[0].matcher).toMatch(/Edit/);
		const md = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
		expect(md.match(/riaf:begin/g)).toHaveLength(1);
		expect(existsSync(join(root, '.riaf', 'policy.yaml'))).toBe(true);
		expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/!\.riaf\/policy\.yaml/);
		const merged = mergeClaudeHooks({}, root);
		expect(JSON.stringify(merged)).toMatch(/gate\.mjs/);
		expect(JSON.stringify(merged)).toMatch(/riaf-govern\.mjs/);
		expect(JSON.stringify(mergeClaudeHooks({}, root, { govern: false }))).not.toMatch(/riaf-govern/);
	});
});
