/**
 * Pure-TypeScript HNSW (Hierarchical Navigable Small World) index for cosine similarity.
 *
 * Vectors are L2-normalised on insert so cosine similarity is a dot product. The structure is
 * in-memory and rebuilt from the embeddings table when an index opens; inserts and removals are
 * incremental so the watcher keeps it current without a rebuild. Sized for repositories
 * (10^4–10^5 chunks): no dependencies, ~O(log n) queries, deterministic given a seed.
 */

export type HnswOptions = {
	/** Max neighbours per node on upper layers (default 16); layer 0 keeps 2·M. */
	M?: number;
	/** Candidate list size while building (default 200). */
	efConstruction?: number;
	/** Default candidate list size while searching (default 64; raised to k when k is larger). */
	efSearch?: number;
	/** Seed for the level generator (tests). */
	seed?: number;
};

export type HnswHit = { id: number; score: number };

type Node = { vec: Float32Array; neighbors: number[][]; deleted: boolean };

const normalise = (v: ArrayLike<number>): Float32Array => {
	const out = new Float32Array(v.length);
	let norm = 0;
	for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
	norm = Math.sqrt(norm) || 1;
	for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
	return out;
};

const dot = (a: Float32Array, b: Float32Array): number => {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] * b[i];
	return s;
};

