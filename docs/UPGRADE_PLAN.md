# RIAF upgrade plan — Trove parity and beyond

Source of truth for the gap between **Trove v1** (`hari8g/trove_v1`, `src/vs/workbench/contrib/trove`: common 10.6k LOC, browser 22.5k, electron-main 9k, 48 React files) and **riaf-vscode** at `56f85e9`. Produced 2026-10-26 from a file-level sweep of both repos; file:line pointers refer to those trees.

Legend: ✅ implemented in riaf-vscode · ◐ partial / lifted-but-not-wired · ❌ missing · ⛔ not portable to an extension · ★ priority for the Claude Code upgrade.

---

## 1. Where riaf-vscode is already ahead of Trove

Worth stating first, so the plan doesn't regress these:

- `.gitignore`-aware scanning, tree-sitter chunking, HNSW vector index, tsconfig-paths module resolver, symbol/call graph (`find_references`, `get_neighbors`, dependents preamble) — Trove has none of these (its vector search is a brute-force scan; its chunker is regex-only).
- Command policy with deny list, allowlist, workspace-write sandbox + macOS Seatbelt; project hooks (preTool/postEdit); checkpoints with rewind; diagnostics fed back after each edit; history summarisation; explore sub-agent; ripgrep `grep`/`glob`.
- Edit approval by default and command approval per call (Trove auto-accepts edits and auto-runs terminal commands by default).
- Corporate-proxy story: SSO gateway transport, proxy bridge, Claude Code setup.

## 2. Gap analysis

### 2.1 Agent loop (Trove `chatThreadService.ts` ↔ `extension/src/agentLoop.ts`)

| Feature | Trove | riaf-vscode | Note |
|---|---|---|---|
| Plan generate / reuse / reactivate across turns with session context | ✅ `agentPlan.ts:273-336` | ◐ generate only; `resolveAgentPlanForRun`, `reactivateAbortedPlan`, `buildPlanSessionContext` lifted into token-opt but unused | ★ |
| Plan items ticked by tool matching | ✅ | ✅ | Trove bug: marks leftovers done at run end — don't copy |
| Iteration cap / read-only budget / consecutive-fail cap / stall timeout | ✅ settings-driven, clamped (`agentLoopSettings.ts`) | ◐ iterations+reads are settings; fail cap, nudges, explore steps hard-coded; no stall timeout | ★ |
| Rate-limit cooldown map (per provider:model, retry-after aware) | ✅ `llmRateLimit.ts` | ◐ lifted, unused (`recordProviderRateLimitHit`, `getAgentInputTokenCap`) | ★ |
| Provider TPM input cap (Anthropic 22k agent) | ✅ | ❌ | |
| Aggressive trim from turn 3; on overflow/429 retry | ✅ `chatThreadService.ts:1012` | ◐ only after overflow | |
| USD budget guard (session budget blocks turns) | ✅ `:1050` | ❌ | |
| Edit truncation detection (output tokens near cap, missing content) | ✅ `:1365-1380` | ◐ `stopReason=length` only; vscode.lm never reports it | ★ |
| Stall-during-edit → retry nudge instead of ending run | ✅ `:1281-1294` | ❌ | |
| Sandbox-verification nudge grounded in repo commands | ✅ `agentVerificationHints.ts` | ◐ lifted, unused (auto-verify runs tests instead) | |
| Delivery summary / next steps / preview of running app | ✅ `agentDeliveryService.ts` | ❌ | |
| Message queue while running; edit earlier message & re-run | ✅ `:1871-1926`, `:2053` | ❌ (Copilot chat owns the input; partial via follow-ups) | |
| Abort semantics (partial assistant kept, interrupted-tool marker, checkpoint) | ✅ `:729-769` | ◐ cancellation stops; no marker, no partial save | |
| Thread persistence across reloads; multi-thread; background runs | ✅ | ◐ in-memory LRU of 32 threads; lost on reload | ★ |
| Memory intent ("remember that …") + user memory file in prompt | ✅ `chatMemoryIntent.ts`, `trove-memory.md` | ❌ | |
| Parallel read-only batching (side-call proposes extra reads) | ✅ (off by default) | ◐ lifted, unused | |
| Light agent mode | ✅ | ◐ lifted, unused | |
| Cross-turn file-read history (2 turns / 50 entries) | ✅ `:1494-1523` | ✅ (`seedFileReadsFromHistory`) | |
| Cache-stability check on stable prefix (dev) | ✅ | ❌ | cheap, useful |
| Recently-viewed code snippets (cursor context) | ✅ `contextGatheringService.ts` | ❌ | |
| Repo-profile cap per mode (8000/3200/1600) | ✅ | ◐ fixed | |

