import { describe, test, expect, beforeEach } from "bun:test"
import {
  InMemoryExecutionStore,
  InMemoryPlanCache,
  Scheduler,
  type ExecutionContext,
  type ExecutionJob,
  type ExecutionRecord,
  type IExecutionStore,
  type SchedulerEvent,
} from "../../../src/engine/runtime/index"
import type { NodeExecutionState } from "../../../src/engine/runtime/context"
import type {
  ExecutionPlan,
  ExecutionStage,
  NodeDefinition,
  Edge,
} from "../../../src/engine/types"
import type {
  INodeRegistry,
  INodeImplementation,
  NodeContext,
} from "../../../src/engine/executor"

// ─────────────────────────────────────────────
// TEST HELPERS
// ─────────────────────────────────────────────

let idCounter = 0
const newId = () => `exec_${++idCounter}`

// Build a minimal valid ExecutionPlan
function makePlan(overrides: {
  nodes:  Record<string, NodeDefinition>
  edges?: Edge[]
  stages?: ExecutionStage[]
}): ExecutionPlan {
  const { nodes, edges = [], stages } = overrides
  const nodeIds = Object.keys(nodes)

  // Auto-build single-stage plan if stages not provided
  const builtStages: ExecutionStage[] = stages ?? [{
    index: 0,
    nodes: nodeIds,
    edges: Object.fromEntries(nodeIds.map(id => [id, edges.filter(e => e.from === id)])),
  }]

  const routing: Record<string, import("../../../src/engine/types").ExecutionEdge[]> = {}
  for (const edge of edges) {
    if (!routing[edge.from]) routing[edge.from] = []
    routing[edge.from]!.push({ edge, sourceStage: 0, targetStage: 1 })
  }

  return {
    flowId:      "flow_test",
    version:     "1.0.0",
    compiledAt:  Date.now(),
    stages:      builtStages,
    nodes,
    triggerIds:  [],
    statics:     {},
    routing,
    nodeCount:   nodeIds.length,
    stageCount:  builtStages.length,
    hasBranching: false,
    hasFanOut:    false,
  }
}

function makeNode(id: string, type = "test.node"): NodeDefinition {
  return { id, type, config: {} }
}

function makeEdge(id: string, from: string, to: string, extra?: Partial<Edge>): Edge {
  return { id, from, to, ...extra }
}

// Build a node implementation
function nodeImpl(
  type: string,
  fn:   (ctx: NodeContext) => Promise<{ ok: boolean; data?: unknown; error?: string }>,
): INodeImplementation {
  return { type, execute: fn as INodeImplementation["execute"] }
}

// Simple success node
const successNode = (type: string, data: unknown = { ok: true }) =>
  nodeImpl(type, async () => ({ ok: true, data }))

// Simple fail node
const failNode = (type: string, error = "node failed") =>
  nodeImpl(type, async () => ({ ok: false, error }))

// Registry from array of implementations
function makeRegistry(impls: INodeImplementation[]): INodeRegistry {
  return { get: (type) => impls.find(i => i.type === type) }
}

function makeJob(flowId = "flow_test", trigger: unknown = { body: {} }): ExecutionJob {
  return { executionId: newId(), flowId, version: "1.0.0", trigger }
}

// ─────────────────────────────────────────────
// IN-MEMORY EXECUTION STORE
// ─────────────────────────────────────────────

