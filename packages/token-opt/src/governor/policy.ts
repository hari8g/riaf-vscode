import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Budget policies (`.riaf/policy.yaml`, versioned with the repo). A small YAML subset is parsed
 * (nested maps by indentation, `{ a: 1 }` flow maps, scalars, comments) so no YAML dependency ships.
 */

export type Phase = 'explore' | 'plan' | 'implement' | 'verify';
export const PHASES: Phase[] = ['explore', 'plan', 'implement', 'verify'];

export interface PhaseCeiling {
	/** Soft ceiling on tool calls in this phase → reflection prompt. */
	soft_calls: number;
	/** Hard ceiling → exploratory calls are blocked until a plan is written. */
	max_calls: number;
	soft_tokens: number;
	max_tokens: number;
	max_minutes: number;
}

export interface GovernorPolicy {
	version: number;
	phases: Record<Phase, PhaseCeiling>;
	guard: {
		/** Serve the first Read of a file the pack already contains. Off for hosts whose edit tool requires a real Read (Claude Code). */
		serve_first_reads: boolean;
		/** Identical calls at or above this count are loops. */
		loop_threshold: number;
		/** Serve repeat reads of unchanged files. */
		serve_repeat_reads: boolean;
		/** Cache Grep / Glob / LS / read-only shell results. */
		cache_searches: boolean;
	};
	prefetch: { enabled: boolean; min_coupling: number; max_files: number };
}

export const DEFAULT_POLICY: GovernorPolicy = {
	version: 1,
	phases: {
		explore: { soft_calls: 40, max_calls: 80, soft_tokens: 120_000, max_tokens: 250_000, max_minutes: 30 },
		plan: { soft_calls: 15, max_calls: 40, soft_tokens: 60_000, max_tokens: 120_000, max_minutes: 15 },
		implement: { soft_calls: 80, max_calls: 200, soft_tokens: 250_000, max_tokens: 500_000, max_minutes: 90 },
		verify: { soft_calls: 30, max_calls: 80, soft_tokens: 120_000, max_tokens: 250_000, max_minutes: 30 },
	},
	guard: { serve_first_reads: false, loop_threshold: 3, serve_repeat_reads: true, cache_searches: true },
	prefetch: { enabled: true, min_coupling: 0.6, max_files: 4 },
};

type YamlValue = string | number | boolean | null | YamlMap;
interface YamlMap { [k: string]: YamlValue }

