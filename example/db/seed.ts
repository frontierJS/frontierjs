// db/seed.ts — enough rows to have something to click, plus two demo users.
//
//   bun run db:seed            seed; a second run adds only what is missing
//
// A SCRIPT, not a module: nothing imports it, so it runs on being run and needs
// no `import.meta.main` guard. It used to be awaited from app.ts at module
// scope, which meant every import of the app seeded the database — including
// `junction surface`, whose whole job is to describe the app without acting on
// it.
//
// Everything here goes through asSystem(): seeding is not a request and has no
// session, so it is not something the gate should be asked about.
//
// ─── Why this file reaches up into api/ ───────────────────────────────────
//
// It needs the app's OWN client, not one of its own. `api/src/core/db.ts`
// installs the gate resolver and FileStorage and assembles the schema from
// three sources, so a second client here would be a second answer to "what is
// this database" — and the product images it writes are `File` columns whose
// bytes have to land where the API serves them from.
//
// `move()` is the same argument: it is the one owner of `ProductVariant.stock`,
// and seeding stock is a `received` movement like any other. Writing the column
// directly would be the second writer that file exists to prevent.
//
// So the import points at api/ rather than the other way round, which is the
// direction that would be a problem. Nothing in db/ is imported BY api/.

import { createLitestoneAuth } from '@frontierjs/auth'
import { toMinor }             from '@frontierjs/toolbelt/units'
import { sys, db, DEV_KEY }    from '../api/src/core/db.ts'
import { move }                from '../api/src/inventory.ts'
import { priceBasket, BASE }   from '../api/src/pricing.ts'

// ─── The unit, and why this file is not written in it ─────────────────────
//
// Every money column in the schema is `@money(USD)`, which stores a whole
// number of CENTS. The tables below are written in DOLLARS anyway — `price: 28`
// and not `price: 2800` — because a fixture is read and edited by people, and a
// four-figure integer beside a tee shirt is a number nobody can check at a
// glance. The conversion happens at the write, which is where it happens in the
// application too: a person types a major-unit amount into a form and the
// boundary stores the minor one.
//
// `cents` is `toMinor`, and it rounds: `8.29 * 100` is 828.9999999999999 in
// binary floating point, so the multiplication a seed file reaches for first
// loses a cent on prices that look exact.
const cents = (major: number) => toMinor(major, BASE)

// `Discount.value` is `@scale(2)` and not `@money`, because half its rows are a
// PERCENTAGE and not an amount (the schema says why). The scale is the same two
// places either way — 1050 is $10.50 under `fixed` and 10.50% under `percent` —
// so this is the same arithmetic under a name that does not claim it is money.
const scaled = (n: number) => Math.round(n * 100)

const DEMO = {
  user:  { email: 'sam@shop.test',  password: 'correct-horse-battery', name: 'Sam',  role: 'user'  },
  admin: { email: 'alex@shop.test', password: 'correct-horse-battery', name: 'Alex', role: 'admin' },
  // A SHOPPER, not staff. Same role as Sam — auth defaults it to "user" and
  // nothing about registering makes a person one of ours — which is exactly why
  // `isStaff` exists and why this one does not get it.
  buyer: { email: 'robin@buyer.test', password: 'correct-horse-battery', name: 'Robin Vale', role: 'user' },
}

// ─── The catalogue ────────────────────────────────────────────────────────
//
// Thirteen products, one row per option combination beneath them, and one
// photograph per colourway. Bigger than the four flat rows this file used to
// write, deliberately: a variant table with one variant per product proves
// nothing, and a filter bar over four rows has nothing to narrow.
//
// The pictures are seeded BY PATH. A `File` column accepts a filesystem path,
// a Buffer, a Blob or a browser File and hands the bytes to the storage
// provider, so the seed states `db/seed-media/fjs-tee-navy.png` and the plugin
// does the upload, the key and the stored reference. db/seed-media/ is
// committed; what the plugin writes under db/public/ is not.

