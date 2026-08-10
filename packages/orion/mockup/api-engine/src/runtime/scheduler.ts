import type { ExecutionPlan, Edge } from "../types"
import type { ResolutionContext } from "../expression"
import type { ExecutorOutcome, INodeRegistry, LogEntry } from "../executor"
import type { IExecutionCache } from "../cache"
import { NodeExecutor } from "../executor"
import type { ExecutionContext, NodeExecutionState, SyncResponseHandle } from "./context"
import type { ExecutionJob } from "./queue"
import type { IExecutionStore, IPlanCache } from "./store"
import { buildRecord } from "./helpers"

// ─────────────────────────────────────────────
// SCHEDULER EVENTS
// Emitted as the run progresses — admin SSE handler subscribes here.
// listener errors are swallowed — a broken subscriber never crashes the scheduler.
// ─────────────────────────────────────────────

export type SchedulerEvent =
  | { type: "execution:started";   executionId: string; flowId: string; trigger: unknown }
  | { type: "execution:completed"; executionId: string; flowId: string; durationMs: number }
  | { type: "execution:failed";    executionId: string; flowId: string; error: string }
  | { type: "node:started";        executionId: string; nodeId: string }
  | { type: "node:completed";      executionId: string; nodeId: string; durationMs: number; fromCache: boolean }
  | { type: "node:failed";         executionId: string; nodeId: string; error: string; routable: boolean }
  | { type: "node:skipped";        executionId: string; nodeId: string }
  | { type: "stage:completed";     executionId: string; stage: number }

export type SchedulerEventHandler = (event: SchedulerEvent) => void

// ─────────────────────────────────────────────
// SCHEDULER
// Pulls jobs off the queue, runs stages in order, writes the record.
// The only place that understands the DAG structure at runtime.
//
// Surface API:
//   new Scheduler(queue, plans, store, nodeRegistry, cache?, opts?)
//   scheduler.run()                → starts processing loop (until stop())
//   scheduler.stop()               → graceful halt
//   scheduler.processJob(job)      → run a single job, returns ExecutionRecord
//   scheduler.on(handler)          → subscribe to events, returns unsubscribe fn
//   scheduler.activeCount          → current in-flight job count (health endpoint)
// ─────────────────────────────────────────────

export interface SchedulerOptions {
  concurrency?: number   // max concurrent jobs — default 10
  checkpoint?:  boolean  // save context after each stage — enables mid-flow resume
}

export class Scheduler {
  private readonly executor:  NodeExecutor
  private readonly listeners = new Set<SchedulerEventHandler>()
  private          running   = 0
  private          stopped   = false

  constructor(
    private readonly queue:    import("./queue").IExecutionQueue,
    private readonly plans:    IPlanCache,
    private readonly store:    IExecutionStore,
    nodeRegistry:              INodeRegistry,
    nodeCache?:                IExecutionCache,
    private readonly opts:     SchedulerOptions = {},
  ) {
    this.executor = new NodeExecutor(nodeRegistry, nodeCache)
  }

  // ─── LIFECYCLE ───────────────────────────────

  async run(): Promise<void> {
    this.stopped = false
    const concurrency = this.opts.concurrency ?? 10

    while (!this.stopped) {
      if (this.running >= concurrency) { await sleep(10); continue }

      const job = await this.queue.dequeue()
      if (!job) { await sleep(10); continue }

      this.running++
      this.processJob(job).finally(() => this.running--)
    }
  }

  stop(): void { this.stopped = true }

  get activeCount(): number { return this.running }

  // ─── EVENT EMITTER ───────────────────────────

  on(handler: SchedulerEventHandler): () => void {
    this.listeners.add(handler)
    return () => this.listeners.delete(handler)
  }

  private emit(event: SchedulerEvent): void {
    for (const h of this.listeners) {
      try { h(event) } catch { /* listener errors must never crash the scheduler */ }
    }
  }

  // ─── JOB PROCESSING ──────────────────────────

  async processJob(job: ExecutionJob): Promise<import("./context").ExecutionRecord> {
    const plan = this.plans.get(job.flowId, job.version)
    if (!plan) throw new Error(`No execution plan found for flow "${job.flowId}"`)

    const ctx: ExecutionContext = job.resumeFrom
      ? { ...job.resumeFrom, status: "resuming" }
      : makeContext(job, plan)

    ctx.status    = "running"
    ctx.startedAt = ctx.startedAt || Date.now()

    this.emit({ type: "execution:started", executionId: ctx.executionId, flowId: ctx.flowId, trigger: ctx.trigger })

    try {
      await this.runStages(ctx, plan)
      ctx.status  = "completed"
      ctx.endedAt = Date.now()
      this.emit({ type: "execution:completed", executionId: ctx.executionId, flowId: ctx.flowId, durationMs: ctx.endedAt - ctx.startedAt })
    } catch (err) {
      ctx.status  = "failed"
      ctx.endedAt = Date.now()
      ctx.error   = errorMessage(err)
      this.emit({ type: "execution:failed", executionId: ctx.executionId, flowId: ctx.flowId, error: ctx.error })
    }

    const record = buildRecord(ctx)
    await this.store.saveRecord(record)
    return record
  }

  // ─── STAGES ──────────────────────────────────

