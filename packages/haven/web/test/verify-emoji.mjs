/**
 * web/test/verify-emoji.mjs — emoji in what is said, on both targets
 * (`IDEAS/haven.md` 14.3). Started by `bun run verify:emoji`; needs Chrome,
 * util-linux `script`, and no TTY of its own.
 *
 * Haven's API runs in this process over a fresh test database, with this
 * package's own Vite dev server for the browser build. Sam is Sierra's shell
 * under a pty, Bea a headless Chrome tab, as in `verify-browser.mjs`. Each
 * says a line holding a single emoji, a CJK pair, a skin tone, a ZWJ sequence
 * and a flag, and it is read off the OTHER screen: in the terminal a bubble
 * whose cells are its text and whose row past it is the art it covered
 * before, in the tab a bubble placed on its cell. Sam's line is typed into
 * his input line as a terminal writes it, one chunk, and Backspace takes the
 * flag off its end whole; Bea's is put in her field as an emoji picker puts
 * it (`Input.insertText`). Then PageUp on both, and the two sit across the
 * tavern table and talk in a booth: on each screen the bubble of the one
 * across ends on the column's right edge, counted in cells.
 *
 * A browser draws an emoji in its emoji font, whose advance is not two `ch`
 * of the scene's font. So a tab's bubble is read for where it STARTS, and
 * how far its emoji run past two cells each is printed, not asserted.
 *
 * Traps:
 * - `screen()` gives a wide grapheme two cells, the second `''`, so a row
 *   holding one is shorter as a string than the cells it spans: a cell past it
 *   is found from the cells before, never by `cellOf`'s string index.
 * - Each screen is fogged for its own figure, so the art a bubble is checked
 *   against is the row Sam's screen drew just before the line came.
 * - A move past 10 a second is dropped by the server in silence, so each
 *   step waits for the screen before the next.
 * - The drive's `type()` sends a key per code point and drops a character
 *   outside the BMP, so emoji go in by `Input.insertText`.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTestEnv } from '@frontierjs/testing'

import { openChrome } from '../../../mesa/src/drive.js'
import { buildHavenApp } from '../../api/src/app.ts'
import { ROOMS } from '../../api/src/rooms.ts'
import { POST_KEY, signIn } from '../../api/test/sign-in.ts'
import { COLUMN } from '../src/lib/games/booth.js'
import { cells } from '../src/lib/scene/cells.js'
import { artOf, cellOf, terminal, until } from './terminal.mjs'
import { stageOf } from './stage.mjs'

const WEB    = join(import.meta.dir, '..')
const VITE   = join(WEB, '../node_modules/.bin/vite')
const square = await stageOf('Square')
const tavern = await stageOf('Tavern')

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}
const note  = (text) => console.log(`  · ${text}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const freePort = () => new Promise((resolve) => {
  const s = createServer()
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)) })
})
const answers = (url) => fetch(url).then(() => true, () => false)

const SAMS = 'sam 🙂 中文 👍🏽 👩‍💻 🇯🇵'
const BEAS = 'bea 🙂 中文 👍🏽 👩‍💻 🇯🇵'

// ─── Haven ────────────────────────────────────────────────────────────

const env = await createTestEnv({
  schema: join(WEB, '../db/schema.lite'),
  listen: true,
  api:    ({ db }) => buildHavenApp({ db, sessionKey: 'verify-emoji', port: 0, postKey: POST_KEY }),
})
for (const room of ROOMS) await env.system.room.create({ data: { ...room } })
const API = `http://localhost:${env.port}`

const webPort = await freePort()
const WEB_ORIGIN = `http://localhost:${webPort}`
if (await answers(WEB_ORIGIN)) {
  console.log(`✗ ${WEB_ORIGIN} already answers — refusing to drive a server this run did not start`)
  process.exit(1)
}
const vite = spawn(VITE, ['-c', 'config/vite.config.js'], {
  cwd: WEB, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, API_PORT: String(env.port), WEB_PORT: String(webPort) },
})
let viteLog = ''
vite.stdout.on('data', (d) => { viteLog += d })
vite.stderr.on('data', (d) => { viteLog += d })
const stopVite = () => { try { process.kill(-vite.pid, 'SIGTERM') } catch {} }
process.on('exit', stopVite)
const served = await until(async () => (await fetch(WEB_ORIGIN).then((r) => r.text(), () => '')).includes('id="app"'), 30000)
check(served, `the browser haven's dev server answers on ${webPort}`, viteLog)
if (!served) { stopVite(); await env.close(); process.exit(1) }

// ─── reading a screen ─────────────────────────────────────────────────

const home = mkdtempSync(join(tmpdir(), 'haven-emoji-sam-'))
const sam  = await signIn(env.port, 'sam')
const term = terminal(API, sam.token, square, { HOME: home })
const at   = (x, y, stage = square) => cellOf(term.screen(), x, y, 1, stage)

/** Row `y` of the scene's view on Sam's screen, from the art's left edge, or null with no room drawn. */
function termRow(y, stage = square) {
  const lines = term.screen().split('\n')
  const art   = artOf(lines, stage.view.h)
  if (!art) return null
  return (lines[art.top + y - stage.view.y] ?? '').slice(art.left)
}