/** Small binary heap keyed by score. */
class Heap {
	private readonly a: HnswHit[] = [];
	constructor(private readonly less: (x: HnswHit, y: HnswHit) => boolean) { }
	get size(): number { return this.a.length; }
	peek(): HnswHit | undefined { return this.a[0]; }
	push(h: HnswHit): void {
		const a = this.a; a.push(h);
		let i = a.length - 1;
		while (i > 0) { const p = (i - 1) >> 1; if (this.less(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break; }
	}
	pop(): HnswHit | undefined {
		const a = this.a;
		if (!a.length) return undefined;
		const top = a[0];
		const last = a.pop()!;
		if (a.length) {
			a[0] = last;
			let i = 0;
			for (; ;) {
				const l = 2 * i + 1, r = l + 1;
				let m = i;
				if (l < a.length && this.less(a[l], a[m])) m = l;
				if (r < a.length && this.less(a[r], a[m])) m = r;
				if (m === i) break;
				[a[i], a[m]] = [a[m], a[i]]; i = m;
			}
		}
		return top;
	}
	toArray(): HnswHit[] { return [...this.a]; }
}

export class HnswIndex {
	private readonly M: number;
	private readonly M0: number;
	private readonly efConstruction: number;
	private readonly efSearch: number;
	private readonly mL: number;
	private readonly nodes = new Map<number, Node>();
	private entry = -1;
	private maxLevel = -1;
	private deletedCount = 0;
	private rng: () => number;
	/** Dimension of stored vectors (fixed by the first insert). */
	dimension = 0;

	constructor(opts: HnswOptions = {}) {
		this.M = Math.max(2, opts.M ?? 16);
		this.M0 = this.M * 2;
		this.efConstruction = Math.max(this.M, opts.efConstruction ?? 200);
		this.efSearch = Math.max(8, opts.efSearch ?? 64);
		this.mL = 1 / Math.log(this.M);
		let s = (opts.seed ?? 0x9e3779b9) >>> 0;
		this.rng = () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
	}

	/** Live vectors. */
	get size(): number { return this.nodes.size - this.deletedCount; }
	get deletedRatio(): number { return this.nodes.size ? this.deletedCount / this.nodes.size : 0; }
	has(id: number): boolean { const n = this.nodes.get(id); return !!n && !n.deleted; }

	/** Insert or replace a vector under `id`. */
	add(id: number, vector: ArrayLike<number>): void {
		if (this.nodes.has(id)) this.remove(id);
		const vec = normalise(vector);
		if (this.dimension === 0) this.dimension = vec.length;
		else if (vec.length !== this.dimension) throw new Error(`HNSW: dimension mismatch (${vec.length} vs ${this.dimension})`);
		const level = Math.floor(-Math.log(Math.max(this.rng(), 1e-12)) * this.mL);
		const node: Node = { vec, neighbors: Array.from({ length: level + 1 }, () => []), deleted: false };
		this.nodes.set(id, node);

		if (this.entry < 0) { this.entry = id; this.maxLevel = level; return; }

		let ep = this.entry;
		// greedy descent through the layers above the new node's level
		for (let l = this.maxLevel; l > level; l--) ep = this.greedy(vec, ep, l);
		// insert into each layer from min(level, maxLevel) down to 0
		for (let l = Math.min(level, this.maxLevel); l >= 0; l--) {
			const candidates = this.searchLayer(vec, ep, this.efConstruction, l, true);
			const max = l === 0 ? this.M0 : this.M;
			const selected = candidates.sort((a, b) => b.score - a.score).slice(0, max);
			node.neighbors[l] = selected.map(c => c.id);
			for (const c of selected) {
				const other = this.nodes.get(c.id)!;
				const list = other.neighbors[l];
				list.push(id);
				if (list.length > max) this.prune(other, l, max);
			}
			ep = selected[0]?.id ?? ep;
		}
		if (level > this.maxLevel) { this.maxLevel = level; this.entry = id; }
	}

	/** Mark `id` deleted; its slot is skipped by searches and freed on `rebuild()`. */
	remove(id: number): boolean {
		const n = this.nodes.get(id);
		if (!n || n.deleted) return false;
		n.deleted = true;
		this.deletedCount++;
		if (this.entry === id) this.entry = this.pickEntry();
		return true;
	}

	/** Top-k live vectors by cosine similarity (descending). */
	search(query: ArrayLike<number>, k: number, ef?: number): HnswHit[] {
		if (this.entry < 0 || k <= 0) return [];
		const q = normalise(query);
		if (q.length !== this.dimension) return [];
		let ep = this.entry;
		for (let l = this.maxLevel; l > 0; l--) ep = this.greedy(q, ep, l);
		const results = this.searchLayer(q, ep, Math.max(ef ?? this.efSearch, k), 0, false);
		return results.sort((a, b) => b.score - a.score).slice(0, k);
	}

	/** Drop deleted nodes and relink everything (call when `deletedRatio` grows). */
	rebuild(): void {
		const live = [...this.nodes.entries()].filter(([, n]) => !n.deleted);
		this.nodes.clear();
		this.entry = -1; this.maxLevel = -1; this.deletedCount = 0;
		for (const [id, n] of live) this.add(id, n.vec);
	}

	/** Snapshot of live ids (for reconciling with the store). */
	ids(): number[] { return [...this.nodes.entries()].filter(([, n]) => !n.deleted).map(([id]) => id); }

	private pickEntry(): number {
		let best = -1, bestLevel = -1;
		for (const [id, n] of this.nodes) {
			if (n.deleted) continue;
			if (n.neighbors.length - 1 > bestLevel) { bestLevel = n.neighbors.length - 1; best = id; }
		}
		this.maxLevel = bestLevel;
		return best;
	}

	private greedy(q: Float32Array, ep: number, level: number): number {
		let cur = ep;
		let curScore = dot(q, this.nodes.get(cur)!.vec);
		for (; ;) {
			let improved = false;
			for (const nb of this.nodes.get(cur)!.neighbors[level] ?? []) {
				const s = dot(q, this.nodes.get(nb)!.vec);
				if (s > curScore) { curScore = s; cur = nb; improved = true; }
			}
			if (!improved) return cur;
		}
	}

	/** Beam search on one layer; returns up to `ef` best (live unless includeDeleted) candidates. */
	private searchLayer(q: Float32Array, ep: number, ef: number, level: number, includeDeleted: boolean): HnswHit[] {
		const visited = new Set<number>([ep]);
		const epScore = dot(q, this.nodes.get(ep)!.vec);
		const candidates = new Heap((x, y) => x.score > y.score);   // max-heap by score
		const results = new Heap((x, y) => x.score < y.score);      // min-heap: worst result on top
		candidates.push({ id: ep, score: epScore });
		if (includeDeleted || !this.nodes.get(ep)!.deleted) results.push({ id: ep, score: epScore });
		while (candidates.size) {
			const c = candidates.pop()!;
			const worst = results.peek();
			if (worst && results.size >= ef && c.score < worst.score) break;
			for (const nb of this.nodes.get(c.id)!.neighbors[level] ?? []) {
				if (visited.has(nb)) continue;
				visited.add(nb);
				const node = this.nodes.get(nb)!;
				const s = dot(q, node.vec);
				const w = results.peek();
				if (results.size < ef || !w || s > w.score) {
					candidates.push({ id: nb, score: s });
					if (includeDeleted || !node.deleted) {
						results.push({ id: nb, score: s });
						if (results.size > ef) results.pop();
					}
				}
			}
		}
		return results.toArray();
	}

	private prune(node: Node, level: number, max: number): void {
		const scored = node.neighbors[level].map(id => ({ id, score: dot(node.vec, this.nodes.get(id)!.vec) }));
		scored.sort((a, b) => b.score - a.score);
		node.neighbors[level] = scored.slice(0, max).map(s => s.id);
	}
}

/** Exact top-k by cosine — the reference the HNSW is measured against (and the fallback for tiny sets). */
export const bruteForceTopK = (query: ArrayLike<number>, vectors: Iterable<[number, ArrayLike<number>]>, k: number): HnswHit[] => {
	const q = normalise(query);
	const out: HnswHit[] = [];
	for (const [id, v] of vectors) out.push({ id, score: dot(q, normalise(v)) });
	return out.sort((a, b) => b.score - a.score).slice(0, k);
};
