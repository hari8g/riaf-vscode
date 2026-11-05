import React, { useEffect, useMemo, useRef, useState } from 'react';
import { RunPanel } from '../run.js';
import { api, type Instruction, type PackItem, type PackMeta, type Route, type Status } from '../api.js';
import { Arc, Btn, Chip, Drawer, Empty, fmtK, shortPath, useToast } from '../kit.js';
import { mdToHtml } from '../md.js';
import type { Page } from '../main.js';

const TYPES = ['bugfix', 'feature', 'refactor', 'explain', 'test', 'migrate', 'review'];
const FORMATS = ['claude', 'copilot', 'markdown', 'agents-md', 'openai', 'gemini', 'json'] as const;
const EXAMPLES = [
	'Fix the NullPointerException in OrderService.capture when the card is expired — do not change the public API',
	'Add exponential backoff (3 retries, jitter) to the charger status poller and cover it with a test',
	'How does a toll transaction get from the ANPR camera to the settlement table?',
	'Migrate the service from Spring Boot 2 to Spring Boot 3',
];

export function Studio({ status, refresh, go }: { status: Status | null; refresh: () => Promise<void>; go: (p: Page, q?: string) => void }) {
	const toast = useToast();
	const [request, setRequest] = useState('');
	const [activeFile, setActiveFile] = useState('');
	const [budget, setBudget] = useState<number | null>(null);
	const [route, setRoute] = useState<Route | null>(null);
	const [pack, setPack] = useState<PackMeta | null>(null);
	const [instr, setInstr] = useState<Instruction | null>(null);
	const [busy, setBusy] = useState<'compile' | 'send' | null>(null);
	const [pinned, setPinned] = useState<Set<string>>(new Set());
	const [dropped, setDropped] = useState<Set<string>>(new Set());
	const [applied, setApplied] = useState<{ pinned: string[]; excluded: string[] }>({ pinned: [], excluded: [] });
	const [hl, setHl] = useState<number | null>(null);
	const [view, setView] = useState<'brief' | 'items' | 'export'>('brief');
	const [format, setFormat] = useState<typeof FORMATS[number]>('claude');
	const [rendered, setRendered] = useState('');
	const [drawer, setDrawer] = useState<null | 'send'>(null);
	const [sent, setSent] = useState<{ written: string[]; command: string; headless: string } | null>(null);
	const [justCompiled, setJustCompiled] = useState(false);
	const [history, setHistory] = useState<{ id: string; generated_at: number; request?: string; type?: string }[]>([]);
	const ta = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		api.get<{ instruction: Instruction | null; pack: PackMeta | null }>('/instruction/current').then(r => { if (r.instruction) { setInstr(r.instruction); setRequest(r.instruction.request); } if (r.pack) setPack(r.pack); }).catch(() => undefined);
		api.get<{ instructions: typeof history }>('/instructions').then(r => setHistory(r.instructions)).catch(() => undefined);
		const q = new URLSearchParams(location.hash.split('?')[1] ?? '').get('task'); if (q) { setRequest(q); setTimeout(() => ta.current?.focus(), 50); }
	}, []);
	useEffect(() => {
		if (request.trim().split(/\s+/).length < 3) { setRoute(null); return; }
		const t = setTimeout(() => api.post<Route>('/classify', { request, activeFile: activeFile || undefined }).then(setRoute).catch(() => undefined), 300);
		return () => clearTimeout(t);
	}, [request, activeFile]);

	const effectiveBudget = budget ?? route?.budget ?? 16_000;
	const overridesDirty = useMemo(() => JSON.stringify([...pinned].sort()) !== JSON.stringify([...applied.pinned].sort()) || JSON.stringify([...dropped].sort()) !== JSON.stringify([...applied.excluded].sort()), [pinned, dropped, applied]);

	const compile = async (fresh = false) => {
		if (!request.trim()) { ta.current?.focus(); return; }
		setBusy('compile'); setSent(null);
		try {
			const r = await api.post<{ route: Route; pack: PackMeta; instruction: Instruction }>('/instruction', { request, activeFile: activeFile || undefined, budget: effectiveBudget, fresh, host: 'claude', pinned: [...pinned], excluded: [...dropped] });
			setRoute(r.route); setPack(r.pack); setInstr(r.instruction); setApplied({ pinned: [...pinned], excluded: [...dropped] });
			setJustCompiled(true); setTimeout(() => setJustCompiled(false), 700);
			setHistory(h => [{ id: r.instruction.instruction_id, generated_at: Date.now(), request: r.instruction.request, type: r.instruction.intent.type }, ...h.filter(x => x.id !== r.instruction.instruction_id)].slice(0, 100));
			toast(`Compiled ${r.pack.items.length} items in ${r.pack.provenance.compile_ms} ms`);
			await refresh();
		} catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(null); }
	};
	const send = async () => {
		setBusy('send');
		try { const s = await api.post<{ written: string[]; command: string; headless: string }>('/send-to-claude', {}); setSent(s); toast('Written for Claude Code'); await refresh(); }
		catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(null); }
	};
	const copy = async (text: string, what: string) => { await navigator.clipboard.writeText(text); toast(`${what} copied`); };
	const correct = async (t: string) => { if (!route) return; await api.post('/feedback', { request, predicted: route.type, corrected: t }); setRoute(await api.post<Route>('/classify', { request })); toast(`Noted: similar requests will route as ${t}`); };
	const renderAs = async (f: typeof FORMATS[number]) => { setFormat(f); try { setRendered((await api.post<{ text: string }>('/pack/render', { format: f })).text); } catch (e) { toast((e as Error).message, 'err'); } };
	const togglePin = (p: string) => { setPinned(s => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; }); setDropped(s => { const n = new Set(s); n.delete(p); return n; }); };
	const toggleDrop = (p: string) => { setDropped(s => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; }); setPinned(s => { const n = new Set(s); n.delete(p); return n; }); };

	const entities = route?.intent.entities.filter(e => e.kind !== 'term') ?? [];
	const used = pack?.budget.used_tokens ?? 0, max = pack?.budget.max_tokens ?? effectiveBudget;
	const sections = instr ? [...instr.markdown.matchAll(/^## (.+)$/gm)].map(m => m[1]) : [];

	return (
		<>
			<h1>Studio</h1>
			<p className="lead">Describe the task. RIAF classifies it as you type, compiles the context an agent needs, and writes one brief you can read, trim and hand to Claude Code.</p>

			<section className="taskline" aria-label="Task">
				<textarea ref={ta} value={request} onChange={e => setRequest(e.target.value)} placeholder="What should be done? Name files, symbols or error text if you have them." rows={2}
					onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void compile(); } }} />
				<div className="bar">
					<Btn kind="primary" onClick={() => void compile()} disabled={busy === 'compile' || !request.trim()}>{busy === 'compile' ? 'Compiling…' : 'Compile brief'}</Btn>
					<span className="opt"><span className="kbd">⌘↵</span></span>
					<span className="opt">budget <input type="range" min={2000} max={32000} step={1000} value={effectiveBudget} onChange={e => setBudget(Number(e.target.value))} aria-label="Pack budget" /> <b>{fmtK(effectiveBudget)}</b>{budget !== null && route && budget !== route.budget && <a href="#" onClick={e => { e.preventDefault(); setBudget(null); }}>reset to {fmtK(route.budget)}</a>}</span>
					<span className="opt" style={{ flex: 1, minWidth: 220 }}><input className="input" value={activeFile} onChange={e => setActiveFile(e.target.value)} placeholder="Active file, if any (src/…)" aria-label="Active file" style={{ padding: '4px 8px', fontSize: 12.5 }} /></span>
					{!request && <span className="opt">try: {EXAMPLES.map((ex, i) => <a key={i} href="#" onClick={e => { e.preventDefault(); setRequest(ex); }}>{['a bug', 'a feature', 'a question', 'a migration'][i]}</a>)}</span>}
				</div>
				{route && (
					<div className="route" aria-live="polite">
						<Arc value={route.confidence} label={route.source} />
						<div>
							<div className="types"><span className="type">{route.type}</span>{route.secondaryType && <Chip>then {route.secondaryType}</Chip>}<Chip tone={route.mode === 'agent' ? 'teal' : undefined}>{route.mode === 'explain' ? 'read-only answer' : route.mode === 'plan' ? 'plan first' : 'will edit'}</Chip>{route.planGate && <Chip tone="ember">plan gate</Chip>}<Chip>{route.tools === 'read-only' ? 'read tools' : route.tools === 'full' ? 'all tools' : 'read tools, then all'}</Chip>{route.scope && <Chip mono>{route.scope}</Chip>}{route.arbiter?.used && <Chip>arbiter {route.arbiter.ms} ms</Chip>}</div>
							<div className="small muted" style={{ marginTop: 4 }}>Wrong type? {TYPES.filter(t => t !== route.type).map((t, i) => <React.Fragment key={t}>{i > 0 && ' '}<a href="#" onClick={e => { e.preventDefault(); void correct(t); }}>{t}</a></React.Fragment>)}</div>
						</div>
						{(entities.length > 0 || route.intent.constraints.length > 0 || route.intent.acceptance.length > 0) && (
							<div className="facts">
								{entities.map(e => <Chip key={e.kind + e.value} mono tone={e.resolved ? 'teal' : undefined} title={e.resolved ? `resolved: ${e.resolved.join(', ')}` : 'not found in the index'}>{e.kind === 'symbol' ? '{}' : e.kind === 'file' ? '📄' : e.kind === 'error' ? '!' : '#'} {e.value}{e.resolved ? ' ✓' : ''}</Chip>)}
								{route.intent.constraints.map(c => <Chip key={c} tone="ember" title="constraint">must: {c}</Chip>)}
								{route.intent.acceptance.map(c => <Chip key={c} tone="moss" title="acceptance">done when: {c}</Chip>)}
							</div>
						)}
						{route.askFirst && <div className="ask">Before starting, RIAF would ask: {route.questions.join(' ')}</div>}
					</div>
				)}
			</section>

			<div style={{ marginTop: 18 }}><RunPanel go={(page, q) => go(page as Page, q)} /></div>

			{pack && instr ? (
				<div className="stack" style={{ marginTop: 18 }}>
					<div className="panel">
						<div className="row" style={{ justifyContent: 'space-between' }}>
							<div><h2>Context budget</h2><div className="small muted">{pack.items.length} items use {fmtK(used)} of {fmtK(max)} tokens, compiled in {pack.provenance.compile_ms} ms. Hover a segment to find the item; pin or drop items, then recompile.</div></div>
							<div className="row">{Object.entries(pack.provenance.retrievers).map(([k, n]) => <Chip key={k} title="candidates from this retriever">{k} {n}</Chip>)}</div>
						</div>
						<div className={`meter ${justCompiled ? 'fill' : ''}`} style={{ marginTop: 10 }} role="img" aria-label={`${fmtK(used)} of ${fmtK(max)} tokens used`}>
							{pack.items.map((it, i) => <div key={i} className={`seg ${it.kind} ${applied.pinned.includes(it.path) ? 'pinned' : ''} ${hl === i ? 'hl' : ''}`} style={{ width: `${(it.tokens / max) * 100}%`, animationDelay: `${i * 18}ms` }} title={`${it.path} — ${it.tokens} tokens`} onMouseEnter={() => setHl(i)} onMouseLeave={() => setHl(null)} onClick={() => { setView('items'); setHl(i); }} />)}
							<div className="free" title={`${fmtK(max - used)} tokens free`} />
						</div>
						<div className="legend"><span><i style={{ background: 'var(--teal-tint-2)' }} />source</span><span><i style={{ background: 'var(--moss-tint)' }} />tests</span><span><i style={{ background: 'var(--teal-tint)' }} />summaries</span><span><i style={{ background: 'var(--teal)' }} />pinned</span><span><i style={{ background: 'var(--paper-3)' }} />free</span></div>
					</div>

					<div className="row" style={{ justifyContent: 'space-between' }}>
						<div className="tabs" style={{ marginBottom: 0, borderBottom: 0 }}>
							<button className={view === 'brief' ? 'on' : ''} onClick={() => setView('brief')}>Brief for the agent</button>
							<button className={view === 'items' ? 'on' : ''} onClick={() => setView('items')}>How it was built</button>
							<button className={view === 'export' ? 'on' : ''} onClick={() => { setView('export'); if (!rendered) void renderAs(format); }}>Export for other models</button>
						</div>
						<div className="row">
							<Btn onClick={() => void copy(instr.markdown, 'Brief')}>Copy brief</Btn>
							<Btn kind="primary" onClick={() => setDrawer('send')}>Send to Claude Code</Btn>
						</div>
					</div>

					{view === 'brief' && (
						<div className="grid2" style={{ gridTemplateColumns: '1.5fr 1fr' }}>
							<div className="panel">
								<div className="toc">{sections.map(s => <a key={s} href={`#sec-${s.replace(/\W+/g, '-')}`} onClick={e => { e.preventDefault(); document.getElementById(`sec-${s.replace(/\W+/g, '-')}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{s.replace(/\s*\(.*$/, '')}</a>)}</div>
								<div className="doc" style={{ maxHeight: '72vh', overflow: 'auto' }} dangerouslySetInnerHTML={{ __html: withAnchors(mdToHtml(instr.markdown)) }} />
							</div>
							<div className="stack">
								<div className="panel">
									<h3>Brief {instr.instruction_id}</h3>
									<div className="small muted" style={{ marginTop: 4 }}>{fmtK(instr.tokens)} tokens. The first half (conventions, architecture, rules, protocol) is identical across tasks on this commit, so it is cached by the model.</div>
									<hr className="rule" />
									<div className="small"><b>Plan</b> {instr.plan.length} steps{instr.findings.length ? `, ${instr.findings.length} findings attached` : ''}</div>
									<div className="small"><b>Verification</b> {instr.verification.length} checks</div>
									<div className="small"><b>Rules</b> {instr.rules_sources.length ? instr.rules_sources.join(', ') : 'none in this repo'} {!instr.rules_sources.length && <a href="#" onClick={e => { e.preventDefault(); go('governance'); }}>add some</a>}</div>
									<div className="small muted" style={{ marginTop: 6 }}>Saved as <code>.claude/riaf/instructions/current.md</code>. Claude Code's hook injects it on the next prompt; <code>/riaf-instruction</code> loads it on demand.</div>
								</div>
								{history.length > 1 && (
									<div className="panel">
										<h3>Earlier briefs</h3>
										<table className="data" style={{ marginTop: 6 }}><tbody>
											{history.filter(h => h.id !== instr.instruction_id).slice(0, 6).map(h => <tr key={h.id} className="clickable" onClick={() => { setRequest(h.request ?? ''); toast('Request restored, compile to rebuild'); }}><td className="mono">{h.id}</td><td><Chip>{h.type}</Chip></td><td className="muted" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.request}</td></tr>)}
										</tbody></table>
									</div>
								)}
							</div>
						</div>
					)}

					{view === 'items' && (
						<div>
							<div className="items">
								{pack.items.map((it, i) => <ItemRow key={i} i={i} it={it} hl={hl === i} pinned={pinned.has(it.path)} dropped={dropped.has(it.path)} onPin={() => togglePin(it.path)} onDrop={() => toggleDrop(it.path)} onOpen={() => go('repository', `path=${encodeURIComponent(it.path.replace(/^\(.*\)$/, ''))}`)} onHover={h => setHl(h ? i : null)} />)}
							</div>
							{(overridesDirty || pinned.size || dropped.size) ? (
								<div className="pinbar">
									<span>{pinned.size ? `${pinned.size} pinned` : ''}{pinned.size && dropped.size ? ', ' : ''}{dropped.size ? `${dropped.size} dropped` : ''}{!pinned.size && !dropped.size ? 'Overrides cleared' : ''}</span>
									<span style={{ flex: 1 }} />
									{overridesDirty && <Btn kind="primary" sm onClick={() => void compile(true)} disabled={busy === 'compile'}>Recompile with changes</Btn>}
									<Btn sm kind="ghost" onClick={() => { setPinned(new Set()); setDropped(new Set()); }}>Clear</Btn>
								</div>
							) : null}
						</div>
					)}

					{view === 'export' && (
						<div className="panel stack">
							<div className="row"><span className="small muted">Same pack, laid out for</span>{FORMATS.map(f => <Btn key={f} sm kind={format === f ? 'primary' : undefined} onClick={() => void renderAs(f)}>{f}</Btn>)}<span style={{ flex: 1 }} /><Btn sm onClick={() => void copy(rendered, format)}>Copy</Btn><span className="tiny muted">same as <code>riaf pack --format {format}</code></span></div>
							<pre className="codeview" style={{ maxHeight: '60vh' }}>{rendered || '…'}</pre>
						</div>
					)}
				</div>
			) : (
				<div style={{ marginTop: 18 }}>
					<Empty title={status?.index.indexed ? 'No brief for this repository yet' : 'Indexing has not finished'}>{status?.index.indexed ? 'Type a task above and press Compile brief. Classification is free; compiling costs no model tokens.' : 'The Overview page shows progress.'}</Empty>
				</div>
			)}

			<Drawer open={drawer === 'send'} onClose={() => setDrawer(null)} title="Send to Claude Code">
				{instr && <div className="stack">
					<p>This writes brief <code>{instr.instruction_id}</code> into the repository so Claude Code picks it up through every door it has. Nothing leaves your machine.</p>
					<div className="inset" style={{ padding: '10px 12px' }}>
						<div className="small"><code>.claude/riaf/instructions/current.md</code> — injected by the <code>UserPromptSubmit</code> hook and served as <code>riaf://instruction/current</code></div>
						<div className="small"><code>.claude/commands/riaf-task.md</code>, <code>riaf-instruction.md</code> — the <code>/riaf-task</code> and <code>/riaf-instruction</code> commands</div>
						<div className="small"><code>CLAUDE.md</code> — a managed block with the brief id and its cacheable half; your own content stays</div>
					</div>
					{!sent ? <div className="row"><Btn kind="primary" onClick={() => void send()} disabled={busy === 'send'}>{busy === 'send' ? 'Writing…' : 'Write the files'}</Btn><Btn kind="ghost" onClick={() => setDrawer(null)}>Not now</Btn></div> : <>
						<div className="status"><span className="dot ok" />Written: {sent.written.join(', ')}</div>
						<h3>Then, in a terminal in this repository</h3>
						<pre className="codeview" style={{ maxHeight: 120 }}>{sent.command}</pre>
						<div className="row"><Btn sm onClick={() => void copy(sent.command, 'Command')}>Copy command</Btn><Btn sm onClick={() => void copy(sent.headless, 'Headless command')}>Copy headless variant</Btn></div>
						<p className="small muted">Or, inside a running Claude Code session, type <code>/riaf-instruction</code>. From VS Code, the chat card's button opens the terminal for you.</p>
					</>}
				</div>}
			</Drawer>
		</>
	);
}

function ItemRow({ i, it, hl, pinned, dropped, onPin, onDrop, onOpen, onHover }: { i: number; it: PackItem; hl: boolean; pinned: boolean; dropped: boolean; onPin: () => void; onDrop: () => void; onOpen: () => void; onHover: (h: boolean) => void }) {
	const kind = it.kind === 'test' ? 'moss' : it.kind === 'manifest' ? undefined : it.kind === 'file' ? 'teal' : undefined;
	return (
		<div className={`item ${hl ? 'hl' : ''} ${dropped ? 'dropped' : ''}`} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}>
			<span className="muted small">{i + 1}</span>
			<div>
				<div className="row" style={{ gap: 6 }}><a className="path" href="#" onClick={e => { e.preventDefault(); onOpen(); }}>{it.path}{it.range ? `:${it.range[0]}-${it.range[1]}` : ''}</a><Chip tone={kind as 'teal' | 'moss' | undefined}>{it.kind}{it.form && it.form !== 'body' ? `, ${it.form}` : ''}</Chip>{pinned && <Chip tone="teal">pinned</Chip>}{dropped && <Chip tone="ember">dropped</Chip>}</div>
				<div className="why">{it.why}</div>
			</div>
			<span className="tok">{it.tokens} tok</span>
			<div className="acts"><Btn sm kind={pinned ? 'primary' : 'ghost'} onClick={onPin} title="Always include this item">{pinned ? 'Pinned' : 'Pin'}</Btn><Btn sm kind="ghost" onClick={onDrop} title="Exclude this item">{dropped ? 'Keep' : 'Drop'}</Btn></div>
		</div>
	);
}

function withAnchors(html: string): string {
	return html.replace(/<h2>(.*?)<\/h2>/g, (_m, t: string) => `<h2 id="sec-${t.replace(/<[^>]+>/g, '').replace(/\W+/g, '-')}">${t}</h2>`);
}
export { shortPath };
