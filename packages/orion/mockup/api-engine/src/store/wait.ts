import type { IDatabase } from "./db"

export interface WaitEntry {
  resumeKey:    string
  executionId:  string
  flowId:       string
  nodeId:       string
  resumeCtxKey: string
  timeoutAt:    number | null
  createdAt:    number
}

export class WaitRegistry {
  constructor(private readonly db: IDatabase) {}

  register(entry: WaitEntry): void {
    this.db.run(
      `INSERT INTO waitingExecutions
         (resumeKey, executionId, flowId, nodeId, resumeCtxKey, timeoutAt, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [entry.resumeKey, entry.executionId, entry.flowId, entry.nodeId,
       entry.resumeCtxKey, entry.timeoutAt, entry.createdAt],
    )
  }

  getByKey(resumeKey: string): WaitEntry | undefined {
    const row = this.db.get<WaitEntry>(
      "SELECT * FROM waitingExecutions WHERE resumeKey = ?",
      [resumeKey],
    )
    return row ?? undefined
  }

  getByExecution(executionId: string): WaitEntry | undefined {
    const row = this.db.get<WaitEntry>(
      "SELECT * FROM waitingExecutions WHERE executionId = ?",
      [executionId],
    )
    return row ?? undefined
  }

  consume(resumeKey: string): void {
    this.db.run("DELETE FROM waitingExecutions WHERE resumeKey = ?", [resumeKey])
  }

  getExpired(): WaitEntry[] {
    return this.db.all<WaitEntry>(
      "SELECT * FROM waitingExecutions WHERE timeoutAt IS NOT NULL AND timeoutAt < ?",
      [Date.now()],
    )
  }

  deleteExpired(): number {
    const rows = this.db.all<{ resumeKey: string }>(
      "SELECT resumeKey FROM waitingExecutions WHERE timeoutAt IS NOT NULL AND timeoutAt < ?",
      [Date.now()],
    )
    if (rows.length === 0) return 0
    this.db.run(
      "DELETE FROM waitingExecutions WHERE timeoutAt IS NOT NULL AND timeoutAt < ?",
      [Date.now()],
    )
    return rows.length
  }
}
