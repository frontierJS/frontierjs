/*
 * test/sessions.test.ts — the session list and `findSession`, over real files in a temp config dir.
 */

import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeCwd, findSession, listSessions, titleOf } from '../index.ts'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const D = '44444444-4444-4444-8444-444444444444'
const E = '55555555-5555-4555-8555-555555555555'
const NOPE = '66666666-6666-4666-8666-666666666666'

let dir: string
const REPO = '/work/repo'
const OTHER = '/work/other'

const line = (cwd: string, prompt: string, entrypoint = 'claude-vscode') =>
  JSON.stringify({ type: 'user', cwd, entrypoint, sessionId: 's', timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: prompt } }) + '\n'

function put(folder: string, id: string, body: string, ageSeconds: number) {
  mkdirSync(join(dir, 'projects', folder), { recursive: true })
  const path = join(dir, 'projects', folder, `${id}.jsonl`)
  writeFileSync(path, body)
  const t = new Date(Date.now() - ageSeconds * 1000)
  utimesSync(path, t, t)
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-sessions-'))
  put(encodeCwd(REPO), A, line(REPO, 'older session\nsecond line'), 300)
  put(encodeCwd(REPO), B, line(REPO, 'newer session'), 100)
  put(encodeCwd(REPO), C, line(REPO, 'a machine run', 'sdk-cli'), 50)
  // `/work/repo` and `/work.repo` share a folder name; the recorded cwd says whose it is.
  put(encodeCwd(REPO), D, line('/work.repo', 'a lookalike folder'), 40)
  put(encodeCwd(OTHER), E, line(OTHER, 'elsewhere'), 30)
  put(encodeCwd(REPO), 'not-an-id', line(REPO, 'ignored'), 10)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('the list is this folder\'s own sessions, newest first, with no machine run and no held one', () => {
  const all = listSessions(REPO, { configDir: dir })
  expect(all.map(s => [s.session, s.title])).toEqual([[B, 'newer session'], [A, 'older session']])
  expect(listSessions(REPO, { configDir: dir, held: new Set([B]) }).map(s => s.session)).toEqual([A])
  expect(listSessions(REPO, { configDir: dir, limit: 1 }).map(s => s.session)).toEqual([B])
  expect(listSessions('/nowhere', { configDir: dir })).toEqual([])
})

test('findSession returns the path and title of a session that ran here', () => {
  const r = findSession(REPO, A, { configDir: dir })
  if (!r.ok) throw new Error(r.reason)
  expect(r.value.session).toBe(A)
  expect(r.value.path).toBe(join(dir, 'projects', encodeCwd(REPO), `${A}.jsonl`))
  expect(r.value.title).toBe('older session')
  expect(r.value.startedAt).toBe('2026-11-01T10:00:00Z')
})

test('findSession refuses by name', () => {
  const why = (s: unknown, cwd = REPO) => { const r = findSession(cwd, s, { configDir: dir }); return r.ok ? '' : r.reason }
  expect(why('nope')).toBe("'nope' is not a session id")
  expect(why(undefined)).toBe("'' is not a session id")
  expect(why(NOPE)).toBe(`no session '${NOPE}' in Claude Code's history on this machine`)
  expect(why(E)).toContain(`that session ran in ${OTHER}, not ${REPO}`)
  expect(why(E)).toContain('Claude Code resumes a session only from the folder it started in')
  put(encodeCwd(REPO), NOPE, '{"type":"summary"}\n', 5)
  expect(why(NOPE)).toBe(`session '${NOPE}' records no folder to resume it in`)
})

test('a title is the first line, cut at 60', () => {
  expect(titleOf('  one\ntwo')).toBe('one')
  expect(titleOf('x'.repeat(80))).toBe(`${'x'.repeat(59)}…`)
})
