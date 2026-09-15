import { describe, test, expect, vi, beforeAll, afterAll } from "bun:test"
import type { NodeContext } from "../../../src/engine/executor"
import { createNodeImplementations, type NodeDeps } from "../../../src/engine/nodes/index"
import { CodeWorkerPool }    from "../../../src/engine/nodes/code-worker-pool"
import { BUILTIN_DESCRIPTORS } from "../../../src/engine/plugins/builtins"
import type { AIRequest, IAIModels, IJobDispatcher, IKeyValueStore, INotifier, IOutbound, OutboundRequest, Recipient } from "../../../src/engine/ports"

// ─────────────────────────────────────────────
// PORT FAKES
// The engine's ports, in memory. These grade the NODES — what each one asks of
// its port and what it returns. The model-backed key-value store is graded in
// its own suite against a real litestone client.
// ─────────────────────────────────────────────

class MemoryKeyValueStore implements IKeyValueStore {
  private readonly rows = new Map<string, unknown>()
  private id(scope: string, key: string) { return `${scope}\u0000${key}` }
  async get(_actor: unknown, scope: string, key: string)             { return this.rows.get(this.id(scope, key)) }
  async set(_actor: unknown, scope: string, key: string, v: unknown) { this.rows.set(this.id(scope, key), v) }
  async delete(_actor: unknown, scope: string, key: string)          { return this.rows.delete(this.id(scope, key)) }
}

// Records every call and answers what the test says, so a node is graded on the
// request it builds.
class RecordingOutbound implements IOutbound {
  readonly sent: Array<{ actor: unknown; req: OutboundRequest }> = []
  answer: () => Promise<{ status: number; headers: Record<string, string>; body: unknown }> =
    async () => ({ status: 200, headers: { "content-type": "application/json" }, body: { ok: true } })
  async send(actor: unknown, req: OutboundRequest) { this.sent.push({ actor, req }); return this.answer() }
}

class RecordingModels implements IAIModels {
  readonly asked: Array<{ model: string; req: AIRequest }> = []
  async complete(_actor: unknown, model: string, req: AIRequest) {
    this.asked.push({ model, req })
    if (model === "missing") throw new Error('AI model "missing" not registered')
    return { content: "Hello!", model, inputTokens: 10, outputTokens: 5 }
  }
}

class RecordingJobs implements IJobDispatcher {
  readonly queued = new Map<string, { actor: unknown; job: string; data: unknown }>()
  async dispatch(actor: unknown, job: string, data: unknown, { id }: { id: string }) {
    if (!this.queued.has(id)) this.queued.set(id, { actor, job, data })
    return id
  }
}

class RecordingNotifier implements INotifier {
  readonly sent: Array<{ actor: unknown; notification: string; recipient: Recipient; payload: unknown }> = []
  fail = false
  async notify(actor: unknown, notification: string, recipient: Recipient, payload: unknown) {
    if (this.fail) throw new Error("transport email failed")
    this.sent.push({ actor, notification, recipient, payload })
  }
}

// ─────────────────────────────────────────────
// TEST SETUP
// ─────────────────────────────────────────────

let deps:      NodeDeps
let outbound:  RecordingOutbound
let models:    RecordingModels
let jobs:      RecordingJobs
let notifier:  RecordingNotifier
let pool:      CodeWorkerPool
let impls:     ReturnType<typeof createNodeImplementations>

beforeAll(() => {
  pool    = new CodeWorkerPool(2)

  outbound = new RecordingOutbound()
  models   = new RecordingModels()
  jobs     = new RecordingJobs()
  notifier = new RecordingNotifier()

  deps = {
    kv:       new MemoryKeyValueStore(),
    outbound,
    ai:       models,
    jobs,
    notifier,
    codePool: pool,
  }

  impls = createNodeImplementations(deps)
})

afterAll(async () => {
  await pool.drain()
})

function getImpl(type: string) {
  const impl = impls.find(i => i.type === type)
  if (!impl) throw new Error(`No impl for ${type}`)
  return impl
}