### 2.2 Tools (Trove `coreToolHandlers.ts` ↔ `tools/*.ts`)

| Tool / capability | Trove | riaf-vscode |
|---|---|---|
| read_file / ls_dir / search_in_file / create / delete / edit_file / rewrite_file / run_command / run_tests | ✅ | ✅ (edit_file has better fuzzy matching; delete goes to trash) |
| get_dir_tree, search_pathnames_only, search_for_files | ✅ | ◐ `glob` and `grep` cover most; no tree |
| get_symbol (source of one symbol) | ✅ | ❌ (`RiafIndex.getSymbol` exists) |
| get_recently_changed | ✅ | ◐ inside `get_git_context` |
| read_lint_errors (waits for markers to settle) | ✅ | ◐ diagnostics after edit only |
| search_web (Tavily) | ✅ | ❌ |
| Persistent terminals: open / run_persistent / kill, dev-server auto-routing, live output, resolve reasons | ✅ `terminalToolService.ts` | ❌ one-shot `execFile` |
| run_tests output parsers (jest, vitest, mocha, pytest, surefire, go) | ✅ `testRunnerService.ts` | ❌ raw tail |
| FILE_READING_POLICY in prompt (outline → symbol → range → full) | ✅ | ◐ "read once" only |
| "EDIT NOT APPLIED … UNCHANGED (k of n blocks)" result shape + lint-settle caveat | ✅ | ◐ error string differs; no settle caveat |
| Heredoc ban, path-outside-workspace guard | ✅ | ✅ guard; heredoc not banned |
| MCP client (consume other servers; stdio/HTTP/SSE) | ✅ | ❌ (we only *serve* MCP) |
| STaaS tools: topology, contract, maven/npm impact, config drift | ✅ | ✅ (merged into `get_dependency_impact`) |
| verify_security_compliance (7 rules) | ✅ | ❌ |
| get_iac_topology / get_pipeline_blast_radius | planned | ◐ `get_infra_resources` covers data, not blast radius |
| Explore sub-agent | ❌ | ✅ |
| All tools exposed to Copilot as LM tools | n/a | ◐ 3 of 25 (Tools tab over-promises) |

### 2.3 Edit application UX

| Feature | Trove | riaf-vscode |
|---|---|---|
| Streaming diff zones, per-hunk accept/reject, command bar, keybindings | ✅ `editCodeService.ts` | ⛔ needs editor internals; ◐ whole-file diff approval |
| Apply from chat code block (fast apply via search/replace) | ✅ | ❌ (Copilot Chat has its own) |
| Quick Edit Ctrl+K in-editor zone | ✅ | ❌ → map to VS Code inline chat / code action |
| Undo integration | ✅ | ◐ checkpoints + rewind |

### 2.4 Provider / transport (electron-main `sendLLMMessage.impl.ts` ↔ `modelTransport.ts`)

| Feature | Trove | riaf-vscode |
|---|---|---|
| 16 providers, per-provider quirks | ✅ | ◐ vscode.lm + OpenAI-wire gateway |
| Native Anthropic wire (thinking, cache breakpoints, 128k beta) | ✅ | ❌ (cache via routed-Claude path only) |
| Gemini, Ollama/FIM, Vertex, Azure | ✅ | ❌ |
| XML tool fallback for non-native-tool models | ✅ `extractGrammar.ts` | ❌ |
| Reasoning/thinking I/O | ✅ | ❌ |
| Vision input | ✅ | ❌ |
| Stream stall watchdog | ✅ | ❌ |
| Usage from provider | ✅ | ◐ gateway yes; vscode.lm estimated |
| Per-feature model selection (Chat / Ctrl+K / Autocomplete / Apply / SCM) | ✅ | ❌ one transport for plan/summary/explore/main |
| API-key providers with secure storage | ✅ (encrypted blob) | ❌ (SSO only) |

