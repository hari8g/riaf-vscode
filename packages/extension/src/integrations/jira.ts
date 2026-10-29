/**
 * Jira adapter — Cloud (REST v3, ADF bodies, basic email+token) and Data Center / Server
 * (REST v2, wiki-markup bodies, bearer PAT). Agile endpoints (`/rest/agile/1.0`) are shared.
 *
 * No `vscode` import: this file runs in the extension host and in the MCP server process.
 */
import {
	type AdapterEnv, type Health, type IntegrationAdapter, type IntegrationToolSpec,
	IntegrationError, RateLimiter, adfToText, baseUrlOf, basicAuth, bearerAuth, clip, num, obj,
	requestJson, secretKey, str, textToAdf, tool,
} from './adapter.js';

type Deployment = 'cloud' | 'datacenter';

type JiraCtx = {
	base: string;
	deployment: Deployment;
	api: string;      // …/rest/api/{2|3}
	agile: string;    // …/rest/agile/1.0
	auth: Record<string, string>;
	defaultProject?: string;
	maxResults: number;
};

type JiraUser = { displayName?: string; name?: string; accountId?: string; emailAddress?: string; key?: string };
type JiraIssue = { id?: string; key: string; fields?: Record<string, any> };
type SearchResponse = { issues?: JiraIssue[]; total?: number; isLast?: boolean; nextPageToken?: string };
type Transition = { id: string; name: string; to?: { name?: string } };

const limiter = new RateLimiter(5);

/* ───────────────────────────── context / auth ───────────────────────────── */

export function resolveDeployment(settings: Record<string, unknown>, base: string): Deployment {
	const d = String(settings.deployment ?? 'auto');
	if (d === 'cloud' || d === 'datacenter') { return d; }
	try { return new URL(base).hostname.toLowerCase().endsWith('atlassian.net') ? 'cloud' : 'datacenter'; } catch { return 'datacenter'; }
}

async function ctxOf(env: AdapterEnv): Promise<JiraCtx> {
	const base = baseUrlOf(env.settings, 'jira');
	const deployment = resolveDeployment(env.settings, base);
	const email = (await env.getSecret(secretKey('jira', 'email')))?.trim();
	const token = (await env.getSecret(secretKey('jira', 'token')))?.trim();
	if (!token) { throw new IntegrationError('jira: no API token / personal access token stored — run "RIAF: Set Integration Credentials"'); }
	let auth: Record<string, string>;
	if (deployment === 'cloud') {
		if (!email) { throw new IntegrationError('jira: Jira Cloud needs the Atlassian account email alongside the API token'); }
		auth = basicAuth(email, token);
	} else {
		// Data Center: bearer PAT. Some Server installs only accept basic (username + password/token).
		auth = email ? basicAuth(email, token) : bearerAuth(token);
	}
	const maxResults = Math.max(1, Math.min(100, Number(env.settings.maxResults ?? 20) || 20));
	const defaultProject = String(env.settings.defaultProject ?? '').trim() || undefined;
	return { base, deployment, api: `${base}/rest/api/${deployment === 'cloud' ? 3 : 2}`, agile: `${base}/rest/agile/1.0`, auth, defaultProject, maxResults };
}

const get = <T,>(env: AdapterEnv, c: JiraCtx, url: string) => requestJson<T>(env, url, c.auth, {}, limiter);
const send = <T,>(env: AdapterEnv, c: JiraCtx, url: string, method: 'POST' | 'PUT', body: unknown) => requestJson<T>(env, url, c.auth, { method, body }, limiter);
const q = (params: Record<string, string | number | undefined>): string => {
	const sp = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) { if (v !== undefined && v !== '') { sp.set(k, String(v)); } }
	const s = sp.toString();
	return s ? `?${s}` : '';
};

/* ───────────────────────────── formatting ───────────────────────────── */

const userName = (u?: JiraUser | null): string => u ? (u.displayName ?? u.name ?? u.emailAddress ?? u.accountId ?? '?') : 'unassigned';
const names = (arr?: Array<{ name?: string }> | null): string => (arr ?? []).map(x => x.name ?? '').filter(Boolean).join(', ');
const when = (iso?: string): string => iso ? iso.replace('T', ' ').replace(/\.\d+[+-]\d{4}$/, '').replace(/\.\d+Z$/, 'Z') : '';

