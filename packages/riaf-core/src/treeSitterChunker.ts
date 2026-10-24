/**
 * AST outlines via web-tree-sitter (`@vscode/tree-sitter-wasm` grammars).
 *
 * The runtime and grammars are loaded lazily and asynchronously (`ensureTreeSitterLanguages`);
 * once a grammar is in memory, `parseOutline` is synchronous so `chunkFile` /
 * `extractSymbolsFromFile` keep their signatures. When the wasm package is missing or a language
 * has no grammar, `parseOutline` returns `null` and the regex chunker takes over.
 */
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { CodeChunkType, ExtractedSymbol } from './repoIntelligenceTypes.js';

export type AstDefinition = {
	name: string;
	kind: ExtractedSymbol['kind'];
	chunkType: CodeChunkType;
	/** 1-based, inclusive. Includes decorators / annotations / leading `export`. */
	startLine: number;
	endLine: number;
	isExported: boolean;
	signature: string;
	docstring: string;
	/** Enclosing class / struct / impl, for methods. */
	parentName?: string;
	/** Nested definitions (methods of a class, functions inside an impl). */
	children: AstDefinition[];
};

/* ───────────────────────────── minimal web-tree-sitter typings ───────────────────────────── */

interface TsPoint { row: number; column: number }
interface TsNode {
	type: string;
	text: string;
	startPosition: TsPoint;
	endPosition: TsPoint;
	startIndex: number;
	endIndex: number;
	namedChildren: TsNode[];
	children: TsNode[];
	parent: TsNode | null;
	previousNamedSibling: TsNode | null;
	childForFieldName(name: string): TsNode | null;
}
interface TsTree { rootNode: TsNode; delete(): void }
interface TsParser { setLanguage(l: unknown): void; parse(src: string): TsTree | null; delete(): void }
interface TsRuntime {
	Parser: { init(opts?: { locateFile?: (f: string) => string }): Promise<void>; new(): TsParser };
	Language: { load(path: string): Promise<unknown> };
}

/* ───────────────────────────── per-language grammar config ───────────────────────────── */

type DefRule = {
	kind: ExtractedSymbol['kind'];
	chunkType: CodeChunkType;
	/** Field holding the name (default `name`). */
	nameField?: string;
	/** Custom name derivation (wins over `nameField`). */
	nameFn?: (node: TsNode) => string | null;
	/** Descendant node type that carries the declarator (C/C++ `function_declarator`). */
	nameType?: string;
	/** Scan the body for nested definitions. */
	container?: boolean;
	/** Keep only nodes passing this test (e.g. `const` only when exported or holding a function). */
	filter?: (node: TsNode, exported: boolean) => boolean;
	/** Refine the kind from the node (Go `type X interface` → interface). */
	kindOf?: (node: TsNode) => ExtractedSymbol['kind'];
};

const FUNCTION_VALUE_TYPES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function', 'class', 'class_expression']);
/** `const x = () => …` or an exported constant; plain locals are noise in a symbol table. */
const constWorthKeeping = (node: TsNode, exported: boolean): boolean => {
	if (exported) return true;
	const declarator = node.namedChildren.find(c => c.type === 'variable_declarator') ?? node;
	const value = declarator.childForFieldName('value');
	return !!value && FUNCTION_VALUE_TYPES.has(value.type);
};
type LanguageSpec = {
	grammar: string;
	/** Node types that define a symbol. */
	defs: Record<string, DefRule>;
	/** Node types to look through (their children are scanned as if at the same level). */
	transparent: Set<string>;
	/** Node types whose children are scanned for nested definitions (class bodies etc). */
	bodies: Set<string>;
	comment: Set<string>;
	isExported(node: TsNode, name: string): boolean;
};

const TS_LIKE = (grammar: string): LanguageSpec => ({
	grammar,
	defs: {
		function_declaration: { kind: 'function', chunkType: 'function' },
		generator_function_declaration: { kind: 'function', chunkType: 'function' },
		class_declaration: { kind: 'class', chunkType: 'class', container: true },
		abstract_class_declaration: { kind: 'class', chunkType: 'class', container: true },
		interface_declaration: { kind: 'interface', chunkType: 'block' },
		type_alias_declaration: { kind: 'type', chunkType: 'block' },
		enum_declaration: { kind: 'enum', chunkType: 'block' },
		lexical_declaration: { kind: 'const', chunkType: 'block', filter: constWorthKeeping },
		variable_declaration: { kind: 'const', chunkType: 'block', filter: constWorthKeeping },
		method_definition: { kind: 'function', chunkType: 'function' },
		method_signature: { kind: 'function', chunkType: 'function' },
		public_field_definition: { kind: 'const', chunkType: 'block', filter: n => FUNCTION_VALUE_TYPES.has(n.childForFieldName('value')?.type ?? '') },
	},
	transparent: new Set(['export_statement']),
	bodies: new Set(['class_body']),
	comment: new Set(['comment']),
	isExported: node => {
		let n: TsNode | null = node;
		while (n) { if (n.type === 'export_statement') return true; if (n.type === 'class_body') return isParentExported(n); n = n.parent; }
		return false;
	},
});
const isParentExported = (body: TsNode): boolean => {
	// a method is "exported" when its class is, and it is not private
	let n: TsNode | null = body.parent;
	while (n) { if (n.type === 'export_statement') return true; n = n.parent; }
	return false;
};

