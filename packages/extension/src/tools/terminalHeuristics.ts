export function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/** What a dev-server log is telling us, without owning the terminal. */
export function classifyTerminalOutput(output: string): { ready: boolean; reason: string } {
	if (/EADDRINUSE|address already in use/i.test(output)) { return { ready: false, reason: 'port in use' }; }
	if (/ELIFECYCLE|npm ERR!|error TS\d+|Traceback \(most recent call last\)|panic:/i.test(output)) { return { ready: false, reason: 'process error' }; }
	if (/ready in \d|Local:\s+https?:|listening on|server (started|running)|compiled successfully|webpack compiled/i.test(output)) { return { ready: true, reason: 'server ready' }; }
	return { ready: false, reason: 'still starting' };
}

export function devServerCommand(command: string): boolean {
	return /\b(vite|next|nuxt|webpack-dev-server|ng serve|npm run (dev|start)|pnpm (dev|start)|yarn (dev|start)|flask run|uvicorn|go run)\b/.test(command);
}

export type TerminalObservation = {
	output: string;
	/** Set when the shell reported an exit. Absent while the process is still running. */
	exitCode?: number;
	devServer: boolean;
	timedOut: boolean;
	/** False when VS Code has no shell integration and the command was only typed in. */
	shellIntegration: boolean;
};

/** Turn a finished observation into the reason the agent sees. */
export function resolveTerminalResult(obs: TerminalObservation): { ok: boolean; ready: boolean; reason: string } {
	if (!obs.shellIntegration) { return { ok: true, ready: false, reason: 'sent (no shell integration)' }; }
	const classified = classifyTerminalOutput(obs.output);
	if (classified.reason === 'port in use' || classified.reason === 'process error') { return { ok: false, ready: false, reason: classified.reason }; }
	if (obs.devServer && classified.ready) { return { ok: true, ready: true, reason: 'server ready' }; }
	if (obs.exitCode !== undefined) { return { ok: obs.exitCode === 0, ready: obs.exitCode === 0, reason: `exit ${obs.exitCode}` }; }
	if (obs.timedOut) { return { ok: false, ready: false, reason: obs.devServer ? 'still starting' : 'timed out' }; }
	return { ok: true, ready: false, reason: obs.devServer ? 'still starting' : 'running' };
}

/**
 * Read a shell-integration stream until the command exits, a dev server looks ready or failed,
 * or `timeoutMs` elapses. `exitCode` may stay pending for a server that is meant to keep running.
 */
export async function observeExecution(
	read: AsyncIterable<string>,
	exitCode: Promise<number | undefined>,
	opts: { devServer: boolean; timeoutMs: number },
): Promise<{ output: string; exitCode?: number; timedOut: boolean }> {
	let output = '';
	let code: number | undefined;
	let sawExit = false;
	const exit = exitCode.then(c => { code = c; sawExit = true; return c; }, () => undefined);
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>(resolve => {
		timer = setTimeout(() => { timedOut = true; resolve(); }, Math.max(1, opts.timeoutMs));
	});
	let stop = false;
	const pump = (async () => {
		for await (const chunk of read) {
			if (stop) { return; }
			output += stripAnsi(chunk);
			if (output.length > 24_000) { output = output.slice(-24_000); }
			const reason = classifyTerminalOutput(output).reason;
			if (opts.devServer && (reason === 'server ready' || reason === 'port in use' || reason === 'process error')) { return; }
			if (sawExit) { return; }
		}
	})();
	await Promise.race([pump, exit.then(() => undefined), timeout]);
	if (timer) { clearTimeout(timer); }
	stop = true;
	if (!timedOut && code === undefined) { await Promise.race([exit.then(() => undefined), new Promise(r => setTimeout(r, 20))]); }
	return { output, exitCode: code, timedOut: timedOut && code === undefined };
}
