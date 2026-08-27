/**
 * test/test-clock.test.ts — `env.clock`, the clock a suite can move (`FJS-524`).
 *
 * `createClient({ now })` has always taken a clock and `createTestEnv` has
 * always forwarded it, so freezing time was reachable and undeclared. What was
 * not reachable is MOVING it, and moving it is the point: every bug worth a test
 * here is a crossing — a window that opens, a retention that expires — and a
 * frozen instant asserts one side of one.
 *
 * The last describe is the one to read before trusting this. The clock does NOT
 * move `@default(now())` or `@updatedAt`, which SQLite stamps, and that is
 * asserted here rather than left to be discovered by somebody staging an old
 * row and watching it come back current (`FJS-531`).
 */

import { describe, test, expect } from 'bun:test'
import { createTestEnv } from '../src/testing.js'

// A window the policy compiler turns into a WHERE, which is what makes this a
// test of the clock the SQL was compiled with rather than of a JS comparison.
const SALES = `
  model Sale {
    id      Int      @id @default(autoincrement())
    name    String
    startAt DateTime
    endAt   DateTime
    @@gate("0")
    @@allow('read', startAt < now() && now() < endAt)
  }
`

const STAMPS = `
  model Note {
    id        Int      @id @default(autoincrement())
    body      String
    createdAt DateTime @default(now())
    updatedAt DateTime @updatedAt
  }
`

// A database that prunes, so the clock can be asked the question it exists for.
const RETAINED = `
  database main { path "./x.db"  retention 90d }
  model Entry {
    id        Int      @id @default(autoincrement())
    body      String
    createdAt DateTime @default(now())
  }
`

async function withSales(now?: unknown) {
  const env = await createTestEnv({ schema: SALES, ...(now === undefined ? {} : { now }) } as never)
  await env.system.sale.create({ data: { name: 'spring', startAt: '2026-05-01T00:00:00Z', endAt: '2026-06-15T00:00:00Z' } })
  await env.system.sale.create({ data: { name: 'autumn', startAt: '2026-09-01T00:00:00Z', endAt: '2026-10-01T00:00:00Z' } })
  return { env, visible: async () => (await env.db.sale.findMany()).map((r: { name: string }) => r.name) }
}

describe('a frozen clock', () => {
  test('an ISO string freezes there', async () => {
    const { env, visible } = await withSales('2026-06-01T00:00:00Z')
    expect(env.clock.frozen).toBe(true)
    expect(env.clock.now().toISOString()).toBe('2026-06-01T00:00:00.000Z')
    expect(await visible()).toEqual(['spring'])
  })

  test('absent is the wall clock, and neither window is open in 2026-08', async () => {
    const { env, visible } = await withSales()
    expect(env.clock.frozen).toBe(false)
    // Both windows are in the past or the future relative to any real run; the
    // assertion is that the policy ran at all, not which side of it we are on.
    expect(await visible()).not.toContain('spring')
  })

  test('a bad date is refused by name rather than freezing at Invalid Date', async () => {
    await expect(createTestEnv({ schema: SALES, now: 'the fifth of never' } as never))
      .rejects.toThrow(/is not a date/)
  })
})

describe('moving it — the crossing a frozen instant cannot assert', () => {
  test('set() moves the window the policy compiles', async () => {
    const { env, visible } = await withSales('2026-06-01T00:00:00Z')
    expect(await visible()).toEqual(['spring'])
    env.clock.set('2026-09-15T00:00:00Z')
    expect(await visible()).toEqual(['autumn'])
    env.clock.set('2027-01-01T00:00:00Z')
    expect(await visible()).toEqual([])
  })

  test('advance() takes a duration, and lands the far side of the window', async () => {
    const { env, visible } = await withSales('2026-06-01T00:00:00Z')
    expect(await visible()).toEqual(['spring'])
    env.clock.advance('20d')                       // 2026-06-21 — spring closed on the 15th
    expect(env.clock.now().toISOString()).toBe('2026-06-21T00:00:00.000Z')
    expect(await visible()).toEqual([])
  })

  test('advance() takes milliseconds too', async () => {
    const { env } = await withSales('2026-06-01T00:00:00Z')
    env.clock.advance(90 * 60_000)
    expect(env.clock.now().toISOString()).toBe('2026-06-01T01:30:00.000Z')
  })

  test('advance() from the wall clock freezes, or the next assertion is a race', async () => {
    const { env } = await withSales()
    expect(env.clock.frozen).toBe(false)
    env.clock.advance('1h')
    expect(env.clock.frozen).toBe(true)
  })

  test('a duration it cannot read is refused by name, and says whose it is', async () => {
    const { env } = await withSales('2026-06-01T00:00:00Z')
    expect(() => env.clock.advance('a fortnight')).toThrow(/clock duration/)
  })
})

