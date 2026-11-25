// index.ts — @frontierjs/claude: how to call the local `claude` program, and read it back.
//
// The transport (the argv, the stdin, the stream-json read, and a live chat's
// control protocol and process) and the one reader of Claude Code's own files:
// a transcript as messages or as turns, the session list, the configuration
// scan (settings, hooks, MCP servers, plugins, skills), the login's quota, and
// the subcommands that answer about the program itself. What to SAY
// stays with each product (`cli/core/{plan,edit,ask}-prompt.js`, the
// workbench's reviewer), which may import from here; this package imports
// from none of them, and from nothing in `@frontierjs/cli`.

export {
  ASK_BASH, ASK_BUDGET_USD, ASK_EFFORT, ASK_TOOLS, DRAW_BUDGET_USD, EDIT_TOOLS, EFFORTS,
  IMAGE_TYPES, MAX_IMAGE, MAX_IMAGES, WORK_BUDGET_USD,
} from './src/limits.ts'
export { askArgv, mcpConfigOf, resumeCommand, SESSION_ID, sessionArgv } from './src/argv.ts'
export { claudeDoor }                                      from './src/door.ts'
export { askInput, readImages }                            from './src/images.ts'
export { agentCall, agentEventOf, readAskEvent }           from './src/events.ts'
export { runAsk }                                          from './src/run.ts'
export { ControlError, LineReader, Protocol }              from './src/protocol.ts'
export { askCard, askSummary, BadAnswer, decide, denial }  from './src/permission.ts'
export {
  commandsOf, FALLBACK_MODELS, initOf, mergeCommands, MODES, modelsOf, usageOf,
} from './src/catalog.ts'
export { Session }                                         from './src/session.ts'
export { claudeConfigDir, read, readJsonObject, unreadable } from './src/read.ts'
export { foldTranscript, MAX_BYTES, readTranscript, SUMMARY_CAP, TEXT_CAP } from './src/transcript.ts'
export { readMessages }                                    from './src/messages.ts'
export { readToolCalls }                                   from './src/calls.ts'
export { encodeCwd, findSession, listSessions, peekSession, titleOf } from './src/sessions.ts'
export { commandTools }                                    from './src/hooks.ts'
export { LISTING_LIMIT }                                   from './src/items.ts'
export { expandMcpVars }                                   from './src/mcp.ts'
export { allHooks, allItems, claudeJsonPath, configRev, readListedFile, scanClaude } from './src/scan.ts'
export { fetchUsage }                                      from './src/quota.ts'
export { contextFor, countContext }                        from './src/context.ts'
export { claudeAuthStatus, readDoctor, readMcpList, runClaude } from './src/subcommands.ts'

export type { Effort }                                                         from './src/limits.ts'
export type { Agent, Answer, AskArgvOptions, AskProfile, Draw, SessionArgvOptions, Work } from './src/argv.ts'
export type { Image }                                                          from './src/images.ts'
export type { ApiEvent, AskEvent, ContentPart, StreamLine, ToolInput }         from './src/events.ts'
export type { ClaudeDoorOptions, ClaudeReply, Run }                            from './src/door.ts'
export type { AskRun, RunAskOptions }                                          from './src/run.ts'
export type { Ask, Decision, Frame, Incoming }                                 from './src/protocol.ts'
export type { Card, Extra }                                                    from './src/permission.ts'
export type { Command, Init, ModelChoice, Usage }                              from './src/catalog.ts'
export type { SessionEvent, SessionOptions }                                   from './src/session.ts'
export type { Read }                                                            from './src/read.ts'
export type { Folded, Text, ToolCall, Turn }                                   from './src/transcript.ts'
export type { ReadMessagesOptions, TranscriptFile, TranscriptMessage }         from './src/messages.ts'
export type { ToolCalls, ToolUse }                                             from './src/calls.ts'
export type { FoundSession, ListSessionsOptions, Peek, SessionRow }            from './src/sessions.ts'
export type { HookEntry, HookHandler }                                         from './src/hooks.ts'
export type { Item, ItemKind }                                                 from './src/items.ts'
export type { ClaudeJsonMcp, McpProjectChoice, McpScope, McpServer, McpTransport, McpWhere } from './src/mcp.ts'
export type {
  Author, InstalledPlugin, InstalledPlugins, Marketplace, MarketplaceManifest, Marketplaces,
  MarketplaceSource, OfferedPlugin, PluginManifest, PluginSource,
} from './src/plugins.ts'
export type { PermissionMode, Permissions, Settings }                          from './src/settings.ts'
export type {
  ClaudeConfig, ListedFile, Loaded, MemoryFile, MemoryKind, Origin, ProjectScan, ScanIssue,
  ScannedHooks, ScannedItem, ScannedMarketplace, ScannedPlugin, ScanOptions,
} from './src/scan.ts'
export type { FetchUsageOptions, Meter, ModelMeter, Quota, QuotaRead }        from './src/quota.ts'
export type { Context, ContextFor, ContextPart, Measured }                      from './src/context.ts'
export type { AuthStatus, ClaudeRun, Doctor, DoctorFinding, McpHealth, McpHealthState, Program } from './src/subcommands.ts'
