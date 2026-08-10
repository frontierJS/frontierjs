import { describe, test, expect, beforeEach } from "vitest"
import { Compiler, type IPluginRegistry } from "./index"
import type { Flow, NodeDefinition, Edge, JSONSchema } from "../types"

// ─────────────────────────────────────────────
// TEST REGISTRY
// ─────────────────────────────────────────────

const TRIGGER_TYPES = new Set(["trigger.webhook", "trigger.cron", "trigger.manual"])

const SCHEMAS: Record<string, { input?: JSONSchema; output?: JSONSchema }> = {
  "ai": {
    output: { type: "object", properties: { score: { type: "number" }, reason: { type: "string" } } },
  },
  "io.slack": {
    // io.slack accepts any object from upstream context
    // its actual message/channel come from config expressions, not edge data
    input: { type: "object" },
  },
  "data.transform": {
    output: { type: "object" },
    input:  { type: "object" },
  },
  "http.request": {
    output: { type: "object" },
  },
}

const KNOWN_FNS = new Set(["gt", "lt", "gte", "lte", "eq", "and", "or", "not", "pick"])

const ERROR_TYPES = new Set(["flow.error"])
const LOOP_TYPES  = new Set(["flow.loop"])
const STORE_TYPES = new Set(["store"])
const AI_TYPES    = new Set(["ai"])

const ALL_KNOWN = new Set([
  ...TRIGGER_TYPES, ...ERROR_TYPES, ...LOOP_TYPES,
  ...STORE_TYPES, ...AI_TYPES,
  "http.request", "data.transform", "io.slack",
  "flow.each", "flow.merge", "flow.delay", "flow.wait",
  "data.code", "data.template", "data.parse", "expr.pipeline",
  "http.respond", "subflow.enrich_lead",
])

const registry: IPluginRegistry = {
  has:              (type) => ALL_KNOWN.has(type),
  isTrigger:        (type) => TRIGGER_TYPES.has(type),
  isErrorHandler:   (type) => ERROR_TYPES.has(type),
  isLoopNode:       (type) => LOOP_TYPES.has(type),
  isStoreNode:      (type) => STORE_TYPES.has(type),
  isAiNode:         (type) => AI_TYPES.has(type),
  getOutputSchema:  (type) => SCHEMAS[type]?.output,
  getInputSchema:   (type) => SCHEMAS[type]?.input,
  getFunctionNames: ()     => KNOWN_FNS,
}

// ─────────────────────────────────────────────
// FLOW BUILDER HELPERS
// ─────────────────────────────────────────────

const baseFlow = (): Flow => ({
  id: "flow_test", version: "1.0.0", name: "Test Flow",
  accountId: "acc_test", workspaceId: "ws_test",
  createdBy: "user_test", createdAt: 0, updatedAt: 0,
  nodes: {}, edges: [],
})

const triggerNode = (id = "start"): NodeDefinition => ({
  id, type: "trigger.webhook",
  config: { path: { type: "literal", value: `/hooks/${id}` } },
})

const node = (id: string, type = "http.request"): NodeDefinition => ({ id, type, config: {} })

const edge = (id: string, from: string, to: string, extra?: Partial<Edge>): Edge =>
  ({ id, from, to, ...extra })

// ─────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────

let compiler: Compiler

beforeEach(() => { compiler = new Compiler(registry) })

// ─── STEP 1: VALIDATE NODES ──────────────────

describe("Step 1 — validateNodes", () => {
  test("fails with no nodes", () => {
    const result = compiler.compile(baseFlow())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0].code).toBe("NO_NODES")
  })

  test("fails with unknown node type", () => {
    const flow = {
      ...baseFlow(),
      nodes: { "start": triggerNode(), "bad": node("bad", "not.real") },
      edges: [edge("e1", "start", "bad")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "UNKNOWN_NODE_TYPE")).toBe(true)
  })

  test("passes with valid node types", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: { "start": triggerNode(), "req": node("req") },
      edges: [edge("e1", "start", "req")],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })
})

// ─── STEP 2: VALIDATE EDGES ──────────────────

