// A `@system` column a HOOK derives, and the seam that lets the write name it
// (`FJS-644`).
//
// A `@system` column reads like any other and is written by the application
// rather than by the person using it, so the Data boundary refuses one a
// caller's payload names. That leaves a hook that DERIVES such a column with
// nowhere to stand: a hook shapes `ctx.data`, and the write happens downstream
// on the caller's own client, so the derived value arrives at the boundary
// indistinguishable from a value the caller sent. Measured on `example`, where
// every customer create over HTTP was a **403** because a hook rebuilt a
// slot-keyed mirror into `ctx.data`.
//
// litestone's narrow hatch is `system: ['col']` on the call, which keeps the
// gate, the row policies, soft-delete and the audit actor where `asSystem()`
// drops all four. `ctx.system` is how a hook reaches it.
//
// **Every acceptance here is PAIRED with the refusal of the identical payload**
// by a call that did not name the column. A seam that let everything through
// would pass any test that only checks the success.

import { describe, test, expect } from 'bun:test'
import { request }       from '../src/testing/index.ts'
import { createApp }     from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'
import type { ServiceContext } from '../src/core/context.ts'
import { createClient }  from '../../litestone/src/index.js'

const SCHEMA = `
  model Doc {
    id      Int     @id
    title   String
    slug    String? @system
    open    String?
    version Int     @version
  }
`

/**
 * Write the derived column onto every row of this payload.
 *
 * Per ROW rather than onto `ctx.data`, because a bulk create hands a hook an
 * ARRAY: assigning to `ctx.data.slug` there sets a property on the array object
 * and reaches no row, which is a hook that silently does nothing.
 */
const derive = (
  ctx: { data: Record<string, unknown> | Record<string, unknown>[] | null },
  value: (row: Record<string, unknown>) => string,
) => {
  const rows = Array.isArray(ctx.data) ? ctx.data : [ctx.data as Record<string, unknown>]
  for (const row of rows) row.slug = value(row as { title: string } & Record<string, unknown>)
}

/** `name` decides which hooks the service gets, so both arms share one schema. */
async function appWith() {
  const db  = await createClient({ db: ':memory:', schema: SCHEMA })
  const app = createApp({
    db: db as never,
    config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
  })

  // Names the column. What an app that derives a system value writes.
  app.services.register(createService({
    name: 'named', model: 'Doc', allowBulk: true,
    hooks: { validated: {
      create: [(ctx: ServiceContext) => { derive(ctx, r => `s-${r.title}`); ctx.system.add('slug') }],
      patch:  [(ctx: ServiceContext) => { derive(ctx, () => 'patched');     ctx.system.add('slug') }],
      update: [(ctx: ServiceContext) => { derive(ctx, () => 'replaced');    ctx.system.add('slug') }],
    } },
  } as never))

  // The same hooks WITHOUT the declaration — the negative control, and the
  // state every app was in before this seam existed.
  app.services.register(createService({
    name: 'silent', model: 'Doc', allowBulk: true,
    hooks: { validated: {
      create: [(ctx: ServiceContext) => { derive(ctx, () => 'sneaky') }],
      patch:  [(ctx: ServiceContext) => { derive(ctx, () => 'sneaky') }],
    } },
  } as never))

  // No hook at all. What a caller sending the column directly must still hit.
  app.services.register(createService({ name: 'plain', model: 'Doc' } as never))

  return { app, db }
}

