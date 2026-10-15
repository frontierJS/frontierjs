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
 * tavern's door brings Sam back out (`IDEAS/haven.md` 2.2). Sam is a mod
 * (`HAVEN_MODS`): `/ban ana` leaves Ana's next frame with no square and
 * `/unban ana` gives it back (`IDEAS/haven.md` 3.2). Then the square is
 * wider than a screen (6.1): Sam walks east off the first screen and the
 * view follows; Ana's frame from the spawn has Sam's line as a marker on the
 * edge facing him; and Bea, a third terminal walking the same way, sees
 * Sam's figure and line in the part the first screen never showed. Last the
 * border (6.2): Sam walks off the square's east edge into the road and
 * stands at the matching row beside the run back, the crossing timed from
 * the key to the road drawn with him in it — the reconnect a door hides
 * behind a scene change and a border cannot — Ana's frame of the road has
 * him there, and the step back west puts him on the square's east edge.
 * Through all of it the square is fogged (6.3): a wall nobody has walked
 * near is blank on every screen, a lamp's halo is drawn from across the
 * square, a hedge walked past stays drawn once it is out of sight, and a
 * figure nine rows beyond a frame's sight is listed and not drawn.
 *
 * Traps (the terminal's own are in `terminal.mjs`):
 * - A move past 10 a second is dropped by the server in silence, so the
 *   steps wait for the screen between keys.
 * - A screen's view is its own figure's, so a terminal that walked past the
 *   edge is read through the view the drive followed beside it (`eye`), and
 *   a `--frame` from the spawn through the stage's own, which this drive
 *   never pans.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../../api/src/app.ts'
import { signIn } from '../../api/test/sign-in.ts'
import { TUI, blank, cellOf, screen, terminal, until } from './terminal.mjs'
import { stageOf } from './stage.mjs'
import { follow, VIEW } from '../src/stage.js'

const WEB = join(import.meta.dir, '..')
const square = await stageOf('Square')
const tavern = await stageOf('Tavern')
const road   = await stageOf('Road')
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
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-explore', port: 0, mods: ['sam'] }),
})
for (const [slug, name] of [['square', 'The square'], ['tavern', 'The tavern'], ['road', 'The road'], ['woods', 'The woods'], ['docks', 'The docks']]) {
  await env.system.room.create({ data: { slug, name } })
}
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
const at = (x, y, width, scene = square, view) => cellOf(screen(out), x, y, width, scene, view)
const samTerm = { write: (k) => shell.stdin.write(k), at }

check(await until(() => screen(out).includes('j/k moves, Enter opens')), 'the shell lists the square', screen(out))
shell.stdin.write('\r')
const { x: sx, y: sy } = square.spawn
check(await until(() => at(sx, sy) === '@' && screen(out).includes('1 here')),
  'Enter opens it, and Sam stands where a figure walks in', screen(out))
const lamp = square.marks.find((m) => m.kind === 'piece' && m.piece.name === 'lamp')
check(blank(at(sx, 0)) && at(lamp.x, lamp.y, 3) === '(o)' && at(sx - 1, sy + 2, 3) === ',,,',
  'the square is fogged: the wall across it is blank, the lamp is lit from across it, the hedge beside him is drawn', screen(out))

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

// A scene opens in NORMAL, so a line starts with `i`.
shell.stdin.write('i')
check(await until(() => screen(out).includes('-- INSERT --')), 'a new scene is NORMAL and i starts the line', screen(out))
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
check(blank(cellOf(framed, sx, 0, 1, square)) && cellOf(framed, lamp.x, lamp.y, 3, square) === '(o)',
  'and nothing of the wall she has not walked near, the lamp lit', framed)
check(await until(() => at(sx, sy) === ' ' && screen(out).includes('1 here')), "Ana leaving takes that figure off Sam's screen", screen(out))

// ─── the tavern's door ────────────────────────────────────────────────

/**
 * Walk a terminal's figure one step at a time, each waiting for the screen.
 * With an `eye`, the view that terminal has is followed beside it, so a
 * step past the edge is read where the pan put it.
 */
