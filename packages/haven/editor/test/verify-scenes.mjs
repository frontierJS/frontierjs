/**
 * editor/test/verify-scenes.mjs — the scene editor driven in a real browser
 * (`IDEAS/haven.md` 5.7). Started by `bun run verify:scenes`; needs Chrome.
 *
 * The editor's own Vite server, on a port nobody answers on, with
 * `SCENES_DIR` pointed at a copy of `web/src` made INSIDE this package, so
 * every save this drive makes lands in the copy and never in the tree, and
 * the copy's `#paint` still resolves through the package's own `imports`. A
 * headless tab opens the tavern and works it the way a person does — clicks
 * on the preview's cells, arrows, Delete, a typed door, a color picked — and
 * every check reads either the page or the file the page saved:
 *
 * - an unedited scene is the real component drawn at its size with nothing
 *   wrong and nothing to save;
 * - a click selects the piece on that cell and an arrow moves it a cell, the
 *   art moving with it; a move onto another piece is refused naming the cell
 *   and the piece stays; Ctrl+Z undoes the move and Ctrl+Shift+Z redoes it;
 * - a shared piece is placed by click and imports itself; the spawn moves by
 *   click; a door's target is typed; a palette color is picked; Delete
 *   removes a piece;
 * - Save writes all of it into the file's own text as attribute edits, a
 *   removed line, an added tag and an import, and the saved file mounts
 *   headless with the door, the lamp and the spawn where they were put;
 * - after the save and a reload, Ctrl+Z still undoes the edit before it;
 * - a block of art pasted in is recognized as two tables and placed, and the
 *   spawn they cover is listed as a problem;
 * - the ask panel (14.1) is served, the inspector and the ask are rooted at
 *   the copy's `web/src`, a shift+alt-click on a table picks its tag's line,
 *   and a send runs `claude` with Edit scoped to `web/src` and that line in
 *   the prompt; the edit it makes swaps the editor onto the moved table.
 *
 * Traps:
 * - A cell is clicked at its center in the scene box's own `ch`/`lh` units,
 *   read off the box `paint.browser.js` laid out, so a preview laid out in
 *   other units clicks the wrong cell and the check after it names the cell
 *   it expected.
 * - A color input cannot be typed into; its value is set and an `input`
 *   event dispatched, which is what the picker does when it closes.
 * - The copy is `editor/.copy-<pid>/`: a copy under `/tmp` has no
 *   `package.json` above it, and `#paint` resolves to nothing there.
 * - `claude` is a stub first on the server's PATH, so no model is paid for:
 *   it records what it was run with and makes one edit to the copy, as
 *   Claude's Edit tool would.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { openChrome } from '../../../mesa/src/drive.js'
import { readScene } from '../source.js'
import { table } from '../../web/src/pieces/table.js'
import { mountScene } from '../../web/test/stage.mjs'

const PKG  = join(import.meta.dir, '../..')
const VITE = join(PKG, 'node_modules/.bin/vite')
const SRC  = join(PKG, 'web/src')

let failed = 0
const check = (ok, label, evidence = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) { failed++; if (evidence) console.log(evidence) }
}
const until = async (pred, ms = 10000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 50)) }
  return false
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((resolve) => {
  const s = createServer()
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

// ─── the editor, over a copy ──────────────────────────────────────────

const root = join(PKG, 'editor', `.copy-${process.pid}`)
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
// The package's own layout, so the web's relative imports of the rules it
// shares with the server (`shared/hearing.ts`, `memory.ts`, `pacer.ts`) land
// on the copy of them; a file left out is a preview that draws nothing.
cpSync(SRC, join(root, 'web/src'), { recursive: true })
cpSync(join(PKG, 'api/src'), join(root, 'api/src'), { recursive: true })
const SCENE = join(root, 'web/src/components/scenes/Tavern.mesa')
const original = readFileSync(SCENE, 'utf8')

const SEEN = join(root, 'claude-seen.json')
mkdirSync(join(root, 'bin'))
// Bun, not node: the copy sits under this package's `"type": "module"`.
writeFileSync(join(root, 'bin/claude'), `#!/usr/bin/env bun
const fs = require('fs')
fs.writeFileSync(${JSON.stringify(SEEN)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), input: fs.readFileSync(0, 'utf8') }))
const scene = ${JSON.stringify(SCENE)}
fs.writeFileSync(scene, fs.readFileSync(scene, 'utf8').replace('x={10}  y={14}', 'x={12}  y={14}'))
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\\n')
`)
chmodSync(join(root, 'bin/claude'), 0o755)

const port = await freePort()
const URL_ = `http://localhost:${port}`
if (await fetch(URL_).then(() => true, () => false)) {
  console.log(`✗ ${URL_} already answers — refusing to drive a server this run did not start`)
  process.exit(1)
}
const vite = spawn(VITE, ['-c', 'editor/vite.config.js'], {
  cwd: PKG, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(port), SCENES_DIR: join(root, 'web/src/components/scenes'), PATH: `${join(root, 'bin')}:${process.env.PATH}` },
})
let viteLog = ''
vite.stdout.on('data', (d) => { viteLog += d })
vite.stderr.on('data', (d) => { viteLog += d })
const cleanup = () => {
  try { process.kill(-vite.pid, 'SIGTERM') } catch {}
  rmSync(root, { recursive: true, force: true })
}
process.on('exit', cleanup)

const served = await until(async () => (await fetch(URL_).then((r) => r.text(), () => '')).includes('id="app"'), 30000)
check(served, `the editor's dev server answers on ${port}`, viteLog)
if (!served) process.exit(1)

const browser = await openChrome({ windowSize: '1600,1100' })
const page = (js) => browser.evaluate(js)
const text = (sel) => page(`return document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`)
const art  = async () => (await text('pre[data-art]'))?.split('\n') ?? []
// What is drawn in the air — a lamp's head, a canopy — is the layer over the
// art (`paint.browser.js`), not the art.
const overhead = async () => (await page(`return { t: document.querySelector('pre[data-art]')?.nextElementSibling?.textContent ?? '' }`)).t.split('\n')
const ALT = 1, CTRL = 2, SHIFT = 8
// A table's middle row with its left stool at `x`. The candle is `i` lit and
// `.` unlit, and lit only while a stool is taken, so it is either here.
const tableAt = (row, x) => /^o\|U  [i.]  U\|o$/.test(row?.slice(x, x + 11) ?? '')

/** Click scene cell `x`,`y` of the preview at its center, with CDP `modifiers` held. */
async function clickCell(x, y, modifiers = 0) {
  const p = await page(`
    const box = document.querySelector('pre[data-art]').parentElement
    const lines = box.querySelector('pre[data-art]').textContent.split('\\n')
    const r = box.getBoundingClientRect()
    const cw = r.width / Math.max(...lines.map((l) => l.length))
    const lh = r.height / lines.length
    return { x: r.left + (${x} + 0.5) * cw, y: r.top + (${y} + 0.5) * lh }
  `)
  // The inspector arms on a move with its modifier held, never on the press.
  if (modifiers) await browser.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, modifiers })
  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.cmd('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0, modifiers })
  }
}