/** Description / comment body → text: ADF object on Cloud v3, wiki/plain string on DC v2. */
export function bodyToText(body: unknown): string {
	if (body == null) { return ''; }
	if (typeof body === 'string') { return body; }
	return adfToText(body).trim();
}
/** Text → request body shape for the deployment. */
const textToBody = (c: JiraCtx, text: string): unknown => c.deployment === 'cloud' ? textToAdf(text) : text;

const SEARCH_FIELDS = ['summary', 'status', 'issuetype', 'assignee', 'priority', 'updated'];
const LINE_FIELDS = ['summary', 'status', 'issuetype', 'assignee'];

function issueLine(i: JiraIssue): string {
	const f = i.fields ?? {};
	return `${i.key}  [${f.status?.name ?? '?'}] ${f.issuetype?.name ?? '?'} · ${userName(f.assignee)} · ${f.summary ?? ''}`;
}

function formatSearch(res: SearchResponse, extraFields?: string[]): string {
	const issues = res.issues ?? [];
	if (!issues.length) { return 'No issues matched.'; }
	const lines = issues.map(i => {
		let line = issueLine(i);
		if (extraFields?.length) {
			const extras = extraFields.filter(f => !LINE_FIELDS.includes(f)).map(f => {
				const v = i.fields?.[f];
				if (v == null) { return undefined; }
				const s = typeof v === 'object' ? (v.name ?? v.displayName ?? v.value ?? (Array.isArray(v) ? names(v) : JSON.stringify(v))) : String(v);
				return `${f}=${String(s).slice(0, 80)}`;
			}).filter(Boolean);
			if (extras.length) { line += `  {${extras.join(', ')}}`; }
		}
		return line;
	});
	const total = typeof res.total === 'number' ? res.total : issues.length;
	const more = total > issues.length ? ` (showing ${issues.length})` : '';
	return clip(`${lines.join('\n')}\n— ${total} issue${total === 1 ? '' : 's'}${more}`);
}

function formatIssue(c: JiraCtx, i: JiraIssue): string {
	const f = i.fields ?? {};
	const out: string[] = [];
	out.push(`${i.key}: ${f.summary ?? ''}`);
	out.push(`status: ${f.status?.name ?? '?'} · type: ${f.issuetype?.name ?? '?'} · priority: ${f.priority?.name ?? '-'}`);
	out.push(`assignee: ${userName(f.assignee)} · reporter: ${userName(f.reporter)}`);
	if (f.labels?.length) { out.push(`labels: ${f.labels.join(', ')}`); }
	if (f.components?.length) { out.push(`components: ${names(f.components)}`); }
	if (f.fixVersions?.length) { out.push(`fixVersions: ${names(f.fixVersions)}`); }
	out.push(`created: ${when(f.created)} · updated: ${when(f.updated)}`);
	if (f.parent?.key) { out.push(`parent: ${f.parent.key} ${f.parent.fields?.summary ?? ''}`.trim()); }
	const epic = f.epic?.key ?? f.customfield_10014;
	if (epic && typeof epic === 'string') { out.push(`epic: ${epic}`); }
	const links: string[] = (f.issuelinks ?? []).map((l: any) => {
		if (l.outwardIssue) { return `${l.type?.outward ?? l.type?.name ?? 'links'} ${l.outwardIssue.key} [${l.outwardIssue.fields?.status?.name ?? ''}] ${l.outwardIssue.fields?.summary ?? ''}`; }
		if (l.inwardIssue) { return `${l.type?.inward ?? l.type?.name ?? 'links'} ${l.inwardIssue.key} [${l.inwardIssue.fields?.status?.name ?? ''}] ${l.inwardIssue.fields?.summary ?? ''}`; }
		return undefined;
	}).filter(Boolean);
	if (links.length) { out.push(`links:\n  ${links.join('\n  ')}`); }
	out.push(`url: ${c.base}/browse/${i.key}`);
	const desc = bodyToText(f.description);
	out.push(`\ndescription:\n${desc ? clip(desc, 6_000) : '(none)'}`);
	if (f.subtasks?.length) {
		out.push(`\nsubtasks:\n${(f.subtasks as JiraIssue[]).map(s => `  ${s.key}  [${s.fields?.status?.name ?? '?'}] ${s.fields?.summary ?? ''}`).join('\n')}`);
	}
	return clip(out.join('\n'));
}

