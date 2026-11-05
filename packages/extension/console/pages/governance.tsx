import React, { useEffect, useState } from 'react';
import { Badge, Button, Note, Section, TextArea } from '../../webview/ui.js';
import { api, type Status } from '../api.js';

type Phase = { soft_calls: number; max_calls: number; soft_tokens: number; max_tokens: number; max_minutes: number };
type Policy = { yaml: string; exists: boolean; parsed: { phases: Record<string, Phase>; guard?: Record<string, unknown>; prefetch?: Record<string, unknown> } };
type Rules = { riafrules: string; files: { path: string; text: string }[] };
type Hooks = { claude: Record<string, { matcher?: string; hooks?: { command: string }[] }[]>; riaf: Record<string, unknown>; governHookPresent: boolean };

export function Governance({ status, refresh }: { status: Status | null; refresh: () => Promise<void> }) {
	const [policy, setPolicy] = useState<Policy | null>(null);
	const [yaml, setYaml] = useState('');
	const [rules, setRules] = useState<Rules | null>(null);
	const [riafrules, setRiafrules] = useState('');
	const [hooks, setHooks] = useState<Hooks | null>(null);
	const [msg, setMsg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState<{ path: string; text: string } | null>(null);

	const load = async () => {
		try {
			const [p, r, h] = await Promise.all([api.get<Policy>('/policy'), api.get<Rules>('/rules'), api.get<Hooks>('/hooks')]);
			setPolicy(p); setYaml(p.yaml); setRules(r); setRiafrules(r.riafrules); setHooks(h); setError(null);
		} catch (e) { setError((e as Error).message); }
	};
	useEffect(() => { void load(); }, []);
	const savePolicy = async () => { try { await api.put('/policy', { yaml }); setMsg('policy saved and reloaded by the governor'); await load(); await refresh(); } catch (e) { setError((e as Error).message); } };
	const saveRules = async (path: string, text: string) => { try { await api.put('/rules', { path, text }); setMsg(`${path} saved`); setEditing(null); await load(); } catch (e) { setError((e as Error).message); } };

	const phases = policy ? Object.entries(policy.parsed.phases) : [];
	return (
		<Section id="governance" title="Governance" desc="Budgets per phase (.riaf/policy.yaml), the rules every agent sees (.riafrules, AGENTS.md, .riaf/rules/*.md) and the hooks installed for Claude Code. Edits here are the same files the extension reads — commit them for the team.">
			{error && <Note kind="warn">{error}</Note>}
			{msg && <Note>{msg}</Note>}
			<div className="grid2">
				<div className="panel stack">
					<div style={{ fontWeight: 600 }}>Tool-call budgets <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>{policy?.exists ? '.riaf/policy.yaml' : 'defaults (no policy file yet — saving creates it)'}</span></div>
					{phases.length > 0 && <table><thead><tr><th>phase</th><th>soft calls</th><th>max calls</th><th>soft tokens</th><th>max tokens</th><th>minutes</th></tr></thead><tbody>
						{phases.map(([p, b]) => <tr key={p}><td>{p}</td><td>{b.soft_calls}</td><td>{b.max_calls}</td><td>{b.soft_tokens.toLocaleString()}</td><td>{b.max_tokens.toLocaleString()}</td><td>{b.max_minutes}</td></tr>)}
					</tbody></table>}
					<div className="muted" style={{ fontSize: 11 }}>Soft ceiling → a reflection prompt asks the agent to write its plan; hard ceiling → exploratory calls are blocked until a plan exists. Guard: {policy?.parsed.guard ? Object.entries(policy.parsed.guard).map(([k, v]) => `${k}=${String(v)}`).join(', ') : '—'}. Prefetch: {policy?.parsed.prefetch ? Object.entries(policy.parsed.prefetch).map(([k, v]) => `${k}=${String(v)}`).join(', ') : '—'}.</div>
					<TextArea mono rows={16} value={yaml} onChange={setYaml} />
					<div className="rowflex"><Button kind="primary" small disabled={!policy || yaml === policy.yaml} onClick={() => void savePolicy()}>Save policy.yaml</Button><Button small onClick={() => setYaml(policy?.yaml ?? '')}>Revert</Button></div>
				</div>
				<div className="stack">
					<div className="panel stack">
						<div style={{ fontWeight: 600 }}>.riafrules <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>whole-repo rules, highest priority, in every prompt and every instruction</span></div>
						<TextArea mono rows={8} value={riafrules} onChange={setRiafrules} placeholder={'- Use the shared logger (src/lib/log.ts); never console.log.\n- Tests live beside the source as *.test.ts.'} />
						<div className="rowflex"><Button kind="primary" small disabled={!rules || riafrules === rules.riafrules} onClick={() => void saveRules('.riafrules', riafrules)}>Save .riafrules</Button></div>
					</div>
					<div className="panel stack">
						<div style={{ fontWeight: 600 }}>Rule files</div>
						{!rules?.files.length && <div className="muted">No AGENTS.md or .riaf/rules/*.md yet. <a href="#" onClick={e => { e.preventDefault(); setEditing({ path: '.riaf/rules/10-conventions.md', text: '' }); }}>Create .riaf/rules/10-conventions.md</a></div>}
						{rules?.files.map(f => <div key={f.path} className="rowflex"><code>{f.path}</code><span className="muted" style={{ fontSize: 11 }}>{f.text.length} chars</span><a href="#" onClick={e => { e.preventDefault(); setEditing({ path: f.path, text: f.text }); }}>edit</a></div>)}
						{editing && <div className="stack"><div className="muted" style={{ fontSize: 11 }}>{editing.path}</div><TextArea mono rows={10} value={editing.text} onChange={t => setEditing({ ...editing, text: t })} /><div className="rowflex"><Button small kind="primary" onClick={() => void saveRules(editing.path, editing.text)}>Save</Button><Button small onClick={() => setEditing(null)}>Cancel</Button></div></div>}
					</div>
					<div className="panel stack">
						<div style={{ fontWeight: 600 }}>Claude Code hooks <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>.claude/settings.json</span></div>
						<Badge ok={!!hooks?.governHookPresent} text={hooks?.governHookPresent ? 'riaf-govern.mjs present (PreToolUse/PostToolUse/SessionStart/UserPromptSubmit)' : 'governance hook not installed — run Set up Claude Code'} />
						{hooks && Object.entries(hooks.claude).map(([ev, groups]) => <div key={ev} style={{ fontSize: 12 }}><span className="chip accent">{ev}</span>{groups.flatMap(g => (g.hooks ?? []).map(h => <code key={h.command} style={{ marginRight: 8 }}>{g.matcher ? `[${g.matcher}] ` : ''}{h.command.replace(/^node "?.*[\\/]/, 'node …/')}</code>))}</div>)}
						{hooks && Object.keys(hooks.riaf).length > 0 && <div style={{ fontSize: 12 }}><span className="chip">.riaf/hooks.json</span> {Object.keys(hooks.riaf).join(', ')}</div>}
						<div className="muted" style={{ fontSize: 11 }}>Policy phases known to the governor: {status?.governance.policyPhases.join(', ')}</div>
					</div>
				</div>
			</div>
		</Section>
	);
}
