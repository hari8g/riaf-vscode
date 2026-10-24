/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { RepoIntelligenceIndexingStats, WorkspaceProfile } from './repoIntelligenceTypes.js';

const SKIP_LANGUAGES = new Set([
	'Markdown', 'JSON', 'YAML', 'TOML', 'HTML', 'CSS', 'SCSS', 'Sass', 'Less',
]);

const formatRecord = (record: Record<string, number>, limit = 12): string => {
	const entries = Object.entries(record).sort((a, b) => b[1] - a[1]);
	if (entries.length === 0) {
		return '_None indexed yet._';
	}
	const lines = entries.slice(0, limit).map(([key, count]) => `- **${key}**: ${count.toLocaleString()}`);
	if (entries.length > limit) {
		lines.push(`- _…and ${entries.length - limit} more_`);
	}
	return lines.join('\n');
};

const formatPercent = (part: number, total: number): string => {
	if (total <= 0) {
		return '0%';
	}
	return `${Math.round((part / total) * 100)}%`;
};

export const buildIndexingStatsFromProfile = (
	profile: WorkspaceProfile | null,
	chunkCount: number,
): RepoIntelligenceIndexingStats => {
	const totalFileCount = profile?.fileCount ?? 0;
	const indexableFileCount = totalFileCount;
	const indexedFileCount = chunkCount > 0
		? Math.min(indexableFileCount, Math.max(1, Math.round(chunkCount / 4)))
		: 0;

	const topo = profile?.serviceTopologySummary;
	const maven = profile?.mavenImpactSummary;
	const npm = profile?.npmImpactSummary;
	const drift = profile?.configDriftSummary;
	const terraform = profile?.terraformSummary;
	const pipeline = profile?.pipelineSummary;

	return {
		chunkCount,
		indexedFileCount,
		totalFileCount,
		indexableFileCount,
		symbolCount: 0,
		symbolFileCount: 0,
		chunksByType: {},
		filesByLanguage: Object.fromEntries((profile?.languageStack ?? []).map(lang => [lang, 0])),
		chunksByLanguage: {},
		symbolsByLanguage: {},
		springEndpoints: topo?.totalEndpoints ?? 0,
		feignClients: topo?.feignEdges?.length ?? 0,
		mavenDeps: maven?.pomCount ?? 0,
		k8sResources: profile?.k8sResourceCount ?? 0,
		gatewayRoutes: topo?.gatewayRoutes?.length ?? 0,
		npmEdges: npm?.sharedPackages?.length ?? 0,
		configDrift: drift?.driftCount ?? 0,
		terraformResources: terraform?.resourceCount ?? 0,
		pipelineJobs: pipeline?.jobCount ?? 0,
		statsSource: 'profile',
	};
};

const assessCoverage = (stats: RepoIntelligenceIndexingStats): { label: string; detail: string } => {
	if (stats.indexableFileCount === 0) {
		return { label: 'No indexable source files', detail: 'The workspace scan did not find supported source languages.' };
	}

	const fileCoverage = stats.indexedFileCount / stats.indexableFileCount;

	if (stats.statsSource === 'profile' && stats.chunkCount >= 1_000) {
		return {
			label: 'Good',
			detail: 'Semantic search is active. Restart Trove fully for exact per-file coverage numbers.',
		};
	}

	if (fileCoverage >= 0.85) {
		return {
			label: 'Strong',
			detail: 'Most indexable files are represented in semantic search.',
		};
	}
	if (fileCoverage >= 0.5 || stats.chunkCount >= 1_000) {
		return {
			label: 'Good',
			detail: 'A meaningful portion of the codebase is searchable, though some files may be missing.',
		};
	}
	if (stats.chunkCount > 0) {
		return {
			label: 'Partial',
			detail: 'Some chunks are indexed, but coverage is limited relative to indexable files.',
		};
	}
	return {
		label: 'Not indexed',
		detail: 'Chunk indexing has not completed yet or the workspace has no supported source files.',
	};
};

