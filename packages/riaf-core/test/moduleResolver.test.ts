/**
 * P1: compiler-like import resolution against the real file set.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createModuleResolver } from '../src/moduleResolver.js';
import { extractImports } from '../src/universalImportExtractor.js';
import { RiafIndex } from '../src/riafIndex.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeRepo(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'riaf-resolve-'));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, rel)), { recursive: true });
		writeFileSync(join(root, rel), content);
	}
	return root;
}

describe('moduleResolver: TypeScript / JavaScript', () => {
	it('resolves relative imports to real files: extensions, .js→.ts rewrites, index files, directories', () => {
		const root = makeRepo({
			'tsconfig.json': '{}',
			'src/a.ts': '', 'src/b.tsx': '', 'src/util/index.ts': '', 'src/esm.ts': '', 'src/data.json': '{}',
			'src/pkg/package.json': '{"main":"lib/entry.js"}', 'src/pkg/lib/entry.js': '',
		});
		const r = createModuleResolver(root, ['tsconfig.json', 'src/a.ts', 'src/b.tsx', 'src/util/index.ts', 'src/esm.ts', 'src/data.json', 'src/pkg/package.json', 'src/pkg/lib/entry.js']);
		const from = 'src/main.ts';
		expect(r.resolve(from, './a', 'TypeScript').resolvedFile).toBe('src/a.ts');
		expect(r.resolve(from, './b', 'TypeScript').resolvedFile).toBe('src/b.tsx');
		expect(r.resolve(from, './util', 'TypeScript').resolvedFile).toBe('src/util/index.ts');
		expect(r.resolve(from, './util/index.js', 'TypeScript').resolvedFile).toBe('src/util/index.ts');
		expect(r.resolve(from, './esm.js', 'TypeScript').resolvedFile).toBe('src/esm.ts');
		expect(r.resolve(from, './data.json', 'TypeScript').resolvedFile).toBe('src/data.json');
		expect(r.resolve(from, './pkg', 'TypeScript').resolvedFile).toBe('src/pkg/lib/entry.js');
		expect(r.resolve('src/util/index.ts', '../a', 'TypeScript').resolvedFile).toBe('src/a.ts');
		// missing relative target: still internal, but dangling
		expect(r.resolve(from, './nope', 'TypeScript')).toEqual({ resolvedFile: null, isExternal: false });
		// bare specifiers that are not in the repo are external
		expect(r.resolve(from, 'react', 'TypeScript')).toEqual({ resolvedFile: null, isExternal: true });
		expect(r.resolve(from, 'node:fs', 'TypeScript').isExternal).toBe(true);
	});

	it('honours tsconfig paths + baseUrl (with extends and comments) and nearest-config precedence', () => {
		const files: Record<string, string> = {
			'tsconfig.base.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@shared/*": ["libs/shared/src/*"] } } }',
			'tsconfig.json': '// root\n{ "extends": "./tsconfig.base.json", "compilerOptions": { /* keep base paths */ } }',
			'apps/web/tsconfig.json': '{ "compilerOptions": { "baseUrl": "src", "paths": { "~/*": ["./*"], "@shared/*": ["../../libs/shared/src/*"], } } }',
			'apps/web/src/pages/home.ts': '', 'apps/web/src/components/Button.tsx': '',
			'libs/shared/src/money.ts': '', 'libs/shared/src/index.ts': '',
			'src/core/thing.ts': '',
		};
		const root = makeRepo(files);
		const r = createModuleResolver(root, Object.keys(files));
		// nested project config wins for files underneath it
		expect(r.resolve('apps/web/src/pages/home.ts', '~/components/Button', 'TypeScript').resolvedFile).toBe('apps/web/src/components/Button.tsx');
		expect(r.resolve('apps/web/src/pages/home.ts', '@shared/money', 'TypeScript').resolvedFile).toBe('libs/shared/src/money.ts');
		// baseUrl-relative bare import
		expect(r.resolve('apps/web/src/pages/home.ts', 'components/Button', 'TypeScript').resolvedFile).toBe('apps/web/src/components/Button.tsx');
		// root config (via extends) for files outside apps/web
		expect(r.resolve('src/core/thing.ts', '@shared/money', 'TypeScript').resolvedFile).toBe('libs/shared/src/money.ts');
		expect(r.resolve('src/core/thing.ts', 'src/core/thing', 'TypeScript').resolvedFile).toBe('src/core/thing.ts');
		expect(r.resolve('src/core/thing.ts', '~/components/Button', 'TypeScript').isExternal).toBe(true);
	});

	it('resolves monorepo workspace packages by package.json name, including deep imports', () => {
		const files: Record<string, string> = {
			'package.json': '{"name":"root","workspaces":["packages/*"]}',
			'packages/core/package.json': '{"name":"@acme/core","main":"dist/index.js","types":"src/index.ts"}',
			'packages/core/src/index.ts': '', 'packages/core/src/hnsw.ts': '',
			'packages/ext/package.json': '{"name":"@acme/ext"}',
			'packages/ext/src/main.ts': '',
		};
		const root = makeRepo(files);
		const r = createModuleResolver(root, Object.keys(files));
		expect(r.resolve('packages/ext/src/main.ts', '@acme/core', 'TypeScript')).toEqual({ resolvedFile: 'packages/core/src/index.ts', isExternal: false });
		expect(r.resolve('packages/ext/src/main.ts', '@acme/core/src/hnsw.js', 'TypeScript').resolvedFile).toBe('packages/core/src/hnsw.ts');
		expect(r.resolve('packages/ext/src/main.ts', '@acme/other', 'TypeScript').isExternal).toBe(true);
	});

	it('tracks file additions/removals and config reloads incrementally', () => {
		const root = makeRepo({ 'src/a.ts': '' });
		const r = createModuleResolver(root, ['src/a.ts']);
		expect(r.resolve('src/a.ts', './b', 'TypeScript').resolvedFile).toBeNull();
		writeFileSync(join(root, 'src/b.ts'), '');
		r.addFile('src/b.ts');
		expect(r.resolve('src/a.ts', './b', 'TypeScript').resolvedFile).toBe('src/b.ts');
		r.removeFile('src/b.ts');
		expect(r.resolve('src/a.ts', './b', 'TypeScript').resolvedFile).toBeNull();
		expect(r.resolve('src/a.ts', '@app/a', 'TypeScript').isExternal).toBe(true);
		writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"paths":{"@app/*":["src/*"]}}}');
		r.addFile('tsconfig.json');   // triggers reloadConfig
		expect(r.resolve('src/a.ts', '@app/a', 'TypeScript').resolvedFile).toBe('src/a.ts');
	});
});

