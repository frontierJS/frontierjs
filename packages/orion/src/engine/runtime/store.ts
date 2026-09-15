import type { ExecutionPlan } from "../types"
import type { ExecutionStatus, ExecutionContext, ExecutionRecord, NodeExecutionState } from "./context"

// ─────────────────────────────────────────────
// EXECUTION STORE
// Persists execution records + live context checkpoints.
// Default: in-memory. Real implementation: SQLite (dev) / Postgres (prod).
//
// Surface API:
//   store.saveRecord(record)            → persist completed run
//   store.getRecord(id)                 → look up by executionId
//   store.saveContext(ctx)              → checkpoint mid-run (resumability)
//   store.getContext(id)                → load for resume
//   store.queryRecords(filter)          → paginated admin history
//   store.getMetrics(flowId?, windowMs) → aggregated perf + health data
// ─────────────────────────────────────────────

export interface RecordFilter {
  flowId?:  string
  status?:  ExecutionStatus
  since?:   number     // unix ms — records with startedAt >= since
  limit?:   number     // default 50
  offset?:  number     // for cursor pagination
}

export interface NodeMetric {
  nodeId: string
  avgMs:  number
  p95Ms:  number
  count:  number
}

export interface ErrorSummary {
  error: string
  count: number
}

export interface FlowMetrics {
  flowId?:       string      // undefined = all flows aggregated
  windowMs:      number
  totalRuns:     number
  successRate:   number      // 0–1
  avgDurationMs: number
  p95DurationMs: number
  slowNodes:     NodeMetric[]
  errorSummary:  ErrorSummary[]
}

export interface IExecutionStore {
  // ── Core ─────────────────────────────────────
  saveRecord(record: ExecutionRecord): Promise<void>
  getRecord(executionId: string): Promise<ExecutionRecord | undefined>
  saveContext(ctx: ExecutionContext): Promise<void>
  getContext(executionId: string): Promise<ExecutionContext | undefined>

  // ── Admin queries ─────────────────────────────
  queryRecords(filter: RecordFilter): Promise<ExecutionRecord[]>
  getMetrics(flowId?: string, windowMs?: number): Promise<FlowMetrics>
}

// ─────────────────────────────────────────────
// PLAN CACHE
// Compile-once, run-many. Invalidate on flow update.
//
// Surface API:
//   cache.get(flowId, version)         → ExecutionPlan | undefined
//   cache.set(flowId, version, plan)
//   cache.invalidate(flowId)           → removes all versions
// ─────────────────────────────────────────────

export interface IPlanCache {
  get(flowId: string, version: string): ExecutionPlan | undefined
  set(flowId: string, version: string, plan: ExecutionPlan): void
  invalidate(flowId: string): void
}

// ─────────────────────────────────────────────
// IN-MEMORY EXECUTION STORE
// ─────────────────────────────────────────────

export class InMemoryExecutionStore implements IExecutionStore {
  private records  = new Map<string, ExecutionRecord>()
  private contexts = new Map<string, ExecutionContext>()

  async saveRecord(record: ExecutionRecord): Promise<void> {
    this.records.set(record.executionId, record)
  }

  async getRecord(executionId: string): Promise<ExecutionRecord | undefined> {
    return this.records.get(executionId)
  }

  async saveContext(ctx: ExecutionContext): Promise<void> {
    // Deep clone — context is mutable; stored snapshot must be stable
    this.contexts.set(ctx.executionId, JSON.parse(JSON.stringify(ctx)))
  }

  async getContext(executionId: string): Promise<ExecutionContext | undefined> {
    return this.contexts.get(executionId)
  }

  async queryRecords(filter: RecordFilter): Promise<ExecutionRecord[]> {
    const { flowId, status, since, limit = 50, offset = 0 } = filter

    let results = [...this.records.values()]
    if (flowId) results = results.filter(r => r.flowId === flowId)
    if (status) results = results.filter(r => r.status === status)
    if (since)  results = results.filter(r => r.startedAt >= since)

    results.sort((a, b) => b.startedAt - a.startedAt)  // newest first
    return results.slice(offset, offset + limit)
  }

  async getMetrics(flowId?: string, windowMs = 3_600_000): Promise<FlowMetrics> {
    const since   = Date.now() - windowMs
    const records = [...this.records.values()].filter(r =>
      r.startedAt >= since && (!flowId || r.flowId === flowId)
    )

    const total     = records.length
    const succeeded = records.filter(r => r.status === "completed").length
    const durations = records.map(r => r.durationMs).sort((a, b) => a - b)

    const avgDurationMs = total > 0
      ? durations.reduce((s, d) => s + d, 0) / total : 0
    const p95DurationMs = total > 0
      ? (durations[Math.floor(durations.length * 0.95)] ?? 0) : 0

    // Per-node timing aggregation
    const nodeMs = new Map<string, number[]>()
    for (const record of records) {
      for (const [nodeId, ms] of Object.entries(record.nodeTimings)) {
        if (!nodeMs.has(nodeId)) nodeMs.set(nodeId, [])
        nodeMs.get(nodeId)!.push(ms)
      }
    }

    const slowNodes: NodeMetric[] = [...nodeMs.entries()]
      .map(([nodeId, msList]) => {
        const sorted = [...msList].sort((a, b) => a - b)
        return {
          nodeId,
          avgMs: sorted.reduce((s, v) => s + v, 0) / sorted.length,
          p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
          count: sorted.length,
        }
      })
      .sort((a, b) => b.avgMs - a.avgMs)
      .slice(0, 10)

    // Error frequency aggregation
    const errorCounts = new Map<string, number>()
    for (const record of records) {
      for (const state of Object.values(record.nodeStates as Record<string, NodeExecutionState>)) {
        if (state.error) errorCounts.set(state.error, (errorCounts.get(state.error) ?? 0) + 1)
      }
    }

    const errorSummary: ErrorSummary[] = [...errorCounts.entries()]
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count)

    return {
      flowId,
      windowMs,
      totalRuns:    total,
      successRate:  total > 0 ? succeeded / total : 1,
      avgDurationMs,
      p95DurationMs,
      slowNodes,
      errorSummary,
    }
  }

  // ── Dev / test helpers ────────────────────────
  recordCount():  number { return this.records.size }
  contextCount(): number { return this.contexts.size }
  clear(): void { this.records.clear(); this.contexts.clear() }
}

// ─────────────────────────────────────────────
// IN-MEMORY PLAN CACHE
// ─────────────────────────────────────────────

export class InMemoryPlanCache implements IPlanCache {
  private readonly plans = new Map<string, ExecutionPlan>()

  private key(flowId: string, version: string) { return `${flowId}:${version}` }

  get(flowId: string, version: string): ExecutionPlan | undefined {
    return this.plans.get(this.key(flowId, version))
  }

  set(flowId: string, version: string, plan: ExecutionPlan): void {
    this.plans.set(this.key(flowId, version), plan)
  }

  invalidate(flowId: string): void {
    for (const key of this.plans.keys()) {
      if (key.startsWith(`${flowId}:`)) this.plans.delete(key)
    }
  }

  size(): number { return this.plans.size }
}
