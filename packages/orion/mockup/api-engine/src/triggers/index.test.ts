import { describe, test, expect, vi, beforeEach, afterEach } from "vitest"
import { TriggerRegistry }   from "./registry"
import { CronScheduler, parseCron, getNextCronMs, InvalidCronError } from "./cron"
import { TriggerRouter }     from "./router"
import { WorkflowActivator } from "./activator"
import { EventBus }          from "../events"
import { InMemoryQueue, QueueFullError } from "../runtime/queue"
import { InMemoryPlanCache } from "../runtime/store"
import type { Flow, ExecutionPlan, ExecutionStage } from "../types"
import type { CompilerResult } from "../compiler"
import type { ICompiler }     from "./activator"

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function makeQueue(capacity = 100) { return new InMemoryQueue(capacity) }
function makePlans()               { return new InMemoryPlanCache() }
function makeRegistry()            { return new TriggerRegistry() }

function makeFlow(overrides: Partial<Flow> & { nodes?: Flow["nodes"] } = {}): Flow {
  return {
    id:          "flow_test",
    version:     "1.0.0",
    name:        "Test Flow",
    accountId:   "acc_1",
    workspaceId: "ws_1",
    createdBy:   "user_1",
    createdAt:   Date.now(),
    updatedAt:   Date.now(),
    nodes: {
      t: { id: "t", type: "trigger.manual", config: {} },
    },
    edges: [],
    ...overrides,
  }
}

function makeWebhookFlow(path: string): Flow {
  return makeFlow({
    nodes: { t: { id: "t", type: "trigger.webhook", config: { path: { type: "literal", value: path } } } },
  })
}

function makeCronFlow(expression: string): Flow {
  return makeFlow({
    nodes: { t: { id: "t", type: "trigger.cron", config: { expression: { type: "literal", value: expression } } } },
  })
}

function makeEventFlow(eventName: string): Flow {
  return makeFlow({
    nodes: { t: { id: "t", type: "trigger.event", config: { event: { type: "literal", value: eventName } } } },
  })
}

function makePlan(flow: Flow): ExecutionPlan {
  const nodeIds   = Object.keys(flow.nodes)
  const triggerIds = nodeIds.filter(id => flow.nodes[id]!.type.startsWith("trigger."))
  const stage: ExecutionStage = { index: 0, nodes: nodeIds, edges: {} }

  return {
    flowId:       flow.id,
    version:      flow.version,
    compiledAt:   Date.now(),
    stages:       [stage],
    nodes:        flow.nodes,
    triggerIds,
    statics:      {},
    routing:      {},
    nodeCount:    nodeIds.length,
    stageCount:   1,
    hasBranching: false,
    hasFanOut:    false,
  }
}

function makeCompiler(failFlowIds: string[] = []): ICompiler {
  return {
    compile(flow: Flow): CompilerResult {
      if (failFlowIds.includes(flow.id)) {
        return { ok: false, errors: [{ code: "NO_NODES", message: "forced failure" }] }
      }
      return { ok: true, plan: makePlan(flow) }
    },
  }
}

function makeRequest(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body:    body !== undefined ? JSON.stringify(body) : undefined,
  })
}

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

// ─────────────────────────────────────────────
// CRON PARSER
// ─────────────────────────────────────────────

describe("parseCron", () => {
  test("parses wildcard expression", () => {
    const f = parseCron("* * * * *")
    expect(f.minute).toHaveLength(60)
    expect(f.hour).toHaveLength(24)
  })

  test("parses specific values", () => {
    const f = parseCron("30 9 1 6 1")
    expect(f.minute).toEqual([30])
    expect(f.hour).toEqual([9])
    expect(f.dayOfMonth).toEqual([1])
    expect(f.month).toEqual([6])
    expect(f.dayOfWeek).toEqual([1])
  })

  test("parses step expressions", () => {
    const f = parseCron("*/5 */2 * * *")
    expect(f.minute).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
    expect(f.hour).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22])
  })

  test("parses range expressions", () => {
    const f = parseCron("0 9-17 * * 1-5")
    expect(f.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect(f.dayOfWeek).toEqual([1, 2, 3, 4, 5])
  })

  test("parses list expressions", () => {
    const f = parseCron("0 8,12,18 * * *")
    expect(f.hour).toEqual([8, 12, 18])
  })

  test("throws InvalidCronError for wrong field count", () => {
    expect(() => parseCron("* * * *")).toThrow(InvalidCronError)
    expect(() => parseCron("* * * * * *")).toThrow(InvalidCronError)
  })

  test("throws InvalidCronError for out-of-range value", () => {
    expect(() => parseCron("60 * * * *")).toThrow(InvalidCronError)
    expect(() => parseCron("* 24 * * *")).toThrow(InvalidCronError)
  })

  test("throws InvalidCronError for invalid step", () => {
    expect(() => parseCron("*/0 * * * *")).toThrow(InvalidCronError)
  })
})

