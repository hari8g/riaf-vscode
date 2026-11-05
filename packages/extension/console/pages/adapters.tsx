import React, { useEffect, useState } from 'react';
import { Badge, Button, Note, Row, Section, Select, TextInput, Toggle } from '../../webview/ui.js';
import { ago, api, type AdapterView } from '../api.js';

type Audit = { at: number; consumer: string; adapter: string; tool: string; kind: string; ok: boolean; ms: number; approved?: string; error?: string };

function AdapterCard({ a, editable, onChange }: { a: AdapterView; editable: boolean; onChange: () => Promise<void> }) {
	const [settings, setSettings] = useState<Record<string, unknown>>(a.settings);
	const [enabled, setEnabled] = useState(a.enabled);
	const [creds, setCreds] = useState<Record<string, string>>({});
	const [health, setHealth] = useState<{ ok: boolean; message: string; latencyMs?: number } | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [msg, setMsg] = useState<string | null>(null);
	useEffect(() => { setSettings(a.settings); setEnabled(a.enabled); }, [a]);
	const dirty = enabled !== a.enabled || JSON.stringify(settings) !== JSON.stringify(a.settings);
	const save = async () => { setBusy('save'); try { await api.put('/adapter', { id: a.id, settings: { ...settings, enabled } }); setMsg('saved'); await onChange(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(null); } };
	const saveCreds = async () => { setBusy('creds'); try { const r = await api.put<{ missing: string[] }>('/adapter/credentials', { id: a.id, values: creds }); setCreds({}); setMsg(r.missing.length ? `saved; still missing: ${r.missing.join(', ')}` : 'credentials saved'); await onChange(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(null); } };
	const test = async () => { setBusy('test'); setHealth(null); try { setHealth(await api.post('/adapter/health', { id: a.id })); } catch (e) { setHealth({ ok: false, message: (e as Error).message }); } finally { setBusy(null); } };
	const reads = a.tools.filter(t => t.kind === 'read'), writes = a.tools.filter(t => t.kind === 'write');
	return (
		<div className="panel stack">
			<div className="rowflex">
				<div style={{ fontWeight: 600, fontSize: 14 }}>{a.displayName}</div>
				<span className="chip">{a.id}</span>
				<Toggle value={enabled} onChange={setEnabled} label={enabled ? 'enabled' : 'disabled'} />
				<span style={{ flex: 1 }} />
				<Button small onClick={() => void test()} disabled={!!busy}>{busy === 'test' ? 'Testing…' : 'Test connection'}</Button>
				{health && <Badge ok={health.ok} text={`${health.message}${health.latencyMs ? ` (${health.latencyMs} ms)` : ''}`} />}
			</div>
			{Object.entries(a.settingsSchema).filter(([k]) => k !== 'enabled').map(([k, sc]) => (
				<Row key={k} label={k} desc={sc.description}>
					{sc.type === 'boolean' ? <Toggle value={!!(settings[k] ?? sc.default)} onChange={v => setSettings(s => ({ ...s, [k]: v }))} />
						: sc.type === 'enum' && sc.enum ? <Select value={String(settings[k] ?? sc.default ?? sc.enum[0])} onChange={v => setSettings(s => ({ ...s, [k]: v }))} options={sc.enum.map(e => ({ value: e, label: e }))} />
							: <TextInput mono value={String(settings[k] ?? sc.default ?? '')} onChange={v => setSettings(s => ({ ...s, [k]: sc.type === 'number' ? Number(v) : v }))} />}
				</Row>
			))}
			<div className="rowflex"><Button small kind="primary" disabled={!dirty || !!busy} onClick={() => void save()}>Save settings</Button>{msg && <span className="muted" style={{ fontSize: 11 }}>{msg}</span>}</div>
			<div style={{ fontWeight: 600, marginTop: 4 }}>Credentials <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>{editable ? '— stored in the OS credential store / ~/.riaf/credentials.json (0600), never shown again, never in the repo' : '— managed in VS Code: RIAF: Set Integration Credentials'}</span></div>
			{a.credentials.map(c => (
				<Row key={c.key} label={c.label} desc={c.hint}>
					<div className="rowflex">
						<Badge ok={c.present} text={c.present ? 'present' : 'missing'} />
						{editable && <div style={{ flex: 1 }}><TextInput type={c.secret ? 'password' : 'text'} mono value={creds[c.key] ?? ''} onChange={v => setCreds(s => ({ ...s, [c.key]: v }))} placeholder={c.present ? '(unchanged)' : `enter ${c.label}`} /></div>}
					</div>
				</Row>
			))}
			{editable && a.credentials.length > 0 && <div><Button small disabled={!Object.keys(creds).length || !!busy} onClick={() => void saveCreds()}>Save credentials</Button></div>}
			<div style={{ fontWeight: 600, marginTop: 4 }}>Tools</div>
			<div style={{ fontSize: 12 }}>
				<div><span className="chip test">read</span>{reads.map(t => <span key={t.name} className="chip" title={t.description}>{t.name}</span>)}</div>
				{writes.length > 0 && <div style={{ marginTop: 4 }}><span className="chip hot">write · approval + audit</span>{writes.map(t => <span key={t.name} className="chip" title={t.description}>{t.name}</span>)}</div>}
			</div>
		</div>
	);
}

export function Adapters() {
	const [data, setData] = useState<{ adapters: AdapterView[]; credentialsEditable: boolean; audit: Audit[] } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const load = async () => { try { setData(await api.get('/adapters')); setError(null); } catch (e) { setError((e as Error).message); } };
	useEffect(() => { void load(); }, []);
	return (
		<Section id="adapters" title="Adapters" desc="Enterprise integrations the agent, Copilot and Claude Code can use through the same MCP server: Jira, Confluence, GitLab and knowledge stores. Read tools ground the agent; write tools are gated and audited.">
			{error && <Note kind="warn">{error.includes('501') || /not available/.test(error) ? 'Integrations are not available on this surface.' : error}</Note>}
			{!data && !error && <div className="muted">Loading…</div>}
			{data?.adapters.map(a => <AdapterCard key={a.id} a={a} editable={data.credentialsEditable} onChange={load} />)}
			{data && (
				<div className="panel stack">
					<div style={{ fontWeight: 600 }}>Audit log <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>.riaf/audit.jsonl — every write tool call, from any client</span></div>
					{!data.audit.length && <div className="muted">No write calls recorded yet.</div>}
					{data.audit.length > 0 && <table><thead><tr><th>when</th><th>client</th><th>adapter</th><th>tool</th><th>result</th></tr></thead><tbody>
						{data.audit.map((e, i) => <tr key={i}><td>{ago(e.at)}</td><td>{e.consumer}</td><td>{e.adapter}</td><td className="mono">{e.tool}</td><td><Badge ok={e.ok} text={e.ok ? `${e.ms} ms${e.approved ? ` · ${e.approved}` : ''}` : e.error ?? 'failed'} /></td></tr>)}
					</tbody></table>}
				</div>
			)}
		</Section>
	);
}
