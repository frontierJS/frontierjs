// api/src/domain/shop/pricing.ts — the one owner of what a basket costs.
//
// `inventory.ts` owns the shelf; this owns the money. The shape of the argument
// is the same one, and so is the reason: there is exactly one definition of
//
//     subtotal − discount + shipping + tax = total
//
// and the basket screen, the checkout, the receipt and the payment provider all
// ask it rather than each doing the multiplication themselves. Two places that
// compute a total are two totals, and the day they disagree a customer is
// charged a number no screen ever showed them.
//
// ─── Where the figures live, and why that differs by table ────────────────
//
// A `Cart` stores WHICH code and WHICH shipping method, and no amounts. An
// `Order` stores the amounts and no references. That inversion is deliberate
// and it is the whole distinction between a question and a statement: a basket
// is re-answered on every request, so a rate that moved or a code that expired
// while the shopper was deciding has to show up at once; an order is a
// statement about a moment, so nothing about it may move afterwards. Storing
// amounts on the basket quotes a price the shop no longer offers; storing
// references on the order reprices history every time a merchant edits a rate.
//
// So this module has two entry points and they are not symmetrical:
//
//   priceBasket(...)   pure arithmetic over rows somebody else loaded
//   contextFor(...)    the loads — a cart's code, method and the shop's rate
//
// ─── The unit, stated once ────────────────────────────────────────────────
//
// EVERY number in and out of this module is a whole number of minor units —
// cents — because every money column in the schema is `@money(USD)` and that is
// what `@money` stores. Nothing here is a float, and that is not a style
// preference: `0.1 + 0.2` is the oldest bug in commerce, and the identity
//
//     subtotal − discount + shipping + tax = total
//
// is an equality over integers where over floats it is a tolerance somebody has
// to remember to write. The Data boundary asserts it as an `@@check` for that
// reason.
//
// Two operations produce a number that is not already exact — a percentage
// discount and a tax rate — and each is rounded to the cent at the point it is
// produced, half away from zero. Everything else is addition. The total is the
// sum of the ROUNDED components, not the rounding of a sum, so what is printed
// adds up to what was charged by construction.
//
// The corollary is the rule for every screen: render these numbers, never
// recompute them, and never divide by a hundred by hand — `fromMinor` in
// `@frontierjs/toolbelt/units` is what knows the yen has no cent.

import { formatMoney, fromMinor, roundMinor } from '@frontierjs/toolbelt/units'
import { compileSegment, matchesAudience } from './custom-fields.ts'
import type { CustomField, SegmentTerm }   from './custom-fields.ts'

/** The currency every `@money(USD)` column in this schema is in.
 *
 *  Stated here because this is the API's one owner of money and the API has
 *  readers of its own — a refused code answers with an amount in it, and two
 *  email bodies quote a total. `web/src/money.js` and `site/src/money.js` each
 *  state it again for their own surface; a surface may not import another
 *  surface's `src/` (Invariant 3), and the real fix is the shop's currency
 *  being a row rather than a constant, which is a feature and not a formatter. */
export const BASE = 'USD'

/** Cents → what a person reads. The API's half of `money()`, and the reason it
 *  exists at all is that nothing may divide by a hundred by hand: `fromMinor`
 *  is what knows the yen has no cent (`FJS-440`). */
export function money(cents: number | null | undefined): string {
  if (cents == null) return ''
  return formatMoney(fromMinor(cents, BASE), BASE)
}

/** A Litestone client of some flavor — see `inventory.ts` for why this is
 *  loose. The reads below go through whichever one the caller is entitled to. */
type Client = Record<string, any>

// ─── Rows, as this module needs them ──────────────────────────────────────

export type DiscountRow = {
  id:             number
  code:           string
  label:          string
  kind:           'percent' | 'fixed'
  /** `@scale(2)`, two readings: 1050 is $10.50 under `fixed` and 10.50% under
   *  `percent`. One column, one scale — see the schema. */
  value:          number
  minSubtotal:    number
  startsAt:       string | null
  endsAt:         string | null
  maxRedemptions: number | null
  redemptions:    number
  active:         boolean
}

