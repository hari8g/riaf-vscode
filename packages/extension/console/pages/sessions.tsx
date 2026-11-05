import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ago, api, clock, fmtDur, fmtK, type Health, type SessionRow } from '../api.js';
import { Btn, Chip, Empty, useToast } from '../kit.js';
import { HealthCheck, LiveFeed, PhaseRail, RunReportView, RunStats, StatusPill, useLiveRun, useRunReport } from '../run.js';

const n = (v: unknown) => Number(v) || 0;
const METRICS: { title: string; rows: [string, string, 'k' | 'pct' | 'n'][] }[] = [
	{ title: 'Tool calls', rows: [['proposed', 'Calls the agent proposed', 'n'], ['served', 'Answered from the index (no tool call)', 'n'], ['blocked', 'Repeats blocked', 'n'], ['executed', 'Executed normally', 'n'], ['repeats', 'Repeated requests seen', 'n'], ['loops', 'Loops detected', 'n'], ['writes', 'File writes', 'n'], ['callsAvoidedRate', 'Calls avoided', 'pct']] },
	{ title: 'Tokens', rows: [['tokensServed', 'Served instead of executed', 'k'], ['tokensExecuted', 'Spent on executed calls', 'k'], ['tokensSavedRate', 'Share saved', 'pct']] },
	{ title: 'Cache and prefetch', rows: [['cacheHits', 'Cache hits', 'n'], ['cacheMisses', 'Cache misses', 'n'], ['cacheHitRate', 'Cache hit rate', 'pct'], ['prefetchIssued', 'Files prefetched', 'n'], ['prefetchUsed', 'Prefetches actually used', 'n'], ['prefetchPrecision', 'Prefetch precision', 'pct'], ['reflections', 'Reflections added', 'n']] },
];
const fmt = (v: unknown, k: 'k' | 'pct' | 'n') => k === 'pct' ? `${Math.round(n(v) * 100)}%` : k === 'k' ? fmtK(n(v)) : String(n(v));

