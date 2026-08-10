import { describe, test, expect } from "vitest"
import { ExpressionResolver, ResolutionError, type ResolutionContext } from "./index"
import type { Expression } from "../types"

// ─────────────────────────────────────────────
// TEST CONTEXT
// ─────────────────────────────────────────────

const ctx: ResolutionContext = {
  trigger: {
    body: {
      name:  "John Smith",
      email: "john@acme.com",
      score: 0.82,
      tags:  ["enterprise", "inbound"],
    },
    headers: { "content-type": "application/json" },
  },
  nodes: {
    parseLead: {
      data: {
        name:    "John Smith",
        email:   "john@acme.com",
        company: "Acme Corp",
      },
      score: 0.82,
    },
    scoreLead: {
      qualified: true,
      score:     0.82,
      reason:    "High intent signals",
      tiers:     ["gold", "enterprise"],
      meta:      { model: "gpt-4", tokens: 142 },
    },
    enrichLead: {
      company: { name: "Acme Corp", size: 500, industry: "SaaS" },
    },
  },
}

let r: ExpressionResolver

const setup = () => { r = new ExpressionResolver() }

// ─────────────────────────────────────────────
// LITERAL
// ─────────────────────────────────────────────

describe("literal", () => {
  test("returns string value", () => {
    setup()
    expect(r.resolve({ type: "literal", value: "hello" }, ctx)).toBe("hello")
  })

  test("returns number value", () => {
    setup()
    expect(r.resolve({ type: "literal", value: 42 }, ctx)).toBe(42)
  })

  test("returns boolean value", () => {
    setup()
    expect(r.resolve({ type: "literal", value: false }, ctx)).toBe(false)
  })

  test("returns null", () => {
    setup()
    expect(r.resolve({ type: "literal", value: null }, ctx)).toBeNull()
  })

  test("returns object", () => {
    setup()
    const val = { a: 1, b: 2 }
    expect(r.resolve({ type: "literal", value: val }, ctx)).toEqual(val)
  })

  test("returns array", () => {
    setup()
    expect(r.resolve({ type: "literal", value: [1, 2, 3] }, ctx)).toEqual([1, 2, 3])
  })
})

// ─────────────────────────────────────────────
// REF
// ─────────────────────────────────────────────

describe("ref", () => {
  test("resolves trigger root", () => {
    setup()
    expect(r.resolve({ type: "ref", path: "$.trigger" }, ctx))
      .toEqual(ctx.trigger)
  })

  test("resolves nested trigger path", () => {
    setup()
    expect(r.resolve({ type: "ref", path: "$.trigger.body.email" }, ctx))
      .toBe("john@acme.com")
  })

  test("resolves node output", () => {
    setup()
    expect(r.resolve({ type: "ref", path: "$.parseLead.data.name" }, ctx))
      .toBe("John Smith")
  })

  test("resolves deeply nested path", () => {
    setup()
    expect(r.resolve({ type: "ref", path: "$.enrichLead.company.industry" }, ctx))
      .toBe("SaaS")
  })

  test("resolves array by index", () => {
    setup()
    expect(r.resolve({ type: "ref", path: "$.trigger.body.tags.0" }, ctx))
      .toBe("enterprise")
  })

  test("resolves second array index", () => {
    setup()
    expect(r.resolve({ type: "ref", path: "$.scoreLead.tiers.1" }, ctx))
      .toBe("enterprise")
  })

  test("returns undefined for missing key", () => {
    setup()
    expect(r.resolve({ type: "ref", path: "$.parseLead.data.missing" }, ctx))
      .toBeUndefined()
  })

  test("throws for unknown root", () => {
    setup()
    expect(() => r.resolve({ type: "ref", path: "$.ghost.field" }, ctx))
      .toThrow(ResolutionError)
  })

  test("throws when traversing null", () => {
    setup()
    const nullCtx: ResolutionContext = {
      ...ctx,
      nodes: { ...ctx.nodes, nullNode: null },
    }
    expect(() => r.resolve({ type: "ref", path: "$.nullNode.field" }, nullCtx))
      .toThrow(ResolutionError)
  })
})

// ─────────────────────────────────────────────
// TEMPLATE
// ─────────────────────────────────────────────

