/**
 * P2: symbol graph — calls / instantiates / extends / implements / imports between definitions,
 * find_references + neighbourhood through RiafIndex, real graph depth.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { extractSymbolsFromFile } from '../src/codeChunker.js';
import { ensureTreeSitterLanguages } from '../src/treeSitterChunker.js';
import { extractImports } from '../src/universalImportExtractor.js';
import { computeMaxDepth, computeMetrics } from '../src/universalGraphAnalyzer.js';
import { extractImportBindings, extractInheritance, extractSymbolEdges, formatNeighborhood, maskSource, type SymbolEdge } from '../src/symbolGraph.js';
import { RiafIndex } from '../src/riafIndex.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample-repo');

/** Resolver over an in-memory "workspace": name → files that define it. */
const resolverFrom = (definers: Record<string, string[]>) => (name: string, ctx: { importedFiles: Set<string> }) => {
	const files = definers[name];
	if (!files?.length) return null;
	if (files.length === 1) return files[0];
	const imp = files.filter(f => ctx.importedFiles.has(f));
	return imp.length === 1 ? imp[0] : null;
};

async function edgesFor(filePath: string, content: string, language: string, definers: Record<string, string[]>, root = '/ws'): Promise<SymbolEdge[]> {
	await ensureTreeSitterLanguages([language]);
	const symbols = extractSymbolsFromFile('ws', filePath, content, language);
	const importEdges = extractImports(join(root, filePath), content, language, root);
	return extractSymbolEdges({ filePath, content, language, symbols, importEdges, resolve: resolverFrom(definers) });
}

