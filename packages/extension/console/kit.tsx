import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/* ───────── toasts ───────── */
type Toast = { id: number; text: string; kind?: 'ok' | 'err' };
const ToastCtx = createContext<(text: string, kind?: 'ok' | 'err') => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);
export function ToastHost({ children }: { children: React.ReactNode }) {
	const [list, setList] = useState<Toast[]>([]);
	const push = useCallback((text: string, kind?: 'ok' | 'err') => {
		const id = Date.now() + Math.random();
		setList(l => [...l, { id, text, kind }]);
		setTimeout(() => setList(l => l.filter(t => t.id !== id)), kind === 'err' ? 6000 : 3200);
	}, []);
	return <ToastCtx.Provider value={push}>{children}<div className="toasts" aria-live="polite">{list.map(t => <div key={t.id} className={`toast ${t.kind === 'err' ? 'err' : ''}`}>{t.text}</div>)}</div></ToastCtx.Provider>;
}

/* ───────── theme ───────── */
export type Theme = 'auto' | 'light' | 'dark';
export function useTheme(): [Theme, (t: Theme) => void] {
	const [t, setT] = useState<Theme>(() => (localStorage.getItem('riaf.theme') as Theme) || 'auto');
	useEffect(() => { if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); localStorage.setItem('riaf.theme', t); }, [t]);
	return [t, setT];
}

/* ───────── primitives ───────── */
export const Btn = ({ children, onClick, kind, sm, disabled, title, type }: { children: React.ReactNode; onClick?: () => void; kind?: 'primary' | 'ghost'; sm?: boolean; disabled?: boolean; title?: string; type?: 'button' | 'submit' }) =>
	<button type={type ?? 'button'} className={`btn ${kind ?? ''} ${sm ? 'sm' : ''}`} onClick={onClick} disabled={disabled} title={title}>{children}</button>;

export const Switch = ({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) =>
	<span className="switch" role="switch" aria-checked={on} tabIndex={0} onClick={() => onChange(!on)} onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onChange(!on); } }}><i />{label && <span>{label}</span>}</span>;

export const Chip = ({ children, tone, mono, onClick, title }: { children: React.ReactNode; tone?: 'teal' | 'ember' | 'moss'; mono?: boolean; onClick?: () => void; title?: string }) =>
	<span className={`chip ${tone ?? ''} ${mono ? 'mono' : ''} ${onClick ? 'clickable' : ''}`} onClick={onClick} title={title} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}>{children}</span>;

export const Status = ({ ok, warn, children }: { ok?: boolean; warn?: boolean; children: React.ReactNode }) =>
	<div className="status"><span className={`dot ${warn ? 'warn' : ok ? 'ok' : 'off'}`} /><span>{children}</span></div>;

export const Field = ({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) =>
	<div className="field"><div><div className="label">{label}</div>{desc && <div className="desc">{desc}</div>}</div><div>{children}</div></div>;

export function Empty({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
	return <div className="empty"><b>{title}</b>{children}{action && <div style={{ marginTop: 12 }}>{action}</div>}</div>;
}

/** Confidence arc: a quarter-turn gauge, teal fills with the value. */
export function Arc({ value, label }: { value: number; label?: string }) {
	const r = 26, c = 2 * Math.PI * r, v = Math.max(0, Math.min(1, value));
	return (
		<svg className="arc" viewBox="0 0 64 64" role="img" aria-label={`confidence ${Math.round(v * 100)}%`}>
			<circle cx="32" cy="32" r={r} fill="none" stroke="var(--paper-3)" strokeWidth="6" />
			<circle cx="32" cy="32" r={r} fill="none" stroke={v >= 0.6 ? 'var(--teal)' : 'var(--ember)'} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${c * v} ${c}`} transform="rotate(-90 32 32)" style={{ transition: 'stroke-dasharray .3s' }} />
			<text x="32" y="36" textAnchor="middle" fontSize="13" fontWeight="650" fill="var(--ink)">{Math.round(v * 100)}</text>
			{label && <text x="32" y="48" textAnchor="middle" fontSize="8" fill="var(--slate)">{label}</text>}
		</svg>
	);
}

/** Segmented ring for a checklist (Claude Code setup). */
export function Ring({ items }: { items: { ok: boolean; label: string }[] }) {
	const r = 38, c = 2 * Math.PI * r, n = items.length || 1, seg = c / n, gap = 3;
	const done = items.filter(i => i.ok).length;
	return (
		<svg className="ring" viewBox="0 0 96 96" role="img" aria-label={`${done} of ${n} set up`}>
			{items.map((it, i) => <circle key={i} cx="48" cy="48" r={r} fill="none" stroke={it.ok ? 'var(--moss)' : 'var(--paper-3)'} strokeWidth="8" strokeDasharray={`${seg - gap} ${c - seg + gap}`} strokeDashoffset={-i * seg} transform="rotate(-90 48 48)"><title>{it.label}</title></circle>)}
			<text x="48" y="52" textAnchor="middle" fontSize="18" fontWeight="650" fill="var(--ink)">{done}/{n}</text>
		</svg>
	);
}

/* ───────── drawer ───────── */
export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
	useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [open, onClose]);
	if (!open) return null;
	return <>
		<div className="drawer-bg" onClick={onClose} />
		<aside className="drawer" role="dialog" aria-label={title}><div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}><h2>{title}</h2><Btn kind="ghost" sm onClick={onClose}>Close</Btn></div>{children}</aside>
	</>;
}

/* ───────── command palette (⌘K) ───────── */
export type PaletteItem = { id: string; label: string; hint?: string; run: () => void };
export function Palette({ open, onClose, items, search }: { open: boolean; onClose: () => void; items: PaletteItem[]; search?: (q: string) => Promise<PaletteItem[]> }) {
	const [q, setQ] = useState('');
	const [extra, setExtra] = useState<PaletteItem[]>([]);
	const [idx, setIdx] = useState(0);
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => { if (open) { setQ(''); setExtra([]); setIdx(0); setTimeout(() => ref.current?.focus(), 10); } }, [open]);
	useEffect(() => { if (!search || q.trim().length < 2) { setExtra([]); return; } const t = setTimeout(() => search(q).then(setExtra).catch(() => setExtra([])), 200); return () => clearTimeout(t); }, [q, search]);
	const list = useMemo(() => [...items.filter(i => !q || i.label.toLowerCase().includes(q.toLowerCase())), ...extra].slice(0, 14), [items, extra, q]);
	if (!open) return null;
	return (
		<div className="palette-bg" onClick={onClose}>
			<div className="palette" onClick={e => e.stopPropagation()}>
				<input ref={ref} value={q} onChange={e => { setQ(e.target.value); setIdx(0); }} placeholder="Jump to a page, or type a file or symbol name" aria-label="Command palette"
					onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(list.length - 1, i + 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); } if (e.key === 'Enter' && list[idx]) { list[idx].run(); onClose(); } if (e.key === 'Escape') onClose(); }} />
				<div className="res">{list.map((it, i) => <div key={it.id} className={i === idx ? 'on' : ''} onMouseEnter={() => setIdx(i)} onClick={() => { it.run(); onClose(); }}><span>{it.label}</span><span className="muted small">{it.hint}</span></div>)}{!list.length && <div className="muted">Nothing matches.</div>}</div>
			</div>
		</div>
	);
}

export const fmtK = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
export const ago = (ts: number) => { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
export const shortPath = (p: string, keep = 2) => { const parts = p.split('/'); return parts.length > keep + 1 ? `…/${parts.slice(-keep).join('/')}` : p; };
