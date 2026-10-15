/**
 * web/test/verify-bar.mjs — the board behind the tavern's bar
 * (`components/Bar.mesa`). Started by `bun run verify:bar`; needs no Chrome.
 *
 * Haven's API runs in this process over a fresh test database. Sam is
 * Sierra's interactive shell under a pty with `HAVEN_BAR` set to a command
 * printing rows. He walks into the tavern and onto a stool of the bar: the
 * rows are chalked up over the shelves and stepping off the
 * stool takes the board down. A second stool within the minute asks the
 * command nothing again (the command appends to a file, and the file is
 * counted). With no `HAVEN_BAR` the stool is a stool, and a command that
 * fails says so on the board.
 *
 * Traps:
 * - A stool is a cell of the bar piece's own, walked onto from the floor
 *   below it (`seats` with `solo`), so the route ends ON the stool.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../../api/src/app.ts'
import { ROOMS } from '../../api/src/rooms.ts'
import { signIn } from '../../api/test/sign-in.ts'
import { terminal, until } from './terminal.mjs'
import { bar as barPiece } from '../src/pieces/bar.js'
import { spotsOf } from '../src/pieces/index.js'
import { stageOf } from './stage.mjs'

const WEB    = join(import.meta.dir, '..')
const square = await stageOf('Square')
const tavern = await stageOf('Tavern')

const ROWS = [
  { text: 'client.test — Check for Access to Google Search Console (todo created)', when: new Date(Date.now() - 12 * 60_000).toISOString() },
  { text: 'client.test — Jennifer was granted access. (project access changed)', when: new Date(Date.now() - 3 * 3_600_000).toISOString() },
]
const TITLE = '— behind the bar —'

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}

const home  = mkdtempSync(join(tmpdir(), 'haven-bar-'))
const asked = join(home, 'asked')

const env = await createTestEnv({
  schema: join(WEB, '../db/schema.lite'),
  listen: true,
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-bar', port: 0 }),
})
for (const room of ROOMS) await env.system.room.create({ data: { ...room } })
const API = `http://localhost:${env.port}`
const sam = await signIn(env.port, 'sam')

const KEY = { '0,-1': '\x1b[A', '0,1': '\x1b[B', '1,0': '\x1b[C', '-1,0': '\x1b[D' }

/** Breadth first over floor from `from` to `to`; `to` may be a door. */
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

const bar    = tavern.placed(barPiece)[0]
const stools = spotsOf(barPiece, 'seat').map((s) => ({ ...bar.spot(s.name), stand: { x: bar.x + s.stand.dx, y: bar.y + s.stand.dy } }))

/** Sam's session: the square, the tavern, and the figure's cell, which is read off the screen by the nick's initial's neighbor — here by the bubble-free `@`. */
async function visit(label, barCmd) {
  const term = terminal(API, sam.token, square, { HOME: home, HAVEN_BAR: barCmd, HAVEN_ERRAND: '', TERM: 'xterm-kitty' })
  const walk = async (stage, cells, done) => {
    for (let i = 1; i < cells.length; i++) {
      const a = cells[i - 1], b = cells[i]
      term.shell.stdin.write(KEY[`${b.x - a.x},${b.y - a.y}`])
      if (!(await until(() => (i === cells.length - 1 ? done() : term.at(b.x, b.y, 1, stage) === '@'), 8000))) return false
    }
    return true
  }
  check(await until(() => term.screen().includes('j/k moves, Enter opens')), `${label}: the shell lists the routes`, term.screen())
  term.shell.stdin.write('\r')
  check(await until(() => term.at(square.spawn.x, square.spawn.y, 1, square) === '@'), `${label}: Enter opens the square`, term.screen())
  const door = square.doors.find((d) => d.to === '/tavern/')
  check(await walk(square, route(square, square.spawn, door), () => term.screen().includes('The tavern · 1 here')), `${label}: Sam walks into the tavern`, term.screen())

  const sit = async (s, from) => {
    const cells = route(tavern, from, s)
    return cells && (await walk(tavern, cells, () => term.at(s.x, s.y, 1, tavern) === '@'))
  }
  return { term, sit, stand: async (s) => { term.shell.stdin.write(KEY['0,1']); return until(() => term.at(s.stand.x, s.stand.y, 1, tavern) === '@', 8000) }, end: async () => {
    term.shell.stdin.write('\x03')
    await Promise.race([term.exited, new Promise((r) => setTimeout(r, 5000))])
    term.shell.kill('SIGKILL')
  } }
}

