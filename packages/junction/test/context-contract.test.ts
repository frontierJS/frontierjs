// The ServiceContext contract — FJS-D03.
//
// Five fields, five different rules, and they are the substance of what a
// Context IS here rather than a list of names:
//
//   auth        the principal. Frozen. PROPAGATES.
//   client      caller environment. Read-only. Propagates. Information, never authority.
//   route       path captures. Router-only — {} on an internal call.
//   locals      per-call scratch. Fresh {} every call. Does NOT propagate.
//   transients  the @transient keys of this call's payload, lifted off it by
//               autoValidate. Fresh {} every call. Does NOT propagate. Written
//               by the framework, where locals is written by whoever wants it.
//   reserved    the query keys the SERVICE declared as its own, lifted off
//               ctx.query by callService. Same freshness and the same
//               non-propagation; the query-side mirror of transients.
//
// This file exists because those four rules were written in `context.ts` and
// **one of them was false**: `auth` was documented as propagating and did not —
// it was built from `opts.auth` alone, so a nested `ctx.app.service(x)` call ran
// as STRANGER(0) while the doc promised the caller's identity. Nothing failed;
// the sub-call was simply refused by the model's own gate, or worse, allowed.
//
// A type cannot hold any of this: propagation, freezing and freshness are
// runtime behaviors. So they are asserted by running them.

import { describe, test, expect } from 'bun:test'
import { createApp }     from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'

const alice = { userId: 'alice', role: 'user' } as never
const bob   = { userId: 'bob',   role: 'user' } as never

/** An app whose `leaf` service records the context it was called with. */
function harness() {
  const app  = createApp()
  const seen: Record<string, any> = {}

  app.services.register(createService({
    name: 'leaf',
    methods: ['find'],
    find(ctx: any) {
      seen[ctx.query.tag ?? 'default'] = {
        user:   ctx.auth?.user?.userId ?? null,
        client: ctx.client,
        route:  ctx.route,
        locals: ctx.locals,
        transients: ctx.transients,
        reserved:   ctx.reserved,
        query:      { ...ctx.query },
      }
      return []
    },
  } as never))

  return { app, seen }
}

describe('auth — the principal, frozen, and it propagates', () => {
  test('a call naming no principal inherits the one in scope', async () => {
    const { app, seen } = harness()

    app.services.register(createService({
      name: 'root', methods: ['find'],
      async find(ctx: any) { await ctx.app.service('leaf').find({ tag: 'a' }); return [] },
    } as never))

    await app.service('root').find({}, { auth: { user: alice } } as never)
    expect(seen.a.user).toBe('alice')
  })

  test('it propagates at DEPTH, not just one level', async () => {
    const { app, seen } = harness()

    app.services.register(createService({
      name: 'mid', methods: ['find'],
      async find(ctx: any) { await ctx.app.service('leaf').find({ tag: 'deep' }); return [] },
    } as never))
    app.services.register(createService({
      name: 'root', methods: ['find'],
      async find(ctx: any) { await ctx.app.service('mid').find({}); return [] },
    } as never))

    await app.service('root').find({}, { auth: { user: alice } } as never)
    expect(seen.deep.user).toBe('alice')
  })

  test('ABSENT is not NULL — an explicit { user: null } stays anonymous', async () => {
    // The escape hatch, and the reason `in` is used rather than `??`. A service
    // that deliberately reads as a stranger would — what does the public
    // listing return — has to be able to say so.
    const { app, seen } = harness()

    app.services.register(createService({
      name: 'root', methods: ['find'],
      async find(ctx: any) {
        await ctx.app.service('leaf').find({ tag: 'nobody' }, { auth: { user: null } })
        return []
      },
    } as never))

    await app.service('root').find({}, { auth: { user: alice } } as never)
    expect(seen.nobody.user).toBeNull()
  })

  test('a changed principal re-scopes, so ITS children inherit IT', async () => {
    // The case a request-wide store alone gets wrong: root runs as alice and
    // calls mid as bob; anything mid calls must be bob, not the request's alice.
    const { app, seen } = harness()

    app.services.register(createService({
      name: 'mid', methods: ['find'],
      async find(ctx: any) { await ctx.app.service('leaf').find({ tag: 'grandchild' }); return [] },
    } as never))
    app.services.register(createService({
      name: 'root', methods: ['find'],
      async find(ctx: any) { await ctx.app.service('mid').find({}, { auth: { user: bob } }); return [] },
    } as never))

    await app.service('root').find({}, { auth: { user: alice } } as never)
    expect(seen.grandchild.user).toBe('bob')
  })

  test('the principal is frozen — a hook cannot mutate it into a sibling call', async () => {
    const { app } = harness()
    let caught: unknown = null

    app.services.register(createService({
      name: 'root', methods: ['find'],
      async find(ctx: any) {
        try { ctx.auth.user.role = 'admin' } catch (e) { caught = e }
        return []
      },
    } as never))

    await app.service('root').find({}, { auth: { user: { userId: 'alice', role: 'user' } } } as never)
    // Frozen in strict mode throws rather than silently dropping the write —
    // the frozen reference is SHARED across calls, so a silent drop would be
    // the good case and a silent success would be privilege escalation.
    expect(caught).not.toBeNull()
  })
})

describe('client — propagates, and is information rather than authority', () => {
  test('it reaches a nested call', async () => {
    const { app, seen } = harness()

    app.services.register(createService({
      name: 'root', methods: ['find'],
      async find(ctx: any) { await ctx.app.service('leaf').find({ tag: 'c' }); return [] },
    } as never))

    // No request here, so there is nothing to inherit — the shape is still the
    // shape, which is what stops every reader testing for it.
    await app.service('root').find({})
    expect(seen.c.client).toEqual({ headers: {} })
  })
})

