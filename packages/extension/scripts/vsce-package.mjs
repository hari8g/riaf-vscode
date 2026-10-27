// Launch vsce through node so Windows does not depend on the .cmd shim or PATHEXT.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const vsce = require.resolve('@vscode/vsce/vsce');
const result = spawnSync(process.execPath, [
	vsce,
	'package',
	'--no-dependencies',
	'--allow-missing-repository',
	'--out',
	'../../riaf-vscode-0.1.0.vsix',
], { stdio: 'inherit', windowsHide: true });
if (result.error) { console.error(result.error); process.exit(1); }
process.exit(result.status ?? 1);
