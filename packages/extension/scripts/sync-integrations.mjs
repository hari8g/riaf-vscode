// Keeps package.json in step with the integration adapters (src/integrations/*):
//   - contributes.configuration: riaf.integrations.<id> objects whose properties mirror each adapter's settingsSchema
//   - contributes.languageModelTools: every integration *read* tool as riaf_<tool> for Copilot (#riaf…)
// Run `node scripts/sync-integrations.mjs` after changing an adapter; `--check` exits 1 when package.json is stale
// (test/integrations/sync.test.ts runs that check).
import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const check = process.argv.includes('--check');

const tmp = mkdtempSync(join(tmpdir(), 'riaf-int-'));
const out = join(tmp, 'integrations.mjs');
await esbuild.build({ entryPoints: [resolve(root, 'src/integrations/index.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent', external: ['vscode'] });
const mod = await import(pathToFileURL(out).href);
rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

const pkgPath = resolve(root, 'package.json');
const raw = readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(raw);

// ── configuration ──
const props = pkg.contributes.configuration.properties;
for (const adapter of mod.allAdapters()) {
	const properties = { enabled: { type: 'boolean', default: false, description: `Enable the ${adapter.displayName} tools for @riaf, Copilot (#riaf…) and the Claude Code MCP server.` } };
	for (const [k, v] of Object.entries(adapter.settingsSchema)) {
		const prop = { type: v.type === 'enum' ? 'string' : v.type, description: v.description };
		if (v.enum) { prop.enum = v.enum; }
		if (v.default !== undefined) { prop.default = v.default; }
		properties[k] = prop;
	}
	const creds = adapter.credentials.map(c => c.label).join(', ');
	props[`riaf.integrations.${adapter.id}`] = {
		type: 'object',
		default: { enabled: false },
		description: `${adapter.displayName} integration. Credentials (${creds}) are NOT settings — run "RIAF: Set Integration Credentials"; they live in the OS credential store.`,
		properties,
		additionalProperties: false,
	};
}
props['riaf.integrations.shareCredentialsWithClaudeCode'] ??= {
	type: 'boolean', default: false,
	description: 'Also write integration credentials to ~/.riaf/credentials.json (mode 0600) so the RIAF MCP server used by Claude Code can call Jira / Confluence / GitLab / knowledge stores. Off = Claude Code needs RIAF_INTEGRATION_* environment variables instead.',
};
props['riaf.agent.approveIntegrationWrites'] ??= {
	type: 'boolean', default: true,
	description: 'Ask before an integration tool changes data (create Jira issue, comment on a merge request, update a Confluence page, …). Every write is recorded in .riaf/audit.jsonl either way.',
};

// ── languageModelTools ──
const lm = pkg.contributes.languageModelTools;
const integrationNames = new Set(mod.INTEGRATION_TOOL_SPECS.map(t => `riaf_${t.name}`));
const kept = lm.filter(t => !integrationNames.has(t.name));
const toRef = name => 'riaf' + name.split('_').map(s => s[0].toUpperCase() + s.slice(1)).join('');
for (const adapter of mod.allAdapters()) {
	for (const t of adapter.tools.filter(t => t.kind === 'read')) {
		kept.push({
			name: `riaf_${t.name}`,
			displayName: `${t.label} (RIAF · ${adapter.displayName})`,
			toolReferenceName: toRef(t.name),
			canBeReferencedInPrompt: true,
			userDescription: `${adapter.displayName}: ${t.label}. Needs riaf.integrations.${adapter.id}.enabled.`,
			modelDescription: t.description,
			icon: adapter.id === 'jira' ? '$(issues)' : adapter.id === 'confluence' ? '$(book)' : adapter.id === 'gitlab' ? '$(git-merge)' : '$(database)',
			inputSchema: t.inputSchema,
		});
	}
}
pkg.contributes.languageModelTools = kept;

const next = JSON.stringify(pkg, null, 2) + '\n';
if (check) {
	if (next !== raw) { console.error('package.json is out of step with src/integrations — run: node scripts/sync-integrations.mjs'); process.exit(1); }
	console.log('package.json integrations in sync');
} else {
	writeFileSync(pkgPath, next);
	console.log(`package.json updated: ${mod.allAdapters().length} integration settings, ${kept.length - lm.filter(t => !integrationNames.has(t.name)).length} LM read tools`);
}