function makeCtx(overrides: Partial<NodeContext> = {}): NodeContext {
  return {
    executionId: "exec-1",
    flowId:      "flow-1",
    nodeId:      "node-1",
    attempt:     1,
    config:  {},
    trigger: { test: true },
    nodes:   {},
    logger:  { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    signal:  new AbortController().signal,
    ...overrides,
  }
}

// ─────────────────────────────────────────────
// ONE IMPLEMENTATION PER BUILT-IN DESCRIPTOR
// A descriptor with no implementation compiles and then fails every run.
// ─────────────────────────────────────────────

test("every built-in descriptor has exactly one implementation", () => {
  const implemented = impls.map(i => i.type).sort()
  expect(implemented).toEqual(BUILTIN_DESCRIPTORS.map(d => d.type).sort())
})

// ─────────────────────────────────────────────
// TRIGGER NODES
// ─────────────────────────────────────────────

describe("trigger.webhook", () => {
  test("returns trigger payload as data", async () => {
    const ctx = makeCtx({ trigger: { body: { foo: 1 }, headers: {} } })
    const res = await getImpl("trigger.webhook").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toEqual(ctx.trigger)
  })
})

describe("trigger.cron", () => {
  test("returns trigger payload", async () => {
    const ctx = makeCtx({ trigger: { scheduledAt: 1000, expression: "0 * * * *" } })
    const res = await getImpl("trigger.cron").execute(ctx)
    expect(res.ok).toBe(true)
  })
})

describe("trigger.manual", () => {
  test("returns trigger payload", async () => {
    const ctx = makeCtx({ trigger: { payload: { userId: "u1" } } })
    const res = await getImpl("trigger.manual").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) expect((res.data as any).payload.userId).toBe("u1")
  })
})

describe("trigger.event", () => {
  test("returns trigger payload", async () => {
    const ctx = makeCtx({ trigger: { event: "user.created", payload: {} } })
    const res = await getImpl("trigger.event").execute(ctx)
    expect(res.ok).toBe(true)
  })
})

// ─────────────────────────────────────────────
// TRANSFORM NODES
// ─────────────────────────────────────────────

describe("expr.pipeline", () => {
  test("returns last step as result", async () => {
    const ctx = makeCtx({ config: { steps: [1, 2, 42] } })
    const res = await getImpl("expr.pipeline").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) expect((res.data as any).result).toBe(42)
  })

  test("fails on empty steps", async () => {
    const ctx = makeCtx({ config: { steps: [] } })
    const res = await getImpl("expr.pipeline").execute(ctx)
    expect(res.ok).toBe(false)
  })
})

describe("data.code", () => {
  test("executes simple expression", async () => {
    const ctx = makeCtx({ config: { code: "1 + 2" } })
    const res = await getImpl("data.code").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) expect((res.data as any).result).toBe(3)
  })

  test("has access to nodes in context", async () => {
    const ctx = makeCtx({
      config: { code: "nodes.total * 2" },
      nodes:  { total: 21 } as any,
    })
    const res = await getImpl("data.code").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) expect((res.data as any).result).toBe(42)
  })

  test("returns error for thrown exception", async () => {
    const ctx = makeCtx({ config: { code: "throw new Error('boom')" } })
    const res = await getImpl("data.code").execute(ctx)
    expect(res.ok).toBe(false)
  })

  test("fails on empty code", async () => {
    const ctx = makeCtx({ config: { code: "" } })
    const res = await getImpl("data.code").execute(ctx)
    expect(res.ok).toBe(false)
  })
})

describe("data.template", () => {
  test("interpolates {{variable}} references", async () => {
    const ctx = makeCtx({
      config: { template: "Hello, {{name}}!" },
      nodes:  { name: "World" } as any,
    })
    const res = await getImpl("data.template").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) expect((res.data as any).rendered).toBe("Hello, World!")
  })

  test("nested path interpolation", async () => {
    const ctx = makeCtx({
      config: { template: "User: {{user.name}}" },
      nodes:  { user: { name: "Alice" } } as any,
    })
    const res = await getImpl("data.template").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) expect((res.data as any).rendered).toBe("User: Alice")
  })

  test("unknown variable renders empty string", async () => {
    const ctx = makeCtx({ config: { template: "{{missing}}" }, nodes: {} as any })
    const res = await getImpl("data.template").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) expect((res.data as any).rendered).toBe("")
  })

  test("fails if template is not a string", async () => {
    const ctx = makeCtx({ config: { template: 123 } })
    const res = await getImpl("data.template").execute(ctx)
    expect(res.ok).toBe(false)
  })
})

