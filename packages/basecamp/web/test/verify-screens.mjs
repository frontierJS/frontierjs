#!/usr/bin/env node
// web/test/verify-screens.mjs — the screens Phases 13 and 14 added, in a browser.
//
// Five from Phase 13 (blueprints, registry, hub backups, hub settings, the
// caller's own settings) plus the audit window, and the six from Phase 14 that
// closed the mock: the graph, the setup checks, DNS, cloud spend, git activity
// and observability.
//
//   bun web/test/verify-screens.mjs
//
// Starts and stops everything itself. **Its own database, in a temp directory**
// — `DATABASE_URL` is pointed at a scratch file that this script seeds — so it
// touches nothing local and never asks anybody to reset a dev fleet.
//
// That is also why this is a separate drive from `verify.mjs`: that one asserts
// the first-run wizard owns an EMPTY app, and three of the screens here are
// about rendering a populated catalog. An empty grid and a broken query look
// identical, which is the whole reason `db/seed.js` exists.
//
// ─── Traps this file has already paid for ────────────────────────────────
//
//   A dev server serves the code it started with. It is started here, after the
//   files are written, and killed at the end.
//   Setting `.value` on an input does not notify Mesa — it listens for `input`.
//   `--headless=new` delivers almost no rendering lifecycle after load, so
//   everything is polled rather than slept on.
//   Backgrounding a server from a tool call is unreliable; this spawns, polls
//   until each answers, asserts, and kills.

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// The count is the enum's; `db/test/schema.test.ts` holds this list equal to it.
import { NOTIFICATION_KIND_NAMES } from '../../api/src/services/notification-preferences/kinds.ts'
import { totp } from '../../../auth/totp.ts'

const KINDS = NOTIFICATION_KIND_NAMES.length

const HERE     = dirname(fileURLToPath(import.meta.url))
const PKG      = join(HERE, '..', '..')
const CHROME   = process.env.FJS_CHROME ?? 'google-chrome'
// The dev slot by default; `API_PORT`/`UI_PORT` move the whole drive (the test
// slot is 7120/7020) so it can run beside a dev server holding 8120/8020.
const API_PORT = Number(process.env.API_PORT ?? 8120)
const WEB_PORT = Number(process.env.UI_PORT ?? 8020)
const BASE     = `http://localhost:${WEB_PORT}`
const EMAIL    = 'sam@example.com'      // the seeded owner, and a sysadmin
const PASSWORD = 'hunter2hunter2'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const children = []
let passed = 0, failed = 0

function ok(label)          { passed++; console.log(`  ✓ ${label}`) }
function bad(label, detail) { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
function check(label, cond, detail) { cond ? ok(label) : bad(label, detail) }

async function cleanup() {
  for (const c of children) { try { c.kill?.() ?? process.kill(-c.pid, 'SIGTERM') } catch {} }
  await sleep(300)
}
function fail(msg) { console.error(`\n✗ ${msg}\n`); cleanup().then(() => process.exit(1)) }

// ─── A database of its own ───────────────────────────────────────────────
const SCRATCH = mkdtempSync(join(tmpdir(), 'basecamp-screens-'))
const DB      = join(SCRATCH, 'basecamp.db')
// A database is TWO declared paths, and redirecting one of them is what this
// drive used to do: `database main` moved here and `database audit` followed
// the CWD, which is `PKG`, so every audit row 83 checks generate landed in the
// developer's own `db/audit/` and nothing failed either way (`FJS-633`).
const AUDIT   = join(SCRATCH, 'audit/')

console.log('\nBasecamp — the screens\n')
console.log(`  seeding ${DB}`)

const seed = spawn('bun', ['db/seed.js'], {
  cwd: PKG, stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, DATABASE_URL: DB, AUDIT_PATH: AUDIT },
})
let seedErr = ''
seed.stderr.on('data', d => { seedErr += d })
const seedCode = await new Promise(r => seed.on('exit', r))
if (seedCode !== 0) fail(`db/seed.js exited ${seedCode}\n${seedErr}`)

// ─── Refuse a port that already answers ──────────────────────────────────
// A stale dev server means this drive would assert against the OTHER app's
// build and report a pass. Vite sets strictPort, so it would die anyway; the
// API would not.
for (const [name, port] of [['API', API_PORT], ['web', WEB_PORT]]) {
  const answered = await fetch(`http://localhost:${port}/`).then(() => true).catch(() => false)
  if (answered) fail(`Something already answers on :${port} (${name}). Stop it — this drive would test it instead.`)
}

// ─── Servers ─────────────────────────────────────────────────────────────
// Held by name as well as in `children`: the last assertions stop the API on
// purpose, to see what a detail screen says when the read cannot be answered,
// and killing every child would take the dev server and the browser with it.
// Its output is kept: with no mail provider the API logs the password-reset
// link, and that line is the only way this drive can follow one.
let apiLog = ''
const api = spawn('bun', ['api/index.ts'], {
  cwd: PKG, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  env: { ...process.env, DATABASE_URL: DB, APP_URL: BASE, AUDIT_PATH: AUDIT, PORT: String(API_PORT) },
})
api.stdout.on('data', d => { apiLog += d })
api.stderr.on('data', d => { apiLog += d })
children.push(api)
children.push(spawn('bun', ['run', 'web'], {
  cwd: PKG, stdio: 'ignore', detached: true,
  env: { ...process.env, API_PORT: String(API_PORT), UI_PORT: String(WEB_PORT) },
}))

const waitFor = async (url, label) => {
  for (let i = 0; i < 120; i++) {
    try { await fetch(url); return } catch {}
    await sleep(500)
  }
  fail(`${label} never answered ${url}`)
}
await waitFor(`http://localhost:${API_PORT}/health`, 'the API')
await waitFor(BASE, 'the web server')

// ─── Chrome ──────────────────────────────────────────────────────────────
const PROFILE = mkdtempSync(join(tmpdir(), 'basecamp-screens-chrome-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`,
  '--window-size=1280,900', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
children.push(chrome)
chrome.on('error', e => fail(`Could not launch ${CHROME}: ${e.message}. Set $FJS_CHROME.`))

const browserWsUrl = await new Promise((resolve, reject) => {
  let buf = ''
  const t = setTimeout(() => reject(new Error('Chrome never announced a DevTools port')), 15_000)
  chrome.stderr.on('data', d => {
    buf += d
    const m = buf.match(/ws:\/\/[^\s]+/)
    if (m) { clearTimeout(t); resolve(m[0]) }
  })
}).catch(e => fail(`${e.message}. Is ${CHROME} installed? Set $FJS_CHROME.`))

const cdpPort = new URL(browserWsUrl).port
let target = null
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
    target = list.find(t => t.type === 'page')
    if (target) break
  } catch {}
  await sleep(250)
}
if (!target) fail(`No Chrome debug target on :${cdpPort}`)

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r))

let msgId = 0
const pending = new Map()
ws.addEventListener('message', e => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}, ms = 30_000) => new Promise((res, rej) => {
  const n = ++msgId
  const timer = setTimeout(() => {
    pending.delete(n)
    rej(new Error(`CDP ${method} timed out after ${ms}ms`))
  }, ms)
  pending.set(n, msg => { clearTimeout(timer); res(msg) })
  ws.send(JSON.stringify({ id: n, method, params }))
})

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    .catch(e => { throw new Error(`${e.message} evaluating ${expression.trim().slice(0, 160)}`) })
  const ex = r.result?.exceptionDetails
  if (ex) throw new Error(ex.exception?.description ?? JSON.stringify(ex))
  return r.result?.result?.value
}

/** Poll until an expression settles rather than sleeping a guessed amount. */
async function until(expression, predicate, label, ms = 15_000) {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) {
    last = await evaluate(expression)
    if (predicate(last)) return last
    await sleep(250)
  }
  throw new Error(`${label} — last value: ${JSON.stringify(last)?.slice(0, 200)}`)
}

/**
 * Write `n` audit rows into the scratch database, newest-first, tagged.
 *
 * A subprocess rather than an HTTP call because the trail is written by a hook
 * and the service is read-only — there is no request that puts a row there. It
 * is also the honest fixture: these arrive the way real ones do, underneath a
 * screen that is already open.
 */
async function auditFixture(n, tag) {
  const p = spawn('bun', ['web/test/audit-fixture.mjs', String(n), tag], {
    cwd: PKG, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, DATABASE_URL: DB, AUDIT_PATH: AUDIT },
  })
  let err = ''
  p.stderr.on('data', d => { err += d })
  const code = await new Promise(r => p.on('exit', r))
  if (code !== 0) fail(`audit-fixture.mjs exited ${code}\n${err}`)
}

/** Three notifications for the seeded owner, two unread; answers what it
 *  wrote, newest first. A subprocess for auditFixture's reason: only the
 *  driver writes a notification, and it does so through `asSystem()`. */
async function notificationFixture(tag) {
  const p = spawn('bun', ['web/test/notification-fixture.mjs', tag], {
    cwd: PKG, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: DB, AUDIT_PATH: AUDIT },
  })
  let out = '', err = ''
  p.stdout.on('data', d => { out += d })
  p.stderr.on('data', d => { err += d })
  const code = await new Promise(r => p.on('exit', r))
  if (code !== 0) fail(`notification-fixture.mjs exited ${code}\n${err}`)
  return JSON.parse(out.trim().split('\n').pop())
}