describe("template", () => {
  test("interpolates string parts", () => {
    setup()
    const expr: Expression = {
      type:  "template",
      parts: [
        { type: "literal", value: "Hello, " },
        { type: "ref",     path: "$.parseLead.data.name" },
        { type: "literal", value: "!" },
      ],
    }
    expect(r.resolve(expr, ctx)).toBe("Hello, John Smith!")
  })

  test("coerces numbers to string in template", () => {
    setup()
    const expr: Expression = {
      type:  "template",
      parts: [
        { type: "literal", value: "Score: " },
        { type: "ref",     path: "$.scoreLead.score" },
      ],
    }
    expect(r.resolve(expr, ctx)).toBe("Score: 0.82")
  })

  test("coerces booleans to string", () => {
    setup()
    const expr: Expression = {
      type:  "template",
      parts: [
        { type: "literal", value: "Qualified: " },
        { type: "ref",     path: "$.scoreLead.qualified" },
      ],
    }
    expect(r.resolve(expr, ctx)).toBe("Qualified: true")
  })

  test("renders null as empty string", () => {
    setup()
    const expr: Expression = {
      type:  "template",
      parts: [
        { type: "literal", value: null },
        { type: "literal", value: "end" },
      ],
    }
    expect(r.resolve(expr, ctx)).toBe("end")
  })

  test("JSON-stringifies objects in template", () => {
    setup()
    const expr: Expression = {
      type:  "template",
      parts: [
        { type: "literal", value: "meta: " },
        { type: "ref",     path: "$.scoreLead.meta" },
      ],
    }
    expect(r.resolve(expr, ctx)).toBe('meta: {"model":"gpt-4","tokens":142}')
  })
})

// ─────────────────────────────────────────────
// ARRAY
// ─────────────────────────────────────────────

describe("array", () => {
  test("builds array from mixed expressions", () => {
    setup()
    const expr: Expression = {
      type:  "array",
      items: [
        { type: "literal", value: "static" },
        { type: "ref",     path: "$.parseLead.data.name" },
        { type: "ref",     path: "$.scoreLead.score" },
      ],
    }
    expect(r.resolve(expr, ctx)).toEqual(["static", "John Smith", 0.82])
  })

  test("builds empty array", () => {
    setup()
    expect(r.resolve({ type: "array", items: [] }, ctx)).toEqual([])
  })

  test("supports nested array expressions", () => {
    setup()
    const expr: Expression = {
      type:  "array",
      items: [
        { type: "array", items: [
          { type: "literal", value: 1 },
          { type: "literal", value: 2 },
        ]},
        { type: "literal", value: 3 },
      ],
    }
    expect(r.resolve(expr, ctx)).toEqual([[1, 2], 3])
  })
})

// ─────────────────────────────────────────────
// OBJECT
// ─────────────────────────────────────────────

describe("object", () => {
  test("builds object from mixed expressions", () => {
    setup()
    const expr: Expression = {
      type: "object",
      properties: {
        name:    { type: "ref",     path: "$.parseLead.data.name" },
        score:   { type: "ref",     path: "$.scoreLead.score" },
        source:  { type: "literal", value: "orion" },
      },
    }
    expect(r.resolve(expr, ctx)).toEqual({
      name:   "John Smith",
      score:  0.82,
      source: "orion",
    })
  })

  test("builds empty object", () => {
    setup()
    expect(r.resolve({ type: "object", properties: {} }, ctx)).toEqual({})
  })

  test("supports nested object expressions", () => {
    setup()
    const expr: Expression = {
      type: "object",
      properties: {
        lead: {
          type: "object",
          properties: {
            name:  { type: "ref", path: "$.parseLead.data.name" },
            email: { type: "ref", path: "$.parseLead.data.email" },
          },
        },
        meta: { type: "literal", value: { version: 1 } },
      },
    }
    expect(r.resolve(expr, ctx)).toEqual({
      lead: { name: "John Smith", email: "john@acme.com" },
      meta: { version: 1 },
    })
  })
})

// ─────────────────────────────────────────────
// FN — COMPARISON
// ─────────────────────────────────────────────

