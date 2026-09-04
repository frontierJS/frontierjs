#!/usr/bin/env bun
// keep-relation.test.ts — @keep, the third fate a child can have.
//
// When a @@softDelete parent is removed, a child was reachable in two states and
// only two: stamped with the parent (@@softDelete(cascade)) or physically
// destroyed (@hardDelete on the relation field). The third — the child STAYS
// LIVE, deliberately — could be produced but not SAID: it is what a plain
// @@softDelete already does, and the parser warns about it because forgetting
// the cascade looks exactly the same.
//
// A financial record outliving the person it names is that shape. `example`'s
// Customer/Order pair is where it turned up: Order.customerId is onDelete
// Cascade, so removing a customer took every order they had ever placed, and
// cascading the soft delete instead only made the orders invisible rather than
// gone. Neither is what a shop means.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'path'

import { parse }        from '../src/core/parser.js'
import { generateDDL }  from '../src/core/ddl.js'
import { splitStatements } from '../src/core/migrate.js'
import { createClient } from '../src/core/client.js'
import { tempDir }      from '../src/tmp-dirs.js'

const TMP = tempDir('litestone-keep-')

async function makeDb(schemaText: string, name: string) {
  const path   = join(TMP, `${name}${Math.random().toString(36).slice(2)}.db`)
  const result = parse(schemaText)
  if (!result.valid) throw new Error(result.errors.join('\n'))
  const raw = new Database(path)
  for (const stmt of splitStatements(generateDDL(result.schema)))
    if (!stmt.startsWith('PRAGMA')) raw.run(stmt)
  raw.close()
  return createClient({ parsed: result, db: path })
}

// ─── the warning ──────────────────────────────────────────────────────────────

describe('@keep — parse and the footgun warning', () => {
  const parent = (fieldLine: string, attr = '@@softDelete') => `
    model Customer {
      id        Int  @id
      name      String
      ${fieldLine}
      deletedAt DateTime?
      ${attr}
    }
    model Order {
      id         Int @id
      customerId Int
      customer   Customer @relation(fields: [customerId], references: [id])
      total      Int
      deletedAt  DateTime?
      @@softDelete
    }
  `

  test('a plain @@softDelete parent still warns about the live children', () => {
    const r = parse(parent('orders Order[]'))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w: string) => w.includes('Customer') && w.includes('Order'))).toBe(true)
  })

  test('@keep silences it', () => {
    const r = parse(parent('orders Order[] @keep'))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w: string) => w.includes('Customer') && w.includes('Order'))).toBe(false)
  })

  test('the warning names all three ways out, so the third is discoverable', () => {
    const w = parse(parent('orders Order[]')).warnings.find((x: string) => x.includes('Customer'))!
    expect(w).toContain('@@softDelete(cascade)')
    expect(w).toContain('@hardDelete')
    expect(w).toContain('@keep')
  })

  test('the attribute reaches the parsed field', () => {
    const r = parse(parent('orders Order[] @keep'))
    const f = r.schema.models.find((m: any) => m.name === 'Customer')!
                             .fields.find((x: any) => x.name === 'orders')!
    expect(f.attributes.some((a: any) => a.kind === 'keep')).toBe(true)
  })
})

// ─── the behavior ────────────────────────────────────────────────────────────
//
// The warning is the half a schema author sees; this is the half that has to be
// true for the word to mean anything. A parent declaring (cascade) with @keep on
// ONE relation must cascade into the others and leave that one alone.

const SHOP = `
  model Customer {
    id        Int  @id
    name      String
    orders    Order[]   @keep
    notes     Note[]
    deletedAt DateTime?
    @@softDelete(cascade)
  }
  model Order {
    id         Int @id
    customerId Int
    customer   Customer @relation(fields: [customerId], references: [id])
    lines      Line[]
    total      Int
    deletedAt  DateTime?
    @@softDelete(cascade)
  }
  model Line {
    id        Int @id
    orderId   Int
    order     Order @relation(fields: [orderId], references: [id])
    sku       String
    deletedAt DateTime?
    @@softDelete
  }
  model Note {
    id         Int @id
    customerId Int
    customer   Customer @relation(fields: [customerId], references: [id])
    body       String
    deletedAt  DateTime?
    @@softDelete
  }
`

describe('@keep — what happens to the rows', () => {
  let db: any
  beforeAll(async () => { db = await makeDb(SHOP, 'keep-shop') })
  afterAll(() => db.$close())

  beforeEach(async () => {
    for (const t of ['line', 'note', 'order', 'customer'])
      await db[t].deleteMany({ where: {}, withDeleted: true })
    await db.customer.create({ data: { id: 1, name: 'Ada' } })
    await db.order.create({ data: { id: 10, customerId: 1, total: 99 } })
    await db.line.create({ data: { id: 100, orderId: 10, sku: 'TEE-M' } })
    await db.note.create({ data: { id: 200, customerId: 1, body: 'prefers email' } })
  })

  test('the parent goes', async () => {
    await db.customer.remove({ where: { id: 1 } })
    expect(await db.customer.count()).toBe(0)
    expect(await db.customer.count({ withDeleted: true })).toBe(1)
  })

  test('a @keep child stays LIVE — not stamped, not destroyed', async () => {
    await db.customer.remove({ where: { id: 1 } })
    const order = await db.order.findUnique({ where: { id: 10 } })
    expect(order).not.toBe(null)
    expect(order.deletedAt).toBe(null)
  })

  test('the subtree below a @keep child stays live too', async () => {
    // A kept child is not a door into the subtree — if the order survives, what
    // it was made of has to survive with it or the receipt is half a receipt.
    await db.customer.remove({ where: { id: 1 } })
    expect(await db.line.count()).toBe(1)
  })

  test('a sibling relation with no @keep still cascades', async () => {
    await db.customer.remove({ where: { id: 1 } })
    expect(await db.note.count()).toBe(0)
    expect(await db.note.count({ withDeleted: true })).toBe(1)
  })

  test('restore brings the sibling back and leaves the kept child alone', async () => {
    await db.customer.remove({ where: { id: 1 } })
    await db.customer.restore({ where: { id: 1 } })
    expect(await db.customer.count()).toBe(1)
    expect(await db.note.count()).toBe(1)
    expect(await db.order.count()).toBe(1)
  })

  test('removeMany honors it the same way', async () => {
    await db.customer.removeMany({ where: { id: 1 } })
    expect(await db.order.count()).toBe(1)
    expect(await db.note.count()).toBe(0)
  })

  test('the kept child can still be removed on its own', async () => {
    // @keep is about what the PARENT'S removal does. It is not a lock.
    await db.order.remove({ where: { id: 10 } })
    expect(await db.order.count()).toBe(0)
    expect(await db.line.count()).toBe(0)
  })
})
