<!-- riaf:rules -->
## RIAF — repository intelligence rules

This repository has a RIAF index available through the `riaf` MCP server. Tools:
`search_codebase`, `grep`, `glob`, `search_symbols`, `get_context_profile`, `get_file_outline`,
`get_import_graph`, `find_references`, `get_neighbors`, `get_service_topology`, `resolve_api_contract`,
`get_dependency_impact`, `get_config_drift`, `get_infra_resources`, `get_git_context`,
`get_indexing_report`, `reindex`. For a multi-step change also use `plan_create`, `plan_status`,
`plan_next`, `plan_mark`, `verify_subtask` and `run_critic`: the ledger lives in `.riaf/runs`.
Use them to keep context small and precise.
When the repo has enabled enterprise integrations (`.riaf/integrations.json`), the same server also offers
`jira_*`, `confluence_*`, `gitlab_*`, `kb_*` (vector store) and `kg_*` (knowledge graph) tools. Prefer them over
pasting ticket text or MR diffs into the prompt. Tools that change data (create/comment/transition/update/
approve) are recorded in `.riaf/audit.jsonl`; call them only when the task asks for that change.

Context gathering
- Start every task with `search_codebase` (identifiers, concepts, error text) or `get_context_profile`
  for the file you are about to change. Do not grep or read files blindly first.
- Read a file at most once. Prefer `get_file_outline` or a line range for large files.
- Do not re-read a file that is already in context; if an edit changed it, re-read only the changed range.
- Keep exploration to ~12 read/search calls before acting. If you exceed it, stop and act with what you have.

Editing
- Combine all changes to one file into one edit. Never make several small edits to the same file in a row.
- For new files, create them directly; don't read paths that don't exist yet.
- After an edit that touches more than one file, call `get_import_graph` for the edited file to find
  importers that may need updating.

Verification
- After editing, run the project's test or typecheck command once (see `get_context_profile` → commands),
  fix the cause, and stop. Do not loop on the same failing command more than twice.
- Prefer the narrowest test target that covers the change (`get_context_profile` lists covering tests).

Finishing
- Summarise changed files and why in 3–6 lines. Do not paste back file contents.

<!-- riaf:begin (managed by RIAF — edits inside this block are overwritten) -->
## RIAF repository intelligence

The RIAF MCP server indexes this repository. A compiled Context Pack for the current task is at
`.claude/riaf/pack.md` and as the MCP resource `riaf://pack/current` (sub-agents: `riaf://pack/current?scope=<path/>`).

Retrieval-before-tool protocol (RIAF):
1. Files listed under "Already in context" are current — do not Read, Grep or list them again.
2. Before any other file or search tool, call `riaf_lookup` (path, symbol or query); it answers from the index or tells you it is a miss.
3. Prefer `riaf_expand` (file or symbol) over walking directories: it returns the structural neighbourhood in one call.
4. After an edit, do not re-read the file to check it; the index reflects your write.
5. When the budget reflection fires, write your plan with `riaf_compile` (stage: "plan") so sub-agents inherit it.
<!-- riaf:end -->
