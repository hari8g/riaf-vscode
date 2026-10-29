/**
 * How the MCP server (Claude Code) learns about integrations. It runs outside VS Code, so it has
 * neither `riaf.*` settings nor SecretStorage:
 *
 *  - non-secret config (enabled flags, base URLs, defaults) → `<workspace>/.riaf/integrations.json`,
 *    written by the extension whenever `riaf.integrations.*` changes and by "Set up Claude Code";
 *  - credentials → environment variables `RIAF_INTEGRATION_<ID>_<KEY>` (e.g. RIAF_INTEGRATION_JIRA_TOKEN),
 *    else the opt-in `~/.riaf/credentials.json` (mode 0600) that the extension writes only when
 *    `riaf.integrations.shareCredentialsWithClaudeCode` is on.
 *
 * Nothing secret is ever written under the workspace.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IntegrationsConfig } from './index.js';

export const integrationsConfigPath = (workspaceRoot: string): string => join(workspaceRoot, '.riaf', 'integrations.json');
export const credentialsFilePath = (): string => process.env.RIAF_CREDENTIALS_FILE || join(homedir(), '.riaf', 'credentials.json');

const SECRET_KEY_RE = /token|password|secret|apikey|api_key/i;

/** Strip anything that looks like a credential so a mistaken caller cannot put secrets in the repo. */
export function sanitizeIntegrationsConfig(cfg: IntegrationsConfig): IntegrationsConfig {
	const out: IntegrationsConfig = {};
	for (const [id, settings] of Object.entries(cfg) as [keyof IntegrationsConfig, Record<string, unknown> | undefined][]) {
		if (!settings) { continue; }
		out[id] = Object.fromEntries(Object.entries(settings).filter(([k]) => !SECRET_KEY_RE.test(k)));
	}
	return out;
}

export function writeIntegrationsConfig(workspaceRoot: string, cfg: IntegrationsConfig): string {
	const path = integrationsConfigPath(workspaceRoot);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ $comment: 'Written by the RIAF VS Code extension from riaf.integrations.*; read by the RIAF MCP server. No credentials here.', ...sanitizeIntegrationsConfig(cfg) }, null, 2) + '\n');
	return path;
}

export function readIntegrationsConfig(workspaceRoot: string): IntegrationsConfig {
	try {
		const path = integrationsConfigPath(workspaceRoot);
		if (!existsSync(path)) { return {}; }
		const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
		delete raw.$comment;
		return sanitizeIntegrationsConfig(raw as IntegrationsConfig);
	} catch { return {}; }
}

/** `riaf.integration.jira.token` → `RIAF_INTEGRATION_JIRA_TOKEN`. */
export const envVarForSecret = (secretKey: string): string => secretKey.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

export function readCredentialsFile(): Record<string, string> {
	try {
		const p = credentialsFilePath();
		if (!existsSync(p)) { return {}; }
		const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
		return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
	} catch { return {}; }
}

/** Merge (or, with `undefined`, delete) entries; file is created 0600 and kept that way. */
export function writeCredentialsFile(entries: Record<string, string | undefined>): string {
	const p = credentialsFilePath();
	mkdirSync(dirname(p), { recursive: true });
	const current = readCredentialsFile();
	for (const [k, v] of Object.entries(entries)) { if (v === undefined || v === '') { delete current[k]; } else { current[k] = v; } }
	writeFileSync(p, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
	try { chmodSync(p, 0o600); } catch { /* Windows */ }
	return p;
}

/** Secret getter for the MCP server: env var first, then the opt-in credentials file. */
export function mcpSecretGetter(): (key: string) => Promise<string | undefined> {
	let file: Record<string, string> | undefined;
	return async (key: string) => {
		const fromEnv = process.env[envVarForSecret(key)];
		if (fromEnv) { return fromEnv; }
		file ??= readCredentialsFile();
		return file[key];
	};
}
