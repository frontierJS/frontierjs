import type { IFlowStore, FlowStatus }     from "../store/flows"
import type { ICredentialStore,
              CredentialInput }            from "../store/credentials"
import type { IExecutionStore }            from "../runtime/store"
import type { RecordFilter }               from "../runtime/store"
import type { WorkflowActivator }          from "../triggers/activator"
import type { Flow }                       from "../types"

// ─────────────────────────────────────────────
// API ROUTER
// Handles all /api/* routes.
// Mounted alongside TriggerRouter in server.ts.
//
// Flows:
//   POST   /api/flows                  create + activate
//   GET    /api/flows                  list active flows
//   GET    /api/flows/:id              get latest version
//   PUT    /api/flows/:id              update + hot-reload triggers
//   DELETE /api/flows/:id              archive + deactivate
//   GET    /api/flows/:id/versions     version history
//   POST   /api/flows/:id/activate     set status = active, re-register
//   POST   /api/flows/:id/deactivate   set status = inactive, tear down
//   GET    /api/flows/:id/layout       visual positions
//   PUT    /api/flows/:id/layout       save visual positions
//
// Credentials:
//   POST   /api/credentials            create
//   GET    /api/credentials            list (metadata only — no plaintext data)
//   GET    /api/credentials/:id        get (metadata only)
//   PUT    /api/credentials/:id        update
//   DELETE /api/credentials/:id        delete
//
// Executions:
//   GET    /api/executions             list (filter by flowId, status, since)
//   GET    /api/executions/:id         get single record
//   GET    /api/flows/:id/executions   executions for a specific flow
//   GET    /api/flows/:id/metrics      aggregated performance metrics
// ─────────────────────────────────────────────

export interface ApiRouterDeps {
  flowStore:   IFlowStore
  credStore:   ICredentialStore
  execStore:   IExecutionStore
  activator:   WorkflowActivator
  workspaceId: string
}

export class ApiRouter {
  constructor(private readonly deps: ApiRouterDeps) {}

  handle = async (req: Request): Promise<Response | null> => {
    const url    = new URL(req.url)
    const path   = url.pathname
    const method = req.method.toUpperCase()

    if (!path.startsWith("/api/")) return null  // not ours

    try {
      return await this.route(req, method, path, url)
    } catch (err) {
      return error(500, errorMessage(err))
    }
  }

  // ─────────────────────────────────────────────
  // ROUTING TABLE
  // ─────────────────────────────────────────────

  private async route(req: Request, method: string, path: string, url: URL): Promise<Response> {
    const { flowStore, credStore, execStore, activator, workspaceId } = this.deps

    // ── /api/flows ──────────────────────────────────────────────────

    if (path === "/api/flows") {
      if (method === "GET")  return this.listFlows()
      if (method === "POST") return this.createFlow(req)
    }

    const flowMatch = path.match(/^\/api\/flows\/([^/]+)$/)
    if (flowMatch) {
      const flowId = flowMatch[1]!
      if (method === "GET")    return this.getFlow(flowId)
      if (method === "PUT")    return this.updateFlow(req, flowId)
      if (method === "DELETE") return this.deleteFlow(flowId)
    }

    const flowVersionsMatch = path.match(/^\/api\/flows\/([^/]+)\/versions$/)
    if (flowVersionsMatch && method === "GET") {
      return this.listFlowVersions(flowVersionsMatch[1]!)
    }

    const flowActivateMatch = path.match(/^\/api\/flows\/([^/]+)\/(activate|deactivate)$/)
    if (flowActivateMatch && method === "POST") {
      const [, flowId, action] = flowActivateMatch
      return action === "activate"
        ? this.activateFlow(flowId!)
        : this.deactivateFlow(flowId!)
    }

    const flowLayoutMatch = path.match(/^\/api\/flows\/([^/]+)\/layout$/)
    if (flowLayoutMatch) {
      const flowId = flowLayoutMatch[1]!
      if (method === "GET") return this.getLayout(flowId)
      if (method === "PUT") return this.saveLayout(req, flowId)
    }

    const flowExecsMatch = path.match(/^\/api\/flows\/([^/]+)\/executions$/)
    if (flowExecsMatch && method === "GET") {
      return this.listExecutions(url, flowExecsMatch[1]!)
    }

    const flowMetricsMatch = path.match(/^\/api\/flows\/([^/]+)\/metrics$/)
    if (flowMetricsMatch && method === "GET") {
      return this.getMetrics(url, flowMetricsMatch[1]!)
    }

    // ── /api/credentials ────────────────────────────────────────────

    if (path === "/api/credentials") {
      if (method === "GET")  return this.listCredentials()
      if (method === "POST") return this.createCredential(req)
    }

    const credMatch = path.match(/^\/api\/credentials\/([^/]+)$/)
    if (credMatch) {
      const credId = credMatch[1]!
      if (method === "GET")    return this.getCredential(credId)
      if (method === "PUT")    return this.updateCredential(req, credId)
      if (method === "DELETE") return this.deleteCredential(credId)
    }

    // ── /api/executions ─────────────────────────────────────────────

    if (path === "/api/executions" && method === "GET") {
      return this.listExecutions(url)
    }

    const execMatch = path.match(/^\/api\/executions\/([^/]+)$/)
    if (execMatch && method === "GET") {
      return this.getExecution(execMatch[1]!)
    }

    const metricsMatch = path.match(/^\/api\/metrics$/)
    if (metricsMatch && method === "GET") {
      return this.getMetrics(url)
    }

    return error(404, "Not found")
  }

