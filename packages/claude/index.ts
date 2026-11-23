// index.ts — @frontierjs/claude: how to call the local `claude` program, and read it back.
//
// The transport only: the argv, the stdin, the stream-json read, and a live
// chat's control protocol and process. What to SAY
// stays with each product (`cli/core/{plan,edit,ask}-prompt.js`, the
// workbench's reviewer), which may import from here; this package imports
// from none of them, and from nothing in `@frontierjs/cli`.

export {
  ASK_BASH, ASK_BUDGET_USD, ASK_EFFORT, ASK_TOOLS, DRAW_BUDGET_USD, EDIT_TOOLS, EFFORTS,
  IMAGE_TYPES, MAX_IMAGE, MAX_IMAGES, WORK_BUDGET_USD,
} from './src/limits.ts'
export { askArgv, resumeCommand, SESSION_ID, sessionArgv } from './src/argv.ts'
export { askInput, readImages }                            from './src/images.ts'
export { agentCall, agentEventOf, readAskEvent }           from './src/events.ts'
export { runAsk }                                          from './src/run.ts'
export { ControlError, LineReader, Protocol }              from './src/protocol.ts'
export { askCard, askSummary, BadAnswer, decide, denial }  from './src/permission.ts'
export {
  commandsOf, FALLBACK_MODELS, initOf, mergeCommands, MODES, modelsOf, newestPerFamily, PICKED_MODES, usageOf,
} from './src/catalog.ts'
export { Session }                                         from './src/session.ts'

export type { Effort }                                                         from './src/limits.ts'
export type { Agent, AskArgvOptions, AskProfile, Draw, SessionArgvOptions, Work } from './src/argv.ts'
export type { Image }                                                          from './src/images.ts'
export type { ApiEvent, AskEvent, ContentPart, StreamLine, ToolInput }         from './src/events.ts'
export type { AskRun, RunAskOptions }                                          from './src/run.ts'
export type { Ask, Decision, Frame, Incoming }                                 from './src/protocol.ts'
export type { Card, Extra }                                                    from './src/permission.ts'
export type { Command, Init, ModelChoice, Usage }                              from './src/catalog.ts'
export type { SessionEvent, SessionOptions }                                   from './src/session.ts'