async function walk(who, key, from, to, scene = square, eye = null) {
  const code = { left: '\x1b[D', right: '\x1b[C', up: '\x1b[A', down: '\x1b[B' }[key]
  let { x, y } = from
  while (x !== to.x || y !== to.y) {
    x += Math.sign(to.x - x)
    y += Math.sign(to.y - y)
    if (eye) eye.view = follow(eye.view, { x, y }, scene)
    who.write(code)
    if (!await until(() => who.at(x, y, 1, scene, eye?.view) === '@', 3000)) return false
    // The screen is this terminal's own; the server drops a move past 10 a
    // second, and the OTHER terminal keeps the last move it was sent.
    await new Promise((r) => setTimeout(r, 110))
  }
  return true
}

const door = square.doors.find((d) => d.to === '/tavern/')
const inFront = { x: door.x, y: door.y + 1 }
const walked = await walk(samTerm, 'up', { x: sx + dx, y: sy }, { x: sx + dx, y: inFront.y })
  && await walk(samTerm, 'left', { x: sx + dx, y: inFront.y }, inFront)
check(walked && at(inFront.x, inFront.y) === '@', "Sam walks to the left house's door", screen(out))
shell.stdin.write('\x1b[A')
check(await until(() => at(tavern.spawn.x, tavern.spawn.y, 1, tavern) === '@' && screen(out).includes('The tavern · 1 here')),
  'stepping onto it opens the tavern, Sam standing inside its door', screen(out))

// One step in, so Ana's own figure at the spawn does not paint over Sam's.
const bar = { x: tavern.spawn.x, y: tavern.spawn.y - 1 }
shell.stdin.write('\x1b[A')
await until(() => at(bar.x, bar.y, 1, tavern) === '@', 3000)

// ─── the history pane ─────────────────────────────────────────────────

shell.stdin.write('i')
await until(() => screen(out).includes('-- INSERT --'))
shell.stdin.write('the hearth is warm\r')
check(await until(() => at(bar.x, bar.y - 1, 20, tavern) === '(the hearth is warm)'), 'Sam says a line in the tavern', screen(out))
shell.stdin.write('\x1b[5~')
check(await until(() => screen(out).includes('sam: the hearth is warm') && screen(out).includes('PageDown newer')),
  "PageUp opens the tavern's history over the art, with Sam's line signed", screen(out))
check(!screen(out).includes('sam: hi all'), "and the square's line is not in it", screen(out))
shell.stdin.write('\x1b[6~')
check(await until(() => !screen(out).includes('PageDown newer') && at(bar.x, bar.y, 1, tavern) === '@'),
  'PageDown past the newest line closes it, the figure where it stood', screen(out))

const outside = await havenFrame('/')
check(outside.code === 0 && cellOf(outside.framed, inFront.x, inFront.y, 1, square) === ' ' && outside.framed.includes('The square · 1 here'),
  "Ana's frame of the square no longer shows Sam", outside.framed + outside.err)
const inside = havenFrame('/tavern/')
check(await until(() => at(tavern.spawn.x, tavern.spawn.y, 1, tavern) === 'A' && screen(out).includes('The tavern · 2 here')),
  "Sam's screen shows Ana walking into the tavern", screen(out))
const ina = await inside
check(ina.code === 0 && cellOf(ina.framed, bar.x, bar.y, 1, tavern) === 'S',
  "Ana's frame of the tavern shows Sam's figure where it stepped", ina.framed + ina.err)

await walk(samTerm, 'down', bar, tavern.spawn, tavern)
shell.stdin.write('\x1b[B')
check(await until(() => at(inFront.x, inFront.y) === '@' && screen(out).includes('The square · 1 here')),
  "the tavern's door brings Sam back out to the square, standing before the door he came out of", screen(out))
await walk(samTerm, 'right', inFront, { x: sx + dx, y: inFront.y })
  && await walk(samTerm, 'down', { x: sx + dx, y: inFront.y }, { x: sx + dx, y: sy })
  && await walk(samTerm, 'left', { x: sx + dx, y: sy }, { x: sx, y: sy })
