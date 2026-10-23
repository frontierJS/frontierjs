/**
 * web/test/verify-taskmaster.mjs — the taskmaster at the workshop's desk.
 * Started by `bun run verify:taskmaster`; needs no Chrome and no TTY of its own.
 *
 * Haven's API runs in this process over a fresh test database. Sam's machine
 * is a HOME of its own whose `HAVEN_TASKMASTER_ROOT` is a root made here: a
 * `fli` that prints a ranking with a row for hand and two for the loop, and a
 * `fix-loop` that records how it was called and waits to be told to stop. So
 * the real `fli next` and the real loop, which spends money, are never run.
 * Sam walks into the workshop; the taskmaster is at his desk and silent until
 * Sam walks up, then offers the first fixable package, `/no` hears the next,
 * `/yes` from out of reach starts nothing, and from beside him starts the
 * loop on the package he last offered, detached, `--pkg` and nothing else.
 * While it runs he says so and a second `/yes` starts nothing; when it ends
 * he reads the register again. A machine with no checkout draws the desk and
 * no one at it.
 *
 * Traps (the terminal's own are in `terminal.mjs`):
 * - Bun's `homedir()` is read once per process, so the lock file is a child's
 *   HOME, never this process's.
 * - A scene opens in NORMAL, so the first `/` command is typed after an `i`; after Enter it
 *   is still in INSERT, and a second `i` would be typed into the line.
 * - He polls the lock once a second, so a loop ending is waited for.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../../api/src/app.ts'
import { ROOMS } from '../../api/src/rooms.ts'
import { POST_KEY, signIn, stakedHome } from '../../api/test/sign-in.ts'
import { cellOf, terminal, until } from './terminal.mjs'
import { stageOf } from './stage.mjs'

const WEB      = join(import.meta.dir, '..')
const REPO     = join(WEB, '../../..')
const FLI      = join(REPO, 'packages/cli/bin/fli.js')
const square   = await stageOf('Square')
const workshop = await stageOf('Workshop')

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}

// ─── a root that costs nothing ────────────────────────────────────────

const samHome = mkdtempSync(join(tmpdir(), 'haven-sam-'))
const anaHome = await stakedHome('haven-ana-', 'ana')
const fake    = mkdtempSync(join(tmpdir(), 'haven-root-'))
const bare    = mkdtempSync(join(tmpdir(), 'haven-bare-'))
const RAN     = join(fake, 'ran.json')
const STOP    = join(fake, 'stop')
mkdirSync(join(fake, 'scripts'), { recursive: true })
mkdirSync(join(fake, 'packages/cli/bin'), { recursive: true })
writeFileSync(join(fake, 'packages/cli/bin/fli.js'), `console.log(JSON.stringify({ ready: [
  { id: 'FJS-1', pkg: ['basecamp'],           severity: 'S1', byHand: true,  title: 'for a hand' },
  { id: 'FJS-2', pkg: ['litestone', 'auth'],  severity: 'S2', byHand: false, title: 'a litestone thing' },
  { id: 'FJS-3', pkg: ['mesa'],               severity: 'S3', byHand: false, title: 'a mesa thing' },
] }))
`)
writeFileSync(join(fake, 'scripts/fix-loop.mjs'), `
  import { writeFileSync, existsSync } from 'node:fs'
  writeFileSync(${JSON.stringify(RAN)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }))
  while (!existsSync(${JSON.stringify(STOP)})) await new Promise((r) => setTimeout(r, 20))
`)

// ─── Haven ────────────────────────────────────────────────────────────

const env = await createTestEnv({
  schema: join(WEB, '../db/schema.lite'),
  listen: true,
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-taskmaster', port: 0, postKey: POST_KEY }),
})
for (const room of ROOMS) await env.system.room.create({ data: { ...room } })
const API = `http://localhost:${env.port}`
const sam = await signIn(env.port, 'sam')
const term = terminal(API, sam.token, square, { HOME: samHome, HAVEN_TASKMASTER_ROOT: fake })
const at = (x, y, width = 1, stage = workshop) => cellOf(term.screen(), x, y, width, stage)

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
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1], b = cells[i]
    term.shell.stdin.write(KEY[`${b.x - a.x},${b.y - a.y}`])
    const last = i === cells.length - 1
    if (!await until(() => (last && arrived ? arrived() : at(b.x, b.y, 1, stage) === '@'), 3000)) return false
  }
  return true
}

/** A command typed into the line; a scene opens in NORMAL, which `i` leaves, and Enter stays in INSERT. */
const say = (line) => term.shell.stdin.write(`${term.screen().includes('-- NORMAL') ? 'i' : ''}${line}\r`)

// ─── Sam walks into the workshop ──────────────────────────────────────

