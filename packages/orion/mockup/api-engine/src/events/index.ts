import type { JSONSchema } from "../types"
import type { IExecutionQueue, ExecutionJob } from "../runtime/queue"

// ─────────────────────────────────────────────
// EVENT BUS
// Named event pub/sub. Flows subscribe to event names;
// emitting fans out to all subscribers as parallel ExecutionJobs.
//
// Transport is decoupled — events can arrive from:
//   HTTP   POST /events/:name          (external systems)
//   Code   eventBus.emit(name, payload) (internal flows via event.emit node)
//   Mapped WebhookMapper translates an inbound HTTP path + body → event name
//
// Surface API:
//   eventBus.subscribe(name, flowId, version)
//   eventBus.unsubscribe(flowId)
//   eventBus.emit(name, payload)        → EmitResult
//   eventBus.defineSchema(name, schema) → compiler uses this for $.trigger validation
//   eventBus.registerMapper(mapper)     → translate raw webhooks to events
//   eventBus.mapRequest(req)            → WebhookMapper lookup (used by TriggerRouter)
//   eventBus.getSchema(name)            → JSONSchema | undefined
//   eventBus.subscribers(name?)         → SubscriberMap
// ─────────────────────────────────────────────

export interface EmitResult {
  eventName:    string
  subscribers:  number
  executionIds: string[]
}

export type SubscriberMap = Record<string, Array<{ flowId: string; version: string }>>

// Maps an inbound HTTP request to an event name + payload.
// Registered by integrations (Stripe, GitHub, etc.) or user config.
export interface WebhookMapper {
  // The HTTP path this mapper claims — e.g. "/webhooks/stripe"
  path: string
  // Given the raw request body, return the event name + payload.
  // Return null to decline (e.g. unrecognized event type).
  map(body: unknown, headers: Record<string, string>): { name: string; payload: unknown } | null
}

export interface IEventBus {
  subscribe(eventName: string, flowId: string, version: string): void
  unsubscribe(flowId: string): void
  emit(eventName: string, payload: unknown): Promise<EmitResult>
  defineSchema(eventName: string, schema: JSONSchema): void
  registerMapper(mapper: WebhookMapper): void
  mapRequest(path: string, body: unknown, headers: Record<string, string>): { name: string; payload: unknown } | null
  getSchema(eventName: string): JSONSchema | undefined
  subscribers(eventName?: string): SubscriberMap
}

// ─────────────────────────────────────────────
// EVENT BUS IMPLEMENTATION
// ─────────────────────────────────────────────

export class EventBus implements IEventBus {
  // eventName → [{ flowId, version }]
  private readonly subs    = new Map<string, Array<{ flowId: string; version: string }>>()
  // eventName → JSONSchema — fed to compiler for $.trigger validation
  private readonly schemas = new Map<string, JSONSchema>()
  // HTTP path → WebhookMapper
  private readonly mappers = new Map<string, WebhookMapper>()

  constructor(private readonly queue: IExecutionQueue) {}

  // ─── SUBSCRIPTIONS ───────────────────────────

  subscribe(eventName: string, flowId: string, version: string): void {
    if (!this.subs.has(eventName)) this.subs.set(eventName, [])
    const list = this.subs.get(eventName)!

    // Replace existing subscription for this flow (hot reload)
    const idx = list.findIndex(s => s.flowId === flowId)
    if (idx >= 0) list[idx] = { flowId, version }
    else           list.push({ flowId, version })
  }

  unsubscribe(flowId: string): void {
    for (const [name, list] of this.subs) {
      const filtered = list.filter(s => s.flowId !== flowId)
      if (filtered.length === 0) this.subs.delete(name)
      else                       this.subs.set(name, filtered)
    }
  }

  // ─── EMIT ────────────────────────────────────

  async emit(eventName: string, payload: unknown): Promise<EmitResult> {
    const list = this.subs.get(eventName) ?? []
    const executionIds: string[] = []

    await Promise.all(list.map(async ({ flowId, version }) => {
      const executionId = generateId()
      executionIds.push(executionId)

      const job: ExecutionJob = {
        executionId,
        flowId,
        version,
        trigger: { event: eventName, payload, emittedAt: Date.now() },
      }

      try {
        await this.queue.enqueue(job)
      } catch {
        // Queue full — log but don't blow up other subscribers
        // In production: dead-letter queue or metric counter here
      }
    }))

    return { eventName, subscribers: list.length, executionIds }
  }

  // ─── SCHEMA ──────────────────────────────────

  defineSchema(eventName: string, schema: JSONSchema): void {
    this.schemas.set(eventName, schema)
  }

  getSchema(eventName: string): JSONSchema | undefined {
    return this.schemas.get(eventName)
  }

  // ─── WEBHOOK MAPPING ─────────────────────────

  registerMapper(mapper: WebhookMapper): void {
    this.mappers.set(mapper.path, mapper)
  }

  mapRequest(
    path:    string,
    body:    unknown,
    headers: Record<string, string>,
  ): { name: string; payload: unknown } | null {
    const mapper = this.mappers.get(path)
    if (!mapper) return null
    return mapper.map(body, headers)
  }

  // ─── INSPECTION ──────────────────────────────

  subscribers(eventName?: string): SubscriberMap {
    if (eventName) {
      const list = this.subs.get(eventName)
      return list ? { [eventName]: list } : {}
    }
    const result: SubscriberMap = {}
    for (const [name, list] of this.subs) {
      result[name] = [...list]
    }
    return result
  }
}

// ─────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────

function generateId(): string {
  return `exec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}
