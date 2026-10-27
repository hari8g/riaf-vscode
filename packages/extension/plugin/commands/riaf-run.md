---
description: Plan a task into the RIAF ledger, then work one subtask at a time
---
Use the riaf MCP tools. Do not start editing until a run exists.

1. Call `plan_status`. If a run is already `planned` or `running`, continue it. Otherwise call `plan_create` with a JSON DAG for: $ARGUMENTS
2. Call `plan_next` and do only that subtask with your own edit tools. Ground files with `search_codebase` first.
3. Call `verify_subtask` for that id. On failure, fix once and verify again. Then `plan_mark`.
4. Repeat until `plan_next` is empty. Then `run_critic` with a short diff summary.
5. Stop when the ledger status is `done`. If it is `blocked`, say which subtask and why.
