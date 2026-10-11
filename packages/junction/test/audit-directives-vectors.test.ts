// test/audit-directives-vectors.test.ts — the Directives spine entry's vectors
// that the implementation answers wrongly today (Fable audit run 4.2).
//
// The draft entry (`IDEAS/specifications.md` 14, with 15 folded in) gives every
// directive a VALUE grammar the table never had: a count is decimal digits, a
// flag is `true`/`1`/`false`/`0`, a text directive is read from the raw text a
// caller sent and never from the typed value the filter parser made of it. The
// table today reads `Number()`, `truthy()` and a two-way ternary, and SQLite is
// the parser of last resort — so `?$limit=1.5` is a 500, `?$withDeleted=1` is
// false on every real wire, and `?$select=` answers rows with no columns.
//
// Each `test.failing` asserts the FIXED behavior and so fails today; drop
// `.failing` when the fix lands. The two controls pass now and stay: they are
// the refusal of an unknown `$`-name (`FJS-D237`), which is the shape every row
// below asks a malformed VALUE to take.

import { describe, test, expect } from 'bun:test'
import { createClient }  from '../../litestone/src/index.js'
import { createApp }     from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'
import { bridge }        from '../src/transport/bridge.ts'
import { parseQuery }    from '../src/core/litestone.ts'
import { normalizeOrderBy } from '../src/core/query-values.ts'
import { orderByPair }   from '@frontierjs/toolbelt/directives'
import { request }       from '../src/testing/index.ts'

type Row = { id: number, title: string, status: string }
type AnyClient = Record<string, any>

const SCHEMA = `
  model Post {
    id        Int       @id
    title     String
    status    String
    deletedAt DateTime?

    @@softDelete
    @@gate("0.4.4.5")
  }
`

async function appWith() {
  const db  = await createClient({ db: ':memory:', schema: SCHEMA }) as unknown as AnyClient
  const sys = db.asSystem()
  await sys.post.create({ data: { id: 1, title: 'b', status: 'live' } })
  await sys.post.create({ data: { id: 2, title: 'c', status: 'live' } })
  await sys.post.create({ data: { id: 3, title: 'a', status: 'draft' } })
  await sys.post.remove({ where: { id: 3 } })

  const app = createApp({
    db: db as never,
    config: { port: 0, services: { dir: '/nonexistent' } },
  })
  app.services.register(createService({ name: 'posts', model: 'Post' } as never))
  return app
}

const ids  = (body: unknown) => ((body as { data: Row[] }).data).map(r => r.id)
const text = (body: unknown) => String((body as { message?: string })?.message ?? '')

describe('a directive VALUE the grammar does not admit is refused by name, as an unknown NAME is', () => {

  test('control: an unknown $-name is refused by name over HTTP', async () => {
    const res = await request(await appWith()).get('/posts?$limit=5&$nope=1')
    expect(res.status).toBe(400)
    expect(text(res.body)).toContain('$nope')
    expect((res.body as { data: { directives: string[] } }).data.directives).toEqual(['$nope'])
  })

  test('control: an unknown $-name is refused by name on the internal path', () => {
    expect(() => bridge.internal('posts', 'find', null, { query: { $nope: 1 } }))
      .toThrow(/\$nope/)
  })

  test('a fractional count is a 400 naming $limit, not a 500 from SQLite', async () => {
    const res = await request(await appWith()).get('/posts?$limit=1.5')
    expect(res.status).toBe(400)
    expect(text(res.body)).toContain('$limit')
  })

  test('a count is decimal digits: true, [] and 0x10 are each refused rather than read as 1, 0 and 16', async () => {
    const app = await appWith()
    for (const value of ['true', '[]', '0x10', '1e2', 'lots']) {
      const res = await request(app).get(`/posts?$limit=${value}`)
      expect(res.status).toBe(400)
      expect(text(res.body)).toContain('$limit')
    }
  })

  test('a directive is single-valued: a repeated or list-spelled $limit is refused, not dropped to the default', async () => {
    const app = await appWith()
    for (const qs of ['$limit=5&$limit=6', '$limit[]=5']) {
      const res = await request(app).get(`/posts?${qs}`)
      expect(res.status).toBe(400)
      expect(text(res.body)).toContain('$limit')
    }
    expect(() => bridge.internal('posts', 'find', null, { query: { $limit: [5, 6] } }))
      .toThrow(/\$limit/)
  })

  test('a numeric-looking $after is text and reaches the cursor check, which refuses it by name', async () => {
    const res = await request(await appWith()).get('/posts?$after=123')
    expect(res.status).toBe(400)
    expect(text(res.body)).toMatch(/cursor/)
  })

  test('an empty $select is absent: every readable column, not rows with none', async () => {
    const res = await request(await appWith()).get('/posts?$select=')
    expect(res.status).toBe(200)
    expect(ids(res.body)).toEqual([1, 2])
  })

  test('$withDeleted=1 is true on the real wire, as the table says it is', async () => {
    const res = await request(await appWith()).get('/posts?$withDeleted=1')
    expect(res.status).toBe(200)
    expect(ids(res.body)).toEqual([1, 2, 3])
  })

  test('a flag directive given text that is no flag spelling is refused by name, not read as false', async () => {
    const app = await appWith()
    for (const bad of ['yes', 'on', '2']) {
      const res = await request(app).get(`/posts?$withDeleted=${bad}`)
      expect(res.status).toBe(400)
      expect(text(res.body)).toContain('$withDeleted')
    }
    const off = await request(app).get('/posts?$withDeleted=0')
    expect(ids(off.body)).toEqual([1, 2])
  })

  // FJS-2464: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing('a direction that is not asc/desc/1/-1 is refused, not read as descending', async () => {
    const res = await request(await appWith()).get('/posts?$orderBy[title]=sideways')
    expect(res.status).toBe(400)
    expect(text(res.body)).toContain('sideways')
  })

  // FJS-2465
  test('orderByPair marks the column normalizeOrderBy sorts by, on the bracket-indexed spelling', () => {
    // `{ '0': { name: 'desc' } }` — an object with a field named '0', which the
    // boundary refuses; the header marker must not say `name` where the server
    // says `0`.
    const raw = { '0': { name: 'desc' } }
    const [first] = normalizeOrderBy(raw)
    expect(orderByPair(raw).key).toBe(Object.keys(first)[0])
  })

  test('the internal path refuses a negative count as HTTP does, rather than flooring it to no rows', () => {
    expect(() => bridge.internal('posts', 'find', null, { query: { $limit: -1 } }))
      .toThrow(/\$limit/)
  })

  test('$first and $wrap are flags read by the one splitter: `no` is refused and `0` is false', async () => {
    const app = await appWith()
    const first = await request(app).get('/posts?$first=no')
    expect(first.status).toBe(400)
    expect(text(first.body)).toContain('$first')

    const wrap = await request(app).get('/posts/1?$wrap=0')
    expect(wrap.status).toBe(200)
    expect((wrap.body as Row).id).toBe(1)

    const off = await request(app).get('/posts?$first=0')
    expect(ids(off.body)).toEqual([1, 2])
  })

  test('a bare $first is true, as a bare flag is on the wire', async () => {
    const res = await request(await appWith()).get('/posts?$first')
    expect(res.status).toBe(200)
    expect((res.body as Row).id).toBe(1)
  })

  test('parseQuery holds no flag grammar of its own: a $-key on query is refused, not read as a third truthy table', () => {
    expect(() => parseQuery({ $withDeleted: '1' } as never, 20, 100, {})).toThrow(/\$withDeleted/)
  })
})