describe("fn — comparison", () => {
  test("gt: true when a > b", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "gt", args: [
      { type: "ref",     path: "$.scoreLead.score" },
      { type: "literal", value: 0.7 },
    ]}, ctx)).toBe(true)
  })

  test("gt: false when a <= b", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "gt", args: [
      { type: "literal", value: 0.5 },
      { type: "literal", value: 0.7 },
    ]}, ctx)).toBe(false)
  })

  test("lt", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "lt", args: [
      { type: "literal", value: 0.5 },
      { type: "literal", value: 0.7 },
    ]}, ctx)).toBe(true)
  })

  test("gte: equal case", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "gte", args: [
      { type: "literal", value: 0.7 },
      { type: "literal", value: 0.7 },
    ]}, ctx)).toBe(true)
  })

  test("eq: primitives", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "eq", args: [
      { type: "literal", value: "hello" },
      { type: "literal", value: "hello" },
    ]}, ctx)).toBe(true)
  })

  test("neq", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "neq", args: [
      { type: "literal", value: "a" },
      { type: "literal", value: "b" },
    ]}, ctx)).toBe(true)
  })
})

// ─────────────────────────────────────────────
// FN — LOGIC
// ─────────────────────────────────────────────

describe("fn — logic", () => {
  test("and: all true", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "and", args: [
      { type: "literal", value: true },
      { type: "literal", value: true },
    ]}, ctx)).toBe(true)
  })

  test("and: one false", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "and", args: [
      { type: "literal", value: true },
      { type: "literal", value: false },
    ]}, ctx)).toBe(false)
  })

  test("or: one true", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "or", args: [
      { type: "literal", value: false },
      { type: "literal", value: true },
    ]}, ctx)).toBe(true)
  })

  test("not: flips boolean", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "not", args: [
      { type: "literal", value: true },
    ]}, ctx)).toBe(false)
  })
})

// ─────────────────────────────────────────────
// FN — MATH
// ─────────────────────────────────────────────

describe("fn — math", () => {
  test("add", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "add", args: [
      { type: "literal", value: 2 },
      { type: "literal", value: 3 },
    ]}, ctx)).toBe(5)
  })

  test("sub", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "sub", args: [
      { type: "literal", value: 10 },
      { type: "literal", value: 4 },
    ]}, ctx)).toBe(6)
  })

  test("mul", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "mul", args: [
      { type: "literal", value: 3 },
      { type: "literal", value: 4 },
    ]}, ctx)).toBe(12)
  })

  test("round", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "round", args: [
      { type: "literal", value: 3.7 },
    ]}, ctx)).toBe(4)
  })

  test("min / max", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "min", args: [
      { type: "literal", value: 5 },
      { type: "literal", value: 2 },
      { type: "literal", value: 8 },
    ]}, ctx)).toBe(2)

    expect(r.resolve({ type: "fn", name: "max", args: [
      { type: "literal", value: 5 },
      { type: "literal", value: 2 },
      { type: "literal", value: 8 },
    ]}, ctx)).toBe(8)
  })
})

// ─────────────────────────────────────────────
// FN — STRING
// ─────────────────────────────────────────────

describe("fn — string", () => {
  test("upper / lower", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "upper", args: [
      { type: "literal", value: "hello" },
    ]}, ctx)).toBe("HELLO")

    expect(r.resolve({ type: "fn", name: "lower", args: [
      { type: "literal", value: "WORLD" },
    ]}, ctx)).toBe("world")
  })

  test("trim", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "trim", args: [
      { type: "literal", value: "  hello  " },
    ]}, ctx)).toBe("hello")
  })

  test("includes", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "includes", args: [
      { type: "literal", value: "john@acme.com" },
      { type: "literal", value: "acme" },
    ]}, ctx)).toBe(true)
  })

  test("split", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "split", args: [
      { type: "literal", value: "a,b,c" },
      { type: "literal", value: "," },
    ]}, ctx)).toEqual(["a", "b", "c"])
  })

  test("replace", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "replace", args: [
      { type: "literal", value: "hello world" },
      { type: "literal", value: "world" },
      { type: "literal", value: "orion" },
    ]}, ctx)).toBe("hello orion")
  })
})

// ─────────────────────────────────────────────
// FN — ARRAY
// ─────────────────────────────────────────────

