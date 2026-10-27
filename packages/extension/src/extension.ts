import * as vscode from 'vscode';
import { registerChatParticipant } from './chatParticipant.js';
import { setProxyCredentials, setupClaudeCode } from './claudeCodeSetup.js';
import { ProxyBridgeManager } from './proxyBridgeManager.js';
import { readSettings, usesGateway } from './config.js';
import { IndexManager } from './indexManager.js';
import { registerLmTools } from './lmTools.js';
import { appendMemory } from './memory.js';
import { registerEditorExtras } from './editorExtras.js';
import { createTransport, setProviderSecrets, type ModelTransport } from './modelTransport.js';
import { setOutboundProxy } from './proxiedFetch.js';
import { installSqliteLoader } from './sqliteLoader.js';
import { decorateGraph } from '@bosch-mps/riaf-engine';
import { buildContextMarkdown } from './contextDoc.js';
import { claudeCodeNetworkStatus, openSettingsPanel, SETTING_KEYS, snapshotSettings } from './settingsPanel.js';
import { registerProposalProvider } from './tools/editApproval.js';
import { resolveShell } from './tools/shell.js';
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

	// local proxy bridge for authenticated corporate proxies (used by Claude Code via ~/.claude/settings.json)
	const bridge = new ProxyBridgeManager(ctx);
	ctx.subscriptions.push(bridge);
	setOutboundProxy(async () => (await bridge.ensureStarted())?.url);
	setProviderSecrets(key => ctx.secrets.get(key));
	void bridge.ensureStarted();

	registerLmTools(ctx, indexes);
	registerChatParticipant(ctx, indexes, usage);
	registerEditorExtras(ctx, indexes, usage, getTransport);

	// status bar: tokens saved
	const saved = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
	saved.command = 'riaf.openSettings';
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
		vscode.commands.registerCommand('riaf.setupClaudeCode', () => setupClaudeCode(ctx, indexes!, bridge)),
		vscode.commands.registerCommand('riaf.setClaudeProxyCredentials', () => setProxyCredentials(ctx)),
		vscode.commands.registerCommand('riaf.proxyBridgeStart', async () => {
			const b = await bridge.restart();
			if (b) { vscode.window.showInformationMessage(`RIAF proxy bridge listening on ${b.url} → ${bridge.upstreamDescription()}`); }
			else { vscode.window.showWarningMessage(`RIAF proxy bridge not started: ${bridge.lastError}`); }
		}),
		vscode.commands.registerCommand('riaf.proxyBridgeStop', () => bridge.stop()),
		vscode.commands.registerCommand('riaf.proxyBridgeLog', () => bridge.output.show(true)),
		vscode.commands.registerCommand('riaf.openSettings', () => openSettingsPanel({ ctx, indexes: indexes!, usage, transport: getTransport, bridge })),
		vscode.commands.registerCommand('riaf.analyse', async () => {
			const f = indexes!.folderFor(); if (!f) { return vscode.window.showErrorMessage('RIAF: open a folder first.'); }
			const idx = await indexes!.get(f);
			const report = await idx.getIndexingReport();
			const text = await buildContextMarkdown({ name: f.name, report });
			const uri = vscode.Uri.joinPath(f.uri, `${f.name}_context.md`);
			await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
			await vscode.window.showTextDocument(uri);
		}),
		vscode.commands.registerCommand('riaf.setProviderKey', async () => {
			const kind = await vscode.window.showQuickPick(['anthropic', 'openai', 'gemini', 'openaiCompatible'], { placeHolder: 'Which provider key?' });
			if (!kind) { return; }
			const key = await vscode.window.showInputBox({ prompt: `${kind} API key`, password: true, ignoreFocusOut: true });
			if (!key) { return; }
			await ctx.secrets.store(`riaf.provider.${kind}`, key);
			void vscode.window.showInformationMessage(`RIAF saved the ${kind} key.`);
		}),
		vscode.commands.registerCommand('riaf.exportSettings', async () => {
			const uri = await vscode.window.showSaveDialog({ filters: { JSON: ['json'] }, defaultUri: vscode.Uri.file('riaf-settings.json') });
			if (!uri) { return; }
			await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(snapshotSettings(), null, 2)));
		}),
		vscode.commands.registerCommand('riaf.importSettings', async () => {
			const picked = await vscode.window.showOpenDialog({ filters: { JSON: ['json'] }, canSelectMany: false });
			if (!picked?.[0]) { return; }
			const raw = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8')) as Record<string, unknown>;
			const cfg = vscode.workspace.getConfiguration('riaf');
			for (const key of SETTING_KEYS) { if (key in raw) { await cfg.update(key, raw[key], vscode.ConfigurationTarget.Global); } }
			void vscode.window.showInformationMessage('RIAF settings imported.');
		}),
		vscode.commands.registerCommand('riaf.setWebSearchKey', async () => {
			const key = await vscode.window.showInputBox({ prompt: 'Tavily API key', password: true, ignoreFocusOut: true });
			if (!key) { return; }
			await ctx.secrets.store('riaf.webSearch.tavily', key);
			void vscode.window.showInformationMessage('RIAF web search key saved.');
		}),
		vscode.commands.registerCommand('riaf.rememberThis', async () => {
			const editor = vscode.window.activeTextEditor;
			const selected = editor ? editor.document.getText(editor.selection).trim() : '';
			const fact = selected || await vscode.window.showInputBox({ title: 'RIAF: Remember This', prompt: 'A fact the agent should keep (saved to ~/.riaf/memory.md)', ignoreFocusOut: true });
			if (!fact?.trim()) { return; }
			appendMemory(fact.trim());
			void vscode.window.showInformationMessage('RIAF will remember that.');
		}),
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
			{ const sh = resolveShell(); lines.push(`- shell for commands/hooks: ${sh.source}${sh.kind === 'cmd' ? '  ⚠ install Git for Windows (Git Bash) or set RIAF_SHELL' : ''}`); }
			{
				const n = await claudeCodeNetworkStatus(ctx);
				if (n.proxyError) { lines.push(`- ⚠ ${n.proxyError}`); }
				lines.push(`- Claude Code network (${n.settingsPath}): proxy=${n.writtenProxy || '(not written)'}${n.writtenProxy ? (n.writtenHasCredentials ? ' (with credentials)' : ' (no credentials)') : ''} · CA=${n.writtenCa || '(none)'}`);
				{
					const b = bridge.status();
					lines.push(`- proxy bridge: ${b.running ? `running at ${b.url} → ${b.upstream}` : b.enabled ? `not running (${b.error ?? 'no reason'})` : 'disabled'}${b.stats ? ` · CONNECTs ${b.stats.connects}, ok ${b.stats.upstreamOk}, refused ${b.stats.upstreamRejected}${b.stats.lastUpstreamStatus ? `, last upstream: ${b.stats.lastUpstreamStatus}` : ''}${b.stats.lastError ? `, last error: ${b.stats.lastError}` : ''}` : ''}`);
				}
				lines.push(`  proxy credentials: ${n.credentialSource === 'url' ? `in the detected URL (${n.credentialUser})` : n.credentialSource === 'secrets' ? `stored in the OS credential store (${n.credentialUser})` : 'none — run "RIAF: Set Claude Code proxy credentials" if the proxy requires sign-in'}`);
				lines.push(`  detected now: proxy=${n.detectedProxy ? `${n.detectedProxy} [${n.detectedProxySource}]` : 'none'} · CA=${n.detectedCa ? `${n.detectedCa} [${n.detectedCaSource}]` : 'none'}${n.caRequiredHint && !n.detectedCa ? '  ⚠ Node < 22.15: a TLS-inspecting proxy needs riaf.claudeCode.caCertPath' : ''}`);
				if (!n.upToDate) { lines.push('  → run "RIAF: Set up Claude Code" to write the detected proxy for Claude Code'); }
			}
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
	const plain = (g.nodes as { filePath?: string; id?: string; path?: string; archLayer?: string; layer?: string }[]).map((n, i) => ({ id: n.filePath ?? n.id ?? n.path ?? String(i), layer: n.archLayer ?? n.layer ?? '', filePath: n.filePath ?? n.id ?? n.path ?? String(i) }));
	const edges = (g.edges as { from?: string; source?: string; fromPath?: string; to?: string; target?: string; toPath?: string }[]).map(e => ({ from: e.from ?? e.source ?? e.fromPath ?? '', to: e.to ?? e.target ?? e.toPath ?? '' }));
	const decorated = JSON.stringify(decorateGraph(plain, edges)).replace(/</g, '\\u003c');
	const data = JSON.stringify(g).replace(/</g, '\\u003c');
	panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font:12px var(--vscode-font-family)}
