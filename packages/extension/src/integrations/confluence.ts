/**
 * Confluence adapter — Cloud (`/wiki/rest/api`, basic email+token) and Data Center / Server
 * (`/rest/api`, bearer PAT). Both speak the v1 REST API with storage-format bodies.
 *
 * No `vscode` import: this file runs in the extension host and in the MCP server process.
 */
import {
	type AdapterEnv, type Health, type IntegrationAdapter, type IntegrationToolSpec,
	IntegrationError, RateLimiter, baseUrlOf, basicAuth, bearerAuth, clip, htmlToText, num, obj,
	requestJson, secretKey, str, tool,
} from './adapter.js';

type Deployment = 'cloud' | 'datacenter';

type ConfCtx = {
	base: string;        // site root, e.g. https://acme.atlassian.net or https://wiki.corp
	deployment: Deployment;
	api: string;         // …/wiki/rest/api  |  …/rest/api
	webBase: string;     // …/wiki  |  …   (prefix for `_links.webui`)
	auth: Record<string, string>;
	defaultSpace?: string;
	maxResults: number;
};

type Page = {
	id: string; type?: string; status?: string; title: string;
	space?: { key?: string; name?: string };
	version?: { number: number; when?: string; by?: { displayName?: string }; message?: string; minorEdit?: boolean };
	ancestors?: Array<{ id: string; title?: string }>;
	body?: { storage?: { value?: string }; view?: { value?: string }; export_view?: { value?: string } };
	metadata?: { labels?: { results?: Array<{ name: string }> } };
	history?: { lastUpdated?: { when?: string; by?: { displayName?: string } }; createdDate?: string; createdBy?: { displayName?: string } };
	_links?: { webui?: string; download?: string };
	extensions?: { mediaType?: string; fileSize?: number };
};
type Paged<T> = { results?: T[]; size?: number; totalSize?: number; start?: number; limit?: number; _links?: { next?: string } };

const limiter = new RateLimiter(5);

/* ───────────────────────────── context / auth ───────────────────────────── */

export function resolveDeployment(settings: Record<string, unknown>, base: string): Deployment {
	const d = String(settings.deployment ?? 'auto');
	if (d === 'cloud' || d === 'datacenter') { return d; }
	try { return new URL(base).hostname.toLowerCase().endsWith('atlassian.net') ? 'cloud' : 'datacenter'; } catch { return 'datacenter'; }
}

/** Site root + REST base. Cloud lives under /wiki; tolerate a baseUrl that already includes it. */
export function apiBases(base: string, deployment: Deployment): { api: string; webBase: string } {
	if (deployment === 'cloud') {
		const webBase = /\/wiki$/i.test(base) ? base : `${base}/wiki`;
		return { api: `${webBase}/rest/api`, webBase };
	}
	return { api: `${base}/rest/api`, webBase: base };
}

async function ctxOf(env: AdapterEnv): Promise<ConfCtx> {
	const base = baseUrlOf(env.settings, 'confluence');
	const deployment = resolveDeployment(env.settings, base);
	const email = (await env.getSecret(secretKey('confluence', 'email')))?.trim();
	const token = (await env.getSecret(secretKey('confluence', 'token')))?.trim();
	if (!token) { throw new IntegrationError('confluence: no API token / personal access token stored — run "RIAF: Set Integration Credentials"'); }
	let auth: Record<string, string>;
	if (deployment === 'cloud') {
		if (!email) { throw new IntegrationError('confluence: Confluence Cloud needs the Atlassian account email alongside the API token'); }
		auth = basicAuth(email, token);
	} else {
		auth = email ? basicAuth(email, token) : bearerAuth(token);
	}
	const { api, webBase } = apiBases(base, deployment);
	const maxResults = Math.max(1, Math.min(100, Number(env.settings.maxResults ?? 20) || 20));
	const defaultSpace = String(env.settings.defaultSpace ?? '').trim() || undefined;
	return { base, deployment, api, webBase, auth, defaultSpace, maxResults };
}

