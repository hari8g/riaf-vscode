import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AdapterEnv } from '../../src/integrations/adapter.js';
import { cypherWriteViolation, ensureLimit, knowledgeAdapter, neighborsQuery, renderNeo4jResult } from '../../src/integrations/knowledge.js';

/* ───────────────────────────── fake backends ───────────────────────────── */

type Rec = { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: any };
const requests: Rec[] = [];
/** Statements the fake Neo4j received (flattened). */
const cypherSeen = (): string[] => requests.filter(r => r.path.startsWith('/db/')).flatMap(r => (r.body?.statements ?? []).map((s: any) => s.statement));

let neo4jFailProcs = new Set<string>(); // substrings that make the fake Neo4j return an error
let neo4jDown = false;

const readBody = (req: IncomingMessage) => new Promise<string>(resolve => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => resolve(b)); });
const send = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

const CHROMA_ID = '11111111-2222-4333-8444-555555555555';

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const raw = await readBody(req);
	let body: any; try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
	const path = req.url ?? '/';
	const method = req.method ?? 'GET';
	requests.push({ method, path, headers: req.headers, body });

	/* Qdrant */
	if (path === '/collections' && method === 'GET') { return send(res, 200, { result: { collections: [{ name: 'docs' }, { name: 'other' }] } }); }
	if (path === '/collections/docs' && method === 'GET') { return send(res, 200, { result: { points_count: 42, status: 'green' } }); }
	if (path === '/collections/other' && method === 'GET') { return send(res, 500, { status: { error: 'boom' } }); }
	if (path === '/collections/docs/points/search' && method === 'POST') {
		if (req.headers['api-key'] !== 'qkey') { return send(res, 401, { status: { error: 'unauthorized' } }); }
		return send(res, 200, { result: [
			{ id: 7, score: 0.91, payload: { text: 'Qdrant chunk one '.repeat(30), source: 'a.md', page: 1 } },
			{ id: 'b2', score: 0.5, payload: { text: 'second', source: 'b.md' } },
		] });
	}
	if (path === '/collections/docs/points/7' && method === 'GET') { return send(res, 200, { result: { id: 7, payload: { text: 'full qdrant text', source: 'a.md' } } }); }
	if (path.startsWith('/collections/docs/points/') && method === 'GET') { return send(res, 404, { status: { error: 'Not found' } }); }

	/* Weaviate */
	if (path === '/v1/schema' && method === 'GET') {
		return send(res, 200, { classes: [
			{ class: 'Doc', properties: [{ name: 'text', dataType: ['text'] }, { name: 'source', dataType: ['text'] }, { name: 'ref', dataType: ['Other'] }] },
			{ class: 'Other', properties: [] },
		] });
	}
	if (path === '/v1/graphql' && method === 'POST') {
		if (req.headers.authorization && req.headers.authorization !== 'Bearer wkey') { return send(res, 401, {}); }
		const q: string = body.query;
		if (q.includes('Aggregate')) { return send(res, 200, { data: { Aggregate: { Doc: [{ meta: { count: 3 } }], Other: [{ meta: { count: 0 } }] } } }); }
		if (q.includes('nearVector')) {
			return send(res, 200, { data: { Get: { Doc: [{ text: 'weaviate vector hit', source: 's1', _additional: { id: 'w-1', distance: 0.12 } }] } } });
		}
		if (q.includes('bm25')) {
			return send(res, 200, { data: { Get: { Doc: [{ text: 'weaviate bm25 hit', source: 's2', _additional: { id: 'w-2', score: '1.5' } }] } } });
		}
		return send(res, 200, { errors: [{ message: 'unexpected query' }] });
	}
	if (path === '/v1/objects/Doc/w-1' && method === 'GET') { return send(res, 200, { id: 'w-1', class: 'Doc', properties: { text: 'full weaviate text', source: 's1' } }); }

	/* Chroma */
	if (path === '/api/v1/collections' && method === 'GET') { return send(res, 200, [{ id: CHROMA_ID, name: 'notes', metadata: null }]); }
	if (path === `/api/v1/collections/${CHROMA_ID}/count` && method === 'GET') { return send(res, 200, 5); }
	if (path === `/api/v1/collections/${CHROMA_ID}/query` && method === 'POST') {
		const mode = body.query_embeddings ? 'vec' : 'txt';
		return send(res, 200, { ids: [['c-1', 'c-2']], documents: [[`chroma ${mode} one`, `chroma ${mode} two`]], metadatas: [[{ src: 'x' }, null]], distances: [[0.2, 0.4]] });
	}
	if (path === `/api/v1/collections/${CHROMA_ID}/get` && method === 'POST') {
		if (body.ids?.[0] === 'c-1') { return send(res, 200, { ids: ['c-1'], documents: ['full chroma text'], metadatas: [{ src: 'x' }] }); }
		return send(res, 200, { ids: [], documents: [], metadatas: [] });
	}

	/* Neo4j */
	if (path === '/db/neo4j/tx/commit' && method === 'POST') {
		if (neo4jDown) { return send(res, 503, { message: 'unavailable' }); }
		if (req.headers.authorization !== `Basic ${Buffer.from('neo:pw').toString('base64')}`) { return send(res, 401, { errors: [{ code: 'Neo.ClientError.Security.Unauthorized', message: 'bad creds' }] }); }
		const results: unknown[] = [];
		for (const st of body.statements as { statement: string }[]) {
			const q = st.statement;
			const failing = [...neo4jFailProcs].find(p => q.includes(p));
			if (failing) { return send(res, 200, { results: [], errors: [{ code: 'Neo.ClientError.Procedure.ProcedureNotFound', message: `no such procedure ${failing}` }] }); }
			if (q.startsWith('RETURN 1')) { results.push({ columns: ['ok'], data: [{ row: [1], meta: [null] }] }); continue; }
			if (q.includes('db.labels')) { results.push({ columns: ['label'], data: [{ row: ['Person'], meta: [null] }, { row: ['Doc'], meta: [null] }] }); continue; }
			if (q.includes('db.relationshipTypes')) { results.push({ columns: ['relationshipType'], data: [{ row: ['KNOWS'], meta: [null] }] }); continue; }
			if (q.includes('db.schema.nodeTypeProperties')) { results.push({ columns: ['nodeLabels', 'propertyName', 'propertyTypes'], data: [{ row: [['Person'], 'name', ['String']], meta: [null, null, null] }] }); continue; }
			if (q.includes('UNWIND keys(n)')) { results.push({ columns: ['k'], data: [{ row: ['name'], meta: [null] }, { row: ['age'], meta: [null] }] }); continue; }
			// generic MATCH: one row with a node, a relationship and a scalar
			results.push({
				columns: ['n', 'r', 'cnt'],
				data: [{
					row: [{ name: 'Ada' }, { since: 1990 }, 3],
					meta: [{ id: 10, type: 'node' }, { id: 20, type: 'relationship' }, null],
					graph: { nodes: [{ id: '10', labels: ['Person', 'Engineer'], properties: { name: 'Ada' } }], relationships: [{ id: '20', type: 'KNOWS', startNode: '10', endNode: '11', properties: { since: 1990 } }] },
				}],
			});
		}
		return send(res, 200, { results, errors: [] });
	}

	send(res, 404, { error: `no fake route for ${method} ${path}` });
}

