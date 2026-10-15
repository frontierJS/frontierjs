/**
 * web/test/verify-steps.mjs — where somebody walked (`IDEAS/haven.md` 7.4).
 * Started by `bun run verify:steps`; needs no Chrome and no TTY of its own.
 *
 * Sam and Ana stand on the square's spawn under a pty each. Sam walks four
 * cells east: his own screen has a footprint on each cell he left, and so has
 * Ana's, laid from the moves presence shows her. Then Rex, who was not there,
 * walks in as `fli haven --frame /` from a HOME of his own and finds the same
 * three footprints, which only the server's memory of the room could tell him.
 * The spawn, where both walked in, has none on any screen.
 *
 * Trap: a footprint is a `.` on a blank cell, so a drive that reads one where
 * the art is drawn reads the art; the cells walked here are blank on the
 * square's picture. The fade takes minutes and is `steps.test.js`'s.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../../api/src/app.ts'
import { signIn } from '../../api/test/sign-in.ts'
import { TUI, cellOf, screen, until } from './terminal.mjs'
import { stageOf } from './stage.mjs'

const WEB = join(import.meta.dir, '..')
const square = await stageOf('Square')
const FLI = join(WEB, '../../cli/bin/fli.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}

const env = await createTestEnv({
  schema: join(WEB, '../db/schema.lite'),
  listen: true,
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-steps', port: 0 }),
})
for (const [slug, name] of [['square', 'The square'], ['tavern', 'The tavern'], ['road', 'The road'], ['woods', 'The woods'], ['docks', 'The docks']]) {
  await env.system.room.create({ data: { slug, name } })
}
const API = `http://localhost:${env.port}`
const { x: sx, y: sy } = square.spawn
const WALK = 4
const walked = Array.from({ length: WALK - 1 }, (_, i) => sx + 1 + i)   // the cells left behind; the last is under him

check(square.picture()[sy].slice(sx, sx + WALK + 1).trim() === '', `the square is blank from (${sx}, ${sy}) to ${WALK} cells east, so a dot there is a footprint`)

/** A member's terminal, walked in to the square. */
async function terminal(nick) {
  const { token } = await signIn(env.port, nick)
  const p = spawn('script', ['-qfec', `stty rows 30 cols 100; bun ${TUI} --api ${API}`, '/dev/null'], {
    cwd: WEB, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, HAVEN_TOKEN: token },
  })
  let out = ''
  p.stdout.on('data', (d) => { out += d })
  await until(() => screen(out).includes('j/k moves, Enter opens'))
  p.stdin.write('\r')
  await until(() => cellOf(screen(out), sx, sy, 1, square) === '@' && screen(out).includes('here'))
  return {
    p,
    screen: () => screen(out),
    at:     (x, y, width = 1) => cellOf(screen(out), x, y, width, square),
  }
}

const sam = await terminal('sam')
const ana = await terminal('ana')
await until(() => sam.screen().includes('2 here') && ana.screen().includes('2 here'))

// More than 100 ms a step, or presence drops the move and the other screen never sees the cell.
for (let i = 1; i <= WALK; i++) {
  sam.p.stdin.write('\x1b[C')
  await until(() => sam.at(sx + i, sy) === '@', 3000)
  await sleep(140)
}
const dots = (read) => walked.map((x) => read(x, sy)).join('')

check(await until(() => dots(sam.at) === '...', 3000), `Sam's screen has a footprint on each of the ${walked.length} cells he left`, sam.screen())
check(sam.at(sx + WALK, sy) === '@', 'and he stands on the fourth', sam.screen())
check(await until(() => dots(ana.at) === '...' && ana.at(sx + WALK, sy) === 'S', 3000),
  "Ana's screen has the same footprints, laid from his moves as she saw them, and Sam at the end of them", ana.screen())

// Rex was not in the room: what he sees was handed to him by the server.
const rexHome = mkdtempSync(join(tmpdir(), 'haven-rex-'))
const rex = await new Promise((r) => {
  const p = spawn('bun', [FLI, 'haven', '--frame', '/', '--api', API, '--nick', 'rex'], {
    cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: rexHome },
  })
  let framed = '', err = ''
  p.stdout.on('data', (d) => { framed += d })
  p.stderr.on('data', (d) => { err += d })
  p.on('exit', () => r({ framed, err }))
})
const rexAt = (x, y) => cellOf(rex.framed, x, y, 1, square)
check(dots(rexAt) === '...', "Rex, walking in after, finds the three footprints from the room's memory", rex.framed + rex.err)
check(rexAt(sx + WALK, sy) === 'S', 'and Sam where he stopped', rex.framed)
check(sam.at(sx - 1, sy) !== '.' && ana.at(sx - 1, sy) !== '.' && rexAt(sx - 1, sy) !== '.',
  'nobody walked west of the spawn, and no screen has a footprint there', sam.screen())

for (const t of [sam, ana]) t.p.stdin.write('\x03')
await sleep(300)
for (const t of [sam, ana]) t.p.kill()
await env.cleanup?.()
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