describe("data.parse", () => {
  test("parses JSON", async () => {
    const ctx = makeCtx({ config: { input: '{"a":1}', format: "json" } })
    const res = await getImpl("data.parse").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) expect((res.data as any).parsed).toEqual({ a: 1 })
  })

  test("parses CSV", async () => {
    const ctx = makeCtx({ config: { input: "name,age\nAlice,30\nBob,25", format: "csv" } })
    const res = await getImpl("data.parse").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) {
      const rows = (res.data as any).parsed
      expect(rows).toHaveLength(2)
      expect(rows[0].name).toBe("Alice")
    }
  })

  test("parses YAML", async () => {
    const ctx = makeCtx({ config: { input: "name: Alice\nage: 30\nactive: true", format: "yaml" } })
    const res = await getImpl("data.parse").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) {
      const parsed = (res.data as any).parsed
      expect(parsed.name).toBe("Alice")
      expect(parsed.age).toBe(30)
      expect(parsed.active).toBe(true)
    }
  })

  test("parses XML", async () => {
    const ctx = makeCtx({ config: { input: "<user><name>Alice</name><age>30</age></user>", format: "xml" } })
    const res = await getImpl("data.parse").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) {
      const parsed = (res.data as any).parsed
      expect(parsed.user).toBeDefined()
    }
  })

  test("fails on invalid JSON", async () => {
    const ctx = makeCtx({ config: { input: "not json", format: "json" } })
    const res = await getImpl("data.parse").execute(ctx)
    expect(res.ok).toBe(false)
  })

  test("fails on unknown format", async () => {
    const ctx = makeCtx({ config: { input: "data", format: "toml" } })
    const res = await getImpl("data.parse").execute(ctx)
    expect(res.ok).toBe(false)
  })
})

// ─────────────────────────────────────────────
// FLOW CONTROL NODES
// ─────────────────────────────────────────────

describe("flow.merge", () => {
  test("always returns ok", async () => {
    const res = await getImpl("flow.merge").execute(makeCtx())
    expect(res.ok).toBe(true)
    if (res.ok) expect((res.data as any).merged).toBe(true)
  })
})

describe("flow.delay", () => {
  test("delays for specified ms", async () => {
    const ctx = makeCtx({ config: { ms: 20 } })
    const start = Date.now()
    const res = await getImpl("flow.delay").execute(ctx)
    expect(res.ok).toBe(true)
    expect(Date.now() - start).toBeGreaterThanOrEqual(15)
    if (res.ok) expect((res.data as any).delayedMs).toBe(20)
  })

  test("fails on negative ms", async () => {
    const ctx = makeCtx({ config: { ms: -1 } })
    const res = await getImpl("flow.delay").execute(ctx)
    expect(res.ok).toBe(false)
  })

  test("fails on non-numeric ms", async () => {
    const ctx = makeCtx({ config: { ms: "lots" } })
    const res = await getImpl("flow.delay").execute(ctx)
    expect(res.ok).toBe(false)
  })
})

describe("flow.each", () => {
  test("returns items array and count", async () => {
    const ctx = makeCtx({ config: { over: [1, 2, 3] } })
    const res = await getImpl("flow.each").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect((res.data as any).count).toBe(3)
      expect((res.data as any).items).toEqual([1, 2, 3])
    }
  })

  test("uses default as and indexKey", async () => {
    const ctx = makeCtx({ config: { over: ["a"] } })
    const res = await getImpl("flow.each").execute(ctx)
    if (res.ok) {
      expect((res.data as any).as).toBe("item")
      expect((res.data as any).indexKey).toBe("index")
    }
  })

  test("fails if over is not an array", async () => {
    const ctx = makeCtx({ config: { over: "not-array" } })
    const res = await getImpl("flow.each").execute(ctx)
    expect(res.ok).toBe(false)
  })
})

