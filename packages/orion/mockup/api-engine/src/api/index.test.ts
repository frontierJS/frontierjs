import { describe, test, expect, beforeAll, vi } from "vitest"
import { ApiRouter }           from "./index"
import { SQLiteFlowStore }     from "../store/flows"
import { SQLiteCredentialStore } from "../store/credentials"
import { SQLiteExecutionStore } from "../store/executions"
import { WorkflowActivator }   from "../triggers/activator"
import { Compiler }            from "../compiler"
import { InMemoryPlanCache }   from "../runtime/store"
import { TriggerRouter }       from "../triggers/router"
import { CronScheduler }       from "../triggers/cron"
import { EventBus }            from "../events"
import { TriggerRegistry }     from "../triggers/registry"
import { InMemoryQueue }       from "../runtime/queue"
import { PluginRegistry }      from "../plugins"
import { createSqlJsDatabase, runMigrations } from "../store/db"
import type { IDatabase } from "../store/db"

process.env["ORION_SECRET"] = "test-secret-at-least-32-chars-long!!"

// ─────────────────────────────────────────────
// TEST HARNESS
// ─────────────────────────────────────────────

let api:      ApiRouter
let db:       IDatabase
let flowStore: SQLiteFlowStore
let credStore: SQLiteCredentialStore
let execStore: SQLiteExecutionStore

const WORKSPACE = "ws-test"

beforeAll(async () => {
  db = await createSqlJsDatabase()
  runMigrations(db)

  flowStore = new SQLiteFlowStore(db)
  credStore = new SQLiteCredentialStore(db)
  execStore = new SQLiteExecutionStore(db)

  const pluginRegistry = new PluginRegistry()
  const queue    = new InMemoryQueue()
  const plans    = new InMemoryPlanCache()
  const eventBus = new EventBus(queue)
  const registry = new TriggerRegistry()
  const cron     = new CronScheduler(queue)
  const compiler = new Compiler(pluginRegistry)
  const triggerRouter = new TriggerRouter(queue, plans, registry, eventBus)
  const activator = new WorkflowActivator(compiler, plans, triggerRouter, cron, eventBus, registry)

  api = new ApiRouter({ flowStore, credStore, execStore, activator, workspaceId: WORKSPACE })
})

async function call(method: string, path: string, body?: unknown) {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body:    body ? JSON.stringify(body) : undefined,
  })
  const res = await api.handle(req)
  if (!res) return { status: 404, body: { error: "not handled" } }
  const json = await res.json()
  return { status: res.status, body: json }
}

// ─────────────────────────────────────────────
// NON-API ROUTES PASS THROUGH
// ─────────────────────────────────────────────

test("non-/api/ routes return null (pass-through)", async () => {
  const req = new Request("http://localhost/hooks/something", { method: "POST" })
  const res = await api.handle(req)
  expect(res).toBeNull()
})

test("GET /admin/health returns null (pass-through)", async () => {
  const req = new Request("http://localhost/admin/health", { method: "GET" })
  const res = await api.handle(req)
  expect(res).toBeNull()
})

// ─────────────────────────────────────────────
// FLOWS — CRUD
// ─────────────────────────────────────────────

const minimalFlow = {
  nodes: {
    t: { id: "t", type: "trigger.manual", config: {} },
    c: { id: "c", type: "data.code", config: { code: { type: "literal", value: "1+1" } } },
  },
  edges: [{ id: "e1", from: "t", to: "c" }],
}

describe("POST /api/flows", () => {
  test("creates a flow and returns 201", async () => {
    const res = await call("POST", "/api/flows", { ...minimalFlow, name: "My Flow" })
    expect(res.status).toBe(201)
    expect(res.body.flow.name).toBe("My Flow")
    expect(typeof res.body.flow.id).toBe("string")
    expect(res.body.flow.nodeCount).toBe(2)
    expect(res.body.activated).toBe(true)
  })

  test("uses supplied id and version", async () => {
    const res = await call("POST", "/api/flows", {
      ...minimalFlow, id: "flow-explicit", version: "2.0.0",
    })
    expect(res.status).toBe(201)
    expect(res.body.flow.id).toBe("flow-explicit")
  })

  test("returns 400 if nodes missing", async () => {
    const res = await call("POST", "/api/flows", { edges: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/nodes/)
  })

  test("returns 400 if edges missing", async () => {
    const res = await call("POST", "/api/flows", { nodes: {} })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/edges/)
  })

  test("saves flow with activated:false if compilation fails", async () => {
    const res = await call("POST", "/api/flows", {
      id: "flow-bad-compile",
      nodes: {
        t: { id: "t", type: "trigger.manual", config: {} },
        x: { id: "x", type: "does.not.exist", config: {} },
      },
      edges: [{ id: "e1", from: "t", to: "x" }],
    })
    expect(res.status).toBe(201)
    expect(res.body.activated).toBe(false)
    expect(typeof res.body.error).toBe("string")
  })
})

