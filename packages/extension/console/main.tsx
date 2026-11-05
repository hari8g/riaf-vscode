import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, boot, type Status } from './api.js';
import { Palette, ToastHost, useTheme, type PaletteItem } from './kit.js';
import { Overview } from './pages/overview.js';
import { Repository } from './pages/repository.js';
import { Studio } from './pages/studio.js';
import { Adapters } from './pages/adapters.js';
import { Governance } from './pages/governance.js';
import { Sessions } from './pages/sessions.js';

export type Page = 'overview' | 'studio' | 'repository' | 'adapters' | 'governance' | 'sessions';
const PAGES: { id: Page; label: string; icon: React.ReactNode }[] = [
	{ id: 'overview', label: 'Overview', icon: <svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" /><rect x="13" y="11" width="8" height="10" rx="1.5" /><rect x="3" y="14" width="8" height="7" rx="1.5" /></svg> },
	{ id: 'studio', label: 'Studio', icon: <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h7" /><circle cx="18" cy="16" r="3" /></svg> },
	{ id: 'repository', label: 'Repository', icon: <svg viewBox="0 0 24 24"><path d="M4 5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /></svg> },
	{ id: 'adapters', label: 'Adapters', icon: <svg viewBox="0 0 24 24"><path d="M8 7V3M16 7V3M6 7h12v4a6 6 0 0 1-12 0zM12 17v4" /></svg> },
	{ id: 'governance', label: 'Governance', icon: <svg viewBox="0 0 24 24"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" /><path d="M9 12l2 2 4-4" /></svg> },
	{ id: 'sessions', label: 'Sessions', icon: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg> },
];

export function usePage(): [Page, (p: Page, q?: string) => void] {
	const read = (): Page => { const h = location.hash.replace(/^#\/?/, '').split('?')[0] as Page; return PAGES.some(p => p.id === h) ? h : 'overview'; };
	const [page, setPage] = useState<Page>(read);
	useEffect(() => { const on = () => setPage(read()); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);
	return [page, (p, q) => { location.hash = `/${p}${q ? `?${q}` : ''}`; }];
}

export function useStatus(intervalMs = 8_000): { status: Status | null; error: string | null; refresh: () => Promise<void> } {
	const [status, setStatus] = useState<Status | null>(null);
	const [error, setError] = useState<string | null>(null);
	const refresh = async () => { try { setStatus(await api.get<Status>('/status')); setError(null); } catch (e) { setError((e as Error).message); } };
	useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), intervalMs); return () => clearInterval(t); }, []);
	return { status, error, refresh };
}

function App() {
	const [page, go] = usePage();
	const { status, error, refresh } = useStatus();
	const [theme, setTheme] = useTheme();
	const [pal, setPal] = useState(false);
	const repoName = (status?.repo.root ?? boot.root).split(/[\\/]/).filter(Boolean).pop() ?? 'repository';

	useEffect(() => {
		const k = (e: KeyboardEvent) => {
			const typing = (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA';
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPal(v => !v); }
			else if (!typing && e.key === '/') { e.preventDefault(); go('studio'); setTimeout(() => (document.querySelector('.taskline textarea') as HTMLTextAreaElement | null)?.focus(), 50); }
		};
		addEventListener('keydown', k); return () => removeEventListener('keydown', k);
	}, []);

	const palItems: PaletteItem[] = useMemo(() => [
		...PAGES.map(p => ({ id: `page:${p.id}`, label: `Go to ${p.label}`, hint: 'page', run: () => go(p.id) })),
		{ id: 'theme', label: `Theme: ${theme} (switch)`, hint: 'setting', run: () => setTheme(theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto') },
		{ id: 'reindex', label: 'Reindex the repository', hint: 'action', run: () => void api.post('/reindex', { force: false }).then(refresh) },
	], [theme]);
	const palSearch = async (q: string): Promise<PaletteItem[]> => {
		const r = await api.get<{ hits: { filePath: string; startLine: number; name?: string; kind?: string }[] }>(`/repo/search?q=${encodeURIComponent(q)}&mode=structural&limit=8`);
		const files = await api.get<{ hits: { filePath: string; startLine: number }[] }>(`/repo/search?q=${encodeURIComponent(q)}&mode=lexical&limit=6`);
		const seen = new Set<string>();
		return [...r.hits.map(h => ({ id: `sym:${h.filePath}:${h.startLine}`, label: `${h.kind ?? 'symbol'} ${h.name ?? ''}`, hint: `${h.filePath}:${h.startLine}`, run: () => go('repository', `path=${encodeURIComponent(h.filePath)}`) })),
		...files.hits.filter(h => { if (seen.has(h.filePath)) return false; seen.add(h.filePath); return true; }).map(h => ({ id: `file:${h.filePath}`, label: h.filePath, hint: 'file', run: () => go('repository', `path=${encodeURIComponent(h.filePath)}`) }))];
	};

	return (
		<div className="shell">
			<nav className="rail" aria-label="Pages">
				<div className="brand">RIAF Console</div>
				<div className="repo">{repoName}{status?.repo.branch ? <><br />on {status.repo.branch}</> : null}</div>
				{PAGES.map(p => <a key={p.id} href={`#/${p.id}`} className={`nav ${page === p.id ? 'active' : ''}`}>{p.icon}{p.label}</a>)}
				<div className="hint"><span className="kbd">/</span> task <span className="kbd">⌘K</span> jump</div>
				<div className="spacer" />
				<div className="foot">
					{status ? <div className="live">● riafd {status.daemon.version === 'cli' ? 'standalone' : `in VS Code ${status.daemon.version}`}</div> : error ? <div className="down">● {error}</div> : <div>○ connecting</div>}
					<div>{status?.index.indexed ? `${status.index.chunks.toLocaleString()} chunks indexed` : 'not indexed yet'}</div>
					<div>port {status?.daemon.port ?? '…'}</div>
					<div style={{ marginTop: 6 }}><select className="select" value={theme} onChange={e => setTheme(e.target.value as 'auto')} aria-label="Theme" style={{ padding: '2px 6px', fontSize: 12 }}><option value="auto">Theme: system</option><option value="light">Theme: light</option><option value="dark">Theme: dark</option></select></div>
				</div>
			</nav>
			<main className="main">
				{page === 'overview' && <Overview status={status} refresh={refresh} go={go} />}
				{page === 'studio' && <Studio status={status} refresh={refresh} go={go} />}
				{page === 'repository' && <Repository go={go} />}
				{page === 'adapters' && <Adapters />}
				{page === 'governance' && <Governance status={status} refresh={refresh} />}
				{page === 'sessions' && <Sessions />}
			</main>
			<Palette open={pal} onClose={() => setPal(false)} items={palItems} search={palSearch} />
		</div>
	);
}

createRoot(document.getElementById('root')!).render(<ToastHost><App /></ToastHost>);
