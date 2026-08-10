import { describe, test, expect, vi, beforeAll, afterAll } from "vitest"
import type { NodeContext } from "../executor"
import { createNodeImplementations, type NodeDeps } from "./index"
import { KVStore }           from "../store/kv"
import { WaitRegistry }      from "../store/wait"
import { AIProviderRegistry } from "./providers"
import { CodeWorkerPool }    from "./code-worker-pool"
import { createSqlJsDatabase, runMigrations } from "../store/db"
import type { IDatabase }    from "../store/db"

// ─────────────────────────────────────────────
// TEST SETUP
// ─────────────────────────────────────────────

let db:        IDatabase
let deps:      NodeDeps
let pool:      CodeWorkerPool
let impls:     ReturnType<typeof createNodeImplementations>

beforeAll(async () => {
  db   = await createSqlJsDatabase()
  await runMigrations(db)

  pool = new CodeWorkerPool(2)

  deps = {
    kv:          new KVStore(db),
    waitReg:     new WaitRegistry(db),
    aiProviders: new AIProviderRegistry(),
    workspaceId: "ws-test",
    codePool:    pool,
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
    config:  {},
    trigger: { test: true },
    nodes:   {},
    logger:  { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    fetch:   fetch,
    signal:  new AbortController().signal,
    ...overrides,
  }
}

// ─────────────────────────────────────────────
// ALL 18 TYPES ARE REGISTERED
// ─────────────────────────────────────────────

test("createNodeImplementations returns 18 implementations", () => {
  expect(impls).toHaveLength(18)
})

test("all required types are present", () => {
  const types = new Set(impls.map(i => i.type))
  const expected = [
    "trigger.webhook", "trigger.cron", "trigger.manual", "trigger.event",
    "expr.pipeline", "data.code", "data.template", "data.parse",
    "flow.merge", "flow.delay", "flow.each", "flow.wait", "flow.loop", "flow.error",
    "http.request", "http.respond",
    "ai",
    "store",
  ]
  for (const t of expected) expect(types.has(t)).toBe(true)
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
      expect(d.resumeKey.length).toBe(21)
      expect(d.event).toBe("approval")
      expect(d.timeoutAt).toBeDefined()
    }
  })

  test("registers wait entry in WaitRegistry", async () => {
    const ctx = makeCtx({
      executionId: "exec-wait-2",
      config: { event: "payment.confirmed", resumeKey: "payloadKey" },
    })
    const res = await getImpl("flow.wait").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) {
      const key   = (res.data as any).resumeKey
      const entry = deps.waitReg.getByKey(key)
      expect(entry).toBeDefined()
      expect(entry?.executionId).toBe("exec-wait-2")
      expect(entry?.resumeCtxKey).toBe("payloadKey")
    }
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
  test("fails if url is empty", async () => {
    const ctx = makeCtx({ config: { url: "" } })
    const res = await getImpl("http.request").execute(ctx)
    expect(res.ok).toBe(false)
    expect((res as any).error).toMatch(/url/)
  })

  test("makes a real GET request", async () => {
    const ctx = makeCtx({ config: { url: "https://httpbin.org/get", method: "GET" } })
    const res = await getImpl("http.request").execute(ctx)
    // May fail in network-restricted CI — just check shape
    if (res.ok) {
      expect(typeof (res.data as any).status).toBe("number")
      expect(typeof (res.data as any).ok).toBe("boolean")
    }
  }, 10_000)

  test("mock fetch returns structured response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ hello: "world" }), {
        status: 200, headers: { "content-type": "application/json" },
      })
    )
    const ctx = makeCtx({ config: { url: "https://example.com/api", method: "GET" }, fetch: mockFetch })
    const res = await getImpl("http.request").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect((res.data as any).status).toBe(200)
      expect((res.data as any).body).toEqual({ hello: "world" })
      expect((res.data as any).ok).toBe(true)
    }
  })

  test("sends POST body as JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("{}", { status: 201, headers: { "content-type": "application/json" } })
    )
    const ctx = makeCtx({
      config: { url: "https://api.example.com", method: "POST", body: { key: "value" } },
      fetch:  mockFetch,
    })
    await getImpl("http.request").execute(ctx)
    const [, init] = mockFetch.mock.calls[0]!
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body)).toEqual({ key: "value" })
  })

  test("returns ok: false on non-2xx but still resolves", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("Not Found", { status: 404 })
    )
    const ctx = makeCtx({ config: { url: "https://example.com", method: "GET" }, fetch: mockFetch })
    const res = await getImpl("http.request").execute(ctx)
    expect(res.ok).toBe(true)  // node succeeded; caller checks data.ok
    if (res.ok) expect((res.data as any).ok).toBe(false)
  })
})

describe("http.respond", () => {
  test("calls respond() in sync mode", async () => {
    const responded: unknown[] = []
    const ctx = makeCtx({
      config:  { status: 200, body: { success: true } },
      respond: (res) => { responded.push(res) },
    })
    const res = await getImpl("http.respond").execute(ctx)
    expect(res.ok).toBe(true)
    expect(responded).toHaveLength(1)
    expect((responded[0] as any).status).toBe(200)
    expect((responded[0] as any).body).toEqual({ success: true })
    if (res.ok) expect((res.data as any).sent).toBe(true)
  })

  test("is a no-op when respond() is absent (async flow)", async () => {
    const ctx = makeCtx({ config: { status: 200, body: "ok" } })
    const res = await getImpl("http.respond").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) expect((res.data as any).sent).toBe(false)
  })

  test("defaults to status 200", async () => {
    const responded: unknown[] = []
    const ctx = makeCtx({ config: {}, respond: (r) => responded.push(r) })
    await getImpl("http.respond").execute(ctx)
    expect((responded[0] as any).status).toBe(200)
  })
})

