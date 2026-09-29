// test/cardinality.test.ts
//
// `@minItems`/`@maxItems` on a relation — how many children a parent must and
// may have. Every case here runs against a real database rather than a parse,
// because the whole question is WHEN the count is graded: a minimum cannot be
// true at the statement that creates the parent, and the two single-row fast
// paths never reach a commit at all.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'
import { parse } from '../src/core/parser.js'

const SHOP = `
model Order {
  id    Int @id @default(autoincrement())
  total Int @default(0)
  lines OrderLine[] @minItems(1) @maxItems(2)
}
model OrderLine {
  id      Int @id @default(autoincrement())
  orderId Int
  order   Order @relation(fields: [orderId], references: [id])
  amount  Int @default(0)
}`

const shop = () => createClient({ schema: SHOP, db: ':memory:' })
const refusal = async (fn: () => Promise<unknown>) => {
  try { await fn(); return null } catch (e: any) { return e.message as string }
}

describe('a minimum', () => {
  test('a create naming no children is refused before the INSERT', async () => {
    const db = await shop()
    const msg = await refusal(() => db.order.create({ data: { total: 1 } }))
    expect(msg).toContain('at least 1 OrderLine')
    // Refused rather than rolled back: nothing was written, so no id was spent.
    expect(await db.order.count()).toBe(0)
  })

  test('a create carrying them is accepted', async () => {
    const db = await shop()
    const o = await db.order.create({ data: { lines: { create: [{ amount: 5 }] } }, include: { lines: true } })
    expect(o.lines.length).toBe(1)
  })

  test('emptying a parent is refused and the rows survive', async () => {
    const db = await shop()
    const o = await db.order.create({ data: { lines: { create: [{ amount: 5 }] } } })
    expect(await refusal(() => db.orderLine.deleteMany({ where: { orderId: o.id } })))
      .toContain('at least 1')
    expect(await db.orderLine.count({ where: { orderId: o.id } })).toBe(1)
  })

  test('moving the last child away is refused — a move leaves one parent as surely as it joins another', async () => {
    const db = await shop()
    const a = await db.order.create({ data: { lines: { create: [{ amount: 1 }] } }, include: { lines: true } })
    const b = await db.order.create({ data: { lines: { create: [{ amount: 2 }] } } })
    expect(await refusal(() => db.orderLine.update({ where: { id: a.lines[0].id }, data: { orderId: b.id } })))
      .toContain('at least 1')
  })

  // The reason the grade is deferred at all: replacing every line of an order
  // is two statements and the parent is below its minimum between them.
  test('a replace-all inside $transaction is accepted', async () => {
    const db = await shop()
    const o = await db.order.create({ data: { lines: { create: [{ amount: 1 }] } } })
    await db.$transaction(async (tx: any) => {
      await tx.orderLine.deleteMany({ where: { orderId: o.id } })
      await tx.orderLine.createMany({ data: [{ orderId: o.id, amount: 9 }] })
    })
    const lines = await db.orderLine.findMany({ where: { orderId: o.id } })
    expect(lines.map((l: any) => l.amount)).toEqual([9])
  })

  test('the same two statements OUTSIDE a transaction are refused at the first', async () => {
    const db = await shop()
    const o = await db.order.create({ data: { lines: { create: [{ amount: 1 }] } } })
    expect(await refusal(() => db.orderLine.deleteMany({ where: { orderId: o.id } })))
      .toContain('at least 1')
  })
})

describe('a maximum', () => {
  // The single-row create never opens a transaction (`FJS-1106`), so this is
  // the case a rule graded at commit misses unless that path is left.
  test('one child past the bound is refused, through the create fast path', async () => {
    const db = await shop()
    const o = await db.order.create({ data: { lines: { create: [{ amount: 1 }] } } })
    await db.orderLine.create({ data: { orderId: o.id, amount: 2 } })
    expect(await refusal(() => db.orderLine.create({ data: { orderId: o.id, amount: 3 } })))
      .toContain('at most 2')
    expect(await db.orderLine.count({ where: { orderId: o.id } })).toBe(2)
  })

  test('a nested create past the bound is refused and the parent does not survive it', async () => {
    const db = await shop()
    expect(await refusal(() => db.order.create({ data: { lines: { create: [{ amount: 1 }, { amount: 2 }, { amount: 3 }] } } })))
      .toContain('at most 2')
    expect(await db.order.count()).toBe(0)
  })

  test('createMany past the bound is refused as one unit', async () => {
    const db = await shop()
    const o = await db.order.create({ data: { lines: { create: [{ amount: 1 }] } } })
    expect(await refusal(() => db.orderLine.createMany({
      data: [{ orderId: o.id, amount: 2 }, { orderId: o.id, amount: 3 }] })))
      .toContain('at most 2')
    expect(await db.orderLine.count({ where: { orderId: o.id } })).toBe(1)
  })
})

