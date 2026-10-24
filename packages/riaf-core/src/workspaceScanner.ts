/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { readdirSync, readFileSync, statSync } from 'fs';
import { extname, join, relative } from 'path';
import { FileMetadataEntry, FrameworkEntry } from './repoIntelligenceTypes.js';

const SKIP_DIRS = new Set([
	'node_modules', '.git', 'dist', 'build', 'out', '__pycache__', '.venv', '.tox',
	'.next', '.nuxt', 'coverage', '.cache', 'vendor', 'target', '.gradle',
]);
const MAX_DEPTH = 14;
const MAX_FILES = 50_000;

export const EXT_TO_LANGUAGE: Record<string, string> = {
	'.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
	'.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
	'.py': 'Python', '.pyw': 'Python', '.pyi': 'Python',
	'.rs': 'Rust',
	'.go': 'Go',
	'.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin',
	'.cs': 'C#',
	'.cpp': 'C++', '.cc': 'C++', '.cxx': 'C++', '.hpp': 'C++', '.h': 'C/C++ Header',
	'.c': 'C',
	'.rb': 'Ruby',
	'.php': 'PHP',
	'.swift': 'Swift',
	'.scala': 'Scala',
	'.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell',
	'.sql': 'SQL',
	'.html': 'HTML', '.htm': 'HTML',
	'.css': 'CSS', '.scss': 'SCSS', '.sass': 'Sass', '.less': 'Less',
	'.vue': 'Vue',
	'.svelte': 'Svelte',
	'.dart': 'Dart',
	'.lua': 'Lua',
	'.r': 'R',
	'.ex': 'Elixir', '.exs': 'Elixir',
	'.erl': 'Erlang',
	'.hs': 'Haskell',
	'.clj': 'Clojure', '.cljs': 'Clojure',
	'.ml': 'OCaml', '.mli': 'OCaml',
	'.fs': 'F#', '.fsx': 'F#',
	'.zig': 'Zig',
	'.toml': 'TOML',
	'.yaml': 'YAML', '.yml': 'YAML',
	'.json': 'JSON',
	'.md': 'Markdown', '.mdx': 'Markdown',
	'.xml': 'XML',
	'.gradle': 'Gradle',
	'.groovy': 'Groovy',
	'.proto': 'Protobuf',
	'.tf': 'Terraform', '.hcl': 'HCL',
	'.dockerfile': 'Dockerfile',
	'.cmake': 'CMake',
	'.make': 'Makefile',
	'.pl': 'Perl', '.pm': 'Perl',
	'.vim': 'Vim script',
	'.sol': 'Solidity',
	'.jl': 'Julia',
	'.nim': 'Nim',
	'.cr': 'Crystal',
	'.pas': 'Pascal',
	'.vb': 'Visual Basic',
	'.asm': 'Assembly',
	'.wat': 'WebAssembly',
	'.graphql': 'GraphQL', '.gql': 'GraphQL',
	'.ipynb': 'Jupyter Notebook',
};

const NPM_FRAMEWORKS: Record<string, string> = {
	'react': 'React', 'react-dom': 'React', 'next': 'Next.js', 'vue': 'Vue', 'nuxt': 'Nuxt',
	'@angular/core': 'Angular', 'svelte': 'Svelte', '@sveltejs/kit': 'SvelteKit',
	'express': 'Express', 'fastify': 'Fastify', 'nestjs': 'NestJS', '@nestjs/core': 'NestJS',
	'electron': 'Electron', 'vite': 'Vite', 'webpack': 'Webpack', 'remix': 'Remix',
	'@remix-run/react': 'Remix', 'gatsby': 'Gatsby', 'astro': 'Astro',
	'tailwindcss': 'Tailwind CSS', 'prisma': 'Prisma', '@prisma/client': 'Prisma',
	'drizzle-orm': 'Drizzle', 'typeorm': 'TypeORM', 'mongoose': 'Mongoose',
	'redux': 'Redux', '@reduxjs/toolkit': 'Redux Toolkit', 'zustand': 'Zustand',
	'tanstack': 'TanStack', '@tanstack/react-query': 'TanStack Query',
	'jest': 'Jest', 'vitest': 'Vitest', 'mocha': 'Mocha', 'cypress': 'Cypress',
	'playwright': 'Playwright', '@playwright/test': 'Playwright',
};

