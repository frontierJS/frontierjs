// api/jobs/book-courier.job.ts — the work that happens after the response.
//
// Autoloaded by @frontierjs/caravan from `jobsDir` (api/jobs). The file name
// does not matter; `defineJob`'s first argument is the name a dispatch uses.
//
// ─── Why this is a job and not part of the `ship` action ──────────────────
//
// Booking a courier is somebody else's HTTP call: it is slow, it fails for
// reasons that have nothing to do with the caller, and retrying it is correct
// where retrying the state transition is not. Doing it inside the action would
// make the button hang on a third party and make a courier outage look like a
// broken shop. So `ship` moves the order and returns; this runs after, and if
// the courier is down it runs again in a minute, then five, then thirty.
//
// The move itself is NOT retried and never queued: it is a state transition
// with an optimistic lock, and "try it again later" is exactly wrong for one.
//
// ─── Why it writes through the SERVICE ────────────────────────────────────
//
// `db.asSystem().order.update(…)` is one line shorter and would be invisible:
// Litestone's onEvent has no Junction subscriber (FJS-010), so a write at the
// Data boundary announces nothing and every open tab keeps the stale row. The
// service layer is the one place a mutation is announced, so background work
// goes through it like everything else — and the tracking code lands in a
// browser that has been sitting idle since before the job was queued.

import { defineJob } from '@frontierjs/caravan'
import { getApp }    from '../app-ref.ts'
import { SYSTEM }    from '../gate.ts'

interface BookCourier {
  orderId:   number
  reference: string
}

/**
 * Pretend courier API. Deterministic from the reference so a re-run of the
 * drive gets the same code, and slow enough (250ms) that the response has
 * demonstrably already been sent by the time this finishes.
 */
async function bookWithCourier(reference: string): Promise<string> {
  await new Promise(r => setTimeout(r, 250))
  let hash = 0
  for (const ch of reference) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffff
  return `TRK-${hash.toString(36).toUpperCase().padStart(4, '0')}`
}

export default defineJob<BookCourier>('book-courier', async (job) => {
  const { orderId, reference } = job.data

  const trackingCode = await bookWithCourier(reference)

  // `auth` is why api/gate.ts declares SYSTEM. An in-process call defaults to
  // no principal, and no principal is STRANGER(0) — refused by Order's @@gate
  // exactly as an anonymous browser is. A job is not anonymous, it is the shop
  // itself, and that is a sentence the app has to say somewhere.
  await getApp().service('orders').patch(orderId, { trackingCode }, {
    auth: { user: SYSTEM as never },
  })
}, {
  queue:       'fulfilment',
  maxAttempts: 5,
  // 1m, 5m, 30m, then 30m again — the last value is reused for every further
  // attempt. A courier outage is measured in minutes, not milliseconds.
  retryDelay:  [60_000, 300_000, 1_800_000],
})
