import React, { useEffect, useState } from 'react';
import { Button, Note, Section, StatCard } from '../../webview/ui.js';
import { ago, api, fmtK, type SessionEvent, type SessionRow } from '../api.js';

const n = (v: unknown) => Number(v) || 0;

export function Sessions() {
	const [rows, setRows] = useState<SessionRow[]>([]);
	const [statusText, setStatusText] = useState('');
	const [sel, setSel] = useState<string | null>(null);
	const [events, setEvents] = useState<SessionEvent[]>([]);
	const [error, setError] = useState<string | null>(null);
	const load = async () => { try { const r = await api.get<{ sessions: SessionRow[]; status: string }>('/sessions'); setRows(r.sessions); setStatusText(r.status); } catch (e) { setError((e as Error).message); } };
	useEffect(() => { void load(); const t = setInterval(() => void load(), 10_000); return () => clearInterval(t); }, []);
	useEffect(() => { if (!sel) return; api.get<{ events: SessionEvent[] }>(`/session?id=${encodeURIComponent(sel)}`).then(r => setEvents(r.events)).catch(e => setError((e as Error).message)); }, [sel]);
	const sum = (k: string) => rows.reduce((s, r) => s + n(r.counters[k]), 0);
	const proposed = sum('proposed'), served = sum('served'), blocked = sum('blocked');
	const selected = rows.find(r => r.sessionId === sel);
	return (
		<Section id="sessions" title="Sessions" desc="Every governed agent session (Claude Code via hooks, @riaf, the console) with the governor's decision per tool call: served from the index, blocked as redundant, prefetched, or executed.">
			{error && <Note kind="warn">{error}</Note>}
			<div className="rowflex">
				<StatCard label="Sessions" value={String(rows.length)} />
				<StatCard label="Calls proposed" value={fmtK(proposed)} />
				<StatCard label="Served from index" value={fmtK(served)} sub={proposed ? `${Math.round(served / proposed * 100)}%` : ''} />
				<StatCard label="Blocked (redundant / loop)" value={fmtK(blocked)} sub={proposed ? `${Math.round(blocked / proposed * 100)}%` : ''} />
				<StatCard label="Tokens served vs executed" value={`${fmtK(sum('tokensServed'))} / ${fmtK(sum('tokensExecuted'))}`} />
			</div>
			<div className="grid2">
				<div className="panel" style={{ overflow: 'auto', maxHeight: '65vh' }}>
					<table><thead><tr><th>session</th><th>host</th><th>last activity</th><th>proposed</th><th>served</th><th>blocked</th><th>saved</th></tr></thead><tbody>
						{rows.map(r => <tr key={r.sessionId} className="clickable" style={sel === r.sessionId ? { background: 'var(--vscode-list-activeSelectionBackground)' } : undefined} onClick={() => setSel(r.sessionId)}>
							<td className="mono">{r.sessionId.slice(0, 12)}</td><td>{r.host}</td><td>{ago(r.updatedAt)}</td><td>{n(r.counters.proposed)}</td><td>{n(r.counters.served)}</td><td>{n(r.counters.blocked)}</td><td>{fmtK(n(r.counters.tokensServed))}</td>
						</tr>)}
						{!rows.length && <tr><td colSpan={7} className="muted">No governed sessions yet. Start Claude Code in this repo (with the RIAF hooks installed) or ask @riaf something.</td></tr>}
					</tbody></table>
				</div>
				<div className="panel stack" style={{ minWidth: 0 }}>
					{!selected && <div className="muted">Select a session to see its tool-call timeline.</div>}
					{selected && <>
						<div className="rowflex"><span style={{ fontWeight: 600 }} className="mono">{selected.sessionId}</span><span className="chip">{selected.host}</span><span className="muted" style={{ fontSize: 11 }}>started {ago(selected.startedAt)} · phase {String(selected.counters.phase ?? '?')}</span><span style={{ flex: 1 }} /><Button small onClick={() => setSel(null)}>close</Button></div>
						<div className="rowflex" style={{ fontSize: 11 }}>{Object.entries(selected.counters).filter(([k, v]) => typeof v === 'number' && !/^(startedAt|updatedAt)$/.test(k)).map(([k, v]) => <span key={k} className="chip">{k} {fmtK(n(v))}</span>)}</div>
						<div style={{ maxHeight: '55vh', overflow: 'auto' }}>
							<table><thead><tr><th>when</th><th>event</th><th>tool</th><th>target</th><th>decision</th></tr></thead><tbody>
								{events.map(e => <tr key={e.id}><td>{new Date(e.ts).toLocaleTimeString()}</td><td>{e.event}</td><td className="mono">{e.tool ?? ''}</td><td className="mono" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.path ?? ''}>{e.path ?? ''}</td><td><span className={`chip ${e.decision === 'deny' ? 'hot' : e.decision === 'context' ? 'accent' : ''}`} title={e.reason ?? ''}>{e.decision ?? ''}</span></td></tr>)}
								{!events.length && <tr><td colSpan={5} className="muted">No per-call events recorded for this session (older sessions predate the event log).</td></tr>}
							</tbody></table>
						</div>
					</>}
				</div>
			</div>
			{statusText && <pre className="muted" style={{ fontSize: 11 }}>{statusText}</pre>}
		</Section>
	);
}
