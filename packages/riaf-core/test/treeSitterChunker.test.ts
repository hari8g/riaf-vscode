/**
 * P1: AST chunking / symbols via web-tree-sitter, with the regex chunker as fallback.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chunkFile, extractSymbolsFromFile } from '../src/codeChunker.js';
import {
	ensureTreeSitterLanguages, flattenOutline, isImportOnlyBlock, parseOutline, setTreeSitterEnabled, treeSitterReady,
} from '../src/treeSitterChunker.js';

const H = 'ws';

beforeAll(async () => {
	setTreeSitterEnabled(true);
	const ready = await ensureTreeSitterLanguages(['TypeScript', 'TSX', 'JavaScript', 'Python', 'Java', 'Go', 'Rust']);
	expect(ready).toEqual(expect.arrayContaining(['TypeScript', 'Python', 'Java', 'Go', 'Rust']));
});
afterAll(() => setTreeSitterEnabled(true));

describe('parseOutline', () => {
	it('TypeScript: exports, enums, type aliases, arrow consts and class methods with doc comments', () => {
		const src = [
			"import { x } from './x';",
			'',
			'/** Lifecycle states. */',
			"export enum OrderStatus { Pending = 'pending', Paid = 'paid' }",
			'export type Money = { cents: number };',
			'export interface Repo { get(id: string): Order | undefined }',
			'const internal = 1;',
			'const helper = (a: number) => a + 1;',
			'export const fmt = (m: Money) => `${m.cents}`;',
			'',
			'@injectable()',
			'export class OrderService {',
			'  private readonly orders = new Map<string, Order>();',
			'  /** Creates an order. */',
			'  async createOrder(input: Input): Promise<Order> { return null as any; }',
			'  handle = () => { };',
			'  static of(): OrderService { return new OrderService(); }',
			'}',
			'export default function main() {}',
			'function hidden() {}',
		].join('\n');
		const outline = parseOutline(src, 'TypeScript', 'src/a.ts')!;
		expect(outline).not.toBeNull();
		const byName = Object.fromEntries(flattenOutline(outline).map(d => [d.name, d]));
		expect(byName.OrderStatus).toMatchObject({ kind: 'enum', isExported: true, startLine: 3, endLine: 4, docstring: 'Lifecycle states.' });
		expect(byName.Money.kind).toBe('type');
		expect(byName.Repo.kind).toBe('interface');
		expect(byName.internal, 'plain locals are not symbols').toBeUndefined();
		expect(byName.helper).toMatchObject({ kind: 'const', isExported: false });
		expect(byName.fmt).toMatchObject({ kind: 'const', isExported: true });
		expect(byName.OrderService).toMatchObject({ kind: 'class', isExported: true, startLine: 11, endLine: 18 });
		expect(byName.OrderService.children.map(c => c.name)).toEqual(['createOrder', 'handle', 'of']);
		expect(byName.createOrder).toMatchObject({ kind: 'function', parentName: 'OrderService', docstring: 'Creates an order.', startLine: 14, endLine: 15 });
		expect(byName.createOrder.signature).toBe('async createOrder(input: Input): Promise<Order> { return null as any; }');
		expect(byName.main).toMatchObject({ kind: 'function', isExported: true });
		expect(byName.hidden).toMatchObject({ kind: 'function', isExported: false });
	});

	it('TSX files use the tsx grammar', () => {
		const src = 'export const App = () => <div>hi</div>;\nfunction Inner(): JSX.Element { return <span/>; }\n';
		const outline = parseOutline(src, 'TypeScript', 'src/App.tsx')!;
		expect(outline.map(d => d.name)).toEqual(['App', 'Inner']);
	});

	it('Python: decorated defs, methods, docstrings and underscore visibility', () => {
		const src = [
			'import os',
			'',
			'class Greeter:',
			'    """Says hello."""',
			'    def __init__(self, name):',
			'        self.name = name',
			'',
			'    @property',
			'    def upper(self):',
			'        return self.name.upper()',
			'',
			'@lru_cache',
			'def add(a, b):',
			'    """Add two numbers."""',
			'    return a + b',
			'',
			'def _private(): pass',
		].join('\n');
		const byName = Object.fromEntries(flattenOutline(parseOutline(src, 'Python')!).map(d => [d.name, d]));
		expect(byName.Greeter).toMatchObject({ kind: 'class', docstring: 'Says hello.', startLine: 3, endLine: 10 });
		expect(byName.Greeter.children.map(c => c.name)).toEqual(['__init__', 'upper']);
		expect(byName.upper).toMatchObject({ startLine: 8, parentName: 'Greeter' });       // decorator included
		expect(byName.add).toMatchObject({ kind: 'function', isExported: true, startLine: 12, docstring: 'Add two numbers.' });
		expect(byName._private.isExported).toBe(false);
	});

	it('Java: annotated classes, methods, constructors, interfaces, enums, records', () => {
		const src = [
			'package com.example;',
			'import java.util.List;',
			'/** Orders API. */',
			'@RestController',
			'@RequestMapping("/api/orders")',
			'public class OrderController {',
			'    private final Repo repo;',
			'    public OrderController(Repo repo) { this.repo = repo; }',
			'    @GetMapping',
			'    public List<OrderDto> listOrders() { return repo.findAll(); }',
			'    private void helper() {}',
			'    public enum Mode { A, B }',
			'}',
			'interface Repo { List<OrderDto> findAll(); }',
			'public record OrderDto(String id) {}',
		].join('\n');
		const all = flattenOutline(parseOutline(src, 'Java')!);
		const byName = Object.fromEntries(all.map(d => [d.name, d]));
		const cls = all.find(d => d.name === 'OrderController' && d.kind === 'class')!;
		expect(cls).toMatchObject({ kind: 'class', isExported: true, startLine: 3, endLine: 13, docstring: 'Orders API.' });
		expect(cls.signature).toBe('public class OrderController');
		// the constructor is a symbol with the class name too
		expect(all.find(d => d.name === 'OrderController' && d.kind === 'function')).toMatchObject({ parentName: 'OrderController', startLine: 8 });
		expect(byName.listOrders).toMatchObject({ kind: 'function', isExported: true, parentName: 'OrderController', startLine: 9 });
		expect(byName.helper.isExported).toBe(false);
		expect(byName.Mode).toMatchObject({ kind: 'enum', parentName: 'OrderController' });
		expect(byName.Repo).toMatchObject({ kind: 'interface', isExported: false });
		expect(byName.findAll).toMatchObject({ parentName: 'Repo' });
		expect(byName.OrderDto).toMatchObject({ kind: 'class', isExported: true });
	});

	it('Go: structs, interfaces, functions and methods with capitalisation as export', () => {
		const src = 'package m\n\n// Server serves.\ntype Server struct{ port int }\ntype Handler interface{ Serve() }\ntype alias = int\nfunc (s *Server) Start() error { return nil }\nfunc helper() {}\n';
		const byName = Object.fromEntries(flattenOutline(parseOutline(src, 'Go')!).map(d => [d.name, d]));
		expect(byName.Server).toMatchObject({ kind: 'class', isExported: true, docstring: 'Server serves.', startLine: 3 });
		expect(byName.Handler.kind).toBe('interface');
		expect(byName.alias.kind).toBe('type');
		expect(byName.Start).toMatchObject({ kind: 'function', isExported: true });
		expect(byName.helper.isExported).toBe(false);
	});

	it('Rust: pub visibility, impl blocks with nested fns, traits, enums', () => {
		const src = 'pub struct S;\npub trait T { fn t(&self); }\nimpl S {\n    pub fn new() -> S { S }\n    fn secret() {}\n}\nfn f() {}\npub enum E { A }\npub const MAX: u8 = 1;\n';
		const byName = Object.fromEntries(flattenOutline(parseOutline(src, 'Rust')!).map(d => [d.name, d]));
		expect(byName.S).toMatchObject({ kind: 'class', isExported: true });
		expect(byName['impl S']).toMatchObject({ kind: 'class', isExported: false, startLine: 3, endLine: 6 });
		expect(byName.T.kind).toBe('interface');
		expect(byName.new).toMatchObject({ isExported: true, parentName: 'impl S' });
		expect(byName.secret).toMatchObject({ isExported: false, parentName: 'impl S' });
		expect(byName.f.isExported).toBe(false);
		expect(byName.E.kind).toBe('enum');
		expect(byName.MAX).toMatchObject({ kind: 'const', isExported: true });
	});

	it('returns null for languages without a grammar and when disabled', () => {
		expect(parseOutline('CREATE TABLE t (id int);', 'SQL')).toBeNull();
		expect(parseOutline('# Title\n', 'Markdown')).toBeNull();
		setTreeSitterEnabled(false);
		try {
			expect(treeSitterReady('TypeScript')).toBe(false);
			expect(parseOutline('export function f() {}', 'TypeScript')).toBeNull();
		} finally { setTreeSitterEnabled(true); }
		expect(treeSitterReady('TypeScript')).toBe(true);
	});
});

