// `@updatedAt` — the timestamp SQLite moves for you.
//
// The stamp is an AFTER UPDATE trigger rather than a client-side write, so it
// holds for a direct SQL statement and a migration as well as for `update()`.
// What decides that a field gets one is the ATTRIBUTE. It used to be the field
// NAME (`f.name === 'updatedAt' && f.type.name === 'DateTime'`), which was wrong
// in both directions — decorative wherever the two agreed and a silent no-op
// wherever they did not, so a second stamp column compiled, read as though it
// worked and never moved (`FJS-394`).
//
// The failure is invisible by construction: the column exists, `@updatedAt`
// implies a DEFAULT so every row carries a plausible timestamp on insert, and a
// screen ordering by *recently changed* is simply wrong with nothing to see.
//
// The name match stays as a FALLBACK, because a schema relying on it would
// otherwise lose its trigger on upgrade — a silent data-freshness regression is
// exactly what this fix exists to stop.
//
// What the trigger cannot do is reach the row a write RETURNS: RETURNING is
// evaluated before an AFTER trigger runs, so the caller's copy holds the old
// value and a re-read holds the new one (`FJS-396`, open). The last case here
// pins that so the day it changes is a red test rather than a surprise.

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'
import { parse } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'

const SCHEMA = `
model Doc {
  id        Int      @id
  title     String
  updatedAt DateTime @updatedAt
  touched   DateTime @updatedAt
  plain     DateTime @default(now())
}

model Ticket {
  id        Int      @id
  title     String
  changedAt DateTime @updatedAt
}

model Legacy {
  id        Int      @id
  title     String
  updatedAt DateTime
}

model Filed {
  id        Int       @id
  title     String
  updatedAt DateTime  @updatedAt
  touched   DateTime  @updatedAt
  deletedAt DateTime?
  @@softDelete
}
`

const ddl = () => generateDDL(parse(SCHEMA).schema)

// The trigger fires AFTER the statement, so the moved value is only visible to
// a read that follows it.
const settle = () => new Promise(r => setTimeout(r, 5))

describe('@updatedAt — the attribute decides', () => {
  it('stamps a field that is not called updatedAt', async () => {
    const db  = await createClient({ schema: SCHEMA, db: ':memory:' })
    const row = await db.doc.create({ data: { title: 'a' } })
    await settle()
    await db.doc.update({ where: { id: row.id }, data: { title: 'b' } })

    const after = await db.doc.findUnique({ where: { id: row.id } })
    expect(after.touched).not.toBe(row.touched)
    expect(after.updatedAt).not.toBe(row.updatedAt)
  })

  it('leaves a plain @default(now()) alone', async () => {
    const db  = await createClient({ schema: SCHEMA, db: ':memory:' })
    const row = await db.doc.create({ data: { title: 'a' } })
    await settle()
    await db.doc.update({ where: { id: row.id }, data: { title: 'b' } })

    const after = await db.doc.findUnique({ where: { id: row.id } })
    expect(after.plain).toBe(row.plain)
  })

  it('stamps a model whose only stamp column carries another name', async () => {
    const db  = await createClient({ schema: SCHEMA, db: ':memory:' })
    const row = await db.ticket.create({ data: { title: 'a' } })
    await settle()
    await db.ticket.update({ where: { id: row.id }, data: { title: 'b' } })

    const after = await db.ticket.findUnique({ where: { id: row.id } })
    expect(after.changedAt).not.toBe(row.changedAt)
  })

  it('keeps stamping a field named updatedAt that declares nothing', async () => {
    const db  = await createClient({ schema: SCHEMA, db: ':memory:' })
    const row = await db.legacy.create({ data: { title: 'a', updatedAt: new Date() } })
    await settle()
    await db.legacy.update({ where: { id: row.id }, data: { title: 'b' } })

    const after = await db.legacy.findUnique({ where: { id: row.id } })
    expect(after.updatedAt).not.toBe(row.updatedAt)
  })

  it('does not overwrite a value the write named', async () => {
    const db    = await createClient({ schema: SCHEMA, db: ':memory:' })
    const row   = await db.doc.create({ data: { title: 'a' } })
    const stamp = '2020-01-01T00:00:00.000Z'
    await db.doc.update({ where: { id: row.id }, data: { touched: new Date(stamp) } })

    const after = await db.doc.findUnique({ where: { id: row.id } })
    expect(after.touched).toBe(stamp)
  })
})

