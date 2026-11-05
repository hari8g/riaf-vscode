import React, { useEffect, useMemo, useState } from 'react';
import { Button, Note, Section, Select, TextInput } from '../../webview/ui.js';
import { ago, api, type FileDetail, type TreeFile } from '../api.js';

type Node = { name: string; path: string; dirs: Map<string, Node>; files: TreeFile[] };

function buildTree(files: TreeFile[]): Node {
	const root: Node = { name: '', path: '', dirs: new Map(), files: [] };
	for (const f of files) {
		const parts = f.path.split('/');
		let n = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const p = parts.slice(0, i + 1).join('/');
			let d = n.dirs.get(parts[i]);
			if (!d) { d = { name: parts[i], path: p, dirs: new Map(), files: [] }; n.dirs.set(parts[i], d); }
			n = d;
		}
		n.files.push(f);
	}
	return root;
}

function Dir({ node, open, toggle, select, selected, filter, depth }: { node: Node; open: Set<string>; toggle: (p: string) => void; select: (p: string) => void; selected: string | null; filter: string; depth: number }) {
	const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
	const match = (f: TreeFile) => !filter || f.path.toLowerCase().includes(filter.toLowerCase());
	const files = node.files.filter(match);
	const isOpen = open.has(node.path) || !!filter || depth === 0;
	return (
		<ul>
			{depth > 0 && <li className="dir" onClick={() => toggle(node.path)}>{isOpen ? '▾' : '▸'} {node.name}/</li>}
			{isOpen && <>
				{dirs.map(d => <Dir key={d.path} node={d} open={open} toggle={toggle} select={select} selected={selected} filter={filter} depth={depth + 1} />)}
				{files.map(f => (
					<li key={f.path} className={`file ${selected === f.path ? 'sel' : ''}`} onClick={() => select(f.path)} style={{ paddingLeft: depth > 0 ? 14 : 0, display: 'flex', gap: 6, alignItems: 'center' }}>
						<span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path.split('/').pop()}</span>
						{f.hot && <span className="chip hot" title="hot spot: many fixes in 12 months">hot</span>}
						{f.isTest && <span className="chip test">test</span>}
						{f.importedBy > 0 && <span className="chip" title="imported by">←{f.importedBy}</span>}
						{f.symbols > 0 && <span className="chip" title="symbols">{f.symbols} sym</span>}
					</li>
				))}
			</>}
		</ul>
	);
}

