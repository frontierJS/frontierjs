import { createBaseService, validateFields, $ } from '@frontierjs/junction'

// The job DEFINITIONS, not their names. `dispatch(bookCourier, …)` states the
// name nowhere, so it cannot drift from the file that answers to it, and the
// payload is typed by the handler that will receive it. Importing them is also
// what puts Caravan's augmentation of `app.jobs` in this file's program —
// without it `ctx.app.jobs` is the empty slot Junction declares and every call
// site needs a hand-written cast.
import bookCourier from '../jobs/book-courier.job.ts'

// The one owner of "this order has been paid for" — shared with
// `payments.record`, which reaches it from a provider's webhook. It reads `$`,
// so it runs inside THIS call's transaction with THIS caller's principal.
import { settleOrder, refundOrder } from '../core/settle.ts'
import { checkoutCodeFor }          from '../core/checkout-code.ts'

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
// A custom method runs inside a SERVICE CALL, and `$` is that call: `$.id` is
// the row, `$.db` the per-request Litestone client that withLitestoneDb scoped
// to the caller — so the gate sees the real user, not a system bypass. `$` is
// read-only and dies with the call, and it throws by name if a function that
// reads it is ever called from outside one.

/** The one verb this service needs that junction's minimal client type does
 *  not declare — `transition` is Litestone's, off `@@transitions`. */
type Orders = { order: { transition(id: unknown, name: string): Promise<unknown> } }
const orders = () => $.db as unknown as Orders

/** One move. Litestone owns every rule about it; this only names it. */
const move = (name: string) => async () =>
  // Which states this is legal from, what it moves to, and what level it needs
  // are all in db/schema.lite. An illegal move throws TransitionViolationError
  // (409), a lost race TransitionConflictError (409), too low a level
  // TransitionGateError (403) — each carries its own status.
  orders().order.transition($.id, name)

/**
 * `pay` is a member of staff saying the money arrived — the manual path.
 *
 * The usual path is not this one: `payments.record` settles an order off the
 * provider's webhook, and this is the button for the sale that was taken over
 * the phone or the card machine that is not wired up. Both do exactly the same
 * thing because both call the same function, which is the only arrangement
 * where they cannot drift.
 *
 * What that function does and why is api/src/core/settle.ts. The one thing
 * that belongs here is the reason `transactional:` is declared below: the
 * announcement it queues is an OUTBOX row, and `$.enqueue` refuses outside a
 * transaction.
 */
