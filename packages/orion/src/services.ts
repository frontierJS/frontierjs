/*
 * services.ts
 *
 * Orion's API: three Junction services over orion's own models, which replace
 * the mockup's hand-rolled `api/`. Each is a model service, so a read, a create
 * and a patch are graded by `orion.lite`'s gates and row policies like any
 * other; the methods below are the verbs a row write cannot say.
 *
 *   flows            save a version · activate · pause · archive · restore
 *                    run · dryRun · versions · export · import · layout · saveLayout
 *   runs             find · get · steps · cancel · metrics
 *   flowCredentials  the derived verbs alone, at ADMINISTRATOR(5)
 *
 * Who may act on a flow is one test (`FJS-D289`, `FJS-D292`): its owner through
 * their own client, so the schema grades the write; an administrator through the
 * system client once this file has graded them; anybody else is refused. A run
 * started here acts as the flow's owner like every other (`FJS-D276`).
 *
 * The run metrics are a method on `runs` rather than a `metrics` service,
 * because `/metrics` is junction's own route.
 */

import { BadRequest, Conflict, Forbidden, NotFound, TooManyRequests, Unauthorized, createService, sessionGateLevel } from "@frontierjs/junction"
import type { Service, ServiceContext, SessionContext } from "@frontierjs/junction"
import { LEVELS, levelName, levelPasses } from "@frontierjs/toolbelt/gate"

import type { Flow } from "./engine/types"
import { FlowNotRunnableError, FlowRateLimitedError, type Runner } from "./runner"

export interface OrionServiceNames {
  flows?:           string | false
  runs?:            string | false
  flowCredentials?: string | false
}

export const DEFAULT_SERVICE_NAMES = { flows: "flows", runs: "runs", flowCredentials: "flowCredentials" } as const

// Every accessor this file reads, on the caller's client and the system's alike.
type Client = any

// What `flows.export` answers and `flows.import` accepts.
export interface FlowFile {
  orion:        1
  name:         string
  description?: string | null
  definition:   Flow
}

