/*--------------------------------------------------------------------------------------
 *  Self-contained, minimal copy of the Trove types the token-optimisation modules need.
 *
 *  Extracted from (in the VS Code fork, src/vs/workbench/contrib/trove/common/):
 *    troveSettingsTypes.ts, chatThreadServiceTypes.ts, toolsServiceTypes.ts,
 *    sendLLMMessageTypes.ts, prompt/prompts.ts (builtin tool names only),
 *    repoIntelligenceTypes.ts (WorkspaceProfile only), editCodeServiceTypes.ts (EditApplyResult).
 *
 *  Deliberately dropped: STaaS-specific tools, MCP types, VS Code service interfaces,
 *  settings-UI helpers.  Where a union was open-ended in the fork, the `string & {}`
 *  escape hatch is preserved so unknown / MCP / org-extension tool names still type-check.
 *--------------------------------------------------------------------------------------*/

import type { URI } from './shim/vsBase.js';
import type { defaultProviderSettings, ModelOverrides } from './modelCapabilities.js';
import type { LLMMessageUsage } from './llmMessageUsage.js';

export type { ModelOverrides } from './modelCapabilities.js';
export type { LLMMessageUsage } from './llmMessageUsage.js';

// ───────────────────────────────────────────────────────────────────────────────
// Providers / models / features (troveSettingsTypes.ts)
// ───────────────────────────────────────────────────────────────────────────────

export type ProviderName = keyof typeof defaultProviderSettings;

export type ModelSelection = { providerName: ProviderName; modelName: string };

export const featureNames = ['Chat', 'Ctrl+K', 'Autocomplete', 'Apply', 'SCM'] as const;
export type FeatureName = (typeof featureNames)[number];

export type ChatMode = 'agent' | 'gather' | 'normal';

export type ModelSelectionOptions = {
	reasoningEnabled?: boolean;
	reasoningBudget?: number;
	reasoningEffort?: string;
};

export type OverridesOfModel = {
	[providerName in ProviderName]: {
		[modelName: string]: Partial<ModelOverrides> | undefined;
	};
};

/**
 * Only the GlobalSettings fields the lifted modules read
 * (lightAgent.ts, agentLoopSettings.ts, agentReadHints.ts).
 */
export type GlobalSettings = {
	chatMode: ChatMode;
	enableAgentPlan: boolean;
	enableLightAgent: boolean;
	enablePromptCache: boolean;
	enableParallelReadBatching: boolean;
	maxAgentIterations: number;
	maxReadOnlyCalls: number;
	maxConsecutiveToolFails: number;
	llmStreamStallTimeoutMs: number;
};

export const defaultGlobalSettings: GlobalSettings = {
	chatMode: 'agent',
	enableAgentPlan: true,
	enableLightAgent: false,
	enablePromptCache: true,
	enableParallelReadBatching: false,
	maxAgentIterations: 25,
	maxReadOnlyCalls: 12,
	maxConsecutiveToolFails: 3,
	llmStreamStallTimeoutMs: 120_000,
};

// ───────────────────────────────────────────────────────────────────────────────
// Tools (toolsServiceTypes.ts + prompt/prompts.ts)
// ───────────────────────────────────────────────────────────────────────────────

export type TerminalResolveReason =
	| { type: 'timeout'; inactiveTimeoutSeconds: number; reason: 'inactivity' | 'absolute' | 'snapshot' }
	| { type: 'done'; exitCode: number }
	| { type: 'server_ready' };

export type LintErrorItem = { code: string; message: string; startLineNumber: number; endLineNumber: number };

/** Partial of VS Code's IFileStat. */
export type ShallowDirectoryItem = {
	uri: URI;
	name: string;
	isDirectory: boolean;
	isSymbolicLink: boolean;
};

/** Result of edit_file / rewrite_file (editCodeServiceTypes.ts). */
export type EditApplyResult = {
	applied: boolean;
	blocksMatched: number;
	blocksTotal: number;
	savedToDisk: boolean;
	failureReason?:
		| 'model-unavailable'
		| 'diffzone-unavailable'
		| 'no-blocks-parsed'
		| 'block-not-found'
		| 'blocks-overlap'
		| 'content-identical';
	failureDetail?: string;
};

