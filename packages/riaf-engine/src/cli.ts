/**
 * `riaf run "<task>" --repo .` plans, edits via the gateway, and verifies.
 * `riaf status` and `riaf resume` read the same `.riaf/runs` ledger as the extension.
 * The process entry lives in cliMain.ts so importing this module never calls process.exit
 * (the extension bundles the package as CommonJS, where import.meta.url is empty).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runTask } from './engine.js';
import { FileLedger } from './ledger.js';
import { renderLedger } from './engine.js';
import { applyPatches, parsePatchDocument } from './patches.js';
import type { LlmCall } from './planner.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type CliIo = {
	callLLM?: LlmCall;
	log?: (line: string) => void;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
};

const flag = (argv: string[], name: string): string | undefined => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};

export function gatewayCall(url: string, model: string, apiKey?: string): LlmCall {
	const base = url.replace(/\/+$/, '');
	return async (system, user) => {
		const res = await fetch(`${base}/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
			body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
		});
		if (!res.ok) { throw new Error(`gateway ${res.status}`); }
		const json = await res.json() as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
		return { text: json.choices?.[0]?.message?.content ?? '', inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens };
	};
}

export async function executeCli(argv: string[], io: CliIo = {}): Promise<number> {
	const log = io.log ?? (line => console.log(line));
	const [cmd, ...rest] = argv;
	const repo = resolve(flag(rest, 'repo') ?? io.cwd ?? process.cwd());
	const ledger = new FileLedger(repo);
	if (cmd === 'status') {
		const id = rest.find(a => !a.startsWith('--'));
		const rows = ledger.list();
		if (!rows.length) { log('No runs.'); return 0; }
		const run = ledger.load(id && !id.startsWith('-') ? id : rows[0].id);
		log(renderLedger(run));
		return run.status === 'done' ? 0 : 1;
	}
	if (cmd !== 'run' && cmd !== 'resume') { log('usage: riaf run "<task>" --repo . [--gateway URL --model NAME] | riaf status | riaf resume [id]'); return 2; }
	const goal = cmd === 'run' ? (rest.find(a => !a.startsWith('--') && rest[rest.indexOf(a) - 1] !== '--repo' && rest[rest.indexOf(a) - 1] !== '--gateway' && rest[rest.indexOf(a) - 1] !== '--model') ?? '') : '';
	if (cmd === 'run' && !goal) { log('riaf run needs a task string'); return 2; }
	const gateway = flag(rest, 'gateway');
	const model = flag(rest, 'model') ?? 'gpt-4o-mini';
	const callLLM = io.callLLM ?? (gateway ? gatewayCall(gateway, model, (io.env ?? process.env).RIAF_GATEWAY_KEY) : undefined);
	if (!callLLM) { log('Set --gateway or pass a model call.'); return 2; }
	const readFile = async (path: string) => { try { return readFileSync(join(repo, path), 'utf8'); } catch { return null; } };
	const existing = cmd === 'resume' ? (() => { const id = rest.find(a => !a.startsWith('--')); const rows = ledger.list(); const pick = id && !id.startsWith('-') ? id : rows[0]?.id; return pick ? ledger.load(pick) : null; })() : null;
	const run = await runTask({
		ledger, goal: existing?.goal ?? goal, userText: cmd === 'resume' ? 'continue' : goal, existing, callLLM,
		context: '',
		env: {
			readFile,
			runCommand: async command => {
				try {
					const { stdout, stderr } = await exec(command, { cwd: repo, shell: true, timeout: 120_000 });
					return { code: 0, output: `${stdout}${stderr}` };
				} catch (e) {
					const err = e as { code?: number; stdout?: string; stderr?: string };
					return { code: typeof err.code === 'number' ? err.code : 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
				}
			},
		},
		runSubtask: async (subtask, context) => {
			const res = await callLLM('Apply the subtask with a JSON array of {path, search, replace}. Change only what the goal requires.', context);
			const edits = parsePatchDocument(res.text);
			const digest: string[] = [];
			const byFile = new Map<string, { search: string; replace: string }[]>();
			for (const edit of edits) {
				const list = byFile.get(edit.path) ?? [];
				list.push({ search: edit.search, replace: edit.replace });
				byFile.set(edit.path, list);
			}
			for (const [path, blocks] of byFile) {
				const current = await readFile(path);
				if (current == null) { return { ok: false, digest, notes: `missing ${path}` }; }
				const applied = applyPatches(current, blocks);
				if (!applied.ok) { return { ok: false, digest, notes: applied.error }; }
				writeFileSync(join(repo, path), applied.text);
				digest.push(`edit ${path} (${blocks.length})`);
			}
			return { ok: true, digest, notes: edits.length ? '' : 'no edits', spend: { inputTokens: res.inputTokens ?? 0, outputTokens: res.outputTokens ?? 0 } };
		},
	});
	log(renderLedger(run));
	return run.status === 'done' ? 0 : 1;
}

/**
 * True only when Node was started on dist/cliMain.js.
 * Windows paths differ by drive-letter case (`C:` vs `c:`), so that compare is case-insensitive.
 * A bundled host (extension.js, mcp.mjs) does not match, and an empty import.meta.url returns false
 * instead of throwing.
 */
export function cliEntryMatches(entry: string | undefined, moduleUrl: string, platform = process.platform): boolean {
	if (!entry) { return false; }
	let selfPath: string;
	try { selfPath = fileURLToPath(moduleUrl); } catch { return false; }
	if (basename(selfPath) !== 'cliMain.js') { return false; }
	const selfUrl = pathToFileURL(resolve(selfPath)).href;
	const entryUrl = pathToFileURL(resolve(entry)).href;
	return platform === 'win32' ? selfUrl.toLowerCase() === entryUrl.toLowerCase() : selfUrl === entryUrl;
}