describe('@updatedAt — the emitted DDL', () => {
  it('stamps every declaring field from one trigger per table', () => {
    const sql = ddl()
    // One trigger, named for the table — a sibling trigger re-enters this one
    // and speaks for a column it does not own.
    expect(sql.match(/CREATE TRIGGER IF NOT EXISTS "doc_updatedAt"/g)).toHaveLength(1)
    expect(sql).toContain('SET "touched" =')
    expect(sql).toContain('SET "updatedAt" =')
    expect(sql).toContain('"ticket_updatedAt"')
    expect(sql).toContain('SET "changedAt" =')
  })

  it('leaves the one-column body every existing database carries unchanged', () => {
    // A changed body migrates a trigger that does the same thing, on every app.
    expect(ddl()).toContain(
      `UPDATE "ticket" SET "changedAt" = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = NEW.rowid;`)
    expect(ddl()).toContain('"legacy_updatedAt"')
  })

  it('emits nothing for an @@external model, and the client stamps nothing either', async () => {
    // generateDDL skips an external table, so there is no trigger to install —
    // and a client stamp with no trigger behind it is a silent write into a
    // table litestone does not own.
    const SRC = `
      model Ledger {
        id        Int      @id
        title     String
        updatedAt DateTime @updatedAt
        @@external
      }
    `
    expect(generateDDL(parse(SRC).schema)).not.toContain('CREATE TRIGGER')

    const db = await createClient({ schema: SRC, db: ':memory:' })
    await db.asSystem().sql`CREATE TABLE ledger (id INTEGER PRIMARY KEY, title TEXT, updatedAt TEXT)`
    const row = await db.ledger.create({ data: { id: 1, title: 'a', updatedAt: new Date('2020-01-01') } })
    await db.ledger.update({ where: { id: row.id }, data: { title: 'b' } })

    const after = await db.ledger.findUnique({ where: { id: row.id } })
    expect(after.updatedAt).toBe('2020-01-01T00:00:00.000Z')
  })

  it('emits no trigger for a model that declares none', () => {
    const sql = generateDDL(parse(`
      model Note {
        id    Int      @id
        title String
        seen  DateTime @default(now())
      }
    `).schema)
    expect(sql).not.toContain('CREATE TRIGGER')
  })
})

describe('@updatedAt — the row a write hands back (FJS-396)', () => {
  // SQLite evaluates RETURNING before an AFTER trigger fires, so a write that
  // leaned on the trigger answered the OLD timestamp while the row in the
  // database already held the new one. The client names the column in its own
  // SET clause now; the trigger stays for raw SQL and migrations.
  // remove/restore need a model that soft-deletes — a hard delete leaves no row
  // to stamp.
  const verbs = {
    doc: {
      async update(db, row) {
        return db.doc.update({ where: { id: row.id }, data: { title: 'b' } })
      },
      async upsert(db, row) {
        return db.doc.upsert({ where: { id: row.id }, create: { id: row.id, title: 'c' }, update: { title: 'c' } })
      },
    },
    filed: {
      async remove(db, row) {
        return db.filed.remove({ where: { id: row.id } })
      },
      // restore() answers the rows, not one row — `where` can match many.
      async restore(db, row) {
        await db.filed.remove({ where: { id: row.id } })
        await settle()
        return (await db.filed.restore({ where: { id: row.id } }))[0]
      },
    },
  }

  for (const [accessor, group] of Object.entries(verbs)) {
    for (const [verb, run] of Object.entries(group)) {
      it(`${verb}() answers the row that is in the database`, async () => {
        const db  = await createClient({ schema: SCHEMA, db: ':memory:' })
        const row = await db[accessor].create({ data: { title: 'a' } })
        await settle()

        const returned = await run(db, row)
        const reread   = await db[accessor].findUnique({ where: { id: row.id }, withDeleted: true })

        expect(returned.touched).not.toBe(row.touched)
        expect(returned.touched).toBe(reread.touched)
        expect(returned.updatedAt).toBe(reread.updatedAt)
      })
    }
  }

  it('leaves a stamp the write named alone', async () => {
    const db    = await createClient({ schema: SCHEMA, db: ':memory:' })
    const row   = await db.doc.create({ data: { title: 'a' } })
    const stamp = '2020-01-01T00:00:00.000Z'
    await settle()

    const returned = await db.doc.update({ where: { id: row.id }, data: { touched: new Date(stamp) } })
    expect(returned.touched).toBe(stamp)
    // The sibling still moves — the write said nothing about it.
    expect(returned.updatedAt).not.toBe(row.updatedAt)
  })

  it('writes nothing, and moves nothing, for a payload with no columns left', async () => {
    const db  = await createClient({ schema: SCHEMA, db: ':memory:' })
    const row = await db.doc.create({ data: { title: 'a' } })
    await settle()

    const returned = await db.doc.update({ where: { id: row.id }, data: { notAColumn: 1 } })
    expect(returned.touched).toBe(row.touched)
    expect(returned.updatedAt).toBe(row.updatedAt)
  })

  it('moves the stamp on a bulk update, and the rows it announces carry it', async () => {
    const db = await createClient({ schema: SCHEMA, db: ':memory:' })
    const a  = await db.doc.create({ data: { title: 'a' } })
    const b  = await db.doc.create({ data: { title: 'b' } })
    await settle()

    await db.doc.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { title: 'z' } })
    for (const before of [a, b]) {
      const after = await db.doc.findUnique({ where: { id: before.id } })
      expect(after.touched).not.toBe(before.touched)
      expect(after.updatedAt).not.toBe(before.updatedAt)
    }
  })

  it('still stamps a raw SQL write, which never comes through the client', async () => {
    const db  = await createClient({ schema: SCHEMA, db: ':memory:' })
    const row = await db.doc.create({ data: { title: 'a' } })
    await settle()

    await db.asSystem().sql`UPDATE doc SET title = 'b' WHERE id = ${row.id}`
    const after = await db.doc.findUnique({ where: { id: row.id } })
    expect(after.touched).not.toBe(row.touched)
    expect(after.updatedAt).not.toBe(row.updatedAt)
  })
})
