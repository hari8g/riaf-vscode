/**
 * `riaf init --host claude`: writes the RIAF 2.0 Claude Code integration into a repository —
 * the governance hook client, its hook groups in `.claude/settings.json`, `.riaf/policy.yaml`,
 * the retrieval-before-tool block in `CLAUDE.md`, and (when a server command is known) `.mcp.json`.
 * The VS Code extension's "Set up Claude Code" calls the same function.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { upsertClaudeMd } from '@bosch-mps/riaf-core';
import { ensurePolicyFile, GOVERN_HOOK_FILENAME, GOVERN_HOOK_SOURCE, mergeGovernHooks } from '@bosch-mps/token-opt';

export const governHookCommand = (repo: string): string => `node "${join(repo, '.claude', 'hooks', GOVERN_HOOK_FILENAME)}"`;

const readJson = (p: string): Record<string, unknown> => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; } };

export interface ClaudeInitOptions {
	/** Command + args that start the RIAF MCP server; written to `.mcp.json` as server "riaf". */
	mcp?: { command: string; args: string[] };
}

export function writeClaudeGovernance(repo: string, opts: ClaudeInitOptions = {}): string[] {
	const written: string[] = [];
	const hookDir = join(repo, '.claude', 'hooks');
	mkdirSync(hookDir, { recursive: true });
	writeFileSync(join(hookDir, GOVERN_HOOK_FILENAME), GOVERN_HOOK_SOURCE);
	written.push(join(hookDir, GOVERN_HOOK_FILENAME));
	const settingsPath = join(repo, '.claude', 'settings.json');
	writeFileSync(settingsPath, JSON.stringify(mergeGovernHooks(existsSync(settingsPath) ? readJson(settingsPath) : {}, governHookCommand(repo)), null, 2) + '\n');
	written.push(settingsPath);
	written.push(ensurePolicyFile(repo));
	const claudeMd = join(repo, 'CLAUDE.md');
	writeFileSync(claudeMd, upsertClaudeMd(existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : ''));
	written.push(claudeMd);
	if (opts.mcp) {
		const mcpPath = join(repo, '.mcp.json');
		const mcp = readJson(mcpPath) as { mcpServers?: Record<string, unknown> };
		mcp.mcpServers = { ...(mcp.mcpServers ?? {}), riaf: { command: opts.mcp.command, args: opts.mcp.args, env: {} } };
		writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
		written.push(mcpPath);
	}
	const gi = join(repo, '.gitignore');
	const ignore = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
	if (!/^\.riaf\/?$/m.test(ignore) && !/^\.riaf\/index/m.test(ignore)) {
		writeFileSync(gi, `${ignore.replace(/\s*$/, '')}${ignore.trim() ? '\n' : ''}# RIAF local index, governor endpoint and caches (policy.yaml is meant to be committed)\n.riaf/*\n!.riaf/policy.yaml\n.claude/riaf/\n`);
		written.push(gi);
	}
	return written;
}
