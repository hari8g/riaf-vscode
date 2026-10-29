/**
 * GitLab integration adapter (self-hosted / Enterprise and gitlab.com, REST API v4).
 *
 * Read tools ground the agent in projects, merge requests, pipelines, files, blame, search, commits
 * and issues; write tools (branch / MR / comments / approvals / pipeline control / issues) are gated
 * by the host. No `vscode` import: this file also runs inside the MCP server process.
 *
 * Project resolution: `settings.defaultProject` ('group/subgroup/project') wins; otherwise the
 * workspace's `git remote get-url origin` is parsed (ssh, ssh://, https, with or without `.git`).
 */
import { execFileSync } from 'node:child_process';
import {
	type AdapterEnv, type Health, type IntegrationAdapter, type IntegrationToolSpec,
	IntegrationError, RateLimiter, baseUrlOf, bearerAuth, bool, clip, num, obj, requestJson, str, tool,
} from './adapter.js';

const API_VERSION = 'v4';
const limiter = new RateLimiter(8, 16);

/* ───────────────────────────── settings / auth ───────────────────────────── */

type Settings = { baseUrl?: string; defaultProject?: string; maxResults?: number; authKind?: string; apiVersion?: string };

const settingsOf = (env: AdapterEnv): Settings => (env.settings ?? {}) as Settings;
const apiBase = (env: AdapterEnv): string => `${baseUrlOf(env.settings ?? {}, 'gitlab')}/api/${API_VERSION}`;

async function authHeaders(env: AdapterEnv): Promise<Record<string, string>> {
	const token = (await env.getSecret('token'))?.trim();
	if (!token) { throw new IntegrationError('gitlab: no token configured (run "RIAF: Set Integration Credentials")'); }
	return settingsOf(env).authKind === 'oauth' ? bearerAuth(token) : { 'PRIVATE-TOKEN': token };
}

/* ───────────────────────────── project resolution ───────────────────────────── */

/** Parse a git remote URL into 'group/sub/project' (no .git, no leading slash). Returns undefined when unparseable. */
export function projectPathFromRemote(remote: string): string | undefined {
	const r = remote.trim();
	if (!r) { return undefined; }
	let path: string | undefined;
	let m: RegExpMatchArray | null;
	if ((m = r.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+\/(.+)$/))) { path = m[1]; }            // https://host/g/p.git, ssh://git@host[:port]/g/p.git
	else if ((m = r.match(/^[^@/]+@[^:]+:(.+)$/))) { path = m[1]; }                                   // git@host:g/p.git
	else if ((m = r.match(/^[^/:]+:(.+)$/))) { path = m[1]; }                                        // host:g/p
	if (!path) { return undefined; }
	path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
	return path.includes('/') ? path : undefined;
}

/** Project path for a request: explicit arg → settings.defaultProject → workspace `origin` remote. */
export function resolveProjectPath(env: AdapterEnv, explicit?: unknown): string {
	const fromArg = typeof explicit === 'string' ? explicit.trim() : '';
	if (fromArg) { return fromArg.replace(/^\/+|\/+$/g, ''); }
	const fromSettings = String(settingsOf(env).defaultProject ?? '').trim();
	if (fromSettings) { return fromSettings.replace(/^\/+|\/+$/g, ''); }
	const root = env.workspaceRoot;
	if (root) {
		try {
			const out = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
			const parsed = projectPathFromRemote(out);
			if (parsed) { return parsed; }
		} catch { /* not a git repo / no origin */ }
	}
	throw new IntegrationError('gitlab: no project given — pass `project`, set riaf.integrations.gitlab.defaultProject, or open a workspace whose git origin points at GitLab');
}

const projectId = (path: string): string => encodeURIComponent(path);

/* ───────────────────────────── HTTP helpers ───────────────────────────── */

type Q = Record<string, string | number | boolean | undefined>;
const qs = (q: Q): string => {
	const p = new URLSearchParams();
	for (const [k, v] of Object.entries(q)) { if (v !== undefined && v !== '' && v !== null) { p.set(k, String(v)); } }
	const s = p.toString();
	return s ? `?${s}` : '';
};

const MAX_PER_PAGE = 100;

async function get<T>(env: AdapterEnv, path: string, q: Q = {}, accept: 'json' | 'text' = 'json'): Promise<T> {
	return requestJson<T>(env, `${apiBase(env)}${path}${qs(q)}`, await authHeaders(env), { accept }, limiter);
}