export type ShippingMethodRow = {
  id:          number
  name:        string
  description: string | null
  price:       number
  freeOver:    number | null
  position:    number
  active:      boolean
}

export type TaxRateRow = {
  id:    number
  label: string
  rate:  number
}

/** A line, as the money cares about it. `total` and not `unitPrice × quantity`:
 *  the basket screen showed a figure and this has to be that same figure, which
 *  is only true if it is carried rather than derived a second time. */
export type PricedLine = { total: number }

/** What everything downstream renders and stores. Deliberately flat and
 *  deliberately complete — a consumer that has to ask a second question to draw
 *  a line of the receipt is a consumer that will compute it instead. */
export type Breakdown = {
  subtotal:      number
  discount:      number
  discountCode:  string | null
  discountLabel: string | null
  shipping:      number
  shippingLabel: string | null
  tax:           number
  taxRate:       number
  taxLabel:      string | null
  total:         number
}

/** Everything the arithmetic needs that is not a line. Each is nullable and
 *  each nullable case is a real state: no code typed, no method chosen yet, a
 *  shop that does not charge tax. */
export type MoneyContext = {
  discount?:       DiscountRow | null
  /// Who is buying, for a code that names an audience. Absent means the basket
  /// has no customer yet — a guest before checkout — which is not the same as a
  /// customer who fails the audience, and `discountProblem` tells them apart.
  customer?:       Record<string, unknown> | null
  /// This shop's `CustomField` rows. Required to read an audience at all, since
  /// the terms are in the shop's vocabulary and the columns are in the pool's.
  declaredFields?: CustomField[] | null
  shippingMethod?: ShippingMethodRow | null
  taxRate?:        TaxRateRow | null
}

// ─── The arithmetic ───────────────────────────────────────────────────────

/** To the cent, once, at the point a figure is produced by a multiplication.
 *
 *  The rule is `roundMinor`'s and this shop states no mode, so it takes the
 *  default: half away from zero, which is what a person checking the sum on
 *  paper expects. A jurisdiction requiring banker's rounding for tax passes
 *  `{ mode: 'half-even' }` at the one call below that computes it, and the two
 *  figures on one receipt can then disagree honestly (`FJS-D154`).
 *
 *  Only two callers below produce a non-integer at all; every other line here
 *  is the addition of two integers and needs nothing. */
export const roundCents = roundMinor

/**
 * Why this code is worth nothing to this basket — or null if it is worth
 * something.
 *
 * A SENTENCE rather than a boolean, and one function rather than two, because
 * `applyDiscount` and `checkout` both have to refuse and they must refuse in
 * the same words. The second check is not paranoia: a code applied to a basket
 * at noon can expire, sell out or be switched off before the shopper pays, and
 * the transaction that writes the order is the only place a *redemption limit*
 * can be honestly enforced at all.
 *
 * `now` is a parameter so a test can stand at a moment, and because the
 * checkout re-check must grade against the same instant it validates stock at.
 */