describe("Step 2 — validateEdges", () => {
  test("fails when edge source does not exist", () => {
    const flow: Flow = { ...baseFlow(), nodes: { "start": triggerNode() }, edges: [edge("e1", "ghost", "start")] }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_EDGE_SOURCE")).toBe(true)
  })

  test("fails when edge target does not exist", () => {
    const flow: Flow = { ...baseFlow(), nodes: { "start": triggerNode() }, edges: [edge("e1", "start", "ghost")] }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_EDGE_TARGET")).toBe(true)
  })
})

// ─── STEP 4: DETECT CYCLES ───────────────────

describe("Step 4 — detectCycles", () => {
  test("fails on A → B → A cycle", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: { "start": triggerNode(), "a": node("a"), "b": node("b") },
      edges: [edge("e1", "start", "a"), edge("e2", "a", "b"), edge("e3", "b", "a")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "CYCLE_DETECTED")).toBe(true)
  })

  test("fails on self-loop", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: { "start": triggerNode(), "a": node("a") },
      edges: [edge("e1", "start", "a"), edge("e2", "a", "a")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "CYCLE_DETECTED")).toBe(true)
  })

  test("passes on valid linear flow", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: { "start": triggerNode(), "a": node("a"), "b": node("b") },
      edges: [edge("e1", "start", "a"), edge("e2", "a", "b")],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })
})

// ─── STEP 5: BUILD STAGES ────────────────────

describe("Step 5 — buildStages", () => {
  test("linear flow → sequential stages", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: { "start": triggerNode(), "process": node("process"), "deliver": node("deliver", "io.slack") },
      edges: [edge("e1", "start", "process"), edge("e2", "process", "deliver")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.stages).toHaveLength(3)
      expect(result.plan.stages[0].nodes).toEqual(["start"])
      expect(result.plan.stages[1].nodes).toEqual(["process"])
      expect(result.plan.stages[2].nodes).toEqual(["deliver"])
    }
  })

  test("parallel branches grouped in same stage", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(), "score": { ...node("score", "ai"), config: { mode: { type: "literal", value: "complete" } } } as NodeDefinition,
        "enrich": node("enrich"), "notify": node("notify", "io.slack"),
      },
      edges: [
        edge("e1", "start", "score"), edge("e2", "start", "enrich"), edge("e3", "enrich", "notify"),
      ],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.stages[0].nodes).toEqual(["start"])
      expect(result.plan.stages[1].nodes).toHaveLength(2)
      expect(result.plan.stages[1].nodes).toContain("score")
      expect(result.plan.stages[1].nodes).toContain("enrich")
      expect(result.plan.stages[2].nodes).toEqual(["notify"])
    }
  })

  test("diamond shape — converging branches", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: { "start": triggerNode(), "a": node("a"), "b": node("b"), "end": node("end", "io.slack") },
      edges: [edge("e1", "start", "a"), edge("e2", "start", "b"), edge("e3", "a", "end"), edge("e4", "b", "end")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.stages[0].nodes).toEqual(["start"])
      expect(result.plan.stages[1].nodes).toContain("a")
      expect(result.plan.stages[1].nodes).toContain("b")
      expect(result.plan.stages[2].nodes).toEqual(["end"])
    }
  })
})

// ─── STEP 6: ROUTING INDEX ───────────────────

describe("Step 6 — buildRoutingIndex", () => {
  test("routing index has correct stage references", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: { "start": triggerNode(), "process": node("process"), "deliver": node("deliver", "io.slack") },
      edges: [edge("e1", "start", "process"), edge("e2", "process", "deliver")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const { routing } = result.plan

      // start → process
      expect(routing["start"]).toHaveLength(1)
      expect(routing["start"][0].sourceStage).toBe(0)
      expect(routing["start"][0].targetStage).toBe(1)
      expect(routing["start"][0].edge.id).toBe("e1")

      // process → deliver
      expect(routing["process"]).toHaveLength(1)
      expect(routing["process"][0].sourceStage).toBe(1)
      expect(routing["process"][0].targetStage).toBe(2)

      // deliver has no outgoing edges
      expect(routing["deliver"]).toBeUndefined()
    }
  })

  test("fan-out node has multiple routing entries", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: { "start": triggerNode(), "a": node("a"), "b": node("b") },
      edges: [edge("e1", "start", "a"), edge("e2", "start", "b")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.routing["start"]).toHaveLength(2)
    }
  })

  test("routing preserves edge metadata including label", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: { "start": triggerNode(), "process": node("process") },
      edges: [edge("e1", "start", "process", { label: "qualified path" })],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.routing["start"][0].edge.label).toBe("qualified path")
    }
  })
})

