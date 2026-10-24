/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * RiafIndex — the standalone façade over the RIAF repository-intelligence engine.
 *
 * Re-creates the orchestration that lived in Trove's `RepoIntelligenceMainService`
 * (scan → chunk → symbols → org-extension indexers → universal context graph →
 * embeddings → LLM summaries) with a plain config object and no VS Code / Electron
 * dependencies.
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { basename, join } from 'path';
import { chunkFile, extractSymbolsFromFile, SKIP_LANGUAGES, supportsSymbolExtraction } from './codeChunker.js';
import { detectCommands } from './commandDetector.js';
import { indexConfigEnvironments } from './configEnvIndexer.js';
import { createEmbedder, Embedder, EmbeddingConfig } from './embeddingService.js';
import { FileChangeEvent, WorkspaceFileWatcher } from './fileWatcher.js';
import { indexGatewayRoutes } from './gatewayRouteIndexer.js';
import { getGitDiffStat, getRecentlyChangedFiles } from './gitContextIndexer.js';
import { indexGitlabPipelines, PipelineJob } from './gitlabCiIndexer.js';
import { indexAllSpringServices } from './javaSpringIndexer.js';
import { indexKubernetesManifests } from './kubernetesYamlIndexer.js';
import { indexMavenDependencies } from './mavenDependencyIndexer.js';
import { indexNpmDependencies } from './npmImpactIndexer.js';
import { hashWorkspaceRoot, RepoIntelligenceDb } from './repoIntelligenceDb.js';
import { formatRepoIntelligenceIndexingReport } from './repoIntelligenceIndexingReport.js';
import {
	ApiContractResult,
	CodebaseSearchResult,
	ConfigDriftEntry,
	ExtractedSymbol,
	FileMetadataEntry,
	GitFileStats,
	ImportGraphResult,
	MavenImpactSummary,
	REPO_PROFILE_MAX_CHARS,
	RepoIntelligenceIndexingStats,
	ServiceTopologySummary,
	TestCoverageEntry,
	UCGFileNode,
	UCGGraphMetrics,
	UCGImportEdge,
	WorkspaceProfile,
} from './repoIntelligenceTypes.js';
import { OrgExtensionIndexerOptions, resolveOrgExtensionIndexerOptions } from './staasIndexerDefaults.js';
import { indexTerraformResources, TerraformResource } from './terraformIndexer.js';
import { computeMetrics } from './universalGraphAnalyzer.js';
import { extractImports, ImportEdge } from './universalImportExtractor.js';
import { classifyNode, isEntryPoint } from './universalNodeClassifier.js';
import { compileExcludeGlobs, detectLanguageForPath, RawScanResult, scanWorkspace } from './workspaceScanner.js';

// ── public config / result types ────────────────────────────────────────────

export interface RiafConfig {
	workspaceRoot: string;
	/** File path used to persist the SQLite image. Use `':memory:'` for a throwaway index. */
	dbPath: string;
	embeddings?: EmbeddingConfig;
	/** Optional LLM hook for project/architecture summaries; when absent, summaries are skipped. */
	summarize?: (prompt: string) => Promise<string>;
	/** gitignore-style globs (relative to workspaceRoot) excluded from scanning and watching. */
	excludeGlobs?: string[];
	orgExtensions?: Partial<OrgExtensionIndexerOptions>;
	log?: (msg: string) => void;
	/** Debounce for writing the DB image to disk (ms). Default 1000. */
	persistDebounceMs?: number;
	/** Timeout for a single `summarize` call (ms). Default 30000. */
	summarizeTimeoutMs?: number;
}

export interface IndexProgress {
	phase: string;
	done: number;
	total: number;
	message?: string;
}

export interface ReindexOptions {
	/** Rebuild everything, ignoring content-hash caches and existing summaries. */
	force?: boolean;
	onProgress?: (p: IndexProgress) => void;
}

export interface ChunkSearchResult {
	filePath: string;
	startLine: number;
	endLine: number;
	content: string;
	score: number;
	language?: string;
}

export type SymbolSearchResult = ExtractedSymbol;

export interface ContextualProfile {
	activeFile?: string;
	/** Files the active file imports plus files that import it (UCG), relative paths. */
	relatedFiles: string[];
	/** Test files that cover the active file (name proximity or import-based). */
	tests: string[];
	/** Compact, injectable text describing the workspace (and the active file's neighbourhood). */
	profileText: string;
}

export interface SearchOptions {
	limit?: number;
	/** Only return chunks whose relative path starts with this prefix (forward slashes). */
	filePathPrefix?: string;
	/** Truncate chunk content to this many characters; default returns the full chunk. */
	maxChars?: number;
}

export interface IndexStatus {
	indexed: boolean;
	files: number;
	chunks: number;
	symbols: number;
	lastIndexedAt?: number;
}

// ── internals ───────────────────────────────────────────────────────────────

const ARCH_SUMMARY_SYSTEM_PROMPT = `You are a software architect. Given scan data about a codebase, write a concise 2-4 sentence architecture summary describing the project's structure, main components, and technology patterns. Output plain text only, no markdown.`;

const PURPOSE_SUMMARY_SYSTEM_PROMPT = `You are a software analyst. Given scan data about a codebase, write a concise 1-2 sentence description of what this project does and its primary purpose. Output plain text only, no markdown.`;

const TEST_PATTERNS = [/\.(test|spec)\.(ts|js|tsx|jsx|py|java|kt|rb)$/, /Test\.(java|kt)$/, /_test\.(py|go|rs)$/];
const isTestFile = (p: string): boolean => TEST_PATTERNS.some(r => r.test(p));

const EMBEDDING_BATCH = 500;
const EMBED_TEXT_CHARS = 512;

const normalisePath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');
const contentHash = (content: string): string => createHash('sha256').update(content).digest('hex').slice(0, 32);
const yieldToEventLoop = (): Promise<void> => new Promise(r => setImmediate(r));

