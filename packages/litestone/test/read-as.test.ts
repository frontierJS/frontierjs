// read-as.test.ts — `$readAs`, the fifth sibling.
//
// `FJS-631`. `@@allow` compiles into a SELECT's WHERE, so a row that reaches a
// caller through a query is filtered by construction and a row that reaches
// them any other way is filtered by nothing. Junction owns the fan-out of a
// broadcast and cannot own the rule — the gate, the row policies and the field
// policies are declared here, and a second implementation of any of them is a
// second answer to who may read.
//
// Every refusal below is paired with the acceptance of the identical row by a
// principal the schema admits, for `FJS-351`'s reason: a function that refuses
// everything is indistinguishable from one that works, from the refused side.

import { test, expect, describe } from 'bun:test'
import { createClient } from '../src/core/client.js'

const SCHEMA = `
database main { path ":memory:" }

model Order {
  id         Int     @id @default(autoincrement())
  reference  String
  total      Int
  margin     Int?    @allow('read', auth().isStaff == true)
  internal   String? @guarded(all)
  userId     String?
  @@gate("1.4.4.5")
  @@allow('read', auth().isStaff == true)
  @@allow('read', userId == auth().id)
}

// Reads at 0, no policy, no field rule — nothing to grade.
model Product {
  id   Int    @id @default(autoincrement())
  name String
}

// Gated but unpoliced: the gate alone is a reason to grade.
model Ledger {
  id   Int @id @default(autoincrement())
  memo String
  @@gate("5.8.9.9")
}
`

const client = () => createClient({ schema: SCHEMA, resolveFrom: import.meta.dir })

const ROW = { id: 1, reference: 'ORD-1001', total: 4194, margin: 1200, internal: 'do not show', userId: 'u-owner' }
const staff    = { id: 'u-staff', isStaff: true }
const owner    = { id: 'u-owner', isStaff: false }
const stranger = { id: 'u-other', isStaff: false }

describe('who may see the row at all', () => {
  test('nobody is refused by the gate — the whole answer for a stranger', async () => {
    const db = await client()
    expect(await db.$readAs('order', ROW, null)).toBeNull()
  })

  test('a signed-in caller the row policy excludes is refused', async () => {
    const db = await client()
    expect(await db.$readAs('order', ROW, stranger)).toBeNull()
  })

  test('and the controls — the owner and staff each get the row', async () => {
    const db = await client()
    expect((await db.$readAs('order', ROW, owner))?.id).toBe(1)
    expect((await db.$readAs('order', ROW, staff))?.id).toBe(1)
  })

  test('the gate is asked BEFORE the row policy, as every other layer reads it', async () => {
    // `Ledger` declares a gate and no policy, so a caller below it is refused
    // by a mechanism a policy walk would never reach.
    const db = await client()
    expect(await db.$readAs('ledger', { id: 1, memo: 'x' }, owner)).toBeNull()
    expect((await db.$readAs('ledger', { id: 1, memo: 'x' }, { id: 'a', isAdmin: true }))?.memo).toBe('x')
  })
})

describe('what of the row they may see', () => {
  test('a field the caller may not read is stripped, and the writer’s copy is not the answer', async () => {
    // The announced row came from a staff write, so it carries `margin`.
    const db = await client()
    const asOwner = await db.$readAs('order', ROW, owner)
    expect(asOwner.margin).toBeUndefined()
    expect(asOwner.reference).toBe('ORD-1001')

    const asStaff = await db.$readAs('order', ROW, staff)
    expect(asStaff.margin).toBe(1200)
  })

  test('a @guarded column is stripped for everybody, staff included', async () => {
    const db = await client()
    expect((await db.$readAs('order', ROW, staff)).internal).toBeUndefined()
    expect((await db.$readAs('order', ROW, owner)).internal).toBeUndefined()
  })

  test('the row handed in is not mutated — the caller may still send it elsewhere', async () => {
    const db = await client()
    await db.$readAs('order', ROW, owner)
    expect(ROW.margin).toBe(1200)
    expect(ROW.internal).toBe('do not show')
  })
})

describe('$readGrading — when the whole pass can be skipped', () => {
  test('a model with no gate, no policy and no field rule is open', async () => {
    const db = await client()
    expect(db.$readGrading('product')).toBe('open')
  })

  test('a gate alone makes it graded', async () => {
    const db = await client()
    expect(db.$readGrading('ledger')).toBe('graded')
  })

  test('a policy makes it graded', async () => {
    const db = await client()
    expect(db.$readGrading('order')).toBe('graded')
  })

  test('an unknown accessor is graded — the fail-closed direction', async () => {
    // The sibling contract answers `{}` / `[]` for an unknown accessor because
    // *I cannot judge this* is not *this is wrong*. Here it is a permission, so
    // the same uncertainty has to fall the other way.
    const db = await client()
    expect(db.$readGrading('nope')).toBe('graded')
    expect(await db.$readAs('nope', ROW, staff)).toBeNull()
  })

  test('an open model still answers the row unchanged', async () => {
    const db = await client()
    const p = { id: 1, name: 'Widget' }
    expect(await db.$readAs('product', p, null)).toEqual(p)
  })
})

describe('the sibling contract', () => {
  test('every flavor of client answers identically for the same principal', async () => {
    // $capabilitiesFor's rule: the subject is an ARGUMENT, so which client is
    // asking cannot change the answer. Defaulting to the client's own principal
    // would break exactly that.
    const db = await client()
    const answers = await Promise.all([
      db.$readAs('order', ROW, owner),
      db.asSystem().$readAs('order', ROW, owner),
      db.$setAuth(staff).$readAs('order', ROW, owner),
      db.$setAuth(null).$readAs('order', ROW, owner),
    ])
    const first = JSON.stringify(answers[0])
    for (const a of answers) expect(JSON.stringify(a)).toBe(first)
    // …and it is the OWNER's answer, not the asking client's.
    expect(answers[1].margin).toBeUndefined()
  })

  test('a null row is null, never an empty object', async () => {
    const db = await client()
    expect(await db.$readAs('order', null, staff)).toBeNull()
  })
})
