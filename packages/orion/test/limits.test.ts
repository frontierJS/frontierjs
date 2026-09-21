/*
 * limits.test.ts
 *
 * The four day-one limits (`FJS-D283`), each against the app host in
 * `fixtures/app.ts`: the kill switch, the per-flow rate limit, the row ceiling,
 * and the dry run.
 *
 * The kill switch is asked where it is hardest — a run already QUEUED when the
 * flow is paused, and a run WAITING when it is — because refusing a new trigger
 * is the easy half. The ceiling is asked across a resume, where an in-memory
 * counter would forget what the run wrote before it waited. The dry run is
 * asked for what it must not do: write a row, create a run, or send anything.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"

import { FlowNotRunnableError, FlowRateLimitedError, RUN_JOB } from "../src/runner"
import { chain, activeFlow, wait } from "./fixtures/host"
import { appHost, lit, obj, create, type AppHost } from "./fixtures/app"

let host: AppHost
let env:  any
beforeAll(async () => { host = await appHost(); env = host.env })
afterAll(() => host.stop())

const pause    = (flowId: string) => env.system.flow.update({ where: { id: flowId }, data: { status: "paused" } })
const activate = (flowId: string) => env.system.flow.update({ where: { id: flowId }, data: { status: "active" } })

// ─── the kill switch ─────────────────────────────────────────────────────────

describe("the kill switch", () => {
  test("a run queued before its flow was paused is cancelled, not run", async () => {
    const flowId = await activeFlow(env.system, chain([create("c", "Lead", obj({ name: "Queued" }))]), "u-user")
    const queue  = host.jobs.queue("orion")

    await queue.pause()
    const runId = await host.runner.start(flowId, {})
    await pause(flowId)
    await queue.resume()

    const run = await host.settled(runId)
    expect(run.status).toBe("cancelled")
    expect(run.error).toMatch(/the flow is paused/)
    expect(await env.system.lead.findFirst({ where: { name: "Queued" } })).toBeNull()
  })

  test("a waiting run of a paused flow stays waiting, and resumes once the flow is active", async () => {
    const flowId = await activeFlow(env.system, chain([wait("w", "approval"), create("c", "Lead", obj({ name: "Later" }))]), "u-user")
    const runId  = await host.runner.start(flowId, {})
    const key    = (await host.settled(runId)).waits[0].resumeKey

    await pause(flowId)
    await expect(host.runner.resume(key, {})).rejects.toBeInstanceOf(FlowNotRunnableError)
    // Dispatched before the pause and run after it: the job leaves it waiting.
    await host.jobs.dispatch(RUN_JOB, { runId, resumeKey: key, payload: {} }, { id: `early:${key}`, queue: "orion" })
    await Bun.sleep(200)
    expect((await env.system.run.findFirst({ where: { id: runId }, include: { waits: true } })).waits).toHaveLength(1)

    await activate(flowId)
    expect(await host.runner.resume(key, {})).toBe(true)
    expect((await host.settled(runId, ["completed", "failed"])).status).toBe("completed")
  })
})

// ─── the rate limit ──────────────────────────────────────────────────────────

describe("runs per minute", () => {
  test("a start past the flow's limit is refused and makes no run", async () => {
    const flowId = await activeFlow(env.system, chain([]), "u-user")
    await env.system.flow.update({ where: { id: flowId }, data: { runsPerMinute: 2 } })

    await host.runner.start(flowId, {})
    await host.runner.start(flowId, {})
    await expect(host.runner.start(flowId, {})).rejects.toBeInstanceOf(FlowRateLimitedError)
    expect(await env.system.run.count({ where: { flowVersion: { is: { flowId } } } })).toBe(2)
  })

  test("a flow with no limit is not counted", async () => {
    const flowId = await activeFlow(env.system, chain([]), "u-user")
    for (let i = 0; i < 5; i++) await host.runner.start(flowId, {})
    expect(await env.system.run.count({ where: { flowVersion: { is: { flowId } } } })).toBe(5)
  })
})

// ─── the row ceiling ─────────────────────────────────────────────────────────

describe("rows one run may write", () => {
  test("the write past the ceiling fails the run, and the ones before it stand", async () => {
    const flowId = await activeFlow(env.system, chain([
      create("a", "Lead", obj({ name: "Ceiling A" })),
      create("b", "Lead", obj({ name: "Ceiling B" })),
    ]), "u-user")
    await env.system.flow.update({ where: { id: flowId }, data: { maxWrites: 1 } })

    const run = await host.settled(await host.runner.start(flowId, {}))
    expect(run.status).toBe("failed")
    expect(run.error).toMatch(/written its ceiling of 1 rows/)
    expect(await env.system.lead.findFirst({ where: { name: "Ceiling A" } })).not.toBeNull()
    expect(await env.system.lead.findFirst({ where: { name: "Ceiling B" } })).toBeNull()
  })

  test("a resumed run counts what it wrote before it waited", async () => {
    const flowId = await activeFlow(env.system, chain([
      create("a", "Lead", obj({ name: "Before wait" })),
      wait("w", "approval"),
      create("b", "Lead", obj({ name: "After wait" })),
    ]), "u-user")
    await env.system.flow.update({ where: { id: flowId }, data: { maxWrites: 1 } })

    const runId = await host.runner.start(flowId, {})
    const key   = (await host.settled(runId)).waits[0].resumeKey
    await host.runner.resume(key, {})

    const run = await host.settled(runId, ["completed", "failed"])
    expect(run.status).toBe("failed")
    expect(run.error).toMatch(/ceiling of 1/)
    expect(await env.system.lead.findFirst({ where: { name: "After wait" } })).toBeNull()
  })

  test("a write in flight holds its row, and a refused one gives it back", async () => {
    // The refused Invoice routes to an error handler, and the Lead after it
    // writes with the one row the refusal returned.
    const flowId = await activeFlow(env.system, {
      ...chain([]),
      nodes: {
        t:       { id: "t", type: "trigger.manual", config: {} },
        no:      create("no", "Invoice", obj({ total: 1 })),
        handled: { id: "handled", type: "flow.error", config: {} },
        ok:      create("ok", "Lead", obj({ name: "Budget kept" })),
      },
      edges: [
        { id: "t-no",       from: "t",       to: "no" },
        { id: "no-handled", from: "no",      to: "handled", kind: "error" },
        { id: "handled-ok", from: "handled", to: "ok" },
      ],
    }, "u-user")
    await env.system.flow.update({ where: { id: flowId }, data: { maxWrites: 1 } })

    const run = await host.settled(await host.runner.start(flowId, {}))
    expect(run.steps.find((s: any) => s.nodeId === "no").error).toMatch(/requires level 5/)
    expect(run.status).toBe("completed")
    expect(await env.system.lead.findFirst({ where: { name: "Budget kept" } })).not.toBeNull()
  })
})

// ─── the dry run ─────────────────────────────────────────────────────────────

describe("a dry run", () => {
  const effects = () => chain([
    create("lead", "Lead", obj({ name: "Dry" })),
    { id: "call", type: "http.request", config: { credential: lit("crm"), path: lit("/hook"), method: lit("POST"), body: obj({ n: 1 }) } },
    { id: "svc",  type: "service.call", config: { service: lit("mail"), method: lit("send"), data: obj({ to: "a@b.c" }) } },
  ])

  test("writes nothing, makes no run, and lists what it did not send", async () => {
    const flowId = await activeFlow(env.system, effects(), "u-user")
    const leads  = await env.system.lead.count()
    const runs   = await env.system.run.count()

    const { record, notSent } = await host.runner.dryRun(flowId, { body: {} })

    expect(record.status).toBe("completed")
    // The create ran — its output is the row it would have written — and rolled back.
    expect((record.nodeStates["lead"]!.output as any).name).toBe("Dry")
    expect(await env.system.lead.count()).toBe(leads)
    expect(await env.system.run.count()).toBe(runs)
    expect(notSent.map(n => n.nodeId).sort()).toEqual(["call", "svc"])
    expect(notSent.find(n => n.nodeId === "call")).toMatchObject({ credential: "crm", path: "/hook", method: "POST" })
    expect(notSent.find(n => n.nodeId === "svc")).toMatchObject({ service: "mail", method: "send" })
  })

  test("is graded as the owner, so a write the owner cannot make fails in the dry run too", async () => {
    const flowId = await activeFlow(env.system, chain([create("c", "Invoice", obj({ total: 5 }))]), "u-user")
    const { record } = await host.runner.dryRun(flowId, {})
    expect(record.status).toBe("failed")
    expect(record.error).toMatch(/requires level 5/)
  })

  test("runs a draft, which is what trying a flow before activating it needs", async () => {
    const flow = await env.system.flow.create({ data: { name: "draft", ownerId: "u-user", currentVersion: 1 } })
    await env.system.flowVersion.create({ data: { flowId: flow.id, version: 1, definition: effects() } })

    const { record, notSent } = await host.runner.dryRun(flow.id, {})
    expect(record.status).toBe("completed")
    expect(notSent).toHaveLength(2)
    await expect(host.runner.start(flow.id, {})).rejects.toThrow(/it is draft/)
  })
})
