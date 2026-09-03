// api/src/domain/shop/inventory.ts — the one owner of the shelf.
//
// Three numbers, and only one of them is a column:
//
//   ON HAND    ProductVariant.stock      what the warehouse could pick now
//   HELD       Σ StockReservation        set aside for a basket, with an expiry
//   AVAILABLE  on hand − held            what may be sold, computed every time
//
// Every read of the third and every write of the first goes through this file.
// That is Invariant 4's shape applied to stock: one owner per translation. The
// translation here is "a number changed and here is why", and the moment two
// places do it the ledger and the column stop reconciling with nothing saying
// which one is wrong.
//
// ─── Why a hold and not a decrement ───────────────────────────────────────
//
// Decrementing `stock` when a line goes into a basket is the obvious design and
// it is unrecoverable: an abandoned basket takes stock off the shelf forever,
// because the thing that would put it back is a person who has closed the tab.
// Leaving `stock` alone until checkout is the other obvious design and it
// oversells: two shoppers both see `1 left`, both add it, and the second one
// finds out at the till.
//
// A hold is the third answer. It is a row with a clock on it, so nothing has to
// come back and undo it — it stops counting on its own.
//
// ─── Why every function takes a client ────────────────────────────────────
//
// Nothing here reaches for a module-level `db`, and that is not ceremony. Under
// `transactional:` Junction reassigns `ctx.locals.db` to the transaction's
// client for the length of the method, so a write through anything else is a
// write OUTSIDE the transaction that was supposed to contain it — committed
// while its neighbours roll back, and invisible until the day a checkout fails
// half way. Passing the client makes that a decision at every call site.
//
// Which client to pass is the other half, and the answer is *whose act is
// this*:
//
//   $.db              an administrator receiving stock. InventoryMovement is
//                     `@@gate("5.5.9.9")`, so the Data boundary is what refuses
//                     a caller below 5 and no code here checks anything.
//   $.db.asSystem()   a shopper at level 0 checking out. The sale is the SHOP's
//                     record of its own act, and a stranger may not write one.

/** How long a basket holds stock. Long enough to find a card, short enough that
 *  an abandoned basket is not a stockout — and stated once, because the browser
 *  tells the shopper the same number the sweep enforces. */
export const HOLD_MINUTES = 20

/** A Litestone client of some flavour. Deliberately loose: this module is
 *  handed the caller's scoped client, a system client, or a transaction's, and
 *  the whole point is that it does not care which. */
type Client = Record<string, any>

export type Levels = {
  variantId: number
  sku:       string
  active:    boolean
  /** What the shop is charging for it now. Public — it is on the shelf edge —
   *  and it is here because every caller asking what may be SOLD is about to
   *  show what it costs. */
  price:     number
  /** The column. What the warehouse could physically pick. */
  onHand:    number
  /** Σ unexpired holds — including, unless excluded, the caller's own. */
  held:      number
  /** What may be sold. Never stored: it is a sum over another table that
   *  changes with the clock, and a column would be a cached answer with
   *  nothing to invalidate it. */
  available: number
}

export type MovementKind = 'received' | 'sold' | 'returned' | 'adjusted' | 'damaged'

/** A row of the tape, as the Data boundary answered it. Structural rather than
 *  generated: what a caller does with it is announce it, and a shape stated
 *  here would go stale the day a column is added. */
export type InventoryMovementRow = Record<string, unknown> & { id: number }

// ─── The clock ────────────────────────────────────────────────────────────
//
// Litestone stores DateTime as ISO-8601 TEXT, so every comparison below is
// lexicographic over a UTC instant — which is exact for this format and is not
// for any other. Never compare one of these as a number.

