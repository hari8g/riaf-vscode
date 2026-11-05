import React, { useEffect, useMemo, useState } from 'react';
import { ago, api, boot, type FileDetail, type TreeFile } from '../api.js';
import { Btn, Chip, Empty, useToast } from '../kit.js';
import type { Page } from '../main.js';

type Node = { name: string; path: string; dirs: Map<string, Node>; files: TreeFile[] };
type Graph = { focus: string; nodes: { id: string; kind: string; hop: number }[]; edges: { from: string; to: string; kind: string; weight?: number }[] };

function buildTree(files: TreeFile[]): Node {
	const root: Node = { name: '', path: '', dirs: new Map(), files: [] };
	for (const f of files) {
		const parts = f.path.split('/');
		let n = root;
		for (let i = 0; i < parts.length - 1; i++) { let d = n.dirs.get(parts[i]); if (!d) { d = { name: parts[i], path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [] }; n.dirs.set(parts[i], d); } n = d; }
		n.files.push(f);
	}
	return root;
}

function Dir({ node, open, toggle, select, selected, filter, depth }: { node: Node; open: Set<string>; toggle: (p: string) => void; select: (p: string) => void; selected: string | null; filter: string; depth: number }) {
	const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
	const files = node.files.filter(f => !filter || f.path.toLowerCase().includes(filter.toLowerCase()));
	const isOpen = open.has(node.path) || !!filter || depth === 0 || (selected?.startsWith(node.path + '/') ?? false);
	return (
		<ul>
			{depth > 0 && <li className="dir" onClick={() => toggle(node.path)}>{isOpen ? '▾' : '▸'} {node.name}</li>}
			{isOpen && <>
				{dirs.map(d => <Dir key={d.path} node={d} open={open} toggle={toggle} select={select} selected={selected} filter={filter} depth={depth + 1} />)}
				{files.map(f => <li key={f.path}><div className={`file ${selected === f.path ? 'sel' : ''}`} onClick={() => select(f.path)}><span className="name">{f.path.split('/').pop()}</span>{f.hot && <span className="dot warn" title="hot spot" />}{f.isTest && <span className="dot ok" title="test" />}{f.importedBy > 2 && <span className="tiny muted" title="importers">{f.importedBy}</span>}</div></li>)}
			</>}
		</ul>
	);
}

/** Radial neighbourhood: focus in the centre, first hop on a ring, second hop outside. No layout library needed. */
function NeighbourhoodGraph({ g, onOpen }: { g: Graph; onOpen: (p: string) => void }) {
	const W = 760, H = 380, cx = W / 2, cy = H / 2;
	const pos = useMemo(() => {
		const m = new Map<string, { x: number; y: number }>();
		m.set(g.focus, { x: cx, y: cy });
		for (const hop of [1, 2]) {
			const ring = g.nodes.filter(n => n.hop === hop && n.id !== g.focus);
			const r = hop === 1 ? 120 : 175;
			ring.forEach((n, i) => { const a = (i / Math.max(1, ring.length)) * Math.PI * 2 - Math.PI / 2 + (hop === 2 ? 0.15 : 0); m.set(n.id, { x: cx + Math.cos(a) * r * (hop === 2 ? 1.9 : 1.6), y: cy + Math.sin(a) * r * 0.95 }); });
		}
		return m;
	}, [g]);
	const label = (p: string) => { const parts = p.split('/'); return parts.length > 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : p; };
	return (
		<svg className="graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`neighbourhood of ${g.focus}`}>
			{g.edges.map((e, i) => { const a = pos.get(e.from), b = pos.get(e.to); return a && b ? <line key={i} className={e.kind === 'co-change' ? 'cochange' : e.kind === 'tests' ? 'tests' : ''} x1={a.x} y1={a.y} x2={b.x} y2={b.y} opacity={e.kind === 'co-change' ? Math.max(0.35, e.weight ?? 0.5) : 0.8}><title>{e.from} {e.kind} {e.to}</title></line> : null; })}
			{g.nodes.map(n => { const p = pos.get(n.id); if (!p) return null; const r = n.id === g.focus ? 9 : n.hop === 1 ? 6 : 4.5; return <g key={n.id} onClick={() => n.id !== g.focus && onOpen(n.id)} className="node"><circle className={n.kind} cx={p.x} cy={p.y} r={r}><title>{n.id} ({n.kind}{n.hop === 2 ? ', two hops away' : ''})</title></circle>{n.hop <= 1 && <text x={p.x} y={p.y + r + 11} textAnchor="middle">{label(n.id)}</text>}</g>; })}
		</svg>
	);
}

