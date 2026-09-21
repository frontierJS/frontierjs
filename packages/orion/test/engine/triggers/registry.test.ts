import { describe, test, expect } from "bun:test"
import { TriggerRegistry }        from "../../../src/engine/triggers/registry"

function makeRegistry() { return new TriggerRegistry() }

// ─────────────────────────────────────────────
// TRIGGER REGISTRY
// ─────────────────────────────────────────────

describe("TriggerRegistry", () => {
  test("registers and retrieves a webhook entry", () => {
    const reg = makeRegistry()
    reg.register({ kind: "webhook", flowId: "flow_a", version: "1.0.0", nodeId: "t", path: "/hooks/leads", registeredAt: Date.now() })
    const entry = reg.getWebhook("/hooks/leads")
    expect(entry).toBeDefined()
    expect(entry!.flowId).toBe("flow_a")
  })

  test("getWebhook returns undefined for unregistered path", () => {
    expect(makeRegistry().getWebhook("/missing")).toBeUndefined()
  })

  test("registering same flow+node replaces existing entry", () => {
    const reg = makeRegistry()
    const base = { flowId: "flow_a", version: "1.0.0", nodeId: "t", registeredAt: Date.now() }
    reg.register({ ...base, kind: "webhook", path: "/hooks/old" })
    reg.register({ ...base, kind: "webhook", path: "/hooks/new", version: "2.0.0" })

    expect(reg.getWebhook("/hooks/old")).toBeUndefined()
    expect(reg.getWebhook("/hooks/new")).toBeDefined()
    expect(reg.size()).toBe(1)
  })

  test("deregisterFlow removes all entries for a flow", () => {
    const reg = makeRegistry()
    const ts  = Date.now()
    reg.register({ kind: "webhook", flowId: "flow_a", version: "1.0.0", nodeId: "t1", path: "/hooks/a", registeredAt: ts })
    reg.register({ kind: "manual",  flowId: "flow_a", version: "1.0.0", nodeId: "t2", registeredAt: ts })
    reg.register({ kind: "webhook", flowId: "flow_b", version: "1.0.0", nodeId: "t1", path: "/hooks/b", registeredAt: ts })

    const removed = reg.deregisterFlow("flow_a")
    expect(removed).toHaveLength(2)
    expect(reg.getByFlow("flow_a")).toHaveLength(0)
    expect(reg.getByFlow("flow_b")).toHaveLength(1)
  })

  test("deregisterFlow removes webhook from secondary index", () => {
    const reg = makeRegistry()
    reg.register({ kind: "webhook", flowId: "flow_a", version: "1.0.0", nodeId: "t", path: "/hooks/x", registeredAt: Date.now() })
    reg.deregisterFlow("flow_a")
    expect(reg.getWebhook("/hooks/x")).toBeUndefined()
  })

  test("all() returns every registered entry", () => {
    const reg = makeRegistry()
    const ts  = Date.now()
    reg.register({ kind: "manual",  flowId: "flow_a", version: "1.0.0", nodeId: "t", registeredAt: ts })
    reg.register({ kind: "manual",  flowId: "flow_b", version: "1.0.0", nodeId: "t", registeredAt: ts })
    expect(reg.all()).toHaveLength(2)
  })

  test("getCron returns only cron entries for a flow", () => {
    const reg = makeRegistry()
    const ts  = Date.now()
    reg.register({ kind: "cron",    flowId: "flow_a", version: "1.0.0", nodeId: "t1", expression: "* * * * *", jitterMs: 0, registeredAt: ts })
    reg.register({ kind: "manual",  flowId: "flow_a", version: "1.0.0", nodeId: "t2", registeredAt: ts })
    expect(reg.getCron("flow_a")).toHaveLength(1)
  })
})
