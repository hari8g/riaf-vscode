import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AdapterEnv } from '../../src/integrations/adapter.js';
import { IntegrationError } from '../../src/integrations/adapter.js';
import { gitlabAdapter, projectPathFromRemote, resolveProjectPath } from '../../src/integrations/gitlab.js';

/* ───────────────────────────── fake GitLab ───────────────────────────── */

type Rec = { method: string; path: string; query: URLSearchParams; headers: IncomingMessage['headers']; body: unknown };
const recorded: Rec[] = [];
const PID = encodeURIComponent('group/sub/proj');

const mr = {
	iid: 7, title: 'Add caching layer', description: 'Adds an LRU cache.\n\nCloses #3', state: 'opened', author: { username: 'alice' },
	source_branch: 'feat/cache', target_branch: 'main', updated_at: '2026-10-28T09:30:00.000Z', created_at: '2026-10-27T08:00:00.000Z',
	web_url: 'https://gitlab.example/group/sub/proj/-/merge_requests/7', draft: false, labels: ['perf'], reviewers: [{ username: 'bob' }], assignees: [],
	head_pipeline: { status: 'success', id: 501 }, sha: 'abcdef1234567890', diff_refs: { base_sha: 'base000', head_sha: 'head111', start_sha: 'start222' }, detailed_merge_status: 'mergeable',
};

