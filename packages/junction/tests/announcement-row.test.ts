// tests/announcement-row.test.ts
//
// A custom method may answer whatever it likes. The same value is also what
// gets ANNOUNCED, and a subscriber has nowhere to put anything that is not a
// row: the browser's store upserts by id and replaces wholesale, so an id-less
// payload is appended as a phantom row and a partial one replaces the record,
// losing every field it omitted. Both silent, in every open tab.
//
// Basecamp shipped four of these — `setVariable` answering `{ id, variables }`,
// the deployment engine's five-field projection, `servers.heartbeat` answering
// `{ ok, server_id, status }` with no id at all, and `jobs.trigger` answering
// `{ id, queued: true }`. Every one was found by looking at a screenshot: a page
// doing the obvious thing rendered "undefined" as its heading while every other
// assertion passed. *A partial row is indistinguishable from a full one until it
// breaks* — `FJS-020`, ruled by `FJS-D08`.
//
// The rule: an announcement is about a row, so it carries one where one can be
// found — the payload when it already is a row, otherwise the row re-read by id.
// Where no row can be found the payload travels as the SIGNAL it is, because an
// method that changes many rows has none to carry and its subscribers re-read
// rather than merge. The service is told once, by name, with both ways out.
//
// Against a REAL Litestone client, deliberately: this reads a model's declared
// columns and re-reads a row through the accessor, and a hand-rolled `{ post: …
// }` stand-in is exactly how the accessor-resolution bug shipped before.

import { describe, test, expect, beforeEach } from 'bun:test'
import { createClient } from '../../litestone/src/index.js'
import { createService, callService } from '../src/core/service.ts'
import { resetAnnouncementWarnings } from '../src/core/litestone.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

async function mkDb() {
  const db = await createClient({
    db: ':memory:',
    schema: `
      model Server {
        id        Int      @id
        name      String
        status    String   @default("online")
        region    String   @default("eu-west")
      }
    `,
  }) as unknown as Record<string, never> & {
    asSystem(): Record<string, { create(a: unknown): Promise<unknown> }>
  }
  await db.asSystem().server!.create({ data: { id: 1, name: 'gateway-01' } })
  return db
}

/** Collects what the bus was told, which is the same payload the socket gets. */
function ctxFor(db: unknown, over: Record<string, unknown> = {}): ServiceContext {
  return {
    service: 'servers', method: 'heartbeat', id: null, data: null,
    query: {}, auth: { user: null }, client: {}, route: {},
    locals: { db }, app: {}, result: null, directives: {},
    ...over,
  } as unknown as ServiceContext
}

async function announce(svc: unknown, ctx: ServiceContext) {
  const seen: unknown[] = []
  const events = { emit: (_e: string, data: unknown) => { seen.push(data) } }
  await callService(svc as never, ctx, undefined, events as never)
  return seen
}

const warnings: string[] = []
const realWarn = console.warn
beforeEach(() => {
  resetAnnouncementWarnings()
  warnings.length = 0
  console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')) }
})

describe('a method that answers the row announces the row', () => {

  test('the whole record travels untouched', async () => {
    const db  = await mkDb()
    const svc = createService({
      name: 'servers', model: 'server',
      async heartbeat(ctx: ServiceContext) {
        return (ctx.locals.db as any).server.findFirst({ where: { id: 1 } })
      },
    } as never)

    const [payload] = await announce(svc, ctxFor(db, { id: 1 })) as Record<string, unknown>[]
    expect(payload.name).toBe('gateway-01')
    expect(payload.region).toBe('eu-west')
    expect(warnings).toEqual([])
  })

  test('the row PLUS a flag is still the row — extra keys are not an omission', async () => {
    // `{ ...job, queued: true }` is what jobs.trigger answers now, and it must
    // not be read as a projection.
    const db  = await mkDb()
    const svc = createService({
      name: 'servers', model: 'server',
      async heartbeat(ctx: ServiceContext) {
        const row = await (ctx.locals.db as any).server.findFirst({ where: { id: 1 } })
        return { ...row, queued: true }
      },
    } as never)

    const [payload] = await announce(svc, ctxFor(db, { id: 1 })) as Record<string, unknown>[]
    expect(payload.queued).toBe(true)
    expect(payload.region).toBe('eu-west')
    expect(warnings).toEqual([])
  })
})