let server: Server;
let base = '';

beforeAll(async () => {
	server = createServer((req, res) => { void handle(req, res); });
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
	const addr = server.address();
	base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => { requests.length = 0; neo4jFailProcs = new Set(); neo4jDown = false; });

const secrets: Record<string, string> = { vectorApiKey: 'qkey', graphUser: 'neo', graphPassword: 'pw' };
const mkEnv = (settings: Record<string, unknown>, opts: { embed?: boolean; secrets?: Record<string, string> } = {}): AdapterEnv => ({
	fetch: (url, init) => fetch(url, init),
	getSecret: async k => (opts.secrets ?? secrets)[k],
	settings,
	embed: opts.embed === false ? undefined : async () => [0.1, 0.2, 0.3],
});
const qdrant = (o: Parameters<typeof mkEnv>[1] = {}) => mkEnv({ vectorKind: 'qdrant', vectorUrl: base, vectorCollection: 'docs' }, o);
const weaviate = (o: Parameters<typeof mkEnv>[1] = {}) => mkEnv({ vectorKind: 'weaviate', vectorUrl: base, vectorCollection: 'Doc' }, { secrets: { vectorApiKey: 'wkey' }, ...o });
const chroma = (o: Parameters<typeof mkEnv>[1] = {}) => mkEnv({ vectorKind: 'chroma', vectorUrl: base, vectorCollection: 'notes' }, { secrets: {}, ...o });
const neo = (extra: Record<string, unknown> = {}) => mkEnv({ graphKind: 'neo4j', graphUrl: base, graphDatabase: 'neo4j', graphMaxRows: 25, ...extra });

const run = (env: AdapterEnv, toolName: string, args: Record<string, unknown> = {}) => knowledgeAdapter.execute(toolName, args, env);

/* ───────────────────────────── contract ───────────────────────────── */

describe('knowledgeAdapter contract', () => {
	it('exposes read-only tools, flat settings and the three credentials', () => {
		expect(knowledgeAdapter.id).toBe('knowledge');
		expect(knowledgeAdapter.tools.map(t => t.name)).toEqual(['kb_search', 'kb_get', 'kb_collections', 'kg_query', 'kg_neighbors', 'kg_schema']);
		expect(knowledgeAdapter.tools.every(t => t.kind === 'read')).toBe(true);
		expect(Object.keys(knowledgeAdapter.settingsSchema)).toEqual(['vectorKind', 'vectorUrl', 'vectorCollection', 'vectorTextField', 'vectorTopK', 'graphKind', 'graphUrl', 'graphDatabase', 'graphMaxRows']);
		expect(knowledgeAdapter.settingsSchema.vectorKind.enum).toEqual(['none', 'qdrant', 'weaviate', 'chroma']);
		expect(knowledgeAdapter.credentials.map(c => c.key)).toEqual(['vectorApiKey', 'graphUser', 'graphPassword']);
	});
	it('refuses tools when the relevant store is not configured', async () => {
		await expect(run(mkEnv({}), 'kb_search', { query: 'x' })).rejects.toThrow(/no vector store configured/);
		await expect(run(mkEnv({}), 'kg_query', { cypher: 'MATCH (n) RETURN n' })).rejects.toThrow(/no graph store configured/);
		await expect(run(mkEnv({ vectorKind: 'qdrant', vectorUrl: base }), 'kb_search', { query: 'x' })).rejects.toThrow(/vectorCollection/);
	});
});

/* ───────────────────────────── kb_search ───────────────────────────── */

describe('kb_search', () => {
	it('Qdrant: embeds the query, POSTs vector search with api-key and renders ranked lines', async () => {
		const out = await run(qdrant(), 'kb_search', { query: 'hello', topK: 2, filter: '{"must":[{"key":"source","match":{"value":"a.md"}}]}' });
		const req = requests.find(r => r.path === '/collections/docs/points/search')!;
		expect(req.headers['api-key']).toBe('qkey');
		expect(req.body).toEqual({ vector: [0.1, 0.2, 0.3], limit: 2, with_payload: true, filter: { must: [{ key: 'source', match: { value: 'a.md' } }] } });
		expect(out).toContain('[qdrant, vector]');
		const lines = out.split('\n');
		expect(lines[1]).toMatch(/^#1 0\.9100 · 7 · Qdrant chunk one .*… · source,page$/);
		expect(lines[1].length).toBeLessThan(380);
		expect(lines[2]).toBe('#2 0.5000 · b2 · second · source');
	});
	it('Qdrant: errors without embeddings', async () => {
		await expect(run(qdrant({ embed: false }), 'kb_search', { query: 'hello' })).rejects.toThrow(/riaf\.embeddings\.enabled/);
		expect(requests.some(r => r.path.includes('/points/search'))).toBe(false);
	});
	it('Weaviate: nearVector GraphQL with bearer auth, schema-derived fields, where filter', async () => {
		const out = await run(weaviate(), 'kb_search', { query: 'hello', filter: '{"path":["source"],"operator":"Equal","valueText":"s1"}' });
		const gql = requests.find(r => r.path === '/v1/graphql')!;
		expect(gql.headers.authorization).toBe('Bearer wkey');
		expect(gql.body.query).toContain('Doc(nearVector: {vector: [0.1,0.2,0.3]}, limit: 8, where: {path: ["source"], operator: Equal, valueText: "s1"})');
		expect(gql.body.query).toContain('text source _additional { id distance }');
		expect(gql.body.query).not.toContain('ref');
		expect(out).toContain('#1 0.1200 · w-1 · weaviate vector hit · source');
	});
	it('Weaviate: falls back to bm25 when embed is undefined', async () => {
		const out = await run(weaviate({ embed: false }), 'kb_search', { query: 'hello world' });
		const gql = requests.find(r => r.path === '/v1/graphql')!;
		expect(gql.body.query).toContain('bm25: {query: "hello world"}');
		expect(gql.body.query).toContain('_additional { id score }');
		expect(out).toContain('[weaviate, text]');
		expect(out).toContain('#1 1.5000 · w-2 · weaviate bm25 hit · source');
	});
	it('Chroma: resolves the collection name to an id and sends query_embeddings', async () => {
		const out = await run(chroma(), 'kb_search', { query: 'hello', topK: 2 });
		const q = requests.find(r => r.path.endsWith('/query'))!;
		expect(q.path).toBe(`/api/v1/collections/${CHROMA_ID}/query`);
		expect(q.headers.authorization).toBeUndefined();
		expect(q.body).toEqual({ n_results: 2, include: ['documents', 'metadatas', 'distances'], query_embeddings: [[0.1, 0.2, 0.3]] });
		expect(out).toContain('#1 0.2000 · c-1 · chroma vec one · src');
		expect(out).toContain('#2 0.4000 · c-2 · chroma vec two · -');
	});
	it('Chroma: falls back to query_texts when embed is undefined', async () => {
		const out = await run(chroma({ embed: false }), 'kb_search', { query: 'hello' });
		const q = requests.find(r => r.path.endsWith('/query'))!;
		expect(q.body.query_texts).toEqual(['hello']);
		expect(q.body.query_embeddings).toBeUndefined();
		expect(out).toContain('chroma txt one');
	});
	it('rejects a non-object filter', async () => {
		await expect(run(qdrant(), 'kb_search', { query: 'x', filter: '[1]' })).rejects.toThrow(/filter must be a JSON object/);
	});
});

/* ───────────────────────────── kb_get / kb_collections ───────────────────────────── */

describe('kb_get', () => {
	it('returns full text and metadata per backend', async () => {
		expect(await run(qdrant(), 'kb_get', { id: '7' })).toBe('kb_get 7\nmetadata: {"source":"a.md"}\n---\nfull qdrant text');
		expect(await run(weaviate(), 'kb_get', { id: 'w-1' })).toBe('kb_get w-1\nmetadata: {"source":"s1"}\n---\nfull weaviate text');
		expect(await run(chroma(), 'kb_get', { id: 'c-1' })).toBe('kb_get c-1\nmetadata: {"src":"x"}\n---\nfull chroma text');
		expect(requests.find(r => r.path === '/v1/objects/Doc/w-1')).toBeTruthy();
	});
	it('reports missing ids', async () => {
		await expect(run(qdrant(), 'kb_get', { id: 'nope' })).rejects.toThrow(/404/);
		await expect(run(chroma(), 'kb_get', { id: 'nope' })).rejects.toThrow(/not found/);
	});
});

describe('kb_collections', () => {
	it('lists collections with counts where available', async () => {
		expect(await run(qdrant(), 'kb_collections')).toBe('kb_collections [qdrant] (2)\n- docs · 42 items · green\n- other');
		expect(await run(weaviate(), 'kb_collections')).toBe('kb_collections [weaviate] (2)\n- Doc · 3 items · 3 props\n- Other · 0 items · 0 props');
		expect(await run(chroma(), 'kb_collections')).toBe(`kb_collections [chroma] (1)\n- notes · 5 items · id ${CHROMA_ID}`);
	});
});

/* ───────────────────────────── kg_query ───────────────────────────── */

describe('kg_query read-only guard', () => {
	it.each([
		['CREATE (n:X)', 'CREATE'],
		['MATCH (n) merge (n)-[:R]->(m)', 'MERGE'],
		['MATCH (n) DELETE n', 'DELETE'],
		['MATCH (n) DETACH DELETE n', 'DETACH'],
		['MATCH (n) SET n.x = 1', 'SET'],
		['MATCH (n) REMOVE n.x', 'REMOVE'],
		['DROP INDEX foo', 'DROP'],
		['CALL dbms.killQueries([])', 'CALL dbms'],
		['CALL  DBMS.security.listUsers()', 'CALL dbms'],
		['CALL apoc.create.node(["X"], {})', 'apoc.create/refactor/periodic'],
		['CALL apoc.refactor.rename.label("A","B")', 'apoc.create/refactor/periodic'],
		['CALL apoc.periodic.iterate("", "", {})', 'apoc.create/refactor/periodic'],
		['LOAD CSV FROM "file:///x.csv" AS row RETURN row', 'LOAD CSV'],
		['load   csv from "x" as r return r', 'LOAD CSV'],
	])('rejects %s', async (cypher, what) => {
		expect(cypherWriteViolation(cypher)).toBe(what);
		await expect(run(neo(), 'kg_query', { cypher })).rejects.toThrow(new RegExp(`read-only — statement contains ${what.replace(/[./]/g, '\\$&')}`));
		expect(cypherSeen()).toEqual([]);
	});
	it('allows keywords inside string literals and as identifier fragments', async () => {
		const cases = [
			'MATCH (n) WHERE n.name = "DELETE me" RETURN n',
			"MATCH (n) WHERE n.note = 'please SET and CREATE' RETURN n",
			'MATCH (n:`CREATE things`) RETURN n',
			'MATCH (n) WHERE n.t = "it\'s CREATE" RETURN n',
			'MATCH (n) WHERE n.t = "esc \\" DROP" RETURN n',
			'MATCH (n:Dataset) RETURN n.settings, n.creates, n.subset',
			'CALL db.labels() YIELD label RETURN label',
			'CALL apoc.meta.stats() YIELD labels RETURN labels',
		];
		for (const c of cases) { expect(cypherWriteViolation(c), c).toBeUndefined(); }
		await expect(run(neo(), 'kg_query', { cypher: cases[0] })).resolves.toContain('n | r | cnt');
	});
	it('appends LIMIT graphMaxRows when absent and leaves existing LIMIT alone', async () => {
		expect(ensureLimit('MATCH (n) RETURN n;', 25)).toBe('MATCH (n) RETURN n LIMIT 25');
		expect(ensureLimit('MATCH (n) RETURN n limit 5', 25)).toBe('MATCH (n) RETURN n limit 5');
		expect(ensureLimit('MATCH (n) WHERE n.x = "no LIMIT here" RETURN n', 25)).toBe('MATCH (n) WHERE n.x = "no LIMIT here" RETURN n LIMIT 25');
		await run(neo(), 'kg_query', { cypher: 'MATCH (n) RETURN n', params: '{"x":1}' });
		expect(cypherSeen()).toEqual(['MATCH (n) RETURN n LIMIT 25']);
		const req = requests.find(r => r.path.startsWith('/db/'))!;
		expect(req.body.statements[0].parameters).toEqual({ x: 1 });
		expect(req.body.statements[0].resultDataContents).toEqual(['row', 'graph']);
		expect(req.headers.authorization).toBe(`Basic ${Buffer.from('neo:pw').toString('base64')}`);
		await run(neo(), 'kg_query', { cypher: 'MATCH (n) RETURN n LIMIT 3' });
		expect(cypherSeen().at(-1)).toBe('MATCH (n) RETURN n LIMIT 3');
	});
	it('renders nodes as labels+props and relationships as type+props in a compact table', async () => {
		const out = await run(neo(), 'kg_query', { cypher: 'MATCH (n)-[r]->() RETURN n, r, 3 AS cnt' });
		expect(out).toContain('n | r | cnt');
		expect(out).toContain('(:Person:Engineer {name: "Ada"}) | -[:KNOWS {since: 1990}]- | 3');
		expect(out).toContain('(1 row)');
	});
	it('renders empty results and arrays of graph elements', () => {
		expect(renderNeo4jResult({ columns: ['a'], data: [] })).toBe('a\n(0 rows)');
		const r = renderNeo4jResult({
			columns: ['path'],
			data: [{ row: [[{ name: 'A' }, { w: 1 }, { name: 'B' }]], meta: [[{ id: 1, type: 'node' }, { id: 2, type: 'relationship' }, { id: 3, type: 'node' }]], graph: { nodes: [{ id: '1', labels: ['X'], properties: { name: 'A' } }, { id: '3', labels: ['Y'], properties: { name: 'B' } }], relationships: [{ id: '2', type: 'TO', properties: { w: 1 } }] } }],
		});
		expect(r).toContain('[(:X {name: "A"}), -[:TO {w: 1}]-, (:Y {name: "B"})]');
	});
	it('surfaces Neo4j errors and rejects bad params JSON', async () => {
		neo4jFailProcs = new Set(['MATCH']);
		await expect(run(neo(), 'kg_query', { cypher: 'MATCH (n) RETURN n' })).rejects.toThrow(/Neo4j error: Neo.ClientError.Procedure.ProcedureNotFound/);
		await expect(run(neo(), 'kg_query', { cypher: 'MATCH (n) RETURN n', params: 'nope' })).rejects.toThrow(/params must be a JSON object/);
	});
});

/* ───────────────────────────── kg_neighbors / kg_schema ───────────────────────────── */

describe('kg_neighbors', () => {
	it('builds a parameterised MATCH with label, key, clamped depth and limit', async () => {
		expect(neighborsQuery({ label: 'Person', key: 'name', depth: 2 })).toBe('MATCH (n:Person {name: $value})-[r*1..2]-(m) RETURN DISTINCT m, [x IN r | type(x)] AS via LIMIT $limit');
		expect(neighborsQuery({ key: 'id', depth: 9 })).toBe('MATCH (n {id: $value})-[r*1..2]-(m) RETURN DISTINCT m, [x IN r | type(x)] AS via LIMIT $limit');
		expect(() => neighborsQuery({ key: 'name}) DETACH DELETE n //', depth: 1 })).toThrow(/plain identifier/);
		expect(() => neighborsQuery({ label: 'A B', key: 'x', depth: 1 })).toThrow(/plain identifier/);
		const out = await run(neo(), 'kg_neighbors', { label: 'Person', key: 'name', value: 'Ada', depth: 1, limit: 500 });
		const req = requests.find(r => r.path.startsWith('/db/'))!;
		expect(req.body.statements[0].statement).toBe('MATCH (n:Person {name: $value})-[r*1..1]-(m) RETURN DISTINCT m, [x IN r | type(x)] AS via LIMIT $limit');
		expect(req.body.statements[0].parameters).toEqual({ value: 'Ada', limit: 25 });
		expect(out).toContain('(:Person:Engineer {name: "Ada"})');
		await expect(run(neo(), 'kg_neighbors', { key: 'name' })).rejects.toThrow(/needs key and value/);
	});
});

describe('kg_schema', () => {
	it('uses db.* procedures when available', async () => {
		const out = await run(neo(), 'kg_schema');
		expect(out).toContain('labels (2): Person, Doc');
		expect(out).toContain('relationship types (1): KNOWS');
		expect(out).toContain('  Person: name:String');
	});
	it('falls back to sampling when db.schema.nodeTypeProperties is missing', async () => {
		neo4jFailProcs = new Set(['db.schema.nodeTypeProperties']);
		const out = await run(neo(), 'kg_schema');
		expect(out).toContain('labels (2): Person, Doc');
		expect(out).toContain('properties by label (sampled');
		expect(out).toContain('  Person: name, age');
		expect(cypherSeen().some(q => q.includes('MATCH (n:`Person`)'))).toBe(true);
	});
	it('falls back to a bounded scan when db.labels is missing too', async () => {
		neo4jFailProcs = new Set(['db.labels', 'db.schema.nodeTypeProperties']);
		const out = await run(neo(), 'kg_schema');
		expect(out).toContain('bounded scan');
		expect(cypherSeen().some(q => q.includes('UNWIND ls AS l'))).toBe(true);
	});
});

/* ───────────────────────────── health ───────────────────────────── */

describe('health', () => {
	it('reports nothing configured', async () => {
		const h = await knowledgeAdapter.health(mkEnv({}));
		expect(h.ok).toBe(false);
		expect(h.message).toMatch(/nothing configured/);
	});
	it('reports both parts ok', async () => {
		const h = await knowledgeAdapter.health(mkEnv({ vectorKind: 'qdrant', vectorUrl: base, vectorCollection: 'docs', graphKind: 'neo4j', graphUrl: base }));
		expect(h.ok).toBe(true);
		expect(h.message).toBe('vector(qdrant): ok, 2 collection(s), "docs" present · graph(neo4j): ok, database "neo4j"');
		expect(cypherSeen()).toEqual(['RETURN 1 AS ok']);
	});
	it('reports a partial failure with the vector part still ok', async () => {
		neo4jDown = true;
		const h = await knowledgeAdapter.health(mkEnv({ vectorKind: 'chroma', vectorUrl: base, vectorCollection: 'notes', graphKind: 'neo4j', graphUrl: base }, { secrets: { graphUser: 'neo', graphPassword: 'pw' } }));
		expect(h.ok).toBe(false);
		expect(h.message).toMatch(/^vector\(chroma\): ok, 1 collection\(s\), "notes" present · graph\(neo4j\): FAIL 503/);
		expect((h.detail as any).graph.error).toMatch(/503/);
	});
	it('flags bad graph credentials and a missing collection', async () => {
		const h = await knowledgeAdapter.health(mkEnv({ vectorKind: 'qdrant', vectorUrl: base, vectorCollection: 'missing', graphKind: 'neo4j', graphUrl: base }, { secrets: { vectorApiKey: 'qkey', graphUser: 'neo', graphPassword: 'wrong' } }));
		expect(h.ok).toBe(false);
		expect(h.message).toContain('"missing" NOT found');
		expect(h.message).toMatch(/graph\(neo4j\): FAIL 401/);
	});
	it('reports graph only when no vector store is configured', async () => {
		const h = await knowledgeAdapter.health(neo());
		expect(h.ok).toBe(true);
		expect(h.message).toBe('vector: not configured · graph(neo4j): ok, database "neo4j"');
	});
});
