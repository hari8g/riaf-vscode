import * as vscode from 'vscode';
import type { RiafIndex } from '@bosch-mps/riaf-core';
import {
	buildAgentTailHints, buildCrossQueryFileReadHint, buildEditCompletionHint, buildExplorationBudgetHint,
	buildLargeFileEditHint, buildRepeatEditHint, buildRepeatFileReadHint, buildRepeatReadHint,
	buildSandboxVerificationHint, createEditCompletionTracker, createReadOnlyCallCounts, createSandboxVerificationTracker,
	discoverAdditionalReadTools, estimateChatHistoryTokens, estimateTokens,
	formatRateLimitCooldownMessage, getAgentInputTokenCap, getAgentLoopLimits, getLatestPlanMessage, getLLMRetryDelayMs, getLlmStreamStallTimeoutMs, getMaxLLMRetryAttempts, getProviderRateLimitCooldownMs,
	hasKnownPricing, invalidateFileRead, isCompactableToolName, isLikelyOutputTruncated, isRateLimitLLMError, isReadOnlyBatchTool, isStreamStallLLMError,
	markInterruptedEditTool, markPlanItemDoneForTool, markSandboxCodeChange, markTruncatedEditTool, needsEditCompletion, needsSandboxVerification, PRICING_TABLE_DATE, prepareMessagesForModel,
	recordFileReadSize, recordProviderRateLimitHit, resolveAgentPlanForRun, shouldForceAggressiveTrimOnRetry, shouldGenerateAgentPlan, shouldSkipDuplicateFileRead, shouldUseParallelReadBatching, skipRemainingPlanItems, summarizeThreadMiddle, trackFileEdit, trackFileRead, trackReadOnlyCall,
	URI, generateUuid,
	type ChatMessage, type FileReadRecord, type LLMCallPort, type LLMErrorLike, type PlanMessage, type RawToolParamsObj, type WorkspaceProfile,
} from '@bosch-mps/token-opt';
import { profileCharCap, toGlobalSettings } from './agentLimits.js';
import { appendMemory, extractRememberedFact, memoryPromptBlock, readMemory } from './memory.js';
import type { RiafSettings } from './config.js';
import type { ModelTransport, ToolCall, TransportMessage } from './modelTransport.js';
import { COMMAND_TOOLS, EDIT_TOOLS, READ_ONLY_TOOLS, TOOL_SPECS, executeTool, integrationToolSpecs, type ToolContext } from './tools/toolRegistry.js';
import { listAgentMcpTools } from './mcpClient.js';
import { createTransport } from './modelTransport.js';
import { loadHooks } from './tools/hooks.js';
import { loadProjectRules } from './projectRules.js';
import type { Checkpoint, CheckpointStore } from './checkpoints.js';
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
	/** Contents of .riafrules (project rules), already wrapped by rulesForPrompt. */
	rules?: string;
	stream: vscode.ChatResponseStream;
	token: vscode.CancellationToken;
	log: (msg: string) => void;
	/** Base delay for transient model-error retries (tests pass a small value). */
	retryDelayMs?: number;
	/** Pre-edit snapshots for this turn (RIAF: Rewind). */
	checkpoint?: { store: CheckpointStore; current: Checkpoint };
	/** How long to wait for language-server diagnostics after an edit (overrides the setting; tests pass 0). */
	diagnosticsSettleMs?: number;
	/** Override the stall watchdog (tests). Production uses the clamped setting. */
	stallTimeoutMs?: number;
	/** Directory whose `.riaf/memory.md` is read and, for "remember that", written. Absent in tests. */
	memoryHome?: string;
	/** Explicit memory text. When omitted and memoryHome is set, the file is read. */
	memoryText?: string;
}

/** How many times an empty / cut-off model response is nudged before the run ends visibly. */
const MAX_EMPTY_RESPONSE_NUDGES = 2;
const DEFAULT_RETRY_DELAY_MS = 2_000;