/**
 * Where `text` sits on a row read off Sam's screen, in cells: `{ col, end }`,
 * or null. The cells before it are counted, since one of them may be wide.
 */
function cellsAt(row, text) {
  const i = row?.indexOf(text) ?? -1
  return i < 0 ? null : { col: cells(row.slice(0, i)), end: cells(row.slice(0, i)) + cells(text) }
}

const KEY = { '0,-1': '\x1b[A', '0,1': '\x1b[B', '1,0': '\x1b[C', '-1,0': '\x1b[D' }
const TAB_KEY = { '0,-1': 'ArrowUp', '0,1': 'ArrowDown', '1,0': 'ArrowRight', '-1,0': 'ArrowLeft' }

/** The cells from `from` to `to` over floor, breadth first; `to` itself may be a seat or a door. */
function route(stage, from, to) {
  const prev = new Map([[`${from.x},${from.y}`, null]])
  const queue = [from]
  while (queue.length) {
    const c = queue.shift()
    if (c.x === to.x && c.y === to.y) break
    for (const [dx, dy] of [[0, -1], [0, 1], [1, 0], [-1, 0]]) {
      const n = { x: c.x + dx, y: c.y + dy }
      const k = `${n.x},${n.y}`
      const end = n.x === to.x && n.y === to.y
      if (prev.has(k) || !(end || (stage.walkable(n.x, n.y) && !stage.doorAt(n.x, n.y)))) continue
      prev.set(k, c)
      queue.push(n)
    }
  }
  const out = []
  for (let c = to; c; c = prev.get(`${c.x},${c.y}`)) out.unshift(c)
  return out[0]?.x === from.x && out[0]?.y === from.y ? out : null
}

const browser = await openChrome({ windowSize: '1400,1000' })
const tabText = () => browser.evaluate('return document.body.innerText')

/** The tab's art box: its left and top, and one cell's width and height, in px. */
const ART = `
  const pre = document.querySelector('pre[data-art]')
  const lines = pre.textContent.split('\\n')
  const r = pre.parentElement.getBoundingClientRect()
  const cw = r.width / Math.max(...lines.map((l) => l.length)), lh = r.height / lines.length`

/** What the tab draws at scene cell `x, y`: the art's glyph, or a placed box's text. */
const tabAt = (x, y) => browser.evaluate(`${ART}
  const el = document.elementFromPoint(r.left + (${x} + 0.5) * cw, r.top + (${y} + 0.5) * lh)
  if (el && pre.contains(el)) return lines[${y}]?.[${x}] ?? ' '
  return el?.closest('p, pre')?.textContent ?? null`)

/** The tab's box holding exactly `text`, as cells of its art: `{ col, row, w }`, or null. */
const tabBox = (text) => browser.evaluate(`${ART}
  const p = [...pre.parentElement.querySelectorAll('p, pre')].find((p) => p.textContent === ${JSON.stringify(text)})
  if (!p) return null
  const b = p.getBoundingClientRect()
  return { col: Math.round((b.left - r.left) / cw * 10) / 10, row: Math.round((b.top - r.top) / lh * 10) / 10, w: Math.round(b.width / cw * 10) / 10 }`)

async function walkTerm(stage, path, arrived) {
  if (!path) return false
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i]
    term.write(KEY[`${b.x - a.x},${b.y - a.y}`])
    const last = i === path.length - 1
    if (!await until(() => (last && arrived ? arrived() : at(b.x, b.y, stage) === '@'), 3000)) return false
  }
  return true
}

async function walkTab(stage, path, arrived) {
  if (!path) return false
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i]
    await browser.press(TAB_KEY[`${b.x - a.x},${b.y - a.y}`])
    const last = i === path.length - 1
    if (!await until(async () => (last && arrived ? arrived() : await tabAt(b.x, b.y) === '@'), 3000)) return false
    await sleep(120)
  }
  return true
}