describe('chunkFile with the AST outline', () => {
	it('one chunk per top-level definition, doc comment attached, import-only preamble dropped', () => {
		const src = [
			"import a from 'a';",
			"import { b } from 'b';",
			'',
			'/** doc */',
			'export function one() {',
			'  return 1;',
			'}',
			'',
			'export class Two {',
			'  m() { return 2; }',
			'  n() { return 3; }',
			'}',
			'',
			'export const three = () => {',
			'  return 3;',
			'};',
		].join('\n');
		const chunks = chunkFile(H, 'src/x.ts', src, 'TypeScript');
		expect(chunks.map(c => [c.chunkType, c.startLine, c.endLine])).toEqual([
			['function', 4, 7],
			['class', 9, 12],
			['block', 14, 16],
		]);
		expect(chunks[0].chunkText.startsWith('/** doc */')).toBe(true);
	});

	it('splits an oversized class at method boundaries, keeping a `class` header chunk', () => {
		const methods = Array.from({ length: 6 }, (_, i) => [
			`  /** method ${i} */`,
			`  method${i}(): number {`,
			...Array.from({ length: 20 }, (_, k) => `    const v${k} = ${k};`),
			`    return ${i};`,
			'  }',
		].join('\n'));
		const src = `export class Big {\n  private field = 1;\n${methods.join('\n')}\n}\n`;
		const chunks = chunkFile(H, 'src/big.ts', src, 'TypeScript');
		expect(chunks.length).toBeGreaterThanOrEqual(6);
		for (const c of chunks) expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(80);
		// the two-line header is merged into the first method so the class name stays retrievable
		expect(chunks[0].chunkType).toBe('class');
		expect(chunks[0].chunkText).toContain('export class Big');
		expect(chunks[0].chunkText).toContain('method0()');
		const methodChunks = chunks.filter(c => c.chunkType === 'function');
		expect(methodChunks).toHaveLength(5);
		expect(methodChunks[1].chunkText.startsWith('  /** method 2 */')).toBe(true);
		// every line of the file is covered exactly once (header, methods, closing brace)
		const covered = new Set<number>();
		for (const c of chunks) for (let l = c.startLine; l <= c.endLine; l++) { expect(covered.has(l)).toBe(false); covered.add(l); }
	});

	it('module-level code between definitions is kept as block chunks', () => {
		const src = [
			'export function f() {',
			'  return 1;',
			'}',
			'const registry = new Map();',
			'registry.set("f", f);',
			'console.log(registry.size);',
			'export function g() {',
			'  return 2;',
			'}',
		].join('\n');
		const chunks = chunkFile(H, 'src/m.ts', src, 'TypeScript');
		expect(chunks.map(c => c.chunkType)).toEqual(['function', 'block', 'function']);
		expect(chunks[1].chunkText).toContain('registry.set');
	});

	it('falls back to the regex chunker when tree-sitter is disabled and for grammar-less languages', () => {
		const src = 'export function one() {\n  return 1;\n}\nexport function two() {\n  return 2;\n}\n';
		const ast = chunkFile(H, 'src/x.ts', src, 'TypeScript');
		setTreeSitterEnabled(false);
		try {
			const rx = chunkFile(H, 'src/x.ts', src, 'TypeScript');
			expect(rx.map(c => c.startLine)).toEqual(ast.map(c => c.startLine));   // same boundaries for this simple file
			const syms = extractSymbolsFromFile(H, 'src/x.ts', src, 'TypeScript');
			expect(syms.map(s => s.name)).toEqual(['one', 'two']);
		} finally { setTreeSitterEnabled(true); }
		const sql = chunkFile(H, 'db.sql', 'CREATE TABLE a (\n  id int\n);\nCREATE TABLE b (\n  id int\n);\n', 'SQL');
		expect(sql.map(c => c.chunkType)).toEqual(['class', 'class']);
	});
});

