import { describe, test, expect, vi, beforeEach } from "vitest"
import {
  NodeExecutor,
  type INodeRegistry,
  type INodeImplementation,
  type NodeContext,
  type NodeResult,
} from "./index"
import { InMemoryCache } from "../cache"
import type { NodeDefinition } from "../types"
import type { ResolutionContext } from "../expression"

// ─────────────────────────────────────────────
// TEST HELPERS
// ─────────────────────────────────────────────

const baseCtx: ResolutionContext = {
  trigger: { body: { email: "john@acme.com", score: 0.82 } },
  nodes:   { upstream: { data: "upstream-data" } },
}

const baseNode = (overrides?: Partial<NodeDefinition>): NodeDefinition => ({
  id:     "testNode",
  type:   "test.node",
  config: {},
  ...overrides,
})

// Build a simple node implementation from a factory function
const impl = (
  fn: (ctx: NodeContext) => Promise<NodeResult>,
  type = "test.node",
): INodeImplementation => ({ type, execute: fn })

// Build a registry from a map of implementations
const registry = (impls: INodeImplementation[]): INodeRegistry => ({
  get: (type) => impls.find(i => i.type === type),
})

// Successful node — returns { value } immediately
const successImpl = (data: unknown = { result: "ok" }, delayMs = 0) =>
  impl(async () => {
    if (delayMs > 0) await sleep(delayMs)
    return { ok: true, data }
  })

// Failing node — returns ok: false with optional retry flag
const failImpl = (error = "something went wrong", retryFlag?: boolean) =>
  impl(async () => ({ ok: false as const, error, retry: retryFlag }))

// Throwing node — throws rather than returning ok: false
const throwImpl = (message = "unexpected crash") =>
  impl(async () => { throw new Error(message) })

// Counter node — counts how many times execute was called
const makeCountedImpl = () => {
  let calls = 0
  const node = impl(async () => {
    calls++
    if (calls < 3) return { ok: false as const, error: `attempt ${calls} failed` }
    return { ok: true as const, data: { calls } }
  })
  return { node, getCalls: () => calls }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─────────────────────────────────────────────
// BASIC EXECUTION
// ─────────────────────────────────────────────

describe("Basic execution", () => {
  test("runs a successful node and returns data", async () => {
    const ex = new NodeExecutor(registry([successImpl({ value: 42 })]))
    const { outcome } = await ex.execute(baseNode(), baseCtx)

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.data).toEqual({ value: 42 })
      expect(outcome.attempts).toBe(1)
      expect(outcome.fromCache).toBe(false)
      expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  test("resolves config expressions before passing to node", async () => {
    let receivedConfig: Record<string, unknown> = {}

    const captureImpl = impl(async (ctx) => {
      receivedConfig = ctx.config
      return { ok: true, data: null }
    })

    const node = baseNode({
      config: {
        email: { type: "ref",     path: "$.trigger.body.email" },
        label: { type: "literal", value: "static-label" },
        score: { type: "ref",     path: "$.trigger.body.score" },
      },
    })

    const ex = new NodeExecutor(registry([captureImpl]))
    await ex.execute(node, baseCtx)

    expect(receivedConfig.email).toBe("john@acme.com")
    expect(receivedConfig.label).toBe("static-label")
    expect(receivedConfig.score).toBe(0.82)
  })

  test("passes trigger and nodes to NodeContext", async () => {
    let receivedCtx: NodeContext | null = null

    const captureImpl = impl(async (ctx) => {
      receivedCtx = ctx
      return { ok: true, data: null }
    })

    const ex = new NodeExecutor(registry([captureImpl]))
    await ex.execute(baseNode(), baseCtx)

    expect(receivedCtx!.trigger).toEqual(baseCtx.trigger)
    expect(receivedCtx!.nodes).toEqual(baseCtx.nodes)
  })

  test("returns routable: false when node type not registered", async () => {
    const ex = new NodeExecutor(registry([]))
    const { outcome } = await ex.execute(baseNode(), baseCtx)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.routable).toBe(false)
      expect(outcome.error).toContain("test.node")
    }
  })

  test("returns routable: false when config resolution fails", async () => {
    const node = baseNode({
      config: {
        // ref to a non-existent path — resolver will throw
        data: { type: "ref", path: "$.ghost.missing" },
      },
    })

    const ex = new NodeExecutor(registry([successImpl()]))
    const { outcome } = await ex.execute(node, baseCtx)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.routable).toBe(false)
      expect(outcome.error).toContain("Config resolution failed")
    }
  })
})

