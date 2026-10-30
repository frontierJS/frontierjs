/**
 * web/test/verify-browser.mjs — a terminal and a browser tab in one room
 * (`IDEAS/haven.md` 5.2). Started by `bun run verify:browser`; needs Chrome,
 * util-linux `script`, and no TTY of its own.
 *
 * One set of routes, two targets (`FJS-D985`). Haven's API runs in this
 * process over a fresh test database. Sam is Sierra's terminal shell under a
 * pty, signed in the way `fli haven` signs a machine in. Bea is a headless
 * Chrome tab on this package's own Vite dev server, which builds the same
 * routes with the browser twins of `#paint`, `#cell` and `#sign-in`, and
 * walks in on a session handed in its address, as `fli haven --browser`
 * hands one. Every check reads one client's figure, line or art off the
 * OTHER client's screen: Sam's figure and line in Bea's tab, Bea's in Sam's
 * terminal, and the art row for row.
 * Then Bea reloads and is the same member, walks through the left house's
 * door, and the terminal sees the square empty of her.
 *
 * The tab is read by geometry, never by the DOM's own bookkeeping: a cell's
 * glyph is whatever `elementFromPoint` finds at that cell's center, counted
 * in the art's `ch`/`lh` cells. A figure whose units disagreed with the art's
 * would read as the art under it.
 *
 * Traps:
 * - Each screen is fogged for its own figure (6.3), so the art is compared
 *   where the tab draws it, and the color cell is one the tab's figure sees.
 * - The server states a build (`FJS_BUILD`) and the page is served as
 *   another (`VITE_FJS_BUILD`), so the page must say it is stale. Both are
 *   set here; a dev server of Haven's own states no build and says nothing.
 * - The dev server is this drive's own, on a port nobody answers on; one
 *   that already answers is refused rather than reused (`FJS-740`).
 * - A move past 10 a second is dropped by the server in silence, so each
 *   step waits for the screen before the next.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { openChrome } from '../../../mesa/src/drive.js'
import { buildHavenApp } from '../../api/src/app.ts'
import { POST_KEY, signIn } from '../../api/test/sign-in.ts'
import { cellOf, terminal, until } from './terminal.mjs'
import { litAt } from '../src/lib/scene/stage.js'
import { DAY_MS } from '#shared/sky.js'
import { stageOf } from './stage.mjs'

const WEB  = join(import.meta.dir, '..')
const square = await stageOf('Square')
const tavern = await stageOf('Tavern')
const VITE = join(WEB, '../node_modules/.bin/vite')

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const freePort = () => new Promise((resolve) => {
  const s = createServer()
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)) })
})
const answers = (url) => fetch(url).then(() => true, () => false)

// ─── Haven ─────────────────────────────────────────────────────────

process.env.FJS_BUILD = 'haven-server-build'
const env = await createTestEnv({
  schema: join(WEB, '../db/schema.lite'),
  listen: true,
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-browser', port: 0, postKey: POST_KEY }),
})
await env.system.room.create({ data: { slug: 'square', name: 'The square' } })
await env.system.room.create({ data: { slug: 'tavern', name: 'The tavern' } })
const API = `http://localhost:${env.port}`

// ─── the browser build ────────────────────────────────────────────────

const webPort = await freePort()
const WEB_ORIGIN = `http://localhost:${webPort}`
if (await answers(WEB_ORIGIN)) {
  console.log(`✗ ${WEB_ORIGIN} already answers — refusing to drive a server this run did not start`)
  process.exit(1)
}
const vite = spawn(VITE, ['-c', 'config/vite.config.js'], {
  cwd: WEB, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, API_PORT: String(env.port), WEB_PORT: String(webPort), VITE_FJS_BUILD: 'haven-page-build' },
})
let viteLog = ''
vite.stdout.on('data', (d) => { viteLog += d })
vite.stderr.on('data', (d) => { viteLog += d })
const stopVite = () => { try { process.kill(-vite.pid, 'SIGTERM') } catch {} }
process.on('exit', stopVite)

const served = await until(async () => (await fetch(WEB_ORIGIN).then((r) => r.text(), () => '')).includes('id="app"'), 30000)
check(served, `the browser haven's dev server answers on ${webPort}`, viteLog)
if (!served) { stopVite(); await env.close(); process.exit(1) }

// ─── Sam, in a terminal ───────────────────────────────────────────────

const sam = await signIn(env.port, 'sam')
const term = terminal(API, sam.token, square)
const { x: sx, y: sy } = square.spawn

check(await until(() => term.screen().includes('j/k moves, Enter opens')), 'the terminal lists the square', term.screen())
term.shell.stdin.write('\r')
check(await until(() => term.at(sx, sy) === '@' && term.screen().includes('1 here')), 'Sam walks into the square', term.screen())

const samX = sx + 4
for (let x = sx + 1; x <= samX; x++) {
  term.shell.stdin.write('\x1b[C')
  await until(() => term.at(x, sy) === '@', 3000)
}
check(term.at(samX, sy) === '@', 'and four steps right', term.screen())

// ─── Bea, in a browser tab ────────────────────────────────────────────

const browser = await openChrome({ windowSize: '1400,1000' })

/** What the tab draws on scene cells `x`..`x+width-1` of row `y`, read at each cell's center. */
const tabCells = (x, y, width = 1) => browser.evaluate(`
  const pre = document.querySelector('pre[data-art]')
  if (!pre) return null
  const box   = pre.parentElement
  const lines = pre.textContent.split('\\n')
  const cols  = Math.max(...lines.map((l) => l.length))
  const r  = box.getBoundingClientRect()
  const cw = r.width / cols
  const lh = r.height / lines.length
  let out = ''
  for (let i = 0; i < ${width}; i++) {
    const px = r.left + (${x} + i + 0.5) * cw
    const py = r.top + (${y} + 0.5) * lh
    const el = document.elementFromPoint(px, py)
    if (el && pre.contains(el)) { out += lines[${y}]?.[${x} + i] ?? ' '; continue }
    const fig = el?.closest('p, pre')
    if (fig && box.contains(fig)) {
      const fr = fig.getBoundingClientRect()
      out += fig.textContent[Math.floor((px - fr.left) / cw)] ?? ' '
      continue
    }
    out += '?'
  }
  return out
`)
const tabText = () => browser.evaluate('return document.body.innerText')

