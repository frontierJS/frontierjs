/*
 * models.test.ts
 *
 * Phase 4's done-when, as written: a flow writing a field its model does not
 * declare fails to compile, and a flow run as a principal below a model's gate
 * is refused by that gate.
 *
 * The host is `fixtures/app.ts`: two app models gated differently beside
 * orion's own, the catalog read off litestone's JSON Schema, and the actor a
 * client graded by litestone's default resolver. So the refusal asserted below
 * is the Data boundary's, and nothing in orion decides it.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"

import { FlowNotRunnableError } from "../src/runner"
import { chain, activeFlow } from "./fixtures/host"
import { appHost, lit, obj, create, type AppHost } from "./fixtures/app"

let host: AppHost
let env:  any
beforeAll(async () => { host = await appHost(); env = host.env })
afterAll(() => host.stop())

const settled = (runId: string) => host.settled(runId, ["completed", "failed"])

// ─── author time ─────────────────────────────────────────────────────────────

describe("a model node is typed when its flow compiles", () => {
  test("a field the model does not declare fails to compile, naming what it does", async () => {
    const flowId = await activeFlow(env.system, chain([create("c", "Lead", obj({ name: "Ada", rating: 5 }))]), "u-user")
    const refusal = await host.runner.start(flowId, {}).catch((err) => err)

    expect(refusal).toBeInstanceOf(FlowNotRunnableError)
    expect(refusal.message).toMatch(/writes "rating", which Lead does not accept on create \(it accepts: .*name.*\)/)
    const versions = await env.system.flowVersion.findMany({ where: { flowId }, include: { runs: true } })
    expect(versions[0].runs).toEqual([])
  })

  test("a model the app does not have fails to compile", async () => {
    const flowId = await activeFlow(env.system, chain([create("c", "Leed", obj({ name: "Ada" }))]), "u-user")
    await expect(host.runner.start(flowId, {})).rejects.toThrow(/names model "Leed", which this app does not have/)
  })

  test("a model or field set computed at run time cannot be typed, so it does not compile", async () => {
    const byRef = await activeFlow(env.system, chain([create("c", { type: "ref", path: "$.trigger.model" }, obj({ name: "x" }))]), "u-user")
    await expect(host.runner.start(byRef, {})).rejects.toThrow(/must name its model as a literal/)

    const dataRef = await activeFlow(env.system, chain([create("c", "Lead", { type: "ref", path: "$.trigger.lead" })]), "u-user")
    await expect(host.runner.start(dataRef, {})).rejects.toThrow(/field names are written out/)
  })

  test("a field the create schema omits is refused even though the column exists", async () => {
    // The key is server-assigned, so create mode does not offer it.
    const flowId = await activeFlow(env.system, chain([create("c", "Lead", obj({ id: 99, name: "Ada" }))]), "u-user")
    await expect(host.runner.start(flowId, {})).rejects.toThrow(/writes "id"/)
  })
})

// ─── run time ────────────────────────────────────────────────────────────────

describe("a model node writes as the flow's owner", () => {
  test("a USER owner writes a model gated at USER", async () => {
    const flowId = await activeFlow(env.system, chain([create("c", "Lead", obj({ name: "Grace", tier: "gold" }))]), "u-user")
    const run    = await settled(await host.runner.start(flowId, {}))

    expect(run.status).toBe("completed")
    const lead = run.steps.find((s: any) => s.nodeId === "c").output
    expect(lead).toMatchObject({ name: "Grace", tier: "gold" })
    expect(await env.system.lead.findFirst({ where: { id: lead.id } })).toMatchObject({ name: "Grace" })
  })

  test("a USER owner is refused by a model gated at ADMINISTRATOR, and nothing is written", async () => {
    const before = await env.system.invoice.count()
    const flowId = await activeFlow(env.system, chain([create("c", "Invoice", obj({ total: 100 }))]), "u-user")
    const run    = await settled(await host.runner.start(flowId, {}))

    expect(run.status).toBe("failed")
    expect(run.error).toMatch(/"Invoice.create" requires level 5, user has level 4/)
    expect(run.steps.find((s: any) => s.nodeId === "c").status).toBe("failed")
    expect(await env.system.invoice.count()).toBe(before)
  })

  test("the same flow owned by an ADMINISTRATOR writes", async () => {
    const flowId = await activeFlow(env.system, chain([create("c", "Invoice", obj({ total: 250 }))]), "u-admin")
    const run    = await settled(await host.runner.start(flowId, {}))
    expect(run.status).toBe("completed")
  })

  test("patch and remove name the row by the model's own key", async () => {
    const lead   = await env.system.lead.create({ data: { name: "Old" } })
    const flowId = await activeFlow(env.system, chain([
      { id: "p", type: "model.patch",  config: { model: lit("Lead"), id: lit(lead.id), data: obj({ name: "New" }) } },
      { id: "r", type: "model.remove", config: { model: lit("Lead"), id: lit(lead.id) } },
    ]), "u-user")
    const run = await settled(await host.runner.start(flowId, {}))

    expect(run.status).toBe("completed")
    expect(run.steps.find((s: any) => s.nodeId === "p").output).toMatchObject({ name: "New" })
    expect(await env.system.lead.findFirst({ where: { id: lead.id } })).toBeNull()
  })

  test("a step's output is the row as the owner reads it, so a protected column is not in run history", async () => {
    const lead   = await env.system.lead.create({ data: { name: "Guarded", internal: "credit score 812" } })
    const flowId = await activeFlow(env.system, chain([
      { id: "p", type: "model.patch", config: { model: lit("Lead"), id: lit(lead.id), data: obj({ tier: "gold" }) } },
    ]), "u-user")
    const run = await settled(await host.runner.start(flowId, {}))

    expect(run.status).toBe("completed")
    const output = run.steps.find((s: any) => s.nodeId === "p").output
    expect(output).toMatchObject({ name: "Guarded", tier: "gold" })
    expect("internal" in output).toBe(false)
    expect(JSON.stringify(run)).not.toContain("credit score")
  })

  test("an owner who cannot be resolved fails the run by name", async () => {
    const flowId = await activeFlow(env.system, chain([create("c", "Lead", obj({ name: "Nobody" }))]), "u-deleted")
    const run    = await settled(await host.runner.start(flowId, {}))

    expect(run.status).toBe("failed")
    expect(run.error).toMatch(/could not act as "u-deleted": no user "u-deleted"/)
    expect(await env.system.lead.findFirst({ where: { name: "Nobody" } })).toBeNull()
  })
})