// ─────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────

describe("Logging", () => {
  test("captures logs emitted by the node", async () => {
    const loggingImpl = impl(async (ctx) => {
      ctx.logger.info("starting",  { step: 1 })
      ctx.logger.debug("details",  { step: 2 })
      ctx.logger.warn("careful",   { step: 3 })
      return { ok: true, data: null }
    })

    const ex = new NodeExecutor(registry([loggingImpl]))
    const { logs } = await ex.execute(baseNode(), baseCtx)

    expect(logs).toHaveLength(3)
    expect(logs[0]!.level).toBe("info")
    expect(logs[0]!.message).toBe("starting")
    expect(logs[1]!.level).toBe("debug")
    expect(logs[2]!.level).toBe("warn")
  })

  test("each log entry has a timestamp", async () => {
    const loggingImpl = impl(async (ctx) => {
      ctx.logger.info("ts test")
      return { ok: true, data: null }
    })

    const ex = new NodeExecutor(registry([loggingImpl]))
    const { logs } = await ex.execute(baseNode(), baseCtx)

    expect(logs[0]!.ts).toBeGreaterThan(0)
  })

  test("executor adds retry logs automatically", async () => {
    const { node: counted } = makeCountedImpl()
    const ex = new NodeExecutor(registry([counted]))

    const def = baseNode({
      retry: { maxAttempts: 3, backoff: "fixed", delayMs: 1 },
    })

    const { logs } = await ex.execute(def, baseCtx)

    const retryLogs = logs.filter(l => l.message.includes("Retrying"))
    expect(retryLogs).toHaveLength(2)  // 2 retries after first failure
  })
})

// ─────────────────────────────────────────────
// RETRY
// ─────────────────────────────────────────────

describe("Retry", () => {
  test("retries up to maxAttempts on ok: false", async () => {
    const { node: counted, getCalls } = makeCountedImpl()
    const ex = new NodeExecutor(registry([counted]))

    const def = baseNode({
      retry: { maxAttempts: 3, backoff: "fixed", delayMs: 1 },
    })

    const { outcome } = await ex.execute(def, baseCtx)

    expect(outcome.ok).toBe(true)
    expect(getCalls()).toBe(3)
    if (outcome.ok) expect(outcome.attempts).toBe(3)
  })

  test("stops retrying after maxAttempts", async () => {
    let calls = 0
    const alwaysFail = impl(async () => {
      calls++
      return { ok: false as const, error: "always fails" }
    })

    const ex = new NodeExecutor(registry([alwaysFail]))
    const def = baseNode({
      retry: { maxAttempts: 3, backoff: "fixed", delayMs: 1 },
    })

    const { outcome } = await ex.execute(def, baseCtx)

    expect(outcome.ok).toBe(false)
    expect(calls).toBe(3)
    if (!outcome.ok) {
      expect(outcome.attempts).toBe(3)
      expect(outcome.routable).toBe(true)
    }
  })

  test("does not retry when retry: false returned", async () => {
    let calls = 0
    const noRetry = impl(async () => {
      calls++
      return { ok: false as const, error: "permanent failure", retry: false }
    })

    const ex = new NodeExecutor(registry([noRetry]))
    const def = baseNode({
      retry: { maxAttempts: 5, backoff: "fixed", delayMs: 1 },
    })

    await ex.execute(def, baseCtx)
    expect(calls).toBe(1)
  })

  test("exponential backoff doubles delay each attempt", async () => {
    const delays: number[] = []
    const originalSetTimeout = global.setTimeout
    const spy = vi.spyOn(global, "setTimeout").mockImplementation(
      (fn: (...args: unknown[]) => void, ms?: number) => {
        if (ms && ms > 0) delays.push(ms)
        return originalSetTimeout(fn, 0)
      }
    )

    let calls = 0
    const flaky = impl(async () => {
      calls++
      if (calls < 4) return { ok: false as const, error: "fail" }
      return { ok: true as const, data: null }
    })

    const ex = new NodeExecutor(registry([flaky]))
    const def = baseNode({
      retry: { maxAttempts: 4, backoff: "exponential", delayMs: 100 },
    })

    await ex.execute(def, baseCtx)
    spy.mockRestore()

    // attempt 2: 2^0 * 100 = 100ms
    // attempt 3: 2^1 * 100 = 200ms
    // attempt 4: 2^2 * 100 = 400ms
    expect(delays).toEqual([100, 200, 400])
  })

  test("retries on thrown errors", async () => {
    let calls = 0
    const throwsOnce = impl(async () => {
      calls++
      if (calls === 1) throw new Error("transient crash")
      return { ok: true as const, data: { recovered: true } }
    })

    const ex = new NodeExecutor(registry([throwsOnce]))
    const def = baseNode({
      retry: { maxAttempts: 2, backoff: "fixed", delayMs: 1 },
    })

    const { outcome } = await ex.execute(def, baseCtx)
    expect(outcome.ok).toBe(true)
    expect(calls).toBe(2)
  })

  test("single attempt when no retry policy", async () => {
    let calls = 0
    const alwaysFail = impl(async () => {
      calls++
      return { ok: false as const, error: "fail" }
    })

    const ex = new NodeExecutor(registry([alwaysFail]))
    const { outcome } = await ex.execute(baseNode(), baseCtx)

    expect(calls).toBe(1)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.attempts).toBe(1)
  })
})