/// Apparel is stocked in three sizes; everything else has one. `one` is a real
/// member of `enum Size` rather than a null — see the note in db/schema.lite
/// for what a nullable option column does to the composite @@unique.
const APPAREL = ['s', 'm', 'l'] as const

/// What a larger cut costs on top. Apparel only, and it is here rather than as
/// a flat price per product because a price lives on the VARIANT: with one
/// price per family the range the catalogue renders could never differ from
/// itself, and the code path that formats it would never run. The drive asserts
/// a range on screen, which is what keeps that honest.
const SIZE_UPLIFT: Record<string, number> = { s: 0, m: 0, l: 2, xl: 4, xxl: 6 }   // dollars

/// Which size carries the colourway photograph. A picture is of a COLOUR, and
/// a colour spans every size it is cut in, so the image hangs off one variant
/// and the product page finds it by matching colour rather than by id.
const PHOTO_SIZE = 'm'

type Colourway = {
  colour: string
  code:   string
  stock:  number
  image?: string
}

type SeedProduct = {
  slug:        string
  name:        string
  brand:       'frontierjs' | 'junction' | 'litestone'
  description: string
  skuStem:     string
  /** DOLLARS. `cents()` converts at the write — see the header. */
  price:       number
  sizes:       readonly string[]
  colours:     Colourway[]
  active?:     boolean
}

