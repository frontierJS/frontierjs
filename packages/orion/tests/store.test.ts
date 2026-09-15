/*
 * store.test.ts
 *
 * `db/orion.lite` and the litestone-backed execution store, against a real
 * litestone client built from the real file.
 *
 * Three questions. Does the schema grade access the way the rulings say
 * (`FJS-D276`, `FJS-D278`) — asked with litestone's executed verifiers, then
 * with real principals for the rules a verifier skips. Does the store keep the
 * speed rule — one statement per stage, one transaction at the end — counted
 * off the client's own query tap. And does every status it writes follow
 * `Run`'s declared `@@transitions`, which nothing at runtime checks, because
 * the store writes through `asSystem()`.
 *
 * Litestone is imported by RELATIVE path: bun resolves `workspace:*` to a copy
 * under node_modules/.bun, and a suite over a copy grades a stale litestone.
 */

import { describe, test, expect, beforeAll } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { createTestEnv } from "../../litestone/src/testing.js"
import { LitestoneExecutionStore, type OrionSystemClient } from "../src/store"
import { InMemoryPlanCache, Scheduler } from "../src/engine/runtime"
import type { ExecutionPlan, NodeDefinition } from "../src/engine/types"
import type { INodeImplementation, INodeRegistry } from "../src/engine/executor"

const SCHEMA = 'database main { path "./orion.db" }\n'
  + readFileSync(join(import.meta.dir, "..", "db", "orion.lite"), "utf8")

const KEY = "0".repeat(64)

// `claims: []` states that the schema reads no claim beyond litestone's own.
async function makeEnv(): Promise<any> {
  return createTestEnv({ schema: SCHEMA, encryptionKey: KEY, claims: [] })
}

// A role grades USER(4) under litestone's default resolver; isAdmin grades 5.
const USER  = { id: "u-user",  role: "member" }
const ADMIN = { id: "u-admin", role: "admin", isAdmin: true }

// ─── plans ───────────────────────────────────────────────────────────────────

// One node per stage, in order, so a checkpoint count is a stage count.
function linearPlan(types: string[]): ExecutionPlan {
  const nodes: Record<string, NodeDefinition> = {}
  types.forEach((type, i) => { nodes[`n${i}`] = { id: `n${i}`, type, config: {} } })
  return {
    flowId:       "flow",
    version:      "1",
    compiledAt:   Date.now(),
    stages:       types.map((_, i) => ({ index: i, nodes: [`n${i}`], edges: {} })),
    nodes,
    triggerIds:   [],
    statics:      {},
    routing:      {},
    nodeCount:    types.length,
    stageCount:   types.length,
    hasBranching: false,
    hasFanOut:    false,
  }
}

const IMPLS: INodeImplementation[] = [
  { type: "ok",    execute: (async () => ({ ok: true, data: { email: "a@b.c", n: 1 } })) as INodeImplementation["execute"] },
  { type: "fails", execute: (async () => ({ ok: false, error: "upstream said no" })) as INodeImplementation["execute"] },
  { type: "waits", execute: (async () => ({ ok: true, data: { __orion_wait: true, resumeKey: crypto.randomUUID(), event: "approval", timeoutAt: null, into: "approval" } })) as INodeImplementation["execute"] },
]
const registry: INodeRegistry = { get: (type) => IMPLS.find(i => i.type === type) }

// ─── fixtures ────────────────────────────────────────────────────────────────

// A flow, its version, and a pending run — what a trigger will have written
// before it dispatches. The run id is the execution id.
async function pendingRun(env: any, trigger: unknown = { body: { amount: 5 } }) {
  const flow    = await env.system.flow.create({ data: { name: "f", ownerId: USER.id } })
  const version = await env.system.flowVersion.create({ data: { flowId: flow.id, version: 1, definition: {} } })
  const run     = await env.system.run.create({ data: { flowVersionId: version.id, trigger } })
  return { flow, version, run }
}

function schedulerFor(store: LitestoneExecutionStore, plan: ExecutionPlan, flowId: string) {
  const plans = new InMemoryPlanCache()
  plans.set(flowId, "1", { ...plan, flowId })
  return new Scheduler(plans, store, registry, undefined, { checkpoint: true })
}

// Every status the store writes to Run, in order, off a client that forwards
// to the real one.
function recording(system: any): { client: OrionSystemClient; statuses: string[] } {
  const statuses: string[] = []
  const wrap = (db: any): OrionSystemClient => new Proxy(db, {
    get(target, key) {
      if (key === "$transaction") return (fn: any) => target.$transaction((tx: any) => fn(wrap(tx)))
      if (key !== "run") return target[key]
      return new Proxy(target.run, {
        get: (table, method) => method !== "update" ? table[method]
          : (a: any) => { if ("status" in a.data) statuses.push(a.data.status); return table.update(a) },
      })
    },
  })
  return { client: wrap(system), statuses }
}

