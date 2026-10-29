import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { onPush, request, type HostResponse, type IndexStatus, type UsageTotals } from './bridge.js';
import { Badge, Button, Note, NumberInput, Row, Section, Select, StatCard, TextArea, TextInput, Toggle, fmtTokens, fmtUsd } from './ui.js';

/* ───────────────────────────── state ───────────────────────────── */

type Settings = Record<string, unknown>;
const TABS = [
	['gateway', 'Gateway'], ['providers', 'Providers'], ['index', 'Repository Intelligence'], ['agent', 'Agent'], ['tools', 'Tools'],
	['mcp', 'MCP'], ['integrations', 'Integrations'], ['rules', 'Rules'], ['usage', 'Usage'], ['claude', 'Claude Code'],
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
				{show('providers') && <Providers get={get} set={set} detected={state.detected} call={call} />}
				{show('index') && <RepoIntelligence get={get} set={set} index={state.index} call={call} />}
				{show('agent') && <Agent get={get} set={set} />}
				{show('tools') && <Tools get={get} set={set} />}
				{show('mcp') && <Mcp mcp={state.mcp} get={get} set={set} call={call} />}
				{show('integrations') && <Integrations block={state.integrations} get={get} set={set} call={call} />}
				{show('rules') && <Rules rules={state.rules ?? ''} path={state.rulesPath} sources={state.ruleSources} call={call} />}
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
			<Row label="Light agent" desc="Skip the plan, shrink the repo profile and cap exploration at 6 reads. For narrow follow-ups."><Toggle value={get('agent.enableLightAgent', false)} onChange={v => set('agent.enableLightAgent', v)} /></Row>
			<Row label="Parallel reads" desc="A side-call may add up to four extra reads to run alongside one read-only call."><Toggle value={get('agent.enableParallelReadBatching', false)} onChange={v => set('agent.enableParallelReadBatching', v)} /></Row>
			<Row label="Nudge to verify" desc="When auto-verify is off, tell the agent which test or start command to run instead of running it."><Toggle value={get('agent.sandboxVerificationNudge', false)} onChange={v => set('agent.sandboxVerificationNudge', v)} /></Row>
			<Row label="Consecutive failures" desc="Stop after this many tool failures in a row (1–10)"><NumberInput min={1} max={10} value={get('agent.maxConsecutiveToolFails', 3)} onChange={v => set('agent.maxConsecutiveToolFails', v)} /></Row>
			<Row label="Explore steps" desc="Tool calls the explore subagent may take (1–20)"><NumberInput min={1} max={20} value={get('agent.exploreMaxSteps', 8)} onChange={v => set('agent.exploreMaxSteps', v)} /></Row>
			<Row label="Stream stall" desc="Seconds of silence before a model stream is retried"><NumberInput min={10} max={300} value={Math.round(get('agent.llmStreamStallTimeoutMs', 120000) / 1000)} onChange={v => set('agent.llmStreamStallTimeoutMs', v * 1000)} /></Row>
			<Row label="Diagnostics wait" desc="Milliseconds to wait for the language server after an edit"><NumberInput min={0} max={5000} step={100} value={get('agent.diagnosticsSettleMs', 1200)} onChange={v => set('agent.diagnosticsSettleMs', v)} /></Row>
			<Row label="Session budget (USD)" desc="Stop when this session's estimated cost reaches this. 0 means no limit."><NumberInput min={0} max={1000} step={0.5} value={get('agent.sessionBudgetUsd', 0)} onChange={v => set('agent.sessionBudgetUsd', v)} /></Row>
			<Row label="AI instructions" desc="Added to every agent prompt. Leave empty to keep the built-in policy only."><TextArea value={get('general.aiInstructions', '')} onChange={v => set('general.aiInstructions', v)} /></Row>
			<Row label="Disable built-in system prompt" desc="Send only your AI instructions plus the mode line."><Toggle value={get('general.disableSystemPrompt', false)} onChange={v => set('general.disableSystemPrompt', v)} /></Row>
			<Row label="Metrics opt-out" desc="Do not record token totals for this session."><Toggle value={get('general.metricsOptOut', false)} onChange={v => set('general.metricsOptOut', v)} /></Row>
			{(['main', 'plan', 'summary', 'explore', 'critic', 'commit', 'autocomplete'] as const).map(purpose => (
				<Row key={purpose} label={`${purpose} model`} desc={purpose === 'autocomplete' ? 'Inline completions stay off until this is set.' : 'Empty uses the chat or gateway model.'}>
					<TextInput mono value={get(`models.${purpose}`, '')} onChange={v => set(`models.${purpose}`, v)} placeholder="provider model id" />
				</Row>
			))}
		</Section>
	);
}