function respond(req: Rec): { status?: number; json?: unknown; text?: string; headers?: Record<string, string> } {
	const p = req.path;
	if (p === '/api/v4/user') { return { json: { id: 42, username: 'hari', name: 'Hari' } }; }
	if (p === `/api/v4/projects/${encodeURIComponent('group/missing')}`) { return { status: 404, json: { message: '404 Project Not Found' } }; }
	if (p === `/api/v4/projects/${PID}`) { return { json: { id: 11, path_with_namespace: 'group/sub/proj', default_branch: 'main', visibility: 'internal', last_activity_at: '2026-10-28T10:00:00Z', open_issues_count: 3, web_url: 'https://gitlab.example/group/sub/proj' } }; }
	if (p === `/api/v4/projects/${PID}/merge_requests`) {
		if (req.method === 'POST') { return { status: 201, json: { ...mr, iid: 8, title: (req.body as { title: string }).title, source_branch: (req.body as { source_branch: string }).source_branch, target_branch: (req.body as { target_branch: string }).target_branch, web_url: 'https://gitlab.example/group/sub/proj/-/merge_requests/8' } }; }
		const page = Number(req.query.get('page') ?? '1'); const per = Number(req.query.get('per_page') ?? '20');
		const total = 150;
		const start = (page - 1) * per;
		const items = Array.from({ length: Math.max(0, Math.min(per, total - start)) }, (_, i) => ({ ...mr, iid: start + i + 1, title: `MR ${start + i + 1}` }));
		const next = start + per < total ? String(page + 1) : '';
		return { json: items, headers: { 'x-next-page': next, 'x-total': String(total) } };
	}
	if (p === `/api/v4/projects/${PID}/merge_requests/7`) { return { json: mr }; }
	if (p === `/api/v4/projects/${PID}/merge_requests/7/approvals`) { return { json: { approved: false, approvals_required: 2, approvals_left: 1, approved_by: [{ user: { username: 'bob' } }] } }; }
	if (p === `/api/v4/projects/${PID}/merge_requests/7/changes`) {
		return { json: { changes: [
			{ old_path: 'src/cache.ts', new_path: 'src/cache.ts', new_file: true, diff: '@@ -0,0 +1,3 @@\n+a\n+b\n+c\n' },
			{ old_path: 'src/index.ts', new_path: 'src/index.ts', diff: '@@ -1,2 +1,2 @@\n-old\n+new\n context\n' },
		] } };
	}
	if (p === `/api/v4/projects/${PID}/merge_requests/7/discussions`) {
		if (req.method === 'POST') { return { status: 201, json: { id: 'disc123', notes: [{ id: 900 }] } }; }
		return { json: [
			{ id: 'aaaaaaaa1111', notes: [{ id: 1, author: { username: 'bob' }, body: 'Please add a test', resolvable: true, resolved: false, created_at: '2026-10-28T09:00:00Z', position: { new_path: 'src/cache.ts', new_line: 12 } }] },
			{ id: 'bbbbbbbb2222', notes: [{ id: 2, author: { username: 'carol' }, body: 'nit: naming', resolvable: true, resolved: true, created_at: '2026-10-28T09:05:00Z', position: { new_path: 'src/index.ts', new_line: 1 } }, { id: 3, author: { username: 'alice' }, body: 'done', resolvable: true, resolved: true }] },
			{ id: 'cccccccc3333', notes: [{ id: 4, author: { username: 'alice' }, body: 'general comment', resolvable: false }] },
			{ id: 'dddddddd4444', notes: [{ id: 5, system: true, body: 'changed the description' }] },
		] };
	}
	if (p === `/api/v4/projects/${PID}/merge_requests/7/notes` && req.method === 'POST') { return { status: 201, json: { id: 777 } }; }
	if (p === `/api/v4/projects/${PID}/pipelines`) { return { json: [{ id: 501, status: 'success', ref: 'main', sha: 'abcdef1234', updated_at: '2026-10-28T10:00:00Z', duration: 125 }] }; }
	if (p === `/api/v4/projects/${PID}/pipelines/501`) { return { json: { id: 501, status: 'success', ref: 'main', sha: 'abcdef1234', duration: 125, user: { username: 'alice' }, web_url: 'https://gitlab.example/p/501' } }; }
	if (p === `/api/v4/projects/${PID}/pipelines/501/jobs`) { return { json: [{ id: 9001, name: 'lint', stage: 'test', status: 'success', duration: 30 }, { id: 9002, name: 'unit', stage: 'test', status: 'failed', duration: 95, allow_failure: false, failure_reason: 'script_failure' }, { id: 9003, name: 'deploy', stage: 'deploy', status: 'manual' }] }; }
	if (p === `/api/v4/projects/${PID}/jobs/9002/trace`) {
		const lines = Array.from({ length: 300 }, (_, i) => `\x1b[32mline ${i + 1}\x1b[0m`);
		return { text: lines.join('\n') + '\n\x1b[31;1mERROR: tests failed\x1b[0m\n' };
	}
	if (p === `/api/v4/projects/${PID}/repository/files/${encodeURIComponent('src/cache.ts')}/raw`) { return { text: `export const cache = new Map(); // ref=${req.query.get('ref')}\n` }; }
	if (p === `/api/v4/projects/${PID}/repository/files/${encodeURIComponent('src/cache.ts')}/blame`) {
		return { json: [
			{ commit: { id: 'abc1234def', author_name: 'Alice Smith', authored_date: '2026-10-01T10:00:00Z' }, lines: ['import x', 'import y'] },
			{ commit: { id: '9876543fed', author_name: 'Bob', authored_date: '2026-10-20T10:00:00Z' }, lines: ['export const cache = new Map();'] },
		] };
	}
	if (p === `/api/v4/projects/${PID}/search`) { return { json: [{ path: 'src/cache.ts', filename: 'cache.ts', startline: 3, ref: 'main', data: 'export const cache = new Map();\n' }] }; }
	if (p === `/api/v4/projects/${PID}/repository/commits`) { return { json: [{ id: 'abc1234def', short_id: 'abc1234d', title: 'Add cache', author_name: 'Alice', committed_date: '2026-10-20T10:00:00Z' }] }; }
	if (p === `/api/v4/projects/${PID}/issues`) { return { json: [{ iid: 3, title: 'Slow startup', state: 'opened', author: { username: 'dave' }, labels: ['bug'], updated_at: '2026-10-25T00:00:00Z' }] }; }
	if (p === `/api/v4/projects/${PID}/issues/3`) { return { json: { iid: 3, title: 'Slow startup', state: 'opened', author: { username: 'dave' }, labels: ['bug'], description: 'Startup takes 10s', web_url: 'https://gitlab.example/i/3' } }; }
	if (p === `/api/v4/projects/${PID}/repository/branches` && req.method === 'POST') { return { status: 201, json: { name: (req.body as { branch: string }).branch, commit: { short_id: 'abc1234d' } } }; }
	if (p === `/api/v4/projects/${PID}/merge_requests/7/approve` && req.method === 'POST') { return { status: 201, json: { approved: true, approvals_left: 0, approved_by: [{ user: { username: 'hari' } }] } }; }
	return { status: 404, json: { message: `404 Not Found: ${p}` } };
}

let server: Server; let base = '';

