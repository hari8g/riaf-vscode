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
import { LiveRunProvider, StatusPill, useLive } from './run.js';

export type Page = 'overview' | 'studio' | 'repository' | 'adapters' | 'governance' | 'sessions';
const PAGES: { id: Page; label: string; key: string; icon: React.ReactNode }[] = [
	{ id: 'overview', key: 'o', label: 'Overview', icon: <svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" /><rect x="13" y="11" width="8" height="10" rx="1.5" /><rect x="3" y="14" width="8" height="7" rx="1.5" /></svg> },
	{ id: 'studio', key: 's', label: 'Studio', icon: <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h7" /><circle cx="18" cy="16" r="3" /></svg> },
	{ id: 'repository', key: 'r', label: 'Repository', icon: <svg viewBox="0 0 24 24"><path d="M4 5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /></svg> },
	{ id: 'adapters', key: 'a', label: 'Adapters', icon: <svg viewBox="0 0 24 24"><path d="M8 7V3M16 7V3M6 7h12v4a6 6 0 0 1-12 0zM12 17v4" /></svg> },
	{ id: 'governance', key: 'g', label: 'Governance', icon: <svg viewBox="0 0 24 24"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" /><path d="M9 12l2 2 4-4" /></svg> },
	{ id: 'sessions', key: 'e', label: 'Sessions', icon: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg> },
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

/** Top bar: where you are, the live state of Claude Code, search, theme. */
function TopBar({ page, repoName, branch, theme, setTheme, openPalette }: { page: Page; repoName: string; branch?: string; theme: string; setTheme: (t: 'auto' | 'light' | 'dark') => void; openPalette: () => void }) {
	const { summary } = useLive();
	const label = PAGES.find(p => p.id === page)?.label ?? '';
	const next = theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto';
	return (
		<header className="topbar">
			<div className="crumbs"><span className="repo-chip" title={boot.root}>{repoName}</span>{branch && <span className="muted"> · {branch}</span>}<span className="sep">/</span><b>{label}</b></div>
			<div className="grow" />
			<a className="runlink" href="#/studio" title="Claude Code status for this repository">{summary ? <StatusPill status={summary.status} /> : <span className="pill idle"><i />Claude Code idle</span>}</a>
			<button className="searchbtn" onClick={openPalette} aria-label="Search or jump"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg><span>Search or jump</span><span className="kbd">⌘K</span></button>
			<button className="iconbtn" onClick={() => setTheme(next)} title={`Theme: ${theme} (click for ${next})`} aria-label="Switch theme">
				{theme === 'dark' ? <svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg> : theme === 'light' ? <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5" /></svg> : <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M12 4v16" /></svg>}
			</button>
		</header>
	);
}

function App() {
	const [page, go] = usePage();
	const { status, error, refresh } = useStatus();
	const [theme, setTheme] = useTheme();
	const [pal, setPal] = useState(false);
	const repoName = (status?.repo.root ?? boot.root).split(/[\\/]/).filter(Boolean).pop() ?? 'repository';

	useEffect(() => {
		let chord = 0; // "g" then a letter jumps to a page
		const k = (e: KeyboardEvent) => {
			const el = e.target as HTMLElement;
			const typing = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT' || el?.isContentEditable;
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPal(v => !v); return; }
			if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
			if (e.key === '/') { e.preventDefault(); go('studio'); setTimeout(() => (document.querySelector('.taskline textarea') as HTMLTextAreaElement | null)?.focus(), 50); return; }
			if (chord && Date.now() - chord < 1200) { const hit = PAGES.find(p => p.key === e.key.toLowerCase()); chord = 0; if (hit) { e.preventDefault(); go(hit.id); } return; }
			if (e.key === 'g') chord = Date.now();
		};
		addEventListener('keydown', k); return () => removeEventListener('keydown', k);
	}, []);
	// The daemon behind this page can be replaced (another repo opened on the same port). Never show one repo's data as another's.
	const served = status?.repo.root;
	const wrongRepo = !!served && !!boot.root && served !== boot.root;

	const palItems: PaletteItem[] = useMemo(() => [
		...PAGES.map(p => ({ id: `page:${p.id}`, label: `Go to ${p.label}`, hint: `g ${p.key}`, run: () => go(p.id) })),
		{ id: 'newtask', label: 'New task (clear the prompt window)', hint: 'action', run: () => { try { sessionStorage.clear(); } catch { /* ignore */ } location.hash = '/studio'; location.reload(); } },
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
				<div className="brandbox">
					<span className="logo"><img src="mps-logo.png" alt="Bosch MPS — Mobility Platform and Services" width={52} height={34} /></span>
					<div className="brand">RIAF Console<small>Repository Intelligence &amp; Agent Loop</small></div>
				</div>
				<div className="repo">{repoName}{status?.repo.branch ? <><br />on {status.repo.branch}</> : null}</div>
				{PAGES.map(p => <a key={p.id} href={`#/${p.id}`} className={`nav ${page === p.id ? 'active' : ''}`}>{p.icon}<span>{p.label}</span>{p.id === 'sessions' && <LiveDot />}<kbd>{p.key}</kbd></a>)}
				<div className="hint"><span className="kbd">/</span> new task <span className="kbd">g</span> then a letter to jump</div>
				<div className="spacer" />
				<div className="foot">
					{status ? <div className="live">● riafd {status.daemon.version === 'cli' ? 'standalone' : `in VS Code ${status.daemon.version}`}</div> : error ? <div className="down">● {error}</div> : <div>○ connecting</div>}
					<div>{status?.index.indexed ? `${status.index.chunks.toLocaleString()} chunks indexed` : 'not indexed yet'}</div>
					<div>port {status?.daemon.port ?? '…'}</div>
				</div>
			</nav>
			<div className="content">
			<TopBar page={page} repoName={repoName} branch={status?.repo.branch} theme={theme} setTheme={setTheme} openPalette={() => setPal(true)} />
			{wrongRepo && <div className="banner warn" role="alert"><span>This page was opened for <b>{boot.root.split(/[\\/]/).filter(Boolean).pop()}</b>, but the console behind it now serves <b>{served?.split(/[\\/]/).filter(Boolean).pop()}</b>.</span><button className="btn sm primary" onClick={() => { try { sessionStorage.clear(); } catch { /* ignore */ } location.reload(); }}>Reload for the current repository</button></div>}
			<main className="main">
				{page === 'overview' && <Overview status={status} refresh={refresh} go={go} />}
				{page === 'studio' && <Studio status={status} refresh={refresh} go={go} />}
				{page === 'repository' && <Repository go={go} />}
				{page === 'adapters' && <Adapters />}
				{page === 'governance' && <Governance status={status} refresh={refresh} />}
				{page === 'sessions' && <Sessions />}
			</main>
			</div>
			<Palette open={pal} onClose={() => setPal(false)} items={palItems} search={palSearch} />
		</div>
	);
}

function LiveDot() {
	const { summary } = useLive();
	return summary?.status === 'running' ? <i className="livedot" title="Claude Code is running" /> : null;
}

createRoot(document.getElementById('root')!).render(<ToastHost><LiveRunProvider><App /></LiveRunProvider></ToastHost>);
