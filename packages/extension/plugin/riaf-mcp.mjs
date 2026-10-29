#!/usr/bin/env node
/**
 * RIAF MCP launcher — written into <repo>/.riaf/riaf-mcp.mjs by "RIAF: Set up Claude Code".
 *
 * Why a launcher: the extension's install folder carries its version
 * (…/extensions/bosch-mps.riaf-vscode-0.2.0/), so a .mcp.json that points straight at
 * dist/mcp.mjs breaks on every upgrade. This file finds the newest installed RIAF extension
 * at run time and starts its MCP server, so .mcp.json never has to change.
 *
 * Resolution order: RIAF_EXTENSION_DIR env → newest bosch-mps.riaf-vscode-* under the
 * VS Code / Insiders / VSCodium / Cursor extension folders (and VSCODE_EXTENSIONS) → error.
 * All other arguments (--workspace, --db, --reindex) are passed through untouched.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ID = 'bosch-mps.riaf-vscode';
const home = homedir();
const roots = [
	process.env.VSCODE_EXTENSIONS,
	join(home, '.vscode', 'extensions'),
	join(home, '.vscode-insiders', 'extensions'),
	join(home, '.vscode-server', 'extensions'),
	join(home, '.vscode-oss', 'extensions'),
	join(home, '.cursor', 'extensions'),
].filter(Boolean);

const parseVersion = s => s.split(/[.-]/).map(n => Number(n) || 0);
const newer = (a, b) => { const x = parseVersion(a), y = parseVersion(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) { return (x[i] || 0) > (y[i] || 0); } } return false; };

function findExtensionDir() {
	if (process.env.RIAF_EXTENSION_DIR && existsSync(join(process.env.RIAF_EXTENSION_DIR, 'dist', 'mcp.mjs'))) { return process.env.RIAF_EXTENSION_DIR; }
	let best;
	for (const root of roots) {
		let names = [];
		try { names = readdirSync(root); } catch { continue; }
		for (const n of names) {
			if (!n.startsWith(ID + '-')) { continue; }
			const dir = join(root, n);
			if (!existsSync(join(dir, 'dist', 'mcp.mjs'))) { continue; }
			const version = n.slice(ID.length + 1);
			if (!best || newer(version, best.version)) { best = { dir, version }; }
		}
	}
	return best?.dir;
}

const dir = findExtensionDir();
if (!dir) {
	process.stderr.write(`[riaf-mcp] RIAF extension not found under ${roots.join(', ')}. Install riaf-vscode in VS Code, or set RIAF_EXTENSION_DIR.\n`);
	process.exit(2);
}
process.stderr.write(`[riaf-mcp] using ${dir}\n`);
await import(pathToFileURL(join(dir, 'dist', 'mcp.mjs')).href);