/** GET a list, following `x-next-page` only when `limit` exceeds one page. */
async function getList<T>(env: AdapterEnv, path: string, q: Q, limit: number): Promise<T[]> {
	const perPage = Math.min(MAX_PER_PAGE, Math.max(1, limit));
	const headers = await authHeaders(env);
	const out: T[] = [];
	let page = 1;
	for (; ;) {
		await limiter.take();
		const url = `${apiBase(env)}${path}${qs({ ...q, per_page: perPage, page })}`;
		const res = await env.fetch(url, { method: 'GET', headers: { accept: 'application/json', ...headers } });
		const text = await res.text();
		if (!res.ok) {
			const hint = res.status === 401 ? ' (credentials rejected — run "RIAF: Set Integration Credentials")' : res.status === 403 ? ' (forbidden — the account lacks permission)' : res.status === 404 ? ' (not found — check baseUrl / project)' : res.status === 429 ? ' (rate limited)' : '';
			throw new IntegrationError(`${res.status} ${res.statusText}${hint}: ${text.slice(0, 300)}`, res.status, text.slice(0, 2000));
		}
		let items: T[];
		try { items = text ? JSON.parse(text) as T[] : []; } catch { throw new IntegrationError(`non-JSON response from ${url}: ${text.slice(0, 200)}`); }
		if (!Array.isArray(items)) { throw new IntegrationError(`unexpected non-array response from ${url}`); }
		out.push(...items);
		const next = res.headers.get('x-next-page');
		if (out.length >= limit || !next || items.length === 0 || limit <= MAX_PER_PAGE) { break; }
		page = Number(next);
		if (!Number.isFinite(page) || page < 2) { break; }
	}
	return out.slice(0, limit);
}

async function send<T>(env: AdapterEnv, method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
	return requestJson<T>(env, `${apiBase(env)}${path}`, await authHeaders(env), { method, body: body ?? {} }, limiter);
}

/** Wrap project-level 404s with the project path so the agent sees what was looked up. */
async function withProject<T>(project: string, fn: () => Promise<T>): Promise<T> {
	try { return await fn(); } catch (e) {
		if (e instanceof IntegrationError && e.status === 404) { throw new IntegrationError(`${e.message} [project: ${project}]`, e.status, e.body); }
		throw e;
	}
}

/* ───────────────────────────── formatting ───────────────────────────── */

type User = { username?: string; name?: string };
const who = (u?: User | null): string => u?.username ?? u?.name ?? '?';
const date = (s?: string): string => s ? s.slice(0, 16).replace('T', ' ') : '';
const n = (v: unknown, d: number): number => { const x = Number(v); return Number.isFinite(x) && x > 0 ? Math.floor(x) : d; };
const limitOf = (env: AdapterEnv, args: Record<string, unknown>): number => n(args.limit, n(settingsOf(env).maxResults, 20));
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][A-Z0-9]/g, '').replace(/\r(?!\n)/g, '\n');
const secs = (d?: number | null): string => d == null ? '' : d >= 60 ? `${Math.floor(d / 60)}m${Math.round(d % 60)}s` : `${Math.round(d)}s`;

type Mr = {
	iid: number; title: string; description?: string | null; state: string; author?: User; source_branch: string; target_branch: string;
	updated_at?: string; created_at?: string; web_url?: string; draft?: boolean; work_in_progress?: boolean; labels?: string[];
	reviewers?: User[]; assignees?: User[]; head_pipeline?: { status?: string; id?: number; web_url?: string } | null; pipeline?: { status?: string; id?: number } | null;
	diff_refs?: { base_sha?: string; head_sha?: string; start_sha?: string }; has_conflicts?: boolean; merge_status?: string; detailed_merge_status?: string;
	sha?: string; changes_count?: string; user_notes_count?: number;
};
const mrLine = (m: Mr): string => `!${m.iid} [${m.state}${m.draft || m.work_in_progress ? ', draft' : ''}] ${m.title} · ${who(m.author)} · ${m.source_branch}→${m.target_branch} · ${date(m.updated_at)}`;

type Pipeline = { id: number; status: string; ref?: string; sha?: string; source?: string; created_at?: string; updated_at?: string; duration?: number | null; web_url?: string };
const pipeLine = (p: Pipeline): string => `#${p.id} ${p.status} · ${p.ref ?? ''}@${(p.sha ?? '').slice(0, 8)}${p.source ? ` · ${p.source}` : ''} · ${date(p.updated_at ?? p.created_at)}${p.duration != null ? ` · ${secs(p.duration)}` : ''}`;

type Job = { id: number; name: string; stage?: string; status: string; duration?: number | null; allow_failure?: boolean; web_url?: string; failure_reason?: string };

type Issue = { iid: number; title: string; state: string; author?: User; assignees?: User[]; labels?: string[]; updated_at?: string; created_at?: string; description?: string | null; web_url?: string; milestone?: { title?: string } | null; user_notes_count?: number };
const issueLine = (i: Issue): string => `#${i.iid} [${i.state}] ${i.title} · ${who(i.author)}${i.assignees?.length ? ` → ${i.assignees.map(who).join(',')}` : ''}${i.labels?.length ? ` · [${i.labels.join(', ')}]` : ''} · ${date(i.updated_at)}`;

/* ───────────────────────────── tools ───────────────────────────── */

const P = str("Project path 'group/subgroup/project' (default: settings.defaultProject or the workspace git origin)");
const LIMIT = num('Max results (default settings.maxResults = 20)');