const PYTHON_FRAMEWORKS: Record<string, string> = {
	'fastapi': 'FastAPI', 'django': 'Django', 'flask': 'Flask', 'starlette': 'Starlette',
	'streamlit': 'Streamlit', 'celery': 'Celery', 'sqlalchemy': 'SQLAlchemy',
	'pytest': 'pytest', 'pandas': 'pandas', 'numpy': 'NumPy', 'tensorflow': 'TensorFlow',
	'torch': 'PyTorch', 'scikit-learn': 'scikit-learn',
};

const RUST_CRATES: Record<string, string> = {
	'tokio': 'Tokio', 'actix-web': 'Actix Web', 'axum': 'Axum', 'rocket': 'Rocket',
	'serde': 'Serde', 'diesel': 'Diesel', 'tauri': 'Tauri',
};

const GO_MODULES: Record<string, string> = {
	'github.com/gin-gonic/gin': 'Gin', 'github.com/labstack/echo': 'Echo',
	'github.com/gorilla/mux': 'Gorilla Mux', 'google.golang.org/grpc': 'gRPC',
};

export type RawScanResult = {
	languages: string[];
	frameworks: FrameworkEntry[];
	packageManagers: string[];
	fileMeta: FileMetadataEntry[];
	totalLoc: number;
	fileCount: number;
};

export const detectLanguage = (ext: string): string | null => {
	const lower = ext.toLowerCase();
	return EXT_TO_LANGUAGE[lower] ?? null;
};

/** Language for a relative/absolute file path, by extension. */
export const detectLanguageForPath = (filePath: string): string | null => detectLanguage(extname(filePath));

/**
 * Compile simple gitignore-style globs (`**`, `*`, `?`, trailing `/`) into a matcher
 * over forward-slash relative paths. A pattern without a slash matches at any depth.
 */
export const compileExcludeGlobs = (globs: readonly string[] | undefined): ((relPath: string) => boolean) => {
	const regexes: RegExp[] = [];
	for (const raw of globs ?? []) {
		let g = raw.trim().replace(/\\/g, '/');
		if (!g || g.startsWith('#')) continue;
		const dirOnly = g.endsWith('/');
		if (dirOnly) g = g.slice(0, -1);
		if (g.startsWith('/')) g = g.slice(1);
		const anchored = g.includes('/');
		let re = '';
		for (let i = 0; i < g.length; i++) {
			const c = g[i];
			if (c === '*') {
				if (g[i + 1] === '*') {
					i++;
					if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else { re += '.*'; }
				} else {
					re += '[^/]*';
				}
			} else if (c === '?') {
				re += '[^/]';
			} else {
				re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
			}
		}
		const prefix = anchored ? '^' : '^(?:.*/)?';
		// Match the path itself or anything beneath it.
		regexes.push(new RegExp(`${prefix}${re}(?:/.*)?$`));
	}
	if (regexes.length === 0) return () => false;
	return (relPath: string) => {
		const p = relPath.replace(/\\/g, '/');
		return regexes.some(r => r.test(p));
	};
};

export type ScanOptions = {
	/** gitignore-style globs (relative to the workspace root) to leave out of the scan. */
	excludeGlobs?: readonly string[];
};

const countLines = (filePath: string): number => {
	try {
		const content = readFileSync(filePath, 'utf8');
		return content.split('\n').length;
	} catch {
		return 0;
	}
};

/** Search for a target filename in subdirectories up to the given depth. */
const findFileInSubdirs = (dir: string, targetFile: string, maxSubdepth = 3): string | null => {
	const SKIP = ['node_modules', '.git', 'target', 'build', 'dist', '.gradle'];
	let entries: string[];
	try { entries = readdirSync(dir); } catch { return null; }
	for (const entry of entries) {
		if (SKIP.includes(entry)) continue;
		const full = join(dir, entry);
		if (entry === targetFile) return full;
		if (maxSubdepth > 0) {
			try {
				if (statSync(full).isDirectory()) {
					const found = findFileInSubdirs(full, targetFile, maxSubdepth - 1);
					if (found) return found;
				}
			} catch { /* ignore */ }
		}
	}
	return null;
};

