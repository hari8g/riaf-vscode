# RIAF 2.0 — Implementation plan

Maps every component of *RIAF 2.0 — Repository Intelligence, Intent Compilation and Tool-Call Governance* (Nov 2, 2026) onto the riaf-vscode monorepo at `101e627`, states what already exists, what this change adds, and how each part is verified. Produced 2026-11-04.

Legend: ✅ exists before this change · 🆕 added by this change · ◐ partial (named gap) · ⏭ deferred (with reason).

---

## 0. Starting point (what the Index plane already has)

| Framework item | Where it lives today | Status |
| --- | --- | --- |
| SQLite store (sqlite-wasm, FTS5, single file `.riaf/index.sqlite`) | `riaf-core/src/repoIntelligenceDb.ts` | ✅ |
| Content-hash incremental re-index, file watcher | `riafIndex.ts` (`chunk_file_hashes`), `fileWatcher.ts` | ✅ |
| Lexical layer: FTS5 BM25, camelCase/snake split | `repoIntelligenceDb.ts` `chunks_fts`, `splitIdentifiers` | ✅ |
| Structural layer: tree-sitter outline + regex fallback, symbol edges (`calls`, `instantiates`, `extends`, `implements`, `imports`) | `treeSitterChunker.ts`, `symbolGraph.ts` | ✅ |
| Import graph (UCG), entry points, cycles, hot files | `universalImportExtractor.ts`, `universalGraphAnalyzer.ts` | ✅ |
| Semantic layer: embeddings (OpenAI-compatible endpoint), HNSW, RRF fusion (K=60) | `embeddingService.ts`, `hnsw.ts`, `searchChunksHybrid` | ✅ |
| Build/dependency layer: Maven, npm, K8s, gateway, Terraform, GitLab CI, Spring | org-extension indexers | ✅ |
| Commands detection (build/test/lint/typecheck) | `commandDetector.ts` | ✅ |
| Git history | `gitContextIndexer.ts` — status/log/diff-stat only | ◐ no mining |
| Compile plane (intent → Context Pack) | — | ❌ |
| Govern plane | `token-opt` has read-dedup, compaction, budget for the in-extension loop only | ◐ not host-agnostic, no pack, no cache |
| Serve plane | MCP server (`extension/src/mcp.ts`), LM tools, `@riaf` participant, Claude hooks (deny-list + stop gate) | ◐ no pack/lookup/expand/history |

The plan therefore **deepens Pillar 1 with history**, and **builds Pillars 2 and 3 plus their serve surfaces**, reusing the existing index rather than rewriting it.

---

## 1. Package layout

```
packages/
  riaf-core/src/
    v2/store.ts            🆕 raw-SQL access + RIAF 2.0 tables (commit*, co_change, ownership, decision, pack*, tool_cache, session_metric)
    v2/gitHistory.ts       🆕 Pillar 1b miner (incremental, logical change units, noise filter, co-change, ownership, churn, intent, decisions)
    v2/intent.ts           🆕 Pillar 2 step 1: intent parser
    v2/tokens.ts           🆕 token estimator shared by compiler + governor
    v2/packTypes.ts        🆕 Context Pack schema v1 (types + JSON-schema-like validator)
    v2/compiler.ts         🆕 Pillar 2 steps 2–5: seeds, RRF, graph expansion, ranking, knapsack, assembly
    v2/render.ts           🆕 Pillar 2 step 6: claude | copilot | markdown | json | openai | gemini | agents-md
    v2/architecture.ts     🆕 architecture facts + conventions (packages/workspaces, monorepo tool, lint/format, test layout)
    v2/summaries.ts        🆕 hierarchical summary tree (file → dir/package → repo), hash-keyed, extractive by default, LLM optional
    v2/eval.ts             🆕 `riaf eval` benchmark from repo history
    v2/riaf2.ts            🆕 façade: Riaf2 = RiafIndex + history + compiler + store (the API in the framework's "Integration surfaces")
  token-opt/src/
    governor/types.ts      🆕 ToolCall, Decision, GovernorBackend port, policy types
    governor/policy.ts     🆕 YAML budget policies (minimal YAML subset parser, defaults, per-phase ceilings)
    governor/cache.ts      🆕 content-addressed tool cache (key = tool + normalised args + blob hashes)
    governor/governor.ts   🆕 redundancy guard, loop detection, prefetcher, budgets, write-aware invalidation, telemetry
    governor/hookScript.ts 🆕 source of the Claude Code hook client (single source of truth, written by setup/CLI)
  riaf-engine/src/
    cli.ts                 ✏️ adds `riaf index | search | pack | history | eval | init --host claude`
  extension/src/
    mcp.ts                 ✏️ riaf_compile / riaf_lookup / riaf_expand / riaf_history / riaf_search, resources, prompt, governor endpoint
    governorServer.ts      🆕 local socket endpoint (unix socket / named pipe) the hooks talk to
    claudeHooks.ts         ✏️ PreToolUse / PostToolUse / SessionStart / UserPromptSubmit governance hooks
    lmTools.ts / package.json ✏️ Copilot LM tools `riaf_context`, `riaf_lookup`; commands Compile pack / Export pack
```

