/**
 * Knowledge adapter — read-only grounding against enterprise knowledge stores:
 *   - a vector store (Qdrant, Weaviate or Chroma) exposed as kb_* tools, and
 *   - a graph store (Neo4j, HTTP transactional endpoint) exposed as kg_* tools.
 *
 * Rules (see adapter.ts): no `vscode` import (runs in the MCP server process too), every result is a
 * compact string, credentials only via env.getSecret, all tools are `kind: 'read'`. Cypher sent to
 * Neo4j passes a read-only guard and gets a LIMIT when the statement has none.
 *
 * Embeddings come from `env.embed` (gateway / provider embeddings). When it is absent, Weaviate falls
 * back to BM25 and Chroma to server-side `query_texts`; Qdrant has no text search, so it errors.
 */
import {
	type AdapterEnv, type Health, type IntegrationAdapter, type IntegrationToolSpec,
	IntegrationError, RateLimiter, bearerAuth, basicAuth, clip, requestJson, tool, str, num, obj,
} from './adapter.js';

type VectorKind = 'none' | 'qdrant' | 'weaviate' | 'chroma';
type GraphKind = 'none' | 'neo4j';

type Hit = { id: string; score: number | undefined; text: string; metadata: Record<string, unknown> };
type Doc = { id: string; text: string; metadata: Record<string, unknown> };
type CollectionInfo = { name: string; count?: number; extra?: string };

const limiter = new RateLimiter(5, 10);
const EXCERPT_CHARS = 300;
const CELL_CHARS = 200;

/* ───────────────────────────── settings ───────────────────────────── */

const s = (settings: Record<string, unknown>, key: string, dflt = ''): string => {
	const v = settings[key];
	return v === undefined || v === null || String(v).trim() === '' ? dflt : String(v).trim();
};
const n = (settings: Record<string, unknown>, key: string, dflt: number): number => {
	const v = Number(settings[key]);
	return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
};
const urlOf = (settings: Record<string, unknown>, key: string, what: string): string => {
	const raw = s(settings, key).replace(/\/+$/, '');
	if (!raw) { throw new IntegrationError(`knowledge: ${key} is not set (${what}; Settings → Integrations)`); }
	if (!/^https?:\/\//i.test(raw)) { throw new IntegrationError(`knowledge: ${key} must start with http:// or https:// (got ${raw})`); }
	return raw;
};

const vectorKindOf = (settings: Record<string, unknown>): VectorKind => {
	const k = s(settings, 'vectorKind', 'none').toLowerCase();
	if (k === 'qdrant' || k === 'weaviate' || k === 'chroma' || k === 'none') { return k; }
	throw new IntegrationError(`knowledge: unknown vectorKind "${k}" (expected none|qdrant|weaviate|chroma)`);
};
const graphKindOf = (settings: Record<string, unknown>): GraphKind => {
	const k = s(settings, 'graphKind', 'none').toLowerCase();
	if (k === 'neo4j' || k === 'none') { return k; }
	throw new IntegrationError(`knowledge: unknown graphKind "${k}" (expected none|neo4j)`);
};

const requireVector = (env: AdapterEnv): Exclude<VectorKind, 'none'> => {
	const k = vectorKindOf(env.settings);
	if (k === 'none') { throw new IntegrationError('knowledge: no vector store configured (set riaf.integrations.knowledge.vectorKind to qdrant|weaviate|chroma)'); }
	return k;
};
const requireGraph = (env: AdapterEnv): Exclude<GraphKind, 'none'> => {
	const k = graphKindOf(env.settings);
	if (k === 'none') { throw new IntegrationError('knowledge: no graph store configured (set riaf.integrations.knowledge.graphKind to neo4j)'); }
	return k;
};
const requireCollection = (env: AdapterEnv): string => {
	const c = s(env.settings, 'vectorCollection');
	if (!c) { throw new IntegrationError('knowledge: vectorCollection is not set (Settings → Integrations)'); }
	return c;
};

const parseJsonArg = (v: unknown, what: string): Record<string, unknown> | undefined => {
	if (v === undefined || v === null || v === '') { return undefined; }
	if (typeof v === 'object') { return v as Record<string, unknown>; }
	try {
		const parsed = JSON.parse(String(v));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { throw new Error('not an object'); }
		return parsed as Record<string, unknown>;
	} catch (e) { throw new IntegrationError(`knowledge: ${what} must be a JSON object string (${(e as Error).message})`); }
};

async function embedQuery(env: AdapterEnv, query: string): Promise<number[] | undefined> {
	if (!env.embed) { return undefined; }
	const v = await env.embed(query);
	if (!Array.isArray(v) || v.length === 0) { throw new IntegrationError('knowledge: embeddings provider returned an empty vector'); }
	return v;
}

/* ───────────────────────────── vector backends ───────────────────────────── */

async function vectorAuth(env: AdapterEnv, kind: Exclude<VectorKind, 'none'>): Promise<Record<string, string>> {
	const key = (await env.getSecret('vectorApiKey'))?.trim();
	if (!key) { return {}; }
	return kind === 'qdrant' ? { 'api-key': key } : bearerAuth(key);
}

const textOf = (payload: Record<string, unknown> | undefined, field: string): string => {
	const v = payload?.[field];
	if (typeof v === 'string') { return v; }
	if (v === undefined || v === null) { return ''; }
	return typeof v === 'object' ? JSON.stringify(v) : String(v);
};
const metaOf = (payload: Record<string, unknown> | undefined, field: string): Record<string, unknown> => {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(payload ?? {})) { if (k !== field) { out[k] = v; } }
	return out;
};