const buildScanContext = (scan: RawScanResult, commands: ReturnType<typeof detectCommands>, workspaceRoot: string): string => {
	const topFiles = scan.fileMeta.filter(f => f.language).slice(0, 30).map(f => f.filePath);
	return JSON.stringify({
		workspaceRoot,
		languages: scan.languages,
		frameworks: scan.frameworks.map(f => f.name),
		packageManagers: scan.packageManagers,
		fileCount: scan.fileCount,
		totalLoc: scan.totalLoc,
		buildCommands: commands.buildCommands.slice(0, 3).map(c => c.command),
		testCommands: commands.testCommands.slice(0, 3).map(c => c.command),
		sampleFiles: topFiles,
	}, null, 2);
};

/** Render a compact profile text, trimmed to `maxChars`. */
export const formatProfileText = (
	profile: WorkspaceProfile | null | undefined,
	ctx: { activeFile?: string; relatedFiles?: string[]; tests?: string[] } = {},
	maxChars = REPO_PROFILE_MAX_CHARS.agent,
): string => {
	const lines: string[] = [];
	if (profile) {
		lines.push(`Workspace: ${profile.workspaceRoot}`);
		if (profile.projectPurpose) lines.push(`Purpose: ${profile.projectPurpose}`);
		if (profile.architectureSummary) lines.push(`Architecture: ${profile.architectureSummary}`);
		if (profile.languageStack.length) lines.push(`Languages: ${profile.languageStack.join(', ')}`);
		if (profile.frameworks.length) lines.push(`Frameworks: ${profile.frameworks.map(f => f.version ? `${f.name} ${f.version}` : f.name).join(', ')}`);
		if (profile.packageManagers.length) lines.push(`Package managers: ${profile.packageManagers.join(', ')}`);
		const cmd = (label: string, entries: { command: string }[]) => {
			if (entries.length) lines.push(`${label}: ${entries.slice(0, 3).map(e => e.command).join(' | ')}`);
		};
		cmd('Build/start', profile.buildCommands);
		cmd('Test', profile.testCommands);
		cmd('Lint', profile.lintCommands);
		cmd('Typecheck', profile.typecheckCommands);
		lines.push(`Files: ${profile.fileCount.toLocaleString()} (${profile.totalLoc.toLocaleString()} LOC)`);
		if (profile.serviceTopologySummary?.serviceCount) {
			const t = profile.serviceTopologySummary;
			lines.push(`Services (${t.serviceCount}): ${t.serviceNames.slice(0, 10).join(', ')}${t.serviceNames.length > 10 ? ', …' : ''}; ${t.totalEndpoints} HTTP endpoints`);
		}
		if (profile.terraformSummary?.resourceCount) {
			lines.push(`Terraform: ${profile.terraformSummary.resourceCount} resources (${profile.terraformSummary.providers.join(', ')})`);
		}
		if (profile.pipelineSummary?.jobCount) {
			lines.push(`CI: ${profile.pipelineSummary.jobCount} jobs across stages ${profile.pipelineSummary.stages.join(' → ')}`);
		}
		if (profile.k8sResourceCount) lines.push(`Kubernetes resources: ${profile.k8sResourceCount}`);
	} else {
		lines.push('Workspace not indexed yet.');
	}

	if (ctx.activeFile) {
		lines.push('', `Active file: ${ctx.activeFile}`);
		if (ctx.relatedFiles?.length) lines.push(`Related files: ${ctx.relatedFiles.slice(0, 20).join(', ')}${ctx.relatedFiles.length > 20 ? ', …' : ''}`);
		if (ctx.tests?.length) lines.push(`Covering tests: ${ctx.tests.slice(0, 10).join(', ')}`);
	}

	const text = lines.join('\n');
	return text.length <= maxChars ? text : text.slice(0, maxChars - 1) + '…';
};

// ── the index ───────────────────────────────────────────────────────────────

export class RiafIndex {
	private readonly _cfg: RiafConfig;
	private readonly _root: string;
	private readonly _hash: string;
	private readonly _db: RepoIntelligenceDb;
	private readonly _embedder: Embedder | undefined;
	private readonly _log: (msg: string) => void;
	private readonly _orgOptions: Required<OrgExtensionIndexerOptions>;
	private _watcher: WorkspaceFileWatcher | null = null;
	private _queue: Promise<unknown> = Promise.resolve();
	private _indexing = false;
	private _closed = false;
	private _status: IndexStatus = { indexed: false, files: 0, chunks: 0, symbols: 0 };
	private _configFileCount = 0;

	private constructor(cfg: RiafConfig, db: RepoIntelligenceDb) {
		this._cfg = cfg;
		this._root = cfg.workspaceRoot;
		this._hash = hashWorkspaceRoot(cfg.workspaceRoot);
		this._db = db;
		this._embedder = createEmbedder(cfg.embeddings);
		this._log = cfg.log ?? (() => { });
		this._orgOptions = resolveOrgExtensionIndexerOptions(cfg.orgExtensions);
	}

	/** Open (or create) the index. Loads any existing DB image from `cfg.dbPath`. */
	static async open(cfg: RiafConfig): Promise<RiafIndex> {
		const db = new RepoIntelligenceDb(cfg.dbPath, { persistDebounceMs: cfg.persistDebounceMs, log: cfg.log });
		await db.init();
		const index = new RiafIndex(cfg, db);
		await index._refreshStatus();
		return index;
	}

	get workspaceRoot(): string { return this._root; }
	get workspaceHash(): string { return this._hash; }
	/** The underlying database, for callers that need the lower-level API. */
	get db(): RepoIntelligenceDb { return this._db; }
	get embeddingsEnabled(): boolean { return this._embedder !== undefined; }

	// ── indexing ─────────────────────────────────────────────────────────────

	/** Full (re)index of the workspace. Incremental unless `force` is set. */
	reindex(opts: ReindexOptions = {}): Promise<RepoIntelligenceIndexingStats> {
		return this._enqueue(() => this._reindex(opts));
	}

