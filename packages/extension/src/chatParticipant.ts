import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { generateUuid, type ChatMessage } from '@bosch-mps/token-opt';
import { runAgent, type AgentMode } from './agentLoop.js';
import { CheckpointStore } from './checkpoints.js';
import { readSettings } from './config.js';
import type { IndexManager } from './indexManager.js';
import { createTransport } from './modelTransport.js';
import { readRules, rulesForPrompt } from './rules.js';
import type { UsageMeter } from './usage.js';

/**
 * Per-chat-thread agent history (with tool results), keyed by a thread id we stash in each
 * response's `metadata`. VS Code gives no thread id, but it does hand back prior turns' result
 * metadata in `context.history`, so the id survives across turns of the same chat.
 */
type Thread = {
	history: ChatMessage[];
	/** history as it stood *before* each user turn (index 0 = before turn 1) — for conversation rewind */
	turnStarts: ChatMessage[][];
	root: string;
};
const threads = new Map<string, Thread>();
const MAX_THREADS = 32;
const stores = new Map<string, CheckpointStore>();

const checkpointDir = (ctx: vscode.ExtensionContext) => join(ctx.globalStorageUri.fsPath, 'checkpoints');
const storeFor = (ctx: vscode.ExtensionContext, root: string): CheckpointStore => {
	let s = stores.get(root);
	if (!s) { s = new CheckpointStore(join(checkpointDir(ctx), createHash('sha1').update(root).digest('hex').slice(0, 12)), root); stores.set(root, s); }
	return s;
};

/** Pure part of `riaf.rewind`, shared with tests: roll files and/or the agent history back to before `turn`. */
export function rewindThread(store: CheckpointStore, thread: Thread | undefined, threadId: string, turn: number, what: 'files' | 'conversation' | 'both') {
	const cps = store.list(threadId).filter(c => c.turn >= turn);
	const files = what === 'conversation' ? undefined : store.rewindFiles(cps);
	if (what !== 'files' && thread && thread.turnStarts[turn - 1]) {
		thread.history = thread.turnStarts[turn - 1];
		thread.turnStarts.length = turn - 1;
	}
	return { files, checkpoints: cps.length };
}

function threadIdFromHistory(history: ReadonlyArray<unknown>): string | undefined {
	for (let i = history.length - 1; i >= 0; i--) {
		const md = (history[i] as { result?: { metadata?: { threadId?: unknown } } }).result?.metadata;
		if (typeof md?.threadId === 'string') { return md.threadId; }
	}
	return undefined;
}

