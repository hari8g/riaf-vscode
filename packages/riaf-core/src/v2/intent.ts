/**
 * Pillar 2, step 1 — intent parsing. Deterministic and fast: a weighted lexicon picks the task type,
 * regexes pull entities, constraints and acceptance criteria. Entities are validated later against
 * the index by the compiler (`resolveEntities`).
 */
export type IntentType = 'bugfix' | 'feature' | 'refactor' | 'explain' | 'test' | 'migrate' | 'review';

export interface IntentEntity {
	kind: 'file' | 'symbol' | 'error' | 'ticket' | 'term';
	value: string;
	/** Set by the compiler when the entity resolved against the index. */
	resolved?: string[];
}

export interface ParsedIntent {
	type: IntentType;
	confidence: number;
	summary: string;
	entities: IntentEntity[];
	constraints: string[];
	acceptance: string[];
	open_questions: string[];
	/** Free-text retrieval terms (identifiers split, stop words removed). */
	terms: string[];
}

const TYPE_LEXICON: Record<IntentType, RegExp[]> = {
	bugfix: [/\b(fix|bug|broken|crash\w*|error|exception|fail\w*|regression|wrong|incorrect|doesn'?t work|not working|issue|npe|stack ?trace|throws?)\b/i],
	feature: [/\b(add|implement|support|introduce|create|new|build|enable|allow|feature)\b/i],
	refactor: [/\b(refactor|rename|extract|move|split|clean ?up|simplify|restructure|deduplicate|decouple|reorgani[sz]e)\b/i],
	explain: [/\b(explain|how does|how do|what does|what is|why does|why is|where is|where are|understand|walk me through|overview|describe)\b/i, /\?\s*$/],
	test: [/\b(tests?|unit test|coverage|spec|test case|e2e|integration test)\b/i],
	migrate: [/\b(migrat\w*|upgrade|port|bump|update (to|from)|move (to|from)|replace \w+ with|deprecat\w*|version)\b/i],
	review: [/\b(review|audit|check|assess|look over|critique|pr\b|pull request|merge request|diff)\b/i],
};

const TYPE_PRIORITY: IntentType[] = ['bugfix', 'migrate', 'refactor', 'test', 'review', 'feature', 'explain'];

const STOP = new Set(('a an and are as at be but by can could do does for from has have how i in into is it its me my of on or our please should so that the their then there these this to us want we what when where which who why will with would you your make get use need fix add change update code file files function method class').split(' '));

const FILE_RE = /(?:^|[\s`'"(\[])((?:\.{0,2}\/)?(?:[\w@.-]+\/)*[\w@.-]+\.(?:tsx?|jsx?|mjs|cjs|py|java|kt|kts|go|rs|c|cc|cpp|h|hpp|cs|rb|php|swift|scala|vue|svelte|json|ya?ml|toml|xml|gradle|md|sql|sh|tf|properties))(?::(\d+)(?:-(\d+))?)?(?=$|[\s`'",)\]:])/g;
const SYMBOL_RE = /(?:^|[\s`'"(])((?:[A-Za-z_$][\w$]*\.)*(?:[A-Z][a-z0-9]+[A-Z]\w*|[a-z][a-z0-9]*[A-Z]\w*|[A-Z][A-Z0-9]*_[A-Z0-9_]+|[a-z][a-z0-9]*_[a-z0-9_]+|[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+))(?:\(\))?(?=$|[\s`'",.)?:;])/g;
const BACKTICK_RE = /`([^`\n]{2,80})`/g;
const ERROR_RE = /(?:"([^"\n]{8,200})"|'([^'\n]{8,200})'|\b((?:[A-Z]\w*(?:Error|Exception))(?::[^\n]{0,160})?))/g;
const TICKET_RE = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b|(?:^|\s)(#\d{1,6})\b/g;

const CONSTRAINT_RE = /(?:^|[.;,\n]\s*|\b(?:but|and)\s+)((?:do not|don't|dont|never|must not|mustn't|without|avoid|keep|preserve|only|no (?:changes?|new)|leave)\b[^.;\n]*)/gi;
const ACCEPT_RE = /(?:^|[.;,\n]\s*)((?:it |this |the \w+ )?(?:should|must|needs? to|so that|expect(?:ed)?|ensure|make sure|acceptance:?)\b[^.;\n]*)/gi;

export function splitIdentifier(id: string): string[] {
	return id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[\s_.$\-/]+/).map(s => s.toLowerCase()).filter(Boolean);
}

export function parseIntent(request: string, extra: { activeFile?: string; selection?: string } = {}): ParsedIntent {
	const text = request.trim();
	const entities: IntentEntity[] = [];
	const seen = new Set<string>();
	const add = (kind: IntentEntity['kind'], value: string) => {
		const v = value.trim().replace(/^\.\//, '');
		const key = `${kind}:${v}`;
		if (!v || seen.has(key)) return;
		seen.add(key); entities.push({ kind, value: v });
	};

	for (const m of text.matchAll(FILE_RE)) add('file', m[1] + (m[2] ? `:${m[2]}${m[3] ? `-${m[3]}` : ''}` : ''));
	if (extra.activeFile) add('file', extra.activeFile);
	const fileValues = new Set(entities.filter(e => e.kind === 'file').map(e => e.value.replace(/:.*$/, '')));
	for (const m of text.matchAll(TICKET_RE)) add('ticket', m[1] ?? m[2]);
	for (const m of text.matchAll(ERROR_RE)) {
		const v = m[1] ?? m[2] ?? m[3];
		if (v && !fileValues.has(v) && (/\s/.test(v) || /(Error|Exception)/.test(v))) add('error', v);
	}
	// stack-trace frames: "at foo (src/x.ts:12:3)" / File "x.py", line 3
	for (const m of text.matchAll(/at [\w$.<>]+ \(([^():\s]+):(\d+)(?::\d+)?\)/g)) add('file', `${m[1]}:${m[2]}`);
	for (const m of text.matchAll(/File "([^"]+)", line (\d+)/g)) add('file', `${m[1]}:${m[2]}`);
	for (const m of text.matchAll(BACKTICK_RE)) {
		const v = m[1].trim();
		if (/^[\w$.]+(\(\))?$/.test(v) && !fileValues.has(v) && !/\.\w{1,5}$/.test(v)) add('symbol', v.replace(/\(\)$/, ''));
	}
	for (const m of text.matchAll(SYMBOL_RE)) {
		const v = m[1];
		if (fileValues.has(v) || /\.(tsx?|jsx?|py|java|go|rs|md|json)$/.test(v)) continue;
		if (/^(TODO|FIXME|README|JSON|HTTP|HTTPS|API|URL|CI|PR)$/.test(v)) continue;
		add('symbol', v);
	}
	if (extra.selection) for (const m of extra.selection.matchAll(/\b(?:function|class|interface|def|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add('symbol', m[1]);

	// Type scoring.
	const scores = new Map<IntentType, number>();
	for (const t of TYPE_PRIORITY) {
		let s = 0;
		for (const re of TYPE_LEXICON[t]) { const hits = text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')); if (hits) s += hits.length; }
		if (t === 'bugfix' && entities.some(e => e.kind === 'error')) s += 2;
		if (t === 'explain' && /^(how|what|why|where|which|explain|describe)\b/i.test(text)) s += 1.5;
		if (t === 'test' && /\b(write|add|create|missing)\b[^.]*\btests?\b/i.test(text)) s += 1.5;
		if (t === 'migrate' && /\bfrom\b[^.]*\bto\b/i.test(text) && /\b(migrat|upgrad|port|mov)/i.test(text)) s += 1.5;
		scores.set(t, s);
	}
	const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || TYPE_PRIORITY.indexOf(a[0]) - TYPE_PRIORITY.indexOf(b[0]));
	const [bestType, best] = ranked[0];
	const second = ranked[1]?.[1] ?? 0;
	const type: IntentType = best === 0 ? (/\?\s*$/.test(text) ? 'explain' : 'feature') : bestType;
	const confidence = best === 0 ? 0.3 : Math.min(1, 0.5 + (best - second) / (best + 1) * 0.5);

	const constraints = [...text.matchAll(CONSTRAINT_RE)].map(m => m[1].trim().replace(/\s+/g, ' ')).filter(s => s.length > 6);
	const acceptance = [...text.matchAll(ACCEPT_RE)].map(m => m[1].trim().replace(/\s+/g, ' ')).filter(s => s.length > 8 && !constraints.includes(s));

	const terms = new Set<string>();
	for (const e of entities) {
		if (e.kind === 'symbol') { terms.add(e.value.split('.').pop()!); for (const p of splitIdentifier(e.value)) if (!STOP.has(p) && p.length > 2) terms.add(p); }
		if (e.kind === 'file') { const base = e.value.replace(/:.*$/, '').split('/').pop()!.replace(/\.\w+$/, ''); for (const p of splitIdentifier(base)) if (!STOP.has(p) && p.length > 2) terms.add(p); }
		if (e.kind === 'ticket') terms.add(e.value);
	}
	for (const w of text.replace(/`[^`]*`/g, ' ').split(/[^A-Za-z0-9_]+/)) {
		const lw = w.toLowerCase();
		if (lw.length > 2 && !STOP.has(lw) && !/^\d+$/.test(lw)) terms.add(lw);
	}

	const open_questions: string[] = [];
	const concrete = entities.filter(e => e.kind !== 'term').length;
	if (!concrete && confidence < 0.6 && text.split(/\s+/).length < 6) open_questions.push('Which file, symbol or behaviour does this request refer to?');
	if (type === 'bugfix' && !entities.some(e => e.kind === 'error') && !/\b(when|after|if|steps?)\b/i.test(text)) open_questions.push('What is the observed vs expected behaviour (error message or reproduction steps)?');
	if (type === 'migrate' && !/\bto\b/i.test(text)) open_questions.push('What is the target version or technology of the migration?');

	const firstSentence = text.split(/(?<=[.!?])\s|\n/)[0].slice(0, 200);
	return { type, confidence: Math.round(confidence * 100) / 100, summary: firstSentence, entities, constraints, acceptance, open_questions, terms: [...terms].slice(0, 24) };
}