  // ─────────────────────────────────────────────
  // FLOW HANDLERS
  // ─────────────────────────────────────────────

  private listFlows(): Response {
    const flows = this.deps.flowStore.listActive()
    return ok({ flows: flows.map(flowSummary) })
  }

  private async createFlow(req: Request): Promise<Response> {
    const body = await parseBody(req) as Record<string, unknown>
    const validation = validateFlowBody(body)
    if (!validation.ok) return error(400, validation.error)

    const flow = buildFlow(body, this.deps.workspaceId)

    this.deps.flowStore.save(flow)

    const results = await this.deps.activator.activate([flow])
    const result  = results[0]!

    if (!result.ok) {
      // Save succeeded but activation failed — flow is persisted as inactive
      this.deps.flowStore.setStatus(flow.id, flow.version, "inactive")
      return ok({ flow: flowSummary(flow), activated: false, error: result.error }, 201)
    }

    return ok({ flow: flowSummary(flow), activated: true, triggers: result.triggers }, 201)
  }

  private getFlow(flowId: string): Response {
    const flow = this.deps.flowStore.get(flowId)
    if (!flow) return error(404, `Flow "${flowId}" not found`)
    return ok({ flow })
  }

  private async updateFlow(req: Request, flowId: string): Promise<Response> {
    const existing = this.deps.flowStore.get(flowId)
    if (!existing) return error(404, `Flow "${flowId}" not found`)

    const body = await parseBody(req) as Record<string, unknown>
    const validation = validateFlowBody(body, { partial: true })
    if (!validation.ok) return error(400, validation.error)

    const updated: Flow = {
      ...existing,
      ...(body.name    !== undefined && { name:    body.name    as string }),
      ...(body.nodes   !== undefined && { nodes:   body.nodes   as Flow["nodes"] }),
      ...(body.edges   !== undefined && { edges:   body.edges   as Flow["edges"] }),
      ...(body.version !== undefined && { version: body.version as string }),
      updatedAt: Date.now(),
    }

    if (updated.version === existing.version) {
      // Auto-bump patch version if caller didn't supply a new one
      updated.version = bumpVersion(existing.version)
    }

    this.deps.flowStore.save(updated)

    // Hot-reload: tear down old triggers, register new ones
    const result = await this.deps.activator.reload(updated)

    return ok({
      flow:      flowSummary(updated),
      activated: result.ok,
      triggers:  result.ok ? result.triggers : 0,
      ...(result.ok ? {} : { error: result.error }),
    })
  }

  private async deleteFlow(flowId: string): Promise<Response> {
    const existing = this.deps.flowStore.get(flowId)
    if (!existing) return error(404, `Flow "${flowId}" not found`)

    await this.deps.activator.deactivate(flowId)
    this.deps.flowStore.delete(flowId)

    return ok({ deleted: true, flowId })
  }

