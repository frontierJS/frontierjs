// scheduler/index.ts
// Scheduler — cron expressions + human-readable intervals.
// Total.js cron parser logic, modernized and typed.
// Bun's native timers — no external dep.

import { parseTtl } from '../config/index.ts'

// ─── Types ────────────────────────────────────────────────────────────────

export type JobFn    = () => Promise<void> | void

export interface JobHandle {
  id:     string
  stop:   () => void
  start:  () => void
  pause:  () => void
  resume: () => void
}

export interface SchedulerStats {
  total:    number
  running:  number
  paused:   number
  executions: number
  errors:   number
}

// ─── Cron parser ──────────────────────────────────────────────────────────
// '*/15 * * * *' — minute, hour, day-of-month, month, day-of-week
// Supports: * (any), */n (every n), a-b (between), a,b (in)

type CronField =
  | { type: 'any' }
  | { type: 'every'; step: number }
  | { type: 'in';    values: number[] }
  | { type: 'between'; min: number; max: number }
  | { type: 'equal'; value: number }

const DAYS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
}

function parseCronField(part: string): CronField {
  if (part === '*') return { type: 'any' }

  if (part.includes('/')) {
    const [, step] = part.split('/')
    return { type: 'every', step: parseInt(step, 10) }
  }

  if (part.includes(',')) {
    const values = part.split(',').map(v => parseInt(v, 10))
    return { type: 'in', values }
  }

  if (part.includes('-')) {
    const [min, max] = part.split('-').map(v => parseInt(v, 10))
    return { type: 'between', min, max }
  }

  return { type: 'equal', value: parseInt(part, 10) }
}

function matchCronField(field: CronField, value: number): boolean {
  switch (field.type) {
    case 'any':     return true
    case 'equal':   return field.value === value
    case 'in':      return field.values.includes(value)
    case 'between': return value >= field.min && value <= field.max
    case 'every':   return value % field.step === 0
  }
}

