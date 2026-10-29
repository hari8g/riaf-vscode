import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiBases, confluenceAdapter, resolveDeployment, toStorage } from '../../src/integrations/confluence.js';
import { FakeServer, decodeBasic, envFor } from './fakeServer.js';

const server = new FakeServer();
beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(() => server.reset());

const cloudSecrets = { 'riaf.integration.confluence.email': 'me@example.com', 'riaf.integration.confluence.token': 'conf-token' };
const dcSecrets = { 'riaf.integration.confluence.token': 'conf-pat' };
const cloud = (extra: Record<string, unknown> = {}) => envFor(server, { deployment: 'cloud', defaultSpace: 'ENG', ...extra }, cloudSecrets);
const dc = (extra: Record<string, unknown> = {}) => envFor(server, { deployment: 'datacenter', ...extra }, dcSecrets);

const page = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, type: 'page', status: 'current', title, space: { key: 'ENG', name: 'Engineering' }, version: { number: 3, when: '2026-05-01T12:00:00.000Z', by: { displayName: 'Dana' } }, _links: { webui: `/spaces/ENG/pages/${id}/${encodeURIComponent(title)}` }, ...extra });

describe('confluence adapter', () => {
	it('declares the contract surface', () => {
		expect(confluenceAdapter.id).toBe('confluence');
		expect(confluenceAdapter.credentials.map(c => c.key)).toEqual(['email', 'token']);
		expect(confluenceAdapter.tools.map(t => t.name)).toEqual(['confluence_search', 'confluence_get_page', 'confluence_children', 'confluence_page_history', 'confluence_attachments', 'confluence_create_page', 'confluence_update_page', 'confluence_comment', 'confluence_add_label']);
		expect(confluenceAdapter.tools.filter(t => t.kind === 'write').map(t => t.name)).toEqual(['confluence_create_page', 'confluence_update_page', 'confluence_comment', 'confluence_add_label']);
	});

	it('resolves deployment and API bases (no double /wiki)', () => {
		expect(resolveDeployment({}, 'https://acme.atlassian.net')).toBe('cloud');
		expect(resolveDeployment({}, 'https://wiki.corp')).toBe('datacenter');
		expect(apiBases('https://acme.atlassian.net', 'cloud')).toEqual({ api: 'https://acme.atlassian.net/wiki/rest/api', webBase: 'https://acme.atlassian.net/wiki' });
		expect(apiBases('https://acme.atlassian.net/wiki', 'cloud')).toEqual({ api: 'https://acme.atlassian.net/wiki/rest/api', webBase: 'https://acme.atlassian.net/wiki' });
		expect(apiBases('https://wiki.corp/confluence', 'datacenter')).toEqual({ api: 'https://wiki.corp/confluence/rest/api', webBase: 'https://wiki.corp/confluence' });
	});

	it('health uses basic auth under /wiki/rest/api on cloud and bearer under /rest/api on data center', async () => {
		server.on('GET', '/wiki/rest/api/space', { results: [{ key: 'ENG' }] });
		server.on('GET', '/rest/api/space', { results: [] });
		const h1 = await confluenceAdapter.health(cloud());
		expect(h1.ok).toBe(true);
		expect(h1.message).toContain('space ENG');
		expect(server.requests[0].query.get('limit')).toBe('1');
		expect(decodeBasic(server.requests[0].headers.authorization as string)).toBe('me@example.com:conf-token');

		const h2 = await confluenceAdapter.health(dc());
		expect(h2.ok).toBe(true);
		expect(server.requests[1].path).toBe('/rest/api/space');
		expect(server.requests[1].headers.authorization).toBe('Bearer conf-pat');
	});

	it('health reports 401 / 403 readably and fails without credentials', async () => {
		server.on('GET', '/wiki/rest/api/space', () => ({ status: 401, json: {} }));
		expect((await confluenceAdapter.health(cloud())).message).toMatch(/rejected the credentials \(401\)/);
		server.reset();
		server.on('GET', '/wiki/rest/api/space', () => ({ status: 403, json: {} }));
		expect((await confluenceAdapter.health(cloud())).message).toMatch(/403/);
		const h = await confluenceAdapter.health(envFor(server, { deployment: 'cloud' }, {}));
		expect(h.ok).toBe(false);
		expect(h.message).toMatch(/Set Integration Credentials/);
	});

	it('confluence_search builds CQL from text and formats hits', async () => {
		server.on('GET', '/wiki/rest/api/search', {
			totalSize: 2, results: [
				{ content: page('101', 'Runbook: deploys'), excerpt: 'How to <b>deploy</b> the&nbsp;thing', url: '/spaces/ENG/pages/101/Runbook', lastModified: '2026-05-02T08:00:00.000Z' },
				{ content: page('102', 'Deploy FAQ'), excerpt: '', url: '/spaces/ENG/pages/102/FAQ' },
			],
		});
		const out = await confluenceAdapter.execute('confluence_search', { text: 'deploy "prod"', limit: 5 }, cloud());
		const req = server.requests[0];
		expect(req.query.get('cql')).toBe('text ~ "deploy \\"prod\\"" AND type = page AND space = "ENG" ORDER BY lastmodified DESC');
		expect(req.query.get('limit')).toBe('5');
		expect(out).toContain('101  [ENG] Runbook: deploys  (updated 2026-05-02 08:00:00)');
		expect(out).toContain(`http://127.0.0.1:${server.port}/wiki/spaces/ENG/pages/101/Runbook`);
		expect(out).toContain('How to deploy the thing');
		expect(out).toContain('— 2 results');
	});

	it('confluence_search passes raw cql through, scoping by space when asked', async () => {
		server.on('GET', '/rest/api/search', { results: [] });
		expect(await confluenceAdapter.execute('confluence_search', { cql: 'label = runbook', space: 'OPS' }, dc())).toBe('No pages matched.');
		expect(server.requests[0].query.get('cql')).toBe('(label = runbook) AND space = "OPS"');
		await confluenceAdapter.execute('confluence_search', { cql: 'space = X AND label = y' }, dc());
		expect(server.requests[1].query.get('cql')).toBe('space = X AND label = y');
		await expect(confluenceAdapter.execute('confluence_search', {}, dc())).rejects.toThrow(/"text" or "cql"/);
	});

	it('confluence_get_page converts storage to text and includes metadata', async () => {
		server.on('GET', '/wiki/rest/api/content/101', page('101', 'Runbook', {
			ancestors: [{ id: '1', title: 'Home' }, { id: '50', title: 'Ops' }],
			metadata: { labels: { results: [{ name: 'runbook' }, { name: 'deploy' }] } },
			body: { storage: { value: '<h1>Steps</h1><p>First &amp; <strong>foremost</strong></p><ul><li>one</li><li>two</li></ul>' } },
		}));
		const out = await confluenceAdapter.execute('confluence_get_page', { id: '101' }, cloud());
		expect(out).toContain('Runbook (id 101)');
		expect(out).toContain('space: ENG (Engineering) · version: 3 @ 2026-05-01 12:00:00 by Dana');
		expect(out).toContain('ancestors: Home (1) › Ops (50)');
		expect(out).toContain('labels: runbook, deploy');
		expect(out).toContain('Steps\nFirst & foremost\n• one\n• two');
		expect(out).not.toContain('<strong>');
		expect(server.requests[0].query.get('expand')).toContain('body.storage');

		const raw = await confluenceAdapter.execute('confluence_get_page', { id: '101', bodyFormat: 'storage' }, cloud());
		expect(raw).toContain('<strong>foremost</strong>');
	});

	it('confluence_get_page resolves title + space', async () => {
		server.on('GET', '/rest/api/content', { results: [page('7', 'Design Doc', { body: { storage: { value: '<p>hi</p>' } } })] });
		const out = await confluenceAdapter.execute('confluence_get_page', { title: 'Design Doc', space: 'ENG' }, dc());
		expect(out).toContain('Design Doc (id 7)');
		expect(server.requests[0].query.get('title')).toBe('Design Doc');
		expect(server.requests[0].query.get('spaceKey')).toBe('ENG');
		server.reset();
		server.on('GET', '/rest/api/content', { results: [] });
		await expect(confluenceAdapter.execute('confluence_get_page', { title: 'Missing', space: 'ENG' }, dc())).rejects.toThrow(/no page titled "Missing"/);
		await expect(confluenceAdapter.execute('confluence_get_page', { title: 'x' }, dc())).rejects.toThrow(/"space" is required/);
	});

	it('confluence_children, confluence_page_history and confluence_attachments', async () => {
		server.on('GET', '/wiki/rest/api/content/101/child/page', { size: 1, results: [page('201', 'Child A')] });
		server.on('GET', '/wiki/rest/api/content/101/version', { results: [{ number: 3, when: '2026-05-01T12:00:00.000Z', by: { displayName: 'Dana' }, message: 'tidy' }, { number: 2, when: '2026-04-01T12:00:00.000Z', by: { displayName: 'Eve' }, minorEdit: true }] });
		server.on('GET', '/wiki/rest/api/content/101/child/attachment', { size: 1, results: [{ id: 'att1', title: 'diagram.png', extensions: { mediaType: 'image/png', fileSize: 20480 }, _links: { download: '/download/attachments/101/diagram.png' } }] });

		expect(await confluenceAdapter.execute('confluence_children', { id: '101' }, cloud())).toContain('201  Child A  (updated 2026-05-01 12:00:00)');
		const hist = await confluenceAdapter.execute('confluence_page_history', { id: '101' }, cloud());
		expect(hist).toBe('v3  2026-05-01 12:00:00  Dana  — tidy\nv2  2026-04-01 12:00:00  Eve  (minor)');
		const att = await confluenceAdapter.execute('confluence_attachments', { id: '101' }, cloud());
		expect(att).toContain('att1  diagram.png  image/png 20.0 KB');
		expect(att).toContain(`http://127.0.0.1:${server.port}/wiki/download/attachments/101/diagram.png`);
	});

	it('confluence_page_history falls back when /version is missing (older DC)', async () => {
		server.on('GET', '/rest/api/content/9', page('9', 'Old', { version: { number: 5, when: '2026-01-01T00:00:00.000Z', by: { displayName: 'Fay' } } }));
		const out = await confluenceAdapter.execute('confluence_page_history', { id: '9' }, dc());
		expect(out).toBe('v5  2026-01-01 00:00:00  Fay');
	});

	it('toStorage converts markdown/plain to storage XHTML and passes storage through', () => {
		expect(toStorage('Hello world\n\nSecond para')).toBe('<p>Hello world</p><p>Second para</p>');
		expect(toStorage('# Title\n- a & b\n- **c**\n1. one\n2. two\n```js\nconst x = 1;\n```\nSee [docs](https://x.y/z) and `code`'))
			.toBe('<h1>Title</h1><ul><li>a &amp; b</li><li><strong>c</strong></li></ul><ol><li>one</li><li>two</li></ol>'
				+ '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter><ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body></ac:structured-macro>'
				+ '<p>See <a href="https://x.y/z">docs</a> and <code>code</code></p>');
		expect(toStorage('<p>already <em>storage</em></p>')).toBe('<p>already <em>storage</em></p>');
		expect(toStorage('')).toBe('<p></p>');
	});

	it('confluence_create_page posts a storage body with space and parent', async () => {
		server.on('POST', '/wiki/rest/api/content', page('300', 'New Page'));
		const out = await confluenceAdapter.execute('confluence_create_page', { title: 'New Page', body: 'Intro\n\n- a\n- b', parentId: '101' }, cloud());
		expect(out).toContain('Created page "New Page" (id 300) in ENG');
		const body = server.requests[0].body;
		expect(body).toEqual({ type: 'page', title: 'New Page', space: { key: 'ENG' }, ancestors: [{ id: '101' }], body: { storage: { value: '<p>Intro</p><ul><li>a</li><li>b</li></ul>', representation: 'storage' } } });
		await expect(confluenceAdapter.execute('confluence_create_page', { title: 't', body: 'b' }, dc())).rejects.toThrow(/"space" is required/);
	});

	it('confluence_update_page reads the current version and PUTs version+1', async () => {
		server.on('GET', '/wiki/rest/api/content/101', page('101', 'Runbook', { version: { number: 7 } }));
		server.on('PUT', '/wiki/rest/api/content/101', page('101', 'Runbook v2', { version: { number: 8 } }));
		const out = await confluenceAdapter.execute('confluence_update_page', { id: '101', body: 'New body', title: 'Runbook v2', versionMessage: 'refresh' }, cloud());
		expect(out).toContain('Updated page "Runbook v2" (id 101) to version 8');
		expect(server.requests[0].method).toBe('GET');
		expect(server.requests[0].query.get('expand')).toContain('version');
		const put = server.requests[1];
		expect(put.method).toBe('PUT');
		expect(put.body).toEqual({ id: '101', type: 'page', title: 'Runbook v2', version: { number: 8, minorEdit: false, message: 'refresh' }, body: { storage: { value: '<p>New body</p>', representation: 'storage' } } });
	});

	it('confluence_update_page keeps the title when omitted', async () => {
		server.on('GET', '/rest/api/content/5', page('5', 'Keep me', { version: { number: 1 } }));
		server.on('PUT', '/rest/api/content/5', page('5', 'Keep me', { version: { number: 2 } }));
		await confluenceAdapter.execute('confluence_update_page', { id: '5', body: 'x' }, dc());
		expect(server.requests[1].body.title).toBe('Keep me');
		expect(server.requests[1].body.version).toEqual({ number: 2, minorEdit: false });
	});

	it('confluence_comment and confluence_add_label', async () => {
		server.on('POST', '/wiki/rest/api/content', { id: 'c1', type: 'comment' });
		server.on('POST', '/wiki/rest/api/content/101/label', { results: [{ name: 'runbook' }] });
		expect(await confluenceAdapter.execute('confluence_comment', { id: '101', body: 'Nice **work**' }, cloud())).toBe('Comment c1 added to page 101');
		expect(server.requests[0].body).toEqual({ type: 'comment', container: { id: '101', type: 'page' }, body: { storage: { value: '<p>Nice <strong>work</strong></p>', representation: 'storage' } } });
		expect(await confluenceAdapter.execute('confluence_add_label', { id: '101', label: 'runbook' }, cloud())).toBe('Label "runbook" added to page 101');
		expect(server.requests[1].body).toEqual([{ prefix: 'global', name: 'runbook' }]);
	});

	it('surfaces 401 from a tool call as a readable IntegrationError', async () => {
		server.on('GET', '/wiki/rest/api/content/1', () => ({ status: 401, json: { message: 'nope' } }));
		await expect(confluenceAdapter.execute('confluence_get_page', { id: '1' }, cloud())).rejects.toMatchObject({ name: 'IntegrationError', status: 401, message: expect.stringMatching(/credentials rejected/) });
	});
});
