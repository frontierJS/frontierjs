import type { Flow } from "../types"
import type { CompilerResult } from "../compiler"
import type { IPlanCache } from "../runtime/store"
import type { IEventBus } from "../events"
import type { TriggerRegistry } from "./registry"
import type { CronScheduler } from "./cron"
import type { TriggerRouter } from "./router"

// ─────────────────────────────────────────────
// WORKFLOW ACTIVATOR
// Boot sequence + hot reload. Owns the lifecycle of compiled plans
// and trigger registrations across all active flows.
//
// Boot order:
//   1. Compile each flow            (skips failures, reports them)
//   2. Cache the execution plan     (compile-once, run-many)
//   3. Scan trigger nodes           (webhook / cron / event / manual)
//   4. Register each trigger type   (router / cron / eventBus / registry)
//
// Hot reload (flow updated):
//   1. Deregister all old triggers  (registry.deregisterFlow — atomic)
//   2. Cancel old cron schedules
//   3. Remove old event subscriptions
//   4. Invalidate plan cache
//   5. Re-run boot sequence for this flow only
//
// Surface API:
//   WorkflowActivator.activate(flows, compiler, plans, router, cron, eventBus, registry)
//   activator.reload(flow)          → ActivationResult for the single flow
//   activator.deactivate(flowId)    → tear down all triggers for a flow
// ─────────────────────────────────────────────

export interface ICompiler {
  compile(flow: Flow): CompilerResult
}

export interface ActivationResult {
  flowId:   string
  ok:       boolean
  triggers: number         // how many triggers were registered
  error?:   string         // set if compilation failed
}

export class WorkflowActivator {
  constructor(
    private readonly compiler: ICompiler,
    private readonly plans:    IPlanCache,
    private readonly router:   TriggerRouter,   // for webhook registration (registry access)
    private readonly cron:     CronScheduler,
    private readonly eventBus: IEventBus,
    private readonly registry: TriggerRegistry,
  ) {}

  // ─── BOOT ────────────────────────────────────

  // Activate a set of flows. Returns one result per flow.
  // Failed compilations are reported but do not block other flows.
  async activate(flows: Flow[]): Promise<ActivationResult[]> {
    return Promise.all(flows.map(flow => this.activateOne(flow)))
  }

  // ─── HOT RELOAD ──────────────────────────────

  // Safe to call while the server is running.
  // Tears down existing triggers before re-registering.
  async reload(flow: Flow): Promise<ActivationResult> {
    await this.deactivate(flow.id)
    return this.activateOne(flow)
  }

  // ─── DEACTIVATE ──────────────────────────────

  async deactivate(flowId: string): Promise<void> {
    // 1. Remove all triggers from registry (returns what was removed)
    const removed = this.registry.deregisterFlow(flowId)

    // 2. Cancel cron timers
    this.cron.deregister(flowId)

    // 3. Remove event subscriptions
    this.eventBus.unsubscribe(flowId)

    // 4. Invalidate plan cache
    this.plans.invalidate(flowId)
  }

  // ─── CORE ────────────────────────────────────

  private async activateOne(flow: Flow): Promise<ActivationResult> {
    // 1. Compile
    const result = this.compiler.compile(flow)
    if (!result.ok) {
      return {
        flowId:   flow.id,
        ok:       false,
        triggers: 0,
        error:    result.errors.map(e => e.message).join("; "),
      }
    }

    const { plan } = result

    // 2. Cache plan — compile-once, run-many
    this.plans.set(flow.id, flow.version, plan)

    // 3. Register each trigger node
    let triggerCount = 0
    const now = Date.now()

    for (const nodeId of plan.triggerIds) {
      const node = plan.nodes[nodeId]
      if (!node) continue

      const base = { flowId: flow.id, version: flow.version, nodeId, registeredAt: now }

      if (node.type === "trigger.webhook") {
        const path = resolveConfigLiteral(node.config["path"])
        if (typeof path === "string") {
          this.registry.register({ ...base, kind: "webhook", path })
          triggerCount++
        }
      }

      else if (node.type === "trigger.cron") {
        const expression = resolveConfigLiteral(node.config["expression"])
        if (typeof expression === "string") {
          const jitterMs = this.cron.register(flow.id, flow.version, nodeId, expression)
          this.registry.register({ ...base, kind: "cron", expression, jitterMs })
          triggerCount++
        }
      }

      else if (node.type === "trigger.event") {
        const eventName = resolveConfigLiteral(node.config["event"])
        if (typeof eventName === "string") {
          this.eventBus.subscribe(eventName, flow.id, flow.version)
          this.registry.register({ ...base, kind: "event", eventName })
          triggerCount++
        }
      }

      else if (node.type === "trigger.manual") {
        // Manual triggers need no external registration — always reachable via
        // POST /flows/:id/trigger as long as the flow is in the registry
        this.registry.register({ ...base, kind: "manual" })
        triggerCount++
      }
    }

    return { flowId: flow.id, ok: true, triggers: triggerCount }
  }
}

// ─────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────

// Trigger node configs are always literal expressions — they must be
// known at compile time. This extracts the raw value safely.
function resolveConfigLiteral(expr: unknown): unknown {
  if (expr && typeof expr === "object" && (expr as { type?: string }).type === "literal") {
    return (expr as { value: unknown }).value
  }
  return undefined
}