const CATALOGUE: SeedProduct[] = [
  {
    slug: 'explorer-tee', name: 'FrontierJS Explorer Tee', brand: 'frontierjs',
    description: 'Heavyweight cotton, screen-printed front. The explorer walks first and finds what matters.',
    skuStem: 'FJS-TEE', price: 28, sizes: APPAREL,
    colours: [
      { colour: 'Night Navy', code: 'NVY', stock: 40, image: 'fjs-tee-navy.png'  },
      { colour: 'Sandstone',  code: 'SND', stock: 32, image: 'fjs-tee-sand.png'  },
      { colour: 'Clay',       code: 'CLY', stock: 18, image: 'fjs-tee-clay.png'  },
      // Deliberately empty. A shop with nothing out of stock cannot show you
      // what out of stock LOOKS like, and the sold-out path is the one that
      // breaks quietly.
      { colour: 'Olive',      code: 'OLV', stock:  0, image: 'fjs-tee-olive.png' },
    ],
  },
  {
    slug: 'explorer-hoodie', name: 'FrontierJS Explorer Hoodie', brand: 'frontierjs',
    description: 'Brushed-back fleece, kangaroo pocket, print across the shoulders.',
    skuStem: 'FJS-HOOD', price: 65, sizes: APPAREL,
    colours: [
      { colour: 'Night Navy', code: 'NVY', stock: 22, image: 'fjs-hoodie-navy.png'  },
      { colour: 'Sandstone',  code: 'SND', stock: 14, image: 'fjs-hoodie-sand.png'  },
      { colour: 'Clay',       code: 'CLY', stock:  9, image: 'fjs-hoodie-clay.png'  },
      { colour: 'Olive',      code: 'OLV', stock: 11, image: 'fjs-hoodie-olive.png' },
    ],
  },

  {
    slug: 'junction-tee', name: 'Junction Tee', brand: 'junction',
    description: 'Routes. Resources. Resolved. Coal cotton, cream mark.',
    skuStem: 'JCT-TEE', price: 26, sizes: APPAREL,
    colours: [{ colour: 'Coal', code: 'COL', stock: 36, image: 'junction-tee.png' }],
  },
  {
    slug: 'junction-hoodie', name: 'Junction Hoodie', brand: 'junction',
    description: 'Heavy hood, sleeve print down both arms.',
    skuStem: 'JCT-HOOD', price: 62, sizes: APPAREL,
    colours: [{ colour: 'Coal', code: 'COL', stock: 16, image: 'junction-hoodie.png' }],
  },
  {
    slug: 'junction-cap', name: 'Junction Cap', brand: 'junction',
    description: 'Washed cotton six-panel, embroidered mark.',
    skuStem: 'JCT-CAP', price: 24, sizes: ['one'],
    colours: [{ colour: 'Parchment', code: 'PCH', stock: 25, image: 'junction-cap.png' }],
  },
  {
    slug: 'junction-camp-mug', name: 'Junction Camp Mug', brand: 'junction',
    description: 'Enamel over steel. Takes a knock, takes the heat.',
    skuStem: 'JCT-MUG', price: 18, sizes: ['one'],
    colours: [{ colour: 'Coal', code: 'COL', stock: 48, image: 'junction-mug.png' }],
  },
  {
    slug: 'junction-notebook', name: 'Junction Notebook', brand: 'junction',
    description: 'Hardback, dotted, elastic closure. Debossed mark.',
    skuStem: 'JCT-NOTE', price: 22, sizes: ['one'],
    colours: [{ colour: 'Coal', code: 'COL', stock: 30, image: 'junction-notebook.png' }],
  },
  {
    slug: 'junction-stickers', name: 'Junction Sticker Pack', brand: 'junction',
    description: 'Four die-cut vinyl stickers.',
    skuStem: 'JCT-STK', price: 6, sizes: ['one'],
    // Retired rather than deleted — the products screen filters on
    // Product.active, and a filter with nothing on the far side of it is a
    // control nobody can tell works.
    active: false,
    colours: [{ colour: 'Parchment', code: 'PCH', stock: 0, image: 'junction-sticker.png' }],
  },

  {
    slug: 'litestone-tee', name: 'Litestone Tee', brand: 'litestone',
    description: 'Black on black, feather mark at the chest and a full print down the side.',
    skuStem: 'LST-TEE', price: 30, sizes: APPAREL,
    colours: [{ colour: 'Black', code: 'BLK', stock: 27, image: 'litestone-tee.png' }],
  },
  {
    slug: 'litestone-hoodie', name: 'Litestone Hoodie', brand: 'litestone',
    description: 'Midweight zip hood, tonal feather.',
    skuStem: 'LST-HOOD', price: 70, sizes: APPAREL,
    colours: [{ colour: 'Black', code: 'BLK', stock: 12, image: 'litestone-hoodie.png' }],
  },
  {
    slug: 'litestone-cap', name: 'Litestone Cap', brand: 'litestone',
    description: 'Unstructured cotton cap, feather at the front panel.',
    skuStem: 'LST-CAP', price: 24, sizes: ['one'],
    colours: [{ colour: 'Black', code: 'BLK', stock: 19, image: 'litestone-cap.png' }],
  },
  {
    slug: 'litestone-camp-mug', name: 'Litestone Camp Mug', brand: 'litestone',
    description: 'Matte black enamel, etched feather.',
    skuStem: 'LST-MUG', price: 19, sizes: ['one'],
    colours: [{ colour: 'Black', code: 'BLK', stock: 41, image: 'litestone-mug.png' }],
  },
  {
    slug: 'litestone-tote', name: 'Litestone Tote', brand: 'litestone',
    description: 'Heavy canvas, long handles, screen-printed feather.',
    skuStem: 'LST-TOTE', price: 20, sizes: ['one'],
    colours: [{ colour: 'Black', code: 'BLK', stock: 33, image: 'litestone-tote.png' }],
  },
]

/// The colourway list — the source of `valueset ProductColour`.
///
/// `Ochre` is here and retired on purpose: it is what the `@@scope(current)` on
/// the set narrows away, so the picker on a variant form offers seven of these
/// eight and the eighth is still the answer for the tees that ran in it.
const COLOURS = [
  { name: 'Default',    hex: '#9ca3af' },
  { name: 'Night Navy', hex: '#1e293b' },
  { name: 'Sandstone',  hex: '#d6c7ae' },
  { name: 'Clay',       hex: '#a8613f' },
  { name: 'Olive',      hex: '#5d6b3f' },
  { name: 'Coal',       hex: '#2b2b2b' },
  { name: 'Parchment',  hex: '#efe6d2' },
  { name: 'Black',      hex: '#111111' },
  { name: 'Ochre',      hex: '#c98a1a', retired: true },
]