const tools: IntegrationToolSpec[] = [
	tool('gitlab_project', 'read', 'read GitLab project', 'Project summary: id, path, default branch, visibility, last activity, open MR/issue counts.', obj({ project: P })),
	tool('gitlab_list_mrs', 'read', 'list GitLab merge requests', 'List merge requests, one per line: `!iid [state] title · author · source→target · updated`.', obj({ project: P, state: { type: 'string', enum: ['opened', 'merged', 'closed', 'all'], description: 'MR state filter (default opened)' }, author: str('Author username'), search: str('Search in title/description'), limit: LIMIT })),
	tool('gitlab_get_mr', 'read', 'read GitLab merge request', 'Merge request details: description, state, author, reviewers/approvals, branches, pipeline status, changed files with +/- counts, web_url.', obj({ project: P, iid: num('MR iid (the number after !)') }, ['iid'])),
	tool('gitlab_mr_discussions', 'read', 'read GitLab MR discussions', 'Review threads on a merge request with file:line, author, body and resolved flag.', obj({ project: P, iid: num('MR iid'), unresolvedOnly: bool('Only unresolved threads') }, ['iid'])),
	tool('gitlab_pipelines', 'read', 'list GitLab pipelines', 'List pipelines for a project, optionally filtered by ref and status.', obj({ project: P, ref: str('Branch or tag'), status: str('running|pending|success|failed|canceled|skipped|manual|created'), limit: LIMIT })),
	tool('gitlab_pipeline', 'read', 'read GitLab pipeline', 'Pipeline details with its stages and jobs (status, duration).', obj({ project: P, id: num('Pipeline id') }, ['id'])),
	tool('gitlab_job_log', 'read', 'read GitLab job log', 'Tail of a CI job trace with ANSI colour codes stripped.', obj({ project: P, jobId: num('Job id'), tail: num('Number of trailing lines (default 200)') }, ['jobId'])),
	tool('gitlab_file', 'read', 'read GitLab file', 'Raw content of a repository file at a ref (default branch when ref omitted).', obj({ project: P, path: str('File path inside the repository'), ref: str('Branch, tag or sha') }, ['path'])),
	tool('gitlab_blame', 'read', 'read GitLab blame', 'Compact blame: `sha7 author date | line` for a file (optionally a line range).', obj({ project: P, path: str('File path'), ref: str('Branch, tag or sha'), startLine: num('First line (1-based)'), endLine: num('Last line (inclusive)') }, ['path'])),
	tool('gitlab_search', 'read', 'search GitLab', 'Search blobs, issues, merge requests or commits in a project (global search when no project resolves).', obj({ project: P, scope: { type: 'string', enum: ['blobs', 'issues', 'merge_requests', 'commits'], description: 'Search scope' }, query: str('Search text'), limit: LIMIT }, ['scope', 'query'])),
	tool('gitlab_commits', 'read', 'list GitLab commits', 'Recent commits on a ref, optionally restricted to a path or since a date.', obj({ project: P, ref: str('Branch, tag or sha'), path: str('Only commits touching this path'), since: str('ISO 8601 date'), limit: LIMIT })),
	tool('gitlab_issues', 'read', 'list GitLab issues', 'List issues: `#iid [state] title · author → assignees · [labels] · updated`.', obj({ project: P, state: { type: 'string', enum: ['opened', 'closed', 'all'], description: 'Issue state (default opened)' }, labels: str('Comma-separated labels'), search: str('Search in title/description'), limit: LIMIT })),
	tool('gitlab_get_issue', 'read', 'read GitLab issue', 'Issue details with description, labels, assignees, milestone and web_url.', obj({ project: P, iid: num('Issue iid') }, ['iid'])),

	tool('gitlab_create_branch', 'write', 'create GitLab branch', 'Create a branch from a ref.', obj({ project: P, branch: str('New branch name'), ref: str('Source branch, tag or sha') }, ['branch', 'ref'])),
	tool('gitlab_create_mr', 'write', 'create GitLab merge request', 'Open a merge request; returns iid and web_url.', obj({ project: P, sourceBranch: str('Source branch'), targetBranch: str('Target branch (default: project default branch)'), title: str('Title'), description: str('Markdown description'), draft: bool('Mark as draft'), removeSourceBranch: bool('Delete source branch on merge'), labels: str('Comma-separated labels'), assigneeIds: { type: 'array', items: { type: 'number' }, description: 'Assignee user ids' }, reviewerIds: { type: 'array', items: { type: 'number' }, description: 'Reviewer user ids' } }, ['sourceBranch', 'title'])),
	tool('gitlab_mr_comment', 'write', 'comment on GitLab merge request', 'Add a note to an MR; with filePath + line it becomes a positioned review discussion (diff_refs fetched when shas are omitted).', obj({ project: P, iid: num('MR iid'), body: str('Markdown body'), filePath: str('File path for an inline comment'), line: num('Line number in the new file'), baseSha: str('diff_refs.base_sha'), headSha: str('diff_refs.head_sha'), startSha: str('diff_refs.start_sha') }, ['iid', 'body'])),
	tool('gitlab_mr_approve', 'write', 'approve GitLab merge request', 'Approve a merge request.', obj({ project: P, iid: num('MR iid') }, ['iid'])),
	tool('gitlab_pipeline_retry', 'write', 'retry GitLab pipeline', 'Retry failed jobs of a pipeline.', obj({ project: P, id: num('Pipeline id') }, ['id'])),
	tool('gitlab_pipeline_cancel', 'write', 'cancel GitLab pipeline', 'Cancel a running pipeline.', obj({ project: P, id: num('Pipeline id') }, ['id'])),
	tool('gitlab_issue_comment', 'write', 'comment on GitLab issue', 'Add a note to an issue.', obj({ project: P, iid: num('Issue iid'), body: str('Markdown body') }, ['iid', 'body'])),
	tool('gitlab_create_issue', 'write', 'create GitLab issue', 'Create an issue; returns iid and web_url.', obj({ project: P, title: str('Title'), description: str('Markdown description'), labels: str('Comma-separated labels') }, ['title'])),
];

