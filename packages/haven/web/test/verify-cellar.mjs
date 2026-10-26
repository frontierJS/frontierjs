/**
 * web/test/verify-cellar.mjs — the cellar (`IDEAS/haven.md` 6.5).
 * Started by `bun run verify:cellar`; needs no Chrome and no TTY of its own.
 *
 * Haven's API runs in this process over a fresh test database. Sam is
 * Sierra's interactive shell under a pty. Ana walks in by `fli haven --frame
 * /tavern/` first and reads the cell where the hidden door is: it is the rug,
 * the same glyph as the cell beside it, with no door drawn. Sam walks from the
 * square through the tavern's door, across the rug to the cell beside the
 * hole and steps onto it; he is in the cellar, beside the ladder. A frame of
 * /cellar/ from Ana's HOME while he stands there draws him, so it is a room
 * like any other. He climbs the ladder and stands in the tavern beside the
 * hole, not at the tavern's door.
 *
 * Traps (the terminal's own are in `terminal.mjs`):
 * - Bun's `homedir()` is read once per process, so Ana's HOME is a child's.
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
const square = await stageOf('Square')
const tavern = await stageOf('Tavern')
const cellar = await stageOf('Cellar')

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}

const samHome = mkdtempSync(join(tmpdir(), 'haven-cellar-sam-'))
const anaHome = await stakedHome('haven-cellar-ana-', 'ana')

// ─── Haven ────────────────────────────────────────────────────────────

const env = await createTestEnv({
  schema: join(WEB, '../db/schema.lite'),
  listen: true,
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-cellar', port: 0, postKey: POST_KEY }),
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

// ─── what Ana sees of the hole ────────────────────────────────────────

const hole    = tavern.doors.find((d) => d.to === '/cellar/')
const ladder  = cellar.doors.find((d) => d.to === '/tavern/')
const tavernFrame = await frameOf('/tavern/')
const anaAt = (x, y) => cellOf(tavernFrame.framed, x, y, 1, tavern)
check(tavernFrame.code === 0 && hole?.hidden === true, 'the tavern has one door to the cellar, and it is hidden', tavernFrame.framed + tavernFrame.err)
check(anaAt(hole.x, hole.y) === ':' && anaAt(hole.x - 1, hole.y) === ':' && anaAt(hole.x + 1, hole.y) === ':',
  "Ana's frame of the tavern draws the rug where the hole is, the same glyph as the cells beside it", tavernFrame.framed)

// ─── Sam walks in ─────────────────────────────────────────────────────

const term = terminal(API, sam.token, square, { HOME: samHome })
const at = (x, y, stage) => cellOf(term.screen(), x, y, 1, stage)
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

/** Walk Sam along `cells`, each key once the last step is on his screen; the last cell may be a door, waited on by `arrived`. */
async function walk(stage, cells, arrived) {
  if (!cells) return false
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1], b = cells[i]
    term.shell.stdin.write(KEY[`${b.x - a.x},${b.y - a.y}`])
    const last = i === cells.length - 1
    if (!await until(() => (last && arrived ? arrived() : at(b.x, b.y, stage) === '@'), 3000)) return false
  }
  return true
}

check(await until(() => term.screen().includes('j/k moves, Enter opens')), 'the shell lists the routes', term.screen())
term.shell.stdin.write('\r')
check(await until(() => at(square.spawn.x, square.spawn.y, square) === '@'), 'Enter opens the square', term.screen())

const tavernDoor = square.doors.find((d) => d.to === '/tavern/')
const back       = tavern.doors.find((d) => d.to === '/')
const inTavern   = { x: back.x, y: back.y - 1 }
check(await walk(square, route(square, square.spawn, tavernDoor),
  () => at(inTavern.x, inTavern.y, tavern) === '@' && term.screen().includes('The tavern · 1 here')),
  'Sam comes into the tavern beside the door back', term.screen())

const beside = { x: hole.x - 1, y: hole.y }
check(await walk(tavern, route(tavern, inTavern, beside)), 'Sam crosses the tavern to the cell beside the hole in the rug', term.screen())
check(term.screen().includes('The tavern · 1 here') && !/cellar/i.test(term.screen()), 'standing beside it says nothing', term.screen())

// ─── down ─────────────────────────────────────────────────────────────

const landing = { x: ladder.x, y: ladder.y + 1 }
check(await walk(tavern, [beside, hole], () => at(landing.x, landing.y, cellar) === '@' && term.screen().includes('The cellar · 1 here')),
  'stepping onto the rug cell takes him down: the cellar, beside the ladder', term.screen())

const cellarFrame = await frameOf('/cellar/')
check(cellarFrame.code === 0 && cellarFrame.framed.includes('The cellar · 2 here') && cellOf(cellarFrame.framed, landing.x, landing.y, 1, cellar) === 'S',
  "Ana's frame of the cellar is the same room, with Sam at the foot of the ladder", cellarFrame.framed + cellarFrame.err)

// ─── up ───────────────────────────────────────────────────────────────

const tavernAgain = () => [[0, 1], [0, -1], [1, 0], [-1, 0]].map(([dx, dy]) => ({ x: hole.x + dx, y: hole.y + dy })).some((c) => at(c.x, c.y, tavern) === '@')
check(await walk(cellar, [landing, ladder], () => term.screen().includes('The tavern · 1 here') && tavernAgain()),
  'the ladder brings him up beside the hole, not at the tavern door', term.screen())

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