// Signed in the way `fli haven --browser` signs her in, and handed over the same way.
const bea = await signIn(env.port, 'bea')
await browser.navigate(`${WEB_ORIGIN}/#session=${bea.token}`)
check(await until(async () => (await tabText()).includes('2 here') && (await tabText()).includes('· sam')),
  "Bea's tab walks in on the session in its address, two here, and names Sam", await tabText())
check(await tabCells(sx, sy) === '@', "Bea's tab draws her own figure where a figure walks in", await tabCells(sx, sy))
check(await tabCells(samX, sy) === 'S', "Bea's tab draws Sam's figure on the cell Sam walked to", await tabCells(samX - 2, sy, 5))
check(await until(() => term.at(sx, sy) === 'B' && term.screen().includes('2 here') && term.screen().includes('· bea')),
  "Sam's terminal draws Bea's figure where she walked in, and names her", term.screen())

// ─── the art is one art ───────────────────────────────────────────────

const shape = await browser.evaluate(`
  const lines = document.querySelector('pre[data-art]').textContent.split('\\n')
  return { rows: lines.length, cols: Math.max(...lines.map((l) => l.length)), top: lines[0], bottom: lines[lines.length - 1] }
`)
const artRows = square.picture()
const view = square.view
check(shape.rows === view.h && shape.cols === view.w && square.width > view.w,
  `the tab draws the view at ${shape.cols}×${shape.rows}, the terminal's size, of a square ${square.width} wide`, JSON.stringify(shape))
// Where the square names the fog (6.3), each screen is fogged for its own
// figure: Bea at the spawn sees the bottom wall round her, and Sam, who
// started there, has seen every cell she sees and four columns more. So the
// tab's bottom row is a part of the terminal's, glyph for glyph, and the top
// wall -- nobody has walked near it -- is blank on both. Without the fog
// both rows are drawn whole on both.
const fogged     = square.layers.includes('fog')
const termTop    = cellOf(term.screen(), 0, 0, shape.cols, square).padEnd(shape.cols)
const termBottom = cellOf(term.screen(), 0, view.h - 1, shape.cols, square).padEnd(shape.cols)
const drawnCols  = [...shape.bottom].map((ch, i) => (ch !== ' ' ? i : -1)).filter((i) => i >= 0)
const darkCol    = [...artRows[view.h - 1]].findIndex((ch, i) => ch !== ' ' && !litAt(square, i, view.h - 1, square.spawn))
check(drawnCols.length > 0 && drawnCols.every((i) => shape.bottom[i] === termBottom[i]) && (!fogged || drawnCols.length < artRows[view.h - 1].trim().length),
  `the tab's bottom row of art, ${drawnCols.length} lit cells of it, is the terminal's cell for cell`, `tab:  ${shape.bottom}\nterm: ${termBottom}`)