describe('every client the env opened reads the same clock', () => {
  test('atLevel()\'s client follows a move made after it was built', async () => {
    const { env } = await withSales('2026-06-01T00:00:00Z')
    const lvl = await env.atLevel(0)
    const seen = async () => (await lvl.sale.findMany()).map((r: { name: string }) => r.name)

    // Built while spring was open, and it must not hold that instant: a level
    // client is opened lazily, so one built mid-suite would otherwise freeze at
    // whatever the clock said when the first atLevel() call happened.
    expect(await seen()).toEqual(['spring'])
    env.clock.set('2026-09-15T00:00:00Z')
    expect(await seen()).toEqual(['autumn'])
  })
})

describe('a clock you passed as a function stays yours', () => {
  test('set() and advance() refuse it, naming the way out', async () => {
    let mine = new Date('2026-06-01T00:00:00Z')
    const { env, visible } = await withSales(() => mine)

    expect(await visible()).toEqual(['spring'])
    mine = new Date('2026-09-15T00:00:00Z')
    expect(await visible()).toEqual(['autumn'])       // yours still drives it

    expect(env.clock.frozen).toBe(false)
    expect(() => env.clock.set('2027-01-01T00:00:00Z')).toThrow(/source is yours to move/)
    expect(() => env.clock.advance('1d')).toThrow(/source is yours to move/)
  })
})

describe('what the clock moves — FJS-531', () => {
  // These were the hole: a column DEFAULT and an AFTER UPDATE trigger, each
  // `strftime(…,'now')`, so a suite that froze time and staged an "old" row by
  // writing nothing got a row stamped with today and every window over it was
  // wrong. The client stamps both now, from the clock it was given.
  test('@default(now()) and @updatedAt follow this clock', async () => {
    const env = await createTestEnv({ schema: STAMPS, now: '2020-01-02T03:04:05Z' } as never)
    const row = await env.db.note.create({ data: { body: 'x' } }) as { createdAt: string; updatedAt: string }

    expect(row.createdAt).toBe('2020-01-02T03:04:05.000Z')
    expect(row.updatedAt).toBe('2020-01-02T03:04:05.000Z')
  })

  test('a stated timestamp still wins over the stamp', async () => {
    const env = await createTestEnv({ schema: STAMPS, now: '2020-01-02T03:04:05Z' } as never)
    const row = await env.db.note.create({
      data: { body: 'x', createdAt: '2019-05-06T07:08:09.000Z' },
    }) as { createdAt: string }

    // Key PRESENCE decides, so an explicit value is a value — and an explicit
    // null is a null rather than a re-stamp.
    expect(row.createdAt).toBe('2019-05-06T07:08:09.000Z')
  })

  test('an update carries the clock into @updatedAt, and the returned row is the stored row', async () => {
    const env = await createTestEnv({ schema: STAMPS, now: '2020-01-02T03:04:05Z' } as never)
    const row = await env.db.note.create({ data: { body: 'x' } }) as { id: number }
    env.clock.advance('10d')

    const updated = await env.db.note.update({
      where: { id: row.id }, data: { body: 'y' },
    }) as { updatedAt: string }
    const reread = await env.db.note.findUnique({ where: { id: row.id } }) as { updatedAt: string }

    expect(updated.updatedAt).toBe('2020-01-12T03:04:05.000Z')
    // RETURNING used to be answered before an AFTER trigger fired (`FJS-396`).
    // There is no trigger now, so the two cannot disagree.
    expect(reread.updatedAt).toBe(updated.updatedAt)
  })

  test('a SECOND write at the same instant keeps the frozen value', async () => {
    // The case that killed the halfway version: the trigger fired exactly when
    // the stamped value equalled the stored one, which under a frozen clock is
    // every write after the first.
    const env = await createTestEnv({ schema: STAMPS, now: '2020-01-02T03:04:05Z' } as never)
    const row = await env.db.note.create({ data: { body: 'x' } }) as { id: number }
    await env.db.note.update({ where: { id: row.id }, data: { body: 'y' } })
    await env.db.note.update({ where: { id: row.id }, data: { body: 'z' } })

    const reread = await env.db.note.findUnique({ where: { id: row.id } }) as { updatedAt: string }
    expect(reread.updatedAt).toBe('2020-01-02T03:04:05.000Z')
  })

  test('a retention sweep measures from this clock, not the wall clock', async () => {
    // The reason to have a movable clock at all: a row aging past a window.
    const env = await createTestEnv({ schema: RETAINED, now: '2020-01-02T03:04:05Z' } as never)
    const db  = env.db.asSystem()
    await db.entry.create({ data: { body: 'old' } })

    expect(db.$retain().reduce((n: number, r: { removed: number }) => n + r.removed, 0)).toBe(0)
    env.clock.advance('100d')
    expect(db.$retain().reduce((n: number, r: { removed: number }) => n + r.removed, 0)).toBe(1)
  })
})
