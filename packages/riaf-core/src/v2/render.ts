/**
 * Pillar 2, step 6 — renderers. Same pack content, per-target layout. Stable sections (conventions,
 * architecture) come first so prompt caches hit across turns; volatile sections (items, history) last.
 */
import { rebudget } from './compiler.js';
import type { ContextPack, PackItem } from './packTypes.js';

export type RenderTarget = 'claude' | 'copilot' | 'markdown' | 'json' | 'openai' | 'gemini' | 'agents-md';
export const RENDER_TARGETS: RenderTarget[] = ['claude', 'copilot', 'markdown', 'json', 'openai', 'gemini', 'agents-md'];

const LANG: Record<string, string> = { ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', py: 'python', java: 'java', kt: 'kotlin', go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', json: 'json', yml: 'yaml', yaml: 'yaml', xml: 'xml', md: 'markdown', sh: 'bash', tf: 'hcl', toml: 'toml', gradle: 'groovy', sql: 'sql' };
const fence = (path: string, body: string) => {
	const ext = path.split('.').pop()?.toLowerCase() ?? '';
	const ticks = body.includes('```') ? '````' : '```';
	return `${ticks}${LANG[ext] ?? ''}\n${body}\n${ticks}`;
};
const header = (it: PackItem) => `${it.path}${it.range ? `:${it.range[0]}-${it.range[1]}` : ''}`;

export const PROTOCOL = [
	'Retrieval-before-tool protocol (RIAF):',
	'1. Files listed under "Already in context" are current — do not Read, Grep or list them again.',
	'2. Before any other file or search tool, call `riaf_lookup` (path, symbol or query); it answers from the index or tells you it is a miss.',
	'3. Prefer `riaf_expand` (file or symbol) over walking directories: it returns the structural neighbourhood in one call.',
	'4. After an edit, do not re-read the file to check it; the index reflects your write.',
	'5. When the budget reflection fires, write your plan with `riaf_compile` (stage: "plan") so sub-agents inherit it.',
].join('\n');

