# RIAF for VS Code

**Repository intelligence + a disciplined coding agent, packaged as one VS Code extension.**

RIAF indexes your repository (semantic chunks, symbols, an import/call graph, and an "org index" of
Spring services, Maven/npm dependencies, Kubernetes, Terraform and CI) and makes that knowledge
available to whatever AI assistant your team already uses:

| You use… | RIAF gives you… |
|---|---|
| **GitHub Copilot Chat** | `#riaf`, `#riafContext`, `#riafSymbols` tools, plus the `@riaf` agent that plans → gathers → edits → verifies |
| **Claude Code** | the same index as a local MCP server, and `/riaf-plan`, `/riaf-verify`, `/riaf-context` commands |
| **An internal LLM gateway** | SSO-authenticated model access (no API keys), prompt caching, token budgeting |

Everything runs locally and offline by default; nothing is downloaded at install time, so it works behind a corporate proxy.

---

## Table of contents

1. [Requirements](#1-requirements)
2. [Install](#2-install)
3. [First run](#3-first-run)
4. [Using RIAF with Copilot Chat](#4-using-riaf-with-copilot-chat)
5. [The `@riaf` agent](#5-the-riaf-agent)
6. [Using RIAF with Claude Code](#6-using-riaf-with-claude-code)
7. [Commands (Command Palette)](#7-commands-command-palette)
8. [Settings panel and all settings](#8-settings-panel-and-all-settings)
9. [Connecting an internal gateway (SSO)](#9-connecting-an-internal-gateway-sso)
10. [Project rules, hooks and safety](#10-project-rules-hooks-and-safety)
11. [Token discipline: what saves tokens and how to see it](#11-token-discipline)
12. [Troubleshooting](#12-troubleshooting)
13. [Building from source](#13-building-from-source)
14. [Architecture](#14-architecture)

---

## 1. Requirements

- **VS Code 1.95 or newer** (`Code → About` / `Help → About`).
- For model access, one of:
  - GitHub Copilot Chat installed and signed in (RIAF borrows its models and your SSO), **or**
  - an internal OpenAI-compatible LLM gateway reachable from your machine (see §9).
- **Windows only:** Git for Windows (provides *Git Bash*). The agent and project hooks run POSIX
  commands; RIAF finds `bash.exe` automatically, or set the `RIAF_SHELL` environment variable to its path.
- Nothing else: no Python, no native modules, no admin rights.

## 2. Install

RIAF ships as a single `riaf-vscode-<version>.vsix` file (about 800 KB).

**Option A — from the Extensions view**

1. Open VS Code → Extensions (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Click the `···` button on the *title row* of the Extensions panel (not the dots on an extension card; if the panel is narrow it hides behind `»`).
3. Choose **Install from VSIX…**, pick the file, click Install.

**Option B — Command Palette**

`Ctrl+Shift+P` → type `vsix` → **Extensions: Install from VSIX…** → pick the file.

**Option C — terminal**

```sh
code --install-extension riaf-vscode-0.1.0.vsix
```
(If `code` isn't found: Command Palette → *Shell Command: Install 'code' command in PATH*.)

Reload the window when prompted. Upgrading is the same procedure with the newer file; your settings and index are kept.

## 3. First run

1. **Open a folder** (`File → Open Folder…`). RIAF indexes workspace folders, not loose files.
2. Indexing starts automatically. The status bar (bottom-left) shows `⟳ RIAF scan…` then **`RIAF 3,180 chunks`**. A mid-sized repo takes one to two minutes the first time; later runs are incremental (only changed files, by content hash).
3. Run **RIAF: Doctor** (`Ctrl+Shift+P` → `RIAF: Doctor`). It reports:
   - index state and the DB path,
   - whether embeddings are on,
   - which models are available (Copilot's, or the gateway with a live ping),
   - the proxy settings in effect and the shell RIAF will use for commands.
   Fix anything red here before going further.
4. Open **RIAF: Open Settings** (or click the **`⚡ 0 saved`** item bottom-right) to see the panel.

That's it. The sections below explain what you can do now.

## 4. Using RIAF with Copilot Chat

RIAF registers three *language model tools*. Copilot's **agent mode** picks them up by itself; in **ask mode** you reference them with `#`.

| Tool | Reference | What it returns |
|---|---|---|
| Search codebase | `#riaf` | Ranked code chunks (path, line range, content) for a natural-language or identifier query — hybrid BM25 + embeddings when enabled, identifier-aware (`orderService` matches `OrderService`, `order_service`) |
| Context profile | `#riafContext` | For a file: what it imports, what imports it, the tests that cover it, plus the workspace profile (languages, frameworks, build/test/lint commands) |
| Search symbols | `#riafSymbols` | Exported functions/classes/types by (partial) name, with file and line |

### Examples

```
#riaf where is the retry logic for payment capture?
```
```
#riafContext src/services/orderService.ts   — what should I check before changing this?
```
```
#riafSymbols TollTransaction
```
```
Using #riaf, list every place we parse the FASTag plate number and tell me which ones ignore the checksum.
```

Tip: in Copilot's tool picker (the 🔧 icon in the chat box) you can see the RIAF tools and turn them on/off per conversation.

## 5. The `@riaf` agent

`@riaf` is a chat participant that runs a bounded **plan → gather → edit → verify** loop with token discipline. Type `@riaf` followed by a task in the Copilot Chat box.

### Slash commands

| Command | Behaviour |
|---|---|
| `@riaf <task>` | Full loop: plan, gather context with RIAF tools, edit (each edit shown as a diff for you to accept), run tests, summarise |
| `@riaf /plan <task>` | Plan only, grounded in real files. No edits. Good first step for anything non-trivial |
| `@riaf /explain <question>` | Explain using read-only tools, citing `path:line` ranges. No edits |
| `@riaf /verify` | Run the detected test/typecheck/lint commands and report; proposes fixes, doesn't apply them |
| `@riaf /reindex` | Rebuild the index (e.g. after a branch switch) |

### Examples

```
@riaf /plan add exponential backoff to the Beckn charger status poller
```
```
@riaf add exponential backoff (3 retries, jitter) to the charger status poller and cover it with a test
```
```
@riaf /explain how does a toll transaction get from the ANPR camera to the settlement table?
```
```
@riaf the build fails with "Cannot find name 'TariffSlab'" — fix it
```
```
@riaf /verify
```

### What you'll see while it runs

1. **Plan** — a short checklist (≤ 300 tokens), ticked off as tools complete.
2. **Progress lines** — `search_codebase charger poller`, `read_file src/…`, `edit_file …` with ✅/❌.
3. **Diff for every edit** — a VS Code diff tab opens; click **Accept** or **Reject** in the notification. Nothing touches disk until you accept (unless you turn `riaf.agent.requireEditApproval` off).
4. **Command approval** — before `run_command`/`run_tests` a dialog shows the exact command. Pre-approve commands you trust in settings (§8).
5. **Diagnostics after edit** — the language server's errors/warnings for the edited file are fed back to the model so it fixes them before running tests.
6. **Verification** — after edits it runs the detected test command once and feeds the result back.
7. **Footer** — `n iterations · 12.4k in / 1.1k out · 9.8k tokens saved by RIAF this session`.

### Attaching context

Use Copilot's normal attachments: `#file:path`, `#selection`, or drag a file into the chat. The active editor file is always used for the context profile.

### Follow-ups

After a turn that edited files, a **Verify** follow-up button appears; after hitting the iteration cap, **Continue**.

### Undo: checkpoints and Rewind

Before the agent edits a file it snapshots it. **RIAF: Rewind** (Command Palette) lets you pick a turn and restore **files**, the **conversation**, or **both** to the state before that turn. Shell commands are *not* checkpointed — the agent tells you so when it runs one that deletes things.

### Tools the agent has (for reference)

*Read-only:* `search_codebase`, `search_symbols`, `get_context_profile`, `get_file_outline`, `read_file`, `search_in_file`, `grep`, `glob`, `ls_dir`, `get_import_graph`, `get_tests_for_file`, `find_references`, `get_neighbors`, `get_git_context`, `get_service_topology`, `resolve_api_contract`, `get_dependency_impact`, `get_config_drift`, `get_infra_resources`, `explore` (a read-only sub-agent that researches and returns a short report so the main thread stays small).

*Write:* `edit_file` (search/replace blocks; several per call), `rewrite_file`, `create_file_or_folder`, `delete_file_or_folder`.

*Commands:* `run_command`, `run_tests`.

`/plan` and `/explain` get only the read-only set; `/verify` adds the command tools.

## 6. Using RIAF with Claude Code

Claude Code has its own agent loop, so RIAF doesn't replace it — it feeds it the index and some discipline.

**One-time setup per repository:** Command Palette → **RIAF: Set up Claude Code (MCP + plugin)**. This writes, inside the repo:

- `.mcp.json` — a `riaf` MCP server entry (stdio, `node <extension>/dist/mcp.mjs --workspace <repo> --db <index>`), sharing the same SQLite index the extension uses;
- `.claude/commands/riaf-plan.md`, `riaf-verify.md`, `riaf-context.md`;
- a `<!-- riaf:rules -->` block appended to `CLAUDE.md` with the token-discipline rules.

- the **corporate proxy and CA for Claude Code itself** into `~/.claude/settings.json` (`env` block: `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`). Claude Code reads the proxy only from there or the environment — not from npm or VS Code — so without this step `claude` fails with `Unable to connect to Anthropic services … ECONNREFUSED` behind a proxy. RIAF detects the values in this order: `riaf.claudeCode.proxyUrl` → VS Code `http.proxy` → `HTTPS_PROXY` → npm config; CA: `riaf.claudeCode.caCertPath` → `NODE_EXTRA_CA_CERTS` → npm `cafile`. Existing keys in the file are left untouched; turn this off with `riaf.claudeCode.writeUserSettings: false`.

Restart Claude Code in that folder. Then:

| In Claude Code | What happens |
|---|---|
| (automatic) | Claude sees `search_codebase`, `search_symbols`, `get_context_profile`, `get_file_outline`, `get_import_graph`, `get_indexing_report`, `reindex` as MCP tools and uses them instead of grepping |
| `/riaf-plan add retry logic to the payment client` | Grounded plan via the index, no edits |
| `/riaf-context src/orderService.ts` | Imports, importers, covering tests, project commands for that file |
| `/riaf-verify` | Runs the narrowest covering test command, fixes once, reports |

Commit `.mcp.json`, `.claude/` and `CLAUDE.md` so the whole team gets it. The MCP server also runs standalone for any MCP client:

```sh
node ~/.vscode/extensions/bosch-mps.riaf-vscode-0.1.0/dist/mcp.mjs --workspace /path/to/repo [--db /path/to/index.sqlite] [--reindex]
```

## 7. Commands (Command Palette)

`Ctrl+Shift+P` / `Cmd+Shift+P`, then type `RIAF:`

| Command | What it does |
|---|---|
| **RIAF: Open Settings** | The settings panel (§8) |
| **RIAF: Reindex Workspace** | Full rebuild of the index for the current folder |
| **RIAF: Show Indexing Report** | Markdown report: languages, frameworks, commands, graph metrics, org-index contents |
| **RIAF: Show Context Graph** | Interactive import graph (drag to pan, wheel to zoom; node size = degree) |
| **RIAF: Set up Claude Code (MCP + plugin)** | Writes `.mcp.json`, `.claude/commands`, `CLAUDE.md` rules (§6) |
| **RIAF: Doctor (index, embeddings, gateway)** | Health report; run this first when anything misbehaves |
| **RIAF: Show Token Usage** | Session and all-time token/cost table |
| **RIAF: Rewind** | Restore files and/or conversation from a checkpoint |

Status bar: **`RIAF n chunks`** (left; click → indexing report) and **`⚡ n saved`** (right; click → settings panel). The Output panel has a **RIAF** channel with the full log.

No default keyboard shortcuts are bound (to avoid clashing with Copilot's). To add your own: `File → Preferences → Keyboard Shortcuts`, search `RIAF`, and assign — e.g. `Ctrl+Alt+R` to *RIAF: Open Settings*. Or in `keybindings.json`:

```json
[
  { "key": "ctrl+alt+r", "command": "riaf.openSettings" },
  { "key": "ctrl+alt+i", "command": "riaf.reindex" },
  { "key": "ctrl+alt+z", "command": "riaf.rewind" }
]
```

## 8. Settings panel and all settings

**RIAF: Open Settings** opens a panel with a left navigation: *Gateway · Repository Intelligence · Agent · Tools · Rules · Usage · Claude Code*. Every control is an ordinary `riaf.*` setting, so the native Settings UI (`Ctrl+,` → search `riaf`) and `settings.json` show the same values. Settings are stored per user; put them in `.vscode/settings.json` to share with the team.

### Index

| Setting | Default | Meaning |
|---|---|---|
| `riaf.index.autoIndexOnStartup` | `true` | Index when a folder opens (incremental after the first run) |
| `riaf.index.watch` | `true` | Keep the index fresh as files are saved |
| `riaf.index.respectGitignore` | `true` | Skip `.gitignore`d files (root and nested) |
| `riaf.index.treeSitter` | `true` | Syntax-tree chunking and symbols; regex fallback per language |
| `riaf.index.excludeGlobs` | `node_modules/`, `dist/`, … | Extra gitignore-style patterns to skip |

### Embeddings

| Setting | Default | Meaning |
|---|---|---|
| `riaf.embeddings.enabled` | `false` | Off = BM25 keyword search only, zero network. On = hybrid retrieval via the gateway's `/embeddings` (needs §9) |
| `riaf.embeddings.model` | `amazon.titan-embed-text-v2:0` | Embedding model id at the gateway |

### Gateway (see §9)

| Setting | Default | Meaning |
|---|---|---|
| `riaf.gateway.url` | `""` | OpenAI-compatible base URL. Empty = use Copilot's models |
| `riaf.gateway.model` | `""` | Chat model id at the gateway |
| `riaf.gateway.auth` | `microsoft-sso` | `microsoft-sso`, `github-sso`, `header`, `none` |
| `riaf.gateway.ssoScopes` | `openid profile email` | Scopes to request; use your gateway's API scope |
| `riaf.gateway.headers` | `{}` | Extra headers |
| `riaf.gateway.promptCache` | `true` | Anthropic `cache_control` breakpoints for Claude models |
| `riaf.gateway.stream` | `true` | SSE streaming; turn off if the gateway rejects `stream=true` |

### Agent

| Setting | Default | Meaning |
|---|---|---|
| `riaf.agent.generatePlan` | `true` | Plan first (≤ 300 tokens), tick items off as tools run |
| `riaf.agent.maxIterations` | `25` | Hard cap on tool rounds per request |
| `riaf.agent.maxReadOnlyCalls` | `12` | Exploration budget before the agent is nudged to act |
| `riaf.agent.contextWindowRatio` | `0.85` | How full the context window may get before trimming |
| `riaf.agent.summarizeHistory` | `true` | Past ~60 % of budget, summarise the oldest turns instead of dropping them |
| `riaf.agent.exploreSubagent` | `true` | Expose the read-only `explore` sub-agent |
| `riaf.agent.autoVerify` | `true` | Run detected tests after edits and feed results back |
| `riaf.agent.diagnosticsAfterEdit` | `true` | Return language-server errors for an edited file in the tool result |
| `riaf.agent.checkpoints` | `true` | Snapshot files before edits (enables Rewind) |

### Claude Code network (Route A — Claude Code through the corporate proxy)

| Setting | Default | Meaning |
|---|---|---|
| `riaf.claudeCode.writeUserSettings` | `true` | Let *Set up Claude Code* write proxy/CA into `~/.claude/settings.json` |
| `riaf.claudeCode.proxyUrl` | `""` | Proxy for Claude Code, **host and port only**; empty = auto-detect (VS Code `http.proxy` → `HTTPS_PROXY` → npm config) |
| *(command)* **RIAF: Set Claude Code proxy credentials** | — | For proxies that need a user name and password. Masked prompt; stored in the OS credential store (Windows Credential Manager / macOS Keychain), never in `settings.json`. Setup composes `http://user:pass@host:port` (special characters percent-encoded) and writes it only into `~/.claude/settings.json`, which is where Claude Code requires it. Credentials already present in a detected `HTTPS_PROXY` are kept as-is |
| `riaf.claudeCode.noProxy` | `localhost, 127.0.0.1` | Hosts reached without the proxy; add your intranet suffix (`.example.com`) |
| `riaf.claudeCode.caCertPath` | `""` | Corporate root CA `.pem` for TLS-inspecting proxies; empty = auto-detect (`NODE_EXTRA_CA_CERTS` → npm `cafile`). **Required on Node < 22.15**, which cannot read the Windows certificate store |

### Tools and safety

| Setting | Default | Meaning |
|---|---|---|
| `riaf.agent.requireEditApproval` | `true` | Every edit is a diff you accept or reject |
| `riaf.agent.allowRunCommand` | `true` | Allow shell commands at all (each still asks) |
| `riaf.agent.autoApproveDetectedTestCommand` | `false` | Let the project's own test/typecheck/lint command run without a dialog |
| `riaf.agent.preApprovedCommands` | `[]` | Command prefixes that run without asking, e.g. `["npm test", "npx vitest", "npm run lint"]` |
| `riaf.agent.denyCommandPatterns` | `[]` | Extra regexes that are always refused (built-ins already block `rm -rf /`, `sudo`, `curl … \| sh`, `git push --force`, `git reset --hard`, `chmod 777`, `mkfs`, `shutdown`, …) |
| `riaf.agent.sandbox` | `auto` | `policy` refuses commands that write outside the workspace; `seatbelt` enforces it with macOS `sandbox-exec`; `auto` = seatbelt where available |
| `riaf.agent.hooks` | `{}` | Pre-tool / post-edit hooks (see §10) |

## 9. Connecting an internal gateway (SSO)

If Copilot isn't available, or you want a specific model (e.g. Claude on Bedrock via LiteLLM), point RIAF at the gateway. No API keys are stored anywhere; the token comes from VS Code's built-in sign-in.

1. **RIAF: Open Settings → Gateway**.
2. *Gateway URL*: the OpenAI-compatible base, e.g. `https://llm-gateway.internal/v1`.
3. *Chat model*: the id the gateway expects, e.g. `anthropic.claude-sonnet-4-5`.
4. *Authentication*: **Microsoft (Entra ID) SSO** (default). *SSO scopes*: ask the gateway owner — usually `api://<gateway-app-id>/.default`.
5. Click **Test connection**. First time, VS Code opens the Microsoft sign-in; afterwards the token is reused silently. The badge shows transport and latency.
6. Optionally turn on **Semantic embeddings** in *Repository Intelligence* and reindex — ranking improves noticeably on large repos.

Everything RIAF sends goes through VS Code's own network stack, so `http.proxy` / PAC settings apply. **RIAF: Doctor** shows the effective proxy settings.

`settings.json` equivalent for a team:

```json
{
  "riaf.gateway.url": "https://llm-gateway.internal/v1",
  "riaf.gateway.model": "anthropic.claude-sonnet-4-5",
  "riaf.gateway.auth": "microsoft-sso",
  "riaf.gateway.ssoScopes": ["api://0000-your-app-id/.default"],
  "riaf.embeddings.enabled": true
}
```

## 10. Project rules, hooks and safety

### Rules the agent always sees

RIAF puts project rules into the agent's system prompt (budgeted, so a long file can't eat the context). In priority order:

| File | Scope |
|---|---|
| `.riafrules` (edit in *Settings → Rules*) | Whole repo |
| `AGENTS.md` at the root, or `.riaf/AGENTS.md` | Whole repo (same convention other agents use) |
| `.riaf/rules/*.md` | Whole repo, sorted by filename |
| nested `AGENTS.md` | Applies when the active file is under that directory |

Example `.riafrules`:

```
- Use the shared logger (src/lib/log.ts); never console.log.
- Services live in src/services, tests beside them as *.test.ts.
- Run `npm run typecheck` before `npm test`.
- Do not edit anything under generated/.
```

### Hooks

Project-defined shell commands around tool calls, in `.riaf/hooks.json` (committed, team-wide) or `riaf.agent.hooks`:

```json
{
  "preTool": [
    { "matcher": "^(edit_file|rewrite_file)$", "command": "node scripts/no-lockfile-edits.mjs" },
    { "matcher": "^delete_file_or_folder$",   "command": "echo '{\"decision\":\"block\",\"reason\":\"deletes need a human\"}'" }
  ],
  "postEdit": [
    { "matcher": "\\.(ts|tsx)$", "command": "npx prettier --write \"$RIAF_FILE\"" }
  ]
}
```

- **preTool** hooks receive `{ tool, args, workspace }` as JSON on stdin (and `RIAF_TOOL`, `RIAF_WORKSPACE` env). Exit code **2** or stdout `{"decision":"block","reason":"…"}` blocks the call; the reason goes back to the model. A hook that cannot start blocks too (fail closed).
- **postEdit** hooks run after a file is written with `RIAF_FILE` set; failures are reported, never fatal. Typical use: formatters.
- Hooks run in `/bin/sh` on macOS/Linux and in Git Bash on Windows, so write them once in POSIX syntax.

### Command safety

Every shell command passes, in order: the built-in deny list → your `denyCommandPatterns` → the sandbox (`policy`: refuse writes outside the workspace except caches/tmp; `seatbelt`: enforced by macOS) → the allowlist (`preApprovedCommands`, the detected project commands if `autoApproveDetectedTestCommand`) → otherwise a confirmation dialog showing the exact command. Chains (`a && b`) need every segment approved.

## 11. Token discipline

What RIAF does so each request sends less and gets more:

| Mechanism | Effect |
|---|---|
| RIAF search first | Top-ranked chunks instead of reading many whole files |
| Duplicate-read suppression | A file already in context is not re-read; the model is told so |
| Exploration budget + hints | Nudges the model to act after N read-only calls, flags repeated reads/edits |
| Stale tool-result compaction | Old search/read/terminal outputs collapse to one-line references (recent ones stay) |
| Context-window trimming | Oldest messages dropped before the model's window overflows; protected tail kept |
| History summarisation | Past ~60 % of budget, old turns become a model-written summary |
| `explore` sub-agent | Research happens in a side loop; only a short report returns |
| Prompt caching | Stable system prefix cached on Claude models via the gateway |
| Combined edits | One `edit_file` call per file with several blocks, instead of many tiny edits |

**Seeing it:** the `⚡ n saved` status item counts tokens kept out of prompts this session; *Settings → Usage* and **RIAF: Show Token Usage** break down calls, input/output, cache hits, saved tokens and estimated cost (session and all time). With Copilot-provided models token counts are estimates; with a gateway they're what the gateway reported.

## 12. Troubleshooting

Start with **RIAF: Doctor** and the **RIAF** output channel. Then:

| Symptom | Cause / fix |
|---|---|
| Proxy returns **407** / `claude` reports proxy authentication failed | The proxy needs credentials: run **RIAF: Set Claude Code proxy credentials**, then **RIAF: Set up Claude Code** again. Doctor shows `proxy credentials: stored in the OS credential store (user)` when they're in place; the password is never displayed |
| `claude` says *Unable to connect to Anthropic services … ECONNREFUSED* | Claude Code isn't using the corporate proxy. Run **RIAF: Set up Claude Code** (writes `HTTPS_PROXY`/CA into `~/.claude/settings.json`); if nothing was detected, set `riaf.claudeCode.proxyUrl` (value of `npm config get https-proxy`) and, for TLS-inspecting proxies, `riaf.claudeCode.caCertPath`, then re-run. Doctor's *Claude Code network* lines show written vs detected values. Verify with `claude --debug` then `/status` → *Proxy* row |
| `@riaf` says *No language model available* | Copilot not installed/signed in, or VS Code hasn't granted RIAF access to Copilot's models. Account icon (bottom-left) → *Manage Trusted Extensions* → tick RIAF; or configure a gateway (§9). Doctor's `vscode.lm models:` line shows what RIAF can see |
| `RIAF not indexed` in the status bar | Run **RIAF: Reindex Workspace**; check the output channel for the failing file |
| Search finds nothing relevant | Try identifiers rather than prose; check `riaf.index.excludeGlobs` / `.gitignore` aren't hiding the folder (Indexing Report lists what's in); enable embeddings |
| Edits never appear | `requireEditApproval` is on — look for the diff tab and the Accept/Reject notification |
| Commands "rejected" every time | A dialog was dismissed; or on Windows Git Bash wasn't found (Doctor shows the shell; install Git for Windows or set `RIAF_SHELL`) |
| Gateway test fails with 401/403 | Wrong SSO scope — use the gateway's API scope, not `openid`; or the gateway expects a different header (`riaf.gateway.auth: header` + `riaf.gateway.headers`) |
| Gateway returns but nothing streams | Set `riaf.gateway.stream: false` |
| Index DB grows large | It lives in VS Code's global storage, one file per workspace; delete it and reindex. Doctor prints the path |
| Hook seems ignored | Hooks only match tool names (preTool) or file paths (postEdit) via regex; test the regex. A hook that fails to launch now *blocks* and says why |

## 13. Building from source

```sh
git clone https://github.com/hari8g/riaf-vscode.git
cd riaf-vscode
npm install                 # Node ≥ 20; links the three workspace packages
npm run typecheck           # tsc across riaf-core, token-opt, extension, webview
npm test                    # builds the libraries, then 260+ tests
npm run package             # production bundle → riaf-vscode-0.1.0.vsix at the repo root
code --install-extension riaf-vscode-0.1.0.vsix
```

Developing: open the repo in VS Code, `npm run watch -w packages/extension` in a terminal, press **F5** to launch an *Extension Development Host* window, open a repo there. `Ctrl+R` in that window reloads after a rebuild.

Windows notes: build, tests and packaging all run in PowerShell; Git Bash is needed only at runtime for agent commands/hooks (and for the four hook tests, which skip without it).

## 14. Architecture

```
packages/
  riaf-core/     @bosch-mps/riaf-core   – indexing & retrieval engine (no VS Code deps)
                 scanner · tree-sitter/regex chunker · symbols · SQLite FTS5 (WASM) · BM25 + embeddings (HNSW, RRF)
                 universal context graph · symbol graph · module resolver · org indexers (Spring, Maven, npm, k8s, Terraform, GitLab CI, config drift)
  token-opt/     @bosch-mps/token-opt   – prompt caching, trimming, compaction, read dedup, batching, rate limits, usage/pricing, agent hints & plan
  extension/     riaf-vscode            – VS Code surface: LM tools, @riaf agent loop, checkpoints, command policy, hooks, settings webview,
                                          MCP server (dist/mcp.mjs), Claude Code plugin (plugin/)
```

- The extension host bundle is CommonJS; the MCP server is ESM; the settings panel is a React bundle in a webview. All three are built by `packages/extension/esbuild.mjs`.
- SQLite is the official WebAssembly build (`@sqlite.org/sqlite-wasm`, FTS5 included), vendored next to the bundle — no native compilation, nothing fetched at install.
- Model transport is pluggable: `VscodeLmTransport` (Copilot's models) or `GatewayTransport` (OpenAI wire + SSO + prompt caching). The agent loop, tools and budgeting don't know which one is in use.
- Both libraries are publishable to an internal npm registry for reuse outside VS Code (CLI, CI, other agents).

The engine and the token-optimisation layer were extracted from the Trove agentic IDE (a VS Code fork); the extension replaces Trove's fork-only UI with standard VS Code APIs so it installs into the editor your team already has.
