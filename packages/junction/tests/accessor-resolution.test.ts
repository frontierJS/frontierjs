// tests/accessor-resolution.test.ts
//
// A FrontierJS app names one model three ways:
//
//   model Post            in db/schema.lite      (PascalCase singular, mandatory)
//   posts.service.ts      → service 'posts'      (filename, and the URL)
//   db.post               the Litestone accessor (singular)
//
// Three places resolve an accessor against the client — getTable (the query),
// _gateLevels (@@gate auth) and resolveDefsKey (field validation) — and all
// three matched the literal string only. `model: 'posts'` therefore:
//
//   • threw from getTable                      (loud, findable)
//   • found no @@gate       → FAILED OPEN      (silent: auth disabled)
//   • found no schema       → FAILED OPEN      (silent: validation disabled)
//
// The fail-open pair is the reason this is a correctness test and not a DX one.
// A naming slip must never be the difference between a gated and an ungated
// service.

import { describe, test, expect } from 'bun:test'
import { createBaseService, createService } from '../src/core/service.ts'
import { createApp, defaultConfig } from '../index.ts'
import { gateAuth, autoValidate, accessorCandidates, resolveDefsKey } from '../src/core/litestone.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

// A Litestone-shaped client for `model Post`: accessor is SINGULAR, and the
// model is gated at level 4 (every operation needs a user). The $schema shape
// is what generateJsonSchema() consumes — enums/types must be present or it
// throws, _deriveJsonSchema swallows that, and validation silently no-ops.
function mkClient(rows: Record<string, unknown>[] = []) {
  return {
    $setAuth() { return this },
    $schema: {
      enums: [],
      types: [],
      models: [{
        name: 'Post',
        attributes: [{ kind: 'gate', value: '4' }],
        fields: [
          { name: 'id',    type: 'String', attributes: [] },
          { name: 'title', type: 'String', attributes: [] },
        ],
      }],
    },
    post: {
      findMany:         async () => rows,
      count:            async () => rows.length,
      findManyAndCount: async () => ({ rows, total: rows.length }),
      findUnique:       async () => rows[0] ?? null,
      findFirst:        async () => rows[0] ?? null,
      create:           async (a: { data: unknown }) => a.data,
    },
  }
}

function ctx(service: string, method = 'find', over: Record<string, unknown> = {}): ServiceContext {
  return {
    service, method, id: undefined, data: null,
    params: {}, query: {}, auth: {}, client: {},
    locals: { db: mkClient([{ id: '1', title: 'Hi' }]) }, app: {},
    ...over,
  } as unknown as ServiceContext
}

describe('accessorCandidates', () => {

  test('literal spelling always comes first', () => {
    // @@external models mirror foreign tables whose accessor may genuinely be
    // plural — the literal must win so they keep resolving to themselves.
    expect(accessorCandidates('posts')[0]).toBe('posts')
    expect(accessorCandidates('post')).toEqual(['post'])
  })

  test('irregular plurals fold the way deriveModelName says', () => {
    expect(accessorCandidates('categories')).toContain('category')
    expect(accessorCandidates('addresses')).toContain('address')
    // -ss / -us / -is / -as are not plural markers: no bogus candidate.
    expect(accessorCandidates('address')).toEqual(['address'])
    expect(accessorCandidates('status')).toEqual(['status'])
  })
})

describe('the query resolves under every spelling', () => {

  for (const model of ['post', 'posts']) {
    test(`model: '${model}' reaches db.post`, async () => {
      const svc = createService({ name: 'posts', model })
      const c = ctx('posts')
      const out = await svc.find(c) as { data: unknown[] }
      expect(out.data).toHaveLength(1)
    })
  }

  test('model omitted entirely — resolved from the service name', async () => {
    // The DX target: services/posts.service.ts containing only the factory.
    const base = createBaseService({})
    const svc  = createService({ name: 'posts', ...(base as object) } as never)
    const out  = await svc.find(ctx('posts')) as { data: unknown[] }
    expect(out.data).toHaveLength(1)
  })

  test('an unresolvable name names what it tried and what exists', async () => {
    const svc = createService({ name: 'widgets', model: 'widget' })
    const err = await svc.find(ctx('widgets')).catch((e: Error) => e)
    expect((err as Error).message).toContain('widget')
    expect((err as Error).message).toContain('Available: post')
  })
})

describe('@@gate must not fail open on a naming slip', () => {

  for (const accessor of ['post', 'posts', undefined]) {
    test(`gateAuth(${JSON.stringify(accessor)}) still rejects anonymous`, () => {
      // @@gate("4") — every operation needs a user. Before the fix, the plural
      // and omitted forms found no model, read that as "no gate declared",
      // and let the request through.
      expect(() => gateAuth(accessor, 'read')(ctx('posts'))).toThrow('Authentication required')
    })
  }

  test('an authenticated caller still passes', () => {
    const c = ctx('posts', 'find', { auth: { user: { userId: 'u1' } } })
    expect(() => gateAuth('posts', 'read')(c)).not.toThrow()
  })

  test('a model with no @@gate stays unrestricted', () => {
    const c = ctx('posts')
    ;(c.locals.db as { $schema: { models: { attributes: unknown[] }[] } })
      .$schema.models[0]!.attributes = []
    expect(() => gateAuth('posts', 'read')(c)).not.toThrow()
  })
})

