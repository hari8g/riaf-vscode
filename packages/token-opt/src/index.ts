/*--------------------------------------------------------------------------------------
 *  @bosch-mps/token-opt — token optimisation for LLM agent loops.
 *  Lifted from the Trove VS Code fork; zero VS Code dependencies.
 *--------------------------------------------------------------------------------------*/

// caching
export * from './promptCache.js';

// trimming
export * from './contextWindowTrim.js';
export * from './wireMessageTrim.js';
export * from './budget.js';

// compaction & dedup
export * from './toolResultCompaction.js';
export * from './fileReadDedup.js';
export * from './parallelReadToolBatch.js';

// rate limiting
export * from './llmRateLimit.js';

// usage & pricing
export * from './llmMessageUsage.js';
export * from './llmPricing.js';
export * from './usageMeteringTypes.js';
export * from './agentOutputTokenLimits.js';
export * from './modelCapabilities.js';

// agent loop discipline (hints/limits/plan)
export * from './agentReadHints.js';
export * from './agentEditHints.js';
export * from './agentVerificationHints.js';
export * from './agentEditCompletionHints.js';
export * from './agentLoopLimits.js';
export * from './agentLoopSettings.js';
export * from './agentPlan.js';
export * from './lightAgent.js';
export * from './anthropicConversationWire.js';
export * from './terminalHeuristics.js';

// types
export * from './types.js';
export { URI, generateUuid, isWindows, removeAnsiEscapeCodes } from './shim/vsBase.js';

// ports
export * from './ports.js';
