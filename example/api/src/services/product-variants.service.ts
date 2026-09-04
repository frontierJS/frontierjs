// The buyable rows beneath a product. `model:` is STATED rather than derived:
// the filename is the service name and the URL segment, and 'product-variants'
// singularises to 'product-variant', which is not what the Litestone accessor
// is called. Naming the model is what keeps the three resolvers that read it —
// the query, the @@gate check and the field validation — pointed at one table.
//
// Getting that wrong fails OPEN rather than loudly: a service whose accessor
// resolves to nothing finds no gate and no schema, so @@gate("0.4.4.5") would
// permit an anonymous write and autoValidate would check nothing.
import { createBaseService, $ } from '@frontierjs/junction'
import { levelsFor } from '../domain/shop'

export function createProductVariantsService() {
  return createBaseService({
    model:   'ProductVariant',
    channel: 'product-variants',

    /**
     * What may actually be sold, per variant — the number the buy box needs and
     * the one no column holds.
     *
     * Addressed to the COLLECTION (`invoke('availability', null, { productId })`)
     * because it is a question about a set of shelves and not about a row. A
     * product page asks about twelve at once; twelve round trips to fill in one
     * screen is what makes a correct feature look like an expensive one.
     *
     * ─── Why this reads through asSystem() ────────────────────────────────
     *
     * `StockReservation` is `@@gate("5.8.8.8")`: an administrator may read the
     * holds, a shopper may not. Availability is a sum over EVERYBODY's holds,
     * so a shopper's own client would answer `on hand − 0` — a number that is
     * always plausible, never right, and reported by nothing. That is the exact
     * shape the house rule warns about: a wrong policy is an empty screen, not
     * an error.
     *
     * The bypass is deliberate and it is narrow: the NUMBER is public — it is
     * what the shop is telling people it can sell — and the ROWS are not. What
     * crosses the wire is `{ variantId, available }` and never a cartId, a
     * quantity somebody else is holding, or an expiry.
     *
     * It is also why holds do not travel on a channel. A broadcast does not
     * re-check the gate, so publishing StockReservation rows would hand every
     * connected browser exactly the rows the Data boundary refuses them. The
     * cost is that another shopper's hold does not move this number live; the
     * page re-asks after each of the shopper's own actions, and the hold is
     * re-checked at the Data boundary either way.
     */
    async availability() {
      // A read announces nothing. Every custom method broadcasts under its own
      // name unless it says otherwise — only `find` and `get` are excluded by
      // name — and this one answers a computed summary, not a ProductVariant.
      // Left alone it put a frame on the `product-variants` channel for every
      // connected browser on every availability check (a product page asks
      // about twelve variants, and the storefront's buy box asks on every
      // load), carrying a payload no store can merge: the client's `upsert`
      // refuses a record with no id, so the frames were dropped on arrival.
      // Junction says so once per method rather than letting it be silent.
      $.dispatch = false

      const { productId, variantIds } = ($.data ?? $.query ?? {}) as
        { productId?: number | string, variantIds?: Array<number | string> }

      // The CALLER's client for the variants — `ProductVariant` reads at level
      // 0, so a stranger resolves their own list and a retired product is not
      // silently reachable through this method when it is not through `find`.
      let ids: number[]
      if (Array.isArray(variantIds)) {
        ids = variantIds.map(Number).filter(Number.isFinite)
      } else if (productId != null) {
        const rows = await $.db.productVariant.findMany({
          where:  { productId: Number(productId) },
          select: { id: true },
        }) as Array<{ id: number }>
        ids = rows.map(r => r.id)
      } else {
        throw Object.assign(
          new Error('availability needs a productId or a list of variantIds'),
          { status: 400 },
        )
      }

      const levels = await levelsFor(sys(), ids)

      // Projected rather than spread. `Levels` carries `held`, which is a fact
      // about other people's baskets: it is what the inventory screen is for
      // and it is not what a product page is asking. `sku` and `price` DO
      // cross — both are on the shelf edge in a shop — and they are the two a
      // caller that is not holding this app's ids needs: the storefront is
      // prerendered and keys its table by SKU, and the price it baked is the
      // one thing on that page most likely to be stale.
      // `variants:` and not `data:`. A custom method answering `{ data: [...] }`
      // is a SINGLE that happens to hold an array — junction's bulk protocol
      // needs `errors` beside it — so it travels whole and the key would be
      // read as an envelope by every human who saw it.
      return {
        variants: ids.map(id => {
          const lv = levels.get(id)
          return {
            variantId: id,
            sku:       lv?.sku       ?? null,
            price:     lv?.price     ?? null,
            onHand:    lv?.onHand    ?? 0,
            available: lv?.available ?? 0,
            active:    lv?.active    ?? false,
          }
        }),
      }
    },

    /**
     * Everything a buy button needs, in ONE call.
     *
     * An embed's budget is round trips on a page it does not own. Assembling
     * this in the browser is three requests — the variant by SKU, its product
     * for a name and a photograph, its availability — on somebody else's page,
     * before their content has finished loading. So the shop assembles it.
     *
     * Addressed by SKU rather than by id, because a SKU is what a merchant
     * pastes into a `data-sku` attribute and an id is a number they would have
     * to look up. It reads at level 0 like the rest of the catalogue.
     *
     * What it does NOT answer is anything about other people's baskets: `held`
     * stays here, and `available` crosses. Same line `availability` draws.
     */
    async embed() {
      // Same as `availability`: a question, not a write. It carries more of the
      // row than that one does — enough to look mergeable — which is worse, not
      // better, for a subscriber holding a real ProductVariant.
      $.dispatch = false

      const { sku } = ($.data ?? $.query ?? {}) as { sku?: string }
      if (typeof sku !== 'string' || !sku.trim())
        throw Object.assign(new Error('embed needs a sku'), { status: 400 })

      const variant = await $.db.productVariant.findFirst({
        // `@upper` on the column, so the stored value is upper-cased and a
        // merchant who pasted a lower-case SKU is not silently told there is no
        // such product.
        where:   { sku: sku.trim().toUpperCase() },
        include: { product: { include: { images: true } } },
      }) as Record<string, any> | null

      if (!variant) throw Object.assign(
        new Error(`No product with SKU ${sku}`), { status: 404 },
      )

      const level = (await levelsFor(sys(), [variant.id])).get(variant.id)
      const photo = (variant.product?.images ?? [])
        .slice()
        .sort((a: any, b: any) => a.position - b.position)[0]

      return {
        variantId: variant.id,
        sku:       variant.sku,
        productId: variant.product?.id ?? null,
        product:   variant.product?.name ?? '',
        color:     variant.color,
        size:      variant.size,
        // MINOR units, because the column is `@money(USD)` and nothing between
        // here and a screen may divide by a hundred by hand — the widget calls
        // `fromMinor` with the code below.
        price:     variant.price,
        // Stated rather than assumed. The widget is on a page in some other
        // country and has no preferences store to read; the shop's base
        // currency is a fact only the shop knows.
        currency:  'USD',
        image:     photo?.file ?? null,
        alt:       photo?.alt  ?? null,
        active:    !!variant.active,
        onHand:    level?.onHand    ?? 0,
        available: level?.available ?? 0,
      }
    },

    // Declaring one custom method declares the whole surface, so the CRUD verbs
    // are restated here — a service that named only `availability` would answer
    // 405 to every other verb. surface.snapshot.md carries this list and CI
    // fails a stale one, so a verb that stopped being answered is a diff before
    // it is a bug.
    methods: [
      'find', 'get', 'create', 'update', 'patch', 'remove',
      'availability', 'embed',
    ],
  })
}

/** See `availability` — the holds are read as the shop, never as the shopper. */
const sys = () => ($.db as { asSystem(): Record<string, any> }).asSystem()
