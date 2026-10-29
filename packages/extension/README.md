# RIAF — Repository Intelligence & Agent Framework

**Your repository, understood once; every AI assistant you use, smarter for it.**

RIAF indexes the workspace — semantic chunks, symbols, an import/call graph, tests-per-file, and an "org index" of Spring services, Maven/npm dependencies, Kubernetes, Terraform and CI — and puts that knowledge in front of whichever assistant your team already runs:

| If you use… | RIAF gives you |
|---|---|
| **GitHub Copilot Chat** | 27 `#riaf…` tools Copilot can call (search, symbols, references, topology, git, lint, web…), plus the **`@riaf` agent** with a plan → execute → verify ledger |
| **Claude Code** | the same index as an MCP server (13 tools incl. the run ledger), `/riaf-run` `/riaf-status` `/riaf-resume` `/riaf-plan` `/riaf-verify` `/riaf-context` commands, and a stop-gate hook |
| **The editor itself** | `Ctrl+Alt+K` edit-selection, inline completions, commit-message generation, notepads, "Remember this" |
| **A corporate network** | SSO to an internal LLM gateway, native Anthropic / OpenAI / Gemini / Ollama providers, a local **proxy bridge** for authenticated proxies — no API key ever written to a file |

Everything runs locally and offline by default. Nothing is downloaded at install time. Works behind authenticating corporate proxies on Windows, macOS and Linux.

---

## Contents

