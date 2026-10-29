/**
 * "Tools served" metrics — what RIAF does for assistants whose model calls it never sees
 * (Copilot calling #riaf tools, Claude Code calling the MCP server).
 *
 * Per consumer and per tool we count calls, characters returned, and an *estimate* of the
 * tokens the assistant did not have to read because RIAF returned ranked chunks / outlines
 * instead of whole files. The estimate is conservative: only retrieval tools whose "naive"
 * alternative is reading the full file(s) contribute.
 *
 * Persisted as JSON next to the index DB (`<dbPath>.tools.json`) so the extension host and the
 * MCP server process (which share the DB path) share one file. Counters only ever increase, so a
 * lost update under concurrent writes costs at most one call's worth. No `vscode` import.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type ToolConsumer = 'copilot' | 'claude-code' | 'agent' | 'other';

export type ToolCounters = { calls: number; charsReturned: number; savedTokensEst: number; errors: number; lastAt?: number };
export type ToolStatsFile = { version: 1; byConsumer: Record<string, Record<string, ToolCounters>> };

const CHARS_PER_TOKEN = 4;
const empty = (): ToolCounters => ({ calls: 0, charsReturned: 0, savedTokensEst: 0, errors: 0 });

export const toolStatsPathFor = (dbPath: string): string => `${dbPath}.tools.json`;

export function readToolStats(path: string): ToolStatsFile {
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as ToolStatsFile;
		if (parsed && parsed.version === 1 && parsed.byConsumer) { return parsed; }
	} catch { /* absent or malformed */ }
	return { version: 1, byConsumer: {} };
}

function writeToolStats(path: string, data: ToolStatsFile): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(data));
	renameSync(tmp, path);
}

/** Files a retrieval result drew from, for the "would have read whole files" estimate. */
export function filesReferencedInResult(toolName: string, args: Record<string, unknown>, result: string): string[] {
	switch (toolName) {
		case 'search_codebase': {
			// result lines look like "### path:12-40 (score …)"
			return [...new Set([...result.matchAll(/^### (.+?):\d+-\d+/gm)].map(m => m[1]))];
		}
		case 'get_file_outline': case 'get_symbol': case 'search_in_file':
			return typeof args.filePath === 'string' ? [args.filePath] : [];
		case 'get_context_profile':
			return typeof args.filePath === 'string' ? [args.filePath] : [];
		default:
			return [];
	}
}

/**
 * Estimate tokens the assistant would have spent reading the underlying files in full, minus
 * what RIAF actually returned. Never negative; 0 for tools without a "read the file" alternative.
 */
export function estimateSavedTokens(workspaceRoot: string, toolName: string, args: Record<string, unknown>, result: string): number {
	const files = filesReferencedInResult(toolName, args, result);
	if (!files.length) { return 0; }
	let fullChars = 0;
	for (const rel of files) {
		try { fullChars += statSync(join(workspaceRoot, rel)).size; } catch { /* file gone or not a file */ }
	}
	const saved = Math.max(0, fullChars - result.length);
	return Math.round(saved / CHARS_PER_TOKEN);
}

/** Record one served call. Returns the updated counters for that tool. */
export function recordToolCall(opts: { statsPath: string; workspaceRoot: string; consumer: ToolConsumer; toolName: string; args: Record<string, unknown>; result: string; ok: boolean }): ToolCounters {
	const data = readToolStats(opts.statsPath);
	const byTool = (data.byConsumer[opts.consumer] ??= {});
	const c = (byTool[opts.toolName] ??= empty());
	c.calls++;
	c.lastAt = Date.now();
	if (opts.ok) {
		c.charsReturned += opts.result.length;
		c.savedTokensEst += estimateSavedTokens(opts.workspaceRoot, opts.toolName, opts.args, opts.result);
	} else { c.errors++; }
	writeToolStats(opts.statsPath, data);
	return c;
}

export type ToolStatsSummary = {
	byConsumer: Record<string, { calls: number; charsReturned: number; savedTokensEst: number; errors: number; tools: Record<string, ToolCounters>; lastAt?: number }>;
	total: { calls: number; savedTokensEst: number; charsReturned: number };
};

export function summarizeToolStats(data: ToolStatsFile): ToolStatsSummary {
	const out: ToolStatsSummary = { byConsumer: {}, total: { calls: 0, savedTokensEst: 0, charsReturned: 0 } };
	for (const [consumer, tools] of Object.entries(data.byConsumer)) {
		const row = { calls: 0, charsReturned: 0, savedTokensEst: 0, errors: 0, tools, lastAt: undefined as number | undefined };
		for (const c of Object.values(tools)) {
			row.calls += c.calls; row.charsReturned += c.charsReturned; row.savedTokensEst += c.savedTokensEst; row.errors += c.errors;
			if (c.lastAt && (!row.lastAt || c.lastAt > row.lastAt)) { row.lastAt = c.lastAt; }
		}
		out.byConsumer[consumer] = row;
		out.total.calls += row.calls; out.total.savedTokensEst += row.savedTokensEst; out.total.charsReturned += row.charsReturned;
	}
	return out;
}

export function resetToolStats(path: string): void {
	if (existsSync(path)) { writeToolStats(path, { version: 1, byConsumer: {} }); }
}
