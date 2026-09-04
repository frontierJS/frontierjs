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
import { move }                from '../api/src/domain/shop'
import { priceBasket, BASE }   from '../api/src/domain/shop'
import { issueInvoice, periodLines, settleInvoice } from '../api/src/domain/billing'

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
// photograph per colorway. Bigger than the four flat rows this file used to
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

/// Which size carries the colorway photograph. A picture is of a COLOR, and
/// a color spans every size it is cut in, so the image hangs off one variant
/// and the product page finds it by matching color rather than by id.
const PHOTO_SIZE = 'm'

type Colorway = {
  color: string
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
  colors:     Colorway[]
  active?:     boolean
}

const CATALOGUE: SeedProduct[] = [
  {
    slug: 'explorer-tee', name: 'FrontierJS Explorer Tee', brand: 'frontierjs',
    description: 'Heavyweight cotton, screen-printed front. The explorer walks first and finds what matters.',
    skuStem: 'FJS-TEE', price: 28, sizes: APPAREL,
    colors: [
      { color: 'Night Navy', code: 'NVY', stock: 40, image: 'fjs-tee-navy.png'  },
      { color: 'Sandstone',  code: 'SND', stock: 32, image: 'fjs-tee-sand.png'  },
      { color: 'Clay',       code: 'CLY', stock: 18, image: 'fjs-tee-clay.png'  },
      // Deliberately empty. A shop with nothing out of stock cannot show you
      // what out of stock LOOKS like, and the sold-out path is the one that
      // breaks quietly.
      { color: 'Olive',      code: 'OLV', stock:  0, image: 'fjs-tee-olive.png' },
    ],
  },
  {
    slug: 'explorer-hoodie', name: 'FrontierJS Explorer Hoodie', brand: 'frontierjs',
    description: 'Brushed-back fleece, kangaroo pocket, print across the shoulders.',
    skuStem: 'FJS-HOOD', price: 65, sizes: APPAREL,
    colors: [
      { color: 'Night Navy', code: 'NVY', stock: 22, image: 'fjs-hoodie-navy.png'  },
      { color: 'Sandstone',  code: 'SND', stock: 14, image: 'fjs-hoodie-sand.png'  },
      { color: 'Clay',       code: 'CLY', stock:  9, image: 'fjs-hoodie-clay.png'  },
      { color: 'Olive',      code: 'OLV', stock: 11, image: 'fjs-hoodie-olive.png' },
    ],
  },

  {
    slug: 'junction-tee', name: 'Junction Tee', brand: 'junction',
    description: 'Routes. Resources. Resolved. Coal cotton, cream mark.',
    skuStem: 'JCT-TEE', price: 26, sizes: APPAREL,
    colors: [{ color: 'Coal', code: 'COL', stock: 36, image: 'junction-tee.png' }],
  },
  {
    slug: 'junction-hoodie', name: 'Junction Hoodie', brand: 'junction',
    description: 'Heavy hood, sleeve print down both arms.',
    skuStem: 'JCT-HOOD', price: 62, sizes: APPAREL,
    colors: [{ color: 'Coal', code: 'COL', stock: 16, image: 'junction-hoodie.png' }],
  },
  {
    slug: 'junction-cap', name: 'Junction Cap', brand: 'junction',
    description: 'Washed cotton six-panel, embroidered mark.',
    skuStem: 'JCT-CAP', price: 24, sizes: ['one'],
    colors: [{ color: 'Parchment', code: 'PCH', stock: 25, image: 'junction-cap.png' }],
  },
  {
    slug: 'junction-camp-mug', name: 'Junction Camp Mug', brand: 'junction',
    description: 'Enamel over steel. Takes a knock, takes the heat.',
    skuStem: 'JCT-MUG', price: 18, sizes: ['one'],
    colors: [{ color: 'Coal', code: 'COL', stock: 48, image: 'junction-mug.png' }],
  },
  {
    slug: 'junction-notebook', name: 'Junction Notebook', brand: 'junction',
    description: 'Hardback, dotted, elastic closure. Debossed mark.',
    skuStem: 'JCT-NOTE', price: 22, sizes: ['one'],
    colors: [{ color: 'Coal', code: 'COL', stock: 30, image: 'junction-notebook.png' }],
  },
  {
    slug: 'junction-stickers', name: 'Junction Sticker Pack', brand: 'junction',
    description: 'Four die-cut vinyl stickers.',
    skuStem: 'JCT-STK', price: 6, sizes: ['one'],
    // Retired rather than deleted — the products screen filters on
    // Product.active, and a filter with nothing on the far side of it is a
    // control nobody can tell works.
    active: false,
    colors: [{ color: 'Parchment', code: 'PCH', stock: 0, image: 'junction-sticker.png' }],
  },

  {
    slug: 'litestone-tee', name: 'Litestone Tee', brand: 'litestone',
    description: 'Black on black, feather mark at the chest and a full print down the side.',
    skuStem: 'LST-TEE', price: 30, sizes: APPAREL,
    colors: [{ color: 'Black', code: 'BLK', stock: 27, image: 'litestone-tee.png' }],
  },
  {
    slug: 'litestone-hoodie', name: 'Litestone Hoodie', brand: 'litestone',
    description: 'Midweight zip hood, tonal feather.',
    skuStem: 'LST-HOOD', price: 70, sizes: APPAREL,
    colors: [{ color: 'Black', code: 'BLK', stock: 12, image: 'litestone-hoodie.png' }],
  },
  {
    slug: 'litestone-cap', name: 'Litestone Cap', brand: 'litestone',
    description: 'Unstructured cotton cap, feather at the front panel.',
    skuStem: 'LST-CAP', price: 24, sizes: ['one'],
    colors: [{ color: 'Black', code: 'BLK', stock: 19, image: 'litestone-cap.png' }],
  },
  {
    slug: 'litestone-camp-mug', name: 'Litestone Camp Mug', brand: 'litestone',
    description: 'Matte black enamel, etched feather.',
    skuStem: 'LST-MUG', price: 19, sizes: ['one'],
    colors: [{ color: 'Black', code: 'BLK', stock: 41, image: 'litestone-mug.png' }],
  },
  {
    slug: 'litestone-tote', name: 'Litestone Tote', brand: 'litestone',
    description: 'Heavy canvas, long handles, screen-printed feather.',
    skuStem: 'LST-TOTE', price: 20, sizes: ['one'],
    colors: [{ color: 'Black', code: 'BLK', stock: 33, image: 'litestone-tote.png' }],
  },
]