// ─── access ──────────────────────────────────────────────────────────────────

describe("orion.lite — access", () => {
  let env: any
  beforeAll(async () => { env = await makeEnv() })

  test("every gated model's ladder executes as declared", async () => {
    const rows = await env.verifyGateLadder()
    expect(rows.filter((m: any) => m.got !== "skipped").map((m: any) => m.message)).toEqual([])
  }, 60_000)

  test("every row policy admits and filters the rows its predicate says", async () => {
    const rows = await env.verifyRowPolicies()
    expect(rows.filter((m: any) => m.got !== "skipped").map((m: any) => m.message)).toEqual([])
  })

  test("encrypted columns are absent below system", async () => {
    expect(await env.verifyFieldProtection()).toEqual([])
  })

  test("a USER drafts a flow, stamped as its owner", async () => {
    const flow = await env.actingAs(USER).flow.create({ data: { name: "draft" } })
    expect(flow.ownerId).toBe(USER.id)
    expect(flow.status).toBe("draft")
  })

  // The skipped half of the ladder: a create policy refuses a synthetic
  // principal before the gate, so these rules are graded here or nowhere.
  test("a create naming another owner is refused — a run acts as its owner", async () => {
    await expect(env.actingAs(USER).flow.create({ data: { name: "x", ownerId: ADMIN.id } }))
      .rejects.toThrow(/@@deny/)
  })

  test("a create straight into active is refused — activation is ADMINISTRATOR(5)", async () => {
    await expect(env.actingAs(USER).flow.create({ data: { name: "x", status: "active" } }))
      .rejects.toThrow(/@@deny/)
  })

  test("the owner is never rewritten", async () => {
    const flow = await env.actingAs(USER).flow.create({ data: { name: "mine" } })
    await expect(env.actingAs(ADMIN).flow.update({ where: { id: flow.id }, data: { ownerId: ADMIN.id } }))
      .rejects.toThrow(/@immutable/)
  })

  test("activation is ADMINISTRATOR(5), even for the owner", async () => {
    const mine = await env.actingAs(USER).flow.create({ data: { name: "go" } })
    await expect(env.actingAs(USER).flow.update({ where: { id: mine.id }, data: { status: "active" } }))
      .rejects.toThrow(/requires level 5/)

    const theirs = await env.actingAs(ADMIN).flow.create({ data: { name: "admin's" } })
    const active = await env.actingAs(ADMIN).flow.update({ where: { id: theirs.id }, data: { status: "active" } })
    expect(active.status).toBe("active")
  })

  // FJS-D289. An administrator acting on somebody else's flow goes through the
  // flows service, which grades the caller and writes as system.
  test("only the owner updates a flow, an administrator included", async () => {
    const flow = await env.actingAs(USER).flow.create({ data: { name: "owned" } })
    const other = { id: "u-other", role: "member" }

    // A policy filters rather than refuses, so a refusal never confirms the row
    // exists: the update answers nothing and the row is unchanged.
    for (const who of [other, ADMIN]) {
      expect(await env.actingAs(who).flow.update({ where: { id: flow.id }, data: { name: "taken" } })).toBeNull()
    }
    expect((await env.system.flow.findFirst({ where: { id: flow.id } })).name).toBe("owned")
  })

  test("only the owner writes a flow's versions and layout", async () => {
    const flow  = await env.actingAs(USER).flow.create({ data: { name: "drawn" } })
    const other = env.actingAs({ id: "u-other", role: "member" })

    await expect(other.flowVersion.create({ data: { flowId: flow.id, version: 1, definition: {} } })).rejects.toThrow(/policy/)
    await expect(other.flowLayout.create({ data: { flowId: flow.id, layout: {} } })).rejects.toThrow(/policy/)

    const owner = env.actingAs(USER)
    await owner.flowVersion.create({ data: { flowId: flow.id, version: 1, definition: {} } })
    const layout = await owner.flowLayout.create({ data: { flowId: flow.id, layout: { a: 1 } } })
    expect(await other.flowLayout.update({ where: { id: layout.id }, data: { layout: {} } })).toBeNull()
    expect((await env.system.flowLayout.findFirst({ where: { id: layout.id } })).layout).toEqual({ a: 1 })
  })

  test("an active flow's version does not move; a paused one's does", async () => {
    const admin = env.actingAs(ADMIN)
    const flow  = await admin.flow.create({ data: { name: "v", currentVersion: 1 } })
    await admin.flow.update({ where: { id: flow.id }, data: { status: "active" } })

    await admin.flow.update({ where: { id: flow.id }, data: { currentVersion: 2 } })
    expect((await env.system.flow.findFirst({ where: { id: flow.id } })).currentVersion).toBe(1)

    await admin.flow.update({ where: { id: flow.id }, data: { status: "paused" } })
    await admin.flow.update({ where: { id: flow.id }, data: { currentVersion: 2 } })
    expect((await env.system.flow.findFirst({ where: { id: flow.id } })).currentVersion).toBe(2)
  })

  test("a flow version names its author, and nobody writes one as somebody else", async () => {
    const flow    = await env.actingAs(USER).flow.create({ data: { name: "authored" } })
    const version = await env.actingAs(USER).flowVersion.create({ data: { flowId: flow.id, version: 1, definition: {} } })
    expect(version.authorId).toBe(USER.id)
    await expect(env.actingAs(USER).flowVersion.create({ data: { flowId: flow.id, version: 2, definition: {}, authorId: ADMIN.id } }))
      .rejects.toThrow(/@@deny/)
  })

  test("a flow version is never edited", async () => {
    const { version } = await pendingRun(env)
    await expect(env.actingAs(ADMIN).flowVersion.update({ where: { id: version.id }, data: { definition: { x: 1 } } }))
      .rejects.toThrow()
    await expect(env.system.flowVersion.update({ where: { id: version.id }, data: { definition: { x: 1 } } }))
      .rejects.toThrow(/LOCKED/)
  })
})

