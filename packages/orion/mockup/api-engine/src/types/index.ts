// ─────────────────────────────────────────────
// EXPRESSION — universal value type
// ─────────────────────────────────────────────

export type Expression =
  | { type: "literal";  value: unknown }
  | { type: "ref";      path: string }
  | { type: "template"; parts: Expression[] }
  | { type: "array";    items: Expression[] }
  | { type: "object";   properties: Record<string, Expression> }
  | { type: "fn";       name: string; args: Expression[] }
  | { type: "cond";     if: Expression; then: Expression; else: Expression }
  // ── Iteration & Composition ──────────────────────────────────────────────
  // Chain expressions left-to-right — "$" in a step = current flowing value
  | { type: "pipe";     steps: Expression[] }
  // Transform every item — "as" names the loop variable, accessible via "$.{as}"
  | { type: "map";      over: Expression; as: string; body: Expression }
  // Subset an array by condition
  | { type: "filter";   over: Expression; as: string; where: Expression }
  // Fold an array into a single value
  | { type: "reduce";   over: Expression; as: string; acc: string; init: Expression; body: Expression }
  // Bind local variables scoped to the body expression
  | { type: "let";      bindings: Record<string, Expression>; body: Expression }
  // Pattern matching — first matching case wins, $ = tested value inside when/then
  | { type: "match";    value: Expression; cases: Array<{ when: Expression; then: Expression }>; default?: Expression }

// ─────────────────────────────────────────────
// NODE
// ─────────────────────────────────────────────

export interface NodeMeta {
  name:               string
  description?:       string
  icon?:              string
  category?:          string
  docsUrl?:           string
  tags?:              string[]
  deprecated?:        boolean
  deprecatedMessage?: string
}

export interface NodeDefinition {
  id:            string
  type:          string
  config:        Record<string, Expression>
  retry?:        RetryPolicy
  timeout?:      number
  cache?:        CachePolicy
  outputSchema?: JSONSchema    // instance-level override for dynamic output shapes
  meta?:         NodeMeta      // UI/docs only — runtime ignores entirely
}

export interface RetryPolicy {
  maxAttempts: number
  backoff:     "fixed" | "exponential"
  delayMs:     number
}

export interface CachePolicy {
  ttlMs: number
  key:   Expression
}

// ─────────────────────────────────────────────
// CORE NODE CONFIG SHAPES
// Documented here for compiler awareness + type safety
// Runtime implementations live in the plugin system
// ─────────────────────────────────────────────

// flow.loop — sequential iteration with accumulated state
export interface LoopNodeConfig {
  over:       Expression   // array to iterate (or counter: { type:"fn", name:"range", args:[n] })
  as:         string       // item binding — available downstream as $.{nodeId}.current
  maxRuns:    number       // hard safety ceiling — default 100
  breakWhen?: Expression   // early exit condition — evaluated after each iteration
}

// flow.error — catches upstream failures routed via error edges
// Receives: { nodeId, error, message, attempt, config }
export interface ErrorNodeConfig {
  strategy: "stop" | "continue" | "retry"  // what to do after handling
}

// data.parse — structured format parsing
// XML/HTML are plugins — core supports json, csv, yaml only
export interface ParseNodeConfig {
  input:      Expression                              // the raw string to parse
  format:     "json" | "csv" | "yaml"
  // CSV options
  delimiter?: Expression                              // default ","
  headers?:   Expression                              // true = first row, or string[]
  // Output shaping
  schema?:    JSONSchema                              // validate + coerce output
}

// store — unified KV store node (replaces store.get / store.set / store.delete)
// Scope: "workspace" (default) | "flow" — flows cannot stomp each other's state
export interface StoreNodeConfig {
  mode:    "get" | "set" | "delete"
  key:     Expression
  value?:  Expression   // set only
  ttl?:    Expression   // set only — milliseconds until expiry
  scope?:  "workspace" | "flow"
  default?: Expression  // get only — returned when key is missing
}

// ai — unified AI node (replaces ai.complete / ai.embed / ai.classify / ai.extract)
export interface AiNodeConfig {
  mode: "complete" | "embed" | "classify" | "extract"

  // complete — LLM text generation / chat
  prompt?:      Expression
  model?:       Expression    // default: workspace setting
  temperature?: Expression
  maxTokens?:   Expression