function Providers({ get, set, detected, call }: P & { detected?: { ollama: string[] }; call: (r: Parameters<typeof request>[0]) => Promise<void> }) {
	const providers = get<Record<string, unknown>>('providers', {});
	const patch = (key: string, value: unknown) => set('providers', { ...providers, [key]: value });
	const lines = (value: unknown) => Array.isArray(value) ? (value as string[]).join('\n') : '';
	return (
		<Section id="providers" title="Providers" desc="Native model providers. Leave Active empty to keep using the gateway or Copilot. Keys are saved with RIAF: Set Provider Key, not in this form.">
			<Row label="Active provider" desc="gateway keeps the Gateway tab. The others call the vendor API.">
				<Select value={String(providers.active ?? '')} onChange={v => patch('active', v)} options={[
					{ value: '', label: 'Gateway or Copilot' }, { value: 'gateway', label: 'Gateway' },
					{ value: 'anthropic', label: 'Anthropic' }, { value: 'openai', label: 'OpenAI' },
					{ value: 'gemini', label: 'Gemini' }, { value: 'ollama', label: 'Ollama' }, { value: 'openaiCompatible', label: 'OpenAI-compatible' },
				]} />
			</Row>
			<Row label="Anthropic model"><TextInput mono value={String(providers.anthropicModel ?? '')} onChange={v => patch('anthropicModel', v)} placeholder="claude-sonnet-4-5" /></Row>
			<Row label="OpenAI model"><TextInput mono value={String(providers.openaiModel ?? '')} onChange={v => patch('openaiModel', v)} placeholder="gpt-4.1" /></Row>
			<Row label="Gemini model"><TextInput mono value={String(providers.geminiModel ?? '')} onChange={v => patch('geminiModel', v)} placeholder="gemini-2.5-pro" /></Row>
			<Row label="Ollama URL"><TextInput mono value={String(providers.ollamaUrl ?? 'http://127.0.0.1:11434')} onChange={v => patch('ollamaUrl', v)} /></Row>
			<Row label="Ollama model"><TextInput mono value={String(providers.ollamaModel ?? '')} onChange={v => patch('ollamaModel', v)} placeholder="qwen2.5-coder:7b" /></Row>
			<Row label="Compatible base URL"><TextInput mono value={String(providers.compatibleUrl ?? '')} onChange={v => patch('compatibleUrl', v)} placeholder="http://127.0.0.1:8000/v1" /></Row>
			<Row label="Compatible model"><TextInput mono value={String(providers.compatibleModel ?? '')} onChange={v => patch('compatibleModel', v)} /></Row>
			<Row label="Reasoning"><Toggle value={Boolean(providers.reasoningEnabled)} onChange={v => patch('reasoningEnabled', v)} /></Row>
			<Row label="Reasoning budget" desc="Anthropic thinking budget tokens. 0 leaves it off."><NumberInput min={0} max={32000} value={Number(providers.reasoningBudget ?? 0)} onChange={v => patch('reasoningBudget', v)} /></Row>
			<Row label="Reasoning effort" desc="Sent as reasoning_effort on OpenAI-compatible calls.">
				<Select value={String(providers.reasoningEffort ?? 'medium')} onChange={v => patch('reasoningEffort', v)} options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} />
			</Row>
			<Row label="Hidden models" desc="One model id per line. Hidden ids are dropped from the visible list." wide>
				<TextArea mono rows={3} value={lines(providers.hiddenModels)} onChange={v => patch('hiddenModels', v.split('\n').map(x => x.trim()).filter(Boolean))} />
			</Row>
			<Row label="Custom models" desc="One model id per line. Added on top of a discovered list." wide>
				<TextArea mono rows={3} value={lines(providers.customModels)} onChange={v => patch('customModels', v.split('\n').map(x => x.trim()).filter(Boolean))} />
			</Row>
			<Row label="Overrides JSON" desc="Shallow-merged into the provider request body." wide>
				<TextArea mono rows={4} value={JSON.stringify(providers.overrides ?? {}, null, 2)} onChange={v => { try { patch('overrides', JSON.parse(v || '{}')); } catch { /* wait */ } }} />
			</Row>
			<div><Button onClick={() => call({ type: 'detectProviders' })}>Detect local Ollama</Button></div>
			{detected && <Note>{detected.ollama.length ? `Ollama models: ${detected.ollama.join(', ')}` : 'No Ollama models at the URL above.'}</Note>}
		</Section>
	);
}

