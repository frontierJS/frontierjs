// `@@expires` and `@@effective` — one predicate, two defaults.
//
// `@@expires` is IMPOSED. The assertion that could not be written before it
// existed is expiry staged by MOVING THE CLOCK: every read of a deadline column
// in this repo filtered on a `new Date()` written into a service, so
// `env.clock.advance()` moved nothing and the correctness condition of a stock
// hold — dead the instant it passes, whether or not the sweep ran — was
// untested and untestable.
//
// `@@effective` is ASKED (`FJS-D352`). Its rows are history other rows point
// at — a subscription names the price it was sold at — so a read that states
// no moment gets every row, and the section on pointers is what would catch the
// window being imposed on it again: a pointer answering null, with nothing
// said.
//
// The decisions with no precedent to copy — whether a hard `delete` bypasses
// the window, whether `asOf` reaches a write, what a broadcast sees — are
// asked of the imposed word, which is the only one where they bite.

import { describe, test, expect } from 'bun:test'
import { createTestEnv } from '../src/testing.js'
import { parse, generateJsonSchema } from '../src/index.js'

const DEADLINE = `
model Cart {
  id    Int    @id
  label String
  holds Hold[]
}

model Hold {
  id        Int      @id
  label     String
  cartId    Int
  cart      Cart     @relation(fields: [cartId], references: [id], onDelete: Cascade)
  expiresAt DateTime
  @@expires(expiresAt)
}
`

const WINDOW = `
model Rate {
  id            Int      @id
  amount        Int
  effectiveFrom String   @date @immutable
  effectiveTo   String?  @date
  @@effective(from: effectiveFrom, to: effectiveTo)
}
`

// A price that moved, and a subscriber still on the old one. The shape the
// asked default exists for.
const PRICED = `
model Plan {
  id       Int           @id
  name     String
  versions PlanVersion[]
}

model PlanVersion {
  id            Int            @id
  planId        Int
  plan          Plan           @relation(fields: [planId], references: [id], onDelete: Restrict)
  price         Int
  effectiveFrom DateTime
  effectiveTo   DateTime?
  subscriptions Subscription[]
  @@effective(from: effectiveFrom, to: effectiveTo)
}

model Subscription {
  id            Int         @id
  planVersionId Int
  planVersion   PlanVersion @relation(fields: [planVersionId], references: [id], onDelete: Restrict)
}
`

const T0 = '2026-01-01T00:00:00.000Z'
const labels  = (rows) => rows.map(r => r.label).sort()
const amounts = (rows) => rows.map(r => r.amount).sort((a, b) => a - b)