const parsePackageJson = (workspaceRoot: string): { frameworks: FrameworkEntry[]; packageManagers: string[] } => {
	const frameworks: FrameworkEntry[] = [];
	const packageManagers: string[] = [];
	// Check workspace root first; fall back to searching subdirectories up to depth 3
	const rootPkg = join(workspaceRoot, 'package.json');
	const pkgPath = exists(rootPkg) ? rootPkg : (findFileInSubdirs(workspaceRoot, 'package.json') ?? rootPkg);
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
		const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
		for (const [name, version] of Object.entries(deps)) {
			const fwName = NPM_FRAMEWORKS[name];
			if (fwName) {
				frameworks.push({ name: fwName, version: String(version), confidence: 'high' });
			}
		}
		if (pkg.packageManager) {
			const pm = String(pkg.packageManager).split('@')[0];
			packageManagers.push(pm);
		}
	} catch { /* ignore */ }

	if (packageManagers.length === 0) {
		if (exists(join(workspaceRoot, 'pnpm-lock.yaml'))) packageManagers.push('pnpm');
		else if (exists(join(workspaceRoot, 'yarn.lock'))) packageManagers.push('yarn');
		else if (exists(join(workspaceRoot, 'bun.lockb')) || exists(join(workspaceRoot, 'bun.lock'))) packageManagers.push('bun');
		else if (exists(join(workspaceRoot, 'package-lock.json'))) packageManagers.push('npm');
	}
	return { frameworks, packageManagers };
};

const exists = (p: string): boolean => {
	try { statSync(p); return true; } catch { return false; }
};

const parsePyproject = (workspaceRoot: string): FrameworkEntry[] => {
	const frameworks: FrameworkEntry[] = [];
	const paths = ['pyproject.toml', 'requirements.txt', 'setup.py'];
	for (const rel of paths) {
		const p = join(workspaceRoot, rel);
		if (!exists(p)) continue;
		try {
			const content = readFileSync(p, 'utf8').toLowerCase();
			for (const [dep, name] of Object.entries(PYTHON_FRAMEWORKS)) {
				if (content.includes(dep)) {
					frameworks.push({ name, version: null, confidence: 'medium' });
				}
			}
		} catch { /* ignore */ }
	}
	return frameworks;
};

const parseCargoToml = (workspaceRoot: string): FrameworkEntry[] => {
	const frameworks: FrameworkEntry[] = [];
	const p = join(workspaceRoot, 'Cargo.toml');
	if (!exists(p)) return frameworks;
	try {
		const content = readFileSync(p, 'utf8').toLowerCase();
		for (const [crate, name] of Object.entries(RUST_CRATES)) {
			if (content.includes(crate)) {
				frameworks.push({ name, version: null, confidence: 'medium' });
			}
		}
	} catch { /* ignore */ }
	return frameworks;
};

const parseGoMod = (workspaceRoot: string): FrameworkEntry[] => {
	const frameworks: FrameworkEntry[] = [];
	const p = join(workspaceRoot, 'go.mod');
	if (!exists(p)) return frameworks;
	try {
		const content = readFileSync(p, 'utf8');
		for (const [mod, name] of Object.entries(GO_MODULES)) {
			if (content.includes(mod)) {
				frameworks.push({ name, version: null, confidence: 'medium' });
			}
		}
	} catch { /* ignore */ }
	return frameworks;
};

const parseJavaBuild = (workspaceRoot: string): FrameworkEntry[] => {
	const frameworks: FrameworkEntry[] = [];
	const javaMarkers = [
		{ file: 'pom.xml', markers: ['spring-boot', 'springframework', 'quarkus', 'micronaut'] },
		{ file: 'build.gradle', markers: ['spring-boot', 'springframework', 'quarkus'] },
		{ file: 'build.gradle.kts', markers: ['spring-boot', 'springframework', 'quarkus'] },
	];
	const seen = new Set<string>();
	for (const { file } of javaMarkers) {
		// Check workspace root first, then scan subdirectories up to depth 3
		const rootPath = join(workspaceRoot, file);
		const foundPath = exists(rootPath) ? rootPath : findFileInSubdirs(workspaceRoot, file);
		if (!foundPath) continue;
		try {
			const content = readFileSync(foundPath, 'utf8').toLowerCase();
			if ((content.includes('spring-boot') || content.includes('springframework')) && !seen.has('Spring Boot')) {
				frameworks.push({ name: 'Spring Boot', version: null, confidence: 'high' });
				seen.add('Spring Boot');
			}
			if (content.includes('quarkus') && !seen.has('Quarkus')) {
				frameworks.push({ name: 'Quarkus', version: null, confidence: 'high' });
				seen.add('Quarkus');
			}
			if (content.includes('micronaut') && !seen.has('Micronaut')) {
				frameworks.push({ name: 'Micronaut', version: null, confidence: 'high' });
				seen.add('Micronaut');
			}
		} catch { /* ignore */ }
	}
	return frameworks;
};

