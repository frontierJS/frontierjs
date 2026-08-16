// tests/real-litestone-client.test.ts
//
// Every other test in this suite builds services over a plain-object fake db.
// That is fast and it is also how the accessor-resolution fix shipped broken:
// a real Litestone client is a Proxy that THROWS on an unknown accessor
// ("posts" is not a table in this schema) instead of returning undefined, so
// probing candidate spellings in order aborted on the first miss. Against
// `{ post: {...} }` the loop worked perfectly; against every real client it
// never reached the second candidate.
//
// These tests use the workspace Litestone client so that class of assumption
// cannot pass again. Keep them here — they are the only place the two packages
// are exercised together.

import { describe, test, expect } from 'bun:test'
import { createClient } from '../../litestone/src/index.js'
import { createService, createBaseService } from '../src/core/service.ts'
import { gateAuth, autoValidate } from '../src/core/litestone.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

type AnyClient = Record<string, never> & {
  asSystem(): Record<string, { create(a: unknown): Promise<unknown> }>
}

async function mkDb(): Promise<AnyClient> {
  return await createClient({
    db: ':memory:',
    schema: `
      model Post {
        id        Int      @id
        title     String   @length(1, 20)
        body      String?
        createdAt DateTime @default(now())

        @@gate("0.4.4.5")
      }
    `,
  }) as unknown as AnyClient
}

function ctx(db: unknown, over: Record<string, unknown> = {}): ServiceContext {
  return {
    service: 'posts', method: 'find', id: undefined, data: null,
    params: {}, query: {}, auth: {}, client: {},
    locals: { db }, app: {},
    ...over,
  } as unknown as ServiceContext
}

describe('accessor resolution against a real Litestone client', () => {

  test.each([
    ['explicit singular', { name: 'posts', model: 'post'  }],
    ['plural spelling',   { name: 'posts', model: 'posts' }],
  ])('%s resolves to db.post', async (_label, def) => {
    const db = await mkDb()
    await db.asSystem().post!.create({ data: { id: 1, title: 'Hi' } })

    const out = await createService(def).find(ctx(db)) as { data: unknown[] }
    expect(out.data).toHaveLength(1)
  })

  test('model omitted — the whole service file is createBaseService({})', async () => {
    const db = await mkDb()
    await db.asSystem().post!.create({ data: { id: 1, title: 'Hi' } })

    // Exactly what the autoloader builds from services/posts.service.ts.
    const svc = createService({ name: 'posts', ...(createBaseService({}) as object) } as never)
    const out = await svc.find(ctx(db)) as { data: unknown[] }
    expect(out.data).toHaveLength(1)
  })

  test('an unresolvable name reports Junction\'s diagnostic, not a proxy TypeError', async () => {
    const db  = await mkDb()
    const svc = createService({ name: 'widgets', model: 'widget' })
    const err = await svc.find(ctx(db, { service: 'widgets' })).catch((e: Error) => e) as Error

    expect(err.message).toContain("not found on db client")
    expect(err.message).toContain('PascalCase singular')
    // Object.keys() on the client proxy throws (duplicate ownKeys); the
    // diagnostic must survive that rather than be replaced by it.
    expect(err.message).not.toContain('ownKeys')
  })
})

describe('derived hooks against a real Litestone client', () => {

  test('@@gate("0.4.4.5") — anonymous read allowed, anonymous write rejected', async () => {
    const db = await mkDb()
    expect(() => gateAuth(undefined, 'read')(ctx(db))).not.toThrow()
    expect(() => gateAuth(undefined, 'create')(ctx(db))).toThrow('Authentication required')
  })

  test('field rules become 400s — @length(1, 20) enforced with no model named', async () => {
    const db  = await mkDb()
    const c   = ctx(db, { method: 'create', data: { title: 'x'.repeat(50) } })
    const err = await autoValidate(undefined, 'create')(c).catch((e: Error) => e) as Error

    expect(err.name).toBe('BadRequest')
    expect(err.message).toContain('title')
  })

  test('a valid payload passes validation', async () => {
    const db = await mkDb()
    const c  = ctx(db, { method: 'create', data: { title: 'Fine' } })
    await expect(autoValidate(undefined, 'create')(c)).resolves.toBeUndefined()
  })
})

