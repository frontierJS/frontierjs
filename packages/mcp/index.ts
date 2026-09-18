// @frontierjs/mcp — an MCP surface for a FrontierJS app, derived from the seed.
//
// Two halves. `mcpPlugin()` mounts the endpoint inside the API that is already
// running; `projectTools()` is what it serves — the tool list one standing may
// see, and what graded each answer.

export { mcpPlugin }      from './src/plugin.ts'
export type { McpOptions } from './src/plugin.ts'

export { projectTools, resolveModel, schemaViews, toolName } from './src/projection.ts'
export type {
  Projection, Tool, Withheld, Verdict,
  ToolInput, InputSource, SchemaViews,
  ServiceShape, ModelDef, ModelGate, DeclaredMove,
} from './src/projection.ts'
