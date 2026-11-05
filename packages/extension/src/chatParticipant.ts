import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { generateUuid, type ChatMessage } from '@bosch-mps/token-opt';
import { readdirSync, readFileSync } from 'node:fs';
import { buildContextMarkdown } from './contextDoc.js';
import { handleEngineCommand } from './engineHost.js';
import { formatNotes, selectNotes } from './notes.js';
import { runAgent, type AgentMode } from './agentLoop.js';
import { CheckpointStore } from './checkpoints.js';
import { readSettings } from './config.js';
import type { IndexManager } from './indexManager.js';
import { createTransport } from './modelTransport.js';
import { readRules, rulesForPrompt } from './rules.js';
import { loadThread, saveThread } from './threadStore.js';
import type { UsageMeter } from './usage.js';
import { hostFor, planGateApplies, prepareTurn, renderCard, registerInstructionCommands, type PreparedTurn } from './instructionFlow.js';
import { loadCurrentInstruction } from '@bosch-mps/riaf-core';

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
const threadsDir = (ctx: vscode.ExtensionContext, root: string) => join(ctx.globalStorageUri.fsPath, 'threads', createHash('sha1').update(root).digest('hex').slice(0, 12));
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

function readNotes(root: string): { name: string; text: string }[] {
	try {
		const dir = join(root, '.riaf', 'notes');
		return readdirSync(dir).filter(name => name.endsWith('.md')).map(name => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
	} catch { return []; }
}

export function registerChatParticipant(ctx: vscode.ExtensionContext, indexes: IndexManager, usage: UsageMeter): void {
	const handler: vscode.ChatRequestHandler = async (request, chatCtx, stream, token) => {
		const settings = readSettings();
		const folder = indexes.folderFor(vscode.window.activeTextEditor?.document.uri);
		if (!folder) { stream.markdown('Open a folder first — RIAF indexes a workspace.'); return {}; }

		const mode: AgentMode = (['plan', 'explain', 'verify'] as const).find(c => c === request.command) ?? 'agent';
		if (request.command === 'run' || request.command === 'status' || request.command === 'resume') {
			const transport = await createTransport(request.model);
			if (!transport) { stream.markdown('No language model available.'); return {}; }
			const planTransport = settings.models.plan ? await createTransport(request.model, settings.models.plan) ?? transport : transport;
			const criticTransport = settings.models.critic ? await createTransport(request.model, settings.models.critic) ?? planTransport : planTransport;
			const root = folder.uri.fsPath;
			const result = await handleEngineCommand({
				command: request.command, repo: root, goal: request.prompt,
				markdown: s => stream.markdown(s), progress: s => stream.progress(s),
				callLLM: async (system, user) => {
					const chosen = system.startsWith('You review') ? criticTransport : planTransport;
					const r = await chosen.call({ systemMessage: system, messages: [{ role: 'user', text: user }] });
					return { text: r.text, inputTokens: r.usage?.inputTokens, outputTokens: r.usage?.outputTokens };
				},
				env: {
					readFile: async path => { try { return readFileSync(join(root, path), 'utf8'); } catch { return null; } },
					diagnostics: async path => {
						const uri = vscode.Uri.joinPath(folder.uri, path);
						return vscode.languages.getDiagnostics(uri).map(d => ({ message: d.message, severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warn' }));
					},
				},
				runSubtask: async (_subtask, context) => {
					const index = await indexes.get(folder);
					const quiet = { ...settings, agent: { ...settings.agent, generatePlan: false, autoVerify: false } };
					const ran = await runAgent({ transport, index, folder, settings: quiet, usage, mode: 'agent', userPrompt: context, history: [], stream, token, log: m => indexes.log(m), memoryHome: homedir() });
					return { ok: ran.stopped === 'done', digest: ran.editedFiles.map(f => `edit ${f}`), notes: ran.stopped, spend: undefined };
				},
			});
			return { metadata: { engine: result } };
		}
		if (request.command === 'analyse') {
			const index = await indexes.get(folder);
			const report = await index.getIndexingReport();
			const summaryTransport = settings.models.summary ? await createTransport(request.model, settings.models.summary) ?? undefined : undefined;
			const text = await buildContextMarkdown({ name: folder.name, report, transport: summaryTransport });
			const path = join(folder.uri.fsPath, `${folder.name}_context.md`);
			const { writeFileSync } = await import('node:fs');
			writeFileSync(path, text);
			stream.markdown(`Wrote **${folder.name}_context.md** (${text.length} characters).`);
			return {};
		}
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
		const tdir = threadsDir(ctx, folder.uri.fsPath);
		const thread = threads.get(threadId) ?? loadThread(tdir, threadId) ?? { history: [], turnStarts: [], root: folder.uri.fsPath };
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
		const notes = formatNotes(selectNotes(request.prompt, readNotes(folder.uri.fsPath)));
		const prompt = [request.prompt, ...refs, notes].filter(Boolean).join('\n');

		const rules = rulesForPrompt(await readRules(folder));

		// RIAF 2.0: classify → compile → Prompt Instruction before any model loop (Designs A/B).
		let effectiveMode: AgentMode = mode;
		let prepared: PreparedTurn | undefined;
		let gated = false;
		const lastMeta = chatCtx.history.length ? (chatCtx.history[chatCtx.history.length - 1] as { result?: { metadata?: { planGated?: boolean; instructionId?: string } } }).result?.metadata : undefined;
		const implementingGatedPlan = !!lastMeta?.planGated && /^(implement|go ahead|continue|do it|proceed)/i.test(request.prompt.trim());
		if (settings.instruction.intentRouting && !implementingGatedPlan) {
			const host = await hostFor(indexes, folder, transport);
			const selection = vscode.window.activeTextEditor && !vscode.window.activeTextEditor.selection.isEmpty ? vscode.window.activeTextEditor.document.getText(vscode.window.activeTextEditor.selection) : undefined;
			const route = await host.route(request.prompt, { command: request.command, activeFile, selection });
			if (route.askFirst) {
				stream.markdown(`Before I start, I need to know (${route.type}, confidence ${route.confidence}):\n${route.questions.map(q => `- ${q}`).join('\n')}\n\n_Answer in the next message, or use /plan, /explain or /verify to force a mode._`);
				thread.turnStarts.pop();
				return { metadata: { threadId, askedFirst: true } };
			}
			stream.progress(`RIAF: ${route.type} (${route.confidence}) — compiling the context pack…`);
			prepared = await prepareTurn(host, request.prompt, { command: request.command, activeFile, selection }).catch(e => { indexes.log(`instruction failed: ${String(e)}`); return undefined; });
			if (prepared) {
				if (!request.command) { effectiveMode = route.mode; }
				gated = effectiveMode === 'agent' && planGateApplies(route, settings);
				if (gated) { effectiveMode = 'plan'; }
				if (settings.instruction.showCard) { renderCard(stream, prepared, folder, { gated }); }
				if (!settings.instruction.autoRun && effectiveMode !== 'plan' && effectiveMode !== 'explain') {
					stream.markdown('_`riaf.instruction.autoRun` is off: review the instruction, then send `@riaf go` to run it here, or send it to Claude Code._');
					thread.turnStarts.pop();
					return { metadata: { threadId, instructionId: prepared.instruction.instruction_id, awaitingGo: true } };
				}
			}
		}
		const goWithCurrent = /^(go|run it|run here)$/i.test(request.prompt.trim()) ? loadCurrentInstruction(folder.uri.fsPath) : null;
		const prelude = prepared?.instruction.markdown ?? goWithCurrent?.markdown ?? (implementingGatedPlan ? loadCurrentInstruction(folder.uri.fsPath)?.markdown : undefined);
		const result = await runAgent({
			transport, index, folder, settings, usage, mode: effectiveMode, userPrompt: prompt, history, activeFile, rules, stream, token, log: m => indexes.log(m), checkpoint,
			memoryHome: homedir(),
			contextPrelude: prelude,
			exploreLane: prepared && settings.instruction.exploreLane && effectiveMode !== 'explain' && effectiveMode !== 'verify'
				? { task: `${request.prompt}\n\nFind the exact files, symbols and line ranges involved; confirm or correct the plan steps: ${prepared.instruction.plan.map((s, i) => `${i + 1}. ${s}`).join('; ')}` }
				: undefined,
		});
		thread.history = result.history;
		threads.delete(threadId); threads.set(threadId, thread);                 // re-insert → most recent last
		saveThread(tdir, threadId, thread);
		if (threads.size > MAX_THREADS) { threads.delete(threads.keys().next().value!); }
		if (checkpoint && Object.keys(checkpoint.current.files).length) {
			stream.markdown(`\n\n_Checkpoint saved for ${Object.keys(checkpoint.current.files).length} file(s) — **RIAF: Rewind** restores them._`);
		}
		return { metadata: { threadId, iterations: result.iterations, editedFiles: result.editedFiles, stopped: result.stopped, planGated: gated, instructionId: prepared?.instruction.instruction_id, intent: prepared?.route.type } };
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
		const rewound = threads.get(pick.cp.threadId);
		if (rewound) { saveThread(threadsDir(ctx, folder.uri.fsPath), pick.cp.threadId, rewound); }
		indexes.log(`rewind thread ${pick.cp.threadId} to turn ${pick.cp.turn} (${what.what}): ${parts.join('; ')}`);
		void vscode.window.showInformationMessage(`RIAF rewind → turn ${pick.cp.turn}: ${parts.join('; ')}`);
	}));

	registerInstructionCommands(ctx, indexes);
	const participant = vscode.chat.createChatParticipant('riaf.agent', handler);
	participant.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.png');
	participant.followupProvider = {
		provideFollowups(result) {
			const md = result.metadata as { editedFiles?: string[]; stopped?: string; planGated?: boolean; awaitingGo?: boolean } | undefined;
			const f: vscode.ChatFollowup[] = [];
			if (md?.planGated) { f.push({ prompt: 'Implement the plan', label: 'Implement the plan' }); }
			if (md?.awaitingGo) { f.push({ prompt: 'go', label: 'Run here' }); }
			if (md?.editedFiles?.length) { f.push({ prompt: 'Run the tests and fix anything that fails', label: 'Verify', command: 'verify' }); }
			if (md?.stopped === 'max_iterations') { f.push({ prompt: 'Continue where you left off', label: 'Continue' }); }
			return f;
		},
	};
	ctx.subscriptions.push(participant);
}