describe('validation must not fail open on a naming slip', () => {

  const jsonSchema = {
    $defs: { Post: { type: 'object', properties: { id: {}, title: {} } } },
  } as never
  const parsed = { models: [{ name: 'Post' }] }

  test('resolveDefsKey maps every spelling to the declared model name', () => {
    expect(resolveDefsKey(jsonSchema, 'post',  parsed)).toBe('Post')
    // Was null before the fix — and null is what autoValidate reads as
    // "no schema for this model", i.e. nothing to validate.
    expect(resolveDefsKey(jsonSchema, 'posts', parsed)).toBe('Post')
  })

  test('an unrelated name still resolves to nothing', () => {
    expect(resolveDefsKey(jsonSchema, 'widgets', parsed)).toBeNull()
  })

  for (const accessor of ['post', 'posts', undefined]) {
    test(`autoValidate(${JSON.stringify(accessor)}) rejects a payload missing a required field`, async () => {
      // `title` is required on create; omitting it must 400 under every
      // spelling. Before the fix the plural/omitted forms found no schema and
      // let the write through unvalidated.
      const c = ctx('posts', 'create', { data: { id: '1' } })
      const err = await autoValidate(accessor, 'create')(c).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
    })
  }
})

// ─── against a real client, not a shaped object (FJS-014) ────────────────────
//
// Every test above uses mkClient(), a plain object. That is what let the
// "Available: …" list go unverified for so long: a real Litestone client is a
// Proxy, and its ownKeys trap returned `$setAuth` and `$db` twice, so
// `Object.keys(db)` THREW. The diagnostic below silently degraded to no list at
// all, and the only sign was a try/catch here explaining why.
//
// Fixed in litestone 2026-08-06 — all five traps dedupe. This pins the seam from
// this side, so the message cannot quietly lose its list again.

describe('the not-found message against a real Litestone client', () => {
  // By relative path: `bun install` resolves workspace:* to a copy, so a
  // package-name import would test a stale snapshot of the proxy under repair.
  const realClient = async () => {
    const { createClient } = await import('../../litestone/src/index.js')
    return createClient({
      schema: 'model Post { id Int @id  title String }\nmodel Author { id Int @id  name String }',
      db: ':memory:',
    })
  }

  test('a real client enumerates, so the list is actually there', async () => {
    const db: any = await realClient()
    const svc = createService({ name: 'widgets', model: 'widget' })
    const err = await svc.find(ctx('widgets', 'find', { locals: { db } }))
      .catch((e: Error) => e) as Error
    expect(err.message).toContain('widget')
    expect(err.message).toContain('Available: author, post')
    // …and not the failure that used to replace it
    expect(err.message).not.toContain('ownKeys')
    db.$close()
  })

  test('a client that refuses to enumerate still gets the rest of the message', async () => {
    // The reason the try/catch stays: `db` is whatever the app supplied.
    const hostile = new Proxy({}, {
      get: (_t, p) => p === '$setAuth' ? () => hostile : undefined,
      ownKeys() { throw new Error('no enumeration for you') },
    })
    const svc = createService({ name: 'widgets', model: 'widget' })
    const err = await svc.find(ctx('widgets', 'find', { locals: { db: hostile } }))
      .catch((e: Error) => e) as Error
    expect(err.message).toContain('widget')
    expect(err.message).toContain('PascalCase singular')
  })
})

// ─── An unknown filter key is a 400, not an empty page (FJS-109) ──────────────
//
// `GET /products?bogusColumn=7` answered `200 {"data":[],"total":0}` — the same
// answer as a misplaced directive and as a genuinely empty table. It cost an
// hour in example/'s prerendered catalogue, which fetched, resolved, rendered
// "0 of 0 products" and reported nothing wrong.
//
// Litestone knew: it validates where-keys, rejects them on writes, and on reads
// prints "Unknown field 'bogusColumn' … Valid fields: id, name" to the SERVER'S
// stderr. autoFilter asks it via $checkWhere rather than re-deriving the rule,
// so the typo hint and the AND/OR/NOT descent come from the one definition.