const assessSymbols = (stats: RepoIntelligenceIndexingStats): { label: string; detail: string } => {
	if (stats.statsSource === 'profile') {
		return {
			label: 'Unknown',
			detail: 'Symbol counts require a full Trove restart so the main process picks up the latest indexer.',
		};
	}
	if (stats.symbolCount === 0) {
		return {
			label: 'Not indexed',
			detail: 'No regex-extracted symbols are stored yet. Symbol search (`search_symbols`) will be empty.',
		};
	}
	if (stats.symbolFileCount >= 50 || stats.symbolCount >= 500) {
		return {
			label: 'Good',
			detail: 'Symbol extraction is active for supported languages (TypeScript, JavaScript, Python, Go, Rust, Java).',
		};
	}
	return {
		label: 'Limited',
		detail: 'Only a small number of symbols were extracted. Nested or non-standard declarations may be missed by regex patterns.',
	};
};

const assessStaas = (stats: RepoIntelligenceIndexingStats, profile: WorkspaceProfile | null): string[] => {
	const lines: string[] = [];
	const add = (name: string, count: number, note: string) => {
		lines.push(`- **${name}**: ${count > 0 ? `${count.toLocaleString()} indexed` : 'not detected'} — ${note}`);
	};

	add('Spring REST endpoints', stats.springEndpoints, 'regex scan of `@RestController` Java files');
	add('Feign client edges', stats.feignClients, 'inter-service call graph hints');
	add('Maven dependencies', stats.mavenDeps, 'pom.xml consumer → artifact edges');
	add('Gateway routes', stats.gatewayRoutes, 'Spring Cloud Gateway YAML / properties');
	add('Kubernetes manifests', stats.k8sResources, 'Deployment/Service/Ingress YAML');
	add('NPM package edges', stats.npmEdges, 'shared internal package consumers');
	add('Config env drift', stats.configDrift, 'multi-environment property differences');
	add('Terraform resources', stats.terraformResources, '`.tf` resource blocks');
	add('GitLab CI jobs', stats.pipelineJobs, '`.gitlab-ci.yml` stage/job graph');

	if (profile?.serviceTopologySummary?.serviceCount) {
		lines.unshift(`- **Detected services**: ${profile.serviceTopologySummary.serviceCount} (${profile.serviceTopologySummary.serviceNames.slice(0, 8).join(', ')}${profile.serviceTopologySummary.serviceNames.length > 8 ? ', …' : ''})`);
	}

	return lines;
};