describe("GET /api/flows", () => {
  test("returns list of active flows", async () => {
    await call("POST", "/api/flows", { ...minimalFlow, id: "flow-list-1" })
    const res = await call("GET", "/api/flows")
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.flows)).toBe(true)
    expect(res.body.flows.some((f: any) => f.id === "flow-list-1")).toBe(true)
  })
})

describe("GET /api/flows/:id", () => {
  test("returns flow definition", async () => {
    await call("POST", "/api/flows", { ...minimalFlow, id: "flow-get", name: "Get Me" })
    const res = await call("GET", "/api/flows/flow-get")
    expect(res.status).toBe(200)
    expect(res.body.flow.name).toBe("Get Me")
    expect(res.body.flow.nodes).toBeDefined()
    expect(res.body.flow.edges).toBeDefined()
  })

  test("returns 404 for unknown flow", async () => {
    const res = await call("GET", "/api/flows/no-such-flow")
    expect(res.status).toBe(404)
  })
})

describe("PUT /api/flows/:id", () => {
  test("updates name and bumps version", async () => {
    await call("POST", "/api/flows", { ...minimalFlow, id: "flow-update", version: "1.0.0" })
    const res = await call("PUT", "/api/flows/flow-update", { name: "Updated Name" })
    expect(res.status).toBe(200)
    expect(res.body.flow.name).toBe("Updated Name")
    expect(res.body.flow.version).not.toBe("1.0.0")
  })

  test("accepts caller-supplied version", async () => {
    await call("POST", "/api/flows", { ...minimalFlow, id: "flow-versioned", version: "1.0.0" })
    const res = await call("PUT", "/api/flows/flow-versioned", { name: "v2", version: "2.0.0" })
    expect(res.status).toBe(200)
    expect(res.body.flow.version).toBe("2.0.0")
  })

  test("returns 404 for unknown flow", async () => {
    const res = await call("PUT", "/api/flows/ghost", { name: "x" })
    expect(res.status).toBe(404)
  })
})

describe("DELETE /api/flows/:id", () => {
  test("deletes flow and returns deleted:true", async () => {
    await call("POST", "/api/flows", { ...minimalFlow, id: "flow-delete" })
    const res = await call("DELETE", "/api/flows/flow-delete")
    expect(res.status).toBe(200)
    expect(res.body.deleted).toBe(true)
    expect(res.body.flowId).toBe("flow-delete")
  })

  test("subsequent GET returns 404", async () => {
    await call("POST", "/api/flows", { ...minimalFlow, id: "flow-delete-2" })
    await call("DELETE", "/api/flows/flow-delete-2")
    const res = await call("GET", "/api/flows/flow-delete-2")
    expect(res.status).toBe(404)
  })

  test("returns 404 for unknown flow", async () => {
    const res = await call("DELETE", "/api/flows/ghost")
    expect(res.status).toBe(404)
  })
})

describe("GET /api/flows/:id/versions", () => {
  test("returns version history", async () => {
    await call("POST", "/api/flows", { ...minimalFlow, id: "flow-versions", version: "1.0.0" })
    await call("PUT",  "/api/flows/flow-versions", { name: "v2", version: "2.0.0" })
    const res = await call("GET", "/api/flows/flow-versions/versions")
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.versions)).toBe(true)
    expect(res.body.versions.length).toBeGreaterThanOrEqual(2)
  })

  test("returns 404 for unknown flow", async () => {
    const res = await call("GET", "/api/flows/ghost/versions")
    expect(res.status).toBe(404)
  })
})