if (fogged) {
  check(darkCol >= 0 && shape.bottom[darkCol] === ' ' && termBottom[darkCol] === ' ' && shape.top.trim() === '' && termTop.trim() === '',
    `and the wall at ${darkCol},${view.h - 1} and the whole top wall are blank on both: nobody has walked near them`, `tab:  ${shape.bottom}\nterm: ${termBottom}\ntab:  ${shape.top}\nterm: ${termTop}`)
} else {
  check(shape.top.trim() !== '' && shape.top.trimEnd() === termTop.trimEnd(),
    'and the top wall, nobody near it, is drawn on both, cell for cell', `tab:  ${shape.top}\nterm: ${termTop}`)
}

// A cell the palette colors, no clock but the sky moves (the same time of day three days on), and Bea sees from the spawn, read for its color in the tab.
const still = (() => {
  for (let y = 0; y < view.h; y++)
    for (let x = 0; x < view.w; x++) {
      const a = square.look(x, y, 0)
      if (a.fg && a.ch !== ' ' && square.look(x, y, 3 * DAY_MS + 123_457).fg === a.fg && litAt(square, x, y, square.spawn)) return { x, y }
    }
  return null
})()
const drawn = still && await browser.evaluate(`
  const pre = document.querySelector('pre[data-art]')
  const lines = pre.textContent.split('\\n')
  const r = pre.parentElement.getBoundingClientRect()
  const cw = r.width / Math.max(...lines.map((l) => l.length)), lh = r.height / lines.length
  const el = document.elementFromPoint(r.left + (${still?.x} + 0.5) * cw, r.top + (${still?.y} + 0.5) * lh)
  return getComputedStyle(el).color
`)
const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`
// The tab draws the sky it is under, so the color expected is the stage's at this moment.
const wanted = still && square.look(still.x, still.y, Date.now()).fg
check(still && drawn === rgb(wanted), `the tab colors a cell from the scene's palette, under the sky (${still?.x},${still?.y} ${wanted})`, String(drawn))

const tick = square.tickOf()
const art = () => browser.evaluate(`return document.querySelector('pre[data-art]').innerHTML`)
const before = await art()
check(!tick || await until(async () => await art() !== before, tick * 4), `and keeps it moving on the wall clock, every ${tick}ms`)

// ─── Bea walks and speaks ─────────────────────────────────────────────

// Left, away from Sam: a bubble is eight cells wide, and two that overlap
// cover each other, so each line is read where only its own bubble is.
const beaX = sx - 6
for (let x = sx - 1; x >= beaX; x--) {
  await browser.press('ArrowLeft')
  await until(async () => await tabCells(x, sy) === '@', 3000)
  await sleep(150)
}
check(await tabCells(beaX, sy) === '@', 'six ArrowLefts move Bea six cells in her tab', await tabCells(beaX - 1, sy, 8))
check(await until(() => term.at(beaX, sy) === 'B' && term.at(sx, sy) !== 'B'),
  "Sam's terminal sees Bea's figure move to the same cell", term.screen())

await browser.type('hi sam')
await browser.press('Enter')
check(await until(() => term.at(beaX, sy - 2, 8) === '(hi sam)'),
  "Bea's line shows as a bubble over her figure in Sam's terminal", term.screen())

term.shell.stdin.write('i')
await new Promise((r) => setTimeout(r, 200))
term.shell.stdin.write('hi bea')
await until(() => term.screen().includes('hi bea'))
term.shell.stdin.write('\r')
check(await until(async () => await tabCells(samX, sy - 2, 8) === '(hi bea)'),
  "Sam's line shows as a bubble over his figure in Bea's tab", await tabCells(samX, sy - 2, 8))

await browser.press('PageUp')
check(await until(async () => { const t = await tabText(); return t.includes('bea: hi sam') && t.includes('sam: hi bea') && t.includes('PageDown newer') }),
  "PageUp opens the square's history in Bea's tab, both lines signed, oldest first", await tabText())
check(await until(() => term.at(samX, sy - 2, 8) === '(hi bea)' && !term.screen().includes('PageDown newer')),
  "and Sam's terminal shows nothing of it", term.screen())
