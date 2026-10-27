#!/usr/bin/env node
import { cliEntryMatches, executeCli } from './cli.js';

if (cliEntryMatches(process.argv[1], import.meta.url)) {
	executeCli(process.argv.slice(2)).then(code => process.exit(code)).catch(e => { console.error(e); process.exit(1); });
}