const pay = async () => settleOrder(Number($.id))

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
const ship = async () => {
  const order = await move('ship')() as
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
  await $.app?.jobs?.dispatch(bookCourier,
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
const recordTracking = async () => {
  // Not a cast. `methods:` below declares this method's payload as
  // `type TrackingUpdate` in db/schema.lite, so by the time this line runs the
  // body has been through the same validator a model create gets — the key is
  // present, it is a string, and it is 4 to 40 characters in the schema's own
  // wording. A cast asserted all three and checked none.
  const { trackingCode } = $.data as { trackingCode: string }
  return $.db.order.update({
    where:  { id: Number($.id) },
    data:   { trackingCode },
    system: ['trackingCode'],
  })
}

/**
 * The rules the seed cannot state, reported the way the seed's rules are.
 *
 * `db/schema.lite` already says `total` is a Float `@gte(0)` and that `status`
 * is an `OrderStatus`, and a caller breaking either gets a 400 naming the
 * field, which `<Form>` puts under the control. Neither of these two can be
 * said there: the first is a relationship BETWEEN two columns, and the second
 * is about the value a column may START at, which `@@transitions` does not
 * cover because a create is not a move.
 *
 * Written through `validateFields` rather than by throwing, for two reasons.
 * Both rules report at once — a caller who has broken both should be told both,
 * not told one, fix it, and be told the other. And the shape is the VALIDATOR's
 * shape (`[{ field, message }]`), so these land under their own controls exactly
 * as `@gte(0)` does; a bare `throw new BadRequest('…')` is a banner, or nothing,
 * depending on what renders it.
 *
 * ─── Why nothing here reads the database ──────────────────────────────────
 *
 * A rule like "that customer is no longer on file" belongs in this file and is
 * deliberately not in it. An app's before-hook runs AHEAD of the derived
 * `gateAuth` (`surface.snapshot.md` prints the chain), so a read here happens
 * for a caller nothing has authenticated yet — measured, and a working
 * existence oracle for the customer table. `FJS-403` is that ordering; until it
 * is settled these rules judge only the payload the caller sent them, which is
 * theirs to know.
 *
 * For the same reason `total` is coerced here rather than trusted: `autoValidate`
 * has not run either, so this is the raw wire value.
 */
/**
 * The code that lets somebody pay for this order, for a caller who may already
 * read the order.
 *
 * `carts.checkout` answers it once, to the shopper who just bought. This is the
 * other door, and a shop needs it: *send the customer a link to pay* is an
 * ordinary thing to want, and the column is `@guarded`, so no read of the order
 * carries it and no filter can probe it.
 *
 * The read goes through the CALLER'S own client and that is the whole
 * permission check — `Order` declares `@@allow('read', auth().isStaff)` and
 * `@@allow('read', userId == auth().id)`, so staff and the shopper it belongs
 * to are exactly who gets an answer, and a hook restating that would be a
 * second copy of a rule the schema already holds. The re-read as the shop is
 * what fetches the guarded column, after the caller's own client has said they
 * may see the row at all.
 */
const paymentCode = async () => {
  // Read-shaped, so it opts out of the announcement every other custom method
  // here makes — and here that is not tidiness. `callService` broadcasts a
  // custom method's RESULT under its own name, this service declares
  // `channel: 'orders'`, and `api/src/app.ts` joins every connection to it: the
  // announcement would put a payment credential on every open socket in the
  // shop. Nothing has changed, so there is nothing to say.
  $.dispatch = false

  const id = Number($.id)

  // The CALLER'S own client, and that read is the whole permission check.
  // `Order` declares `@@allow('read', auth().isStaff)` and
  // `@@allow('read', userId == auth().id)`, so staff and the shopper it belongs
  // to are exactly who gets an answer — and a hook restating that would be a
  // second copy of a rule the schema already holds.
  const own = await $.db.order.findFirst({ where: { id } })
  if (!own) throw Object.assign(new Error('No such order'), { status: 404 })

  return { orderId: id, checkoutCode: checkoutCodeFor(id) }
}

const checkOrderRules = async () => {
  const data = ($.data ?? {}) as { total?: unknown; status?: unknown; note?: string | null }

  await validateFields(e => {
    // Cross-FIELD. Neither column is wrong on its own, which is exactly why
    // this cannot be an attribute on either of them.
    if (Number(data.total ?? 0) >= 1000 && !String(data.note ?? '').trim())
      e.invalid('note', 'An order of 1,000 or more needs a note saying why')

    // A new order starts at `pending`. @@transitions governs every MOVE after
    // that and has nothing to say about where a row begins.
    if (data.status !== undefined && data.status !== 'pending')
      e.invalid('status', 'A new order starts as pending')
  })
}

export function createOrdersService() {
  return createBaseService({
    channel: 'orders',

    // BEFORE the derived gateAuth and autoValidate — an app's layer is merged
    // first and there is no slot after them (`FJS-403`). That is why these
    // rules read nothing but the payload.
    hooks: { before: { create: [checkOrderRules], update: [checkOrderRules] } },

    // `pay` writes an outbox row and $.enqueue refuses outside a transaction —
    // an intent is only worth recording if it rolls back with the write it
    // belongs to. `refund` is here for the other reason: it is the move plus
    // one InventoryMovement per line plus the stock column each of them moves,
    // and an order half back on the shelf is worse than one not back at all.
    transactional: ['pay', 'refund'],

    // The names match @@transitions in the schema. They are written twice —
    // once there, once here — which is the seam worth watching: a method
    // naming a move the schema does not declare answers 400
    // TransitionNotFoundError rather than inventing one.
    pay,                        // the move + a queued announcement
    ship,                       // the move + a queued courier booking
    // NOT `move('refund')`. A refund is the move AND the shelf, and this used
    // to be the move alone — so refunding an order took the money question
    // seriously and left every item sold, with the ledger correctly recording
    // a sale that had been reversed everywhere else. `settle.ts` owns both,
    // shared with the webhook path.
    refund: () => refundOrder(Number($.id)),
    cancel: move('cancel'),

    recordTracking,             // the courier job writing a @system column
    paymentCode,                // the credential a checkout link carries

    // The whole surface, stated — because declaring one method's input is also
    // declaring the list, and a service that named only `recordTracking` would
    // answer 405 to everything else. It is not a trap you fall into quietly:
    // surface.snapshot.md carries this list and CI fails a stale one, so a verb
    // that stopped being answered is a diff before it is a bug.
    //
    // `input:` names a `type` in db/schema.lite. Only recordTracking takes a
    // body — the four moves take an id and nothing else, and a move's rules are
    // in @@transitions where every other rule about this row lives.
    methods: [
      'find', 'get', 'create', 'update', 'patch', 'remove',
      'pay', 'ship', 'refund', 'cancel', 'paymentCode',
      { method: 'recordTracking', input: 'TrackingUpdate' },
    ],
  })
}
