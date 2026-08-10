import type { IExecutionQueue, ExecutionJob } from "../runtime/queue"

// ─────────────────────────────────────────────
// CRON EXPRESSION PARSER
// Standard 5-field cron: minute hour dom month dow
// Supported: *, n, */n, n-m, n,m,o (and combinations)
//
// Limitation: dom/dow interaction follows "both must match" semantics.
// Standard POSIX cron uses OR when both are restricted — this is
// intentionally simplified. Complex dom/dow expressions should use
// a dedicated library. Document this in the flow validator.
// ─────────────────────────────────────────────

interface CronFields {
  minute:     number[]   // 0–59
  hour:       number[]   // 0–23
  dayOfMonth: number[]   // 1–31
  month:      number[]   // 1–12
  dayOfWeek:  number[]   // 0–6 (0 = Sunday)
}

export class InvalidCronError extends Error {
  constructor(expression: string, reason: string) {
    super(`Invalid cron expression "${expression}": ${reason}`)
    this.name = "InvalidCronError"
  }
}

function parseField(field: string, min: number, max: number, expr: string): number[] {
  const values = new Set<number>()

  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i)
    } else if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2), 10)
      if (isNaN(step) || step < 1) throw new InvalidCronError(expr, `invalid step "${part}"`)
      for (let i = min; i <= max; i += step) values.add(i)
    } else if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number)
      if (isNaN(a!) || isNaN(b!) || a! > b!) throw new InvalidCronError(expr, `invalid range "${part}"`)
      for (let i = a!; i <= b!; i++) values.add(i)
    } else {
      const n = parseInt(part, 10)
      if (isNaN(n) || n < min || n > max) throw new InvalidCronError(expr, `value "${part}" out of range [${min}-${max}]`)
      values.add(n)
    }
  }

  return [...values].sort((a, b) => a - b)
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new InvalidCronError(expression, `expected 5 fields, got ${parts.length}`)
  }

  return {
    minute:     parseField(parts[0]!, 0, 59,  expression),
    hour:       parseField(parts[1]!, 0, 23,  expression),
    dayOfMonth: parseField(parts[2]!, 1, 31,  expression),
    month:      parseField(parts[3]!, 1, 12,  expression),
    dayOfWeek:  parseField(parts[4]!, 0, 6,   expression),
  }
}

// Returns ms until the next scheduled fire time (always > 0).
// Uses drift-corrected absolute time — not relative to last fire.
export function getNextCronMs(expression: string, from: Date = new Date()): number {
  const fields = parseCron(expression)

  // Start searching from next whole minute
  const next = new Date(from)
  next.setSeconds(0, 0)
  next.setMinutes(next.getMinutes() + 1)

  // Search up to 4 years — if nothing found, expression is pathological
  const limit = new Date(from.getTime() + 4 * 366 * 24 * 60 * 60 * 1000)

  while (next < limit) {
    // Month check (Date months are 0-indexed)
    if (!fields.month.includes(next.getMonth() + 1)) {
      next.setMonth(next.getMonth() + 1, 1)
      next.setHours(0, 0, 0, 0)
      continue
    }

    // Day checks
    const domOk = fields.dayOfMonth.includes(next.getDate())
    const dowOk = fields.dayOfWeek.includes(next.getDay())
    if (!domOk || !dowOk) {
      next.setDate(next.getDate() + 1)
      next.setHours(0, 0, 0, 0)
      continue
    }

    // Hour check
    if (!fields.hour.includes(next.getHours())) {
      const nextHour = fields.hour.find(h => h > next.getHours())
      if (nextHour !== undefined) {
        next.setHours(nextHour, fields.minute[0]!, 0, 0)
      } else {
        next.setDate(next.getDate() + 1)
        next.setHours(fields.hour[0]!, fields.minute[0]!, 0, 0)
      }
      continue
    }

    // Minute check
    if (!fields.minute.includes(next.getMinutes())) {
      const nextMin = fields.minute.find(m => m > next.getMinutes())
      if (nextMin !== undefined) {
        next.setMinutes(nextMin, 0, 0)
      } else {
        next.setHours(next.getHours() + 1, fields.minute[0]!, 0, 0)
      }
      continue
    }

    return next.getTime() - from.getTime()
  }

  throw new InvalidCronError(expression, "could not find a next execution time within 4 years")
}