describe("InMemoryExecutionStore", () => {
  let store: InMemoryExecutionStore

  beforeEach(() => { store = new InMemoryExecutionStore() })

  test("saves and retrieves a record", async () => {
    const record = {
      executionId: "exec_1",
      flowId:      "flow_a",
      version:     "1.0.0",
      status:      "completed" as const,
      trigger:     { body: {} },
      startedAt:   Date.now(),
      endedAt:     Date.now(),
      durationMs:  100,
      nodeStates:  {},
      nodeTimings: {},
      slowNodes:   [],
      finalContext: {},
    }

    await store.saveRecord(record)
    const retrieved = await store.getRecord("exec_1")
    expect(retrieved).toEqual(record)
  })

  test("returns undefined for missing record", async () => {
    expect(await store.getRecord("missing")).toBeUndefined()
  })

  test("saves and retrieves a context", async () => {
    const ctx: ExecutionContext = {
      executionId:  "exec_1",
      flowId:       "flow_a",
      version:      "1.0.0",
      trigger:      { body: { email: "test@test.com" } },
      nodes:        { fetchData: { result: "ok" } },
      nodeStates:   {},
      status:       "running",
      startedAt:    Date.now(),
      currentStage: 2,
    }

    await store.saveContext(ctx)
    const retrieved = await store.getContext("exec_1")
    expect(retrieved?.currentStage).toBe(2)
    expect(retrieved?.nodes).toEqual({ fetchData: { result: "ok" } })
  })

  test("context is deep-cloned on save — mutations don't affect stored value", async () => {
    const ctx: ExecutionContext = {
      executionId:  "exec_1",
      flowId:       "flow_a",
      version:      "1.0.0",
      trigger:      {},
      nodes:        { a: "original" },
      nodeStates:   {},
      status:       "running",
      startedAt:    Date.now(),
      currentStage: 0,
    }

    await store.saveContext(ctx)
    ctx.nodes["a"] = "mutated"  // mutate after save

    const retrieved = await store.getContext("exec_1")
    expect(retrieved?.nodes["a"]).toBe("original")  // stored value unchanged
  })
})

// ─────────────────────────────────────────────
// IN-MEMORY PLAN CACHE
// ─────────────────────────────────────────────

describe("InMemoryPlanCache", () => {
  test("stores and retrieves a plan by flowId + version", () => {
    const cache = new InMemoryPlanCache()
    const plan  = makePlan({ nodes: { a: makeNode("a") } })

    cache.set("flow_a", "1.0.0", plan)
    expect(cache.get("flow_a", "1.0.0")).toBe(plan)
  })

  test("returns undefined for missing plan", () => {
    const cache = new InMemoryPlanCache()
    expect(cache.get("missing", "1.0.0")).toBeUndefined()
  })

  test("invalidate removes all versions of a flow", () => {
    const cache = new InMemoryPlanCache()
    const plan  = makePlan({ nodes: { a: makeNode("a") } })

    cache.set("flow_a", "1.0.0", plan)
    cache.set("flow_a", "2.0.0", plan)
    cache.set("flow_b", "1.0.0", plan)

    cache.invalidate("flow_a")

    expect(cache.get("flow_a", "1.0.0")).toBeUndefined()
    expect(cache.get("flow_a", "2.0.0")).toBeUndefined()
    expect(cache.get("flow_b", "1.0.0")).toBe(plan)
  })
})

// ─────────────────────────────────────────────
// SCHEDULER — single node
// ─────────────────────────────────────────────

describe("Scheduler — single node", () => {
  test("runs a successful single-node flow", async () => {
    const plan  = makePlan({ nodes: { n: makeNode("n", "greet") } })
    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", plan)

    const scheduler = new Scheduler(
      plans,
      new InMemoryExecutionStore(),
      makeRegistry([successNode("greet", { hello: "world" })]),
    )

    const record = await scheduler.processJob(makeJob())

    expect(record.status).toBe("completed")
    expect(record.nodeStates["n"]?.status).toBe("completed")
    expect(record.nodeStates["n"]?.output).toEqual({ hello: "world" })
    expect(record.finalContext["n"]).toEqual({ hello: "world" })
  })

  test("records failure when node fails with no error edges", async () => {
    const plan  = makePlan({ nodes: { n: makeNode("n", "bad") } })
    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", plan)

    const scheduler = new Scheduler(
      plans,
      new InMemoryExecutionStore(),
      makeRegistry([failNode("bad", "something broke")]),
    )

    const record = await scheduler.processJob(makeJob())

    expect(record.status).toBe("failed")
    expect(record.error).toContain("something broke")
    expect(record.nodeStates["n"]?.status).toBe("failed")
  })

  test("writes execution record to store", async () => {
    const plan  = makePlan({ nodes: { n: makeNode("n", "ok") } })
    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", plan)

    const store = new InMemoryExecutionStore()
    const job   = makeJob()

    const scheduler = new Scheduler(
      plans,
      store,
      makeRegistry([successNode("ok")]),
    )

    await scheduler.processJob(job)

    const saved = await store.getRecord(job.executionId)
    expect(saved).toBeDefined()
    expect(saved?.executionId).toBe(job.executionId)
    expect(saved?.status).toBe("completed")
  })

  test("throws when plan not found", async () => {
    const plans     = new InMemoryPlanCache()
    const scheduler = new Scheduler(
      plans,
      new InMemoryExecutionStore(),
      makeRegistry([]),
    )

    await expect(scheduler.processJob(makeJob("missing_flow")))
      .rejects.toThrow("No execution plan found")
  })
})

