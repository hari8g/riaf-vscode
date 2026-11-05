import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, ago, boot, clock, fmtDur, fmtK, type EventKind, type Health, type RunEvent, type RunReport, type RunStatus, type RunSummary } from './api.js';
import { Btn, Chip, useToast } from './kit.js';

/* ───────── live polling ───────── */

/**
 * Follow one Claude Code session. Polls /api/activity with a cursor, faster while the run is active and
 * paused while the tab is hidden. `sessionId` null follows whichever session is most recent.
 */
/**
 * "Armed" marks when this window last started from a clean slate (page load, New task, Send to Claude Code).
 * A finished run from before that moment is not shown: the window waits for the next prompt instead.
 */
const armed = { at: Date.now(), epoch: 0, subs: new Set<() => void>() };
export function rearm(): void { armed.at = Date.now(); armed.epoch++; armed.subs.forEach(f => f()); }

export function useLiveRun(sessionId: string | null, enabled = true) {
	const [epoch, setEpoch] = useState(armed.epoch);
	useEffect(() => { const f = () => setEpoch(armed.epoch); armed.subs.add(f); return () => void armed.subs.delete(f); }, []);
	const [events, setEvents] = useState<RunEvent[]>([]);
	const [summary, setSummary] = useState<RunSummary | null>(null);
	const [sid, setSid] = useState<string | null>(sessionId);
	const [error, setError] = useState<string | null>(null);
	const [polledAt, setPolledAt] = useState(0);
	const cursor = useRef(0);
	const cur = useRef<string | null>(null);
	const status = useRef<RunStatus | null>(null);

	useEffect(() => { setEvents([]); setSummary(null); setSid(sessionId); cursor.current = 0; cur.current = null; status.current = null; }, [sessionId, epoch]);

	useEffect(() => {
		if (!enabled) return;
		let stop = false, timer: ReturnType<typeof setTimeout>;
		const tick = async () => {
			if (stop) return;
			if (!document.hidden) {
				try {
					const r = await api.get<{ sessionId: string | null; events: RunEvent[]; cursor: number; summary: RunSummary | null }>(`/activity?since=${cursor.current}&session=${encodeURIComponent(sessionId ?? '')}&after=${sessionId ? 0 : armed.at}`);
					if (stop) return;
					if (r.sessionId !== cur.current) { cur.current = r.sessionId; cursor.current = 0; setEvents(r.events); } // a newer session started: start its feed over
					else if (r.events.length) setEvents(prev => [...prev, ...r.events.filter(e => !prev.some(p => p.id === e.id))].slice(-2500));
					if (r.sessionId === cur.current && r.sessionId) cursor.current = Math.max(cursor.current, r.cursor);
					setSid(r.sessionId); setSummary(r.summary); status.current = r.summary?.status ?? null; setError(null); setPolledAt(Date.now());
				} catch (e) { if (!stop) setError((e as Error).message); }
			}
			const st = status.current;
			timer = setTimeout(() => void tick(), st === 'running' ? 1000 : st === 'waiting' ? 3000 : 6000);
		};
		void tick();
		const wake = () => { if (!document.hidden) { clearTimeout(timer); void tick(); } };
		document.addEventListener('visibilitychange', wake);
		return () => { stop = true; clearTimeout(timer); document.removeEventListener('visibilitychange', wake); };
	}, [sessionId, enabled, epoch]);

	return { events, summary, sessionId: sid, error, polledAt };
}

const LiveCtx = createContext<ReturnType<typeof useLiveRun> | null>(null);
/** One poller for the whole console: the top bar and the Studio panel read the same live run. */
export function LiveRunProvider({ children }: { children: React.ReactNode }) { const v = useLiveRun(null); return <LiveCtx.Provider value={v}>{children}</LiveCtx.Provider>; }
export const useLive = () => { const v = useContext(LiveCtx); if (!v) throw new Error('LiveRunProvider missing'); return v; };