	/** Incrementally (re)index the given files (relative to the workspace root). */
	indexFiles(relPaths: string[]): Promise<void> {
		return this._enqueue(() => this._indexFiles(relPaths));
	}

	/** Remove the given files (relative to the workspace root) from every table. */
	removeFiles(relPaths: string[]): Promise<void> {
		return this._enqueue(() => this._removeFiles(relPaths));
	}

	startWatching(): void {
		if (this._watcher || this._closed) return;
		const watcher = new WorkspaceFileWatcher();
		watcher.on('changes', (events: FileChangeEvent[]) => {
			void this._handleWatchEvents(events).catch(err => this._log(`[RiafIndex] watch handling failed: ${String(err)}`));
		});
		watcher.start(this._root);
		this._watcher = watcher;
		this._log(`[RiafIndex] watching ${this._root}`);
	}

	stopWatching(): void {
		if (!this._watcher) return;
		this._watcher.stop();
		this._watcher = null;
	}

	// ── search ───────────────────────────────────────────────────────────────

	/** BM25 + vector search fused with RRF; falls back to BM25 when embeddings are unavailable. */
	async searchHybrid(query: string, opts: SearchOptions = {}): Promise<ChunkSearchResult[]> {
		const trimmed = query.trim();
		if (!trimmed) return [];
		const limit = opts.limit ?? 10;
		const fetchLimit = opts.filePathPrefix ? limit * 4 : limit;
		const queryEmbedding = this._embedder ? await this._embedder.embedText(trimmed) : null;
		const rows = await this._db.searchChunksHybrid(this._hash, trimmed, queryEmbedding, fetchLimit, opts.maxChars ?? Infinity);
		return this._toChunkResults(rows, opts, limit);
	}

	/** Pure FTS5/BM25 search. */
	async searchBM25(query: string, opts: SearchOptions = {}): Promise<ChunkSearchResult[]> {
		const trimmed = query.trim();
		if (!trimmed) return [];
		const limit = opts.limit ?? 10;
		const fetchLimit = opts.filePathPrefix ? limit * 4 : limit;
		const rows = await this._db.searchChunks(this._hash, trimmed, fetchLimit, opts.maxChars ?? Infinity);
		return this._toChunkResults(rows, opts, limit);
	}

	async searchSymbols(query: string, limit = 15): Promise<SymbolSearchResult[]> {
		const trimmed = query.trim();
		if (!trimmed) return [];
		return this._db.searchSymbols(this._hash, trimmed, limit);
	}

	async getFileOutline(relPath: string): Promise<ExtractedSymbol[]> {
		return this._db.getFileOutline(this._hash, normalisePath(relPath));
	}

	async getSymbol(relPath: string, symbolName: string): Promise<ExtractedSymbol | null> {
		return this._db.getSymbol(this._hash, normalisePath(relPath), symbolName);
	}

	// ── profile / graph / report ─────────────────────────────────────────────

	async getWorkspaceProfile(): Promise<WorkspaceProfile | undefined> {
		const profile = await this._db.getProfile(this._hash);
		if (!profile) return undefined;
		return this._hydrateOrgSummaries(profile);
	}

	/** Related files (UCG imports + importers) and covering tests for the active file, plus injectable profile text. */
	async getContextualProfile(activeRelPath?: string): Promise<ContextualProfile> {
		const profile = await this.getWorkspaceProfile();
		if (!activeRelPath) {
			return { relatedFiles: [], tests: [], profileText: formatProfileText(profile) };
		}
		const rel = this._toRelative(activeRelPath);
		let relatedFiles: string[] = [];
		let tests: string[] = [];
		try {
			const graph = await this.getImportGraph(rel, 'both');
			relatedFiles = [...new Set([...graph.imports, ...graph.importedBy])];
		} catch { /* UCG not indexed yet */ }
		try {
			tests = (await this.getTestsForFile(rel)).map(t => t.testFile);
		} catch { /* ignore */ }
		return {
			activeFile: rel,
			relatedFiles,
			tests,
			profileText: formatProfileText(profile, { activeFile: rel, relatedFiles, tests }),
		};
	}

	async getIndexingReport(): Promise<string> {
		const profile = await this.getWorkspaceProfile();
		const stats = await this._db.getIndexingStats(this._hash);
		return formatRepoIntelligenceIndexingReport(this._root, profile ?? null, stats, this._indexing);
	}

	async getIndexingStats(): Promise<RepoIntelligenceIndexingStats> {
		return this._db.getIndexingStats(this._hash);
	}

	async getGraph(): Promise<{ nodes: UCGFileNode[]; edges: UCGImportEdge[] }> {
		return this._db.getUCGGraph(this._hash);
	}

	async getGraphMetrics(): Promise<UCGGraphMetrics | null> {
		return this._db.getUCGMetrics(this._hash);
	}

	async getImportGraph(relPath: string, direction: 'imports' | 'importedBy' | 'both' = 'both'): Promise<ImportGraphResult> {
		const normPath = this._toRelative(relPath);
		const [outEdges, inEdges] = await Promise.all([
			direction === 'importedBy' ? Promise.resolve([]) : this._db.getImportEdgesFrom(this._hash, normPath),
			direction === 'imports' ? Promise.resolve([]) : this._db.getImportEdgesTo(this._hash, normPath),
		]);
		return {
			imports: outEdges.filter(e => !e.isExternal && e.resolvedFile).map(e => e.resolvedFile!),
			importedBy: inEdges.map(e => e.fromFile),
			externalDeps: outEdges.filter(e => e.isExternal).map(e => e.toModule),
		};
	}