describe("flow.wait", () => {
  test("returns __orion_wait sentinel with resumeKey", async () => {
    const ctx = makeCtx({
      executionId: "exec-wait-1",
      config: { event: "approval", timeoutMs: 60000 },
    })
    const res = await getImpl("flow.wait").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) {
      const d = res.data as any
      expect(d.__orion_wait).toBe(true)
      expect(typeof d.resumeKey).toBe("string")
      expect(d.event).toBe("approval")
      expect(d.timeoutAt).toBeDefined()
    }
  })

  test("names where a resume payload lands, and the key is not guessable", async () => {
    const run = () => getImpl("flow.wait").execute(makeCtx({
      executionId: "exec-wait-2",
      config: { event: "payment.confirmed", resumeKey: "payloadKey" },
    }))
    const [a, b] = await Promise.all([run(), run()])
    if (!a.ok || !b.ok) throw new Error("flow.wait failed")
    expect((a.data as any).into).toBe("payloadKey")
    expect((a.data as any).resumeKey).not.toBe((b.data as any).resumeKey)
    expect((a.data as any).resumeKey).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test("null timeoutAt when no timeoutMs", async () => {
    const ctx = makeCtx({
      executionId: "exec-wait-3",
      config: { event: "manual" },
    })
    const res = await getImpl("flow.wait").execute(ctx)
    if (res.ok) expect((res.data as any).timeoutAt).toBeNull()
  })

  test("fails if event is not a string", async () => {
    const ctx = makeCtx({ config: { event: 123 } })
    const res = await getImpl("flow.wait").execute(ctx)
    expect(res.ok).toBe(false)
  })
})

describe("flow.loop", () => {
  test("returns loop metadata", async () => {
    const ctx = makeCtx({ config: { condition: true, maxIter: 50 } })
    const res = await getImpl("flow.loop").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect((res.data as any).maxIter).toBe(50)
      expect((res.data as any).iteration).toBe(0)
    }
  })
})

describe("flow.error", () => {
  test("captures __error from nodes", async () => {
    const ctx = makeCtx({
      config: { capture: "caughtError" },
      nodes:  { __error: { message: "something failed", nodeId: "n1" } } as any,
    })
    const res = await getImpl("flow.error").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect((res.data as any).caughtError).toBe("something failed")
      expect((res.data as any).nodeId).toBe("n1")
    }
  })
})

// ─────────────────────────────────────────────
// HTTP NODES
// ─────────────────────────────────────────────

describe("http.request", () => {
  test("a call names its credential, or it is refused before anything is sent", async () => {
    const before = outbound.sent.length
    const res = await getImpl("http.request").execute(makeCtx({ config: { path: "/v1/leads" } }))
    expect(res.ok).toBe(false)
    expect((res as any).error).toMatch(/credential/)
    expect(outbound.sent.length).toBe(before)
  })

  test("builds the request from config, with a key stable across a re-run of the stage", async () => {
    const actor = { owner: "u1" }
    const res = await getImpl("http.request").execute(makeCtx({
      executionId: "run-9", nodeId: "notify", attempt: 2, actor,
      config: { credential: "crm", method: "post", path: "/v1/leads", body: { name: "Ada" }, headers: { "x-trace": "t" } },
    }))
    expect(res.ok).toBe(true)
    expect(res.ok && res.data).toMatchObject({ status: 200, ok: true, body: { ok: true } })

    const { actor: sentAs, req } = outbound.sent.at(-1)!
    expect(sentAs).toBe(actor)
    expect(req).toEqual({
      credential: "crm", method: "POST", path: "/v1/leads", query: undefined,
      headers: { "x-trace": "t" }, body: { name: "Ada" }, idempotencyKey: "run-9:notify:2",
    })
  })

  test("a non-2xx answer is an output with ok: false, not a node failure", async () => {
    outbound.answer = async () => ({ status: 422, headers: {}, body: { error: "bad" } })
    const res = await getImpl("http.request").execute(makeCtx({ config: { credential: "crm", path: "/x" } }))
    outbound.answer = async () => ({ status: 200, headers: {}, body: { ok: true } })
    expect(res.ok && res.data).toMatchObject({ status: 422, ok: false })
  })

  test("a transport failure fails the node", async () => {
    outbound.answer = async () => { throw new Error("breaker open") }
    const res = await getImpl("http.request").execute(makeCtx({ config: { credential: "crm", path: "/x" } }))
    outbound.answer = async () => ({ status: 200, headers: {}, body: { ok: true } })
    expect(res.ok).toBe(false)
    expect((res as any).error).toMatch(/breaker open/)
  })

  test("a dry run records the request and sends nothing", async () => {
    const before = outbound.sent.length
    const res = await getImpl("http.request").execute(makeCtx({ dryRun: true, config: { credential: "crm", method: "DELETE", path: "/v1/leads/1" } }))
    expect(res.ok && res.data).toMatchObject({ dryRun: true, wouldSend: { credential: "crm", method: "DELETE", path: "/v1/leads/1" } })
    expect(outbound.sent.length).toBe(before)
  })
})

