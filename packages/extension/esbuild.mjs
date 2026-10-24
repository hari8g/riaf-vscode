// Bundles the extension host entry (CJS, VS Code requires it) and the MCP server entry (ESM, run by node).
// Both pull @bosch-mps/riaf-core and @bosch-mps/token-opt from source via workspaces.
// @sqlite.org/sqlite-wasm stays external: it is ESM-only and resolves sqlite3.wasm via import.meta.url,
// so we vendor it next to the bundle (scripts/vendor-sqlite.mjs) and dynamic-import it by file URL.
import * as esbuild from 'esbuild';
import { rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
rmSync('dist', { recursive: true, force: true });

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  external: ['vscode', '@sqlite.org/sqlite-wasm'],
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
};

const extension = esbuild.context({
  ...common,
  entryPoints: { extension: 'src/extension.ts' },
  format: 'cjs',
  outdir: 'dist',
});

const mcp = esbuild.context({
  ...common,
  entryPoints: { mcp: 'src/mcp.ts' },
  format: 'esm',
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

const ctxs = await Promise.all([extension, mcp]);
if (watch) {
  await Promise.all(ctxs.map(c => c.watch()));
  console.log('watching…');
} else {
  await Promise.all(ctxs.map(c => c.rebuild()));
  await Promise.all(ctxs.map(c => c.dispose()));
}