describe("getNextCronMs", () => {
  test("returns positive number of milliseconds", () => {
    const ms = getNextCronMs("* * * * *")
    expect(ms).toBeGreaterThan(0)
    expect(ms).toBeLessThanOrEqual(60_000)
  })

  test("every-minute expression fires within 60s", () => {
    const ms = getNextCronMs("* * * * *")
    expect(ms).toBeLessThanOrEqual(60_000)
  })

  test("specific future time returns correct approximate delay", () => {
    // Fire at minute 0 of every hour — from a known reference point
    const from  = new Date("2024-01-01T10:30:00.000Z")
    const ms    = getNextCronMs("0 * * * *", from)
    // Next fire is 10:31→11:00 = 30 minutes
    expect(ms).toBeCloseTo(30 * 60 * 1000, -4)
  })

  test("throws for pathological expression", () => {
    // Feb 31 never exists
    expect(() => getNextCronMs("0 0 31 2 *")).toThrow()
  })
})

// ─────────────────────────────────────────────
// CRON SCHEDULER
// ─────────────────────────────────────────────

describe("CronScheduler", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(()  => { vi.useRealTimers() })

  test("register returns a jitter value 0–2000ms", () => {
    const sched   = new CronScheduler(makeQueue())
    const jitter  = sched.register("flow_a", "1.0.0", "t", "* * * * *")
    expect(jitter).toBeGreaterThanOrEqual(0)
    expect(jitter).toBeLessThan(2000)
  })

  test("register with explicit jitter stores it correctly", () => {
    const queue  = makeQueue()
    const sched  = new CronScheduler(queue)
    const jitter = sched.register("flow_a", "1.0.0", "t", "* * * * *", 500)
    expect(jitter).toBe(500)
    expect(sched.activeCount()).toBe(1)
  })

  test("fires job into queue after cron interval", async () => {
    const queue = makeQueue()
    const sched = new CronScheduler(queue)

    sched.register("flow_a", "1.0.0", "t", "* * * * *", 0)  // no jitter

    // Advance past one minute
    await vi.advanceTimersByTimeAsync(61_000)

    expect(queue.size()).toBeGreaterThanOrEqual(1)
    const job = await queue.dequeue()
    expect(job?.flowId).toBe("flow_a")
  })

  test("job trigger contains cron expression and firedAt", async () => {
    const queue = makeQueue()
    const sched = new CronScheduler(queue)

    sched.register("flow_a", "1.0.0", "t", "* * * * *", 0)
    await vi.advanceTimersByTimeAsync(61_000)

    const job = await queue.dequeue()
    const trigger = job?.trigger as { cron: string; firedAt: number }
    expect(trigger.cron).toBe("* * * * *")
    expect(typeof trigger.firedAt).toBe("number")
  })

  test("deregister cancels all timers for a flow", async () => {
    const queue = makeQueue()
    const sched = new CronScheduler(queue)

    sched.register("flow_a", "1.0.0", "t", "* * * * *", 0)
    sched.deregister("flow_a")

    await vi.advanceTimersByTimeAsync(120_000)
    expect(queue.size()).toBe(0)
    expect(sched.activeCount()).toBe(0)
  })

  test("re-registering a node cancels the old timer", async () => {
    const queue = makeQueue()
    const sched = new CronScheduler(queue)

    sched.register("flow_a", "1.0.0", "t", "* * * * *", 0)
    sched.register("flow_a", "2.0.0", "t", "* * * * *", 0)  // re-register

    expect(sched.activeCount()).toBe(1)  // still only one handle
  })

  test("queue full does not crash the scheduler", async () => {
    const queue = makeQueue(0)  // zero capacity
    const sched = new CronScheduler(queue)

    sched.register("flow_a", "1.0.0", "t", "* * * * *", 0)
    // Should not throw
    await expect(vi.advanceTimersByTimeAsync(61_000)).resolves.not.toThrow()
  })
})

// ─────────────────────────────────────────────
// TRIGGER ROUTER
// ─────────────────────────────────────────────

