import * as vscode from 'vscode';

export type GatewayAuth = 'none' | 'microsoft-sso' | 'github-sso' | 'header';

export interface RiafSettings {
	index: { autoIndexOnStartup: boolean; watch: boolean; excludeGlobs: string[]; respectGitignore: boolean; treeSitter: boolean };
	embeddings: { enabled: boolean; model: string };
	gateway: {
		url: string; model: string; auth: GatewayAuth; ssoScopes: string[];
		headers: Record<string, string>; promptCache: boolean; stream: boolean;
	};
	claudeCode: { writeUserSettings: boolean; proxyUrl: string; noProxy: string[]; caCertPath: string; proxyBridge: boolean; proxyBridgePort: number };
	models: { main: string; plan: string; summary: string; explore: string; critic: string; commit: string; autocomplete: string };
	general: { aiInstructions: string; disableSystemPrompt: boolean; metricsOptOut: boolean };
	webSearch: { enabled: boolean; provider: 'tavily' | 'gateway' };
	security: { extraRules: { id: string; pattern: string; message: string }[] };
	mcp: { disabledServers: string[] };
	providers: ProviderSettings;
	agent: {
		maxIterations: number; maxReadOnlyCalls: number; generatePlan: boolean; autoVerify: boolean;
		requireEditApproval: boolean; allowRunCommand: boolean; contextWindowRatio: number;
		diagnosticsAfterEdit: boolean;
		autoApproveDetectedTestCommand: boolean; preApprovedCommands: string[]; denyCommandPatterns: string[];
		sandbox: SandboxMode;
		hooks: { preTool?: HookEntry[]; postEdit?: HookEntry[] };
		summarizeHistory: boolean; exploreSubagent: boolean; checkpoints: boolean;
		maxConsecutiveToolFails: number; llmStreamStallTimeoutMs: number; exploreMaxSteps: number; diagnosticsSettleMs: number;
		enableLightAgent: boolean; enableParallelReadBatching: boolean; sessionBudgetUsd: number; sandboxVerificationNudge: boolean;
		approveTerminal: boolean; approveMcp: boolean;
	};
}

export type ProviderKind = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'openaiCompatible';

export type ProviderSettings = {
	active: '' | ProviderKind | 'gateway';
	anthropicModel: string; openaiModel: string; geminiModel: string;
	ollamaUrl: string; ollamaModel: string;
	compatibleUrl: string; compatibleModel: string;
	hiddenModels: string[]; customModels: string[];
	overrides: Record<string, unknown>;
	reasoningEnabled: boolean; reasoningBudget: number; reasoningEffort: string;
};

export const DEFAULT_PROVIDERS: ProviderSettings = {
	active: '', anthropicModel: '', openaiModel: '', geminiModel: '',
	ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: '',
	compatibleUrl: '', compatibleModel: '',
	hiddenModels: [], customModels: [], overrides: {},
	reasoningEnabled: false, reasoningBudget: 0, reasoningEffort: 'medium',
};

export type SandboxMode = 'auto' | 'policy' | 'seatbelt' | 'off';
export type HookEntry = { matcher?: string; command: string; timeoutMs?: number };

