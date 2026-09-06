// scheduler/index.ts
// Scheduler — cron expressions + human-readable intervals.
// Total.js cron parser logic, modernized and typed.
// Bun's native timers — no external dep.

import { parseTtl, parseTtlOrNull } from '../config/index.ts'

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
  /** Ticks that arrived while the previous run of the same job was still
   *  going, and were dropped rather than run beside it. Counted rather than
   *  silent: a job that never keeps up should be visible, and the number is
   *  the only thing that says so. */
  skipped:  number
}

// ─── Cron ─────────────────────────────────────────────────────────────────
//
// The grammar is `@frontierjs/toolbelt/cron` and is not restated here. It was:
// this file had a parser and caravan had another, and they were broken
// differently, so `0 1-5,8 * * *` named hours 1 and 8 to one and hours 1 to 5
// to the other, while `0 25 * * *` parsed for both and matched no minute for the
// life of the process (`FJS-767`). Neither consulted a bound and each took ONE
// operator per field.
//
// What is junction's is WHEN it looks and on which clock: this scheduler is
// in-process, has no persistence and no zone, so it reads the host clock. That
// is the half a grammar cannot answer, and it is why the kit takes clock parts
// rather than a Date.

import { parseCron as parseCronFields, cronMatches } from '@frontierjs/toolbelt/cron'

/**
 * The expression as a predicate over an instant on the HOST clock.
 *
 * Exported because the mapping is the only part of this that can be wrong now,
 * and it is the classic place to be wrong: `getMonth()` is 0-11 and cron's
 * month is 1-12. Nothing could ask the question before — the matcher lived in a
 * closure behind a timer that fires once a minute — so the only way to test a
 * schedule was to wait for it.
 */
