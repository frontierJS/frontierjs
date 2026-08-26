// api/jobs/book-courier.job.ts — the work that happens after the response.
//
// Autoloaded by @frontierjs/caravan from `jobsDir` (api/jobs). The file name
// does not matter; `defineJob`'s first argument is the name a dispatch uses.
//
// ─── Why this is a job and not part of the `ship` method ──────────────────
//
// Booking a courier is somebody else's HTTP call: it is slow, it fails for
// reasons that have nothing to do with the caller, and retrying it is correct
// where retrying the state transition is not. Doing it inside the method would
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

export default defineJob<BookCourier>('book-courier', async (ctx) => {
  const { orderId, reference } = ctx.data

  const trackingCode = await bookWithCourier(reference)

  // No `auth` and no app-reference module. Both used to be here: the handler
  // took one argument and it was the job, so reaching the service layer meant
  // a module holding a mutable app; and an in-process call had no principal,
  // and no principal is STRANGER(0) — refused by Order's @@gate exactly as an
  // anonymous browser is — so every job passed `{ auth: { user: SYSTEM } }`.
  //
  // The dispatch recorded who asked, and this runs as them, re-resolved. The
  // staff member who pressed Ship books the courier; the shop's own standing is
  // not borrowed to do it, which is what SYSTEM everywhere quietly did.
  //
  // A named METHOD, not a patch: `trackingCode` is `@system` in the schema, so a
  // patch carrying it is refused by name at the Data boundary — for this job
  // exactly as for a person, which is what makes the annotation worth having.
  // `recordTracking` names the column on the write and keeps every other rule
  // (see api/services/orders.service.ts).
  await ctx.app!.service('orders').call('recordTracking', orderId, { trackingCode })
}, {
  queue:       'fulfilment',
  maxAttempts: 5,
  // 1m, 5m, 30m, then 30m again — the last value is reused for every further
  // attempt. A courier outage is measured in minutes, not milliseconds.
  retryDelay:  [60_000, 300_000, 1_800_000],
  // The failure a third-party call actually produces is not an error, it is a
  // socket that neither answers nor closes. Without a bound that attempt holds
  // its slot for the life of the process and every order behind it waits, with
  // nothing raised (`FJS-295`). 30s is well past the 250ms this takes and well
  // inside anything a courier would call a response.
  //
  // It does not cancel the call — nothing in JavaScript can — so the attempt is
  // failed and retried while the abandoned one may still be in flight. That is
  // safe HERE because the write it ends in is `recordTracking`, which sets a
  // column to a value derived from the reference: the same answer twice.
  timeout:     30_000,
})
