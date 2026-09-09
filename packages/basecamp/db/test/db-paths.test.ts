// db/test/db-paths.test.ts
// Where this app's data is, and the two ways that answer used to be wrong.
//
// A database here is TWO declared paths — `database main` and `database audit`
// — and for most of this app's life only one of them was ever stated by a
// caller that wanted an isolated run. The other followed the process CWD, so
// isolation happened by accident of where a script was launched: the seed test
// gave the seeder a scratch directory and got both moved, while
// `verify-screens.mjs` redirected `DATABASE_URL` and ran with `cwd: PKG`, so
// its audit rows landed in the developer's own `db/audit/`. Neither drive
// failed and neither said anything (`FJS-633`).
//
// Both halves are asserted here because both are silent.
//
// **The anchor is the APP ROOT, and that is the part which reads wrong.**
// `core/db.ts` passes `resolveFrom: 'schema'`, and `schemaAnchor` takes the
// schema file's directory and STEPS OUT of it when it is named `db` — which is
// where this schema lives. So a relative default is written against the package
// root and keeps its `./db/` prefix; rewriting one relative to `db/` moves the
// file, litestone migrates whatever it finds, and the app works against a
// database nobody meant. Measured both ways: without the anchor, opening the
// client from `api/` created `api/basecamp.db` at 970 KB carrying the same 50
// tables as the real one, so a table count cannot tell them apart; and with the
// defaults rewritten, a 319-check drive ran green against a stray
// `packages/basecamp/basecamp.db`.
//
// **A caller that states one path states both.** Not style: stating one is
// exactly what produced the leak, and it reads as complete.

import { test, expect, describe } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT   = join(import.meta.dir, '..', '..')
const SCHEMA = readFileSync(join(ROOT, 'db', 'schema.lite'), 'utf8')
const DB_TS  = readFileSync(join(ROOT, 'api', 'src', 'core', 'db.ts'), 'utf8')

/** `database <name> { path env("VAR", "default") … }` — the two declarations. */
function declarations(): { name: string; var: string; default: string }[] {
  return [...SCHEMA.matchAll(/database\s+(\w+)\s*\{\s*path\s+env\("([^"]+)",\s*"([^"]+)"\)/g)]
    .map(m => ({ name: m[1], var: m[2], default: m[3] }))
}

describe('where this app keeps its data', () => {
  test('the anchor is the schema, and both defaults are written for that anchor', () => {
    expect(DB_TS).toContain("resolveFrom:   'schema'")

    const declared = declarations()
    // The control: a regex that matched nothing would pass every row below.
    expect(declared.map(d => d.name).sort()).toEqual(['audit', 'main'])

    for (const d of declared) {
      // The anchor is the package root, so a default is written from there —
      // `./db/…`, the same spelling it had under the CWD. A default written
      // against `db/` instead lands beside it and takes the whole app with it.
      expect(d.default.startsWith('./db/')).toBe(true)
      // And it must stay relative, or the anchor is decorative and a checkout
      // in another directory writes to somebody else's tree.
      expect(d.default.startsWith('/')).toBe(false)
    }
  })

  test('every caller that redirects one path redirects the other', () => {
    // The rule FJS-633 came down to. A run that states `DATABASE_URL` and
    // leaves `AUDIT_PATH` inherits the developer's own trail and looks isolated
    // from the inside.
    const files = [
      ...readdirSync(join(ROOT, 'web', 'test')).map(f => join('web', 'test', f)),
      ...readdirSync(join(ROOT, 'db', 'test')).map(f => join('db', 'test', f)),
    ].filter(f => f.endsWith('.mjs') || f.endsWith('.ts'))

    const redirects: string[] = []
    const lonely:    string[] = []

    for (const rel of files) {
      const text = readFileSync(join(ROOT, rel), 'utf8')
      // `DATABASE_URL:` as a key in an env object — not the string typed into a
      // form, which `verify.mjs` does on the environment-variables screen and
      // which is a value in the app rather than a path for this process.
      if (!/DATABASE_URL:\s*[A-Za-z_]/.test(text)) continue
      redirects.push(rel)
      if (!/AUDIT_PATH:\s*[A-Za-z_]/.test(text)) lonely.push(rel)
    }

    // The control, and it is the row that keeps the two below honest: a scan
    // reading a shape nothing uses reports every file as compliant.
    expect(redirects.length).toBeGreaterThan(1)
    expect(lonely).toEqual([])
  })
})
