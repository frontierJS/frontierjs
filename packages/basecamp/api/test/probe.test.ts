/*
 * probe.test.ts — is a URL up, and when does a failure become an outage.
 *
 * Nothing in Basecamp probed a URL (`FJS-1557`). The two judgments the sweep
 * makes are pure and are graded here at chosen status codes and streaks; the
 * sweep itself, against a real client and a real listener, is
 * `monitor-sweep.test.ts`.
 */

import { test, expect, describe } from 'bun:test'
import { gradeProbe, nextState, parseStatusRanges, type StateSubject } from '../src/core/probe.ts'

const NOW = Date.parse('2026-10-14T12:00:00.000Z')

describe('accepted status', () => {
  test('ranges and single codes, inclusive at both ends', () => {
    expect(parseStatusRanges('200-299,301')).toEqual([[200, 299], [301, 301]])
    const m = { acceptedStatus: '200-299,301', invert: false }
    expect(gradeProbe(m, { statusCode: 299 }).ok).toBe(true)
    expect(gradeProbe(m, { statusCode: 301 }).ok).toBe(true)
    expect(gradeProbe(m, { statusCode: 300 }).ok).toBe(false)
    expect(gradeProbe(m, { statusCode: 502 }).message).toBe('Request failed with status code 502')
  })

  test('a list that is not one fails the check and says so, inverted or not', () => {
    for (const bad of ['', 'ok', '299-200', '200-'])
      expect(parseStatusRanges(bad)).toBeNull()
    // Inverting a broken config would make the monitor pass.
    const g = gradeProbe({ acceptedStatus: 'ok', invert: true }, { statusCode: 200 })
    expect(g.ok).toBe(false)
    expect(g.message).toContain('is not a list')
  })

  test('a request that never got a status is a failure carrying its reason', () => {
    const g = gradeProbe({ acceptedStatus: '200-299', invert: false }, { error: 'connect ECONNREFUSED' })
    expect(g).toEqual({ ok: false, message: 'connect ECONNREFUSED' })
  })
})

describe('upside-down', () => {
  const m = { acceptedStatus: '200-299', invert: true }

  test('an answer that would pass is the failure', () => {
    expect(gradeProbe(m, { statusCode: 200 }).ok).toBe(false)
  })

  test('…and one that would fail, a network error included, is the pass', () => {
    expect(gradeProbe(m, { statusCode: 503 }).ok).toBe(true)
    expect(gradeProbe(m, { error: 'timeout' }).ok).toBe(true)
  })
})

describe('the state machine', () => {
  const base: StateSubject = {
    status: 'up', failStreak: 0, retries: 2,
    intervalSec: 120, retryIntervalSec: 30, resendEvery: 0,
  }

  test('failures inside the retries change nothing but the clock', () => {
    const one = nextState(base, false, NOW)
    expect(one).toEqual({ status: 'up', failStreak: 1, nextCheckAt: NOW + 30_000, move: null, page: null })
    const two = nextState({ ...base, failStreak: 1 }, false, NOW)
    expect(two.status).toBe('up')
    expect(two.page).toBeNull()
  })

  test('the failure past the retries is the outage, and pages once', () => {
    // retries: 2 is two RETRIES, so the third failure in a row is the one.
    const down = nextState({ ...base, failStreak: 2 }, false, NOW)
    expect(down).toEqual({ status: 'down', failStreak: 3, nextCheckAt: NOW + 120_000, move: 'markDown', page: 'down' })
    const still = nextState({ ...base, status: 'down', failStreak: 3 }, false, NOW)
    expect(still.move).toBeNull()
    expect(still.page).toBeNull()
  })

  test('retries: 0 goes down on the first failure', () => {
    expect(nextState({ ...base, retries: 0 }, false, NOW).page).toBe('down')
  })

  test('a pass resets the streak, and only down → up pages', () => {
    const blip = nextState({ ...base, failStreak: 2 }, true, NOW)
    expect(blip).toEqual({ status: 'up', failStreak: 0, nextCheckAt: NOW + 120_000, move: null, page: null })

    const back = nextState({ ...base, status: 'down', failStreak: 5 }, true, NOW)
    expect(back.move).toBe('markUp')
    expect(back.page).toBe('up')
  })

  test('a new monitor that passes is up without a recovery notice', () => {
    const first = nextState({ ...base, status: 'pending' }, true, NOW)
    expect(first.move).toBe('markUp')
    expect(first.page).toBeNull()
  })

  test('a new monitor that fails waits out its retries, then pages down', () => {
    const pending = { ...base, status: 'pending' as const }
    expect(nextState(pending, false, NOW).page).toBeNull()
    const down = nextState({ ...pending, failStreak: 2 }, false, NOW)
    expect(down.move).toBe('markDown')
    expect(down.page).toBe('down')
  })

  test('resendEvery re-pages while down, counted from the page', () => {
    const down = { ...base, status: 'down' as const, resendEvery: 3 }
    // streak 3 paged; 4 and 5 are the two checks after it, 6 is the third.
    const pages = [4, 5, 6, 7, 8, 9].map(s => nextState({ ...down, failStreak: s - 1 }, false, NOW).page)
    expect(pages).toEqual([null, null, 'resend', null, null, 'resend'])
  })
})
