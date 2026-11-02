// What the Atlas screen hands Claude (api domain/atlas/atlas.ts) — the prompt
// per intent, and the refusals that keep `fix` and `frame` to one id of the
// kind their skill works on. Pure: the atlas is a literal, no fli, no disk.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join }   from 'node:path'

import { composePrompt, namedIds, branchSlug, explainPrompt, readAutopilot, registerRoot, type Atlas, type Queued } from '../src/domain/atlas/atlas.ts'
import { startEntry, runningOf, dueAt, tickSince, tick, readTick, TICK_MS } from '../src/domain/atlas/autopilot-run.ts'

const at = (file: string, line: number) => ({ file, line, href: file, edit: '' })

const atlas = {
  name: 'ws', prefix: 'FJS', dir: '.', sources: [], sections: ['Access control'], ready: [], blocked: [],
  issues: [
    { id: 'FJS-12', aliases: ['FJS-9'], pkg: ['junction'], title: 'A retry writes twice', status: 'open', severity: 'S2',
      verified: '', closed: false, body: '', refs: [], blockedBy: [], rank: null, links: [], at: at('ISSUES.md', 40) },
    { id: 'FJS-13', aliases: [], pkg: ['mesa'], title: 'Closed one', status: 'closed', severity: 'S3',
      verified: '', closed: true, body: '', refs: [], blockedBy: [], rank: null, links: [], at: at('ISSUES.md', 90) },
  ],
  rulings:   [{ id: 'FJS-D4', date: '2026-01-01', section: 'Access control', title: 'Gates live in the schema', status: '',
                supersededBy: null, body: '', refs: [], links: [], at: at('DECISIONS.md', 7) }],
  questions: [{ id: 'paper:cross-origin', source: 'idea', question: 'Cross-origin.', state: 'decidable',
                options: [{ letter: 'A', text: 'a' }, { letter: 'B', text: 'b' }], recommend: { letter: 'B', why: 'w' },
                paper: 'paper', at: at('IDEAS/paper.md', 12) }],
  ideas: [],
} as unknown as Atlas

describe('namedIds', () => {
  test('ids the registers hold, an alias and a paper question among them; an unknown id is dropped', () => {
    expect(namedIds(atlas, 'see fjs-9, FJS-D4 and FJS-404, then paper:cross-origin'))
      .toEqual(['FJS-9', 'FJS-D4', 'paper:cross-origin'])
  })
})

describe('composePrompt', () => {
  test('discuss carries the text, cites each named record at its line, and asks for no edits', () => {
    const out = composePrompt(atlas, { text: 'FJS-12 still bites', intent: 'discuss' })
    if ('refused' in out) throw new Error(out.refused)
    expect(out.prompt.startsWith('FJS-12 still bites')).toBe(true)
    expect(out.prompt).toContain('- FJS-12 — issue, S2, open (ISSUES.md:40): A retry writes twice')
    expect(out.prompt).toContain('Change no file')
    expect(out.prompt).toContain('fli register:find')
  })

  test('file says how to write it down and nothing else', () => {
    const out = composePrompt(atlas, { text: 'Toasts stack forever', intent: 'file' })
    if ('refused' in out) throw new Error(out.refused)
    expect(out.prompt).toContain('fli register:file --sev')
    expect(out.prompt).toContain('Change no source file')
    expect(out.ids).toEqual([])
  })

  test('fix is the fix-next skill on one open row, with the rest of the text as notes', () => {
    const out = composePrompt(atlas, { text: 'FJS-12 — only on retry', intent: 'fix' })
    if ('refused' in out) throw new Error(out.refused)
    expect(out.prompt).toBe('/fix-next FJS-12 --ask\n\nFrom the person who sent it:\n\n— only on retry')
  })

  test('fix refuses a closed row, no row, and two rows', () => {
    expect(composePrompt(atlas, { text: 'FJS-13', intent: 'fix' })).toEqual({ refused: expect.stringMatching(/open row/) })
    expect(composePrompt(atlas, { text: 'it is broken', intent: 'fix' })).toEqual({ refused: expect.stringMatching(/open row/) })
    expect(composePrompt({ ...atlas, issues: [atlas.issues[0], { ...atlas.issues[0], id: 'FJS-14', aliases: [] }] }, { text: 'FJS-12 FJS-14', intent: 'fix' }))
      .toEqual({ refused: expect.stringMatching(/names FJS-12, FJS-14/) })
  })

  test('frame is the frame-next skill on one open question', () => {
    expect(composePrompt(atlas, { text: 'paper:cross-origin', intent: 'frame' })).toEqual({ ids: ['paper:cross-origin'], prompt: '/frame-next paper:cross-origin' })
    expect(composePrompt(atlas, { text: 'FJS-12', intent: 'frame' })).toEqual({ refused: expect.stringMatching(/open question/) })
  })

  test('an empty text and an unknown intent are refused by name', () => {
    expect(composePrompt(atlas, { text: '  ', intent: 'discuss' })).toEqual({ refused: expect.stringMatching(/paste/) })
    expect(composePrompt(atlas, { text: 'x', intent: 'ship' })).toEqual({ refused: expect.stringMatching(/'ship' is not one of/) })
  })
})