describe("fn — array", () => {
  test("first / last", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "first", args: [
      { type: "ref", path: "$.trigger.body.tags" },
    ]}, ctx)).toBe("enterprise")

    expect(r.resolve({ type: "fn", name: "last", args: [
      { type: "ref", path: "$.trigger.body.tags" },
    ]}, ctx)).toBe("inbound")
  })

  test("count", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "count", args: [
      { type: "ref", path: "$.trigger.body.tags" },
    ]}, ctx)).toBe(2)
  })

  test("join", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "join", args: [
      { type: "ref",     path: "$.trigger.body.tags" },
      { type: "literal", value: ", " },
    ]}, ctx)).toBe("enterprise, inbound")
  })

  test("uniq deduplicates", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "uniq", args: [
      { type: "literal", value: [1, 2, 2, 3, 3, 3] },
    ]}, ctx)).toEqual([1, 2, 3])
  })

  test("compact removes falsy", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "compact", args: [
      { type: "literal", value: [0, 1, null, 2, undefined, false, 3] },
    ]}, ctx)).toEqual([1, 2, 3])
  })
})

// ─────────────────────────────────────────────
// FN — OBJECT
// ─────────────────────────────────────────────

describe("fn — object", () => {
  test("pick selects keys", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "pick", args: [
      { type: "ref",     path: "$.parseLead.data" },
      { type: "literal", value: "name" },
      { type: "literal", value: "email" },
    ]}, ctx)).toEqual({ name: "John Smith", email: "john@acme.com" })
  })

  test("omit removes keys", () => {
    setup()
    const result = r.resolve({ type: "fn", name: "omit", args: [
      { type: "ref",     path: "$.parseLead.data" },
      { type: "literal", value: "email" },
    ]}, ctx) as Record<string, unknown>

    expect(result.name).toBe("John Smith")
    expect(result.email).toBeUndefined()
  })

  test("keys returns key array", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "keys", args: [
      { type: "ref", path: "$.parseLead.data" },
    ]}, ctx)).toEqual(["name", "email", "company"])
  })

  test("merge combines objects", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "merge", args: [
      { type: "literal", value: { a: 1 } },
      { type: "literal", value: { b: 2 } },
      { type: "literal", value: { c: 3 } },
    ]}, ctx)).toEqual({ a: 1, b: 2, c: 3 })
  })
})

// ─────────────────────────────────────────────
// FN — TYPE / COERCE
// ─────────────────────────────────────────────

describe("fn — type and coerce", () => {
  test("isNull", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "isNull", args: [{ type: "literal", value: null }] }, ctx)).toBe(true)
    expect(r.resolve({ type: "fn", name: "isNull", args: [{ type: "literal", value: 0 }] }, ctx)).toBe(false)
  })

  test("isArray", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "isArray", args: [
      { type: "ref", path: "$.trigger.body.tags" },
    ]}, ctx)).toBe(true)
  })

  test("toString", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "toString", args: [
      { type: "literal", value: 42 },
    ]}, ctx)).toBe("42")
  })

  test("toNumber", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "toNumber", args: [
      { type: "literal", value: "3.14" },
    ]}, ctx)).toBe(3.14)
  })

  test("toJson / fromJson roundtrip", () => {
    setup()
    const obj = { a: 1, b: "hello" }
    const json = r.resolve({ type: "fn", name: "toJson", args: [
      { type: "literal", value: obj },
    ]}, ctx)
    expect(json).toBe('{"a":1,"b":"hello"}')

    const parsed = r.resolve({ type: "fn", name: "fromJson", args: [
      { type: "literal", value: json },
    ]}, ctx)
    expect(parsed).toEqual(obj)
  })

  test("coalesce returns first non-null", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "coalesce", args: [
      { type: "literal", value: null },
      { type: "literal", value: undefined },
      { type: "literal", value: "found" },
    ]}, ctx)).toBe("found")
  })

  test("ifNull returns fallback when null", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "ifNull", args: [
      { type: "literal", value: null },
      { type: "literal", value: "default" },
    ]}, ctx)).toBe("default")
  })
})

// ─────────────────────────────────────────────
// FN — UNKNOWN
// ─────────────────────────────────────────────

describe("fn — unknown function", () => {
  test("throws ResolutionError for unknown fn", () => {
    setup()
    expect(() => r.resolve({ type: "fn", name: "doesNotExist", args: [] }, ctx))
      .toThrow(ResolutionError)
  })
})

// ─────────────────────────────────────────────
// COND
// ─────────────────────────────────────────────

