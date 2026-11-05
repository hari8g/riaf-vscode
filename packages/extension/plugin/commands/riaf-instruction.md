---
description: Load the current RIAF Prompt Instruction (compiled by VS Code or a previous session)
---
Call the riaf MCP tool `riaf_instruction` with no request (or read the resource riaf://instruction/current).
Treat the returned document as the brief for this session: follow its Plan, respect its Constraints, use its Verification checklist, and apply the Protocol (riaf_lookup before Read).
