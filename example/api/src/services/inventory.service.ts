// api/services/inventory.service.ts — the warehouse's own screen.
//
// `model:` is InventoryMovement, and that is the honest answer to "what is this
// a service over": the ledger. `find` is the tape, and it needs no code here —
// the model's own `@@gate("5.5.9.9")` is what refuses a shopper, so a service
// that adds nothing to a read adds nothing to a read.
//
// The three methods it does add are the ones a table cannot express:
//
//   levels    on hand / held / available per shelf, which is a join across two
//             tables and a clock, and is not a row in either of them
//   receive   a delivery
//   adjust    a stocktake correction, a breakage, a return to the shelf
//
// ─── What is deliberately NOT here ────────────────────────────────────────
//
// A level check. `receive` and `adjust` write an InventoryMovement through the
// CALLER's own client, so the model's create gate — 5, ADMINISTRATOR — is what
// grades them, at the Data boundary, for every caller including one arriving by
// some route nobody has thought of yet. A `before` hook comparing a number
// would be a second answer to the same question, in a place a policy cannot see
// (Invariant 6).
//
// The one movement written any other way is `sold`, and it is written by a
// shopper at level 0 through `asSystem()` in `carts.checkout` — the shop
// recording its own act. That asymmetry is the whole of the authorisation story
// for stock and it is two sentences long.

import { createBaseService, $ } from '@frontierjs/junction'
import { levelsFor, move, HOLD_MINUTES, type MovementKind } from '../inventory.ts'

/** The kinds an adjustment may name. `received` has its own method — it takes a
 *  delivery note and is always positive — and `sold` belongs to a checkout, so
 *  a hand-filed one would be a sale with no order behind it. */
const ADJUSTABLE: MovementKind[] = ['adjusted', 'damaged', 'returned']

export function createInventoryService() {
  return createBaseService({
    model: 'InventoryMovement',

    // No `channel:`. A movement is `@@gate("5.…")` for reads and a broadcast
    // does not re-check the gate — publishing these would hand every connected
    // browser rows the Data boundary refuses them. The shelf itself DOES
    // announce: `move()` writes ProductVariant, junction taps Litestone's write
    // events, and `product-variants updated` reaches every open catalogue.

    // Both writes are read-modify-write over a number two people can move at
    // once, and each writes two rows that are one fact — the tape and the
    // shelf. `BEGIN IMMEDIATE` is what makes the read and the write one step.
    transactional: ['receive', 'adjust'],

    /**
     * On hand, held and available for a set of shelves.
     *
     * Filtered by `productId`, or by an explicit list, or neither — in which
     * case it answers every variant, which is what the inventory screen opens
     * on. `limit` bounds it: this is a table a person reads, and a shop with ten
     * thousand shelves wants a filter rather than ten thousand rows.
     */
    async levels() {
      const { productId, variantIds, limit = 500 } = ($.data ?? $.query ?? {}) as {
        productId?: number | string
        variantIds?: Array<number | string>
        limit?: number
      }

      const where: Record<string, unknown> = {}
      if (productId != null)        where.productId = Number(productId)
      if (Array.isArray(variantIds)) where.id = { in: variantIds.map(Number).filter(Number.isFinite) }

      const variants = await $.db.productVariant.findMany({
        where,
        orderBy: { sku: 'asc' },
        limit:   Math.min(Number(limit) || 500, 2000),
        include: { product: true },
      }) as Array<{ id: number, sku: string, colour: string, size: string, active: boolean, product?: { id: number, name: string } }>

      // The holds are summed as the shop. An administrator MAY read them —
      // that is what the 5 in the gate says — but `levelsFor` is one function
      // with one client argument, and handing it the caller's would make this
      // the only call site whose answer depends on who asked.
      const levels = await levelsFor(sys(), variants.map(v => v.id))

      return {
        holdMinutes: HOLD_MINUTES,
        rows: variants.map(v => {
          const lv = levels.get(v.id)
          return {
            variantId: v.id,
            sku:       v.sku,
            colour:    v.colour,
            size:      v.size,
            active:    !!v.active,
            productId: v.product?.id   ?? null,
            product:   v.product?.name ?? '',
            onHand:    lv?.onHand    ?? 0,
            held:      lv?.held      ?? 0,
            available: lv?.available ?? 0,
          }
        }),
      }
    },

    /** A delivery. Always positive, always `received`, and the delivery note
     *  goes on the movement as its reference. */
    async receive() {
      const { variantId, quantity, reference, note } = $.data as {
        variantId: number, quantity: number, reference?: string, note?: string
      }
      const { before, after } = await move($.db, Number(variantId), 'received', Number(quantity), { reference, note })
      return { variantId: Number(variantId), before, after }
    },

    /**
     * A correction, a breakage or a return.
     *
     * The reason is the caller's and the shape is the schema's — `kind` is
     * `StockMovementKind` in db/schema.lite, so an unknown one is a 400 with the
     * enum's own wording before this function runs. What the schema cannot say
     * is that two of its five members are not adjustments, and that is here.
     */
    async adjust() {
      const { variantId, quantity, kind, note } = $.data as {
        variantId: number, quantity: number, kind: MovementKind, note: string
      }

      if (!ADJUSTABLE.includes(kind)) throw Object.assign(
        new Error(
          `'${kind}' is not an adjustment. A receipt is inventory.receive, and a sale is ` +
          `recorded by the checkout that made it — filing one by hand would be a sale with ` +
          `no order behind it.`,
        ),
        { status: 400 },
      )

      const { before, after } = await move($.db, Number(variantId), kind, Number(quantity), { note })
      return { variantId: Number(variantId), before, after }
    },

    // The surface, stated. `find` is the ledger; `get` reads one movement.
    // There is deliberately no create, update or remove: the model's gate locks
    // the last two at 9 and a create with no shelf movement beside it is
    // exactly the drift the ledger exists to make impossible.
    methods: [
      'find', 'get',
      'levels',
      { method: 'receive', input: 'StockReceipt' },
      { method: 'adjust',  input: 'StockAdjustment' },
    ],
  })
}

const sys = () => ($.db as { asSystem(): Record<string, any> }).asSystem()
