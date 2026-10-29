# Changelog

## 0.2.0
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
