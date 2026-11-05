import React, { useEffect, useState } from 'react';
import { api, type Status as S } from '../api.js';
import { Btn, Chip, Status, useToast } from '../kit.js';

type Phase = { soft_calls: number; max_calls: number; soft_tokens: number; max_tokens: number; max_minutes: number };
type Policy = { yaml: string; exists: boolean; parsed: { phases: Record<string, Phase>; guard?: Record<string, unknown>; prefetch?: Record<string, unknown> } };
type Rules = { riafrules: string; files: { path: string; text: string }[] };
type Hooks = { claude: Record<string, { matcher?: string; hooks?: { command: string }[] }[]>; riaf: Record<string, unknown>; governHookPresent: boolean };

/** Phase budgets as draggable numbers: edit the table, the YAML is regenerated; or edit the YAML directly. */
function phasesToYaml(phases: Record<string, Phase>, original: string): string {
	let out = original;
	for (const [p, b] of Object.entries(phases)) {
		const line = `  ${p}:${' '.repeat(Math.max(1, 10 - p.length))}{ soft_calls: ${b.soft_calls}, max_calls: ${b.max_calls}, soft_tokens: ${b.soft_tokens}, max_tokens: ${b.max_tokens}, max_minutes: ${b.max_minutes} }`;
		const re = new RegExp(`^\\s{2}${p}:.*$`, 'm');
		out = re.test(out) ? out.replace(re, line) : out.replace(/^phases:\s*$/m, `phases:\n${line}`);
	}
	return out;
}