describe('@@expires — imposed', () => {
  async function staged() {
    const env = await createTestEnv({ schema: DEADLINE, now: T0 })
    const cart = await env.db.cart.create({ data: { label: 'basket' } })
    await env.db.hold.create({ data: { label: 'live', cartId: cart.id, expiresAt: '2026-01-01T00:05:00.000Z' } })
    await env.db.hold.create({ data: { label: 'dead', cartId: cart.id, expiresAt: '2025-12-31T23:00:00.000Z' } })
    return { env, db: env.db, cart }
  }

  test('a read returns the rows not yet expired, and the flags are the way out', async () => {
    const { env, db } = await staged()
    expect(labels(await db.hold.findMany())).toEqual(['live'])
    expect(labels(await db.hold.findMany({ withExpired: true }))).toEqual(['dead', 'live'])
    expect(labels(await db.hold.findMany({ onlyExpired: true }))).toEqual(['dead'])
    expect(await db.hold.count()).toBe(1)
    expect(await db.hold.count({ withExpired: true })).toBe(2)
    await env.close?.()
  })

  test('THE CLOCK MOVES IT — the assertion that could not be written before', async () => {
    const { env, db } = await staged()
    expect(await db.hold.count()).toBe(1)

    // No sweep has run and no row has changed. The hold is dead because the
    // clock passed it, which is what `expiresAt` was always supposed to mean.
    env.clock.advance('10m')
    expect(await db.hold.count()).toBe(0)
    expect(await db.hold.count({ withExpired: true })).toBe(2)
    expect(labels(await db.hold.findMany({ onlyExpired: true }))).toEqual(['dead', 'live'])
    await env.close?.()
  })

  test('a deadline minted from `$now()` lapses on the clock the window reads', async () => {
    const { env, db, cart } = await staged()
    // A caller that minted from `Date.now()` would write a deadline years from
    // T0, and the hold would outlive every `advance` below.
    const at = db.$now()
    expect(at.toISOString()).toBe(new Date(T0).toISOString())
    expect(db.asSystem().$now().getTime()).toBe(at.getTime())

    await db.hold.create({ data: { label: 'minted', cartId: cart.id, expiresAt: new Date(at.getTime() + 60_000) } })
    expect(labels(await db.hold.findMany())).toEqual(['live', 'minted'])
    env.clock.advance('2m')
    expect(db.$now().getTime()).toBe(at.getTime() + 120_000)
    expect(labels(await db.hold.findMany())).toEqual(['live'])
    await env.close?.()
  })

  test('`asOf` re-points it without moving the clock', async () => {
    const { env, db } = await staged()
    expect(labels(await db.hold.findMany({ asOf: '2026-01-01T00:01:00.000Z' }))).toEqual(['live'])
    expect(labels(await db.hold.findMany({ asOf: '2026-01-01T09:00:00.000Z' }))).toEqual([])
    expect(labels(await db.hold.findMany({ asOf: '2025-12-31T22:00:00.000Z' }))).toEqual(['dead', 'live'])
    // A Date is the same value said another way.
    expect(labels(await db.hold.findMany({ asOf: new Date('2026-01-01T09:00:00.000Z') }))).toEqual([])
    await env.close?.()
  })

  test('an unparseable `asOf` is refused by name', async () => {
    const { env, db } = await staged()
    await expect(db.hold.findMany({ asOf: 'tuesday' })).rejects.toThrow(/asOf must be an instant/)
    await env.close?.()
  })

  test('a relation read filters too, and so does `_count`', async () => {
    const { env, db, cart } = await staged()
    // The shape this closes: one model answering two ways depending on whether
    // it was reached directly or through its parent.
    const [withHolds] = await db.cart.findMany({ include: { holds: true } })
    expect(labels(withHolds.holds)).toEqual(['live'])

    const [withAll] = await db.cart.findMany({ include: { holds: { withExpired: true } } })
    expect(labels(withAll.holds)).toEqual(['dead', 'live'])

    const [counted] = await db.cart.findMany({ include: { _count: { holds: true } } })
    expect(counted._count.holds).toBe(1)

    env.clock.advance('10m')
    const [after] = await db.cart.findMany({ include: { holds: true, _count: { holds: true } } })
    expect(after.holds).toEqual([])
    expect(after._count.holds).toBe(0)
    expect(cart.id).toBeGreaterThan(0)
    await env.close?.()
  })
})

