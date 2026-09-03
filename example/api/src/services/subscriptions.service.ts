// A standing arrangement, and what a person may ask of it.
//
// **Every one of the four declared moves is `@system`** — `activate` when a
// trial converts, `lapse` when an invoice goes unpaid past its grace, `recover`
// when the ledger comes clean, and `cancel` when the renewal job reaches a
// period end and finds the flag below set. No request can ask for any of them,
// which is not a gate set high: a gate is a question about the caller, and
// *nobody may ask for this, ever* is a different sentence (`FJS-D150`).
//
// So what a person presses is here, and it is two methods over one `@system`
// column rather than a move: `cancel` sets `cancelAtPeriodEnd` and `resume`
// clears it. The row policy scopes both — staff act on any subscription, a
// subscriber on their own — and the `@@allow('update', userId == auth().id)`
// pair on the model is what says so, not a line of code here.
//
// **Neither method transitions anything**, and the ordering is the reason: the
// arrangement ends at the boundary, so between the press and the boundary there
// is nothing to undo and `resume` is an ordinary write rather than a move back
// out of a terminal state.
import { createBaseService, $ } from '@frontierjs/junction'
import { changePlan }           from '../domain/billing'

/** The scoped client for this call, loosely typed — `orders.service.ts` carries
 *  the same line for the same reason. */
const subs = () => $.db as Record<string, any>

/** Set or clear `cancelAtPeriodEnd` on the subscription this call names.
 *
 *  One function for both verbs because they are one write with one refusal
 *  between them, and two copies of a state check is how the two ends up
 *  disagreeing about what `cancelled` means.
 *
 *  The read is through the CALLER's client, so a subscription this caller may
 *  not see is a 404 here exactly as it is on `get` — reading it with
 *  `asSystem()` to grade the state first would answer *that one is already
 *  cancelled* about a row the asker has no right to know exists.
 */
async function setCancelling(on: boolean) {
  const db  = subs()
  const row = await db.subscription.findFirst({ where: { id: Number($.id) } })
  if (!row) throw Object.assign(new Error('No such subscription'), { status: 404 })

  if (row.status === 'cancelled')
    throw Object.assign(
      new Error(on
        ? 'That subscription has already ended'
        : 'That subscription has ended — starting again is a new one, at the price open today'),
      { status: 409 })

  return await db.subscription.update({
    where:  { id: row.id },
    data:   { cancelAtPeriodEnd: on },
    system: ['cancelAtPeriodEnd'],
  })
}

export function createSubscriptionsService() {
  return createBaseService({
    model:   'Subscription',
    channel: 'subscriptions',

    /**
     * Stop it renewing — at the end of the period, not now.
     *
     * The period has been paid for, so ending it the moment somebody asks
     * forfeits the rest of it. `renew-subscription` reads the flag when it
     * reaches the boundary and cancels there instead of issuing.
     *
     * It does NOT touch invoices. An invoice already issued is a document
     * (`FJS-D162`) and the money is owed whether or not the arrangement
     * continues — cancelling a subscription that owes for last month and having
     * the debt vanish is the behaviour a shop cannot have.
     *
     * `system:` names the one column this may write. It keeps the model's gate,
     * its row policies and the audit actor, where `asSystem()` would drop all
     * three to set a boolean.
     */
    cancel: async () => setCancelling(true),

    /**
     * Change your mind, while the window is still open.
     *
     * Refused once the row is `cancelled`, and the refusal is the honest one
     * rather than a convenience: coming back after the boundary is a NEW
     * arrangement at whatever `PlanVersion` is open now, which is the whole
     * argument for versioning a price in the first place. Reviving the old row
     * would quietly restore a price that is no longer for sale.
     */
    resume: async () => setCancelling(false),

    /**
     * Move to a different price, a different quantity, or both — now.
     *
     * The money for the rest of the period is settled at the same moment, and
     * WHICH document that is comes out of the schema rather than out of a
     * branch: an upgrade owes money and is an invoice, a downgrade is owed
     * money and is a credit note, because `Invoice.subtotal` is `@gte(0)` and
     * the Data boundary refuses a negative document. `api/src/domain/billing` is
     * the one owner of the arithmetic and this only names the call.
     *
     * `asSystem()` because issuing is a system context by declaration —
     * `Invoice` is `@@gate("1.8.8.8")` — and what that does NOT drop is
     * `@immutable`, which is why the numbers it writes can never be restated.
     * The caller's own right to be here is graded before this line runs, by the
     * model's gate and its row policies.
     */
    changePlan: async () => {
      const body = ($.data ?? {}) as { planVersionId?: number, quantity?: number }
      // The one rule a field validator cannot hold: it is about the
      // RELATIONSHIP between two optional fields, so `PlanChange` in the seed
      // types and bounds each of them and this says they may not both be absent.
      if (body.planVersionId == null && body.quantity == null)
        throw Object.assign(new Error('Name a plan version, a quantity, or both'), { status: 400 })

      const db = $.db as any
      return await changePlan(db.asSystem(), Number($.id), body)
    },

    // Stated whole, because declaring one method declares the list — a service
    // that named only `cancel` would answer 405 to `find`. `surface.snapshot.md`
    // carries this and CI fails a stale one.
    //
    // `input:` names the `type` in db/schema.lite, so the payload is validated
    // exactly as a model create is — same generated JSON Schema, same wording,
    // same 400 (`validateInput`).
    methods: [
      'find', 'get', 'create', 'update', 'patch', 'remove', 'cancel', 'resume',
      { method: 'changePlan', input: 'PlanChange' },
    ],
  })
}
