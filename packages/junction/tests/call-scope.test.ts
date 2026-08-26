// tests/call-scope.test.ts
//
// `$` is the service call in progress. Two rules make a surface this broad
// safe, and everything here is one of them or a leak that would break one:
//
//   READ-ONLY   — a writable ambient object is cross-cutting mutable state
//                 with no owner. Breadth on its own is not the risk.
//   CALL LIFETIME — outside a call it throws by name. An ambient dependency
//                 is an undeclared one, and what makes that acceptable is
//                 that the failure is loud, immediate and names itself.
//
// The rest is leakage: a nested call must not overwrite its parent, two
// concurrent calls must not see each other, a throw must not leave a scope
// standing, and `transactional:` must move `$.db` because it reassigns
// ctx.locals.db under the method mid-call.

import { describe, test, expect } from 'bun:test'
import { createApp, createService, defaultConfig }        from '../index.ts'
import { $, currentCall, enterCall, announcingService }   from '../src/core/context.ts'
import { createClient }                                   from '../../litestone/src/index.js'

function app(...services: any[]) {
  const a: any = createApp({
    config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
  })
  for (const s of services) a.services.register(s)
  return a
}

describe('call lifetime', () => {

  test('outside a call, `$` throws by name — never undefined', () => {
    expect(currentCall()).toBeUndefined()
    expect(() => $.locals).toThrow(/'\$' was read outside a service call \(reading 'locals'\)/)
    // The message has to say where it IS legal, or the reader has only "no".
    expect(() => $.data).toThrow(/service method, a hook, an afterCommit effect/)
  })

  test('`$` is not thenable — awaiting it must not resolve to something else', async () => {
    expect(($ as unknown as { then?: unknown }).then).toBeUndefined()
  })

  test('inspecting `$` outside a call does not throw — symbols are protocol', () => {
    // A logger printing the object must not become the error being reported.
    expect(() => String(Object.prototype.toString.call($))).not.toThrow()
  })

  test('the scope covers the method', async () => {
    let seen: unknown
    const a = app(createService({
      name: 'probe', methods: ['find'],
      async find() { seen = { id: $.id, method: $.method, service: $.service }; return [] },
    }))
    await a.service('probe').find()
    expect(seen).toEqual({ id: null, method: 'find', service: 'probe' })
  })

  test('the scope covers before and after hooks', async () => {
    const at: string[] = []
    const svc = createService({
      name: 'probe', methods: ['find'],
      async find() { at.push('method:' + $.service); return [] },
    })
    svc.hooks({
      before: { all: [async () => { at.push('before:' + $.service) }] },
      after:  { all: [async () => { at.push('after:'  + $.service) }] },
    })
    await app(svc).service('probe').find()
    expect(at).toEqual(['before:probe', 'method:probe', 'after:probe'])
  })

  test('the scope covers afterCommit — the span reaches past the pipeline', async () => {
    let inEffect: string | undefined
    let threw: unknown = null
    const a = app(createService({
      name: 'probe', methods: ['create'],
      async create(ctx: any) {
        ctx.afterCommit(() => {
          try { inEffect = $.service } catch (e) { threw = e }
        })
        return { ok: true }
      },
    }))
    await a.service('probe').create({})
    expect(threw).toBeNull()
    expect(inEffect).toBe('probe')
  })

  test('the scope is gone after the call returns', async () => {
    const a = app(createService({
      name: 'probe', methods: ['find'], async find() { return [] },
    }))
    await a.service('probe').find()
    expect(currentCall()).toBeUndefined()
    expect(() => $.service).toThrow(/outside a service call/)
  })

  test('a throwing method does not leave a scope standing', async () => {
    const a = app(createService({
      name: 'probe', methods: ['find'],
      async find() { throw new Error('boom') },
    }))
    await expect(a.service('probe').find()).rejects.toThrow('boom')
    expect(currentCall()).toBeUndefined()
  })
})

