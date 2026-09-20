// actor-type.test.ts — what KIND of caller an audit entry says did it.
//
// `actorId` answers WHO and is null for two entirely different callers: a
// bearer holding a capability and nobody at all. `actorType` is the column
// that separates them, and it used to read any principal OBJECT as a user —
// so a guest holding a cart token was filed as a person with no id, which is
// indistinguishable from a session whose id went missing (`FJS-1195`).
//
// Every case here is a PAIR against the ones beside it: four callers, one
// write each, four different answers. A grader that collapsed any two of them
// would pass a test that only asked about one.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createClient } from '../src/index.js'

const tick = () => new Promise((r) => setImmediate(r))

const SCHEMA = (dir: string) => `
  database main  { path ":memory:" }
  database audit { path "${dir}/audit/" driver logger }
  model Thing {
    id    String @id @default(uuid())
    token String @default("t")
    name  String
    @@gate("0")
    @@log(audit)
  }
`

/** One write through whichever flavor `pick` returns, and the row it left. */
async function writeAs(pick: (db: any) => any) {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-actor-'))
  try {
    const db: any = await createClient({ schema: SCHEMA(dir), resolveFrom: dir })
    await pick(db).thing.create({ data: { name: 'x' } })
    await tick()
    const rows = await db.asSystem().auditLogs.findMany({})
    db.$close()
    return rows[0]
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('actorType grades the principal it was handed', () => {

  test('a principal with an id is a user', async () => {
    const row = await writeAs(db => db.$setAuth({ id: 'u-1' }))
    expect(row.actorId).toBe('u-1')
    expect(row.actorType).toBe('user')
  })

  test('a claims-only principal is a bearer, not a user with no id', async () => {
    // What junction hands the Data boundary for a caller with no session:
    // claims and nothing else. The id stays null — that is what a bearer
    // capability IS — so the type is the only thing that can say so.
    const row = await writeAs(db => db.$setAuth({ cartToken: 'abc' }))
    expect(row.actorId).toBeNull()
    expect(row.actorType).toBe('bearer')
  })

  test('asSystem is the application, which is not the same as nobody', async () => {
    const row = await writeAs(db => db.asSystem())
    expect(row.actorId).toBeNull()
    expect(row.actorType).toBe('system')
  })

  test('no principal at all says nothing', async () => {
    // The gate is 0, so an unauthenticated caller can make this write. There
    // is nobody to name and nothing to grade, and inventing a word for it
    // would make the system row above unreadable.
    const row = await writeAs(db => db)
    expect(row.actorId).toBeNull()
    expect(row.actorType).toBeNull()
  })

  test('a principal that states its own type keeps it', async () => {
    // Declared beats derived: an app whose callers are machines says so, and
    // an id is present here, so the derivation would have answered 'user'.
    const row = await writeAs(db => db.$setAuth({ id: 'k-1', type: 'apiKey' }))
    expect(row.actorType).toBe('apiKey')
  })
})