describe("TriggerRouter — webhook", () => {
  function makeRouter() {
    const queue    = makeQueue()
    const plans    = makePlans()
    const registry = makeRegistry()
    const eventBus = new EventBus(queue)
    const router   = new TriggerRouter(queue, plans, registry, eventBus)
    return { queue, plans, registry, eventBus, router }
  }

  test("POST /hooks/path enqueues job and returns 202", async () => {
    const { queue, registry, router } = makeRouter()
    registry.register({ kind: "webhook", flowId: "flow_a", version: "1.0.0", nodeId: "t", path: "/hooks/leads", registeredAt: Date.now() })

    const res = await router.handle(makeRequest("POST", "/hooks/leads", { email: "a@b.com" }))
    expect(res.status).toBe(202)

    const body = await res.json() as { accepted: boolean; executionId: string }
    expect(body.accepted).toBe(true)
    expect(body.executionId).toBeDefined()
    expect(queue.size()).toBe(1)
  })

  test("POST /hooks/path with unknown path returns 404", async () => {
    const { router } = makeRouter()
    const res = await router.handle(makeRequest("POST", "/hooks/unknown"))
    expect(res.status).toBe(404)
  })

  test("returns 503 when queue is full", async () => {
    const queue    = makeQueue(0)
    const registry = makeRegistry()
    const eventBus = new EventBus(queue)
    const router   = new TriggerRouter(queue, makePlans(), registry, eventBus)

    registry.register({ kind: "webhook", flowId: "flow_a", version: "1.0.0", nodeId: "t", path: "/hooks/a", registeredAt: Date.now() })

    const res = await router.handle(makeRequest("POST", "/hooks/a", {}))
    expect(res.status).toBe(503)
  })

  test("enqueued job contains trigger payload", async () => {
    const { queue, registry, router } = makeRouter()
    registry.register({ kind: "webhook", flowId: "flow_a", version: "1.0.0", nodeId: "t", path: "/hooks/x", registeredAt: Date.now() })

    await router.handle(makeRequest("POST", "/hooks/x", { score: 0.9 }))

    const job = await queue.dequeue()
    const trigger = job?.trigger as { body: unknown }
    expect(trigger.body).toEqual({ score: 0.9 })
  })
})

describe("TriggerRouter — event emit", () => {
  function makeRouter() {
    const queue    = makeQueue()
    const eventBus = new EventBus(queue)
    const router   = new TriggerRouter(queue, makePlans(), makeRegistry(), eventBus)
    return { queue, eventBus, router }
  }

  test("POST /events/:name fans out to subscribers", async () => {
    const { queue, eventBus, router } = makeRouter()
    eventBus.subscribe("user.created", "flow_a", "1.0.0")
    eventBus.subscribe("user.created", "flow_b", "1.0.0")

    const res  = await router.handle(makeRequest("POST", "/events/user.created", { userId: "u_1" }))
    const body = await res.json() as { accepted: boolean; subscribers: number }

    expect(res.status).toBe(202)
    expect(body.accepted).toBe(true)
    expect(body.subscribers).toBe(2)
    expect(queue.size()).toBe(2)
  })

  test("POST /events/:name with no subscribers still returns 202", async () => {
    const { router } = makeRouter()
    const res = await router.handle(makeRequest("POST", "/events/unknown"))
    expect(res.status).toBe(202)
  })
})

describe("TriggerRouter — mapped webhook", () => {
  test("POST /webhooks/:path maps to event and fans out", async () => {
    const queue    = makeQueue()
    const eventBus = new EventBus(queue)
    const router   = new TriggerRouter(queue, makePlans(), makeRegistry(), eventBus)

    eventBus.subscribe("stripe.payment_intent.succeeded", "flow_stripe", "1.0.0")
    eventBus.registerMapper({
      path: "/webhooks/stripe",
      map:  (body: unknown) => {
        const b = body as { type: string; data: { object: unknown } }
        return { name: `stripe.${b.type}`, payload: b.data.object }
      },
    })

    const res = await router.handle(makeRequest("POST", "/webhooks/stripe", {
      type: "payment_intent.succeeded",
      data: { object: { amount: 5000 } },
    }))

    expect(res.status).toBe(202)
    expect(queue.size()).toBe(1)
  })

  test("POST /webhooks/:path with no mapper returns 404", async () => {
    const queue  = makeQueue()
    const router = new TriggerRouter(queue, makePlans(), makeRegistry(), new EventBus(queue))
    const res    = await router.handle(makeRequest("POST", "/webhooks/unknown"))
    expect(res.status).toBe(404)
  })
})

