/**
 * Pillar 1b — git-history intelligence.
 *
 * Mines `git log --numstat` incrementally into the RIAF 2.0 tables and derives five signals:
 * co-change coupling, ownership, churn / hot spots, commit intent and design decisions.
 * Everything is local; author identities are hashed unless `storeAuthorNames` is set.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { V2Store } from './store.js';

export type IntentClass = 'feature' | 'fix' | 'refactor' | 'test' | 'docs' | 'chore' | 'perf' | 'security';

export interface HistoryOptions {
	/** Reference "now" in ms (tests pin this). Default Date.now(). */
	now?: () => number;
	/** Co-change decay half-life in days. Default 180. */
	halfLifeDays?: number;
	/** Commits touching more files are noise for co-change and ownership. Default 50. */
	noiseFileThreshold?: number;
	/** Logical units touching more files contribute no co-change pairs. Default 30. */
	maxFilesPerUnit?: number;
	/** Pairs seen in fewer logical units are pruned. Default 2. */
	minSupport?: number;
	/** Same-author commits closer than this are one logical change. Default 30 min. */
	unitWindowMs?: number;
	/** Cap on commits mined (most recent). Default 20 000. */
	maxCommits?: number;
	/** Keep author display names in the local DB (packs still export roles). Default false. */
	storeAuthorNames?: boolean;
	log?: (msg: string) => void;
}

export interface CommitRow {
	sha: string;
	authorHash: string;
	authorName?: string;
	ts: number;
	subject: string;
	body: string;
	parents: number;
	files: { path: string; added: number; deleted: number; oldPath?: string }[];
	isNoise: boolean;
	noiseReason?: string;
	unitId: string;
	intent: IntentClass;
	tickets: string[];
	why: string;
}

export interface CoChangeNeighbor { path: string; support: number; score: number; confidence: number }
export interface OwnerInfo { authorHash: string; authorName?: string; role: 'primary owner' | 'co-owner' | 'recent contributor' | 'contributor'; share: number; commits12m: number; lastTs: number }
export interface Hotspot { path: string; score: number; commits365: number; fixRatio: number; linesChanged: number }
export interface CommitSummary { sha: string; ts: number; intent: IntentClass; subject: string; why: string; tickets: string[]; files?: string[] }
export interface Decision { id: string; source: 'commit' | 'adr' | 'changelog'; ref: string; text: string; paths: string[]; ts: number }
export interface HistoryCard {
	path: string;
	created?: CommitSummary;
	recent: CommitSummary[];
	intents: Partial<Record<IntentClass, number>>;
	owners: OwnerInfo[];
	hotspot?: Hotspot & { isHot: boolean };
	coChanges: CoChangeNeighbor[];
}
export interface MineResult { newCommits: number; totalCommits: number; full: boolean; head: string | null; ms: number }

const DAY = 86_400_000;
const RS = '\x1e', US = '\x1f', GS = '\x1d';

// ── pure helpers (exported for tests) ──────────────────────────────────────

const CONVENTIONAL = /^(feat|feature|fix|bugfix|hotfix|refactor|test|tests|docs|doc|chore|perf|security|sec|build|ci|style|revert)(\([^)]*\))?!?:/i;
const CONVENTIONAL_MAP: Record<string, IntentClass> = {
	feat: 'feature', feature: 'feature', fix: 'fix', bugfix: 'fix', hotfix: 'fix', refactor: 'refactor', test: 'test', tests: 'test',
	docs: 'docs', doc: 'docs', chore: 'chore', perf: 'perf', security: 'security', sec: 'security', build: 'chore', ci: 'chore', style: 'chore', revert: 'fix',
};
const LEXICON: [IntentClass, RegExp][] = [
	['security', /\b(security|cve-\d|xss|csrf|injection|vulnerab\w*|sanitiz\w*|privilege|secrets?\s+leak|auth(?:entication)? bypass)\b/i],
	['fix', /\b(fix(e[sd])?|bug|issue|crash\w*|error|regression|hotfix|broken|incorrect|wrong|fail(s|ing|ure)?|npe|null pointer|exception)\b/i],
	['perf', /\b(perf(ormance)?|speed ?up|faster|optimi[sz]\w*|latency|throughput|memory usage|slow)\b/i],
	['refactor', /\b(refactor\w*|rename\w*|move[sd]?|extract\w*|clean ?up|simplif\w*|restructur\w*|reorgani[sz]\w*|dedup\w*)\b/i],
	['test', /\b(tests?|specs?|coverage|unit test|e2e)\b/i],
	['docs', /\b(docs?|readme|documentation|changelog|comments?|typos?)\b/i],
	['chore', /\b(bump|deps?|dependenc(y|ies)|upgrade|release|version|ci|pipeline|build|lint|format(ting)?|prettier|merge branch)\b/i],
	['feature', /\b(add(s|ed)?|implement\w*|support\w*|introduc\w*|new|feature|enable\w*|allow\w*|create[sd]?)\b/i],
];

const isTestPath = (p: string) => /(^|\/)(tests?|__tests__|spec)\//i.test(p) || /\.(test|spec)\.[a-z]+$|Test\.(java|kt)$|_test\.(py|go|rs)$/i.test(p);
const isDocPath = (p: string) => /\.(md|rst|adoc|txt)$/i.test(p) || /(^|\/)docs?\//i.test(p);
export const isLockfile = (p: string) => /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Pipfile\.lock|go\.sum|composer\.lock|Gemfile\.lock|gradle\.lockfile)$/.test(p);
export const isVendored = (p: string) => /(^|\/)(vendor|third_party|node_modules|dist|build)\//.test(p) || /\.min\.(js|css)$/.test(p);

