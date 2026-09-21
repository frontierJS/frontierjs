/*
 * runner.test.ts
 *
 * Flows run on a real Caravan queue over a real jobs FILE, against a real
 * litestone database built from `db/orion.lite`.
 *
 * Every assertion about how many times something ran reads the evidence the
 * nodes leave on disk (`fixtures/host.ts`), never the runner's own answer, and
 * every assertion about a job reads the jobs table. What is asked: a run is one
 * job dispatched as its owner; a start or a resume stated twice runs once; a
 * wait ends on its key or its deadline and never both; a dispatch lost between
 * the insert and the queue is found again; a cron trigger follows the row.
 * Model and webhook triggers are `triggers.test.ts`.
 *
 * The crash — a process killed mid-stage — is `crash.test.ts`, because it needs
 * processes this file does not have.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createTestEnv } from "../../litestone/src/testing.js"
import { createCaravan } from "../../caravan/src/index"
import { litestoneHost } from "../src/tenancy"
import { createRunner, FlowNotRunnableError, RUN_JOB, type Runner } from "../src/runner"
import { SCHEMA, KEY, registryFor, ranIn, chain, count, wait, cronTrigger, activeFlow } from "./fixtures/host"

let env:    any
let dir:    string
let jobs:   ReturnType<typeof createCaravan>
let runner: Runner

beforeAll(async () => {
  dir    = mkdtempSync(join(tmpdir(), "orion-runner-"))
  env    = await createTestEnv({ schema: SCHEMA, encryptionKey: KEY, claims: [] })
  jobs   = createCaravan({ db: join(dir, "jobs.db"), pollInterval: 20, heartbeat: 100, lease: 2_000, cleanupAfter: 0 })
  runner = createRunner({ host: litestoneHost({ db: env.db }), jobs, registry: registryFor(dir) })
  runner.register()
  await jobs.start()
})

afterAll(async () => {
  await jobs.stop()
  rmSync(dir, { recursive: true, force: true })
})

async function settled(runId: string, statuses = ["completed", "failed", "waiting"], ms = 5_000) {
  const until = Date.now() + ms
  for (;;) {
    const run = await env.system.run.findFirst({ where: { id: runId }, include: { steps: true, waits: true } })
    if (run && statuses.includes(run.status)) return run
    if (Date.now() > until) throw new Error(`run ${runId} is ${run?.status} after ${ms}ms`)
    await Bun.sleep(20)
  }
}

// ─── starting ────────────────────────────────────────────────────────────────

describe("start", () => {
  test("a run is one job, dispatched as the flow's owner, and it completes", async () => {
    const flowId = await activeFlow(env.system, chain([count("a"), count("b")]), "owner-7")
    const runId  = await runner.start(flowId, { body: { n: 1 } })

    const run = await settled(runId)
    expect(run.status).toBe("completed")
    expect(run.actorId).toBe("owner-7")
    expect(run.steps.map((s: any) => s.nodeId).sort()).toEqual(["a", "b", "t"])
    expect(ranIn(dir, runId)).toEqual({ a: 1, b: 1 })

    const job = jobs.find(`run:${runId}`)
    expect(job?.name).toBe(RUN_JOB)
    expect(job?.actor_id).toBe("owner-7")
  })

  test("a flow that is not active does not run, and leaves no run behind", async () => {
    const flowId = await activeFlow(env.system, chain([count("a")]))
    await env.system.flow.update({ where: { id: flowId }, data: { status: "paused" } })

    await expect(runner.start(flowId, {})).rejects.toBeInstanceOf(FlowNotRunnableError)
    const versions = await env.system.flowVersion.findMany({ where: { flowId }, include: { runs: true } })
    expect(versions[0].runs).toEqual([])
  })

  test("a flow that does not compile does not run", async () => {
    const flowId = await activeFlow(env.system, chain([{ id: "x", type: "not.a.type", config: {} }]))
    await expect(runner.start(flowId, {})).rejects.toThrow(/cannot run/)
  })

  test("a start stated twice under one id is one run", async () => {
    const flowId = await activeFlow(env.system, chain([count("a")]))
    const id     = crypto.randomUUID()
    const [first, second] = await Promise.all([runner.start(flowId, {}, { id }), runner.start(flowId, {}, { id })])

    expect(first).toBe(id)
    expect(second).toBe(id)
    await settled(id)
    expect(ranIn(dir, id)).toEqual({ a: 1 })
  })
})

// ─── waiting ─────────────────────────────────────────────────────────────────

describe("wait and resume", () => {
  test("a run waits on its key, and the payload reaches the node after it", async () => {
    const flowId = await activeFlow(env.system, chain([count("before"), wait("w", "approval"), count("after", "approval")]))
    const runId  = await runner.start(flowId, {})

    const waiting = await settled(runId)
    expect(waiting.status).toBe("waiting")
    expect(waiting.waits).toHaveLength(1)
    const key = waiting.waits[0].resumeKey

    expect(await runner.resume(key, { approvedBy: "sam" })).toBe(true)
    const done = await settled(runId, ["completed", "failed"])
    expect(done.status).toBe("completed")
    expect(done.waits).toEqual([])
    expect(done.steps.find((s: any) => s.nodeId === "after").output).toEqual({ read: { approvedBy: "sam" } })
    expect(ranIn(dir, runId)).toEqual({ before: 1, after: 1 })
  })

  test("a resume key replayed runs nothing — before its job runs and after", async () => {
    const flowId = await activeFlow(env.system, chain([wait("w", "approval"), count("after")]))
    const runId  = await runner.start(flowId, {})
    const key    = (await settled(runId)).waits[0].resumeKey

    // Both find the Wait row before either job has run: one job id between them.
    const answers = await Promise.all([runner.resume(key, { n: 1 }), runner.resume(key, { n: 2 })])
    expect(answers).toEqual([true, true])
    await settled(runId, ["completed"])

    // And a dispatch stated under the same job id after the run ended.
    await jobs.dispatch(RUN_JOB, { runId, resumeKey: key, payload: { n: 3 } }, { id: `resume:${key}`, queue: "orion" })
    expect(await runner.resume(key, { n: 4 })).toBe(false)
    await Bun.sleep(200)

    // Two defenses, each asserted: the job id makes the three one job, and the
    // transaction consuming the Wait row would stop a second one running.
    expect(ranIn(dir, runId)).toEqual({ after: 1 })
    const resumes = jobs.list({ queue: "orion", limit: 500 }).filter(j => JSON.parse(j.data).resumeKey === key)
    expect(resumes.map(j => j.id)).toEqual([`resume:${key}`])
  })

  test("a wait past its deadline ends the run failed, and its key resumes nothing", async () => {
    const flowId = await activeFlow(env.system, chain([wait("w", "approval", 1_000), count("after")]))
    const runId  = await runner.start(flowId, {})
    const key    = (await settled(runId)).waits[0].resumeKey

    const early = createRunner({ host: litestoneHost({ db: env.db }), jobs, registry: registryFor(dir), now: () => Date.now() })
    expect((await early.sweep()).expired).toBe(0)

    const late = createRunner({ host: litestoneHost({ db: env.db }), jobs, registry: registryFor(dir), now: () => Date.now() + 5_000 })
    expect((await late.sweep()).expired).toBe(1)

    const run = await env.system.run.findFirst({ where: { id: runId }, include: { waits: true } })
    expect(run.status).toBe("failed")
    expect(run.error).toMatch(/flow.wait "approval" timed out/)
    expect(run.context).toBeNull()
    expect(run.waits).toEqual([])
    expect(await runner.resume(key, {})).toBe(false)
    expect(ranIn(dir, runId)).toEqual({})
  })
})

// ─── a lost dispatch ─────────────────────────────────────────────────────────

describe("the sweep", () => {
  test("a pending run whose job was never queued is dispatched again", async () => {
    const flowId  = await activeFlow(env.system, chain([count("a")]))
    const version = await env.system.flowVersion.findFirst({ where: { flowId } })
    // What a crash between the insert and the dispatch leaves.
    const run = await env.system.run.create({ data: { flowVersionId: version.id, trigger: {}, actorId: "owner-1" } })
    expect(jobs.find(`run:${run.id}`)).toBeNull()

    const soon = createRunner({ host: litestoneHost({ db: env.db }), jobs, registry: registryFor(dir), now: () => Date.now() })
    expect((await soon.sweep()).redispatched).toBe(0)

    const later = createRunner({ host: litestoneHost({ db: env.db }), jobs, registry: registryFor(dir), now: () => Date.now() + 120_000 })
    expect((await later.sweep()).redispatched).toBeGreaterThanOrEqual(1)
    expect((await settled(run.id)).status).toBe("completed")
    expect(ranIn(dir, run.id)).toEqual({ a: 1 })
  })
})

// ─── cron ────────────────────────────────────────────────────────────────────

describe("cron from a flow row", () => {
  function cronFlow(expression: string) {
    const flow = chain([count("tick")])
    return { ...flow, nodes: { ...flow.nodes, t: cronTrigger(expression) } }
  }
  // `nextRuns()` and not `registrations()`: a cron bound to a flow ROW is data,
  // so it is on the clock and off the declaration list `junction jobs` commits.
  const registered = () => jobs.nextRuns().map(r => r.name)

  test("an active flow's cron trigger is a schedule, and unscheduling takes it back", async () => {
    const flowId = await activeFlow(env.system, cronFlow("*/5 * * * *"))
    const names  = (await runner.activate(flowId))?.cron ?? []

    expect(names).toEqual([`orion.cron:${flowId}:t`])
    expect(registered()).toContain(names[0])

    runner.deactivate(flowId)
    expect(jobs.nextRuns().map(r => r.name)).not.toContain(names[0])
  })

  test("a paused flow has no schedule, and pausing one that had removes it", async () => {
    const flowId = await activeFlow(env.system, cronFlow("0 9 * * *"))
    const [name] = (await runner.activate(flowId))?.cron ?? []

    await env.system.flow.update({ where: { id: flowId }, data: { status: "paused" } })
    expect((await runner.activate(flowId))?.cron ?? []).toEqual([])
    expect(jobs.nextRuns().map(r => r.name)).not.toContain(name)
  })

  test("a fire starts one run, and a fire replayed under its job id starts none", async () => {
    const flowId = await activeFlow(env.system, cronFlow("* * * * *"))
    const [name] = (await runner.activate(flowId))?.cron ?? []

    const fireId = `cron:${name}:12345`
    await jobs.dispatch(name!, {}, { id: fireId, queue: "orion" })
    const run = await settled(fireId)
    expect(run.status).toBe("completed")

    await jobs.dispatch(name!, {}, { id: fireId, queue: "orion" })
    await Bun.sleep(200)
    expect(ranIn(dir, fireId)).toEqual({ tick: 1 })
    runner.deactivate(flowId)
  })

  test("syncActivations registers every active flow's triggers at boot", async () => {
    const a = await activeFlow(env.system, cronFlow("0 1 * * *"))
    const b = await activeFlow(env.system, cronFlow("0 2 * * *"))
    await runner.syncActivations()
    expect(registered()).toEqual(expect.arrayContaining([`orion.cron:${a}:t`, `orion.cron:${b}:t`]))
  })
})

