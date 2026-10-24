/**
 * Org-index and git queries exposed as agent tools — shared by the VS Code tool registry and
 * the MCP server so both answer identically. No `vscode` import: this module must run in the
 * stdio MCP process too.
 */
import { formatGrepResult, type RiafIndex } from '@bosch-mps/riaf-core';
import type { ToolSpec } from '../modelTransport.js';

const str = (d: string) => ({ type: 'string', description: d });
const num = (d: string) => ({ type: 'number', description: d });
const bool = (d: string) => ({ type: 'boolean', description: d });
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required });

/** Exact / regex search and file globbing — the "agentic search" complement to the semantic index. */
export const SEARCH_TOOL_SPECS: ToolSpec[] = [
	{ name: 'grep', description: 'Exact-text or regex search across the workspace (ripgrep-backed). Use for identifiers, error strings, config keys and call sites when you need every occurrence; use search_codebase for concepts. Returns file:line matches grouped by file.', inputSchema: obj({ pattern: str('Text to find (literal by default)'), regex: bool('Interpret pattern as a regular expression'), caseSensitive: bool('Default false'), include: str('Restrict to files matching this glob, e.g. src/**/*.ts or *.yaml'), context: num('Context lines around each match (0-3)'), maxResults: num('Default 100') }, ['pattern']) },
	{ name: 'glob', description: 'List files matching a glob such as src/**/*.test.ts, **/Dockerfile or *.tf. Respects .gitignore. Use to discover files before reading them.', inputSchema: obj({ pattern: str('Glob pattern'), maxResults: num('Default 200') }, ['pattern']) },
];

export const SEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(SEARCH_TOOL_SPECS.map(t => t.name));

/** Run one search tool. Returns `undefined` when `name` is not a search tool. */
export async function executeSearchTool(index: RiafIndex, name: string, a: Record<string, any>): Promise<string | undefined> {
	switch (name) {
		case 'grep': {
			const pattern = String(a.pattern ?? '');
			if (!pattern.trim()) { return 'grep needs a non-empty `pattern`.'; }
			const r = await index.grep(pattern, {
				regex: !!a.regex,
				caseSensitive: !!a.caseSensitive,
				include: a.include ? [String(a.include)] : undefined,
				context: Math.max(0, Math.min(3, Number(a.context) || 0)),
				maxResults: Math.max(1, Math.min(500, Number(a.maxResults) || 100)),
			});
			return formatGrepResult(r);
		}
		case 'glob': {
			const pattern = String(a.pattern ?? '');
			if (!pattern.trim()) { return 'glob needs a non-empty `pattern`.'; }
			const r = index.glob(pattern, { maxResults: Math.max(1, Math.min(2000, Number(a.maxResults) || 200)) });
			if (!r.files.length) { return `No files match ${pattern}.`; }
			return r.files.join('\n') + (r.truncated ? `\n… capped at ${r.files.length}; narrow the pattern` : '');
		}
		default:
			return undefined;
	}
}

export const ORG_TOOL_SPECS: ToolSpec[] = [
	{ name: 'get_service_topology', description: 'Microservice map from the org index: Spring services, their REST endpoints, Feign client edges and gateway routes. Optionally filter endpoints to one service.', inputSchema: obj({ serviceName: str('Restrict endpoint list to this service (optional)') }) },
	{ name: 'resolve_api_contract', description: 'Given an HTTP method + path (as a caller or gateway sees it), find the backend service, controller, handler and request/response DTOs.', inputSchema: obj({ httpMethod: str('GET, POST, …'), pathPattern: str('e.g. /api/orders/**') }, ['httpMethod', 'pathPattern']) },
	{ name: 'get_dependency_impact', description: 'Who depends on a library? Matches Maven artifactIds and npm package names; returns the consuming modules / packages in this repo.', inputSchema: obj({ name: str('Maven artifactId or npm package name') }, ['name']) },
	{ name: 'get_config_drift', description: 'Configuration keys whose values differ between environments (dev/staging/prod …) for a service.', inputSchema: obj({ serviceName: str('Service / application name') }, ['serviceName']) },
	{ name: 'get_infra_resources', description: 'Infrastructure from the org index: `terraform` resources, `k8s` manifests or CI `pipeline` jobs. `filter` narrows by resource type, k8s kind or pipeline stage.', inputSchema: obj({ kind: { type: 'string', enum: ['terraform', 'k8s', 'pipeline'], description: 'Which inventory' }, filter: str('terraform resource type / k8s kind / pipeline stage (optional)') }, ['kind']) },
	{ name: 'get_git_context', description: 'Current branch, uncommitted changes (status + diff stat), recent commits and the most frequently changed files. Use before edits to see what is in flight.', inputSchema: obj({ recentFiles: num('How many hot files to list (default 10)') }) },
];

export const ORG_TOOL_NAMES: ReadonlySet<string> = new Set(ORG_TOOL_SPECS.map(t => t.name));

const MAX_ROWS = 60;
const capped = <T,>(rows: T[], fmt: (r: T) => string): string => {
	const out = rows.slice(0, MAX_ROWS).map(fmt);
	if (rows.length > MAX_ROWS) { out.push(`… ${rows.length - MAX_ROWS} more`); }
	return out.join('\n');
};