export function classifyCommit(subject: string, body = '', files: string[] = []): IntentClass {
	const conv = CONVENTIONAL.exec(subject.trim());
	if (conv) return CONVENTIONAL_MAP[conv[1].toLowerCase()] ?? 'chore';
	if (files.length && files.every(isTestPath)) return 'test';
	if (files.length && files.every(isDocPath)) return 'docs';
	if (files.length && files.every(f => isLockfile(f) || /(^|\/)(package\.json|pom\.xml|build\.gradle(\.kts)?|requirements.*\.txt|go\.mod|Cargo\.toml)$/.test(f)) && /bump|upgrade|update|deps?/i.test(subject)) return 'chore';
	const text = `${subject}\n${body.slice(0, 400)}`;
	for (const [cls, re] of LEXICON) if (re.test(subject)) return cls;
	for (const [cls, re] of LEXICON) if (re.test(text)) return cls;
	return 'feature';
}

export function extractTickets(text: string): string[] {
	const out = new Set<string>();
	for (const m of text.matchAll(/\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g)) if (!/^(UTF|ISO|SHA|RFC|CVE)-/.test(m[1])) out.add(m[1]);
	for (const m of text.matchAll(/(?:^|[\s(])(#\d{1,6})\b/g)) out.add(m[1]);
	for (const m of text.matchAll(/(?:^|[\s(])(![0-9]{1,6})\b/g)) out.add(m[1]);
	return [...out];
}

export function extractWhy(subject: string, body: string): string {
	const sentences = body.replace(/\r/g, '').split(/(?<=[.!?])\s+|\n{2,}|\n(?=[-*] )/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
	const reason = sentences.find(s => /\b(because|so that|in order to|to avoid|to prevent|since|otherwise|caused by|root cause)\b/i.test(s));
	const clean = subject.replace(CONVENTIONAL, '').trim();
	return reason ? `${clean} — ${reason}`.slice(0, 300) : clean.slice(0, 300);
}

const DECISION_RE = /\b(we (?:moved|switched|migrated|decided|chose|replaced|dropped|no longer)|decided to|decision:|instead of|in favou?r of|deprecat\w+|do not use|don't use|must not|rejected|superseded)\b/i;

export function extractDecisionSentences(text: string): string[] {
	return text.replace(/\r/g, '').split(/(?<=[.!?])\s+|\n+/).map(s => s.replace(/^[-*#>\s]+/, '').replace(/\s+/g, ' ').trim())
		.filter(s => s.length >= 30 && s.length <= 400 && /\s\S+\s\S+\s\S+\s/.test(s) && !/\b(at|of|to|the|a|an|and|or)$/i.test(s) && DECISION_RE.test(s));
}

export function noiseReason(subject: string, files: string[], parents: number, threshold: number): string | undefined {
	if (parents > 1) return 'merge';
	if (files.length === 0) return 'empty';
	if (files.length > threshold) return `outlier (${files.length} files)`;
	if (/^(merge (branch|pull request|remote)|revert "merge)/i.test(subject)) return 'merge';
	if (/\b(prettier|black|gofmt|clang-format|reformat\w*|format(ting)? (all|code|files)|lint ?--fix|eslint --fix|whitespace|line endings|crlf)\b/i.test(subject)) return 'formatter';
	if (/\b(renovate|dependabot|bump(ed)? (deps|dependencies|version)|update (deps|dependencies|lockfile))\b/i.test(subject)) return 'dependency bump';
	if (files.every(f => isLockfile(f))) return 'lockfile-only';
	if (files.every(f => isVendored(f))) return 'vendored';
	return undefined;
}

/** Expand git's `--numstat -M` rename notation: `a/{x => y}/f.ts` and `old.ts => new.ts`. */
export function parseRenamePath(raw: string): { path: string; oldPath?: string } {
	const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
	if (brace) {
		const [, pre, from, to, post] = brace;
		const join2 = (mid: string) => `${pre}${mid}${post}`.replace(/\/\//g, '/').replace(/^\//, '');
		return { path: join2(to), oldPath: join2(from) };
	}
	const arrow = /^(.*) => (.*)$/.exec(raw);
	if (arrow) return { path: arrow[2], oldPath: arrow[1] };
	return { path: raw };
}

export const hashAuthor = (email: string): string => createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12);

// ── git runner ─────────────────────────────────────────────────────────────

const git = (root: string, args: string[], maxBuffer = 512 * 1024 * 1024): Promise<string> =>
	new Promise((resolve, reject) => {
		execFile('git', args, { cwd: root, maxBuffer, windowsHide: true, env: { ...process.env, GIT_PAGER: 'cat', LC_ALL: 'C' } }, (err, stdout) => {
			if (err) reject(err); else resolve(stdout);
		});
	});

const gitOr = async (root: string, args: string[], fallback = ''): Promise<string> => { try { return (await git(root, args)).trim(); } catch { return fallback; } };

// ── miner ──────────────────────────────────────────────────────────────────

export class GitHistory {
	private readonly o: Required<Omit<HistoryOptions, 'log' | 'now'>> & { now: () => number; log: (m: string) => void };
	private _alias: Map<string, string> | null = null;

	constructor(private readonly store: V2Store, private readonly root: string, options: HistoryOptions = {}) {
		this.o = {
			now: options.now ?? (() => Date.now()),
			halfLifeDays: options.halfLifeDays ?? 180,
			noiseFileThreshold: options.noiseFileThreshold ?? 50,
			maxFilesPerUnit: options.maxFilesPerUnit ?? 30,
			minSupport: options.minSupport ?? 2,
			unitWindowMs: options.unitWindowMs ?? 30 * 60_000,
			maxCommits: options.maxCommits ?? 20_000,
			storeAuthorNames: options.storeAuthorNames ?? false,
			log: options.log ?? (() => { }),
		};
	}

	async isGitRepo(): Promise<boolean> {
		return (await gitOr(this.root, ['rev-parse', '--is-inside-work-tree'])) === 'true';
	}

	async head(): Promise<string | null> {
		return (await gitOr(this.root, ['rev-parse', 'HEAD'])) || null;
	}

	/** Mine new commits since the last run (or everything when history was rewritten) and recompute derived signals. */
	async mine(): Promise<MineResult> {
		const t0 = Date.now();
		if (!(await this.isGitRepo())) return { newCommits: 0, totalCommits: 0, full: false, head: null, ms: 0 };
		const head = await this.head();
		if (!head) return { newCommits: 0, totalCommits: 0, full: false, head: null, ms: 0 };
		const last = this.store.getKv('history.last_sha');
		let full = !last;
		if (last && last !== head) {
			const ok = await git(this.root, ['merge-base', '--is-ancestor', last, head]).then(() => true, () => false);
			if (!ok) full = true;
		}
		if (last === head && !full) {
			if (this.store.getKv('history.derived_at') !== head) this.recomputeDerived();
			return { newCommits: 0, totalCommits: this.commitCount(), full: false, head, ms: Date.now() - t0 };
		}
		if (full) this.clear();
		const range = full ? [head] : [`${last}..${head}`];
		const raw = await git(this.root, ['log', '--reverse', `--max-count=${this.o.maxCommits}`, '--numstat', '-M', '--no-color',
			`--format=${RS}%H${US}%P${US}%ae${US}%an${US}%at${US}%s${US}%b${GS}`, ...range]);
		const commits = this.parseLog(raw);
		this.insertCommits(commits);
		this.store.setKv('history.last_sha', head);
		this.recomputeDerived();
		await this.mineDecisionDocs();
		const total = this.commitCount();
		this.o.log(`[history] ${full ? 'full' : 'incremental'} mine: ${commits.length} new commits (${total} total) in ${Date.now() - t0} ms`);
		return { newCommits: commits.length, totalCommits: total, full, head, ms: Date.now() - t0 };
	}

	private clear(): void {
		this.store.raw.tx(() => {
			for (const t of ['git_commit', 'git_commit_file', 'co_change', 'ownership', 'file_churn', 'decision']) this.store.raw.run(`DELETE FROM ${t}`);
		});
		this.store.deleteKv('history.last_sha');
		this._alias = null;
	}

	parseLog(raw: string): CommitRow[] {
		const out: CommitRow[] = [];
		const prev = this.lastCommitForUnit();
		let lastByAuthor = prev;
		for (const rec of raw.split(RS)) {
			if (!rec.trim()) continue;
			const gs = rec.indexOf(GS);
			const header = gs >= 0 ? rec.slice(0, gs) : rec;
			const stat = gs >= 0 ? rec.slice(gs + 1) : '';
			const [sha, parentsRaw, email, name, at, subject, body = ''] = header.split(US);
			if (!sha || !/^[0-9a-f]{7,64}$/.test(sha.trim())) continue;
			const files: CommitRow['files'] = [];
			for (const line of stat.split('\n')) {
				const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
				if (!m) continue;
				const { path, oldPath } = parseRenamePath(m[3]);
				files.push({ path, added: m[1] === '-' ? 0 : Number(m[1]), deleted: m[2] === '-' ? 0 : Number(m[2]), oldPath });
			}
			const parents = parentsRaw.trim() ? parentsRaw.trim().split(/\s+/).length : 0;
			const paths = files.map(f => f.path);
			const reason = noiseReason(subject, paths, parents, this.o.noiseFileThreshold);
			const tickets = extractTickets(`${subject}\n${body}`);
			const authorHash = hashAuthor(email);
			const ts = Number(at) * 1000;
			// Logical change units: shared ticket → same unit; else same author within the window with overlapping files.
			let unitId = tickets.find(t => /-/.test(t)) ? `T:${tickets.find(t => /-/.test(t))}` : sha;
			if (unitId === sha && lastByAuthor && lastByAuthor.authorHash === authorHash && ts - lastByAuthor.ts <= this.o.unitWindowMs
				&& !lastByAuthor.isNoise && (lastByAuthor.files.length === 0 || paths.some(p => lastByAuthor!.files.includes(p)) || ts - lastByAuthor.ts <= this.o.unitWindowMs / 3)) {
				unitId = lastByAuthor.unitId;
			}
			const row: CommitRow = {
				sha, authorHash, authorName: this.o.storeAuthorNames ? name : undefined, ts, subject: subject ?? '', body: body.trim(), parents, files,
				isNoise: !!reason, noiseReason: reason, unitId, intent: classifyCommit(subject ?? '', body, paths), tickets, why: extractWhy(subject ?? '', body),
			};
			out.push(row);
			lastByAuthor = { authorHash, ts, unitId, files: paths, isNoise: !!reason };
		}
		return out;
	}

	private lastCommitForUnit(): { authorHash: string; ts: number; unitId: string; files: string[]; isNoise: boolean } | undefined {
		const r = this.store.raw.get<{ sha: string; author_hash: string; ts: number; unit_id: string; is_noise: number }>('SELECT sha, author_hash, ts, unit_id, is_noise FROM git_commit ORDER BY seq DESC LIMIT 1');
		if (!r) return undefined;
		const files = this.store.raw.all<{ path: string }>('SELECT path FROM git_commit_file WHERE sha = ?', [r.sha]).map(x => x.path);
		return { authorHash: r.author_hash, ts: r.ts, unitId: r.unit_id, files, isNoise: !!r.is_noise };
	}

	private insertCommits(commits: CommitRow[]): void {
		let seq = (this.store.raw.get<{ s: number | null }>('SELECT MAX(seq) AS s FROM git_commit')?.s ?? 0);
		this.store.raw.tx(() => {
			for (const c of commits) {
				seq++;
				this.store.raw.run(`INSERT OR REPLACE INTO git_commit(sha, author_hash, author_name, ts, subject, body, parents, file_count, is_noise, noise_reason, unit_id, intent_class, ticket_ids, why, seq)
					VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				[c.sha, c.authorHash, c.authorName ?? null, c.ts, c.subject, c.body.slice(0, 4000), c.parents, c.files.length, c.isNoise ? 1 : 0, c.noiseReason ?? null, c.unitId, c.intent, JSON.stringify(c.tickets), c.why, seq]);
				for (const f of c.files) {
					this.store.raw.run('INSERT OR REPLACE INTO git_commit_file(sha, path, added, deleted, old_path) VALUES (?,?,?,?,?)', [c.sha, f.path, f.added, f.deleted, f.oldPath ?? null]);
				}
			}
		});
		this._alias = null;
	}

	commitCount(): number {
		return this.store.raw.get<{ n: number }>('SELECT COUNT(*) AS n FROM git_commit')?.n ?? 0;
	}

	/** old path → newest path, following rename chains, so history survives moves. */
	private alias(): Map<string, string> {
		if (this._alias) return this._alias;
		const rows = this.store.raw.all<{ path: string; old_path: string }>(
			'SELECT f.path, f.old_path FROM git_commit_file f JOIN git_commit c ON c.sha = f.sha WHERE f.old_path IS NOT NULL ORDER BY c.seq');
		const direct = new Map<string, string>();
		for (const r of rows) if (r.old_path !== r.path) direct.set(r.old_path, r.path);
		const resolved = new Map<string, string>();
		for (const k of direct.keys()) {
			let cur = k; const seen = new Set<string>();
			while (direct.has(cur) && !seen.has(cur)) { seen.add(cur); cur = direct.get(cur)!; }
			resolved.set(k, cur);
		}
		this._alias = resolved;
		return resolved;
	}

	canonical(path: string): string { return this.alias().get(path) ?? path; }

	/** Load commits (canonical paths) — optionally only those strictly before `beforeTs` and excluding `excludeShas`. */
	loadCommits(opts: { beforeTs?: number; includeNoise?: boolean; excludeShas?: Set<string> } = {}): { sha: string; author: string; ts: number; unit: string; intent: IntentClass; noise: boolean; files: { path: string; lines: number }[] }[] {
		const commits = this.store.raw.all<{ sha: string; author_hash: string; ts: number; unit_id: string; intent_class: IntentClass; is_noise: number }>(
			`SELECT sha, author_hash, ts, unit_id, intent_class, is_noise FROM git_commit ${opts.beforeTs !== undefined ? 'WHERE ts < ?' : ''} ORDER BY seq`,
			opts.beforeTs !== undefined ? [opts.beforeTs] : []);
		const fileRows = this.store.raw.all<{ sha: string; path: string; added: number; deleted: number }>('SELECT sha, path, added, deleted FROM git_commit_file');
		const bySha = new Map<string, { path: string; lines: number }[]>();
		for (const f of fileRows) {
			const list = bySha.get(f.sha) ?? [];
			list.push({ path: this.canonical(f.path), lines: f.added + f.deleted });
			bySha.set(f.sha, list);
		}
		return commits
			.filter(c => (opts.includeNoise || !c.is_noise) && !opts.excludeShas?.has(c.sha))
			.map(c => ({ sha: c.sha, author: c.author_hash, ts: c.ts, unit: c.unit_id ?? c.sha, intent: c.intent_class, noise: !!c.is_noise, files: bySha.get(c.sha) ?? [] }));
	}

	/**
	 * Co-change graph over logical units: weight = Σ 0.5^(age/half-life), score = weight / sqrt(churn_a · churn_b)
	 * (hub suppression), confidence = support / units(a). Pure; `recomputeDerived` persists it.
	 */
	computeCoChange(commits: ReturnType<GitHistory['loadCommits']>): Map<string, Map<string, { support: number; weight: number }>> & { unitsPerFile?: Map<string, number> } {
		const now = this.o.now();
		const units = new Map<string, { ts: number; files: Set<string> }>();
		for (const c of commits) {
			const u = units.get(c.unit) ?? { ts: c.ts, files: new Set<string>() };
			u.ts = Math.max(u.ts, c.ts);
			for (const f of c.files) if (!isLockfile(f.path) && !isVendored(f.path)) u.files.add(f.path);
			units.set(c.unit, u);
		}
		const unitsPerFile = new Map<string, number>();
		const pairs = new Map<string, Map<string, { support: number; weight: number }>>() as Map<string, Map<string, { support: number; weight: number }>> & { unitsPerFile?: Map<string, number> };
		for (const u of units.values()) {
			for (const f of u.files) unitsPerFile.set(f, (unitsPerFile.get(f) ?? 0) + 1);
			if (u.files.size < 2 || u.files.size > this.o.maxFilesPerUnit) continue;
			const decay = Math.pow(0.5, Math.max(0, now - u.ts) / (this.o.halfLifeDays * DAY));
			const files = [...u.files].sort();
			for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) {
				for (const [a, b] of [[files[i], files[j]], [files[j], files[i]]]) {
					const m = pairs.get(a) ?? new Map();
					const e = m.get(b) ?? { support: 0, weight: 0 };
					e.support++; e.weight += decay;
					m.set(b, e); pairs.set(a, m);
				}
			}
		}
		pairs.unitsPerFile = unitsPerFile;
		return pairs;
	}

	/** Top-k co-change neighbours from an in-memory graph (used by the held-out evaluation). */
	static neighborsFrom(graph: ReturnType<GitHistory['computeCoChange']>, path: string, k: number, minSupport = 1): CoChangeNeighbor[] {
		const m = graph.get(path);
		if (!m) return [];
		const upf = graph.unitsPerFile ?? new Map();
		return [...m.entries()].filter(([, e]) => e.support >= minSupport)
			.map(([p, e]) => ({ path: p, support: e.support, score: e.weight / Math.sqrt(Math.max(1, upf.get(path) ?? 1) * Math.max(1, upf.get(p) ?? 1)), confidence: e.support / Math.max(1, upf.get(path) ?? 1) }))
			.sort((x, y) => y.score - x.score || y.support - x.support).slice(0, k);
	}

	/** Recompute co-change, ownership and churn from stored commits. */
	recomputeDerived(): void {
		const now = this.o.now();
		const all = this.loadCommits({ includeNoise: true });
		const clean = all.filter(c => !c.noise);
		const graph = this.computeCoChange(clean);
		const upf = graph.unitsPerFile ?? new Map<string, number>();
		const ownership = new Map<string, { lines: number; commits: number; c12: number; last: number }>();
		const churn = new Map<string, { commits: number; c90: number; c365: number; lines: number; fixes: number; first: number; last: number; firstSha: string }>();
		for (const c of all) {
			for (const f of c.files) {
				const ch = churn.get(f.path) ?? { commits: 0, c90: 0, c365: 0, lines: 0, fixes: 0, first: c.ts, last: c.ts, firstSha: c.sha };
				if (c.ts < ch.first) { ch.first = c.ts; ch.firstSha = c.sha; }
				ch.last = Math.max(ch.last, c.ts);
				if (!c.noise) {
					ch.commits++; ch.lines += f.lines;
					if (now - c.ts <= 90 * DAY) ch.c90++;
					if (now - c.ts <= 365 * DAY) ch.c365++;
					if (c.intent === 'fix' || c.intent === 'security') ch.fixes++;
					const key = `${f.path}\u0000${c.author}`;
					const o = ownership.get(key) ?? { lines: 0, commits: 0, c12: 0, last: 0 };
					o.lines += f.lines; o.commits++; if (now - c.ts <= 365 * DAY) o.c12++; o.last = Math.max(o.last, c.ts);
					ownership.set(key, o);
				}
				churn.set(f.path, ch);
			}
		}
		this.store.raw.tx(() => {
			this.store.raw.run('DELETE FROM co_change');
			for (const [a, m] of graph) for (const [b, e] of m) {
				if (e.support < this.o.minSupport) continue;
				const score = e.weight / Math.sqrt(Math.max(1, upf.get(a) ?? 1) * Math.max(1, upf.get(b) ?? 1));
				this.store.raw.run('INSERT INTO co_change(a, b, support, weight, score, confidence) VALUES (?,?,?,?,?,?)',
					[a, b, e.support, e.weight, score, e.support / Math.max(1, upf.get(a) ?? 1)]);
			}
			this.store.raw.run('DELETE FROM ownership');
			for (const [key, o] of ownership) {
				const [path, author] = key.split('\u0000');
				this.store.raw.run('INSERT INTO ownership(path, author_hash, lines, commits, commits_12m, last_ts) VALUES (?,?,?,?,?,?)', [path, author, o.lines, o.commits, o.c12, o.last]);
			}
			this.store.raw.run('DELETE FROM file_churn');
			for (const [path, c] of churn) {
				const fixRatio = c.commits ? c.fixes / c.commits : 0;
				const hotspot = Math.log1p(c.c365) * (1 + fixRatio) * (c.commits ? 1 : 0);
				this.store.raw.run('INSERT INTO file_churn(path, commits, commits_90d, commits_365d, lines_changed, fixes, first_ts, last_ts, first_sha, hotspot) VALUES (?,?,?,?,?,?,?,?,?,?)',
					[path, c.commits, c.c90, c.c365, c.lines, c.fixes, c.first, c.last, c.firstSha, hotspot]);
			}
			// Decisions from commit bodies.
			this.store.raw.run(`DELETE FROM decision WHERE source = 'commit'`);
			const bodies = this.store.raw.all<{ sha: string; ts: number; subject: string; body: string }>(`SELECT sha, ts, subject, body FROM git_commit WHERE is_noise = 0 AND (body != '' OR subject != '')`);
			for (const b of bodies) {
				const sentences = extractDecisionSentences(`${b.subject}.\n${b.body}`);
				if (!sentences.length) continue;
				const paths = this.store.raw.all<{ path: string }>('SELECT path FROM git_commit_file WHERE sha = ? LIMIT 12', [b.sha]).map(r => this.canonical(r.path));
				sentences.slice(0, 3).forEach((s, i) => this.store.raw.run('INSERT OR REPLACE INTO decision(id, source, ref, text, paths, ts) VALUES (?,?,?,?,?,?)',
					[`c:${b.sha.slice(0, 12)}:${i}`, 'commit', b.sha, s, JSON.stringify(paths), b.ts]));
			}
		});
		this.store.setKv('history.derived_at', this.store.getKv('history.last_sha') ?? '');
	}

	/** ADR files (docs/adr, adr, doc/architecture/decisions) and CHANGELOG deprecations / breaking changes. */
	async mineDecisionDocs(): Promise<number> {
		const found: Decision[] = [];
		const dirs = ['docs/adr', 'doc/adr', 'adr', 'docs/decisions', 'doc/architecture/decisions', 'docs/architecture/decisions'];
		for (const d of dirs) {
			const abs = join(this.root, d);
			if (!existsSync(abs)) continue;
			let names: string[] = [];
			try { names = readdirSync(abs).filter(n => /\.(md|markdown|adoc|rst)$/i.test(n)); } catch { continue; }
			for (const n of names) {
				const rel = `${d}/${n}`;
				let text = ''; let ts = 0;
				try { text = readFileSync(join(abs, n), 'utf8'); ts = statSync(join(abs, n)).mtimeMs; } catch { continue; }
				const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? n;
				const status = /^(?:##\s*)?status:?\s*\n*\s*(\w+)/im.exec(text)?.[1] ?? '';
				const decisionSection = /^##\s*Decision\s*\n+([\s\S]*?)(?=\n##\s|$)/im.exec(text)?.[1]?.trim().split(/\n\n/)[0]?.replace(/\s+/g, ' ') ?? '';
				const paths = [...text.matchAll(/`((?:[\w.-]+\/)+[\w.-]+\.\w+)`/g)].map(m => m[1]).slice(0, 12);
				found.push({ id: `adr:${rel}`, source: 'adr', ref: rel, text: `${title}${status ? ` [${status}]` : ''}${decisionSection ? `: ${decisionSection}` : ''}`.slice(0, 600), paths, ts });
			}
		}
		for (const n of ['CHANGELOG.md', 'CHANGES.md', 'HISTORY.md']) {
			const abs = join(this.root, n);
			if (!existsSync(abs)) continue;
			let text = ''; try { text = readFileSync(abs, 'utf8'); } catch { continue; }
			let i = 0;
			for (const line of text.split('\n')) {
				if (/\b(BREAKING|deprecat\w*|removed?|no longer)\b/i.test(line) && line.trim().length > 15) {
					found.push({ id: `cl:${n}:${i++}`, source: 'changelog', ref: n, text: line.replace(/^[-*#\s]+/, '').trim().slice(0, 300), paths: [], ts: 0 });
					if (i >= 30) break;
				}
			}
		}
		this.store.raw.tx(() => {
			this.store.raw.run(`DELETE FROM decision WHERE source != 'commit'`);
			for (const d of found) this.store.raw.run('INSERT OR REPLACE INTO decision(id, source, ref, text, paths, ts) VALUES (?,?,?,?,?,?)', [d.id, d.source, d.ref, d.text, JSON.stringify(d.paths), d.ts]);
		});
		return found.length;
	}

	// ── queries ─────────────────────────────────────────────────────────────

	coChanged(path: string, limit = 10, minConfidence = 0): CoChangeNeighbor[] {
		return this.store.raw.all<{ b: string; support: number; score: number; confidence: number }>(
			'SELECT b, support, score, confidence FROM co_change WHERE a = ? AND confidence >= ? ORDER BY score DESC, support DESC LIMIT ?', [this.canonical(path), minConfidence, limit])
			.map(r => ({ path: r.b, support: r.support, score: r.score, confidence: r.confidence }));
	}

	owners(pathOrPrefix: string, limit = 5): OwnerInfo[] {
		const isDir = pathOrPrefix === '' || pathOrPrefix.endsWith('/');
		const rows = this.store.raw.all<{ author_hash: string; lines: number; c12: number; last: number }>(
			`SELECT author_hash, SUM(lines) AS lines, SUM(commits_12m) AS c12, MAX(last_ts) AS last FROM ownership WHERE ${isDir ? 'path LIKE ?' : 'path = ?'} GROUP BY author_hash ORDER BY lines DESC`,
			[isDir ? `${pathOrPrefix}%` : this.canonical(pathOrPrefix)]);
		const total = rows.reduce((s, r) => s + r.lines, 0) || 1;
		const names = this.o.storeAuthorNames ? new Map(this.store.raw.all<{ author_hash: string; author_name: string }>('SELECT author_hash, MAX(author_name) AS author_name FROM git_commit GROUP BY author_hash').map(r => [r.author_hash, r.author_name])) : new Map<string, string>();
		const now = this.o.now();
		return rows.slice(0, limit).map((r, i) => {
			const share = r.lines / total;
			const role: OwnerInfo['role'] = i === 0 && share >= 0.4 ? 'primary owner' : share >= 0.2 ? 'co-owner' : now - r.last <= 90 * DAY ? 'recent contributor' : 'contributor';
			return { authorHash: r.author_hash, authorName: names.get(r.author_hash) ?? undefined, role, share: Math.round(share * 100) / 100, commits12m: r.c12, lastTs: r.last };
		});
	}

	/** Smallest number of authors covering ≥ 50 % of lines under a prefix. */
	busFactor(prefix: string): number {
		const rows = this.store.raw.all<{ lines: number }>('SELECT SUM(lines) AS lines FROM ownership WHERE path LIKE ? GROUP BY author_hash ORDER BY lines DESC', [`${prefix}%`]);
		const total = rows.reduce((s, r) => s + r.lines, 0);
		if (!total) return 0;
		let acc = 0;
		for (let i = 0; i < rows.length; i++) { acc += rows[i].lines; if (acc >= total / 2) return i + 1; }
		return rows.length;
	}

	hotspots(limit = 10, pathPrefix = ''): Hotspot[] {
		return this.store.raw.all<{ path: string; hotspot: number; commits_365d: number; fixes: number; commits: number; lines_changed: number }>(
			'SELECT path, hotspot, commits_365d, fixes, commits, lines_changed FROM file_churn WHERE path LIKE ? AND commits > 0 ORDER BY hotspot DESC, commits DESC LIMIT ?', [`${pathPrefix}%`, limit])
			.map(r => ({ path: r.path, score: Math.round(r.hotspot * 100) / 100, commits365: r.commits_365d, fixRatio: r.commits ? Math.round(r.fixes / r.commits * 100) / 100 : 0, linesChanged: r.lines_changed }));
	}

	/** Threshold above which a file counts as a hot spot: the 90th percentile of active files (min 1.5). */
	hotspotThreshold(): number {
		const rows = this.store.raw.all<{ hotspot: number }>('SELECT hotspot FROM file_churn WHERE commits_365d >= 3 ORDER BY hotspot DESC');
		if (!rows.length) return Infinity;
		return Math.max(1.5, rows[Math.floor(rows.length * 0.1)]?.hotspot ?? rows[0].hotspot);
	}

	private toSummary(r: { sha: string; ts: number; intent_class: IntentClass; subject: string; why: string | null; ticket_ids: string }): CommitSummary {
		return { sha: r.sha, ts: r.ts, intent: r.intent_class, subject: r.subject, why: r.why ?? r.subject, tickets: JSON.parse(r.ticket_ids || '[]') };
	}

	commitsForFile(path: string, limit = 10): CommitSummary[] {
		const paths = [this.canonical(path), ...[...this.alias().entries()].filter(([, v]) => v === this.canonical(path)).map(([k]) => k)];
		return this.store.raw.all<{ sha: string; ts: number; intent_class: IntentClass; subject: string; why: string | null; ticket_ids: string }>(
			`SELECT c.sha, c.ts, c.intent_class, c.subject, c.why, c.ticket_ids FROM git_commit c JOIN git_commit_file f ON f.sha = c.sha
			 WHERE f.path IN (${paths.map(() => '?').join(',')}) AND c.is_noise = 0 GROUP BY c.sha ORDER BY c.ts DESC LIMIT ?`, [...paths, limit]).map(r => this.toSummary(r));
	}

	/** Intent tier: commits whose subject/body/why/tickets match the query terms, scored by term hits and recency. */
	searchCommits(terms: string[], limit = 10, intent?: IntentClass, beforeTs?: number): (CommitSummary & { files: string[]; score: number })[] {
		const words = [...new Set(terms.map(t => t.toLowerCase()).filter(t => t.length >= 3))].slice(0, 12);
		if (!words.length) return [];
		const where = words.map(() => `(LOWER(subject) LIKE ? OR LOWER(body) LIKE ? OR LOWER(ticket_ids) LIKE ?)`).join(' OR ');
		const params = words.flatMap(w => [`%${w}%`, `%${w}%`, `%${w}%`]);
		const rows = this.store.raw.all<{ sha: string; ts: number; intent_class: IntentClass; subject: string; body: string; why: string | null; ticket_ids: string }>(
			`SELECT sha, ts, intent_class, subject, body, why, ticket_ids FROM git_commit WHERE is_noise = 0 ${beforeTs !== undefined ? 'AND ts < ?' : ''} AND (${where}) ORDER BY ts DESC LIMIT 400`, beforeTs !== undefined ? [beforeTs, ...params] : params);
		const now = this.o.now();
		return rows.map(r => {
			const hay = `${r.subject} ${r.body} ${r.ticket_ids}`.toLowerCase();
			const hits = words.filter(w => hay.includes(w)).length;
			const recency = Math.pow(0.5, Math.max(0, now - r.ts) / (365 * DAY));
			const score = hits / words.length + 0.15 * recency + (intent && r.intent_class === intent ? 0.2 : 0);
			const files = this.store.raw.all<{ path: string }>('SELECT path FROM git_commit_file WHERE sha = ?', [r.sha]).map(x => this.canonical(x.path));
			return { ...this.toSummary(r), files, score };
		}).filter(r => r.score >= 0.34).sort((a, b) => b.score - a.score).slice(0, limit);
	}

	/** Temporal query: commits since a ref (tag/branch/sha) or ISO date touching a path prefix. */
	async changedSince(refOrDate: string, pathPrefix = ''): Promise<(CommitSummary & { files: string[] })[]> {
		let since: number | null = null;
		if (/^\d{4}-\d{2}-\d{2}/.test(refOrDate)) since = Date.parse(refOrDate);
		else {
			const t = await gitOr(this.root, ['log', '-1', '--format=%at', refOrDate]);
			since = t ? Number(t) * 1000 : null;
		}
		if (since === null || Number.isNaN(since)) return [];
		const rows = this.store.raw.all<{ sha: string; ts: number; intent_class: IntentClass; subject: string; why: string | null; ticket_ids: string }>(
			`SELECT DISTINCT c.sha, c.ts, c.intent_class, c.subject, c.why, c.ticket_ids FROM git_commit c JOIN git_commit_file f ON f.sha = c.sha
			 WHERE c.ts > ? AND f.path LIKE ? AND c.is_noise = 0 ORDER BY c.ts DESC LIMIT 200`, [since, `${pathPrefix}%`]);
		return rows.map(r => ({ ...this.toSummary(r), files: this.store.raw.all<{ path: string }>('SELECT path FROM git_commit_file WHERE sha = ? AND path LIKE ?', [r.sha, `${pathPrefix}%`]).map(x => x.path) }));
	}

	decisions(paths: string[] = [], limit = 5): Decision[] {
		const rows = this.store.raw.all<{ id: string; source: Decision['source']; ref: string; text: string; paths: string; ts: number }>('SELECT * FROM decision ORDER BY ts DESC');
		const decs = rows.map(r => ({ ...r, paths: JSON.parse(r.paths || '[]') as string[] }));
		if (!paths.length) return decs.slice(0, limit);
		const dirs = new Set(paths.map(p => p.split('/').slice(0, -1).join('/')));
		const scored = decs.map(d => {
			const exact = d.paths.filter(p => paths.includes(p)).length;
			const near = d.paths.filter(p => dirs.has(p.split('/').slice(0, -1).join('/'))).length;
			const mentions = paths.filter(p => d.text.includes(p.split('/').pop()!.replace(/\.\w+$/, ''))).length;
			return { d, s: exact * 3 + near + mentions * 2 + (d.source === 'adr' ? 0.5 : 0) };
		}).filter(x => x.s > 0).sort((a, b) => b.s - a.s || b.d.ts - a.d.ts);
		return scored.slice(0, limit).map(x => x.d);
	}

	card(path: string): HistoryCard {
		const p = this.canonical(path);
		const churn = this.store.raw.get<{ path: string; hotspot: number; commits_365d: number; fixes: number; commits: number; lines_changed: number; first_sha: string | null }>('SELECT * FROM file_churn WHERE path = ?', [p]);
		const recent = this.commitsForFile(p, 5);
		const created = churn?.first_sha ? this.store.raw.get<{ sha: string; ts: number; intent_class: IntentClass; subject: string; why: string | null; ticket_ids: string }>(
			'SELECT sha, ts, intent_class, subject, why, ticket_ids FROM git_commit WHERE sha = ?', [churn.first_sha]) : undefined;
		const intents: HistoryCard['intents'] = {};
		for (const r of this.store.raw.all<{ intent_class: IntentClass; n: number }>(
			'SELECT c.intent_class, COUNT(*) AS n FROM git_commit c JOIN git_commit_file f ON f.sha = c.sha WHERE f.path = ? AND c.is_noise = 0 GROUP BY c.intent_class', [p])) intents[r.intent_class] = r.n;
		const threshold = this.hotspotThreshold();
		return {
			path: p,
			created: created ? this.toSummary(created) : undefined,
			recent,
			intents,
			owners: this.owners(p, 3),
			hotspot: churn ? { path: p, score: Math.round(churn.hotspot * 100) / 100, commits365: churn.commits_365d, fixRatio: churn.commits ? Math.round(churn.fixes / churn.commits * 100) / 100 : 0, linesChanged: churn.lines_changed, isHot: churn.hotspot >= threshold } : undefined,
			coChanges: this.coChanged(p, 5),
		};
	}

	/** Rename-following log for one path (uses git directly; for on-demand symbol/file evolution). */
	async follow(path: string, limit = 20): Promise<{ sha: string; ts: number; subject: string; path: string }[]> {
		const out = await gitOr(this.root, ['log', '--follow', '--name-only', `--max-count=${limit}`, `--format=${RS}%H${US}%at${US}%s`, '--', path]);
		return out.split(RS).filter(Boolean).map(rec => {
			const [head, ...rest] = rec.split('\n');
			const [sha, at, subject] = head.split(US);
			return { sha, ts: Number(at) * 1000, subject, path: rest.map(s => s.trim()).filter(Boolean)[0] ?? path };
		});
	}
}

export function formatHistoryCard(card: HistoryCard, opts: { showNames?: boolean } = {}): string {
	const lines = [`History card — ${card.path}`];
	const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
	if (card.created) lines.push(`- created ${day(card.created.ts)} in ${card.created.sha.slice(0, 8)} (${card.created.intent}): ${card.created.why}`);
	const intents = Object.entries(card.intents).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
	if (intents) lines.push(`- changes by intent: ${intents}`);
	for (const c of card.recent.slice(0, 3)) lines.push(`- ${day(c.ts)} ${c.sha.slice(0, 8)} [${c.intent}] ${c.why}${c.tickets.length ? ` (${c.tickets.join(', ')})` : ''}`);
	if (card.owners.length) lines.push(`- owners: ${card.owners.map(o => `${opts.showNames && o.authorName ? `${o.authorName} (${o.role})` : o.role} ${Math.round(o.share * 100)}%`).join(', ')}`);
	if (card.hotspot?.isHot) lines.push(`- ⚠ hot spot: ${card.hotspot.commits365} commits in 12 months, fix ratio ${Math.round(card.hotspot.fixRatio * 100)}% — change carefully`);
	if (card.coChanges.length) lines.push(`- usually changes with: ${card.coChanges.map(c => `${c.path} (${c.support}×)`).join(', ')}`);
	return lines.join('\n');
}