export function discountProblem(
  discount: DiscountRow | null | undefined,
  subtotal: number,
  now: Date = new Date(),
  audience?: { customer?: Record<string, unknown> | null; declared?: CustomField[] | null },
): string | null {
  if (!discount)        return 'That code is not one this shop issued'
  if (!discount.active) return `${discount.code} is no longer available`

  const t = now.getTime()
  if (discount.startsAt && Date.parse(discount.startsAt) > t)
    return `${discount.code} is not valid yet`
  if (discount.endsAt && Date.parse(discount.endsAt) <= t)
    return `${discount.code} has expired`

  if (discount.maxRedemptions != null && discount.redemptions >= discount.maxRedemptions)
    return `${discount.code} has been used the maximum number of times`

  // Compared against the subtotal, which is the lines and nothing else — a
  // minimum spend that shipping could satisfy would be a shop paying itself.
  // Both are cents, so this is an integer comparison and there is nothing to
  // round before making it.
  if (discount.minSubtotal > 0 && subtotal < discount.minSubtotal)
    return `${discount.code} needs a subtotal of at least ${money(discount.minSubtotal)}`

  // ─── Who it is for ──────────────────────────────────────────────────────
  //
  // The audience is compiled by the same function `customers.segment` uses and
  // then asked of ONE row, so the list a merchant sees and the refusal a
  // shopper gets come from one predicate. Two implementations here would be a
  // code that is advertised to somebody the checkout then declines.
  //
  // Every branch below fails CLOSED, and each for a different reason:
  //   · no customer yet — a guest basket cannot be shown to be in the audience
  //   · a term on a field this shop no longer declares — the audience the
  //     merchant wrote is not the audience this would apply, so honouring it
  //     would widen the code silently, which is the one failure nothing
  //     downstream can see
  //   · undecidable — the row came through a `select` that dropped a slot
  const terms = discount.audience as SegmentTerm[] | null | undefined
  if (Array.isArray(terms) && terms.length) {
    if (!audience?.customer)
      return `${discount.code} is only for selected customers`

    const { where, unknown, unindexed } = compileSegment(terms, audience.declared ?? [])
    if (unknown.length || unindexed.length)
      return `${discount.code} cannot be checked right now`

    if (matchesAudience(where, audience.customer) !== true)
      return `${discount.code} is only for selected customers`
  }

  return null
}

/**
 * What comes off, for a code that is valid.
 *
 * Capped at the subtotal in both directions: a fixed 20-off code on a 15 basket
 * takes 15 and not 20, because the alternative is a negative subtotal that
 * every line below inherits — a tax on a negative and, at the end, a shop
 * paying a customer to take its stock.
 *
 * The percentage is clamped rather than trusted. `value` is one column for two
 * units (see the schema), so nothing in the Data boundary can enforce *at most
 * 100* on the percent half without seeing `kind`, and here both are in scope.
 * It is `@scale(2)`, so a hundred per cent is 10000 and the divisor below is
 * the two places of the percentage times the two of the money it is taken off.
 */
export function discountAmount(discount: DiscountRow | null | undefined, subtotal: number): number {
  if (!discount) return 0
  const base = Math.max(0, subtotal)

  const raw = discount.kind === 'percent'
    ? roundCents(base * Math.min(10000, Math.max(0, discount.value)) / 10000)
    : Math.max(0, discount.value)

  return Math.min(base, raw)
}

/**
 * What it costs to send it.
 *
 * The threshold is measured against the subtotal AFTER the discount, and that
 * is a decision rather than an accident. A shop offering free delivery over 50
 * and a code worth 10 off has to answer whether a 55 basket with the code
 * applied still qualifies, and discount-first is the answer that cannot
 * surprise a merchant into shipping at a loss. It is written here so the
 * question is answered once for every screen.
 */
export function shippingAmount(method: ShippingMethodRow | null | undefined, afterDiscount: number): number {
  if (!method || !method.active) return 0
  if (method.freeOver != null && afterDiscount >= method.freeOver) return 0
  return method.price
}

/**
 * Everything, in the order the money happens.
 *
 * Tax last and on the sum of the two before it, because delivery is a service
 * the shop sold and is taxable in every jurisdiction this app pretends to be
 * in. A shop where it is not would need a flag on `ShippingMethod`, which is a
 * column and not a rewrite — the arithmetic already has one place to change.
 */
