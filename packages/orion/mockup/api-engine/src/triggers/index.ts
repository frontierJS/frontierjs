// ─────────────────────────────────────────────
// TRIGGERS
// Boot sequence, HTTP routing, cron scheduling, and trigger registry.
//
// Modules:
//   registry   — TriggerRegistry (central source of truth)
//   cron       — CronScheduler (drift-corrected, jittered)
//   router     — TriggerRouter (Bun HTTP handler)
//   activator  — WorkflowActivator (boot + hot reload)
// ─────────────────────────────────────────────

export type { TriggerKind, TriggerEntry, WebhookTrigger, CronTrigger, EventTrigger, ManualTrigger } from "./registry"
export type { ActivationResult, ICompiler }                                                         from "./activator"

export { TriggerRegistry }    from "./registry"
export { CronScheduler, parseCron, getNextCronMs, InvalidCronError } from "./cron"
export { TriggerRouter }      from "./router"
export { WorkflowActivator }  from "./activator"
