// ─── @sealed — the write guard ────────────────────────────────────────────────
//
// Phase 2/3 of FJS-D162's answer. `@seals` on a move says the row became a
// document; `@sealed` on a relation says which children it is made of. After the
// seal those children may not be created, changed or removed.
//
// EVERY refusal here is paired with the same call against a DRAFT parent, and
// that pairing is the test rather than decoration (`FJS-351`): a guard that
// refuses everything and a guard that is correct look identical from the refused
// side, and a `@@gate`, a row policy or a typo in the where would all produce the
// same throw.
//
// The other half is that the guard is a PREDICATE. It rides the WHERE, so a
// refused write is zero rows changed — which already means five other things —
// and the sentence comes from a follow-up read that runs only on that path.

import { test, expect, describe, beforeEach } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
enum DocState { draft issued paid void }

model Invoice {
  id       Int      @id
  state    DocState @default(draft)
  number   String   @immutable
  lines    InvoiceLine[] @sealed
  payments Payment[]
  @@transitions(state,
    issue:  draft  -> issued @seals,
    settle: issued -> paid,
    void:   issued -> void)
}

model InvoiceLine {
  id          Int      @id
  invoice     Invoice  @relation(fields: [invoiceId], references: [id], onDelete: Cascade)
  invoiceId   Int
  note        Note?    @relation(fields: [noteId], references: [id])
  noteId      Int?
  amount      Int
}

model Payment {
  id        Int     @id
  invoice   Invoice @relation(fields: [invoiceId], references: [id], onDelete: Cascade)
  invoiceId Int
  amount    Int
}