/* Qdrant ------------------------------------------------------------------ */

type QdrantSearch = { result?: { id: string | number; score: number; payload?: Record<string, unknown> }[] };

async function qdrantSearch(env: AdapterEnv, query: string, topK: number, filter: Record<string, unknown> | undefined): Promise<Hit[]> {
	const url = urlOf(env.settings, 'vectorUrl', 'Qdrant REST URL');
	const coll = requireCollection(env);
	const field = s(env.settings, 'vectorTextField', 'text');
	const vector = await embedQuery(env, query);
	if (!vector) {
		throw new IntegrationError('knowledge: Qdrant search needs query embeddings — enable riaf.embeddings.enabled and configure the embeddings gateway/provider (Qdrant has no server-side text search)');
	}
	const auth = await vectorAuth(env, 'qdrant');
	const res = await requestJson<QdrantSearch>(env, `${url}/collections/${encodeURIComponent(coll)}/points/search`, auth, {
		body: { vector, limit: topK, with_payload: true, ...(filter ? { filter } : {}) },
	}, limiter);
	return (res.result ?? []).map(p => ({ id: String(p.id), score: p.score, text: textOf(p.payload, field), metadata: metaOf(p.payload, field) }));
}

async function qdrantGet(env: AdapterEnv, id: string): Promise<Doc> {
	const url = urlOf(env.settings, 'vectorUrl', 'Qdrant REST URL');
	const coll = requireCollection(env);
	const field = s(env.settings, 'vectorTextField', 'text');
	const auth = await vectorAuth(env, 'qdrant');
	const res = await requestJson<{ result?: { id: string | number; payload?: Record<string, unknown> } }>(env, `${url}/collections/${encodeURIComponent(coll)}/points/${encodeURIComponent(id)}`, auth, {}, limiter);
	if (!res?.result) { throw new IntegrationError(`knowledge: point ${id} not found in ${coll}`, 404); }
	return { id: String(res.result.id), text: textOf(res.result.payload, field), metadata: metaOf(res.result.payload, field) };
}

async function qdrantCollections(env: AdapterEnv): Promise<CollectionInfo[]> {
	const url = urlOf(env.settings, 'vectorUrl', 'Qdrant REST URL');
	const auth = await vectorAuth(env, 'qdrant');
	const res = await requestJson<{ result?: { collections?: { name: string }[] } }>(env, `${url}/collections`, auth, {}, limiter);
	const names = (res.result?.collections ?? []).map(c => c.name);
	const out: CollectionInfo[] = [];
	for (const name of names) {
		try {
			const info = await requestJson<{ result?: { points_count?: number; vectors_count?: number; status?: string } }>(env, `${url}/collections/${encodeURIComponent(name)}`, auth, {}, limiter);
			out.push({ name, count: info.result?.points_count ?? info.result?.vectors_count, extra: info.result?.status });
		} catch { out.push({ name }); }
	}
	return out;
}

/* Weaviate ----------------------------------------------------------------- */

type WeaviateClass = { class: string; properties?: { name: string; dataType?: string[] }[] };
type WeaviateSchema = { classes?: WeaviateClass[] };
type GraphQLResponse = { data?: Record<string, Record<string, unknown>>; errors?: { message: string }[] };

/** JSON → GraphQL input literal. Weaviate's `where.operator` is an enum, so it is emitted bare. */
function gqlLiteral(v: unknown, key?: string): string {
	if (v === null || v === undefined) { return 'null'; }
	if (typeof v === 'string') { return key === 'operator' && /^[A-Za-z]+$/.test(v) ? v : JSON.stringify(v); }
	if (typeof v === 'number' || typeof v === 'boolean') { return String(v); }
	if (Array.isArray(v)) { return `[${v.map(x => gqlLiteral(x, key)).join(', ')}]`; }
	return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${gqlLiteral(x, k)}`).join(', ')}}`;
}

async function weaviateGraphQL(env: AdapterEnv, url: string, auth: Record<string, string>, query: string): Promise<Record<string, Record<string, unknown>>> {
	const res = await requestJson<GraphQLResponse>(env, `${url}/v1/graphql`, auth, { body: { query } }, limiter);
	if (res.errors?.length) { throw new IntegrationError(`knowledge: Weaviate GraphQL error: ${res.errors.map(e => e.message).join('; ').slice(0, 400)}`); }
	return res.data ?? {};
}