function stableBlock(p: ContextPack): string {
	const c = p.conventions; const a = p.architecture;
	return [
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
}

function taskBlock(p: ContextPack): string {
	const i = p.intent;
	return [
		`## Task (${i.type}, confidence ${i.confidence})`,
		i.request,
		i.constraints.length ? `\nConstraints:\n${i.constraints.map(c => `- ${c}`).join('\n')}` : '',
		i.acceptance.length ? `\nAcceptance:\n${i.acceptance.map(c => `- ${c}`).join('\n')}` : '',
		i.open_questions.length ? `\nOpen questions (ask before guessing):\n${i.open_questions.map(c => `- ${c}`).join('\n')}` : '',
	].filter(Boolean).join('\n');
}

function historyBlock(p: ContextPack): string {
	const h = p.history;
	const out: string[] = [];
	if (h.decisions.length) out.push('Decisions (do not reintroduce rejected approaches):', ...h.decisions.map(d => `- [${d.source} ${d.ref}] ${d.text}`));
	if (h.hotspots.length) out.push('Hot spots (change carefully):', ...h.hotspots.map(x => `- ${x.path}: ${x.commits365} commits/12 mo, fix ratio ${Math.round(x.fixRatio * 100)}%`));
	if (h.related_commits.length) out.push('Related commits:', ...h.related_commits.slice(0, 6).map(c => `- ${c.date} ${c.sha.slice(0, 8)} [${c.intent}] ${c.why}${c.tickets.length ? ` (${c.tickets.join(', ')})` : ''}`));
	if (h.owners.length) out.push('Owners:', ...h.owners.map(o => `- ${o.path}: ${o.name ?? o.role} (${Math.round(o.share * 100)}%)`));
	return out.length ? `## History\n${out.join('\n')}` : '';
}

function itemsBlock(p: ContextPack, showWhy: boolean): string {
	return ['## Context items', ...p.items.map(it => {
		const head = `### ${header(it)} — ${it.kind}${it.form && it.form !== 'body' ? ` (${it.form})` : ''}`;
		const why = showWhy ? `_why: ${it.why}_\n` : `<!-- why: ${it.why} -->\n`;
		const body = it.kind === 'history_card' || it.form === 'summary' && !/\n\d+: /.test(it.content) ? it.content : fence(it.path, it.content);
		return `${head}\n${why}${body}`;
	})].join('\n\n');
}

function knownBlock(p: ContextPack): string {
	const k = p.known_facts;
	const lines = [
		...k.files_read.map(f => `- ${f.path} (full)`),
		...k.ranges_read.map(r => `- ${r.path}:${r.range[0]}-${r.range[1]}`),
		...k.files_listed.map(d => `- ${d}/ (listing)`),
	];
	return lines.length ? `## Already in context\n${lines.join('\n')}` : '';
}

function planBlock(p: ContextPack): string {
	return [`## Plan skeleton\n${p.plan_skeleton.map((s, i) => `${i + 1}. ${s}`).join('\n')}`, `## Verification\n${p.verification.map(v => `- [ ] ${v}`).join('\n')}`].join('\n\n');
}

export function renderMarkdown(p: ContextPack, opts: { showWhy?: boolean; protocol?: boolean } = {}): string {
	return [
		`# RIAF Context Pack ${p.pack_id.slice(0, 8)} — ${p.repo.head?.slice(0, 8) ?? 'no-git'} — ${p.budget.used_tokens}/${p.budget.max_tokens} tokens`,
		stableBlock(p),
		opts.protocol ? `## Protocol\n${PROTOCOL}` : '',
		taskBlock(p),
		planBlock(p),
		historyBlock(p),
		knownBlock(p),
		itemsBlock(p, opts.showWhy ?? false),
	].filter(Boolean).join('\n\n');
}

export function render(pack: ContextPack, target: RenderTarget, opts: { budget?: number } = {}): string {
	const p: ContextPack = JSON.parse(JSON.stringify(pack));
	if (opts.budget && opts.budget < p.budget.used_tokens) rebudget(p, opts.budget);
	switch (target) {
		case 'json': return JSON.stringify(p, null, 2);
		case 'markdown': return renderMarkdown(p, { showWhy: true });
		case 'claude': return renderMarkdown(p, { protocol: true });
		case 'copilot': {
			// Copilot's context is smaller: prefer summaries/signatures, cap at 8 k tokens.
			if (p.budget.used_tokens > 8_000) rebudget(p, 8_000);
			return renderMarkdown(p, { protocol: false });
		}
		case 'agents-md': return [
			'# AGENTS.md (generated by RIAF — regenerate with `riaf pack --format agents-md`)',
			stableBlock(p),
			`## Working agreement\n${PROTOCOL}`,
			historyBlock(p),
		].filter(Boolean).join('\n\n');
		case 'openai': {
			const system = [stableBlock(p), `## Protocol\n${PROTOCOL}`].join('\n\n');
			const user = [taskBlock(p), planBlock(p), historyBlock(p), knownBlock(p), itemsBlock(p, false)].filter(Boolean).join('\n\n');
			return JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }, null, 2);
		}
		case 'gemini': {
			const system = [stableBlock(p), `## Protocol\n${PROTOCOL}`].join('\n\n');
			// Gemini guidance: put long context before the question.
			const user = [knownBlock(p), itemsBlock(p, false), historyBlock(p), planBlock(p), taskBlock(p)].filter(Boolean).join('\n\n');
			return JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }] }, null, 2);
		}
	}
}

/** CLAUDE.md fragment that points Claude Code at the current pack and states the protocol. */
export function claudeMdFragment(): string {
	return [
		'<!-- riaf:begin (managed by RIAF — edits inside this block are overwritten) -->',
		'## RIAF repository intelligence',
		'',
		'The RIAF MCP server indexes this repository. A compiled Context Pack for the current task is at',
		'`.claude/riaf/pack.md` and as the MCP resource `riaf://pack/current` (sub-agents: `riaf://pack/current?scope=<path/>`).',
		'',
		PROTOCOL,
		'<!-- riaf:end -->',
	].join('\n');
}

export function upsertClaudeMd(existing: string): string {
	const block = claudeMdFragment();
	const re = /<!-- riaf:begin[\s\S]*?<!-- riaf:end -->/;
	if (re.test(existing)) return existing.replace(re, block);
	return `${existing.replace(/\s*$/, '')}${existing.trim() ? '\n\n' : ''}${block}\n`;
}
