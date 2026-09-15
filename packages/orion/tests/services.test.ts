/*
 * services.test.ts
 *
 * Phase 5: orion's services in a real Junction app, built by
 * `@frontierjs/testing`'s `createTestEnv` on a real port, with Caravan, channels
 * and a stub auth provider whose users stand at USER(4), ADMINISTRATOR(5) and
 * SYSADMIN(7).
 *
 * Every behavior is asked over HTTP with a bearer token, so the refusals below
 * are junction's resolver and litestone's gate, not this file's. The done-when is
 * the last block: `verifyTransportParity` puts the same calls down HTTP and a
 * WebSocket, for each service and each principal, and expects no mismatch.
 *
 * Calls that start a run are left out of the parity list, because a run is a
 * Caravan job writing to the database after the call answers, and the runner
 * restores a snapshot between the two transports' attempts.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createTestEnv } from "../../testing/src/index.ts"
import { channels, createApp, createStubAuth, request, sessionGateLevel } from "../../junction/index.ts"
import { createCaravan } from "../../caravan/src/index"
import { orion } from "../src/plugin"
import type { Runner } from "../src/runner"
import { KEY, chain, count, wait, registryFor } from "./fixtures/host"
import { APP, lit, obj, create } from "./fixtures/app"

let env:    any
let app:    any
let dir:    string
let runner: Runner

const TOKEN = { user: "test-token-u-user", other: "test-token-u-other", admin: "test-token-u-admin", sys: "test-token-u-sys", manager: "test-token-u-manager" }

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "orion-services-"))
  env = await createTestEnv({
    schema: APP, encryptionKey: KEY, claims: [], listen: true,
    api: ({ db }: any) => {
      const built = createApp({
        db,
        auth: createStubAuth({ users: [
          { id: "u-user",  role: "member" },
          { id: "u-other", role: "member" },
          { id: "u-admin", role: "admin", isAdmin: true },
          { id: "u-sys",   role: "admin", isSystemAdmin: true },
          // An administrator by the APP's mapping alone, as `example`'s shop roles are.
          { id: "u-manager", role: "manager" },
        ] }),
      })
      built.configure(createCaravan({ db: join(dir, "jobs.db"), pollInterval: 20, heartbeat: 100, lease: 2_000, cleanupAfter: 0 }))
      built.configure(channels())
      built.configure(orion({ plugins: [suiteNodes()], level: (u) => u.role === "manager" ? 5 : sessionGateLevel(u) }))
      return built
    },
  })
  app    = env.app
  runner = app.orion
})

afterAll(async () => {
  await env.close()
  rmSync(dir, { recursive: true, force: true })
})

// The fixture's `test.count` node, contributed the way an app contributes one.
function suiteNodes() {
  const registry = registryFor(dir)
  return { manifest: registry.plugins().find(p => p.manifest.id === "suite")!.manifest, implementations: [registry.get("test.count")!] }
}

const http = () => request(app)
const call = (token: string, path: string, method: string, body: unknown = {}) =>
  http().post(path).auth(token).set("X-Service-Method", method).send(body as never)

const manual = (...steps: any[]) => chain(steps)

async function draft(token: string, definition: unknown, name = "suite") {
  const created = await http().post("/flows").auth(token).send({ name })
  expect(created.status).toBe(201)
  const id = (created.body as any).id as string
  const saved = await call(token, `/flows/${id}`, "save", { definition })
  expect(saved.status).toBe(200)
  return id
}

async function settled(runId: string, statuses = ["completed", "failed", "waiting", "cancelled"]) {
  const until = Date.now() + 5_000
  for (;;) {
    const run = await env.system.run.findFirst({ where: { id: runId }, include: { waits: true } })
    if (run && statuses.includes(run.status)) return run
    if (Date.now() > until) throw new Error(`run ${runId} is ${run?.status}`)
    await Bun.sleep(20)
  }
}

// ─── flows ───────────────────────────────────────────────────────────────────

describe("flows: a USER drafts, an administrator activates, the owner runs", () => {
  test("the whole path, each step graded where the rulings put it", async () => {
    const id = await draft(TOKEN.user, manual(create("c", "Lead", obj({ name: "by hand" }))))

    const flow = await http().get(`/flows/${id}`).auth(TOKEN.user)
    expect(flow.body).toMatchObject({ ownerId: "u-user", status: "draft", currentVersion: 1 })

    // Activation is ADMINISTRATOR(5) on the move itself (`FJS-D278`).
    expect((await call(TOKEN.user, `/flows/${id}`, "activate")).status).toBe(403)
    const activated = await call(TOKEN.admin, `/flows/${id}`, "activate")
    expect(activated.status).toBe(200)
    expect(activated.body).toMatchObject({ status: "active", activation: { webhooks: [], events: [] } })

    // By hand, as the owner (`FJS-D292`), and not by another USER.
    expect((await call(TOKEN.other, `/flows/${id}`, "run", { payload: {} })).status).toBe(403)
    const started = await call(TOKEN.user, `/flows/${id}`, "run", { payload: { n: 1 } })
    expect(started.status).toBe(200)
    const run = await settled((started.body as any).runId)
    expect(run.status).toBe("completed")
    expect(run.actorId).toBe("u-user")
    expect(run.trigger).toEqual({ payload: { n: 1 }, by: "u-user" })

    const steps = await call(TOKEN.user, `/runs/${run.id}`, "steps")
    expect((steps.body as any).data.map((s: any) => s.nodeId).sort()).toEqual(["c", "t"])

    const versions = await call(TOKEN.user, `/flows/${id}`, "versions")
    expect((versions.body as any).data).toEqual([expect.objectContaining({ version: 1, authorId: "u-user" })])
  })

  test("only the owner or an administrator changes a flow; an administrator's version names them", async () => {
    const id = await draft(TOKEN.user, manual(count("a")))
    expect((await call(TOKEN.other, `/flows/${id}`, "save", { definition: manual(count("b")) })).status).toBe(403)

    const saved = await call(TOKEN.admin, `/flows/${id}`, "save", { definition: manual(count("b")) })
    expect(saved.body).toEqual({ flowId: id, version: 2, current: true })
    const [latest] = ((await call(TOKEN.user, `/flows/${id}`, "versions")).body as any).data
    expect(latest).toMatchObject({ version: 2, authorId: "u-admin" })
  })

  test("who is an administrator is the app's own mapping, not junction's default", async () => {
    const id = await draft(TOKEN.user, manual(count("a")))
    // `sessionGateLevel` grades a bare role USER(4); the app says 5.
    const saved = await call(TOKEN.manager, `/flows/${id}`, "save", { definition: manual(count("b")) })
    expect(saved.status).toBe(200)
  })

  test("a definition that does not compile is refused with the compiler's sentence", async () => {
    const id  = await draft(TOKEN.user, manual(count("a")))
    const res = await call(TOKEN.user, `/flows/${id}`, "save", { definition: manual({ id: "x", type: "not.a.type", config: {} }) })
    expect(res.status).toBe(400)
    expect((res.body as any).message).toMatch(/not\.a\.type/)
  })

  test("a data.code node is saved by SYSADMIN(7) and nobody below (`FJS-D279`)", async () => {
    const code  = manual({ id: "js", type: "data.code", config: { code: lit("return 1") } })
    const byAdm = await draft(TOKEN.admin, manual(count("a")))
    const refused = await call(TOKEN.admin, `/flows/${byAdm}`, "save", { definition: code })
    expect(refused.status).toBe(403)
    expect((refused.body as any).message).toMatch(/SYSADMIN\(7\)/)

    const bySys = await draft(TOKEN.sys, manual(count("a")))
    expect((await call(TOKEN.sys, `/flows/${bySys}`, "save", { definition: code })).status).toBe(200)
  })

  test("an activation whose trigger cannot register puts the status back", async () => {
    const hook = (path: string) => ({ ...manual(count("a")), nodes: { ...manual(count("a")).nodes, t: { id: "t", type: "trigger.webhook", config: { path: lit(path) } } } })
    const first  = await draft(TOKEN.admin, hook("taken"))
    const second = await draft(TOKEN.admin, hook("taken"))
    expect((await call(TOKEN.admin, `/flows/${first}`, "activate")).status).toBe(200)

    const res = await call(TOKEN.admin, `/flows/${second}`, "activate")
    expect(res.status).toBe(409)
    expect((res.body as any).message).toMatch(/"taken" belongs to flow/)
    expect((await http().get(`/flows/${second}`).auth(TOKEN.admin)).body).toMatchObject({ status: "draft" })
    await call(TOKEN.admin, `/flows/${first}`, "pause")
  })

  test("a flow with no manual trigger cannot be run by hand", async () => {
    const flow = manual(count("a"))
    flow.nodes.t = { id: "t", type: "trigger.webhook", config: { path: lit("no-manual") } }
    const id = await draft(TOKEN.admin, flow)
    await call(TOKEN.admin, `/flows/${id}`, "activate")
    const res = await call(TOKEN.admin, `/flows/${id}`, "run", {})
    expect(res.status).toBe(409)
    expect((res.body as any).message).toMatch(/no trigger\.manual node/)
    await call(TOKEN.admin, `/flows/${id}`, "pause")
  })

  test("pause takes a flow's triggers back on this instance", async () => {
    const flow = manual(count("a"))
    flow.nodes.t = { id: "t", type: "trigger.webhook", config: { path: lit("pausable") } }
    const id = await draft(TOKEN.admin, flow)
    await call(TOKEN.admin, `/flows/${id}`, "activate")
    expect(runner.webhook("pausable")?.flowId).toBe(id)

    const paused = await call(TOKEN.admin, `/flows/${id}`, "pause")
    expect(paused.body).toMatchObject({ status: "paused" })
    expect(runner.webhook("pausable")).toBeUndefined()
  })

  test("export and import round-trip a flow into a new draft the importer owns", async () => {
    const id   = await draft(TOKEN.user, manual(count("a")), "shared")
    const file = (await call(TOKEN.user, `/flows/${id}`, "export")).body as any
    expect(file).toMatchObject({ orion: 1, name: "shared", definition: { nodes: { a: { type: "test.count" } } } })

    const imported = await call(TOKEN.other, "/flows", "import", file)
    expect(imported.status).toBe(200)
    expect(imported.body).toMatchObject({ name: "shared", ownerId: "u-other", status: "draft", currentVersion: 1 })
    expect((await call(TOKEN.user, "/flows", "import", { ...file, orion: 2 })).status).toBe(400)
  })

  test("a dry run by the owner sends nothing and writes no run", async () => {
    const id     = await draft(TOKEN.user, manual(create("c", "Lead", obj({ name: "dry" }))))
    const before = await env.system.run.count()
    const res    = await call(TOKEN.user, `/flows/${id}`, "dryRun", { trigger: {} })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: "completed" })
    expect(await env.system.run.count()).toBe(before)
    expect(await env.system.lead.count({ where: { name: "dry" } })).toBe(0)
  })

  test("the layout is the owner's to move", async () => {
    const id = await draft(TOKEN.user, manual(count("a")))
    expect((await call(TOKEN.user, `/flows/${id}`, "layout")).body).toEqual({ flowId: id, layout: {} })
    expect((await call(TOKEN.other, `/flows/${id}`, "saveLayout", { layout: { a: { x: 1, y: 2 } } })).status).toBe(403)
    await call(TOKEN.user, `/flows/${id}`, "saveLayout", { layout: { a: { x: 1, y: 2 } } })
    await call(TOKEN.user, `/flows/${id}`, "saveLayout", { layout: { a: { x: 3, y: 4 } } })
    expect((await call(TOKEN.other, `/flows/${id}`, "layout")).body).toEqual({ flowId: id, layout: { a: { x: 3, y: 4 } } })
  })
})

// ─── runs ────────────────────────────────────────────────────────────────────

describe("runs", () => {
  test("a waiting run is cancelled by its owner, its key spent; anything else is refused", async () => {
    const id = await draft(TOKEN.user, manual(wait("w", "approval"), count("after")))
    await call(TOKEN.admin, `/flows/${id}`, "activate")
    const runId   = ((await call(TOKEN.user, `/flows/${id}`, "run", {})).body as any).runId
    const waiting = await settled(runId)
    const key     = waiting.waits[0].resumeKey

    expect((await call(TOKEN.other, `/runs/${runId}`, "cancel")).status).toBe(403)
    const cancelled = await call(TOKEN.user, `/runs/${runId}`, "cancel")
    expect(cancelled.status).toBe(200)
    expect(cancelled.body).toMatchObject({ status: "cancelled", error: "cancelled by u-user" })
    expect(await runner.resume(key, {})).toBe(false)

    expect((await call(TOKEN.user, `/runs/${runId}`, "cancel")).status).toBe(409)
    await call(TOKEN.admin, `/flows/${id}`, "pause")
  })

  test("metrics count the runs in the window, by status, for one flow", async () => {
    const id = await draft(TOKEN.user, manual(count("a")))
    await call(TOKEN.admin, `/flows/${id}`, "activate")
    for (let i = 0; i < 3; i++) await settled(((await call(TOKEN.user, `/flows/${id}`, "run", {})).body as any).runId)

    const res = await call(TOKEN.user, "/runs", "metrics", { flowId: id })
    expect(res.body).toMatchObject({ flowId: id, totalRuns: 3, byStatus: { completed: 3 }, successRate: 1 })
    expect(typeof (res.body as any).p95DurationMs).toBe("number")
    await call(TOKEN.admin, `/flows/${id}`, "pause")
  })

  test("a run's history is read at USER(4) and written by nothing but the engine", async () => {
    expect((await http().post("/runs").auth(TOKEN.admin).send({ status: "completed" })).status).toBe(405)
    expect((await http().get("/runs")).status).toBe(401)
  })
})

// ─── named events ────────────────────────────────────────────────────────────

describe("a named event, emitted by the app's own code", () => {
  test("starts every active flow listening for it, each as its own owner", async () => {
    const listening = (owner: string) => {
      const flow = manual(count("heard"))
      flow.nodes.t = { id: "t", type: "trigger.event", config: { event: lit("lead.qualified") } }
      return draft(owner, flow)
    }
    const mine   = await listening(TOKEN.user)
    const theirs = await listening(TOKEN.other)
    for (const id of [mine, theirs]) await call(TOKEN.admin, `/flows/${id}`, "activate")

    const runIds = await runner.emit("lead.qualified", { leadId: 9 })
    expect(runIds).toHaveLength(2)
    const runs = await Promise.all(runIds.map(r => settled(r)))
    expect(runs.map(r => r.actorId).sort()).toEqual(["u-other", "u-user"])
    expect(runs[0].trigger).toEqual({ event: "lead.qualified", payload: { leadId: 9 } })
    expect(await runner.emit("nobody.listens", {})).toEqual([])

    for (const id of [mine, theirs]) await call(TOKEN.admin, `/flows/${id}`, "pause")
    expect(await runner.emit("lead.qualified", {})).toEqual([])
  })
})

// ─── credentials ─────────────────────────────────────────────────────────────

describe("flowCredentials", () => {
  test("an administrator writes one and reads it back without the secret; a USER does neither", async () => {
    const body = { name: "crm-svc", provider: "crm", address: "https://crm.example.com", auth: "bearer", secret: "sk_live" }
    expect((await http().post("/flowCredentials").auth(TOKEN.user).send(body)).status).toBe(403)

    const created = await http().post("/flowCredentials").auth(TOKEN.admin).send(body)
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ name: "crm-svc" })
    expect("secret" in (created.body as object)).toBe(false)
    expect((await http().get("/flowCredentials").auth(TOKEN.user)).status).toBe(403)
  })
})

// ─── the done-when ───────────────────────────────────────────────────────────

describe("transport parity", () => {
  test("every service answers the same calls the same way over HTTP and a WebSocket", async () => {
    const flowId = await draft(TOKEN.user, manual(count("a")), "parity")
    const hook   = manual(count("a"))
    hook.nodes.t = { id: "t", type: "trigger.webhook", config: { path: lit("parity-hook") } }
    const hookId = await draft(TOKEN.user, hook, "parity-hook")
    const runId  = (await env.system.run.findFirst({ select: { id: true } }))?.id
    const credId = (await env.system.flowCredential.findFirst({ select: { id: true } }))?.id

    const found = await env.verifyTransportParity({
      as: [
        { label: "anonymous", token: null },
        { label: "user",      token: TOKEN.user },
        { label: "other",     token: TOKEN.other },
        { label: "admin",     token: TOKEN.admin },
      ],
      calls: [
        { service: "flows", method: "find" },
        { service: "flows", method: "get",        id: flowId },
        { service: "flows", method: "patch",      id: flowId, data: { description: "edited" } },
        { service: "flows", method: "versions",   id: flowId },
        { service: "flows", method: "export",     id: flowId },
        { service: "flows", method: "layout",     id: flowId },
        { service: "flows", method: "saveLayout", id: flowId, data: { layout: { a: { x: 1 } } } },
        { service: "flows", method: "save",       id: flowId, data: { definition: manual(count("b")) } },
        { service: "flows", method: "activate",   id: hookId },
        { service: "flows", method: "archive",    id: flowId },
        { service: "flows", method: "import",     data: { orion: 1, name: "imported", definition: manual(count("a")) } },
        { service: "runs",  method: "find" },
        { service: "runs",  method: "get",        id: runId },
        { service: "runs",  method: "steps",      id: runId },
        { service: "runs",  method: "metrics",    data: { windowMs: 60_000 } },
        { service: "flowCredentials", method: "find" },
        { service: "flowCredentials", method: "get", id: credId },
        { service: "flowCredentials", method: "create", data: { name: "parity-cred", provider: "p", address: "https://p.example.com" } },
      ],
    })
    expect(found).toEqual([])
    runner.deactivate(hookId)
  }, 60_000)
})