	async getTestsForFile(relPath: string): Promise<TestCoverageEntry[]> {
		const rel = this._toRelative(relPath);
		const allFiles = await this._db.getFileMetadata(this._hash);
		const stripExt = (p: string) => p.replace(/\.[^.]+$/, '');
		const sourceBase = basename(stripExt(rel)).toLowerCase();
		const results: TestCoverageEntry[] = [];

		for (const f of allFiles) {
			if (!isTestFile(f.filePath)) continue;

			// Strategy 1: name proximity (OrderService.test.ts → OrderService.ts)
			const testBase = basename(f.filePath)
				.replace(/\.(test|spec|_test|Test)\.(ts|js|tsx|jsx|py|java|kt|rb)$/, '')
				.replace(/_test\.(py|go|rs)$/, '')
				.replace(/\.[^.]+$/, '')
				.replace(/Test$/, '')
				.toLowerCase();
			if (testBase === sourceBase) {
				results.push({ testFile: f.filePath, confidence: 'high' });
				continue;
			}

			// Strategy 2: import-based (test file imports the source file)
			const outEdges = await this._db.getImportEdgesFrom(this._hash, f.filePath);
			if (outEdges.some(e => e.resolvedFile && stripExt(e.resolvedFile) === stripExt(rel))) {
				results.push({ testFile: f.filePath, confidence: 'medium' });
			}
		}
		return results;
	}

	getStatus(): IndexStatus {
		return { ...this._status };
	}

	// ── org-extension queries (STaaS) ────────────────────────────────────────

	async getServiceTopology(): Promise<ServiceTopologySummary | null> {
		const [endpoints, feignClients, routes] = await Promise.all([
			this._db.getSpringEndpoints(this._hash),
			this._db.getFeignClients(this._hash),
			this._db.getGatewayRoutes(this._hash),
		]);
		if (endpoints.length === 0) return null;
		const feignMap = new Map<string, Set<string>>();
		for (const e of feignClients) {
			if (!feignMap.has(e.callerService)) feignMap.set(e.callerService, new Set());
			feignMap.get(e.callerService)!.add(e.targetService);
		}
		return {
			serviceCount: new Set(endpoints.map(e => e.serviceName)).size,
			serviceNames: [...new Set(endpoints.map(e => e.serviceName))],
			gatewayRoutes: routes.map(r => ({ pathPattern: r.pathPredicate, targetService: r.targetService })),
			feignEdges: [...feignMap.entries()].map(([caller, targets]) => ({ caller, targets: [...targets] })),
			totalEndpoints: endpoints.length,
		};
	}

	async getMavenImpact(artifactId: string): Promise<string[]> {
		const consumers = await this._db.getMavenConsumers(this._hash, artifactId);
		return [...new Set(consumers.map(c => c.consumerPath))];
	}

	async resolveApiContract(httpMethod: string, pathPattern: string): Promise<ApiContractResult | null> {
		const endpoints = await this._db.getSpringEndpoints(this._hash);
		const method = httpMethod.toUpperCase();
		let ep = endpoints.find(e => e.httpMethod === method && e.pathPattern === pathPattern);
		if (!ep) {
			const prefix = pathPattern.replace(/\*\*$/, '').replace(/\/+$/, '');
			ep = endpoints.find(e => e.httpMethod === method && e.pathPattern.startsWith(prefix));
		}
		if (!ep) return null;
		return {
			pathPattern: ep.pathPattern,
			httpMethod: ep.httpMethod,
			backendService: ep.serviceName,
			controllerClass: ep.controllerClass,
			handlerMethod: ep.handlerMethod,
			requestDto: ep.requestDto,
			responseDto: ep.responseDto,
			filePath: ep.filePath,
		};
	}

	async getNpmConsumers(packageName: string): Promise<string[]> {
		return this._db.getNpmConsumers(this._hash, packageName);
	}

	async getConfigDrift(serviceName: string): Promise<ConfigDriftEntry[]> {
		const drifts = await this._db.getConfigDriftForService(this._hash, serviceName);
		return drifts.map(d => ({ key: d.key, envValues: d.envValues }));
	}

	async getTerraformResources(resourceType?: string): Promise<TerraformResource[]> {
		const resources = await this._db.getTerraformResources(this._hash);
		return resourceType ? resources.filter(r => r.resourceType === resourceType) : resources;
	}

	async getPipelineJobs(stage?: string): Promise<PipelineJob[]> {
		const jobs = await this._db.getPipelineJobs(this._hash);
		return stage ? jobs.filter(j => j.stage === stage) : jobs;
	}

	// ── git ──────────────────────────────────────────────────────────────────

	getGitDiffStat(): Promise<string | null> {
		return getGitDiffStat(this._root);
	}

	getGitRecentlyChanged(limit = 20): Promise<GitFileStats[]> {
		return getRecentlyChangedFiles(this._root, limit);
	}

	// ── lifecycle ────────────────────────────────────────────────────────────

	/** Write the DB image to disk now. */
	flush(): Promise<void> {
		return this._db.flush();
	}

	async close(): Promise<void> {
		if (this._closed) return;
		this._closed = true;
		this.stopWatching();
		try { await this._queue; } catch { /* already reported */ }
		await this._db.close();
	}

	// ── implementation ───────────────────────────────────────────────────────

	private _enqueue<T>(task: () => Promise<T>): Promise<T> {
		if (this._closed) return Promise.reject(new Error('RiafIndex is closed'));
		const run = this._queue.then(task, task);
		this._queue = run.catch(() => { });
		return run;
	}

	private _toRelative(p: string): string {
		const norm = normalisePath(p);
		const root = normalisePath(this._root).replace(/\/+$/, '');
		if (norm.startsWith(root + '/')) return norm.slice(root.length + 1);
		if (norm === root) return '';
		return norm;
	}

	private _toChunkResults(rows: CodebaseSearchResult[], opts: SearchOptions, limit: number): ChunkSearchResult[] {
		const prefix = opts.filePathPrefix ? normalisePath(opts.filePathPrefix) : undefined;
		const filtered = prefix ? rows.filter(r => normalisePath(r.filePath).startsWith(prefix)) : rows;
		return filtered.slice(0, limit).map(r => ({
			filePath: r.filePath,
			startLine: r.startLine,
			endLine: r.endLine,
			content: r.snippet,
			score: r.score,
			language: detectLanguageForPath(r.filePath) ?? undefined,
		}));
	}