const get = <T,>(env: AdapterEnv, c: ConfCtx, url: string) => requestJson<T>(env, url, c.auth, {}, limiter);
const send = <T,>(env: AdapterEnv, c: ConfCtx, url: string, method: 'POST' | 'PUT', body: unknown) => requestJson<T>(env, url, c.auth, { method, body }, limiter);
const q = (params: Record<string, string | number | undefined>): string => {
	const sp = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) { if (v !== undefined && v !== '') { sp.set(k, String(v)); } }
	const s = sp.toString();
	return s ? `?${s}` : '';
};
const pageUrl = (c: ConfCtx, p: Page): string => p._links?.webui ? `${c.webBase}${p._links.webui}` : `${c.webBase}/pages/viewpage.action?pageId=${p.id}`;
const when = (iso?: string): string => iso ? iso.replace('T', ' ').replace(/\.\d+(Z|[+-]\d{2}:?\d{2})$/, '') : '';
const cqlStr = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/* ───────────────────────────── markdown/plain → storage format ───────────────────────────── */

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inlineMd(s: string): string {
	let out = escapeHtml(s);
	out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
	out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
	out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
	out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
	return out;
}

/**
 * Minimal markdown/plain → Confluence storage (XHTML): headings, paragraphs, bullet/numbered lists,
 * fenced code blocks (as a code macro), inline code/bold/italic/links. Anything else is a paragraph.
 * If the body already looks like storage/HTML, it is passed through untouched.
 */
