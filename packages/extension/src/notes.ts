/** `#riafNote` pulls every notepad. `#riafNote:name` pulls one file under `.riaf/notes`. */
export function noteNamesFromPrompt(prompt: string): string[] | 'all' {
	const named = [...prompt.matchAll(/#riafNote:([A-Za-z0-9._-]+)/g)].map(match => match[1]);
	if (named.length) { return named; }
	return /#riafNote\b/.test(prompt) ? 'all' : [];
}

export function selectNotes(prompt: string, notes: { name: string; text: string }[]): { name: string; text: string }[] {
	const want = noteNamesFromPrompt(prompt);
	if (want === 'all') { return notes; }
	if (!want.length) { return []; }
	const names = new Set(want.map(name => name.replace(/\.md$/, '')));
	return notes.filter(note => names.has(note.name.replace(/\.md$/, '')));
}

export function formatNotes(notes: { name: string; text: string }[]): string {
	return notes.map(note => `<riaf_note name="${note.name}">\n${note.text.trim()}\n</riaf_note>`).join('\n');
}
