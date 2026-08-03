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

import type { BreakerState, ConduitErrorKind, ResilienceOptions } from './types.ts'

const DEFAULT_FAILURE_THRESHOLD = 5
const DEFAULT_RESET_MS          = 30_000

// Failures that implicate the *target*. A credential that will not resolve,
// a body that will not serialise, a typo'd method or an unknown target are
// all local bugs — counting them would open a breaker that no amount of
// waiting can heal, and hide the actual error behind circuit_open.
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
}

export type Admission =
  | { ok: true }
  | { ok: false; kind: 'circuit_open' | 'overloaded'; message: string }

export class Resilience {
  private states = new Map<string, TargetState>()

  private readonly threshold: number
  private readonly resetMs:   number
  private readonly maxConcurrent?: number

  constructor(opts: ResilienceOptions = {}) {
    this.threshold      = opts.failure_threshold ?? DEFAULT_FAILURE_THRESHOLD
    this.resetMs        = opts.reset_ms ?? DEFAULT_RESET_MS
    this.maxConcurrent  = opts.max_concurrent
  }

  /**
   * Decide whether a request may be dispatched, and reserve a slot if so.
   * Every `{ ok: true }` must be paired with exactly one release().
   */
  admit(target: string): Admission {
    const s = this.state(target)

    if (this.threshold > 0 && s.openedAt !== null) {
      const elapsed = Date.now() - s.openedAt

      if (elapsed < this.resetMs) {
        return {
          ok: false,
          kind: 'circuit_open',
          message: `Circuit open for '${target}' after ${s.failures} consecutive failures; ` +
                   `retrying in ${Math.ceil((this.resetMs - elapsed) / 1000)}s`,
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

    if (this.maxConcurrent !== undefined && s.inFlight >= this.maxConcurrent) {
      // Undo the trial reservation — this request is not going out, so it
      // cannot be the probe.
      if (s.halfOpen && s.openedAt !== null) s.halfOpen = false
      return {
        ok: false,
        kind: 'overloaded',
        message: `Target '${target}' is at its concurrency cap of ${this.maxConcurrent}`,
      }
    }

    s.inFlight++
    return { ok: true }
  }

  /** Report the outcome of an admitted request and free its slot. */
  release(target: string, outcome: 'success' | 'target_fault' | 'other'): void {
    const s = this.state(target)
    s.inFlight = Math.max(0, s.inFlight - 1)

    if (this.threshold <= 0) return

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

    if (s.failures >= this.threshold) s.openedAt = Date.now()
  }

  /** Drop a target's state — on deregister, so a re-registered target starts clean. */
  forget(target: string): void {
    this.states.delete(target)
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
    return Date.now() - s.openedAt >= this.resetMs ? 'half_open' : 'open'
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
