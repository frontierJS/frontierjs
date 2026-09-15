/*
 * store.ts
 *
 * The engine's `IExecutionStore` over the host's litestone client, writing the
 * `Run` and `RunStep` models in `db/orion.lite`.
 *
 * Two writes and no others, because the checkpoint is the engine's hot path
 * (`README.md` § The engine is written for speed):
 *
 *   saveContext — once per stage, one `run.update` of the context and the
 *                 stage cursor. Status rides along only when it changed. A
 *                 checkpoint that suspends the run writes its `Wait` row in the
 *                 same transaction, so a resume key exists exactly while its
 *                 run is waiting.
 *   saveRecord  — once when the run ends, one transaction: the run's terminal
 *                 status, the context cleared, and a `RunStep` row per node.
 *
 * And the two ways a wait ends, each of which CONSUMES the `Wait` row inside its
 * own transaction, so a resume and a timeout racing for one run cannot both
 * win: `resume` moves the run back to running with the payload in its context,
 * `expire` ends it failed.
 *
 * The client handed in is the SYSTEM client. Run and RunStep are written at
 * gate 8 and nothing but the engine writes them; the principal a run acts as
 * reaches the nodes that touch the app's data, never this file.
 *
 * `asSystem()` does not consult `@@transitions`, so the status moves this file
 * makes are held to the declaration by `tests/store.test.ts` and by nothing at
 * runtime.
 */

import { buildRecord } from "./engine/runtime"
import { tagKey } from "./tenancy"
import type {
  IExecutionStore, ExecutionContext, ExecutionRecord, ExecutionStatus, NodeExecutionState,
} from "./engine/runtime"

// ─── the client ──────────────────────────────────────────────────────────────

// The calls this file makes, stated so the store needs no import of litestone.
// A litestone client is a Proxy whose tables no static type here can see.
export interface OrionTable {
  findFirst(args: object): Promise<any>
  findMany(args: object): Promise<any[]>
  count(args: object): Promise<number>
  create(args: object): Promise<any>
  update(args: object): Promise<any>
  delete(args: object): Promise<any>
  deleteMany(args: object): Promise<{ count: number }>
  createMany(args: { data: object[] }): Promise<{ count: number }>
}

export interface OrionSystemClient {
  flow:        OrionTable
  flowVersion: OrionTable
  run:         OrionTable
  runStep:     OrionTable
  wait:        OrionTable
  kvEntry:     OrionTable
  $transaction<T>(fn: (tx: OrionSystemClient) => Promise<T>): Promise<T>
}

// ─── the store ───────────────────────────────────────────────────────────────

const TERMINAL = new Set<ExecutionStatus>(["completed", "failed", "cancelled"])

// What the context column holds. Everything else a context carries is a column
// of its own, and re-encrypting a column that did not change is the cost this
// shape avoids.
interface Checkpoint {
  nodes:      Record<string, unknown>
  nodeStates: Record<string, NodeExecutionState>
  waitingOn?: string
}

// What a flow.wait node answers. The key, the deadline and where the resume
// payload lands are read back off the waiting node's own output.
export interface WaitSentinel {
  __orion_wait: true
  resumeKey:    string
  event:        string
  timeoutAt:    number | null
  into:         string
}

export class LitestoneExecutionStore implements IExecutionStore {
  // The status this process last wrote per run, so a checkpoint that did not
  // move the status does not write it. Forgotten when a run suspends or ends:
  // a run resumed elsewhere writes its status on its first checkpoint.
  private readonly written = new Map<string, ExecutionStatus>()

  // `tenant` is the tenant this client serves, which a resume key carries
  // (`src/tenancy.ts`).
  constructor(private readonly db: OrionSystemClient, private readonly opts: { tenant?: string | null } = {}) {}