describe('extractSymbolsFromFile with the AST outline', () => {
	it('records methods with their class in the signature and enums as symbols', () => {
		const src = 'export enum Color { Red }\nexport class Svc {\n  run(): void {}\n}\n';
		const syms = extractSymbolsFromFile(H, 'src/s.ts', src, 'TypeScript');
		expect(syms.map(s => `${s.kind}:${s.name}`)).toEqual(['enum:Color', 'class:Svc', 'function:run']);
		expect(syms[2].signature).toBe('Svc.run(): void');
		expect(syms.every(s => s.contentHash.length === 16)).toBe(true);
	});
});

describe('isImportOnlyBlock', () => {
	it('recognises import / package / require preambles and rejects code', () => {
		expect(isImportOnlyBlock("import a from 'a';\nimport {\n  b,\n  c,\n} from 'b';\n// comment\n")).toBe(true);
		expect(isImportOnlyBlock('package com.example;\nimport java.util.List;\n')).toBe(true);
		expect(isImportOnlyBlock("const fs = require('fs');\nconst { join } = require('path');")).toBe(true);
		expect(isImportOnlyBlock('from os import path\nimport sys\n"""module doc"""')).toBe(true);
		expect(isImportOnlyBlock("import a from 'a';\nconst x = 1;")).toBe(false);
		expect(isImportOnlyBlock('registry.set("f", f);')).toBe(false);
	});
});
