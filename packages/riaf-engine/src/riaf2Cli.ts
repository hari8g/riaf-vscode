/**
 * RIAF 2.0 CLI commands (dispatched from `riaf`):
 *   riaf index [--force] [--ci]                       build / refresh the index, history and summaries
 *   riaf search <query> [--mode hybrid|lexical|structural] [--limit N]
 *   riaf pack --intent "<task>" [--format md|json|claude|copilot|openai|gemini|agents-md] [--budget 32k] [--scope path/] [--out file]
 *   riaf history <path> | --hotspots | --since <ref|date> [--prefix path/]
 *   riaf eval [--samples N] [--budget 24k] [--json]
 *   riaf init --host claude [--mcp-command "node /path/to/riaf-mcp.mjs"]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { formatEvalReport, parseBudget, Riaf2, runEval, RENDER_TARGETS, type RenderTarget } from '@bosch-mps/riaf-core';
import { writeClaudeGovernance } from './claudeInit.js';

export const RIAF2_COMMANDS = ['index', 'search', 'pack', 'history', 'eval', 'init'] as const;

const VALUE_FLAGS = new Set(['repo', 'mode', 'limit', 'intent', 'format', 'budget', 'scope', 'out', 'since', 'prefix', 'samples', 'host', 'mcp-command', 'db', 'seed']);

export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
	const positional: string[] = []; const flags: Record<string, string | true> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const [k, inline] = a.slice(2).split('=', 2);
			if (inline !== undefined) flags[k] = inline;
			else if (VALUE_FLAGS.has(k) && i + 1 < argv.length) flags[k] = argv[++i];
			else flags[k] = true;
		} else positional.push(a);
	}
	return { positional, flags };
}

export async function executeRiaf2(cmd: string, argv: string[], io: { log: (s: string) => void; cwd?: string }): Promise<number> {
	const { positional, flags } = parseArgs(argv);
	const repo = resolve(typeof flags.repo === 'string' ? flags.repo : io.cwd ?? process.cwd());
	const str = (k: string) => (typeof flags[k] === 'string' ? flags[k] as string : undefined);

	if (cmd === 'init') {
		if ((str('host') ?? 'claude') !== 'claude') { io.log('riaf init supports --host claude'); return 2; }
		const mcpCmd = str('mcp-command');
		const mcp = mcpCmd ? (() => { const parts = mcpCmd.match(/"[^"]*"|\S+/g)!.map(p => p.replace(/^"|"$/g, '')); return { command: parts[0], args: [...parts.slice(1), '--workspace', repo] }; })() : undefined;
		const files = writeClaudeGovernance(repo, { mcp });
		io.log(`RIAF Claude Code integration written:\n${files.map(f => `- ${f}`).join('\n')}`);
		if (!mcp) io.log('No --mcp-command given: run "RIAF: Set up Claude Code" in VS Code to register the MCP server in .mcp.json (the hooks need it running to govern tool calls; without it they fail open).');
		return 0;
	}

	const dbPath = str('db') ?? join(repo, '.riaf', 'index.sqlite');
	mkdirSync(join(repo, '.riaf'), { recursive: true });
	const riaf = await Riaf2.open({ workspaceRoot: repo, dbPath, log: flags.verbose ? io.log : undefined });
	try {
		if (cmd === 'index' || !riaf.index.getStatus().indexed) {
			const s = await riaf.indexRepo({ force: !!flags.force });
			if (cmd === 'index') {
				io.log(`indexed ${s.files} files, ${s.chunks} chunks, ${s.commits} commits, ${s.summaries} summaries regenerated in ${s.ms} ms → ${dbPath}`);
				if (flags.ci) io.log(`CI: cache ${join(repo, '.riaf')} keyed by the commit to share the index (delta download is planned for Phase 3).`);
				return 0;
			}
		} else {
			await riaf.history?.mine().catch(() => undefined);
		}

		if (cmd === 'search') {
			const q = positional.join(' ');
			if (!q) { io.log('usage: riaf search <query>'); return 2; }
			const hits = await riaf.search(q, { mode: (str('mode') as 'hybrid' | 'lexical' | 'structural' | undefined), limit: Number(str('limit') ?? 10) }) as Array<Record<string, unknown>>;
			io.log(hits.map(h => 'signature' in h ? `${h.filePath}:${h.startLine}  ${h.kind} ${h.name}` : `${h.filePath}:${h.startLine}-${h.endLine}  (${Number(h.score).toFixed(3)})`).join('\n') || 'No matches.');
			return 0;
		}
		if (cmd === 'pack') {
			const intent = str('intent') ?? positional.join(' ');
			if (!intent) { io.log('usage: riaf pack --intent "<task>" [--format md] [--budget 32k]'); return 2; }
			const fmt = (str('format') ?? 'md').replace(/^md$/, 'markdown') as RenderTarget;
			if (!RENDER_TARGETS.includes(fmt)) { io.log(`unknown format ${fmt}; use one of md, ${RENDER_TARGETS.join(', ')}`); return 2; }
			const pack = await riaf.compile(intent, { budget: parseBudget(str('budget'), 24_000), scope: str('scope'), fresh: !!flags.fresh });
			const out = riaf.render(pack, fmt);
			const file = str('out') ?? (fmt === 'agents-md' ? join(repo, 'AGENTS.md') : undefined);
			if (file) { writeFileSync(resolve(repo, file), out); io.log(`wrote ${file} (${pack.items.length} items, ${pack.budget.used_tokens}/${pack.budget.max_tokens} tokens)`); }
			else io.log(out);
			return 0;
		}
		if (cmd === 'history') {
			const h = riaf.history;
			if (!h) { io.log('history disabled'); return 1; }
			if (str('since')) {
				const rows = await h.changedSince(str('since')!, str('prefix') ?? positional[0] ?? '');
				io.log(rows.map(c => `${new Date(c.ts).toISOString().slice(0, 10)} ${c.sha.slice(0, 8)} [${c.intent}] ${c.why}`).join('\n') || 'No commits.');
				return 0;
			}
			if (flags.hotspots || !positional[0]) {
				io.log(h.hotspots(20, str('prefix') ?? '').map(x => `${x.path}  score ${x.score}  ${x.commits365} commits/12mo  fix ${Math.round(x.fixRatio * 100)}%`).join('\n') || 'No history.');
				return 0;
			}
			io.log(riaf.historyCard(positional[0], !!flags.names)?.text ?? 'No history.');
			return 0;
		}
		if (cmd === 'eval') {
			const report = await runEval(riaf, { samples: Number(str('samples') ?? 20), budget: parseBudget(str('budget'), 24_000), seed: Number(str('seed') ?? 42), log: flags.verbose ? io.log : undefined });
			io.log(flags.json ? JSON.stringify(report, null, 2) : formatEvalReport(report));
			return report.gates.some(g => g.pass === false) ? 1 : 0;
		}
		io.log(`unknown command ${cmd}`);
		return 2;
	} finally {
		await riaf.close();
	}
}