/** Run one org/git tool. Returns `undefined` when `name` is not an org tool. */
export async function executeOrgTool(index: RiafIndex, name: string, a: Record<string, any>): Promise<string | undefined> {
	switch (name) {
		case 'get_service_topology': {
			const topo = await index.getServiceTopology();
			if (!topo) { return 'No Spring services indexed (the org index found no @RestController endpoints).'; }
			const lines = [`${topo.serviceCount} services, ${topo.totalEndpoints} endpoints`, `Services: ${topo.serviceNames.join(', ')}`];
			if (topo.gatewayRoutes.length) { lines.push('', 'Gateway routes:', capped(topo.gatewayRoutes, r => `- ${r.pathPattern} → ${r.targetService}`)); }
			if (topo.feignEdges.length) { lines.push('', 'Feign calls:', capped(topo.feignEdges, e => `- ${e.caller} → ${e.targets.join(', ')}`)); }
			const endpoints = await index.getSpringEndpoints(a.serviceName || undefined);
			if (endpoints.length) {
				lines.push('', a.serviceName ? `Endpoints of ${a.serviceName}:` : 'Endpoints:',
					capped(endpoints, e => `- ${e.httpMethod} ${e.pathPattern} — ${e.serviceName} ${e.controllerClass}.${e.handlerMethod} (${e.filePath})`));
			} else if (a.serviceName) { lines.push('', `No endpoints for service '${a.serviceName}'.`); }
			return lines.join('\n');
		}
		case 'resolve_api_contract': {
			const c = await index.resolveApiContract(String(a.httpMethod ?? 'GET'), String(a.pathPattern ?? ''));
			if (!c) { return `No endpoint matches ${String(a.httpMethod ?? 'GET').toUpperCase()} ${a.pathPattern}. Try get_service_topology to list routes.`; }
			return [
				`${c.httpMethod} ${c.pathPattern} → ${c.backendService}`,
				`handler: ${c.controllerClass}.${c.handlerMethod}  (${c.filePath})`,
				`request: ${c.requestDto ?? '-'}   response: ${c.responseDto ?? '-'}`,
			].join('\n');
		}
		case 'get_dependency_impact': {
			const n = String(a.name ?? '');
			const [maven, npm] = await Promise.all([index.getMavenImpact(n), index.getNpmConsumers(n)]);
			if (!maven.length && !npm.length) { return `Nothing in this repo depends on '${n}' (checked Maven artifactIds and npm package names).`; }
			const lines: string[] = [];
			if (maven.length) { lines.push(`Maven modules depending on ${n}:`, capped(maven, p => `- ${p}`)); }
			if (npm.length) { lines.push(`npm packages depending on ${n}:`, capped(npm, p => `- ${p}`)); }
			return lines.join('\n');
		}
		case 'get_config_drift': {
			const drift = await index.getConfigDrift(String(a.serviceName ?? ''));
			if (!drift.length) { return `No configuration drift recorded for '${a.serviceName}'.`; }
			return capped(drift, d => `- ${d.key}: ${Object.entries(d.envValues).map(([env, v]) => `${env}=${v}`).join(' | ')}`);
		}
		case 'get_infra_resources': {
			const filter = a.filter ? String(a.filter) : undefined;
			switch (String(a.kind)) {
				case 'terraform': {
					const rs = await index.getTerraformResources(filter);
					return rs.length ? capped(rs, r => `- ${r.resourceType}.${r.resourceName} [${r.provider}]  (${r.filePath})`) : 'No Terraform resources indexed.';
				}
				case 'k8s': {
					const rs = await index.getK8sResources(filter);
					return rs.length ? capped(rs, r => `- ${r.kind}/${r.name}${r.namespace ? ` ns=${r.namespace}` : ''}  (${r.filePath})`) : 'No Kubernetes manifests indexed.';
				}
				case 'pipeline': {
					const jobs = await index.getPipelineJobs(filter);
					return jobs.length ? capped(jobs, j => `- [${j.stage}] ${j.name}${j.needs.length ? ` needs: ${j.needs.join(', ')}` : ''}  (${j.filePath})`) : 'No CI pipeline jobs indexed.';
				}
				default:
					return 'kind must be one of terraform, k8s, pipeline.';
			}
		}
		case 'get_git_context': {
			const [ctx, hot] = await Promise.all([index.getGitContext(), index.getGitRecentlyChanged(Number(a.recentFiles) || 10)]);
			if (!ctx.branch && !ctx.log) { return 'Not a git repository (or git is unavailable).'; }
			const lines = [`branch: ${ctx.branch || '(detached)'}`];
			lines.push('', 'uncommitted:', ctx.status || '(clean)');
			if (ctx.diffStat) { lines.push('', 'diff --stat HEAD:', ctx.diffStat); }
			lines.push('', 'recent commits:', ctx.log || '(none)');
			if (hot.length) { lines.push('', 'most changed files (last 100 commits):', capped(hot, h => `- ${h.file} (${h.changeCount}×, last ${h.lastChanged})`)); }
			return lines.join('\n');
		}
		default:
			return undefined;
	}
}
