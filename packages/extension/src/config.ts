import * as vscode from 'vscode';

export type GatewayAuth = 'none' | 'microsoft-sso' | 'github-sso' | 'header';

export interface RiafSettings {
	index: { autoIndexOnStartup: boolean; watch: boolean; excludeGlobs: string[] };
	embeddings: { enabled: boolean; model: string };
	gateway: {
		url: string; model: string; auth: GatewayAuth; ssoScopes: string[];
		headers: Record<string, string>; promptCache: boolean;
	};
	agent: {
		maxIterations: number; maxReadOnlyCalls: number; generatePlan: boolean; autoVerify: boolean;
		requireEditApproval: boolean; allowRunCommand: boolean; contextWindowRatio: number;
	};
}

export function readSettings(): RiafSettings {
	const c = vscode.workspace.getConfiguration('riaf');
	return {
		index: {
			autoIndexOnStartup: c.get('index.autoIndexOnStartup', true),
			watch: c.get('index.watch', true),
			excludeGlobs: c.get<string[]>('index.excludeGlobs', []),
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
		},
		agent: {
			maxIterations: c.get('agent.maxIterations', 25),
			maxReadOnlyCalls: c.get('agent.maxReadOnlyCalls', 12),
			generatePlan: c.get('agent.generatePlan', true),
			autoVerify: c.get('agent.autoVerify', true),
			requireEditApproval: c.get('agent.requireEditApproval', true),
			allowRunCommand: c.get('agent.allowRunCommand', true),
			contextWindowRatio: c.get('agent.contextWindowRatio', 0.85),
		},
	};
}

/** True when the developer pointed us at an internal gateway instead of Copilot's models. */
export const usesGateway = (s: RiafSettings): boolean => s.gateway.url.length > 0;