describe('what the count means', () => {
  // `select: false` with nothing nested skips the RETURNING, so the write has no
  // row to be read out of — and a rule that reads the row alone grades nothing
  // on exactly the call that says *do not hand me the row*.
  test('select: false still moves the count, on both sides', async () => {
    const db = await shop()
    const o = await db.order.create({ data: { lines: { create: [{ amount: 1 }] } } })
    await db.orderLine.create({ data: { orderId: o.id, amount: 2 }, select: false })
    expect(await refusal(() => db.orderLine.create({ data: { orderId: o.id, amount: 3 }, select: false })))
      .toContain('at most 2')
    expect(await db.orderLine.count({ where: { orderId: o.id } })).toBe(2)
    expect(await refusal(() => db.order.create({ data: {}, select: false }))).toContain('at least 1')
  })

  test('upsert reaches it too', async () => {
    const db = await shop()
    const o = await db.order.create({ data: { lines: { create: [{ amount: 1 }, { amount: 2 }] } } })
    expect(await refusal(() => db.orderLine.upsert({
      where: { id: 999 }, create: { orderId: o.id, amount: 3 }, update: {} })))
      .toContain('at most 2')
  })

  test('a soft-deleted child is not a child', async () => {
    const db = await createClient({ db: ':memory:', schema: `
      model Cart { id Int @id @default(autoincrement())  items Item[] @minItems(1) }
      model Item {
        id Int @id @default(autoincrement())  cartId Int
        cart Cart @relation(fields: [cartId], references: [id])
        deletedAt DateTime?
        @@softDelete
      }` })
    const c = await db.cart.create({ data: { items: { create: [{}] } }, include: { items: true } })
    expect(await refusal(() => db.item.remove({ where: { id: c.items[0].id } }))).toContain('at least 1')
  })

  test('removeMany and restore move the count in both directions', async () => {
    const db = await createClient({ db: ':memory:', schema: `
      model Cart { id Int @id @default(autoincrement())  items Item[] @minItems(1) @maxItems(2) }
      model Item {
        id Int @id @default(autoincrement())  cartId Int
        cart Cart @relation(fields: [cartId], references: [id])
        deletedAt DateTime?
        @@softDelete
      }` })
    const c = await db.cart.create({ data: { items: { create: [{}, {}] } } })
    // Taking both out at once leaves none.
    expect(await refusal(() => db.item.removeMany({ where: { cartId: c.id } })))
      .toContain('at least 1')
    // One out is fine, and putting it back is a write that moves the count the
    // other way — into a cart that is now full.
    await db.item.removeMany({ where: { id: 1 } })
    expect(await db.item.count({ where: { cartId: c.id } })).toBe(1)
    await db.item.create({ data: { cartId: c.id } })
    expect(await refusal(() => db.item.restore({ where: { id: 1 } }))).toContain('at most 2')
  })

  test('a cascade takes the parent with the children, so it is not held to its minimum', async () => {
    const db = await createClient({ db: ':memory:', schema: `
      model Order { id Int @id @default(autoincrement())  lines Line[] @minItems(1) }
      model Line {
        id Int @id @default(autoincrement())  orderId Int
        order Order @relation(fields: [orderId], references: [id], onDelete: Cascade)
      }` })
    const o = await db.order.create({ data: { lines: { create: [{}] } } })
    await db.order.delete({ where: { id: o.id } })
    expect(await db.order.count()).toBe(0)
  })

  // A missed identifier in a WHERE is silent — SQLite reads an unknown one as a
  // string literal — so a mapped column would count 0 for every parent and
  // refuse every minimum (`FJS-761`).
  test('@map on the foreign key and on the parent key both translate', async () => {
    const db = await createClient({ db: ':memory:', schema: `
      model Box { id Int @id @default(autoincrement()) @map("box_id")  things Thing[] @minItems(1) @maxItems(2) }
      model Thing {
        id Int @id @default(autoincrement())  boxId Int @map("box_ref")
        box Box @relation(fields: [boxId], references: [id])
      }` })
    expect(await refusal(() => db.box.create({ data: {} }))).toContain('at least 1')
    const b = await db.box.create({ data: { things: { create: [{}] } } })
    await db.thing.create({ data: { boxId: b.id } })
    expect(await refusal(() => db.thing.create({ data: { boxId: b.id } }))).toContain('at most 2')
    expect(await refusal(() => db.thing.deleteMany({ where: { boxId: b.id } }))).toContain('at least 1')
  })

  // A bound is a statement about the DATA, which is the line @@check and @@arc
  // sit on — not about the caller, which is what asSystem() drops.
  test('asSystem() is graded', async () => {
    const db = await shop()
    expect(await refusal(() => db.asSystem().order.create({ data: { total: 1 } }))).toContain('at least 1')
  })
})