export function Repository({ go }: { go: (p: Page, q?: string) => void }) {
	const toast = useToast();
	const [files, setFiles] = useState<TreeFile[]>([]);
	const [filter, setFilter] = useState('');
	const [open, setOpen] = useState<Set<string>>(new Set());
	const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('path'));
	const [detail, setDetail] = useState<FileDetail | null>(null);
	const [graph, setGraph] = useState<Graph | null>(null);
	const [tab, setTab] = useState<'map' | 'outline' | 'source' | 'history'>('map');
	const [q, setQ] = useState('');
	const [mode, setMode] = useState<'lexical' | 'hybrid' | 'structural'>('lexical');
	const [hits, setHits] = useState<{ filePath: string; startLine: number; endLine: number; content?: string; name?: string; kind?: string; signature?: string }[] | null>(null);

	useEffect(() => { api.get<{ files: TreeFile[] }>('/repo/tree').then(r => setFiles(r.files), e => toast((e as Error).message, 'err')); }, []);
	useEffect(() => { const on = () => { const p = new URLSearchParams(location.hash.split('?')[1] ?? '').get('path'); if (p && p !== selected) setSelected(p); }; addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, [selected]);
	useEffect(() => {
		if (!selected) return;
		setDetail(null); setGraph(null);
		api.get<FileDetail>(`/repo/file?path=${encodeURIComponent(selected)}`).then(setDetail, e => toast((e as Error).message, 'err'));
		api.get<Graph>(`/repo/neighborhood?path=${encodeURIComponent(selected)}`).then(setGraph).catch(() => undefined);
	}, [selected]);
	const tree = useMemo(() => buildTree(files), [files]);
	const toggle = (p: string) => setOpen(s => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
	const select = (p: string) => { setSelected(p); location.hash = `/repository?path=${encodeURIComponent(p)}`; };
	const search = async () => { if (!q.trim()) { setHits(null); return; } const r = await api.get<{ hits: typeof hits }>(`/repo/search?q=${encodeURIComponent(q)}&mode=${mode}&limit=20`); setHits(r.hits); };
	const stats = { hot: files.filter(f => f.hot).length, tests: files.filter(f => f.isTest).length };
	const vscodeHref = (p: string) => `vscode://file/${encodeURI((boot.root + '/' + p).replace(/\\/g, '/'))}`;

	return (
		<>
			<h1>Repository</h1>
			<p className="lead">What the index knows: {files.length.toLocaleString()} files, {stats.tests} of them tests, {stats.hot} hot spots. Pick a file to see what it touches and what touches it. Read-only here; edit in VS Code.</p>
			<form className="row" onSubmit={e => { e.preventDefault(); void search(); }}>
				<input className="input" style={{ flex: 1 }} value={q} onChange={e => setQ(e.target.value)} placeholder="Search the index: an identifier, a concept, an error message" aria-label="Search" />
				<select className="select" value={mode} onChange={e => setMode(e.target.value as 'lexical')}><option value="lexical">Text (BM25)</option><option value="hybrid">Hybrid (needs embeddings)</option><option value="structural">Symbols</option></select>
				<Btn kind="primary" type="submit">Search</Btn>{hits && <Btn kind="ghost" onClick={() => setHits(null)}>Clear</Btn>}
			</form>
			{hits && (
				<div className="panel" style={{ marginTop: 12, maxHeight: 340, overflow: 'auto' }}>
					{!hits.length ? <Empty title="Nothing matches">Try an identifier rather than a sentence, or switch to Symbols.</Empty> : hits.map((h, i) => (
						<div key={i} style={{ padding: '6px 0', borderTop: i ? '1px solid var(--line)' : 0 }}>
							<a href="#" className="mono" onClick={e => { e.preventDefault(); select(h.filePath); setTab('source'); }}>{h.filePath}:{h.startLine}{h.endLine && h.endLine !== h.startLine ? `–${h.endLine}` : ''}</a>{h.name && <> <Chip tone="teal">{h.kind} {h.name}</Chip></>}
							{(h.content || h.signature) && <pre className="muted small" style={{ marginTop: 3, maxHeight: 96, overflow: 'hidden' }}>{(h.content ?? h.signature ?? '').slice(0, 360)}</pre>}
						</div>
					))}
				</div>
			)}
			<div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16, marginTop: 14 }}>
				<div className="panel" style={{ maxHeight: '74vh', overflow: 'auto', padding: 12 }}>
					<input className="input" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter files" aria-label="Filter files" />
					<div className="tree" style={{ marginTop: 8 }}><Dir node={tree} open={open} toggle={toggle} select={select} selected={selected} filter={filter} depth={0} /></div>
				</div>
				<div className="panel" style={{ minWidth: 0 }}>
					{!selected && <Empty title="Pick a file">The map shows imports, importers, tests, callers and the files that historically change together.</Empty>}
					{selected && !detail && <div className="muted">Loading {selected}…</div>}
					{detail && <div className="stack">
						<div>
							<div className="row" style={{ justifyContent: 'space-between' }}><h2 className="mono" style={{ fontSize: 14, wordBreak: 'break-all' }}>{detail.path}</h2><div className="row"><a className="btn sm" href={vscodeHref(detail.path)}>Open in VS Code</a><Btn sm kind="ghost" onClick={() => go('studio', `task=${encodeURIComponent(`Explain ${detail.path}`)}`)}>Ask about it</Btn></div></div>
							{detail.summary && <details className="small" style={{ marginTop: 4 }}><summary style={{ cursor: 'pointer', listStyle: 'none' }}>{detail.summary.slice(0, 180)}{detail.summary.length > 180 ? '…' : ''}</summary>{detail.summary.length > 180 && <p className="muted" style={{ marginTop: 4 }}>{detail.summary}</p>}</details>}
							<div className="row" style={{ marginTop: 8 }}>
								<Chip>{detail.lines} lines</Chip><Chip>{detail.expand.importedBy.length} importers</Chip><Chip>{detail.expand.imports.length} imports</Chip><Chip tone="moss">{detail.expand.tests.length} tests</Chip><Chip tone={detail.expand.coChanges.length ? 'ember' : undefined}>{detail.expand.coChanges.length} co-change partners</Chip>
								{detail.history?.hotspot && <Chip tone="ember">hot spot: {detail.history.hotspot.commits365} commits in 12 months, {Math.round(detail.history.hotspot.fixRatio * 100)}% fixes</Chip>}
								{detail.history?.owners?.map(o => <Chip key={o.role}>{o.role} {Math.round(o.share * 100)}%</Chip>)}
							</div>
						</div>
						<div className="tabs">{(['map', 'outline', 'source', 'history'] as const).map(t => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'map' ? 'Neighbourhood' : t === 'outline' ? 'Outline' : t === 'source' ? 'Source' : 'History'}</button>)}</div>
						{tab === 'map' && (graph ? <div><NeighbourhoodGraph g={graph} onOpen={select} /><div className="legend"><span><i style={{ background: 'var(--teal)' }} />this file</span><span><i style={{ background: 'var(--teal-ink)' }} />imports it</span><span><i style={{ background: 'var(--teal-tint-2)' }} />it imports</span><span><i style={{ background: 'var(--moss)' }} />tests</span><span><i style={{ background: 'var(--slate)' }} />callers</span><span><i style={{ background: 'var(--ember)' }} />changes together</span></div></div> : <div className="muted">Building the map…</div>)}
						{tab === 'outline' && <div className="grid2">
							<pre className="codeview" style={{ maxHeight: 380 }}>{detail.expand.outline.join('\n') || 'No symbols extracted for this file.'}</pre>
							<div className="stack small">
								{([['Imported by', detail.expand.importedBy], ['Imports', detail.expand.imports], ['Tests', detail.expand.tests], ['Callers', detail.expand.callers]] as const).map(([t, list]) => list.length ? <div key={t}><b>{t}</b>{list.slice(0, 12).map(p => <div key={p}><a href="#" className="mono" onClick={e => { e.preventDefault(); select(p.split(' ')[0].split('#')[0]); }}>{p}</a></div>)}</div> : null)}
								{detail.expand.coChanges.length > 0 && <div><b>Changes together with</b>{detail.expand.coChanges.map(c => <div key={c.path}><a href="#" className="mono" onClick={e => { e.preventDefault(); select(c.path); }}>{c.path}</a> <span className="muted">{c.support} times, {Math.round(c.confidence * 100)}%</span></div>)}</div>}
							</div>
						</div>}
						{tab === 'source' && <div className="codeview">{detail.content.split('\n').map((l, i) => <div key={i}><span className="ln">{i + 1}</span>{l}</div>)}</div>}
						{tab === 'history' && <pre className="codeview" style={{ maxHeight: '60vh' }}>{detail.historyText || 'No git history for this file.'}</pre>}
					</div>}
				</div>
			</div>
			{files.length > 0 && <div className="tiny muted" style={{ marginTop: 8 }}>Newest indexed change {(() => { const t = Math.max(...files.map(f => f.lastChanged ?? 0)); return t ? ago(t) : 'unknown'; })()}</div>}
		</>
	);
}