// ─── STEP 7: DETECT TRIGGERS ─────────────────

describe("Step 7 — detectTriggers", () => {
  test("correctly identifies trigger node IDs", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: { "webhook": triggerNode("webhook"), "process": node("process") },
      edges: [edge("e1", "webhook", "process")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.triggerIds).toContain("webhook")
      expect(result.plan.triggerIds).not.toContain("process")
    }
  })

  test("fails if entry node is not a trigger type", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: { "notATrigger": node("notATrigger"), "process": node("process") },
      edges: [edge("e1", "notATrigger", "process")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_ENTRY_NODE")).toBe(true)
  })

  test("supports multiple trigger entry points", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "webhook": triggerNode("webhook"),
        "cron":    { ...triggerNode("cron"), type: "trigger.cron" },
        "process": node("process"),
      },
      edges: [edge("e1", "webhook", "process"), edge("e2", "cron", "process")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.triggerIds).toContain("webhook")
      expect(result.plan.triggerIds).toContain("cron")
    }
  })
})

// ─── STEP 8: VALIDATE EXPRESSIONS (refs) ─────

describe("Step 8 — validateExpressions", () => {
  test("passes when ref points to trigger", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "process": { ...node("process"), config: { input: { type: "ref", path: "$.trigger.body" } } },
      },
      edges: [edge("e1", "start", "process")],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })

  test("fails when ref points to downstream node", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "a": { ...node("a"), config: { input: { type: "ref", path: "$.b.data" } } },
        "b": node("b"),
      },
      edges: [edge("e1", "start", "a"), edge("e2", "a", "b")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_REF")).toBe(true)
  })

  test("validates nested refs inside array expressions", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "notify": {
          ...node("notify", "io.slack"),
          config: {
            items: {
              type: "array",
              items: [
                { type: "ref", path: "$.ghost.name" },   // invalid
                { type: "literal", value: "ok" },
              ],
            },
          },
        },
      },
      edges: [edge("e1", "start", "notify")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_REF")).toBe(true)
  })

  test("validates nested refs inside object expressions", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "notify": {
          ...node("notify", "io.slack"),
          config: {
            body: {
              type: "object",
              properties: {
                name:  { type: "ref", path: "$.ghost.name" },  // invalid
                score: { type: "literal", value: 0 },
              },
            },
          },
        },
      },
      edges: [edge("e1", "start", "notify")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_REF")).toBe(true)
  })
})

// ─── STEP 9: VALIDATE EXPRESSION FORMS ───────

describe("Step 9 — validateExpressionForms", () => {
  test("fails when ref path does not start with $.", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "process": { ...node("process"), config: { input: { type: "ref", path: "trigger.body" } } },
      },
      edges: [edge("e1", "start", "process")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_EXPRESSION")).toBe(true)
  })

  test("fails when template has no parts", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "process": { ...node("process"), config: { msg: { type: "template", parts: [] } } },
      },
      edges: [edge("e1", "start", "process")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_EXPRESSION")).toBe(true)
  })

  test("fails when fn references unknown function", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "process": {
          ...node("process"),
          config: {
            result: { type: "fn", name: "unknownFn", args: [{ type: "literal", value: 1 }] },
          },
        },
      },
      edges: [edge("e1", "start", "process")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_EXPRESSION")).toBe(true)
  })

  test("fails when cond is missing then/else", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "process": {
          ...node("process"),
          config: {
            // @ts-expect-error — intentionally malformed for test
            val: { type: "cond", if: { type: "literal", value: true } },
          },
        },
      },
      edges: [edge("e1", "start", "process")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_EXPRESSION")).toBe(true)
  })

  test("passes valid fn expression", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "process": {
          ...node("process"),
          config: {
            result: {
              type: "fn", name: "gt",
              args: [
                { type: "ref",     path: "$.trigger.score" },
                { type: "literal", value: 0.7 },
              ],
            },
          },
        },
      },
      edges: [edge("e1", "start", "process")],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })
})

// ─── STEP 10: VALIDATE SCHEMAS ───────────────

