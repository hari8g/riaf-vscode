/**
 * RIAF 2.0 CLI commands (dispatched from `riaf`):
 *   riaf index [--force] [--ci]                       build / refresh the index, history and summaries
 *   riaf search <query> [--mode hybrid|lexical|structural] [--limit N]
 *   riaf pack --intent "<task>" [--format md|json|claude|copilot|openai|gemini|agents-md] [--budget 32k] [--scope path/] [--out file]
 *   riaf history <path> | --hotspots | --since <ref|date> [--prefix path/]
 *   riaf eval [--samples N] [--budget 24k] [--json]
 *   riaf init --host claude [--mcp-command "node /path/to/riaf-mcp.mjs"]
 *   riaf serve [--port 7421] [--open] [--daemon /path/to/daemon.mjs]   RIAF Console (web UI) over this repo's index
 *   riaf classify "<task>" | riaf instruct "<task>" [--budget 16k]     intent route / Prompt Instruction
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { buildInstruction, formatEvalReport, formatRouteLine, parseBudget, Riaf2, routeIntent, runEval, saveInstruction, RENDER_TARGETS, type RenderTarget } from '@bosch-mps/riaf-core';
import { writeClaudeGovernance } from './claudeInit.js';

export const RIAF2_COMMANDS = ['index', 'search', 'pack', 'history', 'eval', 'init', 'serve', 'classify', 'instruct'] as const;

const VALUE_FLAGS = new Set(['repo', 'mode', 'limit', 'intent', 'format', 'budget', 'scope', 'out', 'since', 'prefix', 'samples', 'host', 'mcp-command', 'db', 'seed', 'port', 'daemon', 'active-file', 'command']);

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

	if (cmd === 'serve') {
		const daemon = findDaemon(str('daemon'));
		if (!daemon) { io.log('riaf serve: cannot find daemon.mjs — pass --daemon <path to riaf-vscode/dist/daemon.mjs> or set RIAF_DAEMON'); return 2; }
		const args = [daemon, '--workspace', repo, ...(str('db') ? ['--db', str('db')!] : []), ...(str('port') ? ['--port', str('port')!] : []), ...(flags.open ? ['--open'] : []), ...(flags.reindex ? ['--reindex'] : []), ...(flags['no-govern'] ? ['--no-govern'] : [])];
		io.log(`starting RIAF Console: node ${args.join(' ')}`);
		const child = spawn(process.execPath, args, { stdio: 'inherit' });
		return new Promise<number>(res => child.on('exit', code => res(code ?? 0)));
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

		if (cmd === 'classify' || cmd === 'instruct') {
		const request = str('intent') ?? positional.join(' ');
		if (!request) { io.log(`usage: riaf ${cmd} "<task>" [--active-file path] [--command plan|explain|verify]`); await riaf.close(); return 2; }
		const arch = await riaf.architecture().catch(() => null);
		const route = await routeIntent(request, { root: repo, activeFile: str('active-file'), command: str('command'), architectureSummary: arch?.summary });
		if (cmd === 'classify') { io.log(flags.json ? JSON.stringify(route, null, 2) : formatRouteLine(route) + (route.askFirst ? `\nWould ask first:\n${route.questions.map(q => `- ${q}`).join('\n')}` : '')); await riaf.close(); return 0; }
		const pack = await riaf.compile(request, { budget: parseBudget(str('budget'), route.budget), stage: route.stage, scope: route.scope, activeFile: str('active-file') });
		const instruction = buildInstruction(pack, { route, root: repo, host: (str('host') as 'claude' | 'copilot' | 'generic' | undefined) ?? 'claude' });
		const saved = saveInstruction(repo, instruction);
		if (str('out')) writeFileSync(str('out')!, instruction.markdown);
		io.log(flags.quiet ? `${formatRouteLine(route, { items: pack.items.length, tokens: pack.budget.used_tokens })}\nsaved ${saved.currentPath}` : instruction.markdown);
		await riaf.close();
		return 0;
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

/** Locate the daemon bundle: explicit flag, RIAF_DAEMON, or the extension's dist next to this package. */
export function findDaemon(explicit?: string): string | undefined {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [explicit, process.env.RIAF_DAEMON, join(here, '..', '..', 'extension', 'dist', 'daemon.mjs'), join(here, '..', 'dist', 'daemon.mjs'), join(here, 'daemon.mjs')].filter((p): p is string => !!p);
	return candidates.find(p => existsSync(p));
}