// ─────────────────────────────────────────────
// AI NODE
// ─────────────────────────────────────────────

describe("ai", () => {
  test("fails if __provider is missing", async () => {
    const ctx = makeCtx({ config: { model: "gpt-4o", mode: "complete", prompt: "hi" } })
    const res = await getImpl("ai").execute(ctx)
    expect(res.ok).toBe(false)
    expect((res as any).error).toMatch(/provider/)
  })

  test("fails if provider name is unknown", async () => {
    const ctx = makeCtx({ config: { model: "gpt", mode: "complete", prompt: "hi", __provider: { provider: "notreal" } } })
    const res = await getImpl("ai").execute(ctx)
    expect(res.ok).toBe(false)
    expect((res as any).error).toMatch(/Unknown AI provider/)
  })

  test("complete mode — mocked OpenAI response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "Hello!" }, finish_reason: "stop" }],
      usage:   { prompt_tokens: 10, completion_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } }))

    // Register a custom openai provider that uses our mock fetch
    const registry = new AIProviderRegistry()
    const { OpenAIProvider } = await import("./providers")
    registry.register("openai-mock", () => new OpenAIProvider("test-key", "https://api.openai.com/v1", mockFetch))

    const localDeps = { ...deps, aiProviders: registry }
    const localImpls = createNodeImplementations(localDeps)
    const aiImpl = localImpls.find(i => i.type === "ai")!

    const ctx = makeCtx({
      config: { model: "gpt-4o", mode: "complete", prompt: "Say hi", __provider: { provider: "openai-mock" } },
    })
    const res = await aiImpl.execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect((res.data as any).result).toBe("Hello!")
      expect((res.data as any).finishReason).toBe("stop")
    }
  })

  test("fails with helpful error for missing prompt in complete mode", async () => {
    const ctx = makeCtx({ config: { model: "gpt-4o", mode: "complete", __provider: { provider: "openai" } } })
    const res = await getImpl("ai").execute(ctx)
    expect(res.ok).toBe(false)
    expect((res as any).error).toMatch(/prompt/)
  })

  test("fails with helpful error for missing input in embed mode", async () => {
    const ctx = makeCtx({ config: { model: "text-embedding-3-small", mode: "embed", __provider: { provider: "openai" } } })
    const res = await getImpl("ai").execute(ctx)
    expect(res.ok).toBe(false)
    expect((res as any).error).toMatch(/input/)
  })
})

// ─────────────────────────────────────────────
// STORE NODE
// ─────────────────────────────────────────────

describe("store", () => {
  test("set then get workspace key", async () => {
    const setCtx = makeCtx({ config: { key: "counter", mode: "set", value: 42, scope: "workspace" } })
    const setRes = await getImpl("store").execute(setCtx)
    expect(setRes.ok).toBe(true)

    const getCtx = makeCtx({ config: { key: "counter", mode: "get", scope: "workspace" } })
    const getRes = await getImpl("store").execute(getCtx)
    expect(getRes.ok).toBe(true)
    if (getRes.ok) {
      expect((getRes.data as any).value).toBe(42)
      expect((getRes.data as any).found).toBe(true)
    }
  })

  test("get returns found: false for missing key", async () => {
    const ctx = makeCtx({ config: { key: "nonexistent-key", mode: "get", scope: "workspace" } })
    const res = await getImpl("store").execute(ctx)
    expect(res.ok).toBe(true)
    if (res.ok) expect((res.data as any).found).toBe(false)
  })

  test("delete removes a key", async () => {
    const setCtx = makeCtx({ config: { key: "temp", mode: "set", value: "hello", scope: "workspace" } })
    await getImpl("store").execute(setCtx)

    const delCtx = makeCtx({ config: { key: "temp", mode: "delete", scope: "workspace" } })
    const delRes = await getImpl("store").execute(delCtx)
    expect(delRes.ok).toBe(true)
    if (delRes.ok) expect((delRes.data as any).deleted).toBe(true)

    const getCtx = makeCtx({ config: { key: "temp", mode: "get", scope: "workspace" } })
    const getRes = await getImpl("store").execute(getCtx)
    if (getRes.ok) expect((getRes.data as any).found).toBe(false)
  })

  test("execution scope is isolated by executionId", async () => {
    const exec1 = makeCtx({ executionId: "exec-A", config: { key: "x", mode: "set", value: 1, scope: "execution" } })
    await getImpl("store").execute(exec1)

    const exec2 = makeCtx({ executionId: "exec-B", config: { key: "x", mode: "get", scope: "execution" } })
    const res = await getImpl("store").execute(exec2)
    if (res.ok) expect((res.data as any).found).toBe(false)
  })

  test("respects custom output key name", async () => {
    const setCtx = makeCtx({ config: { key: "score", mode: "set", value: 0.9, scope: "workspace" } })
    await getImpl("store").execute(setCtx)

    const getCtx = makeCtx({ config: { key: "score", mode: "get", output: "myScore", scope: "workspace" } })
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
