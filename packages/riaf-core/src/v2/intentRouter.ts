/**
 * Intent router — turns a request into a route the hosts act on *before* any agent loop starts.
 *
 *   tier 1  parseIntent (lexicon + regex, offline, < 5 ms)            — always
 *   tier 2  LLM arbiter (one small, cacheable call)                   — only when tier 1 is unsure or the request is multi-intent
 *   tier 3  per-repo feedback lexicon (.riaf/intent-feedback.jsonl)   — corrections developers made on earlier routes
 *
 * The route decides agent mode, tool set, pack budget, pack stage, whether a plan gate applies and
 * whether to ask the parser's open questions instead of starting. An explicit slash command always wins.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { INTENT_TYPES, intentTypeScores, parseIntent, splitIdentifier, type IntentType, type ParsedIntent } from './intent.js';

export type RouteMode = 'agent' | 'plan' | 'explain' | 'verify';
export type RouteTools = 'read-only' | 'full' | 'read-only-then-full';
export type RouteStage = 'explore' | 'plan' | 'implement' | 'verify';
export type RouteSource = 'command' | 'lexicon' | 'arbiter' | 'feedback';

export interface RouteRule {
	mode: RouteMode;
	tools: RouteTools;
	budget: number;
	stage: RouteStage;
	/** Show the plan and wait for approval before edits (feature / migrate by default). */
	planGate: boolean;
	note: string;
}

/** Routing table (framework §Design A). Budgets are pack token budgets, not model context sizes. */
export const ROUTING_TABLE: Record<IntentType, RouteRule> = {
	explain: { mode: 'explain', tools: 'read-only', budget: 8_000, stage: 'explore', planGate: false, note: 'answer with path:line citations; never edits' },
	review: { mode: 'explain', tools: 'read-only', budget: 12_000, stage: 'explore', planGate: false, note: 'seed from the diff / MR, not the prompt text' },
	bugfix: { mode: 'agent', tools: 'full', budget: 16_000, stage: 'plan', planGate: false, note: 'error entities weighted 1.5; verification forced on' },
	test: { mode: 'agent', tools: 'full', budget: 12_000, stage: 'implement', planGate: false, note: 'covering tests prior 1.0' },
	feature: { mode: 'agent', tools: 'read-only-then-full', budget: 16_000, stage: 'plan', planGate: true, note: 'plan shown and approved before edits' },
	refactor: { mode: 'agent', tools: 'full', budget: 20_000, stage: 'plan', planGate: false, note: 'callers of changed symbols pinned into the pack' },
	migrate: { mode: 'agent', tools: 'read-only-then-full', budget: 24_000, stage: 'plan', planGate: true, note: 'manifests weighted 1.0; decisions block mandatory' },
};

/** Below this (after every tier) the host asks the open questions instead of starting a loop. */
export const ASK_THRESHOLD = 0.45;
/** Below this tier 1 hands over to the arbiter. */
export const ARBITER_THRESHOLD = 0.6;

export interface IntentRoute {
	intent: ParsedIntent;
	type: IntentType;
	secondaryType?: IntentType;
	confidence: number;
	source: RouteSource;
	mode: RouteMode;
	tools: RouteTools;
	budget: number;
	stage: RouteStage;
	planGate: boolean;
	/** True when the host should ask `questions` and stop. */
	askFirst: boolean;
	questions: string[];
	/** Path prefix the arbiter or feedback narrowed the task to. */
	scope?: string;
	arbiter?: { used: boolean; ms?: number; error?: string };
}

export interface ArbiterResult {
	type: IntentType;
	secondary_type?: IntentType;
	confidence: number;
	scope_paths?: string[];
	clarify?: string;
}

export interface RouteOptions {
	activeFile?: string;
	selection?: string;
	/** Explicit slash command (`plan` | `explain` | `verify` | …); wins over the classifier. */
	command?: string;
	/** Tier-2 arbiter: (system, user) → model text. Absent = tier 1 only. */
	classify?: (system: string, user: string) => Promise<string>;
	/** Short architecture summary given to the arbiter (never file contents). */
	architectureSummary?: string;
	/** Repo root for the feedback lexicon. */
	root?: string;
	timeoutMs?: number;
	/** Force the arbiter even when tier 1 is confident (evaluation). */
	alwaysArbiter?: boolean;
	/** Per-type overrides of the routing table (from settings). */
	rules?: Partial<Record<IntentType, Partial<RouteRule>>>;
}

const COMMAND_TO_TYPE: Record<string, IntentType> = { plan: 'feature', explain: 'explain', verify: 'test', review: 'review' };
const COMMAND_TO_MODE: Record<string, RouteMode> = { plan: 'plan', explain: 'explain', verify: 'verify' };

