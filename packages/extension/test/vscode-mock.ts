// Minimal vscode API surface for unit-testing the agent loop outside the extension host.
export class Uri { constructor(public fsPath: string) { } static file(p: string) { return new Uri(p); } static joinPath(u: Uri, ...p: string[]) { return new Uri([u.fsPath, ...p].join('/')); } toString() { return 'file://' + this.fsPath; } with() { return this; } }
export class EventEmitter<T> { private l: ((e: T) => void)[] = []; event = (f: (e: T) => void) => { this.l.push(f); return { dispose() { } }; }; fire(e: T) { this.l.forEach(f => f(e)); } }
export class CancellationTokenSource { token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() { } }) }; cancel() { } }
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
export class Range { constructor(public start: unknown, public end: unknown) { } }
export class WorkspaceEdit { ops: { uri: Uri; text: string }[] = []; replace(uri: Uri, _r: unknown, text: string) { this.ops.push({ uri, text }); } createFile(uri: Uri, o: { contents?: Uint8Array }) { this.ops.push({ uri, text: Buffer.from(o.contents ?? '').toString('utf8') }); } }
export class LanguageModelTextPart { constructor(public value: string) { } }
export class LanguageModelToolCallPart { constructor(public callId: string, public name: string, public input: unknown) { } }
export class LanguageModelToolResultPart { constructor(public callId: string, public content: unknown[]) { } }
export class LanguageModelToolResult { constructor(public content: unknown[]) { } }
export class LanguageModelChatMessage { static User(c: unknown) { return { role: 'user', c }; } static Assistant(c: unknown) { return { role: 'assistant', c }; } }
export const LanguageModelChatToolMode = { Auto: 1 };
export const FileType = { Directory: 2, File: 1 };
export const ProgressLocation = { Window: 10 };
export const StatusBarAlignment = { Left: 1, Right: 2 };
export class TabInputTextDiff { }
export const configStore = new Map<string, unknown>();
export const ConfigurationTarget = { Global: 1, Workspace: 2 };
export const workspace = {
	fs: {
		readFile: async (u: Uri) => new Uint8Array(readFileSync(u.fsPath)), writeFile: async (u: Uri, b: Uint8Array) => writeFileSync(u.fsPath, b),
		readDirectory: async (u: Uri) => readdirSync(u.fsPath).map(n => [n, statSync(u.fsPath + '/' + n).isDirectory() ? 2 : 1]),
		stat: async (u: Uri) => statSync(u.fsPath), createDirectory: async (u: Uri) => mkdirSync(u.fsPath, { recursive: true }), delete: async (u: Uri) => rmSync(u.fsPath, { recursive: true, force: true }),
	},
	textDocuments: [] as unknown[], getConfiguration: () => ({ get: (k: string, d: unknown) => configStore.has(k) ? configStore.get(k) : d, update: async (k: string, v: unknown) => { configStore.set(k, v); } }), getWorkspaceFolder: () => undefined, workspaceFolders: [],
	applyEdit: async (e: WorkspaceEdit) => { for (const op of e.ops) { writeFileSync(op.uri.fsPath, op.text); } return true; },
	openTextDocument: async (u: Uri) => { const t = readFileSync(u.fsPath, 'utf8'); return { getText: () => t, positionAt: (n: number) => n, isDirty: false, save: async () => true }; },
	registerTextDocumentContentProvider: () => ({ dispose() { } }), onDidChangeWorkspaceFolders: () => ({ dispose() { } }), onDidChangeConfiguration: () => ({ dispose() { } }),
};
export const ViewColumn = { Active: -1, Beside: -2 };
export const window = { showInformationMessage: async () => 'Run', showWarningMessage: async () => 'Delete', showErrorMessage: async () => undefined, activeTextEditor: undefined, tabGroups: { activeTabGroup: { activeTab: undefined }, close: async () => true }, createOutputChannel: () => ({ appendLine() { }, dispose() { } }), createStatusBarItem: () => ({ show() { }, dispose() { } }), withProgress: async (_o: unknown, f: (p: unknown) => unknown) => f({ report() { } }) };
export const commands = { executeCommand: async () => undefined, registerCommand: () => ({ dispose() { } }) };
export const lm = { selectChatModels: async () => [], registerTool: () => ({ dispose() { } }) };
export const authentication = { getSession: async () => ({ accessToken: 'test-token' }) };
export const chat = { createChatParticipant: () => ({}) };
