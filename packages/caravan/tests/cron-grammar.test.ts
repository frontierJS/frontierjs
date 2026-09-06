// ============================================================
// cron-grammar.test.ts — a schedule that cannot fire is refused, here
//
// `FJS-767`. The grammar is `@frontierjs/toolbelt/cron` and is asserted there.
// What is asserted HERE is the half that is caravan's: that a bad expression
// stops at `add()` naming the JOB — the expression alone is not enough to find
// the declaration once it can live in any `*.job.ts` file — and that a compound
// expression fires at the hours it names.
//
// The rows are the expressions this parser used to accept and then never match,
// which is `FJS-327`'s silence one layer down: they reached `registrations()`
// and `jobs.snapshot.md` and ran zero times for the life of the process.
// ============================================================

import { describe, it, expect } from 'bun:test'
import { CronScheduler, parseCronExpr } from '../src/cron.ts'

const scheduler = () => new CronScheduler({ now: () => new Date('2026-03-02T00:00:00Z') })

const add = (cron: string) => {
  const s = scheduler()
  try { s.add({ name: 'nightly-report', cron, fn: () => {} }); return null }
  catch (err) { return (err as Error).message }
}

// Which hours of one day this expression matches, read through the validator
// the scheduler itself uses.
const hours = (cron: string): number[] => {
  const out: number[] = []
  for (let h = 0; h < 24; h++)
    if (parseCronExpr(cron, new Date(Date.UTC(2026, 2, 2, h, 0, 0)), { timeZone: 'UTC' }).isValid)
      out.push(h)
  return out
}

describe('an expression that can never fire is refused at registration', () => {
  it('names the job as well as the expression', () => {
    const msg = add('0 25 * * *')
    expect(msg).toContain('nightly-report')
    expect(msg).toContain('hour value is 25')
  })

  it('refuses every shape that used to register and never run', () => {
    for (const cron of ['0 25 * * *', '61 * * * *', '0 0 32 * *', '0 0 * 13 *',
                        '*/0 * * * *', '-5 * * * *', 'abc * * * *', '0 9 31 2 *'])
      expect(add(cron)).not.toBeNull()
  })

  // The control. A registration that refused everything would satisfy the row
  // above on its own, and the schedules this app already runs are the ones that
  // must not move.
  it('and accepts the ordinary ones', () => {
    for (const cron of ['* * * * *', '*/5 * * * *', '30 * * * *', '0 */2 * * *',
                        '0 3 * * 1', '30 1,13 * * *', '0 9 29 2 *'])
      expect(add(cron)).toBeNull()
  })
})

describe('a compound term is read whole', () => {
  it('a range AND a list keeps both', () => {
    // Was [1, 2, 3, 4, 5]: the parser took the first operator it found and split
    // on that character alone, so `,8` was gone with nothing said.
    expect(hours('0 1-5,8 * * *')).toEqual([1, 2, 3, 4, 5, 8])
  })

  it('a range with a step steps through the range', () => {
    expect(hours('0 1-5/2 * * *')).toEqual([1, 3, 5])
  })

  it('and the single-operator spellings are unchanged', () => {
    expect(hours('0 1,3,5 * * *')).toEqual([1, 3, 5])
    expect(hours('0 1-5 * * *')).toEqual([1, 2, 3, 4, 5])
    expect(hours('0 */6 * * *')).toEqual([0, 6, 12, 18])
  })
})

describe('Sunday', () => {
  it('is the same day spelled three ways', () => {
    // `0 9 * * 7` used to match no day at all while `sun` worked, so one
    // spelling of one weekly job silently never ran.
    const sunday = new Date(Date.UTC(2026, 2, 8, 9, 0, 0))   // a Sunday
    for (const cron of ['0 9 * * 7', '0 9 * * 0', '0 9 * * sun'])
      expect(parseCronExpr(cron, sunday, { timeZone: 'UTC' }).isValid).toBe(true)
  })

  it('and a range ending on it includes the days before', () => {
    const fri = new Date(Date.UTC(2026, 2, 6, 9, 0, 0))
    const sun = new Date(Date.UTC(2026, 2, 8, 9, 0, 0))
    const mon = new Date(Date.UTC(2026, 2, 9, 9, 0, 0))
    expect(parseCronExpr('0 9 * * 5-7', fri, { timeZone: 'UTC' }).isValid).toBe(true)
    expect(parseCronExpr('0 9 * * 5-7', sun, { timeZone: 'UTC' }).isValid).toBe(true)
    expect(parseCronExpr('0 9 * * 5-7', mon, { timeZone: 'UTC' }).isValid).toBe(false)
  })
})
