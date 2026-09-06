/**
 * tests/window.test.ts — a live list pages by GROWING, not by stepping
 *
 * `FJS-D145`. Offset paging is correct for a static table and silently wrong
 * for a moving one: rows shift between page 1 and page 2, so one item is shown
 * twice and another is never shown at all. It sits worst beside a `channel:`
 * subscription, which is the case this framework is best at.
 *
 * The answer is a window — `limit` is the window, `more()` raises it — over a
 * keyset scan that resumes from the edge of what the list already holds. The
 * cursor is the WIRE: minted by the server, opaque, handed back verbatim, and
 * never constructed here.
 *
 * Two halves, and they fail separately:
 *   • the server — `$after` is the keyset path, and an ordinary page still
 *     mints the edge off the last row it already has, at no extra query
 *   • the client — `more()` appends, supersedes correctly, and stops
 */

import { describe, test, expect } from 'bun:test'
import { createClient } from '../../litestone/src/index.js'
import { createService } from '../src/core/service.ts'
import { parseQuery } from '../src/core/litestone.ts'
import { createJunctionClient } from '../src/client/index.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

// ─── the server half, against a real Litestone client ─────────────────────────

async function shop() {
  const db = await createClient({
    db: ':memory:',
    schema: `
      model Item {
        id    Int    @id
        rank  Int
        name  String
      }
    `,
  }) as unknown as Record<string, never> & { asSystem(): any }

  const sys = db.asSystem()
  for (let i = 1; i <= 25; i++) {
    // Every row shares a rank, so ordering by it alone is a tie for all 25 —
    // the case a cursor without a tiebreaker gets silently wrong.
    await sys.item.create({ data: { id: i, rank: 1, name: `item ${i}` } })
  }
  return db
}

const svcCtx = (db: unknown, over: Record<string, unknown> = {}): ServiceContext => ({
  service: 'items', method: 'find', id: undefined, data: null,
  params: {}, query: {}, auth: {}, client: {},
  locals: { db }, app: {},
  ...over,
} as unknown as ServiceContext)

