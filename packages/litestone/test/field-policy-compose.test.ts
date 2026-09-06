// FJS-D205 — the read strip is two axes AND'd, not a chain.
//
// VISIBILITY (@hashed, @encrypted, @guarded, field @allow('read')) answers *may
// this caller see the column at all*; INCLUSION (@omit) answers *is it in the
// default payload*. They were one if/else ladder where the first match won, so
// `@guarded` swallowed an `@omit` written beside it and a field `@allow('read')`
// under `@guarded` or `@encrypted` was unreachable — silently, in both cases.
//
// The shape of this file is the point. Every pair is asserted BESIDE each of its
// halves alone, because a strip that refused everything and a strip that
// composed are indistinguishable from the refused side, and a reordering of the
// branches passes any test that only asks about single attributes.

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
claim isAdmin

model Doc {
  id       Int     @id
  title    String
  gu       Int?    @guarded
  om       Int?    @omit(all)
  oml      Int?    @omit
  guOm     Int?    @guarded @omit(all)
  guOml    Int?    @guarded @omit
  encAllow String? @encrypted @allow('read', auth().isAdmin)
  omAllow  Int?    @omit(all) @allow('read', auth().isAdmin)
}
`
const ALL = ['gu', 'om', 'oml', 'guOm', 'guOml', 'encAllow', 'omAllow']
const ROW  = { id: 1, title: 'n', gu: 1, om: 2, oml: 3, guOm: 4, guOml: 5, encAllow: 'e', omAllow: 7 }
const KEY  = 'a'.repeat(64)

const open = async () => {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA, encryptionKey: KEY })
  await db.asSystem().doc.create({ data: ROW })
  return db
}
// Which of the columns came back. `null` is a value here, so presence is asked
// with `in` rather than by truthiness.
const got = (row: any) => ALL.filter(f => row && f in row)
const select = Object.fromEntries([['id', true], ...ALL.map(f => [f, true])])

describe('a caller sees neither axis without asking', () => {
  // Bare `@omit` is a LIST rule, so a findUnique keeps it — that is the whole
  // difference from `@omit(all)`, and it is the control for the guarded pair.
  it('strips every protected and every all-omitted column', async () => {
    const db = await open()
    expect(got(await db.doc.findUnique({ where: { id: 1 } }))).toEqual(['oml'])
    expect(got((await db.doc.findMany({}))[0])).toEqual([])
    await db.$close()
  })

  // The control for the row below: `select` DOES unlock, so a grid where
  // nothing unlocks would not prove the guarded columns are locked.
  it('an explicit select unlocks @omit and never @guarded', async () => {
    const db = await open()
    const row = await db.doc.findUnique({ where: { id: 1 }, select })
    // `omAllow` is absent because nobody is signed in, not because select
    // failed — the admin/non-admin pair below is what separates those.
    expect(got(row)).toEqual(['om', 'oml'])
    await db.$close()
  })
})

describe('asSystem() lifts visibility and does not lift inclusion', () => {
  // The defect. Before this, `guOm` and `guOml` came back here.
  it('a guarded column comes back and a guarded+omitted one does not', async () => {
    const db = await open()
    const row = await db.asSystem().doc.findUnique({ where: { id: 1 } })
    expect(got(row)).toEqual(['gu', 'oml', 'guOml', 'encAllow'])
    await db.$close()
  })

  it('naming them brings the omitted halves back too', async () => {
    const db = await open()
    const row = await db.asSystem().doc.findUnique({ where: { id: 1 }, select })
    expect(got(row)).toEqual(ALL)
    await db.$close()
  })

  it('a list still drops @omit', async () => {
    const db = await open()
    const [row] = await db.asSystem().doc.findMany({})
    expect(got(row)).toEqual(['gu', 'encAllow'])
    await db.$close()
  })
})

describe('a field @allow may narrow a protected column and may not widen one', () => {
  // `encAllow` is the pair; `om`/`omAllow` are the halves that make it readable.
  it('an admin caller does not reach a guarded column through @allow', async () => {
    const db = await open()
    const row = await db.$setAuth({ id: 9, isAdmin: true }).doc.findUnique({ where: { id: 1 }, select })
    expect(got(row)).toEqual(['om', 'oml', 'omAllow'])
    await db.$close()
  })

  it('a non-admin caller loses the @omit+@allow column and keeps the plain @omit one', async () => {
    const db = await open()
    const row = await db.$setAuth({ id: 9, isAdmin: false }).doc.findUnique({ where: { id: 1 }, select })
    expect(got(row)).toEqual(['om', 'oml'])
    await db.$close()
  })

  // Under the chain this was unreachable: `guarded` matched first and the
  // predicate never ran. It must stay unreachable in the WIDENING direction and
  // reachable in the narrowing one, which asSystem() is the only way to see.
  it('asSystem() is not narrowed by a field @allow', async () => {
    const db = await open()
    const row = await db.asSystem().doc.findUnique({ where: { id: 1 } })
    expect(got(row)).toContain('encAllow')
    await db.$close()
  })
})