describe('symbolGraph: lexical building blocks', () => {
	it('masks strings and comments but keeps line structure', () => {
		const src = `const a = foo("bar(baz)"); // call(x)\n/* block\n call(y) */ const b = 'q(' + \`t(\${z})\`;\n# not a comment in TS\n`;
		const masked = maskSource(src, 'TypeScript');
		expect(masked.split('\n').length).toBe(src.split('\n').length);
		expect(masked).toContain('foo(');
		expect(masked).not.toContain('bar(baz)');
		expect(masked).not.toContain('call(');
		expect(masked).toContain('# not a comment in TS');
		const py = maskSource('x = f(1)  # g(2)\n"""doc h(3)"""\ny = "i(4)"\n', 'Python');
		expect(py).toContain('f(1)');
		for (const s of ['g(2)', 'h(3)', 'i(4)']) expect(py).not.toContain(s);
	});

	it('extracts import bindings per language and links them to resolved files', () => {
		const ts = extractImportBindings(
			`import React, { useState, type FC } from 'react';\nimport * as path from 'node:path';\nimport { Order as O,\n  OrderStatus } from './models/order';\nconst { readFile } = require('fs');\nexport { helper } from './helper';\n`,
			'TypeScript',
			[{ fromFile: 'a.ts', toModule: './models/order', resolvedFile: 'src/models/order.ts', isExternal: false, edgeType: 'import' }, { fromFile: 'a.ts', toModule: 'react', resolvedFile: null, isExternal: true, edgeType: 'import' }, { fromFile: 'a.ts', toModule: './helper', resolvedFile: 'src/helper.ts', isExternal: false, edgeType: 'import' }],
		);
		const byName = Object.fromEntries(ts.map(b => [b.name, b]));
		expect(byName.React).toMatchObject({ module: 'react', file: null, isNamespace: true });
		expect(byName.useState.module).toBe('react');
		expect(byName.FC.module).toBe('react');
		expect(byName.path).toMatchObject({ module: 'node:path', isNamespace: true });
		expect(byName.O).toMatchObject({ module: './models/order', file: 'src/models/order.ts', line: 3 });
		expect(byName.OrderStatus.file).toBe('src/models/order.ts');
		expect(byName.readFile.module).toBe('fs');
		expect(byName.helper.file).toBe('src/helper.ts');

		const py = extractImportBindings('from .utils import add_numbers, circle_area as area\nimport os, json as j\nfrom pkg.mod import (\n  A,\n  B,\n)\n', 'Python', []);
		expect(py.map(b => b.name).sort()).toEqual(['A', 'B', 'add_numbers', 'area', 'j', 'os']);
		const java = extractImportBindings('import java.util.List;\nimport static com.acme.Util.helper;\nimport com.acme.orders.*;\n', 'Java', []);
		expect(java.map(b => b.name)).toEqual(['List', 'helper', 'orders']);
		const go = extractImportBindings('import (\n\t"fmt"\n\torders "github.com/acme/svc/internal/orders"\n\t"github.com/acme/svc/internal/store"\n)\n', 'Go', []);
		expect(go.map(b => b.name)).toEqual(['fmt', 'orders', 'store']);
		const rust = extractImportBindings('use std::collections::{HashMap, HashSet as Set};\nuse crate::orders::Order;\npub use crate::util::*;\n', 'Rust', []);
		expect(rust.map(b => b.name)).toEqual(['HashMap', 'Set', 'Order']);
	});

	it('extracts inheritance clauses across languages', () => {
		const ts = extractInheritance('export class Admin<T> extends User<T> implements Auditable, Serializable {\ninterface Big extends Small {}\nclass Multi\n  extends Base {}\n', 'TypeScript');
		expect(ts).toEqual(expect.arrayContaining([
			{ subtype: 'Admin', supertype: 'User', edgeType: 'extends', line: 1 },
			{ subtype: 'Admin', supertype: 'Auditable', edgeType: 'implements', line: 1 },
			{ subtype: 'Admin', supertype: 'Serializable', edgeType: 'implements', line: 1 },
			{ subtype: 'Big', supertype: 'Small', edgeType: 'extends', line: 2 },
			{ subtype: 'Multi', supertype: 'Base', edgeType: 'extends', line: 4 },
		]));
		expect(extractInheritance('class Dog(Animal, Walker):\nclass Base(object): pass\nclass Meta(metaclass=ABCMeta): pass\n', 'Python').map(i => `${i.subtype}<${i.supertype}`)).toEqual(['Dog<Animal', 'Dog<Walker']);
		expect(extractInheritance('public class OrderRepo extends JpaRepo<Order, Long> implements Searchable {', 'Java').map(i => `${i.subtype}:${i.edgeType}:${i.supertype}`)).toEqual(['OrderRepo:extends:JpaRepo', 'OrderRepo:implements:Searchable']);
		expect(extractInheritance('impl<T> Display for Wrapper<T> {\nimpl Wrapper<T> {\n', 'Rust')).toEqual([{ subtype: 'Wrapper', supertype: 'Display', edgeType: 'implements', line: 1 }]);
		expect(extractInheritance('public class Svc : BaseSvc, IDisposable {', 'C#').map(i => `${i.edgeType}:${i.supertype}`)).toEqual(['extends:BaseSvc', 'implements:IDisposable']);
		expect(extractInheritance('type Server struct {\n\t*BaseServer\n\tName string\n\tLogger\n}\n', 'Go').map(i => i.supertype)).toEqual(['BaseServer', 'Logger']);
		expect(extractInheritance('class Admin < User\n  include Auditable\nend\n', 'Ruby').map(i => `${i.edgeType}:${i.supertype}`)).toEqual(['extends:User', 'implements:Auditable']);
	});
});