// ─────────────────────────────────────────────
// SCHEDULER — multi-stage linear flow
// ─────────────────────────────────────────────

describe("Scheduler — linear flow", () => {
  test("runs stages in order — each node sees previous output", async () => {
    const executionOrder: string[] = []
    let   seenUpstream: unknown    = null

    const fetchImpl = nodeImpl("fetch", async () => {
      executionOrder.push("fetch")
      return { ok: true, data: { leads: ["alice", "bob"] } }
    })

    const processImpl = nodeImpl("process", async (ctx) => {
      executionOrder.push("process")
      seenUpstream = ctx.nodes["fetch"]
      return { ok: true, data: { processed: true } }
    })

    const plan = makePlan({
      nodes: {
        fetch:   makeNode("fetch",   "fetch"),
        process: makeNode("process", "process"),
      },
      edges: [makeEdge("e1", "fetch", "process")],
      stages: [
        { index: 0, nodes: ["fetch"],   edges: { fetch:   [makeEdge("e1", "fetch", "process")] } },
        { index: 1, nodes: ["process"], edges: { process: [] } },
      ],
    })

    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", plan)

    const scheduler = new Scheduler(
      plans,
      new InMemoryExecutionStore(),
      makeRegistry([fetchImpl, processImpl]),
    )

    const record = await scheduler.processJob(makeJob())

    expect(record.status).toBe("completed")
    expect(executionOrder).toEqual(["fetch", "process"])
    expect(seenUpstream).toEqual({ leads: ["alice", "bob"] })
  })

  test("trigger data is available to all nodes", async () => {
    let seenTrigger: unknown = null

    const impl = nodeImpl("check", async (ctx) => {
      seenTrigger = ctx.trigger
      return { ok: true, data: null }
    })

    const plan  = makePlan({ nodes: { n: makeNode("n", "check") } })
    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", plan)

    const scheduler = new Scheduler(
      plans,
      new InMemoryExecutionStore(),
      makeRegistry([impl]),
    )

    const trigger = { body: { email: "test@orion.dev", score: 0.9 } }
    await scheduler.processJob(makeJob("flow_test", trigger))

    expect(seenTrigger).toEqual(trigger)
  })
})

// ─────────────────────────────────────────────
// SCHEDULER — parallel execution
// ─────────────────────────────────────────────

describe("Scheduler — parallel execution", () => {
  test("parallel nodes in same stage run concurrently", async () => {
    const startTimes: Record<string, number> = {}
    const endTimes:   Record<string, number> = {}

    const makeSlowImpl = (type: string, delayMs: number) =>
      nodeImpl(type, async () => {
        startTimes[type] = Date.now()
        await new Promise(r => setTimeout(r, delayMs))
        endTimes[type]   = Date.now()
        return { ok: true, data: { type } }
      })

    const plan = makePlan({
      nodes: {
        trigger: makeNode("trigger", "trigger"),
        score:   makeNode("score",   "score"),
        enrich:  makeNode("enrich",  "enrich"),
        notify:  makeNode("notify",  "notify"),
      },
      edges: [
        makeEdge("e1", "trigger", "score"),
        makeEdge("e2", "trigger", "enrich"),
        makeEdge("e3", "score",   "notify"),
        makeEdge("e4", "enrich",  "notify"),
      ],
      stages: [
        { index: 0, nodes: ["trigger"], edges: { trigger: [makeEdge("e1","trigger","score"), makeEdge("e2","trigger","enrich")] } },
        { index: 1, nodes: ["score", "enrich"], edges: { score: [makeEdge("e3","score","notify")], enrich: [makeEdge("e4","enrich","notify")] } },
        { index: 2, nodes: ["notify"], edges: { notify: [] } },
      ],
    })

    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", plan)

    const scheduler = new Scheduler(
      plans,
      new InMemoryExecutionStore(),
      makeRegistry([
        makeSlowImpl("trigger", 5),
        makeSlowImpl("score",   50),
        makeSlowImpl("enrich",  50),
        successNode("notify", { sent: true }),
      ]),
    )

    const before = Date.now()
    const record = await scheduler.processJob(makeJob())
    const elapsed = Date.now() - before

    expect(record.status).toBe("completed")

    // Both score and enrich started before either ended
    expect(startTimes["score"]).toBeDefined()
    expect(startTimes["enrich"]).toBeDefined()
    const latestStart = Math.max(startTimes["score"]!, startTimes["enrich"]!)
    const earliestEnd = Math.min(endTimes["score"]!,  endTimes["enrich"]!)
    expect(latestStart).toBeLessThan(earliestEnd)

    // Total time should be ~60ms (5 + 50 overlap), not ~105ms (5 + 50 + 50 serial)
    expect(elapsed).toBeLessThan(120)
  })
})

