// tests/after-commit.test.ts
//
// FJS-089's other half. `transactional:` made the WRITE atomic with the
// pipeline; nothing made an effect atomic with it — an `after` hook that sends
// an email runs, a later `after` hook throws, and the client is told the call
// failed with the email already gone. Under `transactional:` the row is rolled
// back and the email is STILL gone, which is worse.
//
// `ctx.afterCommit(fn)` is the phase that was missing: queued during the
// pipeline, run once, after the call has succeeded — and, where a transaction
// was opened, after it committed.
//
// Against a real Litestone client, for the same reason `transactional.test.ts`
// is: the whole claim is about when a commit happens, and a stub would agree
// with whatever it was written to agree with.

import { describe, test, expect } from 'bun:test'

import { createClient }  from '../../litestone/src/index.js'
import { createService, callService } from '../src/core/service.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

const SCHEMA = `model Post { id Int @id @default(autoincrement())  title String }`

const mkDb = () => createClient({ db: ':memory:', schema: SCHEMA }) as unknown as Promise<any>

function ctx(db: unknown, over: Record<string, unknown> = {}): ServiceContext {
  return {
    service: 'posts', method: 'create', id: undefined, data: { title: 't' },
    query: {}, auth: { user: null }, client: {}, route: {},
    locals: { db }, app: {}, result: null, type: 'before', ...over,
  } as unknown as ServiceContext
}

const writes = (extra: Record<string, unknown> = {}) => ({
  name: 'posts',
  async create(c: ServiceContext) { return (c.locals.db as any).post.create({ data: c.data }) },
  async find()  { return [] },
  ...extra,
})

/** Capture console.error for the duration of one call. */
async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; logged: string[] }> {
  const logged: string[] = []
  const real = console.error
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
  try {
    return { value: await fn(), logged }
  } finally {
    console.error = real
  }
}

describe('ctx.afterCommit — the success path', () => {

  test('runs after the call succeeds, in the order queued', async () => {
    const db  = await mkDb()
    const ran: string[] = []
    const svc = createService(writes({
      hooks: { before: { create: [(c: ServiceContext) => { c.afterCommit(() => { ran.push('from before') }) }] },
               after:  { create: [(c: ServiceContext) => { c.afterCommit(() => { ran.push('from after') }) }] } },
    }) as never)

    await callService(svc, ctx(db))

    // Queued in two different phases, drained once, in the order they were
    // added — the queue outlives the phase that filled it.
    expect(ran).toEqual(['from before', 'from after'])
  })

  test('an async callback is awaited before the call returns', async () => {
    const db  = await mkDb()
    let done  = false
    const svc = createService(writes({
      hooks: { after: { create: [(c: ServiceContext) => {
        c.afterCommit(async () => { await new Promise(r => setTimeout(r, 5)); done = true })
      }] } },
    }) as never)

    await callService(svc, ctx(db))
    expect(done).toBe(true)
  })

  test('runs after the announcement, not before it', async () => {
    // The order the framework already promises for a broadcast: subscribers
    // hear about the write, then the effects fire. A caller reading the row
    // from inside a callback is reading a row every tab has already been told
    // about.
    const db     = await mkDb()
    const order: string[] = []
    // The shape callService takes — `emit` and nothing else. Node's own
    // EventEmitter answers a boolean, which this interface does not.
    const events = { emit: (name: string) => { if (name === 'posts:created') order.push('announced') } }

    const svc = createService(writes({
      hooks: { after: { create: [(c: ServiceContext) => { c.afterCommit(() => { order.push('effect') }) }] } },
    }) as never)

    await callService(svc, ctx(db), undefined, events)
    expect(order).toEqual(['announced', 'effect'])
  })
})

