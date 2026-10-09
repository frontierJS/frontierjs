// A transform rebuilds each table it touches, and the copy keeps the
// constraints the schema declared: inline UNIQUE, a compound @@unique and STRICT
// (FJS-2133). generateDDL emits UNIQUE inside the CREATE TABLE, so no
// sqlite_master index carries it over.

import { describe, test, expect, beforeAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join, resolve } from 'path'
import { writeFileSync } from 'fs'
import { parse } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'
import { splitStatements } from '../src/core/migrate.js'
import { execute } from '../src/transform/framework.js'
import { run } from '../src/transform/runner.js'
import { tempDir } from '../src/tmp-dirs.js'

const TMP       = tempDir('litestone-transform-constraints-')
const FRAMEWORK = resolve(import.meta.dir, '../src/transform/framework.js')

const SCHEMA = `
  model Member {
    id    Int    @id
    email String @unique
    org   String
    slug  String
    name  String
    @@unique([org, slug])
  }
`
const schemaPath = join(TMP, 'schema.lite')
const dbPath     = join(TMP, 'source.db')

beforeAll(() => {
  writeFileSync(schemaPath, SCHEMA)
  const r = parse(SCHEMA)
  if (!r.valid) throw new Error(r.errors.join('\n'))
  const db = new Database(dbPath)
  for (const s of splitStatements(generateDDL(r.schema))) if (!s.startsWith('PRAGMA')) db.run(s)
  db.run(`INSERT INTO member (id, email, org, slug, name) VALUES (1, 'a@x.test', 'o', 's1', 'Ann'), (2, 'b@x.test', 'o', 's2', 'Bo')`)
  db.close()
})

async function transformed(name: string, pipeline: string) {
  const out = join(TMP, `${name}.db`)
  const cfg = join(TMP, `${name}.js`)
  writeFileSync(cfg,
    `import { $ } from '${FRAMEWORK}'\n` +
    `export const db = '${dbPath}'\n` +
    `export const pipeline = [${pipeline}]\n`)
  await execute(cfg, { verbose: false, outputPath: out, schemaPath }, run)
  return new Database(out)
}

describe('a rebuilt table keeps what the schema declared', () => {
  for (const [name, pipeline] of [
    ['mask',   `$.member.mask('name', 'hash')`],
    ['set',    `$.member.set('note', () => 'x')`],
  ] as const) {
    test(`${name}: STRICT, inline UNIQUE and compound UNIQUE survive`, async () => {
      const db = await transformed(name, pipeline)
      const tbl = db.query(`SELECT strict FROM pragma_table_list('member')`).get() as any
      expect(tbl.strict).toBe(1)
      expect(() => db.run(`INSERT INTO member (id, email, org, slug, name) VALUES (3, 'a@x.test', 'p', 'z', 'C')`)).toThrow(/UNIQUE/)
      expect(() => db.run(`INSERT INTO member (id, email, org, slug, name) VALUES (3, 'c@x.test', 'o', 's1', 'C')`)).toThrow(/UNIQUE/)
      expect(() => db.run(`INSERT INTO member (id, email, org, slug, name) VALUES (3, 'c@x.test', 'o', 's3', x'00')`)).toThrow()
      db.close()
    })
  }
})
