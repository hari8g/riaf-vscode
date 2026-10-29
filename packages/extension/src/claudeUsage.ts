/**
 * Real Claude Code usage for a repository, read from Claude Code's own transcripts.
 *
 * Claude Code writes one JSONL per session under ~/.claude/projects/<encoded repo path>/.
 * Every assistant line carries `message.usage` (input, output, cache read, cache creation) and
 * `message.model`. We sum them per repository, de-duplicating by `message.id` (a streamed
 * message is written several times with the same id as it grows; the last line is complete).
 *
 * Read-only; nothing is sent anywhere. No `vscode` import.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { calculateTurnCostUSD, getModelPricing, type LLMMessageUsage } from '@bosch-mps/token-opt';
import { estimateSavedTokens } from './toolStats.js';

export type ClaudeUsageTotals = {
	calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUSD: number;
	/** cache read ÷ (input + cache read + cache write) */
	cacheEfficiency: number;
	byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUSD: number }>;
	sessions: number;
	firstAt?: number; lastAt?: number;
	/** The transcript folder that was read, for Doctor. */
	projectDir?: string;
	/** Models with no price-table entry (cost counted as 0). */
	unpricedModels: string[];
	/** How RIAF changed Claude Code's token use in this repo (see RiafEffect). */
	riafEffect?: RiafEffect;
};

/** One side of the with/without-RIAF comparison. "Prompt tokens" = input + cache read + cache write. */
export type EffectSide = {
	sessions: number; userTurns: number; calls: number;
	promptTokens: number; outputTokens: number;
	/** Claude's own file-reading tool calls (Read, Grep, Glob) */
	nativeReads: number;
	/** mcp__riaf__* calls */
	riafCalls: number;
	avgPromptPerCall: number; avgOutputPerCall: number; avgCallsPerTurn: number; avgReadsPerTurn: number;
};

export type RiafEffect = {
	with: EffectSide; without: EffectSide;
	/** (without.avgPromptPerCall − with.avgPromptPerCall) / without.avgPromptPerCall; undefined when one side has no data */
	promptPerCallSavedPct?: number;
	outputPerCallSavedPct?: number;
	readsPerTurnSavedPct?: number;
	/** Tokens RIAF's tool results saved vs reading the whole files they drew on (same estimate as "Tools served") */
	directSavedTokens: number;
	/** directSavedTokens / (with.promptTokens + directSavedTokens) */
	directSavedPct: number;
	/** Per riaf tool: calls and estimated saved tokens */
	byTool: Record<string, { calls: number; savedTokens: number }>;
};

const empty = (): ClaudeUsageTotals => ({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0, cacheEfficiency: 0, byModel: {}, sessions: 0, unpricedModels: [] });

export const claudeProjectsDir = (claudeHome = join(homedir(), '.claude')): string => join(claudeHome, 'projects');

/**
 * Claude Code encodes the repo path by replacing every non-alphanumeric character with "-"
 * (`/home/u/x` → `-home-u-x`, `C:\Users\u\x` → `C--Users-u-x`). Accept the looser variant that
 * keeps dots and underscores too, in case an older version was used.
 */
export function candidateProjectDirNames(repoRoot: string): string[] {
	const strict = repoRoot.replace(/[^A-Za-z0-9]/g, '-');
	const loose = repoRoot.replace(/[\\/:]/g, '-');
	return [...new Set([strict, loose])];
}

export function findProjectDir(repoRoot: string, claudeHome?: string): string | undefined {
	const base = claudeProjectsDir(claudeHome);
	if (!existsSync(base)) { return undefined; }
	let names: string[] = [];
	try { names = readdirSync(base); } catch { return undefined; }
	const wanted = new Set(candidateProjectDirNames(repoRoot).map(s => s.toLowerCase()));
	const hit = names.find(n => wanted.has(n.toLowerCase()));
	return hit ? join(base, hit) : undefined;
}

type TranscriptLine = { type?: string; message?: { id?: string; model?: string; usage?: Record<string, number | undefined> }; timestamp?: string };

function* jsonlFiles(dir: string, depth = 0): Generator<string> {
	let entries: string[] = [];
	try { entries = readdirSync(dir); } catch { return; }
	for (const e of entries) {
		const p = join(dir, e);
		let st; try { st = statSync(p); } catch { continue; }
		if (st.isDirectory() && depth < 2) { yield* jsonlFiles(p, depth + 1); }       // subagent transcripts live in a subfolder
		else if (st.isFile() && e.endsWith('.jsonl')) { yield p; }
	}
}

