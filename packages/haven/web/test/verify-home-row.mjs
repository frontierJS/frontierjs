/**
 * web/test/verify-home-row.mjs — `a s d f` in NORMAL (`IDEAS/haven.md` 9.4–9.7).
 * Started by `bun run verify:home-row`; needs no Chrome and no TTY of its own.
 *
 * Sam and Ana stand in the square under a pty each, Ana eight cells east.
 * `s` and `T` draws her as `T` on both screens, `s` and Space gives her back;
 * `f` and `a` walks Sam up beside her, one step a tick, and the same keys
 * from farther off are stopped by Esc partway; `d` and a way is a bolt, and a
 * second inside the cooldown says so; and in INSERT the same letters go into
 * the line and move nobody. A half-typed line is ui's vim box (`FJS-D1411`):
 * Esc, `0 w $ x u dd p` and Enter over it, and an emptied line walks again.
 *
 * Trap: a terminal in NORMAL reaches the scene as a prevented key, so a drive
 * that types `i` first has switched the home row off, and that is the point of
 * the last check.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../../api/src/app.ts'
import { POST_KEY, signIn } from '../../api/test/sign-in.ts'
import { TUI, cellOf, screen, until } from './terminal.mjs'
import { stageOf } from './stage.mjs'

const WEB = join(import.meta.dir, '..')
const square = await stageOf('Square')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}

const env = await createTestEnv({
  schema: join(WEB, '../db/schema.lite'),
  listen: true,
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-home-row', port: 0, postKey: POST_KEY }),
})
for (const [slug, name] of [['square', 'The square'], ['tavern', 'The tavern'], ['road', 'The road'], ['woods', 'The woods'], ['docks', 'The docks']]) {
  await env.system.room.create({ data: { slug, name } })
}
const API = `http://localhost:${env.port}`
const { x: sx, y: sy } = square.spawn
const RIGHT = '\x1b[C'
// Tall enough that the line sits on screen under a note.
const ROWS = 45

async function terminal(nick) {
  const { token } = await signIn(env.port, nick)
  const p = spawn('script', ['-qfec', `stty rows ${ROWS} cols 100; bun ${TUI} --api ${API}`, '/dev/null'], {
    cwd: WEB, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, HAVEN_TOKEN: token },
  })
  let out = ''
  p.stdout.on('data', (d) => { out += d })
  await until(() => screen(out, ROWS).includes('j/k moves, Enter opens'))
  p.stdin.write('\r')
  await until(() => cellOf(screen(out, ROWS), sx, sy, 1, square) === '@' && screen(out, ROWS).includes('here'))
  const t = {
    p,
    screen: () => screen(out, ROWS),
    at:     (x, y, width = 1) => cellOf(screen(out, ROWS), x, y, width, square),
    send:   (s) => p.stdin.write(s),
    /** The column of this screen's own `@` in the spawn's row, or null. */
    where() { for (let x = sx - 2; x <= sx + 20; x++) if (t.at(x, sy) === '@') return x; return null },
    async walk(n) { for (let i = 0; i < n; i++) { p.stdin.write(RIGHT); await sleep(140) } },
  }
  return t
}

const sam = await terminal('sam')
const ana = await terminal('ana')
await until(() => sam.screen().includes('2 here'))
await ana.walk(8)
const AX = sx + 8
check(await until(() => sam.at(AX, sy) === 'A'), 'Ana stands eight cells east of Sam', sam.screen())

// ─── s: a shapeshift ───────────────────────────────────────────────────────
ana.send('s'); await sleep(80); ana.send('T')
check(await until(() => sam.at(AX, sy) === 'T'), "`s` and `T` draws Ana as T on Sam's screen", sam.screen())
check(await until(() => ana.screen().includes('you are T')), 'and says so on her own', ana.screen())
ana.send('s'); await sleep(80); ana.send(' ')
check(await until(() => sam.at(AX, sy) === 'A'), '`s` and Space gives Ana back as herself', sam.screen())

// ─── f: find ───────────────────────────────────────────────────────────────
sam.send('f'); await sleep(80); sam.send('a')
check(await until(() => sam.where() === AX - 1, 6000), '`f` and `a` walks Sam up beside Ana and no further', sam.screen())
await sleep(600)
check(sam.where() === AX - 1, 'and he stays there', sam.screen())

sam.send('f'); await sleep(80); sam.send('z')
check(await until(() => sam.screen().includes('nobody here is called z')), '`f` and a letter nobody has is said, not walked', sam.screen())

// Ana steps off; Esc stops Sam partway.
await ana.walk(10)
sam.send('f'); await sleep(80); sam.send('a')
await sleep(300)
sam.send('\x1b')
await sleep(200)
const stopped = sam.where()
await sleep(700)
check(stopped !== null && stopped > AX - 1 && sam.where() === stopped && stopped < sx + 18 - 1, 'Esc stops the walk where it stood', `${stopped} -> ${sam.where()}\n${sam.screen()}`)

// ─── d: a bolt ─────────────────────────────────────────────────────────────
sam.send('d'); await sleep(80); sam.send('l')
await sleep(300)
sam.send('d'); await sleep(80); sam.send('l')
check(await until(() => sam.screen().includes('not ready')), 'a second bolt inside the cooldown is refused by the server', sam.screen())

// ─── INSERT: the letters are the line's ────────────────────────────────────
const before = sam.where()
sam.send('i'); await sleep(150)
sam.send('fa'); await sleep(600)
check(sam.where() === before && !sam.screen().includes('arrows walk, type'), 'in INSERT `fa` is typed into the line and walks nobody', sam.screen())

// ─── the line's own NORMAL (FJS-D1411) ─────────────────────────────────────
// A line with words is ui's vim box: Esc gives it NORMAL, and emptying it
// gives the keys back to the scene.
const PLACEHOLDER = 'arrows walk, type'
const keys = async (...ks) => { for (const k of ks) { sam.send(k); await sleep(120) } }
const line = (want, gone) => until(() => sam.screen().includes(want) && !(gone && sam.screen().includes(gone)))
await keys('\x7f', '\x7f', 'hello there world', '\x1b')
check(await until(() => sam.screen().includes('-- NORMAL --') && sam.screen().includes('hello there world')), 'Esc on a half-typed line is NORMAL over the line', sam.screen())
await keys('0', 'x')
check(await line('ello there world', 'hello'), '`0` and `x` delete its first letter', sam.screen())
await keys('w', 'x')
check(await line('ello here world', 'there'), '`w` and `x` delete the next word\'s first letter', sam.screen())
await keys('$', 'x')
check(await line('ello here worl', 'here world'), '`$` and `x` delete its last letter', sam.screen())
await keys('u')
check(await line('ello here world'), '`u` undoes it', sam.screen())
check(sam.where() === before, 'and nobody walked while the line was edited', sam.screen())
await keys('dd')
check(await line(PLACEHOLDER, 'ello here world'), '`dd` empties the line', sam.screen())
await keys('l')
check(await until(() => sam.where() !== before), 'and an empty line is the scene\'s again: `l` walks', sam.screen())
await keys('i', 'ab', '\x1b', 'p')
check(await line('ello here world', PLACEHOLDER), '`i`, Esc and `p` put the deleted line back', sam.screen())
await keys('\r')
check(await until(() => sam.screen().includes(PLACEHOLDER) && sam.screen().includes('ello here world')), 'Enter in NORMAL says it', sam.screen())

for (const t of [sam, ana]) { t.send('\x03'); await until(() => t.p.exitCode !== null, 3000); t.p.kill() }
await env.cleanup?.()
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
