import React, { useState } from 'react';
import { Badge, Button, Note, Section, StatCard } from '../../webview/ui.js';
import { ago, api, fmtK, type Status } from '../api.js';

export function Overview({ status, refresh, go }: { status: Status | null; refresh: () => Promise<void>; go: (p: 'overview' | 'repository' | 'pack' | 'adapters' | 'governance' | 'sessions', q?: string) => void }) {
	const [busy, setBusy] = useState<string | null>(null);
	const [msg, setMsg] = useState<string | null>(null);
	if (!status) return <Section id="overview" title="Overview"><div className="muted">Connecting to riafd…</div></Section>;
	const g = status.governance;
	const avoided = g.proposed ? Math.round((g.served + g.blocked) / g.proposed * 100) : 0;
	const c = status.claude;
	const act = async (label: string, fn: () => Promise<unknown>) => { setBusy(label); setMsg(null); try { const r = await fn(); setMsg(typeof r === 'string' ? r : `${label}: done`); await refresh(); } catch (e) { setMsg(`${label} failed: ${(e as Error).message}`); } finally { setBusy(null); } };
	return (
		<Section id="overview" title="Overview" desc={`${status.repo.root} · HEAD ${status.repo.head?.slice(0, 8) ?? 'no git'}${status.repo.branch ? ` (${status.repo.branch})` : ''}`}>
			<div className="rowflex">
				<StatCard label="Index" value={status.index.indexed ? `${fmtK(status.index.chunks)} chunks` : 'not indexed'} sub={status.index.indexed ? `${status.index.files} files · ${fmtK(status.index.symbols)} symbols · ${status.index.lastIndexedAt ? ago(status.index.lastIndexedAt) : ''}` : 'run a reindex'} />
				<StatCard label="Embeddings" value={status.index.embeddings ? 'hybrid' : 'BM25 only'} sub={status.index.embeddings ? 'semantic + lexical' : 'enable in VS Code settings'} />
				<StatCard label="Git history" value={status.history ? String(status.history.commits) : '—'} sub={status.history ? `${status.history.hotspots.length} hot spots` : 'no git'} />
				<StatCard label="Tokens saved (7d)" value={fmtK(g.week.tokensServed)} sub={`${g.week.sessions} sessions · ${g.week.served + g.week.blocked} calls avoided`} />
				<StatCard label="Calls avoided (all)" value={`${avoided}%`} sub={`${g.served} served · ${g.blocked} blocked of ${g.proposed}`} />
			</div>

			<div className="grid2">
				<div className="panel stack">
					<div style={{ fontWeight: 600 }}>Current instruction</div>
					{status.instruction ? <>
						<div><span className="chip accent">{status.instruction.type}</span><span className="chip">{status.instruction.confidence}</span>{status.instruction.planGate && <span className="chip hot">plan gate</span>}<span className="muted" style={{ fontSize: 11 }}>{status.instruction.id} · {ago(Date.parse(status.instruction.generated_at))} · {fmtK(status.instruction.tokens)} tokens</span></div>
						<div style={{ fontSize: 12 }}>{status.instruction.request}</div>
						<div className="rowflex"><Button small kind="primary" onClick={() => go('pack')}>Open in Pack Studio</Button></div>
					</> : <div className="muted">None yet — compile one in Pack Studio, or ask <code>@riaf</code> in VS Code.</div>}
					{status.instructions.length > 1 && <div className="muted" style={{ fontSize: 11 }}>Recent: {status.instructions.slice(0, 6).map(i => <span key={i.id} className="chip" title={i.request}>{i.type ?? '?'} {i.id}</span>)}</div>}
				</div>
				<div className="panel stack">
					<div style={{ fontWeight: 600 }}>Claude Code setup in this repo</div>
					<Badge ok={c.mcpJson && !c.mcpStale} warn={!!c.mcpStale} text={c.mcpJson ? (c.mcpStale ? `.mcp.json ${c.mcpStale}` : '.mcp.json has the riaf server') : '.mcp.json not set up'} />
					<Badge ok={c.governHook} text={c.governHook ? 'governance hook installed (.claude/hooks/riaf-govern.mjs)' : 'governance hook missing'} />
					<Badge ok={c.commands.length > 0} text={c.commands.length ? `${c.commands.length} slash commands: ${c.commands.map(x => '/' + x.replace(/\.md$/, '')).join(' ')}` : 'no /riaf-* commands'} />
					<Badge ok={c.claudeMdRules} text={c.claudeMdRules ? 'CLAUDE.md carries the RIAF protocol' : 'CLAUDE.md protocol block missing'} />
					<Badge ok={c.claudeMdInstruction} warn={!c.claudeMdInstruction && c.instructionCurrent} text={c.claudeMdInstruction ? 'CLAUDE.md carries the current instruction' : c.instructionCurrent ? 'instruction not yet sent (Pack Studio → Send to Claude Code)' : 'no instruction sent yet'} />
					<Badge ok={c.policy} text={c.policy ? '.riaf/policy.yaml present' : 'no policy file (defaults apply)'} />
					<div className="rowflex">
						{status.daemon.surface === 'vscode' && <Button small onClick={() => act('Set up Claude Code', () => api.post('/claude-setup', {}))} disabled={!!busy}>Run setup</Button>}
						{status.daemon.surface !== 'vscode' && <span className="muted" style={{ fontSize: 11 }}>Run <code>riaf init --host claude</code> or VS Code → RIAF: Set up Claude Code.</span>}
						<Button small onClick={() => go('governance')}>Policy &amp; rules</Button>
					</div>
				</div>
			</div>

			<div className="grid2">
				<div className="panel stack">
					<div style={{ fontWeight: 600 }}>Models &amp; routing</div>
					{status.vscode ? <>
						<div style={{ fontSize: 12 }}>Chat model: <code>{status.vscode.model}</code>{status.vscode.gateway && <> via <code>{status.vscode.gateway}</code></>}</div>
						<div style={{ fontSize: 12 }}>Intent arbiter model: <code>{status.vscode.classifyModel ?? '(chat model)'}</code></div>
						<div style={{ fontSize: 12 }}>Routing: {Object.entries(status.vscode.instruction).map(([k, v]) => <span key={k} className="chip">{k}={String(v)}</span>)}</div>
					</> : <div className="muted" style={{ fontSize: 12 }}>Standalone daemon: tier-1 lexicon classifier only (no model arbiter). Intent corrections recorded: {status.feedback}.</div>}
				</div>
				<div className="panel stack">
					<div style={{ fontWeight: 600 }}>Actions</div>
					<div className="rowflex">
						<Button small onClick={() => act('Reindex', () => api.post('/reindex', { force: false }))} disabled={!!busy}>Reindex (incremental)</Button>
						<Button small onClick={() => act('Full reindex', () => api.post('/reindex', { force: true }))} disabled={!!busy}>Full reindex</Button>
						<Button small onClick={() => go('repository')}>Browse repository</Button>
						<Button small onClick={() => go('sessions')}>Sessions</Button>
					</div>
					{busy && <div className="muted">{busy}…</div>}
					{msg && <Note>{msg}</Note>}
					<div className="muted" style={{ fontSize: 11 }}>riafd pid {status.daemon.pid} · up {Math.round(status.daemon.uptimeMs / 60000)} min · loopback only, token in <code>.riaf/daemon.json</code></div>
				</div>
			</div>
		</Section>
	);
}
