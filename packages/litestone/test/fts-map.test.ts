// An `@@fts` over a field with `@map` (FJS-1467). External-content FTS5 reads
// the source table by the FTS table's own column names, so those must be the
// source's COLUMN names — field names failed every read and every rebuild
// with `no such column: T.<field>`.

import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { parse } from '../src/core/parser.js'
import {
  introspect, buildPristine, diffSchemas, generateMigrationSQL, splitStatements,
} from '../src/core/migrate.js'

function migrate(live: Database, source: string) {
  const parsed   = parse(source)
  const pristine = buildPristine(new Database(':memory:'), parsed)
  const sql      = generateMigrationSQL(diffSchemas(pristine, introspect(live), parsed), parsed)
  for (const st of splitStatements(sql)) live.run(st)
}

const BEFORE = `model Note {\n  id Int @id\n  body String @map("body_text")\n}`
const AFTER  = `model Note {\n  id Int @id\n  body String @map("body_text")\n  @@fts([body])\n}`

describe('@@fts over a @map field', () => {
  it('reads the index back on a fresh database', () => {
    const db = new Database(':memory:')
    migrate(db, AFTER)
    db.run(`INSERT INTO note (id, body_text) VALUES (1, 'hello world')`)
    expect(db.query(`SELECT body_text FROM note_fts WHERE note_fts MATCH 'hello'`).all())
      .toEqual([{ body_text: 'hello world' }])
    db.run(`INSERT INTO note_fts(note_fts) VALUES('integrity-check')`)
  })

  it('rebuilds when added to a table that holds rows', () => {
    const db = new Database(':memory:')
    migrate(db, BEFORE)
    db.run(`INSERT INTO note (id, body_text) VALUES (1, 'hello world')`)
    migrate(db, AFTER)
    expect(db.query(`SELECT rowid AS id FROM note_fts WHERE note_fts MATCH 'hello'`).all())
      .toEqual([{ id: 1 }])
  })
})
