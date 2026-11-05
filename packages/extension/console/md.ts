/** Tiny markdown → HTML for the instruction / pack views (headings, fences, lists, tables, task boxes, inline code/bold/links). No dependency. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s: string): string {
	// Code spans first, parked so that bold/italic never touch identifiers with underscores.
	const codes: string[] = [];
	let t = esc(s).replace(/`([^`]+)`/g, (_m, c: string) => { codes.push(`<code>${c}</code>`); return `\u0000${codes.length - 1}\u0000`; });
	t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
		.replace(/(^|[\s(])_([^_\n]{1,80}?)_(?=[\s).,;:]|$)/g, '$1<i>$2</i>')
		.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
	return t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

export function mdToHtml(md: string): string {
	const lines = md.replace(/\r\n/g, '\n').split('\n');
	const out: string[] = [];
	let i = 0;
	let list: 'ul' | 'ol' | null = null;
	const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
	while (i < lines.length) {
		const l = lines[i];
		const fence = l.match(/^(`{3,4})(\w*)/);
		if (fence) {
			closeList();
			const end = fence[1]; const body: string[] = []; i++;
			while (i < lines.length && !lines[i].startsWith(end)) { body.push(lines[i]); i++; }
			i++;
			out.push(`<pre><code class="lang-${esc(fence[2])}">${esc(body.join('\n'))}</code></pre>`);
			continue;
		}
		if (/^<!--/.test(l.trim())) { i++; continue; }
		const h = l.match(/^(#{1,6})\s+(.*)$/);
		if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
		if (/^\|.*\|\s*$/.test(l) && /^\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
			closeList();
			const cells = (r: string) => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
			const head = cells(l); i += 2;
			const rows: string[][] = [];
			while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
			out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
			continue;
		}
		const ol = l.match(/^\s*(\d+)\.\s+(.*)$/);
		const ul = l.match(/^\s*[-*]\s+(.*)$/);
		if (ol || ul) {
			const kind: 'ul' | 'ol' = ol ? 'ol' : 'ul';
			if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
			let text = (ol ? ol[2] : ul![1]);
			const task = text.match(/^\[([ xX])\]\s+(.*)$/);
			if (task) text = `<input type="checkbox" disabled ${task[1] !== ' ' ? 'checked' : ''}/>${inline(task[2])}`; else text = inline(text);
			const indent = l.match(/^(\s*)/)![1].length;
			out.push(`<li${indent >= 4 ? ' style="margin-left:14px;list-style:circle"' : ''}>${text}</li>`);
			i++; continue;
		}
		if (!l.trim()) { closeList(); i++; continue; }
		closeList();
		out.push(`<p>${inline(l)}</p>`);
		i++;
	}
	closeList();
	return out.join('\n');
}
