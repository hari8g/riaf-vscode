import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type McpTransportKind = 'stdio' | 'http' | 'sse';

export type McpServerSpec = {
	name: string;
	command?: string;
	args: string[];
	env: Record<string, string>;
	url?: string;
	headers: Record<string, string>;
	transport: McpTransportKind;
	/** True when the file named the transport, so a failed HTTP connect is not retried as SSE. */
	explicitTransport: boolean;
};

const stringMap = (value: unknown): Record<string, string> => value && typeof value === 'object'
	? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
	: {};

function inferTransport(type: string, command: string | undefined, url: string | undefined): { transport: McpTransportKind; explicit: boolean } {
	if (type === 'sse') { return { transport: 'sse', explicit: true }; }
	if (type === 'http' || type === 'streamable-http' || type === 'streamable_http') { return { transport: 'http', explicit: true }; }
	if (type === 'stdio' || command) { return { transport: 'stdio', explicit: type === 'stdio' || !url }; }
	if (url && /\/sse\/?$/.test(url)) { return { transport: 'sse', explicit: true }; }
	if (url) { return { transport: 'http', explicit: false }; }
	return { transport: 'stdio', explicit: false };
}

/** `.mcp.json` (`mcpServers`) and VS Code `mcp.json` (`servers`): command/args/env, or url with type http|sse. */
export function parseMcpConfig(text: string): McpServerSpec[] {
	let raw: unknown;
	try { raw = JSON.parse(text); } catch { return []; }
	const body = raw as { mcpServers?: unknown; servers?: unknown };
	const servers = (body?.mcpServers && typeof body.mcpServers === 'object' ? body.mcpServers : undefined)
		?? (body?.servers && typeof body.servers === 'object' ? body.servers : undefined);
	if (!servers) { return []; }
	return Object.entries(servers as Record<string, unknown>).map(([name, spec]) => {
		const s = (spec ?? {}) as { command?: unknown; args?: unknown; env?: unknown; url?: unknown; type?: unknown; headers?: unknown };
		const command = typeof s.command === 'string' ? s.command : undefined;
		const url = typeof s.url === 'string' ? s.url : undefined;
		const kind = inferTransport(typeof s.type === 'string' ? s.type.toLowerCase() : '', command, url);
		return {
			name,
			command,
			args: Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === 'string') : [],
			env: stringMap(s.env),
			url,
			headers: stringMap(s.headers),
			transport: kind.transport,
			explicitTransport: kind.explicit,
		};
	});
}

/** Later texts win on the same server name. Empty and invalid documents are skipped. */
export function mergeMcpConfigs(texts: string[]): McpServerSpec[] {
	const map = new Map<string, McpServerSpec>();
	for (const text of texts) { for (const server of parseMcpConfig(text)) { map.set(server.name, server); } }
	return [...map.values()];
}

/** User files first, then the workspace, so the repo overrides a personal server of the same name. */
export function mcpConfigFiles(root: string, home: string): string[] {
	return [
		join(home, '.mcp.json'),
		join(home, '.cursor', 'mcp.json'),
		join(root, '.vscode', 'mcp.json'),
		join(root, '.mcp.json'),
	];
}

export function loadMcpServers(root: string, home = homedir()): McpServerSpec[] {
	const texts = mcpConfigFiles(root, home).map(path => { try { return readFileSync(path, 'utf8'); } catch { return ''; } });
	return mergeMcpConfigs(texts);
}

/** HTTP with no declared type is retried as SSE. An explicit type is used once. */
export function transportsToTry(spec: McpServerSpec): McpTransportKind[] {
	if (spec.transport === 'stdio') { return ['stdio']; }
	if (spec.explicitTransport) { return [spec.transport]; }
	return spec.transport === 'sse' ? ['sse', 'http'] : ['http', 'sse'];
}

export function prefixMcpTool(server: string, tool: string): string {
	const clean = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
	return `mcp_${clean(server)}_${clean(tool)}`;
}
