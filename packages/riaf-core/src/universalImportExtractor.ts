/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { dirname, join, relative } from 'path';

export type ImportEdge = {
	fromFile: string;
	toModule: string;
	resolvedFile: string | null;
	isExternal: boolean;
	edgeType: 'import' | 'require' | 'include' | 'use' | 'from_import';
};

export type FileNode = {
	filePath: string;
	language: string;
	nodeType: NodeType;
	layer: ArchLayer;
	isEntryPoint: boolean;
	exportCount: number;
	importCount: number;
};

export type NodeType =
	| 'entry'
	| 'router'
	| 'controller'
	| 'service'
	| 'middleware'
	| 'model'
	| 'repository'
	| 'schema'
	| 'util'
	| 'config'
	| 'test'
	| 'external'
	| 'unknown';

export type ArchLayer = 'entry' | 'api' | 'service' | 'data' | 'config' | 'external' | 'test';

const IMPORT_PATTERNS: Record<string, RegExp[]> = {
	TypeScript: [
		/(?:^|\n)\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]/gm,
		/(?:^|\n)\s*(?:const|let|var)\s+\w+\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
		/(?:^|\n)\s*export\s+.*?\s+from\s+['"]([^'"]+)['"]/gm,
		/(?:^|\n)\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
	],
	JavaScript: [
		/(?:^|\n)\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]/gm,
		/(?:^|\n)\s*(?:const|let|var)\s+\w+\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
		/(?:^|\n)\s*export\s+.*?\s+from\s+['"]([^'"]+)['"]/gm,
	],
	Python: [
		/(?:^|\n)\s*from\s+([\w.]+)\s+import/gm,
		/(?:^|\n)\s*import\s+([\w.]+)/gm,
	],
	Java: [
		/(?:^|\n)\s*import\s+([\w.]+)\s*;/gm,
	],
	Kotlin: [
		/(?:^|\n)\s*import\s+([\w.]+)/gm,
	],
	Go: [
		/import\s+"([^"]+)"/gm,
		/import\s+\w+\s+"([^"]+)"/gm,
	],
	Rust: [
		/(?:^|\n)\s*use\s+([\w:]+)/gm,
		/(?:^|\n)\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm,
	],
	'C#': [
		/(?:^|\n)\s*using\s+([\w.]+)\s*;/gm,
	],
	'C++': [
		/(?:^|\n)\s*#include\s+[<"]([^>"]+)[>"]/gm,
	],
	C: [
		/(?:^|\n)\s*#include\s+[<"]([^>"]+)[>"]/gm,
	],
	Ruby: [
		/(?:^|\n)\s*require(?:_relative)?\s+['"]([^'"]+)['"]/gm,
	],
	PHP: [
		/(?:^|\n)\s*use\s+([\w\\]+)\s*;/gm,
		/(?:^|\n)\s*require(?:_once)?\s*['"]([^'"]+)['"]/gm,
		/(?:^|\n)\s*include(?:_once)?\s*['"]([^'"]+)['"]/gm,
	],
};

const STDLIB_PREFIXES: Record<string, string[]> = {
	Python: ['os', 'sys', 'json', 'math', 're', 'datetime', 'collections', 'typing',
		'pathlib', 'logging', 'subprocess', 'threading', 'asyncio', 'abc',
		'functools', 'itertools', 'copy', 'io', 'time', 'random', 'struct',
		'hashlib', 'base64', 'urllib', 'http', 'socket', 'enum', 'dataclasses'],
	Java: ['java.', 'javax.', 'sun.', 'com.sun.'],
	'C#': ['System.', 'Microsoft.', 'Windows.'],
	Go: ['fmt', 'os', 'io', 'net', 'math', 'sort', 'sync', 'time', 'strings',
		'strconv', 'bytes', 'errors', 'context', 'log', 'path', 'runtime',
		'reflect', 'encoding', 'crypto', 'testing', 'bufio', 'unicode'],
	Rust: ['std::', 'core::', 'alloc::'],
	'C++': ['iostream', 'string', 'vector', 'map', 'set', 'algorithm', 'memory',
		'utility', 'functional', 'stdexcept', 'cassert', 'cstring', 'cstdlib',
		'cstdio', 'cmath', 'chrono', 'thread', 'mutex', 'condition_variable'],
};

