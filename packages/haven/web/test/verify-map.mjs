/**
 * web/test/verify-map.mjs — the map (`IDEAS/haven.md` 6.4).
 * Started by `bun run verify:map`; needs no Chrome and no TTY of its own.
 *
 * Haven's API runs in this process over a fresh test database. Sam is
 * Sierra's interactive shell under a pty with a HOME of his own. In the square
 * `/map` draws the square alone and him on it; Esc closes it. He walks through
 * the tavern's door and `/map` draws both, the square beside no street he has
 * not walked into, and the `@` in the tavern's block. Then Sam's terminal
 * closes and another opens in the same HOME, in the square: it draws the
 * tavern too, since this machine has been in it, from the file at
 * `~/.fli/haven/seen/`; a third in a HOME that has walked nowhere draws the
 * square alone — what a machine has seen is not the server's to say.
 *
 * Traps (the terminal's own are in `terminal.mjs`):
 * - The map pane sits at cell 1,1 of the art's box, so a map cell is read at
 *   the art's left and top plus one — the same rule `cellOf` uses for a stage.
 * - Bun's `homedir()` is read once per process, so a machine's HOME is a
 *   child's, never this process's.
 * - The pane covers the figure, so the only `@` it leaves is the map's own and
 *   the footer's `@ you`.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../../api/src/app.ts'
import { ROOMS } from '../../api/src/rooms.ts'
import { POST_KEY, signIn } from '../../api/test/sign-in.ts'
import { terminal, until } from './terminal.mjs'
import { stageOf } from './stage.mjs'
import { SCALE, coarse, layoutOf } from '../src/lib/scene/map.js'

const WEB    = join(import.meta.dir, '..')
const square = await stageOf('Square')
const tavern = await stageOf('Tavern')

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}

const homes = [mkdtempSync(join(tmpdir(), 'haven-map-sam-')), mkdtempSync(join(tmpdir(), 'haven-map-bea-'))]
const SEEN  = join(homes[0], '.fli/haven/seen')

// ─── Haven ────────────────────────────────────────────────────────────

const env = await createTestEnv({
  schema: join(WEB, '../db/schema.lite'),
  listen: true,
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-map', port: 0, postKey: POST_KEY }),
})
for (const room of ROOMS) await env.system.room.create({ data: { ...room } })
const API = `http://localhost:${env.port}`
const sam = await signIn(env.port, 'sam')

const MAP = '— the map · @ you'

/** The map's rows as drawn on `screen`, and where its cell `mx, my` is on it; null with no map open. */
function mapOf(screen) {
  const lines  = screen.split('\n')
  const footer = lines.findIndex((l) => l.includes(MAP))
  const status = lines.findIndex((l) => / · \d+ here\b/.test(l))
  if (footer === -1 || status === -1) return null
  const left = lines[status].search(/\S/)
  const top  = status - Math.min(26, square.height)
  return { lines, left: left + 1, top: top + 1, footer }
}
/** Where an `@` stands in the map's rows, as a map cell; the footer's own is not one. */
function marked(screen) {
  const m = mapOf(screen)
  if (!m) return []
  const out = []
  m.lines.forEach((l, row) => {
    if (row === m.footer) return
    for (let i = l.indexOf('@'); i !== -1; i = l.indexOf('@', i + 1)) out.push({ x: i - m.left, y: row - m.top })
  })
  return out
}

// ─── walking ──────────────────────────────────────────────────────────

const KEY = { '0,-1': '\x1b[A', '0,1': '\x1b[B', '1,0': '\x1b[C', '-1,0': '\x1b[D' }

/** The cells from `from` to `to` over floor by breadth first; `to` may be a door. */
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

/** Walk `term` along `cells`, a key once the last step is on its screen; the last cell is a door, waited on by `arrived`. */
async function walk(term, stage, cells, arrived) {
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1], b = cells[i]
    term.shell.stdin.write(KEY[`${b.x - a.x},${b.y - a.y}`])
    if (!await until(() => (i === cells.length - 1 ? arrived() : term.at(b.x, b.y, 1, stage) === '@'), 3000)) return false
  }
  return true
}

/** A terminal in `home`, in the square. */
async function enter(home) {
  const term = terminal(API, sam.token, square, { HOME: home })
  await until(() => term.screen().includes('j/k moves, Enter opens'))
  term.shell.stdin.write('\r')
  const ok = await until(() => term.at(square.spawn.x, square.spawn.y, 1, square) === '@')
  return { term, ok }
}
const quit = async (term) => {
  term.shell.stdin.write('\x03')
  const code = await Promise.race([term.exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))])
  if (code === 'timeout') term.shell.kill('SIGKILL')
  return code
}
// A scene opens in NORMAL, so a line starts with `i`.
const open = async (term) => {
  term.shell.stdin.write('i')
  if (!await until(() => term.screen().includes('-- INSERT --'))) return false
  term.shell.stdin.write('/map\r')
  return until(() => mapOf(term.screen()))
}
const labels = (screen) => ['square', 'woods', 'road', 'docks', 'tavern', 'workshop'].filter((s) => {
  const m = mapOf(screen)
  return m && m.lines.slice(m.top, m.footer).some((l) => l.includes(s))
})

