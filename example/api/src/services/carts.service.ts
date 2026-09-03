import { createBaseService, $ } from '@frontierjs/junction'
import { hold, release, consume, heldUntil, levelsFor, HOLD_MINUTES } from '../domain/shop'
import { priceBasket, contextFor, discountByCode, discountProblem } from '../domain/shop'
import type { CustomField } from '../domain/shop/custom-fields.ts'
import { checkoutCodeFor } from '../domain/shop'
import { postJournal, saleJournal } from '../domain/ledger.ts'

// The basket. Its ACCESS is entirely in db/schema.lite — `@@allow('read',
// token == auth().cartToken)` on both models — so nothing in this file checks
// who is calling. What it adds is the three things a policy cannot express:
// minting a basket, adding to it at the price the shopper is being shown, and
// turning it into an order.
//
// ─── Why the token is answered ONCE ───────────────────────────────────────
//
// `Cart.token` is `@guarded`, so it is stripped from every response — which is
// the point: the only way to hold one is to have been given it. `open` is the
// one method that gives it, and it is a custom method rather than `create` for
// exactly that reason, since a CRUD create would answer the row and the row no
// longer carries the secret.

/** How long a handoff code is good for. Long enough to click a link, short
 *  enough that a leaked URL is worth almost nothing. */
const HANDOFF_MINUTES = 2

type CartRow  = { id: number, token: string, status: string, discountId?: number | null, shippingMethodId?: number | null }
type LineRow  = { id: number, variantId: number, quantity: number, unitPrice: number }
type Variant  = { id: number, price: number, stock: number, active: boolean, sku: string }

/** A line as a BASKET SCREEN needs it. A row carrying `variantId: 7` is not a
 *  basket line to anybody looking at one, and the alternative to joining here
 *  is every screen loading the variant and product tables to render six rows. */
type DisplayLine = LineRow & {
  sku:     string
  productId: number
  colour:  string
  size:    string
  /** What this shopper may raise the line to — on hand, less everybody ELSE's
   *  holds. Not `stock`: the number a stepper's max is set from is a question
   *  about this basket, and the shopper's own hold must not count against
   *  them. */
  available: number
  product: string
  image:   string | null
  alt:     string | null
  total:   number
}

/**
 * The system client, for the three things a shopper's own client cannot do.
 *
 *   the token     minting a basket (nothing can be scoped by a token that does
 *                 not exist yet) and reading one back to answer with it
 *   the holds     StockReservation is `@@gate("5.8.8.8")` — a stranger may
 *                 neither read the holds nor write one, and availability is a
 *                 sum over EVERYBODY's
 *   the sale      an InventoryMovement is the shop's own record of its act
 *
 * Every other read below goes through the caller's own scoped client, so the
 * policies do the work. Under `transactional:` this is still the transaction's
 * connection — `asSystem()` returns a scoped proxy over the same one, so a
 * hold taken here rolls back with the line it was taken for.
 */
const sys = () => ($.db as { asSystem(): Record<string, any> }).asSystem()

/**
 * This shop's declared custom fields. One read per call that needs them.
 *
 * Separate from `audienceFor` because checkout already holds the customer and
 * only wants this half — and because a shop that has declared nothing gets an
 * empty list here rather than a null the audience check would have to special
 * case.
 */
async function declaredFields(system: any): Promise<CustomField[]> {
  return await system.customField.findMany({})
}

/**
 * Who the basket belongs to, for a code that names an audience.
 *
 * `Customer.userId` is `@unique`, so a signed-in basket resolves to exactly one
 * person. A guest basket answers `{ customer: null }` and an audience code is
 * then refused by name — which is the honest answer: the shop cannot tell
 * whether a stranger is in the audience, and honouring the code because it
 * cannot tell is how an audience stops meaning anything.
 */
async function audienceFor(system: any, userId: string | null | undefined) {
  const declared = await declaredFields(system)
  if (!userId) return { customer: null, declared }
  return { customer: await system.customer.findFirst({ where: { userId } }), declared }
}

