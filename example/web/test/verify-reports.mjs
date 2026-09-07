/*
 * verify-reports.mjs — a REPORT, and the gate that decides who reads one.
 *
 * `FJS-D228` phase 2. The first report surface in this app is a declared `view`
 * rendered on a screen — no new noun was minted for it, because a projection the
 * schema already declares is what a report IS.
 *
 * **What only a browser can ask here** is the thing the HTTP tier cannot: that a
 * caller who may not read the projection is TOLD SO, rather than shown an empty
 * table. An empty grid and a gate saying no look identical on screen and only one
 * of them is something a reader can act on — the lesson basecamp's screens drive
 * paid for once already.
 *
 * The ladder is the substance and it is an INVERSION: `revenueByStatus` reads at
 * 5, `Order` reads at 1. So staff who can open every order on /orders/ cannot
 * read the total of them here, and that pair is asserted rather than assumed —
 * a screen that refused everybody would satisfy any test that only checked the
 * refusal.
 *
 *   bun run verify:reports
 *
 * Starts and stops its own API and its own web server. Needs Chrome on PATH or
 * $FJS_CHROME. Signs in twice, which is inside the login limiter's budget.
 *
 * Harness rules, repeated from verify-payroll.mjs: never return a bare `null`
 * from a probe (CDP omits `value`, so it reads back as `undefined`), and never
 * start an evaluated expression with `return` on its own line.
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE   = dirname(fileURLToPath(import.meta.url))
const ROOT   = join(HERE, '../..')
const UI     = process.env.UI_URL  ?? 'http://localhost:8010'
const API    = process.env.API_URL ?? 'http://localhost:8110'
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

// ─── servers ──────────────────────────────────────────────────────────────
//
// This drive starts and stops both. **A dev server serves the code it STARTED
// with**, and the failure that costs here is specific: an API booted before
// `revenue.service.ts` landed answers `Service 'revenue' not found` — a 404 that
// reads exactly like the gate refusing, which is the one thing this drive is
// about. The manifest probe below is what separates them.

const procs = []
function start(cmd, args, name) {
  // `detached`, so stopAll can signal the GROUP — `npx vite` is a launcher and
  // SIGTERM to the handle here leaves vite itself holding the port.
  const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stdout.on('data', () => {})
  p.stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(`[${name}] ${d}`) })
  procs.push(p)
  return p
}
const stopAll = () => {
  for (const p of procs) {
    try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGTERM') } catch {} }
  }
}
process.on('exit', stopAll)
process.on('SIGINT', () => { stopAll(); process.exit(130) })

for (const [port, what] of [[8110, 'the API'], [8010, 'the dev server']]) {
  let busy = false
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) {
    console.error(`port ${port} already answers — ${what} is still running from an earlier run.\n` +
                  `stop it first (\`bun run stop\`); this drive starts its own.`)
    process.exit(1)
  }
}

// Idempotent, and a step rather than a boot side effect: against an empty
// database every assertion here fails as *the row is not there*.
execFileSync('bun', ['run', 'db/seed.ts'], { cwd: ROOT, stdio: 'ignore' })

start('bun', ['run', 'api/index.ts'], 'api')
start('npx', ['vite', '-c', 'web/config/vite.config.js'], 'web')

async function waitForServer(url, label, tries = 160) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  console.error(`${label} never answered on ${url}`)
  return false
}

if (!await waitForServer(`${API}/api/health`, 'api')) { stopAll(); process.exit(1) }
if (!await waitForServer(UI, 'web'))                 { stopAll(); process.exit(1) }

// Health is not enough, and the gap is this drive's own finding. `/health`
// answers as soon as the process is listening; what every screen here needs is
// the SERVICE, and an API booted before these services landed answers
// `Service 'employees' not found` — a 404 that reads exactly like a screen
// asking for a row that does not exist. `/api/employees` cannot be the probe
// either: `Employee` is `@@gate("5.5.5.5")`, so an unauthenticated GET is a
// 401, which is a working service refusing a stranger. `/manifest` is the one
// answer to *what is mounted* that needs no session.
const mounted = await (await fetch(`${API}/api/manifest`)).json()
const names   = (mounted.services ?? []).map(s => s.name)
for (const want of ['revenue', 'orders']) {
  if (!names.includes(want)) {
    console.error(`the API is up and does not serve '${want}' — it booted from an older tree.`)
    stopAll(); process.exit(1)
  }
}

// ─── CDP ──────────────────────────────────────────────────────────────────

const profile = mkdtempSync(join(tmpdir(), 'fjs-payroll-'))
const chrome  = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })

chrome.on('error', (e) => { console.error(`Could not launch ${CHROME}: ${e.message}`); process.exit(1) })

const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''
  const t = setTimeout(() => reject(new Error('Chrome never announced a DevTools port')), 15000)
  chrome.stderr.on('data', (d) => {
    buf += d
    const m = buf.match(/ws:\/\/[^\s]+/)
    if (m) { clearTimeout(t); resolve(m[0]) }
  })
})

const browser = new WebSocket(wsUrl)
await new Promise((r) => browser.addEventListener('open', r, { once: true }))

let nextId = 1
const pending = new Map()
const noise   = []

function send(method, params = {}, sessionId) {
  const id = nextId++
  browser.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => pending.has(id) && reject(new Error(`${method} timed out`)), 60000)
  })
}

browser.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown')
    noise.push('exception: ' + (msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text))
  if (msg.method === 'Runtime.consoleAPICalled' && ['error'].includes(msg.params.type))
    noise.push(msg.params.type + ': ' + msg.params.args.map(a => a.value ?? a.description ?? '').join(' '))
})

// The reporter. `results` rather than payroll's deferred `got` map, because
// every assertion here has its expectation in hand at the point it is made.
const results = []
const t = (name, actual, expected) => results.push({ name, actual, expected })
const consoleErrors = noise

const { targetId }  = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true, returnByValue: true,
  }, sessionId)
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

/** Navigate and wait for the shell — the SPA boots once and routes after. */
async function go(path) {
  await evaluate(`window.__nav = ${JSON.stringify(path)}; location.href = ${JSON.stringify(UI + path)}`)
    .catch(() => {})
  await send('Page.navigate', { url: UI + path }, sessionId)
  await evaluate(`
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if (document.querySelector('#app .shell')) return true;
      await new Promise(r => setTimeout(r, 40));
    }
    throw new Error('the app never mounted at ${path}');
  `)
}