export interface AgentRunResult {
	history: ChatMessage[];
	iterations: number;
	editedFiles: string[];
	stopped: 'done' | 'max_iterations' | 'cancelled' | 'error' | 'tool_fail_cap' | 'budget';
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
		// compactStaleToolResults only touches messages flagged compactable.
		compactable: isCompactableToolName(call.name),
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
- Start with search_codebase (concepts) or grep (exact identifiers, error strings, every call site) plus glob to find files; never read many files blindly.
- For questions about services, REST routes, library consumers, config per environment, infrastructure or CI, use the org tools (get_service_topology, resolve_api_contract, get_dependency_impact, get_config_drift, get_infra_resources) — they answer from the index without reading files. get_git_context shows what is already in flight.
- Read a file at most once; use get_file_outline or a line range when the file is large.
- Before changing a function signature, a class or an exported type, call find_references (or get_neighbors for the file) and update every call site in the same turn. read_file results carry a <dependents> block with the one-hop callers — use it.
- Combine all changes to one file into a single edit_file call with several search/replace blocks.
- Edit results include the language server's diagnostics for that file: fix reported errors before running tests.
- For open-ended investigation, delegate to the explore tool and work from its report instead of reading many files yourself.
- After editing, run run_tests (or the relevant typecheck/lint) once and fix failures; do not loop on the same failing command.
- Stop when the task is done; summarise what changed in 3-6 lines. Do not restate file contents.
- Paths are workspace-relative. Never invent file paths — find them first.

File reading:
- Prefer get_symbol, get_file_outline, grep and search_codebase before read_file.
- Never read a file you have already read this turn unless an edit invalidated it.
- Do not use shell heredocs. Do not cat a whole file to answer a question the index can answer.

Terminals and MCP:
- A dev server (npm run dev, vite, next, flask, uvicorn) is routed to a persistent terminal named dev. Read the reason it returns: server ready, port in use, still starting, or exit N.
- Tools from .mcp.json and the user mcp.json are named mcp_<server>_<tool>. list_mcp_tools shows servers that are configured or disabled.`;

const MODE_SYSTEM: Record<AgentMode, string> = {
	agent: '',
	plan: 'MODE: plan only. Produce a concise numbered plan with the files involved. Do NOT call edit, create, delete or run tools.',
	explain: 'MODE: explain. Use read-only tools to ground your explanation in the actual code, cite paths and line ranges, make no edits.',
	verify: 'MODE: verify. Run the project test/typecheck command(s) and report results; propose (do not apply) fixes.',
};

const toolsForMode = (mode: AgentMode, s: RiafSettings) => [
	...TOOL_SPECS.filter(t => {
		if (t.name === 'explore' && !s.agent.exploreSubagent) { return false; }
		if (mode === 'plan' || mode === 'explain') { return READ_ONLY_TOOLS.has(t.name); }
		if (mode === 'verify') { return READ_ONLY_TOOLS.has(t.name) || COMMAND_TOOLS.has(t.name); }
		if (!s.agent.allowRunCommand && COMMAND_TOOLS.has(t.name)) { return false; }
		return true;
	}),
	// enterprise integrations the developer switched on (Jira, Confluence, GitLab, knowledge stores); writes only in agent mode
	...integrationToolSpecs({ readOnly: mode !== 'agent' }),
];

/* ───────────────────────────── the loop ───────────────────────────── */

export async function runAgent(o: AgentRunOptions): Promise<AgentRunResult> {
	const { transport, settings: s, stream, token, usage } = o;
	const limits = getAgentLoopLimits(toGlobalSettings(s));
	const gs = toGlobalSettings(s);
	const history: ChatMessage[] = [...o.history, userMsg(o.userPrompt)];
	const abort = new AbortController();
	token.onCancellationRequested(() => abort.abort());

	const remembered = o.memoryHome ? extractRememberedFact(o.userPrompt) : null;
	if (remembered && o.memoryHome) {
		appendMemory(remembered, o.memoryHome);
		const ack = `I'll remember that: ${remembered}`;
		history.push(assistantMsg(ack));
		stream.markdown(ack);
		return { history, iterations: 0, editedFiles: [], stopped: 'done' };
	}
	if (s.agent.sessionBudgetUsd > 0 && usage.session.costUSD >= s.agent.sessionBudgetUsd) {
		stream.markdown(`\n\n⚠️ session budget reached ($${usage.session.costUSD.toFixed(4)} of $${s.agent.sessionBudgetUsd}). Raise \`riaf.agent.sessionBudgetUsd\` or set it to 0 to continue.`);
		return { history, iterations: 0, editedFiles: [], stopped: 'budget' };
	}
	const cooldownMs = getProviderRateLimitCooldownMs(transport.providerName, transport.modelName);
	if (cooldownMs > 0) {
		const wait = o.retryDelayMs !== undefined ? Math.min(cooldownMs, o.retryDelayMs) : cooldownMs;
		stream.progress(formatRateLimitCooldownMessage(wait));
		await sleep(wait, abort.signal);
	}

	// trackers from token-opt
	const fileReads = new Map<string, FileReadRecord>();
	const fileEditCounts = new Map<string, number>();
	const readCounts = createReadOnlyCallCounts();
	const editCompletion = createEditCompletionTracker();
	const sandboxVerify = createSandboxVerificationTracker();
	seedFileReadsFromHistory(o.history, fileReads);

	const meter = (u: Parameters<UsageMeter['record']>[0] | undefined, purpose: string) => { if (!s.general.metricsOptOut && u) { usage.record(u, { provider: transport.providerName, model: transport.modelName, purpose }); } };
	const toolCtx: ToolContext = {
		folder: o.folder, index: o.index, activeFile: o.activeFile, requireEditApproval: s.agent.requireEditApproval, allowRunCommand: s.agent.allowRunCommand,
		// plan / explain hide the edit tools from the model AND refuse them if a call arrives anyway
		readOnly: o.mode === 'plan' || o.mode === 'explain',
		progress: t => stream.progress(t), token,
		// P3 harness: shell policy + sandbox, hooks, checkpoints, diagnostics, explore subagent
		commandPolicy: { preApproved: s.agent.preApprovedCommands, denyPatterns: s.agent.denyCommandPatterns, autoApproveDetected: s.agent.autoApproveDetectedTestCommand },
		sandbox: s.agent.sandbox,
		hooks: loadHooks(o.folder.uri.fsPath, s.agent.hooks),
		checkpoint: s.agent.checkpoints ? o.checkpoint : undefined,
		diagnosticsSettleMs: s.agent.diagnosticsAfterEdit ? (o.diagnosticsSettleMs ?? s.agent.diagnosticsSettleMs) : undefined,
		exploreMaxSteps: s.agent.exploreMaxSteps,
		transport, onSubagentUsage: (u, purpose) => meter(u, purpose), log: o.log,
	};
	const tools = toolsForMode(o.mode, s);
	if (o.mode === 'agent' || o.mode === 'verify') {
		const mcp = await listAgentMcpTools(o.folder.uri.fsPath, s.mcp.disabledServers).catch(error => { o.log(`mcp tools: ${(error as Error).message}`); return []; });
		tools.push(...mcp);
	}

	// stable system prompt: role + policy + project rules + workspace profile (cacheable prefix)
	const profile = await o.index.getContextualProfile(o.activeFile).catch(() => undefined);
	const fileRules = loadProjectRules(o.folder.uri.fsPath, o.activeFile);
	if (fileRules.sources.length) { o.log(`project rules: ${fileRules.sources.join(', ')}`); }
	const memoryText = o.memoryText ?? (o.memoryHome ? readMemory(o.memoryHome) : '');
	const profileCap = profileCharCap(o.mode, gs.enableLightAgent);
	const profileText = profile?.profileText && profile.profileText.length > profileCap ? `${profile.profileText.slice(0, profileCap)}\n…` : profile?.profileText;
	const stableSystem = [s.general.disableSystemPrompt ? '' : STABLE_SYSTEM, MODE_SYSTEM[o.mode],
		s.general.aiInstructions ? `<ai_instructions>\n${s.general.aiInstructions}\n</ai_instructions>` : '',
		o.rules ?? '',
		memoryPromptBlock(memoryText),
		fileRules.text ? `<project_rules>\nFollow these project rules (${fileRules.sources.join(', ')}); they override the defaults above where they conflict.\n\n${fileRules.text}\n</project_rules>` : '',
		profileText ? `<workspace_profile>\n${profileText}\n</workspace_profile>` : '',
		profile?.activeFile ? `Active file: ${profile.activeFile}\nRelated: ${profile.relatedFiles.slice(0, 12).join(', ')}\nTests: ${profile.tests.join(', ') || 'none'}` : '',
		profile?.neighborhood ? `<active_file_neighborhood>\n${profile.neighborhood}\n</active_file_neighborhood>` : ''].filter(Boolean).join('\n\n');
	// files whose one-hop neighbourhood has already been shown this run (the preamble before an edit)
	const briefedFiles = new Set<string>(profile?.activeFile && profile.neighborhood ? [profile.activeFile] : []);

	// 1. plan — reuse a pending plan, reactivate a skipped one on "continue", else generate with session context.
	// Leftover items are never marked done just because the run ended.
	let plan: PlanMessage | null = null;
	if (shouldGenerateAgentPlan(gs) && o.mode === 'agent') {
		stream.progress('Planning…');
		const callLLM: LLMCallPort = async req => {
			const r = await transport.call({ systemMessage: req.systemMessage, messages: toTransportMessages(req.messages), maxOutputTokens: req.maxOutputTokens, signal: req.signal });
			meter(r.usage, 'agent:plan');
			return { text: r.text, usage: r.usage };
		};
		const resolved = await resolveAgentPlanForRun({
			callLLM, usageMeter: usage, chatMessages: history, chatMode: 'agent', threadId: generateUuid(),
			modelSelection: { providerName: transport.providerName, modelName: transport.modelName }, signal: abort.signal, timeoutMs: 30_000,
			fileReadHistory: fileReads,
		}).catch(e => { o.log(`plan failed: ${e}`); return { action: 'none' as const }; });
		if (resolved.action === 'reuse') { plan = getLatestPlanMessage(history); }
		else if (resolved.action === 'reactivate') { history[resolved.planMessageIdx] = resolved.plan; plan = resolved.plan; renderPlan(stream, plan); }
		else if (resolved.action === 'generate') {
			if (resolved.priorPlanMessageIdx !== undefined && history[resolved.priorPlanMessageIdx]?.role === 'plan') {
				history[resolved.priorPlanMessageIdx] = skipRemainingPlanItems(history[resolved.priorPlanMessageIdx] as PlanMessage);
			}
			plan = resolved.plan; history.push(plan); renderPlan(stream, plan);
		}
	}

	// 2. iterate
	const editedFiles = new Set<string>();
	let consecutiveFails = 0;
	let iterations = 0;
	let verified = false;
	let stopped: AgentRunResult['stopped'] = 'done';
	let editNudges = 0;
	let emptyNudges = 0;
	let retryAttempt = 0;
	let aggressiveTrim = false;
	let summaryFailedThisRun = false;

	while (iterations < limits.maxAgentIterations) {
		if (token.isCancellationRequested) { stopped = 'cancelled'; break; }
		iterations++;

		// budget: summarise the middle of a long thread (model side-call), then compact stale tool
		// results, trim oldest, keep the protected tail — the summary step is skipped on failure so
		// trimming always still runs.
		const inputCap = getAgentInputTokenCap(transport.providerName);
		let effectiveWindow = Math.floor(transport.contextWindow * (s.agent.contextWindowRatio / 0.85));
		if (inputCap) { effectiveWindow = Math.min(effectiveWindow, inputCap); }
		if (s.agent.summarizeHistory && !summaryFailedThisRun) {
			const summaryTransport = s.models.summary ? await createTransport(undefined, s.models.summary) ?? transport : transport;
			const callLLM: LLMCallPort = async req => {
				const r = await summaryTransport.call({ systemMessage: req.systemMessage, messages: toTransportMessages(req.messages), maxOutputTokens: req.maxOutputTokens, signal: req.signal });
				meter(r.usage, 'agent:summary');
				return { text: r.text, usage: r.usage };
			};
			const sum = await summarizeThreadMiddle({
				messages: history, callLLM, systemMessage: stableSystem, signal: abort.signal,
				inputBudget: Math.floor(Math.max(1, effectiveWindow - transport.maxOutputTokens) * 0.85),
				onSkip: reason => { if (/failed|returned nothing/.test(reason)) { summaryFailedThisRun = true; o.log(`summary skipped: ${reason}`); } },
			});
			if (sum.summarized) {
				history.splice(0, history.length, ...sum.messages);
				usage.recordSaved(Math.max(0, sum.tokensSaved));
				o.log(`summary: replaced ${sum.replaced} messages, saved ≈${sum.tokensSaved} tokens`);
				stream.progress('Summarised earlier turns to stay within the context budget');
			}
		}
		const prepared = prepareMessagesForModel({
			messages: history, contextWindow: effectiveWindow,
			reservedOutputTokens: transport.maxOutputTokens, chatMode: 'agent', fileReads, systemMessage: stableSystem, providerName: transport.providerName,
			forceAggressiveTrim: aggressiveTrim || iterations >= 3,
		});
		usage.recordSaved(Math.max(0, estimateChatHistoryTokens({ chatMessages: history, systemMessage: stableSystem, aiInstructions: '' }) - prepared.estimatedTokens));
		if (prepared.trimmed || prepared.compacted) { o.log(`budget: trimmed=${prepared.trimmed} compacted=${prepared.compacted} est=${prepared.estimatedTokens}`); }

		// volatile hints (never in the cached prefix)
		const volatile = buildAgentTailHints({
			repeatEditHint: buildRepeatEditHint(fileEditCounts),
			repeatReadHint: buildRepeatReadHint(readCounts),
			repeatFileReadHint: buildRepeatFileReadHint(fileReads),
			largeFileEditHint: buildLargeFileEditHint(fileReads),
			explorationBudgetHint: buildExplorationBudgetHint(readCounts, limits.maxReadOnlyCalls),
			editCompletionHint: editCompletion.interruptedEditTool || editCompletion.truncatedEditTool ? buildEditCompletionHint(editCompletion) : '',
			crossQueryFileReadHint: buildCrossQueryFileReadHint(fileReads, iterations),
		});
		const planText = plan ? `\n\nPlan status:\n${plan.items.map(i => `- [${i.status === 'done' ? 'x' : ' '}] ${i.text}`).join('\n')}` : '';

		let res;
		let streamed = '';
		const stallMs = o.stallTimeoutMs ?? getLlmStreamStallTimeoutMs(limits.llmStreamStallTimeoutMs, { editToolStreaming: fileEditCounts.size > 0 });
		try {
			res = await callWithStall(transport, {
				systemMessage: stableSystem, volatileSystemMessage: (volatile + planText).trim() || undefined,
				messages: toTransportMessages(prepared.messages), tools, signal: abort.signal,
				onText: delta => { streamed += delta; stream.markdown(delta); },
			}, stallMs);
		} catch (e) {
			if (token.isCancellationRequested) {
				if (streamed) { history.push(assistantMsg(streamed)); }
				stopped = 'cancelled'; break;
			}
			const err: LLMErrorLike = { message: (e as Error).message ?? String(e), fullError: e instanceof Error ? e : null };
			if (isRateLimitLLMError(err)) { recordProviderRateLimitHit(transport.providerName, err, transport.modelName); }
			if (isStreamStallLLMError(err) && fileEditCounts.size > 0) {
				markInterruptedEditTool(editCompletion);
				history.push(userMsg('The model stream stalled while an edit was in progress. Retry the edit with smaller edit_file blocks; do not rewrite the whole file.'));
			}
			o.log(`model error (attempt ${retryAttempt + 1}): ${(e as Error).stack ?? e}`);
			// transient (429 / 5xx / overflow / stall): wait and retry with a tighter budget; fatal (4xx auth, 404): stop
			if (retryAttempt < getMaxLLMRetryAttempts(err)) {
				retryAttempt++;
				iterations--; // a retry is not a model turn
				if (shouldForceAggressiveTrimOnRetry(err)) { aggressiveTrim = true; }
				const delay = getLLMRetryDelayMs(err, retryAttempt, o.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
				stream.progress(`model call failed (${err.message.split('\n')[0].slice(0, 80)}); retrying in ${Math.round(delay / 1000)}s…`);
				await sleep(delay, abort.signal);
				continue;
			}
			stream.markdown(`\n\n⚠️ model call failed: ${err.message}`);
			stopped = 'error'; break;
		}
		retryAttempt = 0; aggressiveTrim = false;
		meter(res.usage, `agent:${o.mode}`);

		// Always record the assistant turn when it carries tool calls — even with empty text — so the
		// tool results that follow stay paired with it (sanitizeToolMessagePairing drops orphans).
		if (res.text || res.toolCalls.length) { history.push(assistantMsg(res.text)); }
		const truncated = res.stopReason === 'length' || isLikelyOutputTruncated(res.usage?.outputTokens, res.usage ? transport.maxOutputTokens : 0);
		if (truncated && (res.toolCalls.some(tc => EDIT_TOOLS.has(tc.name)) || !res.toolCalls.length)) { markTruncatedEditTool(editCompletion); }
		if (truncated && !res.toolCalls.length && res.text.trim() && emptyNudges < MAX_EMPTY_RESPONSE_NUDGES) {
			emptyNudges++;
			history.push(userMsg('Your previous message was cut off by the output limit (token count is at the cap). Continue exactly where you stopped; if you were about to edit, call edit_file with small blocks.'));
			continue;
		}

		if (!res.toolCalls.length) {
			// empty or cut-off response: ask to continue, a bounded number of times, instead of ending silently
			if (!res.text.trim() || res.stopReason === 'length') {
				if (emptyNudges < MAX_EMPTY_RESPONSE_NUDGES) {
					emptyNudges++;
					o.log(`empty/cut-off response (stop=${res.stopReason}); nudge ${emptyNudges}`);
					history.push(userMsg(res.stopReason === 'length'
						? 'Your previous message was cut off by the output limit. Continue exactly where you stopped; if you were about to edit, call edit_file with small blocks.'
						: 'Your previous message was empty. Either call a tool to make progress or write the final answer now.'));
					continue;
				}
				stream.markdown('\n\n⚠️ the model returned an empty response twice; stopping. Try rephrasing the request or use /plan first.');
				break;
			}
			// one nudge if the user clearly asked for an edit but none happened
			if (o.mode === 'agent' && editNudges < 1 && needsEditCompletion({ tracker: editCompletion, fileEditCounts, readOnlyCallCount: readCounts.total, userMessage: o.userPrompt, chatMode: 'agent' })) {
				editNudges++;
				history.push(userMsg('You described changes but made no edit_file/rewrite_file/create_file_or_folder call. Apply the changes now using the tools.'));
				continue;
			}
			// auto-verify once after edits
			if (o.mode === 'agent' && !s.agent.autoVerify && s.agent.sandboxVerificationNudge && !verified && needsSandboxVerification(sandboxVerify, fileEditCounts, await workspaceProfile(o))) {
				verified = true;
				sandboxVerify.nudgeCount++;
				history.push(userMsg(buildSandboxVerificationHint(await workspaceProfile(o)).trim()));
				continue;
			}
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

		// 3. execute tool calls. A single read-only call may grow into a small parallel batch.
		let calls = res.toolCalls;
		if (shouldUseParallelReadBatching(gs) && calls.length === 1 && isReadOnlyBatchTool(calls[0].name)) {
			try {
				const primary = calls[0];
				const extra = await discoverAdditionalReadTools({
					callLLM: async req => {
						const r = await transport.call({ systemMessage: req.systemMessage, messages: toTransportMessages(req.messages), maxOutputTokens: req.maxOutputTokens, signal: abort.signal });
						meter(r.usage, 'agent:read-batch');
						return { text: r.text };
					},
					modelSelection: { providerName: transport.providerName, modelName: transport.modelName },
					primaryToolCall: { name: primary.name, rawParams: stringifyParams(primary.args ?? {}), id: primary.id, isDone: true, doneParams: Object.keys(primary.args ?? {}) },
					recentMessages: history.filter(m => m.role === 'user').map(m => ({ role: 'user', content: (m as { content?: string }).content ?? '' })),
					excludeKeys: new Set(),
					signal: abort.signal,
				});
				for (const t of extra) {
					const args: Record<string, unknown> = {};
					for (const [k, v] of Object.entries(t.rawParams)) { args[k] = v; }
					calls = [...calls, { id: t.id, name: t.name, args }];
				}
			} catch (e) { o.log(`read batch skipped: ${(e as Error).message}`); }
		}
		for (const call of calls) {
			if (token.isCancellationRequested) {
				history.push({ role: 'interrupted_streaming_tool', name: call.name } as ChatMessage);
				stopped = 'cancelled';
				break;
			}
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
			let text = out.ok ? out.result : `ERROR: ${out.error}`;
			// One hop before the edit: the first time a file is read in agent mode, append who depends on
			// it (callers, subclasses, importers) so a signature change is made with its call sites in view.
			if (out.ok && o.mode === 'agent' && call.name === 'read_file' && typeof args.filePath === 'string' && !briefedFiles.has(args.filePath)) {
				briefedFiles.add(args.filePath);
				const hood = await o.index.getEditNeighborhood(args.filePath).catch(() => '');
				if (hood && !/no dependents or dependencies/.test(hood)) { text += `\n\n<dependents>\n${hood}\n</dependents>`; }
			}
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
					markSandboxCodeChange(sandboxVerify);
					// the file changed: an earlier read no longer reflects it, so a re-read must be allowed
					invalidateFileRead(fileReads, URI.file(p));
					stream.reference(vscode.Uri.joinPath(o.folder.uri, p));
				}
				if (plan) { plan = markPlanItemDoneForTool(plan, call.name, { ...args, uri: URI.file(String(args.filePath ?? args.path ?? '')) } as never); }
			} else {
				consecutiveFails++;
				if (EDIT_TOOLS.has(call.name) && /rejected/.test(out.error)) { /* developer said no — not a failure of the model */ consecutiveFails--; }
				if (EDIT_TOOLS.has(call.name)) {
					// a failed search block usually means the model's copy of the file is wrong: let it re-read
					const p = String(args.filePath ?? args.path ?? '');
					if (p && out.meta?.editFailed) { invalidateFileRead(fileReads, URI.file(p)); }
					if (out.meta?.truncated) { markTruncatedEditTool(editCompletion); }
				}
				if (consecutiveFails >= limits.maxConsecutiveToolFails) { stream.markdown(`\n\n⚠️ ${limits.maxConsecutiveToolFails} consecutive tool failures — stopping.`); stopped = 'tool_fail_cap'; break; }
			}
		}
		if (stopped !== 'done') { break; }
	}
	if (iterations >= limits.maxAgentIterations && stopped === 'done') { stopped = 'max_iterations'; stream.markdown(`\n\n⚠️ reached the iteration cap (${limits.maxAgentIterations}).`); }
	if (plan) { renderPlan(stream, plan, true); }

	const t = usage.session;
	const priceNote = hasKnownPricing(transport.providerName) ? '' : ` · no price for ${transport.providerName} (table ${PRICING_TABLE_DATE})`;
	stream.markdown(`\n\n<sub>${iterations} iteration${iterations === 1 ? '' : 's'} · ${t.inputTokens.toLocaleString()} in / ${t.outputTokens.toLocaleString()} out · ${t.savedTokens.toLocaleString()} tokens saved by RIAF this session${priceNote}</sub>`);
	return { history, iterations, editedFiles: [...editedFiles], stopped };
}