/** The scene cells a tone's marks sit on, read by geometry. */
const marksOf = (tone) => page(`
  const box = document.querySelector('pre[data-art]').parentElement
  const lines = box.querySelector('pre[data-art]').textContent.split('\\n')
  const r = box.getBoundingClientRect()
  const cw = r.width / Math.max(...lines.map((l) => l.length))
  const lh = r.height / lines.length
  return [...document.querySelectorAll('[data-mark=${tone}]')].map((m) => {
    const q = m.getBoundingClientRect()
    return Math.round((q.left - r.left) / cw) + ',' + Math.round((q.top - r.top) / lh)
  })
`)
const mode = (label) => page(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
const saveEnabled = () => page(`return ![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save').disabled`)
const selected = () => text('[data-selected]')
const selectedIs = (s) => until(async () => (await selected())?.includes(s))

// ─── an unedited scene ────────────────────────────────────────────────

await browser.navigate(`${URL_}/#Tavern.mesa`)
check(await until(async () => (await art()).length === 26), 'the tavern opens, the real component drawn as the preview', await text('[data-status]'))
const rows = await art()
check(rows.length === 26 && Math.max(...rows.map((r) => r.length)) === 97, `the preview is 97×26, the scene's size`, `${rows.length} rows`)
check(rows[25].includes('n'), "the door's n is in the bottom wall")
check((await text('[data-problems]'))?.includes('The spawn reaches every door'), 'an unedited tavern has nothing wrong', await text('aside'))
check(!(await saveEnabled()), 'and nothing to save')
check((await marksOf('success')).join() === '48,24', 'the spawn is marked on its cell', JSON.stringify(await marksOf('success')))
check((await marksOf('warning')).join() === '48,25,75,15,95,13,17,21', 'both doors are marked on their cells, the hidden one too: the editor is where an author finds a secret', JSON.stringify(await marksOf('warning')))

// ─── a piece moved by arrow ───────────────────────────────────────────

await clickCell(10, 15)
check(await selectedIs('table at 9,14'), 'a click on a table selects it, named with its cell', await selected())
await browser.press('ArrowRight')
check(await selectedIs('table at 10,14'), 'ArrowRight moves it one cell right', await selected())
check(await until(async () => tableAt((await art())[15], 10)), 'and the art moves with it', (await art())[15])
check(await saveEnabled(), 'and there is something to save')

await clickCell(91, 15)
check(await selectedIs('barrel at 90,14'), 'a click on a barrel selects it', await selected())
await browser.press('ArrowDown')
check(await until(async () => (await text('[data-status]'))?.includes('cell 91,17 is claimed by both barrel and barrel')), 'a move onto another barrel is refused naming the cell and both', await text('[data-status]'))
check((await selected())?.includes('barrel at 90,14'), 'and the barrel stays where it was', await selected())

await clickCell(11, 15)
check(await selectedIs('table at 10,14'), 'the moved table is selected again')
await browser.press('z', CTRL)
check(await selectedIs('table at 9,14'), 'Ctrl+Z undoes the move', await selected())
check(await until(async () => tableAt((await art())[15], 9)), 'and the art goes back')
await browser.press('z', CTRL | SHIFT)
check(await selectedIs('table at 10,14'), 'Ctrl+Shift+Z redoes it', await selected())

// ─── placed, moved, typed, picked, removed ────────────────────────────

await mode('Place')
await page(`[...document.querySelectorAll('[data-pieces] button')].find((b) => b.textContent.trim().endsWith('lamp +')).click()`)
await clickCell(40, 20)
check(await selectedIs('lamp at 40,20'), 'a shared lamp is placed by click where it was clicked', await selected())
// The lamp's bulb is a `y` cell, which the tavern's palette flickers through `i!i`.
const lampAt = (row) => row?.[40] === '(' && row?.[42] === ')'
check(await until(async () => lampAt((await overhead())[20])), 'and drawn there', (await overhead())[20])
check(await page(`return document.querySelectorAll('pre[data-art]').length`) === 1, 'one preview is on the page')
check(await page(`return window.__stage.picture()[20].slice(40, 43)`) === '(o)', 'and the edited stage has the lamp', await page(`return window.__stage.picture()[20]`))

await mode('Spawn')
await clickCell(40, 13)
check(await until(async () => (await text('[data-spawn]')) === 'Spawn 40,13'), 'the spawn moves by click', await text('[data-spawn]'))
check((await marksOf('success')).join() === '40,13', 'and is marked there')

await mode('Select')
await clickCell(48, 25)
check(await selectedIs('Door'), 'a click on the door selects it', await selected())
await page(`
  const input = document.querySelector('[aria-label="Door target"]')
  input.value = '/square/'
  input.dispatchEvent(new Event('change', { bubbles: true }))
`)
check(await until(async () => (await text('aside'))?.includes('Door to /square/ at 48,25')), "a door's target is typed", await text('aside'))

await page(`
  const input = document.querySelector('[aria-label="f color 1"]')
  input.value = '#000000'
  input.dispatchEvent(new Event('input', { bubbles: true }))
`)
check(await until(async () => await page(`return getComputedStyle(document.querySelector('pre[data-art] span')).color`) === 'rgb(0, 0, 0)'), 'a palette color picked is drawn at once')

await clickCell(91, 21)
check(await selectedIs('barrel at 90,20'), 'a click on the lower barrel selects it', await selected())
await browser.press('Delete')
check(await until(async () => (await art())[21].slice(90, 96) === '      '), 'Delete removes it from the art', `${(await art())[21]}\nstage: ${await page(`return window.__stage.picture()[21]`)}`)
check((await selected())?.includes('Click a piece'), 'and nothing is selected')

// ─── saved into the file's own text ───────────────────────────────────

await mode('Save')
check(await until(async () => (await text('[data-status]'))?.startsWith('Saved Tavern.mesa')), 'Save writes the file', await text('[data-status]'))
const saved = readFileSync(SCENE, 'utf8')
check(saved !== original, 'the saved file differs from the original')
check(saved.includes('<Piece of={table}   x={10}  y={14} />'), 'the moved table is its attribute edit, in place', saved.split('\n').filter((l) => l.includes('table')).join('\n'))
check(!saved.includes('x={90} y={20}'), 'the removed barrel took its line with it')
check(saved.includes("import { lamp } from '@/pieces/lamp.js'\n") && saved.includes('<Piece of={lamp} x={40} y={20} />\n</Scene>'), 'the lamp is imported and placed before </Scene>', saved.slice(-200))
check(saved.includes('spawn={{ x: 40, y: 13 }}'), 'the spawn is written')
check(saved.includes('to="/square/"'), "the door's target is written")
check(saved.includes("f: { fg: '#000000' }"), 'the picked color is written')
const gone = original.split('\n').filter((l) => !saved.includes(l))
check(gone.length === 5 && gone.every((l) => /x=\{9\} {2}y=\{14\}|x=\{90\} y=\{20\}|spawn=|<Door|^\s+f: /.test(l)), 'and every other line of the file is untouched', gone.join('\n'))

const again = readScene(saved)
check(again.elements.length === 21, 'read again, the file is 21 placed tags', String(again.elements.length))
const { stage, dispose } = await mountScene(SCENE)
const shown = stage.doors.filter((d) => !d.hidden)
check(shown.length === 3 && shown.some((d) => d.to === '/square/' && d.x === 48), 'the saved scene mounts with its door retargeted', JSON.stringify(stage.doors))
check(stage.doors.some((d) => d.hidden && d.to === '/cellar/'), 'and the hidden door to the cellar is still hidden, a save having left its tag alone', JSON.stringify(stage.doors))
check(stage.picture()[20].slice(40, 43) === '(o)' && stage.picture()[21].slice(90, 96) === '      ', 'the lamp placed and the barrel gone')
check(stage.spawn.x === 40 && stage.spawn.y === 13 && stage.walkable(40, 13), 'and the spawn where it was put, on floor')
dispose()

// ─── the history survives the save and a reload ───────────────────────

await page('location.reload()')
await sleep(500)
check(await until(async () => (await art()).length === 26 && lampAt((await overhead())[20])), 'reloaded, the editor opens on the saved file', `${await text('[data-status]')}\n${(await overhead())[20]}`)
check(!(await saveEnabled()), 'with nothing to save', await text('[data-status]'))
await clickCell(45, 23)
await browser.press('z', CTRL)
check(await until(async () => (await art())[21].slice(90, 96) === '(====)'), 'Ctrl+Z after the reload undoes the removal before the save', `${(await art())[21]}\nstatus: ${await text('[data-status]')}\nstage: ${await page(`return window.__stage.picture()[21]`)}\nmarks: ${await page(`return window.__stage.marks.length`)}`)
check(await saveEnabled(), 'and there is something to save again')
await browser.press('z', CTRL | SHIFT)
check(await until(async () => (await art())[21].slice(90, 96) === '      '), 'and Ctrl+Shift+Z removes it again')

// ─── a block of art pasted in ─────────────────────────────────────────

const two = table.art.split('\n').map((r) => `${r.padEnd(11)}   ${r}`).join('\n')
await page(`
  const area = document.querySelector('[data-import]')
  area.value = ${JSON.stringify(two)}
  area.dispatchEvent(new Event('input', { bubbles: true }))
`)
await mode('Place as pieces')
check(await until(async () => (await text('[data-status]'))?.startsWith('2 piece(s) placed')), 'two tables drawn side by side are placed as two tables', await text('[data-status]'))
check(await until(async () => tableAt((await art())[14], 40) && tableAt((await art())[14], 54)), 'with their top-left on the spawn', (await art())[14])
// A table's top-left is a space, so the spawn under it stays floor; the cell right of it is a wall.
check(await page(`return window.__stage.walkable(40, 13) && !window.__stage.walkable(41, 13)`), 'the spawn stays floor beside the wall of the first', await text('[data-problems]'))

// ─── the ask panel ────────────────────────────────────────────────────

const COPY_SRC = join(root, 'web/src')
const client = await fetch(`${URL_}/@frontierjs/cli/ask-client`).then((r) => r.text(), () => '')
check(client.startsWith('const ASK = '), 'the ask panel is served', client.slice(0, 120))
check(await page(`return window.__fjsAsk === true && window.__fjsInspect?.root`) === COPY_SRC, "the panel is on the page, and the inspector is rooted at the copy's web/src", String(await page(`return window.__fjsInspect?.root`)))

const now = readFileSync(SCENE, 'utf8')
const locOf = (needle) => {
  const at = now.indexOf(needle)
  const before = now.slice(0, at)
  return `scenes/Tavern.mesa:${before.split('\n').length}:${at - before.lastIndexOf('\n')}`
}
const tableLoc = locOf('<Piece of={table}   x={10}  y={14} />')
const placed = (at) => page(`return document.querySelector('[data-placed=${JSON.stringify(at)}]')?.getAttribute('data-fjs-loc') ?? null`)
check(await placed('table at 10,14') === tableLoc, "a placed table carries its tag's line", String(await placed('table at 10,14')))
check(await placed('the scene') === locOf('<Scene'), "and the stage the <Scene> tag's", String(await placed('the scene')))

const was = await selected()
await clickCell(11, 15, ALT | SHIFT)
check(await until(async () => !!(await page(`return document.querySelector('[data-pick=${JSON.stringify(tableLoc)}]')`))), 'shift+alt-click on the table picks it into the panel', await page(`return [...document.querySelectorAll('[data-pick]')].map((e) => e.dataset.pick).join()`))
check(await selected() === was, 'and the editor never sees the click: its selection is as it was', await selected())

// The panel's box is the one textarea the editor did not write.
await page(`
  ;[...document.querySelectorAll('textarea')].find((t) => !t.hasAttribute('data-import')).value = 'move this table two cells right'
  ;[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send').click()
`)
check(await until(() => existsSync(SEEN)), 'Send runs claude', `${await page(`return sessionStorage.getItem('fli:ask:log')`)}\n${viteLog.slice(-1500)}`)
const seen = existsSync(SEEN) ? JSON.parse(readFileSync(SEEN, 'utf8')) : { argv: [], input: '' }
const edits = seen.argv.filter((a) => a.startsWith('Edit('))
check(edits.join() === `Edit(/${COPY_SRC}),Edit(/${COPY_SRC}/**)`, "with Edit scoped to the copy's web/src and nothing wider", edits.join())
check(seen.cwd === COPY_SRC, 'run from it', seen.cwd)
check(seen.input.includes(tableLoc) && seen.input.includes('move this table two cells right'), "and the table's line and the instruction in the prompt", seen.input.slice(0, 600))
check(await until(async () => tableAt((await art())[15], 12) && (await page(`return { at: document.querySelector('[data-placed="table at 12,14"]')?.getAttribute('data-fjs-loc') ?? '' }`)).at === tableLoc), "the edit it made reopens the editor on the moved table, at the tag's line", `${(await art())[15]}\n${await text('[data-status]')}`)
check(await until(async () => (await page(`return { t: document.body.innerText }`)).t.includes('move this table two cells right')), 'and the panel is open again over the conversation')

check(browser.errors.length === 0, 'the tab threw nothing', browser.errors.join('\n'))
await browser.close()
cleanup()
process.exit(failed ? 1 : 0)
