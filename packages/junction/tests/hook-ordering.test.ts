// tests/hook-ordering.test.ts — where an app's own hook sits in the chain.
//
// `FJS-403`. The derived layer used to trail the app's entirely, so the run
// order for a model service was `<app hooks> → gateAuth → autoValidate` and an
// app rule that read the database read it for strangers. Measured on `example`:
// an unauthenticated POST naming a customer that does not exist answered 400
// "That customer is no longer on file" and the same request naming a real one
// answered 401 — a working existence oracle over a gated table.
//
// The layer is in two halves now:
//
//   gateAuth  →  the app's own before hooks  →  autoValidate/Filter/Sort
//
// and `validated:` is the phase that runs after all of it, for a rule that
// needs a graded caller and a coerced payload. A real client throughout: the
// gate levels come off a parsed schema, and a fake db has none.

import { describe, test, expect } from 'bun:test'
import { createClient }           from '../../litestone/src/index.js'
import { createService, callService } from '../src/core/service.ts'
import { bridge }                 from '../src/transport/bridge.ts'
import type { ServiceContext }    from '../src/transport/bridge.ts'

const SCHEMA = `
  model Customer {
    id   Int    @id
    name String
    @@gate("4.4.4.5")
  }

  model Order {
    id         Int    @id
    customerId Int
    total      Float
    @@gate("4.4.4.5")
  }
`

async function mkDb() {
  const db = await createClient({ db: ':memory:', schema: SCHEMA }) as never as {
    asSystem(): Record<string, { create(a: unknown): Promise<unknown> }>
  }
  await db.asSystem().customer!.create({ data: { id: 1, name: 'Ada' } })
  return db
}

// `@@gate("4.4.4.5")` — USER for read/create/update, ADMINISTRATOR for delete.
// Two graders read this principal (junction's `sessionGateLevel` for the 401,
// litestone's own for the 403) and only the explicit standing satisfies both
// without modeling a lifecycle these tests are not about.
const SIGNED_IN = { userId: 1, id: 1, isAdmin: true }

/** A context with no principal — the stranger the gate is there to refuse. */
function anonCtx(db: unknown, method: string, data: unknown): ServiceContext {
  return bridge.internal('orders', method as never, data as never, {
    auth:   { user: null },
    locals: { db },
  } as never)
}

/** The same call, made by a caller the gate admits. */
function userCtx(db: unknown, method: string, data: unknown, id?: string): ServiceContext {
  const ctx = bridge.internal('orders', method as never, data as never, {
    auth:   { user: SIGNED_IN },
    locals: { db },
  } as never)
  if (id !== undefined) ctx.id = id
  return ctx
}

describe('FJS-403 — the gate leads the chain', () => {

  test("an app's before hook does not run for a caller the gate refuses", async () => {
    const db  = await mkDb()
    const ran: string[] = []

    const svc = createService({
      name: 'orders', model: 'Order', db: () => db,
      hooks: {
        before: {
          create: [async function customerMustExist(ctx: ServiceContext) {
            ran.push('customerMustExist')
            const found = await (ctx.locals.db as never as Record<string, {
              findUnique(a: unknown): Promise<unknown>
            }>).customer!.findUnique({ where: { id: (ctx.data as { customerId: number }).customerId } })
            if (!found) throw Object.assign(new Error('no such customer'), { code: 400 })
          }],
        },
      },
    })

    // The payload that used to answer 400 — the oracle. It must answer 401 now,
    // and the hook that would have looked the customer up must not have run.
    const err = await callService(
      svc, anonCtx(db, 'create', { id: 1, customerId: 999, total: 12.5 })
    ).then(() => null, (e: { code?: number }) => e)

    expect((err as { code?: number })?.code).toBe(401)
    expect(ran).toEqual([])
  })

  test("a service's `before: { all }` hook does not run for a stranger either", async () => {
    // The reason the gate is an AROUND hook. `resolvePipelines` runs `all`
    // ahead of the per-method list, so leading that list would have left this
    // shape holding the whole defect.
    const db  = await mkDb()
    const ran: string[] = []

    const svc = createService({
      name: 'orders', model: 'Order', db: () => db,
      hooks: { before: { all: [function everything() { ran.push('all') }] } },
    })

    await callService(svc, anonCtx(db, 'create', { id: 1, customerId: 1, total: 12.5 }))
      .catch(() => {})

    expect(ran).toEqual([])
  })

  test("an app-level `before: { all }` hook does not run for a stranger", async () => {
    const db  = await mkDb()
    const ran: string[] = []

    const svc = createService({ name: 'orders', model: 'Order', db: () => db })
    const app = { before: { all: [function appEverything() { ran.push('app') }] } }

    await callService(svc, anonCtx(db, 'create', { id: 1, customerId: 1, total: 12.5 }), app as never)
      .catch(() => {})

    expect(ran).toEqual([])
  })

  test('a real customer and a missing one are indistinguishable to a stranger', async () => {
    const db = await mkDb()

    const svc = createService({
      name: 'orders', model: 'Order', db: () => db,
      hooks: {
        before: {
          create: [async function customerMustExist(ctx: ServiceContext) {
            const found = await (ctx.locals.db as never as Record<string, {
              findUnique(a: unknown): Promise<unknown>
            }>).customer!.findUnique({ where: { id: (ctx.data as { customerId: number }).customerId } })
            if (!found) throw Object.assign(new Error('no such customer'), { code: 400 })
          }],
        },
      },
    })

    const status = async (customerId: number) => await callService(
      svc, anonCtx(db, 'create', { id: 1, customerId, total: 12.5 })
    ).then(() => 200, (e: { code?: number }) => e.code)

    expect(await status(1)).toBe(await status(999))
    expect(await status(1)).toBe(401)
  })

  test('the app hook still runs before the validator that grades what it shaped', async () => {
    const db  = await mkDb()
    const seen: string[] = []

    const svc = createService({
      name: 'orders', model: 'Order', db: () => db,
      hooks: {
        before: {
          create: [function shape(ctx: ServiceContext) {
            // The validator has not run: the wire string is still a string.
            seen.push(typeof (ctx.data as { total: unknown }).total)
            ;(ctx.data as { customerId: number }).customerId = 1
          }],
        },
      },
    })

    await callService(svc, userCtx(db, 'create', { id: 1, total: '12.5' }))

    expect(seen).toEqual(['string'])
  })
})

