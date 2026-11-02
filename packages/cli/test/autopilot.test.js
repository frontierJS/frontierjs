// autopilot.test.js — the schedule file read once: an entry's caps become its
// script's flags, an unknown loop or cap is refused by name, an entry whose
// worst run is over the day's cap is refused at read time, and what a day has
// spent is counted off the log's own lines.
//
// What can be WRONG: a mistyped cap passed through as a flag the script never
// had, a schedule that reads half (one bad entry refused, the rest run), and a
// day cap compared against every hand run in the log rather than the scheduled ones.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join }   from 'path'
import { tmpdir } from 'os'

import { readSchedule, writeSwitch, flagsOf, worstCost, cronShape, spentToday, overDayCap, LOOPS, MAX_LANES } from '../core/autopilot.js'

let DIR
beforeAll(() => { DIR = mkdtempSync(join(tmpdir(), 'autopilot-')) })
afterAll(() => rmSync(DIR, { recursive: true, force: true }))

let n = 0
const file = body => {
  const f = join(DIR, `schedule-${++n}.json`)
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body))
  return f
}
const read = body => readSchedule({ file: file(body) })

const FIX   = { loop: 'fix',   cron: '0 1 * * *', caps: { rows: 4, lanes: 2, budget: 5, sev: 'S3,S4', model: 'sonnet' } }
const FRAME = { loop: 'frame', cron: '30 0 * * 1-5', caps: { rows: 2, max: 4, budget: 5 } }

