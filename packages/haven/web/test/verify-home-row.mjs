/**
 * web/test/verify-home-row.mjs — `a s d f` in NORMAL (`IDEAS/haven.md` 9.4–9.7).
 * Started by `bun run verify:home-row`; needs no Chrome and no TTY of its own.
 *
 * Sam and Ana stand in the square under a pty each, Ana eight cells east.
 * `s` and `T` draws her as `T` on both screens, `s` and Space gives her back;
 * `f` and `a` walks Sam up beside her, one step a tick, and the same keys
 * from farther off are stopped by Esc partway; `d` and a way is a bolt, and a
 * second inside the cooldown says so; and in INSERT the same letters go into
 * the line and move nobody.
 *
 * Trap: a terminal in NORMAL reaches the scene as a prevented key, so a drive
 * that types `i` first has switched the home row off, and that is the point of
 * the last check.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../../api/src/app.ts'
import { signIn } from '../../api/test/sign-in.ts'
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
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-home-row', port: 0 }),
})
for (const [slug, name] of [['square', 'The square'], ['tavern', 'The tavern'], ['road', 'The road'], ['woods', 'The woods'], ['docks', 'The docks']]) {
  await env.system.room.create({ data: { slug, name } })
}
const API = `http://localhost:${env.port}`
const { x: sx, y: sy } = square.spawn
const RIGHT = '\x1b[C'

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
  const t = {
    p,
    screen: () => screen(out),
    at:     (x, y, width = 1) => cellOf(screen(out), x, y, width, square),
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

for (const t of [sam, ana]) { t.send('\x03'); await until(() => t.p.exitCode !== null, 3000); t.p.kill() }
await env.cleanup?.()
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
