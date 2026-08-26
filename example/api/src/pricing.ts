// api/pricing.ts — the one owner of what a basket costs.
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
// ─── Rounding, stated once ────────────────────────────────────────────────
//
// Every component is rounded to two places as it is produced, and the total is
// the sum of the ROUNDED components. Not the rounding of the sum. The two
// differ by a penny often enough to matter, and only the first one has the
// property that makes a receipt readable: what is printed adds up to what was
// charged, by construction, without anything downstream being careful.
//
// The corollary is the rule for every screen: render these numbers, never
// recompute them. A percentage re-applied in JavaScript rounds on its own.

/** A Litestone client of some flavour — see `inventory.ts` for why this is
 *  loose. The reads below go through whichever one the caller is entitled to. */
type Client = Record<string, any>

// ─── Rows, as this module needs them ──────────────────────────────────────

export type DiscountRow = {
  id:             number
  code:           string
  label:          string
  kind:           'percent' | 'fixed'
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
  shippingMethod?: ShippingMethodRow | null
  taxRate?:        TaxRateRow | null
}

// ─── The arithmetic ───────────────────────────────────────────────────────

/** Two places, once, at the point the figure is produced. Rounds half away from
 *  zero on the value's own sign, which is what `toFixed` does and what a person
 *  checking the sum on paper expects. */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Number(n.toFixed(2))
}

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
  if (discount.minSubtotal > 0 && round2(subtotal) < round2(discount.minSubtotal))
    return `${discount.code} needs a subtotal of at least ${discount.minSubtotal.toFixed(2)}`

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
 */
export function discountAmount(discount: DiscountRow | null | undefined, subtotal: number): number {
  if (!discount) return 0
  const base = Math.max(0, subtotal)

  const raw = discount.kind === 'percent'
    ? base * (Math.min(100, Math.max(0, discount.value)) / 100)
    : Math.max(0, discount.value)

  return round2(Math.min(base, raw))
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
  if (method.freeOver != null && round2(afterDiscount) >= round2(method.freeOver)) return 0
  return round2(method.price)
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
  const subtotal = round2(lines.reduce((n, l) => n + (Number(l.total) || 0), 0))

  // The code is only worth something if it is currently valid. A basket
  // carrying an expired code prices at zero off and says so on the screen,
  // rather than quoting a discount the checkout is about to refuse.
  const usable  = discountProblem(ctx.discount, subtotal) === null ? ctx.discount ?? null : null
  const discount = discountAmount(usable, subtotal)

  const afterDiscount = round2(subtotal - discount)
  const shipping      = shippingAmount(ctx.shippingMethod, afterDiscount)

  const rate = ctx.taxRate ? Math.max(0, Number(ctx.taxRate.rate) || 0) : 0
  const tax  = round2(Math.max(0, afterDiscount + shipping) * rate)

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
    total:         round2(subtotal - discount + shipping + tax),
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
