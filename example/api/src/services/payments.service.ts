import { createBaseService, $ } from '@frontierjs/junction'
import { occurrenceKey }        from '@frontierjs/toolbelt/history'
import { createIntent, createRefund } from '../core/psp.ts'
import { settleOrder, refundOrder }   from '../core/settle.ts'

// Money, in two methods that face opposite directions.
//
//   start   the shop ASKS the provider for an intent — outbound, over conduit,
//           signed, and the one place a Payment row is created
//   record  the provider TELLS the shop what happened — inbound, off a
//           verified webhook, and the one place an order is settled by machine
//
// The CRUD half is the seller's read-only view: `Payment` is @@gate("5.8.8.9")
// and `PaymentEvent` @@gate("5.8.9.9"), so `find` and `get` answer an
// administrator and every write below goes through `asSystem()` — the shop
// recording what it was told. A person at no standing writes one of these
// rows, which is what 8 says and what a level could not.

/**
 * The system client. Both tables are SYSTEM-write by declaration, so this is
 * not a shortcut past a check — there is no standing that passes them.
 *
 * Under `transactional:` it is still the transaction's connection:
 * `asSystem()` answers a scoped proxy over the same one, so the ledger row and
 * the order move roll back together.
 */
const sys = () => ($.db as { asSystem(): Record<string, any> }).asSystem()

type OrderRow   = { id: number; reference: string; status: string; total: number }
type PaymentRow = {
  id: number; providerRef: string; orderId: number
  status: string; amount: number; refundedAmount: number
}

const bad = (message: string) => Object.assign(new Error(message), { status: 400 })

/**
 * Ask the provider to take money for an order, and write the row that says we
 * did.
 *
 * Addressed to the COLLECTION — `invoke('start', null, { orderId })` — because
 * it is not an operation on a payment: there is no payment until it answers.
 *
 * ─── The order of the two writes ──────────────────────────────────────────
 *
 * The provider is called FIRST and the row is written from its answer. The
 * other order — write `pending`, then call — looks safer and is worse: it
 * leaves a row claiming a payment exists at a provider that refused the
 * request, keyed by a `providerRef` that has to be invented locally and then
 * reconciled if the real one ever arrives. A provider call that fails leaves
 * nothing here, which is the honest state, and the caller is told which kind
 * of failure it was.
 */
const start = async () => {
  const { orderId } = ($.data ?? {}) as { orderId?: number }
  const id = Number(orderId)
  if (!Number.isFinite(id)) throw bad('Which order is this payment for?')

  // ─── Read as the SHOP, not as the caller ────────────────────────────────
  //
  // This was the caller's own client, and it worked because `Order` read at
  // level 0 — the same gate the catalogue carries. That is the leak this app
  // shipped with: a hosted checkout is reached by a shopper with no session, so
  // making the READ public was the way to let them pay, and it made every
  // order in the shop public with it.
  //
  // The shop looking up its own order to open a payment intent is not the same
  // act as the caller reading that order, and only the first one is happening
  // here: nothing about the row is answered back. What the caller gets is an
  // intent for the id they named.
  //
  // What that leaves is a smaller thing worth naming rather than hiding: an
  // order id is a sequential integer, so a stranger can OPEN a payment for
  // somebody else's order. They cannot see it, change it or pay it to their own
  // account, and the shop's answer is the same either way — but the checkout
  // link should carry a token of its own, and does not (`FJS-497`).
  const order = await sys().order.findFirst({ where: { id } }) as OrderRow | null
  if (!order) throw bad('No such order')

  // The state machine's business, asked before spending a round trip on it.
  // Not a substitute for the transition: `record` moves the row and Litestone
  // refuses an illegal move whatever this says.
  if (order.status !== 'pending')
    throw bad(`That order is ${order.status} — there is nothing to pay`)

  const { intent, error } = await createIntent($.app!, {
    amount:    order.total,
    currency:  'USD',
    reference: order.reference,
  })

  if (error || !intent) {
    // `retryable` is the provider's own answer and it is the whole reason this
    // goes through conduit: "the provider is down" and "our key is wrong" are
    // one failed fetch to a caller and two completely different things to do.
    // Carried onto the error so a client can tell a shopper to try again
    // rather than to phone the shop.
    throw Object.assign(
      new Error(`We could not reach the payment provider (${error?.kind ?? 'unknown'})`),
      { status: 502, retryable: error?.retryable ?? false },
    )
  }

  const payment = await sys().payment.create({ data: {
    providerRef: intent.id,
    orderId:     order.id,
    amount:      order.total,
    currency:    intent.currency ?? 'USD',
  } }) as PaymentRow

  // ─── Two audiences, two payloads ─────────────────────────────────────────
  //
  // The CALLER gets a narrow view: the provider's id, because their next hop
  // is the provider's own page and that is how it is addressed, plus the row's
  // own id so a staff screen can link to it. Not the row — `Payment` reads at
  // ADMINISTRATOR(5) and this method answers a shopper at 0, and a custom
  // method's return value is not filtered by anything.
  //
  // SUBSCRIBERS get the row, through `$.dispatch`. It is the announcement
  // payload and nothing else, so widening it does not widen the response, and
  // a row is the only shape a subscriber can merge — junction says so out loud
  // rather than broadcasting a summary that every store would try to upsert as
  // a record.
  $.dispatch = payment

  return { paymentId: payment.id, providerRef: intent.id, amount: order.total, status: payment.status }
}

