/*
 * plugin.test.ts
 *
 * `orion()` installed into a real Junction app — a litestone client, Caravan
 * on a jobs file, a model service, and a stub auth provider that answers
 * `sessionFor`, which is the one thing `app.runAs` asks of a provider. Every
 * request goes through `request(app)`, the whole transport pipeline minus the
 * socket.
 *
 * What is asked here and nowhere else: that a write through a SERVICE starts a
 * model-triggered flow and a write BY a flow starts none; that the owner a run
 * acts as is the session junction re-resolves, graded by junction's own gate
 * resolver, for a model node and a service call alike; and that the two raw
 * routes answer what the paper says — 202 and a run for an async webhook, the
 * flow's own response for a sync one, and a resume key used once.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createTestEnv } from "../../litestone/src/testing.js"
import { AIRegistry, channels, createApp, createService, createStubAuth, mailerPlugin, request } from "../../junction/index.ts"
import { notificationsPlugin } from "../../notifications/plugin.ts"
import { createCaravan } from "../../caravan/src/index"
import { orion } from "../src/plugin"
import type { Runner } from "../src/runner"
import { KEY, chain, activeFlow, wait } from "./fixtures/host"
import { APP, lit, obj, create } from "./fixtures/app"

let env:    any
let dir:    string
let app:    any
let runner: Runner
let target: ReturnType<typeof Bun.serve>
let hits:   Array<{ path: string; auth: string | null; body: string }> = []
let mailed: Array<{ to: unknown; subject: string }> = []
let touched: Array<{ id: string; actorId: string | null; principal: unknown; data: unknown }> = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "orion-plugin-"))
  env = await createTestEnv({ schema: APP, encryptionKey: KEY, claims: [] })
  target = Bun.serve({
    port: 0,
    async fetch(req) {
      hits.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body: await req.text() })
      return Response.json({ received: true })
    },
  })

  // The app's own adapter, as an app would register one. Who it runs as is
  // what the flow's owner is, so it answers with that.
  const ai = new AIRegistry().register({
    name:     "echo",
    complete: async (req) => ({ content: `${app.principal()?.userId}: ${req.messages[0]!.content}`, model: "echo" }),
    stream:   async () => { throw new Error("not streamed") },
  })

  app = createApp({
    db:   env.db,
    ai,
    auth: createStubAuth({ users: [
      { id: "u-user",  role: "member" },
      { id: "u-admin", role: "admin", isAdmin: true },
    ] }),
  })
  app.services.register(createService({ name: "leads",    model: "Lead",    db: env.db }))
  app.services.register(createService({ name: "invoices", model: "Invoice", db: env.db }))
  app.services.register(createService({ name: "memos",    model: "Memo",    db: env.db }))
  app.configure(createCaravan({ db: join(dir, "jobs.db"), pollInterval: 20, heartbeat: 100, lease: 2_000, cleanupAfter: 0 }))
  app.configure(channels())
  const send = async (m: any) => { mailed.push({ to: m.to, subject: m.subject }); return { id: String(mailed.length), message: "captured" } }
  app.configure(mailerPlugin({ send, batch: (ms: any[]) => Promise.all(ms.map(send)) } as never))
  app.configure(notificationsPlugin({ db: env.db, notifications: join(import.meta.dir, "fixtures", "notifications") }))
  // An app's own job, which records who it ran as.
  app.jobs.handle("leads.touch", async (job: any) => {
    touched.push({ id: job.id, actorId: job.actorId, principal: app.principal()?.userId ?? null, data: job.data })
  })
  app.configure(orion({
    deadlineMs:    1_000,
    verifyWebhook: (ctx) => ctx.headers["x-signature"] !== "bad",
  }))
  await app._startForTest()
  runner = app.orion
})

afterAll(async () => {
  target.stop(true)
  await app.jobs.stop()
  rmSync(dir, { recursive: true, force: true })
})

const http = () => request(app)

async function runsOf(flowId: string) {
  return env.system.run.findMany({ where: { flowVersion: { is: { flowId } } }, include: { steps: true } })
}

async function settled(runId: string, statuses = ["completed", "failed", "waiting"]) {
  const until = Date.now() + 5_000
  for (;;) {
    const run = await env.system.run.findFirst({ where: { id: runId }, include: { steps: true, waits: true } })
    if (run && statuses.includes(run.status)) return run
    if (Date.now() > until) throw new Error(`run ${runId} is ${run?.status}`)
    await Bun.sleep(20)
  }
}

async function until<T>(fn: () => Promise<T | undefined | false>, what: string): Promise<T> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const got = await fn()
    if (got) return got
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(20)
  }
}

// ─── the owner ───────────────────────────────────────────────────────────────

describe("a run acts as its owner, as junction resolves them", () => {
  test("a USER owner is refused by the ADMINISTRATOR gate — through junction's own resolver", async () => {
    const flowId = await activeFlow(env.system, chain([create("c", "Invoice", obj({ total: 9 }))]), "u-user")
    const run    = await settled(await runner.start(flowId, {}), ["completed", "failed"])
    expect(run.status).toBe("failed")
    expect(run.error).toMatch(/Invoice\.create" requires level 5, user has level 4/)
  })

  test("a service call runs as the owner too", async () => {
    const call = (id: string) => ({ id, type: "service.call", config: { service: lit("invoices"), method: lit("create"), data: obj({ total: 12 }) } })

    const asUser  = await settled(await runner.start(await activeFlow(env.system, chain([call("s")]), "u-user"), {}), ["completed", "failed"])
    expect(asUser.status).toBe("failed")
    expect(asUser.error).toMatch(/level 5/)

    const asAdmin = await settled(await runner.start(await activeFlow(env.system, chain([call("s")]), "u-admin"), {}), ["completed", "failed"])
    expect(asAdmin.status).toBe("completed")
    expect(asAdmin.steps.find((s: any) => s.nodeId === "s").output).toMatchObject({ total: 12 })
  })
})

// ─── the model trigger ───────────────────────────────────────────────────────

describe("a model trigger", () => {
  test("a write through a service starts the flow; the flow's own write starts nothing", async () => {
    const flow = chain([create("echo", "Lead", obj({ name: "echo" }))])
    flow.nodes.t = { id: "t", type: "trigger.model", config: { model: lit("Lead"), on: lit(["create"]) } }
    const flowId = await activeFlow(env.system, flow, "u-user")
    await runner.activate(flowId)

    const res = await http().post("/leads").auth("test-token-u-user").send({ name: "Ada" })
    expect(res.status).toBe(201)

    const [run] = await until(async () => { const r = await runsOf(flowId); return r.length > 0 && r }, "the flow to start")
    const done  = await settled(run.id, ["completed", "failed"])
    expect(done.status).toBe("completed")
    expect(done.trigger).toMatchObject({ model: "Lead", event: "create", record: { name: "Ada" } })

    // The echo Lead is a Lead create too. It ran inside the run, so it started none.
    await Bun.sleep(300)
    expect(await runsOf(flowId)).toHaveLength(1)
    runner.deactivate(flowId)
  })

  test("an event the trigger does not name starts nothing", async () => {
    const flow = chain([])
    flow.nodes.t = { id: "t", type: "trigger.model", config: { model: lit("Lead"), on: lit(["remove"]) } }
    const flowId = await activeFlow(env.system, flow, "u-user")
    await runner.activate(flowId)

    await http().post("/leads").auth("test-token-u-user").send({ name: "Not removed" })
    await Bun.sleep(300)
    expect(await runsOf(flowId)).toHaveLength(0)
    runner.deactivate(flowId)
  })

  test("the trigger holds the row as the flow's OWNER reads it, not as its writer did (`FJS-D295`)", async () => {
    const heard = async (owner: string) => {
      const flow = chain([])
      flow.nodes.t = { id: "t", type: "trigger.model", config: { model: lit("Lead"), on: lit(["create"]) } }
      const flowId = await activeFlow(env.system, flow, owner)
      await runner.activate(flowId)
      return flowId
    }
    const byUser  = await heard("u-user")
    const byAdmin = await heard("u-admin")

    expect((await http().post("/leads").auth("test-token-u-admin").send({ name: "Scored", score: 7 })).status).toBe(201)
    const [userRun]  = await until(async () => { const r = await runsOf(byUser);  return r.length > 0 && r }, "the USER's flow")
    const [adminRun] = await until(async () => { const r = await runsOf(byAdmin); return r.length > 0 && r }, "the administrator's flow")

    expect(userRun.trigger.record).toMatchObject({ name: "Scored" })
    expect("score" in userRun.trigger.record).toBe(false)
    expect(adminRun.trigger.record).toMatchObject({ name: "Scored", score: 7 })
    for (const id of [byUser, byAdmin]) runner.deactivate(id)
  })

  test("a row the owner may not read starts nothing, and the same write starts an owner who may", async () => {
    const heard = async (owner: string) => {
      const flow = chain([])
      flow.nodes.t = { id: "t", type: "trigger.model", config: { model: lit("Memo"), on: lit(["create"]) } }
      const flowId = await activeFlow(env.system, flow, owner)
      await runner.activate(flowId)
      return flowId
    }
    const byUser  = await heard("u-user")
    const byAdmin = await heard("u-admin")

    expect((await http().post("/memos").auth("test-token-u-admin").send({ body: "private" })).status).toBe(201)
    await until(async () => { const r = await runsOf(byAdmin); return r.length > 0 && r }, "the administrator's flow")
    await Bun.sleep(300)
    expect(await runsOf(byUser)).toHaveLength(0)
    for (const id of [byUser, byAdmin]) runner.deactivate(id)
  })

  test("a model trigger naming a model the app does not have does not activate", async () => {
    const flow = chain([])
    flow.nodes.t = { id: "t", type: "trigger.model", config: { model: lit("Leed") } }
    const flowId = await activeFlow(env.system, flow, "u-user")
    await expect(runner.activate(flowId)).rejects.toThrow(/names "Leed", which this app does not have/)
  })
})

// ─── the webhook routes ──────────────────────────────────────────────────────

function hookFlow(path: string, mode: "async" | "sync", steps: any[] = []) {
  const flow = chain(steps)
  flow.nodes.t = { id: "t", type: "trigger.webhook", config: { path: lit(path), mode: lit(mode) } }
  return flow
}

describe("POST /orion/hooks/{path}", () => {
  test("an async webhook answers 202 with its run, and a credential header is not stored", async () => {
    const flowId = await activeFlow(env.system, hookFlow("new-lead", "async", [create("c", "Lead", obj({ name: "From hook" }))]), "u-user")
    await runner.activate(flowId)

    const res = await http().post("/orion/hooks/new-lead").set("authorization", "Bearer secret-token").send({ source: "form" })
    expect(res.status).toBe(202)
    const run = await settled((res.body as any).runId, ["completed", "failed"])
    expect(run.status).toBe("completed")
    expect(run.trigger.body).toEqual({ source: "form" })
    expect(JSON.stringify(run.trigger.headers)).not.toContain("secret-token")
  })

  test("a sync webhook answers with what the flow's http.respond sends", async () => {
    const respond = { id: "r", type: "http.respond", config: { status: lit(201), body: { type: "ref", path: "$.trigger.body" } } }
    const flowId  = await activeFlow(env.system, hookFlow("echo", "sync", [respond]), "u-user")
    await runner.activate(flowId)

    const res = await http().post("/orion/hooks/echo").send({ hello: "world" })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ hello: "world" })
  })

  test("a sync run acts as its owner, not as the anonymous request that started it", async () => {
    // Inside a Caravan job the owner is already in scope; a sync run is not a
    // job, so this is the path that proves the service call enters the owner.
    const call    = { id: "s", type: "service.call", config: { service: lit("invoices"), method: lit("create"), data: obj({ total: 77 }) } }
    const respond = { id: "r", type: "http.respond", config: { status: lit(201), body: { type: "ref", path: "$.s" } } }
    const flowId  = await activeFlow(env.system, hookFlow("admin-invoice", "sync", [call, respond]), "u-admin")
    await runner.activate(flowId)

    const res = await http().post("/orion/hooks/admin-invoice").send({})
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ total: 77 })
  })

  test("a sync flow that waits does not compile, so it does not activate", async () => {
    const flowId = await activeFlow(env.system, hookFlow("waits", "sync", [wait("w", "approval")]), "u-user")
    await expect(runner.activate(flowId)).rejects.toThrow(/cannot run: .*waits, and a flow answering its webhook synchronously cannot/)
  })

  test("a refused signature, an unknown path and a taken path", async () => {
    const flowId = await activeFlow(env.system, hookFlow("signed", "async"), "u-user")
    await runner.activate(flowId)

    expect((await http().post("/orion/hooks/signed").set("x-signature", "bad").send({})).status).toBe(401)
    expect((await http().post("/orion/hooks/nobody").send({})).status).toBe(404)

    const rival = await activeFlow(env.system, hookFlow("signed", "async"), "u-user")
    await expect(runner.activate(rival)).rejects.toThrow(/"signed" belongs to flow/)
  })

  test("a paused flow's webhook is refused with 409", async () => {
    const flowId = await activeFlow(env.system, hookFlow("paused-hook", "async"), "u-user")
    await runner.activate(flowId)
    await env.system.flow.update({ where: { id: flowId }, data: { status: "paused" } })

    expect((await http().post("/orion/hooks/paused-hook").send({})).status).toBe(409)
  })
})

describe("POST /orion/wait/{key}", () => {
  test("resumes the run once, and the key is spent", async () => {
    const flowId = await activeFlow(env.system, chain([wait("w", "approval"), create("c", "Lead", obj({ name: "Approved" }))]), "u-user")
    const runId  = await runner.start(flowId, {})
    const key    = (await settled(runId)).waits[0].resumeKey

    expect((await http().post(`/orion/wait/${key}`).send({ ok: true })).status).toBe(202)
    expect((await settled(runId, ["completed", "failed"])).status).toBe("completed")
    expect((await http().post(`/orion/wait/${key}`).send({ ok: true })).status).toBe(404)
  })
})

// ─── outbound and AI ─────────────────────────────────────────────────────────

describe("the nodes that reach outside the app", () => {
  test("http.request calls through a FlowCredential with its secret, via orion's conduit", async () => {
    await env.system.flowCredential.create({
      data: { name: "crm", provider: "crm", address: `http://127.0.0.1:${target.port}`, auth: "bearer", secret: "sk_flow" },
    })
    const flowId = await activeFlow(env.system, chain([
      { id: "push", type: "http.request", config: { credential: lit("crm"), method: lit("POST"), path: lit("/leads"), body: obj({ name: "Ada" }) } },
    ]), "u-user")

    const run = await settled(await runner.start(flowId, {}), ["completed", "failed"])
    expect(run.status).toBe("completed")
    expect(run.steps.find((s: any) => s.nodeId === "push").output).toMatchObject({ status: 200, ok: true, body: { received: true } })
    expect(hits.at(-1)).toEqual({ path: "/leads", auth: "Bearer sk_flow", body: JSON.stringify({ name: "Ada" }) })
  })

  test("ai asks the app's own model, running as the flow's owner", async () => {
    const flowId = await activeFlow(env.system, chain([
      { id: "ask", type: "ai", config: { model: lit("echo"), mode: lit("complete"), prompt: lit("hello") } },
    ]), "u-admin")

    const run = await settled(await runner.start(flowId, {}), ["completed", "failed"])
    expect(run.status).toBe("completed")
    expect(run.steps.find((s: any) => s.nodeId === "ask").output).toMatchObject({ result: "u-admin: hello", model: "echo" })
  })
})

// ─── the app's jobs and notifications ────────────────────────────────────────

describe("the nodes that hand work to the app", () => {
  test("job.dispatch queues any job the app registers, run as the owner, once per node per run", async () => {
    const flowId = await activeFlow(env.system, chain([
      { id: "touch", type: "job.dispatch", config: { job: lit("leads.touch"), data: obj({ lead: 7 }) } },
    ]), "u-user")
    const runId = await runner.start(flowId, {})
    expect((await settled(runId, ["completed", "failed"])).status).toBe("completed")

    const done = await until(async () => touched.find(t => t.id === `orion:${runId}:touch`), "the job to run")
    expect(done).toEqual({ id: `orion:${runId}:touch`, actorId: "u-user", principal: "u-user", data: { lead: 7 } })

    // What a stage run again after a crash asks for: the same id, no second job.
    await app.jobs.dispatch("leads.touch", { lead: 7 }, { id: `orion:${runId}:touch`, actor: "u-user" })
    await Bun.sleep(150)
    expect(touched.filter(t => t.id === `orion:${runId}:touch`)).toHaveLength(1)
  })

  test("a job the app does not register, or one of orion's own, does not compile", async () => {
    const typo = await activeFlow(env.system, chain([{ id: "d", type: "job.dispatch", config: { job: lit("leads.tuoch") } }]), "u-user")
    await expect(runner.start(typo, {})).rejects.toThrow(/names job "leads.tuoch", which this app does not have \(it has: .*leads\.touch/)

    const own = await activeFlow(env.system, chain([{ id: "d", type: "job.dispatch", config: { job: lit("orion.sweep") } }]), "u-user")
    await expect(runner.start(own, {})).rejects.toThrow(/orion's own job/)
  })

  test("notify sends the app's own notification to an account and to a bare address", async () => {
    const flowId = await activeFlow(env.system, chain([
      { id: "rep",      type: "notify", config: { notification: lit("LeadAssigned"), to: obj({ id: "u-admin" }),                  payload: obj({ lead: "Ada" }) } },
      { id: "outsider", type: "notify", config: { notification: lit("LeadAssigned"), to: obj({ email: "anyone@example.com" }),    payload: obj({ lead: "Ada" }) } },
    ]), "u-user")
    const run = await settled(await runner.start(flowId, {}), ["completed", "failed"])
    expect(run.status).toBe("completed")

    const row = await until(async () => (await env.system.notification.findMany({ where: { userId: "u-admin", type: "LeadAssigned" } }))[0], "the in-app row")
    expect(row.data).toMatchObject({ lead: "Ada" })
    await until(async () => mailed.find(m => m.to === "anyone@example.com"), "the email")
    expect(mailed.find(m => m.to === "anyone@example.com")?.subject).toBe("Lead assigned: Ada")
  })

  test("a notification the app does not declare does not compile", async () => {
    const flowId = await activeFlow(env.system, chain([
      { id: "n", type: "notify", config: { notification: lit("LeadAsigned"), to: obj({ id: "u-admin" }) } },
    ]), "u-user")
    await expect(runner.start(flowId, {})).rejects.toThrow(/names notification "LeadAsigned", which this app does not have \(it has: LeadAssigned\)/)
  })
})
