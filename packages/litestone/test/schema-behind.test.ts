// test/schema-behind.test.ts
// What a process is told when the database is ahead of the schema it holds
// (FJS-566).
//
// The situation is two processes on one database file — under
// `strategy database` the ordinary shape: a long-running API, and a drive or a
// seed run from the app root after the schema moved. The newer one migrates
// forward; the older one then diffs toward its own, older schema, and every
// change it would make is a REMOVAL.
//
// litestone already fails closed there, which is the part that was never in
// doubt. What was wrong is the sentence: it offered `{ acceptDataLoss: true }`
// as the way forward, and taking that advice deletes the column the newer build
// is writing to. The diff cannot tell *I removed this* from *you are behind* —
// both are drops-only — so both readings are printed and neither is chosen.
//
// Trap: `needsRebuild` is true whenever anything is dropped, because SQLite
// cannot drop a column in place. Testing it as "something changed" answers
// false in exactly the case this is about.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, autoMigrate } from '../src/index.js'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'ls-behind-')); dirs.push(d); return d }
const clean = () => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) }

const WIDGET = (fields: string) =>
  `model Widget { id Int @id @default(autoincrement())  ${fields} }`

/** Build `ahead` on disk, then open the same file with `behind` and diff. */
async function behindBy(ahead: string, behind: string) {
  const db  = join(tmp(), 'app.db')
  const now = await createClient({ schema: WIDGET(ahead), db })
  autoMigrate(now)
  await now.widget.create({ data: { name: 'kept' } })
  const old = await createClient({ schema: WIDGET(behind), db })
  const warned: string[] = []
  const real = console.warn
  console.warn = (...a: unknown[]) => { warned.push(a.join(' ')) }
  let result
  try { result = autoMigrate(old) } finally { console.warn = real }
  return { result: result.main, said: warned.join('\n'), old, db }
}

describe('a database that is ahead of the schema in hand', () => {
  test('is refused, and nothing is dropped', async () => {
    const { result, old } = await behindBy('name String  colour String?', 'name String')
    expect(result.state).toBe('blocked')
    expect((await old.$rawDbs.main.query('PRAGMA table_info(widget)').all() as { name: string }[])
      .map(c => c.name)).toContain('colour')
    clean()
  })

  test('names both readings, because the diff cannot tell them apart', async () => {
    const { result, said } = await behindBy('name String  colour String?', 'name String')
    expect(result.onlyDrops).toBe(true)
    expect(said).toContain('migrated by a NEWER schema')
    expect(said).toContain('run the current build instead')
    // and it still offers the option, for the author who meant it
    expect(said).toContain('acceptDataLoss')
    clean()
  })

  // The pair. A diff that ADDS as well as removes is an author editing a
  // schema, not a process that is behind — one reading, and the original
  // advice. Without this the new branch is indistinguishable from one that
  // fires on every blocked migration.
  test('and a diff that also adds keeps the single reading', async () => {
    const { result, said } = await behindBy('name String  colour String?', 'name String  shade String?')
    expect(result.state).toBe('blocked')
    expect(result.onlyDrops).toBe(false)
    expect(said).not.toContain('migrated by a NEWER schema')
    expect(said).toContain('acceptDataLoss')
    clean()
  })

  // The author who meant it is still served: the option applies where the
  // refusal is the only thing standing between them and the drop.
  test('the option still works when the removal was intended', async () => {
    const db  = join(tmp(), 'app.db')
    const now = await createClient({ schema: WIDGET('name String  colour String?'), db })
    autoMigrate(now)
    const old = await createClient({ schema: WIDGET('name String'), db })
    const res = autoMigrate(old, undefined, { acceptDataLoss: true })
    expect(res.main.state).not.toBe('blocked')
    expect((old.$rawDbs.main.query('PRAGMA table_info(widget)').all() as { name: string }[])
      .map(c => c.name)).not.toContain('colour')
    clean()
  })

  // The control that keeps the whole file honest: an unchanged schema is not
  // "behind", and must migrate nothing and say nothing.
  test('an unchanged schema is neither blocked nor warned about', async () => {
    const db  = join(tmp(), 'app.db')
    const one = await createClient({ schema: WIDGET('name String'), db })
    autoMigrate(one)
    const two = await createClient({ schema: WIDGET('name String'), db })
    const warned: string[] = []
    const real = console.warn
    console.warn = (...a: unknown[]) => { warned.push(a.join(' ')) }
    let res
    try { res = autoMigrate(two) } finally { console.warn = real }
    expect(res.main.state).not.toBe('blocked')
    expect(warned.join('\n')).not.toContain('BLOCKED')
    clean()
  })
})
