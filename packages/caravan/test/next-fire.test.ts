// ============================================================
// When a schedule next fires — `nextFireTime`, and `nextRuns()` over it.
//
// The search walked one minute at a time with a zone lookup per minute, which
// cost seconds for a weekly schedule, and stopped after a week, so a monthly one
// answered null. An app reading it per request to show *Next run* on a screen
// found both (`FJS-1283`, from `FJS-1241`). It now skips a day or an hour the
// expression cannot match, which is the shape a bug in it would take: a jump
// that steps over a minute the minute walk would have answered.
//
// So the oracle here is the minute walk itself, written against its OWN cached
// formatter rather than through `partsIn`, and run across the days a jump is
// most likely to be wrong — both daylight transitions, in a zone with a
// half-hour one (Lord Howe), one whose clock changes at midnight (Santiago) and
// one with a :45 offset (Kathmandu).
//
// TRAP: nothing here times anything. A search that went back to one minute per
// step would spend minutes on `0 0 1 1 *` and fail by bun's own 5s timeout,
// which is the assertion that the cost is gone.
// ============================================================

import { describe, it, expect } from 'bun:test'
import { parseCron, cronMatches } from '@frontierjs/toolbelt/cron'
import { nextFireTime, CronScheduler } from '../src/cron.ts'

const formatters = new Map<string, Intl.DateTimeFormat>()
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function wallAt(t: Date, timeZone: string) {
  let f = formatters.get(timeZone)
  if (!f) formatters.set(timeZone, f = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', weekday: 'short',
    month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }))
  const p: Record<string, string> = {}
  for (const { type, value } of f.formatToParts(t)) p[type] = value
  return { minutes: +p.minute, hours: +p.hour % 24, date: +p.day, month: +p.month, day: WEEKDAY[p.weekday] }
}

/** The minute walk: every minute of real time, asked in the zone. */
function walked(expr: string, fromISO: string, timeZone: string, days = 9): string | null {
  const fields = parseCron(expr)
  const t = new Date(fromISO)
  t.setSeconds(0, 0)
  for (let i = 0; i < days * 1440; i++) {
    t.setTime(t.getTime() + 60_000)
    if (cronMatches(fields, wallAt(t, timeZone))) return t.toISOString()
  }
  return null
}

const EXPRESSIONS = [
  '30 2 * * *', '0 2 * * *', '15 1 * * *', '30 1-3 * * *',
  '0 9 * * 1', '45 23 * * 0', '0 0 * * 6,0', '*/7 * * * *', '0 */3 * * *',
  // The first hour of the day AFTER a transition day — what a day jump aimed at
  // midnight steps over when the day it crosses is 23 hours long.
  '30 0 * * 1', '30 0 * * *',
]
const ZONES = ['America/Denver', 'Europe/London', 'Australia/Lord_Howe', 'America/Santiago', 'Asia/Kathmandu']
// Just before, and inside, each zone's transitions in 2026.
const FROM = [
  '2026-03-08T08:59:00Z', '2026-11-01T07:30:00Z',   // Denver
  '2026-03-28T23:59:00Z', '2026-10-24T23:10:00Z',   // London
  '2026-04-04T14:20:00Z', '2026-10-03T15:31:00Z',   // Lord Howe
  '2026-04-04T20:00:00Z', '2026-09-05T20:00:00Z',   // Santiago, at local midnight
]

describe('nextFireTime — the minute walk\'s answer, without walking every minute', () => {
  for (const zone of ZONES) {
    it(`agrees with the walk across the daylight transitions, in ${zone}`, () => {
      const wrong: string[] = []
      for (const expr of EXPRESSIONS) for (const from of FROM) {
        const got  = nextFireTime(expr, new Date(from), { timeZone: zone })?.toISOString() ?? null
        const want = walked(expr, from, zone)
        if (got !== want) wrong.push(`${expr} from ${from}: ${got}, walk says ${want}`)
      }
      expect(wrong).toEqual([])
    })
  }

  it('finds a monthly schedule, which a week-long horizon did not', () => {
    const next = nextFireTime('0 3 1 * *', new Date('2026-09-02T00:00:00Z'), { timeZone: 'UTC' })
    expect(next?.toISOString()).toBe('2026-10-01T03:00:00.000Z')
  })

  it('finds a yearly one', () => {
    const next = nextFireTime('0 0 1 1 *', new Date('2026-01-02T00:00:00Z'), { timeZone: 'America/Denver' })
    expect(next?.toISOString()).toBe('2027-01-01T07:00:00.000Z')
  })

  it('answers null for February 29th in a year that has none', () => {
    expect(nextFireTime('0 0 29 2 *', new Date('2029-03-01T00:00:00Z'), { timeZone: 'UTC' })).toBeNull()
    expect(nextFireTime('0 0 29 2 *', new Date('2027-03-01T00:00:00Z'), { timeZone: 'UTC' })?.toISOString())
      .toBe('2028-02-29T00:00:00.000Z')
  })
})

describe('nextRuns — every schedule, off the scheduler\'s clock', () => {
  it('answers a monthly and a yearly schedule beside a frequent one', () => {
    const sched = new CronScheduler({ now: () => new Date('2026-09-22T12:00:00Z') })
    sched.add({ name: 'often',   cron: '*/5 * * * *', timeZone: 'UTC', fn: () => {} })
    sched.add({ name: 'monthly', cron: '0 3 1 * *',   timeZone: 'UTC', fn: () => {} })
    sched.add({ name: 'yearly',  cron: '0 0 1 1 *',   timeZone: 'UTC', fn: () => {} })

    expect(sched.nextRuns().map(r => [r.name, r.nextRun?.toISOString()])).toEqual([
      ['often',   '2026-09-22T12:05:00.000Z'],
      ['monthly', '2026-10-01T03:00:00.000Z'],
      ['yearly',  '2027-01-01T00:00:00.000Z'],
    ])
  })
})
