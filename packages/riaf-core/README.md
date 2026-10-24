# @bosch-mps/riaf-core

Standalone Node/TypeScript port of the RIAF (Reasoning and Indexing Agent Framework)
repository-intelligence engine extracted from the Trove VS Code fork. No Electron,
no VS Code services, no native modules.

What it does for a workspace:

- **Scan** – languages, frameworks, package managers, build/test/lint/typecheck commands.
- **Chunk + symbols** – regex boundary chunking per language, exported-symbol extraction,
  stored in SQLite with FTS5 (BM25) indexes; camelCase/snake_case identifiers are split so
  `order controller` matches `OrderController`.
- **Hybrid retrieval** – BM25 fused with cosine-similarity over embeddings using
  Reciprocal Rank Fusion (K = 60); degrades to BM25-only when embeddings are off/unavailable.
- **Universal Context Graph (UCG)** – file nodes, resolved import edges, entry points, cycles,
  hot files, external dependency counts.
- **Org-extension indexers** – Spring endpoints / Feign clients, Maven and npm dependency
  edges, Kubernetes manifests, gateway routes, Spring Cloud Config drift, Terraform, GitLab CI.
- **Persistence** – the official SQLite WebAssembly build (`@sqlite.org/sqlite-wasm`, ships
  FTS5). The DB lives in WASM memory and is written to `dbPath` as a single file, debounced
  1 s after the last write and on `close()`.

## Install

```sh
npm install @bosch-mps/riaf-core
```

Requires Node ≥ 20 (uses global `fetch`). ESM only.

## Quick start

```ts
import { RiafIndex } from '@bosch-mps/riaf-core';

const index = await RiafIndex.open({
  workspaceRoot: '/path/to/repo',
  dbPath: '/path/to/.riaf/index.sqlite',       // or ':memory:'
  excludeGlobs: ['generated/', '**/*.snap'],   // gitignore-style, optional
  embeddings: {                                // optional – BM25-only when omitted
    enabled: true,
    url: 'http://localhost:4000/v1/embeddings', // any OpenAI-compatible /embeddings endpoint
    model: 'text-embedding-3-small',
    headers: { Authorization: `Bearer ${process.env.LITELLM_KEY}` },
  },
  summarize: async prompt => callYourLlm(prompt), // optional – project/architecture summaries
  log: msg => console.log(msg),
});

const stats = await index.reindex({
  onProgress: p => console.log(`${p.phase} ${p.done}/${p.total} ${p.message ?? ''}`),
});

const hits = await index.searchHybrid('capture payment', { limit: 10, filePathPrefix: 'src/' });
const symbols = await index.searchSymbols('OrderService');
const ctx = await index.getContextualProfile('src/orderService.ts');
console.log(ctx.relatedFiles, ctx.tests, ctx.profileText);

index.startWatching();   // incremental updates via fs.watch (2 s debounce)
// ...
await index.close();     // flushes the DB image to dbPath
```

## API

### `RiafIndex`

