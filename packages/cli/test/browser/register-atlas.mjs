/*
 * test/browser/register-atlas.mjs — the register page, opened and pressed.
 *
 * `fli register:atlas` writes one file whose rows are drawn by its own script
 * out of an embedded model, so `test/register-atlas.test.js` can prove the
 * model and that the script PARSES, and neither says a tab draws anything. A
 * page whose script throws on its first line still shows its header and its
 * tabs, and reads as a project with an empty register.
 *
 * Two runs: the fixture from `test/fixtures/register-project.mjs`, where every
 * id is known and each control is asserted to do its one thing, and this
 * workspace, where what is asked is only that 1,400 rows draw without an error.
 *
 * Chrome and the CDP client are mesa's, read by RELATIVE path for the reason
 * the other drives state.
 */
import { fileURLToPath } from 'node:url'
import { resolve, join }  from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir }         from 'node:os'
import { openChrome, green, red, dim } from '../../../mesa/test/browser/drive.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLI  = resolve(HERE, '../..')
const REPO = resolve(CLI, '../..')

const { collectRegisterAtlas, renderRegisterAtlas } = await import(resolve(CLI, 'core/register-atlas.js'))
const { ownStyleBundle }  = await import(resolve(CLI, 'core/assets.js'))
const { registerProject } = await import(resolve(CLI, 'test/fixtures/register-project.mjs'))

const rows = []
const ok = (name, pass, note = '') => { rows.push({ name, pass, note }); return pass }

const css = ownStyleBundle()
const drawn = 'document.querySelectorAll("#view .ra-row").length > 0'

// ─── the fixture ──────────────────────────────────────────────────────────────

const project = registerProject()
const page    = await openChrome()

