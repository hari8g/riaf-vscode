import * as vscode from 'vscode';
import { registerChatParticipant } from './chatParticipant.js';
import { setupClaudeCode } from './claudeCodeSetup.js';
import { readSettings, usesGateway } from './config.js';
import { IndexManager } from './indexManager.js';
import { registerLmTools } from './lmTools.js';
import { createTransport, type ModelTransport } from './modelTransport.js';
import { installSqliteLoader } from './sqliteLoader.js';
import { registerProposalProvider } from './tools/editApproval.js';
import { UsageMeter } from './usage.js';

let indexes: IndexManager | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
	installSqliteLoader(ctx.extensionPath);
	registerProposalProvider(ctx);

	const usage = new UsageMeter(ctx.globalState);
	let transport: ModelTransport | undefined;
	const getTransport = () => transport;
	// resolve lazily; vscode.lm models may not exist until Copilot activates
	void createTransport().then(t => { transport = t; }).catch(() => { /* none yet */ });
	ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('riaf.gateway')) { void createTransport().then(t => { transport = t; }); }
	}));

	indexes = new IndexManager(ctx, getTransport);
	ctx.subscriptions.push(indexes);

	registerLmTools(ctx, indexes);
	registerChatParticipant(ctx, indexes, usage);

	// status bar: tokens saved
	const saved = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
	saved.command = 'riaf.showUsage';
	const refreshSaved = () => { const t = usage.session; saved.text = `$(zap) ${t.savedTokens.toLocaleString()} saved`; saved.tooltip = 'Tokens RIAF kept out of prompts this session — click for details'; saved.show(); };
	usage.onDidChange(refreshSaved); refreshSaved();
	ctx.subscriptions.push(saved);

	ctx.subscriptions.push(
		vscode.commands.registerCommand('riaf.reindex', async () => {
			const f = indexes!.folderFor(vscode.window.activeTextEditor?.document.uri);
			if (!f) { return vscode.window.showErrorMessage('RIAF: open a folder first.'); }
			await indexes!.reindex(f, true);
		}),
		vscode.commands.registerCommand('riaf.showReport', async () => {
			const f = indexes!.folderFor(); if (!f) { return; }
			const idx = await indexes!.get(f);
			const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: await idx.getIndexingReport() });
			await vscode.window.showTextDocument(doc, { preview: true });
		}),
		vscode.commands.registerCommand('riaf.showContextGraph', async () => {
			const f = indexes!.folderFor(); if (!f) { return; }
			const idx = await indexes!.get(f);
			const g = await idx.getGraph();
			showGraphWebview(ctx, f.name, g);
		}),
		vscode.commands.registerCommand('riaf.setupClaudeCode', () => setupClaudeCode(ctx, indexes!)),
		vscode.commands.registerCommand('riaf.showUsage', async () => {
			const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: `# RIAF token usage\n\n${usage.summaryMarkdown()}\n\nModel transport: ${transport?.id ?? 'none yet'}` });
			await vscode.window.showTextDocument(doc, { preview: true });
		}),
		vscode.commands.registerCommand('riaf.doctor', async () => {
			const s = readSettings();
			const lines: string[] = ['# RIAF doctor', ''];
			const f = indexes!.folderFor();
			if (f) {
				try { const st = (await indexes!.get(f)).getStatus(); lines.push(`- index: ${st.indexed ? 'OK' : 'NOT INDEXED'} — ${st.files} files, ${st.chunks} chunks, ${st.symbols} symbols`, `- db: ${indexes!.dbPathFor(f)}`); }
				catch (e) { lines.push(`- index: FAILED — ${(e as Error).message}`); }
			} else { lines.push('- index: no folder open'); }
			lines.push(`- embeddings: ${s.embeddings.enabled ? `on (${s.embeddings.model})` : 'off (BM25-only, offline)'}`);
			if (usesGateway(s)) {
				try {
					const t = await createTransport();
					const r = await t!.call({ systemMessage: 'Reply with OK.', messages: [{ role: 'user', text: 'ping' }], maxOutputTokens: 5 });
					lines.push(`- gateway: OK (${t!.id}) → "${r.text.trim().slice(0, 20)}"`);
				} catch (e) { lines.push(`- gateway: FAILED — ${(e as Error).message}`); }
			} else {
				const models = await vscode.lm.selectChatModels();
				lines.push(`- vscode.lm models: ${models.length ? models.map(m => `${m.vendor}/${m.id}`).join(', ') : 'none (sign in to Copilot or configure riaf.gateway.*)'}`);
			}
			lines.push(`- proxy: http.proxy=${vscode.workspace.getConfiguration('http').get('proxy') || '(system)'} · http.proxySupport=${vscode.workspace.getConfiguration('http').get('proxySupport')}`);
			const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: lines.join('\n') });
			await vscode.window.showTextDocument(doc, { preview: true });
		}),
	);

	if (readSettings().index.autoIndexOnStartup && vscode.workspace.workspaceFolders?.length) {
		// don't block activation
		setTimeout(() => void indexes!.reindexAll(false), 1500);
	}
}

