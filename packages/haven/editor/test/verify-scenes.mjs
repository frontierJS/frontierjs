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
 *   spawn they cover is listed as a problem.
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
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
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
cpSync(SRC, join(root, 'src'), { recursive: true })
const SCENE = join(root, 'src/scenes/Tavern.mesa')
const original = readFileSync(SCENE, 'utf8')

const port = await freePort()
const URL_ = `http://localhost:${port}`
if (await fetch(URL_).then(() => true, () => false)) {
  console.log(`✗ ${URL_} already answers — refusing to drive a server this run did not start`)
  process.exit(1)
}
const vite = spawn(VITE, ['-c', 'editor/vite.config.js'], {
  cwd: PKG, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(port), SCENES_DIR: join(root, 'src/scenes') },
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
const CTRL = 2, SHIFT = 8

/** Click scene cell `x`,`y` of the preview at its center. */
async function clickCell(x, y) {
  const p = await page(`
    const box = document.querySelector('pre[data-art]').parentElement
    const lines = box.querySelector('pre[data-art]').textContent.split('\\n')
    const r = box.getBoundingClientRect()
    const cw = r.width / Math.max(...lines.map((l) => l.length))
    const lh = r.height / lines.length
    return { x: r.left + (${x} + 0.5) * cw, y: r.top + (${y} + 0.5) * lh }
  `)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.cmd('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
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
check((await marksOf('warning')).join() === '48,25', 'the door is marked on its cell', JSON.stringify(await marksOf('warning')))

// ─── a piece moved by arrow ───────────────────────────────────────────

await clickCell(10, 14)
check(await selectedIs('table at 9,13'), 'a click on a table selects it, named with its cell', await selected())
await browser.press('ArrowRight')
check(await selectedIs('table at 10,13'), 'ArrowRight moves it one cell right', await selected())
check(await until(async () => (await art())[14].slice(10, 21) === 'o|U  i  U|o'), 'and the art moves with it', (await art())[14])
check(await saveEnabled(), 'and there is something to save')

await clickCell(84, 16)
check(await selectedIs('barrel at 83,15'), 'a click on a barrel selects it', await selected())
await browser.press('ArrowRight')
check(await until(async () => (await text('[data-status]'))?.includes('cell 89,16 is claimed by both barrel and barrel')), 'a move onto another barrel is refused naming the cell and both', await text('[data-status]'))
check((await selected())?.includes('barrel at 83,15'), 'and the barrel stays where it was', await selected())

await clickCell(11, 14)
check(await selectedIs('table at 10,13'), 'the moved table is selected again')
await browser.press('z', CTRL)
check(await selectedIs('table at 9,13'), 'Ctrl+Z undoes the move', await selected())
check(await until(async () => (await art())[14].slice(9, 20) === 'o|U  i  U|o'), 'and the art goes back')
await browser.press('z', CTRL | SHIFT)
check(await selectedIs('table at 10,13'), 'Ctrl+Shift+Z redoes it', await selected())

// ─── placed, moved, typed, picked, removed ────────────────────────────

await mode('Place')
await page(`[...document.querySelectorAll('[data-pieces] button')].find((b) => b.textContent.trim().endsWith('lamp +')).click()`)
await clickCell(40, 20)
check(await selectedIs('lamp at 40,20'), 'a shared lamp is placed by click where it was clicked', await selected())
// The lamp's bulb is a `y` cell, which the tavern's palette flickers through `i!i`.
const lampAt = (row) => row[40] === '(' && row[42] === ')'
check(await until(async () => lampAt((await art())[20])), 'and drawn there', (await art())[20])
check(await page(`return document.querySelectorAll('pre[data-art]').length`) === 1, 'one preview is on the page')
check(await page(`return window.__stage.picture()[20].slice(40, 43)`) === '(o)', 'and the edited stage has the lamp', await page(`return window.__stage.picture()[20]`))

await mode('Spawn')
await clickCell(50, 21)
check(await until(async () => (await text('[data-spawn]')) === 'Spawn 50,21'), 'the spawn moves by click', await text('[data-spawn]'))
check((await marksOf('success')).join() === '50,21', 'and is marked there')

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

await clickCell(87, 19)
check(await selectedIs('barrel at 86,18'), 'a click on the lower barrel selects it', await selected())
await browser.press('Delete')
check(await until(async () => (await art())[19].slice(86, 92) === '      '), 'Delete removes it from the art', `${(await art())[19]}\nstage: ${await page(`return window.__stage.picture()[19]`)}`)
check((await selected())?.includes('Click a piece'), 'and nothing is selected')

// ─── saved into the file's own text ───────────────────────────────────

await mode('Save')
check(await until(async () => (await text('[data-status]'))?.startsWith('Saved Tavern.mesa')), 'Save writes the file', await text('[data-status]'))
const saved = readFileSync(SCENE, 'utf8')
check(saved !== original, 'the saved file differs from the original')
check(saved.includes('<Piece of={table}   x={10}  y={13} />'), 'the moved table is its attribute edit, in place', saved.split('\n').filter((l) => l.includes('table')).join('\n'))
check(!saved.includes('x={86} y={18}'), 'the removed barrel took its line with it')
check(saved.includes("import { lamp } from '@/pieces/lamp.js'\n") && saved.includes('<Piece of={lamp} x={40} y={20} />\n</Scene>'), 'the lamp is imported and placed before </Scene>', saved.slice(-200))
check(saved.includes('spawn={{ x: 50, y: 21 }}'), 'the spawn is written')
check(saved.includes('to="/square/"'), "the door's target is written")
check(saved.includes("f: { fg: '#000000' }"), 'the picked color is written')
const gone = original.split('\n').filter((l) => !saved.includes(l))
check(gone.length === 5 && gone.every((l) => /x=\{9\}|x=\{86\}|spawn=|<Door|^\s+f: /.test(l)), 'and every other line of the file is untouched', gone.join('\n'))

const again = readScene(saved)
check(again.elements.length === 16, 'read again, the file is 16 placed tags', String(again.elements.length))
const { stage, dispose } = await mountScene(SCENE)
check(stage.doors.length === 1 && stage.doors[0].to === '/square/' && stage.doors[0].x === 48, 'the saved scene mounts with its door retargeted', JSON.stringify(stage.doors))
check(stage.picture()[20].slice(40, 43) === '(o)' && stage.picture()[19].slice(86, 92) === '      ', 'the lamp placed and the barrel gone')
check(stage.spawn.x === 50 && stage.spawn.y === 21 && stage.walkable(50, 21), 'and the spawn where it was put, on floor')
dispose()

// ─── the history survives the save and a reload ───────────────────────

await page('location.reload()')
await sleep(500)
check(await until(async () => (await art()).length === 26 && lampAt((await art())[20])), 'reloaded, the editor opens on the saved file', `${await text('[data-status]')}\n${(await art())[20]}`)
check(!(await saveEnabled()), 'with nothing to save', await text('[data-status]'))
await clickCell(45, 23)
await browser.press('z', CTRL)
check(await until(async () => (await art())[19].slice(86, 92) === '(====)'), 'Ctrl+Z after the reload undoes the removal before the save', `${(await art())[19]}\nstatus: ${await text('[data-status]')}\nstage: ${await page(`return window.__stage.picture()[19]`)}\nmarks: ${await page(`return window.__stage.marks.length`)}`)
check(await saveEnabled(), 'and there is something to save again')
await browser.press('z', CTRL | SHIFT)
check(await until(async () => (await art())[19].slice(86, 92) === '      '), 'and Ctrl+Shift+Z removes it again')

// ─── a block of art pasted in ─────────────────────────────────────────

const two = table.art.split('\n').map((r) => `${r.padEnd(11)}   ${r}`).join('\n')
await page(`
  const area = document.querySelector('[data-import]')
  area.value = ${JSON.stringify(two)}
  area.dispatchEvent(new Event('input', { bubbles: true }))
`)
await mode('Place as pieces')
check(await until(async () => (await text('[data-status]'))?.startsWith('2 piece(s) placed')), 'two tables drawn side by side are placed as two tables', await text('[data-status]'))
check(await until(async () => (await art())[22].slice(50, 61) === 'o|U  i  U|o' && (await art())[22].slice(64, 75) === 'o|U  i  U|o'), 'with their top-left on the spawn', (await art())[22])
// A table's top-left is a space, so the spawn under it stays floor; the cell right of it is a wall.
check(await page(`return window.__stage.walkable(50, 21) && !window.__stage.walkable(51, 21)`), 'the spawn stays floor beside the wall of the first', await text('[data-problems]'))

check(await page(`return window.__errors ?? 0`) === 0, 'the tab threw nothing')
await browser.close()
cleanup()
process.exit(failed ? 1 : 0)
