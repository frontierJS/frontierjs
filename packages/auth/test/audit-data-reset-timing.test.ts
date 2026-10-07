// AUDIT 1.1 (2026-10-05), FJS-1832.
//
// `login()` pays a bcrypt on every refusal so that a stopwatch cannot tell a
// registered address from an unknown one (FJS-063, `payPasswordCost`).
// `requestPasswordReset()` answers the same either way, so it must also answer
// in the same TIME: a known address that awaited a deleteMany, a create and
// `onPasswordResetRequested` — in any real app a mail send — was readable off
// the clock. Both branches now return before the lookup.
//
// Same measure as test/flows.test.ts's FJS-063 test: the MIN of several runs,
// and a loose band — before a fix the ratio is far from 1.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, type Harness } from './harness.ts'

const floorOf = async (fn: () => Promise<unknown>, runs = 7) => {
  let min = Infinity
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    await fn().catch(() => {})
    min = Math.min(min, performance.now() - t0)
  }
  return min
}

describe('requestPasswordReset on the clock', () => {
  let mail: Harness
  let quiet: Harness
  beforeAll(async () => {
    // A mail client that takes 20ms — a fast one. SMTP and HTTP mail APIs are
    // typically 100ms+.
    mail  = await makeAuth({ onPasswordResetRequested: async () => { await Bun.sleep(20) } })
    quiet = await makeAuth({ onPasswordResetRequested: async () => {} })
  })
  afterAll(() => { mail.cleanup(); quiet.cleanup() })

  test('with a mail callback: an unknown address answers in the time a known one does', async () => {
    await mail.auth.createUser({ email: 'known@example.test', password: 'pw-1' })
    const known   = await floorOf(() => mail.auth.requestPasswordReset!('known@example.test'))
    const unknown = await floorOf(() => mail.auth.requestPasswordReset!('ghost@example.test'))
    console.log(`[audit] reset-request floor with 20ms mail: known=${known.toFixed(2)}ms unknown=${unknown.toFixed(2)}ms ratio=${(unknown / known).toFixed(3)}`)
    expect(unknown).toBeGreaterThan(known * 0.5)
  })

  test('with a no-op callback: the two database writes alone are still readable', async () => {
    await quiet.auth.createUser({ email: 'known2@example.test', password: 'pw-1' })
    const known   = await floorOf(() => quiet.auth.requestPasswordReset!('known2@example.test'), 15)
    const unknown = await floorOf(() => quiet.auth.requestPasswordReset!('ghost2@example.test'), 15)
    console.log(`[audit] reset-request floor with no-op mail: known=${known.toFixed(3)}ms unknown=${unknown.toFixed(3)}ms ratio=${(unknown / known).toFixed(3)}`)
    expect(unknown).toBeGreaterThan(known * 0.5)
  })
})
