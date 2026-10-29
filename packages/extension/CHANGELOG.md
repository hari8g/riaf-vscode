# Changelog

## 0.3.0
- Enterprise integrations framework: adapters for **Jira** (Cloud + Data Center), **Confluence**, **GitLab** (self-hosted / gitlab.com) and **knowledge stores** (Qdrant, Weaviate, Chroma vector search; Neo4j read-only Cypher). 30 read tools + 17 write tools, available to `@riaf`, Copilot (`#riaf…`, reads only) and the Claude Code MCP server.
- Settings → **Integrations** tab: enable per adapter, URL/defaults fields generated from each adapter's schema, Test connection, credential status, recent writes. Commands `RIAF: Set Integration Credentials`, `RIAF: Test Integrations`, `RIAF: Show Integration Audit Log`; Doctor reports each adapter's health.
- Credentials live only in the OS credential store (`riaf.integration.<id>.<key>`); for Claude Code via `RIAF_INTEGRATION_*` env vars or the opt-in `~/.riaf/credentials.json` (0600). Non-secret config for the MCP server in `.riaf/integrations.json`.
- Write tools ask first (`riaf.agent.approveIntegrationWrites`) and every write is recorded in `.riaf/audit.jsonl` with redacted arguments; secrets are scrubbed from error text.
- `scripts/sync-integrations.mjs` keeps `package.json` (settings schema, Copilot tool contributions) in step with the adapters; a test fails when it is stale.

## 0.2.0
- Usage tab: "RIAF effect inside Claude Code" — with-vs-without-RIAF comparison from transcripts (prompt/output tokens per call, reads per turn, % saved) and a direct per-tool savings estimate.
- Claude Code setup writes a version-independent launcher (`.riaf/riaf-mcp.mjs`) and points `.mcp.json` at it; the panel and Doctor flag a stale `.mcp.json` from an older install.
- Version bump so the new icon and README replace the cached 0.1.0 install cleanly.

## 0.1.0
- MPS logo as the extension icon (Extensions view, marketplace card, @riaf chat avatar, settings tab).
- Usage tab: "Tools served" counters for Copilot and Claude Code (calls per tool, tokens returned, estimated tokens saved vs whole-file reads) and "Claude Code · this repo" real usage (calls, tokens, cache efficiency, cost) read from Claude Code's transcripts; Doctor reports both; `riaf.usage.readClaudeCodeTranscripts`.
- Extension description page (this README in the Extensions view): full feature, shortcut, command, tool, setting and troubleshooting reference.
- Local proxy bridge (127.0.0.1:3128) that forwards to an authenticated corporate proxy and injects the credentials; Claude Code is pointed at the bridge so no password is written anywhere. Standalone `dist/proxy-bridge.mjs` for terminals outside VS Code. Logs each CONNECT and the upstream's answer.
- Authenticated proxies: `RIAF: Set Claude Code proxy credentials` stores user/password in the OS credential store; setup composes the `http://user:pass@host` URL (percent-encoded) for ~/.claude/settings.json; passwords are redacted in the panel, Doctor, notifications and logs.
- Claude Code behind a corporate proxy (Route A): setup detects the proxy (VS Code http.proxy → HTTPS_PROXY → npm config) and CA bundle and writes them into ~/.claude/settings.json; new riaf.claudeCode.* settings, panel section and Doctor lines.
- Windows: agent commands and project hooks run through Git Bash when present (cmd.exe fallback, `RIAF_SHELL` override); a pre-tool hook that cannot start now blocks instead of allowing. Doctor reports the shell.
- Settings panel (`RIAF: Open Settings`, also via the status-bar token counter): Gateway with Test connection, Repository Intelligence status + reindex, Agent and Tools options, `.riafrules` editor, Usage dashboard, Claude Code setup status. Ported from Trove's settings UI, pruned for a SSO-only environment.
- Initial standalone extraction from Trove: riaf-core (index + hybrid retrieval), token-opt (budgeting), @riaf agent, LM tools, MCP server for Claude Code.