describe('a method that answers a projection announces the row anyway', () => {

  test('the subscriber gets every column, re-read by id', async () => {
    const db  = await mkDb()
    const svc = createService({
      name: 'servers', model: 'server',
      async heartbeat() { return { id: 1, status: 'online' } },   // the real shape basecamp shipped
    } as never)

    const [payload] = await announce(svc, ctxFor(db, { id: 1 })) as Record<string, unknown>[]
    expect(payload.name).toBe('gateway-01')     // was absent from the answer
    expect(payload.region).toBe('eu-west')
  })

  test('…and says so once, naming the columns and both ways out', async () => {
    const db  = await mkDb()
    const svc = createService({
      name: 'servers', model: 'server',
      async heartbeat() { return { id: 1, status: 'online' } },
    } as never)

    await announce(svc, ctxFor(db, { id: 1 }))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('servers.heartbeat()')
    expect(warnings[0]).toContain('name')
    expect(warnings[0]).toContain('ctx.dispatch')

    // Once per service.method: a per-call warning on a heartbeat is a log nobody
    // reads, which is the same silence in a louder font.
    await announce(svc, ctxFor(db, { id: 1 }))
    expect(warnings).toHaveLength(1)
  })

  test('an id-less answer is re-read from the ROUTE id', async () => {
    // `{ ok, server_id, status }` — the heartbeat that could not be matched to
    // a row by anything downstream.
    const db  = await mkDb()
    const svc = createService({
      name: 'servers', model: 'server',
      async heartbeat() { return { ok: true, server_id: 1, status: 'online' } },
    } as never)

    const [payload] = await announce(svc, ctxFor(db, { id: 1 })) as Record<string, unknown>[]
    expect(payload.id).toBe(1)
    expect(payload.name).toBe('gateway-01')
  })
})

// A method that changes MANY rows has no single row to carry, and its
// subscribers use the event as a trigger to re-read. Dropping those was the
// first design and it would have stopped basecamp's `/volumes/` updating live
// with nothing but a server-side line to say why — the same silent failure this
// exists to remove. So the payload travels as the signal it is, and the phantom
// row it could have become is refused on the client instead.
describe('when no row can be found, the payload travels as a signal', () => {

  test('a collection method with no id still announces, and says why', async () => {
    const db  = await mkDb()
    const svc = createService({
      name: 'servers', model: 'server',
      async prune() { return { freedBytes: 1024, forgotten: ['a'] } },
    } as never)

    const seen = await announce(svc, ctxFor(db, { method: 'prune', id: null }))
    expect(seen).toEqual([{ freedBytes: 1024, forgotten: ['a'] }])
    expect(warnings[0]).toContain('carries no id')
    expect(warnings[0]).toContain('signal')
  })

  test('an id that matches no row announces what the method said, not silence', async () => {
    const db  = await mkDb()
    const svc = createService({
      name: 'servers', model: 'server',
      async heartbeat() { return { status: 'online' } },
    } as never)

    // A custom method that DELETES its row lands here, and its id is the one
    // thing a subscriber's remove handler needs.
    const seen = await announce(svc, ctxFor(db, { id: 999 }))
    expect(seen).toEqual([{ status: 'online' }])
    expect(warnings[0]).toContain('no row answered to that id')
  })
})

describe('what the app states, the app owns', () => {

  test('ctx.dispatch = <value> is sent exactly as given', async () => {
    const db  = await mkDb()
    const svc = createService({
      name: 'servers', model: 'server',
      async prune(ctx: ServiceContext) {
        ctx.dispatch = { freedBytes: 1024 }
        return { freedBytes: 1024 }
      },
    } as never)

    const seen = await announce(svc, ctxFor(db, { method: 'prune' }))
    expect(seen).toEqual([{ freedBytes: 1024 }])
    // No warning: ctx.dispatch is a declaration of what to send, and
    // second-guessing it would make the one switch mean two things.
    expect(warnings).toEqual([])
  })

  test('ctx.dispatch = false still announces nothing', async () => {
    const db  = await mkDb()
    const svc = createService({
      name: 'servers', model: 'server',
      async heartbeat(ctx: ServiceContext) { ctx.dispatch = false; return { id: 1 } },
    } as never)

    expect(await announce(svc, ctxFor(db, { id: 1 }))).toEqual([])
  })
})

describe('a service with no model is left alone', () => {

  test('its answer travels untouched — there is no row for it to be part of', async () => {
    const db  = await mkDb()
    const svc = createService({
      name: 'reports',
      async build() { return { generated: 3 } },
    } as never)

    const seen = await announce(svc, ctxFor(db, { service: 'reports', method: 'build' }))
    expect(seen).toEqual([{ generated: 3 }])
    expect(warnings).toEqual([])
  })
})

// Restore the console for the rest of the run.
process.on('exit', () => { console.warn = realWarn })