/**
 * Give the money back.
 *
 * Addressed to the PAYMENT — `invoke('refund', paymentId, { amount? })` —
 * because a refund is an operation on money that was taken, and an order may
 * have more than one payment behind it.
 *
 * ─── Where the authority comes from, and why it is not a number here ─────
 *
 * `gateAuth` grades CRUD against the model's `@@gate` and says nothing about a
 * custom method — by design, and stated in junction: "a method the map does
 * not name is not gated here". So this method has to establish its own
 * authority, and the wrong way is `if (level < 5)`, which is the seed's rule
 * written a second time in a place nothing keeps in step.
 *
 * The right way is to ASK. `db/schema.lite` declares
 * `refund: paid -> refunded @gate(5)`, and `db.order.transitions(row)` answers
 * every move legal from where that row is now, each flagged `allowed` for the
 * CALLER IN SCOPE. So the check below reads the same declaration the Data
 * boundary will enforce, and raising the gate in the seed moves both.
 *
 * It is checked HERE rather than left to the transition because the transition
 * happens in `record`, hours later, as the shop — by which time the money has
 * already gone back and a refusal is far too late to mean anything.
 */
const refund = async () => {
  const payment = await sys().payment.findFirst({ where: { id: Number($.id) } }) as PaymentRow | null
  if (!payment) throw bad('No such payment')
  // A PARTLY refunded payment is still `succeeded` — the status is about the
  // attempt, the amount is a separate fact — so this admits the second call of
  // a refund taken in two parts and refuses a payment that never went through
  // or has already gone back whole.
  if (payment.status !== 'succeeded')
    throw bad(`That payment is ${payment.status} — there is nothing to give back`)

  const order = await $.db.order.findFirst({ where: { id: payment.orderId } }) as OrderRow | null
  if (!order) throw bad('That payment names an order that is no longer here')

  // The seed's own answer, for this caller, about this row. `allowed` is false
  // for a caller below 5; the move being ABSENT means the order is not in a
  // state a refund is legal from, which is a different sentence.
  const moves = await ($.db as unknown as {
    order: { transitions(row: unknown): Promise<Array<{ name: string; allowed: boolean }>> }
  }).order.transitions(order)
  const move = moves.find(m => m.name === 'refund')

  if (!move) throw bad(`An order that is ${order.status} cannot be refunded`)
  if (!move.allowed) throw Object.assign(
    new Error('Refunding an order needs an administrator'), { status: 403 },
  )

  const { amount } = ($.data ?? {}) as { amount?: number }
  const asked = amount === undefined ? undefined : Number(amount)
  if (asked !== undefined && !(asked > 0)) throw bad('A refund is more than nothing')

  const { refund: taken, error } = await createRefund($.app!, {
    paymentRef: payment.providerRef,
    ...(asked === undefined ? {} : { amount: asked }),
    // ─── The key, and why it is this ────────────────────────────────────
    //
    // What makes two attempts THE SAME REFUND is the shop's intention, which
    // nothing downstream can infer — a uuid per call would be unique and
    // guard nothing. This says: one refund of this size against this payment.
    // A second click inside a network timeout replays the first answer; a
    // deliberate second refund of the same amount states its own key, which
    // is a thing a person has to mean.
    key: occurrenceKey('refund', payment.providerRef, String(asked ?? 'all')),
  })

  if (error || !taken) throw Object.assign(
    new Error(`We could not reach the payment provider (${error?.kind ?? 'unknown'})`),
    { status: 502, retryable: error?.retryable ?? false },
  )

  // Nothing is written here. The provider's webhook is what moves the row, the
  // order and the shelf — one owner for "a refund happened", whether this shop
  // asked for it or somebody pressed refund in the provider's dashboard.
  $.dispatch = false
  return { paymentId: payment.id, refunded: taken.amount, refundedTotal: taken.total }
}