export function createCartsService() {
  return createBaseService({
    model:   'Cart',
    channel: 'carts',

    // Narrowed deliberately. A basket is opened, added to and checked out; it
    // is not listed, and `find` over Cart would answer the caller's own single
    // row at best and is a question nobody asks. Declaring `methods:` also
    // makes every verb NOT named here answer 405 rather than existing quietly.
    methods: [
      'get', 'open', 'addLine', 'setQuantity', 'removeLine',
      // The money. Neither is a write of an amount — `applyDiscount` takes a
      // CODE and answers what it is worth to this basket, `setShipping` takes a
      // method and checks it is on offer. Both columns are `@system` precisely
      // so that the basket's own update policy, which is what lets a stranger
      // work their own stepper, cannot be used to point them anywhere.
      { method: 'applyDiscount', input: 'DiscountCode' },
      { method: 'setShipping',   input: 'ShippingChoice' },
      'removeDiscount',
      // The cross-origin pair. `handoff` is addressed to a basket and needs its
      // token; `redeem` is addressed to the collection and needs NOTHING but
      // the code, because the caller is a browser on the shop's own site that
      // has never held this basket. That asymmetry is the feature.
      'handoff', 'redeem',
      // The one method with a payload no model describes. `input:` names a
      // `type` in db/schema.lite, so the 400 a bad checkout gets is generated
      // from the seed like a model's — same wording, same shape, and <Form>
      // renders it. Without it `$.data` is whatever arrived on the wire.
      { method: 'checkout', input: 'CheckoutDetails' },
    ],

    // Every method that touches stock, which since holds arrived is all four.
    //
    // `checkout` was always here: the order, the shelf coming down, the customer
    // and the basket closing are one thing or they are a bug. The other three
    // joined it with the holds, and they need it for a different reason — each
    // is a read-modify-write over a number two shoppers are competing for.
    // Checking availability and then writing the hold is precisely the
    // interleaving that lets both of them past the check, and Litestone opens a
    // transaction with `BEGIN IMMEDIATE`, taking the write lock up front, so the
    // second shopper waits and then reads the first one's hold.
    //
    // It was already racy before this — `wanted > variant.stock` and the line
    // write had the same shape — and it did not matter, because stock only ever
    // moved at checkout. Adding the hold is what made the window real.
    transactional: ['addLine', 'setQuantity', 'removeLine', 'checkout', 'redeem'],

    /**
     * Mint a basket and answer its token. The ONE call that ever returns it.
     *
     * Addressed to the collection (`invoke('open', null)`), because there is no
     * row yet to address.
     */
    async open() {
      const cart = await sys().cart.create({ data: {} }) as CartRow
      return { ...await view(cart), token: cart.token }
    },

    /** The basket and its lines. Both reads go through the CALLER's client, so
     *  a token that is not theirs answers nothing rather than someone else's
     *  basket — the policy is what makes that true, not this function. */
    async get() {
      const cart = await $.db.cart.findFirst({ where: { id: Number($.id) } }) as CartRow | null
      if (!cart) throw notFound()
      return await view(cart)
    },

    /**
     * Put a variant in the basket, at the price being shown right now, and take
     * a HOLD on the stock for it.
     *
     * The price is COPIED rather than joined at read time. A basket left
     * overnight has to either honour what it quoted or say out loud that it
     * changed, and it can do neither if the number was never written down.
     *
     * The hold is taken FIRST, and it is what refuses: `api/inventory.ts` reads
     * on hand less everybody else's unexpired holds and throws the shop's own
     * sentence naming the SKU. This method contains no comparison of its own,
     * which is the point — there is one definition of *may this be sold* and
     * the product page, the basket stepper and the checkout all ask it.
     */
    async addLine() {
      const cart = await open$()
      const { variantId, quantity = 1 } = ($.data ?? {}) as { variantId?: number, quantity?: number }

      const variant = await $.db.productVariant.findFirst({ where: { id: Number(variantId) } }) as Variant | null
      if (!variant) throw bad('That product is no longer on sale')

      const existing = await $.db.cartLine.findFirst({
        where: { cartId: cart.id, variantId: variant.id },
      }) as LineRow | null

      // A second "navy / m" is a QUANTITY change and not a second row — which
      // the composite @@unique would refuse anyway, with SQLite's words rather
      // than the shop's.
      const wanted = (existing?.quantity ?? 0) + Math.max(1, Number(quantity) || 1)

      // Refuses with a 409 and `retryable` where the shelf moved under the
      // shopper, and a 400 where the variant is off sale. The hold is upserted,
      // so raising a quantity moves one row and refreshes its clock.
      await hold(sys(), cart.id, variant.id, wanted)

      if (existing) {
        await $.db.cartLine.update({ where: { id: existing.id }, data: { quantity: wanted } })
      } else {
        await $.db.cartLine.create({ data: {
          cartId:    cart.id,
          variantId: variant.id,
          token:     await tokenOf(cart.id),
          quantity:  wanted,
          // @system — the application sets the price, never the caller. Named
          // on the write so the gate, the row policies and the audit actor all
          // still apply, where asSystem() would drop all three to set one value.
          unitPrice: variant.price,
        }, system: ['unitPrice'] })
      }

      return await view(cart)
    },

    /** Change how many. Zero removes — a stepper that bottoms out at 1 and
     *  needs a separate button to reach 0 is two controls for one idea. */
    async setQuantity() {
      const cart = await open$()
      const { lineId, quantity } = ($.data ?? {}) as { lineId?: number, quantity?: number }
      const n = Number(quantity)

      const line = await $.db.cartLine.findFirst({ where: { id: Number(lineId), cartId: cart.id } }) as LineRow | null
      if (!line) throw notFound('No such line in this basket')

      if (!Number.isFinite(n) || n <= 0) {
        await $.db.cartLine.delete({ where: { id: line.id } })
        // The line and its hold go together. A hold left behind would keep
        // stock reserved against a line that no longer exists until the sweep
        // noticed — the shop refusing to sell something nobody is buying.
        await release(sys(), cart.id, line.variantId)
        return await view(cart)
      }

      // The same one definition as `addLine`, and this is the call that needs
      // `exceptCartId` most: a shopper holding 2 of the last 5 who raises the
      // line to 3 is asking about stock that is already being kept for them.
      // Summing every hold would refuse it.
      await hold(sys(), cart.id, line.variantId, n)

      await $.db.cartLine.update({ where: { id: line.id }, data: { quantity: n } })
      return await view(cart)
    },

    async removeLine() {
      const cart = await open$()
      const { lineId } = ($.data ?? {}) as { lineId?: number }
      const line = await $.db.cartLine.findFirst({ where: { id: Number(lineId), cartId: cart.id } }) as LineRow | null
      if (!line) throw notFound('No such line in this basket')

      await $.db.cartLine.delete({ where: { id: line.id } })
      await release(sys(), cart.id, line.variantId)
      return await view(cart)
    },

    /**
     * Put a code on the basket, or say why it is worth nothing.
     *
     * Takes a STRING and answers a basket. Never an amount in either direction:
     * what a code is worth is a function of this basket at this instant, and a
     * caller who could state it could state any of it.
     *
     * The refusal is `pricing.ts`'s sentence rather than one written here, and
     * that is the point of putting it there — `checkout` re-checks the same
     * code against the same rules a moment later, and a shopper told *expired*
     * at the till after being told *applied* in the basket has been told two
     * different things by two copies of one rule.
     *
     * Reads and writes through the SYSTEM client, for two different reasons
     * that happen to point the same way: `Discount` is staff-only to read, and
     * `Cart.discountId` is `@system` so that the basket's own update policy —
     * which lets its holder move a quantity without a session — cannot also
     * move the discount.
     */
    async applyDiscount() {
      const cart = await open$()
      const { code } = ($.data ?? {}) as { code?: string }

      const system   = sys()
      const discount = await discountByCode(system, code ?? '')

      // Priced BEFORE the code goes on, because a minimum spend is a question
      // about the lines and the answer must not include the discount it is
      // gating.
      const lines    = await linesOf(cart.id)
      const subtotal = lines.reduce((n, l) => n + l.total, 0)

      // An audience code needs to know WHO. A signed-in basket carries
      // `userId` and `Customer.userId` is unique, so the row is one lookup; a
      // guest basket has nobody, and `discountProblem` refuses an audience code
      // by name rather than applying it to a person it cannot identify.
      const problem = discountProblem(discount, subtotal, new Date(),
        await audienceFor(system, cart.userId))
      if (problem) throw bad(problem)

      await system.cart.update({ where: { id: cart.id }, data: { discountId: discount!.id } })

      return await view({ ...cart, discountId: discount!.id })
    },

    /** Take it off. Silent about a basket that had none — a shopper pressing
     *  *remove* has already got what they asked for. */
    async removeDiscount() {
      const cart = await open$()
      await sys().cart.update({ where: { id: cart.id }, data: { discountId: null } })
      return await view({ ...cart, discountId: null })
    },

    /**
     * Choose how it is sent, or go back to undecided.
     *
     * Null is a legitimate value and is why there is no `clearShipping` beside
     * this. What is NOT legitimate is a method that is switched off: the
     * storefront lists the active ones, and a caller naming an inactive row is
     * either a stale page or somebody trying it on — the shop refuses by name
     * either way, because silently pricing at zero would ship for free.
     */
    async setShipping() {
      const cart = await open$()
      const { shippingMethodId } = ($.data ?? {}) as { shippingMethodId?: number | null }

      let chosen: number | null = null
      if (shippingMethodId != null) {
        // The CALLER's client — `ShippingMethod` is `@@gate("0.5.5.5")` and a
        // storefront has to be able to read it, so there is nothing here a
        // guest is not entitled to see.
        const method = await $.db.shippingMethod.findFirst({
          where: { id: Number(shippingMethodId) },
        }) as { id: number, active: boolean } | null

        if (!method || !method.active) throw bad('That delivery option is no longer available')
        chosen = method.id
      }

      await sys().cart.update({ where: { id: cart.id }, data: { shippingMethodId: chosen } })

      return await view({ ...cart, shippingMethodId: chosen })
    },

    /**
     * Mint a one-time code that hands this basket to another origin.
     *
     * The case is an embeddable buy button: it runs on a page the shop does not
     * own, so its token is in that origin's `localStorage` and the shop's own
     * site cannot read it. Sending the shopper to checkout is therefore handing
     * a capability ACROSS an origin, and the token must not be the thing that
     * travels — a URL is written to history, to a `Referer` and to every log on
     * the way, and this one is good for the life of the basket.
     *
     * A code is worth one basket, for two minutes, once. It is 32 hex
     * characters from the platform's CSPRNG rather than anything derived from
     * the basket, because a code you can compute from an id is not a code.
     *
     * Reached through the CALLER's client for the read, so only the holder of
     * the basket can ask for one; written through the system client, because
     * both columns are `@guarded` and a guard locks BOTH directions.
     */
    async handoff() {
      const cart = await open$()

      const code = [...crypto.getRandomValues(new Uint8Array(16))]
        .map(b => b.toString(16).padStart(2, '0')).join('')

      await sys().cart.update({ where: { id: cart.id }, data: {
        handoffCode:    code,
        handoffExpires: new Date(Date.now() + HANDOFF_MINUTES * 60_000).toISOString(),
      } })

      return { code, expiresInSeconds: HANDOFF_MINUTES * 60 }
    },

    /**
     * Exchange a code for the basket it names.
     *
     * The ONE method here that answers a token to a caller who is not already
     * holding one — `open` mints a new basket, this one hands over an existing
     * one — so everything about it is about making the window small:
     *
     *   · single use — the code is cleared in the same write that reads it, and
     *     `transactional:` is what makes "read it and clear it" one step rather
     *     than two a second caller can get between
     *   · short lived — two minutes, checked here rather than swept, for
     *     `StockReservation`'s reason: a read that depends on a cron having run
     *     is a shop that stops working when the queue does
     *   · unguessable — 128 bits, so there is nothing to enumerate
     *
     * Addressed to the COLLECTION, because the caller does not know the basket's
     * id: finding out is what the code is for.
     *
     * Answers the same basket shape every other method answers, plus the token
     * — the browser redeeming this is about to hold it.
     */
    async redeem() {
      const { code } = ($.data ?? {}) as { code?: string }
      if (typeof code !== 'string' || !/^[0-9a-f]{32}$/.test(code))
        throw bad('That checkout link is not one this shop issued')

      // `asSystem()` because both columns are `@guarded` — and because the
      // caller has no claim at all yet, which is the whole point: the code IS
      // the credential, and it is checked here rather than by a policy.
      const system = sys()
      const cart = await system.cart.findFirst({ where: { handoffCode: code } }) as
        (CartRow & { handoffExpires: string | null }) | null

      if (!cart) throw notFound('That checkout link has already been used, or was never issued')
      if (cart.status !== 'open') throw bad('That basket has already been checked out')
      if (!cart.handoffExpires || Date.parse(cart.handoffExpires) <= Date.now())
        throw bad('That checkout link has expired — go back and try again')

      // Cleared BEFORE the answer, in the same transaction. A code that
      // survives its own redemption is a bearer token with a nicer name.
      await system.cart.update({ where: { id: cart.id }, data: {
        handoffCode: null, handoffExpires: null,
      } })

      // Built through the SYSTEM client, and this is the one call where that is
      // right. Every other method here reads lines through the caller's own
      // client so `@@allow('read', token == auth().cartToken)` does the work —
      // and the caller redeeming a code holds no claim yet, because the claim
      // rides a header on the NEXT request. Reading as the caller answers a
      // basket with `lines: []` and `count: 0`: a wrong policy is an empty
      // screen, not an error, and this one arrives as a shopper who followed a
      // checkout link to an empty basket.
      //
      // The proof is the code: single use, two minutes, issued to whoever was
      // already holding this basket. That is the same evidence the token would
      // have been.
      return { ...await view(cart, system), token: cart.token }
    },

    /**
     * The basket becomes an order.
     *
     * `transactional: true` on the method is what makes the four writes below
     * one thing: the order, its total, the stock coming down and the basket
     * closing either all happen or none do. Without it a crash between the
     * order and the decrement sells stock the shop does not have, and the
     * basket stays open so the shopper buys it again.
     *
     * An `Idempotency-Key` on the request makes a retry replay the first
     * answer rather than place a second order — claimed in `callService`, so it
     * holds over HTTP and the socket alike. A checkout button double-clicked on
     * a slow connection is the case, and it is the one place in this app where
     * the difference is a real order and real money.
     */
    async checkout() {
      const cart  = await open$()
      const lines = await linesOf(cart.id)
      if (!lines.length) throw bad('Your basket is empty')

      const { email, name, note } = $.data as { email: string, name: string, note?: string }

      // Stock is re-read INSIDE the transaction, and against ON HAND rather
      // than available: the shopper's own hold is what has been keeping this
      // stock for them, so counting it against them here would refuse the sale
      // the hold exists to guarantee.
      //
      // With a live hold this cannot fail — nothing else could have sold it.
      // What it catches is the basket whose hold ran out while the shopper was
      // typing their address, where somebody else legitimately took the last
      // one, and it says so in the shop's words rather than the warehouse's.
      const levels = await levelsFor(sys(), lines.map(l => l.variantId))
      for (const line of lines) {
        const lv = levels.get(line.variantId)
        if (!lv || lv.onHand < line.quantity) throw bad(
          `${lv?.sku ?? 'An item'} is no longer available in that quantity`,
        )
      }

      const system = sys()

      // ─── The money, decided once and re-decided here ────────────────────
      //
      // `l.total` and not the multiplication again: what the basket screen
      // showed and what the order is written for have to be one calculation,
      // and `priceBasket` is that calculation for both.
      //
      // The context is re-read INSIDE the transaction rather than trusted from
      // whenever the code was applied. Three things can have moved while the
      // shopper was typing their address — a code switched off, a code that
      // reached its limit on somebody else's checkout a second ago, a rate the
      // merchant edited — and this is the last moment any of them can be seen.
      // It is the same argument as the stock re-read above, for the same
      // reason: the basket quoted a number, and quoting is not charging.
      const context = await contextFor(system, cart)
      const money   = priceBasket(lines, context)

      // Refused BY NAME rather than quietly dropped. A basket that showed 10%
      // off and an order that charges full price is the shop taking money the
      // shopper did not agree to, and it is worse than a failed checkout
      // because nobody finds out. `discountProblem` is the same function
      // `applyDiscount` refused with, so the sentence is the one they were
      // already told the rules in.
      // A guest has no Customer row until this moment, and a returning one must
      // not get a second. `email` is @unique @lower, so this is the lookup.
      const existing = await system.customer.findFirst({ where: { email: email.toLowerCase() } })
      const customer = existing ?? await system.customer.create({ data: {
        email,
        name,
        firstName: name.split(' ')[0] ?? name,
        lastName:  name.split(' ').slice(1).join(' ') || name,
      } })

      // ─── The code, re-checked ───────────────────────────────────────────
      //
      // Refused BY NAME rather than quietly dropped. A basket that showed 10%
      // off and an order that charges full price is the shop taking money the
      // shopper did not agree to, and it is worse than a failed checkout
      // because nobody finds out. `discountProblem` is the same function
      // `applyDiscount` refused with, so the sentence is the one they were
      // already told the rules in.
      //
      // It happens HERE, below the customer, and that ordering is load-bearing
      // now that a code can name an audience: run above it there is no customer
      // row yet, so every audience code would refuse at checkout having been
      // accepted onto the basket — a discount a shopper watched apply and then
      // could not buy with.
      if (cart.discountId != null) {
        const problem = discountProblem(context.discount, money.subtotal, new Date(),
          { customer, declared: await declaredFields(system) })
        if (problem) throw bad(problem)
      }

      // ─── Whose sale is this ─────────────────────────────────────────────
      //
      // A basket does not need a session and never has — that is what
      // `verify:cart` is about. But a shopper who IS signed in is buying as
      // themselves, and this is the only moment anything knows it: the order is
      // written here, and afterwards it is a receipt.
      //
      // Two writes, and they are not the same fact. The order carries the id so
      // `@@allow('read', userId == auth().id)` can answer without traversing a
      // relation; the customer record carries it so the NEXT sale, and the
      // order history screen, find the person rather than a second record with
      // the same address.
      //
      // The customer link is written only when it is empty. It is `@unique`, so
      // overwriting one is taking somebody else's record — an address shared by
      // two accounts is a support conversation, not a silent reassignment.
      const buyer = $.me as { userId?: string } | null
      const buyerId = buyer?.userId ?? null
      if (buyerId && !customer.userId) {
        await system.customer.update({ where: { id: customer.id }, data: { userId: buyerId } })
      }

      // The breakdown is COPIED onto the order, every figure of it, and the
      // references are not — see `pricing.ts`'s header for why the two tables
      // are inverted. What matters at this call site is that nothing here
      // recomputes anything: `money` is spread whole, so the receipt and the
      // basket screen the shopper just pressed a button on are the same nine
      // numbers.
      const order = await system.order.create({ data: {
        reference:  `ORD-${Date.now().toString(36).toUpperCase().slice(-6)}`,
        customerId: customer.id,
        userId:     buyerId,
        ...money,
        note:       note ?? null,
      } })

      // ─── The redemption ──────────────────────────────────────────────────
      //
      // Counted only where the code was actually worth something. A basket
      // carrying an expired code prices at zero off and reaches here with
      // `discountCode: null`, and charging it a redemption would burn a limited
      // code on a discount nobody received.
      //
      // Read-modify-write and not `{ increment: 1 }`, for `stock`'s reason: an
      // atomic operator computes the new value inside SQLite where no validator
      // can see it, so a limit would be passed and the constraint would never
      // fire (`FJS-D27`). It is safe because this method is `transactional:` —
      // Litestone opens with `BEGIN IMMEDIATE` and takes the write lock up
      // front, so two shoppers racing for the last redemption of a code are
      // serialised and the second one reads the first one's count.
      //
      // In the SAME transaction as the order, which is the whole of what makes
      // it honest: a checkout that rolls back did not redeem anything.
      if (money.discountCode && context.discount) {
        await system.discount.update({
          where: { id: context.discount.id },
          data:  { redemptions: context.discount.redemptions + 1 },
        })
      }

      // What was bought, written down at the price it was bought for.
      //
      // Copies, not lookups — `OrderLine`'s own header argues why. What matters
      // at this call site is that `l.total` is carried across rather than
      // recomputed: the basket screen showed it, `total` above summed it, and
      // the line rows have to be the same arithmetic or the itemisation does
      // not add up to what was charged.
      //
      // `description` is the sentence the shopper read, assembled the way the
      // basket screen assembles it. A colourway renamed next year does not
      // un-sell this one.
      //
      // One `createMany`, not a loop: it is one write inside the checkout
      // transaction, and a bulk write announces `changed` rather than a row
      // apiece — which is the correct event here, since nothing has an order's
      // lines on screen at the moment they come into existence.
      await system.orderLine.createMany({ data: lines.map(l => ({
        orderId:     order.id,
        // The same id the order carries, for the same reason and at the same
        // moment. Two columns holding one fact is what a policy that cannot
        // reach through a relation costs (`FJS-499`); writing them in one
        // transaction is what stops them drifting.
        userId:      buyerId,
        variantId:   l.variantId,
        sku:         l.sku,
        description: [l.product, [l.colour, l.size].filter(Boolean).join(' · ')]
          .filter(Boolean).join(' — '),
        quantity:    l.quantity,
        unitPrice:   l.unitPrice,
        lineTotal:   l.total,
      })) })

      // ─── The books ───────────────────────────────────────────────────────
      //
      // The sale in double entry, inside the same transaction as everything
      // else — an order that rolls back did not post a journal, and a journal
      // that fails takes the order with it.
      //
      // `ledger.ts` owns the rule, and the rule is that the lines sum to zero.
      // It cannot fail here for an arithmetic reason: `saleJournal` is built
      // from the five figures `priceBasket` just decided, and `Order`'s own
      // `@@check` says those five add up. That is exactly why it is worth
      // asserting — the day somebody adds a sixth figure to a receipt and not
      // to the journal, this is what says so, and it says so before the money
      // is taken rather than at a month end.
      await postJournal(system, saleJournal({ id: order.id, reference: order.reference, ...money }))

      // The shelf comes down and the holds go away, together, through the one
      // module that owns both — every decrement writes an InventoryMovement in
      // the same breath, so `stock` and its ledger cannot drift.
      //
      // Read-modify-write inside `move()`, not `{ stock: { decrement: n } }`.
      // The atomic operator is refused by name on this column and the refusal
      // is right: `stock` carries `@gte(0)`, and an operator computes the new
      // value inside SQLite where no validator can see it, so a decrement past
      // zero would be written and the constraint would never fire (`FJS-D27`).
      // It is only safe because this method is `transactional:` — the re-read
      // above and these writes are in one transaction, so the interleaving that
      // loses one of two concurrent decrements cannot happen.
      //
      // The SYSTEM client, because a sale is the shop recording its own act and
      // the caller is a stranger at level 0. An administrator receiving stock
      // passes their own client instead, and the Data boundary is what grades
      // them — see the gate on InventoryMovement.
      await consume(system, cart.id, lines, order.reference)

      await system.cart.update({ where: { id: cart.id }, data: { status: 'ordered' } })

      // The whole breakdown back, not just the figure. A receipt screen that
      // had only a total would have to fetch the order to draw its own lines,
      // and the basket it would need to compare against has just been closed.
      // The checkout code with it, and this is the ONE call that answers one to
      // a shopper. They have no session and their basket has just closed, so a
      // moment from now nothing identifies them to this shop at all — the code
      // is what carries the right to pay for what they just bought (`FJS-497`).
      return {
        orderId:      order.id,
        reference:    order.reference,
        checkoutCode: checkoutCodeFor(order.id),
        ...money,
      }
    },
  })
}

