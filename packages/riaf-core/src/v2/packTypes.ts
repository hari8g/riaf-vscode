/** Context Pack schema v1 — the portable output of the compiler (framework §Pillar 2). */
import type { IntentEntity, IntentType } from './intent.js';

export const PACK_SCHEMA_VERSION = 'riaf.pack/v1';

export type PackItemKind = 'symbol' | 'file' | 'summary' | 'history_card' | 'decision' | 'test' | 'manifest';
export type PackItemForm = 'body' | 'signatures' | 'summary';

export interface PackItem {
	kind: PackItemKind;
	path: string;
	range?: [number, number];
	blob?: string;
	form?: PackItemForm;
	content: string;
	score: number;
	tokens: number;
	why: string;
}

export interface ContextPack {
	schema: typeof PACK_SCHEMA_VERSION;
	pack_id: string;
	repo: { root: string; head: string | null; branch?: string; index_version: string };
	intent: { type: IntentType; summary: string; request: string; entities: IntentEntity[]; constraints: string[]; acceptance: string[]; open_questions: string[]; confidence: number };
	budget: { max_tokens: number; used_tokens: number; model_hint: string };
	conventions: { languages: string[]; frameworks: string[]; build: string; test_cmd: string; lint: string; typecheck?: string; style_notes: string[] };
	architecture: { packages: { name: string; path: string; kind: string }[]; entry_points: string[]; summary: string; monorepo?: string };
	items: PackItem[];
	history: {
		related_commits: { sha: string; date: string; intent: string; why: string; tickets: string[] }[];
		owners: { path: string; role: string; share: number; name?: string }[];
		hotspots: { path: string; commits365: number; fixRatio: number }[];
		decisions: { source: string; ref: string; text: string }[];
	};
	plan_skeleton: string[];
	verification: string[];
	known_facts: {
		files_listed: string[];
		/** Files whose full content is in the pack (path → blob hash). */
		files_read: { path: string; blob?: string }[];
		/** Partial reads (path, range) present in the pack. */
		ranges_read: { path: string; range: [number, number]; blob?: string }[];
		symbols_resolved: { name: string; path: string; line: number }[];
	};
	provenance: { retrievers: Record<string, number>; ranker_version: string; generated_at: string; compile_ms: number; scope?: string; parent_pack?: string; stage?: string };
	diff?: { previous_pack: string; added: string[]; removed: string[] };
}

/** Lightweight structural validation (no external schema library). Returns problems, empty when valid. */
export function validatePack(p: unknown): string[] {
	const errs: string[] = [];
	const o = p as Record<string, unknown>;
	if (!o || typeof o !== 'object') return ['pack is not an object'];
	if (o.schema !== PACK_SCHEMA_VERSION) errs.push(`schema must be ${PACK_SCHEMA_VERSION}`);
	for (const k of ['pack_id', 'repo', 'intent', 'budget', 'conventions', 'architecture', 'items', 'history', 'plan_skeleton', 'verification', 'known_facts', 'provenance']) if (!(k in o)) errs.push(`missing ${k}`);
	const b = o.budget as ContextPack['budget'] | undefined;
	if (b && b.used_tokens > b.max_tokens) errs.push(`used_tokens ${b.used_tokens} exceeds max_tokens ${b.max_tokens}`);
	if (Array.isArray(o.items)) (o.items as PackItem[]).forEach((it, i) => {
		if (!it.path || typeof it.content !== 'string' || typeof it.why !== 'string' || !it.why) errs.push(`items[${i}] needs path, content and why`);
	});
	return errs;
}
