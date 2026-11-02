// loop-log.test.js — the loops' logs read once: the pairing of an attempt with
// its start, the 24-hour window, one event of each kind, a busy lane and a patch.
//
// What can be WRONG: an attempt paired with another row's start, an entry
// outside the window counted in the day's spend, a lane whose row was never
// finished shown idle, and a patch whose row is not the one its file names.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs'
import { join }   from 'path'
import { tmpdir } from 'os'

import { readLog, finishedAttempts, readLoopLog } from '../core/loop-log.js'

const UNTIL = Date.parse('2026-11-02T12:00:00Z')
const at    = h => new Date(UNTIL - h * 36e5).toISOString()
const lane  = n => `/home/x/.fli/lanes/ws-${n}`

let DIR, LOGS

const fixLines = [
  { at: at(30), id: 'FJS-1', severity: 'S2', model: 'sonnet', effort: 'high', outcome: 'started' },
  { at: at(29), id: 'FJS-1', severity: 'S2', model: 'sonnet', effort: 'high', cost: 9, turns: 5, minutes: 1, outcome: 'closed', cwd: lane(1) },
  { at: at(10), id: 'FJS-2', severity: 'S3', model: 'sonnet', effort: 'high', outcome: 'started' },
  { at: at(9),  id: 'FJS-2', severity: 'S3', model: 'sonnet', effort: 'high', cost: 0.5, turns: 12, minutes: 3, outcome: 'closed', cwd: lane(2), source: 'schedule' },
  { at: at(8),  lane: 2, row: 'FJS-2', harvest: { written: ['a.js', 'b.js'], dropped: [], conflicts: [] } },
  { at: at(7),  id: 'FJS-3', severity: 'S3', model: 'sonnet', effort: 'high', outcome: 'started' },
  { at: at(6),  id: 'FJS-3', severity: 'S3', model: 'sonnet', effort: 'high', cost: 0.25, turns: 7, minutes: 2, outcome: 'blocked', cwd: lane(1) },
  // lane 3 has started FJS-4 and nothing has finished it
  { at: at(1),  id: 'FJS-4', severity: 'S4', model: 'sonnet', effort: 'high', outcome: 'started', lane: 3 },
]
const frameLines = [
  { at: at(5), id: 'paper-a', questions: ['paper-a:q1', 'paper-a:q2'], model: 'opus', effort: 'low', outcome: 'started' },
  { at: at(4), id: 'paper-a', model: 'opus', effort: 'low', cost: 0.4, turns: 9, minutes: 2, outcome: 'framed settled', outcomes: { 'paper-a:q1': 'framed', 'paper-a:q2': 'settled' } },
]

beforeAll(() => {
  DIR  = mkdtempSync(join(tmpdir(), 'loop-log-'))
  LOGS = join(DIR, '.fli')
  mkdirSync(join(LOGS, 'lanes', 'patches'), { recursive: true })
  mkdirSync(join(LOGS, 'lanes', 'ws-1'))
  writeFileSync(join(LOGS, 'fix-loop.jsonl'), fixLines.map(l => JSON.stringify(l)).join('\n') + '\nnot json\n')
  writeFileSync(join(LOGS, 'frame-loop.jsonl'), frameLines.map(l => JSON.stringify(l)).join('\n') + '\n')
  writeFileSync(join(LOGS, 'lanes', 'patches', 'FJS-9.patch'), 'diff')
  utimesSync(join(LOGS, 'lanes', 'patches', 'FJS-9.patch'), new Date('2026-11-02T08:00:00Z'), new Date('2026-11-02T08:00:00Z'))
  writeFileSync(join(LOGS, 'fix-loop-review.md'), '# review\n\nrepeats\n')
})

afterAll(() => rmSync(DIR, { recursive: true, force: true }))

const read = () => readLoopLog({ logDir: LOGS, root: '/code/ws', until: UNTIL })

describe('readLog', () => {
  test('is [] for a missing file and skips a line that does not parse', () => {
    expect(readLog(join(LOGS, 'nope.jsonl'))).toEqual([])
    expect(readLog(join(LOGS, 'fix-loop.jsonl'))).toHaveLength(fixLines.length)
  })
})