describe("TriggerRouter — manual trigger", () => {
  test("POST /flows/:id/trigger enqueues job", async () => {
    const { queue, registry, router } = (() => {
      const queue    = makeQueue()
      const registry = makeRegistry()
      const router   = new TriggerRouter(queue, makePlans(), registry, new EventBus(queue))
      return { queue, registry, router }
    })()

    registry.register({ kind: "manual", flowId: "flow_x", version: "2.0.0", nodeId: "t", registeredAt: Date.now() })

    const res  = await router.handle(makeRequest("POST", "/flows/flow_x/trigger", { test: true }))
    const body = await res.json() as { accepted: boolean }

    expect(res.status).toBe(202)
    expect(body.accepted).toBe(true)
    expect(queue.size()).toBe(1)
  })

  test("POST /flows/:id/trigger returns 404 for inactive flow", async () => {
    const queue  = makeQueue()
    const router = new TriggerRouter(queue, makePlans(), makeRegistry(), new EventBus(queue))
    const res    = await router.handle(makeRequest("POST", "/flows/missing/trigger"))
    expect(res.status).toBe(404)
  })
})

describe("TriggerRouter — admin", () => {
  function makeRouter() {
    const queue    = makeQueue()
    const registry = makeRegistry()
    const router   = new TriggerRouter(queue, makePlans(), registry, new EventBus(queue))
    return { queue, registry, router }
  }

  test("GET /admin/health returns system status", async () => {
    const { router } = makeRouter()
    const res  = await router.handle(makeRequest("GET", "/admin/health"))
    const body = await res.json() as { status: string; queue: { depth: number } }

    expect(res.status).toBe(200)
    expect(body.status).toBe("ok")
    expect(body.queue.depth).toBe(0)
  })

  test("GET /admin/health reflects queue depth", async () => {
    const { queue, registry, router } = makeRouter()
    registry.register({ kind: "webhook", flowId: "f", version: "1.0.0", nodeId: "t", path: "/hooks/h", registeredAt: Date.now() })
    await router.handle(makeRequest("POST", "/hooks/h", {}))

    const res  = await router.handle(makeRequest("GET", "/admin/health"))
    const body = await res.json() as { queue: { depth: number } }
    expect(body.queue.depth).toBe(1)
  })

  test("GET /admin/triggers lists all registered triggers", async () => {
    const { registry, router } = makeRouter()
    registry.register({ kind: "manual", flowId: "flow_a", version: "1.0.0", nodeId: "t", registeredAt: Date.now() })
    registry.register({ kind: "manual", flowId: "flow_b", version: "1.0.0", nodeId: "t", registeredAt: Date.now() })

    const res  = await router.handle(makeRequest("GET", "/admin/triggers"))
    const body = await res.json() as { triggers: unknown[] }

    expect(res.status).toBe(200)
    expect(body.triggers).toHaveLength(2)
  })

  test("unknown route returns 404", async () => {
    const { router } = makeRouter()
    const res = await router.handle(makeRequest("GET", "/not/a/route"))
    expect(res.status).toBe(404)
  })
})

// ─────────────────────────────────────────────
// WORKFLOW ACTIVATOR
// ─────────────────────────────────────────────

describe("WorkflowActivator — activate", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(()  => vi.useRealTimers())

  function makeActivator(failIds: string[] = []) {
    const queue    = makeQueue()
    const plans    = makePlans()
    const registry = makeRegistry()
    const cron     = new CronScheduler(queue)
    const eventBus = new EventBus(queue)
    const router   = new TriggerRouter(queue, plans, registry, eventBus)
    const activator = new WorkflowActivator(makeCompiler(failIds), plans, router, cron, eventBus, registry)
    return { queue, plans, registry, cron, eventBus, activator }
  }

  test("compiles flow and caches plan", async () => {
    const { plans, activator } = makeActivator()
    const flow = makeWebhookFlow("/hooks/test")

    const results = await activator.activate([flow])
    expect(results[0]!.ok).toBe(true)
    expect(plans.get(flow.id, flow.version)).toBeDefined()
  })

  test("reports compile failure without crashing other flows", async () => {
    const { activator } = makeActivator(["flow_bad"])
    const good = makeFlow({ id: "flow_good" })
    const bad  = makeFlow({ id: "flow_bad" })

    const results = await activator.activate([good, bad])
    expect(results.find(r => r.flowId === "flow_good")!.ok).toBe(true)
    expect(results.find(r => r.flowId === "flow_bad")!.ok).toBe(false)
    expect(results.find(r => r.flowId === "flow_bad")!.error).toBeDefined()
  })

  test("registers webhook trigger in registry", async () => {
    const { registry, activator } = makeActivator()
    const flow = makeWebhookFlow("/hooks/leads")

    await activator.activate([flow])

    expect(registry.getWebhook("/hooks/leads")).toBeDefined()
    expect(registry.getWebhook("/hooks/leads")!.flowId).toBe(flow.id)
  })

  test("registers cron trigger in registry + scheduler", async () => {
    const { registry, cron, activator } = makeActivator()
    const flow = makeCronFlow("* * * * *")

    await activator.activate([flow])

    expect(registry.getCron(flow.id)).toHaveLength(1)
    expect(cron.activeCount()).toBe(1)
  })

  test("registers event trigger in eventBus + registry", async () => {
    const { registry, eventBus, activator } = makeActivator()
    const flow = makeEventFlow("user.created")

    await activator.activate([flow])

    expect(registry.getEvent(flow.id)).toHaveLength(1)
    expect(eventBus.subscribers("user.created")["user.created"]).toHaveLength(1)
  })

  test("registers manual trigger in registry", async () => {
    const { registry, activator } = makeActivator()
    const flow = makeFlow()  // default has manual trigger

    await activator.activate([flow])

    expect(registry.getByFlow(flow.id).some(e => e.kind === "manual")).toBe(true)
  })

  test("reports trigger count", async () => {
    const { activator } = makeActivator()
    const result = await activator.activate([makeWebhookFlow("/hooks/x")])
    expect(result[0]!.triggers).toBe(1)
  })
})