export async function deactivate(): Promise<void> {
	await indexes?.dispose();
}

function showGraphWebview(ctx: vscode.ExtensionContext, name: string, g: { nodes: unknown[]; edges: unknown[] }): void {
	const panel = vscode.window.createWebviewPanel('riaf.graph', `RIAF graph — ${name}`, vscode.ViewColumn.Beside, { enableScripts: true });
	const data = JSON.stringify(g).replace(/</g, '\\u003c');
	panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font:12px var(--vscode-font-family)}
canvas{display:block;width:100%;height:100%}#info{position:fixed;top:8px;left:8px;opacity:.8}</style></head>
<body><div id="info"></div><canvas id="c"></canvas><script>
const g=${data};const nodes=g.nodes.map((n,i)=>({id:n.filePath??n.id??n.path??String(i),x:Math.random(),y:Math.random(),vx:0,vy:0,deg:0,kind:n.kind??n.nodeType??''}));
const byId=new Map(nodes.map(n=>[n.id,n]));const edges=g.edges.map(e=>({s:byId.get(e.from??e.source??e.fromPath),t:byId.get(e.to??e.target??e.toPath)})).filter(e=>e.s&&e.t);
for(const e of edges){e.s.deg++;e.t.deg++;}document.getElementById('info').textContent=nodes.length+' files, '+edges.length+' import edges — drag to pan, wheel to zoom';
const c=document.getElementById('c'),ctx=c.getContext('2d');let W,H,sc=1,ox=0,oy=0;function rs(){W=c.width=c.clientWidth;H=c.height=c.clientHeight}rs();addEventListener('resize',rs);
function step(){for(const a of nodes){for(const b of nodes){if(a===b)continue;let dx=a.x-b.x,dy=a.y-b.y,d2=dx*dx+dy*dy+1e-4,f=0.00002/d2;a.vx+=dx*f;a.vy+=dy*f}}
for(const e of edges){let dx=e.t.x-e.s.x,dy=e.t.y-e.s.y;e.s.vx+=dx*0.01;e.s.vy+=dy*0.01;e.t.vx-=dx*0.01;e.t.vy-=dy*0.01}
for(const n of nodes){n.vx+=(0.5-n.x)*0.002;n.vy+=(0.5-n.y)*0.002;n.x+=n.vx*=0.85;n.y+=n.vy*=0.85}}
function draw(){ctx.clearRect(0,0,W,H);ctx.save();ctx.translate(ox,oy);ctx.scale(sc,sc);ctx.strokeStyle='rgba(128,128,128,.35)';
for(const e of edges){ctx.beginPath();ctx.moveTo(e.s.x*W,e.s.y*H);ctx.lineTo(e.t.x*W,e.t.y*H);ctx.stroke()}
for(const n of nodes){const r=2+Math.min(10,Math.sqrt(n.deg));ctx.fillStyle=n.kind.includes('test')?'#4caf50':n.kind.includes('entry')?'#ff9800':'#2196f3';ctx.beginPath();ctx.arc(n.x*W,n.y*H,r,0,7);ctx.fill();
if(sc>1.8||n.deg>8){ctx.fillStyle='currentColor';ctx.fillText(n.id.split('/').pop(),n.x*W+r+2,n.y*H+3)}}ctx.restore()}
let t=0;(function loop(){if(t++<300)step();draw();requestAnimationFrame(loop)})();
let drag=null;c.onmousedown=e=>drag={x:e.clientX-ox,y:e.clientY-oy};c.onmousemove=e=>{if(drag){ox=e.clientX-drag.x;oy=e.clientY-drag.y}};c.onmouseup=()=>drag=null;
c.onwheel=e=>{e.preventDefault();const k=e.deltaY<0?1.1:0.9;ox=e.clientX-(e.clientX-ox)*k;oy=e.clientY-(e.clientY-oy)*k;sc*=k};
</script></body></html>`;
}
