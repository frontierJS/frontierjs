// tests/scheduler-cron.test.ts
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
// HOST clock — this scheduler is in-process and has no zone, which is the one
// thing it does differently from Caravan's.

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

// Which local hours of one day the compiled matcher accepts.
const hours = (expr: string): number[] => {
  const match = cronMatcher(expr)
  const out: number[] = []
  for (let h = 0; h < 24; h++) if (match(new Date(2026, 2, 2, h, 0, 0))) out.push(h)
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
    expect(match(new Date(2026, 2, 1, 0, 0, 0))).toBe(true)    // 1 March
    expect(match(new Date(2026, 1, 1, 0, 0, 0))).toBe(false)   // 1 February
  })

  test('the day of week is the local one', () => {
    const match = cronMatcher('0 9 * * 1')
    expect(match(new Date(2026, 2, 2, 9, 0, 0))).toBe(true)    // a Monday
    expect(match(new Date(2026, 2, 3, 9, 0, 0))).toBe(false)
  })
})
