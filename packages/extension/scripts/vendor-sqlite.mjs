// Copies the sqlite-wasm node build next to the bundle so the .vsix is self-contained
// (no node_modules shipped, nothing downloaded at install time behind a corporate proxy).
import { cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const pkgJson = require.resolve('@sqlite.org/sqlite-wasm/package.json');
const dist = join(dirname(pkgJson), 'dist');
const out = join(process.cwd(), 'dist', 'vendor', 'sqlite-wasm');
mkdirSync(out, { recursive: true });
for (const f of ['node.mjs', 'sqlite3.wasm']) cpSync(join(dist, f), join(out, f));
console.log('vendored sqlite-wasm →', out);