  private listFlowVersions(flowId: string): Response {
    const versions = this.deps.flowStore.versions(flowId)
    if (versions.length === 0) return error(404, `Flow "${flowId}" not found`)
    return ok({ flowId, versions })
  }

  private async activateFlow(flowId: string): Promise<Response> {
    // Use versions() to find the flow regardless of current status
    const versions = this.deps.flowStore.versions(flowId)
    if (versions.length === 0) return error(404, `Flow "${flowId}" not found`)
    const latest  = versions[0]!
    const flow = this.deps.flowStore.getVersion(flowId, latest.version)
    if (!flow) return error(404, `Flow "${flowId}" not found`)

    const result = await this.deps.activator.reload(flow)

    if (result.ok) {
      this.deps.flowStore.setStatus(flowId, flow.version, "active")
    }

    return ok({
      flowId,
      activated: result.ok,
      triggers:  result.ok ? result.triggers : 0,
      ...(result.ok ? {} : { error: result.error }),
    })
  }

  private async deactivateFlow(flowId: string): Promise<Response> {
    const flow = this.deps.flowStore.get(flowId)
    if (!flow) return error(404, `Flow "${flowId}" not found`)

    await this.deps.activator.deactivate(flowId)
    this.deps.flowStore.setStatus(flowId, flow.version, "inactive")

    return ok({ flowId, deactivated: true })
  }

  private getLayout(flowId: string): Response {
    const layout = this.deps.flowStore.getLayout(flowId)
    if (!layout) return ok({ flowId, layout: {} })
    return ok({ flowId, layout })
  }

  private async saveLayout(req: Request, flowId: string): Promise<Response> {
    const existing = this.deps.flowStore.get(flowId)
    if (!existing) return error(404, `Flow "${flowId}" not found`)

    const body = await parseBody(req) as Record<string, unknown>
    this.deps.flowStore.saveLayout(flowId, body)
    return ok({ flowId, saved: true })
  }

  // ─────────────────────────────────────────────
  // CREDENTIAL HANDLERS
  // ─────────────────────────────────────────────

  private listCredentials(): Response {
    const metas = this.deps.credStore.list(this.deps.workspaceId)
    return ok({ credentials: metas })
  }

  private async createCredential(req: Request): Promise<Response> {
    const body = await parseBody(req) as Record<string, unknown>

    if (!body.name || typeof body.name !== "string") return error(400, "name is required")
    if (!body.provider || typeof body.provider !== "string") return error(400, "provider is required")
    if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
      return error(400, "data must be an object of key-value pairs")
    }

    const id   = generateId()
    const cred: CredentialInput = {
      id,
      workspaceId: this.deps.workspaceId,
      name:        body.name,
      provider:    body.provider,
      data:        body.data as Record<string, string>,
    }