/**
 * Find a seeded row the drives may have removed, and bring it back if they did.
 *
 * A plain `findFirst` is why this exists. Six of this schema's models declare
 * `@@softDelete`, so a drive that deletes a seeded row over HTTP HIDES it — and
 * a soft-deleted row keeps its `@unique` values, deliberately, because
 * `restore()` has to be able to bring it back. The next seed then neither finds
 * the row (the read excludes it) nor may create one (the value is held), and
 * dies with a `SoftDeletedUniqueError` naming a table, an id and a column,
 * which is the Data boundary being correct and is not a sentence anybody
 * running `bun run db:seed` can act on.
 *
 * The seeder's contract is that it restores what a drive consumes (`FJS-080`).
 * Once removal is something the schema can express, restoring the row IS that
 * contract — five drives reseed as their first act, so without this the whole
 * self-starting half of the suite fails on the run after any order is deleted.
 *
 * Cascading models bring their children back with them, which is what
 * `@@softDelete(cascade)` already means: `restore` walks the same tree the
 * delete walked.
 */
async function reseed<T extends { id: number, deletedAt?: string | null }>(
  model: { findFirst: Function, restore: Function },
  where: Record<string, unknown>,
): Promise<T | null> {
  const hit = await model.findFirst({ where, withDeleted: true }) as T | null
  if (!hit?.deletedAt) return hit
  await model.restore({ where: { id: hit.id } })
  return await model.findFirst({ where }) as T | null
}

/**
 * The three tables that stand between the lines and the total.
 *
 * Guarded per table like everything else here. `TaxRate` in particular is
 * guarded on the DEFAULT rather than on the count: a shop with a rate row that
 * nothing marks as default charges no tax, which is a correct state and an
 * invisible one, so a re-seed has to be able to put the flag back.
 */
async function seedMoney() {
  if (await sys.taxRate.count() === 0) {
    // One rate, 20%, called what a UK receipt calls it. The label is seeded
    // rather than defaulted because a receipt reading `Tax` where the law says
    // `VAT` is a receipt a business customer cannot file.
    await sys.taxRate.create({ data: { label: 'VAT', rate: 0.2, isDefault: true, active: true } })
  }

  if (await sys.shippingMethod.count() === 0) {
    // Three, and the middle one carries the free-over threshold — which is the
    // member of this table that makes the arithmetic worth testing, because it
    // is measured against the subtotal AFTER the discount and a code can
    // therefore take a basket back BELOW the threshold it had qualified for.
    await sys.shippingMethod.createMany({ data: [
      { name: 'Standard', description: '3–5 working days', price: cents(4.95), freeOver: cents(75), position: 1 },
      { name: 'Express',  description: 'Next working day',  price: cents(12.5), freeOver: null,      position: 2 },
      { name: 'Collect',  description: 'Pick up in store',  price: cents(0),    freeOver: null,      position: 3 },
    ] })
  }

  if (await sys.discount.count() === 0) {
    // Four codes, one per thing that can go wrong with one. Every screen in
    // this app is built around the first; the other three exist so a drive can
    // reach each refusal without inventing rows of its own.
    const day = 24 * 60 * 60 * 1000
    await sys.discount.createMany({ data: [
      { code: 'WELCOME10', label: '10% off your first order', kind: 'percent', value: scaled(10) },
      { code: 'FIVER',     label: '5 off orders over 40',     kind: 'fixed',   value: scaled(5),
        minSubtotal: cents(40) },
      // Ended yesterday. A code that is a row and is worth nothing is a
      // different state from one that was never issued, and only a shop with
      // both in it can prove the two are told apart.
      { code: 'EXPIRED',   label: 'Last season',              kind: 'percent', value: scaled(25),
        endsAt: new Date(Date.now() - day).toISOString() },
      // One redemption, ever. What the checkout's read-modify-write is for.
      { code: 'ONLYONCE',  label: 'One customer only',        kind: 'fixed',   value: scaled(3),
        maxRedemptions: 1 },
    ] })
  }
}