// ─── helpers ──────────────────────────────────────────────────────────────

function bad(message: string) {
  const e = new Error(message) as Error & { status: number }
  e.status = 400
  return e
}

function notFound(message = 'No such basket') {
  const e = new Error(message) as Error & { status: number }
  e.status = 404
  return e
}

/** The basket this call is about, refused unless it is open. Read through the
 *  CALLER's client, so a token that is not theirs finds nothing. */
async function open$(): Promise<CartRow> {
  const cart = await $.db.cart.findFirst({ where: { id: Number($.id) } }) as CartRow | null
  if (!cart) throw notFound()
  if (cart.status !== 'open') throw bad('This basket has already been checked out')
  return cart
}

/** The token, which no response carries — `@guarded` strips it from the
 *  caller's own read, so writing a line's copy has to ask the system client. */
async function tokenOf(cartId: number): Promise<string> {
  const row = await sys().cart.findFirst({ where: { id: cartId } }) as CartRow
  return row.token
}

/**
 * The whole basket, as every method here answers it.
 *
 * One shape, because a screen that got a different one from `addLine` than
 * from `get` would have to know which call it had just made. The count and the
 * total are on it for the same reason the line total is: a header badge and a
 * checkout button must not each do their own arithmetic.
 *
 * `token` is absent and cannot be otherwise — the column is `@guarded`, so the
 * caller's own read strips it. `open` is the one method that puts it back.
 */