Dependency rule (unchanged spirit): `token-opt` stays host- and index-agnostic — the governor talks to the index through the `GovernorBackend` port; `riaf-core` never imports `token-opt`; hosts (MCP server, extension, CLI) wire them together.

---

## 2. Pillar 1 — Indexing deepening

| Item | Implementation | Verification |
| --- | --- | --- |
| RIAF 2.0 tables in the same DB | `v2/store.ts` creates `commit`, `commit_file`, `commit_intent` (columns on `git_commit`), `co_change`, `ownership`, `decision`, `pack`, `pack_item`, `tool_cache`, `session_metric`, `summary`, `kv` with `CREATE TABLE IF NOT EXISTS` through a new public raw-SQL accessor on `RepoIntelligenceDb`; persisted by the existing debounced export | store unit test round-trips rows through a file DB |
| Architecture facts & conventions | `v2/architecture.ts`: workspaces (npm/pnpm/yarn, Lerna, Nx, Turbo, Bazel, Gradle settings, Maven modules, Cargo, go.mod), entry points from UCG, frameworks/commands from the profile, lint/formatter configs (ESLint, Prettier, Ruff, Black, Checkstyle, clang-format, EditorConfig), test layout (co-located vs `test/` dirs), generated-path patterns from `.gitattributes linguist-generated` | test on fixture repo |
| Hierarchical summary tree | `v2/summaries.ts`: bottom-up file → directory → repo; extractive (doc comments + exported signatures) by default, `summarize` LLM hook optional; keyed by blob/tree hash so only changed nodes regenerate | test: second build regenerates 0 nodes; edit regenerates the file + its ancestors only |
| Generated / vendored detection | `.gitattributes` `linguist-generated`/`linguist-vendored` + existing heuristics feed `is_generated` facts used by the compiler to exclude bodies | covered in architecture test |
| Merkle directory hashes | tree hashes computed in `summaries.ts` from child hashes (reused to skip unchanged subtrees) | as above |
| SCIP/LSIF import, more tree-sitter grammars | ⏭ Phase 3: needs per-language indexers shipped in the .vsix; existing grammars already cover TS/JS/Python/Java/C/C++/C#/Go |

## 3. Pillar 1b — Git-history intelligence (`v2/gitHistory.ts`)

Mining uses one `git log --numstat -z`-style pass (`--format` with record separators), incrementally from `kv['history.last_sha']`; a rewritten history (last sha no longer an ancestor) triggers a full re-mine.