### 2.5 Settings & UI (Trove `Settings.tsx` ↔ `webview/main.tsx`)

| Section | Trove | riaf-vscode | Plan |
|---|---|---|---|
| Models (list, show/hide, add custom, delete, overrides JSON, auto-detect local, refresh) | ✅ | ❌ | Phase D |
| Local providers (ollama/vLLM/LM Studio) | ✅ | ❌ | Phase D (ollama + openAICompatible first) |
| Main providers (keys, endpoints, help links) | ✅ | ◐ gateway only | Phase D |
| Feature Options: Autocomplete (FIM, codebase ctx, next-edit) | ✅ | ❌ | Phase F |
| Feature Options: Apply (sync/fast) | ✅ | ⛔ (Copilot owns apply) | skip |
| Agent & token economy (light, plan, cache, org ext, parallel reads; 4 limits; web search) | ✅ | ◐ | Phase A/D |
| Tools (approval per type, lint errors, auto-accept) | ✅ | ◐ | Phase D |
| Editor (inline suggestions) | ✅ | ❌ | Phase F |
| Commit message generator | ✅ | ❌ | Phase F |
| General: One-Click Switch | ✅ | ⛔ | skip |
| General: Import/Export/Reset settings & chats | ✅ | ❌ | Phase D |
| General: metrics opt-out, AI instructions, disable system message | ✅ | ❌ | Phase D |
| Rules viewer (`.troverules` + globs frontmatter) | ✅ | ◐ editor for `.riafrules`; AGENTS.md/.riaf/rules read but not shown | Phase D |
| Usage: today, 7-day chart, per-provider, cache efficiency, budget bar + set/clear, stale-pricing warning | ✅ | ◐ session/all-time only | Phase D |
| MCP tab (servers from mcp.json, status, toggle, tools, errors) | ✅ | ❌ | Phase B/D |
| Onboarding | ✅ | ❌ | Phase D (walkthrough) |
| Chat sidebar (threads, @-mentions, attachments, tool cards, approvals, plan card, composer, notepads) | ✅ | ⛔/◐ Copilot Chat UI is the host | selective |
| Context Document panel (RIAF analyse run) | ✅ | ❌ | Phase E |
| Context graph (layers, depth, package view) | ✅ | ◐ basic canvas | Phase E |

### 2.6 Intelligence (electron-main `repoIntelligence` ↔ `riaf-core`)

| Feature | Trove | riaf-vscode |
|---|---|---|
| LLM architecture/purpose summaries | ✅ (Chat model) | ◐ hook exists, extension passes a summarizer but profile text never shows summaries |
| STaaS summary hydration in profile | ✅ | ◐ partial |
| Watcher updates UCG/org indexes | ❌ | ✅ |
| Co-change analysis, interaction memory, test_source_map | planned | ❌ |
| User memory file | ✅ | ❌ |
| Kotlin/Go/C#/Java import resolution | planned | ❌ |

### 2.7 Known defects to fix while touching these areas

- Tools tab text promises LM tools that aren't registered (3 of 25).
- `.riafrules` / `AGENTS.md` / `.riaf/rules` not carried into `CLAUDE.md` for Claude Code.
- Gateway transport and embeddings client ignore the proxy bridge (`fetch` without agent).
- `plugin/CLAUDE.md` lists 7 MCP tools; server exposes 17.
- Explore sub-agent ignores the abort signal.
- Dead `before` computation in `agentLoop.ts:205`.

---

## 3. Target architecture for the "extensive" loop

The upgrade is not "more hints": it is a **plan–execute–verify engine** with a persisted ledger, usable from three fronts — `@riaf` in Copilot Chat, Claude Code (via MCP tools + commands + hooks), and a CLI for CI.