1. [Requirements](#1-requirements)
2. [Install and first run](#2-install-and-first-run)
3. [Keyboard shortcuts](#3-keyboard-shortcuts)
4. [Commands](#4-commands-command-palette)
5. [Copilot Chat: `#riaf` tools](#5-copilot-chat-riaf-tools)
6. [The `@riaf` agent and its slash commands](#6-the-riaf-agent)
7. [Runs, ledger and verification (`/run`)](#7-runs-ledger-and-verification)
8. [Claude Code integration](#8-claude-code-integration)
9. [Editor features](#9-editor-features)
10. [Settings panel](#10-settings-panel)
11. [Models and providers](#11-models-and-providers)
12. [Rules, memory, notes and hooks](#12-rules-memory-notes-and-hooks)
13. [Safety: approvals, sandbox, checkpoints](#13-safety)
14. [Token discipline](#14-token-discipline)
15. [All settings](#15-all-settings)
16. [Corporate proxy and SSO](#16-corporate-proxy-and-sso)
17. [Troubleshooting](#17-troubleshooting)
18. [Files RIAF creates](#18-files-riaf-creates)

---

## 1. Requirements

- **VS Code 1.95+**.
- A model: GitHub Copilot Chat signed in (RIAF borrows its models — zero config), **or** an internal OpenAI-compatible gateway, **or** a native provider key (Anthropic, OpenAI, Gemini) stored via `RIAF: Set Provider Key`, **or** Ollama running locally.
- **Windows:** Git for Windows (Git Bash) for agent commands and hooks; RIAF finds it automatically (`RIAF_SHELL` overrides).
- No Python, no native modules, no admin rights. SQLite runs as WebAssembly inside the extension.

## 2. Install and first run

1. **Install** `riaf-vscode-<version>.vsix`: Extensions view → `···` on the panel title row → **Install from VSIX…** (or `Ctrl+Shift+P` → *Extensions: Install from VSIX…*, or `code --install-extension riaf-vscode-<version>.vsix`). Reload when prompted.
2. **Open a folder.** Indexing starts automatically; the status bar (bottom-left) shows `⟳ RIAF scan…` then **`RIAF 3,180 chunks`**. One to two minutes for a mid-sized repo, incremental afterwards (content-hash based; `.gitignore` respected).
3. The **Get started with RIAF** walkthrough opens (Help → Welcome → Walkthroughs if you closed it): index, ask `@riaf`, set up Claude Code.
4. `Ctrl+Shift+P` → **RIAF: Doctor** — a one-page health report: index, embeddings, models/gateway, proxy, shell, Claude Code network, proxy bridge. Fix anything red here first.
5. `Ctrl+Alt+,` (or the **`⚡ 0 saved`** status item, bottom-right) opens the settings panel.

## 3. Keyboard shortcuts

| Keys | Command | When |
|---|---|---|
| `Ctrl+Alt+K` | **RIAF: Edit Selection** — describe a change, RIAF rewrites the selected lines (fill-in-the-middle with codebase context) | editor has a selection |
| `Ctrl+Alt+M` | **RIAF: Generate Commit Message** into the SCM input box | a source-control provider is active |
| `Ctrl+Alt+,` | **RIAF: Open Settings** | editor focused |

Same keys on macOS (`Ctrl`, not `Cmd`, to avoid clashing with Copilot's shortcuts). Everything else is reachable from the Command Palette; add your own bindings in *Keyboard Shortcuts* by searching `riaf.` — e.g. `riaf.reindex`, `riaf.rewind`, `riaf.analyse`.

Chat-side shortcuts: in Copilot Chat type `@riaf` then `/` to see the slash commands; type `#riaf` to pick a tool reference; `#riafNote` or `#riafNote:<name>` pulls notepads into the prompt.

## 4. Commands (Command Palette)

`Ctrl+Shift+P`, type `RIAF:`

**Index & insight**
| Command | What it does |
|---|---|
| RIAF: Reindex Workspace | Full rebuild of the index for the current folder |
| RIAF: Show Indexing Report | Markdown: languages, frameworks, build/test/lint commands, graph metrics, org-index contents, known limitations |
| RIAF: Show Context Graph | Interactive import graph (pan, zoom; node size = degree; entry points and tests coloured) |
| RIAF: Write Context Document | Writes `<folder>_context.md` — the index report plus a model-written architecture summary and test/source pairs; same as `@riaf /analyse` |
| RIAF: Doctor (index, embeddings, gateway) | Health report; run first when anything misbehaves |
| RIAF: Show Token Usage | Session / all-time tokens, cache hits, tokens saved, estimated cost |

**Agent**
| Command | What it does |
|---|---|
| RIAF: Rewind (restore files / conversation from a checkpoint) | Pick a turn; restore **files**, the **conversation**, or both to the state before it |
| RIAF: Remember This | Save the selected text (or a typed fact) to `~/.riaf/memory.md`; injected into every later prompt. In chat, "remember that …" does the same |
| RIAF: New Notepad | Create `.riaf/notes/<name>.md`; reference with `#riafNote:<name>` |

**Editor**
| Command | What it does |
|---|---|
| RIAF: Edit Selection (`Ctrl+Alt+K`) | Instruction-driven rewrite of the selection, also offered as a lightbulb code action *RIAF: Edit selection* |
| RIAF: Generate Commit Message (`Ctrl+Alt+M`) | Reads status, sampled diffs, branch and recent log; fills the SCM input box |

**Setup & keys**
| Command | What it does |
|---|---|
| RIAF: Open Settings (`Ctrl+Alt+,`) | The settings panel (§10) |
| RIAF: Set Provider Key | Store an Anthropic / OpenAI / Gemini key in the OS credential store |
| RIAF: Set Web Search Key | Store the Tavily key for `search_web` |
| RIAF: Export Settings / Import Settings | JSON export/import of all `riaf.*` settings (keys are never exported) |
| RIAF: Set up Claude Code (MCP + plugin) | Writes `.mcp.json`, `.claude/commands`, `.claude/hooks`, `CLAUDE.md` rules and the proxy config for Claude Code (§8) |
| RIAF: Set Claude Code proxy credentials | Proxy user/password into the OS credential store |
| RIAF: Start / Stop proxy bridge · Show proxy bridge log | Local authenticating proxy for Claude Code and the gateway (§16) |

Status bar: **`RIAF n chunks`** (left; click → indexing report) · **`⚡ n saved`** (right; click → settings). Output panel: **RIAF** and **RIAF proxy bridge** channels.

## 5. Copilot Chat: `#riaf` tools

RIAF registers 27 *language model tools*. In **agent mode** Copilot picks them up itself; in **ask mode** reference them with `#`. The 🔧 tool picker in the chat box lets you enable/disable them per conversation.

| Reference | Tool | Returns |
|---|---|---|
| `#riaf` | search_codebase | Ranked code chunks (path, lines, content) for a natural-language or identifier query — hybrid BM25 + embeddings, identifier-aware (`orderService` ≈ `OrderService` ≈ `order_service`) |
| `#riafContext` | context_profile | For a file: imports, importers, covering tests + workspace profile (languages, frameworks, commands) |
| `#riafSymbols` | search_symbols | Exported functions/classes/types by (partial) name |
| `#riafSymbol` | get_symbol | Source of one indexed symbol |
| `#riafRead` | read_file | A file or line range (line-numbered) |
| `#riafOutline` | get_file_outline | Symbols with line numbers — cheaper than reading the file |
| `#riafSearchInFile` | search_in_file | Regex within one file |
| `#riafGrep` | grep | ripgrep across the workspace (regex, case, include glob, context) |
| `#riafGlob` | glob | Files matching a glob; respects `.gitignore` |
| `#riafLs` · `#riafTree` | ls_dir · get_dir_tree | Directory listing / tree to a depth |
| `#riafImports` | get_import_graph | Files imported by / importing a file |
| `#riafRefs` | find_references | Callers, subclasses, importers of a symbol (language server first, static graph fallback) |
| `#riafNeighbors` | get_neighbors | One-hop callers/callees/imports of a file or symbol |
| `#riafTests` | get_tests_for_file | Test files covering a source file |
| `#riafLint` | read_lint_errors | Language-server diagnostics for a file |
| `#riafGit` | get_git_context | Branch, uncommitted changes, recent commits, hot files |
| `#riafTopology` | get_service_topology | Spring services, REST endpoints, Feign clients, gateway routes |
| `#riafContract` | resolve_api_contract | HTTP method + path → backend handler, controller, DTOs |
| `#riafImpact` | get_dependency_impact | Who depends on a Maven artifactId or npm package |
| `#riafConfig` | get_config_drift | Config keys that differ between environments |
| `#riafInfra` · `#riafIac` · `#riafBlast` | get_infra_resources · get_iac_topology · get_pipeline_blast_radius | Terraform / k8s / CI jobs; Terraform grouped by type; CI jobs depending on a job |
| `#riafSecurity` | verify_security_compliance | Secrets and unsafe-API scan (7 built-in rules + `riaf.security.extraRules`) |
| `#riafWeb` | search_web | Tavily or `<gateway>/search` (needs `riaf.webSearch.enabled`) |
| `#riafMcp` | list_mcp_tools | Servers and tools declared in `.mcp.json` / user `mcp.json` |

Examples:
```
#riaf where is the retry logic for payment capture?
#riafRefs TariffSlab — what breaks if I rename it?
#riafContract POST /api/orders
#riafImpact spring-boot-starter-web
Using #riafGit and #riafTests, which tests should I run for my current changes?
```

## 6. The `@riaf` agent

Type `@riaf` in Copilot Chat. It is a bounded **plan → gather → edit → verify** loop with token discipline; every edit is a diff you accept, every command a dialog you approve (both configurable).

| Slash command | Behaviour |
|---|---|
| `@riaf <task>` | Full loop: short plan, RIAF-grounded context, edits, diagnostics, tests, summary |
| `@riaf /plan <task>` | Plan only, grounded in real files; no edits |
| `@riaf /explain <question>` | Explanation citing `path:line`; read-only tools |
| `@riaf /verify` | Run detected test/typecheck/lint commands and report; proposes fixes |
| `@riaf /run <task>` | **Plan into a ledger, then execute and verify each subtask** (§7) |
| `@riaf /status` | Show the latest run ledger |
| `@riaf /resume` | Continue the latest unfinished run |
| `@riaf /analyse` | Write `<folder>_context.md` from the index |
| `@riaf /reindex` | Rebuild the index (after a branch switch) |

What you see while it runs: a ticked-off plan, progress lines per tool (`search_codebase charger poller` ✅), a **diff tab + Accept/Reject** for each edit, a **command dialog** before each shell command, language-server **diagnostics fed back** after edits, a **verification** block, and a footer (`n iterations · 12.4k in / 1.1k out · 9.8k tokens saved by RIAF`). Follow-ups: **Verify** after edits, **Continue** after an iteration cap. Attach context with `#file:`, `#selection`, `#riafNote`, or drag files in; the active editor file always seeds the context profile.

The agent's tool set (38): the 27 above plus `edit_file` (search/replace blocks, several per call, whitespace-tolerant), `rewrite_file`, `create_file_or_folder`, `delete_file_or_folder` (to trash), `run_command`, `run_tests` (parsed: vitest/jest/mocha/pytest/surefire/go), `open_persistent_terminal` / `run_persistent_command` / `kill_persistent_terminal` (long-running processes; dev servers auto-routed), `dev` (start a dev server and detect "ready"), `mcp_call` (any external MCP tool), and `explore` — a read-only sub-agent that researches and returns a short report so the main thread stays small. `/plan` and `/explain` get the read-only subset; `/verify` adds the command tools.

## 7. Runs, ledger and verification

`/run` turns a task into a **DAG of subtasks** — each with goal, grounded files, an acceptance check (tests, typecheck, or a grep assertion) and a budget — and persists it as a **ledger** in `.riaf/runs/<id>.json`. The executor works one subtask at a time with its own context budget, runs the acceptance check, retries a fix once, marks `done`/`blocked`, and continues the DAG. After the last subtask a **critic** pass reviews the full diff against the goal and the project rules and may add fix subtasks (one round). `/status` renders the ledger (status per subtask, tokens, cost); `/resume` picks up an unfinished run after a reload. The same engine is exposed to Claude Code (§8) and as a CLI (`riaf run "<task>"` from `@bosch-mps/riaf-engine`) for CI.

## 8. Claude Code integration

Claude Code keeps its own agent loop; RIAF feeds it the index, the ledger discipline, and safety gates. **Once per repository:** `RIAF: Set up Claude Code (MCP + plugin)`. It writes, inside the repo:

- `.mcp.json` — a `riaf` stdio MCP server sharing the extension's index, started through `.riaf/riaf-mcp.mjs`, a tiny launcher that finds the newest installed RIAF at run time — so upgrading the extension never breaks Claude Code (if you set up with a version before 0.2.0, run setup once more);
- `.claude/commands/` — `riaf-run`, `riaf-status`, `riaf-resume`, `riaf-plan`, `riaf-verify`, `riaf-context`;
- `.claude/hooks/gate.mjs` — a **Stop** hook that refuses to end while the latest run isn't `done`, and a **PreToolUse** guard for heredocs and the built-in deny list;
- `CLAUDE.md` — a `<!-- riaf:rules -->` block with the token-discipline rules (search first, read once, combined edits, verify once);
- `~/.claude/settings.json` — the corporate proxy / CA / bridge configuration so `claude` itself can reach Anthropic (§16).

Restart `claude` in that folder (trust the project MCP server), then `/mcp` shows **riaf** with 13 tools:

| MCP tool | Purpose |
|---|---|
| `search_codebase`, `search_symbols`, `get_context_profile`, `get_file_outline`, `get_import_graph`, `get_indexing_report`, `reindex` | retrieval and index maintenance |
| `plan_create`, `plan_status`, `plan_next`, `plan_mark`, `verify_subtask`, `run_critic` | the run ledger — Claude Code becomes the executor, RIAF keeps the plan, acceptance checks and critic |

Typical session: `/riaf-run add exponential backoff to the charger status poller` → Claude creates the ledger, takes `plan_next`, edits with its own tools, calls `verify_subtask`, marks it, repeats, runs the critic; `/riaf-status` any time; `/riaf-resume` after a restart. Commit `.mcp.json`, `.claude/` and `CLAUDE.md` so the team gets it.

## 9. Editor features

- **Edit Selection** (`Ctrl+Alt+K`, or the lightbulb *RIAF: Edit selection*): type what should change; RIAF rewrites the selection using fill-in-the-middle with codebase context, shown as a diff to accept.
- **Inline completions**: ghost-text suggestions from the `riaf.models.autocomplete` model (off until a model is set); uses the active-file neighbourhood and recent edits.
- **Commit message** (`Ctrl+Alt+M`, or the SCM input box): generated from status, sampled diffs, branch and log with the `riaf.models.commit` model.
- **Notepads**: `RIAF: New Notepad` → `.riaf/notes/<name>.md`; `#riafNote` (all) or `#riafNote:<name>` in chat.
- **Remember This**: editor context → `~/.riaf/memory.md`; later prompts include it.
- **Context Document**: `RIAF: Write Context Document` / `@riaf /analyse` → `<folder>_context.md` you can commit and `@`-mention.

## 10. Settings panel

`Ctrl+Alt+,` · tabs: **Gateway · Providers · Repository Intelligence · Agent · Tools · MCP · Rules · Usage · Claude Code · All**

- **Gateway** — URL, model, SSO provider and scopes, headers, prompt caching, streaming, **Test connection** (transport + latency), list of Copilot models visible to RIAF.
- **Providers** — native Anthropic / OpenAI / Gemini / Ollama / OpenAI-compatible: active provider, model lists with show/hide, custom models, per-model overrides (context window, output reserve, tool format), reasoning on/off + budget + effort, keys via the OS credential store. Per-purpose models: main, plan, summary, explore, critic, commit, autocomplete.
- **Repository Intelligence** — status cards (files, chunks, symbols, last indexed), incremental/full reindex, report and graph buttons, watch, gitignore, tree-sitter, exclude patterns, embeddings toggle, DB path.
- **Agent** — plan, auto-verify, iteration/read/fail caps, stall timeout, context ratio, history summarisation, explore sub-agent and its steps, light agent, parallel read batching, session USD budget, sandbox-verification nudge, diagnostics settle time, checkpoints.
- **Tools** — edit approval, terminal approval, MCP approval, auto-approve detected test command, allowlist, deny patterns, sandbox mode, hooks JSON, security extra rules, web search.
- **MCP** — servers from `.mcp.json` and user `mcp.json`: status, tools, enable/disable per server.
- **Rules** — `.riafrules` editor; shows AGENTS.md / `.riaf/rules/*` sources that apply.
- **Usage** — three sources: (1) **RIAF's own model calls** (`@riaf`, `/run`, quick edit, commit, summaries, explore): session and all-time calls, input (with cache hits), output, saved-by-RIAF with %, cost, cache efficiency, 14-day bars, per-provider; (2) **Tools served** to Copilot and Claude Code: calls per tool, tokens returned, and an estimate of tokens they didn't have to spend reading whole files; (3) **Claude Code · this repo** — real calls, input/output, cache read/write, cache efficiency and cost from Claude Code's own transcripts (`~/.claude/projects`, read locally). Copilot does not expose its token usage to extensions, so for Copilot only the tools-served figures exist.
- **Claude Code** — setup status lights, proxy written-vs-detected, credentials, CA, proxy bridge controls + per-CONNECT stats and log.

All controls are ordinary `riaf.*` settings — the native Settings UI and `settings.json` stay in sync; put them in `.vscode/settings.json` to share with the team.

## 11. Models and providers

Resolution order for the agent's model: `riaf.providers.active` (native provider) → gateway (`riaf.gateway.url` + `model`) → the model chosen in the Copilot chat dropdown → any `vscode.lm` model. Per-purpose overrides (`riaf.models.*`) let you run planning and summaries on a cheaper model and the critic on a stronger one. Native Anthropic gets cache breakpoints, thinking, and the 128k-output beta; routed Claude (LiteLLM/Bedrock/OpenRouter) gets `cache_control` via the OpenAI wire; OpenAI gets `prompt_cache_key`. Keys: `RIAF: Set Provider Key` (never in settings files; never exported).

## 12. Rules, memory, notes and hooks

| Source | Scope | Notes |
|---|---|---|
| `.riafrules` | repo | Edit in *Settings → Rules*; wrapped as `<project_rules>` (≈2k tokens cap) |
| `AGENTS.md`, `.riaf/AGENTS.md`, `.riaf/rules/*.md` | repo | Same convention other agents use; nested `AGENTS.md` applies under its directory |
| `riaf.general.aiInstructions` | user | Prepended to every prompt |
| `~/.riaf/memory.md` | user | "remember that …" / *Remember This* |
| `.riaf/notes/*.md` | repo | `#riafNote` references |
| `.riaf/hooks.json` or `riaf.agent.hooks` | repo/user | `preTool` (block with exit 2 or `{"decision":"block"}`) and `postEdit` (formatters) shell hooks; `/bin/sh` or Git Bash |

## 13. Safety

- **Edits**: diff tab with Accept/Reject (`riaf.agent.requireEditApproval`); files snapshotted before the first write per turn (`riaf.agent.checkpoints`) → **RIAF: Rewind**.
- **Commands**: built-in deny list (`rm -rf /`, `sudo`, `curl | sh`, force push, `reset --hard`, `chmod 777`, `mkfs`, `shutdown`, publish/prune/destroy, …) → your `denyCommandPatterns` → workspace-write sandbox (`policy`; `seatbelt` enforces with macOS `sandbox-exec`) → allowlist (`preApprovedCommands`, detected project commands if enabled) → otherwise a dialog showing the exact command. Chains need every segment approved; heredocs are refused.
- **MCP**: each external tool call asks (`riaf.agent.approveMcp`); servers can be disabled.
- **Hooks**: a pre-tool hook that cannot start **blocks** the call (fail closed).
- **Budget**: `riaf.agent.sessionBudgetUsd` stops the agent at a spend limit.

## 14. Token discipline

RIAF search instead of blind reads · duplicate-read suppression across turns · exploration budget and repeat-read/edit hints · stale tool-result compaction · context-window trimming with a protected tail · history summarisation past ~60 % · the `explore` sub-agent returning reports, not transcripts · prompt caching on a stable system prefix · combined edits per file · truncation and stall detection with retry. The **`⚡ n saved`** counter and *Usage* show the effect; with Copilot-provided models the counts are estimates, with a gateway or native provider they are what the provider reported.

## 15. All settings

<details><summary>Index &amp; embeddings</summary>

| Setting | Default | Meaning |
|---|---|---|
| `riaf.index.autoIndexOnStartup` | `true` | Index when a folder opens |
| `riaf.index.watch` | `true` | Incremental updates on save |
| `riaf.index.respectGitignore` | `true` | Skip `.gitignore`d files (root and nested) |
| `riaf.index.treeSitter` | `true` | Syntax-tree chunking/symbols; regex fallback |
| `riaf.index.excludeGlobs` | `node_modules/`, `dist/`, … | Extra gitignore-style patterns |
| `riaf.embeddings.enabled` | `false` | Hybrid BM25 + embeddings (needs gateway/provider); off = offline keyword search |
| `riaf.embeddings.model` | `amazon.titan-embed-text-v2:0` | Embedding model id |
</details>

<details><summary>Gateway, providers, models</summary>

| Setting | Default | Meaning |
|---|---|---|
| `riaf.gateway.url` / `.model` | `""` | OpenAI-compatible base URL and chat model; empty = Copilot's models |
| `riaf.gateway.auth` | `microsoft-sso` | `microsoft-sso`, `github-sso`, `header`, `none` |
| `riaf.gateway.ssoScopes` | `openid profile email` | Use your gateway's API scope |
| `riaf.gateway.headers` | `{}` | Extra headers |
| `riaf.gateway.promptCache` | `true` | `cache_control` for Claude-routed models |
| `riaf.gateway.stream` | `true` | SSE streaming |
| `riaf.providers` | `{active:"", …}` | Native provider selection, model lists, hidden/custom models, overrides, reasoning |
| `riaf.models.main` / `.plan` / `.summary` / `.explore` / `.critic` / `.commit` / `.autocomplete` | `""` | Per-purpose model ids |
| `riaf.webSearch.enabled` / `.provider` | `false` / `tavily` | `search_web` via Tavily key or `<gateway>/search` |
</details>

<details><summary>Agent</summary>

| Setting | Default | Meaning |
|---|---|---|
| `riaf.agent.generatePlan` | `true` | Plan first, tick items as tools run |
| `riaf.agent.maxIterations` | `25` | Tool rounds per request |
| `riaf.agent.maxReadOnlyCalls` | `12` | Exploration budget |
| `riaf.agent.maxConsecutiveToolFails` | `3` | Stop after N failures in a row |
| `riaf.agent.llmStreamStallTimeoutMs` | `120000` | Stall watchdog (edits get longer) |
| `riaf.agent.contextWindowRatio` | `0.85` | Window fill before trimming |
| `riaf.agent.summarizeHistory` | `true` | Summarise instead of dropping old turns |
| `riaf.agent.exploreSubagent` / `.exploreMaxSteps` | `true` / `8` | Read-only sub-agent |
| `riaf.agent.enableLightAgent` | `false` | Smaller profile, no plan, tighter budget |
| `riaf.agent.enableParallelReadBatching` | `false` | Side-call adds up to 4 reads per turn |
| `riaf.agent.autoVerify` | `true` | Run detected tests after edits |
| `riaf.agent.sandboxVerificationNudge` | `false` | Tell the agent which command to run instead |
| `riaf.agent.diagnosticsAfterEdit` / `.diagnosticsSettleMs` | `true` / `1200` | Language-server feedback after edits |
| `riaf.agent.checkpoints` | `true` | Snapshots for Rewind |
| `riaf.agent.sessionBudgetUsd` | `0` | Spend guard (0 = off) |
</details>

<details><summary>Tools &amp; safety</summary>

| Setting | Default | Meaning |
|---|---|---|
| `riaf.agent.requireEditApproval` | `true` | Diff to accept per edit |
| `riaf.agent.allowRunCommand` | `true` | Shell commands allowed at all |
| `riaf.agent.approveTerminal` | `true` | Ask for commands not on the allowlist |
| `riaf.agent.approveMcp` | `true` | Ask before external MCP calls |
| `riaf.agent.autoApproveDetectedTestCommand` | `false` | Project test/typecheck/lint runs silently |
| `riaf.agent.preApprovedCommands` | `[]` | Prefixes that run without asking |
| `riaf.agent.denyCommandPatterns` | `[]` | Extra always-refused regexes |
| `riaf.agent.sandbox` | `auto` | `policy` / `seatbelt` / `off` |
| `riaf.agent.hooks` | `{}` | preTool / postEdit hooks |
| `riaf.mcp.disabledServers` | `[]` | Hide servers from the agent |
| `riaf.security.extraRules` | `[]` | `{ id, pattern, message }` for the security scan |
</details>

<details><summary>General &amp; Claude Code</summary>

| Setting | Default | Meaning |
|---|---|---|
| `riaf.general.aiInstructions` | `""` | Added to every prompt |
| `riaf.general.disableSystemPrompt` | `false` | Only your instructions + mode line |
| `riaf.general.metricsOptOut` | `false` | Don't record token totals |
| `riaf.usage.readClaudeCodeTranscripts` | `true` | Show Claude Code's real usage for the open repo from `~/.claude/projects` (local read only) |
| `riaf.claudeCode.writeUserSettings` | `true` | Setup writes proxy/CA into `~/.claude/settings.json` |
| `riaf.claudeCode.proxyUrl` | `""` | Host:port only; empty = auto-detect |
| `riaf.claudeCode.noProxy` | `localhost, 127.0.0.1` | Bypass list |
| `riaf.claudeCode.caCertPath` | `""` | Corporate root CA `.pem` (TLS-inspecting proxies) |
| `riaf.claudeCode.proxyBridge` / `.proxyBridgePort` | `true` / `3128` | Local authenticating proxy |
</details>

## 16. Corporate proxy and SSO

- **Gateway with SSO**: *Settings → Gateway*, URL + model, *Microsoft (Entra ID) SSO*, the gateway's API scope (`api://<app-id>/.default`), **Test connection**. Token comes from VS Code's built-in sign-in; nothing stored.
- **Authenticated proxy (Basic auth)**: `RIAF: Set Claude Code proxy credentials` (OS credential store). The **proxy bridge** then listens on `127.0.0.1:3128`, forwards to the corporate proxy adding `Proxy-Authorization` itself, and logs every `CONNECT` with the proxy's answer. Claude Code, the gateway transport and embeddings all go through it, so no password reaches any file. Outside VS Code: `node <extension>/dist/proxy-bridge.mjs --upstream http://proxy:8080`.
- **Which proxy**: `riaf.claudeCode.proxyUrl` (host:port) beats VS Code `http.proxy`, `HTTPS_PROXY`, npm config. Doctor shows written vs detected.
- **TLS inspection**: set `riaf.claudeCode.caCertPath` to the corporate root CA; required for Node < 22.15.

## 17. Troubleshooting

| Symptom | Fix |
|---|---|
| `@riaf`: *No language model available* | Sign in to Copilot and allow RIAF under Account → *Manage Trusted Extensions*; or configure a gateway/provider. Doctor lists what RIAF can see |
| `RIAF not indexed` | *RIAF: Reindex Workspace*; check the RIAF output channel |
| Search finds nothing | Use identifiers; check `.gitignore`/`excludeGlobs` (the Indexing Report lists what's in); enable embeddings |
| Edits never appear | Approval is on — look for the diff tab and Accept/Reject |
| Commands always "rejected" | Dialog dismissed, or Windows without Git Bash (Doctor shows the shell; set `RIAF_SHELL`) |
| `claude`: *ECONNREFUSED* | Run *Set up Claude Code*; set `riaf.claudeCode.proxyUrl` if nothing was detected |
| `claude`: *ERR_SOCKET_CLOSED* / proxy 407 | Wrong proxy host or credentials — curl-test with `-x <proxy> -U user:pass`; pin the working proxy; use the bridge and read its log |
| Gateway 401/403 | Wrong SSO scope; or `auth: header` + `riaf.gateway.headers` |
| Gateway returns, nothing streams | `riaf.gateway.stream: false` |
| Settings panel says *unknown request …* right after an upgrade | The panel is the new build but the extension host is still the old one — *Developer: Reload Window* |
| Claude Code's `riaf` server stopped after upgrading RIAF, or *Tools served* stays at 0 | `.mcp.json` pointed at the old versioned folder. Run **RIAF: Set up Claude Code** once; from now on it uses the version-independent launcher. Doctor and the Claude Code tab flag a stale `.mcp.json` |
| Usage shows zeros although I use RIAF in Claude Code / Copilot | Expected for the top two blocks: they count calls RIAF makes itself. Look at **Tools served** and **Claude Code · this repo** lower on the same tab (needs `riaf.usage.readClaudeCodeTranscripts`, default on). Doctor prints the transcript folder it found |
| Hook seems ignored | Hooks match tool names (preTool) / paths (postEdit) by regex; a hook that fails to launch now blocks and says why |

## 18. Files RIAF creates

| Path | Contents |
|---|---|
| `<globalStorage>/riaf-<hash>.sqlite` (+ `.tools.json`) | The index (one per workspace; Doctor prints the path) and the tools-served counters |
| `.riaf/runs/*.json` | Run ledgers (`/run`, `/status`, `/resume`, Claude Code `plan_*`) |
| `.riaf/notes/*.md`, `.riaf/interactions.json` | Notepads; interaction history used to boost search ranking |
| `.riafrules`, `.riaf/hooks.json`, `.riaf/rules/` | Project rules and hooks (yours) |
| `.mcp.json`, `.riaf/riaf-mcp.mjs`, `.claude/commands/`, `.claude/hooks/gate.mjs`, `CLAUDE.md` block | Claude Code setup (commit these) |
| `<folder>_context.md` | Context Document |
| `~/.riaf/memory.md` | User memory |
| `~/.claude/settings.json` (`env` block) | Proxy/CA for Claude Code |

---

Built from `@bosch-mps/riaf-core` (index engine), `@bosch-mps/token-opt` (budgeting), `@bosch-mps/riaf-engine` (plan–execute–verify) and this extension. Lifted from the Trove agentic IDE and re-packaged for the VS Code your team already runs. See `CHANGELOG.md` for what changed in each version.
