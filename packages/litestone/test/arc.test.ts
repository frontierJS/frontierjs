// @@arc — exclusive foreign keys, exactly one set.
//
// The feature exists because the alternative for "this row points at an Order OR
// a Product" is a polymorphic (typeName, id) pair, which keeps no foreign key, no
// cascade and no include, and which the database cannot refuse a dangling one of.
// So the assertions that matter here are not that the CHECK is emitted — it is
// that the relations stay ORDINARY: a real FK, a real cascade, and a refusal that
// survives asSystem().
import { describe, it, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'
import { createClient } from '../src/index.js'
import { deriveReleaseSurface, classifyPivot } from '../src/release.js'

const BASE = `
model Order   { id Int @id @default(autoincrement())  attachments Attachment[] }
model Product { id Int @id @default(autoincrement())  attachments Attachment[] }
`

const attachment = (arc: string) => `${BASE}
model Attachment {
  id        Int      @id @default(autoincrement())
  label     String
  orderId   Int?
  order     Order?   @relation(fields: [orderId],   references: [id], onDelete: Cascade)
  productId Int?
  product   Product? @relation(fields: [productId], references: [id], onDelete: Cascade)
  ${arc}
}`

const errorsOf = (src: string) =>
  (parse(src).errors ?? []).map((e: any) => e.message ?? String(e))

describe('@@arc — parse', () => {
  it('accepts an arc over two optional relation keys', () => {
    const r = parse(attachment('@@arc([orderId, productId])'))
    expect(r.errors ?? []).toEqual([])
    expect(r.warnings ?? []).toEqual([])
    const attr = r.schema.models.find((m: any) => m.name === 'Attachment')
      .attributes.find((a: any) => a.kind === 'arc')
    expect(attr.fields).toEqual(['orderId', 'productId'])
    expect(attr.optional).toBe(false)
  })

  it('carries optional: true and a message', () => {
    const r = parse(attachment('@@arc([orderId, productId], optional: true, message: "pick one or none")'))
    expect(r.errors ?? []).toEqual([])
    const attr = r.schema.models.find((m: any) => m.name === 'Attachment')
      .attributes.find((a: any) => a.kind === 'arc')
    expect(attr.optional).toBe(true)
    expect(attr.message).toBe('pick one or none')
  })

  it('refuses a REQUIRED member — one that is always set is always the answer', () => {
    const src = `${BASE}
model Attachment {
  id        Int  @id
  orderId   Int
  productId Int?
  @@arc([orderId, productId])
}`
    const msg = errorsOf(src).find(e => e.includes('@@arc'))
    expect(msg).toContain("'orderId' is required")
    expect(msg).toContain('Make it optional')
  })

  it('refuses a single member — an arc of one is nothing to choose between', () => {
    const src = `${BASE}
model Attachment {
  id      Int  @id
  orderId Int?
  @@arc([orderId])
}`
    expect(errorsOf(src).find(e => e.includes('@@arc'))).toContain('at least two members')
  })

  it('refuses a repeated member', () => {
    const src = `${BASE}
model Attachment {
  id        Int  @id
  orderId   Int?
  productId Int?
  @@arc([orderId, orderId, productId])
}`
    expect(errorsOf(src).find(e => e.includes('@@arc'))).toContain("names 'orderId' more than once")
  })

  it('reports an unknown member ONCE — the generic field-ref check owns it', () => {
    const src = `${BASE}
model Attachment {
  id      Int  @id
  orderId Int?
  @@arc([orderId, prodctId])
}`
    // A second message from the arc's own validation would be noise, and the
    // required-member test must not also fire for a column that is not there.
    const about = errorsOf(src).filter(e => e.includes('prodctId'))
    expect(about).toHaveLength(1)
    expect(about[0]).toContain('references unknown field')
  })

  it('refuses an unknown argument by name', () => {
    // parse() catches a ParseError into `errors` rather than throwing, so the
    // schema comes back null and the sentence names both spellings that work.
    const r = parse(attachment('@@arc([orderId, productId], exclusive: true)'))
    expect(r.schema).toBeNull()
    expect(errorsOf(attachment('@@arc([orderId, productId], exclusive: true)'))[0])
      .toContain("unknown argument 'exclusive' — expected 'optional' or 'message'")
  })
})

describe('@@arc — DDL', () => {
  it('counts the non-null members and compares to one', () => {
    const ddl = String(generateDDL(parse(attachment('@@arc([orderId, productId])')).schema))
    expect(ddl).toContain('CHECK ((("orderId" IS NOT NULL) + ("productId" IS NOT NULL)) = 1)')
  })

  it('optional: true relaxes the comparison rather than dropping the constraint', () => {
    const ddl = String(generateDDL(parse(attachment('@@arc([orderId, productId], optional: true)')).schema))
    expect(ddl).toContain('CHECK ((("orderId" IS NOT NULL) + ("productId" IS NOT NULL)) <= 1)')
  })

  it('leaves the foreign keys alone — the whole point is that they stay ordinary', () => {
    const ddl = String(generateDDL(parse(attachment('@@arc([orderId, productId])')).schema))
    expect(ddl).toContain('FOREIGN KEY ("orderId") REFERENCES "order" ("id") ON DELETE CASCADE')
    expect(ddl).toContain('FOREIGN KEY ("productId") REFERENCES "product" ("id") ON DELETE CASCADE')
  })
})

describe('@@arc — against a real database', () => {
  const open = async (arc: string) => {
    const db = await createClient({ schema: attachment(arc), db: ':memory:' })
    const order   = await db.order.create({ data: {} })
    const product = await db.product.create({ data: {} })
    return { db, order, product }
  }

  it('accepts exactly one member and refuses both or neither', async () => {
    const { db, order, product } = await open('@@arc([orderId, productId])')

    await db.attachment.create({ data: { label: 'a', orderId:   order.id } })
    await db.attachment.create({ data: { label: 'b', productId: product.id } })
    expect(await db.attachment.count()).toBe(2)

    expect(db.attachment.create({ data: { label: 'c', orderId: order.id, productId: product.id } }))
      .rejects.toThrow()
    expect(db.attachment.create({ data: { label: 'd' } })).rejects.toThrow()
    expect(await db.attachment.count()).toBe(2)
  })

  it('refuses an UPDATE that walks a good row into a bad state', async () => {
    const { db, order, product } = await open('@@arc([orderId, productId])')
    const row = await db.attachment.create({ data: { label: 'a', orderId: order.id } })
    expect(db.attachment.update({ where: { id: row.id }, data: { productId: product.id } }))
      .rejects.toThrow()
  })

  it('holds under asSystem(), which drops the gate and every row policy', async () => {
    // The reason to declare a rule here rather than in a service hook: a CHECK is
    // in the table, so it survives the bypass, a migration, a seed and an atomic
    // operator alike.
    const { db, order, product } = await open('@@arc([orderId, productId])')
    expect(db.asSystem().attachment.create({
      data: { label: 'x', orderId: order.id, productId: product.id },
    })).rejects.toThrow()
  })

  it('keeps the cascade a polymorphic pair could not have', async () => {
    const { db, order } = await open('@@arc([orderId, productId])')
    await db.attachment.create({ data: { label: 'a', orderId: order.id } })
    await db.order.delete({ where: { id: order.id } })
    expect(await db.attachment.count()).toBe(0)
  })

  it('optional: true admits a row pointing at nothing, and still refuses both', async () => {
    const { db, order, product } = await open('@@arc([orderId, productId], optional: true)')
    await db.attachment.create({ data: { label: 'none' } })
    expect(await db.attachment.count()).toBe(1)
    expect(db.attachment.create({ data: { label: 'both', orderId: order.id, productId: product.id } }))
      .rejects.toThrow()
  })
})

describe('@@arc — what a violation says', () => {
  // A constraint whose refusal reads "this record is not valid" is half a
  // feature: the person cannot act on it. Same argument as `FJS-534` made for
  // `@check` one attribute earlier.
  const violate = async (arc: string) => {
    const db = await createClient({ schema: attachment(arc), db: ':memory:' })
    const order   = await db.order.create({ data: {} })
    const product = await db.product.create({ data: {} })
    try {
      await db.attachment.create({ data: { label: 'x', orderId: order.id, productId: product.id } })
      throw new Error('expected a refusal')
    } catch (e: any) { return e }
  }

  it('names the columns in the choice by default', async () => {
    const err = await violate('@@arc([orderId, productId])')
    expect(err.errors?.[0]?.message).toBe('exactly one of orderId, productId must be set')
    // Empty path: a rule spanning columns marks no single box, which is the
    // form-level shape `VersionConflictError` already takes.
    expect(err.errors?.[0]?.path).toEqual([])
  })

  it('says at MOST one when the arc is optional', async () => {
    const err = await violate('@@arc([orderId, productId], optional: true)')
    expect(err.errors?.[0]?.message).toBe('at most one of orderId, productId may be set')
  })

  it("prefers the author's own sentence", async () => {
    const err = await violate('@@arc([orderId, productId], message: "attach to an order or a product, not both")')
    expect(err.errors?.[0]?.message).toBe('attach to an order or a product, not both')
  })

  it('keeps the SQL for the developer and off the person', async () => {
    const err = await violate('@@arc([orderId, productId])')
    expect(err.constraint).toContain('IS NOT NULL')
    expect(err.errors?.[0]?.message).not.toContain('IS NOT NULL')
  })
})

describe('@@arc — the deploy question', () => {
  it('adding one is a CONTRACT, because N-1 has been making writes it now refuses', () => {
    // The gap this pins: `describeModel` collected `kind === 'check'` only, so an
    // arc was invisible to the surface and adding one graded as an expand — a
    // deploy that cannot be taken back, reported as one that can.
    const before = deriveReleaseSurface(parse(attachment('')).schema)
    const after  = deriveReleaseSurface(parse(attachment('@@arc([orderId, productId])')).schema)
    const v      = classifyPivot(before, after)

    expect(v.verdict).toBe('contract')
    // Named by the SQL it compiles to rather than by the word the author wrote:
    // the emitted expression is the constraint's identity, which is what makes an
    // edited member list a different constraint rather than the same one moved.
    expect(v.findings[0].detail).toContain('IS NOT NULL')
    expect(v.findings[0].subject).toContain('Attachment')
  })

  it('removing one is not — a release that stops refusing is one N-1 can still serve', () => {
    const before = deriveReleaseSurface(parse(attachment('@@arc([orderId, productId])')).schema)
    const after  = deriveReleaseSurface(parse(attachment('')).schema)
    expect(classifyPivot(before, after).verdict).not.toBe('contract')
  })
})