/// The colorway list — the source of `valueset ProductColor`.
///
/// `Ochre` is here and retired on purpose: it is what the `@@scope(current)` on
/// the set narrows away, so the picker on a variant form offers seven of these
/// eight and the eighth is still the answer for the tees that ran in it.
const COLORS = [
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

async function seedColors() {
  for (const c of COLORS) {
    if (await sys.color.findFirst({ where: { name: c.name } })) continue
    await sys.color.create({ data: c })
  }
}

async function seedCatalogue() {
  // Before the variants, and not only for the swatches: `color` binds to
  // ProductColor as `open`, so a variant naming a colorway that is not on the
  // list would ADD it — silently, with no hex, from a seed file. The list is
  // the thing being seeded here; a variant is a reference to it.
  await seedColors()

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

    for (const c of p.colors) {
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
          color:    c.color,
          size,
          price:     cents(p.price + (SIZE_UPLIFT[size] ?? 0)),
        } })

        // A zero-stock colorway is seeded deliberately (see OLV below) and
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
          alt:       `${p.name} — ${c.color}`,
          position:  p.colors.indexOf(c),
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

  // Last, because it needs the buyer's customer row and the shop's tax rate.
  await seedBilling()
}


/**
 * The recurring half — one plan, its price window, a live subscription and the
 * invoice it has already been charged.
 *
 * Two things here are deliberately unlike everything above.
 *
 * **The plan's price is a ROW with a lifetime**, not a column, so this seeds a
 * closed window and an open one: the shop raised its price, and the subscriber
 * below is still on the old one. That pair is the whole of what effective
 * dating is for and it is invisible in a shop with one price.
 *
 * **The invoice is written WHOLE.** Every money column on it is `@immutable`
 * (`FJS-D162`), so there is no row to add lines to afterwards — header and
 * lines go in one transaction, and the subtotal is summed from the lines here
 * rather than typed, for the reason `priceOrder` exists: a seed that states a
 * total beside a list can state one the list does not add up to.
 */
