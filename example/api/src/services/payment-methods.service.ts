// The cards this shop is holding, and the one thing a person does to get one
// there.
//
// ─── Why there is a service at all, when every write is `@system` ─────────
//
// `PaymentMethod` is `@@gate("1.8.8.8")`: an instrument exists because the
// PROVIDER says it does, off a signed event, and no request writes one. So this
// service is the reads — a person looking at which card is on file — plus
// `startSetup`, which is not a write at all. It asks the provider to open a
// conversation and hands back an id; what comes of that conversation arrives
// later, on the webhook, and `payments.record` is what files it.
//
// That split is the security property rather than a layering preference. A
// method that took a card's details, or that took a provider handle from the
// caller, would let anybody attach an instrument to anybody — and the browser
// that confirmed is on the person's own machine, so it is not a caller this
// shop can believe about whose card was filed.
import { createBaseService, $ } from '@frontierjs/junction'
import { createSetupIntent }    from '../providers/psp/index.ts'

const bad = (message: string, status = 400) => Object.assign(new Error(message), { status })

export function createPaymentMethodsService() {
  return createBaseService({
    model:   'PaymentMethod',
    channel: 'payment-methods',

    /**
     * Begin filing a card, for the caller's OWN customer record.
     *
     * Addressed at the collection and taking no id, because *whose card* is not
     * a parameter: it is read off the caller's own client, where the row policy
     * on `Customer` has already narrowed the answer to their record. Staff
     * filing a card on somebody else's behalf is deliberately not offered —
     * that is a person reading a card number down a telephone, which is the one
     * thing this arrangement exists to avoid.
     *
     * Answers the provider's setup-intent id. The caller's next step is the
     * provider's own page, not this app: the shop never sees a card number and
     * there is no route by which it could.
     */
    startSetup: async () => {
      const db   = $.db as Record<string, any>
      const mine = await db.customer.findFirst({})
      if (!mine) throw bad('There is no customer record for this account', 404)

      // `CUS-<id>` and not a bare number: it comes back on the event as the
      // shop's own reference, and a reference that could be confused with a
      // provider's own id is the shape that files a card against the wrong
      // person the day the provider echoes something else.
      const { setup, error } = await createSetupIntent($.app!, { reference: `CUS-${mine.id}` })
      if (error || !setup)
        throw bad(error?.message ?? 'The payment provider could not be reached', 502)

      return { id: setup.id, status: setup.status, customer: mine.id }
    },

    // Stated whole, because declaring one method declares the list. There is no
    // create, update, patch or remove: every write is the system's, and a
    // service that answered 403 to them would be saying *not you* where the
    // truth is *nobody*.
    //
    // Removal is the one absence worth naming. It wants rules this does not
    // have — which card the default moves to, and what happens to a live
    // subscription whose only instrument has just gone — and a `remove` that
    // leaves a subscriber unbillable without saying so is worse than not
    // offering one.
    methods: ['find', 'get', 'startSetup'],
  })
}
