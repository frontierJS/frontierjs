/**
 * web/test/verify-geo.mjs — where a row IS, across three realms at once.
 *
 * **bun, one server.** The Data half of `@point` has its own unit suite in
 * litestone and the control has its own browser drive in `@frontierjs/ui`; what
 * neither can reach is the CROSSING, and the crossing is the whole claim:
 *
 *   `?site[near][lat]=51.5074&site[near][lng]=-0.1278&site[near][within]=5mi`
 *
 * `FJS-D323` ruled that a proximity search travels as the bracket notation
 * `@frontierjs/toolbelt/query` already carries structure in, rather than as a
 * compact triple only the geo layer can read — so it is parsed by the three
 * readers that already existed and not by a fourth. That is a statement about
 * a real URL reaching a real Data boundary, and a unit test on either side of
 * the wire passes with it broken.
 *
 * ─── What this drive is FOR ───────────────────────────────────────────────
 *
 * Four things, each of which fails with a 200 rather than an error:
 *
 *   - the SEARCH. A radius that admits three branches and refuses two, asked
 *     over HTTP, compared against a brute-force scan of the same rows computed
 *     here with the kit. A prefilter that drops a row answers fewer rows and
 *     says nothing, which is the defect Elasticsearch, qdrant and GeoBlacklight
 *     each shipped.
 *   - the ORDER. Nearest-first has to be the QUERY's ordering and not the
 *     page's, or the second page is the wrong rows — so it is asked with a
 *     `$limit` small enough that a client-side sort could not produce the
 *     answer.
 *   - the TYPES. `within` must arrive as TEXT (`5mi` is not a number) and the
 *     coordinates as NUMBERS, over a transport that carries only strings.
 *   - the REFUSALS, by name: every operator but `near` on a point column, a
 *     radius with no unit, and — the one the database alone can answer — a
 *     half-set coordinate written through `asSystem()`, which reaches no
 *     validator at all.
 *
 * Start first:
 *
 *   bun run db:seed     # the branches
 *   bun run api         # terminal 1
 *   bun run verify:geo
 */

import { db } from '../../api/src/core/db.ts'
import { distance } from '@frontierjs/toolbelt/geo'
import { parseLength } from '@frontierjs/toolbelt/units'
import { encodeQueryString } from '@frontierjs/toolbelt/query'
import { results, report } from './lib/report.mjs'
import { requireServers } from './lib/preflight.mjs'

const API = process.env.API_URL ?? 'http://localhost:8110'

await requireServers([['api (bun run api)', `${API}/api/health`]])

const { got, t } = results()
const sys = db.asSystem()

// The middle of London, and the center every assertion here is about.
const LONDON = { lat: 51.5074, lng: -0.1278 }

const refused = async (fn) => { try { await fn(); return false } catch { return true } }

/** A list read the way a browser reads one: a query STRING, no session. */
async function ask(query, directives = {}) {
  const res  = await fetch(`${API}/api/pickup-points${encodeQueryString({ ...query, ...directives })}`)
  const body = await res.json()
  return { status: res.status, rows: body?.data ?? [], body }
}

const names = (rows) => rows.map(r => r.name)

// ─── The rows this drive is about ─────────────────────────────────────────

const all = await sys.pickupPoint.findMany()
t('seed.theBranchesAreThere', all.length >= 6)
t('seed.oneHasNoCoordinateYet', all.some(p => p.site === null))

// ─── A stranger may ask, which is half of why this model reads at 0 ───────

const open = await ask({})
t('gate.aStrangerListsThem', open.status === 200 && open.rows.length >= 6)

// ─── The search, graded against a brute-force scan ────────────────────────
//
// The comparison is the gate. A radius asserted against a hand-written list of
// names passes against a filter that is wrong by a few hundred metres; this
// measures every seeded row here, with the same function the SQL agrees with,
// and demands the same set.

const NEAR_5MI = { site: { near: { ...LONDON, within: '5mi' } } }

const within5 = await ask(NEAR_5MI)
const metres  = parseLength('5mi')
const brute   = all.filter(p => p.site && distance(p.site, LONDON) <= metres).map(p => p.name)

t('near.theRadiusAdmitsSome',   brute.length >= 3)
t('near.andRefusesOthers',      brute.length < all.length)
t('near.matchesABruteForceScan', JSON.stringify(names(within5.rows).sort()) === JSON.stringify([...brute].sort()))
t('near.aRowWithNoPointIsInNoCircle', !names(within5.rows).includes('Milton Keynes'))

// A wider circle takes in a row the narrow one did not — the control that makes
// the assertion above evidence rather than a coincidence about one radius.
const within100 = await ask({ site: { near: { ...LONDON, within: '100mi' } } })
t('near.aWiderRadiusTakesInMore', within100.rows.length > within5.rows.length)

// ─── The ORDER is the query's, proved by a window too small to sort ───────

const ORDERED = { $orderBy: { site: { near: LONDON } } }

const firstTwo = await ask({}, { ...ORDERED, $limit: 2 })
const nextTwo  = await ask({}, { ...ORDERED, $limit: 2, $offset: 2 })