describe('moduleResolver: Python', () => {
	const files: Record<string, string> = {
		'pyproject.toml': '[project]\nname="svc"',
		'src/svc/__init__.py': '', 'src/svc/orders/__init__.py': '', 'src/svc/orders/models.py': '', 'src/svc/payments.py': '',
		'tests/test_orders.py': '',
		'scripts/tool.py': '', 'scripts/helper.py': '',
	};
	it('resolves absolute packages via source roots, relative imports, and symbol-level from-imports', () => {
		const root = makeRepo(files);
		const r = createModuleResolver(root, Object.keys(files));
		expect(r.resolve('tests/test_orders.py', 'svc.orders.models', 'Python').resolvedFile).toBe('src/svc/orders/models.py');
		expect(r.resolve('tests/test_orders.py', 'svc.orders', 'Python').resolvedFile).toBe('src/svc/orders/__init__.py');
		expect(r.resolve('tests/test_orders.py', 'svc', 'Python').resolvedFile).toBe('src/svc/__init__.py');
		// `from svc.payments import charge` → charge is a symbol, so we land on the module
		expect(r.resolve('tests/test_orders.py', 'svc.payments.charge', 'Python').resolvedFile).toBe('src/svc/payments.py');
		expect(r.resolve('src/svc/orders/models.py', '..payments', 'Python').resolvedFile).toBe('src/svc/payments.py');
		expect(r.resolve('src/svc/orders/models.py', '.', 'Python').resolvedFile).toBe('src/svc/orders/__init__.py');
		// sibling script without a package
		expect(r.resolve('scripts/tool.py', 'helper', 'Python').resolvedFile).toBe('scripts/helper.py');
		expect(r.resolve('scripts/tool.py', 'os.path', 'Python')).toEqual({ resolvedFile: null, isExternal: false });
		expect(r.resolve('scripts/tool.py', 'requests', 'Python')).toEqual({ resolvedFile: null, isExternal: true });
	});

	it('extractImports expands `import a, b` and resolves through the resolver', () => {
		const root = makeRepo(files);
		const r = createModuleResolver(root, Object.keys(files));
		const edges = extractImports(join(root, 'tests/test_orders.py'), 'import os, sys\nfrom svc.orders.models import Order\nimport svc.payments as p\n', 'Python', root, r);
		const byMod = Object.fromEntries(edges.map(e => [e.toModule, e]));
		expect(byMod['svc.orders.models'].resolvedFile).toBe('src/svc/orders/models.py');
		expect(byMod['svc.payments'].resolvedFile).toBe('src/svc/payments.py');
		expect(byMod['sys'].isExternal).toBe(false);
	});
});