await browser.press('PageDown')
check(await until(async () => !(await tabText()).includes('PageDown newer') && await tabCells(beaX, sy) === '@'),
  'PageDown closes it, Bea where she stood', await tabText())

check(await until(async () => (await tabText()).includes('Reload to walk in with it')),
  'a server on another build than the page says so on the page (x-fjs-build)', await tabText())

// ─── the session is the tab's, not its address ─────────────────────────

const held = await browser.evaluate(`return { hash: location.hash, kept: localStorage.getItem('haven_token') }`)
check(held?.hash === '' && held?.kept === bea.token, "the address no longer carries the session, and the client's tokenStorage does", JSON.stringify(held))

await browser.navigate(`${WEB_ORIGIN}/`)
check(await until(async () => (await tabText()).includes('2 here') && await tabCells(sx, sy) === '@'),
  'a reload walks in again, with nothing handed', await tabText())
const beas = await env.system.member.findMany({ where: { nick: 'bea' } })
check(beas.length === 1 && beas[0].id === bea.id, 'and is the same member', JSON.stringify(beas))

// ─── the door ─────────────────────────────────────────────────────────

/** Arrow keys from `from` to `to` over walkable cells, breadth first. */
function route(scene, from, to) {
  const key = (p) => `${p.x},${p.y}`
  const prev = new Map([[key(from), null]])
  const queue = [from]
  const STEPS = [['ArrowLeft', -1, 0], ['ArrowRight', 1, 0], ['ArrowUp', 0, -1], ['ArrowDown', 0, 1]]
  while (queue.length) {
    const p = queue.shift()
    if (p.x === to.x && p.y === to.y) break
    for (const [k, dx, dy] of STEPS) {
      const n = { x: p.x + dx, y: p.y + dy }
      if (prev.has(key(n)) || scene.doorAt(n.x, n.y) || !scene.walkable(n.x, n.y)) continue
      prev.set(key(n), { p, k, n })
      queue.push(n)
    }
  }
  const keys = []
  for (let at = prev.get(key(to)); at; at = prev.get(key(at.p))) keys.unshift({ k: at.k, n: at.n })
  return keys
}

const door = square.doors.find((d) => d.to === '/tavern/')
const inFront = { x: door.x, y: door.y + 1 }
const path = route(square, square.spawn, inFront)
let walked = path.length > 0
for (const { k, n } of path) {
  await browser.press(k)
  if (!await until(async () => await tabCells(n.x, n.y) === '@', 3000)) { walked = false; break }
  await sleep(120)
}
check(walked, `Bea walks ${path.length} steps to the left house's door in her tab`, await tabText())
await browser.press('ArrowUp')
check(await until(async () => (await tabText()).includes('The tavern · 1 here') && await tabCells(tavern.spawn.x, tavern.spawn.y) === '@'),
  'stepping onto it opens the tavern in the tab, Bea inside its door', await tabText())
check(await until(() => term.screen().includes('The square · 1 here') && !term.screen().includes('· bea')),
  "Sam's terminal sees the square without her", term.screen())

// The map: a scene walked into is a record in the tab's own IndexedDB
// (`seen.browser.js`), and `/map` draws the two this tab has been in.
await browser.type('/map')
await browser.press('Enter')
check(await until(async () => { const t = await tabText(); return t.includes('the map · @ you') && /\bsquare\b/.test(t) && /\btavern\b/.test(t) }),
  '/map in the tab draws the square and the tavern it has walked into', await tabText())
const seenKept = await browser.evaluate(`
  const db = await new Promise((r, j) => { const o = indexedDB.open('haven-seen'); o.onsuccess = () => r(o.result); o.onerror = () => j(o.error) })
  const keys = await new Promise((r) => { const q = db.transaction('scenes').objectStore('scenes').getAllKeys(); q.onsuccess = () => r(q.result) })
  db.close()
  return keys.sort().join()`)
check(seenKept === 'square,tavern', `the tab keeps a record per scene in IndexedDB: ${seenKept}`)
await browser.press('Escape')
check(await until(async () => !(await tabText()).includes('the map · @ you')), 'Esc closes the map in the tab', await tabText())

check(browser.errors.length === 0, 'the tab threw nothing and logged no error', browser.errors.join('\n'))

// ─── done ─────────────────────────────────────────────────────────────

term.shell.stdin.write('\x03')
const code = await Promise.race([term.exited, sleep(5000).then(() => 'timeout')])
if (code === 'timeout') term.shell.kill('SIGKILL')
await browser.close()
stopVite()
await env.close()

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