/**
 * The provider told us something. The one place that acts on it.
 *
 * Called from the webhook route (api/src/app.ts) once the signature has been
 * verified, as the shop's own SYSTEM principal — a webhook carries no session
 * and must not be able to name one.
 *
 * ─── Why the claim and the effect are one transaction ────────────────────
 *
 * `transactional: ['record']` below, and it is load-bearing. The obvious
 * arrangement — claim the event id, commit, then do the work — has a hole a
 * crash fits through exactly: the event is claimed, the order is still
 * pending, and the provider's retry is deduped away by the very row that
 * recorded nothing happening. In one transaction a crash rolls the claim back
 * with the work, so the retry redoes both.
 *
 * The claim is a read-then-write, which is safe here for a stated reason:
 * `transactional:` opens with BEGIN IMMEDIATE, taking the write lock up front,
 * so a second delivery of the same event waits and then reads the first one's
 * row.
 */
const record = async () => {
  const body = ($.data ?? {}) as {
    id?: string
    type?: string
    data?: { paymentRef?: string; reason?: string | null; refunded?: number; refundedTotal?: number }
  }

  const eventId = String(body.id ?? '')
  const kind    = String(body.type ?? '')
  const ref     = body.data?.paymentRef ? String(body.data.paymentRef) : null
  if (!eventId || !kind) throw bad('A payment event needs an id and a type')

  const system = sys()

  // Already handled — the ordinary case for a redelivery, not an error. The
  // provider gets a 2xx and stops retrying, which is what it is asking for.
  const already = await system.paymentEvent.findFirst({ where: { eventId } })
  if (already) {
    // Nothing changed, so nothing is announced. Every early return below says
    // the same thing the same way: what this method answers is a RECEIPT for
    // the provider, and a receipt is not a payments row.
    $.dispatch = false
    return { status: 'duplicate', eventId }
  }

  await system.paymentEvent.create({ data: { eventId, kind, paymentRef: ref } })

  // An event about a payment this shop has no row for is recorded and not
  // acted on — a refund issued from the provider's dashboard, a test event
  // fired at a fresh database. Recording it is the point of the ledger; 200,
  // because there is nothing for the provider to retry.
  const payment = ref
    ? await system.payment.findFirst({ where: { providerRef: ref } }) as PaymentRow | null
    : null
  if (!payment) {
    $.dispatch = false
    return { status: 'unknown-payment', eventId, paymentRef: ref }
  }

  if (kind === 'payment.failed') {
    // The row is what goes on the wire, and it is the UPDATED row — the write
    // itself announces nothing, because callService is already announcing for
    // this service and the tap suppresses the double.
    $.dispatch = await system.payment.update({ where: { id: payment.id }, data: {
      status:        'failed',
      failureReason: body.data?.reason ?? null,
    } })
    // The order stays `pending`. A declined card is not a cancelled order —
    // the shopper is expected to try another one, and `start` will answer
    // because the status has not moved.
    return { status: 'recorded', eventId, payment: payment.id, order: null }
  }

  if (kind === 'payment.refunded') {
    const back  = Number(body.data?.refunded ?? 0)
    const total = Number(body.data?.refundedTotal ?? back)

    // FULLY refunded is what moves the order. A partial refund is money going
    // back on an order that is still paid and still shipping — the shop has
    // refunded the postage, not the sale — and moving `status` for it would
    // make `refunded` mean two different things.
    const whole = total >= payment.amount - 0.005

    $.dispatch = await system.payment.update({ where: { id: payment.id }, data: {
      refundedAmount: total,
      ...(whole ? { status: 'refunded' } : {}),
    } })

    if (!whole) return { status: 'partly-refunded', eventId, payment: payment.id, refunded: back, order: null }

    const order = await system.order.findFirst({ where: { id: payment.orderId } }) as OrderRow | null
    if (!order)                    return { status: 'unknown-order', eventId, payment: payment.id }
    if (order.status === 'refunded') return { status: 'already-refunded', eventId, payment: payment.id, order: order.id }
    if (order.status !== 'paid')   return { status: 'not-refundable', eventId, payment: payment.id, order: order.id, was: order.status }

    // One owner of "this order was refunded", shared with `orders.refund` —
    // the move AND the shelf, inside this call's transaction.
    await refundOrder(order.id)
    return { status: 'refunded', eventId, payment: payment.id, order: order.id, refunded: back }
  }

  if (kind !== 'payment.succeeded') {
    $.dispatch = false
    return { status: 'ignored', eventId, kind }
  }

  $.dispatch = await system.payment.update({ where: { id: payment.id }, data: {
    status:    'succeeded',
    settledAt: new Date().toISOString(),
  } })

  // The order may already be paid — a member of staff pressed the button while
  // the webhook was in flight, or an earlier delivery of a DIFFERENT event
  // settled it. The move would throw `TransitionViolationError`, which as a
  // 409 to the provider means "retry this forever". So the state is asked
  // first, and the two paths answer differently on purpose: `settled` means
  // this delivery moved the row, `already-paid` means it found it moved.
  const order = await system.order.findFirst({ where: { id: payment.orderId } }) as OrderRow | null
  if (!order) return { status: 'unknown-order', eventId, payment: payment.id }

  if (order.status !== 'pending')
    return { status: 'already-paid', eventId, payment: payment.id, order: order.id }

  // One owner of "this order has been paid for", shared with `orders.pay`.
  // It reads `$` — this call's transaction, this call's principal — so the
  // move and the outbox row for the announcement commit with the ledger claim
  // above or roll back with it.
  await settleOrder(order.id)

  return { status: 'settled', eventId, payment: payment.id, order: order.id }
}

