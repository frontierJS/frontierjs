// What the shop sells on a cycle, and what it costs.
//
// `@@gate("0.5.5.5")` on both — a pricing page is read by a caller with no
// session, exactly as the catalogue and the delivery options are, and only
// staff change what a shop charges.
//
// Two services rather than one over a nested read, because they answer
// different questions and at different rates: `plans` is what is on offer and
// changes when the product does, `plan-versions` is a price with a lifetime and
// changes when the price does. `Plan.currentPrice` is a `@from` on the model,
// so a pricing page costs ONE query and never a join the client assembles.
import { createBaseService, $ } from '@frontierjs/junction'

export function createPlansService() {
  return createBaseService({
    model:   'Plan',
    channel: 'plans',

    /**
     * Charge something else from now on.
     *
     * A price is `@immutable`, so this is not a PATCH and cannot be: raising
     * what a plan costs is CLOSING the open window and OPENING the next one,
     * and the two halves are one write or they are a plan with two current
     * prices — or none — for however long the second statement took to arrive.
     * `transactional:` below is what makes them one.
     *
     * **The invariant is the schema's since `FJS-603`** — `@@unique([planId],
     * where: effectiveTo == null)`, where `@@unique([planId, effectiveTo])` was
     * satisfied by every open row there is, two NULLs never comparing equal.
     * What this method still owns is the ORDER: the constraint refuses the
     * second open row and does not close the first. The refusal below is for a
     * database written before the constraint existed, and it is honest rather
     * than assumed: a plan somehow holding two open windows is reported, not quietly
     * repaired, because which of the two was the real price is not a question
     * this code can answer.
     *
     * No gate check is written here and none is needed. A custom method is not
     * in `gateAuth`'s map — the operation is a property of the method, and this
     * one is not CRUD — so what refuses a shopper is the Data boundary itself:
     * both writes go through `$.db`, the request's own scoped client, and
     * `PlanVersion` is `@@gate("0.5.5.5")`.
     *
     * Existing subscribers are untouched, which is the whole reason
     * `Subscription` names a version rather than a plan: somebody who signed up
     * in February keeps February's price until something explicitly moves them,
     * and that something is `subscriptions.changePlan`.
     */
    reprice: async () => {
      const db     = $.db as any
      const planId = Number($.id)
      const price  = Number(($.data as { price?: number } | undefined)?.price)
      const at     = new Date().toISOString()

      const open = await db.planVersion.findMany({ where: { planId, effectiveTo: null }, limit: 3 })

      // Two open windows is a shop with two current prices. It cannot be put
      // right from here — picking one would be this method inventing which
      // price the subscribers under the other one were actually charged.
      if (open.length > 1) {
        throw Object.assign(
          new Error(`Plan ${planId} has ${open.length} open price windows; close all but one before repricing`),
          { status: 409 })
      }

      // Closed at the instant the next one opens, so the windows touch with no
      // gap and no overlap: `Plan.currentPrice` reads the open one, and a
      // lookup by date finds exactly one window holding it.
      if (open.length === 1) {
        await db.planVersion.update({ where: { id: open[0].id }, data: { effectiveTo: at } })
      }

      return await db.planVersion.create({ data: { planId, price, effectiveFrom: at } })
    },

    // Declaring one method declares the list. `input:` names the `type` in
    // db/schema.lite, so `price` is bounded and worded by the seed rather than
    // by a check written here.
    methods: [
      'find', 'get', 'create', 'update', 'patch', 'remove',
      { method: 'reprice', input: 'PlanPrice' },
    ],

    // Close-then-open is one statement about what a plan costs. Under BEGIN
    // IMMEDIATE a second repricer waits rather than reading the window this one
    // is halfway through closing.
    transactional: ['reprice'],
  })
}
