/**
 * Compiler-like module resolution against the *actual* set of workspace files.
 *
 * The regex import extractor only knows the import string; this resolver turns it into a real
 * file the way the language's toolchain would — tsconfig `paths`/`baseUrl`, `index.*` files,
 * `.js`→`.ts` ESM rewrites, workspace packages (monorepos), Python packages and source roots,
 * Java/Kotlin package directories, Go module paths from `go.mod`, Rust `mod`/`crate::` trees,
 * C/C++ include dirs. Anything it cannot place inside the workspace is external.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, posix, relative } from 'path';

export type Resolution = { resolvedFile: string | null; isExternal: boolean };

export interface ModuleResolver {
	resolve(fromFile: string, modulePath: string, language: string): Resolution;
	/** Keep the file universe in sync with the index (watcher events). */
	addFile(relPath: string): void;
	removeFile(relPath: string): void;
	hasFile(relPath: string): boolean;
	/** Reload project configuration (tsconfig / package.json / go.mod changed). */
	reloadConfig(): void;
}

type TsPathsConfig = { dir: string; baseUrl: string | null; paths: { pattern: string; targets: string[] }[] };
type WorkspacePackage = { name: string; dir: string; entry: string | null };

const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '.json', '.vue', '.svelte'];
const JS_INDEX = TS_EXTS.map(e => `index${e}`);
const GO_STDLIB_FIRST = new Set(['fmt', 'os', 'io', 'net', 'math', 'sort', 'sync', 'time', 'strings', 'strconv', 'bytes', 'errors', 'context', 'log', 'path', 'runtime', 'reflect', 'encoding', 'crypto', 'testing', 'bufio', 'unicode', 'regexp', 'flag', 'hash', 'html', 'image', 'index', 'mime', 'plugin', 'text', 'embed', 'archive', 'compress', 'container', 'database', 'debug', 'expvar', 'go', 'iter', 'maps', 'slices', 'cmp', 'unsafe', 'syscall', 'internal']);
const PY_STDLIB = new Set(['os', 'sys', 'json', 'math', 're', 'datetime', 'collections', 'typing', 'pathlib', 'logging', 'subprocess', 'threading', 'asyncio', 'abc', 'functools', 'itertools', 'copy', 'io', 'time', 'random', 'struct', 'hashlib', 'base64', 'urllib', 'http', 'socket', 'enum', 'dataclasses', 'unittest', 'argparse', 'csv', 'decimal', 'fractions', 'glob', 'shutil', 'tempfile', 'traceback', 'types', 'uuid', 'warnings', 'weakref', 'contextlib', 'inspect', 'operator', 'string', 'textwrap', 'pickle', 'queue', 'select', 'signal', 'statistics', 'xml', 'zipfile', 'zlib', 'email', 'html', 'importlib', 'pprint', 'secrets', 'ssl', 'sqlite3', 'concurrent', 'multiprocessing', 'platform', 'getpass', 'configparser', 'heapq', 'bisect', 'array', 'numbers', 'cmath', 'locale', 'gettext', 'codecs', 'unicodedata', 'binascii', 'calendar', 'difflib', 'filecmp', 'fnmatch', 'linecache', 'shlex', 'site', 'sysconfig', 'venv', 'wsgiref', 'zoneinfo', 'graphlib', 'tomllib', '__future__', 'builtins']);
const JAVA_STDLIB = ['java.', 'javax.', 'jakarta.', 'sun.', 'com.sun.', 'jdk.', 'kotlin.', 'kotlinx.', 'android.', 'androidx.'];

const stripJsonComments = (text: string): string =>
	text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\"'])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1');

const readJson = (abs: string): any | null => {
	try { return JSON.parse(stripJsonComments(readFileSync(abs, 'utf8'))); } catch { return null; }
};

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
const joinRel = (...parts: string[]): string => norm(posix.normalize(posix.join(...parts.map(p => p.replace(/\\/g, '/')))));