// ─── Sam in the square ────────────────────────────────────────────────

const first = await enter(homes[0])
check(first.ok, 'Sam walks into the square', first.term.screen())
check(mapOf(first.term.screen()) === null, 'no map is drawn until it is asked for', first.term.screen())
check(await open(first.term), '/map opens the map over the art', first.term.screen())

const alone = layoutOf([coarse(square, '/')])
const sq = alone.tiles[0]
let marks = marked(first.term.screen())
check(labels(first.term.screen()).join() === 'square', 'a machine that has walked into the square has the square on its map, and nothing else', first.term.screen())
check(marks.length === 1 && marks[0].x === sq.x + 1 + Math.floor(square.spawn.x / SCALE.x) && marks[0].y === sq.y + 1 + Math.floor(square.spawn.y / SCALE.y),
  `Sam is the @ on the block of the spawn: ${JSON.stringify(marks)}`, first.term.screen())

first.term.shell.stdin.write('\x1b')
check(await until(() => mapOf(first.term.screen()) === null), 'Esc closes it', first.term.screen())

// A scene opens in NORMAL: `/` alone enters INSERT with the slash typed, and
// Tab completes the word the line holds.
first.term.shell.stdin.write('/')
check(await until(() => first.term.screen().includes('-- INSERT --')), '/ in NORMAL enters INSERT', first.term.screen())
first.term.shell.stdin.write('m')
check(await until(() => first.term.screen().includes('/map · Tab completes')), '/m lists /map under the line', first.term.screen())
first.term.shell.stdin.write('\t')
check(await until(() => first.term.screen().split('\n').some((l) => l.startsWith("/map") && !l.includes("·"))), 'Tab completes /m to /map', first.term.screen())
first.term.shell.stdin.write('\r')
check(await until(() => mapOf(first.term.screen())), 'and Enter on the completed line opens the map', first.term.screen())
first.term.shell.stdin.write('\x1b')
check(await until(() => mapOf(first.term.screen()) === null), 'Esc closes it', first.term.screen())
first.term.shell.stdin.write('\x1b')

// ─── through the tavern's door ────────────────────────────────────────

const tavernDoor = square.doors.find((d) => d.to === '/tavern/')
const back       = tavern.doors.find((d) => d.to === '/')
const inside     = { x: back.x, y: back.y - 1 }
check(await walk(first.term, square, route(square, square.spawn, tavernDoor),
  () => first.term.at(inside.x, inside.y, 1, tavern) === '@' && first.term.screen().includes('The tavern')),
  "Sam walks through the tavern's door", first.term.screen())
check(await open(first.term), '/map opens in the tavern', first.term.screen())

const both = layoutOf([coarse(square, '/'), coarse(tavern, '/tavern/')])
const tv = both.tiles.find((t) => t.slug === 'tavern')
marks = marked(first.term.screen())
check(labels(first.term.screen()).sort().join() === 'square,tavern', 'the map has both, the square walked out of and the tavern walked into', first.term.screen())
check(marks.length === 1 && marks[0].x === tv.x + 1 + Math.floor(inside.x / SCALE.x) && marks[0].y === tv.y + 1 + Math.floor(inside.y / SCALE.y),
  `and Sam is the @ in the tavern's block, beside its door: ${JSON.stringify(marks)}`, first.term.screen())
check(readdirSync(SEEN).sort().join() === 'square.json,tavern.json', `~/.fli/haven/seen holds a file per scene walked into: ${readdirSync(SEEN)}`)
check(await quit(first.term) === 0, 'Ctrl+C exits 0')

// ─── another terminal, the same machine ───────────────────────────────

const again = await enter(homes[0])
check(again.ok && await open(again.term), 'a terminal opened later on the same machine opens the map', again.term.screen())
check(labels(again.term.screen()).sort().join() === 'square,tavern',
  'it draws the tavern too, from the file: this machine has been in it, this terminal has not', again.term.screen())
marks = marked(again.term.screen())
check(marks.length === 1 && marks[0].x === sq.x + 1 + Math.floor(square.spawn.x / SCALE.x) && marks[0].y === sq.y + 1 + Math.floor(square.spawn.y / SCALE.y),
  'and the @ is on the square, where it stands now', again.term.screen())
check(await quit(again.term) === 0, 'Ctrl+C exits 0')

// ─── a machine that has walked nowhere ────────────────────────────────

const bea = await enter(homes[1])
check(bea.ok && await open(bea.term) && labels(bea.term.screen()).join() === 'square',
  "another machine's map is its own: the square alone, though Sam has been in the tavern on the same server", bea.term.screen())
check(await quit(bea.term) === 0, 'Ctrl+C exits 0')

// ─── done ─────────────────────────────────────────────────────────────

await env.close()
for (const h of homes) rmSync(h, { recursive: true, force: true })

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
