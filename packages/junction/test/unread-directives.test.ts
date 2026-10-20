// test/unread-directives.test.ts
//
// The directive twin of unread-filters. A hand-written find that never read
// `$.directives.orderBy` answered `?$orderBy=title` in its own order with a 200,
// and basecamp had 27 such finds (`FJS-2345`). Against a real Litestone client,
// for the same reason the filter test is: autoFilter and autoSort ask the
// client, and a plain-object db would no-op both.
//
// Only what the CALLER sent is watched. The paginate hook writes limit and
// offset onto every find's directives, and a find that does not page was not
// asked to.

import { describe, test, expect } from 'bun:test'
import { createClient }  from '../../litestone/src/index.js'
import { createApp }     from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'
import { $ }             from '../src/core/context.ts'
import type { ServiceContext } from '../src/core/context.ts'
import { request }       from '../src/testing/index.ts'
import { callDb } from '../src/core/context.ts'

type Row = { id: number, title: string, status: string }
type AnyClient = Record<string, any>

const SCHEMA = `
  model Post {
    id     Int    @id
    title  String
    status String

    @@gate(0.4.4.5)
  }
`

async function appWith(def: Record<string, unknown> = {}) {
  const db  = await createClient({ db: ':memory:', schema: SCHEMA }) as unknown as AnyClient
  const sys = db.asSystem()
  await sys.post.create({ data: { id: 1, title: 'b', status: 'live' } })
  await sys.post.create({ data: { id: 2, title: 'c', status: 'live' } })
  await sys.post.create({ data: { id: 3, title: 'a', status: 'draft' } })

  const app = createApp({
    db: db as never,
    config: { port: 0 },
  })
  app.services.register(createService({ name: 'posts', model: 'Post', ...def } as never))
  return app
}

const ids = (body: unknown) => ((body as { data: Row[] }).data).map(r => r.id)
const db  = (c: ServiceContext) => callDb(c) as AnyClient

/** A find that pages and sorts by id, and reads no other directive. */
const pagesOnly = {
  async find(c: ServiceContext) {
    const d = c.directives ?? {}
    return db(c).post.findMany({ orderBy: { id: 'asc' }, limit: d.limit, offset: d.offset })
  },
}

describe('a hand-written find must read every directive the caller sent', () => {
  test('an $orderBy the body never read is refused by name', async () => {
    const res  = await request(await appWith(pagesOnly)).get('/posts?$orderBy=title')
    const body = res.body as { message: string, data: { field: string }[] }

    expect(res.status).toBe(400)
    expect(body.message).toContain("posts.find does not apply '$orderBy'")
    expect(body.data.map(e => e.field)).toEqual(['$orderBy'])
  })

  test('every unread directive is named in one answer', async () => {
    const res = await request(await appWith(pagesOnly)).get('/posts?$orderBy=title&$select=id')
    expect(res.status).toBe(400)
    expect((res.body as { message: string }).message).toContain("'$orderBy', '$select'")
  })

  test('an internal caller is refused the same way', async () => {
    const app = await appWith(pagesOnly)
    const err = await app.service('posts').find({}, { directives: { orderBy: 'title' } } as never)
      .catch((e: Error) => e) as Error
    expect(err.message).toContain("does not apply '$orderBy'")
  })

  test('a find that reads $.directives.orderBy answers in that order', async () => {
    const app = await appWith({
      async find() {
        const sort = $.directives?.orderBy
        return ($.db as AnyClient).post.findMany({ orderBy: sort === 'title' ? { title: 'asc' } : { id: 'asc' } })
      },
    })
    const res = await request(app).get('/posts?$orderBy=title')
    expect(res.status).toBe(200)
    expect(ids(res.body)).toEqual([3, 1, 2])
  })

  test('the base find reads every directive', async () => {
    const res = await request(await appWith()).get('/posts?$orderBy=-title&$select=id,title&$limit=2')
    expect(res.status).toBe(200)
    expect(ids(res.body)).toEqual([2, 1])
  })

  test('a limit the paginate hook wrote is not the caller asking', async () => {
    const res = await request(await appWith({
      async find(c: ServiceContext) { return db(c).post.findMany({ orderBy: { id: 'asc' } }) },
    })).get('/posts')
    expect(res.status).toBe(200)
    expect(ids(res.body)).toEqual([1, 2, 3])
  })

  test('a hook that reads a directive does not count as the body reading it', async () => {
    const app = await appWith({
      ...pagesOnly,
      hooks: { before: { find: [(c: ServiceContext) => { c.directives = { ...c.directives } }] } },
    })
    const res = await request(app).get('/posts?$orderBy=title')
    expect(res.status).toBe(400)
    expect((res.body as { message: string }).message).toContain("does not apply '$orderBy'")
  })

  test('a directive a hook took off before the body ran was the hook\'s to apply', async () => {
    const app = await appWith({
      ...pagesOnly,
      hooks: { before: { find: [(c: ServiceContext) => { delete c.directives!.orderBy }] } },
    })
    expect((await request(app).get('/posts?$orderBy=title')).status).toBe(200)
  })

  test('a hand-written get is held to the same rule', async () => {
    const app = await appWith({
      async get(c: ServiceContext) { return db(c).post.findUnique({ where: { id: Number(c.id) } }) },
    })
    const res = await request(app).get('/posts/2?$select=id')
    expect(res.status).toBe(400)
    expect((res.body as { message: string }).message).toContain("posts.get does not apply '$select'")
  })

  test('the base get is not refused', async () => {
    expect((await request(await appWith()).get('/posts/2?$select=id')).status).toBe(200)
  })

  test('an after hook sees the original directives object, not the watch', async () => {
    let seen: unknown
    const app = await appWith({
      async find() { return ($.db as AnyClient).post.findMany({ orderBy: $.directives?.orderBy ? { title: 'asc' } : undefined }) },
      hooks: { after: { find: [(c: ServiceContext) => { seen = c.directives }] } },
    })
    await request(app).get('/posts?$orderBy=title')
    expect((seen as { orderBy: unknown }).orderBy).toBe('title')
    expect(require('node:util').types.isProxy(seen)).toBe(false)
  })
})
