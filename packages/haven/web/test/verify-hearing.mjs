/**
 * web/test/verify-hearing.mjs — a line is heard where it is said (`IDEAS/haven.md` 7.1).
 * Started by `bun run verify:hearing`; needs no Chrome and no TTY of its own.
 *
 * Sam and Ana stand in the square under a pty each, Ana then walks out of
 * Sam's earshot. A line Sam says aloud is on his screen and not on hers; a
 * `!` line is on both; a `/w ana` line is on hers as a whisper, and a third
 * terminal beside Sam, who reads the room's history, never gets it. Ana walks
 * back and the next line is hers again; Sam walks off and the history's copy
 * of it is no bubble over him for a terminal at the spawn.
 *
 * Trap: a screen is read for a line's text, so the negative waits long enough
 * for the delivery to have happened if it were going to — Sam's own bubble is
 * the proof that the line was sent, and the shout after it that Ana was
 * listening.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../../api/src/app.ts'
import { EARSHOT } from '../../api/src/hearing.ts'
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
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-hearing', port: 0 }),
})
for (const [slug, name] of [['square', 'The square'], ['tavern', 'The tavern'], ['road', 'The road'], ['woods', 'The woods'], ['docks', 'The docks']]) {
  await env.system.room.create({ data: { slug, name } })
}
const API = `http://localhost:${env.port}`
const { x: sx, y: sy } = square.spawn
const OUT = EARSHOT.x + 2

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
    send:   (s) => p.stdin.write(s),
    async walk(dx) {
      for (let i = 0; i < Math.abs(dx); i++) { p.stdin.write(dx > 0 ? '\x1b[C' : '\x1b[D'); await sleep(140) }
    },
    async say(line) { p.stdin.write(line); await sleep(60); p.stdin.write('\r') },
  }
}

const sam = await terminal('sam')
const ana = await terminal('ana')
await until(() => sam.at(sx, sy) === '@' && sam.screen().includes('2 here'))
sam.send('i')
await sleep(150)

await ana.walk(OUT)
check(await until(() => sam.at(sx + OUT, sy) === 'A'), `Ana is ${OUT} cells east of Sam, past earshot`, sam.screen())

await sam.say('hello there')
check(await until(() => sam.screen().includes('(hello there)')), "Sam's own screen shows what he said", sam.screen())
await sleep(1200)
check(!ana.screen().includes('hello there'), "a line said aloud is not on the screen of a figure beyond earshot", ana.screen())

await sam.say('!over here')
check(await until(() => ana.screen().includes('(!over here)')), 'a line that begins with ! reaches her across the square', ana.screen())

await sam.say('/w ana meet me')
check(await until(() => sam.screen().includes('whispered to ana')), 'Sam is told the whisper went', sam.screen())
check(await until(() => ana.screen().includes('(psst: meet me)')), 'and it is on her screen as a whisper, across the square', ana.screen())

// A terminal at the spawn reads the room's history, which holds every line
// said aloud and none of a whisper it is not a party to.
const bea = await new Promise((resolve) => {
  const p = spawn('bun', [FLI, 'haven', '--frame', '/', '--api', API, '--nick', 'bea'], {
    cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'haven-bea-')) },
  })
  let framed = ''
  p.stdout.on('data', (d) => { framed += d })
  p.stderr.on('data', (d) => { framed += d })
  p.on('exit', () => resolve(framed))
})
check(bea.includes('(!over here)') && !bea.includes('meet me') && !bea.includes('psst'),
  "a third member beside Sam reads his shout and nothing of the whisper", bea)

await ana.walk(-OUT)
await until(() => sam.at(sx + 1, sy) === 'A' || sam.at(sx, sy) !== '@', 3000)
await sam.say('again')
check(await until(() => ana.screen().includes('(again)')), 'walking back within earshot, the next line is hers', ana.screen())

// The history holds "again" and a frame loads it, so only the bubble's own
// test of distance keeps it off the screen of a figure Sam has walked from.
await sam.walk(OUT)
await until(() => ana.at(sx + OUT, sy) === 'S', 3000)
const left = await new Promise((resolve) => {
  const p = spawn('bun', [FLI, 'haven', '--frame', '/', '--api', API, '--nick', 'cat'], {
    cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'haven-cat-')) },
  })
  let framed = ''
  p.stdout.on('data', (d) => { framed += d })
  p.stderr.on('data', (d) => { framed += d })
  p.on('exit', () => resolve(framed))
})
check(left.includes('here') && !left.includes('(again)'),
  "a line in the history is no bubble over a speaker who has since walked out of earshot", left)

for (const t of [sam, ana]) { t.send('\x03'); await until(() => t.p.exitCode !== null, 3000); t.p.kill() }
await env.cleanup?.()
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
