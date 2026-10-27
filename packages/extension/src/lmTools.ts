import * as vscode from 'vscode';
import type { IndexManager } from './indexManager.js';
import { LM_TOOLS, LM_TOOLS_ALREADY_CONTRIBUTED } from './lmToolCatalog.js';
import { executeTool } from './tools/toolRegistry.js';

/**
 * Exposes RIAF retrieval as Language Model Tools, so Copilot Chat (agent mode or #riaf in a
 * prompt) and any other vscode.lm consumer can use the index without going through @riaf.
 */
export function registerLmTools(ctx: vscode.ExtensionContext, indexes: IndexManager): void {
	const run = (toolName: string) => async (options: vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>, token: vscode.CancellationToken) => {
		const folder = indexes.folderFor(vscode.window.activeTextEditor?.document.uri);
		if (!folder) { return text('No workspace folder is open.'); }
		const index = await indexes.get(folder);
		if (!index.getStatus().indexed) { await indexes.reindex(folder); }
		const out = await executeTool(toolName, options.input ?? {}, { folder, index, requireEditApproval: true, allowRunCommand: false, token });
		return text(out.ok ? out.result : `ERROR: ${out.error}`);
	};
	const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);

	const prep = (label: (i: Record<string, unknown>) => string): vscode.LanguageModelTool<Record<string, unknown>>['prepareInvocation'] =>
		async options => ({ invocationMessage: label(options.input ?? {}) });

	ctx.subscriptions.push(
		vscode.lm.registerTool('riaf_search_codebase', { invoke: run('search_codebase'), prepareInvocation: prep(i => `Searching codebase for "${i.query}"`) }),
		vscode.lm.registerTool('riaf_context_profile', { invoke: run('get_context_profile'), prepareInvocation: prep(i => i.filePath ? `Context profile for ${i.filePath}` : 'Workspace profile') }),
		vscode.lm.registerTool('riaf_search_symbols', { invoke: run('search_symbols'), prepareInvocation: prep(i => `Searching symbols for "${i.query}"`) }),
		...LM_TOOLS.filter(t => !(LM_TOOLS_ALREADY_CONTRIBUTED as readonly string[]).includes(t.name)).map(t =>
			vscode.lm.registerTool(`riaf_${t.name}`, { invoke: run(t.name), prepareInvocation: prep(() => t.display) })),
	);
}
