// site/src/routes/pricing/index.meta.js — the pricing page's build-time data.
//
// load() runs in Node at BUILD time and whatever it returns is baked into a
// public HTML file, so the same rule the catalogue lives under applies: Sierra
// taps this client with $tapQuery while this runs and refuses to emit the page
// if anything read here is gated above what the route declares (nothing, so
// level 0). `Plan` and `PlanVersion` are both `@@gate("0.5.5.5")` — a pricing
// page is public exactly as a catalogue is, and only staff change what a shop
// charges.
//
// ─── Why `currentPrice` and not a second query ─────────────────────────────
//
// A price is a `PlanVersion` row with a lifetime, so *what does this plan cost
// today* is *the open window's price* — which the model already answers:
// `currentPrice` is `@from(PlanVersion, max: price, where: "effectiveTo IS
// NULL")`, a subquery litestone compiles into the read. Assembling it here
// would mean shipping the whole version table into a page that renders four
// rows, and would put a second opinion about *what a price is* in a file
// nobody looks at again.
import { sys } from '../../../../api/src/core/db.ts'

export async function load() {
  // `active` is what retires a plan. The rows stay — every past subscription
  // points at a version of one — so a pricing page that listed every plan would
  // offer things the shop stopped selling.
  const plans = await sys.plan.findMany({
    where:   { active: true },
    orderBy: { code: 'asc' },
    limit:   50,
  })

  return {
    // Sorted by what it costs, because that is the order a person reads a price
    // list in. Done here rather than in the query for one reason: a plan with
    // no open window has a null price and belongs at the end rather than at the
    // front, which is where SQLite puts a NULL ascending.
    plans: plans
      .map(p => ({
        code:        p.code,
        name:        p.name,
        blurb:       p.description ?? '',
        interval:    p.interval,
        price:       p.currentPrice,
      }))
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)),
  }
}