// ─────────────────────────────────────────────
// AI NODE
// ─────────────────────────────────────────────

describe("ai", () => {
  test("asks the named model with the prompt as a message, and the answer lands in the output", async () => {
    const res = await getImpl("ai").execute(makeCtx({
      config: { model: "claude", mode: "complete", prompt: "Say hi", system: "Be brief", maxTokens: 50 },
    }))
    expect(res.ok && res.data).toEqual({ result: "Hello!", model: "claude", usage: { inputTokens: 10, outputTokens: 5 } })
    expect(models.asked.at(-1)).toEqual({
      model: "claude",
      req:   { messages: [{ role: "user", content: "Say hi" }], system: "Be brief", maxTokens: 50 },
    })
  })

  test("a model the app does not have fails the node, naming it", async () => {
    const res = await getImpl("ai").execute(makeCtx({ config: { model: "missing", prompt: "hi" } }))
    expect(res.ok).toBe(false)
    expect((res as any).error).toMatch(/"missing" not registered/)
  })

  test("a missing prompt and a mode other than complete are refused", async () => {
    expect((await getImpl("ai").execute(makeCtx({ config: { model: "claude" } }))).ok).toBe(false)
    const embed = await getImpl("ai").execute(makeCtx({ config: { model: "claude", mode: "embed", prompt: "x" } }))
    expect((embed as any).error).toMatch(/unknown mode "embed"/)
  })

  test("a dry run asks no model", async () => {
    const before = models.asked.length
    const res = await getImpl("ai").execute(makeCtx({ dryRun: true, config: { model: "claude", prompt: "hi" } }))
    expect(res.ok && (res.data as any).dryRun).toBe(true)
    expect(models.asked.length).toBe(before)
  })
})

// ─────────────────────────────────────────────
// STORE NODE
// ─────────────────────────────────────────────

describe("store", () => {
  test("set then get workspace key", async () => {
    const setCtx = makeCtx({ config: { key: "counter", mode: "set", value: 42, scope: "global" } })
    const setRes = await getImpl("store").execute(setCtx)
    expect(setRes.ok).toBe(true)

    const getCtx = makeCtx({ config: { key: "counter", mode: "get", scope: "global" } })
    const getRes = await getImpl("store").execute(getCtx)
    expect(getRes.ok).toBe(true)
    if (getRes.ok) {
      expect((getRes.data as any).value).toBe(42)
      expect((getRes.data as any).found).toBe(true)
    }
  })

  test("get returns found: false for missing key", async () => {
    const ctx = makeCtx({ config: { key: "nonexistent-key", mode: "get", scope: "global" } })
    const res = await getImpl("store").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) expect((res.data as any).found).toBe(false)
  })

  test("delete removes a key", async () => {
    const setCtx = makeCtx({ config: { key: "temp", mode: "set", value: "hello", scope: "global" } })
    await getImpl("store").execute(setCtx)

    const delCtx = makeCtx({ config: { key: "temp", mode: "delete", scope: "global" } })
    const delRes = await getImpl("store").execute(delCtx)
    expect(delRes.ok).toBe(true)
    if (delRes.ok) expect((delRes.data as any).deleted).toBe(true)

    const getCtx = makeCtx({ config: { key: "temp", mode: "get", scope: "global" } })
    const getRes = await getImpl("store").execute(getCtx)
    if (getRes.ok) expect((getRes.data as any).found).toBe(false)
  })

  test("run scope is isolated by run", async () => {
    await getImpl("store").execute(makeCtx({ executionId: "exec-A", config: { key: "x", mode: "set", value: 1, scope: "run" } }))
    const res = await getImpl("store").execute(makeCtx({ executionId: "exec-B", config: { key: "x", mode: "get", scope: "run" } }))
    expect(res.ok && (res.data as any).found).toBe(false)
  })

  test("flow scope, the default, is shared by a flow's runs and isolated from other flows", async () => {
    await getImpl("store").execute(makeCtx({ flowId: "f1", executionId: "r1", config: { key: "seen", mode: "set", value: 3 } }))
    const same  = await getImpl("store").execute(makeCtx({ flowId: "f1", executionId: "r2", config: { key: "seen", mode: "get" } }))
    const other = await getImpl("store").execute(makeCtx({ flowId: "f2", executionId: "r3", config: { key: "seen", mode: "get" } }))
    expect(same.ok && (same.data as any).value).toBe(3)
    expect(other.ok && (other.data as any).found).toBe(false)
  })

  test("an unknown scope is refused", async () => {
    const res = await getImpl("store").execute(makeCtx({ config: { key: "k", mode: "get", scope: "workspace" } }))
    expect(res.ok).toBe(false)
  })

  test("respects custom output key name", async () => {
    const setCtx = makeCtx({ config: { key: "score", mode: "set", value: 0.9, scope: "global" } })
    await getImpl("store").execute(setCtx)

    const getCtx = makeCtx({ config: { key: "score", mode: "get", output: "myScore", scope: "global" } })
    const res = await getImpl("store").execute(getCtx)
    if (res.ok) expect((res.data as any).myScore).toBe(0.9)
  })

  test("fails on empty key", async () => {
    const ctx = makeCtx({ config: { key: "", mode: "get" } })
    const res = await getImpl("store").execute(ctx)
    expect(res.ok).toBe(false)
  })

  test("fails on unknown mode", async () => {
    const ctx = makeCtx({ config: { key: "k", mode: "upsert" } })
    const res = await getImpl("store").execute(ctx)
    expect(res.ok).toBe(false)
  })
})