/* ───────────────────────────── tool implementations ───────────────────────────── */

type Project = { id: number; path_with_namespace: string; default_branch?: string; visibility?: string; last_activity_at?: string; web_url?: string; open_issues_count?: number; description?: string | null; archived?: boolean };

const reqNum = (args: Record<string, unknown>, key: string): number => {
	const v = Number(args[key]);
	if (!Number.isFinite(v) || v <= 0) { throw new IntegrationError(`gitlab: \`${key}\` must be a positive number`); }
	return Math.floor(v);
};
const reqStr = (args: Record<string, unknown>, key: string): string => {
	const v = String(args[key] ?? '').trim();
	if (!v) { throw new IntegrationError(`gitlab: \`${key}\` is required`); }
	return v;
};
const optStr = (args: Record<string, unknown>, key: string): string | undefined => { const v = args[key]; return v == null || v === '' ? undefined : String(v); };
const idList = (v: unknown): number[] | undefined => Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : typeof v === 'number' ? [v] : undefined;

async function mrChanges(env: AdapterEnv, pid: string, iid: number): Promise<string> {
	type Change = { old_path: string; new_path: string; new_file?: boolean; deleted_file?: boolean; renamed_file?: boolean; diff?: string };
	const data = await get<{ changes?: Change[]; changes_count?: string; overflow?: boolean }>(env, `/projects/${pid}/merge_requests/${iid}/changes`);
	const changes = data.changes ?? [];
	let addTotal = 0, delTotal = 0;
	const lines = changes.map(c => {
		let add = 0, del = 0;
		for (const l of (c.diff ?? '').split('\n')) {
			if (l.startsWith('+') && !l.startsWith('+++')) { add++; } else if (l.startsWith('-') && !l.startsWith('---')) { del++; }
		}
		addTotal += add; delTotal += del;
		const flag = c.new_file ? 'A' : c.deleted_file ? 'D' : c.renamed_file ? 'R' : 'M';
		return `  ${flag} ${c.renamed_file ? `${c.old_path} → ${c.new_path}` : c.new_path} (+${add}/-${del})`;
	});
	return `Changes: ${changes.length} file(s), +${addTotal}/-${delTotal}${data.overflow ? ' (truncated by GitLab)' : ''}\n${lines.join('\n')}`;
}

