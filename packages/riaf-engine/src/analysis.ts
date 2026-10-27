/** Downstream CI jobs: everyone who needs `start`, directly or through another job. */
export function pipelineBlastRadius(jobs: { name: string; needs: string[] }[], start: string): string[] {
	const dependents = new Map<string, string[]>();
	for (const job of jobs) {
		for (const need of job.needs) {
			const list = dependents.get(need) ?? [];
			list.push(job.name);
			dependents.set(need, list);
		}
	}
	const out: string[] = [];
	const seen = new Set<string>();
	const stack = [start];
	while (stack.length) {
		const cur = stack.pop()!;
		for (const next of dependents.get(cur) ?? []) {
			if (seen.has(next)) { continue; }
			seen.add(next);
			out.push(next);
			stack.push(next);
		}
	}
	return out;
}

/** `git log --name-only` body → one file list per commit. */
export function parseGitNameOnly(log: string): string[][] {
	const commits: string[][] = [];
	let current: string[] | null = null;
	for (const line of log.split('\n')) {
		if (line.startsWith('commit ')) { if (current) { commits.push(current); } current = []; continue; }
		if (!current || !line.trim() || line.startsWith('Author:') || line.startsWith('Date:') || line.startsWith('    ')) { continue; }
		current.push(line.trim());
	}
	if (current) { commits.push(current); }
	return commits.filter(c => c.length);
}

/** How often `file` changed in the same commit as each other file. */
export function coChangeCounts(commits: string[][]): Map<string, Map<string, number>> {
	const scores = new Map<string, Map<string, number>>();
	for (const files of commits) {
		const unique = [...new Set(files)];
		for (const a of unique) {
			const row = scores.get(a) ?? new Map<string, number>();
			for (const b of unique) {
				if (a === b) { continue; }
				row.set(b, (row.get(b) ?? 0) + 1);
			}
			scores.set(a, row);
		}
	}
	return scores;
}

export type SecurityRule = { id: string; pattern: string; message: string; flags?: string };

export const DEFAULT_SECURITY_RULES: SecurityRule[] = [
	{ id: 'aws-key', pattern: 'AKIA[0-9A-Z]{16}', message: 'looks like an AWS access key' },
	{ id: 'private-key', pattern: '-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----', message: 'private key material' },
	{ id: 'password-assign', pattern: '(password|passwd|secret)\\s*[:=]\\s*[\'"][^\'"]{6,}[\'"]', message: 'hard-coded secret assignment', flags: 'i' },
	{ id: 'eval', pattern: '\\beval\\s*\\(', message: 'eval() executes a string' },
	{ id: 'cleartext-http', pattern: 'http://(?!localhost|127\\.0\\.0\\.1)', message: 'cleartext http URL' },
	{ id: 'tls-verify-off', pattern: 'rejectUnauthorized\\s*:\\s*false|InsecureSkipVerify\\s*[:=]\\s*true|CURLOPT_SSL_VERIFYPEER\\s*,\\s*0', message: 'TLS verification disabled', flags: 'i' },
	{ id: 'world-writable', pattern: 'chmod\\s+(-R\\s+)?[0-7]*777\\b', message: 'world-writable permissions' },
];

export type SecurityFinding = { rule: string; path: string; line: number; message: string };

export function scanSecurity(files: { path: string; text: string }[], extra: SecurityRule[] = []): SecurityFinding[] {
	const rules = [...DEFAULT_SECURITY_RULES, ...extra].flatMap(rule => {
		try { return [{ ...rule, re: new RegExp(rule.pattern, rule.flags ?? '') }]; }
		catch { return []; }
	});
	const findings: SecurityFinding[] = [];
	for (const file of files) {
		const lines = file.text.split('\n');
		for (const rule of rules) {
			for (let i = 0; i < lines.length; i++) {
				if (rule.re.test(lines[i])) { findings.push({ rule: rule.id, path: file.path, line: i + 1, message: rule.message }); }
			}
		}
	}
	return findings;
}

/** Group Terraform-like addresses `{type, name, file}` by type. */
export function iacTopology(resources: { resourceType: string; name: string; filePath: string }[]): { type: string; count: number; names: string[] }[] {
	const by = new Map<string, string[]>();
	for (const r of resources) {
		const list = by.get(r.resourceType) ?? [];
		list.push(`${r.name} (${r.filePath})`);
		by.set(r.resourceType, list);
	}
	return [...by.entries()].map(([type, names]) => ({ type, count: names.length, names })).sort((a, b) => b.count - a.count);
}
