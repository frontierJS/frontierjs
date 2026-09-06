// tests/scheduler-overlap.test.ts
//
// A recurring job does not overlap itself.
//
// `setInterval` fires on a clock and knows nothing about the body it started
// last time. Measured before the fix: a 100 ms interval with a 350 ms body
// started 15 runs in 1.6 s and had FOUR of them in flight at once, with nothing
// anywhere reporting that it had happened. A scheduled job that overlaps itself
// is how one corrupts the state it is maintaining.
//
// A tick that arrives while the previous run is still going is DROPPED rather
// than queued: queueing turns a job that cannot keep up into an unbounded
// backlog, which fails later and further from the cause. `stats.skipped` is
// what keeps the drop from being silent, which is the whole difference between
// this and the bug.
//
// `batteries-10` of FJS-709. Two of its four clauses were already closed by the
// `@frontierjs/toolbelt/cron` consolidation and are asserted here as controls,
// so they cannot regress unnoticed: `1-10/2` is a stepped RANGE and not
// every-2, and a date that never occurs is refused.

import { describe, test, expect } from 'bun:test'
import { createScheduler }        from '../src/scheduler/index.ts'
import { parseCron, cronMatches } from '@frontierjs/toolbelt/cron'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('a slow body does not stack up', () => {

  test('a 100ms interval with a 350ms body runs one at a time', async () => {
    const s: any = createScheduler()
    let concurrent = 0, peak = 0, started = 0
    s.every('100ms', async () => {
      started++; concurrent++; peak = Math.max(peak, concurrent)
      await sleep(350)
      concurrent--
    })
    await sleep(1600)
    s.destroy?.()

    expect(peak).toBe(1)
    // And it did keep running — a guard that never released would also give 1.
    expect(started).toBeGreaterThan(2)
  })

  test('the ticks it dropped are counted, not swallowed', async () => {
    const s: any = createScheduler()
    s.every('50ms', async () => { await sleep(300) })
    await sleep(900)
    const stats = s.stats()
    s.destroy?.()

    expect(stats.skipped).toBeGreaterThan(0)
    expect(stats.executions).toBeGreaterThan(0)
  })

  test('a fast body is never skipped — the control', async () => {
    // Without this, a guard that skipped everything would pass the two above.
    const s: any = createScheduler()
    let runs = 0
    s.every('50ms', async () => { runs++ })
    await sleep(400)
    const stats = s.stats()
    s.destroy?.()

    expect(runs).toBeGreaterThan(2)
    expect(stats.skipped).toBe(0)
  })

  test('a body that throws releases the guard', async () => {
    // The `finally`. Without it the first throw stops the job for ever, which
    // is a worse failure than the overlap it replaced.
    const s: any = createScheduler()
    let runs = 0
    s.every('50ms', async () => { runs++; throw new Error('nope') })
    await sleep(400)
    const stats = s.stats()
    s.destroy?.()

    expect(runs).toBeGreaterThan(2)
    expect(stats.errors).toBeGreaterThan(2)
  })
})

describe('an interval that is not one is refused', () => {

  test("every('0ms') is a hot loop, not a schedule", () => {
    const s: any = createScheduler()
    expect(() => s.every('0ms', () => {})).toThrow(/not an interval/)
    s.destroy?.()
  })

  test("every('nonsense') no longer becomes five minutes", () => {
    // `parseTtl` answers 300_000 for anything it cannot read — the right
    // default for a cache TTL and a job on a schedule nobody wrote here. The
    // parse and the opinion about it are now separate entry points.
    const s: any = createScheduler()
    expect(() => s.every('nonsense', () => {})).toThrow(/not an interval/)
    s.destroy?.()
  })

  test('…and a real duration is accepted', () => {
    const s: any = createScheduler()
    expect(() => s.every('30s', () => {})).not.toThrow()
    expect(() => s.every('5 minutes', () => {})).not.toThrow()
    s.destroy?.()
  })
})

// ─── the two clauses the toolbelt consolidation already closed ────────────

describe('the cron grammar, as controls', () => {

  const minutesOf = (expr: string) => {
    const p = parseCron(expr)
    return [...Array(60).keys()].filter(m =>
      cronMatches(p, { minutes: m, hours: 12, date: 1, month: 1, day: 4 } as never))
  }

  test('a stepped RANGE steps within the range, not from zero', () => {
    // `1-10/2` was read as every-2 because `/` was checked before `-`.
    expect(minutesOf('1-10/2 * * * *')).toEqual([1, 3, 5, 7, 9])
    expect(minutesOf('1-10 * * * *')).toEqual([1,2,3,4,5,6,7,8,9,10])
    expect(minutesOf('*/20 * * * *')).toEqual([0, 20, 40])
  })

  test('a date that never occurs is refused rather than never firing', () => {
    expect(() => parseCron('0 0 31 2 *')).toThrow(/31/)
    expect(() => parseCron('0 0 30 2 *')).toThrow()
    expect(() => parseCron('0 0 31 1 *')).not.toThrow()
  })
})
