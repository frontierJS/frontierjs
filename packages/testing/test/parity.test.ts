// parity.test.ts — the transport contract, and the ways it can be worthless.
//
// The runner itself is the thing under test here. A differential check that
// silently compares one implementation against itself passes everything, which
// is the failure mode this whole realm exists to make visible — so most of what
// follows is about the runner reporting that it could not grade something,
// rather than about two transports agreeing.

import { describe, expect, test }            from 'bun:test'
import { join }                              from 'node:path'
import { createApp, createService, channels } from '@frontierjs/junction'
import type { ServiceContext }               from '@frontierjs/junction'
import { GatePlugin }                        from '@frontierjs/litestone'
import { createTestEnv }                     from '../src/index.ts'

const SCHEMA = join(import.meta.dir, 'fixtures', 'schema.lite')

const gate = new GatePlugin({
  getLevel: (u: any) => (!u ? 0 : u.isAdmin ? 5 : u.role === 'member' ? 4 : 2),
})

const USERS: Record<string, any> = {
  'tok-member': { userId: 'u-member', userType: 'user', authMethod: 'session', role: 'member' },
  'tok-admin':  { userId: 'u-admin',  userType: 'user', authMethod: 'session', role: 'member', isAdmin: true },
}

/** The app's own auth. A token maps to a session; anything else is anonymous. */
const auth = {
  async verifySession(t: string) { return USERS[t] ?? null },
  async login()        { return { token: '', user: null as never } },
  async logout()       {},
  async createUser()   { return {} as never },
  async deleteUser()   {},
  async createApiKey(id: string) { return { key: id, id } },
  async revokeApiKey() {},
  async verifyApiKey() { return null },
}

interface BuildOpts {
  /** Off for the test that proves an unconnected socket is reported, not ignored. */
  sockets?: boolean
  leadHooks?: Record<string, unknown>
}

function buildApp(db: unknown, { sockets = true, leadHooks }: BuildOpts = {}) {
  const app = createApp({ db, auth: auth as never, config: { database: { url: '', log: false } } })
  app.services.register(createService({
    name: 'leads', model: 'Lead', hooks: leadHooks as never,
    // A custom action, because it reaches the two transports by different names:
    // `action()` is a POST with an X-Service-Method header, `call()` is a frame
    // whose `method` IS the action. Nothing else in the derived set covers it.
    async qualify(ctx: ServiceContext) {
      ctx.dispatch = false     // read-shaped; it answers no row and announces nothing
      return { id: ctx.id, by: (ctx.auth?.user as { userId?: string })?.userId ?? null }
    },
  } as never))
  app.services.register(createService({ name: 'accounts', model: 'Account' }))
  if (sockets) app.configure(channels())
  return app
}

async function env(opts: BuildOpts & Record<string, unknown> = {}) {
  const { sockets, leadHooks, ...rest } = opts
  return await createTestEnv({
    schema:  SCHEMA,
    plugins: [gate],
    listen:  true,
    api:     ({ db }: any) => buildApp(db, { sockets, leadHooks }),
    ...rest,
  }) as any
}

const THREE = [
  { label: 'anonymous', token: null },
  { label: 'member',    token: 'tok-member' },
  { label: 'admin',     token: 'tok-admin' },
]

describe('verifyTransportParity', () => {

  test('an ephemeral port is bound and read back', async () => {
    // Asked for as 0 so parallel suites cannot collide. Without reading it back
    // there is no URL to give anything, which is why `http.port` exists.
    const e = await env()
    expect(e.port).toBeGreaterThan(0)
    expect(e.url).toBe(`http://127.0.0.1:${e.port}`)
    await e.close()
  })

  test('no port without `listen`, and the runner says so rather than guessing', async () => {
    const e = await createTestEnv({
      schema: SCHEMA, plugins: [gate], api: ({ db }: any) => buildApp(db),
    }) as any
    expect(e.url).toBeNull()
    expect(() => e.verifyTransportParity()).toThrow(/listen: true/)
    await e.close()
  })

  test('the two transports agree on every derived call, at three levels', async () => {
    const e = await env()
    const found = await e.verifyTransportParity({ as: THREE })
    expect(found).toEqual([])
    await e.close()
  }, 30_000)

  // ── The ways this check can be worthless ───────────────────────────────────

  test('an app with no channels() is reported, not compared against itself', async () => {
    // The failure this exists to catch: the browser client falls back to HTTP
    // when no socket is connected, so a runner that did not notice would compare
    // HTTP against HTTP, agree on everything, and certify a transport it never
    // spoke to.
    const e = await env({ sockets: false })
    const found = await e.verifyTransportParity({ as: [{ label: 'member', token: 'tok-member' }] })

    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe('error')
    expect(found[0].message).toMatch(/no WebSocket connected/)
    expect(found[0].message).toMatch(/channels\(\)/)
    await e.close()
  }, 30_000)

  test('an empty call list is a reported failure, not a pass', async () => {
    const e = await env()
    const found = await e.verifyTransportParity({ calls: [] })
    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe('error')
    expect(found[0].message).toMatch(/empty/)
    await e.close()
  })

  // ── Falsifiable ────────────────────────────────────────────────────────────

  test('a service that behaves differently over the socket is caught', async () => {
    // § Generator acceptance: a category nothing can falsify is worth nothing,
    // and its absence is invisible. This is the change that makes it fail —
    // staged in the app rather than by breaking Junction, so the test pins the
    // runner and not a particular defect.
    const e = await env({
      leadHooks: {
        before: {
          find: [function refuseOverSockets(ctx: ServiceContext) {
            if (ctx.transport === 'websocket') throw Object.assign(new Error('nope'), { status: 418 })
          }],
        },
      },
    })

    const found = await e.verifyTransportParity({
      as:    [{ label: 'member', token: 'tok-member' }],
      calls: [{ service: 'leads', method: 'find' }],
    })

    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe('verdict')
    expect(found[0].call).toBe('leads.find')
    expect(found[0].message).toMatch(/HTTP answered and WS refused with 418/)
    await e.close()
  }, 30_000)

  test('a custom action agrees across the two spellings it has', async () => {
    // Over HTTP an action is POST /{service}/{id} with X-Service-Method; over the
    // socket it is a frame whose `method` is the action name. Two routes to the
    // same handler, and the id and the principal travel differently on each.
    const e = await env()
    const found = await e.verifyTransportParity({
      as:    [{ label: 'member', token: 'tok-member' }],
      calls: [{ service: 'leads', method: 'qualify', id: 42 }],
    })
    expect(found).toEqual([])
    await e.close()
  }, 30_000)

  test('a result that differs only in a generated value is not a mismatch', async () => {
    // Every `create` returns a fresh id and a fresh createdAt, so a naive
    // comparison fails on every write. Volatility is measured by making the same
    // call twice over one transport — nothing here names `id` or `createdAt`.
    const e = await env()
    await e.system.account.create({ data: { id: 900, name: 'acme' } })

    const found = await e.verifyTransportParity({
      as:    [{ label: 'admin', token: 'tok-admin' }],
      calls: [{ service: 'leads', method: 'create', data: { name: 'x', accountId: 900 } }],
    })
    expect(found).toEqual([])
    await e.close()
  }, 30_000)
})
