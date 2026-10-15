/**
 * web/test/verify-view.mjs — the view follows the terminal (`IDEAS/haven.md`
 * 14.6). Started by `bun run verify:view`; needs no Chrome and no TTY of its
 * own.
 *
 * Sam is Sierra's interactive shell under a pty of 140×40, a terminal zoomed
 * out: the square's top row is drawn past column 97, where a 100×30 screen
 * ends, and he walks east past where that screen's view would have panned
 * with this one still at its corner. Then the pty is resized to 80×30 with
 * him standing there: the view re-fits round him rather than leaving him off
 * its right edge, the status and input lines still fit under the art, and the
 * next step pans it as the narrower slack says. Resized back up to 140×40 the
 * view widens round where he stands.
 *
 * Traps (the terminal's own are in `terminal.mjs`):
 * - A pty's size is this drive's to state; every other drive's pty is 100×30,
 *   where the view is `VIEW`, so their numbers are this one's at that size.
 * - A resize is read off what was drawn after it: `terminal.mjs` keeps no
 *   scrollback, and a cell the old size drew and the new one never rewrote
 *   would otherwise read as still there.
 * - The square is not fogged (`OUTDOORS` names no fog), so its top row is
 *   drawn whoever stands where; a scene with fog would read it blank.
 */
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { buildHavenApp } from '../../api/src/app.ts'
import { signIn } from '../../api/test/sign-in.ts'
import { terminal, until } from './terminal.mjs'
import { stageOf } from './stage.mjs'
import { VIEW, follow, viewFor } from '../src/stage.js'

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
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-view', port: 0 }),
})
await env.system.room.create({ data: { slug: 'square', name: 'The square' } })
const API = `http://localhost:${env.port}`
const { token } = await signIn(env.port, 'sam')

const WIDE = { cols: 140, rows: 40 }
const NARROW = { cols: 80, rows: 30 }
const sam = terminal(API, token, square, {}, WIDE)
const { x: sx, y: sy } = square.spawn
const top = (view) => square.picture()[0].slice(view.x, view.x + view.w).trimEnd()
const row0 = (view) => sam.at(view.x, 0, view.w, square, view)?.trimEnd()

check(await until(() => sam.screen().includes('j/k moves, Enter opens')), 'the shell lists the square', sam.screen())
sam.shell.stdin.write('\r')
const eye = { view: follow({ x: 0, y: 0 }, square.spawn, square, viewFor(WIDE.cols, WIDE.rows)) }
check(eye.view.w === WIDE.cols - (100 - VIEW.w) && eye.view.w > VIEW.w, `a ${WIDE.cols}-column terminal shows ${eye.view.w} columns of the square, ${VIEW.w} at 100`)
check(await until(() => sam.at(sx, sy, 1, square, eye.view) === '@' && sam.screen().includes('1 here')),
  'Enter opens it, and Sam stands where a figure walks in', sam.screen())
check(top(eye.view).length > VIEW.w && row0(eye.view) === top(eye.view),
  `the square's top row is drawn to column ${eye.view.w - 1}, past where a 100-column screen ends`, sam.screen())

/** Walk east from `from` to `to` a step at a time, each waiting for the screen; the view is followed beside it at `size`. */
async function east(from, to, size) {
  for (let x = from; x < to;) {
    x++
    eye.view = follow(eye.view, { x, y: sy }, square, size)
    sam.write('\x1b[C')
    if (!await until(() => sam.at(x, sy, 1, square, eye.view) === '@', 3000)) return false
    // The server drops a move past 10 a second.
    await sleep(110)
  }
  return true
}

// Past where a 97-column view pans (its slack is 8), short of where this one does.
const far = VIEW.w - 8 + 3
check(await east(sx, far, viewFor(WIDE.cols, WIDE.rows)) && eye.view.x === 0,
  `Sam walks east to column ${far} and the wide view has not panned`, sam.screen())

sam.resize(NARROW.cols, NARROW.rows)
const narrow = viewFor(NARROW.cols, NARROW.rows)
eye.view = follow(eye.view, { x: far, y: sy }, square, narrow)
check(eye.view.x > 0 && eye.view.w === narrow.w, `the pty is resized to ${NARROW.cols}×${NARROW.rows}, and the view re-fits to ${eye.view.w} columns from column ${eye.view.x}`)
check(await until(() => sam.at(far, sy, 1, square, eye.view) === '@' && row0(eye.view) === top(eye.view), 5000),
  'Sam is still on screen, the view panned round him, and the art beside him is the square', sam.screen())
check(sam.screen().includes('1 here') && sam.screen().includes('arrows walk'),
  'the status line and the input line still fit under the art', sam.screen())
const before = eye.view.x
check(await east(far, far + 1, narrow) && eye.view.x === before + 1, 'the next step east pans the narrower view by one', sam.screen())

sam.resize(WIDE.cols, WIDE.rows)
eye.view = follow(eye.view, { x: far + 1, y: sy }, square, viewFor(WIDE.cols, WIDE.rows))
check(await until(() => sam.at(far + 1, sy, 1, square, eye.view) === '@' && row0(eye.view) === top(eye.view), 5000),
  `resized back to ${WIDE.cols}×${WIDE.rows}, the view widens to ${eye.view.w} columns round where he stands`, sam.screen())

sam.shell.stdin.write('\x03')
await sleep(300)
sam.shell.kill()
await env.cleanup?.()
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
