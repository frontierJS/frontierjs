/**
 * web/test/verify-glade.mjs — the glade and the tunnel (`IDEAS/haven.md` 6.6).
 * Started by `bun run verify:glade`; needs no Chrome and no TTY of its own.
 *
 * Haven's API runs in this process over a fresh test database. Ana's
 * `fli haven --frame /woods/` reads the loose plank as fence, the glyph of the
 * plank above it. Sam is Sierra's interactive shell under a pty, twice, with
 * the clock pinned (`clock-at.mjs`). By day he walks west out of the square,
 * through the woods to the end of the path and onto the plank: he is in the
 * glade beside its east door, and Ana's frame of /glade/ draws him there. He
 * walks to the foot of the oak, where the trunk is drawn, and steps onto it;
 * nothing happens. By night the foot of the oak is drawn as a door, and
 * stepping onto it takes him into the cellar beside its west wall, which is
 * drawn as a door too; stepping back onto it brings him up beside the oak.
 *
 * Traps (the terminal's own are in `terminal.mjs`):
 * - Bun's `homedir()` is read once per process, so Ana's HOME is a child's.
 * - Ana's frames run on the real clock, since a signed login is refused off
 *   it, so nothing read off them may depend on the time of day.
 * - A move past 10 a second is dropped by the server, so the walk waits for
 *   the figure at each cell before the next key.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../../api/src/app.ts'
import { ROOMS } from '../../api/src/rooms.ts'
import { POST_KEY, signIn, stakedHome } from '../../api/test/sign-in.ts'
import { cellOf, terminal, until } from './terminal.mjs'
import { stageOf } from './stage.mjs'

const WEB    = join(import.meta.dir, '..')
const FLI    = join(WEB, '../../cli/bin/fli.js')
const CLOCK  = join(import.meta.dir, 'clock-at.mjs')
const square = await stageOf('Square')
const woods  = await stageOf('Woods')
const glade  = await stageOf('Glade')
const cellar = await stageOf('Cellar')

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}

const homes = [...['sam-day', 'sam-night'].map((n) => mkdtempSync(join(tmpdir(), `haven-glade-${n}-`))), await stakedHome('haven-glade-ana-', 'ana')]
const [dayHome, nightHome, anaHome] = homes

// ─── Haven ────────────────────────────────────────────────────────────

const env = await createTestEnv({
  schema: join(WEB, '../db/schema.lite'),
  listen: true,
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-glade', port: 0, postKey: POST_KEY }),
})
for (const room of ROOMS) await env.system.room.create({ data: { ...room } })
const API = `http://localhost:${env.port}`
const sam = await signIn(env.port, 'sam')

/** Ana's frame of `route`, from a HOME of her own. */
const frameOf = (route) => new Promise((resolve) => {
  const p = spawn('bun', [FLI, 'haven', '--frame', route, '--api', API], {
    cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: anaHome },
  })
  let framed = '', err = ''
  p.stdout.on('data', (d) => { framed += d })
  p.stderr.on('data', (d) => { err += d })
  p.on('exit', (code) => resolve({ code, framed, err }))
})

// ─── what Ana sees of the plank ───────────────────────────────────────

const plank    = woods.doors.find((d) => d.to === '/glade/')
const oak      = glade.doors.find((d) => d.to === '/cellar/')
const tunnel   = cellar.doors.find((d) => d.to === '/glade/')
const gladeOut = glade.doors.find((d) => d.to === '/woods/')
const woodsFrame = await frameOf('/woods/')
const anaAt = (x, y) => cellOf(woodsFrame.framed, x, y, 1, woods)
check(woodsFrame.code === 0 && plank?.hidden === true, 'the woods have one way to the glade, and it is hidden', woodsFrame.framed + woodsFrame.err)
check(anaAt(plank.x, plank.y) === '|' && anaAt(plank.x, plank.y - 1) === '|' && anaAt(plank.x, plank.y + 1) === '|',
  "Ana's frame of the woods draws the plank as fence, the glyph of the planks above and below it", woodsFrame.framed)

// ─── Sam ──────────────────────────────────────────────────────────────

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

/** Sam at the time of day `at`: his terminal, a reader of a cell, and a walk. */
function samAt(at, home) {
  const term = terminal(API, sam.token, square, { HOME: home, BUN_OPTIONS: `--preload ${CLOCK}`, HAVEN_CLOCK_AT: String(at) })
  const cell = (x, y, stage) => cellOf(term.screen(), x, y, 1, stage)
  /** Walk along `cells`, each key once the last step is on his screen; the last cell may be a door, waited on by `arrived`. */
  const walk = async (stage, cells, arrived) => {
    if (!cells) return false
    for (let i = 1; i < cells.length; i++) {
      const a = cells[i - 1], b = cells[i]
      term.shell.stdin.write(KEY[`${b.x - a.x},${b.y - a.y}`])
      const last = i === cells.length - 1
      if (!await until(() => (last && arrived ? arrived() : cell(b.x, b.y, stage) === '@'), 3000)) return false
    }
    return true
  }
  return { term, cell, walk }
}