// ─────────────────────────────────────────────
// SCHEDULER — error routing
// ─────────────────────────────────────────────

describe("Scheduler — error routing", () => {
  test("error edge fires when node fails", async () => {
    const handlerRan = { value: false }

    const plan = makePlan({
      nodes: {
        trigger: makeNode("trigger",  "trigger"),
        fetch:   makeNode("fetch",    "fetch.fail"),
        handler: makeNode("handler",  "error.handler"),
      },
      edges: [
        makeEdge("e1", "trigger", "fetch"),
        makeEdge("e2", "fetch",   "handler", { kind: "error" }),
      ],
      stages: [
        { index: 0, nodes: ["trigger"], edges: { trigger: [makeEdge("e1","trigger","fetch")] } },
        { index: 1, nodes: ["fetch"],   edges: { fetch: [makeEdge("e2","fetch","handler",{kind:"error"})] } },
        { index: 2, nodes: ["handler"], edges: { handler: [] } },
      ],
    })

    // Fix routing to use correct stage references
    plan.routing["trigger"] = [{ edge: makeEdge("e1","trigger","fetch"), sourceStage: 0, targetStage: 1 }]
    plan.routing["fetch"]   = [{ edge: makeEdge("e2","fetch","handler",{kind:"error"}), sourceStage: 1, targetStage: 2 }]

    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", plan)

    const scheduler = new Scheduler(
      plans,
      new InMemoryExecutionStore(),
      makeRegistry([
        successNode("trigger", {}),
        failNode("fetch.fail", "api timeout"),
        nodeImpl("error.handler", async () => {
          handlerRan.value = true
          return { ok: true, data: { handled: true } }
        }),
      ]),
    )

    const record = await scheduler.processJob(makeJob())

    expect(record.nodeStates["fetch"]?.status).toBe("failed")
    expect(handlerRan.value).toBe(true)
    expect(record.nodeStates["handler"]?.status).toBe("completed")
  })

  test("flow fails when no error edge and node fails", async () => {
    const plan  = makePlan({ nodes: { n: makeNode("n", "fail") } })
    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", plan)

    const scheduler = new Scheduler(
      plans,
      new InMemoryExecutionStore(),
      makeRegistry([failNode("fail")]),
    )

    const record = await scheduler.processJob(makeJob())
    expect(record.status).toBe("failed")
  })
})

// ─────────────────────────────────────────────
// SCHEDULER — conditional edges
// ─────────────────────────────────────────────

describe("Scheduler — conditional edges", () => {
  test("skips target node when condition is false", async () => {
    const notifyRan = { value: false }

    const scoreNode = nodeImpl("score", async () => ({
      ok: true, data: { score: 0.3 }  // below threshold
    }))

    const notifyNode = nodeImpl("notify", async () => {
      notifyRan.value = true
      return { ok: true, data: { sent: true } }
    })

    const condition = {
      type: "fn" as const,
      name: "gt",
      args: [
        { type: "ref" as const,     path: "$.score.score" },
        { type: "literal" as const, value: 0.7 },
      ],
    }

    const plan = makePlan({
      nodes: {
        trigger: makeNode("trigger", "trigger"),
        score:   makeNode("score",   "score"),
        notify:  makeNode("notify",  "notify"),
      },
      edges: [
        makeEdge("e1", "trigger", "score"),
        makeEdge("e2", "score",   "notify", { condition }),
      ],
      stages: [
        { index: 0, nodes: ["trigger"], edges: {} },
        { index: 1, nodes: ["score"],   edges: {} },
        { index: 2, nodes: ["notify"],  edges: {} },
      ],
    })

    plan.routing["trigger"] = [{ edge: makeEdge("e1","trigger","score"),               sourceStage: 0, targetStage: 1 }]
    plan.routing["score"]   = [{ edge: makeEdge("e2","score","notify",{condition}),    sourceStage: 1, targetStage: 2 }]

    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", plan)

    const scheduler = new Scheduler(
      plans,
      new InMemoryExecutionStore(),
      makeRegistry([successNode("trigger", {}), scoreNode, notifyNode]),
    )

    await scheduler.processJob(makeJob())

    expect(notifyRan.value).toBe(false)
  })
})

