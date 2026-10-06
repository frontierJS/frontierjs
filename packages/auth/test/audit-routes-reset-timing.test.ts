// test/audit-routes-reset-timing.test.ts
//
// Audit 2026-10-05: POST /auth/password-reset/request answers `{ ok: true }`
// for a known and an unknown address alike, and the clock is the remaining
// oracle. An unknown address returns after one read; a known one deletes,
// creates and AWAITS the app's mail callback. Login pays bcrypt on every
// branch for exactly this reason (`FJS-063`); this route pays nothing.
//
// Two harnesses: a mail callback that awaits a 20ms timer (a mail client's
// round trip), and the harness's own no-op. Medians over 30 interleaved
// iterations each. The assertion is a 2x ceiling; the medians are printed.

import { describe, test, expect, afterAll } from 'bun:test'
import { makeAuth, type Harness } from './harness.ts'
import { appWith, json } from './audit-routes-http.ts'

const harnesses: Harness[] = []
afterAll(() => harnesses.forEach(h => h.cleanup()))

const sleep  = (ms: number) => new Promise(r => setTimeout(r, ms))
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]! }

async function measure(label: string, onPasswordResetRequested: () => Promise<void>) {
  const h = await makeAuth({ onPasswordResetRequested })
  harnesses.push(h)
  const app = await appWith(h.auth)
  await h.auth.createUser({ email: 'known@example.com', password: 'k-pw-1', name: 'K' })

  const known: number[] = [], unknown: number[] = []
  const time = async (email: string) => {
    const t0 = performance.now()
    const res = await json(app, 'POST', '/auth/password-reset/request', { email })
    const dt = performance.now() - t0
    expect(res.status).toBe(200)
    return dt
  }
  // Warm both paths once so neither pays first-call costs inside the sample.
  await time('known@example.com'); await time('nobody@example.com')

  for (let i = 0; i < 30; i++) {
    known.push(await time('known@example.com'))
    unknown.push(await time('nobody@example.com'))
  }
  const mk = median(known), mu = median(unknown)
  console.log(`[reset-timing] ${label}: known=${mk.toFixed(2)}ms unknown=${mu.toFixed(2)}ms ratio=${(mk / mu).toFixed(1)}x`)
  return { mk, mu }
}

describe('POST /auth/password-reset/request timing', () => {
  // FJS-1832: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing('with a mail callback that awaits 20ms, a known address is not distinguishable on the clock', async () => {
    const { mk, mu } = await measure('20ms mail callback', async () => { await sleep(20) })
    expect(mk / mu).toBeLessThan(2)
  })

  // FJS-1832: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing('with the no-op callback, a known address is not distinguishable on the clock', async () => {
    const { mk, mu } = await measure('no-op callback', async () => {})
    expect(mk / mu).toBeLessThan(2)
  })
})
