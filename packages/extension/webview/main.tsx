import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { onPush, request, type HostResponse, type IndexStatus, type UsageTotals } from './bridge.js';
import { Badge, Button, Note, NumberInput, Row, Section, Select, StatCard, TextArea, TextInput, Toggle, fmtTokens, fmtUsd } from './ui.js';

/* ───────────────────────────── state ───────────────────────────── */

type Settings = Record<string, unknown>;
const TABS = [
	['gateway', 'Gateway'], ['index', 'Repository Intelligence'], ['agent', 'Agent'], ['tools', 'Tools'],
	['rules', 'Rules'], ['usage', 'Usage'], ['claude', 'Claude Code'],
] as const;
type Tab = typeof TABS[number][0];

function useHost() {
	const [state, setState] = useState<HostResponse>({});
	const merge = useCallback((r: HostResponse) => setState(s => ({ ...s, ...r })), []);
	useEffect(() => { void request({ type: 'getAll' }).then(merge); return onPush(merge); }, [merge]);
	const set = useCallback(async (key: string, value: unknown) => {
		setState(s => ({ ...s, settings: { ...(s.settings ?? {}), [key]: value } }));   // optimistic
		merge(await request({ type: 'set', key, value }));
	}, [merge]);
	const call = useCallback(async (req: Parameters<typeof request>[0]) => merge(await request(req)), [merge]);
	return { state, set, call };
}

/* ───────────────────────────── app ───────────────────────────── */

function App() {
	const { state, set, call } = useHost();
	const s: Settings = state.settings ?? {};
	const get = <T,>(k: string, d: T): T => (s[k] as T) ?? d;
	const [tab, setTab] = useState<Tab | 'all'>('all');
	const show = (t: Tab) => tab === 'all' || tab === t;

	return (
		<div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', minHeight: '100vh', fontSize: 13 }}>
			<nav style={{ padding: '20px 12px', borderRight: '1px solid var(--vscode-editorGroup-border)', position: 'sticky', top: 0, alignSelf: 'start', height: '100vh', boxSizing: 'border-box' }}>
				<div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14 }}>RIAF Settings</div>
				{[['all', 'All'] as const, ...TABS].map(([id, label]) => (
					<div key={id} onClick={() => setTab(id as Tab | 'all')}
						style={{ padding: '5px 8px', borderRadius: 3, cursor: 'pointer', marginBottom: 2, background: tab === id ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent', color: tab === id ? 'var(--vscode-list-activeSelectionForeground)' : 'inherit' }}>
						{label}
					</div>
				))}
				<div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
					<Button small onClick={() => call({ type: 'openNativeSettings' })}>All settings (native UI)</Button>
					<Button small onClick={() => call({ type: 'openOutput' })}>Open RIAF log</Button>
				</div>
			</nav>
			<main style={{ padding: '20px 28px', maxWidth: 860 }}>
				{state.error && <Note kind="warn">{state.error}</Note>}
				{show('gateway') && <Gateway s={s} get={get} set={set} state={state} call={call} />}
				{show('index') && <RepoIntelligence get={get} set={set} index={state.index} call={call} />}
				{show('agent') && <Agent get={get} set={set} />}
				{show('tools') && <Tools get={get} set={set} />}
				{show('rules') && <Rules rules={state.rules ?? ''} path={state.rulesPath} call={call} />}
				{show('usage') && <Usage usage={state.usage} transportId={state.transportId} call={call} />}
				{show('claude') && <ClaudeCode status={state.claudeCode} bridge={state.bridge} call={call} get={get} set={set} />}
			</main>
		</div>
	);
}

/* ───────────────────────────── sections ───────────────────────────── */

type P = { get: <T,>(k: string, d: T) => T; set: (k: string, v: unknown) => Promise<void> };