// ─────────────────────────────────────────────
// CRON SCHEDULER
// Drift-corrected: each fire computes next run from actual current time,
// not from when the last job ran. setTimeout > setInterval for this reason.
//
// Jitter: random 0–JITTER_MAX_MS offset per trigger at registration.
// Prevents thundering-herd when many flows share the same cron expression.
//
// Distributed safety: NOT safe for multi-instance deployments.
// If multiple instances run, all will fire the same crons.
// Fix: distributed cron lock via Redis SET NX or a DB cron_locks table.
// TODO: implement when horizontal scaling is introduced.
//
// Surface API:
//   scheduler.register(flowId, version, nodeId, expression) → jitterMs
//   scheduler.deregister(flowId)
//   scheduler.deregisterNode(flowId, nodeId)
// ─────────────────────────────────────────────

const JITTER_MAX_MS = 2000   // max random offset added per trigger

interface CronHandle {
  flowId:     string
  version:    string
  nodeId:     string
  expression: string
  jitterMs:   number
  timerId:    ReturnType<typeof setTimeout> | null
}

export class CronScheduler {
  private readonly handles = new Map<string, CronHandle>()

  constructor(private readonly queue: IExecutionQueue) {}

  private key(flowId: string, nodeId: string) {
    return `${flowId}:${nodeId}`
  }

  // Returns the jitter applied — stored in TriggerRegistry for observability
  register(
    flowId:     string,
    version:    string,
    nodeId:     string,
    expression: string,
    jitterMs?:  number,   // override for tests
  ): number {
    const appliedJitter = jitterMs ?? Math.floor(Math.random() * JITTER_MAX_MS)
    const k = this.key(flowId, nodeId)

    // Cancel any existing timer for this slot
    this.cancelHandle(k)

    const handle: CronHandle = {
      flowId, version, nodeId, expression,
      jitterMs: appliedJitter,
      timerId:  null,
    }

    this.handles.set(k, handle)
    this.scheduleNext(handle, appliedJitter)

    return appliedJitter
  }

  deregister(flowId: string): void {
    for (const [k, handle] of this.handles) {
      if (handle.flowId === flowId) this.cancelHandle(k)
    }
  }

  deregisterNode(flowId: string, nodeId: string): void {
    this.cancelHandle(this.key(flowId, nodeId))
  }

  activeCount(): number {
    return this.handles.size
  }

  // ─── SCHEDULING LOOP ─────────────────────────

  private scheduleNext(handle: CronHandle, initialDelayOverride?: number): void {
    const delayMs = initialDelayOverride !== undefined
      ? getNextCronMs(handle.expression) + initialDelayOverride
      : getNextCronMs(handle.expression)   // drift-corrected: always from now

    handle.timerId = setTimeout(async () => {
      await this.fire(handle)
      // Re-schedule from actual fire time — not from when we called scheduleNext
      // This is what prevents drift
      this.scheduleNext(handle)
    }, delayMs)
  }

  private async fire(handle: CronHandle): Promise<void> {
    const job: ExecutionJob = {
      executionId: generateId(),
      flowId:      handle.flowId,
      version:     handle.version,
      trigger:     { cron: handle.expression, firedAt: Date.now() },
    }

    try {
      await this.queue.enqueue(job)
    } catch {
      // Queue full — cron fires are skipped, not retried
      // In production: metric counter + alert here
    }
  }

  private cancelHandle(key: string): void {
    const handle = this.handles.get(key)
    if (handle) {
      if (handle.timerId !== null) clearTimeout(handle.timerId)
      this.handles.delete(key)
    }
  }
}

// ─────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────

function generateId(): string {
  return `exec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}
