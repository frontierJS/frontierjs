// ============================================================
// What a schedule does when the wall clock is not a function of real time.
//
// Two days a year the local clock is not monotonic, and a cron expression is
// written in local terms. Before `FJS-525` the firing path asked only *does the
// current minute match*, which answered:
//
//   • spring — `30 2 * * *` fired ZERO times, because 02:30 never occurred
//   • autumn — `30 1 * * *` fired TWICE, because 01:30 occurred twice, and the
//     dispatch id was built from the epoch minute so the two were two keys
//
// `FJS-D144` takes Vixie cron's rule: a fixed-time schedule fires once per
// calendar day whatever the clock does, a wildcard schedule follows the new
// wall clock, and a shift over three hours is a clock correction.
//
// TRAP: these assertions need a clock, not a parser. The suite already had four
// green `timeZone` tests and every one of them asserted that a stated value had
// been stored — which is why the defect lived in the firing path underneath
// them. `CronScheduler` takes `now` for this reason; `_tick` is driven directly
// because `start()` would put a real interval between every assertion.
// ============================================================

import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { occurrenceKey } from '@frontierjs/toolbelt/history'
import { CronScheduler, isFixedTime } from '../src/cron.ts'
import { createCaravan } from '../src/index.ts'
import type { CaravanInstance } from '../src/types.ts'

const NY = 'America/New_York'

/**
 * Step a scheduler minute by minute across a span of real time and collect the
 * fire identities it hands its callback. The identity is the assertion as much
 * as the count is: it is what two processes must agree on for the second one's
 * dispatch to be a no-op.
 */
function runMinutes(cron: string, timeZone: string, startISO: string, minutes: number): number[] {
  let clock = new Date(startISO)
  const fired: number[] = []
  const sched = new CronScheduler({ now: () => clock })

  sched.add({ name: 'job', cron, timeZone, fn: (m) => { fired.push(m) } })

  for (let i = 0; i < minutes; i++) {
    ;(sched as unknown as { _tick(): void })._tick()
    clock = new Date(clock.getTime() + 60_000)
  }
  return fired
}

/** A fire identity read back as the wall clock it names. */
const asWallClock = (m: number) => new Date(m * 60_000).toISOString().slice(0, 16).replace('T', ' ')

describe('isFixedTime — Vixie\'s carve-out', () => {
  it('is fixed when neither the minute nor the hour holds a `*`', () => {
    expect(isFixedTime('30 2 * * *')).toBe(true)
    expect(isFixedTime('0 3 * * 1')).toBe(true)
    expect(isFixedTime('30 1,13 * * *')).toBe(true)   // two stated times is still stated
  })

  it('is not fixed when either holds a `*`, a step included', () => {
    expect(isFixedTime('30 * * * *')).toBe(false)
    expect(isFixedTime('*/5 * * * *')).toBe(false)
    expect(isFixedTime('0 */2 * * *')).toBe(false)    // a step in the hour has no single time to move
    expect(isFixedTime('* * * * *')).toBe(false)
  })

  it('answers false for an expression that is not five fields', () => {
    expect(isFixedTime('30 2 * *')).toBe(false)
  })
})

describe('a fixed-time schedule across a DST boundary', () => {
  // 2026-03-08, America/New_York: 02:00 EST becomes 03:00 EDT. The local day is
  // 23 hours long and no wall clock in [02:00, 03:00) ever happens.
  it('fires ONCE in spring, for the hour that never happened', () => {
    const fired = runMinutes('30 2 * * *', NY, '2026-03-08T05:00:00Z', 23 * 60)
    expect(fired.length).toBe(1)
    // The identity is the SKIPPED wall clock — the moment the schedule asked
    // for — not the instant it was actually run at. Two processes compensating
    // the same gap therefore compute one dispatch id between them.
    expect(asWallClock(fired[0])).toBe('2026-03-08 02:30')
  })

  // 2026-11-01, America/New_York: 02:00 EDT becomes 01:00 EST. The local day is
  // 25 hours long and every wall clock in [01:00, 02:00) happens twice.
  it('fires ONCE in autumn, for the hour that happened twice', () => {
    const fired = runMinutes('30 1 * * *', NY, '2026-11-01T04:00:00Z', 25 * 60)
    expect(fired.length).toBe(1)
    expect(asWallClock(fired[0])).toBe('2026-11-01 01:30')
  })

  it('fires once on an ordinary day, which is the case that must not move', () => {
    const fired = runMinutes('30 2 * * *', NY, '2026-06-15T04:00:00Z', 24 * 60)
    expect(fired.length).toBe(1)
    expect(asWallClock(fired[0])).toBe('2026-06-15 02:30')
  })
})

