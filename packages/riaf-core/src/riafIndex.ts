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
import { createEmbedder, Embedder, EmbeddingConfig, EmbeddingVector } from './embeddingService.js';
import { HnswIndex, HnswOptions } from './hnsw.js';
import { FileChangeEvent, WorkspaceFileWatcher } from './fileWatcher.js';
import { indexGatewayRoutes } from './gatewayRouteIndexer.js';
import { getGitBranch, getGitDiffStat, getGitLog, getGitStatus, getRecentlyChangedFiles } from './gitContextIndexer.js';
import { indexGitlabPipelines, PipelineJob } from './gitlabCiIndexer.js';
import { indexAllSpringServices } from './javaSpringIndexer.js';
import { indexKubernetesManifests } from './kubernetesYamlIndexer.js';
import { indexMavenDependencies } from './mavenDependencyIndexer.js';
import { indexNpmDependencies } from './npmImpactIndexer.js';
import { ChunkLedgerEntry, hashWorkspaceRoot, K8sResource, RepoIntelligenceDb, SpringEndpoint } from './repoIntelligenceDb.js';
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
import { ensureTreeSitterLanguages, grammarLanguageFor, setTreeSitterEnabled, setTreeSitterWasmDir, treeSitterReady } from './treeSitterChunker.js';
import { computeMetrics } from './universalGraphAnalyzer.js';
import { extractImports, ImportEdge } from './universalImportExtractor.js';
import { createModuleResolver, ModuleResolver } from './moduleResolver.js';
import { extractSymbolEdges, formatNeighborhood, maskSource, type DefinitionResolver, type SymbolEdge, type SymbolNeighborhood } from './symbolGraph.js';

/**
 * Resolve a simple symbol name to its defining file: the file this file imports from wins, then a
 * unique definer anywhere in the workspace. Ambiguous names (several definers, none imported) are
 * left unresolved so a `save()` does not get pinned to a random repository.
 */
function makeDefinitionResolver(definers: Map<string, string[]>): DefinitionResolver {
	return (name, ctx) => {
		const files = definers.get(name);
		if (!files?.length) return null;
		if (files.length === 1) return files[0];
		const imported = files.filter(f => ctx.importedFiles.has(f));
		if (imported.length === 1) return imported[0];
		if (ctx.importedFrom) {
			const hint = ctx.importedFrom.replace(/\\/g, '/').replace(/^\.\//, '');
			const byHint = files.filter(f => f.includes(hint) || hint.split('/').pop()!.replace(/\.\w+$/, '') === f.split('/').pop()!.replace(/\.\w+$/, ''));
			if (byHint.length === 1) return byHint[0];
		}
		if (files.includes(ctx.fromFile)) return ctx.fromFile;
		return null;
	};
}
import { classifyNode, isEntryPoint } from './universalNodeClassifier.js';
import { buildExcludeMatcher, detectLanguageForPath, RawScanResult, scanWorkspace } from './workspaceScanner.js';
import { GlobOptions, globWorkspace, GrepOptions, GrepResult, grepWorkspace } from './workspaceSearch.js';

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
	/** Honour `.gitignore` files when scanning and watching (default true). */
	respectGitignore?: boolean;
	/** Delay before derived data (org indexers, graph metrics) is recomputed after incremental changes (ms). Default 1500. */
	derivedRefreshDebounceMs?: number;
	/**
	 * AST chunking / symbols via tree-sitter. `false` disables it; an object may point at a
	 * directory with the wasm grammars (defaults to the installed `@vscode/tree-sitter-wasm`).
	 * Falls back to regex heuristics per language when a grammar is unavailable.
	 */
	treeSitter?: boolean | { wasmDir?: string };
	/** Explicit ripgrep binary for `grep()` (VS Code's bundled one, for instance). Discovered on PATH otherwise. */
	ripgrepPath?: string;
	/** Tuning for the in-memory HNSW vector index. */
	vectorIndex?: HnswOptions;
}

/** Which org-extension indexers a changed path can affect. */
export type OrgSlice = 'spring' | 'maven' | 'k8s' | 'gateway' | 'npm' | 'config' | 'terraform' | 'ci';

/** Map a relative path to the org slices that must be re-run when it changes. */
export const orgSlicesForPath = (relPath: string): OrgSlice[] => {
	const p = relPath.replace(/\\/g, '/');
	const base = basename(p).toLowerCase();
	const out = new Set<OrgSlice>();
	if (base === 'pom.xml') { out.add('maven'); out.add('spring'); }
	if (/\.(java|kt)$/.test(base)) out.add('spring');
	if (base === 'package.json') out.add('npm');
	if (/\.(ya?ml)$/.test(base)) {
		out.add('k8s'); out.add('config');
		if (/^application(-[\w-]+)?\.ya?ml$/.test(base)) out.add('gateway');
		if (base === '.gitlab-ci.yml' || base.includes('pipeline') || base.includes('-ci') || p.includes('.gitlab/') || p.includes('.github/')) out.add('ci');
	}
	if (/\.(properties)$/.test(base)) out.add('config');
	if (/\.tf$/.test(base)) out.add('terraform');
	return [...out];
};

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
	/** One-hop symbol neighbourhood of the active file (callers, callees), prompt-ready; empty when unknown. */
	neighborhood?: string;
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
/** Default cap on characters sent per chunk — a full 80-line chunk, not a 512-char prefix. */
const EMBED_TEXT_CHARS = 6_000;

