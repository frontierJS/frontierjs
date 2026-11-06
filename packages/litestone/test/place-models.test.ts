// `createClient({ placeModels })` moves named models into another database for
// one client (`FJS-D1921`). The read-only copy is why it exists: the copy opens
// `main` readonly so nothing a reader does can change yesterday's data, and
// `Session` alone stays writable so a person can still sign in and out.
//
// A sign-in that wrote to `main` would be lost at the next refresh, and a
// password change would be lost the same way, so the cases below pin both
// halves: `Session` writes land, and `User`, `Credential` and raw SQL are
// refused. The schema is auth's three models in their own shape: `Session`
// carries `userId` as a plain column, which is what lets it move alone.

import { describe, it, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createClient } from '../src/core/client.js'
import { parse, placeModels } from '../src/core/parser.js'
import { createTenantRegistry } from '../src/tenant.js'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'lite-place-'))
  dirs.push(d)
  return d
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const MODELS = `
model User {
  id    String @id @default(uuid())
  email String @unique
}

model Credential {
  id     String @id @default(uuid())
  userId String
  value  String
  user   User   @relation(fields: [userId], references: [id])
}

model Session {
  id        String   @id @default(uuid())
  userId    String
  expiresAt DateTime
}
`

const SCHEMA = `database main { path "./app.db" }\n${MODELS}`

// The live App's file, with one user, their password and one session in it.
const live = async (dir: string) => {
  const db: any = await createClient({ schema: SCHEMA, resolveFrom: dir })
  const user = await db.user.create({ data: { email: 'a@x.test' } })
  await db.credential.create({ data: { userId: user.id, value: 'hash' } })
  await db.session.create({ data: { userId: user.id, expiresAt: '2099-01-01T00:00:00.000Z' } })
  await db.$close()
  return user
}

describe('placeModels on a read-only copy', () => {
  it('writes Session to a scratch file while main refuses every write', async () => {
    const dir  = tmp()
    const user = await live(dir)
    const scratch = join(dir, 'copy-sessions.db')
    const db: any = await createClient({
      schema: SCHEMA, resolveFrom: dir,
      placeModels: { Session: 'sessions' },
      databases:   { sessions: { path: scratch } },
      access:      { main: 'readonly' },
    })

    expect(db.$rawDbs.sessions).not.toBe(db.$rawDbs.main)
    expect(existsSync(scratch)).toBe(true)
    // The copy's session table starts empty: a session is the copy's own.
    expect(await db.session.count()).toBe(0)

    const s = await db.session.create({ data: { userId: user.id, expiresAt: '2099-01-01T00:00:00.000Z' } })
    expect(await db.session.count()).toBe(1)
    await db.session.delete({ where: { id: s.id } })
    expect(await db.session.count()).toBe(0)

    await expect(db.user.update({ where: { id: user.id }, data: { email: 'b@x.test' } })).rejects.toThrow(/readonly/)
    const cred = await db.credential.findFirst({ where: { userId: user.id } })
    await expect(db.credential.update({ where: { id: cred.id }, data: { value: 'other' } })).rejects.toThrow(/readonly/)
    await expect(db.asSystem().sql`UPDATE "user" SET email = 'c@x.test'`).rejects.toThrow(/readonly/)

    // Reads of the copy still answer, unchanged.
    expect((await db.user.findFirst({ where: { id: user.id } })).email).toBe('a@x.test')
    await db.$close()
  })

  it('leaves the schema alone, so the next client puts Session back in main', async () => {
    const dir = tmp()
    await live(dir)
    const copy: any = await createClient({
      schema: SCHEMA, resolveFrom: dir,
      placeModels: { Session: 'sessions' },
      databases:   { sessions: { path: join(dir, 'copy-sessions.db') } },
    })
    await copy.$close()
    const db: any = await createClient({ schema: SCHEMA, resolveFrom: dir })
    expect(db.$rawDbs.sessions).toBeUndefined()
    expect(await db.session.count()).toBe(1)
    await db.$close()
  })

  it('does not change a parse it was handed', () => {
    const parsed = parse(SCHEMA)
    const placed = placeModels(parsed, { Session: 'sessions' })
    expect(placed.valid).toBe(true)
    expect(parsed.schema.databases.map((d: any) => d.name)).toEqual(['main'])
    expect(parsed.schema.models.find((m: any) => m.name === 'Session').attributes.some((a: any) => a.kind === 'db')).toBe(false)
    expect(placed.schema.models.find((m: any) => m.name === 'Session').attributes.find((a: any) => a.kind === 'db').name).toBe('sessions')
  })
})

