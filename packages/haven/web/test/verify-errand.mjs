/**
 * web/test/verify-errand.mjs — the tavern's runner (`components/Runner.mesa`).
 * Started by `bun run verify:errand`; needs no Chrome and no TTY of its own.
 *
 * Haven's API runs in this process over a fresh test database. Sam is
 * Sierra's interactive shell under a pty with `HAVEN_ERRAND` set to a command
 * printing one ticket. He walks from the square through the tavern's door; a
 * boy runs in behind him and stops with the ticket's title and URL over his
 * head. Ana, in the same room from a HOME of her own, never sees the boy: the
 * errand is Sam's machine's. Sam leaves and walks in again: the ticket was
 * delivered today, so no boy comes. With no `HAVEN_ERRAND` but the line in
 * `~/.fli/haven/errand`, a new ticket comes the same way. `HAVEN_ERRAND_CMD`
 * drives what Sam's machine really uses instead of the stand-in.
 *
 * Traps:
 * - The boy is `&` at layer 11; the figures are `@` and `S`, so he is read off
 *   the screen as a glyph that appears and moves, not at a fixed cell.
 * - Bun's `homedir()` is read once per process, so each HOME is a child's.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../../api/src/app.ts'
import { ROOMS } from '../../api/src/rooms.ts'
import { signIn } from '../../api/test/sign-in.ts'
import { cellOf, terminal, until } from './terminal.mjs'
import { stageOf } from './stage.mjs'

const WEB    = join(import.meta.dir, '..')
const FLI    = join(WEB, '../../cli/bin/fli.js')
const square = await stageOf('Square')
const tavern = await stageOf('Tavern')

const TICKET = { id: 8851169195, title: 'lead form / estimator form', url: 'https://app.basecamp.com/5483754/buckets/33281201/todos/8851169195' }
const REAL   = process.env.HAVEN_ERRAND_CMD
const CMD    = REAL || `printf '%s' '${JSON.stringify(TICKET)}'`

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}

const samHome = mkdtempSync(join(tmpdir(), 'haven-errand-sam-'))
const anaHome = mkdtempSync(join(tmpdir(), 'haven-errand-ana-'))

const env = await createTestEnv({
  schema: join(WEB, '../db/schema.lite'),
  listen: true,
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-errand', port: 0 }),
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

/** A session of Sam's: into the square, then through the tavern's door. */
async function visit(label, { errand, expectBoy, hyperlinks = true }) {
  // opentui turns OSC 8 on for a terminal it knows by name; a pty has none to ask.
  const term = terminal(API, sam.token, square, { HOME: samHome, HAVEN_ERRAND: errand, TERM: hyperlinks ? 'xterm-kitty' : 'xterm' })
  const at = (x, y, stage) => cellOf(term.screen(), x, y, 1, stage)
  check(await until(() => term.screen().includes('j/k moves, Enter opens')), `${label}: the shell lists the routes`, term.screen())
  term.shell.stdin.write('\r')
  check(await until(() => at(square.spawn.x, square.spawn.y, square) === '@'), `${label}: Enter opens the square`, term.screen())

  const door = square.doors.find((d) => d.to === '/tavern/')
  const back = tavern.doors.find((d) => d.to === '/')
  const cells = route(square, square.spawn, door)
  let ok = !!cells
  for (let i = 1; ok && i < cells.length; i++) {
    const a = cells[i - 1], b = cells[i]
    term.shell.stdin.write(KEY[`${b.x - a.x},${b.y - a.y}`])
    ok = await until(() => (i === cells.length - 1 ? term.screen().includes('The tavern · 1 here') : at(b.x, b.y, square) === '@'), 3000)
  }
  check(ok, `${label}: Sam walks into the tavern`, term.screen())

  const said = await until(() => (REAL ? term.screen().includes('(! ') : term.screen().includes(`(! ${TICKET.title}`)) || /\(! the runner tripped/.test(term.screen()), 20000)
  const screen = term.screen()
  if (expectBoy) {
    check(said && screen.includes('&'), `${label}: a boy stops in the tavern with an errand`, screen)
    const link = term.raw().match(/\x1b\]8;[^;]*;(https?:[^\x07\x1b]+)/)?.[1]
    if (hyperlinks) {
      check(REAL ? !!link : link === TICKET.url, `${label}: his title is a hyperlink to the ticket's URL`, term.raw().slice(-600))
      check(!screen.includes('https://'), `${label}: the URL itself is not printed`, screen)
    } else {
      check(!link && /https:\/\/\S+/.test(screen), `${label}: a terminal with no hyperlinks is shown the URL as text`, screen)
    }
    check(!/the runner tripped/.test(screen), `${label}: the boy did not trip`, screen)
  } else {
    await new Promise((r) => setTimeout(r, 1500))
    check(!term.screen().includes('&') && !term.screen().includes('(!'), `${label}: no boy comes`, term.screen())
  }
  return { term, at, back }
}

// First visit: the boy comes, Ana (another machine) sees nothing of him.
const first = await visit('first visit', { errand: CMD, expectBoy: true })
const anaFrame = await new Promise((resolve) => {
  const p = spawn('bun', [FLI, 'haven', '--frame', '/tavern/', '--api', API, '--nick', 'ana'], {
    cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: anaHome, HAVEN_ERRAND: '' },
  })
  let out = ''
  p.stdout.on('data', (d) => { out += d })
  p.on('exit', () => resolve(out))
})
check(anaFrame.includes('The tavern') && !anaFrame.includes('&') && !anaFrame.includes('(!'), "Ana's frame of the tavern has no boy and no errand: they are Sam's machine's", anaFrame)

first.term.shell.stdin.write('\x03')
await Promise.race([first.term.exited, new Promise((r) => setTimeout(r, 5000))])
first.term.shell.kill('SIGKILL')

// Second visit, same HOME: the ticket was delivered today.
const second = await visit('second visit', { errand: CMD, expectBoy: false })
second.term.shell.stdin.write('\x03')
await Promise.race([second.term.exited, new Promise((r) => setTimeout(r, 5000))])
second.term.shell.kill('SIGKILL')

// A terminal that cannot open a hyperlink is shown the URL as text instead.
if (!REAL) {
  const fresh = await visit('no hyperlinks', { errand: `printf '%s' '${JSON.stringify({ ...TICKET, id: 3 })}'`, expectBoy: true, hyperlinks: false })
  fresh.term.shell.stdin.write('\x03')
  await Promise.race([fresh.term.exited, new Promise((r) => setTimeout(r, 5000))])
  fresh.term.shell.kill('SIGKILL')
}

// Third visit: no HAVEN_ERRAND, but the one line in ~/.fli/haven/errand, a
// ticket not yet delivered. Set once, no command passed.
if (!REAL) {
  mkdirSync(join(samHome, '.fli', 'haven'), { recursive: true })
  writeFileSync(join(samHome, '.fli', 'haven', 'errand'), `printf '%s' '${JSON.stringify({ ...TICKET, id: 2 })}'\n`)
  const third = await visit('command file', { errand: '', expectBoy: true })
  third.term.shell.stdin.write('\x03')
  await Promise.race([third.term.exited, new Promise((r) => setTimeout(r, 5000))])
  third.term.shell.kill('SIGKILL')
}

await env.close()
rmSync(samHome, { recursive: true, force: true })
rmSync(anaHome, { recursive: true, force: true })

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