beforeAll(async () => {
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', c => chunks.push(c as Buffer));
		req.on('end', () => {
			const u = new URL(req.url ?? '/', 'http://x');
			const raw = Buffer.concat(chunks).toString('utf8');
			let body: unknown = undefined; try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
			const rec: Rec = { method: req.method ?? 'GET', path: u.pathname, query: u.searchParams, headers: req.headers, body };
			recorded.push(rec);
			const r = respond(rec);
			res.writeHead(r.status ?? 200, { 'content-type': r.text !== undefined ? 'text/plain' : 'application/json', ...(r.headers ?? {}) });
			res.end(r.text !== undefined ? r.text : JSON.stringify(r.json ?? {}));
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
	const addr = server.address();
	base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => { recorded.length = 0; });

const envOf = (settings: Record<string, unknown> = {}, extra: Partial<AdapterEnv> = {}): AdapterEnv => ({
	fetch: (url, init) => fetch(url, init),
	getSecret: async key => key === 'token' ? 'glpat-secret' : undefined,
	settings: { baseUrl: base, defaultProject: 'group/sub/proj', ...settings },
	...extra,
});
const last = () => recorded[recorded.length - 1];

/* ───────────────────────────── tests ───────────────────────────── */

describe('gitlab adapter: auth', () => {
	it('sends PRIVATE-TOKEN by default and Bearer for oauth', async () => {
		await gitlabAdapter.execute('gitlab_get_issue', { iid: 3 }, envOf());
		expect(last().headers['private-token']).toBe('glpat-secret');
		expect(last().headers.authorization).toBeUndefined();
		await gitlabAdapter.execute('gitlab_get_issue', { iid: 3 }, envOf({ authKind: 'oauth' }));
		expect(last().headers.authorization).toBe('Bearer glpat-secret');
		expect(last().headers['private-token']).toBeUndefined();
	});
	it('fails readably without a token', async () => {
		await expect(gitlabAdapter.execute('gitlab_get_issue', { iid: 3 }, { ...envOf(), getSecret: async () => undefined })).rejects.toThrow(/no token/);
	});
});

describe('gitlab adapter: project resolution', () => {
	const remotes: [string, string][] = [
		['git@gitlab.bosch.com:group/sub/proj.git', 'group/sub/proj'],
		['git@gitlab.com:group/proj', 'group/proj'],
		['https://gitlab.bosch.com/group/sub/proj.git', 'group/sub/proj'],
		['https://user@gitlab.com/group/proj', 'group/proj'],
		['ssh://git@gitlab.bosch.com:2222/group/sub/proj.git', 'group/sub/proj'],
	];
	it.each(remotes)('parses %s', (remote, expected) => { expect(projectPathFromRemote(remote)).toBe(expected); });

	const withRepo = (origin: string, fn: (root: string) => void) => {
		const root = mkdtempSync(join(tmpdir(), 'riaf-gl-'));
		try {
			execFileSync('git', ['-C', root, 'init', '-q']);
			execFileSync('git', ['-C', root, 'remote', 'add', 'origin', origin]);
			fn(root);
		} finally { rmSync(root, { recursive: true, force: true }); }
	};
	it('resolves from a real git repo with ssh origin', () => {
		withRepo('git@gitlab.bosch.com:mps/riaf/core.git', root => {
			expect(resolveProjectPath({ fetch, getSecret: async () => undefined, settings: {}, workspaceRoot: root })).toBe('mps/riaf/core');
		});
	});
	it('resolves from a real git repo with https origin and .git suffix', () => {
		withRepo('https://gitlab.bosch.com/mps/riaf/core.git', root => {
			expect(resolveProjectPath({ fetch, getSecret: async () => undefined, settings: {}, workspaceRoot: root })).toBe('mps/riaf/core');
		});
		withRepo('https://gitlab.com/mps/core', root => {
			expect(resolveProjectPath({ fetch, getSecret: async () => undefined, settings: {}, workspaceRoot: root })).toBe('mps/core');
		});
	});
	it('prefers explicit arg, then defaultProject, and errors when nothing resolves', () => {
		expect(resolveProjectPath(envOf(), 'other/thing')).toBe('other/thing');
		expect(resolveProjectPath(envOf())).toBe('group/sub/proj');
		const root = mkdtempSync(join(tmpdir(), 'riaf-gl-nogit-'));
		try { expect(() => resolveProjectPath({ fetch, getSecret: async () => undefined, settings: {}, workspaceRoot: root })).toThrow(/no project given/); }
		finally { rmSync(root, { recursive: true, force: true }); }
	});
});

describe('gitlab adapter: read tools', () => {
	it('gitlab_project summarises the project', async () => {
		const out = await gitlabAdapter.execute('gitlab_project', {}, envOf());
		expect(out).toContain('Project: group/sub/proj (id 11)');
		expect(out).toContain('Default branch: main · Visibility: internal');
		expect(out).toContain('Open issues: 3');
		expect(recorded[0].path).toBe(`/api/v4/projects/${PID}`);
	});
	it('gitlab_list_mrs formats one line per MR and respects limit via per_page', async () => {
		const out = await gitlabAdapter.execute('gitlab_list_mrs', { limit: 5, state: 'all', author: 'alice' }, envOf());
		expect(out.split('\n')).toHaveLength(5);
		expect(out.split('\n')[0]).toBe('!1 [opened] MR 1 · alice · feat/cache→main · 2026-10-28 09:30');
		expect(last().query.get('per_page')).toBe('5');
		expect(last().query.get('state')).toBe('all');
		expect(last().query.get('author_username')).toBe('alice');
		expect(recorded).toHaveLength(1);
	});
	it('pagination: follows x-next-page only when limit > 100', async () => {
		const out = await gitlabAdapter.execute('gitlab_list_mrs', { limit: 120 }, envOf());
		const pages = recorded.filter(r => r.path.endsWith('/merge_requests'));
		expect(pages).toHaveLength(2);
		expect(pages[0].query.get('per_page')).toBe('100');
		expect(pages[1].query.get('page')).toBe('2');
		expect(out.split('\n')).toHaveLength(120);
		recorded.length = 0;
		await gitlabAdapter.execute('gitlab_list_mrs', { limit: 100 }, envOf());
		expect(recorded.filter(r => r.path.endsWith('/merge_requests'))).toHaveLength(1);
	});
	it('gitlab_get_mr includes approvals, pipeline and change summary', async () => {
		const out = await gitlabAdapter.execute('gitlab_get_mr', { iid: 7 }, envOf());
		expect(out).toContain('!7 Add caching layer');
		expect(out).toContain('Branches: feat/cache → main (head abcdef12)');
		expect(out).toContain('Reviewers: bob');
		expect(out).toContain('Approvals: not approved (1/2 required) by bob');
		expect(out).toContain('Pipeline: success (#501)');
		expect(out).toContain('Changes: 2 file(s), +4/-1');
		expect(out).toContain('A src/cache.ts (+3/-0)');
		expect(out).toContain('M src/index.ts (+1/-1)');
		expect(out).toContain('Closes #3');
		expect(out).toContain(mr.web_url);
	});
	it('gitlab_mr_discussions lists threads and filters unresolved', async () => {
		const all = await gitlabAdapter.execute('gitlab_mr_discussions', { iid: 7 }, envOf());
		expect(all).toContain('3 thread(s)');
		expect(all).toContain('[UNRESOLVED] src/cache.ts:12');
		expect(all).toContain('[resolved] src/index.ts:1');
		expect(all).toContain('[note] general');
		expect(all).not.toContain('changed the description');
		const unresolved = await gitlabAdapter.execute('gitlab_mr_discussions', { iid: 7, unresolvedOnly: true }, envOf());
		expect(unresolved).toContain('1 thread(s)');
		expect(unresolved).toContain('bob 2026-10-28 09:00: Please add a test');
		expect(unresolved).not.toContain('nit: naming');
	});
	it('gitlab_pipelines / gitlab_pipeline show stages and jobs', async () => {
		const list = await gitlabAdapter.execute('gitlab_pipelines', { ref: 'main' }, envOf());
		expect(list).toContain('#501 success · main@abcdef12');
		expect(last().query.get('ref')).toBe('main');
		const one = await gitlabAdapter.execute('gitlab_pipeline', { id: 501 }, envOf());
		expect(one).toContain('Jobs (3)');
		expect(one).toMatch(/test:\n\s+success\s+lint \(9001\) 30s\n\s+failed\s+unit \(9002\) 1m35s — script_failure/);
		expect(one).toContain('deploy:\n  manual   deploy (9003)');
	});
	it('gitlab_job_log tails the trace with ANSI stripped', async () => {
		const out = await gitlabAdapter.execute('gitlab_job_log', { jobId: 9002, tail: 3 }, envOf());
		expect(out).toBe('[last 3 of 301 lines of job 9002]\nline 299\nline 300\nERROR: tests failed');
		expect(out).not.toContain('\x1b');
		const dflt = await gitlabAdapter.execute('gitlab_job_log', { jobId: 9002 }, envOf());
		expect(dflt.startsWith('[last 200 of 301 lines')).toBe(true);
	});
	it('gitlab_file reads raw content at ref (default branch when omitted)', async () => {
		const out = await gitlabAdapter.execute('gitlab_file', { path: 'src/cache.ts' }, envOf());
		expect(out).toBe('// src/cache.ts @ main\nexport const cache = new Map(); // ref=main\n');
		expect(last().path).toBe(`/api/v4/projects/${PID}/repository/files/${encodeURIComponent('src/cache.ts')}/raw`);
		const tagged = await gitlabAdapter.execute('gitlab_file', { path: 'src/cache.ts', ref: 'v1.2' }, envOf());
		expect(tagged).toContain('ref=v1.2');
	});
	it('gitlab_blame formats compact lines', async () => {
		const out = await gitlabAdapter.execute('gitlab_blame', { path: 'src/cache.ts', ref: 'main', startLine: 10, endLine: 12 }, envOf());
		const lines = out.split('\n');
		expect(lines[0]).toBe('// blame src/cache.ts @ main lines 10-12');
		expect(lines[1]).toBe('abc1234 Alice Smith        2026-10-01 |   10: import x');
		expect(lines[2]).toBe('abc1234 Alice Smith        2026-10-01 |   11: import y');
		expect(lines[3]).toBe('9876543 Bob                2026-10-20 |   12: export const cache = new Map();');
		expect(last().query.get('range[start]')).toBe('10');
		expect(last().query.get('range[end]')).toBe('12');
	});
	it('gitlab_search uses the project-scoped endpoint', async () => {
		const out = await gitlabAdapter.execute('gitlab_search', { scope: 'blobs', query: 'cache' }, envOf());
		expect(last().path).toBe(`/api/v4/projects/${PID}/search`);
		expect(last().query.get('scope')).toBe('blobs');
		expect(out).toContain('src/cache.ts:3 @main');
	});
	it('gitlab_commits / gitlab_issues / gitlab_get_issue', async () => {
		expect(await gitlabAdapter.execute('gitlab_commits', { ref: 'main', path: 'src' }, envOf())).toContain('abc1234d Add cache · Alice · 2026-10-20 10:00');
		expect(last().query.get('ref_name')).toBe('main');
		expect(await gitlabAdapter.execute('gitlab_issues', { labels: 'bug' }, envOf())).toBe('#3 [opened] Slow startup · dave · [bug] · 2026-10-25 00:00');
		expect(await gitlabAdapter.execute('gitlab_get_issue', { iid: 3 }, envOf())).toContain('Startup takes 10s');
	});
	it('maps a 404 project to a readable error naming the project', async () => {
		const err = await gitlabAdapter.execute('gitlab_project', { project: 'group/missing' }, envOf()).catch(e => e as IntegrationError);
		expect(err).toBeInstanceOf(IntegrationError);
		expect((err as IntegrationError).status).toBe(404);
		expect((err as Error).message).toMatch(/404.*not found.*\[project: group\/missing\]/);
	});
});

describe('gitlab adapter: write tools', () => {
	it('gitlab_create_mr builds the payload and returns iid + web_url', async () => {
		const out = await gitlabAdapter.execute('gitlab_create_mr', { sourceBranch: 'feat/x', title: 'Do X', description: 'Body', draft: true, removeSourceBranch: true, labels: 'a,b', assigneeIds: [1], reviewerIds: [2, 3] }, envOf());
		const post = recorded.find(r => r.method === 'POST')!;
		expect(post.path).toBe(`/api/v4/projects/${PID}/merge_requests`);
		expect(post.body).toEqual({ source_branch: 'feat/x', target_branch: 'main', title: 'Draft: Do X', description: 'Body', remove_source_branch: true, labels: 'a,b', assignee_ids: [1], reviewer_ids: [2, 3] });
		expect(out).toContain('Created !8 Draft: Do X (feat/x → main)');
		expect(out).toContain('merge_requests/8');
	});
	it('gitlab_mr_comment posts a plain note without a position', async () => {
		const out = await gitlabAdapter.execute('gitlab_mr_comment', { iid: 7, body: 'LGTM' }, envOf());
		expect(last().path).toBe(`/api/v4/projects/${PID}/merge_requests/7/notes`);
		expect(last().body).toEqual({ body: 'LGTM' });
		expect(out).toBe('Added note 777 to !7');
	});
	it('gitlab_mr_comment with file+line fetches diff_refs and opens a positioned discussion', async () => {
		const out = await gitlabAdapter.execute('gitlab_mr_comment', { iid: 7, body: 'Use a WeakMap', filePath: 'src/cache.ts', line: 12 }, envOf());
		expect(recorded.map(r => `${r.method} ${r.path}`)).toEqual([
			`GET /api/v4/projects/${PID}/merge_requests/7`,
			`POST /api/v4/projects/${PID}/merge_requests/7/discussions`,
		]);
		expect(last().body).toEqual({ body: 'Use a WeakMap', position: { position_type: 'text', base_sha: 'base000', head_sha: 'head111', start_sha: 'start222', new_path: 'src/cache.ts', old_path: 'src/cache.ts', new_line: 12 } });
		expect(out).toBe('Started discussion disc123 on !7 at src/cache.ts:12');
	});
	it('gitlab_mr_comment with explicit shas skips the MR fetch', async () => {
		await gitlabAdapter.execute('gitlab_mr_comment', { iid: 7, body: 'x', filePath: 'src/cache.ts', line: 1, baseSha: 'b', headSha: 'h', startSha: 's' }, envOf());
		expect(recorded).toHaveLength(1);
		expect((last().body as { position: { base_sha: string } }).position.base_sha).toBe('b');
	});
	it('gitlab_create_branch and gitlab_mr_approve', async () => {
		expect(await gitlabAdapter.execute('gitlab_create_branch', { branch: 'feat/y', ref: 'main' }, envOf())).toBe('Created branch feat/y at abc1234d');
		expect(last().body).toEqual({ branch: 'feat/y', ref: 'main' });
		expect(await gitlabAdapter.execute('gitlab_mr_approve', { iid: 7 }, envOf())).toContain('Approved !7 (0 approval(s) still required) · approved by hari');
	});
});

describe('gitlab adapter: health and metadata', () => {
	it('health reports username and the resolved project', async () => {
		const h = await gitlabAdapter.health(envOf());
		expect(h.ok).toBe(true);
		expect(h.message).toContain('hari');
		expect(h.detail?.project).toBe('group/sub/proj');
		expect(h.detail?.username).toBe('hari');
		expect(recorded.map(r => r.path)).toEqual(['/api/v4/user', `/api/v4/projects/${PID}`]);
	});
	it('health is not ok when the project is missing or the token is rejected', async () => {
		const h = await gitlabAdapter.health(envOf({ defaultProject: 'group/missing' }));
		expect(h.ok).toBe(false);
		expect(h.message).toContain('group/missing');
		const bad = await gitlabAdapter.health({ ...envOf(), getSecret: async () => undefined });
		expect(bad.ok).toBe(false);
		expect(bad.message).toMatch(/no token/);
	});
	it('declares id, settings, credentials and uniquely named gitlab_* tools', () => {
		expect(gitlabAdapter.id).toBe('gitlab');
		expect(Object.keys(gitlabAdapter.settingsSchema)).toEqual(['baseUrl', 'defaultProject', 'maxResults', 'authKind', 'apiVersion']);
		expect(gitlabAdapter.credentials).toEqual([expect.objectContaining({ key: 'token', secret: true })]);
		const names = gitlabAdapter.tools.map(t => t.name);
		expect(new Set(names).size).toBe(names.length);
		expect(names.every(nm => nm.startsWith('gitlab_'))).toBe(true);
		expect(gitlabAdapter.tools.filter(t => t.kind === 'write').map(t => t.name)).toEqual(['gitlab_create_branch', 'gitlab_create_mr', 'gitlab_mr_comment', 'gitlab_mr_approve', 'gitlab_pipeline_retry', 'gitlab_pipeline_cancel', 'gitlab_issue_comment', 'gitlab_create_issue']);
	});
	it('rejects unknown tools', async () => {
		await expect(gitlabAdapter.execute('gitlab_nope', {}, envOf())).rejects.toThrow(/unknown tool/);
	});
});
