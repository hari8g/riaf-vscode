/**
 * Symbol-level graph: who calls, extends, implements or imports what.
 *
 * Nodes are the symbols already extracted into the `symbols` table (functions, classes, types …).
 * Edges are extracted per file from the source text — tree-sitter gives us the definition ranges
 * (via the outline), and a tolerant lexical pass finds call sites, inheritance clauses and import
 * bindings. Callee names are resolved to their defining file through the workspace symbol index,
 * so an edge to a builtin or a library function is dropped and the result stays low-noise.
 *
 * The file-level Universal Context Graph stays as a projection; this adds the hop the agent needs
 * before editing a function: "who depends on this".
 */
import type { ExtractedSymbol } from './repoIntelligenceTypes.js';
import type { ImportEdge } from './universalImportExtractor.js';

export type SymbolEdgeType = 'calls' | 'instantiates' | 'extends' | 'implements' | 'imports';

export type SymbolEdge = {
	fromFile: string;
	/** Enclosing definition at the use site, qualified (`Order.capture`); null = module level. */
	fromSymbol: string | null;
	/** Simple name of the callee / base type / imported binding. */
	toName: string;
	/** File that defines `toName`, when it could be resolved inside the workspace. */
	toFile: string | null;
	edgeType: SymbolEdgeType;
	/** 1-based line of the use site. */
	line: number;
};

export type ImportBinding = { name: string; module: string; file: string | null; line: number; isNamespace: boolean };

/** Resolve a simple name to the file defining it. `hint` is the file a binding points at, if any. */
export type DefinitionResolver = (name: string, ctx: { fromFile: string; importedFrom: string | null; importedFiles: Set<string> }) => string | null;

// ── keywords that look like calls ───────────────────────────────────────────

