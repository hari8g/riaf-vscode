import React, { useEffect, useState } from 'react';
import { ago, api, type AdapterView } from '../api.js';
import { Btn, Chip, Empty, Field, Status, Switch, useToast } from '../kit.js';

type Audit = { at: number; consumer: string; adapter: string; tool: string; kind: string; ok: boolean; ms: number; approved?: string; error?: string };

function AdapterCard({ a, editable, onChange }: { a: AdapterView; editable: boolean; onChange: () => Promise<void> }) {
	const toast = useToast();
	const [settings, setSettings] = useState<Record<string, unknown>>(a.settings);
	const [enabled, setEnabled] = useState(a.enabled);
	const [creds, setCreds] = useState<Record<string, string>>({});
	const [health, setHealth] = useState<{ ok: boolean; message: string; latencyMs?: number } | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [open, setOpen] = useState(a.enabled);
	useEffect(() => { setSettings(a.settings); setEnabled(a.enabled); }, [a]);
	const dirty = enabled !== a.enabled || JSON.stringify(settings) !== JSON.stringify(a.settings);
	const save = async () => { setBusy('save'); try { await api.put('/adapter', { id: a.id, settings: { ...settings, enabled } }); toast(`${a.displayName} settings saved`); await onChange(); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(null); } };
	const saveCreds = async () => { setBusy('creds'); try { const r = await api.put<{ missing: string[] }>('/adapter/credentials', { id: a.id, values: creds }); setCreds({}); toast(r.missing.length ? `Saved; still missing ${r.missing.join(', ')}` : 'Credentials saved'); await onChange(); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(null); } };
	const test = async () => { setBusy('test'); setHealth(null); try { setHealth(await api.post('/adapter/health', { id: a.id })); } catch (e) { setHealth({ ok: false, message: (e as Error).message }); } finally { setBusy(null); } };
	const reads = a.tools.filter(t => t.kind === 'read'), writes = a.tools.filter(t => t.kind === 'write');
	const missing = a.credentials.filter(c => !c.present).length;
	return (
		<div className="panel">
			<div className="row" style={{ justifyContent: 'space-between' }}>
				<div className="row"><h2>{a.displayName}</h2><Switch on={enabled} onChange={v => { setEnabled(v); setOpen(true); }} label={enabled ? 'on' : 'off'} />{a.enabled && <Chip tone={missing ? 'ember' : 'moss'}>{missing ? `${missing} credential${missing > 1 ? 's' : ''} missing` : 'credentials present'}</Chip>}<Chip>{reads.length} read, {writes.length} write tools</Chip></div>
				<div className="row">{health && <Status ok={health.ok}>{health.message}{health.latencyMs ? ` (${health.latencyMs} ms)` : ''}</Status>}<Btn sm onClick={() => void test()} disabled={!!busy}>{busy === 'test' ? 'Testing…' : 'Test connection'}</Btn><Btn sm kind="ghost" onClick={() => setOpen(o => !o)}>{open ? 'Hide' : 'Configure'}</Btn></div>
			</div>
			{open && <div style={{ marginTop: 10 }}>
				{Object.entries(a.settingsSchema).filter(([k]) => k !== 'enabled').map(([k, sc]) => (
					<Field key={k} label={k} desc={sc.description}>
						{sc.type === 'boolean' ? <Switch on={!!(settings[k] ?? sc.default)} onChange={v => setSettings(s => ({ ...s, [k]: v }))} />
							: sc.type === 'enum' && sc.enum ? <select className="select" value={String(settings[k] ?? sc.default ?? sc.enum[0])} onChange={e => setSettings(s => ({ ...s, [k]: e.target.value }))}>{sc.enum.map(o => <option key={o} value={o}>{o}</option>)}</select>
								: <input className="input mono" value={String(settings[k] ?? sc.default ?? '')} onChange={e => setSettings(s => ({ ...s, [k]: sc.type === 'number' ? Number(e.target.value) : e.target.value }))} />}
					</Field>
				))}
				<div className="row" style={{ marginTop: 8 }}><Btn kind="primary" sm disabled={!dirty || !!busy} onClick={() => void save()}>Save settings</Btn>{dirty && <span className="small muted">Unsaved changes</span>}</div>
				<h3 style={{ marginTop: 16 }}>Credentials</h3>
				<p className="small muted">{editable ? 'Kept in the OS credential store (VS Code) or ~/.riaf/credentials.json with mode 0600. Never written into the repository, never shown again.' : 'Managed in VS Code with RIAF: Set Integration Credentials; this surface cannot change them.'}</p>
				{a.credentials.map(c => (
					<Field key={c.key} label={c.label} desc={c.hint}>
						<div className="row"><Status ok={c.present}>{c.present ? 'present' : 'missing'}</Status>{editable && <input className="input mono" type={c.secret ? 'password' : 'text'} style={{ flex: 1 }} value={creds[c.key] ?? ''} onChange={e => setCreds(s => ({ ...s, [c.key]: e.target.value }))} placeholder={c.present ? 'leave empty to keep' : `enter ${c.label.toLowerCase()}`} aria-label={c.label} />}</div>
					</Field>
				))}
				{editable && a.credentials.length > 0 && <div className="row" style={{ marginTop: 8 }}><Btn sm disabled={!Object.keys(creds).length || !!busy} onClick={() => void saveCreds()}>Save credentials</Btn></div>}
				<h3 style={{ marginTop: 16 }}>Tools the agents get</h3>
				<div className="row" style={{ marginTop: 6 }}><Chip tone="moss">read</Chip>{reads.map(t => <Chip key={t.name} mono title={t.description}>{t.name}</Chip>)}</div>
				{writes.length > 0 && <div className="row" style={{ marginTop: 6 }}><Chip tone="ember">write, asks first, audited</Chip>{writes.map(t => <Chip key={t.name} mono title={t.description}>{t.name}</Chip>)}</div>}
			</div>}
		</div>
	);
}

