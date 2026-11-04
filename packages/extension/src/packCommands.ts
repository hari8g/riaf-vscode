import * as vscode from 'vscode';
import { writeFileSync } from 'node:fs';
import { RENDER_TARGETS, Riaf2, type RenderTarget } from '@bosch-mps/riaf-core';
import type { IndexManager } from './indexManager.js';

/**
 * RIAF 2.0 in VS Code: Copilot LM tools `riaf_context` (compile a pack) and `riaf_lookup` (answer a read
 * from the index), and the commands "RIAF: Compile pack for selection" / "RIAF: Export pack".
 */
const riaf2For = new WeakMap<object, Riaf2>();

async function riaf2(indexes: IndexManager): Promise<Riaf2 | undefined> {
	const folder = indexes.folderFor(vscode.window.activeTextEditor?.document.uri);
	if (!folder) { return undefined; }
	const index = await indexes.get(folder);
	if (!index.getStatus().indexed) { await indexes.reindex(folder); }
	let r = riaf2For.get(index);
	if (!r) {
		r = Riaf2.fromIndex(index, { llmSummaries: false });
		riaf2For.set(index, r);
		await r.history?.mine().catch(() => undefined);
		await r.summaries.build().catch(() => undefined);
	}
	return r;
}

function activeContext(): { activeFile?: string; selection?: string } {
	const ed = vscode.window.activeTextEditor;
	if (!ed) { return {}; }
	const activeFile = vscode.workspace.asRelativePath(ed.document.uri, false);
	const selection = ed.selection.isEmpty ? undefined : ed.document.getText(ed.selection);
	return { activeFile, selection };
}

export function registerPackFeatures(ctx: vscode.ExtensionContext, indexes: IndexManager): void {
	const text = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);
	ctx.subscriptions.push(
		vscode.lm.registerTool<{ request: string; budget?: number; scope?: string }>('riaf_context', {
			prepareInvocation: async o => ({ invocationMessage: `Compiling RIAF context pack for "${String(o.input.request ?? '').slice(0, 60)}"` }),
			invoke: async o => {
				const r = await riaf2(indexes);
				if (!r) { return text('No workspace folder is open.'); }
				const pack = await r.compile(o.input.request, { budget: o.input.budget ?? 8_000, scope: o.input.scope, modelHint: 'copilot', ...activeContext() });
				return text(r.render(pack, 'copilot'));
			},
		}),
		vscode.lm.registerTool<{ path?: string; startLine?: number; endLine?: number; symbol?: string; dir?: string; query?: string }>('riaf_lookup', {
			prepareInvocation: async o => ({ invocationMessage: `RIAF lookup ${o.input.path ?? o.input.symbol ?? o.input.dir ?? o.input.query ?? ''}` }),
			invoke: async o => {
				const r = await riaf2(indexes);
				if (!r) { return text('No workspace folder is open.'); }
				const i = o.input;
				const res = await r.lookup({ path: i.path, range: i.path && i.startLine ? [i.startLine, i.endLine ?? i.startLine + 80] : undefined, symbol: i.symbol, dir: i.dir, query: i.query });
				return text(`${res.hit ? `[RIAF ${res.kind}${res.path ? ` ${res.path}` : ''}]` : '[RIAF miss]'}\n${res.content}${res.alternatives?.length ? `\nAlternatives: ${res.alternatives.join(', ')}` : ''}`);
			},
		}),
		vscode.commands.registerCommand('riaf.compilePack', async () => {
			const r = await riaf2(indexes);
			if (!r) { void vscode.window.showWarningMessage('RIAF: open a workspace folder first.'); return; }
			const ac = activeContext();
			const request = await vscode.window.showInputBox({ title: 'RIAF: Compile pack', prompt: 'Describe the task (the active file and selection are included)', value: ac.selection ? `Explain ${ac.selection.split('\n')[0].slice(0, 80)}` : '', ignoreFocusOut: true });
			if (!request) { return; }
			const pack = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'RIAF: compiling context pack…' }, () => r.compile(request, { ...ac }));
			const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: r.render(pack, 'markdown') });
			await vscode.window.showTextDocument(doc, { preview: true });
		}),
		vscode.commands.registerCommand('riaf.exportPack', async () => {
			const r = await riaf2(indexes);
			const pack = r?.currentPack();
			if (!r || !pack) { void vscode.window.showWarningMessage('RIAF: no pack yet — run "RIAF: Compile pack for selection" first.'); return; }
			const target = await vscode.window.showQuickPick(RENDER_TARGETS, { title: 'RIAF: Export pack as…' }) as RenderTarget | undefined;
			if (!target) { return; }
			const ext = target === 'json' || target === 'openai' || target === 'gemini' ? 'json' : 'md';
			const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(vscode.Uri.file(r.root), target === 'agents-md' ? 'AGENTS.md' : `riaf-pack.${ext}`) });
			if (!uri) { return; }
			writeFileSync(uri.fsPath, r.render(pack, target));
			void vscode.window.showInformationMessage(`RIAF: pack exported to ${vscode.workspace.asRelativePath(uri)}`);
		}),
	);
}