| Signal | Algorithm | Stored as |
| --- | --- | --- |
| Logical change units | group commits by (a) shared ticket IDs, (b) same author within 30 min whose file sets overlap; merge commits excluded | `git_commit.unit_id` |
| Noise filter | merges, > 50 files (outlier), message patterns (`format`, `prettier`, `lint --fix`, `bump`, `deps`, `renovate`, `dependabot`, `vendor`), lockfile/vendored-only diffs | `git_commit.is_noise` |
| Co-change | per unit, every pair of touched files; weight `Σ 0.5^(age/180d)`; normalised `w / sqrt(churn_a·churn_b)` (hub suppression); pairs with support < 2 pruned; units > 30 files skipped for pairs | `co_change(a,b,weight,support,confidence)`; `confidence = support / commits(a)` used as “coupling” |
| Ownership | per file: commits in last 12 months, lines added (numstat), last ts per author hash; bus factor per directory = smallest author set covering ≥ 50 % of lines | `ownership` |
| Churn / hot spots | commits, lines changed, fix ratio over 90-day and 365-day windows; hot-spot score = `log(1+commits_365)·(1+fix_ratio)` | computed view in `history.hotspots()` |
| Commit intent | rule classifier (conventional-commit prefixes, keyword lexicon) → `feature|fix|refactor|test|docs|chore|perf|security`; ticket IDs (`ABC-123`, `#123`); one-line “what and why” (subject + first `because/so that/to` clause of the body); optional LLM classifier hook | `git_commit.intent_class, ticket_ids, why` |
| Decision mining | sentences in commit bodies and `ADR`/`docs/adr/*`/`CHANGELOG*` matching decision patterns (“we moved to X because Y”, “decided”, “instead of”, “deprecate”, “do not use”) | `decision` |
| Symbol/file history card | `history.card(path)` → created-in commit + intent, last N intents, owners (roles), hot-spot flag; `--follow` rename tracking on demand | computed |
| Temporal queries | `history.changedSince(ref, pathPrefix)` over stored commits (resolves ref with `git rev-parse` once) | computed |
| Privacy | author identity stored as `sha256(email)[:12]`; names resolved only in-session (`resolveAuthors: true`); packs carry roles (`primary owner`, `recent contributor`) unless opted in | flag on `Riaf2` |

Verification: a test builds a temp git repo with scripted authors/dates (formatter commit, dependency bump, ticket-linked pair, fix commits) and asserts co-change pairs, noise flags, intent classes, decisions, ownership and incremental mining (second pass reads only new commits).

## 4. Pillar 2 — Intent-to-context compilation (`v2/intent.ts`, `v2/compiler.ts`, `v2/render.ts`)