// A command that counts how many times it was asked.
const CMD = `echo asked >> '${asked}'; printf '%s' '${JSON.stringify(ROWS)}'`
const first = await visit('with a command', CMD)
const spawnAt = tavern.arrival ? tavern.arrival({ from: '/', x: 0, y: 0 }) : null
const start = spawnAt ?? tavern.spawn
check(!first.term.screen().includes(TITLE), 'with a command: no board while Sam is on his feet', first.term.screen())

check(await first.sit(stools[0], start), 'with a command: Sam sits on a stool', first.term.screen())
check(await until(() => first.term.screen().includes(TITLE) && first.term.screen().includes('Check for Access to Google Search')), 'with a command: the board is up with the newest row', first.term.screen())
check(/12m/.test(first.term.screen()) && /3h/.test(first.term.screen()), 'with a command: each row says how long ago', first.term.screen())

check(await first.stand(stools[0]), 'with a command: Sam steps off the stool', first.term.screen())
check(await until(() => !first.term.screen().includes(TITLE)), 'with a command: the board comes down', first.term.screen())

const next = stools[3]
const there = route(tavern, stools[0].stand, next)
let ok = !!there
for (let i = 1; ok && i < there.length; i++) {
  first.term.shell.stdin.write(KEY[`${there[i].x - there[i - 1].x},${there[i].y - there[i - 1].y}`])
  ok = await until(() => first.term.at(there[i].x, there[i].y, 1, tavern) === '@', 8000)
}
check(ok && await until(() => first.term.screen().includes(TITLE)), 'with a command: a second stool puts the board up again', first.term.screen())
check(readFileSync(asked, 'utf8').trim().split('\n').length === 1, 'with a command: the second sitting within the minute asked the command nothing', readFileSync(asked, 'utf8'))
await first.end()

// More rows than the board holds scroll up it, and a new sitting starts at the top.
const MANY = Array.from({ length: 8 }, (_, i) => ({ text: `scroll-row-${i}` }))
const long = await visit('eight rows', `printf '%s' '${JSON.stringify(MANY)}'`)
check(await long.sit(stools[0], start), 'eight rows: Sam sits on a stool', long.term.screen())
check(await until(() => long.term.screen().includes('scroll-row-0')), 'eight rows: the board opens at the newest', long.term.screen())
check(!long.term.screen().includes('scroll-row-5'), 'eight rows: only five fit', long.term.screen())
check(await until(() => long.term.screen().includes('scroll-row-7'), 15_000) && !long.term.screen().includes('scroll-row-0'), 'eight rows: the board scrolls on, the newest rolling off the top', long.term.screen())
check(await long.stand(stools[0]), 'eight rows: Sam steps off the stool', long.term.screen())
check(await until(() => !long.term.screen().includes(TITLE)), 'eight rows: the board comes down', long.term.screen())
check(await long.sit(stools[0], stools[0].stand) && await until(() => long.term.screen().includes('scroll-row-0')), 'eight rows: sitting again starts at the newest', long.term.screen())
await long.end()

// No opt-in: a stool is a stool.
const none = await visit('no command', '')
check(await none.sit(stools[0], start), 'no command: Sam sits on a stool', none.term.screen())
await new Promise((r) => setTimeout(r, 1500))
check(!none.term.screen().includes(TITLE), 'no command: no board', none.term.screen())
await none.end()

// A command that fails says so.
const bad = await visit('failing command', 'echo nope >&2; exit 2')
check(await bad.sit(stools[0], start), 'failing command: Sam sits on a stool', bad.term.screen())
check(await until(() => bad.term.screen().includes('the board is blank')), 'failing command: the board says it is blank', bad.term.screen())
await bad.end()

await env.close()
rmSync(home, { recursive: true, force: true })

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
