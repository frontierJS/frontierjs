import type { Flow } from "../types"
import type { IDatabase } from "./db"

export type FlowStatus = "active" | "inactive" | "archived"

export interface FlowRow {
  id:         string
  version:    string
  name:       string
  definition: string
  status:     FlowStatus
  createdBy:  string
  createdAt:  number
  updatedAt:  number
}

export interface IFlowStore {
  save(flow: Flow): void
  get(flowId: string): Flow | undefined
  getVersion(flowId: string, version: string): Flow | undefined
  listActive(): Flow[]
  setStatus(flowId: string, version: string, status: FlowStatus): void
  versions(flowId: string): Array<{ version: string; status: FlowStatus; updatedAt: number }>
  delete(flowId: string): void
  saveLayout(flowId: string, layout: Record<string, unknown>): void
  getLayout(flowId: string): Record<string, unknown> | undefined
}

export class SQLiteFlowStore implements IFlowStore {
  constructor(private readonly db: IDatabase) {}

  save(flow: Flow): void {
    this.db.run(
      `INSERT INTO flows (id, version, name, definition, status, createdBy, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
       ON CONFLICT (id, version) DO UPDATE SET
         name       = excluded.name,
         definition = excluded.definition,
         status     = excluded.status,
         updatedAt  = excluded.updatedAt`,
      [flow.id, flow.version, flow.name, JSON.stringify(flow), flow.createdBy, flow.createdAt, flow.updatedAt],
    )
  }

  get(flowId: string): Flow | undefined {
    const row = this.db.get<{ definition: string }>(
      `SELECT definition FROM flows
       WHERE id = ? AND status = 'active'
       ORDER BY updatedAt DESC LIMIT 1`,
      [flowId],
    )
    return row ? parseFlow(row.definition) : undefined
  }

  getVersion(flowId: string, version: string): Flow | undefined {
    const row = this.db.get<{ definition: string }>(
      "SELECT definition FROM flows WHERE id = ? AND version = ?",
      [flowId, version],
    )
    return row ? parseFlow(row.definition) : undefined
  }

  listActive(): Flow[] {
    const rows = this.db.all<{ definition: string }>(
      `SELECT definition FROM flows f1
       WHERE status = 'active'
         AND updatedAt = (
           SELECT MAX(updatedAt) FROM flows f2
           WHERE f2.id = f1.id AND f2.status = 'active'
         )`,
    )
    return rows.map(r => parseFlow(r.definition)).filter((f): f is Flow => f !== undefined)
  }

  setStatus(flowId: string, version: string, status: FlowStatus): void {
    this.db.run(
      "UPDATE flows SET status = ?, updatedAt = ? WHERE id = ? AND version = ?",
      [status, Date.now(), flowId, version],
    )
  }

  versions(flowId: string): Array<{ version: string; status: FlowStatus; updatedAt: number }> {
    return this.db.all<{ version: string; status: FlowStatus; updatedAt: number }>(
      "SELECT version, status, updatedAt FROM flows WHERE id = ? ORDER BY updatedAt DESC",
      [flowId],
    )
  }

  delete(flowId: string): void {
    this.db.run(
      "UPDATE flows SET status = 'archived', updatedAt = ? WHERE id = ?",
      [Date.now(), flowId],
    )
  }

  saveLayout(flowId: string, layout: Record<string, unknown>): void {
    this.db.run(
      `INSERT INTO flowLayouts (flowId, layout, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT (flowId) DO UPDATE SET layout = excluded.layout, updatedAt = excluded.updatedAt`,
      [flowId, JSON.stringify(layout), Date.now()],
    )
  }

  getLayout(flowId: string): Record<string, unknown> | undefined {
    const row = this.db.get<{ layout: string }>(
      "SELECT layout FROM flowLayouts WHERE flowId = ?",
      [flowId],
    )
    if (!row) return undefined
    try { return JSON.parse(row.layout) as Record<string, unknown> } catch { return undefined }
  }
}

function parseFlow(json: string): Flow | undefined {
  try { return JSON.parse(json) as Flow } catch { return undefined }
}