// ─── into the square ──────────────────────────────────────────────────

const { x: sx, y: sy } = square.spawn
check(await until(() => term.screen().includes('j/k moves, Enter opens')), 'the terminal lists the routes', term.screen())
term.write('\r')
check(await until(() => at(sx, sy) === '@' && term.screen().includes('1 here')), 'Sam walks into the square', term.screen())

const beaIn = await signIn(env.port, 'bea')
await browser.navigate(`${WEB_ORIGIN}/#session=${beaIn.token}`)
check(await until(async () => (await tabText()).includes('2 here')), "Bea's tab walks in", await tabText())

// Bea six cells left of the spawn and Sam three rows up from it, so the two
// bubbles are on rows of their own and each is read where only it is.
const bea = { x: sx - 6, y: sy }
check(await walkTab(square, route(square, square.spawn, bea)), 'Bea walks six cells left in her tab', await tabText())
const samAt = [{ x: sx + 2, y: sy - 3 }, { x: sx + 4, y: sy - 3 }, { x: sx + 2, y: sy - 4 }].find((c) => square.walkable(c.x, c.y))
check(await walkTerm(square, route(square, square.spawn, samAt)), `Sam walks to ${samAt.x},${samAt.y}`, term.screen())
check(await until(() => at(bea.x, bea.y) === 'B'), "Sam's screen draws Bea where she stands", term.screen())

// ─── Bea says it, Sam reads it ────────────────────────────────────────

const beforeBea = termRow(bea.y - 2)
await browser.cmd('Input.insertText', { text: BEAS })
check(await browser.evaluate('return document.querySelector("form textarea").value') === BEAS, "an emoji picker's text is Bea's line, whole", await browser.evaluate('return document.querySelector("form textarea").value'))
await browser.press('Enter')
const bBubble = `(${BEAS})`
check(await until(() => cellsAt(termRow(bea.y - 2), bBubble)?.col === bea.x - square.view.x),
  "Bea's line is a bubble over her figure on Sam's screen, starting on her cell", termRow(bea.y - 2))
const bAt = cellsAt(termRow(bea.y - 2), bBubble)
const afterBea = termRow(bea.y - 2)
const tail = afterBea.slice(afterBea.indexOf(bBubble) + bBubble.length).trimEnd()
check(bAt.end - bAt.col === cells(bBubble) && tail === beforeBea.slice(bAt.end).trimEnd(),
  `the bubble takes ${cells(bBubble)} cells and the art past it is the art it covered before`, `before: ${beforeBea}\nafter:  ${afterBea}`)

// ─── Sam types it, Bea reads it ───────────────────────────────────────

term.write('i')
await until(() => term.screen().includes('-- INSERT --'))
term.write(SAMS)
check(await until(() => term.screen().includes(SAMS)), 'Sam types his line, written as one chunk, and his input line holds it whole', term.screen())
term.write('\x7f')
// Trimmed: a screen row loses its trailing space, which the flag sat after.
const lessFlag = SAMS.slice(0, -'🇯🇵'.length).trimEnd()
// The input line is the row that starts with it; ui's Textbox paints its mode on the row under it.
const inputLine = () => term.screen().split('\n').find((r) => r.startsWith(lessFlag)) ?? ''
check(await until(() => inputLine().startsWith(lessFlag) && !inputLine().includes('🇯')),
  'Backspace takes the flag off the end whole, not half of it', inputLine())
term.write('🇯🇵\r')
const sBubble = `(${SAMS})`
const sBox = await until(async () => (await tabBox(sBubble))?.col === samAt.x - square.view.x)
check(sBox, "Sam's line is a bubble over his figure in Bea's tab, starting on his cell", JSON.stringify(await tabBox(sBubble)))
const box = await tabBox(sBubble)
note(`the tab's bubble is ${box?.w} cells wide for ${cells(sBubble)} counted: the emoji font's advance is not 2ch`)
check(await until(() => cellsAt(termRow(samAt.y - 2), sBubble)?.col === samAt.x - square.view.x), 'and over him on his own screen', termRow(samAt.y - 2))

// Bea in her field: Backspace over a ZWJ sequence.
await browser.cmd('Input.insertText', { text: 'x👩‍💻' })
await browser.press('Backspace')
check(await browser.evaluate('return document.querySelector("form textarea").value') === 'x', "Backspace in the tab's field takes the ZWJ sequence whole",
  await browser.evaluate('return document.querySelector("form textarea").value'))
