// `@@index([deletedAt])` beside `@@softDelete` (FJS-480).
//
// `@@softDelete` builds its own partial index over the column and both derive
// the same name — `idx_<table>_deletedAt`. Before the refusal the schema
// validated, the DDL was emitted, and the run died inside SQLite on
// `index idx_note_deletedAt already exists`: an error naming a physical index,
// about a declaration two attributes away, on a schema nothing had objected to.
//
// Refused rather than deduped at emit, because the declaration buys nothing
// either way — a declared index on a soft-delete table is already given the
// `WHERE "deletedAt" IS NULL` clause, so it compiled to exactly the index
// `@@softDelete` was about to write. What a dedupe would preserve is the
// ability to write a line with no effect, and `litestone introspect` would go
// on generating it.
//
// Single-column only. `@@index([deletedAt, status])` derives a different name
// and is an ordinary composite index that happens to lead with the column.

import { describe, it, expect } from 'bun:test'
import { createClient, parse } from '../src/index.js'

const MODEL = (attrs: string) => `
model Note {
  id        Int       @id @default(autoincrement())
  body      String
  status    String
  deletedAt DateTime?
${attrs}
}
`

describe('@@index([deletedAt]) on a soft-delete model', () => {
  it('refuses at parse, naming both attributes and the way out', async () => {
    const p = createClient({ db: ':memory:', schema: MODEL('  @@index([deletedAt])\n  @@softDelete') })
    await expect(p).rejects.toThrow(/@@index\(\[deletedAt\]\) duplicates the index @@softDelete already builds/)
    await expect(p).rejects.toThrow(/Remove the @@index/)
  })

  it('is a parse error, not a runtime one — the schema never reaches SQLite', () => {
    const parsed = parse(MODEL('  @@index([deletedAt])\n  @@softDelete'))
    expect(parsed.valid).toBe(false)
    expect(parsed.errors.join('\n')).toMatch(/idx_<table>_deletedAt/)
  })

  it('allows the composite that leads with the column', async () => {
    const db: any = await createClient({
      db: ':memory:',
      schema: MODEL('  @@index([deletedAt, status])\n  @@softDelete'),
    })
    const sys = db.asSystem()
    await sys.note.create({ data: { body: 'a', status: 'open' } })
    expect(await sys.note.count()).toBe(1)
  })

  it('allows @@index([deletedAt]) where the model does not soft-delete', async () => {
    // Nothing else emits that name, so the column is an ordinary indexable one.
    const db: any = await createClient({ db: ':memory:', schema: MODEL('  @@index([deletedAt])') })
    const sys = db.asSystem()
    await sys.note.create({ data: { body: 'a', status: 'open' } })
    expect(await sys.note.count()).toBe(1)
  })
})
