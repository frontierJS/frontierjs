// test/cron-rows.test.ts
//
// FJS-D1285 / FJS-3060: a recurring wall-clock rule is a ROW — a `@cron`
// column and a `@zone` beside it — and a job file binds one schedule per row
// with `schedules: { model, cron, timeZone }`. Each occurrence fires exactly
// once, named `cron:<job>:<rowId>:<wall minute>`, across a spring-forward
// Sunday (Lisbon's 01:30 never happens; it fires at 02:00) and an autumn one
// (01:30 happens twice; it fires once). A write to the model rebinds — a
// row's create, its rule changing, its delete — an `asSystem()` one included,
// since litestone's write tap sees every write a client makes.
//
// Real pieces throughout: a Litestone client holds the rows, a Junction test
// app is the host, and the scheduler's 10s interval is driven by Bun's fake
// timers against an owned clock.

import { describe, it, expect, afterEach, jest } from 'bun:test'
import { occurrenceKey } from '@frontierjs/toolbelt/history'

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir }        from 'node:os'
import { join }          from 'node:path'

import { createClient, createTenantRegistry } from '../../litestone/src/index.js'
import { createApp, createTestApp } from '../../junction/index.ts'
import { caravan } from '../src/index.ts'

const SCHEMA = `
model Window {
  id       Int    @id @default(autoincrement())
  name     String
  rule     String? @cron
  timeZone String @zone
}
`

const JOB = 'window.open'
const LISBON = 'Europe/Lisbon'

const closers: Array<() => unknown> = []
afterEach(async () => {
  jest.useRealTimers()
  for (const c of closers.splice(0)) await c()
})

/**
 * The write tap is deferred to a later turn of the loop, and the rebind it
 * starts reads through `withDb`, so a turn is yielded — `setImmediate` is not
 * one of the timers the fake clock holds — until the work has drained.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r))
}

async function boot(start: Date) {
  const db = await createClient({ db: ':memory:', schema: SCHEMA }) as any
  closers.push(() => db.$close())
  const app = await createTestApp()
  app.db = db

  let at = start
  const queue = caravan({ db: ':memory:', pollInterval: 60_000, cronClock: () => at })
  app.configure(queue)
  queue.handle(JOB, async () => {}, { schedules: { model: 'Window', cron: 'rule', timeZone: 'timeZone' } })

  const sys = db.asSystem()
  jest.useFakeTimers()
  await app._startForTest()
  closers.push(() => queue.stop())
  await settle()

  /** Walk the clock to `until`, one scheduler tick per step. */
  async function walk(until: Date, stepMinutes = 10): Promise<void> {
    while (at < until) {
      at = new Date(Math.min(at.getTime() + stepMinutes * 60_000, until.getTime()))
      jest.advanceTimersByTime(10_000)
      await settle()
    }
  }
  const fires = () => queue.list({ limit: 500 }).filter(r => r.name === JOB)
  return { sys, queue, walk, fires, set: (d: Date) => { at = d } }
}

const wall = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi) / 60_000