	private async _refreshStatus(): Promise<void> {
		const [profile, chunks, symbolStats] = await Promise.all([
			this._db.getProfile(this._hash),
			this._db.getChunkCount(this._hash),
			this._db.getIndexingStats(this._hash),
		]);
		this._status = {
			indexed: !!profile && !profile.isStale,
			files: profile?.fileCount ?? symbolStats.totalFileCount,
			chunks,
			symbols: symbolStats.symbolCount,
			lastIndexedAt: profile?.lastScannedAt,
		};
	}

	private async _reindex(opts: ReindexOptions): Promise<RepoIntelligenceIndexingStats> {
		const force = opts.force === true;
		const progress = (phase: string, done: number, total: number, message?: string) => {
			try { opts.onProgress?.({ phase, done, total, message }); } catch { /* listener error */ }
		};
		this._indexing = true;
		const started = Date.now();
		try {
			// 1. scan
			progress('scan', 0, 1);
			const scan = scanWorkspace(this._root, { excludeGlobs: this._cfg.excludeGlobs });
			const commands = detectCommands(this._root);
			let profile: WorkspaceProfile = {
				workspaceRoot: this._root,
				lastScannedAt: Date.now(),
				languageStack: scan.languages,
				frameworks: scan.frameworks,
				packageManagers: scan.packageManagers,
				// Start scripts live alongside build in the same JSON column (purpose distinguishes them)
				buildCommands: [...commands.buildCommands, ...commands.startCommands],
				testCommands: commands.testCommands,
				lintCommands: commands.lintCommands,
				typecheckCommands: commands.typecheckCommands,
				projectPurpose: null,
				architectureSummary: null,
				fileCount: scan.fileCount,
				totalLoc: scan.totalLoc,
				isStale: false,
			};
			await this._db.upsertProfile(this._hash, profile, scan.fileMeta);
			progress('scan', 1, 1, `${scan.fileCount} files, ${scan.languages.join(', ')}`);

			// 2. chunks (incremental by content hash) + 3. symbols
			await this._rebuildChunks(scan.fileMeta, force, progress);
			await this._indexSymbols(scan.fileMeta, force, progress);

			// 4. org-extension indexers
			this._configFileCount = await this._indexOrgExtensions(progress);

			// 5. universal context graph
			await this._indexGraph(scan.fileMeta, progress);

			// 6. embeddings
			await this._indexEmbeddings(progress);

			// 7. summaries (LLM hook)
			const existing = await this._db.getProfile(this._hash);
			if (!force && existing?.projectPurpose && existing?.architectureSummary) {
				profile = { ...profile, projectPurpose: existing.projectPurpose, architectureSummary: existing.architectureSummary };
			} else if (this._cfg.summarize) {
				progress('summaries', 0, 2);
				const scanContext = buildScanContext(scan, commands, this._root);
				const [architectureSummary, projectPurpose] = await Promise.all([
					this._summarize(`${ARCH_SUMMARY_SYSTEM_PROMPT}\n\n${scanContext}`),
					this._summarize(`${PURPOSE_SUMMARY_SYSTEM_PROMPT}\n\n${scanContext}`),
				]);
				if (architectureSummary || projectPurpose) {
					await this._db.updateSummaries(this._hash, projectPurpose, architectureSummary);
					profile = { ...profile, projectPurpose, architectureSummary };
				}
				progress('summaries', 2, 2);
			}
			const stats = await this._db.getIndexingStats(this._hash);
			await this._db.flush();
			await this._refreshStatus();
			this._log(`[RiafIndex] reindex complete: ${stats.chunkCount} chunks, ${stats.symbolCount} symbols, ${stats.indexedFileCount}/${stats.indexableFileCount} files in ${Date.now() - started}ms`);
			progress('done', 1, 1);
			return stats;
		} finally {
			this._indexing = false;
		}
	}

	private async _rebuildChunks(
		fileMeta: FileMetadataEntry[],
		force: boolean,
		progress: (phase: string, done: number, total: number, message?: string) => void,
	): Promise<void> {
		const indexable = fileMeta.filter(f => f.language && !SKIP_LANGUAGES.has(f.language));
		const stored = force ? new Map<string, string>() : await this._db.getChunkFileHashes(this._hash);
		if (force) {
			await this._db.replaceChunks(this._hash, []);
			for (const p of (await this._db.getChunkFileHashes(this._hash)).keys()) {
				await this._db.deleteChunkFileHash(this._hash, p);
			}
		}

		let updated = 0;
		let totalChunks = 0;
		let processed = 0;
		progress('chunks', 0, indexable.length);

		for (const file of indexable) {
			const absPath = join(this._root, file.filePath);
			const storedHash = stored.get(file.filePath);
			const stat = await fs.stat(absPath).catch(() => null);
			if (!stat) {
				await this._db.upsertChunkFileHash(this._hash, file.filePath, 'UNREADABLE');
			} else if (storedHash && storedHash !== 'UNREADABLE' && stat.mtimeMs === file.lastModified && stat.size === file.sizeBytes) {
				// unchanged since the scan and already in the ledger
			} else {
				let content: string | null = null;
				try { content = await fs.readFile(absPath, 'utf8'); } catch { /* unreadable */ }
				if (content === null) {
					await this._db.upsertChunkFileHash(this._hash, file.filePath, 'UNREADABLE');
				} else {
					const current = contentHash(content);
					if (storedHash !== current) {
						const chunks = chunkFile(this._hash, file.filePath, content, file.language);
						await this._db.replaceChunksForFile(this._hash, file.filePath, chunks);
						await this._db.upsertChunkFileHash(this._hash, file.filePath, current);
						if (this._embedder) await this._db.deleteChunkEmbeddingsForFile(this._hash, file.filePath);
						updated++;
						totalChunks += chunks.length;
					}
				}
			}
			if (++processed % 50 === 0) {
				progress('chunks', processed, indexable.length);
				await yieldToEventLoop();
			}
		}

		// Drop chunks for files that disappeared from the scan
		const currentPaths = new Set(indexable.map(f => f.filePath));
		for (const storedPath of stored.keys()) {
			if (!currentPaths.has(storedPath)) {
				await this._db.replaceChunksForFile(this._hash, storedPath, []);
				await this._db.deleteChunkFileHash(this._hash, storedPath);
				await this._db.deleteChunkEmbeddingsForFile(this._hash, storedPath);
			}
		}
		progress('chunks', indexable.length, indexable.length, updated > 0 ? `${updated} files → ${totalChunks} chunks` : 'up to date');
	}

