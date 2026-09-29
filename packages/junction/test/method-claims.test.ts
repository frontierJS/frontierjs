// test/method-claims.test.ts
//
// `claims:` on a methods entry (`FJS-D514`) — the declaration for a method whose
// work touches no row, so no `@@allow` ever sees it. Portal's Privacy Pass
// search (`FJS-1437`) is the shape: a guest holding a pass may search, a guest
// holding nothing may not, and before this the only spelling was `gate: 0`,
// which admitted both.
//
// Against a real Litestone client, because the floor the method would take
// without `gate: 0` is read off the model's `@@gate`.

import { describe, test, expect } from 'bun:test'

import { createClient } from '../../litestone/src/index.js'
import { createApp, createService, header, defaultConfig } from '../index.ts'
import { collectMethodClaims } from '../src/core/service.ts'

const SCHEMA = `
  model Usage {
    id     Int    @id @default(autoincrement())
    passId String
    @@gate("4")
  }
`

const pass = header('x-portal-pass')

async function portal() {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA, claims: ['passId'] })
  const app: any = createApp({
    db,
    principal: (ctx: any) => {
      const v = pass(ctx)
      return v ? { passId: v } : {}
    },
    config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' },
              http: { ...defaultConfig.http, drainTimeout: 50 } },
  } as never)
  let ran = 0
  app.services.register(createService({
    name:    'usages',
    model:   'Usage',
    methods: ['find', { method: 'search', gate: 0, claims: ['passId'] }],
    async search() { ran++; return { results: [] } },
  }))
  app.setAuth({ verifySession: async (t: string) => t === 'member' ? { userId: 'u1', role: 'user' } : null })
  await app.start()

  const call = async (opts: { pass?: string; session?: string }) => {
    ran = 0
    const headers: Record<string, string> = { 'x-service-method': 'search', 'content-type': 'application/json' }
    if (opts.pass)    headers['x-portal-pass'] = opts.pass
    if (opts.session) headers.authorization = `Bearer ${opts.session}`
    const res = await app.http.fetch(new Request('http://localhost/usages/1', { method: 'POST', headers, body: '{}' }))
    return { status: res.status, ran }
  }
  return { app, call, close: async () => { await app.stop(); db.$close() } }
}

describe('methods: [{ claims }]', () => {

  test('a guest holding the claim is admitted, and one holding nothing is refused 401 before the body', async () => {
    const s = await portal()
    try {
      expect(await s.call({ pass: 'p-1' })).toEqual({ status: 200, ran: 1 })
      expect(await s.call({})).toEqual({ status: 401, ran: 0 })
    } finally { await s.close() }
  })

  test('a session lacking the claim is refused 403, and holding it is admitted', async () => {
    const s = await portal()
    try {
      expect(await s.call({ session: 'member' })).toEqual({ status: 403, ran: 0 })
      expect(await s.call({ session: 'member', pass: 'p-1' })).toEqual({ status: 200, ran: 1 })
    } finally { await s.close() }
  })

  test('describe() reports the requirement', async () => {
    const s = await portal()
    try {
      expect(s.app.services.get('usages').describe().methodClaims).toEqual({ search: ['passId'] })
    } finally { await s.close() }
  })

  test('a CRUD verb and a malformed list are refused where they are written', () => {
    expect(() => collectMethodClaims([{ method: 'find', claims: ['x'] }], 's')).toThrow(/@@allow/)
    expect(() => collectMethodClaims([{ method: 'go', claims: [] }], 's')).toThrow(/not a list/)
    expect(() => collectMethodClaims([{ method: 'go', claims: 'x' as never }], 's')).toThrow(/not a list/)
  })
})