/* ───────────────────────────── API calls ───────────────────────────── */

async function search(env: AdapterEnv, c: JiraCtx, jql: string, maxResults: number, fields: string[]): Promise<SearchResponse> {
	const fieldList = [...new Set([...SEARCH_FIELDS, ...fields])];
	if (c.deployment === 'cloud') {
		// /rest/api/3/search is deprecated on Cloud; the enhanced endpoint is the supported path.
		return send<SearchResponse>(env, c, `${c.api}/search/jql`, 'POST', { jql, maxResults, fields: fieldList });
	}
	return send<SearchResponse>(env, c, `${c.api}/search`, 'POST', { jql, maxResults, fields: fieldList, startAt: 0 });
}

async function transitionsOf(env: AdapterEnv, c: JiraCtx, key: string): Promise<Transition[]> {
	const r = await get<{ transitions?: Transition[] }>(env, c, `${c.api}/issue/${encodeURIComponent(key)}/transitions`);
	return r.transitions ?? [];
}

async function myself(env: AdapterEnv, c: JiraCtx): Promise<JiraUser> {
	return get<JiraUser>(env, c, `${c.api}/myself`);
}

function requireStr(args: Record<string, unknown>, k: string): string {
	const v = args[k];
	if (typeof v !== 'string' || !v.trim()) { throw new IntegrationError(`jira: "${k}" is required`); }
	return v.trim();
}
const optStr = (args: Record<string, unknown>, k: string): string | undefined => typeof args[k] === 'string' && (args[k] as string).trim() ? (args[k] as string).trim() : undefined;
const optStrArr = (v: unknown): string[] | undefined => Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v.trim() ? v.split(',').map(s => s.trim()).filter(Boolean) : undefined;
const limitOf = (v: unknown, dflt: number): number => Math.max(1, Math.min(100, Number(v) || dflt));

/* ───────────────────────────── tools ───────────────────────────── */

const tools: IntegrationToolSpec[] = [
	tool('jira_search', 'read', 'search Jira issues', 'Run a JQL query. Returns one compact line per issue (KEY [status] type · assignee · summary) plus the total count.',
		obj({ jql: str('JQL query, e.g. `project = ABC AND status != Done ORDER BY updated DESC`'), maxResults: num('Max issues to return (default from settings, max 100)'), fields: { type: 'array', items: { type: 'string' }, description: 'Extra field ids to include per line (e.g. priority, labels, customfield_10016)' } }, ['jql'])),
	tool('jira_get_issue', 'read', 'read Jira issue', 'Fetch one issue in full: summary, status, type, priority, people, labels, components, versions, dates, parent/epic, links, description (as text), subtasks.',
		obj({ key: str('Issue key, e.g. ABC-123') }, ['key'])),
	tool('jira_get_comments', 'read', 'read Jira comments', 'List comments on an issue (newest last), as text.',
		obj({ key: str('Issue key'), limit: num('Max comments (default 20)') }, ['key'])),
	tool('jira_list_transitions', 'read', 'list Jira transitions', 'List the workflow transitions currently available on an issue (id, name, target status).',
		obj({ key: str('Issue key') }, ['key'])),
	tool('jira_sprint', 'read', 'read Jira sprint', 'Issues in a sprint via the Agile API. With sprintId: that sprint. With boardId only: its active sprint (or `state`). With neither: list boards for defaultProject so you can pick one.',
		obj({ boardId: num('Agile board id'), sprintId: num('Sprint id'), state: str('Sprint state filter when resolving by board: active (default), future, closed') })),
	tool('jira_my_issues', 'read', 'read my Jira issues', 'Issues assigned to the authenticated user, optionally filtered by status name.',
		obj({ status: str('Status name filter, e.g. "In Progress" (omit for all unresolved)') })),
	tool('jira_create_issue', 'write', 'create Jira issue', 'Create an issue. Description is plain text (converted to ADF on Cloud, wiki markup passthrough on Data Center).',
		obj({ project: str('Project key (defaults to settings.defaultProject)'), issueType: str('Issue type name, e.g. Task, Bug, Story, Sub-task'), summary: str('Summary / title'), description: str('Description text'), labels: { type: 'array', items: { type: 'string' }, description: 'Labels' }, parentKey: str('Parent issue key (for sub-tasks or issues under an epic)'), assigneeAccountId: str('Assignee accountId (Cloud) or username (Data Center)') }, ['issueType', 'summary'])),
	tool('jira_transition', 'write', 'transition Jira issue', 'Move an issue through its workflow by transition name (case-insensitive, also matches the target status name) or id, optionally adding a comment.',
		obj({ key: str('Issue key'), transitionName: str('Transition name, e.g. "Done" or "Start Progress"'), transitionId: str('Transition id (alternative to transitionName)'), comment: str('Comment to add with the transition') }, ['key'])),
	tool('jira_comment', 'write', 'comment on Jira issue', 'Add a comment to an issue (plain text; ADF on Cloud).',
		obj({ key: str('Issue key'), body: str('Comment text') }, ['key', 'body'])),
	tool('jira_assign', 'write', 'assign Jira issue', 'Assign an issue to a user by accountId (Cloud), username (Data Center), or "me".',
		obj({ key: str('Issue key'), accountId: str('Cloud accountId'), name: str('Data Center username, or "me"') }, ['key'])),
	tool('jira_link_issues', 'write', 'link Jira issues', 'Create an issue link between two issues (default link type "Relates").',
		obj({ inward: str('Inward issue key'), outward: str('Outward issue key'), type: str('Link type name (default Relates), e.g. Blocks, Cloners, Duplicate') }, ['inward', 'outward'])),
];

