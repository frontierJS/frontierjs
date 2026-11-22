/**
 * test/retention-fold.test.ts — `@@retention(…, into:)`, retention that FOLDS
 * (`FJS-D1297`, `FJS-3030`).
 *
 * The chart must not move: raw rows older than the window are summed into a
 * rollup and deleted in one transaction, so a reader adding both tables sees
 * the same number before and after the sweep. A day lives in one table or the
 * other, never both — a late row for a folded day is refused by name rather
 * than counted twice or hidden behind a sealed total.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, FoldedSpanError } from '../src/index.js'
import { parse } from '../src/core/parser.js'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'litestone-fold-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const NOW = new Date('2026-06-15T12:00:00.000Z')
const at  = (day: string, hm = '10:00') => `${day}T${hm}:00.000Z`

const MODELS = `
  model Check {
    id         Int      @id @default(autoincrement())
    monitorId  Int
    checkedAt  DateTime
    ok         Boolean
    latencyMs  Int
    @@retention(30d, into: DailyUptime, by: [monitorId, day(checkedAt)], sum: [ok], count: total, max: [latencyMs])
  }
  model DailyUptime {
    id         Int      @id
    monitorId  Int
    day        String   @date
    ok         Int      @default(0)
    total      Int      @default(0)
    latencyMs  Int?
    published  Boolean  @default(false)
    createdAt  DateTime @default(now())
    @@unique([monitorId, day])
    @@transitions(published, publish: false -> true)
  }
`

async function open(models = MODELS) {
  const dir = tmp()
  const db  = await createClient({ schema: `database main { path "${join(dir, 'app.db')}" }\n${models}`, now: () => NOW })
  return { db, sys: db.asSystem() }
}

// The reader the row measured: published rollups plus the raw rows of days
// no rollup holds yet.
async function uptime(sys: any, monitorId: number) {
  const days = new Map<string, { ok: number, total: number }>()
  for (const r of await sys.dailyUptime.findMany({ where: { monitorId } }))
    days.set(r.day, { ok: r.ok, total: r.total })
  for (const c of await sys.check.findMany({ where: { monitorId } })) {
    const d = new Date(c.checkedAt).toISOString().slice(0, 10)
    const e = days.get(d) ?? { ok: 0, total: 0 }
    days.set(d, { ok: e.ok + (c.ok ? 1 : 0), total: e.total + 1 })
  }
  return Object.fromEntries([...days].sort())
}

describe('a fold sums the doomed rows into the rollup and the chart does not move', () => {
  test('old days fold whole, the read is identical before and after, and a later sweep adds to the row', async () => {
    const { db, sys } = await open()
    // 2026-05-10 is 36 days old; 2026-05-16 is inside the window's day
    // (the cutoff is the start of 2026-05-16 UTC); 2026-06-10 is fresh.
    const rows = [
      [1, at('2026-05-10', '01:00'), true, 40], [1, at('2026-05-10', '23:59'), false, 900],
      [1, at('2026-05-11'), true, 50], [2, at('2026-05-10'), true, 10],
      [1, at('2026-05-16', '00:30'), true, 30], [1, at('2026-06-10'), false, 70],
    ] as const
    for (const [monitorId, checkedAt, ok, latencyMs] of rows)
      await sys.check.create({ data: { monitorId, checkedAt, ok, latencyMs } })

    const before = { 1: await uptime(sys, 1), 2: await uptime(sys, 2) }
    const swept  = await sys.$retain()
    expect(swept.find((r: any) => r.model === 'Check')).toMatchObject({ removed: 4, into: 'DailyUptime' })

    const rollups = await sys.dailyUptime.findMany({ orderBy: [{ monitorId: 'asc' }, { day: 'asc' }] })
    expect(rollups.map((r: any) => [r.monitorId, r.day, r.ok, r.total, r.latencyMs])).toEqual([
      [1, '2026-05-10', 1, 2, 900], [1, '2026-05-11', 1, 1, 50], [2, '2026-05-10', 1, 1, 10],
    ])
    expect(new Date(rollups[0].createdAt).toISOString()).toBe(NOW.toISOString())
    expect((await sys.check.findMany()).length).toBe(2)
    expect({ 1: await uptime(sys, 1), 2: await uptime(sys, 2) }).toEqual(before)
    db.$close()
  })
})

describe('a day lives in the raw table XOR in the rollup', () => {
  test('a late row for a folded day is refused by name, asSystem included, and nothing is written', async () => {
    const { db, sys } = await open()
    await sys.check.create({ data: { monitorId: 1, checkedAt: at('2026-05-10'), ok: true, latencyMs: 5 } })
    await sys.$retain()

    const late = sys.check.create({ data: { monitorId: 1, checkedAt: at('2026-05-10', '18:00'), ok: false, latencyMs: 5 } })
    await expect(late).rejects.toBeInstanceOf(FoldedSpanError)
    await expect(sys.check.create({ data: { monitorId: 1, checkedAt: at('2026-05-10', '18:00'), ok: false, latencyMs: 5 } }))
      .rejects.toMatchObject({ status: 409, into: 'DailyUptime', day: '2026-05-10', key: { monitorId: 1 } })
    await expect(sys.check.createMany({ data: [{ monitorId: 1, checkedAt: at('2026-05-10', '19:00'), ok: false, latencyMs: 5 }] }))
      .rejects.toThrow(/folded into DailyUptime/)
    expect((await sys.check.findMany()).length).toBe(0)

    // Another monitor, or another day, is not folded and lands.
    await sys.check.create({ data: { monitorId: 2, checkedAt: at('2026-05-10'), ok: true, latencyMs: 5 } })
    await sys.check.create({ data: { monitorId: 1, checkedAt: at('2026-05-12'), ok: true, latencyMs: 5 } })
    expect((await sys.check.findMany()).length).toBe(2)
    db.$close()
  })

  test('a sealed rollup is not folded into: the sweep reports it and keeps the raw rows', async () => {
    const { db, sys } = await open(MODELS.replace('ok         Int      @default(0)', 'ok         Int      @default(0) @immutable(after: publish)'))
    // The app made and published the day itself, then a raw row of it was left.
    await sys.check.create({ data: { monitorId: 1, checkedAt: at('2026-05-10'), ok: false, latencyMs: 5 } })
    const roll = await sys.dailyUptime.create({ data: { monitorId: 1, day: '2026-05-10', ok: 3, total: 3 } })
    await sys.dailyUptime.update({ where: { id: roll.id }, data: { published: true } })

    const swept = await sys.$retain()
    expect(swept.find((r: any) => r.model === 'Check')).toMatchObject({ removed: 0, error: expect.stringMatching(/sealed/) })
    expect((await sys.dailyUptime.findFirst({ where: { id: roll.id } })).ok).toBe(3)
    expect((await sys.check.findMany()).length).toBe(1)
    db.$close()
  })
})

describe('a fold that would sweep wrong is refused at parse', () => {
  const errs = (schema: string) => parse(schema).errors.join('\n')

  test('the as-written schema parses', () => {
    expect(errs(MODELS)).toBe('')
  })

  test('a rollup whose unique does not cover the key', () => {
    expect(errs(MODELS.replace('@@unique([monitorId, day])', '@@unique([day])'))).toMatch(/DailyUptime needs @@unique\(\[day, monitorId\]\)/)
  })

  test('a rollup with no day column, or a key it does not hold', () => {
    expect(errs(MODELS.replace('day        String   @date', 'day        String'))).toMatch(/DailyUptime\.day.*String @date/)
    expect(errs(MODELS.replace('by: [monitorId, day(checkedAt)]', 'by: [siteId, day(checkedAt)]'))).toMatch(/key 'siteId'/)
  })

  test('a column the fold cannot fill, or an aggregate frozen from create', () => {
    expect(errs(MODELS.replace('createdAt  DateTime @default(now())', 'createdAt  DateTime @default(now())\n    label String'))).toMatch(/cannot fill 'label'/)
    expect(errs(MODELS.replace('total      Int      @default(0)', 'total      Int      @default(0) @immutable'))).toMatch(/total is @immutable from create/)
  })

  test('a bucket other than day, two clocks, or no aggregate', () => {
    expect(errs(MODELS.replace('day(checkedAt)', 'hour(checkedAt)'))).toMatch(/not a bucket/)
    expect(errs(MODELS.replace('@@retention(30d, into:', '@@retention(30d, from: createdAt, into:'))).toMatch(/two clocks/)
    expect(errs(MODELS.replace(', sum: [ok], count: total, max: [latencyMs]', ''))).toMatch(/at least one aggregate/)
  })
})
