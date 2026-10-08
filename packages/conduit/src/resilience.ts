// ============================================================
// Conduit — Per-target load shedding
//
// A circuit breaker and a concurrency gate, one pair per target.
//
// The point is not to make failing calls succeed — it is to stop a
// degraded provider from consuming your request handlers. Without this,
// an outage costs you retry_limit+1 attempts per call, each holding a
// handler for up to the full timeout, for as long as the outage lasts.
// ============================================================

import type { BreakerState, ConduitErrorKind, ResilienceOptions, TargetResilience } from './types.ts'

const DEFAULT_FAILURE_THRESHOLD = 5
const DEFAULT_RESET_MS          = 30_000

// In-flight sends per target. There was no default, and an unbounded burst does
// not go out unbounded — it QUEUES inside Bun's connection pool, and the
// per-attempt timer is already running while it waits, so the wait is charged
// to the target as a timeout. Measured: 5000 concurrent requests to a target
// that answered every one of them took 10s, returned 136 timeouts, took the
// process from 23 to 533 file descriptors, and opened the breaker. The same
// burst against a cap answers instantly, sheds the excess as `overloaded`, and
// leaves the breaker closed — which is the honest answer rather than a nicer
// one (`FJS-685`). 64 sits under a connection pool rather than above it, so the
// queue that produced those timeouts does not form.
const DEFAULT_MAX_CONCURRENT = 64

// Failures that implicate the *target*. A credential that will not resolve,
// a body that will not serialize, a typo'd method or an unknown target are
// all local bugs — counting them would open a breaker that no amount of
// waiting can heal, and hide the actual error behind circuit_open.
//
// `rate_limited` is deliberately NOT here, and it is the one absence worth
// stating: a 429 says the target is healthy and we are asking too fast. Counted
// as a fault it opened the breaker, after which every send failed `circuit_open`
// — load shed by the one status that means *slow down* (`FJS-650`). The answer to
// being paced is to wait the stated time, which the retry ladder now does.
const TARGET_FAULTS: ReadonlySet<ConduitErrorKind> = new Set([
  'connection_failed',
  'timeout',
  'server_error',
])

export function countsAsTargetFault(kind: ConduitErrorKind): boolean {
  return TARGET_FAULTS.has(kind)
}

type TargetState = {
  failures:  number
  openedAt:  number | null
  halfOpen:  boolean   // a trial request is in flight
  inFlight:  number
  // What this target declared, or undefined for one that declared nothing.
  // Kept beside the counts rather than resolved into them: a re-register may
  // change the resilience of a target that is already open, and a threshold copied
  // at first-touch would keep grading it by the old one.
  resilience?: TargetResilience
}

export type Admission =
  | { ok: true }
  | { ok: false; kind: 'circuit_open' | 'overloaded'; message: string }

export class Resilience {
  private states = new Map<string, TargetState>()

  private readonly threshold: number
  private readonly resetMs:   number
  private readonly maxConcurrent: number

  constructor(opts: ResilienceOptions = {}) {
    this.threshold      = opts.failure_threshold ?? DEFAULT_FAILURE_THRESHOLD
    this.resetMs        = opts.reset_ms ?? DEFAULT_RESET_MS
    this.maxConcurrent  = opts.max_concurrent ?? DEFAULT_MAX_CONCURRENT
  }

  /**
   * Record what a target declared. Called wherever a descriptor is read, so a
   * target registered on another replica is graded by its own numbers from the
   * first request this process resolves it for.
   *
   * Deliberately does not reset the counts: a resilience change is not a statement
   * about the target's health, and clearing the trip count on re-register would
   * make a heartbeat that re-registers a way to keep a broken target admitted.
   */
  setResilience(target: string, resilience: TargetResilience | undefined): void {
    this.state(target).resilience = resilience
  }

