import { createBaseService, $ } from '@frontierjs/junction'
import { occurrenceKey }        from '@frontierjs/toolbelt/history'
import { createIntent, createRefund } from '../providers/psp/index.ts'
import { orderIdFromCheckoutCode }     from '../domain/shop'
import { settleOrder, refundOrder }   from '../domain/shop'
import { settleInvoice, declineKind } from '../domain/billing'

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

type OrderRow   = { id: number; reference: string; status: string; total: number
                    userId: string | null }
// Both parents are nullable and exactly one is set — `Payment` is
// `@@arc([orderId, invoiceId])`, so the shape here is the declaration's, and a
// branch that reads one without checking it is a branch the schema already
// refused to let exist.
type PaymentRow = {
  id: number; providerRef: string
  orderId: number | null; invoiceId: number | null
  status: string; amount: number; refundedAmount: number
}

const bad = (message: string) => Object.assign(new Error(message), { status: 400 })

/**
 * One sentence for every way a caller fails to reach an order, and one status.
 *
 * A wrong code, a code that names nothing, an id that does not exist and an id
 * belonging to somebody else all answer this. Saying which would put the oracle
 * back: *that order is not yours* confirms the order, and confirming an order
 * by naming a sequential integer is the whole of `FJS-497`.
 */
const notFoundOrder = () =>
  Object.assign(new Error('No such order, or this checkout link is not one this shop issued'),
                { status: 404 })

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
  const { orderId, code } = ($.data ?? {}) as { orderId?: number, code?: string }

  // ─── Two ways to be entitled to pay, and no third ───────────────────────
  //
  // `Order` reads at VISITOR(1) behind two policies — staff, or the shopper it
  // belongs to. A hosted checkout is reached by a shopper with NO session, so
  // there is nobody for either policy to admit, and the previous answer was to
  // look the order up as the shop and open an intent for whatever id was named.
  // The money could not be redirected (that was `FJS-494`) and the row could
  // not be read — but the answer carried the total and the refusal named the
  // status, so an order id being a sequential integer made this an existence,
  // amount and status oracle over the whole ledger, walked by counting
  // (`FJS-497`).
  //
  // So the id says WHICH order and something else has to say the caller may pay
  // it. Either:
  //
  //   · `code` — `domain/checkout-code.ts`, handed to the shopper by
  //     `carts.checkout` and to staff by `orders.paymentCode`. It IS the
  //     credential, so it is checked here rather than by a policy: a caller with
  //     no session has no claim for a policy to work with, which is exactly what
  //     `carts.redeem` does with a handoff code.
  //
  //   · nothing — and then the caller's OWN client answers, so the two `@@allow`
  //     rules on `Order` decide. Staff opening a payment from the console and a
  //     signed-in shopper paying their own order both land here, and neither
  //     needs a code to do what they could already do.
  //
  // A stranger naming a bare id now falls into the second branch and reads
  // nothing, which is the same answer they get for an order that does not
  // exist. That identical answer is the point: the oracle was never the intent,
  // it was the difference between the two replies.
  let order: OrderRow | null

  if (code != null && code !== '') {
    // The code NAMES its order — `<orderId>.<mac>` — so there is no id to agree
    // with it and no second field to get wrong. A code that does not verify
    // resolves to nothing, and nothing is what a caller who guessed an id gets.
    const named = orderIdFromCheckoutCode(code)
    if (named === null) throw notFoundOrder()
    order = await sys().order.findFirst({ where: { id: named } }) as OrderRow | null
    if (!order) throw notFoundOrder()
  } else {
    const id = Number(orderId)
    if (!Number.isFinite(id)) throw bad('Which order is this payment for?')

    // A policy FILTERS and a gate THROWS, so not being allowed to see this
    // order arrives here in two different shapes: a signed-in shopper who does
    // not own it reads `null`, and a caller at STRANGER(0) — which is every
    // hosted checkout — is refused by `@@gate("1.4.4.5")` before any policy runs.
    // Both mean the same thing to this method and both have to answer the same
    // sentence, or the status code is the oracle the code was added to close.
    // Anything that is not a refusal is a real failure and is rethrown.
    try {
      order = await $.db.order.findFirst({ where: { id } }) as OrderRow | null
    } catch (err) {
      if ((err as { status?: number })?.status === 403 || (err as Error)?.name === 'AccessDeniedError')
        throw notFoundOrder()
      throw err
    }
    if (!order) throw notFoundOrder()
  }

  // The state machine's business, asked before spending a round trip on it.
  // Not a substitute for the transition: `record` moves the row and Litestone
  // refuses an illegal move whatever this says.
  //
  // Safe to name the status now — whoever got this far has proved they may
  // read this order, by holding its code or by satisfying its read policy.
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
    // Copied from the order, like the invoice path does. Null for a guest,
    // which is most of this shop's orders and is the honest answer: there is no
    // account for the row policy to match, and a checkout link is what the
    // stranger was given instead.
    userId:      order.userId ?? null,
  } }) as PaymentRow

  // ─── Two audiences, two payloads ─────────────────────────────────────────
  //
  // The CALLER gets a narrow view: the provider's id, because their next hop
  // is the provider's own page and that is how it is addressed, plus the row's
  // own id so a staff screen can link to it. Not the row — `Payment` reads at
  // VISITOR(1) behind two row policies, this method answers a stranger at 0
  // holding a checkout link, and a custom method's return value is not filtered
  // by anything.
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

  // An invoice payment is refused by NAME here rather than falling through to
  // an order lookup that answers null. `Payment` is
  // `@@arc([orderId, invoiceId])`, so a payment for an invoice legitimately has
  // no order — and *that payment names an order that is no longer here* is the
  // wrong sentence for it, blaming a missing row for a shape that is correct.
  // Giving money back on a subscription is a credit note, which is a document
  // somebody authorises rather than a button that moves an order.
  if (payment.invoiceId)
    throw bad('That payment is for an invoice — money goes back on a subscription as a credit note, not as an order refund')

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
    data?: { paymentRef?: string; reason?: string | null; refunded?: number; refundedTotal?: number
             /** The provider's own decline code. What separates a retry from an
              *  answer — see `declineKind`. */
             declineCode?: string | null
             /** Only on `payment.action_required`: where the CARDHOLDER has to
              *  go. The provider's own page — see `Payment.actionUrl`. */
             actionUrl?: string | null
             /** Only on `setup.succeeded`: the shop's own reference for whose
              *  card this is, echoed back, and what the provider is now
              *  holding. */
             setupRef?: string
             reference?: string | null
             instrument?: { id?: string; brand?: string; last4?: string
                            expMonth?: number; expYear?: number } }
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

  // ── A card being filed is not a payment ─────────────────────────────────
  //
  // Handled ABOVE the lookup below, because there is no `Payment` row for a
  // setup intent and the generic path would answer `unknown-payment` and drop
  // the one event that files an instrument.
  //
  // The event is where the shop learns which card it has, and not the reply to
  // the confirm: the browser that confirmed is on the person's own machine and
  // is not a caller this shop can believe about whose card was filed. The
  // signature is what makes this one believable.
  if (kind === 'setup.succeeded') {
    const inst = body.data?.instrument
    const who  = String(body.data?.reference ?? '')
    const id   = Number(/^CUS-(\d+)$/.exec(who)?.[1] ?? NaN)
    $.dispatch = false

    if (!inst?.id || !Number.isInteger(id))
      return { status: 'unusable-setup', eventId, reference: who || null }

    const customer = await system.customer.findFirst({ where: { id } })
    if (!customer) return { status: 'unknown-customer', eventId, reference: who }

    // Already filed. A redelivery of an event whose row survived is the same
    // answer as a duplicate id — the ledger check above only catches the ones
    // that arrive under the same event.
    const held = await system.paymentMethod.findFirst({ where: { providerRef: String(inst.id) } })
    if (held) return { status: 'already-filed', eventId, paymentMethod: held.id }

    // The newest card is the one a renewal reaches for, which is what a person
    // adding one means. **One default per customer is still not declarable** —
    // the predicate is expressible since `FJS-603`, and the DECLARATION is not,
    // because this model already indexes `customerId` for the ordinary read and
    // an index is named for its columns alone (`FJS-614`) — so these two writes
    // are the invariant, and they are only sound because `record` is `transactional:`:
    // between the clear and the create there is an instant with no default at
    // all, and a renewal landing in it charges nobody and duns them for it.
    await system.paymentMethod.updateMany({
      where: { customerId: customer.id, isDefault: true },
      data:  { isDefault: false },
    })
    const filed = await system.paymentMethod.create({ data: {
      customerId:  customer.id,
      providerRef: String(inst.id),
      brand:       String(inst.brand ?? 'card'),
      last4:       String(inst.last4 ?? '0000'),
      expMonth:    Number(inst.expMonth ?? 12),
      expYear:     Number(inst.expYear ?? 2030),
      isDefault:   true,
      userId:      customer.userId ?? null,
    } })

    return { status: 'filed', eventId, paymentMethod: filed.id, customer: customer.id }
  }

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

  // ── The bank wants the cardholder ──────────────────────────────────────
  //
  // Neither a decline nor a success, which is why it is its own event and its
  // own status rather than a third `declineKind`. Nothing the shop can do
  // advances it: the money has not moved, re-presenting produces the same
  // answer, and the only thing that resolves it is a person answering their
  // issuer's challenge.
  //
  // So the row records WHERE to send them and stops. The invoice stays
  // `issued`, which means the dunning clock keeps running — correctly: a
  // challenge nobody ever answers is an invoice nobody ever pays, and the
  // deadline is the same one every other unpaid invoice is measured against.
  // What must NOT happen is a lapse at once, and it does not, because that is
  // the hard-decline path and this is not a decline.
  if (kind === 'payment.action_required') {
    // Out of order, exactly as the failure path below: a challenge delivered
    // after the payment has already been settled or refused is a provider
    // retrying an event it thinks it owes, and acting on it would move a
    // finished payment back to *waiting for somebody*.
    if (payment.status !== 'pending') {
      $.dispatch = false
      return { status: 'stale', eventId, payment: payment.id, was: payment.status }
    }

    $.dispatch = await system.payment.update({ where: { id: payment.id }, data: {
      status:    'requiresAction',
      actionUrl: body.data?.actionUrl ?? null,
    } })

    return { status: 'recorded', eventId, payment: payment.id,
             invoice: payment.invoiceId ?? null, action: 'required' }
  }

  if (kind === 'payment.failed') {
    // The row is what goes on the wire, and it is the UPDATED row — the write
    // itself announces nothing, because callService is already announcing for
    // this service and the tap suppresses the double.
    $.dispatch = await system.payment.update({ where: { id: payment.id }, data: {
      status:        'failed',
      failureReason: body.data?.reason ?? null,
    } })

    // ── A subscription payment: a decline is a DOMAIN answer ──────────────
    //
    // For an order a declined card is nothing but a card — the shopper tries
    // another one. For a subscription it is the start of a process, and WHICH
    // process is decided by the code the provider sent: a soft decline is a
    // retry, because the money may be there tomorrow, and a hard one is an
    // answer that re-presenting cannot change. A shop that keeps re-presenting
    // a stolen card gets its merchant account reviewed.
    //
    // The MOVE is the subscription's own `lapse`, so the dunning clock starts
    // from the invoice's due date exactly as it does for a card nobody ever
    // tried — one deadline, one place. What the hard case skips is the grace,
    // and nothing else.
    if (payment.invoiceId) {
      const invoice = await system.invoice.findFirst({ where: { id: payment.invoiceId } }) as
        { id: number, status: string, subscriptionId: number | null } | null
      const hard = declineKind(body.data?.declineCode ?? null) === 'hard'

      // OUT OF ORDER. A provider retries an event it thinks it owes, so a
      // failure delivered after a settlement is ordinary rather than exotic —
      // and acting on it lapses a subscription that is paid up.
      //
      // The guard is the INVOICE's state and not the subscription's, because
      // the subscription is `active` in both the stale case and the real one.
      // `settle: issued -> paid` already stops the SUCCESS path being applied
      // twice; this is the same protection on the other side, and it is the
      // document's state machine doing the work in both directions.
      const stale = invoice && invoice.status !== 'issued'

      if (hard && !stale && invoice?.subscriptionId) {
        const sub = await system.subscription.findFirst({ where: { id: invoice.subscriptionId } }) as
          { id: number, status: string } | null
        // Asked before it is moved, for the same reason the order path asks:
        // a move the machine refuses is a 409 to the provider, which reads as
        // *retry this forever*.
        if (sub?.status === 'active') await system.subscription.transition(sub.id, 'lapse')
      }
      return { status: stale ? 'stale' : 'recorded', eventId, payment: payment.id,
               invoice: invoice?.id ?? null,
               decline: declineKind(body.data?.declineCode ?? null) }
    }

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
    // An exact comparison, because both are cents. It used to carry a half-cent
    // tolerance, which is what two floats needed to agree that they were equal.
    const whole = total >= payment.amount

    $.dispatch = await system.payment.update({ where: { id: payment.id }, data: {
      refundedAmount: total,
      ...(whole ? { status: 'refunded' } : {}),
    } })

    if (!whole) return { status: 'partly-refunded', eventId, payment: payment.id, refunded: back, order: null }

    // A refund against an INVOICE is a credit note, and issuing one is a
    // decision rather than a consequence — a shop that credited automatically
    // on every provider refund would write documents nobody authorized. So the
    // payment row is updated and the ledger says so; the note is `changePlan`'s
    // business or a person's.
    if (payment.invoiceId)
      return { status: 'refunded-invoice-payment', eventId, payment: payment.id, invoice: payment.invoiceId, refunded: back }

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
    // The challenge is answered, so the link stops being anywhere to send
    // anybody. Cleared rather than left: a screen that offers a stale one sends
    // a person to a page that answers 409 about a payment they already made.
    actionUrl: null,
  } })

  // The order may already be paid — a member of staff pressed the button while
  // the webhook was in flight, or an earlier delivery of a DIFFERENT event
  // settled it. The move would throw `TransitionViolationError`, which as a
  // 409 to the provider means "retry this forever". So the state is asked
  // first, and the two paths answer differently on purpose: `settled` means
  // this delivery moved the row, `already-paid` means it found it moved.
  // ── A subscription payment settles the INVOICE ────────────────────────
  //
  // `Payment` is `@@arc([orderId, invoiceId])`, so exactly one of the two is
  // set and this branch is decided by the row rather than by the event.
  //
  // Nothing here tells dunning that the money arrived: `dun-subscriptions`
  // reads the ledger, so a subscription sitting at `pastDue` with a clean
  // ledger recovers on its own. That is why an out-of-order delivery cannot
  // corrupt anything either — the state machine refuses a move from where the
  // row already is, and `settle` is `issued -> paid`.
  if (payment.invoiceId) {
    const invoice = await system.invoice.findFirst({ where: { id: payment.invoiceId } }) as
      { id: number, status: string } | null
    if (!invoice) return { status: 'unknown-invoice', eventId, payment: payment.id }
    if (invoice.status !== 'issued')
      return { status: 'already-paid', eventId, payment: payment.id, invoice: invoice.id, was: invoice.status }

    await settleInvoice(system, invoice.id)
    return { status: 'settled', eventId, payment: payment.id, invoice: invoice.id }
  }

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
