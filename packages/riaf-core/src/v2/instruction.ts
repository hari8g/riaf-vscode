/**
 * Prompt Instruction — the one document a developer reviews and hands to Claude Code (or any agent).
 *
 * Assembled from things that already exist: the Context Pack (task, conventions, architecture, items,
 * history, plan skeleton, verification), the route (mode, budget, plan gate), project rules
 * (.riafrules / AGENTS.md / .riaf/rules), the governance policy budgets, the retrieval-before-tool
 * protocol, and — when the host ran an exploration lane — its findings. Layout is fixed and the stable
 * half comes first so prompt caches hit across turns.
 *
 * Saved under `.claude/riaf/instructions/<id>.md` with `current.md` + `current.json` beside it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IntentRoute } from './intentRouter.js';
import type { ContextPack } from './packTypes.js';
import { loadProjectRules } from './projectRules.js';
import { PROTOCOL, renderMarkdown } from './render.js';
import { estimateTokens } from './tokens.js';

export const INSTRUCTION_SCHEMA = 'riaf.instruction/v1';
export const INSTRUCTION_DIR = join('.claude', 'riaf', 'instructions');

/** Minimal shape of the governor policy the instruction prints (token-opt owns the full type). */
export interface PolicyBudgets { phases: Record<string, { soft_calls: number; max_calls: number; soft_tokens: number; max_tokens: number }> }

export interface PromptInstruction {
	schema: typeof INSTRUCTION_SCHEMA;
	instruction_id: string;
	pack_id: string;
	head: string | null;
	branch?: string;
	generated_at: string;
	request: string;
	intent: { type: string; confidence: number; source?: string; secondary?: string };
	route: { mode: string; tools: string; budget: number; stage: string; planGate: boolean };
	/** Plan steps (skeleton + evidence lines appended by the explore lane). */
	plan: string[];
	verification: string[];
	findings: string[];
	rules_sources: string[];
	tokens: number;
	/** Stable half (conventions, architecture, rules, protocol) — cacheable across tasks on the same HEAD. */
	stable_hash: string;
	markdown: string;
}

export interface BuildInstructionOptions {
	route?: IntentRoute;
	/** Repo root (for rules). Absent = no rules block. */
	root?: string;
	activeFile?: string;
	/** `.riafrules` text when the host already read it (VS Code); otherwise read from disk when `root` is set. */
	riafRules?: string;
	policy?: PolicyBudgets;
	/** Evidence from the explore lane: "step-index: path:line — note" or free lines. */
	findings?: string[];
	/** Extra lines appended to the plan (developer edits). */
	planOverride?: string[];
	protocol?: boolean;
	/** Which MCP host the instruction is for; changes only the wording of the tool hints. */
	host?: 'claude' | 'copilot' | 'generic';
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

function readRiafRules(root: string): string {
	try { return readFileSync(join(root, '.riafrules'), 'utf8').trim(); } catch { return ''; }
}

export function stableSection(pack: ContextPack, rules: { text: string; sources: string[] }, protocol: boolean): string {
	const c = pack.conventions, a = pack.architecture;
	const conv = [
		'## Repository conventions',
		`- Languages: ${c.languages.join(', ') || 'unknown'}${c.frameworks.length ? `; frameworks: ${c.frameworks.join(', ')}` : ''}`,
		c.build ? `- Build: \`${c.build}\`` : '', c.test_cmd ? `- Test: \`${c.test_cmd}\`` : '', c.lint ? `- Lint: \`${c.lint}\`` : '', c.typecheck ? `- Typecheck: \`${c.typecheck}\`` : '',
		...c.style_notes.map(s => `- ${s}`),
		'',
		'## Architecture',
		a.summary,
		a.monorepo ? `- Monorepo: ${a.monorepo}` : '',
		a.packages.length ? `- Packages: ${a.packages.slice(0, 15).map(x => `${x.name} (${x.path})`).join(', ')}` : '',
		a.entry_points.length ? `- Entry points: ${a.entry_points.slice(0, 8).join(', ')}` : '',
	].filter(l => l !== '').join('\n');
	const rulesBlock = rules.text ? `## Project rules (${rules.sources.join(', ')})\n${rules.text}` : '';
	const proto = protocol ? `## Protocol\n${PROTOCOL}` : '';
	return [conv, rulesBlock, proto].filter(Boolean).join('\n\n');
}

export function buildInstruction(pack: ContextPack, opts: BuildInstructionOptions = {}): PromptInstruction {
	const route = opts.route;
	const rulesFromFiles = opts.root ? loadProjectRules(opts.root, opts.activeFile) : { text: '', sources: [] as string[] };
	const riaf = opts.riafRules ?? (opts.root ? readRiafRules(opts.root) : '');
	const rules = {
		text: [riaf ? `### .riafrules\n${riaf}` : '', rulesFromFiles.text].filter(Boolean).join('\n\n'),
		sources: [...(riaf ? ['.riafrules'] : []), ...rulesFromFiles.sources],
	};
	const stable = stableSection(pack, rules, opts.protocol ?? true);

	const i = pack.intent;
	const task = [
		`## Task (${i.type}${route?.secondaryType ? ` + ${route.secondaryType}` : ''}, confidence ${route?.confidence ?? i.confidence}${route ? `, ${route.source}` : ''})`,
		i.request,
		route ? `\nRoute: mode **${route.mode}**, tools **${route.tools}**, pack budget ${route.budget} tokens, stage ${route.stage}${route.planGate ? ', **plan gate: show the plan and wait for approval before any edit**' : ''}.` : '',
		i.constraints.length ? `\nConstraints:\n${i.constraints.map(c => `- ${c}`).join('\n')}` : '',
		i.acceptance.length ? `\nAcceptance:\n${i.acceptance.map(c => `- ${c}`).join('\n')}` : '',
		i.open_questions.length ? `\nOpen questions (ask before guessing):\n${i.open_questions.map(c => `- ${c}`).join('\n')}` : '',
	].filter(Boolean).join('\n');

	const plan = opts.planOverride?.length ? opts.planOverride : [...pack.plan_skeleton];
	const findings = (opts.findings ?? []).map(f => f.trim()).filter(Boolean);
	// Findings prefixed "N:" attach to plan step N as evidence; the rest form their own block.
	const perStep = new Map<number, string[]>();
	const loose: string[] = [];
	for (const f of findings) {
		const m = f.match(/^(\d+)\s*[:.)-]\s*(.+)$/);
		if (m && Number(m[1]) >= 1 && Number(m[1]) <= plan.length) { const k = Number(m[1]); perStep.set(k, [...(perStep.get(k) ?? []), m[2]]); } else loose.push(f);
	}
	const planBlock = [
		'## Plan',
		...plan.map((s, idx) => [`${idx + 1}. ${s}`, ...(perStep.get(idx + 1) ?? []).map(e => `    - evidence: ${e}`)].join('\n')),
		loose.length ? `\nFindings from exploration:\n${loose.map(l => `- ${l}`).join('\n')}` : '',
	].filter(Boolean).join('\n');

