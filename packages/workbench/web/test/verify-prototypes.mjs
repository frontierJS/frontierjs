#!/usr/bin/env node
// web/test/verify-prototypes.mjs — /prototypes/ groups, orders, folds and edits the catalog
// through the real controls.
//
//   bun web/test/verify-prototypes.mjs
//   API_PORT=7121 UI_PORT=7021 bun web/test/verify-prototypes.mjs   # pin the ports
//
// Starts and stops its own database, API, web server and Chrome. The API runs with
// PROTOTYPES_DIR, WORKBENCH_DIR, XDG_CONFIG_HOME and CLAUDE_CONFIG_DIR pointed at a scratch directory
// holding a few tiny git repos and a CATALOG.json naming them. The owner's real
// fjs-prototypes/catalog/CATALOG.json and ~/.config/workbench/prototypes.json are
// fingerprinted before anything starts and must be as they were at the end.
//
// ─── What only this can ask ──────────────────────────────────────────────
//
//   Every control is used the way a person uses it, then the file on disk is read
//   back: a favorite, a fold or an order the screen showed but prototypes.json never
//   got, or a record edit CATALOG.json never took, is the failure. A reload follows
//   each view change, because the screen is optimistic and the file is the truth.
//   Reorder is proved twice: an HTML5 drag (synthetic DragEvents with one shared
//   DataTransfer) and the handle's arrow keys. A cleared purpose must leave the file
//   as a missing key, a record the page does not know a field of keeps it, and a
//   related line with no colon writes nothing.
//   Merge candidates: alpha and charlie are clients that link and share two models;
//   bravo shares two with alpha but is a product, so it pairs with nothing until the
//   Edit section links it to charlie, which the open panel must show unreloaded.
//   Move: foxtrot goes into a scratch KOBAMI folder, after a folder that does not exist
//   is refused on the form with nothing moved. Its record, the folder, its link into the
//   framework, its Claude Code history (CLAUDE_CONFIG_DIR is scratch too) and the
//   transcript's cwd must all follow,
//   and the row must still list with git state, which only a scan of the new parent gives.
//   The Lathe and Workbench buttons are never pressed: one opens a desktop window and
//   the other pins a repo on this machine.
//
// ─── Traps ───────────────────────────────────────────────────────────────
//
//   Setting `.value` on an input does not notify Mesa — it listens for `input`.
//   The Select is a wrapper around a native <select>; it is found by its id or name.
//   A recorded row's order is favorites first, so a hand reorder is only visible in
//   a group with no favorite in it.
//   Backgrounding a server from a tool call is unreliable; this spawns, polls until
//   each answers, asserts, and kills.

// Workbench lives in the global port block, which has no slot for a drive, so
// both servers take an OS-chosen port and nothing is held.
export const holds = []

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openChrome } from '../../../mesa/src/drive.js'

const HERE     = dirname(fileURLToPath(import.meta.url))
const PKG      = join(HERE, '..', '..')
const freePort = () => new Promise((done, fail) => {
  const s = createServer()
  s.on('error', fail)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)) })
})
const API_PORT = Number(process.env.API_PORT ?? await freePort())
const WEB_PORT = Number(process.env.UI_PORT ?? await freePort())
const BASE     = `http://localhost:${WEB_PORT}`
const API      = `http://localhost:${API_PORT}`
const KEY      = 'workbench-drive-key'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const children = []
let passed = 0, failed = 0
let browser = null

function ok(label)          { passed++; console.log(`  ✓ ${label}`) }
function bad(label, detail) { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
function check(label, cond, detail) { cond ? ok(label) : bad(label, detail) }

// The GROUP, not the child: `bun run web` spawns vite, so killing the direct
// child leaves the server holding its port.
async function cleanup() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGTERM') } catch { try { c.kill?.() } catch {} } }
  await sleep(500)
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch {} }
  await browser?.close()
}
function fail(msg) { console.error(`\n✗ ${msg}\n`); cleanup().then(() => process.exit(1)) }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => cleanup().then(() => process.exit(130)))

for (const [name, port] of [['API', API_PORT], ['web', WEB_PORT]]) {
  const answered = await fetch(`http://localhost:${port}/`).then(() => true).catch(() => false)
  if (answered) fail(`Something already answers on :${port} (${name}). Stop it — this drive would test it instead.`)
}

// ─── the scratch catalog ─────────────────────────────────────────────────

