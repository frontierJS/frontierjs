/**
 * web/test/verify-custom-fields.mjs — a column the SHOP declared, at runtime.
 *
 * **bun, and it starts its own API for the last section.** Almost every
 * assertion is about the Data boundary, about `api/src/domain/shop/custom-fields.ts`,
 * and about the one thing neither can be asked alone: whether the field a shop
 * DECLARES is the field a segment can FILTER on. Two code paths — a
 * `CustomField` row becoming a slot, and a segment's terms becoming a `where` —
 * and a unit test on either side passes with the crossing broken (the shape
 * `verify:values` exists for).
 *
 * **`http.*` is a second crossing and it was found the same way the first one
 * predicts.** For its whole life this drive reached the pure functions and the
 * client directly, so nothing between an HTTP request and them had ever run —
 * and all three things in that gap were broken. Declaring a field was a **500**
 * (`POOL[ctx.type]`, a service method written with Feathers' `(data, params)`
 * signature where junction hands the CONTEXT), segmenting was a **500** for the
 * same reason and then a 400 on `take:` where litestone's option is `limit`,
 * and creating a customer was a **403** because the hook that derives the slot
 * mirror wrote a column no caller may send (`FJS-644`, `FJS-661`). A drive on
 * one side of a crossing passes with the crossing broken; this drive was that
 * drive.
 *
 * ─── What only this drive can ask ─────────────────────────────────────────
 *
 * `crossing.*` — declare, write a value, segment on it, get the row back.
 * Nothing above the domain module knows a slot exists, so if allocation and
 * compilation ever disagree about the ORDER of the pool this is what says so.
 *
 * `pool.*` — the thirteenth field. It is NOT an error: it stores, it reads back
 * and it displays, and only an audience naming it degrades. Asserted as a pair
 * with a promoted field so *the pool is full* cannot be confused with *the
 * field did not save*.
 *
 * `audience.*` — the same terms read by two different mechanisms. The list side
 * compiles to SQL and asks SQLite; the checkout side compiles the same terms
 * and asks `matchesQuery` about ONE row. A discount advertised to somebody the
 * checkout then declines is exactly what two implementations of this would buy,
 * so both are asked here about the same customer and must agree.
 *
 * `index.*` — the EXPLAIN. A promoted segment must reach the composite index,
 * and no behavioral assertion can see that it did not: every row comes back
 * either way, just slower. Twelve single-column indexes measured 139 ms against
 * the composite's 2.7 ms, so this is the assertion that keeps the shape.
 *
 * ─── The fixture rule ─────────────────────────────────────────────────────
 *
 * `Customer.email` is `@unique` and the model soft-deletes, so a deleted row
 * KEEPS its email and a literal fixture address is single-use (`FJS-530`,
 * `FJS-546`). Every customer minted here carries a per-run prefix, and every
 * count is a delta rather than an absolute.
 */

import { readFileSync }  from 'node:fs'
import { spawn }         from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createClient }  from '@frontierjs/litestone'
import { db, ENCRYPTION_KEY } from '../../api/src/core/db.ts'
import { allocateSlot, compileSegment, projectSlots, matchesAudience, POOL }
  from '../../api/src/domain/shop/custom-fields.ts'
import { discountProblem, priceBasket } from '../../api/src/domain/shop/pricing.ts'

const sys = db.asSystem()
const RUN = String(Date.now()).slice(-6)
const got = {}
const t   = (label, value) => { got[label] = value }

let failedEarly = null
const made = { customers: [], fields: [] }

