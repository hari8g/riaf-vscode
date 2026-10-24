/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { writeFileSync, rmSync } from 'fs';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { chunkFile } from '../src/codeChunker.js';
import { hashWorkspaceRoot, RepoIntelligenceDb } from '../src/repoIntelligenceDb.js';

describe('Trove - codeChunker', () => {

	const workspaceHash = hashWorkspaceRoot('/tmp/test-workspace');

	it('chunks TypeScript functions and classes', () => {
		const content = [
			'export function foo() {',
			'  return 1;',
			'}',
			'',
			'export class Bar {',
			'  baz() {',
			'    return 2;',
			'  }',
			'}',
		].join('\n');

		const chunks = chunkFile(workspaceHash, 'src/example.ts', content, 'TypeScript');
		assert.ok(chunks.length >= 2);
		assert.ok(chunks.some(c => c.chunkType === 'function'));
		assert.ok(chunks.some(c => c.chunkType === 'class'));
	});

	it('skips markdown files', () => {
		const chunks = chunkFile(workspaceHash, 'README.md', '# Title\n\nSome text.', 'Markdown');
		assert.strictEqual(chunks.length, 0);
	});

	it('falls back to file chunk when no boundaries found', () => {
		const content = 'const x = 1;\nconst y = 2;\nconst z = 3;\n';
		const chunks = chunkFile(workspaceHash, 'plain.js', content, 'JavaScript');
		assert.strictEqual(chunks.length, 1);
		assert.strictEqual(chunks[0].chunkType, 'file');
	});
});

describe('Trove - repoIntelligenceDb chunks', () => {

	let db: RepoIntelligenceDb;
	const workspaceHash = hashWorkspaceRoot('/tmp/phase3-test');
	const dbPath = join(tmpdir(), `trove-phase3-test-${randomBytes(8).toString('hex')}.db`);

	beforeAll(async () => {
		db = new RepoIntelligenceDb(dbPath);
		await db.init();

		await db.upsertProfile(workspaceHash, {
			workspaceRoot: '/tmp/phase3-test',
			lastScannedAt: Date.now(),
			languageStack: ['TypeScript'],
			frameworks: [],
			packageManagers: [],
			buildCommands: [],
			testCommands: [],
			lintCommands: [],
			typecheckCommands: [],
			projectPurpose: null,
			architectureSummary: null,
			fileCount: 1,
			totalLoc: 10,
			isStale: false,
		}, []);

		await db.replaceChunks(workspaceHash, [{
			id: 'chunk-1',
			filePath: 'src/auth/login.ts',
			chunkText: 'export async function authenticateUser(credentials: Credentials) {\n  return validateSession(credentials);\n}',
			startLine: 1,
			endLine: 3,
			chunkType: 'function',
		}, {
			id: 'chunk-2',
			filePath: 'src/ipc/channel.ts',
			chunkText: 'mainProcessElectronServer.registerChannel("trove-channel-repoIntelligence", repoIntelligenceChannel);',
			startLine: 10,
			endLine: 12,
			chunkType: 'block',
		}]);
	});

	afterAll(async () => {
		await db.close();
	});

	it('searchChunks finds authentication-related code', async () => {
		const results = await db.searchChunks(workspaceHash, 'authenticate session', 5);
		assert.ok(results.length >= 1);
		assert.ok(results[0].filePath.includes('auth'));
	});

	it('searchChunks finds IPC channel registration', async () => {
		const results = await db.searchChunks(workspaceHash, 'registerChannel repoIntelligence', 5);
		assert.ok(results.length >= 1);
		assert.ok(results[0].filePath.includes('channel'));
	});

	it('searchChunks returns empty for nonsense query', async () => {
		const results = await db.searchChunks(workspaceHash, 'xyzzy quantum entanglement', 5);
		assert.strictEqual(results.length, 0);
	});

	it('getChunkCount returns indexed chunk total', async () => {
		const count = await db.getChunkCount(workspaceHash);
		assert.strictEqual(count, 2);
	});
});

describe('Trove - repoIntelligenceDb legacy migration', () => {

	it('migrates legacy symbol_id schema and symbols_fts without workspace_hash', async () => {
		const legacyPath = join(tmpdir(), `trove-legacy-test-${randomBytes(8).toString('hex')}.db`);
		// Build a pre-v2 database image with the raw sqlite-wasm driver and write it to disk.
		const sqlite3 = await sqlite3InitModule();
		const legacyDb = new sqlite3.oo1.DB(':memory:');
		legacyDb.exec(`
				CREATE TABLE workspace_profiles (
					workspace_hash TEXT PRIMARY KEY,
					workspace_root TEXT NOT NULL,
					last_scanned_at INTEGER NOT NULL,
					language_stack TEXT NOT NULL,
					frameworks TEXT NOT NULL,
					package_managers TEXT NOT NULL,
					build_commands TEXT NOT NULL,
					test_commands TEXT NOT NULL,
					lint_commands TEXT NOT NULL,
					typecheck_commands TEXT NOT NULL,
					project_purpose TEXT,
					architecture_summary TEXT,
					file_count INTEGER,
					total_loc INTEGER,
					stale INTEGER DEFAULT 0
				);
				CREATE TABLE file_metadata (
					workspace_hash TEXT NOT NULL,
					file_path TEXT NOT NULL,
					language TEXT,
					last_modified INTEGER NOT NULL,
					size_bytes INTEGER,
					PRIMARY KEY (workspace_hash, file_path)
				);
				INSERT INTO workspace_profiles VALUES ('wh', '/tmp/w', 1, '[]', '[]', '[]', '[]', '[]', '[]', '[]', NULL, NULL, 0, 0, 0);
				INSERT INTO file_metadata VALUES ('wh', 'src/a.ts', 'TypeScript', 1, 100);
				CREATE TABLE symbols (
					symbol_id TEXT PRIMARY KEY,
					workspace_hash TEXT NOT NULL,
					file_path TEXT NOT NULL,
					name TEXT NOT NULL,
					kind TEXT NOT NULL,
					start_line INTEGER NOT NULL,
					end_line INTEGER NOT NULL,
					signature TEXT,
					docstring TEXT,
					is_exported INTEGER NOT NULL DEFAULT 0,
					is_async INTEGER NOT NULL DEFAULT 0,
					content_hash TEXT NOT NULL,
					indexed_at INTEGER NOT NULL
				);
				CREATE VIRTUAL TABLE symbols_fts USING fts5(
					name, signature, docstring, content='symbols', content_rowid='rowid'
				);
			`);
		writeFileSync(legacyPath, sqlite3.capi.sqlite3_js_db_export(legacyDb));
		legacyDb.close();

		const db = new RepoIntelligenceDb(legacyPath);
		await db.init();
		await db.replaceSymbolsForFile('wh', 'src/a.ts', [{
			name: 'foo',
			kind: 'function',
			filePath: 'src/a.ts',
			startLine: 1,
			endLine: 3,
			signature: 'function foo()',
			docstring: '',
			isExported: true,
			contentHash: 'abc123',
		}]);
		const outline = await db.getFileOutline('wh', 'src/a.ts');
		assert.strictEqual(outline.length, 1);
		assert.strictEqual(outline[0].name, 'foo');
		await db.close();
		try { rmSync(legacyPath); } catch { /* ignore */ }
	});
});