// ─── The Data realm's per-call options, over the wire ─────────────────────────
//
// `@@hasTemplates` had no wire name at all: `parseDirectives`, `QueryDirectives`
// and the two wire builders each named a fixed set, and none of them named a
// template — so an app declaring the attribute had a template list screen it
// could not build over HTTP or from a browser (FJS-306). The same shape
// FJS-290 had just closed for soft delete.
//
// A fake db cannot grade any of this: it is the real client's filter that has
// to change, and its refusal that has to arrive as a 400.

describe('the template and soft-delete directives reach a real client', () => {

  async function tmplDb(): Promise<AnyClient> {
    const db = await createClient({
      db: ':memory:',
      schema: `model Quote {
        id    Int    @id
        title String
        @@hasTemplates
      }`,
    }) as unknown as AnyClient
    const t = (db as unknown as Record<string, { create(a: unknown): Promise<unknown> }>).quote!
    await t.create({ data: { id: 1, title: 'live' } })
    await t.create({ data: { id: 2, title: 'template', isTemplate: true } })
    return db
  }

  const quotes = () => createService({ name: 'quotes', model: 'Quote' })

  test('the default read still hides templates', async () => {
    const out = await quotes().find(ctx(await tmplDb(), { service: 'quotes' })) as { data: { id: number }[] }
    expect(out.data.map(r => r.id)).toEqual([1])
  })

  test('$onlyTemplates and $withTemplates reach the WHERE clause', async () => {
    const db = await tmplDb()
    const only = await quotes().find(
      ctx(db, { service: 'quotes', directives: { onlyTemplates: true } })) as { data: { id: number }[] }
    expect(only.data.map(r => r.id)).toEqual([2])

    const both = await quotes().find(
      ctx(db, { service: 'quotes', directives: { withTemplates: true } })) as { data: { id: number }[] }
    expect(both.data.map(r => r.id)).toEqual([1, 2])
  })

  test('the same names travel as `$` params, which is what a browser sends', async () => {
    const db = await tmplDb()
    // What the bridge produces from `?$onlyTemplates=true`: the parse is
    // toolbelt's, and this is the fallback path parseQuery keeps for callers
    // that predate ctx.directives.
    const out = await quotes().find(
      ctx(db, { service: 'quotes', query: { $onlyTemplates: 'true' } })) as { data: { id: number }[] }
    expect(out.data.map(r => r.id)).toEqual([2])
  })

  test('a directive the model cannot satisfy is a 400, not a silent no-op', async () => {
    // FJS-293: this answered the live rows — the opposite of the question —
    // with nothing anywhere saying the flag had not applied.
    const db  = await mkDb()
    const err = await createService({ name: 'posts', model: 'Post' })
      .find(ctx(db, { directives: { onlyDeleted: true } })).catch((e: Error) => e) as Error & { status?: number }

    expect(err.name).toBe('CapabilityNotDeclaredError')
    expect(err.status).toBe(400)
    expect(err.message).toContain('@@softDelete')
  })
})

describe('$search answers the list envelope', () => {

  async function ftsDb(): Promise<AnyClient> {
    const db = await createClient({
      db: ':memory:',
      schema: `model Doc {
        id   Int    @id
        body String
        @@fts([body])
      }`,
    }) as unknown as AnyClient
    const t = (db as unknown as Record<string, { create(a: unknown): Promise<unknown> }>).doc!
    await t.create({ data: { id: 1, body: 'a blue widget' } })
    await t.create({ data: { id: 2, body: 'nothing here'  } })
    return db
  }

  test('a match answers rows and a total', async () => {
    // It answered `{"limit":20,"offset":0}` — the branch destructured
    // `{ rows, total }` off the array `search()` returns, so a search that
    // matched came back empty with a 200.
    const out = await createService({ name: 'docs', model: 'Doc' })
      .find(ctx(await ftsDb(), { service: 'docs', directives: { search: 'widget' } })) as
      { data: { id: number }[]; total: number }

    expect(out.data.map(r => r.id)).toEqual([1])
    expect(out.total).toBe(1)
  })

  test('a model with no @@fts refuses with a 400, not a 500', async () => {
    // FJS-292. The message always named the fix; the STATUS said the server
    // had broken about a request it understood.
    const err = await createService({ name: 'posts', model: 'Post' })
      .find(ctx(await mkDb(), { directives: { search: 'x' } })).catch((e: Error) => e) as Error & { status?: number }

    expect(err.name).toBe('CapabilityNotDeclaredError')
    expect(err.status).toBe(400)
    expect(err.message).toContain('@@fts')
  })
})