async function seedBilling() {
  const PLAN = 'PRO'

  let plan = await sys.plan.findFirst({ where: { code: PLAN } })
  if (!plan) {
    plan = await sys.plan.create({ data: {
      code: PLAN, name: 'Pro', interval: 'monthly',
      description: 'Everything in the shop, restocked monthly.',
    } })
  }

  // Two versions: one that ended when the price went up, one still open.
  // `@@unique([planId], where: effectiveTo == null)` says *only one open window*
  // since `FJS-603` closed, and a seed is one of the four writers that reaches
  // no service — so it is HELD to the rule rather than trusted with it, and it
  // closes before it opens.
  if (await sys.planVersion.count({ where: { planId: plan.id } }) === 0) {
    const raisedOn = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    await sys.planVersion.create({ data: {
      planId: plan.id, price: cents(19), effectiveFrom: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
      effectiveTo: raisedOn,
    } })
    await sys.planVersion.create({ data: {
      planId: plan.id, price: cents(24), effectiveFrom: raisedOn,
    } })
  }

  // ─── The rest of the price list ─────────────────────────────────────────
  //
  // `PRO` above carries the argument — two windows, a subscriber on the older
  // one — and these carry the PAGE: a pricing page with one row on it cannot
  // show a plan being compared to another, cannot show two intervals side by
  // side, and cannot show that `active: false` is what retires a plan rather
  // than deleting the rows every past subscription points at.
  //
  // One version each and it is open, which is the state a price is in for
  // almost all of its life. They are seeded through the same two writes the
  // block above uses rather than through `plans.reprice`, because a seed runs
  // with no request and `reprice` is a service method — the shop's own way of
  // saying *charge something else from now on*, which needs a caller.
  for (const spec of [
    { code: 'STARTER', name: 'Starter',    interval: 'monthly' as const, price: cents(9),
      description: 'One shelf, restocked when you ask.',            active: true },
    { code: 'SCALE',   name: 'Scale',      interval: 'monthly' as const, price: cents(49),
      description: 'Every shelf, restocked weekly, with a buyer.',  active: true },
    { code: 'PROYEAR', name: 'Pro annual', interval: 'yearly'  as const, price: cents(240),
      description: 'Pro, paid for the year — two months of it free.', active: true },
    { code: 'LEGACY',  name: 'Legacy',     interval: 'monthly' as const, price: cents(12),
      description: 'Closed to new subscribers.',                    active: false },
  ]) {
    let row = await sys.plan.findFirst({ where: { code: spec.code } })
    if (!row) {
      row = await sys.plan.create({ data: {
        code: spec.code, name: spec.name, interval: spec.interval,
        description: spec.description, active: spec.active,
      } })
    }
    if (await sys.planVersion.count({ where: { planId: row.id } }) === 0) {
      await sys.planVersion.create({ data: { planId: row.id, price: spec.price } })
    }
  }

  const versions = await sys.planVersion.findMany({
    where: { planId: plan.id }, orderBy: { effectiveFrom: 'asc' },
  })
  const soldAt = versions[0]                  // the subscriber is on the OLD price
  const buyerUser     = await sys.user.findFirst({ where: { email: DEMO.buyer.email } })
  const buyerCustomer = await reseed<any>(sys.customer, { email: DEMO.buyer.email })
  if (!soldAt || !buyerCustomer) return

  const REF = 'SUB-3001'
  let sub = await sys.subscription.findFirst({ where: { reference: REF } })

  // Put it back on its feet. `verify:billing` drives a subscription to
  // `cancelled` and the deadline is a one-way door, so without this the demo
  // shop's only subscription is dead after the first run and no re-seed brings
  // it back — the row exists, so the branch below never fires. The same shape
  // as `reseed()` restoring a soft-deleted customer, one state machine along.
  // `asSystem()` is what makes it possible at all: it bypasses `@@transitions`
  // like every other rule that is not a check.
  if (sub && sub.status === 'cancelled') {
    await sys.subscription.update({ where: { id: sub.id }, data: { status: 'active', cancelledAt: null },
                                    system: ['cancelledAt'] })
    sub = await sys.subscription.findFirst({ where: { id: sub.id } })
  }

  // …and back onto the price it was SOLD at, with the seats it was sold with.
  // `verify` changes both — a plan reprice and a mid-cycle seat change are what
  // that drive is for — and neither is restored by the branch below, which only
  // fires when the row does not exist. Without this the demo shop drifts one
  // change per run and the thing the seed exists to show (a subscriber on a
  // price the plan no longer sells at) stops being true after the first.
  if (sub && (sub.planVersionId !== soldAt.id || sub.quantity !== 2)) {
    await sys.subscription.update({
      where: { id: sub.id }, data: { planVersionId: soldAt.id, quantity: 2 },
    })
    sub = await sys.subscription.findFirst({ where: { id: sub.id } })
  }

  if (!sub) {
    const periodStart = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    const periodEnd   = new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000)
    sub = await sys.subscription.create({ data: {
      reference: REF,
      customerId: buyerCustomer.id,
      planVersionId: soldAt.id,
      status: 'active',
      quantity: 2,
      currentPeriodStart: periodStart.toISOString(),
      currentPeriodEnd:   periodEnd.toISOString(),
      userId: buyerUser?.id ?? null,
    } })
  }

  // The document, through the same function the renewal job issues one with.
  //
  // `issueInvoice` sums the lines, reads the shop's own tax rate, mints the due
  // date from the shop's terms and writes the header and the lines in one
  // transaction. A seed that wrote those columns itself would be a second
  // opinion about what an invoice IS — and it would be the opinion every screen
  // and every drive was built against.
  const INV = 'INV-3001'
  if (!await sys.invoice.findFirst({ where: { number: INV } })) {
    const plan = await sys.plan.findFirst({ where: { id: soldAt.planId } })
    await issueInvoice(sys, {
      number:         INV,
      customerId:     buyerCustomer.id,
      subscriptionId: sub.id,
      userId:         buyerUser?.id ?? null,
      periodStart:    sub.currentPeriodStart,
      periodEnd:      sub.currentPeriodEnd,
      issuedAt:       sub.currentPeriodStart,
      lines: periodLines({
        name:        plan?.name ?? 'Pro',
        quantity:    sub.quantity,
        unitAmount:  soldAt.price,
        periodStart: sub.currentPeriodStart,
        periodEnd:   sub.currentPeriodEnd,
      }),
    })

  }

  // Settled, and that is not decoration. The seeded period started ten days
  // ago, so the invoice is already past the shop's seven-day terms — an unpaid
  // one puts the demo shop into dunning on the first cron fire and cancels its
  // only subscription for a reason nobody asked for.
  //
  // Outside the branch above, because the branch only fires the first time and
  // this has to be true on every run: a drive can settle it, void it, or leave
  // a re-seeded shop holding an overdue document.
  const issued = await sys.invoice.findFirst({ where: { number: INV } })
  if (issued?.status === 'issued') await settleInvoice(sys, issued.id, issued.dueAt)
  // A row an earlier seed settled with the transition alone, before
  // `settleInvoice` owned both writes. Repaired rather than left, because a
  // paid invoice with no payment date is the kind of thing a screen renders as
  // a blank and nobody notices.
  else if (issued && !issued.paidAt)
    await sys.invoice.update({ where: { id: issued.id }, data: { paidAt: issued.dueAt }, system: ['paidAt'] })
}