/** When a hold taken now runs out. */
export function holdExpiry(minutes = HOLD_MINUTES): string {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

const nowIso = () => new Date().toISOString()

// ─── Reading ──────────────────────────────────────────────────────────────

/**
 * What may be sold, per variant.
 *
 * `exceptCartId` is the whole subtlety and it is not an optimisation. A shopper
 * holding 2 of the last 5 who raises their line to 3 is asking whether 3 is
 * available — and it is, because the 2 they already hold are theirs. Summing
 * every hold answers 3, refuses the request, and the shopper cannot buy stock
 * that is being kept for them. The hold being asked about has to come out of
 * the sum before the comparison.
 *
 * THE READ IS THE TRUTH. `expiresAt > now` is in the filter, so a hold is dead
 * the instant it passes whether or not `release-holds` has run. The sweep keeps
 * the table small; it is not what makes the number right. Depending on a cron
 * for correctness means a queue outage quietly stops the shop from selling.
 */
export async function levelsFor(
  client: Client,
  variantIds: number[],
  opts: { exceptCartId?: number | null } = {},
): Promise<Map<number, Levels>> {
  const out = new Map<number, Levels>()
  if (!variantIds.length) return out

  const variants = await client.productVariant.findMany({
    where: { id: { in: variantIds } },
  }) as Array<{ id: number, sku: string, price: number, stock: number, active: boolean }>

  for (const v of variants) {
    out.set(v.id, {
      variantId: v.id, sku: v.sku, active: !!v.active, price: v.price,
      onHand: v.stock, held: 0, available: v.stock,
    })
  }

  // groupBy rather than one aggregate per variant: a product page asks about
  // twelve shelves at once, and twelve round trips to answer one screen is the
  // shape that makes a feature look expensive when it is not.
  const where: Record<string, unknown> = {
    variantId: { in: variantIds },
    expiresAt: { gt: nowIso() },
  }
  if (opts.exceptCartId != null) where.cartId = { not: opts.exceptCartId }

  const groups = await client.stockReservation.groupBy({
    by:   ['variantId'],
    _sum: { quantity: true },
    where,
  }) as Array<{ variantId: number, _sum: { quantity: number | null } }>

  for (const g of groups) {
    const row = out.get(g.variantId)
    if (!row) continue
    row.held = g._sum?.quantity ?? 0
    // Clamped at zero rather than allowed negative. Holds cannot exceed stock
    // by any path this module offers, but a hand-written adjustment that takes
    // the shelf below what is held can, and `-2 available` on a screen is a
    // number a reader will chase rather than the plain "nothing to sell" it
    // actually means.
    row.available = Math.max(0, row.onHand - row.held)
  }

  return out
}

/** One shelf. The single-variant case is common enough to name. */
export async function levelFor(
  client: Client,
  variantId: number,
  opts: { exceptCartId?: number | null } = {},
): Promise<Levels | null> {
  return (await levelsFor(client, [variantId], opts)).get(variantId) ?? null
}

// ─── Holding ──────────────────────────────────────────────────────────────

/**
 * Set `quantity` of a variant aside for a basket, refreshing the clock.
 *
 * Upsert rather than insert: `@@unique([cartId, variantId])` mirrors the line
 * it stands for, so a shopper raising their quantity moves one row instead of
 * accumulating holds that each expire separately.
 *
 * MUST run inside a transaction, and every caller here declares one. The check
 * and the write are read-modify-write over a number two shoppers are competing
 * for; Litestone opens a transaction with `BEGIN IMMEDIATE`, which takes the
 * write lock up front, so the interleaving that lets both of them past the
 * check cannot happen. Outside one, this is the bug it exists to prevent.
 *
 * Answers the instant the hold runs out, because that is what the basket screen
 * shows and it must be the same value that was written.
 */
export async function hold(
  client: Client,
  cartId: number, variantId: number, quantity: number,
): Promise<{ expiresAt: string, level: Levels }> {
  const level = await levelFor(client, variantId, { exceptCartId: cartId })
  if (!level)        throw stockError('That product is no longer on sale', 400)
  if (!level.active) throw stockError(`${level.sku} is no longer on sale`, 400)

  if (quantity > level.available) throw stockError(
    level.available === 0
      ? `${level.sku} is sold out`
      : `Only ${level.available} of ${level.sku} left`,
    // 409 and not 400. The request was well formed and was true when the
    // shopper was shown it; what changed is the world. `retryable` is what says
    // so — a browser holding a stale count re-reads and re-offers rather than
    // showing the shopper their own input as an error.
    409, { retryable: true },
  )

  const expiresAt = holdExpiry()
  const existing  = await client.stockReservation.findFirst({ where: { cartId, variantId } })

  if (existing) await client.stockReservation.update({ where: { id: existing.id }, data: { quantity, expiresAt } })
  else          await client.stockReservation.create({ data: { cartId, variantId, quantity, expiresAt } })

  return { expiresAt, level }
}

/** Give it back. One shelf, or the basket's whole hold. Answers how many rows
 *  went, which is what a job wants to log and a caller can ignore. */
export async function release(
  client: Client,
  cartId: number, variantId?: number,
): Promise<number> {
  const where = variantId == null ? { cartId } : { cartId, variantId }
  const rows  = await client.stockReservation.findMany({ where }) as Array<{ id: number }>
  for (const r of rows) await client.stockReservation.delete({ where: { id: r.id } })
  return rows.length
}

/** When this basket's hold runs out — the EARLIEST of its holds, because that
 *  is the one the shopper loses first and a basket is held until then or it is
 *  not held. Null for a basket holding nothing. */
export async function heldUntil(client: Client, cartId: number): Promise<string | null> {
  const rows = await client.stockReservation.findMany({
    where:   { cartId, expiresAt: { gt: nowIso() } },
    orderBy: { expiresAt: 'asc' },
    limit:   1,
  }) as Array<{ expiresAt: string }>
  return rows[0]?.expiresAt ?? null
}

// ─── Moving ───────────────────────────────────────────────────────────────

/**
 * The ONE place `ProductVariant.stock` is written.
 *
 * `delta` is signed and is the movement rather than the new total: +12
 * received, −2 sold. A ledger of totals cannot be summed, and summing is the
 * only thing anyone ever wants to do with one.
 *
 * The tape is written BEFORE the shelf moves. Inside a transaction the order
 * makes no difference to the outcome; what it buys is the failure shape — a
 * caller refused by InventoryMovement's gate is refused before the number
 * changed, rather than leaving a shelf that moved with no row saying why.
 */
export async function move(
  client: Client,
  variantId: number,
  kind: MovementKind,
  delta: number,
  meta: { reference?: string | null, note?: string | null } = {},
): Promise<{ before: number, after: number, movement: InventoryMovementRow }> {
  if (!Number.isInteger(delta) || delta === 0)
    throw stockError('A stock movement is a whole number of items and cannot be zero', 400)

  const variant = await client.productVariant.findFirst({ where: { id: variantId } }) as
    { id: number, sku: string, stock: number } | null
  if (!variant) throw stockError('No such variant', 404)

  const after = variant.stock + delta
  // Refused here rather than at the column. `stock` carries `@gte(0)` and would
  // refuse it too, in SQLite's words about a constraint; the shop's words name
  // the SKU and the number, which is what an inventory screen can show.
  if (after < 0) throw stockError(
    `${variant.sku} has ${variant.stock} on hand — ${Math.abs(delta)} cannot be taken out`, 400,
  )

  // The row is kept rather than discarded because it is what the write
  // ANNOUNCES. A service method broadcasts under its own name, and `receive`
  // and `adjust` answer a summary a subscriber cannot merge; the movement is
  // the fact that happened, so `$.dispatch` is handed this.
  const movement = await client.inventoryMovement.create({ data: {
    variantId, kind, quantity: delta,
    stockBefore: variant.stock,
    stockAfter:  after,
    reference:   meta.reference ?? null,
    note:        meta.note ?? null,
  } }) as InventoryMovementRow

  await client.productVariant.update({ where: { id: variantId }, data: { stock: after } })

  return { before: variant.stock, after, movement }
}

/**
 * A basket becomes an order: every hold turns into a sale.
 *
 * Two things happen per line and they are one thing — the shelf comes down and
 * the hold goes away. Leaving the hold behind would keep the stock reserved
 * against a basket that no longer exists until the sweep noticed, so the shop
 * would refuse to sell what it had just been paid for.
 *
 * Called from inside `carts.checkout`, which is `transactional:`, with the
 * SYSTEM client — the sale is the shop's own record and the shopper is a
 * stranger at level 0.
 */
export async function consume(
  client: Client,
  cartId: number,
  lines: Array<{ variantId: number, quantity: number }>,
  reference: string,
): Promise<void> {
  for (const line of lines) {
    await move(client, line.variantId, 'sold', -line.quantity, { reference })
  }
  await release(client, cartId)
}

// ─── The sweep ────────────────────────────────────────────────────────────

/**
 * Drop every hold that has run out.
 *
 * Housekeeping and not correctness — see `levelsFor`. `before` is the cutoff so
 * the job can be RUN rather than waited for: the drive passes an instant in the
 * future and the SAME comparison executes, where a `releaseAll` flag would be a
 * second code path that proves nothing about the first.
 */
/**
 * Put an order's items back on the shelf.
 *
 * ─── Why this reads the LEDGER and not the basket ────────────────────────
 *
 * An Order carries a total and a customer and no lines: what was bought lives
 * in the CartLine rows the checkout consumed, and a basket is a shopper's
 * object with a shopper's lifetime — abandoned baskets are swept, and a
 * shopper may empty one after ordering from it.
 *
 * `InventoryMovement` is append-only and every sale wrote one naming the
 * order's reference, so the tape IS the record of what left the shelf. Reading
 * it back is the ledger doing the thing the schema says it exists for: a
 * ledger of totals cannot be summed, and a refund is a sum.
 *
 * It is also the only version that stays right. A line whose quantity was
 * changed after checkout, a variant that has since been retired, a partial
 * consumption — the movement rows say what actually happened, and the basket
 * says what somebody meant at some point.
 *
 * Returns the movements it wrote, so a caller can say what went back.
 */
export async function restock(
  client: Client,
  reference: string,
  note?: string,
): Promise<Array<{ variantId: number, quantity: number }>> {
  const sold = await client.inventoryMovement.findMany({
    where: { reference, kind: 'sold' },
  }) as Array<{ variantId: number, quantity: number }>

  const back: Array<{ variantId: number, quantity: number }> = []
  for (const row of sold) {
    // `sold` is negative — the ledger is signed — so the way back is the
    // negation, not a second reading of the basket. A sale of −2 returns +2
    // whatever anybody has done to the line since.
    const qty = Math.abs(row.quantity)
    if (!qty) continue
    await move(client, row.variantId, 'returned', qty, { reference, note: note ?? null })
    back.push({ variantId: row.variantId, quantity: qty })
  }
  return back
}

export async function releaseExpired(
  client: Client,
  before: string = nowIso(),
): Promise<number> {
  const rows = await client.stockReservation.findMany({
    where: { expiresAt: { lte: before } },
  }) as Array<{ id: number }>
  for (const r of rows) await client.stockReservation.delete({ where: { id: r.id } })
  return rows.length
}

// ─── helpers ──────────────────────────────────────────────────────────────

/** A thrown value with a status Junction's error boundary will carry through,
 *  and — where the world moved rather than the caller being wrong — the
 *  `retryable` flag that a status alone cannot express. */
function stockError(message: string, status: number, extra: { retryable?: boolean } = {}) {
  return Object.assign(new Error(message), { status, ...extra })
}