```
                 ┌──────────────────────────────────────────────┐
  @riaf (VS Code)│  token-opt: budget · cache · dedup · limits  │
  Claude Code    │  riaf-engine (new package, no vscode deps)    │
  CLI / CI       │   planner → ledger → executor → verifier →   │
                 │   critic → replanner   (events, persisted)   │
                 │  riaf-core: index · graph · org · git        │
                 └──────────────────────────────────────────────┘
```

**Planner** — decomposes a task into a DAG of subtasks: `{id, goal, files (from index), acceptance (test/typecheck/grep assertion), dependsOn, budget}`; uses `search_codebase`, `find_references`, `get_tests_for_file` to ground every item; reuses/reactivates across turns (Trove logic, now in token-opt).
**Ledger** — `.riaf/runs/<id>.json`: plan, per-subtask status, tool log digest, checkpoints, token spend. Survives reloads; drives `RIAF: Rewind`, resume, and the Claude Code `/riaf-status`.
**Executor** — one subtask at a time with its own context budget (profile + neighbourhood of *its* files only), the current loop's guards, parallel read batching, persistent terminal for servers/tests.
**Verifier** — per-subtask acceptance: parsed test results (jest/vitest/pytest/surefire/go), diagnostics, optional grep assertion; failure → bounded fix loop (≤2) → else mark blocked, continue DAG.
**Critic** — after all subtasks: one side-call reviews the full diff against the goal and the rules; can add fix subtasks (max 1 round).
**Replanner** — on blocked subtask or new user message mid-run: regenerate remaining DAG with session context.

For **Claude Code**, the same engine is exposed as MCP tools (`plan_create`, `plan_status`, `plan_next`, `plan_mark`, `verify_subtask`, `run_critic`) plus commands (`/riaf-run`, `/riaf-status`, `/riaf-resume`) and a `Stop` hook that refuses to end while acceptance checks are red — so Claude Code's own loop becomes the executor and RIAF supplies the discipline and the ledger.

---

## 4. Phases

Effort assumes one engineer; tests included. Phases A, C and B are the "major upgrade" for Claude Code; D is settings parity; E/F are intelligence and editor extras.

### Phase A — Loop hardening (wire what's lifted, close Trove gaps) · ~4 days
1. Configurable limits via `getAgentLoopLimits` (fail cap, nudges, explore steps, settle time) + settings + panel.
2. Rate-limit cooldown map + provider TPM cap + aggressive trim from turn 3 + stall watchdog (`getLlmStreamStallTimeoutMs`) with stall-during-edit → retry nudge.
3. Edit truncation detection by output-token proximity (works on vscode.lm via countTokens).
4. Plan continuation: `resolveAgentPlanForRun` (reuse/reactivate/regenerate) with session context; never auto-complete leftovers.
5. Thread persistence (globalStorage, per workspace) so rewind and continuation survive reloads; interrupted-tool marker + partial assistant on cancel.
6. USD session budget guard + stale-pricing warning.
7. Sandbox-verification nudge (repo commands) as an alternative to auto-run; light agent mode; parallel read batching behind settings.
8. Memory: "remember that …" intent + `~/.riaf/memory.md` injected into the stable prompt; **RIAF: Remember This** editor command.
9. Fix the 2.7 defects; expose all read-only tools as LM tools; carry `.riafrules`/AGENTS/.riaf/rules into CLAUDE.md.

### Phase B — Tools & terminal · ~4 days
1. Persistent terminals via `vscode.window.createTerminal` + shell integration (exit codes, stream, server-ready detection, resolve reasons); `open_persistent_terminal`, `run_persistent_command`, `kill_persistent_terminal`; dev-server auto-routing; `terminalHeuristics` wired.
2. `run_tests` parsers (vitest/jest/mocha/pytest/surefire/go) → structured `{passed, failed[], tail}`.
3. New tools: `get_symbol`, `get_dir_tree`, `read_lint_errors` (settle), `search_web` (Tavily or gateway-hosted), `verify_security_compliance` (port 7 rules + make them configurable), `get_pipeline_blast_radius`, `get_iac_topology`.
4. MCP **client**: read `.mcp.json`/user mcp.json, stdio + streamable-HTTP + SSE, tool prefixing, text results; tools appear to `@riaf` and in the MCP settings tab.
5. FILE_READING_POLICY and the Trove result-shape conventions in prompts; heredoc ban; "EDIT NOT APPLIED (k of n)".
6. Gateway + embeddings through the proxy bridge (undici `ProxyAgent`).

