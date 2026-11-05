/**
 * Send to Claude Code — the parts with no `vscode` dependency (also used by the daemon / console).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { upsertClaudeMd, upsertClaudeMdInstruction, type PromptInstruction } from '@bosch-mps/riaf-core';

/* ───────────────────────── Send to Claude Code (five channels) ───────────────────────── */

export const SLASH_COMMANDS: Record<string, string> = {
	'riaf-task.md': `---
description: Classify the task, compile a RIAF Prompt Instruction and follow it
---
Call the riaf MCP tool \`riaf_instruction\` with request: $ARGUMENTS

Then:
1. Read the instruction it returns. Files under "Already in context" and "Context items" are current — do not Read them again.
2. If "Open questions" is non-empty, ask them and stop.
3. Follow the Plan in order. Before any Read/Grep/Glob use \`riaf_lookup\` or \`riaf_expand\`.
4. If the instruction says "plan gate", present the plan and wait for approval before editing.
5. Run the Verification checklist once; on failure call \`riaf_compile\` with stage "verify" and appendOutput, fix once, stop.
`,
	'riaf-instruction.md': `---
description: Load the current RIAF Prompt Instruction (compiled by VS Code or a previous session)
---
Call the riaf MCP tool \`riaf_instruction\` with no request (or read the resource riaf://instruction/current).
Treat the returned document as the brief for this session: follow its Plan, respect its Constraints, use its Verification checklist, and apply the Protocol (riaf_lookup before Read).
`,
};

export interface SendResult { written: string[]; launched: boolean }

/** Write the instruction through every Claude Code door; optionally open a terminal running `claude` with it. */
export function writeInstructionForClaude(root: string, instruction: PromptInstruction, opts: { pluginDir?: string } = {}): string[] {
	const written: string[] = [];
	// 1 + 4: the instruction files are already at .claude/riaf/instructions/{current.md,current.json} (hook + MCP read them).
	written.push(join(root, '.claude', 'riaf', 'instructions', 'current.md'));
	// 2: slash commands
	const cmdDir = join(root, '.claude', 'commands');
	mkdirSync(cmdDir, { recursive: true });
	for (const [name, body] of Object.entries(SLASH_COMMANDS)) {
		const p = join(cmdDir, name);
		const fromPlugin = opts.pluginDir ? join(opts.pluginDir, 'commands', name) : '';
		if (fromPlugin && existsSync(fromPlugin)) { cpSync(fromPlugin, p); } else { writeFileSync(p, body); }
		written.push(p);
	}
	// 3: CLAUDE.md managed blocks (rules block if missing, instruction block always refreshed with the stable half)
	const claudeMd = join(root, 'CLAUDE.md');
	const existing = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : '';
	writeFileSync(claudeMd, upsertClaudeMdInstruction(upsertClaudeMd(existing), instruction));
	written.push(claudeMd);
	return written;
}

export function claudeLaunchCommand(root: string, opts: { headless?: boolean } = {}): string {
	const rel = '.claude/riaf/instructions/current.md';
	if (process.platform === 'win32') {
		// PowerShell: Get-Content -Raw keeps the markdown intact.
		return opts.headless ? `claude -p (Get-Content -Raw "${rel}") --output-format json` : `claude (Get-Content -Raw "${rel}")`;
	}
	return opts.headless ? `claude -p "$(cat ${rel})" --output-format json` : `claude "$(cat ${rel})"`;
}