```ts
interface RiafConfig {
  workspaceRoot: string;
  dbPath: string;                              // file path for the SQLite image, or ':memory:'
  embeddings?: { enabled: boolean; url: string; model: string; headers?: Record<string, string>;
                 timeoutMs?: number; batchSize?: number };
  summarize?: (prompt: string) => Promise<string>;  // LLM hook; summaries skipped if absent
  excludeGlobs?: string[];
  orgExtensions?: Partial<OrgExtensionIndexerOptions>;  // { npmScopes, configServerDirs }
  log?: (msg: string) => void;
  persistDebounceMs?: number;                  // default 1000
  summarizeTimeoutMs?: number;                 // default 30000
}

interface IndexProgress { phase: string; done: number; total: number; message?: string }
// phases: scan → chunks → symbols → org-extensions → graph → embeddings → summaries → done

class RiafIndex {
  static open(cfg: RiafConfig): Promise<RiafIndex>;

  reindex(opts?: { force?: boolean; onProgress?: (p: IndexProgress) => void }): Promise<RepoIntelligenceIndexingStats>;
  indexFiles(relPaths: string[]): Promise<void>;        // incremental: chunks, symbols, UCG edges, embeddings
  removeFiles(relPaths: string[]): Promise<void>;
  startWatching(): void;
  stopWatching(): void;

  searchHybrid(query: string, opts?: { limit?: number; filePathPrefix?: string; maxChars?: number }): Promise<ChunkSearchResult[]>;
  searchBM25(query: string, opts?: { limit?: number; filePathPrefix?: string; maxChars?: number }): Promise<ChunkSearchResult[]>;
  searchSymbols(query: string, limit?: number): Promise<SymbolSearchResult[]>;
  getFileOutline(relPath: string): Promise<ExtractedSymbol[]>;
  getSymbol(relPath: string, name: string): Promise<ExtractedSymbol | null>;

  getContextualProfile(activeRelPath?: string): Promise<ContextualProfile>;
  getWorkspaceProfile(): Promise<WorkspaceProfile | undefined>;
  getIndexingReport(): Promise<string>;                 // markdown
  getIndexingStats(): Promise<RepoIntelligenceIndexingStats>;
  getGraph(): Promise<{ nodes: UCGFileNode[]; edges: UCGImportEdge[] }>;
  getGraphMetrics(): Promise<UCGGraphMetrics | null>;
  getImportGraph(relPath: string, direction?: 'imports' | 'importedBy' | 'both'): Promise<ImportGraphResult>;
  getTestsForFile(relPath: string): Promise<TestCoverageEntry[]>;
  getStatus(): { indexed: boolean; files: number; chunks: number; symbols: number; lastIndexedAt?: number };

  // org-extension queries
  getServiceTopology(): Promise<ServiceTopologySummary | null>;
  resolveApiContract(httpMethod: string, pathPattern: string): Promise<ApiContractResult | null>;
  getMavenImpact(artifactId: string): Promise<string[]>;
  getNpmConsumers(packageName: string): Promise<string[]>;
  getConfigDrift(serviceName: string): Promise<ConfigDriftEntry[]>;
  getTerraformResources(resourceType?: string): Promise<TerraformResource[]>;
  getPipelineJobs(stage?: string): Promise<PipelineJob[]>;

  getGitDiffStat(): Promise<string | null>;
  getGitRecentlyChanged(limit?: number): Promise<GitFileStats[]>;

  flush(): Promise<void>;                               // write DB image now
  close(): Promise<void>;
}

interface ChunkSearchResult { filePath: string; startLine: number; endLine: number; content: string; score: number; language?: string }
type SymbolSearchResult = ExtractedSymbol;
interface ContextualProfile { activeFile?: string; relatedFiles: string[]; tests: string[]; profileText: string }
```

Scores: `searchBM25` returns raw FTS5 `bm25()` values (negative; lower is better, results are
ordered best-first). `searchHybrid` with embeddings returns positive RRF scores
(`Σ 1/(60 + rank)`); without embeddings it returns the BM25 values.

### Lower-level building blocks

Everything the façade is built from is exported too:

- `RepoIntelligenceDb`, `hashWorkspaceRoot`, `splitIdentifiers`, `buildFtsQuery`
- `scanWorkspace`, `detectCommands`, `compileExcludeGlobs`, `detectLanguageForPath`
- `chunkFile`, `extractSymbolsFromFile`, `buildChunksForWorkspace`, `SKIP_LANGUAGES`
- `extractImports`, `classifyNode`, `isEntryPoint`, `computeMetrics`, `detectCycles`
- `createEmbedder`, `cosineSimilarity`, `serializeEmbedding`, `deserializeEmbedding`
- `formatRepoIntelligenceIndexingReport`, `formatProfileText`
- `indexAllSpringServices`, `indexMavenDependencies`, `indexKubernetesManifests`,
  `indexGatewayRoutes`, `indexNpmDependencies`, `indexConfigEnvironments`,
  `indexTerraformResources`, `indexGitlabPipelines`
- `WorkspaceFileWatcher`, git helpers, and all plain types from `repoIntelligenceTypes`.

## Bundling note

`@sqlite.org/sqlite-wasm` locates `sqlite3.wasm` relative to its own module URL. When
bundling (e.g. a VS Code extension with esbuild), either mark the package `external` and ship
`node_modules/@sqlite.org/sqlite-wasm` alongside, or copy `dist/node.mjs` + `dist/sqlite3.wasm`
next to the bundle.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # emits dist/
```
