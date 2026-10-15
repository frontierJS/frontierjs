/**
 * web/test/verify-nameplate.mjs — a figure close to yours wears its full nick.
 * Started by `bun run verify:nameplate`; needs no Chrome and no TTY of its own.
 *
 * Sam stands in the square under a pty. Ana walks in beside him, then far from
 * him, as `fli haven --frame /` — each frame is Ana's own screen. Beside Sam
 * her frame shows his nick on the row under his figure, and his screen shows
 * hers; once Sam has walked out of reach neither does, and the figures keep
 * their initials.
 *
 * Trap: a frame is one connection that exits, so Sam is read while Ana's
 * frame is up, and his screen is read after it has gone.
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

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}

const env = await createTestEnv({
  schema: join(WEB, '../db/schema.lite'),
  listen: true,
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-nameplate', port: 0 }),
})
for (const [slug, name] of [['square', 'The square'], ['tavern', 'The tavern'], ['road', 'The road'], ['woods', 'The woods'], ['docks', 'The docks']]) {
  await env.system.room.create({ data: { slug, name } })
}
const sam = await signIn(env.port, 'sam')
const anaHome = mkdtempSync(join(tmpdir(), 'haven-ana-'))
const API = `http://localhost:${env.port}`

const shell = spawn('script', ['-qfec', `stty rows 30 cols 100; bun ${TUI} --api ${API}`, '/dev/null'], {
  cwd: WEB, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, HAVEN_TOKEN: sam.token },
})
let out = ''
shell.stdout.on('data', (d) => { out += d })
const at = (x, y, width) => cellOf(screen(out), x, y, width, square)

await until(() => screen(out).includes('j/k moves, Enter opens'))
shell.stdin.write('\r')
const { x: sx, y: sy } = square.spawn
await until(() => at(sx, sy) === '@' && screen(out).includes('1 here'))

/** `fli haven --frame /` held open by `--keep`-less polling: started now, answered once it exits. */
function frame() {
  const p = spawn('bun', [FLI, 'haven', '--frame', '/', '--api', API, '--nick', 'ana'], {
    cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: anaHome },
  })
  let framed = ''
  let err = ''
  p.stdout.on('data', (d) => { framed += d })
  p.stderr.on('data', (d) => { err += d })
  return new Promise((r) => p.on('exit', (code) => r({ code, framed, err })))
}

// Ana walks in on Sam's own cell, so she is beside him.
const near = frame()
check(await until(() => at(sx, sy + 1, 3) === 'ana'), "Sam's screen shows Ana's nick on the row under her figure", screen(out))
const beside = await near
check(cellOf(beside.framed, sx, sy + 1, 3, square) === 'sam',
  "and Ana's frame shows Sam's nick on the row under his", beside.framed + beside.err)

// Five steps right is one past reach.
for (let step = 1; step <= 5; step++) {
  shell.stdin.write('\x1b[C')
  await until(() => at(sx + step, sy) === '@', 3000)
}
const far = await frame()
check(cellOf(far.framed, sx + 5, sy, 1, square) === 'S' && cellOf(far.framed, sx + 5, sy + 1, 3, square) !== 'sam',
  "out of reach Sam is his initial and wears no nick", far.framed + far.err)

shell.stdin.write('\x03')
await until(() => shell.exitCode !== null, 3000)
shell.kill()
await env.cleanup?.()
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
