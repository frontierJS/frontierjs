// tests/query-directives.test.ts
//
// `$` is TRANSPORT SYNTAX — a way of saying "this key is a directive, not a
// column" inside a flat query string. It stops at the bridge.
//
// It used not to. The bridge stripped $limit/$offset/$orderBy/$select from
// ctx.query as "reserved params", and parseQuery — the query builder — then
// looked for exactly those four keys on ctx.query and found nothing. The
// transport deleted precisely what the service layer was written to read, so
// pagination, ordering and field selection were ALL inert over HTTP:
//
//   ?$limit=1       → every row      ?$orderBy=-id   → unsorted
//   ?$offset=1      → every row      ?$select=title  → every column
//
// and the unprefixed spelling was worse: `?limit=1` isn't reserved, so it
// became a WHERE clause on a column named "limit" and returned zero rows — a
// silently wrong answer rather than an error.

import { describe, test, expect } from 'bun:test'
import { createTestApp, request } from '../src/testing/index.ts'
import { createService } from '../src/core/service.ts'
import { bridge } from '../src/transport/bridge.ts'
import { parseQuery } from '../src/core/litestone.ts'

// Echoes what the service layer actually received.
function echoService() {
  return createService({
    name: 'things',
    find: async (ctx) => ({
      total: 0, limit: 0, offset: 0,
      data: [{ query: ctx.query, directives: ctx.directives }],
    }),
  })
}

const seen = async (qs: string) => {
  const app = await createTestApp({ services: [() => echoService()] })
  const res = await request(app).get(`/things${qs}`)
  return (res.body as { data: Array<{ query: unknown; directives: unknown }> }).data[0]!
}

describe('the bridge splits the query string in two', () => {

  test('filters stay in ctx.query, directives go to ctx.directives', async () => {
    const got = await seen('?status=open&$limit=5&$offset=10')
    expect(got.query).toEqual({ status: 'open' })
    expect(got.directives).toEqual({ limit: 5, offset: 10 })
  })

  test('no `$` key ever reaches ctx.query', async () => {
    const got = await seen('?$limit=5&$offset=1&$orderBy=-id&$select=title&$populate=author&$search=hi&$withDeleted=true')
    expect(Object.keys(got.query as object)).toHaveLength(0)
  })

  test('directives are typed, not stringly', async () => {
    // ctx.query values are strings off the wire; a directive is a number.
    const got = await seen('?$limit=5&$offset=10') as { directives: { limit: number; offset: number } }
    expect(got.directives.limit).toBe(5)
    expect(got.directives.offset).toBe(10)
  })

  test('every wire directive is translated', async () => {
    const got = await seen('?$orderBy=-id&$select=title&$populate=author&$search=hi&$withDeleted=true&$onlyDeleted=false')
    expect(got.directives).toEqual({
      orderBy: '-id', select: 'title', populate: 'author',
      search: 'hi', withDeleted: true, onlyDeleted: false,
    })
  })

  test('an absent directive is absent, not undefined-valued', async () => {
    const got = await seen('?status=open')
    expect(got.directives).toEqual({})
  })

  test('a garbage $limit falls back rather than producing NaN', async () => {
    const got = await seen('?$limit=banana') as { directives: { limit?: number } }
    expect(got.directives.limit).toBeUndefined()
  })
})

describe('parseQuery consumes directives', () => {

  test('directives drive the query, filters become the where clause', () => {
    const q = parseQuery({ name: 'alice' }, 20, 100, { limit: 5, offset: 10, orderBy: '-id' })
    expect(q.limit).toBe(5)
    expect(q.offset).toBe(10)
    expect(q.where).toEqual({ name: 'alice' })
    expect(q.orderBy).toBeDefined()
  })

  test('maxLimit still caps an over-large request', () => {
    expect(parseQuery({}, 20, 100, { limit: 9999 }).limit).toBe(100)
  })

  test('limit 0 is honored — it means count-only, not "unset"', () => {
    expect(parseQuery({}, 20, 100, { limit: 0 }).limit).toBe(0)
  })

  test('the `$`-in-query path still works for callers that predate directives', () => {
    // Direct parseQuery() users and older internal calls.
    const q = parseQuery({ $limit: '10', $offset: '5', name: 'alice' })
    expect(q.limit).toBe(10)
    expect(q.offset).toBe(5)
    expect(q.where).toEqual({ name: 'alice' })
  })

  test('explicit directives beat a `$` key of the same name', () => {
    const q = parseQuery({ $limit: '10' }, 20, 100, { limit: 3 })
    expect(q.limit).toBe(3)
  })
})

describe('internal callers can finally paginate', () => {

  test('CallOptions.directives reaches ctx.directives', async () => {
    const app = await createTestApp({ services: [() => echoService()] })
    const res = await app.service('things').find({ status: 'open' }, {
      directives: { limit: 7, offset: 2 },
    }) as { data: Array<{ query: unknown; directives: unknown }> }

    expect(res.data[0]!.directives).toEqual({ limit: 7, offset: 2 })
    expect(res.data[0]!.query).toEqual({ status: 'open' })
  })

  test('bridge.internal translates a `$`-spelled query too', () => {
    const ctx = bridge.internal('things', 'find', null, { query: { $limit: '4', status: 'open' } })
    expect(ctx.directives).toEqual({ limit: 4 })
    expect(ctx.query).toEqual({ status: 'open' })
  })
})

describe('$wrap is tri-state', () => {

  const listService = () => createService({
    name: 'things',
    find: async () => [{ id: 1 }, { id: 2 }],
    get:  async () => ({ id: 1 }),
  })

  test('default — list envelopes, single unwraps', async () => {
    const app = await createTestApp({ services: [() => listService()] })
    expect((await request(app).get('/things')).body).toMatchObject({ kind: 'list' })
    expect((await request(app).get('/things/1')).body).toEqual({ id: 1 })
  })

  test('$wrap=true envelopes a single too', async () => {
    const app = await createTestApp({ services: [() => listService()] })
    expect((await request(app).get('/things/1?$wrap=true')).body).toMatchObject({ kind: 'single' })
  })

  test('$wrap=false unwraps a list to a bare array', async () => {
    // Feathers' paginate:false. Previously $wrap was read as `=== 'true'`, so
    // asking for false was indistinguishable from not asking, and there was no
    // way to get a bare array out of find().
    const app = await createTestApp({ services: [() => listService()] })
    const body = (await request(app).get('/things?$wrap=false')).body
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(2)
  })
})
