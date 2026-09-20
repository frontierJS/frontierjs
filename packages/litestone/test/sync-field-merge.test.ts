// sync-field-merge.test.ts — `@@sync(field)`: two people, one row, different
// columns, and both of them win (`FJS-D334`, `IDEAS/homestead.md` phase 5).
//
// `@@sync(refuse)` already refuses a held write whose row moved, and that is
// correct and blunt: `@version` is a counter, so it can say the row moved and
// never which columns moved. `field` is the same precondition with the answer
// kept instead of discarded — the held write carries the row as the device READ
// it, and the comparison runs here, where the gate, the row policies and the
// constraints are.
//
// **The decisive test is `two writers, different columns`.** Everything else
// here passes against a `refuse` that merely got a better error message.
//
// **The two silent failures are asserted, not reasoned about.** A conflict that
// carried `retryable: true` would be re-applied automatically by sierra's
// `isStaleWrite()` — the whole patch re-sent, the other writer's column
// overwritten, nothing said — so the flag is pinned here rather than in the
// package that reads it. And a `base` passed where nothing reads one looks
// exactly like a merge that found no conflict, so it is refused by name.

import { describe, it, expect } from 'bun:test'
import { createClient }         from '../src/core/client.js'
import { parse }                from '../src/core/parser.js'

const SCHEMA = `
model Doc {
  id      Int     @id
  title   String
  body    String
  locked  String? @encrypted
  version Int     @version
  @@sync(field)
}
model Plain {
  id      Int    @id
  title   String
  version Int    @version
  @@sync(refuse)
}
`

const KEY = 'a'.repeat(64)
const open = () => createClient({ schema: SCHEMA, db: ':memory:', encryptionKey: KEY })

/** The row as one writer read it, and the write they made from it. */
const held = (row: any, data: any) => ({ base: row, data: { ...data, version: row.version } })

describe('@@sync(field) — the merge', () => {
  it('lets two writers who touched different columns both win', async () => {
    const db  = await open()
    const doc = await db.doc.create({ data: { id: 1, title: 'draft', body: 'one' } })

    // Both people read the same row. One is offline.
    const mine = held(doc, { body: 'two' })

    // The other saves first, over the network, touching a different column.
    await db.doc.update({ where: { id: 1 }, data: { title: 'final', version: doc.version } })

    // Now the held write drains. It was made against a revision that has moved.
    const merged = await db.doc.update({ where: { id: 1 }, ...mine })

    expect(merged.title).toBe('final')   // theirs survived
    expect(merged.body).toBe('two')      // and so did mine
    await db.$close()
  })

  it('refuses when both writers moved the same column, and names it', async () => {
    const db  = await open()
    const doc = await db.doc.create({ data: { id: 1, title: 'draft', body: 'one' } })
    const mine = held(doc, { body: 'mine' })
    await db.doc.update({ where: { id: 1 }, data: { body: 'theirs', version: doc.version } })

    const err: any = await db.doc.update({ where: { id: 1 }, ...mine }).catch(e => e)
    expect(err.name).toBe('SyncConflictError')
    expect(err.conflicts).toEqual([{ column: 'body', base: 'one', local: 'mine', remote: 'theirs' }])
    expect((await db.doc.findUnique({ where: { id: 1 } })).body).toBe('theirs')  // nothing written
    await db.$close()
  })

  it('is NOT a stale write — a retry would be the data loss', async () => {
    const db  = await open()
    const doc = await db.doc.create({ data: { id: 1, title: 'draft', body: 'one' } })
    const mine = held(doc, { body: 'mine' })
    await db.doc.update({ where: { id: 1 }, data: { body: 'theirs', version: doc.version } })

    const err: any = await db.doc.update({ where: { id: 1 }, ...mine }).catch(e => e)
    // sierra's isStaleWrite() is `409 && retryable`, and re-applying this patch
    // would overwrite the other writer's column with nothing said.
    expect(err.status).toBe(409)
    expect(err.retryable).toBe(false)
    expect(err.name).not.toBe('VersionConflictError')
    await db.$close()
  })

  it('treats the same value from both writers as agreed, not as a conflict', async () => {
    const db  = await open()
    const doc = await db.doc.create({ data: { id: 1, title: 'draft', body: 'one' } })
    const mine = held(doc, { body: 'same' })
    await db.doc.update({ where: { id: 1 }, data: { body: 'same', version: doc.version } })

    const merged = await db.doc.update({ where: { id: 1 }, ...mine })
    expect(merged.body).toBe('same')
    await db.$close()
  })

  it('does not clobber a column the form carried but nobody edited', async () => {
    const db  = await open()
    const doc = await db.doc.create({ data: { id: 1, title: 'draft', body: 'one' } })
    // A form submits every field it holds, edited or not.
    const mine = held(doc, { title: 'draft', body: 'two' })
    await db.doc.update({ where: { id: 1 }, data: { title: 'theirs', version: doc.version } })

    const merged = await db.doc.update({ where: { id: 1 }, ...mine })
    expect(merged.title).toBe('theirs')
    await db.$close()
  })

  it('refuses to merge a column whose stored form is an encoding', async () => {
    // Ciphertext re-encrypts to different bytes each time, so comparing it
    // against the value the writer read reports a conflict on every write that
    // names the column — including one nobody else touched.
    const db  = await open()
    const doc = await db.doc.create({ data: { id: 1, title: 't', body: 'b', locked: 'was' } })
    const err: any = await db.doc
      .update({ where: { id: 1 }, base: doc, data: { locked: 'mine', version: doc.version } })
      .catch(e => e)
    expect(String(err.message)).toContain('cannot compare')
    expect(String(err.message)).toContain('locked')
    await db.$close()
  })

  it('costs nothing when the row did not move', async () => {
    const db  = await open()
    const doc = await db.doc.create({ data: { id: 1, title: 'draft', body: 'one' } })
    const merged = await db.doc.update({ where: { id: 1 }, ...held(doc, { body: 'two' }) })
    expect(merged.body).toBe('two')
    expect(merged.version).toBe(doc.version + 1)
    await db.$close()
  })
})

describe('@@sync(field) — what is refused', () => {
  it('refuses a base on a model that does not declare field', async () => {
    const db  = await open()
    await db.plain.create({ data: { id: 1, title: 'a' } })
    const err: any = await db.plain
      .update({ where: { id: 1 }, data: { title: 'b', version: 1 }, base: { title: 'a' } })
      .catch(e => e)
    expect(String(err.message)).toContain('only @@sync(field) reads one')
    expect(String(err.message)).toContain('@@sync(refuse)')
    await db.$close()
  })

  it('refuses @@sync(field) on a model with no @version, at parse', () => {
    const r = parse('model M {\n  id Int @id\n  name String\n  @@sync(field)\n}')
    expect(r.valid).toBe(false)
    expect(String(r.errors[0])).toContain('@@sync(field) needs an @version field')
  })
})