async function execRead(name: string, args: Record<string, unknown>, env: AdapterEnv): Promise<string> {
	switch (name) {
		case 'gitlab_project': {
			const project = resolveProjectPath(env, args.project); const pid = projectId(project);
			return withProject(project, async () => {
				const p = await get<Project>(env, `/projects/${pid}`);
				const [mrs, issues] = await Promise.all([
					get<unknown[]>(env, `/projects/${pid}/merge_requests`, { state: 'opened', per_page: 100 }).catch(() => [] as unknown[]),
					get<unknown[]>(env, `/projects/${pid}/issues`, { state: 'opened', per_page: 100 }).catch(() => [] as unknown[]),
				]);
				const cnt = (a: unknown[]) => a.length >= 100 ? '100+' : String(a.length);
				return [
					`Project: ${p.path_with_namespace} (id ${p.id})`,
					`Default branch: ${p.default_branch ?? '?'} · Visibility: ${p.visibility ?? '?'}${p.archived ? ' · archived' : ''}`,
					`Last activity: ${date(p.last_activity_at)}`,
					`Open MRs: ${cnt(mrs)} · Open issues: ${p.open_issues_count ?? cnt(issues)}`,
					p.description ? `Description: ${clip(p.description, 400)}` : '',
					`URL: ${p.web_url ?? ''}`,
				].filter(Boolean).join('\n');
			});
		}
		case 'gitlab_list_mrs': {
			const project = resolveProjectPath(env, args.project); const pid = projectId(project);
			const limit = limitOf(env, args);
			return withProject(project, async () => {
				const q: Q = { state: optStr(args, 'state') ?? 'opened', author_username: optStr(args, 'author'), search: optStr(args, 'search'), order_by: 'updated_at', sort: 'desc' };
				const mrs = await getList<Mr>(env, `/projects/${pid}/merge_requests`, q, limit);
				return mrs.length ? clip(mrs.map(mrLine).join('\n')) : `No merge requests (state=${q.state}) in ${project}`;
			});
		}
		case 'gitlab_get_mr': {
			const project = resolveProjectPath(env, args.project); const pid = projectId(project); const iid = reqNum(args, 'iid');
			return withProject(project, async () => {
				const m = await get<Mr>(env, `/projects/${pid}/merge_requests/${iid}`);
				type Approvals = { approved?: boolean; approvals_required?: number; approvals_left?: number; approved_by?: { user?: User }[] };
				const [approvals, changes] = await Promise.all([
					get<Approvals>(env, `/projects/${pid}/merge_requests/${iid}/approvals`).catch(() => undefined),
					mrChanges(env, pid, iid).catch(e => `Changes: unavailable (${(e as Error).message})`),
				]);
				const pipe = m.head_pipeline ?? m.pipeline;
				const lines = [
					`!${m.iid} ${m.title}`,
					`State: ${m.state}${m.draft || m.work_in_progress ? ' (draft)' : ''} · Author: ${who(m.author)} · Created: ${date(m.created_at)} · Updated: ${date(m.updated_at)}`,
					`Branches: ${m.source_branch} → ${m.target_branch}${m.sha ? ` (head ${m.sha.slice(0, 8)})` : ''}${m.has_conflicts ? ' · CONFLICTS' : ''}${m.detailed_merge_status ?? m.merge_status ? ` · merge status: ${m.detailed_merge_status ?? m.merge_status}` : ''}`,
					m.labels?.length ? `Labels: ${m.labels.join(', ')}` : '',
					`Assignees: ${m.assignees?.length ? m.assignees.map(who).join(', ') : '—'} · Reviewers: ${m.reviewers?.length ? m.reviewers.map(who).join(', ') : '—'}`,
					approvals ? `Approvals: ${approvals.approved ? 'approved' : 'not approved'}${approvals.approvals_required != null ? ` (${(approvals.approvals_required ?? 0) - (approvals.approvals_left ?? 0)}/${approvals.approvals_required} required)` : ''}${approvals.approved_by?.length ? ` by ${approvals.approved_by.map(a => who(a.user)).join(', ')}` : ''}` : '',
					`Pipeline: ${pipe ? `${pipe.status ?? '?'}${pipe.id ? ` (#${pipe.id})` : ''}` : 'none'}`,
					`URL: ${m.web_url ?? ''}`,
					'',
					`Description:\n${clip((m.description ?? '').trim() || '(none)', 3000)}`,
					'',
					changes,
				];
				return clip(lines.filter(l => l !== '').join('\n'));
			});
		}
		case 'gitlab_mr_discussions': {
			const project = resolveProjectPath(env, args.project); const pid = projectId(project); const iid = reqNum(args, 'iid');
			const unresolvedOnly = args.unresolvedOnly === true;
			return withProject(project, async () => {
				type Note = { id: number; author?: User; body?: string; system?: boolean; resolvable?: boolean; resolved?: boolean; created_at?: string; position?: { new_path?: string; old_path?: string; new_line?: number | null; old_line?: number | null } };
				type Discussion = { id: string; individual_note?: boolean; notes?: Note[] };
				const discussions = await getList<Discussion>(env, `/projects/${pid}/merge_requests/${iid}/discussions`, {}, 200);
				const threads = discussions
					.map(d => ({ d, notes: (d.notes ?? []).filter(x => !x.system) }))
					.filter(t => t.notes.length > 0)
					.map(t => ({ ...t, resolvable: t.notes.some(x => x.resolvable), resolved: t.notes.some(x => x.resolvable) && t.notes.filter(x => x.resolvable).every(x => x.resolved) }))
					.filter(t => !unresolvedOnly || (t.resolvable && !t.resolved));
				if (!threads.length) { return `No ${unresolvedOnly ? 'unresolved ' : ''}discussions on !${iid}`; }
				const out = threads.map(t => {
					const first = t.notes[0];
					const pos = first.position;
					const loc = pos ? `${pos.new_path ?? pos.old_path ?? '?'}:${pos.new_line ?? pos.old_line ?? '?'}` : 'general';
					const head = `[${t.resolvable ? (t.resolved ? 'resolved' : 'UNRESOLVED') : 'note'}] ${loc} (discussion ${t.d.id.slice(0, 8)})`;
					const body = t.notes.map(x => `  ${who(x.author)} ${date(x.created_at)}: ${clip((x.body ?? '').trim(), 600).replace(/\n/g, '\n    ')}`).join('\n');
					return `${head}\n${body}`;
				}).join('\n\n');
				return clip(`${threads.length} thread(s) on !${iid}${unresolvedOnly ? ' (unresolved only)' : ''}\n\n${out}`);
			});
		}
		case 'gitlab_pipelines': {
			const project = resolveProjectPath(env, args.project); const pid = projectId(project); const limit = limitOf(env, args);
			return withProject(project, async () => {
				const ps = await getList<Pipeline>(env, `/projects/${pid}/pipelines`, { ref: optStr(args, 'ref'), status: optStr(args, 'status'), order_by: 'updated_at', sort: 'desc' }, limit);
				return ps.length ? clip(ps.map(pipeLine).join('\n')) : `No pipelines in ${project}`;
			});
		}
		case 'gitlab_pipeline': {
			const project = resolveProjectPath(env, args.project); const pid = projectId(project); const id = reqNum(args, 'id');
			return withProject(project, async () => {
				const [p, jobs] = await Promise.all([
					get<Pipeline & { user?: User; started_at?: string; finished_at?: string }>(env, `/projects/${pid}/pipelines/${id}`),
					getList<Job>(env, `/projects/${pid}/pipelines/${id}/jobs`, {}, 200),
				]);
				const stages = new Map<string, Job[]>();
				for (const j of jobs) { const s = j.stage ?? '?'; stages.set(s, [...(stages.get(s) ?? []), j]); }
				const stageText = [...stages.entries()].map(([s, js]) => `${s}:\n${js.map(j => `  ${j.status.padEnd(8)} ${j.name} (${j.id})${j.duration != null ? ` ${secs(j.duration)}` : ''}${j.allow_failure && j.status === 'failed' ? ' [allowed]' : ''}${j.failure_reason ? ` — ${j.failure_reason}` : ''}`).join('\n')}`).join('\n');
				return clip([
					pipeLine(p),
					`By: ${who(p.user)} · Started: ${date(p.started_at)} · Finished: ${date(p.finished_at)}`,
					`URL: ${p.web_url ?? ''}`,
					'',
					`Jobs (${jobs.length}):`,
					stageText || '  (none)',
				].join('\n'));
			});
		}
		case 'gitlab_job_log': {
			const project = resolveProjectPath(env, args.project); const pid = projectId(project); const jobId = reqNum(args, 'jobId');
			const tail = n(args.tail, 200);
			return withProject(project, async () => {
				const raw = await get<string>(env, `/projects/${pid}/jobs/${jobId}/trace`, {}, 'text');
				const lines = stripAnsi(raw ?? '').replace(/\n+$/, '').split('\n');
				const tailLines = lines.slice(-tail);
				const header = lines.length > tailLines.length ? `[last ${tailLines.length} of ${lines.length} lines of job ${jobId}]\n` : `[job ${jobId}, ${lines.length} lines]\n`;
				return clip(header + tailLines.join('\n'));
			});
		}
		case 'gitlab_file': {
			const project = resolveProjectPath(env, args.project); const pid = projectId(project); const path = reqStr(args, 'path').replace(/^\/+/, '');
			return withProject(project, async () => {
				const ref = optStr(args, 'ref') ?? (await get<Project>(env, `/projects/${pid}`)).default_branch ?? 'HEAD';
				const text = await get<string>(env, `/projects/${pid}/repository/files/${encodeURIComponent(path)}/raw`, { ref }, 'text');
				return clip(`// ${path} @ ${ref}\n${text ?? ''}`);
			});
		}
		case 'gitlab_blame': {
			const project = resolveProjectPath(env, args.project); const pid = projectId(project); const path = reqStr(args, 'path').replace(/^\/+/, '');
			return withProject(project, async () => {
				const ref = optStr(args, 'ref') ?? (await get<Project>(env, `/projects/${pid}`)).default_branch ?? 'HEAD';
				const start = args.startLine != null ? n(args.startLine, 1) : undefined;
				const end = args.endLine != null ? n(args.endLine, 0) || undefined : undefined;
				type Blame = { commit: { id: string; author_name?: string; author_email?: string; authored_date?: string; committed_date?: string }; lines: string[] };
				const ranges = await get<Blame[]>(env, `/projects/${pid}/repository/files/${encodeURIComponent(path)}/blame`, { ref, 'range[start]': start, 'range[end]': end });
				const out: string[] = [];
				let ln = start ?? 1;
				for (const r of ranges ?? []) {
					const sha = (r.commit?.id ?? '').slice(0, 7);
					const author = (r.commit?.author_name ?? '?').slice(0, 18);
					const d = (r.commit?.authored_date ?? r.commit?.committed_date ?? '').slice(0, 10);
					for (const line of r.lines ?? []) { out.push(`${sha} ${author.padEnd(18)} ${d} | ${String(ln).padStart(4)}: ${line}`); ln++; }
				}
				return clip(`// blame ${path} @ ${ref}${start ? ` lines ${start}-${end ?? ''}` : ''}\n${out.join('\n')}`);
			});
		}
		case 'gitlab_search': {
			const scope = reqStr(args, 'scope'); const query = reqStr(args, 'query'); const limit = limitOf(env, args);
			if (!['blobs', 'issues', 'merge_requests', 'commits'].includes(scope)) { throw new IntegrationError(`gitlab: scope must be one of blobs|issues|merge_requests|commits (got ${scope})`); }
			let project: string | undefined;
			try { project = resolveProjectPath(env, args.project); } catch { project = undefined; }
			const path = project ? `/projects/${projectId(project)}/search` : '/search';
			const run = async () => {
				const results = await getList<Record<string, unknown>>(env, path, { scope, search: query }, limit);
				if (!results.length) { return `No ${scope} matching "${query}"${project ? ` in ${project}` : ''}`; }
				const lines = results.map(r => {
					switch (scope) {
						case 'blobs': return `${String(r.path ?? r.filename ?? '?')}:${String(r.startline ?? '?')}${r.ref ? ` @${String(r.ref)}` : ''}\n${clip(String(r.data ?? '').replace(/\n+$/, ''), 400).replace(/^/gm, '    ')}`;
						case 'commits': return `${String(r.short_id ?? String(r.id ?? '').slice(0, 8))} ${String(r.title ?? '')} · ${String(r.author_name ?? '')} · ${date(String(r.created_at ?? ''))}`;
						case 'merge_requests': return mrLine(r as unknown as Mr);
						default: return issueLine(r as unknown as Issue);
					}
				});
				return clip(`${results.length} ${scope} result(s) for "${query}"${project ? ` in ${project}` : ' (global)'}\n${lines.join('\n')}`);
			};
			return project ? withProject(project, run) : run();
		}
		case 'gitlab_commits': {
			const project = resolveProjectPath(env, args.project); const pid = projectId(project); const limit = limitOf(env, args);
			return withProject(project, async () => {
				type Commit = { id: string; short_id?: string; title?: string; author_name?: string; created_at?: string; committed_date?: string };
				const cs = await getList<Commit>(env, `/projects/${pid}/repository/commits`, { ref_name: optStr(args, 'ref'), path: optStr(args, 'path'), since: optStr(args, 'since') }, limit);
				return cs.length ? clip(cs.map(c => `${c.short_id ?? c.id.slice(0, 8)} ${c.title ?? ''} · ${c.author_name ?? ''} · ${date(c.committed_date ?? c.created_at)}`).join('\n')) : `No commits in ${project}`;
			});
		}
		case 'gitlab_issues': {
			const project = resolveProjectPath(env, args.project); const pid = projectId(project); const limit = limitOf(env, args);
			return withProject(project, async () => {
				const is = await getList<Issue>(env, `/projects/${pid}/issues`, { state: optStr(args, 'state') ?? 'opened', labels: optStr(args, 'labels'), search: optStr(args, 'search'), order_by: 'updated_at', sort: 'desc' }, limit);
				return is.length ? clip(is.map(issueLine).join('\n')) : `No issues in ${project}`;
			});
		}
		case 'gitlab_get_issue': {
			const project = resolveProjectPath(env, args.project); const pid = projectId(project); const iid = reqNum(args, 'iid');
			return withProject(project, async () => {
				const i = await get<Issue>(env, `/projects/${pid}/issues/${iid}`);
				return clip([
					`#${i.iid} ${i.title}`,
					`State: ${i.state} · Author: ${who(i.author)} · Created: ${date(i.created_at)} · Updated: ${date(i.updated_at)}`,
					`Assignees: ${i.assignees?.length ? i.assignees.map(who).join(', ') : '—'}${i.labels?.length ? ` · Labels: ${i.labels.join(', ')}` : ''}${i.milestone?.title ? ` · Milestone: ${i.milestone.title}` : ''}${i.user_notes_count != null ? ` · Comments: ${i.user_notes_count}` : ''}`,
					`URL: ${i.web_url ?? ''}`,
					'',
					`Description:\n${clip((i.description ?? '').trim() || '(none)', 4000)}`,
				].join('\n'));
			});
		}
	}
	throw new IntegrationError(`gitlab: unknown tool ${name}`);
}