async function seedColours() {
  for (const c of COLOURS) {
    if (await sys.colour.findFirst({ where: { name: c.name } })) continue
    await sys.colour.create({ data: c })
  }
}

async function seedCatalogue() {
  // Before the variants, and not only for the swatches: `colour` binds to
  // ProductColour as `open`, so a variant naming a colourway that is not on the
  // list would ADD it — silently, with no hex, from a seed file. The list is
  // the thing being seeded here; a variant is a reference to it.
  await seedColours()

  // Guarded per PRODUCT rather than per table. The table guard the rest of this
  // file uses answers "has anything been seeded", which stops a thirteenth
  // product added here from ever reaching a database that already has twelve.
  for (const p of CATALOGUE) {
    const existing = await reseed<any>(sys.product, { slug: p.slug })
    if (existing) continue

    const product = await sys.product.create({ data: {
      slug:        p.slug,
      name:        p.name,
      brand:       p.brand,
      description: p.description,
      active:      p.active ?? true,
    } })

    for (const c of p.colours) {
      for (const size of p.sizes) {
        // One SKU per row and it has to be unique across the whole shop, so it
        // carries every option that distinguishes the row. A one-size product
        // still spells its size out — dropping the segment would make
        // JCT-CAP-PCH mean two different things across two products' lifetimes.
        // Created EMPTY, then filled by a movement. The shelf and its ledger
        // have one writer (api/inventory.ts) and a seed that set `stock`
        // directly would be the second — leaving twelve products whose numbers
        // have no row explaining where they came from, which is the drift the
        // ledger exists to make impossible. It also means the inventory screen
        // has something to show on a fresh database.
        const variant = await sys.productVariant.create({ data: {
          productId: product.id,
          sku:       `${p.skuStem}-${c.code}-${size.toUpperCase()}`,
          colour:    c.colour,
          size,
          price:     cents(p.price + (SIZE_UPLIFT[size] ?? 0)),
        } })

        // A zero-stock colourway is seeded deliberately (see OLV below) and
        // there is nothing to record: `move()` refuses a delta of zero, because
        // a movement that moves nothing is a row that says nothing.
        if (c.stock > 0) await move(sys, variant.id, 'received', c.stock, {
          reference: 'OPENING',
          note:      'Opening stock',
        })

        if (!c.image) continue
        if (size !== PHOTO_SIZE && p.sizes.length > 1) continue

        await sys.productImage.create({ data: {
          productId: product.id,
          variantId: variant.id,
          // The plugin reads this path, uploads the bytes and stores the ref.
          // Relative to the process CWD, which is the example root — the same
          // assumption `database audit` already makes about its own path.
          file:      `./db/seed-media/${c.image}`,
          alt:       `${p.name} — ${c.colour}`,
          position:  p.colours.indexOf(c),
        } })
      }
    }
  }
}