	const verification = [...pack.verification];
	const verifyBlock = `## Verification\n${verification.map(v => `- [ ] ${v}`).join('\n')}`;

	const policyBlock = opts.policy
		? ['## Budgets (from .riaf/policy.yaml)', '| Phase | Soft calls | Max calls | Soft tokens | Max tokens |', '| --- | --- | --- | --- | --- |',
			...Object.entries(opts.policy.phases).map(([p, b]) => `| ${p} | ${b.soft_calls} | ${b.max_calls} | ${b.soft_tokens} | ${b.max_tokens} |`),
			'When a soft ceiling fires, write the plan with `riaf_compile stage="plan"`; at a hard ceiling stop exploring and act.'].join('\n')
		: '';

	// Volatile half: items, history, known facts — rendered by the pack renderer so the item format is identical everywhere.
	const packMd = renderMarkdown(pack, { showWhy: false, protocol: false });
	const volatile = packMd.split('\n## History')[1] ? `## History${packMd.split('\n## History')[1]}` : packMd.split('\n## Already in context')[1] ? `## Already in context${packMd.split('\n## Already in context')[1]}` : packMd.split('\n## Context items')[1] ? `## Context items${packMd.split('\n## Context items')[1]}` : '';

	const id = randomUUID().slice(0, 8);
	const hostLine = opts.host === 'copilot' ? 'Use the #riaf, #riafContext and #riafSymbols tools before reading files.' : opts.host === 'generic' ? 'Use the RIAF MCP tools (riaf_lookup, riaf_expand, riaf_search) before reading files.' : 'Use the riaf MCP tools (`riaf_lookup`, `riaf_expand`, `riaf_history`) before Read/Grep/Glob; the governance hooks enforce this.';
	const header = `# RIAF Prompt Instruction ${id} — pack ${pack.pack_id.slice(0, 8)} — ${pack.repo.head?.slice(0, 8) ?? 'no-git'}${pack.repo.branch ? ` (${pack.repo.branch})` : ''}\n${hostLine}`;
	const markdown = [header, stable, task, planBlock, verifyBlock, policyBlock, volatile].filter(Boolean).join('\n\n');

	return {
		schema: INSTRUCTION_SCHEMA,
		instruction_id: id,
		pack_id: pack.pack_id,
		head: pack.repo.head,
		branch: pack.repo.branch,
		generated_at: new Date().toISOString(),
		request: i.request,
		intent: { type: i.type, confidence: route?.confidence ?? i.confidence, source: route?.source, secondary: route?.secondaryType },
		route: route ? { mode: route.mode, tools: route.tools, budget: route.budget, stage: route.stage, planGate: route.planGate } : { mode: 'agent', tools: 'full', budget: pack.budget.max_tokens, stage: 'plan', planGate: false },
		plan, verification, findings,
		rules_sources: rules.sources,
		tokens: estimateTokens(markdown),
		stable_hash: hash(stable),
		markdown,
	};
}

