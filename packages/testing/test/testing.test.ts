// @frontierjs/testing — the API tier, against a real Litestone client and a real
// Junction app.
//
// Nothing here is stubbed. A fake client passed every test and failed every real
// one (house rule), and the whole claim of this package is that the derivation
// between the two realms is real: SessionContext → toDataPrincipal → the scoped
// client the service actually queries through.

import { describe, expect, test } from 'bun:test'
import { join }                   from 'node:path'
import { createApp, createService } from '@frontierjs/junction'
import { GatePlugin }             from '@frontierjs/litestone'
import { createTestEnv, session } from '../src/index.ts'

const SCHEMA = join(import.meta.dir, 'fixtures', 'schema.lite')

// The app's own grading. Deliberately reads fields off the SessionContext rather
// than being a constant: `atLevel` is the synthetic door, and a test about
// behavior has to go through this one.
const gate = new GatePlugin({
  getLevel: (user: any) => {
    if (!user)             return 0
    if (user.isAdmin)      return 5
    if (user.role === 'member') return 4
    return 2
  },
})

function buildApp(db: unknown) {
  const app = createApp({ db })
  app.services.register(createService({ name: 'leads',    model: 'Lead' }))
  app.services.register(createService({ name: 'accounts', model: 'Account' }))
  return app
}

async function env(extra: Record<string, unknown> = {}) {
  return await createTestEnv({
    schema:  SCHEMA,
    plugins: [gate],
    api:     ({ db }) => buildApp(db),
    ...extra,
  }) as any
}

const member = session({ userId: 'u-member', role: 'member' })
const admin  = session({ userId: 'u-admin',  role: 'member', isAdmin: true })
const reader = session({ userId: 'u-reader', role: 'reader' })