function Gateway({ get, set, state, call }: P & { s: Settings; state: HostResponse; call: (r: Parameters<typeof request>[0]) => Promise<void> }) {
	const url = get('gateway.url', '');
	const [testing, setTesting] = useState(false);
	const test = async () => { setTesting(true); try { await call({ type: 'testConnection' }); } finally { setTesting(false); } };
	const c = state.connection;
	return (
		<Section id="gateway" title="Gateway" desc="Where the agent's model calls go. Leave the URL empty to borrow the models (and sign-in) that Copilot already provides in this VS Code.">
			{!url && <Note>Using Copilot's models via <code>vscode.lm</code>{state.models?.length ? ` — available: ${state.models.join(', ')}` : ' — none detected yet (sign in to Copilot, or configure a gateway below)'}.</Note>}
			<Row label="Gateway URL" desc="OpenAI-compatible base URL, e.g. https://llm-gateway.internal/v1"><TextInput mono value={url} onChange={v => set('gateway.url', v)} placeholder="https://…/v1" /></Row>
			<Row label="Chat model" desc="Model id as the gateway knows it"><TextInput mono value={get('gateway.model', '')} onChange={v => set('gateway.model', v)} placeholder="anthropic.claude-sonnet-4-5" /></Row>
			<Row label="Authentication" desc="SSO uses VS Code's built-in sign-in; no API keys are stored.">
				<Select value={get('gateway.auth', 'microsoft-sso')} onChange={v => set('gateway.auth', v)} options={[
					{ value: 'microsoft-sso', label: 'Microsoft (Entra ID) SSO' }, { value: 'github-sso', label: 'GitHub SSO' }, { value: 'header', label: 'Static headers' }, { value: 'none', label: 'None' }]} />
			</Row>
			<Row label="SSO scopes" desc="Comma-separated. For a gateway registered in Entra use its API scope, e.g. api://<app-id>/.default">
				<TextInput mono value={get<string[]>('gateway.ssoScopes', []).join(', ')} onChange={v => set('gateway.ssoScopes', v.split(',').map(x => x.trim()).filter(Boolean))} />
			</Row>
			<Row label="Extra headers" desc="JSON object sent with every request">
				<TextInput mono value={JSON.stringify(get('gateway.headers', {}))} onChange={v => { try { void set('gateway.headers', JSON.parse(v || '{}')); } catch { /* ignore invalid */ } }} />
			</Row>
			<Row label="Prompt caching" desc="Anthropic cache_control breakpoints when the gateway routes to Claude"><Toggle value={get('gateway.promptCache', true)} onChange={v => set('gateway.promptCache', v)} /></Row>
			<Row label="Stream responses" desc="Show gateway text as it is generated. Turn off for gateways that reject stream=true."><Toggle value={get('gateway.stream', true)} onChange={v => set('gateway.stream', v)} /></Row>
			<Row label="Connection">
				<div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
					<Button kind="primary" onClick={test} disabled={testing}>{testing ? 'Testing…' : 'Test connection'}</Button>
					{c && <Badge ok={c.ok} text={`${c.message}${c.latencyMs ? ` (${c.latencyMs} ms)` : ''}`} />}
				</div>
			</Row>
		</Section>
	);
}

function RepoIntelligence({ get, set, index, call }: P & { index?: IndexStatus; call: (r: Parameters<typeof request>[0]) => Promise<void> }) {
	const [busy, setBusy] = useState(false);
	const reindex = async (force: boolean) => { setBusy(true); try { await call({ type: 'reindex', force }); } finally { setBusy(false); } };
	return (
		<Section id="index" title="Repository Intelligence" desc="The RIAF index: chunks, symbols and the import graph that power search for Copilot, @riaf and Claude Code.">
			<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
				<StatCard label="Status" value={index ? (index.indexed ? 'Indexed' : 'Not indexed') : '…'} sub={index?.folder} />
				<StatCard label="Files" value={String(index?.files ?? 0)} />
				<StatCard label="Chunks" value={fmtTokens(index?.chunks ?? 0)} />
				<StatCard label="Symbols" value={fmtTokens(index?.symbols ?? 0)} />
				<StatCard label="Last indexed" value={index?.lastIndexedAt ? new Date(index.lastIndexedAt).toLocaleTimeString() : '—'} sub={index?.lastIndexedAt ? new Date(index.lastIndexedAt).toLocaleDateString() : undefined} />
			</div>
			<div style={{ display: 'flex', gap: 8 }}>
				<Button kind="primary" disabled={busy} onClick={() => reindex(false)}>{busy ? 'Indexing…' : 'Reindex (incremental)'}</Button>
				<Button disabled={busy} onClick={() => reindex(true)}>Full rebuild</Button>
				<Button onClick={() => call({ type: 'openReport' })}>Indexing report</Button>
				<Button onClick={() => call({ type: 'openGraph' })}>Context graph</Button>
			</div>
			<Row label="Index on startup"><Toggle value={get('index.autoIndexOnStartup', true)} onChange={v => set('index.autoIndexOnStartup', v)} /></Row>
			<Row label="Watch for changes" desc="Incremental updates as files are saved"><Toggle value={get('index.watch', true)} onChange={v => set('index.watch', v)} /></Row>
			<Row label="Honor .gitignore" desc="Skip files matched by the root and nested gitignore files"><Toggle value={get('index.respectGitignore', true)} onChange={v => set('index.respectGitignore', v)} /></Row>
			<Row label="Tree-sitter chunking" desc="Chunk and extract symbols from the syntax tree. Falls back to regex per language when a grammar is missing."><Toggle value={get('index.treeSitter', true)} onChange={v => set('index.treeSitter', v)} /></Row>
			<Row label="Exclude patterns" desc="gitignore-style, one per line" wide>
				<TextArea mono rows={5} value={get<string[]>('index.excludeGlobs', []).join('\n')} onChange={v => set('index.excludeGlobs', v.split('\n').map(x => x.trim()).filter(Boolean))} />
			</Row>
			<Row label="Semantic embeddings" desc="Hybrid BM25 + embeddings via the gateway's /embeddings. Off = keyword-only, fully offline.">
				<div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
					<Toggle value={get('embeddings.enabled', false)} onChange={v => set('embeddings.enabled', v)} />
					{get('embeddings.enabled', false) && !get('gateway.url', '') && <Badge warn text="needs a gateway URL" />}
				</div>
			</Row>
			<Row label="Embedding model"><TextInput mono value={get('embeddings.model', '')} onChange={v => set('embeddings.model', v)} /></Row>
			{index?.dbPath && <div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>DB: <code>{index.dbPath}</code></div>}
		</Section>
	);
}

function Agent({ get, set }: P) {
	return (
		<Section id="agent" title="Agent" desc="How @riaf runs its plan → gather → edit → verify loop.">
			<Row label="Generate a plan first" desc="≤300-token plan, ticked off as tools run"><Toggle value={get('agent.generatePlan', true)} onChange={v => set('agent.generatePlan', v)} /></Row>
			<Row label="Auto-verify after edits" desc="Runs the detected test/typecheck command once and feeds results back"><Toggle value={get('agent.autoVerify', true)} onChange={v => set('agent.autoVerify', v)} /></Row>
			<Row label="Max iterations" desc="Hard cap on tool-call rounds per request"><NumberInput min={1} max={100} value={get('agent.maxIterations', 25)} onChange={v => set('agent.maxIterations', v)} /></Row>
			<Row label="Exploration budget" desc="Read/search/list calls before the agent is nudged to act"><NumberInput min={1} max={100} value={get('agent.maxReadOnlyCalls', 12)} onChange={v => set('agent.maxReadOnlyCalls', v)} /></Row>
			<Row label="Context window usage" desc="Fraction of the model window filled before trimming (0.3–0.95)"><NumberInput min={0.3} max={0.95} step={0.05} value={get('agent.contextWindowRatio', 0.85)} onChange={v => set('agent.contextWindowRatio', v)} /></Row>
			<Row label="Diagnostics after edit" desc="Wait briefly for the language server and return that file's errors in the tool result"><Toggle value={get('agent.diagnosticsAfterEdit', true)} onChange={v => set('agent.diagnosticsAfterEdit', v)} /></Row>
			<Row label="Summarise long threads" desc="Replace the oldest turns with a summary past ~60% of the budget. Falls back to dropping them if the summary call fails."><Toggle value={get('agent.summarizeHistory', true)} onChange={v => set('agent.summarizeHistory', v)} /></Row>
			<Row label="Explore subagent" desc="A read-only side loop that searches and reads, then returns a short report"><Toggle value={get('agent.exploreSubagent', true)} onChange={v => set('agent.exploreSubagent', v)} /></Row>
			<Row label="Checkpoints" desc="Snapshot files before the agent edits them so RIAF: Rewind can restore a turn"><Toggle value={get('agent.checkpoints', true)} onChange={v => set('agent.checkpoints', v)} /></Row>
		</Section>
	);
}

function Tools({ get, set }: P) {
	return (
		<Section id="tools" title="Tools" desc="What the agent may do without asking. Reads and searches never ask.">
			<Row label="Edits need approval" desc="Show each edit as a diff to accept or reject"><Toggle value={get('agent.requireEditApproval', true)} onChange={v => set('agent.requireEditApproval', v)} /></Row>
			<Row label="Allow shell commands" desc="run_command / run_tests. Commands not on the allowlist still ask."><Toggle value={get('agent.allowRunCommand', true)} onChange={v => set('agent.allowRunCommand', v)} /></Row>
			<Row label="Auto-approve detected tests" desc="Run the detected test, typecheck and lint commands without a confirmation dialog"><Toggle value={get('agent.autoApproveDetectedTestCommand', false)} onChange={v => set('agent.autoApproveDetectedTestCommand', v)} /></Row>
			<Row label="Workspace sandbox" desc="Where shell commands may write. Auto uses macOS Seatbelt when sandbox-exec is available.">
				<Select value={get<'auto' | 'policy' | 'seatbelt' | 'off'>('agent.sandbox', 'auto')} onChange={v => set('agent.sandbox', v)} options={[
					{ value: 'auto', label: 'Auto' }, { value: 'policy', label: 'Policy (lexical check)' }, { value: 'seatbelt', label: 'macOS Seatbelt' }, { value: 'off', label: 'Off' },
				]} />
			</Row>
			<Row label="Pre-approved commands" desc="One per line. A prefix matches at a token boundary, e.g. npm test. Every segment of a chain must match." wide>
				<TextArea mono rows={4} value={get<string[]>('agent.preApprovedCommands', []).join('\n')} onChange={v => set('agent.preApprovedCommands', v.split('\n').map(x => x.trim()).filter(Boolean))} placeholder={'npm test\nnpx vitest'} />
			</Row>
			<Row label="Deny patterns" desc="Extra regular expressions. A matching command is always refused. Built-ins already cover rm -rf /, sudo, force push and similar." wide>
				<TextArea mono rows={3} value={get<string[]>('agent.denyCommandPatterns', []).join('\n')} onChange={v => set('agent.denyCommandPatterns', v.split('\n').map(x => x.trim()).filter(Boolean))} placeholder={'\\bnpm\\s+publish\\b'} />
			</Row>
			<Row label="Hooks" desc='JSON merged with .riaf/hooks.json: { "preTool": [{ "matcher", "command" }], "postEdit": [...] }. Exit code 2 or {"decision":"block"} blocks the call.' wide>
				<TextArea mono rows={5} value={JSON.stringify(get('agent.hooks', {}), null, 2)} onChange={v => { try { void set('agent.hooks', JSON.parse(v || '{}')); } catch { /* wait for valid JSON */ } }} />
			</Row>
			<Note>Read-only tools (search_codebase, grep, find_references, get_neighbors, …) are also exposed to Copilot Chat as <code>#riaf</code>, <code>#riafContext</code> and <code>#riafSymbols</code>.</Note>
		</Section>
	);
}

function Rules({ rules, path, call }: { rules: string; path?: string; call: (r: Parameters<typeof request>[0]) => Promise<void> }) {
	const [text, setText] = useState(rules);
	useEffect(() => setText(rules), [rules]);
	const dirty = text !== rules;
	return (
		<Section id="rules" title="Rules" desc="Project rules the agent always sees (coding conventions, forbidden areas, how to run things). Stored in the repo so the whole team shares them.">
			<TextArea mono rows={12} value={text} onChange={setText} placeholder={'# Example\n- Use the shared logger, never console.log\n- Services live under src/services; tests beside them as *.test.ts\n- Run `npm run typecheck` before tests'} />
			<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
				<Button kind="primary" disabled={!dirty} onClick={() => call({ type: 'setRules', text })}>Save</Button>
				<Button disabled={!dirty} onClick={() => setText(rules)}>Revert</Button>
				<span style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>{path ?? '.riafrules'} · also read by Claude Code via CLAUDE.md after "Set up Claude Code"</span>
			</div>
		</Section>
	);
}

function Usage({ usage, transportId, call }: { usage?: { session: UsageTotals; allTime: UsageTotals }; transportId?: string; call: (r: Parameters<typeof request>[0]) => Promise<void> }) {
	const s = usage?.session, a = usage?.allTime;
	const saving = useMemo(() => s && s.inputTokens + s.savedTokens > 0 ? Math.round(100 * s.savedTokens / (s.inputTokens + s.savedTokens)) : 0, [s]);
	return (
		<Section id="usage" title="Usage" desc={`Token usage metered per model call${transportId ? ` · transport: ${transportId}` : ''}.`}>
			<div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>This session</div>
			<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
				<StatCard label="Calls" value={String(s?.calls ?? 0)} />
				<StatCard label="Input tokens" value={fmtTokens(s?.inputTokens ?? 0)} sub={`${fmtTokens(s?.cacheReadTokens ?? 0)} from cache`} />
				<StatCard label="Output tokens" value={fmtTokens(s?.outputTokens ?? 0)} />
				<StatCard label="Saved by RIAF" value={fmtTokens(s?.savedTokens ?? 0)} sub={`${saving}% of what would have been sent`} />
				<StatCard label="Est. cost" value={fmtUsd(s?.costUSD ?? 0)} />
			</div>
			<div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', marginTop: 6 }}>All time</div>
			<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
				<StatCard label="Calls" value={String(a?.calls ?? 0)} />
				<StatCard label="Input tokens" value={fmtTokens(a?.inputTokens ?? 0)} sub={`${fmtTokens(a?.cacheReadTokens ?? 0)} from cache`} />
				<StatCard label="Output tokens" value={fmtTokens(a?.outputTokens ?? 0)} />
				<StatCard label="Saved by RIAF" value={fmtTokens(a?.savedTokens ?? 0)} />
				<StatCard label="Est. cost" value={fmtUsd(a?.costUSD ?? 0)} />
			</div>
			<div><Button kind="danger" small onClick={() => call({ type: 'resetUsage' })}>Reset all-time counters</Button></div>
			<Note>"Saved" counts tokens kept out of prompts by stale-result compaction, context trimming and duplicate-read suppression. Costs use the built-in price table and are estimates; with Copilot-provided models token counts are estimated too.</Note>
		</Section>
	);
}

function ClaudeCode({ status, bridge, call, get, set }: P & { status?: HostResponse['claudeCode']; bridge?: HostResponse['bridge']; call: (r: Parameters<typeof request>[0]) => Promise<void> }) {
	const n = status?.network;
	const proxyOk = !!n?.writtenProxy && n.upToDate;
	return (
		<Section id="claude" title="Claude Code" desc="Developers using Claude Code get the same index through a local MCP server plus /riaf-plan, /riaf-verify and /riaf-context commands. Setup also writes the corporate proxy for Claude Code itself.">
			<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
				<Badge ok={status?.mcpJson} text={status?.mcpJson ? '.mcp.json has the riaf server' : '.mcp.json not set up'} />
				<Badge ok={status?.commands} text={status?.commands ? '.claude/commands installed' : '.claude/commands missing'} />
				<Badge ok={status?.rules} text={status?.rules ? 'CLAUDE.md carries RIAF rules' : 'CLAUDE.md rules missing'} />
			</div>
			<div><Button kind="primary" onClick={() => call({ type: 'setupClaudeCode' })}>{status?.mcpJson ? 'Re-run setup' : 'Set up Claude Code for this repo'}</Button></div>
			{status?.mcpEntry && <div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>MCP server: <code>{status.mcpEntry}</code></div>}

			<h3 style={{ fontSize: 14, fontWeight: 600, margin: '14px 0 2px' }}>Corporate network for Claude Code</h3>
			<div style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>Claude Code reads the proxy from <code>{n?.settingsPath ?? '~/.claude/settings.json'}</code>, not from npm or VS Code. Setup writes what it detects; override below if detection is wrong.</div>
			{n && <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
				<Badge ok={proxyOk} warn={!n.writtenProxy && !!n.detectedProxy} text={n.writtenProxy ? `written: HTTPS_PROXY=${n.writtenProxy}${!n.upToDate ? ` (detected now: ${n.detectedProxy} — run setup)` : ''}` : n.detectedProxy ? `detected ${n.detectedProxy} [${n.detectedProxySource}] — not yet written, run setup` : 'no proxy detected or written'} />
				<Badge ok={!!n.writtenCa} warn={!n.writtenCa && n.caRequiredHint && !!n.detectedProxy} text={n.writtenCa ? `written: NODE_EXTRA_CA_CERTS=${n.writtenCa}` : n.detectedCa ? `CA detected ${n.detectedCa} [${n.detectedCaSource}] — run setup` : n.caRequiredHint ? 'no CA bundle: needed if the proxy inspects TLS (Node < 22.15)' : 'no CA bundle (OS store will be used)'} />
			</div>}
			{n && <Badge ok={n.credentialSource !== 'none'} warn={n.credentialSource === 'none' && !!n.detectedProxy} text={n.credentialSource === 'url' ? `credentials in the detected proxy URL (${n.credentialUser})` : n.credentialSource === 'secrets' ? `credentials stored in the OS credential store (${n.credentialUser})` : 'no proxy credentials — needed if the proxy asks for a user name and password'} />}
			<Row label="Write network settings" desc="Let setup update ~/.claude/settings.json"><Toggle value={get('claudeCode.writeUserSettings', true)} onChange={v => set('claudeCode.writeUserSettings', v)} /></Row>
			<Row label="Proxy URL" desc="Host and port only — never put a password here. Empty = auto-detect (VS Code http.proxy → HTTPS_PROXY → npm config)"><TextInput mono value={get('claudeCode.proxyUrl', '')} onChange={v => set('claudeCode.proxyUrl', v)} placeholder="http://proxy.example.com:8080" /></Row>
			<Row label="Proxy credentials" desc="Kept in the OS credential store. With the bridge on, they never leave VS Code; without it they go into ~/.claude/settings.json"><Button onClick={() => call({ type: 'setProxyCredentials' })}>{n?.credentialSource === 'secrets' ? 'Change credentials…' : 'Set credentials…'}</Button></Row>
			<Row label="Local proxy bridge" desc="127.0.0.1 proxy that adds your credentials and forwards to the corporate proxy. Recommended for authenticated proxies; logs each CONNECT and the upstream's answer">
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					<Toggle value={get('claudeCode.proxyBridge', true)} onChange={v => set('claudeCode.proxyBridge', v)} label={get('claudeCode.proxyBridge', true) ? 'enabled' : 'disabled'} />
					{bridge && <Badge ok={bridge.running} warn={bridge.enabled && !bridge.running} text={bridge.running ? `running at ${bridge.url} → ${bridge.upstream}` : bridge.enabled ? `not running — ${bridge.error ?? 'unknown'}` : 'disabled'} />}
					{bridge?.stats && <div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>CONNECTs {bridge.stats.connects} · ok {bridge.stats.upstreamOk} · refused {bridge.stats.upstreamRejected}{bridge.stats.lastUpstreamStatus ? ` · last upstream: ${bridge.stats.lastUpstreamStatus}` : ''}{bridge.stats.lastError ? ` · last error: ${bridge.stats.lastError}` : ''}</div>}
					<div style={{ display: 'flex', gap: 8 }}>
						<Button small onClick={() => call({ type: 'bridgeStart' })}>{bridge?.running ? 'Restart' : 'Start'}</Button>
						<Button small onClick={() => call({ type: 'bridgeStop' })} disabled={!bridge?.running}>Stop</Button>
						<Button small onClick={() => call({ type: 'bridgeLog' })}>Log</Button>
					</div>
				</div>
			</Row>
			<Row label="Bridge port"><NumberInput min={1024} max={65535} value={get('claudeCode.proxyBridgePort', 3128)} onChange={v => set('claudeCode.proxyBridgePort', v)} /></Row>
			<Row label="No-proxy hosts" desc="Comma-separated; add your intranet suffix"><TextInput mono value={get<string[]>('claudeCode.noProxy', []).join(', ')} onChange={v => set('claudeCode.noProxy', v.split(',').map(x => x.trim()).filter(Boolean))} /></Row>
			<Row label="Corporate root CA (.pem)" desc="Empty = auto-detect (NODE_EXTRA_CA_CERTS → npm cafile)"><TextInput mono value={get('claudeCode.caCertPath', '')} onChange={v => set('claudeCode.caCertPath', v)} placeholder="C:\certs\corp-root-ca.pem" /></Row>
		</Section>
	);
}

createRoot(document.getElementById('root')!).render(<App />);