describe('calling a method directly', () => {

  // callService opens the scope for every ordinary path — HTTP, a socket frame,
  // app.service(x).find(). What it does not cover is a hand-built context
  // calling a method as a plain function, which this suite and several others
  // do (tests/populate.test.ts, tests/real-litestone-client.test.ts). Those
  // pass today because createBaseService's CRUD reads the ctx PARAMETER; a
  // method reading `$` has no such luck, and `enterCall` is the only way in.

  const method = async () => ({ saw: $.service, id: $.id })

  test('without enterCall it throws, rather than answering undefined', async () => {
    expect(method()).rejects.toThrow(/outside a service call/)
  })

  test('enterCall is the way in, and it is exported', async () => {
    const ctx = { service: 'widgets', id: '7' } as never
    const out = await enterCall(ctx, () => method())
    expect(out).toEqual({ saw: 'widgets', id: '7' })
  })

  test('it nests and restores, so a direct call inside a real one is safe', async () => {
    const outer = { service: 'outer', id: '1' } as never
    const inner = { service: 'inner', id: '2' } as never
    const seen = await enterCall(outer, async () => {
      const a = $.service
      const b = await enterCall(inner, () => method())
      return { before: a, inner: b.saw, after: $.service }
    })
    expect(seen).toEqual({ before: 'outer', inner: 'inner', after: 'outer' })
  })
})

describe('read-only', () => {

  test('an invented key is refused, and the message names what IS writable', () => {
    enterCall({ service: 'x' } as never, () => {
      expect(() => { ($ as never as Record<string, unknown>).nope = 1 })
        .toThrow(/'\$\.nope' cannot be assigned.*data, query, id, result/s)
      expect(() => Object.defineProperty($, 'nope', { value: 1 })).toThrow(/cannot be assigned/)
      expect(() => { delete ($ as never as Record<string, unknown>).service })
        .toThrow(/cannot be assigned/)
    })
  })

  test("junction's own contract properties CAN be assigned", () => {
    // `ctx.dispatch = false` is the documented way a read-shaped custom method
    // says "do not broadcast this". With no spelling on `$` it forced eighteen
    // call sites in one app to keep taking a context for that line alone.
    const ctx = { service: 'x', data: null, dispatch: undefined } as never as Record<string, unknown>
    enterCall(ctx as never, () => {
      $.dispatch = false
      $.data = { a: 1 }
      $.statusCode = 202
    })
    expect(ctx.dispatch).toBe(false)
    expect(ctx.data).toEqual({ a: 1 })
    expect(ctx.statusCode).toBe(202)
  })

  test('reading still works through spread and destructuring', () => {
    enterCall({ service: 'x', method: 'find', locals: {}, auth: { user: null } } as never, () => {
      const { service, method } = $
      expect([service, method]).toEqual(['x', 'find'])
      expect(Object.keys({ ...$ })).toContain('service')
      expect('db' in $).toBe(true)
    })
  })
})

describe('db', () => {

  test('`$.db` with no client refuses by name rather than answering undefined', () => {
    enterCall({ service: 'x', locals: {} } as never, () => {
      expect(() => $.db).toThrow(/no Litestone client on ctx\.locals\.db/)
    })
  })

  test('`transactional:` moves `$.db` — resolved per read, never snapshotted', async () => {
    const db: any = await createClient({
      db: ':memory:',
      schema: 'model Post { id Int @id\n title String\n @@gate("0.0.0.0") }',
    })
    const MARKER = { marker: true } as never
    let outer: unknown, inner: unknown, moved = false
    const a: any = createApp({
      db,
      config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
    })
    a.services.register(createService({
      name: 'posts', model: 'Post', transactional: true, methods: ['run'],
      async run(ctx: any) {
        outer = ctx.locals.db
        inner = $.db          // the client the around hook installed
        // Resolved per read, not snapshotted: move it and `$` must follow. A
        // snapshot would keep answering the pre-transaction client, and every
        // write in the method would commit outside the transaction.
        const before = $.db
        ctx.locals.db = MARKER
        moved = $.db !== before && $.db === MARKER
        ctx.locals.db = outer
        ctx.dispatch = false   // not a Post row; nothing to announce
        return { ok: true }
      },
    }))
    await a.service('posts').call('run')
    expect(inner).toBe(outer)
    expect(moved).toBe(true)
  })
})