### Phase C — Plan–execute–verify engine (`packages/riaf-engine`) · ~7 days ★
1. Types + ledger (JSON under `.riaf/runs`, with migration), event bus.
2. Planner (DAG, grounding, acceptance criteria, budgets), with Trove's reuse/reactivate semantics.
3. Executor (per-subtask context assembly, guards from Phase A, parallel explore for independent reads).
4. Verifier (Phase B parsers + diagnostics + grep assertions), bounded fix loop.
5. Critic + replanner.
6. `@riaf` integration: `/run`, `/status`, `/resume`, live ledger rendering (checklist with per-subtask state, tokens, cost).
7. Claude Code integration: MCP tools `plan_*`, `verify_subtask`, `run_critic`; commands `/riaf-run`, `/riaf-status`, `/riaf-resume`; hooks template (`Stop` gate on red acceptance; `PreToolUse` guard for deny list parity).
8. CLI `riaf run "<task>" --repo .` for CI / batch use (shares the engine; gateway transport only).

### Phase D — Settings parity · ~4 days
1. Provider layer: Anthropic native (thinking, cache, 128k beta), OpenAI, Gemini, Ollama (incl. model list), openAICompatible, liteLLM/Bedrock-via-gateway; keys in SecretStorage; model lists with show/hide, custom add/delete, overrides JSON; auto-detect local providers.
2. Per-purpose model selection: main, plan, summary, explore, critic, commit, autocomplete; reasoning options per model (toggle/budget/effort).
3. Panel sections: Models · Providers · Agent & token economy (incl. new limits) · Tools (approval per type, lint, auto-accept) · General (AI instructions, disable system prompt, import/export/reset, metrics opt-out) · Rules viewer (all sources, globs) · Usage (today, 7-day chart, per-provider, cache efficiency, budget) · MCP (servers, status, toggle, tools).
4. Onboarding walkthrough (`contributes.walkthroughs`) replacing Trove's overlay.
5. Keybindings with safe `when` clauses (Ctrl+Alt+… family).

### Phase E — Intelligence · ~3 days
1. LLM summaries surfaced in profile (via per-purpose model); Context Document run (`/riaf analyse` → `<repo>_context.md`) with the Context Document panel.
2. Co-change analysis (`git_file_stats`), interaction-memory boost in search ranking, `test_source_map`.
3. Context graph: layers, depth, package view, node details.
4. Kotlin/Go/C#/Java import resolution.

### Phase F — Editor extras · ~3 days
1. Commit message generation in the SCM input box (per-purpose model).
2. Quick Edit: inline chat provider / code action "RIAF: Edit selection" with FIM-tag prompt.
3. Inline completions provider (FIM) with codebase context; selection helper as a code-action lightbulb.
4. Notepads → `.riaf/notes/*.md` as `#riafNote` chat references.

### Explicitly not ported (not possible or not sensible in an extension)
One-Click Switch from Cursor/Windsurf; per-hunk streaming diff zones and the command bar (Copilot Chat's edit review covers it); Trove's own chat sidebar, threads list and attachments UI; PostHog telemetry; auto-update service; the ONDC/Beckn prompt injection (becomes a `.riaf/rules` file instead).

---

## 5. Sequencing recommendation

A → C → B → D → E → F. A is prerequisite plumbing for C; C is the stated goal and the Claude Code differentiator; B's terminal and parsers are what make C's verifier real, so B.1–B.2 can be pulled into C's week; D is independent and can run in parallel if a second person is available.

Total ≈ 25 engineering days; the first demonstrable Claude Code upgrade (A + C.1–C.7) lands at ≈ 11 days.