  async saveContext(ctx: ExecutionContext): Promise<void> {
    const status = persisted(ctx.status)
    const checkpoint: Checkpoint = { nodes: ctx.nodes, nodeStates: ctx.nodeStates, waitingOn: ctx.waitingOn }
    const data: Record<string, unknown> = { context: checkpoint, currentStage: ctx.currentStage }

    if (this.written.get(ctx.executionId) !== status) {
      data.status    = status
      data.startedAt = iso(ctx.startedAt)
    }

    // `select: false` skips RETURNING. Without it every checkpoint parses (and
    // decrypts) the context it just wrote, which is most of what one costs.
    if (status === "waiting") {
      const wait = ctx.waitingOn ? ctx.nodeStates[ctx.waitingOn]?.output as WaitSentinel | undefined : undefined
      if (!wait?.resumeKey) throw new Error(`Run "${ctx.executionId}" suspended with no flow.wait output to resume it by`)
      // Into the checkpoint as well as the row, since the context is serialized
      // below and a step's output is where a flow reads the key from.
      wait.resumeKey = tagKey(this.opts.tenant ?? null, wait.resumeKey)
      await this.db.$transaction(async (tx) => {
        await tx.run.update({ where: { id: ctx.executionId }, data, select: false })
        await tx.wait.create({
          select: false,
          data:   {
            resumeKey: wait.resumeKey,
            runId:     ctx.executionId,
            nodeId:    ctx.waitingOn,
            timeoutAt: wait.timeoutAt === null ? null : iso(wait.timeoutAt),
          },
        })
      })
    } else {
      await this.db.run.update({ where: { id: ctx.executionId }, data, select: false })
    }

    if (status === "waiting") this.written.delete(ctx.executionId)
    else this.written.set(ctx.executionId, status)
  }

  async getContext(executionId: string): Promise<ExecutionContext | undefined> {
    const run = await this.db.run.findFirst({
      where:   { id: executionId },
      include: { flowVersion: { select: { flowId: true, version: true } } },
    })
    if (!run?.context) return undefined

    const checkpoint = run.context as Checkpoint
    return {
      executionId,
      flowId:       run.flowVersion.flowId,
      version:      String(run.flowVersion.version),
      trigger:      run.trigger,
      nodes:        checkpoint.nodes,
      nodeStates:   checkpoint.nodeStates,
      status:       run.status,
      startedAt:    ms(run.startedAt) ?? Date.now(),
      currentStage: run.currentStage,
      waitingOn:    checkpoint.waitingOn,
    }
  }

  async saveRecord(record: ExecutionRecord): Promise<void> {
    // One transaction, so a crash between the two leaves the run resumable
    // rather than ended with no history, or with history and a live context.
    await this.db.$transaction((tx) => this.writeTerminal(tx, record))
    this.written.delete(record.executionId)
  }

  private async writeTerminal(tx: OrionSystemClient, record: ExecutionRecord): Promise<void> {
    const steps = Object.entries(record.nodeStates).map(([nodeId, s]) => ({
      runId:      record.executionId,
      nodeId,
      status:     s.status,
      attempts:   s.attempts,
      fromCache:  s.fromCache,
      startedAt:  s.startedAt ? iso(s.startedAt) : null,
      durationMs: s.startedAt && s.endedAt ? s.endedAt - s.startedAt : null,
      output:     s.output ?? null,
      error:      s.error ?? null,
      logs:       s.logs.length > 0 ? s.logs : null,
    }))

    await tx.run.update({
      select: false,
      where:  { id: record.executionId },
      data:   {
        status:    record.status,
        startedAt: iso(record.startedAt),
        endedAt:   iso(record.endedAt),
        error:     record.error ?? null,
        context:   null,
      },
    })
    if (steps.length > 0) await tx.runStep.createMany({ data: steps })
  }

  async resume(resumeKey: string, payload: unknown): Promise<ExecutionContext | undefined> {
    const wait = await this.db.wait.findFirst({ where: { resumeKey } })
    if (!wait) return undefined
    const ctx = await this.getContext(wait.runId)
    if (!ctx || ctx.status !== "waiting" || ctx.waitingOn !== wait.nodeId) return undefined

    const sentinel = ctx.nodeStates[wait.nodeId]?.output as WaitSentinel
    ctx.nodes[sentinel.into] = payload
    ctx.waitingOn    = undefined
    ctx.status       = "running"
    // Every node in the waiting stage settled before the run suspended.
    ctx.currentStage = ctx.currentStage + 1

    const consumed = await this.db.$transaction(async (tx) => {
      const { count } = await tx.wait.deleteMany({ where: { resumeKey } })
      if (count === 0) return false
      await tx.run.update({
        select: false,
        where:  { id: ctx.executionId },
        data:   {
          status:       "running",
          currentStage: ctx.currentStage,
          context:      { nodes: ctx.nodes, nodeStates: ctx.nodeStates } satisfies Checkpoint,
        },
      })
      return true
    })
    if (!consumed) return undefined
    this.written.set(ctx.executionId, "running")
    return ctx
  }