describe('a wildcard schedule follows the new wall clock', () => {
  // The carve-out, and it is here because compensating this case would be a
  // REGRESSION: hourly already means whatever the clock now says.
  it('fires 25 times on the 25-hour day', () => {
    expect(runMinutes('30 * * * *', NY, '2026-11-01T04:00:00Z', 25 * 60).length).toBe(25)
  })

  it('fires 23 times on the 23-hour day', () => {
    expect(runMinutes('30 * * * *', NY, '2026-03-08T05:00:00Z', 23 * 60).length).toBe(23)
  })

  it('is keyed by the EPOCH minute, so the repeated hour is two distinct fires', () => {
    const fired = runMinutes('30 * * * *', NY, '2026-11-01T05:00:00Z', 120)
    expect(fired.length).toBe(2)
    expect(fired[1] - fired[0]).toBe(60)   // two real hours apart, one wall clock
  })
})

describe('a jump that is not daylight saving', () => {
  it('replays nothing past the three-hour correction threshold', () => {
    let clock = new Date('2026-06-15T04:00:00Z')          // 00:00 local
    const fired: number[] = []
    const sched = new CronScheduler({ now: () => clock })
    sched.add({ name: 'job', cron: '30 2 * * *', timeZone: NY, fn: (m) => { fired.push(m) } })

    ;(sched as unknown as { _tick(): void })._tick()
    clock = new Date(clock.getTime() + 8 * 3600_000)      // NTP step forward 8 hours
    ;(sched as unknown as { _tick(): void })._tick()

    // 02:30 is inside the jump. A daylight-saving gap would replay it; a
    // corrected clock must not, or a machine whose zone was wrong replays a day.
    expect(fired.length).toBe(0)
  })

  it('adopts a large BACKWARD correction instead of stalling until it catches up', () => {
    let clock = new Date('2026-06-15T14:00:00Z')          // 10:00 local
    const fired: number[] = []
    const sched = new CronScheduler({ now: () => clock })
    const tick  = () => (sched as unknown as { _tick(): void })._tick()
    sched.add({ name: 'job', cron: '30 2 * * *', timeZone: NY, fn: (m) => { fired.push(m) } })

    tick()
    clock = new Date(clock.getTime() - 8 * 3600_000)      // NTP step BACK 8 hours → 02:00 local
    tick()
    expect(fired.length).toBe(0)                          // adopting replays nothing

    // Without the threshold on this side the mark stays eight hours ahead and
    // the schedule fires nothing until real time catches up to it — half a day
    // of silence after a correction nobody was told about.
    for (let i = 0; i < 31; i++) { clock = new Date(clock.getTime() + 60_000); tick() }
    expect(fired.map(asWallClock)).toEqual(['2026-06-15 02:30'])
  })

  it('replays a SHORT gap, which is the blocked event loop it also covers', () => {
    let clock = new Date('2026-06-15T06:00:00Z')          // 02:00 local
    const fired: number[] = []
    const sched = new CronScheduler({ now: () => clock })
    sched.add({ name: 'job', cron: '30 2 * * *', timeZone: NY, fn: (m) => { fired.push(m) } })

    ;(sched as unknown as { _tick(): void })._tick()
    clock = new Date(clock.getTime() + 45 * 60_000)       // the process was busy for 45 minutes
    ;(sched as unknown as { _tick(): void })._tick()

    expect(fired.length).toBe(1)
    expect(asWallClock(fired[0])).toBe('2026-06-15 02:30')
  })
})

describe('registration', () => {
  it('a freshly added schedule does not fire for the hours before it existed', () => {
    let clock = new Date('2026-06-15T10:00:00Z')          // 06:00 local, well past 02:30
    const fired: number[] = []
    const sched = new CronScheduler({ now: () => clock })
    sched.add({ name: 'job', cron: '30 2 * * *', timeZone: NY, fn: (m) => { fired.push(m) } })
    ;(sched as unknown as { _tick(): void })._tick()
    expect(fired.length).toBe(0)
  })

  it('re-registering a name drops the mark, so the new schedule replays nothing', () => {
    let clock = new Date('2026-06-15T04:00:00Z')
    const fired: number[] = []
    const sched = new CronScheduler({ now: () => clock })
    sched.add({ name: 'job', cron: '30 2 * * *', timeZone: NY, fn: (m) => { fired.push(m) } })
    ;(sched as unknown as { _tick(): void })._tick()

    clock = new Date(clock.getTime() + 6 * 3600_000)      // 06:00 local
    sched.add({ name: 'job', cron: '30 5 * * *', timeZone: NY, fn: (m) => { fired.push(m) } })
    ;(sched as unknown as { _tick(): void })._tick()

    // 05:30 is behind the new registration, and a replaced schedule's mark
    // describes a walk that no longer means anything.
    expect(fired.length).toBe(0)
  })
})