export function createOrionServices(deps: {
  runner: Runner
  names?: OrionServiceNames
  /** The app's own role → level mapping, which is what its Data boundary grades by. Default: `sessionGateLevel`. */
  level?: (user: SessionContext) => number
}): Service[] {
  const { runner } = deps
  const levelOf = deps.level ?? sessionGateLevel
  const names = { ...DEFAULT_SERVICE_NAMES, ...deps.names }
  const services: Service[] = []

  // ─── who is asking ─────────────────────────────────────────────────────────

  function caller(ctx: ServiceContext): SessionContext {
    const user = ctx.auth?.user as SessionContext | null | undefined
    if (!user?.userId) throw new Unauthorized("Authentication required")
    return user
  }

  const clientOf = (ctx: ServiceContext): Client => ctx.locals.db
  // The system client of THIS call's tenant: the caller's own client, lifted.
  // Under row tenancy it keeps the tenant claim, so it still reads and writes
  // one tenant's rows (`FJS-D294`).
  const systemOf = (ctx: ServiceContext): Client => clientOf(ctx).asSystem()
  const tenantOf = (ctx: ServiceContext) => ({ tenant: (ctx.locals.tenantId as string | undefined) ?? null })

  async function readableFlow(ctx: ServiceContext, id: unknown) {
    const flow = await clientOf(ctx).flow.findFirst({ where: { id } })
    if (!flow) throw new NotFound(`No flow '${id}'`)
    return flow
  }

  /**
   * The client a change to this flow is written through: the owner's own, or the
   * system's for an administrator acting on somebody else's (`FJS-D289`). A
   * refusal names both ways in.
   */
  function writerFor(ctx: ServiceContext, flow: { id: string; ownerId: string }, what: string): Client {
    const user = caller(ctx)
    if (String(flow.ownerId) === String(user.userId)) return clientOf(ctx)
    if (levelPasses(LEVELS.ADMINISTRATOR, levelOf(user))) return systemOf(ctx)
    throw new Forbidden(`Only the owner of flow '${flow.id}', or an administrator, may ${what}`)
  }

  // A definition is compiled before it is saved, and a code node needs a caller
  // who could reach the server anyway (`FJS-D272`, `FJS-D279`).
  function assertSavable(ctx: ServiceContext, definition: unknown): Flow {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      throw new BadRequest("definition must be a flow: an object with nodes and edges")
    }
    const compiled = runner.check(definition)
    if (!compiled.ok) {
      throw new BadRequest(`The flow does not compile: ${compiled.errors.map(e => e.message).join("; ")}`, { errors: compiled.errors })
    }
    const nodes = Object.values((definition as Flow).nodes ?? {})
    const level = levelOf(caller(ctx))
    if (nodes.some(n => n.type === "data.code") && !levelPasses(LEVELS.SYSADMIN, level)) {
      throw new Forbidden(`A flow with a data.code node is saved by ${levelName(LEVELS.SYSADMIN)}(${LEVELS.SYSADMIN}) and above; the caller has level ${level}`)
    }
    return definition as Flow
  }

  // Every custom method needs a session, which is what the model's read gate
  // already asks; stated, so a stranger's refusal is a declaration and not the
  // floor junction applies to a method nobody graded.
  function signedIn(...methods: string[]) {
    return methods.map(method => ({ method, gate: LEVELS.USER }))
  }

  function refusal(err: unknown): never {
    if (err instanceof FlowRateLimitedError) throw new TooManyRequests(err.message)
    if (err instanceof FlowNotRunnableError) throw new Conflict(err.message)
    throw err
  }

  // ─── flows ─────────────────────────────────────────────────────────────────

  if (names.flows !== false) services.push(createService({
    name:  names.flows,
    model: "Flow",
    methods: [
      "find", "get", "create", "patch", "remove",
      ...signedIn("save", "versions", "activate", "pause", "archive", "restore", "run", "dryRun", "export", "import", "layout", "saveLayout"),
    ],

    // A patch moving the status or the version, and a removal, reach this
    // instance's triggers now; the others catch up on their next poll.
    hooks: {
      after: {
        patch:  [async (ctx: ServiceContext) => { await resync(ctx) }],
        remove: [async (ctx: ServiceContext) => { runner.deactivate(String(ctx.id)) }],
      },
    },

    /** A new version of the definition. It becomes current unless the flow is active, which goes through pause and activate. */
    async save(ctx: ServiceContext) {
      const flow       = await readableFlow(ctx, ctx.id)
      const db         = writerFor(ctx, flow, "save a version of it")
      const definition = assertSavable(ctx, (ctx.data as { definition?: unknown } | null)?.definition)

      const system  = systemOf(ctx)
      const last    = await system.flowVersion.findFirst({ where: { flowId: flow.id }, orderBy: { version: "desc" }, select: { version: true } })
      const version = (last?.version ?? 0) + 1
      // Written as system, the version records the administrator who wrote it.
      const byOwner = String(flow.ownerId) === String(caller(ctx).userId)
      await db.flowVersion.create({ data: { flowId: flow.id, version, definition, ...(byOwner ? {} : { authorId: caller(ctx).userId }) } })

      const current = flow.status !== "active"
      if (current) await db.flow.update({ where: { id: flow.id }, data: { currentVersion: version } })
      ctx.dispatch = await system.flow.findFirst({ where: { id: flow.id } })
      return { flowId: flow.id, version, current }
    },

    /** Every version, newest first, without their definitions. */
    async versions(ctx: ServiceContext) {
      ctx.dispatch = false
      const flow = await readableFlow(ctx, ctx.id)
      return clientOf(ctx).flowVersion.findMany({
        where:   { flowId: flow.id },
        orderBy: { version: "desc" },
        select:  { id: true, version: true, authorId: true, createdAt: true },
      })
    },

    /**
     * Moves the flow to `active` — graded by the move's own `@gate(5)` on the
     * owner's client — and registers its triggers here. A version that does not
     * compile is refused before the move; a trigger that cannot register, such
     * as a webhook path another flow holds, puts the status back.
     */
    async activate(ctx: ServiceContext) {
      const flow = await readableFlow(ctx, ctx.id)
      const db   = writerFor(ctx, flow, "activate it")
      if (flow.currentVersion === null) throw new Conflict(`Flow '${flow.id}' has no version to activate; save one first`)
      const version = await systemOf(ctx).flowVersion.findFirst({ where: { flowId: flow.id, version: flow.currentVersion } })
      assertCompiles(version?.definition)

      await db.flow.transition(flow.id, "activate")
      try {
        const activation = await runner.activate(flow.id, tenantOf(ctx))
        const row        = await clientOf(ctx).flow.findFirst({ where: { id: flow.id } })
        ctx.dispatch = row
        return { ...row, activation }
      } catch (err) {
        await systemOf(ctx).flow.update({ where: { id: flow.id }, data: { status: flow.status } })
        throw new Conflict((err as Error).message)
      }
    },

    async pause(ctx: ServiceContext)   { return move(ctx, "pause",   "pause it") },
    async archive(ctx: ServiceContext) { return move(ctx, "archive", "archive it") },
    async restore(ctx: ServiceContext) { return move(ctx, "restore", "restore it") },

    /** Starts a run by hand, as the flow's owner (`FJS-D292`). The active version must declare a `trigger.manual`. */
    async run(ctx: ServiceContext) {
      ctx.dispatch = false
      const flow = await readableFlow(ctx, ctx.id)
      writerFor(ctx, flow, "run it")
      const payload = (ctx.data as { payload?: unknown } | null)?.payload ?? null
      try {
        return { runId: await runner.start(flow.id, { payload, by: caller(ctx).userId }, { via: "trigger.manual", ...tenantOf(ctx) }) }
      } catch (err) {
        refusal(err)
      }
    },

    /** Runs a version as the owner, rolled back and with nothing sent (`FJS-D283`). */
    async dryRun(ctx: ServiceContext) {
      ctx.dispatch = false
      const flow = await readableFlow(ctx, ctx.id)
      writerFor(ctx, flow, "dry-run it")
      const data = (ctx.data ?? {}) as { trigger?: unknown; version?: number }
      try {
        const { record, notSent } = await runner.dryRun(flow.id, data.trigger ?? {}, { version: data.version, ...tenantOf(ctx) })
        return { status: record.status, error: record.error ?? null, nodeStates: record.nodeStates, notSent }
      } catch (err) {
        refusal(err)
      }
    },

    /** A version as a file for review (`FJS-D277`) — the current one unless `data.version` names another. */
    async export(ctx: ServiceContext): Promise<FlowFile> {
      ctx.dispatch = false
      const flow   = await readableFlow(ctx, ctx.id)
      const number = (ctx.data as { version?: number } | null)?.version ?? flow.currentVersion
      const row    = number === null ? null : await clientOf(ctx).flowVersion.findFirst({ where: { flowId: flow.id, version: number } })
      if (!row) throw new NotFound(`Flow '${flow.id}' has no version ${number}`)
      return { orion: 1, name: flow.name, description: flow.description ?? null, definition: row.definition }
    },

    /** A file becomes a new draft flow owned by the caller, at version 1. */
    async import(ctx: ServiceContext) {
      caller(ctx)
      const file = (ctx.data ?? {}) as Partial<FlowFile>
      if (file.orion !== 1) throw new BadRequest("Not an orion flow file: expected { orion: 1, name, definition }")
      if (typeof file.name !== "string" || file.name === "") throw new BadRequest("name is required")
      const definition = assertSavable(ctx, file.definition)

      return clientOf(ctx).$transaction(async (tx: Client) => {
        const flow = await tx.flow.create({ data: { name: file.name, description: file.description ?? null } })
        await tx.flowVersion.create({ data: { flowId: flow.id, version: 1, definition } })
        return tx.flow.update({ where: { id: flow.id }, data: { currentVersion: 1 } })
      })
    },

    /** Where the builder drew each node. An empty object for a flow never laid out. */
    async layout(ctx: ServiceContext) {
      ctx.dispatch = false
      const flow = await readableFlow(ctx, ctx.id)
      const row  = await clientOf(ctx).flowLayout.findFirst({ where: { flowId: flow.id } })
      return { flowId: flow.id, layout: row?.layout ?? {} }
    },

    // The row that moved is a FlowLayout, which no subscriber to flows merges.
    async saveLayout(ctx: ServiceContext) {
      ctx.dispatch = false
      const flow   = await readableFlow(ctx, ctx.id)
      const db     = writerFor(ctx, flow, "move its layout")
      const layout = (ctx.data as { layout?: unknown } | null)?.layout
      if (!layout || typeof layout !== "object" || Array.isArray(layout)) throw new BadRequest("layout must be an object")

      const existing = await db.flowLayout.findFirst({ where: { flowId: flow.id } })
      if (existing) await db.flowLayout.update({ where: { id: existing.id }, data: { layout } })
      else          await db.flowLayout.create({ data: { flowId: flow.id, layout } })
      return { flowId: flow.id, layout }
    },
  }))

  function assertCompiles(definition: unknown) {
    const compiled = runner.check(definition)
    if (!compiled.ok) throw new Conflict(`The current version does not compile: ${compiled.errors.map(e => e.message).join("; ")}`, { errors: compiled.errors })
  }

  async function move(ctx: ServiceContext, name: "pause" | "archive" | "restore", what: string) {
    const flow = await readableFlow(ctx, ctx.id)
    await writerFor(ctx, flow, what).flow.transition(flow.id, name)
    runner.deactivate(flow.id)
    return clientOf(ctx).flow.findFirst({ where: { id: flow.id } })
  }

  async function resync(ctx: ServiceContext) {
    const data = (ctx.data ?? {}) as Record<string, unknown>
    if (!("status" in data) && !("currentVersion" in data)) return
    try {
      await runner.activate(String(ctx.id), tenantOf(ctx))
    } catch (err) {
      ctx.app?.logger?.warn?.(`[orion] flow "${ctx.id}" is active and did not activate: ${(err as Error).message}`)
    }
  }

  // ─── runs ──────────────────────────────────────────────────────────────────

  if (names.runs !== false) services.push(createService({
    name:    names.runs,
    model:   "Run",
    methods: ["find", "get", ...signedIn("steps", "cancel", "metrics")],

    /** What each node did. Written when the run ends, so a run still going has none. */
    async steps(ctx: ServiceContext) {
      ctx.dispatch = false
      const run = await clientOf(ctx).run.findFirst({ where: { id: ctx.id }, select: { id: true } })
      if (!run) throw new NotFound(`No run '${ctx.id}'`)
      return clientOf(ctx).runStep.findMany({ where: { runId: run.id }, orderBy: { startedAt: "asc" } })
    },

    /**
     * Ends a waiting run, for the flow's owner or an administrator. A run that
     * is queued or running is refused: its job would write over the
     * cancellation (`FJS-1157`). Pausing the flow stops new ones.
     */
    async cancel(ctx: ServiceContext) {
      const run = await clientOf(ctx).run.findFirst({
        where:   { id: ctx.id },
        include: { flowVersion: { select: { flow: { select: { id: true, ownerId: true } } } } },
      })
      if (!run) throw new NotFound(`No run '${ctx.id}'`)
      writerFor(ctx, run.flowVersion.flow, "cancel its runs")
      if (run.status !== "waiting") throw new Conflict(`Run '${run.id}' is ${run.status}; only a waiting run can be cancelled`)
      if (!(await runner.cancel(run.id, `cancelled by ${caller(ctx).userId}`, tenantOf(ctx)))) {
        throw new Conflict(`Run '${run.id}' is no longer waiting`)
      }
      const row = await clientOf(ctx).run.findFirst({ where: { id: run.id } })
      ctx.dispatch = row
      return row
    },

    /**
     * Runs created in the last `windowMs` (an hour by default), optionally of one
     * flow: how many in each status, the success rate over those that ended
     * completed or failed, and the mean and p95 duration of those that ended.
     */
    async metrics(ctx: ServiceContext) {
      ctx.dispatch = false
      const data     = (ctx.data ?? {}) as { flowId?: string; windowMs?: number }
      const windowMs = data.windowMs ?? 3_600_000
      if (typeof windowMs !== "number" || !(windowMs > 0)) throw new BadRequest("windowMs must be a positive number")

      const rows: Array<{ status: string; startedAt: string | null; endedAt: string | null }> = await clientOf(ctx).run.findMany({
        where:  {
          createdAt: { gte: new Date(Date.now() - windowMs).toISOString() },
          ...(data.flowId ? { flowVersion: { is: { flowId: data.flowId } } } : {}),
        },
        select: { status: true, startedAt: true, endedAt: true },
      })

      const byStatus: Record<string, number> = {}
      for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
      const decided   = (byStatus.completed ?? 0) + (byStatus.failed ?? 0)
      const durations = rows
        .filter(r => r.startedAt && r.endedAt)
        .map(r => Date.parse(r.endedAt!) - Date.parse(r.startedAt!))
        .sort((a, b) => a - b)

      return {
        flowId:        data.flowId ?? null,
        windowMs,
        totalRuns:     rows.length,
        byStatus,
        successRate:   decided === 0 ? null : (byStatus.completed ?? 0) / decided,
        avgDurationMs: durations.length === 0 ? null : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
        p95DurationMs: durations.length === 0 ? null : durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)],
      }
    },
  }))

  // ─── credentials ───────────────────────────────────────────────────────────

  // Gated at ADMINISTRATOR(5) by the model; the secret is written and never
  // read back below system.
  if (names.flowCredentials !== false) services.push(createService({
    name:  names.flowCredentials,
    model: "FlowCredential",
  }))

  return services
}