type ContentBlock = { type?: string; name?: string; id?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; text?: string };
type SessionAcc = { file: string; usesRiaf: boolean; userTurns: number; msgIds: Set<string>; nativeReads: number; riafCalls: number };
const NATIVE_READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const RIAF_PREFIX = 'mcp__riaf__';
const blockText = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (b as ContentBlock)?.text ?? '').join('') : '';

/** Parse the transcripts under one project dir. `workspaceRoot` enables the direct-savings estimate (file sizes). */
export function readClaudeUsageFromDir(projectDir: string, workspaceRoot?: string): ClaudeUsageTotals {
	const out = empty();
	out.projectDir = projectDir;
	const seen = new Map<string, { model: string; usage: LLMMessageUsage; at?: number; session: string }>();
	const sessionsAcc = new Map<string, SessionAcc>();
	const riafUses = new Map<string, { name: string; args: Record<string, unknown> }>();   // tool_use id → riaf call
	const directByTool: Record<string, { calls: number; savedTokens: number }> = {};
	let directSaved = 0;
	let sessions = 0;
	for (const file of jsonlFiles(projectDir)) {
		sessions++;
		const acc: SessionAcc = { file, usesRiaf: false, userTurns: 0, msgIds: new Set(), nativeReads: 0, riafCalls: 0 };
		sessionsAcc.set(file, acc);
		let text: string; try { text = readFileSync(file, 'utf8'); } catch { continue; }
		for (const raw of text.split('\n')) {
			if (!raw.includes('"message"')) { continue; }
			let line: TranscriptLine & { message?: { content?: unknown; role?: string } }; try { line = JSON.parse(raw); } catch { continue; }
			const content = line.message?.content;
			const blocks: ContentBlock[] = Array.isArray(content) ? content as ContentBlock[] : [];
			if (line.type === 'user') {
				// a real user turn is a string message or text blocks; tool_result lines are the loop, not a turn
				if (typeof content === 'string' || (blocks.length && blocks.every(b => b.type === 'text'))) { acc.userTurns++; }
				for (const b of blocks) {
					if (b.type !== 'tool_result' || !b.tool_use_id) { continue; }
					const use = riafUses.get(b.tool_use_id);
					if (!use) { continue; }
					const tool = use.name.slice(RIAF_PREFIX.length);
					const row = (directByTool[tool] ??= { calls: 0, savedTokens: 0 });
					row.calls++;
					if (workspaceRoot) { const saved = estimateSavedTokens(workspaceRoot, tool, use.args, blockText(b.content)); row.savedTokens += saved; directSaved += saved; }
				}
				continue;
			}
			if (line.type !== 'assistant') { continue; }
			for (const b of blocks) {
				if (b.type !== 'tool_use' || !b.name) { continue; }
				if (b.name.startsWith(RIAF_PREFIX)) { acc.usesRiaf = true; acc.riafCalls++; if (b.id) { riafUses.set(b.id, { name: b.name, args: b.input ?? {} }); } }
				else if (NATIVE_READ_TOOLS.has(b.name)) { acc.nativeReads++; }
			}
			const u = line.message?.usage; const id = line.message?.id;
			if (!u || !id) { continue; }
			acc.msgIds.add(id);
			const usage: LLMMessageUsage = {
				inputTokens: Number(u.input_tokens ?? 0), outputTokens: Number(u.output_tokens ?? 0),
				cacheReadTokens: Number(u.cache_read_input_tokens ?? 0), cacheWriteTokens: Number(u.cache_creation_input_tokens ?? 0),
			};
			const at = line.timestamp ? Date.parse(line.timestamp) : undefined;
			const prev = seen.get(id);
			// keep the most complete record for a message id (output grows as the stream is flushed)
			// keep the first timestamp (when the call started) but the most complete usage
			if (!prev || usage.outputTokens >= prev.usage.outputTokens) { seen.set(id, { model: line.message?.model ?? 'unknown', usage, at: prev?.at ?? at, session: file }); }
		}
	}
	out.sessions = sessions;
	out.riafEffect = computeRiafEffect(sessionsAcc, seen, directSaved, directByTool);
	const unpriced = new Set<string>();
	for (const { model, usage, at } of seen.values()) {
		if (!getModelPricing('anthropic', model)) { unpriced.add(model); }
		const c = calculateTurnCostUSD(usage, 'anthropic', model);
		const row = (out.byModel[model] ??= { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0 });
		for (const t of [out, row]) {
			t.calls++; t.inputTokens += usage.inputTokens; t.outputTokens += usage.outputTokens;
			t.cacheReadTokens += usage.cacheReadTokens ?? 0; t.cacheWriteTokens += usage.cacheWriteTokens ?? 0; t.costUSD += c;
		}
		if (at) { out.firstAt = out.firstAt ? Math.min(out.firstAt, at) : at; out.lastAt = out.lastAt ? Math.max(out.lastAt, at) : at; }
	}
	const prompt = out.inputTokens + out.cacheReadTokens + out.cacheWriteTokens;
	out.cacheEfficiency = prompt > 0 ? out.cacheReadTokens / prompt : 0;
	out.unpricedModels = [...unpriced];
	return out;
}

