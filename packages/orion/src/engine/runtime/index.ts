// ─────────────────────────────────────────────
// RUNTIME
// Single import surface — internal structure is an implementation detail.
//
// Modules:
//   context   — ExecutionContext, ExecutionRecord, NodeExecutionState
//   queue     — IExecutionQueue, InMemoryQueue, QueueFullError, ExecutionJob
//   store     — IExecutionStore, InMemoryExecutionStore, IPlanCache,
//               InMemoryPlanCache, FlowMetrics, RecordFilter
//   scheduler — Scheduler, SchedulerEvent, SchedulerOptions
// ─────────────────────────────────────────────

export type { ExecutionStatus, NodeExecutionState, ExecutionContext, ExecutionRecord } from "./context"
export type { ExecutionJob, IExecutionQueue }                                          from "./queue"
export type { IExecutionStore, IPlanCache, RecordFilter, FlowMetrics, NodeMetric, ErrorSummary } from "./store"
export type { SchedulerEvent, SchedulerEventHandler, SchedulerOptions }               from "./scheduler"

export { InMemoryQueue, QueueFullError }            from "./queue"
export { InMemoryExecutionStore, InMemoryPlanCache } from "./store"
export { Scheduler }                                from "./scheduler"
export { buildRecord }                              from "./helpers"