describe('@@effective — asked, over days', () => {
  async function staged() {
    const env = await createTestEnv({ schema: WINDOW, now: '2026-06-15T09:00:00.000Z' })
    await env.db.rate.create({ data: { amount: 100, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-01' } })
    await env.db.rate.create({ data: { amount: 200, effectiveFrom: '2026-06-01', effectiveTo: null } })
    await env.db.rate.create({ data: { amount: 300, effectiveFrom: '2027-01-01', effectiveTo: null } })
    return { env, db: env.db }
  }

  test('a read that states no moment gets every row — history is not hidden', async () => {
    const { env, db } = await staged()
    expect(amounts(await db.rate.findMany())).toEqual([100, 200, 300])
    expect(await db.rate.count()).toBe(3)
    // And the clock moving changes nothing, because nothing asked it.
    env.clock.advance('400d')
    expect(await db.rate.count()).toBe(3)
    await env.close?.()
  })

  test('a stated day gets the rows in force: a null `to` is still in force, a future `from` is not yet', async () => {
    const { env, db } = await staged()
    expect(amounts(await db.rate.findMany({ asOf: '2026-06-15' }))).toEqual([200])
    expect(amounts(await db.rate.findMany({ asOf: '2026-03-01' }))).toEqual([100])
    // TWO rows, and that is the declaration keeping its hands off: *at most one
    // open row* is `@@unique([...], where: effectiveTo == null)`, which this
    // schema does not declare. Implying it would be a second answer.
    expect(amounts(await db.rate.findMany({ asOf: '2027-06-01' }))).toEqual([200, 300])
    await env.close?.()
  })

  test('`onlyExpired` is the COMPLEMENT at the stated day, and needs one', async () => {
    const { env, db } = await staged()
    // Spelled as `to <= asOf` alone this would answer [100] and drop the 2027
    // row, which on a two-sided window is most of what a caller asking for the
    // excluded rows wants.
    expect(amounts(await db.rate.findMany({ asOf: '2026-06-15', onlyExpired: true }))).toEqual([100, 300])
    // With no moment stated there is nothing to be out of force AT.
    await expect(db.rate.findMany({ onlyExpired: true })).rejects.toThrow(/needs asOf/)
    await env.close?.()
  })

  test('a day window reads a DAY, and refuses an instant by name', async () => {
    const { env, db } = await staged()
    await expect(db.rate.findMany({ asOf: '2026-03-01T00:00:00.000Z' }))
      .rejects.toThrow(/must be a plain date/)
    await env.close?.()
  })

  test('the interval is half-open, so a row opening where another closes is in exactly one', async () => {
    const { env, db } = await staged()
    expect(amounts(await db.rate.findMany({ asOf: '2026-06-01' }))).toEqual([200])
    await env.close?.()
  })

  test('a write is not filtered: closing the open row needs no flag', async () => {
    const { env, db } = await staged()
    // `setPay` and `reprice` both close whichever row is open, and a future-
    // dated one is open too. Imposed, the update would match nothing and the
    // next insert would collide with the partial unique.
    const future = (await db.rate.findMany({ where: { amount: 300 } }))[0]
    const closed = await db.rate.update({ where: { id: future.id }, data: { effectiveTo: '2027-06-01' } })
    expect(closed?.effectiveTo).toBe('2027-06-01')
    await env.close?.()
  })
})

describe('@@effective — a pointer is a fact, and the window does not hide it', () => {
  async function staged() {
    const env = await createTestEnv({ schema: PRICED, now: '2026-06-15T09:00:00.000Z' })
    const plan = await env.db.plan.create({ data: { name: 'Pro' } })
    const old  = await env.db.planVersion.create({ data: {
      planId: plan.id, price: 900, effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: '2026-03-01T00:00:00.000Z' } })
    const cur  = await env.db.planVersion.create({ data: {
      planId: plan.id, price: 1200, effectiveFrom: '2026-03-01T00:00:00.000Z', effectiveTo: null } })
    // Sold in February and never moved: still paying 900.
    const sub = await env.db.subscription.create({ data: { planVersionId: old.id } })
    return { env, db: env.db, plan, old, cur, sub }
  }

  test('a subscriber on a closed price still reads it, by include and by id', async () => {
    const { env, db, sub, old } = await staged()
    // The failure this section exists for: imposed, both of these answer null
    // and a renewal job reading them skips the subscriber with nothing said.
    const [withVersion] = await db.subscription.findMany({ include: { planVersion: true } })
    expect(withVersion.planVersion?.price).toBe(900)
    expect((await db.planVersion.findFirst({ where: { id: sub.planVersionId } }))?.price).toBe(900)
    expect(old.id).toBe(sub.planVersionId)
    await env.close?.()
  })

  test('the price table is the history, and the current price is one stated moment', async () => {
    const { env, db, plan } = await staged()
    const [withAll] = await db.plan.findMany({ include: { versions: true, _count: { versions: true } } })
    expect(withAll.versions.map(v => v.price).sort()).toEqual([1200, 900])
    expect(withAll._count.versions).toBe(2)

    const now = await db.planVersion.findMany({ where: { planId: plan.id }, asOf: '2026-06-15T09:00:00.000Z' })
    expect(now.map(v => v.price)).toEqual([1200])
    await env.close?.()
  })

  test('an include cannot ask `onlyExpired` of an asked window — it has no moment to ask at', async () => {
    const { env, db } = await staged()
    await expect(db.plan.findMany({ include: { versions: { onlyExpired: true } } }))
      .rejects.toThrow(/has no moment to be out of force at/)
    await env.close?.()
  })

  test('$inWindow holds every row unless a moment is stated', async () => {
    const { env, db, old } = await staged()
    // A frame about a closed price reaches the subscriber holding it; a store
    // that dropped it would lose the price its own row points at.
    expect(db.$inWindow('planVersion', old)).toBe(true)
    expect(db.$inWindow('planVersion', old, '2026-06-15T09:00:00.000Z')).toBe(false)
    expect(db.$inWindow('planVersion', old, '2026-02-01T00:00:00.000Z')).toBe(true)
    await env.close?.()
  })
})

describe('@@expires — the decisions with no precedent to copy', () => {
  async function staged() {
    const env = await createTestEnv({ schema: DEADLINE, now: T0 })
    const cart = await env.db.cart.create({ data: { label: 'basket' } })
    await env.db.hold.create({ data: { label: 'live', cartId: cart.id, expiresAt: '2026-01-01T00:05:00.000Z' } })
    await env.db.hold.create({ data: { label: 'dead', cartId: cart.id, expiresAt: '2025-12-31T23:00:00.000Z' } })
    return { env, db: env.db }
  }

  test('a hard delete APPLIES it — templates, not soft delete', async () => {
    const { env, db } = await staged()
    // Soft delete's bypass is the contract of `delete` against `remove`, and
    // this declares no verb for one to be the counterpart of.
    await db.hold.deleteMany({ where: {} })
    expect(await db.hold.count({ withExpired: true })).toBe(1)
    expect(labels(await db.hold.findMany({ withExpired: true }))).toEqual(['dead'])
    await env.close?.()
  })

  test('a sweep says `onlyExpired`, which is the intent it spelled by hand', async () => {
    const { env, db } = await staged()
    await db.hold.deleteMany({ where: {}, onlyExpired: true })
    expect(labels(await db.hold.findMany({ withExpired: true }))).toEqual(['live'])
    await env.close?.()
  })

  test('a delete carries `asOf`, so a sweep at a stated instant takes the right rows', async () => {
    const { env, db } = await staged()
    // The regression this row exists for: the flags reached the delete's fold
    // and `asOf` did not, so a sweep stating an instant deleted at `now` and
    // matched nothing — silently, because a delete that removed no rows answers
    // a count rather than an error.
    const gone = await db.hold.deleteMany({ onlyExpired: true, asOf: '2099-01-01T00:00:00.000Z' })
    expect(await db.hold.count({ withExpired: true })).toBe(0)
    expect(gone).toBeTruthy()
    await env.close?.()
  })

  test('a write is filtered at NOW, and `withExpired` is the way through', async () => {
    const { env, db } = await staged()
    const dead = (await db.hold.findMany({ onlyExpired: true }))[0]

    // Without the flag an expired row cannot be silently resurrected.
    expect(await db.hold.update({ where: { id: dead.id }, data: { label: 'revived' } })).toBeNull()
    const revived = await db.hold.update({ where: { id: dead.id }, data: { label: 'revived' }, withExpired: true })
    expect(revived?.label).toBe('revived')
    await env.close?.()
  })

  test('`onlyExpired` on a model with no window refuses; `withExpired` and `asOf` pass', async () => {
    const { env, db } = await staged()
    await expect(db.cart.findMany({ onlyExpired: true }))
      .rejects.toThrow(/@@expires or @@effective/)
    // Both WIDEN, and on a model that hides nothing the full row set already is
    // every row — so a generic caller (a row browser with an *as at* control)
    // is not writing a mistake it cannot see.
    expect(await db.cart.count({ withExpired: true })).toBe(1)
    expect(await db.cart.count({ asOf: '2020-01-01T00:00:00.000Z' })).toBe(1)
    await env.close?.()
  })

  test('$inWindow is the broadcast seam, and it answers about the row in hand', async () => {
    const { env, db } = await staged()
    const [live] = await db.hold.findMany()
    const [dead] = await db.hold.findMany({ onlyExpired: true })

    expect(db.$inWindow('hold', live)).toBe(true)
    expect(db.$inWindow('hold', dead)).toBe(false)
    // A model with no window is always in it — there is nothing to be out of.
    expect(db.$inWindow('cart', { id: 1 })).toBe(true)
    // The same clock the filter reads.
    env.clock.advance('10m')
    expect(db.$inWindow('hold', live)).toBe(false)
    // And it takes an explicit instant, which is what a replay grades with.
    expect(db.$inWindow('hold', live, '2026-01-01T00:01:00.000Z')).toBe(true)
    await env.close?.()
  })
})

describe('@@expires and @@effective — refused at parse', () => {
  const refuses = (src, re) => {
    const r = parse(src)
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toMatch(re)
  }
  const throwsAtParse = (src, re) => {
    let message = ''
    try { const r = parse(src); message = r.valid ? '' : r.errors.join('\n') }
    catch (e) { message = String(e.message) }
    expect(message).toMatch(re)
  }

  test('@@effective with no `from:` names @@expires — the line reads as an expiry', () => {
    // Accepted, it would be a window nobody asks: an expired session read back
    // as live, with nothing said.
    throwsAtParse('model A {\n id Int @id\n x DateTime\n @@effective(to: x)\n}', /@@expires\(x\)/)
  })

  test('a model declaring both', () => {
    refuses('model A {\n id Int @id\n f DateTime\n t DateTime?\n @@expires(t)\n @@effective(from: f, to: t)\n}',
      /declares both @@expires and @@effective/)
  })

  test('a column the model does not have', () => {
    refuses('model A {\n id Int @id\n x DateTime\n @@expires(nope)\n}', /@@expires\(nope\) names no field/)
    refuses('model A {\n id Int @id\n x DateTime\n @@effective(from: nope)\n}', /names no field/)
  })

  test('a column that is not a time', () => {
    refuses('model A {\n id Int @id\n n Int\n @@expires(n)\n}', /must be a DateTime or a String @date/)
  })

  test('a pair whose two edges are different KINDS', () => {
    // `'2026-06-01' <= '2026-06-01T09:00:00Z'` is true and means nothing, so
    // this is refused here rather than compared at runtime.
    refuses('model A {\n id Int @id\n f String @date\n t DateTime?\n @@effective(from: f, to: t)\n}',
      /mixes kinds/)
  })

  test('naming no column at all', () => {
    throwsAtParse('model A {\n id Int @id\n x DateTime\n @@effective()\n}', /names no column/)
  })

  test('an argument that is neither from nor to', () => {
    throwsAtParse('model A {\n id Int @id\n x DateTime\n @@effective(at: x)\n}', /takes 'from:' and 'to:'/)
  })

  test('a @from over an @@expires model without its own where', () => {
    refuses(`
model Cart {
  id    Int @id
  holds Int @from(Hold, count: true)
}
model Hold {
  id        Int      @id
  cartId    Int
  expiresAt DateTime
  @@expires(expiresAt)
}`, /reads a model declaring @@expires/)
  })
})

// A live store holding a Hold drops it at `expiresAt` by its own clock, since
// the transition is the clock and no frame announces it (`FJS-1274`). It can
// only do that if the schema tells it which column is the edge.
describe('x-effective — the window reaches the client', () => {
  test('an imposed window is emitted with its column and kind', () => {
    const defs = generateJsonSchema(parse(DEADLINE).schema).$defs
    expect(defs.Hold['x-effective']).toEqual({ from: null, to: 'expiresAt', kind: 'instant', imposed: true })
    expect(defs.Cart['x-effective']).toBeUndefined()
  })
})
