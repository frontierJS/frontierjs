// web/test/workers.test.js — `#workers` in the terminal: the file the
// PostToolUse hook writes per session and the workshop reads (`src/workers.js`).
//
// The hook runs after every edit in every session, so what can go wrong is
// quiet: a file outside the repo seating a session at a wrong bench, a
// session that ended standing at its bench for ever, a half-written file
// taking the workshop down. Each test hands the directory in; the module's
// own default is this machine's `~/.fli/haven/workers/`.
import { test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QUIET_MS, benchOf, readWorkers, recordWorker } from '../src/workers.js'

const ROOT = '/repo'
const base = mkdtempSync(join(tmpdir(), 'haven-workers-'))
let dir
beforeEach(() => { dir = mkdtempSync(join(base, 'w-')) })
afterAll(() => rmSync(base, { recursive: true, force: true }))

const edit = (session, file, now) => recordWorker({ session_id: session, tool_input: { file_path: file } }, { root: ROOT, dir, now })

test('a file is at the bench of its package, example/ at its own, the rest of the tree at frontierjs, outside it at none', () => {
  expect(benchOf('/repo/packages/junction/src/app.ts', ROOT)).toBe('junction')
  expect(benchOf('/repo/example/web/src/App.mesa', ROOT)).toBe('example')
  expect(benchOf('/repo/ISSUES.md', ROOT)).toBe('frontierjs')
  expect(benchOf('/repo/packages/README.md', ROOT)).toBe('frontierjs')
  expect(benchOf('/home/me/.claude/memory/x.md', ROOT)).toBe(null)
  expect(benchOf('/repo-two/packages/mesa/x.js', ROOT)).toBe(null)
})

test('an edit seats its session at the bench, and a later one moves it', () => {
  const t = Date.parse('2026-10-14T12:00:00Z')
  expect(edit('abc-123', '/repo/packages/mesa/src/x.js', t)).toEqual({ session: 'abc-123', bench: 'mesa', file: 'packages/mesa/src/x.js', at: '2026-10-14T12:00:00.000Z' })
  expect(readWorkers({ dir, now: t }).map((w) => w.bench)).toEqual(['mesa'])
  edit('abc-123', '/repo/packages/sierra/src/y.js', t + 1000)
  expect(readWorkers({ dir, now: t + 1000 })).toEqual([{ session: 'abc-123', bench: 'sierra', file: 'packages/sierra/src/y.js', at: t + 1000 }])
})

test('an edit outside the repo writes nothing, so the session stays at its bench', () => {
  const t = Date.now()
  edit('s1', '/repo/packages/ui/a.mesa', t)
  expect(edit('s1', '/elsewhere/notes.md', t + 1)).toBe(null)
  expect(readWorkers({ dir, now: t + 1 }).map((w) => w.bench)).toEqual(['ui'])
})

test('two sessions in one package are two workers at one bench', () => {
  const t = Date.now()
  edit('s1', '/repo/packages/junction/a.ts', t)
  edit('s2', '/repo/packages/junction/b.ts', t)
  expect(readWorkers({ dir, now: t }).map((w) => [w.session, w.bench])).toEqual([['s1', 'junction'], ['s2', 'junction']])
})

test('a session quiet past QUIET_MS has left, and its file is gone a day later at the next write', () => {
  const t = Date.now()
  edit('old', '/repo/packages/css/a.css', t)
  expect(readWorkers({ dir, now: t + QUIET_MS })).toHaveLength(1)
  expect(readWorkers({ dir, now: t + QUIET_MS + 1 })).toHaveLength(0)
  const day = 24 * 60 * 60 * 1000
  utimesSync(join(dir, 'old.json'), new Date(t - day - 1000), new Date(t - day - 1000))
  edit('new', '/repo/packages/css/b.css', t)
  expect(readdirSync(dir)).toEqual(['new.json'])
})

test('a half-written or foreign file is no worker, and a missing directory is none', () => {
  const t = Date.now()
  edit('s1', '/repo/packages/cli/a.js', t)
  writeFileSync(join(dir, 'torn.json'), '{"session":"to')
  writeFileSync(join(dir, 'other.json'), '{"hello":1}')
  expect(readWorkers({ dir, now: t }).map((w) => w.session)).toEqual(['s1'])
  expect(readWorkers({ dir: join(dir, 'nope'), now: t })).toEqual([])
})

test('a session id is a file name and nothing more', () => {
  edit('../../etc/passwd', '/repo/packages/cli/a.js', Date.now())
  expect(readdirSync(dir)).toEqual(['etcpasswd.json'])
})

// The hook is run by Claude Code on every edit in every session, so a
// failure inside it must never reach the session.
test('the hook seats a session through recordWorker, and exits 0 silent on input it cannot use', () => {
  const hook = join(import.meta.dir, '../../../../.claude/hooks/haven-worker.mjs')
  const home = mkdtempSync(join(base, 'home-'))
  const repo = join(import.meta.dir, '../../../..')
  const run = (stdin) => spawnSync('node', [hook], { input: stdin, env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: repo }, encoding: 'utf8' })
  const ok = run(JSON.stringify({ session_id: 'hook-1', tool_name: 'Edit', tool_input: { file_path: join(repo, 'packages/haven/web/src/stage.js') } }))
  expect({ code: ok.status, out: ok.stdout, err: ok.stderr }).toEqual({ code: 0, out: '', err: '' })
  expect(readWorkers({ dir: join(home, '.fli/haven/workers') }).map((w) => [w.session, w.bench, w.file])).toEqual([['hook-1', 'haven', 'packages/haven/web/src/stage.js']])
  for (const bad of ['', 'not json', '{}', JSON.stringify({ session_id: 'x' })]) {
    const r = run(bad)
    expect({ bad, code: r.status, out: r.stdout, err: r.stderr }).toEqual({ bad, code: 0, out: '', err: '' })
  }
})
