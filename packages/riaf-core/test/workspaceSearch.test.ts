/**
 * P1: grep (ripgrep + pure-JS fallback) and glob over the workspace with shared exclusions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { RiafIndex } from '../src/riafIndex.js';
import { compileFileGlob } from '../src/workspaceScanner.js';
import { findRipgrep, formatGrepResult, globWorkspace, grepWorkspace } from '../src/workspaceSearch.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');
let dir: string;
let root: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'riaf-search-'));
	root = join(dir, 'repo');
	cpSync(FIXTURE, root, { recursive: true });
	mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
	writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'capturePayment in a dependency\n');
	mkdirSync(join(root, '.github'), { recursive: true });
	writeFileSync(join(root, '.github', 'CODEOWNERS'), '* @team capturePayment-owners\n');
	writeFileSync(join(root, 'binary.bin'), Buffer.from([0x63, 0x61, 0x70, 0x74, 0x75, 0x72, 0x65, 0x00, 0x50, 0x61, 0x79]));
	writeFileSync(join(root, 'notes.md'), 'Capture Payment flow\n\ncapturePayment(id) is called by the controller.\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const rgAvailable = !!findRipgrep();

describe('compileFileGlob', () => {
	it('matches exact paths with **, *, ? and {a,b}; bare patterns match at any depth', () => {
		expect(compileFileGlob('src/**/*.ts')('src/a.ts')).toBe(true);
		expect(compileFileGlob('src/**/*.ts')('src/models/order.ts')).toBe(true);
		expect(compileFileGlob('src/*.ts')('src/models/order.ts')).toBe(false);
		expect(compileFileGlob('*.test.ts')('src/orderService.test.ts')).toBe(true);
		expect(compileFileGlob('**/Dockerfile')('svc/Dockerfile')).toBe(true);
		expect(compileFileGlob('**/*.{yml,yaml}')('k8s/dep.yaml')).toBe(true);
		expect(compileFileGlob('**/*.{yml,yaml}')('k8s/dep.json')).toBe(false);
		expect(compileFileGlob('py/?pp.py')('py/app.py')).toBe(true);
	});
});

describe.each(rgAvailable ? (['js', 'rg'] as const) : (['js'] as const))('grepWorkspace (%s engine)', engine => {
	it('finds literal matches, skips node_modules and binaries, searches dot-dirs', async () => {
		const r = await grepWorkspace(root, 'capturePayment', { engine });
		expect(r.engine).toBe(engine);
		const files = [...new Set(r.matches.map(m => m.filePath))].sort();
		expect(files).toEqual(expect.arrayContaining(['src/orderService.ts', 'src/orderService.test.ts', 'notes.md', '.github/CODEOWNERS']));
		expect(files.some(f => f.startsWith('node_modules/'))).toBe(false);
		expect(files).not.toContain('binary.bin');
		const hit = r.matches.find(m => m.filePath === 'src/orderService.ts' && m.text.includes('capturePayment(id: string)'));
		expect(hit?.line).toBe(29);
	});

	it('supports regex, case sensitivity, include globs, context and result caps', async () => {
		const re = await grepWorkspace(root, 'capture\\s*payment', { engine, regex: true });
		expect(re.matches.some(m => m.filePath === 'notes.md' && m.text === 'Capture Payment flow')).toBe(true);

		const cs = await grepWorkspace(root, 'Capture Payment', { engine, caseSensitive: true });
		expect(cs.matches.map(m => m.filePath)).toEqual(['notes.md']);

		const only = await grepWorkspace(root, 'capturePayment', { engine, include: ['src/**/*.test.ts'] });
		expect([...new Set(only.matches.map(m => m.filePath))]).toEqual(['src/orderService.test.ts']);

		const ctx = await grepWorkspace(root, 'capturePayment(id: string)', { engine, context: 1 });
		const m = ctx.matches.find(x => x.filePath === 'src/orderService.ts')!;
		expect(m.before?.map(b => b.line)).toEqual([28]);
		expect(m.after?.map(a => a.line)).toEqual([30]);
		expect(m.after?.[0].text).toContain('const order = this.orders.get(id)');

		const capped = await grepWorkspace(root, 'order', { engine, maxResults: 3 });
		expect(capped.matches).toHaveLength(3);
		expect(capped.truncated).toBe(true);
	});

	it('honours the caller\'s exclusion predicate and returns nothing for an empty pattern', async () => {
		const r = await grepWorkspace(root, 'capturePayment', { engine, isExcluded: p => p.startsWith('src/') });
		expect(r.matches.some(m => m.filePath.startsWith('src/'))).toBe(false);
		expect(r.matches.length).toBeGreaterThan(0);
		expect((await grepWorkspace(root, '', { engine })).matches).toEqual([]);
	});
});

describe('globWorkspace', () => {
	it('lists matching files sorted, without excluded dirs, with a cap', () => {
		const ts = globWorkspace(root, 'src/**/*.ts');
		expect(ts.files).toEqual(['src/index.ts', 'src/logger.ts', 'src/models/order.ts', 'src/orderService.test.ts', 'src/orderService.ts']);
		expect(globWorkspace(root, '**/*.java').files.every(f => f.endsWith('.java'))).toBe(true);
		expect(globWorkspace(root, '**/*.js').files.some(f => f.startsWith('node_modules/'))).toBe(false);
		const capped = globWorkspace(root, '**/*', { maxResults: 2 });
		expect(capped.files).toHaveLength(2);
		expect(capped.truncated).toBe(true);
		expect(globWorkspace(root, 'nothing/**').files).toEqual([]);
	});
});

describe('RiafIndex.grep / glob share the index exclusions', () => {
	it('applies .gitignore + excludeGlobs and renders a compact result', async () => {
		writeFileSync(join(root, '.gitignore'), 'generated/\nnode_modules/\n');
		const index = await RiafIndex.open({ workspaceRoot: root, dbPath: ':memory:', excludeGlobs: ['notes.md'] });
		try {
			const r = await index.grep('capturePayment', { engine: 'js' });
			const files = [...new Set(r.matches.map(m => m.filePath))];
			expect(files).not.toContain('notes.md');
			expect(files.some(f => f.startsWith('generated/'))).toBe(false);
			expect(files).toContain('src/orderService.ts');
			const text = formatGrepResult(r);
			expect(text).toMatch(/^src\/orderService\.ts\n\s+\d+: /m);
			expect(index.glob('**/*.ts').files.some(f => f.startsWith('generated/'))).toBe(false);
			expect(formatGrepResult(await index.grep('zzz-nothing-here', { engine: 'js' }))).toBe('No matches.');
		} finally {
			await index.close();
		}
	});
});