describe('the server answers a window', () => {
  test('an ordinary page carries the edge, minted off the last row it already has', async () => {
    const db  = await shop()
    const svc = createService({ model: 'Item' })
    const res: any = await svc.find(svcCtx(db, { directives: { limit: 10, orderBy: 'id' } }))

    expect(res.data.length).toBe(10)
    expect(res.total).toBe(25)
    expect(typeof res.endCursor).toBe('string')
    expect(res.hasMore).toBe(true)
  })

  test('a page that is the whole list says there is no more', async () => {
    const db  = await shop()
    const svc = createService({ model: 'Item' })
    const res: any = await svc.find(svcCtx(db, { directives: { limit: 100, orderBy: 'id' } }))
    expect(res.hasMore).toBe(false)
  })

  test('$after is the keyset path — no total, and it resumes from the edge', async () => {
    const db  = await shop()
    const svc = createService({ model: 'Item' })
    const first: any = await svc.find(svcCtx(db, { directives: { limit: 10, orderBy: 'id' } }))
    const next:  any = await svc.find(svcCtx(db, {
      directives: { limit: 10, orderBy: 'id', after: first.endCursor },
    }))

    expect(next.data.map((r: any) => r.id)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
    // No COUNT on this path, and reporting the page length as the total is what
    // makes a list claim to be complete every time it is capped.
    expect(next.total).toBeNull()
    expect(next.hasMore).toBe(true)
  })

  test('a window walks the whole list with nothing served twice — on a NON-unique order', async () => {
    const db  = await shop()
    const svc = createService({ model: 'Item' })
    const seen: number[] = []
    let after: string | null = null

    for (let i = 0; i < 10; i++) {
      const res: any = await svc.find(svcCtx(db, {
        directives: { limit: 7, orderBy: 'rank', ...(after ? { after } : {}) },
      }))
      for (const r of res.data) seen.push(r.id)
      after = res.endCursor
      if (!res.hasMore) break
    }

    expect(seen.length).toBe(25)
    expect(new Set(seen).size).toBe(25)
  })

  // The same walk with the tiebreaker pointing AGAINST the order SQLite hands
  // rows back in. `rank` ties for all 25, so the tiebreaker is `id` in the last
  // sort key's direction — DESC — while a table scan emits them by rowid, which
  // is ASC. The first page is therefore an ordinary `findManyAndCount`, and it
  // used to be ordered by `rank` alone: it stopped at id 7 and the edge minted
  // off it named where the TOTAL order stops, so ids 8–25 were never served and
  // the walk ended reporting a complete list of thirteen (`FJS-535`). The
  // ascending case above cannot see it — there SQLite's own order and the total
  // order agree by accident.
  test('...and with the tiebreaker running against the order rows come back in', async () => {
    const db  = await shop()
    const svc = createService({ model: 'Item' })
    const seen: number[] = []
    let after: string | null = null

    for (let i = 0; i < 10; i++) {
      const res: any = await svc.find(svcCtx(db, {
        directives: { limit: 7, orderBy: '-rank', ...(after ? { after } : {}) },
      }))
      for (const r of res.data) seen.push(r.id)
      after = res.endCursor
      if (!res.hasMore) break
    }

    expect(new Set(seen).size).toBe(25)
    expect(seen.length).toBe(25)
  })

  test('a list whose ties cannot be broken carries no edge rather than a wrong one', async () => {
    // No @id to append, so there is no total order to be had. The page is still
    // answered — a read is not a request for a window — and `endCursor` is null,
    // which is what stops `more()` from asking for a position nothing can name.
    const db = await createClient({
      db: ':memory:',
      schema: `model Tally { label String @unique  n Int }`,
    }) as unknown as { asSystem(): any }
    const sys = db.asSystem()
    for (let i = 1; i <= 5; i++) await sys.tally.create({ data: { label: `t${i}`, n: 1 } })

    const svc = createService({ model: 'Tally', idField: 'label' })
    const res: any = await svc.find(svcCtx(db, { directives: { limit: 2, orderBy: 'n' } }))
    expect(res.data.length).toBe(2)
    expect(res.total).toBe(5)
    expect(res.endCursor).toBeNull()
    expect(res.hasMore).toBe(true)
  })

  test('the directive is parsed, and an empty one is not a cursor', () => {
    expect(parseQuery({}, 20, 100, { after: 'abc' }).after).toBe('abc')
    expect(parseQuery({ $after: 'xyz' }, 20, 100).after).toBe('xyz')
    expect(parseQuery({}, 20, 100, { after: '' }).after).toBeUndefined()
    expect(parseQuery({}, 20, 100).after).toBeUndefined()
  })

  test('$after is not a filter — it never reaches the where', () => {
    expect(parseQuery({ $after: 'abc', name: 'x' }, 20, 100).where).toEqual({ name: 'x' })
  })
})

// ─── over a real request ──────────────────────────────────────────────────────
// The two halves above meet at the bridge: a cursor arrives as a `$` key in a
// query STRING and has to survive being parsed, stripped from the filters and
// put back on the answer. That crossing is where a directive goes missing —
// `$withTemplates` had a wire name, a parse and a reserved-key entry and all
// three were empty, so an app declaring it had a screen it could not build.

describe('a window over HTTP', () => {
  const appWith = async (db: unknown) => {
    const { createApp, defaultConfig } = await import('../index.ts')
    const app: any = createApp({
      db,
      config: {
        port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' },
        http: { ...defaultConfig.http, drainTimeout: 50 },
      },
    } as never)
    app.services.register(createService({ name: 'items', model: 'Item' }))
    await app.start()
    return app
  }
  const get = async (app: any, path: string) => {
    const res = await app.http.fetch(new Request('http://localhost' + path))
    return await res.json() as any
  }

  test('walks the whole list through the bridge, nothing twice', async () => {
    const db  = await shop()
    const app = await appWith(db)

    const seen: number[] = []
    let after: string | null = null
    for (let i = 0; i < 10; i++) {
      const url = `/items?$limit=7&$orderBy=rank` + (after ? `&$after=${encodeURIComponent(after)}` : '')
      const body = await get(app, url)
      for (const r of body.data) seen.push(r.id)
      after = body.endCursor
      if (!body.hasMore) break
    }

    expect(seen.length).toBe(25)
    expect(new Set(seen).size).toBe(25)
    ;(db as any).$close(); await app.stop()
  })

  test('the cursor is not a filter — it does not reach the where', async () => {
    const db  = await shop()
    const app = await appWith(db)
    const body = await get(app, '/items?$limit=3&$orderBy=id')
    expect(body.data).toHaveLength(3)
    expect(typeof body.endCursor).toBe('string')
    ;(db as any).$close(); await app.stop()
  })

  // `FJS-779`. The token is caller-supplied text and was graded by nothing, so
  // over the wire the four shapes below answered a 200 with an EMPTY LIST —
  // which a client reads as the end of the data — except the malformed one,
  // which answered 500. The grading is litestone's, because that is where the
  // ordering is known; what is asserted here is the STATUS, which is the half
  // neither package can answer alone.
  test('a cursor this list did not mint is a 400, never an empty page', async () => {
    const db  = await shop()
    const app = await appWith(db)
    const mint = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')

    const status = async (after: string) => {
      const res = await app.http.fetch(new Request(
        `http://localhost/items?$limit=3&$orderBy=id&$after=${encodeURIComponent(after)}`))
      return { code: res.status, body: await res.json() as any }
    }

    for (const [name, after] of [
      ['malformed',   'not-a-cursor'],
      ['wrong keys',  mint({ nope: 1 })],
      ['null',        mint(null)],
      ['an array',    mint([1])],
    ] as const) {
      const { code, body } = await status(after)
      expect(`${name}: ${code}`).toBe(`${name}: 400`)
      expect(body.message).toMatch(/\$after/)
      // Not an empty LIST wearing a 200, which is what each of these was. The
      // body is an error — `data` on a 400 is the field-error list junction
      // hands `<Form>`, so it names the parameter rather than holding rows.
      expect(body.kind).toBeUndefined()
      expect(body.data).toEqual([{ path: ['$after'], message: expect.any(String) }])
    }

    // Paired: the edge this list actually minted still pages, over the same
    // transport. A boundary that refused every cursor would pass every row
    // above and break the feature.
    const first = await get(app, '/items?$limit=3&$orderBy=id')
    const next  = await get(app, `/items?$limit=3&$orderBy=id&$after=${encodeURIComponent(first.endCursor)}`)
    expect(next.data).toHaveLength(3)
    expect(next.data.map((r: any) => r.id)).not.toEqual(first.data.map((r: any) => r.id))

    ;(db as any).$close(); await app.stop()
  })
})

// ─── the client half ──────────────────────────────────────────────────────────

function mockPages(pages: Array<{ data: unknown[]; endCursor: string | null; hasMore: boolean; total?: number | null }>) {
  const original = globalThis.fetch
  const asked: string[] = []
  let at = 0
  globalThis.fetch = (async (url: string | URL) => {
    asked.push(String(url))
    const p = pages[Math.min(at++, pages.length - 1)]
    return new Response(JSON.stringify({
      kind: 'list', object: 'items', errors: [], limit: p.data.length, offset: 0,
      total: p.total ?? null, ...p,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
  return { restore: () => { globalThis.fetch = original }, asked }
}

const client = () => createJunctionClient({ url: 'http://localhost:3000' })

describe('resource().more()', () => {
  test('appends the next slice and carries the new edge', async () => {
    const m = mockPages([
      { data: [{ id: 1 }, { id: 2 }], endCursor: 'c1', hasMore: true },
      { data: [{ id: 3 }, { id: 4 }], endCursor: 'c2', hasMore: false },
    ])
    const r = client().resource('items', 'id', { model: 'Item' })
    await r.load({}, { limit: 2, orderBy: 'id' })
    expect(r.hasMore()).toBe(true)

    const added = await r.more()
    expect(added.map((x: any) => x.id)).toEqual([3, 4])
    expect(r.store.get().map((x: any) => x.id)).toEqual([1, 2, 3, 4])
    expect(r.hasMore()).toBe(false)
    m.restore()
  })

  test('the cursor goes back verbatim, on the query the window was opened with', async () => {
    const m = mockPages([
      { data: [{ id: 1 }], endCursor: 'edge-1', hasMore: true },
      { data: [{ id: 2 }], endCursor: null,     hasMore: false },
    ])
    const r = client().resource('items', 'id', { model: 'Item' })
    await r.load({ status: 'live' }, { limit: 1, orderBy: '-id' })
    await r.more()

    const grew = m.asked[1]
    expect(grew).toContain('$after=edge-1')
    expect(grew).toContain('status=live')
    expect(grew).toContain('$orderBy=-id')
    m.restore()
  })

  test('nothing past the window is an empty answer, not a request', async () => {
    const m = mockPages([{ data: [{ id: 1 }], endCursor: null, hasMore: false }])
    const r = client().resource('items', 'id', { model: 'Item' })
    await r.load()
    expect(await r.more()).toEqual([])
    expect(m.asked.length).toBe(1)
    m.restore()
  })

  test('before load() it refuses by name — a window has to be opened first', async () => {
    const r = client().resource('items', 'id', { model: 'Item' })
    await expect(r.more()).rejects.toThrow(/before load\(\)/)
  })

  test('a load() during a more() wins, and the slice is dropped', async () => {
    const m = mockPages([
      { data: [{ id: 1 }],  endCursor: 'c1', hasMore: true },
      { data: [{ id: 99 }], endCursor: 'c2', hasMore: true },   // the more()
      { data: [{ id: 7 }],  endCursor: 'c3', hasMore: true },   // the load()
    ])
    const r = client().resource('items', 'id', { model: 'Item' })
    await r.load({}, { limit: 1 })

    const growing = r.more()
    const reload  = r.load({ other: true }, { limit: 1 })
    await Promise.all([growing, reload])

    // The window is the reload's, and the superseded slice is not in it.
    expect(r.store.get().map((x: any) => x.id)).toEqual([7])
    m.restore()
  })

  test('a row already in the window is not duplicated by growing it', async () => {
    // The server resumes from the edge, but a row can arrive on the socket in
    // the meantime — the store is keyed by id either way.
    const m = mockPages([
      { data: [{ id: 1 }, { id: 2 }], endCursor: 'c1', hasMore: true },
      { data: [{ id: 2 }, { id: 3 }], endCursor: 'c2', hasMore: false },
    ])
    const r = client().resource('items', 'id', { model: 'Item' })
    await r.load({}, { limit: 2 })
    await r.more()
    expect(r.store.get().map((x: any) => x.id)).toEqual([1, 2, 3])
    m.restore()
  })
})