export function Adapters() {
	const [data, setData] = useState<{ adapters: AdapterView[]; credentialsEditable: boolean; audit: Audit[] } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const load = async () => { try { setData(await api.get('/adapters')); setError(null); } catch (e) { setError((e as Error).message); } };
	useEffect(() => { void load(); }, []);
	return (
		<>
			<h1>Adapters</h1>
			<p className="lead">Jira, Confluence, GitLab and knowledge stores, reachable by @riaf, Copilot and Claude Code through the same MCP server. Read tools ground the agent; write tools ask you first and are recorded.</p>
			{error && <Empty title="Adapters are not available on this surface">{error}</Empty>}
			{!data && !error && <div className="muted">Loading…</div>}
			<div className="stack">
				{data?.adapters.map(a => <AdapterCard key={a.id} a={a} editable={data.credentialsEditable} onChange={load} />)}
				{data && <div className="panel">
					<h2>Writes made through adapters</h2>
					<p className="small muted">From <code>.riaf/audit.jsonl</code>, every client included.</p>
					{!data.audit.length ? <p className="small muted" style={{ marginTop: 8 }}>None yet.</p> : <table className="data" style={{ marginTop: 8 }}><thead><tr><th>When</th><th>Client</th><th>Adapter</th><th>Tool</th><th>Result</th></tr></thead><tbody>
						{data.audit.map((e, i) => <tr key={i}><td>{ago(e.at)}</td><td>{e.consumer}</td><td>{e.adapter}</td><td className="mono">{e.tool}</td><td><Status ok={e.ok}>{e.ok ? `${e.ms} ms${e.approved ? `, approved by ${e.approved}` : ''}` : e.error ?? 'failed'}</Status></td></tr>)}
					</tbody></table>}
				</div>}
			</div>
		</>
	);
}
