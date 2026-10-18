/**
 * web/test/verify-workshop.mjs — the workshop (`IDEAS/haven.md` Phase 11).
 * Started by `bun run verify:workshop`; needs no Chrome and no TTY of its own.
 *
 * Haven's API runs in this process over a fresh test database. Sam's machine
 * is a HOME of its own whose workers directory is filled through the real
 * PostToolUse hook (`.claude/hooks/haven-worker.mjs`): two sessions editing
 * the package whose bench is nearest the door, and one elsewhere. Sam is
 * Sierra's interactive shell under a pty, walks from the square's spawn
 * through the workshop's door, and sees the two at one bench with its count
 * and the third alone. He stands beside one and it is read out — the session,
 * the file, how long ago. Ana walks in by `fli haven --frame /workshop/` from
 * a HOME with no workers while Sam stands there: her frame draws Sam's
 * figure, so it is the same room, and none of Sam's workers, their count or
 * the reading — what is drawn from a workers directory stays on the screen
 * of the machine it is on. Then on Sam's screen a session moving to another
 * package walks to its bench, and one gone quiet past `QUIET_MS` leaves. The
 * one he stands beside is stopped on a permission prompt — through the same
 * hook, as a Notification — and is a `?` with its bench saying it waits on
 * him and the prompt read out; then it stops, a `✓` with its last words.
 *
 * Traps (the terminal's own are in `terminal.mjs`):
 * - Bun's `homedir()` is read once per process, so a workers directory is
 *   a child's HOME, never this process's.
 * - The workshop reads its directory every second, so a change written here
 *   is waited for on the screen, never assumed.
 * - A move past 10 a second is dropped by the server, so the walk waits for
 *   the figure at each cell before the next key.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../../api/src/app.ts'
import { ROOMS } from '../../api/src/rooms.ts'
import { signIn } from '../../api/test/sign-in.ts'
import { blank, cellOf, terminal, until } from './terminal.mjs'
import { stageOf } from './stage.mjs'
import { follow } from '../src/lib/scene/stage.js'
import { BENCH_WIDTH } from '../src/pieces/bench.js'
import { QUIET_MS, readWorkers } from '../src/lib/hash/workers.js'
import { SPIN } from '../src/lib/working.js'

const WEB      = join(import.meta.dir, '..')
const REPO     = join(WEB, '../../..')
const HOOK     = join(REPO, '.claude/hooks/haven-worker.mjs')
const FLI      = join(REPO, 'packages/cli/bin/fli.js')
const square   = await stageOf('Square')
const workshop = await stageOf('Workshop')

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}

// ─── Sam's machine ────────────────────────────────────────────────────

const samHome = mkdtempSync(join(tmpdir(), 'haven-sam-'))
const anaHome = mkdtempSync(join(tmpdir(), 'haven-ana-'))
const WORKERS = join(samHome, '.fli/haven/workers')

/** One event through the hook Claude Code runs, as session `id`. */
function hookRun(id, input) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ session_id: id, cwd: REPO, ...input }),
    env: { ...process.env, HOME: samHome, CLAUDE_PROJECT_DIR: REPO }, encoding: 'utf8',
  })
  if (r.status !== 0 || r.stdout || r.stderr) throw new Error(`the hook failed: ${r.status} ${r.stdout}${r.stderr}`)
}

/** One edit, as session `id` on `file` (repo-relative). */
const hookEdit = (id, file) => hookRun(id, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(REPO, file) } })

// The bench nearest where a figure comes in from the square, so the walk
// to it is short and inside the door's sight.
const door    = workshop.doors.find((d) => d.to === '/')
const benches = workshop.marks.filter((m) => m.piece?.bench)
const nearest = benches.reduce((a, b) => (Math.abs(b.x + 2 - door.x) + Math.abs(b.y - door.y) < Math.abs(a.x + 2 - door.x) + Math.abs(a.y - door.y) ? b : a))
// A bench Sam's first screen shows: the room is taller than a screen and the door is at its foot.
const v0      = workshop.view
const onFirst = (b) => b.y >= v0.y && b.y < v0.y + v0.h && b.x >= v0.x && b.x + b.piece.art.length <= v0.x + v0.w
const far     = benches.find((b) => onFirst(b) && b.y < nearest.y - 6)
const fileOf  = (bench) => (['example', 'frontierjs'].includes(bench) ? `${bench === 'example' ? 'example/' : ''}README.md` : `packages/${bench}/package.json`)
hookEdit('aaaa-one', fileOf(nearest.piece.bench))
hookEdit('bbbb-two', fileOf(nearest.piece.bench))
hookEdit('cccc-far', fileOf(far.piece.bench))
check(readWorkers({ dir: WORKERS }).map((w) => w.bench).join() === [nearest, nearest, far].map((b) => b.piece.bench).join(),
  `the hook seats three sessions in Sam's HOME: two at ${nearest.piece.bench}, one at ${far.piece.bench}`, JSON.stringify(readWorkers({ dir: WORKERS })))