// ─── a second instance ───────────────────────────────────────────────────────

describe("an activation made on another instance", () => {
  // A second Caravan over the same jobs file and a second runner over the same
  // database: what another process of the same app holds.
  function instance(extra: Partial<Parameters<typeof createRunner>[0]> = {}) {
    const other = createCaravan({ db: join(dir, "jobs.db"), pollInterval: 20, heartbeat: 100, lease: 2_000, cleanupAfter: 0 })
    return { jobs: other, runner: createRunner({ host: litestoneHost({ db: env.db }), jobs: other, registry: registryFor(dir), ...extra }) }
  }

  function hookFlow(path: string, cron?: string) {
    const flow = chain([count("hit")])
    const t    = { id: "t", type: "trigger.webhook", config: { path: { type: "literal", value: path }, mode: { type: "literal", value: "async" } } }
    return { ...flow, nodes: { ...flow.nodes, t, ...(cron ? { c: { ...cronTrigger(cron), id: "c" } } : {}) } }
  }

  const pause = (flowId: string) => env.system.flow.update({ where: { id: flowId }, data: { status: "paused" } })

  test("reaches this one on its next sync, and so does the pause", async () => {
    const path   = `hook-${crypto.randomUUID().slice(0, 8)}`
    const flowId = await activeFlow(env.system, hookFlow(path, "0 3 * * *"))
    const b      = instance()

    await runner.activate(flowId)
    expect(b.runner.webhook(path)).toBeUndefined()

    expect((await b.runner.syncActivations()).activated).toContain(flowId)
    expect(b.runner.webhook(path)).toEqual({ flowId, mode: "async", tenant: null })
    expect(b.jobs.nextRuns().map(r => r.name)).toContain(`orion.cron:${flowId}:c`)

    await pause(flowId)
    expect((await b.runner.syncActivations()).deactivated).toEqual([flowId])
    expect(b.runner.webhook(path)).toBeUndefined()
    expect(b.jobs.nextRuns().map(r => r.name)).not.toContain(`orion.cron:${flowId}:c`)
    runner.deactivate(flowId)
  })

  test("a new version activated while this one was not looking replaces the old one's triggers", async () => {
    const [before, after] = [`old-${crypto.randomUUID().slice(0, 8)}`, `new-${crypto.randomUUID().slice(0, 8)}`]
    const flowId = await activeFlow(env.system, hookFlow(before))
    const b      = instance()
    await b.runner.syncActivations()
    expect(b.runner.webhook(before)?.flowId).toBe(flowId)

    // Paused, edited and activated again between two passes: the status reads
    // `active` both times and only the version says anything changed.
    await pause(flowId)
    await env.system.flowVersion.create({ data: { flowId, version: 2, definition: hookFlow(after) } })
    await env.system.flow.update({ where: { id: flowId }, data: { currentVersion: 2, status: "active" } })

    await b.runner.syncActivations()
    expect(b.runner.webhook(before)).toBeUndefined()
    expect(b.runner.webhook(after)?.flowId).toBe(flowId)
    await pause(flowId)
    await b.runner.syncActivations()
  })

  test("watch finds it without being asked", async () => {
    const path   = `watched-${crypto.randomUUID().slice(0, 8)}`
    const b      = instance()
    const stop   = b.runner.watch(25)
    try {
      const flowId = await activeFlow(env.system, hookFlow(path))
      const until  = Date.now() + 2_000
      while (!b.runner.webhook(path) && Date.now() < until) await Bun.sleep(10)
      expect(b.runner.webhook(path)?.flowId).toBe(flowId)
      await pause(flowId)
    } finally {
      stop()
    }
  })

  test("a flow that cannot activate is reported once per version, and activates once the path it wanted is free", async () => {
    const path    = `contested-${crypto.randomUUID().slice(0, 8)}`
    const errors: string[] = []
    const b       = instance({ onActivationError: (id, error) => errors.push(`${id}: ${error}`) })

    const holder  = await activeFlow(env.system, hookFlow(path))
    const wanting = await activeFlow(env.system, hookFlow(path))
    await b.runner.syncActivations()
    await b.runner.syncActivations()
    await b.runner.syncActivations()
    // Rows come back in no promised order, so either may hold the path.
    const [won, lost] = b.runner.webhook(path)?.flowId === holder ? [holder, wanting] : [wanting, holder]
    // The suite's database holds other tests' flows, one of which never compiles.
    const ours = () => errors.filter(e => e.startsWith(`${holder}: `) || e.startsWith(`${wanting}: `))
    expect(ours()).toEqual([expect.stringContaining(`${lost}: `)])

    await pause(won)
    await b.runner.syncActivations()
    expect(b.runner.webhook(path)?.flowId).toBe(lost)
    expect(ours()).toHaveLength(1)
    await pause(lost)
    await b.runner.syncActivations()
  })
})