describe("job.dispatch", () => {
  test("queues the job as the run's actor, under an id a stage run again reuses", async () => {
    const ctx = () => makeCtx({ executionId: "run-9", nodeId: "touch", actor: "owner", config: { job: "leads.touch", data: { id: 4 } } })
    const first  = await getImpl("job.dispatch").execute(ctx())
    const second = await getImpl("job.dispatch").execute(ctx())

    expect(first).toEqual({ ok: true, data: { jobId: "orion:run-9:touch" } })
    expect(second).toEqual(first)
    expect([...jobs.queued.entries()].filter(([id]) => id === "orion:run-9:touch"))
      .toEqual([["orion:run-9:touch", { actor: "owner", job: "leads.touch", data: { id: 4 } }]])
  })

  test("orion's own jobs are refused", async () => {
    const res = await getImpl("job.dispatch").execute(makeCtx({ nodeId: "own", config: { job: "orion.run", data: { runId: "x" } } }))
    expect(res.ok).toBe(false)
    expect([...jobs.queued.values()].some(j => j.job === "orion.run")).toBe(false)
  })

  test("a dry run queues nothing", async () => {
    const res = await getImpl("job.dispatch").execute(makeCtx({ nodeId: "dry", dryRun: true, config: { job: "leads.touch" } }))
    expect(res.ok && (res.data as any).dryRun).toBe(true)
    expect(jobs.queued.has("orion:exec-1:dry")).toBe(false)
  })
})

describe("notify", () => {
  test("sends the named notification to the recipient, as the run's actor", async () => {
    const res = await getImpl("notify").execute(makeCtx({ actor: "owner", config: { notification: "LeadAssigned", to: { email: "rep@example.com" }, payload: { name: "Ada" } } }))
    expect(res).toEqual({ ok: true, data: { sent: true } })
    expect(notifier.sent.at(-1)).toEqual({ actor: "owner", notification: "LeadAssigned", recipient: { email: "rep@example.com" }, payload: { name: "Ada" } })
  })

  test("a recipient that is not an object is refused before anything is sent", async () => {
    const before = notifier.sent.length
    const res    = await getImpl("notify").execute(makeCtx({ config: { notification: "LeadAssigned", to: "rep@example.com" } }))
    expect(res.ok).toBe(false)
    expect(notifier.sent.length).toBe(before)
  })

  test("a failed send is not retried, since a transport may already have delivered", async () => {
    notifier.fail = true
    try {
      const res = await getImpl("notify").execute(makeCtx({ config: { notification: "LeadAssigned", to: { id: "u1" } } }))
      expect(res).toMatchObject({ ok: false, retry: false })
    } finally {
      notifier.fail = false
    }
  })

  test("a dry run sends nothing", async () => {
    const before = notifier.sent.length
    const res    = await getImpl("notify").execute(makeCtx({ dryRun: true, config: { notification: "LeadAssigned", to: { id: "u1" } } }))
    expect(res.ok && (res.data as any).wouldSend).toEqual({ notification: "LeadAssigned", to: { id: "u1" }, payload: null })
    expect(notifier.sent.length).toBe(before)
  })
})