const goto = async path => { await send('Page.navigate', { url: BASE + path }); await sleep(1200) }
const text = sel => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`)
const body = () => evaluate(`document.body.textContent`)
const click = sel => evaluate(`
  (() => { const el = document.querySelector(${JSON.stringify(sel)})
           if (!el) throw new Error('no ' + ${JSON.stringify(sel)})
           el.click(); return true })()`)
const fill = fields => evaluate(`
  (() => {
    ${Object.entries(fields).map(([id, v]) =>
      `{ const el = document.getElementById(${JSON.stringify(id)})
         if (!el) throw new Error('no field #${id} on ' + location.pathname)
         el.value = ${JSON.stringify(v)}
         el.dispatchEvent(new Event('input', { bubbles: true })) }`).join('\n    ')}
  })()`)

// The console is watched throughout: a Mesa keying warning or a runtime throw
// is a defect the assertions below would otherwise walk straight past.
const consoleErrors = []
await send('Runtime.enable')
ws.addEventListener('message', e => {
  const msg = JSON.parse(e.data)
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    const t = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')
    // Vite's own dev-time noise, and a favicon nobody has drawn.
    if (/favicon|\[vite\]|Download the .* DevTools/i.test(t)) return
    consoleErrors.push(t)
  }
})

try {
  // ─── Sign in ───────────────────────────────────────────────────────────
  await goto('/login/')
  await until(`!!document.getElementById('email')`, v => v, 'the sign-in form never rendered')
  await fill({ email: EMAIL, password: PASSWORD })
  await evaluate(`document.querySelector('button[type=submit]').click()`)
  await until(`location.pathname`, p => p === '/', 'sign-in never landed on the overview')
  ok('signed in as the seeded owner')

  // ─── Blueprints ────────────────────────────────────────────────────────
  console.log('\n  /blueprints/ — the catalog')
  await goto('/blueprints/')
  await until(`document.querySelectorAll('#blueprint-grid .card').length`, n => n > 0,
    'the catalog never rendered a card')

  const cards = await evaluate(`document.querySelectorAll('#blueprint-grid .card').length`)
  // Seven of eight: Ghost is seeded withdrawn, and a withdrawn blueprint is off
  // the list while still readable by id.
  check('seven blueprints offered, the withdrawn one hidden', cards === 7, `saw ${cards}`)

  const chips = await evaluate(`[...document.querySelectorAll('#blueprint-filters .pill')].map(e => e.textContent.trim())`)
  check('category chips are derived from the rows', chips.some(c => c.startsWith('Analytics (2)')),
    chips.join(' | '))
  // CMS is Ghost's category and Ghost is withdrawn — a chip for it would mean
  // the count came from somewhere other than the offered rows.
  check('a withdrawn entry contributes no chip', !chips.some(c => c.startsWith('CMS')), chips.join(' | '))

  await evaluate(`
    (() => { const el = document.getElementById('blueprint-search')
             el.value = 'redis'; el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await until(`document.querySelectorAll('#blueprint-grid .card').length`, n => n === 1,
    'search never narrowed to one card')
  ok('search narrows the grid')

  await click('#blueprint-grid .card button')
  await until(`!!document.getElementById('blueprint-detail')`, v => v, 'the detail pane never opened')
  const detail = await text('#blueprint-detail')
  check('the detail names the image', detail.includes('redis:7.2-alpine'), detail.slice(0, 120))
  check('and every parameter', detail.includes('REDIS_PASSWORD') && detail.includes('MAXMEMORY_POLICY'))
  check('marking which are secret', detail.includes('secret'))

  // ─── Registry ──────────────────────────────────────────────────────────
  console.log('\n  /registry/ — the mirror')
  await goto('/registry/')
  await until(`document.querySelectorAll('#registry-list .card').length`, n => n > 0,
    'the repository list never rendered')

  const freshness = await text('#registry-freshness')
  check('the header says when the mirror was last seen', /mirror last seen/.test(freshness ?? ''), freshness)

  const totals = await text('#registry-totals')
  // The seeded workspace has two repositories of five tags each; `latest` and
  // `v2.14.1` share a digest, so four digests are charged per repository. A
  // per-tag sum would report ~25% more.
  check('two repositories, ten tags', /2 repositories/.test(totals) && /10 tags/.test(totals), totals)

  await click('#registry-list .card button')
  await until(`document.querySelectorAll('#registry-list tbody tr').length`, n => n >= 5,
    'the tag table never opened')
  const tagText = await evaluate(`document.querySelector('#registry-list table').textContent`)
  check('an aliased tag is marked as the same image', /same image as/.test(tagText),
    tagText.slice(0, 160))

  // ─── Servers ───────────────────────────────────────────────────────────
  // Nothing else types into this box — `verify` filters by status and role
  // only — and a refused key renders as an error over an empty list, which
  // is how it answered 400 unseen (FJS-1284). The name is read off the first
  // row rather than written here, because the seed names machines by counter.
  console.log('\n  /servers/ — the search box')
  await goto('/servers/')
  await until(`document.querySelectorAll('#server-rows tbody tr').length`, n => n > 1,
    'the server list never rendered two rows to narrow')
  const everyRow = `[...document.querySelectorAll('#server-rows tbody tr td:first-child')].map(td => td.textContent.trim())`
  const unfiltered = await evaluate(everyRow)
  const wanted     = unfiltered[0]

  await fill({ 'filter-search': wanted })
  await evaluate(`document.getElementById('filter-search').form.requestSubmit()`)
  await until(`location.search`, s => s.includes('search='), 'submitting never wrote ?search= into the URL')
  const narrowed = await until(everyRow, rows => rows.length > 0 && rows.length < unfiltered.length,
    'the list never narrowed').catch(e => e)
  // The page's own banner sits under its header. The shell draws notices of
  // its own in the same tone — a seeded machine that is unreachable — so a
  // bare `.alert.danger` reads one of those as this page failing.
  const banner = await text('.section-header + .alert.danger')
  check('searching by name answers rather than refusing', !banner, banner)
  check('and narrows to the rows holding it',
    Array.isArray(narrowed) && narrowed.every(n => n.includes(wanted)), String(narrowed?.message ?? narrowed))

  // ─── Hub settings ──────────────────────────────────────────────────────
  console.log('\n  /hub/settings/ — the installation')
  await goto('/hub/settings/')
  await until(`!!document.getElementById('cfg-base-url')`, v => v, 'the settings form never rendered')
  const seededUrl = await evaluate(`document.getElementById('cfg-base-url').value`)
  check('the seeded settings load', seededUrl === 'https://hub.acme.example', seededUrl)

  await fill({ 'cfg-name': 'Renamed Hub' })
  await click('#save-settings')
  await until(`document.body.textContent`, t => t.includes('Settings saved') || t.includes('Renamed Hub'),
    'the save never reported')
  await goto('/hub/settings/')
  await until(`document.getElementById('cfg-name')?.value ?? ''`, v => v === 'Renamed Hub',
    'the rename did not survive a reload')
  ok('a save round-trips through the singleton')

  // The version guard, proved rather than described: a save carrying a stale
  // revision must be refused. Done through the client so the payload is exactly
  // what the screen sends, minus a correct version.
  const conflict = await evaluate(`
    (async () => {
      try {
        await window.__fjsClient.service('hub-config')
          .invoke('save', null, { name: 'Stale write', version: 1 })
        return 'accepted'
      } catch (e) { return e.message }
    })()
  `).catch(() => 'no client handle')
  if (conflict === 'no client handle') {
    console.log('  · skipped: no client handle on window (the version guard is covered by the API tests)')
  } else {
    check('a save carrying a stale revision is refused', conflict !== 'accepted', conflict)
  }

  // ─── Hub backups ───────────────────────────────────────────────────────
  console.log('\n  /hub/backups/ — archives')
  await goto('/hub/backups/')
  await until(`!!document.getElementById('take-backup')`, v => v, 'the backups screen never rendered')

  const schedule = await text('#backup-schedule')
  check('the schedule is shown with its caveat', /Nothing registers it yet/i.test(schedule ?? ''),
    (schedule ?? '').slice(0, 120))

  const before = await evaluate(`document.querySelectorAll('#backup-history tbody tr').length`)
  await click('#take-backup')

  // A refusal renders in the screen's own alert. Read for it as a REASON, not
  // as a wait: without it the assertions below fail with `1 → 1` and say
  // nothing about why.
  const refusal = await evaluate(`
    (async () => { await new Promise(r => setTimeout(r, 500))
                   return document.getElementById('screen-error')?.textContent ?? null })()`)
  if (refusal) bad('taking a backup was refused', refusal.trim())

  // Poll the row COUNT, never the text. The seeded archive is already
  // `success` with a size, so a text predicate matches before the new row has
  // been written at all — which is a drive that passes on the fixture and would
  // pass with the button disconnected. Measured: it did.
  const after = await until(
    `document.querySelectorAll('#backup-history tbody tr').length`,
    n => n > before, 'taking a backup never added a row', 30_000)
  check('taking one adds a row', after > before, `${before} → ${after}`)

  // Then the NEW row settles — a real `VACUUM INTO` onto a real file, so the
  // size is what the machine reported rather than anything this app chose.
  const newest = await until(
    `document.querySelector('#backup-history tbody tr')?.textContent ?? ''`,
    t => /success/.test(t) && /manual/.test(t), 'the new backup never succeeded', 30_000)
  check('and it finishes with a size the machine reported',
    /\d(\.\d)?\s?(B|kB|MB|GB)/.test(newest), newest.trim().slice(0, 120))

  // ─── Your settings ─────────────────────────────────────────────────────
  console.log('\n  /settings/ — the caller\'s own account')
  await goto('/settings/')
  await until(`document.querySelectorAll('#notification-kinds > div').length`, n => n === KINDS,
    `the ${KINDS} notification kinds never rendered`)
  ok(`all ${KINDS} kinds render, stored merged over defaults`)

  const kindsText = await text('#settings-notifications')
  // Two are seeded chosen and the rest have never been touched. A screen that
  // flattened the two states would show one identical row per kind.
  check('chosen and default are distinguished', /chosen/.test(kindsText) && /default/.test(kindsText))
  check('and the count agrees', kindsText.includes(`2 of ${KINDS} chosen`), kindsText.slice(0, 80))

  const sessionsText = await text('#settings-sessions')
  check('this session is listed and marked', /this one/.test(sessionsText ?? ''),
    (sessionsText ?? '').slice(0, 120))

  check('the profile shows the signed-in address', (await text('#settings-profile')).includes(EMAIL))

  // The profile form. Read back through the API, never off the form, which
  // shows what was typed whether or not the write landed.
  const nameBox = `document.querySelector('#settings-profile [name=displayName]')`
  await until(`!!${nameBox}`, v => v, 'the profile form never rendered')
  check('the form offers no address box — a new address is proven first, and that is auth\'s',
    !(await evaluate(`!!document.querySelector('#settings-profile [name=email]')`)))
  await evaluate(`(() => { const el = ${nameBox}
    el.value = 'Sam Drive'; el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await click('#profile-save')
  await until(`document.body.textContent`, t => t.includes('Profile saved'), 'the profile save never reported')
  const mine = (await apiGet('/users/me')).body
  check('a profile save lands on the caller\'s own row', mine?.displayName === 'Sam Drive',
    JSON.stringify(mine)?.slice(0, 120))
  await goto('/settings/')
  await until(`${nameBox}?.value ?? ''`, v => v === 'Sam Drive', 'the name did not survive a reload')
  ok('and it survives a reload')
  check('two-step sign-in is offered, and is off', await evaluate(
    `document.getElementById('settings-totp')?.dataset.totpState`) === 'off')

  // Flip one and prove it stuck — the write goes through `save`, which fills the
  // other transport from the KIND's default rather than the column's.
  await click('#notify-member_joined-email')
  await until(`document.getElementById('settings-notifications').textContent`,
    t => t.includes(`3 of ${KINDS} chosen`), 'flipping a switch never marked the kind chosen')
  ok('flipping a transport marks that kind chosen')

  await goto('/settings/')
  await until(`document.getElementById('settings-notifications')?.textContent ?? ''`,
    t => t.includes(`3 of ${KINDS} chosen`), 'the choice did not survive a reload')
  ok('and it survives a reload')

  // ─── The audit trail ───────────────────────────────────────────────────
  // The one screen here whose job is to be COMPLETE, and the one shape a
  // numbered page is worst for: a trail only grows, and it grows at the end a
  // reader starts from, so every offset means something different a second
  // later. This asserts the window instead (`FJS-D145`) — a far edge named by
  // the last row's sort keys rather than by a count of rows before it.
  console.log('\n  /admin/audit/ — a window that grows')

  await auditFixture(60, 'window')

  await goto('/admin/audit/')
  await until(`document.querySelectorAll('#audit-rows tbody tr').length`, n => n > 0,
    'the audit trail never rendered a row')

  const firstWindow = await evaluate(`document.querySelectorAll('#audit-rows tbody tr').length`)
  check('the first window is one page and stops there', firstWindow === 50, `saw ${firstWindow}`)
  // The half that was missing before: a capped list said nothing about the rows
  // it was not showing, which reads exactly like a trail that has fifty rows.
  check('and it offers the rest', await evaluate(`!!document.getElementById('audit-more')`))

  // Three rows written ABOVE the window's start, between reading it and
  // growing it. This is the whole argument: under an offset, `offset=50` now
  // names three rows that were on page one, so growing repeats them and skips
  // three others — silently, and only ever under a list somebody is writing to.
  await auditFixture(3, 'inserted')

  await click('#audit-more')
  const grown = await until(`document.querySelectorAll('#audit-rows tbody tr').length`,
    n => n > firstWindow, 'growing the window added no rows')

  const tokens = () => evaluate(`
    [...document.querySelectorAll('#audit-rows tbody tr')]
      .map(tr => (tr.textContent.match(/\\b[wi]-\\d{3}\\b/) ?? [null])[0])
      .filter(Boolean)`)

  const seen = await tokens()
  check('growing appended rows past the edge', grown > firstWindow, `${firstWindow} → ${grown}`)
  check('and served none of them twice', new Set(seen).size === seen.length,
    `${seen.length} rows, ${new Set(seen).size} distinct`)
  // A keyset scan resumes from a POSITION, so rows written above the window
  // cannot move it. They are legitimately absent — a reload is how you see
  // them, which is what a trail's "newest first" already means.
  check('rows written above the window did not enter it',
    !seen.some(t => t.startsWith('i-')), seen.filter(t => t.startsWith('i-')).join(','))

  // Five fixture rows share one `createdAt`, straddling the 50-row edge. A
  // cursor built from the sort column alone names a position five rows wide:
  // resuming past it loses two, resuming at it repeats three. The tiebreaker is
  // litestone's, appended to the sort keys; this is where it shows.
  const tie = ['w-047', 'w-048', 'w-049', 'w-050', 'w-051']
  check('the rows sharing one timestamp all survive the edge, once each',
    tie.every(t => seen.filter(x => x === t).length === 1),
    tie.map(t => `${t}:${seen.filter(x => x === t).length}`).join(' '))

  // Growing to the end: the button is the only statement about whether more
  // exists, so it has to stop being there.
  for (let i = 0; i < 6 && await evaluate(`!!document.getElementById('audit-more')`); i++) {
    const n = await evaluate(`document.querySelectorAll('#audit-rows tbody tr').length`)
    await click('#audit-more')
    await until(`document.querySelectorAll('#audit-rows tbody tr').length`,
      c => c > n, 'growing the window stopped adding rows before the end')
  }
  check('growing to the end retires the button and says so',
    await evaluate(`!!document.getElementById('audit-end')`))

  const all = await tokens()
  check('and the whole trail was served once each', new Set(all).size === all.length,
    `${all.length} rows, ${new Set(all).size} distinct`)
  check('every fixture row is in it', all.filter(t => t.startsWith('w-')).length === 60,
    `${all.filter(t => t.startsWith('w-')).length} of 60`)

  // ─── The six screens that closed the mock ──────────────────────────────
  //
  // Two of them read the database (the graph, the setup checks) and four are
  // mostly a statement about what is NOT wired. The first two are asserted
  // against rows; the other four are asserted on the one thing that can be
  // wrong about them — that the skeleton is there and the reason beside it is
  // the adapter's real state rather than a sentence somebody typed.

  /** A write through the app's own API, from the page, with the session it is
   *  already holding. A subprocess against the database would not go through
   *  the gate, the row policies or the workspace stamp — and those are what
   *  decides whether these rows are the ones the screens can read. */
  async function apiPost(path, payload) {
    return evaluate(`
      fetch(${JSON.stringify(path)}, {
        method: 'POST',
        headers: {
          'content-type':   'application/json',
          accept:           'application/json',
          authorization:    'Bearer ' + localStorage.getItem('basecamp_token'),
          'x-workspace-id': localStorage.getItem('basecamp_workspace'),
        },
        body: JSON.stringify(${JSON.stringify(payload)}),
      }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`)
  }

  /** The same read, and the workspace is a PARAMETER. Every service here is
   *  scoped by the caller's membership row for the workspace the request
   *  names, so asking the same question about two of them is the only way to
   *  see that the scope is doing anything at all. */
  async function apiGet(path, workspaceId = null) {
    return evaluate(`
      fetch(${JSON.stringify(path)}, { headers: {
        accept:           'application/json',
        authorization:    'Bearer ' + localStorage.getItem('basecamp_token'),
        'x-workspace-id': ${workspaceId ? JSON.stringify(workspaceId) : `localStorage.getItem('basecamp_workspace')`},
      }}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`)
  }

  // db/seed.js makes servers, apps and placements and no domains or networks,
  // so two of the graph's four node kinds and the whole of /dns/ would be
  // asserted against an empty list — which is exactly the shape that passes
  // with a broken query. One of each is created here.
  const appList = await evaluate(`
    fetch('/apps', { headers: {
      accept: 'application/json',
      authorization: 'Bearer ' + localStorage.getItem('basecamp_token'),
      'x-workspace-id': localStorage.getItem('basecamp_workspace'),
    }}).then(r => r.json())`)
  const firstApp = appList?.data?.[0]
  check('the seeded workspace has an app to hang a hostname on', !!firstApp,
    JSON.stringify(appList)?.slice(0, 120))

  const madeDomain = await apiPost('/domains', {
    appId: firstApp.id, hostname: 'drive.example.test', isPrimary: false,
  })
  check('a hostname was created for the drive', madeDomain.status < 300, JSON.stringify(madeDomain).slice(0, 200))

  const madeNetwork = await apiPost('/networks', {
    name: 'Drive mesh', slug: 'drive-mesh', cidr: '10.9.0.0/16',
  })
  check('and a network', madeNetwork.status < 300, JSON.stringify(madeNetwork).slice(0, 200))

  // ── /onboarding/ ───────────────────────────────────────────────────────
  console.log('\n  /onboarding/ — six checks, nothing stored')
  await goto('/onboarding/')
  await until(`document.querySelectorAll('#onboarding-steps .step').length`, n => n > 0,
    'the step list never rendered')

  const stepCount = await evaluate(`document.querySelectorAll('#onboarding-steps .step').length`)
  check('six steps', stepCount === 6, `saw ${stepCount}`)

  const progress = await evaluate(`(() => {
    const el = document.getElementById('onboarding-progress')
    return el ? { value: el.value, max: el.max } : null })()`)
  check('the progress element carries the real numbers', progress?.max === 6 && progress.value > 0,
    JSON.stringify(progress))

  const complete = await evaluate(`document.querySelectorAll('#onboarding-steps .step.complete').length`)
  check('and it agrees with the steps marked complete', complete === progress.value,
    `${complete} complete, progress says ${progress.value}`)

  // The whole argument of this screen: a step is done because a row exists, so
  // the seeded fleet's steps are done and the ones with no rows are not. If a
  // `done` flag ever creeps back in, this is what stops agreeing.
  const bodyText = await body()
  check('a seeded server marks its step done',
    await evaluate(`[...document.querySelectorAll('#onboarding-steps .step')]
      .some(li => li.classList.contains('complete') && li.textContent.includes('server'))`))
  check('the counts the answers came from are on the page',
    /servers,/.test(bodyText) && /invitations/.test(bodyText))
  check('and no button claims to complete a step',
    !(await evaluate(`[...document.querySelectorAll('#onboarding-steps button')]
      .some(b => /complete|done|mark/i.test(b.textContent))`)))

  // ── /infra-graph/ ──────────────────────────────────────────────────────
  console.log('\n  /infra-graph/ — the fleet, drawn from rows')
  await goto('/infra-graph/')
  await until(`document.querySelectorAll('#infra-graph g').length`, n => n > 0,
    'the graph never drew a node')

  const drawn = await evaluate(`document.querySelectorAll('#infra-graph g').length`)
  const lines = await evaluate(`document.querySelectorAll('#infra-graph line').length`)
  check('nodes are drawn', drawn > 0, `${drawn} nodes`)
  check('and the edges between them', lines > 0, `${lines} edges`)

  const summary = await text('#graph-summary')
  check('the summary counts what is on the canvas',
    summary.includes(`${drawn} nodes`) && summary.includes(`${lines} edges`), summary)

  // The two kinds the fixture created — both are on the canvas, which is the
  // only proof the edge kinds beyond `host` are wired at all.
  const labels = await evaluate(`[...document.querySelectorAll('#infra-graph text')].map(t => t.textContent)`)
  check('the created hostname is a node', labels.some(l => l.includes('drive.example.test')), labels.slice(0, 8).join(' | '))
  check('and the created network', labels.some(l => l.includes('Drive mesh')), labels.slice(0, 8).join(' | '))

  // A filter takes a lane out of the projection rather than hiding it with CSS
  // — the node count has to fall.
  await evaluate(`[...document.querySelectorAll('#graph-filters button')]
    .find(b => b.textContent.trim().startsWith('Networks')).click()`)
  await until(`document.querySelectorAll('#infra-graph g').length`, n => n < drawn,
    'turning a kind off removed no nodes')
  ok('turning a kind off removes its nodes')

  // ── /dns/ ──────────────────────────────────────────────────────────────
  console.log('\n  /dns/ — hostnames and certificates')
  await goto('/dns/')
  await until(`document.querySelectorAll('#dns-rows tbody tr').length`, n => n > 0,
    'the hostname table never rendered a row')
  const dns = await text('#dns-rows')
  check('the created hostname is listed', dns.includes('drive.example.test'), dns.slice(0, 120))
  check('with the app it points at resolved to a name', dns.includes(firstApp.name), dns.slice(0, 200))
  check('and a certificate status rather than a blank cell', dns.includes('none'), dns.slice(0, 200))
  check('the vendor half is a skeleton, not a number',
    await evaluate(`document.querySelectorAll('[aria-busy="true"] .skeleton').length`) > 0)
  // The word comes from the portal's ping, not from the page. `IEdge` is
  // declared with a stub behind it, so it must read unconfigured here — and
  // must stop reading it the day an adapter is wired.
  check('and the edge adapter reports its real state', (await text('#edge-status')).trim() === 'unconfigured',
    await text('#edge-status'))

  // ── /cloud-spend/ ──────────────────────────────────────────────────────
  console.log('\n  /cloud-spend/ — the inventory a bill would cover')
  await goto('/cloud-spend/')
  await until(`document.querySelectorAll('#spend-rows tbody tr').length`, n => n > 0,
    'the fleet table never rendered')
  const fleetRows = await evaluate(`document.querySelectorAll('#spend-rows tbody tr').length`)
  const providerTotal = await evaluate(`[...document.querySelectorAll('#spend-by-provider dd')]
    .reduce((n, dd) => n + Number(dd.textContent), 0)`)
  check('the provider tally sums to the fleet', providerTotal === fleetRows,
    `${providerTotal} tallied, ${fleetRows} rows`)
  check('and the money is a skeleton',
    await evaluate(`document.querySelectorAll('[aria-busy="true"] .skeleton').length`) > 0)
  check('with the spend adapter reporting its real state',
    (await text('#spend-status')).trim() === 'unconfigured', await text('#spend-status'))
  check('with no currency figure anywhere on it', !/[$£€]\s?\d/.test(await body()))

  // ── The counts are a PROJECTION, and the projection is scoped ─────────
  //
  // `view fleetByProvider` in db/schema.lite. Two things are asserted and only
  // the second needs this app: that the number on screen is the database's
  // answer rather than a tally of whatever page of servers the screen fetched,
  // and that the projection narrows to ONE workspace with no where-clause
  // written anywhere — not in the service, not on the screen. Tenancy is
  // declared once at the top of the schema and the parser gives a scoped view
  // a generated READ deny; `membershipClaim` resolves the claim per request.
  const activeWs = await evaluate(`localStorage.getItem('basecamp_workspace')`)
  const fleetApi = await apiGet('/fleet')
  const projected = (fleetApi.body?.data ?? []).reduce((n, r) => n + (r.servers ?? 0), 0)
  check('the total on screen is the projection, not a tally of the listed page',
    Number((await text('#spend-total')).trim()) === projected,
    `screen ${await text('#spend-total')}, projection ${projected}`)
  check('and the projection only carries this workspace',
    (fleetApi.body?.data ?? []).length > 0 &&
    (fleetApi.body?.data ?? []).every(r => r.workspaceId === activeWs),
    JSON.stringify(fleetApi.body?.data?.map(r => r.workspaceId)))

  // The other half, and the one a single-tenant app cannot ask. The seeded
  // owner is a member of every workspace, so the SAME principal asking the
  // SAME question about a different one gets a different answer — which is the
  // declared claim doing the narrowing, since nothing in the path writes a
  // filter.
  const wsList = await apiGet('/workspaces')
  const otherWs = (wsList.body?.data ?? []).find(w => w.id !== activeWs)
  check('the seeded owner belongs to more than one workspace', !!otherWs,
    JSON.stringify(wsList.body?.data?.map(w => w.id)))
  if (otherWs) {
    const otherFleet = await apiGet('/fleet', otherWs.id)
    check('the same principal asking about another workspace gets that one',
      (otherFleet.body?.data ?? []).length > 0 &&
      (otherFleet.body?.data ?? []).every(r => r.workspaceId === otherWs.id),
      JSON.stringify(otherFleet.body?.data?.map(r => r.workspaceId)))
  }

  // The negative control, and it is what separates *scoped by the membership
  // row* from *scoped by whatever the header said*. A workspace this caller is
  // not in must not answer rows, and the refusal has to be a status rather
  // than an empty list — an empty projection and a refused one look identical
  // to a reader counting rows.
  const strangerWs = await apiGet('/fleet', '00000000-0000-4000-8000-000000000000')
  check('a workspace the caller is not in is refused, not answered empty',
    strangerWs.status >= 400,
    `${strangerWs.status} ${JSON.stringify(strangerWs.body)?.slice(0, 120)}`)

  // ── /git-activity/ and /observability/ ─────────────────────────────────
  // Both report an adapter the test environment does not configure, and the
  // word they print comes from the portal's own ping — the same read
  // /admin/adapters/ makes. A screen that hardcoded "not connected" would pass
  // an assertion on the text and be wrong the day one is wired.
  for (const [path, id, label] of [
    ['/git-activity/',   'git-status',           'git activity'],
    ['/observability/',  'observability-status', 'observability'],
  ]) {
    console.log(`\n  ${path}`)
    await goto(path)
    await until(`!!document.getElementById(${JSON.stringify(id)})`, v => v, `${label} never reported a status`)
    const status = await text(`#${id}`)
    check(`${label} reports the adapter's real state`, status.trim() === 'unconfigured', status)
    check('and shows a skeleton where the data would be',
      await evaluate(`document.querySelectorAll('[aria-busy="true"] .skeleton').length`) > 0)
  }

  // ── /admin/adapters/ ───────────────────────────────────────────────────
  // Ten providers in two groups. The split is the SERVICE's (`hosted`), so an
  // adapter added to one list cannot go missing from the other.
  console.log('\n  /admin/adapters/ — ten, in two kinds')
  await goto('/admin/adapters/')
  await until(`document.querySelectorAll('#adapter-tiles .card').length`, n => n > 0,
    'the appliance grid never rendered')
  const appliances = await evaluate(`document.querySelectorAll('#adapter-tiles .card').length`)
  const hostedN    = await evaluate(`document.querySelectorAll('#hosted-tiles .card').length`)
  check('eight self-hosted appliances', appliances === 8, `saw ${appliances}`)
  check('and two hosted services', hostedN === 2, `saw ${hostedN}`)
  const hostedText = await text('#hosted-tiles')
  check('the hosted pair are the two the screens ask about',
    hostedText.includes('Edge & DNS') && hostedText.includes('Cloud spend'), hostedText.slice(0, 120))

  // ── A detail screen with no record ─────────────────────────────────────
  //
  // `FJS-968`. Every one of these screens used to answer with one of three
  // wrong things: `apps/[id]` said *App not found — it may have been deleted*
  // for ANY throw in load(), five rendered NOTHING at all when the row was
  // genuinely absent, and the same five rendered a failure as an alert with no
  // heading above it. Each state is asserted here PAIRED with the one it was
  // being confused with, because a component that gave one answer to
  // everything is exactly what was there before.
  //
  // It goes last: the failure case stops the API, and nothing after it could
  // read anything.
  console.log('\n  a detail screen with no record')

  // GONE. A real id that is not in the database, over the real transport — so
  // this is the boundary answering, not a stub.
  await goto('/apps/00000000-0000-4000-8000-0000000000ff/')
  await until(`document.querySelector('h1')?.textContent ?? ''`, t => t.length > 0,
    'the missing-record screen rendered no heading at all')
  const goneHeading = (await text('h1')).trim()
  check('a record that is not there says so, in a heading',
    goneHeading === 'App not found', goneHeading)
  check('and says the two things it could be',
    (await body()).includes('deleted, or it belongs to another workspace'))
  // The pair. A screen that said this for every state would pass the two rows
  // above and be the bug this closed.
  check('with no failure alert beside it — nothing failed',
    await evaluate(`!document.getElementById('screen-error')`))
  check('and no retry button, because retrying cannot make it exist',
    !(await body()).includes('Try again'))

  // The control: the same screen, a real id, still renders the record. Without
  // it every row above passes against a detail screen that renders nothing.
  const realApp = await apiGet('/apps')
  const realId  = realApp.body?.data?.[0]?.id
  check('the same screen still opens a record that IS there', !!realId)
  await goto(`/apps/${realId}/`)
  await until(`document.getElementById('app-status') !== null`, v => v,
    'the app detail never rendered for a real id')
  check('and its heading is the record, not a state',
    (await text('h1')).trim() !== 'App not found', await text('h1'))

  // A hostname written from OUTSIDE the screen — not its own add button, which
  // reloads by itself — arrives with no reload. The listener that does it is one
  // declaration whose `const` spelling the compiler makes lazy, and read only
  // in teardown it registered at destroy (`FJS-1062`).
  const liveHost = 'live.example.test'
  // On the Domains tab: this app already has a primary hostname from the /dns/
  // section above, so a second one is listed there and nowhere on the overview.
  await evaluate(`[...document.querySelectorAll('#app-tabs [role=tab]')].find(b => b.textContent.trim() === 'domains').click()`)
  await until(`!!document.getElementById('domain-list')`, v => v, 'the domains tab never opened')
  const madeLive = await apiPost('/domains', { appId: realId, hostname: liveHost, isPrimary: false })
  check('a hostname written behind the open screen was accepted', madeLive.status < 300,
    JSON.stringify(madeLive).slice(0, 200))
  const liveSeen = await until(`document.body.textContent.includes(${JSON.stringify(liveHost)})`, v => v,
    'the hostname never appeared', 8_000).catch(() => false)
  check('and the open app screen shows it without a reload', !!liveSeen)

  // ─── The edit surfaces ─────────────────────────────────────────────────
  // Four screens take their form from the resource file's markup half, and
  // what the schema says about each column is the whole of what decides the
  // box: `@immutable` frozen on an edit and writable on a create, `@system`
  // never offered. Every check changes a value and reads it back through the
  // API, because a drawer that closes on a refused save looks like a pass.
  console.log('\n  the edit surfaces — each model\'s default form')

  const typeIn = (sel, v) => evaluate(`
    (() => { const el = document.querySelector(${JSON.stringify(sel)})
             if (!el) throw new Error('no ' + ${JSON.stringify(sel)})
             el.value = ${JSON.stringify(v)}
             el.dispatchEvent(new Event('input',  { bubbles: true }))
             el.dispatchEvent(new Event('change', { bubbles: true }))
             return true })()`)
  const frozen  = sel => evaluate(`!!document.querySelector(${JSON.stringify(sel)})?.disabled`)
  const present = sel => evaluate(`!!document.querySelector(${JSON.stringify(sel)})`)
  const clickText = (scope, label) => evaluate(`
    (() => { const b = [...document.querySelectorAll(${JSON.stringify(scope + ' button')})]
               .find(b => b.textContent.trim() === ${JSON.stringify(label)})
             if (!b) throw new Error('no button "' + ${JSON.stringify(label)} + '" in ' + ${JSON.stringify(scope)})
             b.click(); return true })()`)
  // `data-confirm` stops the first click and asks; the panel's last button is
  // the one that lets it through.
  const confirmIt = async () => {
    await until(`!!document.querySelector('[role=dialog][aria-modal=false]')`, v => v, 'no confirmation was asked')
    await evaluate(`document.querySelector('[role=dialog][aria-modal=false] .cluster button:last-child').click()`)
  }

  // App — the drawer, and what the schema froze.
  await goto(`/apps/${realId}/`)
  await until(`!!document.getElementById('app-breadcrumb')`, v => v, 'the app screen never rendered')
  check('an app names its project and its environment above it',
    await evaluate(`document.querySelectorAll('#app-breadcrumb a').length`) === 2)
  await click('#app-more')
  await until(`!!document.getElementById('app-edit')`, v => v, 'the app menu never opened')
  await click('#app-edit')
  await until(`!!document.getElementById('app-edit-save')`, v => v, 'the app form never opened')
  check('an app\'s address is shown frozen on an edit', await frozen('dialog[open] [name=slug]'))
  check('and so is the environment it lives in', await frozen('dialog[open] [name=environmentId]'))
  check('and the status the machine reports is not offered at all',
    !(await present('dialog[open] [name=status]')))
  await typeIn('dialog[open] [name=name]', 'web-edited')
  await typeIn('dialog[open] [name=port]', '3100')
  await click('#app-edit-save')
  await until(`document.querySelector('h1')?.textContent.includes('web-edited')`, v => v,
    'the app heading never took the new name')
  const appAfter = (await apiGet(`/apps/${realId}`)).body
  check('and the save reached the row', appAfter?.name === 'web-edited' && appAfter?.port === 3100,
    JSON.stringify({ name: appAfter?.name, port: appAfter?.port }))

  // Environment — rename, and a variable edited where it stands.
  const envId = appAfter?.environmentId
  await goto(`/environments/${envId}/`)
  await until(`!!document.getElementById('env-edit')`, v => v, 'the environment screen never rendered')
  await click('#env-edit')
  await until(`!!document.getElementById('env-edit-save')`, v => v, 'the environment form never opened')
  check('an environment\'s project is frozen on an edit', await frozen('dialog[open] [name=projectId]'))
  check('and its variables are not a box on it — they have their own editor',
    !(await present('dialog[open] [name=variables]')))
  await typeIn('dialog[open] [name=name]', 'Production edited')
  await click('#env-edit-save')
  await until(`document.querySelector('h1')?.textContent.includes('Production edited')`, v => v,
    'the environment heading never took the new name')
  ok('an environment is renamed from its own screen')

  await typeIn('#var-key', 'SCREENS_PROBE')
  await typeIn('#var-value', 'first')
  await clickText('form.card', 'Set variable')
  await until(`document.getElementById('variable-rows')?.textContent.includes('SCREENS_PROBE')`, v => v,
    'the variable never appeared')
  await clickText('#variable-rows', 'Edit')
  await until(`!!document.getElementById('var-edit-SCREENS_PROBE')`, v => v, 'the value never became editable')
  await typeIn('#var-edit-SCREENS_PROBE', 'second')
  await clickText('#variable-rows', 'Save')
  await until(`document.getElementById('variable-rows')?.textContent.includes('second')`, v => v,
    'the edited value never showed')
  const envAfter = (await apiGet(`/environments/${envId}`)).body
  check('a variable edited in place is the one stored',
    envAfter?.variables?.find(v => v.key === 'SCREENS_PROBE')?.value === 'second')

  // Job — the create form may choose what the edit form freezes.
  await goto('/jobs/')
  await until(`!!document.getElementById('job-new')`, v => v, 'the jobs screen never rendered')
  await click('#job-new')
  await until(`!!document.getElementById('job-create-save')`, v => v, 'the job form never opened')
  check('a new job may choose its kind', !(await frozen('dialog[open] [name=kind]')))
  check('and is not offered a state — it is born pending', !(await present('dialog[open] [name=status]')))
  await typeIn('dialog[open] [name=name]', 'Screens probe')
  await typeIn('dialog[open] [name=kind]', 'scheduled')
  await typeIn('dialog[open] [name=cronExpression]', '*/5 * * * *')
  await click('#job-create-save')
  await until(`document.getElementById('job-rows')?.textContent.includes('Screens probe')`, v => v,
    'the new job never appeared in the list')
  const probe = (await apiGet('/jobs')).body?.data?.find(j => j.name === 'Screens probe')
  check('and it was made the kind that was chosen', probe?.kind === 'scheduled', probe?.kind)

  await goto(`/jobs/${probe?.id}/`)
  await until(`!!document.getElementById('job-edit')`, v => v, 'the job screen never rendered')
  await click('#job-edit')
  await until(`!!document.getElementById('job-edit-save')`, v => v, 'the job edit form never opened')
  check('the same column is frozen once the job exists', await frozen('dialog[open] [name=kind]'))
  await typeIn('dialog[open] [name=cronExpression]', '0 * * * *')
  await click('#job-edit-save')
  await until(`document.body.textContent.includes('0 * * * *')`, v => v, 'the new schedule never showed')
  ok('a job\'s schedule is edited from its screen')

  await click('#job-delete')
  await confirmIt()
  await until(`location.pathname`, p => p === '/jobs/', 'deleting the job never left its screen')
  check('and a deleted job is gone from the list',
    !(await apiGet('/jobs')).body?.data?.some(j => j.id === probe?.id))

  // Alert rule — the column the old form never had.
  await goto('/alerts/')
  await until(`!!document.getElementById('alert-list')`, v => v, 'the alerts screen never rendered')
  await clickText('#alert-list', 'Edit')
  await until(`!!document.querySelector('[id^=alert-edit-save-]')`, v => v, 'the rule form never opened')
  await typeIn('#alert-list [name=description]', 'Pages the on-call when it holds')
  await evaluate(`document.querySelector('[id^=alert-edit-save-]').click()`)
  await until(`document.getElementById('alert-list')?.textContent.includes('Pages the on-call')`, v => v,
    'the description never showed on the card')
  ok('an alert rule is edited, description included')

  // Deleting from a watched screen: the delete's own push empties the record
  // under the handler, which is how the job screen above once deleted the row
  // and then stayed where it was.
  await goto(`/apps/${realId}/`)
  await until(`!!document.getElementById('app-more')`, v => v, 'the app screen never rendered')
  await click('#app-more')
  await until(`!!document.getElementById('app-delete')`, v => v, 'the app menu never opened')
  await click('#app-delete')
  await confirmIt()
  await until(`location.pathname`, p => p === `/environments/${envId}/`,
    'deleting the app never landed on its environment')
  check('an app deleted from its menu lands on the environment it was in, and is gone',
    (await apiGet(`/apps/${realId}`)).status === 404)

  // ─── Account: two-step sign-in, and a forgotten password ───────────────
  // Both walk the whole loop a person does. The code is computed from the
  // secret the screen showed, which is what an authenticator does; the reset
  // link is read from the API's log, which is where it goes with no mailer.
  console.log('\n  your account — two-step sign-in, and a forgotten password')
  await goto('/settings/')
  await until(`document.getElementById('settings-totp')?.dataset.totpState`, v => v === 'off',
    'the two-step card never said off')
  await fill({ 'totp-password': PASSWORD })
  await click('#totp-enable')
  const secret = await until(`document.getElementById('totp-secret')?.textContent.trim()`, v => v,
    'setting up never showed a secret')
  await fill({ 'totp-code': totp(secret, new Date()) })
  await click('#totp-confirm')
  const codes = await until(`document.querySelectorAll('#recovery-codes [data-recovery-code]').length`, n => n > 0,
    'confirming never showed the recovery codes')
  check('confirming a code from the secret turns it on, and shows ten recovery codes', codes === 10, `saw ${codes}`)
  await click('#recovery-done')
  const remaining = await until(`document.getElementById('totp-remaining')?.textContent.trim()`, v => v,
    'the on state never rendered')
  check('and the card counts them', remaining === '10', remaining)
  await fill({ 'totp-password': PASSWORD })
  await click('#totp-disable')
  await confirmIt()
  await until(`document.getElementById('settings-totp')?.dataset.totpState`, v => v === 'off',
    'turning it off never came back off')
  ok('and turning it off, with the password, puts it back')

  // Forgot password. Open while signed in, as the mail's link must be.
  await goto('/reset-password/')
  await until(`!!document.getElementById('reset-email')`, v => v, 'the reset request form never rendered')
  await fill({ 'reset-email': EMAIL })
  await click('#reset-send')
  await until(`!!document.getElementById('reset-sent')`, v => v, 'sending never confirmed')
  check('asking for a link answers without saying whether the address exists',
    /If .* is a Basecamp account/.test(await text('#reset-sent')))
  const link = await (async () => {
    for (let i = 0; i < 40; i++) {
      const m = apiLog.match(/reset your password link for \S+: (\S+)/)
      if (m) return m[1]
      await sleep(250)
    }
    return null
  })()
  check('with no mailer, the API logs the link rather than dropping it', !!link, apiLog.slice(-300))
  if (link) {
    const url = new URL(link)
    check('the link points at this app\'s reset screen', url.pathname === '/reset-password/', link)
    await goto(url.pathname + url.search)
    await until(`!!document.getElementById('reset-password')`, v => v, 'the new-password form never rendered')
    await fill({ 'reset-password': PASSWORD, 'reset-confirm': PASSWORD })
    await click('#reset-submit')
    await until(`location.pathname`, p => p === '/login/', 'a reset never landed on sign-in')
    ok('a new password from the link lands on sign-in')
    check('where the form offers the way back here', await present('#forgot-password'))
    await goto(url.pathname + url.search)
    await until(`!!document.getElementById('reset-password')`, v => v, 'the form never rendered twice')
    await fill({ 'reset-password': PASSWORD, 'reset-confirm': PASSWORD })
    await click('#reset-submit')
    await until(`document.body.textContent`, t => /expired or was already used/.test(t),
      'a spent link was not refused in words')
    ok('and the same link a second time is refused, saying why')

    // The reset signed every session out. Back in, for what follows.
    await goto('/login/')
    await until(`!!document.getElementById('email')`, v => v, 'the sign-in form never rendered')
    await fill({ email: EMAIL, password: PASSWORD })
    await evaluate(`document.querySelector('button[type=submit]').click()`)
    await until(`location.pathname`, p => p === '/', 'signing in with the new password never landed')
    ok('and the new password signs in')
  }

  // ─── Flags, secrets, recipes, channels — the writes each screen lacked ──
  // Each changes a value on screen and reads the row back through the API.
  console.log('\n  flags, secrets, recipes and channels — edits and rotations')
  const byLabel = label => evaluate(`
    (() => { const b = document.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']')
             if (!b) throw new Error('no control labelled ' + ${JSON.stringify(label)})
             b.click(); return true })()`)
  const pickIn = (sel, v) => evaluate(`
    (() => { const el = document.querySelector(${JSON.stringify(sel)})
             if (!el) throw new Error('no ' + ${JSON.stringify(sel)})
             el.value = ${JSON.stringify(v)}
             el.dispatchEvent(new Event('input',  { bubbles: true }))
             el.dispatchEvent(new Event('change', { bubbles: true }))
             return el.value })()`)

  // Flags — a variant flag can be made at all, which the create form could
  // not do: the service needs two variants and there was nowhere to type one.
  await goto('/flags/')
  await until(`!!document.getElementById('new-flag')`, v => v, 'the flags screen never rendered')
  await click('#new-flag')
  await until(`!!document.getElementById('key')`, v => v, 'the new-flag form never opened')
  await typeIn('#key', 'drive-variant')
  await pickIn('#type', 'variant')
  await until(`!!document.getElementById('new-variant-add')`, v => v, 'choosing variant never offered a variants editor')
  await click('#new-variant-add'); await click('#new-variant-add')
  await until(`document.querySelectorAll('[data-variant-row]').length`, n => n === 2, 'two variant rows never appeared')
  await typeIn('#new-variant-key-0', 'a'); await typeIn('#new-variant-weight-0', '50')
  await typeIn('#new-variant-key-1', 'b'); await typeIn('#new-variant-weight-1', '50')
  await typeIn('#rollout', '40')
  await evaluate(`document.querySelector('#key').form.requestSubmit()`)
  const flagRow = await (async () => {
    for (let i = 0; i < 40; i++) {
      const f = (await apiGet('/flags')).body?.data?.find(f => f.key === 'drive-variant')
      if (f) return f
      await sleep(250)
    }
    return null
  })()
  check('a variant flag is created with its variants and its rollout',
    flagRow?.variants?.length === 2 && flagRow?.rollout === 40, JSON.stringify(flagRow)?.slice(0, 200))

  await until(`!!document.querySelector('[aria-label="Edit drive-variant"]')`, v => v, 'the new flag never listed')
  await byLabel('Edit drive-variant')
  await until(`!!document.getElementById('flag-edit-save')`, v => v, 'the flag edit drawer never opened')
  await typeIn('#edit-rollout', '70')
  await typeIn('#edit-variant-weight-0', '60'); await typeIn('#edit-variant-weight-1', '40')
  await click('#flag-edit-save')
  await until(`!document.getElementById('flag-edit-save')`, v => v, 'the flag edit never closed')
  const flagEdited = (await apiGet(`/flags/${flagRow?.id}`)).body
  check('its rollout and weights are edited from the drawer',
    flagEdited?.rollout === 70 && flagEdited?.variants?.map(v => v.weight).join() === '60,40',
    JSON.stringify({ r: flagEdited?.rollout, v: flagEdited?.variants }))

  await clickText('#flag-list .card:has([aria-label="Edit drive-variant"])', 'Environments')
  const envSel = `#env-${flagRow?.id}`
  await until(`document.querySelectorAll('${envSel} option').length`, n => n > 1, 'the override picker never filled')
  const envOption = await evaluate(`[...document.querySelectorAll('${envSel} option')].find(o => o.value)?.textContent ?? ''`)
  check('an environment is named with its project', envOption.includes(' / '), envOption)
  const envPicked = await evaluate(`[...document.querySelectorAll('${envSel} option')].find(o => o.value).value`)
  await pickIn(envSel, envPicked)
  await clickText('#flag-list .card:has([aria-label="Edit drive-variant"])', 'Force off here')
  await until(`!!document.querySelector('#pin-${flagRow?.id}-${envPicked}')`, v => v, 'the forced-off override never listed')
  await pickIn(`#pin-${flagRow?.id}-${envPicked}`, 'b')
  const pinned = await (async () => {
    for (let i = 0; i < 40; i++) {
      const o = (await apiGet(`/flags/${flagRow?.id}`)).body?.overrides?.[0]
      if (o?.variantKey === 'b') return o
      await sleep(250)
    }
    return (await apiGet(`/flags/${flagRow?.id}`)).body?.overrides?.[0]
  })()
  check('an environment can be forced off, and a variant pinned there without turning it back on',
    pinned?.isEnabled === false && pinned?.variantKey === 'b', JSON.stringify(pinned)?.slice(0, 160))

  // Secrets — rotated in place: the same row, so nothing that holds its id
  // has to be told, and unverified until tested again.
  await goto('/secrets/')
  await until(`!!document.querySelector('[aria-label^="Rotate "]')`, v => v, 'no secret offers a rotation')
  const secretsBefore = (await apiGet('/secrets')).body?.data ?? []
  const verifiedOne = secretsBefore.find(x => x.isVerified && x.kind === 'notification')
  await byLabel(`Rotate ${verifiedOne?.name}`)
  await until(`!!document.getElementById('rotate-value')`, v => v, 'the rotate drawer never opened')
  await typeIn('#rotate-value', JSON.stringify({ url: 'https://hooks.example.com/rotated' }))
  await click('#rotate-save')
  await until(`!document.getElementById('rotate-save')`, v => v, 'the rotation never closed')
  const rotated = (await apiGet(`/secrets/${verifiedOne?.id}`)).body
  check('a secret is rotated in place, and is unverified until tested',
    rotated?.id === verifiedOne?.id && rotated?.isVerified === false && rotated?.version > verifiedOne?.version,
    JSON.stringify({ v: rotated?.isVerified, before: verifiedOne?.version, after: rotated?.version }))

  // Recipes — the author's four columns and none of the run job's.
  await goto('/recipes/')
  await until(`!!document.getElementById('recipe-list')`, v => v, 'the recipes screen never rendered')
  const ran = (await apiGet('/recipes')).body?.data?.find(r => r.runCount > 0)
  await byLabel(`Run ${ran?.name}`).catch(() => {})
  // That opened a confirmation; nothing is run by this drive.
  await evaluate(`document.querySelector('[role=dialog][aria-modal=false] .btn.ghost')?.click()`)
  await clickText(`#recipe-list .card:has([aria-label="Run ${ran?.name}"])`, 'Script and history')
  await until(`document.querySelectorAll('#recipe-runs a[href^="/servers/"]').length`, n => n > 0,
    'a run never linked to its machine')
  ok('each run links to the machine it ran on')
  await click('#recipe-edit')
  await until(`!!document.querySelector('#recipe-edit-save')`, v => v, 'the recipe drawer never opened')
  check('the recipe drawer offers a timeout', await present('dialog[open] [name=timeoutSeconds]'))
  check('and not the run counters', !(await present('dialog[open] [name=runCount]')) && !(await present('dialog[open] [name=lastRunAt]')))
  await typeIn('dialog[open] [name=timeoutSeconds]', '120')
  await click('#recipe-edit-save')
  await until(`!document.querySelector('#recipe-edit-save')`, v => v, 'the recipe drawer never closed')
  check('a recipe\'s timeout is edited', (await apiGet(`/recipes/${ran?.id}`)).body?.timeoutSeconds === 120)

  // Channels — edited, the credential rotated behind the SAME secret, and the
  // rules that deliver through one listed.
  await goto('/channels/')
  await until(`!!document.getElementById('channel-rows')`, v => v, 'the channels screen never rendered')
  const chans = (await apiGet('/channels')).body?.data ?? []
  // The seed picks each workspace's kinds at random, so whichever carries a
  // credential — one already stored, or a kind that takes one.
  const slackCh = chans.find(c => c.secretId) ?? chans.find(c => ['slack', 'webhook', 'pagerduty'].includes(c.kind))
  await byLabel(`Edit ${slackCh?.name}`)
  await until(`!!document.getElementById('channel-edit-save')`, v => v, 'the channel drawer never opened')
  await typeIn('#edit-name', `${slackCh?.name} ops`)
  await typeIn('#edit-secret', 'rotated-credential-value')
  await click('#channel-edit-save')
  await until(`!document.getElementById('channel-edit-save')`, v => v, 'the channel drawer never closed')
  const chAfter = (await apiGet(`/channels/${slackCh?.id}`)).body
  check('a channel is renamed from its drawer', chAfter?.name === `${slackCh?.name} ops`, chAfter?.name)
  if (slackCh?.secretId) {
    const chSecret = (await apiGet(`/secrets/${slackCh.secretId}`)).body
    check('and its credential is rotated behind the same secret', chAfter?.secretId === slackCh.secretId && chSecret?.isVerified === false,
      JSON.stringify({ same: chAfter?.secretId === slackCh.secretId, verified: chSecret?.isVerified }))
  } else {
    check('and a channel that held no credential is given one', !!chAfter?.secretId, JSON.stringify(chAfter?.secretId))
  }
  const ruled = chans.find(c => c.rule_count > 0)
  if (ruled) {
    await byLabel(`Rules delivering through ${ruled.id === slackCh?.id ? `${slackCh.name} ops` : ruled.name}`)
    const listed = await until(`document.querySelectorAll('#rules-${ruled.id} li').length`, n => n > 0,
      'the rules never listed').catch(() => 0)
    check('the rules that deliver through a channel are listed', listed === ruled.rule_count, `${listed} of ${ruled.rule_count}`)
  } else bad('the seed has a rule delivering through a channel')

  // ─── Workspace, and a key a bot owns ───────────────────────────────────
  console.log('\n  the workspace itself, and a key for a bot')
  const homeWs = await evaluate(`localStorage.getItem('basecamp_workspace')`)
  await goto('/admin/workspace/')
  await until(`!!document.getElementById('ws-name')`, v => v, 'the workspace screen never rendered')
  const wsName = await evaluate(`document.getElementById('ws-name').value`)
  await typeIn('#ws-name', `${wsName} renamed`)
  await click('#ws-save')
  const renamed = await (async () => {
    for (let i = 0; i < 40; i++) {
      const w = (await apiGet(`/workspaces/${homeWs}`)).body
      if (w?.name === `${wsName} renamed`) return w
      await sleep(250)
    }
    return null
  })()
  check('the workspace is renamed from its admin screen', !!renamed)
  // The screen settles on the saved row before it is edited again: the save
  // resets the draft from the answer, and a keystroke before that is lost.
  await until(`document.getElementById('ws-save')?.disabled`, v => v === true, 'the rename never settled')
  await typeIn('#ws-name', wsName)
  await click('#ws-save')
  await until(`document.getElementById('ws-save')?.disabled || document.getElementById('workspace-error')?.textContent`,
    v => v === true, 'renaming back never settled')

  await typeIn('#ws-new-name', 'Drive scratch')
  await click('#ws-create')
  await until(`location.pathname === '/' || document.getElementById('workspace-error')?.textContent || location.pathname`,
    v => v === true, 'creating a workspace never landed home')
  const scratchWs = await until(`localStorage.getItem('basecamp_workspace')`, v => v && v !== homeWs,
    'the new workspace was never switched to')
  const scratchRow = (await apiGet('/workspaces')).body?.data?.find(w => w.id === scratchWs)
  check('a new workspace is made, and is the one you are in', scratchRow?.name === 'Drive scratch', JSON.stringify(scratchRow?.name))
  await goto('/admin/workspace/')
  await until(`document.getElementById('ws-name')?.value`, v => v === 'Drive scratch', 'the scratch workspace never loaded')
  check('deleting is refused until the name is typed', await evaluate(`document.getElementById('ws-delete').disabled`))
  await typeIn('#ws-delete-confirm', 'Drive scratch')
  await click('#ws-delete')
  await until(`localStorage.getItem('basecamp_workspace')`, v => v !== scratchWs, 'deleting never moved off the workspace')
  check('and typing it deletes it', !(await apiGet('/workspaces')).body?.data?.some(w => w.id === scratchWs))
  await evaluate(`localStorage.setItem('basecamp_workspace', ${JSON.stringify(homeWs)})`)

  // ─── Handing a workspace over, and leaving it ──────────────────────────
  // On a workspace of its own, so the seeded owner every later section signs
  // in as keeps the home one.
  console.log('\n  handing a workspace over, and leaving it')
  const callWs = (id, method, payload = {}) => evaluate(`
    fetch('/workspaces/' + ${JSON.stringify(id)}, { method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json',
      'x-service-method': ${JSON.stringify(method)},
      authorization: 'Bearer ' + localStorage.getItem('basecamp_token'),
    }, body: JSON.stringify(${JSON.stringify(payload)}) })
      .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`)
  const handWs = (await apiPost('/workspaces', { name: 'Drive handover' })).body
  const homeMembers = (await callWs(homeWs, 'members')).body?.data ?? []
  const kim = homeMembers.find(m => m.user?.email === 'kim@example.com')
  const added = await callWs(handWs?.id, 'addMember', { userId: kim?.userId, role: 'developer' })
  check('a workspace to hand over, with a second member', added.status < 300, JSON.stringify(added).slice(0, 160))

  await evaluate(`localStorage.setItem('basecamp_workspace', ${JSON.stringify(handWs?.id)})`)
  await goto('/settings/')
  const standing = await until(`document.getElementById('standing-role')?.textContent ?? ''`,
    t => /here/.test(t), 'the standing never rendered')
  check('settings says what you hold in the workspace you are in', standing.trim() === 'owner here', standing)
  await click('#leave-workspace')
  await confirmIt()
  const onlyOwner = await until(`document.getElementById('screen-error')?.textContent ?? ''`, t => t.length > 0,
    'leaving as the only owner was not refused')
  check('the only owner is refused, and told to hand it over first', /Hand ownership/.test(onlyOwner), onlyOwner)

  await goto('/admin/')
  const kimRow = await until(`[...document.querySelectorAll('#member-rows tbody tr')]
    .find(r => r.textContent.includes('kim@example.com'))?.querySelector('[id^=hand-over-]')?.id ?? ''`,
    v => v, 'no Hand over on the other member')
  await click(`#${kimRow}`)
  await confirmIt()
  const handed = await (async () => {
    for (let i = 0; i < 40; i++) {
      const rows = (await callWs(handWs.id, 'members')).body?.data ?? []
      const roles = Object.fromEntries(rows.map(m => [m.user?.email, m.role]))
      if (roles['kim@example.com'] === 'owner') return roles
      await sleep(250)
    }
    return null
  })()
  check('handing over makes them the owner and you an admin',
    handed?.['kim@example.com'] === 'owner' && handed?.[EMAIL] === 'admin', JSON.stringify(handed))

  await goto('/settings/')
  await until(`document.getElementById('standing-role')?.textContent ?? ''`, t => t.trim() === 'admin here',
    'settings never showed the new standing')
  await click('#leave-workspace')
  await confirmIt()
  await until(`localStorage.getItem('basecamp_workspace')`, v => v !== handWs.id, 'leaving never moved off the workspace')
  check('and then you can leave it, and it is gone from your list',
    !(await apiGet('/workspaces')).body?.data?.some(w => w.id === handWs.id))
  await evaluate(`localStorage.setItem('basecamp_workspace', ${JSON.stringify(homeWs)})`)

  // A bot, then a key that belongs to it.
  await goto('/hub/users/')
  await until(`!!document.getElementById('new-bot')`, v => v, 'the hub users screen never rendered')
  await click('#new-bot')
  await until(`!!document.getElementById('bot-name')`, v => v, 'the bot form never opened')
  await typeIn('#bot-name', 'Drive CI')
  await pickIn('#bot-ws', homeWs)
  await click('#create-bot')
  const bot = await (async () => {
    for (let i = 0; i < 40; i++) {
      const m = await evaluate(`
        fetch('/workspaces/${homeWs}', { method: 'POST', headers: {
          accept: 'application/json', 'content-type': 'application/json', 'x-service-method': 'members',
          authorization: 'Bearer ' + localStorage.getItem('basecamp_token'),
          'x-workspace-id': ${JSON.stringify(homeWs)} }, body: '{}' }).then(r => r.json())`)
      const b = (m?.data ?? []).find(x => x.user?.kind === 'bot' && /Drive CI/.test(x.user?.displayName ?? x.user?.name ?? ''))
      if (b) return b
      await sleep(250)
    }
    return null
  })()
  check('a bot account is made in this workspace', !!bot)

  await goto('/api-keys/')
  await until(`!!document.getElementById('new-key')`, v => v, 'the API keys screen never rendered')
  await click('#new-key')
  await until(`document.querySelectorAll('#key-owner option').length`, n => n > 1, 'the key form offers no owner')
  await pickIn('#key-owner', bot?.userId ?? '')
  await typeIn('#name', 'drive-bot-key')
  await evaluate(`document.querySelector('#scope-picker input[type=checkbox]').click()`)
  await click('#issue-key')
  await until(`!!document.getElementById('minted-token')`, v => v, 'no token was minted for the bot')
  const botKey = (await apiGet('/api-keys')).body?.data?.find(k => k.name === 'drive-bot-key')
  check('a key issued from the form belongs to the bot it named', botKey?.userId === bot?.userId,
    JSON.stringify({ key: botKey?.userId, bot: bot?.userId }))

  // ─── A lost second factor, reset from the hub ──────────────────────────
  // Another person enrols over HTTP — the drive stands in for them — and the
  // seeded owner, a sysadmin, resets it from /hub/users/. auth's
  // account-recovery grades both by basecamp's `recoveryLevel`.
  console.log('\n  /hub/users/ — resetting somebody else\'s second factor')
  const API = `http://localhost:${API_PORT}`
  const eventually = async (read, pred) => {
    for (let i = 0; i < 40; i++) { const v = await read(); if (pred(v)) return v; await sleep(250) }
    return read()
  }
  const KIM = 'kim@example.com'
  const asKim = async (method, body, token) => (await fetch(`${API}/account/me`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', accept: 'application/json',
               authorization: `Bearer ${token}`, 'x-service-method': method },
  })).json()
  const kimLogin = async () => (await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email: KIM, password: PASSWORD }),
  })).json()

  const kimToken = (await kimLogin()).token
  const { secret: kimSecret } = await asKim('setupTotp', { currentPassword: PASSWORD }, kimToken)
  await asKim('confirmTotp', { code: totp(kimSecret, new Date()) }, kimToken)
  check('the other person has two-step sign-in on', (await asKim('totpStatus', {}, kimToken))?.enabled === true)
  check('so a password alone no longer signs them in', !(await kimLogin()).token)

  await goto('/hub/users/')
  await until(`!!document.querySelector('[aria-label^="Reset two-step sign-in for "]')`, v => v,
    'the hub offers no Reset 2FA')
  const kimLabel = await evaluate(`[...document.querySelectorAll('[aria-label^="Reset two-step sign-in for "]')]
    .map(b => b.getAttribute('aria-label')).find(l => /kim/i.test(l)) ?? ''`)
  check('it is offered on a person who is not an administrator', !!kimLabel)
  check('and not on an administrator', !(await evaluate(`[...document.querySelectorAll('#hub-user-rows tr')]
    .some(tr => /sysadmin/.test(tr.textContent) && tr.querySelector('[aria-label^="Reset two-step sign-in"]'))`)))
  await byLabel(kimLabel)
  await confirmIt()
  const signedIn = await eventually(async () => (await kimLogin()).token, t => !!t)
  check('after the reset, their password alone signs them in', !!signedIn,
    await text('#screen-error'))

  // ─── DNS, networks, dashboards, backups, blueprints ─────────────────────
  console.log('\n  dns, networks, dashboards, backups and blueprints')
  const apiCall = (method, path, payload, serviceMethod) => evaluate(`
    fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: {
      'content-type': 'application/json', accept: 'application/json',
      authorization: 'Bearer ' + localStorage.getItem('basecamp_token'),
      'x-workspace-id': localStorage.getItem('basecamp_workspace'),
      ${serviceMethod ? `'x-service-method': ${JSON.stringify(serviceMethod)},` : ''}
    }, ${payload ? `body: JSON.stringify(${JSON.stringify(payload)}),` : ''} })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`)

  // DNS — edit a hostname, and the certificate action lands on the one form.
  // Its own hostname: the app an earlier section gave one to has since been
  // deleted, and its domains with it.
  const dnsApp = (await apiGet('/apps')).body?.data?.[0]
  const dnsRow = (await apiPost('/domains', { appId: dnsApp?.id, hostname: 'dns-drive.example.test', isPrimary: false })).body
  await goto('/dns/')
  await until(`!!document.querySelector('[aria-label="Edit dns-drive.example.test"]')`, v => v, 'the DNS row offers no edit')
  await byLabel('Edit dns-drive.example.test')
  await until(`!!document.querySelector('#domain-edit-save')`, v => v, 'the domain drawer never opened')
  check('the domain drawer does not offer the certificate columns', !(await present('dialog[open] [name=certExpiresAt]')))
  await typeIn('dialog[open] [name=port]', '8443')
  await click('#domain-edit-save')
  const domEdited = await eventually(async () => (await apiGet(`/domains/${dnsRow?.id}`)).body, d => d?.port === 8443)
  check('a hostname is edited from DNS', domEdited?.port === 8443, JSON.stringify(domEdited?.port))
  await goto('/dns/')
  await until(`!!document.querySelector('[aria-label="Upload a certificate for dns-drive.example.test"]')`, v => v,
    'a hostname with no certificate offers none')
  await byLabel('Upload a certificate for dns-drive.example.test')
  await until(`!!document.getElementById('certPem')`, v => v, 'the certificate link never opened the upload form')
  check('and its certificate action opens the app\'s upload form for that hostname',
    (await evaluate(`location.pathname`)) === `/apps/${dnsRow?.appId}/`)

  // Networks — edit, and an address given on attach.
  const net = (await apiGet('/networks')).body?.data?.[0]
  await goto('/networks/')
  await until(`!!document.querySelector('[aria-label="Edit ${net?.name}"]')`, v => v, 'the network offers no edit')
  await byLabel(`Edit ${net?.name}`)
  await until(`!!document.querySelector('#network-edit-save')`, v => v, 'the network drawer never opened')
  check('the network drawer does not offer the slug', !(await present('dialog[open] [name=slug]')))
  await typeIn('dialog[open] [name=cidr]', '10.9.0.0/16')
  await click('#network-edit-save')
  const netEdited = await eventually(async () => (await apiGet(`/networks/${net?.id}`)).body, n => n?.cidr === '10.9.0.0/16')
  check('a network is edited', netEdited?.cidr === '10.9.0.0/16', JSON.stringify(netEdited?.cidr))
  // The save reloads the list, which is a moment with no list in it.
  await until(`[...document.querySelectorAll('#network-list button')].some(b => b.textContent.trim() === 'Attach a server')`,
    v => v, 'the network list never came back after the save')
  await clickText(`#network-list .card:has([aria-label="Edit ${net?.name}"])`, 'Attach a server')
  await until(`document.querySelectorAll('#attach-${net?.id} option').length`, n => n > 1, 'no server to attach')
  const attachSrv = await evaluate(`[...document.querySelectorAll('#attach-${net?.id} option')].find(o => o.value).value`)
  await pickIn(`#attach-${net?.id}`, attachSrv)
  await typeIn(`#attach-ip-${net?.id}`, '10.9.0.5')
  // Only the card in attach mode has an Attach button, and it has no Edit.
  await clickText('#network-list', 'Attach')
  await until(`document.getElementById('network-list').textContent`, t => t.includes('10.9.0.5'),
    'the address given on attach never showed')
  ok('a server attached with an address shows it')

  // Dashboards — a widget whose server is gone is re-pointed; rename, pin, delete.
  const board = (await apiPost('/dashboards', { name: 'Drive board' })).body
  const fleetNow = (await apiGet('/servers')).body?.data ?? []
  const doomed = fleetNow.find(x => x.status !== 'online')
  const keeper = fleetNow.find(x => x.id !== doomed?.id)
  await apiCall('POST', `/dashboards/${board?.id}`, { kind: 'server_health', serverId: doomed?.id, cols: 1 }, 'addWidget')
  const gone = await apiCall('DELETE', `/servers/${doomed?.id}`)
  check('the widget\'s server is removed', gone.status < 300, `${gone.status}`)
  await goto(`/dashboards/${board?.id}/`)
  const wid = await until(`document.querySelector('[data-repoint]')?.dataset.repoint`, v => v,
    'a widget whose server is gone offers no re-point')
  await until(`document.querySelectorAll('#repoint-${wid} option').length`, n => n > 1, 'the re-point list never filled')
  await pickIn(`#repoint-${wid}`, keeper?.id)
  await clickText(`[data-repoint="${wid}"]`, 'Re-point')
  const repointed = await eventually(async () => (await apiGet(`/dashboards/${board?.id}`)).body,
    b => b?.widgets?.[0]?.serverId === keeper?.id)
  check('an orphaned widget is re-pointed at another server', repointed?.widgets?.[0]?.serverId === keeper?.id)

  await click('#rename-board')
  await until(`!!document.querySelector('#board-save')`, v => v, 'the rename drawer never opened')
  await typeIn('dialog[open] [name=name]', 'Drive board renamed')
  await click('#board-save')
  const renamedBoard = await eventually(async () => (await apiGet(`/dashboards/${board?.id}`)).body,
    b => b?.name === 'Drive board renamed')
  check('a dashboard is renamed from its own screen', renamedBoard?.name === 'Drive board renamed')
  await click('#pin-board')
  const pinnedRow = await eventually(async () => (await apiGet(`/dashboards/${board?.id}`)).body, b => b?.isPinned === true)
  check('Pin is stored', pinnedRow?.isPinned === true, await text('#screen-error'))
  await goto('/')
  const pinnedStrip = await until(`document.getElementById('pinned-dashboards')?.textContent ?? ''`,
    t => t.includes('Drive board renamed'), 'a pinned board never reached the home screen').catch(e => e.message)
  check('pinning puts the board on the home screen', String(pinnedStrip).includes('Drive board renamed'))
  await goto(`/dashboards/${board?.id}/`)
  await until(`!!document.getElementById('delete-board')`, v => v, 'the board never rendered')
  await click('#delete-board')
  await confirmIt()
  await until(`location.pathname`, p => p === '/dashboards/', 'deleting a board never left it')
  check('a dashboard is deleted from its own screen', (await apiGet(`/dashboards/${board?.id}`)).status === 404)

  // Backups — forgetting drops the row and says the file stays.
  await goto('/hub/backups/')
  await until(`!!document.querySelector('[aria-label^="Forget "]')`, v => v, 'no settled backup offers Forget')
  const kept = await evaluate(`document.querySelectorAll('#backup-history tbody tr').length`)
  await evaluate(`document.querySelector('[aria-label^="Forget "]').click()`)
  const warned = await until(`document.querySelector('[role=dialog][aria-modal=false]')?.textContent ?? ''`, t => t,
    'forgetting asked nothing')
  check('forgetting a backup says the archive stays on disk', /stays on disk|from this list/.test(warned), warned.slice(0, 120))
  await evaluate(`document.querySelector('[role=dialog][aria-modal=false] .cluster button:last-child').click()`)
  const left = await until(`document.querySelectorAll('#backup-history tbody tr').length`, n => n < kept,
    'the forgotten backup stayed listed').catch(() => kept)
  check('and it leaves the list', left < kept, `${kept} → ${left}`)

  // Blueprints — a sysadmin adds one, gives it ordered parameters, and edits it.
  await goto('/blueprints/')
  await until(`!!document.getElementById('new-blueprint')`, v => v, 'a sysadmin is not offered New blueprint')
  await click('#new-blueprint')
  await until(`!!document.querySelector('#blueprint-save')`, v => v, 'the blueprint drawer never opened')
  for (const [k, v] of Object.entries({ slug: 'drive-app', name: 'Drive app', category: 'Testing',
                                          description: 'Made by the drive', version: '1.0', image: 'nginx:alpine' }))
    await typeIn(`dialog[open] [name=${k}]`, v)
  await click('#blueprint-save')
  const bp = await eventually(async () => (await apiGet('/blueprints')).body?.data?.find(b => b.slug === 'drive-app'), b => !!b)
  check('a blueprint is added to the catalog', !!bp,
    await evaluate(`document.querySelector('dialog[open]')?.textContent.replace(/\\s+/g, ' ').slice(0, 300) ?? ''`))
  await until(`!!document.getElementById('blueprint-params-edit')`, v => v, 'the new blueprint never opened its details')
  await click('#blueprint-params-edit')
  await click('#param-add'); await click('#param-add')
  await typeIn('#param-key-0', 'API_TOKEN'); await typeIn('#param-label-0', 'API token')
  await evaluate(`document.querySelector('#param-secret-0')?.click()`)
  await pickIn('#param-generate-0', 'random_hex_32')
  await typeIn('#param-key-1', 'PORT'); await typeIn('#param-label-1', 'Port'); await typeIn('#param-default-1', '8080')
  await byLabel('Move parameter 2 up')
  await click('#params-save')
  const withParams = await eventually(async () => (await apiGet(`/blueprints/${bp?.id}`)).body, b => b?.params?.length === 2)
  check('its parameters are saved in the order arranged',
    withParams?.params?.map(p => p.key).join() === 'PORT,API_TOKEN', withParams?.params?.map(p => p.key).join())
  check('with the secret flag and the generator', withParams?.params?.[1]?.secret === true
    && withParams?.params?.[1]?.generate === 'random_hex_32', JSON.stringify(withParams?.params?.[1]))
  await click('#blueprint-edit')
  await until(`!!document.querySelector('dialog[open] [name=description]')`, v => v, 'the blueprint edit never opened')
  check('the edit does not offer the slug', !(await present('dialog[open] [name=slug]')))
  await typeIn('dialog[open] [name=description]', 'Edited by the drive')
  await click('#blueprint-save')
  const bpEdited = await eventually(async () => (await apiGet(`/blueprints/${bp?.id}`)).body, b => b?.description === 'Edited by the drive')
  check('a blueprint is edited', bpEdited?.description === 'Edited by the drive',
    await evaluate(`(() => { const d = document.querySelector('dialog[open]')
      if (!d) return 'drawer closed'
      const why = [...d.querySelectorAll('.alert, [role=alert], .field-error, [aria-invalid=true]')]
        .map(e => e.id || e.getAttribute('name') || e.textContent.trim()).join(' | ')
      return why || d.textContent.replace(/\\s+/g, ' ').slice(0, 200) })()`))

  // ─── Home, the palette's New entries, a release's own screen ───────────
  console.log('\n  home, ⌘K\'s New entries, the deployment screen')

  await goto('/')
  await until(`document.querySelectorAll('#project-rows a').length`, n => n > 0,
    'home never listed its projects as links')
  const home = (await body()).replace(/\s+/g, ' ')
  check('home carries no build-phase or header-debug text',
    !/Phase [0-9]|X-Workspace-Id/.test(home), home.match(/.{40}(Phase [0-9]|X-Workspace-Id).{40}/)?.[0])
  check('and each project row opens its project', await evaluate(
    `[...document.querySelectorAll('#project-rows a')].every(a => /^\\/projects\\/[^/]+\\/$/.test(a.getAttribute('href')))`))

  // ?new is what the palette's New entries go to: from another route, a full
  // load, and on the same route, which the router answers without remounting.
  await goto('/networks/?new=1')
  await until(`document.getElementById('new-network')?.textContent.trim()`, t => t === 'Cancel',
    '/networks/?new never opened the create form')
  ok('?new opens a list screen with its create form open')
  await goto('/jobs/')
  await until(`!!document.getElementById('job-new')`, v => v, 'the jobs screen never rendered')
  check('and the same screen without it does not', !(await present('dialog[open] [name=name]')))
  await evaluate(`(() => {
    const a = document.createElement('a'); a.href = '/jobs/?new=1'; a.id = 'drive-new'
    document.body.appendChild(a); a.click(); a.remove()
  })()`)
  await until(`!!document.querySelector('dialog[open] [name=name]')`, v => v,
    '?new on the route already open did not open the drawer')
  ok('?new reached by the router on the open route opens it too')

  const releases = (await apiGet('/deployments?$limit=50')).body?.data ?? []
  // An app deleted by a section above leaves its releases with no app to link.
  const release  = releases.find(d => d.app && d.previousDeploymentId) ?? releases.find(d => d.app)
  check('the seed has a release to open', !!release)
  await goto(`/deployments/${release?.id}/`)
  await until(`!!document.getElementById('deploy-breadcrumb')`, v => v, 'the deployment screen never rendered')
  check('a release links its app from the breadcrumb', await evaluate(
    `!!document.querySelector('#deploy-breadcrumb a[href="/apps/${release?.appId}/"]')`))
  const facts = (await text('.facts'))?.replace(/\s+/g, ' ') ?? ''
  check('and states branch, author and when it was queued',
    /Branch/.test(facts) && /Author/.test(facts) && /Queued/.test(facts), facts.slice(0, 160))
  check('and links the release it replaced', !release?.previousDeploymentId || await evaluate(
    `!!document.querySelector('#deploy-previous a[href="/deployments/${release?.previousDeploymentId}/"]')`))

  // The seed's statuses are drawn at random, so a release is STOPPED here
  // rather than hoped for: one in flight, cancelled from its own screen.
  const inFlight = releases.find(d => d.app && (d.status === 'building' || d.status === 'pending'))
  check('the seed has a release in flight to stop', !!inFlight,
    JSON.stringify(releases.reduce((n, d) => ({ ...n, [d.status]: (n[d.status] ?? 0) + 1 }), {})))
  if (inFlight) {
    await goto(`/deployments/${inFlight.id}/`)
    await until(`!!document.getElementById('deploy-status')`, v => v, 'the in-flight release never rendered')
    check('a release in flight does not offer Deploy again', !(await present('#deploy-again')))
    await clickText('.section-header', 'Cancel')
    await confirmIt()
    await until(`document.getElementById('deploy-status')?.textContent.trim()`, t => t === 'cancelled',
      'cancelling from the screen never landed')
    await until(`!!document.getElementById('deploy-again')`, v => v, 'a cancelled release offered no Deploy again')
    ok('once cancelled, it offers Deploy again')
    await click('#deploy-again')
    // Either a new release to watch, or the service's sentence on this screen;
    // a press that does neither is the silent failure.
    const answered = await until(`location.pathname !== '/deployments/${inFlight.id}/' ? 'moved'
      : document.querySelector('.alert.danger')?.textContent.trim() || ''`, v => !!v,
      'Deploy again neither moved nor said why')
    check('and pressing it ships or says why not', !!answered, answered)
  }
  await goto('/settings/')
  await until(`!!document.getElementById('notification-delivery')`, v => v, 'settings never rendered')
  check('settings no longer says nothing delivers',
    !/nothing delivers/.test(await text('#settings-notifications')))
  check('and points at where in-app notifications land',
    await present('#settings-notifications a[href="/notifications/"]'))

  // ─── What runs on a machine, what shipped to an environment ────────────
  console.log('\n  a server\'s apps, an environment\'s releases')
  const allApps = (await apiGet('/apps?$limit=100')).body?.data ?? []
  let host = null, hosted = []
  for (const srv of (await apiGet('/servers?$limit=100')).body?.data ?? []) {
    hosted = (await apiGet(`/apps?serverId=${srv.id}`)).body?.data ?? []
    if (hosted.length) { host = srv; break }
  }
  check('the seed places an app on a machine', !!host)
  check('and ?serverId= narrows the list rather than answering every app',
    hosted.length > 0 && hosted.length < allApps.length, `${hosted.length} of ${allApps.length}`)
  if (host) {
    await goto(`/servers/${host.id}/`)
    const shown = await until(`[...document.querySelectorAll('#server-apps a')].map(a => a.getAttribute('href')).sort().join()`,
      v => !!v, 'the server screen never listed its apps')
    check('the server screen lists exactly the apps placed on it',
      shown === hosted.map(x => `/apps/${x.id}/`).sort().join(), shown)
  }

  const shipped = ((await apiGet('/deployments?$limit=100')).body?.data ?? []).find(d => d.environmentId)
  check('the seed has a release that names its environment', !!shipped)
  if (shipped) {
    const here    = (await apiGet(`/deployments?environmentId=${shipped.environmentId}&$limit=10`)).body?.data ?? []
    check('?environmentId= answers only that environment\'s releases',
      here.length > 0 && here.every(d => d.environmentId === shipped.environmentId))
    await goto(`/environments/${shipped.environmentId}/`)
    const rows = await until(`[...document.querySelectorAll('#env-releases a[href^="/deployments/"]')].map(a => a.getAttribute('href')).join()`,
      v => !!v, 'the environment screen never listed its releases')
    check('the environment screen lists its releases, newest first',
      rows === here.map(d => `/deployments/${d.id}/`).join(), rows)
  }

  // ─── The inbox ─────────────────────────────────────────────────────────
  console.log('\n  the bell and /notifications/')
  const inbox = await notificationFixture('inbox')
  const [failedDeploy, failedJob, resolved] = inbox

  // A full load: the fixture wrote underneath an open page, and a row nobody
  // pushed reaches the store on the next read.
  await goto('/')
  const unreadAtFirst = await until(`Number(document.getElementById('bell-count')?.textContent.trim() ?? 0)`,
    n => n >= 2, 'the bell never counted the two unread')
  ok(`the bell counts what is unread (${unreadAtFirst})`)
  check('and its name says so to a screen reader',
    /unread/.test(await evaluate(`document.getElementById('bell').getAttribute('aria-label')`)))

  await click('#bell')
  const menu = await until(`[...document.querySelectorAll('[role=menuitem]')].map(b => b.textContent.trim()).join(' | ')`,
    t => t.includes(failedDeploy.title), 'the bell menu never listed the unread notification')
  check('the menu lists the unread and not the read one',
    menu.includes(failedJob.title) && !menu.includes(resolved.title), menu.slice(0, 200))
  await evaluate(`[...document.querySelectorAll('[role=menuitem]')]
    .find(b => b.textContent.includes(${JSON.stringify(failedDeploy.title)})).click()`)
  await until(`location.pathname`, p => p === failedDeploy.url, 'opening a notification never went to its action')
  ok('opening one goes where it points')
  await until(`Number(document.getElementById('bell-count')?.textContent.trim() ?? 0)`,
    n => n === unreadAtFirst - 1, 'the bell never counted the opened one as read')
  ok('and marks it read — the bell counts one fewer')

  await goto('/notifications/')
  await until(`!!document.getElementById('notifications-rows')`, v => v, '/notifications/ never listed anything')
  const unreadRows = await body()
  check('the screen opens on Unread, without the one just read or the read one',
    unreadRows.includes(failedJob.title) && !unreadRows.includes(failedDeploy.title) && !unreadRows.includes(resolved.title))
  await clickText('#notifications-filter', 'All')
  await until(`document.getElementById('notifications-rows')?.textContent ?? ''`,
    t => t.includes(resolved.title) && t.includes(failedDeploy.title), 'All never showed the read ones')
  ok('All shows the read ones too')

  await click('#notifications-read-all')
  await until(`!document.getElementById('bell-count')`, v => v, 'Mark all read left the bell counting')
  ok('Mark all read empties the bell')
  const inboxAfter = (await apiGet('/notifications?$limit=50')).body?.data ?? []
  check('and the server agrees — nothing of this fixture is unread',
    inbox.every(n => inboxAfter.find(r => r.id === n.id)?.readAt), JSON.stringify(inboxAfter.map(r => [r.data?.title, r.readAt])).slice(0, 200))

  // ─── Undo, and the trash ───────────────────────────────────────────────
  // Two doors to one verb: the toast a delete ends with, and /trash/ with no
  // clock on it. Every press is read back through the API, because a toast
  // saying *restored* over a refused restore looks exactly like a pass.
  console.log('\n  Undo, and /trash/')
  const binPrj = (await apiPost('/projects', { name: 'Drive trash', slug: 'drive-trash' })).body
  const binEnv = (await apiPost('/environments', { projectId: binPrj?.id, name: 'Drive env', slug: 'drive-env' })).body
  check('a project with an environment in it, to delete', !!binPrj?.id && !!binEnv?.id, JSON.stringify(binEnv)?.slice(0, 160))

  const deleteProject = async () => {
    await goto(`/projects/${binPrj.id}/`)
    await until(`document.querySelector('h1')?.textContent ?? ''`, t => t === 'Drive trash', 'the project never rendered')
    await clickText('.section-header', 'Delete')
    await confirmIt()
    await until(`location.pathname`, p => p === '/projects/', 'deleting the project never left it')
  }
  const undoButton = `[...document.querySelectorAll('.toast-stack .toast')]
    .find(t => t.textContent.includes('Drive trash deleted'))?.querySelector('button:not([aria-label])')`

  await deleteProject()
  check('the delete took', (await apiGet(`/projects/${binPrj.id}`)).status === 404)
  const undoLabel = await until(`${undoButton}?.textContent.trim() ?? ''`, t => t, 'the delete offered no Undo')
  check('the toast a delete ends with offers Undo', undoLabel === 'Undo', undoLabel)
  await evaluate(`${undoButton}.click()`)
  const undone = await eventually(async () => (await apiGet(`/projects/${binPrj.id}`)).status, s => s === 200)
  check('pressing Undo brings the project back', undone === 200, `GET answered ${undone}`)
  check('and its environment with it', (await apiGet(`/environments/${binEnv.id}`)).status === 200)
  const backInList = await until(`document.body.textContent.includes('Drive trash')`, v => v,
    'the restored project never reappeared on the list').catch(() => false)
  check('the list it was deleted from shows it again, with no reload', backInList)

  await deleteProject()
  await goto('/trash/')
  const binRow = `document.querySelector('#trash-rows tr[data-trash-id="projects:${binPrj.id}"]')`
  const rowText = await until(`${binRow}?.textContent.replace(/\\s+/g, ' ') ?? ''`, t => t, 'the project never reached /trash/')
  check('/trash/ lists the deleted project', rowText.includes('Drive trash'), rowText.slice(0, 160))
  check('as one row that says what went with it', rowText.includes('with 1 environment'), rowText.slice(0, 160))
  check('and not its environment as a second row, which could not be restored alone',
    !(await evaluate(`!!document.querySelector('#trash-rows tr[data-trash-id="environments:${binEnv.id}"]')`)))
  await evaluate(`[...${binRow}.querySelectorAll('button')].find(b => b.textContent.trim() === 'Restore').click()`)
  const restored = await eventually(async () => (await apiGet(`/projects/${binPrj.id}`)).status, s => s === 200)
  check('Restore on /trash/ brings it back', restored === 200, `GET answered ${restored}`)
  const leftBin = await until(`!${binRow}`, v => v, 'the restored row stayed on /trash/').catch(() => false)
  check('and it leaves the trash', leftBin)
  check('the trash answers what the screen showed', !((await apiGet('/trash')).body?.data ?? []).some(i => i.ref === binPrj.id))

  // FAILED. The API is stopped under a page that is already signed in, and the
  // next screen is reached by CLICKING — a client-side navigation, so the
  // session stays in memory and the only thing that fails is this screen's own
  // read. That is the shape of the flake that filed this. A full page load
  // instead exercises a different path entirely, asserted below.
  //
  // `detached: true` means the child leads its own process GROUP and
  // `bun api/index.ts` spawns under it, so killing the pid alone leaves the app
  // holding the port and the read is answered by a process that never went away
  // (`FJS-740`, one layer along). The negative pid is the group.
  try { process.kill(-api.pid, 'SIGTERM') } catch { try { api.kill('SIGTERM') } catch {} }
  // Probed from node against the API's own port. Asked through the page it goes
  // via vite's proxy, which answers 500 rather than refusing the connection — a
  // resolved fetch, so *is it down* would read as *it is up*.
  {
    const deadline = Date.now() + 10_000
    let down = false
    while (Date.now() < deadline && !down) {
      try { await fetch(`http://localhost:${API_PORT}/health`, { signal: AbortSignal.timeout(500) }) }
      catch { down = true }
      if (!down) await sleep(250)
    }
    check('the API really stopped, so the next read cannot be answered', down)
  }

  // The SAME URL as the *gone* rows above, which is the sharpest pair this
  // drive can make: one address, two reasons for having no record, two
  // sentences. It has to be a record nothing has read — a node already in the
  // client's store answers from memory with the API down, which is correct and
  // would have made this row green against the bug. The link is injected and
  // clicked so the router handles it: `Page.navigate` is a full load, and a
  // full load with no API cannot restore a session at all (asserted below).
  await evaluate(`(() => {
    const a = document.createElement('a')
    a.href = '/apps/00000000-0000-4000-8000-0000000000ff/'
    a.id = 'drive-nav'
    document.body.appendChild(a)
    a.click()
  })()`)
  await until(`location.pathname.startsWith('/apps/') && document.querySelector('h1')?.textContent || ''`,
    t => t && t !== 'Loading…', 'a failed load rendered no heading')
  const failHeading = (await text('h1')).trim()
  check('a load that FAILED does not say the record was deleted',
    failHeading !== 'App not found', failHeading)
  check('it says it could not load, in a heading a screen reader lands on',
    failHeading === 'Could not load this app', failHeading)
  check('and it offers a retry, which is the whole difference from gone',
    (await body()).includes('Try again'))

  // The other path, and it is this app's own decision rather than the
  // component's: a FULL load with the API down cannot restore a session, so the
  // guard sends the caller to /login/ — `src/session.js` says so and says why.
  // Asserted because that decision is only sound if the login screen then
  // states the reason; a redirect that drops it is the same lost sentence one
  // layer up.
  await goto(`/apps/${realId}/`)
  await until(`document.body.textContent.length`, n => n > 0, 'the login screen never rendered')
  const landed = await evaluate(`location.pathname`)
  check('a full load with no API lands on sign-in rather than a broken screen',
    landed.includes('/login'), landed)
  check('and the login screen says why it sent them there',
    await evaluate(`!!document.getElementById('session-error')`),
    (await body()).replace(/\s+/g, ' ').slice(0, 160))

  // ─── The console ───────────────────────────────────────────────────────
  console.log('\n  the console')
  check('no console errors or warnings across every screen',
    consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

} catch (e) {
  bad('the run stopped', e.message)
}

console.log(`\n${failed ? '✗' : '✓'} ${passed}/${passed + failed} checks passed\n`)
await cleanup()
await rm(SCRATCH,  { recursive: true, force: true })
await rm(PROFILE,  { recursive: true, force: true })
process.exit(failed ? 1 : 0)
