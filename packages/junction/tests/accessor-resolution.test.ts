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
