/**
 * Audit log for integration write tools — `<workspace>/.riaf/audit.jsonl`, one JSON object per line.
 * Records who (consumer: riaf-agent / copilot / claude-code), what (adapter, tool, redacted args),
 * and the outcome. Reads are not audited (they would swamp the file); failed writes are.
 * No `vscode` import: the MCP server writes to the same file.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { previewArgs } from './index.js';

export type AuditConsumer = 'riaf-agent' | 'copilot' | 'claude-code' | 'panel' | string;

export type AuditEntry = {
	at: string; consumer: AuditConsumer; adapter: string; tool: string; kind: 'read' | 'write';
	args: string; ok: boolean; ms: number; approved?: 'dialog' | 'setting' | 'none'; result?: string; error?: string; user?: string;
};

export const auditPathFor = (workspaceRoot: string): string => join(workspaceRoot, '.riaf', 'audit.jsonl');

/** Roll over at ~5 MB so the file never grows without bound; the previous log is kept once. */
const MAX_BYTES = 5 * 1024 * 1024;

export function appendAudit(workspaceRoot: string, e: Omit<AuditEntry, 'at' | 'args'> & { args: Record<string, unknown> }): void {
	try {
		const path = auditPathFor(workspaceRoot);
		mkdirSync(join(workspaceRoot, '.riaf'), { recursive: true });
		if (existsSync(path) && statSync(path).size > MAX_BYTES) { renameSync(path, `${path}.1`); }
		const entry: AuditEntry = {
			at: new Date().toISOString(), consumer: e.consumer, adapter: e.adapter, tool: e.tool, kind: e.kind,
			args: previewArgs(e.args, 1_000), ok: e.ok, ms: e.ms, approved: e.approved,
			result: e.result?.slice(0, 300), error: e.error?.slice(0, 300), user: e.user,
		};
		appendFileSync(path, JSON.stringify(entry) + '\n');
	} catch { /* audit is best-effort */ }
}

export function readAudit(workspaceRoot: string, limit = 50): AuditEntry[] {
	try {
		const path = auditPathFor(workspaceRoot);
		if (!existsSync(path)) { return []; }
		const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
		return lines.slice(-limit).reverse().map(l => { try { return JSON.parse(l) as AuditEntry; } catch { return undefined; } }).filter((x): x is AuditEntry => !!x);
	} catch { return []; }
}
