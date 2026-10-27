/**
 * User memory: "remember that …" is appended to ~/.riaf/memory.md and injected into the
 * stable system prompt on later turns. No `vscode` import.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const memoryDir = (home = homedir()): string => join(home, '.riaf');
export const memoryPath = (home = homedir()): string => join(memoryDir(home), 'memory.md');

/** A message that is only a remember-request, not a remember-request plus a task. */
export function extractRememberedFact(text: string): string | null {
	const m = text.trim().match(/^(?:please\s+)?remember(?:\s+that)?\s*[:\-]?\s+([\s\S]+)$/i);
	if (!m) { return null; }
	const fact = m[1].trim().replace(/\s+/g, ' ');
	if (!fact || fact.length > 2_000) { return null; }
	if (/\b(and then|and also|and fix|and edit|and add|and update|and change|and implement)\b/i.test(fact)) { return null; }
	return fact;
}

export function readMemory(home = homedir()): string {
	const p = memoryPath(home);
	if (!existsSync(p)) { return ''; }
	try { return readFileSync(p, 'utf8').trim(); } catch { return ''; }
}

export function appendMemory(fact: string, home = homedir()): void {
	const dir = memoryDir(home);
	mkdirSync(dir, { recursive: true });
	const p = memoryPath(home);
	const line = `- [${new Date().toISOString().slice(0, 10)}] ${fact.trim()}`;
	const prev = existsSync(p) ? readFileSync(p, 'utf8').trimEnd() : '# RIAF memory\n\nFacts the user asked the agent to remember.';
	writeFileSync(p, `${prev}\n${line}\n`);
}

export function memoryPromptBlock(text: string): string {
	const t = text.trim();
	if (!t) { return ''; }
	return `<user_memory>\nThe user asked you to remember the following. Follow it when it applies; do not recite it back unprompted.\n\n${t}\n</user_memory>`;
}