	private async _indexSymbols(
		fileMeta: FileMetadataEntry[],
		force: boolean,
		progress: (phase: string, done: number, total: number, message?: string) => void,
	): Promise<void> {
		const candidates = fileMeta.filter(f => supportsSymbolExtraction(f.language));
		// upsertProfile rewrites file_metadata, so content_hash is always empty here on a full
		// reindex; the symbol pass therefore re-extracts every supported file (cheap, regex-based).
		const storedHashes = force ? new Map<string, string>() : await this._db.getFileHashes(this._hash);
		let indexed = 0;
		let processed = 0;
		progress('symbols', 0, candidates.length);
		for (const file of candidates) {
			let content: string;
			try { content = await fs.readFile(join(this._root, file.filePath), 'utf8'); } catch { continue; }
			const current = contentHash(content);
			if (storedHashes.get(file.filePath) !== current) {
				const symbols = extractSymbolsFromFile(this._hash, file.filePath, content, file.language);
				await this._db.replaceSymbolsForFile(this._hash, file.filePath, symbols);
				await this._db.upsertFileHash(this._hash, file.filePath, current);
				indexed++;
			}
			if (++processed % 50 === 0) {
				progress('symbols', processed, candidates.length);
				await yieldToEventLoop();
			}
		}
		progress('symbols', candidates.length, candidates.length, `${indexed} files re-extracted`);
	}

	private async _indexOrgExtensions(progress: (phase: string, done: number, total: number, message?: string) => void): Promise<number> {
		const steps = 8;
		let done = 0;
		let configFileCount = 0;
		const step = (label: string) => progress('org-extensions', ++done, steps, label);
		try {
			const java = indexAllSpringServices(this._root);
			await this._db.replaceSpringEndpoints(this._hash, java.endpoints);
			await this._db.replaceFeignClients(this._hash, java.feignClients);
			step(`spring: ${java.endpoints.length} endpoints`);

			const maven = await indexMavenDependencies(this._root);
			await this._db.replaceMavenDependencies(this._hash, maven.deps);
			step(`maven: ${maven.pomCount} poms`);

			const k8s = indexKubernetesManifests(this._root);
			await this._db.replaceK8sResources(this._hash, k8s);
			step(`k8s: ${k8s.length} resources`);

			const routes = indexGatewayRoutes(this._root);
			await this._db.replaceGatewayRoutes(this._hash, routes);
			step(`gateway: ${routes.length} routes`);

			const npm = indexNpmDependencies(this._root, [...this._orgOptions.npmScopes]);
			await this._db.replaceNpmEdges(this._hash, npm.edges);
			step(`npm: ${npm.edges.length} edges`);

			const config = indexConfigEnvironments(this._root, { configServerDirs: this._orgOptions.configServerDirs });
			configFileCount = config.fileCount;
			await this._db.replaceConfigDrift(this._hash, config.envDrift);
			step(`config: ${config.envDrift.length} drifts`);

			const tf = indexTerraformResources(this._root);
			await this._db.replaceTerraformIndex(this._hash, tf);
			step(`terraform: ${tf.resources.length} resources`);

			const ci = indexGitlabPipelines(this._root);
			await this._db.replacePipelineIndex(this._hash, ci);
			step(`ci: ${ci.jobs.length} jobs`);
		} catch (err) {
			this._log(`[RiafIndex] org-extension indexing failed: ${String(err)}`);
			progress('org-extensions', steps, steps, 'failed (partial)');
		}
		return configFileCount;
	}

	private _buildNodeAndEdges(relPath: string, content: string, language: string): { node: UCGFileNode; edges: UCGImportEdge[] } {
		const normalizedPath = normalisePath(relPath);
		const classification = classifyNode(normalizedPath, content);
		const imports = extractImports(join(this._root, relPath), content, language, this._root);
		const node: UCGFileNode = {
			filePath: normalizedPath,
			language,
			nodeType: classification.nodeType,
			archLayer: classification.layer,
			isEntryPoint: false,
			importCount: imports.filter(e => !e.isExternal).length,
			importedByCount: 0,
		};
		const edges: UCGImportEdge[] = imports.map(imp => ({
			fromFile: normalizedPath,
			toModule: imp.toModule,
			resolvedFile: imp.resolvedFile,
			isExternal: imp.isExternal,
			edgeType: imp.edgeType,
		}));
		return { node, edges };
	}