describe('branchSlug', () => {
  test('from the first id, lowercased, stepping past a branch that exists', () => {
    expect(branchSlug(['FJS-12'], () => false)).toBe('fjs-12')
    expect(branchSlug(['paper:cross-origin'], () => false)).toBe('paper-cross-origin')
    expect(branchSlug(['FJS-12'], s => s === 'fjs-12' || s === 'fjs-12-2')).toBe('fjs-12-3')
    expect(branchSlug([], () => false)).toBe('discuss')
  })
})

describe('explainPrompt', () => {
  const q: Queued = {
    id: 'paper:cross-origin', question: 'Cross-origin.', body: 'The store is on another origin.',
    options: [{ letter: 'A', text: 'a list of origins' }, { letter: 'B', text: 'any origin, a scoped token' }],
    recommend: { letter: 'B', qualifier: null, why: 'a wildcard grants nothing without a credential' },
    paper: 'paper', status: 'proposed', file: 'IDEAS/paper.md', line: 12,
  }

  test('the question as argued — id at its line, prose, every option and the recommendation', () => {
    const p = explainPrompt(q)
    expect(p).toContain('paper:cross-origin — IDEAS/paper.md:12')
    expect(p).toContain('**Cross-origin.** The store is on another origin.')
    expect(p).toContain('- **A** — a list of origins')
    expect(p).toContain('- **Recommend B** — a wildcard grants nothing without a credential')
    // A qualified recommendation reaches the agent whole, or it argues for all of B.
    const narrowed = explainPrompt({ ...q, recommend: { ...q.recommend!, qualifier: 'B, read-only' } })
    expect(narrowed).toContain('- **Recommend B, read-only** — a wildcard')
    expect(p).toContain('You are read-only')
  })

  test('a question with no recommendation says so rather than inventing one', () => {
    expect(explainPrompt({ ...q, recommend: null })).toContain('No recommendation is written.')
  })
})

// The town reads the real logs and registers, so its shape is asserted off this
// workspace and not a literal; skipped where the cli is not installed beside the API.
describe('readAutopilot', async () => {
  const root = await registerRoot().catch(() => null)

  test.skipIf(!root)('answers every key the town draws, and the counts agree with the lists', async () => {
    const t = await readAutopilot(root!)
    expect(Object.keys(t).sort()).toEqual([
      'attempts', 'ci', 'council', 'counts', 'dock', 'events', 'frame', 'lanes', 'plans', 'registry', 'review', 'spend', 'switch', 'window',
    ])
    expect(t.lanes.map(l => l.id)).toEqual(['lane.1', 'lane.2', 'lane.3', 'lane.4', 'lane.5'])
    expect(t.registry.ready.top.length).toBeLessThanOrEqual(40)
    expect(t.registry.ready.top.length).toBeLessThanOrEqual(t.registry.ready.count)
    expect(t.registry.busy.count).toBe(t.lanes.filter(l => l.busy).length)
    expect(t.council.bench.length).toBeLessThanOrEqual(12)
    expect(t.plans.papers.every(p => p.next !== null)).toBe(true)
    expect(Date.parse(t.window.end) - Date.parse(t.window.start)).toBe(864e5)
    expect(t.switch).toMatchObject({ file: '~/.fli/autopilot.json', on: expect.any(Boolean), entries: expect.any(Array), spent: { attempts: expect.any(Number), dollars: expect.any(Number) }, missing: expect.any(Array) })
    expect(t.switch.refused === null || t.switch.entries.length === 0).toBe(true)
  }, 30_000)
})