// ─────────────────────────────────────────────
// RESUMABILITY
// ─────────────────────────────────────────────

describe("Resumability", () => {
  test("resumes from checkpointed context — skips completed stages", async () => {
    const executionOrder: string[] = []

    const fetchImpl = nodeImpl("fetch", async () => {
      executionOrder.push("fetch")
      return { ok: true, data: { leads: 5 } }
    })
    const processImpl = nodeImpl("process", async () => {
      executionOrder.push("process")
      return { ok: true, data: { done: true } }
    })

    const plan = makePlan({
      nodes: {
        fetch:   makeNode("fetch",   "fetch"),
        process: makeNode("process", "process"),
      },
      stages: [
        { index: 0, nodes: ["fetch"],   edges: {} },
        { index: 1, nodes: ["process"], edges: {} },
      ],
    })

    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", plan)

    // Build a context that simulates fetch already completed
    const resumeCtx: ExecutionContext = {
      executionId:  "exec_resume",
      flowId:       "flow_test",
      version:      "1.0.0",
      trigger:      { body: {} },
      nodes:        { fetch: { leads: 5 } },   // fetch output already present
      nodeStates: {
        fetch: {
          status:    "completed",
          attempts:  1,
          fromCache: false,
          startedAt: Date.now() - 500,
          endedAt:   Date.now() - 400,
          output:    { leads: 5 },
          logs:      [],
        },
        process: {
          status:    "pending",
          attempts:  0,
          fromCache: false,
          logs:      [],
        },
      },
      status:       "running",
      startedAt:    Date.now() - 500,
      currentStage: 1,   // start from stage 1 — skip stage 0
    }

    const scheduler = new Scheduler(
      plans,
      new InMemoryExecutionStore(),
      makeRegistry([fetchImpl, processImpl]),
    )

    const record = await scheduler.processJob({
      executionId: "exec_resume",
      flowId:      "flow_test",
      version:     "1.0.0",
      trigger:     { body: {} },
      resumeFrom:  resumeCtx,
    })

    expect(record.status).toBe("completed")
    // fetch should NOT have re-run — we resumed from stage 1
    expect(executionOrder).not.toContain("fetch")
    expect(executionOrder).toContain("process")
  })

  test("checkpoint saves context after each stage", async () => {
    const store = new InMemoryExecutionStore()

    const plan = makePlan({
      nodes: {
        a: makeNode("a", "nodeA"),
        b: makeNode("b", "nodeB"),
      },
      stages: [
        { index: 0, nodes: ["a"], edges: {} },
        { index: 1, nodes: ["b"], edges: {} },
      ],
    })

    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", plan)

    const scheduler = new Scheduler(
      plans,
      store,
      makeRegistry([
        successNode("nodeA", { a: 1 }),
        successNode("nodeB", { b: 2 }),
      ]),
      undefined,
      { checkpoint: true },
    )

    const stages: number[] = []
    const save = store.saveContext.bind(store)
    store.saveContext = async (ctx) => { stages.push(ctx.currentStage); return save(ctx) }

    const job = makeJob()
    await scheduler.processJob(job)

    expect(stages).toEqual([0, 1])
    // The run ended, so there is nothing left to resume from.
    expect(await store.getContext(job.executionId)).toBeUndefined()
  })

  test("a failing node ends the run only once its stage has settled", async () => {
    let siblingDone = false
    const plan  = makePlan({ nodes: { a: makeNode("a", "fails"), b: makeNode("b", "slow") } })
    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", plan)

    const record = await new Scheduler(
      plans, new InMemoryExecutionStore(),
      makeRegistry([
        failNode("fails"),
        nodeImpl("slow", async () => { await new Promise(r => setTimeout(r, 30)); siblingDone = true; return { ok: true, data: 1 } }),
      ]),
    ).processJob(makeJob())

    expect(record.status).toBe("failed")
    expect(siblingDone).toBe(true)
    expect(record.nodeStates["b"]?.status).toBe("completed")
  })

  test("a node that cannot run fails the run rather than being stepped over", async () => {
    const plan  = makePlan({
      nodes:  { a: makeNode("a", "unregistered"), b: makeNode("b", "nodeB") },
      stages: [
        { index: 0, nodes: ["a"], edges: {} },
        { index: 1, nodes: ["b"], edges: {} },
      ],
    })
    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", plan)

    const record = await new Scheduler(
      plans, new InMemoryExecutionStore(),
      makeRegistry([successNode("nodeB", { b: 2 })]),
    ).processJob(makeJob())

    expect(record.status).toBe("failed")
    expect(record.error).toMatch(/No implementation registered/)
    expect(record.nodeStates["b"]?.status).toBe("pending")
  })

  test("a run suspended at a wait is checkpointed and not recorded", async () => {
    const store = new InMemoryExecutionStore()
    const plan  = makePlan({
      nodes:  { a: makeNode("a", "waits"), b: makeNode("b", "nodeB") },
      stages: [
        { index: 0, nodes: ["a"], edges: {} },
        { index: 1, nodes: ["b"], edges: {} },
      ],
    })
    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", plan)

    const scheduler = new Scheduler(
      plans, store,
      makeRegistry([
        successNode("waits", { __orion_wait: true, resumeKey: "k" }),
        successNode("nodeB", { b: 2 }),
      ]),
    )

    const job    = makeJob()
    const record = await scheduler.processJob(job)

    expect(record.status).toBe("waiting")
    expect(await store.getRecord(job.executionId)).toBeUndefined()
    const saved = await store.getContext(job.executionId)
    expect(saved?.status).toBe("waiting")
    expect(saved?.nodeStates["b"]?.status).toBe("pending")
  })
})