// ─── Haven ────────────────────────────────────────────────────────────

const env = await createTestEnv({
  schema: join(WEB, '../db/schema.lite'),
  listen: true,
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-workshop', port: 0 }),
})
for (const room of ROOMS) await env.system.room.create({ data: { ...room } })
const API = `http://localhost:${env.port}`
const sam = await signIn(env.port, 'sam')
const term = terminal(API, sam.token, square, { HOME: samHome })
const at = (x, y, width = 1, stage = workshop, view = stage.view) => cellOf(term.screen(), x, y, width, stage, view)

// ─── Sam walks to the workshop ────────────────────────────────────────

const KEY = { '0,-1': '\x1b[A', '0,1': '\x1b[B', '1,0': '\x1b[C', '-1,0': '\x1b[D' }

/** The cells from `from` to `to` over floor, by breadth first; `to` may be a door. */
function route(stage, from, to) {
  const prev = new Map([[`${from.x},${from.y}`, null]])
  const queue = [from]
  while (queue.length) {
    const c = queue.shift()
    if (c.x === to.x && c.y === to.y) break
    for (const [dx, dy] of [[0, -1], [0, 1], [1, 0], [-1, 0]]) {
      const n = { x: c.x + dx, y: c.y + dy }
      const k = `${n.x},${n.y}`
      if (prev.has(k) || !(stage.walkable(n.x, n.y) || (n.x === to.x && n.y === to.y))) continue
      prev.set(k, c)
      queue.push(n)
    }
  }
  const cells = []
  for (let c = to; c; c = prev.get(`${c.x},${c.y}`)) cells.unshift(c)
  return cells[0]?.x === from.x && cells[0]?.y === from.y ? cells : null
}

/**
 * Walk Sam along `cells`, each key once the last step is on his screen; the last cell may be a door, waited on by `arrived`.
 * With an `eye`, the view his screen has is followed beside it, since a cell past the first screen is read through the
 * view that has panned to it.
 */
async function walk(stage, cells, arrived, eye = null) {
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1], b = cells[i]
    term.shell.stdin.write(KEY[`${b.x - a.x},${b.y - a.y}`])
    if (eye) eye.view = follow(eye.view, b, stage)
    const last = i === cells.length - 1
    if (!await until(() => (last && arrived ? arrived() : at(b.x, b.y, 1, stage, eye?.view) === '@'), 3000)) return false
  }
  return true
}

check(await until(() => term.screen().includes('j/k moves, Enter opens')), 'the shell lists the routes', term.screen())
term.shell.stdin.write('\r')
check(await until(() => at(square.spawn.x, square.spawn.y, 1, square) === '@'), 'Enter opens the square', term.screen())
const workshopDoor = square.doors.find((d) => d.to === '/workshop/')
const inside = { x: door.x, y: door.y - 1 }
check(await walk(square, route(square, square.spawn, workshopDoor),
  () => at(inside.x, inside.y) === '@' && term.screen().includes('The workshop · 1 here')),
  "the house beside the tavern's door is the workshop's, and Sam comes in beside the door back", term.screen())

// ─── the benches ──────────────────────────────────────────────────────

// A working session spins, so any of its frames is one.
const cooking = (g) => SPIN.includes(g)
const seat  = (bench, i) => ({ x: bench.x + 2 + 2 * i, y: bench.y + 1 })
const [s0, s1] = [seat(nearest, 0), seat(nearest, 1)]
const COUNT = '(! 2 here)'
check(await until(() => cooking(at(s0.x, s0.y)) && cooking(at(s1.x, s1.y)) && at(s1.x + 2, s1.y, COUNT.length) === COUNT),
  `two sessions in ${nearest.piece.bench} are two workers at its bench with its count, on Sam's screen from the door`, term.screen())
const f0 = seat(far, 0)
check(cooking(at(f0.x, f0.y)) && at(f0.x + 2, f0.y) !== '(', `the one at ${far.piece.bench} stands alone with no count`, term.screen())

const beside = { x: s0.x - 1, y: s0.y }
check(await walk(workshop, route(workshop, inside, beside)), 'Sam walks to stand beside the first worker', term.screen())
const READ = `aaaa ${fileOf(nearest.piece.bench)} · `
check(await until(() => at(s0.x, s0.y + 1, READ.length) === READ && /\d+s ago/.test(at(s0.x, s0.y + 1, READ.length + 8))),
  'standing beside it reads it: the session, the file it touched, how long ago', term.screen())

// ─── Ana, another terminal in the room ───────────────────────────────