// ─────────────────────────────────────────────
// TIMEOUT
// ─────────────────────────────────────────────

describe("Timeout", () => {
  test("times out a slow node", async () => {
    const slow = impl(async () => {
      await sleep(500)
      return { ok: true as const, data: null }
    })

    const ex = new NodeExecutor(registry([slow]))
    const def = baseNode({ timeout: 50 })

    const { outcome } = await ex.execute(def, baseCtx)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toContain("timed out")
      expect(outcome.routable).toBe(true)
    }
  }, 2000)

  test("does not time out a fast node", async () => {
    const fast = successImpl({ quick: true }, 10)
    const ex   = new NodeExecutor(registry([fast]))
    const def  = baseNode({ timeout: 500 })

    const { outcome } = await ex.execute(def, baseCtx)
    expect(outcome.ok).toBe(true)
  })

  test("timeout does not retry", async () => {
    let calls = 0
    const slow = impl(async () => {
      calls++
      await sleep(500)
      return { ok: true as const, data: null }
    })

    const ex = new NodeExecutor(registry([slow]))
    const def = baseNode({
      timeout: 20,
      retry:   { maxAttempts: 3, backoff: "fixed", delayMs: 1 },
    })

    const { outcome } = await ex.execute(def, baseCtx)

    expect(outcome.ok).toBe(false)
    expect(calls).toBe(1)   // timed out — no retry
  }, 2000)

  test("AbortSignal is passed to node — node can respect it", async () => {
    let signalSeen: AbortSignal | null = null

    const captureSignal = impl(async (ctx) => {
      signalSeen = ctx.signal
      return { ok: true, data: null }
    })

    const ex = new NodeExecutor(registry([captureSignal]))
    await ex.execute(baseNode({ timeout: 1000 }), baseCtx)

    expect(signalSeen).not.toBeNull()
    expect(signalSeen).toBeInstanceOf(AbortSignal)
  })
})

// ─────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────

