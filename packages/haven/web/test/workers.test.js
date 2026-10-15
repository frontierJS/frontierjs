// web/test/workers.test.js — `#workers` in the terminal: the file the
// hook writes per session and the workshop reads (`src/workers.js`).
//
// The hook runs on every tool in every session, so what can go wrong is
// quiet: a file outside the repo seating a session at a wrong bench, a
// session that ended standing at its bench for ever, a hand left raised
// after the prompt was answered, an idle notice wiping a session's last
// words, a half-written file taking the workshop down. Each test hands the directory in; the module's
// own default is this machine's `~/.fli/haven/workers/`.
import { test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QUIET_MS, WORDS, benchOf, lastWords, readWorkers, recordWorker } from '../src/workers.js'

const ROOT = '/repo'
const base = mkdtempSync(join(tmpdir(), 'haven-workers-'))
let dir
beforeEach(() => { dir = mkdtempSync(join(base, 'w-')) })
afterAll(() => rmSync(base, { recursive: true, force: true }))

const edit = (session, file, now) => recordWorker({ session_id: session, tool_input: { file_path: file } }, { root: ROOT, dir, now })
const hook = (session, event, now, more = {}) => recordWorker({ session_id: session, hook_event_name: event, cwd: ROOT, ...more }, { root: ROOT, dir, now })
const one = (now) => readWorkers({ dir, now })[0] ?? null

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
  expect(edit('abc-123', '/repo/packages/mesa/src/x.js', t)).toEqual({ session: 'abc-123', bench: 'mesa', file: 'packages/mesa/src/x.js', at: '2026-10-14T12:00:00.000Z', seen: '2026-10-14T12:00:00.000Z' })
  expect(readWorkers({ dir, now: t }).map((w) => w.bench)).toEqual(['mesa'])
  edit('abc-123', '/repo/packages/sierra/src/y.js', t + 1000)
  expect(readWorkers({ dir, now: t + 1000 })).toEqual([{ session: 'abc-123', bench: 'sierra', file: 'packages/sierra/src/y.js', at: t + 1000, seen: t + 1000, asking: null, said: null }])
})

test('an edit outside the repo moves nothing, so the session stays at its bench and file', () => {
  const t = Date.now()
  edit('s1', '/repo/packages/ui/a.mesa', t)
  edit('s1', '/elsewhere/notes.md', t + 1)
  expect(readWorkers({ dir, now: t + 1 }).map((w) => [w.bench, w.file])).toEqual([['ui', 'packages/ui/a.mesa']])
  expect(edit('s2', '/elsewhere/notes.md', t)).toBe(null)
})

test('a permission prompt raises the hand, and the next tool lowers it', () => {
  const t = Date.now()
  edit('s1', '/repo/packages/litestone/src/a.js', t)
  hook('s1', 'Notification', t + 1, { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
  expect(one(t + 1).asking).toEqual({ why: 'Claude needs your permission to use Bash', at: t + 1 })
  hook('s1', 'PostToolUse', t + 2, { tool_name: 'Bash', tool_input: { command: 'ls' } })
  expect([one(t + 2).asking, one(t + 2).bench, one(t + 2).at]).toEqual([null, 'litestone', t])
})

test('a hand stays raised past QUIET_MS, since the session is waiting on you; a quiet one without is gone', () => {
  const t = Date.now()
  edit('quiet', '/repo/packages/css/a.css', t)
  edit('asks', '/repo/packages/css/b.css', t)
  hook('asks', 'Notification', t, { notification_type: 'elicitation_dialog', message: '' })
  expect(readWorkers({ dir, now: t + QUIET_MS * 6 }).map((w) => [w.session, w.asking?.why])).toEqual([['asks', 'elicitation_dialog']])
})

test('a stop leaves its last words, an idle notice after it keeps them, and the next prompt drops them', () => {
  const t = Date.now()
  edit('s1', '/repo/packages/junction/a.ts', t)
  hook('s1', 'Stop', t + 1, { last_assistant_message: '## Done\n\n**Booth sweep** fixed, 3 tests added.' })
  expect(one(t + 1).said).toEqual({ text: 'Done', at: t + 1 })
  expect(hook('s1', 'Notification', t + 2, { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })).toBe(null)
  expect(one(t + 2).said?.text).toBe('Done')
  hook('s1', 'UserPromptSubmit', t + 3, { prompt: 'next' })
  expect([one(t + 3).said, one(t + 3).seen]).toEqual([null, t + 3])
})

test('a session that has edited nothing is seated where it was started, and an event with nothing to say writes nothing', () => {
  const t = Date.now()
  expect(hook('s1', 'UserPromptSubmit', t)).toBe(null)
  hook('s1', 'Notification', t, { notification_type: 'permission_prompt', message: 'May I?' })
  hook('s2', 'Stop', t, { cwd: '/repo/packages/haven', last_assistant_message: 'All passed.' })
  expect(readWorkers({ dir, now: t }).map((w) => [w.session, w.bench, w.file, w.at])).toEqual([['s1', 'frontierjs', '', null], ['s2', 'haven', '', null]])
  expect(hook('s3', 'Stop', t, { cwd: '/elsewhere', last_assistant_message: 'hi' })).toBe(null)
})

test('the session ending takes it from its bench, hand and all', () => {
  const t = Date.now()
  hook('s1', 'Notification', t, { notification_type: 'permission_prompt', message: 'May I?' })
  hook('s1', 'SessionEnd', t + 1, { reason: 'prompt_input_exit' })
  expect(readdirSync(dir)).toEqual([])
})

test('last words are the first line that says something, without markdown, cut to WORDS', () => {
  expect(lastWords('\n\n> **All** `12` passed\nmore')).toBe('All 12 passed')
  expect(lastWords('- [x] done')).toBe('[x] done')
  expect(lastWords(undefined)).toBe('')
  const long = lastWords('x'.repeat(500))
  expect([long.length, long.endsWith('…')]).toEqual([WORDS, true])
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
  const asked = run(JSON.stringify({ session_id: 'hook-1', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash', cwd: repo }))
  expect({ code: asked.status, out: asked.stdout, err: asked.stderr }).toEqual({ code: 0, out: '', err: '' })
  expect(readWorkers({ dir: join(home, '.fli/haven/workers') })[0].asking?.why).toBe('Claude needs your permission to use Bash')
  for (const bad of ['', 'not json', '{}', JSON.stringify({ session_id: 'x' })]) {
    const r = run(bad)
    expect({ bad, code: r.status, out: r.stdout, err: r.stderr }).toEqual({ bad, code: 0, out: '', err: '' })
  }
})