/** Validated (typed) params of every core builtin tool. */
export type BuiltinToolCallParams = {
	'read_file': { uri: URI; startLine: number | null; endLine: number | null; pageNumber: number };
	'ls_dir': { uri: URI; pageNumber: number };
	'get_dir_tree': { uri: URI };
	'search_pathnames_only': { query: string; includePattern: string | null; pageNumber: number };
	'search_for_files': { query: string; isRegex: boolean; searchInFolder: URI | null; pageNumber: number };
	'search_codebase': { query: string; maxResults: number };
	'get_file_outline': { uri: URI };
	'get_symbol': { uri: URI; symbolName: string };
	'search_symbols': { query: string; maxResults: number };
	'search_web': { query: string; maxResults: number };
	'get_import_graph': { uri: URI; direction?: 'imports' | 'importedBy' | 'both' };
	'get_tests_for_file': { uri: URI };
	'get_recently_changed': { limit?: number };
	'search_in_file': { uri: URI; query: string; isRegex: boolean };
	'read_lint_errors': { uri: URI };
	// ---
	'rewrite_file': { uri: URI; newContent: string };
	'edit_file': { uri: URI; searchReplaceBlocks: string };
	'create_file_or_folder': { uri: URI; isFolder: boolean };
	'delete_file_or_folder': { uri: URI; isRecursive: boolean; isFolder: boolean };
	// ---
	'run_command': { command: string; cwd: string | null; terminalId: string };
	'run_tests': { testCommand: string | null; filePattern: string | null; terminalId: string };
	'open_persistent_terminal': { cwd: string | null };
	'run_persistent_command': { command: string; persistentTerminalId: string };
	'kill_persistent_terminal': { persistentTerminalId: string };
};

/** Result of every core builtin tool. */
export type BuiltinToolResultType = {
	'read_file': { fileContents: string; totalFileLen: number; totalNumLines: number; hasNextPage: boolean; emptyReason?: 'empty-file' | 'page-out-of-range' | 'empty-range'; totalPages: number };
	'ls_dir': { children: ShallowDirectoryItem[] | null; hasNextPage: boolean; hasPrevPage: boolean; itemsRemaining: number };
	'get_dir_tree': { str: string };
	'search_pathnames_only': { uris: URI[]; hasNextPage: boolean };
	'search_for_files': { uris: URI[]; hasNextPage: boolean };
	'search_codebase': { results: { filePath: string; startLine: number; endLine: number; snippet: string }[]; query: string };
	'get_file_outline': { outline: string };
	'get_symbol': { source?: string; startLine?: number; endLine?: number; error?: string };
	'search_symbols': { results: string };
	'search_web': { results: { title: string; url: string; snippet: string }[]; query: string };
	'get_import_graph': { imports: string[]; importedBy: string[]; externalDeps: string[] };
	'get_tests_for_file': { tests: { testFile: string; confidence: 'high' | 'medium' }[] };
	'get_recently_changed': { files: { file: string; changeCount: number; lastChanged: string }[] };
	'search_in_file': { lines: number[] };
	'read_lint_errors': { lintErrors: LintErrorItem[] | null };
	// ---
	'rewrite_file': Promise<{ lintErrors: LintErrorItem[] | null; edit: EditApplyResult; lintSettled?: boolean }>;
	'edit_file': Promise<{ lintErrors: LintErrorItem[] | null; edit: EditApplyResult; lintSettled?: boolean }>;
	'create_file_or_folder': { created: boolean; alreadyExisted: boolean };
	'delete_file_or_folder': {};
	// ---
	'run_command': { result: string; resolveReason: TerminalResolveReason; autoPersistentTerminalId?: string };
	'run_tests': {
		framework: string;
		passed: number;
		failed: number;
		skipped: number;
		failures: { test: string; file?: string; line?: number; message: string }[];
		exitCode: number;
		rawTail: string;
		command: string;
	};
	'run_persistent_command': { result: string; resolveReason: TerminalResolveReason };
	'open_persistent_terminal': { persistentTerminalId: string };
	'kill_persistent_terminal': {};
};

export type BuiltinToolName = keyof BuiltinToolResultType;

/** Any tool name: a core builtin, or an opaque string (MCP / org-extension tools). */
export type ToolName = BuiltinToolName | (string & {});

export const builtinToolNames: readonly BuiltinToolName[] = [
	'read_file',
	'ls_dir',
	'get_dir_tree',
	'search_pathnames_only',
	'search_for_files',
	'search_codebase',
	'get_file_outline',
	'get_symbol',
	'search_symbols',
	'search_web',
	'get_import_graph',
	'get_tests_for_file',
	'get_recently_changed',
	'search_in_file',
	'read_lint_errors',
	'rewrite_file',
	'edit_file',
	'create_file_or_folder',
	'delete_file_or_folder',
	'run_command',
	'run_tests',
	'open_persistent_terminal',
	'run_persistent_command',
	'kill_persistent_terminal',
];

