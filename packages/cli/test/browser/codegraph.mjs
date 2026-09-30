/*
 * test/browser/codegraph.mjs — the codegraph page, opened.
 *
 * `fli project:codegraph --as=page` writes one HTML file with its whole script
 * inside it, and the script is built from strings: `test/codegraph.test.js`
 * asserts it PARSES, which is not the same as asserting it runs. Both ways it
 * has broken were silent in exactly that gap — a `const` read before its
 * declaration, and a backtick inside a comment inside the `String.raw` block,
 * which closed the literal. Each rendered a page that looks right, draws its
 * tiles, and has a dead control on it.
 *
 * So this opens the file it just wrote and presses things. Chrome and the CDP
 * client are mesa's, read by RELATIVE path for the reason the other drives
 * state: a workspace dep resolves to a copy under `node_modules/.bun/`, so a
 * by-name import would drive an install-time snapshot.
 *
 * Run against this repo rather than a fixture: what a fixture cannot answer is
 * whether the real project has anything to draw.
 */
import { fileURLToPath } from 'node:url'
import { resolve, join }  from 'node:path'
import { mkdtempSync }    from 'node:fs'
import { tmpdir }         from 'node:os'
import { openChrome }      from '../../../mesa/src/drive.js'
import { green, red, dim } from '../../../mesa/test/browser/drive.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLI  = resolve(HERE, '../..')
const REPO = resolve(CLI, '../..')

const out = join(mkdtempSync(join(tmpdir(), 'fli-codegraph-drive-')), 'codegraph.html')
global.fliRoot = CLI

const { collectCodegraph } = await import(resolve(CLI, 'core/codegraph.js'))
const { renderPage }       = await import(resolve(CLI, 'core/codegraph-page.js'))
const { typeScriptAt }     = await import(resolve(CLI, 'core/functions.js'))
const { ownStyleBundle }   = await import(resolve(CLI, 'core/assets.js'))
const { writeFileSync }    = await import('node:fs')

const ts    = await typeScriptAt(REPO)
const model = collectCodegraph({ root: REPO, ts })
writeFileSync(out, renderPage(model, { css: ownStyleBundle(), theme: 'field', name: 'frontierjs' }))

const rows = []
const ok = (name, pass, note = '') => { rows.push({ name, pass, note }); return pass }

const page = await openChrome()
await page.navigate('file://' + out, 'document.getElementById("cv") && document.getElementById("cv").width > 0')

const drawn = await page.evaluate(`
  const cv = document.getElementById('cv')
  return { w: cv.width, h: cv.height, tiles: document.getElementById('foot').textContent, facts: document.getElementById('facts').children.length }
`)
ok('the map is drawn', drawn.w > 0 && drawn.h > 0, drawn.w + '×' + drawn.h)
ok('the footer counts tiles', /\d+×\d+ tiles/.test(drawn.tiles), drawn.tiles.slice(0, 40))
ok('the facts are rendered', drawn.facts > 0, drawn.facts + ' tiles')

// every layout has to lay out: three of them are functions serialized out of
// core/codegraph.js, so a signature that moves breaks only here
for (const layout of ['packages', 'depth', 'path', 'core']) {
  const shape = await page.evaluate(`
    document.querySelector('[data-layout="${layout}"]').click()
    await new Promise(r => setTimeout(r, 60))
    const cv = document.getElementById('cv')
    return { w: cv.width, foot: document.getElementById('foot').textContent }
  `)
  ok('layout ' + layout, shape.w > 0 && /\d+×\d+ tiles/.test(shape.foot), shape.foot.split(' tiles')[0])
}

// the more menu, and the metric that is re-banded in the browser
const tuned = await page.evaluate(`
  const $ = id => document.getElementById(id)
  $('more').click()
  ;[...$('more-menu').querySelectorAll('[data-view]')].find(li => li.dataset.view === 'cognitive').click()
  await new Promise(r => setTimeout(r, 120))
  const counts = () => [...$('scales-more').querySelectorAll('.cg-ramp em')].map(e => e.textContent)
  const mounted = { hist: !!$('cut-hist'), rows: $('cut-rows') ? $('cut-rows').children.length : 0 }
  const before = counts(), hist = $('cut-hist').toDataURL(), map = $('cv').toDataURL()
  const s = $('cut-0')
  s.value = String(Number(s.max) - 100)
  s.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 120))
  const after = counts(), painted = $('cut-hist').toDataURL() !== hist, moved = $('cv').toDataURL() !== map
  $('cut-reset').click()
  await new Promise(r => setTimeout(r, 120))
  return { mounted, before, after, reset: counts(), painted, moved }
`)
ok('the cognitive view mounts its tuner', tuned.mounted.hist && tuned.mounted.rows === 3, tuned.mounted.rows + ' cuts')
ok('moving a cut re-bands the files', tuned.before.join() !== tuned.after.join(), tuned.before.slice(4).join('/') + ' → ' + tuned.after.slice(4).join('/'))
ok('and redraws the strip and the map', tuned.painted && tuned.moved)
ok('reset restores the shipped cuts', tuned.reset.join() === tuned.before.join(), tuned.reset.slice(0, 4).join(' '))

// a page that throws still renders, which is the whole reason this file exists
const errs = page.errors
ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '))

await page.close()

for (const r of rows) console.log(`  ${r.pass ? green('ok  ') : red('FAIL')}  ${r.name}${r.note ? dim('  ' + r.note) : ''}`)
const bad = rows.filter(r => !r.pass).length
console.log(bad ? red(`\n${bad} of ${rows.length} failed`) : green(`\nall ${rows.length} assertions passed`))
process.exit(bad ? 1 : 0)
