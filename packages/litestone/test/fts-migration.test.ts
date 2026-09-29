// An `@@fts` index through a migration, on a table that already exists (FJS-1463).
//
// `introspect()` hid every `*_fts*` table, so neither side of the diff could
// see an index missing or different. Adding `@@fts` to a model that holds rows
// emitted its three triggers and no FTS5 table: the migration applied, verify
// said in sync, and every write to the model then failed with
// `no such table: main.<model>_fts`. Changing the indexed columns rewrote the
// triggers against the OLD table, and changing `tokenize:` emitted nothing.
//
// Creating the table is half of it. External-content FTS5 indexes only what a
// trigger hands it, so an index created over existing rows answers nothing for
// them, and the first UPDATE of one issues a 'delete' for a docid the index
// never held — `database disk image is malformed`.

import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { parse } from '../src/core/parser.js'
import {
  introspect, buildPristine, diffSchemas, generateMigrationSQL, splitStatements,
} from '../src/core/migrate.js'

function plan(live: Database, source: string) {
  const parsed   = parse(source)
  const pristine = buildPristine(new Database(':memory:'), parsed)
  const diff     = diffSchemas(pristine, introspect(live), parsed)
  return { diff, sql: generateMigrationSQL(diff, parsed) }
}

/** Apply a generated migration the way the runner does — abort on first error. */
function migrate(live: Database, source: string) {
  const { sql } = plan(live, source)
  for (const st of splitStatements(sql)) live.run(st)
  return sql
}

const match = (db: Database, table: string, q: string) =>
  db.query(`SELECT rowid AS id FROM "${table}_fts" WHERE "${table}_fts" MATCH ? ORDER BY rowid`)
    .all(q).map((r: any) => r.id)

describe('@@fts added to a table that holds rows', () => {
  const BEFORE = `model Note {\n  id Int @id\n  body String\n}`
  const AFTER  = `model Note {\n  id Int @id\n  body String\n  @@fts([body])\n}`

  function seeded() {
    const db = new Database(':memory:')
    migrate(db, BEFORE)
    db.run(`INSERT INTO note (id, body) VALUES (1, 'hello world'), (2, 'goodbye')`)
    return db
  }

  it('creates the table and indexes the rows already there', () => {
    const db  = seeded()
    const sql = migrate(db, AFTER)
    expect(sql).toContain('CREATE VIRTUAL TABLE')
    expect(sql).toContain(`INSERT INTO "note_fts"("note_fts") VALUES('rebuild')`)
    expect(match(db, 'note', 'hello')).toEqual([1])
  })

  it('leaves the model writable — insert, update of an existing row, delete', () => {
    const db = seeded()
    migrate(db, AFTER)
    db.run(`INSERT INTO note (id, body) VALUES (3, 'hello again')`)
    db.run(`UPDATE note SET body = 'farewell' WHERE id = 1`)
    db.run(`DELETE FROM note WHERE id = 2`)
    expect(match(db, 'note', 'hello')).toEqual([3])
    expect(match(db, 'note', 'farewell')).toEqual([1])
    db.run(`INSERT INTO note_fts(note_fts) VALUES('integrity-check')`)
  })

  it('is in sync once applied', () => {
    const db = seeded()
    migrate(db, AFTER)
    expect(plan(db, AFTER).diff.hasChanges).toBe(false)
  })
})

describe('an existing @@fts that changes', () => {
  const V1 = `model Note {\n  id Int @id\n  title String @default("")\n  body String\n  @@fts([body])\n}`

  it('gains a column — the index is rebuilt with it, and writes still work', () => {
    const db = new Database(':memory:')
    migrate(db, V1)
    db.run(`INSERT INTO note (id, title, body) VALUES (1, 'alpha', 'hello')`)

    const V2 = V1.replace('@@fts([body])', '@@fts([body, title])')
    migrate(db, V2)
    db.run(`INSERT INTO note (id, title, body) VALUES (2, 'beta', 'world')`)
    expect(match(db, 'note', 'alpha')).toEqual([1])
    expect(match(db, 'note', 'beta')).toEqual([2])
    expect(plan(db, V2).diff.hasChanges).toBe(false)
  })

  it('changes tokenizer — the table is recreated with the new one', () => {
    const db = new Database(':memory:')
    migrate(db, V1)
    db.run(`INSERT INTO note (id, title, body) VALUES (1, '', 'running')`)

    const V2 = V1.replace('@@fts([body])', '@@fts([body], tokenize: porter)')
    migrate(db, V2)
    const { sql } = db.query(`SELECT sql FROM sqlite_master WHERE name = 'note_fts'`).get() as any
    expect(sql).toContain('porter')
    expect(match(db, 'note', 'run')).toEqual([1])
    expect(plan(db, V2).diff.hasChanges).toBe(false)
  })

  it('is removed — the index goes with its triggers', () => {
    const db = new Database(':memory:')
    migrate(db, V1)
    migrate(db, V1.replace('  @@fts([body])\n', ''))
    const left = db.query(`SELECT name FROM sqlite_master WHERE name LIKE 'note_fts%'`).all()
    expect(left).toEqual([])
  })
})

describe('a rebuilt table under @@fts', () => {
  // A String id leaves `rowid` unaliased, and the rebuild's INSERT … SELECT does
  // not copy it: the rows are renumbered, and an index keyed on the old rowids
  // points every docid at a different row.
  it('re-indexes, because the copy renumbers the rowids', () => {
    const V1 = `model Note {\n  id String @id\n  body String\n  legacy String?\n  @@fts([body])\n}`
    const db = new Database(':memory:')
    migrate(db, V1)
    db.run(`INSERT INTO note (id, body) VALUES ('a', 'first'), ('b', 'second'), ('c', 'third')`)
    db.run(`DELETE FROM note WHERE id = 'a'`)

    const V2 = V1.replace('  legacy String?\n', '')
    expect(migrate(db, V2)).toContain('rebuild "note"')
    const hit = db.query(`SELECT n.id FROM note_fts f JOIN note n ON n.rowid = f.rowid WHERE note_fts MATCH 'third'`).all()
    expect(hit).toEqual([{ id: 'c' }])
    db.run(`UPDATE note SET body = 'changed' WHERE id = 'b'`)
    db.run(`INSERT INTO note_fts(note_fts) VALUES('integrity-check')`)
  })
})
