// FJS-619 — a field `@allow('read')` that reads only the caller is answered once.
//
// `@allow('read', auth().isAdmin)` has ONE answer for a whole result set, and it
// was asked once per field per ROW through the expression interpreter — the
// worst per-row cost in the 2026-07-18 audit (M7). It is now hoisted.
//
// The suite is almost entirely about the hoist NOT applying. A wrong one is
// silent in the worst way: every row in a page gets the FIRST row's answer, so a
// list looks right whenever its rows happen to agree, which on a seeded fixture
// is most of the time. Every case below therefore reads rows that DISAGREE.

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'
import { referencesRow } from '../src/core/policy.js'

const SCHEMA = (pred: string) => `
model Doc {
  id      Int    @id
  ownerId Int
  title   String
  secret  String @allow('read', ${pred})
}
`
const seed = async (db: any) => db.asSystem().doc.createMany({ data: [
  { id: 1, ownerId: 1, title: 'a', secret: 's1' },
  { id: 2, ownerId: 2, title: 'b', secret: 's2' },
  { id: 3, ownerId: 1, title: 'c', secret: 's3' },
]})
const open = async (pred: string) => {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA(pred) })
  await seed(db)
  return db
}
const secrets = (rows: any[]) => rows.sort((a, b) => a.id - b.id).map(r => ('secret' in r ? r.secret : null))

describe('a caller-only predicate is hoisted and still answers correctly', () => {
  it('admits every row for a caller who passes', async () => {
    const db = await open('auth().isAdmin')
    const rows = await db.$setAuth({ id: 9, isAdmin: true }).doc.findMany({})
    expect(secrets(rows)).toEqual(['s1', 's2', 's3'])
    await db.$close()
  })

  it('strips every row for a caller who does not', async () => {
    const db = await open('auth().isAdmin')
    const rows = await db.$setAuth({ id: 9, isAdmin: false }).doc.findMany({})
    expect(secrets(rows)).toEqual([null, null, null])
    await db.$close()
  })

  // The memo hangs on the context, and `$setAuth` builds a new one per caller.
  // If it were keyed by anything coarser the second caller would read the
  // first's answer, which is the whole risk this feature carries.
  it('two principals in one process get their own answer', async () => {
    const db = await open('auth().isAdmin')
    const yes = await db.$setAuth({ id: 1, isAdmin: true }).doc.findMany({})
    const no  = await db.$setAuth({ id: 2, isAdmin: false }).doc.findMany({})
    const yes2 = await db.$setAuth({ id: 3, isAdmin: true }).doc.findMany({})
    expect(secrets(yes)).toEqual(['s1', 's2', 's3'])
    expect(secrets(no)).toEqual([null, null, null])
    expect(secrets(yes2)).toEqual(['s1', 's2', 's3'])
    await db.$close()
  })
})

// The cases that must NOT hoist. Each reads a page whose rows DISAGREE, so a
// wrong hoist shows up as every row taking the first one's verdict.
describe('a predicate that reads the row is still asked per row', () => {
  it('a bare field reference', async () => {
    const db = await open('ownerId == auth().id')
    const rows = await db.$setAuth({ id: 1 }).doc.findMany({})
    expect(secrets(rows)).toEqual(['s1', null, 's3'])
    await db.$close()
  })

  // The shape that would fool a deny-list: an auth-only branch sitting beside a
  // row-reading one. `some(referencesRow)` is over the WHOLE expression.
  it('a mixed expression — one branch caller-only, one row-reading', async () => {
    const db = await open("auth().role == 'nobody' || ownerId == auth().id")
    const rows = await db.$setAuth({ id: 2, role: 'user' }).doc.findMany({})
    expect(secrets(rows)).toEqual([null, 's2', null])
    await db.$close()
  })

  // Two @allow on one field are OR-ed. One of them reading the row disqualifies
  // the pair, or the row-reading half is answered from the caller-only half.
  it('two @allow on one field, only one of which reads the row', async () => {
    const db: any = await createClient({ db: ':memory:', schema: `
model Doc {
  id      Int    @id
  ownerId Int
  title   String
  secret  String @allow('read', auth().isAdmin) @allow('read', ownerId == auth().id)
}` })
    await seed(db)
    const rows = await db.$setAuth({ id: 1, isAdmin: false }).doc.findMany({})
    expect(secrets(rows)).toEqual(['s1', null, 's3'])
    await db.$close()
  })
})

// The classifier itself, asked directly — the per-row cases above prove the
// behavior, and these pin the RULE, including the one no schema can express yet.
describe('referencesRow is an allow-list, so an unknown node reads the row', () => {
  const auth = { type: 'auth', field: 'isAdmin' }

  it('says no to a caller-only expression', () => {
    expect(referencesRow(auth)).toBe(false)
    expect(referencesRow({ type: 'not', expr: auth })).toBe(false)
    expect(referencesRow({ type: 'compare', op: '==', left: auth, right: { type: 'literal', value: true } })).toBe(false)
  })

  it('says yes to a field, a check, and anything nested under them', () => {
    expect(referencesRow({ type: 'field', name: 'ownerId' })).toBe(true)
    expect(referencesRow({ type: 'check', relation: 'owner', expr: auth })).toBe(true)
    expect(referencesRow({ type: 'or', left: auth, right: { type: 'field', name: 'x' } })).toBe(true)
  })

  // `now()` reads no row and is still refused: a clock-dependent predicate
  // hoisted across a page would answer one instant for rows read at another.
  it('says yes to now(), which is about the clock rather than the row', () => {
    expect(referencesRow({ type: 'now' })).toBe(true)
  })

  // The safety property. A kind the language grows later must be evaluated per
  // row — slower and correct — rather than silently stop stripping.
  it('says yes to a node kind it has never heard of', () => {
    expect(referencesRow({ type: 'somethingNewInTwoYears' })).toBe(true)
    expect(referencesRow({ type: 'and', left: auth, right: { type: 'brandNew' } })).toBe(true)
  })
})

describe('the paths beside it are unchanged', () => {
  it('asSystem() still reads the column whatever the predicate says', async () => {
    const db = await open('auth().isAdmin')
    expect(secrets(await db.asSystem().doc.findMany({}))).toEqual(['s1', 's2', 's3'])
    await db.$close()
  })

  it('an anonymous caller is refused by a caller-only predicate', async () => {
    const db = await open('auth().isAdmin')
    expect(secrets(await db.doc.findMany({}))).toEqual([null, null, null])
    await db.$close()
  })
})
