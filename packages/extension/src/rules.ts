import * as vscode from 'vscode';

export const RULES_FILENAME = '.riafrules';

/** Project rules the agent always sees — the extension's equivalent of Trove's `.troverules`. */
export async function readRules(folder: vscode.WorkspaceFolder): Promise<string> {
	try { return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, RULES_FILENAME))).toString('utf8'); }
	catch { return ''; }
}

export async function writeRules(folder: vscode.WorkspaceFolder, text: string): Promise<void> {
	await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder.uri, RULES_FILENAME), Buffer.from(text, 'utf8'));
}

/** Clamp rules so a huge file can't eat the prompt budget; the cap is generous (~2k tokens). */
export const rulesForPrompt = (text: string, maxChars = 8_000): string => {
	const t = text.trim();
	if (!t) { return ''; }
	return `<project_rules>\n${t.length > maxChars ? `${t.slice(0, maxChars)}\n…[rules truncated]` : t}\n</project_rules>`;
};
