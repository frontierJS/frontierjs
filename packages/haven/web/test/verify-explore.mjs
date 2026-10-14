/**
 * web/test/verify-explore.mjs — two terminals in the square (`IDEAS/haven.md`
 * Phase 2). Started by `bun run verify:explore`; needs no Chrome and no TTY
 * of its own.
 *
 * Haven's API runs in this process over a fresh test database, with the
 * square laid out. Sam is signed in through the real Ed25519 login and is
 * Sierra's interactive shell under a pty: `/` opened, six steps
 * right, a hedge bumped into, a line said. Ana walks in through `fli haven
 * --frame /` (`IDEAS/haven.md` 2.3), started while Sam stands there, with a
 * HOME of its own: the first run writes the key there, and every later frame is the
 * same member because it signs with that key again. Ana's frame must show Sam's figure on the
 * cell Sam walked to with Sam's line over it, and Sam's screen must show Ana's
 * figure while Ana's frame is up — each direction is the other client's frame,
 * never a client's own echo. Then Sam walks through the left house's door: a
 * `--frame /` of Ana's no longer shows Sam, a `--frame /tavern/` does, and the
 * tavern's door brings Sam back out (`IDEAS/haven.md` 2.2).
 *
 * Traps (the terminal's own are in `terminal.mjs`):
 * - A move past 10 a second is dropped by the server in silence, so the
 *   steps wait for the screen between keys.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../../api/src/app.ts'
import { signIn } from '../../api/test/sign-in.ts'
import { TUI, cellOf, screen, until } from './terminal.mjs'
import { stageOf } from './stage.mjs'

const WEB = join(import.meta.dir, '..')
const square = await stageOf('Square')
const tavern = await stageOf('Tavern')
const FLI = join(WEB, '../../cli/bin/fli.js')

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}

// ─── Haven ─────────────────────────────────────────────────────────

const env = await createTestEnv({
  schema: join(WEB, '../db/schema.lite'),
  listen: true,
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-explore', port: 0 }),
})
await env.system.room.create({ data: { slug: 'square', name: 'The square' } })
await env.system.room.create({ data: { slug: 'tavern', name: 'The tavern' } })
const sam = await signIn(env.port, 'sam')
const anaHome = mkdtempSync(join(tmpdir(), 'haven-ana-'))
const API = `http://localhost:${env.port}`

// ─── Sam walks in ─────────────────────────────────────────────────────

const shell = spawn('script', ['-qfec', `stty rows 30 cols 100; bun ${TUI} --api ${API}`, '/dev/null'], {
  cwd: WEB, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, HAVEN_TOKEN: sam.token },
})
let out = ''
shell.stdout.on('data', (d) => { out += d })
const exited = new Promise((r) => shell.on('exit', (code) => r(code)))
const at = (x, y, width, scene = square) => cellOf(screen(out), x, y, width, scene)

check(await until(() => screen(out).includes('j/k moves, Enter opens')), 'the shell lists the square', screen(out))
shell.stdin.write('\r')
const { x: sx, y: sy } = square.spawn
check(await until(() => at(sx, sy) === '@' && screen(out).includes('1 here')),
  'Enter opens it, and Sam stands where a figure walks in', screen(out))

// Six right puts the figure over a hedge, two rows down.
const dx = 6
for (let step = 1; step <= dx; step++) {
  shell.stdin.write('\x1b[C')
  await until(() => at(sx + step, sy) === '@', 3000)
}
check(at(sx + dx, sy) === '@' && at(sx, sy) === ' ', 'six steps right move the figure six cells and draw the art back', screen(out))

shell.stdin.write('\x1b[B')
await until(() => at(sx + dx, sy + 1) === '@', 3000)
shell.stdin.write('\x1b[B')
await new Promise((r) => setTimeout(r, 300))
check(at(sx + dx, sy + 1) === '@' && at(sx + dx, sy + 2) === ',', 'a hedge is a wall', screen(out))
shell.stdin.write('\x1b[A')
check(await until(() => at(sx + dx, sy) === '@', 3000), 'and Up steps back', screen(out))

shell.stdin.write('hi all')
check(await until(() => screen(out).includes('hi all')), 'a typed line shows in the input', screen(out))
shell.stdin.write('\x1b[D')
await new Promise((r) => setTimeout(r, 300))
check(at(sx + dx, sy) === '@', 'Left edits a line being typed and walks nobody', screen(out))
shell.stdin.write('\r')
check(await until(() => at(sx + dx, sy - 1, 8) === '(hi all)'), 'Enter says it, as a bubble over the figure', screen(out))

// Esc is NORMAL, where h j k l walk as the arrows do and type nothing. The
// keys wait apart: Esc then a letter at once reads as Alt+letter.
shell.stdin.write('\x1b')
check(await until(() => screen(out).includes('-- NORMAL --')), 'Esc in the line is NORMAL', screen(out))
await new Promise((r) => setTimeout(r, 100))
const vim = [['j', 0, 1], ['k', 0, 0], ['h', -1, 0], ['l', 0, 0]]
let vimWalked = true
for (const [key, ox, oy] of vim) {
  shell.stdin.write(key)
  vimWalked &&= await until(() => at(sx + dx + ox, sy + oy) === '@', 3000)
}
check(vimWalked, 'j k h l step down, up, left and right', screen(out))
shell.stdin.write('i')
check(await until(() => screen(out).includes('-- INSERT --') && screen(out).includes('arrows walk')),
  'and i types again, into a line h j k l left empty', screen(out))

// ─── Ana, a second terminal ───────────────────────────────────────────

/** A `fli haven --frame` of one path: started now, answered with its output once it exits. */
function havenFrame(path, { home = anaHome, nick = 'ana' } = {}) {
  const p = spawn('bun', [FLI, 'haven', '--frame', path, '--api', API, '--nick', nick], {
    cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home },
  })
  let framed = ''
  let err = ''
  p.stdout.on('data', (d) => { framed += d })
  p.stderr.on('data', (d) => { err += d })
  return new Promise((r) => p.on('exit', (code) => r({ code, framed, err })))
}

