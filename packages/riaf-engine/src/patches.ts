/** Apply exact-once search/replace blocks. The first failure leaves the text unchanged. */
export function applyPatches(text: string, edits: { search: string; replace: string }[]): { ok: true; text: string } | { ok: false; error: string } {
	let next = text;
	for (const [i, edit] of edits.entries()) {
		if (!edit.search) { return { ok: false, error: `EDIT NOT APPLIED (${i + 1} of ${edits.length}): empty search` }; }
		const hits = next.split(edit.search).length - 1;
		if (hits !== 1) {
			return { ok: false, error: `EDIT NOT APPLIED (${i + 1} of ${edits.length}): search matched ${hits} times` };
		}
		next = next.replace(edit.search, () => edit.replace);
	}
	return { ok: true, text: next };
}

export function parsePatchDocument(text: string): { path: string; search: string; replace: string }[] {
	const start = text.indexOf('[');
	const obj = text.indexOf('{');
	const sliceFrom = start >= 0 && (obj < 0 || start < obj) ? start : obj;
	if (sliceFrom < 0) { return []; }
	const end = text.lastIndexOf(sliceFrom === start ? ']' : '}');
	if (end <= sliceFrom) { return []; }
	let raw: unknown;
	try { raw = JSON.parse(text.slice(sliceFrom, end + 1)); } catch { return []; }
	const list = Array.isArray(raw) ? raw : (raw as { edits?: unknown }).edits;
	if (!Array.isArray(list)) { return []; }
	return list.flatMap(item => {
		if (!item || typeof item !== 'object') { return []; }
		const e = item as { path?: unknown; filePath?: unknown; search?: unknown; replace?: unknown };
		const path = typeof e.path === 'string' ? e.path : typeof e.filePath === 'string' ? e.filePath : '';
		if (!path || typeof e.search !== 'string' || typeof e.replace !== 'string') { return []; }
		return [{ path, search: e.search, replace: e.replace }];
	});
}