function Tools({ get, set }: P) {
	return (
		<Section id="tools" title="Tools" desc="What the agent may do without asking. Reads and searches never ask.">
			<Row label="Edits need approval" desc="Show each edit as a diff to accept or reject"><Toggle value={get('agent.requireEditApproval', true)} onChange={v => set('agent.requireEditApproval', v)} /></Row>
			<Row label="Allow shell commands" desc="run_command / run_tests. Commands not on the allowlist still ask."><Toggle value={get('agent.allowRunCommand', true)} onChange={v => set('agent.allowRunCommand', v)} /></Row>
			<Row label="Approve terminal" desc="Ask before a command that is not allow-listed. Off runs it. Denied commands stay denied."><Toggle value={get('agent.approveTerminal', true)} onChange={v => set('agent.approveTerminal', v)} /></Row>
			<Row label="Approve MCP calls" desc="Ask before each external MCP tool call."><Toggle value={get('agent.approveMcp', true)} onChange={v => set('agent.approveMcp', v)} /></Row>
			<Row label="Web search" desc="search_web uses Tavily or the gateway /search route."><Toggle value={get('webSearch.enabled', false)} onChange={v => set('webSearch.enabled', v)} /></Row>
			<Row label="Web search provider" desc="tavily needs RIAF: Set Web Search Key. gateway posts to <gateway>/search.">
				<Select value={get('webSearch.provider', 'tavily')} onChange={v => set('webSearch.provider', v)} options={[{ value: 'tavily', label: 'Tavily' }, { value: 'gateway', label: 'Gateway' }]} />
			</Row>
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
			<Note>Every read-only tool is also a Copilot language-model tool (<code>#riaf</code>, <code>#riafContext</code>, <code>#riafSymbols</code>, <code>#riafGrep</code>, <code>#riafRefs</code>, and the rest). Edits and shell commands stay on @riaf, where they can ask first.</Note>
		</Section>
	);
}

function Mcp({ mcp, get, set, call }: P & { mcp?: HostResponse['mcp']; call: (r: Parameters<typeof request>[0]) => Promise<void> }) {
	const disabled = get<string[]>('mcp.disabledServers', []);
	const servers = mcp?.servers ?? [];
	const toggle = (name: string, on: boolean) => {
		const next = new Set(disabled);
		if (on) { next.delete(name); } else { next.add(name); }
		void set('mcp.disabledServers', [...next]);
	};
	return (
		<Section id="mcp" title="MCP" desc="Servers from the workspace .mcp.json and .vscode/mcp.json, then ~/.mcp.json and ~/.cursor/mcp.json. Enabled servers are offered to @riaf as mcp_<server>_<tool>.">
			<div><Button onClick={() => call({ type: 'mcpRefresh' })}>Refresh tools</Button></div>
			{servers.map(server => (
				<Row key={server.name} label={`${server.name} · ${server.transport}`} desc={`${server.target}${server.tools.length ? ` — ${server.tools.join(', ')}` : ''}${server.error ? ` — ${server.error}` : ''}`}>
					<Toggle value={!disabled.includes(server.name)} onChange={on => toggle(server.name, on)} />
				</Row>
			))}
			{!servers.length && <Note>No MCP servers found. Add one to .mcp.json in this folder, or to ~/.cursor/mcp.json.</Note>}
		</Section>
	);
}

function Integrations({ block, get, set, call }: P & { block?: HostResponse['integrations']; call: (r: Parameters<typeof request>[0]) => Promise<void> }) {
	const [testing, setTesting] = useState<string | undefined>();
	const test = async (id?: string) => { setTesting(id ?? 'all'); try { await call({ type: 'integrationHealth', id }); } finally { setTesting(undefined); } };
	const adapters = block?.adapters ?? [];
	return (
		<Section id="integrations" title="Integrations" desc="Enterprise systems the agent can read from and, with your approval, write to: Jira, Confluence, GitLab (self-hosted or gitlab.com) and vector / knowledge-graph stores. Enabled tools appear in @riaf, as #riaf… tools in Copilot, and in the Claude Code MCP server.">
			<Row label="Approve writes" desc="Ask before any tool that changes data (create issue, comment, update page, create MR, …). Every write is recorded in .riaf/audit.jsonl either way."><Toggle value={get('agent.approveIntegrationWrites', true)} onChange={v => set('agent.approveIntegrationWrites', v)} /></Row>
			<Row label="Share credentials with Claude Code" desc={`Also write the tokens to ${block?.credentialsFile ?? '~/.riaf/credentials.json'} (mode 0600) so the MCP server can use them. Off: set RIAF_INTEGRATION_<ID>_<KEY> environment variables for Claude Code instead.`}>
				<Toggle value={get('integrations.shareCredentialsWithClaudeCode', false)} onChange={v => set('integrations.shareCredentialsWithClaudeCode', v)} />
			</Row>
			<div style={{ display: 'flex', gap: 8 }}>
				<Button onClick={() => test()} disabled={!!testing}>{testing === 'all' ? 'Testing…' : 'Test all connections'}</Button>
				<Button small onClick={() => call({ type: 'openAudit' })}>Open audit log</Button>
			</div>
			{adapters.map(a => {
				const key = `integrations.${a.id}`;
				const cfg = get<Record<string, unknown>>(key, {}) ?? {};
				const enabled = cfg.enabled === true;
				const update = (k: string, v: unknown) => set(key, { ...cfg, [k]: v });
				const reads = a.tools.filter(t => t.kind === 'read').length, writes = a.tools.length - reads;
				const h = a.health;
				return (
					<div key={a.id} style={{ border: '1px solid var(--vscode-editorGroup-border)', borderRadius: 4, padding: '10px 12px', margin: '10px 0' }}>
						<div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
							<Toggle value={enabled} onChange={v => update('enabled', v)} />
							<span style={{ fontWeight: 600, fontSize: 14 }}>{a.displayName}</span>
							<span style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>{reads} read · {writes} write tools</span>
							<span style={{ flex: 1 }} />
							<Button small onClick={() => test(a.id)} disabled={!enabled || !!testing}>{testing === a.id ? 'Testing…' : 'Test connection'}</Button>
						</div>
						{h && <div style={{ marginTop: 6 }}><Badge ok={h.ok} warn={!h.ok && h.enabled} text={`${h.message}${h.latencyMs ? ` · ${h.latencyMs} ms` : ''}`} /></div>}
						{enabled && (
							<div style={{ marginTop: 6 }}>
								{Object.entries(a.settingsSchema).map(([k, sch]) => (
									<Row key={k} label={k} desc={sch.description}>
										{sch.type === 'boolean' ? <Toggle value={(cfg[k] as boolean) ?? (sch.default as boolean) ?? false} onChange={v => update(k, v)} />
											: sch.type === 'number' ? <NumberInput value={(cfg[k] as number) ?? (sch.default as number) ?? 0} onChange={v => update(k, v)} />
												: sch.type === 'enum' ? <Select value={String(cfg[k] ?? sch.default ?? sch.enum?.[0] ?? '')} onChange={v => update(k, v)} options={(sch.enum ?? []).map(e => ({ value: e, label: e }))} />
													: <TextInput mono value={String(cfg[k] ?? '')} onChange={v => update(k, v)} placeholder={sch.default !== undefined && sch.default !== '' ? String(sch.default) : undefined} />}
									</Row>
								))}
								<Row label="Credentials" desc={`${a.credentials.map(c => `${c.label}${c.stored ? ' ✓' : ' (not set)'}`).join(' · ')}. Stored in the OS credential store, never in settings files.`}>
									<div style={{ display: 'flex', gap: 8 }}>
										<Button small onClick={() => call({ type: 'setIntegrationCredentials', id: a.id })}>{a.credentials.some(c => c.stored) ? 'Change…' : 'Set…'}</Button>
										{a.credentials.some(c => c.stored) && <Button small kind="danger" onClick={() => call({ type: 'clearIntegrationCredentials', id: a.id })}>Clear</Button>}
									</div>
								</Row>
								<div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>Tools: {a.tools.map(t => `${t.name}${t.kind === 'write' ? '*' : ''}`).join(', ')} <i>(* = write, asks first)</i></div>
							</div>
						)}
					</div>
				);
			})}
			<h3 style={{ fontSize: 14, fontWeight: 600, margin: '14px 0 2px' }}>Recent writes</h3>
			{block?.audit?.length ? (
				<div style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 3 }}>
					{block.audit.map((e, i) => <div key={i}><code>{new Date(e.at).toLocaleString()}</code> · {e.consumer} · <b>{e.adapter}.{e.tool}</b> · {e.ok ? 'ok' : <span style={{ color: 'var(--vscode-errorForeground)' }}>failed</span>} · {e.approved ?? ''} <span style={{ color: 'var(--vscode-descriptionForeground)' }}>{e.args.slice(0, 120)}</span></div>)}
				</div>
			) : <div style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>No integration writes recorded yet{block?.auditPath ? ` (${block.auditPath})` : ''}.</div>}
			<Note>Claude Code reads the enabled flags and URLs from <code>{block?.configPath ?? '.riaf/integrations.json'}</code> (written automatically, no secrets) and the tokens from <code>RIAF_INTEGRATION_*</code> environment variables or the shared credentials file. Restart the Claude Code session after enabling an integration so the MCP server picks up the new tools.</Note>
		</Section>
	);
}