export interface SavedInstruction { id: string; path: string; currentPath: string; jsonPath: string }

export function instructionDir(root: string): string { return join(root, INSTRUCTION_DIR); }

export function saveInstruction(root: string, instr: PromptInstruction): SavedInstruction {
	const dir = instructionDir(root);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${instr.instruction_id}.md`);
	writeFileSync(path, instr.markdown);
	const currentPath = join(dir, 'current.md');
	writeFileSync(currentPath, instr.markdown);
	const jsonPath = join(dir, 'current.json');
	const { markdown: _md, ...meta } = instr;
	writeFileSync(jsonPath, JSON.stringify({ ...meta, path: `${instr.instruction_id}.md` }, null, 2) + '\n');
	return { id: instr.instruction_id, path, currentPath, jsonPath };
}

export function loadCurrentInstruction(root: string): PromptInstruction | null {
	const dir = instructionDir(root);
	const jsonPath = join(dir, 'current.json');
	if (!existsSync(jsonPath)) return null;
	try {
		const meta = JSON.parse(readFileSync(jsonPath, 'utf8')) as Omit<PromptInstruction, 'markdown'> & { path: string };
		const markdown = readFileSync(join(dir, 'current.md'), 'utf8');
		const { path: _p, ...rest } = meta;
		return { ...rest, markdown };
	} catch { return null; }
}

/** Past instructions (newest first) from the directory: id, generated_at, intent, request — read from each file's header. */
export function listInstructions(root: string, limit = 50): { id: string; generated_at: number; request?: string; type?: string }[] {
	const dir = instructionDir(root);
	if (!existsSync(dir)) return [];
	const out: { id: string; generated_at: number; request?: string; type?: string }[] = [];
	for (const f of readdirSync(dir)) {
		if (!/^[0-9a-f]{8}\.md$/.test(f)) continue;
		try {
			const text = readFileSync(join(dir, f), 'utf8');
			const m = text.match(/^## Task \(([a-z]+)[^\n]*\n([^\n]*)/m);
			out.push({ id: f.slice(0, 8), generated_at: statSync(join(dir, f)).mtimeMs, type: m?.[1], request: m?.[2]?.slice(0, 160) });
		} catch { /* skip */ }
	}
	return out.sort((a, b) => b.generated_at - a.generated_at).slice(0, limit);
}

/** `<!-- riaf:instruction -->` managed block for CLAUDE.md: the stable half only (cached across sessions). */
export function claudeMdInstructionBlock(instr: PromptInstruction | null): string {
	const body = instr
		? [`Current RIAF instruction: \`${instr.instruction_id}\` (${instr.intent.type}, ${instr.generated_at.slice(0, 10)}) — full text at \`.claude/riaf/instructions/current.md\`, also \`riaf://instruction/current\`.`,
			`Run \`/riaf-instruction\` to load it, or \`/riaf-task <text>\` to compile a new one.`,
			'', instr.markdown.split('\n## Task')[0].split('\n').slice(2).join('\n').trim()].join('\n')
		: 'No RIAF instruction compiled yet. Run `/riaf-task <what you want done>` to compile one.';
	return ['<!-- riaf:instruction:begin (managed by RIAF — regenerated on every Send to Claude Code) -->', '## RIAF current instruction', '', body, '<!-- riaf:instruction:end -->'].join('\n');
}

export function upsertClaudeMdInstruction(existing: string, instr: PromptInstruction | null): string {
	const block = claudeMdInstructionBlock(instr);
	const re = /<!-- riaf:instruction:begin[\s\S]*?<!-- riaf:instruction:end -->/;
	if (re.test(existing)) return existing.replace(re, block);
	return `${existing.replace(/\s*$/, '')}${existing.trim() ? '\n\n' : ''}${block}\n`;
}


/**
 * A prompt that already IS a compiled RIAF brief (pasted or sent with `claude "$(cat current.md)"`): its id and the request it carries.
 * Hooks use this to avoid compiling a brief of a brief, and reports to show the real task instead of the boilerplate.
 */
export function extractBriefRequest(text: string): { id: string; request: string; intent?: string } | null {
	const head = /^\s*#\s*RIAF Prompt Instruction\s+([0-9a-f]{6,16})\b/i.exec(text);
	if (!head) return null;
	const task = /^##\s*Task\s*\(([a-z]+)[^)\n]*\)[^\n]*\n([\s\S]*?)(?=\n\s*\n(?:Route:|Constraints:|Acceptance:|Open questions)|\n##\s|(?![\s\S]))/m.exec(text);
	const request = (task?.[2] ?? '').replace(/\s+/g, ' ').trim();
	return { id: head[1], request: request || `RIAF brief ${head[1]}`, ...(task?.[1] ? { intent: task[1] } : {}) };
}
