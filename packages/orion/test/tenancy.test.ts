/*
 * tenancy.test.ts
 *
 * `FJS-D294`: orion in a tenanted Junction app, under both strategies, through
 * the real plugin, the real services and a real Caravan queue.
 *
 *   strategy database   a real `createTenantRegistry`, two shops, the tenant
 *                       named by a header — `example/`'s shape
 *   strategy row        one client, `extend model` adding the workspace to the
 *                       models orion scopes from, and a principal resolver
 *                       reading the tenant the way `membershipClaim` does —
 *                       `basecamp`'s shape
 *
 * Every assertion that something landed in one tenant is PAIRED with the other
 * tenant's rows, because a run written to nobody passes any test that only looks
 * where it should be.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClient, createTenantRegistry } from "../../litestone/src/index.js"
import { createApp, createService, createStubAuth, request } from "../../junction/index.ts"
import { createCaravan } from "../../caravan/src/index"
import { orion } from "../src/plugin"
import { createRunner, type Runner } from "../src/runner"
import { litestoneHost, tenantOfKey } from "../src/tenancy"
import { SCHEMA, KEY, registryFor, ranIn, chain, count, wait } from "./fixtures/host"
import { lit, obj, create } from "./fixtures/app"

const USERS = [
  { id: "u-user",  role: "member" },
  { id: "u-admin", role: "admin", isAdmin: true },
]
const TOKEN = { user: "test-token-u-user", admin: "test-token-u-admin" }

const LEAD = `
model Lead {
  id    Int    @id
  name  String
  @@gate("4.4.4.4")
}
`

async function settled(db: any, runId: string, statuses = ["completed", "failed", "waiting", "cancelled"]) {
  const until = Date.now() + 5_000
  for (;;) {
    const run = await db.run.findFirst({ where: { id: runId }, include: { waits: true, steps: true } })
    if (run && statuses.includes(run.status)) return run
    if (Date.now() > until) throw new Error(`run ${runId} is ${run?.status ?? "not in this tenant"}`)
    await Bun.sleep(20)
  }
}

// ─── strategy database ───────────────────────────────────────────────────────

describe("strategy database: a tenant is a file", () => {
  let dir: string, registry: any, app: any, runner: Runner

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "orion-tenants-"))
    const path = join(dir, "schema.lite")
    writeFileSync(path, `tenancy { strategy database  dir "${dir}/shops"  registry "${dir}/registry.db"  resolve header("x-shop") }\n${SCHEMA}\n${LEAD}`)
    registry = await createTenantRegistry({ path, encryptionKey: KEY })
    for (const id of ["a", "b"]) await registry.create(id)

    app = createApp({ tenants: registry, auth: createStubAuth({ users: USERS }) })
    app.services.register(createService({ name: "leads", model: "Lead" }))
    app.configure(createCaravan({ db: join(dir, "jobs.db"), pollInterval: 20, heartbeat: 100, lease: 2_000, cleanupAfter: 0 }))
    const suite = registryFor(dir)
    app.configure(orion({ plugins: [{ manifest: suite.plugins().find(p => p.manifest.id === "suite")!.manifest, implementations: [suite.get("test.count")!] }] }))
    await app._startForTest()
    runner = app.orion
  })

  afterAll(async () => {
    await app.jobs.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  const shop = async (id: string) => (await registry.get(id)).asSystem()
  const http = () => request(app)
  const call = (shopId: string, token: string, path: string, method: string, body: unknown = {}) =>
    http().post(path).set("x-shop", shopId).auth(token).set("X-Service-Method", method).send(body as never)

  async function activeIn(shopId: string, definition: unknown) {
    const created = await http().post("/flows").set("x-shop", shopId).auth(TOKEN.user).send({ name: "tenanted" })
    const id = (created.body as any).id as string
    expect((await call(shopId, TOKEN.user, `/flows/${id}`, "save", { definition })).status).toBe(200)
    expect((await call(shopId, TOKEN.admin, `/flows/${id}`, "activate")).status).toBe(200)
    return id
  }

  test("a flow's run, and the row its owner writes, land in the flow's own file", async () => {
    const flow = chain([create("c", "Lead", obj({ name: "for a" }))])
    flow.nodes.t = { id: "t", type: "trigger.manual", config: {} }
    const flowId = await activeIn("a", flow)

    const runId = ((await call("a", TOKEN.user, `/flows/${flowId}`, "run", {})).body as any).runId
    const run   = await settled(await shop("a"), runId)
    expect(run.status).toBe("completed")
    expect(run.actorId).toBe("u-user")

    expect(await (await shop("a")).lead.count({ where: { name: "for a" } })).toBe(1)
    expect(await (await shop("b")).lead.count({})).toBe(0)
    expect(await (await shop("b")).run.count({})).toBe(0)
    expect(await (await shop("b")).flow.count({})).toBe(0)
  })

  test("a model trigger hears writes in its own tenant and no other", async () => {
    const flow = chain([count("heard")])
    flow.nodes.t = { id: "t", type: "trigger.model", config: { model: lit("Lead"), on: lit(["create"]) } }
    const flowId = await activeIn("a", flow)
    const runsOf = async () => (await shop("a")).run.count({ where: { flowVersion: { is: { flowId } } } })

    expect((await http().post("/leads").set("x-shop", "b").auth(TOKEN.user).send({ name: "in b" })).status).toBe(201)
    await Bun.sleep(150)
    expect(await runsOf()).toBe(0)

    expect((await http().post("/leads").set("x-shop", "a").auth(TOKEN.user).send({ name: "in a" })).status).toBe(201)
    const until = Date.now() + 3_000
    while (await runsOf() === 0 && Date.now() < until) await Bun.sleep(20)
    expect(await runsOf()).toBe(1)
    await call("a", TOKEN.admin, `/flows/${flowId}`, "pause")
  })

  test("a resume key carries its tenant, so the resume route needs nothing else", async () => {
    const flow = chain([wait("w", "approval"), count("after")])
    flow.nodes.t = { id: "t", type: "trigger.manual", config: {} }
    const flowId = await activeIn("b", flow)
    const runId  = ((await call("b", TOKEN.user, `/flows/${flowId}`, "run", {})).body as any).runId
    const key    = (await settled(await shop("b"), runId)).waits[0].resumeKey

    expect(tenantOfKey(key)).toBe("b")
    expect((await http().post(`/orion/wait/${key}`).send({ ok: true })).status).toBe(202)
    expect((await settled(await shop("b"), runId, ["completed", "failed"])).status).toBe("completed")
    expect(ranIn(dir, runId)).toEqual({ after: 1 })
  })

  test("a webhook path answers only the tenant whose flow holds it", async () => {
    const flow = chain([count("hooked")])
    flow.nodes.t = { id: "t", type: "trigger.webhook", config: { path: lit("shop-hook") } }
    const flowId = await activeIn("a", flow)

    expect((await http().post("/orion/hooks/shop-hook").set("x-shop", "b").send({})).status).toBe(404)
    const res = await http().post("/orion/hooks/shop-hook").set("x-shop", "a").send({})
    expect(res.status).toBe(202)
    expect((await settled(await shop("a"), (res.body as any).runId)).status).toBe("completed")
    await call("a", TOKEN.admin, `/flows/${flowId}`, "pause")
  })

  test("a second instance's poll and sweep visit every tenant", async () => {
    const hook = (path: string) => { const f = chain([count("x")]); f.nodes.t = { id: "t", type: "trigger.webhook", config: { path: lit(path) } }; return f }
    const inA  = await activeIn("a", hook("poll-a"))
    const inB  = await activeIn("b", hook("poll-b"))

    const other = createRunner({ host: litestoneHost({ registry }), jobs: app.jobs, registry: registryFor(dir) })
    const { activated } = await other.syncActivations()
    expect(activated).toEqual(expect.arrayContaining([inA, inB]))
    expect(other.webhook("poll-a")).toMatchObject({ flowId: inA, tenant: "a" })
    expect(other.webhook("poll-b")).toMatchObject({ flowId: inB, tenant: "b" })

    // A wait past its deadline in one shop, found by a sweep nobody pointed at it.
    const waiting = chain([wait("w", "approval", 1_000)])
    waiting.nodes.t = { id: "t", type: "trigger.manual", config: {} }
    const flowId = await activeIn("b", waiting)
    const runId  = ((await call("b", TOKEN.user, `/flows/${flowId}`, "run", {})).body as any).runId
    await settled(await shop("b"), runId)
    const late = createRunner({ host: litestoneHost({ registry }), jobs: app.jobs, registry: registryFor(dir), now: () => Date.now() + 5_000 })
    expect((await late.sweep()).expired).toBe(1)
    expect((await (await shop("b")).run.findFirst({ where: { id: runId } })).status).toBe("failed")

    // A dispatch lost between the insert and the queue, re-dispatched by a sweep
    // with no request in scope: the job has to carry the tenant itself.
    const counting = chain([count("recovered")])
    counting.nodes.t = { id: "t", type: "trigger.manual", config: {} }
    const lostFlow = await activeIn("b", counting)
    const version  = await (await shop("b")).flowVersion.findFirst({ where: { flowId: lostFlow } })
    const lost     = await (await shop("b")).run.create({ data: { flowVersionId: version.id, trigger: {}, actorId: "u-user" } })
    const later    = createRunner({ host: litestoneHost({ registry }), jobs: app.jobs, registry: registryFor(dir), now: () => Date.now() + 120_000 })
    expect((await later.sweep()).redispatched).toBeGreaterThanOrEqual(1)
    expect(app.jobs.find(`run:${lost.id}`)?.tenant_id).toBe("b")
    expect((await settled(await shop("b"), lost.id)).status).toBe("completed")
    expect(ranIn(dir, lost.id)).toEqual({ recovered: 1 })
    for (const [s, id] of [["a", inA], ["b", inB]] as const) await call(s, TOKEN.admin, `/flows/${id}`, "pause")
  })
})

// ─── strategy row ────────────────────────────────────────────────────────────

describe("strategy row: a tenant is a column", () => {
  let dir: string, db: any, app: any

  // The workspace on the models orion's scoping starts from; every other model
  // reaches one of these through its relation.
  const ROW = `tenancy { strategy row  column workspaceId  claim workspaceId }
${SCHEMA}
extend model Flow           { workspaceId String }
extend model FlowCredential { workspaceId String }
extend model KvEntry        { workspaceId String }
model Lead {
  id          Int    @id
  name        String
  workspaceId String
  @@gate("4.4.4.4")
}
`

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "orion-rows-"))
    db  = await createClient({ schema: ROW, db: join(dir, "app.db"), encryptionKey: KEY, claims: ["workspaceId"] })
    // What `membershipClaim` does for a job: a header for a request, and the
    // tenant `runAs` put in scope for work with no request behind it.
    app = createApp({
      db, auth: createStubAuth({ users: USERS }),
      principal: async (ctx: any) => {
        const tenant = ctx.caller?.headers?.["x-workspace"] ?? ctx.app.tenant()
        return tenant ? { workspaceId: String(tenant) } : {}
      },
    })
    app.services.register(createService({ name: "leads", model: "Lead" }))
    app.configure(createCaravan({ db: join(dir, "jobs.db"), pollInterval: 20, heartbeat: 100, lease: 2_000, cleanupAfter: 0 }))
    app.configure(orion())
    await app._startForTest()
  })

  afterAll(async () => {
    await app.jobs.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  const http = () => request(app)
  const call = (ws: string, token: string, path: string, method: string, body: unknown = {}) =>
    http().post(path).set("x-workspace", ws).auth(token).set("X-Service-Method", method).send(body as never)

  test("a run in one workspace writes that workspace's rows as its owner, and reads none of the other's", async () => {
    const created = await http().post("/flows").set("x-workspace", "w1").auth(TOKEN.user).send({ name: "rows" })
    expect(created.body).toMatchObject({ workspaceId: "w1", ownerId: "u-user" })
    const flowId = (created.body as any).id

    const flow = chain([create("c", "Lead", obj({ name: "for w1" }))])
    flow.nodes.t = { id: "t", type: "trigger.manual", config: {} }
    expect((await call("w1", TOKEN.user, `/flows/${flowId}`, "save", { definition: flow })).status).toBe(200)
    expect((await call("w1", TOKEN.admin, `/flows/${flowId}`, "activate")).status).toBe(200)
    // Another workspace cannot see the flow to act on it.
    expect((await call("w2", TOKEN.user, `/flows/${flowId}`, "run", {})).status).toBe(404)

    const runId = ((await call("w1", TOKEN.user, `/flows/${flowId}`, "run", {})).body as any).runId
    const run   = await settled(db.asSystem(), runId)
    expect(run.status).toBe("completed")

    const leads = await db.asSystem().lead.findMany({ where: { name: "for w1" } })
    expect(leads.map((l: any) => l.workspaceId)).toEqual(["w1"])
    expect((await http().get("/runs").set("x-workspace", "w2").auth(TOKEN.user)).body).toMatchObject({ data: [] })
    expect(((await http().get("/runs").set("x-workspace", "w1").auth(TOKEN.user)).body as any).data.map((r: any) => r.id)).toContain(runId)
  })
})