describe('autoFilter — unknown filter keys', () => {
  // Over HTTP, because that is the surface the bug was reported on and the one
  // that was silently wrong: the bridge splits `$` directives from filters, the
  // derived hook runs in the compiled pipeline, and the status reaches a client.
  const appFor = async (db: unknown, service = 'products', model = 'product') => {
    const app = createApp({
      db,
      config: {
        port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' },
        http: { ...defaultConfig.http, drainTimeout: 50 },
      },
    })
    app.services.register(createService({ name: service, model }))
    await app.start()
    return app
  }

  const appWithProducts = async () => {
    const { createClient } = await import('../../litestone/src/index.js')
    const db: any = await createClient({
      schema: 'model Product { id Int @id  name String  price Float @default(1) }',
      db: ':memory:',
    })
    await db.product.createMany({ data: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] })
    return { app: await appFor(db), db }
  }

  const get = async (app: any, path: string) => {
    const res = await app.http.fetch(new Request('http://localhost' + path))
    return { status: res.status, body: await res.json() as { message?: string, data?: unknown[] } }
  }

  test('a known column still filters', async () => {
    const { app, db } = await appWithProducts()
    const res = await get(app, '/products?name=a')
    expect(res.status).toBe(200)
    expect((res.body as { data: unknown[] }).data).toHaveLength(1)
    db.$close(); await app.stop()
  })

  test('an unknown key is a 400 naming the valid fields', async () => {
    const { app, db } = await appWithProducts()
    const res = await get(app, '/products?bogusColumn=7')
    expect(res.status).toBe(400)
    expect((res.body as { message: string }).message).toContain("'bogusColumn'")
    expect((res.body as { message: string }).message).toContain('id, name, price')
    db.$close(); await app.stop()
  })

  test('a typo gets the suggestion litestone already computes', async () => {
    const { app, db } = await appWithProducts()
    const res = await get(app, '/products?nme=a')
    expect(res.status).toBe(400)
    expect((res.body as { message: string }).message).toContain("did you mean 'name'")
    db.$close(); await app.stop()
  })

  // The case that started it: a directive sent as a filter. `limit` belongs on
  // `$limit`, and as a filter it silently matched nothing.
  test('a misplaced directive is named, and the message says where it belongs', async () => {
    const { app, db } = await appWithProducts()
    const res = await get(app, '/products?limit=100')
    expect(res.status).toBe(400)
    expect((res.body as { message: string }).message).toContain('$limit')
    db.$close(); await app.stop()
  })

  test('every bad key is named, not just the first', async () => {
    const { app, db } = await appWithProducts()
    const msg = (await get(app, '/products?nope=1&alsoNope=2')).body as { message: string }
    expect(msg.message).toContain("'nope'")
    expect(msg.message).toContain("'alsoNope'")
    db.$close(); await app.stop()
  })

  test('a real directive is untouched', async () => {
    const { app, db } = await appWithProducts()
    const res = await get(app, '/products?$limit=1')
    expect(res.status).toBe(200)
    expect((res.body as { data: unknown[] }).data).toHaveLength(1)
    db.$close(); await app.stop()
  })

  // The browser client serializes a nested filter as ?price={"$gte":0} — the
  // KEY stays a real column, so operator filters must not trip this.
  test('an operator filter passes — the key is still a column', async () => {
    const { app, db } = await appWithProducts()
    const res = await get(app, '/products?price=' + encodeURIComponent('{"$gte":0}'))
    expect(res.status).toBe(200)
    db.$close(); await app.stop()
  })

  // A stand-in client cannot answer, and "I cannot judge this" is not "this is
  // wrong" — rejecting what it failed to understand would be worse than the bug.
  test('a client without $checkWhere no-ops', async () => {
    // mkClient's Post is @@gate("4"), and gateAuth runs first — a 401 would
    // prove nothing about this hook. An ungated stand-in isolates it.
    const stub = {
      $setAuth() { return this },
      $schema: { enums: [], types: [], models: [{ name: 'Post', attributes: [], fields: [
        { name: 'id', type: 'String', attributes: [] },
      ] }] },
      post: {
        findMany: async () => [], count: async () => 0,
        findManyAndCount: async () => ({ rows: [], total: 0 }),
      },
    }
    const app = await appFor(stub, 'posts', 'post')
    expect((await get(app, '/posts?anythingAtAll=1')).status).toBe(200)
    await app.stop()
  })

  // A real Litestone client THROWS on an unknown property rather than answering
  // undefined — deliberately, so a typo'd accessor is loud. That makes the
  // capability probe itself a throwing expression. When `$checkWhere` was
  // missing from the scoped proxies, `typeof client.$checkWhere` took down every
  // list read in both apps with `"$checkWhere" is not a table in this schema`.
  // Litestone was fixed; this pins the boundary so a client that cannot answer
  // still no-ops rather than 500s.
  test('a client that THROWS on the probe no-ops', async () => {
    const tables = {
      post: {
        findMany: async () => [], count: async () => 0,
        findManyAndCount: async () => ({ rows: [], total: 0 }),
      },
    }
    const target = {
      $setAuth() { return proxy },
      $schema: { enums: [], types: [], models: [{ name: 'Post', attributes: [], fields: [
        { name: 'id', type: 'String', attributes: [] },
      ] }] },
      ...tables,
    }
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop in t) return Reflect.get(t, prop)
        throw new Error(`"${String(prop)}" is not a table in this schema. Tables: post`)
      },
      has(t, prop) { return prop in t },
    })
    const app = await appFor(proxy, 'posts', 'post')
    expect((await get(app, '/posts?anythingAtAll=1')).status).toBe(200)
    await app.stop()
  })
})