const scalar = (raw: string): YamlValue => {
	const v = raw.trim();
	if (v === '' || v === '~' || v === 'null') return null;
	if (v === 'true' || v === 'yes' || v === 'on') return true;
	if (v === 'false' || v === 'no' || v === 'off') return false;
	if (/^-?\d+(\.\d+)?$/.test(v.replace(/_/g, ''))) return Number(v.replace(/_/g, ''));
	if (/^-?\d+(\.\d+)?[kK]$/.test(v)) return Number(v.slice(0, -1)) * 1000;
	if (/^(['"]).*\1$/.test(v)) return v.slice(1, -1);
	if (v.startsWith('{') && v.endsWith('}')) {
		const out: YamlMap = {};
		for (const part of v.slice(1, -1).split(',')) {
			const i = part.indexOf(':');
			if (i > 0) out[part.slice(0, i).trim()] = scalar(part.slice(i + 1));
		}
		return out;
	}
	return v;
};

/** Parse the YAML subset used by policy files. Throws on malformed indentation. */
export function parseYamlSubset(text: string): YamlMap {
	const root: YamlMap = {};
	const stack: { indent: number; map: YamlMap }[] = [{ indent: -1, map: root }];
	text.split(/\r?\n/).forEach((line, n) => {
		const stripped = line.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
		if (!stripped.trim()) return;
		const indent = stripped.length - stripped.trimStart().length;
		const m = /^\s*([\w.-]+)\s*:\s*(.*)$/.exec(stripped);
		if (!m) throw new Error(`policy.yaml line ${n + 1}: expected "key: value"`);
		while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
		const parent = stack[stack.length - 1].map;
		if (m[2].trim() === '') {
			const child: YamlMap = {};
			parent[m[1]] = child;
			stack.push({ indent, map: child });
		} else parent[m[1]] = scalar(m[2]);
	});
	return root;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Merge a parsed policy over the defaults; unknown keys are ignored, invalid values fall back. */
export function resolvePolicy(raw: unknown): GovernorPolicy {
	const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, unknown>>;
	const phases = {} as GovernorPolicy['phases'];
	for (const p of PHASES) {
		const src = ((r.phases as Record<string, unknown> | undefined)?.[p] ?? {}) as Record<string, unknown>;
		const d = DEFAULT_POLICY.phases[p];
		phases[p] = {
			soft_calls: num(src.soft_calls, d.soft_calls), max_calls: num(src.max_calls, d.max_calls),
			soft_tokens: num(src.soft_tokens, d.soft_tokens), max_tokens: num(src.max_tokens, d.max_tokens), max_minutes: num(src.max_minutes, d.max_minutes),
		};
		if (phases[p].soft_calls > phases[p].max_calls) phases[p].soft_calls = phases[p].max_calls;
	}
	const g = (r.guard ?? {}) as Record<string, unknown>;
	const pf = (r.prefetch ?? {}) as Record<string, unknown>;
	return {
		version: num(r.version as unknown, 1),
		phases,
		guard: {
			serve_first_reads: bool(g.serve_first_reads, DEFAULT_POLICY.guard.serve_first_reads),
			loop_threshold: Math.max(2, num(g.loop_threshold, DEFAULT_POLICY.guard.loop_threshold)),
			serve_repeat_reads: bool(g.serve_repeat_reads, DEFAULT_POLICY.guard.serve_repeat_reads),
			cache_searches: bool(g.cache_searches, DEFAULT_POLICY.guard.cache_searches),
		},
		prefetch: { enabled: bool(pf.enabled, true), min_coupling: num(pf.min_coupling, 0.6), max_files: num(pf.max_files, 4) },
	};
}

export function parsePolicy(yaml: string): GovernorPolicy {
	return resolvePolicy(parseYamlSubset(yaml));
}

export const DEFAULT_POLICY_YAML = `# RIAF tool-call governance policy (versioned with the repo).
# Soft ceilings add a reflection prompt; hard ceilings block exploratory calls until a plan is written.
version: 1
phases:
  explore:   { soft_calls: 40, max_calls: 80, soft_tokens: 120000, max_tokens: 250000, max_minutes: 30 }
  plan:      { soft_calls: 15, max_calls: 40, soft_tokens: 60000, max_tokens: 120000, max_minutes: 15 }
  implement: { soft_calls: 80, max_calls: 200, soft_tokens: 250000, max_tokens: 500000, max_minutes: 90 }
  verify:    { soft_calls: 30, max_calls: 80, soft_tokens: 120000, max_tokens: 250000, max_minutes: 30 }
guard:
  serve_first_reads: false   # Claude Code's Edit needs a real Read first
  serve_repeat_reads: true
  cache_searches: true
  loop_threshold: 3
prefetch:
  enabled: true
  min_coupling: 0.6
  max_files: 4
`;

export const policyPath = (root: string): string => join(root, '.riaf', 'policy.yaml');

/** Load `.riaf/policy.yaml`; defaults when missing or malformed. */
export function loadPolicyFile(root: string): GovernorPolicy {
	try { return existsSync(policyPath(root)) ? parsePolicy(readFileSync(policyPath(root), 'utf8')) : DEFAULT_POLICY; } catch { return DEFAULT_POLICY; }
}

/** Write the default policy file if the repo has none. Returns its path. */
export function ensurePolicyFile(root: string): string {
	const p = policyPath(root);
	if (!existsSync(p)) { mkdirSync(join(root, '.riaf'), { recursive: true }); writeFileSync(p, DEFAULT_POLICY_YAML); }
	return p;
}