const byDistance = all
  .filter(p => p.site)
  .sort((a, b) => distance(a.site, LONDON) - distance(b.site, LONDON))
  .map(p => p.name)

t('order.theFirstPageIsTheNearestTwo', JSON.stringify(names(firstTwo.rows)) === JSON.stringify(byDistance.slice(0, 2)))
t('order.andTheSECONDPageContinuesIt', JSON.stringify(names(nextTwo.rows)) === JSON.stringify(byDistance.slice(2, 4)))

// The row with no coordinate is at no distance, not at zero — it sorts after
// every located one. Without `NULLS LAST` on the expression it leads the list,
// and the nearest branch to London is the one nobody has located.
const everything = await ask({}, ORDERED)
t('order.anUnlocatedRowSortsLAST', names(everything.rows).at(-1) === 'Milton Keynes')

// ─── The types survived a transport that carries only strings ─────────────
//
// Asked of the SERVER's answer rather than of the query object: a radius that
// arrived as the number 5 would be metres, and a coordinate that arrived as the
// text '51.5074' would be refused by name. Both are silent in the query string
// itself, which is why this is asked at the far end.

const qs = encodeQueryString(NEAR_5MI)
t('wire.itIsOrdinaryBracketNotation', qs.includes('site[near][lat]=51.5074') && qs.includes('site[near][within]=5mi'))
t('wire.noSecondSyntaxWasInvented',  !qs.includes(',') && !qs.includes('site.near'))

// `toFixed(6)` is how a GPS reading reaches a URL, and it does not round-trip
// through the query kit's number rule — so it arrives as TEXT and the `@point`
// declaration is what reads it back as a Float. The rows must be the same ones.
const fixed = await ask({ site: { near: { lat: LONDON.lat.toFixed(6), lng: LONDON.lng.toFixed(6), within: '5mi' } } })
t('wire.aFixedPrecisionCoordinateIsStillACoordinate',
  JSON.stringify(names(fixed.rows).sort()) === JSON.stringify(names(within5.rows).sort()))

// ─── The refusals ─────────────────────────────────────────────────────────

const junk = await ask({ site: { near: { ...LONDON, within: '5 parsecs' } } })
t('refuse.anUnknownUnitIs4xx', junk.status >= 400 && junk.status < 500)

const bare = await ask({ site: { near: { ...LONDON, within: '5' } } })
t('refuse.aUnitlessRadiusIs4xx', bare.status >= 400 && bare.status < 500)

const asText = await ask({ site: 'somewhere' })
t('refuse.aBareComparisonIs4xx', asText.status >= 400 && asText.status < 500)

// The one only the DATABASE can answer. `asSystem()` reaches no validator, no
// gate and no hook — it is the path a migration and a seed take — and the CHECK
// is what stands between it and a row carrying half a coordinate. Every kit
// function answers NaN for one of those, and the row would leave every `near`
// result with a 200.
t('check.aHalfSetCoordinateIsRefusedByTheTABLE', await refused(() =>
  sys.pickupPoint.create({ data: { name: `Half ${Date.now()}`, address: 'nowhere', site: { lat: 51.5 } } })))

t('check.anOutOfRangeCoordinateIsRefusedByTheTABLE', await refused(() =>
  sys.pickupPoint.create({ data: { name: `Far ${Date.now()}`, address: 'nowhere', site: { lat: 91, lng: 0 } } })))

t('check.andAWholePairIsStored', await (async () => {
  const name = `Drive ${Date.now()}`
  const made = await sys.pickupPoint.create({ data: { name, address: 'a drive', site: { lat: 51.5, lng: -0.12 } } })
  const read = await sys.pickupPoint.findFirst({ where: { id: made.id } })
  const ok   = read?.site?.lat === 51.5 && read?.site?.lng === -0.12
  await sys.pickupPoint.delete({ where: { id: made.id } })
  return ok
})())

// ─── Report ───────────────────────────────────────────────────────────────

const expected = {
  'seed.theBranchesAreThere':                          true,
  'seed.oneHasNoCoordinateYet':                        true,
  'gate.aStrangerListsThem':                           true,
  'near.theRadiusAdmitsSome':                          true,
  'near.andRefusesOthers':                             true,
  'near.matchesABruteForceScan':                       true,
  'near.aRowWithNoPointIsInNoCircle':                  true,
  'near.aWiderRadiusTakesInMore':                      true,
  'order.theFirstPageIsTheNearestTwo':                 true,
  'order.andTheSECONDPageContinuesIt':                 true,
  'order.anUnlocatedRowSortsLAST':                     true,
  'wire.itIsOrdinaryBracketNotation':                  true,
  'wire.noSecondSyntaxWasInvented':                    true,
  'wire.aFixedPrecisionCoordinateIsStillACoordinate':  true,
  'refuse.anUnknownUnitIs4xx':                         true,
  'refuse.aUnitlessRadiusIs4xx':                       true,
  'refuse.aBareComparisonIs4xx':                       true,
  'check.aHalfSetCoordinateIsRefusedByTheTABLE':       true,
  'check.anOutOfRangeCoordinateIsRefusedByTheTABLE':   true,
  'check.andAWholePairIsStored':                       true,
}

process.exit(report(got, expected))