describe('leakage', () => {

  test('a nested call gets its own context; the parent is intact after', async () => {
    const seen: Record<string, unknown> = {}
    const inner = createService({
      name: 'inner', methods: ['find'],
      async find() { seen.inner = $.service; return [] },
    })
    const outer = createService({
      name: 'outer', methods: ['find'],
      async find(ctx: any) {
        seen.beforeNest = $.service
        await ctx.app.service('inner').find()
        seen.afterNest = $.service
        return []
      },
    })
    const a = app(inner, outer)
    await a.service('outer').find()
    expect(seen).toEqual({ beforeNest: 'outer', inner: 'inner', afterNest: 'outer' })
  })

  test('a nested call does not overwrite the parent locals', async () => {
    let parentLocal: unknown
    const inner = createService({
      name: 'inner', methods: ['find'],
      async find() { ($.locals as Record<string, unknown>).mine = 'inner'; return [] },
    })
    const outer = createService({
      name: 'outer', methods: ['find'],
      async find(ctx: any) {
        ($.locals as Record<string, unknown>).mine = 'outer'
        await ctx.app.service('inner').find()
        parentLocal = ($.locals as Record<string, unknown>).mine
        return []
      },
    })
    await app(inner, outer).service('outer').find()
    // locals is fresh per call and does NOT propagate — the inner write must
    // land somewhere else entirely.
    expect(parentLocal).toBe('outer')
  })

  test('concurrent calls cannot observe each other', async () => {
    const a = app(createService({
      name: 'probe', methods: ['get'],
      async get() {
        const mine = $.id
        // Yield hard enough that every call is interleaved mid-flight.
        await new Promise(r => setTimeout(r, 5 + Math.floor(Number(mine) % 7)))
        return { asked: mine, sawAfterAwait: $.id }
      },
    }))
    const out = await Promise.all(
      Array.from({ length: 25 }, (_, i) => a.service('probe').get(String(i))))
    for (const r of out as any[]) expect(r.sawAfterAwait).toBe(r.asked)
    expect(new Set((out as any[]).map(r => r.asked)).size).toBe(25)
  })

  test('a principal change re-enters the request without moving the call', async () => {
    const seen: Record<string, unknown> = {}
    const inner = createService({
      name: 'inner', methods: ['find'],
      async find() { seen.innerUser = $.auth.user?.userId; seen.innerSvc = $.service; return [] },
    })
    const outer = createService({
      name: 'outer', methods: ['find'],
      async find(ctx: any) {
        await ctx.app.service('inner').find(undefined, { auth: { user: { userId: 'bob' } } })
        seen.outerUser = $.auth.user?.userId ?? null
        seen.outerSvc  = $.service
        return []
      },
    })
    const a = app(inner, outer)
    await a.service('outer').find(undefined, { auth: { user: { userId: 'alice' } } })
    expect(seen).toEqual({
      innerUser: 'bob', innerSvc: 'inner',
      outerUser: 'alice', outerSvc: 'outer',
    })
  })
})

describe('the announcing-service store stayed narrow', () => {

  test('it is already closed by afterCommit, so a write there still announces', async () => {
    let during: string | undefined = 'unset'
    let inEffect: string | undefined = 'unset'
    const a = app(createService({
      name: 'probe', methods: ['create'],
      async create(ctx: any) {
        during = announcingService()
        ctx.afterCommit(() => { inEffect = announcingService() })
        return { ok: true }
      },
    }))
    await a.service('probe').create({})
    // Inside the pipeline the tap must suppress; by afterCommit it must not,
    // or a write from an effect is broadcast to nobody. This is the assertion
    // that fails if the two stores are ever merged into one span.
    expect(during).toBe('probe')
    expect(inEffect).toBeUndefined()
  })
})