describe('readSchedule', () => {
  test('a missing file is a schedule with nothing set', () => {
    expect(readSchedule({ file: join(DIR, 'none.json') })).toEqual({
      file: join(DIR, 'none.json'), exists: false, on: false, day: null, entries: [], stressors: null, missing: ['day.attempts', 'day.dollars'],
    })
  })

  test('a whole file reads with each entry carrying its flags and worst run, and nothing missing', () => {
    const s = read({ on: true, day: { attempts: 20, dollars: 40 }, entries: [FIX, FRAME], stressors: { dir: '../apps', apps: ['serpgrid', 'thod'] } })
    expect(s).toMatchObject({ exists: true, on: true, day: { attempts: 20, dollars: 40 }, missing: [], stressors: { dir: '../apps', apps: ['serpgrid', 'thod'] } })
    expect(s.entries[0]).toEqual({ ...FIX, flags: ['--rows', '4', '--lanes', '2', '--budget', '5', '--sev', 'S3,S4', '--model', 'sonnet', '--source', 'autopilot'], worst: 20 })
    expect(s.entries[1]).toEqual({ ...FRAME, flags: ['--rows', '2', '--max', '4', '--budget', '5', '--source', 'autopilot'], worst: 30 })
  })

  test('a cap not set is listed by path, never defaulted', () => {
    const s = read({ entries: [{ loop: 'fix', cron: '* * * * *', caps: { rows: 1 } }] })
    expect(s.missing).toEqual(['day.attempts', 'day.dollars', 'entries[0].caps.lanes', 'entries[0].caps.budget', 'entries[0].caps.sev', 'entries[0].caps.model'])
    expect(s.entries[0].flags).toEqual(['--rows', '1', '--source', 'autopilot'])
    expect(s.entries[0].worst).toBeNull()
  })

  test('an unknown loop is refused by name, with the loops it runs', () => {
    expect(() => read({ entries: [FIX, { loop: 'stress', cron: '* * * * *' }] })).toThrow(/entry 2: 'stress' is not a loop autopilot runs; it runs fix, frame/)
  })

  test('an unknown cap is refused by name, and so is one of the wrong shape', () => {
    expect(() => read({ entries: [{ ...FIX, caps: { ...FIX.caps, turns: 40 } }] })).toThrow(/entry 1 \(fix\): 'turns' is not a cap fix takes; it takes rows, lanes, budget, sev, model/)
    expect(() => read({ entries: [{ ...FRAME, caps: { ...FRAME.caps, lanes: 2 } }] })).toThrow(/'lanes' is not a cap frame takes/)
    expect(() => read({ entries: [{ ...FIX, caps: { ...FIX.caps, lanes: MAX_LANES + 1 } }] })).toThrow(new RegExp(`lanes is ${MAX_LANES + 1}, not a whole number of lanes, 1 to ${MAX_LANES}`))
    expect(() => read({ entries: [{ ...FIX, caps: { ...FIX.caps, sev: 'S5' } }] })).toThrow(/sev is "S5", not severities/)
    expect(() => read({ entries: [{ ...FIX, caps: { ...FIX.caps, model: 'haiku' } }] })).toThrow(/model is "haiku", not one of sonnet, opus/)
    expect(() => read({ entries: [{ ...FIX, caps: { ...FIX.caps, rows: '4' } }] })).toThrow(/rows is "4", not a whole number/)
  })

  test('an entry whose worst run is over the day cap is refused at read time, so nothing of the file runs', () => {
    expect(() => read({ day: { attempts: 20, dollars: 10 }, entries: [FIX] })).toThrow(/entry 1 \(fix\): its worst run is \$20 \(4 rows × \$5 × 1 rung\), over the day's \$10/)
    expect(() => read({ day: { attempts: 3, dollars: 100 }, entries: [FIX] })).toThrow(/4 rows in one run is over the day's 3 attempts/)
    // Opus on the ladder is the first rung plus a second at twice its cap.
    expect(() => read({ day: { attempts: 20, dollars: 50 }, entries: [{ ...FIX, caps: { ...FIX.caps, model: 'opus' } }] })).toThrow(/\$60 \(4 rows × \$5 × 3 rungs\), over the day's \$50/)
    expect(read({ day: { attempts: 20, dollars: 60 }, entries: [{ ...FIX, caps: { ...FIX.caps, model: 'opus' } }] }).entries[0].worst).toBe(60)
  })

  test('a bad cron line, a bad switch and a bad day cap are each refused by name', () => {
    expect(() => read({ entries: [{ ...FIX, cron: '0 1 * *' }] })).toThrow(/entry 1 \(fix\): cron "0 1 \* \*" is not five fields/)
    expect(() => read({ on: 'yes' })).toThrow(/"on" is "yes", not true or false/)
    expect(() => read({ day: { attempts: 0 } })).toThrow(/day.attempts is 0, not a whole number of attempts above 0/)
    expect(() => read({ day: { hours: 2 } })).toThrow(/day.hours is not a day cap; the day caps are attempts and dollars/)
    expect(() => read({ stressors: { dir: '../x' } })).toThrow(/"stressors" is not \{ dir, apps: \[names\] \}/)
    expect(() => read('{ not json')).toThrow(/is not JSON/)
    expect(() => read([FIX])).toThrow(/holds a list, not an object/)
  })
})

describe('flagsOf and worstCost', () => {
  test('the model ceiling opus is the ladder as it is, so it is no flag', () => {
    expect(flagsOf({ loop: 'fix', caps: { rows: 2, model: 'opus' } })).toEqual(['--rows', '2', '--source', 'autopilot'])
    expect(worstCost({ loop: 'fix', caps: { rows: 2, budget: 1.5, model: 'opus' } })).toBe(9)
    expect(worstCost({ loop: 'frame', caps: { rows: 1, budget: 2 } })).toBe(6)
    expect(worstCost({ loop: 'frame', caps: { rows: 1 } })).toBeNull()
  })

  test('every loop names a script under scripts/', () => {
    for (const l of Object.values(LOOPS)) expect(l.script).toMatch(/^scripts\/[a-z-]+\.mjs$/)
  })
})

describe('cronShape', () => {
  test('five fields of numbers, ranges, steps and lists', () => {
    for (const ok of ['* * * * *', '*/5 * * * *', '0 1,13 * * 1-5', '30 2-6/2 1 * *']) expect(cronShape(ok)).toBe(true)
    for (const bad of ['* * * *', '* * * * * *', 'a b c d e', '', undefined, 42]) expect(cronShape(bad)).toBe(false)
  })
})

describe('spentToday and overDayCap', () => {
  const now  = new Date('2026-11-02T15:00:00')
  const at   = h => new Date(now.getTime() - h * 36e5).toISOString()
  const lines = [
    { at: at(1), id: 'FJS-1', outcome: 'started', source: 'autopilot' },
    { at: at(0.5), id: 'FJS-1', outcome: 'closed', cost: 1.25, source: 'autopilot' },
    { at: at(2), id: 'FJS-2', outcome: 'started', source: 'autopilot' },
    { at: at(1.5), id: 'FJS-2', outcome: 'failed', cost: 0.75, source: 'autopilot' },
    { at: at(3), id: 'FJS-3', outcome: 'started' },
    { at: at(2.5), id: 'FJS-3', outcome: 'closed', cost: 9 },
    { at: at(30), id: 'FJS-4', outcome: 'started', source: 'autopilot' },
    { at: at(29), id: 'FJS-4', outcome: 'closed', cost: 4, source: 'autopilot' },
  ]

  test('counts the scheduled runs of the calendar day and not the hand ones or yesterday\'s', () => {
    expect(spentToday(lines, { now })).toEqual({ attempts: 2, dollars: 2 })
    expect(spentToday([], { now })).toEqual({ attempts: 0, dollars: 0 })
  })

  test('one more attempt is refused at the cap, and with no cap at all', () => {
    expect(overDayCap({ attempts: 10, dollars: 20 }, { attempts: 2, dollars: 2 })).toBeNull()
    expect(overDayCap({ attempts: 2, dollars: 20 }, { attempts: 2, dollars: 2 })).toMatch(/today's 2 attempts reach the day's cap of 2/)
    expect(overDayCap({ attempts: 10, dollars: 2 }, { attempts: 2, dollars: 2 })).toMatch(/today's \$2 reaches the day's cap of \$2/)
    expect(overDayCap({ attempts: 10, dollars: null }, { attempts: 0, dollars: 0 })).toMatch(/the day's dollars cap is not set/)
    expect(overDayCap(null, { attempts: 0, dollars: 0 })).toBe('no day cap is set')
  })
})

describe('writeSwitch', () => {
  test('On is refused by the caps not set, and by a missing or refused file; Off and a full file write and read back', () => {
    const full = { day: { attempts: 20, dollars: 40 }, entries: [FIX, FRAME], stressors: { dir: '../apps', apps: [] } }
    const f = file(full)
    expect(() => writeSwitch({ file: f, on: 'yes' })).toThrow(/takes true or false/)
    expect(() => writeSwitch({ file: join(DIR, 'none.json'), on: true })).toThrow(/does not exist; write it with every cap set/)
    expect(() => writeSwitch({ file: file({ entries: [{ loop: 'fix', cron: '* * * * *', caps: { rows: 1 } }] }), on: true })).toThrow(/Turn On waits on 6 caps not set: day.attempts, day.dollars, entries\[0\].caps.lanes/)
    expect(() => writeSwitch({ file: file('{ not json'), on: false })).toThrow(/is not JSON/)
    expect(writeSwitch({ file: f, on: true }).on).toBe(true)
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ ...full, on: true })
    expect(writeSwitch({ file: f, on: false }).on).toBe(false)
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ ...full, on: false })
  })
})
