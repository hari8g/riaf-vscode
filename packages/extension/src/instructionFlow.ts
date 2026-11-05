/**
 * RIAF 2.0 in the VS Code extension — Designs A/B/C glued together for the `@riaf` participant:
 *   route the request (intent classifier + optional arbiter + per-repo feedback) → compile the pack with
 *   the route's budget/stage/scope → assemble the Prompt Instruction → review card with buttons →
 *   run here, or hand the instruction to Claude Code through all five doors.
 */
import * as vscode from 'vscode';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	formatRouteLine, INTENT_TYPES, loadCurrentInstruction, recordIntentFeedback, Riaf2, upsertClaudeMd, upsertClaudeMdInstruction,
	type IntentRoute, type IntentType, type PromptInstruction,
} from '@bosch-mps/riaf-core';
import { Riaf2Host } from './riaf2Host.js';
import { readSettings, type RiafSettings } from './config.js';
import type { IndexManager } from './indexManager.js';
import { createTransport, type ModelTransport } from './modelTransport.js';

const hosts = new WeakMap<object, Riaf2Host>();

/** One Riaf2Host per index (shared with the pack commands); the arbiter uses `riaf.models.classify` when set. */
export async function hostFor(indexes: IndexManager, folder: vscode.WorkspaceFolder, transport?: ModelTransport): Promise<Riaf2Host> {
	const index = await indexes.get(folder);
	if (!index.getStatus().indexed) { await indexes.reindex(folder); }
	let h = hosts.get(index);
	if (!h) {
		const r = Riaf2.fromIndex(index, { llmSummaries: false, log: m => indexes.log(m) });
		await r.history?.mine().catch(() => undefined);
		await r.summaries.build().catch(() => undefined);
		h = new Riaf2Host(r, { host: 'vscode', log: m => indexes.log(`[riaf2] ${m}`), classify: makeClassifier(readSettings(), transport) });
		hosts.set(index, h);
	}
	return h;
}

/** Tier-2 arbiter: the classify model if configured, else the chat's model. Returns undefined when the arbiter is off. */
export function makeClassifier(s: RiafSettings, transport?: ModelTransport): ((system: string, user: string) => Promise<string>) | undefined {
	if (!s.instruction.arbiter) { return undefined; }
	return async (system, user) => {
		const t = s.models.classify ? await createTransport(undefined, s.models.classify) ?? transport : transport;
		if (!t) { throw new Error('no model for the intent arbiter'); }
		const r = await t.call({ systemMessage: system, messages: [{ role: 'user', text: user }], maxOutputTokens: 120 });
		return r.text;
	};
}

export function planGateApplies(route: IntentRoute, s: RiafSettings): boolean {
	if (s.instruction.planGate === 'off') { return false; }
	if (s.instruction.planGate === 'all') { return route.mode === 'agent' && route.source !== 'command'; }
	return route.planGate;
}

export interface PreparedTurn { route: IntentRoute; instruction: PromptInstruction; items: number; tokens: number; path: string }

export async function prepareTurn(host: Riaf2Host, request: string, opts: { command?: string; activeFile?: string; selection?: string }): Promise<PreparedTurn> {
	const r = await host.instruct(request, { command: opts.command, activeFile: opts.activeFile, selection: opts.selection, host: 'copilot' });
	return { route: r.route, instruction: r.instruction, items: r.pack.items.length, tokens: r.pack.budget.used_tokens, path: r.path };
}

/** The review card: one route line, a collapsible instruction, and the action buttons. */
export function renderCard(stream: vscode.ChatResponseStream, t: PreparedTurn, folder: vscode.WorkspaceFolder, opts: { gated?: boolean } = {}): void {
	stream.markdown(`_${formatRouteLine(t.route, { items: t.items, tokens: t.tokens })} · instruction \`${t.instruction.instruction_id}\`_\n\n`);
	stream.markdown(`<details><summary>Prompt Instruction ${t.instruction.instruction_id} (${t.instruction.tokens} tokens)</summary>\n\n${t.instruction.markdown.replace(/^# /m, '#### ')}\n\n</details>\n\n`);
	stream.button({ command: 'riaf.sendToClaudeCode', title: '$(rocket) Send to Claude Code', arguments: [folder.uri.fsPath, t.instruction.instruction_id] });
	stream.button({ command: 'riaf.openInstruction', title: '$(edit) Edit instruction', arguments: [folder.uri.fsPath] });
	stream.button({ command: 'riaf.intentFeedback', title: '$(thumbsdown) Wrong intent?', arguments: [folder.uri.fsPath, t.instruction.request, t.route.type] });
	if (opts.gated) { stream.markdown(`\n_Plan gate: this ${t.route.type} task is planned first. Review the plan, then click **Implement the plan** (or type \`@riaf implement the plan\`)._\n\n`); }
}

/* ───────────────────────── Send to Claude Code (five channels) ───────────────────────── */

