import React, { useEffect, useState } from 'react';
import { Button, Note, Section, Select, TextArea, TextInput } from '../../webview/ui.js';
import { api, fmtK, type Instruction, type PackMeta, type Route, type Status } from '../api.js';
import { mdToHtml } from '../md.js';

const TYPES = ['bugfix', 'feature', 'refactor', 'explain', 'test', 'migrate', 'review'];
const FORMATS = ['claude', 'copilot', 'markdown', 'agents-md', 'openai', 'gemini', 'json'] as const;

export function PackStudio({ status, refresh }: { status: Status | null; refresh: () => Promise<void> }) {
	const [request, setRequest] = useState('');
	const [activeFile, setActiveFile] = useState('');
	const [budget, setBudget] = useState<number | ''>('');
	const [route, setRoute] = useState<Route | null>(null);
	const [pack, setPack] = useState<PackMeta | null>(null);
	const [instr, setInstr] = useState<Instruction | null>(null);
	const [busy, setBusy] = useState<'classify' | 'compile' | 'send' | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [view, setView] = useState<'instruction' | 'items' | 'render'>('instruction');
	const [format, setFormat] = useState<typeof FORMATS[number]>('claude');
	const [rendered, setRendered] = useState('');
	const [sent, setSent] = useState<{ written: string[]; command: string } | null>(null);
	const [history, setHistory] = useState<{ id: string; generated_at: number; request?: string; type?: string }[]>([]);
	const [compare, setCompare] = useState<{ id: string; markdown: string } | null>(null);

	useEffect(() => {
		api.get<{ instruction: Instruction | null; pack: PackMeta | null }>('/instruction/current').then(r => { if (r.instruction) { setInstr(r.instruction); setRequest(r.instruction.request); } if (r.pack) setPack(r.pack); }).catch(() => undefined);
		api.get<{ instructions: typeof history }>('/instructions').then(r => setHistory(r.instructions)).catch(() => undefined);
	}, []);

	// Live classification while typing (debounced; tier 1 only costs a few ms server-side).
	useEffect(() => {
		if (request.trim().split(/\s+/).length < 3) { setRoute(null); return; }
		const t = setTimeout(() => { api.post<Route>('/classify', { request, activeFile: activeFile || undefined }).then(setRoute).catch(() => undefined); }, 350);
		return () => clearTimeout(t);
	}, [request, activeFile]);

	const compile = async (fresh = false) => {
		setBusy('compile'); setError(null); setSent(null);
		try {
			const r = await api.post<{ route: Route; pack: PackMeta; instruction: Instruction }>('/instruction', { request, activeFile: activeFile || undefined, budget: budget === '' ? undefined : Number(budget), fresh, host: 'claude' });
			setRoute(r.route); setPack(r.pack); setInstr(r.instruction); setView('instruction');
			setHistory(h => [{ id: r.instruction.instruction_id, generated_at: Date.now(), request: r.instruction.request, type: r.instruction.intent.type }, ...h].slice(0, 100));
			await refresh();
		} catch (e) { setError((e as Error).message); } finally { setBusy(null); }
	};
	const renderAs = async (f: typeof FORMATS[number]) => { setFormat(f); try { const r = await api.post<{ text: string }>('/pack/render', { format: f }); setRendered(r.text); } catch (e) { setError((e as Error).message); } };
	const send = async () => { setBusy('send'); try { setSent(await api.post('/send-to-claude', {})); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } };
	const copy = async (text: string) => { await navigator.clipboard.writeText(text); };
	const feedback = async (corrected: string) => { if (!route) return; await api.post('/feedback', { request, predicted: route.type, corrected }); const r = await api.post<Route>('/classify', { request }); setRoute(r); await refresh(); };
	const loadOld = async (id: string) => { const r = await api.get<{ id: string; markdown: string }>(`/instruction?id=${id}`); setCompare(r); };

	const retrievers = pack ? Object.entries(pack.provenance.retrievers) : [];
	return (
		<Section id="pack" title="Pack Studio" desc="Type a task → see how RIAF classifies it → compile the Context Pack and the Prompt Instruction → send to Claude Code or export for any model.">
			<div className="grid2">
				<div className="stack">
					<TextArea value={request} onChange={setRequest} rows={4} placeholder="e.g. Fix the NullPointerException in OrderService.capture when the card is expired — do not change the public API" />
					<div className="rowflex">
						<div style={{ flex: 1 }}><TextInput mono value={activeFile} onChange={setActiveFile} placeholder="active file (optional, e.g. src/services/orderService.ts)" /></div>
						<div style={{ width: 120 }}><TextInput mono value={budget === '' ? '' : String(budget)} onChange={v => setBudget(v === '' ? '' : Number(v) || '')} placeholder="budget tokens" /></div>
					</div>
					<div className="rowflex">
						<Button kind="primary" disabled={!request.trim() || !!busy} onClick={() => void compile(false)}>{busy === 'compile' ? 'Compiling…' : 'Compile instruction'}</Button>
						<Button disabled={!request.trim() || !!busy} onClick={() => void compile(true)}>Recompile fresh</Button>
						{instr && <Button disabled={!!busy} onClick={() => void send()}>{busy === 'send' ? 'Writing…' : 'Send to Claude Code'}</Button>}
						{instr && <Button onClick={() => void copy(instr.markdown)}>Copy instruction</Button>}
					</div>
					{error && <Note kind="warn">{error}</Note>}
					{sent && <Note>Written {sent.written.join(', ')}. In a terminal in this repo run: <code>{sent.command}</code> — or in Claude Code type <code>/riaf-instruction</code>.</Note>}
				</div>
				<div className="panel stack">
					<div style={{ fontWeight: 600 }}>Classification {route?.arbiter?.used && <span className="chip accent">arbiter {route.arbiter.ms} ms</span>}</div>
					{!route && <div className="muted">Start typing a task (3+ words). Tier 1 is the offline lexicon; the arbiter runs only when it is unsure.</div>}
					{route && <>
						<div className="rowflex">
							<span className="chip accent" style={{ fontSize: 13 }}>{route.type}</span>{route.secondaryType && <span className="chip">+ {route.secondaryType}</span>}
							<span className="chip">confidence {route.confidence}</span><span className="chip">{route.source}</span>
							<span className="chip">mode {route.mode}</span><span className="chip">tools {route.tools}</span><span className="chip">budget {fmtK(route.budget)}</span><span className="chip">stage {route.stage}</span>
							{route.planGate && <span className="chip hot">plan gate</span>}{route.scope && <span className="chip">scope {route.scope}</span>}
						</div>
						<div className="bar"><span style={{ width: `${Math.round(route.confidence * 100)}%` }} /></div>
						{route.intent.entities.filter(e => e.kind !== 'term').length > 0 && <div style={{ fontSize: 12 }}>Entities: {route.intent.entities.filter(e => e.kind !== 'term').map(e => <span key={e.kind + e.value} className="chip" title={e.resolved?.join(', ')}>{e.kind}: {e.value}{e.resolved ? ' ✓' : ''}</span>)}</div>}
						{route.intent.constraints.length > 0 && <div style={{ fontSize: 12 }}>Constraints: {route.intent.constraints.map(c => <span key={c} className="chip">{c}</span>)}</div>}
						{route.intent.acceptance.length > 0 && <div style={{ fontSize: 12 }}>Acceptance: {route.intent.acceptance.map(c => <span key={c} className="chip test">{c}</span>)}</div>}
						{route.askFirst && <Note kind="warn">RIAF would ask before starting: {route.questions.join(' · ')}</Note>}
						<div className="rowflex" style={{ fontSize: 11 }}><span className="muted">Wrong?</span>{TYPES.filter(t => t !== route.type).map(t => <a key={t} href="#" onClick={e => { e.preventDefault(); void feedback(t); }}>{t}</a>)}</div>
					</>}
				</div>
			</div>

			{pack && (
				<div className="rowflex" style={{ fontSize: 12 }}>
					<span className="chip accent">pack {pack.pack_id.slice(0, 8)}</span><span className="chip">{pack.items.length} items</span><span className="chip">{fmtK(pack.budget.used_tokens)} / {fmtK(pack.budget.max_tokens)} tokens</span><span className="chip">{pack.provenance.compile_ms} ms</span>
					{retrievers.map(([k, n]) => <span key={k} className="chip" title="retriever → candidates">{k} {n}</span>)}
					<span style={{ flex: 1 }} />
					{(['instruction', 'items', 'render'] as const).map(v => <Button key={v} small kind={view === v ? 'primary' : 'secondary'} onClick={() => { setView(v); if (v === 'render' && !rendered) void renderAs(format); }}>{v}</Button>)}
				</div>
			)}

			{view === 'instruction' && instr && (
				<div className="grid2">
					<div className="panel md" style={{ maxHeight: '70vh', overflow: 'auto' }} dangerouslySetInnerHTML={{ __html: mdToHtml(instr.markdown) }} />
					<div className="stack">
						<div className="panel stack">
							<div style={{ fontWeight: 600 }}>Instruction {instr.instruction_id} <span className="muted" style={{ fontWeight: 400 }}>· {fmtK(instr.tokens)} tokens · stable half {instr.stable_hash}</span></div>
							<div style={{ fontSize: 12 }}>Plan ({instr.plan.length} steps){instr.findings.length ? ` · ${instr.findings.length} findings attached` : ''} · Verification ({instr.verification.length}) · Rules: {instr.rules_sources.join(', ') || 'none'}</div>
							<div className="muted" style={{ fontSize: 11 }}>Saved at <code>.claude/riaf/instructions/{instr.instruction_id}.md</code> (= current.md). The Claude Code hook injects it on the next prompt; <code>/riaf-instruction</code> loads it on demand.</div>
						</div>
						{history.length > 1 && <div className="panel stack">
							<div style={{ fontWeight: 600 }}>Earlier instructions</div>
							<table><thead><tr><th>id</th><th>type</th><th>request</th><th></th></tr></thead><tbody>
								{history.filter(h => h.id !== instr.instruction_id).slice(0, 8).map(h => <tr key={h.id}><td className="mono">{h.id}</td><td>{h.type}</td><td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.request}</td><td><a href="#" onClick={e => { e.preventDefault(); void loadOld(h.id); }}>compare</a></td></tr>)}
							</tbody></table>
							{compare && <div><div className="muted" style={{ fontSize: 11 }}>Instruction {compare.id} (plan + verification only)</div><pre style={{ maxHeight: 260, overflow: 'auto' }}>{sliceSection(compare.markdown)}</pre><Button small onClick={() => setCompare(null)}>close</Button></div>}
						</div>}
					</div>
				</div>
			)}

			{view === 'items' && pack && (
				<table>
					<thead><tr><th>#</th><th>path</th><th>kind</th><th>form</th><th>score</th><th>tokens</th><th>why it is in the pack</th></tr></thead>
					<tbody>{pack.items.map((it, i) => (
						<tr key={i} className="clickable" onClick={() => { location.hash = `/repository?path=${encodeURIComponent(it.path.replace(/^\(.*\)$/, ''))}`; }}>
							<td>{i + 1}</td><td className="mono">{it.path}{it.range ? `:${it.range[0]}-${it.range[1]}` : ''}</td><td><span className={`chip ${it.kind === 'test' ? 'test' : ''}`}>{it.kind}</span></td><td>{it.form ?? 'body'}</td><td>{it.score}</td><td>{it.tokens}</td><td style={{ fontSize: 11 }}>{it.why}</td>
						</tr>
					))}</tbody>
				</table>
			)}

			{view === 'render' && (
				<div className="stack">
					<div className="rowflex"><span className="muted">Portable pack for:</span><Select value={format} onChange={v => void renderAs(v)} options={FORMATS.map(f => ({ value: f, label: f }))} /><Button small onClick={() => void copy(rendered)}>Copy</Button><span className="muted" style={{ fontSize: 11 }}>same as <code>riaf pack --format {format}</code></span></div>
					<pre className="panel" style={{ maxHeight: '60vh', overflow: 'auto' }}>{rendered || '…'}</pre>
				</div>
			)}
			{!instr && !pack && status && <Note>No instruction yet for this repository. Compile one above — it costs no model tokens unless the arbiter runs.</Note>}
		</Section>
	);
}

function sliceSection(md: string): string {
	const a = md.indexOf('## Plan'); const b = md.indexOf('## Budgets'); const c = md.indexOf('## History');
	const end = [b, c].filter(x => x > a)[0] ?? md.length;
	return a >= 0 ? md.slice(a, end) : md.slice(0, 2000);
}