export function registerChatParticipant(ctx: vscode.ExtensionContext, indexes: IndexManager, usage: UsageMeter): void {
	const handler: vscode.ChatRequestHandler = async (request, chatCtx, stream, token) => {
		const settings = readSettings();
		const folder = indexes.folderFor(vscode.window.activeTextEditor?.document.uri);
		if (!folder) { stream.markdown('Open a folder first — RIAF indexes a workspace.'); return {}; }

		const mode: AgentMode = (['plan', 'explain', 'verify'] as const).find(c => c === request.command) ?? 'agent';
		if (request.command === 'reindex') {
			stream.progress('Reindexing…');
			const stats = await indexes.reindex(folder, true);
			stream.markdown(stats ? `Reindexed **${folder.name}**: ${JSON.stringify(stats)}` : 'Reindex failed — see the RIAF output channel.');
			return {};
		}

		// Prefer the model the user picked in the chat model dropdown; fall back to settings/gateway.
		const transport = await createTransport(request.model);
		if (!transport) {
			stream.markdown('No language model available. Sign in to Copilot, or set `riaf.gateway.url` + `riaf.gateway.model` to use the internal gateway.');
			return {};
		}

		const index = await indexes.get(folder);
		if (!index.getStatus().indexed) {
			stream.progress('First run — indexing the workspace…');
			await indexes.reindex(folder);
		}

		// history: VS Code hands us prior turns; we keep our richer tool history keyed on the thread.
		const threadId = threadIdFromHistory(chatCtx.history) ?? generateUuid();
		const thread = threads.get(threadId) ?? { history: [], turnStarts: [], root: folder.uri.fsPath };
		const history = thread.history;
		// checkpoint for this turn: the first write to each file snapshots its original (RIAF: Rewind)
		thread.turnStarts.push([...history]);
		const turn = thread.turnStarts.length;
		const store = storeFor(ctx, folder.uri.fsPath);
		const checkpoint = settings.agent.checkpoints && mode !== 'plan' && mode !== 'explain' ? { store, current: store.begin(threadId, turn, request.prompt) } : undefined;

		const active = vscode.window.activeTextEditor?.document.uri;
		const activeFile = active && vscode.workspace.getWorkspaceFolder(active)?.uri.fsPath === folder.uri.fsPath
			? relative(folder.uri.fsPath, active.fsPath).split('\\').join('/') : undefined;

		// #file / #selection references the user attached in the prompt
		const refs = request.references.map(r => {
			const v = r.value as unknown;
			if (v instanceof vscode.Uri) { return `Attached file: ${relative(folder.uri.fsPath, v.fsPath)}`; }
			if (v instanceof vscode.Location) { return `Attached range: ${relative(folder.uri.fsPath, v.uri.fsPath)}:${v.range.start.line + 1}-${v.range.end.line + 1}`; }
			return typeof v === 'string' ? v : '';
		}).filter(Boolean);
		const prompt = [request.prompt, ...refs].join('\n');

		const rules = rulesForPrompt(await readRules(folder));
		const result = await runAgent({
			transport, index, folder, settings, usage, mode, userPrompt: prompt, history, activeFile, rules, stream, token, log: m => indexes.log(m), checkpoint,
		});
		thread.history = result.history;
		threads.delete(threadId); threads.set(threadId, thread);                 // re-insert → most recent last
		if (threads.size > MAX_THREADS) { threads.delete(threads.keys().next().value!); }
		if (checkpoint && Object.keys(checkpoint.current.files).length) {
			stream.markdown(`\n\n_Checkpoint saved for ${Object.keys(checkpoint.current.files).length} file(s) — **RIAF: Rewind** restores them._`);
		}
		return { metadata: { threadId, iterations: result.iterations, editedFiles: result.editedFiles, stopped: result.stopped } };
	};

	ctx.subscriptions.push(vscode.commands.registerCommand('riaf.rewind', async () => {
		const folder = indexes.folderFor(vscode.window.activeTextEditor?.document.uri);
		if (!folder) { return vscode.window.showErrorMessage('RIAF: open a folder first.'); }
		const store = storeFor(ctx, folder.uri.fsPath);
		const cps = store.list();
		if (!cps.length) { return vscode.window.showInformationMessage('RIAF: no checkpoints — the agent has not edited files in this workspace yet.'); }
		const pick = await vscode.window.showQuickPick(cps.map(c => ({
			label: `Turn ${c.turn}: ${c.label || '(no prompt)'}`,
			description: new Date(c.createdAt).toLocaleString(),
			detail: `${Object.keys(c.files).length} file(s): ${Object.keys(c.files).slice(0, 6).join(', ')}${Object.keys(c.files).length > 6 ? ', …' : ''}`,
			cp: c,
		})), { placeHolder: 'Rewind to before which turn? (files edited in that turn and later are restored)' });
		if (!pick) { return; }
		const what = await vscode.window.showQuickPick([
			{ label: 'Files', description: 'restore files only; keep the conversation', what: 'files' as const },
			{ label: 'Files and conversation', description: 'also forget the agent history from that turn on', what: 'both' as const },
			{ label: 'Conversation', description: 'forget the agent history from that turn on; keep files', what: 'conversation' as const },
		], { placeHolder: 'What to rewind' });
		if (!what) { return; }
		const r = rewindThread(store, threads.get(pick.cp.threadId), pick.cp.threadId, pick.cp.turn, what.what);
		const parts: string[] = [];
		if (r.files) {
			parts.push(`${r.files.restored.length} restored, ${r.files.deleted.length} deleted${r.files.failed.length ? `, ${r.files.failed.length} failed` : ''}`);
			for (const rel of [...r.files.restored]) { const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === join(folder.uri.fsPath, rel)); if (doc?.isDirty) { indexes.log(`rewind: ${rel} had unsaved edits in the editor; disk was restored`); } }
		}
		if (what.what !== 'files') { parts.push('conversation rolled back (VS Code still shows the old turns; the agent no longer remembers them)'); }
		indexes.log(`rewind thread ${pick.cp.threadId} to turn ${pick.cp.turn} (${what.what}): ${parts.join('; ')}`);
		void vscode.window.showInformationMessage(`RIAF rewind → turn ${pick.cp.turn}: ${parts.join('; ')}`);
	}));

	const participant = vscode.chat.createChatParticipant('riaf.agent', handler);
	participant.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.png');
	participant.followupProvider = {
		provideFollowups(result) {
			const md = result.metadata as { editedFiles?: string[]; stopped?: string } | undefined;
			const f: vscode.ChatFollowup[] = [];
			if (md?.editedFiles?.length) { f.push({ prompt: 'Run the tests and fix anything that fails', label: 'Verify', command: 'verify' }); }
			if (md?.stopped === 'max_iterations') { f.push({ prompt: 'Continue where you left off', label: 'Continue' }); }
			return f;
		},
	};
	ctx.subscriptions.push(participant);
}