async function seed(auth: ReturnType<typeof createLitestoneAuth>) {
  // Guarded PER TABLE, not once on products.
  //
  // A single `if (await sys.product.count() > 0) return` at the top made this
  // whole file a no-op forever after the first boot — and `web/test/verify.mjs`
  // deletes an order and drives the seeded ones through their transitions. So
  // the orders ran out, no restart ever brought them back, and the second run
  // of a drive that asserts 37 facts failed in ways that read as a regression
  // in whatever you had just changed. `ISSUES.md` FJS-080.
  //
  // Per-table is also the honest shape: this function's job is "the rows this
  // app needs in order to be clickable exist", and products existing says
  // nothing about orders.

  await seedCatalogue()
  await seedMoney()

  // By EMAIL rather than by count, and the reason is `@@softDelete`: `count()`
  // excludes hidden rows, so a run in which the customers screen removed both
  // reads zero here and then cannot create either of them — the email is still
  // held by the row that is merely hidden.
  for (const c of [
    { name: 'Acme Corp', firstName: 'Ada', lastName: 'Ashby',  email: 'ops@acme.test',   notes: 'Net-30. Always disputes shipping.' },
    { name: 'Globex',    firstName: 'Gil', lastName: 'Boothe', email: 'buy@globex.test', notes: 'Prefers pickup.' },
  ]) {
    if (!await reseed<any>(sys.customer, { email: c.email })) await sys.customer.create({ data: c })
  }

  // One order per interesting state, so every transition button has a row that
  // can actually exercise it. `pending` can pay or cancel; `paid` can ship,
  // refund (level 5) or cancel; `shipped` can do nothing at all.
  //
  // Restored by REFERENCE rather than by count: the drive creates its own
  // ORD-CDP-1, so "there are some orders" is not the same question as "the
  // three the screens were built around are present".
  const customers = await sys.customer.findMany({ orderBy: { id: 'asc' } })

  // The three, ITEMISED — and the totals are not typed here.
  //
  // An order says what was bought (`model OrderLine`), so a seed that stated a
  // total beside a list of items could state one the items do not add up to.
  // Every number below is summed from real catalogue rows, which also means a
  // price edit in CATALOGUE above cannot leave this block quietly wrong.
  //
  // Two lines on ORD-1002 and a quantity of two on ORD-1003, deliberately: a
  // one-line order of one thing is the shape that renders correctly whatever
  // the arithmetic does.
  const wanted = [
    { reference: 'ORD-1001', status: 'pending', customerId: customers[0]?.id,
      shipping: 'Standard',
      items: [{ sku: 'LST-TEE-BLK-M', quantity: 1 }] },
    // The one with a code on it. Every screen that draws a discount line was
    // built against this row, and it is `paid` so the receipt it produces is
    // one a refund is calculated from.
    { reference: 'ORD-1002', status: 'paid',    customerId: customers[0]?.id, note: 'Gift wrap',
      discountCode: 'WELCOME10', shipping: 'Standard',
      items: [{ sku: 'JCT-MUG-COL-ONE', quantity: 1 }, { sku: 'JCT-CAP-PCH-ONE', quantity: 1 }] },
    { reference: 'ORD-1003', status: 'shipped', customerId: customers[1]?.id, shipping: 'Express',
      items: [{ sku: 'FJS-TEE-NVY-L', quantity: 2 }] },
  ]

  for (const { items, discountCode, shipping, ...row } of wanted) {
    const lines = await orderLinesFor(items)
    const money = await priceOrder(lines, discountCode, shipping)

    const existing = await reseed<any>(sys.order, { reference: row.reference })
    if (existing) {
      // Present but moved on — the drive pays and ships these. Put the state
      // back so the next run finds the same buttons.
      if (existing.status !== row.status) {
        await sys.order.update({ where: { id: existing.id }, data: { status: row.status } })
      }
      // Lines arrived after these orders did, so a database seeded before them
      // has orders with nothing in them. Backfilled rather than left, because
      // an itemisation that is empty for the three rows every screen was built
      // around reads as the feature not working.
      if (await sys.orderLine.count({ where: { orderId: existing.id } }) === 0) {
        await sys.orderLine.createMany({ data: lines.map(l => ({ ...l, orderId: existing.id })) })
        await sys.order.update({ where: { id: existing.id }, data: money })
      } else if (!existing.subtotal) {
        // The breakdown arrived after the lines did, and the same argument
        // applies one layer up: an order carrying a total with a zero subtotal
        // beside it renders as a receipt whose arithmetic does not add up.
        // `subtotal` is `@default(0)`, so falsy here means *written before this
        // feature existed* — the only order that can legitimately have one is
        // an order with no lines, and this branch has already found lines.
        await sys.order.update({ where: { id: existing.id }, data: money })
      }
      continue
    }

    const order = await sys.order.create({ data: { ...row, ...money } })
    await sys.orderLine.createMany({ data: lines.map(l => ({ ...l, orderId: order.id })) })
  }

  // ── Demo users ───────────────────────────────────────────────────────────
  // Both are created email-VERIFIED. Left unverified they grade VISITOR(1) and
  // cannot write anything, which reads as "the app is broken" rather than "you
  // have not clicked the link in your email". See api/gate.ts.
  //
  // Guarded per user for the same reason as the tables above. This one bites
  // harder: `createUser` throws EmailTakenError (409), so without the check a
  // second boot does not merely skip the users — it kills the whole process
  // before the server ever listens.
  for (const who of [DEMO.user, DEMO.admin]) {
    if (!await sys.user.findFirst({ where: { email: who.email } })) await auth.createUser(who)

    // Stamped on every run and not only on creation, which is not tidiness: a
    // database seeded before `isStaff` existed has both of these rows already,
    // so an update guarded by the create above would leave Sam a shopper. It
    // reads as the policy being wrong — staff sees zero orders — and the column
    // is nowhere on screen to contradict it.
    //
    // `isStaff` is here rather than in `createUser`, which knows nothing about
    // it: it is the shop's own column (`extend model User` in db/schema.lite).
    // Not derivable from `role` either — auth defaults that to `"user"`, so
    // every shopper the storefront registers arrives with the role Sam has.
    await sys.user.updateMany({
      where: { email: who.email },
      data:  { emailVerified: true, isStaff: true },
    })
  }

  // A shopper with an account, so the storefront has somebody to be. Their
  // customer record is linked by `userId` — the same write `carts.checkout`
  // makes when a signed-in person buys — which is what turns `@@allow('read',
  // userId == auth().id)` on Order and Customer from a rule into a screen.
  if (!await sys.user.findFirst({ where: { email: DEMO.buyer.email } })) {
    await auth.createUser(DEMO.buyer)
    await sys.user.updateMany({ where: { email: DEMO.buyer.email }, data: { emailVerified: true } })
  }
  const buyerUser = await sys.user.findFirst({ where: { email: DEMO.buyer.email } })
  const buyerCustomer = await reseed<any>(sys.customer, { email: DEMO.buyer.email })
  if (buyerUser && !buyerCustomer) {
    await sys.customer.create({ data: {
      email:     DEMO.buyer.email,
      name:      DEMO.buyer.name,
      firstName: DEMO.buyer.name.split(' ')[0],
      lastName:  DEMO.buyer.name.split(' ').slice(1).join(' ') || DEMO.buyer.name,
      userId:    buyerUser.id,
    } })
  } else if (buyerUser && buyerCustomer && !buyerCustomer.userId) {
    await sys.customer.update({ where: { id: buyerCustomer.id }, data: { userId: buyerUser.id } })
  }

  // …and something in their history, so the account page has a page to be.
  //
  // `userId` on the order AND on every line. Two columns holding one fact,
  // because a row policy cannot name a column on a related model (`FJS-499`) —
  // the schema says so where the columns are declared. A seed that wrote only
  // the order would give the account page an order it can open and an
  // itemisation it cannot read, which is the exact failure the second column
  // exists to prevent, arriving as an empty table rather than an error.
  const buyerRecord = await reseed<any>(sys.customer, { email: DEMO.buyer.email })
  if (buyerUser && buyerRecord && !await reseed<any>(sys.order, { reference: 'ORD-2001' })) {
    const lines = await orderLinesFor([
      { sku: 'FJS-TEE-NVY-L',   quantity: 1 },
      { sku: 'JCT-MUG-COL-ONE', quantity: 2 },
    ])
    const order = await sys.order.create({ data: {
      reference:  'ORD-2001',
      status:     'shipped',
      customerId: buyerRecord.id,
      userId:     buyerUser.id,
      ...await priceOrder(lines, null, 'Standard'),
    } })
    await sys.orderLine.createMany({
      data: lines.map(l => ({ ...l, orderId: order.id, userId: buyerUser.id })),
    })
  }
}