const frame = await new Promise((resolve) => {
  const p = spawn('bun', [FLI, 'haven', '--frame', '/workshop/', '--api', API, '--nick', 'ana'], {
    cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: anaHome },
  })
  let framed = '', err = ''
  p.stdout.on('data', (d) => { framed += d })
  p.stderr.on('data', (d) => { err += d })
  p.on('exit', (code) => resolve({ code, framed, err }))
})
const anaAt = (x, y, width = 1) => cellOf(frame.framed, x, y, width, workshop)
check(frame.code === 0 && anaAt(beside.x, beside.y) === 'S' && frame.framed.includes('The workshop · 2 here'),
  "Ana's frame of the workshop is the same room: Sam's figure where he stands", frame.framed + frame.err)
check(!SPIN.slice(1).some((g) => frame.framed.includes(g)) && !frame.framed.includes('(!') && !frame.framed.includes('aaaa') && anaAt(nearest.x + nearest.piece.art.indexOf(` ${nearest.piece.bench} `) + 1, nearest.y, nearest.piece.bench.length) === nearest.piece.bench,
  "and none of Sam's workers, their count or the reading — the bench itself is drawn", frame.framed)

// ─── a session moves, a session goes quiet ───────────────────────────

const moved = benches.find((b) => b !== nearest && b !== far && onFirst(b))
hookEdit('cccc-far', fileOf(moved.piece.bench))
const m0 = seat(moved, 0)
check(await until(() => cooking(at(m0.x, m0.y)) && blank(at(f0.x, f0.y))),
  `a session that edits in ${moved.piece.bench} next walks from its bench to that one`, term.screen())

writeFileSync(join(WORKERS, 'bbbb-two.json'), JSON.stringify({
  session: 'bbbb-two', bench: nearest.piece.bench, file: fileOf(nearest.piece.bench), at: new Date(Date.now() - QUIET_MS - 1000).toISOString(),
}) + '\n')
check(await until(() => blank(at(s1.x, s1.y)) && cooking(at(s0.x, s0.y)) && !term.screen().includes(COUNT)),
  'a session quiet past QUIET_MS leaves its bench, and the count goes with it', term.screen())

// ─── a hand raised, then last words ──────────────────────────────────

const WHY = 'Claude needs your permission to use Bash'
const WAITS = '(? 1 waiting on you)'
hookRun('aaaa-one', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: WHY })
check(await until(() => at(s0.x, s0.y) === '?' && at(s0.x + 2, s0.y, WAITS.length) === WAITS && term.screen().includes(`aaaa asks: ${WHY} · `)),
  'a session stopped on a permission prompt is a ? whose bench says it waits on Sam, and beside it the prompt is read', term.screen())
hookRun('aaaa-one', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '**Booth sweep** fixed, 3 tests added.\n\nMore below.' })
check(await until(() => at(s0.x, s0.y) === '✓' && !term.screen().includes(WAITS) && term.screen().includes('aaaa done: Booth sweep fixed, 3 tests added. · ')),
  'when it stops it is a ✓, its hand down, and beside it its last words are read', term.screen())

// ─── the register, on the benches ─────────────────────────────────────

// Litestone has the most issues, so its piles are the tallest and its bench is
// in the row far below the door. Sam walks up to the aisle past its table,
// level with the top of its tallest pile, and the view pans up the room to it.
const { LEDGER } = await import('../src/lib/hash/ledger.data.js')
const lite = workshop.marks.find((m) => m.piece?.bench === 'litestone')
const pile = workshop.marks.find((m) => m.piece?.ledger === 'litestone')
const top = pile.piece.cells.reduce((a, c) => (c.dy < a.dy ? c : a))
const slip = { x: pile.x + top.dx, y: pile.y + top.dy }
const aisle = { x: lite.x + BENCH_WIDTH + 1, y: slip.y }
const there = route(workshop, beside, aisle)
const eye = { view: workshop.view }
check(there && await walk(workshop, there, null, eye),
  'Sam walks up the room to the aisle past litestone\'s table, level with its tallest pile, the view panning', term.screen())
check(await until(() => at(lite.x, lite.y, 1, workshop, eye.view) === '[' && at(slip.x, slip.y, 1, workshop, eye.view) === '━'),
  'litestone\'s bench and the top slip of its pile are on his screen, cell for cell through the view that panned to them', term.screen())
check(pile.piece.count === Object.values(LEDGER.litestone).reduce((a, b) => a + b, 0) && pile.y + pile.piece.art.split('\n').length === lite.y,
  'its piles hold one slip for each of its issues, lying on the bench', JSON.stringify(LEDGER.litestone))

// ─── done ─────────────────────────────────────────────────────────────

term.shell.stdin.write('\x03')
const code = await Promise.race([term.exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))])
check(code === 0, 'Ctrl+C exits 0', `exit: ${code}`)
if (code === 'timeout') term.shell.kill('SIGKILL')
await env.close()
rmSync(samHome, { recursive: true, force: true })
rmSync(anaHome, { recursive: true, force: true })

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
