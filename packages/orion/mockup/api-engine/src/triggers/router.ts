import type { IExecutionQueue, ExecutionJob } from "../runtime/queue"
import type { IPlanCache } from "../runtime/store"
import type { IEventBus } from "../events"
import type { TriggerRegistry } from "./registry"
import type { IExecutionStore } from "../runtime/store"
import type { SyncResponseHandle, SyncHttpResponse } from "../runtime/context"
import type { WaitRegistry } from "../store/wait"
import { QueueFullError } from "../runtime/queue"

// ─────────────────────────────────────────────
// TRIGGER ROUTER
// The single Bun fetch handler. All inbound HTTP flows through here.
//
// Route table:
//   POST /hooks/*              → webhook trigger    (O(1) registry lookup)
//   POST /webhooks/*           → mapped webhook     (WebhookMapper → EventBus)
//   POST /events/:name         → event emit         (EventBus.emit)
//   POST /flows/:id/trigger    → manual trigger     (any active flow)
//   GET  /admin/health         → system health
//   GET  /admin/triggers       → registered triggers
//   *                          → 404
//
// Surface API:
//   new TriggerRouter(queue, plans, registry, eventBus)
//   router.handle(req)   → Response   (pass to Bun.serve)
// ─────────────────────────────────────────────

export class TriggerRouter {
  constructor(
    private readonly queue:    IExecutionQueue,
    private readonly plans:    IPlanCache,
    private readonly registry: TriggerRegistry,
    private readonly eventBus: IEventBus,
    private readonly execStore?: IExecutionStore,
    private readonly waitReg?:   WaitRegistry,
  ) {}

  handle = async (req: Request): Promise<Response> => {
    const url    = new URL(req.url)
    const path   = url.pathname
    const method = req.method.toUpperCase()

    try {
      // ── Wait resume ────────────────────────────────────────────
      if (method === "POST" && path.startsWith("/wait/")) {
        const resumeKey = path.slice("/wait/".length)
        return await this.handleWaitResume(req, resumeKey)
      }

      // ── Webhook trigger — O(1) lookup ──────────────────────────
      if (method === "POST" && path.startsWith("/hooks/")) {
        return await this.handleWebhook(req, path)
      }

      // ── Mapped webhook → event ─────────────────────────────────
      if (method === "POST" && path.startsWith("/webhooks/")) {
        return await this.handleMappedWebhook(req, path)
      }

      // ── Event emit ─────────────────────────────────────────────
      if (method === "POST" && path.startsWith("/events/")) {
        const eventName = path.slice("/events/".length)
        return await this.handleEventEmit(req, eventName)
      }

      // ── Manual trigger ─────────────────────────────────────────
      if (method === "POST") {
        const match = path.match(/^\/flows\/([^/]+)\/trigger$/)
        if (match) return await this.handleManualTrigger(req, match[1]!)
      }

      // ── Admin ──────────────────────────────────────────────────
      if (path === "/admin/health" && method === "GET") {
        return this.handleHealth()
      }

      if (path === "/admin/triggers" && method === "GET") {
        return this.handleTriggerList()
      }

      return json({ error: "Not found" }, 404)

    } catch (err) {
      return json({ error: "Internal server error", detail: errorMessage(err) }, 500)
    }
  }

  // ─── WEBHOOK ─────────────────────────────────

  private async handleWebhook(req: Request, path: string): Promise<Response> {
    const entry = this.registry.getWebhook(path)
    if (!entry) return json({ error: `No flow registered at "${path}"` }, 404)

    const body = await parseBody(req)
    const trigger = { path, body, headers: headersToObject(req.headers), receivedAt: Date.now() }

    // Check whether this webhook is configured for sync mode
    const plan = this.plans.get(entry.flowId, entry.version)
    const triggerNode = plan ? Object.values(plan.nodes).find(n => n.id === entry.nodeId) : undefined
    const mode      = (triggerNode?.config as any)?.mode ?? "async"
    const timeoutMs = Number((triggerNode?.config as any)?.timeoutMs ?? 30_000)

    if (mode === "sync") {
      return await this.handleSyncWebhook(entry, trigger, timeoutMs)
    }

    const job: ExecutionJob = {
      executionId: generateId(),
      flowId:      entry.flowId,
      version:     entry.version,
      trigger,
    }
    return await this.enqueueAndRespond(job)
  }

  private async handleSyncWebhook(
    entry:     { flowId: string; version: string },
    trigger:   unknown,
    timeoutMs: number,
  ): Promise<Response> {
    return new Promise<Response>(async (resolve) => {
      const executionId = generateId()

      const handle: SyncResponseHandle = {
        resolve: (res: SyncHttpResponse) => {
          const body = typeof res.body === "string"
            ? res.body
            : JSON.stringify(res.body)
          const headers: Record<string, string> = {
            "content-type": "application/json",
            ...res.headers,
          }
          resolve(new Response(body, { status: res.status, headers }))
        },
        reject: (err: Error) => {
          resolve(json({ error: err.message }, 502))
        },
      }

      // Timeout — if http.respond never fires, send 504
      const timer = setTimeout(() => {
        resolve(json({ error: "Gateway timeout — flow did not respond in time" }, 504))
      }, timeoutMs)

      const job: ExecutionJob = {
        executionId,
        flowId:   entry.flowId,
        version:  entry.version,
        trigger,
        responseHandle: handle,
      }

      try {
        await this.queue.enqueue(job)
      } catch (err) {
        clearTimeout(timer)
        if (err instanceof QueueFullError) {
          resolve(json({ error: "Queue full — try again shortly" }, 503))
        } else {
          resolve(json({ error: "Internal server error" }, 500))
        }
      }
    })
  }

