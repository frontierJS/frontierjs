/**
 * web/test/verify-townhall.mjs — the town hall in session (`IDEAS/haven.md`
 * Phase 15). Started by `bun run verify:townhall`; needs no Chrome and no TTY
 * of its own.
 *
 * Haven's API runs in this process over a fresh test database. Sam and Ana
 * each walk from the square's spawn through the town hall's door and up to
 * the same delegate, the one nearest the door, from either side. Standing there each
 * reads who the delegate is and the idea's count; Sam's `/aye` is read on
 * ANA's screen with nothing typed there (the hall is told, and her screen asks
 * the count again), then his `/nay` changes it and `/withdraw` takes it back.
 * Away from every delegate a vote is refused with where to stand, and an aye
 * carried up the hall is on the board of the most wanted at its top.
 *
 * Traps (the terminal's own are in `terminal.mjs`):
 * - A scene opens in NORMAL, so the first `/` command is typed after an `i`,
 *   and an arrow typed in INSERT moves nothing: Esc first.
 * - The hall is taller than a screen, so a cell is never read off the screen
 *   here; the drive reads what a delegate says, which is drawn wherever the
 *   view is.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../../api/src/app.ts'
import { ROOMS } from '../../api/src/rooms.ts'
import { POST_KEY, signIn } from '../../api/test/sign-in.ts'
import { terminal, until } from './terminal.mjs'
import { stageOf } from './stage.mjs'
import { arrival } from '../src/lib/scene/stage.js'
import { nameOf } from '../src/lib/hash/townhall.js'

const WEB  = join(import.meta.dir, '..')
const hall = await stageOf('TownHall')
const square = await stageOf('Square')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}

// ─── Haven ────────────────────────────────────────────────────────────

const env = await createTestEnv({
  schema: join(WEB, '../db/schema.lite'),
  listen: true,
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-townhall', port: 0, postKey: POST_KEY }),
})
for (const room of ROOMS) await env.system.room.create({ data: { ...room } })
const API = `http://localhost:${env.port}`
const sam = await signIn(env.port, 'sam')
const ana = await signIn(env.port, 'ana')
const homes = [mkdtempSync(join(tmpdir(), 'haven-sam-')), mkdtempSync(join(tmpdir(), 'haven-ana-'))]

// The delegate nearest the door: the lowest row's first.
const heads = hall.marks.filter((m) => m.piece?.idea).map((m) => ({ idea: m.piece.idea, ...m.spot('head') }))
const near = heads.reduce((a, b) => (b.y > a.y || (b.y === a.y && b.x < a.x) ? b : a))
const top  = heads.reduce((a, b) => (b.y < a.y || (b.y === a.y && b.x < a.x) ? b : a))
const who  = nameOf(near.idea)

const KEY = { '0,-1': '\x1b[A', '0,1': '\x1b[B', '1,0': '\x1b[C', '-1,0': '\x1b[D' }

/** The cells from `from` to `to` over `stage`'s floor, by breadth first; `to` may be a door. */
function route(from, to, stage = hall) {
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
  return cells
}

const door  = square.doors.find((d) => d.to === '/townhall/')
const inside = arrival(hall, { from: '/', x: door.x, y: door.y })

/** A terminal opened on the square, walked through the town hall's door. */
async function open(member, home) {
  const term = terminal(API, member.token, square, { HOME: home })
  await until(() => term.screen().includes('j/k moves, Enter opens'))
  term.shell.stdin.write('\r')
  await until(() => term.screen().includes('The square · '))
  await walk(term, square.spawn, door, square)
  return term
}

/** Walks `term`'s figure from `from` to `to`, a step at a time under the room's move rate. */
async function walk(term, from, to, stage = hall) {
  if (!term.screen().includes('-- NORMAL')) { term.shell.stdin.write('\x1b'); await sleep(80) }
  const cells = route(from, to, stage)
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1], b = cells[i]
    term.shell.stdin.write(KEY[`${b.x - a.x},${b.y - a.y}`])
    await sleep(120)
  }
  return cells.length > 1 && cells.at(-1).x === to.x && cells.at(-1).y === to.y
}

const say = (term, line) => term.shell.stdin.write(`${term.screen().includes('-- NORMAL') ? 'i' : ''}${line}\r`)

async function quit(term) {
  term.shell.stdin.write('\x03')
  const code = await Promise.race([term.exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))])
  if (code === 'timeout') term.shell.kill('SIGKILL')
  return code
}

// ─── walking up ───────────────────────────────────────────────────────

const s = await open(sam, homes[0])
check(await until(() => s.screen().includes('The town hall · 1 here')), 'Sam walks from the square through the town hall\'s door', s.screen())

say(s, '/aye')
check(await until(() => s.screen().includes('walk up to a delegate first')), 'at the door, /aye says to walk up to a delegate first', s.screen())

const left = { x: near.x - 1, y: near.y }, right = { x: near.x + 1, y: near.y }
check(await walk(s, inside, left), `Sam walks to the left of ${who}, for ${near.idea}`)
const intro = `${who}, for ${near.idea}:`
check(await until(() => s.screen().includes(intro) && s.screen().includes('aye 0 nay 0 · /aye or /nay')),
  'beside them, the delegate says who they are, the idea, and nobody has voted', s.screen())

const a = await open(ana, homes[1])
check(await until(() => a.screen().includes('The town hall · 2 here')), 'Ana walks in after him', a.screen())
await walk(a, inside, right)
check(await until(() => a.screen().includes(intro) && a.screen().includes('aye 0 nay 0')), 'Ana stands on the other side and reads the same', a.screen())

// ─── voting ───────────────────────────────────────────────────────────

say(s, '/aye')
check(await until(() => s.screen().includes('aye 1 nay 0 · you said aye')), 'Sam\'s /aye is his, and counted', s.screen())
check(await until(() => a.screen().includes('aye 1 nay 0 · /aye or /nay')), 'and Ana\'s screen counts it with nothing typed there', a.screen())

say(s, '/nay')
check(await until(() => a.screen().includes('aye 0 nay 1')), 'his /nay changes the vote on her screen, not adds one', a.screen())

say(a, '/aye')
check(await until(() => s.screen().includes('aye 1 nay 1 · you said nay')), 'Ana\'s /aye reaches Sam\'s screen beside his own nay', s.screen())

say(s, '/withdraw')
check(await until(() => s.screen().includes('aye 1 nay 0 · /aye or /nay') && a.screen().includes('aye 1 nay 0 · you said aye')),
  '/withdraw takes his back on both screens', `${s.screen()}\n---\n${a.screen()}`)

// ─── the board ────────────────────────────────────────────────────────

// The view keeps the figure `EDGE` rows from its top, so the board is read
// from the row of floor above it.
check(await walk(s, left, { x: top.x, y: 1 }), 'Sam walks up the hall past the board, to the floor above it')
check(await until(() => s.screen().includes(`${near.idea.padEnd(6)}+1`)), `the board of the most wanted carries ${near.idea} at +1`, s.screen())

check(await quit(s) === 0 && await quit(a) === 0, 'both terminals exit 0 on Ctrl+C')

// ─── done ─────────────────────────────────────────────────────────────

await env.close()
for (const d of homes) rmSync(d, { recursive: true, force: true })

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