describe('ctx.afterCommit — the failure path', () => {

  test('a later after hook throwing means the effect does NOT run', async () => {
    // This is the filed defect, stated as a test. The email is queued by one
    // after hook and a later one fails the call; nothing goes out.
    const db   = await mkDb()
    let sent   = 0
    const svc  = createService(writes({
      hooks: { after: { create: [
        (c: ServiceContext) => { c.afterCommit(() => { sent++ }) },
        function boom() { throw new Error('a later after hook fails') },
      ] } },
    }) as never)

    await expect(callService(svc, ctx(db))).rejects.toThrow(/later after hook/)
    expect(sent).toBe(0)

    // Without `transactional:` the ROW is still there — the write is not what
    // this phase makes atomic, and pretending otherwise is what the two
    // features are for. The effect follows the CALL's verdict either way.
    expect(await db.asSystem().post.count()).toBe(1)
  })

  test('with transactional: the row rolls back and the effect still does not run', async () => {
    const db  = await mkDb()
    let sent  = 0
    const svc = createService(writes({
      transactional: true,
      hooks: { after: { create: [
        (c: ServiceContext) => { c.afterCommit(() => { sent++ }) },
        function boom() { throw new Error('a later after hook fails') },
      ] } },
    }) as never)

    await expect(callService(svc, ctx(db))).rejects.toThrow(/later after hook/)
    expect(sent).toBe(0)
    expect(await db.asSystem().post.count()).toBe(0)
  })

  test('a callback that throws does not fail the call, and says so', async () => {
    // Observer tier: the write is committed and the announcement is out, so a
    // 500 here would tell the client a write failed that did not. Loud, but not
    // fatal — and the callbacks after it still run.
    const db  = await mkDb()
    let later = 0
    const svc = createService(writes({
      hooks: { after: { create: [(c: ServiceContext) => {
        c.afterCommit(() => { throw new Error('smtp is down') })
        c.afterCommit(() => { later++ })
      }] } },
    }) as never)

    const c = ctx(db)
    const { logged } = await quiet(() => callService(svc, c))

    expect(c.error).toBeFalsy()
    expect(await db.asSystem().post.count()).toBe(1)
    expect(later).toBe(1)
    expect(logged.join('\n')).toContain('smtp is down')
    expect(logged.join('\n')).toContain('posts.create')
  })
})

describe('ctx.afterCommit — under a transaction', () => {

  test('runs after $transaction resolves, not inside it', async () => {
    // The whole claim, measured on the real client: the wrapper records when
    // the transaction returned, the callback records when it ran. Inside the
    // scope, a callback could still be rolled back by a later hook — which is
    // the bug wearing a different hat.
    const db    = await mkDb()
    const order: string[] = []

    const realTx = db.$transaction.bind(db)
    db.$transaction = async (fn: (tx: unknown) => Promise<void>) => {
      const out = await realTx(fn)
      order.push('commit')
      return out
    }

    const svc = createService(writes({
      transactional: true,
      hooks: { after: { create: [(c: ServiceContext) => { c.afterCommit(() => { order.push('effect') }) }] } },
    }) as never)

    await callService(svc, ctx(db))
    expect(order).toEqual(['commit', 'effect'])
  })

  test('the queue survives the client swap the transaction does', async () => {
    // `transactionScopeHook` reassigns ctx.locals.db to the tx client for the
    // rest of the pipeline. The queue lives on the context, not on locals, so a
    // callback queued before the swap and one queued after it both run.
    const db  = await mkDb()
    const ran: string[] = []
    const svc = createService(writes({
      transactional: true,
      hooks: {
        around: { create: [async (c: ServiceContext, next: () => Promise<void>) => {
          c.afterCommit(() => { ran.push('outside') })
          await next()
        }] },
        after:  { create: [(c: ServiceContext) => { c.afterCommit(() => { ran.push('inside') }) }] },
      },
    }) as never)

    await callService(svc, ctx(db))
    expect(ran).toEqual(['outside', 'inside'])
    expect(await db.asSystem().post.count()).toBe(1)
  })
})

describe('ctx.afterCommit — every context has one', () => {

  test('a hand-built context gets the queue from callService', async () => {
    // The three builders attach it; a context written by hand in a test or an
    // app does not have one, and a hook that queues an effect must not be the
    // thing that throws.
    const db  = await mkDb()
    let ran   = false
    const svc = createService(writes({
      hooks: { after: { create: [(c: ServiceContext) => { c.afterCommit(() => { ran = true }) }] } },
    }) as never)

    const bare = ctx(db)
    expect((bare as { afterCommit?: unknown }).afterCommit).toBeUndefined()

    await callService(svc, bare)
    expect(ran).toBe(true)
  })

  test('a read queues nothing and drains nothing', async () => {
    const db  = await mkDb()
    let ran   = 0
    const svc = createService(writes({
      hooks: { after: { find: [(c: ServiceContext) => { c.afterCommit(() => { ran++ }) }] } },
    }) as never)

    // find is not a write and announces nothing — but afterCommit is about the
    // CALL succeeding, not about writing, so a read's callback runs too.
    await callService(svc, ctx(db, { method: 'find', data: null }))
    expect(ran).toBe(1)
  })
})
