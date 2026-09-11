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
 * **Both models declare `@@extensible` now, and most of what this drive used to
 * grade is gone from the app.** The pool, the order slots are handed out in, the
 * slot each declaration takes and the mirror kept beside the blob are the Data
 * boundary's; `custom-fields.ts` is two functions over the shop's own keys and
 * names no slot. So the rows below are about the CROSSING and no longer about an
 * app-side derivation: what they can still see, and nothing else here can, is
 * whether a key declared through this app's service is a key this app's segment
 * finds.
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
import { compileSegment, matchesAudience }
  from '../../api/src/domain/shop/custom-fields.ts'
import { withCustomFields, shownFields } from '../../web/src/custom-fields.js'
import { discountProblem, priceBasket } from '../../api/src/domain/shop/pricing.ts'
import { results, report } from './lib/report.mjs'

const sys = db.asSystem()

// `Customer` declares `@@extensible(fields, declaredBy: CustomField, max: …)`
// and `Product` declares the same word without the `max:`, so one has a pool and
// the other has none. Both are read off the parsed seed rather than listed here,
// and the seed is read through the CLIENT rather than parsed a second time —
// the app has no module that reads it as a document any more, which is the point
// of the section below.
const customerModel = db.$schema.models.find(m => m.name === 'Customer')
const POOL = {
  order: customerModel.attributes.find(a => a.kind === 'index' && a.generated === 'extensible').fields,
  type:  Object.fromEntries(customerModel.fields.filter(f => f.extKind).map(f => [f.name, f.extKind])),
}
const RUN = String(Date.now()).slice(-6)
const { got, t } = results()

let failedEarly = null
const made = { customers: [], fields: [], products: [] }

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

// The mirror is not built here and cannot be: `Customer.fieldsSlots` is the
// expansion of `@@extensible(max:)`, derived inside `writeData` from whatever
// `fields` holds. This helper used to project it by hand and hand it in.
const mkCustomer = async (tag, fields) => {
  const row = await sys.customer.create({ data: {
    name: `CF ${tag}`, firstName: 'CF', lastName: tag,
    email: `cf-${RUN}-${tag}@example.test`,
    fields,
  } })
  made.customers.push(row.id)
  return row
}