// ─── The payroll ──────────────────────────────────────────────────────────

/**
 * Three people, with pay HISTORIES rather than pay.
 *
 * A single window per person would let every as-at read pass by accident: with
 * one row, *what were they on in March* and *what are they on* are the same
 * query. Each of these is seeded with a window that has already CLOSED and one
 * that is open, so a read that forgets its instant gets a different answer from
 * one that does not.
 *
 * The dates are relative to the run for `db:seed`'s usual reason — a fixture
 * pinned to a literal year stops being *last March* the moment the year turns.
 *
 * The third person has LEFT, which is the half `PayWindow` says nothing
 * about: their pay window is still open, and they are still not on a payroll
 * run dated after they went. `employedAt` is what separates the two, and
 * seeding somebody who exercises it is what stops that being theoretical.
 */
/**
 * The band tables, as of a year ago.
 *
 * Dated in the past rather than at `now` so that every as-at read in
 * `verify:employment` has bands in force — a table opened at the instant the
 * seed ran answers nothing for any date before it, and a drive asking what
 * March looked like would get zero tax and pass.
 *
 * The figures are UK-shaped and the shape is what matters: a zero band that is
 * the personal allowance, two bands above it, an unbounded top band, and a flat
 * contribution with a floor. Nothing here is advice.
 */
