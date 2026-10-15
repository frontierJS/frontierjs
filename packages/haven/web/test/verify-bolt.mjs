/**
 * web/test/verify-bolt.mjs — the client end of `d` (`IDEAS/haven.md` 9.5).
 * Started by `bun run verify:bolt`; needs no Chrome and no TTY of its own.
 *
 * Sam and Ana stand in the square under a pty each, Ana eight cells east of
 * Sam, which is the bolt's whole range. Sam's `d` `l` flies a `>` arrow along the
 * cells up to and including hers on Sam's screen and Ana's, knocks Ana two cells east on
 * both, and flickers her `x` for a second before she is `A` again. Then `d`
 * `k` flies north into the tavern's wall and scorches it with a `,` that Ana
 * sees too, and that a third member, who walks in after, is handed.
 *
 * Trap: a flight lasts under half a second on a screen, so the drive samples
 * a screen in a loop rather than waiting for a frame. A piece shattering is
 * not here -- the square has none a bolt breaks -- and is proved by
 * `scars.test.js` and `bolt-service.test.ts`.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../../api/src/app.ts'
import { BOLT_MS } from '../../api/src/bolt.ts'
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
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-bolt', port: 0 }),
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
    at:     (x, y) => cellOf(screen(out), x, y, 1, square),
    send:   (s) => p.stdin.write(s),
    async walk(n) { for (let i = 0; i < n; i++) { p.stdin.write(RIGHT); await sleep(140) } },
  }
  return t
}

/** Every glyph `read()` gives over `ms`, sampled as fast as a screen can be replayed. */
async function watch(read, ms) {
  const seen = []
  const end = Date.now() + ms
  while (Date.now() < end) { seen.push(read()); await sleep(15) }
  return seen
}

const sam = await terminal('sam')
const ana = await terminal('ana')
await until(() => sam.screen().includes('2 here'))
await ana.walk(8)
const AX = sx + 8
check(await until(() => sam.at(AX, sy) === 'A'), 'Ana stands eight cells east of Sam, the bolt\'s whole range', sam.screen())

// ─── d l: a bolt that hits ─────────────────────────────────────────────────
const between = (t) => () => { for (let x = sx + 1; x <= AX; x++) if (t.at(x, sy) === '>') return '>'; return ' ' }
sam.send('d'); await sleep(80)
const flightOnSam = watch(between(sam), 900)
const flightOnAna = watch(between(ana), 900)
const flicker = watch(() => sam.at(AX + 2, sy), 1800)
sam.send('l')
const [onSam, onAna, flick] = await Promise.all([flightOnSam, flightOnAna, flicker])
check(onSam.includes('>'), "the bolt is a `>` arrow across the cells up to and including hers on Sam's screen", sam.screen())
check(onAna.includes('>'), "and on Ana's, who did not fire it", ana.screen())
check(!['A', 'x'].includes(sam.at(AX, sy)), 'Ana is no longer where she was struck', sam.screen())
check(flick.includes('x') && flick.at(-1) === 'A', 'she is knocked two cells east, flickers `x` for a second, and is A again', `${flick.join('')}\n${sam.screen()}`)
check(ana.at(AX + 2, sy) === '@', "and on her own screen the `@` stands at the cell she was knocked to", ana.screen())
check(!between(sam)().includes('>') && !between(ana)().includes('>'), 'once landed, the flight is gone from both', sam.screen())

// ─── d j: a bolt that scorches ─────────────────────────────────────────────
// The hedge below is a wall drawn as `,`, the scorch's own glyph, so the shot
// goes north to the tavern's wall, seven cells from four rows up.
const wall = { x: sx, y: 10 }
for (let i = 0; i < 4; i++) { sam.send('\x1b[A'); await sleep(140) }
check(sam.at(wall.x, wall.y) !== ',' && sam.at(wall.x, wall.y) !== ' ', 'the wall below Sam is a wall before the bolt', sam.at(wall.x, wall.y))
await sleep(BOLT_MS)
sam.send('d'); await sleep(80); sam.send('k')
check(await until(() => sam.at(wall.x, wall.y) === ','), 'a bolt north ends in a `,` on the wall it struck, on Sam\'s screen', sam.screen())
check(await until(() => ana.at(wall.x, wall.y) === ','), "and on Ana's", ana.screen())

// ─── a joiner is handed the scorch ─────────────────────────────────────────
const rex = await terminal('rex')
check(await until(() => rex.at(wall.x, wall.y) === ','), 'a member who walks in after sees the scorch the room remembers', rex.screen())

for (const t of [sam, ana, rex]) { t.send('\x03'); await until(() => t.p.exitCode !== null, 3000); t.p.kill() }
await env.cleanup?.()
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
