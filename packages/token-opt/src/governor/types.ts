/** Host-agnostic types for the tool-call governor (RIAF 2.0 Pillar 3). */
import type { Phase } from './policy.js';

/** A proposed tool call, normalised from the host's shape (Claude Code, Copilot LM tools, RIAF's own loop). */
export interface ToolCall {
	tool: string;
	args: Record<string, unknown>;
	sessionId?: string;
}

export type CallClass = 'read' | 'search' | 'list' | 'shell-read' | 'shell' | 'test' | 'write' | 'other';

export type ServeSource = 'session' | 'pack' | 'cache' | 'loop';

export type GuardDecision =
	| { decision: 'serve'; content: string; source: ServeSource; note: string; tokens: number }
	| { decision: 'allow'; note?: string; prefetch?: PrefetchItem[] }
	| { decision: 'block'; reason: string };

export interface PrefetchItem { path: string; reason: string; content: string }

/** What the governor needs from the index / filesystem. Implemented by hosts (riaf-mcp wires it to Riaf2). */
export interface GovernorBackend {
	/** Current content hash of a workspace-relative file, or null when missing. */
	blobHash(path: string): string | null;
	readFile(path: string): string | null;
	/** Opaque version of the working tree (changes whenever any indexed file changes). */
	treeVersion(): string;
	/** Files worth fetching with `path`: co-change partners (coupling ≥ minCoupling), tests, direct imports. */
	prefetchCandidates?(path: string, minCoupling: number): Promise<{ path: string; reason: string }[]> | { path: string; reason: string }[];
	/** Compact representation of a prefetched file (outline / summary, not the body). */
	outline?(path: string): Promise<string> | string;
	/** Called after the agent wrote files: re-index incrementally, refresh pack items. */
	onWrite?(paths: string[]): Promise<void> | void;
	/** Normalise an absolute or relative path to workspace-relative (forward slashes). */
	relative(path: string): string;
}

export interface CacheEntry {
	key: string;
	tool: string;
	argsNorm: string;
	/** path → blob hash, for entries about specific files; `*` → tree version for searches. */
	blobs: Record<string, string>;
	result: string;
	ts: number;
}

/** Persistence port for the tool cache (riaf-mcp stores it in the `tool_cache` table). */
export interface CacheStore {
	load(): CacheEntry[];
	put(entry: CacheEntry): void;
	delete(keys: string[]): void;
}

/** Facts the current Context Pack already provides (subset of the pack's `known_facts`). */
export interface KnownFacts {
	files_read: { path: string; blob?: string }[];
	ranges_read?: { path: string; range: [number, number]; blob?: string }[];
	files_listed: string[];
	symbols_resolved?: { name: string; path: string; line: number }[];
}

export interface GovernorCounters {
	proposed: number;
	served: number;
	servedBy: Record<ServeSource, number>;
	executed: number;
	blocked: number;
	repeats: number;
	loops: number;
	writes: number;
	tokensServed: number;
	tokensExecuted: number;
	cacheHits: number;
	cacheMisses: number;
	prefetchIssued: number;
	prefetchUsed: number;
	reflections: number;
	byPhase: Record<Phase, { calls: number; tokens: number; startedAt: number }>;
}

export interface GovernorMetrics extends GovernorCounters {
	sessionId: string;
	host: string;
	phase: Phase;
	startedAt: number;
	/** (served + blocked repeats) / proposed */
	callsAvoidedRate: number;
	/** tokensServed / (tokensServed + tokensExecuted) */
	tokensSavedRate: number;
	cacheHitRate: number;
	prefetchPrecision: number;
}