  /**
   * Decide whether a request may be dispatched, and reserve a slot if so.
   * Every `{ ok: true }` must be paired with exactly one release().
   */
  admit(target: string): Admission {
    const s = this.state(target)
    const threshold     = s.resilience?.failure_threshold ?? this.threshold
    const resetMs       = s.resilience?.reset_ms ?? this.resetMs
    const maxConcurrent = s.resilience?.max_concurrent ?? this.maxConcurrent

    if (threshold > 0 && s.openedAt !== null) {
      const elapsed = Date.now() - s.openedAt

      if (elapsed < resetMs) {
        return {
          ok: false,
          kind: 'circuit_open',
          message: `Circuit open for '${target}' after ${s.failures} consecutive failures; ` +
                   `retrying in ${Math.ceil((resetMs - elapsed) / 1000)}s`,
        }
      }

      // Reset window elapsed — admit exactly one trial request. Further
      // requests keep being shed until that trial reports back, so a
      // recovering target is probed, not stampeded.
      if (s.halfOpen) {
        return {
          ok: false,
          kind: 'circuit_open',
          message: `Circuit half-open for '${target}'; a trial request is already in flight`,
        }
      }
      s.halfOpen = true
    }

    if (s.inFlight >= maxConcurrent) {
      // Undo the trial reservation — this request is not going out, so it
      // cannot be the probe.
      if (s.halfOpen && s.openedAt !== null) s.halfOpen = false
      return {
        ok: false,
        kind: 'overloaded',
        message: `Target '${target}' is at its concurrency cap of ${maxConcurrent}`,
      }
    }

    s.inFlight++
    return { ok: true }
  }

  /**
   * A per-origin key of a request-addressed target is graded by that target's
   * resilience, learned under its id. Copied on every send, so re-registered
   * resilience reaches origins already seen.
   */
  inherit(key: string, target: string): void {
    this.state(key).resilience = this.states.get(target)?.resilience
  }

  /** The `timeout_ms` a target declared, or undefined for one that declared none. */
  declaredTimeout(target: string): number | undefined {
    return this.states.get(target)?.resilience?.timeout_ms
  }

  /** Report the outcome of an admitted request and free its slot. */
  release(target: string, outcome: 'success' | 'target_fault' | 'other'): void {
    const s = this.state(target)
    s.inFlight = Math.max(0, s.inFlight - 1)

    const threshold = s.resilience?.failure_threshold ?? this.threshold
    if (threshold <= 0) return

    if (outcome === 'success') {
      s.failures = 0
      s.openedAt = null
      s.halfOpen = false
      return
    }

    // A local fault leaves the breaker exactly as it was — it says nothing
    // about the target's health. But it must still clear a trial flag, or
    // the breaker would wedge half-open forever.
    if (outcome === 'other') {
      s.halfOpen = false
      return
    }

    s.failures++

    if (s.halfOpen) {
      // The probe failed — reopen for another full window rather than
      // letting the next request through immediately.
      s.openedAt = Date.now()
      s.halfOpen = false
      return
    }

    if (s.failures >= threshold) s.openedAt = Date.now()
  }

  /** Drop a target's state — on deregister, so a re-registered target starts clean. */
  forget(target: string): void {
    this.states.delete(target)
    // And every origin a request-addressed target kept a breaker for.
    for (const key of this.states.keys()) if (key.startsWith(`${target} `)) this.states.delete(key)
  }

  clear(): void {
    this.states.clear()
  }

  /**
   * Snapshot for stats(). Healthy, idle targets are omitted so the output
   * stays readable when everything is fine.
   */
  snapshot(): Record<string, {
    state: BreakerState; failures: number; opened_at: number | null; in_flight: number
  }> {
    const out: Record<string, {
      state: BreakerState; failures: number; opened_at: number | null; in_flight: number
    }> = {}

    for (const [target, s] of this.states) {
      const state = this.stateNameOf(s)
      if (state === 'closed' && s.failures === 0 && s.inFlight === 0) continue
      out[target] = {
        state,
        failures:  s.failures,
        opened_at: s.openedAt,
        in_flight: s.inFlight,
      }
    }
    return out
  }

  // ─── Private ────────────────────────────────────────────────

  private stateNameOf(s: TargetState): BreakerState {
    if (s.openedAt === null) return 'closed'
    return Date.now() - s.openedAt >= (s.resilience?.reset_ms ?? this.resetMs) ? 'half_open' : 'open'
  }

  private state(target: string): TargetState {
    let s = this.states.get(target)
    if (!s) {
      s = { failures: 0, openedAt: null, halfOpen: false, inFlight: 0 }
      this.states.set(target, s)
    }
    return s
  }
}
