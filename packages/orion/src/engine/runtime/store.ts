import type { ExecutionPlan } from "../types"
import type { ExecutionContext, ExecutionRecord } from "./context"

// ─────────────────────────────────────────────
// EXECUTION STORE
// What the scheduler writes and a resume reads — nothing else. History and
// metrics are the host's reads over its own models, not the engine's.
//
// Surface API:
//   store.saveContext(ctx)   → checkpoint once per stage (the hot path)
//   store.getContext(id)     → load for resume; undefined once the run ended
//   store.saveRecord(record) → the run ended: one terminal write
//   store.getRecord(id)      → the ended run, as history
// ─────────────────────────────────────────────

export interface IExecutionStore {
  saveContext(ctx: ExecutionContext): Promise<void>
  getContext(executionId: string): Promise<ExecutionContext | undefined>
  saveRecord(record: ExecutionRecord): Promise<void>
  getRecord(executionId: string): Promise<ExecutionRecord | undefined>
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
    this.contexts.delete(record.executionId)
  }

  async getRecord(executionId: string): Promise<ExecutionRecord | undefined> {
    return this.records.get(executionId)
  }

  async saveContext(ctx: ExecutionContext): Promise<void> {
    // Deep clone — context is mutable; stored snapshot must be stable. The two
    // transient handles are live objects, and a client does not survive JSON.
    const { actor: _actor, responseHandle: _handle, ...stored } = ctx
    this.contexts.set(ctx.executionId, JSON.parse(JSON.stringify(stored)))
  }

  async getContext(executionId: string): Promise<ExecutionContext | undefined> {
    return this.contexts.get(executionId)
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