async function view(cart: CartRow, client: Record<string, any> = $.db) {
  const lines = await linesOf(cart.id, client)

  // The SYSTEM client, and it is not a convenience. `Discount` is
  // `@@gate("5.5.5.5")` — a shopper may not read the codes table at all, which
  // is the whole reason the gate is there — so the caller's own client answers
  // null and the basket would price at no discount with nothing saying why. A
  // wrong policy is an empty screen, and here the empty screen is a shopper
  // being charged full price for a code they can see in the box.
  const money = priceBasket(lines, await contextFor(sys(), cart))

  return {
    id:     cart.id,
    status: cart.status,
    lines,
    count:  lines.reduce((n, l) => n + l.quantity, 0),

    // The whole breakdown, flat, on every basket response.
    //
    // `total` is the GRAND total — what the card would be charged — and
    // `subtotal` is the lines. That is a change of meaning for a key that used
    // to be the sum of the lines, and it is the right way round: the number a
    // checkout button carries has to be the number the checkout writes.
    //
    // Every figure is the server's. `api/src/domain/shop` rounds each component
    // once and sums the rounded ones, so what a screen prints adds up by
    // construction — which is only true while a screen renders these and does
    // not re-derive any of them.
    ...money,

    // Which code is on the basket even where it is currently worth nothing —
    // an expired code has to stay visible and removable, because a shopper who
    // typed one and sees no line for it will type it again.
    discountId:       cart.discountId ?? null,
    shippingMethodId: cart.shippingMethodId ?? null,
    // The clock on the basket. Answered here rather than read by the browser
    // because StockReservation is `@@gate("5.…")` for reads — a shopper may not
    // see the holds table at all, including their own. They learn about their
    // own hold from the basket the shop builds for them, which is the only
    // place it is any of their business.
    heldUntil:   await heldUntil(sys(), cart.id),
    holdMinutes: HOLD_MINUTES,
  }
}