const SLASH_COMMANDS: Record<string, string> = {
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

export async function sendToClaudeCode(ctx: vscode.ExtensionContext, root: string, instructionId?: string): Promise<SendResult> {
	const instruction = loadCurrentInstruction(root);
	if (!instruction) { void vscode.window.showWarningMessage('RIAF: no instruction compiled yet — ask @riaf something first, or run "RIAF: Compile instruction".'); return { written: [], launched: false }; }
	if (instructionId && instruction.instruction_id !== instructionId) { void vscode.window.showInformationMessage(`RIAF: sending the current instruction ${instruction.instruction_id} (the one you clicked, ${instructionId}, was superseded).`); }
	const pick = await vscode.window.showQuickPick([
		{ label: '$(terminal) Open Claude Code here with this instruction', detail: 'Writes the hook/command/CLAUDE.md files, then runs `claude` in a terminal with the instruction as the first message', action: 'launch' as const },
		{ label: '$(save) Save only', detail: 'Writes .claude/commands/riaf-task.md, riaf-instruction.md and the CLAUDE.md block; nothing is launched', action: 'save' as const },
		{ label: '$(clippy) Copy instruction to clipboard', action: 'copy' as const },
	], { title: `RIAF: Send instruction ${instruction.instruction_id} (${instruction.intent.type}) to Claude Code` });
	if (!pick) { return { written: [], launched: false }; }
	if (pick.action === 'copy') { await vscode.env.clipboard.writeText(instruction.markdown); void vscode.window.showInformationMessage('RIAF: instruction copied.'); return { written: [], launched: false }; }
	const written = writeInstructionForClaude(root, instruction, { pluginDir: join(ctx.extensionPath, 'plugin') });
	if (pick.action === 'save') { void vscode.window.showInformationMessage(`RIAF: instruction ${instruction.instruction_id} written for Claude Code (${written.length} files). In Claude Code run /riaf-instruction.`); return { written, launched: false }; }
	const term = vscode.window.createTerminal({ name: `Claude Code · RIAF ${instruction.instruction_id}`, cwd: root });
	term.show(true);
	term.sendText(claudeLaunchCommand(root), true);
	return { written, launched: true };
}

/** "Wrong intent?" → pick the right type; recorded in .riaf/intent-feedback.jsonl and used by the router next time. */
export async function intentFeedback(root: string, request: string, predicted: IntentType): Promise<void> {
	const pick = await vscode.window.showQuickPick(INTENT_TYPES.filter(t => t !== predicted).map(t => ({ label: t })), { title: `RIAF classified this as "${predicted}". What should it have been?` });
	if (!pick) { return; }
	recordIntentFeedback(root, { request, predicted, corrected: pick.label as IntentType });
	void vscode.window.showInformationMessage(`RIAF: noted — similar requests will route as ${pick.label}.`);
}

export function registerInstructionCommands(ctx: vscode.ExtensionContext, indexes: IndexManager): void {
	ctx.subscriptions.push(
		vscode.commands.registerCommand('riaf.sendToClaudeCode', async (root?: string, id?: string) => {
			const r = root ?? indexes.folderFor(vscode.window.activeTextEditor?.document.uri)?.uri.fsPath;
			if (!r) { return vscode.window.showWarningMessage('RIAF: open a workspace folder first.'); }
			await sendToClaudeCode(ctx, r, id);
		}),
		vscode.commands.registerCommand('riaf.openInstruction', async (root?: string) => {
			const r = root ?? indexes.folderFor(vscode.window.activeTextEditor?.document.uri)?.uri.fsPath;
			if (!r) { return; }
			const p = join(r, '.claude', 'riaf', 'instructions', 'current.md');
			if (!existsSync(p)) { return vscode.window.showWarningMessage('RIAF: no instruction yet.'); }
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(p), { preview: false });
		}),
		vscode.commands.registerCommand('riaf.intentFeedback', async (root: string, request: string, predicted: IntentType) => intentFeedback(root, request, predicted)),
		vscode.commands.registerCommand('riaf.compileInstruction', async () => {
			const folder = indexes.folderFor(vscode.window.activeTextEditor?.document.uri);
			if (!folder) { return vscode.window.showWarningMessage('RIAF: open a workspace folder first.'); }
			const request = await vscode.window.showInputBox({ title: 'RIAF: Compile instruction', prompt: 'Describe the task', ignoreFocusOut: true });
			if (!request) { return; }
			const host = await hostFor(indexes, folder);
			const ed = vscode.window.activeTextEditor;
			const t = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'RIAF: classifying and compiling…' }, () => prepareTurn(host, request, { activeFile: ed ? vscode.workspace.asRelativePath(ed.document.uri, false) : undefined, selection: ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : undefined }));
			const doc = await vscode.workspace.openTextDocument(t.path);
			await vscode.window.showTextDocument(doc, { preview: false });
			const choice = await vscode.window.showInformationMessage(`RIAF: ${formatRouteLine(t.route, { items: t.items, tokens: t.tokens })}`, 'Send to Claude Code');
			if (choice) { await sendToClaudeCode(ctx, folder.uri.fsPath, t.instruction.instruction_id); }
		}),
	);
}
