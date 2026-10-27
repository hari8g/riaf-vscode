/**
 * Persisted @riaf threads so rewind and plan continuation survive a window reload.
 * One JSON file per thread under the extension's global storage. No `vscode` import.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage } from '@bosch-mps/token-opt';

export type PersistedThread = {
	history: ChatMessage[];
	turnStarts: ChatMessage[][];
	root: string;
};

const safeId = (threadId: string): string => threadId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);

export function loadThread(dir: string, threadId: string): PersistedThread | undefined {
	const p = join(dir, `${safeId(threadId)}.json`);
	if (!existsSync(p)) { return undefined; }
	try {
		const raw = JSON.parse(readFileSync(p, 'utf8')) as PersistedThread;
		if (!raw || !Array.isArray(raw.history) || !Array.isArray(raw.turnStarts)) { return undefined; }
		return raw;
	} catch { return undefined; }
}

export function saveThread(dir: string, threadId: string, thread: PersistedThread): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${safeId(threadId)}.json`), JSON.stringify(thread));
}