/* ───────────────────────────── execute ───────────────────────────── */

async function execute(name: string, args: Record<string, unknown>, env: AdapterEnv): Promise<string> {
	const c = await ctxOf(env);
	switch (name) {
		case 'jira_search': {
			const jql = requireStr(args, 'jql');
			const fields = optStrArr(args.fields) ?? [];
			const res = await search(env, c, jql, limitOf(args.maxResults, c.maxResults), fields);
			return formatSearch(res, fields);
		}
		case 'jira_get_issue': {
			const key = requireStr(args, 'key');
			const issue = await get<JiraIssue>(env, c, `${c.api}/issue/${encodeURIComponent(key)}?fields=*all`);
			return formatIssue(c, issue);
		}
		case 'jira_get_comments': {
			const key = requireStr(args, 'key');
			const limit = limitOf(args.limit, 20);
			const r = await get<{ comments?: Array<{ id: string; author?: JiraUser; created?: string; body?: unknown }>; total?: number }>(env, c, `${c.api}/issue/${encodeURIComponent(key)}/comment${q({ maxResults: limit, orderBy: '-created' })}`);
			const comments = (r.comments ?? []).slice(0, limit).reverse();
			if (!comments.length) { return `${key}: no comments.`; }
			return clip(comments.map(cm => `[${when(cm.created)}] ${userName(cm.author)} (#${cm.id}):\n${bodyToText(cm.body)}`).join('\n\n') + `\n— ${r.total ?? comments.length} comment(s) total`);
		}
		case 'jira_list_transitions': {
			const key = requireStr(args, 'key');
			const ts = await transitionsOf(env, c, key);
			if (!ts.length) { return `${key}: no transitions available to this user.`; }
			return ts.map(t => `${t.id}  ${t.name}${t.to?.name ? ` → ${t.to.name}` : ''}`).join('\n');
		}
		case 'jira_sprint': {
			const sprintId = args.sprintId != null && args.sprintId !== '' ? Number(args.sprintId) : undefined;
			const boardId = args.boardId != null && args.boardId !== '' ? Number(args.boardId) : undefined;
			const state = optStr(args, 'state') ?? 'active';
			let resolvedSprint = sprintId;
			let header = '';
			if (!resolvedSprint) {
				if (!boardId) {
					const boards = await get<{ values?: Array<{ id: number; name: string; type?: string; location?: { projectKey?: string; name?: string } }> }>(env, c, `${c.agile}/board${q({ projectKeyOrId: c.defaultProject, maxResults: 50 })}`);
					const vals = boards.values ?? [];
					if (!vals.length) { return c.defaultProject ? `No boards found for project ${c.defaultProject}.` : 'No boards found; set defaultProject or pass boardId.'; }
					return `Boards${c.defaultProject ? ` for ${c.defaultProject}` : ''} (pass boardId to jira_sprint):\n` + vals.map(b => `${b.id}  ${b.name} (${b.type ?? '?'}${b.location?.projectKey ? `, ${b.location.projectKey}` : ''})`).join('\n');
				}
				const sprints = await get<{ values?: Array<{ id: number; name: string; state?: string; startDate?: string; endDate?: string }> }>(env, c, `${c.agile}/board/${boardId}/sprint${q({ state, maxResults: 50 })}`);
				const vals = sprints.values ?? [];
				if (!vals.length) { return `Board ${boardId}: no ${state} sprint.`; }
				const s = state === 'active' ? vals[vals.length - 1] : vals[0];
				resolvedSprint = s.id;
				header = `Sprint ${s.id} "${s.name}" [${s.state ?? state}]${s.startDate ? ` ${when(s.startDate).slice(0, 10)} → ${when(s.endDate).slice(0, 10)}` : ''}\n`;
				if (vals.length > 1) { header += `(other ${state} sprints: ${vals.filter(v => v.id !== s.id).map(v => `${v.id} ${v.name}`).join('; ')})\n`; }
			}
			const res = await get<SearchResponse>(env, c, `${c.agile}/sprint/${resolvedSprint}/issue${q({ maxResults: c.maxResults, fields: SEARCH_FIELDS.join(',') })}`);
			return clip(header + formatSearch(res));
		}
		case 'jira_my_issues': {
			const status = optStr(args, 'status');
			const jql = `assignee = currentUser() AND ${status ? `status = "${status.replace(/"/g, '\\"')}"` : 'resolution = Unresolved'} ORDER BY updated DESC`;
			return formatSearch(await search(env, c, jql, c.maxResults, []));
		}
		case 'jira_create_issue': {
			const project = optStr(args, 'project') ?? c.defaultProject;
			if (!project) { throw new IntegrationError('jira: "project" is required (or set defaultProject in settings)'); }
			const fields: Record<string, unknown> = { project: { key: project }, issuetype: { name: requireStr(args, 'issueType') }, summary: requireStr(args, 'summary') };
			const description = optStr(args, 'description');
			if (description) { fields.description = textToBody(c, description); }
			const labels = optStrArr(args.labels);
			if (labels?.length) { fields.labels = labels; }
			const parentKey = optStr(args, 'parentKey');
			if (parentKey) { fields.parent = { key: parentKey }; }
			const assignee = optStr(args, 'assigneeAccountId');
			if (assignee) { fields.assignee = c.deployment === 'cloud' ? { accountId: assignee } : { name: assignee }; }
			const r = await send<{ id: string; key: string }>(env, c, `${c.api}/issue`, 'POST', { fields });
			return `Created ${r.key} (id ${r.id}): ${c.base}/browse/${r.key}`;
		}
		case 'jira_transition': {
			const key = requireStr(args, 'key');
			let id = optStr(args, 'transitionId');
			const nameArg = optStr(args, 'transitionName');
			const ts = await transitionsOf(env, c, key);
			let chosen: Transition | undefined;
			if (id) {
				chosen = ts.find(t => t.id === id);
			} else if (nameArg) {
				const want = nameArg.toLowerCase();
				chosen = ts.find(t => t.name.toLowerCase() === want) ?? ts.find(t => t.to?.name?.toLowerCase() === want) ?? ts.find(t => t.name.toLowerCase().includes(want));
				if (!chosen) { throw new IntegrationError(`jira: no transition "${nameArg}" on ${key}; available: ${ts.map(t => `${t.name}${t.to?.name ? ` (→ ${t.to.name})` : ''}`).join(', ') || 'none'}`); }
				id = chosen.id;
			} else {
				throw new IntegrationError('jira: transitionName or transitionId is required');
			}
			if (!id) { throw new IntegrationError('jira: transitionId is required'); }
			const body: Record<string, unknown> = { transition: { id } };
			const comment = optStr(args, 'comment');
			if (comment) { body.update = { comment: [{ add: { body: textToBody(c, comment) } }] }; }
			await send(env, c, `${c.api}/issue/${encodeURIComponent(key)}/transitions`, 'POST', body);
			return `${key}: transitioned via ${chosen?.name ?? id}${chosen?.to?.name ? ` → ${chosen.to.name}` : ''}${comment ? ' (comment added)' : ''}`;
		}
		case 'jira_comment': {
			const key = requireStr(args, 'key');
			const body = requireStr(args, 'body');
			const r = await send<{ id?: string }>(env, c, `${c.api}/issue/${encodeURIComponent(key)}/comment`, 'POST', { body: textToBody(c, body) });
			return `${key}: comment ${r?.id ? `#${r.id} ` : ''}added`;
		}
		case 'jira_assign': {
			const key = requireStr(args, 'key');
			const accountId = optStr(args, 'accountId');
			let name = optStr(args, 'name');
			let payload: Record<string, unknown>;
			if (accountId === 'me' || name === 'me') {
				const me = await myself(env, c);
				payload = c.deployment === 'cloud' ? { accountId: me.accountId } : { name: me.name ?? me.key };
				name = userName(me);
			} else if (accountId) {
				payload = c.deployment === 'cloud' ? { accountId } : { name: accountId };
			} else if (name) {
				payload = c.deployment === 'cloud' ? { accountId: name } : { name };
			} else {
				throw new IntegrationError('jira: accountId, name, or "me" is required');
			}
			await send(env, c, `${c.api}/issue/${encodeURIComponent(key)}/assignee`, 'PUT', payload);
			return `${key}: assigned to ${name ?? accountId}`;
		}
		case 'jira_link_issues': {
			const inward = requireStr(args, 'inward');
			const outward = requireStr(args, 'outward');
			const type = optStr(args, 'type') ?? 'Relates';
			await send(env, c, `${c.api}/issueLink`, 'POST', { type: { name: type }, inwardIssue: { key: inward }, outwardIssue: { key: outward } });
			return `Linked ${inward} —${type}→ ${outward}`;
		}
		default:
			throw new IntegrationError(`jira: unknown tool ${name}`);
	}
}

