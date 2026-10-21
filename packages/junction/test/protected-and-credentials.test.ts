// FJS-2089 (a withheld key is named), FJS-3291 (cross-origin cookie fetch),
// FJS-2258 + FJS-1158 (a protected column is not "missing").

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createClient } from '../../litestone/src/index.js'
import { buildService, callService } from '../src/core/service.ts'
import { withholdProtected, resetWithheldWarnings } from '../src/transport/bridge.ts'
import { resetAnnouncementWarnings } from '../src/core/litestone.ts'
import { createJunctionClient } from '../src/client/index.ts'
import { createTestApp, request } from '../src/testing/index.ts'
import { cors } from '../index.ts'
import { setCallDb } from '../index.ts'

const warnings: string[] = []
const realWarn = console.warn
beforeEach(() => {
  resetAnnouncementWarnings(); resetWithheldWarnings()
  warnings.length = 0
  console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')) }
})
afterEach(() => { console.warn = realWarn })

const fakeDb = { $protectedFields: (a: string) => (a === 'invite' ? { token: 'guarded' } : {}) }

describe('FJS-2089 withholdProtected names what it dropped', () => {
  test('a custom method warns once, naming the key and the way out', () => {
    const ctx = setCallDb({ service: 'invites', model: 'invite', method: 'link', locals: {} }, fakeDb) as never
    expect(withholdProtected({ token: 's', other: 1 }, ctx)).toEqual({ other: 1 })
    withholdProtected({ token: 's' }, ctx)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('invites.link')
    expect(warnings[0]).toContain('token')
    expect(warnings[0]).toContain('return it under another key')
  })
  test('a CRUD answer drops in silence', () => {
    const ctx = setCallDb({ service: 'invites', model: 'invite', method: 'find', locals: {} }, fakeDb) as never
    withholdProtected({ token: 's', other: 1 }, ctx)
    expect(warnings).toEqual([])
  })
})

describe('FJS-3291 credentials on the browser client fetch', () => {
  const realFetch = globalThis.fetch
  const g = globalThis as { location?: unknown }
  let init: RequestInit | undefined
  beforeEach(() => {
    init = undefined
    globalThis.fetch = (async (_u: unknown, i: RequestInit) => {
      init = i
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
    }) as never
    g.location = { origin: 'https://app.example' }
  })
  afterEach(() => { globalThis.fetch = realFetch; delete g.location })

  test('cookie mode + another origin includes credentials, on both paths', async () => {
    const c = createJunctionClient({ url: 'https://api.example', cookieAuth: true })
    await c.fetch('/x')
    expect(init?.credentials).toBe('include')
    init = undefined
    // the stub answers no list envelope, so find() throws after the request left
    await c.service('things').find().catch(() => {})
    expect((init as RequestInit | undefined)?.credentials).toBe('include')
  })
  test('same origin, or Bearer mode, leaves the default', async () => {
    await createJunctionClient({ url: 'https://app.example', cookieAuth: true }).fetch('/x')
    expect(init?.credentials).toBeUndefined()
    await createJunctionClient({ url: 'https://api.example' }).fetch('/x')
    expect(init?.credentials).toBeUndefined()
  })
  test('cors({ credentials }) echoes the origin, never *, and varies on it', async () => {
    const app = await createTestApp({ services: [] })
    app.configure(cors({ origins: ['https://app.example'], credentials: true }))
    app.post('/p', async () => ({ ok: true }))
    const r = await request(app).post('/p').set('Origin', 'https://app.example').send({})
    expect(r.headers['access-control-allow-origin']).toBe('https://app.example')
    expect(r.headers['access-control-allow-credentials']).toBe('true')
    expect(String(r.headers['vary'])).toContain('Origin')
  })
})

describe('FJS-2258 a protected column is not missing from the answer', () => {
  async function mk() {
    const db: any = await createClient({ db: ':memory:', encryptionKey: 'a'.repeat(64), schema: `
      model Invite { id Int @id
        name String
        note String?
        pw String @encrypted }` } as never)
    await db.asSystem().invite.create({ data: { id: 1, name: 'x', pw: 'p' } })
    return db
  }
  const ctxFor = (db: unknown, method: string) => setCallDb({
    service: 'invites', method, id: 1, data: null, query: {}, user: null, caller: {},
    route: {}, locals: {}, app: {}, result: null, directives: {},
  }, db) as never
  const events = { emit() {} }

  test('answering every readable column is whole', async () => {
    const db = await mk()
    const svc = buildService({ name: 'invites', model: 'invite',
      async touch() { return { id: 1, name: 'x', note: null } } } as never)
    await callService(svc as never, ctxFor(db, 'touch'), undefined, events as never)
    expect(warnings).toEqual([])
  })
  test('a genuinely missing readable column still warns, without the protected one', async () => {
    const db = await mk()
    const svc = buildService({ name: 'invites', model: 'invite',
      async touch() { return { id: 1, name: 'x' } } } as never)
    await callService(svc as never, ctxFor(db, 'touch'), undefined, events as never)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('note')
    expect(warnings[0]).not.toContain('pw')
  })
})
