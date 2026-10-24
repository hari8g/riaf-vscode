# riaf-vscode monorepo

| package | what | tests |
|---|---|---|
| `@bosch-mps/riaf-core` | RIAF repository intelligence: scanner, chunker, FTS5/BM25 + embedding hybrid retrieval (RRF), universal context graph, org indexers. SQLite via WASM (`@sqlite.org/sqlite-wasm`), no native build. | `packages/riaf-core/test` |
| `@bosch-mps/token-opt` | Prompt caching breakpoints, context-window trim, stale tool-result compaction, file-read dedup, parallel read batching, rate-limit handling, usage/pricing, agent hints & plan. Zero VS Code deps. | `packages/token-opt/test` |
| `riaf-vscode` | The extension: LM tools for Copilot, `@riaf` agent, MCP server for Claude Code, SSO gateway transport. | `packages/extension/test` |

```
npm install && npm run typecheck && npm test && npm run package
```
Lifted from `hari8g/trove_v1` (`src/vs/workbench/contrib/trove`); see each package README for what changed.
