// test/scheduler-cron.test.ts
//
// `FJS-767`. `app.scheduler.cron()` had a parser of its own and Caravan had
// another, and they were broken differently — the same expression named two
// different schedules depending on which timer was holding it:
//
//   0 1-5,8 * * *      here: hours 1, 8            caravan: hours 1-5
//   0 1-5/2 * * *      here: every 2nd hour        caravan: hours 1-5
//   0 25 * * *         both: registered, then matched no minute, for ever
//
// The grammar is `@frontierjs/toolbelt/cron` now and is asserted there. What is
// asserted here is junction's half: that a bad expression stops at `cron()`
// rather than becoming a timer that never fires, and that the matcher reads the
// clock in UTC (`FJS-1150`) — this scheduler is in-process and states no zone,
// so it names the one that is the same everywhere rather than the host's.
//
// **`bun test` runs in UTC whatever the host is set to** — measured at offset 0
// on a machine at −7 — so a case built with `new Date(y, m, d, …)` and one built
// with `Date.UTC` agree here and disagree for every developer running the code.
// That is what let this matcher read the host clock for its whole life with a
// file of clock assertions sitting on it. Every date below is `Date.UTC`, and
// the zone rows set `TZ` themselves, which is the only shape that can fail.

import { describe, test, expect, afterEach } from 'bun:test'
import { createScheduler, cronMatcher } from '../src/scheduler/index.ts'

let sched: ReturnType<typeof createScheduler> | null = null
const make = () => (sched = createScheduler())
afterEach(() => { sched?.destroy(); sched = null })

const refuses = (expr: string): string | null => {
  const s = make()
  try { s.cron(expr, async () => {}); return null }
  catch (err) { return (err as Error).message }
}

// Which hours of one UTC day the compiled matcher accepts.
const hours = (expr: string): number[] => {
  const match = cronMatcher(expr)
  const out: number[] = []
  for (let h = 0; h < 24; h++) if (match(new Date(Date.UTC(2026, 2, 2, h, 0, 0)))) out.push(h)
  return out
}

describe('an expression that can never fire is refused at registration', () => {
  test('every shape that used to become a timer matching nothing', () => {
    for (const expr of ['0 25 * * *', '61 * * * *', '0 0 32 * *', '0 0 * 13 *',
                        '*/0 * * * *', '-5 * * * *', 'abc * * * *', '0 9 31 2 *'])
      expect(refuses(expr)).not.toBeNull()
  })

  // The control: a refusal that refused everything would pass the row above.
  test('and the ordinary ones still register', () => {
    for (const expr of ['* * * * *', '*/15 * * * *', '0 2 * * *', '0 3 * * 1', '30 1,13 * * *'])
      expect(refuses(expr)).toBeNull()
  })

  test('the message names the field and the bound', () => {
    expect(refuses('0 25 * * *')).toContain('hour value is 25, outside 0-23')
  })
})

describe('a compound term is read whole', () => {
  test('a range AND a list keeps both — it used to keep two of six', () => {
    expect(hours('0 1-5,8 * * *')).toEqual([1, 2, 3, 4, 5, 8])
  })

  test('a range with a step stays inside the range — it used to leave it', () => {
    expect(hours('0 1-5/2 * * *')).toEqual([1, 3, 5])
  })

  test('and the single-operator spellings are unchanged', () => {
    expect(hours('0 1,3,5 * * *')).toEqual([1, 3, 5])
    expect(hours('0 1-5 * * *')).toEqual([1, 2, 3, 4, 5])
    expect(hours('0 */6 * * *')).toEqual([0, 6, 12, 18])
  })
})

describe('the clock it reads', () => {
  test('month is cron\'s 1-12 and not the Date object\'s 0-11', () => {
    // `getMonth()` answers 2 for March. A matcher that forwarded it unchanged
    // would fire `0 0 1 3 *` in February and never in March, which is a
    // schedule that is wrong once a year and looks fine every other day.
    const match = cronMatcher('0 0 1 3 *')
    expect(match(new Date(Date.UTC(2026, 2, 1, 0, 0, 0)))).toBe(true)    // 1 March
    expect(match(new Date(Date.UTC(2026, 1, 1, 0, 0, 0)))).toBe(false)   // 1 February
  })

  test('the day of week is the UTC one', () => {
    const match = cronMatcher('0 9 * * 1')
    expect(match(new Date(Date.UTC(2026, 2, 2, 9, 0, 0)))).toBe(true)    // a Monday
    expect(match(new Date(Date.UTC(2026, 2, 3, 9, 0, 0)))).toBe(false)
  })

  // The row the others cannot be. Everything above is built from `Date.UTC`, so
  // it passes under a host-clock matcher too once `bun test` has pinned the
  // runtime to UTC — this one moves the zone under the matcher and asserts the
  // ANSWER does not move, which is the whole claim.
  //
  // Measured before the fix: `0 9 * * *` matched 16:00Z under
  // America/Los_Angeles, 09:00Z under UTC and neither under Europe/Berlin —
  // one expression, three schedules, with nothing in the app saying which.
  test('the same instant answers the same in every zone', () => {
    const held = process.env.TZ
    try {
      for (const tz of ['UTC', 'America/Los_Angeles', 'Europe/Berlin', 'Pacific/Auckland']) {
        process.env.TZ = tz
        // Built INSIDE the loop: a `Date` caches its local-time fields at
        // construction, so one made before the zone moved keeps answering in
        // the old one and this row would grade nothing.
        const nine  = new Date(Date.UTC(2026, 2, 2, 9, 0, 0))
        const four  = new Date(Date.UTC(2026, 2, 2, 16, 0, 0))
        const match = cronMatcher('0 9 * * *')
        expect(`${tz} 09:00Z ${match(nine)}`).toBe(`${tz} 09:00Z true`)
        expect(`${tz} 16:00Z ${match(four)}`).toBe(`${tz} 16:00Z false`)
      }
    } finally {
      if (held === undefined) delete process.env.TZ
      else process.env.TZ = held
    }
  })
})