describe('createTestEnv — the API tier', () => {

  test('without `api` it is the Data-realm env unchanged', async () => {
    const e = await createTestEnv({ schema: SCHEMA, plugins: [gate] }) as any
    expect(e.app).toBeUndefined()
    expect(typeof e.actingAs).toBe('function')
    expect(typeof e.phases).toBe('function')
    e.close()
  })

  test('the app is built over the env database, not one of its own', async () => {
    // The failure this prevents: an app that opened its own client would pass
    // every service test while the factories wrote somewhere else entirely.
    const e = await env()
    await e.system.account.create({ data: { id: 1, name: 'acme' } })
    await e.system.lead.create({ data: { id: 1, name: 'via the client', accountId: 1 } })

    const res: any = await e.as(member).service('leads').find()
    expect(res.data.map((r: any) => r.name)).toEqual(['via the client'])
    await e.close()
  })

  test('a principal is graded by the app`s own getLevel, through the whole stack', async () => {
    const e = await env()
    await e.system.account.create({ data: { id: 1, name: 'acme' } })

    // READER(2) may read, may not create. USER(4) may create. Neither may delete.
    await expect(e.as(reader).service('leads').find()).resolves.toBeDefined()
    await expect(e.as(reader).service('leads').create({ name: 'x', accountId: 1 }))
      .rejects.toThrow(/level 4|denied|forbidden/i)

    const made: any = await e.as(member).service('leads').create({ name: 'made', accountId: 1 })
    expect(made.name).toBe('made')

    await expect(e.as(member).service('leads').remove(made.id))
      .rejects.toThrow(/level 5|denied|forbidden/i)
    await expect(e.as(admin).service('leads').remove(made.id)).resolves.toBeDefined()
    await e.close()
  })

  test('no principal is refused, not silently unchecked', async () => {
    // A background job with no auth is refused. The anonymous caller has to be
    // reachable so a test can prove that — and worth recording that the refusal
    // arrives as `gateAuth()`'s 401 rather than the gate's own level message:
    // a model whose read gate is above STRANGER cannot be read anonymously at
    // all, so Junction answers before Litestone is consulted.
    const e = await env()
    await expect(e.service('leads').find()).rejects.toThrow(/Authentication required/i)
    await e.close()
  })

  test('a row policy sees the principal — userId became id somewhere', async () => {
    // The seam this tier exists for. `@@allow('read', ownerId == auth().id)` is
    // compiled into the WHERE, so a principal that arrives as `undefined`
    // returns an empty list with a 200 and nothing raises (FJS-097). Junction's
    // toDataPrincipal() renames userId → id; if it stops, this is what goes red.
    const e = await env()
    await e.system.account.create({ data: { id: 1, name: 'acme' } })
    await e.system.lead.createMany({ data: [
      { id: 1, name: 'mine',    accountId: 1, ownerId: 'u-member' },
      { id: 2, name: 'theirs',  accountId: 1, ownerId: 'u-other' },
      { id: 3, name: 'nobody`s', accountId: 1, ownerId: null },
    ] })

    const res: any = await e.as(member).service('leads').find()
    expect(res.data.map((r: any) => r.name).sort()).toEqual(['mine', 'nobody`s'])
    await e.close()
  })

  test('the principal is bound at the right argument, per method', async () => {
    // patch(id, data, opts) and find(query, opts) put CallOptions in different
    // places. Binding it by position-from-the-end would land `data` in `opts`
    // for one of them, and the call would run anonymous — a refusal, or worse,
    // an empty list.
    const e = await env()
    await e.system.account.create({ data: { id: 1, name: 'acme' } })
    const made: any = await e.as(member).service('leads').create({ name: 'a', accountId: 1 })

    const patched: any = await e.as(member).service('leads').patch(made.id, { name: 'b' })
    expect(patched.name).toBe('b')

    const found: any = await e.as(member).service('leads').find({ name: 'b' })
    expect(found.data).toHaveLength(1)

    const one: any = await e.as(member).service('leads').get(made.id)
    expect(one.name).toBe('b')
    await e.close()
  })

  test('a create payload with an `auth` key is data, not call options', async () => {
    // The exact reason OPTS_AT is a table. `create({ auth: … })` read as options
    // would send an empty payload and bind a nonsense principal, and both
    // failures are downstream of the call that caused them.
    const e = await env()
    await e.system.account.create({ data: { id: 1, name: 'acme' } })
    const made: any = await e.as(member).service('leads')
      .create({ name: 'a', accountId: 1, auth: 'not a call option' })
    // autoValidate strips the undeclared key; what matters is that the row was
    // created as the member, which an options-shaped read would not have done.
    expect(made.name).toBe('a')
    expect(made.id).toBeDefined()
    await e.close()
  })

  test('OPTS_AT covers every method Junction`s caller actually has', async () => {
    // The table is a hand copy of a signature list in another package, which is
    // the shape that drifts. This is the assertion that notices — it asks a real
    // caller rather than a list written here.
    const e = await env()
    expect(() => e.as(member).service('leads')).not.toThrow()
    await e.close()
  })

  test('a caller method with no known options position is refused, not guessed', async () => {
    const e = await env()
    const real = e.app.service
    // The binder's input is app.service(name); stub it to hand back a caller
    // carrying a method the table has never seen. This is the branch that fires
    // the day Junction grows a method, and it cannot be reached any other way.
    e.app.service = (name: string) => ({ ...(real.call(e.app, name) as object), sync: () => {} })
    expect(() => e.as(member).service('leads'))
      .toThrow(/does not know how to bind a principal to — sync/)
    e.app.service = real
    await e.close()
  })

  test('announced() reports what the act announced, and only that', async () => {
    const e = await env()
    await e.system.account.create({ data: { id: 1, name: 'acme' } })

    const t = e.phases({ as: member })
    // Arranging through a SERVICE announces — and it is not what the assertion
    // is about, which is why the buffer clears when the act begins.
    await t.arrange(() => e.as(member).service('leads').create({ name: 'setup', accountId: 1 }))
    expect(e.announced().length).toBeGreaterThan(0)

    await t.act(() => e.as(member).service('leads').create({ name: 'the act', accountId: 1 }))

    const events = e.announced()
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('leads:created')
    expect((events[0].data as any).name).toBe('the act')
    expect(e.announced('leads:created')).toHaveLength(1)
    expect(e.announced('leads:removed')).toHaveLength(0)
    await e.close()
  })

  test('a write below the boundary announces nothing', async () => {
    // arrange writes through asSystem(), which is the Data boundary — no service
    // ran, so nothing announced and every open tab keeps the stale row. That is
    // the documented cost of arranging that way, and this is what says so.
    const e = await env()
    const t = e.phases()
    await t.arrange(({ system }: any) => system.account.create({ data: { id: 1, name: 'acme' } }))
    await t.act(async () => {})
    expect(e.announced()).toHaveLength(0)
    await e.close()
  })

  test('http is Junction`s own helper against this app', async () => {
    const e = await env()
    await e.system.account.create({ data: { id: 1, name: 'acme' } })
    const res = await e.http.get('/leads')
    // No token, so the gate refuses — the point is that a real route answered.
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    await e.close()
  })

  test('setup and phases still work with an app mounted', async () => {
    const e = await env()
    const fx = await e.setup(async ({ system }: any) => {
      await system.account.create({ data: { id: 1, name: 'acme' } })
      return system.lead.create({ data: { id: 1, name: 'fixture', accountId: 1 } })
    })

    const a = e.phases({ as: member })
    await a.act(() => e.as(member).service('leads').create({ name: 'junk', accountId: 1 }))
    expect(await e.system.lead.count()).toBe(2)

    e.phases({ as: member })
    expect(await e.system.lead.count()).toBe(1)
    expect((await e.system.lead.findUnique({ where: { id: fx.id } })).name).toBe('fixture')
    await e.close()
  })
})

describe('session()', () => {
  test('fills the three required fields and invents nothing else', async () => {
    // Defaulting verifiedAt to null would grade every session it built down to
    // VISITOR(1) through sessionGateLevel — absent means the app does not model
    // the stage, and only null grades down.
    const s = session({ userId: 'u1' })
    expect(s).toEqual({ userId: 'u1', userType: 'user', authMethod: 'session' })
    expect('verifiedAt'   in s).toBe(false)
    expect('activatedAt'  in s).toBe(false)
    expect('isSystemAdmin' in s).toBe(false)
  })

  test('a stated field wins', () => {
    expect(session({ userId: 'u1', userType: 'admin', verifiedAt: null }).userType).toBe('admin')
  })
})
