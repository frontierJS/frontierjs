// FJS-615 — `nested` is an object, so `nested.length` is `undefined`, so every
// guard spelled that way read *there are no nested writes* and all three were
// wrong. It is not a typo three times: `.length` on an object is silently
// falsy rather than an error, which is what let three separate guards be
// written the same wrong way and none of them fail.
//
// Three consequences, and only one of them was loud:
//
//   create + select:false   the parent was written and every child DROPPED,
//                           with `null` returned and nothing said
//   update + select:false   the same, but only where the payload also carries
//                           a scalar column — a nested-only payload sets no
//                           columns, misses the fast path entirely and worked
//                           by accident, which is why this went unnoticed
//   upsert fast path        a legitimate nested write handed to the column
//                           validator: `lines: must be an array`
//
// Every case below is a measurement of the code as it stood.

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
model Inv  { id Int @id @default(autoincrement())  n String @unique  lines Line[] }
model Line { id Int @id @default(autoincrement())  amount Int  invId Int
             inv Inv @relation(fields: [invId], references: [id], onDelete: Cascade) }
`
const setup = () => createClient({ db: ':memory:', schema: SCHEMA })
const lines = async (db: any, invId: number) =>
  (await db.line.findMany({ where: { invId } })).length

describe('a nested write survives select: false', () => {
  it('create keeps its children', async () => {
    const db: any = await setup()
    await db.inv.create({ select: false, data: { n: 'A', lines: { create: [{ amount: 10 }, { amount: 20 }] } } })
    const row = await db.inv.findFirst({ where: { n: 'A' } })
    expect(await lines(db, row.id)).toBe(2)
    await db.$close()
  })

  // The half that hid the create case: a payload of nothing but a nested write
  // sets no columns, so it never reaches the fast path at all.
  it('update keeps them too, with a scalar column beside them', async () => {
    const db: any = await setup()
    const inv = await db.inv.create({ data: { n: 'B' } })
    await db.inv.update({ where: { id: inv.id }, select: false, data: { n: 'B2', lines: { create: [{ amount: 4 }] } } })
    expect(await lines(db, inv.id)).toBe(1)
    await db.$close()
  })

  // `select: false` is *do not hand me the row*, and it still means that. The
  // parent's id is needed to attach the children, so RETURNING cannot be
  // skipped — but that is the method's need, not a change to what was asked.
  it('and still answers null, which is what select: false asked for', async () => {
    const db: any = await setup()
    const withKids = await db.inv.create({ select: false, data: { n: 'C', lines: { create: [{ amount: 1 }] } } })
    const without  = await db.inv.create({ select: false, data: { n: 'D' } })
    expect(withKids).toBeNull()
    expect(without).toBeNull()
    await db.$close()
  })
})

describe('the upsert fast path declines a nested write instead of mangling it', () => {
  it('on the create side', async () => {
    const db: any = await setup()
    await db.inv.upsert({ where: { n: 'E' }, create: { n: 'E', lines: { create: [{ amount: 7 }] } }, update: { n: 'E' } })
    const row = await db.inv.findFirst({ where: { n: 'E' } })
    expect(row).not.toBeNull()
    expect(await lines(db, row.id)).toBe(1)
    await db.$close()
  })

  it('on the update side', async () => {
    const db: any = await setup()
    const inv = await db.inv.create({ data: { n: 'F' } })
    await db.inv.upsert({ where: { n: 'F' }, create: { n: 'F' }, update: { lines: { create: [{ amount: 9 }] } } })
    expect(await lines(db, inv.id)).toBe(1)
    await db.$close()
  })
})

// The controls. The guards exist to keep a real saving on the ordinary call, so
// a fix that simply stopped taking the fast path everywhere would pass every
// assertion above and be worth nothing.
describe('the paths that were already right stay right', () => {
  it('an ordinary nested create still works', async () => {
    const db: any = await setup()
    const inv = await db.inv.create({ data: { n: 'G', lines: { create: [{ amount: 1 }, { amount: 2 }] } } })
    expect(await lines(db, inv.id)).toBe(2)
    await db.$close()
  })

  it('select: false with no nested write still skips the row', async () => {
    const db: any = await setup()
    expect(await db.inv.create({ select: false, data: { n: 'H' } })).toBeNull()
    expect(await db.inv.update({ where: { n: 'H' }, select: false, data: { n: 'H2' } })).toBeNull()
    await db.$close()
  })

  it('an upsert with no nested write still takes the fast path and is correct', async () => {
    const db: any = await setup()
    await db.inv.upsert({ where: { n: 'I' }, create: { n: 'I' }, update: { n: 'I' } })
    await db.inv.upsert({ where: { n: 'I' }, create: { n: 'I' }, update: { n: 'I2' } })
    expect(await db.inv.findFirst({ where: { n: 'I2' } })).not.toBeNull()
    expect(await db.inv.findFirst({ where: { n: 'I' } })).toBeNull()
    await db.$close()
  })
})
