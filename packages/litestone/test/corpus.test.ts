// corpus.test.ts — real schemas nobody here wrote, built for real.
//
// `test/fixtures/scale/openmrp.lite` asks whether the Data realm survives SIZE.
// This file asks a different question: whether it survives SHAPES this project
// did not invent. Every fixture beside it was read mechanically out of a
// published schema by `litestone import`, so nothing in it was chosen by someone
// who already knew what `.lite` can say — which is the half a hand-written
// fixture cannot cover and a `fli check` rule can never reach. The first run
// found FJS-563 and FJS-564.
//
// Four readers feed it (`src/import/`), each added for what the previous one
// cannot put in front of the parser: `prisma.js`; `rails.js` for single-table
// inheritance and partial indexes; `sql.js` for a Postgres dump, the only source
// carrying CHECK constraints, views and native enums; and `frappe.js`, the only
// one where the schema DECLARES whether a polymorphic target set is closed.
//
// It is therefore also the widest test of the SHIPPED importer: 1,377 models of
// input nobody here wrote, through the same code an app runs.
//
// Only `triggerdev.lite` is committed; the others are fetched (`fixtures/
// corpus/README.md` says why) and are SKIPPED BY NAME when absent rather than
// silently not run.

import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { parse, createClient, introspect, buildPristine, diffSchemas } from '../src/index.js'

const dir      = new URL('./fixtures/corpus/', import.meta.url).pathname
const COMMITTED = ['triggerdev']
const FETCHED   = ['calcom', 'documenso', 'mastodon', 'lago', 'discourse', 'erpnext']

const read = (name: string) => {
  const p = `${dir}${name}.lite`
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

describe('the corpus — schemas converted from real applications', () => {
  for (const name of [...COMMITTED, ...FETCHED]) {
    const source = read(name)

    if (!source) {
      test.skip(`${name} — not present; run \`bun test/fixtures/corpus/fetch.mjs ${name}\``, () => {})
      continue
    }

    test(`${name} parses, and every model is a model`, () => {
      const parsed = parse(source)
      expect(parsed.errors).toEqual([])
      expect(parsed.valid).toBe(true)
      expect(parsed.schema.models.length).toBeGreaterThan(20)
    })

    test(`${name} builds a database, and booting again against it migrates nothing`, async () => {
      const dbPath = join(tmpdir(), `litestone-corpus-${name}-${process.pid}.db`)
      const clean  = () => { for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(p)) rmSync(p) }
      clean()

      try {
        const db = await createClient({ schema: source, db: dbPath })
        if ('close' in db) db.close()

        const db2 = await createClient({ schema: source, db: dbPath })
        if ('close' in db2) db2.close()

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
  }
})
