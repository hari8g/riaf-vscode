---
description: Plan a change using the RIAF index before touching code
---
Produce a concise plan (3–8 bullets, infinitive verbs) for: $ARGUMENTS

Rules:
1. First call `search_codebase` and `get_context_profile` via the riaf MCP server to ground the plan in real files.
2. Name the exact files to read (once each) and the files to edit (one combined edit per file).
3. Include one verification step using the project's detected test/typecheck command.
4. Do not edit anything yet. Output only the bullet list.
