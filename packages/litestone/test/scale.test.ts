// scale.test.ts — the whole Data realm over a schema nobody here would write by hand.
//
// `test/fixtures/scale/openmrp.lite` is 188 models and ~1,900 columns, derived
// from the MySQL schema of a real manufacturing ERP. Every rule it exercises is
// already covered at small sizes; what nothing else in this repo covers is SIZE.
// The apps in the tree top out around 40 models, so a rule that is quadratic in
// model count, or an index name two features derive identically, is invisible.
//
// The bench beside it (`bench/scale-schema.mjs`) prints the timings. This file
// asserts only the two things that must not silently stop being true.

import { describe, test, expect } from 'bun:test'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { parse, createClient, introspect, buildPristine, diffSchemas } from '../src/index.js'

const source = readFileSync(new URL('./fixtures/scale/openmrp.lite', import.meta.url).pathname, 'utf8')

describe('a 188-model schema', () => {
  test('parses, and every model is a model', () => {
    const parsed = parse(source)
    expect(parsed.errors).toEqual([])
    expect(parsed.valid).toBe(true)
    expect(parsed.schema.models.length).toBeGreaterThan(180)
  })

  test('builds a database, and booting again against it migrates nothing', async () => {
    // The case CLAUDE.md names: a constraint compared by TEXT rather than by
    // meaning rebuilds every table on every boot, and at 40 models that is fast
    // enough to look like it did nothing.
    const dbPath = join(tmpdir(), `litestone-scale-test-${process.pid}.db`)
    const clean = () => { for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(p)) rmSync(p) }
    clean()

    try {
      const db = await createClient({ schema: source, db: dbPath, autoMigrate: true })
      if ('close' in db) db.close()

      const parsed     = parse(source)
      const pristineDb = new Database(':memory:')
      const pristine   = buildPristine(pristineDb, parsed)
      pristineDb.close()

      const live = introspect(new Database(dbPath))
      const diff = diffSchemas(pristine, live, parsed)

      const changes = Object.entries(diff).flatMap(([kind, v]) =>
        (Array.isArray(v) ? v : []).map(x => `${kind}: ${JSON.stringify(x)}`))
      expect(changes).toEqual([])
    } finally {
      clean()
    }
  })
})
