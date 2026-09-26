/*
 * runner.ts
 *
 * Runs flows on the host's queue: a run is ONE Caravan job (`IDEAS/orion-port.md`
 * § Execution). This file is what turns a flow row into a `Run` row and a job,
 * and a job back into the engine's `Scheduler`.
 *
 *   start(flowId, trigger)  → a pending Run, and `orion.run` dispatched under
 *                             `run:<runId>` as the flow's owner (`FJS-D276`)
 *   the `orion.run` job     → resume from the checkpoint if there is one,
 *                             otherwise start at stage 0
 *   resume(key, payload)    → `orion.run` under `resume:<key>`, so a replayed
 *                             key is a dispatch Caravan already has
 *   activate(flowId)        → the active version's triggers: cron as Caravan
 *                             schedules, model, webhook and event in the indexes
 *   the `orion.sweep` job   → each minute, in every tenant: expire waits past
 *                             their deadline, re-dispatch a run whose dispatch
 *                             was lost, and dispatch an inline run whose
 *                             process stopped
 *
 * Every entry point names a TENANT (`FJS-D294`, `src/tenancy.ts`): null for a
 * host with none. A run's job carries its tenant and Caravan re-enters it, a
 * resume key carries it, and an activation records it, so a trigger starts a
 * flow where the flow is.
 *
 * A crash anywhere is recovered by the queue and not by this file. Caravan
 * reclaims a job whose instance stopped heartbeating, and the job reads the
 * checkpoint, so a stage runs at least once and a finished stage does not run
 * again.
 */

import { Compiler, type IPluginRegistry } from "./engine/compiler"
import { InMemoryExecutionStore, InMemoryPlanCache, Scheduler, buildRecord, type ExecutionContext } from "./engine/runtime"
import type { INodeRegistry } from "./engine/executor"
import type { NodeTypeDescriptor } from "./engine/plugins"
import { AsyncLocalStorage } from "node:async_hooks"
import type { ExecutionPlan, Expression, Flow, NodeDefinition } from "./engine/types"
import type { SyncHttpResponse } from "./engine/runtime/context"
import type { HostCatalog } from "./engine/ports"
import { LitestoneExecutionStore, type OrionSystemClient } from "./store"
import { tenantOfKey, withSystem, type OrionHost } from "./tenancy"

// ─── the queue ───────────────────────────────────────────────────────────────

// The Caravan calls this file makes, stated so orion needs no import of it.
export interface OrionJob<T> {
  id:        string
  data:      T
  actorId:   string | null
  tenantId?: string | null
  attempts:  number
}

export interface OrionJobs {
  handle<T>(name: string, handler: (job: OrionJob<T>) => Promise<void>, opts?: { queue?: string; maxAttempts?: number; cron?: string }): void
  dispatch<T>(name: string, data: T, opts?: { id?: string; actor?: string | null; tenant?: string | null; queue?: string }): Promise<string>
  schedule(name: string, cron: string, handler: (job: OrionJob<unknown>) => Promise<void>, opts?: { queue?: string; timeZone?: string }): void
  unschedule(name: string): boolean
}

export const RUN_JOB   = "orion.run"
export const SWEEP_JOB = "orion.sweep"

interface RunJobData { runId: string; resumeKey?: string; payload?: unknown }

export interface Activation {
  cron:     string[]
  models:   string[]
  webhooks: string[]
  events:   string[]
}

// What `onWrite` reads off litestone's `$tapEvents`.
export interface WriteEventLike {
  event:       string
  model:       string
  result?:     unknown
  record?:     unknown
  transition?: string
}

// One URL segment, so a path can never reach another route.
const WEBHOOK_PATH = /^[A-Za-z0-9_-]{1,120}$/

// Which run, if any, the code on this call stack is part of. Read by `onWrite`.
const insideRun = new AsyncLocalStorage<string>()

// ─── errors ──────────────────────────────────────────────────────────────────

export class FlowRateLimitedError extends Error {
  constructor(readonly flowId: string, readonly limit: number) {
    super(`Flow "${flowId}" has started ${limit} runs in the last minute, its limit`)
    this.name = "FlowRateLimitedError"
  }
}

export class FlowNotRunnableError extends Error {
  constructor(readonly flowId: string, reason: string) {
    super(`Flow "${flowId}" cannot run: ${reason}`)
    this.name = "FlowNotRunnableError"
  }
}

// ─── the runner ──────────────────────────────────────────────────────────────