const builtinToolNameSet = new Set<string>(builtinToolNames);

export const isABuiltinToolName = (toolName: string): toolName is BuiltinToolName =>
	builtinToolNameSet.has(toolName);

/** Validated params for a tool: typed for builtins, raw string map otherwise. */
export type ToolCallParams<T extends ToolName> = T extends BuiltinToolName ? BuiltinToolCallParams[T] : RawToolParamsObj;

/** Result for a tool: typed for builtins, opaque otherwise (MCP result types dropped). */
export type ToolResult<T extends ToolName> = T extends BuiltinToolName ? BuiltinToolResultType[T] : unknown;

/** Snake-cased param names as the model emits them (e.g. `start_line`), plus camelCase for leniency. */
export type ToolParamName = string;

/** Raw (unvalidated) params as parsed from the model's tool call — all strings. */
export type RawToolParamsObj = {
	[paramName: string]: string | undefined;
};

export type RawToolCallObj = {
	name: ToolName;
	rawParams: RawToolParamsObj;
	doneParams: ToolParamName[];
	id: string;
	isDone: boolean;
};

/** Tool definition handed to the LLM (prompt/prompts.ts). */
export type InternalToolInfo = {
	name: string;
	description: string;
	params: {
		[paramName: string]: { description: string };
	};
	/** Only if the tool is from an MCP server. */
	mcpServerName?: string;
};

// ───────────────────────────────────────────────────────────────────────────────
// Chat thread messages (chatThreadServiceTypes.ts)
// ───────────────────────────────────────────────────────────────────────────────

export type ToolMessage<T extends ToolName> = {
	role: 'tool';
	/** Content given to the LLM on future calls (string of the result). */
	content: string;
	id: string;
	rawParams: RawToolParamsObj;
	/** Server name at the time of the call, if the tool came from an MCP server. */
	mcpServerName?: string | undefined;
	/** Full content kept for UI; wire payload may be compacted when stale. */
	compactable?: boolean;
} & (
	// in order of events:
	| { type: 'invalid_params'; result: null; name: T }
	| { type: 'tool_request'; result: null; name: T; params: ToolCallParams<T> } // params validated, awaiting user
	| { type: 'running_now'; result: null; name: T; params: ToolCallParams<T> }
	| { type: 'tool_error'; result: string; name: T; params: ToolCallParams<T> } // error while tool was running
	| { type: 'success'; result: Awaited<ToolResult<T>>; name: T; params: ToolCallParams<T> }
	| { type: 'rejected'; result: null; name: T; params: ToolCallParams<T> } // user rejected
);

export type DecorativeCanceledTool = {
	role: 'interrupted_streaming_tool';
	name: ToolName;
	mcpServerName?: string | undefined;
};

/** Opaque file snapshot (VoidFileSnapshot in the fork) — never read by this library. */
export type FileSnapshot = { entireFileCode: string; [k: string]: unknown };

export type CheckpointEntry = {
	role: 'checkpoint';
	type: 'user_edit' | 'tool_edit';
	voidFileSnapshotOfURI: { [fsPath: string]: FileSnapshot | undefined };
	userModifications: {
		voidFileSnapshotOfURI: { [fsPath: string]: FileSnapshot | undefined };
	};
};

export type PlanItemStatus = 'pending' | 'done' | 'skipped';

export type PlanMessage = {
	role: 'plan';
	items: { text: string; status: PlanItemStatus }[];
};

export type UserMessage = {
	role: 'user';
	/** Content shown to the LLM on future calls — may be '' (replaced with "(empty)"). */
	content: string;
	/** Content shown to the user — may be ''. */
	displayContent: string;
	selections: StagingSelectionItem[] | null;
	state: {
		stagingSelections: StagingSelectionItem[];
		isBeingEdited: boolean;
	};
};

export type AssistantMessage = {
	role: 'assistant';
	/** Content received from the LLM — may be ''. */
	displayContent: string;
	/** Step-by-step reasoning from the LLM. */
	reasoning: string;
	anthropicReasoning: AnthropicReasoning[] | null;
};

export type ChatMessage =
	| UserMessage
	| AssistantMessage
	| ToolMessage<ToolName>
	| DecorativeCanceledTool
	| CheckpointEntry
	| PlanMessage;