describe("Cache", () => {
  test("returns cached value on hit", async () => {
    let calls = 0
    const expensiveImpl = impl(async () => {
      calls++
      return { ok: true as const, data: { expensive: true } }
    })

    const cache = new InMemoryCache()
    const ex    = new NodeExecutor(registry([expensiveImpl]), cache)
    const def   = baseNode({
      cache: {
        ttlMs: 60_000,
        key:   { type: "literal", value: "my-cache-key" },
      },
    })

    // First call — miss, executes node
    const first = await ex.execute(def, baseCtx)
    expect(first.outcome.ok).toBe(true)
    if (first.outcome.ok) expect(first.outcome.fromCache).toBe(false)

    // Second call — hit, does not execute node
    const second = await ex.execute(def, baseCtx)
    expect(second.outcome.ok).toBe(true)
    if (second.outcome.ok) {
      expect(second.outcome.fromCache).toBe(true)
      expect(second.outcome.data).toEqual({ expensive: true })
    }

    expect(calls).toBe(1)
  })

  test("does not cache on ok: false", async () => {
    let calls = 0
    const alwaysFail = impl(async () => {
      calls++
      return { ok: false as const, error: "fail" }
    })

    const cache = new InMemoryCache()
    const ex    = new NodeExecutor(registry([alwaysFail]), cache)
    const def   = baseNode({
      cache: {
        ttlMs: 60_000,
        key:   { type: "literal", value: "fail-key" },
      },
    })

    await ex.execute(def, baseCtx)
    await ex.execute(def, baseCtx)

    expect(calls).toBe(2)  // executed both times — no cache write
  })

  test("respects TTL — expired entries are not returned", async () => {
    let calls = 0
    const counter = impl(async () => {
      calls++
      return { ok: true as const, data: { call: calls } }
    })

    const cache = new InMemoryCache()
    const ex    = new NodeExecutor(registry([counter]), cache)
    const def   = baseNode({
      cache: {
        ttlMs: 1,  // expire after 1ms
        key:   { type: "literal", value: "ttl-key" },
      },
    })

    await ex.execute(def, baseCtx)
    await sleep(10)  // wait for TTL to expire
    await ex.execute(def, baseCtx)

    expect(calls).toBe(2)
  })

  test("cache key uses expression — different keys for different inputs", async () => {
    let calls = 0
    const counter = impl(async () => {
      calls++
      return { ok: true as const, data: { call: calls } }
    })

    const cache = new InMemoryCache()
    const ex    = new NodeExecutor(registry([counter]), cache)
    const def   = baseNode({
      cache: {
        ttlMs: 60_000,
        key:   { type: "ref", path: "$.trigger.body.email" },  // dynamic key
      },
    })

    // Same node, different trigger contexts → different cache keys
    const ctx1: ResolutionContext = { ...baseCtx, trigger: { body: { email: "a@test.com", score: 0 } } }
    const ctx2: ResolutionContext = { ...baseCtx, trigger: { body: { email: "b@test.com", score: 0 } } }

    await ex.execute(def, ctx1)
    await ex.execute(def, ctx1)  // cache hit
    await ex.execute(def, ctx2)  // different key — cache miss

    expect(calls).toBe(2)
  })

  test("cache miss — node still executes", async () => {
    let calls = 0
    const counter = impl(async () => {
      calls++
      return { ok: true as const, data: { call: calls } }
    })

    const cache = new InMemoryCache()
    const ex    = new NodeExecutor(registry([counter]), cache)
    const def   = baseNode({
      cache: {
        ttlMs: 60_000,
        key:   { type: "literal", value: "fresh-key" },
      },
    })

    const { outcome } = await ex.execute(def, baseCtx)
    expect(calls).toBe(1)
    if (outcome.ok) expect(outcome.fromCache).toBe(false)
  })

  test("no cache configured — fromCache always false", async () => {
    const ex = new NodeExecutor(registry([successImpl()]))
    // No cache passed to constructor

    const { outcome } = await ex.execute(baseNode(), baseCtx)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.fromCache).toBe(false)
  })
})

// ─────────────────────────────────────────────
// IN-MEMORY CACHE
// ─────────────────────────────────────────────

describe("InMemoryCache", () => {
  test("get returns undefined for missing key", async () => {
    const cache = new InMemoryCache()
    expect(await cache.get("missing")).toBeUndefined()
  })

  test("set and get roundtrip", async () => {
    const cache = new InMemoryCache()
    await cache.set("key", { data: 42 }, 60_000)
    expect(await cache.get("key")).toEqual({ data: 42 })
  })

  test("expired entries return undefined", async () => {
    const cache = new InMemoryCache()
    await cache.set("key", "value", 1)
    await sleep(10)
    expect(await cache.get("key")).toBeUndefined()
  })

  test("clear empties the cache", async () => {
    const cache = new InMemoryCache()
    await cache.set("a", 1, 60_000)
    await cache.set("b", 2, 60_000)
    cache.clear()
    expect(cache.size()).toBe(0)
  })

  test("stores different value types", async () => {
    const cache = new InMemoryCache()
    await cache.set("str",  "hello",       60_000)
    await cache.set("num",  42,            60_000)
    await cache.set("obj",  { a: 1 },      60_000)
    await cache.set("arr",  [1, 2, 3],     60_000)
    await cache.set("null", null,          60_000)
    await cache.set("bool", false,         60_000)

    expect(await cache.get("str")).toBe("hello")
    expect(await cache.get("num")).toBe(42)
    expect(await cache.get("obj")).toEqual({ a: 1 })
    expect(await cache.get("arr")).toEqual([1, 2, 3])
    expect(await cache.get("null")).toBeNull()
    expect(await cache.get("bool")).toBe(false)
  })
})

