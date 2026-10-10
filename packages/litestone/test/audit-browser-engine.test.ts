// audit-browser-engine.test.ts — where the two engines answer differently for
// the same client code (audit run 2.3, `FJS-D305`).
//
// `core/engine.js` states the surface an engine owes. These are the places the
// client leans on something the contract does not state, so `bun:sqlite` and
// SQLite's wasm build answer two different things. Each test here is the SERVER
// half, run on `bun:sqlite`; the comment above it states what the browser half
// answered in Chrome over the wasm engine (`test/browser/audit-browser-seams.mjs`,
// scenarios `int-past-safe` and `engine-serialize`).

import { describe, it, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createClient }  from '../src/core/client.js'
import { parse }         from '../src/core/parser.js'
import { openDatabase }  from '../src/core/engine.js'

const SRC = join(import.meta.dir, '../src')

describe('an Int past 2^53 in a column that is not @big', () => {
  // Browser half: the same row reads back as a BigInt (`1152921504606846976n`),
  // because oo1 answers a BigInt for an integer a double cannot hold. The two
  // engines therefore hand the same client two TYPES for one stored value, and
  // a page that JSON.stringifies the browser's answer throws. A row like this
  // reaches the file by raw SQL or an older writer, since the write path now
  // refuses it.
  it('bun:sqlite answers a rounded Number', async () => {
    const db = (await createClient({ parsed: parse('model Num { id Int @id @default(autoincrement())  n Int }'), db: ':memory:' })).asSystem()
    await db.sql`INSERT INTO "Num" (n) VALUES (${2 ** 60})`
    const row = await db.num.findFirst()
    expect(typeof row.n).toBe('number')
    expect(row.n).toBe(1152921504606847000)
  })

  // One answer on both engines: a value an Int cannot hold exactly is refused
  // on the way in, the way `@scale` and `@money` already refuse it, so neither
  // engine is asked to read it (`FJS-2403`).
  test('a value past Number.MAX_SAFE_INTEGER is refused for an Int that is not @big', async () => {
    const db = (await createClient({ parsed: parse('model Num { id Int @id @default(autoincrement())  n Int }'), db: ':memory:' })).asSystem()
    await expect(db.num.create({ data: { n: 2 ** 60 } })).rejects.toThrow()
  })
})

describe('the optional serialize()', () => {
  // Browser half: `engines/sqlite-wasm.js` wrap().serialize() answered `null`
  // for a database holding a table, because `sqlite3Export` looks for the api
  // on `db.constructor.sqlite3` or `globalThis.sqlite3` and the ESM build sets
  // neither — while `wrap()` is handed `capi`, which has `sqlite3_js_db_export`.
  it('bun:sqlite answers the file as bytes', () => {
    const raw = openDatabase(':memory:')
    try {
      raw.run('CREATE TABLE t (x)')
      const bytes = raw.serialize()
      expect(bytes.byteLength).toBeGreaterThan(0)
    } finally { raw.close() }
  })

  // FJS-2402: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  // The export has to come from the capi the wrap was handed, not from a global
  // the module build does not set.
  test.failing('the wasm engine exports through the capi it was handed', () => {
    const src = readFileSync(join(SRC, 'engines/sqlite-wasm.js'), 'utf8')
    expect(src).not.toMatch(/globalThis\.sqlite3/)
    expect(src).toMatch(/capi\.sqlite3_js_db_export/)
  })
})

describe('what a backup is made of', () => {
  // Browser half: `$backup` answered `ReferenceError: Bun is not defined`.
  // FJS-2401: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  // The file write belongs behind #host, where the browser half refuses it by name.
  test.failing('core/backup.js reaches the filesystem through #host, never Bun', () => {
    const src = readFileSync(join(SRC, 'core/backup.js'), 'utf8')
    expect(src).not.toMatch(/\bBun\./)
    expect(src).toMatch(/from '#host'/)
  })
})
