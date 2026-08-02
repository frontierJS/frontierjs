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
