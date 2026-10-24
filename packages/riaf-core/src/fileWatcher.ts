/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt in project root.
 *--------------------------------------------------------------------------------------*/

import { EventEmitter } from 'events';
import { join, relative } from 'path';
import { readdirSync, statSync, watch as fsWatch } from 'fs';

const WATCH_DEBOUNCE_MS = 2000;

const IGNORE_DIRS = new Set([
	'node_modules', '.git', 'dist', 'build', 'out', 'target', '.gradle',
	'__pycache__', '.venv', '.tox', '.next', '.nuxt', 'coverage', '.cache', 'vendor',
]);

const IGNORE_EXTENSIONS = new Set([
	'.class', '.pyc', '.pyo', '.o', '.obj', '.dll', '.so', '.dylib',
	'.map', '.min.js', '.d.ts',
]);

export type FileChangeEvent = {
	type: 'add' | 'change' | 'unlink';
	filePath: string; // relative to workspaceRoot, forward-slash separated
};

/** Lightweight recursive file watcher using Node's built-in fs.watch. */
export class WorkspaceFileWatcher extends EventEmitter {
	private _watchers: Map<string, ReturnType<typeof fsWatch>> = new Map();
	private _pending: Map<string, FileChangeEvent> = new Map();
	private _timer: ReturnType<typeof setTimeout> | null = null;
	private _workspaceRoot = '';

	start(workspaceRoot: string): void {
		this._workspaceRoot = workspaceRoot;
		this._watchDir(workspaceRoot);
	}

	private _watchDir(absDir: string): void {
		if (this._watchers.has(absDir)) return;

		let watcher: ReturnType<typeof fsWatch>;
		try {
			watcher = fsWatch(absDir, { persistent: false }, (eventType, filename) => {
				if (!filename) return;
				const fullPath = join(absDir, filename);
				const relPath = relative(this._workspaceRoot, fullPath).replace(/\\/g, '/');
				if (this._shouldIgnore(relPath)) return;

				let type: FileChangeEvent['type'];
				try {
					const stat = statSync(fullPath);
					if (stat.isDirectory()) {
						// New directory — watch it
						this._watchDir(fullPath);
						return;
					}
					type = eventType === 'rename' ? 'add' : 'change';
				} catch {
					// stat failed → file deleted
					type = 'unlink';
					this._watchers.get(fullPath)?.close();
					this._watchers.delete(fullPath);
				}

				this._schedule(relPath, type);
			});
		} catch {
			return;
		}

		this._watchers.set(absDir, watcher);

		// Recursively watch subdirectories that already exist
		try {
			for (const entry of readdirSync(absDir)) {
				if (IGNORE_DIRS.has(entry) || entry.startsWith('.')) continue;
				const full = join(absDir, entry);
				try {
					if (statSync(full).isDirectory()) this._watchDir(full);
				} catch { /* ignore */ }
			}
		} catch { /* ignore */ }
	}

	private _shouldIgnore(relPath: string): boolean {
		const parts = relPath.split('/');
		if (parts.some(p => IGNORE_DIRS.has(p))) return true;
		const ext = relPath.slice(relPath.lastIndexOf('.'));
		return IGNORE_EXTENSIONS.has(ext);
	}

	private _schedule(relPath: string, type: FileChangeEvent['type']): void {
		this._pending.set(relPath, { type, filePath: relPath });
		if (this._timer) clearTimeout(this._timer);
		this._timer = setTimeout(() => {
			const events = [...this._pending.values()];
			this._pending.clear();
			this._timer = null;
			this.emit('changes', events);
		}, WATCH_DEBOUNCE_MS);
	}

	stop(): void {
		for (const w of this._watchers.values()) {
			try { w.close(); } catch { /* ignore */ }
		}
		this._watchers.clear();
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = null;
		}
		this._pending.clear();
	}
}
