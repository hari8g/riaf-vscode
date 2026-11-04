/**
 * Content-addressed tool cache: key = sha256(tool, normalised args); every entry records the blob hashes
 * of the files it depends on (or the tree version for searches) and is served only while they still match.
 */
import { createHash } from 'node:crypto';
import type { CacheEntry, CacheStore } from './types.js';

export function normaliseArgs(args: Record<string, unknown>): string {
	const sort = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(sort);
		if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().filter(k => (v as Record<string, unknown>)[k] !== undefined && k !== 'description').map(k => [k, sort((v as Record<string, unknown>)[k])]));
		if (typeof v === 'string') return v.trim();
		return v;
	};
	return JSON.stringify(sort(args));
}

export const cacheKey = (tool: string, argsNorm: string): string => createHash('sha256').update(`${tool}\u0000${argsNorm}`).digest('hex').slice(0, 32);

export class ToolCache {
	private readonly entries = new Map<string, CacheEntry>();

	constructor(private readonly store?: CacheStore, private readonly maxEntries = 2_000) {
		if (store) for (const e of store.load()) this.entries.set(e.key, e);
	}

	get size(): number { return this.entries.size; }

	/** Return the entry if every dependency still has the recorded hash. Stale entries are evicted. */
	get(key: string, currentHash: (dep: string) => string | null): CacheEntry | undefined {
		const e = this.entries.get(key);
		if (!e) return undefined;
		for (const [dep, hash] of Object.entries(e.blobs)) {
			if (currentHash(dep) !== hash) { this.delete([key]); return undefined; }
		}
		return e;
	}

	put(e: CacheEntry): void {
		this.entries.delete(e.key);
		this.entries.set(e.key, e);
		if (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value as string;
			this.delete([oldest]);
		}
		try { this.store?.put(e); } catch { /* persistence is best-effort */ }
	}

	delete(keys: string[]): void {
		for (const k of keys) this.entries.delete(k);
		try { this.store?.delete(keys); } catch { /* ignore */ }
	}

	/** Drop every entry that depends on one of `paths` or on the tree version. */
	invalidate(paths: string[]): number {
		const set = new Set(paths);
		const gone = [...this.entries.values()].filter(e => Object.keys(e.blobs).some(d => d === '*' || set.has(d))).map(e => e.key);
		this.delete(gone);
		return gone.length;
	}
}