const frameDone = havenFrame('/')

check(await until(() => at(sx, sy) === 'A' && screen(out).includes('2 here') && screen(out).includes('· ana')),
  "Sam's screen shows Ana's figure where a figure walks in, by its initial, and Ana's nick", screen(out))
const { code: frameCode, framed, err: frameErr } = await frameDone
check(frameCode === 0, 'fli haven --frame / exits 0', frameErr)
check(existsSync(join(anaHome, '.fli/haven/key.json')), "the first fli haven wrote Ana's key under ~/.fli/haven/")
check(cellOf(framed, sx + dx, sy, 1, square) === 'S', "Ana's frame shows Sam's figure on the cell it walked to", framed)
check(cellOf(framed, sx + dx, sy - 1, 8, square) === '(hi all)', "with Sam's line over it", framed)
check(cellOf(framed, sx, sy, 1, square) === '@', "and Ana's own figure where it walked in", framed)
check(await until(() => at(sx, sy) === ' ' && screen(out).includes('1 here')), "Ana leaving takes that figure off Sam's screen", screen(out))

// ─── the tavern's door ────────────────────────────────────────────────

/** Walk the shell's figure one step at a time, each waiting for the screen. */
async function walk(key, from, to, scene = square) {
  const code = { left: '\x1b[D', right: '\x1b[C', up: '\x1b[A', down: '\x1b[B' }[key]
  let { x, y } = from
  while (x !== to.x || y !== to.y) {
    x += Math.sign(to.x - x)
    y += Math.sign(to.y - y)
    shell.stdin.write(code)
    if (!await until(() => at(x, y, 1, scene) === '@', 3000)) return false
  }
  return true
}

const door = square.doors[0]
const inFront = { x: door.x, y: door.y + 1 }
const walked = await walk('up', { x: sx + dx, y: sy }, { x: sx + dx, y: inFront.y })
  && await walk('left', { x: sx + dx, y: inFront.y }, inFront)
check(walked && at(inFront.x, inFront.y) === '@', "Sam walks to the left house's door", screen(out))
shell.stdin.write('\x1b[A')
check(await until(() => at(tavern.spawn.x, tavern.spawn.y, 1, tavern) === '@' && screen(out).includes('The tavern · 1 here')),
  'stepping onto it opens the tavern, Sam standing inside its door', screen(out))

// One step in, so Ana's own figure at the spawn does not paint over Sam's.
const bar = { x: tavern.spawn.x, y: tavern.spawn.y - 1 }
shell.stdin.write('\x1b[A')
await until(() => at(bar.x, bar.y, 1, tavern) === '@', 3000)

const outside = await havenFrame('/')
check(outside.code === 0 && cellOf(outside.framed, inFront.x, inFront.y, 1, square) === ' ' && outside.framed.includes('The square · 1 here'),
  "Ana's frame of the square no longer shows Sam", outside.framed + outside.err)
const inside = havenFrame('/tavern/')
check(await until(() => at(tavern.spawn.x, tavern.spawn.y, 1, tavern) === 'A' && screen(out).includes('The tavern · 2 here')),
  "Sam's screen shows Ana walking into the tavern", screen(out))
const ina = await inside
check(ina.code === 0 && cellOf(ina.framed, bar.x, bar.y, 1, tavern) === 'S',
  "Ana's frame of the tavern shows Sam's figure where it stepped", ina.framed + ina.err)

await walk('down', bar, tavern.spawn, tavern)
shell.stdin.write('\x1b[B')
check(await until(() => at(sx, sy) === '@' && screen(out).includes('The square · 1 here')),
  "the tavern's door brings Sam back out to the square", screen(out))

// ─── the key is the member ────────────────────────────────────────────

const anas = await env.system.member.findMany({ where: { nick: 'ana' } })
check(anas.length === 1, "three fli haven runs from Ana's HOME are one member, signed in by one key", JSON.stringify(anas))
const otherHome = mkdtempSync(join(tmpdir(), 'haven-other-'))
const stranger = await havenFrame('/', { home: otherHome })
check(stranger.code !== 0 && /taken/.test(stranger.err + stranger.framed),
  "another machine's key cannot walk in as ana", stranger.err + stranger.framed)

// ─── done ─────────────────────────────────────────────────────────────

shell.stdin.write('\x03')
const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))])
check(code === 0, 'Ctrl+C exits 0', `exit: ${code}`)
if (code === 'timeout') shell.kill('SIGKILL')
await env.close()
rmSync(anaHome, { recursive: true, force: true })
rmSync(otherHome, { recursive: true, force: true })

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