/** Rendered report for a session; refetches when `version` changes (new events) while visible. */
export function useRunReport(sessionId: string | null, version: number, enabled: boolean) {
	const [report, setReport] = useState<RunReport | null>(null);
	const [markdown, setMarkdown] = useState('');
	const [busy, setBusy] = useState(false);
	useEffect(() => { setReport(null); setMarkdown(''); }, [sessionId]);
	useEffect(() => {
		if (!enabled || !sessionId) return;
		let stop = false;
		const t = setTimeout(() => {
			setBusy(true);
			api.get<{ report: RunReport; markdown: string }>(`/session/report?id=${encodeURIComponent(sessionId)}`).then(r => { if (!stop) { setReport(r.report); setMarkdown(r.markdown); } }).catch(() => undefined).finally(() => { if (!stop) setBusy(false); });
		}, 250);
		return () => { stop = true; clearTimeout(t); };
	}, [sessionId, version, enabled]);
	return { report, markdown, busy };
}

/* ───────── small pieces ───────── */

const ICON: Record<EventKind, string> = {
	prompt: 'M4 5h16v10H9l-5 4zM8 9h8',
	read: 'M7 3h7l4 4v14H7zM13 3v5h5',
	search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
	edit: 'M4 20l1-4L16 5l3 3L8 19zM14 7l3 3',
	command: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h3',
	test: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12l3 3 5-6',
	served: 'M13 3L5 13h6l-1 8 8-10h-6z',
	blocked: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6zM9 12l2 2 4-4',
	briefing: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01',
	riaf: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
	subagent: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3 3-5 6-5s6 2 6 5M17 8a3 3 0 0 1 0 6M21 20c0-2-1-4-3-4.5',
	'turn-end': 'M5 21V4h12l-2 4 2 4H5',
	start: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
	end: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9h6v6H9z',
	other: 'M12 12h.01',
};
export const KindIcon = ({ kind }: { kind: EventKind }) => <svg viewBox="0 0 24 24" aria-hidden="true"><path d={ICON[kind] ?? ICON.other} /></svg>;

const STATUS_TEXT: Record<RunStatus, string> = { running: 'Running', waiting: 'Done, waiting for you', finished: 'Finished', stale: 'No recent activity' };
export const StatusPill = ({ status }: { status: RunStatus }) => <span className={`pill ${status}`}><i />{STATUS_TEXT[status]}</span>;

const PHASES: { id: string; label: string; kinds: EventKind[] }[] = [
	{ id: 'plan', label: 'Task received', kinds: ['prompt', 'briefing', 'start'] },
	{ id: 'explore', label: 'Exploring', kinds: ['read', 'search', 'served', 'blocked', 'riaf'] },
	{ id: 'implement', label: 'Implementing', kinds: ['edit', 'command', 'subagent'] },
	{ id: 'verify', label: 'Verifying', kinds: ['test'] },
];
/** Where the run is now, judged from the latest meaningful event. */
export function PhaseRail({ events, status }: { events: RunEvent[]; status: RunStatus | null }) {
	const seen = new Set(events.map(e => e.kind));
	const last = [...events].reverse().find(e => e.kind !== 'other' && e.kind !== 'turn-end' && e.kind !== 'end');
	const curIdx = last ? PHASES.findIndex(p => p.kinds.includes(last.kind)) : -1;
	const done = status === 'waiting' || status === 'finished';
	return (
		<ol className="phase-rail" aria-label="Run phase">
			{PHASES.map((p, i) => {
				const reached = p.kinds.some(k => seen.has(k));
				const cls = done ? (reached ? 'done' : '') : i === curIdx && status === 'running' ? 'now' : reached ? 'done' : '';
				return <li key={p.id} className={cls}><i />{p.label}</li>;
			})}
		</ol>
	);
}

export function RunStats({ s }: { s: RunSummary }) {
	const t = s.tests;
	return (
		<div className="runstats">
			<div><b>{s.filesRead}</b><span>files read</span></div>
			<div><b>{s.filesEdited}</b><span>files edited{s.linesAdded || s.linesRemoved ? ` · +${s.linesAdded} −${s.linesRemoved}` : ''}</span></div>
			<div><b>{s.commands}</b><span>commands run</span></div>
			<div className={t.lastOk === null ? '' : t.lastOk ? 'good' : 'bad'}><b>{t.lastOk === null ? '—' : t.lastOk ? `${t.passed} ✓` : `${t.failed} ✗`}</b><span>{t.runs ? `last of ${t.runs} test run${t.runs === 1 ? '' : 's'}` : 'no test run yet'}</span></div>
			<div><b>{fmtDur(s.durationMs)}</b><span>elapsed</span></div>
		</div>
	);
}

/* ───────── the live feed ───────── */

