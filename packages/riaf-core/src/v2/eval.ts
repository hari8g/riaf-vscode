/**
 * `riaf eval` — offline benchmark built from the repository's own history (framework §Evaluation).
 * For sampled non-noise commits: the commit message is the intent, the touched files are the ground truth.
 */
import { GitHistory } from './gitHistory.js';
import type { Riaf2 } from './riaf2.js';

export interface EvalOptions { samples?: number; budget?: number; minFiles?: number; maxFiles?: number; seed?: number; log?: (m: string) => void }
export interface EvalSample { sha: string; subject: string; touched: string[]; recall: number; precision: number; coChangeRecall5: number | null; ms: number; packFiles: number }
export interface EvalReport {
	samples: EvalSample[];
	packRecall: number;
	packPrecision: number;
	coChangeRecallAt5: number | null;
	compileP50: number;
	compileP95: number;
	gates: { metric: string; value: number | null; target: number; pass: boolean | null }[];
	notes: string[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };

/** Deterministic PRNG so runs are reproducible. */
const mulberry32 = (a: number) => () => { a |= 0; a = a + 0x6d2b79f5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

export async function runEval(riaf: Riaf2, opts: EvalOptions = {}): Promise<EvalReport> {
	const hist = riaf.history;
	if (!hist) throw new Error('history is disabled; eval needs git history');
	await hist.mine();
	const indexed = new Set((await riaf.index.db.getFileMetadata(riaf.index.workspaceHash)).map(f => f.filePath));
	const all = hist.loadCommits();
	const subjects = new Map(riaf.store.raw.all<{ sha: string; subject: string; body: string }>('SELECT sha, subject, body FROM git_commit').map(r => [r.sha, `${r.subject}\n${r.body}`.trim()]));
	const minF = opts.minFiles ?? 2, maxF = opts.maxFiles ?? 15;
	const eligible = all.filter((c, i) => i > 0 && (() => { const t = c.files.map(f => f.path).filter(p => indexed.has(p)); return t.length >= minF && t.length <= maxF; })());
	const rnd = mulberry32(opts.seed ?? 42);
	const pool = [...eligible];
	for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
	const picked = pool.slice(0, opts.samples ?? 20);
	const samples: EvalSample[] = [];
	for (const c of picked) {
		const touched = [...new Set(c.files.map(f => f.path).filter(p => indexed.has(p)))];
		const request = subjects.get(c.sha) ?? '';
		const t0 = Date.now();
		const pack = await riaf.compile(request, { budget: opts.budget ?? 24_000, historyBeforeTs: c.ts, persist: false, fresh: true });
		const ms = Date.now() - t0;
		const packPaths = new Set(pack.items.filter(i => i.kind !== 'history_card' && !i.path.endsWith('/')).map(i => i.path));
		const recall = touched.filter(p => packPaths.has(p)).length / touched.length;
		// Precision/density: share of item tokens belonging to touched files or their direct import neighbours.
		const neighbours = new Set<string>(touched);
		for (const p of touched) {
			const g = await riaf.index.getImportGraph(p).catch(() => ({ imports: [] as string[], importedBy: [] as string[] }));
			for (const x of [...g.imports, ...g.importedBy]) neighbours.add(x);
		}
		const itemTokens = pack.items.filter(i => i.kind !== 'history_card' && !i.path.endsWith('/'));
		const total = itemTokens.reduce((s, i) => s + i.tokens, 0) || 1;
		const precision = itemTokens.filter(i => neighbours.has(i.path)).reduce((s, i) => s + i.tokens, 0) / total;
		// Co-change recall@5 against a graph built only from older commits.
		const graph = hist.computeCoChange(hist.loadCommits({ beforeTs: c.ts }));
		const per: number[] = [];
		for (const f of touched) {
			const nb = GitHistory.neighborsFrom(graph, f, 5);
			if (!nb.length) continue;
			const others = touched.filter(x => x !== f);
			per.push(nb.filter(n => others.includes(n.path)).length / Math.min(5, others.length));
		}
		samples.push({ sha: c.sha, subject: request.split('\n')[0].slice(0, 80), touched, recall, precision, coChangeRecall5: per.length ? mean(per) : null, ms, packFiles: packPaths.size });
		opts.log?.(`[eval] ${c.sha.slice(0, 8)} recall ${recall.toFixed(2)} precision ${precision.toFixed(2)} ${ms} ms`);
	}
	const cc = samples.map(s => s.coChangeRecall5).filter((x): x is number => x !== null);
	const report: EvalReport = {
		samples,
		packRecall: mean(samples.map(s => s.recall)),
		packPrecision: mean(samples.map(s => s.precision)),
		coChangeRecallAt5: cc.length ? mean(cc) : null,
		compileP50: pct(samples.map(s => s.ms), 0.5),
		compileP95: pct(samples.map(s => s.ms), 0.95),
		gates: [],
		notes: [
			`${eligible.length} eligible commits (${minF}-${maxF} indexed files, non-noise); ${samples.length} sampled with seed ${opts.seed ?? 42}.`,
			'Packs are compiled against the index at HEAD (not the sampled commit\'s parent) — recall is optimistic for files that changed shape since; history signals are held out (only commits older than the sample).',
		],
	};
	report.gates = [
		{ metric: 'Pack recall', value: samples.length ? report.packRecall : null, target: 0.8, pass: samples.length ? report.packRecall >= 0.8 : null },
		{ metric: 'Pack precision / density', value: samples.length ? report.packPrecision : null, target: 0.55, pass: samples.length ? report.packPrecision >= 0.55 : null },
		{ metric: 'Co-change recall@5', value: report.coChangeRecallAt5, target: 0.6, pass: report.coChangeRecallAt5 === null ? null : report.coChangeRecallAt5 >= 0.6 },
		{ metric: 'Compile latency p95 (ms)', value: samples.length ? report.compileP95 : null, target: 2000, pass: samples.length ? report.compileP95 < 2000 : null },
	];
	return report;
}

export function formatEvalReport(r: EvalReport): string {
	const f = (v: number | null, ms = false) => v === null ? 'n/a' : ms ? `${Math.round(v)}` : `${Math.round(v * 100)}%`;
	return [
		'# RIAF eval',
		'',
		'| Metric | Value | Target | Gate |',
		'| --- | --- | --- | --- |',
		...r.gates.map(g => `| ${g.metric} | ${f(g.value, g.metric.includes('ms'))} | ${g.metric.includes('ms') ? `< ${g.target}` : `≥ ${Math.round(g.target * 100)}%`} | ${g.pass === null ? '—' : g.pass ? 'pass' : 'FAIL'} |`),
		'',
		`compile p50 ${r.compileP50} ms`,
		'',
		'| Commit | Files | Recall | Precision | Co-change@5 | ms |',
		'| --- | --- | --- | --- | --- | --- |',
		...r.samples.map(s => `| ${s.sha.slice(0, 8)} ${s.subject.replace(/\|/g, '/')} | ${s.touched.length} | ${f(s.recall)} | ${f(s.precision)} | ${f(s.coChangeRecall5)} | ${s.ms} |`),
		'',
		...r.notes.map(n => `> ${n}`),
	].join('\n');
}
