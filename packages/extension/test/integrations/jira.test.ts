import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jiraAdapter, resolveDeployment } from '../../src/integrations/jira.js';
import { FakeServer, decodeBasic, envFor } from './fakeServer.js';

const server = new FakeServer();
beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(() => server.reset());

const cloudSecrets = { 'riaf.integration.jira.email': 'me@example.com', 'riaf.integration.jira.token': 'cloud-token' };
const dcSecrets = { 'riaf.integration.jira.token': 'dc-pat' };
const cloud = (extra: Record<string, unknown> = {}) => envFor(server, { deployment: 'cloud', defaultProject: 'ABC', ...extra }, cloudSecrets);
const dc = (extra: Record<string, unknown> = {}) => envFor(server, { deployment: 'datacenter', ...extra }, dcSecrets);

const adf = { type: 'doc', version: 1, content: [
	{ type: 'paragraph', content: [{ type: 'text', text: 'First para with ' }, { type: 'mention', attrs: { text: '@Bob' } }] },
	{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item one' }] }] }] },
	{ type: 'codeBlock', content: [{ type: 'text', text: 'x = 1' }] },
] };

const issue = (key: string, status: string, summary: string, extra: Record<string, unknown> = {}) => ({ id: '1', key, fields: { summary, status: { name: status }, issuetype: { name: 'Task' }, assignee: { displayName: 'Alice' }, ...extra } });

describe('jira adapter', () => {
	it('declares the contract surface', () => {
		expect(jiraAdapter.id).toBe('jira');
		expect(jiraAdapter.credentials.map(c => c.key)).toEqual(['email', 'token']);
		expect(jiraAdapter.credentials.find(c => c.key === 'token')?.secret).toBe(true);
		expect(jiraAdapter.tools.map(t => t.name)).toEqual(['jira_search', 'jira_get_issue', 'jira_get_comments', 'jira_list_transitions', 'jira_sprint', 'jira_my_issues', 'jira_create_issue', 'jira_transition', 'jira_comment', 'jira_assign', 'jira_link_issues']);
		expect(jiraAdapter.tools.filter(t => t.kind === 'write').map(t => t.name)).toEqual(['jira_create_issue', 'jira_transition', 'jira_comment', 'jira_assign', 'jira_link_issues']);
		expect(jiraAdapter.settingsSchema.deployment.enum).toEqual(['auto', 'cloud', 'datacenter']);
	});

	it('auto-detects deployment from the hostname', () => {
		expect(resolveDeployment({}, 'https://acme.atlassian.net')).toBe('cloud');
		expect(resolveDeployment({}, 'https://jira.corp.example.com/jira')).toBe('datacenter');
		expect(resolveDeployment({ deployment: 'datacenter' }, 'https://acme.atlassian.net')).toBe('datacenter');
	});

	it('uses basic auth + /rest/api/3 on cloud and bearer + /rest/api/2 on data center', async () => {
		server.on('GET', /\/rest\/api\/[23]\/myself$/, { displayName: 'Me', accountId: 'acc-1', name: 'me' });
		const h1 = await jiraAdapter.health(cloud());
		expect(h1.ok).toBe(true);
		expect(h1.message).toContain('Me');
		expect(server.requests[0].path).toBe('/rest/api/3/myself');
		expect(decodeBasic(server.requests[0].headers.authorization as string)).toBe('me@example.com:cloud-token');

		const h2 = await jiraAdapter.health(dc());
		expect(h2.ok).toBe(true);
		expect(server.requests[1].path).toBe('/rest/api/2/myself');
		expect(server.requests[1].headers.authorization).toBe('Bearer dc-pat');
	});

	it('falls back to basic auth on data center when an email is also stored', async () => {
		server.on('GET', '/rest/api/2/myself', { displayName: 'Me' });
		await jiraAdapter.health(envFor(server, { deployment: 'datacenter' }, { 'riaf.integration.jira.email': 'svc', 'riaf.integration.jira.token': 'pw' }));
		expect(decodeBasic(server.requests[0].headers.authorization as string)).toBe('svc:pw');
	});

	it('health maps 401 / 404 to readable messages', async () => {
		server.on('GET', '/rest/api/3/myself', () => ({ status: 401, json: { errorMessages: ['nope'] } }));
		const h = await jiraAdapter.health(cloud());
		expect(h.ok).toBe(false);
		expect(h.message).toMatch(/rejected the credentials \(401\)/);
		server.reset();
		const h2 = await jiraAdapter.health(cloud());
		expect(h2.ok).toBe(false);
		expect(h2.message).toMatch(/404/);
		expect(h2.message).toMatch(/baseUrl/);
	});

	it('fails fast without a token or baseUrl', async () => {
		const h = await jiraAdapter.health(envFor(server, { deployment: 'cloud' }, {}));
		expect(h.ok).toBe(false);
		expect(h.message).toMatch(/Set Integration Credentials/);
		await expect(jiraAdapter.execute('jira_search', { jql: 'x' }, { ...cloud(), settings: { deployment: 'cloud' } })).rejects.toThrow(/baseUrl is not set/);
	});

	it('jira_search formats compact lines with a total', async () => {
		server.on('POST', '/rest/api/3/search/jql', { total: 42, issues: [issue('ABC-1', 'To Do', 'Fix login'), issue('ABC-2', 'Done', 'Ship it', { assignee: null, priority: { name: 'High' } })] });
		const out = await jiraAdapter.execute('jira_search', { jql: 'project = ABC', fields: ['priority'] }, cloud({ maxResults: 2 }));
		expect(out).toContain('ABC-1  [To Do] Task · Alice · Fix login');
		expect(out).toContain('ABC-2  [Done] Task · unassigned · Ship it  {priority=High}');
		expect(out).toContain('— 42 issues (showing 2)');
		const req = server.requests[0];
		expect(req.body.jql).toBe('project = ABC');
		expect(req.body.maxResults).toBe(2);
		expect(req.body.fields).toContain('priority');
	});

	it('jira_search on data center posts to /rest/api/2/search', async () => {
		server.on('POST', '/rest/api/2/search', { total: 0, issues: [] });
		const out = await jiraAdapter.execute('jira_search', { jql: 'x' }, dc());
		expect(out).toBe('No issues matched.');
		expect(server.requests[0].body.startAt).toBe(0);
	});

	it('jira_get_issue renders ADF description as text on cloud', async () => {
		server.on('GET', '/rest/api/3/issue/ABC-7', {
			id: '7', key: 'ABC-7', fields: {
				summary: 'Big thing', status: { name: 'In Progress' }, issuetype: { name: 'Story' }, priority: { name: 'Medium' },
				assignee: { displayName: 'Alice' }, reporter: { displayName: 'Bob' }, labels: ['backend', 'urgent'], components: [{ name: 'api' }], fixVersions: [{ name: '1.2' }],
				created: '2026-01-02T03:04:05.000+0000', updated: '2026-02-03T04:05:06.000+0000', parent: { key: 'ABC-1', fields: { summary: 'Epic one' } },
				issuelinks: [{ type: { name: 'Blocks', outward: 'blocks', inward: 'is blocked by' }, outwardIssue: { key: 'ABC-9', fields: { summary: 'Downstream', status: { name: 'To Do' } } } }],
				description: adf, subtasks: [{ key: 'ABC-8', fields: { summary: 'Sub one', status: { name: 'Done' } } }],
			},
		});
		const out = await jiraAdapter.execute('jira_get_issue', { key: 'ABC-7' }, cloud());
		expect(out).toContain('ABC-7: Big thing');
		expect(out).toContain('status: In Progress · type: Story · priority: Medium');
		expect(out).toContain('assignee: Alice · reporter: Bob');
		expect(out).toContain('labels: backend, urgent');
		expect(out).toContain('components: api');
		expect(out).toContain('fixVersions: 1.2');
		expect(out).toContain('parent: ABC-1 Epic one');
		expect(out).toContain('blocks ABC-9 [To Do] Downstream');
		expect(out).toContain('First para with @Bob');
		expect(out).toContain('• item one');
		expect(out).toContain('```\nx = 1\n```');
		expect(out).toContain('ABC-8  [Done] Sub one');
		expect(out).toContain(`url: http://127.0.0.1:${server.port}/browse/ABC-7`);
		expect(server.requests[0].query.get('fields')).toBe('*all');
	});

	it('jira_get_issue passes wiki/plain description through on data center', async () => {
		server.on('GET', '/rest/api/2/issue/DC-1', { key: 'DC-1', fields: { summary: 's', status: { name: 'Open' }, issuetype: { name: 'Bug' }, description: 'h2. Heading\n* bullet' } });
		const out = await jiraAdapter.execute('jira_get_issue', { key: 'DC-1' }, dc());
		expect(out).toContain('h2. Heading\n* bullet');
	});

	it('jira_get_comments lists comments as text', async () => {
		server.on('GET', '/rest/api/3/issue/ABC-1/comment', { total: 1, comments: [{ id: '100', author: { displayName: 'Carol' }, created: '2026-03-01T10:00:00.000+0000', body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Looks good' }] }] } }] });
		const out = await jiraAdapter.execute('jira_get_comments', { key: 'ABC-1', limit: 5 }, cloud());
		expect(out).toContain('Carol (#100):\nLooks good');
		expect(server.requests[0].query.get('maxResults')).toBe('5');
	});

	it('jira_list_transitions and jira_transition resolve names case-insensitively', async () => {
		server.on('GET', '/rest/api/3/issue/ABC-1/transitions', { transitions: [{ id: '11', name: 'Start Progress', to: { name: 'In Progress' } }, { id: '31', name: 'Done', to: { name: 'Done' } }] });
		server.on('POST', '/rest/api/3/issue/ABC-1/transitions', () => ({ status: 204, text: '' }));
		const list = await jiraAdapter.execute('jira_list_transitions', { key: 'ABC-1' }, cloud());
		expect(list).toBe('11  Start Progress → In Progress\n31  Done → Done');

		const out = await jiraAdapter.execute('jira_transition', { key: 'ABC-1', transitionName: 'start progress', comment: 'on it' }, cloud());
		expect(out).toContain('transitioned via Start Progress → In Progress');
		const post = server.requests.find(r => r.method === 'POST')!;
		expect(post.body.transition).toEqual({ id: '11' });
		expect(post.body.update.comment[0].add.body.type).toBe('doc');

		// matches on target status name too
		await jiraAdapter.execute('jira_transition', { key: 'ABC-1', transitionName: 'IN PROGRESS' }, cloud());
		expect(server.requests.filter(r => r.method === 'POST')[1].body.transition.id).toBe('11');

		await expect(jiraAdapter.execute('jira_transition', { key: 'ABC-1', transitionName: 'Reopen' }, cloud())).rejects.toThrow(/no transition "Reopen".*Start Progress/);
	});

	it('jira_transition by id posts without resolving a name', async () => {
		server.on('GET', '/rest/api/2/issue/DC-1/transitions', { transitions: [{ id: '5', name: 'Close' }] });
		server.on('POST', '/rest/api/2/issue/DC-1/transitions', () => ({ status: 204, text: '' }));
		const out = await jiraAdapter.execute('jira_transition', { key: 'DC-1', transitionId: '5', comment: 'bye' }, dc());
		expect(out).toContain('via Close');
		const post = server.requests.find(r => r.method === 'POST')!;
		expect(post.body.update.comment[0].add.body).toBe('bye');
	});

	it('jira_create_issue builds an ADF description on cloud', async () => {
		server.on('POST', '/rest/api/3/issue', { id: '500', key: 'ABC-500' });
		const out = await jiraAdapter.execute('jira_create_issue', { issueType: 'Task', summary: 'New thing', description: 'para one\n\npara two', labels: ['a', 'b'], parentKey: 'ABC-1', assigneeAccountId: 'acc-9' }, cloud());
		expect(out).toContain('Created ABC-500');
		const f = server.requests[0].body.fields;
		expect(f.project).toEqual({ key: 'ABC' });
		expect(f.issuetype).toEqual({ name: 'Task' });
		expect(f.summary).toBe('New thing');
		expect(f.description).toEqual({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'para one' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'para two' }] }] });
		expect(f.labels).toEqual(['a', 'b']);
		expect(f.parent).toEqual({ key: 'ABC-1' });
		expect(f.assignee).toEqual({ accountId: 'acc-9' });
	});

	it('jira_create_issue sends plain description and name-assignee on data center', async () => {
		server.on('POST', '/rest/api/2/issue', { id: '1', key: 'DC-2' });
		await jiraAdapter.execute('jira_create_issue', { project: 'DC', issueType: 'Bug', summary: 's', description: 'h1. wiki', assigneeAccountId: 'jdoe' }, dc());
		const f = server.requests[0].body.fields;
		expect(f.description).toBe('h1. wiki');
		expect(f.assignee).toEqual({ name: 'jdoe' });
	});

	it('jira_create_issue requires a project when none is configured', async () => {
		await expect(jiraAdapter.execute('jira_create_issue', { issueType: 'Task', summary: 's' }, dc())).rejects.toThrow(/"project" is required/);
	});

	it('jira_comment, jira_assign and jira_link_issues post the right shapes', async () => {
		server.on('POST', '/rest/api/3/issue/ABC-1/comment', { id: '77' });
		server.on('GET', '/rest/api/3/myself', { accountId: 'acc-me', displayName: 'Me' });
		server.on('PUT', '/rest/api/3/issue/ABC-1/assignee', () => ({ status: 204, text: '' }));
		server.on('POST', '/rest/api/3/issueLink', () => ({ status: 201, text: '' }));

		expect(await jiraAdapter.execute('jira_comment', { key: 'ABC-1', body: 'hi' }, cloud())).toBe('ABC-1: comment #77 added');
		expect(server.requests[0].body.body.type).toBe('doc');

		expect(await jiraAdapter.execute('jira_assign', { key: 'ABC-1', accountId: 'me' }, cloud())).toBe('ABC-1: assigned to Me');
		const put = server.requests.find(r => r.method === 'PUT')!;
		expect(put.body).toEqual({ accountId: 'acc-me' });

		expect(await jiraAdapter.execute('jira_link_issues', { inward: 'ABC-1', outward: 'ABC-2' }, cloud())).toBe('Linked ABC-1 —Relates→ ABC-2');
		const link = server.requests.find(r => r.path === '/rest/api/3/issueLink')!;
		expect(link.body).toEqual({ type: { name: 'Relates' }, inwardIssue: { key: 'ABC-1' }, outwardIssue: { key: 'ABC-2' } });
	});

	it('jira_my_issues builds a currentUser() JQL', async () => {
		server.on('POST', '/rest/api/3/search/jql', { total: 0, issues: [] });
		await jiraAdapter.execute('jira_my_issues', { status: 'In Progress' }, cloud());
		expect(server.requests[0].body.jql).toBe('assignee = currentUser() AND status = "In Progress" ORDER BY updated DESC');
		await jiraAdapter.execute('jira_my_issues', {}, cloud());
		expect(server.requests[1].body.jql).toContain('resolution = Unresolved');
	});

	it('jira_sprint lists boards, resolves the active sprint, and reads sprint issues', async () => {
		server.on('GET', '/rest/agile/1.0/board', { values: [{ id: 3, name: 'ABC board', type: 'scrum', location: { projectKey: 'ABC' } }] });
		server.on('GET', '/rest/agile/1.0/board/3/sprint', { values: [{ id: 21, name: 'Sprint 21', state: 'active', startDate: '2026-10-01T00:00:00.000Z', endDate: '2026-10-14T00:00:00.000Z' }] });
		server.on('GET', '/rest/agile/1.0/sprint/21/issue', { total: 1, issues: [issue('ABC-3', 'In Progress', 'Sprint work')] });

		const boards = await jiraAdapter.execute('jira_sprint', {}, cloud());
		expect(boards).toContain('3  ABC board (scrum, ABC)');
		expect(server.requests[0].query.get('projectKeyOrId')).toBe('ABC');

		const out = await jiraAdapter.execute('jira_sprint', { boardId: 3 }, cloud());
		expect(out).toContain('Sprint 21 "Sprint 21" [active] 2026-10-01 → 2026-10-14');
		expect(out).toContain('ABC-3  [In Progress] Task · Alice · Sprint work');
		expect(server.requests.find(r => r.path === '/rest/agile/1.0/board/3/sprint')!.query.get('state')).toBe('active');

		await jiraAdapter.execute('jira_sprint', { sprintId: 21 }, dc());
		expect(server.requests[server.requests.length - 1].headers.authorization).toBe('Bearer dc-pat');
	});

	it('surfaces 401 from a tool call as a readable IntegrationError', async () => {
		server.on('POST', '/rest/api/3/search/jql', () => ({ status: 401, json: { errorMessages: ['Unauthorized'] } }));
		await expect(jiraAdapter.execute('jira_search', { jql: 'x' }, cloud())).rejects.toMatchObject({ name: 'IntegrationError', status: 401, message: expect.stringMatching(/credentials rejected/) });
	});

	it('rejects unknown tools and missing args', async () => {
		await expect(jiraAdapter.execute('jira_nope', {}, cloud())).rejects.toThrow(/unknown tool/);
		await expect(jiraAdapter.execute('jira_get_issue', {}, cloud())).rejects.toThrow(/"key" is required/);
	});
});