try {
  const out = join(project.root, '.project', 'registers.html')
  writeFileSync(out, renderRegisterAtlas(collectRegisterAtlas(project.root, { touched: new Set() }), css))
  await page.navigate('file://' + out, drawn)

  const counts = await page.evaluate(`
    return Object.fromEntries([...document.querySelectorAll('[data-count]')].map(e => [e.dataset.count, e.textContent]))
  `)
  ok('every tab is counted', counts.next === '2' && counts.decide === '3' && counts.issues === '3'
    && counts.rulings === '1' && counts.ideas === '1' && counts.closed === '1', JSON.stringify(counts))

  const next = await page.evaluate(`
    return [...document.querySelectorAll('#view .ra-row')].map(d => ({ id: d.dataset.id, blocked: !!d.querySelector('.badge.warning') }))
  `)
  ok('Next opens first, ranked, and marks the blocked row', next.map(r => r.id).join() === 'ACME-001,ACME-002' && next[1].blocked, JSON.stringify(next))

  const facet = await page.evaluate(`
    location.hash = '/issues'
    await new Promise(r => setTimeout(r, 30))
    const sel = document.querySelector('[data-dim="severity"]')
    sel.value = 'S3'; sel.dispatchEvent(new Event('change'))
    const ids = [...document.querySelectorAll('#view .ra-row')].map(d => d.dataset.id)
    return { ids, hits: document.getElementById('hits').textContent }
  `)
  ok('a severity facet narrows the issues', facet.ids.join() === 'ACME-002' && facet.hits === '1 / 3', JSON.stringify(facet))

  const search = await page.evaluate(`
    const q = document.getElementById('q')
    document.querySelector('[data-dim="severity"]').value = ''
    document.querySelector('[data-dim="severity"]').dispatchEvent(new Event('change'))
    q.value = 'commented-out'; q.dispatchEvent(new Event('input'))
    const ids = [...document.querySelectorAll('#view .ra-row')].map(d => d.dataset.id)
    q.value = ''; q.dispatchEvent(new Event('input'))
    return ids
  `)
  ok("the filter reads a row's text", search.join() === 'ACME-001', search.join())

  const jump = await page.evaluate(`
    location.hash = '/rulings'
    await new Promise(r => setTimeout(r, 30))
    const row = document.querySelector('#view [data-id="ACME-D1"]')
    row.open = true
    row.querySelector('a[href="#/id/ACME-001"]').click()
    await new Promise(r => setTimeout(r, 30))
    const target = document.querySelector('#view [data-id="ACME-001"]')
    return {
      tab: document.querySelector('[data-tab][aria-selected="true"]').dataset.tab,
      open: !!target && target.open,
      edit: target && target.querySelector('.ra-body > .text-muted a[href^="vscode://file/"]')?.getAttribute('href'),
    }
  `)
  ok('a citation in a ruling jumps to the issue it names, opened', jump.tab === 'issues' && jump.open, JSON.stringify(jump))
  ok('and the issue carries an editor link with its line', /ISSUES\.md:\d+$/.test(jump.edit ?? ''), jump.edit)

  const closed = await page.evaluate(`
    location.hash = '/id/ACME-000'
    await new Promise(r => setTimeout(r, 30))
    return document.querySelector('[data-tab][aria-selected="true"]').dataset.tab
  `)
  ok('a closed id lands on the Closed tab', closed === 'closed', closed)

  const decide = await page.evaluate(`
    location.hash = '/decide/texting'
    await new Promise(r => setTimeout(r, 30))
    const sec = document.getElementById('section')
    sec.value = 'Repo conventions'; sec.dispatchEvent(new Event('change'))
    const rec = document.querySelector('[data-copy="texting:where-does-the-call-run"][data-letter="A"]')
    rec.click()
    await new Promise(r => setTimeout(r, 30))
    const recCmd = rec.closest('.ra-body').querySelector('.ra-cmd').value
    const other = document.querySelector('[data-copy="texting:where-does-the-call-run"][data-letter="B"]')
    other.click()
    await new Promise(r => setTimeout(r, 30))
    const otherCmd = other.closest('.ra-body').querySelector('.ra-cmd').value
    const open = document.querySelector('#view [data-id="texting:what-may-leave-for-the-provider"]')
    return { recCmd, otherCmd, hint: open.textContent.includes('No lettered options yet') }
  `)
  ok('the recommended pick copies the exact fli decide line',
    decide.recCmd === 'fli decide texting:where-does-the-call-run A --section "Repo conventions"', decide.recCmd)
  ok('a pick against the recommendation asks for --why', decide.otherCmd.endsWith(' B --section "Repo conventions" --why ""'), decide.otherCmd)
  ok('a question without options says how to make it pickable', decide.hint)

  ok('no page errors on the fixture', page.errors.length === 0, page.errors.slice(0, 2).join(' | '))

  // ─── this workspace ─────────────────────────────────────────────────────────

  page.errors.length = 0
  const big = join(mkdtempSync(join(tmpdir(), 'fli-register-atlas-drive-')), 'registers.html')
  writeFileSync(big, renderRegisterAtlas(collectRegisterAtlas(REPO, { outDir: REPO }), css))
  await page.navigate('file://' + big, drawn)

  const every = await page.evaluate(`
    const out = {}
    for (const t of document.querySelectorAll('[data-tab]')) {
      location.hash = '/' + t.dataset.tab
      await new Promise(r => setTimeout(r, 20))
      out[t.dataset.tab] = [document.querySelectorAll('#view .ra-row').length, Number(document.querySelector('[data-count="' + t.dataset.tab + '"]').textContent)]
    }
    return out
  `)
  ok('this workspace: every tab draws every row it counts',
    Object.values(every).every(([drawn, counted]) => drawn === counted) && every.issues[0] > 0 && every.rulings[0] > 0,
    Object.entries(every).map(([k, [d]]) => k + ' ' + d).join(' · '))
  ok('no page errors on this workspace', page.errors.length === 0, page.errors.slice(0, 2).join(' | '))
} finally {
  await page.close()
  project.cleanup()
}

for (const r of rows) console.log(`  ${r.pass ? green('ok  ') : red('FAIL')}  ${r.name}${r.note ? dim('  ' + r.note) : ''}`)
const bad = rows.filter(r => !r.pass).length
console.log(bad ? red(`\n${bad} of ${rows.length} failed`) : green(`\nall ${rows.length} assertions passed`))
process.exit(bad ? 1 : 0)