export function cronMatcher(expr: string): (date: Date) => boolean {
  const fields = parseCronFields(expr)
  return function matchCron(date: Date): boolean {
    return cronMatches(fields, {
      minutes: date.getMinutes(),
      hours:   date.getHours(),
      date:    date.getDate(),
      month:   date.getMonth() + 1,
      day:     date.getDay(),
    })
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────

export function createScheduler() {

  const jobs   = new Map<string, ScheduledJob>()
  const stats: SchedulerStats = { total: 0, running: 0, paused: 0, executions: 0, errors: 0, skipped: 0 }

  /**
   * Run a recurring job's body, once at a time.
   *
   * `setInterval` fires on a clock and knows nothing about the body it started
   * last time, so a 100 ms interval with a 350 ms body ran FOUR of them at once
   * — measured. A scheduled job that overlaps itself is how one corrupts shared
   * state, and nothing anywhere reported that it had happened.
   *
   * A tick arriving while the previous run is still going is DROPPED rather
   * than queued. Queueing turns a job that cannot keep up into an unbounded
   * backlog, which fails later and further from the cause; dropping keeps the
   * cadence and loses a tick, and `stats.skipped` is what makes that visible
   * instead of silent.
   *
   * An app that genuinely wants concurrent runs dispatches them from inside the
   * body, where the fan-out is written down.
   */
  async function runOnce(job: ScheduledJob, label: string): Promise<void> {
    if (!job.running || job.paused) return
    if (job.inFlight) { stats.skipped++; return }
    job.inFlight = true
    stats.executions++
    try {
      await job.fn()
    } catch (err) {
      stats.errors++
      console.error(`[Scheduler] Error in ${label}:`, err)
    } finally {
      job.inFlight = false
    }
  }
  let   nextId = 0

  // Cron driver — ticks every minute, checks all cron jobs.
  // Both the minute-alignment timeout AND the interval are tracked so
  // destroy() can cancel them (previously the align timer was discarded:
  // destroying the scheduler before the minute boundary still started a
  // fresh 60s interval afterwards). The driver also stops itself when the
  // last cron job is removed instead of ticking forever.
  let cronTimer:  ReturnType<typeof setTimeout> | null = null
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
    if (cronTimer)  { clearTimeout(cronTimer);  cronTimer = null }
  }

  function ensureCronDriver(): void {
    if (cronTimer || alignTimer || destroyed) return

    // Align to next minute boundary
    const now     = Date.now()
    const msUntil = 60_000 - (now % 60_000)

    const startCron = () => {
      alignTimer = null
      if (destroyed || !hasCronJobs()) return
      // Re-aligned on every tick rather than a fixed 60s interval, which
      // accumulates drift: a tick that lands at :59.99 reads the minute BEFORE
      // the one it was meant to serve, so a schedule fires twice for one minute
      // or misses one entirely. The minute the job last ran for is remembered
      // as well, because re-aligning narrows that window and does not close it.
      const tick = () => {
        const date   = new Date()
        const minute = date.toISOString().slice(0, 16)
        for (const job of jobs.values()) {
          if (job.type !== 'cron' || !job.running || job.paused) continue
          if (job.lastMinute === minute) continue
          if (!job.cronMatch?.(date)) continue
          job.lastMinute = minute
          job.execute()
        }
        if (destroyed) return
        cronTimer = setTimeout(tick, 60_000 - (Date.now() % 60_000))
        if (cronTimer.unref) cronTimer.unref()
      }
      tick()
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
      // `every('0ms')` is a timer with no interval — a hot loop that starves
      // the event loop — and `every('nonsense')` took `parseTtl`'s 5-minute
      // fallback and became a job on a schedule nobody wrote. Neither is a
      // thing anyone means, so both are refused by name.
      const ms = parseTtlOrNull(interval)
      if (ms === null || !Number.isFinite(ms) || ms <= 0)
        throw new TypeError(
          `[Scheduler] every('${interval}') is not an interval` +
          `${ms === null ? '' : ` — it parsed to ${ms}`}. ` +
          `Write a positive duration: '30s', '5 minutes', '1 hour'.`)
      const id  = `job_${++nextId}`

      const job: ScheduledJob = {
        id,
        type:    'interval',
        expr:    interval,
        fn,
        running: true,
        paused:  false,
        timer:   null,
        async execute() { await runOnce(job, `job "${id}"`) }
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
      const cronMatch = cronMatcher(expr)

      const job: ScheduledJob = {
        id,
        type:    'cron',
        expr,
        fn,
        running: true,
        paused:  false,
        timer:   null,
        cronMatch,
        async execute() { await runOnce(job, `cron "${id}" (${expr})`) }
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
        expr:    String(delay),
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

    // ── describe ──────────────────────────────────────────────────────────────
    //
    // What this app runs on a clock IN PROCESS, as declared. `list()` answers
    // `job_1`, `job_2` — ids the app never chose and that say nothing about what
    // fires or when, so nothing could be asked what a deploy is about to start
    // doing on a timer.
    //
    // These are the timers with no persistence, no retry and no principal
    // (`FJS-D36`), which is exactly why they want a reader: a durable job leaves
    // a row behind and one of these leaves nothing at all. `paused` and
    // `running` are live state and are absent — this answers what was declared,
    // so two boots of the same code agree and the answer can be committed.
    //
    // A `once` job is included and marked: it is still something a deploy
    // starts, and a timer that fires one time is the easiest kind to forget.

    describe(): Array<{ id: string; type: 'interval' | 'cron' | 'once'; expr: string }> {
      return Array.from(jobs.values())
        .map(j => ({ id: j.id, type: j.type, expr: j.expr }))
        .sort((a, b) => a.expr.localeCompare(b.expr) || a.id.localeCompare(b.id))
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
  // The expression AS WRITTEN. `every()` parses it to milliseconds and `cron()`
  // compiles it to a matcher, so without this the only record of when a timer
  // fires is a closure — nothing could report what this app runs on a clock,
  // which is the half of `FJS-327` that is not Caravan's.
  expr:      string
  fn:        JobFn
  running:   boolean
  paused:    boolean
  timer:     ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null
  cronMatch?: (date: Date) => boolean
  /** A run of THIS job is in progress. A recurring job does not overlap
   *  itself — see `runOnce` for why skipping beats queueing. */
  inFlight?: boolean
  /** The minute this cron job last fired for, `YYYY-MM-DDTHH:mm`. The driver
   *  re-aligns to the minute boundary on every tick, and a tick that lands at
   *  :59.99 sees the minute it has already run. */
  lastMinute?: string
  execute:   () => Promise<void>
}
