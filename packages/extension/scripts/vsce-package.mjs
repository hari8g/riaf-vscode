// Launch vsce through node so Windows does not depend on the .cmd shim or PATHEXT.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const vsce = require.resolve('@vscode/vsce/vsce');
const { name, version } = require('../package.json');   // output name follows the manifest version
const result = spawnSync(process.execPath, [
	vsce,
	'package',
	'--no-dependencies',
	'--allow-missing-repository',
	'--out',
	`../../${name}-${version}.vsix`,
], { stdio: 'inherit', windowsHide: true });
if (result.error) { console.error(result.error); process.exit(1); }
process.exit(result.status ?? 1);
