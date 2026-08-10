import { describe, test, expect, beforeAll, afterAll, vi } from "vitest"
import { createSqlJsDatabase, runMigrations } from "./store/db"
import { SQLiteFlowStore }        from "./store/flows"
import { SQLiteExecutionStore }   from "./store/executions"
import { KVStore }                from "./store/kv"
import { WaitRegistry }           from "./store/wait"
import { SQLiteCredentialStore }  from "./store/credentials"
import { InMemoryQueue }          from "./runtime/queue"
import { InMemoryPlanCache }      from "./runtime/store"
import { Scheduler }              from "./runtime/scheduler"
import { EventBus }               from "./events"
import { TriggerRegistry }        from "./triggers/registry"
import { CronScheduler }          from "./triggers/cron"
import { TriggerRouter }          from "./triggers/router"
import { WorkflowActivator }      from "./triggers/activator"
import { Compiler }               from "./compiler"
import { PluginRegistry }         from "./plugins"
import { createNodeImplementations } from "./nodes"
import { AIProviderRegistry }     from "./nodes/providers"
import { CodeWorkerPool }         from "./nodes/code-worker-pool"
import type { Flow }              from "./types"
import type { IDatabase }         from "./store/db"

// ─────────────────────────────────────────────
// TEST HARNESS
// Mirrors the boot() sequence in server.ts using
// sql.js instead of BunSqliteAdapter.
// ─────────────────────────────────────────────

process.env["ORION_SECRET"] = "test-secret-key-at-least-32-chars-long!!"

interface Harness {
  db:        IDatabase
  flowStore: SQLiteFlowStore
  execStore: SQLiteExecutionStore
  credStore: SQLiteCredentialStore
  kv:        KVStore
  waitReg:   WaitRegistry
  queue:     InMemoryQueue
  plans:     InMemoryPlanCache
  router:    TriggerRouter
  scheduler: Scheduler
  activator: WorkflowActivator
  codePool:  CodeWorkerPool
  compiler:  Compiler
}

async function makeHarness(): Promise<Harness> {
  const db = await createSqlJsDatabase()
  runMigrations(db)

  const flowStore = new SQLiteFlowStore(db)
  const execStore = new SQLiteExecutionStore(db)
  const credStore = new SQLiteCredentialStore(db)
  const kv        = new KVStore(db)
  const waitReg   = new WaitRegistry(db)
  const codePool  = new CodeWorkerPool(1)

  const pluginRegistry = new PluginRegistry()
  const impls = createNodeImplementations({
    kv, waitReg, aiProviders: new AIProviderRegistry(),
    workspaceId: "ws-test", codePool,
  })
  for (const impl of impls) pluginRegistry.registerImpl(impl)

  const queue    = new InMemoryQueue()
  const plans    = new InMemoryPlanCache()
  const eventBus = new EventBus(queue)
  const registry = new TriggerRegistry()
  const cron     = new CronScheduler(queue)
  const compiler = new Compiler(pluginRegistry)
  const router   = new TriggerRouter(queue, plans, registry, eventBus, execStore, waitReg)

  const scheduler = new Scheduler(queue, plans, execStore, pluginRegistry, undefined, {
    concurrency: 5, checkpoint: true,
  })

  const activator = new WorkflowActivator(compiler, plans, router, cron, eventBus, registry)

  return { db, flowStore, execStore, credStore, kv, waitReg, queue, plans, router, scheduler, activator, codePool, compiler }
}

function makeFlow(overrides: Partial<Flow> & { nodes: Flow["nodes"]; edges: Flow["edges"] }): Flow {
  return {
    id: "flow-test", version: "1.0.0", name: "Test Flow",
    accountId: "a1", workspaceId: "ws-test", createdBy: "u1",
    createdAt: Date.now(), updatedAt: Date.now(),
    ...overrides,
  }
}

// ─────────────────────────────────────────────
// BOOT + ACTIVATION
// ─────────────────────────────────────────────

describe("Server — boot and activation", () => {
  test("activates a flow with a webhook trigger", async () => {
    const h = await makeHarness()
    const flow = makeFlow({
      nodes: {
        t: { id: "t", type: "trigger.webhook", config: { path: { type: "literal", value: "/hooks/test" }, method: { type: "literal", value: "POST" } } },
        r: { id: "r", type: "http.respond",    config: { status: { type: "literal", value: 200 }, body: { type: "literal", value: { ok: true } } } },
      },
      edges: [{ id: "e1", from: "t", to: "r" }],
    })

    h.flowStore.save(flow)
    const results = await h.activator.activate([flow])
    expect(results[0]?.ok).toBe(true)
    expect(results[0]?.triggers).toBe(1)
    await h.codePool.drain()
  })

  test("activation fails gracefully for invalid flow", async () => {
    const h = await makeHarness()
    const badFlow = makeFlow({
      id: "bad-flow",
      nodes: {
        t: { id: "t", type: "trigger.webhook", config: { path: { type: "literal", value: "/hooks/bad" } } },
        x: { id: "x", type: "not.a.type",     config: {} },
      },
      edges: [{ id: "e1", from: "t", to: "x" }],
    })
    const results = await h.activator.activate([badFlow])
    expect(results[0]?.ok).toBe(false)
    await h.codePool.drain()
  })
})

