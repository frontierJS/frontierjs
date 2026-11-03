// src/domain/monitor/probe.ts — is this URL up, and what does the answer do to the monitor.
//
// Pure: no database, no clock, no fetch. `jobs/monitor-sweep.job.ts` makes the
// request and writes the rows; the two judgments live here so a test can stand
// at a chosen status code and streak (`domain/alert/alerting.ts` and
// `domain/host/reachability.ts` are the same split).
//
// ─── Two judgments, and they are separate ────────────────────────────────
//
// `gradeProbe` answers whether ONE request counted as a success. `nextState`
// answers what that does to the monitor, and a failure is not yet an outage:
// the monitor goes `down` only after `retries` failures in a row, and while it
// is retrying the next check comes at `retryIntervalSeconds`. A single 502 behind a
// load balancer is a blip; paging on it is what makes a pager ignored.

export interface ProbeSubject {
  acceptedStatus: string
  isInverted:     boolean
}

/** What the request produced: a status code, or the reason it never got one. */
export type ProbeOutcome =
  | { statusCode: number; error?: undefined }
  | { error: string;      statusCode?: undefined }

export interface ProbeGrade {
  ok:      boolean
  message: string
}

/**
 * `200-299,301` as inclusive ranges, or null where the text is not one.
 *
 * Null rather than a throw: a monitor row with an unreadable list must come out
 * of the grader as a FAILED check that says why, not abort the sweep over
 * every monitor after it.
 */
export function parseStatusRanges(text: string): Array<[number, number]> | null {
  const ranges: Array<[number, number]> = []
  for (const part of text.split(',')) {
    const m = /^\s*(\d{3})(?:\s*-\s*(\d{3}))?\s*$/.exec(part)
    if (!m) return null
    const lo = Number(m[1])
    const hi = m[2] === undefined ? lo : Number(m[2])
    if (hi < lo) return null
    ranges.push([lo, hi])
  }
  return ranges.length ? ranges : null
}

/**
 * The one owner of *is this a failure*.
 *
 * `isInverted` flips the verdict for a monitor whose healthy state is an error —
 * a URL that must NOT answer. It flips a network error as well as a status,
 * which is the case it exists for.
 */
export function gradeProbe(subject: ProbeSubject, outcome: ProbeOutcome): ProbeGrade {
  const ranges = parseStatusRanges(subject.acceptedStatus)
  if (!ranges)
    // Inverting a config error would turn a broken monitor into a passing one.
    return { ok: false, message: `Accepted status '${subject.acceptedStatus}' is not a list of codes or ranges` }

  let ok: boolean
  let message: string

  if (outcome.error !== undefined) {
    ok      = false
    message = outcome.error
  } else {
    const code = outcome.statusCode
    ok      = ranges.some(([lo, hi]) => code >= lo && code <= hi)
    message = ok ? `${code} - ${STATUS_TEXT[code] ?? 'OK'}` : `Request failed with status code ${code}`
  }

  if (!subject.isInverted) return { ok, message }
  return { ok: !ok, message: ok ? `${message} (expected a failure)` : `${message} (inverted)` }
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
}

// ─── The state machine ───────────────────────────────────────────────────

export type MonitorStatus = 'pending' | 'up' | 'down' | 'paused'

export interface StateSubject {
  status:           MonitorStatus
  failStreak:       number
  retries:          number
  intervalSeconds:      number
  retryIntervalSeconds: number
  resendEvery:      number
}

/** What the sweep tells people, if anything. `resend` is a still-down reminder. */
export type Page = 'down' | 'up' | 'resend' | null

export interface NextState {
  status:      MonitorStatus
  failStreak:  number
  nextCheckAt: number
  /** The `@@transitions` move to make, or null where the status stays. */
  move:        'markUp' | 'markDown' | null
  page:        Page
}

/**
 * The monitor after one graded check at instant `at`.
 *
 * A first success from `pending` moves to `up` and pages nobody — a monitor
 * that has just been created is not a recovery. A first failure from `pending`
 * waits out its retries like any other, then pages `down`.
 */
export function nextState(m: StateSubject, ok: boolean, at: number): NextState {
  if (ok) {
    return {
      status:      'up',
      failStreak:  0,
      nextCheckAt: at + m.intervalSeconds * 1_000,
      move:        m.status === 'up' ? null : 'markUp',
      page:        m.status === 'down' ? 'up' : null,
    }
  }

  const failStreak = m.failStreak + 1
  if (failStreak <= m.retries) {
    return {
      status:      m.status,
      failStreak,
      nextCheckAt: at + m.retryIntervalSeconds * 1_000,
      move:        null,
      page:        null,
    }
  }

  const entering = m.status !== 'down'
  // Counted from the failure that crossed `retries`, so `resendEvery: 3` is the
  // 3rd check after the page and not the 3rd check since the monitor last passed.
  const sinceDown = failStreak - m.retries - 1
  const resend    = !entering && m.resendEvery > 0 && sinceDown % m.resendEvery === 0

  return {
    status:      'down',
    failStreak,
    nextCheckAt: at + m.intervalSeconds * 1_000,
    move:        entering ? 'markDown' : null,
    page:        entering ? 'down' : resend ? 'resend' : null,
  }
}

// ─── Certificate expiry ──────────────────────────────────────────────────

/** Days before expiry a warning goes out, widest first. Constants, not settings (`FJS-D1795`). */
export const CERT_WARN_DAYS = [14, 7, 3] as const

const DAY_MS = 86_400_000

export interface CertWarning {
  /** The threshold to warn of now, or null where none is owed. */
  warn:       number | null
  /** Whole days left, zero or less once expired. */
  daysLeft:   number
  /** What to store as `certWarnedDays`: the tightest threshold warned of, null when none is crossed. */
  warnedDays: number | null
}

/**
 * Which warning, if any, a certificate expiring at `expiresAt` is owed.
 *
 * One per threshold: `prior.warnedDays` is the tightest already sent for the
 * certificate in `prior.expiresAt`. A certificate first seen at 5 days warns
 * once as 7, not as 14 and 7 together. A different expiry is a renewed
 * certificate, so its warnings start over; without that a renewal would leave
 * next year's 14-day warning silenced by this year's.
 */
export function certWarning(
  expiresAt: number,
  prior:     { expiresAt: number | null; warnedDays: number | null },
  now:       number,
): CertWarning {
  const daysLeft = Math.floor((expiresAt - now) / DAY_MS)
  const crossed  = CERT_WARN_DAYS.filter(d => daysLeft <= d)
  if (!crossed.length) return { warn: null, daysLeft, warnedDays: null }

  const tightest = Math.min(...crossed)
  const renewed  = prior.expiresAt !== null && Math.abs(expiresAt - prior.expiresAt) > DAY_MS
  const warned   = renewed ? null : prior.warnedDays
  return warned !== null && warned <= tightest
    ? { warn: null,     daysLeft, warnedDays: warned }
    : { warn: tightest, daysLeft, warnedDays: tightest }
}
