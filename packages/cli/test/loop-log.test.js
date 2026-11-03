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

const stressLines = [
  { at: at(40), app: 'thod', step: '3.1', id: 'thod 3.1', model: 'sonnet', effort: 'high', cost: 2, outcome: 'ticked', filed: [] },
  { at: at(3), app: 'serpgrid', step: '1.2', id: 'serpgrid 1.2', model: 'sonnet', effort: 'high', outcome: 'started', branch: 'stress/1.2' },
  { at: at(2), app: 'serpgrid', step: '1.2', id: 'serpgrid 1.2', model: 'sonnet', effort: 'high', cost: 0.6, turns: 20, minutes: 6, outcome: 'blocked', filed: ['FJS-20', 'FJS-D21'], branch: 'stress/1.2' },
]

const feedLines = [
  { at: at(1.5), feeder: 'ci', id: 'ci', outcome: 'started', source: 'autopilot' },
  { at: at(1), feeder: 'ci', id: 'ci', outcome: 'red', minutes: 21, filed: ['FJS-30'], amended: ['FJS-2'], env: ['CI red: tests · packages/x'], held: 0, run: 'r1', source: 'autopilot' },
]

beforeAll(() => {
  DIR  = mkdtempSync(join(tmpdir(), 'loop-log-'))
  LOGS = join(DIR, '.fli')
  mkdirSync(join(LOGS, 'lanes', 'patches'), { recursive: true })
  mkdirSync(join(LOGS, 'lanes', 'ws-1'))
  writeFileSync(join(LOGS, 'fix-loop.jsonl'), fixLines.map(l => JSON.stringify(l)).join('\n') + '\nnot json\n')
  writeFileSync(join(LOGS, 'frame-loop.jsonl'), frameLines.map(l => JSON.stringify(l)).join('\n') + '\n')
  writeFileSync(join(LOGS, 'stress-loop.jsonl'), stressLines.map(l => JSON.stringify(l)).join('\n') + '\n')
  writeFileSync(join(LOGS, 'feed-loop.jsonl'), feedLines.map(l => JSON.stringify(l)).join('\n') + '\n')
  writeFileSync(join(LOGS, 'lanes', 'patches', 'FJS-9.patch'), 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,2 @@\n-old\n+new\n+more\ndiff --git a/y.js b/y.js\n--- a/y.js\n+++ b/y.js\n@@ -1 +1 @@\n-gone\n')
  utimesSync(join(LOGS, 'lanes', 'patches', 'FJS-9.patch'), new Date('2026-11-02T08:00:00Z'), new Date('2026-11-02T08:00:00Z'))
  writeFileSync(join(LOGS, 'fix-loop-review.md'), '# review\n\nrepeats\n\n## Cost\n\n- not a repeat\n\n## Calls that fail\n\n- `Edit` — 2× in 1 session(s)\n  - call: a.js\n- `Bash` — 1×\n- `Read` — 1×\n\n## Denied tool calls\n\n- Bash ×1\n')
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
    expect(t.spend).toBe(1.75)
    expect(t.counts).toMatchObject({ closed: 1, blocked: 1, started: 3, harvest: 1, fixLines: 6, frameLines: 2, stressLines: 2, feedLines: 2 })
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
    expect(dock.patches).toEqual([{ file: 'FJS-9.patch', row: 'FJS-9', at: '2026-11-02T08:00:00.000Z', files: 2, added: 2, removed: 2 }])
    expect(dock).toMatchObject({ harvestsToday: 1, filesHarvestedToday: 2 })
    expect(frame).toMatchObject({ linesToday: 2, total: 2, framedAllTime: 0 })
  })

  test('a stress step is a site out to the Proving ground and back, and each row it filed a crate to the Registry or a question to the Council', () => {
    const t = read()
    const site = t.events.filter(e => e.kind === 'paper' && e.id === 'serpgrid 1.2')
    expect(site.map(e => [e.from, e.to, e.label])).toEqual([['plans', 'proving', 'stress serpgrid 1.2 · sonnet·high'], ['proving', 'plans', 'blocked']])
    expect(site[1]).toMatchObject({ cost: 0.6, turns: 20 })
    expect(t.events.filter(e => e.label === 'filed by stress serpgrid 1.2').map(e => [e.kind, e.id, e.to]))
      .toEqual([['row', 'FJS-20', 'registry.ready'], ['question', 'FJS-D21', 'council.open']])
    expect(t.stress).toEqual({ linesToday: 2, lastAt: at(2), total: 3, tickedAllTime: 1, filedToday: 2 })
  })

  test('a feeder moves nothing on the map but the rows it filed, each a crate from the Proving ground; it costs nothing', () => {
    const t = read()
    expect(t.events.filter(e => e.label === 'filed by the ci feeder').map(e => [e.kind, e.id, e.from, e.to, e.source])).toEqual([['row', 'FJS-30', 'proving', 'registry.ready', 'autopilot']])
    expect(t.events.some(e => e.id === 'ci')).toBe(false)
    expect(t.spend).toBe(1.75)
  })

  test('the review\'s head and what repeated', () => {
    const { review } = read()
    expect(review.head.slice(0, 2)).toEqual(['# review', 'repeats'])
    // Top-level bullets under a repeat heading only, two per heading; Cost's bullet and a sub-bullet are not repeats.
    expect(review.repeated).toEqual(['Calls that fail: `Edit` — 2× in 1 session(s)', 'Calls that fail: `Bash` — 1×', 'Denied tool calls: Bash ×1'])
  })

  test('a missing logDir reads as an empty town', () => {
    const t = readLoopLog({ logDir: join(DIR, 'none'), root: '/code/ws', until: UNTIL })
    expect(t).toMatchObject({ attempts: [], events: [], spend: 0, review: null })
    expect(t.lanes.every(l => !l.busy && !l.exists)).toBe(true)
  })
})