function parseCron(expr: string): (date: Date) => boolean {

  // Normalize day names
  const normalized = expr.toLowerCase().replace(
    /\b(sun|mon|tue|wed|thu|fri|sat)\b/g,
    d => String(DAYS[d] ?? d)
  )

  const parts = normalized.trim().split(/\s+/)
  if (parts.length !== 5)
    throw new Error(`Invalid cron expression: "${expr}" — expected 5 fields`)

  const [mField, hField, dField, MField, wField] = parts.map(parseCronField)

  return function matchCron(date: Date): boolean {
    return (
      matchCronField(mField, date.getMinutes())  &&
      matchCronField(hField, date.getHours())    &&
      matchCronField(dField, date.getDate())     &&
      matchCronField(MField, date.getMonth() + 1) &&
      matchCronField(wField, date.getDay())
    )
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────

export function createScheduler() {

  const jobs   = new Map<string, ScheduledJob>()
  const stats: SchedulerStats = { total: 0, running: 0, paused: 0, executions: 0, errors: 0 }
  let   nextId = 0

  // Cron driver — ticks every minute, checks all cron jobs.
  // Both the minute-alignment timeout AND the interval are tracked so
  // destroy() can cancel them (previously the align timer was discarded:
  // destroying the scheduler before the minute boundary still started a
  // fresh 60s interval afterwards). The driver also stops itself when the
  // last cron job is removed instead of ticking forever.
  let cronTimer:  ReturnType<typeof setInterval> | null = null
  let alignTimer: ReturnType<typeof setTimeout>  | null = null
  let destroyed = false

  function hasCronJobs(): boolean {
    for (const job of jobs.values()) {
      if (job.type === 'cron') return true
    }
    return false
  }

  function stopCronDriver(): void {
    if (alignTimer) { clearTimeout(alignTimer); alignTimer = null }
    if (cronTimer)  { clearInterval(cronTimer); cronTimer = null }
  }

  function ensureCronDriver(): void {
    if (cronTimer || alignTimer || destroyed) return

    // Align to next minute boundary
    const now     = Date.now()
    const msUntil = 60_000 - (now % 60_000)

    const startCron = () => {
      alignTimer = null
      if (destroyed || !hasCronJobs()) return
      cronTimer = setInterval(() => {
        const date = new Date()
        for (const job of jobs.values()) {
          if (job.type === 'cron' && job.running && !job.paused && job.cronMatch?.(date)) {
            job.execute()
          }
        }
      }, 60_000)
      if (cronTimer.unref) cronTimer.unref()
    }

    // First tick aligned to minute, then every 60s
    alignTimer = setTimeout(startCron, msUntil)
    if (alignTimer.unref) alignTimer.unref()
  }

  function createHandle(id: string): JobHandle {
    return {
      id,
      stop()   { removeJob(id) },
      start()  { const job = jobs.get(id); if (job) job.running = true  },
      pause()  { const job = jobs.get(id); if (job && !job.paused) { job.paused = true;  stats.paused++; stats.running-- } },
      resume() { const job = jobs.get(id); if (job &&  job.paused) { job.paused = false; stats.paused--; stats.running++ } },
    }
  }

  function removeJob(id: string): void {
    const job = jobs.get(id)
    if (!job) return
    job.running = false
    if (job.timer) { clearInterval(job.timer); clearTimeout(job.timer) }
    jobs.delete(id)
    stats.total--
    if (job.paused) stats.paused--
    else stats.running--

    // Last cron job gone → stop the minute driver instead of letting it
    // tick an empty set forever.
    if (job.type === 'cron' && !hasCronJobs()) stopCronDriver()
  }

  return {

    // ── every('5 minutes', fn) ─────────────────────────────────
    // Human-readable interval: '5 minutes', '30s', '1 hour'

    every(interval: string, fn: JobFn): JobHandle {
      const ms = parseTtl(interval)
      const id  = `job_${++nextId}`

      const job: ScheduledJob = {
        id,
        type:    'interval',
        fn,
        running: true,
        paused:  false,
        timer:   null,
        async execute() {
          if (!job.running || job.paused) return
          stats.executions++
          try {
            await fn()
          } catch (err) {
            stats.errors++
            console.error(`[Scheduler] Error in job "${id}":`, err)
          }
        }
      }

      job.timer = setInterval(() => job.execute(), ms)
      if ((job.timer as ReturnType<typeof setInterval>).unref)
        (job.timer as ReturnType<typeof setInterval>).unref()

      jobs.set(id, job)
      stats.total++
      stats.running++

      return createHandle(id)
    },

    // ── cron('0 2 * * *', fn) ──────────────────────────────────
    // Standard 5-field cron expression.

    cron(expr: string, fn: JobFn): JobHandle {
      const id       = `job_${++nextId}`
      const cronMatch = parseCron(expr)

      const job: ScheduledJob = {
        id,
        type:    'cron',
        fn,
        running: true,
        paused:  false,
        timer:   null,
        cronMatch,
        async execute() {
          if (!job.running || job.paused) return
          stats.executions++
          try {
            await fn()
          } catch (err) {
            stats.errors++
            console.error(`[Scheduler] Error in cron "${id}" (${expr}):`, err)
          }
        }
      }

      jobs.set(id, job)
      stats.total++
      stats.running++

      ensureCronDriver()

      return createHandle(id)
    },

    // ── once(delay, fn) ────────────────────────────────────────
    // Run once after a delay.

    once(delay: string | number, fn: JobFn): JobHandle {
      const ms = typeof delay === 'number' ? delay : parseTtl(delay)
      const id  = `job_${++nextId}`

      const job: ScheduledJob = {
        id,
        type:    'once',
        fn,
        running: true,
        paused:  false,
        timer:   null,
        async execute() {
          stats.executions++
          try { await fn() } catch (err) { stats.errors++; console.error(`[Scheduler] Error in once "${id}":`, err) }
          removeJob(id)
        }
      }

      job.timer = setTimeout(() => job.execute(), ms)
      // Consistent with every() and the cron driver: a pending one-shot
      // job must not hold the process open by itself.
      if ((job.timer as { unref?: () => void }).unref) {
        (job.timer as unknown as { unref: () => void }).unref()
      }

      jobs.set(id, job)
      stats.total++
      stats.running++

      return createHandle(id)
    },

    stats(): SchedulerStats {
      return { ...stats }
    },

    list(): string[] {
      return Array.from(jobs.keys())
    },

    destroy(): void {
      destroyed = true
      for (const id of jobs.keys()) removeJob(id)
      stopCronDriver()
    }
  }
}

// ─── Internal job structure ───────────────────────────────────────────────

interface ScheduledJob {
  id:        string
  type:      'interval' | 'cron' | 'once'
  fn:        JobFn
  running:   boolean
  paused:    boolean
  timer:     ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null
  cronMatch?: (date: Date) => boolean
  execute:   () => Promise<void>
}
