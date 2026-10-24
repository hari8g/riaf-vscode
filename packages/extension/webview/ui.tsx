import React from 'react';

/* Small UI kit in the style of Trove's settings panel: inline styles over VS Code theme variables,
 * so it follows light/dark/high-contrast themes with no CSS build. */

const v = (name: string, fallback?: string) => `var(--vscode-${name}${fallback ? `, ${fallback}` : ''})`;

export const fmtUsd = (usd: number): string => usd === 0 ? '$0.00' : usd < 0.0001 ? '< $0.0001' : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
export const fmtTokens = (n: number): string => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);

export function Section({ id, title, desc, children }: { id: string; title: string; desc?: string; children: React.ReactNode }) {
	return (
		<section id={id} style={{ marginBottom: 28 }}>
			<h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 4px' }}>{title}</h2>
			{desc && <p style={{ margin: '0 0 12px', color: v('descriptionForeground'), fontSize: 12 }}>{desc}</p>}
			<div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div>
		</section>
	);
}

export function Row({ label, desc, children, wide }: { label: string; desc?: string; children: React.ReactNode; wide?: boolean }) {
	return (
		<div style={{ display: 'grid', gridTemplateColumns: wide ? '1fr' : 'minmax(180px, 260px) 1fr', gap: wide ? 6 : 16, alignItems: 'start' }}>
			<div>
				<div style={{ fontSize: 13 }}>{label}</div>
				{desc && <div style={{ fontSize: 11, color: v('descriptionForeground'), marginTop: 2 }}>{desc}</div>}
			</div>
			<div>{children}</div>
		</div>
	);
}

const inputStyle: React.CSSProperties = {
	width: '100%', boxSizing: 'border-box', padding: '4px 8px', fontSize: 13, fontFamily: 'inherit',
	background: v('input-background'), color: v('input-foreground'), border: `1px solid ${v('input-border', 'transparent')}`, borderRadius: 2, outline: 'none',
};

export function TextInput({ value, onChange, placeholder, mono, type }: { value: string; onChange: (s: string) => void; placeholder?: string; mono?: boolean; type?: string }) {
	const [local, setLocal] = React.useState(value);
	React.useEffect(() => setLocal(value), [value]);
	return <input type={type ?? 'text'} value={local} placeholder={placeholder} spellCheck={false}
		style={{ ...inputStyle, fontFamily: mono ? v('editor-font-family') : 'inherit' }}
		onChange={e => setLocal(e.target.value)} onBlur={() => local !== value && onChange(local)}
		onKeyDown={e => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); } }} />;
}

export function NumberInput({ value, onChange, min, max, step }: { value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number }) {
	return <input type="number" value={value} min={min} max={max} step={step ?? 1} style={{ ...inputStyle, width: 120 }}
		onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) { onChange(n); } }} />;
}

export function TextArea({ value, onChange, rows, mono, placeholder }: { value: string; onChange: (s: string) => void; rows?: number; mono?: boolean; placeholder?: string }) {
	return <textarea value={value} rows={rows ?? 6} placeholder={placeholder} spellCheck={false}
		style={{ ...inputStyle, fontFamily: mono ? v('editor-font-family') : 'inherit', resize: 'vertical', lineHeight: 1.45 }}
		onChange={e => onChange(e.target.value)} />;
}

export function Select<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; desc?: string }[] }) {
	return <select value={value} onChange={e => onChange(e.target.value as T)}
		style={{ ...inputStyle, width: 'auto', minWidth: 200, background: v('dropdown-background'), color: v('dropdown-foreground'), border: `1px solid ${v('dropdown-border', 'transparent')}` }}>
		{options.map(o => <option key={o.value} value={o.value} title={o.desc}>{o.label}</option>)}
	</select>;
}

export function Toggle({ value, onChange, label }: { value: boolean; onChange: (b: boolean) => void; label?: string }) {
	return (
		<label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, userSelect: 'none' }}>
			<span role="switch" aria-checked={value} onClick={() => onChange(!value)}
				style={{ width: 30, height: 16, borderRadius: 8, position: 'relative', transition: 'background .15s', background: value ? v('button-background') : v('input-background'), border: `1px solid ${v('input-border', 'transparent')}` }}>
				<span style={{ position: 'absolute', top: 1, left: value ? 15 : 1, width: 12, height: 12, borderRadius: 6, transition: 'left .15s', background: value ? v('button-foreground') : v('descriptionForeground') }} />
			</span>
			{label && <span>{label}</span>}
		</label>
	);
}

export function Button({ children, onClick, kind, disabled, small }: { children: React.ReactNode; onClick: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; small?: boolean }) {
	const k = kind ?? 'secondary';
	const style: React.CSSProperties = {
		fontSize: small ? 11 : 12, padding: small ? '3px 8px' : '5px 12px', borderRadius: 2, border: 'none', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? .5 : 1, fontFamily: 'inherit',
		...(k === 'primary' ? { background: v('button-background'), color: v('button-foreground') }
			: k === 'danger' ? { background: 'transparent', color: v('errorForeground'), border: `1px solid ${v('errorForeground')}` }
				: { background: v('button-secondaryBackground'), color: v('button-secondaryForeground') }),
	};
	return <button style={style} disabled={disabled} onClick={onClick}>{children}</button>;
}

export function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
	return (
		<div style={{ flex: 1, minWidth: 110, padding: '8px 10px', background: v('editor-background'), border: `1px solid ${v('editorGroup-border')}`, borderRadius: 4 }}>
			<div style={{ fontSize: 10, color: v('descriptionForeground'), marginBottom: 2 }}>{label}</div>
			<div style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
			{sub && <div style={{ fontSize: 10, color: v('descriptionForeground'), opacity: .7 }}>{sub}</div>}
		</div>
	);
}

export function Badge({ ok, text, warn }: { ok?: boolean; warn?: boolean; text: string }) {
	const color = warn ? v('editorWarning-foreground') : ok ? v('testing-iconPassed', '#4caf50') : v('errorForeground');
	return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}><span style={{ width: 8, height: 8, borderRadius: 4, background: color, display: 'inline-block' }} />{text}</span>;
}

export function Note({ children, kind }: { children: React.ReactNode; kind?: 'info' | 'warn' }) {
	return <div style={{ fontSize: 12, padding: '8px 10px', borderRadius: 3, borderLeft: `3px solid ${kind === 'warn' ? v('editorWarning-foreground') : v('textLink-foreground')}`, background: v('textBlockQuote-background') }}>{children}</div>;
}