canvas{display:block;width:100%;height:100%}#info{position:fixed;top:8px;left:8px;opacity:.8}</style></head>
<body><div id="info"></div><canvas id="c"></canvas><script>
const g=${data};const meta=new Map(${decorated}.map(d=>[d.id,d]));const nodes=g.nodes.map((n,i)=>({id:n.filePath??n.id??n.path??String(i),x:Math.random(),y:Math.random(),vx:0,vy:0,deg:0,kind:n.kind??n.nodeType??'',layer:(meta.get(n.filePath??n.id??n.path??String(i))||{}).layer||n.archLayer||n.layer||'',packageName:(meta.get(n.filePath??n.id??n.path??String(i))||{}).packageName||'',depth:(meta.get(n.filePath??n.id??n.path??String(i))||{}).depth||0}));
const byId=new Map(nodes.map(n=>[n.id,n]));const edges=g.edges.map(e=>({s:byId.get(e.from??e.source??e.fromPath),t:byId.get(e.to??e.target??e.toPath)})).filter(e=>e.s&&e.t);
for(const e of edges){e.s.deg++;e.t.deg++;}const layers=[...new Set(nodes.map(n=>n.layer).filter(Boolean))];document.getElementById('info').textContent=nodes.length+' files, '+edges.length+' import edges'+(layers.length?' · layers: '+layers.join(', '):'')+' — drag to pan, wheel to zoom. Click a node for details.';
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
c.onclick=e=>{const r=c.getBoundingClientRect();const x=(e.clientX-r.left-ox)/sc/W,y=(e.clientY-r.top-oy)/sc/H;let best=null,bd=0.02;for(const n of nodes){const dx=n.x-x,dy=n.y-y,d=dx*dx+dy*dy;if(d<bd){bd=d;best=n}}document.getElementById('info').textContent=best?(best.id+' · '+(best.packageName||best.layer||'unknown')+' · depth '+best.depth+' · degree '+best.deg):nodes.length+' files, '+edges.length+' edges';};
</script></body></html>`;
}