describe("POST /api/flows/:id/activate & deactivate", () => {
  test("activate returns activated:true", async () => {
    await call("POST", "/api/flows", { ...minimalFlow, id: "flow-toggle" })
    await call("POST", "/api/flows/flow-toggle/deactivate")
    const res = await call("POST", "/api/flows/flow-toggle/activate")
    expect(res.status).toBe(200)
    expect(res.body.activated).toBe(true)
  })

  test("deactivate returns deactivated:true", async () => {
    await call("POST", "/api/flows", { ...minimalFlow, id: "flow-deact" })
    const res = await call("POST", "/api/flows/flow-deact/deactivate")
    expect(res.status).toBe(200)
    expect(res.body.deactivated).toBe(true)
  })
})

describe("GET/PUT /api/flows/:id/layout", () => {
  test("GET returns empty layout for new flow", async () => {
    await call("POST", "/api/flows", { ...minimalFlow, id: "flow-layout" })
    const res = await call("GET", "/api/flows/flow-layout/layout")
    expect(res.status).toBe(200)
    expect(res.body.layout).toBeDefined()
  })

  test("PUT saves layout, GET retrieves it", async () => {
    await call("POST", "/api/flows", { ...minimalFlow, id: "flow-layout-2" })
    await call("PUT", "/api/flows/flow-layout-2/layout", {
      nodes: { t: { x: 100, y: 200 }, c: { x: 300, y: 200 } },
    })
    const res = await call("GET", "/api/flows/flow-layout-2/layout")
    expect(res.status).toBe(200)
    expect((res.body.layout as any).nodes?.t?.x).toBe(100)
  })
})

// ─────────────────────────────────────────────
// CREDENTIALS
// ─────────────────────────────────────────────

describe("POST /api/credentials", () => {
  test("creates credential and returns id", async () => {
    const res = await call("POST", "/api/credentials", {
      name: "my-openai", provider: "openai", data: { apiKey: "sk-test" },
    })
    expect(res.status).toBe(201)
    expect(typeof res.body.id).toBe("string")
    expect(res.body.name).toBe("my-openai")
    expect(res.body.provider).toBe("openai")
    expect(res.body.data).toBeUndefined()  // never returned
  })

  test("returns 400 if name missing", async () => {
    const res = await call("POST", "/api/credentials", { provider: "openai", data: {} })
    expect(res.status).toBe(400)
  })

  test("returns 400 if provider missing", async () => {
    const res = await call("POST", "/api/credentials", { name: "x", data: {} })
    expect(res.status).toBe(400)
  })

  test("returns 400 if data missing", async () => {
    const res = await call("POST", "/api/credentials", { name: "x", provider: "y" })
    expect(res.status).toBe(400)
  })
})

describe("GET /api/credentials", () => {
  test("lists credentials — no plaintext data exposed", async () => {
    await call("POST", "/api/credentials", {
      name: "list-cred", provider: "stripe", data: { secretKey: "sk_live_secret" },
    })
    const res = await call("GET", "/api/credentials")
    expect(res.status).toBe(200)
    const cred = res.body.credentials.find((c: any) => c.name === "list-cred")
    expect(cred).toBeDefined()
    expect(cred.secretKey).toBeUndefined()
    expect(cred.data).toBeUndefined()
  })
})

describe("GET /api/credentials/:id", () => {
  test("returns metadata without data", async () => {
    const create = await call("POST", "/api/credentials", {
      name: "get-cred", provider: "anthropic", data: { apiKey: "ant-key" },
    })
    const res = await call("GET", `/api/credentials/${create.body.id}`)
    expect(res.status).toBe(200)
    expect(res.body.credential.name).toBe("get-cred")
    expect(res.body.credential.data).toBeUndefined()
  })

  test("returns 404 for unknown id", async () => {
    const res = await call("GET", "/api/credentials/no-such-id")
    expect(res.status).toBe(404)
  })
})

