// ─────────────────────────────────────────────
// TRIGGER REGISTRY
// Single source of truth for every active trigger across all flows.
// All trigger types (webhook, cron, event, manual) are tracked here.
//
// Why this exists:
//   When a flow is updated or deleted, all its triggers must be torn down
//   atomically before the new ones are registered. Without a registry,
//   you'd have to clean up in three separate places and hope nothing leaked.
//
// Surface API:
//   registry.register(entry)           → add or replace trigger
//   registry.deregisterFlow(flowId)    → remove all triggers for a flow
//   registry.getByFlow(flowId)         → all entries for a flow
//   registry.getWebhook(path)          → O(1) path → entry lookup
//   registry.getCron(flowId)           → cron entries for a flow
//   registry.all()                     → full registry snapshot (admin)
// ─────────────────────────────────────────────

export type TriggerKind = "webhook" | "cron" | "event" | "manual"

interface BaseTrigger {
  flowId:      string
  version:     string
  nodeId:      string    // which trigger node in the flow
  registeredAt: number
}

export interface WebhookTrigger extends BaseTrigger {
  kind: "webhook"
  path: string           // e.g. "/hooks/payments"
}

export interface CronTrigger extends BaseTrigger {
  kind:       "cron"
  expression: string     // e.g. "0 * * * *"
  jitterMs:   number     // applied offset — stored for observability
}

export interface EventTrigger extends BaseTrigger {
  kind:      "event"
  eventName: string      // e.g. "user.created"
}

export interface ManualTrigger extends BaseTrigger {
  kind: "manual"
}

export type TriggerEntry = WebhookTrigger | CronTrigger | EventTrigger | ManualTrigger

export class TriggerRegistry {
  // All entries indexed by a composite key: `${flowId}:${nodeId}`
  private readonly entries = new Map<string, TriggerEntry>()

  // O(1) secondary index for webhook path → entry
  private readonly webhookIndex = new Map<string, WebhookTrigger>()

  private key(flowId: string, nodeId: string) {
    return `${flowId}:${nodeId}`
  }

  // ─── WRITE ───────────────────────────────────

  register(entry: TriggerEntry): void {
    const k = this.key(entry.flowId, entry.nodeId)

    // Clean up old webhook index entry if this node was previously a webhook
    const existing = this.entries.get(k)
    if (existing?.kind === "webhook") {
      this.webhookIndex.delete(existing.path)
    }

    this.entries.set(k, entry)

    if (entry.kind === "webhook") {
      this.webhookIndex.set(entry.path, entry)
    }
  }

  // Remove all triggers for a flow — call before re-registering on hot reload
  deregisterFlow(flowId: string): TriggerEntry[] {
    const removed: TriggerEntry[] = []

    for (const [key, entry] of this.entries) {
      if (entry.flowId === flowId) {
        this.entries.delete(key)
        if (entry.kind === "webhook") this.webhookIndex.delete(entry.path)
        removed.push(entry)
      }
    }

    return removed
  }

  // ─── READ ────────────────────────────────────

  // O(1) — used by TriggerRouter on every inbound webhook
  getWebhook(path: string): WebhookTrigger | undefined {
    return this.webhookIndex.get(path)
  }

  getByFlow(flowId: string): TriggerEntry[] {
    return [...this.entries.values()].filter(e => e.flowId === flowId)
  }

  getCron(flowId: string): CronTrigger[] {
    return this.getByFlow(flowId).filter((e): e is CronTrigger => e.kind === "cron")
  }

  getEvent(flowId: string): EventTrigger[] {
    return this.getByFlow(flowId).filter((e): e is EventTrigger => e.kind === "event")
  }

  // Full snapshot — used by admin /triggers endpoint
  all(): TriggerEntry[] {
    return [...this.entries.values()]
  }

  size(): number {
    return this.entries.size
  }
}
