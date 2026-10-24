/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * RepoIntelligenceDb — SQLite persistence for the RIAF engine.
 *
 * Driver: the official SQLite WebAssembly build (`@sqlite.org/sqlite-wasm`), which
 * ships FTS5 + bm25(). The database lives in WASM memory; it is loaded from
 * `dbPath` on init (if the file exists) and written back with a debounced export
 * after writes and on close(). Method signatures stay async so callers are
 * insulated from the driver.
 */

import { createHash } from 'crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { Database, Sqlite3Static, SqlValue } from '@sqlite.org/sqlite-wasm';
import { CommandEntry, CodeChunk, CodebaseSearchResult, ExtractedSymbol, FileMetadataEntry, FrameworkEntry, RepoIntelligenceIndexingStats, WorkspaceProfile } from './repoIntelligenceTypes.js';
import { EmbeddingVector, cosineSimilarity, serializeEmbedding, deserializeEmbedding } from './embeddingService.js';
import type { SymbolEdge } from './symbolGraph.js';

const SCHEMA_VERSION = 9;
const DEFAULT_PERSIST_DEBOUNCE_MS = 1000;
const DEFAULT_SNIPPET_CHARS = 400;

type Logger = (msg: string) => void;

/**
 * Loader for the `@sqlite.org/sqlite-wasm` ES module. The package is ESM-only and locates
 * `sqlite3.wasm` via `import.meta.url`, so hosts that bundle this library to CommonJS
 * (e.g. a VS Code extension) must supply a loader that performs a *real* dynamic import of
 * the shipped `node.mjs` by absolute file URL. The default loader is a plain `import()`,
 * which is what Node/ESM consumers and the test-suite use.
 */
export type SqliteModuleLoader = () => Promise<{ default: (opts?: object) => Promise<Sqlite3Static> }>;
let _sqliteLoader: SqliteModuleLoader = () => import('@sqlite.org/sqlite-wasm') as unknown as ReturnType<SqliteModuleLoader>;
let _sqlite3Promise: Promise<Sqlite3Static> | null = null;

/** Override how the sqlite-wasm module is loaded. Must be called before the first DB is opened. */
export const setSqliteModuleLoader = (loader: SqliteModuleLoader): void => {
	_sqliteLoader = loader;
	_sqlite3Promise = null;
};

const loadSqlite = (): Promise<Sqlite3Static> => {
	if (!_sqlite3Promise) {
		// The Node build of sqlite-wasm accepts Emscripten module options; silence its stdout/stderr.
		_sqlite3Promise = _sqliteLoader().then(mod => mod.default({ print: () => { }, printErr: () => { } }));
	}
	return _sqlite3Promise;
};

type Row = Record<string, SqlValue>;
type Params = readonly (string | number | null | Uint8Array | boolean | undefined)[];

const normaliseParams = (params: Params): SqlValue[] =>
	params.map(p => p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p);

/** Minimal synchronous wrapper around a sqlite-wasm `Database`. */
class SqliteHandle {
	constructor(readonly sqlite3: Sqlite3Static, readonly db: Database) { }

	exec(sql: string): void {
		this.db.exec(sql);
	}

	run(sql: string, params: Params = []): void {
		this.db.exec({ sql, bind: normaliseParams(params) });
	}

	all<T>(sql: string, params: Params = []): T[] {
		return this.db.selectObjects(sql, normaliseParams(params)) as unknown as T[];
	}

	get<T>(sql: string, params: Params = []): T | undefined {
		const stmt = this.db.prepare(sql);
		try {
			const bound = normaliseParams(params);
			if (bound.length > 0) stmt.bind(bound);
			if (!stmt.step()) return undefined;
			return stmt.get({}) as unknown as T;
		} finally {
			stmt.finalize();
		}
	}

	inTransaction(): boolean {
		return this.sqlite3.capi.sqlite3_get_autocommit(this.db) === 0;
	}

	export(): Uint8Array {
		return this.sqlite3.capi.sqlite3_js_db_export(this.db);
	}

