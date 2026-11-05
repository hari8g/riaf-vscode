---
description: Classify the task, compile a RIAF Prompt Instruction and follow it
---
Call the riaf MCP tool `riaf_instruction` with request: $ARGUMENTS

Then:
1. Read the instruction it returns. Files under "Already in context" and "Context items" are current — do not Read them again.
2. If "Open questions" is non-empty, ask them and stop.
3. Follow the Plan in order. Before any Read/Grep/Glob use `riaf_lookup` or `riaf_expand`.
4. If the instruction says "plan gate", present the plan and wait for approval before editing.
5. Run the Verification checklist once; on failure call `riaf_compile` with stage "verify" and appendOutput, fix once, stop.
