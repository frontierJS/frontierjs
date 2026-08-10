import { describe, test, expect, beforeEach } from "vitest"
import { PluginRegistry, PluginRegistrationError } from "./index"
import type { PluginManifest }  from "./types"
import type { INodeImplementation } from "../executor"
import { BUILTIN_DESCRIPTORS }  from "./builtins"
import { Compiler } from "../compiler"

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function makeImpl(type: string): INodeImplementation {
  return {
    type,
    execute: async () => ({ ok: true, data: { type } }),
  }
}

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id:      "test-plugin",
    name:    "Test Plugin",
    version: "1.0.0",
    nodes: [
      {
        type:        "custom.hello",
        category:    "transform",
        label:       "Hello",
        description: "A test node",
      },
    ],
    ...overrides,
  }
}

// ─────────────────────────────────────────────
// BUILT-IN DESCRIPTORS
// ─────────────────────────────────────────────

describe("PluginRegistry — built-ins loaded at construction", () => {
  let registry: PluginRegistry

  beforeEach(() => { registry = new PluginRegistry() })

  test("all 18 built-in node types are registered", () => {
    expect(registry.types()).toHaveLength(BUILTIN_DESCRIPTORS.length)
  })

  test("has() returns true for all built-in types", () => {
    for (const d of BUILTIN_DESCRIPTORS) {
      expect(registry.has(d.type)).toBe(true)
    }
  })

  test("has() returns false for unknown types", () => {
    expect(registry.has("unknown.type")).toBe(false)
    expect(registry.has("")).toBe(false)
  })

  test("types() returns sorted list", () => {
    const types = registry.types()
    expect([...types].sort()).toEqual(types)
  })

  test("descriptor() returns the descriptor for built-in types", () => {
    const d = registry.descriptor("trigger.webhook")
    expect(d).toBeDefined()
    expect(d!.type).toBe("trigger.webhook")
    expect(d!.category).toBe("trigger")
    expect(d!.label).toBe("Webhook")
  })
})

// ─────────────────────────────────────────────
// IPluginRegistry — COMPILER INTERFACE
// ─────────────────────────────────────────────

