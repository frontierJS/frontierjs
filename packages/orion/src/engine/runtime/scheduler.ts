import type { ExecutionPlan, Edge } from "../types"
import type { ResolutionContext } from "../expression"
import type { ExecutorOutcome, INodeRegistry, LogEntry } from "../executor"
import type { IExecutionCache } from "../cache"
import { NodeExecutor } from "../executor"
import type { ExecutionContext, ExecutionJob, NodeExecutionState } from "./context"
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
// Runs one run's stages in order and writes the record.
// The only place that understands the DAG structure at runtime. Which run, when
// and how many at once is the host's queue — one job per run.
//
// Surface API:
//   new Scheduler(plans, store, nodeRegistry, cache?, opts?)
//   scheduler.processJob(job)      → run a single job, returns ExecutionRecord
//   scheduler.on(handler)          → subscribe to events, returns unsubscribe fn
// ─────────────────────────────────────────────

export interface SchedulerOptions {
  checkpoint?:  boolean  // save context after each stage — enables mid-flow resume
}

export class Scheduler {
  private readonly executor:  NodeExecutor
  private readonly listeners = new Set<SchedulerEventHandler>()

  constructor(
    private readonly plans:    IPlanCache,
    private readonly store:    IExecutionStore,
    nodeRegistry:              INodeRegistry,
    nodeCache?:                IExecutionCache,
    private readonly opts:     SchedulerOptions = {},
  ) {
    this.executor = new NodeExecutor(nodeRegistry, nodeCache)
  }

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
      ? { ...job.resumeFrom, status: "resuming", actor: job.actor ?? job.resumeFrom.actor }
      : makeContext(job, plan)
    ctx.dryRun = job.dryRun
    if (job.maxWrites !== undefined) ctx.writes = { limit: job.maxWrites, used: writesIn(ctx, plan) }

    ctx.status    = "running"
    ctx.startedAt = ctx.startedAt || Date.now()

    this.emit({ type: "execution:started", executionId: ctx.executionId, flowId: ctx.flowId, trigger: ctx.trigger })

    try {
      // A suspended run has not ended. Recording it would clear the context its
      // resume reads, and call a half-run flow completed.
      if (await this.runStages(ctx, plan) === "suspended") return buildRecord(ctx)
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

  private async runStages(ctx: ExecutionContext, plan: ExecutionPlan): Promise<"ended" | "suspended"> {
    for (let i = ctx.currentStage; i < plan.stages.length; i++) {
      const stage    = plan.stages[i]!
      ctx.currentStage = i

      const runnable = stage.nodes.filter(id => {
        const s = ctx.nodeStates[id]
        return !s || s.status === "pending"
      })

      // Every node in the stage settles before a failure ends the run. With
      // Promise.all the record was written while a sibling was still running, so
      // it named a step `running` in an ended run and that sibling's write could
      // land after the run was recorded failed.
      if (runnable.length > 0) {
        const settled = await Promise.allSettled(runnable.map(id => this.runNode(id, ctx, plan)))
        const failure = settled.find((s): s is PromiseRejectedResult => s.status === "rejected")
        if (failure) throw failure.reason
      }

      // flow.wait suspended this execution — checkpoint and stop processing.
      // Unconditional: without it a wait loses everything before it.
      if (ctx.status === "waiting") {
        await this.store.saveContext(ctx)
        return "suspended"
      }

      this.emit({ type: "stage:completed", executionId: ctx.executionId, stage: i })

      if (this.opts.checkpoint) await this.store.saveContext(ctx)
    }
    return "ended"
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
      flowId:      ctx.flowId,
      respond:     ctx.responseHandle?.resolve,
      actor:       ctx.actor,
      dryRun:      ctx.dryRun,
      writes:      ctx.writes,
    })

    state.endedAt  = Date.now()
    state.attempts = outcome.attempts
    state.logs     = logs

    if (outcome.ok) {
      // flow.wait sentinel — node signals the execution should suspend
      const data = outcome.data as Record<string, unknown> | null
      if (data && typeof data === "object" && data["__orion_wait"] === true) {
        ctx.status    = "waiting"
        ctx.waitingOn = nodeId
        state.status  = "completed"
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

      // The node never ran — no implementation, or config that did not resolve —
      // so no error edge is an answer to it, and the flow stops.
      if (!outcome.routable) throw new Error(`Node "${nodeId}" could not run: ${outcome.error}`)

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
    actor:          job.actor,           // transient — stripped on serialize
  }
}

// A model node writes one row, so what a run has written is how many of them
// completed.
function writesIn(ctx: ExecutionContext, plan: ExecutionPlan): number {
  let used = 0
  for (const [id, state] of Object.entries(ctx.nodeStates)) {
    if (state.status === "completed" && plan.nodes[id]?.type.startsWith("model.")) used++
  }
  return used
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
