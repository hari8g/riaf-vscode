/**
 * Checkpoints: before the agent's first write to a file in a turn, the original content is
 * captured; the developer can rewind the files of any turn (and, in the chat participant, the
 * conversation to that point). Snapshots are persisted as JSON so a rewind survives a reload.
 *
 * Shell deletes (rm, git clean) are not covered — that is a git problem, and run_command says so.
 *
 * No `vscode` import.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type FileSnapshot = { existed: boolean; content: string };

export type Checkpoint = {
	id: string;
	threadId: string;
	/** 1-based index of the user turn this checkpoint precedes. */
	turn: number;
	createdAt: number;
	/** First 120 chars of the user prompt, for the picker. */
	label: string;
	/** workspace-relative path → state before the first write of this turn */
	files: Record<string, FileSnapshot>;
};

export type RewindResult = { restored: string[]; deleted: string[]; failed: { path: string; error: string }[] };

export class CheckpointStore {
	constructor(private readonly dir: string, private readonly workspaceRoot: string) { }

	/** Start a checkpoint for a turn. Nothing is written until the first file is recorded. */
	begin(threadId: string, turn: number, prompt: string): Checkpoint {
		return { id: `${threadId}:${turn}`, threadId, turn, createdAt: Date.now(), label: prompt.replace(/\s+/g, ' ').trim().slice(0, 120), files: {} };
	}

	/** Record the pre-edit state of a file once per checkpoint (later edits in the turn keep the first snapshot). */
	record(cp: Checkpoint, relPath: string, original: string | null): void {
		if (cp.files[relPath]) { return; }
		cp.files[relPath] = original === null ? { existed: false, content: '' } : { existed: true, content: original };
		this.save(cp);
	}

	save(cp: Checkpoint): void {
		if (!Object.keys(cp.files).length) { return; }
		mkdirSync(join(this.dir, cp.threadId), { recursive: true });
		writeFileSync(join(this.dir, cp.threadId, `${cp.turn}.json`), JSON.stringify(cp));
	}

	list(threadId?: string): Checkpoint[] {
		if (!existsSync(this.dir)) { return []; }
		const threads = threadId ? [threadId] : readdirSync(this.dir);
		const out: Checkpoint[] = [];
		for (const t of threads) {
			const tdir = join(this.dir, t);
			if (!existsSync(tdir)) { continue; }
			for (const f of readdirSync(tdir)) {
				if (!f.endsWith('.json')) { continue; }
				try { out.push(JSON.parse(readFileSync(join(tdir, f), 'utf8')) as Checkpoint); } catch { /* skip */ }
			}
		}
		return out.sort((a, b) => b.createdAt - a.createdAt);
	}

	/**
	 * Restore every file of the given checkpoints (newest first, so the oldest snapshot wins for a
	 * file touched in several turns). Files created by the agent are deleted again.
	 */
	rewindFiles(checkpoints: Checkpoint[]): RewindResult {
		const result: RewindResult = { restored: [], deleted: [], failed: [] };
		const ordered = [...checkpoints].sort((a, b) => b.turn - a.turn);
		const done = new Set<string>();
		for (const cp of ordered) {
			for (const [rel, snap] of Object.entries(cp.files)) {
				const abs = join(this.workspaceRoot, rel);
				try {
					if (snap.existed) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, snap.content); if (!done.has(rel)) { result.restored.push(rel); } }
					else if (existsSync(abs)) { unlinkSync(abs); if (!done.has(rel)) { result.deleted.push(rel); } }
					done.add(rel);
				} catch (e) {
					result.failed.push({ path: rel, error: (e as Error).message });
				}
			}
		}
		// the restored state *is* the state before those turns: drop their checkpoints
		for (const cp of ordered) { this.remove(cp); }
		return result;
	}

	remove(cp: Checkpoint): void {
		try { unlinkSync(join(this.dir, cp.threadId, `${cp.turn}.json`)); } catch { /* gone */ }
	}

	clearThread(threadId: string): void {
		rmSync(join(this.dir, threadId), { recursive: true, force: true });
	}
}
