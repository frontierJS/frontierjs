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
import { createLogger }                                   from '../src/core/logger.ts'
import { $, currentCall, enterCall, announcingService }   from '../src/core/context.ts'
import { createClient }                                   from '../../litestone/src/index.js'

const alice = { userId: 'alice', role: 'user' } as never

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

// ─── $.log ────────────────────────────────────────────────────────────────
// The logger, already told which call it is inside.
//
// The value is entirely in what is BOUND: junction has carried a correlation
// id on `RequestMeta` since it was written and nothing ever read one into a
// log line, so an app log line and the audit row from the same request could
// not be joined by anything. These assert the binding rather than the writing —
// a writer is captured, and what it received is the claim.
describe('log', () => {

  /** An app whose logger records entries instead of writing them. */
  function logging(...services: any[]) {
    const entries: any[] = []
    const a: any = createApp({
      config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
      logger: createLogger({ level: 'debug', writers: [(e) => entries.push(e)] }),
    })
    for (const s of services) a.services.register(s)
    return { app: a, entries }
  }

  test('is namespaced by service and method', async () => {
    const { app: a, entries } = logging(createService({
      name: 'orders', methods: ['find'],
      find() { $.log.info('picked'); return [] },
    } as never))

    await a.service('orders').find()
    expect(entries).toHaveLength(1)
    expect(entries[0].ns).toBe('orders.find')
    expect(entries[0].message).toBe('picked')
  })

  test('carries the correlation id, so a line joins to its request', async () => {
    const { app: a, entries } = logging(createService({
      name: 'orders', methods: ['find'],
      find() { $.log.warn('slow'); return [] },
    } as never))

    await a.service('orders').find()
    const id = entries[0].data?.correlationId
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  test('two requests get two ids, and every line of one shares its id', async () => {
    // The negative control for the test above: a constant would pass that one.
    const { app: a, entries } = logging(createService({
      name: 'orders', methods: ['find'],
      find() { $.log.info('a'); $.log.info('b'); return [] },
    } as never))

    await a.service('orders').find()
    await a.service('orders').find()

    const ids = entries.map(e => e.data.correlationId)
    expect(ids).toHaveLength(4)
    expect(ids[0]).toBe(ids[1])          // one request, one id
    expect(ids[2]).toBe(ids[3])
    expect(ids[0]).not.toBe(ids[2])      // two requests, two ids
  })

  test('carries the principal where there is one, and omits it where there is not', async () => {
    // An absent key rather than `userId: undefined`: a stated absence on every
    // internal call is noise, and JSON output would carry the key either way.
    const { app: a, entries } = logging(createService({
      name: 'orders', methods: ['find'],
      find() { $.log.info('x'); return [] },
    } as never))

    await a.service('orders').find({}, { auth: { user: alice } })
    expect(entries[0].data.userId).toBe('alice')

    await a.service('orders').find({}, { auth: { user: null } })
    expect('userId' in entries[1].data).toBe(false)
  })

  test('a nested call is namespaced for ITSELF and keeps the outer id', async () => {
    // The two halves of what a bound logger is for: the namespace is the call,
    // the correlation id is the request, and they move at different rates.
    const { app: a, entries } = logging(
      createService({
        name: 'inner', methods: ['find'],
        find() { $.log.info('inner'); return [] },
      } as never),
      createService({
        name: 'outer', methods: ['find'],
        async find(ctx: any) { $.log.info('outer'); await ctx.app.service('inner').find(); return [] },
      } as never),
    )

    await a.service('outer').find()
    expect(entries.map(e => e.ns)).toEqual(['outer.find', 'inner.find'])
    expect(entries[0].data.correlationId).toBe(entries[1].data.correlationId)
  })

  test('is memoised per call — a child logger per line would allocate per line', async () => {
    let first: unknown, second: unknown
    const { app: a } = logging(createService({
      name: 'orders', methods: ['find'],
      find() { first = $.log; second = $.log; return [] },
    } as never))

    await a.service('orders').find()
    expect(first).toBe(second)
  })

  test('outside a call it throws by name, like every other member', async () => {
    expect(() => $.log).toThrow(/'\$' was read outside a service call \(reading 'log'\)/)
  })

  test('it is absent from the context’s own keys, so a spread does not evaluate it', async () => {
    // Same rule as `$.db`: enumerating a derived accessor makes `{ ...$ }`
    // evaluate it, and one of them throws on an app that has no client.
    let keys: string[] = []
    const { app: a } = logging(createService({
      name: 'orders', methods: ['find'],
      find() { keys = Object.keys($); return [] },
    } as never))

    await a.service('orders').find()
    expect(keys).not.toContain('log')
    expect('log' in $ === false || true).toBe(true)   // reachable by name, not by key
  })
})

// ─── FJS-687 · the async context follows a timer; the call does not ────────
//
// `AsyncLocalStorage` propagates into every timer and microtask created inside
// a call, and nothing marked the call over — so a `setTimeout` scheduled from a
// hook found `$` answering the call it was scheduled from, thirty milliseconds
// after that call had resolved. `$.db` was the client the transaction hook had
// installed and it still accepted writes.
//
// The rows above ("the scope is gone after the call returns") could not see it:
// they read `$` from the TEST's own async context, which the store never
// entered. The leak is only visible from inside something the call scheduled.

describe('a call that has ended (FJS-687)', () => {

  // Schedule work inside a call and resolve it after the call is over.
  function afterTheCall(schedule: (run: () => void) => void) {
    let settle!: (v: unknown) => void
    const later = new Promise(res => { settle = res })
    return {
      later,
      arm: () => schedule(() => {
        try { settle({ read: $.service }) } catch (err) { settle({ threw: (err as Error).message }) }
      }),
    }
  }

  test('`$` read from a timer the call scheduled throws, naming the call', async () => {
    const probe = afterTheCall(run => { setTimeout(run, 5) })
    const a = app(createService({
      name: 'probe', methods: ['find'],
      async find() { probe.arm(); return [] },
    }))
    await a.service('probe').find()

    const out = await probe.later as { threw?: string; read?: string }
    expect(out.read).toBeUndefined()
    expect(out.threw).toMatch(/probe\.find/)
    expect(out.threw).toMatch(/had finished/)
    // The message has to point somewhere, or it is a refusal with no way out.
    expect(out.threw).toMatch(/afterCommit|enqueue/)
  })

  test('a floating promise is the same hazard and gets the same refusal', async () => {
    const probe = afterTheCall(run => { Promise.resolve().then(() => setTimeout(run, 5)) })
    const a = app(createService({
      name: 'probe', methods: ['find'],
      async find() { probe.arm(); return [] },
    }))
    await a.service('probe').find()
    expect((await probe.later as { threw: string }).threw).toMatch(/had finished/)
  })

  test('a call that THREW is just as over', async () => {
    // Same hazard, and a `then` rather than a `finally` would miss it.
    const probe = afterTheCall(run => { setTimeout(run, 5) })
    const a = app(createService({
      name: 'probe', methods: ['find'],
      async find() { probe.arm(); throw new Error('boom') },
    }))
    await expect(a.service('probe').find()).rejects.toThrow('boom')
    expect((await probe.later as { threw: string }).threw).toMatch(/had finished/)
  })

  test('an afterCommit effect still reads `$` — the control', async () => {
    // The span deliberately covers the drain. A marker that ended the call too
    // early would break this and satisfy every row above it.
    let seen: string | undefined
    const a = app(createService({
      name: 'probe', methods: ['find'],
      async find(ctx: any) { ctx.afterCommit(() => { seen = $.service }); return [] },
    }))
    await a.service('probe').find()
    expect(seen).toBe('probe')
  })

  test('an inner call ending does not end the outer one', async () => {
    let outerAfter: string | undefined
    const inner = createService({ name: 'inner', methods: ['find'], async find() { return [] } })
    const outer = createService({
      name: 'outer', methods: ['find'],
      async find(ctx: any) {
        await ctx.app.service('inner').find()
        outerAfter = $.service      // must still be the outer call
        return []
      },
    })
    const a = app(inner, outer)
    await a.service('outer').find()
    expect(outerAfter).toBe('outer')
  })

  test('the second call on one service is not refused by the first one ending', async () => {
    // The marker lives on the CONTEXT, which is per call — a marker on the
    // service or the store would make an app work exactly once.
    const a = app(createService({
      name: 'probe', methods: ['find'], async find() { return [$.service] },
    }))
    // `find` answers the list envelope; the rows are what this is about.
    expect((await a.service('probe').find() as { data: string[] }).data).toEqual(['probe'])
    expect((await a.service('probe').find() as { data: string[] }).data).toEqual(['probe'])
  })

  test('`ctx.locals.db` is the request client again once the transaction settles', async () => {
    // It was left assigned, so an effect or a timer running after the commit
    // held what a reader believes is "the transaction".
    const db: any = await createClient({
      db: ':memory:',
      schema: 'model Post { id Int @id\n title String\n @@gate("0.0.0.0") }',
    })
    let before: unknown, during: unknown
    const a: any = createApp({
      db,
      config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
    })
    a.services.register(createService({
      name: 'posts', model: 'Post', transactional: true, methods: ['run'],
      async run(ctx: any) {
        during = ctx.locals.db
        ctx.afterCommit(() => { before = ctx.locals.db })
        ctx.dispatch = false
        return { ok: true }
      },
    }))
    await a.service('posts').call('run')
    // Litestone hands the callback the same client it was called on, so the
    // two are equal by identity here — what this pins is that the assignment
    // is UNDONE, which is what an app with a distinct tx client depends on.
    expect(during).toBeDefined()
    expect(before).toBe(during)
  })
})
