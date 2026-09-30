// test/unread-filters.test.ts
//
// A hand-written find reads only the filters it names, after autoFilter has
// admitted every key that is a column — so a key it skipped matched every row
// and answered 200 (`FJS-1577`). Against a real Litestone client, because
// autoFilter asks `$checkWhere` and a plain-object db has no columns to admit:
// the check would no-op and every case here would pass for nothing.
//
// Each passing case also asserts the rows, so a find that satisfies the check
// by reading a key and still answering every row is visible.

import { describe, test, expect } from 'bun:test'
import { createClient }  from '../../litestone/src/index.js'
import { createApp }     from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'
import { parseWhere }    from '../src/core/litestone.ts'
import { $ }             from '../src/core/context.ts'
import type { ServiceContext } from '../src/core/context.ts'
import { request }       from '../src/testing/index.ts'

type Row = { id: number, title: string, status: string }
type AnyClient = Record<string, any>

const SCHEMA = `
  model Post {
    id     Int    @id
    title  String
    status String

    @@gate("0.4.4.5")
  }
`

/** One app, one `posts` service built from `def`, three rows to tell filters apart. */
async function appWith(def: Record<string, unknown> = {}) {
  const db  = await createClient({ db: ':memory:', schema: SCHEMA }) as unknown as AnyClient
  const sys = db.asSystem()
  await sys.post.create({ data: { id: 1, title: 'kept',  status: 'live' } })
  await sys.post.create({ data: { id: 2, title: 'other', status: 'live' } })
  await sys.post.create({ data: { id: 3, title: 'kept',  status: 'draft' } })

  const app = createApp({
    db: db as never,
    config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
  })
  app.services.register(createService({ name: 'posts', model: 'Post', ...def } as never))
  return app
}

const ids = (body: unknown) => ((body as { data: Row[] }).data).map(r => r.id).sort()
const db  = (c: ServiceContext) => c.locals.db as AnyClient

/** A find that names `status` and nothing else — the shape basecamp had 27 of. */
const namesStatus = {
  async find(c: ServiceContext) {
    const status = c.query.status as string | undefined
    return db(c).post.findMany({ where: status ? { status } : {} })
  },
}

