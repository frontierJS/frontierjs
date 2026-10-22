// FJS-2294: Stripe's own signature check refuses a tolerance with no window.
// `skew > NaN` is false, so a NaN tolerance used to verify a request of any age.
import { test, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import { verifyStripeSignature } from '../api/src/providers/stripe/index.ts'

const secret  = 'whsec_test'
const rawBody = '{"id":"evt_1"}'
const now     = 2_000_000_000
const sign    = t => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`

const verify = (t, toleranceSeconds) =>
  verifyStripeSignature({ rawBody, header: sign(t), secret, now, toleranceSeconds })

test('a fresh signature verifies under the default tolerance', () => {
  expect(verify(now - 10)).toEqual({ ok: true })
})

test('a stale signature is refused under the default tolerance', () => {
  expect(verify(now - 10 * 365 * 86400).ok).toBe(false)
})

for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, '300']) {
  test(`toleranceSeconds ${String(bad)} is refused, not read as no window`, () => {
    expect(() => verify(now - 10 * 365 * 86400, bad)).toThrow(TypeError)
  })
}