async function weaviateProps(env: AdapterEnv, url: string, auth: Record<string, string>, cls: string): Promise<string[]> {
	const schema = await requestJson<WeaviateSchema>(env, `${url}/v1/schema`, auth, {}, limiter);
	const c = (schema.classes ?? []).find(x => x.class === cls || x.class.toLowerCase() === cls.toLowerCase());
	if (!c) { throw new IntegrationError(`knowledge: Weaviate class "${cls}" not found (classes: ${(schema.classes ?? []).map(x => x.class).join(', ') || 'none'})`, 404); }
	// Cross-references have a class name as dataType (capitalised); skip them — they need sub-selections.
	return (c.properties ?? []).filter(p => !(p.dataType ?? []).some(t => /^[A-Z]/.test(t))).map(p => p.name);
}

async function weaviateSearch(env: AdapterEnv, query: string, topK: number, filter: Record<string, unknown> | undefined): Promise<Hit[]> {
	const url = urlOf(env.settings, 'vectorUrl', 'Weaviate URL');
	const cls = requireCollection(env);
	const field = s(env.settings, 'vectorTextField', 'text');
	const auth = await vectorAuth(env, 'weaviate');
	const vector = await embedQuery(env, query);
	const props = await weaviateProps(env, url, auth, cls);
	const fields = [...new Set([field, ...props])].join(' ');
	const where = filter ? `, where: ${gqlLiteral(filter)}` : '';
	const search = vector ? `nearVector: {vector: ${JSON.stringify(vector)}}` : `bm25: {query: ${JSON.stringify(query)}}`;
	const extra = vector ? 'distance' : 'score';
	const gql = `{ Get { ${cls}(${search}, limit: ${topK}${where}) { ${fields} _additional { id ${extra} } } } }`;
	const data = await weaviateGraphQL(env, url, auth, gql);
	const rows = (data.Get?.[cls] ?? []) as Record<string, unknown>[];
	return rows.map(r => {
		const add = (r._additional ?? {}) as { id?: string; distance?: number; score?: number | string };
		const { _additional: _ignored, ...rest } = r;
		const raw = vector ? add.distance : add.score;
		const score = raw === undefined || raw === null ? undefined : Number(raw);
		return { id: String(add.id ?? ''), score: Number.isFinite(score as number) ? score : undefined, text: textOf(rest, field), metadata: metaOf(rest, field) };
	});
}

async function weaviateGet(env: AdapterEnv, id: string): Promise<Doc> {
	const url = urlOf(env.settings, 'vectorUrl', 'Weaviate URL');
	const cls = requireCollection(env);
	const field = s(env.settings, 'vectorTextField', 'text');
	const auth = await vectorAuth(env, 'weaviate');
	const res = await requestJson<{ id?: string; properties?: Record<string, unknown> }>(env, `${url}/v1/objects/${encodeURIComponent(cls)}/${encodeURIComponent(id)}`, auth, {}, limiter);
	if (!res) { throw new IntegrationError(`knowledge: object ${id} not found in ${cls}`, 404); }
	return { id: String(res.id ?? id), text: textOf(res.properties, field), metadata: metaOf(res.properties, field) };
}

async function weaviateCollections(env: AdapterEnv): Promise<CollectionInfo[]> {
	const url = urlOf(env.settings, 'vectorUrl', 'Weaviate URL');
	const auth = await vectorAuth(env, 'weaviate');
	const schema = await requestJson<WeaviateSchema>(env, `${url}/v1/schema`, auth, {}, limiter);
	const classes = schema.classes ?? [];
	const counts = new Map<string, number>();
	if (classes.length) {
		try {
			const gql = `{ Aggregate { ${classes.map(c => `${c.class} { meta { count } }`).join(' ')} } }`;
			const data = await weaviateGraphQL(env, url, auth, gql);
			for (const c of classes) {
				const agg = (data.Aggregate?.[c.class] as { meta?: { count?: number } }[] | undefined)?.[0];
				if (typeof agg?.meta?.count === 'number') { counts.set(c.class, agg.meta.count); }
			}
		} catch (e) { env.log?.(`knowledge: Weaviate aggregate counts failed: ${(e as Error).message}`); }
	}
	return classes.map(c => ({ name: c.class, count: counts.get(c.class), extra: `${(c.properties ?? []).length} props` }));
}

/* Chroma ------------------------------------------------------------------- */