	private async _indexGraph(
		fileMeta: FileMetadataEntry[],
		progress: (phase: string, done: number, total: number, message?: string) => void,
	): Promise<void> {
		const started = Date.now();
		const candidates = fileMeta.filter(f => f.language && !SKIP_LANGUAGES.has(f.language));
		const allNodes: UCGFileNode[] = [];
		const allEdges: UCGImportEdge[] = [];
		let processed = 0;
		progress('graph', 0, candidates.length);

		for (const meta of candidates) {
			let content: string;
			try { content = await fs.readFile(join(this._root, meta.filePath), 'utf8'); } catch { continue; }
			const { node, edges } = this._buildNodeAndEdges(meta.filePath, content, meta.language!);
			allNodes.push(node);
			allEdges.push(...edges);
			if (++processed % 100 === 0) {
				progress('graph', processed, candidates.length);
				await yieldToEventLoop();
			}
		}

		const inDegree = new Map<string, number>();
		for (const e of allEdges) {
			if (e.resolvedFile) inDegree.set(e.resolvedFile, (inDegree.get(e.resolvedFile) ?? 0) + 1);
		}
		for (const node of allNodes) {
			const inDeg = inDegree.get(node.filePath) ?? 0;
			node.isEntryPoint = isEntryPoint(node.filePath, '', inDeg);
			node.importedByCount = inDeg;
		}

		const metrics = computeMetrics(allNodes, allEdges.map(e => ({ ...e, edgeType: e.edgeType as ImportEdge['edgeType'] })));
		await this._db.replaceUCGNodes(this._hash, allNodes);
		await this._db.replaceUCGEdges(this._hash, allEdges);
		await this._db.upsertUCGMetrics(this._hash, {
			totalNodes: metrics.totalNodes,
			totalEdges: metrics.totalEdges,
			entryCount: metrics.entryPoints.length,
			cycleCount: metrics.cycleCount,
			cycles: metrics.cycles,
			hotFiles: metrics.hotFiles,
			externalDeps: Object.fromEntries(metrics.externalDeps),
			computedAt: Date.now(),
		});
		progress('graph', candidates.length, candidates.length, `${allNodes.length} nodes, ${allEdges.length} edges in ${Date.now() - started}ms`);
	}

	private async _indexEmbeddings(progress: (phase: string, done: number, total: number, message?: string) => void): Promise<void> {
		if (!this._embedder) return;
		const total = await this._db.getChunkCount(this._hash);
		let done = 0;
		progress('embeddings', 0, total);
		// Loop until no chunk is missing an embedding (or the endpoint goes away).
		for (; ;) {
			const rows = await this._db.getChunksWithoutEmbeddings(this._hash, EMBEDDING_BATCH);
			if (rows.length === 0) break;
			const embeddings = await this._embedder.embedTexts(rows.map(r => r.chunk_text.slice(0, EMBED_TEXT_CHARS)));
			if (!embeddings) {
				this._log('[RiafIndex] embedding endpoint unavailable — continuing with BM25 only');
				progress('embeddings', done, total, 'endpoint unavailable');
				return;
			}
			for (let i = 0; i < rows.length; i++) {
				if (embeddings[i]) {
					await this._db.upsertChunkEmbedding(this._hash, rows[i].file_path, rows[i].start_line, embeddings[i]);
				}
			}
			done += rows.length;
			progress('embeddings', Math.min(done, total), total);
			await yieldToEventLoop();
		}
		progress('embeddings', total, total);
	}

	private async _embedFile(relPath: string): Promise<void> {
		if (!this._embedder) return;
		const rows = await this._db.getChunksForFile(this._hash, relPath);
		await this._db.deleteChunkEmbeddingsForFile(this._hash, relPath);
		if (rows.length === 0) return;
		const embeddings = await this._embedder.embedTexts(rows.map(r => r.chunk_text.slice(0, EMBED_TEXT_CHARS)));
		if (!embeddings) return;
		for (let i = 0; i < rows.length; i++) {
			if (embeddings[i]) {
				await this._db.upsertChunkEmbedding(this._hash, rows[i].file_path, rows[i].start_line, embeddings[i]);
			}
		}
	}

	private async _summarize(prompt: string): Promise<string | null> {
		const hook = this._cfg.summarize;
		if (!hook) return null;
		const timeoutMs = this._cfg.summarizeTimeoutMs ?? 30_000;
		try {
			const result = await Promise.race([
				hook(prompt),
				new Promise<null>(resolve => {
					const t = setTimeout(() => resolve(null), timeoutMs);
					(t as { unref?: () => void }).unref?.();
				}),
			]);
			const text = typeof result === 'string' ? result.trim() : '';
			return text || null;
		} catch (err) {
			this._log(`[RiafIndex] summarize hook failed: ${String(err)}`);
			return null;
		}
	}

	private async _indexFiles(relPaths: string[]): Promise<void> {
		let touchedGraph = false;
		for (const raw of relPaths) {
			const rel = this._toRelative(raw);
			if (!rel) continue;
			const language = detectLanguageForPath(rel);
			const absPath = join(this._root, rel);
			const stat = await fs.stat(absPath).catch(() => null);
			if (!stat || !stat.isFile()) {
				await this._removeFiles([rel]);
				continue;
			}

			await this._db.upsertFileMetadata(this._hash, {
				filePath: rel,
				language,
				lastModified: stat.mtimeMs,
				sizeBytes: stat.size,
			});

			if (!language || SKIP_LANGUAGES.has(language)) continue;

			let content: string;
			try { content = await fs.readFile(absPath, 'utf8'); } catch { continue; }
			const current = contentHash(content);
			const stored = await this._db.getChunkFileHash(this._hash, rel);
			if (stored === current) continue;

			const chunks = chunkFile(this._hash, rel, content, language);
			await this._db.replaceChunksForFile(this._hash, rel, chunks);
			await this._db.upsertChunkFileHash(this._hash, rel, current);

			if (supportsSymbolExtraction(language)) {
				await this._db.replaceSymbolsForFile(this._hash, rel, extractSymbolsFromFile(this._hash, rel, content, language));
				await this._db.upsertFileHash(this._hash, rel, current);
			}

			const { node, edges } = this._buildNodeAndEdges(rel, content, language);
			const importers = await this._db.getImportEdgesTo(this._hash, node.filePath);
			node.importedByCount = importers.length;
			node.isEntryPoint = isEntryPoint(node.filePath, '', importers.length);
			await this._db.upsertUCGNode(this._hash, node);
			await this._db.replaceUCGEdgesForFile(this._hash, node.filePath, edges);
			touchedGraph = true;

			await this._embedFile(rel);
		}
		if (touchedGraph) await this._db.refreshUCGImportedByCounts(this._hash);
		await this._refreshStatus();
	}