const LANGUAGES: Record<string, LanguageSpec> = {
	TypeScript: TS_LIKE('tree-sitter-typescript.wasm'),
	TSX: TS_LIKE('tree-sitter-tsx.wasm'),
	JavaScript: TS_LIKE('tree-sitter-javascript.wasm'),
	Python: {
		grammar: 'tree-sitter-python.wasm',
		defs: {
			function_definition: { kind: 'function', chunkType: 'function' },
			class_definition: { kind: 'class', chunkType: 'class', container: true },
		},
		transparent: new Set(['decorated_definition']),
		bodies: new Set(['block']),
		comment: new Set(['comment']),
		isExported: (_n, name) => !name.startsWith('_'),
	},
	Java: {
		grammar: 'tree-sitter-java.wasm',
		defs: {
			class_declaration: { kind: 'class', chunkType: 'class', container: true },
			interface_declaration: { kind: 'interface', chunkType: 'block', container: true },
			enum_declaration: { kind: 'enum', chunkType: 'block', container: true },
			record_declaration: { kind: 'class', chunkType: 'class', container: true },
			annotation_type_declaration: { kind: 'interface', chunkType: 'block' },
			method_declaration: { kind: 'function', chunkType: 'function' },
			constructor_declaration: { kind: 'function', chunkType: 'function' },
		},
		transparent: new Set(['enum_body_declarations']),
		bodies: new Set(['class_body', 'interface_body', 'enum_body']),
		comment: new Set(['line_comment', 'block_comment']),
		isExported: node => /\bpublic\b/.test(node.children.find(c => c.type === 'modifiers')?.text ?? ''),
	},
	Go: {
		grammar: 'tree-sitter-go.wasm',
		defs: {
			function_declaration: { kind: 'function', chunkType: 'function' },
			method_declaration: { kind: 'function', chunkType: 'function' },
			type_spec: {
				kind: 'class', chunkType: 'class',
				kindOf: n => { const t = n.childForFieldName('type')?.type; return t === 'interface_type' ? 'interface' : t === 'struct_type' ? 'class' : 'type'; },
			},
			type_alias: { kind: 'type', chunkType: 'block' },
		},
		transparent: new Set(['type_declaration']),
		bodies: new Set(),
		comment: new Set(['comment']),
		isExported: (_n, name) => /^[A-Z]/.test(name),
	},
	Rust: {
		grammar: 'tree-sitter-rust.wasm',
		defs: {
			function_item: { kind: 'function', chunkType: 'function' },
			function_signature_item: { kind: 'function', chunkType: 'function' },
			struct_item: { kind: 'class', chunkType: 'class' },
			enum_item: { kind: 'enum', chunkType: 'block' },
			trait_item: { kind: 'interface', chunkType: 'block', container: true },
			impl_item: {
				kind: 'class', chunkType: 'class', container: true,
				// `impl Display for S` → one symbol per impl block, distinct from the struct itself
				nameFn: n => { const t = n.childForFieldName('type')?.text; const tr = n.childForFieldName('trait')?.text; return t ? `impl ${tr ? `${tr} for ` : ''}${t}` : null; },
			},
			type_item: { kind: 'type', chunkType: 'block' },
			const_item: { kind: 'const', chunkType: 'block' },
			static_item: { kind: 'const', chunkType: 'block' },
			mod_item: { kind: 'class', chunkType: 'block', container: true },
		},
		transparent: new Set(),
		bodies: new Set(['declaration_list']),
		comment: new Set(['line_comment', 'block_comment']),
		isExported: node => node.children.some(c => c.type === 'visibility_modifier'),
	},
	'C#': {
		grammar: 'tree-sitter-c-sharp.wasm',
		defs: {
			class_declaration: { kind: 'class', chunkType: 'class', container: true },
			struct_declaration: { kind: 'class', chunkType: 'class', container: true },
			record_declaration: { kind: 'class', chunkType: 'class', container: true },
			interface_declaration: { kind: 'interface', chunkType: 'block', container: true },
			enum_declaration: { kind: 'enum', chunkType: 'block' },
			method_declaration: { kind: 'function', chunkType: 'function' },
			constructor_declaration: { kind: 'function', chunkType: 'function' },
			property_declaration: { kind: 'const', chunkType: 'block' },
		},
		transparent: new Set(['namespace_declaration', 'file_scoped_namespace_declaration']),
		bodies: new Set(['declaration_list']),
		comment: new Set(['comment']),
		isExported: node => node.children.some(c => c.type === 'modifier' && c.text === 'public'),
	},
	Ruby: {
		grammar: 'tree-sitter-ruby.wasm',
		defs: {
			method: { kind: 'function', chunkType: 'function' },
			singleton_method: { kind: 'function', chunkType: 'function' },
			class: { kind: 'class', chunkType: 'class', container: true },
			module: { kind: 'class', chunkType: 'class', container: true },
		},
		transparent: new Set(),
		bodies: new Set(['body_statement']),
		comment: new Set(['comment']),
		isExported: () => true,
	},
	PHP: {
		grammar: 'tree-sitter-php.wasm',
		defs: {
			function_definition: { kind: 'function', chunkType: 'function' },
			class_declaration: { kind: 'class', chunkType: 'class', container: true },
			interface_declaration: { kind: 'interface', chunkType: 'block', container: true },
			trait_declaration: { kind: 'class', chunkType: 'class', container: true },
			enum_declaration: { kind: 'enum', chunkType: 'block' },
			method_declaration: { kind: 'function', chunkType: 'function' },
		},
		transparent: new Set(['namespace_definition']),
		bodies: new Set(['declaration_list']),
		comment: new Set(['comment']),
		isExported: node => !/\bprivate\b/.test(node.children.find(c => c.type === 'visibility_modifier')?.text ?? ''),
	},
	'C++': {
		grammar: 'tree-sitter-cpp.wasm',
		defs: {
			function_definition: { kind: 'function', chunkType: 'function', nameType: 'function_declarator' },
			class_specifier: { kind: 'class', chunkType: 'class', container: true },
			struct_specifier: { kind: 'class', chunkType: 'class', container: true },
			enum_specifier: { kind: 'enum', chunkType: 'block' },
		},
		transparent: new Set(['namespace_definition', 'declaration_list', 'template_declaration']),
		bodies: new Set(['field_declaration_list']),
		comment: new Set(['comment']),
		isExported: () => true,
	},
	Shell: {
		grammar: 'tree-sitter-bash.wasm',
		defs: { function_definition: { kind: 'function', chunkType: 'function' } },
		transparent: new Set(),
		bodies: new Set(),
		comment: new Set(['comment']),
		isExported: () => true,
	},
};

