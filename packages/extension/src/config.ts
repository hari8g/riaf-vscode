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
	agent: {
		maxIterations: number; maxReadOnlyCalls: number; generatePlan: boolean; autoVerify: boolean;
		requireEditApproval: boolean; allowRunCommand: boolean; contextWindowRatio: number;
		diagnosticsAfterEdit: boolean;
		autoApproveDetectedTestCommand: boolean; preApprovedCommands: string[]; denyCommandPatterns: string[];
		sandbox: SandboxMode;
		hooks: { preTool?: HookEntry[]; postEdit?: HookEntry[] };
		summarizeHistory: boolean; exploreSubagent: boolean; checkpoints: boolean;
	};
}

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
		},
	};
}

/** True when the developer pointed us at an internal gateway instead of Copilot's models. */
export const usesGateway = (s: RiafSettings): boolean => s.gateway.url.length > 0;
