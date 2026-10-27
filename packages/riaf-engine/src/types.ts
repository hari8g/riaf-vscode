/** On-disk shape of `.riaf/runs/<id>.json`. Bump only with a migrate step. */
export const LEDGER_VERSION = 1 as const;

export type SubtaskStatus = 'pending' | 'running' | 'done' | 'blocked' | 'skipped';
export type RunStatus = 'planned' | 'running' | 'blocked' | 'done' | 'cancelled';

/** What must be true before a subtask counts as done. The verifier (Phase C.4) executes these. */
export type AcceptanceCheck =
	| { kind: 'command'; command: string }
	| { kind: 'grep'; pattern: string; path?: string }
	| { kind: 'diagnostics'; path: string };

export type SubtaskBudget = { maxIterations: number; maxTokens: number };

export type Subtask = {
	id: string;
	goal: string;
	files: string[];
	acceptance: AcceptanceCheck[];
	dependsOn: string[];
	budget: SubtaskBudget;
	status: SubtaskStatus;
	attempts: number;
	/** Short lines ("edit_file src/a.ts", "run_tests failed") so a resume does not need the whole transcript. */
	toolDigest: string[];
	notes: string;
};

export type LedgerEventType =
	| 'planned' | 'started' | 'subtask_running' | 'subtask_done' | 'subtask_blocked'
	| 'subtask_skipped' | 'verified' | 'critic' | 'replanned' | 'cancelled' | 'spend' | 'checkpoint';

export type LedgerEvent = {
	at: number;
	type: LedgerEventType;
	subtaskId?: string;
	message: string;
};

export type RunSpend = { inputTokens: number; outputTokens: number; costUSD: number };

export type RunCheckpoint = { at: number; label: string; subtaskId?: string };

export type RunLedger = {
	version: typeof LEDGER_VERSION;
	id: string;
	goal: string;
	createdAt: number;
	updatedAt: number;
	status: RunStatus;
	subtasks: Subtask[];
	spend: RunSpend;
	checkpoints: RunCheckpoint[];
	events: LedgerEvent[];
};

export type NewSubtask = Omit<Subtask, 'status' | 'attempts' | 'toolDigest' | 'notes'> & {
	status?: SubtaskStatus;
	notes?: string;
};