check(at(sx, sy) === '@', 'and he walks back to where a figure walks in', screen(out))

// ─── the key is the member ────────────────────────────────────────────

const anas = await env.system.member.findMany({ where: { nick: 'ana' } })
check(anas.length === 1, "three fli haven runs from Ana's HOME are one member, signed in by one key", JSON.stringify(anas))
const otherHome = mkdtempSync(join(tmpdir(), 'haven-other-'))
const stranger = await havenFrame('/', { home: otherHome })
check(stranger.code !== 0 && /taken/.test(stranger.err + stranger.framed),
  "another machine's key cannot walk in as ana", stranger.err + stranger.framed)

// ─── a mod ────────────────────────────────────────────────────────────

check(sam.role === 'mod', "the server lists sam as a mod, so Sam's login made one", JSON.stringify(sam))
shell.stdin.write('i')
await until(() => screen(out).includes('-- INSERT --'))
shell.stdin.write('/ban ana\r')
check(await until(() => screen(out).includes('ana is banned')), "Sam types /ban ana and the screen says so", screen(out))
const gone = await havenFrame('/')
check(gone.code === 0 && cellOf(gone.framed, sx, sy, 1, square) === null && gone.framed.includes('no square'),
  "Ana's frame has no square to walk into", gone.framed + gone.err)
check(!screen(out).includes('· ana'), "and Sam's screen never showed Ana", screen(out))
shell.stdin.write('/unban ana\r')
check(await until(() => screen(out).includes('ana is back')), 'Sam types /unban ana and the screen says so', screen(out))
const back = havenFrame('/')
check(await until(() => screen(out).includes('2 here') && screen(out).includes('· ana')), "Ana walks in again on Sam's screen", screen(out))
const backed = await back
check(backed.code === 0 && backed.framed.includes('The square · 2 here') && backed.framed.includes('· sam'),
  "and Ana's frame has Sam in the square", backed.framed + backed.err)

// ─── past the edge ────────────────────────────────────────────────────

// East along the spawn's row to the far side, then ten back, so Sam stands
// inside the view's slack with the view still panned and his bubble on his
// own cell rather than pushed in from the edge.
const farEast = { x: 110, y: sy }
const far     = { x: 100, y: sy }
const samEye  = { view: square.view }
check(square.width > VIEW.w && square.view.w === VIEW.w, `the square is ${square.width} cells wide and a screen shows ${VIEW.w}`)
const east = await walk(samTerm, 'right', { x: sx, y: sy }, farEast, square, samEye)
  && await walk(samTerm, 'left', farEast, far, square, samEye)
check(east && samEye.view.x > 0 && at(far.x, far.y, 1, square, samEye.view) === '@',
  `Sam walks east past the first screen's edge and the view follows, to column ${samEye.view.x}`, screen(out))
check(at(0, sy, 1, square, samEye.view) === null && at(far.x, sy + 2, 1, square, samEye.view) === ',',
  "the square's west edge is off Sam's screen and the hedge runs on beside him", screen(out))
check(blank(at(far.x, 0, 1, square, samEye.view)) && at(sx + dx, sy + 2, 1, square, samEye.view) === ',',
  'the wall across is still blank, and the hedge he bumped is drawn from memory, out of sight', screen(out))
shell.stdin.write('i')
shell.stdin.write('over here\r')
check(await until(() => at(far.x, far.y - 1, 11, square, samEye.view) === '(over here)'), 'Sam says a line there', screen(out))

const edge = await havenFrame('/')
check(edge.code === 0 && cellOf(edge.framed, VIEW.w - 12, far.y - 1, 12, square) === '(over here)>',
  "Ana's frame from the spawn shows Sam's line as a marker on the edge facing him", edge.framed + edge.err)
check(cellOf(edge.framed, far.x, far.y, 1, square) === null && edge.framed.includes('· sam'),
  "Sam's figure is past her edge, and Sam is still listed", edge.framed)

