// A lone `Int @id` emits AUTOINCREMENT (FJS-D887, FJS-2432), so a hard-deleted
// highest id is never handed to the next create and a permalink never changes
// meaning. Asserted by running a create/delete/create, not by reading the DDL.

import { describe, it, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'
import { createClient } from '../src/core/client.js'
import { Database } from 'bun:sqlite'
import { join } from 'path'
import { tempDir } from '../src/tmp-dirs.js'
import { buildPristine, introspect, diffSchemas, summarizeDiff } from '../src/core/migrate.js'
import { autoMigrate } from '../src/core/migrations.js'

const ddl = (src: string) => generateDDL(parse(src).schema)

describe('Int @id never reuses a deleted id', () => {
  for (const [label, src] of [
    ['a bare `Int @id`',            `model M { id Int @id  x String }`],
    ['`@default(autoincrement())`', `model M { id Int @id @default(autoincrement())  x String }`],
  ] as [string, string][]) {
    it(`${label}: delete the highest, the next create takes a new id`, async () => {
      const db = await createClient({ schema: src, db: ':memory:' })
      try {
        const a = await db.m.create({ data: { x: 'a' } })
        await db.m.delete({ where: { id: a.id } })
        const b = await db.m.create({ data: { x: 'b' } })
        expect(b.id).toBeGreaterThan(a.id)
      } finally { await db.$close() }
    })
    it(`${label}: emits INTEGER PRIMARY KEY AUTOINCREMENT`, () => {
      expect(ddl(src)).toContain('PRIMARY KEY AUTOINCREMENT')
    })
  }

  it('a composite key and a String @id take no AUTOINCREMENT', () => {
    expect(ddl(`model M { a Int  b Int  @@id([a, b]) }`)).not.toContain('AUTOINCREMENT')
    expect(ddl(`model M { id String @id @default(uuid()) }`)).not.toContain('AUTOINCREMENT')
  })
})

// A table created before the ruling has no AUTOINCREMENT, and nothing else
// about it differs. The differ has to read the keyword or that table is
// "in sync" forever and only the residue tripwire says otherwise.
describe('a table created before FJS-D887 gains AUTOINCREMENT', () => {
  const SRC = `model M { id Int @id  x String }`
  const BEFORE = `CREATE TABLE "m" ("id" INTEGER NOT NULL PRIMARY KEY, "x" TEXT NOT NULL) STRICT`

  it('the diff names it as a rebuild, and the same table declared is no change', () => {
    const parsed = parse(SRC)
    const dir = tempDir('litestone-autoinc-')
    const pris = new Database(join(dir, 'pristine.db'))
    buildPristine(pris, parsed)
    const grade = (stmt: string) => {
      const live = new Database(join(dir, `live-${Math.random()}.db`))
      live.run(stmt)
      return diffSchemas(introspect(pris), introspect(live), parsed, 'main', {})
    }

    const old = grade(BEFORE)
    expect(old.residue).toEqual([])
    expect(old.tableDiffs).toHaveLength(1)
    expect(old.tableDiffs[0].autoincrementChanged).toBe(true)
    expect(old.tableDiffs[0].needsRebuild).toBe(true)
    expect(summarizeDiff(old)).toContain('AUTOINCREMENT changed')

    const now = grade(BEFORE.replace('PRIMARY KEY', 'PRIMARY KEY AUTOINCREMENT'))
    expect(now.hasChanges).toBe(false)
    expect(now.residue).toEqual([])
  })

  it('autoMigrate rebuilds it, keeps the rows, and the highest id is not reused after', async () => {
    const path = join(tempDir('litestone-autoinc-'), 'app.db')
    const raw = new Database(path)
    raw.run(BEFORE)
    raw.run(`INSERT INTO "m" ("id", "x") VALUES (1, 'a'), (7, 'b')`)
    raw.close()

    const db = await createClient({ schema: SRC, db: path })
    try {
      expect(autoMigrate(db).main.state).toBe('migrated')
      expect(db.$db.query(`SELECT sql FROM sqlite_master WHERE name = 'm'`).get().sql).toContain('AUTOINCREMENT')
      expect((await db.m.findMany({ orderBy: { id: 'asc' } })).map(r => r.x)).toEqual(['a', 'b'])

      await db.m.delete({ where: { id: 7 } })
      const c = await db.m.create({ data: { x: 'c' } })
      expect(c.id).toBeGreaterThan(7)

      expect(autoMigrate(db, undefined, { force: true }).main.residue).toBeUndefined()
    } finally { await db.$close() }
  })
})
