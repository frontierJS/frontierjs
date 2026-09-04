// ─── @immutable on a sealing model ────────────────────────────────────────────
//
// Phase 4, and the only part of this feature that changes a SHIPPED behavior.
//
// `@immutable` means *written once, at create*. On a model that declares a
// `@seals` move it means *frozen at the seal* instead — because a document is
// built before it is issued, and freezing at create is what forced the domain to
// write invoices whole with no draft at all (`IDEAS/billing.md`, phase 1).
//
// It is scoped by DECLARATION: a model with no `@seals` move is untouched, and
// that pairing is what the last describe here exists to hold.

import { test, expect, describe, beforeEach } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
enum DocState { draft issued paid void }

model Invoice {
  id     Int      @id
  state  DocState @default(draft)
  number String   @immutable
  total  Int      @immutable
  memo   String?
  @@transitions(state,
    issue:  draft  -> issued @seals,
    settle: issued -> paid,
    void:   issued -> void)
}

model Plain {
  id   Int    @id
  code String @immutable
  memo String?
}
`

let db: any
beforeEach(async () => {
  db = await createClient({ schema: SCHEMA, db: ':memory:' })
  await db.invoice.create({ data: { id: 1, number: 'A1', total: 100 } })
  await db.plain.create({ data: { id: 1, code: 'X' } })
})

const refusal = async (fn: () => Promise<any>) => {
  try { await fn(); return null } catch (e: any) { return e }
}

describe('before the seal, a frozen column is an ordinary one', () => {
  test('a single frozen column is writable', async () => {
    const r = await db.invoice.update({ where: { id: 1 }, data: { number: 'A9' } })
    expect(r.number).toBe('A9')
  })

  test('so are several at once', async () => {
    const r = await db.invoice.update({ where: { id: 1 }, data: { number: 'B1', total: 250 } })
    expect([r.number, r.total]).toEqual(['B1', 250])
  })

  test('updateMany reaches them too', async () => {
    expect((await db.invoice.updateMany({ where: { id: 1 }, data: { total: 7 } })).count).toBe(1)
  })

  test('and so does upsert', async () => {
    const r = await db.invoice.upsert({
      where: { id: 1 }, create: { id: 1, number: 'Z', total: 1 }, update: { number: 'Z9' } })
    expect(r.number).toBe('Z9')
  })
})

describe('after the seal it is frozen, by every path', () => {
  beforeEach(async () => { await db.invoice.transition(1, 'issue') })

  test('update is refused, naming the column', async () => {
    const e = await refusal(() => db.invoice.update({ where: { id: 1 }, data: { number: 'C1' } }))
    expect(e?.name).toBe('SealedDocumentError')
    expect(e.fields).toEqual(['number'])
    expect(e.message).toContain("it is at 'issued', which is sealed")
  })

  test('several columns are named together', async () => {
    const e = await refusal(() => db.invoice.update({ where: { id: 1 }, data: { number: 'C1', total: 9 } }))
    expect(e.fields.sort()).toEqual(['number', 'total'])
    expect(e.message).toContain('those columns are @immutable')
  })

  test('updateMany writes nothing and says so in the count', async () => {
    expect((await db.invoice.updateMany({ where: { id: 1 }, data: { total: 7 } })).count).toBe(0)
    expect((await db.invoice.findUnique({ where: { id: 1 } })).total).toBe(100)
  })

  test('upsert is refused rather than taking its ON CONFLICT fast path', async () => {
    const e = await refusal(() => db.invoice.upsert({
      where: { id: 1 }, create: { id: 1, number: 'Z', total: 1 }, update: { number: 'Z9' } }))
    expect(e?.name).toBe('SealedDocumentError')
  })

  test('asSystem() does not lift it', async () => {
    const e = await refusal(() => db.asSystem().invoice.update({ where: { id: 1 }, data: { number: 'D1' } }))
    expect(e?.name).toBe('SealedDocumentError')
  })

  test('an ordinary column is still writable — the freeze is per column', async () => {
    const r = await db.invoice.update({ where: { id: 1 }, data: { memo: 'later' } })
    expect(r.memo).toBe('later')
  })

  // The guard narrows only where the payload names a frozen column. Narrowing
  // every update on the model would refuse this move, which the machine declares
  // out of a state the seal itself put the row in.
  test('a declared move out of a sealed state still runs', async () => {
    expect((await db.invoice.transition(1, 'settle')).state).toBe('paid')
  })

  test('and the row stays frozen in the state that move led to', async () => {
    await db.invoice.transition(1, 'settle')
    const e = await refusal(() => db.invoice.update({ where: { id: 1 }, data: { number: 'E1' } }))
    expect(e?.state).toBe('paid')
  })
})

describe('a model that declares no seal keeps the shipped meaning', () => {
  // Written once, at CREATE — refused by name off the payload, with no read of
  // the row at all. The pairing is the point: the change above is scoped by a
  // declaration, so an app that has not made one sees nothing.
  test('the refusal is still a ValidationError naming the field', async () => {
    const e = await refusal(() => db.plain.update({ where: { id: 1 }, data: { code: 'Y' } }))
    expect(e?.name).toBe('ValidationError')
    expect(e.message).toContain('written once, when the row was created')
  })

  test('and it fires whether or not the value differs', async () => {
    const e = await refusal(() => db.plain.update({ where: { id: 1 }, data: { code: 'X' } }))
    expect(e?.name).toBe('ValidationError')
  })
})