	private async _removeFiles(relPaths: string[]): Promise<void> {
		let touchedGraph = false;
		for (const raw of relPaths) {
			const rel = this._toRelative(raw);
			if (!rel) continue;
			await this._db.replaceChunksForFile(this._hash, rel, []);
			await this._db.deleteChunkFileHash(this._hash, rel);
			await this._db.deleteChunkEmbeddingsForFile(this._hash, rel);
			await this._db.replaceSymbolsForFile(this._hash, rel, []);
			await this._db.deleteFileMetadata(this._hash, rel);
			await this._db.deleteUCGNode(this._hash, rel);
			await this._db.replaceUCGEdgesForFile(this._hash, rel, []);
			touchedGraph = true;
		}
		if (touchedGraph) await this._db.refreshUCGImportedByCounts(this._hash);
		await this._refreshStatus();
	}

	private async _handleWatchEvents(events: FileChangeEvent[]): Promise<void> {
		const excluded = compileExcludeGlobs(this._cfg.excludeGlobs);
		const removed = events.filter(e => e.type === 'unlink' && !excluded(e.filePath)).map(e => e.filePath);
		const changed = events.filter(e => e.type !== 'unlink' && !excluded(e.filePath)).map(e => e.filePath);
		if (removed.length) await this.removeFiles(removed);
		if (changed.length) await this.indexFiles(changed);
	}

	private async _hydrateOrgSummaries(profile: WorkspaceProfile): Promise<WorkspaceProfile> {
		const [
			endpoints, feignClients, routes, mavenDeps, npmEdges, driftStats,
			tfResources, tfMeta, pipelineJobs, pipelineMeta, k8sCount,
		] = await Promise.all([
			this._db.getSpringEndpoints(this._hash),
			this._db.getFeignClients(this._hash),
			this._db.getGatewayRoutes(this._hash),
			this._db.getAllMavenDependencies(this._hash),
			this._db.getAllNpmEdges(this._hash),
			this._db.getConfigDriftStats(this._hash),
			this._db.getTerraformResources(this._hash),
			this._db.getTerraformIndexMeta(this._hash),
			this._db.getPipelineJobs(this._hash),
			this._db.getPipelineIndexMeta(this._hash),
			this._db.getK8sResourceCount(this._hash),
		]);

		let hydrated: WorkspaceProfile = { ...profile };

		if (endpoints.length > 0) {
			const feignMap = new Map<string, Set<string>>();
			for (const e of feignClients) {
				if (!feignMap.has(e.callerService)) feignMap.set(e.callerService, new Set());
				feignMap.get(e.callerService)!.add(e.targetService);
			}
			const serviceNames = [...new Set(endpoints.map(ep => ep.serviceName))];
			hydrated.serviceTopologySummary = {
				serviceCount: serviceNames.length,
				serviceNames,
				gatewayRoutes: routes.map(r => ({ pathPattern: r.pathPredicate, targetService: r.targetService })),
				feignEdges: [...feignMap.entries()].map(([caller, targets]) => ({ caller, targets: [...targets] })),
				totalEndpoints: endpoints.length,
			};
		}

		if (mavenDeps.length > 0) {
			const byArtifact = new Map<string, Set<string>>();
			for (const d of mavenDeps) {
				if (!byArtifact.has(d.artifactId)) byArtifact.set(d.artifactId, new Set());
				byArtifact.get(d.artifactId)!.add(d.consumerPath);
			}
			const sharedLibs = [...byArtifact.entries()]
				.filter(([, consumers]) => consumers.size >= 2)
				.map(([artifactId, consumers]) => ({ artifactId, consumerCount: consumers.size }))
				.sort((a, b) => b.consumerCount - a.consumerCount)
				.slice(0, 20);
			const mavenImpact: MavenImpactSummary = { sharedLibs, pomCount: new Set(mavenDeps.map(d => d.consumerPath)).size };
			hydrated.mavenImpactSummary = mavenImpact;
		}

		if (npmEdges.length > 0) {
			const byPackage = new Map<string, Set<string>>();
			for (const e of npmEdges) {
				if (!byPackage.has(e.packageName)) byPackage.set(e.packageName, new Set());
				byPackage.get(e.packageName)!.add(e.consumerPath);
			}
			hydrated.npmImpactSummary = {
				sharedPackages: [...byPackage.entries()]
					.filter(([, consumers]) => consumers.size >= 2)
					.map(([packageName, consumers]) => ({ packageName, consumerCount: consumers.size }))
					.sort((a, b) => b.consumerCount - a.consumerCount)
					.slice(0, 15),
				packageJsonCount: new Set(npmEdges.map(e => e.consumerPath)).size,
			};
		}

		if (driftStats.driftCount > 0) {
			hydrated.configDriftSummary = {
				driftCount: driftStats.driftCount,
				fileCount: this._configFileCount || driftStats.driftCount,
				topDriftedServices: driftStats.topDriftedServices,
			};
		}

		if (tfResources.length > 0 || tfMeta) {
			hydrated.terraformSummary = {
				resourceCount: tfResources.length,
				providers: tfMeta?.providers.length ? tfMeta.providers : [...new Set(tfResources.map(r => r.provider))],
				fileCount: tfMeta?.fileCount ?? 0,
				topResourceTypes: [...new Set(tfResources.map(r => r.resourceType))].slice(0, 10),
			};
		}

		if (pipelineJobs.length > 0 || pipelineMeta) {
			const stages = [...new Set(pipelineJobs.map(j => j.stage))];
			hydrated.pipelineSummary = {
				stageCount: stages.length,
				jobCount: pipelineJobs.length,
				hasManualGates: pipelineMeta?.hasManualGates ?? false,
				stages,
			};
		}

		if (k8sCount > 0) hydrated.k8sResourceCount = k8sCount;

		return hydrated;
	}
}