/* ───────────────────────────── health ───────────────────────────── */

async function health(env: AdapterEnv): Promise<Health> {
	const t0 = Date.now();
	try {
		const c = await ctxOf(env);
		const me = await myself(env, c);
		return { ok: true, message: `Connected to Jira ${c.deployment === 'cloud' ? 'Cloud' : 'Data Center'} as ${userName(me)}`, latencyMs: Date.now() - t0, detail: { deployment: c.deployment, accountId: me.accountId ?? me.name, baseUrl: c.base } };
	} catch (e) {
		const err = e as IntegrationError;
		const status = err.status;
		const message = status === 401 ? 'Jira rejected the credentials (401). Check the email/API token (Cloud) or personal access token (Data Center).'
			: status === 403 ? 'Jira refused access (403). The account is authenticated but lacks permission, or a CAPTCHA/SSO challenge is pending.'
				: status === 404 ? 'Jira endpoint not found (404). Check baseUrl (include any context path) and the deployment setting (cloud vs datacenter).'
					: `Jira unreachable: ${err.message}`;
		return { ok: false, message, latencyMs: Date.now() - t0, detail: status ? { status } : undefined };
	}
}

/* ───────────────────────────── adapter ───────────────────────────── */

export const jiraAdapter: IntegrationAdapter = {
	id: 'jira',
	displayName: 'Jira',
	settingsSchema: {
		baseUrl: { type: 'string', description: 'Jira base URL, e.g. https://acme.atlassian.net or https://jira.corp.example.com/jira' },
		deployment: { type: 'enum', description: 'cloud (REST v3, ADF) or datacenter (REST v2, wiki markup); auto picks cloud for *.atlassian.net', default: 'auto', enum: ['auto', 'cloud', 'datacenter'] },
		defaultProject: { type: 'string', description: 'Project key used when a tool call omits project (create, boards)' },
		maxResults: { type: 'number', description: 'Default page size for searches and sprint listings', default: 20 },
	},
	credentials: [
		{ key: 'email', label: 'Atlassian account email', secret: false, hint: 'Jira Cloud only (basic auth with the API token). Leave empty for Data Center bearer PATs; fill it on Data Center only to force basic auth (username + token).' },
		{ key: 'token', label: 'API token / personal access token', secret: true, hint: 'Cloud: API token from id.atlassian.com. Data Center: personal access token from your profile.' },
	],
	tools,
	health,
	execute,
};