type ChromaCollection = { id: string; name: string; metadata?: Record<string, unknown> | null };
type ChromaQuery = { ids?: string[][]; documents?: (string | null)[][]; metadatas?: (Record<string, unknown> | null)[][]; distances?: number[][] };
type ChromaGet = { ids?: string[]; documents?: (string | null)[]; metadatas?: (Record<string, unknown> | null)[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function chromaCollectionId(env: AdapterEnv, url: string, auth: Record<string, string>): Promise<string> {
	const nameOrId = requireCollection(env);
	if (UUID_RE.test(nameOrId)) { return nameOrId; }
	const list = await requestJson<ChromaCollection[]>(env, `${url}/api/v1/collections`, auth, {}, limiter);
	const hit = (Array.isArray(list) ? list : []).find(c => c.name === nameOrId || c.id === nameOrId);
	if (!hit) { throw new IntegrationError(`knowledge: Chroma collection "${nameOrId}" not found (have: ${(Array.isArray(list) ? list : []).map(c => c.name).join(', ') || 'none'})`, 404); }
	return hit.id;
}

async function chromaSearch(env: AdapterEnv, query: string, topK: number, filter: Record<string, unknown> | undefined): Promise<Hit[]> {
	const url = urlOf(env.settings, 'vectorUrl', 'Chroma URL');
	const auth = await vectorAuth(env, 'chroma');
	const id = await chromaCollectionId(env, url, auth);
	const vector = await embedQuery(env, query);
	const body: Record<string, unknown> = { n_results: topK, include: ['documents', 'metadatas', 'distances'], ...(filter ? { where: filter } : {}) };
	if (vector) { body.query_embeddings = [vector]; } else { body.query_texts = [query]; }
	const res = await requestJson<ChromaQuery>(env, `${url}/api/v1/collections/${encodeURIComponent(id)}/query`, auth, { body }, limiter);
	const ids = res.ids?.[0] ?? [];
	return ids.map((pid, i) => ({
		id: String(pid),
		score: res.distances?.[0]?.[i],
		text: res.documents?.[0]?.[i] ?? '',
		metadata: res.metadatas?.[0]?.[i] ?? {},
	}));
}

async function chromaGet(env: AdapterEnv, docId: string): Promise<Doc> {
	const url = urlOf(env.settings, 'vectorUrl', 'Chroma URL');
	const auth = await vectorAuth(env, 'chroma');
	const id = await chromaCollectionId(env, url, auth);
	const res = await requestJson<ChromaGet>(env, `${url}/api/v1/collections/${encodeURIComponent(id)}/get`, auth, { body: { ids: [docId], include: ['documents', 'metadatas'] } }, limiter);
	if (!res.ids?.length) { throw new IntegrationError(`knowledge: document ${docId} not found in Chroma collection`, 404); }
	return { id: String(res.ids[0]), text: res.documents?.[0] ?? '', metadata: res.metadatas?.[0] ?? {} };
}

async function chromaCollections(env: AdapterEnv): Promise<CollectionInfo[]> {
	const url = urlOf(env.settings, 'vectorUrl', 'Chroma URL');
	const auth = await vectorAuth(env, 'chroma');
	const list = await requestJson<ChromaCollection[]>(env, `${url}/api/v1/collections`, auth, {}, limiter);
	const out: CollectionInfo[] = [];
	for (const c of Array.isArray(list) ? list : []) {
		let count: number | undefined;
		try {
			const v = await requestJson<unknown>(env, `${url}/api/v1/collections/${encodeURIComponent(c.id)}/count`, auth, {}, limiter);
			if (typeof v === 'number') { count = v; }
		} catch { /* count is optional */ }
		out.push({ name: c.name, count, extra: `id ${c.id}` });
	}
	return out;
}

/* dispatch ------------------------------------------------------------------ */

const vectorSearch = (env: AdapterEnv, q: string, k: number, f: Record<string, unknown> | undefined): Promise<Hit[]> => {
	const kind = requireVector(env);
	return kind === 'qdrant' ? qdrantSearch(env, q, k, f) : kind === 'weaviate' ? weaviateSearch(env, q, k, f) : chromaSearch(env, q, k, f);
};
const vectorGet = (env: AdapterEnv, id: string): Promise<Doc> => {
	const kind = requireVector(env);
	return kind === 'qdrant' ? qdrantGet(env, id) : kind === 'weaviate' ? weaviateGet(env, id) : chromaGet(env, id);
};
const vectorCollections = (env: AdapterEnv): Promise<CollectionInfo[]> => {
	const kind = requireVector(env);
	return kind === 'qdrant' ? qdrantCollections(env) : kind === 'weaviate' ? weaviateCollections(env) : chromaCollections(env);
};

const oneLine = (t: string): string => t.replace(/\s+/g, ' ').trim();
const excerpt = (t: string, max = EXCERPT_CHARS): string => { const o = oneLine(t); return o.length > max ? `${o.slice(0, max)}…` : o; };
const fmtScore = (v: number | undefined): string => v === undefined ? '-' : (Number.isInteger(v) ? String(v) : v.toFixed(4));

function renderHits(kind: VectorKind, mode: 'vector' | 'text', hits: Hit[], query: string): string {
	const scoreLabel = kind === 'qdrant' ? 'score (higher = closer)' : kind === 'weaviate' ? (mode === 'vector' ? 'distance (lower = closer)' : 'bm25 score (higher = better)') : 'distance (lower = closer)';
	const head = `kb_search [${kind}, ${mode === 'vector' ? 'vector' : 'text'}] "${excerpt(query, 80)}" → ${hits.length} hit(s); ${scoreLabel}`;
	if (!hits.length) { return `${head}\n(no results)`; }
	const lines = hits.map((h, i) => {
		const keys = Object.keys(h.metadata);
		return `#${i + 1} ${fmtScore(h.score)} · ${h.id} · ${excerpt(h.text) || '(no text)'} · ${keys.length ? keys.join(',') : '-'}`;
	});
	return clip(`${head}\n${lines.join('\n')}`);
}

/* ───────────────────────────── graph (Neo4j) ───────────────────────────── */

/** Strip string literals (single, double, backtick) so keywords inside them are not flagged. */
export function stripCypherStrings(cypher: string): string {
	let out = '';
	let quote: string | null = null;
	for (let i = 0; i < cypher.length; i++) {
		const ch = cypher[i];
		if (quote) {
			if (ch === '\\') { i++; continue; }
			if (ch === quote) { quote = null; out += ' '; }
			continue;
		}
		if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ' '; continue; }
		out += ch;
	}
	return out;
}

/** Most specific first so the error names the real culprit (apoc.create before CREATE, DETACH before DELETE). */
const FORBIDDEN: { re: RegExp; what: string }[] = [
	{ re: /\bapoc\.(create|refactor|periodic)\b/i, what: 'apoc.create/refactor/periodic' },
	{ re: /\bCALL\s+dbms\b/i, what: 'CALL dbms' },
	{ re: /\bLOAD\s+CSV\b/i, what: 'LOAD CSV' },
	{ re: /\bDETACH\b/i, what: 'DETACH' },
	{ re: /\bCREATE\b/i, what: 'CREATE' },
	{ re: /\bMERGE\b/i, what: 'MERGE' },
	{ re: /\bDELETE\b/i, what: 'DELETE' },
	{ re: /\bSET\b/i, what: 'SET' },
	{ re: /\bREMOVE\b/i, what: 'REMOVE' },
	{ re: /\bDROP\b/i, what: 'DROP' },
];

/** Returns the offending keyword when `cypher` is not read-only, else undefined. */
export function cypherWriteViolation(cypher: string): string | undefined {
	const bare = stripCypherStrings(cypher);
	for (const f of FORBIDDEN) { if (f.re.test(bare)) { return f.what; } }
	return undefined;
}

/** Append `LIMIT n` when the statement has no LIMIT clause (outside string literals). */
export function ensureLimit(cypher: string, max: number): string {
	const trimmed = cypher.trim().replace(/;+\s*$/, '');
	if (/\bLIMIT\b/i.test(stripCypherStrings(trimmed))) { return trimmed; }
	return `${trimmed} LIMIT ${max}`;
}

type Neo4jMeta = { id?: number | string; type?: string; elementId?: string } | null;
type Neo4jGraphNode = { id: string; labels?: string[]; properties?: Record<string, unknown> };
type Neo4jGraphRel = { id: string; type?: string; startNode?: string; endNode?: string; properties?: Record<string, unknown> };
type Neo4jResponse = {
	results?: { columns: string[]; data: { row: unknown[]; meta?: (Neo4jMeta | Neo4jMeta[])[]; graph?: { nodes?: Neo4jGraphNode[]; relationships?: Neo4jGraphRel[] } }[] }[];
	errors?: { code: string; message: string }[];
};

async function graphAuth(env: AdapterEnv): Promise<Record<string, string>> {
	const user = (await env.getSecret('graphUser'))?.trim() ?? '';
	const pass = (await env.getSecret('graphPassword')) ?? '';
	return user ? basicAuth(user, pass) : {};
}

async function neo4jRun(env: AdapterEnv, statements: { statement: string; parameters?: Record<string, unknown> }[]): Promise<NonNullable<Neo4jResponse['results']>> {
	const url = urlOf(env.settings, 'graphUrl', 'Neo4j HTTP URL, e.g. http://host:7474');
	const db = s(env.settings, 'graphDatabase', 'neo4j');
	const auth = await graphAuth(env);
	const res = await requestJson<Neo4jResponse>(env, `${url}/db/${encodeURIComponent(db)}/tx/commit`, auth, {
		body: { statements: statements.map(st => ({ statement: st.statement, parameters: st.parameters ?? {}, resultDataContents: ['row', 'graph'] })) },
	}, limiter);
	if (res.errors?.length) { throw new IntegrationError(`knowledge: Neo4j error: ${res.errors.map(e => `${e.code}: ${e.message}`).join('; ').slice(0, 600)}`); }
	return res.results ?? [];
}

const props = (p: Record<string, unknown> | undefined): string => {
	const entries = Object.entries(p ?? {});
	if (!entries.length) { return '{}'; }
	return `{${entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')}}`;
};

function renderValue(value: unknown, meta: Neo4jMeta | Neo4jMeta[] | undefined, nodes: Map<string, Neo4jGraphNode>, rels: Map<string, Neo4jGraphRel>): string {
	if (Array.isArray(meta) && Array.isArray(value)) {
		return `[${value.map((v, i) => renderValue(v, meta[i], nodes, rels)).join(', ')}]`;
	}
	const m = Array.isArray(meta) ? undefined : meta;
	if (m && m.type === 'node') {
		const g = nodes.get(String(m.elementId ?? m.id));
		const labels = g?.labels?.length ? `:${g.labels.join(':')}` : '';
		return `(${labels} ${props((g?.properties ?? value) as Record<string, unknown>)})`;
	}
	if (m && m.type === 'relationship') {
		const g = rels.get(String(m.elementId ?? m.id));
		return `-[:${g?.type ?? '?'} ${props((g?.properties ?? value) as Record<string, unknown>)}]-`;
	}
	if (value === null || value === undefined) { return 'null'; }
	if (typeof value === 'object') { return JSON.stringify(value); }
	return String(value);
}

const cell = (t: string): string => { const o = oneLine(t); return o.length > CELL_CHARS ? `${o.slice(0, CELL_CHARS)}…` : o; };

/** Render one statement result as a compact pipe table; nodes → (:Label {props}), relationships → -[:TYPE {props}]-. */
export function renderNeo4jResult(result: NonNullable<Neo4jResponse['results']>[number] | undefined): string {
	if (!result) { return '(no result)'; }
	const nodes = new Map<string, Neo4jGraphNode>();
	const rels = new Map<string, Neo4jGraphRel>();
	for (const d of result.data) {
		for (const nd of d.graph?.nodes ?? []) { nodes.set(String(nd.id), nd); }
		for (const r of d.graph?.relationships ?? []) { rels.set(String(r.id), r); }
	}
	const header = result.columns.join(' | ');
	if (!result.data.length) { return `${header}\n(0 rows)`; }
	const rows = result.data.map(d => d.row.map((v, i) => cell(renderValue(v, d.meta?.[i], nodes, rels))).join(' | '));
	return `${header}\n${'-'.repeat(Math.min(header.length, 80))}\n${rows.join('\n')}\n(${rows.length} row${rows.length === 1 ? '' : 's'})`;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ident = (v: unknown, what: string): string => {
	const t = String(v ?? '').trim();
	if (!IDENT_RE.test(t)) { throw new IntegrationError(`knowledge: ${what} must be a plain identifier (letters, digits, underscore; got "${t}")`); }
	return t;
};

/** Build the parameterised neighbourhood query (exported for tests / transparency). */
export function neighborsQuery(args: { label?: string; key: string; depth: number; }): string {
	const label = args.label ? `:${ident(args.label, 'label')}` : '';
	const key = ident(args.key, 'key');
	const depth = Math.min(2, Math.max(1, Math.floor(args.depth) || 1));
	return `MATCH (n${label} {${key}: $value})-[r*1..${depth}]-(m) RETURN DISTINCT m, [x IN r | type(x)] AS via LIMIT $limit`;
}

async function kgQuery(env: AdapterEnv, args: Record<string, unknown>): Promise<string> {
	requireGraph(env);
	const cypher = String(args.cypher ?? '').trim();
	if (!cypher) { throw new IntegrationError('knowledge: kg_query needs a cypher statement'); }
	const bad = cypherWriteViolation(cypher);
	if (bad) { throw new IntegrationError(`knowledge: kg_query is read-only — statement contains ${bad}. Only MATCH/RETURN/WITH/UNWIND/CALL db.* read procedures are allowed.`); }
	const maxRows = n(env.settings, 'graphMaxRows', 50);
	const statement = ensureLimit(cypher, maxRows);
	const parameters = parseJsonArg(args.params, 'params') ?? {};
	const [result] = await neo4jRun(env, [{ statement, parameters }]);
	return clip(`kg_query: ${cell(statement)}\n${renderNeo4jResult(result)}`);
}

async function kgNeighbors(env: AdapterEnv, args: Record<string, unknown>): Promise<string> {
	requireGraph(env);
	if (args.value === undefined || args.value === null || args.value === '') { throw new IntegrationError('knowledge: kg_neighbors needs key and value'); }
	const maxRows = n(env.settings, 'graphMaxRows', 50);
	const limit = Math.min(maxRows, Math.max(1, Math.floor(Number(args.limit)) || maxRows));
	const depth = Math.min(2, Math.max(1, Math.floor(Number(args.depth)) || 1));
	const statement = neighborsQuery({ label: args.label ? String(args.label) : undefined, key: String(args.key ?? ''), depth });
	const [result] = await neo4jRun(env, [{ statement, parameters: { value: args.value, limit } }]);
	return clip(`kg_neighbors: ${statement}\nparams: ${JSON.stringify({ value: args.value, limit })}\n${renderNeo4jResult(result)}`);
}

const columnValues = (r: NonNullable<Neo4jResponse['results']>[number] | undefined): string[] => (r?.data ?? []).map(d => String(d.row[0] ?? '')).filter(Boolean);

async function kgSchema(env: AdapterEnv): Promise<string> {
	requireGraph(env);
	const parts: string[] = [];
	let labels: string[] = [];
	let relTypes: string[] = [];
	try {
		const [l, t] = await neo4jRun(env, [{ statement: 'CALL db.labels() YIELD label RETURN label' }, { statement: 'CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType' }]);
		labels = columnValues(l); relTypes = columnValues(t);
	} catch (e) {
		// Older servers / restricted roles: derive from data with a bounded scan.
		env.log?.(`knowledge: db.labels()/db.relationshipTypes() unavailable (${(e as Error).message}); falling back to a scan`);
		const [l, t] = await neo4jRun(env, [
			{ statement: 'MATCH (n) WITH DISTINCT labels(n) AS ls LIMIT 500 UNWIND ls AS l RETURN DISTINCT l' },
			{ statement: 'MATCH ()-[r]->() WITH DISTINCT type(r) AS t LIMIT 500 RETURN t' },
		]);
		labels = columnValues(l); relTypes = columnValues(t);
		parts.push('(labels/relationship types derived from a bounded scan — db.labels() unavailable)');
	}
	parts.push(`labels (${labels.length}): ${labels.join(', ') || '-'}`);
	parts.push(`relationship types (${relTypes.length}): ${relTypes.join(', ') || '-'}`);
	try {
		const [p] = await neo4jRun(env, [{ statement: 'CALL db.schema.nodeTypeProperties() YIELD nodeLabels, propertyName, propertyTypes RETURN nodeLabels, propertyName, propertyTypes' }]);
		const byLabel = new Map<string, string[]>();
		for (const d of p?.data ?? []) {
			const [ls, name, types] = d.row as [string[] | string, string, string[] | string];
			const key = Array.isArray(ls) ? ls.join(':') : String(ls);
			const list = byLabel.get(key) ?? [];
			list.push(`${name}${types ? `:${Array.isArray(types) ? types.join('|') : types}` : ''}`);
			byLabel.set(key, list);
		}
		parts.push('properties by label:');
		for (const [k, v] of byLabel) { parts.push(`  ${k}: ${v.join(', ')}`); }
		if (!byLabel.size) { parts.push('  (none reported)'); }
	} catch (e) {
		env.log?.(`knowledge: db.schema.nodeTypeProperties() unavailable (${(e as Error).message}); sampling keys per label`);
		try {
			const sampled: string[] = [];
			for (const l of labels.slice(0, 25)) {
				const [r] = await neo4jRun(env, [{ statement: `MATCH (n:\`${l.replace(/`/g, '``')}\`) WITH n LIMIT 50 UNWIND keys(n) AS k RETURN DISTINCT k` }]);
				sampled.push(`  ${l}: ${columnValues(r).join(', ') || '-'}`);
			}
			parts.push('properties by label (sampled, db.schema.nodeTypeProperties() unavailable):');
			parts.push(...(sampled.length ? sampled : ['  (none)']));
		} catch (e2) {
			parts.push(`properties by label: unavailable (${(e2 as Error).message.slice(0, 200)})`);
		}
	}
	return clip(`kg_schema\n${parts.join('\n')}`);
}

