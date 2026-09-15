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

  // The flow.wait node a suspended run is waiting on; cleared by the resume.
  waitingOn?: string

  // Flow-level error (distinct from node errors)
  error?: string

  // Transient — NEVER serialized. Who the run acts as, as the host's ports
  // understand it (a principal-scoped client, for a litestone host). The engine
  // only carries it to the nodes; a resumed run is handed it again by its job.
  actor?: unknown

  // Transient. A dry run: a node with an effect outside the actor records what
  // it would have done and does not do it (`FJS-D283`).
  dryRun?: boolean

  // Transient. How many rows this run may still write through model nodes, and
  // how many it has — seeded from the completed model nodes in nodeStates, so a
  // resumed run counts what it already wrote (`FJS-D283`).
  writes?: WriteBudget

  // Transient — NEVER serialized to SQLite.
  // Present only for sync webhook executions (trigger.webhook mode: "sync").
  // http.respond reads this to send the held HTTP response.
  responseHandle?: SyncResponseHandle
}

// ─────────────────────────────────────────────
// EXECUTION JOB
// One run handed to Scheduler.processJob — by the host's run job.
// ─────────────────────────────────────────────

export interface WriteBudget {
  limit: number
  used:  number
}

export interface ExecutionJob {
  executionId: string
  flowId:      string
  version:     string
  trigger:     unknown
  // If set, the scheduler resumes from this state instead of starting fresh
  resumeFrom?: ExecutionContext
  // Present for sync webhook flows — resolved by the http.respond node
  responseHandle?: SyncResponseHandle
  // Who the run acts as — see ExecutionContext.actor
  actor?: unknown
  dryRun?: boolean
  // Rows the run may write through model nodes. Absent is no ceiling.
  maxWrites?: number
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