// ─── the store ───────────────────────────────────────────────────────────────

describe("LitestoneExecutionStore", () => {
  let env: any
  beforeAll(async () => { env = await makeEnv() })

  test("a run costs one statement per stage and one transaction at the end", async () => {
    const { flow, run } = await pendingRun(env)
    const store = new LitestoneExecutionStore(env.system)
    const plan  = linearPlan(["ok", "ok", "ok"])

    // The tap names the TABLE, not the model.
    const seen: string[] = []
    const untap = env.db.$tapQuery((e: any) => seen.push(`${e.operation} ${e.model}`))
    const record = await schedulerFor(store, plan, flow.id)
      .processJob({ executionId: run.id, flowId: flow.id, version: "1", trigger: run.trigger })
    untap()

    expect(record.status).toBe("completed")
    expect(seen).toEqual(["update run", "update run", "update run", "update run", "createMany run_step"])
  })

  test("the ended run keeps its steps and drops its context", async () => {
    const { flow, run } = await pendingRun(env)
    const store = new LitestoneExecutionStore(env.system)
    await schedulerFor(store, linearPlan(["ok", "ok"]), flow.id)
      .processJob({ executionId: run.id, flowId: flow.id, version: "1", trigger: run.trigger })

    const row = await env.system.run.findFirst({ where: { id: run.id }, include: { steps: true } })
    expect(row.status).toBe("completed")
    expect(row.context).toBeNull()
    expect(row.endedAt).not.toBeNull()
    expect(row.steps.map((s: any) => [s.nodeId, s.status, s.output])).toEqual([
      ["n0", "completed", { email: "a@b.c", n: 1 }],
      ["n1", "completed", { email: "a@b.c", n: 1 }],
    ])
    expect(await store.getContext(run.id)).toBeUndefined()

    const history = await store.getRecord(run.id)
    expect(history?.status).toBe("completed")
    expect(history?.flowId).toBe(flow.id)
    expect(Object.keys(history!.nodeTimings).sort()).toEqual(["n0", "n1"])
    expect(history?.finalContext["n1"]).toEqual({ email: "a@b.c", n: 1 })
  })

  test("a failed node fails the run and says why", async () => {
    const { flow, run } = await pendingRun(env)
    const store = new LitestoneExecutionStore(env.system)
    await schedulerFor(store, linearPlan(["ok", "fails", "ok"]), flow.id)
      .processJob({ executionId: run.id, flowId: flow.id, version: "1", trigger: run.trigger })

    const row = await env.system.run.findFirst({ where: { id: run.id }, include: { steps: true } })
    expect(row.status).toBe("failed")
    expect(row.error).toMatch(/upstream said no/)
    const byNode = Object.fromEntries(row.steps.map((s: any) => [s.nodeId, s.status]))
    expect(byNode).toEqual({ n0: "completed", n1: "failed", n2: "pending" })
  })

  test("a suspended run is resumable from the database, and hidden below system", async () => {
    const { flow, run } = await pendingRun(env)
    const store     = new LitestoneExecutionStore(env.system)
    const scheduler = schedulerFor(store, linearPlan(["ok", "waits", "ok"]), flow.id)

    const first = await scheduler.processJob({ executionId: run.id, flowId: flow.id, version: "1", trigger: run.trigger })
    expect(first.status).toBe("waiting")

    const waiting = await env.system.run.findFirst({ where: { id: run.id }, include: { steps: true, waits: true } })
    expect(waiting.status).toBe("waiting")
    expect(waiting.steps).toEqual([])
    expect(waiting.context).not.toBeNull()
    // The Wait row lands with the checkpoint, naming the node the run waits on.
    expect(waiting.waits.map((w: any) => [w.nodeId, w.resumeKey])).toEqual([["n1", first.nodeStates["n1"]!.output && (first.nodeStates["n1"]!.output as any).resumeKey]])

    const inspector = await env.actingAs(USER).run.findFirst({ where: { id: run.id } })
    expect(inspector.status).toBe("waiting")
    expect("context" in inspector).toBe(false)

    // A different store is a different process: nothing but the row carries over.
    const resumed = await new LitestoneExecutionStore(env.system).getContext(run.id)
    expect(resumed?.currentStage).toBe(1)
    expect(resumed?.trigger).toEqual({ body: { amount: 5 } })

    const done = await schedulerFor(new LitestoneExecutionStore(env.system), linearPlan(["ok", "waits", "ok"]), flow.id)
      .processJob({ executionId: run.id, flowId: flow.id, version: "1", trigger: run.trigger, resumeFrom: resumed })
    expect(done.status).toBe("completed")

    const ended = await env.system.run.findFirst({ where: { id: run.id }, include: { steps: true } })
    expect(ended.steps.map((s: any) => s.nodeId).sort()).toEqual(["n0", "n1", "n2"])
  })

  test("the context column is ciphertext on disk", async () => {
    const { flow, run } = await pendingRun(env)
    const store = new LitestoneExecutionStore(env.system)
    await schedulerFor(store, linearPlan(["waits"]), flow.id)
      .processJob({ executionId: run.id, flowId: flow.id, version: "1", trigger: run.trigger })

    const { Database } = await import("bun:sqlite")
    const raw = new Database(env.path, { readonly: true })
    const row = raw.query("SELECT context FROM run WHERE id = ?").get(run.id) as { context: string }
    raw.close()
    expect(row.context).toMatch(/^v2\./)
    expect(row.context).not.toContain("__orion_wait")
  })

  test("a terminal write that fails leaves the run resumable", async () => {
    const { flow, run } = await pendingRun(env)
    // The terminal transaction's second statement fails, as a full disk would.
    const failing = (db: any): OrionSystemClient => new Proxy(db, {
      get(target, key) {
        if (key === "$transaction") return (fn: any) => target.$transaction((tx: any) => fn(failing(tx)))
        if (key !== "runStep") return target[key]
        return new Proxy(target.runStep, { get: (t, m) => m === "createMany" ? async () => { throw new Error("disk full") } : t[m] })
      },
    })
    const broken = failing(env.system)
    const scheduler = schedulerFor(new LitestoneExecutionStore(broken), linearPlan(["ok"]), flow.id)
    await expect(scheduler.processJob({ executionId: run.id, flowId: flow.id, version: "1", trigger: run.trigger }))
      .rejects.toThrow(/disk full/)

    const row = await env.system.run.findFirst({ where: { id: run.id } })
    expect(row.status).toBe("running")
    expect(row.context).not.toBeNull()
  })

  test("every status it writes is a move Run declares", async () => {
    const run  = env.schema.models.find((m: any) => m.name === "Run")
    const decl = run.attributes.find((a: any) => a.kind === "transitions").transitions
    const legal = new Set<string>()
    for (const move of Object.values(decl) as Array<{ from: string[]; to: string }>)
      for (const from of move.from) legal.add(`${from}->${move.to}`)

    const walk = async (types: string[], resume: boolean) => {
      const { flow, run } = await pendingRun(env)
      const { client, statuses } = recording(env.system)
      const store = new LitestoneExecutionStore(client)
      const job   = { executionId: run.id, flowId: flow.id, version: "1", trigger: run.trigger }
      await schedulerFor(store, linearPlan(types), flow.id).processJob(job)
      if (resume) {
        const resumeFrom = await store.getContext(run.id)
        await schedulerFor(store, linearPlan(types), flow.id).processJob({ ...job, resumeFrom })
      }
      return ["pending", ...statuses]
    }

    const paths = [
      await walk(["ok", "ok"], false),
      await walk(["ok", "fails"], false),
      await walk(["fails"], false),
      await walk(["ok", "waits", "ok"], true),
      await walk(["waits", "fails"], true),
    ]
    const illegal = paths.flatMap(p => p.slice(1).map((to, i) => `${p[i]}->${to}`)).filter(m => !legal.has(m))
    expect(illegal).toEqual([])
  })
})
