---
description: Run the detected test/typecheck commands for the files changed in this session and fix failures
---
1. Call `get_context_profile` for each file changed in this session to find covering tests and the project's test/typecheck commands.
2. Run the narrowest command that covers the changes (fall back to the full test command).
3. If it fails, fix the cause with the fewest edits (one combined edit per file), rerun once, and stop.
4. Report: command run, pass/fail, files touched. $ARGUMENTS