// ─────────────────────────────────────────────
// ERROR ROUTING
// ─────────────────────────────────────────────

describe("Error routing", () => {
  test("routable: true when node returns ok: false", async () => {
    const ex = new NodeExecutor(registry([failImpl("bad input")]))
    const { outcome } = await ex.execute(baseNode(), baseCtx)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.routable).toBe(true)
  })

  test("routable: true when node throws", async () => {
    const ex = new NodeExecutor(registry([throwImpl("crash")]))
    const { outcome } = await ex.execute(baseNode(), baseCtx)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.routable).toBe(true)
  })

  test("routable: false when implementation not found", async () => {
    const ex = new NodeExecutor(registry([]))
    const { outcome } = await ex.execute(baseNode(), baseCtx)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.routable).toBe(false)
  })

  test("routable: false when config resolution fails", async () => {
    const node = baseNode({
      config: { x: { type: "ref", path: "$.ghost.field" } },
    })
    const ex = new NodeExecutor(registry([successImpl()]))
    const { outcome } = await ex.execute(node, baseCtx)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.routable).toBe(false)
  })
})

// ─────────────────────────────────────────────
// DURATION TRACKING
// ─────────────────────────────────────────────

describe("Duration tracking", () => {
  test("durationMs reflects actual execution time", async () => {
    const slow = impl(async () => {
      await sleep(50)
      return { ok: true, data: null }
    })

    const ex = new NodeExecutor(registry([slow]))
    const { outcome } = await ex.execute(baseNode(), baseCtx)

    expect(outcome.durationMs).toBeGreaterThanOrEqual(40)
  })

  test("durationMs is set even on failure", async () => {
    const ex = new NodeExecutor(registry([failImpl()]))
    const { outcome } = await ex.execute(baseNode(), baseCtx)

    expect(outcome.ok).toBe(false)
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
  })

  test("durationMs spans all retry attempts", async () => {
    let calls = 0
    const retryable = impl(async () => {
      calls++
      await sleep(20)
      if (calls < 3) return { ok: false as const, error: "not yet" }
      return { ok: true as const, data: null }
    })

    const ex = new NodeExecutor(registry([retryable]))
    const def = baseNode({
      retry: { maxAttempts: 3, backoff: "fixed", delayMs: 1 },
    })

    const { outcome } = await ex.execute(def, baseCtx)
    expect(outcome.ok).toBe(true)
    // 3 attempts × ~20ms each = ~60ms minimum
    expect(outcome.durationMs).toBeGreaterThanOrEqual(50)
  })
})

// ─────────────────────────────────────────────
// INTEGRATION
// ─────────────────────────────────────────────

describe("Integration — lead qualifier node", () => {
  test("full node execution with config resolution, retry, and caching", async () => {
    let executions = 0

    const scoreImpl = impl(async (ctx) => {
      executions++
      const score = ctx.config.score as number
      if (score > 0.7) {
        return {
          ok:   true,
          data: { qualified: true, tier: "enterprise", score },
        }
      }
      return { ok: false as const, error: "score too low", retry: false }
    }, "ai.score")

    const cache = new InMemoryCache()
    const ex    = new NodeExecutor(registry([scoreImpl]), cache)

    const node: NodeDefinition = {
      id:   "scoreLead",
      type: "ai.score",
      config: {
        score:  { type: "ref",     path: "$.trigger.body.score" },
        prompt: { type: "template", parts: [
          { type: "literal", value: "Score this lead: " },
          { type: "ref",     path: "$.upstream.data" },
        ]},
      },
      retry: { maxAttempts: 2, backoff: "fixed", delayMs: 1 },
      cache: {
        ttlMs: 60_000,
        key:   { type: "ref", path: "$.trigger.body.email" },
      },
    }

    // First run — cache miss
    const first = await ex.execute(node, baseCtx)
    expect(first.outcome.ok).toBe(true)
    if (first.outcome.ok) {
      expect(first.outcome.data).toEqual({ qualified: true, tier: "enterprise", score: 0.82 })
      expect(first.outcome.fromCache).toBe(false)
      expect(first.outcome.attempts).toBe(1)
    }

    // Second run same context — cache hit
    const second = await ex.execute(node, baseCtx)
    expect(second.outcome.ok).toBe(true)
    if (second.outcome.ok) {
      expect(second.outcome.fromCache).toBe(true)
    }

    expect(executions).toBe(1)  // only ran once
  })
})