function Rules({ rules, path, sources, call }: { rules: string; path?: string; sources?: string[]; call: (r: Parameters<typeof request>[0]) => Promise<void> }) {
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
			{sources && sources.length > 0 && <Note>Also loaded into the prompt: {sources.join(', ')}</Note>}
		</Section>
	);
}

function Usage({ usage, transportId, call }: { usage?: HostResponse['usage']; transportId?: string; call: (r: Parameters<typeof request>[0]) => Promise<void> }) {
	const s = usage?.session, a = usage?.allTime;
	const cc = usage?.claudeCode; const tools = usage?.tools;
	const when = (t?: number) => t ? new Date(t).toLocaleString() : '—';
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
				<StatCard label="Cache efficiency" value={`${Math.round(100 * (usage?.cacheEfficiency ?? 0))}%`} sub="cache read / prompt tokens" />
			</div>
			{usage?.byProvider && Object.keys(usage.byProvider).length > 0 && <Note>{Object.entries(usage.byProvider).map(([name, row]) => `${name}: ${row.calls} calls, ${row.inputTokens} in`).join(' · ')}</Note>}
			{usage?.days && usage.days.length > 0 && (
				<div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 48, margin: '8px 0' }}>
					{usage.days.map(d => {
						const max = Math.max(1, ...usage.days!.map(x => x.inputTokens));
						return <div key={d.day} title={`${d.day}: ${d.inputTokens} in`} style={{ flex: 1, height: `${Math.max(4, Math.round(44 * d.inputTokens / max))}px`, background: 'var(--vscode-button-background)' }} />;
					})}
				</div>
			)}
			<div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', marginTop: 6 }}>All time</div>
			<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
				<StatCard label="Calls" value={String(a?.calls ?? 0)} />
				<StatCard label="Input tokens" value={fmtTokens(a?.inputTokens ?? 0)} sub={`${fmtTokens(a?.cacheReadTokens ?? 0)} from cache`} />
				<StatCard label="Output tokens" value={fmtTokens(a?.outputTokens ?? 0)} />
				<StatCard label="Saved by RIAF" value={fmtTokens(a?.savedTokens ?? 0)} />
				<StatCard label="Est. cost" value={fmtUsd(a?.costUSD ?? 0)} />
			</div>
			<Note>The two blocks above count model calls <b>RIAF makes itself</b> — @riaf, /run, quick edit, commit messages, summaries, explore. When Copilot or Claude Code call RIAF's tools, <i>they</i> make the model call; those tokens appear in the sections below.</Note>

			<h3 style={{ fontSize: 14, fontWeight: 600, margin: '14px 0 2px' }}>Tools served{usage?.repo ? ` · ${usage.repo}` : ''}</h3>
			<div style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>RIAF tool calls answered for other assistants. "Saved" estimates the tokens they would have spent reading the whole files instead of the ranked chunks / outlines RIAF returned.</div>
			{tools && tools.total.calls > 0 ? (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					{Object.entries(tools.byConsumer).map(([consumer, row]) => (
						<div key={consumer}>
							<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
								<StatCard label={consumer === 'claude-code' ? 'Claude Code · calls' : consumer === 'copilot' ? 'Copilot · calls' : `${consumer} · calls`} value={String(row.calls)} sub={row.errors ? `${row.errors} errors` : undefined} />
								<StatCard label="Returned" value={fmtTokens(Math.round(row.charsReturned / 4))} sub="tokens (chars ÷ 4)" />
								<StatCard label="Saved (est.)" value={fmtTokens(row.savedTokensEst)} sub="vs reading whole files" />
								<StatCard label="Last call" value={when(row.lastAt)} />
							</div>
							<div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', marginTop: 4 }}>
								{Object.entries(row.tools).sort((x, y) => y[1].calls - x[1].calls).slice(0, 10).map(([t, c]) => `${t} ×${c.calls}`).join(' · ')}
							</div>
						</div>
					))}
				</div>
			) : <div style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>No tool calls served yet for this repo. Use <code>#riaf</code> in Copilot Chat or any riaf tool in Claude Code.</div>}

			<h3 style={{ fontSize: 14, fontWeight: 600, margin: '14px 0 2px' }}>Claude Code · this repo</h3>
			<div style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>Real numbers from Claude Code's own transcripts under <code>~/.claude/projects</code> (read locally; nothing is sent). Covers every Claude Code session in this folder, with or without RIAF.</div>
			{cc?.projectDir ? (
				<>
					<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
						<StatCard label="Calls" value={String(cc.calls)} sub={`${cc.sessions} session${cc.sessions === 1 ? '' : 's'}`} />
						<StatCard label="Input tokens" value={fmtTokens(cc.inputTokens)} sub={`${fmtTokens(cc.cacheReadTokens)} from cache · ${fmtTokens(cc.cacheWriteTokens)} written`} />
						<StatCard label="Output tokens" value={fmtTokens(cc.outputTokens)} />
						<StatCard label="Cache efficiency" value={`${Math.round(100 * cc.cacheEfficiency)}%`} sub="cache read / prompt tokens" />
						<StatCard label="Est. cost" value={fmtUsd(cc.costUSD)} sub={cc.unpricedModels.length ? `no price for ${cc.unpricedModels.join(', ')}` : 'Anthropic list prices'} />
						<StatCard label="Last activity" value={when(cc.lastAt)} />
					</div>
					{Object.keys(cc.byModel).length > 0 && <div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>{Object.entries(cc.byModel).map(([m, r]) => `${m}: ${r.calls} calls, ${fmtTokens(r.inputTokens + r.cacheReadTokens)} in, ${fmtTokens(r.outputTokens)} out, ${fmtUsd(r.costUSD)}`).join(' · ')}</div>}
				</>
			) : <div style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>No Claude Code transcripts found for this folder yet (looked under ~/.claude/projects). Run <code>claude</code> in this repo once, or turn on <code>riaf.usage.readClaudeCodeTranscripts</code>.</div>}

			<h3 style={{ fontSize: 14, fontWeight: 600, margin: '14px 0 2px' }}>RIAF effect inside Claude Code</h3>
			<div style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>Sessions in this repo that used <code>riaf</code> tools versus sessions that did not, from the same transcripts. "Prompt tokens" = input + cache read + cache write per model call.</div>
			{cc?.riafEffect && (cc.riafEffect.with.calls > 0 || cc.riafEffect.without.calls > 0) ? (() => {
				const e = cc.riafEffect; const pctStr = (p?: number) => p === undefined ? '—' : `${p >= 0 ? '−' : '+'}${Math.abs(Math.round(100 * p))}%`;
				const sign = (p?: number) => p === undefined ? undefined : p >= 0;
				return (
					<>
						<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
							<StatCard label="Sessions" value={`${e.with.sessions} with · ${e.without.sessions} without`} sub={`${e.with.calls} vs ${e.without.calls} model calls`} />
							<StatCard label="Prompt tokens / call" value={`${fmtTokens(Math.round(e.with.avgPromptPerCall))} vs ${fmtTokens(Math.round(e.without.avgPromptPerCall))}`} sub={`with RIAF: ${pctStr(e.promptPerCallSavedPct)}`} />
							<StatCard label="Output tokens / call" value={`${fmtTokens(Math.round(e.with.avgOutputPerCall))} vs ${fmtTokens(Math.round(e.without.avgOutputPerCall))}`} sub={`with RIAF: ${pctStr(e.outputPerCallSavedPct)}`} />
							<StatCard label="File reads / turn" value={`${e.with.avgReadsPerTurn.toFixed(1)} vs ${e.without.avgReadsPerTurn.toFixed(1)}`} sub={`Read/Grep/Glob · with RIAF: ${pctStr(e.readsPerTurnSavedPct)}`} />
							<StatCard label="Saved by RIAF results" value={fmtTokens(e.directSavedTokens)} sub={`${Math.round(100 * e.directSavedPct)}% of with-RIAF prompt tokens · ${e.with.riafCalls} riaf calls`} />
						</div>
						{Object.keys(e.byTool).length > 0 && <div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>{Object.entries(e.byTool).sort((a, b) => b[1].calls - a[1].calls).map(([t, r]) => `${t} ×${r.calls} (~${fmtTokens(r.savedTokens)} saved)`).join(' · ')}</div>}
						{(e.with.calls === 0 || e.without.calls === 0) && <Note kind="warn">{e.with.calls === 0 ? 'No session has used riaf tools yet — the comparison needs at least one.' : 'Every session used RIAF — there is no "without" baseline yet; the direct estimate above still applies.'}</Note>}
						{sign(e.promptPerCallSavedPct) === false && <Note kind="warn">Prompt tokens per call are higher in RIAF sessions. That usually means those sessions were bigger tasks; the direct estimate is the fairer number.</Note>}
					</>
				);
			})() : <div style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>Needs Claude Code transcripts for this repo.</div>}
			<Note>The with/without comparison is observational — sessions differ in task size — so treat percentages as indicative. "Saved by RIAF results" is the same conservative estimate as "Tools served": whole-file size minus what RIAF returned, for search / outline / symbol results.</Note>

			<div style={{ display: 'flex', gap: 8 }}>
				<Button small onClick={() => call({ type: 'refreshUsage' })}>Refresh</Button>
				<Button kind="danger" small onClick={() => call({ type: 'resetUsage' })}>Reset RIAF counters</Button>
			</div>
			<Note>"Saved by RIAF" counts tokens kept out of prompts by stale-result compaction, context trimming and duplicate-read suppression. Costs use the built-in price table and are estimates; with Copilot-provided models token counts are estimated too. Copilot does not expose its own token usage to extensions, so for Copilot only the tools-served figures are available.</Note>
		</Section>
	);
}

