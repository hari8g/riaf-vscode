import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setSqliteModuleLoader, setTreeSitterWasmDir } from '@bosch-mps/riaf-core';

/**
 * The extension bundle is CommonJS (VS Code requires it), but @sqlite.org/sqlite-wasm is
 * ESM-only and finds sqlite3.wasm via import.meta.url. We therefore ship the package's
 * node build under dist/vendor/sqlite-wasm/ (scripts/vendor-sqlite.mjs) and load it with a
 * genuine dynamic import by absolute file URL. `new Function` keeps esbuild from rewriting
 * the import() into a require().
 */
const realDynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;

export function installSqliteLoader(extensionRoot: string): void {
	const candidates = [
		join(extensionRoot, 'dist', 'vendor', 'sqlite-wasm', 'node.mjs'),
		// dev fallback when running from source with a hoisted node_modules
		join(extensionRoot, '..', '..', 'node_modules', '@sqlite.org', 'sqlite-wasm', 'dist', 'node.mjs'),
		join(extensionRoot, 'node_modules', '@sqlite.org', 'sqlite-wasm', 'dist', 'node.mjs'),
	];
	const found = candidates.find(p => existsSync(p));
	if (!found) {
		throw new Error(`RIAF: sqlite-wasm not found. Looked in:\n${candidates.join('\n')}`);
	}
	setSqliteModuleLoader(() => realDynamicImport(pathToFileURL(found).href));
	installTreeSitterDir(extensionRoot);
}

/**
 * Tree-sitter grammars are vendored the same way (dist/vendor/tree-sitter). Optional: when the
 * directory is missing riaf-core falls back to its regex chunker.
 */
export function installTreeSitterDir(extensionRoot: string): string | undefined {
	const candidates = [
		join(extensionRoot, 'dist', 'vendor', 'tree-sitter'),
		join(extensionRoot, '..', '..', 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm'),
		join(extensionRoot, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm'),
	];
	const found = candidates.find(p => existsSync(join(p, 'tree-sitter.wasm')));
	if (found) { setTreeSitterWasmDir(found); }
	return found;
}