describe('a schema that declares none', () => {
  test('writes exactly as it did before', async () => {
    const db = await createClient({ db: ':memory:', schema: `
      model Order { id Int @id @default(autoincrement())  lines Line[] }
      model Line { id Int @id @default(autoincrement())  orderId Int  order Order @relation(fields: [orderId], references: [id]) }` })
    const o = await db.order.create({ data: {} })
    await db.line.create({ data: { orderId: o.id } })
    await db.line.deleteMany({ where: { orderId: o.id } })
    expect(await db.line.count()).toBe(0)
  })
})

describe('a bound with no key to count through is refused at parse', () => {
  const errs = (src: string) => (parse(src).errors ?? []).map(e => String((e as any).message ?? e)).join('\n')

  test('a to-one relation', () => {
    expect(errs(`
      model Order { id Int @id  custId Int  cust Cust @relation(fields: [custId], references: [id]) @minItems(1) }
      model Cust { id Int @id  orders Order[] }`)).toContain('counts the rows on the MANY side')
  })

  test('an implicit many-to-many — neither table holds the key', () => {
    expect(errs(`model Post { id Int @id  tags Tag[] @maxItems(5) }\nmodel Tag { id Int @id  posts Post[] }`))
      .toContain('holds no foreign key')
  })

  // The other side of the same question: two relations to one model are
  // countable once each says WHICH, and the bound then follows the name rather
  // than the first key that happens to match.
  test('two NAMED relations to the same model resolve, and the bound counts the named one', async () => {
    const db = await createClient({ db: ':memory:', schema: `
      model User {
        id Int @id @default(autoincrement())
        sent Msg[] @relation("sent") @maxItems(1)
        got  Msg[] @relation("got")
      }
      model Msg {
        id Int @id @default(autoincrement())  fromId Int  toId Int
        from User @relation("sent", fields: [fromId], references: [id])
        to   User @relation("got",  fields: [toId],   references: [id])
      }` })
    const a = await db.user.create({ data: {} })
    const b = await db.user.create({ data: {} })
    await db.msg.create({ data: { fromId: a.id, toId: b.id } })
    // b has RECEIVED one and sent none, so the bound on `sent` says nothing
    // about it; a has sent its one and is at the maximum.
    await db.msg.create({ data: { fromId: b.id, toId: a.id } })
    expect(await refusal(() => db.msg.create({ data: { fromId: a.id, toId: b.id } })))
      .toContain('at most 1')
  })
})

// A list back-relation whose foreign key is unique holds at most one row, so
// the schema declares a one-to-many and a one-to-one at once (`FJS-1451`).
describe('a list over a unique foreign key', () => {
  const lite = (unique: string, attr = '') => `
model Lemma {
  id         Int    @id @default(autoincrement())
  strongsTag String @unique
  morphas    Morpha[]
}
model Morpha {
  id         Int    @id @default(autoincrement())
  strongsTag String ${unique}
  lemma      Lemma  @relation(fields: [strongsTag], references: [strongsTag])
  pos        String
  ${attr}
}`

  test('@unique on the key warns naming both fields', () => {
    const r = parse(lite('@unique'))
    expect(r.errors).toEqual([])
    const w = r.warnings.filter((s: string) => s.includes('Lemma.morphas'))
    expect(w.length).toBe(1)
    expect(w[0]).toContain('Morpha.strongsTag')
  })

  test('@@unique over exactly the key warns; a wider one does not', () => {
    expect(parse(lite('', '@@unique([strongsTag])')).warnings.some((s: string) => s.includes('Lemma.morphas'))).toBe(true)
    expect(parse(lite('', '@@unique([strongsTag, pos])')).warnings.some((s: string) => s.includes('Lemma.morphas'))).toBe(false)
  })

  test('a plain key does not warn', () => {
    expect(parse(lite('')).warnings.some((s: string) => s.includes('Lemma.morphas'))).toBe(false)
  })
})