const normalisePath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');
const buildExcludeMatcherNoGitignore = (globs?: readonly string[]) => buildExcludeMatcher(null, globs);
const contentHash = (content: string): string => createHash('sha256').update(content).digest('hex').slice(0, 32);
const symbolFingerprint = (content: string, language: string | null | undefined, filePath: string): string =>
	contentHash(`${treeSitterReady(grammarLanguageFor(language, filePath)) ? 'ast' : 'rx'}\u0000${content}`);
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
	private _isExcluded: (relPath: string) => boolean;
	/** In-memory ANN index over chunk embeddings (built lazily from the DB). */
	private _vectorIndex: HnswIndex | null = null;
	private _resolver: ModuleResolver | null = null;
	private _vectorIndexBuild: Promise<void> | null = null;
	private readonly _vectorIds = new Map<string, number>();
	private readonly _vectorKeys = new Map<number, { filePath: string; startLine: number }>();
	private _nextVectorId = 1;
	/** Derived-data refresh scheduled after incremental changes. */
	private _pendingOrgSlices = new Set<OrgSlice>();
	private _pendingGraphMetrics = false;
	private _derivedTimer: ReturnType<typeof setTimeout> | null = null;
	private _derivedPromise: Promise<void> | null = null;

	private constructor(cfg: RiafConfig, db: RepoIntelligenceDb) {
		this._cfg = cfg;
		this._root = cfg.workspaceRoot;
		this._hash = hashWorkspaceRoot(cfg.workspaceRoot);
		this._db = db;
		this._embedder = createEmbedder(cfg.embeddings);
		this._log = cfg.log ?? (() => { });
		this._orgOptions = resolveOrgExtensionIndexerOptions(cfg.orgExtensions);
		this._isExcluded = cfg.respectGitignore === false
			? buildExcludeMatcherNoGitignore(cfg.excludeGlobs)
			: buildExcludeMatcher(cfg.workspaceRoot, cfg.excludeGlobs);
		if (cfg.treeSitter === false) setTreeSitterEnabled(false);
		else {
			setTreeSitterEnabled(true);
			if (typeof cfg.treeSitter === 'object' && cfg.treeSitter.wasmDir) setTreeSitterWasmDir(cfg.treeSitter.wasmDir);
		}
	}

	/** Load tree-sitter grammars for the given languages; logs once which ones are AST-backed. */
	private async _prepareParsers(languages: Iterable<string>): Promise<void> {
		if (this._cfg.treeSitter === false) return;
		const wanted = [...new Set([...languages].filter(Boolean))];
		if (!wanted.length) return;
		const ready = await ensureTreeSitterLanguages(wanted);
		const key = ready.sort().join(',');
		if (key !== this._parsersLogged) {
			this._parsersLogged = key;
			this._log(ready.length ? `[RiafIndex] tree-sitter grammars ready: ${key}` : '[RiafIndex] tree-sitter unavailable — using regex chunker');
		}
	}
	private _parsersLogged = '';

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

	/**
	 * Recompute data derived from many files — graph metrics / entry flags and the org-extension
	 * slices touched since the last refresh. Runs automatically (debounced) after `indexFiles` /
	 * `removeFiles`; call it directly to force the refresh now (tests, "save then ask").
	 */
	refreshDerived(): Promise<void> {
		if (this._derivedTimer) { clearTimeout(this._derivedTimer); this._derivedTimer = null; }
		const slices = [...this._pendingOrgSlices];
		const graph = this._pendingGraphMetrics;
		this._pendingOrgSlices.clear();
		this._pendingGraphMetrics = false;
		if (!slices.length && !graph) return this._derivedPromise ?? Promise.resolve();
		const run = this._enqueue(async () => {
			if (slices.length) await this._indexOrgExtensions(() => { }, new Set(slices));
			if (graph) await this._recomputeGraphMetrics();
		});
		this._derivedPromise = run.finally(() => { if (this._derivedPromise === run) this._derivedPromise = null; });
		return run;
	}

	startWatching(): void {
		if (this._watcher || this._closed) return;
		const watcher = new WorkspaceFileWatcher({ isExcluded: this._isExcluded });
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
		const queryEmbedding = this._embedder ? await this._embedQuery(trimmed) : null;
		const vectorHits = queryEmbedding ? await this._vectorTopK(queryEmbedding, fetchLimit * 2) : null;
		const rows = await this._db.searchChunksHybrid(this._hash, trimmed, vectorHits, fetchLimit, opts.maxChars ?? Infinity);
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
		const neighborhood = await this.getEditNeighborhood(rel);
		return {
			activeFile: rel,
			relatedFiles,
			tests,
			profileText: formatProfileText(profile, { activeFile: rel, relatedFiles, tests }),
			neighborhood: neighborhood && !/no dependents or dependencies/.test(neighborhood) ? neighborhood : undefined,
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

	async getK8sResources(kind?: string): Promise<K8sResource[]> {
		const all = await this._db.getK8sResources(this._hash);
		return kind ? all.filter(r => r.kind.toLowerCase() === kind.toLowerCase()) : all;
	}

	async getSpringEndpoints(serviceName?: string): Promise<SpringEndpoint[]> {
		const all = await this._db.getSpringEndpoints(this._hash);
		return serviceName ? all.filter(e => e.serviceName === serviceName) : all;
	}

	// ── agentic search (grep / glob, same exclusions as the index) ──────────

	grep(pattern: string, options: Omit<GrepOptions, 'isExcluded'> = {}): Promise<GrepResult> {
		const rgCandidates = options.rgCandidates ?? (this._cfg.ripgrepPath ? [this._cfg.ripgrepPath] : undefined);
		return grepWorkspace(this._root, pattern, { ...options, isExcluded: this._isExcluded, rgCandidates });
	}

	glob(pattern: string, options: Omit<GlobOptions, 'isExcluded'> = {}): { files: string[]; truncated: boolean } {
		return globWorkspace(this._root, pattern, { ...options, isExcluded: this._isExcluded });
	}

	// ── git ──────────────────────────────────────────────────────────────────

	getGitDiffStat(): Promise<string | null> {
		return getGitDiffStat(this._root);
	}

	getGitRecentlyChanged(limit = 20): Promise<GitFileStats[]> {
		return getRecentlyChangedFiles(this._root, limit);
	}

	/** Branch, short status, recent log and diff stat in one call (empty strings when not a git repo). */
	async getGitContext(logCount = 10): Promise<{ branch: string; status: string; log: string; diffStat: string | null }> {
		const [branch, status, log, diffStat] = await Promise.all([
			getGitBranch(this._root), getGitStatus(this._root), getGitLog(this._root, logCount), getGitDiffStat(this._root),
		]);
		return { branch, status, log, diffStat };
	}

	// ── lifecycle ────────────────────────────────────────────────────────────

	/** Write the DB image to disk now. */
	flush(): Promise<void> {
		return this._db.flush();
	}

	async close(): Promise<void> {
		if (this._closed) return;
		this.stopWatching();
		if (this._derivedTimer) { clearTimeout(this._derivedTimer); this._derivedTimer = null; }
		// finish any pending derived refresh so the persisted image is consistent
		try { await this.refreshDerived(); } catch { /* reported via log */ }
		this._closed = true;
		try { await this._queue; } catch { /* already reported */ }
		await this._db.close();
	}

	private _scheduleDerived(slices: Iterable<OrgSlice>, graph: boolean): void {
		for (const s of slices) this._pendingOrgSlices.add(s);
		if (graph) this._pendingGraphMetrics = true;
		if (!this._pendingOrgSlices.size && !this._pendingGraphMetrics) return;
		if (this._derivedTimer) clearTimeout(this._derivedTimer);
		const t = setTimeout(() => {
			this._derivedTimer = null;
			void this.refreshDerived().catch(err => this._log(`[RiafIndex] derived refresh failed: ${String(err)}`));
		}, this._cfg.derivedRefreshDebounceMs ?? 1500);
		(t as { unref?: () => void }).unref?.();
		this._derivedTimer = t;
	}

	/** Recompute entry flags, in-degrees and metrics from the stored graph (after incremental edits). */
	private async _recomputeGraphMetrics(): Promise<void> {
		const { nodes, edges } = await this._db.getUCGGraph(this._hash);
		const inDegree = new Map<string, number>();
		for (const e of edges) if (e.resolvedFile) inDegree.set(e.resolvedFile, (inDegree.get(e.resolvedFile) ?? 0) + 1);
		let entryChanged = false;
		for (const n of nodes) {
			const inDeg = inDegree.get(n.filePath) ?? 0;
			const entry = isEntryPoint(n.filePath, '', inDeg);
			if (entry !== n.isEntryPoint || inDeg !== n.importedByCount) {
				entryChanged = true;
				n.isEntryPoint = entry;
				n.importedByCount = inDeg;
				await this._db.upsertUCGNode(this._hash, n);
			}
		}
		const metrics = computeMetrics(nodes, edges.map(e => ({ ...e, edgeType: e.edgeType as ImportEdge['edgeType'] })));
		await this._db.upsertUCGMetrics(this._hash, {
			totalNodes: metrics.totalNodes,
			totalEdges: metrics.totalEdges,
			entryCount: metrics.entryPoints.length,
			cycleCount: metrics.cycleCount,
			cycles: metrics.cycles,
			hotFiles: metrics.hotFiles,
			externalDeps: Object.fromEntries(metrics.externalDeps),
			maxDepth: metrics.maxDepth,
			orphanFiles: metrics.orphanFiles,
			computedAt: Date.now(),
		});
		if (entryChanged) this._log('[RiafIndex] graph entry flags refreshed');
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
			const scan = scanWorkspace(this._root, { excludeGlobs: this._cfg.excludeGlobs, respectGitignore: this._cfg.respectGitignore });
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
		await this._prepareParsers(indexable.flatMap(f => f.language ? [f.language === 'TypeScript' && /\.tsx$/i.test(f.filePath) ? 'TSX' : f.language] : []));
		const stored = force ? new Map<string, ChunkLedgerEntry>() : await this._db.getChunkFileLedger(this._hash);
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
			const ledger = stored.get(file.filePath);
			const stat = await fs.stat(absPath).catch(() => null);
			if (!stat) {
				await this._db.upsertChunkFileHash(this._hash, file.filePath, 'UNREADABLE');
			} else if (ledger && ledger.contentHash !== 'UNREADABLE' && ledger.mtimeMs === stat.mtimeMs && ledger.sizeBytes === stat.size) {
				// the ledger remembers the stat its hash was computed from — unchanged, skip the read
			} else {
				let content: string | null = null;
				try { content = await fs.readFile(absPath, 'utf8'); } catch { /* unreadable */ }
				if (content === null) {
					await this._db.upsertChunkFileHash(this._hash, file.filePath, 'UNREADABLE');
				} else {
					const current = contentHash(content);
					const fileStat = { mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
					if (ledger?.contentHash !== current) {
						const chunks = chunkFile(this._hash, file.filePath, content, file.language);
						await this._db.replaceChunksForFile(this._hash, file.filePath, chunks);
						if (this._embedder) await this._dropEmbeddingsForFile(file.filePath);
						updated++;
						totalChunks += chunks.length;
					}
					// same content, new stat (touch / checkout): just refresh the ledger
					await this._db.upsertChunkFileHash(this._hash, file.filePath, current, fileStat);
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
				await this._dropEmbeddingsForFile(storedPath);
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
			// the extractor mode is part of the fingerprint: symbols are re-extracted once a grammar becomes available
			const current = symbolFingerprint(content, file.language, file.filePath);
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

	/**
	 * Run the org-extension indexers — all of them on a full reindex, or only the `slices` affected
	 * by changed files on an incremental refresh. Each indexer is isolated: one failing does not
	 * stop the others.
	 */
	private async _indexOrgExtensions(
		progress: (phase: string, done: number, total: number, message?: string) => void,
		slices?: ReadonlySet<OrgSlice>,
	): Promise<number> {
		const want = (s: OrgSlice) => !slices || slices.has(s);
		const steps = slices ? slices.size : 8;
		let done = 0;
		let configFileCount = this._configFileCount;
		const step = (label: string) => progress('org-extensions', ++done, steps, label);
		const run = async (slice: OrgSlice, fn: () => Promise<string>) => {
			if (!want(slice)) return;
			try { step(await fn()); } catch (err) {
				this._log(`[RiafIndex] org-extension indexer '${slice}' failed: ${String(err)}`);
				step(`${slice}: failed`);
			}
		};
		await run('spring', async () => {
			const java = indexAllSpringServices(this._root);
			await this._db.replaceSpringEndpoints(this._hash, java.endpoints);
			await this._db.replaceFeignClients(this._hash, java.feignClients);
			return `spring: ${java.endpoints.length} endpoints`;
		});
		await run('maven', async () => {
			const maven = await indexMavenDependencies(this._root);
			await this._db.replaceMavenDependencies(this._hash, maven.deps);
			return `maven: ${maven.pomCount} poms`;
		});
		await run('k8s', async () => {
			const k8s = indexKubernetesManifests(this._root);
			await this._db.replaceK8sResources(this._hash, k8s);
			return `k8s: ${k8s.length} resources`;
		});
		await run('gateway', async () => {
			const routes = indexGatewayRoutes(this._root);
			await this._db.replaceGatewayRoutes(this._hash, routes);
			return `gateway: ${routes.length} routes`;
		});
		await run('npm', async () => {
			const npm = indexNpmDependencies(this._root, [...this._orgOptions.npmScopes]);
			await this._db.replaceNpmEdges(this._hash, npm.edges);
			return `npm: ${npm.edges.length} edges`;
		});
		await run('config', async () => {
			const config = indexConfigEnvironments(this._root, { configServerDirs: this._orgOptions.configServerDirs });
			configFileCount = config.fileCount;
			await this._db.replaceConfigDrift(this._hash, config.envDrift);
			return `config: ${config.envDrift.length} drifts`;
		});
		await run('terraform', async () => {
			const tf = indexTerraformResources(this._root);
			await this._db.replaceTerraformIndex(this._hash, tf);
			return `terraform: ${tf.resources.length} resources`;
		});
		await run('ci', async () => {
			const ci = indexGitlabPipelines(this._root);
			await this._db.replacePipelineIndex(this._hash, ci);
			return `ci: ${ci.jobs.length} jobs`;
		});
		this._configFileCount = configFileCount;
		return configFileCount;
	}

	/** Compiler-like module resolver over the indexed file set (lazy; rebuilt on full reindex). */
	private async _getResolver(): Promise<ModuleResolver> {
		if (!this._resolver) {
			const files = await this._db.getFileMetadata(this._hash);
			this._resolver = createModuleResolver(this._root, files.map(f => f.filePath));
		}
		return this._resolver;
	}

	/** Re-resolve dangling internal edges — a newly created file may be what they were pointing at. */
	private async _reresolveDanglingEdges(resolver: ModuleResolver): Promise<boolean> {
		const dangling = await this._db.getUnresolvedEdges(this._hash);
		let changed = false;
		for (const e of dangling) {
			const lang = detectLanguageForPath(e.fromFile);
			if (!lang) continue;
			const r = resolver.resolve(e.fromFile, e.toModule, lang);
			if (r.resolvedFile) { await this._db.setEdgeResolution(this._hash, e.fromFile, e.toModule, r.resolvedFile); changed = true; }
		}
		return changed;
	}

	private _buildNodeAndEdges(relPath: string, content: string, language: string, resolver?: ModuleResolver): { node: UCGFileNode; edges: UCGImportEdge[]; imports: ImportEdge[] } {
		const normalizedPath = normalisePath(relPath);
		const classification = classifyNode(normalizedPath, content);
		const imports = extractImports(join(this._root, relPath), content, language, this._root, resolver);
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
		return { node, edges, imports };
	}

	private async _indexGraph(
		fileMeta: FileMetadataEntry[],
		progress: (phase: string, done: number, total: number, message?: string) => void,
	): Promise<void> {
		const started = Date.now();
		const candidates = fileMeta.filter(f => f.language && !SKIP_LANGUAGES.has(f.language));
		const allNodes: UCGFileNode[] = [];
		const allEdges: UCGImportEdge[] = [];
		const allSymbolEdges: SymbolEdge[] = [];
		let processed = 0;
		progress('graph', 0, candidates.length);
		const resolver = createModuleResolver(this._root, fileMeta.map(f => f.filePath));
		this._resolver = resolver;
		const definers = await this._db.getSymbolDefinerIndex(this._hash);
		const resolveDef = makeDefinitionResolver(definers);

		for (const meta of candidates) {
			let content: string;
			try { content = await fs.readFile(join(this._root, meta.filePath), 'utf8'); } catch { continue; }
			const { node, edges, imports } = this._buildNodeAndEdges(meta.filePath, content, meta.language!, resolver);
			allNodes.push(node);
			allEdges.push(...edges);
			if (supportsSymbolExtraction(meta.language!)) {
				const symbols = await this._db.getFileOutline(this._hash, node.filePath);
				allSymbolEdges.push(...extractSymbolEdges({ filePath: node.filePath, content, language: meta.language!, symbols, importEdges: imports, resolve: resolveDef }));
			}
			if (++processed % 100 === 0) {
				progress('graph', processed, candidates.length);
				await yieldToEventLoop();
			}
		}
		await this._db.replaceAllSymbolEdges(this._hash, allSymbolEdges);

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
			maxDepth: metrics.maxDepth,
			orphanFiles: metrics.orphanFiles,
			computedAt: Date.now(),
		});
		progress('graph', candidates.length, candidates.length, `${allNodes.length} nodes, ${allEdges.length} edges, ${allSymbolEdges.length} symbol edges in ${Date.now() - started}ms`);
	}

	/** Symbol edges for one file, resolved against the current symbol table (incremental path). */
	private async _refreshSymbolEdgesForFile(rel: string, content: string, language: string, imports: ImportEdge[]): Promise<void> {
		if (!supportsSymbolExtraction(language)) return;
		const symbols = await this._db.getFileOutline(this._hash, rel);
		const cache = new Map<string, string[]>();
		const lookup = async (name: string) => {
			if (!cache.has(name)) cache.set(name, [...new Set((await this._db.getSymbolsByName(this._hash, name)).map(s => s.filePath))]);
			return cache.get(name)!;
		};
		// pre-warm the lookup for every candidate identifier so the extractor can stay synchronous
		const idents = new Set<string>();
		for (const m of maskSource(content, language).matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g)) idents.add(m[1]);
		for (const m of content.matchAll(/\b(?:extends|implements|import|use|from)\b[^\n]*/g)) for (const w of m[0].match(/[A-Za-z_$][\w$]+/g) ?? []) idents.add(w);
		const definers = new Map<string, string[]>();
		for (const id of idents) definers.set(id, await lookup(id));
		const edges = extractSymbolEdges({ filePath: rel, content, language, symbols, importEdges: imports, resolve: makeDefinitionResolver(definers) });
		await this._db.replaceSymbolEdgesForFile(this._hash, rel, edges);
		// a (re)created file may be the definer that dangling edges in other files were waiting for
		await this._db.reresolveSymbolEdgesTo(this._hash, rel, symbols.map(s => s.name.includes('.') ? s.name.split('.').pop()! : s.name));
	}

	// ── symbol graph queries ─────────────────────────────────────────────────

	/**
	 * Who references a symbol: its definitions plus every call / instantiation / extends /
	 * implements / import edge that targets it. `filePath` narrows to the definition in one file.
	 */
	async findReferences(name: string, options: { filePath?: string; limit?: number } = {}): Promise<{ definitions: ExtractedSymbol[]; references: SymbolEdge[] }> {
		const simple = name.includes('.') ? name.split('.').pop()! : name;
		const file = options.filePath ? this._toRelative(options.filePath) : undefined;
		const definitions = await this._db.getSymbolsByName(this._hash, simple, file);
		const target = file ?? (definitions.length === 1 || new Set(definitions.map(d => d.filePath)).size === 1 ? definitions[0]?.filePath : undefined);
		let references = await this._db.getSymbolEdgesTo(this._hash, target ?? null, simple, options.limit ?? 200);
		if (!target) references = references.filter(e => e.toFile === null || definitions.some(d => d.filePath === e.toFile) || definitions.length === 0);
		return { definitions, references };
	}

	/** One-hop neighbourhood of a file (or of one symbol in it). */
	async getNeighbors(filePath: string, symbol?: string): Promise<SymbolNeighborhood> {
		const rel = this._toRelative(filePath);
		const simple = symbol?.includes('.') ? symbol.split('.').pop()! : symbol;
		const [inbound, outbound, graph] = await Promise.all([
			this._db.getSymbolEdgesTo(this._hash, rel, simple),
			this._db.getSymbolEdgesFrom(this._hash, rel, simple),
			this.getImportGraph(rel, 'both').catch(() => ({ imports: [], importedBy: [], externalDeps: [] })),
		]);
		return { filePath: rel, symbol: simple, inbound, outbound, imports: graph.imports, importedBy: graph.importedBy };
	}

	/** Prompt-ready text: callers and callees the agent should know before editing `filePath`. */
	async getEditNeighborhood(filePath: string, maxChars = 1_800): Promise<string> {
		try { return formatNeighborhood(await this.getNeighbors(filePath), maxChars); } catch { return ''; }
	}

	// ── embeddings: text preparation, content-addressed cache, ANN index ──────

	/** Text sent to the embedding model: a path header for context, then the chunk (capped). */
	private _embedText(filePath: string, chunkText: string): string {
		const cap = this._cfg.embeddings?.maxChars ?? EMBED_TEXT_CHARS;
		const header = `// ${filePath}\n`;
		return header + chunkText.slice(0, Math.max(64, cap - header.length));
	}

	private get _embedModel(): string { return this._cfg.embeddings?.model ?? 'default'; }

	/** Query embeddings go through the same content-addressed cache (agents repeat searches a lot). */
	private async _embedQuery(text: string): Promise<EmbeddingVector | null> {
		if (!this._embedder) return null;
		const h = contentHash(`q\u0000${text}`);
		const cached = this._queryCache.get(h);
		if (cached) return cached;
		const fromDb = (await this._db.getCachedEmbeddings(this._embedModel, [h])).get(h);
		if (fromDb) { this._queryCache.set(h, fromDb); return fromDb; }
		const vec = await this._embedder.embedText(text);
		if (vec) {
			this._queryCache.set(h, vec);
			if (this._queryCache.size > 256) this._queryCache.delete(this._queryCache.keys().next().value!);
			await this._db.putCachedEmbeddings(this._embedModel, [{ textHash: h, embedding: vec }]);
		}
		return vec;
	}
	private readonly _queryCache = new Map<string, EmbeddingVector>();

	/**
	 * Embed `rows`, serving repeats from the content-addressed cache and only sending misses to
	 * the endpoint. Returns the vectors aligned with `rows` (an entry is `undefined` when the
	 * endpoint failed before reaching it) plus how many came from the cache.
	 */
	private async _embedRows(rows: { file_path: string; start_line: number; chunk_text: string }[]): Promise<{ vectors: (EmbeddingVector | undefined)[]; cached: number; endpointFailed: boolean }> {
		const texts = rows.map(r => this._embedText(r.file_path, r.chunk_text));
		const hashes = texts.map(t => contentHash(t));
		const cache = await this._db.getCachedEmbeddings(this._embedModel, [...new Set(hashes)]);
		const vectors: (EmbeddingVector | undefined)[] = hashes.map(h => cache.get(h));
		const missIdx = vectors.flatMap((v, i) => v ? [] : [i]);
		// de-duplicate identical texts inside the batch
		const uniqueMiss = new Map<string, number[]>();
		for (const i of missIdx) (uniqueMiss.get(hashes[i]) ?? uniqueMiss.set(hashes[i], []).get(hashes[i])!).push(i);
		let endpointFailed = false;
		if (uniqueMiss.size) {
			const order = [...uniqueMiss.keys()];
			const got = await this._embedder!.embedTexts(order.map(h => texts[uniqueMiss.get(h)![0]]));
			if (!got) endpointFailed = true;
			else {
				if (got.length < order.length) endpointFailed = true;
				const toCache: { textHash: string; embedding: EmbeddingVector }[] = [];
				got.forEach((vec, k) => {
					if (!vec) return;
					const h = order[k];
					for (const i of uniqueMiss.get(h)!) vectors[i] = vec;
					toCache.push({ textHash: h, embedding: vec });
				});
				await this._db.putCachedEmbeddings(this._embedModel, toCache);
			}
		}
		return { vectors, cached: rows.length - missIdx.length, endpointFailed };
	}

	private async _storeEmbedding(filePath: string, startLine: number, vec: EmbeddingVector): Promise<void> {
		await this._db.upsertChunkEmbedding(this._hash, filePath, startLine, vec);
		this._vectorIndex?.add(this._vectorId(filePath, startLine), vec);
	}

	private async _dropEmbeddingsForFile(filePath: string): Promise<void> {
		await this._db.deleteChunkEmbeddingsForFile(this._hash, filePath);
		if (this._vectorIndex) {
			for (const [key, id] of this._vectorIds) {
				if (key.startsWith(`${filePath}:`)) { this._vectorIndex.remove(id); this._vectorIds.delete(key); this._vectorKeys.delete(id); }
			}
		}
	}

	private _vectorId(filePath: string, startLine: number): number {
		const key = `${filePath}:${startLine}`;
		let id = this._vectorIds.get(key);
		if (id === undefined) { id = this._nextVectorId++; this._vectorIds.set(key, id); this._vectorKeys.set(id, { filePath, startLine }); }
		return id;
	}

	/** Build the ANN index from the stored embeddings (once; later updates are incremental). */
	private async _ensureVectorIndex(): Promise<HnswIndex | null> {
		if (!this._embedder) return null;
		if (this._vectorIndex) return this._vectorIndex;
		if (!this._vectorIndexBuild) {
			this._vectorIndexBuild = (async () => {
				const started = Date.now();
				const rows = await this._db.getAllChunkEmbeddings(this._hash);
				const idx = new HnswIndex(this._cfg.vectorIndex);
				this._vectorIds.clear(); this._vectorKeys.clear(); this._nextVectorId = 1;
				for (const r of rows) idx.add(this._vectorId(r.file_path, r.start_line), r.embedding);
				this._vectorIndex = idx;
				this._log(`[RiafIndex] vector index built: ${idx.size} vectors in ${Date.now() - started}ms`);
			})().finally(() => { this._vectorIndexBuild = null; });
		}
		await this._vectorIndexBuild;
		return this._vectorIndex;
	}

	/** Top-k chunks by cosine similarity from the ANN index (compacting it when many deletes accumulated). */
	private async _vectorTopK(query: EmbeddingVector, k: number): Promise<{ filePath: string; startLine: number; score: number }[]> {
		const idx = await this._ensureVectorIndex();
		if (!idx || idx.size === 0) return [];
		if (idx.deletedRatio > 0.25 && idx.size > 100) idx.rebuild();
		return idx.search(query, k).flatMap(h => { const key = this._vectorKeys.get(h.id); return key ? [{ ...key, score: h.score }] : []; });
	}

	private async _indexEmbeddings(progress: (phase: string, done: number, total: number, message?: string) => void): Promise<void> {
		if (!this._embedder) return;
		const total = await this._db.getChunkCount(this._hash);
		let done = 0;
		let cachedTotal = 0;
		progress('embeddings', 0, total);
		// Loop until no chunk is missing an embedding (or the endpoint goes away).
		for (; ;) {
			const rows = await this._db.getChunksWithoutEmbeddings(this._hash, EMBEDDING_BATCH);
			if (rows.length === 0) break;
			const { vectors, cached, endpointFailed } = await this._embedRows(rows);
			cachedTotal += cached;
			let stored = 0;
			for (let i = 0; i < rows.length; i++) {
				if (vectors[i]) { await this._storeEmbedding(rows[i].file_path, rows[i].start_line, vectors[i]!); stored++; }
			}
			done += stored;
			if (stored === 0) {
				this._log('[RiafIndex] embedding endpoint unavailable — continuing with BM25 only');
				progress('embeddings', done, total, 'endpoint unavailable');
				return;
			}
			if (endpointFailed || stored < rows.length) {
				// the embedder gave up part-way (outage); what we have is persisted — the next pass resumes here
				this._log(`[RiafIndex] embedding endpoint failed mid-batch — ${done}/${total} chunks embedded, will resume on the next pass`);
				progress('embeddings', done, total, 'endpoint unavailable');
				return;
			}
			progress('embeddings', Math.min(done, total), total);
			await yieldToEventLoop();
		}
		progress('embeddings', total, total, cachedTotal ? `${cachedTotal} from cache` : undefined);
	}

	private async _embedFile(relPath: string): Promise<void> {
		if (!this._embedder) return;
		const rows = await this._db.getChunksForFile(this._hash, relPath);
		await this._dropEmbeddingsForFile(relPath);
		if (rows.length === 0) return;
		const { vectors } = await this._embedRows(rows);
		for (let i = 0; i < rows.length; i++) {
			if (vectors[i]) await this._storeEmbedding(rows[i].file_path, rows[i].start_line, vectors[i]!);
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
		let newFiles = false;
		const orgSlices = new Set<OrgSlice>();
		const resolver = await this._getResolver();
		for (const raw of relPaths) {
			const rel = this._toRelative(raw);
			if (!rel) continue;
			if (this._isExcluded(rel)) continue;
			for (const s of orgSlicesForPath(rel)) orgSlices.add(s);
			const language = detectLanguageForPath(rel);
			const absPath = join(this._root, rel);
			const stat = await fs.stat(absPath).catch(() => null);
			if (!stat || !stat.isFile()) {
				await this._removeFiles([rel]);
				continue;
			}
			if (!resolver.hasFile(rel)) { resolver.addFile(rel); newFiles = true; }

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
			if (stored === current) {
				await this._db.upsertChunkFileHash(this._hash, rel, current, { mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
				continue;
			}

			await this._prepareParsers([grammarLanguageFor(language, rel) ?? language]);
			const chunks = chunkFile(this._hash, rel, content, language);
			await this._db.replaceChunksForFile(this._hash, rel, chunks);
			await this._db.upsertChunkFileHash(this._hash, rel, current, { mtimeMs: stat.mtimeMs, sizeBytes: stat.size });

			if (supportsSymbolExtraction(language)) {
				await this._db.replaceSymbolsForFile(this._hash, rel, extractSymbolsFromFile(this._hash, rel, content, language));
				await this._db.upsertFileHash(this._hash, rel, symbolFingerprint(content, language, rel));
			}

			const { node, edges, imports } = this._buildNodeAndEdges(rel, content, language, resolver);
			const importers = await this._db.getImportEdgesTo(this._hash, node.filePath);
			node.importedByCount = importers.length;
			node.isEntryPoint = isEntryPoint(node.filePath, '', importers.length);
			await this._db.upsertUCGNode(this._hash, node);
			await this._db.replaceUCGEdgesForFile(this._hash, node.filePath, edges);
			await this._refreshSymbolEdgesForFile(rel, content, language, imports);
			touchedGraph = true;

			await this._embedFile(rel);
		}
		if (newFiles && await this._reresolveDanglingEdges(resolver)) touchedGraph = true;
		if (touchedGraph) await this._db.refreshUCGImportedByCounts(this._hash);
		this._scheduleDerived(orgSlices, touchedGraph);
		await this._refreshStatus();
	}

	private async _removeFiles(relPaths: string[]): Promise<void> {
		let touchedGraph = false;
		const orgSlices = new Set<OrgSlice>();
		for (const raw of relPaths) {
			const rel = this._toRelative(raw);
			if (!rel) continue;
			for (const s of orgSlicesForPath(rel)) orgSlices.add(s);
			this._resolver?.removeFile(rel);
			await this._db.replaceChunksForFile(this._hash, rel, []);
			await this._db.deleteChunkFileHash(this._hash, rel);
			await this._dropEmbeddingsForFile(rel);
			await this._db.replaceSymbolsForFile(this._hash, rel, []);
			await this._db.deleteFileMetadata(this._hash, rel);
			await this._db.deleteUCGNode(this._hash, rel);
			await this._db.replaceUCGEdgesForFile(this._hash, rel, []);
			// edges from other files that pointed at the removed file are now dangling
			await this._db.unresolveEdgesTo(this._hash, rel);
			await this._db.replaceSymbolEdgesForFile(this._hash, rel, []);
			await this._db.unresolveSymbolEdgesTo(this._hash, rel);
			touchedGraph = true;
		}
		if (touchedGraph) await this._db.refreshUCGImportedByCounts(this._hash);
		this._scheduleDerived(orgSlices, touchedGraph);
		await this._refreshStatus();
	}

	private async _handleWatchEvents(events: FileChangeEvent[]): Promise<void> {
		const excluded = this._isExcluded;
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