check(await until(() => term.screen().includes('j/k moves, Enter opens')), 'the shell lists the routes', term.screen())
term.shell.stdin.write('\r')
check(await until(() => at(square.spawn.x, square.spawn.y, 1, square) === '@'), 'Enter opens the square', term.screen())
const workshopDoor = square.doors.find((d) => d.to === '/workshop/')
const door   = workshop.doors.find((d) => d.to === '/')
const inside = { x: door.x, y: door.y - 1 }
check(await walk(square, route(square, square.spawn, workshopDoor),
  () => at(inside.x, inside.y) === '@' && term.screen().includes('The workshop · 1 here')),
  "Sam comes in through the workshop's door", term.screen())

// ─── the desk ─────────────────────────────────────────────────────────

const desk   = workshop.marks.find((m) => m.piece?.name === 'taskmaster')
const man    = { x: desk.x + 7, y: desk.y + 1 }
const speech = (width) => at(man.x, man.y + 1, width)
const OFFER  = 'litestone has the most severe issue — FJS-2 (S2). Work on it? /yes or /no'
check(desk && !desk.piece.bench && workshop.walkable(man.x, man.y) && desk.x < 8,
  'the desk is no bench, stands by the door on the left, and has floor under it for him', JSON.stringify(desk))
check(await until(() => at(man.x, man.y) === '✦'), 'the taskmaster stands at his desk once fli next has answered', term.screen())
check(speech(OFFER.length) !== OFFER && !term.screen().includes('most severe'),
  'and says nothing to a figure three cells off', term.screen())

const beside = { x: man.x - 2, y: man.y + 2 }
check(await walk(workshop, route(workshop, inside, beside)), 'Sam walks up to him', term.screen())
check(await until(() => speech(OFFER.length) === OFFER),
  'he offers the first package the loop can take — the row for a hand is passed over — and the row naming it', term.screen())

// ─── no, then yes from the wrong place ────────────────────────────────

const NEXT = 'then mesa — FJS-3 (S3). Work on it? /yes or /no'
say('/n')
check(await until(() => speech(NEXT.length) === NEXT), '/n (the alias of /no) hears the next package', term.screen())

const away = { x: beside.x + 5, y: beside.y }
check(await walk(workshop, route(workshop, beside, away)), 'Sam steps out of reach', term.screen())
say('/yes')
check(await until(() => term.screen().includes('nobody here to answer')), '/yes from out of reach is answered by nobody', term.screen())
await Bun.sleep(400)
check(!existsSync(RAN), 'and starts no loop')

// ─── yes ──────────────────────────────────────────────────────────────

check(await walk(workshop, route(workshop, away, beside)), 'Sam walks back up to him', term.screen())
say('/yes')
const RUNNING = 'fix-loop is on mesa — the sessions stand at its bench'
check(await until(() => speech(RUNNING.length) === RUNNING && term.screen().includes('fix-loop started on mesa')),
  '/yes starts the loop on the package he last offered, and he says it is running', term.screen())
check(await until(() => existsSync(RAN)), 'the loop was run', '')
const ran = JSON.parse(readFileSync(RAN, 'utf8'))
check(ran.cwd === fake && ran.argv.join(' ') === '--pkg mesa', 'from the root, with --pkg mesa and nothing else', JSON.stringify(ran))
check(existsSync(join(samHome, '.fli/haven/taskmaster.json')), 'the loop is kept in Sam\'s HOME so a second terminal knows it', '')

say('/y')
check(await until(() => term.screen().includes('fix-loop is on mesa') && !term.screen().includes('started on mesa — ')),
  'a second /y starts nothing while it runs', term.screen())

// ─── the loop ends ────────────────────────────────────────────────────

writeFileSync(STOP, '')
check(await until(() => speech(OFFER.length) === OFFER, 8000),
  'when the loop ends he reads the register again and offers the first package afresh', term.screen())

// ─── a machine with no checkout ───────────────────────────────────────

const frame = await new Promise((resolve) => {
  const p = spawn('bun', [FLI, 'haven', '--frame', '/workshop/', '--api', API], {
    cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: anaHome, HAVEN_TASKMASTER_ROOT: bare },
  })
  let framed = '', err = ''
  p.stdout.on('data', (d) => { framed += d })
  p.stderr.on('data', (d) => { err += d })
  p.on('exit', (code) => resolve({ code, framed, err }))
})
check(frame.code === 0 && frame.framed.includes('[ taskmaster ]') && !frame.framed.includes('✦'),
  'a root with no fix loop draws his desk and no one at it', frame.framed + frame.err)

// ─── done ─────────────────────────────────────────────────────────────

term.shell.stdin.write('\x03')
const code = await Promise.race([term.exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))])
check(code === 0, 'Ctrl+C exits 0', `exit: ${code}`)
if (code === 'timeout') term.shell.kill('SIGKILL')
await env.close()
for (const d of [samHome, anaHome, fake, bare]) rmSync(d, { recursive: true, force: true })

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