async function execWrite(name: string, args: Record<string, unknown>, env: AdapterEnv): Promise<string> {
	const project = resolveProjectPath(env, args.project); const pid = projectId(project);
	return withProject(project, async () => {
		switch (name) {
			case 'gitlab_create_branch': {
				const r = await send<{ name: string; web_url?: string; commit?: { short_id?: string; id?: string } }>(env, 'POST', `/projects/${pid}/repository/branches`, { branch: reqStr(args, 'branch'), ref: reqStr(args, 'ref') });
				return `Created branch ${r.name} at ${r.commit?.short_id ?? (r.commit?.id ?? '').slice(0, 8)}${r.web_url ? ` — ${r.web_url}` : ''}`;
			}
			case 'gitlab_create_mr': {
				const target = optStr(args, 'targetBranch') ?? (await get<Project>(env, `/projects/${pid}`)).default_branch;
				if (!target) { throw new IntegrationError('gitlab: targetBranch not given and project has no default branch'); }
				let title = reqStr(args, 'title');
				if (args.draft === true && !/^draft:/i.test(title)) { title = `Draft: ${title}`; }
				const body: Record<string, unknown> = { source_branch: reqStr(args, 'sourceBranch'), target_branch: target, title };
				if (optStr(args, 'description')) { body.description = String(args.description); }
				if (args.removeSourceBranch !== undefined) { body.remove_source_branch = args.removeSourceBranch === true; }
				if (optStr(args, 'labels')) { body.labels = String(args.labels); }
				const a = idList(args.assigneeIds); if (a?.length) { body.assignee_ids = a; }
				const rv = idList(args.reviewerIds); if (rv?.length) { body.reviewer_ids = rv; }
				const m = await send<Mr>(env, 'POST', `/projects/${pid}/merge_requests`, body);
				return `Created !${m.iid} ${m.title} (${m.source_branch} → ${m.target_branch})\n${m.web_url ?? ''}`;
			}
			case 'gitlab_mr_comment': {
				const iid = reqNum(args, 'iid'); const body = reqStr(args, 'body');
				const filePath = optStr(args, 'filePath'); const line = args.line != null ? n(args.line, 0) : 0;
				if (filePath && line > 0) {
					let base = optStr(args, 'baseSha'), head = optStr(args, 'headSha'), start = optStr(args, 'startSha');
					if (!base || !head || !start) {
						const m = await get<Mr>(env, `/projects/${pid}/merge_requests/${iid}`);
						base = base ?? m.diff_refs?.base_sha; head = head ?? m.diff_refs?.head_sha; start = start ?? m.diff_refs?.start_sha;
						if (!base || !head || !start) { throw new IntegrationError(`gitlab: !${iid} has no diff_refs; pass baseSha/headSha/startSha explicitly`); }
					}
					const payload = { body, position: { position_type: 'text', base_sha: base, head_sha: head, start_sha: start, new_path: filePath, old_path: filePath, new_line: line } };
					const d = await send<{ id: string; notes?: { id: number }[] }>(env, 'POST', `/projects/${pid}/merge_requests/${iid}/discussions`, payload);
					return `Started discussion ${d.id} on !${iid} at ${filePath}:${line}`;
				}
				const note = await send<{ id: number }>(env, 'POST', `/projects/${pid}/merge_requests/${iid}/notes`, { body });
				return `Added note ${note.id} to !${iid}`;
			}
			case 'gitlab_mr_approve': {
				const iid = reqNum(args, 'iid');
				const r = await send<{ approved?: boolean; approvals_left?: number; approved_by?: { user?: User }[] }>(env, 'POST', `/projects/${pid}/merge_requests/${iid}/approve`, {});
				return `Approved !${iid}${r.approvals_left != null ? ` (${r.approvals_left} approval(s) still required)` : ''}${r.approved_by?.length ? ` · approved by ${r.approved_by.map(a => who(a.user)).join(', ')}` : ''}`;
			}
			case 'gitlab_pipeline_retry': {
				const id = reqNum(args, 'id');
				const p = await send<Pipeline>(env, 'POST', `/projects/${pid}/pipelines/${id}/retry`, {});
				return `Retried pipeline #${p.id ?? id}: ${p.status ?? 'pending'}${p.web_url ? ` — ${p.web_url}` : ''}`;
			}
			case 'gitlab_pipeline_cancel': {
				const id = reqNum(args, 'id');
				const p = await send<Pipeline>(env, 'POST', `/projects/${pid}/pipelines/${id}/cancel`, {});
				return `Cancelled pipeline #${p.id ?? id}: ${p.status ?? 'canceled'}`;
			}
			case 'gitlab_issue_comment': {
				const iid = reqNum(args, 'iid');
				const note = await send<{ id: number }>(env, 'POST', `/projects/${pid}/issues/${iid}/notes`, { body: reqStr(args, 'body') });
				return `Added note ${note.id} to issue #${iid}`;
			}
			case 'gitlab_create_issue': {
				const body: Record<string, unknown> = { title: reqStr(args, 'title') };
				if (optStr(args, 'description')) { body.description = String(args.description); }
				if (optStr(args, 'labels')) { body.labels = String(args.labels); }
				const i = await send<Issue>(env, 'POST', `/projects/${pid}/issues`, body);
				return `Created issue #${i.iid} ${i.title}\n${i.web_url ?? ''}`;
			}
		}
		throw new IntegrationError(`gitlab: unknown tool ${name}`);
	});
}

