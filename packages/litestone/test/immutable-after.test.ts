// ─── @immutable(after: <move>) ────────────────────────────────────────────────
//
// FJS-1512 / FJS-D568. A sealing model has one freeze instant, the seal, so a
// signature written by the accept, after the terms were sealed at approve, had
// no word. `@immutable(after: accept)` is writable until the accept's target and
// frozen from there and from every state reachable from it.

import { test, expect, describe, beforeEach } from 'bun:test'
import { createClient, parse } from '../src/index.js'

const SCHEMA = `
enum OfferState { draft approved sent accepted declined void }

model Offer {
  id         Int        @id
  status     OfferState @default(draft)
  terms      String     @immutable
  signedName String?    @immutable(after: accept)
  @@transitions(status,
    approve: draft    -> approved @seals,
    send:    approved -> sent,
    accept:  sent     -> accepted,
    decline: sent     -> declined,
    retire:  accepted -> void)
}

model Plain {
  id     Int        @id
  status OfferState @default(draft)
  note   String?    @immutable(after: send)
  @@transitions(status,
    send:   draft -> sent,
    accept: sent  -> accepted)
}
`

let db: any
beforeEach(async () => {
  db = await createClient({ schema: SCHEMA, db: ':memory:' })
  await db.offer.create({ data: { id: 1, terms: 'T' } })
  await db.plain.create({ data: { id: 1 } })
})

const refusal = async (fn: () => Promise<any>) => {
  try { await fn(); return null } catch (e: any) { return e }
}
const move = (status: string, extra: object = {}) => db.offer.update({ where: { id: 1 }, data: { status, ...extra } })

describe('writable until the named move, frozen from it', () => {
  test('past the seal and before the move, the column is still writable', async () => {
    await move('approved')
    await move('sent')
    const r = await db.offer.update({ where: { id: 1 }, data: { signedName: 'Ada' } })
    expect(r.signedName).toBe('Ada')
  })

  test('the move itself may carry the column', async () => {
    await move('approved'); await move('sent')
    const r = await move('accepted', { signedName: 'Ada' })
    expect([r.status, r.signedName]).toEqual(['accepted', 'Ada'])
  })

  test('after the move it is refused as a sealed document, not a policy', async () => {
    await move('approved'); await move('sent'); await move('accepted', { signedName: 'Ada' })
    const e = await refusal(() => db.offer.update({ where: { id: 1 }, data: { signedName: 'Somebody Else' } }))
    expect(e?.name).toBe('SealedDocumentError')
    expect(e.fields).toEqual(['signedName'])
    expect((await db.offer.findFirst({ where: { id: 1 } })).signedName).toBe('Ada')
  })

  test('asSystem() does not lift it', async () => {
    await move('approved'); await move('sent'); await move('accepted', { signedName: 'Ada' })
    const e = await refusal(() => db.asSystem().offer.update({ where: { id: 1 }, data: { signedName: 'Mallory' } }))
    expect(e?.name).toBe('SealedDocumentError')
  })

  test('so is every state reachable from the move', async () => {
    await move('approved'); await move('sent'); await move('accepted', { signedName: 'Ada' })
    await move('void')
    const e = await refusal(() => db.offer.update({ where: { id: 1 }, data: { signedName: 'Mallory' } }))
    expect(e?.name).toBe('SealedDocumentError')
  })

  test('a state the move does not reach stays writable', async () => {
    await move('approved'); await move('sent')
    await move('declined')
    const r = await db.offer.update({ where: { id: 1 }, data: { signedName: 'Ada' } })
    expect(r.signedName).toBe('Ada')
  })

  test('updateMany writes nothing and says so in the count', async () => {
    await move('approved'); await move('sent'); await move('accepted', { signedName: 'Ada' })
    expect((await db.offer.updateMany({ where: { id: 1 }, data: { signedName: 'Mallory' } })).count).toBe(0)
    expect((await db.offer.findFirst({ where: { id: 1 } })).signedName).toBe('Ada')
  })

  test('a write that does not name the column goes on', async () => {
    await move('approved'); await move('sent'); await move('accepted', { signedName: 'Ada' })
    const r = await move('void')
    expect(r.status).toBe('void')
  })
})

describe('the seal keeps its own meaning for bare @immutable', () => {
  test('terms freeze at approve, not at accept', async () => {
    await move('approved')
    const e = await refusal(() => db.offer.update({ where: { id: 1 }, data: { terms: 'Changed' } }))
    expect(e?.name).toBe('SealedDocumentError')
  })
})

describe('on a model that does not seal', () => {
  test('the column freezes from the move and is free before it', async () => {
    const r = await db.plain.update({ where: { id: 1 }, data: { note: 'a' } })
    expect(r.note).toBe('a')
    await db.plain.update({ where: { id: 1 }, data: { status: 'sent' } })
    const e = await refusal(() => db.plain.update({ where: { id: 1 }, data: { note: 'b' } }))
    expect(e?.name).toBe('SealedDocumentError')
  })
})

describe('parse', () => {
  const wrap = (field: string) => `
enum S { a b }
model M {
  id Int @id
  s  S @default(a)
  x  String? ${field}
  @@transitions(s, go: a -> b)
}`
  const errors = (field: string) => parse(wrap(field)).errors.join('\n')
  test('a move the model does not have is refused by name', () => {
    expect(errors('@immutable(after: nope)')).toMatch(/no move 'nope'.*go/s)
  })
  test('an argument other than after is refused', () => {
    expect(errors('@immutable(before: go)')).toMatch(/after: <move>/)
  })
  test('a real move parses', () => {
    expect(parse(wrap('@immutable(after: go)')).valid).toBe(true)
  })
})