describe('symbolGraph: edge extraction', () => {
	it('TypeScript: attributes calls to the enclosing method, resolves callees through imports, skips declarations and builtins', async () => {
		const content = `import { Logger, createLogger } from './logger';
import { Order, OrderStatus } from './models/order';
import { format } from 'date-fns';

export class OrderService extends BaseService implements Lifecycle {
	constructor(private readonly logger: Logger) { super(); }

	createOrder(input: { customerId: string }): Order {
		const order = buildOrder(input);          // local helper
		this.logger.info(format(new Date(), 'x'));
		this.validate(order);
		return order;
	}

	private validate(order: Order): void {
		if (order.status !== OrderStatus.Pending) { throw new Error('bad'); }
		audit(order);                              // defined in audit.ts, imported by nobody here
	}
}

export function buildOrder(input: { customerId: string }): Order { return { id: '1', customerId: input.customerId, status: OrderStatus.Pending } as Order; }
const log = createLogger('svc');
`;
		const edges = await edgesFor('src/orderService.ts', content, 'TypeScript', {
			Logger: ['src/logger.ts'], createLogger: ['src/logger.ts'], Order: ['src/models/order.ts'], OrderStatus: ['src/models/order.ts'],
			BaseService: ['src/base.ts'], Lifecycle: ['src/base.ts'], audit: ['src/audit.ts'], buildOrder: ['src/orderService.ts'], validate: ['src/orderService.ts'],
		});
		const key = (e: SymbolEdge) => `${e.edgeType}:${e.fromSymbol ?? '<module>'}->${e.toName}@${e.toFile}`;
		const keys = edges.map(key);
		expect(keys).toEqual(expect.arrayContaining([
			'imports:<module>->Logger@src/logger.ts',
			'imports:<module>->createLogger@src/logger.ts',
			'imports:<module>->Order@src/models/order.ts',
			'extends:OrderService->BaseService@src/base.ts',
			'implements:OrderService->Lifecycle@src/base.ts',
			'calls:OrderService.createOrder->buildOrder@src/orderService.ts',
			'calls:OrderService.createOrder->validate@src/orderService.ts',
			'calls:OrderService.validate->audit@src/audit.ts',
			'calls:<module>->createLogger@src/logger.ts',
		]));
		// not edges: builtins, external library calls, the declarations themselves, `new Error`
		expect(keys.some(k => k.includes('->format@'))).toBe(false);
		expect(keys.some(k => k.includes('->Error@'))).toBe(false);
		expect(keys.some(k => k.includes('->Date@'))).toBe(false);
		expect(keys.filter(k => k.startsWith('calls:') && k.includes('->buildOrder@'))).toHaveLength(1);   // the declaration line is not a call
		expect(keys.some(k => k.startsWith('calls:') && k.includes('->validate@') && k.includes('OrderService.validate->'))).toBe(false);
		// line numbers point at the use site
		expect(edges.find(e => e.toName === 'audit')?.line).toBe(17);
	});

	it('Java: resolves constructor-injected collaborators and member calls when the callee is unique', async () => {
		const content = `package com.example.orders;

import java.util.List;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController extends BaseController {
    private final OrderRepository repository;

    public OrderController(OrderRepository repository) { this.repository = repository; }

    public List<OrderDto> listOrders() {
        return repository.findAll();
    }

    public OrderDto createOrder(CreateOrderRequest request) {
        OrderDto dto = new OrderDto();
        return repository.save(request);
    }
}
`;
		const edges = await edgesFor('java/src/main/java/com/example/orders/OrderController.java', content, 'Java', {
			OrderRepository: ['java/src/main/java/com/example/orders/OrderRepository.java'], findAll: ['java/src/main/java/com/example/orders/OrderRepository.java'],
			save: ['java/src/main/java/com/example/orders/OrderRepository.java', 'java/src/main/java/com/example/users/UserRepository.java'],
			OrderDto: ['java/src/main/java/com/example/orders/OrderDto.java'], BaseController: ['java/src/main/java/com/example/web/BaseController.java'],
		});
		const key = (e: SymbolEdge) => `${e.edgeType}:${e.fromSymbol ?? '<module>'}->${e.toName}`;
		expect(edges.map(key)).toEqual(expect.arrayContaining([
			'extends:OrderController->BaseController',
			'calls:OrderController.listOrders->findAll',
			'instantiates:OrderController.createOrder->OrderDto',
		]));
		// `save` is defined in two repositories and nothing disambiguates it → no edge rather than a wrong one
		expect(edges.some(e => e.toName === 'save')).toBe(false);
		// the constructor declaration is not an instantiation/call of itself
		expect(edges.some(e => e.toName === 'OrderController')).toBe(false);
	});

	it('Python: relative from-imports give the callee file; methods are qualified by class', async () => {
		const content = `import json
from .utils import add_numbers, circle_area


def handle_request(payload: str) -> str:
    data = json.loads(payload)
    total = add_numbers(data["base"], data["surcharge"])
    return json.dumps({"area": circle_area(1.0)})


class ShippingEstimator(BaseEstimator):
    def estimate(self, weight_kg: float) -> float:
        return add_numbers(weight_kg * self.rate, 2.5)
`;
		const edges = await edgesFor('py/app.py', content, 'Python', { add_numbers: ['py/utils.py'], circle_area: ['py/utils.py'], BaseEstimator: ['py/base.py'] });
		const key = (e: SymbolEdge) => `${e.edgeType}:${e.fromSymbol ?? '<module>'}->${e.toName}@${e.toFile}`;
		expect(edges.map(key)).toEqual(expect.arrayContaining([
			'imports:<module>->add_numbers@py/utils.py',
			'calls:handle_request->add_numbers@py/utils.py',
			'calls:handle_request->circle_area@py/utils.py',
			'calls:ShippingEstimator.estimate->add_numbers@py/utils.py',
			'extends:ShippingEstimator->BaseEstimator@py/base.py',
		]));
		expect(edges.some(e => e.toName === 'loads' || e.toName === 'dumps')).toBe(false);
	});

	it('Go and Rust: grouped imports, receiver methods and trait impls', async () => {
		const goSrc = `package api

import (
	"fmt"
	orders "github.com/acme/svc/internal/orders"
)

type Server struct {
	*BaseServer
	svc *orders.Service
}

func (s *Server) handle(w http.ResponseWriter) {
	o := orders.NewService(s.svc)
	fmt.Println(o)
	s.render(w)
}

func (s *Server) render(w http.ResponseWriter) {}
`;
		const go = await edgesFor('cmd/api/server.go', goSrc, 'Go', { NewService: ['internal/orders/service.go'], BaseServer: ['cmd/api/base.go'], render: ['cmd/api/server.go'], handle: ['cmd/api/server.go'] });
		const gk = go.map(e => `${e.edgeType}:${e.fromSymbol ?? '<module>'}->${e.toName}@${e.toFile}`);
		expect(gk).toEqual(expect.arrayContaining(['calls:handle->NewService@internal/orders/service.go', 'calls:handle->render@cmd/api/server.go', 'extends:Server->BaseServer@cmd/api/base.go']));
		expect(gk.some(k => k.includes('Println'))).toBe(false);

		const rsSrc = `use crate::orders::{Order, OrderStatus};
use std::fmt::Display;

pub struct Receipt { pub order: Order }

impl Display for Receipt {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { write!(f, "{}", total(&self.order)) }
}

pub fn total(order: &Order) -> u64 { order.amount }
`;
		const rs = await edgesFor('src/receipt.rs', rsSrc, 'Rust', { Order: ['src/orders.rs'], OrderStatus: ['src/orders.rs'], total: ['src/receipt.rs'], Receipt: ['src/receipt.rs'] });
		const rk = rs.map(e => `${e.edgeType}:${e.fromSymbol ?? '<module>'}->${e.toName}@${e.toFile}`);
		expect(rk).toEqual(expect.arrayContaining(['imports:<module>->Order@src/orders.rs', 'calls:impl Display for Receipt.fmt->total@src/receipt.rs']));
		expect(rk.some(k => k.includes('->Display@'))).toBe(false);   // std trait, not in the workspace
	});
});