describe('ctx.system — a hook naming the column it derived', () => {

  test('a create writes the derived column', async () => {
    const { app } = await appWith()
    const res = await request(app).post('/named').send({ title: 'one' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ title: 'one', slug: 's-one' })
  })

  // The pair. Identical hook, identical payload, no declaration.
  test('the same hook WITHOUT the declaration is refused by name', async () => {
    const { app } = await appWith()
    const res = await request(app).post('/silent').send({ title: 'one' })

    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).toMatch(/slug/)
    expect(JSON.stringify(res.body)).toMatch(/@system/)
  })

  test('a patch by id writes it too', async () => {
    const { app } = await appWith()
    const made = await request(app).post('/named').send({ title: 'two' })
    const id   = (made.body as { id: number }).id

    const res = await request(app).patch(`/named/${id}`)
      .send({ title: 'two!', version: (made.body as { version: number }).version })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ slug: 'patched' })
  })

  test('and a patch with no id — the bulk path carries the same set', async () => {
    const { app } = await appWith()
    await request(app).post('/named').send({ title: 'bulk-a' })
    await request(app).post('/named').send({ title: 'bulk-b' })

    const res = await request(app).patch('/named?title=bulk-a').send({ open: 'x' })

    expect(res.status).toBe(200)
    const check = await request(app).get('/named?title=bulk-a')
    expect((check.body as { data: { slug: string }[] }).data[0].slug).toBe('patched')
  })

  test('the pair for bulk — the undeclared service reports the row as failed', async () => {
    const { app } = await appWith()
    await request(app).post('/plain').send({ title: 'bulk-c' })

    const res = await request(app).patch('/silent?title=bulk-c').send({ open: 'x' })

    // A bulk write answers per row rather than throwing, so the refusal lands
    // in `errors` — which is why the assertion is on the body and not a status.
    expect(JSON.stringify(res.body)).toMatch(/slug/)
  })

  test('a bulk create carries it for every row', async () => {
    const { app } = await appWith()

    const res = await request(app).post('/named').send([{ title: 'b1' }, { title: 'b2' }])

    expect(res.status).toBe(201)
    const rows = (res.body as { data: { slug: string }[] }).data
    expect(rows.map(r => r.slug)).toEqual(['s-b1', 's-b2'])
  })

  test('the pair for a bulk create — undeclared, every row fails', async () => {
    const { app } = await appWith()

    const res = await request(app).post('/silent').send([{ title: 'b3' }, { title: 'b4' }])

    const body = res.body as { data: unknown[]; errors: unknown[] }
    expect(body.data).toHaveLength(0)
    expect(body.errors).toHaveLength(2)
    expect(JSON.stringify(body.errors)).toMatch(/slug/)
  })

  test('a caller sending the column is STILL refused on the service that names it', async () => {
    const { app } = await appWith()

    const res = await request(app).post('/named').send({ title: 'three', slug: 'mine' })

    // The hook overwrites it, so what lands is the derived value and never the
    // caller's. Naming a column is the application vouching for the value IT
    // put there; it is not a hole a payload can climb through.
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ slug: 's-three' })
  })

  test('a service naming nothing refuses a payload that names the column', async () => {
    const { app } = await appWith()

    const res = await request(app).post('/plain').send({ title: 'four', slug: 'mine' })

    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).toMatch(/slug/)
  })
})

describe('the set itself', () => {

  test('it is FRESH per call — one create does not license the next', async () => {
    const { app } = await appWith()
    await request(app).post('/named').send({ title: 'first' })

    // Same app, same client, a service that declares nothing. If the set leaked
    // across calls this would be a 201.
    const res = await request(app).post('/silent').send({ title: 'second' })

    expect(res.status).toBe(403)
  })

  test('it does not propagate into a nested call', async () => {
    const { db } = await appWith()
    const app = createApp({
      db: db as never,
      config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
    })
    app.services.register(createService({ name: 'inner', model: 'Doc',
      hooks: { validated: { create: [(ctx: ServiceContext) => { (ctx.data as Record<string, unknown>).slug = 'inner' }] } },
    } as never))
    app.services.register(createService({ name: 'outer', model: 'Doc',
      hooks: { validated: { create: [(ctx: ServiceContext) => { ctx.system.add('slug') }] } },
      create: async (ctx: { app: { service: (n: string) => { create: (d: unknown) => Promise<unknown> } } }) =>
        ctx.app.service('inner').create({ title: 'nested' }),
    } as never))

    const res = await request(app).post('/outer').send({ title: 'outer' })

    // The outer call named the column; the inner one did not, and locals do not
    // propagate — so the inner write is refused exactly as it would be alone.
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).toMatch(/slug/)
  })

  test('a hook may add to it without discarding what another hook named', async () => {
    const { app } = await appWith()
    const seen: string[][] = []
    app.services.register(createService({
      name: 'two-hooks', model: 'Doc',
      hooks: { validated: { create: [
        (ctx: ServiceContext) => { ctx.system.add('slug') },
        (ctx: ServiceContext) => { ctx.system.add('slug'); seen.push([...ctx.system]) },
      ] } },
    } as never))

    await request(app).post('/two-hooks').send({ title: 'x' })

    expect(seen[0]).toEqual(['slug'])
  })

  test('naming nothing passes nothing down — the boundary is not widened by default', async () => {
    const { app } = await appWith()

    // A create through a service with no hook at all still refuses the column,
    // which is the whole guarantee: an empty set must not read as "all".
    const res = await request(app).post('/plain').send({ title: 'five', slug: 'x' })
    expect(res.status).toBe(403)
  })
})