  async expire(resumeKey: string, now: number): Promise<boolean> {
    const wait = await this.db.wait.findFirst({ where: { resumeKey } })
    if (!wait) return false
    const ctx = await this.getContext(wait.runId)
    if (!ctx) return false

    const sentinel = ctx.nodeStates[wait.nodeId]?.output as WaitSentinel | undefined
    ctx.status  = "failed"
    ctx.endedAt = now
    ctx.error   = `flow.wait "${sentinel?.event ?? wait.nodeId}" timed out`
    const record = buildRecord(ctx)

    const expired = await this.db.$transaction(async (tx) => {
      const { count } = await tx.wait.deleteMany({ where: { resumeKey } })
      if (count === 0) return false
      await this.writeTerminal(tx, record)
      return true
    })
    this.written.delete(ctx.executionId)
    return expired
  }

  /**
   * Ends a waiting run as cancelled. Its `Wait` rows are consumed in the same
   * transaction, so a cancel and a resume or a deadline cannot both win: false
   * when one of them got there first, or the run is not waiting.
   */
  async cancel(runId: string, now: number, reason: string): Promise<boolean> {
    const ctx = await this.getContext(runId)
    if (!ctx || ctx.status !== "waiting") return false
    const record = buildRecord({ ...ctx, status: "cancelled", endedAt: now, error: reason })

    const cancelled = await this.db.$transaction(async (tx) => {
      const { count } = await tx.wait.deleteMany({ where: { runId } })
      if (count === 0) return false
      await this.writeTerminal(tx, record)
      return true
    })
    this.written.delete(runId)
    return cancelled
  }

  async getRecord(executionId: string): Promise<ExecutionRecord | undefined> {
    const run = await this.db.run.findFirst({
      where:   { id: executionId },
      include: { flowVersion: { select: { flowId: true, version: true } }, steps: true },
    })
    if (!run || !TERMINAL.has(run.status)) return undefined

    const nodeStates: Record<string, NodeExecutionState> = {}
    const nodes:      Record<string, unknown> = {}
    for (const step of run.steps) {
      const startedAt = ms(step.startedAt)
      nodeStates[step.nodeId] = {
        status:    step.status,
        attempts:  step.attempts,
        fromCache: step.fromCache,
        startedAt,
        endedAt:   startedAt !== undefined && step.durationMs !== null ? startedAt + step.durationMs : undefined,
        output:    step.output ?? undefined,
        error:     step.error ?? undefined,
        logs:      step.logs ?? [],
      }
      if (step.output !== null) nodes[step.nodeId] = step.output
    }

    // `finalContext` is rebuilt from the steps' outputs, so an edge transform's
    // rewrite of a node's value — held only in the context, which the terminal
    // write cleared — is not in it.
    return buildRecord({
      executionId,
      flowId:       run.flowVersion.flowId,
      version:      String(run.flowVersion.version),
      trigger:      run.trigger,
      nodes,
      nodeStates,
      status:       run.status,
      startedAt:    ms(run.startedAt) ?? 0,
      endedAt:      ms(run.endedAt),
      currentStage: run.currentStage,
      error:        run.error ?? undefined,
    })
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

// `resuming` lives for the instant between loading a context and running it.
function persisted(status: ExecutionStatus): ExecutionStatus {
  return status === "resuming" ? "running" : status
}

function iso(at: number): string {
  return new Date(at).toISOString()
}

function ms(at: string | null | undefined): number | undefined {
  return at ? Date.parse(at) : undefined
}