// Under `strategy database` the moved table is the one already in the shop's
// file, read under the new name, and a session written there stays that tenant's.
describe('placeModels under strategy database', () => {
  it('reads the staged sessions and writes new ones into the tenant file alone', async () => {
    const dir = tmp()
    await Bun.write(join(dir, 'schema.lite'), `
      tenancy { strategy database  dir "./fleet"  registry "./fleet-index.db" }
      ${SCHEMA}
    `)
    const fleet: any = await createTenantRegistry({ path: join(dir, 'schema.lite') })
    for (const id of ['acme', 'globex']) {
      await fleet.create(id)
      const db: any = await fleet.get(id)
      const user = await db.user.create({ data: { email: `${id}@x.test` } })
      await db.session.create({ data: { userId: user.id, expiresAt: '2099-01-01T00:00:00.000Z' } })
    }
    fleet.close()

    const copy: any = await createTenantRegistry({
      path: join(dir, 'schema.lite'),
      clientOptions: { placeModels: { Session: 'sessions' }, access: { main: 'readonly' } },
    })
    const acme: any = await copy.get('acme')
    // A readonly main has no write handle, so the shared file is read off the writer it does have.
    expect(acme.$rawDbs.sessions.filename).toBe(join(dir, 'fleet', 'acme.db'))
    expect(await acme.session.count()).toBe(1)
    const user = await acme.user.findFirst({})
    const s = await acme.session.create({ data: { userId: user.id, expiresAt: '2099-01-01T00:00:00.000Z' } })
    await acme.session.delete({ where: { id: s.id } })
    await acme.session.create({ data: { userId: user.id, expiresAt: '2099-01-01T00:00:00.000Z' } })
    await expect(acme.user.update({ where: { id: user.id }, data: { email: 'z@x.test' } })).rejects.toThrow(/readonly/)

    const globex: any = await copy.get('globex')
    expect(await acme.session.count()).toBe(2)
    expect(await globex.session.count()).toBe(1)
    copy.close()
  })
})

describe('placeModels refuses by name', () => {
  it('a model the schema does not have', async () => {
    await expect(createClient({ schema: SCHEMA, databases: ':memory:', placeModels: { Sesion: 'sessions' } }))
      .rejects.toThrow(/'Sesion' names no model/)
  })

  it('a database the schema does not declare and no path for it', async () => {
    await expect(createClient({ schema: SCHEMA, resolveFrom: tmp(), placeModels: { Session: 'sessions' } }))
      .rejects.toThrow(/databases: \{ sessions: \{ path \} \}/)
  })

  it('a move that makes a relation cross databases', async () => {
    await expect(createClient({ schema: SCHEMA, databases: ':memory:', placeModels: { Credential: 'sessions' } }))
      .rejects.toThrow(/a relation cannot cross databases/)
  })

  it('a jsonl database as the destination', () => {
    const placed = placeModels(parse(`database main { path "./a.db" }\ndatabase log { path "./log/" driver jsonl }\n${MODELS}`), { Session: 'log' })
    expect(placed.valid).toBe(false)
    expect(placed.errors[0]).toMatch(/a jsonl database/)
  })

  it('an untrusted schema', async () => {
    await expect(createClient({ schema: MODELS, db: ':memory:', untrusted: true, placeModels: { Session: 'sessions' } }))
      .rejects.toThrow(/untrusted.*placeModels/)
  })
})