/** Imperative clauses joined by "and"/"then"/";" that hit different lexicons mark a multi-intent request. */
export function isMultiIntent(text: string): { multi: boolean; types: IntentType[] } {
	const clauses = text.split(/\s*(?:;|\bthen\b|\band (?:also |then )?(?=\w)|\n)\s*/i).map(c => c.trim()).filter(c => c.split(/\s+/).length >= 2);
	const types = new Set<IntentType>();
	for (const c of clauses) {
		const scores = intentTypeScores(c);
		const best = INTENT_TYPES.map(t => [t, scores[t]] as const).sort((a, b) => b[1] - a[1])[0];
		if (best && best[1] > 0) types.add(best[0]);
	}
	return { multi: types.size >= 2, types: [...types] };
}

export function needsArbiter(intent: ParsedIntent, text: string): boolean {
	if (intent.confidence < ARBITER_THRESHOLD) return true;
	const scores = intentTypeScores(text);
	const ranked = INTENT_TYPES.map(t => scores[t]).sort((a, b) => b - a);
	if (ranked[0] > 0 && ranked[1] > 0 && ranked[0] - ranked[1] <= 1) return true;
	// One keyword and nothing concrete (no file, symbol, error or ticket) is a guess, not a classification.
	if (ranked[0] <= 1 && !intent.entities.some(e => e.kind !== 'term')) return true;
	return isMultiIntent(text).multi;
}

export const ARBITER_SYSTEM = [
	'You classify a software task for a repository assistant. Reply with ONE JSON object and nothing else:',
	'{"type": one of bugfix|feature|refactor|explain|test|migrate|review, "secondary_type"?: same set, "confidence": 0..1, "scope_paths"?: [path prefixes], "clarify"?: one question if the task is too vague to start}',
	'Rules: "type" is what the developer wants done first. Prefer bugfix when an error or wrong behaviour is described, explain when they ask how/why/where, review for diffs/MRs/audits, migrate for version or technology changes. Do not invent paths; only use ones that appear in the request or the architecture summary.',
].join('\n');

export function parseArbiter(text: string): ArbiterResult | null {
	const m = text.match(/\{[\s\S]*\}/);
	if (!m) return null;
	let j: Record<string, unknown>;
	try { j = JSON.parse(m[0]); } catch { return null; }
	const type = String(j.type ?? '').toLowerCase() as IntentType;
	if (!INTENT_TYPES.includes(type)) return null;
	const sec = typeof j.secondary_type === 'string' ? j.secondary_type.toLowerCase() as IntentType : undefined;
	const conf = Number(j.confidence);
	const paths = Array.isArray(j.scope_paths) ? j.scope_paths.filter((p): p is string => typeof p === 'string' && /^[\w@./-]+$/.test(p) && !/(^|\/)\.\.(\/|$)/.test(p)).slice(0, 4) : undefined;
	return { type, secondary_type: sec && INTENT_TYPES.includes(sec) && sec !== type ? sec : undefined, confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.7, scope_paths: paths?.length ? paths : undefined, clarify: typeof j.clarify === 'string' && j.clarify.trim() ? j.clarify.trim().slice(0, 300) : undefined };
}

/* ───────────────────────── feedback lexicon (tier 3) ───────────────────────── */

export const FEEDBACK_FILE = join('.riaf', 'intent-feedback.jsonl');

export interface IntentFeedback { ts: number; request: string; predicted: IntentType; corrected: IntentType }

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function recordIntentFeedback(root: string, fb: Omit<IntentFeedback, 'ts'>): void {
	mkdirSync(join(root, '.riaf'), { recursive: true });
	appendFileSync(join(root, FEEDBACK_FILE), JSON.stringify({ ts: Date.now(), ...fb }) + '\n');
}

export function loadIntentFeedback(root: string): IntentFeedback[] {
	const p = join(root, FEEDBACK_FILE);
	if (!existsSync(p)) return [];
	return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) as IntentFeedback; } catch { return null; } }).filter((x): x is IntentFeedback => !!x && INTENT_TYPES.includes(x.corrected));
}

/** Exact-request match → corrected type; otherwise term votes (≥ 2 shared distinctive terms, majority type). */
export function feedbackVote(feedback: IntentFeedback[], request: string): { type: IntentType; strength: number } | null {
	if (!feedback.length) return null;
	const n = norm(request);
	const exact = [...feedback].reverse().find(f => norm(f.request) === n);
	if (exact) return { type: exact.corrected, strength: 1 };
	const terms = new Set(n.split(/[^a-z0-9_]+/).flatMap(w => splitIdentifier(w)).filter(w => w.length >= 4));
	const votes = new Map<IntentType, number>();
	for (const f of feedback) {
		const ft = new Set(norm(f.request).split(/[^a-z0-9_]+/).flatMap(w => splitIdentifier(w)).filter(w => w.length >= 4));
		let shared = 0;
		for (const t of terms) if (ft.has(t)) shared++;
		if (shared >= 2) votes.set(f.corrected, (votes.get(f.corrected) ?? 0) + shared);
	}
	const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
	return best ? { type: best[0], strength: Math.min(0.9, 0.5 + best[1] * 0.1) } : null;
}

/* ───────────────────────── the router ───────────────────────── */

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`arbiter timed out after ${ms} ms`)), ms); p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); }); });
}