1. **Intent parsing** — type by weighted lexicon (bugfix, feature, refactor, explain, test, migrate, review); entities: paths (validated against the index), symbols (CamelCase/snake/dotted, validated with `searchSymbols`), quoted error strings, stack-trace frames, ticket IDs; constraints (“don't/do not/without/keep/must not/only”), acceptance (“should/must/so that/expect”); `open_questions` when no entity resolves and the type is ambiguous.
2. **Seed retrieval** — lexical (BM25), semantic (hybrid when embeddings on), structural (symbol lookup + explicit paths), intent tier (commits whose message/why matches → their files); fused with RRF (K=60), per-retriever ranks kept in `provenance`.
3. **Graph expansion** — 1–2 hops over imports/importedBy, symbol edges (calls/extends/implements), tests (`getTestsForFile`), co-change (confidence ≥ 0.3), manifests that build the seed’s package; neighbour score = parent score × edge weight × hop decay (0.6/hop).
4. **Ranking and budgeting** — score = 0.45·fusion + 0.15·centrality (importedBy) + 0.25·history (co-change, recency, hot-spot) + 0.15·task prior (tests for bugfix/test, manifests for migrate, docs for explain); knapsack by score/token density with forms per file: *body* → *signatures + summary* → *summary line*; rule “signature+summary when body > 150 tokens and within 5 % score” is the default degrade; overlapping ranges deduplicated.
5. **Assembly** — conventions, architecture, history (related commits, owners as roles, hot spots, newest decision), `plan_skeleton` and `verification` from task type + detected test/lint commands, `known_facts` (files read in full, ranges read, symbols resolved, dirs listed), provenance; stored in `pack`/`pack_item`; `compile()` with the same intent + HEAD returns a diff against the previous pack.
6. **Rendering** — stable sections first (conventions, architecture) for prompt-cache hits; targets `claude` (Markdown, fenced items with `path:range` headers), `copilot` (summaries preferred, trimmed to 8 k), `markdown` (human briefing with *why*), `json`, `openai` (`messages[]`), `gemini` (`systemInstruction` + `contents`), `agents-md`.

Verification: compiler test on the fixture repo (a bugfix intent mentioning `OrderService` must pull its test and its imports, stay under budget, populate `known_facts`); renderer snapshot-style assertions; latency assertion (< 2 s warm).

## 5. Pillar 3 — Tool-call governance (`token-opt/src/governor/*`)

`ToolGovernor.guard(call) → { decision: 'serve' | 'allow' | 'block', content?, note, prefetch? }` and `record(call, output)`, `onWrite(path)`, `setPack(knownFacts)`, `metrics()`.

| Component | Behaviour |
| --- | --- |
| Redundancy guard | `Read`: served when the same file (same blob hash) was already returned in this session — full or covering range — or when `known_facts` lists it **and** the host allows first-read serving (`serveFirstReads`; off for Claude Code, whose Edit tool requires a real prior Read). `Grep`/`Glob`/`LS`/`git log|blame` (Bash): served from cache when key + blob hashes match. Identical call ≥ 3× → served with a loop warning. |
| Tool cache | key = sha256(tool, normalised args); entry stores blob hashes of involved files; validated against current hashes before serving (never stale); persisted through a store port (MCP host uses the `tool_cache` table) so new sessions start warm. |
| Pre-fetcher | on an allowed Read: co-change neighbours with coupling > 0.6, tests, direct imports → outlines (not bodies) returned as `prefetch` and delivered via PostToolUse `additionalContext`; tracked for prefetch precision. |
| Budget policies | `.riaf/policy.yaml` (versioned with the repo): per-phase ceilings (`explore`, `plan`, `implement`, `verify`) on tool calls / tokens / wall time; soft → reflection prompt appended; hard → exploratory calls blocked with the reflection prompt; phase advances on first Edit/Write (implement) and on test runs (verify), or explicitly. |
| Write-aware invalidation | `onWrite(path)` drops cache entries containing that path, forgets the session read, triggers incremental re-index through the backend. |
| Telemetry | proposed / served / executed / blocked / repeats / loops, tokens served (saved) / executed, cache hit rate, prefetch issued / used; persisted to `session_metric`. |

Host wiring for Claude Code (`claudeHooks.ts` + hook script): **PreToolUse** (`Read|Grep|Glob|LS|Bash`) → `serve` = `permissionDecision: "deny"` with the indexed content as the reason (Claude receives it instead of a tool run), `block` = deny with the reflection prompt, `allow` = no output; **PostToolUse** (`Read|Grep|Glob|LS|Bash|Edit|Write|MultiEdit`) records output, invalidates on writes, returns `additionalContext` with prefetched outlines or soft-budget reflection; **SessionStart** / **UserPromptSubmit** inject the compiled pack briefing. The hook is fail-open (any error → allow) so governance never breaks the agent; `RIAF_NO_GUARD=1` is the escape hatch.

The hook reaches the governor through a local endpoint opened by the MCP server (`.riaf/governor.json` → unix socket / Windows named pipe), so per-call hooks stay ~ms and share the session’s cache, pack and index.

Verification: governor unit tests (serve/allow/block, loop, invalidation, budget soft/hard, cache persistence, prefetch precision); an integration test that starts the governor server and runs the real hook script with Claude Code-shaped payloads.

## 6. Serve plane

| Surface | Additions |
| --- | --- |
| `riaf-mcp` | tools `riaf_compile`, `riaf_lookup`, `riaf_expand`, `riaf_history`, `riaf_search`, `riaf_governor_status`; resources `riaf://pack/current` (`?scope=<pathPrefix>` child packs for sub-agents), `riaf://repo/conventions`, `riaf://repo/architecture`; prompt `riaf-briefing`; writes `.claude/riaf/pack.md` on compile |
| Claude Code setup | `.claude/settings.json` gains the governance hooks; `CLAUDE.md` fragment states the retrieval-before-tool protocol |
| CLI (`riaf`) | `riaf index [--ci]`, `riaf search <q>`, `riaf pack --intent "…" --format md|json|openai|gemini|claude|copilot|agents-md --budget 32k`, `riaf history <path>`, `riaf eval [--samples N]`, `riaf init --host claude` |
| VS Code | Copilot LM tools `riaf_context`, `riaf_lookup`; commands `RIAF: Compile pack for selection`, `RIAF: Export pack` |

## 7. Evaluation (`v2/eval.ts`, `riaf eval`)

For N sampled non-noise commits touching 2–15 indexed files: (a) **pack recall** and **pack precision/density** of a pack compiled from the commit message (budget 24 k); (b) **co-change recall@5** with the co-change graph rebuilt from commits strictly older than the sample (held-out); (c) **compile latency p50/p95**. Output: Markdown table + JSON, gated against the framework targets (recall ≥ 80 %, precision ≥ 55 %, co-change recall@5 ≥ 60 %, compile < 2 s p95). Known bias: the index is at HEAD, not at the sampled commit’s parent — reported in the output.

Governance metrics (tool calls avoided, tokens saved, prefetch precision) come from `session_metric` over real sessions (`riaf_governor_status`, Usage panel).

## 8. Phase mapping and what is deferred

| Phase | Delivered here | Deferred |
| --- | --- | --- |
| 0 | store, architecture facts, summaries tree on top of the existing index | SCIP import; extra tree-sitter grammars (Kotlin) |
| 1 | history mining, compiler, renderers, MCP tools/resources, Claude hooks, CLAUDE.md fragment, `riaf eval` | local ONNX embedding model (open decision: model choice) — semantic retrieval keeps using the configured endpoint, BM25 + graph otherwise |
| 2 | token-opt governor (guard, cache, prefetch, budgets, invalidation, telemetry), Copilot LM tools + commands | briefing side-panel tab (uses existing panel); pilot repo (open decision) |
| 3 | child packs via `?scope=`, stage checkpoint (`riaf_compile` with `stage` appends verify output to the previous pack) | CI shared index artifact & delta download; multi-repo workspaces |

Open decisions from the framework stay open and are surfaced as config: `riaf.history.resolveAuthors` (default false → hashed), embeddings endpoint (default off), preview MCP release.

## 9. Test strategy

- Every new module has a vitest suite; history tests build real temp git repos; compiler/eval tests run on the existing `sample-repo` fixture turned into a git repo.
- Full monorepo `npm test` must stay green (baseline at `101e627`: 443 tests).

---

## 10. Status after implementation (2026-11-04)

Everything marked 🆕 above is implemented and tested; ⏭ items remain deferred.

| Area | Files | Tests |
| --- | --- | --- |
| Store, history, intent, compiler, renderers, architecture, summaries, eval, façade | `riaf-core/src/v2/*` | `riaf-core/test/v2/gitHistory.test.ts` (14), `compiler.test.ts` (14) |
| Governor, policy, cache, Claude hook bridge, endpoint, hook script | `token-opt/src/governor/*` | `token-opt/test/governor.test.ts` (14, incl. the real hook script against a live endpoint) |
| MCP host wiring, governance setup | `extension/src/riaf2Host.ts`, `mcp.ts`, `claudeHooks.ts`, `packCommands.ts` | `extension/test/riaf2Host.test.ts` (5) |
| CLI | `riaf-engine/src/riaf2Cli.ts`, `claudeInit.ts` | `riaf-engine/test/riaf2Cli.test.ts` (3) |

Monorepo: 493 tests pass (baseline 443); `npm run typecheck` clean; the MCP bundle was smoke-tested over stdio (all six `riaf_*` tools, resources incl. `?scope=`, the prompt, governor endpoint file).

**First eval on this repository** (`riaf eval --samples 8`, 24 commits, small history — indicative only): pack recall 77 % (target 80 %), pack precision 57 % (55 %), co-change recall@5 34 % (60 %), compile p95 132 ms (< 2 s). Co-change needs a longer history than this repo has; recall misses are mostly build/infra commits whose message names no code entity.

**Implementation notes that differ from the framework text**

- *Serving first reads in Claude Code*: Claude Code's Edit tool requires a real prior Read, so the guard serves **repeat** reads of unchanged files by default and serves pack-covered first reads only when `guard.serve_first_reads: true` (for hosts without that rule). Served content is delivered as a PreToolUse `deny` whose reason carries the content.
- *RRF constant*: K = 10 inside the compiler (lists are ≤ 40 long and top ranks must stay distinct); retrievers are ranked per file, not per chunk.
- *Ownership* uses lines changed per author from `--numstat` (non-noise commits) rather than `git blame`, so it is incremental and cheap; `blame` remains a possible refinement.
- *Commit intent* uses a rule classifier (conventional-commit prefixes + lexicon); the LLM classifier is not wired (open decision on remote endpoints).