const sideEmpty = (): EffectSide => ({ sessions: 0, userTurns: 0, calls: 0, promptTokens: 0, outputTokens: 0, nativeReads: 0, riafCalls: 0, avgPromptPerCall: 0, avgOutputPerCall: 0, avgCallsPerTurn: 0, avgReadsPerTurn: 0 });
const pct = (without: number, withR: number): number | undefined => without > 0 ? (without - withR) / without : undefined;

function computeRiafEffect(sessionsAcc: Map<string, SessionAcc>, seen: Map<string, { usage: LLMMessageUsage; session: string }>, directSaved: number, byTool: Record<string, { calls: number; savedTokens: number }>): RiafEffect {
	const w = sideEmpty(), wo = sideEmpty();
	for (const acc of sessionsAcc.values()) {
		if (!acc.msgIds.size) { continue; }
		const side = acc.usesRiaf ? w : wo;
		side.sessions++; side.userTurns += acc.userTurns; side.nativeReads += acc.nativeReads; side.riafCalls += acc.riafCalls;
	}
	for (const { usage, session } of seen.values()) {
		const side = sessionsAcc.get(session)?.usesRiaf ? w : wo;
		side.calls++;
		side.promptTokens += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
		side.outputTokens += usage.outputTokens;
	}
	for (const s of [w, wo]) {
		s.avgPromptPerCall = s.calls ? s.promptTokens / s.calls : 0;
		s.avgOutputPerCall = s.calls ? s.outputTokens / s.calls : 0;
		s.avgCallsPerTurn = s.userTurns ? s.calls / s.userTurns : 0;
		s.avgReadsPerTurn = s.userTurns ? s.nativeReads / s.userTurns : 0;
	}
	const both = w.calls > 0 && wo.calls > 0;
	return {
		with: w, without: wo,
		promptPerCallSavedPct: both ? pct(wo.avgPromptPerCall, w.avgPromptPerCall) : undefined,
		outputPerCallSavedPct: both ? pct(wo.avgOutputPerCall, w.avgOutputPerCall) : undefined,
		readsPerTurnSavedPct: both && w.userTurns && wo.userTurns ? pct(wo.avgReadsPerTurn, w.avgReadsPerTurn) : undefined,
		directSavedTokens: directSaved,
		directSavedPct: w.promptTokens + directSaved > 0 ? directSaved / (w.promptTokens + directSaved) : 0,
		byTool,
	};
}

/** Usage for the repo at `repoRoot`, or an empty record (with `projectDir` unset) when Claude Code has no transcripts for it. */
export function readClaudeUsage(repoRoot: string, claudeHome?: string): ClaudeUsageTotals {
	const dir = findProjectDir(repoRoot, claudeHome);
	return dir ? readClaudeUsageFromDir(dir, repoRoot) : empty();
}

/* small mtime-keyed cache so the settings panel can poll cheaply */
const cache = new Map<string, { stamp: string; value: ClaudeUsageTotals }>();
export function readClaudeUsageCached(repoRoot: string, claudeHome?: string): ClaudeUsageTotals {
	const dir = findProjectDir(repoRoot, claudeHome);
	if (!dir) { return empty(); }
	let stamp = '';
	for (const f of jsonlFiles(dir)) { try { stamp += `${f}:${statSync(f).mtimeMs};`; } catch { /* ignore */ } }
	const hit = cache.get(dir);
	if (hit && hit.stamp === stamp) { return hit.value; }
	const value = readClaudeUsageFromDir(dir, repoRoot);
	cache.set(dir, { stamp, value });
	return value;
}
