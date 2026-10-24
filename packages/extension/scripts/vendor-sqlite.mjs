// Copies the sqlite-wasm node build and the tree-sitter runtime + grammars next to the bundle so
// the .vsix is self-contained (no node_modules shipped, nothing downloaded at install time behind
// a corporate proxy).
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);

// sqlite
const sqlitePkg = require.resolve('@sqlite.org/sqlite-wasm/package.json');
const sqliteDist = join(dirname(sqlitePkg), 'dist');
const sqliteOut = join(process.cwd(), 'dist', 'vendor', 'sqlite-wasm');
mkdirSync(sqliteOut, { recursive: true });
for (const f of ['node.mjs', 'sqlite3.wasm']) cpSync(join(sqliteDist, f), join(sqliteOut, f));
console.log('vendored sqlite-wasm →', sqliteOut);

// tree-sitter runtime + grammars (optional: the index falls back to regex chunking without them)
try {
	const tsPkg = require.resolve('@vscode/tree-sitter-wasm/package.json');
	const tsWasm = join(dirname(tsPkg), 'wasm');
	const tsOut = join(process.cwd(), 'dist', 'vendor', 'tree-sitter');
	mkdirSync(tsOut, { recursive: true });
	let n = 0;
	for (const f of readdirSync(tsWasm)) {
		if (f === 'tree-sitter.js' || f.endsWith('.wasm')) { cpSync(join(tsWasm, f), join(tsOut, f)); n++; }
	}
	console.log(`vendored tree-sitter (${n} files) →`, tsOut);
} catch (e) {
	console.warn('tree-sitter wasm not vendored:', e.message);
}