describe('universalGraphAnalyzer: depth', () => {
	it('computeMaxDepth measures hops from entry points and survives cycles', () => {
		const nodes = new Set(['a', 'b', 'c', 'd', 'x', 'y', 'solo']);
		const edge = (f: string, t: string) => ({ fromFile: f, toModule: t, resolvedFile: t, isExternal: false, edgeType: 'import' as const });
		const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('x', 'y'), edge('y', 'x')];
		expect(computeMaxDepth(nodes, edges, ['a'])).toBe(3);
		const m = computeMetrics([...nodes].map(f => ({ filePath: f, language: 'TypeScript', nodeType: 'unknown', archLayer: 'service', isEntryPoint: false, importCount: 0, importedByCount: 0 })), edges);
		expect(m.maxDepth).toBe(3);
		expect(m.orphanFiles).toEqual(['solo']);
		expect(m.cycleCount).toBe(1);
	});
});

describe('RiafIndex: symbol graph end to end', () => {
	const dirs: string[] = [];
	afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

	it('answers find_references / neighbourhood for the sample repo and keeps them fresh on incremental edits', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'riaf-symgraph-'));
		dirs.push(dir);
		const root = join(dir, 'repo');
		cpSync(FIXTURE, root, { recursive: true });
		const idx = await RiafIndex.open({ workspaceRoot: root, dbPath: join(dir, 'idx.sqlite') });
		await idx.reindex();

		// who calls capturePayment? the test file, inside its `it` callback (module level)
		const refs = await idx.findReferences('capturePayment');
		expect(refs.definitions.map(d => d.filePath)).toEqual(['src/orderService.ts']);
		expect(refs.references.map(r => `${r.edgeType}:${r.fromFile}`)).toContain('calls:src/orderService.test.ts');

		// OrderService is instantiated by index.ts and the test, imported by both
		const svc = await idx.findReferences('OrderService', { filePath: 'src/orderService.ts' });
		const kinds = svc.references.map(r => `${r.edgeType}:${r.fromFile}`);
		expect(kinds).toEqual(expect.arrayContaining(['instantiates:src/index.ts', 'instantiates:src/orderService.test.ts', 'imports:src/index.ts']));

		// neighbourhood text the agent sees before editing orderService.ts
		const text = await idx.getEditNeighborhood('src/orderService.ts');
		expect(text).toMatch(/^Dependents and dependencies of src\/orderService\.ts/);
		expect(text).toContain('capturePayment called by src/orderService.test.ts:');
		expect(text).toMatch(/uses: .*createLogger|Logger.* from src\/logger\.ts/);
		const n = await idx.getNeighbors('src/orderService.ts', 'createOrder');
		expect(n.inbound.map(e => e.fromFile).sort()).toEqual(['src/index.ts', 'src/orderService.test.ts']);

		// metrics now carry real depth / orphans
		const metrics = await idx.getGraphMetrics();
		expect(metrics?.maxDepth).toBeGreaterThanOrEqual(2);     // index.ts → orderService.ts → models/order.ts
		expect(Array.isArray(metrics?.orphanFiles)).toBe(true);

		// incremental: a new caller appears → references update without a full reindex
		writeFileSync(join(root, 'src', 'cron.ts'), "import { OrderService } from './orderService';\nimport { createLogger } from './logger';\nexport function sweep(svc: OrderService) {\n\tsvc.capturePayment('ord_1');\n\tcreateLogger('cron').info('swept');\n}\n");
		await idx.indexFiles(['src/cron.ts']);
		const after = await idx.findReferences('capturePayment');
		expect(after.references.map(r => `${r.fromFile}:${r.fromSymbol}`)).toContain('src/cron.ts:sweep');
		// and disappears when the file goes
		rmSync(join(root, 'src', 'cron.ts'));
		await idx.removeFiles(['src/cron.ts']);
		expect((await idx.findReferences('capturePayment')).references.some(r => r.fromFile === 'src/cron.ts')).toBe(false);

		// formatNeighborhood is bounded
		expect(formatNeighborhood(await idx.getNeighbors('src/orderService.ts'), 120).length).toBeLessThanOrEqual(120);
		await idx.close();
	});
});