// ─── Two instances, one jobs.db ───────────────────────────────────────────────
//
// The scheduler firing once is half the guarantee. The other half is that two
// PROCESSES fire their own schedule — there is no leader, on purpose — and only
// the first dispatch becomes a row, which rests entirely on both computing the
// same id. That is what naming a fire by its wall clock buys, and it is not
// observable from the scheduler alone.

const dirs: string[] = []
const queues: CaravanInstance[] = []
afterEach(async () => {
  for (const q of queues.splice(0)) await q.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/**
 * Run N schedulers over the same span of real time against one queue file,
 * dispatching exactly as `index.ts` does. Answers how many rows landed.
 */
async function instancesOver(
  cron: string, timeZone: string, startISO: string, minutes: number, instances: number,
  identity: 'fire' | 'epoch',
  /**
   * Minutes during which instance 1 does not get to tick, though its clock keeps
   * moving — a blocked event loop, a paused container. This is what makes the
   * two identities differ: the instance catches up and fires a wall-clock minute
   * that is no longer the minute it is living in.
   */
  stall: { from: number; len: number } | null = null,
): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'caravan-dst-'))
  dirs.push(dir)
  const q = createCaravan({ db: join(dir, 'jobs.db'), pollInterval: 20 })
  queues.push(q)

  const clocks = Array.from({ length: instances }, () => new Date(startISO))
  const scheds = clocks.map((_, i) => {
    const s = new CronScheduler({ now: () => clocks[i] })
    s.add({
      name: 'nightly', cron, timeZone,
      fn: (fireMinute) => {
        const key = identity === 'fire'
          ? fireMinute
          : Math.floor(clocks[i].getTime() / 60_000)   // what the id used to be built from
        void q.dispatch('nightly', {}, { id: occurrenceKey('cron', 'nightly', key) })
      },
    })
    return s
  })

  for (let m = 0; m < minutes; m++) {
    for (let i = 0; i < instances; i++) {
      const stalled = stall !== null && i === 1 && m >= stall.from && m < stall.from + stall.len
      if (!stalled) (scheds[i] as unknown as { _tick(): void })._tick()
      clocks[i] = new Date(clocks[i].getTime() + 60_000)
    }
  }
  await Bun.sleep(50)
  return q.list({ limit: 100 }).length
}

describe('two instances over one jobs.db', () => {
  it('queue ONE row for the autumn boundary', async () => {
    expect(await instancesOver('30 1 * * *', NY, '2026-11-01T04:00:00Z', 25 * 60, 2, 'fire')).toBe(1)
  })

  it('queue ONE row for the spring boundary, for the hour that never happened', async () => {
    expect(await instancesOver('30 2 * * *', NY, '2026-03-08T05:00:00Z', 23 * 60, 2, 'fire')).toBe(1)
  })

  // 01:30 EDT is 05:30Z, which is minute 90 of a run starting at local midnight.
  const OVER_THE_FIRE = { from: 88, len: 5 }

  it('stay ONE row when one of them was blocked across the fire', async () => {
    // The identity half of the fix, isolated. The stalled instance catches up
    // three minutes late and still names the minute the SCHEDULE asked for, so
    // both compute one id and the second dispatch is a no-op.
    expect(await instancesOver('30 1 * * *', NY, '2026-11-01T04:00:00Z', 25 * 60, 2, 'fire', OVER_THE_FIRE)).toBe(1)
  })

  it('queue TWO under the old epoch-minute identity, on the same stall', async () => {
    // The regression this pins, and it is not a boundary bug: naming a fire by
    // the minute it was RUN AT rather than the minute it was FOR means any
    // instance that falls behind dispatches the nightly job a second time.
    expect(await instancesOver('30 1 * * *', NY, '2026-11-01T04:00:00Z', 25 * 60, 2, 'epoch', OVER_THE_FIRE)).toBe(2)
  })
})
