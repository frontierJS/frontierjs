import type { LogEntry } from "../executor"

// ─────────────────────────────────────────────
// EXECUTION CONTEXT
// Live state for a single in-flight run.
// Plain JSON at every point — fully serializable for resumability.
// currentStage is the resume cursor: crash + reload = pick up here.
//
// Surface API:
//   ExecutionContext  — live state (mutable during run)
//   ExecutionRecord   — permanent history (written once on completion)
//   NodeExecutionState — per-node outcome
// ─────────────────────────────────────────────

export type ExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "resuming"
  | "waiting"    // suspended at flow.wait — resumes via POST /wait/:resumeKey

// Transient handle for sync webhook responses (http.respond node).
// Never serialized — only lives in memory during an in-flight execution.
export interface SyncResponseHandle {
  resolve: (res: SyncHttpResponse) => void
  reject:  (err: Error) => void
}

export interface SyncHttpResponse {
  status:  number
  headers: Record<string, string>
  body:    unknown
}

export interface NodeExecutionState {
  status:     "pending" | "running" | "completed" | "failed" | "skipped"
  startedAt?: number
  endedAt?:   number
  attempts:   number
  fromCache:  boolean
  output?:    unknown    // written on completion — downstream nodes read from here
  error?:     string
  logs:       LogEntry[]
}

export interface ExecutionContext {
  // Identity
  executionId:  string
  flowId:       string
  version:      string

  // Trigger payload — available as $.trigger in all expressions
  trigger: unknown

  // Flat output map — feeds ResolutionContext.nodes directly
  nodes: Record<string, unknown>

  // Full per-node states — observability + resume checkpoint
  nodeStates: Record<string, NodeExecutionState>

  // Lifecycle
  status:       ExecutionStatus
  startedAt:    number
  endedAt?:     number
  currentStage: number    // last stage index reached — resume starts here

  // Flow-level error (distinct from node errors)
  error?: string

  // Transient — NEVER serialized to SQLite.
  // Present only for sync webhook executions (trigger.webhook mode: "sync").
  // http.respond reads this to send the held HTTP response.
  responseHandle?: SyncResponseHandle
}

// ─────────────────────────────────────────────
// EXECUTION RECORD
// Permanent, immutable history entry.
// Written once when a run reaches a terminal state.
// ─────────────────────────────────────────────

export interface ExecutionRecord {
  executionId:  string
  flowId:       string
  version:      string
  status:       ExecutionStatus
  trigger:      unknown
  startedAt:    number
  endedAt:      number
  durationMs:   number
  nodeStates:   Record<string, NodeExecutionState>
  nodeTimings:  Record<string, number>   // nodeId → ms, feeds perf dashboard
  slowNodes:    string[]                 // nodeIds that exceeded SLOW_NODE_THRESHOLD_MS
  error?:       string
  finalContext: Record<string, unknown>  // snapshot of ctx.nodes — enables replay
}