export function readSettings(): RiafSettings {
	const c = vscode.workspace.getConfiguration('riaf');
	return {
		index: {
			autoIndexOnStartup: c.get('index.autoIndexOnStartup', true),
			watch: c.get('index.watch', true),
			excludeGlobs: c.get<string[]>('index.excludeGlobs', []),
			respectGitignore: c.get('index.respectGitignore', true),
			treeSitter: c.get('index.treeSitter', true),
		},
		embeddings: {
			enabled: c.get('embeddings.enabled', false),
			model: c.get('embeddings.model', 'amazon.titan-embed-text-v2:0'),
		},
		gateway: {
			url: c.get('gateway.url', '').replace(/\/+$/, ''),
			model: c.get('gateway.model', ''),
			auth: c.get<GatewayAuth>('gateway.auth', 'microsoft-sso'),
			ssoScopes: c.get<string[]>('gateway.ssoScopes', ['openid', 'profile', 'email']),
			headers: c.get<Record<string, string>>('gateway.headers', {}),
			promptCache: c.get('gateway.promptCache', true),
			stream: c.get('gateway.stream', true),
		},
		claudeCode: {
			writeUserSettings: c.get('claudeCode.writeUserSettings', true),
			proxyUrl: c.get('claudeCode.proxyUrl', ''),
			noProxy: c.get<string[]>('claudeCode.noProxy', ['localhost', '127.0.0.1']),
			caCertPath: c.get('claudeCode.caCertPath', ''),
			proxyBridge: c.get('claudeCode.proxyBridge', true),
			proxyBridgePort: c.get('claudeCode.proxyBridgePort', 3128),
		},
		models: {
			main: c.get('models.main', ''), plan: c.get('models.plan', ''), summary: c.get('models.summary', ''),
			explore: c.get('models.explore', ''), critic: c.get('models.critic', ''), commit: c.get('models.commit', ''),
			autocomplete: c.get('models.autocomplete', ''),
		},
		general: {
			aiInstructions: c.get('general.aiInstructions', ''),
			disableSystemPrompt: c.get('general.disableSystemPrompt', false),
			metricsOptOut: c.get('general.metricsOptOut', false),
		},
		webSearch: { enabled: c.get('webSearch.enabled', false), provider: c.get<'tavily' | 'gateway'>('webSearch.provider', 'tavily') },
		security: { extraRules: c.get('security.extraRules', []) },
		mcp: { disabledServers: c.get<string[]>('mcp.disabledServers', []) },
		providers: { ...DEFAULT_PROVIDERS, ...c.get<Partial<ProviderSettings>>('providers', {}) },
		agent: {
			maxIterations: c.get('agent.maxIterations', 25),
			maxReadOnlyCalls: c.get('agent.maxReadOnlyCalls', 12),
			generatePlan: c.get('agent.generatePlan', true),
			autoVerify: c.get('agent.autoVerify', true),
			requireEditApproval: c.get('agent.requireEditApproval', true),
			allowRunCommand: c.get('agent.allowRunCommand', true),
			contextWindowRatio: c.get('agent.contextWindowRatio', 0.85),
			diagnosticsAfterEdit: c.get('agent.diagnosticsAfterEdit', true),
			autoApproveDetectedTestCommand: c.get('agent.autoApproveDetectedTestCommand', false),
			preApprovedCommands: c.get<string[]>('agent.preApprovedCommands', []),
			denyCommandPatterns: c.get<string[]>('agent.denyCommandPatterns', []),
			sandbox: c.get<SandboxMode>('agent.sandbox', 'auto'),
			hooks: c.get<{ preTool?: HookEntry[]; postEdit?: HookEntry[] }>('agent.hooks', {}),
			summarizeHistory: c.get('agent.summarizeHistory', true),
			exploreSubagent: c.get('agent.exploreSubagent', true),
			checkpoints: c.get('agent.checkpoints', true),
			maxConsecutiveToolFails: c.get('agent.maxConsecutiveToolFails', 3),
			llmStreamStallTimeoutMs: c.get('agent.llmStreamStallTimeoutMs', 120_000),
			exploreMaxSteps: c.get('agent.exploreMaxSteps', 8),
			diagnosticsSettleMs: c.get('agent.diagnosticsSettleMs', 1_200),
			enableLightAgent: c.get('agent.enableLightAgent', false),
			enableParallelReadBatching: c.get('agent.enableParallelReadBatching', false),
			sessionBudgetUsd: c.get('agent.sessionBudgetUsd', 0),
			sandboxVerificationNudge: c.get('agent.sandboxVerificationNudge', false),
			approveTerminal: c.get('agent.approveTerminal', true),
			approveMcp: c.get('agent.approveMcp', true),
		},
	};
}

/** True when the developer pointed us at an internal gateway instead of Copilot's models. */
export const usesGateway = (s: RiafSettings): boolean => s.gateway.url.length > 0;