export function Repository() {
	const [files, setFiles] = useState<TreeFile[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState('');
	const [open, setOpen] = useState<Set<string>>(new Set());
	const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('path'));
	const [detail, setDetail] = useState<FileDetail | null>(null);
	const [tab, setTab] = useState<'outline' | 'content' | 'history'>('outline');
	const [q, setQ] = useState('');
	const [mode, setMode] = useState<'lexical' | 'hybrid' | 'structural'>('lexical');
	const [hits, setHits] = useState<{ filePath: string; startLine: number; endLine: number; content?: string; name?: string; kind?: string; signature?: string }[] | null>(null);

	useEffect(() => { api.get<{ files: TreeFile[] }>('/repo/tree').then(r => setFiles(r.files), e => setError((e as Error).message)); }, []);
	useEffect(() => { if (!selected) return; setDetail(null); api.get<FileDetail>(`/repo/file?path=${encodeURIComponent(selected)}`).then(setDetail, e => setError((e as Error).message)); }, [selected]);
	const tree = useMemo(() => buildTree(files), [files]);
	const toggle = (p: string) => setOpen(s => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
	const select = (p: string) => { setSelected(p); location.hash = `/repository?path=${encodeURIComponent(p)}`; };
	const search = async () => { if (!q.trim()) { setHits(null); return; } const r = await api.get<{ hits: typeof hits }>(`/repo/search?q=${encodeURIComponent(q)}&mode=${mode}&limit=20`); setHits(r.hits); };
	const stats = { hot: files.filter(f => f.hot).length, tests: files.filter(f => f.isTest).length, langs: [...new Set(files.map(f => f.lang))].filter(Boolean).length };

	return (
		<Section id="repository" title="Repository" desc={`${files.length} indexed files · ${stats.langs} languages · ${stats.tests} test files · ${stats.hot} hot spots. Read-only: open a file in VS Code to edit it.`}>
			{error && <Note kind="warn">{error}</Note>}
			<div className="rowflex">
				<div style={{ flex: 1 }}><TextInput value={q} onChange={setQ} placeholder="Search the index: identifiers, concepts, error text (Enter)" /></div>
				<Select value={mode} onChange={setMode} options={[{ value: 'lexical', label: 'BM25 (lexical)' }, { value: 'hybrid', label: 'Hybrid (needs embeddings)' }, { value: 'structural', label: 'Symbols' }]} />
				<Button kind="primary" onClick={() => void search()}>Search</Button>
				{hits && <Button small onClick={() => setHits(null)}>Clear</Button>}
			</div>
			{hits && (
				<div className="panel" style={{ maxHeight: 360, overflow: 'auto' }}>
					<div style={{ fontWeight: 600, marginBottom: 6 }}>{hits.length} results</div>
					{!hits.length && <div className="muted">Nothing indexed matches. Try an identifier rather than prose.</div>}
					{hits.map((h, i) => (
						<div key={i} style={{ padding: '6px 0', borderBottom: '1px solid var(--vscode-editorGroup-border)' }}>
							<a href="#" onClick={e => { e.preventDefault(); select(h.filePath); setTab('content'); }}>{h.filePath}:{h.startLine}{h.endLine && h.endLine !== h.startLine ? `-${h.endLine}` : ''}</a>
							{h.name && <span className="chip accent">{h.kind} {h.name}</span>}
							{(h.content || h.signature) && <pre className="muted" style={{ marginTop: 4, maxHeight: 120, overflow: 'hidden' }}>{(h.content ?? h.signature ?? '').slice(0, 400)}</pre>}
						</div>
					))}
				</div>
			)}
			<div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16, minHeight: 400 }}>
				<div className="panel" style={{ overflow: 'auto', maxHeight: '70vh' }}>
					<TextInput value={filter} onChange={setFilter} placeholder="filter files…" />
					<div className="tree" style={{ marginTop: 8 }}><Dir node={tree} open={open} toggle={toggle} select={select} selected={selected} filter={filter} depth={0} /></div>
				</div>
				<div className="panel stack" style={{ minWidth: 0 }}>
					{!selected && <div className="muted">Select a file to see its outline, neighbourhood and history.</div>}
					{selected && !detail && <div className="muted">Loading {selected}…</div>}
					{detail && <>
						<div style={{ fontWeight: 600, wordBreak: 'break-all' }}>{detail.path} <span className="muted" style={{ fontWeight: 400 }}>· {detail.lines} lines</span></div>
						{detail.summary && <div style={{ fontSize: 12 }}>{detail.summary}</div>}
						<div className="rowflex">
							{detail.history?.hotspot && <span className="chip hot">hot spot: {detail.history.hotspot.commits365} commits/12 mo, fix ratio {Math.round(detail.history.hotspot.fixRatio * 100)}%</span>}
							{detail.history?.owners?.map(o => <span key={o.role} className="chip">{o.role} {Math.round(o.share * 100)}%</span>)}
							<span className="chip">{detail.expand.importedBy.length} importers</span><span className="chip">{detail.expand.imports.length} imports</span><span className="chip test">{detail.expand.tests.length} tests</span><span className="chip">{detail.expand.coChanges.length} co-change partners</span>
							<a href={`vscode://file/${encodeURI(((window as unknown as { __RIAF__: { root: string } }).__RIAF__.root + '/' + detail.path).replace(/\\/g, '/'))}`} className="chip accent">open in VS Code</a>
						</div>
						<div className="rowflex">{(['outline', 'content', 'history'] as const).map(t => <Button key={t} small kind={tab === t ? 'primary' : 'secondary'} onClick={() => setTab(t)}>{t}</Button>)}</div>
						{tab === 'outline' && <div className="grid2">
							<div>
								<div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>OUTLINE</div>
								<pre style={{ maxHeight: 360, overflow: 'auto' }}>{detail.expand.outline.join('\n') || '(no symbols)'}</pre>
							</div>
							<div className="stack">
								{([['Imported by', detail.expand.importedBy], ['Imports', detail.expand.imports], ['Tests', detail.expand.tests], ['Callers', detail.expand.callers]] as const).map(([t, list]) => list.length ? (
									<div key={t}><div className="muted" style={{ fontSize: 11 }}>{t.toUpperCase()}</div>{list.slice(0, 12).map(p => <div key={p}><a href="#" onClick={e => { e.preventDefault(); select(p.split(' ')[0].split('#')[0]); }}>{p}</a></div>)}</div>
								) : null)}
								{detail.expand.coChanges.length > 0 && <div><div className="muted" style={{ fontSize: 11 }}>CO-CHANGES (history)</div>{detail.expand.coChanges.map(c => <div key={c.path}><a href="#" onClick={e => { e.preventDefault(); select(c.path); }}>{c.path}</a> <span className="muted">{c.support}× · {Math.round(c.confidence * 100)}%</span></div>)}</div>}
							</div>
						</div>}
						{tab === 'content' && <pre style={{ maxHeight: '60vh', overflow: 'auto', background: 'var(--vscode-textBlockQuote-background)', padding: 8 }}>{detail.content.split('\n').map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join('\n')}</pre>}
						{tab === 'history' && <pre style={{ maxHeight: '60vh', overflow: 'auto' }}>{detail.historyText || 'No git history for this file.'}</pre>}
					</>}
				</div>
			</div>
			{files.length > 0 && <div className="muted" style={{ fontSize: 11 }}>Last indexed change: {(() => { const t = Math.max(...files.map(f => f.lastChanged ?? 0)); return t ? ago(t) : 'n/a'; })()}</div>}
		</Section>
	);
}