describe('a hand-written find must read every filter autoFilter admitted', () => {
  test('a filter the body never read is refused by name', async () => {
    const res  = await request(await appWith(namesStatus)).get('/posts?status=live&title=kept')
    const body = res.body as { message: string, data: { field: string }[] }

    expect(res.status).toBe(400)
    expect(body.message).toContain("posts.find does not filter on 'title'")
    expect(body.message).toContain('a column on post')
    // The key it DID read is not named — the refusal points at the one to fix.
    expect(body.message).not.toContain("'status'")
    expect(body.data.map(e => e.field)).toEqual(['title'])
  })

  test('an internal caller is refused the same way', async () => {
    const app = await appWith(namesStatus)
    const err = await app.service('posts').find({ status: 'live', title: 'kept' }).catch((e: Error) => e) as Error
    expect(err.message).toContain("does not filter on 'title'")
  })

  test('every unread filter is named in one answer', async () => {
    const res = await request(await appWith({ async find() { return [] } })).get('/posts?status=live&title=kept')
    expect(res.status).toBe(400)
    expect((res.body as { message: string }).message).toContain("'status', 'title'")
  })

  test('the filters it names still answer when those are all the caller sent', async () => {
    const res = await request(await appWith(namesStatus)).get('/posts?status=draft')
    expect(res.status).toBe(200)
    expect(ids(res.body)).toEqual([3])
  })

  test('spreading parseWhere($.query) reads and applies every key', async () => {
    const app = await appWith({
      async find() { return ($.db as AnyClient).post.findMany({ where: { ...parseWhere($.query) } }) },
    })
    const res = await request(app).get('/posts?status=live&title=kept')
    expect(res.status).toBe(200)
    expect(ids(res.body)).toEqual([1])
  })

  test('a key read through $ counts as read', async () => {
    const app = await appWith({
      async find() {
        const where: Record<string, unknown> = {}
        if ($.query.status) where.status = $.query.status
        if ('title' in $.query) where.title = $.query.title
        return ($.db as AnyClient).post.findMany({ where })
      },
    })
    const res = await request(app).get('/posts?status=live&title=kept')
    expect(res.status).toBe(200)
    expect(ids(res.body)).toEqual([1])
  })

  test('the base find reads every key', async () => {
    const res = await request(await appWith()).get('/posts?status=live&title=kept')
    expect(res.status).toBe(200)
    expect(ids(res.body)).toEqual([1])
  })

  test('a hook that spreads ctx.query does not count as the body reading it', async () => {
    // A scoping hook rebuilding the query touches every key; were its reads
    // counted, one such hook would hide every drop behind it.
    const app = await appWith({
      ...namesStatus,
      hooks: { before: { find: [(c: ServiceContext) => { c.query = { ...c.query } }] } },
    })
    const res = await request(app).get('/posts?status=live&title=kept')
    expect(res.status).toBe(400)
    expect((res.body as { message: string }).message).toContain("does not filter on 'title'")
  })

  test('a key a hook took off the query before the body ran was the hook\'s to apply', async () => {
    const app = await appWith({
      hooks: { before: { find: [(c: ServiceContext) => {
        c.locals.title = c.query.title
        delete c.query.title
      }] } },
      async find(c: ServiceContext) {
        return db(c).post.findMany({ where: { status: c.query.status, title: c.locals.title } })
      },
    })
    const res = await request(app).get('/posts?status=live&title=kept')
    expect(res.status).toBe(200)
    expect(ids(res.body)).toEqual([1])
  })

  test('a key that is not a column is still autoFilter\'s refusal, before the body runs', async () => {
    let ran = false
    const res = await request(await appWith({ async find() { ran = true; return [] } })).get('/posts?bogus=1')

    expect(res.status).toBe(400)
    expect((res.body as { message: string }).message).toContain("Unknown filter key 'bogus'")
    expect(ran).toBe(false)
  })

  test('a hand-written get is held to the same rule', async () => {
    // autoFilter admits for get as well, so get is watched too.
    const app = await appWith({
      async get(c: ServiceContext) { return db(c).post.findUnique({ where: { id: Number(c.id) } }) },
    })
    const res = await request(app).get('/posts/2?status=draft')
    expect(res.status).toBe(400)
    expect((res.body as { message: string }).message).toContain("posts.get does not filter on 'status'")
  })

  test('the base get and aggregate are not refused', async () => {
    const app = await appWith()
    expect((await request(app).get('/posts/2?status=live')).status).toBe(200)
    const agg = await app.service('posts').aggregate({ _count: true }, { query: { status: 'live' } } as never)
      .catch((e: Error) => e)
    expect(agg).not.toBeInstanceOf(Error)
  })

  test('an after hook sees the original query object, not the watch', async () => {
    let seen: unknown
    const app = await appWith({
      ...namesStatus,
      hooks: { after: { find: [(c: ServiceContext) => { seen = c.query }] } },
    })
    await request(app).get('/posts?status=live')
    expect(seen).toEqual({ status: 'live' })
    expect(require('node:util').types.isProxy(seen)).toBe(false)
  })
})

// The base get by id enumerated the query for its directives and never put
// the filters in its where, so the read check above passed it while every
// filter went unapplied (`FJS-1585`).
describe('the base get by id applies the filters it reads', () => {
  test('a filter the row fails is a 404', async () => {
    const app = await appWith()
    expect((await request(app).get('/posts/2?status=draft')).status).toBe(404)
    const res = await request(app).get('/posts/2?status=live')
    expect(res.status).toBe(200)
    expect((res.body as Row).id).toBe(2)
  })

  test('a filter on the key cannot replace the id the URL named', async () => {
    expect((await request(await appWith()).get('/posts/2?id=3')).status).toBe(404)
  })

  test('a hook that narrows reads through ctx.query narrows a get by id', async () => {
    const app = await appWith({
      hooks: { before: { get: [(c: ServiceContext) => { c.query = { ...c.query, status: 'live' } }] } },
    })
    expect((await request(app).get('/posts/3')).status).toBe(404)
    expect((await request(app).get('/posts/1')).status).toBe(200)
  })
})