/**
 * The basket's lines, joined out to what a screen shows.
 *
 * The join is nested — line → variant → product — and it goes through the
 * CALLER's client like everything else here. That works for a stranger because
 * the catalogue reads at level 0: `Product` and `ProductVariant` are
 * `@@gate("0.4.4.5")`, so a guest may read them and may not write them. The
 * line itself is reached by the token policy.
 *
 * The image is the product's FIRST photograph rather than the variant's own,
 * which is a deliberate simplification: a colourway usually has one and a
 * basket row is 40 pixels wide.
 */
async function linesOf(cartId: number, client: Record<string, any> = $.db): Promise<DisplayLine[]> {
  const lines = await client.cartLine.findMany({
    where:   { cartId },
    orderBy: { id: 'asc' },
    include: { variant: { include: { product: { include: { images: true } } } } },
  }) as Array<LineRow & { variant?: Record<string, any> }>

  // What the stepper's max is, per line: on hand less everybody ELSE's holds.
  // The system client, because the sum is over holds a shopper may not read —
  // the NUMBER is theirs to know and the ROWS are not.
  const levels = await levelsFor(sys(), lines.map(l => l.variantId), { exceptCartId: cartId })

  // `token` is dropped rather than carried. It is the caller's own — the
  // policy is what let them read the row at all — so this is not a leak; it is
  // that a response should not repeat back a secret nobody asked it for.
  // `CartLine.token` cannot be `@guarded` the way `Cart.token` is: a guard
  // locks BOTH directions, and the guest writing their own line is refused by
  // it. The create policy is the protection instead.
  return lines.map(({ variant, token: _token, ...line }) => {
    const product = variant?.product ?? {}
    const photo   = (product.images ?? [])
      .slice()
      .sort((a: any, b: any) => a.position - b.position)[0]

    return {
      ...line,
      sku:     variant?.sku     ?? '',
      // The id and not the slug: /products/[id]/ is the route, and a basket
      // line linking to a URL the router cannot match is a dead row.
      productId: product.id ?? 0,
      colour:  variant?.colour  ?? '',
      size:    variant?.size    ?? '',
      // What the shopper may raise the quantity to. Read now rather than
      // remembered from when the line went in — the number on screen is the
      // one the next write will be graded against.
      available: levels.get(line.variantId)?.available ?? 0,
      product: product.name     ?? '',
      image:   photo?.file      ?? null,
      alt:     photo?.alt       ?? null,
      // Money is computed on the SERVER even though it is one multiplication:
      // the total a shopper is shown and the total that is charged have to be
      // the same arithmetic, and `checkout` does it here. Cents times a
      // quantity is exact, so there is nothing to round.
      total:   line.unitPrice * line.quantity,
    }
  })
}
