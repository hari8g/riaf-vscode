import { type GlobalSettings } from '@bosch-mps/token-opt';
import type { RiafSettings } from './config.js';

/** The slice of RIAF settings the lifted token-opt limit helpers read. */
export function toGlobalSettings(s: RiafSettings): GlobalSettings {
	return {
		chatMode: 'agent',
		enableAgentPlan: s.agent.generatePlan,
		enableLightAgent: s.agent.enableLightAgent,
		enablePromptCache: s.gateway.promptCache,
		enableParallelReadBatching: s.agent.enableParallelReadBatching,
		maxAgentIterations: s.agent.maxIterations,
		maxReadOnlyCalls: s.agent.maxReadOnlyCalls,
		maxConsecutiveToolFails: s.agent.maxConsecutiveToolFails,
		llmStreamStallTimeoutMs: s.agent.llmStreamStallTimeoutMs,
	};
}

/** Repo-profile character cap: agent 8000, light 3200, plan/explain 1600. */
export function profileCharCap(mode: string, light: boolean): number {
	if (mode === 'plan' || mode === 'explain') { return 1_600; }
	return light ? 3_200 : 8_000;
}