const bea     = await signIn(env.port, 'bea')
const beaTerm = terminal(API, bea.token, square)
const beaEye  = { view: square.view }
const beaWho  = { write: (k) => beaTerm.shell.stdin.write(k), at: beaTerm.at }
check(await until(() => beaTerm.screen().includes('j/k moves, Enter opens')), "Bea's terminal lists the square", beaTerm.screen())
beaTerm.shell.stdin.write('\r')
check(await until(() => beaTerm.at(sx, sy) === '@' && beaTerm.screen().includes('2 here') && beaTerm.at(VIEW.w - 12, far.y - 1, 12) === '(over here)>'),
  "Bea walks in at the spawn and sees Sam's marker on her edge", beaTerm.screen())
const beaEast = await walk(beaWho, 'right', { x: sx, y: sy }, { x: farEast.x - 1, y: sy }, square, beaEye)
  && await walk(beaWho, 'left', { x: farEast.x - 1, y: sy }, { x: far.x - 1, y: sy }, square, beaEye)
check(beaEast && beaTerm.at(far.x, far.y, 1, square, beaEye.view) === 'S' && beaTerm.at(far.x, far.y - 1, 11, square, beaEye.view) === '(over here)',
  "Bea's screen, panned the same way, shows Sam's figure and line where the first screen never reached", beaTerm.screen())
check(await until(() => at(far.x - 1, far.y, 1, square, samEye.view) === 'B'), "and Sam's shows Bea beside him", screen(out))
beaTerm.shell.stdin.write('\x03')
const beaCode = await Promise.race([beaTerm.exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))])
check(beaCode === 0, "Bea's Ctrl+C exits 0", `exit: ${beaCode}`)
if (beaCode === 'timeout') beaTerm.shell.kill('SIGKILL')

// ─── the border ───────────────────────────────────────────────────────

// The square's east edge is a run of door cells into the road, and the
// road's west edge the run back: a crossing lands at the same row.
const border = square.marks.find((m) => m.kind === 'door' && m.to === '/road/')
const eastEdge = { x: border.x - 1, y: sy }
check(border && border.h > 1 && sy >= border.y && sy < border.y + border.h,
  `the square's east edge is a border into the road, ${border?.h} cells tall`, JSON.stringify(border))
// Along the spawn's row to the signpost, round its post, and on to the edge.
const post = { x: border.x - 9, y: sy }
const toEdge = await walk(samTerm, 'right', far, post, square, samEye)
  && await walk(samTerm, 'up', post, { x: post.x, y: sy - 2 }, square, samEye)
  && await walk(samTerm, 'right', { x: post.x, y: sy - 2 }, { x: eastEdge.x, y: sy - 2 }, square, samEye)
  && await walk(samTerm, 'down', { x: eastEdge.x, y: sy - 2 }, eastEdge, square, samEye)
check(toEdge && at(eastEdge.x, eastEdge.y, 1, square, samEye.view) === '@', "Sam walks to the square's east edge", screen(out))
const arrive = { x: 2, y: sy }
const t0 = Date.now()
shell.stdin.write('\x1b[C')
const crossed = await until(() => at(arrive.x, arrive.y, 1, road) === '@' && screen(out).includes('The road · 1 here'))
const ms = Date.now() - t0
check(crossed, 'one step east is the road, Sam beside its west edge at the row he crossed on', screen(out))
check(crossed && ms < 3000, `the crossing — a new route, the socket cycled into the road's room, presence synced — took ${ms} ms`)
const onRoad = await havenFrame('/road/')
check(onRoad.code === 0 && blank(cellOf(onRoad.framed, arrive.x, arrive.y, 1, road)) && onRoad.framed.includes('The road · 2 here') && onRoad.framed.includes('· sam'),
  `Ana's frame of the road lists Sam and draws nothing on his cell, ${arrive.y - road.spawn.y} rows beyond her sight`, onRoad.framed + onRoad.err)
const backEye = { view: follow(square.view, eastEdge, square) }
shell.stdin.write('\x1b[D')
check(await until(() => at(eastEdge.x, eastEdge.y, 1, square, backEye.view) === '@' && screen(out).includes('The square · 1 here')),
  'one step west is the square again, Sam on its east edge with the view panned to him', screen(out))

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
