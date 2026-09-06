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
// Which fixtures exist and on whose machine is `fixtures/corpus/tiers.js`, and
// `introspect-roundtrip.test.ts` reads the same module — a roster written twice
// drifts, and the copy that drifted made the suite unpassable on a fresh clone
// (`FJS-009`). `fixtures/corpus/README.md` § What is committed says why the
// split falls where it does. An absent fixture is SKIPPED BY NAME rather than
// silently not run.
//
// A LOCAL fixture is also read from `$FJS_CORPUS_LOCAL` when the tree does not
// hold it, because a private schema in the tree is a source file `.gitignore`
// has to hide, and a hidden source file is the shape that made 20 files of a
// build pipeline invisible to a fresh clone. Keeping it outside means the
// hygiene sweep stays honest AND the target still runs. The override is LOCAL
// only: pointing a committed fixture somewhere else would let a green run grade
// bytes nobody reviewed.

import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { parse, createClient, introspect, buildPristine, diffSchemas } from '../src/index.js'
import { COMMITTED, FETCHED, LOCAL } from './fixtures/corpus/tiers.js'

const dir = new URL('./fixtures/corpus/', import.meta.url).pathname

// Where a LOCAL fixture may live instead of the tree. Trailing separator is not
// assumed — an operator types a directory, not a prefix.
const localDir = process.env.FJS_CORPUS_LOCAL

const read = (name: string) => {
  const candidates = [`${dir}${name}.lite`]
  if (localDir && LOCAL.includes(name)) candidates.push(join(localDir, `${name}.lite`))
  for (const p of candidates) if (existsSync(p)) return readFileSync(p, 'utf8')
  return null
}

// A fixture on disk that no tier names is swept by NOTHING, and that is the
// half a count cannot ask: `hrms.lite` sat committed and unnamed by the
// round-trip test's own copy of the roster for as long as the copy existed.
// Asked against the DIRECTORY, because comparing the roster to a list derived
// from the roster is a tautology that passes however wrong both are.
describe('the roster names every fixture that is here', () => {
  test('no .lite in fixtures/corpus/ is unaccounted for', () => {
    const known   = new Set([...COMMITTED, ...FETCHED, ...LOCAL])
    const onDisk  = readdirSync(dir).filter(f => f.endsWith('.lite')).map(f => f.replace(/\.lite$/, ''))
    const unnamed = onDisk.filter(n => !known.has(n))
    expect(unnamed).toEqual([])
  })
})

describe('the corpus — schemas converted from real applications', () => {
  for (const name of [...COMMITTED, ...FETCHED, ...LOCAL]) {
    const source = read(name)

    if (!source) {
      const how = LOCAL.includes(name)
        ? 'a private source with no fetch target — convert it by hand, or set FJS_CORPUS_LOCAL to the directory holding it'
        : `run \`bun test/fixtures/corpus/fetch.mjs ${name}\``
      test.skip(`${name} — not present; ${how}`, () => {})
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