describe('the `validated` phase', () => {

  const svcWith = (db: unknown, seen: string[]) => createService({
    name: 'orders', model: 'Order', db: () => db,
    hooks: {
      before:    { create: [function shape(ctx: ServiceContext) {
        seen.push(`before:${typeof (ctx.data as { total: unknown }).total}`)
        ;(ctx.data as { customerId: number }).customerId = 1
      }] },
      validated: { create: [function check(ctx: ServiceContext) {
        seen.push(`validated:${typeof (ctx.data as { total: unknown }).total}`)
      }] },
    },
  })

  test('runs after the derived layer, so the payload is coerced', async () => {
    const db   = await mkDb()
    const seen: string[] = []
    await callService(svcWith(db, seen), userCtx(db, 'create', { id: 1, total: '12.5' }))

    expect(seen).toEqual(['before:string', 'validated:number'])
  })

  test('does not run for a caller the gate refuses', async () => {
    const db   = await mkDb()
    const seen: string[] = []

    await callService(svcWith(db, seen), anonCtx(db, 'create', { id: 1, total: '12.5' }))
      .catch(() => {})

    expect(seen).toEqual([])
  })

  test('a before hook that answers the call skips it, as it skips the method', async () => {
    const db   = await mkDb()
    const seen: string[] = []

    const svc = createService({
      name: 'orders', model: 'Order', db: () => db,
      hooks: {
        before:    { get: [function answer(ctx: ServiceContext) { ctx.result = { id: 7 } as never }] },
        validated: { get: [function check() { seen.push('validated') }] },
      },
    })

    await callService(svc, userCtx(db, 'get', null, '7'))
    expect(seen).toEqual([])
  })

  test('it can answer the call itself, and the method is skipped', async () => {
    const db  = await mkDb()
    let   ran = false

    const svc = createService({
      name: 'orders', model: 'Order', db: () => db,
      find: async () => { ran = true; return [] },
      hooks: { validated: { find: [function answer(ctx: ServiceContext) {
        ctx.result = [{ id: 42 }] as never
      }] } },
    })

    // `callService` answers through the context, not a return value.
    const ctx = userCtx(db, 'find', null)
    await callService(svc, ctx)

    expect((ctx.result as { id: number }[])[0]!.id).toBe(42)
    expect(ran).toBe(false)
  })

  test('an app-level validated hook applies to every service', async () => {
    const db   = await mkDb()
    const seen: string[] = []

    const svc = createService({ name: 'orders', model: 'Order', db: () => db })
    const app = { validated: { all: [function appCheck() { seen.push('app') }] } }

    await callService(svc, userCtx(db, 'find', null), app as never)
    expect(seen).toEqual(['app'])
  })
})
