/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * EmbeddingService — calls an OpenAI-compatible `/embeddings` endpoint (LiteLLM,
 * OpenAI, Ollama, …) to generate text embeddings. Falls back gracefully (returns
 * null) when the endpoint is unavailable so callers can degrade to BM25-only search.
 */

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_TEXTS_PER_BATCH = 20;

export type EmbeddingVector = number[];

export interface EmbeddingConfig {
	enabled: boolean;
	/** Full URL of the embeddings endpoint, e.g. `http://localhost:4000/v1/embeddings`. */
	url: string;
	/** Model identifier sent in the request body, e.g. `text-embedding-3-small`. */
	model: string;
	/** Extra request headers (e.g. `Authorization`). */
	headers?: Record<string, string>;
	/** Per-request timeout; defaults to 10s. */
	timeoutMs?: number;
	/** Max texts per HTTP request; defaults to 20. */
	batchSize?: number;
}

export interface Embedder {
	/** Embed a single text. Returns null if the endpoint is unavailable. */
	embedText(text: string): Promise<EmbeddingVector | null>;
	/** Embed a batch of texts. Returns null if the endpoint is unavailable. */
	embedTexts(texts: string[]): Promise<EmbeddingVector[] | null>;
}

/** Cosine similarity between two unit vectors (or any float arrays of the same length). */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
	if (a.length !== b.length || a.length === 0) return 0;
	let dot = 0, normA = 0, normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

/** Serialize a float array to a compact Buffer for SQLite BLOB storage. */
export function serializeEmbedding(vec: EmbeddingVector): Buffer {
	const buf = Buffer.allocUnsafe(vec.length * 4);
	for (let i = 0; i < vec.length; i++) {
		buf.writeFloatLE(vec[i], i * 4);
	}
	return buf;
}

/** Deserialize a float array from a SQLite BLOB (Buffer or Uint8Array). */
export function deserializeEmbedding(blob: Uint8Array): EmbeddingVector {
	const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
	const vec: EmbeddingVector = new Array(Math.floor(blob.byteLength / 4));
	for (let i = 0; i < vec.length; i++) {
		vec[i] = view.getFloat32(i * 4, true);
	}
	return vec;
}

/**
 * Build an embedder for the given endpoint. Returns `undefined` when embeddings are
 * disabled or misconfigured so callers can use `embedder?.embedText(...)`.
 * Uses the global `fetch` (Node 18+).
 */
export function createEmbedder(cfg: EmbeddingConfig | undefined): Embedder | undefined {
	if (!cfg || !cfg.enabled || !cfg.url || !cfg.model) return undefined;

	const timeoutMs = cfg.timeoutMs ?? REQUEST_TIMEOUT_MS;
	const batchSize = Math.max(1, cfg.batchSize ?? MAX_TEXTS_PER_BATCH);
	const headers = { 'Content-Type': 'application/json', ...(cfg.headers ?? {}) };

	const embedBatch = async (texts: string[]): Promise<EmbeddingVector[] | null> => {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			let resp: Response;
			try {
				resp = await fetch(cfg.url, {
					method: 'POST',
					headers,
					body: JSON.stringify({ model: cfg.model, input: texts }),
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timer);
			}
			if (!resp.ok) return null;
			const data = await resp.json() as { data?: { embedding: EmbeddingVector; index?: number }[] };
			if (!Array.isArray(data.data) || data.data.length !== texts.length) return null;
			// Honour the `index` field when present (OpenAI may reorder).
			const out: EmbeddingVector[] = new Array(texts.length);
			data.data.forEach((d, i) => { out[typeof d.index === 'number' ? d.index : i] = d.embedding; });
			return out.every(Boolean) ? out : null;
		} catch {
			return null;
		}
	};

	const embedTexts = async (texts: string[]): Promise<EmbeddingVector[] | null> => {
		if (texts.length === 0) return [];
		const all: EmbeddingVector[] = [];
		for (let i = 0; i < texts.length; i += batchSize) {
			const batch = await embedBatch(texts.slice(i, i + batchSize));
			if (batch === null) return null;
			all.push(...batch);
		}
		return all;
	};

	const embedText = async (text: string): Promise<EmbeddingVector | null> => {
		const result = await embedTexts([text]);
		return result?.[0] ?? null;
	};

	return { embedText, embedTexts };
}