const COMMON_KEYWORDS = ['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'return', 'throw', 'try', 'catch', 'finally', 'new', 'delete', 'typeof', 'instanceof', 'void', 'in', 'of', 'await', 'async', 'yield', 'function', 'class', 'super', 'this', 'import', 'export', 'require', 'define', 'const', 'let', 'var', 'static', 'public', 'private', 'protected', 'readonly', 'declare', 'constructor', 'get', 'set', 'with', 'assert', 'sizeof', 'defer', 'go', 'select', 'match', 'loop', 'fn', 'func', 'def', 'elif', 'except', 'lambda', 'print', 'pass', 'not', 'and', 'or', 'is', 'as', 'from', 'struct', 'enum', 'interface', 'type', 'impl', 'trait', 'pub', 'mod', 'use', 'where', 'macro_rules', 'foreach', 'using', 'namespace', 'override', 'virtual', 'operator', 'template', 'typename', 'decltype', 'alignof', 'noexcept', 'static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast', 'synchronized', 'throws', 'extends', 'implements', 'abstract', 'final', 'native', 'transient', 'volatile', 'package', 'when', 'object', 'val', 'fun', 'init', 'companion', 'echo', 'isset', 'unset', 'empty', 'list', 'array', 'elseif', 'end', 'unless', 'until', 'begin', 'rescue', 'ensure', 'module', 'then', 'nil', 'true', 'false', 'null', 'None', 'Some', 'Ok', 'Err', 'Box', 'Vec', 'String', 'Option', 'Result', 'println', 'eprintln', 'format', 'vec', 'panic', 'unwrap', 'expect', 'clone', 'to_string', 'into', 'iter', 'collect', 'map', 'filter', 'len', 'push', 'pop', 'get', 'set', 'has', 'add', 'remove', 'keys', 'values', 'entries', 'join', 'split', 'trim', 'slice', 'splice', 'concat', 'indexOf', 'includes', 'find', 'some', 'every', 'reduce', 'forEach', 'sort', 'reverse', 'toString', 'valueOf', 'parse', 'stringify', 'log', 'warn', 'error', 'info', 'debug', 'test', 'describe', 'it', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'require_once', 'include', 'include_once', 'str', 'int', 'float', 'bool', 'dict', 'tuple', 'range', 'enumerate', 'zip', 'isinstance', 'hasattr', 'getattr', 'setattr', 'super', 'self', 'Promise', 'Array', 'Object', 'Number', 'Boolean', 'Symbol', 'Map', 'Set', 'WeakMap', 'Date', 'Error', 'RegExp', 'JSON', 'Math', 'parseInt', 'parseFloat', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'resolve', 'reject', 'then', 'apply', 'call', 'bind'];
const SKIP_CALLEES = new Set(COMMON_KEYWORDS);

/** Words that mark the identifier right after them as a *declaration*, not a call. */
const DECL_BEFORE = /\b(?:function\*?|def|fn|func|class|interface|struct|enum|trait|type|constructor|get|set|async\s+function|static|public|private|protected|abstract|override|virtual|fun|sub|macro_rules!)\s*$/;

const IDENT_CALL = /(?<![\w$.])(?:new\s+)?([A-Za-z_$][\w$]*)(?:\s*(?:<[^<>()]{0,80}>|::<[^<>()]{0,80}>))?\s*\(/g;
const MEMBER_CALL = /(?<![\w$])([A-Za-z_$][\w$]*(?:\??\.|::|->)[A-Za-z_$][\w$]*)(?:\s*(?:<[^<>()]{0,80}>|::<[^<>()]{0,80}>))?\s*\(/g;

// ── source masking (strings & comments become spaces, newlines preserved) ────

const LINE_COMMENT: Record<string, string[]> = {
	Python: ['#'], Ruby: ['#'], Bash: ['#'], Shell: ['#'], YAML: ['#'], PHP: ['//', '#'],
};
const DEFAULT_LINE_COMMENT = ['//'];

export function maskSource(content: string, language: string): string {
	const markers = LINE_COMMENT[language] ?? DEFAULT_LINE_COMMENT;
	const out: string[] = [];
	let i = 0;
	const n = content.length;
	const blank = (s: string) => s.replace(/[^\n]/g, ' ');
	while (i < n) {
		const ch = content[i];
		// block comments
		if (ch === '/' && content[i + 1] === '*' && language !== 'Python') {
			const end = content.indexOf('*/', i + 2);
			const stop = end < 0 ? n : end + 2;
			out.push(blank(content.slice(i, stop))); i = stop; continue;
		}
		if (language === 'Python' && (content.startsWith('"""', i) || content.startsWith("'''", i))) {
			const q = content.slice(i, i + 3);
			const end = content.indexOf(q, i + 3);
			const stop = end < 0 ? n : end + 3;
			out.push(blank(content.slice(i, stop))); i = stop; continue;
		}
		let isLineComment = false;
		for (const m of markers) {
			if (content.startsWith(m, i)) {
				// `#include`, `#[derive]`, `#!` are not comments in C/Rust/shebang-land
				if (m === '#' && (language === 'C' || language === 'C++' || language === 'Rust' || language === 'C#')) break;
				isLineComment = true; break;
			}
		}
		if (isLineComment) {
			const end = content.indexOf('\n', i);
			const stop = end < 0 ? n : end;
			out.push(blank(content.slice(i, stop))); i = stop; continue;
		}
		if (ch === '"' || ch === "'" || ch === '`') {
			let j = i + 1;
			while (j < n && content[j] !== ch) {
				if (content[j] === '\\') j++;
				else if (content[j] === '\n' && ch !== '`') break;      // unterminated single-line string
				j++;
			}
			const stop = Math.min(n, j + 1);
			// keep the quotes so `import x from 'y'` style parsers still see the shape
			out.push(ch + blank(content.slice(i + 1, stop - 1)) + (stop - 1 < n && content[stop - 1] === ch ? ch : ''));
			i = stop; continue;
		}
		out.push(ch); i++;
	}
	return out.join('');
}

// ── import bindings ─────────────────────────────────────────────────────────

const lastSeg = (s: string, sep: RegExp) => s.split(sep).filter(Boolean).pop() ?? s;

export function extractImportBindings(content: string, language: string, importEdges: ImportEdge[]): ImportBinding[] {
	const fileFor = new Map(importEdges.map(e => [e.toModule, e.resolvedFile]));
	const out: ImportBinding[] = [];
	const lines = content.split('\n');
	const push = (name: string, module: string, line: number, isNamespace = false) => {
		const clean = name.trim().replace(/^type\s+/, '');
		if (!/^[A-Za-z_$][\w$]*$/.test(clean)) return;
		out.push({ name: clean, module, file: fileFor.get(module) ?? null, line, isNamespace });
	};
	const asName = (spec: string) => { const m = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(spec); return m ? (m[2] ?? m[1]) : null; };

	if (language === 'TypeScript' || language === 'JavaScript') {
		// handle multi-line import clauses by joining until the `from`
		const text = content;
		const re = /(?:^|\n)[ \t]*(?:import|export)\s+(type\s+)?([^;'"]*?)\s+from\s+['"]([^'"]+)['"]/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			const line = text.slice(0, m.index + (m[0].startsWith('\n') ? 1 : 0)).split('\n').length;
			const clause = m[2], mod = m[3];
			const ns = /\*\s+as\s+([\w$]+)/.exec(clause);
			if (ns) push(ns[1], mod, line, true);
			const braces = /\{([^}]*)\}/.exec(clause);
			if (braces) for (const spec of braces[1].split(',')) { const nm = asName(spec); if (nm) push(nm, mod, line); }
			const def = /^\s*([\w$]+)\s*(?:,|$)/.exec(clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+[\w$]+/, ''));
			if (def && def[1] !== 'type') push(def[1], mod, line, true);
		}
		const req = /(?:^|\n)[ \t]*(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
		while ((m = req.exec(text)) !== null) {
			const line = text.slice(0, m.index).split('\n').length;
			if (m[1].startsWith('{')) for (const spec of m[1].slice(1, -1).split(',')) { const nm = /([\w$]+)\s*$/.exec(spec.replace(/^\s*[\w$]+\s*:\s*/, ''))?.[1]; if (nm) push(nm, m[2], line); }
			else push(m[1], m[2], line, true);
		}
		return out;
	}

	for (let i = 0; i < lines.length; i++) {
		const l = lines[i], ln = i + 1;
		if (language === 'Python') {
			let m = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/.exec(l);
			if (m) {
				let spec = m[2].trim();
				if (spec.startsWith('(')) { // multi-line
					let j = i; spec = '';
					while (j < lines.length) { spec += lines[j].replace(/^.*?import\s*/, '').replace(/[()]/g, '') + ' '; if (lines[j].includes(')')) break; j++; }
					spec = spec.replace(/^from.*?import\s*/, '');
				}
				for (const s of spec.split(',')) { const nm = asName(s.replace(/#.*$/, '')); if (nm && nm !== '*') push(nm, m[1], ln); }
				continue;
			}
			m = /^\s*import\s+(.+)$/.exec(l);
			if (m) for (const s of m[1].split(',')) { const mm = /^\s*([\w.]+)(?:\s+as\s+(\w+))?/.exec(s); if (mm) push(mm[2] ?? mm[1].split('.')[0], mm[1], ln, true); }
		} else if (language === 'Java' || language === 'Kotlin' || language === 'Scala') {
			const m = /^\s*import\s+(static\s+)?([\w.]+)(?:\.\*)?(?:\s+as\s+(\w+))?\s*;?\s*$/.exec(l);
			if (m) push(m[3] ?? lastSeg(m[2], /\./), (m[1] ? 'static ' : '') + m[2], ln, false);
		} else if (language === 'Go') {
			const single = /^\s*import\s+(?:([\w.]+)\s+)?"([^"]+)"/.exec(l);
			if (single) { push(single[1] ?? lastSeg(single[2], /\//), single[2], ln, true); continue; }
			const grouped = /^\s*(?:([\w.]+)\s+)?"([^"]+)"\s*$/.exec(l);
			if (grouped && /import\s*\(/.test(lines.slice(Math.max(0, i - 30), i).join('\n'))) push(grouped[1] ?? lastSeg(grouped[2], /\//), grouped[2], ln, true);
		} else if (language === 'Rust') {
			const m = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+?)(?:::\{([^}]*)\}|(::\*))?(?:\s+as\s+(\w+))?\s*;/.exec(l);
			if (m && !m[3]) {
				const mod = m[1];
				if (m[2]) for (const s of m[2].split(',')) { const nm = /(\w+)\s*$/.exec(s.replace(/\s+as\s+\w+$/, mm => mm))?.[1]; const alias = /as\s+(\w+)\s*$/.exec(s)?.[1]; if (nm && nm !== 'self') push(alias ?? nm, mod, ln); else if (nm === 'self') push(lastSeg(mod, /::/), mod, ln, true); }
				else push(m[4] ?? lastSeg(mod, /::/), mod, ln, false);
			}
		} else if (language === 'PHP') {
			const m = /^\s*use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/.exec(l);
			if (m) push(m[2] ?? lastSeg(m[1], /\\/), m[1], ln);
		} else if (language === 'C#') {
			const m = /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/.exec(l);
			if (m) push(lastSeg(m[1], /\./), m[1], ln, true);
		} else if (language === 'Ruby') {
			const m = /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/.exec(l);
			if (m) push(lastSeg(m[1], /\//).replace(/\W/g, '_'), m[1], ln, true);
		}
	}
	return out;
}

// ── inheritance ─────────────────────────────────────────────────────────────

type Inheritance = { subtype: string; supertype: string; edgeType: 'extends' | 'implements'; line: number };

const splitTypeList = (s: string): string[] => {
	// drop generics so `Base<Map<K,V>>, Other` splits correctly
	let depth = 0, cur = '';
	const out: string[] = [];
	for (const ch of s) {
		if (ch === '<' || ch === '(' || ch === '[') depth++;
		else if (ch === '>' || ch === ')' || ch === ']') depth--;
		if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
	}
	out.push(cur);
	return out.map(t => t.trim().replace(/<.*$/, '').replace(/\(.*$/, '').replace(/^(?:public|private|protected|virtual|open|abstract)\s+/, '').trim())
		.map(t => t.split(/[.:\\]+/).filter(Boolean).pop() ?? t)
		.filter(t => /^[A-Za-z_$][\w$]*$/.test(t) && !['object', 'Object', 'Any', 'Exception', 'ABC', 'metaclass'].includes(t));
};

export function extractInheritance(masked: string, language: string): Inheritance[] {
	const out: Inheritance[] = [];
	const lines = masked.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i], ln = i + 1;
		if (language === 'TypeScript' || language === 'JavaScript' || language === 'Java' || language === 'Kotlin' || language === 'Scala' || language === 'PHP' || language === 'C#' || language === 'C++' || language === 'Python') {
			let m = /\b(?:class|interface|enum|record|object|trait)\s+([A-Za-z_$][\w$]*)(?:<[^>]*>)?\s*(.*)$/.exec(l);
			if (m) {
				const name = m[1]; const rest = m[2];
				if (language === 'Python') {
					const bases = /^\(([^)]*)\)/.exec(rest);
					if (bases) for (const b of splitTypeList(bases[1].replace(/\w+\s*=\s*[^,]+/g, ''))) out.push({ subtype: name, supertype: b, edgeType: 'extends', line: ln });
					continue;
				}
				if (language === 'C#' || language === 'C++' || language === 'Kotlin' || language === 'Scala') {
					const colon = /^:\s*([^{]+)/.exec(rest) ?? (language === 'Scala' ? /^extends\s+([^{]+)/.exec(rest) : null);
					if (colon) {
						const types = splitTypeList(colon[1].replace(/\bwith\b/g, ','));
						types.forEach((t, k) => out.push({ subtype: name, supertype: t, edgeType: k === 0 && !/^I[A-Z]/.test(t) ? 'extends' : 'implements', line: ln }));
					}
					continue;
				}
				const ext = /\bextends\s+([^{]+?)(?:\s+implements\b|\s*\{|$)/.exec(rest);
				if (ext) for (const t of splitTypeList(ext[1])) out.push({ subtype: name, supertype: t, edgeType: 'extends', line: ln });
				const impl = /\bimplements\s+([^{]+?)(?:\s*\{|$)/.exec(rest);
				if (impl) for (const t of splitTypeList(impl[1])) out.push({ subtype: name, supertype: t, edgeType: 'implements', line: ln });
				continue;
			}
			// clause continued on the next line(s): `class Foo\n  extends Bar`
			m = /^\s*(extends|implements)\s+([^{]+)/.exec(l);
			if (m && i > 0) {
				const prevLine = lines.slice(Math.max(0, i - 3), i).reverse().find(x => /\b(?:class|interface)\s+[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*$/.test(x));
				const prev = prevLine ? /\b(?:class|interface)\s+([A-Za-z_$][\w$]*)/.exec(prevLine) : null;
				if (prev) for (const t of splitTypeList(m[2])) out.push({ subtype: prev[1], supertype: t, edgeType: m[1] as 'extends' | 'implements', line: ln });
			}
		} else if (language === 'Rust') {
			const m = /^\s*(?:unsafe\s+)?impl(?:<[^>]*>)?\s+([\w:]+)(?:<[^>]*>)?\s+for\s+([\w:]+)/.exec(l);
			if (m) out.push({ subtype: lastSeg(m[2], /::/), supertype: lastSeg(m[1], /::/), edgeType: 'implements', line: ln });
		} else if (language === 'Go') {
			// struct embedding: `type A struct { B; *C }` — treated as extends
			const m = /^\s*type\s+(\w+)\s+struct\s*\{/.exec(l);
			if (m) {
				for (let j = i + 1; j < lines.length && !/^\s*\}/.test(lines[j]); j++) {
					const emb = /^\s*\*?([A-Z]\w*(?:\.[A-Z]\w*)?)\s*(?:`[^`]*`)?\s*$/.exec(lines[j]);
					if (emb) out.push({ subtype: m[1], supertype: lastSeg(emb[1], /\./), edgeType: 'extends', line: j + 1 });
				}
			}
		} else if (language === 'Ruby') {
			const m = /^\s*class\s+(\w+)\s*<\s*([\w:]+)/.exec(l);
			if (m) out.push({ subtype: m[1], supertype: lastSeg(m[2], /::/), edgeType: 'extends', line: ln });
			const inc = /^\s*include\s+([\w:]+)/.exec(l);
			if (inc) { const cls = /\bclass\s+(\w+)/.exec(lines.slice(Math.max(0, i - 40), i).reverse().find(x => /\bclass\s+\w+/.test(x)) ?? ''); if (cls) out.push({ subtype: cls[1], supertype: lastSeg(inc[1], /::/), edgeType: 'implements', line: ln }); }
		}
	}
	return out;
}

// ── enclosing-definition lookup ─────────────────────────────────────────────

type Def = { name: string; qualified: string; startLine: number; endLine: number; kind: string };

function buildDefs(symbols: ExtractedSymbol[]): Def[] {
	const sorted = [...symbols].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
	const defs: Def[] = [];
	const stack: Def[] = [];
	for (const s of sorted) {
		while (stack.length && stack[stack.length - 1].endLine < s.startLine) stack.pop();
		// a symbol whose range sits inside the previous one is its member
		const parent = stack.find(p => p.startLine <= s.startLine && p.endLine >= s.endLine && p !== undefined);
		const container = [...stack].reverse().find(p => p.startLine <= s.startLine && p.endLine >= s.endLine) ?? parent;
		const simple = s.name.includes('.') ? s.name.split('.').pop()! : s.name;
		const qualified = container && container.kind !== 'function' ? `${container.qualified}.${simple}` : simple;
		const d: Def = { name: simple, qualified, startLine: s.startLine, endLine: s.endLine, kind: s.kind };
		defs.push(d);
		stack.push(d);
	}
	return defs;
}

const enclosing = (defs: Def[], line: number): Def | null => {
	let best: Def | null = null;
	for (const d of defs) {
		if (d.startLine <= line && d.endLine >= line && (!best || (d.endLine - d.startLine) < (best.endLine - best.startLine))) best = d;
	}
	return best;
};

// ── main extraction ─────────────────────────────────────────────────────────

export type ExtractSymbolEdgesInput = {
	filePath: string;
	content: string;
	language: string;
	symbols: ExtractedSymbol[];
	importEdges: ImportEdge[];
	resolve: DefinitionResolver;
};

export function extractSymbolEdges(input: ExtractSymbolEdgesInput): SymbolEdge[] {
	const { filePath, language, symbols, importEdges, resolve } = input;
	const masked = maskSource(input.content, language);
	const lines = masked.split('\n');
	const defs = buildDefs(symbols);
	const localNames = new Set(defs.map(d => d.name));
	const bindings = extractImportBindings(input.content, language, importEdges);
	const bindingByName = new Map(bindings.map(b => [b.name, b]));
	const importedFiles = new Set(importEdges.map(e => e.resolvedFile).filter((f): f is string => !!f));
	const edges: SymbolEdge[] = [];
	const seen = new Set<string>();
	const add = (e: SymbolEdge) => {
		const k = `${e.fromSymbol}|${e.toName}|${e.toFile}|${e.edgeType}`;
		if (seen.has(k)) return;        // one edge per (caller, callee, kind); first line wins
		seen.add(k);
		edges.push(e);
	};
	const resolveName = (name: string, receiverBinding: ImportBinding | null): string | null => {
		if (localNames.has(name)) return filePath;
		const b = receiverBinding ?? bindingByName.get(name) ?? null;
		if (b?.file) return b.file;
		return resolve(name, { fromFile: filePath, importedFrom: b?.module ?? null, importedFiles });
	};

	// imports
	for (const b of bindings) {
		if (b.isNamespace) continue;    // whole-module bindings are already file edges
		const toFile = b.file ?? resolve(b.name, { fromFile: filePath, importedFrom: b.module, importedFiles });
		if (toFile) add({ fromFile: filePath, fromSymbol: null, toName: b.name, toFile, edgeType: 'imports', line: b.line });
	}

	// inheritance
	for (const inh of extractInheritance(masked, language)) {
		const toFile = resolveName(inh.supertype, null);
		if (!toFile) continue;          // framework / library base types are not part of the workspace graph
		const sub = defs.find(d => d.name === inh.subtype) ?? null;
		add({ fromFile: filePath, fromSymbol: sub?.qualified ?? inh.subtype, toName: inh.supertype, toFile, edgeType: inh.edgeType, line: inh.line });
	}

	// calls / instantiations
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i], ln = i + 1;
		if (!l.includes('(')) continue;
		const here = enclosing(defs, ln);
		const declaredHere = new Set(defs.filter(d => d.startLine <= ln && ln <= Math.min(d.endLine, d.startLine + 6)).map(d => d.name));
		const consider = (calleeRaw: string, isNew: boolean, idx: number) => {
			let receiver: string | null = null;
			let callee = calleeRaw;
			const sep = /(\??\.|::|->)/.exec(calleeRaw);
			if (sep) { receiver = calleeRaw.slice(0, sep.index); callee = calleeRaw.slice(sep.index + sep[0].length); }
			if (SKIP_CALLEES.has(callee) && !localNames.has(callee)) return;
			if (!isNew && !receiver && declaredHere.has(callee) && DECL_BEFORE.test(l.slice(0, idx))) return;      // the declaration itself
			if (!isNew && !receiver && declaredHere.has(callee)
				&& /^\s*(?:(?:public|private|protected|static|final|abstract|override|async|export|default|fn|pub|func|def|internal|open|suspend)\s+)*(?:[\w<>\[\](),\s?*&.]+\s+)?$/.test(l.slice(0, idx))
				&& /\)[^;=]*?(?:\{|=>|\bwhere\b|\bthrows\b|:)?\s*$/.test(l.slice(idx))) return;
			if (receiver && (receiver === 'this' || receiver === 'self' || receiver === 'cls')) receiver = null;
			const receiverBinding = receiver ? bindingByName.get(receiver) ?? null : null;
			if (receiver && !receiverBinding && !localNames.has(callee) && !bindingByName.has(callee)) {
				// `foo.bar()` where neither foo nor bar is known locally: only keep if bar is unique in the workspace
				const toFile = resolve(callee, { fromFile: filePath, importedFrom: null, importedFiles });
				if (!toFile) return;
				add({ fromFile: filePath, fromSymbol: here?.qualified ?? null, toName: callee, toFile, edgeType: isNew ? 'instantiates' : 'calls', line: ln });
				return;
			}
			const toFile = resolveName(callee, receiverBinding);
			if (!toFile) return;
			if (here && toFile === filePath && here.name === callee && here.kind === 'function') { /* recursion: keep but it is rarely useful */ }
			add({ fromFile: filePath, fromSymbol: here?.qualified ?? null, toName: callee, toFile, edgeType: isNew ? 'instantiates' : 'calls', line: ln });
		};
		let m: RegExpExecArray | null;
		MEMBER_CALL.lastIndex = 0;
		const memberSpans: [number, number][] = [];
		while ((m = MEMBER_CALL.exec(l)) !== null) { memberSpans.push([m.index, m.index + m[0].length]); consider(m[1], /\bnew\s+$/.test(l.slice(0, m.index)), m.index); }
		IDENT_CALL.lastIndex = 0;
		while ((m = IDENT_CALL.exec(l)) !== null) {
			const start = m.index;
			if (memberSpans.some(([a, b]) => start >= a && start < b)) {
				// the member regex already handled `a.b(`; but `a.b(` also matches `b(` here — skip
				continue;
			}
			consider(m[1], m[0].startsWith('new'), start + (m[0].startsWith('new') ? m[0].indexOf(m[1]) : 0));
		}
	}

	return edges;
}

// ── neighbourhood formatting ────────────────────────────────────────────────

export type SymbolNeighborhood = {
	filePath: string;
	symbol?: string;
	/** Edges whose target is in this file (or this symbol). */
	inbound: SymbolEdge[];
	/** Edges from this file (or symbol) to definitions elsewhere. */
	outbound: SymbolEdge[];
	imports: string[];
	importedBy: string[];
};

const VERB: Record<SymbolEdgeType, [string, string]> = {
	calls: ['called by', 'calls'], instantiates: ['instantiated by', 'instantiates'],
	extends: ['extended by', 'extends'], implements: ['implemented by', 'implements'], imports: ['imported by', 'imports'],
};

/** Compact, prompt-ready description of the one-hop neighbourhood (≤ maxChars). */
export function formatNeighborhood(n: SymbolNeighborhood, maxChars = 1_800): string {
	const lines: string[] = [];
	const subject = n.symbol ? `${n.symbol} (${n.filePath})` : n.filePath;
	const inbound = n.inbound.filter(e => e.fromFile !== n.filePath);
	const outbound = n.outbound.filter(e => e.toFile && e.toFile !== n.filePath);
	if (!inbound.length && !outbound.length && !n.importedBy.length) return `${subject}: no dependents or dependencies found in the index.`;
	lines.push(`Dependents and dependencies of ${subject} (one hop):`);
	if (inbound.length) {
		const byTarget = new Map<string, Map<string, SymbolEdge[]>>();
		for (const e of inbound) {
			const t = byTarget.get(e.toName) ?? new Map<string, SymbolEdge[]>();
			const list = t.get(e.edgeType) ?? [];
			list.push(e); t.set(e.edgeType, list); byTarget.set(e.toName, t);
		}
		for (const [name, kinds] of byTarget) {
			for (const [kind, list] of kinds) {
				const sites = list.slice(0, 6).map(e => `${e.fromFile}:${e.line}${e.fromSymbol ? ` (${e.fromSymbol})` : ''}`);
				lines.push(`- ${name} ${VERB[kind as SymbolEdgeType][0]} ${sites.join(', ')}${list.length > 6 ? ` … +${list.length - 6}` : ''}`);
			}
		}
	} else if (n.importedBy.length) {
		lines.push(`- imported by ${n.importedBy.slice(0, 8).join(', ')}${n.importedBy.length > 8 ? ` … +${n.importedBy.length - 8}` : ''}`);
	}
	if (outbound.length) {
		const byFile = new Map<string, Set<string>>();
		for (const e of outbound) { const s = byFile.get(e.toFile!) ?? new Set<string>(); s.add(e.toName); byFile.set(e.toFile!, s); }
		lines.push(`- uses: ${[...byFile].slice(0, 8).map(([f, names]) => `${[...names].slice(0, 5).join(', ')} from ${f}`).join('; ')}`);
	}
	let text = lines.join('\n');
	if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
	return text;
}