const NOISE = new Set<EventKind>(['other']);

export function LiveFeed({ events, maxHeight = 420, showAllToggle = true }: { events: RunEvent[]; maxHeight?: number; showAllToggle?: boolean }) {
	const [follow, setFollow] = useState(true);
	const [verbose, setVerbose] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	// Pre-events that were allowed are dropped (their Post event says the same thing, with results).
	const shown = useMemo(() => events.filter(e => !(e.event === 'PreToolUse' && e.decision !== 'deny') && (verbose || !NOISE.has(e.kind))), [events, verbose]);
	useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight; }, [shown.length, follow]);
	const onScroll = () => { const el = box.current; if (!el) return; setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40); };
	if (!shown.length) return <p className="small muted" style={{ margin: 0 }}>Waiting for the first event. Start Claude Code in this repository and it will appear here within a second.</p>;
	return (
		<div className="feedwrap">
			<div className="feed" ref={box} onScroll={onScroll} style={{ maxHeight }} role="log" aria-live="polite" aria-label="Claude Code activity">
				{shown.map(e => (
					<div key={e.id} className={`ev ${e.kind} ${e.detail?.failed || (e.detail?.tests && !e.detail.tests.ok) ? 'bad' : ''}`}>
						<span className="ic"><KindIcon kind={e.kind} /></span>
						<div className="body">
							<div className="lab">{e.label}</div>
							{e.kind === 'test' && e.detail?.tests && <TestBar t={e.detail.tests} />}
							{e.detail?.tail && (e.detail.failed || (e.detail.tests && !e.detail.tests.ok)) && <pre className="tail">{e.detail.tail}</pre>}
						</div>
						<span className="t">{clock(e.ts)}</span>
					</div>
				))}
			</div>
			<div className="feedbar">
				{!follow && <Btn sm onClick={() => { setFollow(true); if (box.current) box.current.scrollTop = box.current.scrollHeight; }}>Jump to latest</Btn>}
				{showAllToggle && <label className="tiny muted"><input type="checkbox" checked={verbose} onChange={e => setVerbose(e.target.checked)} /> show every hook event</label>}
				<span className="tiny muted">{shown.length} events</span>
			</div>
		</div>
	);
}

export function TestBar({ t }: { t: { passed: number; failed: number; errors: number; skipped: number; total: number } }) {
	const tot = Math.max(1, t.total);
	return <div className="testbar" title={`${t.passed} passed, ${t.failed + t.errors} failed, ${t.skipped} skipped`}><i style={{ width: `${t.passed / tot * 100}%`, background: 'var(--moss)' }} /><i style={{ width: `${(t.failed + t.errors) / tot * 100}%`, background: 'var(--ember)' }} /><i style={{ width: `${t.skipped / tot * 100}%`, background: 'var(--line-2)' }} /></div>;
}

/* ───────── the report ───────── */

const download = (name: string, text: string) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };

