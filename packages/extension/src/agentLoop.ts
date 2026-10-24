import * as vscode from 'vscode';
import type { RiafIndex } from '@bosch-mps/riaf-core';
import {
	buildAgentTailHints, buildCrossQueryFileReadHint, buildEditCompletionHint, buildExplorationBudgetHint,
	buildLargeFileEditHint, buildRepeatEditHint, buildRepeatFileReadHint, buildRepeatReadHint,
	createEditCompletionTracker, createReadOnlyCallCounts, estimateChatHistoryTokens, estimateTokens,
	generateAgentPlan, markPlanItemDoneForTool, needsEditCompletion, prepareMessagesForModel,
	recordFileReadSize, shouldSkipDuplicateFileRead, trackFileEdit, trackFileRead, trackReadOnlyCall,
	URI, generateUuid,
	type ChatMessage, type FileReadRecord, type LLMCallPort, type PlanMessage, type RawToolParamsObj,
} from '@bosch-mps/token-opt';
import type { RiafSettings } from './config.js';
import type { ModelTransport, ToolCall, TransportMessage } from './modelTransport.js';
import { COMMAND_TOOLS, EDIT_TOOLS, READ_ONLY_TOOLS, TOOL_SPECS, executeTool, type ToolContext } from './tools/toolRegistry.js';
import type { UsageMeter } from './usage.js';

export type AgentMode = 'agent' | 'plan' | 'explain' | 'verify';

export interface AgentRunOptions {
	transport: ModelTransport;
	index: RiafIndex;
	folder: vscode.WorkspaceFolder;
	settings: RiafSettings;
	usage: UsageMeter;
	mode: AgentMode;
	userPrompt: string;
	/** Prior turns of this chat thread (token-opt ChatMessage form). */
	history: ChatMessage[];
	/** Workspace-relative path of the active editor, for the contextual profile. */
	activeFile?: string;
	stream: vscode.ChatResponseStream;
	token: vscode.CancellationToken;
	log: (msg: string) => void;
}

export interface AgentRunResult {
	history: ChatMessage[];
	iterations: number;
	editedFiles: string[];
	stopped: 'done' | 'max_iterations' | 'cancelled' | 'error' | 'tool_fail_cap';
}

/* ───────────────────────────── ChatMessage constructors (token-opt shapes) ───────────────────────────── */