describe("Step 10 — validateSchemas", () => {
  test("passes when output schema matches input schema", () => {
    // data.transform output: object → data.transform input: object ✓
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start":   triggerNode(),
        "transform": node("transform", "data.transform"),
        "slack":   node("slack",     "data.transform"),
      },
      edges: [edge("e1", "start", "transform"), edge("e2", "transform", "slack")],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })

  test("flags SCHEMA_MISMATCH when types are incompatible", () => {
    // ai.complete outputs an object — override with string to force mismatch
    // data.transform input is object → string ≠ object → SCHEMA_MISMATCH
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "score": {
          ...{ ...node("score", "ai"), config: { mode: { type: "literal", value: "complete" } } } as NodeDefinition,
          outputSchema: { type: "string" },   // override: produces a string
        },
        "transform": node("transform", "data.transform"),  // expects object
      },
      edges: [edge("e1", "start", "score"), edge("e2", "score", "transform")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "SCHEMA_MISMATCH")).toBe(true)
  })

  test("skips schema check when either side has no schema", () => {
    // http.request has output schema but no input schema declared
    // This edge should pass without SCHEMA_MISMATCH
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start":   triggerNode(),
        "request": node("request", "http.request"),
        "request2": node("request2", "http.request"),
      },
      edges: [edge("e1", "start", "request"), edge("e2", "request", "request2")],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })
})

// ─── STEP 11: PRE-EVALUATE STATICS ───────────

describe("Step 11 — preEvaluateStatics", () => {
  test("pre-evaluates literal expressions", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "request": {
          ...node("request"),
          config: {
            url:    { type: "literal", value: "https://api.example.com" },
            method: { type: "literal", value: "POST" },
          },
        },
      },
      edges: [edge("e1", "start", "request")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.statics["request.url"]).toBe("https://api.example.com")
      expect(result.plan.statics["request.method"]).toBe("POST")
    }
  })

  test("does not pre-evaluate dynamic expressions", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "request": {
          ...node("request"),
          config: {
            url:  { type: "ref",     path: "$.trigger.url" },
            name: { type: "literal", value: "static" },
          },
        },
      },
      edges: [edge("e1", "start", "request")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.statics["request.url"]).toBeUndefined()
      expect(result.plan.statics["request.name"]).toBe("static")
    }
  })
})

// ─── STEP 9b: VALIDATE NODE MODES ────────────

describe("Step 9b — validateNodeModes", () => {

  // ── store ──────────────────────────────────

  test("store node missing mode fails", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "kv": { id: "kv", type: "store", config: {
          key: { type: "literal", value: "my-key" },
          // missing: mode
        }},
      },
      edges: [edge("e1", "start", "kv")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_NODE_MODE")).toBe(true)
  })

  test("store node with invalid mode fails", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "kv": { id: "kv", type: "store", config: {
          mode: { type: "literal", value: "upsert" },  // not a valid mode
          key:  { type: "literal", value: "my-key" },
        }},
      },
      edges: [edge("e1", "start", "kv")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_NODE_MODE")).toBe(true)
  })

  test("store node with dynamic mode fails", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "kv": { id: "kv", type: "store", config: {
          mode: { type: "ref", path: "$.trigger.mode" },  // dynamic — not allowed
          key:  { type: "literal", value: "my-key" },
        }},
      },
      edges: [edge("e1", "start", "kv")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_NODE_MODE")).toBe(true)
  })

  test("store get passes", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "kv": { id: "kv", type: "store", config: {
          mode:    { type: "literal", value: "get" },
          key:     { type: "literal", value: "last-run" },
          default: { type: "literal", value: null },
        }},
      },
      edges: [edge("e1", "start", "kv")],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })

  test("store set passes", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "kv": { id: "kv", type: "store", config: {
          mode:  { type: "literal", value: "set" },
          key:   { type: "literal", value: "last-run" },
          value: { type: "ref",     path: "$.trigger.body" },
          ttl:   { type: "literal", value: 86400000 },
        }},
      },
      edges: [edge("e1", "start", "kv")],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })

  test("store delete passes", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "kv": { id: "kv", type: "store", config: {
          mode: { type: "literal", value: "delete" },
          key:  { type: "ref",     path: "$.trigger.body.key" },
        }},
      },
      edges: [edge("e1", "start", "kv")],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })

  // ── ai ─────────────────────────────────────

  test("ai node missing mode fails", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "model": { id: "model", type: "ai", config: {
          prompt: { type: "literal", value: "Say hello" },
          // missing: mode
        }},
      },
      edges: [edge("e1", "start", "model")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_NODE_MODE")).toBe(true)
  })

  test("ai node with invalid mode fails", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "model": { id: "model", type: "ai", config: {
          mode:   { type: "literal", value: "generate" },  // not valid
          prompt: { type: "literal", value: "Say hello" },
        }},
      },
      edges: [edge("e1", "start", "model")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_NODE_MODE")).toBe(true)
  })

  test("ai complete passes", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "model": { id: "model", type: "ai", config: {
          mode:        { type: "literal", value: "complete" },
          prompt:      { type: "ref",     path: "$.trigger.body.prompt" },
          temperature: { type: "literal", value: 0.7 },
          maxTokens:   { type: "literal", value: 1000 },
        }},
      },
      edges: [edge("e1", "start", "model")],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })

  test("ai embed passes", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "model": { id: "model", type: "ai", config: {
          mode:  { type: "literal", value: "embed" },
          input: { type: "ref",     path: "$.trigger.body.text" },
        }},
      },
      edges: [edge("e1", "start", "model")],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })

  test("ai classify passes", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "model": { id: "model", type: "ai", config: {
          mode:       { type: "literal", value: "classify" },
          prompt:     { type: "ref",     path: "$.trigger.body.text" },
          categories: { type: "literal", value: ["positive", "neutral", "negative"] },
        }},
      },
      edges: [edge("e1", "start", "model")],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })

  test("ai extract passes", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "model": { id: "model", type: "ai", config: {
          mode:   { type: "literal", value: "extract" },
          prompt: { type: "ref",     path: "$.trigger.body.text" },
        }},
      },
      edges: [edge("e1", "start", "model")],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })
})

