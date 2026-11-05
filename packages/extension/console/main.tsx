import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, boot, type Status } from './api.js';
import { Overview } from './pages/overview.js';
import { Repository } from './pages/repository.js';
import { PackStudio } from './pages/packStudio.js';
import { Adapters } from './pages/adapters.js';
import { Governance } from './pages/governance.js';
import { Sessions } from './pages/sessions.js';

const PAGES = [
	['overview', 'Overview'], ['repository', 'Repository'], ['pack', 'Pack Studio'], ['adapters', 'Adapters'], ['governance', 'Governance'], ['sessions', 'Sessions'],
] as const;
type Page = typeof PAGES[number][0];

function usePage(): [Page, (p: Page, q?: string) => void] {
	const read = (): Page => { const h = location.hash.replace(/^#\/?/, '').split('?')[0] as Page; return PAGES.some(p => p[0] === h) ? h : 'overview'; };
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
	const repoName = (status?.repo.root ?? boot.root).split(/[\\/]/).filter(Boolean).pop() ?? 'repository';
	return (
		<div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', minHeight: '100vh' }}>
			<nav className="nav" style={{ padding: '18px 12px', borderRight: '1px solid var(--vscode-editorGroup-border)', position: 'sticky', top: 0, height: '100vh', boxSizing: 'border-box' }}>
				<div style={{ fontWeight: 700, fontSize: 15, marginBottom: 2 }}>RIAF Console</div>
				<div className="muted" style={{ fontSize: 11, marginBottom: 14, wordBreak: 'break-all' }}>{repoName}{status?.repo.branch ? ` · ${status.repo.branch}` : ''}</div>
				{PAGES.map(([id, label]) => <a key={id} href={`#/${id}`} className={page === id ? 'active' : ''}>{label}</a>)}
				<div className="muted" style={{ fontSize: 11, marginTop: 18, lineHeight: 1.6 }}>
					<div>{status ? <span style={{ color: 'var(--vscode-testing-iconPassed)' }}>● riafd {status.daemon.version}</span> : error ? <span style={{ color: 'var(--vscode-errorForeground)' }}>● {error}</span> : '○ connecting…'}</div>
					<div>{status?.daemon.surface === 'vscode' ? 'inside VS Code' : 'standalone'} · :{status?.daemon.port ?? '?'}</div>
					<div>{status?.index.indexed ? `${status.index.chunks.toLocaleString()} chunks` : 'not indexed'}</div>
				</div>
			</nav>
			<main style={{ padding: '20px 28px', maxWidth: 1180, minWidth: 0 }}>
				{page === 'overview' && <Overview status={status} refresh={refresh} go={go} />}
				{page === 'repository' && <Repository />}
				{page === 'pack' && <PackStudio status={status} refresh={refresh} />}
				{page === 'adapters' && <Adapters />}
				{page === 'governance' && <Governance status={status} refresh={refresh} />}
				{page === 'sessions' && <Sessions />}
			</main>
		</div>
	);
}

createRoot(document.getElementById('root')!).render(<App />);
