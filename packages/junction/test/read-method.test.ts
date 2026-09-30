// test/read-method.test.ts — a custom method declared `read: true` (FJS-D505).
//
// A custom method was a write to junction, so a search whose answer echoes its
// query had that answer kept for 24 hours under an Idempotency-Key (FJS-1412)
// and published on the bus unless every method remembered `$.dispatch = false`
// (FJS-1403). These pin both halves for a declared read, and that an
// undeclared custom method is still the write it always was.

import { describe, test, expect } from 'bun:test'
import { createTestApp } from '../src/testing/index.ts'
import { createService, callService } from '../src/core/service.ts'
import { enterRequest } from '../src/core/context.ts'
import { bridge } from '../src/transport/bridge.ts'

function searchService() {
  const calls = { search: 0, reboot: 0, aggregate: 0 }
  const svc = createService({
    name: 'usages',
    methods: [{ method: 'search', read: true }, 'reboot', 'aggregate'],
    search:    async (ctx) => { calls.search++;    return { q: (ctx.data as { q: string }).q, n: calls.search } },
    reboot:    async ()    => { calls.reboot++;    return { id: '1', n: calls.reboot } },
    aggregate: async ()    => { calls.aggregate++; return { count: calls.aggregate } },
  })
  return { svc, calls }
}

async function call(
  app:    Awaited<ReturnType<typeof createTestApp>>,
  svc:    ReturnType<typeof createService>,
  method: string,
  key?:   string,
) {
  const ctx = bridge.internal(svc.name, method as 'create', { q: 'canary-7f3a' }, {
    auth: { user: { userId: 'u1' } as never },
  }, app)
  ctx.method = method
  await enterRequest(
    { correlationId: 'c1', idempotencyKey: key, origin: 'internal' },
    () => callService(svc, ctx, app._appHooks, app.events, app.telemetry)
  )
  return (ctx.result as { data: { n?: number } }).data
}

describe('an Idempotency-Key keeps no answer from a read', () => {

  test('a declared read runs every time the key is repeated', async () => {
    const app = await createTestApp()
    const { svc, calls } = searchService()
    const a = await call(app, svc, 'search', 'k1')
    const b = await call(app, svc, 'search', 'k1')
    expect(calls.search).toBe(2)
    expect(b.n).toBe(2)
    expect(a.n).toBe(1)
  })

  test('an undeclared custom method is still a write, and replays', async () => {
    const app = await createTestApp()
    const { svc, calls } = searchService()
    await call(app, svc, 'reboot', 'k1')
    const b = await call(app, svc, 'reboot', 'k1')
    expect(calls.reboot).toBe(1)
    expect(b.n).toBe(1)
  })

  test('aggregate is a read by its name', async () => {
    const app = await createTestApp()
    const { svc, calls } = searchService()
    await call(app, svc, 'aggregate', 'k1')
    await call(app, svc, 'aggregate', 'k1')
    expect(calls.aggregate).toBe(2)
  })
})

describe('a declared read announces nothing', () => {

  test('the bus hears the write and not the read', async () => {
    const app = await createTestApp()
    const { svc } = searchService()
    const heard: string[] = []
    app.events.on('usages:search', () => { heard.push('search') })
    app.events.on('usages:reboot', () => { heard.push('reboot') })

    await call(app, svc, 'search')
    await call(app, svc, 'reboot')
    await new Promise(r => setTimeout(r, 10))

    expect(heard).toEqual(['reboot'])
  })
})

describe('the declaration', () => {

  test('describe() names the declared reads', () => {
    const { svc } = searchService()
    expect(svc.describe().readMethods).toEqual(['search'])
  })

  test('read: is refused unless it is true or false', () => {
    expect(() => createService({
      name: 'usages',
      methods: [{ method: 'search', read: 'yes' as never }],
      search: async () => ({}),
    })).toThrow(/declares read "yes", which is not true or false/)
  })

  test('read: on a CRUD verb is refused, since its name already says', () => {
    expect(() => createService({
      name: 'usages',
      methods: [{ method: 'create', read: true }],
    })).toThrow(/create is a CRUD verb/)
  })
})
