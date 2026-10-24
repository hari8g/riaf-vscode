/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// ── high-level façade ───────────────────────────────────────────────────────
export {
	RiafIndex,
	formatProfileText,
	type RiafConfig,
	type IndexProgress,
	type ReindexOptions,
	type ChunkSearchResult,
	type SymbolSearchResult,
	type ContextualProfile,
	type SearchOptions,
	type IndexStatus,
	type OrgSlice,
	orgSlicesForPath,
} from './riafIndex.js';

// ── plain data types ────────────────────────────────────────────────────────
export * from './repoIntelligenceTypes.js';

// ── persistence ─────────────────────────────────────────────────────────────
export {
	RepoIntelligenceDb,
	hashWorkspaceRoot,
	splitIdentifiers,
	buildFtsQuery,
	setSqliteModuleLoader,
	type SqliteModuleLoader,
	type RepoIntelligenceDbOptions,
	type SpringEndpoint,
	type FeignClientEdge,
	type MavenDep,
	type GatewayRoute,
	type K8sResource,
	type NpmPackageEdge,
	type TerraformIndexMeta,
	type PipelineIndexMeta,
} from './repoIntelligenceDb.js';

// ── indexing report ─────────────────────────────────────────────────────────
export { formatRepoIntelligenceIndexingReport, buildIndexingStatsFromProfile } from './repoIntelligenceIndexingReport.js';

// ── scanning / chunking / symbols ───────────────────────────────────────────
export {
	scanWorkspace,
	detectLanguage,
	detectLanguageForPath,
	compileExcludeGlobs,
	compileFileGlob,
	compileGitignore,
	loadRootGitignore,
	buildExcludeMatcher,
	SKIP_DIRS,
	EXT_TO_LANGUAGE,
	type RawScanResult,
	type ScanOptions,
} from './workspaceScanner.js';
export {
	chunkFile,
	extractSymbolsFromFile,
	buildChunksForWorkspace,
	supportsSymbolExtraction,
	SKIP_LANGUAGES,
} from './codeChunker.js';
export { detectCommands, type DetectedCommands } from './commandDetector.js';
export {
	grepWorkspace,
	globWorkspace,
	walkFiles,
	findRipgrep,
	formatGrepResult,
	type GrepOptions,
	type GrepMatch,
	type GrepResult,
	type GlobOptions,
} from './workspaceSearch.js';
export {
	ensureTreeSitterLanguages,
	parseOutline,
	flattenOutline,
	treeSitterReady,
	setTreeSitterWasmDir,
	setTreeSitterEnabled,
	TREE_SITTER_LANGUAGES,
	type AstDefinition,
} from './treeSitterChunker.js';

// ── universal context graph ─────────────────────────────────────────────────
export {
	extractImports,
	type ImportEdge,
	type FileNode,
	type NodeType,
	type ArchLayer,
} from './universalImportExtractor.js';
export { classifyNode, isEntryPoint } from './universalNodeClassifier.js';
export { computeMetrics, detectCycles, type GraphMetrics, type UCGFileNodeInput } from './universalGraphAnalyzer.js';

// ── embeddings ──────────────────────────────────────────────────────────────
export {
	createEmbedder,
	cosineSimilarity,
	serializeEmbedding,
	deserializeEmbedding,
	type Embedder,
	type EmbeddingConfig,
	type EmbeddingVector,
} from './embeddingService.js';

export { HnswIndex, bruteForceTopK, type HnswOptions, type HnswHit } from './hnsw.js';
export { createModuleResolver, createModuleResolverFromDisk, type ModuleResolver, type Resolution } from './moduleResolver.js';
export {
	extractSymbolEdges, extractImportBindings, extractInheritance, maskSource, formatNeighborhood,
	type SymbolEdge, type SymbolEdgeType, type SymbolNeighborhood, type ImportBinding, type DefinitionResolver, type ExtractSymbolEdgesInput,
} from './symbolGraph.js';
export { computeMaxDepth } from './universalGraphAnalyzer.js';

// ── git context ─────────────────────────────────────────────────────────────
export {
	getGitDiffStat,
	getGitStatus,
	getGitBranch,
	getGitLog,
	getRecentlyChangedFiles,
	buildGitContextBlock,
} from './gitContextIndexer.js';

// ── file watching ───────────────────────────────────────────────────────────
export { WorkspaceFileWatcher, type FileChangeEvent, type WatcherOptions } from './fileWatcher.js';

// ── org-extension (STaaS) indexers ──────────────────────────────────────────
export {
	resolveOrgExtensionIndexerOptions,
	DEFAULT_ORG_EXTENSION_NPM_SCOPES,
	DEFAULT_ORG_EXTENSION_CONFIG_SERVER_DIRS,
} from './staasIndexerDefaults.js';
export { indexJavaSpringService, indexAllSpringServices, type JavaIndexResult } from './javaSpringIndexer.js';
export { indexMavenDependencies, parsePomDependencies, type MavenIndexResult } from './mavenDependencyIndexer.js';
export { indexKubernetesManifests } from './kubernetesYamlIndexer.js';
export { indexGatewayRoutes } from './gatewayRouteIndexer.js';
export { indexNpmDependencies, type NpmImpactResult } from './npmImpactIndexer.js';
export {
	indexConfigEnvironments,
	type ConfigIndexResult,
	type ConfigIndexOptions,
	type ConfigProperty,
	type EnvDrift,
} from './configEnvIndexer.js';
export {
	indexTerraformResources,
	type TerraformIndexResult,
	type TerraformResource,
	type TerraformModule,
} from './terraformIndexer.js';
export {
	indexGitlabPipelines,
	type PipelineIndexResult,
	type PipelineJob,
	type PipelineStage,
} from './gitlabCiIndexer.js';
