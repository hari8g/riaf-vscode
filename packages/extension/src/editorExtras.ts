import * as vscode from 'vscode';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runAgent } from './agentLoop.js';
import { readSettings } from './config.js';
import type { IndexManager } from './indexManager.js';
import { buildFimPrompt } from './fim.js';
import { createTransport, type ModelTransport } from './modelTransport.js';
import type { UsageMeter } from './usage.js';

const exec = promisify(execFile);

/** Commit message, quick edit, inline completions and notepads. Completions stay off until a model id is set. */
export function registerEditorExtras(ctx: vscode.ExtensionContext, indexes: IndexManager, usage: UsageMeter, getTransport: () => ModelTransport | undefined): void {
	ctx.subscriptions.push(
		vscode.commands.registerCommand('riaf.commitMessage', () => writeCommitMessage(indexes, getTransport)),
		vscode.commands.registerCommand('riaf.quickEdit', () => quickEdit(indexes, usage, getTransport)),
		vscode.commands.registerCommand('riaf.newNote', () => newNote()),
		vscode.languages.registerCodeActionsProvider('*', {
			provideCodeActions(doc, range) {
				if (range.isEmpty || doc.uri.scheme !== 'file') { return []; }
				const action = new vscode.CodeAction('RIAF: Edit selection', vscode.CodeActionKind.RefactorRewrite);
				action.command = { command: 'riaf.quickEdit', title: 'RIAF: Edit selection' };
				return [action];
			},
		}),
		vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, {
			async provideInlineCompletionItems(doc, pos, _ctx, token) {
				const model = readSettings().models.autocomplete;
				if (!model || token.isCancellationRequested) { return []; }
				const transport = getTransport() ?? await createTransport(undefined, model);
				if (!transport) { return []; }
				const prefix = doc.getText(new vscode.Range(new vscode.Position(Math.max(0, pos.line - 30), 0), pos)).slice(-2000);
				const suffix = doc.getText(new vscode.Range(pos, new vscode.Position(Math.min(doc.lineCount - 1, pos.line + 15), 0))).slice(0, 800);
				let context = '';
				try {
					const folder = indexes.folderFor(doc.uri);
					if (folder) {
						const profile = await (await indexes.get(folder)).getContextualProfile(vscode.workspace.asRelativePath(doc.uri));
						context = [...profile.relatedFiles.slice(0, 8), ...profile.tests.slice(0, 4)].join('\n');
					}
				} catch { context = ''; }
				try {
					const r = await transport.call({
						systemMessage: 'Complete the code at <fim_middle>. Reply with only the text that should be inserted. No fences.',
						messages: [{ role: 'user', text: buildFimPrompt({ prefix, suffix, context }) }],
						maxOutputTokens: 128,
					});
					const insert = r.text.replace(/^```[a-z]*\n?|```$/g, '').trim();
					if (!insert || token.isCancellationRequested) { return []; }
					return [new vscode.InlineCompletionItem(insert)];
				} catch { return []; }
			},
		}),
	);
}

async function writeCommitMessage(indexes: IndexManager, getTransport: () => ModelTransport | undefined): Promise<void> {
	const folder = indexes.folderFor();
	if (!folder) { void vscode.window.showErrorMessage('RIAF: open a folder first.'); return; }
	const diff = await exec('git', ['diff', '--cached', '--stat'], { cwd: folder.uri.fsPath }).then(r => r.stdout, () => '');
	const body = diff.trim() || await exec('git', ['diff', '--stat'], { cwd: folder.uri.fsPath }).then(r => r.stdout, () => '');
	if (!body.trim()) { void vscode.window.showInformationMessage('RIAF: nothing to summarise. Stage a change first.'); return; }
	const transport = getTransport() ?? await createTransport(undefined, readSettings().models.commit || undefined);
	if (!transport) { void vscode.window.showErrorMessage('RIAF: no model available.'); return; }
	const r = await transport.call({
		systemMessage: 'Write a one-line git commit subject, imperative mood, at most 72 characters. Reply with that line only.',
		messages: [{ role: 'user', text: body.slice(0, 4000) }],
		maxOutputTokens: 40,
	});
	const message = r.text.trim().split('\n')[0].replace(/^["']|["']$/g, '');
	const git = vscode.extensions.getExtension('vscode.git')?.exports?.getAPI?.(1);
	const repo = git?.repositories?.find((rp: { rootUri: vscode.Uri }) => rp.rootUri.fsPath === folder.uri.fsPath) ?? git?.repositories?.[0];
	if (repo?.inputBox) { repo.inputBox.value = message; }
	else { void vscode.window.showInformationMessage(message); }
}

async function quickEdit(indexes: IndexManager, usage: UsageMeter, getTransport: () => ModelTransport | undefined): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	const folder = indexes.folderFor(editor?.document.uri);
	if (!editor || !folder) { return; }
	const selection = editor.document.getText(editor.selection);
	if (!selection.trim()) { void vscode.window.showInformationMessage('RIAF: select the code to edit.'); return; }
	const instruction = await vscode.window.showInputBox({ title: 'RIAF: Edit selection', prompt: 'What should change?', ignoreFocusOut: true });
	if (!instruction) { return; }
	const transport = getTransport() ?? await createTransport();
	if (!transport) { return; }
	const index = await indexes.get(folder);
	const rel = vscode.workspace.asRelativePath(editor.document.uri);
	const settings = readSettings();
	settings.agent.generatePlan = false;
	await runAgent({
		transport, index, folder, settings, usage, mode: 'agent',
		userPrompt: buildFimPrompt({ prefix: selection, suffix: '', instruction: `Edit only this selection in ${rel}. ${instruction}`, context: rel }),
		history: [], stream: { markdown() { }, progress() { } } as unknown as vscode.ChatResponseStream, token: new vscode.CancellationTokenSource().token,
		log: m => indexes.log(m), memoryHome: homedir(),
	});
}

async function newNote(): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) { return; }
	const title = await vscode.window.showInputBox({ title: 'RIAF notepad', prompt: 'Note name', value: 'note' });
	if (!title) { return; }
	const safe = title.replace(/[^A-Za-z0-9._-]/g, '-');
	const dir = join(folder.uri.fsPath, '.riaf', 'notes');
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${safe}.md`);
	try { writeFileSync(path, `# ${title}\n\n`, { flag: 'wx' }); } catch { /* already there */ }
	const doc = await vscode.workspace.openTextDocument(path);
	await vscode.window.showTextDocument(doc);
}