model Note {
  id    Int    @id
  body  String
}
`

let db: any
// 1 is the document — issued, therefore sealed. 2 stays draft and is the
// control every refusal below is measured against.
const SEALED = 1
const DRAFT  = 2

beforeEach(async () => {
  db = await createClient({ schema: SCHEMA, db: ':memory:' })
  await db.invoice.create({ data: { id: SEALED, number: 'A1' } })
  await db.invoice.create({ data: { id: DRAFT,  number: 'A2' } })
  await db.invoiceLine.create({ data: { id: 100, invoiceId: SEALED, amount: 10 } })
  await db.invoiceLine.create({ data: { id: 200, invoiceId: DRAFT,  amount: 10 } })
  await db.invoice.transition(SEALED, 'issue')
})

const refusal = async (fn: () => Promise<any>) => {
  try { await fn(); return null }
  catch (e: any) { return e }
}

describe('every write path is guarded, and each is paired with the draft it must allow', () => {
  const cases: Array<[string, (inv: number, line: number) => Promise<any>]> = [
    ['create',     (inv)       => db.invoiceLine.create({ data: { invoiceId: inv, amount: 1 } })],
    ['create select:false',
                   (inv)       => db.invoiceLine.create({ data: { invoiceId: inv, amount: 1 }, select: false })],
    ['createMany', (inv)       => db.invoiceLine.createMany({ data: [{ invoiceId: inv, amount: 1 }] })],
    ['update',     (_i, line)  => db.invoiceLine.update({ where: { id: line }, data: { amount: 99 } })],
    ['delete',     (_i, line)  => db.invoiceLine.delete({ where: { id: line } })],
    ['remove',     (_i, line)  => db.invoiceLine.remove({ where: { id: line } })],
    ['upsert (new)',
                   (inv)       => db.invoiceLine.upsert({ where: { id: 900 + inv }, create: { id: 900 + inv, invoiceId: inv, amount: 1 }, update: { amount: 1 } })],
    ['upsert (existing)',
                   (_i, line)  => db.invoiceLine.upsert({ where: { id: line }, create: { id: line, invoiceId: 1, amount: 1 }, update: { amount: 77 } })],
    ['upsertMany', (inv)       => db.invoiceLine.upsertMany({ data: [{ id: 800 + inv, invoiceId: inv, amount: 1 }], conflictTarget: ['id'] })],
  ]

  for (const [name, run] of cases) {
    test(`${name} — refused on a sealed document`, async () => {
      const e = await refusal(() => run(SEALED, 100))
      expect(e?.name).toBe('SealedDocumentError')
      expect(e.status).toBe(409)
      expect(e.retryable).toBe(false)
    })

    test(`${name} — allowed on a draft one`, async () => {
      const e = await refusal(() => run(DRAFT, 200))
      expect(e).toBeNull()
    })
  }
})

describe('what the guard must not reach', () => {
  test('a relation the parent did not mark keeps taking rows', async () => {
    // The case the feature exists to permit. A payment against an issued
    // invoice is exactly the row that must keep arriving, which is why @sealed
    // is declared per relation and never inferred from the model.
    const p = await db.payment.create({ data: { invoiceId: SEALED, amount: 500 } })
    expect(p.amount).toBe(500)
  })

  test('a second, still-draft document of the same model is untouched', async () => {
    const l = await db.invoiceLine.create({ data: { invoiceId: DRAFT, amount: 3 } })
    expect(l.invoiceId).toBe(DRAFT)
  })

  test('an optional relation left null has no document to be sealed by', async () => {
    // The guard binds the foreign key, and NULL matches no parent — so NOT
    // EXISTS holds. An optional relation keeps working without being cased.
    const l = await db.invoiceLine.create({ data: { invoiceId: DRAFT, amount: 3, noteId: null } })
    expect(l.noteId).toBeNull()
  })

  test('the parent itself still moves through the rest of its machine', async () => {
    const paid = await db.invoice.transition(SEALED, 'settle')
    expect(paid.state).toBe('paid')
  })

  test('every state reachable from the seal is sealed, not just the one it lands on', async () => {
    // `void` is two hops from `draft` and nothing declares it sealed. The
    // closure is what makes it so, and a one-hop walk passes every other
    // assertion in this file.
    await db.invoice.create({ data: { id: 3, number: 'A3' } })
    await db.invoice.transition(3, 'issue')
    await db.invoice.transition(3, 'void')
    const e = await refusal(() => db.invoiceLine.create({ data: { invoiceId: 3, amount: 1 } }))
    expect(e?.name).toBe('SealedDocumentError')
    expect(e.state).toBe('void')
  })
})

describe('asSystem() does not lift it', () => {
  // The ruling: a seal is the @immutable tier — a statement about what the row
  // IS — where the gate, the row policies and @guarded are statements about who
  // is asking. `@@transitions` IS lifted by asSystem(), so getting this backwards
  // would be entirely plausible and would make the document editable by every job.
  test('a system client is refused exactly as a caller is', async () => {
    const e = await refusal(() => db.asSystem().invoiceLine.create({ data: { invoiceId: SEALED, amount: 1 } }))
    expect(e?.name).toBe('SealedDocumentError')
  })

  test('and still writes freely to a draft one', async () => {
    const l = await db.asSystem().invoiceLine.create({ data: { invoiceId: DRAFT, amount: 1 } })
    expect(l.amount).toBe(1)
  })
})

describe('the refusal is a sentence, not a count', () => {
  test('it names the document, the row, the state and the relation', async () => {
    const e = await refusal(() => db.invoiceLine.create({ data: { invoiceId: SEALED, amount: 1 } }))
    expect(e.data).toEqual({
      model: 'InvoiceLine', parent: 'Invoice', parentId: SEALED, state: 'issued', relation: 'lines',
    })
  })

  test('the operation is in the wording, because add and change read differently', async () => {
    const create = await refusal(() => db.invoiceLine.create({ data: { invoiceId: SEALED, amount: 1 } }))
    const update = await refusal(() => db.invoiceLine.update({ where: { id: 100 }, data: { amount: 1 } }))
    expect(create.message).toContain('add an InvoiceLine to Invoice')
    expect(update.message).toContain('update an InvoiceLine of Invoice')
    expect(create.message).toContain('correct it with a new row beside it')
  })

  test('a write that matched nothing for an ORDINARY reason is not blamed on the seal', async () => {
    // The guard rides the WHERE, so it produces the same zero rows a missing row
    // does. Reporting the seal for every empty update would be a confident wrong
    // answer on the commonest failure there is.
    const e = await refusal(() => db.invoiceLine.update({ where: { id: 99999 }, data: { amount: 1 } }))
    expect(e).toBeNull()
  })

  test('a row of an unsealed document that simply is not there is likewise not blamed', async () => {
    const r = await db.invoiceLine.update({ where: { id: 12345 }, data: { amount: 1 } })
    expect(r).toBeNull()
  })
})

describe('a bulk write filters, it does not throw', () => {
  // updateMany/deleteMany already skip the transition check and already let a row
  // policy narrow them silently. The guard follows that contract rather than
  // inventing a per-row diagnosis for a method whose answer is a count — and the
  // direction it fails in is the safe one: the rows are not written.
  test('updateMany writes nothing to a sealed document and says so in the count', async () => {
    const r = await db.invoiceLine.updateMany({ where: { invoiceId: SEALED }, data: { amount: 42 } })
    expect(r.count).toBe(0)
    expect((await db.invoiceLine.findUnique({ where: { id: 100 } })).amount).toBe(10)
  })

  test('deleteMany likewise, and the rows are still there', async () => {
    const r = await db.invoiceLine.deleteMany({ where: { invoiceId: SEALED } })
    expect(r.count).toBe(0)
    expect(await db.invoiceLine.count({ where: { invoiceId: SEALED } })).toBe(1)
  })

  test('the same calls against a draft document do the work', async () => {
    expect((await db.invoiceLine.updateMany({ where: { invoiceId: DRAFT }, data: { amount: 42 } })).count).toBe(1)
    expect((await db.invoiceLine.deleteMany({ where: { invoiceId: DRAFT } })).count).toBe(1)
  })
})

describe('a model nothing seals pays nothing', () => {
  test('its inserts are still VALUES, not SELECT … WHERE', async () => {
    // The guard turns an INSERT into `INSERT … SELECT … WHERE`, which is a
    // different plan. A model with no sealed parent must not take it.
    const seen: string[] = []
    const plain = await createClient({
      schema: `model Widget { id Int @id  name String }`,
      db: ':memory:',
      onQuery: (e: any) => { seen.push(e.sql) },
    })
    await plain.widget.create({ data: { name: 'w' } })
    expect(seen.some(s => s.includes('VALUES'))).toBe(true)
    expect(seen.some(s => s.includes('SELECT ? WHERE') || s.includes('NOT EXISTS'))).toBe(false)
  })
})