// ─────────────────────────────────────────────
// EXECUTION RECORD
// ─────────────────────────────────────────────

describe("Execution record", () => {
  test("record includes node timings", async () => {
    const plan  = makePlan({ nodes: { n: makeNode("n", "ok") } })
    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", plan)

    const scheduler = new Scheduler(
      plans,
      new InMemoryExecutionStore(),
      makeRegistry([successNode("ok")]),
    )

    const record = await scheduler.processJob(makeJob())
    expect(record.nodeTimings["n"]).toBeGreaterThanOrEqual(0)
  })

  test("flags slow nodes above threshold", async () => {
    const plan  = makePlan({ nodes: { slow: makeNode("slow", "slowNode") } })
    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", plan)

    const scheduler = new Scheduler(
      plans,
      new InMemoryExecutionStore(),
      makeRegistry([
        nodeImpl("slowNode", async () => {
          await new Promise(r => setTimeout(r, 1100))
          return { ok: true, data: null }
        }),
      ]),
    )

    const record = await scheduler.processJob(makeJob())
    expect(record.slowNodes).toContain("slow")
  }, 5000)

  test("record durationMs spans full execution", async () => {
    const plan  = makePlan({ nodes: { n: makeNode("n", "ok") } })
    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", plan)

    const scheduler = new Scheduler(
      plans,
      new InMemoryExecutionStore(),
      makeRegistry([successNode("ok")]),
    )

    const record = await scheduler.processJob(makeJob())
    expect(record.durationMs).toBeGreaterThanOrEqual(0)
    expect(record.endedAt - record.startedAt).toBe(record.durationMs)
  })

  test("finalContext contains all node outputs", async () => {
    const plan = makePlan({
      nodes: {
        a: makeNode("a", "nodeA"),
        b: makeNode("b", "nodeB"),
      },
      stages: [
        { index: 0, nodes: ["a", "b"], edges: {} },
      ],
    })

    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", plan)

    const scheduler = new Scheduler(
      plans,
      new InMemoryExecutionStore(),
      makeRegistry([
        successNode("nodeA", { from: "a" }),
        successNode("nodeB", { from: "b" }),
      ]),
    )

    const record = await scheduler.processJob(makeJob())
    expect(record.finalContext["a"]).toEqual({ from: "a" })
    expect(record.finalContext["b"]).toEqual({ from: "b" })
  })
})

// ─────────────────────────────────────────────
// SCHEDULER — events
// ─────────────────────────────────────────────