/* ───────────────────────────── adapter ───────────────────────────── */

export const gitlabAdapter: IntegrationAdapter = {
	id: 'gitlab',
	displayName: 'GitLab',
	settingsSchema: {
		baseUrl: { type: 'string', description: 'GitLab base URL, e.g. https://gitlab.bosch.com or https://gitlab.com', default: '' },
		defaultProject: { type: 'string', description: "Default project path 'group/subgroup/project'. Empty = resolve from the workspace git origin remote.", default: '' },
		maxResults: { type: 'number', description: 'Default maximum number of list results per tool call', default: 20 },
		authKind: { type: 'enum', description: "'pat' sends PRIVATE-TOKEN (personal/project/group access token); 'oauth' sends Authorization: Bearer", default: 'pat', enum: ['pat', 'oauth'] },
		apiVersion: { type: 'string', description: 'REST API version (fixed)', default: API_VERSION },
	},
	credentials: [{ key: 'token', label: 'Personal access token (api scope) or OAuth token', secret: true, hint: 'User Settings → Access Tokens → scope `api` (read_api suffices for read-only use)' }],
	tools,
	async health(env: AdapterEnv): Promise<Health> {
		const t0 = Date.now();
		try {
			const user = await get<{ username?: string; name?: string; id?: number }>(env, '/user');
			const detail: Record<string, unknown> = { username: user.username, userId: user.id, baseUrl: baseUrlOf(env.settings ?? {}, 'gitlab'), apiVersion: API_VERSION };
			let project: string | undefined;
			try { project = resolveProjectPath(env); } catch (e) { detail.project = `unresolved: ${(e as Error).message}`; }
			if (project) {
				try {
					const p = await get<Project>(env, `/projects/${projectId(project)}`);
					detail.project = p.path_with_namespace; detail.projectId = p.id; detail.defaultBranch = p.default_branch;
				} catch (e) {
					return { ok: false, message: `GitLab reachable as ${user.username ?? '?'}, but project ${project} is not accessible: ${(e as Error).message}`, detail: { ...detail, project }, latencyMs: Date.now() - t0 };
				}
			}
			return { ok: true, message: `GitLab OK as ${user.username ?? user.name ?? '?'}${project ? ` · project ${detail.project}` : ' · no project resolved'}`, detail, latencyMs: Date.now() - t0 };
		} catch (e) {
			return { ok: false, message: `GitLab: ${(e as Error).message}`, latencyMs: Date.now() - t0 };
		}
	},
	async execute(toolName: string, args: Record<string, unknown>, env: AdapterEnv): Promise<string> {
		const spec = tools.find(t => t.name === toolName);
		if (!spec) { throw new IntegrationError(`gitlab: unknown tool ${toolName}`); }
		return spec.kind === 'write' ? execWrite(toolName, args ?? {}, env) : execRead(toolName, args ?? {}, env);
	},
};

export default gitlabAdapter;