    this.deps.credStore.save(cred)
    return ok({ id, name: cred.name, provider: cred.provider }, 201)
  }

  private getCredential(credId: string): Response {
    const meta = this.deps.credStore.list(this.deps.workspaceId)
      .find(c => c.id === credId)
    if (!meta) return error(404, `Credential "${credId}" not found`)
    return ok({ credential: meta })
  }

  private async updateCredential(req: Request, credId: string): Promise<Response> {
    const existing = this.deps.credStore.get(credId)
    if (!existing) return error(404, `Credential "${credId}" not found`)

    const body = await parseBody(req) as Record<string, unknown>

    const updated: CredentialInput = {
      ...existing,
      ...(body.name     !== undefined && { name:     body.name as string }),
      ...(body.provider !== undefined && { provider: body.provider as string }),
      ...(body.data     !== undefined && { data:     body.data as Record<string, string> }),
    }

    this.deps.credStore.save(updated)
    return ok({ id: credId, name: updated.name, provider: updated.provider })
  }

  private deleteCredential(credId: string): Response {
    const existing = this.deps.credStore.get(credId)
    if (!existing) return error(404, `Credential "${credId}" not found`)

    this.deps.credStore.delete(credId)
    return ok({ deleted: true, credId })
  }

  // ─────────────────────────────────────────────
  // EXECUTION HANDLERS
  // ─────────────────────────────────────────────

  private async listExecutions(url: URL, flowId?: string): Promise<Response> {
    const params = url.searchParams
    const filter: RecordFilter = {
      ...(flowId                                 && { flowId }),
      ...(params.get("flowId")                   && { flowId: params.get("flowId")! }),
      ...(params.get("status")                   && { status: params.get("status") as any }),
      ...(params.get("since")                    && { since:  Number(params.get("since")) }),
      limit:  params.get("limit")  ? Number(params.get("limit"))  : 50,
      offset: params.get("offset") ? Number(params.get("offset")) : 0,
    }

    const records = await this.deps.execStore.queryRecords(filter)
    return ok({ executions: records.map(executionSummary), count: records.length })
  }

  private async getExecution(executionId: string): Promise<Response> {
    const record = await this.deps.execStore.getRecord(executionId)
    if (!record) return error(404, `Execution "${executionId}" not found`)
    return ok({ execution: record })
  }

  private async getMetrics(url: URL, flowId?: string): Promise<Response> {
    const windowMs = url.searchParams.get("windowMs")
      ? Number(url.searchParams.get("windowMs"))
      : 3_600_000

    const metrics = await this.deps.execStore.getMetrics(flowId, windowMs)
    return ok({ metrics })
  }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function error(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

async function parseBody(req: Request): Promise<unknown> {
  try {
    const text = await req.text()
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function generateId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let id = ""
  for (let i = 0; i < 21; i++) id += chars[Math.floor(Math.random() * chars.length)]
  return id
}

function bumpVersion(version: string): string {
  const parts = version.split(".").map(Number)
  if (parts.length === 3 && parts.every(n => !isNaN(n))) {
    return `${parts[0]}.${parts[1]}.${(parts[2]! + 1)}`
  }
  return `${version}.1`
}

// ── Flow validation ───────────────────────────

type ValidationResult = { ok: true } | { ok: false; error: string }

function validateFlowBody(body: unknown, opts: { partial?: boolean } = {}): ValidationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object" }
  }

  const b = body as Record<string, unknown>

  if (!opts.partial) {
    if (!b.nodes || typeof b.nodes !== "object") {
      return { ok: false, error: "nodes is required and must be an object" }
    }
    if (!Array.isArray(b.edges)) {
      return { ok: false, error: "edges is required and must be an array" }
    }
  }

  if (b.nodes !== undefined && (typeof b.nodes !== "object" || Array.isArray(b.nodes))) {
    return { ok: false, error: "nodes must be an object" }
  }
  if (b.edges !== undefined && !Array.isArray(b.edges)) {
    return { ok: false, error: "edges must be an array" }
  }

  return { ok: true }
}

function buildFlow(body: Record<string, unknown>, workspaceId: string): Flow {
  const now = Date.now()
  return {
    id:          (body.id as string | undefined)      ?? generateId(),
    version:     (body.version as string | undefined) ?? "1.0.0",
    name:        (body.name as string | undefined)    ?? "Untitled Flow",
    accountId:   (body.accountId as string | undefined) ?? workspaceId,
    workspaceId: (body.workspaceId as string | undefined) ?? workspaceId,
    createdBy:   (body.createdBy as string | undefined) ?? "api",
    createdAt:   now,
    updatedAt:   now,
    nodes:       body.nodes as Flow["nodes"],
    edges:       body.edges as Flow["edges"],
    ...(body.tags        ? { tags:        body.tags as string[] }        : {}),
    ...(body.description ? { description: body.description as string }   : {}),
  }
}

// ── Response shapes ───────────────────────────

function flowSummary(flow: Flow) {
  return {
    id:          flow.id,
    version:     flow.version,
    name:        flow.name,
    workspaceId: flow.workspaceId,
    nodeCount:   Object.keys(flow.nodes).length,
    edgeCount:   flow.edges.length,
    updatedAt:   flow.updatedAt,
  }
}

function executionSummary(record: import("../runtime/context").ExecutionRecord) {
  return {
    executionId: record.executionId,
    flowId:      record.flowId,
    version:     record.version,
    status:      record.status,
    startedAt:   record.startedAt,
    endedAt:     record.endedAt,
    durationMs:  record.durationMs,
    error:       record.error,
  }
}