/* ───────────────────────────── adapter ───────────────────────────── */

const tools: IntegrationToolSpec[] = [
	tool('kb_search', 'read', 'search knowledge base', 'Semantic (or text fallback) search over the configured vector store collection. Returns ranked hits: rank, score, id, text excerpt, metadata keys. Use kb_get to read a full chunk.', obj({
		query: str('Natural-language query'),
		topK: num('Number of hits (default from settings vectorTopK)'),
		filter: str('Optional backend-native filter as a JSON object string (Qdrant filter / Weaviate where / Chroma where)'),
	}, ['query'])),
	tool('kb_get', 'read', 'read knowledge chunk', 'Fetch one chunk/object by id from the configured vector store collection: full text (clipped) plus metadata.', obj({ id: str('Chunk / point / object id') }, ['id'])),
	tool('kb_collections', 'read', 'list knowledge collections', 'List the collections/classes in the configured vector store with item counts where the backend reports them.', obj({})),
	tool('kg_query', 'read', 'run read-only graph query', 'Run a READ-ONLY Cypher statement against the knowledge graph (Neo4j). Writes (CREATE/MERGE/DELETE/SET/REMOVE/DROP/LOAD CSV/dbms/apoc write procs) are rejected; a LIMIT is added when missing. Returns a compact table.', obj({
		cypher: str('Cypher statement (read-only)'),
		params: str('Optional parameters as a JSON object string, referenced as $name'),
	}, ['cypher'])),
	tool('kg_neighbors', 'read', 'expand graph neighbours', 'Return the neighbourhood of a node matched by {key: value} (optionally restricted to a label), up to depth 1-2, as a parameterised MATCH. Safer than hand-written Cypher.', obj({
		label: str('Optional node label'),
		key: str('Property name to match, e.g. id or name'),
		value: str('Property value to match'),
		depth: num('Traversal depth 1-2 (default 1)'),
		limit: num('Max neighbours (default graphMaxRows)'),
	}, ['key', 'value'])),
	tool('kg_schema', 'read', 'describe graph schema', 'Labels, relationship types and properties per label of the knowledge graph (db.labels / db.relationshipTypes / db.schema.nodeTypeProperties with fallbacks).', obj({})),
];