const parseComposer = (workspaceRoot: string): FrameworkEntry[] => {
	const frameworks: FrameworkEntry[] = [];
	const p = join(workspaceRoot, 'composer.json');
	if (!exists(p)) return frameworks;
	try {
		const pkg = JSON.parse(readFileSync(p, 'utf8'));
		const deps = { ...pkg.require, ...pkg['require-dev'] };
		if (deps['laravel/framework']) frameworks.push({ name: 'Laravel', version: String(deps['laravel/framework']), confidence: 'high' });
		if (deps['symfony/framework-bundle']) frameworks.push({ name: 'Symfony', version: null, confidence: 'high' });
	} catch { /* ignore */ }
	return frameworks;
};

const dedupeFrameworks = (frameworks: FrameworkEntry[]): FrameworkEntry[] => {
	const seen = new Set<string>();
	return frameworks.filter(f => {
		if (seen.has(f.name)) return false;
		seen.add(f.name);
		return true;
	});
};

export const scanWorkspace = (workspaceRoot: string, options: ScanOptions = {}): RawScanResult => {
	const isExcluded = compileExcludeGlobs(options.excludeGlobs);
	const languageCounts = new Map<string, number>();
	const fileMeta: FileMetadataEntry[] = [];
	let totalLoc = 0;
	let fileCount = 0;

	type QueueItem = { absPath: string; depth: number };
	const queue: QueueItem[] = [{ absPath: workspaceRoot, depth: 0 }];

	while (queue.length > 0 && fileCount < MAX_FILES) {
		const { absPath, depth } = queue.shift()!;
		let entries: string[];
		try {
			entries = readdirSync(absPath);
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (fileCount >= MAX_FILES) break;
			const fullPath = join(absPath, entry);
			let stat;
			try { stat = statSync(fullPath); } catch { continue; }
			const relPath = relative(workspaceRoot, fullPath).replace(/\\/g, '/');
			if (isExcluded(relPath)) continue;

			if (stat.isDirectory()) {
				if (depth >= MAX_DEPTH) continue;
				if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
				queue.push({ absPath: fullPath, depth: depth + 1 });
			} else if (stat.isFile()) {
				fileCount += 1;
				const ext = extname(entry);
				const language = detectLanguage(ext);
				if (language) {
					languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
				}
				const loc = countLines(fullPath);
				totalLoc += loc;
				fileMeta.push({
					filePath: relPath,
					language,
					lastModified: stat.mtimeMs,
					sizeBytes: stat.size,
				});
			}
		}
	}

	const languages = [...languageCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([lang]) => lang);

	const allFrameworks = [
		...parsePackageJson(workspaceRoot).frameworks,
		...parsePyproject(workspaceRoot),
		...parseCargoToml(workspaceRoot),
		...parseGoMod(workspaceRoot),
		...parseJavaBuild(workspaceRoot),
		...parseComposer(workspaceRoot),
	];

	const { packageManagers } = parsePackageJson(workspaceRoot);
	if (exists(join(workspaceRoot, 'Pipfile'))) packageManagers.push('pipenv');
	if (exists(join(workspaceRoot, 'poetry.lock'))) packageManagers.push('poetry');
	if (exists(join(workspaceRoot, 'uv.lock'))) packageManagers.push('uv');
	if (exists(join(workspaceRoot, 'Cargo.toml')) && !packageManagers.includes('cargo')) packageManagers.push('cargo');
	if (exists(join(workspaceRoot, 'go.mod')) && !packageManagers.includes('go')) packageManagers.push('go');

	return {
		languages,
		frameworks: dedupeFrameworks(allFrameworks),
		packageManagers: [...new Set(packageManagers)],
		fileMeta,
		totalLoc,
		fileCount,
	};
};