describe("cond", () => {
  test("returns then branch when condition is true", () => {
    setup()
    expect(r.resolve({
      type: "cond",
      if:   { type: "ref",     path: "$.scoreLead.qualified" },
      then: { type: "literal", value: "qualified" },
      else: { type: "literal", value: "rejected" },
    }, ctx)).toBe("qualified")
  })

  test("returns else branch when condition is false", () => {
    setup()
    expect(r.resolve({
      type: "cond",
      if:   { type: "fn", name: "gt", args: [
        { type: "literal", value: 0.3 },
        { type: "literal", value: 0.7 },
      ]},
      then: { type: "literal", value: "high" },
      else: { type: "literal", value: "low" },
    }, ctx)).toBe("low")
  })

  test("evaluates nested cond expressions", () => {
    setup()
    // score > 0.9 → "excellent" | score > 0.7 → "good" | else → "poor"
    const expr: Expression = {
      type: "cond",
      if:   { type: "fn", name: "gt", args: [
        { type: "ref",     path: "$.scoreLead.score" },
        { type: "literal", value: 0.9 },
      ]},
      then: { type: "literal", value: "excellent" },
      else: {
        type: "cond",
        if:   { type: "fn", name: "gt", args: [
          { type: "ref",     path: "$.scoreLead.score" },
          { type: "literal", value: 0.7 },
        ]},
        then: { type: "literal", value: "good" },
        else: { type: "literal", value: "poor" },
      },
    }
    // score is 0.82 → > 0.7 but not > 0.9 → "good"
    expect(r.resolve(expr, ctx)).toBe("good")
  })
})

// ─────────────────────────────────────────────
// RESOLVE CONFIG
// ─────────────────────────────────────────────

describe("resolveConfig", () => {
  test("resolves all fields in a config record", () => {
    setup()
    const config = {
      channel: { type: "literal", value: "#sales" } as Expression,
      message: { type: "template", parts: [
        { type: "literal", value: "New lead: " },
        { type: "ref",     path: "$.parseLead.data.name" },
      ]} as Expression,
      score: { type: "ref", path: "$.scoreLead.score" } as Expression,
    }

    expect(r.resolveConfig(config, ctx)).toEqual({
      channel: "#sales",
      message: "New lead: John Smith",
      score:   0.82,
    })
  })

  test("resolves empty config", () => {
    setup()
    expect(r.resolveConfig({}, ctx)).toEqual({})
  })
})

// ─────────────────────────────────────────────
// CUSTOM FUNCTIONS
// ─────────────────────────────────────────────

describe("custom functions", () => {
  test("plugin-registered function is callable", () => {
    const custom = new ExpressionResolver({
      double: (n) => (n as number) * 2,
      greet:  (name) => `Hello, ${name}!`,
    })

    expect(custom.resolve({ type: "fn", name: "double", args: [
      { type: "literal", value: 21 },
    ]}, ctx)).toBe(42)

    expect(custom.resolve({ type: "fn", name: "greet", args: [
      { type: "literal", value: "Orion" },
    ]}, ctx)).toBe("Hello, Orion!")
  })

  test("custom function overrides builtin of same name", () => {
    const custom = new ExpressionResolver({
      upper: () => "overridden",
    })
    expect(custom.resolve({ type: "fn", name: "upper", args: [
      { type: "literal", value: "hello" },
    ]}, ctx)).toBe("overridden")
  })

  test("getFunctionNames includes builtins and custom fns", () => {
    const custom = new ExpressionResolver({ myFn: () => null })
    const names  = custom.getFunctionNames()
    expect(names.has("gt")).toBe(true)
    expect(names.has("pick")).toBe(true)
    expect(names.has("myFn")).toBe(true)
  })
})



// ─────────────────────────────────────────────
// PIPE
// ─────────────────────────────────────────────