export function RunReportView({ report: r, markdown, go }: { report: RunReport; markdown: string; go?: (page: string, q?: string) => void }) {
	const toast = useToast();
	const gov = r.governance;
	const maxPhase = Math.max(1, ...r.phases.map(p => p.calls));
	return (
		<div className="report stack">
			<div className={`verdict ${r.verdict}`}>
				<div>
					<div className="vh">{r.headline}</div>
					<div className="small muted">{fmtDur(r.durationMs)} · {new Date(r.startedAt).toLocaleString()} · session <code>{r.sessionId.slice(0, 10)}</code>{r.git?.branch ? ` · ${r.git.branch}` : ''}</div>
				</div>
				<div className="row">
					<Btn sm onClick={() => { void navigator.clipboard.writeText(markdown); toast('Report copied as markdown'); }}>Copy markdown</Btn>
					<Btn sm onClick={() => download(`riaf-run-${r.sessionId.slice(0, 8)}.md`, markdown)}>Download .md</Btn>
				</div>
			</div>

			{r.notes?.length > 0 && <div className="banner warn" style={{ margin: 0 }}><div className="stack" style={{ gap: 4 }}>{r.notes.map((x, i) => <div key={i} className="small">{x}</div>)}</div></div>}

			<section className="panel">
				<h3>What was done</h3>
				<ul className="bul">{r.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
				{r.task.instruction && <div className="small muted" style={{ marginTop: 8 }}>Worked from brief <code>{r.task.instruction.id}</code> ({r.task.instruction.intent}), which planned {r.task.instruction.plan.length} steps and {r.task.instruction.verification.length} verification checks.</div>}
			</section>

			<section className="panel">
				<h3>How it was built</h3>
				{r.phases.some(p => p.calls) && <div className="phasebars">{r.phases.map(p => <div key={p.phase}><span className="small">{p.phase}</span><div className="pb"><i style={{ width: `${p.calls / maxPhase * 100}%` }} /></div><span className="tiny muted">{p.calls} calls · {fmtK(p.tokens)} tok</span></div>)}</div>}
				<ol className="steps">{r.steps.map((s, i) => <li key={i} className={s.kind}><span className="ic"><KindIcon kind={s.kind} /></span><span className="lab">{s.label}</span><span className="t">{clock(s.ts)}</span></li>)}</ol>
			</section>

			<div className="grid2">
				<section className="panel">
					<h3>Files changed</h3>
					{r.files.edited.length ? <table className="data"><thead><tr><th>File</th><th>Edits</th><th>Lines</th><th /></tr></thead><tbody>
						{r.files.edited.map(f => <tr key={f.path} className={go ? 'clickable' : ''} onClick={() => go?.('repository', `path=${encodeURIComponent(f.path)}`)}>
							<td className="mono" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>{f.path}</td><td>{f.edits}</td>
							<td className="mono tiny"><span style={{ color: 'var(--moss)' }}>+{f.added}</span> <span style={{ color: 'var(--ember)' }}>−{f.removed}</span></td>
							<td>{f.isNew && <Chip tone="teal">new</Chip>}{f.isTest && <Chip tone="moss">test</Chip>}{f.inPack === false && <Chip title="Claude edited a file RIAF had not put in the pack">not in pack</Chip>}</td></tr>)}
					</tbody></table> : <p className="small muted">No file edits were recorded.</p>}
					{r.files.outside?.length > 0 && <div className="small" style={{ marginTop: 10 }}><b>Outside this repository</b><div className="tiny mono muted" style={{ marginTop: 4 }}>{r.files.outside.map(f => `${f.path} (${f.edited ? 'edited' : 'read'})`).join(' · ')}</div></div>}
					{r.git && (r.git.changed.length > 0 || r.git.untracked.length > 0) && <div className="small" style={{ marginTop: 10 }}><b>Checked against git</b> ({r.git.changed.length} changed, {r.git.untracked.length} new)
						<div className="tiny muted" style={{ marginTop: 4 }}>{r.git.changed.slice(0, 8).map(c => `${c.file} +${c.added} −${c.removed}`).join(' · ')}{r.git.untracked.length ? ` · new: ${r.git.untracked.slice(0, 6).join(', ')}` : ''}</div></div>}
				</section>

				<section className="panel">
					<h3>Unit tests</h3>
					{r.tests.runs.length ? <>
						<table className="data"><thead><tr><th>Time</th><th>Runner</th><th>Result</th><th /></tr></thead><tbody>
							{r.tests.runs.map((t, i) => <tr key={i}><td className="tiny">{clock(t.ts)}</td><td>{t.framework}</td><td style={{ minWidth: 120 }}><TestBar t={t} /><div className="tiny muted">{t.passed} passed · {t.failed + t.errors} failed{t.skipped ? ` · ${t.skipped} skipped` : ''}</div></td><td><Chip tone={t.ok ? 'moss' : 'ember'}>{t.ok ? 'pass' : 'fail'}</Chip></td></tr>)}
						</tbody></table>
						{r.tests.redToGreen && <div className="small" style={{ marginTop: 8, color: 'var(--moss)' }}>The suite went from failing to passing during the run.</div>}
					</> : <p className="small muted">No test run was observed. If Claude Code ran tests outside the hooks, they are not counted here.</p>}
					{(r.tests.testFilesTouched.length > 0 || r.tests.newTestFiles.length > 0) && <div className="small" style={{ marginTop: 10 }}><b>Test files written or changed</b><div className="tiny mono muted" style={{ marginTop: 4 }}>{[...new Set([...r.tests.testFilesTouched, ...r.tests.newTestFiles])].join(' · ')}</div></div>}
				</section>
			</div>

			<div className="grid2">
				<section className="panel">
					<h3>What RIAF did for this run</h3>
					<div className="kv"><span>Calls proposed</span><b>{gov.proposed}</b><span>Answered from the index</span><b>{gov.served}</b><span>Repeats blocked</span><b>{gov.blocked}</b><span>RIAF tool calls</span><b>{gov.riafToolCalls ?? 0}</b><span>Shell searches (grep, sed, cat, find)</span><b>{gov.shellExploration ?? 0}</b><span>Calls avoided</span><b>{Math.round(gov.avoidedRate * 100)}%</b><span>Tokens served instead of executed</span><b>{fmtK(gov.tokensServed)}</b><span>Tokens executed</span><b>{fmtK(gov.tokensExecuted)}</b></div>
				</section>
				<section className="panel">
					<h3>Context quality</h3>
					{r.context ? <>
						<div className="small">{r.context.touchedInPack} of {r.context.touched} files touched were in the compiled pack{r.context.hitRate !== null ? ` (${Math.round(r.context.hitRate * 100)}%)` : ''}.</div>
						{r.context.missed.length > 0 && <div className="small" style={{ marginTop: 6 }}><b>Needed but not packed</b><div className="tiny mono muted">{r.context.missed.join(' · ')}</div></div>}
						{r.context.unused.length > 0 && <div className="small" style={{ marginTop: 6 }}><b>Packed but never used</b><div className="tiny mono muted">{r.context.unused.join(' · ')}</div></div>}
						<div className="tiny muted" style={{ marginTop: 8 }}>Pin the first list in Studio next time, and drop the second, to tighten the brief.</div>
					</> : <p className="small muted">No brief was attached to this run, so context quality can't be scored. Compile one in Studio first.</p>}
				</section>
			</div>

			{r.commands.length > 0 && <section className="panel"><h3>Other commands</h3><table className="data"><tbody>{r.commands.map((c, i) => <tr key={i}><td className="tiny">{clock(c.ts)}</td><td className="mono" style={{ wordBreak: 'break-all' }}>{c.command}</td><td>{c.failed && <Chip tone="ember">failed</Chip>}</td></tr>)}</tbody></table></section>}
		</div>
	);
}

/* ───────── the Studio panel: live while running, report when done ───────── */

export function RunPanel({ go }: { go: (page: string, q?: string) => void }) {
	const toast = useToast();
	const { events, summary, sessionId, error } = useLive();
	const [tab, setTab] = useState<'live' | 'report'>('live');
	const [open, setOpen] = useState(true);
	const prev = useRef<RunStatus | null>(null);
	useEffect(() => {
		const s = summary?.status ?? null;
		if (prev.current === 'running' && (s === 'waiting' || s === 'finished')) { setTab('report'); setOpen(true); toast('Claude Code finished. The run report is ready.'); }
		if (prev.current !== 'running' && s === 'running') { setTab('live'); setOpen(true); }
		prev.current = s;
	}, [summary?.status, toast]);
	const { report, markdown, busy } = useRunReport(sessionId, events.length, tab === 'report' && open && !!summary);
	const repo = boot.root.split(/[\\/]/).filter(Boolean).pop() ?? 'this repository';

	if (!summary) {
		return (
			<section className="panel runpanel idle ready">
				<span className="radar" aria-hidden="true"><i /><i /><i /></span>
				<div style={{ flex: 1, minWidth: 220 }}>
					<h2>{error ? 'Cannot reach the daemon' : 'Ready for your next prompt'}</h2>
					<div className="small muted">{error ? error : <>Run Claude Code in <code>{repo}</code>. Each step appears here as it happens and a report is written when it finishes. Every new prompt starts a clean run; earlier ones are cleared.</>}</div>
				</div>
				<Btn sm kind="ghost" onClick={() => go('sessions')}>Check the connection</Btn>
			</section>
		);
	}
	const live = summary.status === 'running';
	return (
		<section className={`panel runpanel ${live ? 'live' : ''}`}>
			<div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
				<div style={{ minWidth: 0, flex: 1 }}>
					<div className="row" style={{ gap: 10 }}><h2>Claude Code activity</h2><StatusPill status={summary.status} /></div>
					<div className="small muted rt" title={summary.title ?? ''}>started {ago(summary.startedAt)} · {summary.title ?? 'Current prompt'}</div>
				</div>
				<div className="row">
					<div className="seg2" role="tablist">
						<button role="tab" aria-selected={tab === 'live'} className={tab === 'live' ? 'on' : ''} onClick={() => { setTab('live'); setOpen(true); }}>Live</button>
						<button role="tab" aria-selected={tab === 'report'} className={tab === 'report' ? 'on' : ''} onClick={() => { setTab('report'); setOpen(true); }}>Report</button>
					</div>
					<Btn sm kind="ghost" onClick={() => go('sessions', `id=${encodeURIComponent(summary.sessionId)}`)}>Open in Sessions</Btn>
					{!live && <Btn sm kind="ghost" onClick={() => rearm()} title="Clear this run and wait for the next prompt">Clear</Btn>}
					<Btn sm kind="ghost" onClick={() => setOpen(o => !o)} title={open ? 'Collapse' : 'Expand'}>{open ? 'Hide' : 'Show'}</Btn>
				</div>
			</div>
			{open && <div className="stack" style={{ marginTop: 12 }}>
				<PhaseRail events={events} status={summary.status} />
				<RunStats s={summary} />
				{tab === 'live' ? <LiveFeed events={events} /> : report ? <RunReportView report={report} markdown={markdown} go={go} /> : <p className="small muted">{busy ? 'Assembling the report…' : 'No report yet.'}</p>}
			</div>}
		</section>
	);
}

/* ───────── connection checklist (explains an empty Sessions page) ───────── */

export function HealthCheck({ health, onInstall, installing }: { health: Health; onInstall: () => void; installing: boolean }) {
	const g = health.governor;
	const rows: { ok: boolean; text: string; fix?: string }[] = [
		{ ok: g.listening, text: 'This RIAF process is listening for Claude Code hooks', fix: 'Start the daemon without --no-govern, or run RIAF: Open Console from VS Code.' },
		{ ok: g.ownedByThisProcess || !g.fileEndpoint, text: g.otherPid ? `Hooks currently report to another RIAF process (pid ${g.otherPid}), not this console` : 'Hooks are pointed at this process', fix: 'Only one RIAF process can own .riaf/governor.json. Close the other (for example the VS Code extension) or use its console instead.' },
		{ ok: health.hookScript, text: 'The hook client exists at .claude/hooks/riaf-govern.mjs', fix: 'Install the hooks.' },
		{ ok: health.missing.length === 0, text: health.missing.length ? `Claude Code settings are missing hooks: ${health.missing.join(', ')}` : 'All hooks are registered in .claude/settings.json (including Stop, which marks a finished run)', fix: 'Install or update the hooks, then restart Claude Code.' },
		{ ok: health.riafToolsRecorded, text: health.riafToolsRecorded ? 'RIAF tool calls (riaf_lookup and friends) are recorded in the run' : 'RIAF tool calls are not recorded yet, so a run cannot show whether Claude used the index', fix: 'Install or update the hooks, then restart Claude Code.' },
		{ ok: health.eventsTotal > 0, text: health.eventsTotal ? `Last hook event received ${ago(health.lastEventAt ?? 0)} (${health.eventsTotal} in total)` : 'No hook event has been received yet', fix: 'Start a Claude Code session in this repository after installing the hooks.' },
	];
	const allOk = rows.every(r => r.ok);
	return (
		<div className="panel stack">
			<div className="row" style={{ justifyContent: 'space-between' }}>
				<div><h2>{allOk ? 'Connected' : 'Claude Code is not fully connected'}</h2><div className="small muted">This is why a session may not show up. Each line is checked live.</div></div>
				<Btn kind={allOk ? undefined : 'primary'} onClick={onInstall} disabled={installing}>{installing ? 'Installing…' : 'Install or update hooks'}</Btn>
			</div>
			<div className="checks">{rows.map((r, i) => <div key={i} className={`check ${r.ok ? 'ok' : 'bad'}`}><span className={`dot ${r.ok ? 'ok' : 'warn'}`} /><div><div>{r.text}</div>{!r.ok && r.fix && <div className="tiny muted">{r.fix}</div>}</div></div>)}</div>
			<div className="tiny muted">Installing writes <code>.claude/hooks/riaf-govern.mjs</code>, merges hooks into <code>.claude/settings.json</code> (your other hooks stay), <code>.riaf/policy.yaml</code> and the RIAF block in <code>CLAUDE.md</code>. Restart Claude Code afterwards so it re-reads its settings.</div>
		</div>
	);
}

