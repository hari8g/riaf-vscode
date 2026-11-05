import React, { useEffect, useState } from 'react';
import { ago, api, fmtK, type SessionRow, type Status } from '../api.js';
import { Btn, Chip, Empty, Ring, Status as St, useToast } from '../kit.js';
import type { Page } from '../main.js';

export function Overview({ status, refresh, go }: { status: Status | null; refresh: () => Promise<void>; go: (p: Page, q?: string) => void }) {
	const toast = useToast();
	const [busy, setBusy] = useState<string | null>(null);
	const [sessions, setSessions] = useState<SessionRow[]>([]);
	useEffect(() => { api.get<{ sessions: SessionRow[] }>('/sessions?limit=24').then(r => setSessions(r.sessions.reverse())).catch(() => undefined); }, [status?.governance.sessions]);
	if (!status) return <><h1>Overview</h1><p className="lead">Connecting to riafd…</p></>;
	const act = async (label: string, fn: () => Promise<unknown>) => { setBusy(label); try { await fn(); toast(`${label}: done`); await refresh(); } catch (e) { toast(`${label} failed: ${(e as Error).message}`, 'err'); } finally { setBusy(null); } };
	const c = status.claude, g = status.governance;
	const checks = [
		{ ok: c.mcpJson && !c.mcpStale, label: c.mcpJson ? (c.mcpStale ? `.mcp.json ${c.mcpStale}` : 'MCP server registered in .mcp.json') : 'MCP server not registered (.mcp.json)' },
		{ ok: c.governHook, label: c.governHook ? 'Governance hook installed' : 'Governance hook missing' },
		{ ok: c.commands.length > 0, label: c.commands.length ? `Slash commands: ${c.commands.map(x => '/' + x.replace(/\.md$/, '')).join(', ')}` : 'No /riaf-* slash commands yet' },
		{ ok: c.claudeMdRules, label: c.claudeMdRules ? 'CLAUDE.md carries the retrieval protocol' : 'CLAUDE.md has no RIAF protocol block' },
		{ ok: c.claudeMdInstruction, label: c.claudeMdInstruction ? 'CLAUDE.md points at the current brief' : c.instructionCurrent ? 'Brief compiled but not yet sent' : 'No brief sent yet' },
		{ ok: c.policy, label: c.policy ? '.riaf/policy.yaml present' : 'No policy file — defaults apply' },
	];
	const maxSaved = Math.max(1, ...sessions.map(s => Number(s.counters.tokensServed) || 0));
	return (
		<>
			<h1>Overview</h1>
			<p className="lead">{status.repo.root}, at commit {status.repo.head?.slice(0, 8) ?? 'no git'}{status.repo.branch ? ` on ${status.repo.branch}` : ''}. Index, history and governance at a glance; the Studio is where the work happens.</p>

			<div className="hero">
				<div className="panel stack">
					{status.instruction ? <>
						<div className="row" style={{ justifyContent: 'space-between' }}><h2>Current brief</h2><span className="small muted">{ago(Date.parse(status.instruction.generated_at))}</span></div>
						<div className="row"><Chip tone="teal">{status.instruction.type}</Chip><Chip>confidence {status.instruction.confidence}</Chip>{status.instruction.planGate && <Chip tone="ember">plan gate</Chip>}<Chip mono>{status.instruction.id}</Chip><Chip>{fmtK(status.instruction.tokens)} tokens</Chip></div>
						<p style={{ fontSize: 15 }}>{status.instruction.request}</p>
						<div className="row"><Btn kind="primary" onClick={() => go('studio')}>Open in Studio</Btn>{!c.claudeMdInstruction && <span className="small muted">Not yet handed to Claude Code.</span>}</div>
					</> : <Empty title="No brief yet" action={<Btn kind="primary" onClick={() => go('studio')}>Write the first task</Btn>}>Describe a task in the Studio; classification and compilation cost no model tokens.</Empty>}
					<div className="grid3">
						<div className="stat"><div className="v">{status.index.indexed ? fmtK(status.index.chunks) : '—'}</div><div className="l">{status.index.indexed ? `chunks from ${status.index.files} files, ${fmtK(status.index.symbols)} symbols` : 'not indexed'}</div></div>
						<div className="stat"><div className="v">{status.history ? status.history.commits : '—'}</div><div className="l">{status.history ? `commits mined, ${status.history.hotspots.length} hot spots` : 'no git history'}</div></div>
						<div className="stat"><div className="v">{status.index.embeddings ? 'hybrid' : 'BM25'}</div><div className="l">{status.index.embeddings ? 'semantic and lexical search' : 'lexical search; embeddings off'}</div></div>
					</div>
				</div>
				<div className="panel">
					<div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
						<Ring items={checks} />
						<div><h2>Claude Code in this repository</h2><div className="small muted">{checks.filter(x => x.ok).length === checks.length ? 'Everything is wired.' : 'What is still missing for the hooks, commands and brief to reach Claude Code.'}</div></div>
					</div>
					<div className="stack" style={{ gap: 6, marginTop: 12 }}>{checks.map((x, i) => <St key={i} ok={x.ok} warn={!x.ok && i === 4 && c.instructionCurrent}>{x.label}</St>)}</div>
					<div className="row" style={{ marginTop: 12 }}>
						{status.daemon.surface === 'vscode' ? <Btn onClick={() => act('Set up Claude Code', () => api.post('/claude-setup', {}))} disabled={!!busy}>Run setup</Btn> : <span className="small muted">Run <code>riaf init --host claude</code>, or in VS Code: RIAF: Set up Claude Code.</span>}
						<Btn kind="ghost" onClick={() => go('governance')}>Policy and rules</Btn>
					</div>
				</div>
			</div>

			<div className="grid2" style={{ marginTop: 16 }}>
				<div className="panel">
					<div className="row" style={{ justifyContent: 'space-between' }}><h2>Tool calls the governor avoided</h2><Btn sm kind="ghost" onClick={() => go('sessions')}>All sessions</Btn></div>
					{sessions.length ? <>
						<div className="bars" style={{ marginTop: 10 }} role="img" aria-label="tokens served from the index per session">{sessions.map(s => <i key={s.sessionId} style={{ height: `${Math.max(4, (Number(s.counters.tokensServed) || 0) / maxSaved * 100)}%` }} title={`${s.sessionId.slice(0, 8)}: ${fmtK(Number(s.counters.tokensServed) || 0)} tokens served, ${s.counters.served} served, ${s.counters.blocked} blocked`} />)}</div>
						<div className="small muted" style={{ marginTop: 6 }}>Last {sessions.length} sessions. This week: {g.week.served + g.week.blocked} of {g.week.proposed} proposed calls answered from the index ({fmtK(g.week.tokensServed)} tokens). All time: {g.proposed ? Math.round((g.served + g.blocked) / g.proposed * 100) : 0}% avoided.</div>
					</> : <Empty title="No governed sessions yet">Start Claude Code in this repository with the hooks installed, or ask @riaf in VS Code. Each session appears here with what the governor served, blocked and let through.</Empty>}
				</div>
				<div className="panel stack">
					<h2>Models and routing</h2>
					{status.vscode ? <>
						<div className="small">Chat model <code>{status.vscode.model}</code>{status.vscode.gateway && <> through <code>{status.vscode.gateway}</code></>}</div>
						<div className="small">Intent arbiter <code>{status.vscode.classifyModel ?? 'chat model'}</code></div>
						<div className="row">{Object.entries(status.vscode.instruction).map(([k, v]) => <Chip key={k}>{k} {String(v)}</Chip>)}</div>
					</> : <div className="small muted">Standalone daemon: the offline lexicon classifies; the model arbiter runs only inside VS Code. {status.feedback} intent corrections recorded for this repository.</div>}
					<hr className="rule" />
					<div className="row">
						<Btn sm onClick={() => act('Reindex', () => api.post('/reindex', { force: false }))} disabled={!!busy}>Reindex changed files</Btn>
						<Btn sm onClick={() => act('Full reindex', () => api.post('/reindex', { force: true }))} disabled={!!busy}>Rebuild the index</Btn>
						{busy && <span className="small muted">{busy}…</span>}
					</div>
					<div className="tiny muted">riafd pid {status.daemon.pid}, up {Math.round(status.daemon.uptimeMs / 60000)} min, loopback only; token in <code>.riaf/daemon.json</code></div>
				</div>
			</div>
		</>
	);
}