describe('moduleResolver: Java / Kotlin, Go, Rust, C', () => {
	it('maps Java packages to source files regardless of source-root prefix; static & wildcard imports', () => {
		const files = ['svc/src/main/java/com/acme/orders/OrderService.java', 'svc/src/main/java/com/acme/orders/OrderRepo.java', 'svc/src/main/kotlin/com/acme/util/Money.kt', 'svc/src/test/java/com/acme/orders/OrderServiceTest.java'];
		const root = makeRepo(Object.fromEntries(files.map(f => [f, ''])));
		const r = createModuleResolver(root, files);
		const from = files[3];
		expect(r.resolve(from, 'com.acme.orders.OrderService', 'Java').resolvedFile).toBe(files[0]);
		expect(r.resolve(from, 'com.acme.util.Money', 'Java').resolvedFile).toBe(files[2]);
		expect(r.resolve(from, 'static com.acme.orders.OrderRepo.find', 'Java').resolvedFile).toBe(files[1]);
		expect(r.resolve(from, 'com.acme.orders.OrderService.Status', 'Java').resolvedFile, 'nested class').toBe(files[0]);
		expect(r.resolve(from, 'com.acme.orders.*', 'Java')).toEqual({ resolvedFile: null, isExternal: false });
		expect(r.resolve(from, 'org.springframework.stereotype.Service', 'Java')).toEqual({ resolvedFile: null, isExternal: true });
		expect(r.resolve(from, 'java.util.List', 'Java')).toEqual({ resolvedFile: null, isExternal: false });
	});

	it('resolves Go module paths from go.mod and grouped import blocks', () => {
		const files: Record<string, string> = {
			'go.mod': 'module github.com/acme/svc\n\ngo 1.22\n',
			'cmd/api/main.go': 'package main\n\nimport (\n\t"fmt"\n\t"net/http"\n\n\torders "github.com/acme/svc/internal/orders"\n\t"github.com/acme/svc/internal/store"\n\t"github.com/gin-gonic/gin"\n)\n',
			'internal/orders/service.go': 'package orders', 'internal/orders/service_test.go': 'package orders', 'internal/orders/handler.go': 'package orders',
			'internal/store/store.go': 'package store',
		};
		const root = makeRepo(files);
		const r = createModuleResolver(root, Object.keys(files));
		const edges = extractImports(join(root, 'cmd/api/main.go'), files['cmd/api/main.go'], 'Go', root, r);
		const byMod = Object.fromEntries(edges.map(e => [e.toModule, e]));
		expect(Object.keys(byMod).sort()).toEqual(['fmt', 'github.com/acme/svc/internal/orders', 'github.com/acme/svc/internal/store', 'github.com/gin-gonic/gin', 'net/http']);
		expect(byMod['github.com/acme/svc/internal/orders'].resolvedFile).toBe('internal/orders/handler.go');   // first non-test file of the package
		expect(byMod['github.com/acme/svc/internal/store'].resolvedFile).toBe('internal/store/store.go');
		expect(byMod['github.com/gin-gonic/gin']).toMatchObject({ resolvedFile: null, isExternal: true });
		expect(byMod['net/http']).toMatchObject({ resolvedFile: null, isExternal: false });
	});

	it('resolves Rust mod declarations and crate::/super::/self:: paths', () => {
		const files = ['Cargo.toml', 'src/lib.rs', 'src/orders.rs', 'src/orders/model.rs', 'src/payments/mod.rs', 'src/payments/stripe.rs', 'src/util.rs'];
		const root = makeRepo(Object.fromEntries(files.map(f => [f, ''])));
		const r = createModuleResolver(root, files);
		expect(r.resolve('src/lib.rs', 'orders', 'Rust').resolvedFile).toBe('src/orders.rs');
		expect(r.resolve('src/lib.rs', 'payments', 'Rust').resolvedFile).toBe('src/payments/mod.rs');
		expect(r.resolve('src/orders.rs', 'model', 'Rust').resolvedFile, '2018 layout: orders.rs + orders/model.rs').toBe('src/orders/model.rs');
		expect(r.resolve('src/payments/stripe.rs', 'crate::orders::model::Order', 'Rust').resolvedFile).toBe('src/orders/model.rs');
		expect(r.resolve('src/payments/stripe.rs', 'crate::util::retry', 'Rust').resolvedFile).toBe('src/util.rs');
		expect(r.resolve('src/payments/stripe.rs', 'crate::Config', 'Rust').resolvedFile).toBe('src/lib.rs');
		expect(r.resolve('src/payments/stripe.rs', 'super::Gateway', 'Rust').resolvedFile).toBe('src/payments/mod.rs');
		expect(r.resolve('src/orders/model.rs', 'super::Order', 'Rust').resolvedFile, 'parent module file in 2018 layout').toBe('src/orders.rs');
		expect(r.resolve('src/orders/model.rs', 'super::super::util::x', 'Rust').resolvedFile).toBe('src/util.rs');
		expect(r.resolve('src/payments/mod.rs', 'self::stripe::Client', 'Rust').resolvedFile).toBe('src/payments/stripe.rs');
		expect(r.resolve('src/lib.rs', 'std::collections::HashMap', 'Rust')).toEqual({ resolvedFile: null, isExternal: false });
		expect(r.resolve('src/lib.rs', 'serde::Deserialize', 'Rust')).toEqual({ resolvedFile: null, isExternal: true });
	});

	it('resolves C/C++ includes via local dir and include roots', () => {
		const files = ['CMakeLists.txt', 'include/acme/orders.h', 'src/orders.cpp', 'src/orders_impl.h'];
		const root = makeRepo(Object.fromEntries(files.map(f => [f, ''])));
		const r = createModuleResolver(root, files);
		expect(r.resolve('src/orders.cpp', 'orders_impl.h', 'C++').resolvedFile).toBe('src/orders_impl.h');
		expect(r.resolve('src/orders.cpp', 'acme/orders.h', 'C++').resolvedFile).toBe('include/acme/orders.h');
		expect(r.resolve('src/orders.cpp', 'vector', 'C++')).toEqual({ resolvedFile: null, isExternal: false });
	});
});