// ─────────────────────────────────────────────
// ASYNC WEBHOOK — end-to-end execution
// ─────────────────────────────────────────────

describe("Server — async webhook execution", () => {
  let h: Harness

  beforeAll(async () => {
    h = await makeHarness()

    const flow = makeFlow({
      id: "flow-async",
      nodes: {
        t: { id: "t", type: "trigger.webhook", config: { path: { type: "literal", value: "/hooks/async" }, method: { type: "literal", value: "POST" } } },
        c: { id: "c", type: "data.code",       config: { code: { type: "literal", value: "trigger.body.x * 2" } } },
      },
      edges: [{ id: "e1", from: "t", to: "c" }],
    })

    await h.activator.activate([flow])
    h.scheduler.run()
  })

  afterAll(async () => {
    h.scheduler.stop()
    await h.codePool.drain()
  })

  test("POST /hooks/async returns 202 with executionId", async () => {
    const req = new Request("http://localhost/hooks/async", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 21 }),
    })
    const res = await h.router.handle(req)
    expect(res.status).toBe(202)
    const body = await res.json() as any
    expect(body.accepted).toBe(true)
    expect(typeof body.executionId).toBe("string")
  })

  test("execution record written after scheduler runs", async () => {
    const req = new Request("http://localhost/hooks/async", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 5 }),
    })
    const res  = await h.router.handle(req)
    const body = await res.json() as any

    // Wait for scheduler to process
    await new Promise(r => setTimeout(r, 200))

    const record = await h.execStore.getRecord(body.executionId)
    expect(record).toBeDefined()
    expect(record?.status).toBe("completed")
    expect(record?.nodeStates["c"]?.status).toBe("completed")
  })

  test("unknown webhook path returns 404", async () => {
    const req = new Request("http://localhost/hooks/no-such-path", { method: "POST" })
    const res = await h.router.handle(req)
    expect(res.status).toBe(404)
  })
})

// ─────────────────────────────────────────────
// SYNC WEBHOOK — http.respond integration
// ─────────────────────────────────────────────

describe("Server — sync webhook (http.respond)", () => {
  test("POST /hooks/sync awaits http.respond and returns its body", async () => {
    const h = await makeHarness()

    const flow = makeFlow({
      id: "flow-sync",
      nodes: {
        t:    { id: "t",    type: "trigger.webhook", config: { path: { type: "literal", value: "/hooks/sync" }, mode: "sync", timeoutMs: 5000 } },
        code: { id: "code", type: "data.code",       config: { code: { type: "literal", value: "42" } } },
        resp: { id: "resp", type: "http.respond",    config: {
          status:  { type: "literal", value: 200 },
          body:    { type: "ref",     path: "$.code.result" },
        }},
      },
      edges: [
        { id: "e1", from: "t",    to: "code" },
        { id: "e2", from: "code", to: "resp" },
      ],
    })

    await h.activator.activate([flow])
    h.scheduler.run()

    const req = new Request("http://localhost/hooks/sync", {
      method: "POST",
      body: JSON.stringify({}),
    })

    // The router holds the connection until http.respond fires
    const responsePromise = h.router.handle(req)
    const res = await responsePromise

    expect(res.status).toBe(200)
    h.scheduler.stop()
    await h.codePool.drain()
  }, 8_000)

  test("sync webhook returns 504 on timeout", async () => {
    const h = await makeHarness()

    // A flow with no http.respond node — will time out
    const flow = makeFlow({
      id: "flow-timeout",
      nodes: {
        t: { id: "t", type: "trigger.webhook", config: { path: { type: "literal", value: "/hooks/timeout" }, mode: "sync", timeoutMs: 50 } },
        d: { id: "d", type: "flow.delay",      config: { ms: { type: "literal", value: 500 } } },
      },
      edges: [{ id: "e1", from: "t", to: "d" }],
    })

    await h.activator.activate([flow])
    h.scheduler.run()

    const req = new Request("http://localhost/hooks/timeout", { method: "POST" })
    const res = await h.router.handle(req)
    expect(res.status).toBe(504)

    h.scheduler.stop()
    await h.codePool.drain()
  }, 5_000)
})