try {
  // ─── The pool, and what a full one answers ──────────────────────────────
  const before = await sys.customField.findMany({ where: { model: 'Customer' } })
  t('pool.startsFromWhateverTheShopHad', Array.isArray(before))

  // `model:` is the second half of a declaration, and it is the WHOLE of it now:
  // `slot` is filled at the Data boundary out of the pool the named model
  // declares, so nothing here allocates and nothing here says `system: ['slot']`.
  // `Customer` has a pool and `Product` has none, and this one call covers both.
  const declare = async (model, key, type, label = key, extra = {}) => {
    const row = await sys.customField.create({
      data: { model, key: `${key}_${RUN}`, label, type, ...extra },
    })
    made.fields.push(row.id)
    return row
  }

  // The control is a generated column that is not a slot: `Customer.fullName` is
  // `@generated` too, and a pool read off that attribute alone would take it for
  // a text slot. Both rows read `type`, which is keyed by the KIND each expanded
  // column was stamped with — reading a slot's kind back off its first letter is
  // one enum rename away from coercing every value into the wrong affinity.
  t('pool.aGeneratedColumnThatIsNotASlotIsNotInIt', !('fullName' in POOL.type))
  t('pool.isTheTwelveTheSeedDeclares',              Object.keys(POOL.type).length === 12)

  const tier = await declare('Customer', 'tier', 'text',   'Loyalty tier')
  const ltv  = await declare('Customer', 'ltv',  'number', 'Lifetime value')
  t('declare.aTextFieldTakesATextSlot',   POOL.type[tier.slot] === 'text')
  t('declare.aNumberFieldTakesANumberSlot', POOL.type[ltv.slot]  === 'number')
  t('declare.theTwoPoolsDoNotShare',      tier.slot !== ltv.slot)

  // ─── The crossing ───────────────────────────────────────────────────────
  // `$declaredFields()` and not a findMany: one declaring table carries both
  // models' keys, and the narrowing is the accessor rather than a `where` the
  // caller has to remember.
  const declared = await sys.customer.$declaredFields()
  const gold   = await mkCustomer('gold',   { [tier.key]: 'gold',   [ltv.key]: 900 })
  const bronze = await mkCustomer('bronze', { [tier.key]: 'bronze', [ltv.key]: 40  })

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
  const spare = POOL.order.filter(sl => POOL.type[sl] === 'text').length
    - (await sys.customer.$declaredFields()).filter(d => d.type === 'text' && d.slot).length
  for (let i = 0; i < spare; i++) await declare('Customer', `filler${i}`, 'text')
  const overflow = await declare('Customer', 'overflow', 'text', 'Overflowed')
  t('pool.theOneAfterTheLastGetsNoSlot', overflow.slot === null)

  const withOverflow = await sys.customer.$declaredFields()
  const late = await mkCustomer('late', { [overflow.key]: 'yes', [tier.key]: 'gold' })
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

  // ─── The other half: a declared field on a model with NO pool ──────────
  //
  // `Product` carries `fields` and no slot columns, which is the ORDINARY shape
  // of this feature rather than a degraded one. Everything above is about a key
  // a segment can filter on; this is about a key a shop just wants somewhere to
  // put, and the question the section exists to answer is whether the two are
  // one feature or two.
  //
  // Each row is PAIRED with the customer field declared a moment ago, because
  // *no pool* and *the allocator is broken* answer identically from this side.
  const care = await declare('Product', 'care', 'text', 'Care symbol',
                             { defaultValue: 'machine wash 30', show: true })
  const sku  = await declare('Product', 'supplier_sku', 'text', 'Supplier SKU',
                             { defaultValue: '', show: false })

  t('blob.aModelWithNoPoolAllocatesNoSlot',   care.slot === null)
  t('blob.andTheCustomerFieldStillGotOne',    tier.slot !== null)
  t('blob.itIsNotRefused',                    care.id > 0 && care.key.startsWith('care_'))

  // The same key on two models is two fields. It was `key @unique` while
  // `Customer` was the only model with any, so this write was an error.
  const careOnCustomer = await declare('Customer', 'care', 'text', 'Care note')
  t('blob.theSameKeyOnTwoModelsIsTwoFields',
    careOnCustomer.key === care.key && careOnCustomer.id !== care.id)

  const prod = await sys.product.create({ data: {
    name: `CF Widget ${RUN}`, slug: `cf-widget-${RUN}`, brand: 'frontierjs', active: true,
    // Active, so `Product.description`'s `@required(where: active)` applies —
    // this is a CHECK in the DDL and `asSystem()` is held to it like anything
    // else.
    description: 'A fixture this drive makes and removes.',
    fields: { [care.key]: 'hand wash only' },
  } })
  made.products.push(prod.id)
  const prodBack = await sys.product.findUnique({ where: { id: prod.id } })
  t('blob.theValueStoresAndReadsBack', prodBack.fields?.[care.key] === 'hand wash only')

  // No projection, no mirror, no hook. The service half of the pool is absent
  // here and nothing had to be written in its place.
  t('blob.thereIsNoMirrorToGoStale', !('fieldsSlots' in prodBack))

  // A segment over these is every term unindexed and none unknown — the same
  // answer the thirteenth CUSTOMER field gets, from the same function, which is
  // what says the two tiers share one compiler rather than resembling one.
  const prodDeclared = await sys.product.$declaredFields()
  const prodSeg = compileSegment([{ key: care.key, op: 'eq', value: 'hand wash only' }], prodDeclared)
  t('blob.everyTermIsUnindexedRatherThanUnknown',
    prodSeg.unindexed.length === 1 && prodSeg.unknown.length === 0 &&
    Object.keys(prodSeg.where).length === 0)

  // ─── And the assembler is one assembler ────────────────────────────────
  //
  // The claim the whole section is for: the code that turns declarations into
  // form fields is the SAME code for both models, and it never mentions a slot.
  const custRules = withCustomFields({ fields: {}, formFields: () => [] }, [tier, ltv]).fields
  const prodRules = withCustomFields({ fields: {}, formFields: () => [] }, prodDeclared).fields

  t('assembler.oneFunctionRendersBoth',
    `fields.${tier.key}` in custRules && `fields.${care.key}` in prodRules)
  // The sharpest row here, and it is the whole finding: a PROMOTED customer
  // field and an UNPROMOTED product field of the same type produce the same
  // rule, label aside. If they differed, the two tiers would be two features
  // and would need two names.
  const bare = r => JSON.stringify({ ...r, label: undefined })
  t('assembler.aPromotedFieldAndAnUnpromotedOneRenderIdentically',
    bare(custRules[`fields.${tier.key}`]) === bare(prodRules[`fields.${sku.key}`]))

  // The default reaches the rule under the key a COLUMN's default arrives under,
  // so a generated form prefills a declared field with nothing added to <Form>.
  t('assembler.aDeclaredDefaultReachesTheRule',
    prodRules[`fields.${care.key}`].default === 'machine wash 30')
  t('assembler.anEmptyDefaultIsAbsentRatherThanBlank',
    !('default' in prodRules[`fields.${sku.key}`]))

  // `show` decides a TABLE's columns and never an answer. Asserted as a pair,
  // because a filter that returned nothing satisfies the hidden half alone.
  const shown = shownFields(prodDeclared)
  t('assembler.showChoosesTableColumns',
    shown.some(d => d.key === care.key) && !shown.some(d => d.key === sku.key))
  t('assembler.andAHiddenFieldIsStillOnTheForm',
    `fields.${sku.key}` in prodRules)

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
    matchesAudience(declared, compileSegment(terms, declared).where, { /* blob dropped */ }) === null)

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

  // The declarations come FIRST and the mirror is never written here. This block
  // used to hand `slots:` in directly, which meant the fixture agreed with any
  // pool it liked and the EXPLAIN below was about columns nothing had bound a
  // key to. Now `tier` takes t1, `band` takes t2 and `ltv` takes n1 because the
  // boundary allocated them in the composite's own order, and the rows below
  // reach those columns only if the projection put them there.
  for (const [key, type] of [['tier', 'text'], ['band', 'text'], ['ltv', 'number']])
    await psys.customField.create({ data: { model: 'Customer', key, label: key, type } })

  const bulk = []
  for (let i = 0; i < 3000; i++) bulk.push({
    name: `P${i}`, firstName: 'P', lastName: String(i), email: `p${i}@probe.test`,
    fields: { tier: ['gold', 'silver', 'bronze'][i % 3], band: `src${i % 5}`, ltv: i },
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

  // ─── Which slots the order hands out, which the one-term plan cannot see ──
  //
  // A composite is read left to right, so the plan above passes under ANY order
  // of the pool — `t1` is leading in all of them. The order only becomes visible
  // on a second term, and it is a BET rather than a fact: `max: { text: 8,
  // number: 4 }` is a 2:1 ratio and lays the pool down `t1,t2,n1,t3,t4,n2,…`,
  // which allocates a shop's first two TEXT fields adjacently. Measured at
  // 20,000 rows against
  // the interleaved alternative (`t1,n1,t2,n2,…`): four text terms reach four
  // columns here and one there, 0.03 ms against 0.94 — and the trade runs the
  // other way on a mixed pair, 0.21 ms against 0.06. Text-first is the bet
  // because a shop declares mostly text; this row is what makes it a decision
  // somebody can revisit with a number rather than a list nobody compares.
  const twoText = (await psys.sql`
    EXPLAIN QUERY PLAN SELECT id FROM customer
    WHERE t1 = 'gold' AND t2 = 'src1' AND deletedAt IS NULL`).map(r => r.detail).join(' | ')
  t('index.twoTextTermsReachTwoColumnsOfTheComposite',
    /t1=\? AND t2=\?/.test(twoText))

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

    const [ds, declaredRow] = await post('/custom-fields',
      { model: 'Customer', key, label: 'HTTP tier', type: 'text' })
    if (declaredRow?.id) made.fields.push(declaredRow.id)
    t('http.declaringAFieldIsNotA500', ds === 201)
    t('http.andTheBoundaryAllocatedTheSlot', typeof declaredRow?.slot === 'string')

    // The same request against a model with no pool. It is the same route, the
    // same hook and the same 201 — the only difference is a null the seed
    // decided, which is what makes this one feature rather than two.
    const [blobStatus, blobRow] = await post('/custom-fields',
      { model: 'Product', key: `${key}_p`, label: 'HTTP care', type: 'text' })
    if (blobRow?.id) made.fields.push(blobRow.id)
    t('http.declaringOnAPoollessModelIsTheSame201', blobStatus === 201)
    t('http.andItsSlotIsNullRatherThanAnError', blobRow?.slot === null)

    // The 403. `fieldsSlots` is `@system` and derived, so a service filling it
    // by hand had to say `ctx.system.add('slots')` on all three of its write
    // hooks and the one that forgot was every customer create over HTTP
    // (`FJS-644`). Nothing here fills it, so there is nothing to forget — this
    // row is what says the boundary's own derivation does not trip its own
    // refusal.
    const [cs, row] = await post('/customers', {
      name: `HTTP ${RUN}`, firstName: 'HTTP', lastName: RUN,
      email: `cf-${RUN}-http@example.test`, fields: { [key]: 'gold' },
    })
    if (row?.id) made.customers.push(row.id)
    t('http.creatingACustomerIsNotA403', cs === 201)
    t('http.andTheMirrorWasDerived', row?.fieldsSlots?.[declaredRow?.slot] === 'gold')
    t('http.andTheGeneratedColumnReadsIt', row?.[declaredRow?.slot] === 'gold')

    // The pair: the same column, sent by the CALLER this time. The derivation
    // runs either way and rebuilds the mirror from `fields`, so what lands is
    // the derived value and never the one that was posted. Asserted on the
    // stored value, because a 201 alone is what a service that simply accepted
    // the forgery would also answer.
    const [bs, forged] = await post('/customers', {
      name: `HTTP2 ${RUN}`, firstName: 'HTTP2', lastName: RUN,
      email: `cf-${RUN}-http2@example.test`, fields: { [key]: 'bronze' }, fieldsSlots: { t1: 'forged' },
    })
    if (forged?.id) made.customers.push(forged.id)
    t('http.aCallersOwnSlotsAreOverwrittenByTheHook',
      bs === 201 && forged?.fieldsSlots?.[declaredRow?.slot] === 'bronze'
      && !Object.values(forged?.fieldsSlots ?? {}).includes('forged'))

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
  // `Product` soft-deletes and keeps its unique name and slug, same as a
  // customer's email — hiding one leaves both claimed for every later run.
  for (const id of made.products) {
    try { await sys.product.delete({ where: { id }, withDeleted: true }) } catch {}
  }
}

const expected = {
  'pool.startsFromWhateverTheShopHad': true,
  'pool.aGeneratedColumnThatIsNotASlotIsNotInIt': true,
  'pool.isTheTwelveTheSeedDeclares': true,
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
  'blob.aModelWithNoPoolAllocatesNoSlot': true,
  'blob.andTheCustomerFieldStillGotOne': true,
  'blob.itIsNotRefused': true,
  'blob.theSameKeyOnTwoModelsIsTwoFields': true,
  'blob.theValueStoresAndReadsBack': true,
  'blob.thereIsNoMirrorToGoStale': true,
  'blob.everyTermIsUnindexedRatherThanUnknown': true,
  'assembler.oneFunctionRendersBoth': true,
  'assembler.aPromotedFieldAndAnUnpromotedOneRenderIdentically': true,
  'assembler.aDeclaredDefaultReachesTheRule': true,
  'assembler.anEmptyDefaultIsAbsentRatherThanBlank': true,
  'assembler.showChoosesTableColumns': true,
  'assembler.andAHiddenFieldIsStillOnTheForm': true,
  'index.aRawQueryMissingTheSoftDeleteClauseScans': true,
  'index.twoTextTermsReachTwoColumnsOfTheComposite': true,

  'http.declaringAFieldIsNotA500': true,
  'http.andTheBoundaryAllocatedTheSlot': true,
  'http.declaringOnAPoollessModelIsTheSame201': true,
  'http.andItsSlotIsNullRatherThanAnError': true,
  'http.creatingACustomerIsNotA403': true,
  'http.andTheMirrorWasDerived': true,
  'http.andTheGeneratedColumnReadsIt': true,
  'http.aCallersOwnSlotsAreOverwrittenByTheHook': true,
  'http.aPatchMovesTheMirror': true,
  'http.aPutRebuildsTheMirrorToo': true,
  'http.segmentingFindsTheRow': true,
  'http.andReportsNothingUnindexed': true,
  'http.anUnknownKeyIsA400NamingIt': true,
}

process.exit(report(got, expected, { stoppedEarly: failedEarly }))
