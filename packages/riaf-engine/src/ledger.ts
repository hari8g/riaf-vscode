import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEDGER_VERSION, type LedgerEvent, type LedgerEventType, type NewSubtask, type RunLedger, type RunSpend, type RunStatus, type Subtask, type SubtaskStatus } from './types.js';

export type LedgerListener = (event: LedgerEvent & { runId: string }) => void;

/** In-process fan-out. The file is the source of truth; listeners are for the chat UI and the CLI. */
export class LedgerBus {
	private readonly listeners = new Set<LedgerListener>();
	subscribe(listener: LedgerListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	emit(runId: string, event: LedgerEvent): void {
		for (const listener of this.listeners) { listener({ ...event, runId }); }
	}
}

const EMPTY_SPEND = (): RunSpend => ({ inputTokens: 0, outputTokens: 0, costUSD: 0 });

export function assertRunId(id: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(id)) {
		throw new Error(`invalid run id "${id}" (use letters, digits, "_" and "-")`);
	}
	return id;
}

function newRunId(now: number): string {
	return `run-${now.toString(36)}-${randomBytes(3).toString('hex')}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Accept the current shape, and a version-less object that already has a goal and subtasks. */
export function migrateLedger(raw: unknown): RunLedger {
	if (!isRecord(raw)) { throw new Error('ledger is not a JSON object'); }
	const version = raw.version === undefined ? 0 : raw.version;
	if (version !== 0 && version !== LEDGER_VERSION) {
		throw new Error(`unsupported ledger version ${String(version)}`);
	}
	if (typeof raw.id !== 'string' || typeof raw.goal !== 'string' || !Array.isArray(raw.subtasks)) {
		throw new Error('ledger is missing id, goal, or subtasks');
	}
	const id = assertRunId(raw.id);
	const now = typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now();
	const spend = isRecord(raw.spend) ? {
		inputTokens: Number(raw.spend.inputTokens) || 0,
		outputTokens: Number(raw.spend.outputTokens) || 0,
		costUSD: Number(raw.spend.costUSD) || 0,
	} : EMPTY_SPEND();
	return {
		version: LEDGER_VERSION,
		id,
		goal: raw.goal,
		createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
		updatedAt: now,
		status: (typeof raw.status === 'string' ? raw.status : 'planned') as RunStatus,
		subtasks: raw.subtasks.map(normalizeSubtask),
		spend,
		checkpoints: Array.isArray(raw.checkpoints) ? raw.checkpoints as RunLedger['checkpoints'] : [],
		events: Array.isArray(raw.events) ? raw.events as LedgerEvent[] : [],
	};
}

function normalizeSubtask(raw: unknown): Subtask {
	if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.goal !== 'string') {
		throw new Error('ledger subtask is missing id or goal');
	}
	const budget = isRecord(raw.budget) ? raw.budget : {};
	return {
		id: raw.id,
		goal: raw.goal,
		files: Array.isArray(raw.files) ? raw.files.filter((f): f is string => typeof f === 'string') : [],
		acceptance: Array.isArray(raw.acceptance) ? raw.acceptance as Subtask['acceptance'] : [],
		dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.filter((d): d is string => typeof d === 'string') : [],
		budget: { maxIterations: Number(budget.maxIterations) || 8, maxTokens: Number(budget.maxTokens) || 40_000 },
		status: (typeof raw.status === 'string' ? raw.status : 'pending') as SubtaskStatus,
		attempts: Number(raw.attempts) || 0,
		toolDigest: Array.isArray(raw.toolDigest) ? raw.toolDigest.filter((t): t is string => typeof t === 'string') : [],
		notes: typeof raw.notes === 'string' ? raw.notes : '',
	};
}

/** Subtasks whose dependencies are finished and that have not started. Order is file order. */
export function nextReadySubtasks(run: RunLedger): Subtask[] {
	const finished = new Set(run.subtasks.filter(s => s.status === 'done' || s.status === 'skipped').map(s => s.id));
	return run.subtasks.filter(s => s.status === 'pending' && s.dependsOn.every(d => finished.has(d)));
}

export function deriveRunStatus(run: RunLedger): RunStatus {
	if (run.status === 'cancelled') { return 'cancelled'; }
	if (run.subtasks.length === 0) { return run.status === 'planned' ? 'planned' : 'done'; }
	if (run.subtasks.some(s => s.status === 'blocked')) { return 'blocked'; }
	if (run.subtasks.every(s => s.status === 'done' || s.status === 'skipped')) { return 'done'; }
	if (run.subtasks.some(s => s.status === 'running' || s.status === 'done' || s.status === 'skipped')) { return 'running'; }
	return 'planned';
}

/**
 * Persists one JSON file per run under `<repo>/.riaf/runs`. Writes are temp-file plus rename
 * so a crash mid-write cannot leave a half ledger as the current file.
 */
export class FileLedger {
	private readonly now: () => number;
	constructor(private readonly repoRoot: string, private readonly opts: { now?: () => number; bus?: LedgerBus } = {}) {
		this.now = opts.now ?? Date.now;
	}

	directory(): string { return join(this.repoRoot, '.riaf', 'runs'); }

	create(input: { goal: string; subtasks: NewSubtask[]; id?: string }): RunLedger {
		const at = this.now();
		const run: RunLedger = {
			version: LEDGER_VERSION,
			id: assertRunId(input.id ?? newRunId(at)),
			goal: input.goal,
			createdAt: at,
			updatedAt: at,
			status: 'planned',
			subtasks: input.subtasks.map(s => ({
				...s,
				status: s.status ?? 'pending',
				attempts: 0,
				toolDigest: [],
				notes: s.notes ?? '',
				files: s.files ?? [],
				acceptance: s.acceptance ?? [],
				dependsOn: s.dependsOn ?? [],
			})),
			spend: EMPTY_SPEND(),
			checkpoints: [],
			events: [],
		};
		this.push(run, 'planned', `planned ${run.subtasks.length} subtask${run.subtasks.length === 1 ? '' : 's'}`);
		return run;
	}

	load(id: string): RunLedger {
		return migrateLedger(JSON.parse(readFileSync(this.file(id), 'utf8')));
	}

	save(run: RunLedger): void {
		assertRunId(run.id);
		run.updatedAt = this.now();
		const dir = this.directory();
		mkdirSync(dir, { recursive: true });
		const dest = this.file(run.id);
		const tmp = `${dest}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(run, null, 2));
		renameSync(tmp, dest);
	}

	list(): { id: string; goal: string; status: RunStatus; updatedAt: number }[] {
		let names: string[] = [];
		try { names = readdirSync(this.directory()); } catch { return []; }
		const rows = names.filter(n => n.endsWith('.json')).flatMap(n => {
			try {
				const run = migrateLedger(JSON.parse(readFileSync(join(this.directory(), n), 'utf8')));
				return [{ id: run.id, goal: run.goal, status: run.status, updatedAt: run.updatedAt }];
			} catch { return []; }
		});
		return rows.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	setSubtaskStatus(run: RunLedger, subtaskId: string, status: Exclude<SubtaskStatus, 'pending'>, message: string): LedgerEvent {
		const task = run.subtasks.find(s => s.id === subtaskId);
		if (!task) { throw new Error(`unknown subtask ${subtaskId}`); }
		task.status = status;
		if (status === 'running') { task.attempts++; }
		if (run.status !== 'cancelled') { run.status = deriveRunStatus(run); }
		return this.push(run, `subtask_${status}` as LedgerEventType, message, subtaskId);
	}

	recordSpend(run: RunLedger, delta: Partial<RunSpend>): void {
		run.spend.inputTokens += delta.inputTokens ?? 0;
		run.spend.outputTokens += delta.outputTokens ?? 0;
		run.spend.costUSD += delta.costUSD ?? 0;
		this.push(run, 'spend', `+${delta.inputTokens ?? 0} in / +${delta.outputTokens ?? 0} out`);
	}

	recordCheckpoint(run: RunLedger, label: string, subtaskId?: string): void {
		run.checkpoints.push({ at: this.now(), label, subtaskId });
		this.push(run, 'checkpoint', label, subtaskId);
	}

	appendEvent(run: RunLedger, type: LedgerEventType, message: string, subtaskId?: string): LedgerEvent {
		return this.push(run, type, message, subtaskId);
	}

	appendToolDigest(run: RunLedger, subtaskId: string, line: string): void {
		const task = run.subtasks.find(s => s.id === subtaskId);
		if (!task) { throw new Error(`unknown subtask ${subtaskId}`); }
		task.toolDigest.push(line);
		this.save(run);
	}

	private file(id: string): string { return join(this.directory(), `${assertRunId(id)}.json`); }

	private push(run: RunLedger, type: LedgerEventType, message: string, subtaskId?: string): LedgerEvent {
		const event: LedgerEvent = { at: this.now(), type, message, ...(subtaskId ? { subtaskId } : {}) };
		run.events.push(event);
		this.save(run);
		this.opts.bus?.emit(run.id, event);
		return event;
	}
}
