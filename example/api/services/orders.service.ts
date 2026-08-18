import { createBaseService } from '@frontierjs/junction'
import type { ServiceContext } from '@frontierjs/junction'

// The job DEFINITIONS, not their names. `dispatch(bookCourier, …)` states the
// name nowhere, so it cannot drift from the file that answers to it, and the
// payload is typed by the handler that will receive it. Importing them is also
// what puts Caravan's augmentation of `app.jobs` in this file's program —
// without it `ctx.app.jobs` is the empty slot Junction declares and every call
// site needs a hand-written cast.
import announcePayment from '../jobs/announce-payment.job.ts'
import bookCourier     from '../jobs/book-courier.job.ts'

// Orders declare @@transitions, and Litestone enforces the machine at the Data
// boundary. What this file adds is a way to ASK for a move by name.
//
// ─── Why these are methods and not four more columns to PATCH ─────────────
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
// custom method, dispatched as POST /{service}/{id} with an
// `X-Service-Method: {name}` header. The browser calls them through
// `resource.service.invoke(name, id)`. Nothing here registers a route.
//
// A custom method's ctx is a SERVICE context: `ctx.id` is the row and
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
 * `pay` is the move plus telling two audiences about it — durably.
 *
 * Neither the email to the customer nor the row for the staff belongs inside
 * the transition: one is an HTTP call to somebody else's API and the other is
 * five writes and a broadcast. Both go on the queue
 * (api/jobs/announce-payment.job.ts), so a mail outage cannot make paying an
 * order fail, and a retry re-sends the email rather than re-running the move.
 *
 * ─── Why enqueue and not dispatch ──────────────────────────────────────────
 *
 * A dispatch here is a second thing that happens after the move commits, and
 * nothing joins the two: the process dying in between leaves an order that is
 * paid and a customer who is never told, with no row anywhere saying the
 * announcement was owed. `ctx.enqueue` writes that row INSIDE this method's
 * transaction — see `transactional:` below — so it commits with the move or
 * rolls back with it, and the relay hands it to the queue afterwards.
 *
 * The `unique` key this used to carry is gone, and nothing replaced it: it
 * covered a double-click while the job was still queued, and the state machine
 * already refuses paying a paid order (409), so the second call never reaches
 * this line to write a second row. What `unique` could never cover is the case
 * above, because a key on a job that was never queued guards nothing.
 */
const pay = async (ctx: ServiceContext) => {
  const order = await move('pay')(ctx) as { id: number }

  await ctx.enqueue(announcePayment, { orderId: order.id })

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

  // `app.jobs` is Caravan's claim on the app, made through app.claim().
  await ctx.app?.jobs?.dispatch(bookCourier,
    { orderId: order.id, reference: order.reference },
    { unique: `book-courier:${order.id}` })

  return order
}

/**
 * The courier job's way back in.
 *
 * `trackingCode` is `@system` in db/schema.lite: readable by anyone, refused on
 * write to every caller. So the job cannot PATCH it — and that is the point,
 * because neither can a person, and before the annotation existed nothing could
 * tell the two apart.
 *
 * What unlocks it is naming the column on the call. Everything else still
 * applies: the gate grades the job's SYSTEM principal exactly as it grades a
 * browser, the row policies run, the write is audited to the caller. That is
 * the whole difference from `asSystem()`, which would write this one column by
 * dropping every rule on the row.
 *
 * A named method rather than a PATCH for the same reason the moves are: "record what
 * the courier said" is a thing the shop does, and a service that says so reads
 * better than a payload that happens to carry one column.
 */
const recordTracking = async (ctx: ServiceContext) => {
  const db = (ctx.locals as { db?: { order: { update(a: unknown): Promise<unknown> } } } | undefined)?.db
  if (!db) throw new Error('no scoped db on ctx.locals — is withLitestoneDb installed?')

  const { id, data } = ctx as ServiceContext & { id?: unknown; data?: { trackingCode?: string } }
  return db.order.update({
    where:  { id: Number(id) },
    data:   { trackingCode: data?.trackingCode },
    system: ['trackingCode'],
  })
}

export function createOrdersService() {
  return createBaseService({
    channel: 'orders',

    // `pay` alone. It is the one move that records a durable effect, and
    // ctx.enqueue refuses outside a transaction — an outbox row is only worth
    // writing if it rolls back with the write it belongs to.
    transactional: ['pay'],

    // The names match @@transitions in the schema. They are written twice —
    // once there, once here — which is the seam worth watching: a method
    // naming a move the schema does not declare answers 400
    // TransitionNotFoundError rather than inventing one.
    pay,                        // the move + a queued announcement
    ship,                       // the move + a queued courier booking
    refund: move('refund'),
    cancel: move('cancel'),

    recordTracking,             // the courier job writing a @system column
  })
}