describe("Scheduler — events", () => {
  function makeSingleNodePlan(type = "ok"): ExecutionPlan {
    return makePlan({ nodes: { n: makeNode("n", type) } })
  }

  function makeMultiStagePlan(): ExecutionPlan {
    return makePlan({
      nodes: {
        a: makeNode("a", "nodeA"),
        b: makeNode("b", "nodeB"),
      },
      stages: [
        { index: 0, nodes: ["a"], edges: {} },
        { index: 1, nodes: ["b"], edges: {} },
      ],
    })
  }

  test("emits execution:started and execution:completed on success", async () => {
    const events: SchedulerEvent[] = []
    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", makeSingleNodePlan())

    const scheduler = new Scheduler(
      plans, new InMemoryExecutionStore(),
      makeRegistry([successNode("ok")]),
    )
    scheduler.on(e => events.push(e))

    const job = makeJob()
    await scheduler.processJob(job)

    const types = events.map(e => e.type)
    expect(types).toContain("execution:started")
    expect(types).toContain("execution:completed")
    expect(types).not.toContain("execution:failed")
  })

  test("emits execution:failed on flow failure", async () => {
    const events: SchedulerEvent[] = []
    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", makeSingleNodePlan("bad"))

    const scheduler = new Scheduler(
      plans, new InMemoryExecutionStore(),
      makeRegistry([failNode("bad")]),
    )
    scheduler.on(e => events.push(e))

    await scheduler.processJob(makeJob())

    expect(events.some(e => e.type === "execution:failed")).toBe(true)
  })

  test("emits node:started and node:completed per node", async () => {
    const events: SchedulerEvent[] = []
    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", makeSingleNodePlan())

    const scheduler = new Scheduler(
      plans, new InMemoryExecutionStore(),
      makeRegistry([successNode("ok")]),
    )
    scheduler.on(e => events.push(e))

    await scheduler.processJob(makeJob())

    expect(events.some(e => e.type === "node:started"   && e.nodeId === "n")).toBe(true)
    expect(events.some(e => e.type === "node:completed" && e.nodeId === "n")).toBe(true)
  })

  test("emits node:failed on node failure", async () => {
    const events: SchedulerEvent[] = []
    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", makeSingleNodePlan("bad"))

    const scheduler = new Scheduler(
      plans, new InMemoryExecutionStore(),
      makeRegistry([failNode("bad", "boom")]),
    )
    scheduler.on(e => events.push(e))

    await scheduler.processJob(makeJob())

    const failEvent = events.find(e => e.type === "node:failed")
    expect(failEvent).toBeDefined()
    if (failEvent?.type === "node:failed") {
      expect(failEvent.error).toBe("boom")
    }
  })

  test("emits stage:completed after each stage", async () => {
    const events: SchedulerEvent[] = []
    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", makeMultiStagePlan())

    const scheduler = new Scheduler(
      plans, new InMemoryExecutionStore(),
      makeRegistry([successNode("nodeA"), successNode("nodeB")]),
    )
    scheduler.on(e => events.push(e))

    await scheduler.processJob(makeJob())

    const stageEvents = events.filter(e => e.type === "stage:completed")
    expect(stageEvents).toHaveLength(2)
  })

  test("on() returns unsubscribe function", async () => {
    const events: SchedulerEvent[] = []
    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", makeSingleNodePlan())

    const scheduler = new Scheduler(
      plans, new InMemoryExecutionStore(),
      makeRegistry([successNode("ok")]),
    )

    const unsub = scheduler.on(e => events.push(e))
    unsub()  // unsubscribe before running

    await scheduler.processJob(makeJob())
    expect(events).toHaveLength(0)
  })

  test("listener errors do not crash the scheduler", async () => {
    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", makeSingleNodePlan())

    const scheduler = new Scheduler(
      plans, new InMemoryExecutionStore(),
      makeRegistry([successNode("ok")]),
    )

    // Listener that always throws
    scheduler.on(() => { throw new Error("listener crash") })

    // Should still complete successfully
    const record = await scheduler.processJob(makeJob())
    expect(record.status).toBe("completed")
  })

  test("node:completed carries fromCache flag", async () => {
    const events: SchedulerEvent[] = []
    const plans = new InMemoryPlanCache()
    plans.set("flow_test", "1.0.0", makeSingleNodePlan())

    const scheduler = new Scheduler(
      plans, new InMemoryExecutionStore(),
      makeRegistry([successNode("ok")]),
    )
    scheduler.on(e => events.push(e))

    await scheduler.processJob(makeJob())

    const completed = events.find(e => e.type === "node:completed")
    if (completed?.type === "node:completed") {
      expect(completed.fromCache).toBe(false)
    }
  })
})