  private async runStages(ctx: ExecutionContext, plan: ExecutionPlan): Promise<void> {
    for (let i = ctx.currentStage; i < plan.stages.length; i++) {
      const stage    = plan.stages[i]!
      ctx.currentStage = i

      const runnable = stage.nodes.filter(id => {
        const s = ctx.nodeStates[id]
        return !s || s.status === "pending"
      })

      if (runnable.length > 0) {
        await Promise.all(runnable.map(id => this.runNode(id, ctx, plan)))
      }

      // flow.wait suspended this execution — checkpoint and stop processing
      if (ctx.status === "waiting") {
        if (this.opts.checkpoint) await this.store.saveContext(ctx)
        return
      }

      this.emit({ type: "stage:completed", executionId: ctx.executionId, stage: i })

      if (this.opts.checkpoint) await this.store.saveContext(ctx)
    }
  }

  // ─── NODE ────────────────────────────────────

  private async runNode(nodeId: string, ctx: ExecutionContext, plan: ExecutionPlan): Promise<void> {
    const node  = plan.nodes[nodeId]!
    const state = initNodeState(ctx, nodeId)

    state.status    = "running"
    state.startedAt = Date.now()
    this.emit({ type: "node:started", executionId: ctx.executionId, nodeId })

    const resCtx: ResolutionContext = { trigger: ctx.trigger, nodes: ctx.nodes }
    const { outcome, logs } = await this.executor.execute(node, resCtx, {
      executionId: ctx.executionId,
      respond:     ctx.responseHandle?.resolve,
    })

    state.endedAt  = Date.now()
    state.attempts = outcome.attempts
    state.logs     = logs

    if (outcome.ok) {
      // flow.wait sentinel — node signals the execution should suspend
      const data = outcome.data as Record<string, unknown> | null
      if (data && typeof data === "object" && data["__orion_wait"] === true) {
        ctx.status = "waiting"
        state.status = "completed"
        state.output = data
        ctx.nodes[nodeId] = data
        return
      }

      state.status    = "completed"
      state.fromCache = outcome.fromCache
      state.output    = outcome.data
      ctx.nodes[nodeId] = outcome.data
      this.emit({ type: "node:completed", executionId: ctx.executionId, nodeId, durationMs: outcome.durationMs, fromCache: outcome.fromCache })
    } else {
      state.status = "failed"
      state.error  = outcome.error
      this.emit({ type: "node:failed", executionId: ctx.executionId, nodeId, error: outcome.error, routable: outcome.routable })

      if (!outcome.routable) return

      const errorEdges = (plan.routing[nodeId] ?? [])
        .filter(e => e.edge.kind === "error" || e.edge.kind === "always")

      if (errorEdges.length === 0) {
        throw new Error(`Node "${nodeId}" failed: ${outcome.error}`)
      }
      this.skipSuccessDescendants(nodeId, ctx, plan)
    }

    await this.routeEdges(nodeId, ctx, plan, outcome)
  }

  // ─── ROUTING ─────────────────────────────────

  private async routeEdges(
    nodeId:  string,
    ctx:     ExecutionContext,
    plan:    ExecutionPlan,
    outcome: ExecutorOutcome,
  ): Promise<void> {
    for (const { edge } of (plan.routing[nodeId] ?? [])) {
      const kind = edge.kind ?? "success"
      if (kind === "success" && !outcome.ok) continue
      if (kind === "error"   &&  outcome.ok) continue

      if (edge.condition) {
        const resCtx: ResolutionContext = { trigger: ctx.trigger, nodes: ctx.nodes }
        try {
          if (!this.executor.resolve(edge.condition, resCtx)) {
            initNodeState(ctx, edge.to).status = "skipped"
            continue
          }
        } catch {
          initNodeState(ctx, edge.to).status = "skipped"
          continue
        }
      }

      if (edge.transform && outcome.ok) {
        const resCtx: ResolutionContext = { trigger: ctx.trigger, nodes: ctx.nodes }
        try { ctx.nodes[nodeId] = this.executor.resolve(edge.transform, resCtx) } catch { /* keep original */ }
      }
    }
  }

  private skipSuccessDescendants(nodeId: string, ctx: ExecutionContext, plan: ExecutionPlan): void {
    for (const { edge } of (plan.routing[nodeId] ?? [])) {
      if ((edge.kind ?? "success") === "success") {
        const state = initNodeState(ctx, edge.to)
        if (state.status === "pending") {
          state.status = "skipped"
          this.emit({ type: "node:skipped", executionId: ctx.executionId, nodeId: edge.to })
          this.skipSuccessDescendants(edge.to, ctx, plan)
        }
      }
    }
  }
}

// ─────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────

function makeContext(job: ExecutionJob, plan: ExecutionPlan): ExecutionContext {
  const nodeStates: Record<string, NodeExecutionState> = {}
  for (const nodeId of Object.keys(plan.nodes)) {
    nodeStates[nodeId] = { status: "pending", attempts: 0, fromCache: false, logs: [] }
  }
  return {
    executionId:    job.executionId,
    flowId:         job.flowId,
    version:        plan.version,
    trigger:        job.trigger,
    nodes:          {},
    nodeStates,
    status:         "pending",
    startedAt:      Date.now(),
    currentStage:   0,
    responseHandle: job.responseHandle,  // transient — stripped on serialize
  }
}

function initNodeState(ctx: ExecutionContext, nodeId: string): NodeExecutionState {
  if (!ctx.nodeStates[nodeId]) {
    ctx.nodeStates[nodeId] = { status: "pending", attempts: 0, fromCache: false, logs: [] }
  }
  return ctx.nodeStates[nodeId]!
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