describe("WorkflowActivator — hot reload", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(()  => vi.useRealTimers())

  function makeActivator() {
    const queue    = makeQueue()
    const plans    = makePlans()
    const registry = makeRegistry()
    const cron     = new CronScheduler(queue)
    const eventBus = new EventBus(queue)
    const router   = new TriggerRouter(queue, plans, registry, eventBus)
    const activator = new WorkflowActivator(makeCompiler(), plans, router, cron, eventBus, registry)
    return { queue, plans, registry, cron, eventBus, activator }
  }

  test("reload removes old webhook and registers new path", async () => {
    const { registry, activator } = makeActivator()

    const v1 = makeWebhookFlow("/hooks/old")
    await activator.activate([v1])
    expect(registry.getWebhook("/hooks/old")).toBeDefined()

    const v2 = { ...makeWebhookFlow("/hooks/new"), id: v1.id, version: "2.0.0" }
    await activator.reload(v2)

    expect(registry.getWebhook("/hooks/old")).toBeUndefined()
    expect(registry.getWebhook("/hooks/new")).toBeDefined()
  })

  test("reload cancels old cron and registers new one", async () => {
    const { cron, activator } = makeActivator()

    await activator.activate([makeCronFlow("* * * * *")])
    expect(cron.activeCount()).toBe(1)

    await activator.reload({ ...makeCronFlow("0 * * * *"), version: "2.0.0" })
    expect(cron.activeCount()).toBe(1)  // still one — old replaced
  })

  test("reload removes old event subscription and adds new one", async () => {
    const { eventBus, activator } = makeActivator()

    await activator.activate([makeEventFlow("user.created")])
    expect(eventBus.subscribers("user.created")["user.created"]).toHaveLength(1)

    await activator.reload({ ...makeEventFlow("user.updated"), version: "2.0.0" })

    // Old subscription gone
    const oldSubs = eventBus.subscribers("user.created")["user.created"]
    expect(oldSubs).toBeUndefined()
    // New subscription present
    expect(eventBus.subscribers("user.updated")["user.updated"]).toHaveLength(1)
  })

  test("reload invalidates old plan and stores new one", async () => {
    const { plans, activator } = makeActivator()

    const flow = makeWebhookFlow("/hooks/x")
    await activator.activate([flow])

    const newFlow = { ...makeWebhookFlow("/hooks/x"), version: "2.0.0" }
    await activator.reload(newFlow)

    expect(plans.get(flow.id, "1.0.0")).toBeUndefined()
    expect(plans.get(flow.id, "2.0.0")).toBeDefined()
  })

  test("deactivate removes all triggers and invalidates plan", async () => {
    const { registry, plans, cron, eventBus, activator } = makeActivator()

    const flow = makeEventFlow("user.created")
    await activator.activate([flow])

    await activator.deactivate(flow.id)

    expect(registry.getByFlow(flow.id)).toHaveLength(0)
    expect(plans.get(flow.id, flow.version)).toBeUndefined()
    expect(cron.activeCount()).toBe(0)
    const subs = eventBus.subscribers("user.created")["user.created"]
    expect(!subs || subs.length === 0).toBe(true)
  })
})
