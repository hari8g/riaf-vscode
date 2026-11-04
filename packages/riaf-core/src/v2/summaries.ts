/**
 * Hierarchical summary tree (repo → directory → file), built bottom-up and keyed by content/tree hash
 * so only changed nodes are regenerated (RAPTOR-style altitudes for retrieval and the pack's summaries).
 *
 * Default summariser is extractive (doc comments + exported signatures), which is deterministic and
 * offline; pass `summarize` to have an LLM write file/directory summaries from the extractive input.
 */
import { createHash } from 'node:crypto';
import type { RiafIndex } from '../riafIndex.js';
import type { V2Store } from './store.js';

export type Summarize = (prompt: string) => Promise<string>;
export interface SummaryBuildResult { files: number; dirs: number; regenerated: number; ms: number }

const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export class SummaryTree {
	constructor(private readonly store: V2Store, private readonly index: RiafIndex, private readonly summarize?: Summarize) { }

	get model(): string { return this.summarize ? 'llm' : 'extractive'; }

	get(nodeType: 'file' | 'dir' | 'repo', id: string): string | undefined {
		return this.store.raw.get<{ text: string }>('SELECT text FROM summary_node WHERE node_type = ? AND node_id = ?', [nodeType, id])?.text;
	}

	private stored(nodeType: string, id: string): { hash: string; model: string } | undefined {
		return this.store.raw.get<{ hash: string; model: string }>('SELECT hash, model FROM summary_node WHERE node_type = ? AND node_id = ?', [nodeType, id]);
	}

	private put(nodeType: string, id: string, hash: string, text: string): void {
		this.store.raw.run('INSERT INTO summary_node(node_type, node_id, hash, text, model) VALUES (?,?,?,?,?) ON CONFLICT(node_type, node_id) DO UPDATE SET hash = excluded.hash, text = excluded.text, model = excluded.model',
			[nodeType, id, hash, text, this.model]);
	}

	/** Extractive file summary: leading doc comment + exported symbol signatures. */
	async extractFile(path: string): Promise<string> {
		const outline = await this.index.getFileOutline(path);
		const chunks = await this.index.db.getChunksForFile(this.index.workspaceHash, path);
		const head = (chunks.sort((a, b) => a.start_line - b.start_line)[0]?.chunk_text ?? '').replace(/^#!.*\n/, '').replace(/^\s*\/\*-{3,}[\s\S]*?\*\/\s*/, '');
		const doc = /^\s*(?:\/\*\*?([\s\S]*?)\*\/|((?:\s*(?:\/\/|#)[^\n]*\n){1,6})|"""([\s\S]*?)""")/.exec(head);
		const docText = (doc?.[1] ?? doc?.[2] ?? doc?.[3] ?? '').replace(/^\s*[*#/]+\s?/gm, '').replace(/\s+/g, ' ').trim().slice(0, 240);
		const exported = outline.filter(s => s.isExported).slice(0, 8);
		const syms = (exported.length ? exported : outline.slice(0, 6)).map(s => {
			const d = s.docstring ? ` — ${s.docstring.replace(/\s+/g, ' ').slice(0, 80)}` : '';
			const sig = s.signature?.trim() ? s.signature.replace(/\s+/g, ' ').replace(/^export\s+(default\s+)?/, '').slice(0, 120) : s.name;
			return `${sig.startsWith(s.kind) || /^(async |abstract )?(function|class|interface|type|enum|const|let|def) /.test(sig) ? '' : `${s.kind} `}${sig}${d}`;
		});
		return [docText, syms.length ? `Defines: ${syms.join('; ')}` : ''].filter(Boolean).join(' ').slice(0, 700) || `(${path}: no symbols indexed)`;
	}

	/**
	 * Build or refresh the tree. Files are keyed by their content hash, directories by the hash of their
	 * children's hashes (merkle), so an edit regenerates the file and its ancestors only.
	 */
	async build(opts: { maxLlmCalls?: number } = {}): Promise<SummaryBuildResult> {
		const t0 = Date.now();
		const hashes = await this.index.db.getChunkFileHashes(this.index.workspaceHash);
		let regenerated = 0; let llmCalls = 0;
		const maxLlm = opts.maxLlmCalls ?? 200;
		const fileText = new Map<string, string>();
		const fileHash = new Map<string, string>();
		for (const [path, contentHash] of hashes) {
			const key = h(`${contentHash}:${this.model}:2`);
			fileHash.set(path, key);
			const prev = this.stored('file', path);
			if (prev?.hash === key) { fileText.set(path, this.get('file', path)!); continue; }
			let text = await this.extractFile(path);
			if (this.summarize && llmCalls < maxLlm) {
				try { llmCalls++; text = (await this.summarize(`Summarise this source file in one or two sentences (purpose and main responsibilities). File: ${path}\n${text}`)).trim().slice(0, 600) || text; } catch { /* keep extractive */ }
			}
			this.put('file', path, key, text); fileText.set(path, text); regenerated++;
		}
		// Remove summaries of deleted files.
		for (const r of this.store.raw.all<{ node_id: string }>(`SELECT node_id FROM summary_node WHERE node_type = 'file'`)) if (!hashes.has(r.node_id)) this.store.raw.run(`DELETE FROM summary_node WHERE node_type = 'file' AND node_id = ?`, [r.node_id]);

		// Directories bottom-up.
		const children = new Map<string, string[]>();
		const addChild = (dir: string, child: string) => { const l = children.get(dir) ?? []; if (!l.includes(child)) l.push(child); children.set(dir, l); };
		for (const p of hashes.keys()) {
			let child = p; let d = dirOf(p);
			while (true) { addChild(d, child); if (d === '') break; child = d + '/'; d = dirOf(d); }
		}
		const dirs = [...children.keys()].sort((a, b) => b.split('/').length - a.split('/').length || b.length - a.length);
		const dirHash = new Map<string, string>();
		const dirText = new Map<string, string>();
		for (const d of dirs) {
			const kids = children.get(d)!.sort();
			const key = h(kids.map(k => k.endsWith('/') ? `${k}:${dirHash.get(k.slice(0, -1))}` : `${k}:${fileHash.get(k)}`).join('|') + this.model);
			dirHash.set(d, key);
			const id = d === '' ? '.' : d;
			const prev = this.stored(d === '' ? 'repo' : 'dir', id);
			if (prev?.hash === key) { dirText.set(d, this.get(d === '' ? 'repo' : 'dir', id)!); continue; }
			const parts = kids.slice(0, 12).map(k => {
				const t = k.endsWith('/') ? dirText.get(k.slice(0, -1)) : fileText.get(k);
				return `${k.split('/').filter(Boolean).pop()}${k.endsWith('/') ? '/' : ''}: ${(t ?? '').split(/(?<=\.)\s/)[0].slice(0, 140)}`;
			});
			let text = `${kids.length} entries. ${parts.join(' | ')}`.slice(0, 900);
			if (this.summarize && llmCalls < maxLlm) {
				try { llmCalls++; text = (await this.summarize(`Summarise the purpose of directory "${id}" in two sentences from its children's summaries:\n${parts.join('\n')}`)).trim().slice(0, 700) || text; } catch { /* keep extractive */ }
			}
			this.put(d === '' ? 'repo' : 'dir', id, key, text); dirText.set(d, text); regenerated++;
		}
		return { files: hashes.size, dirs: dirs.length, regenerated, ms: Date.now() - t0 };
	}
}