describe('RiafIndex uses the resolver for the context graph', () => {
	it('resolves tsconfig-path imports in the graph and heals dangling edges when the target file appears', async () => {
		const root = makeRepo({
			'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["src/*"]}}}',
			'package.json': '{"name":"demo"}',
			'src/main.ts': "import { svc } from '@app/service';\nimport { later } from './later';\nexport const run = () => svc() + later();\n",
			'src/service.ts': "export const svc = () => 1;\n",
		});
		const idx = await RiafIndex.open({ workspaceRoot: root, dbPath: join(root, '.riaf.sqlite') });
		await idx.reindex();
		const mainEdges = async () => Object.fromEntries((await idx.getGraph()).edges.filter(e => e.fromFile === 'src/main.ts').map(e => [e.toModule, e]));
		let byMod = await mainEdges();
		expect(byMod['@app/service']).toMatchObject({ resolvedFile: 'src/service.ts', isExternal: false });
		expect(byMod['./later']).toMatchObject({ resolvedFile: null, isExternal: false });
		expect((await idx.getImportGraph('src/service.ts')).importedBy).toEqual(['src/main.ts']);

		writeFileSync(join(root, 'src/later.ts'), 'export const later = () => 2;\n');
		await idx.indexFiles(['src/later.ts']);
		byMod = await mainEdges();
		expect(byMod['./later'].resolvedFile).toBe('src/later.ts');
		const { nodes } = await idx.getGraph();
		expect(nodes.find(n => n.filePath === 'src/later.ts')?.importedByCount).toBe(1);

		rmSync(join(root, 'src/later.ts'));
		await idx.removeFiles(['src/later.ts']);
		byMod = await mainEdges();
		expect(byMod['./later'].resolvedFile).toBeNull();
		await idx.close();
	});
});
