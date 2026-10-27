export type TestFailure = { name: string; message: string };
export type ParsedTests = { runner: string; passed: number; failed: TestFailure[]; tail: string };

const tailOf = (output: string) => output.trim().split('\n').slice(-12).join('\n');

function count(output: string, re: RegExp): number {
	const m = output.match(re);
	return m ? Number(m[1]) : 0;
}

/** Structured result from vitest, jest, mocha, pytest, Maven surefire, or go test. Unknown output is a single pass/fail from the exit text. */
export function parseTestOutput(output: string, hint?: string): ParsedTests {
	const text = output.replace(/\u001b\[[0-9;]*m/g, '');
	const runner = hint ?? detectRunner(text);
	const failed: TestFailure[] = [];
	let passed = 0;
	if (runner === 'vitest' || runner === 'jest') {
		passed = count(text, /Tests\s+(\d+)\s+passed/i) || count(text, /(\d+)\s+passed/i);
		const failCount = count(text, /Tests\s+(\d+)\s+failed/i) || count(text, /(\d+)\s+failed/i);
		for (const m of text.matchAll(/^\s*(?:FAIL|×|✕)\s+(.+)$/gm)) { failed.push({ name: m[1].trim(), message: '' }); }
		while (failed.length < failCount) { failed.push({ name: `failed ${failed.length + 1}`, message: '' }); }
	} else if (runner === 'mocha') {
		passed = count(text, /(\d+)\s+passing/);
		for (const m of text.matchAll(/^\s*\d+\)\s+(.+)$/gm)) { failed.push({ name: m[1].trim(), message: '' }); }
	} else if (runner === 'pytest') {
		passed = count(text, /(\d+)\s+passed/);
		for (const m of text.matchAll(/^FAILED\s+(.+)$/gm)) { failed.push({ name: m[1].trim(), message: '' }); }
	} else if (runner === 'go') {
		for (const m of text.matchAll(/^--- FAIL:\s+(\S+)/gm)) { failed.push({ name: m[1], message: '' }); }
		passed = (text.match(/^--- PASS:/gm) ?? []).length;
	} else if (runner === 'surefire') {
		passed = Math.max(0, count(text, /tests="(\d+)"/) - count(text, /failures="(\d+)"/) - count(text, /errors="(\d+)"/));
		for (const m of text.matchAll(/<testcase[^>]*name="([^"]+)"[^>]*>[\s\S]*?<failure/g)) { failed.push({ name: m[1], message: '' }); }
	} else {
		passed = /\b(ok|passed|success)\b/i.test(text) && !/\b(fail|error)\b/i.test(text) ? 1 : 0;
		if (/\b(fail|error)\b/i.test(text)) { failed.push({ name: 'command', message: tailOf(text) }); }
	}
	return { runner, passed, failed, tail: tailOf(text) };
}

export function detectRunner(text: string): string {
	if (/vitest|RUN\s+v\d/i.test(text)) { return 'vitest'; }
	if (/jest/i.test(text)) { return 'jest'; }
	if (/passing|failing/.test(text) && /\d+\)/.test(text)) { return 'mocha'; }
	if (/===+.*pytest|PASSED|FAILED /.test(text) && /passed/.test(text)) { return 'pytest'; }
	if (/^--- (PASS|FAIL):/m.test(text) || /\bok\s+\S+\t/.test(text)) { return 'go'; }
	if (/<testsuite\b/.test(text)) { return 'surefire'; }
	return 'unknown';
}