export interface RunnerOptions {
  /** Where orion's rows are, per tenant (`src/tenancy.ts`). Orion's models are written at gate 8. */
  host:     OrionHost
  jobs:     OrionJobs
  /**
   * The node types a flow may use, and their implementations.
   *
   * `descriptors()` is here rather than on the compiler's interface because
   * the compiler never asks: it is the CATALOG, which a screen reads to offer
   * a node and to build that node's form from its `configSchema`.
   */
  registry: IPluginRegistry & INodeRegistry & { descriptors(): NodeTypeDescriptor[] }
  /** What the app has — models, jobs, notifications — so a node naming one is checked when its flow compiles. */
  catalog?: HostCatalog
  /**
   * Runs `fn` as the owner a run recorded (`FJS-D276`), in its tenant — for a
   * litestone host, `fn` is handed a client scoped to that principal. Asked on
   * every attempt, so a demoted owner's standing is the one the run gets. A
   * throw fails the run by name rather than running it as nobody. The actor is
   * valid only while `fn` runs.
   */
  withActor?: <T>(actorId: string | null, tenant: string | null, fn: (actor: unknown) => Promise<T>) => Promise<T>
  /**
   * Runs `fn` with the actor its writes go through bound to one transaction,
   * for a dry run to roll back. Default: the actor is itself a client with
   * `$transaction`, which a litestone host's is.
   */
  inTransaction?: <T>(actor: unknown, fn: (txActor: unknown) => Promise<T>) => Promise<T>
  /**
   * A written row as the actor may read it, or null (`FJS-D295`). A model trigger
   * starts its flow with the row as the flow's OWNER reads it, and not at all
   * when the owner may not read it: the run acts as the owner, and its trigger is
   * read back by the owner. Without it the trigger is the row as its writer read
   * it, which is every column the writer could see.
   */
  readAs?: (actor: unknown, model: string, record: unknown) => Promise<unknown | null>
  /** The Caravan queue runs go on. Default: `orion`. */
  queue?:   string
  /** How long a pending run may sit before the sweep dispatches it again. Default: 60s. */
  lostAfter?: number
  /** A trigger that could not start its flow — an Observer, so it cannot refuse the write. */
  onTriggerError?: (err: unknown, at: { flowId: string; trigger: unknown }) => void
  /**
   * An active flow whose triggers could not be registered — an Observer. Told
   * once per version, not on every pass of `watch`.
   */
  onActivationError?: (flowId: string, error: string) => void
  now?:     () => number
}

// Where a tenant is named by a caller. Absent is the host with no tenancy.
export interface InTenant { tenant?: string | null }