describe("PUT /api/credentials/:id", () => {
  test("updates name and provider", async () => {
    const create = await call("POST", "/api/credentials", {
      name: "upd-cred", provider: "openai", data: { apiKey: "old-key" },
    })
    const res = await call("PUT", `/api/credentials/${create.body.id}`, {
      name: "updated-name",
      data: { apiKey: "new-key" },
    })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe("updated-name")
  })

  test("returns 404 for unknown id", async () => {
    const res = await call("PUT", "/api/credentials/ghost", { name: "x" })
    expect(res.status).toBe(404)
  })
})

describe("DELETE /api/credentials/:id", () => {
  test("deletes credential", async () => {
    const create = await call("POST", "/api/credentials", {
      name: "del-cred", provider: "openai", data: { apiKey: "k" },
    })
    const res = await call("DELETE", `/api/credentials/${create.body.id}`)
    expect(res.status).toBe(200)
    expect(res.body.deleted).toBe(true)
  })

  test("returns 404 for unknown id", async () => {
    const res = await call("DELETE", "/api/credentials/ghost")
    expect(res.status).toBe(404)
  })
})

// ─────────────────────────────────────────────
// EXECUTIONS
// ─────────────────────────────────────────────

describe("GET /api/executions", () => {
  test("returns list of executions", async () => {
    const res = await call("GET", "/api/executions")
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.executions)).toBe(true)
    expect(typeof res.body.count).toBe("number")
  })

  test("supports limit and offset params", async () => {
    const res = await call("GET", "/api/executions?limit=5&offset=0")
    expect(res.status).toBe(200)
  })

  test("supports status filter", async () => {
    const res = await call("GET", "/api/executions?status=completed")
    expect(res.status).toBe(200)
  })
})

describe("GET /api/executions/:id", () => {
  test("returns 404 for unknown execution", async () => {
    const res = await call("GET", "/api/executions/no-such-exec")
    expect(res.status).toBe(404)
  })

  test("returns execution record when it exists", async () => {
    // Write a record directly to the store
    await execStore.saveRecord({
      executionId: "exec-api-test",
      flowId:      "flow-test",
      version:     "1.0.0",
      status:      "completed",
      trigger:     { manual: true },
      startedAt:   Date.now() - 100,
      endedAt:     Date.now(),
      durationMs:  100,
      nodeStates:  {},
      nodeTimings: {},
      slowNodes:   [],
      finalContext: {},
    })
    const res = await call("GET", "/api/executions/exec-api-test")
    expect(res.status).toBe(200)
    expect(res.body.execution.executionId).toBe("exec-api-test")
    expect(res.body.execution.status).toBe("completed")
  })
})

describe("GET /api/flows/:id/executions", () => {
  test("filters executions by flowId", async () => {
    await execStore.saveRecord({
      executionId: "exec-flow-filter",
      flowId:      "flow-filter-test",
      version:     "1.0.0",
      status:      "completed",
      trigger:     {},
      startedAt:   Date.now(),
      endedAt:     Date.now(),
      durationMs:  50,
      nodeStates:  {},
      nodeTimings: {},
      slowNodes:   [],
      finalContext: {},
    })
    const res = await call("GET", "/api/flows/flow-filter-test/executions")
    expect(res.status).toBe(200)
    expect(res.body.executions.every((e: any) => e.flowId === "flow-filter-test")).toBe(true)
  })
})

describe("GET /api/flows/:id/metrics + GET /api/metrics", () => {
  test("returns metrics shape for a flow", async () => {
    const res = await call("GET", "/api/flows/flow-test/metrics")
    expect(res.status).toBe(200)
    expect(typeof res.body.metrics.totalRuns).toBe("number")
    expect(typeof res.body.metrics.successRate).toBe("number")
  })

  test("returns global metrics", async () => {
    const res = await call("GET", "/api/metrics")
    expect(res.status).toBe(200)
    expect(typeof res.body.metrics.totalRuns).toBe("number")
  })

  test("supports windowMs param", async () => {
    const res = await call("GET", "/api/flows/flow-test/metrics?windowMs=86400000")
    expect(res.status).toBe(200)
    expect(res.body.metrics.windowMs).toBe(86400000)
  })
})

// ─────────────────────────────────────────────
// UNKNOWN ROUTES
// ─────────────────────────────────────────────

test("unknown /api/ path returns 404", async () => {
  const res = await call("GET", "/api/unknown/route")
  expect(res.status).toBe(404)
})