export function createModuleResolver(workspaceRoot: string, files: Iterable<string>): ModuleResolver {
	const fileSet = new Set<string>();
	/** path suffix index for Java/Kotlin: "com/example/Foo.java" → full relative path(s) */
	const bySuffix = new Map<string, string[]>();
	const dirs = new Set<string>();

	const indexFile = (rel: string) => {
		const p = norm(rel);
		if (!p || fileSet.has(p)) return;
		fileSet.add(p);
		let d = posix.dirname(p);
		while (d && d !== '.' && !dirs.has(d)) { dirs.add(d); d = posix.dirname(d); }
		if (/\.(java|kt|kts|scala)$/.test(p)) {
			const parts = p.split('/');
			// register every suffix of ≥2 segments so src/main/java/com/x/Foo.java is found by com/x/Foo.java
			for (let i = 0; i < parts.length - 1; i++) {
				const key = parts.slice(i).join('/');
				(bySuffix.get(key) ?? bySuffix.set(key, []).get(key)!).push(p);
			}
		}
	};
	for (const f of files) indexFile(f);

	const has = (p: string) => fileSet.has(p);
	const hasDir = (p: string) => dirs.has(p);

	// ── project configuration ────────────────────────────────────────────────

	let tsConfigs: TsPathsConfig[] = [];
	let packages: WorkspacePackage[] = [];
	let goModule: { path: string; dir: string }[] = [];
	let pySourceRoots: string[] = [];
	let rustCrateRoots: string[] = [];        // dirs holding src/lib.rs or src/main.rs
	let cIncludeDirs: string[] = [];

	const loadTsConfig = (relPath: string, depth = 0): TsPathsConfig | null => {
		const json = readJson(join(workspaceRoot, relPath));
		if (!json) return null;
		const dir = posix.dirname(relPath) === '.' ? '' : posix.dirname(relPath);
		let base: TsPathsConfig | null = null;
		if (typeof json.extends === 'string' && depth < 3 && (json.extends.startsWith('.') || json.extends.startsWith('/'))) {
			const parentRel = joinRel(dir, json.extends.endsWith('.json') ? json.extends : `${json.extends}.json`);
			if (has(parentRel)) base = loadTsConfig(parentRel, depth + 1);
		}
		const co = json.compilerOptions ?? {};
		const baseUrl = typeof co.baseUrl === 'string' ? joinRel(dir, co.baseUrl) : base?.baseUrl ?? null;
		const paths: TsPathsConfig['paths'] = [];
		if (co.paths && typeof co.paths === 'object') {
			const pathsBase = baseUrl ?? dir;
			for (const [pattern, targets] of Object.entries(co.paths as Record<string, string[]>)) {
				if (Array.isArray(targets)) paths.push({ pattern, targets: targets.map(t => joinRel(pathsBase, t)) });
			}
		}
		return { dir, baseUrl, paths: paths.length ? paths : base?.paths ?? [] };
	};

	const reloadConfig = () => {
		tsConfigs = [];
		packages = [];
		goModule = [];
		pySourceRoots = [''];
		rustCrateRoots = [];
		cIncludeDirs = ['', 'include', 'src'];
		for (const f of fileSet) {
			const base = posix.basename(f);
			const dir = posix.dirname(f) === '.' ? '' : posix.dirname(f);
			if (base === 'tsconfig.json' || base === 'jsconfig.json') {
				const cfg = loadTsConfig(f);
				if (cfg && (cfg.baseUrl || cfg.paths.length)) tsConfigs.push(cfg);
			} else if (base === 'package.json') {
				const json = readJson(join(workspaceRoot, f));
				if (json && typeof json.name === 'string') {
					const entry = [json.types, json.typings, json.module, json.main].find((e: unknown) => typeof e === 'string') as string | undefined;
					packages.push({ name: json.name, dir, entry: entry ? joinRel(dir, entry) : null });
				}
			} else if (base === 'go.mod') {
				try {
					const m = /^module\s+(\S+)/m.exec(readFileSync(join(workspaceRoot, f), 'utf8'));
					if (m) goModule.push({ path: m[1], dir });
				} catch { /* ignore */ }
			} else if (base === 'pyproject.toml' || base === 'setup.py' || base === 'setup.cfg') {
				pySourceRoots.push(dir, joinRel(dir, 'src'));
			} else if (base === 'Cargo.toml') {
				rustCrateRoots.push(dir);
			} else if (base === 'CMakeLists.txt' || base === 'Makefile') {
				cIncludeDirs.push(dir, joinRel(dir, 'include'), joinRel(dir, 'src'));
			}
		}
		// deepest tsconfig first so nested projects win
		tsConfigs.sort((a, b) => b.dir.length - a.dir.length);
		packages.sort((a, b) => b.dir.length - a.dir.length);
		goModule.sort((a, b) => b.dir.length - a.dir.length);
		pySourceRoots = [...new Set(pySourceRoots)];
		cIncludeDirs = [...new Set(cIncludeDirs)];
	};
	reloadConfig();

	// ── per-language resolution ──────────────────────────────────────────────

	/** Try `base` as a file with the known extensions, then as a directory with index files. */
	const resolveJsPath = (base: string): string | null => {
		const b = norm(base);
		if (has(b) && !hasDir(b)) return b;
		// ESM-style `./foo.js` written against TS sources
		const jsToTs = b.replace(/\.(m|c)?js$/, (_m, c) => `.${c ?? ''}ts`);
		if (jsToTs !== b && has(jsToTs)) return jsToTs;
		if (/\.jsx$/.test(b) && has(b.replace(/\.jsx$/, '.tsx'))) return b.replace(/\.jsx$/, '.tsx');
		for (const ext of TS_EXTS) if (has(b + ext)) return b + ext;
		if (hasDir(b)) {
			for (const idx of JS_INDEX) if (has(joinRel(b, idx))) return joinRel(b, idx);
			const pkg = joinRel(b, 'package.json');
			if (has(pkg)) {
				const json = readJson(join(workspaceRoot, pkg));
				const entry = [json?.types, json?.module, json?.main].find((e: unknown) => typeof e === 'string') as string | undefined;
				if (entry) { const r = resolveJsPath(joinRel(b, entry)); if (r) return r; }
			}
		}
		return null;
	};

	const matchTsPath = (pattern: string, mod: string): string | null => {
		const star = pattern.indexOf('*');
		if (star < 0) return pattern === mod ? '' : null;
		const prefix = pattern.slice(0, star), suffix = pattern.slice(star + 1);
		if (mod.startsWith(prefix) && mod.endsWith(suffix) && mod.length >= prefix.length + suffix.length) return mod.slice(prefix.length, mod.length - suffix.length);
		return null;
	};

	const resolveTs = (fromFile: string, mod: string): Resolution => {
		const cleaned = mod.replace(/\?.*$/, '').replace(/^node:/, 'node:');
		if (cleaned.startsWith('node:')) return { resolvedFile: null, isExternal: true };
		if (cleaned.startsWith('.') || cleaned.startsWith('/')) {
			const base = cleaned.startsWith('/') ? cleaned.slice(1) : joinRel(posix.dirname(fromFile), cleaned);
			const r = resolveJsPath(base);
			// keep the old best-effort guess for a relative import whose target is missing (dangling edge, still internal)
			return { resolvedFile: r ?? (has(base) ? base : null), isExternal: false };
		}
		// tsconfig paths / baseUrl — nearest config above the importing file wins
		for (const cfg of tsConfigs) {
			if (cfg.dir && !fromFile.startsWith(`${cfg.dir}/`)) continue;
			for (const p of cfg.paths) {
				const captured = matchTsPath(p.pattern, cleaned);
				if (captured === null) continue;
				for (const t of p.targets) {
					const r = resolveJsPath(t.replace('*', captured));
					if (r) return { resolvedFile: r, isExternal: false };
				}
			}
			if (cfg.baseUrl !== null) {
				const r = resolveJsPath(joinRel(cfg.baseUrl, cleaned));
				if (r) return { resolvedFile: r, isExternal: false };
			}
		}
		// workspace packages (monorepo): `@org/pkg` or `@org/pkg/sub/path`
		for (const pkg of packages) {
			if (cleaned === pkg.name) {
				const r = (pkg.entry && resolveJsPath(pkg.entry)) ?? resolveJsPath(joinRel(pkg.dir, 'src')) ?? resolveJsPath(pkg.dir);
				return { resolvedFile: r, isExternal: false };
			}
			if (cleaned.startsWith(`${pkg.name}/`)) {
				const sub = cleaned.slice(pkg.name.length + 1);
				const r = resolveJsPath(joinRel(pkg.dir, sub)) ?? resolveJsPath(joinRel(pkg.dir, 'src', sub));
				return { resolvedFile: r, isExternal: false };
			}
		}
		return { resolvedFile: null, isExternal: true };
	};

	const resolvePyModule = (modPath: string, roots: string[]): string | null => {
		const rel = modPath.replace(/\./g, '/');
		for (const root of roots) {
			const base = joinRel(root, rel);
			if (has(`${base}.py`)) return `${base}.py`;
			if (has(joinRel(base, '__init__.py'))) return joinRel(base, '__init__.py');
			if (has(`${base}.pyi`)) return `${base}.pyi`;
		}
		return null;
	};

	const resolvePython = (fromFile: string, mod: string): Resolution => {
		if (mod.startsWith('.')) {
			const dots = mod.match(/^\.+/)![0].length;
			let base = posix.dirname(fromFile);
			for (let i = 1; i < dots; i++) base = posix.dirname(base);
			if (base === '.') base = '';
			const rest = mod.slice(dots);
			const r = rest ? resolvePyModule(rest, [base]) : (has(joinRel(base, '__init__.py')) ? joinRel(base, '__init__.py') : null);
			return { resolvedFile: r, isExternal: false };
		}
		const top = mod.split('.')[0];
		// the importing file's own package tree first, then declared source roots
		const roots = [...pySourceRoots];
		let d = posix.dirname(fromFile);
		while (d && d !== '.') { roots.push(d); d = posix.dirname(d); }
		const r = resolvePyModule(mod, roots);
		if (r) return { resolvedFile: r, isExternal: false };
		// `from a.b import c` where c is a symbol, not a module
		const parent = mod.includes('.') ? resolvePyModule(mod.slice(0, mod.lastIndexOf('.')), roots) : null;
		if (parent) return { resolvedFile: parent, isExternal: false };
		return { resolvedFile: null, isExternal: !PY_STDLIB.has(top) };
	};

	const resolveJvm = (mod: string, ext: string[]): Resolution => {
		if (JAVA_STDLIB.some(p => mod.startsWith(p))) return { resolvedFile: null, isExternal: false };
		const clean = mod.replace(/^static\s+/, '');
		const parts = clean.split('.');
		// try the full path, then drop trailing segments (static member / nested class / wildcard)
		for (let n = parts.length; n >= 2; n--) {
			const seg = parts.slice(0, n);
			if (seg[seg.length - 1] === '*') continue;
			for (const e of ext) {
				const hits = bySuffix.get(`${seg.join('/')}${e}`);
				if (hits?.length) return { resolvedFile: hits[0], isExternal: false };
			}
		}
		// a wildcard / unresolved package that exists as a directory in the repo is internal
		const pkgDir = parts.filter(p => p !== '*').join('/');
		const internalDir = [...dirs].some(d => d.endsWith(`/${pkgDir}`) || d === pkgDir);
		return { resolvedFile: null, isExternal: !internalDir };
	};

	const resolveGo = (fromFile: string, mod: string): Resolution => {
		const first = mod.split('/')[0];
		for (const m of goModule) {
			if (m.dir && !fromFile.startsWith(`${m.dir}/`) && m.dir !== '') continue;
			if (mod === m.path || mod.startsWith(`${m.path}/`)) {
				const sub = mod === m.path ? '' : mod.slice(m.path.length + 1);
				const dir = joinRel(m.dir, sub);
				const file = goPackageFile(dir);
				return { resolvedFile: file, isExternal: false };
			}
		}
		if (!first.includes('.') || GO_STDLIB_FIRST.has(first)) return { resolvedFile: null, isExternal: false }; // stdlib
		return { resolvedFile: null, isExternal: true };
	};
	const goPackageFile = (dir: string): string | null => {
		const candidates = [...fileSet].filter(f => posix.dirname(f) === (dir || '.') && f.endsWith('.go') && !f.endsWith('_test.go')).sort();
		return candidates[0] ?? null;
	};

	const resolveRust = (fromFile: string, mod: string): Resolution => {
		const fromDir = posix.dirname(fromFile) === '.' ? '' : posix.dirname(fromFile);
		const fileStem = posix.basename(fromFile, '.rs');
		// `mod foo;` → foo.rs | foo/mod.rs | <stem>/foo.rs (2018 edition layout)
		if (/^\w+$/.test(mod)) {
			for (const c of [joinRel(fromDir, `${mod}.rs`), joinRel(fromDir, mod, 'mod.rs'), joinRel(fromDir, fileStem, `${mod}.rs`)]) if (has(c)) return { resolvedFile: c, isExternal: false };
			return { resolvedFile: null, isExternal: false };
		}
		const segs = mod.split('::').filter(Boolean);
		const head = segs[0];
		if (head === 'std' || head === 'core' || head === 'alloc') return { resolvedFile: null, isExternal: false };
		let baseDir: string | null = null;
		let rest = segs.slice(1);
		// directory that holds the *children* of the current module
		const ownModDir = fileStem === 'mod' || fileStem === 'lib' || fileStem === 'main' ? fromDir : joinRel(fromDir, fileStem);
		const up = (d: string) => (posix.dirname(d) === '.' ? '' : posix.dirname(d));
		if (head === 'crate') {
			const crate = rustCrateRoots.find(r => !r || fromFile.startsWith(`${r}/`)) ?? '';
			baseDir = joinRel(crate, 'src');
		} else if (head === 'self') { baseDir = ownModDir; }
		else if (head === 'super') {
			baseDir = ownModDir;
			let i = 0;
			while (segs[i] === 'super') { baseDir = up(baseDir); i++; }
			rest = segs.slice(i);
		} else {
			// a sibling module declared in this crate (`use orders::Order` without `crate::`)
			const sib = [joinRel(fromDir, `${head}.rs`), joinRel(fromDir, head, 'mod.rs')].find(has);
			if (sib) return { resolvedFile: sib, isExternal: false };
			return { resolvedFile: null, isExternal: true };
		}
		// walk down the path as far as files exist: a::b::C → a/b.rs | a/b/mod.rs | a.rs
		for (let n = rest.length; n >= 1; n--) {
			const p = joinRel(baseDir, ...rest.slice(0, n));
			if (has(`${p}.rs`)) return { resolvedFile: `${p}.rs`, isExternal: false };
			if (has(joinRel(p, 'mod.rs'))) return { resolvedFile: joinRel(p, 'mod.rs'), isExternal: false };
		}
		// the path names a symbol in the module itself: its file is mod.rs | <dir>.rs | the crate root
		const rootFile = [joinRel(baseDir, 'mod.rs'), `${baseDir}.rs`, joinRel(baseDir, 'lib.rs'), joinRel(baseDir, 'main.rs')].find(has);
		return { resolvedFile: rootFile ?? null, isExternal: false };
	};

	const resolveC = (fromFile: string, mod: string, quoted: boolean): Resolution => {
		const fromDir = posix.dirname(fromFile) === '.' ? '' : posix.dirname(fromFile);
		const local = joinRel(fromDir, mod);
		if (has(local)) return { resolvedFile: local, isExternal: false };
		for (const inc of cIncludeDirs) { const c = joinRel(inc, mod); if (has(c)) return { resolvedFile: c, isExternal: false }; }
		// header next to a source with the same stem
		return { resolvedFile: null, isExternal: !quoted };
	};

	const resolveRubyPhp = (fromFile: string, mod: string, language: string): Resolution => {
		const fromDir = posix.dirname(fromFile) === '.' ? '' : posix.dirname(fromFile);
		const exts = language === 'Ruby' ? ['', '.rb'] : ['', '.php'];
		const bases = mod.startsWith('.') || mod.startsWith('/') ? [joinRel(fromDir, mod)] : [joinRel(fromDir, mod), mod, joinRel('lib', mod), joinRel('app', mod), joinRel('src', mod)];
		for (const b of bases) for (const e of exts) if (has(b + e)) return { resolvedFile: b + e, isExternal: false };
		if (language === 'PHP' && mod.includes('\\')) {
			// PSR-4-ish: App\Service\Foo → **/Service/Foo.php
			const tail = mod.split('\\').slice(1).join('/');
			const hit = tail && [...fileSet].find(f => f.endsWith(`/${tail}.php`) || f === `${tail}.php`);
			return { resolvedFile: hit || null, isExternal: !hit };
		}
		return { resolvedFile: null, isExternal: !mod.startsWith('.') };
	};

	const resolve = (fromFile: string, modulePath: string, language: string): Resolution => {
		const from = norm(fromFile);
		const mod = modulePath.trim();
		switch (language) {
			case 'TypeScript': case 'JavaScript': return resolveTs(from, mod);
			case 'Python': return resolvePython(from, mod);
			case 'Java': return resolveJvm(mod, ['.java', '.kt']);
			case 'Kotlin': case 'Scala': return resolveJvm(mod, ['.kt', '.java', '.scala']);
			case 'Go': return resolveGo(from, mod);
			case 'Rust': return resolveRust(from, mod);
			case 'C': case 'C++': return resolveC(from, mod, !mod.startsWith('<'));
			case 'Ruby': case 'PHP': return resolveRubyPhp(from, mod, language);
			case 'C#': return { resolvedFile: null, isExternal: /^(System|Microsoft|Windows)\./.test(mod) ? false : !isCSharpNamespaceInRepo(mod) };
			default: return { resolvedFile: null, isExternal: !mod.startsWith('.') };
		}
	};
	const isCSharpNamespaceInRepo = (ns: string): boolean => {
		const tail = ns.split('.').slice(-1)[0];
		return [...dirs].some(d => d.endsWith(`/${tail}`) || d === tail);
	};

	return {
		resolve,
		addFile: rel => { indexFile(rel); if (/(^|\/)(tsconfig|jsconfig|package)\.json$|(^|\/)(go\.mod|Cargo\.toml|pyproject\.toml)$/.test(norm(rel))) reloadConfig(); },
		removeFile: rel => {
			const p = norm(rel);
			if (!fileSet.delete(p)) return;
			for (const [k, v] of bySuffix) { const i = v.indexOf(p); if (i >= 0) { v.splice(i, 1); if (!v.length) bySuffix.delete(k); } }
		},
		hasFile: rel => has(norm(rel)),
		reloadConfig,
	};
}

/** Build a resolver by walking the disk (for callers that have no scan result handy). */
export function createModuleResolverFromDisk(workspaceRoot: string, isExcluded: (rel: string) => boolean = () => false): ModuleResolver {
	const files: string[] = [];
	const stack = [workspaceRoot];
	while (stack.length) {
		const dir = stack.pop()!;
		let entries: string[];
		try { entries = readdirSync(dir); } catch { continue; }
		for (const e of entries) {
			const abs = join(dir, e);
			const rel = relative(workspaceRoot, abs).replace(/\\/g, '/');
			if (isExcluded(rel) || e === 'node_modules' || e === '.git') continue;
			try {
				const st = statSync(abs);
				if (st.isDirectory()) stack.push(abs); else if (st.isFile()) files.push(rel);
			} catch { /* ignore */ }
		}
	}
	return createModuleResolver(workspaceRoot, files);
}