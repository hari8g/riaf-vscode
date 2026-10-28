import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { callMcpTool, discoverMcpTools, mcpResultText } from '../src/mcpClient.js';
import { loadMcpServers, parseMcpConfig, prefixMcpTool, transportsToTry } from '../src/mcpConfig.js';
import { classifyTerminalOutput, devServerCommand, observeExecution, resolveTerminalResult, stripAnsi } from '../src/tools/terminalHeuristics.js';

async function* chunks(parts: string[]): AsyncGenerator<string> {
	for (const part of parts) { yield part; }
}
async function* hang(): AsyncGenerator<string> { await new Promise(() => { }); yield ''; }

describe('MCP config and terminal heuristics', () => {
	it('parses stdio, SSE and streamable HTTP, and lets the workspace override the user file', () => {
		const servers = parseMcpConfig(JSON.stringify({ mcpServers: { riaf: { command: 'node', args: ['dist/mcp.mjs'], env: { A: '1', B: 2 } }, remote: { url: 'http://127.0.0.1:9/sse' } } }));
		expect(servers.map(s => s.name)).toEqual(['riaf', 'remote']);
		expect(servers[0].transport).toBe('stdio');
		expect(servers[0].env).toEqual({ A: '1' });
		expect(servers[1].transport).toBe('sse');
		expect(servers[1].explicitTransport).toBe(true);
		expect(prefixMcpTool('my-server', 'do thing')).toBe('mcp_my_server_do_thing');
		expect(parseMcpConfig('not json')).toEqual([]);

		const home = mkdtempSync(join(tmpdir(), 'riaf-mcp-home-'));
		const root = mkdtempSync(join(tmpdir(), 'riaf-mcp-root-'));
		mkdirSync(join(home, '.cursor'));
		mkdirSync(join(root, '.vscode'));
		writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { shared: { command: 'user' }, onlyUser: { url: 'http://user.example/mcp', headers: { Authorization: 'Bearer x' } } } }));
		writeFileSync(join(root, '.vscode', 'mcp.json'), JSON.stringify({ servers: { vscode: { type: 'http', url: 'http://127.0.0.1:9/mcp' } } }));
		writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { command: 'repo', args: ['a'] } } }));
		const merged = Object.fromEntries(loadMcpServers(root, home).map(s => [s.name, s]));
		expect(merged.shared.command).toBe('repo');
		expect(merged.onlyUser.transport).toBe('http');
		expect(transportsToTry(merged.onlyUser)).toEqual(['http', 'sse']);
		expect(merged.vscode.explicitTransport).toBe(true);
		expect(transportsToTry(merged.vscode)).toEqual(['http']);
		expect(merged.onlyUser.headers.Authorization).toBe('Bearer x');
		expect(mcpResultText({ content: [{ text: 'hello' }, { text: 'there' }] })).toBe('hello\nthere');
	});

	it('classifies shell-integration output into a reason', async () => {
		expect(stripAnsi('\u001b[32mready\u001b[0m')).toBe('ready');
		expect(classifyTerminalOutput('Local: http://localhost:5173/').ready).toBe(true);
		expect(classifyTerminalOutput('Error: listen EADDRINUSE :::3000').reason).toBe('port in use');
		expect(devServerCommand('npm run dev')).toBe(true);
		expect(devServerCommand('npm test')).toBe(false);
		expect(resolveTerminalResult({ output: '', devServer: true, timedOut: false, shellIntegration: false }).reason).toBe('sent (no shell integration)');

		const ready = await observeExecution(chunks(['Listening on http://127.0.0.1:3000\n']), new Promise(() => { }), { devServer: true, timeoutMs: 400 });
		expect(resolveTerminalResult({ ...ready, devServer: true, shellIntegration: true }).reason).toBe('server ready');

		const exited = await observeExecution(chunks(['ok\n']), Promise.resolve(2), { devServer: false, timeoutMs: 400 });
		expect(resolveTerminalResult({ ...exited, devServer: false, shellIntegration: true })).toMatchObject({ ok: false, reason: 'exit 2' });

		const stalled = await observeExecution(hang(), new Promise(() => { }), { devServer: false, timeoutMs: 30 });
		expect(resolveTerminalResult({ ...stalled, devServer: false, shellIntegration: true }).reason).toBe('timed out');

		const busy = await observeExecution(chunks(['Error: listen EADDRINUSE :::3000\n']), new Promise(() => { }), { devServer: true, timeoutMs: 400 });
		expect(resolveTerminalResult({ ...busy, devServer: true, shellIntegration: true })).toMatchObject({ ok: false, reason: 'port in use' });
	});

	it('lists and calls a stdio MCP server', async () => {
		const root = mkdtempSync(join(tmpdir(), 'riaf-mcp-stdio-'));
		const home = mkdtempSync(join(tmpdir(), 'riaf-mcp-stdio-home-'));
		const modules = join(__dirname, '../../../node_modules');
		const sdk = join(modules, '@modelcontextprotocol/sdk/dist/esm');
		const serverFile = join(root, 'echo.mjs');
		// ESM specifiers must be file:// URLs — a bare C:\ path is an unknown URL scheme on Windows
		const spec = (p: string) => JSON.stringify(pathToFileURL(p).href);
		writeFileSync(serverFile, `import { z } from ${spec(join(modules, 'zod/index.js'))};\nimport { McpServer } from ${spec(join(sdk, 'server/mcp.js'))};\nimport { StdioServerTransport } from ${spec(join(sdk, 'server/stdio.js'))};\nconst server = new McpServer({ name: 'echo', version: '0.0.1' });\nserver.tool('echo', 'echo text', { text: z.string() }, async ({ text }) => ({ content: [{ type: 'text', text }] }));\nawait server.connect(new StdioServerTransport());\n`);
		writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [serverFile] } } }));
		const found = await discoverMcpTools(root, [], 8_000, home);
		expect([...found.errors.entries()]).toEqual([]);
		expect(found.bindings.map(b => b.prefixed)).toContain('mcp_echo_echo');
		const called = await callMcpTool(root, 'echo', 'echo', { text: 'hi' }, []);
		expect(called.ok).toBe(true);
		expect(called.result).toContain('hi');
	}, 15_000);
});