export function createRunner(opts: RunnerOptions) {
  const { host, jobs, registry } = opts
  const queue     = opts.queue ?? "orion"
  const lostAfter = opts.lostAfter ?? 60_000
  const now       = opts.now ?? Date.now
  const withActor = opts.withActor ?? (<T>(_: string | null, __: string | null, fn: (actor: unknown) => Promise<T>) => fn(undefined))

  const plans     = new InMemoryPlanCache()
  const compiler  = new Compiler(registry, opts.catalog)

  // What each flow registered — keyed by flow id, which is unique across
  // tenants — and the version each refusal was for, which `syncActivations`
  // compares the rows against.
  const activations = new Map<string, { tenant: string | null; version: number; triggers: Activation }>()
  const refusedAt   = new Map<string, number>()
  const byModel     = new Map<string, Map<string, { on: Set<string> | null; tenant: string | null }>>()
  const byPath      = new Map<string, { flowId: string; mode: "async" | "sync"; tenant: string | null }>()
  const byEvent     = new Map<string, Map<string, string | null>>()

  // A FlowVersion is immutable, so a plan compiled once is good for its life.
  function planFor(flowId: string, version: { version: number; definition: unknown }): ExecutionPlan {
    const key    = String(version.version)
    const cached = plans.get(flowId, key)
    if (cached) return cached

    const flow   = { ...(version.definition as Flow), id: flowId, version: key }
    const result = compiler.compile(flow)
    if (!result.ok) {
      throw new FlowNotRunnableError(flowId, result.errors.map(e => e.message).join("; "))
    }
    plans.set(flowId, key, result.plan)
    return result.plan
  }

  async function activeVersion(db: OrionSystemClient, flowId: string) {
    const flow = await db.flow.findFirst({ where: { id: flowId } })
    if (!flow) throw new FlowNotRunnableError(flowId, "no such flow")
    // `paused` is the kill switch every trigger reads (`FJS-D283`).
    if (flow.status !== "active") throw new FlowNotRunnableError(flowId, `it is ${flow.status}`)
    if (flow.currentVersion === null) throw new FlowNotRunnableError(flowId, "it has no current version")

    const version = await db.flowVersion.findFirst({ where: { flowId, version: flow.currentVersion } })
    if (!version) throw new FlowNotRunnableError(flowId, `version ${flow.currentVersion} does not exist`)
    return { flow, version }
  }

  // ─── starting a run ────────────────────────────────────────────────────────

  /**
   * A pending Run and its job. `id` makes a trigger idempotent: a trigger that
   * holds an id for its own delivery states it, and a second start under it
   * answers the run the first one made. `via` names the trigger node type the
   * active version must declare, so a flow is started only the ways its author
   * said it may be.
   */
  async function start(flowId: string, trigger: unknown, startOpts: { id?: string; via?: string } & InTenant = {}): Promise<string> {
    const tenant = startOpts.tenant ?? null
    const { runId, ownerId } = await withSystem(host, tenant, async (db) => {
      const { flow, version } = await activeVersion(db, flowId)
      planFor(flowId, version)
      if (startOpts.via && !Object.values((version.definition as Flow).nodes ?? {}).some(n => n.type === startOpts.via)) {
        throw new FlowNotRunnableError(flowId, `it has no ${startOpts.via} node`)
      }

      await admit(db, flowId, flow)

      const data = { flowVersionId: version.id, trigger, actorId: flow.ownerId }
      if (startOpts.id === undefined) return { runId: (await db.run.create({ data })).id as string, ownerId: flow.ownerId }
      // Two deliveries of one trigger race here, and the loser's insert is the
      // run the winner already made.
      try { await db.run.create({ data: { id: startOpts.id, ...data } }) } catch (err) {
        if ((err as Error).name !== "UniqueConflictError") throw err
      }
      return { runId: startOpts.id, ownerId: flow.ownerId }
    })

    await dispatchRun(runId, ownerId, tenant)
    return runId
  }

  // Counted, not reserved: two triggers arriving together can both pass one
  // slot. The limit bounds a runaway, not an exact budget.
  async function admit(db: OrionSystemClient, flowId: string, flow: { runsPerMinute: number | null }) {
    if (flow.runsPerMinute === null) return
    const recent = await db.run.count({
      where: { flowVersion: { is: { flowId } }, createdAt: { gte: new Date(now() - 60_000).toISOString() } },
    })
    if (recent >= flow.runsPerMinute) throw new FlowRateLimitedError(flowId, flow.runsPerMinute)
  }

  function dispatchRun(runId: string, ownerId: string, tenant: string | null) {
    return jobs.dispatch<RunJobData>(RUN_JOB, { runId }, { id: `run:${runId}`, actor: ownerId, tenant, queue })
  }

  // ─── the run job ───────────────────────────────────────────────────────────

  async function runJob(job: OrionJob<RunJobData>): Promise<void> {
    const tenant = job.tenantId ?? null
    await withSystem(host, tenant, async (db) => {
      const { runId, resumeKey } = job.data
      const store = new LitestoneExecutionStore(db, { tenant })
      const run = await db.run.findFirst({
        where:   { id: runId },
        include: { flowVersion: { select: { flowId: true, version: true, definition: true, flow: { select: { status: true, maxWrites: true } } } } },
      })
      if (!run || ["completed", "failed", "cancelled"].includes(run.status)) return

      const plan = planFor(run.flowVersion.flowId, run.flowVersion)
      const flow = run.flowVersion.flow

      // The kill switch is read again here, because a run queued or reclaimed
      // before a pause would otherwise run after it (`FJS-D283`). A waiting run is
      // left waiting, to resume if the flow is activated again.
      if (flow.status !== "active") {
        if (run.status === "waiting") return
        await endUnrun(store, run, plan.version, await store.getContext(runId), "cancelled", `the flow is ${flow.status}`)
        return
      }

      let resumeFrom: ExecutionContext | undefined
      if (resumeKey) {
        // Consumed here, or by an earlier attempt of THIS job that crashed after
        // its transaction, in which case the checkpoint already carries the
        // payload. A first attempt finding the key consumed is somebody else's
        // resume, and running from the checkpoint would run the run twice.
        resumeFrom = await store.resume(resumeKey, job.data.payload)
          ?? (job.attempts > 1 && run.status === "running" ? await store.getContext(runId) : undefined)
        if (!resumeFrom) return
      } else {
        // A waiting run is resumed by its key and nothing else.
        if (run.status === "waiting") return
        resumeFrom = await store.getContext(runId)
      }

      // An inline run whose process stopped is this job's now, and the sweep stops
      // counting it as lost.
      if (run.heartbeatAt !== null) {
        await db.run.update({ where: { id: runId }, data: { heartbeatAt: null }, select: false })
      }

      const scheduler = new Scheduler(plans, store, registry, undefined, { checkpoint: true })
      let entered = false
      try {
        await withActor(run.actorId, tenant, (actor) => {
          entered = true
          return insideRun.run(runId, () => scheduler.processJob({
            executionId: runId,
            flowId:      run.flowVersion.flowId,
            version:     plan.version,
            trigger:     run.trigger,
            resumeFrom,
            actor,
            maxWrites: flow.maxWrites,
          }))
        })
      } catch (err) {
        // A failure inside the run is the scheduler's to record; one before it is
        // the owner who could not be acted as.
        if (entered) throw err
        await endUnrun(store, run, plan.version, resumeFrom, "failed", `could not act as "${run.actorId}": ${(err as Error).message}`)
      }
    })
  }

  // A run the job will not run still ends with a record, so it is not left
  // pending for the sweep to dispatch again forever.
  async function endUnrun(store: LitestoneExecutionStore, run: any, version: string, from: ExecutionContext | undefined, status: "failed" | "cancelled", error: string) {
    const at  = now()
    const ctx: ExecutionContext = from ?? {
      executionId: run.id, flowId: run.flowVersion.flowId, version, trigger: run.trigger,
      nodes: {}, nodeStates: {}, status: "pending", startedAt: at, currentStage: 0,
    }
    await store.saveRecord(buildRecord({ ...ctx, status, endedAt: at, error }))
  }

  // ─── resuming a wait ───────────────────────────────────────────────────────

  /**
   * Hands a payload to the run waiting on `resumeKey`. False when no run is
   * waiting on it — never used, already used, or expired. A key used twice
   * dispatches under the same job id and runs nothing the second time. The
   * tenant is read off the key, which is the only thing a resume carries.
   */
  async function resume(resumeKey: string, payload: unknown): Promise<boolean> {
    const tenant = tenantOfKey(resumeKey)
    const wait = await withSystem(host, tenant, (db) => db.wait.findFirst({
      where:   { resumeKey },
      include: { run: { select: { actorId: true, flowVersion: { select: { flow: { select: { id: true, status: true } } } } } } },
    }))
    if (!wait) return false
    if (wait.run.flowVersion.flow.status !== "active") {
      throw new FlowNotRunnableError(wait.run.flowVersion.flow.id, `it is ${wait.run.flowVersion.flow.status}, so run "${wait.runId}" stays waiting`)
    }
    await jobs.dispatch(RUN_JOB, { runId: wait.runId, resumeKey, payload }, {
      id:    `resume:${resumeKey}`,
      actor: wait.run.actorId,
      tenant,
      queue,
    })
    return true
  }

  // ─── a dry run ─────────────────────────────────────────────────────────────

  /**
   * Runs a version of a flow as its owner inside a transaction that is rolled
   * back, with every effect outside that transaction recorded rather than made
   * (`FJS-D283`). No Run row is written; the answer is the record and the list
   * of what was not sent. A draft runs as readily as an active flow — trying
   * one before activating it is what this is for.
   */
  async function dryRun(flowId: string, trigger: unknown, dryOpts: { version?: number } & InTenant = {}) {
    const tenant = dryOpts.tenant ?? null
    const { flow, plan } = await withSystem(host, tenant, async (db) => {
      const flow = await db.flow.findFirst({ where: { id: flowId } })
      if (!flow) throw new FlowNotRunnableError(flowId, "no such flow")
      const number  = dryOpts.version ?? flow.currentVersion
      const version = number === null ? null : await db.flowVersion.findFirst({ where: { flowId, version: number } })
      if (!version) throw new FlowNotRunnableError(flowId, `version ${number} does not exist`)
      return { flow, plan: planFor(flowId, version) }
    })

    const inTransaction = opts.inTransaction ?? (<T>(a: unknown, fn: (tx: unknown) => Promise<T>) => {
      const client = a as { $transaction?: (fn: (tx: unknown) => Promise<T>) => Promise<T> } | undefined
      if (!client?.$transaction) throw new Error("A dry run needs an actor that can open a transaction, or RunnerOptions.inTransaction")
      return client.$transaction(fn)
    })

    const dry = new Scheduler(plans, new InMemoryExecutionStore(), registry, undefined, { checkpoint: false })
    const rollback = Symbol("dry run")
    let record!: Awaited<ReturnType<Scheduler["processJob"]>>
    try {
      await withActor(flow.ownerId, tenant, (actor) => inTransaction(actor, async (tx) => {
        record = await insideRun.run("dry", () => dry.processJob({
          executionId: `dry:${crypto.randomUUID()}`,
          flowId, version: plan.version, trigger,
          actor: tx, dryRun: true, maxWrites: flow.maxWrites,
        }))
        throw rollback
      }))
    } catch (err) {
      if (err !== rollback) throw err
    }

    const notSent = Object.entries(record.nodeStates)
      .filter(([, state]) => (state.output as { dryRun?: boolean } | undefined)?.dryRun === true)
      .map(([nodeId, state]) => ({ nodeId, ...(state.output as { wouldSend: object }).wouldSend }))
    return { record, notSent }
  }

  // ─── activation ──────────────────────────────────────────────────────────

  /**
   * Registers every trigger of a flow's current version, replacing what it had:
   * its cron schedules with Caravan, and its model, webhook and event triggers in
   * the indexes the triggers answer from. A flow that is not active is
   * deactivated and answers null; one whose version does not compile, or whose
   * webhook path another flow holds, is refused by name.
   *
   * What it registers is this process's alone. Every other instance finds the
   * change on its next `syncActivations`, which `watch` runs on a timer
   * (`FJS-1155`).
   */
  async function activate(flowId: string, activateOpts: InTenant = {}): Promise<Activation | null> {
    const tenant = activateOpts.tenant ?? null
    deactivate(flowId)
    let found
    try { found = await withSystem(host, tenant, (db) => activeVersion(db, flowId)) } catch (err) {
      if (err instanceof FlowNotRunnableError) return null
      throw err
    }
    planFor(flowId, found.version)

    const triggers: Activation = { cron: [], models: [], webhooks: [], events: [] }
    const definition = found.version.definition as Flow
    const entry = { tenant, version: found.flow.currentVersion as number, triggers }
    try {
      for (const node of Object.values(definition.nodes ?? {})) {
        if (node.type === "trigger.cron")    activateCron(flowId, tenant, node, triggers)
        if (node.type === "trigger.model")   activateModel(flowId, tenant, node, triggers)
        if (node.type === "trigger.webhook") activateWebhook(flowId, tenant, node, triggers)
        if (node.type === "trigger.event")   activateEvent(flowId, tenant, node, triggers)
      }
    } catch (err) {
      activations.set(flowId, entry)
      unregister(flowId, false)
      throw err
    }
    activations.set(flowId, entry)
    refusedAt.delete(flowId)
    return triggers
  }

  function activateCron(flowId: string, tenant: string | null, node: NodeDefinition, into: Activation) {
    const expression = literal(node.config.expression)
    const timezone   = literal(node.config.timezone)
    if (typeof expression !== "string") {
      throw new FlowNotRunnableError(flowId, `cron trigger "${node.id}" needs its expression written as a literal`)
    }
    const name = `orion.cron:${flowId}:${node.id}`
    // The fire's own job id names the minute, so a retried fire starts the run
    // it already started.
    jobs.schedule(name, expression, async (fire) => {
      await start(flowId, { cron: expression, firedAt: now() }, { id: fire.id, tenant })
    }, { queue, ...(typeof timezone === "string" ? { timeZone: timezone } : {}) })
    into.cron.push(name)
  }

  function activateModel(flowId: string, tenant: string | null, node: NodeDefinition, into: Activation) {
    const model = literal(node.config.model)
    const on    = literal(node.config.on)
    if (typeof model !== "string") {
      throw new FlowNotRunnableError(flowId, `model trigger "${node.id}" needs its model written as a literal`)
    }
    if (opts.catalog?.models && !opts.catalog.models.fields(model, "update")) {
      throw new FlowNotRunnableError(flowId, `model trigger "${node.id}" names "${model}", which this app does not have`)
    }
    const flows = byModel.get(model) ?? new Map()
    flows.set(flowId, { on: Array.isArray(on) ? new Set(on.map(String)) : null, tenant })
    byModel.set(model, flows)
    into.models.push(model)
  }

  // A path is one namespace across the whole host, so a webhook URL names one
  // flow however the request's tenant is resolved.
  function activateWebhook(flowId: string, tenant: string | null, node: NodeDefinition, into: Activation) {
    const path = literal(node.config.path)
    const mode = literal(node.config.mode) === "sync" ? "sync" : "async"
    if (typeof path !== "string" || !WEBHOOK_PATH.test(path)) {
      throw new FlowNotRunnableError(flowId, `webhook trigger "${node.id}" needs a literal path of letters, digits, - and _`)
    }
    const holder = byPath.get(path)
    if (holder && holder.flowId !== flowId) {
      throw new FlowNotRunnableError(flowId, `webhook path "${path}" belongs to flow "${holder.flowId}"`)
    }
    byPath.set(path, { flowId, mode, tenant })
    into.webhooks.push(path)
  }

  function activateEvent(flowId: string, tenant: string | null, node: NodeDefinition, into: Activation) {
    const name = literal(node.config.event)
    if (typeof name !== "string" || name === "") {
      throw new FlowNotRunnableError(flowId, `event trigger "${node.id}" needs its event name written as a literal`)
    }
    const flows = byEvent.get(name) ?? new Map<string, string | null>()
    flows.set(flowId, tenant)
    byEvent.set(name, flows)
    into.events.push(name)
  }

  function deactivate(flowId: string): void {
    unregister(flowId, true)
  }

  // `wasActive` is false while a partial activation is being unwound, which
  // freed nothing another flow was refused for.
  function unregister(flowId: string, wasActive: boolean): void {
    const entry = activations.get(flowId)
    if (!entry) return
    const { triggers } = entry
    for (const name of triggers.cron) jobs.unschedule(name)
    for (const model of triggers.models) {
      byModel.get(model)?.delete(flowId)
      if (byModel.get(model)?.size === 0) byModel.delete(model)
    }
    for (const path of triggers.webhooks) if (byPath.get(path)?.flowId === flowId) byPath.delete(path)
    for (const name of triggers.events) {
      byEvent.get(name)?.delete(flowId)
      if (byEvent.get(name)?.size === 0) byEvent.delete(name)
    }
    // A path an active flow held is free now, so a flow refused for wanting it
    // is worth asking again.
    if (wasActive && triggers.webhooks.length > 0) refusedAt.clear()
    activations.delete(flowId)
  }

  /**
   * Makes this process's triggers match the rows, in every tenant: a flow active
   * at a version it has not registered is activated, and one registered that is
   * no longer active at that version is deactivated. The first call is the boot;
   * later ones are how an activation made on another instance reaches this one.
   * A flow that cannot activate is reported to `onActivationError`, once per
   * version.
   *
   * A version cannot change while its flow is active, so `(id, currentVersion)`
   * is the whole of what a row can say about its triggers.
   */
  async function syncActivations(): Promise<{ activated: string[]; deactivated: string[]; refused: Array<{ flowId: string; error: string }> }> {
    const live = new Map<string, { tenant: string | null; version: number | null }>()
    for (const tenant of await host.tenants()) {
      const rows = await withSystem(host, tenant, (db) => db.flow.findMany({ where: { status: "active" }, select: { id: true, currentVersion: true } }))
      for (const row of rows) live.set(row.id, { tenant, version: row.currentVersion })
    }
    const result = { activated: [] as string[], deactivated: [] as string[], refused: [] as Array<{ flowId: string; error: string }> }

    for (const [flowId, entry] of [...activations]) {
      const row = live.get(flowId)
      if (row && row.version === entry.version && row.tenant === entry.tenant) continue
      deactivate(flowId)
      result.deactivated.push(flowId)
    }
    for (const flowId of [...refusedAt.keys()]) if (!live.has(flowId)) refusedAt.delete(flowId)

    for (const [flowId, { tenant, version }] of live) {
      if (activations.has(flowId) || version === null) continue
      if (refusedAt.get(flowId) === version) continue
      try {
        if (await activate(flowId, { tenant })) result.activated.push(flowId)
      } catch (err) {
        refusedAt.set(flowId, version)
        const error = (err as Error).message
        result.refused.push({ flowId, error })
        opts.onActivationError?.(flowId, error)
      }
    }
    return result
  }

  /**
   * Runs `syncActivations` every `everyMs` until the returned function is
   * called. One read of the active flows per tenant, per pass, per instance; a
   * pass still running when the next is due is not overlapped.
   */
  function watch(everyMs: number): () => void {
    let pass: Promise<unknown> | undefined
    const timer = setInterval(() => {
      if (pass) return
      pass = syncActivations()
        .catch((err) => opts.onActivationError?.("*", (err as Error).message))
        .finally(() => { pass = undefined })
    }, everyMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  // ─── triggers ──────────────────────────────────────────────────────────────

  /**
   * A write the host's data client announced — litestone's `$tapEvents` — in the
   * tenant whose client made it. Starts every active flow of that tenant whose
   * model trigger matches. An Observer: it runs after the write committed and
   * cannot refuse it, a flow that cannot start is reported to `onTriggerError`
   * and does not reach the writer, and a process that stops between the write
   * and the start starts nothing (`FJS-D274`).
   *
   * A write made BY a run starts no flow. A flow writing the model it is
   * triggered by would otherwise start itself for ever, bounded only by a rate
   * limit that is off by default.
   */
  function onWrite(event: WriteEventLike, writeOpts: InTenant = {}): void {
    if (insideRun.getStore() !== undefined) return
    const tenant = writeOpts.tenant ?? null
    const flows  = byModel.get(event.model)
    if (!flows) return
    for (const [flowId, { on, tenant: of }] of flows) {
      if (of !== tenant) continue
      if (on && !on.has(event.event)) continue
      const trigger = {
        model:      event.model,
        event:      event.event,
        record:     event.result ?? event.record ?? null,
        ...(event.transition ? { transition: event.transition } : {}),
      }
      startFromWrite(flowId, trigger, tenant).catch((err) => opts.onTriggerError?.(err, { flowId, trigger }))
    }
  }

  // The row goes into the run as its owner reads it, and a row the owner may not
  // read starts nothing (`FJS-D295`). Asked before the run exists, so a refused
  // row leaves no run behind to be read.
  async function startFromWrite(flowId: string, trigger: { model: string; record: unknown }, tenant: string | null) {
    if (!opts.readAs || trigger.record === null) return start(flowId, trigger, { tenant })
    const ownerId = await withSystem(host, tenant, async (db) =>
      (await db.flow.findFirst({ where: { id: flowId }, select: { ownerId: true } }))?.ownerId as string | undefined)
    if (!ownerId) return
    const record = await withActor(ownerId, tenant, (actor) => opts.readAs!(actor, trigger.model, trigger.record))
    if (record === null || record === undefined) return
    return start(flowId, { ...trigger, record }, { tenant })
  }

  /**
   * A named event, emitted by the app's own code (`FJS-D293`). Starts every
   * active flow of the tenant listening for `name`, each as its own owner, and
   * answers their run ids. A flow that cannot start is reported to
   * `onTriggerError` and does not stop the others.
   *
   * Unlike a model write, an emit inside a run DOES start flows: it is the one
   * way a flow chains another, and each start is bounded by its flow's
   * `runsPerMinute`.
   */
  async function emit(name: string, payload: unknown, emitOpts: InTenant = {}): Promise<string[]> {
    const tenant = emitOpts.tenant ?? null
    const runIds: string[] = []
    for (const [flowId, of] of byEvent.get(name) ?? []) {
      if (of !== tenant) continue
      const trigger = { event: name, payload: payload ?? null }
      try {
        runIds.push(await start(flowId, trigger, { tenant }))
      } catch (err) {
        opts.onTriggerError?.(err, { flowId, trigger })
      }
    }
    return runIds
  }

  /** Which flow a webhook path starts, in which tenant, and how it answers. */
  function webhook(path: string): { flowId: string; mode: "async" | "sync"; tenant: string | null } | undefined {
    return byPath.get(path)
  }

  /**
   * A run in the process that asked for it, answering with what its
   * `http.respond` node sends (`FJS-D280`). Resolves with the response, with the
   * record when the run ends having sent none, or with `timedOut` at the
   * deadline — after which the run goes on and ends on its own.
   *
   * Not a Caravan job, so no lease covers it. The run's `heartbeatAt` is
   * restamped while it executes instead, and a process that stops mid-run
   * leaves a stale one, which the sweep hands to the run job (`FJS-1156`).
   */
  async function runInline(flowId: string, trigger: unknown, inlineOpts: { deadlineMs?: number } & InTenant = {}) {
    const tenant = inlineOpts.tenant ?? null
    // Held until the run ends, which is after this function answers.
    const { db, release } = await host.open(tenant)
    let run: { id: string }
    let flow: any, plan: ExecutionPlan
    try {
      const found = await activeVersion(db, flowId)
      flow = found.flow
      plan = planFor(flowId, found.version)
      await admit(db, flowId, flow)
      run = await db.run.create({ data: { flowVersionId: found.version.id, trigger, actorId: flow.ownerId, heartbeatAt: new Date(now()).toISOString() } })
    } catch (err) {
      release()
      throw err
    }

    // A third of the window, so two missed beats still read as alive.
    const beat = setInterval(() => {
      db.run.update({ where: { id: run.id }, data: { heartbeatAt: new Date(now()).toISOString() }, select: false }).catch(() => {})
    }, Math.max(10, Math.floor(lostAfter / 3)))
    beat.unref?.()

    const scheduler = new Scheduler(plans, new LitestoneExecutionStore(db, { tenant }), registry, undefined, { checkpoint: true })
    let respond!: (res: SyncHttpResponse) => void
    const responded = new Promise<SyncHttpResponse>(r => { respond = r })
    const running = withActor(flow.ownerId, tenant, (actor) => insideRun.run(run.id, () => scheduler.processJob({
      executionId: run.id, flowId, version: plan.version, trigger,
      actor, maxWrites: flow.maxWrites,
      responseHandle: { resolve: respond, reject: () => {} },
    })))
    running.finally(() => { clearInterval(beat); release() }).catch(() => {})
    running.catch((err) => opts.onTriggerError?.(err, { flowId, trigger }))

    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<"timeout">(r => { timer = setTimeout(() => r("timeout"), inlineOpts.deadlineMs ?? 10_000) })
    const outcome = await Promise.race([
      responded.then(response => ({ response })),
      running.then(record => ({ record })),
      deadline.then(() => ({ timedOut: true as const })),
    ])
    clearTimeout(timer)
    return { runId: run.id as string, ...outcome }
  }

  // ─── the services ──────────────────────────────────────────────────────────

  /**
   * Every node type this app knows, with the schema each one's config answers.
   *
   * Read off the registry rather than off `BUILTIN_DESCRIPTORS`, because the
   * set a screen may offer is the set this app registered: a host that
   * installed a plugin has node types no import can see, and they are the ones
   * `configSchema` exists for — a built-in's form could have been written by
   * hand, a plugin's could not.
   */
  function nodeTypes(): NodeTypeDescriptor[] {
    return registry.descriptors()
  }

  /** What the compiler says of a definition, before it is saved as a version. */
  function check(definition: unknown): ReturnType<Compiler["compile"]> {
    return compiler.compile({ ...(definition as Flow), id: "check", version: "check" })
  }

  /** Ends a waiting run. False when it is not waiting, or a resume got there first. */
  function cancel(runId: string, reason: string, cancelOpts: InTenant = {}): Promise<boolean> {
    const tenant = cancelOpts.tenant ?? null
    return withSystem(host, tenant, (db) => new LitestoneExecutionStore(db, { tenant }).cancel(runId, now(), reason))
  }

  // ─── the sweep ─────────────────────────────────────────────────────────────

  /**
   * One pass over every tenant. A tenant that fails does not stop the others;
   * the first failure is rethrown once they have all been visited.
   */
  async function sweep(): Promise<{ expired: number; redispatched: number; kvExpired: number }> {
    const total = { expired: 0, redispatched: 0, kvExpired: 0 }
    let failure: unknown
    for (const tenant of await host.tenants()) {
      try {
        const one = await withSystem(host, tenant, (db) => sweepTenant(db, tenant))
        total.expired += one.expired; total.redispatched += one.redispatched; total.kvExpired += one.kvExpired
      } catch (err) {
        failure ??= err
      }
    }
    if (failure) throw failure
    return total
  }

  async function sweepTenant(db: OrionSystemClient, tenant: string | null) {
    const store = new LitestoneExecutionStore(db, { tenant })
    let expired = 0
    const due = await db.wait.findMany({ where: { timeoutAt: { lt: new Date(now()).toISOString() } } })
    for (const wait of due) if (await store.expire(wait.resumeKey, now())) expired++

    // A queued run in flight is Caravan's to reclaim, so `running` is ours only
    // when it carries a heartbeat: an inline run whose process stopped beating.
    const cutoff = new Date(now() - lostAfter).toISOString()
    const lost = await db.run.findMany({
      where: { OR: [
        { status: "pending", createdAt: { lt: cutoff }, heartbeatAt: null },
        { status: { in: ["pending", "running"] }, heartbeatAt: { lt: cutoff } },
      ] },
      select: { id: true, actorId: true },
    })
    for (const run of lost) await dispatchRun(run.id, run.actorId, tenant)

    // The window reads the CLIENT's clock, not this runner's `now`: an entry is
    // swept on the clock that already reads it as absent.
    const { count: kvExpired } = await db.kvEntry.deleteMany({ onlyExpired: true })
    return { expired, redispatched: lost.length, kvExpired }
  }

  // ─── wiring ────────────────────────────────────────────────────────────────

  /** Registers the run job and the sweep. Call before the queue starts. */
  function register(): void {
    jobs.handle<RunJobData>(RUN_JOB, runJob, { queue })
    // Stated as no tenant, because the sweep visits them all itself.
    jobs.handle(SWEEP_JOB, async () => { await sweep() }, { queue, cron: "* * * * *" })
  }

  return {
    start, resume, dryRun, runInline,
    activate, deactivate, syncActivations, watch, onWrite, webhook, emit,
    check, cancel, nodeTypes,
    sweep, register, host,
  }
}

export type Runner = ReturnType<typeof createRunner>

// A schedule is registered before any run exists, so it cannot be an expression
// over the run's data.
function literal(expr: Expression | undefined): unknown {
  return expr && expr.type === "literal" ? expr.value : undefined
}