describe("pipe", () => {
  test("chains steps left to right", () => {
    setup()
    const expr: Expression = {
      type:  "pipe",
      steps: [
        { type: "ref",  path: "$.trigger.body.email" },
        { type: "fn",   name: "lower" },
        { type: "fn",   name: "trim" },
      ],
    }
    expect(r.resolve(expr, ctx)).toBe("john@acme.com")
  })

  test("$ in a step refers to current flowing value", () => {
    setup()
    const expr: Expression = {
      type:  "pipe",
      steps: [
        { type: "ref", path: "$.trigger.body.email" },
        { type: "fn",  name: "split", args: [{ type: "literal", value: "@" }] },
        { type: "fn",  name: "last" },
      ],
    }
    // "john@acme.com" → ["john", "acme.com"] → "acme.com"
    expect(r.resolve(expr, ctx)).toBe("acme.com")
  })

  test("pipe with template step", () => {
    setup()
    const expr: Expression = {
      type:  "pipe",
      steps: [
        { type: "ref",      path: "$.parseLead.data.name" },
        { type: "fn",       name: "upper" },
        { type: "template", parts: [
          { type: "literal", value: "LEAD: " },
          { type: "ref",     path: "$.$" },
        ]},
      ],
    }
    expect(r.resolve(expr, ctx)).toBe("LEAD: JOHN SMITH")
  })

  test("pipe: products sum — the JSONata equivalent", () => {
    setup()
    const productCtx: ResolutionContext = {
      trigger: {},
      nodes: {
        fetchProducts: {
          data: {
            Account: {
              Order: {
                Products: [
                  { Price: 10.00, Quantity: 3 },
                  { Price: 25.50, Quantity: 2 },
                  { Price: 5.00,  Quantity: 10 },
                ],
              },
            },
          },
        },
      },
    }

    const expr: Expression = {
      type:  "pipe",
      steps: [
        { type: "ref", path: "$.fetchProducts.data.Account.Order.Products" },
        {
          type: "map",
          as:   "p",
          body: { type: "fn", name: "mul", args: [
            { type: "ref", path: "$.p.Price" },
            { type: "ref", path: "$.p.Quantity" },
          ]},
        },
        { type: "fn", name: "sum" },
      ],
    }
    // (10*3) + (25.5*2) + (5*10) = 30 + 51 + 50 = 131
    expect(r.resolve(expr, productCtx)).toBe(131)
  })

  test("single-step pipe returns value directly", () => {
    setup()
    expect(r.resolve({
      type: "pipe",
      steps: [{ type: "literal", value: 42 }],
    }, ctx)).toBe(42)
  })
})

// ─────────────────────────────────────────────
// MAP
// ─────────────────────────────────────────────

describe("map", () => {
  test("transforms each item in array", () => {
    setup()
    const expr: Expression = {
      type: "map",
      over: { type: "ref", path: "$.trigger.body.tags" },
      as:   "tag",
      body: { type: "fn", name: "upper", args: [
        { type: "ref", path: "$.tag" },
      ]},
    }
    expect(r.resolve(expr, ctx)).toEqual(["ENTERPRISE", "INBOUND"])
  })

  test("builds objects from array items", () => {
    setup()
    const leadCtx: ResolutionContext = {
      trigger: {},
      nodes: {
        fetchLeads: {
          leads: [
            { name: "John Smith",  email: "john@acme.com",  score: 0.9 },
            { name: "Jane Doe",    email: "jane@corp.com",  score: 0.6 },
          ],
        },
      },
    }
    const expr: Expression = {
      type: "map",
      over: { type: "ref", path: "$.fetchLeads.leads" },
      as:   "lead",
      body: {
        type: "object",
        properties: {
          name:      { type: "ref",     path: "$.lead.name" },
          qualified: { type: "fn",      name: "gte", args: [
            { type: "ref",     path: "$.lead.score" },
            { type: "literal", value: 0.7 },
          ]},
        },
      },
    }
    expect(r.resolve(expr, leadCtx)).toEqual([
      { name: "John Smith", qualified: true },
      { name: "Jane Doe",   qualified: false },
    ])
  })

  test("throws when over resolves to non-array", () => {
    setup()
    expect(() => r.resolve({
      type: "map",
      over: { type: "literal", value: "not an array" },
      as:   "item",
      body: { type: "ref", path: "$.item" },
    }, ctx)).toThrow(ResolutionError)
  })

  test("returns empty array for empty input", () => {
    setup()
    expect(r.resolve({
      type: "map",
      over: { type: "literal", value: [] },
      as:   "item",
      body: { type: "ref", path: "$.item" },
    }, ctx)).toEqual([])
  })
})

// ─────────────────────────────────────────────
// FILTER
// ─────────────────────────────────────────────

