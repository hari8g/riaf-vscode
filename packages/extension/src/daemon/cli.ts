/**
 * Standalone RIAF daemon + console (no VS Code):
 *   node dist/daemon.mjs --workspace /path/to/repo [--db path] [--port 7421] [--reindex] [--open] [--no-govern]
 * Serves the RIAF Console at http://127.0.0.1:<port>/ over the same index the MCP server uses.
 * Credentials come from RIAF_INTEGRATION_* env vars or ~/.riaf/credentials.json (0600).
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { RiafIndex, Riaf2, setSqliteModuleLoader, setTreeSitterWasmDir } from '@bosch-mps/riaf-core';
import { Riaf2Host } from '../riaf2Host.js';
import { RiafDaemon } from './server.js';
import { mcpSecretGetter, readIntegrationsConfig, writeCredentialsFile, writeIntegrationsConfig } from '../integrations/mcpConfig.js';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const workspaceRoot = resolve(flag('workspace') ?? process.cwd());
const dbPath = flag('db') ?? join(workspaceRoot, '.riaf', 'index.sqlite');
const port = Number(flag('port') ?? process.env.RIAF_CONSOLE_PORT ?? 7421);
const log = (m: string) => process.stderr.write(`[riafd] ${m}\n`);

const here = dirname(fileURLToPath(import.meta.url));
const wasmEntry = [join(here, 'vendor', 'sqlite-wasm', 'node.mjs'), join(here, '..', '..', '..', 'node_modules', '@sqlite.org', 'sqlite-wasm', 'dist', 'node.mjs')].find(existsSync);
if (wasmEntry) { setSqliteModuleLoader(() => import(pathToFileURL(wasmEntry).href)); }
const tsDir = [join(here, 'vendor', 'tree-sitter'), join(here, '..', '..', '..', 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')].find(d => existsSync(join(d, 'tree-sitter.wasm')));
if (tsDir) { setTreeSitterWasmDir(tsDir); }

const index = await RiafIndex.open({ workspaceRoot, dbPath, log });
if (!index.getStatus().indexed || args.includes('--reindex')) {
	log(`indexing ${workspaceRoot}…`);
	await index.reindex({ onProgress: p => p.done === p.total && log(`${p.phase} done`) });
}
index.startWatching();
const riaf2 = Riaf2.fromIndex(index, { log, llmSummaries: false });
const host = new Riaf2Host(riaf2, { host: 'console', log, governEnabled: !args.includes('--no-guard') });
void (async () => { try { await riaf2.history?.mine(); await riaf2.summaries.build(); } catch (e) { log(`history/summaries skipped: ${String(e)}`); } })();
if (!args.includes('--no-govern')) { host.startGovernor().then(ep => log(`governor endpoint ${ep}`), e => log(`governor not started: ${String(e)}`)); }

const getSecret = mcpSecretGetter();
const daemon = new RiafDaemon({
	root: workspaceRoot, host, version: process.env.RIAF_VERSION ?? 'cli', surface: 'cli',
	consoleDir: [join(here, 'console'), join(here, '..', 'dist', 'console')].find(d => existsSync(join(d, 'index.html'))),
	extensionPath: resolve(here, '..'),
	integrations: {
		config: () => readIntegrationsConfig(workspaceRoot),
		saveConfig: cfg => { writeIntegrationsConfig(workspaceRoot, cfg); },
		getSecret,
		setSecret: async (key, value) => { writeCredentialsFile({ [key]: value }); },
		fetch: (u, i) => fetch(u, i),
	},
	reindex: force => riaf2.indexRepo({ force }),
	log,
});
const info = await daemon.start(port);
log(`RIAF Console: ${info.url}`);
if (args.includes('--open')) {
	const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', info.url]] as const : process.platform === 'darwin' ? ['open', [info.url]] as const : ['xdg-open', [info.url]] as const;
	try { spawn(cmd[0], [...cmd[1]], { detached: true, stdio: 'ignore' }).unref(); } catch { /* best effort */ }
}
const shutdown = async () => { await daemon.stop(); await host.stop(); await index.close(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