  // ─── MAPPED WEBHOOK → EVENT ──────────────────

  private async handleMappedWebhook(req: Request, path: string): Promise<Response> {
    const body    = await parseBody(req)
    const headers = headersToObject(req.headers)
    const mapped  = this.eventBus.mapRequest(path, body, headers)

    if (!mapped) return json({ error: `No mapper registered for "${path}"` }, 404)

    const result = await this.eventBus.emit(mapped.name, mapped.payload)
    return json({ accepted: true, event: result.eventName, subscribers: result.subscribers, executionIds: result.executionIds }, 202)
  }

  // ─── EVENT EMIT ──────────────────────────────

  private async handleEventEmit(req: Request, eventName: string): Promise<Response> {
    if (!eventName) return json({ error: "Event name required" }, 400)

    const payload = await parseBody(req)
    const result  = await this.eventBus.emit(eventName, payload)
    return json({ accepted: true, event: result.eventName, subscribers: result.subscribers, executionIds: result.executionIds }, 202)
  }

  // ─── MANUAL TRIGGER ──────────────────────────

  private async handleManualTrigger(req: Request, flowId: string): Promise<Response> {
    // Find the most recent version via registry (any trigger type)
    const entries = this.registry.getByFlow(flowId)
    if (entries.length === 0) return json({ error: `Flow "${flowId}" not found or not active` }, 404)

    const version = entries[0]!.version
    const body    = await parseBody(req)
    const job: ExecutionJob = {
      executionId: generateId(),
      flowId,
      version,
      trigger:     { manual: true, payload: body, triggeredAt: Date.now() },
    }

    return await this.enqueueAndRespond(job)
  }

  // ─── WAIT RESUME ─────────────────────────────

  private async handleWaitResume(req: Request, resumeKey: string): Promise<Response> {
    if (!resumeKey) return json({ error: "resumeKey required" }, 400)
    if (!this.waitReg || !this.execStore) {
      return json({ error: "Wait registry not configured" }, 501)
    }

    const entry = this.waitReg.getByKey(resumeKey)
    if (!entry) return json({ error: "Unknown or already-consumed resume key" }, 404)

    if (entry.timeoutAt !== null && Date.now() > entry.timeoutAt) {
      this.waitReg.consume(resumeKey)
      return json({ error: "Resume key has expired" }, 410)
    }

    const payload = await parseBody(req)

    // Load the suspended context
    const savedCtx = await this.execStore.getContext(entry.executionId)
    if (!savedCtx) return json({ error: `Execution "${entry.executionId}" context not found` }, 404)

    // Inject the resume payload into context
    savedCtx.nodes[entry.resumeCtxKey] = payload
    savedCtx.status = "resuming"
    savedCtx.currentStage = savedCtx.currentStage + 1  // advance past the flow.wait stage

    // Consume the wait entry before re-enqueuing
    this.waitReg.consume(resumeKey)

    const job: ExecutionJob = {
      executionId: entry.executionId,
      flowId:      entry.flowId,
      version:     savedCtx.version,
      trigger:     savedCtx.trigger,
      resumeFrom:  savedCtx,
    }

    return await this.enqueueAndRespond(job)
  }

  // ─── ADMIN ───────────────────────────────────

  private handleHealth(): Response {
    return json({
      status:   "ok",
      queue:    { depth: this.queue.size() },
      triggers: { count: this.registry.size() },
      time:     Date.now(),
    })
  }

  private handleTriggerList(): Response {
    return json({ triggers: this.registry.all() })
  }

  // ─── SHARED ──────────────────────────────────

  private async enqueueAndRespond(job: ExecutionJob): Promise<Response> {
    try {
      await this.queue.enqueue(job)
      return json({ accepted: true, executionId: job.executionId }, 202)
    } catch (err) {
      if (err instanceof QueueFullError) {
        return json({ error: "Queue full — try again shortly" }, 503)
      }
      throw err
    }
  }
}

// ─────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

async function parseBody(req: Request): Promise<unknown> {
  const ct = req.headers.get("content-type") ?? ""
  if (ct.includes("application/json")) {
    try { return await req.json() } catch { return null }
  }
  const text = await req.text()
  return text || null
}

function headersToObject(headers: Headers): Record<string, string> {
  const obj: Record<string, string> = {}
  headers.forEach((value, key) => { obj[key] = value })
  return obj
}

function generateId(): string {
  return `exec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