describe("filter", () => {
  test("filters array by condition", () => {
    setup()
    const filterCtx: ResolutionContext = {
      trigger: {},
      nodes: {
        fetchLeads: {
          leads: [
            { name: "John",  score: 0.9 },
            { name: "Jane",  score: 0.5 },
            { name: "Bob",   score: 0.8 },
            { name: "Alice", score: 0.3 },
          ],
        },
      },
    }
    const expr: Expression = {
      type:  "filter",
      over:  { type: "ref", path: "$.fetchLeads.leads" },
      as:    "lead",
      where: { type: "fn", name: "gte", args: [
        { type: "ref",     path: "$.lead.score" },
        { type: "literal", value: 0.7 },
      ]},
    }
    expect(r.resolve(expr, filterCtx)).toEqual([
      { name: "John", score: 0.9 },
      { name: "Bob",  score: 0.8 },
    ])
  })

  test("returns empty array when nothing matches", () => {
    setup()
    expect(r.resolve({
      type:  "filter",
      over:  { type: "literal", value: [1, 2, 3] },
      as:    "n",
      where: { type: "fn", name: "gt", args: [
        { type: "ref",     path: "$.n" },
        { type: "literal", value: 100 },
      ]},
    }, ctx)).toEqual([])
  })

  test("returns all items when all match", () => {
    setup()
    expect(r.resolve({
      type:  "filter",
      over:  { type: "literal", value: [5, 6, 7] },
      as:    "n",
      where: { type: "fn", name: "gt", args: [
        { type: "ref",     path: "$.n" },
        { type: "literal", value: 0 },
      ]},
    }, ctx)).toEqual([5, 6, 7])
  })

  test("throws when over resolves to non-array", () => {
    setup()
    expect(() => r.resolve({
      type:  "filter",
      over:  { type: "literal", value: 42 },
      as:    "item",
      where: { type: "literal", value: true },
    }, ctx)).toThrow(ResolutionError)
  })

  test("filter then map — pipeline without pipe", () => {
    setup()
    const filterCtx: ResolutionContext = {
      trigger: {},
      nodes: {
        leads: {
          items: [
            { name: "John", score: 0.9 },
            { name: "Jane", score: 0.4 },
            { name: "Bob",  score: 0.8 },
          ],
        },
      },
    }
    // filter qualified, then extract names
    const filtered: Expression = {
      type:  "filter",
      over:  { type: "ref", path: "$.leads.items" },
      as:    "lead",
      where: { type: "fn", name: "gte", args: [
        { type: "ref",     path: "$.lead.score" },
        { type: "literal", value: 0.7 },
      ]},
    }
    const mapped: Expression = {
      type: "map",
      over: filtered,
      as:   "lead",
      body: { type: "ref", path: "$.lead.name" },
    }
    expect(r.resolve(mapped, filterCtx)).toEqual(["John", "Bob"])
  })
})

// ─────────────────────────────────────────────
// REDUCE
// ─────────────────────────────────────────────

describe("reduce", () => {
  test("sums numbers with reduce", () => {
    setup()
    expect(r.resolve({
      type: "reduce",
      over: { type: "literal", value: [1, 2, 3, 4, 5] },
      as:   "n",
      acc:  "total",
      init: { type: "literal", value: 0 },
      body: { type: "fn", name: "add", args: [
        { type: "ref", path: "$.total" },
        { type: "ref", path: "$.n" },
      ]},
    }, ctx)).toBe(15)
  })

  test("builds string from array with reduce", () => {
    setup()
    expect(r.resolve({
      type: "reduce",
      over: { type: "literal", value: ["a", "b", "c"] },
      as:   "item",
      acc:  "result",
      init: { type: "literal", value: "" },
      body: { type: "fn", name: "concat", args: [
        { type: "ref", path: "$.result" },
        { type: "ref", path: "$.item" },
      ]},
    }, ctx)).toBe("abc")
  })

  test("returns init value for empty array", () => {
    setup()
    expect(r.resolve({
      type: "reduce",
      over: { type: "literal", value: [] },
      as:   "item",
      acc:  "total",
      init: { type: "literal", value: 99 },
      body: { type: "ref", path: "$.total" },
    }, ctx)).toBe(99)
  })

  test("throws when over is not an array", () => {
    setup()
    expect(() => r.resolve({
      type: "reduce",
      over: { type: "literal", value: "not array" },
      as:   "item",
      acc:  "acc",
      init: { type: "literal", value: 0 },
      body: { type: "ref", path: "$.acc" },
    }, ctx)).toThrow(ResolutionError)
  })
})

// ─────────────────────────────────────────────
// LET
// ─────────────────────────────────────────────