export function createPaymentsService() {
  return createBaseService({
    model:   'Payment',
    channel: 'payments',

    // `record` alone. `start` writes one row and calls a third party, and
    // wrapping a network round trip in a transaction holds SQLite's write lock
    // open for the length of somebody else's outage.
    transactional: ['record'],

    start,
    refund,
    record,

    // Declared, which also declares the surface: `find` and `get` for the
    // seller's screens, the two verbs, and nothing else — no `create`, no
    // `patch`, no `remove`. A payment is not a row a person makes, and 405 is
    // a better answer than a 403 from a gate the caller could not have known
    // about. surface.snapshot.md carries this list and CI fails a stale one.
    methods: ['find', 'get', 'start', 'refund', 'record'],
    //
    // ─── Nothing joins this channel, and that is the decision ──────────────
    //
    // api/src/app.ts joins every connection to orders, products and customers.
    // Not this one: `Payment` reads at ADMINISTRATOR(5), a socket connection is
    // not graded by anything, and joining every one would put a gated row on a
    // stranger's socket — the exact shape junction reports about an app-level
    // `publishDefault` (FJS-334). A screen that wants these joins the channel
    // knowing what it is asking for.
    //
    // The seller's ORDER list is not affected and does not need this: the
    // order's move announces on the `orders` channel, from Litestone's own
    // write tap, because the transition happens through a client this service
    // holds rather than through the orders service.
  })
}
