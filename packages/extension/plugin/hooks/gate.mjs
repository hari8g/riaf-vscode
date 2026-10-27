#!/usr/bin/env node
/**
 * Claude Code hook. `node gate.mjs stop <repo>` exits 2 while the latest run is not done.
 * `node gate.mjs pretool` reads a PreToolUse payload on stdin and exits 2 for heredocs and the built-in deny list.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DENY = [
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)/,
	/\bsudo\b/,
	/<<-?\s*['"]?[A-Za-z_]/,
	/\bcurl\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/,
];

function latestRun(repo) {
	const dir = join(repo, '.riaf', 'runs');
	let names = [];
	try { names = readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return null; }
	let best = null;
	for (const name of names) {
		try {
			const run = JSON.parse(readFileSync(join(dir, name), 'utf8'));
			if (!best || (run.updatedAt ?? 0) > (best.updatedAt ?? 0)) { best = run; }
		} catch { /* skip */ }
	}
	return best;
}

const mode = process.argv[2];
const repo = process.argv[3] || process.cwd();
if (mode === 'stop') {
	const run = latestRun(repo);
	if (run && run.status !== 'done' && run.status !== 'cancelled') {
		process.stderr.write(`RIAF run ${run.id} is ${run.status}. Finish or cancel it before stopping.\n`);
		process.exit(2);
	}
	process.exit(0);
}
if (mode === 'pretool') {
	const raw = readFileSync(0, 'utf8');
	let payload = {};
	try { payload = JSON.parse(raw || '{}'); } catch { process.exit(0); }
	const command = String(payload.tool_input?.command ?? payload.tool_input?.cmd ?? '');
	const hit = DENY.find(re => re.test(command));
	if (hit) { process.stderr.write(`RIAF blocked this command (${hit}).\n`); process.exit(2); }
	process.exit(0);
}
process.stderr.write('usage: gate.mjs stop <repo> | pretool\n');
process.exit(2);
