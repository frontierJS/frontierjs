import { createBaseService } from '@frontierjs/junction'
import type { ServiceContext } from '@frontierjs/junction'

// Orders declare @@transitions, and Litestone enforces the machine at the Data
// boundary. What this file adds is a way to ASK for a move by name.
//
// ─── Why these are actions and not four more columns to PATCH ─────────────
//
// `PATCH /api/orders/3 {"status":"paid"}` already works and is already refused
// when the move is illegal — the machine does not care how you arrive. But a
// PATCH says "set this field to this value" and a transition is not that: it is
// "run this named move, if it is legal from where the row is now". Litestone's
// `transition()` narrows the UPDATE with the expected state in the WHERE, so two
// callers racing the same move produce one winner and one
// TransitionConflictError rather than two silent successes. A PATCH cannot
// express that.
//
// Naming a move also means the gate can be per-move: `refund` wants level 5,
// `ship` does not, and no model-level @@gate can say that — a PATCH to `status`
// is one operation with one gate whatever value it carries.
//
// ─── How they are routed ──────────────────────────────────────────────────
//
// Any function on a service definition that is not a known option key becomes a
// custom action, dispatched as POST /{service}/{id} with an
// `X-Service-Method: {name}` header. The browser calls them through
// `resource.service.action(name, id)`. Nothing here registers a route.
//
// A custom action's ctx is a SERVICE context: `ctx.id` is the row and
// `ctx.locals.db` the per-request Litestone client that withLitestoneDb scoped
// to the caller — so the gate sees the real user, not a system bypass.

type ScopedDb = { order: { transition(id: unknown, name: string): Promise<unknown> } }

/** One move. Litestone owns every rule about it; this only names it. */
const move = (name: string) => async (ctx: ServiceContext) => {
  const db = (ctx.locals as { db?: ScopedDb } | undefined)?.db
  if (!db) throw new Error('no scoped db on ctx.locals — is withLitestoneDb installed?')
  // Which states this is legal from, what it moves to, and what level it needs
  // are all in db/schema.lite. An illegal move throws TransitionViolationError
  // (409), a lost race TransitionConflictError (409), too low a level
  // TransitionGateError (403) — each carries its own status.
  return db.order.transition((ctx as ServiceContext & { id?: unknown }).id, name)
}

/**
 * `pay` is the move plus telling two audiences about it.
 *
 * Neither the email to the customer nor the row for the staff belongs inside
 * the transition: one is an HTTP call to somebody else's API and the other is
 * five writes and a broadcast. Both go on the queue
 * (api/jobs/announce-payment.job.ts), so a mail outage cannot make paying an
 * order fail, and a retry re-sends the email rather than re-running the move.
 *
 * `unique` keys the announcement to the order, so a double-click announces
 * once — for the window in which the job is still queued. Paying an already
 * paid order is refused by the machine (409), so unlike `ship` there is no
 * second dispatch to guard against afterwards.
 */
const pay = async (ctx: ServiceContext) => {
  const order = await move('pay')(ctx) as { id: number }

  await (ctx.app as { jobs?: { dispatch(name: string, data: unknown, opts?: { unique?: string }): Promise<string> } })
    .jobs?.dispatch('announce-payment', { orderId: order.id },
      { unique: `announce-payment:${order.id}` })

  return order
}

/**
 * `ship` is the move plus one piece of deferred work.
 *
 * The transition runs inline — it is this shop's own state and it either is or
 * is not legal right now. Booking the courier does not run inline: it is a
 * third party's API, slow and flaky, and the caller should not wait on it or
 * see its outage as a failed shipment. So the move answers, and the queue picks
 * the rest up (api/jobs/book-courier.job.ts).
 *
 * Dispatched AFTER the transition resolves, deliberately. Queue first and a
 * refused move (409, 403) still books a courier for an order that never
 * shipped — and a job cannot be un-dispatched.
 */
const ship = async (ctx: ServiceContext) => {
  const order = await move('ship')(ctx) as
    { id: number; reference: string; trackingCode: string | null }

  // Shipping a SHIPPED order is a no-op at the Data boundary — the row is
  // already at the target state, so unlike `cancel` from `shipped` it does not
  // 409 and this line is reached a second time. A second booking is a second
  // parcel, so the app has to say when the work is already done, and the row
  // says it: a tracking code means a courier has one.
  //
  // `unique` covers the other half — two clicks a second apart, before the job
  // has run and before any tracking code exists. It is a lock on work in
  // flight, not an idempotency key: once the booking finishes the key is free
  // again, which is exactly why this guard cannot be left to the queue.
  if (order.trackingCode) return order

  // `app.jobs` is Caravan's claim on the app, made through app.provide().
  await (ctx.app as { jobs?: { dispatch(name: string, data: unknown, opts?: { unique?: string }): Promise<string> } })
    .jobs?.dispatch('book-courier', { orderId: order.id, reference: order.reference },
      { unique: `book-courier:${order.id}` })

  return order
}

export function createOrdersService() {
  return createBaseService({
    channel: 'orders',

    // The names match @@transitions in the schema. They are written twice —
    // once there, once here — which is the seam worth watching: an action
    // naming a move the schema does not declare answers 400
    // TransitionNotFoundError rather than inventing one.
    pay,                        // the move + a queued announcement
    ship,                       // the move + a queued courier booking
    refund: move('refund'),
    cancel: move('cancel'),
  })
}