/**
 * Lines → the nine columns a receipt is made of.
 *
 * Goes through `priceBasket` — the same function `carts.checkout` prices a real
 * sale with — rather than adding the lines up here. A seed that did its own
 * arithmetic would be a second opinion about what an order costs, and it would
 * be the opinion every screen was built against: the drives assert the numbers
 * on these rows, so a divergence would make the tests agree with the seed and
 * disagree with the shop.
 *
 * The code and the method are looked up by the names above, so a seed naming
 * one that is not there fails loudly rather than quietly pricing without it.
 */
async function priceOrder(
  lines: Array<{ lineTotal: number }>,
  code: string | null | undefined,
  shipping: string | null | undefined,
) {
  const discount = code
    ? await sys.discount.findFirst({ where: { code } })
    : null
  if (code && !discount) throw new Error(`seed: no discount with code ${code}`)

  const method = shipping
    ? await sys.shippingMethod.findFirst({ where: { name: shipping } })
    : null
  if (shipping && !method) throw new Error(`seed: no shipping method called ${shipping}`)

  const taxRate = await sys.taxRate.findFirst({ where: { active: true, isDefault: true } })

  return priceBasket(
    lines.map(l => ({ total: l.lineTotal })),
    { discount: discount as any, shippingMethod: method as any, taxRate: taxRate as any },
  )
}

