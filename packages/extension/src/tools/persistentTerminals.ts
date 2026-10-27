import * as vscode from 'vscode';
import { devServerCommand, observeExecution, resolveTerminalResult } from './terminalHeuristics.js';

type Slot = { term: vscode.Terminal; log: string };

const slots = new Map<string, Slot>();

const SHELL_WAIT_MS = 3_000;

function ensure(name: string, cwd: string): Slot {
	let slot = slots.get(name);
	if (!slot || slot.term.exitStatus) {
		const term = vscode.window.createTerminal({ name: `RIAF ${name}`, cwd });
		slot = { term, log: '' };
		slots.set(name, slot);
	}
	return slot;
}

function waitForShell(term: vscode.Terminal, ms: number): Promise<vscode.TerminalShellIntegration | undefined> {
	if (term.shellIntegration) { return Promise.resolve(term.shellIntegration); }
	const listen = vscode.window.onDidChangeTerminalShellIntegration;
	if (!listen) { return Promise.resolve(undefined); }
	return new Promise(resolve => {
		const timer = setTimeout(() => { sub.dispose(); resolve(term.shellIntegration); }, ms);
		const sub = listen(e => {
			if (e.terminal !== term) { return; }
			clearTimeout(timer);
			sub.dispose();
			resolve(e.shellIntegration);
		});
	});
}

function exitOf(execution: vscode.TerminalShellExecution): Promise<number | undefined> {
	const listen = vscode.window.onDidEndTerminalShellExecution;
	if (!listen) { return Promise.resolve(undefined); }
	return new Promise(resolve => {
		const sub = listen(e => {
			if (e.execution !== execution) { return; }
			sub.dispose();
			resolve(e.exitCode);
		});
	});
}

/** Open or reuse a named terminal, run `command` through shell integration, and report why it stopped. */
export async function runPersistentCommand(opts: { name: string; command: string; cwd: string; timeoutMs?: number; devServer?: boolean }): Promise<{ ok: boolean; result: string }> {
	const slot = ensure(opts.name, opts.cwd);
	const command = opts.command.trim();
	if (!command) { return { ok: true, result: `terminal ${opts.name}: opened` }; }
	const devServer = opts.devServer ?? devServerCommand(command);
	slot.term.show(true);
	const shell = await waitForShell(slot.term, SHELL_WAIT_MS);
	if (!shell) {
		slot.term.sendText(command);
		slot.log += `\n$ ${command}\n`;
		const verdict = resolveTerminalResult({ output: slot.log, devServer, timedOut: false, shellIntegration: false });
		return { ok: verdict.ok, result: `terminal ${opts.name}: ${verdict.reason}` };
	}
	let execution: vscode.TerminalShellExecution;
	try { execution = shell.executeCommand(command); }
	catch {
		slot.term.sendText(command);
		const verdict = resolveTerminalResult({ output: '', devServer, timedOut: false, shellIntegration: false });
		return { ok: verdict.ok, result: `terminal ${opts.name}: ${verdict.reason}` };
	}
	const observed = await observeExecution(execution.read(), exitOf(execution), { devServer, timeoutMs: opts.timeoutMs ?? (devServer ? 20_000 : 120_000) });
	slot.log = observed.output;
	const verdict = resolveTerminalResult({ output: observed.output, exitCode: observed.exitCode, devServer, timedOut: observed.timedOut, shellIntegration: true });
	const tail = observed.output.trim().slice(-2_000);
	return { ok: verdict.ok, result: `terminal ${opts.name}: ${verdict.reason}${tail ? `\n${tail}` : ''}` };
}

export function disposePersistentTerminal(name: string): boolean {
	const slot = slots.get(name);
	slot?.term.dispose();
	slots.delete(name);
	return Boolean(slot);
}