function ClaudeCode({ status, bridge, call, get, set }: P & { status?: HostResponse['claudeCode']; bridge?: HostResponse['bridge']; call: (r: Parameters<typeof request>[0]) => Promise<void> }) {
	const n = status?.network;
	const proxyOk = !!n?.writtenProxy && n.upToDate;
	return (
		<Section id="claude" title="Claude Code" desc="Developers using Claude Code get the same index through a local MCP server plus /riaf-plan, /riaf-verify and /riaf-context commands. Setup also writes the corporate proxy for Claude Code itself.">
			<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
				<Badge ok={status?.mcpJson && !status?.mcpStale} warn={!!status?.mcpStale} text={status?.mcpJson ? (status.mcpStale ? `.mcp.json ${status.mcpStale} — run setup again` : '.mcp.json has the riaf server (version-independent launcher)') : '.mcp.json not set up'} />
				<Badge ok={status?.commands} text={status?.commands ? '.claude/commands installed' : '.claude/commands missing'} />
				<Badge ok={status?.rules} text={status?.rules ? 'CLAUDE.md carries RIAF rules' : 'CLAUDE.md rules missing'} />
			</div>
			<div><Button kind="primary" onClick={() => call({ type: 'setupClaudeCode' })}>{status?.mcpJson ? 'Re-run setup' : 'Set up Claude Code for this repo'}</Button></div>
			{status?.mcpEntry && <div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>MCP server: <code>{status.mcpEntry}</code></div>}

			<h3 style={{ fontSize: 14, fontWeight: 600, margin: '14px 0 2px' }}>Corporate network for Claude Code</h3>
			<div style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>Claude Code reads the proxy from <code>{n?.settingsPath ?? '~/.claude/settings.json'}</code>, not from npm or VS Code. Setup writes what it detects; override below if detection is wrong.</div>
			{n?.proxyError && <Note kind="warn">{n.proxyError}</Note>}
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
