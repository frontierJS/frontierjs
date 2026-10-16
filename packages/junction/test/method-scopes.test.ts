// test/method-scopes.test.ts
//
// FJS-2116 / FJS-D916 — a key's scopes narrow what it may call.
//
// The defect: a key issued `scopes: ['ela']` authenticated as its issuer at
// every method, because nothing read the scopes. sstime gave up on keys for
// its machine reader; portal and basecamp each built a hook. The refusal is
// now junction's, in callService, and these tests hold the three answers it
// owes: a session and a whole key are held to nothing, a scoped key reaches
// only what names a scope it holds, and a method naming none refuses one.
// Over HTTP, since the refusal is graded at the edge and an internal call is
// not — the last test is that half.

import { describe, expect, test } from 'bun:test'
import { createApp, defaultConfig, scopeRefusal } from '../index.ts'
import { buildService } from '../src/core/service.ts'

const TOKENS: Record<string, { scopes?: string[] }> = {
  session:   {},
  whole:     { scopes: [] },
  reader:    { scopes: ['clock:read'] },
  writer:    { scopes: ['clock:read', 'clock:write'] },
  stranger:  { scopes: ['billing'] },
}

async function clockApp() {
  const ran: string[] = []
  const app: any = createApp({
    config: { port: 0, services: { dir: '/nonexistent' },
              http: { ...defaultConfig.http, drainTimeout: 50 } },
  })
  app.services.register(buildService({
    name:    'clock',
    scope:   { read: 'clock:read', write: 'clock:write' },
    methods: ['find', 'create', { method: 'tally', read: true }, { method: 'whoami', scope: false }],
    async find()   { ran.push('find');   return [] },
    async create() { ran.push('create'); return { id: 1 } },
    async tally()  { ran.push('tally');  return { total: 0 } },
    async whoami() { ran.push('whoami'); return { ok: true } },
  }))
  app.services.register(buildService({
    name: 'audit',
    async find() { ran.push('audit.find'); return [await app.service('clock').find({})].flat() },
  }))
  app.services.register(buildService({
    name:    'relay',
    scope:   'clock:read',
    async pull(ctx: any) { ran.push('relay.pull'); return app.service('audit').find({}, { auth: ctx.auth }) },
  }))
  app.setAuth({
    verifySession: async (t: string) => t in TOKENS
      ? { userId: 'u1', authMethod: t === 'session' ? 'session' : 'apiKey', ...TOKENS[t] }
      : null,
  })
  await app.start()

  const call = async (token: string, path: string, init: { method?: string; custom?: string } = {}) => {
    ran.length = 0
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    if (init.custom) headers['x-service-method'] = init.custom
    const method = init.custom ? 'POST' : init.method ?? 'GET'
    const res = await app.http.fetch(new Request(`http://localhost${path}`, {
      method, headers, ...(method === 'GET' ? {} : { body: '{}' }),
    }))
    return { status: res.status, ran: [...ran], body: res.status >= 400 ? await res.json() : null }
  }
  return { app, call }
}

describe('scope: on a service and on a method', () => {

  test('a session and a key issued whole are held to no scope', async () => {
    const { app, call } = await clockApp()
    try {
      for (const token of ['session', 'whole']) {
        expect((await call(token, '/clock')).status).toBe(200)
        expect((await call(token, '/clock', { method: 'POST' })).status).toBe(201)
        expect((await call(token, '/audit')).status).toBe(200)
      }
    } finally { await app.stop() }
  })

  test('{ read, write } splits on the read line, a declared read custom method included', async () => {
    const { app, call } = await clockApp()
    try {
      expect(await call('reader', '/clock')).toMatchObject({ status: 200, ran: ['find'] })
      expect(await call('reader', '/clock/1', { custom: 'tally' })).toMatchObject({ status: 200, ran: ['tally'] })
      const refused = await call('reader', '/clock', { method: 'POST' })
      expect(refused).toMatchObject({ status: 403, ran: [] })
      expect(JSON.stringify(refused.body)).toContain(`needs the 'clock:write' scope`)
      expect((await call('writer', '/clock', { method: 'POST' })).status).toBe(201)
    } finally { await app.stop() }
  })

  test('a scoped key is refused a method that states no scope, before any hook or body runs', async () => {
    const { app, call } = await clockApp()
    try {
      const r = await call('writer', '/audit')
      expect(r).toMatchObject({ status: 403, ran: [] })
      expect(JSON.stringify(r.body)).toContain('audit.find states no scope')
      expect((await call('stranger', '/clock')).status).toBe(403)
    } finally { await app.stop() }
  })

  test('scope: false admits any key', async () => {
    const { app, call } = await clockApp()
    try {
      expect(await call('stranger', '/clock/1', { custom: 'whoami' })).toMatchObject({ status: 200, ran: ['whoami'] })
    } finally { await app.stop() }
  })

  test('an internal call inside an admitted one is not graded again', async () => {
    const { app, call } = await clockApp()
    try {
      expect(await call('reader', '/relay/1', { custom: 'pull' }))
        .toMatchObject({ status: 200, ran: ['relay.pull', 'audit.find', 'find'] })
    } finally { await app.stop() }
  })

  test('describe() reports every method resolved, and scopeRefusal is the one reading', async () => {
    const { app } = await clockApp()
    try {
      const clock = app.services.get('clock')
      // Only what the service answers: `methods:` narrowed it to four.
      expect(clock.describe().scopes).toEqual({
        find: 'clock:read', create: 'clock:write', tally: 'clock:read', whoami: false,
      })
      expect(app.services.get('audit').describe().scopes).toEqual({})
      expect(scopeRefusal(clock, 'create', { scopes: ['clock:read'] })).toBe(`clock.create needs the 'clock:write' scope`)
      expect(scopeRefusal(clock, 'create', { scopes: [] })).toBeNull()
      expect(scopeRefusal(clock, 'create', null)).toBeNull()
    } finally { await app.stop() }
  })

  test('a malformed declaration is refused where it is written', () => {
    expect(() => buildService({ name: 'x', scope: '' as never, async find() { return [] } }))
      .toThrow(/scope "" is not a scope name/)
    expect(() => buildService({ name: 'x', scope: { read: 'x:read' } as never, async find() { return [] } }))
      .toThrow(/not a scope name/)
    expect(() => buildService({ name: 'x', methods: [{ method: 'find', scope: true as never }], async find() { return [] } }))
      .toThrow(/find declares scope true/)
  })
})
