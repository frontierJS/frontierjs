// `@@unique` over a NULLABLE column (FJS-437).
//
// Two NULLs never compare equal, so SQLite's UNIQUE index admits
// `(1, NULL, NULL)` twice. The constraint holds exactly where nobody doubted
// it and fails exactly where a caller relies on it — measured before the fix:
// two identical creates both succeeded and the model held two rows, while the
// same pair with values was refused.
//
// The refusal is composite-only, and that asymmetry is the substance. On one
// optional column `@unique` has a single reading — unique when present — and
// every SQL developer already holds it. On a tuple the reading is the tuple.
//
// `nullsDistinct: true` is SQL's own word for what SQLite does, so the opt-in
// states the behaviour rather than inventing an escape hatch.

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const VARIANT = (opts = '') => `
model Variant {
  id        Int     @id @default(autoincrement())
  productId Int
  colour    String?
  size      String?
  @@unique([productId, colour, size]${opts})
}
`

describe('@@unique over a nullable column', () => {
  it('refuses at parse, naming every nullable member', async () => {
    const p = createClient({ db: ':memory:', schema: VARIANT() })
    await expect(p).rejects.toThrow(/'colour', 'size' are optional/)
    await expect(p).rejects.toThrow(/two NULLs never compare equal/)
  })

  it('offers both answers', async () => {
    try {
      await createClient({ db: ':memory:', schema: VARIANT() })
      throw new Error('should have refused')
    } catch (e: any) {
      expect(e.message).toMatch(/required with a @default/)
      expect(e.message).toMatch(/nullsDistinct: true/)
    }
  })

  it('is satisfied by a default, and then the constraint actually fires', async () => {
    const db: any = await createClient({ db: ':memory:', schema: `
model Variant {
  id        Int    @id @default(autoincrement())
  productId Int
  colour    String @default("Default")
  size      String @default("One")
  @@unique([productId, colour, size])
}
` })
    const sys = db.asSystem()
    await sys.variant.create({ data: { productId: 1 } })
    await expect(sys.variant.create({ data: { productId: 1 } })).rejects.toThrow()
    expect(await sys.variant.count()).toBe(1)
  })

  it('nullsDistinct: true declares the shape and keeps the index', async () => {
    const db: any = await createClient({ db: ':memory:', schema: VARIANT(', nullsDistinct: true') })
    const sys = db.asSystem()
    // The declared half: rows leaving a member unset are not constrained.
    await sys.variant.create({ data: { productId: 1 } })
    await sys.variant.create({ data: { productId: 1 } })
    expect(await sys.variant.count()).toBe(2)
    // The index is still there for the rows that fill the tuple.
    await sys.variant.create({ data: { productId: 2, colour: 'red', size: 'S' } })
    await expect(sys.variant.create({ data: { productId: 2, colour: 'red', size: 'S' } }))
      .rejects.toThrow()
  })

  it('leaves a single-column @unique over an optional column alone', async () => {
    const db: any = await createClient({ db: ':memory:', schema: `
model Product {
  id      Int     @id @default(autoincrement())
  barcode String? @unique
}
` })
    const sys = db.asSystem()
    await sys.product.create({ data: {} })
    await sys.product.create({ data: {} })          // two absent barcodes do not collide
    await sys.product.create({ data: { barcode: 'X' } })
    await expect(sys.product.create({ data: { barcode: 'X' } })).rejects.toThrow()
    expect(await sys.product.count()).toBe(3)
  })

  it('says nothing about a composite whose members are all required', async () => {
    const db: any = await createClient({ db: ':memory:', schema: `
model Slot {
  id     Int    @id @default(autoincrement())
  roomId Int
  day    String
  @@unique([roomId, day])
}
` })
    expect(await db.asSystem().slot.count()).toBe(0)
  })

  it('refuses an unknown argument, and a non-boolean', async () => {
    await expect(createClient({ db: ':memory:', schema: VARIANT(', nullsFirst: true') }))
      .rejects.toThrow(/unknown argument 'nullsFirst'/)
    await expect(createClient({ db: ':memory:', schema: VARIANT(', nullsDistinct: yes') }))
      .rejects.toThrow(/expected true or false/)
  })
})