export function toStorage(body: string): string {
	const text = body.replace(/\r\n?/g, '\n').trim();
	if (!text) { return '<p></p>'; }
	if (/^\s*<(p|h[1-6]|ac:|table|ul|ol|div)[\s>]/i.test(text)) { return text; }
	const lines = text.split('\n');
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) { i++; continue; }
		const fence = /^```\s*(\w+)?\s*$/.exec(line);
		if (fence) {
			const code: string[] = [];
			i++;
			while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
			i++; // closing fence
			const lang = fence[1] ? `<ac:parameter ac:name="language">${escapeHtml(fence[1])}</ac:parameter>` : '';
			out.push(`<ac:structured-macro ac:name="code">${lang}<ac:plain-text-body><![CDATA[${code.join('\n').replace(/\]\]>/g, ']]]]><![CDATA[>')}]]></ac:plain-text-body></ac:structured-macro>`);
			continue;
		}
		const h = /^(#{1,6})\s+(.*)$/.exec(line);
		if (h) { out.push(`<h${h[1].length}>${inlineMd(h[2].trim())}</h${h[1].length}>`); i++; continue; }
		if (/^\s*[-*+]\s+/.test(line)) {
			const items: string[] = [];
			while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(`<li>${inlineMd(lines[i].replace(/^\s*[-*+]\s+/, ''))}</li>`); i++; }
			out.push(`<ul>${items.join('')}</ul>`);
			continue;
		}
		if (/^\s*\d+[.)]\s+/.test(line)) {
			const items: string[] = [];
			while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(`<li>${inlineMd(lines[i].replace(/^\s*\d+[.)]\s+/, ''))}</li>`); i++; }
			out.push(`<ol>${items.join('')}</ol>`);
			continue;
		}
		// paragraph: consecutive non-blank, non-special lines
		const para: string[] = [];
		while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) { para.push(lines[i]); i++; }
		out.push(`<p>${para.map(inlineMd).join('<br/>')}</p>`);
	}
	return out.join('');
}

/* ───────────────────────────── formatting ───────────────────────────── */

function formatSearchResults(c: ConfCtx, res: Paged<Page & { excerpt?: string; lastModified?: string; content?: Page; url?: string }>): string {
	const rows = res.results ?? [];
	if (!rows.length) { return 'No pages matched.'; }
	const lines = rows.map(r => {
		// /content/search returns content objects; /search returns {content, excerpt, url, lastModified}
		const p: Page = (r as any).content ?? r;
		const updated = (r as any).lastModified ?? p.version?.when ?? p.history?.lastUpdated?.when;
		const excerpt = typeof (r as any).excerpt === 'string' ? htmlToText((r as any).excerpt).replace(/\s+/g, ' ').slice(0, 160) : '';
		const url = (r as any).url ? `${c.webBase}${(r as any).url}` : pageUrl(c, p);
		return `${p.id}  [${p.space?.key ?? '?'}] ${p.title}${updated ? `  (updated ${when(updated)})` : ''}\n    ${url}${excerpt ? `\n    ${excerpt}` : ''}`;
	});
	const total = res.totalSize ?? res.size ?? rows.length;
	return clip(`${lines.join('\n')}\n— ${total} result${total === 1 ? '' : 's'}${total > rows.length ? ` (showing ${rows.length})` : ''}`);
}

function formatPage(c: ConfCtx, p: Page, bodyFormat: 'text' | 'storage'): string {
	const out: string[] = [];
	out.push(`${p.title} (id ${p.id})`);
	out.push(`space: ${p.space?.key ?? '?'}${p.space?.name ? ` (${p.space.name})` : ''} · version: ${p.version?.number ?? '?'}${p.version?.when ? ` @ ${when(p.version.when)}` : ''}${p.version?.by?.displayName ? ` by ${p.version.by.displayName}` : ''}`);
	if (p.ancestors?.length) { out.push(`ancestors: ${p.ancestors.map(a => `${a.title ?? a.id} (${a.id})`).join(' › ')}`); }
	const labels = p.metadata?.labels?.results?.map(l => l.name) ?? [];
	if (labels.length) { out.push(`labels: ${labels.join(', ')}`); }
	out.push(`url: ${pageUrl(c, p)}`);
	const storage = p.body?.storage?.value ?? p.body?.view?.value ?? '';
	const body = bodyFormat === 'storage' ? storage : htmlToText(storage);
	out.push(`\nbody${bodyFormat === 'storage' ? ' (storage)' : ''}:\n${body ? clip(body, 12_000) : '(empty)'}`);
	return out.join('\n');
}

/* ───────────────────────────── API calls ───────────────────────────── */

const PAGE_EXPAND = 'space,version,ancestors,metadata.labels,body.storage';

async function getPageById(env: AdapterEnv, c: ConfCtx, id: string, expand = PAGE_EXPAND): Promise<Page> {
	return get<Page>(env, c, `${c.api}/content/${encodeURIComponent(id)}${q({ expand })}`);
}

async function findPageByTitle(env: AdapterEnv, c: ConfCtx, title: string, space: string, expand = PAGE_EXPAND): Promise<Page> {
	const r = await get<Paged<Page>>(env, c, `${c.api}/content${q({ title, spaceKey: space, type: 'page', expand, limit: 1 })}`);
	const p = r.results?.[0];
	if (!p) { throw new IntegrationError(`confluence: no page titled "${title}" in space ${space}`); }
	return p;
}

async function resolvePage(env: AdapterEnv, c: ConfCtx, args: Record<string, unknown>, expand?: string): Promise<Page> {
	const id = optStr(args, 'id');
	if (id) { return getPageById(env, c, id, expand); }
	const title = optStr(args, 'title');
	const space = optStr(args, 'space') ?? c.defaultSpace;
	if (!title) { throw new IntegrationError('confluence: "id" or "title" (+ space) is required'); }
	if (!space) { throw new IntegrationError('confluence: "space" is required with title (or set defaultSpace)'); }
	return findPageByTitle(env, c, title, space, expand);
}

function requireStr(args: Record<string, unknown>, k: string): string {
	const v = args[k];
	if (typeof v !== 'string' || !v.trim()) { throw new IntegrationError(`confluence: "${k}" is required`); }
	return v.trim();
}
const optStr = (args: Record<string, unknown>, k: string): string | undefined => typeof args[k] === 'string' && (args[k] as string).trim() ? (args[k] as string).trim() : undefined;
const limitOf = (v: unknown, dflt: number): number => Math.max(1, Math.min(100, Number(v) || dflt));

/* ───────────────────────────── tools ───────────────────────────── */

const tools: IntegrationToolSpec[] = [
	tool('confluence_search', 'read', 'search Confluence', 'Search pages by free text (title/body match, pages only) or raw CQL. Returns id, title, space, last update, URL and an excerpt per hit.',
		obj({ text: str('Free-text query (becomes `text ~ "…" AND type = page`)'), cql: str('Raw CQL, e.g. `space = ENG AND label = runbook` (overrides text)'), space: str('Restrict to a space key (defaults to settings.defaultSpace for text searches)'), limit: num('Max results (default from settings)') })),
	tool('confluence_get_page', 'read', 'read Confluence page', 'Fetch a page by id, or by title + space. Returns title, space, version, ancestors, labels, URL and the body as text (or raw storage XHTML).',
		obj({ id: str('Page id'), title: str('Page title (used with space when id is omitted)'), space: str('Space key for title lookup'), bodyFormat: str('"text" (default) or "storage" for raw XHTML') })),
	tool('confluence_children', 'read', 'list Confluence child pages', 'List the direct child pages of a page.',
		obj({ id: str('Parent page id'), limit: num('Max children (default 50)') }, ['id'])),
	tool('confluence_page_history', 'read', 'read Confluence page history', 'List a page\'s versions (number, author, date, message), newest first.',
		obj({ id: str('Page id'), limit: num('Max versions (default 20)') }, ['id'])),
	tool('confluence_attachments', 'read', 'list Confluence attachments', 'List attachments on a page with media type, size and download URL.',
		obj({ id: str('Page id') }, ['id'])),
	tool('confluence_create_page', 'write', 'create Confluence page', 'Create a page. Body may be plain text or simple markdown (headings, lists, fenced code, bold/italic/links); it is converted to storage format. Raw storage XHTML is passed through.',
		obj({ space: str('Space key (defaults to settings.defaultSpace)'), title: str('Page title'), body: str('Page body (markdown / plain text / storage XHTML)'), parentId: str('Parent page id (omit for space root)') }, ['title', 'body'])),
	tool('confluence_update_page', 'write', 'update Confluence page', 'Replace a page\'s body (and optionally title) as a new version. Body is converted like confluence_create_page.',
		obj({ id: str('Page id'), body: str('New body (markdown / plain text / storage XHTML)'), title: str('New title (keeps current when omitted)'), versionMessage: str('Version comment') }, ['id', 'body'])),
	tool('confluence_comment', 'write', 'comment on Confluence page', 'Add a footer comment to a page.',
		obj({ id: str('Page id'), body: str('Comment text (markdown / plain)') }, ['id', 'body'])),
	tool('confluence_add_label', 'write', 'label Confluence page', 'Add a label to a page.',
		obj({ id: str('Page id'), label: str('Label name (lowercase, no spaces)') }, ['id', 'label'])),
];

/* ───────────────────────────── execute ───────────────────────────── */

async function execute(name: string, args: Record<string, unknown>, env: AdapterEnv): Promise<string> {
	const c = await ctxOf(env);
	switch (name) {
		case 'confluence_search': {
			const limit = limitOf(args.limit, c.maxResults);
			let cql = optStr(args, 'cql');
			const space = optStr(args, 'space');
			if (!cql) {
				const text = optStr(args, 'text');
				if (!text) { throw new IntegrationError('confluence: "text" or "cql" is required'); }
				const parts = [`text ~ ${cqlStr(text)}`, 'type = page'];
				const sp = space ?? c.defaultSpace;
				if (sp) { parts.push(`space = ${cqlStr(sp)}`); }
				cql = `${parts.join(' AND ')} ORDER BY lastmodified DESC`;
			} else if (space && !/\bspace\s*(=|in)/i.test(cql)) {
				cql = `(${cql}) AND space = ${cqlStr(space)}`;
			}
			const res = await get<Paged<Page>>(env, c, `${c.api}/search${q({ cql, limit, expand: 'content.space,content.version' })}`);
			return formatSearchResults(c, res);
		}
		case 'confluence_get_page': {
			const fmt = optStr(args, 'bodyFormat') === 'storage' ? 'storage' : 'text';
			const p = await resolvePage(env, c, args);
			return formatPage(c, p, fmt);
		}
		case 'confluence_children': {
			const id = requireStr(args, 'id');
			const limit = limitOf(args.limit, 50);
			const r = await get<Paged<Page>>(env, c, `${c.api}/content/${encodeURIComponent(id)}/child/page${q({ limit, expand: 'version' })}`);
			const rows = r.results ?? [];
			if (!rows.length) { return `Page ${id}: no child pages.`; }
			return clip(rows.map(p => `${p.id}  ${p.title}${p.version?.when ? `  (updated ${when(p.version.when)})` : ''}\n    ${pageUrl(c, p)}`).join('\n') + `\n— ${r.size ?? rows.length} child page(s)`);
		}
		case 'confluence_page_history': {
			const id = requireStr(args, 'id');
			const limit = limitOf(args.limit, 20);
			type Ver = { number: number; when?: string; by?: { displayName?: string }; message?: string; minorEdit?: boolean };
			let versions: Ver[] = [];
			try {
				const r = await get<Paged<Ver>>(env, c, `${c.api}/content/${encodeURIComponent(id)}/version${q({ limit })}`);
				versions = r.results ?? [];
			} catch (e) {
				// Older Data Center builds lack /content/{id}/version; fall back to history + current version.
				if ((e as IntegrationError).status !== 404) { throw e; }
				const p = await get<Page>(env, c, `${c.api}/content/${encodeURIComponent(id)}${q({ expand: 'version,history.lastUpdated' })}`);
				if (p.version) { versions = [p.version]; }
			}
			if (!versions.length) { return `Page ${id}: no version history available.`; }
			return clip(versions.slice(0, limit).map(v => `v${v.number}  ${when(v.when)}  ${v.by?.displayName ?? '?'}${v.minorEdit ? '  (minor)' : ''}${v.message ? `  — ${v.message}` : ''}`).join('\n'));
		}
		case 'confluence_attachments': {
			const id = requireStr(args, 'id');
			const r = await get<Paged<Page>>(env, c, `${c.api}/content/${encodeURIComponent(id)}/child/attachment${q({ limit: 100, expand: 'version' })}`);
			const rows = r.results ?? [];
			if (!rows.length) { return `Page ${id}: no attachments.`; }
			const size = (n?: number) => n == null ? '' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
			return clip(rows.map(a => `${a.id}  ${a.title}  ${a.extensions?.mediaType ?? ''} ${size(a.extensions?.fileSize)}${a.version?.when ? `  (${when(a.version.when)})` : ''}\n    ${a._links?.download ? `${c.webBase}${a._links.download}` : ''}`.trimEnd()).join('\n') + `\n— ${r.size ?? rows.length} attachment(s)`);
		}
		case 'confluence_create_page': {
			const space = optStr(args, 'space') ?? c.defaultSpace;
			if (!space) { throw new IntegrationError('confluence: "space" is required (or set defaultSpace in settings)'); }
			const title = requireStr(args, 'title');
			const body = requireStr(args, 'body');
			const payload: Record<string, unknown> = { type: 'page', title, space: { key: space }, body: { storage: { value: toStorage(body), representation: 'storage' } } };
			const parentId = optStr(args, 'parentId');
			if (parentId) { payload.ancestors = [{ id: parentId }]; }
			const p = await send<Page>(env, c, `${c.api}/content`, 'POST', payload);
			return `Created page "${p.title}" (id ${p.id}) in ${space}: ${pageUrl(c, p)}`;
		}
		case 'confluence_update_page': {
			const id = requireStr(args, 'id');
			const body = requireStr(args, 'body');
			const current = await getPageById(env, c, id, 'version,space');
			const next = (current.version?.number ?? 0) + 1;
			const title = optStr(args, 'title') ?? current.title;
			const version: Record<string, unknown> = { number: next, minorEdit: false };
			const msg = optStr(args, 'versionMessage');
			if (msg) { version.message = msg; }
			const payload = { id, type: 'page', title, version, body: { storage: { value: toStorage(body), representation: 'storage' } } };
			const p = await send<Page>(env, c, `${c.api}/content/${encodeURIComponent(id)}`, 'PUT', payload);
			return `Updated page "${p.title ?? title}" (id ${id}) to version ${p.version?.number ?? next}: ${pageUrl(c, p)}`;
		}
		case 'confluence_comment': {
			const id = requireStr(args, 'id');
			const body = requireStr(args, 'body');
			const payload = { type: 'comment', container: { id, type: 'page' }, body: { storage: { value: toStorage(body), representation: 'storage' } } };
			const r = await send<Page>(env, c, `${c.api}/content`, 'POST', payload);
			return `Comment ${r?.id ?? ''} added to page ${id}`.replace(/\s+/g, ' ');
		}
		case 'confluence_add_label': {
			const id = requireStr(args, 'id');
			const label = requireStr(args, 'label');
			await send(env, c, `${c.api}/content/${encodeURIComponent(id)}/label`, 'POST', [{ prefix: 'global', name: label }]);
			return `Label "${label}" added to page ${id}`;
		}
		default:
			throw new IntegrationError(`confluence: unknown tool ${name}`);
	}
}

/* ───────────────────────────── health ───────────────────────────── */

async function health(env: AdapterEnv): Promise<Health> {
	const t0 = Date.now();
	try {
		const c = await ctxOf(env);
		const r = await get<Paged<{ key: string; name?: string }>>(env, c, `${c.api}/space?limit=1`);
		const first = r.results?.[0];
		return { ok: true, message: `Connected to Confluence ${c.deployment === 'cloud' ? 'Cloud' : 'Data Center'}${first ? ` (e.g. space ${first.key})` : ''}`, latencyMs: Date.now() - t0, detail: { deployment: c.deployment, api: c.api } };
	} catch (e) {
		const err = e as IntegrationError;
		const status = err.status;
		const message = status === 401 ? 'Confluence rejected the credentials (401). Check the email/API token (Cloud) or personal access token (Data Center).'
			: status === 403 ? 'Confluence refused access (403). The account is authenticated but lacks permission.'
				: status === 404 ? 'Confluence REST endpoint not found (404). Check baseUrl (Cloud sites live under /wiki; include any Data Center context path) and the deployment setting.'
					: `Confluence unreachable: ${err.message}`;
		return { ok: false, message, latencyMs: Date.now() - t0, detail: status ? { status } : undefined };
	}
}

/* ───────────────────────────── adapter ───────────────────────────── */

export const confluenceAdapter: IntegrationAdapter = {
	id: 'confluence',
	displayName: 'Confluence',
	settingsSchema: {
		baseUrl: { type: 'string', description: 'Confluence site URL, e.g. https://acme.atlassian.net (Cloud; /wiki is added automatically) or https://wiki.corp.example.com' },
		deployment: { type: 'enum', description: 'cloud (/wiki/rest/api) or datacenter (/rest/api); auto picks cloud for *.atlassian.net', default: 'auto', enum: ['auto', 'cloud', 'datacenter'] },
		defaultSpace: { type: 'string', description: 'Space key used when a tool call omits space (search scope, create, title lookup)' },
		maxResults: { type: 'number', description: 'Default page size for searches', default: 20 },
	},
	credentials: [
		{ key: 'email', label: 'Atlassian account email', secret: false, hint: 'Confluence Cloud only (basic auth with the API token). Leave empty for Data Center bearer PATs; fill it on Data Center only to force basic auth (username + token).' },
		{ key: 'token', label: 'API token / personal access token', secret: true, hint: 'Cloud: API token from id.atlassian.com (the same token works for Jira and Confluence). Data Center: personal access token from your profile.' },
	],
	tools,
	health,
	execute,
};
