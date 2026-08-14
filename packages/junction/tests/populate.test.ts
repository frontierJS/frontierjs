// tests/populate.test.ts — asking for a relation from the browser (FJS-084).
//
// The wire and the server both understood `$populate` from the start: the
// bridge parsed it into ctx.directives, the litestone base turned it into an
// `include`. The browser client had no way to say it — `FindParams` was
// {query, offset, limit, orderBy, select} — so a component could not declare
// its own data shape and over-fetching was decided server-side in a hook.
//
// Two halves are asserted here because they fail apart: the client has to EMIT
// the directive on both transports, and the server has to answer it with real
// related rows. The second half runs against a real Litestone client, since a
// relation is exactly the thing a plain-object fake cannot have.

import { describe, test, expect, mock } from 'bun:test'
import { createJunctionClient } from '../src/client/index.ts'
import { createClient } from '../../litestone/src/index.js'
import { createService } from '../src/core/service.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

function mockFetch(body: unknown) {
  const original = globalThis.fetch
  const stub = mock(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  )
  globalThis.fetch = stub as unknown as typeof fetch
  return {
    restore: () => { globalThis.fetch = original },
    // `calls` is typed from the stub's own (zero-argument) signature, so the
    // recorded arguments have to be read back as what fetch was actually given.
    url:     () => new URL((stub.mock.calls as unknown as string[][])[0]![0]!),
  }
}

describe('the client can ask for a relation', () => {

  const client = () => createJunctionClient({ url: 'http://localhost:3000' })

  test('find sends $populate', async () => {
    const { restore, url } = mockFetch([])
    await client().service('orders').find({}, { populate: 'customer' })
    expect(url().searchParams.get('$populate')).toBe('customer')
    restore()
  })

  test('an array of relations travels as the server spells it', async () => {
    // Comma-joined, because parsePopulate() splits on commas — one grammar,
    // not a client dialect the server has to be taught.
    const { restore, url } = mockFetch([])
    await client().service('orders').find({}, { populate: ['customer', 'items'] })
    expect(url().searchParams.get('$populate')).toBe('customer,items')
    restore()
  })

  test('the field-picking form is passed through untouched', async () => {
    const { restore, url } = mockFetch([])
    await client().service('orders').find({}, { populate: 'customer:name+email' })
    expect(url().searchParams.get('$populate')).toBe('customer:name+email')
    restore()
  })

  test('a by-id get carries it too', async () => {
    // params was accepted and dropped on the by-id path, so the shape a detail
    // page wants most silently answered the bare row.
    const { restore, url } = mockFetch({ id: '1' })
    await client().service('orders').get('1', { populate: 'customer' })
    expect(url().pathname).toBe('/orders/1')
    expect(url().searchParams.get('$populate')).toBe('customer')
    restore()
  })

  test('the WebSocket frame carries the same directive', async () => {
    // The client prefers the socket whenever one is up, so a directive on the
    // HTTP builder alone is a difference nothing can see from the call site.
    const c = client() as unknown as {
      _wsReady: boolean
      _ws: { send: (s: string) => void; readyState: number }
      _wsCallMap: Map<string, { resolve: (v: unknown) => void }>
      service: (n: string) => { find: (q: unknown, p: unknown) => Promise<unknown> }
    }
    const sent: string[] = []
    c._wsReady = true
    c._ws = { send: (s: string) => { sent.push(s) }, readyState: 1 }

    const pending = c.service('orders').find({}, { populate: 'customer' })
    const frame = JSON.parse(sent[0]!)
    expect(frame.meta.query['$populate']).toBe('customer')

    // Settle the call so the test does not leave a pending timer behind.
    c._wsCallMap.get(frame.id)!.resolve({ kind: 'list', data: [], total: 0 })
    await pending
  })
})

describe('and the server answers it with real rows', () => {

  async function mkDb() {
    return await createClient({
      db: ':memory:',
      schema: `
        model Customer {
          id     Int     @id
          name   String
          orders Order[]
        }
        model Order {
          id         Int      @id
          reference  String
          customerId Int
          customer   Customer @relation(fields: [customerId], references: [id])
        }
      `,
    }) as unknown as Record<string, never> & {
      asSystem(): Record<string, { create(a: unknown): Promise<unknown> }>
    }
  }

  function ctx(db: unknown, over: Record<string, unknown> = {}): ServiceContext {
    return {
      service: 'orders', method: 'find', id: undefined, data: null,
      params: {}, query: {}, auth: {}, client: {},
      locals: { db }, app: {},
      ...over,
    } as unknown as ServiceContext
  }

  test('$populate on the query reaches the include and the relation comes back', async () => {
    const db = await mkDb()
    await db.asSystem().customer!.create({ data: { id: 1, name: 'Ada' } })
    await db.asSystem().order!.create({ data: { id: 1, reference: 'ORD-1', customerId: 1 } })

    const svc = createService({ name: 'orders', model: 'order' })
    const out = await svc.find(ctx(db, { query: { $populate: 'customer' } })) as {
      data: { customer?: { name: string } }[]
    }

    expect(out.data).toHaveLength(1)
    expect(out.data[0]!.customer?.name).toBe('Ada')
  })

  test('without it the relation is absent — over-fetching is not the default', async () => {
    const db = await mkDb()
    await db.asSystem().customer!.create({ data: { id: 1, name: 'Ada' } })
    await db.asSystem().order!.create({ data: { id: 1, reference: 'ORD-1', customerId: 1 } })

    const svc = createService({ name: 'orders', model: 'order' })
    const out = await svc.find(ctx(db)) as { data: { customer?: unknown }[] }

    expect(out.data[0]!.customer).toBeUndefined()
  })
})