/** Open the square, cross into the woods and step through the plank: the glade, beside its east door. */
async function intoGlade({ term, cell, walk }, when) {
  check(await until(() => term.screen().includes('j/k moves, Enter opens')), `${when}: the shell lists the routes`, term.screen())
  term.shell.stdin.write('\r')
  check(await until(() => cell(square.spawn.x, square.spawn.y, square) === '@'), `${when}: Enter opens the square`, term.screen())
  const edge   = { x: 1, y: square.spawn.y }
  const inWoods = { x: 95, y: edge.y }
  check(await walk(square, route(square, square.spawn, edge), () => cell(inWoods.x, inWoods.y, woods) === '@' && term.screen().includes('The woods · 1 here')),
    `${when}: west across the square's border, Sam is in the woods at the same row`, term.screen())
  const beside  = { x: plank.x + 1, y: plank.y }
  check(await walk(woods, route(woods, inWoods, beside)), `${when}: he walks the path to its end at the fence`, term.screen())
  const landing = { x: gladeOut.x - 1, y: gladeOut.y }
  check(await walk(woods, [beside, plank], () => cell(landing.x, landing.y, glade) === '@' && term.screen().includes('The glade · 1 here')),
    `${when}: stepping onto the plank takes him through: the glade, beside its east door`, term.screen())
  return landing
}

const foot = { x: oak.x, y: oak.y + 1 }

// ─── by day ───────────────────────────────────────────────────────────

const day = samAt(0.25, dayHome)
const dayLanding = await intoGlade(day, 'by day')

const gladeFrame = await frameOf('/glade/')
check(gladeFrame.code === 0 && gladeFrame.framed.includes('The glade · 2 here') && cellOf(gladeFrame.framed, dayLanding.x, dayLanding.y, 1, glade) === 'S',
  "Ana's frame of the glade is the same room, with Sam inside its east door", gladeFrame.framed + gladeFrame.err)

check(await day.walk(glade, route(glade, dayLanding, foot)), 'by day: Sam walks to the foot of the oak', day.term.screen())
check(day.cell(oak.x, oak.y, glade) === '|', 'by day: the cell over him is trunk', day.term.screen())
day.term.shell.stdin.write(KEY['0,-1'])
await new Promise((r) => setTimeout(r, 1000))
check(day.cell(foot.x, foot.y, glade) === '@' && day.term.screen().includes('The glade · 1 here'),
  'by day: stepping onto the trunk goes nowhere: he stands where he was, in the glade', day.term.screen())

day.term.shell.stdin.write('\x03')
const dayCode = await Promise.race([day.term.exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))])
check(dayCode === 0, 'by day: Ctrl+C exits 0', `exit: ${dayCode}`)
if (dayCode === 'timeout') day.term.shell.kill('SIGKILL')

// ─── by night ─────────────────────────────────────────────────────────

const night = samAt(0.75, nightHome)
const nightLanding = await intoGlade(night, 'by night')
check(await night.walk(glade, route(glade, nightLanding, foot)), 'by night: Sam walks to the foot of the oak', night.term.screen())
check(night.cell(oak.x, oak.y, glade) === 'n', 'by night: the cell over him is a door', night.term.screen())

const inCellar = { x: tunnel.x + 1, y: tunnel.y }
check(await night.walk(glade, [foot, oak], () => night.cell(inCellar.x, inCellar.y, cellar) === '@' && night.term.screen().includes('The cellar · 1 here')),
  'by night: stepping onto it takes him down the tunnel: the cellar, beside its west wall', night.term.screen())
check(night.cell(tunnel.x, tunnel.y, cellar) === 'n', "by night: the cellar's west wall is a door where he came through", night.term.screen())

check(await night.walk(cellar, [inCellar, tunnel], () => night.cell(foot.x, foot.y, glade) === '@' && night.term.screen().includes('The glade · 1 here')),
  'by night: back through it, he comes up at the foot of the oak', night.term.screen())

night.term.shell.stdin.write('\x03')
const nightCode = await Promise.race([night.term.exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))])
check(nightCode === 0, 'by night: Ctrl+C exits 0', `exit: ${nightCode}`)
if (nightCode === 'timeout') night.term.shell.kill('SIGKILL')

// ─── done ─────────────────────────────────────────────────────────────

await env.close()
for (const h of homes) rmSync(h, { recursive: true, force: true })

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