  // embed — vector embedding
  input?:       Expression

  // classify — AI-driven routing
  // Output: { label: string, confidence: number }
  // Use with conditional edges: $.{nodeId}.label == "positive"
  categories?:  Expression    // string[] of possible labels

  // extract — structured data from unstructured text
  // Output shape is driven by schema
  schema?:      JSONSchema    // defines the fields to extract
}

// ─────────────────────────────────────────────
// EDGE
// ─────────────────────────────────────────────

export interface Edge {
  id:         string
  from:       string
  to:         string
  condition?: Expression
  transform?: Expression
  fanOut?: {
    iterate:     Expression
    parallelism: number
  }
  label?: string   // UI only — human readable label

  // Controls when this edge is traversed:
  //   "success" (default) — source node completed without error
  //   "error"             — source node threw / returned ok:false
  //   "always"            — regardless of source outcome
  kind?: "success" | "error" | "always"
}

// ─────────────────────────────────────────────
// FLOW
// ─────────────────────────────────────────────

export interface Flow {
  id:           string
  version:      string
  name:         string
  description?: string
  tags?:        string[]   // ["crm", "ai", "leads"] — grouping + search

  // Tenancy
  accountId:   string
  workspaceId: string
  createdBy:   string
  createdAt:   number
  updatedAt:   number

  // Graph
  nodes: Record<string, NodeDefinition>
  edges: Edge[]

  // If declared, flow auto-registers as a subflow node
  input?:  JSONSchema
  output?: JSONSchema

  variables?: Record<string, VariableDefinition>
  settings?:  FlowSettings
}

export interface VariableDefinition {
  type:     "string" | "number" | "boolean" | "object" | "array"
  default?: unknown
  secret?:  boolean
}

export interface FlowSettings {
  timeoutMs?:   number
  concurrency?: number
  errorPolicy?: "stop" | "continue" | "retry"
}

// ─────────────────────────────────────────────
// JSON SCHEMA (minimal)
// ─────────────────────────────────────────────

export interface JSONSchema {
  type:        "string" | "number" | "boolean" | "object" | "array"
  properties?: Record<string, JSONSchema>
  items?:      JSONSchema
  required?:   string[]
}

// ─────────────────────────────────────────────
// EXECUTION PLAN — compiler output
// ─────────────────────────────────────────────

export interface ExecutionStage {
  index: number
  nodes: string[]
  edges: Record<string, Edge[]>
}

// Pre-computed at compile time — runtime does O(1) routing lookup
export interface ExecutionEdge {
  edge:        Edge
  sourceStage: number
  targetStage: number
}

export interface ExecutionPlan {
  flowId:     string
  version:    string
  compiledAt: number

  stages:     ExecutionStage[]
  nodes:      Record<string, NodeDefinition>
  triggerIds: string[]
  statics:    Record<string, unknown>

  // O(1) routing — nodeId → outgoing ExecutionEdges
  routing: Record<string, ExecutionEdge[]>

  // Metadata
  nodeCount:    number
  stageCount:   number
  hasBranching: boolean
  hasFanOut:    boolean
}

// ─────────────────────────────────────────────
// COMPILATION ERRORS
// ─────────────────────────────────────────────

export type ErrorCode =
  | "NO_NODES"
  | "UNKNOWN_NODE_TYPE"
  | "INVALID_EDGE_SOURCE"
  | "INVALID_EDGE_TARGET"
  | "CYCLE_DETECTED"
  | "INVALID_ENTRY_NODE"
  | "INVALID_REF"              // valid structure, path doesn't resolve
  | "INVALID_EXPRESSION"       // malformed expression structure
  | "SCHEMA_MISMATCH"          // input/output schemas incompatible across edge
  | "ORPHANED_NODE"
  | "INVALID_LOOP_CONFIG"      // flow.loop missing required fields or invalid maxRuns
  | "INVALID_ERROR_EDGE"       // error edge points to non-flow.error node
  | "UNREACHABLE_ERROR_NODE"   // flow.error node has no incoming error edges
  | "INVALID_NODE_MODE"        // store/ai node has missing or invalid mode field

export interface CompilationError {
  code:    ErrorCode
  message: string
  nodeId?: string
  edgeId?: string
}
