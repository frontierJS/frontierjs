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
  database audit { path "${dir}/audit/" driver trail }
  model Thing {
    id    String @id @default(uuid())
    token String @default("t")
    name  String
    @@gate("0")
    @@trail(audit)
  }
`

/** One write through whichever flavor `pick` returns, and the row it left. */
async function writeAs(pick: (db: any) => any) {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-actor-'))
  try {
    const db: any = await createClient({ schema: SCHEMA(dir), resolveFrom: dir })
    await pick(db).thing.create({ data: { name: 'x' } })
    await tick()
    const rows = await db.asSystem().auditTrail.findMany({})
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

  test('a bearer names the GRANT as its actor, and what it was for as the subject', async () => {
    // A bearer principal carries no id — that is what keeps the gate at
    // STRANGER(0) — so without the provenance closure the write is filed under
    // nobody, and *which link did this* is unanswerable after a revocation
    // (`FJS-D342`). The grant travels the same way an operator does, because
    // neither is on the principal.
    const dir = mkdtempSync(join(tmpdir(), 'fjs-actor-'))
    try {
      const db: any = await createClient({ schema: SCHEMA(dir), resolveFrom: dir })
      db.$logContext(() => ({ bearerId: 'link-7', bearerSubject: 'client-3' }))
      await db.$setAuth({ portalClientId: 'client-3' }).thing.create({ data: { name: 'x' } })
      await tick()
      const row = (await db.asSystem().auditTrail.findMany({}))[0]
      db.$close()

      expect(row.actorType).toBe('bearer')
      expect(row.actorId).toBe('link-7')
      expect(row.subjectId).toBe('client-3')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a person holding a grant as well is the actor, and the grant\'s subject is the subject', async () => {
    // Junction's `session: 'merge'` (`FJS-D832`): the grant is a thing the
    // person held, not who acted. Filed as a user under the person's id, with
    // what the grant was for kept as the subject.
    const dir = mkdtempSync(join(tmpdir(), 'fjs-actor-'))
    try {
      const db: any = await createClient({ schema: SCHEMA(dir), resolveFrom: dir })
      db.$logContext(() => ({ bearerId: 'link-7', bearerSubject: 'client-3' }))
      await db.$setAuth({ id: 'person-1', type: 'user', portalClientId: 'client-3' }).thing.create({ data: { name: 'x' } })
      await tick()
      const row = (await db.asSystem().auditTrail.findMany({}))[0]
      db.$close()

      expect(row.actorType).toBe('user')
      expect(row.actorId).toBe('person-1')
      expect(row.subjectId).toBe('client-3')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('an operator still wins over a bearer, and keeps the principal as subject', async () => {
    // The negative control for the row above. Both arrive down one closure, so
    // a reader that took whichever it saw first would file a support write
    // against a link id — and support mode is the feature whose whole point is
    // that the trail names the person who acted.
    const dir = mkdtempSync(join(tmpdir(), 'fjs-actor-'))
    try {
      const db: any = await createClient({ schema: SCHEMA(dir), resolveFrom: dir })
      db.$logContext(() => ({ operatorId: 'op-9', episodeId: 'ep-1', bearerId: 'link-7', bearerSubject: 'client-3' }))
      await db.$setAuth({ id: 'subject-1', type: 'user' }).thing.create({ data: { name: 'x' } })
      await tick()
      const row = (await db.asSystem().auditTrail.findMany({}))[0]
      db.$close()

      expect(row.actorId).toBe('op-9')
      expect(row.actorType).toBe('support')
      expect(row.subjectId).toBe('subject-1')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a principal that states its own type keeps it', async () => {
    // Declared beats derived: an app whose callers are machines says so, and
    // an id is present here, so the derivation would have answered 'user'.
    const row = await writeAs(db => db.$setAuth({ id: 'k-1', type: 'apiKey' }))
    expect(row.actorType).toBe('apiKey')
  })
})
