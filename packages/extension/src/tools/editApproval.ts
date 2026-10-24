import * as vscode from 'vscode';

/**
 * Shows the agent's proposed change as a real VS Code diff (current file ⇄ proposal) and asks
 * the developer to accept or reject — the same feel as Copilot agent mode's review step.
 */
const SCHEME = 'riaf-proposed';
const proposals = new Map<string, string>();
const emitter = new vscode.EventEmitter<vscode.Uri>();

export function registerProposalProvider(ctx: vscode.ExtensionContext): void {
	ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
		onDidChange: emitter.event,
		provideTextDocumentContent: uri => proposals.get(uri.toString()) ?? '',
	}));
}

export async function proposeEdit(target: vscode.Uri, original: string, next: string, label: string): Promise<boolean> {
	const proposedUri = target.with({ scheme: SCHEME, query: `t=${Date.now()}` });
	proposals.set(proposedUri.toString(), next);
	emitter.fire(proposedUri);
	try {
		const leftUri = original === '' ? target.with({ scheme: SCHEME, query: 'empty' }) : target;
		if (original === '') { proposals.set(leftUri.toString(), ''); }
		await vscode.commands.executeCommand('vscode.diff', leftUri, proposedUri, `RIAF: ${label}`, { preview: true });
		const choice = await vscode.window.showInformationMessage(`RIAF agent proposes: ${label}`, { modal: false }, 'Accept', 'Reject');
		return choice === 'Accept';
	} finally {
		proposals.delete(proposedUri.toString());
		// close the diff editor if it is still the active one
		const active = vscode.window.tabGroups.activeTabGroup.activeTab;
		if (active?.input instanceof vscode.TabInputTextDiff && active.input.modified.toString() === proposedUri.toString()) {
			await vscode.window.tabGroups.close(active).then(undefined, () => { });
		}
	}
}