/* ───────────────────────────── helpers ───────────────────────────── */

const numOrNull = (v: unknown): number | null => (v === undefined || v === null || v === '') ? null : Number(v);
async function workspaceProfile(o: AgentRunOptions): Promise<WorkspaceProfile | null> {
	const p = await o.index.getWorkspaceProfile().catch(() => undefined);
	return (p as WorkspaceProfile | undefined) ?? null;
}

/** Abort the model call if it produces nothing for `timeoutMs`. A stall does not cancel the whole run. */
function callWithStall(transport: ModelTransport, req: Parameters<ModelTransport['call']>[0], timeoutMs: number): Promise<Awaited<ReturnType<ModelTransport['call']>>> {
	const stall = new AbortController();
	let timer: ReturnType<typeof setTimeout>;
	const onAbort = () => { clearTimeout(timer); stall.abort(); };
	req.signal?.addEventListener('abort', onAbort, { once: true });
	return new Promise((resolve, reject) => {
		timer = setTimeout(() => { stall.abort(); reject(new Error('stream stalled')); }, timeoutMs);
		transport.call({ ...req, signal: stall.signal }).then(
			r => { clearTimeout(timer); resolve(r); },
			e => { clearTimeout(timer); reject(stall.signal.aborted && !req.signal?.aborted ? new Error('stream stalled') : e); },
		);
	});
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
	const t = setTimeout(resolve, ms);
	signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});
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