// A Run now is a spawn of the entry's script with its flags; the script here
// is a stand-in that prints its argv, since the real one opens a lane and pays
// for a session.
describe('startEntry', () => {
  test('spawns the script beside the registers with the entry\'s flags, refuses a second start while it runs, and names what is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autopilot-run-'))
    mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'scripts', 'echo-loop.mjs'), 'console.log(process.argv.slice(2).join(" ")); await new Promise(r => setTimeout(r, 300))\n')
    const loops   = { fix: { script: 'scripts/echo-loop.mjs' }, frame: { script: 'scripts/none.mjs' } }
    const entries = [
      { loop: 'fix',   cron: '* * * * *', caps: { rows: 1 }, flags: ['--rows', '1', '--source', 'autopilot'], worst: null },
      { loop: 'frame', cron: '* * * * *', caps: {},          flags: ['--source', 'autopilot'],               worst: null },
    ]
    try {
      const out = startEntry(root, loops, entries, 0, process.env, { outDir: join(root, 'out') })
      if (!('started' in out)) throw new Error(out.refused)
      // On a copy: bun's toMatchObject writes an expect.any matcher into the object it matched, and this one is the module's own record.
      expect({ ...out.started }).toMatchObject({ loop: 'fix', pid: expect.any(Number), log: join(root, 'out', 'fix-1.log') })
      expect(runningOf(0)?.pid).toBe(out.started.pid)
      expect(startEntry(root, loops, entries, 0, process.env, { outDir: join(root, 'out') })).toMatchObject({ refused: expect.stringMatching(/entry 1 \(fix\) is already running \(pid \d+\)/) })
      expect(startEntry(root, loops, entries, 1, process.env, { outDir: join(root, 'out') })).toMatchObject({ refused: expect.stringContaining('scripts/none.mjs is not beside the registers') })
      expect(startEntry(root, loops, entries, 5, process.env, { outDir: join(root, 'out') })).toMatchObject({ refused: 'the schedule has no entry 6; it lists 2' })
      const end = Date.now() + 5_000
      while (runningOf(0) && Date.now() < end) await new Promise(r => setTimeout(r, 50))
      expect(runningOf(0)).toBeNull()
      const log = readFileSync(out.started.log, 'utf8')
      expect(log.split('\n')[0]).toContain('$ bun scripts/echo-loop.mjs --rows 1 --source autopilot')
      expect(log).toContain('\n--rows 1 --source autopilot\n')
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 10_000)
})

describe('tick', () => {
  const local = (h: number, m: number) => { const d = new Date(2026, 10, 2, h, m, 0, 0); return d }

  test('an entry is due when its cron names a local minute after the last tick and up to now, and not before', () => {
    expect(dueAt('0 1 * * *', local(0, 55), local(1, 0))).toBe(true)
    expect(dueAt('0 1 * * *', local(0, 55), local(0, 59))).toBe(false)
    expect(dueAt('0 1 * * *', local(1, 0), local(1, 5))).toBe(false)
    expect(dueAt('*/5 * * * *', local(1, 1), local(1, 6))).toBe(true)
    expect(dueAt('0 1 * * 0', local(0, 55), local(1, 0))).toBe(false)
  })

  test('the window starts at the last tick, or five minutes ago with none or a stale one', () => {
    const now = local(1, 0)
    expect(tickSince(null, now).getTime()).toBe(now.getTime() - TICK_MS)
    expect(tickSince({ at: local(0, 55).toISOString(), since: '', started: [], skipped: [] }, now).getTime()).toBe(local(0, 55).getTime())
    expect(tickSince({ at: new Date(2026, 9, 1).toISOString(), since: '', started: [], skipped: [] }, now).getTime()).toBe(now.getTime() - TICK_MS)
  })

  test('a pass starts what is due, skips the cap and held lanes by name, and writes its record', () => {
    const outDir  = mkdtempSync(join(tmpdir(), 'autopilot-tick-'))
    const entries = [
      { loop: 'fix',   cron: '0 1 * * *', caps: { rows: 1, lanes: 2 }, flags: [], worst: null },
      { loop: 'frame', cron: '0 1 * * *', caps: { rows: 1 },           flags: [], worst: null },
      { loop: 'fix',   cron: '0 3 * * *', caps: { rows: 1, lanes: 1 }, flags: [], worst: null },
    ]
    const starts: number[] = []
    const start = ((_root: string, _loops: unknown, _entries: unknown, i: number) => { starts.push(i); return { started: { loop: 'x', pid: 100 + i, at: '', log: '' } } }) as typeof startEntry
    const base = { root: '/r', loops: {}, entries, env: {}, since: local(0, 55), now: local(1, 0), start, outDir }
    try {
      const out = tick({ ...base, cap: null, freeLanes: 1 })
      expect(out.started).toEqual([{ entry: 2, loop: 'frame', pid: 101 }])
      expect(out.skipped).toEqual([{ entry: 1, loop: 'fix', why: '2 lanes asked, 1 free' }])
      expect(starts).toEqual([1])
      expect(readTick(outDir)).toEqual(out)

      const capped = tick({ ...base, cap: "today's $20 reaches the day's cap of $20", freeLanes: 5 })
      expect(capped.started).toEqual([])
      expect(capped.skipped.map(s => s.entry)).toEqual([1, 2])
      expect(capped.skipped[0].why).toMatch(/day's cap/)
    } finally { rmSync(outDir, { recursive: true, force: true }) }
  })
})