// ─── TYPES: FLOW TAGS + NODE META ────────────

describe("Types — Flow tags and Node meta", () => {
  test("flow accepts tags", () => {
    const flow: Flow = {
      ...baseFlow(),
      tags: ["crm", "ai", "leads"],
      nodes: { "start": triggerNode(), "process": node("process") },
      edges: [edge("e1", "start", "process")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(true)
  })

  test("node accepts meta block", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "process": {
          ...node("process"),
          meta: {
            name:        "Process Lead",
            description: "Transforms raw lead data",
            category:    "data",
            tags:        ["lead", "transform"],
            docsUrl:     "https://docs.orion.dev/nodes/data-transform",
          },
        },
      },
      edges: [edge("e1", "start", "process")],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })
})

// ─── METADATA ────────────────────────────────

describe("Plan metadata", () => {
  test("correctly flags hasBranching", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: { "start": triggerNode(), "process": node("process") },
      edges: [edge("e1", "start", "process", {
        condition: { type: "fn", name: "gt", args: [
          { type: "ref", path: "$.trigger.score" },
          { type: "literal", value: 0.7 },
        ]},
      })],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.hasBranching).toBe(true)
      expect(result.plan.hasFanOut).toBe(false)
    }
  })

  test("correctly flags hasFanOut", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: { "start": triggerNode(), "process": node("process") },
      edges: [edge("e1", "start", "process", {
        fanOut: { iterate: { type: "ref", path: "$.trigger.items" }, parallelism: 5 },
      })],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan.hasFanOut).toBe(true)
      expect(result.plan.hasBranching).toBe(false)
    }
  })
})


// ─── STEP 8b: VALIDATE ERROR EDGES ───────────