// ─────────────────────────────────────────────
// WAIT RESUME
// ─────────────────────────────────────────────

describe("Server — flow.wait + POST /wait/:resumeKey", () => {
  test("POST /wait/:resumeKey returns 404 for unknown key", async () => {
    const h = await makeHarness()
    const req = new Request("http://localhost/wait/no-such-key", { method: "POST" })
    const res = await h.router.handle(req)
    expect(res.status).toBe(404)
    await h.codePool.drain()
  })

  test("registers wait entry and resume path works", async () => {
    const h = await makeHarness()

    const flow = makeFlow({
      id: "flow-wait",
      nodes: {
        t:    { id: "t",    type: "trigger.manual", config: {} },
        wait: { id: "wait", type: "flow.wait",      config: { event: { type: "literal", value: "approval" }, timeoutMs: 60000, resumeKey: "approvalPayload" } },
        code: { id: "code", type: "data.code",      config: { code: { type: "literal", value: "nodes.wait.resumeKey" } } },
      },
      edges: [
        { id: "e1", from: "t",    to: "wait" },
        { id: "e2", from: "wait", to: "code" },
      ],
    })

    await h.activator.activate([flow])
    h.scheduler.run()

    // Trigger the flow manually
    const triggerReq = new Request("http://localhost/flows/flow-wait/trigger", {
      method: "POST", body: JSON.stringify({}),
    })
    const triggerRes = await h.router.handle(triggerReq)
    expect(triggerRes.status).toBe(202)
    const { executionId } = await triggerRes.json() as any

    // Wait for scheduler to reach flow.wait and suspend
    await new Promise(r => setTimeout(r, 200))

    // Find the resume key in the wait registry
    const entry = h.waitReg.getByExecution(executionId)
    expect(entry).toBeDefined()

    const resumeKey = entry!.resumeKey

    // Resume via POST /wait/:resumeKey
    const resumeReq = new Request(`http://localhost/wait/${resumeKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: true }),
    })
    const resumeRes = await h.router.handle(resumeReq)
    expect(resumeRes.status).toBe(202)

    // Wait entry should be consumed
    expect(h.waitReg.getByKey(resumeKey)).toBeUndefined()

    h.scheduler.stop()
    await h.codePool.drain()
  }, 5_000)
})

// ─────────────────────────────────────────────
// CREDENTIAL INJECTION
// ─────────────────────────────────────────────

describe("Server — credential injection", () => {
  // Credential injection is tested by directly invoking the wrapper pattern
  // that server.ts uses — no need for a full scheduler stack.

  test("credential-aware registry injects __provider into ai node config", async () => {
    const h = await makeHarness()

    h.credStore.save({
      id: "cred-ai", workspaceId: "ws-test",
      name: "openai", provider: "openai",
      data: { apiKey: "sk-test-key", baseUrl: "https://api.openai.com/v1" },
    })

    const pluginRegistry = new PluginRegistry()
    const receivedConfigs: unknown[] = []
    pluginRegistry.registerImpl({
      type: "ai",
      async execute(ctx) { receivedConfigs.push(ctx.config); return { ok: true, data: {} } },
    })
    // fill in the rest
    const impls = createNodeImplementations({
      kv: h.kv, waitReg: h.waitReg,
      aiProviders: new AIProviderRegistry(),
      workspaceId: "ws-test", codePool: h.codePool,
    })
    for (const impl of impls) {
      if (!pluginRegistry.hasImpl(impl.type)) pluginRegistry.registerImpl(impl)
    }

    // Build the wrapper (mirrors server.ts)
    const credentialAwareRegistry = {
      get(type: string) {
        const impl = pluginRegistry.get(type)
        if (!impl) return undefined
        return {
          type: impl.type,
          async execute(ctx: import("./executor").NodeContext) {
            const credId = ctx.config.credential
            if (typeof credId === "string" && credId) {
              const cred = h.credStore.get(credId)
              if (!cred) return { ok: false as const, error: `Credential "${credId}" not found` }
              ctx = { ...ctx, config: { ...ctx.config, __provider: { provider: cred.provider, ...cred.data } } }
            }
            return impl.execute(ctx)
          },
        }
      },
    }

    // Call get() + execute() directly — no scheduler needed
    const aiWrapper = credentialAwareRegistry.get("ai")!
    const ctx = {
      executionId: "e1",
      config: { credential: "cred-ai", model: "gpt-4o", mode: "complete", prompt: "hi" },
      trigger: {}, nodes: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      fetch: fetch, signal: new AbortController().signal,
    }
    await aiWrapper.execute(ctx)

    expect(receivedConfigs.length).toBe(1)
    const cfg = receivedConfigs[0] as any
    expect(cfg.__provider.provider).toBe("openai")
    expect(cfg.__provider.apiKey).toBe("sk-test-key")

    await h.codePool.drain()
  })

  test("missing credential returns ok:false error", async () => {
    const h = await makeHarness()

    const pluginRegistry = new PluginRegistry()
    pluginRegistry.registerImpl({ type: "ai", async execute() { return { ok: true, data: {} } } })
    const impls = createNodeImplementations({ kv: h.kv, waitReg: h.waitReg, aiProviders: new AIProviderRegistry(), workspaceId: "ws-test", codePool: h.codePool })
    for (const impl of impls) {
      if (!pluginRegistry.hasImpl(impl.type)) pluginRegistry.registerImpl(impl)
    }

    const credentialAwareRegistry = {
      get(type: string) {
        const impl = pluginRegistry.get(type)
        if (!impl) return undefined
        return {
          type: impl.type,
          async execute(ctx: import("./executor").NodeContext) {
            const credId = ctx.config.credential
            if (typeof credId === "string" && credId) {
              const cred = h.credStore.get(credId)
              if (!cred) return { ok: false as const, error: `Credential "${credId}" not found` }
            }
            return impl.execute(ctx)
          },
        }
      },
    }

    const aiWrapper = credentialAwareRegistry.get("ai")!
    const ctx = {
      executionId: "e1",
      config: { credential: "does-not-exist", model: "gpt-4o" },
      trigger: {}, nodes: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      fetch: fetch, signal: new AbortController().signal,
    }
    const result = await aiWrapper.execute(ctx)
    expect(result.ok).toBe(false)
    expect((result as any).error).toMatch(/not found/)

    await h.codePool.drain()
  })

  test("http credential merges data into headers", async () => {
    const h = await makeHarness()

    h.credStore.save({
      id: "cred-http", workspaceId: "ws-test",
      name: "my-api", provider: "http",
      data: { Authorization: "Bearer token123" },
    })

    const pluginRegistry = new PluginRegistry()
    const receivedHeaders: unknown[] = []
    pluginRegistry.registerImpl({
      type: "http.request",
      async execute(ctx) { receivedHeaders.push(ctx.config.headers); return { ok: true, data: {} } },
    })
    const impls = createNodeImplementations({ kv: h.kv, waitReg: h.waitReg, aiProviders: new AIProviderRegistry(), workspaceId: "ws-test", codePool: h.codePool })
    for (const impl of impls) {
      if (!pluginRegistry.hasImpl(impl.type)) pluginRegistry.registerImpl(impl)
    }

    const credentialAwareRegistry = {
      get(type: string) {
        const impl = pluginRegistry.get(type)
        if (!impl) return undefined
        return {
          type: impl.type,
          async execute(ctx: import("./executor").NodeContext) {
            const credId = ctx.config.credential
            if (typeof credId === "string" && credId) {
              const cred = h.credStore.get(credId)
              if (!cred) return { ok: false as const, error: `Credential "${credId}" not found` }
              if (cred.provider === "http") {
                const existing = (ctx.config.headers as Record<string, string> | undefined) ?? {}
                ctx = { ...ctx, config: { ...ctx.config, headers: { ...cred.data, ...existing } } }
              } else {
                ctx = { ...ctx, config: { ...ctx.config, __provider: { provider: cred.provider, ...cred.data } } }
              }
            }
            return impl.execute(ctx)
          },
        }
      },
    }

    const wrapper = credentialAwareRegistry.get("http.request")!
    const ctx = {
      executionId: "e1",
      config: { credential: "cred-http", url: "https://api.example.com", method: "GET" },
      trigger: {}, nodes: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      fetch: fetch, signal: new AbortController().signal,
    }
    await wrapper.execute(ctx)

    expect(receivedHeaders.length).toBe(1)
    expect((receivedHeaders[0] as any).Authorization).toBe("Bearer token123")

    await h.codePool.drain()
  })
})

describe("Server — admin endpoints", () => {
  test("GET /admin/health returns ok", async () => {
    const h   = await makeHarness()
    const req = new Request("http://localhost/admin/health", { method: "GET" })
    const res = await h.router.handle(req)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.status).toBe("ok")
    expect(typeof body.queue.depth).toBe("number")
    await h.codePool.drain()
  })

  test("GET /admin/triggers returns trigger list", async () => {
    const h = await makeHarness()
    const req = new Request("http://localhost/admin/triggers", { method: "GET" })
    const res = await h.router.handle(req)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(Array.isArray(body.triggers)).toBe(true)
    await h.codePool.drain()
  })

  test("unknown route returns 404", async () => {
    const h   = await makeHarness()
    const req = new Request("http://localhost/not/a/route", { method: "GET" })
    const res = await h.router.handle(req)
    expect(res.status).toBe(404)
    await h.codePool.drain()
  })
})