/** Languages with a bundled grammar. */
export const TREE_SITTER_LANGUAGES: readonly string[] = Object.keys(LANGUAGES);

/* ───────────────────────────── runtime loading ───────────────────────────── */

let runtime: TsRuntime | null | undefined;      // undefined = not tried, null = unavailable
let runtimeInit: Promise<TsRuntime | null> | null = null;
let wasmDirOverride: string | undefined;
const loaded = new Map<string, unknown>();      // language → Language object
const loading = new Map<string, Promise<void>>();
let parser: TsParser | null = null;
let disabled = false;

/** Point the loader at a directory holding `tree-sitter.wasm` + `tree-sitter-<lang>.wasm` (e.g. a vendored copy in a .vsix). */
export const setTreeSitterWasmDir = (dir: string | undefined): void => { wasmDirOverride = dir; };
/** Turn AST chunking off entirely (tests, or a user setting). */
export const setTreeSitterEnabled = (enabled: boolean): void => { disabled = !enabled; };

const findWasmDir = (): string | null => {
	const candidates: string[] = [];
	if (wasmDirOverride) candidates.push(wasmDirOverride);
	if (process.env.RIAF_TREE_SITTER_WASM_DIR) candidates.push(process.env.RIAF_TREE_SITTER_WASM_DIR);
	try {
		const req = createRequire(import.meta.url);
		candidates.push(join(dirname(req.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm'));
	} catch { /* not installed */ }
	return candidates.find(d => existsSync(join(d, 'tree-sitter.wasm')) && existsSync(join(d, 'tree-sitter.js'))) ?? null;
};

const initRuntime = (): Promise<TsRuntime | null> => {
	if (runtime !== undefined) return Promise.resolve(runtime);
	if (runtimeInit) return runtimeInit;
	runtimeInit = (async () => {
		try {
			const dir = findWasmDir();
			if (!dir) { runtime = null; return null; }
			const req = createRequire(import.meta.url);
			const mod = req(join(dir, 'tree-sitter.js')) as TsRuntime;
			await mod.Parser.init({ locateFile: (f: string) => join(dir, f) });
			parser = new mod.Parser();
			(mod as TsRuntime & { __dir?: string }).__dir = dir;
			runtime = mod;
			return mod;
		} catch {
			runtime = null;
			return null;
		}
	})();
	return runtimeInit;
};

/**
 * Load the grammars for `languages` (no-op for those already loaded / unsupported). Resolves
 * to the list of languages that are now parseable with tree-sitter.
 */
export async function ensureTreeSitterLanguages(languages: Iterable<string>): Promise<string[]> {
	if (disabled) return [];
	const rt = await initRuntime();
	if (!rt) return [];
	const dir = (rt as TsRuntime & { __dir?: string }).__dir!;
	const ready: string[] = [];
	await Promise.all([...new Set(languages)].map(async lang => {
		const spec = LANGUAGES[lang];
		if (!spec) return;
		if (loaded.has(lang)) { ready.push(lang); return; }
		let p = loading.get(lang);
		if (!p) {
			p = (async () => {
				try {
					const file = join(dir, spec.grammar);
					if (!existsSync(file)) return;
					loaded.set(lang, await rt.Language.load(file));
				} catch { /* grammar unusable → regex fallback for this language */ }
			})().finally(() => loading.delete(lang));
			loading.set(lang, p);
		}
		await p;
		if (loaded.has(lang)) ready.push(lang);
	}));
	return ready;
}

/** True when `language` can be parsed right now (grammar in memory). */
export const treeSitterReady = (language: string | null | undefined): boolean =>
	!disabled && !!language && loaded.has(language) && !!parser;

/** Map a detected language + path to the grammar key (TSX files use the tsx grammar). */
export const grammarLanguageFor = (language: string | null | undefined, filePath: string): string | null => {
	if (!language) return null;
	if (language === 'TypeScript' && /\.tsx$/i.test(filePath)) return 'TSX';
	return LANGUAGES[language] ? language : null;
};

/* ───────────────────────────── outline extraction ───────────────────────────── */

const findDescendant = (node: TsNode, type: string, depth: number): TsNode | null => {
	if (depth < 0) return null;
	for (const c of node.children) {
		if (c.type === type) return c;
		const deeper = findDescendant(c, type, depth - 1);
		if (deeper) return deeper;
	}
	return null;
};

const nameOf = (node: TsNode, rule: DefRule): string | null => {
	if (rule.nameFn) return rule.nameFn(node);
	if (rule.nameField) { const n = node.childForFieldName(rule.nameField); if (n) return n.text; }
	const byField = node.childForFieldName('name');
	if (byField) return byField.text;
	if (rule.nameType) {
		const decl = findDescendant(node, rule.nameType, 3);
		const inner = decl?.childForFieldName('declarator');
		if (inner) return inner.text.replace(/^.*::/, '');
	}
	// lexical_declaration: `export const foo = …` → first declarator's name
	const declarator = node.namedChildren.find(c => c.type === 'variable_declarator');
	if (declarator) return declarator.childForFieldName('name')?.text ?? null;
	return null;
};

/** Comment nodes directly above `node` (through export/decorator wrappers), outermost first. */
const leadingComments = (node: TsNode, spec: LanguageSpec): TsNode[] => {
	let anchor: TsNode = node;
	while (anchor.parent && spec.transparent.has(anchor.parent.type)) anchor = anchor.parent;
	const out: TsNode[] = [];
	let sib = anchor.previousNamedSibling;
	let expectRow = anchor.startPosition.row;
	while (sib && spec.comment.has(sib.type) && sib.endPosition.row >= expectRow - 1) {
		out.unshift(sib);
		expectRow = sib.startPosition.row;
		sib = sib.previousNamedSibling;
	}
	return out;
};

const docstringBefore = (node: TsNode, spec: LanguageSpec): string => {
	const parts = leadingComments(node, spec).map(c => c.text);
	if (!parts.length && spec.grammar.includes('python')) {
		// PEP 257 docstring: first statement of the body
		const body = node.childForFieldName('body');
		const first = body?.namedChildren[0];
		const str = first?.type === 'expression_statement' ? first.namedChildren[0] : null;
		if (str?.type === 'string') parts.push(str.text);
	}
	return parts.join(' ')
		.replace(/\/\*+|\*+\/|^\s*[*#/]+\s?/gm, ' ')
		.replace(/^\s*(["']{3})|(["']{3})\s*$/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 150);
};

const signatureOf = (node: TsNode, lines: string[]): string => {
	// first line of the definition that is not an annotation / decorator / comment
	for (let r = node.startPosition.row; r <= node.endPosition.row && r < lines.length; r++) {
		const t = lines[r].trim();
		if (!t || t.startsWith('@') || t.startsWith('#[') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
		return t.replace(/\s*(\{\s*\}?|:)\s*$/, '').slice(0, 200);
	}
	return lines[node.startPosition.row]?.trim().slice(0, 200) ?? '';
};

const collect = (parent: TsNode, spec: LanguageSpec, lines: string[], parentName: string | undefined, out: AstDefinition[]): void => {
	for (const child of parent.namedChildren) {
		if (spec.transparent.has(child.type)) { collect(child, spec, lines, parentName, out); continue; }
		const rule = spec.defs[child.type];
		if (!rule) continue;
		const name = nameOf(child, rule);
		if (!name) continue;
		const isExported = spec.isExported(child, name);
		if (rule.filter && !rule.filter(child, isExported)) continue;
		// the span starts at the outermost wrapper (export statement / decorators) or its doc comment
		let outer: TsNode = child;
		while (outer.parent && spec.transparent.has(outer.parent.type)) outer = outer.parent;
		const docs = leadingComments(child, spec);
		const def: AstDefinition = {
			name,
			kind: rule.kindOf ? rule.kindOf(child) : rule.kind,
			chunkType: rule.chunkType,
			startLine: (docs[0] ?? outer).startPosition.row + 1,
			endLine: child.endPosition.row + 1,
			isExported,
			signature: signatureOf(child, lines),
			docstring: docstringBefore(child, spec),
			parentName,
			children: [],
		};
		if (rule.container) {
			const body = child.children.find(c => spec.bodies.has(c.type)) ?? child.childForFieldName('body');
			if (body) collect(body, spec, lines, name, def.children);
		}
		out.push(def);
	}
};

/** True when `text` is only imports / package / using lines and comments — no code to retrieve. */
export const isImportOnlyBlock = (text: string): boolean => {
	const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
	if (!lines.length) return true;
	let inBlockComment = false;
	return lines.every(l => {
		if (inBlockComment) { if (l.includes('*/')) inBlockComment = false; return true; }
		if (l.startsWith('/*')) { inBlockComment = !l.includes('*/'); return true; }
		if (/^(\/\/|#(?!include)|\*|"""|'''|--)/.test(l)) return true;
		if (/^(import\b|from\s+\S+\s+import\b|export\s+(\*|\{)[^=]*from\b|package\b|using\b|use\b|#include\b|require\s*\(|(const|let|var)\s+[\w{}\s,]+=\s*require\()/.test(l)) return true;
		if (/^\}?\s*from\s+['"]/.test(l) || /^\)\s*;?$/.test(l)) return true;      // closing line of a multi-line import
		return /^[\w.,{}()\s*'"]+;?$/.test(l) && !/[=]/.test(l) && !/\w\s*\(/.test(l); // bare name lists inside a multi-line import
	});
};

/**
 * Parse `content` and return the definition outline, or `null` when tree-sitter is not ready
 * for this language (caller falls back to regex heuristics).
 */
export function parseOutline(content: string, language: string | null | undefined, filePath = ''): AstDefinition[] | null {
	const key = grammarLanguageFor(language, filePath);
	if (!key || !treeSitterReady(key) || !parser) return null;
	const spec = LANGUAGES[key];
	let tree: TsTree | null = null;
	try {
		parser.setLanguage(loaded.get(key));
		tree = parser.parse(content);
		if (!tree) return null;
		const lines = content.split('\n');
		const out: AstDefinition[] = [];
		collect(tree.rootNode, spec, lines, undefined, out);
		out.sort((a, b) => a.startLine - b.startLine);
		return out;
	} catch {
		return null;
	} finally {
		tree?.delete();
	}
}

/** Flatten an outline (depth-first) — what the symbol table stores. */
export const flattenOutline = (defs: AstDefinition[]): AstDefinition[] => {
	const out: AstDefinition[] = [];
	const walk = (d: AstDefinition) => { out.push(d); d.children.forEach(walk); };
	defs.forEach(walk);
	return out;
};
