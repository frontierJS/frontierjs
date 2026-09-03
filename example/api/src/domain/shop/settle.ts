// api/src/domain/shop/settle.ts — an order has been paid for.
//
// Two callers reach this and they could hardly be less alike: a member of
// staff pressing Mark paid (`orders.pay`), and a provider's webhook arriving
// at four in the morning (`payments.record`). What has to happen is identical
// — move the row, and owe somebody an email — and writing it twice is how the
// two quietly stop agreeing, usually by one of them forgetting the second half.
//
// ─── Why this takes no client, no context and no transaction ─────────────
//
// It reads `$`, junction's ambient SERVICE CALL. `$.db` is the caller's own
// scoped Litestone client — already swapped to the transaction client if the
// calling method declared `transactional:` — and `$.enqueue` is that call's
// outbox. So this function inherits the caller's principal, the caller's
// transaction and the caller's audit actor without any of the three being
// threaded through a parameter that every future caller would have to
// remember to pass.
//
// It is the shape `$` exists for, and the cost is stated: called outside a
// service call it throws by name rather than doing something plausible. That
// is the whole of what makes an ambient dependency acceptable.
//
// BOTH callers must declare `transactional:`. `$.enqueue` refuses outside a
// transaction — an outbox row is only worth writing if it rolls back with the
// write it belongs to — so getting it wrong is a refusal naming the service
// and the method, not a silent half-effect.

import { $ }              from '@frontierjs/junction'
import announcePayment    from '../../jobs/announce-payment.job.ts'
import { restock }        from './inventory.ts'

/** The one verb Junction's minimal client type does not declare —
 *  `transition` is Litestone's, off `@@transitions` in db/schema.lite. */
type WithTransitions = {
  order: { transition(id: unknown, name: string): Promise<unknown> }
}

export interface SettledOrder {
  id:        number
  reference: string
  status:    string
  total:     number
}

/**
 * Move the order to `paid` and queue the announcement.
 *
 * The move is Litestone's: `pending -> paid`, narrowed with the expected state
 * in the WHERE, so two callers racing it — the seller pressing the button as
 * the webhook lands — produce one winner and one `TransitionConflictError`
 * rather than two silent successes. Nothing here compares a status; every rule
 * about this move is in the seed.
 *
 * The announcement is an OUTBOX row and not a dispatch, for the reason
 * `orders.pay` has always had: a dispatch is a second thing that happens after
 * the move commits with nothing joining the two, so a process dying in between
 * leaves an order that is paid and a customer nobody ever told, with no row
 * anywhere saying it was owed.
 */
export async function settleOrder(orderId: number): Promise<SettledOrder> {
  const order = await ($.db as unknown as WithTransitions)
    .order.transition(orderId, 'pay') as SettledOrder

  await $.enqueue(announcePayment, { orderId: order.id })

  return order
}

/**
 * Move the order to `refunded` and put its items back on the shelf.
 *
 * The counterpart of `settleOrder`, and it has the same two callers for the
 * same reason: `orders.refund` is a member of staff who handled the money
 * some other way, and `payments.record` is the provider confirming a refund
 * the shop asked for. What must happen is identical.
 *
 * ─── Why the shelf is in here and not beside one caller ──────────────────
 *
 * It was beside neither, which is the defect this closes. `orders.refund` was
 * the move alone, so refunding an order took the money question seriously and
 * left the stock sold — the shelf stayed one item short for ever, with the
 * ledger correctly recording a sale that had been reversed everywhere else.
 * The shelf is not a detail of how the refund was requested.
 *
 * `restock` reads the ledger rather than the basket, so this is right for an
 * order whose basket has since been swept — see `api/src/domain/inventory.ts`.
 *
 * The gate is NOT checked here. `refund: paid -> refunded @gate(5)` is in the
 * seed and Litestone enforces it against the caller in scope, which for the
 * webhook path is the shop itself; the caller who ASKED was graded by
 * `payments.refund`, against the same declaration, before any money moved.
 */
export async function refundOrder(orderId: number): Promise<SettledOrder> {
  const order = await ($.db as unknown as WithTransitions)
    .order.transition(orderId, 'refund') as SettledOrder

  // The system client: an InventoryMovement is `@@gate("5.5.9.9")` and a
  // refund may be confirmed by a webhook, which is nobody. `restock` is handed
  // a client rather than reaching for one, which is what makes that a decision
  // at every call site (`api/src/domain/inventory.ts`).
  const system = ($.db as unknown as { asSystem(): never }).asSystem()
  await restock(system, order.reference, `refund of ${order.reference}`)

  return order
}