describe("Step 8b — validateErrorEdges", () => {
  test("error edge pointing to non-flow.error node fails", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start":   triggerNode(),
        "request": node("request", "http.request"),
        "process": node("process", "data.transform"),
      },
      edges: [
        edge("e1", "start",   "request"),
        edge("e2", "request", "process", { kind: "error" }),  // invalid — not a flow.error node
      ],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_ERROR_EDGE")).toBe(true)
  })

  test("flow.error node with no incoming error edge fails", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start":   triggerNode(),
        "request": node("request", "http.request"),
        "handler": node("handler", "flow.error"),
      },
      edges: [
        edge("e1", "start",   "request"),
        edge("e2", "request", "handler"),   // success edge, not error edge
      ],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "UNREACHABLE_ERROR_NODE")).toBe(true)
  })

  test("valid error edge to flow.error node passes", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start":   triggerNode(),
        "request": node("request", "http.request"),
        "handler": node("handler", "flow.error"),
        "notify":  node("notify",  "http.request"),
      },
      edges: [
        edge("e1", "start",   "request"),
        edge("e2", "request", "handler", { kind: "error" }),
        edge("e3", "handler", "notify"),
      ],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })

  test("success and error edges on same source node both work", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start":   triggerNode(),
        "request": node("request", "http.request"),
        "process": node("process", "data.transform"),
        "handler": node("handler", "flow.error"),
      },
      edges: [
        edge("e1", "start",   "request"),
        edge("e2", "request", "process", { kind: "success" }),
        edge("e3", "request", "handler", { kind: "error" }),
      ],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })
})

// ─── STEP 8c: VALIDATE LOOP NODES ────────────

describe("Step 8c — validateLoopNodes", () => {
  test("flow.loop missing 'over' config fails", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "loop":  {
          id: "loop", type: "flow.loop",
          config: {
            as:      { type: "literal", value: "item" },
            maxRuns: { type: "literal", value: 100 },
            // missing: over
          },
        },
        "process": node("process"),
      },
      edges: [edge("e1", "start", "loop"), edge("e2", "loop", "process")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_LOOP_CONFIG")).toBe(true)
  })

  test("flow.loop missing 'as' config fails", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "loop":  {
          id: "loop", type: "flow.loop",
          config: {
            over:    { type: "ref", path: "$.trigger.items" },
            maxRuns: { type: "literal", value: 100 },
            // missing: as
          },
        },
        "process": node("process"),
      },
      edges: [edge("e1", "start", "loop"), edge("e2", "loop", "process")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_LOOP_CONFIG")).toBe(true)
  })

  test("flow.loop with non-literal maxRuns fails", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "loop": {
          id: "loop", type: "flow.loop",
          config: {
            over:    { type: "ref", path: "$.trigger.items" },
            as:      { type: "literal", value: "item" },
            maxRuns: { type: "ref", path: "$.trigger.limit" },  // dynamic — not allowed
          },
        },
        "process": node("process"),
      },
      edges: [edge("e1", "start", "loop"), edge("e2", "loop", "process")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_LOOP_CONFIG")).toBe(true)
  })

  test("flow.loop with negative maxRuns fails", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "loop": {
          id: "loop", type: "flow.loop",
          config: {
            over:    { type: "ref",     path: "$.trigger.items" },
            as:      { type: "literal", value: "item" },
            maxRuns: { type: "literal", value: -5 },
          },
        },
        "process": node("process"),
      },
      edges: [edge("e1", "start", "loop"), edge("e2", "loop", "process")],
    }
    const result = compiler.compile(flow)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.code === "INVALID_LOOP_CONFIG")).toBe(true)
  })

  test("valid flow.loop passes", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "loop": {
          id: "loop", type: "flow.loop",
          config: {
            over:      { type: "ref",     path: "$.trigger.items" },
            as:        { type: "literal", value: "item" },
            maxRuns:   { type: "literal", value: 50 },
            breakWhen: {
              type: "fn", name: "gt",
              args: [
                { type: "ref",     path: "$.loop.index" },
                { type: "literal", value: 10 },
              ],
            },
          },
        },
        "process": node("process"),
      },
      edges: [edge("e1", "start", "loop"), edge("e2", "loop", "process")],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })

  test("flow.loop without maxRuns uses default — passes", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start": triggerNode(),
        "loop": {
          id: "loop", type: "flow.loop",
          config: {
            over: { type: "ref",     path: "$.trigger.items" },
            as:   { type: "literal", value: "item" },
            // no maxRuns — runtime will apply default of 100
          },
        },
        "process": node("process"),
      },
      edges: [edge("e1", "start", "loop"), edge("e2", "loop", "process")],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })
})

// ─── TYPES: EDGE KIND ─────────────────────────