function isStdlib(modulePath: string, language: string): boolean {
	const prefixes = STDLIB_PREFIXES[language] ?? [];
	return prefixes.some(p => modulePath.startsWith(p));
}

function isExternalModule(modulePath: string, language: string): boolean {
	if (language === 'TypeScript' || language === 'JavaScript') {
		return !modulePath.startsWith('.') && !modulePath.startsWith('/');
	}
	if (language === 'Python') {
		return !modulePath.startsWith('.') && !isStdlib(modulePath, language);
	}
	if (language === 'Java') {
		return !isStdlib(modulePath, language);
	}
	if (language === 'Go') {
		return modulePath.includes('.') && !isStdlib(modulePath, language);
	}
	if (language === 'Rust') {
		return modulePath.startsWith('std::') || modulePath.startsWith('core::') || modulePath.startsWith('alloc::');
	}
	if (language === 'C#' || language === 'C#') {
		return !isStdlib(modulePath, language);
	}
	if (language === 'C++' || language === 'C') {
		return !modulePath.startsWith('.') && !modulePath.startsWith('/');
	}
	if (language === 'Ruby' || language === 'PHP') {
		return !modulePath.startsWith('.') && !modulePath.startsWith('/');
	}
	return false;
}

function resolveRelativePath(fromFile: string, modulePath: string, language: string): string | null {
	if (language === 'TypeScript' || language === 'JavaScript') {
		if (!modulePath.startsWith('.')) {
			return null;
		}
		const base = join(dirname(fromFile), modulePath);
		for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']) {
			if (base.endsWith(ext)) {
				return base.replace(/\\/g, '/');
			}
		}
		for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']) {
			return `${base}${ext}`.replace(/\\/g, '/');
		}
	}
	if (language === 'Python') {
		if (!modulePath.startsWith('.')) {
			return null;
		}
		const dots = modulePath.match(/^\.+/)?.[0].length ?? 0;
		const modPart = modulePath.slice(dots).replace(/\./g, '/');
		let base = dirname(fromFile);
		for (let i = 1; i < dots; i++) {
			base = dirname(base);
		}
		return join(base, modPart + '.py').replace(/\\/g, '/');
	}
	if (language === 'Ruby' || language === 'PHP') {
		if (!modulePath.startsWith('.')) {
			return null;
		}
		return join(dirname(fromFile), modulePath).replace(/\\/g, '/');
	}
	if (language === 'Rust') {
		if (/^[\w]+$/.test(modulePath)) {
			return join(dirname(fromFile), `${modulePath}.rs`).replace(/\\/g, '/');
		}
	}
	return null;
}

export function extractImports(
	filePath: string,
	content: string,
	language: string,
	workspaceRoot: string,
): ImportEdge[] {
	const relPath = relative(workspaceRoot, filePath).replace(/\\/g, '/');
	const patterns = IMPORT_PATTERNS[language] ?? [];
	const edges: ImportEdge[] = [];
	const seen = new Set<string>();

	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(content)) !== null) {
			const raw = match[1]?.trim();
			if (!raw || raw.length < 2) {
				continue;
			}
			const key = `${pattern.source}:${raw}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);

			const external = isExternalModule(raw, language);
			const resolvedFile = external ? null : resolveRelativePath(relPath, raw, language);

			edges.push({
				fromFile: relPath,
				toModule: raw,
				resolvedFile,
				isExternal: external,
				edgeType: pattern.source.includes('require') ? 'require'
					: pattern.source.includes('include') ? 'include'
						: pattern.source.includes('from') && language === 'Python' ? 'from_import'
							: pattern.source.includes('use') ? 'use'
								: 'import',
			});
		}
	}

	return edges;
}