async function seedPayRates() {
  const DAY  = 24 * 60 * 60 * 1000
  const from = new Date(Date.now() - 400 * DAY).toISOString()

  // [kind, fromAmount, toAmount, percent] — minor units, and percent at two
  // places (2000 is 20.00%), which is `Discount.value`'s spelling.
  const BANDS = [
    ['incomeTax',       0,           1_257_000,   0],
    ['incomeTax',       1_257_000,   5_027_000,   2000],
    ['incomeTax',       5_027_000,   12_514_000,  4000],
    ['incomeTax',       12_514_000,  null,        4500],

    // Flat above a floor, which is the other shape a band table holds and the
    // one that would pass unnoticed if every kind were a ladder.
    ['employeePension', 624_000,     null,        500],
    ['employerPension', 624_000,     null,        300],
    ['employerNI',      910_000,     null,        1380],
  ] as const

  for (const [kind, fromAmount, toAmount, percent] of BANDS) {
    const held = await sys.payRate.findFirst({
      where: { kind, fromAmount, effectiveTo: null },
    })
    if (held) continue
    await sys.payRate.create({ data: {
      kind, fromAmount, toAmount, percent, effectiveFrom: from,
    } })
  }
}

async function seedPayroll() {
  const DAY  = 24 * 60 * 60 * 1000
  const ago  = (days: number) => new Date(Date.now() - days * DAY).toISOString()

  const PEOPLE = [
    { reference: 'EMP-1001', name: 'Dana Fletcher', email: 'dana@shop.test',
      startedOn: ago(900), endedOn: null,
      windows: [
        { basis: 'salary', rate: 4_200_000, hoursPerWeek: 40, from: ago(900), to: ago(200) },
        { basis: 'salary', rate: 4_800_000, hoursPerWeek: 40, from: ago(200), to: null    },
      ] },
    { reference: 'EMP-1002', name: 'Ira Sandoval', email: 'ira@shop.test',
      startedOn: ago(500), endedOn: null,
      windows: [
        { basis: 'hourly', rate: 1_850, hoursPerWeek: 30, from: ago(500), to: ago(120) },
        { basis: 'hourly', rate: 2_100, hoursPerWeek: 35, from: ago(120), to: null    },
      ] },
    // Left. The open window is deliberate: leaving does not close a pay window,
    // and a payroll that read the terms table alone would keep paying them.
    { reference: 'EMP-1003', name: 'Wren Okafor', email: 'wren@shop.test',
      startedOn: ago(700), endedOn: ago(60),
      windows: [
        { basis: 'salary', rate: 3_600_000, hoursPerWeek: 40, from: ago(700), to: null },
      ] },
  ] as const

  for (const person of PEOPLE) {
    let employee = await sys.employee.findFirst({ where: { reference: person.reference } })
    if (!employee) {
      employee = await sys.employee.create({ data: {
        reference: person.reference, name: person.name, email: person.email,
        startedOn: person.startedOn, endedOn: person.endedOn,
      } })
    }

    // Idempotent by REBUILDING, not by matching, and that is a correction worth
    // keeping: this loop first keyed on `effectiveFrom`, which is `ago(900)` —
    // recomputed on every run, so nothing ever matched and each `db:seed` added
    // another whole history. Three seeds gave one person six windows, several of
    // them open at once, and the next as-at read refused by name. A seed whose
    // idempotency key is a computed timestamp is not idempotent.
    //
    // The count is the check because the history is the fixture: if it is not
    // exactly the windows below, it is somebody else's and this rebuilds it.
    // Drives mint their own employee under a run prefix and are unaffected.
    const held = await sys.payWindow.findMany({ where: { employeeId: employee.id } })
    if (held.length !== person.windows.length) {
      if (held.length) await sys.payWindow.deleteMany({ where: { employeeId: employee.id } })
      for (const w of person.windows) {
        await sys.payWindow.create({ data: {
          employeeId:    employee.id,
          basis:         w.basis,
          rate:          w.rate,
          hoursPerWeek:  w.hoursPerWeek,
          effectiveFrom: w.from,
          effectiveTo:   w.to,
        } })
      }
    }
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
      description: `${product.name} — ${variant.color} · ${variant.size}`,
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

await seedPayRates()
await seedPayroll()

const [products, customers, orders, users, staff] = await Promise.all([
  sys.product.count(), sys.customer.count(), sys.order.count(), sys.user.count(), sys.employee.count(),
])

console.log(`
  seeded  ${products} product(s) · ${customers} customer(s) · ${orders} order(s) · ${users} user(s) · ${staff} employee(s)

  sign in as  ${DEMO.user.email}  / ${DEMO.user.password}   → level 4
              ${DEMO.admin.email} / ${DEMO.admin.password}  → level 5
  shop as     ${DEMO.buyer.email} / ${DEMO.buyer.password}  → a customer, not staff
`)
