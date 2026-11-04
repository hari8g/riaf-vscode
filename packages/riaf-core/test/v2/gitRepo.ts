import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sample-repo');
export const NOW = Date.parse('2026-07-01T00:00:00Z');

export const AUTHORS = {
	alice: { name: 'Alice', email: 'alice@example.com' },
	bob: { name: 'Bob', email: 'bob@example.com' },
	carol: { name: 'Carol', email: 'carol@example.com' },
};

export function git(repo: string, args: string[], env: Record<string, string> = {}): string {
	return execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: repo, ...env }, encoding: 'utf8' }).trim();
}

export function commit(repo: string, who: keyof typeof AUTHORS, date: string, message: string, edits: Record<string, string | ((old: string) => string)>): string {
	for (const [path, edit] of Object.entries(edits)) {
		const abs = join(repo, path);
		mkdirSync(dirname(abs), { recursive: true });
		let old = ''; try { old = readFileSync(abs, 'utf8'); } catch { /* new */ }
		writeFileSync(abs, typeof edit === 'function' ? edit(old) : edit);
	}
	git(repo, ['add', '-A']);
	const a = AUTHORS[who];
	git(repo, ['commit', '-q', '-m', message], { GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_COMMITTER_NAME: a.name, GIT_COMMITTER_EMAIL: a.email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
	return git(repo, ['rev-parse', 'HEAD']);
}

const append = (line: string) => (old: string) => `${old.replace(/\s*$/, '')}\n${line}\n`;

/** Copy the sample repo and give it a scripted history (tickets, noise, decisions, a rename). */
export function makeHistoryRepo(dir: string): { repo: string; shas: Record<string, string> } {
	const repo = join(dir, 'repo');
	cpSync(FIXTURE, repo, { recursive: true });
	git(repo, ['init', '-q', '-b', 'main']);
	git(repo, ['config', 'user.email', 'test@example.com']);
	git(repo, ['config', 'user.name', 'Test']);
	git(repo, ['config', 'commit.gpgsign', 'false']);
	const shas: Record<string, string> = {};
	git(repo, ['add', '-A']);
	const a = AUTHORS.alice;
	git(repo, ['commit', '-q', '-m', 'Initial import of the order sample'], { GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_AUTHOR_DATE: '2026-01-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T10:00:00Z' });
	shas.initial = git(repo, ['rev-parse', 'HEAD']);
	shas.fix1 = commit(repo, 'bob', '2026-03-01T10:00:00Z', 'fix(payments): capturePayment accepted refunded orders PAY-12\n\nThe status check was wrong because refunded orders kept the Pending flag.', {
		'src/orderService.ts': append('// PAY-12: guard refunded orders'),
		'src/orderService.test.ts': append('// PAY-12 regression test'),
	});
	shas.fix1b = commit(repo, 'bob', '2026-03-01T10:10:00Z', 'PAY-12 log the capture decision', {
		'src/orderService.ts': append('// log capture decision'),
		'src/logger.ts': append('// capture logging'),
	});
	shas.prettier = commit(repo, 'carol', '2026-03-15T09:00:00Z', 'Run prettier on all files', {
		'src/orderService.ts': append('// fmt'), 'src/logger.ts': append('// fmt'), 'src/index.ts': append('// fmt'), 'src/models/order.ts': append('// fmt'),
	});
	shas.bump = commit(repo, 'carol', '2026-04-01T09:00:00Z', 'chore: bump deps', {
		'package.json': old => old.replace('^4.19.0', '^4.21.0'),
		'package-lock.json': '{"lockfileVersion":3}\n',
	});
	shas.feat = commit(repo, 'alice', '2026-05-01T12:00:00Z', 'feat: add order refunds\n\nWe moved refund handling into OrderService instead of the controller because the controller must stay thin.', {
		'src/orderService.ts': append('// refund support'),
		'src/models/order.ts': append('// Refunded status'),
		'src/orderService.test.ts': append('// refund tests'),
	});
	shas.fix2 = commit(repo, 'carol', '2026-06-01T08:00:00Z', 'Fix order status mismatch between model and service', {
		'src/models/order.ts': append('// status mapping fix'),
		'src/orderService.ts': append('// use mapped status'),
	});
	git(repo, ['mv', 'py/utils.py', 'py/helpers.py']);
	shas.rename = commit(repo, 'alice', '2026-06-10T08:00:00Z', 'refactor: rename utils to helpers', {
		'py/app.py': old => old.replace(/\butils\b/g, 'helpers'),
	});
	return { repo, shas };
}

export { append };