describe('a schedule bound from rows (FJS-D1285)', () => {
  it('fires a Lisbon Sunday 01:30 once on the spring Sunday, at 02:00, naming the row and the wall minute', async () => {
    const t = await boot(new Date('2026-03-28T23:00:00Z'))
    const w = await t.sys.window.create({ data: { name: 'maint', rule: '30 1 * * 0', timeZone: LISBON } })
    await t.walk(new Date('2026-03-29T03:00:00Z'))
    const rows = t.fires()
    expect(rows.map(r => r.id)).toEqual([occurrenceKey('cron', JOB, w.id, wall(2026, 3, 29, 1, 30))])
    expect(JSON.parse(String(rows[0].data))).toEqual({ id: w.id })
  })

  it('fires once on the autumn Sunday, where 01:30 happens twice', async () => {
    const t = await boot(new Date('2026-10-24T23:00:00Z'))
    const w = await t.sys.window.create({ data: { name: 'maint', rule: '30 1 * * 0', timeZone: LISBON } })
    await t.walk(new Date('2026-10-25T04:00:00Z'))
    expect(t.fires().map(r => r.id)).toEqual([occurrenceKey('cron', JOB, w.id, wall(2026, 10, 25, 1, 30))])
  })

  it('binds the rows that exist at start, one schedule per row, each in its own zone', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA }) as any
    closers.push(() => db.$close())
    const a = await db.asSystem().window.create({ data: { name: 'ny', rule: '0 3 * * *', timeZone: 'America/New_York' } })
    const b = await db.asSystem().window.create({ data: { name: 'tokyo', rule: '0 3 * * *', timeZone: 'Asia/Tokyo' } })
    const app = await createTestApp()
    app.db = db
    let at = new Date('2026-06-01T00:00:00Z')
    const queue = caravan({ db: ':memory:', pollInterval: 60_000, cronClock: () => at })
    app.configure(queue)
    queue.handle(JOB, async () => {}, { schedules: { model: 'Window', cron: 'rule', timeZone: 'timeZone' } })
    jest.useFakeTimers()
    await app._startForTest()
    closers.push(() => queue.stop())
    await settle()
    // 03:00 Tokyo is 18:00Z the day before, 03:00 New York is 07:00Z.
    while (at < new Date('2026-06-01T08:00:00Z')) {
      at = new Date(at.getTime() + 10 * 60_000)
      jest.advanceTimersByTime(10_000)
      await settle()
    }
    expect(queue.list({ limit: 50 }).filter(r => r.name === JOB).map(r => r.id).sort()).toEqual([
      occurrenceKey('cron', JOB, a.id, wall(2026, 6, 1, 3, 0)),
    ].sort())
    expect(b.id).toBeGreaterThan(0)
  })

  it('rebinds on a write: a changed rule moves, a null rule and a delete unbind', async () => {
    const t = await boot(new Date('2026-06-01T00:00:00Z'))
    const moved   = await t.sys.window.create({ data: { name: 'moved',   rule: '0 1 * * *', timeZone: 'UTC' } })
    const cleared = await t.sys.window.create({ data: { name: 'cleared', rule: '0 1 * * *', timeZone: 'UTC' } })
    const gone    = await t.sys.window.create({ data: { name: 'gone',    rule: '0 1 * * *', timeZone: 'UTC' } })
    await t.sys.window.update({ where: { id: moved.id },   data: { rule: '0 2 * * *' } })
    await t.sys.window.update({ where: { id: cleared.id }, data: { rule: null } })
    await t.sys.window.delete({ where: { id: gone.id } })
    await settle()
    await t.walk(new Date('2026-06-01T03:00:00Z'))
    expect(t.fires().map(r => r.id)).toEqual([occurrenceKey('cron', JOB, moved.id, wall(2026, 6, 1, 2, 0))])
  })

  it('refuses a model the client does not have, by name', async () => {
    const db = await createClient({ db: ':memory:', schema: SCHEMA }) as any
    closers.push(() => db.$close())
    const app = await createTestApp()
    app.db = db
    const queue = caravan({ db: ':memory:', pollInterval: 60_000 })
    app.configure(queue)
    queue.handle(JOB, async () => {}, { schedules: { model: 'Windo', cron: 'rule', timeZone: 'timeZone' } })
    closers.push(() => queue.stop())
    await expect(app._startForTest()).rejects.toThrow(/Windo/)
  })
})

