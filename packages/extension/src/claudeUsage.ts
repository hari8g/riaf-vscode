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

/** Parse the transcripts under one project dir. */
export function readClaudeUsageFromDir(projectDir: string): ClaudeUsageTotals {
	const out = empty();
	out.projectDir = projectDir;
	const seen = new Map<string, { model: string; usage: LLMMessageUsage; at?: number }>();
	let sessions = 0;
	for (const file of jsonlFiles(projectDir)) {
		sessions++;
		let text: string; try { text = readFileSync(file, 'utf8'); } catch { continue; }
		for (const raw of text.split('\n')) {
			if (!raw.includes('"usage"')) { continue; }
			let line: TranscriptLine; try { line = JSON.parse(raw); } catch { continue; }
			const u = line.message?.usage; const id = line.message?.id;
			if (line.type !== 'assistant' || !u || !id) { continue; }
			const usage: LLMMessageUsage = {
				inputTokens: Number(u.input_tokens ?? 0), outputTokens: Number(u.output_tokens ?? 0),
				cacheReadTokens: Number(u.cache_read_input_tokens ?? 0), cacheWriteTokens: Number(u.cache_creation_input_tokens ?? 0),
			};
			const at = line.timestamp ? Date.parse(line.timestamp) : undefined;
			const prev = seen.get(id);
			// keep the most complete record for a message id (output grows as the stream is flushed)
			// keep the first timestamp (when the call started) but the most complete usage
			if (!prev || usage.outputTokens >= prev.usage.outputTokens) { seen.set(id, { model: line.message?.model ?? 'unknown', usage, at: prev?.at ?? at }); }
		}
	}
	out.sessions = sessions;
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

/** Usage for the repo at `repoRoot`, or an empty record (with `projectDir` unset) when Claude Code has no transcripts for it. */
export function readClaudeUsage(repoRoot: string, claudeHome?: string): ClaudeUsageTotals {
	const dir = findProjectDir(repoRoot, claudeHome);
	return dir ? readClaudeUsageFromDir(dir) : empty();
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
	const value = readClaudeUsageFromDir(dir);
	cache.set(dir, { stamp, value });
	return value;
}