export function Governance({ status, refresh }: { status: S | null; refresh: () => Promise<void> }) {
	const toast = useToast();
	const [policy, setPolicy] = useState<Policy | null>(null);
	const [phases, setPhases] = useState<Record<string, Phase>>({});
	const [yaml, setYaml] = useState('');
	const [rawMode, setRawMode] = useState(false);
	const [rules, setRules] = useState<Rules | null>(null);
	const [riafrules, setRiafrules] = useState('');
	const [hooks, setHooks] = useState<Hooks | null>(null);
	const [editing, setEditing] = useState<{ path: string; text: string } | null>(null);

	const load = async () => {
		try {
			const [p, r, h] = await Promise.all([api.get<Policy>('/policy'), api.get<Rules>('/rules'), api.get<Hooks>('/hooks')]);
			setPolicy(p); setPhases(p.parsed.phases); setYaml(p.yaml); setRules(r); setRiafrules(r.riafrules); setHooks(h);
		} catch (e) { toast((e as Error).message, 'err'); }
	};
	useEffect(() => { void load(); }, []);
	const effectiveYaml = rawMode ? yaml : (policy ? phasesToYaml(phases, policy.yaml) : yaml);
	const policyDirty = !!policy && effectiveYaml !== policy.yaml;
	const savePolicy = async () => { try { await api.put('/policy', { yaml: effectiveYaml }); toast('Policy saved; the governor reloaded it'); await load(); await refresh(); } catch (e) { toast((e as Error).message, 'err'); } };
	const saveRules = async (path: string, text: string) => { try { await api.put('/rules', { path, text }); toast(`${path} saved`); setEditing(null); await load(); } catch (e) { toast((e as Error).message, 'err'); } };
	const setPhase = (p: string, k: keyof Phase, v: number) => setPhases(ph => ({ ...ph, [p]: { ...ph[p], [k]: v } }));
	const num = (p: string, k: keyof Phase, step: number) => <input className="input mono" type="number" step={step} min={0} value={phases[p]?.[k] ?? 0} onChange={e => setPhase(p, k, Number(e.target.value))} style={{ width: 96, padding: '3px 6px' }} aria-label={`${p} ${k}`} />;

	return (
		<>
			<h1>Governance</h1>
			<p className="lead">How much exploring an agent may do before it must plan, and the rules every agent reads first. These are the repository's own files, so commit them for the team.</p>
			<div className="grid2" style={{ gridTemplateColumns: '1.25fr 1fr' }}>
				<div className="panel stack">
					<div className="row" style={{ justifyContent: 'space-between' }}><div><h2>Budgets per phase</h2><div className="small muted">{policy?.exists ? '.riaf/policy.yaml' : 'Defaults; saving creates .riaf/policy.yaml'}. Soft ceiling asks the agent to write its plan; hard ceiling blocks exploring until it has one.</div></div><Btn sm kind="ghost" onClick={() => setRawMode(r => !r)}>{rawMode ? 'Table' : 'Edit YAML'}</Btn></div>
					{!rawMode ? <table className="data"><thead><tr><th>Phase</th><th>Soft calls</th><th>Max calls</th><th>Soft tokens</th><th>Max tokens</th><th>Minutes</th></tr></thead><tbody>
						{Object.keys(phases).map(p => <tr key={p}><td><Chip tone="teal">{p}</Chip></td><td>{num(p, 'soft_calls', 5)}</td><td>{num(p, 'max_calls', 5)}</td><td>{num(p, 'soft_tokens', 10000)}</td><td>{num(p, 'max_tokens', 10000)}</td><td>{num(p, 'max_minutes', 5)}</td></tr>)}
					</tbody></table> : <textarea className="textarea mono" rows={16} value={yaml} onChange={e => setYaml(e.target.value)} />}
					<div className="small muted">Guard: {policy?.parsed.guard ? Object.entries(policy.parsed.guard).map(([k, v]) => `${k} ${String(v)}`).join(', ') : 'defaults'}. Prefetch: {policy?.parsed.prefetch ? Object.entries(policy.parsed.prefetch).map(([k, v]) => `${k} ${String(v)}`).join(', ') : 'defaults'}. Switch to YAML to change these.</div>
					<div className="row"><Btn kind="primary" sm disabled={!policyDirty} onClick={() => void savePolicy()}>Save policy</Btn>{policyDirty && <Btn sm kind="ghost" onClick={() => { if (policy) { setPhases(policy.parsed.phases); setYaml(policy.yaml); } }}>Discard</Btn>}</div>
				</div>
				<div className="stack">
					<div className="panel stack">
						<div><h2>Repository rules</h2><div className="small muted"><code>.riafrules</code> goes into every prompt and every brief, ahead of everything else.</div></div>
						<textarea className="textarea mono" rows={7} value={riafrules} onChange={e => setRiafrules(e.target.value)} placeholder={'- Use the shared logger (src/lib/log.ts); never console.log.\n- Tests live beside the source as *.test.ts.'} />
						<div className="row"><Btn kind="primary" sm disabled={!rules || riafrules === rules.riafrules} onClick={() => void saveRules('.riafrules', riafrules)}>Save rules</Btn></div>
					</div>
					<div className="panel stack">
						<h2>Rule files</h2>
						{!rules?.files.length && <div className="small muted">No AGENTS.md or .riaf/rules/*.md yet. <a href="#" onClick={e => { e.preventDefault(); setEditing({ path: '.riaf/rules/10-conventions.md', text: '' }); }}>Create .riaf/rules/10-conventions.md</a></div>}
						{rules?.files.map(f => <div key={f.path} className="row"><code>{f.path}</code><span className="tiny muted">{f.text.length} characters</span><a href="#" onClick={e => { e.preventDefault(); setEditing({ path: f.path, text: f.text }); }}>Edit</a></div>)}
						{editing && <div className="stack"><div className="small"><code>{editing.path}</code></div><textarea className="textarea mono" rows={9} value={editing.text} onChange={e => setEditing({ ...editing, text: e.target.value })} /><div className="row"><Btn sm kind="primary" onClick={() => void saveRules(editing.path, editing.text)}>Save file</Btn><Btn sm kind="ghost" onClick={() => setEditing(null)}>Cancel</Btn></div></div>}
					</div>
					<div className="panel stack">
						<h2>Hooks installed for Claude Code</h2>
						<Status ok={!!hooks?.governHookPresent}>{hooks?.governHookPresent ? 'riaf-govern.mjs answers PreToolUse, PostToolUse, SessionStart and UserPromptSubmit' : 'Governance hook not installed; run Set up Claude Code'}</Status>
						{hooks && Object.entries(hooks.claude).map(([ev, groups]) => <div key={ev} className="small"><Chip tone="teal">{ev}</Chip> {groups.flatMap(g => (g.hooks ?? []).map(h => <code key={h.command} style={{ marginRight: 8 }}>{g.matcher ? `[${g.matcher}] ` : ''}{h.command.replace(/^node "?.*[\\/]/, 'node …/')}</code>))}</div>)}
						{hooks && Object.keys(hooks.riaf).length > 0 && <div className="small"><Chip>.riaf/hooks.json</Chip> {Object.keys(hooks.riaf).join(', ')}</div>}
						<div className="tiny muted">Phases the governor knows: {status?.governance.policyPhases.join(', ')}</div>
					</div>
				</div>
			</div>
		</>
	);
}
