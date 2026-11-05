#!/usr/bin/env node
// RIAF tool-call governance hook for Claude Code (generated — do not edit; regenerate with `riaf init --host claude`).
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

const done = (out) => { if (out && Object.keys(out).length) process.stdout.write(JSON.stringify(out)); process.exit(0); };
if (process.env.RIAF_NO_GUARD === '1') done();
let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { done(); }
let payload;
try { payload = JSON.parse(raw || '{}'); } catch { done(); }
const root = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
let info;
try { info = JSON.parse(readFileSync(join(root, '.riaf', 'governor.json'), 'utf8')); } catch { done(); }
const timeoutMs = Number(process.env.RIAF_HOOK_TIMEOUT_MS || (payload.hook_event_name === 'UserPromptSubmit' || payload.hook_event_name === 'SessionStart' ? 8000 : 1500));
const sock = createConnection(info.endpoint);
let buf = '';
const timer = setTimeout(() => { sock.destroy(); done(); }, timeoutMs);
sock.setEncoding('utf8');
sock.on('connect', () => sock.write(JSON.stringify({ type: 'claude-hook', payload }) + '\n'));
sock.on('data', (d) => {
	buf += d;
	const nl = buf.indexOf('\n');
	if (nl < 0) return;
	clearTimeout(timer);
	sock.end();
	let res = {};
	try { res = JSON.parse(buf.slice(0, nl)); } catch { done(); }
	done(res && res.output ? res.output : undefined);
});
sock.on('error', () => { clearTimeout(timer); done(); });
