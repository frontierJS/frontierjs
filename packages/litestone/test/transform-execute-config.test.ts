// execute() takes a config as a path to a module or as the module's own shape.
// Studio builds its pipeline in memory and has no file to point at, so a path
// there is imported as a config and the pipeline is never read (FJS-2064).

import { describe, test, expect, beforeAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'path'
import { writeFileSync } from 'fs'
import { parse } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'
import { splitStatements } from '../src/core/migrate.js'
import { $, execute } from '../src/transform/framework.js'
import { run } from '../src/transform/runner.js'
import { tempDir } from '../src/tmp-dirs.js'

const TMP = tempDir('litestone-transform-execute-config-')

const SCHEMA = `
  model Member {
    id   Int    @id
    name String
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
  db.run(`INSERT INTO member (id, name) VALUES (1, 'Ann'), (2, 'Bo'), (3, 'Cy')`)
  db.close()
})

describe('execute takes a config object', () => {
  test('its pipeline runs against its db', async () => {
    const out = join(TMP, 'object.db')
    await execute({ db: dbPath, pipeline: [$.member.limit(2)] }, { verbose: false, outputPath: out, schemaPath }, run)
    const db = new Database(out)
    expect(db.query(`SELECT COUNT(*) AS n FROM member`).get()).toEqual({ n: 2 })
    db.close()
  })
})