describe('route — router-only', () => {
  test('an internal call has no path captures, because there was no path', async () => {
    const { app, seen } = harness()
    await app.service('leaf').find({ tag: 'r' })
    expect(seen.r.route).toEqual({})
  })
})

describe('locals — fresh per call, and it does NOT propagate', () => {
  test('a sub-service cannot reach its caller by writing locals', async () => {
    const { app } = harness()
    let leaked: unknown = 'unset'

    app.services.register(createService({
      name: 'writer', methods: ['find'],
      async find(ctx: any) { ctx.locals.secret = 'from-child'; return [] },
    } as never))

    app.services.register(createService({
      name: 'root', methods: ['find'],
      async find(ctx: any) {
        await ctx.app.service('writer').find({})
        leaked = ctx.locals.secret
        return []
      },
    } as never))

    await app.service('root').find({})
    expect(leaked).toBeUndefined()
  })

  test('and a caller cannot leak into a sub-call by accident', async () => {
    const { app, seen } = harness()

    app.services.register(createService({
      name: 'root', methods: ['find'],
      async find(ctx: any) {
        ctx.locals.scratch = 'parent'
        await ctx.app.service('leaf').find({ tag: 'l' })
        return []
      },
    } as never))

    await app.service('root').find({})
    expect(seen.l.locals.scratch).toBeUndefined()
  })

  test('locals CAN be handed down deliberately — passed, never inherited', async () => {
    const { app, seen } = harness()

    app.services.register(createService({
      name: 'root', methods: ['find'],
      async find(ctx: any) {
        await ctx.app.service('leaf').find({ tag: 'given' }, { locals: { scratch: 'stated' } })
        return []
      },
    } as never))

    await app.service('root').find({})
    expect(seen.given.locals.scratch).toBe('stated')
  })
})

describe('transients — fresh per call, and it does NOT propagate', () => {
  test('a service with no @transient field still has the key', async () => {
    // Always present, so `ctx.transients.x` is a read rather than a crash on
    // every service that declares none — which is nearly all of them.
    const { app, seen } = harness()
    await app.service('leaf').find({ tag: 't' })
    expect(seen.t.transients).toEqual({})
  })

  test('a sub-call does not inherit what its caller was sent', async () => {
    // Same rule as locals, for a different reason: a transient value is part of
    // ONE payload. A nested call has its own, or none.
    const { app, seen } = harness()

    app.services.register(createService({
      name: 'root', methods: ['find'],
      async find(ctx: any) {
        ctx.transients.secret = 'from-parent'
        await ctx.app.service('leaf').find({ tag: 'nested' })
        return []
      },
    } as never))

    await app.service('root').find({})
    expect(seen.nested.transients.secret).toBeUndefined()
  })
})

describe('reserved — the query keys a service owns rather than filters on', () => {
  test('a service reserving nothing still has the key', async () => {
    // Always present, so `ctx.reserved.x` is a read rather than a crash on the
    // services that declare none, which is nearly all of them.
    const { app, seen } = harness()
    await app.service('leaf').find({ tag: 't' })
    expect(seen.t.reserved).toEqual({})
  })

  test('a reserved key is moved off the query before any hook runs', async () => {
    // The lift is in callService rather than in a hook, so `ctx.query` is
    // columns alone for the app's own leading hook as much as for the derived
    // autoFilter behind it.
    const app = createApp()
    const at: Record<string, any> = {}

    app.services.register(createService({
      name: 'owned',
      methods: ['find'],
      reservedQuery: ['workspace_id'],
      hooks: { before: { find: [(ctx: any) => { at.hook = { query: { ...ctx.query }, reserved: { ...ctx.reserved } } }] } },
      find(ctx: any) {
        at.method = { query: { ...ctx.query }, reserved: { ...ctx.reserved } }
        return []
      },
    } as never))

    await app.service('owned').find({ workspace_id: 'ws_7', status: 'live' })

    expect(at.hook.reserved).toEqual({ workspace_id: 'ws_7' })
    expect(at.hook.query).toEqual({ status: 'live' })
    expect(at.method.reserved).toEqual({ workspace_id: 'ws_7' })
    expect(at.method.query).toEqual({ status: 'live' })
  })

  test('a key the caller did not send is simply absent', async () => {
    const app = createApp()
    let seen: any = null
    app.services.register(createService({
      name: 'owned2', methods: ['find'], reservedQuery: ['workspace_id'],
      find(ctx: any) { seen = { ...ctx.reserved }; return [] },
    } as never))

    await app.service('owned2').find({ status: 'live' })
    expect(seen).toEqual({})
  })

  test('a sub-call does not inherit what its caller reserved', async () => {
    const { app, seen } = harness()

    app.services.register(createService({
      name: 'root-r', methods: ['find'],
      async find(ctx: any) {
        ctx.reserved.workspace_id = 'from-parent'
        await ctx.app.service('leaf').find({ tag: 'nested-r' })
        return []
      },
    } as never))

    await app.service('root-r').find({})
    expect(seen['nested-r'].reserved.workspace_id).toBeUndefined()
  })

  test('a $-name cannot be reserved', async () => {
    // Decidable with no client: $ is transport syntax and the directive table
    // owns every name under it (Invariant 10), so reserving one would put two
    // owners on a single spelling.
    expect(() => createService({
      name: 'bad', reservedQuery: ['$limit'],
    } as never)).toThrow(/directive/)
  })
})