await browser.press('Backspace')

// ─── the history ──────────────────────────────────────────────────────

term.write('\x1b[5~')
check(await until(() => term.screen().includes(`bea: ${BEAS}`) && term.screen().includes(`sam: ${SAMS}`) && term.screen().includes('PageDown newer')),
  "PageUp on Sam's screen: both lines whole in the history pane", term.screen())
term.write('\x1b[6~')
check(await until(() => !term.screen().includes('PageDown newer')), 'PageDown closes it', term.screen())

await browser.press('PageUp')
check(await until(async () => { const t = await tabText(); return t.includes(`bea: ${BEAS}`) && t.includes(`sam: ${SAMS}`) && t.includes('PageDown newer') }),
  "PageUp in Bea's tab: both lines whole", await tabText())
await browser.press('PageDown')
check(await until(async () => !(await tabText()).includes('PageDown newer')), 'PageDown closes it in the tab', await tabText())

// ─── the booth ────────────────────────────────────────────────────────

const door   = square.doors.find((d) => d.to === '/tavern/')
const back   = tavern.doors.find((d) => d.to === '/')
const inside = { x: back.x, y: back.y - 1 }
const inTavern = (s) => s.includes('The tavern')

term.write('\x1b')
await until(() => term.screen().includes('-- NORMAL --'))
check(await walkTerm(square, route(square, samAt, door), () => inTavern(term.screen()) && at(inside.x, inside.y, tavern) === '@'),
  'Sam walks into the tavern', term.screen())
check(await walkTab(square, route(square, bea, door), async () => (await tabText()).includes('The tavern') && await tabAt(inside.x, inside.y) === '@'),
  'Bea walks into the tavern in her tab', await tabText())

const table = tavern.marks.find((m) => m.piece?.name === 'table' && m.x === 49 && m.y === 16)
const left  = table.spot('west')
const right = table.spot('east')
check(await walkTerm(tavern, route(tavern, inside, left)), 'Sam sits on the left stool', term.screen())
check(await walkTab(tavern, route(tavern, inside, right), async () => /across the table/.test(await tabText())), 'Bea sits on the right, and her tab is the booth', await tabText())
check(await until(() => /across the table/.test(term.screen())), "and Sam's screen is the booth", term.screen())

term.write('i')
await sleep(200)
term.write(`${SAMS}\r`)
const sRow = `( ${SAMS} )`
await browser.cmd('Input.insertText', { text: '中文中文 🇯🇵👍🏽' })
await browser.press('Enter')
const bRow = '( 中文中文 🇯🇵👍🏽 )'

const rowWith = (text) => term.screen().split('\n').find((l) => l.includes(text))
check(await until(() => rowWith(sRow) && rowWith(bRow)), 'both lines are bubbles on Sam\'s screen', term.screen())
const mine   = cellsAt(rowWith(sRow), sRow)
const theirs = cellsAt(rowWith(bRow), bRow)
check(mine && theirs && theirs.end - mine.col === COLUMN.w,
  `on Sam's screen his starts the column and hers ends it, ${COLUMN.w} cells on, counted in cells`, `${JSON.stringify(mine)} ${JSON.stringify(theirs)}\n${term.screen()}`)

const tMine   = await until(async () => await tabBox(bRow) && await tabBox(sRow)) && await tabBox(bRow)
const tTheirs = await tabBox(sRow)
check(tMine && tTheirs && tTheirs.col === tMine.col + COLUMN.w - cells(sRow),
  "in Bea's tab hers starts the column and Sam's is placed to end it, by its cells", `${JSON.stringify(tMine)} ${JSON.stringify(tTheirs)}`)
note(`Sam's bubble in the tab ends ${tTheirs ? Math.round((tTheirs.col + tTheirs.w - tMine.col - COLUMN.w) * 10) / 10 : '?'} cells past the column's edge: the emoji font again`)

check(browser.errors.length === 0, 'the tab threw nothing and logged no error', browser.errors.join('\n'))

// ─── done ─────────────────────────────────────────────────────────────

term.write('\x03')
const code = await Promise.race([term.exited, sleep(5000).then(() => 'timeout')])
if (code === 'timeout') term.shell.kill('SIGKILL')
await browser.close()
stopVite()
await env.close()
rmSync(home, { recursive: true, force: true })

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
