// Bundles the extension host entry (CJS, VS Code requires it) and the MCP server entry (ESM, run by node).
// Workspace packages are bundled from TypeScript source. Their package exports point at dist/, which
// does not exist on a clean checkout, and `npm run build -ws` builds this package first.
// @sqlite.org/sqlite-wasm stays external: it is ESM-only and resolves sqlite3.wasm via import.meta.url,
// so we vendor it next to the bundle (scripts/vendor-sqlite.mjs) and dynamic-import it by file URL.
import * as esbuild from 'esbuild';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const here = dirname(fileURLToPath(import.meta.url));
const packages = resolve(here, '..');
// Windows holds dist files open briefly (AV, extension host). Retry instead of failing the build.
rmSync(resolve(here, 'dist'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

const alias = {
  '@bosch-mps/riaf-core': resolve(packages, 'riaf-core/src/index.ts'),
  '@bosch-mps/token-opt': resolve(packages, 'token-opt/src/index.ts'),
  '@bosch-mps/riaf-engine': resolve(packages, 'riaf-engine/src/index.ts'),
};

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  alias,
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
  entryPoints: { mcp: 'src/mcp.ts', 'proxy-bridge': 'src/proxyBridgeCli.ts' },
  format: 'esm',
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

// Settings panel UI (browser, IIFE) — React + the bridge, loaded by the WebviewPanel from dist/webview.js.
const webview = esbuild.context({
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
  entryPoints: { webview: 'webview/main.tsx' },
  outdir: 'dist',
});

const ctxs = await Promise.all([extension, mcp, webview]);
if (watch) {
  await Promise.all(ctxs.map(c => c.watch()));
  console.log('watching…');
} else {
  await Promise.all(ctxs.map(c => c.rebuild()));
  await Promise.all(ctxs.map(c => c.dispose()));
}