export async function routeIntent(request: string, opts: RouteOptions = {}): Promise<IntentRoute> {
	const text = request.trim();
	const intent = parseIntent(text, { activeFile: opts.activeFile, selection: opts.selection });
	let type = intent.type;
	let confidence = intent.confidence;
	let source: RouteSource = 'lexicon';
	let secondaryType: IntentType | undefined;
	let scope: string | undefined;
	const questions = [...intent.open_questions];
	let arbiter: IntentRoute['arbiter'];

	// Explicit command wins.
	const cmd = opts.command?.replace(/^\//, '');
	if (cmd && COMMAND_TO_TYPE[cmd]) {
		type = cmd === 'plan' || cmd === 'verify' ? (intent.confidence >= ARBITER_THRESHOLD ? intent.type : COMMAND_TO_TYPE[cmd]) : COMMAND_TO_TYPE[cmd];
		confidence = 1; source = 'command';
	} else {
		// Tier 3 first: a developer correction on this repo beats both other tiers.
		const fb = opts.root ? feedbackVote(loadIntentFeedback(opts.root), text) : null;
		if (fb && fb.strength >= 0.7) { type = fb.type; confidence = Math.max(confidence, fb.strength); source = 'feedback'; }
		else if (opts.classify && (opts.alwaysArbiter || needsArbiter(intent, text))) {
			const t0 = Date.now();
			const user = [
				`Request: ${text.slice(0, 1_500)}`,
				opts.activeFile ? `Active file: ${opts.activeFile}` : '',
				`Tier-1 guess: ${intent.type} (confidence ${intent.confidence}); entities: ${intent.entities.map(e => `${e.kind}:${e.value}`).slice(0, 8).join(', ') || 'none'}`,
				opts.architectureSummary ? `Architecture: ${opts.architectureSummary.slice(0, 600)}` : '',
			].filter(Boolean).join('\n');
			try {
				const out = await withTimeout(opts.classify(ARBITER_SYSTEM, user), opts.timeoutMs ?? 1_500);
				const r = parseArbiter(out);
				arbiter = { used: true, ms: Date.now() - t0 };
				if (r) {
					type = r.type; secondaryType = r.secondary_type; source = 'arbiter';
					// Blend: the arbiter saw more, but never fully trust it when it disagrees with a confident lexicon.
					confidence = r.type === intent.type ? Math.max(intent.confidence, r.confidence) : Math.round(((r.confidence * 0.7) + (intent.confidence * 0.3)) * 100) / 100;
					scope = r.scope_paths?.[0];
					if (r.clarify && !questions.includes(r.clarify)) questions.unshift(r.clarify);
				} else arbiter.error = 'unparseable reply';
			} catch (e) { arbiter = { used: false, ms: Date.now() - t0, error: String((e as Error).message ?? e) }; }
			if (fb) { // weak feedback still nudges
				if (fb.type === type) confidence = Math.min(1, confidence + 0.1);
			}
		} else if (fb && fb.type === type) confidence = Math.min(1, confidence + 0.1);
		if (!secondaryType) { const mi = isMultiIntent(text); if (mi.multi) secondaryType = mi.types.find(t => t !== type); }
	}

	const rule = { ...ROUTING_TABLE[type], ...(opts.rules?.[type] ?? {}) };
	const mode: RouteMode = cmd && COMMAND_TO_MODE[cmd] ? COMMAND_TO_MODE[cmd] : rule.mode;
	// Thin request: no concrete entity, fewer than five words → the parser's questions are worth more than a guess.
	const thin = text.split(/\s+/).length < 5 && !intent.entities.some(e => e.kind !== 'term');
	const askFirst = source !== 'command' && questions.length > 0 && (confidence < ASK_THRESHOLD || thin);
	return {
		intent: { ...intent, type, confidence },
		type, secondaryType, confidence: Math.round(confidence * 100) / 100, source,
		mode, tools: mode === 'plan' || mode === 'explain' ? 'read-only' : rule.tools, budget: rule.budget, stage: rule.stage,
		planGate: source === 'command' ? false : rule.planGate,
		askFirst, questions, scope, arbiter,
	};
}

/** One-line echo for chat / logs: `Intent: bugfix (0.82, lexicon) · entities: OrderService, NullPointerException · plan-gated`. */
export function formatRouteLine(r: IntentRoute, extra: { items?: number; tokens?: number } = {}): string {
	const ents = r.intent.entities.filter(e => e.kind !== 'term').slice(0, 4).map(e => e.value).join(', ');
	return [
		`Intent: ${r.type}${r.secondaryType ? ` + ${r.secondaryType}` : ''} (${r.confidence}, ${r.source})`,
		ents ? `entities: ${ents}` : '',
		r.scope ? `scope: ${r.scope}` : '',
		`mode: ${r.mode}${r.planGate ? ', plan-gated' : ''}`,
		extra.items !== undefined ? `pack: ${extra.items} items / ${((extra.tokens ?? 0) / 1000).toFixed(1)}k tokens` : `budget: ${(r.budget / 1000).toFixed(0)}k`,
	].filter(Boolean).join(' · ');
}