export function priceBasket(lines: PricedLine[], ctx: MoneyContext = {}): Breakdown {
  const subtotal = lines.reduce((n, l) => n + (Number(l.total) || 0), 0)

  // The code is only worth something if it is currently valid. A basket
  // carrying an expired code prices at zero off and says so on the screen,
  // rather than quoting a discount the checkout is about to refuse.
  const usable  = discountProblem(ctx.discount, subtotal, new Date(),
                    { customer: ctx.customer, declared: ctx.declaredFields }) === null
    ? ctx.discount ?? null : null
  const discount = discountAmount(usable, subtotal)

  const afterDiscount = subtotal - discount
  const shipping      = shippingAmount(ctx.shippingMethod, afterDiscount)

  // The rate is the one figure here that is not money and is therefore still a
  // fraction — 0.2 and not 20, `TaxRate.rate` says why — so this is the second
  // and last multiplication, and the second and last rounding.
  const rate = ctx.taxRate ? Math.max(0, Number(ctx.taxRate.rate) || 0) : 0
  const tax  = roundCents(Math.max(0, afterDiscount + shipping) * rate)

  return {
    subtotal,
    discount,
    discountCode:  usable?.code  ?? null,
    discountLabel: usable?.label ?? null,
    shipping,
    // The label is the METHOD's, present whenever one is chosen — a `Standard`
    // against a zero is the free-over threshold having been met, and that reads
    // correctly without a fourth column saying so.
    shippingLabel: ctx.shippingMethod?.active ? ctx.shippingMethod.name : null,
    tax,
    taxRate:       rate,
    taxLabel:      rate > 0 ? ctx.taxRate?.label ?? null : null,
    // The sum of the rounded components. See the header.
    total:         subtotal - discount + shipping + tax,
  }
}

// ─── The loads ────────────────────────────────────────────────────────────

/**
 * The shop's rate, or none.
 *
 * A shop that has configured no tax charges none — it does not refuse to sell.
 * That is the only reasonable failure mode for a fleet where a shop is a file
 * somebody created this morning, and it is why every consumer of `Breakdown`
 * has to render a zero tax line as absent rather than as `0.00`.
 */
export async function defaultTaxRate(client: Client): Promise<TaxRateRow | null> {
  const rows = await client.taxRate.findMany({
    where:   { active: true, isDefault: true },
    orderBy: { id: 'asc' },
    limit:   1,
  }) as TaxRateRow[]
  return rows[0] ?? null
}

/** What a shopper may pick from, in the merchant's own order. */
export async function shippingMethods(client: Client): Promise<ShippingMethodRow[]> {
  return await client.shippingMethod.findMany({
    where:   { active: true },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  }) as ShippingMethodRow[]
}

/**
 * Look a code up. Case-insensitively, because `@upper` on the column means the
 * stored form is upper and a shopper reading a code off a poster will not be.
 *
 * Answers the row whatever its state — the caller asks `discountProblem` for
 * the sentence, so that an expired code and a code that never existed can be
 * told apart by the thing that is going to say so.
 */
export async function discountByCode(client: Client, code: string): Promise<DiscountRow | null> {
  const trimmed = String(code ?? '').trim().toUpperCase()
  if (!trimmed) return null
  return await client.discount.findFirst({ where: { code: trimmed } }) as DiscountRow | null
}

/**
 * Everything a cart's money depends on, in one place.
 *
 * Reads through whichever client it is handed, and the callers hand it the
 * SYSTEM one: `Discount` is `@@gate("5.5.5.5")` because listing a shop's codes
 * is the exploit the gate exists to stop, so a shopper's own client answers
 * nothing here — a wrong policy is an empty screen, and this one would be a
 * silently un-applied discount at the till.
 */
export async function contextFor(
  client: Client,
  cart: { discountId?: number | null, shippingMethodId?: number | null },
): Promise<MoneyContext> {
  const [discount, shippingMethod, taxRate] = await Promise.all([
    cart.discountId != null
      ? client.discount.findFirst({ where: { id: cart.discountId } }) as Promise<DiscountRow | null>
      : Promise.resolve(null),
    cart.shippingMethodId != null
      ? client.shippingMethod.findFirst({ where: { id: cart.shippingMethodId } }) as Promise<ShippingMethodRow | null>
      : Promise.resolve(null),
    defaultTaxRate(client),
  ])
  return { discount, shippingMethod, taxRate }
}
