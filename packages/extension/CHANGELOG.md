# Changelog

## 0.1.0
- Claude Code behind a corporate proxy (Route A): setup detects the proxy (VS Code http.proxy → HTTPS_PROXY → npm config) and CA bundle and writes them into ~/.claude/settings.json; new riaf.claudeCode.* settings, panel section and Doctor lines.
- Windows: agent commands and project hooks run through Git Bash when present (cmd.exe fallback, `RIAF_SHELL` override); a pre-tool hook that cannot start now blocks instead of allowing. Doctor reports the shell.
- Settings panel (`RIAF: Open Settings`, also via the status-bar token counter): Gateway with Test connection, Repository Intelligence status + reindex, Agent and Tools options, `.riafrules` editor, Usage dashboard, Claude Code setup status. Ported from Trove's settings UI, pruned for a SSO-only environment.
- Initial standalone extraction from Trove: riaf-core (index + hybrid retrieval), token-opt (budgeting), @riaf agent, LM tools, MCP server for Claude Code.
