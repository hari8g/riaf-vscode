# RIAF for VS Code

Repository intelligence (semantic index + context graph) and a token-disciplined
read → edit → verify agent, packaged as one `.vsix`. Works offline behind a corporate proxy;
authenticates to an internal LLM gateway with the SSO VS Code already holds.

## Install (developers)
1. Get `riaf-vscode-<version>.vsix` from the shared drive / internal release page.
2. VS Code → Extensions → `…` → **Install from VSIX…** (or `code --install-extension riaf-vscode-<version>.vsix`).
3. Reload. The status bar shows `RIAF … chunks` once the first index finishes (a minute or two).

## Use
| You use… | Do this |
|---|---|
| Copilot Chat | Type `#riaf <question>` or let agent mode pick the `Search codebase (RIAF)` tool itself. |
| `@riaf` agent | `@riaf add retry logic to the payment client` → plan, gather, edit (diff to accept), verify. Slash commands: `/plan`, `/explain`, `/verify`, `/reindex`. |
| Claude Code | Run **RIAF: Set up Claude Code** once per repo. It writes `.mcp.json` (riaf MCP server) and `.claude/commands` (`/riaf-plan`, `/riaf-verify`, `/riaf-context`) plus rules in `CLAUDE.md`. |

## Settings panel
**RIAF: Open Settings** (or click the `⚡ … saved` status-bar item) opens a panel with: Gateway (URL, model, SSO, *Test connection*), Repository Intelligence (index status, reindex, excludes, embeddings), Agent, Tools, Rules (`.riafrules`, shared with the team and with Claude Code), Usage (session + all-time tokens, cache hits, tokens saved, cost) and Claude Code setup status. Every value is an ordinary `riaf.*` setting, so the native Settings UI shows the same things.

## Settings that matter
- `riaf.gateway.url` / `riaf.gateway.model` — leave empty to borrow Copilot's models and SSO; set to use the internal gateway (`riaf.gateway.auth` = `microsoft-sso` by default).
- `riaf.embeddings.enabled` — off = BM25-only, zero network; on = hybrid retrieval via the gateway's `/embeddings`.
- `riaf.agent.*` — iteration caps, plan on/off, auto-verify, edit approval.

## Troubleshooting
Run **RIAF: Doctor** — reports index state, embeddings, gateway reachability and the proxy settings in effect. Logs: Output panel → *RIAF*.

## Build from source
```
npm install
npm run typecheck && npm test
npm run package          # → riaf-vscode-0.1.0.vsix at the repo root
```
Packages: `packages/riaf-core` (index engine), `packages/token-opt` (budgeting/caching/dedup), `packages/extension`.
