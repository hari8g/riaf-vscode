# @bosch-mps/token-opt

Token optimisation for LLM agent loops, lifted out of the Trove VS Code fork
(`src/vs/workbench/contrib/trove/{common,browser}`) into a standalone ESM TypeScript
library with **zero VS Code dependencies**. The only runtime dependency is
[`vscode-uri`](https://www.npmjs.com/package/vscode-uri) (the standalone URI class).

```
npm run typecheck        # tsc --noEmit on src/
npm run typecheck:test   # tsc --noEmit on src/ + test/
npm test                 # vitest (18 files, 91 tests)
npm run build            # src/ -> dist/ (ESM + .d.ts)
```

## Quick start (host agent runner)

```ts
import {
  prepareMessagesForModel, getModelCapabilities, getReservedOutputTokenSpace,
  trackFileRead, shouldSkipDuplicateFileRead,
  type ChatMessage, type FileReadRecord,
} from '@bosch-mps/token-opt';

const caps = getModelCapabilities('anthropic', 'claude-sonnet-4-6', undefined);
const fileReads = new Map<string, FileReadRecord>();

const { messages, estimatedTokens, trimmed, compacted } = prepareMessagesForModel({
  messages: thread,                     // ChatMessage[]
  contextWindow: caps.contextWindow,
  reservedOutputTokens: getReservedOutputTokenSpace('anthropic', 'claude-sonnet-4-6', { isReasoningEnabled: false, overridesOfModel: undefined }) ?? 4096,
  chatMode: 'agent',
  providerName: 'anthropic',            // enables the Anthropic agent TPM cap
  fileReads,                            // compacted reads are invalidated here
  systemMessage,
});
```

## API summary

### caching — `promptCache.ts`
| export | purpose |
|---|---|
| `isAnthropicRoutedModel(provider, model)` | Claude served via OpenRouter / Bedrock / LiteLLM / Azure |
| `applyRoutedAnthropicPromptCache(messages, system, enable, provider, model, volatile?)` | add `cache_control` to the system block on OpenAI-wire Claude |
| `applyRoutedAnthropicConversationCache(messages, enable, provider, model)` | 2-breakpoint conversation cache on user turns |

### trimming — `contextWindowTrim.ts`, `wireMessageTrim.ts`, `budget.ts`
| export | purpose |
|---|---|
| `estimateTokens`, `estimateChatMessageTokens`, `estimateChatHistoryTokens` | ~4 chars/token estimates |
| `getProtectedTailStartIndex(messages)` | index of the second-to-last user turn (never trimmed) |
| `trimChatMessagesForContextWindow({chatMessages, systemMessage, aiInstructions, contextWindow, forceAggressiveTrim?})` | drop oldest assistant/tool messages until under `contextWindow × 0.85` (0.70 / 0.55 aggressive) |
| `sanitizeToolMessagePairing(messages)` | drop tool messages with no preceding assistant in the turn |
| `getAgentEffectiveContextWindow({chatMode, providerName, contextWindow})` | min(contextWindow, per-provider agent cap) |
| `CONTEXT_WINDOW_USE_RATIO`, `AGGRESSIVE_CONTEXT_WINDOW_USE_RATIO`, `TPM_CAP_CONTEXT_WINDOW_USE_RATIO` | ratios |
| `computeEffectiveOutputReserve(reserved)` | reserved output + 2k safety margin |
| `elideOldestToolResultsFirst(wireMessages, charBudget)` | in-place wire-level elision (keeps system, last 2 user turns, last 3 tools) |
| `CHARS_PER_TOKEN`, `OUTPUT_RESERVE_SAFETY_MARGIN`, `AGGRESSIVE_WIRE_TRIM_RATIO`, `TOOL_OUTPUT_OMISSION` | constants |
| **`prepareMessagesForModel(opts)`** | **new** composition: compact → trim → sanitize; returns `{ messages, estimatedTokens, trimmed, compacted }` |

### compaction & dedup — `toolResultCompaction.ts`, `fileReadDedup.ts`, `parallelReadToolBatch.ts`
| export | purpose |
|---|---|
| `compactStaleToolResults(messages, onCompactedFileRead?)` | replace stale `compactable` tool bodies with one-line refs; keeps last `RECENT_FULL_TOOL_RESULTS` (2) and the latest read of each file |
| `isCompactableToolName`, `COMPACTABLE_TOOL_NAMES` | which tools compact |
| `readFileUriKey(uri)` | normalised map key (file:// URI string, lower-cased on Windows) |
| `trackFileRead(map, uri, start, end, totalLen?, turn?)`, `recordFileReadSize`, `invalidateFileRead` | maintain `Map<string, FileReadRecord>` |
| `shouldSkipDuplicateFileRead(map, uri, start, end)` | `{ skip, message? }` when the requested range is already covered |
| `extractReadFileUriFromRawParams`, `formatReadFileRange`, `buildRepeatFileReadHint` | helpers |
| `isReadOnlyBatchTool(name)`, `READ_ONLY_BATCH_TOOL_NAMES`, `toolCallDedupKey(name, rawParams)` | read-only tool classification + dedup key |
| `parseDiscoveryToolLines(text)`, `buildReadToolBatch(primary, additional)` | pure parsing / batching |
| `discoverAdditionalReadTools({ callLLM, primaryToolCall, recentMessages, excludeKeys, ... })` | side-call (via `LLMCallPort`) for up to `MAX_ADDITIONAL_READ_TOOLS` (4) extra reads; **rejects** on LLM failure |
| `DISCOVERY_OUTPUT_TOKEN_CAP` (200), `withDiscoveryTokenCap` | output cap for the discovery call |

### rate limiting — `llmRateLimit.ts`
| export | purpose |
|---|---|
| `AGENT_INPUT_TOKEN_CAPS`, `getAgentInputTokenCap(provider)` | per-provider agent input caps (anthropic: 22k) |
| `recordProviderRateLimitHit`, `getProviderRateLimitCooldownMs`, `clearProviderRateLimitCooldown`, `parseRateLimitCooldownUntilMs`, `formatRateLimitCooldownMessage` | module-level cooldown registry keyed by provider[:model] |
| `isRateLimitLLMError`, `isContextOverflowLLMError`, `isStreamStallLLMError`, `isFatalLLMError` | classify `{ message, fullError }` |
| `getMaxLLMRetryAttempts(err)`, `getLLMRetryDelayMs(err, attempt, defaultMs)`, `shouldForceAggressiveTrimOnRetry(err)` | retry policy |

### usage & pricing — `llmMessageUsage.ts`, `llmPricing.ts`, `usageMeteringTypes.ts`, `agentOutputTokenLimits.ts`, `modelCapabilities.ts`
| export | purpose |
|---|---|
| `LLMMessageUsage`, `AgentRunTokenTotals`, `emptyAgentRunTokenTotals`, `addUsageToRunTotals`, `formatAgentRunTokenSummary` | normalised usage + run totals |
| `usageFromAnthropicResponse`, `usageFromOpenAIResponse`, `usageFromGeminiMetadata` | provider → normalised usage |
| `getModelPricing`, `calculateTurnCostUSD`, `hasKnownPricing`, `PRICING_TABLE_DATE`, `ModelPricing` | USD pricing table |
| `TurnCostRecord`, `ProviderTotals`, `MeteringSession` | metering record types |
| `getEffectiveMaxOutputTokens`, `getAnthropicBetaHeaders`, `isLikelyOutputTruncated`, `AGENT_ANTHROPIC_OUTPUT_TOKENS`, `ANTHROPIC_EXTENDED_OUTPUT_BETA` | output-token limits |
| `getModelCapabilities(provider, model, overrides)`, `getReservedOutputTokenSpace`, `getSendableReasoningInfo`, `getIsReasoningEnabledState`, `modelSupportsVision`, `getProviderCapabilities`, `defaultProviderSettings`, `defaultModelsOfProvider`, `modelOverrideKeys`, `ollamaRecommendedModels`, `VoidStaticModelInfo`, `ModelOverrides`, `SendableReasoningInfo` | the full 1.7k-line model/provider capability table (kept whole) |

### agent loop discipline — hints / limits / plan
| module | exports |
|---|---|
| `agentReadHints.ts` | `createReadOnlyCallCounts`, `trackReadOnlyCall`, `buildRepeatReadHint`, `buildExplorationBudgetHint`, `buildCrossQueryFileReadHint`, `buildAgentTailHints`, `REPEAT_READ_THRESHOLD`, `ReadOnlyCallCounts` |
| `agentEditHints.ts` | `trackFileEdit`, `buildRepeatEditHint`, `buildLargeFileEditHint`, `REPEAT_EDIT_THRESHOLD`, `LARGE_FILE_EDIT_THRESHOLD_CHARS` |
| `agentVerificationHints.ts` | `createSandboxVerificationTracker`, `markSandboxCodeChange`, `markSandboxVerified`, `needsSandboxVerification`, `buildSandboxVerificationHint`, `isSandboxVerificationCommand`, `isLocalhostCurlCommand`, `MAX_SANDBOX_VERIFICATION_NUDGES` |
| `agentEditCompletionHints.ts` | `createEditCompletionTracker`, `markInterruptedEditTool`, `markTruncatedEditTool`, `isMissingEditContentError`, `detectEditIntentFromText`, `isEditToolName`, `needsEditCompletion`, `buildEditCompletionHint`, `MAX_EDIT_COMPLETION_NUDGES` |
| `agentLoopLimits.ts` | `DEFAULT_MAX_AGENT_ITERATIONS` (25), `DEFAULT_MAX_READONLY_CALLS` (12), `DEFAULT_MAX_CONSECUTIVE_TOOL_FAILS` (3), `DEFAULT_LLM_STREAM_STALL_TIMEOUT_MS`, `EDIT_/REASONING_/TOOL_LLM_STREAM_STALL_TIMEOUT_MS`, `getLlmStreamStallTimeoutMs` |
| `agentLoopSettings.ts` | `getAgentLoopLimits(settings)`, `agentLoopLimitDefaults`, `AgentLoopLimits` |
| `lightAgent.ts` | `isLightAgentEnabled`, `shouldGenerateAgentPlan`, `shouldUseParallelReadBatching`, `getEffectiveRepoProfileMode`, `getEffectiveMaxReadOnlyCalls`, `LIGHT_AGENT_MAX_DIRSTR_CHARS` |
| `agentPlan.ts` | `generateAgentPlan({ callLLM, usageMeter?, modelSelection, chatMode, chatMessages, threadId, ... })`, `resolveAgentPlanForRun(...)`, `parsePlanBulletItems`, `markPlanItemDoneForTool`, `completeRemainingPlanItems`, `skipRemainingPlanItems`, `reactivateAbortedPlan`, `planHasPendingItems`, `planHasSkippedItems`, `getLatestPlanMessage`, `findLatestPlanMessageIdx`, `buildPlanSessionContext`, `summarizeUserTask`, `isContinuationUserMessage`, `isLikelyNewTaskUserMessage`, `getToolSummaryForPlanMatch`, `PLAN_OUTPUT_TOKEN_CAP` (300), `PLAN_MIN_BULLETS`, `PLAN_MAX_BULLETS`, `PLAN_GENERATION_TIMEOUT_MS`, `AgentPlanRunResolution` |
| `anthropicConversationWire.ts` | `ensureAnthropicConversationEndsWithUser`, `appendAgentTailHintsToMessages`, `EMPTY_ANTHROPIC_CONTINUATION` |
| `terminalHeuristics.ts` | `isLongRunningTerminalCommand`, `isDevServerCommand`, `isPackageInstallCommand`, `packageInstallLooksSuccessful`, `terminalCommandLooksSuccessful`, `isHeredocTerminalCommand`, `getTerminalInactiveTimeoutSeconds`, `buildVerificationReminder`, patterns + timeouts (lifted from `prompt/prompts.ts`) |

### types — `types.ts`
`ProviderName`, `ModelSelection`, `ModelSelectionOptions`, `OverridesOfModel`, `ModelOverrides`, `FeatureName`,
`ChatMode`, `GlobalSettings` (+ `defaultGlobalSettings`), `ChatMessage` = `UserMessage | AssistantMessage | ToolMessage<ToolName> | DecorativeCanceledTool | CheckpointEntry | PlanMessage`,
`PlanMessage`, `PlanItemStatus`, `StagingSelectionItem`, `ToolName`, `BuiltinToolName`, `builtinToolNames`, `isABuiltinToolName`,
`BuiltinToolCallParams`, `BuiltinToolResultType`, `ToolCallParams<T>`, `ToolResult<T>`, `RawToolParamsObj`, `RawToolCallObj`, `InternalToolInfo`,
`TerminalResolveReason`, `LintErrorItem`, `ShallowDirectoryItem`, `EditApplyResult`, `AnthropicLLMChatMessage`, `OpenAILLMChatMessage`, `LLMChatMessage`,
`AnthropicReasoning`, `LLMErrorLike`, `LLMMessageUsage`, `WorkspaceProfile`, `CommandEntry`, `FrameworkEntry`, `FileReadRecord`.
Plus from `shim/vsBase.ts`: `URI` (re-export of `vscode-uri`), `generateUuid`, `isWindows`, `removeAnsiEscapeCodes`.

### ports — `ports.ts`
```ts
interface LLMCallPort {
  (req: { messages: ChatMessage[]; systemMessage: string; maxOutputTokens?: number; tools?: InternalToolInfo[];
          signal?: AbortSignal; modelSelection?; modelSelectionOptions?; overridesOfModel?; chatMode?; purpose? })
    : Promise<{ text: string; usage?: LLMMessageUsage; toolCalls?: RawToolCallObj[] }>;
}
interface UsageMeterPort {
  record(usage: LLMMessageUsage, meta: { provider: ProviderName; model: string; purpose: string; threadId?: string }): void;
}
const noopUsageMeter: UsageMeterPort;
```
These replace the fork's `ILLMMessageService` / `IConvertToLLMMessageService` / `IUsageMeteringService`
in `generateAgentPlan`, `resolveAgentPlanForRun` and `discoverAdditionalReadTools`.

## What was dropped / changed vs the fork
- STaaS org-extension tools (`query_service_topology`, `resolve_api_contract`, `get_maven_impact`, `get_npm_impact`, `get_config_drift`, `verify_security_compliance`) and `StaasWorkspaceProfileFields` — `ToolName` keeps the `string & {}` escape hatch so they still type-check as opaque names; `WorkspaceProfile` has an index signature for extra fields.
- MCP types — `ToolResult<non-builtin>` is `unknown` instead of `RawMCPToolCall`; `mcpServerName` is optional on tool messages.
- `GlobalSettings` is reduced to the 9 fields these modules read.
- `CheckpointEntry.voidFileSnapshotOfURI` uses an opaque `FileSnapshot` type.
- `generateAgentPlan` / `discoverAdditionalReadTools` take `callLLM: LLMCallPort` (and `usageMeter?: UsageMeterPort`) instead of DI services; plan-generation timer is cleared on completion and `timeoutMs` is overridable.
- `settings-UI` helpers (`displayInfoOfProviderName`, `defaultSettingsOfProvider`, …) were not lifted.