describe('a zone one relation away', () => {
  const RELATED = `
model Site {
  id       Int      @id @default(autoincrement())
  timeZone String   @zone
  windows  Window[]
}

model Window {
  id     Int    @id @default(autoincrement())
  siteId Int
  site   Site   @relation(fields: [siteId], references: [id])
  rule   String @cron
}
`

  it('reads the zone through the relation, and a write to the related row rebinds', async () => {
    const db = await createClient({ db: ':memory:', schema: RELATED }) as any
    closers.push(() => db.$close())
    const sys  = db.asSystem()
    const site = await sys.site.create({ data: { timeZone: 'Asia/Tokyo' } })
    const w    = await sys.window.create({ data: { siteId: site.id, rule: '0 3 * * *' } })
    const app = await createTestApp()
    app.db = db
    let at = new Date('2026-06-01T00:00:00Z')
    const queue = caravan({ db: ':memory:', pollInterval: 60_000, cronClock: () => at })
    app.configure(queue)
    queue.handle(JOB, async () => {}, { schedules: { model: 'Window', cron: 'rule', timeZone: 'site.timeZone' } })
    jest.useFakeTimers()
    await app._startForTest()
    closers.push(() => queue.stop())
    await settle()
    expect(queue.nextRuns().map(r => r.nextRun?.toISOString())).toEqual(['2026-06-01T18:00:00.000Z'])

    // The site moves to New York: 03:00 there is 07:00Z, and Tokyo's 18:00Z is gone.
    await sys.site.update({ where: { id: site.id }, data: { timeZone: 'America/New_York' } })
    await settle()
    while (at < new Date('2026-06-01T20:00:00Z')) {
      at = new Date(at.getTime() + 10 * 60_000)
      jest.advanceTimersByTime(10_000)
      await settle()
    }
    expect(queue.list({ limit: 50 }).filter(r => r.name === JOB).map(r => r.id))
      .toEqual([occurrenceKey('cron', JOB, w.id, wall(2026, 6, 1, 3, 0))])
  })
})

describe('under tenancy { strategy database } (FJS-4536)', () => {
  // Each tenant is a file of its own, so there is no one client to read the
  // rows from or to tap: a tenant's rows bind at start, a write in one rebinds
  // it, and each fire carries its tenant and names it in its id — two tenants'
  // row 1 on one rule are two fires.
  it('binds every tenant\'s rows, rebinds on a tenant\'s write, and fires in the row\'s tenant', async () => {
    const dir  = mkdtempSync(join(tmpdir(), 'cron-rows-'))
    const path = join(dir, 'schema.lite')
    writeFileSync(path, `
tenancy {
  strategy database
  dir      "${dir}/tenants"
  registry "${dir}/registry.db"
}
${SCHEMA}
`)
    const registry: any = await createTenantRegistry({ path })
    for (const id of ['acme', 'globex']) await registry.create(id)
    closers.push(() => registry.close?.())
    const rows: Record<string, any> = {}
    for (const id of ['acme', 'globex'])
      rows[id] = await (await registry.get(id)).asSystem().window.create({ data: { name: id, rule: '0 3 * * *', timeZone: 'UTC' } })

    const app = createApp({ tenants: registry }) as any
    let at = new Date('2026-06-01T00:00:00Z')
    const queue = caravan({ db: ':memory:', pollInterval: 60_000, cronClock: () => at })
    app.configure(queue)
    queue.handle(JOB, async () => {}, { schedules: { model: 'Window', cron: 'rule', timeZone: 'timeZone' } })
    jest.useFakeTimers()
    await app._startForTest()
    closers.push(() => queue.stop())
    await settle()

    // A tenant's client opened after start is tapped like the first: acme's
    // window moves to 04:00 and a second one is added there.
    const acme = (await registry.get('acme')).asSystem()
    await acme.window.update({ where: { id: rows.acme.id }, data: { rule: '0 4 * * *' } })
    const added = await acme.window.create({ data: { name: 'added', rule: '0 5 * * *', timeZone: 'UTC' } })
    await settle()

    while (at < new Date('2026-06-01T06:00:00Z')) {
      at = new Date(at.getTime() + 10 * 60_000)
      jest.advanceTimersByTime(10_000)
      await settle()
    }
    const fired = queue.list({ limit: 50 }).filter(r => r.name === JOB)
    expect(fired.map(r => [r.id, r.tenant_id]).sort()).toEqual([
      [occurrenceKey('cron', JOB, 'acme',   rows.acme.id,   wall(2026, 6, 1, 4, 0)), 'acme'],
      [occurrenceKey('cron', JOB, 'acme',   added.id,       wall(2026, 6, 1, 5, 0)), 'acme'],
      [occurrenceKey('cron', JOB, 'globex', rows.globex.id, wall(2026, 6, 1, 3, 0)), 'globex'],
    ].sort())
  })
})
