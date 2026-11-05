/** Project rules now live in riaf-core (so the CLI, MCP server and daemon see the same rules); re-exported for existing imports. */
export { findRuleFiles, loadProjectRules, RULES_MAX_CHARS, type ProjectRules } from '@bosch-mps/riaf-core';