export const knowledgeAdapter: IntegrationAdapter = {
	id: 'knowledge',
	displayName: 'Knowledge stores (vector + graph)',
	settingsSchema: {
		vectorKind: { type: 'enum', description: 'Vector store backend', default: 'none', enum: ['none', 'qdrant', 'weaviate', 'chroma'] },
		vectorUrl: { type: 'string', description: 'Vector store base URL (Qdrant http://host:6333, Weaviate http://host:8080, Chroma http://host:8000)', default: '' },
		vectorCollection: { type: 'string', description: 'Qdrant collection / Weaviate class name / Chroma collection name or id', default: '' },
		vectorTextField: { type: 'string', description: 'Payload/property that holds the chunk text', default: 'text' },
		vectorTopK: { type: 'number', description: 'Default number of hits for kb_search', default: 8 },
		graphKind: { type: 'enum', description: 'Graph store backend', default: 'none', enum: ['none', 'neo4j'] },
		graphUrl: { type: 'string', description: 'Neo4j HTTP URL, e.g. http://host:7474', default: '' },
		graphDatabase: { type: 'string', description: 'Neo4j database name', default: 'neo4j' },
		graphMaxRows: { type: 'number', description: 'Row cap enforced on every graph query', default: 50 },
	},
	credentials: [
		{ key: 'vectorApiKey', label: 'Vector store API key', secret: true, hint: 'Qdrant api-key header / Weaviate bearer / Chroma token; leave empty if none' },
		{ key: 'graphUser', label: 'Graph DB user', secret: false },
		{ key: 'graphPassword', label: 'Graph DB password', secret: true },
	],
	tools,

	async health(env: AdapterEnv): Promise<Health> {
		const started = Date.now();
		const vk = (() => { try { return vectorKindOf(env.settings); } catch (e) { return (e as Error).message; } })();
		const gk = (() => { try { return graphKindOf(env.settings); } catch (e) { return (e as Error).message; } })();
		const parts: string[] = [];
		const detail: Record<string, unknown> = {};
		let ok = true;
		let configured = 0;

		if (vk === 'none') { parts.push('vector: not configured'); detail.vector = 'none'; }
		else if (vk === 'qdrant' || vk === 'weaviate' || vk === 'chroma') {
			configured++;
			try {
				const cols = await vectorCollections(env);
				const coll = s(env.settings, 'vectorCollection');
				const present = coll ? cols.some(c => c.name === coll || c.extra?.endsWith(coll)) : true;
				parts.push(`vector(${vk}): ok, ${cols.length} collection(s)${coll ? (present ? `, "${coll}" present` : `, "${coll}" NOT found`) : ', vectorCollection not set'}${env.embed ? '' : ' (no embeddings — text fallback only)'}`);
				detail.vector = { kind: vk, collections: cols.map(c => c.name), collectionPresent: present, embed: Boolean(env.embed) };
				if (coll && !present) { ok = false; }
			} catch (e) { ok = false; parts.push(`vector(${vk}): FAIL ${(e as Error).message}`); detail.vector = { kind: vk, error: (e as Error).message }; }
		} else { ok = false; parts.push(`vector: ${vk}`); }

		if (gk === 'none') { parts.push('graph: not configured'); detail.graph = 'none'; }
		else if (gk === 'neo4j') {
			configured++;
			try {
				const [r] = await neo4jRun(env, [{ statement: 'RETURN 1 AS ok' }]);
				const db = s(env.settings, 'graphDatabase', 'neo4j');
				parts.push(`graph(neo4j): ok, database "${db}"${r?.data?.[0]?.row?.[0] === 1 ? '' : ' (unexpected RETURN 1 result)'}`);
				detail.graph = { kind: gk, database: db };
			} catch (e) { ok = false; parts.push(`graph(neo4j): FAIL ${(e as Error).message}`); detail.graph = { kind: gk, error: (e as Error).message }; }
		} else { ok = false; parts.push(`graph: ${gk}`); }

		if (!configured) { return { ok: false, message: 'knowledge: nothing configured — set vectorKind and/or graphKind under riaf.integrations.knowledge', detail, latencyMs: Date.now() - started }; }
		return { ok, message: parts.join(' · '), detail, latencyMs: Date.now() - started };
	},

	async execute(toolName: string, args: Record<string, unknown>, env: AdapterEnv): Promise<string> {
		switch (toolName) {
			case 'kb_search': {
				const query = String(args.query ?? '').trim();
				if (!query) { throw new IntegrationError('knowledge: kb_search needs a query'); }
				const kind = requireVector(env);
				const topK = Math.max(1, Math.min(100, Math.floor(Number(args.topK)) || n(env.settings, 'vectorTopK', 8)));
				const filter = parseJsonArg(args.filter, 'filter');
				const hits = await vectorSearch(env, query, topK, filter);
				return renderHits(kind, env.embed ? 'vector' : 'text', hits, query);
			}
			case 'kb_get': {
				const id = String(args.id ?? '').trim();
				if (!id) { throw new IntegrationError('knowledge: kb_get needs an id'); }
				const doc = await vectorGet(env, id);
				const meta = Object.entries(doc.metadata);
				return clip(`kb_get ${doc.id}\nmetadata: ${meta.length ? JSON.stringify(doc.metadata) : '{}'}\n---\n${doc.text || '(no text)'}`);
			}
			case 'kb_collections': {
				const kind = requireVector(env);
				const cols = await vectorCollections(env);
				if (!cols.length) { return `kb_collections [${kind}]: none`; }
				return clip(`kb_collections [${kind}] (${cols.length})\n${cols.map(c => `- ${c.name}${c.count !== undefined ? ` · ${c.count} items` : ''}${c.extra ? ` · ${c.extra}` : ''}`).join('\n')}`);
			}
			case 'kg_query': return kgQuery(env, args);
			case 'kg_neighbors': return kgNeighbors(env, args);
			case 'kg_schema': return kgSchema(env);
			default: throw new IntegrationError(`knowledge: unknown tool ${toolName}`);
		}
	},
};