describe('finishedAttempts', () => {
  test('pairs each finish with the last earlier start of its own id', () => {
    const got = finishedAttempts(readLog(join(LOGS, 'fix-loop.jsonl')))
    expect(got.map(a => a.id)).toEqual(['FJS-1', 'FJS-2', 'FJS-3'])
    expect(got.map(a => a.startedAt)).toEqual([at(30), at(10), at(7)])
  })
})

describe('readLoopLog', () => {
  test('the window is the 24 hours ending at until, and an older attempt is left out of attempts and spend', () => {
    const t = read()
    expect(t.window).toEqual({ start: at(24), end: at(0) })
    expect(t.attempts.map(a => a.id)).toEqual(['FJS-2', 'FJS-3'])
    expect(t.attempts[0].source).toBe('schedule')
    expect(t.spend).toBe(1.15)
    expect(t.counts).toMatchObject({ closed: 1, blocked: 1, started: 3, harvest: 1, fixLines: 6, frameLines: 2 })
  })

  test('a row, a question and a paper each become an event, with the building names the town uses', () => {
    const { events } = read()
    const find = (kind, label) => events.find(e => e.kind === kind && e.label.startsWith(label))
    expect(find('row', 'closed')).toMatchObject({ id: 'FJS-2', from: 'lane.2', to: 'dock', cost: 0.5, source: 'schedule' })
    expect(find('row', 'started')).toMatchObject({ from: 'registry.ready', to: 'lane.2' })
    // A start naming its lane is drawn there even with nothing finishing it; one naming none is read off its finish.
    expect(events.find(e => e.id === 'FJS-4')).toMatchObject({ from: 'registry.ready', to: 'lane.3', label: 'started · S4 · sonnet·high' })
    expect(find('row', 'harvest 2 files')).toMatchObject({ from: 'lane.2', to: 'dock' })
    expect(find('question', 'filed a ruling')).toMatchObject({ id: 'FJS-3', from: 'registry.blocked', to: 'council.open' })
    expect(find('paper', 'framing 2')).toMatchObject({ id: 'paper-a', from: 'plans', to: 'framing' })
    expect(events.filter(e => e.kind === 'question' && e.from === 'framing').map(e => e.to)).toEqual(['council.bench', 'council.wall'])
    expect(events.map(e => e.t)).toEqual([...events.map(e => e.t)].sort())
  })

  test('a lane whose newest line is a start nothing finished is busy; the others are not', () => {
    const { lanes } = read()
    expect(lanes.map(l => l.id)).toEqual(['lane.1', 'lane.2', 'lane.3', 'lane.4', 'lane.5'])
    expect(lanes.map(l => l.busy)).toEqual([false, false, true, false, false])
    expect(lanes[0]).toMatchObject({ dir: 'ws-1', exists: true, closedToday: 0, last: { row: 'FJS-3', outcome: 'blocked' } })
    expect(lanes[1]).toMatchObject({ exists: false, closedToday: 1, spendToday: 0.5 })
  })

  test('a lane whose lock names a live pid is busy even when the log shows nothing', () => {
    writeFileSync(join(LOGS, 'lanes', 'ws-4.lock'), String(process.pid))
    try { expect(read().lanes[3].busy).toBe(true) } finally { rmSync(join(LOGS, 'lanes', 'ws-4.lock')) }
  })

  test('a patch names its row and the time it was written', () => {
    const { dock, frame, review } = read()
    expect(dock.patches).toEqual([{ file: 'FJS-9.patch', row: 'FJS-9', at: '2026-11-02T08:00:00.000Z' }])
    expect(dock).toMatchObject({ harvestsToday: 1, filesHarvestedToday: 2 })
    expect(frame).toMatchObject({ linesToday: 2, total: 2, framedAllTime: 0 })
    expect(review.head).toEqual(['# review', 'repeats'])
  })

  test('a missing logDir reads as an empty town', () => {
    const t = readLoopLog({ logDir: join(DIR, 'none'), root: '/code/ws', until: UNTIL })
    expect(t).toMatchObject({ attempts: [], events: [], spend: 0, review: null })
    expect(t.lanes.every(l => !l.busy && !l.exists)).toBe(true)
  })
})