// ─── The API, started and stopped by this drive ────────────────────────────
//
// Only the API — there is no browser here and no page to load. It refuses a
// port that already answers rather than testing somebody else's process, and
// it signs in ONCE: login is rate-limited to 10 per 15 minutes across every
// drive in this app, so a helper that logged in per call would fail the run
// after ten assertions and report it as a broken app.
async function withApi(body) {
  const ROOT = fileURLToPath(new URL('../..', import.meta.url))
  const API  = process.env.API_URL ?? 'http://localhost:8110'

  let busy = false
  try { await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) throw new Error(
    `port 8110 already answers — an API is still running from an earlier run.\n` +
    `stop it first (\`bun run stop\`); this drive starts its own.`)

  const proc = spawn('bun', ['run', 'api/index.ts'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  proc.stdout.on('data', () => {})
  proc.stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(`[api] ${d}`) })
  const stop = () => { try { process.kill(-proc.pid, 'SIGTERM') } catch { try { proc.kill('SIGTERM') } catch {} } }
  process.on('exit', stop)

  try {
    let up = false
    for (let i = 0; i < 120 && !up; i++) {
      try { up = (await fetch(`${API}/api/health`)).ok } catch {}
      if (!up) await new Promise(r => setTimeout(r, 250))
    }
    if (!up) throw new Error('the API never answered on 8110')

    const auth = await (await fetch(`${API}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alex@shop.test', password: 'correct-horse-battery' }),
    })).json()
    if (!auth.token) throw new Error(`sign-in failed: ${JSON.stringify(auth).slice(0, 160)}`)

    const H = { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` }
    // `method` names a CUSTOM method on the collection, which travels as a
    // header — there is no URL for one, and posting to `/{service}/{name}` is a
    // create with an id.
    const call = async (verb, path, payload, method) => {
      const res = await fetch(`${API}/api${path}`, {
        method: verb,
        headers: method ? { ...H, 'x-service-method': method } : H,
        body: JSON.stringify(payload),
      })
      return [res.status, await res.json().catch(() => null)]
    }
    await body({
      post:  (path, payload, method) => call('POST',  path, payload, method),
      patch: (path, payload)         => call('PATCH', path, payload),
      put:   (path, payload)         => call('PUT',   path, payload),
    })
  } finally { stop() }
}

const mkCustomer = async (tag, fields, declared) => {
  const row = await sys.customer.create({ data: {
    name: `CF ${tag}`, firstName: 'CF', lastName: tag,
    email: `cf-${RUN}-${tag}@example.test`,
    fields, slots: projectSlots(fields, declared),
  } })
  made.customers.push(row.id)
  return row
}

try {
  // ─── The pool, and what a full one answers ──────────────────────────────
  const before = await sys.customField.findMany({})
  t('pool.startsFromWhateverTheShopHad', Array.isArray(before))

  const declare = async (key, type, label = key) => {
    const declared = await sys.customField.findMany({})
    const row = await sys.customField.create({
      data: { key: `${key}_${RUN}`, label, type, slot: allocateSlot(declared, type) },
      system: ['slot'],
    })
    made.fields.push(row.id)
    return row
  }

  const tier = await declare('tier',  'text',   'Loyalty tier')
  const ltv  = await declare('ltv',   'number', 'Lifetime value')
  t('declare.aTextFieldTakesATextSlot',   POOL.text.includes(tier.slot))
  t('declare.aNumberFieldTakesANumberSlot', POOL.number.includes(ltv.slot))
  t('declare.theTwoPoolsDoNotShare',      tier.slot !== ltv.slot)

  // ─── The crossing ───────────────────────────────────────────────────────
  const declared = await sys.customField.findMany({})
  const gold   = await mkCustomer('gold',   { [tier.key]: 'gold',   [ltv.key]: 900 }, declared)
  const bronze = await mkCustomer('bronze', { [tier.key]: 'bronze', [ltv.key]: 40  }, declared)

  t('crossing.theValueSurvivesTheWrite',
    (await sys.customer.findUnique({ where: { id: gold.id } }))[tier.slot] === 'gold')

  const seg  = compileSegment([{ key: tier.key, op: 'eq', value: 'gold' }], declared)
  const hits = await sys.customer.findMany({ where: seg.where })
  t('crossing.aDeclaredFieldIsSegmentableOnTheSameDay',
    hits.some(r => r.id === gold.id) && !hits.some(r => r.id === bronze.id))

  const two = compileSegment(
    [{ key: tier.key, op: 'eq', value: 'gold' }, { key: ltv.key, op: 'gte', value: 500 }], declared)
  const bothRows = await sys.customer.findMany({ where: two.where })
  t('crossing.twoTermsAcrossBothPoolsNarrow',
    bothRows.some(r => r.id === gold.id) && !bothRows.some(r => r.id === bronze.id))

  // The blob is what a person reads; the slots are bookkeeping. Both, always.
  const back = await sys.customer.findUnique({ where: { id: gold.id } })
  t('crossing.theHumanKeyIsStillReadable', back.fields?.[tier.key] === 'gold')

  // ─── The negative control: the pool runs out ────────────────────────────
  const spare = POOL.text.length - (await sys.customField.findMany({}))
    .filter(d => d.type === 'text' && d.slot).length
  for (let i = 0; i < spare; i++) await declare(`filler${i}`, 'text')
  const overflow = await declare('overflow', 'text', 'Overflowed')
  t('pool.theOneAfterTheLastGetsNoSlot', overflow.slot === null)

  const withOverflow = await sys.customField.findMany({})
  const late = await mkCustomer('late', { [overflow.key]: 'yes', [tier.key]: 'gold' }, withOverflow)
  const lateBack = await sys.customer.findUnique({ where: { id: late.id } })
  t('pool.anUnpromotedFieldStillStores',  lateBack.fields?.[overflow.key] === 'yes')
  t('pool.andStillReadsBack',             lateBack.fields?.[overflow.key] === 'yes')

  // The pair that keeps *pool full* apart from *the write failed*: the SAME row
  // carries a promoted field too, and that one does reach a slot.
  t('pool.thePromotedFieldOnTheSameRowStillWorks', lateBack[tier.slot] === 'gold')

  const mixed = compileSegment([{ key: overflow.key, op: 'eq', value: 'yes' }], withOverflow)
  t('pool.aTermOnItIsReportedRatherThanDropped',
    mixed.unindexed.length === 1 && Object.keys(mixed.where).length === 0)
  t('pool.andIsNotReportedAsUnknown', mixed.unknown.length === 0)

  const nope = compileSegment([{ key: 'never_declared', op: 'eq', value: 1 }], withOverflow)
  t('pool.anUndeclaredKeyIsUnknownNotUnindexed',
    nope.unknown.length === 1 && nope.unindexed.length === 0)

  // ─── The audience: one predicate, two readers ───────────────────────────
  const terms  = [{ key: tier.key, op: 'eq', value: 'gold' }]
  const code   = { code: `CF${RUN}`, active: true, kind: 'percent', value: 1000,
                   minSubtotal: 0, startsAt: null, endsAt: null,
                   maxRedemptions: null, redemptions: 0, audience: terms }

  const listSide = await sys.customer.findMany({ where: compileSegment(terms, declared).where })
  const inList   = listSide.some(r => r.id === gold.id)
  const oneSide  = discountProblem(code, 5000, new Date(), { customer: back, declared }) === null
  t('audience.theListAndTheCheckoutAgreeForTheSamePerson', inList === oneSide && inList === true)

  const bronzeRow  = await sys.customer.findUnique({ where: { id: bronze.id } })
  const bronzeList = listSide.some(r => r.id === bronze.id)
  const bronzeOne  = discountProblem(code, 5000, new Date(), { customer: bronzeRow, declared }) === null
  t('audience.andAgreeWhenTheAnswerIsNo', bronzeList === bronzeOne && bronzeList === false)

  t('audience.aGuestIsRefusedRatherThanAdmitted',
    discountProblem(code, 5000, new Date(), { customer: null, declared }) !== null)
  t('audience.aCodeWithNoAudienceIsForEverybody',
    discountProblem({ ...code, audience: null }, 5000, new Date(),
      { customer: bronzeRow, declared }) === null)

  // A field the shop has since dropped must not silently widen the audience.
  t('audience.aTermOnAnUndeclaredFieldFailsClosed',
    discountProblem(code, 5000, new Date(), { customer: back, declared: [] }) !== null)

  t('audience.theDiscountActuallyComesOffForAMatch',
    priceBasket([{ total: 5000 }], { discount: code, customer: back,       declaredFields: declared }).discount === 500)
  t('audience.andDoesNotForANonMatch',
    priceBasket([{ total: 5000 }], { discount: code, customer: bronzeRow,  declaredFields: declared }).discount === 0)

  t('audience.matchesAudienceSaysUndecidableRatherThanGuessing',
    matchesAudience(compileSegment(terms, declared).where, { /* slot dropped */ }) === null)

  // ─── The index. Nothing behavioral can see this one ────────────────────
  //
  // Asked of a THROWAWAY database built from the same `db/schema.lite`, not of
  // the shop. The shop has four customers, and SQLite is right to scan four
  // rows — an EXPLAIN there asserts the planner's arithmetic rather than the
  // schema's index, and would read as a pass or a fail for reasons that have
  // nothing to do with this feature. The question is about the SHAPE the seed
  // declares, so the fixture is sized until the shape is what decides.
  // `path:` alone, never `path:` beside `schema:`. A `schema:` string wins the
  // resolution order and `parse()` has no base to resolve an import against, so
  // handing it both reads the file and DROPS its three `import` lines —
  // including `./user.lite`, which is where `User.isStaff` lives (`FJS-670`).
  const probe = await createClient({
    path:      fileURLToPath(new URL('../../db/schema.lite', import.meta.url)),
    databases: ':memory:',
    // Resolving the imports brings `@frontierjs/auth`'s `@encrypted` columns in
    // with them, which the probe never saw while they were being dropped.
    encryptionKey: ENCRYPTION_KEY,
  })
  const psys = probe.asSystem()
  const bulk = []
  for (let i = 0; i < 3000; i++) bulk.push({
    name: `P${i}`, firstName: 'P', lastName: String(i), email: `p${i}@probe.test`,
    fields: {}, slots: { t1: ['gold', 'silver', 'bronze'][i % 3], n1: i },
  })
  await psys.customer.createMany({ data: bulk })
  await psys.sql`ANALYZE`

  const detail = (await psys.sql`
    EXPLAIN QUERY PLAN SELECT id FROM customer WHERE t1 = 'gold' AND deletedAt IS NULL`)
    .map(r => r.detail).join(' | ')

  t('index.aPromotedSegmentReachesAnIndex', /USING (COVERING )?INDEX/.test(detail))
  t('index.andItIsTheCompositeOverThePool', detail.includes('idx_customer_t1'))

  // The other half of a PARTIAL index, and the reason the clause is in the
  // query above: `createIndexes` ANDs `deletedAt IS NULL` onto every index on a
  // soft-deleting model, and SQLite will not use a partial index unless the
  // query implies its predicate. Every ORM read carries that clause; a raw
  // statement does not, and gets a scan with nothing saying so.
  const rawDetail = (await psys.sql`
    EXPLAIN QUERY PLAN SELECT id FROM customer WHERE t1 = 'gold'`)
    .map(r => r.detail).join(' | ')
  t('index.aRawQueryMissingTheSoftDeleteClauseScans', /SCAN/.test(rawDetail))

  // ─── The other crossing: the same feature over HTTP ─────────────────────
  //
  // Everything above holds the client in its own hand. A request does not: it
  // arrives at a service, is validated against the seed, runs a hook that
  // derives a `@system` column, and only then reaches the boundary this file
  // has been asking. Three separate things lived in that gap and none of them
  // worked.
  await withApi(async ({ post, patch, put }) => {
    // The sections above deliberately EXHAUST the text pool — the thirteenth
    // field is one of their assertions — so this one has to give a slot back
    // before it can ask whether allocation works over HTTP. They are swept in
    // the `finally` anyway; this is the same sweep, early.
    for (const id of made.fields.splice(0)) {
      try { await sys.customField.delete({ where: { id } }) } catch {}
    }

    const key = `http_${RUN}`

    const [ds, declaredRow] = await post('/custom-fields', { key, label: 'HTTP tier', type: 'text' })
    if (declaredRow?.id) made.fields.push(declaredRow.id)
    t('http.declaringAFieldIsNotA500', ds === 201)
    t('http.andTheApplicationAllocatedTheSlot', typeof declaredRow?.slot === 'string')

    // The 403. A hook derives `slots` and the Data boundary refuses a payload
    // naming a `@system` column — so the write has to say the application is
    // the one supplying it (`ctx.system.add('slots')`).
    const [cs, row] = await post('/customers', {
      name: `HTTP ${RUN}`, firstName: 'HTTP', lastName: RUN,
      email: `cf-${RUN}-http@example.test`, fields: { [key]: 'gold' },
    })
    if (row?.id) made.customers.push(row.id)
    t('http.creatingACustomerIsNotA403', cs === 201)
    t('http.andTheMirrorWasBuiltByTheHook', row?.slots?.[declaredRow?.slot] === 'gold')
    t('http.andTheGeneratedColumnReadsIt', row?.[declaredRow?.slot] === 'gold')

    // The pair, and the half that says the seam widened one CALL rather than
    // the model: the same column, sent by the CALLER this time. The hook runs
    // either way and rebuilds the mirror from `fields`, so what lands is the
    // derived value and never the one that was posted — naming a column is the
    // application vouching for what IT put there, not a hole a payload climbs
    // through. Asserted on the stored value, because a 201 alone is what a
    // service that simply accepted the forgery would also answer.
    const [bs, forged] = await post('/customers', {
      name: `HTTP2 ${RUN}`, firstName: 'HTTP2', lastName: RUN,
      email: `cf-${RUN}-http2@example.test`, fields: { [key]: 'bronze' }, slots: { t1: 'forged' },
    })
    if (forged?.id) made.customers.push(forged.id)
    t('http.aCallersOwnSlotsAreOverwrittenByTheHook',
      bs === 201 && forged?.slots?.[declaredRow?.slot] === 'bronze'
      && !Object.values(forged?.slots ?? {}).includes('forged'))

    // A patch rebuilds the mirror WHOLE, so the old value has to leave its slot
    // — merging would keep segmenting a row on a value it no longer holds.
    const [ps, patched] = await patch(`/customers/${row.id}`, { fields: { [key]: 'silver' }, version: row.version })
    t('http.aPatchMovesTheMirror', ps === 200 && patched?.[declaredRow?.slot] === 'silver')

    // A PUT, which is `update` — patch with an id required, merging like every
    // other write here (`FJS-663`). It is the only place this app's
    // `validated.update` hook runs, and until the version stopped being
    // stripped it could not run at all.
    const [rs, replaced] = await put(`/customers/${row.id}`, {
      name: `HTTP ${RUN}`, firstName: 'HTTP', lastName: RUN,
      email: patched.email, fields: { [key]: 'gold' }, version: patched.version,
    })
    t('http.aPutRebuildsTheMirrorToo', rs === 200 && replaced?.[declaredRow?.slot] === 'gold')

    // The segment, over the wire. `terms` is what `type SegmentQuery` declares,
    // so this is also the only place the declared `input:` is exercised.
    const [ss, seg] = await post('/customers', { terms: [{ key, op: 'eq', value: 'gold' }] }, 'segment')
    t('http.segmentingFindsTheRow', ss === 200 && seg?.rows?.some(r => r.id === row.id))
    t('http.andReportsNothingUnindexed', Array.isArray(seg?.unindexed) && seg.unindexed.length === 0)

    // An undeclared key is refused BY NAME rather than widening the audience —
    // the same rule the in-process half asserts, asked at the boundary that
    // actually answers a shop.
    const [us, unknown] = await post('/customers', { terms: [{ key: 'nope', op: 'eq', value: 'x' }] }, 'segment')
    t('http.anUnknownKeyIsA400NamingIt', us === 400 && /nope/.test(JSON.stringify(unknown)))
  })

} catch (err) {
  failedEarly = err
} finally {
  // Restore what this run MADE. `Customer` soft-deletes and keeps its unique
  // email, so a plain remove would leave the address claimed for every later
  // run — these are destroyed rather than hidden.
  for (const id of made.customers) {
    try { await sys.customer.delete({ where: { id }, withDeleted: true }) } catch {}
  }
  for (const id of made.fields) {
    try { await sys.customField.delete({ where: { id } }) } catch {}
  }
}

const expected = {
  'pool.startsFromWhateverTheShopHad': true,
  'declare.aTextFieldTakesATextSlot': true,
  'declare.aNumberFieldTakesANumberSlot': true,
  'declare.theTwoPoolsDoNotShare': true,
  'crossing.theValueSurvivesTheWrite': true,
  'crossing.aDeclaredFieldIsSegmentableOnTheSameDay': true,
  'crossing.twoTermsAcrossBothPoolsNarrow': true,
  'crossing.theHumanKeyIsStillReadable': true,
  'pool.theOneAfterTheLastGetsNoSlot': true,
  'pool.anUnpromotedFieldStillStores': true,
  'pool.andStillReadsBack': true,
  'pool.thePromotedFieldOnTheSameRowStillWorks': true,
  'pool.aTermOnItIsReportedRatherThanDropped': true,
  'pool.andIsNotReportedAsUnknown': true,
  'pool.anUndeclaredKeyIsUnknownNotUnindexed': true,
  'audience.theListAndTheCheckoutAgreeForTheSamePerson': true,
  'audience.andAgreeWhenTheAnswerIsNo': true,
  'audience.aGuestIsRefusedRatherThanAdmitted': true,
  'audience.aCodeWithNoAudienceIsForEverybody': true,
  'audience.aTermOnAnUndeclaredFieldFailsClosed': true,
  'audience.theDiscountActuallyComesOffForAMatch': true,
  'audience.andDoesNotForANonMatch': true,
  'audience.matchesAudienceSaysUndecidableRatherThanGuessing': true,
  'index.aPromotedSegmentReachesAnIndex': true,
  'index.andItIsTheCompositeOverThePool': true,
  'index.aRawQueryMissingTheSoftDeleteClauseScans': true,

  'http.declaringAFieldIsNotA500': true,
  'http.andTheApplicationAllocatedTheSlot': true,
  'http.creatingACustomerIsNotA403': true,
  'http.andTheMirrorWasBuiltByTheHook': true,
  'http.andTheGeneratedColumnReadsIt': true,
  'http.aCallersOwnSlotsAreOverwrittenByTheHook': true,
  'http.aPatchMovesTheMirror': true,
  'http.aPutRebuildsTheMirrorToo': true,
  'http.segmentingFindsTheRow': true,
  'http.andReportsNothingUnindexed': true,
  'http.anUnknownKeyIsA400NamingIt': true,
}

let failed = 0
for (const [key, want] of Object.entries(expected)) {
  const ok = got[key] === want
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${key}`)
  if (!ok) console.log(`         want ${want}   have ${JSON.stringify(got[key])}`)
}
if (failedEarly) console.error(`\nstopped early: ${failedEarly.message ?? failedEarly}`)
console.log(failed || failedEarly
  ? `\n${failed} assertion(s) failed`
  : `\nall ${Object.keys(expected).length} assertions passed`)
process.exit(failed || failedEarly ? 1 : 0)
