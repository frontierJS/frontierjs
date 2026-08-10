import type { IDatabase }         from "./db"
import type {
  IExecutionStore,
  RecordFilter,
  FlowMetrics,
  NodeMetric,
  ErrorSummary,
} from "../runtime/store"
import type { ExecutionContext, ExecutionRecord, ExecutionStatus, NodeExecutionState } from "../runtime/context"

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000   // 30 days

export class SQLiteExecutionStore implements IExecutionStore {
  constructor(
    private readonly db: IDatabase,
    private readonly retentionMs = DEFAULT_RETENTION_MS,
  ) {}

  async saveRecord(record: ExecutionRecord): Promise<void> {
    this.db.run(
      `INSERT INTO executionRecords
         (executionId, flowId, version, status, trigger, startedAt, endedAt,
          durationMs, nodeStates, nodeTimings, slowNodes, error, finalContext)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (executionId) DO UPDATE SET
         status       = excluded.status,
         endedAt      = excluded.endedAt,
         durationMs   = excluded.durationMs,
         nodeStates   = excluded.nodeStates,
         nodeTimings  = excluded.nodeTimings,
         slowNodes    = excluded.slowNodes,
         error        = excluded.error,
         finalContext = excluded.finalContext`,
      [
        record.executionId,
        record.flowId,
        record.version,
        record.status,
        JSON.stringify(record.trigger),
        record.startedAt,
        record.endedAt,
        record.durationMs,
        JSON.stringify(record.nodeStates),
        JSON.stringify(record.nodeTimings),
        JSON.stringify(record.slowNodes),
        record.error ?? null,
        JSON.stringify(record.finalContext),
      ],
    )
  }

  async getRecord(executionId: string): Promise<ExecutionRecord | undefined> {
    const row = this.db.get<RawRecord>(
      "SELECT * FROM executionRecords WHERE executionId = ?",
      [executionId],
    )
    return row ? rowToRecord(row) : undefined
  }

  async queryRecords(filter: RecordFilter): Promise<ExecutionRecord[]> {
    const { flowId, status, since, limit = 50, offset = 0 } = filter

    const conditions: string[] = []
    const params: (string | number)[] = []

    if (flowId) { conditions.push("flowId = ?");    params.push(flowId) }
    if (status) { conditions.push("status = ?");    params.push(status) }
    if (since)  { conditions.push("startedAt >= ?"); params.push(since) }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
    params.push(limit, offset)

    const rows = this.db.all<RawRecord>(
      `SELECT * FROM executionRecords ${where}
       ORDER BY startedAt DESC LIMIT ? OFFSET ?`,
      params,
    )
    return rows.map(rowToRecord)
  }

  async saveContext(ctx: ExecutionContext): Promise<void> {
    this.db.run(
      `INSERT INTO executionContexts (executionId, context, updatedAt)
       VALUES (?, ?, ?)
       ON CONFLICT (executionId) DO UPDATE SET
         context   = excluded.context,
         updatedAt = excluded.updatedAt`,
      [ctx.executionId, JSON.stringify(ctx), Date.now()],
    )
  }

  async getContext(executionId: string): Promise<ExecutionContext | undefined> {
    const row = this.db.get<{ context: string }>(
      "SELECT context FROM executionContexts WHERE executionId = ?",
      [executionId],
    )
    if (!row) return undefined
    try   { return JSON.parse(row.context) as ExecutionContext }
    catch { return undefined }
  }

  async getMetrics(flowId?: string, windowMs = 3_600_000): Promise<FlowMetrics> {
    const since = Date.now() - windowMs

    const conditions: string[] = ["startedAt >= ?"]
    const params: (string | number)[] = [since]
    if (flowId) { conditions.push("flowId = ?"); params.push(flowId) }

    const where = `WHERE ${conditions.join(" AND ")}`

    const records = this.db.all<RawRecord>(
      `SELECT * FROM executionRecords ${where}`,
      params,
    )

    const total     = records.length
    const succeeded = records.filter(r => r.status === "completed").length
    const durations = records.map(r => r.durationMs).sort((a, b) => a - b)

    const avgDurationMs = total > 0 ? durations.reduce((s, d) => s + d, 0) / total : 0
    const p95DurationMs = total > 0 ? (durations[Math.floor(durations.length * 0.95)] ?? 0) : 0

    const nodeMs = new Map<string, number[]>()
    for (const row of records) {
      const timings = parseJson<Record<string, number>>(row.nodeTimings, {})
      for (const [nodeId, ms] of Object.entries(timings)) {
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

    const errorCounts = new Map<string, number>()
    for (const row of records) {
      const states = parseJson<Record<string, NodeExecutionState>>(row.nodeStates, {})
      for (const state of Object.values(states)) {
        if (state.error) {
          errorCounts.set(state.error, (errorCounts.get(state.error) ?? 0) + 1)
        }
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

  purgeExpired(): number {
    const cutoff = Date.now() - this.retentionMs
    this.db.run("DELETE FROM executionRecords WHERE endedAt < ?", [cutoff])
    this.db.run(
      `DELETE FROM executionContexts WHERE executionId NOT IN (
         SELECT executionId FROM executionRecords WHERE status IN ('running', 'resuming')
       )`,
    )
    return 0
  }
}

interface RawRecord {
  executionId:  string
  flowId:       string
  version:      string
  status:       string
  trigger:      string
  startedAt:    number
  endedAt:      number
  durationMs:   number
  nodeStates:   string
  nodeTimings:  string
  slowNodes:    string
  error:        string | null
  finalContext: string
}

function rowToRecord(row: RawRecord): ExecutionRecord {
  return {
    executionId:  row.executionId,
    flowId:       row.flowId,
    version:      row.version,
    status:       row.status as ExecutionStatus,
    trigger:      parseJson(row.trigger, null),
    startedAt:    row.startedAt,
    endedAt:      row.endedAt,
    durationMs:   row.durationMs,
    nodeStates:   parseJson<Record<string, NodeExecutionState>>(row.nodeStates, {}),
    nodeTimings:  parseJson<Record<string, number>>(row.nodeTimings, {}),
    slowNodes:    parseJson<string[]>(row.slowNodes, []),
    error:        row.error ?? undefined,
    finalContext: parseJson<Record<string, unknown>>(row.finalContext, {}),
  }
}

function parseJson<T>(json: string, fallback: T): T {
  try   { return JSON.parse(json) as T }
  catch { return fallback }
}