describe("PluginRegistry — IPluginRegistry (compiler interface)", () => {
  let registry: PluginRegistry

  beforeEach(() => { registry = new PluginRegistry() })

  // isTrigger
  test("isTrigger returns true for all trigger.* types", () => {
    expect(registry.isTrigger("trigger.webhook")).toBe(true)
    expect(registry.isTrigger("trigger.cron")).toBe(true)
    expect(registry.isTrigger("trigger.manual")).toBe(true)
    expect(registry.isTrigger("trigger.event")).toBe(true)
  })

  test("isTrigger returns false for non-trigger types", () => {
    expect(registry.isTrigger("http.request")).toBe(false)
    expect(registry.isTrigger("flow.merge")).toBe(false)
    expect(registry.isTrigger("ai")).toBe(false)
  })

  // isErrorHandler
  test("isErrorHandler returns true only for flow.error", () => {
    expect(registry.isErrorHandler("flow.error")).toBe(true)
    expect(registry.isErrorHandler("flow.merge")).toBe(false)
    expect(registry.isErrorHandler("trigger.webhook")).toBe(false)
  })

  // isLoopNode
  test("isLoopNode returns true only for flow.loop", () => {
    expect(registry.isLoopNode("flow.loop")).toBe(true)
    expect(registry.isLoopNode("flow.each")).toBe(false)
    expect(registry.isLoopNode("flow.merge")).toBe(false)
  })

  // isStoreNode
  test("isStoreNode returns true only for store", () => {
    expect(registry.isStoreNode("store")).toBe(true)
    expect(registry.isStoreNode("http.request")).toBe(false)
    expect(registry.isStoreNode("ai")).toBe(false)
  })

  // isAiNode
  test("isAiNode returns true only for ai", () => {
    expect(registry.isAiNode("ai")).toBe(true)
    expect(registry.isAiNode("store")).toBe(false)
    expect(registry.isAiNode("data.code")).toBe(false)
  })

  // getOutputSchema
  test("getOutputSchema returns schema for trigger.webhook", () => {
    const schema = registry.getOutputSchema("trigger.webhook")
    expect(schema).toBeDefined()
    expect(schema?.type).toBe("object")
  })

  test("getOutputSchema returns undefined for nodes without schema", () => {
    expect(registry.getOutputSchema("flow.merge")).toBeUndefined()
    expect(registry.getOutputSchema("flow.delay")).toBeUndefined()
  })

  // getInputSchema
  test("getInputSchema returns undefined for all built-ins (none declare inputSchema)", () => {
    // Built-in nodes use configSchema, not inputSchema for now
    // inputSchema is for external event-driven nodes
    expect(registry.getInputSchema("trigger.webhook")).toBeUndefined()
  })

  // getFunctionNames
  test("getFunctionNames returns the set of all built-in functions", () => {
    const fns = registry.getFunctionNames()
    expect(fns.size).toBeGreaterThan(0)
    // Core builtins should all be present
    for (const fn of ["gt", "lt", "eq", "and", "or", "add", "concat", "upper", "pick", "now"]) {
      expect(fns.has(fn)).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────
// INodeRegistry — EXECUTOR INTERFACE
// ─────────────────────────────────────────────

describe("PluginRegistry — INodeRegistry (executor interface)", () => {
  let registry: PluginRegistry

  beforeEach(() => { registry = new PluginRegistry() })

  test("get returns undefined before any implementation is registered", () => {
    expect(registry.get("trigger.webhook")).toBeUndefined()
    expect(registry.get("http.request")).toBeUndefined()
  })

  test("get returns implementation after registerImpl", () => {
    const impl = makeImpl("trigger.webhook")
    registry.registerImpl(impl)
    expect(registry.get("trigger.webhook")).toBe(impl)
  })

  test("registerImpl throws for unknown type", () => {
    expect(() => registry.registerImpl(makeImpl("unknown.type")))
      .toThrow(PluginRegistrationError)
  })

  test("registerImpl throws with helpful message", () => {
    expect(() => registry.registerImpl(makeImpl("not.registered")))
      .toThrow(/Cannot register implementation for unknown type/)
  })

  test("hasImpl returns false before registration", () => {
    expect(registry.hasImpl("trigger.webhook")).toBe(false)
  })

  test("hasImpl returns true after registerImpl", () => {
    registry.registerImpl(makeImpl("ai"))
    expect(registry.hasImpl("ai")).toBe(true)
  })
})

// ─────────────────────────────────────────────
// PLUGIN REGISTRATION
// ─────────────────────────────────────────────

describe("PluginRegistry — register(manifest, impls)", () => {
  let registry: PluginRegistry

  beforeEach(() => { registry = new PluginRegistry() })

  test("registers a third-party plugin's descriptor", () => {
    const manifest = makeManifest()
    registry.register(manifest, [])
    expect(registry.has("custom.hello")).toBe(true)
  })

  test("registers a third-party plugin's implementation", () => {
    const manifest = makeManifest()
    const impl     = makeImpl("custom.hello")
    registry.register(manifest, [impl])
    expect(registry.get("custom.hello")).toBe(impl)
  })

  test("registers plugin entry for introspection", () => {
    registry.register(makeManifest(), [])
    const plugins = registry.plugins()
    expect(plugins).toHaveLength(1)
    expect(plugins[0]!.manifest.id).toBe("test-plugin")
  })

  test("throws if implementation type is not declared in manifest", () => {
    const manifest = makeManifest()   // only declares custom.hello
    const wrongImpl = makeImpl("custom.other")
    expect(() => registry.register(manifest, [wrongImpl]))
      .toThrow(PluginRegistrationError)
  })

  test("throws with helpful message about undeclared type", () => {
    expect(() => registry.register(makeManifest(), [makeImpl("custom.other")]))
      .toThrow(/not declared in the manifest/)
  })

  test("re-registering same plugin id overwrites previous entry", () => {
    registry.register(makeManifest({ version: "1.0.0" }), [])
    registry.register(makeManifest({ version: "2.0.0" }), [])
    const plugins = registry.plugins()
    expect(plugins).toHaveLength(1)
    expect(plugins[0]!.manifest.version).toBe("2.0.0")
  })

  test("plugin with multiple node types — all descriptors registered", () => {
    const manifest: PluginManifest = {
      id: "multi-plugin", name: "Multi", version: "1.0.0",
      nodes: [
        { type: "slack.send",   category: "http",      label: "Slack Send",   description: "" },
        { type: "slack.update", category: "http",      label: "Slack Update", description: "" },
        { type: "slack.read",   category: "transform", label: "Slack Read",   description: "" },
      ],
    }
    registry.register(manifest, [])
    expect(registry.has("slack.send")).toBe(true)
    expect(registry.has("slack.update")).toBe(true)
    expect(registry.has("slack.read")).toBe(true)
  })

  test("plugin can contribute custom function names to getFunctionNames()", () => {
    const manifest: PluginManifest = {
      id: "fn-plugin", name: "Fn Plugin", version: "1.0.0",
      nodes: [{
        type: "custom.fn", category: "transform", label: "Fn", description: "",
        functions: ["myCustomFn", "anotherFn"],
      }],
    }
    registry.register(manifest, [])
    const fns = registry.getFunctionNames()
    expect(fns.has("myCustomFn")).toBe(true)
    expect(fns.has("anotherFn")).toBe(true)
  })

  test("built-in functions are still present after plugin registration", () => {
    registry.register(makeManifest(), [])
    const fns = registry.getFunctionNames()
    expect(fns.has("gt")).toBe(true)
    expect(fns.has("concat")).toBe(true)
  })
})

// ─────────────────────────────────────────────
// STATUS
// ─────────────────────────────────────────────

describe("PluginRegistry — status()", () => {
  let registry: PluginRegistry

  beforeEach(() => { registry = new PluginRegistry() })

  test("fresh registry has descriptors but no implementations", () => {
    const s = registry.status()
    expect(s.totalDescriptors).toBe(BUILTIN_DESCRIPTORS.length)
    expect(s.totalImplementations).toBe(0)
    expect(s.ready).toBe(false)
    expect(s.missingImplementations.length).toBe(BUILTIN_DESCRIPTORS.length)
  })

  test("ready is true when all descriptors have implementations", () => {
    // Register impl for every built-in descriptor
    for (const d of BUILTIN_DESCRIPTORS) {
      registry.registerImpl(makeImpl(d.type))
    }
    const s = registry.status()
    expect(s.ready).toBe(true)
    expect(s.missingImplementations).toHaveLength(0)
  })

  test("missingImplementations lists types without impls", () => {
    registry.registerImpl(makeImpl("ai"))
    const missing = registry.status().missingImplementations
    expect(missing).not.toContain("ai")
    expect(missing).toContain("http.request")
    expect(missing).toContain("trigger.webhook")
  })

  test("totalPlugins counts registered third-party plugins", () => {
    registry.register(makeManifest({ id: "p1" }), [])
    registry.register(makeManifest({ id: "p2", nodes: [{ type: "custom.two", category: "transform", label: "Two", description: "" }] }), [])
    expect(registry.status().totalPlugins).toBe(2)
  })
})

// ─────────────────────────────────────────────
// COMPILER INTEGRATION — PluginRegistry satisfies IPluginRegistry
// ─────────────────────────────────────────────

describe("PluginRegistry — compiler integration", () => {
  test("compiles a valid flow using PluginRegistry", () => {
    // Compiler already imported at top
    const registry = new PluginRegistry()
    const compiler = new Compiler(registry)

    const result = compiler.compile({
      id: "f1", version: "1.0.0", name: "Test",
      accountId: "a1", workspaceId: "w1", createdBy: "u1",
      createdAt: Date.now(), updatedAt: Date.now(),
      nodes: {
        t: { id: "t", type: "trigger.webhook", config: {} },
        r: { id: "r", type: "http.request",    config: {
          url: { type: "literal", value: "https://example.com" },
        }},
      },
      edges: [{ id: "e1", from: "t", to: "r" }],
    })

    expect(result.ok).toBe(true)
  })

  test("compilation fails for unregistered node type", () => {
    // Compiler already imported at top
    const registry = new PluginRegistry()
    const compiler = new Compiler(registry)

    const result = compiler.compile({
      id: "f1", version: "1.0.0", name: "Test",
      accountId: "a1", workspaceId: "w1", createdBy: "u1",
      createdAt: Date.now(), updatedAt: Date.now(),
      nodes: {
        t: { id: "t", type: "trigger.webhook", config: {} },
        x: { id: "x", type: "not.a.real.type", config: {} },
      },
      edges: [{ id: "e1", source: "t", target: "x" }],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.some(e => e.code === "UNKNOWN_NODE_TYPE")).toBe(true)
    }
  })

  test("plugin node type passes compiler validation after registration", () => {
    // Compiler already imported at top
    const registry = new PluginRegistry()

    registry.register({
      id: "slack", name: "Slack", version: "1.0.0",
      nodes: [{ type: "slack.send", category: "http", label: "Slack Send", description: "" }],
    }, [])

    const compiler = new Compiler(registry)
    const result = compiler.compile({
      id: "f1", version: "1.0.0", name: "Test",
      accountId: "a1", workspaceId: "w1", createdBy: "u1",
      createdAt: Date.now(), updatedAt: Date.now(),
      nodes: {
        t:     { id: "t",    type: "trigger.manual", config: {} },
        slack: { id: "slack", type: "slack.send",     config: {} },
      },
      edges: [{ id: "e1", from: "t", to: "slack" }],
    })

    expect(result.ok).toBe(true)
  })
})
