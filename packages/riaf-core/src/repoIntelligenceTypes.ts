/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Plain data types shared by the RIAF repository-intelligence engine.
 * This file carries no runtime dependencies: the VS Code service interfaces and
 * decorators that lived here in the Trove fork were removed when the engine was
 * extracted into a standalone library.
 */

export type { OrgExtensionIndexerOptions } from './staasIndexerDefaults.js';

export type CommandPurpose = 'build' | 'test' | 'lint' | 'typecheck' | 'start' | 'format';

export type CommandEntry = {
	command: string;
	purpose: CommandPurpose;
	confidence: 'high' | 'medium' | 'low';
	source: string;
};

export type FrameworkEntry = {
	name: string;
	version: string | null;
	confidence: 'high' | 'medium' | 'low';
};

// ── Org-extension (STaaS) summary types ─────────────────────────────────────

export type ServiceTopologySummary = {
	serviceCount: number;
	serviceNames: string[];
	gatewayRoutes: { pathPattern: string; targetService: string }[];
	feignEdges: { caller: string; targets: string[] }[];
	totalEndpoints: number;
};

export type MavenImpactSummary = {
	sharedLibs: { artifactId: string; consumerCount: number }[];
	pomCount: number;
};

export type NpmImpactSummary = {
	sharedPackages: { packageName: string; consumerCount: number }[];
	packageJsonCount: number;
};

export type ConfigDriftSummary = {
	driftCount: number;
	fileCount: number;
	topDriftedServices: string[];
};

export type ConfigDriftEntry = {
	key: string;
	envValues: Record<string, string>;
};

export type ApiContractResult = {
	pathPattern: string;
	httpMethod: string;
	backendService: string;
	controllerClass: string;
	handlerMethod: string;
	requestDto?: string;
	responseDto?: string;
	filePath: string;
};

/** Optional profile fields populated by org-extension indexers. */
export type StaasWorkspaceProfileFields = {
	serviceTopologySummary?: ServiceTopologySummary | null;
	mavenImpactSummary?: MavenImpactSummary | null;
	npmImpactSummary?: NpmImpactSummary | null;
	configDriftSummary?: ConfigDriftSummary | null;
};

// ── Workspace profile ───────────────────────────────────────────────────────

export type CoreWorkspaceProfile = {
	workspaceRoot: string;
	lastScannedAt: number;
	languageStack: string[];
	frameworks: FrameworkEntry[];
	packageManagers: string[];
	buildCommands: CommandEntry[];
	testCommands: CommandEntry[];
	lintCommands: CommandEntry[];
	typecheckCommands: CommandEntry[];
	projectPurpose: string | null;
	architectureSummary: string | null;
	fileCount: number;
	totalLoc: number;
	isStale: boolean;
	/** Terraform IaC resource summary */
	terraformSummary?: TerraformSummary | null;
	/** GitLab CI pipeline structure summary */
	pipelineSummary?: PipelineSummary | null;
	/** Number of K8s resources indexed (Deployments, Services, Ingresses, etc.) */
	k8sResourceCount?: number;
};

export type WorkspaceProfile = CoreWorkspaceProfile & StaasWorkspaceProfileFields;

export type TerraformSummary = {
	resourceCount: number;
	providers: string[];
	fileCount: number;
	topResourceTypes: string[];
};

export type PipelineSummary = {
	stageCount: number;
	jobCount: number;
	hasManualGates: boolean;
	stages: string[];
};

/** Terraform resource row returned by getTerraformResources */
export type TerraformResourceRow = {
	filePath: string;
	resourceType: string;
	resourceName: string;
	provider: string;
};

/** GitLab CI job row returned by getPipelineJobs */
export type PipelineJobRow = {
	name: string;
	stage: string;
	needs: string[];
	filePath: string;
};

// ── Universal Context Graph ─────────────────────────────────────────────────

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
	computedAt: number;
};

export type UCGGraphData = {
	nodes: UCGFileNode[];
	edges: UCGImportEdge[];
	metrics: UCGGraphMetrics | null;
};

// ── Files, chunks, symbols ──────────────────────────────────────────────────

export type FileMetadataEntry = {
	filePath: string;
	language: string | null;
	lastModified: number;
	sizeBytes: number;
};

export type CodeChunkType = 'function' | 'class' | 'block' | 'file';

export type CodeChunk = {
	id: string;
	filePath: string;
	chunkText: string;
	startLine: number;
	endLine: number;
	chunkType: CodeChunkType;
};

export type CodebaseSearchResult = {
	filePath: string;
	startLine: number;
	endLine: number;
	snippet: string;
	score: number;
};

export type ExtractedSymbol = {
	name: string;
	kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const';
	filePath: string;
	startLine: number;
	endLine: number;
	signature: string;
	docstring: string;
	isExported: boolean;
	contentHash: string;
};

export type RepoIntelligenceIndexingStats = {
	chunkCount: number;
	indexedFileCount: number;
	totalFileCount: number;
	indexableFileCount: number;
	symbolCount: number;
	symbolFileCount: number;
	chunksByType: Record<string, number>;
	filesByLanguage: Record<string, number>;
	chunksByLanguage: Record<string, number>;
	symbolsByLanguage: Record<string, number>;
	springEndpoints: number;
	feignClients: number;
	mavenDeps: number;
	k8sResources: number;
	gatewayRoutes: number;
	npmEdges: number;
	configDrift: number;
	terraformResources: number;
	pipelineJobs: number;
	/** Present when stats were synthesized from profile instead of SQLite aggregates */
	statsSource?: 'database' | 'profile';
};

export type ImportGraphResult = {
	imports: string[];       // files this file imports (resolved relative paths)
	importedBy: string[];    // files that import this file
	externalDeps: string[];  // unresolved external module names
};

export type TestCoverageEntry = {
	testFile: string;
	confidence: 'high' | 'medium';
};

export type GitFileStats = {
	file: string;
	changeCount: number;
	lastChanged: string;
};

export type ScopedRuleInfo = {
	source: string;
	content: string;
	globs: string[];
	alwaysApply: boolean;
};

export const REPO_INTEL_PROFILE_STALE_MS = 24 * 60 * 60 * 1000;

// Injection char budget caps (per mode). CHARS_PER_TOKEN ≈ 4 in wireMessageTrim.
export const REPO_PROFILE_MAX_CHARS: Record<'agent' | 'gather' | 'normal', number> = {
	agent: 8_000,
	gather: 3_200, // ~800 tokens — commands + framework
	normal: 1_600, // ~400 tokens — language + minimal facts
};