	close(): void {
		this.db.close();
	}
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace_profiles (
  workspace_hash    TEXT PRIMARY KEY,
  workspace_root    TEXT NOT NULL,
  last_scanned_at   INTEGER NOT NULL,
  language_stack    TEXT NOT NULL,
  frameworks        TEXT NOT NULL,
  package_managers  TEXT NOT NULL,
  build_commands    TEXT NOT NULL,
  test_commands     TEXT NOT NULL,
  lint_commands     TEXT NOT NULL,
  typecheck_commands TEXT NOT NULL,
  project_purpose   TEXT,
  architecture_summary TEXT,
  file_count        INTEGER,
  total_loc         INTEGER,
  stale             INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS file_metadata (
  workspace_hash  TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  language        TEXT,
  last_modified   INTEGER NOT NULL,
  size_bytes      INTEGER,
  PRIMARY KEY (workspace_hash, file_path),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_file_metadata_workspace ON file_metadata(workspace_hash);
CREATE INDEX IF NOT EXISTS idx_file_metadata_language ON file_metadata(workspace_hash, language);

CREATE TABLE IF NOT EXISTS code_chunks (
  id             TEXT PRIMARY KEY,
  workspace_hash   TEXT NOT NULL,
  file_path        TEXT NOT NULL,
  chunk_text       TEXT NOT NULL,
  start_line       INTEGER NOT NULL,
  end_line         INTEGER NOT NULL,
  chunk_type       TEXT NOT NULL,
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_text,
  file_path UNINDEXED,
  workspace_hash UNINDEXED,
  start_line UNINDEXED,
  end_line UNINDEXED,
  chunk_type UNINDEXED
);

CREATE INDEX IF NOT EXISTS idx_code_chunks_workspace ON code_chunks(workspace_hash);
CREATE INDEX IF NOT EXISTS idx_code_chunks_file ON code_chunks(workspace_hash, file_path);

CREATE TABLE IF NOT EXISTS symbols (
  workspace_hash  TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  start_line      INTEGER NOT NULL,
  end_line        INTEGER NOT NULL,
  signature       TEXT,
  docstring       TEXT,
  is_exported     INTEGER NOT NULL DEFAULT 0,
  content_hash    TEXT NOT NULL,
  PRIMARY KEY (workspace_hash, file_path, name, kind),
  FOREIGN KEY (workspace_hash, file_path)
    REFERENCES file_metadata(workspace_hash, file_path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(workspace_hash, name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(workspace_hash, file_path);

CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name,
  signature,
  docstring,
  file_path UNINDEXED,
  workspace_hash UNINDEXED,
  start_line UNINDEXED,
  end_line UNINDEXED
);

-- ── STaaS polyglot extensions ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS java_spring_endpoints (
  workspace_hash    TEXT NOT NULL,
  service_name      TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  http_method       TEXT NOT NULL,
  path_pattern      TEXT NOT NULL,
  controller_class  TEXT NOT NULL,
  handler_method    TEXT NOT NULL,
  request_dto       TEXT,
  response_dto      TEXT,
  PRIMARY KEY (workspace_hash, service_name, http_method, path_pattern),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_endpoints_path ON java_spring_endpoints(workspace_hash, path_pattern);
CREATE INDEX IF NOT EXISTS idx_endpoints_service ON java_spring_endpoints(workspace_hash, service_name);

CREATE TABLE IF NOT EXISTS feign_clients (
  workspace_hash    TEXT NOT NULL,
  caller_service    TEXT NOT NULL,
  target_service    TEXT NOT NULL,
  interface_name    TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  PRIMARY KEY (workspace_hash, caller_service, target_service, interface_name),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_feign_caller ON feign_clients(workspace_hash, caller_service);
CREATE INDEX IF NOT EXISTS idx_feign_target ON feign_clients(workspace_hash, target_service);

CREATE TABLE IF NOT EXISTS maven_dependencies (
  workspace_hash    TEXT NOT NULL,
  consumer_path     TEXT NOT NULL,
  group_id          TEXT NOT NULL,
  artifact_id       TEXT NOT NULL,
  version           TEXT,
  scope             TEXT,
  PRIMARY KEY (workspace_hash, consumer_path, group_id, artifact_id),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_maven_artifact ON maven_dependencies(workspace_hash, artifact_id);
CREATE INDEX IF NOT EXISTS idx_maven_consumer ON maven_dependencies(workspace_hash, consumer_path);

CREATE TABLE IF NOT EXISTS k8s_resources (
  workspace_hash    TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  kind              TEXT NOT NULL,
  name              TEXT NOT NULL,
  namespace         TEXT,
  env_label         TEXT,
  image_tag         TEXT,
  PRIMARY KEY (workspace_hash, file_path, kind, name),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_k8s_kind ON k8s_resources(workspace_hash, kind);
CREATE INDEX IF NOT EXISTS idx_k8s_name ON k8s_resources(workspace_hash, name);

CREATE TABLE IF NOT EXISTS gateway_routes (
  workspace_hash    TEXT NOT NULL,
  route_id          TEXT NOT NULL,
  path_predicate    TEXT NOT NULL,
  target_service    TEXT NOT NULL,
  strip_prefix      INTEGER,
  PRIMARY KEY (workspace_hash, route_id),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_routes_path ON gateway_routes(workspace_hash, path_predicate);

-- ── Phase β: NPM impact + config drift ─────────────────────────────────

CREATE TABLE IF NOT EXISTS npm_package_edges (
  workspace_hash  TEXT NOT NULL,
  consumer_path   TEXT NOT NULL,
  package_name    TEXT NOT NULL,
  version         TEXT,
  dep_type        TEXT,
  PRIMARY KEY (workspace_hash, consumer_path, package_name),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_npm_package ON npm_package_edges(workspace_hash, package_name);
CREATE INDEX IF NOT EXISTS idx_npm_consumer ON npm_package_edges(workspace_hash, consumer_path);

CREATE TABLE IF NOT EXISTS config_env_drift (
  workspace_hash    TEXT NOT NULL,
  service_name      TEXT NOT NULL,
  config_key        TEXT NOT NULL,
  env_values_json   TEXT NOT NULL,
  PRIMARY KEY (workspace_hash, service_name, config_key),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_drift_service ON config_env_drift(workspace_hash, service_name);

-- ── Phase γ: Terraform IaC + GitLab CI (persisted) ───────────────────────

CREATE TABLE IF NOT EXISTS terraform_resources (
  workspace_hash    TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  resource_type     TEXT NOT NULL,
  resource_name     TEXT NOT NULL,
  provider          TEXT NOT NULL,
  PRIMARY KEY (workspace_hash, file_path, resource_type, resource_name),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tf_resource_type ON terraform_resources(workspace_hash, resource_type);
CREATE INDEX IF NOT EXISTS idx_tf_provider ON terraform_resources(workspace_hash, provider);

CREATE TABLE IF NOT EXISTS terraform_modules (
  workspace_hash    TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  module_name       TEXT NOT NULL,
  source            TEXT NOT NULL,
  PRIMARY KEY (workspace_hash, file_path, module_name),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS terraform_index_meta (
  workspace_hash    TEXT PRIMARY KEY,
  file_count        INTEGER NOT NULL,
  providers_json    TEXT NOT NULL,
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pipeline_jobs (
  workspace_hash    TEXT NOT NULL,
  job_name          TEXT NOT NULL,
  stage             TEXT NOT NULL,
  needs_json        TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  PRIMARY KEY (workspace_hash, job_name),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pipeline_stage ON pipeline_jobs(workspace_hash, stage);

CREATE TABLE IF NOT EXISTS pipeline_index_meta (
  workspace_hash    TEXT PRIMARY KEY,
  file_count        INTEGER NOT NULL,
  has_manual_gates  INTEGER NOT NULL,
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);

-- ── Universal Context Graph ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ucg_file_nodes (
  workspace_hash      TEXT NOT NULL,
  file_path           TEXT NOT NULL,
  language            TEXT NOT NULL,
  node_type           TEXT NOT NULL,
  arch_layer          TEXT NOT NULL,
  is_entry_point      INTEGER NOT NULL DEFAULT 0,
  import_count        INTEGER NOT NULL DEFAULT 0,
  imported_by_count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_hash, file_path),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ucg_nodes_layer ON ucg_file_nodes(workspace_hash, arch_layer);

CREATE TABLE IF NOT EXISTS ucg_import_edges (
  workspace_hash      TEXT NOT NULL,
  from_file           TEXT NOT NULL,
  to_module           TEXT NOT NULL,
  resolved_file       TEXT,
  is_external         INTEGER NOT NULL DEFAULT 0,
  edge_type           TEXT NOT NULL,
  PRIMARY KEY (workspace_hash, from_file, to_module),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ucg_edges_from ON ucg_import_edges(workspace_hash, from_file);
CREATE INDEX IF NOT EXISTS idx_ucg_edges_to ON ucg_import_edges(workspace_hash, resolved_file);
CREATE INDEX IF NOT EXISTS idx_ucg_edges_ext ON ucg_import_edges(workspace_hash, is_external);

CREATE TABLE IF NOT EXISTS ucg_graph_metrics (
  workspace_hash      TEXT PRIMARY KEY,
  total_nodes         INTEGER NOT NULL DEFAULT 0,
  total_edges         INTEGER NOT NULL DEFAULT 0,
  entry_count         INTEGER NOT NULL DEFAULT 0,
  cycle_count         INTEGER NOT NULL DEFAULT 0,
  cycles_json         TEXT NOT NULL DEFAULT '[]',
  hot_files_json      TEXT NOT NULL DEFAULT '[]',
  ext_deps_json       TEXT NOT NULL DEFAULT '{}',
  max_depth           INTEGER NOT NULL DEFAULT 0,
  orphan_files_json   TEXT NOT NULL DEFAULT '[]',
  computed_at         INTEGER NOT NULL,
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
`;

type ColumnInfo = { name: string };

export type ChunkLedgerEntry = { contentHash: string; mtimeMs: number | null; sizeBytes: number | null };

type WorkspaceProfileRow = {
	workspace_hash: string;
	workspace_root: string;
	last_scanned_at: number;
	language_stack: string;
	frameworks: string;
	package_managers: string;
	build_commands: string;
	test_commands: string;
	lint_commands: string;
	typecheck_commands: string;
	project_purpose: string | null;
	architecture_summary: string | null;
	file_count: number | null;
	total_loc: number | null;
	stale: number;
};

export type SpringEndpoint = {
	serviceName: string;
	filePath: string;
	httpMethod: string;
	pathPattern: string;
	controllerClass: string;
	handlerMethod: string;
	requestDto?: string;
	responseDto?: string;
};

export type FeignClientEdge = {
	callerService: string;
	targetService: string;
	interfaceName: string;
	filePath: string;
};

export type UCGFileNode = {
	filePath: string;
	language: string;
	nodeType: string;
	archLayer: string;
	isEntryPoint: boolean;
	importCount: number;
	importedByCount: number;
};

export type UCGImportEdge = {
	fromFile: string;
	toModule: string;
	resolvedFile: string | null;
	isExternal: boolean;
	edgeType: string;
};

export type UCGGraphMetrics = {
	totalNodes: number;
	totalEdges: number;
	entryCount: number;
	cycleCount: number;
	cycles: string[][];
	hotFiles: string[];
	externalDeps: Record<string, number>;
	/** Longest distance (in import hops) from an entry point to any reachable file. */
	maxDepth: number;
	/** Files with neither importers nor internal imports. */
	orphanFiles: string[];
	computedAt: number;
};

export type MavenDep = {
	consumerPath: string;
	groupId: string;
	artifactId: string;
	version?: string;
	scope?: string;
};

export type GatewayRoute = {
	routeId: string;
	pathPredicate: string;
	targetService: string;
	stripPrefix: boolean;
};

export type K8sResource = {
	filePath: string;
	kind: string;
	name: string;
	namespace?: string;
	envLabel?: string;
	imageTag?: string;
};

export type NpmPackageEdge = {
	consumerPath: string;
	packageName: string;
	version: string;
	depType: 'dependencies' | 'devDependencies' | 'peerDependencies';
};

export type { EnvDrift } from './configEnvIndexer.js';
export type { TerraformResource, TerraformModule } from './terraformIndexer.js';
export type { PipelineJob } from './gitlabCiIndexer.js';

export type TerraformIndexMeta = {
	fileCount: number;
	providers: string[];
};

export type PipelineIndexMeta = {
	fileCount: number;
	hasManualGates: boolean;
};

export const hashWorkspaceRoot = (workspaceRoot: string): string => {
	return createHash('sha256').update(workspaceRoot).digest('hex');
};

export interface RepoIntelligenceDbOptions {
	/** Debounce window for writing the DB image to disk after a write. Default 1000ms. */
	persistDebounceMs?: number;
	log?: Logger;
}

export class RepoIntelligenceDb {
	private _handle: SqliteHandle | null = null;
	private _initPromise: Promise<void> | null = null;
	private readonly _dbPath: string;
	private readonly _persistDebounceMs: number;
	private readonly _log: Logger;
	private _persistTimer: ReturnType<typeof setTimeout> | null = null;
	private _dirty = false;

	/**
	 * @param dbPath File path used to persist the database image. Pass `':memory:'`
	 *   to keep the DB purely in memory (no disk writes).
	 */
	constructor(dbPath: string, options: RepoIntelligenceDbOptions = {}) {
		this._dbPath = dbPath;
		this._persistDebounceMs = options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;
		this._log = options.log ?? (() => { });
	}

	get dbPath(): string {
		return this._dbPath;
	}

	private get _isMemoryOnly(): boolean {
		return this._dbPath === ':memory:' || this._dbPath === '';
	}

	async init(): Promise<void> {
		if (this._handle) return;
		if (this._initPromise) return this._initPromise;
		this._initPromise = this._doInit().finally(() => { this._initPromise = null; });
		return this._initPromise;
	}

	private async _doInit(): Promise<void> {
		const sqlite3 = await loadSqlite();
		const db = new sqlite3.oo1.DB(':memory:');
		const handle = new SqliteHandle(sqlite3, db);

		if (!this._isMemoryOnly && existsSync(this._dbPath)) {
			try {
				const bytes = readFileSync(this._dbPath);
				if (bytes.length > 0) {
					this._deserializeInto(handle, bytes);
					this._log(`[RepoIntelligence] Loaded DB image (${bytes.length} bytes) from ${this._dbPath}`);
				}
			} catch (err) {
				this._log(`[RepoIntelligence] Could not load DB image, starting fresh: ${String(err)}`);
			}
		}

		handle.exec(SCHEMA);
		this._migrate(handle);
		this._handle = handle;
		this._log(`[RepoIntelligence] DB initialized (${this._isMemoryOnly ? 'in-memory' : this._dbPath})`);
	}

	private _deserializeInto(handle: SqliteHandle, bytes: Uint8Array): void {
		const { sqlite3, db } = handle;
		// Node Buffers share a pooled ArrayBuffer with a non-zero byteOffset, which the
		// WASM allocator does not honour — copy into a standalone Uint8Array first.
		const plain = new Uint8Array(bytes.byteLength);
		plain.set(bytes);
		const p = sqlite3.wasm.allocFromTypedArray(plain);
		const rc = sqlite3.capi.sqlite3_deserialize(
			db,
			'main',
			p,
			bytes.length,
			bytes.length,
			sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
		);
		if (rc !== 0) {
			throw new Error(`sqlite3_deserialize failed with rc=${rc}`);
		}
	}

	/** Serialize the in-memory database and return the raw SQLite file bytes. */
	async export(): Promise<Uint8Array> {
		await this.init();
		return this._getDb().export();
	}

	/** Write the DB image to `dbPath` now (no-op for in-memory DBs or when nothing changed). */
	async flush(): Promise<void> {
		if (this._persistTimer) {
			clearTimeout(this._persistTimer);
			this._persistTimer = null;
		}
		if (!this._handle || this._isMemoryOnly || !this._dirty) return;
		if (this._handle.inTransaction()) {
			// Never snapshot a half-applied transaction — try again later.
			this._schedulePersist();
			return;
		}
		const bytes = this._handle.export();
		const dir = dirname(this._dbPath);
		mkdirSync(dir, { recursive: true });
		const tmp = `${this._dbPath}.tmp-${process.pid}`;
		writeFileSync(tmp, bytes);
		renameSync(tmp, this._dbPath);
		this._dirty = false;
		this._log(`[RepoIntelligence] Persisted DB image (${bytes.length} bytes) to ${this._dbPath}`);
	}

	private _markDirty(): void {
		this._dirty = true;
		if (this._isMemoryOnly) return;
		this._schedulePersist();
	}

	private _schedulePersist(): void {
		if (this._persistTimer) clearTimeout(this._persistTimer);
		this._persistTimer = setTimeout(() => {
			this._persistTimer = null;
			this.flush().catch(err => this._log(`[RepoIntelligence] Persist failed: ${String(err)}`));
		}, this._persistDebounceMs);
		// Don't keep the host process alive just for a pending flush; close() flushes anyway.
		(this._persistTimer as { unref?: () => void }).unref?.();
	}

	async close(): Promise<void> {
		if (!this._handle) return;
		try {
			await this.flush();
		} finally {
			this._handle.close();
			this._handle = null;
		}
	}

	private _getDb(): SqliteHandle {
		if (!this._handle) throw new Error('RepoIntelligenceDb not initialized');
		return this._handle;
	}

	// ── schema migration ─────────────────────────────────────────────────────

	private _migrate(db: SqliteHandle): void {
		const fileMetaColumns = db.all<ColumnInfo>(`PRAGMA table_info(file_metadata)`);
		if (!fileMetaColumns.some(c => c.name === 'content_hash')) {
			db.exec(`ALTER TABLE file_metadata ADD COLUMN content_hash TEXT`);
		}

		this._migrateLegacyKnowledgeGraph(db);
		this._ensureCurrentSymbolsSchema(db);
		this._ensureFtsTable(
			db,
			'chunks_fts',
			`CREATE VIRTUAL TABLE chunks_fts USING fts5(
				chunk_text,
				file_path UNINDEXED,
				workspace_hash UNINDEXED,
				start_line UNINDEXED,
				end_line UNINDEXED,
				chunk_type UNINDEXED
			)`,
			`INSERT INTO chunks_fts (chunk_text, file_path, workspace_hash, start_line, end_line, chunk_type)
			 SELECT chunk_text, file_path, workspace_hash, start_line, end_line, chunk_type FROM code_chunks`,
		);
		this._ensureFtsTable(
			db,
			'symbols_fts',
			`CREATE VIRTUAL TABLE symbols_fts USING fts5(
				name,
				signature,
				docstring,
				file_path UNINDEXED,
				workspace_hash UNINDEXED,
				start_line UNINDEXED,
				end_line UNINDEXED
			)`,
			`INSERT INTO symbols_fts (name, signature, docstring, file_path, workspace_hash, start_line, end_line)
			 SELECT name, signature, docstring, file_path, workspace_hash, start_line, end_line FROM symbols`,
		);

		// v3 migration: STaaS polyglot tables
		this._ensureTable(db, 'java_spring_endpoints',
			`CREATE TABLE IF NOT EXISTS java_spring_endpoints (
				workspace_hash TEXT NOT NULL, service_name TEXT NOT NULL,
				file_path TEXT NOT NULL, http_method TEXT NOT NULL, path_pattern TEXT NOT NULL,
				controller_class TEXT NOT NULL, handler_method TEXT NOT NULL,
				request_dto TEXT, response_dto TEXT,
				PRIMARY KEY (workspace_hash, service_name, http_method, path_pattern)
			)`);
		this._ensureTable(db, 'feign_clients',
			`CREATE TABLE IF NOT EXISTS feign_clients (
				workspace_hash TEXT NOT NULL, caller_service TEXT NOT NULL,
				target_service TEXT NOT NULL, interface_name TEXT NOT NULL, file_path TEXT NOT NULL,
				PRIMARY KEY (workspace_hash, caller_service, target_service, interface_name)
			)`);
		this._ensureTable(db, 'maven_dependencies',
			`CREATE TABLE IF NOT EXISTS maven_dependencies (
				workspace_hash TEXT NOT NULL, consumer_path TEXT NOT NULL,
				group_id TEXT NOT NULL, artifact_id TEXT NOT NULL, version TEXT, scope TEXT,
				PRIMARY KEY (workspace_hash, consumer_path, group_id, artifact_id)
			)`);
		this._ensureTable(db, 'k8s_resources',
			`CREATE TABLE IF NOT EXISTS k8s_resources (
				workspace_hash TEXT NOT NULL, file_path TEXT NOT NULL,
				kind TEXT NOT NULL, name TEXT NOT NULL, namespace TEXT,
				env_label TEXT, image_tag TEXT,
				PRIMARY KEY (workspace_hash, file_path, kind, name)
			)`);
		this._ensureTable(db, 'gateway_routes',
			`CREATE TABLE IF NOT EXISTS gateway_routes (
				workspace_hash TEXT NOT NULL, route_id TEXT NOT NULL,
				path_predicate TEXT NOT NULL, target_service TEXT NOT NULL, strip_prefix INTEGER,
				PRIMARY KEY (workspace_hash, route_id)
			)`);
		this._ensureTable(db, 'npm_package_edges',
			`CREATE TABLE IF NOT EXISTS npm_package_edges (
				workspace_hash TEXT NOT NULL, consumer_path TEXT NOT NULL,
				package_name TEXT NOT NULL, version TEXT, dep_type TEXT,
				PRIMARY KEY (workspace_hash, consumer_path, package_name)
			)`);
		this._ensureTable(db, 'config_env_drift',
			`CREATE TABLE IF NOT EXISTS config_env_drift (
				workspace_hash TEXT NOT NULL, service_name TEXT NOT NULL,
				config_key TEXT NOT NULL, env_values_json TEXT NOT NULL,
				PRIMARY KEY (workspace_hash, service_name, config_key)
			)`);
		this._ensureTable(db, 'terraform_resources',
			`CREATE TABLE IF NOT EXISTS terraform_resources (
				workspace_hash TEXT NOT NULL, file_path TEXT NOT NULL,
				resource_type TEXT NOT NULL, resource_name TEXT NOT NULL, provider TEXT NOT NULL,
				PRIMARY KEY (workspace_hash, file_path, resource_type, resource_name)
			)`);
		this._ensureTable(db, 'terraform_modules',
			`CREATE TABLE IF NOT EXISTS terraform_modules (
				workspace_hash TEXT NOT NULL, file_path TEXT NOT NULL,
				module_name TEXT NOT NULL, source TEXT NOT NULL,
				PRIMARY KEY (workspace_hash, file_path, module_name)
			)`);
		this._ensureTable(db, 'terraform_index_meta',
			`CREATE TABLE IF NOT EXISTS terraform_index_meta (
				workspace_hash TEXT PRIMARY KEY, file_count INTEGER NOT NULL, providers_json TEXT NOT NULL
			)`);
		this._ensureTable(db, 'pipeline_jobs',
			`CREATE TABLE IF NOT EXISTS pipeline_jobs (
				workspace_hash TEXT NOT NULL, job_name TEXT NOT NULL,
				stage TEXT NOT NULL, needs_json TEXT NOT NULL, file_path TEXT NOT NULL,
				PRIMARY KEY (workspace_hash, job_name)
			)`);
		this._ensureTable(db, 'pipeline_index_meta',
			`CREATE TABLE IF NOT EXISTS pipeline_index_meta (
				workspace_hash TEXT PRIMARY KEY, file_count INTEGER NOT NULL, has_manual_gates INTEGER NOT NULL
			)`);

		this._ensureTable(db, 'chunk_file_hashes',
			`CREATE TABLE IF NOT EXISTS chunk_file_hashes (
				workspace_hash  TEXT NOT NULL,
				file_path       TEXT NOT NULL,
				content_hash    TEXT NOT NULL,
				mtime_ms        REAL,
				size_bytes      INTEGER,
				PRIMARY KEY (workspace_hash, file_path)
			)`);
		// v8: the ledger remembers the stat the hash was computed from, so a full reindex can skip
		// unchanged files without re-reading them — and cannot mistake the current scan for "stored".
		if (!this._tableHasColumn(db, 'chunk_file_hashes', 'mtime_ms')) {
			db.exec(`ALTER TABLE chunk_file_hashes ADD COLUMN mtime_ms REAL`);
			db.exec(`ALTER TABLE chunk_file_hashes ADD COLUMN size_bytes INTEGER`);
		}

		this._ensureTable(db, 'ucg_file_nodes',
			`CREATE TABLE IF NOT EXISTS ucg_file_nodes (
				workspace_hash TEXT NOT NULL, file_path TEXT NOT NULL, language TEXT NOT NULL,
				node_type TEXT NOT NULL, arch_layer TEXT NOT NULL, is_entry_point INTEGER NOT NULL DEFAULT 0,
				import_count INTEGER NOT NULL DEFAULT 0, imported_by_count INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (workspace_hash, file_path)
			)`);
		this._ensureTable(db, 'ucg_import_edges',
			`CREATE TABLE IF NOT EXISTS ucg_import_edges (
				workspace_hash TEXT NOT NULL, from_file TEXT NOT NULL, to_module TEXT NOT NULL,
				resolved_file TEXT, is_external INTEGER NOT NULL DEFAULT 0, edge_type TEXT NOT NULL,
				PRIMARY KEY (workspace_hash, from_file, to_module)
			)`);
		this._ensureTable(db, 'ucg_graph_metrics',
			`CREATE TABLE IF NOT EXISTS ucg_graph_metrics (
				workspace_hash TEXT PRIMARY KEY, total_nodes INTEGER NOT NULL DEFAULT 0,
				total_edges INTEGER NOT NULL DEFAULT 0, entry_count INTEGER NOT NULL DEFAULT 0,
				cycle_count INTEGER NOT NULL DEFAULT 0, cycles_json TEXT NOT NULL DEFAULT '[]',
				hot_files_json TEXT NOT NULL DEFAULT '[]', ext_deps_json TEXT NOT NULL DEFAULT '{}',
				computed_at INTEGER NOT NULL
			)`);

		this._ensureTable(db, 'chunk_embeddings',
			`CREATE TABLE IF NOT EXISTS chunk_embeddings (
				workspace_hash  TEXT NOT NULL,
				file_path       TEXT NOT NULL,
				start_line      INTEGER NOT NULL,
				embedding       BLOB NOT NULL,
				PRIMARY KEY (workspace_hash, file_path, start_line)
			)`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_workspace ON chunk_embeddings(workspace_hash)`);

		// v9: real graph depth + orphan list on the metrics row
		if (!this._tableHasColumn(db, 'ucg_graph_metrics', 'max_depth')) {
			db.exec(`ALTER TABLE ucg_graph_metrics ADD COLUMN max_depth INTEGER NOT NULL DEFAULT 0`);
			db.exec(`ALTER TABLE ucg_graph_metrics ADD COLUMN orphan_files_json TEXT NOT NULL DEFAULT '[]'`);
		}

		// v9: symbol-level graph (calls / extends / implements / imports between definitions)
		this._ensureTable(db, 'symbol_edges',
			`CREATE TABLE IF NOT EXISTS symbol_edges (
				workspace_hash TEXT NOT NULL,
				from_file      TEXT NOT NULL,
				from_symbol    TEXT,
				to_name        TEXT NOT NULL,
				to_file        TEXT,
				edge_type      TEXT NOT NULL,
				line           INTEGER NOT NULL
			)`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_symbol_edges_from ON symbol_edges(workspace_hash, from_file)`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_symbol_edges_to_name ON symbol_edges(workspace_hash, to_name)`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_symbol_edges_to_file ON symbol_edges(workspace_hash, to_file)`);

		// Content-addressed embedding cache: keyed by model + hash of the embedded text, independent
		// of file path / workspace, so moved or duplicated chunks never hit the endpoint twice.
		this._ensureTable(db, 'embedding_cache',
			`CREATE TABLE IF NOT EXISTS embedding_cache (
				model       TEXT NOT NULL,
				text_hash   TEXT NOT NULL,
				embedding   BLOB NOT NULL,
				created_at  INTEGER NOT NULL,
				PRIMARY KEY (model, text_hash)
			)`);

		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	}

	/** Drop pre-v2 knowledge-graph tables (symbol_id PK, content-backed FTS, edges/embeddings). */
	private _migrateLegacyKnowledgeGraph(db: SqliteHandle): void {
		const hasLegacySymbols = this._tableExists(db, 'symbols')
			&& this._tableHasColumn(db, 'symbols', 'symbol_id');
		const hasLegacyFts = this._tableExists(db, 'symbols_fts')
			&& !this._ftsSupportsWorkspaceFilter(db, 'symbols_fts');

		if (!hasLegacySymbols && !hasLegacyFts) {
			return;
		}

		this._log('[RepoIntelligence] Migrating legacy symbol schema to v2 format');
		db.exec(`
			DROP TABLE IF EXISTS symbol_embeddings;
			DROP TABLE IF EXISTS symbol_edges;
			DROP TABLE IF EXISTS file_change_log;
			DROP TABLE IF EXISTS symbols_fts;
			DROP TABLE IF EXISTS symbols;
		`);
	}

	private _ensureCurrentSymbolsSchema(db: SqliteHandle): void {
		if (this._tableExists(db, 'symbols')) {
			return;
		}
		db.exec(`
			CREATE TABLE symbols (
				workspace_hash  TEXT NOT NULL,
				file_path       TEXT NOT NULL,
				name            TEXT NOT NULL,
				kind            TEXT NOT NULL,
				start_line      INTEGER NOT NULL,
				end_line        INTEGER NOT NULL,
				signature       TEXT,
				docstring       TEXT,
				is_exported     INTEGER NOT NULL DEFAULT 0,
				content_hash    TEXT NOT NULL,
				PRIMARY KEY (workspace_hash, file_path, name, kind),
				FOREIGN KEY (workspace_hash, file_path)
					REFERENCES file_metadata(workspace_hash, file_path) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(workspace_hash, name);
			CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(workspace_hash, file_path);
		`);
	}

	private _tableExists(db: SqliteHandle, tableName: string): boolean {
		const row = db.get<{ cnt: number }>(
			`SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?`,
			[tableName],
		);
		return (row?.cnt ?? 0) > 0;
	}

	private _tableHasColumn(db: SqliteHandle, tableName: string, columnName: string): boolean {
		const rows = db.all<ColumnInfo>(`PRAGMA table_info(${tableName})`);
		return rows.some(c => c.name === columnName);
	}

	private _ftsSupportsWorkspaceFilter(db: SqliteHandle, tableName: string): boolean {
		try {
			db.run(`DELETE FROM ${tableName} WHERE workspace_hash IS NULL`);
			return true;
		} catch {
			return false;
		}
	}

	private _ensureTable(db: SqliteHandle, tableName: string, createSql: string): void {
		if (!this._tableExists(db, tableName)) {
			db.exec(createSql);
		}
	}

	private _ensureFtsTable(
		db: SqliteHandle,
		tableName: string,
		createSql: string,
		backfillSql: string,
	): void {
		const exists = this._tableExists(db, tableName);
		if (exists && this._ftsSupportsWorkspaceFilter(db, tableName)) {
			return;
		}
		if (exists) {
			this._log(`[RepoIntelligence] Recreating ${tableName} — missing workspace_hash column`);
			db.exec(`DROP TABLE IF EXISTS ${tableName}`);
		}
		db.exec(createSql);
		try {
			db.exec(backfillSql);
		} catch (err) {
			this._log(`[RepoIntelligence] ${tableName} backfill skipped: ${String(err)}`);
		}
	}

	// ── async primitives (sync underneath; kept async so callers don't change) ──

	private async _run(sql: string, params: Params = []): Promise<void> {
		this._getDb().run(sql, params);
		this._markDirty();
	}

	private async _get<T>(sql: string, params: Params = []): Promise<T | undefined> {
		return this._getDb().get<T>(sql, params);
	}

	private async _all<T>(sql: string, params: Params = []): Promise<T[]> {
		return this._getDb().all<T>(sql, params);
	}


	private _rowToProfile(row: WorkspaceProfileRow): WorkspaceProfile {
		return {
			workspaceRoot: row.workspace_root,
			lastScannedAt: row.last_scanned_at,
			languageStack: JSON.parse(row.language_stack),
			frameworks: JSON.parse(row.frameworks) as FrameworkEntry[],
			packageManagers: JSON.parse(row.package_managers),
			buildCommands: JSON.parse(row.build_commands) as CommandEntry[],
			testCommands: JSON.parse(row.test_commands) as CommandEntry[],
			lintCommands: JSON.parse(row.lint_commands) as CommandEntry[],
			typecheckCommands: JSON.parse(row.typecheck_commands) as CommandEntry[],
			projectPurpose: row.project_purpose,
			architectureSummary: row.architecture_summary,
			fileCount: row.file_count ?? 0,
			totalLoc: row.total_loc ?? 0,
			isStale: row.stale === 1,
		};
	}

	async getProfile(workspaceHash: string): Promise<WorkspaceProfile | null> {
		const row = await this._get<WorkspaceProfileRow>(
			`SELECT * FROM workspace_profiles WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return row ? this._rowToProfile(row) : null;
	}

	async getFileMetadata(workspaceHash: string): Promise<FileMetadataEntry[]> {
		type FileMetaRow = {
			file_path: string;
			language: string | null;
			last_modified: number;
			size_bytes: number | null;
		};
		const rows = await this._all<FileMetaRow>(
			`SELECT file_path, language, last_modified, size_bytes FROM file_metadata WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return rows.map(row => ({
			filePath: row.file_path,
			language: row.language,
			lastModified: row.last_modified,
			sizeBytes: row.size_bytes ?? 0,
		}));
	}

	/** Insert or update a single file_metadata row (incremental indexing path). */
	async upsertFileMetadata(workspaceHash: string, file: FileMetadataEntry): Promise<void> {
		await this._run(
			`INSERT INTO file_metadata (workspace_hash, file_path, language, last_modified, size_bytes)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(workspace_hash, file_path) DO UPDATE SET
				language = excluded.language,
				last_modified = excluded.last_modified,
				size_bytes = excluded.size_bytes`,
			[workspaceHash, file.filePath, file.language, file.lastModified, file.sizeBytes],
		);
	}

	async deleteFileMetadata(workspaceHash: string, filePath: string): Promise<void> {
		await this._run(`DELETE FROM file_metadata WHERE workspace_hash = ? AND file_path = ?`, [workspaceHash, filePath]);
	}

	async getFileHashes(workspaceHash: string): Promise<Map<string, string>> {
		const rows = await this._all<{ file_path: string; content_hash: string }>(
			`SELECT file_path, content_hash FROM file_metadata
			 WHERE workspace_hash = ? AND content_hash IS NOT NULL`,
			[workspaceHash],
		);
		return new Map(rows.map(r => [r.file_path, r.content_hash]));
	}

	async upsertFileHash(workspaceHash: string, filePath: string, contentHash: string): Promise<void> {
		await this._run(
			`UPDATE file_metadata SET content_hash = ? WHERE workspace_hash = ? AND file_path = ?`,
			[contentHash, workspaceHash, filePath],
		);
	}

	async replaceSymbolsForFile(workspaceHash: string, filePath: string, symbols: ExtractedSymbol[]): Promise<void> {
		await this._run(`DELETE FROM symbols WHERE workspace_hash = ? AND file_path = ?`, [workspaceHash, filePath]);
		await this._run(`DELETE FROM symbols_fts WHERE workspace_hash = ? AND file_path = ?`, [workspaceHash, filePath]);
		for (const s of symbols) {
			await this._run(
				`INSERT OR REPLACE INTO symbols
				 (workspace_hash, file_path, name, kind, start_line, end_line, signature, docstring, is_exported, content_hash)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[workspaceHash, filePath, s.name, s.kind, s.startLine, s.endLine, s.signature, s.docstring, s.isExported ? 1 : 0, s.contentHash],
			);
			await this._run(
				`INSERT INTO symbols_fts (name, signature, docstring, file_path, workspace_hash, start_line, end_line)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[s.name, s.signature, s.docstring, filePath, workspaceHash, s.startLine, s.endLine],
			);
		}
	}

	async getFileOutline(workspaceHash: string, filePath: string): Promise<ExtractedSymbol[]> {
		type SymbolRow = {
			name: string;
			kind: ExtractedSymbol['kind'];
			file_path: string;
			start_line: number;
			end_line: number;
			signature: string | null;
			docstring: string | null;
			is_exported: number;
			content_hash: string;
		};
		const rows = await this._all<SymbolRow>(
			`SELECT name, kind, file_path, start_line, end_line, signature, docstring, is_exported, content_hash
			 FROM symbols WHERE workspace_hash = ? AND file_path = ?
			 ORDER BY start_line ASC`,
			[workspaceHash, filePath],
		);
		return rows.map(row => ({
			name: row.name,
			kind: row.kind,
			filePath: row.file_path,
			startLine: row.start_line,
			endLine: row.end_line,
			signature: row.signature ?? '',
			docstring: row.docstring ?? '',
			isExported: row.is_exported === 1,
			contentHash: row.content_hash,
		}));
	}

	async getSymbol(workspaceHash: string, filePath: string, symbolName: string): Promise<ExtractedSymbol | null> {
		type SymbolRow = {
			name: string;
			kind: ExtractedSymbol['kind'];
			file_path: string;
			start_line: number;
			end_line: number;
			signature: string | null;
			docstring: string | null;
			is_exported: number;
			content_hash: string;
		};
		const row = await this._get<SymbolRow>(
			`SELECT name, kind, file_path, start_line, end_line, signature, docstring, is_exported, content_hash
			 FROM symbols WHERE workspace_hash = ? AND file_path = ? AND name = ?
			 LIMIT 1`,
			[workspaceHash, filePath, symbolName],
		);
		if (!row) {
			return null;
		}
		return {
			name: row.name,
			kind: row.kind,
			filePath: row.file_path,
			startLine: row.start_line,
			endLine: row.end_line,
			signature: row.signature ?? '',
			docstring: row.docstring ?? '',
			isExported: row.is_exported === 1,
			contentHash: row.content_hash,
		};
	}

	async searchSymbols(workspaceHash: string, query: string, maxResults = 20): Promise<ExtractedSymbol[]> {
		type SymbolRow = {
			name: string;
			kind: ExtractedSymbol['kind'];
			file_path: string;
			start_line: number;
			end_line: number;
			signature: string | null;
			docstring: string | null;
			is_exported: number;
			content_hash: string;
		};
		const mapRow = (row: SymbolRow): ExtractedSymbol => ({
			name: row.name,
			kind: row.kind,
			filePath: row.file_path,
			startLine: row.start_line,
			endLine: row.end_line,
			signature: row.signature ?? '',
			docstring: row.docstring ?? '',
			isExported: row.is_exported === 1,
			contentHash: row.content_hash,
		});

		try {
			const ftsResults = await this._all<SymbolRow>(
				`SELECT s.name, s.kind, s.file_path, s.start_line, s.end_line,
				        s.signature, s.docstring, s.is_exported, s.content_hash
				 FROM symbols_fts f
				 JOIN symbols s ON s.file_path = f.file_path
				  AND s.workspace_hash = f.workspace_hash
				  AND s.name = f.name
				  AND s.start_line = f.start_line
				 WHERE f MATCH ? AND s.workspace_hash = ?
				 ORDER BY rank LIMIT ?`,
				[query.replace(FTS_SPECIAL_CHARS, ' '), workspaceHash, maxResults],
			);
			if (ftsResults.length > 0) {
				return ftsResults.map(mapRow);
			}
		} catch {
			// FTS parse error — fall through to LIKE
		}

		return (await this._all<SymbolRow>(
			`SELECT name, kind, file_path, start_line, end_line, signature, docstring, is_exported, content_hash
			 FROM symbols WHERE workspace_hash = ? AND name LIKE ?
			 LIMIT ?`,
			[workspaceHash, `%${query}%`, maxResults],
		)).map(mapRow);
	}

	async upsertProfile(workspaceHash: string, profile: WorkspaceProfile, fileMeta: FileMetadataEntry[]): Promise<void> {
		await this._run(
			`INSERT INTO workspace_profiles (
				workspace_hash, workspace_root, last_scanned_at, language_stack, frameworks,
				package_managers, build_commands, test_commands, lint_commands, typecheck_commands,
				project_purpose, architecture_summary, file_count, total_loc, stale
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
			ON CONFLICT(workspace_hash) DO UPDATE SET
				workspace_root = excluded.workspace_root,
				last_scanned_at = excluded.last_scanned_at,
				language_stack = excluded.language_stack,
				frameworks = excluded.frameworks,
				package_managers = excluded.package_managers,
				build_commands = excluded.build_commands,
				test_commands = excluded.test_commands,
				lint_commands = excluded.lint_commands,
				typecheck_commands = excluded.typecheck_commands,
				project_purpose = COALESCE(excluded.project_purpose, project_purpose),
				architecture_summary = COALESCE(excluded.architecture_summary, architecture_summary),
				file_count = excluded.file_count,
				total_loc = excluded.total_loc,
				stale = 0`,
			[
				workspaceHash,
				profile.workspaceRoot,
				profile.lastScannedAt,
				JSON.stringify(profile.languageStack),
				JSON.stringify(profile.frameworks),
				JSON.stringify(profile.packageManagers),
				JSON.stringify(profile.buildCommands),
				JSON.stringify(profile.testCommands),
				JSON.stringify(profile.lintCommands),
				JSON.stringify(profile.typecheckCommands),
				profile.projectPurpose,
				profile.architectureSummary,
				profile.fileCount,
				profile.totalLoc,
			],
		);

		await this._run(`DELETE FROM file_metadata WHERE workspace_hash = ?`, [workspaceHash]);
		for (const file of fileMeta) {
			await this._run(
				`INSERT INTO file_metadata (workspace_hash, file_path, language, last_modified, size_bytes)
				 VALUES (?, ?, ?, ?, ?)`,
				[workspaceHash, file.filePath, file.language, file.lastModified, file.sizeBytes],
			);
		}
	}

	async updateSummaries(workspaceHash: string, projectPurpose: string | null, architectureSummary: string | null): Promise<void> {
		await this._run(
			`UPDATE workspace_profiles SET project_purpose = ?, architecture_summary = ? WHERE workspace_hash = ?`,
			[projectPurpose, architectureSummary, workspaceHash],
		);
	}

	async markStale(workspaceHash: string): Promise<void> {
		await this._run(`UPDATE workspace_profiles SET stale = 1 WHERE workspace_hash = ?`, [workspaceHash]);
	}

	async getChunkCount(workspaceHash: string): Promise<number> {
		const row = await this._get<{ count: number }>(
			`SELECT COUNT(*) AS count FROM code_chunks WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return row?.count ?? 0;
	}

	async getDistinctChunkFileCount(workspaceHash: string): Promise<number> {
		const row = await this._get<{ count: number }>(
			`SELECT COUNT(DISTINCT file_path) AS count FROM code_chunks WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return row?.count ?? 0;
	}

	async getIndexingStats(workspaceHash: string): Promise<RepoIntelligenceIndexingStats> {
		const countRow = async (sql: string): Promise<number> => {
			const row = await this._get<{ count: number }>(sql, [workspaceHash]);
			return row?.count ?? 0;
		};

		const groupedCounts = async (sql: string): Promise<Record<string, number>> => {
			const rows = await this._all<{ key: string; count: number }>(sql, [workspaceHash]);
			const result: Record<string, number> = {};
			for (const row of rows) {
				if (row.key) {
					result[row.key] = row.count;
				}
			}
			return result;
		};

		const [
			chunkCount,
			indexedFileCount,
			totalFileCount,
			indexableFileCount,
			symbolCount,
			symbolFileCount,
			chunksByType,
			filesByLanguage,
			chunksByLanguage,
			symbolsByLanguage,
			springEndpoints,
			feignClients,
			mavenDeps,
			k8sResources,
			gatewayRoutes,
			npmEdges,
			configDrift,
			terraformResources,
			pipelineJobs,
		] = await Promise.all([
			countRow(`SELECT COUNT(*) AS count FROM code_chunks WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(DISTINCT file_path) AS count FROM code_chunks WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM file_metadata WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM file_metadata WHERE workspace_hash = ? AND language IS NOT NULL AND language NOT IN ('Markdown', 'JSON', 'YAML', 'TOML', 'HTML', 'CSS', 'SCSS', 'Sass', 'Less')`),
			countRow(`SELECT COUNT(*) AS count FROM symbols WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(DISTINCT file_path) AS count FROM symbols WHERE workspace_hash = ?`),
			groupedCounts(`SELECT chunk_type AS key, COUNT(*) AS count FROM code_chunks WHERE workspace_hash = ? GROUP BY chunk_type`),
			groupedCounts(`SELECT COALESCE(language, 'Unknown') AS key, COUNT(*) AS count FROM file_metadata WHERE workspace_hash = ? GROUP BY language`),
			groupedCounts(
				`SELECT COALESCE(fm.language, 'Unknown') AS key, COUNT(*) AS count
				 FROM code_chunks cc
				 JOIN file_metadata fm ON fm.workspace_hash = cc.workspace_hash AND fm.file_path = cc.file_path
				 WHERE cc.workspace_hash = ?
				 GROUP BY fm.language`,
			),
			groupedCounts(
				`SELECT COALESCE(fm.language, 'Unknown') AS key, COUNT(*) AS count
				 FROM symbols s
				 JOIN file_metadata fm ON fm.workspace_hash = s.workspace_hash AND fm.file_path = s.file_path
				 WHERE s.workspace_hash = ?
				 GROUP BY fm.language`,
			),
			countRow(`SELECT COUNT(*) AS count FROM java_spring_endpoints WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM feign_clients WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM maven_dependencies WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM k8s_resources WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM gateway_routes WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM npm_package_edges WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM config_env_drift WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM terraform_resources WHERE workspace_hash = ?`),
			countRow(`SELECT COUNT(*) AS count FROM pipeline_jobs WHERE workspace_hash = ?`),
		]);

		return {
			chunkCount,
			indexedFileCount,
			totalFileCount,
			indexableFileCount,
			symbolCount,
			symbolFileCount,
			chunksByType,
			filesByLanguage,
			chunksByLanguage,
			symbolsByLanguage,
			springEndpoints,
			feignClients,
			mavenDeps,
			k8sResources,
			gatewayRoutes,
			npmEdges,
			configDrift,
			terraformResources,
			pipelineJobs,
			statsSource: 'database',
		};
	}

	async replaceChunks(workspaceHash: string, chunks: CodeChunk[]): Promise<void> {
		await this._run(`DELETE FROM code_chunks WHERE workspace_hash = ?`, [workspaceHash]);
		await this._run(`DELETE FROM chunks_fts WHERE workspace_hash = ?`, [workspaceHash]);

		if (chunks.length === 0) {
			return;
		}

		await this._run(`BEGIN IMMEDIATE`);
		try {
			for (const chunk of chunks) {
				await this._run(
					`INSERT INTO code_chunks (id, workspace_hash, file_path, chunk_text, start_line, end_line, chunk_type)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					[chunk.id, workspaceHash, chunk.filePath, chunk.chunkText, chunk.startLine, chunk.endLine, chunk.chunkType],
				);
				await this._run(
					`INSERT INTO chunks_fts (chunk_text, file_path, workspace_hash, start_line, end_line, chunk_type)
					 VALUES (?, ?, ?, ?, ?, ?)`,
					[splitIdentifiers(chunk.chunkText), chunk.filePath, workspaceHash, chunk.startLine, chunk.endLine, chunk.chunkType],
				);
			}
			await this._run(`COMMIT`);
		} catch (err) {
			await this._run(`ROLLBACK`).catch(() => { });
			throw err;
		}
	}

	/** Replace chunks for a single file only — used by the incremental rebuild path. */
	async replaceChunksForFile(workspaceHash: string, filePath: string, chunks: CodeChunk[]): Promise<void> {
		await this._run(`BEGIN IMMEDIATE`);
		try {
			await this._run(
				`DELETE FROM code_chunks WHERE workspace_hash = ? AND file_path = ?`,
				[workspaceHash, filePath],
			);
			await this._run(
				`DELETE FROM chunks_fts WHERE workspace_hash = ? AND file_path = ?`,
				[workspaceHash, filePath],
			);
			for (const chunk of chunks) {
				await this._run(
					`INSERT INTO code_chunks (id, workspace_hash, file_path, chunk_text, start_line, end_line, chunk_type)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					[chunk.id, workspaceHash, chunk.filePath, chunk.chunkText, chunk.startLine, chunk.endLine, chunk.chunkType],
				);
				await this._run(
					`INSERT INTO chunks_fts (chunk_text, file_path, workspace_hash, start_line, end_line, chunk_type)
					 VALUES (?, ?, ?, ?, ?, ?)`,
					[splitIdentifiers(chunk.chunkText), chunk.filePath, workspaceHash, chunk.startLine, chunk.endLine, chunk.chunkType],
				);
			}
			await this._run(`COMMIT`);
		} catch (err) {
			await this._run(`ROLLBACK`).catch(() => { });
			throw err;
		}
	}

	async getChunkFileHashes(workspaceHash: string): Promise<Map<string, string>> {
		const rows = await this._all<{ file_path: string; content_hash: string }>(
			`SELECT file_path, content_hash FROM chunk_file_hashes WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return new Map(rows.map(r => [r.file_path, r.content_hash]));
	}

	/** Ledger of hash + the stat it was computed from, keyed by relative path. */
	async getChunkFileLedger(workspaceHash: string): Promise<Map<string, ChunkLedgerEntry>> {
		const rows = await this._all<{ file_path: string; content_hash: string; mtime_ms: number | null; size_bytes: number | null }>(
			`SELECT file_path, content_hash, mtime_ms, size_bytes FROM chunk_file_hashes WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return new Map(rows.map(r => [r.file_path, { contentHash: r.content_hash, mtimeMs: r.mtime_ms, sizeBytes: r.size_bytes }]));
	}

	async getChunkFileHash(workspaceHash: string, filePath: string): Promise<string | undefined> {
		const row = await this._get<{ content_hash: string }>(
			`SELECT content_hash FROM chunk_file_hashes WHERE workspace_hash = ? AND file_path = ?`,
			[workspaceHash, filePath],
		);
		return row?.content_hash;
	}

	async upsertChunkFileHash(workspaceHash: string, filePath: string, contentHash: string, stat?: { mtimeMs: number; sizeBytes: number }): Promise<void> {
		await this._run(
			`INSERT OR REPLACE INTO chunk_file_hashes (workspace_hash, file_path, content_hash, mtime_ms, size_bytes) VALUES (?, ?, ?, ?, ?)`,
			[workspaceHash, filePath, contentHash, stat?.mtimeMs ?? null, stat?.sizeBytes ?? null],
		);
	}

	async deleteChunkFileHash(workspaceHash: string, filePath: string): Promise<void> {
		await this._run(
			`DELETE FROM chunk_file_hashes WHERE workspace_hash = ? AND file_path = ?`,
			[workspaceHash, filePath],
		);
	}

	async searchChunks(workspaceHash: string, query: string, limit: number, snippetMaxLen = DEFAULT_SNIPPET_CHARS): Promise<CodebaseSearchResult[]> {
		const ftsQuery = buildFtsQuery(query);
		if (!ftsQuery) return [];

		type FtsRow = {
			file_path: string;
			start_line: number;
			end_line: number;
			chunk_text: string;
			score: number;
		};

		// chunks_fts stores the identifier-split text used for tokenisation; join back to
		// code_chunks so the snippet returned to callers is the original source text.
		const rows = await this._all<FtsRow>(
			`SELECT chunks_fts.file_path AS file_path, chunks_fts.start_line AS start_line,
			        chunks_fts.end_line AS end_line, cc.chunk_text AS chunk_text,
			        bm25(chunks_fts) AS score
			 FROM chunks_fts
			 JOIN code_chunks cc
			   ON cc.workspace_hash = chunks_fts.workspace_hash
			  AND cc.file_path = chunks_fts.file_path
			  AND cc.start_line = chunks_fts.start_line
			 WHERE chunks_fts MATCH ? AND chunks_fts.workspace_hash = ?
			 ORDER BY score
			 LIMIT ?`,
			[ftsQuery, workspaceHash, limit],
		);

		return rows.map(row => ({
			filePath: row.file_path,
			startLine: row.start_line,
			endLine: row.end_line,
			snippet: truncateSnippet(row.chunk_text, snippetMaxLen),
			score: row.score,
		}));
	}

	// ── vector embedding methods ──────────────────────────────────────────────

	async upsertChunkEmbedding(
		workspaceHash: string,
		filePath: string,
		startLine: number,
		embedding: EmbeddingVector,
	): Promise<void> {
		const blob = serializeEmbedding(embedding);
		await this._run(
			`INSERT OR REPLACE INTO chunk_embeddings (workspace_hash, file_path, start_line, embedding)
			 VALUES (?, ?, ?, ?)`,
			[workspaceHash, filePath, startLine, blob],
		);
	}

	async deleteChunkEmbeddingsForFile(workspaceHash: string, filePath: string): Promise<void> {
		await this._run(
			`DELETE FROM chunk_embeddings WHERE workspace_hash = ? AND file_path = ?`,
			[workspaceHash, filePath],
		);
	}

	async getEmbeddedFiles(workspaceHash: string): Promise<Set<string>> {
		type Row = { file_path: string };
		const rows = await this._all<Row>(
			`SELECT DISTINCT file_path FROM chunk_embeddings WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return new Set(rows.map(r => r.file_path));
	}

	async getChunksWithoutEmbeddings(workspaceHash: string, limit: number): Promise<{ file_path: string; start_line: number; chunk_text: string }[]> {
		type ChunkRow = { file_path: string; start_line: number; chunk_text: string };
		// Per chunk, not per file: a file whose embedding pass was interrupted gets finished later.
		return this._all<ChunkRow>(
			`SELECT c.file_path, c.start_line, c.chunk_text FROM code_chunks c
			 LEFT JOIN chunk_embeddings e
			   ON e.workspace_hash = c.workspace_hash AND e.file_path = c.file_path AND e.start_line = c.start_line
			 WHERE c.workspace_hash = ? AND e.start_line IS NULL
			 LIMIT ?`,
			[workspaceHash, limit],
		);
	}

	/** Every stored chunk embedding for a workspace (to (re)build the in-memory vector index). */
	async getAllChunkEmbeddings(workspaceHash: string): Promise<{ file_path: string; start_line: number; embedding: EmbeddingVector }[]> {
		type Row = { file_path: string; start_line: number; embedding: Uint8Array };
		const rows = await this._all<Row>(
			`SELECT file_path, start_line, embedding FROM chunk_embeddings WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return rows.map(r => ({ file_path: r.file_path, start_line: r.start_line, embedding: deserializeEmbedding(r.embedding) }));
	}

	/** Chunk rows for specific (filePath, startLine) keys — used to hydrate vector hits. */
	async getChunksByKeys(workspaceHash: string, keys: { filePath: string; startLine: number }[]): Promise<Map<string, { file_path: string; start_line: number; end_line: number; chunk_text: string }>> {
		type Row = { file_path: string; start_line: number; end_line: number; chunk_text: string };
		const out = new Map<string, Row>();
		for (let i = 0; i < keys.length; i += 100) {
			const slice = keys.slice(i, i + 100);
			const placeholders = slice.map(() => '(?, ?)').join(', ');
			const rows = await this._all<Row>(
				`SELECT file_path, start_line, end_line, chunk_text FROM code_chunks
				 WHERE workspace_hash = ? AND (file_path, start_line) IN (VALUES ${placeholders})`,
				[workspaceHash, ...slice.flatMap(k => [k.filePath, k.startLine])],
			);
			for (const r of rows) out.set(`${r.file_path}:${r.start_line}`, r);
		}
		return out;
	}

	// ── embedding cache (content-addressed) ──────────────────────────────────

	async getCachedEmbeddings(model: string, textHashes: string[]): Promise<Map<string, EmbeddingVector>> {
		type Row = { text_hash: string; embedding: Uint8Array };
		const out = new Map<string, EmbeddingVector>();
		for (let i = 0; i < textHashes.length; i += 200) {
			const slice = textHashes.slice(i, i + 200);
			const rows = await this._all<Row>(
				`SELECT text_hash, embedding FROM embedding_cache WHERE model = ? AND text_hash IN (${slice.map(() => '?').join(',')})`,
				[model, ...slice],
			);
			for (const r of rows) out.set(r.text_hash, deserializeEmbedding(r.embedding));
		}
		return out;
	}

	async putCachedEmbeddings(model: string, entries: { textHash: string; embedding: EmbeddingVector }[]): Promise<void> {
		const now = Date.now();
		for (const e of entries) {
			await this._run(
				`INSERT OR REPLACE INTO embedding_cache (model, text_hash, embedding, created_at) VALUES (?, ?, ?, ?)`,
				[model, e.textHash, serializeEmbedding(e.embedding), now],
			);
		}
	}

	async getEmbeddingCacheSize(model?: string): Promise<number> {
		type Row = { n: number };
		const rows = model
			? await this._all<Row>(`SELECT COUNT(*) AS n FROM embedding_cache WHERE model = ?`, [model])
			: await this._all<Row>(`SELECT COUNT(*) AS n FROM embedding_cache`, []);
		return rows[0]?.n ?? 0;
	}

	/** Drop cache rows older than `maxAgeMs` (housekeeping after model changes). */
	async pruneEmbeddingCache(maxAgeMs: number): Promise<void> {
		await this._run(`DELETE FROM embedding_cache WHERE created_at < ?`, [Date.now() - maxAgeMs]);
	}

	async getChunksForFile(workspaceHash: string, filePath: string): Promise<{ file_path: string; start_line: number; chunk_text: string }[]> {
		type ChunkRow = { file_path: string; start_line: number; chunk_text: string };
		return this._all<ChunkRow>(
			`SELECT file_path, start_line, chunk_text FROM code_chunks
			 WHERE workspace_hash = ? AND file_path = ?`,
			[workspaceHash, filePath],
		);
	}

	/**
	 * Hybrid BM25 + vector search with Reciprocal Rank Fusion (RRF).
	 *
	 * `vector` is either the query embedding (exhaustive cosine scan — fine for small stores and
	 * the reference implementation) or an already-ranked candidate list from an ANN index.
	 */
	async searchChunksHybrid(
		workspaceHash: string,
		query: string,
		vector: EmbeddingVector | { filePath: string; startLine: number; score: number }[] | null,
		limit: number,
		snippetMaxLen = DEFAULT_SNIPPET_CHARS,
	): Promise<CodebaseSearchResult[]> {
		// BM25 results (rank-indexed)
		const bm25Results = await this.searchChunks(workspaceHash, query, limit * 2, snippetMaxLen);
		const bm25Ranks = new Map<string, number>(); // key = "filePath:startLine"
		bm25Results.forEach((r, idx) => bm25Ranks.set(`${r.filePath}:${r.startLine}`, idx + 1));

		if (!vector || vector.length === 0) return bm25Results.slice(0, limit);

		type VecHit = { filePath: string; startLine: number; endLine: number; snippet: string; sim: number };
		let vecTopK: VecHit[];
		if (typeof vector[0] === 'number') {
			// exhaustive scan
			type EmbRow = { file_path: string; start_line: number; end_line: number; chunk_text: string; embedding: Uint8Array };
			const embRows = await this._all<EmbRow>(
				`SELECT ce.file_path, ce.start_line, cc.end_line, cc.chunk_text, ce.embedding
				 FROM chunk_embeddings ce
				 JOIN code_chunks cc ON cc.workspace_hash = ce.workspace_hash
				   AND cc.file_path = ce.file_path AND cc.start_line = ce.start_line
				 WHERE ce.workspace_hash = ?`,
				[workspaceHash],
			);
			const q = vector as EmbeddingVector;
			vecTopK = embRows.map(r => ({
				filePath: r.file_path, startLine: r.start_line, endLine: r.end_line,
				snippet: truncateSnippet(r.chunk_text, snippetMaxLen), sim: cosineSimilarity(q, deserializeEmbedding(r.embedding)),
			})).sort((a, b) => b.sim - a.sim).slice(0, limit * 2);
		} else {
			// pre-ranked ANN hits → hydrate line ranges and text
			const hits = (vector as { filePath: string; startLine: number; score: number }[]).slice(0, limit * 2);
			const rows = await this.getChunksByKeys(workspaceHash, hits);
			vecTopK = hits.flatMap(h => {
				const r = rows.get(`${h.filePath}:${h.startLine}`);
				return r ? [{ filePath: h.filePath, startLine: h.startLine, endLine: r.end_line, snippet: truncateSnippet(r.chunk_text, snippetMaxLen), sim: h.score }] : [];
			});
		}
		const vecRanks = new Map<string, number>();
		vecTopK.forEach((r, idx) => vecRanks.set(`${r.filePath}:${r.startLine}`, idx + 1));

		// Collect all candidate keys
		const allKeys = new Set([...bm25Ranks.keys(), ...vecRanks.keys()]);
		const K = 60; // RRF constant
		const rrfScores: { key: string; score: number }[] = [];
		for (const key of allKeys) {
			const b = bm25Ranks.get(key);
			const v = vecRanks.get(key);
			let score = 0;
			if (b !== undefined) score += 1 / (K + b);
			if (v !== undefined) score += 1 / (K + v);
			rrfScores.push({ key, score });
		}
		rrfScores.sort((a, b) => b.score - a.score);

		// Build result list from top RRF keys
		const bm25ByKey = new Map(bm25Results.map(r => [`${r.filePath}:${r.startLine}`, r]));
		const vecByKey = new Map(vecTopK.map(r => [`${r.filePath}:${r.startLine}`, r]));
		const final: CodebaseSearchResult[] = [];
		for (const { key, score } of rrfScores.slice(0, limit)) {
			const bm25r = bm25ByKey.get(key);
			if (bm25r) { final.push({ ...bm25r, score }); continue; }
			const vecr = vecByKey.get(key);
			if (vecr) final.push({ filePath: vecr.filePath, startLine: vecr.startLine, endLine: vecr.endLine, snippet: vecr.snippet, score });
		}
		return final;
	}

	// ── α methods ────────────────────────────────────────────────────────────

	async replaceSpringEndpoints(workspaceHash: string, endpoints: SpringEndpoint[]): Promise<void> {
		await this._run(`DELETE FROM java_spring_endpoints WHERE workspace_hash = ?`, [workspaceHash]);
		for (const ep of endpoints) {
			await this._run(
				`INSERT OR REPLACE INTO java_spring_endpoints
					(workspace_hash, service_name, file_path, http_method, path_pattern,
					 controller_class, handler_method, request_dto, response_dto)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[workspaceHash, ep.serviceName, ep.filePath, ep.httpMethod, ep.pathPattern,
					ep.controllerClass, ep.handlerMethod, ep.requestDto ?? null, ep.responseDto ?? null],
			);
		}
	}

	async getSpringEndpoints(workspaceHash: string): Promise<SpringEndpoint[]> {
		type Row = {
			service_name: string; file_path: string; http_method: string;
			path_pattern: string; controller_class: string; handler_method: string;
			request_dto: string | null; response_dto: string | null;
		};
		const rows = await this._all<Row>(
			`SELECT service_name, file_path, http_method, path_pattern,
					controller_class, handler_method, request_dto, response_dto
			 FROM java_spring_endpoints WHERE workspace_hash = ? ORDER BY path_pattern`,
			[workspaceHash],
		);
		return rows.map(r => ({
			serviceName: r.service_name, filePath: r.file_path, httpMethod: r.http_method,
			pathPattern: r.path_pattern, controllerClass: r.controller_class,
			handlerMethod: r.handler_method, requestDto: r.request_dto ?? undefined,
			responseDto: r.response_dto ?? undefined,
		}));
	}

	async replaceFeignClients(workspaceHash: string, clients: FeignClientEdge[]): Promise<void> {
		await this._run(`DELETE FROM feign_clients WHERE workspace_hash = ?`, [workspaceHash]);
		for (const c of clients) {
			await this._run(
				`INSERT OR REPLACE INTO feign_clients
					(workspace_hash, caller_service, target_service, interface_name, file_path)
				 VALUES (?, ?, ?, ?, ?)`,
				[workspaceHash, c.callerService, c.targetService, c.interfaceName, c.filePath],
			);
		}
	}

	async getFeignClients(workspaceHash: string): Promise<FeignClientEdge[]> {
		type Row = { caller_service: string; target_service: string; interface_name: string; file_path: string };
		const rows = await this._all<Row>(
			`SELECT caller_service, target_service, interface_name, file_path
			 FROM feign_clients WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return rows.map(r => ({
			callerService: r.caller_service, targetService: r.target_service,
			interfaceName: r.interface_name, filePath: r.file_path,
		}));
	}

	async replaceMavenDependencies(workspaceHash: string, deps: MavenDep[]): Promise<void> {
		await this._run(`DELETE FROM maven_dependencies WHERE workspace_hash = ?`, [workspaceHash]);
		for (const d of deps) {
			await this._run(
				`INSERT OR REPLACE INTO maven_dependencies
					(workspace_hash, consumer_path, group_id, artifact_id, version, scope)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[workspaceHash, d.consumerPath, d.groupId, d.artifactId, d.version ?? null, d.scope ?? null],
			);
		}
	}

	async getMavenConsumers(workspaceHash: string, artifactId: string): Promise<MavenDep[]> {
		type Row = { consumer_path: string; group_id: string; artifact_id: string; version: string | null; scope: string | null };
		const rows = await this._all<Row>(
			`SELECT consumer_path, group_id, artifact_id, version, scope
			 FROM maven_dependencies WHERE workspace_hash = ? AND artifact_id = ?`,
			[workspaceHash, artifactId],
		);
		return rows.map(r => ({
			consumerPath: r.consumer_path, groupId: r.group_id, artifactId: r.artifact_id,
			version: r.version ?? undefined, scope: r.scope ?? undefined,
		}));
	}

	async getAllMavenDependencies(workspaceHash: string): Promise<MavenDep[]> {
		type Row = { consumer_path: string; group_id: string; artifact_id: string; version: string | null; scope: string | null };
		const rows = await this._all<Row>(
			`SELECT consumer_path, group_id, artifact_id, version, scope
			 FROM maven_dependencies WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return rows.map(r => ({
			consumerPath: r.consumer_path, groupId: r.group_id, artifactId: r.artifact_id,
			version: r.version ?? undefined, scope: r.scope ?? undefined,
		}));
	}

	async replaceGatewayRoutes(workspaceHash: string, routes: GatewayRoute[]): Promise<void> {
		await this._run(`DELETE FROM gateway_routes WHERE workspace_hash = ?`, [workspaceHash]);
		for (const r of routes) {
			await this._run(
				`INSERT OR REPLACE INTO gateway_routes
					(workspace_hash, route_id, path_predicate, target_service, strip_prefix)
				 VALUES (?, ?, ?, ?, ?)`,
				[workspaceHash, r.routeId, r.pathPredicate, r.targetService, r.stripPrefix ? 1 : 0],
			);
		}
	}

	async getGatewayRoutes(workspaceHash: string): Promise<GatewayRoute[]> {
		type Row = { route_id: string; path_predicate: string; target_service: string; strip_prefix: number };
		const rows = await this._all<Row>(
			`SELECT route_id, path_predicate, target_service, strip_prefix
			 FROM gateway_routes WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return rows.map(r => ({
			routeId: r.route_id, pathPredicate: r.path_predicate,
			targetService: r.target_service, stripPrefix: r.strip_prefix === 1,
		}));
	}

	async replaceK8sResources(workspaceHash: string, resources: K8sResource[]): Promise<void> {
		await this._run(`DELETE FROM k8s_resources WHERE workspace_hash = ?`, [workspaceHash]);
		for (const r of resources) {
			await this._run(
				`INSERT OR REPLACE INTO k8s_resources
					(workspace_hash, file_path, kind, name, namespace, env_label, image_tag)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[workspaceHash, r.filePath, r.kind, r.name,
					r.namespace ?? null, r.envLabel ?? null, r.imageTag ?? null],
			);
		}
	}

	async getK8sResources(workspaceHash: string): Promise<K8sResource[]> {
		type Row = { file_path: string; kind: string; name: string; namespace: string | null; env_label: string | null; image_tag: string | null };
		const rows = await this._all<Row>(
			`SELECT file_path, kind, name, namespace, env_label, image_tag
			 FROM k8s_resources WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return rows.map(r => ({
			filePath: r.file_path, kind: r.kind, name: r.name,
			namespace: r.namespace ?? undefined, envLabel: r.env_label ?? undefined,
			imageTag: r.image_tag ?? undefined,
		}));
	}

	async getK8sResourceCount(workspaceHash: string): Promise<number> {
		const row = await this._get<{ count: number }>(
			`SELECT COUNT(*) as count FROM k8s_resources WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return row?.count ?? 0;
	}

	// ── β methods ─────────────────────────────────────────────────────────────

	async replaceNpmEdges(workspaceHash: string, edges: NpmPackageEdge[]): Promise<void> {
		await this._run(`DELETE FROM npm_package_edges WHERE workspace_hash = ?`, [workspaceHash]);
		for (const e of edges) {
			await this._run(
				`INSERT OR REPLACE INTO npm_package_edges
					(workspace_hash, consumer_path, package_name, version, dep_type)
				 VALUES (?, ?, ?, ?, ?)`,
				[workspaceHash, e.consumerPath, e.packageName, e.version, e.depType],
			);
		}
	}

	async getNpmConsumers(workspaceHash: string, packageName: string): Promise<string[]> {
		type Row = { consumer_path: string };
		const rows = await this._all<Row>(
			`SELECT DISTINCT consumer_path FROM npm_package_edges
			 WHERE workspace_hash = ? AND package_name = ?`,
			[workspaceHash, packageName],
		);
		return rows.map(r => r.consumer_path);
	}

	async getAllNpmEdges(workspaceHash: string): Promise<NpmPackageEdge[]> {
		type Row = { consumer_path: string; package_name: string; version: string | null; dep_type: string };
		const rows = await this._all<Row>(
			`SELECT consumer_path, package_name, version, dep_type FROM npm_package_edges WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return rows.map(r => ({
			consumerPath: r.consumer_path,
			packageName: r.package_name,
			version: r.version ?? '',
			depType: r.dep_type as NpmPackageEdge['depType'],
		}));
	}

	async replaceConfigDrift(workspaceHash: string, drifts: import('./configEnvIndexer.js').EnvDrift[]): Promise<void> {
		await this._run(`DELETE FROM config_env_drift WHERE workspace_hash = ?`, [workspaceHash]);
		for (const d of drifts) {
			await this._run(
				`INSERT OR REPLACE INTO config_env_drift
					(workspace_hash, service_name, config_key, env_values_json)
				 VALUES (?, ?, ?, ?)`,
				[workspaceHash, d.serviceName, d.key, JSON.stringify(d.envValues)],
			);
		}
	}

	async getConfigDriftForService(
		workspaceHash: string,
		serviceName: string,
	): Promise<{ key: string; serviceName: string; envValues: Record<string, string> }[]> {
		type Row = { service_name: string; config_key: string; env_values_json: string };
		const rows = await this._all<Row>(
			`SELECT service_name, config_key, env_values_json
			 FROM config_env_drift WHERE workspace_hash = ? AND service_name = ?
			 ORDER BY config_key`,
			[workspaceHash, serviceName],
		);
		return rows.map(r => ({
			key: r.config_key,
			serviceName: r.service_name,
			envValues: JSON.parse(r.env_values_json) as Record<string, string>,
		}));
	}

	async getConfigDriftStats(workspaceHash: string): Promise<{ driftCount: number; topDriftedServices: string[] }> {
		type Row = { service_name: string };
		const rows = await this._all<Row>(
			`SELECT DISTINCT service_name FROM config_env_drift WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		const countRow = await this._get<{ count: number }>(
			`SELECT COUNT(*) AS count FROM config_env_drift WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return {
			driftCount: countRow?.count ?? 0,
			topDriftedServices: rows.map(r => r.service_name).slice(0, 5),
		};
	}

	// ── γ methods (Terraform + GitLab CI) ─────────────────────────────────────

	async replaceTerraformIndex(
		workspaceHash: string,
		result: import('./terraformIndexer.js').TerraformIndexResult,
	): Promise<void> {
		await this._run(`DELETE FROM terraform_resources WHERE workspace_hash = ?`, [workspaceHash]);
		await this._run(`DELETE FROM terraform_modules WHERE workspace_hash = ?`, [workspaceHash]);
		await this._run(`DELETE FROM terraform_index_meta WHERE workspace_hash = ?`, [workspaceHash]);

		for (const r of result.resources) {
			await this._run(
				`INSERT OR REPLACE INTO terraform_resources
					(workspace_hash, file_path, resource_type, resource_name, provider)
				 VALUES (?, ?, ?, ?, ?)`,
				[workspaceHash, r.filePath, r.resourceType, r.resourceName, r.provider],
			);
		}
		for (const m of result.modules) {
			await this._run(
				`INSERT OR REPLACE INTO terraform_modules
					(workspace_hash, file_path, module_name, source)
				 VALUES (?, ?, ?, ?)`,
				[workspaceHash, m.filePath, m.moduleName, m.source],
			);
		}
		if (result.fileCount > 0 || result.resources.length > 0 || result.modules.length > 0) {
			await this._run(
				`INSERT OR REPLACE INTO terraform_index_meta (workspace_hash, file_count, providers_json)
				 VALUES (?, ?, ?)`,
				[workspaceHash, result.fileCount, JSON.stringify(result.providers)],
			);
		}
	}

	async getTerraformResources(workspaceHash: string): Promise<import('./terraformIndexer.js').TerraformResource[]> {
		type Row = { file_path: string; resource_type: string; resource_name: string; provider: string };
		const rows = await this._all<Row>(
			`SELECT file_path, resource_type, resource_name, provider
			 FROM terraform_resources WHERE workspace_hash = ? ORDER BY resource_type, resource_name`,
			[workspaceHash],
		);
		return rows.map(r => ({
			filePath: r.file_path,
			resourceType: r.resource_type,
			resourceName: r.resource_name,
			provider: r.provider,
		}));
	}

	async getTerraformModules(workspaceHash: string): Promise<import('./terraformIndexer.js').TerraformModule[]> {
		type Row = { file_path: string; module_name: string; source: string };
		const rows = await this._all<Row>(
			`SELECT file_path, module_name, source FROM terraform_modules WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return rows.map(r => ({ filePath: r.file_path, moduleName: r.module_name, source: r.source }));
	}

	async getTerraformIndexMeta(workspaceHash: string): Promise<TerraformIndexMeta | null> {
		const row = await this._get<{ file_count: number; providers_json: string }>(
			`SELECT file_count, providers_json FROM terraform_index_meta WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		if (!row) return null;
		return {
			fileCount: row.file_count,
			providers: JSON.parse(row.providers_json) as string[],
		};
	}

	async replacePipelineIndex(
		workspaceHash: string,
		result: import('./gitlabCiIndexer.js').PipelineIndexResult,
	): Promise<void> {
		await this._run(`DELETE FROM pipeline_jobs WHERE workspace_hash = ?`, [workspaceHash]);
		await this._run(`DELETE FROM pipeline_index_meta WHERE workspace_hash = ?`, [workspaceHash]);

		for (const job of result.jobs) {
			await this._run(
				`INSERT OR REPLACE INTO pipeline_jobs
					(workspace_hash, job_name, stage, needs_json, file_path)
				 VALUES (?, ?, ?, ?, ?)`,
				[workspaceHash, job.name, job.stage, JSON.stringify(job.needs), job.filePath],
			);
		}
		if (result.fileCount > 0 || result.jobs.length > 0) {
			await this._run(
				`INSERT OR REPLACE INTO pipeline_index_meta (workspace_hash, file_count, has_manual_gates)
				 VALUES (?, ?, ?)`,
				[workspaceHash, result.fileCount, result.hasManualGates ? 1 : 0],
			);
		}
	}

	async getPipelineJobs(workspaceHash: string): Promise<import('./gitlabCiIndexer.js').PipelineJob[]> {
		type Row = { job_name: string; stage: string; needs_json: string; file_path: string };
		const rows = await this._all<Row>(
			`SELECT job_name, stage, needs_json, file_path FROM pipeline_jobs WHERE workspace_hash = ? ORDER BY stage, job_name`,
			[workspaceHash],
		);
		return rows.map(r => ({
			name: r.job_name,
			stage: r.stage,
			needs: JSON.parse(r.needs_json) as string[],
			filePath: r.file_path,
		}));
	}

	async getPipelineIndexMeta(workspaceHash: string): Promise<PipelineIndexMeta | null> {
		const row = await this._get<{ file_count: number; has_manual_gates: number }>(
			`SELECT file_count, has_manual_gates FROM pipeline_index_meta WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		if (!row) return null;
		return { fileCount: row.file_count, hasManualGates: row.has_manual_gates === 1 };
	}

	// ── Universal Context Graph ───────────────────────────────────────────────

	async replaceUCGNodes(workspaceHash: string, nodes: UCGFileNode[]): Promise<void> {
		await this._run(`DELETE FROM ucg_file_nodes WHERE workspace_hash = ?`, [workspaceHash]);
		for (const n of nodes) {
			await this._run(
				`INSERT OR REPLACE INTO ucg_file_nodes
					(workspace_hash, file_path, language, node_type, arch_layer, is_entry_point, import_count, imported_by_count)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[workspaceHash, n.filePath, n.language, n.nodeType, n.archLayer,
					n.isEntryPoint ? 1 : 0, n.importCount, n.importedByCount],
			);
		}
	}

	async replaceUCGEdges(workspaceHash: string, edges: UCGImportEdge[]): Promise<void> {
		await this._run(`DELETE FROM ucg_import_edges WHERE workspace_hash = ?`, [workspaceHash]);
		for (const e of edges) {
			await this._run(
				`INSERT OR REPLACE INTO ucg_import_edges
					(workspace_hash, from_file, to_module, resolved_file, is_external, edge_type)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[workspaceHash, e.fromFile, e.toModule, e.resolvedFile, e.isExternal ? 1 : 0, e.edgeType],
			);
		}
	}

	async upsertUCGNode(workspaceHash: string, n: UCGFileNode): Promise<void> {
		await this._run(
			`INSERT OR REPLACE INTO ucg_file_nodes
				(workspace_hash, file_path, language, node_type, arch_layer, is_entry_point, import_count, imported_by_count)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[workspaceHash, n.filePath, n.language, n.nodeType, n.archLayer,
				n.isEntryPoint ? 1 : 0, n.importCount, n.importedByCount],
		);
	}

	async deleteUCGNode(workspaceHash: string, filePath: string): Promise<void> {
		await this._run(`DELETE FROM ucg_file_nodes WHERE workspace_hash = ? AND file_path = ?`, [workspaceHash, filePath]);
	}

	/** Replace the outgoing edges of one file (incremental indexing path). */
	async replaceUCGEdgesForFile(workspaceHash: string, filePath: string, edges: UCGImportEdge[]): Promise<void> {
		await this._run(`DELETE FROM ucg_import_edges WHERE workspace_hash = ? AND from_file = ?`, [workspaceHash, filePath]);
		for (const e of edges) {
			await this._run(
				`INSERT OR REPLACE INTO ucg_import_edges
					(workspace_hash, from_file, to_module, resolved_file, is_external, edge_type)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[workspaceHash, e.fromFile, e.toModule, e.resolvedFile, e.isExternal ? 1 : 0, e.edgeType],
			);
		}
	}

	/** Mark edges that resolved to `filePath` as unresolved (the target was deleted). */
	async unresolveEdgesTo(workspaceHash: string, filePath: string): Promise<void> {
		await this._run(
			`UPDATE ucg_import_edges SET resolved_file = NULL WHERE workspace_hash = ? AND resolved_file = ?`,
			[workspaceHash, filePath],
		);
	}

	/** Internal edges whose target could not be placed in the workspace (dangling / not-yet-created). */
	async getUnresolvedEdges(workspaceHash: string): Promise<UCGImportEdge[]> {
		type Row = { from_file: string; to_module: string; edge_type: string };
		const rows = await this._all<Row>(
			`SELECT from_file, to_module, edge_type FROM ucg_import_edges
			 WHERE workspace_hash = ? AND resolved_file IS NULL AND is_external = 0`,
			[workspaceHash],
		);
		return rows.map(r => ({ fromFile: r.from_file, toModule: r.to_module, resolvedFile: null, isExternal: false, edgeType: r.edge_type }));
	}

	async setEdgeResolution(workspaceHash: string, fromFile: string, toModule: string, resolvedFile: string | null): Promise<void> {
		await this._run(
			`UPDATE ucg_import_edges SET resolved_file = ? WHERE workspace_hash = ? AND from_file = ? AND to_module = ?`,
			[resolvedFile, workspaceHash, fromFile, toModule],
		);
	}

	/** Recompute imported_by_count for every node from the current edge table. */
	async refreshUCGImportedByCounts(workspaceHash: string): Promise<void> {
		await this._run(
			`UPDATE ucg_file_nodes SET imported_by_count = (
				SELECT COUNT(*) FROM ucg_import_edges e
				WHERE e.workspace_hash = ucg_file_nodes.workspace_hash AND e.resolved_file = ucg_file_nodes.file_path
			) WHERE workspace_hash = ?`,
			[workspaceHash],
		);
	}

	async upsertUCGMetrics(workspaceHash: string, metrics: UCGGraphMetrics): Promise<void> {
		await this._run(
			`INSERT OR REPLACE INTO ucg_graph_metrics
				(workspace_hash, total_nodes, total_edges, entry_count, cycle_count,
				 cycles_json, hot_files_json, ext_deps_json, max_depth, orphan_files_json, computed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				workspaceHash,
				metrics.totalNodes,
				metrics.totalEdges,
				metrics.entryCount,
				metrics.cycleCount,
				JSON.stringify(metrics.cycles),
				JSON.stringify(metrics.hotFiles),
				JSON.stringify(metrics.externalDeps),
				metrics.maxDepth ?? 0,
				JSON.stringify(metrics.orphanFiles ?? []),
				metrics.computedAt,
			],
		);
	}

	// ── symbol graph ─────────────────────────────────────────────────────────

	private _mapSymbolEdge = (r: { from_file: string; from_symbol: string | null; to_name: string; to_file: string | null; edge_type: string; line: number }): SymbolEdge => ({
		fromFile: r.from_file, fromSymbol: r.from_symbol, toName: r.to_name, toFile: r.to_file, edgeType: r.edge_type as SymbolEdge['edgeType'], line: r.line,
	});

	async replaceSymbolEdgesForFile(workspaceHash: string, filePath: string, edges: SymbolEdge[]): Promise<void> {
		await this._run(`DELETE FROM symbol_edges WHERE workspace_hash = ? AND from_file = ?`, [workspaceHash, filePath]);
		await this._insertSymbolEdges(workspaceHash, edges);
	}

	async replaceAllSymbolEdges(workspaceHash: string, edges: SymbolEdge[]): Promise<void> {
		await this._run(`DELETE FROM symbol_edges WHERE workspace_hash = ?`, [workspaceHash]);
		await this._insertSymbolEdges(workspaceHash, edges);
	}

	private async _insertSymbolEdges(workspaceHash: string, edges: SymbolEdge[]): Promise<void> {
		const BATCH = 200;
		for (let i = 0; i < edges.length; i += BATCH) {
			const slice = edges.slice(i, i + BATCH);
			const placeholders = slice.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
			const params: (string | number | null)[] = [];
			for (const e of slice) params.push(workspaceHash, e.fromFile, e.fromSymbol, e.toName, e.toFile, e.edgeType, e.line);
			await this._run(`INSERT INTO symbol_edges (workspace_hash, from_file, from_symbol, to_name, to_file, edge_type, line) VALUES ${placeholders}`, params);
		}
	}

	/** Targets that pointed at a deleted file keep the name but lose the file. */
	async unresolveSymbolEdgesTo(workspaceHash: string, filePath: string): Promise<void> {
		await this._run(`UPDATE symbol_edges SET to_file = NULL WHERE workspace_hash = ? AND to_file = ?`, [workspaceHash, filePath]);
	}

	/** Edges from other files that name a symbol now defined in `filePath` (after a file was created). */
	async reresolveSymbolEdgesTo(workspaceHash: string, filePath: string, names: string[]): Promise<void> {
		if (!names.length) return;
		const BATCH = 100;
		for (let i = 0; i < names.length; i += BATCH) {
			const slice = names.slice(i, i + BATCH);
			await this._run(
				`UPDATE symbol_edges SET to_file = ? WHERE workspace_hash = ? AND to_file IS NULL AND to_name IN (${slice.map(() => '?').join(', ')})`,
				[filePath, workspaceHash, ...slice],
			);
		}
	}

	/** All edges whose target is `filePath` (optionally one symbol in it), plus unresolved edges by name. */
	async getSymbolEdgesTo(workspaceHash: string, filePath: string | null, toName?: string, limit = 500): Promise<SymbolEdge[]> {
		const where: string[] = ['workspace_hash = ?'];
		const params: (string | number)[] = [workspaceHash];
		if (filePath && toName) { where.push('(to_file = ? OR to_file IS NULL)'); params.push(filePath); }
		else if (filePath) { where.push('to_file = ?'); params.push(filePath); }
		if (toName) { where.push('to_name = ?'); params.push(toName); }
		const rows = await this._all<{ from_file: string; from_symbol: string | null; to_name: string; to_file: string | null; edge_type: string; line: number }>(
			`SELECT from_file, from_symbol, to_name, to_file, edge_type, line FROM symbol_edges
			 WHERE ${where.join(' AND ')} ORDER BY from_file, line LIMIT ?`,
			[...params, limit],
		);
		return rows.map(this._mapSymbolEdge);
	}

	async getSymbolEdgesFrom(workspaceHash: string, filePath: string, fromSymbol?: string, limit = 500): Promise<SymbolEdge[]> {
		const where = ['workspace_hash = ?', 'from_file = ?'];
		const params: (string | number)[] = [workspaceHash, filePath];
		if (fromSymbol) { where.push('(from_symbol = ? OR from_symbol LIKE ?)'); params.push(fromSymbol, `%.${fromSymbol}`); }
		const rows = await this._all<{ from_file: string; from_symbol: string | null; to_name: string; to_file: string | null; edge_type: string; line: number }>(
			`SELECT from_file, from_symbol, to_name, to_file, edge_type, line FROM symbol_edges
			 WHERE ${where.join(' AND ')} ORDER BY line LIMIT ?`,
			[...params, limit],
		);
		return rows.map(this._mapSymbolEdge);
	}

	async getSymbolEdgeCount(workspaceHash: string): Promise<number> {
		const row = await this._get<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM symbol_edges WHERE workspace_hash = ?`, [workspaceHash]);
		return row?.cnt ?? 0;
	}

	/** name → defining files, for the whole workspace (used by the full graph pass). */
	async getSymbolDefinerIndex(workspaceHash: string): Promise<Map<string, string[]>> {
		const rows = await this._all<{ name: string; file_path: string }>(
			`SELECT DISTINCT name, file_path FROM symbols WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		const out = new Map<string, string[]>();
		for (const r of rows) {
			const simple = r.name.includes('.') ? r.name.split('.').pop()! : r.name;
			const list = out.get(simple) ?? [];
			if (!list.includes(r.file_path)) list.push(r.file_path);
			out.set(simple, list);
		}
		return out;
	}

	async getSymbolsByName(workspaceHash: string, name: string, filePath?: string): Promise<ExtractedSymbol[]> {
		type SymbolRow = { name: string; kind: ExtractedSymbol['kind']; file_path: string; start_line: number; end_line: number; signature: string | null; docstring: string | null; is_exported: number; content_hash: string };
		const rows = await this._all<SymbolRow>(
			`SELECT name, kind, file_path, start_line, end_line, signature, docstring, is_exported, content_hash
			 FROM symbols WHERE workspace_hash = ? AND (name = ? OR name LIKE ?)${filePath ? ' AND file_path = ?' : ''}
			 ORDER BY is_exported DESC, file_path, start_line LIMIT 50`,
			filePath ? [workspaceHash, name, `%.${name}`, filePath] : [workspaceHash, name, `%.${name}`],
		);
		return rows.map(row => ({
			name: row.name, kind: row.kind, filePath: row.file_path, startLine: row.start_line, endLine: row.end_line,
			signature: row.signature ?? '', docstring: row.docstring ?? '', isExported: row.is_exported === 1, contentHash: row.content_hash,
		}));
	}

	/** Returns edges where `fromFile` is the given file (what it imports). */
	async getImportEdgesFrom(workspaceHash: string, filePath: string): Promise<UCGImportEdge[]> {
		type Row = { from_file: string; to_module: string; resolved_file: string | null; is_external: number; edge_type: string };
		const rows = await this._all<Row>(
			`SELECT from_file, to_module, resolved_file, is_external, edge_type
			 FROM ucg_import_edges WHERE workspace_hash = ? AND from_file = ?`,
			[workspaceHash, filePath],
		);
		return rows.map(r => ({
			fromFile: r.from_file, toModule: r.to_module, resolvedFile: r.resolved_file,
			isExternal: r.is_external === 1, edgeType: r.edge_type,
		}));
	}

	/** Returns edges where `resolved_file` is the given file (who imports it). */
	async getImportEdgesTo(workspaceHash: string, filePath: string): Promise<UCGImportEdge[]> {
		type Row = { from_file: string; to_module: string; resolved_file: string | null; is_external: number; edge_type: string };
		const rows = await this._all<Row>(
			`SELECT from_file, to_module, resolved_file, is_external, edge_type
			 FROM ucg_import_edges WHERE workspace_hash = ? AND resolved_file = ?`,
			[workspaceHash, filePath],
		);
		return rows.map(r => ({
			fromFile: r.from_file, toModule: r.to_module, resolvedFile: r.resolved_file,
			isExternal: r.is_external === 1, edgeType: r.edge_type,
		}));
	}

	async getUCGNodeCount(workspaceHash: string): Promise<number> {
		const row = await this._get<{ count: number }>(
			`SELECT COUNT(*) AS count FROM ucg_file_nodes WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		return row?.count ?? 0;
	}

	async getUCGGraph(workspaceHash: string): Promise<{ nodes: UCGFileNode[]; edges: UCGImportEdge[] }> {
		type NodeRow = {
			file_path: string;
			language: string;
			node_type: string;
			arch_layer: string;
			is_entry_point: number;
			import_count: number;
			imported_by_count: number;
		};
		type EdgeRow = {
			from_file: string;
			to_module: string;
			resolved_file: string | null;
			is_external: number;
			edge_type: string;
		};

		const [nodeRows, edgeRows] = await Promise.all([
			this._all<NodeRow>(
				`SELECT file_path, language, node_type, arch_layer, is_entry_point, import_count, imported_by_count
				 FROM ucg_file_nodes WHERE workspace_hash = ?`,
				[workspaceHash],
			),
			this._all<EdgeRow>(
				`SELECT from_file, to_module, resolved_file, is_external, edge_type
				 FROM ucg_import_edges WHERE workspace_hash = ?`,
				[workspaceHash],
			),
		]);

		return {
			nodes: nodeRows.map(r => ({
				filePath: r.file_path,
				language: r.language,
				nodeType: r.node_type,
				archLayer: r.arch_layer,
				isEntryPoint: r.is_entry_point === 1,
				importCount: r.import_count,
				importedByCount: r.imported_by_count,
			})),
			edges: edgeRows.map(r => ({
				fromFile: r.from_file,
				toModule: r.to_module,
				resolvedFile: r.resolved_file,
				isExternal: r.is_external === 1,
				edgeType: r.edge_type,
			})),
		};
	}

	async getUCGMetrics(workspaceHash: string): Promise<UCGGraphMetrics | null> {
		const row = await this._get<{
			total_nodes: number;
			total_edges: number;
			entry_count: number;
			cycle_count: number;
			cycles_json: string;
			hot_files_json: string;
			ext_deps_json: string;
			max_depth: number;
			orphan_files_json: string;
			computed_at: number;
		}>(
			`SELECT total_nodes, total_edges, entry_count, cycle_count,
			        cycles_json, hot_files_json, ext_deps_json, max_depth, orphan_files_json, computed_at
			 FROM ucg_graph_metrics WHERE workspace_hash = ?`,
			[workspaceHash],
		);
		if (!row) {
			return null;
		}
		return {
			totalNodes: row.total_nodes,
			totalEdges: row.total_edges,
			entryCount: row.entry_count,
			cycleCount: row.cycle_count,
			cycles: JSON.parse(row.cycles_json) as string[][],
			hotFiles: JSON.parse(row.hot_files_json) as string[],
			externalDeps: JSON.parse(row.ext_deps_json) as Record<string, number>,
			maxDepth: row.max_depth ?? 0,
			orphanFiles: JSON.parse(row.orphan_files_json ?? '[]') as string[],
			computedAt: row.computed_at,
		};
	}
}

const truncateSnippet = (text: string, maxLen: number): string => {
	if (!Number.isFinite(maxLen) || maxLen <= 0 || text.length <= maxLen) return text;
	return text.slice(0, maxLen) + '…';
};

const FTS_SPECIAL_CHARS = /["\-^*():]/g;

/**
 * Pre-process identifiers so SQLite's FTS tokenizer can find them.
 * Splits camelCase, PascalCase, snake_case, kebab-case, and dot.notation into
 * separate tokens, allowing queries like "order controller" to match OrderController.
 */
export const splitIdentifiers = (text: string): string => {
	return text
		// camelCase → camel Case
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		// PascalCase sequences → Pascal Case
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		// snake_case → snake case
		.replace(/_/g, ' ')
		// kebab-case in identifiers → kebab case
		.replace(/([a-zA-Z])-([a-zA-Z])/g, '$1 $2')
		// dot.notation → dot notation
		.replace(/([a-zA-Z])\.([a-zA-Z])/g, '$1 $2');
};

/** Build an FTS5 MATCH expression: identifier-split, lower-cased prefix tokens OR'd together. */
export const buildFtsQuery = (query: string): string | null => {
	const tokens = splitIdentifiers(query)
		.toLowerCase()
		.replace(FTS_SPECIAL_CHARS, ' ')
		.split(/\s+/)
		.filter(t => t.length >= 2);

	if (tokens.length === 0) return null;
	return tokens.map(t => `"${t}"*`).join(' OR ');
};