/** One of the square items that indicates a selection in a chat bubble. */
export type StagingSelectionItem = {
	type: 'File';
	uri: URI;
	language: string;
	state: { wasAddedAsCurrentFile: boolean };
} | {
	type: 'CodeSelection';
	range: [number, number];
	uri: URI;
	language: string;
	state: { wasAddedAsCurrentFile: boolean };
} | {
	type: 'Folder';
	uri: URI;
	language?: undefined;
	state?: undefined;
} | {
	type: 'Notepad';
	notepadId: string;
	title: string;
	content: string;
	language?: undefined;
	uri?: undefined;
	state?: undefined;
} | {
	type: 'CodebaseSearch';
	query: string;
	content: string;
	language?: undefined;
	uri?: undefined;
	state?: undefined;
} | {
	type: 'SymbolSearch';
	symbolName: string;
	content: string;
	language?: undefined;
	uri?: undefined;
	state?: undefined;
} | {
	type: 'TerminalOutput';
	content: string;
	language?: undefined;
	uri?: undefined;
	state?: undefined;
} | {
	type: 'GitContext';
	content: string;
	language?: undefined;
	uri?: undefined;
	state?: undefined;
} | {
	type: 'PackageDocs';
	packageName: string;
	content: string;
	language?: undefined;
	uri?: undefined;
	state?: undefined;
} | {
	type: 'Image';
	dataUrl: string;
	mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
	fileName?: string;
	language?: undefined;
	uri?: undefined;
	state?: undefined;
} | {
	type: 'Pdf';
	fileName: string;
	extractedText: string;
	pageCount?: number;
	language?: undefined;
	uri?: undefined;
	state?: undefined;
};

// ───────────────────────────────────────────────────────────────────────────────
// Wire-format messages (sendLLMMessageTypes.ts)
// ───────────────────────────────────────────────────────────────────────────────

export type AnthropicReasoning =
	| { type: 'thinking'; thinking: any; signature: string }
	| { type: 'redacted_thinking'; data: any };

export type AnthropicLLMChatMessage = {
	role: 'assistant';
	content: string | (AnthropicReasoning | { type: 'text'; text: string }
		| { type: 'tool_use'; name: string; input: Record<string, any>; id: string }
	)[];
} | {
	role: 'user';
	content: string | (
		{ type: 'text'; text: string } | { type: 'tool_result'; tool_use_id: string; content: string }
		| { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string } }
	)[];
};

export type OpenAILLMChatMessage = {
	role: 'system' | 'user' | 'developer';
	content: string | (
		{ type: 'text'; text: string }
		| { type: 'image_url'; image_url: { url: string; detail?: string } }
	)[];
} | {
	role: 'assistant';
	content: string | (AnthropicReasoning | { type: 'text'; text: string })[];
	tool_calls?: { type: 'function'; id: string; function: { name: string; arguments: string } }[];
} | {
	role: 'tool';
	content: string;
	tool_call_id: string;
};

export type LLMChatMessage = AnthropicLLMChatMessage | OpenAILLMChatMessage;

/** Shape of an LLM error as surfaced by the fork's sendLLMMessage onError callback. */
export type LLMErrorLike = { message: string; fullError: Error | null };

// ───────────────────────────────────────────────────────────────────────────────
// Repo intelligence (repoIntelligenceTypes.ts — WorkspaceProfile only)
// ───────────────────────────────────────────────────────────────────────────────

export type CommandPurpose = 'build' | 'test' | 'lint' | 'typecheck' | 'start' | 'format';

export type CommandEntry = {
	command: string;
	purpose: CommandPurpose;
	confidence: 'high' | 'medium' | 'low';
	source: string;
};

export type FrameworkEntry = {
	name: string;
	version: string | null;
	confidence: 'high' | 'medium' | 'low';
};

/**
 * Workspace profile produced by repo intelligence. Only `buildCommands` and
 * `testCommands` are read by this library (agentVerificationHints); the rest is
 * carried for shape fidelity. STaaS-specific fields are dropped.
 */
export type WorkspaceProfile = {
	workspaceRoot: string;
	lastScannedAt: number;
	languageStack: string[];
	frameworks: FrameworkEntry[];
	packageManagers: string[];
	buildCommands: CommandEntry[];
	testCommands: CommandEntry[];
	lintCommands: CommandEntry[];
	typecheckCommands: CommandEntry[];
	projectPurpose: string | null;
	architectureSummary: string | null;
	fileCount: number;
	totalLoc: number;
	isStale: boolean;
	[extra: string]: unknown;
};

// ───────────────────────────────────────────────────────────────────────────────
// Re-exported from sibling modules for convenience
// ───────────────────────────────────────────────────────────────────────────────

export type { FileReadRecord } from './fileReadDedup.js';

/** Usage attached to one LLM turn, with the model that produced it. */
export type TurnUsage = { usage: LLMMessageUsage; providerName: ProviderName; modelName: string };