/**
 * Catalogue rows → order lines, priced and worded from what is actually there.
 *
 * The line's copies are made HERE rather than restated in the block above, for
 * the same reason `carts.checkout` makes them at the moment of sale: the price
 * and the description are facts about the catalogue at the time the order was
 * placed, and a seed that typed them would be asserting a second opinion about
 * what the shop sells.
 *
 * A SKU that is not there throws, naming it. A missing line would show up as an
 * order whose total is short by one item — arithmetic that is wrong and looks
 * fine, which is the failure this whole model exists to end.
 */
async function orderLinesFor(items: Array<{ sku: string, quantity: number }>) {
  const out = []
  for (const { sku, quantity } of items) {
    const variant = await sys.productVariant.findFirst({
      where:   { sku },
      include: { product: true },
    })
    if (!variant) throw new Error(`seed: no variant with sku ${sku} — the catalogue above changed`)

    const product = (variant as Record<string, any>).product ?? {}
    out.push({
      variantId:   variant.id,
      sku:         variant.sku,
      description: `${product.name} — ${variant.colour} · ${variant.size}`,
      quantity,
      unitPrice:   variant.price,
      lineTotal:   variant.price * quantity,
    })
  }
  return out
}

// ─── Run ──────────────────────────────────────────────────────────────────
//
// The same auth `api/src/app.ts` builds, and for the same reason: a password
// belongs in a Credential row as a hash, and createUser is the only thing that
// knows that shape. `sessionFields` is absent because nothing here issues a
// session.

const auth = createLitestoneAuth(db, {
  encryptionKey: process.env.ENCRYPTION_KEY ?? DEV_KEY,
})

await seed(auth)

const [products, customers, orders, users] = await Promise.all([
  sys.product.count(), sys.customer.count(), sys.order.count(), sys.user.count(),
])

console.log(`
  seeded  ${products} product(s) · ${customers} customer(s) · ${orders} order(s) · ${users} user(s)

  sign in as  ${DEMO.user.email}  / ${DEMO.user.password}   → level 4
              ${DEMO.admin.email} / ${DEMO.admin.password}  → level 5
  shop as     ${DEMO.buyer.email} / ${DEMO.buyer.password}  → a customer, not staff
`)
