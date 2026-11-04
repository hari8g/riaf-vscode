/**
 * RIAF 2.0 tables, kept in the same SQLite image as the index (`.riaf/index.sqlite`).
 * One database per repository, so these tables carry no workspace column.
 */
import type { RepoIntelligenceDb } from '../repoIntelligenceDb.js';

export const V2_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS r2_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS git_commit (
	sha TEXT PRIMARY KEY,
	author_hash TEXT NOT NULL,
	author_name TEXT,
	ts INTEGER NOT NULL,
	subject TEXT NOT NULL,
	body TEXT NOT NULL DEFAULT '',
	parents INTEGER NOT NULL DEFAULT 1,
	file_count INTEGER NOT NULL DEFAULT 0,
	is_noise INTEGER NOT NULL DEFAULT 0,
	noise_reason TEXT,
	unit_id TEXT,
	intent_class TEXT,
	ticket_ids TEXT NOT NULL DEFAULT '[]',
	why TEXT,
	seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_git_commit_ts ON git_commit(ts);
CREATE INDEX IF NOT EXISTS idx_git_commit_unit ON git_commit(unit_id);

CREATE TABLE IF NOT EXISTS git_commit_file (
	sha TEXT NOT NULL,
	path TEXT NOT NULL,
	added INTEGER NOT NULL DEFAULT 0,
	deleted INTEGER NOT NULL DEFAULT 0,
	old_path TEXT,
	PRIMARY KEY (sha, path)
);
CREATE INDEX IF NOT EXISTS idx_git_commit_file_path ON git_commit_file(path);

CREATE TABLE IF NOT EXISTS co_change (
	a TEXT NOT NULL,
	b TEXT NOT NULL,
	support INTEGER NOT NULL,
	weight REAL NOT NULL,
	score REAL NOT NULL,
	confidence REAL NOT NULL,
	PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS idx_co_change_b ON co_change(b);

CREATE TABLE IF NOT EXISTS ownership (
	path TEXT NOT NULL,
	author_hash TEXT NOT NULL,
	lines INTEGER NOT NULL DEFAULT 0,
	commits INTEGER NOT NULL DEFAULT 0,
	commits_12m INTEGER NOT NULL DEFAULT 0,
	last_ts INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (path, author_hash)
);

CREATE TABLE IF NOT EXISTS file_churn (
	path TEXT PRIMARY KEY,
	commits INTEGER NOT NULL,
	commits_90d INTEGER NOT NULL,
	commits_365d INTEGER NOT NULL,
	lines_changed INTEGER NOT NULL,
	fixes INTEGER NOT NULL,
	first_ts INTEGER NOT NULL,
	last_ts INTEGER NOT NULL,
	first_sha TEXT,
	hotspot REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS decision (
	id TEXT PRIMARY KEY,
	source TEXT NOT NULL,
	ref TEXT NOT NULL,
	text TEXT NOT NULL,
	paths TEXT NOT NULL DEFAULT '[]',
	ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS summary_node (
	node_type TEXT NOT NULL,
	node_id TEXT NOT NULL,
	hash TEXT NOT NULL,
	text TEXT NOT NULL,
	model TEXT NOT NULL,
	PRIMARY KEY (node_type, node_id)
);

CREATE TABLE IF NOT EXISTS pack (
	pack_id TEXT PRIMARY KEY,
	intent_key TEXT NOT NULL,
	head TEXT,
	created_at INTEGER NOT NULL,
	intent_json TEXT NOT NULL,
	budget INTEGER NOT NULL,
	used INTEGER NOT NULL,
	json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pack_intent ON pack(intent_key, created_at);

CREATE TABLE IF NOT EXISTS pack_item (
	pack_id TEXT NOT NULL,
	ord INTEGER NOT NULL,
	kind TEXT NOT NULL,
	path TEXT,
	score REAL NOT NULL,
	tokens INTEGER NOT NULL,
	why TEXT NOT NULL,
	PRIMARY KEY (pack_id, ord)
);

CREATE TABLE IF NOT EXISTS tool_cache (
	key_hash TEXT PRIMARY KEY,
	tool TEXT NOT NULL,
	args_norm TEXT NOT NULL,
	blob_hashes TEXT NOT NULL,
	result TEXT NOT NULL,
	ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_metric (
	session_id TEXT PRIMARY KEY,
	host TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	counters TEXT NOT NULL
);
`;

export class V2Store {
	constructor(readonly db: RepoIntelligenceDb) {
		db.raw.exec(SCHEMA);
		const v = this.getKv('schema.version');
		if (v !== String(V2_SCHEMA_VERSION)) this.setKv('schema.version', String(V2_SCHEMA_VERSION));
	}

	get raw() { return this.db.raw; }

	getKv(k: string): string | undefined {
		return this.db.raw.get<{ v: string }>('SELECT v FROM r2_kv WHERE k = ?', [k])?.v;
	}

	setKv(k: string, v: string): void {
		this.db.raw.run('INSERT INTO r2_kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', [k, v]);
	}

	deleteKv(k: string): void {
		this.db.raw.run('DELETE FROM r2_kv WHERE k = ?', [k]);
	}
}
