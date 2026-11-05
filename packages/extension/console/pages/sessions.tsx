import React, { useEffect, useMemo, useState } from 'react';
import { ago, api, fmtK, type SessionEvent, type SessionRow } from '../api.js';
import { Btn, Chip, Empty } from '../kit.js';

const n = (v: unknown) => Number(v) || 0;
const cls = (e: SessionEvent) => e.decision === 'deny' ? 'deny' : e.decision === 'context' ? 'context' : e.event === 'PostToolUse' ? 'exec' : 'allow';

export function Sessions() {
	const [rows, setRows] = useState<SessionRow[]>([]);
	const [sel, setSel] = useState<string | null>(null);
	const [events, setEvents] = useState<SessionEvent[]>([]);
	const [filter, setFilter] = useState<'all' | 'deny' | 'exec' | 'context'>('all');
	const load = async () => { try { const r = await api.get<{ sessions: SessionRow[] }>('/sessions'); setRows(r.sessions); } catch { /* shown by overview */ } };
	useEffect(() => { void load(); const t = setInterval(() => void load(), 10_000); return () => clearInterval(t); }, []);
	useEffect(() => { if (!sel) return; api.get<{ events: SessionEvent[] }>(`/session?id=${encodeURIComponent(sel)}&limit=800`).then(r => setEvents([...r.events].reverse())).catch(() => setEvents([])); }, [sel]);
	const sum = (k: string) => rows.reduce((s, r) => s + n(r.counters[k]), 0);
	const proposed = sum('proposed'), served = sum('served'), blocked = sum('blocked');
	const selected = rows.find(r => r.sessionId === sel);
	const shown = useMemo(() => events.filter(e => filter === 'all' || cls(e) === filter), [events, filter]);
	const counts = useMemo(() => ({ deny: events.filter(e => cls(e) === 'deny').length, exec: events.filter(e => cls(e) === 'exec').length, context: events.filter(e => cls(e) === 'context').length }), [events]);

	return (
		<>
			<h1>Sessions</h1>
			<p className="lead">Every governed session: what the agent asked to read or run, and whether the governor answered from the index, blocked a repeat, or let it through. Green is a call that never had to happen.</p>
			<div className="grid3" style={{ marginBottom: 14 }}>
				<div className="stat"><div className="v">{rows.length}</div><div className="l">sessions recorded</div></div>
				<div className="stat"><div className="v">{proposed ? Math.round((served + blocked) / proposed * 100) : 0}%</div><div className="l">of {fmtK(proposed)} proposed calls avoided: {fmtK(served)} served from the index, {fmtK(blocked)} blocked</div></div>
				<div className="stat"><div className="v">{fmtK(sum('tokensServed'))}</div><div className="l">tokens served instead of executed ({fmtK(sum('tokensExecuted'))} executed)</div></div>
			</div>
			{!rows.length ? <Empty title="No sessions yet">Start Claude Code in this repository with the RIAF hooks installed, or ask @riaf in VS Code; sessions appear here as they run.</Empty> : (
				<div className="grid2" style={{ gridTemplateColumns: selected ? '1fr 1.3fr' : '1fr' }}>
					<div className="panel" style={{ maxHeight: '70vh', overflow: 'auto', padding: 0 }}>
						<table className="data"><thead><tr><th>Session</th><th>Client</th><th>Last activity</th><th>Decisions</th><th>Saved</th></tr></thead><tbody>
							{rows.map(r => { const p = n(r.counters.proposed), s = n(r.counters.served), b = n(r.counters.blocked); return (
								<tr key={r.sessionId} className={`clickable ${sel === r.sessionId ? 'sel' : ''}`} onClick={() => setSel(r.sessionId === sel ? null : r.sessionId)}>
									<td className="mono">{r.sessionId.slice(0, 10)}</td><td>{r.host}</td><td>{ago(r.updatedAt)}</td>
									<td style={{ minWidth: 140 }}><div className="breakdown" title={`${s} served, ${b} blocked, ${Math.max(0, p - s - b)} executed`}>{p > 0 && <><i style={{ width: `${s / p * 100}%`, background: 'var(--moss)' }} /><i style={{ width: `${b / p * 100}%`, background: 'var(--teal)' }} /><i style={{ width: `${Math.max(0, p - s - b) / p * 100}%`, background: 'var(--ember)' }} /></>}</div><div className="tiny muted">{p} calls</div></td>
									<td>{fmtK(n(r.counters.tokensServed))}</td>
								</tr>); })}
						</tbody></table>
					</div>
					{selected && <div className="panel stack" style={{ minWidth: 0 }}>
						<div className="row" style={{ justifyContent: 'space-between' }}><div><h2 className="mono" style={{ fontSize: 14 }}>{selected.sessionId}</h2><div className="small muted">{selected.host}, started {ago(selected.startedAt)}, phase {String(selected.counters.phase ?? 'unknown')}</div></div><Btn sm kind="ghost" onClick={() => setSel(null)}>Close</Btn></div>
						<div className="tl" role="img" aria-label="timeline of governor decisions">{events.map(e => <i key={e.id} className={cls(e)} title={`${new Date(e.ts).toLocaleTimeString()} ${e.event} ${e.tool ?? ''} ${e.path ?? ''} → ${e.decision ?? ''}`} />)}</div>
						<div className="row small">
							<Chip tone={filter === 'all' ? 'teal' : undefined} onClick={() => setFilter('all')}>all {events.length}</Chip>
							<Chip tone={filter === 'deny' ? 'teal' : undefined} onClick={() => setFilter('deny')}><span className="dot ok" /> served or blocked {counts.deny}</Chip>
							<Chip tone={filter === 'exec' ? 'teal' : undefined} onClick={() => setFilter('exec')}><span className="dot warn" /> executed {counts.exec}</Chip>
							<Chip tone={filter === 'context' ? 'teal' : undefined} onClick={() => setFilter('context')}>briefings {counts.context}</Chip>
						</div>
						<div className="row">{Object.entries(selected.counters).filter(([k, v]) => typeof v === 'number' && !/^(startedAt|updatedAt)$/.test(k)).map(([k, v]) => <Chip key={k}>{k} {fmtK(n(v))}</Chip>)}</div>
						<div style={{ maxHeight: '52vh', overflow: 'auto' }}>
							{!events.length ? <p className="small muted">No per-call events for this session (it predates the event log).</p> : <table className="data"><thead><tr><th>Time</th><th>Event</th><th>Tool</th><th>Target</th><th>Decision</th></tr></thead><tbody>
								{shown.map(e => <tr key={e.id}><td className="tiny">{new Date(e.ts).toLocaleTimeString()}</td><td>{e.event}</td><td className="mono">{e.tool ?? ''}</td><td className="mono" style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.path ?? ''}>{e.path ?? ''}</td><td><Chip tone={cls(e) === 'deny' ? 'moss' : cls(e) === 'context' ? 'teal' : cls(e) === 'exec' ? 'ember' : undefined} title={e.reason ?? ''}>{e.decision === 'deny' ? 'served' : e.decision ?? 'allowed'}</Chip></td></tr>)}
							</tbody></table>}
						</div>
					</div>}
				</div>
			)}
		</>
	);
}
