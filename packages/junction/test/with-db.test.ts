// test/with-db.test.ts
//
// `app.withDb(fn)` — the client a service call would get, for work that holds no
// ctx — and `app.onTenantClient(observer)`, the once-per-tenant-client Observer.
//
// Against real Litestone clients and a real tenant registry, one per strategy,
// because the failure each assertion is about is a write landing in the wrong
// tenant or refused in the right one, and both look like success from a fake.
// Every tenant assertion is PAIRED with the other tenant's rows, so a client
// that reached nobody cannot pass.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient, createTenantRegistry } from '../../litestone/src/index.js'
import { createApp, createService, createStubAuth, toDataPrincipal } from '../index.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

const USERS = createStubAuth({ users: [{ id: 'u1', role: 'member' }, { id: 'u2', role: 'member' }] })

describe('app.withDb with no tenancy', () => {
  test('inside runAs it is the principal\'s own client, graded by the schema\'s policies', async () => {
    const db: any = await createClient({ db: ':memory:', schema: `
      model Note {
        id      Int    @id @default(autoincrement())
        ownerId String @default(auth().id)
        body    String
        @@allow('read', ownerId == auth().id)
      }` })
    await db.asSystem().note.create({ data: { ownerId: 'u1', body: 'mine' } })
    await db.asSystem().note.create({ data: { ownerId: 'u2', body: 'theirs' } })
    const app = createApp({ db, auth: USERS })
    await app._startForTest()

    const bodies = await app.runAs('u1', () => app.withDb((scoped: any) => scoped.note.findMany({})))
    expect(bodies.map((n: any) => n.body)).toEqual(['mine'])

    const created = await app.runAs('u2', () => app.withDb((scoped: any) => scoped.note.create({ data: { body: 'stamped' } })))
    expect(created.ownerId).toBe('u2')
  })

  test('the leased client takes a lock, and the work inside it is still graded as the principal', async () => {
    // It threw `"$lock" is not a table in this schema`, so an engine had to
    // reach past this seam for the root client and write as the system (FJS-1216).
    const db: any = await createClient({ db: ':memory:', schema: `
      model Note {
        id      Int    @id @default(autoincrement())
        ownerId String @default(auth().id)
        body    String
        @@allow('read', ownerId == auth().id)
      }` })
    await db.asSystem().note.create({ data: { ownerId: 'u2', body: 'theirs' } })
    const app = createApp({ db, auth: USERS })
    await app._startForTest()

    const held = await db.$locks.acquire('person:u1')
    await expect(app.runAs('u1', () => app.withDb((scoped: any) => scoped.$lock('person:u1', async () => 'ran', { wait: 0 }))))
      .rejects.toThrow(/lock/i)
    await held.release()

    const seen = await app.runAs('u1', () => app.withDb((scoped: any) => scoped.$lock('person:u1', async () => {
      await scoped.note.create({ data: { body: 'mine' } })
      return scoped.note.findMany({})
    })))
    expect(seen.map((n: any) => n.body)).toEqual(['mine'])
  })
})

describe('app.withDb under strategy database', () => {
  async function fleet() {
    const dir  = mkdtempSync(join(tmpdir(), 'junction-withdb-'))
    const path = join(dir, 'schema.lite')
    writeFileSync(path, `
tenancy { strategy database  dir "${dir}/tenants"  registry "${dir}/registry.db" }
database main { path "./app.db" }
model Note {
  id   Int    @id @default(autoincrement())
  body String
  @@db(main)
}
`)
    const registry: any = await createTenantRegistry({ path })
    for (const id of ['a', 'b']) await registry.create(id)
    return registry
  }

  test('the tenant runAs names is the database fn writes to, and each tenant client is observed once', async () => {
    const registry = await fleet()
    const app = createApp({ tenants: registry, auth: USERS })
    const observed: string[] = []
    app.onTenantClient((_client, tenant) => observed.push(tenant))
    app.services.register(createService({
      name: 'notes', model: 'Note',
    }))
    await app._startForTest()

    await app.runAs('u1', { tenant: 'b' }, () => app.withDb((db: any) => db.note.create({ data: { body: 'into b' } })))
    await app.runAs('u1', { tenant: 'b' }, () => app.withDb((db: any) => db.note.create({ data: { body: 'into b again' } })))

    expect((await (await registry.get('b')).asSystem().note.findMany({})).map((n: any) => n.body)).toEqual(['into b', 'into b again'])
    expect(await (await registry.get('a')).asSystem().note.findMany({})).toEqual([])
    expect(observed).toEqual(['b'])
  })

  test('a unit of work that names no tenant is refused by the same sentence a request gets', async () => {
    const registry = await fleet()
    const app = createApp({ tenants: registry, auth: USERS })
    await app._startForTest()
    await expect(app.runAs('u1', () => app.withDb(async () => 'ran'))).rejects.toThrow(/No tenant on this request/)
  })
})

describe('app.withDb under strategy row', () => {
  test('the principal resolver\'s claim scopes the client, so a write lands in the tenant runAs named', async () => {
    const db: any = await createClient({ db: ':memory:', schema: `
      tenancy { strategy row  column workspaceId  claim workspaceId }
      model Doc {
        id          Int    @id @default(autoincrement())
        workspaceId String
        title       String
      }` })
    await db.asSystem().doc.create({ data: { workspaceId: 'w2', title: 'other workspace' } })

    // The resolver reads the tenant the way `membershipClaim` does for a job:
    // off the request meta `runAs` set.
    const app = createApp({ db, auth: USERS, principal: async (ctx: ServiceContext) => {
      const tenant = (ctx.app as any).tenant()
      return tenant ? { workspaceId: tenant } : {}
    } })
    await app._startForTest()

    const seen = await app.runAs('u1', { tenant: 'w1' }, () => app.withDb(async (scoped: any) => {
      await scoped.doc.create({ data: { title: 'stamped' } })
      return scoped.doc.findMany({})
    }))
    expect(seen.map((d: any) => [d.workspaceId, d.title])).toEqual([['w1', 'stamped']])
    expect((await db.asSystem().doc.findMany({})).length).toBe(2)
  })

  test('fn is handed the principal the client is scoped to, claim included, which $readAs needs', async () => {
    const db: any = await createClient({ db: ':memory:', schema: `
      tenancy { strategy row  column workspaceId  claim workspaceId }
      model Doc {
        id          Int    @id @default(autoincrement())
        workspaceId String
        title       String
      }` })
    const mine   = await db.asSystem().doc.create({ data: { workspaceId: 'w1', title: 'mine' } })
    const theirs = await db.asSystem().doc.create({ data: { workspaceId: 'w2', title: 'theirs' } })
    const app = createApp({ db, auth: USERS, principal: async (ctx: ServiceContext) => {
      const tenant = (ctx.app as any).tenant()
      return tenant ? { workspaceId: tenant } : {}
    } })
    await app._startForTest()

    const out = await app.runAs('u1', { tenant: 'w1' }, () => app.withDb(async (scoped: any, user: any) => ({
      claim:  user?.workspaceId,
      mine:   (await scoped.$readAs('doc', mine, toDataPrincipal(user)))?.title ?? null,
      theirs: (await scoped.$readAs('doc', theirs, toDataPrincipal(user)))?.title ?? null,
      bare:   (await scoped.$readAs('doc', mine, toDataPrincipal(app.principal()!)))?.title ?? null,
    })))
    // The last is the principal without the resolver's claim: refused its own
    // tenant's row, which is why the callback is handed the claimed one.
    expect(out).toEqual({ claim: 'w1', mine: 'mine', theirs: null, bare: null })
  })
})