export const formatRepoIntelligenceIndexingReport = (
	workspaceRoot: string,
	profile: WorkspaceProfile | null,
	stats: RepoIntelligenceIndexingStats,
	isIndexing: boolean,
): string => {
	const scannedAt = profile?.lastScannedAt
		? new Date(profile.lastScannedAt).toLocaleString()
		: 'Not scanned yet';
	const coverage = assessCoverage(stats);
	const symbols = assessSymbols(stats);
	const skippedLanguages = [...SKIP_LANGUAGES].sort().join(', ');
	const breakdownNote = stats.statsSource === 'profile'
		? '_Per-type and per-language breakdown requires a full Trove restart (quit and relaunch `./scripts/code.sh`)._'
		: undefined;

	const sections = [
		'# Repository Intelligence Index Report',
		'',
		`Workspace: \`${workspaceRoot}\``,
		`Generated: ${new Date().toLocaleString()}`,
		`Profile last scanned: ${scannedAt}${profile?.isStale ? ' _(stale — refresh recommended)_' : ''}`,
		isIndexing ? `Status: **Indexing in progress**` : `Status: **Ready**`,
		stats.statsSource === 'profile' ? `Data source: **profile summary** (main process reload pending for full DB stats)` : '',
		'',
		'## How parsing works (Tree-sitter vs RIAF)',
		'',
		'**Important:** Repository Intelligence (RIAF) does **not** use Tree-sitter for indexing.',
		'',
		'| Layer | Technology | Purpose |',
		'| --- | --- | --- |',
		'| Editor syntax highlighting | VS Code Tree-sitter WASM (`@vscode/tree-sitter-wasm`) | Accurate token colors in the editor |',
		'| RIAF chunk + symbol index | Regex boundary patterns per language | Fast, dependency-free semantic search (`search_codebase`, `search_symbols`) |',
		'| RIAF STaaS indexers | Regex / structured text parsers | Spring, Maven, K8s, Terraform, GitLab CI, gateway routes, config drift |',
		'',
		'Tree-sitter in the editor and RIAF indexing are independent. Good syntax highlighting does **not** imply RIAF has AST-level understanding of your code.',
		'',
		'### RIAF chunking pipeline',
		'',
		'1. **Workspace scan** — file extensions, LOC, frameworks, build commands.',
		`2. **Chunk extraction** — splits source files on language-specific regex boundaries (functions, classes, blocks). Skips: ${skippedLanguages}.`,
		'3. **FTS index** — SQLite FTS5 (`chunks_fts`) powers BM25-ranked `search_codebase`.',
		'4. **Symbol extraction** — incremental regex pass on changed files; stored in `symbols` + `symbols_fts`.',
		'5. **STaaS indexers** — run during profile scan when matching artifacts are found.',
		'',
		'## Index quality summary',
		'',
		`| Metric | Value | Assessment |`,
		`| --- | --- | --- |`,
		`| Semantic search coverage | ${stats.indexedFileCount.toLocaleString()} / ${stats.indexableFileCount.toLocaleString()} indexable files (${formatPercent(stats.indexedFileCount, stats.indexableFileCount)}) | **${coverage.label}** — ${coverage.detail} |`,
		`| Code chunks | ${stats.chunkCount.toLocaleString()} | Indexed for semantic search |`,
		`| Symbols | ${stats.symbolCount.toLocaleString()} across ${stats.symbolFileCount.toLocaleString()} files | **${symbols.label}** — ${symbols.detail} |`,
		`| Total scanned files | ${stats.totalFileCount.toLocaleString()} | Includes config, docs, assets |`,
	];

	if (profile) {
		sections.push(
			'',
			'## Workspace profile',
			'',
			`- **Languages:** ${profile.languageStack.join(', ') || 'unknown'}`,
			`- **Frameworks:** ${profile.frameworks.map(f => f.name).join(', ') || 'none detected'}`,
			`- **LOC:** ${profile.totalLoc.toLocaleString()} across ${profile.fileCount.toLocaleString()} files`,
			profile.projectPurpose ? `- **Purpose:** ${profile.projectPurpose}` : '',
			profile.architectureSummary ? `- **Architecture:** ${profile.architectureSummary}` : '',
		);
	}

	sections.push(
		'',
		'## Chunks by type',
		'',
		breakdownNote ?? formatRecord(stats.chunksByType),
		'',
		'## Files by language (scan metadata)',
		'',
		stats.statsSource === 'profile'
			? (profile?.languageStack.length
				? profile.languageStack.map(lang => `- **${lang}**`).join('\n')
				: '_None detected._')
			: formatRecord(stats.filesByLanguage),
		'',
		'## Chunks by language',
		'',
		breakdownNote ?? formatRecord(stats.chunksByLanguage),
		'',
		'## Symbols by language',
		'',
		breakdownNote ?? formatRecord(stats.symbolsByLanguage),
		'',
		'## STaaS / polyglot indexers',
		'',
		...assessStaas(stats, profile),
		'',
		'## Known limitations',
		'',
		'- Regex chunking may split nested or generated code imperfectly.',
		'- Symbols miss arrow functions, anonymous classes, and non-top-level declarations.',
		'- STaaS indexers are heuristic; validate critical routes and dependencies manually.',
		'',
		'---',
		'_Click the status bar index indicator anytime to refresh this report._',
	);

	return sections.filter(line => line !== undefined && line !== '').join('\n');
};
