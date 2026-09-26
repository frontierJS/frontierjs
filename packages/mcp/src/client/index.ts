/*
 * @frontierjs/mcp/client — the terminal client's half, held here until the CLI
 * package is named (`IDEAS/app-cli.md`). Nothing in it imports the server.
 */

export { commandFor, parseArgs, ArgvError } from './argv.ts'
export type { Command, Flag, FlagType, Payload, ParseOptions, Slot, ToolListing } from './argv.ts'
export { run, EXIT } from './run.ts'
export type { RunOptions, Session, CallOptions, CallAnswer, AwaitedJob, Breadcrumb } from './run.ts'
export { configPath, fileStore, maskToken } from './profiles.ts'
export type { Profile, ProfileFile, ProfileStore } from './profiles.ts'
export { cacheKey, cacheDir, fileCache } from './cache.ts'
export type { CachedTools, ToolCache } from './cache.ts'
export { defineCommand, loadRoutes, checkRoutes, routeOffered, CallRefused } from './routes.ts'
export type { Route, RouteDefinition, RouteContext } from './routes.ts'
export { main } from './main.ts'
export type { CliConfig } from './main.ts'