describe("let", () => {
  test("binds variables available in body", () => {
    setup()
    const expr: Expression = {
      type: "let",
      bindings: {
        domain: {
          type:  "pipe",
          steps: [
            { type: "ref", path: "$.trigger.body.email" },
            { type: "fn",  name: "split", args: [{ type: "literal", value: "@" }] },
            { type: "fn",  name: "last" },
          ],
        },
        upper: { type: "fn", name: "upper", args: [
          { type: "ref", path: "$.trigger.body.name" },
        ]},
      },
      body: {
        type: "object",
        properties: {
          domain: { type: "ref", path: "$.domain" },
          upper:  { type: "ref", path: "$.upper" },
        },
      },
    }
    expect(r.resolve(expr, ctx)).toEqual({
      domain: "acme.com",
      upper:  "JOHN SMITH",
    })
  })

  test("earlier bindings available to later bindings", () => {
    setup()
    const expr: Expression = {
      type: "let",
      bindings: {
        base:   { type: "literal", value: 10 },
        double: { type: "fn", name: "mul", args: [
          { type: "ref",     path: "$.base" },
          { type: "literal", value: 2 },
        ]},
        quad: { type: "fn", name: "mul", args: [
          { type: "ref",     path: "$.double" },
          { type: "literal", value: 2 },
        ]},
      },
      body: { type: "ref", path: "$.quad" },
    }
    // 10 → 20 → 40
    expect(r.resolve(expr, ctx)).toBe(40)
  })

  test("let bindings shadow outer context", () => {
    setup()
    // "parseLead" exists in ctx.nodes — let binding should shadow it
    const expr: Expression = {
      type: "let",
      bindings: {
        parseLead: { type: "literal", value: { data: { name: "Shadowed" } } },
      },
      body: { type: "ref", path: "$.parseLead.data.name" },
    }
    expect(r.resolve(expr, ctx)).toBe("Shadowed")
  })
})

// ─────────────────────────────────────────────
// FN — AGGREGATION
// ─────────────────────────────────────────────

describe("fn — aggregation", () => {
  test("sum", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "sum", args: [
      { type: "literal", value: [1, 2, 3, 4, 5] },
    ]}, ctx)).toBe(15)
  })

  test("sum of mapped values", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "sum", args: [
      { type: "literal", value: [10, 20, 30] },
    ]}, ctx)).toBe(60)
  })

  test("avg", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "avg", args: [
      { type: "literal", value: [10, 20, 30] },
    ]}, ctx)).toBe(20)
  })

  test("median — odd count", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "median", args: [
      { type: "literal", value: [3, 1, 4, 1, 5] },
    ]}, ctx)).toBe(3)
  })

  test("median — even count", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "median", args: [
      { type: "literal", value: [1, 2, 3, 4] },
    ]}, ctx)).toBe(2.5)
  })

  test("product", () => {
    setup()
    expect(r.resolve({ type: "fn", name: "product", args: [
      { type: "literal", value: [2, 3, 4] },
    ]}, ctx)).toBe(24)
  })
})

// ─────────────────────────────────────────────
// INTEGRATION — full node config
// ─────────────────────────────────────────────

describe("Integration — resolve full node config", () => {
  test("resolves the notifySlack node config from lead qualifier", () => {
    setup()

    const config = {
      channel: { type: "literal", value: "#sales" } as Expression,
      message: {
        type: "object",
        properties: {
          text: {
            type: "template",
            parts: [
              { type: "literal", value: "🎯 Qualified lead: " },
              { type: "ref",     path: "$.parseLead.data.name" },
              { type: "literal", value: " from " },
              { type: "ref",     path: "$.enrichLead.company.name" },
            ],
          },
          score:   { type: "ref", path: "$.scoreLead.score" },
          reason:  { type: "ref", path: "$.scoreLead.reason" },
          company: { type: "ref", path: "$.enrichLead.company" },
        },
      } as Expression,
      qualified: {
        type: "fn",
        name: "gt",
        args: [
          { type: "ref",     path: "$.scoreLead.score" },
          { type: "literal", value: 0.7 },
        ],
      } as Expression,
    }

    const resolved = r.resolveConfig(config, ctx)

    expect(resolved.channel).toBe("#sales")
    expect(resolved.qualified).toBe(true)
    expect((resolved.message as any).text).toBe("🎯 Qualified lead: John Smith from Acme Corp")
    expect((resolved.message as any).score).toBe(0.82)
    expect((resolved.message as any).company).toEqual({ name: "Acme Corp", size: 500, industry: "SaaS" })
  })
})