describe("Types — edge kind", () => {
  test("edge accepts kind field", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start":   triggerNode(),
        "request": node("request", "http.request"),
        "handler": node("handler", "flow.error"),
        "next":    node("next",    "http.request"),
      },
      edges: [
        edge("e1", "start",   "request"),
        edge("e2", "request", "next",    { kind: "success" }),
        edge("e3", "request", "handler", { kind: "error" }),
      ],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })

  test("always edge kind is valid", () => {
    const flow: Flow = {
      ...baseFlow(),
      nodes: {
        "start":   triggerNode(),
        "request": node("request", "http.request"),
        "log":     node("log",     "http.request"),
      },
      edges: [
        edge("e1", "start",   "request"),
        edge("e2", "request", "log", { kind: "always" }),
      ],
    }
    expect(compiler.compile(flow).ok).toBe(true)
  })
})

// ─── INTEGRATION — LEAD QUALIFIER ────────────

describe("Integration — Lead Qualifier", () => {
  test("compiles correctly end to end", () => {
    const flow: Flow = {
      ...baseFlow(),
      id:   "flow_lead_qualifier",
      name: "Lead Qualifier",
      tags: ["crm", "ai"],
      nodes: {
        "webhook": {
          ...triggerNode("webhook"),
          meta: { name: "Inbound Webhook" },
        },
        "parseLead": {
          id: "parseLead", type: "data.transform",
          config: { input: { type: "ref", path: "$.trigger.body" } },
          meta: { name: "Parse Lead", category: "data" },
        },
        "scoreLead": {
          id: "scoreLead", type: "ai",
          config: {
            mode: { type: "literal", value: "complete" },
            prompt: {
              type: "template",
              parts: [
                { type: "literal", value: "Score this lead: " },
                { type: "ref",     path: "$.parseLead.data" },
              ],
            },
          },
          timeout: 10000,
          retry: { maxAttempts: 2, backoff: "exponential", delayMs: 500 },
        },
        "enrichLead": {
          id: "enrichLead", type: "http.request",
          config: {
            url: {
              type: "template",
              parts: [
                { type: "literal", value: "https://api.clearbit.com/v2/people?email=" },
                { type: "ref",     path: "$.parseLead.data" },
              ],
            },
            method: { type: "literal", value: "GET" },
          },
        },
        "notifySlack": {
          id: "notifySlack", type: "io.slack",
          config: {
            channel: { type: "literal", value: "#sales" },
            message: {
              type: "object",
              properties: {
                text:  { type: "template", parts: [
                  { type: "literal", value: "Qualified lead: " },
                  { type: "ref",     path: "$.parseLead.name" },
                ]},
                score: { type: "ref", path: "$.scoreLead.score" },
              },
            },
          },
        },
      },
      edges: [
        edge("e1", "webhook",   "parseLead"),
        edge("e2", "parseLead", "scoreLead"),
        edge("e3", "parseLead", "enrichLead"),
        edge("e4", "scoreLead", "notifySlack", {
          label: "qualified",
          condition: {
            type: "fn", name: "gt",
            args: [
              { type: "ref",     path: "$.scoreLead.score" },
              { type: "literal", value: 0.7 },
            ],
          },
        }),
      ],
    }

    const result = compiler.compile(flow)
    expect(result.ok).toBe(true)

    if (result.ok) {
      const { plan } = result

      // Triggers
      expect(plan.triggerIds).toContain("webhook")

      // Stages
      expect(plan.stages[0].nodes).toEqual(["webhook"])
      expect(plan.stages[1].nodes).toEqual(["parseLead"])
      expect(plan.stages[2].nodes).toHaveLength(2)
      expect(plan.stages[2].nodes).toContain("scoreLead")
      expect(plan.stages[2].nodes).toContain("enrichLead")
      expect(plan.stages[3].nodes).toEqual(["notifySlack"])

      // Routing
      expect(plan.routing["parseLead"]).toHaveLength(2)
      expect(plan.routing["scoreLead"][0].edge.label).toBe("qualified")
      expect(plan.routing["scoreLead"][0].targetStage).toBe(3)

      // Statics
      expect(plan.statics["enrichLead.method"]).toBe("GET")
      expect(plan.statics["notifySlack.channel"]).toBe("#sales")

      // Metadata
      expect(plan.hasBranching).toBe(true)
      expect(plan.hasFanOut).toBe(false)
      expect(plan.nodeCount).toBe(5)
      expect(plan.stageCount).toBe(4)
    }
  })
})
