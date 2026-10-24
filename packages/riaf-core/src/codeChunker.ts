/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CodeChunk, CodeChunkType, ExtractedSymbol, FileMetadataEntry } from './repoIntelligenceTypes.js';
import { AstDefinition, flattenOutline, isImportOnlyBlock, parseOutline, TREE_SITTER_LANGUAGES } from './treeSitterChunker.js';

const MAX_FILE_CHARS = 300_000;
const MAX_CHUNK_LINES = 80;
const MIN_NON_EMPTY_LINES = 3;
const FALLBACK_FILE_LINES = 120;

const SKIP_LANGUAGES = new Set([
	'JSON', 'TOML', 'HTML', 'CSS', 'SCSS', 'Sass', 'Less',
	// SQL, YAML, and Markdown are indexed with their own boundary patterns below
]);

export { SKIP_LANGUAGES };

type SymbolPattern = {
	nameRegex: RegExp;
	kind: ExtractedSymbol['kind'];
	exportRegex: RegExp;
};

const SYMBOL_PATTERNS: Record<string, SymbolPattern[]> = {
	TypeScript: [
		{ nameRegex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m, kind: 'function', exportRegex: /^export\s/ },
		{ nameRegex: /^(?:export\s+)?class\s+(\w+)/m, kind: 'class', exportRegex: /^export\s/ },
		{ nameRegex: /^(?:export\s+)?interface\s+(\w+)/m, kind: 'interface', exportRegex: /^export\s/ },
		{ nameRegex: /^(?:export\s+)?type\s+(\w+)\s*=/m, kind: 'type', exportRegex: /^export\s/ },
		{ nameRegex: /^(?:export\s+)?enum\s+(\w+)/m, kind: 'enum', exportRegex: /^export\s/ },
		{ nameRegex: /^export\s+const\s+(\w+)/m, kind: 'const', exportRegex: /^export\s/ },
	],
	JavaScript: [
		{ nameRegex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m, kind: 'function', exportRegex: /^export\s/ },
		{ nameRegex: /^(?:export\s+)?class\s+(\w+)/m, kind: 'class', exportRegex: /^export\s/ },
		{ nameRegex: /^export\s+const\s+(\w+)/m, kind: 'const', exportRegex: /^export\s/ },
	],
	Python: [
		{ nameRegex: /^def\s+(\w+)/m, kind: 'function', exportRegex: /^(?!_)/ },
		{ nameRegex: /^class\s+(\w+)/m, kind: 'class', exportRegex: /^(?!_)/ },
	],
	Go: [
		{ nameRegex: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/m, kind: 'function', exportRegex: /^func\s+[A-Z]/ },
		{ nameRegex: /^type\s+(\w+)\s+struct/m, kind: 'class', exportRegex: /^type\s+[A-Z]/ },
		{ nameRegex: /^type\s+(\w+)\s+interface/m, kind: 'interface', exportRegex: /^type\s+[A-Z]/ },
	],
	Rust: [
		{ nameRegex: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/m, kind: 'function', exportRegex: /^pub\s/ },
		{ nameRegex: /^(?:pub\s+)?struct\s+(\w+)/m, kind: 'class', exportRegex: /^pub\s/ },
		{ nameRegex: /^(?:pub\s+)?trait\s+(\w+)/m, kind: 'interface', exportRegex: /^pub\s/ },
	],
	Java: [
		{ nameRegex: /^(?:public\s+)?(?:static\s+)?\w+\s+(\w+)\s*\(/m, kind: 'function', exportRegex: /^public\s/ },
		{ nameRegex: /^(?:public\s+)?(?:abstract\s+)?class\s+(\w+)/m, kind: 'class', exportRegex: /^public\s/ },
		{ nameRegex: /^(?:public\s+)?interface\s+(\w+)/m, kind: 'interface', exportRegex: /^public\s/ },
		{ nameRegex: /^(?:public\s+)?enum\s+(\w+)/m, kind: 'enum', exportRegex: /^public\s/ },
	],
};

export const supportsSymbolExtraction = (language: string | null | undefined): boolean => {
	return !!language && !SKIP_LANGUAGES.has(language) && (!!SYMBOL_PATTERNS[language] || TREE_SITTER_LANGUAGES.includes(language));
};

type BoundaryPattern = { regex: RegExp; chunkType: CodeChunkType };

const LANGUAGE_BOUNDARIES: Record<string, BoundaryPattern[]> = {
	TypeScript: [
		{ regex: /^(?:export\s+)?(?:async\s+)?function\s+\w/m, chunkType: 'function' },
		{ regex: /^(?:export\s+)?class\s+\w/m, chunkType: 'class' },
		{ regex: /^(?:export\s+)?interface\s+\w/m, chunkType: 'block' },
		{ regex: /^(?:export\s+)?type\s+\w/m, chunkType: 'block' },
		{ regex: /^export\s+default\s+/m, chunkType: 'block' },
	],
	JavaScript: [
		{ regex: /^(?:export\s+)?(?:async\s+)?function\s+\w/m, chunkType: 'function' },
		{ regex: /^(?:export\s+)?class\s+\w/m, chunkType: 'class' },
		{ regex: /^export\s+default\s+/m, chunkType: 'block' },
	],
	Python: [
		{ regex: /^def\s+\w/m, chunkType: 'function' },
		{ regex: /^class\s+\w/m, chunkType: 'class' },
	],
	Go: [
		{ regex: /^func\s+/m, chunkType: 'function' },
	],
	Rust: [
		{ regex: /^(?:pub\s+)?fn\s+\w/m, chunkType: 'function' },
		{ regex: /^(?:pub\s+)?impl\b/m, chunkType: 'class' },
		{ regex: /^(?:pub\s+)?struct\s+\w/m, chunkType: 'class' },
	],
	Java: [
		{ regex: /^(?:public\s+)?(?:abstract\s+)?class\s+\w/m, chunkType: 'class' },
		{ regex: /^(?:public\s+)?interface\s+\w/m, chunkType: 'block' },
		{ regex: /^\s+(?:public|private|protected)\s+\w+\s+\w+\s*\(/m, chunkType: 'function' },
	],
	'C#': [
		{ regex: /^(?:public|private|protected|internal)?\s*(?:static\s+)?(?:\w+\s+)+?\w+\s*\([^)]*\)\s*\{/m, chunkType: 'function' },
		{ regex: /^(?:public|private|protected|internal)?\s*class\s+\w/m, chunkType: 'class' },
	],
	SQL: [
		{ regex: /^CREATE\s+TABLE\s+/im, chunkType: 'class' },
		{ regex: /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+/im, chunkType: 'function' },
		{ regex: /^ALTER\s+TABLE\s+/im, chunkType: 'block' },
		{ regex: /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+/im, chunkType: 'block' },
		{ regex: /^INSERT\s+INTO\s+/im, chunkType: 'block' },
	],
	YAML: [
		// Top-level keys (no leading whitespace) as chunk boundaries
		{ regex: /^\w[\w-]*\s*:/m, chunkType: 'block' },
	],
	Markdown: [
		// H1 and H2 headings as chunk boundaries
		{ regex: /^#{1,2}\s+\S/m, chunkType: 'block' },
	],
};

const countNonEmptyLines = (text: string): number => {
	return text.split('\n').filter(line => line.trim().length > 0).length;
};

const makeChunkId = (workspaceHash: string, filePath: string, startLine: number): string => {
	return createHash('sha256').update(`${workspaceHash}:${filePath}:${startLine}`).digest('hex').slice(0, 32);
};

const findBoundaryLines = (content: string, patterns: BoundaryPattern[]): { line: number; chunkType: CodeChunkType }[] => {
	const lines = content.split('\n');
	const boundaries: { line: number; chunkType: CodeChunkType }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		for (const pattern of patterns) {
			if (pattern.regex.test(line)) {
				boundaries.push({ line: i + 1, chunkType: pattern.chunkType });
				break;
			}
		}
	}
	return boundaries;
};

const splitAtBlankLines = (lines: string[], startIdx: number, endIdx: number, maxLines: number): { start: number; end: number }[] => {
	const spans: { start: number; end: number }[] = [];
	let spanStart = startIdx;
	while (spanStart <= endIdx) {
		let spanEnd = Math.min(spanStart + maxLines - 1, endIdx);
		if (spanEnd < endIdx) {
			for (let i = spanEnd; i > spanStart + MIN_NON_EMPTY_LINES; i--) {
				if (lines[i - 1].trim() === '') {
					spanEnd = i - 1;
					break;
				}
			}
		}
		spans.push({ start: spanStart, end: spanEnd });
		spanStart = spanEnd + 1;
	}
	return spans;
};

type Span = { start: number; end: number; chunkType: CodeChunkType };

/**
 * Turn an AST outline into chunk spans: every top-level definition is a chunk; the code between
 * definitions (imports, module-level statements) becomes `block` chunks; definitions longer than
 * MAX_CHUNK_LINES are split at their members (methods) and, failing that, at blank lines.
 */
const spansFromOutline = (defs: AstDefinition[], lines: string[]): Span[] => {
	const spans: Span[] = [];
	const total = lines.length;
	const pushGap = (start: number, end: number) => { if (end >= start) spans.push({ start, end, chunkType: 'block' }); };
	const pushDef = (def: AstDefinition) => {
		const len = def.endLine - def.startLine + 1;
		if (len <= MAX_CHUNK_LINES) { spans.push({ start: def.startLine, end: def.endLine, chunkType: def.chunkType }); return; }
		const members = def.children.filter(c => c.startLine > def.startLine && c.endLine <= def.endLine).sort((a, b) => a.startLine - b.startLine);
		if (members.length === 0) {
			for (const sub of splitAtBlankLines(lines, def.startLine - 1, def.endLine - 1, MAX_CHUNK_LINES)) {
				spans.push({ start: sub.start + 1, end: sub.end + 1, chunkType: def.chunkType });
			}
			return;
		}
		// header (signature + fields) keeps the parent's chunk type so "class" chunks still exist;
		// a header too short to stand alone is merged into the first member so the class name is never lost
		let cursor = def.startLine;
		let pendingHeader: Span | null = null;
		for (const m of members) {
			if (m.startLine > cursor) {
				const header: Span = { start: cursor, end: m.startLine - 1, chunkType: cursor === def.startLine ? def.chunkType : 'block' };
				const nonEmpty = lines.slice(header.start - 1, header.end).filter(l => l.trim()).length;
				if (cursor === def.startLine && nonEmpty < MIN_NON_EMPTY_LINES) pendingHeader = header;
				else spans.push(header);
			}
			const before = spans.length;
			pushDef(m);
			if (pendingHeader && spans.length > before) {
				spans[before] = { start: pendingHeader.start, end: spans[before].end, chunkType: pendingHeader.chunkType };
				pendingHeader = null;
			}
			cursor = m.endLine + 1;
		}
		if (cursor <= def.endLine) spans.push({ start: pendingHeader?.start ?? cursor, end: def.endLine, chunkType: pendingHeader ? pendingHeader.chunkType : 'block' });
	};

	let cursor = 1;
	for (const def of defs) {
		if (def.startLine < cursor) continue;           // overlapping (should not happen at one level)
		pushGap(cursor, def.startLine - 1);
		pushDef(def);
		cursor = def.endLine + 1;
	}
	pushGap(cursor, total);
	return spans
		// import-only preambles carry nothing worth retrieving (the import graph has them)
		.filter(s => !(s.chunkType === 'block' && isImportOnlyBlock(lines.slice(s.start - 1, s.end).join('\n'))))
		// a gap longer than the cap is split too (module-level statements, config tables)
		.flatMap(s => s.end - s.start + 1 > MAX_CHUNK_LINES && s.chunkType === 'block'
			? splitAtBlankLines(lines, s.start - 1, s.end - 1, MAX_CHUNK_LINES).map(sub => ({ start: sub.start + 1, end: sub.end + 1, chunkType: 'block' as const }))
			: [s]);
};

export const chunkFile = (
	workspaceHash: string,
	filePath: string,
	content: string,
	language: string | null,
): CodeChunk[] => {
	if (!language || SKIP_LANGUAGES.has(language)) return [];
	if (content.length > MAX_FILE_CHARS) return [];

	const lines = content.split('\n');
	const spans: Span[] = [];

	const outline = parseOutline(content, language, filePath);
	if (outline && outline.length > 0) {
		spans.push(...spansFromOutline(outline, lines));
		return spansToChunks(workspaceHash, filePath, lines, spans);
	}

	const patterns = LANGUAGE_BOUNDARIES[language] ?? [];
	const boundaries = findBoundaryLines(content, patterns);

	if (boundaries.length === 0) {
		const endLine = Math.min(lines.length, FALLBACK_FILE_LINES);
		spans.push({ start: 1, end: endLine, chunkType: 'file' });
	} else {
		for (let i = 0; i < boundaries.length; i++) {
			const startLine = boundaries[i].line;
			const endLine = i + 1 < boundaries.length ? boundaries[i + 1].line - 1 : lines.length;
			const chunkType = boundaries[i].chunkType;
			if (endLine - startLine + 1 > MAX_CHUNK_LINES) {
				for (const sub of splitAtBlankLines(lines, startLine - 1, endLine - 1, MAX_CHUNK_LINES)) {
					spans.push({ start: sub.start + 1, end: sub.end + 1, chunkType });
				}
			} else {
				spans.push({ start: startLine, end: endLine, chunkType });
			}
		}
	}
	return spansToChunks(workspaceHash, filePath, lines, spans);
};

const spansToChunks = (workspaceHash: string, filePath: string, lines: string[], spans: Span[]): CodeChunk[] => {
	const chunks: CodeChunk[] = [];
	for (const span of spans) {
		const chunkText = lines.slice(span.start - 1, span.end).join('\n');
		if (countNonEmptyLines(chunkText) < MIN_NON_EMPTY_LINES) continue;
		chunks.push({
			id: makeChunkId(workspaceHash, filePath, span.start),
			filePath,
			chunkText,
			startLine: span.start,
			endLine: span.end,
			chunkType: span.chunkType,
		});
	}
	return chunks;
};

const extractLeadingDocstring = (lines: string[], startLineIdx: number, language: string): string => {
	const commentChars = language === 'Python' ? ['#'] : ['//', '*', '/**', '/*'];
	const result: string[] = [];
	for (let i = startLineIdx - 1; i >= Math.max(0, startLineIdx - 8); i--) {
		const line = lines[i].trim();
		const isComment = commentChars.some(c => line.startsWith(c)) || line === '*/';
		if (!isComment && line !== '') {
			break;
		}
		if (isComment) {
			result.unshift(line.replace(/^[/*#\s]+/, '').replace(/\*+\/$/, '').trim());
		}
	}
	return result.filter(Boolean).join(' ').slice(0, 150);
};

export const extractSymbolsFromFile = (
	workspaceHash: string,
	filePath: string,
	content: string,
	language: string | null,
): ExtractedSymbol[] => {
	if (!supportsSymbolExtraction(language)) {
		return [];
	}

	const lines = content.split('\n');
	const outline = parseOutline(content, language, filePath);
	if (outline) {
		return flattenOutline(outline).map(def => {
			const symbolText = lines.slice(def.startLine - 1, def.endLine).join('\n');
			return {
				name: def.name,
				kind: def.kind,
				filePath,
				startLine: def.startLine,
				endLine: def.endLine,
				signature: def.parentName ? `${def.parentName}.${def.signature}` : def.signature,
				docstring: def.docstring,
				isExported: def.isExported,
				contentHash: createHash('sha256').update(symbolText).digest('hex').slice(0, 16),
			};
		});
	}

	// regex fallback (grammar not loaded or language without one)
	const patterns = SYMBOL_PATTERNS[language!];
	if (!patterns) return [];
	const symbols: ExtractedSymbol[] = [];
	const boundaries = findBoundaryLines(content, LANGUAGE_BOUNDARIES[language!] ?? []);

	for (let b = 0; b < boundaries.length; b++) {
		const startLineIdx = boundaries[b].line - 1;
		const endLineIdx = b + 1 < boundaries.length
			? boundaries[b + 1].line - 2
			: lines.length - 1;
		const line = lines[startLineIdx];

		for (const pat of patterns) {
			const match = pat.nameRegex.exec(line);
			if (!match?.[1]) {
				continue;
			}

			const name = match[1];
			const isExported = pat.exportRegex.test(line);
			const signature = line.trim().slice(0, 200);
			const docstring = extractLeadingDocstring(lines, startLineIdx, language!);
			const symbolText = lines.slice(startLineIdx, endLineIdx + 1).join('\n');
			const contentHash = createHash('sha256').update(symbolText).digest('hex').slice(0, 16);

			symbols.push({
				name,
				kind: pat.kind,
				filePath,
				startLine: startLineIdx + 1,
				endLine: endLineIdx + 1,
				signature,
				docstring,
				isExported,
				contentHash,
			});
			break;
		}
	}
	return symbols;
};

export const buildChunksForWorkspace = (
	workspaceRoot: string,
	workspaceHash: string,
	fileMeta: FileMetadataEntry[],
): CodeChunk[] => {
	const chunks: CodeChunk[] = [];
	const indexable = fileMeta.filter(f => f.language && !SKIP_LANGUAGES.has(f.language));

	for (const file of indexable) {
		let content: string;
		try {
			content = readFileSync(join(workspaceRoot, file.filePath), 'utf8');
		} catch {
			continue;
		}

		const fileChunks = chunkFile(workspaceHash, file.filePath, content, file.language);
		chunks.push(...fileChunks);
	}

	return chunks;
};