const SCRATCH = mkdtempSync(join(tmpdir(), 'workbench-prototypes-'))
const PROTOS  = join(SCRATCH, 'prototypes')
const WB      = join(SCRATCH, 'workbench')
const CATALOG = join(PROTOS, 'catalog', 'CATALOG.json')
const VIEW    = join(WB, 'prototypes.json')
const DB      = join(SCRATCH, 'workbench.db')
const dbEnv   = { DATABASE_URL: DB, AUDIT_PATH: join(SCRATCH, 'audit.db') }

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Drive', GIT_AUTHOR_EMAIL: 'd@example.com', GIT_COMMITTER_NAME: 'Drive', GIT_COMMITTER_EMAIL: 'd@example.com' } })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`)
}
// User is in every schema read, so it is furniture and pairs nothing.
const SCHEMAS = {
  alpha:   ['User', 'Lead', 'Quote', 'Job', 'Invoice'],
  charlie: ['User', 'Lead', 'Quote'],
  bravo:   ['User', 'Job', 'Invoice'],
}
const makeRepo = (name, { dirty = false } = {}) => {
  const dir = join(PROTOS, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`)
  if (SCHEMAS[name]) {
    mkdirSync(join(dir, 'db'))
    writeFileSync(join(dir, 'db', 'schema.lite'), SCHEMAS[name].map(m => `model ${m} {\n  id Integer @id\n}\n`).join('\n'))
  }
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'first')
  if (dirty) writeFileSync(join(dir, 'scratch.txt'), 'not committed\n')
  return dir
}

const repos = {}
for (const n of ['alpha', 'bravo', 'echo', 'charlie', 'foxtrot', 'delta', 'stray']) repos[n] = makeRepo(n, { dirty: n === 'delta' })
mkdirSync(join(PROTOS, 'notes'))                      // a plain folder: not a repo, so not a prototype
mkdirSync(join(PROTOS, 'catalog'), { recursive: true })
git(join(PROTOS, 'catalog'), 'init', '-q', '-b', 'main')

const rec = (name, owner, kind, status, extra = {}) => ({ path: repos[name], owner, kind, status, ...extra })
const seed = {
  alpha:   rec('alpha',   'kobami',      'client',   'active', { purpose: 'The first client site' }),
  bravo:   rec('bravo',   'kobami',      'product',  'paused', { purpose: 'A product spike', notes: 'mine, not the page\'s' }),
  echo:    rec('echo',    'kobami',      'stressor', 'active'),
  charlie: rec('charlie', 'knightworks', 'client',   'active', { related: [{ to: 'alpha', why: 'same stack' }] }),
  foxtrot: rec('foxtrot', 'knightworks', 'example',  'active'),
  delta:   rec('delta',   'personal',    'spike',    'active'),
  ghost:   { path: join(PROTOS, 'ghost'), owner: 'framework', kind: 'test', status: 'archived', purpose: 'The folder is gone' },
}
writeFileSync(CATALOG, JSON.stringify(seed, null, 2) + '\n')

// Where Move takes foxtrot, and the Claude Code history that must follow it.
// One level deeper than PROTOS, so foxtrot's relative link out of the repo breaks unless re-pointed.
const KOBAMI   = join(SCRATCH, 'KOBAMI', 'clients')
const CLAUDE   = join(SCRATCH, 'claude')
const SESSION  = '0f0f0f0f-1111-2222-3333-444444444444.jsonl'
const enc      = p => p.replace(/[^a-zA-Z0-9]/g, '-')
const transcriptLine = cwd => JSON.stringify({ type: 'user', cwd, sessionId: SESSION.slice(0, -6), message: { content: 'hello' } })
mkdirSync(KOBAMI, { recursive: true })
// As bun links @frontierjs/* from the framework checkout; excluded so foxtrot stays clean.
const FRAMEWORK_PKG = join(SCRATCH, 'frontierjs', 'packages', 'auth')
mkdirSync(FRAMEWORK_PKG, { recursive: true })
writeFileSync(join(FRAMEWORK_PKG, 'package.json'), '{"name":"@frontierjs/auth"}')
mkdirSync(join(repos.foxtrot, 'node_modules', '@frontierjs'), { recursive: true })
symlinkSync(relative(join(repos.foxtrot, 'node_modules', '@frontierjs'), FRAMEWORK_PKG), join(repos.foxtrot, 'node_modules', '@frontierjs', 'auth'))
writeFileSync(join(repos.foxtrot, '.git', 'info', 'exclude'), 'node_modules\n')
mkdirSync(join(CLAUDE, 'projects', enc(repos.foxtrot), 'memory'), { recursive: true })
writeFileSync(join(CLAUDE, 'projects', enc(repos.foxtrot), SESSION), transcriptLine(repos.foxtrot) + '\n')

// The owner's real files, fingerprinted before anything starts and compared at the end.
const REAL_CATALOG = join(dirname(PKG), '..', '..', 'fjs-prototypes', 'catalog', 'CATALOG.json')
const REAL_VIEW    = join(homedir(), '.config', 'workbench', 'prototypes.json')
const fingerprint = () => ({
  catalog: existsSync(REAL_CATALOG) ? createHash('sha1').update(readFileSync(REAL_CATALOG)).digest('hex') : null,
  view:    existsSync(REAL_VIEW)    ? createHash('sha1').update(readFileSync(REAL_VIEW)).digest('hex')    : null,
})
const realBefore = fingerprint()

children.push(spawn('bun', ['api/index.ts'], {
  cwd: PKG, stdio: 'ignore', detached: true,
  env: { ...process.env, ...dbEnv, FRONTIER_APP_URL: BASE, PORT: String(API_PORT), WORKBENCH_KEY: KEY,
         WORKBENCH_DIR: WB, XDG_CONFIG_HOME: join(SCRATCH, 'xdg'), PROTOTYPES_DIR: PROTOS, CLAUDE_CONFIG_DIR: CLAUDE },
}))
children.push(spawn('bun', ['run', 'web'], {
  cwd: PKG, stdio: 'ignore', detached: true,
  env: { ...process.env, API_PORT: String(API_PORT), UI_PORT: String(WEB_PORT) },
}))

const waitFor = async (url, label) => {
  for (let i = 0; i < 120; i++) { try { await fetch(url); return } catch {} await sleep(500) }
  fail(`${label} never answered ${url}`)
}
await waitFor(`${API}/health`, 'the API')
await waitFor(BASE, 'the web server')

browser = await openChrome().catch(async (e) => { console.error(`\n✗ ${e.message}\n`); await cleanup(); process.exit(1) })
const send = browser.cmd

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))
  return r.result?.value
}
async function until(expression, predicate, label, ms = 20_000) {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) {
    last = await evaluate(expression)
    if (predicate(last)) return last
    await sleep(250)
  }
  throw new Error(`${label} — last value: ${JSON.stringify(last)?.slice(0, 200)}`)
}
const goto = async path => { await send('Page.navigate', { url: BASE + path }); await sleep(1200) }

// ─── the screen ──────────────────────────────────────────────────────────

const q = JSON.stringify
const openScreen = async () => {
  await goto('/prototypes/')
  await until(`document.querySelectorAll('.prototypes-group').length`, n => n > 0, 'the groups never rendered', 30_000)
}
const headings = () => evaluate(`[...document.querySelectorAll('.prototypes-group-label')].map(e => e.textContent.trim())`)
const rowsIn   = (sectionId) => evaluate(`[...document.querySelectorAll('#${sectionId} li.prototypes-row')].map(li => li.id.slice('prototype-'.length))`)
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const clickSel = (sel) => evaluate(`(() => { const e = document.querySelector(${q(sel)}); if (!e) throw new Error('nothing matches ${sel.replace(/'/g, '')}'); e.click() })()`)
const rowButton = (name, text) => evaluate(`(() => {
  const b = [...document.querySelectorAll('#prototype-${name} .prototypes-actions button')].find(b => b.textContent.trim() === ${q(text)})
  if (!b) throw new Error('no ${text} button on ${name}')
  b.click()
})()`)
// The native control inside a form field, found by its name within one row's form.
const field = (row, name) => `document.querySelector('#prototype-form-${row} [name=${name}]')`
const fill = (row, name, value) => evaluate(`(() => {
  const el = ${field(row, name)}
  if (!el) throw new Error('no field ${name} in ${row}\\'s form')
  el.focus()
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${q(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
})()`)
const readField = (row, name) => evaluate(`${field(row, name)}?.value ?? null`)
const save = (row) => evaluate(`document.querySelector('#prototype-form-${row} button[type=submit]').click()`)
const setSearch = (value) => evaluate(`(() => {
  const host = document.getElementById('prototypes-search')
  const el = host.matches('input') ? host : host.querySelector('input')
  el.value = ${q(value)}
  el.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
const candidatePairs = () => evaluate(`[...document.querySelectorAll('.prototypes-candidate')].map(li => li.id.slice('prototypes-candidate-'.length))`)
const chooseGroup = (value) => evaluate(`(() => {
  const host = document.getElementById('prototypes-group-by')
  const el = host.matches('select') ? host : host.querySelector('select')
  el.value = ${q(value)}
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
})()`)

// One DataTransfer across the three events, the way a browser carries it.
const drag = async (from, to) => {
  const fire = (name, type) => evaluate(`(() => {
    window.__dt ??= new DataTransfer()
    document.getElementById('prototype-${name}').dispatchEvent(new DragEvent(${q(type)}, { bubbles: true, cancelable: true, dataTransfer: window.__dt }))
  })()`)
  await evaluate(`window.__dt = new DataTransfer()`)
  await fire(from, 'dragstart'); await sleep(200)
  await fire(to, 'dragover');    await sleep(200)
  await fire(to, 'drop');        await sleep(200)
  await fire(from, 'dragend')
}
const key = async (name, which) => {
  await evaluate(`document.getElementById('prototype-move-${name}').focus()`)
  const code = which === 'ArrowDown' ? 40 : 38
  for (const type of ['keyDown', 'keyUp'])
    await send('Input.dispatchKeyEvent', { type, key: which, code: which, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
}

// ─── the files ───────────────────────────────────────────────────────────

const json = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }
const text = (file) => { try { return readFileSync(file, 'utf8') } catch { return null } }
const viewSaved = async (predicate, label) => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) { const v = json(VIEW); if (v && predicate(v)) return v; await sleep(200) }
  throw new Error(`${label} — prototypes.json reads ${JSON.stringify(json(VIEW))?.slice(0, 300)}`)
}
const catSaved = async (predicate, label) => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) { const c = json(CATALOG); if (c && predicate(c)) return c; await sleep(200) }
  throw new Error(`${label} — CATALOG.json reads ${JSON.stringify(json(CATALOG))?.slice(0, 400)}`)
}
const others = (cat, except) => JSON.stringify(Object.entries(cat).filter(([n]) => !except.includes(n)))

const consoleErrors = []
browser.on('Runtime.consoleAPICalled', (p) => {
  if (p.type !== 'error') return
  const t = p.args.map(a => a.value ?? a.description ?? '').join(' ')
  if (!/favicon|\[vite\]/i.test(t)) consoleErrors.push(t)
})

try {
  await goto('/login/')
  await until(`!!document.getElementById('key')`, v => v, 'the sign-in form never rendered')
  await evaluate(`(() => { const el = document.getElementById('key'); el.value = ${q(KEY)}; el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await until(`location.pathname`, p => p === '/home/', 'sign-in never landed on home')
  ok('signed in with the pass-phrase')

  console.log('\n  Grouping — one section per owner, Missing and Unsorted last')
  await openScreen()
  check('the screen reads the scratch catalog, not the real one', (await evaluate(`document.body.innerText`)).includes('alpha') && !(await evaluate(`document.body.innerText`)).includes('fjs-prototypes/catalog'))
  check('owners in the schema\'s order, then Missing, then Unsorted', sameList(await headings(), ['kobami', 'knightworks', 'personal', 'Missing', 'Unsorted']), JSON.stringify(await headings()))
  check('kobami holds alpha, bravo and echo', sameList([...(await rowsIn('prototypes-group-owner-kobami'))].sort(), ['alpha', 'bravo', 'echo']), JSON.stringify(await rowsIn('prototypes-group-owner-kobami')))
  check('knightworks holds charlie and foxtrot', sameList([...(await rowsIn('prototypes-group-owner-knightworks'))].sort(), ['charlie', 'foxtrot']))
  check('Missing holds the record whose folder is gone', sameList(await rowsIn('prototypes-group-missing'), ['ghost']), JSON.stringify(await rowsIn('prototypes-group-missing')))
  check('Unsorted holds the repo with no record', sameList(await rowsIn('prototypes-group-unsorted'), ['stray']), JSON.stringify(await rowsIn('prototypes-group-unsorted')))
  check('a plain folder is not a prototype, and the catalog folder is not one either', await evaluate(`!document.getElementById('prototype-notes') && !document.getElementById('prototype-catalog')`))
  check('the uncommitted file shows on delta', (await evaluate(`document.getElementById('prototype-delta').innerText`)).includes('1 changed'), await evaluate(`document.getElementById('prototype-delta').innerText`))
  check('a clean repo says clean', (await evaluate(`document.getElementById('prototype-alpha').innerText`)).includes('clean'))
  check('no prototypes.json exists for looking', !existsSync(VIEW))

  await chooseGroup('kind')
  await until(`document.querySelectorAll('#prototypes-group-kind-client').length`, n => n === 1, 'Group by Kind never showed the client group')
  const byKind = await headings()
  check('Kind groups, in the schema\'s order, then Missing and Unsorted', sameList(byKind, ['client', 'product', 'stressor', 'example', 'spike', 'Missing', 'Unsorted']), JSON.stringify(byKind))
  check('the client group holds alpha and charlie, across owners', sameList([...(await rowsIn('prototypes-group-kind-client'))].sort(), ['alpha', 'charlie']))
  await chooseGroup('owner')
  await until(`document.querySelectorAll('#prototypes-group-owner-kobami').length`, n => n === 1, 'Group by Owner never came back')
  check('back on Owner the owner groups return', sameList(await headings(), ['kobami', 'knightworks', 'personal', 'Missing', 'Unsorted']))

  console.log('\n  Favorite — to the top of its group, in the file, and after a reload')
  const kobamiBefore = await rowsIn('prototypes-group-owner-kobami')
  check('echo is not first before it is a favorite', kobamiBefore[0] !== 'echo', JSON.stringify(kobamiBefore))
  await clickSel('#prototype-echo button[aria-label="Favorite echo"]')
  await until(`document.querySelector('#prototypes-group-owner-kobami li')?.id`, id => id === 'prototype-echo', 'echo never moved to the top of kobami')
  ok('echo moved to the top of kobami')
  check('the button now says Unfavorite and is pressed', await evaluate(`document.querySelector('#prototype-echo button[aria-label="Unfavorite echo"]')?.getAttribute('aria-pressed')`) === 'true')
  const v1 = await viewSaved(v => v.favorites.includes('echo'), 'the favorite never reached the file')
  check('prototypes.json has echo in favorites', sameList(v1.favorites, ['echo']), JSON.stringify(v1))
  await openScreen()
  check('after a reload echo is still first', sameList((await rowsIn('prototypes-group-owner-kobami'))[0], 'echo'), JSON.stringify(await rowsIn('prototypes-group-owner-kobami')))
  check('and the totals say one favorite', (await evaluate(`document.getElementById('prototypes-totals').innerText`)).toLowerCase().includes('1 favorites'), await evaluate(`document.getElementById('prototypes-totals').innerText`))

  console.log('\n  Reorder — a drag, then the handle\'s arrow keys')
  const kw0 = await rowsIn('prototypes-group-owner-knightworks')
  const kobamiHeld = await rowsIn('prototypes-group-owner-kobami')
  await drag(kw0[0], kw0[1])
  await until(`[...document.querySelectorAll('#prototypes-group-owner-knightworks li.prototypes-row')].map(l => l.id.slice(10))`, l => sameList(l, [kw0[1], kw0[0]]), 'the drop never changed the order on screen')
  ok(`dragging ${kw0[0]} onto ${kw0[1]} swapped them on screen`)
  const v2 = await viewSaved(v => v.order.length && sameList(v.order.filter(n => kw0.includes(n)), [kw0[1], kw0[0]]), 'the drop never reached the file')
  check('prototypes.json order matches the drop', sameList(v2.order.filter(n => kw0.includes(n)), [kw0[1], kw0[0]]), JSON.stringify(v2.order))
  check('and the favorite is still there', v2.favorites.includes('echo'))
  await openScreen()
  check('after a reload the dragged order holds', sameList(await rowsIn('prototypes-group-owner-knightworks'), [kw0[1], kw0[0]]), JSON.stringify(await rowsIn('prototypes-group-owner-knightworks')))

  const kw1 = await rowsIn('prototypes-group-owner-knightworks')
  await key(kw1[0], 'ArrowDown')
  await until(`[...document.querySelectorAll('#prototypes-group-owner-knightworks li.prototypes-row')].map(l => l.id.slice(10))`, l => sameList(l, [kw1[1], kw1[0]]), 'ArrowDown never moved the row down')
  ok(`ArrowDown on ${kw1[0]}'s handle moved it below ${kw1[1]}`)
  await viewSaved(v => sameList(v.order.filter(n => kw1.includes(n)), [kw1[1], kw1[0]]), 'ArrowDown never reached the file')
  check('the handle kept focus through the move', await until(`document.activeElement?.id ?? ''`, id => id === `prototype-move-${kw1[0]}`, 'focus did not follow the handle', 3000).then(() => true).catch(() => false))
  await key(kw1[0], 'ArrowUp')
  await until(`[...document.querySelectorAll('#prototypes-group-owner-knightworks li.prototypes-row')].map(l => l.id.slice(10))`, l => sameList(l, kw1), 'ArrowUp never moved the row back')
  const v3 = await viewSaved(v => sameList(v.order.filter(n => kw1.includes(n)), kw1), 'ArrowUp never reached the file')
  check('prototypes.json order follows ArrowUp too', sameList(v3.order.filter(n => kw1.includes(n)), kw1), JSON.stringify(v3.order))
  check('a move in knightworks left kobami\'s order alone', sameList(await rowsIn('prototypes-group-owner-kobami'), kobamiHeld), JSON.stringify(await rowsIn('prototypes-group-owner-kobami')))

  console.log('\n  Fold — rows hidden, in the file, after a reload')
  await clickSel('#prototypes-group-owner-kobami .prototypes-fold')
  await until(`document.querySelectorAll('#prototypes-group-owner-kobami li.prototypes-row').length`, n => n === 0, 'folding never hid the rows')
  ok('the kobami rows are hidden')
  check('the heading says it is collapsed', await evaluate(`document.querySelector('#prototypes-group-owner-kobami .prototypes-fold').getAttribute('aria-expanded')`) === 'false')
  const v4 = await viewSaved(v => v.folded.includes('owner:kobami'), 'the fold never reached the file')
  check('prototypes.json folded holds owner:kobami', sameList(v4.folded, ['owner:kobami']), JSON.stringify(v4.folded))
  check('and the knightworks rows are still shown', (await rowsIn('prototypes-group-owner-knightworks')).length === 2)
  await openScreen()
  check('after a reload kobami is still folded', (await rowsIn('prototypes-group-owner-kobami')).length === 0)
  await clickSel('#prototypes-group-owner-kobami .prototypes-fold')
  await until(`document.querySelectorAll('#prototypes-group-owner-kobami li.prototypes-row').length`, n => n === 3, 'unfolding never showed the rows')
  const v5 = await viewSaved(v => !v.folded.length, 'the unfold never reached the file')
  check('unfolding empties folded in the file', sameList(v5.folded, []))

  console.log('\n  Merge candidates — a linked pair that shares models, and the furniture left out')
  check('the panel is closed until asked for', await evaluate(`!document.getElementById('prototypes-candidates')`))
  await clickSel('#prototypes-candidates-toggle')
  await until(`document.querySelectorAll('.prototypes-candidate').length`, n => n > 0, 'the panel never listed a pair')
  check('one pair: alpha and charlie', sameList(await candidatePairs(), ['alpha-charlie']), JSON.stringify(await candidatePairs()))
  const pairText = await evaluate(`document.getElementById('prototypes-candidate-alpha-charlie').innerText`)
  check('it is linked, says why, and names the two shared models', /linked/i.test(pairText) && pairText.includes('charlie → alpha: same stack') && pairText.includes('shares 2 models: Lead, Quote'), pairText)
  const panelText = await evaluate(`document.getElementById('prototypes-candidates').innerText`)
  check('the panel says it read 3 schemas and left User out', panelText.includes('Read 3 schemas') && /models\s+User\s+are in a quarter/.test(panelText), panelText.slice(0, 300))
  check('bravo shares Job and Invoice with alpha but is a product, so it is in no pair', !(await candidatePairs()).some(p => p.includes('bravo')))
  await clickSel('#prototypes-candidate-alpha-charlie .prototypes-name')
  await until(`[...document.querySelectorAll('li.prototypes-row')].map(l => l.id)`, ids => sameList(ids, ['prototype-alpha']), 'a name in the panel never filtered the list to that repo')
  ok('a name in the panel filters the list to that repo')
  await setSearch('')
  await until(`document.querySelectorAll('li.prototypes-row').length`, n => n > 3, 'clearing the filter never brought the rows back')

  console.log('\n  Edit — status, purpose and a related line, then the purpose cleared')
  const before = json(CATALOG)
  await rowButton('bravo', 'Edit')
  await until(`!!document.getElementById('prototype-form-bravo')`, v => v, 'Edit never opened the form')
  check('the form starts from the record', await readField('bravo', 'status') === 'paused' && await readField('bravo', 'purpose') === 'A product spike' && await readField('bravo', 'owner') === 'kobami', JSON.stringify([await readField('bravo', 'status'), await readField('bravo', 'purpose'), await readField('bravo', 'owner')]))
  await fill('bravo', 'status', 'moving')
  await fill('bravo', 'purpose', 'Moving to the new stack')
  await fill('bravo', 'related', 'charlie: shares the schema')
  await save('bravo')
  const c1 = await catSaved(c => c.bravo?.status === 'moving', 'the edit never reached CATALOG.json')
  check('status is moving', c1.bravo.status === 'moving')
  check('purpose is the typed one', c1.bravo.purpose === 'Moving to the new stack', c1.bravo.purpose)
  check('related is [{ to, why }]', JSON.stringify(c1.bravo.related) === JSON.stringify([{ to: 'charlie', why: 'shares the schema' }]), JSON.stringify(c1.bravo.related))
  check('path, owner and kind stayed', c1.bravo.path === before.bravo.path && c1.bravo.owner === 'kobami' && c1.bravo.kind === 'product')
  check('a field the page does not know stayed', c1.bravo.notes === before.bravo.notes, JSON.stringify(c1.bravo.notes))
  check('every other record is unchanged', others(c1, ['bravo']) === others(before, ['bravo']))
  await until(`!document.getElementById('prototype-form-bravo')`, v => v, 'the form never closed after Save', 5000)
  check('the row shows the new purpose and status', (await evaluate(`document.getElementById('prototype-bravo').innerText`)).includes('Moving to the new stack') && (await evaluate(`document.getElementById('prototype-bravo').innerText`)).includes('moving'))
  check('and the related repo', (await evaluate(`document.getElementById('prototype-bravo').innerText`)).includes('related: charlie'))
  await until(`[...document.querySelectorAll('.prototypes-candidate')].map(li => li.id)`, ids => ids.includes('prototypes-candidate-bravo-charlie'), 'the open panel never showed the new link')
  check('the open panel lists bravo and charlie after the save, linked and of no one kind',
    sameList(await candidatePairs(), ['alpha-charlie', 'bravo-charlie']) && (await evaluate(`document.getElementById('prototypes-candidate-bravo-charlie').innerText`)).includes('bravo → charlie: shares the schema'),
    JSON.stringify(await candidatePairs()))
  await openScreen()
  check('after a reload the record reads the same', (await evaluate(`document.getElementById('prototype-bravo').innerText`)).includes('Moving to the new stack'))

  await rowButton('bravo', 'Edit')
  await until(`!!document.getElementById('prototype-form-bravo')`, v => v, 'Edit never opened the form the second time')
  check('the related field shows the saved line', await readField('bravo', 'related') === 'charlie: shares the schema', await readField('bravo', 'related'))
  const withPurpose = json(CATALOG)
  await fill('bravo', 'purpose', '')
  await save('bravo')
  const c2 = await catSaved(c => !('purpose' in (c.bravo ?? {})), 'clearing the purpose never reached CATALOG.json')
  check('the purpose key is gone from the file', !('purpose' in c2.bravo) && !/"purpose": ?(null|"")/.test(text(CATALOG).split('"charlie"')[0].split('"bravo"')[1] ?? ''))
  check('related and status stayed', c2.bravo.status === 'moving' && c2.bravo.related?.length === 1)
  check('every other record is unchanged', others(c2, ['bravo']) === others(withPurpose, ['bravo']))

  console.log('\n  A bad related line — said on the screen, nothing written')
  const beforeBad = text(CATALOG)
  await rowButton('delta', 'Edit')
  await until(`!!document.getElementById('prototype-form-delta')`, v => v, 'Edit never opened delta\'s form')
  await fill('delta', 'purpose', 'This must not be written')
  await fill('delta', 'related', 'no colon on this line')
  await save('delta')
  const said = await until(`document.querySelector('#prototype-form-delta [role=alert]')?.textContent ?? ''`, t => t, 'the bad line was never refused on the screen', 8000)
  check('the form names the line', said.includes('"no colon on this line" is not "repo-name: why"'), said)
  await sleep(600)
  check('and CATALOG.json is byte for byte as it was', text(CATALOG) === beforeBad)
  check('the form is still open with what was typed', await readField('delta', 'purpose') === 'This must not be written')
  await evaluate(`[...document.querySelectorAll('#prototype-form-delta button')].find(b => b.textContent.trim() === 'Cancel').click()`)
  await until(`!document.getElementById('prototype-form-delta')`, v => v, 'Cancel never closed the form', 5000)
  check('Cancel writes nothing', text(CATALOG) === beforeBad)

  console.log('\n  Record — an unsorted repo gets a record and moves under its owner')
  await rowButton('stray', 'Record')
  await until(`!!document.getElementById('prototype-form-stray')`, v => v, 'Record never opened the form')
  check('the form offers the defaults', await readField('stray', 'owner') === 'personal' && await readField('stray', 'kind') === 'spike' && await readField('stray', 'status') === 'active')
  await fill('stray', 'owner', 'knightworks')
  await fill('stray', 'kind', 'example')
  await fill('stray', 'purpose', 'Found in the folder')
  const beforeRecord = json(CATALOG)
  await save('stray')
  const c3 = await catSaved(c => !!c.stray, 'the new record never reached CATALOG.json')
  check('the file has stray with its owner, kind and status', c3.stray.owner === 'knightworks' && c3.stray.kind === 'example' && c3.stray.status === 'active', JSON.stringify(c3.stray))
  check('its path is the repo\'s own, absolute or ~/', c3.stray.path === repos.stray || c3.stray.path.startsWith('~/'), c3.stray.path)
  check('its purpose is the typed one', c3.stray.purpose === 'Found in the folder')
  check('every other record is unchanged', others(c3, ['stray']) === others(beforeRecord, ['stray']))
  await until(`document.querySelectorAll('#prototypes-group-owner-knightworks #prototype-stray').length`, n => n === 1, 'stray never appeared under knightworks')
  ok('stray is under knightworks')
  check('and Unsorted is gone', await evaluate(`!document.getElementById('prototypes-group-unsorted')`))
  check('the owner groups are unchanged but for the new row', sameList(await headings(), ['kobami', 'knightworks', 'personal', 'Missing']), JSON.stringify(await headings()))

  console.log('\n  Move — foxtrot leaves the folder; its record and Claude Code history follow')
  const moveField = `document.querySelector('#prototype-moveto-foxtrot [name=into]')`
  const typeInto = (value) => evaluate(`(() => {
    const el = ${moveField}
    if (!el) throw new Error('no folder field in foxtrot\\'s Move form')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${q(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const submitMove = () => evaluate(`document.querySelector('#prototype-moveto-foxtrot button[type=submit]').click()`)
  const beforeMove = text(CATALOG)
  await clickSel('#prototype-relocate-foxtrot')
  await until(`!!document.getElementById('prototype-moveto-foxtrot')`, v => v, 'Move never opened its form')
  await typeInto(join(SCRATCH, 'no-such-folder'))
  await submitMove()
  const refusedMove = await until(`document.querySelector('#prototype-moveto-foxtrot [role=alert]')?.textContent ?? ''`, t => t, 'a missing folder was never refused on the screen', 8000)
  check('a folder that does not exist is refused by name', refusedMove.includes('does not exist'), refusedMove)
  check('and nothing moved', text(CATALOG) === beforeMove && existsSync(repos.foxtrot))

  await typeInto(KOBAMI)
  await submitMove()
  await until(`!!document.getElementById('prototypes-moved')`, v => v, 'the move never reported', 15_000)
  const next = join(KOBAMI, 'foxtrot')
  const c4 = json(CATALOG)
  check('the record names the new path', c4.foxtrot.path === next, c4.foxtrot.path)
  check('every other record is unchanged', others(c4, ['foxtrot']) === others(JSON.parse(beforeMove), ['foxtrot']))
  check('the folder is at the new path and gone from the old', existsSync(join(next, 'README.md')) && !existsSync(repos.foxtrot))
  const movedHistory = join(CLAUDE, 'projects', enc(next))
  check('its Claude Code history folder moved, memory and all', existsSync(join(movedHistory, 'memory')) && !existsSync(join(CLAUDE, 'projects', enc(repos.foxtrot))))
  check('the transcript records the new cwd', existsSync(join(movedHistory, SESSION)) && text(join(movedHistory, SESSION)) === transcriptLine(next) + '\n')
  const linked = join(next, 'node_modules', '@frontierjs', 'auth', 'package.json')
  check('its link into the framework still resolves', existsSync(linked) && text(linked).includes('@frontierjs/auth'))
  const report = await evaluate(`document.getElementById('prototypes-moved').innerText`)
  check('the page says what moved', report.includes('1 folder renamed') && report.includes('1 transcript') && report.includes('1 link out of the repo re-pointed'), report)
  const foxRow = await until(`document.getElementById('prototype-foxtrot')?.innerText ?? ''`, t => t.includes('KOBAMI'), 'foxtrot never showed its new path')
  check('foxtrot still lists, with git state from the new folder', /clean/.test(foxRow) && !(await evaluate(`!!document.querySelector('#prototypes-group-missing #prototype-foxtrot')`)), foxRow.slice(0, 200))

  const real = fingerprint()
  check('the real CATALOG.json is byte-identical', real.catalog === realBefore.catalog, JSON.stringify([realBefore.catalog, real.catalog]))
  check('~/.config/workbench/prototypes.json is as it was', real.view === realBefore.view, JSON.stringify([realBefore.view, real.view]))
  check('no console errors on the screen', !consoleErrors.length, consoleErrors.join(' | ').slice(0, 300))
} catch (e) {
  bad('the drive stopped', e.message + (consoleErrors.length ? ` | console: ${consoleErrors.join(' | ').slice(0, 400)}` : ''))
}

await cleanup()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