export function Sessions() {
	const toast = useToast();
	const [rows, setRows] = useState<SessionRow[]>([]);
	const [health, setHealth] = useState<Health | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const [sel, setSel] = useState<string | null>(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('id'));
	const [tab, setTab] = useState<'live' | 'report' | 'metrics'>('live');
	const [installing, setInstalling] = useState(false);
	const [showHealth, setShowHealth] = useState(false);
	const [updated, setUpdated] = useState(0);

	// The list refreshes by itself: every 2 s while any session is running, 4 s otherwise, paused in a hidden tab.
	const anyRunning = useRef(false);
	useEffect(() => {
		let stop = false, timer: ReturnType<typeof setTimeout>;
		const load = async () => {
			if (!document.hidden) {
				try {
					const r = await api.get<{ sessions: SessionRow[]; health: Health }>('/sessions?limit=60');
					if (stop) return;
					setRows(r.sessions); setHealth(r.health); setErr(null); setLoaded(true); setUpdated(Date.now());
					anyRunning.current = r.sessions.some(s => s.status === 'running');
				} catch (e) { if (!stop) { setErr((e as Error).message); setLoaded(true); } }
			}
			timer = setTimeout(() => void load(), anyRunning.current ? 2000 : 4000);
		};
		void load();
		const wake = () => { if (!document.hidden) { clearTimeout(timer); void load(); } };
		document.addEventListener('visibilitychange', wake);
		return () => { stop = true; clearTimeout(timer); document.removeEventListener('visibilitychange', wake); };
	}, []);

	const selected = rows.find(r => r.sessionId === sel) ?? null;
	const live = useLiveRun(sel, !!sel);
	const { report, markdown, busy } = useRunReport(sel, live.events.length, tab === 'report' && !!sel);

	const sum = (k: string) => rows.reduce((s, r) => s + n(r.counters[k]), 0);
	const proposed = sum('proposed'), served = sum('served'), blocked = sum('blocked');
	const running = rows.filter(r => r.status === 'running').length;
	const edited = rows.reduce((s, r) => s + r.filesEdited, 0);
	const withTests = rows.filter(r => r.tests.lastOk !== null);
	const green = withTests.filter(r => r.tests.lastOk).length;

	const install = async () => {
		setInstalling(true);
		try { const r = await api.post<{ written: string[] }>('/hooks/install', {}); toast(`Hooks installed (${r.written.length} files). Restart Claude Code so it reloads its settings.`); const s = await api.get<{ health: Health }>('/sessions?limit=1'); setHealth(s.health); }
		catch (e) { toast((e as Error).message, 'err'); } finally { setInstalling(false); }
	};
	const select = (id: string | null) => { setSel(id); setTab('live'); history.replaceState(null, '', id ? `#/sessions?id=${encodeURIComponent(id)}` : '#/sessions'); };
	const unhealthy = health && (health.missing.length > 0 || !health.governor.listening || !health.hookScript || (!health.governor.ownedByThisProcess && !!health.governor.fileEndpoint));
	const metrics = (selected?.counters ?? {}) as Record<string, unknown>;
	const by = (metrics.byPhase ?? {}) as Record<string, { calls?: number; tokens?: number }>;
	const sb = (metrics.servedBy ?? {}) as Record<string, number>;
	const tiles = useMemo(() => ([
		{ v: String(rows.length), l: running ? `sessions recorded, ${running} running now` : 'sessions recorded' },
		{ v: `${proposed ? Math.round((served + blocked) / proposed * 100) : 0}%`, l: `of ${fmtK(proposed)} proposed calls avoided (${fmtK(served)} served from the index, ${fmtK(blocked)} blocked)` },
		{ v: fmtK(sum('tokensServed')), l: `tokens served instead of executed (${fmtK(sum('tokensExecuted'))} executed)` },
		{ v: withTests.length ? `${green}/${withTests.length}` : '—', l: `runs ending on green tests · ${edited} files edited in total` },
	]), [rows]); // eslint-disable-line react-hooks/exhaustive-deps

	return (
		<>
			<div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
				<div><h1>Sessions</h1><p className="lead">Every Claude Code session in this repository: what it did, whether the tests passed, and how many tool calls RIAF kept from running. It updates by itself.</p></div>
				<div className="row"><span className="tiny muted live-tick"><i className={running ? 'on' : ''} />{updated ? `updated ${ago(updated)}` : 'connecting'}</span><Btn sm kind="ghost" onClick={() => setShowHealth(h => !h)}>{unhealthy ? '⚠ Connection' : 'Connection'}</Btn></div>
			</div>

			<div className="grid4" style={{ marginBottom: 14 }}>{tiles.map((t, i) => <div className="stat" key={i}><div className="v">{t.v}</div><div className="l">{t.l}</div></div>)}</div>

			{err && <div className="ask" style={{ marginBottom: 14 }}>Can't reach the daemon: {err}. The page keeps retrying.</div>}
			{health && (showHealth || (unhealthy && !rows.length)) && <div style={{ marginBottom: 14 }}><HealthCheck health={health} onInstall={() => void install()} installing={installing} /></div>}

			{!loaded ? <p className="muted">Loading…</p> : !rows.length ? (
				<>
					{!health || !(showHealth || unhealthy) ? <Empty title="No sessions yet">Start Claude Code in this repository. With the hooks installed, the session appears here the moment it sends its first prompt.</Empty> : null}
				</>
			) : (
				<div className="grid2" style={{ gridTemplateColumns: selected ? 'minmax(0,1fr) minmax(0,1.5fr)' : '1fr', alignItems: 'start' }}>
					<div className="panel" style={{ maxHeight: '78vh', overflow: 'auto', padding: 0 }}>
						<table className="data"><thead><tr><th>Status</th><th>Task</th>{!selected && <><th>Started</th><th>Duration</th></>}<th>Files</th><th>Tests</th>{!selected && <th>Calls avoided</th>}</tr></thead><tbody>
							{rows.map(r => { const p = n(r.counters.proposed), s = n(r.counters.served), b = n(r.counters.blocked); return (
								<tr key={r.sessionId} className={`clickable ${sel === r.sessionId ? 'sel' : ''}`} onClick={() => select(r.sessionId === sel ? null : r.sessionId)}>
									<td><StatusPill status={r.status} /></td>
									<td style={{ maxWidth: 260 }}><div className="clip" title={r.title ?? ''}>{r.title ?? <span className="muted">no prompt recorded</span>}</div><div className="tiny muted mono">{r.sessionId.slice(0, 10)} · {r.host}</div></td>
									{!selected && <><td className="small">{ago(r.startedAt)}</td><td className="small">{fmtDur(r.durationMs)}</td></>}
									<td className="small">{r.filesEdited ? <>{r.filesEdited} edited <span className="tiny mono"><span style={{ color: 'var(--moss)' }}>+{r.linesAdded}</span> <span style={{ color: 'var(--ember)' }}>−{r.linesRemoved}</span></span></> : <span className="muted">none</span>}</td>
									<td>{r.tests.lastOk === null ? <span className="muted small">no run</span> : <Chip tone={r.tests.lastOk ? 'moss' : 'ember'}>{r.tests.lastOk ? `${r.tests.passed} pass` : `${r.tests.failed} fail`}</Chip>}</td>
									{!selected && <td style={{ minWidth: 130 }}><div className="breakdown" title={`${s} served, ${b} blocked, ${Math.max(0, p - s - b)} executed`}>{p > 0 && <><i style={{ width: `${s / p * 100}%`, background: 'var(--moss)' }} /><i style={{ width: `${b / p * 100}%`, background: 'var(--teal)' }} /><i style={{ width: `${Math.max(0, p - s - b) / p * 100}%`, background: 'var(--ember)' }} /></>}</div><div className="tiny muted">{p ? `${Math.round((s + b) / p * 100)}% of ${p} calls` : 'no governed calls'}</div></td>}
								</tr>); })}
						</tbody></table>
					</div>

					{selected && (
						<div className="panel stack" style={{ minWidth: 0 }}>
							<div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
								<div style={{ minWidth: 0, flex: 1 }}><div className="row" style={{ gap: 10 }}><StatusPill status={(live.summary ?? selected).status} /><span className="mono small">{selected.sessionId.slice(0, 14)}</span></div><div className="small muted rt" title={selected.title ?? ''}>started {ago(selected.startedAt)} · {selected.title ?? 'No prompt recorded'}</div></div>
								<Btn sm kind="ghost" onClick={() => select(null)}>Close</Btn>
							</div>
							<PhaseRail events={live.events} status={(live.summary ?? selected).status} />
							<RunStats s={live.summary ?? selected} />
							<div className="tabs" style={{ marginBottom: 0 }}>
								<button className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')}>Activity</button>
								<button className={tab === 'report' ? 'on' : ''} onClick={() => setTab('report')}>Report</button>
								<button className={tab === 'metrics' ? 'on' : ''} onClick={() => setTab('metrics')}>Metrics</button>
							</div>
							{tab === 'live' && <LiveFeed events={live.events} maxHeight={460} />}
							{tab === 'report' && (report ? <RunReportView report={report} markdown={markdown} go={(page, q) => { location.hash = `#/${page}${q ? `?${q}` : ''}`; }} /> : <p className="small muted">{busy ? 'Assembling the report…' : 'No report yet.'}</p>)}
							{tab === 'metrics' && (
								<div className="stack">
									{!selected.counters || !Object.keys(selected.counters).length ? <p className="small muted">The governor kept no counters for this session (it never saw a governed tool call).</p> : <>
										<div className="grid3">{METRICS.map(g => <div key={g.title} className="panel flat"><h3>{g.title}</h3><div className="kv">{g.rows.map(([k, label, kind]) => <React.Fragment key={k}><span>{label}</span><b>{fmt(metrics[k], kind)}</b></React.Fragment>)}</div></div>)}</div>
										<div className="grid2">
											<div className="panel flat"><h3>Where answers came from</h3><div className="kv">{Object.entries(sb).map(([k, v]) => <React.Fragment key={k}><span>{({ session: 'Earlier in this session', pack: 'The compiled context pack', cache: 'The tool cache', loop: 'Loop guard' } as Record<string, string>)[k] ?? k}</span><b>{v}</b></React.Fragment>)}</div></div>
											<div className="panel flat"><h3>Time by phase</h3><table className="data"><thead><tr><th>Phase</th><th>Calls</th><th>Tokens</th></tr></thead><tbody>{['explore', 'plan', 'implement', 'verify'].map(ph => <tr key={ph}><td>{ph}</td><td>{n(by[ph]?.calls)}</td><td>{fmtK(n(by[ph]?.tokens))}</td></tr>)}</tbody></table></div>
										</div>
									</>}
								</div>
							)}
							<div className="tiny muted">Last event {live.events.length ? `${clock(live.events[live.events.length - 1].ts)} (${ago(live.events[live.events.length - 1].ts)})` : 'none yet'} · feed refreshes every second while the run is active.</div>
						</div>
					)}
				</div>
			)}
		</>
	);
}
