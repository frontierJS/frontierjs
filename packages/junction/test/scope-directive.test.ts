// test/scope-directive.test.ts — a `@@scope` asked for by name, over the wire
//
// `$scope` is the one spelling of a schema-declared predicate a browser can send
// (`FJS-D63`), and a value set's `where` mints one so a picker offers exactly
// the list the Data boundary accepts (`FJS-430`). The bridge refuses a `$` name
// its table does not hold and the parse strips every `$` key from the filters
// (`FJS-D237`), so a scope sent as a filter was a 400 and every narrowed picker
// read 'No options' (`FJS-2561`). It is a directive, and the adapter hands it
// to Litestone as `where.$scope`.

import { describe, test, expect } from 'bun:test'
import { createClient }         from '../../litestone/src/index.js'
import { createService }        from '../src/core/service.ts'
import { createJunctionClient } from '../src/client/index.ts'
import { encodeQueryString }    from '@frontierjs/toolbelt/query'
import type { QueryDirectives } from '../src/core/directives.ts'

async function tags() {
  const db = await createClient({
    db: ':memory:',
    schema: `
      model Tag {
        id    Int    @id
        kind  String
        name  String
        @@scope(contact, kind == 'contact')
        @@scope(low, id < 2 || kind == 'job')
      }
    `,
  }) as unknown as Record<string, never> & { asSystem(): any, $close(): void }

  const sys = db.asSystem()
  await sys.tag.create({ data: { id: 1, kind: 'contact', name: 'vip' } })
  await sys.tag.create({ data: { id: 2, kind: 'contact', name: 'lead' } })
  await sys.tag.create({ data: { id: 3, kind: 'job',     name: 'big' } })
  return db
}

async function appWith(db: unknown) {
  const { createApp, defaultConfig, channels } = await import('../index.ts')
  const app: any = createApp({
    db,
    config: {
      port: 0, services: { dir: '/nonexistent' },
      http: { ...defaultConfig.http, drainTimeout: 50 },
    },
  } as never)
  app.configure(channels() as never)
  app.services.register(createService({ name: 'tags', model: 'Tag' }))
  await app.start()
  return app
}

const get = async (app: any, search: string) => {
  const res = await app.http.fetch(new Request('http://localhost/tags' + search))
  return { status: res.status, body: await res.json() as any }
}

describe('$scope over HTTP', () => {
  test('one name narrows the list to the scope', async () => {
    const db  = await tags()
    const app = await appWith(db)
    const { status, body } = await get(app, encodeQueryString({ $scope: ['contact'], $orderBy: 'id' }))
    expect(status).toBe(200)
    expect(body.data.map((r: any) => r.id)).toEqual([1, 2])
    db.$close(); await app.stop()
  })

  test('a bare name is one scope, and two names AND', async () => {
    const db  = await tags()
    const app = await appWith(db)
    expect((await get(app, '?$scope=contact&$orderBy=id')).body.data.map((r: any) => r.id)).toEqual([1, 2])
    const both = await get(app, encodeQueryString({ $scope: ['contact', 'low'] }))
    expect(both.body.data.map((r: any) => r.id)).toEqual([1])
    db.$close(); await app.stop()
  })

  test('a scope conjoins with an ordinary filter', async () => {
    const db  = await tags()
    const app = await appWith(db)
    const { body } = await get(app, encodeQueryString({ name: 'lead', $scope: ['contact'] }))
    expect(body.data.map((r: any) => r.id)).toEqual([2])
    db.$close(); await app.stop()
  })

  test('a name the model does not declare is refused by name, never answered unscoped', async () => {
    const db  = await tags()
    const app = await appWith(db)
    const { status, body } = await get(app, '?$scope=nope')
    expect(status).toBe(400)
    expect(JSON.stringify(body)).toMatch(/nope/)
    db.$close(); await app.stop()
  })
})

describe('$scope from the client', () => {
  const client = () => createJunctionClient({ url: 'http://localhost:3000' })

  test('the scope directive goes out as $scope on both transports', async () => {
    const d: QueryDirectives = { scope: ['contact'] }

    let asked = ''
    const original = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
      asked = String(url)
      return new Response(JSON.stringify({ kind: 'list', object: 'items', data: [], total: 0 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    await client().service('tags').find({}, d)
    globalThis.fetch = original
    expect(new URL(asked).searchParams.getAll('$scope[]')).toEqual(['contact'])

    const c = client() as unknown as {
      _wsReady: boolean
      _wsCall: (svc: string, method: string, id: unknown, data: unknown, q: Record<string, unknown>) => Promise<unknown>
      service(name: string): { find(q?: unknown, d?: QueryDirectives): Promise<unknown> }
    }
    let sent: Record<string, unknown> = {}
    c._wsReady = true
    c._wsCall = async (_s, _m, _i, _d, q) => { sent = q; return { kind: 'list', object: 'items', data: [], total: 0 } }
    await c.service('tags').find({}, d)
    expect(sent.$scope).toEqual(['contact'])
  })
})

describe('$scope through the real client, down both transports', () => {
  test('the picker\'s read answers the scope\'s rows over HTTP and over the socket', async () => {
    const db  = await tags()
    const app = await appWith(db)
    const url = `http://127.0.0.1:${app.http.port}`

    const overHttp   = createJunctionClient({ url })
    const overSocket = createJunctionClient({ url }) as any
    overSocket.connect()
    for (let i = 0; i < 100 && !overSocket._wsReady; i++) await new Promise(r => setTimeout(r, 50))
    expect(overSocket._wsReady).toBe(true)

    for (const c of [overHttp, overSocket]) {
      const res: any = await c.service('tags').find({}, { scope: ['contact'], orderBy: 'id' })
      expect(res.data.map((r: any) => r.id)).toEqual([1, 2])
    }

    overSocket.disconnect?.()
    db.$close(); await app.stop()
  })
})