/** Wait for a selector to appear, answering whether it did. */
const waitFor = (sel, ms = 12000) => evaluate(`
  const t0 = Date.now();
  while (Date.now() - t0 < ${ms}) {
    if (document.querySelector(${JSON.stringify(sel)})) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
`)


// ─── the administrator ────────────────────────────────────────────────────

await go('/')
await evaluate(`
  const { signIn } = await import('/src/session.js');
  await signIn('alex@shop.test', 'correct-horse-battery');
`)
await go('/')

t('nav.reportsIsOfferedAtLevelFive', await waitFor('#nav-reports', 5000), true)

await go('/reports/')
t('screen.theTableRenders', await waitFor('[data-status]'), true)
// Every number on the page comes out of the view's own SUM(), so these are read
// back and compared to what the API answers rather than to a literal — a
// hard-coded total is a fixture that goes stale the day the seed changes.
const onScreen = await evaluate(`
  const rows = [...document.querySelectorAll('[data-status]')].map(tr => ({
    status: tr.getAttribute('data-status'),
    orders: Number(tr.querySelector('[data-orders]').textContent.trim()),
  }));
  return { rows, stats: document.querySelectorAll('#rp-stats .tile').length };
`)

const served = await (await fetch(`${API}/api/revenue`, {
  headers: { authorization: `Bearer ${await (async () => {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alex@shop.test', password: 'correct-horse-battery' }),
    })
    return (await res.json()).token
  })()}` },
})).json()

t('screen.rendersEveryRowTheProjectionAnswers',
  onScreen.rows.length, served.data.length)
t('screen.andTheCountsAreTheProjectionsOwn',
  onScreen.rows.map(r => [r.status, r.orders]).sort(),
  served.data.map(r => [r.status, r.orders]).sort())
t('screen.theSummaryTilesRender', onScreen.stats, 2)

// Nothing on this page is summed by this page. The view keeps the answer, so a
// total that disagreed with its own rows would mean the screen re-derived it.
t('screen.theBankedTileIsTheSumOfTheRowsShown', await evaluate(`
  const rows  = [...document.querySelectorAll('[data-total]')];
  const cells = rows.map(td => Number(td.textContent.replace(/[^0-9.-]/g, '')));
  const tile  = document.querySelector('#rp-stats');
  const shown = Number((tile.textContent.match(/[0-9][0-9,.]*/) || ['0'])[0].replace(/,/g, ''));
  const sum   = cells.reduce((a, b) => a + b, 0);
  return Math.abs(sum - shown) < 0.02;
`), true)

// ─── the inversion ────────────────────────────────────────────────────────
//
// The pair that carries the whole screen. `sam` is staff: every order on
// /orders/ is theirs to read, and the SUM of them is not.

await evaluate(`
  const { signOut, signIn } = await import('/src/session.js');
  await signOut();
  await signIn('sam@shop.test', 'correct-horse-battery');
`)
await go('/orders/')

// The orders table draws plain rows, so the probe is the table itself. What
// matters is that staff SEE orders, not how a row is marked up.
t('staff.canReadEveryOrder', await evaluate(`
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    if (document.querySelectorAll('table tbody tr').length > 0) return true;
    await new Promise(r => setTimeout(r, 60));
  }
  return false;
`), true)

await go('/reports/')

t('staff.areToldTheyMayNot', await waitFor('#rp-gated', 6000), true)

// The row that pins WHY the panel above is drawn from the refusal rather than
// from the affordance. `can()` is permissive by design (Invariant 6) and a
// view's gate reaches no generated schema (`FJS-999`), so it answers yes to a
// caller the server then refuses. A screen resting on it would show this caller
// an empty table. When the schema gap closes this flips to false and the panel
// is drawn one round trip earlier — nothing else about the page changes.
t('staff.theAffordanceIsPermissiveAndTheScreenDoesNotRestOnIt', await evaluate(`
  const { session } = await import('/src/session.js');
  const { revenue } = await import('/src/resources/Revenue.mesa');
  return { level: session.level, affordance: revenue.can('read', session.level) };
`), { level: 4, affordance: true })
t('staff.andNoTableIsDrawnBesideTheRefusal',
  await evaluate(`return document.querySelectorAll('[data-status]').length`), 0)
t('staff.theRefusalNamesWhatTheyCANDo',
  await evaluate(`
    const el = document.getElementById('rp-gated');
    return Boolean(el && el.querySelector('a[href="/orders/"]'));
  `), true)

// The link is hidden too, so the refusal is the second line of defence rather
// than the first thing staff meet.
t('staff.areNotOfferedTheNavLinkAtAll',
  await evaluate(`return document.querySelectorAll('#nav-reports').length`), 0)

t('consoleErrors', consoleErrors, [])

// ─── Result ───────────────────────────────────────────────────────────────

let failed = 0
for (const { name, actual, expected } of results) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`}`)
}
console.log(failed ? `\n${failed} assertion(s) failed` : `\nall ${results.length} assertions passed`)

try { browser.close() } catch {}
stopAll()
process.exit(failed ? 1 : 0)
