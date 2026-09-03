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
// about rendering a populated catalogue. An empty grid and a broken query look
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

const HERE     = dirname(fileURLToPath(import.meta.url))
const PKG      = join(HERE, '..', '..')
const CHROME   = process.env.FJS_CHROME ?? 'google-chrome'
const API_PORT = 8120
const WEB_PORT = 8020
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

console.log('\nBasecamp — the screens\n')
console.log(`  seeding ${DB}`)

const seed = spawn('bun', ['db/seed.js'], {
  cwd: PKG, stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, DATABASE_URL: DB },
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
children.push(spawn('bun', ['api/index.ts'], {
  cwd: PKG, stdio: 'ignore', detached: true,
  env: { ...process.env, DATABASE_URL: DB, APP_URL: BASE },
}))
children.push(spawn('bun', ['run', 'web'], { cwd: PKG, stdio: 'ignore', detached: true }))

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
    env: { ...process.env, DATABASE_URL: DB },
  })
  let err = ''
  p.stderr.on('data', d => { err += d })
  const code = await new Promise(r => p.on('exit', r))
  if (code !== 0) fail(`audit-fixture.mjs exited ${code}\n${err}`)
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
  console.log('\n  /blueprints/ — the catalogue')
  await goto('/blueprints/')
  await until(`document.querySelectorAll('#blueprint-grid .card').length`, n => n > 0,
    'the catalogue never rendered a card')

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
  await until(`document.querySelectorAll('#notification-kinds > div').length`, n => n === 7,
    'the seven notification kinds never rendered')
  ok('all seven kinds render, stored merged over defaults')

  const kindsText = await text('#settings-notifications')
  // Two are seeded chosen and five have never been touched. A screen that
  // flattened the two states would show seven identical rows.
  check('chosen and default are distinguished', /chosen/.test(kindsText) && /default/.test(kindsText))
  check('and the count agrees', /2 of 7 chosen/.test(kindsText), kindsText.slice(0, 80))

  const sessionsText = await text('#settings-sessions')
  check('this session is listed and marked', /this one/.test(sessionsText ?? ''),
    (sessionsText ?? '').slice(0, 120))

  check('the profile shows the signed-in address', (await text('#settings-profile')).includes(EMAIL))
  check('MFA is absent and says so', (await body()).includes('Two-factor authentication is not built'))

  // Flip one and prove it stuck — the write goes through `save`, which fills the
  // other transport from the KIND's default rather than the column's.
  await click('#notify-member_joined-email')
  await until(`document.getElementById('settings-notifications').textContent`,
    t => /3 of 7 chosen/.test(t), 'flipping a switch never marked the kind chosen')
  ok('flipping a transport marks that kind chosen')

  await goto('/settings/')
  await until(`document.getElementById('settings-notifications')?.textContent ?? ''`,
    t => /3 of 7 chosen/.test(t), 'the choice did not survive a reload')
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
