import * as vscode from 'vscode';
import { relative } from 'node:path';
import type { ChatMessage } from '@bosch-mps/token-opt';
import { runAgent, type AgentMode } from './agentLoop.js';
import { readSettings } from './config.js';
import type { IndexManager } from './indexManager.js';
import { createTransport } from './modelTransport.js';
import type { UsageMeter } from './usage.js';

/** Per-chat-thread agent history, keyed by the first request's id (VS Code gives no thread id). */
const threads = new WeakMap<object, ChatMessage[]>();

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
		const key = (chatCtx.history[0] as { request?: object })?.request ?? chatCtx.history[0] ?? request;
		const history = threads.get(key) ?? [];

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

		const result = await runAgent({
			transport, index, folder, settings, usage, mode, userPrompt: prompt, history, activeFile, stream, token, log: m => indexes.log(m),
		});
		threads.set(key, result.history);
		return { metadata: { iterations: result.iterations, editedFiles: result.editedFiles, stopped: result.stopped } };
	};

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
