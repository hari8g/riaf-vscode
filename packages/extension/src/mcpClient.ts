import type { ToolSpec } from './modelTransport.js';
import { loadMcpServers, prefixMcpTool, transportsToTry, type McpServerSpec, type McpTransportKind } from './mcpConfig.js';

export type McpToolBinding = { prefixed: string; server: string; tool: string; spec: ToolSpec };

type Session = {
	listTools: () => Promise<{ tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[] }>;
	callTool: (params: { name: string; arguments: Record<string, unknown> }) => Promise<{ content?: { text?: string }[]; isError?: boolean }>;
	close: () => Promise<void>;
};

const cache = new Map<string, { at: number; bindings: McpToolBinding[]; errors: Map<string, string> }>();

export function mcpResultText(result: { content?: { text?: string }[] }): string {
	if (!Array.isArray(result.content)) { return JSON.stringify(result).slice(0, 8_000); }
	return result.content.map(part => typeof part?.text === 'string' ? part.text : JSON.stringify(part)).join('\n').slice(0, 8_000);
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
	});
}

async function connectKind(spec: McpServerSpec, kind: McpTransportKind, cwd?: string): Promise<Session> {
	const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
	const client = new Client({ name: 'riaf', version: '0.1.0' });
	try {
		if (kind === 'stdio') {
			if (!spec.command) { throw new Error(`${spec.name} has no command`); }
			const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
			const env: Record<string, string> = {};
			for (const [key, value] of Object.entries(process.env)) { if (typeof value === 'string') { env[key] = value; } }
			Object.assign(env, spec.env);
			await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env, cwd, stderr: 'ignore' }));
		} else {
			if (!spec.url) { throw new Error(`${spec.name} has no url`); }
			const headers = Object.keys(spec.headers).length ? spec.headers : undefined;
			if (kind === 'sse') {
				const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
				await client.connect(new SSEClientTransport(new URL(spec.url), { requestInit: headers ? { headers } : undefined }));
			} else {
				const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
				await client.connect(new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: headers ? { headers } : undefined }));
			}
		}
		return client as unknown as Session;
	} catch (error) {
		await client.close().catch(() => { });
		throw error;
	}
}

/** Connect with the declared transport. A bare URL that fails as streamable HTTP is retried as SSE. */
export async function openMcpClient(spec: McpServerSpec, cwd?: string): Promise<Session> {
	let last: Error | undefined;
	for (const kind of transportsToTry(spec)) {
		try { return await connectKind(spec, kind, cwd); }
		catch (error) { last = error as Error; }
	}
	throw last ?? new Error(`could not connect to ${spec.name}`);
}

function enabledServers(root: string, disabled: string[], home?: string): McpServerSpec[] {
	const off = new Set(disabled);
	return loadMcpServers(root, home).filter(server => !off.has(server.name));
}

export async function discoverMcpTools(root: string, disabled: string[], timeoutMs = 5_000, home?: string): Promise<{ bindings: McpToolBinding[]; errors: Map<string, string> }> {
	const servers = enabledServers(root, disabled, home);
	const errors = new Map<string, string>();
	const found: { server: string; tool: string; description?: string; inputSchema?: Record<string, unknown> }[] = [];
	await Promise.all(servers.map(async server => {
		let session: Session | undefined;
		try {
			session = await withTimeout(openMcpClient(server, root), timeoutMs, server.name);
			const listed = await withTimeout(session.listTools(), timeoutMs, `${server.name} list`);
			for (const tool of listed.tools ?? []) { found.push({ server: server.name, tool: tool.name, description: tool.description, inputSchema: tool.inputSchema }); }
		} catch (error) { errors.set(server.name, (error as Error).message); }
		finally { await session?.close().catch(() => { }); }
	}));
	const used = new Set<string>();
	const bindings: McpToolBinding[] = found.map(tool => {
		let prefixed = prefixMcpTool(tool.server, tool.tool);
		while (used.has(prefixed)) { prefixed = `${prefixed}_`; }
		used.add(prefixed);
		return {
			prefixed, server: tool.server, tool: tool.tool,
			spec: { name: prefixed, description: `[MCP ${tool.server}] ${tool.description ?? tool.tool}`, inputSchema: tool.inputSchema ?? { type: 'object', properties: {} } },
		};
	});
	cache.set(root, { at: Date.now(), bindings, errors });
	return { bindings, errors };
}

/** Tool specs for the agent. Skipped under vitest so a personal mcp.json is not spawned during unit tests. */
export async function listAgentMcpTools(root: string, disabled: string[]): Promise<ToolSpec[]> {
	if (process.env.VITEST) { return []; }
	const fresh = cache.get(root);
	if (fresh && Date.now() - fresh.at < 30_000) { return fresh.bindings.map(binding => binding.spec); }
	const found = await discoverMcpTools(root, disabled);
	return found.bindings.map(binding => binding.spec);
}

export function cachedMcpStatus(root: string): { errors: Map<string, string>; toolsByServer: Map<string, string[]> } | undefined {
	const hit = cache.get(root);
	if (!hit) { return undefined; }
	const toolsByServer = new Map<string, string[]>();
	for (const binding of hit.bindings) {
		const list = toolsByServer.get(binding.server) ?? [];
		list.push(binding.tool);
		toolsByServer.set(binding.server, list);
	}
	return { errors: hit.errors, toolsByServer };
}

export async function callDiscoveredMcpTool(root: string, name: string, args: Record<string, unknown>, disabled: string[]): Promise<{ ok: boolean; result?: string; error?: string } | undefined> {
	if (!name.startsWith('mcp_') || name === 'mcp_call') { return undefined; }
	let hit = cache.get(root)?.bindings.find(binding => binding.prefixed === name);
	if (!hit && !process.env.VITEST) {
		await discoverMcpTools(root, disabled).catch(() => undefined);
		hit = cache.get(root)?.bindings.find(binding => binding.prefixed === name);
	}
	if (!hit) { return undefined; }
	if (disabled.includes(hit.server)) { return { ok: false, error: `MCP server ${hit.server} is disabled` }; }
	return callMcpTool(root, hit.server, hit.tool, args, disabled);
}

export async function callMcpTool(root: string, serverName: string, tool: string, args: Record<string, unknown>, disabled: string[]): Promise<{ ok: boolean; result?: string; error?: string }> {
	if (disabled.includes(serverName)) { return { ok: false, error: `MCP server ${serverName} is disabled` }; }
	const spec = loadMcpServers(root).find(server => server.name === serverName);
	if (!spec) { return { ok: false, error: `no MCP server ${serverName}` }; }
	const session = await openMcpClient(spec, root);
	try {
		const result = await session.callTool({ name: tool, arguments: args });
		const text = mcpResultText(result);
		return { ok: !result.isError, result: text, error: result.isError ? text.slice(0, 500) : undefined };
	} finally { await session.close().catch(() => { }); }
}