const userMsg = (text: string): ChatMessage => ({ role: 'user', content: text, displayContent: text, selections: null, state: { stagingSelections: [], isBeingEdited: false } });
const assistantMsg = (text: string): ChatMessage => ({ role: 'assistant', displayContent: text, reasoning: '', anthropicReasoning: null });
const toolMsg = (call: ToolCall, ok: boolean, content: string): ChatMessage => {
	const rawParams: RawToolParamsObj = Object.fromEntries(Object.entries(call.args).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
	// `params.uri` is what fileReadDedup/agentEditHints/planning key on.
	const p = call.args.filePath ?? call.args.path;
	const params = { ...call.args, ...(typeof p === 'string' ? { uri: URI.file(p) } : {}) };
	return {
		role: 'tool', content, id: call.id, rawParams, name: call.name, params,
		...(ok ? { type: 'success', result: content } : { type: 'tool_error', result: content }),
	} as unknown as ChatMessage;
};

/** token-opt history → transport messages (assistant tool calls are re-attached from the tool messages). */
function toTransportMessages(history: ChatMessage[]): TransportMessage[] {
	const out: TransportMessage[] = [];
	for (const m of history) {
		if (m.role === 'user') { out.push({ role: 'user', text: m.content || '(empty)' }); }
		else if (m.role === 'assistant') { out.push({ role: 'assistant', text: m.displayContent }); }
		else if (m.role === 'tool') {
			const args: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(m.rawParams)) { if (v === undefined) { continue; } try { args[k] = /^[\[{]/.test(v) ? JSON.parse(v) : v; } catch { args[k] = v; } }
			const call: ToolCall = { id: m.id, name: m.name, args };
			const prev = out[out.length - 1];
			if (prev?.role === 'assistant') { (prev.toolCalls ??= []).push(call); }
			else { out.push({ role: 'assistant', text: '', toolCalls: [call] }); }
			out.push({ role: 'tool', toolCallId: m.id, name: m.name, text: m.content });
		}
		// plan / checkpoint / interrupted messages are UI-only — not sent to the model.
	}
	return out;
}

/* ───────────────────────────── system prompt ───────────────────────────── */

const STABLE_SYSTEM = `You are RIAF, a coding agent inside VS Code. You work in a loop: plan → gather context → edit → verify.

Tool policy (token discipline):
- Start with search_codebase or get_context_profile; never read many files blindly.
- Read a file at most once; use get_file_outline or a line range when the file is large.
- Combine all changes to one file into a single edit_file call with several search/replace blocks.
- After editing, run run_tests (or the relevant typecheck/lint) once and fix failures; do not loop on the same failing command.
- Stop when the task is done; summarise what changed in 3-6 lines. Do not restate file contents.
- Paths are workspace-relative. Never invent file paths — find them first.`;

const MODE_SYSTEM: Record<AgentMode, string> = {
	agent: '',
	plan: 'MODE: plan only. Produce a concise numbered plan with the files involved. Do NOT call edit, create, delete or run tools.',
	explain: 'MODE: explain. Use read-only tools to ground your explanation in the actual code, cite paths and line ranges, make no edits.',
	verify: 'MODE: verify. Run the project test/typecheck command(s) and report results; propose (do not apply) fixes.',
};

const toolsForMode = (mode: AgentMode, s: RiafSettings) => TOOL_SPECS.filter(t => {
	if (mode === 'plan' || mode === 'explain') { return READ_ONLY_TOOLS.has(t.name); }
	if (mode === 'verify') { return READ_ONLY_TOOLS.has(t.name) || COMMAND_TOOLS.has(t.name); }
	if (!s.agent.allowRunCommand && COMMAND_TOOLS.has(t.name)) { return false; }
	return true;
});

/* ───────────────────────────── the loop ───────────────────────────── */

export async function runAgent(o: AgentRunOptions): Promise<AgentRunResult> {
	const { transport, settings: s, stream, token, usage } = o;
	const history: ChatMessage[] = [...o.history, userMsg(o.userPrompt)];
	const abort = new AbortController();
	token.onCancellationRequested(() => abort.abort());

	// trackers from token-opt
	const fileReads = new Map<string, FileReadRecord>();
	const fileEditCounts = new Map<string, number>();
	const readCounts = createReadOnlyCallCounts();
	const editCompletion = createEditCompletionTracker();
	seedFileReadsFromHistory(o.history, fileReads);

	const toolCtx: ToolContext = {
		folder: o.folder, index: o.index, requireEditApproval: s.agent.requireEditApproval, allowRunCommand: s.agent.allowRunCommand,
		progress: t => stream.progress(t), token,
	};
	const tools = toolsForMode(o.mode, s);
	const meter = (u: Parameters<UsageMeter['record']>[0] | undefined, purpose: string) => u && usage.record(u, { provider: transport.providerName, model: transport.modelName, purpose });

	// stable system prompt: role + policy + workspace profile (cacheable prefix)
	const profile = await o.index.getContextualProfile(o.activeFile).catch(() => undefined);
	const stableSystem = [STABLE_SYSTEM, MODE_SYSTEM[o.mode], profile?.profileText ? `<workspace_profile>\n${profile.profileText}\n</workspace_profile>` : '',
		profile?.activeFile ? `Active file: ${profile.activeFile}\nRelated: ${profile.relatedFiles.slice(0, 12).join(', ')}\nTests: ${profile.tests.join(', ') || 'none'}` : ''].filter(Boolean).join('\n\n');

	// 1. plan
	let plan: PlanMessage | null = null;
	if (s.agent.generatePlan && o.mode === 'agent') {
		stream.progress('Planning…');
		const callLLM: LLMCallPort = async req => {
			const r = await transport.call({ systemMessage: req.systemMessage, messages: toTransportMessages(req.messages), maxOutputTokens: req.maxOutputTokens, signal: req.signal });
			return { text: r.text, usage: r.usage };
		};
		plan = await generateAgentPlan({
			callLLM, usageMeter: usage, chatMessages: history, chatMode: 'agent', threadId: generateUuid(),
			modelSelection: { providerName: transport.providerName, modelName: transport.modelName }, signal: abort.signal, timeoutMs: 30_000,
		}).catch(e => { o.log(`plan failed: ${e}`); return null; });
		if (plan) { history.push(plan); renderPlan(stream, plan); }
	}

	// 2. iterate
	const editedFiles = new Set<string>();
	let consecutiveFails = 0;
	let iterations = 0;
	let verified = false;
	let stopped: AgentRunResult['stopped'] = 'done';
	let editNudges = 0;

	while (iterations < s.agent.maxIterations) {
		if (token.isCancellationRequested) { stopped = 'cancelled'; break; }
		iterations++;

		// budget: compact stale tool results, trim oldest, keep the protected tail
		const before = estimateChatHistoryTokens({ chatMessages: history, systemMessage: stableSystem, aiInstructions: '' });
		const prepared = prepareMessagesForModel({
			messages: history, contextWindow: Math.floor(transport.contextWindow * (s.agent.contextWindowRatio / 0.85)),
			reservedOutputTokens: transport.maxOutputTokens, chatMode: 'agent', fileReads, systemMessage: stableSystem, providerName: transport.providerName,
		});
		usage.recordSaved(Math.max(0, before - prepared.estimatedTokens));
		if (prepared.trimmed || prepared.compacted) { o.log(`budget: trimmed=${prepared.trimmed} compacted=${prepared.compacted} est=${prepared.estimatedTokens}`); }

		// volatile hints (never in the cached prefix)
		const volatile = buildAgentTailHints({
			repeatEditHint: buildRepeatEditHint(fileEditCounts),
			repeatReadHint: buildRepeatReadHint(readCounts),
			repeatFileReadHint: buildRepeatFileReadHint(fileReads),
			largeFileEditHint: buildLargeFileEditHint(fileReads),
			explorationBudgetHint: buildExplorationBudgetHint(readCounts, s.agent.maxReadOnlyCalls),
			editCompletionHint: editCompletion.interruptedEditTool || editCompletion.truncatedEditTool ? buildEditCompletionHint(editCompletion) : '',
			crossQueryFileReadHint: buildCrossQueryFileReadHint(fileReads, iterations),
		});
		const planText = plan ? `\n\nPlan status:\n${plan.items.map(i => `- [${i.status === 'done' ? 'x' : ' '}] ${i.text}`).join('\n')}` : '';

		let res;
		try {
			res = await transport.call({
				systemMessage: stableSystem, volatileSystemMessage: (volatile + planText).trim() || undefined,
				messages: toTransportMessages(prepared.messages), tools, signal: abort.signal,
				onText: delta => stream.markdown(delta),
			});
		} catch (e) {
			if (token.isCancellationRequested) { stopped = 'cancelled'; break; }
			stream.markdown(`\n\n⚠️ model call failed: ${(e as Error).message}`);
			o.log(`model error: ${(e as Error).stack ?? e}`);
			stopped = 'error'; break;
		}
		meter(res.usage, `agent:${o.mode}`);
		if (res.text) { history.push(assistantMsg(res.text)); }
		if (res.stopReason === 'length' && res.toolCalls.some(tc => EDIT_TOOLS.has(tc.name))) { editCompletion.truncatedEditTool = true; }

		if (!res.toolCalls.length) {
			// one nudge if the user clearly asked for an edit but none happened
			if (o.mode === 'agent' && editNudges < 1 && needsEditCompletion({ tracker: editCompletion, fileEditCounts, readOnlyCallCount: readCounts.total, userMessage: o.userPrompt, chatMode: 'agent' })) {
				editNudges++;
				history.push(userMsg('You described changes but made no edit_file/rewrite_file/create_file_or_folder call. Apply the changes now using the tools.'));
				continue;
			}
			// auto-verify once after edits
			if (o.mode === 'agent' && s.agent.autoVerify && editedFiles.size && !verified) {
				verified = true;
				stream.progress('Verifying…');
				const call: ToolCall = { id: generateUuid(), name: 'run_tests', args: {} };
				const out = await executeTool('run_tests', {}, toolCtx);
				const text = out.ok ? out.result : out.error;
				history.push(toolMsg(call, out.ok, text));
				stream.markdown(`\n\n**Verification** (${out.ok ? 'passed' : 'failed'}):\n\`\`\`\n${text.slice(0, 1500)}\n\`\`\`\n`);
				if (!out.ok) { history.push(userMsg('Tests/typecheck failed above. Fix the cause with minimal edits, then stop.')); continue; }
			}
			break;
		}

		// 3. execute tool calls
		for (const call of res.toolCalls) {
			if (token.isCancellationRequested) { break; }
			const args = call.args ?? {};
			// read dedup (token-opt)
			if (call.name === 'read_file' && typeof args.filePath === 'string') {
				const uri = URI.file(String(args.filePath));
				const skip = shouldSkipDuplicateFileRead(fileReads, uri, numOrNull(args.startLine), numOrNull(args.endLine));
				if (skip.skip) { history.push(toolMsg(call, false, skip.message ?? 'duplicate read skipped — content already in context')); usage.recordSaved(estimateTokens(skip.message ?? '') + 800); continue; }
			}
			trackReadOnlyCall(readCounts, call.name, stringifyParams(args), iterations);
			stream.progress(describeCall(call));

			const out = await executeTool(call.name, args, toolCtx);
			const text = out.ok ? out.result : `ERROR: ${out.error}`;
			history.push(toolMsg(call, out.ok, text));
			stream.markdown(`\n\n> ${out.ok ? '✅' : '❌'} \`${describeCall(call)}\`${out.ok ? '' : ` — ${out.error.split('\n')[0].slice(0, 160)}`}\n`);

			if (out.ok) {
				consecutiveFails = 0;
				if (call.name === 'read_file' && out.meta) {
					trackFileRead(fileReads, URI.file(String(args.filePath)), numOrNull(args.startLine), numOrNull(args.endLine), Number(out.meta.totalFileLen) || undefined, iterations);
					recordFileReadSize(fileReads, URI.file(String(args.filePath)), Number(out.meta.totalFileLen) || 0);
				}
				if (EDIT_TOOLS.has(call.name)) {
					const p = String(args.filePath ?? args.path ?? '');
					trackFileEdit(fileEditCounts, call.name, { uri: URI.file(p) });
					editedFiles.add(p);
					verified = false;
					stream.reference(vscode.Uri.joinPath(o.folder.uri, p));
				}
				if (plan) { plan = markPlanItemDoneForTool(plan, call.name, { ...args, uri: URI.file(String(args.filePath ?? args.path ?? '')) } as never); }
			} else {
				consecutiveFails++;
				if (EDIT_TOOLS.has(call.name) && /rejected/.test(out.error)) { /* developer said no — not a failure of the model */ consecutiveFails--; }
				if (consecutiveFails >= 3) { stream.markdown('\n\n⚠️ three consecutive tool failures — stopping.'); stopped = 'tool_fail_cap'; break; }
			}
		}
		if (stopped !== 'done') { break; }
	}
	if (iterations >= s.agent.maxIterations && stopped === 'done') { stopped = 'max_iterations'; stream.markdown(`\n\n⚠️ reached the iteration cap (${s.agent.maxIterations}).`); }
	if (plan) { renderPlan(stream, plan, true); }

	const t = usage.session;
	stream.markdown(`\n\n<sub>${iterations} iteration${iterations === 1 ? '' : 's'} · ${t.inputTokens.toLocaleString()} in / ${t.outputTokens.toLocaleString()} out · ${t.savedTokens.toLocaleString()} tokens saved by RIAF this session</sub>`);
	return { history, iterations, editedFiles: [...editedFiles], stopped };
}

/* ───────────────────────────── helpers ───────────────────────────── */

const numOrNull = (v: unknown): number | null => (v === undefined || v === null || v === '') ? null : Number(v);
const stringifyParams = (args: Record<string, unknown>): RawToolParamsObj => Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));

function describeCall(call: ToolCall): string {
	const a = call.args ?? {};
	const main = a.filePath ?? a.path ?? a.query ?? a.command ?? a.dirPath ?? '';
	return `${call.name}${main ? ` ${String(main).slice(0, 80)}` : ''}`;
}

function renderPlan(stream: vscode.ChatResponseStream, plan: PlanMessage, final = false): void {
	stream.markdown(`\n\n**${final ? 'Plan — final status' : 'Plan'}**\n${plan.items.map(i => `- [${i.status === 'done' ? 'x' : ' '}] ${i.text}${i.status === 'skipped' ? ' _(skipped)_' : ''}`).join('\n')}\n\n`);
}

/** Carry read history across turns so a second turn doesn't re-read what is already in context. */
function seedFileReadsFromHistory(history: ChatMessage[], fileReads: Map<string, FileReadRecord>): void {
	for (const m of history) {
		if (m.role === 'tool' && m.name === 'read_file' && m.type === 'success') {
			const p = m.rawParams.filePath; if (!p) { continue; }
			trackFileRead(fileReads, URI.file(p), numOrNull(m.rawParams.startLine), numOrNull(m.rawParams.endLine), undefined, 0);
		}
	}
}
