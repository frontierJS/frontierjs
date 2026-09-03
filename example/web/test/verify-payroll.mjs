/**
 * web/test/verify-payroll.mjs — the payroll console, in a real browser.
 *
 * Started by `bun run verify:payroll`, with both servers already up:
 *
 *   bun run db:seed ; bun run api    # terminal 1
 *   bun run web                      # terminal 2
 *
 * Run under BUN, not node, and that is forced rather than stylistic: the drive
 * has to clean up after itself and the books are `@@gate("5.8.9.9")`, so
 * removing a journal it posted needs the app's own Litestone client and the one
 * hatch under the boundary (`asSystem().sql`). `verify:retro` explains it at
 * length; this is the second caller.
 *
 * ─── What only this drive can ask ─────────────────────────────────────────
 *
 * The three payroll bun drives assert the arithmetic. What none of them can see
 * is whether a PERSON can reach it, and payroll is the first thing in `example`
 * with exactly one audience — every other feature here has at least two, and a
 * gate ladder is what stands between them. So:
 *
 * **`ladder.*`** — and what it found is not what it was written to find. The
 * expectation was that `approve: … @gate(5)` would be the one place a level-4
 * caller is told apart from a level-5 one. It is not: `PayRun` is
 * `@@gate("5.5.5.5")`, so a level below may not update the row at all and is
 * offered NO move — the transition's gate is the same number as the model's and
 * adds nothing. **A per-transition gate is only visible ABOVE the model's own
 * update gate, and this application's ladder tops out at 5 for a person**, so
 * there is nowhere above to put one. The drive asserts the fact and the reason
 * separately, because from a screen they look identical.
 *
 * **`asat.*`** — the as-at read, typed into a box. The answer comes from
 * `employees.payOn` rather than from the history table on the same page, which
 * is the point: a second reading of the half-open interval written into a
 * screen is a wrong salary once per raise.
 *
 * **`correction.thePayslipSaysWhatItCorrects`** — phase 6's finding, on screen.
 * A backdated raise makes an already-paid period wrong, and the next payslip
 * carries a line badged with the run it puts right, because
 * `PayslipLine.correctsPayRunId` is the only thing in the schema that says a
 * row was derived from other rows.
 *
 * Two sign-ins, and the limiter is 10 per 15 minutes across every browser
 * drive — budgeted rather than discovered.
 *
 * Fixtures are minted per run (`FJS-530`, `FJS-546`) and swept in a `finally`.
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../../api/src/core/db.ts'
import { sweepPayroll } from './payroll-sweep.mjs'

const HERE   = dirname(fileURLToPath(import.meta.url))
const ROOT   = join(HERE, '../..')
const UI     = process.env.UI_URL  ?? 'http://localhost:8010'
const API    = process.env.API_URL ?? 'http://localhost:8110'
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

const sys = db.asSystem()
const RUN = String(Date.now()).slice(-6)

// ─── servers ──────────────────────────────────────────────────────────────
//
// This drive starts and stops both, for `verify:catalogue`'s reason and for one
// of its own. **A dev server serves the code it STARTED with**, and this domain
// is the sharpest case of that in the repository: a payroll service registered
// after the process booted is not a 500 that names itself, it is
// `Service 'employees' not found` — a 404 that reads exactly like a screen
// asking for something that does not exist. An API left running from before
// these services landed answers every payroll screen that way and the drive
// would report *the roster does not render*, which is true and is about the
// wrong thing entirely.

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
for (const want of ['employees', 'payRuns', 'payslips', 'journalEntries']) {
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

/** Type into a generated form field the way a person does. */
const fill = (name, value) => evaluate(`
  const el = document.querySelector('[name=' + ${JSON.stringify(JSON.stringify(name))} + ']');
  if (!el) throw new Error('no field named ${name}');
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, ${JSON.stringify(String(value))});
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value;
`)

/**
 * A `DateTime` column's control is `datetime-local`, and it REFUSES a date-only
 * string in silence — `el.value` comes back `''`, the field stays empty, and a
 * required column then fails validation with nothing on screen saying which
 * keystroke was ignored. Every date typed here goes through this.
 */
const stamp = (d) => new Date(d).toISOString().slice(0, 16)

/**
 * Read through the app's OWN client, in the page, rather than with `fetch`.
 *
 * Not tidiness: every model in this domain is `@@gate("5.…")`, so an
 * unauthenticated `fetch` to the API answers 401 — which from a drive looks
 * exactly like an empty table, and would have made four assertions here pass
 * for the wrong reason. In the page there is a session.
 */
const find = (mod, accessor, query = {}, directives = { limit: 500 }) => evaluate(
  'const m = await import("/src/resources/' + mod + '.mesa");\n' +
  'const r = await m.' + accessor + '.service.find(' +
    JSON.stringify(query) + ', ' + JSON.stringify(directives) + ');\n' +
  'return r?.data ?? [];')

const click = (sel) => evaluate(`
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) throw new Error('nothing at ${sel}');
  el.click();
  return true;
`)

const got = {}
const t   = (label, value) => { got[label] = value }

const fixtures = { runIds: [], employeeIds: [] }
let failedEarly = null

try {

// ─── sign in, and the way in ──────────────────────────────────────────────

await go('/')
await evaluate(`
  const { signIn } = await import('/src/session.js');
  await signIn('alex@shop.test', 'correct-horse-battery');
`)
await go('/')

t('nav.payrollIsOfferedAtLevelFive', await waitFor('#nav-payroll', 5000))

// ─── the roster ───────────────────────────────────────────────────────────

await go('/people/')
t('people.theRosterRenders', await waitFor('[data-employee]'))

// Somebody who has LEFT is shown as left rather than filtered out — the screen
// separates *employed* from *having a pay window*, which is what a payroll
// reading the terms table alone gets wrong.
t('people.aLeaverIsShownAsGone',
  await evaluate(`return !!document.querySelector('[data-status="left"]')`))
t('people.andSomebodyStillHereIsNot',
  await evaluate(`return !!document.querySelector('[data-status="here"]')`))

// The annual figure on screen is the OPEN window's, converted from the
// column's minor units — compared against the API rather than a literal.
const dana = (await find('Employee', 'employees', { reference: 'EMP-1001' }, { limit: 1 }))[0]
const danaWindow = dana &&
  (await find('PayWindow', 'payWindows', { employeeId: dana.id, effectiveTo: null }, { limit: 1 }))[0]
t('people.theOnColumnIsTheOpenWindow',
  dana ? await evaluate(`
    const tr = document.querySelector('[data-employee="${dana.id}"]');
    return tr && tr.querySelector('[data-annual]')?.getAttribute('data-annual');
  `) === String(danaWindow?.rate) : false)

// ─── a new person, through the drawer ─────────────────────────────────────

const REF = `CON-${RUN}`
await click('#p-new')
t('create.theDrawerOffersTheGeneratedForm', await waitFor('[name="reference"]'))
await fill('reference', REF)
await fill('name', 'Robin Ashworth')
await fill('email', `robin-${RUN}@shop.test`)
await fill('startedOn', stamp(Date.now() - 400 * 86_400_000))
await click('#p-save')

t('create.thePersonAppears', await waitFor(`[data-reference="${REF}"]`))
const mine = (await find('Employee', 'employees', { reference: REF }, { limit: 1 }))[0] ?? null
t('create.andTheApiHasThem', !!mine)
if (mine) fixtures.employeeIds.push(mine.id)

// A person with no pay window reads as one, rather than as zero — a salary a
// screen invented is worse than a blank.
t('create.withNoOpenWindowTheColumnSaysSo',
  await evaluate(`
    const tr = document.querySelector('[data-reference="${REF}"]');
    return (tr?.textContent ?? '').includes('no open window');
  `))

// ─── setting pay: the raise ───────────────────────────────────────────────

await go(`/people/${mine.id}/`)
t('person.theScreenLoads', await waitFor('#pd-setpay'))

// What control the schema chose for the date. Asked rather than assumed: the
// answer decides what a person types into it.
const dateControl = await evaluate(`
  const m = await import('/src/resources/PayWindow.mesa');
  const f = m.payWindows.formFields().find(f => f.name === 'effectiveFrom');
  return { control: f?.control, required: f?.required };
`)
t('person.theFromBoxIsADate', ['date', 'datetime', 'datetime-local'].includes(dateControl.control))
t('person.andItIsOptional',   dateControl.required !== true)

// A new hire whose pay started when they did — 400 days ago, which is a past
// instant on the FIRST window. It was refused until this drive tried to build a
// fixture and could not: with nothing open there is no window to close and no
// history to cross, and the refusal meant a person's pay could only ever begin
// at the moment somebody typed it.
await fill('basis', 'salary')
await fill('rate', '60000')          // dollars — the column holds cents
await fill('hoursPerWeek', '40')
await fill('effectiveFrom', stamp(Date.now() - 400 * 86_400_000))
await click('#pd-setpay')
t('pay.aFirstWindowMayStartWhenTheyDid', await waitFor('[data-window][data-open="true"]'))

// `@money` means the box is dollars and the column is cents. Nothing on the
// page knows that — the control does, off `x-money` on the rule.
const stored = (await find('PayWindow', 'payWindows',
  { employeeId: mine.id, effectiveTo: null }, { limit: 1 }))[0]
t('pay.theColumnHoldsMinorUnits', stored?.rate === 6_000_000)
t('pay.andTheTileShowsTheAnnualFigure',
  await evaluate(`return (document.querySelector('#pd-now')?.textContent ?? '').replace(/[^0-9]/g, '')`)
    .then(s => s.includes('60000') || s.includes('6000000')))

// ─── setting pay: the backdate, which is the same write ───────────────────

const BACK = new Date(Date.now() - 200 * 86_400_000)
await fill('basis', 'salary')
await fill('rate', '72000')
await fill('hoursPerWeek', '40')
await fill('effectiveFrom', stamp(BACK))
await click('#pd-setpay')

t('backdate.aSecondWindowOpens', await evaluate(`
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    if (document.querySelectorAll('[data-window]').length >= 2) return true;
    await new Promise(r => setTimeout(r, 60));
  }
  return false;
`))

const windows = await find('PayWindow', 'payWindows',
  { employeeId: mine.id }, { orderBy: '-effectiveFrom', limit: 20 })
t('backdate.theEarlierOneIsNowClosed', windows.filter(w => w.effectiveTo).length === 1)
// The two windows TOUCH — no gap and no overlap — which is the invariant, and
// it is also the only timezone-free way to assert it: the box is a local wall
// clock and the column is an instant, so what a drive can compare is the two
// ends against each other rather than either against what was typed.
t('backdate.andTheWindowsTouch',
  windows.find(w => w.effectiveTo)?.effectiveTo === windows.find(w => !w.effectiveTo)?.effectiveFrom)
t('backdate.andTheNewOneOpensInThePast',
  new Date(windows.find(w => !w.effectiveTo)?.effectiveFrom) < new Date())

// A FUTURE date is refused, and the refusal reaches the screen rather than
// dying in a console. It is a service rule, so it arrives as a form-level
// message rather than under a box.
await fill('basis', 'salary')
await fill('rate', '80000')
await fill('effectiveFrom', stamp(Date.now() + 5 * 86_400_000))
await click('#pd-setpay')
t('backdate.aFutureDateIsRefusedOnScreen', await evaluate(`
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    const txt = document.body.textContent ?? '';
    if (/future date/i.test(txt)) return true;
    await new Promise(r => setTimeout(r, 60));
  }
  return false;
`))
t('backdate.andNoThirdWindowWasWritten',
  (await find('PayWindow', 'payWindows', { employeeId: mine.id }, { limit: 20 })).length === 2)

// ─── the as-at read ───────────────────────────────────────────────────────
//
// Typed into a box, answered by the server. Before the backdate instant the
// answer is the first window; after it, the second.

// A `type="date"` box, so a date and not a wall clock — a datetime string in
// one is rejected outright and `el.value` comes back empty, which reads on
// screen as somebody not having typed anything.
const day    = (ms) => new Date(ms).toISOString().slice(0, 10)
const before = day(Date.now() - 300 * 86_400_000)
const after  = day(Date.now() - 100 * 86_400_000)

await evaluate(`
  const el = document.querySelector('#pd-asat input, input#pd-asat, #pd-asat');
  const inp = el?.tagName === 'INPUT' ? el : el?.querySelector('input');
  if (!inp) throw new Error('no as-at box');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(inp, ${JSON.stringify(before)});
  inp.dispatchEvent(new Event('input',  { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
`)
await click('#pd-ask')
const wasThen = await evaluate(`
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    const p = document.querySelector('#pd-answer');
    if (p) return p.getAttribute('data-rate');
    await new Promise(r => setTimeout(r, 60));
  }
  return null;
`)
t('asat.itAnswersTheWindowInForceThen', wasThen === '6000000')

await evaluate(`
  const el = document.querySelector('#pd-asat input, input#pd-asat, #pd-asat');
  const inp = el?.tagName === 'INPUT' ? el : el?.querySelector('input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(inp, ${JSON.stringify(after)});
  inp.dispatchEvent(new Event('input',  { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
`)
await click('#pd-ask')
const wasLater = await evaluate(`
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    const p = document.querySelector('#pd-answer');
    if (p && p.getAttribute('data-rate') !== '6000000') return p.getAttribute('data-rate');
    await new Promise(r => setTimeout(r, 60));
  }
  return document.querySelector('#pd-answer')?.getAttribute('data-rate') ?? null;
`)
t('asat.andADifferentOneAfterTheBackdate', wasLater === '7200000')
t('asat.theTwoAnswersDiffer', wasThen !== wasLater)

// **`FJS-612`, the app-level half.** The same expression is on a plain element
// and forwarded to a component beside it, on a screen that answers about three
// different dates in turn — so all three ways it can go wrong are live here at
// once: the forwarded copy frozen at the first answer, the plain one frozen,
// or the children disagreeing with either.
//
// mesa's own `forward-attributes` spec is where the mechanism is asserted; this
// is the one place a real screen re-asks it, which is where it was found.
const forwarded = await evaluate(`
  const plain = document.querySelector('#pd-answer')?.getAttribute('data-rate');
  const fwd   = document.querySelector('#pd-wason')?.getAttribute('data-rate');
  const text  = document.querySelector('#pd-wason')?.textContent ?? '';
  return { plain, fwd, textAgreesWithPlain: text.replace(/[^0-9]/g, '').startsWith(String(plain).slice(0, 5)) };
`)
t('forward.aForwardedAttributeTracksTheValueItWasGiven', forwarded.fwd === forwarded.plain)
t('forward.andItIsTheCurrentAnswerRatherThanTheFirst',   forwarded.plain === wasLater)
t('forward.andTheComponentsOwnChildrenAgree',            forwarded.textAgreesWithPlain)

// ─── a pay run ────────────────────────────────────────────────────────────

await go('/payroll/')
t('runs.theScreenLoads', await waitFor('#r-new'))

// The rate bands are on this page because a payslip line names the row that
// produced it, and a number nobody can trace back is a number nobody can check.
t('runs.theBandsInForceAreShown',
  await evaluate(`return document.querySelectorAll('[data-rate][data-kind]').length >= 4`))
t('runs.aBandNamesItsSlice',
  await evaluate(`
    const tr = document.querySelector('[data-kind="incomeTax"]');
    return /over |–/.test(tr?.textContent ?? '');
  `))

const RREF = `CONR-${RUN}`
const P0 = new Date(Date.now() - 30 * 86_400_000)
const P1 = new Date(Date.now() -  1 * 86_400_000)
await click('#r-new')
await waitFor('[name="reference"]')
await fill('reference', RREF)
await fill('periodStart', stamp(P0))
await fill('periodEnd',   stamp(P1))
await fill('payDate',     stamp(P1))
await fill('periodsPerYear', '12')
await fill('periodIndex', '0')
await click('#r-save')
t('runs.theRunAppears', await waitFor(`[data-reference="${RREF}"]`))

const run = (await find('PayRun', 'payRuns', { reference: RREF }, { limit: 1 }))[0] ?? null
t('runs.andTheApiHasIt', !!run)
if (run) fixtures.runIds.push(run.id)

// A draft offers Calculate — a CUSTOM METHOD, because it writes documents
// before it moves the row. `calculate` is `@system` on the transition, so no
// picker on this page ever offers it as a move.
t('runs.aDraftOffersCalculate', await evaluate(`
  const tr = document.querySelector('[data-reference="${RREF}"]');
  return !!tr?.querySelector('[data-act="calculate"]');
`))
t('runs.andNeverAsATransition', await evaluate(`
  const tr = document.querySelector('[data-reference="${RREF}"]');
  return !tr?.querySelector('[data-move="calculate"]') && !tr?.querySelector('[data-move="pay"]');
`))

await click(`[data-reference="${RREF}"] [data-act="calculate"]`)
t('runs.calculatingMovesIt', await evaluate(`
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    const tr = document.querySelector('[data-reference="${RREF}"]');
    if (tr?.querySelector('[data-run-status="calculated"]')) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  const tr = document.querySelector('[data-reference="${RREF}"]');
  return document.querySelector('#r-error')?.textContent
      ?? ('status stayed ' + (tr?.querySelector('[data-run-status]')?.getAttribute('data-run-status') ?? 'gone'));
`))

// ─── the ladder, and the one place it is not flat ─────────────────────────

t('ladder.anAdministratorIsOfferedApprove', await evaluate(`
  const tr = document.querySelector('[data-reference="${RREF}"]');
  return !!tr?.querySelector('[data-move="approve"]');
`))
t('ladder.andRevertBesideIt', await evaluate(`
  const tr = document.querySelector('[data-reference="${RREF}"]');
  return !!tr?.querySelector('[data-move="revert"]');
`))

await evaluate(`
  const { signOut, signIn } = await import('/src/session.js');
  await signOut();
  await signIn('sam@shop.test', 'correct-horse-battery');
`)
await go('/payroll/')
await waitFor(`[data-reference="${RREF}"]`)

// **And what it found is not what it was written to find.** The expectation was
// that a level-4 caller would see the run and be offered no `approve`. They see
// no run: `PayRun` READS at 5, so the whole surface is gated one step earlier
// and the per-transition gate never gets a chance to matter.
t('ladder.aLevelFourCallerSeesNoRunAtAll', await evaluate(`
  return !document.querySelector('[data-reference="${RREF}"]');
`))
t('ladder.andTheNavLinkIsGoneWithIt', await evaluate(`
  return !document.querySelector('#nav-payroll');
`))

const graded = await evaluate(`
  const m = await import('/src/resources/PayRun.mesa');
  return { read4: m.payRuns.can('read', 4), read5: m.payRuns.can('read', 5),
           upd4:  m.payRuns.can('update', 4), upd5: m.payRuns.can('update', 5) };
`)
t('ladder.becauseTheModelReadsAtFive', graded.read4 === false && graded.read5 === true)
// The transition's own gate is the same number as the model's update gate, so
// it narrows nothing. **A per-transition gate is only visible ABOVE the model's
// update gate**, and this application's ladder tops out at 5 for a person —
// there is nowhere above to put one. That is the honest shape of a domain with
// exactly one audience: the ladder gates the SURFACE and not the moves inside
// it.
t('ladder.andTheTransitionGateAddsNothingHere',
  graded.upd4 === false && graded.upd5 === true)

// …and the affordance is an affordance: the boundary refuses the patch whether
// or not a button was rendered (Invariant 6).
t('ladder.andTheBoundaryRefusesItAnyway', await evaluate(`
  const m = await import('/src/resources/PayRun.mesa');
  try { await m.payRuns.service.patch(${run.id}, { status: 'approved' }); return false }
  catch (e) { return (e.status ?? e.code) === 401 || (e.status ?? e.code) === 403 }
`))

await evaluate(`
  const { signOut, signIn } = await import('/src/session.js');
  await signOut();
  await signIn('alex@shop.test', 'correct-horse-battery');
`)

// ─── the run's own screen ─────────────────────────────────────────────────

await go(`/payroll/${run.id}/`)
t('detail.thePayslipsRender', await waitFor('[data-payslip]'))
t('detail.myPersonIsOnIt', await evaluate(`
  return !!document.querySelector('[data-payslip][data-employee="${mine.id}"]');
`))

const tiles = await evaluate(`
  const n = (id) => Number((document.querySelector(id)?.textContent ?? '').replace(/[^0-9.-]/g, ''));
  return { gross: n('#rd-gross'), deductions: n('#rd-deductions'), net: n('#rd-net'),
           employer: n('#rd-employer'), count: n('#rd-count') };
`)
t('detail.theTotalsAddUp', Math.abs(tiles.gross - tiles.deductions - tiles.net) < 0.02)
t('detail.andTheEmployerCostIsNotInTheNet', tiles.employer > 0 && tiles.employer !== tiles.deductions)
t('detail.theHeadcountMatchesTheRows',
  tiles.count === await evaluate(`return document.querySelectorAll('[data-payslip]').length`))

// One payslip, composed — the header and the lines that add up to it.
await click(`[data-payslip][data-employee="${mine.id}"] [data-open]`)
t('detail.aPayslipOpensWithItsLines', await waitFor('[data-line]'))
t('detail.theCountedLinesSumToNet', await evaluate(`
  const rows = [...document.querySelectorAll('[data-line]')];
  const counted = rows.filter(r => !r.querySelector('[data-line] , td:last-child')?.textContent?.includes('employer'));
  const sum = rows
    .filter(r => !(r.textContent ?? '').includes('employer'))
    .reduce((n, r) => n + Number(r.querySelector('[data-amount]')?.getAttribute('data-amount') ?? 0), 0);
  const net = Number((document.querySelector('#ps-net')?.textContent ?? '').replace(/[^0-9.-]/g, '')) * 100;
  return Math.abs(sum - net) <= 1;
`))
t('detail.anOrdinaryLineCorrectsNothing', await evaluate(`
  return [...document.querySelectorAll('[data-line]')].every(r => !r.getAttribute('data-corrects'));
`))

// ─── approve, pay, and the books ──────────────────────────────────────────

await go('/payroll/')
await waitFor(`[data-reference="${RREF}"] [data-move="approve"]`)
await click(`[data-reference="${RREF}"] [data-move="approve"]`)
t('pay.approvingMovesIt', await evaluate(`
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const tr = document.querySelector('[data-reference="${RREF}"]');
    if (tr?.querySelector('[data-run-status="approved"]')) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
`))

await click(`[data-reference="${RREF}"] [data-act="pay"]`)
// The confirmation is a one-way door — a payslip that has gone out cannot be
// un-sent — so it asks where the button is.
await evaluate(`
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const b = [...document.querySelectorAll('button')].find(b => /pay it/i.test(b.textContent ?? ''));
    if (b) { b.click(); return true }
    await new Promise(r => setTimeout(r, 60));
  }
  throw new Error('the confirmation never appeared');
`)
t('pay.itMovesToPaid', await evaluate(`
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    const tr = document.querySelector('[data-reference="${RREF}"]');
    if (tr?.querySelector('[data-run-status="paid"]')) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
`))

await go(`/payroll/${run.id}/`)
t('books.theJournalIsOnTheScreen', await waitFor('[data-account]'))
const books = await evaluate(`
  const rows = [...document.querySelectorAll('[data-account]')];
  const num = (a) => Number(a || 0);
  return {
    accounts: rows.map(r => r.getAttribute('data-account')),
    debits:   rows.reduce((n, r) => n + num(r.querySelector('[data-debit]')?.getAttribute('data-debit')), 0),
    credits:  rows.reduce((n, r) => n + num(r.querySelector('[data-credit]')?.getAttribute('data-credit')), 0),
  };
`)
t('books.itBalancesOnScreen', books.debits === books.credits && books.debits > 0)
t('books.fiveAccounts', books.accounts.length === 5)
t('books.theWagesExpenseIsTheDebit', books.accounts[0] === 'wagesExpense')

// **The second refusal, and the one no HTTP drive can reach.** Over the wire
// the books answer 405, because `journalEntries` declares `find` and `get` and
// nothing else — the service never mounts a write and the gate is not
// consulted (`verify:money` asserts that half). What holds if somebody adds
// `'update'` to that list is `@@gate("5.8.9.9")`: `9` is LOCKED, so
// `asSystem()` — which grades 8 — is refused BY NAME. That is the difference
// between a ledger that is append-only by agreement and one that is
// append-only at the Data boundary, and it needs a client to ask.
const ledgerEntry = (await sys.journalEntry.findMany({ where: { payRunId: run.id }, limit: 1 }))[0]
t('books.andTheSystemItselfMayNotRestateOne', await (async () => {
  try { await sys.journalEntry.update({ where: { id: ledgerEntry.id }, data: { narrative: 'restated' } }); return false }
  catch (e) { return /LOCKED|9/.test(e.message) }
})())
t('books.norDeleteOne', await (async () => {
  try { await sys.journalEntry.delete({ where: { id: ledgerEntry.id } }); return false }
  catch (e) { return /LOCKED|9/.test(e.message) }
})())

// ─── the correction, on a screen ──────────────────────────────────────────
//
// Phase 6's finding rendered: a backdated raise makes a paid period wrong, and
// the NEXT payslip says which run each of its adjustment lines puts right.

const slipBefore = (await find('Payslip', 'payslips',
  { payRunId: run.id, employeeId: mine.id }, { limit: 1 }))[0]

await go(`/people/${mine.id}/`)
await waitFor('#pd-setpay')
await fill('basis', 'salary')
await fill('rate', '96000')
await fill('effectiveFrom', stamp(Date.now() - 120 * 86_400_000))
await click('#pd-setpay')
await evaluate(`
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    if (document.querySelectorAll('[data-window]').length >= 3) return true;
    await new Promise(r => setTimeout(r, 60));
  }
  return false;
`)

const RREF2 = `CONR-${RUN}B`
await go('/payroll/')
await waitFor('#r-new')
await click('#r-new')
await waitFor('[name="reference"]')
await fill('reference', RREF2)
await fill('periodStart', stamp(Date.now() - 1 * 86_400_000))
await fill('periodEnd',   stamp(Date.now()))
await fill('payDate',     stamp(Date.now()))
await fill('periodsPerYear', '12')
await fill('periodIndex', '1')
await click('#r-save')
await waitFor(`[data-reference="${RREF2}"]`)

const run2 = (await find('PayRun', 'payRuns', { reference: RREF2 }, { limit: 1 }))[0] ?? null
if (run2) fixtures.runIds.push(run2.id)

await click(`[data-reference="${RREF2}"] [data-act="calculate"]`)
await evaluate(`
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    const tr = document.querySelector('[data-reference="${RREF2}"]');
    if (tr?.querySelector('[data-run-status="calculated"]')) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
`)

await go(`/payroll/${run2.id}/`)
await waitFor(`[data-payslip][data-employee="${mine.id}"]`)
await click(`[data-payslip][data-employee="${mine.id}"] [data-open]`)
await waitFor('[data-line]')

t('correction.thePayslipCarriesAdjustmentLines', await evaluate(`
  return [...document.querySelectorAll('[data-line]')].some(r => r.getAttribute('data-corrects'));
`))
t('correction.theyNameTheRunTheyCorrect', await evaluate(`
  const r = [...document.querySelectorAll('[data-line]')].find(r => r.getAttribute('data-corrects'));
  return (r?.textContent ?? '').includes('corrects ${RREF}');
`))
t('correction.andItIsBadgedAsAnAdjustment', await evaluate(`
  return !!document.querySelector('[data-adjustment]');
`))
// The paid payslip it corrects is untouched — the console never offers a way
// to edit one, because every figure on it is @immutable.
const paidSlip = (await find('Payslip', 'payslips',
  { payRunId: run.id, employeeId: mine.id }, { limit: 1 }))[0]
// The FIGURES, not the whole row. `sentAt` is the one column on a payslip that
// legitimately moves after it is issued — the send job stamps it once the
// outbox relay gets to it — so a byte comparison here would be asserting that
// the payslip was never sent, which is a different claim and an unstable one.
// Everything a person is owed is `@immutable` and is what has to hold.
const figures = (x) => x && JSON.stringify({
  gross: x.gross, deductions: x.deductions, net: x.net,
  employerCost: x.employerCost, payWindowId: x.payWindowId,
  periodStart: x.periodStart, periodEnd: x.periodEnd,
})
t('correction.andTheClosedPayslipDidNotMove',
  !!paidSlip && figures(paidSlip) === figures(slipBefore))

t('console.noErrorsAnywhere', noise.length === 0)

} catch (err) {
  failedEarly = err
} finally {
  // The sweep has one owner — `payroll-sweep.mjs` — because five drives make
  // the same shapes and the ORDER is the whole of it: four foreign keys point
  // into a pay run, two of them `Restrict`, and the books need the hatch under
  // the boundary.
  try { await sweepPayroll(sys, fixtures) }
  catch (e) { console.log(`  note  sweep: ${e.message}`) }

  try { chrome.kill() } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
  stopAll()
}

// ─── report ───────────────────────────────────────────────────────────────
//
// Printed even when the drive stopped early, because *which assertions had
// already passed* is most of what a stack trace does not say.

const expected = {
  'nav.payrollIsOfferedAtLevelFive': true,
  'people.theRosterRenders': true,
  'people.aLeaverIsShownAsGone': true,
  'people.andSomebodyStillHereIsNot': true,
  'people.theOnColumnIsTheOpenWindow': true,
  'create.theDrawerOffersTheGeneratedForm': true,
  'create.thePersonAppears': true,
  'create.andTheApiHasThem': true,
  'create.withNoOpenWindowTheColumnSaysSo': true,
  'person.theScreenLoads': true,
  'person.theFromBoxIsADate': true,
  'person.andItIsOptional': true,
  'pay.aFirstWindowMayStartWhenTheyDid': true,
  'pay.theColumnHoldsMinorUnits': true,
  'pay.andTheTileShowsTheAnnualFigure': true,
  'backdate.aSecondWindowOpens': true,
  'backdate.theEarlierOneIsNowClosed': true,
  'backdate.andTheWindowsTouch': true,
  'backdate.andTheNewOneOpensInThePast': true,
  'backdate.aFutureDateIsRefusedOnScreen': true,
  'backdate.andNoThirdWindowWasWritten': true,
  'asat.itAnswersTheWindowInForceThen': true,
  'asat.andADifferentOneAfterTheBackdate': true,
  'asat.theTwoAnswersDiffer': true,
  'forward.aForwardedAttributeTracksTheValueItWasGiven': true,
  'forward.andItIsTheCurrentAnswerRatherThanTheFirst': true,
  'forward.andTheComponentsOwnChildrenAgree': true,
  'runs.theScreenLoads': true,
  'runs.theBandsInForceAreShown': true,
  'runs.aBandNamesItsSlice': true,
  'runs.theRunAppears': true,
  'runs.andTheApiHasIt': true,
  'runs.aDraftOffersCalculate': true,
  'runs.andNeverAsATransition': true,
  'runs.calculatingMovesIt': true,
  'ladder.anAdministratorIsOfferedApprove': true,
  'ladder.andRevertBesideIt': true,
  'ladder.aLevelFourCallerSeesNoRunAtAll': true,
  'ladder.andTheNavLinkIsGoneWithIt': true,
  'ladder.becauseTheModelReadsAtFive': true,
  'ladder.andTheTransitionGateAddsNothingHere': true,
  'ladder.andTheBoundaryRefusesItAnyway': true,
  'detail.thePayslipsRender': true,
  'detail.myPersonIsOnIt': true,
  'detail.theTotalsAddUp': true,
  'detail.andTheEmployerCostIsNotInTheNet': true,
  'detail.theHeadcountMatchesTheRows': true,
  'detail.aPayslipOpensWithItsLines': true,
  'detail.theCountedLinesSumToNet': true,
  'detail.anOrdinaryLineCorrectsNothing': true,
  'pay.approvingMovesIt': true,
  'pay.itMovesToPaid': true,
  'books.theJournalIsOnTheScreen': true,
  'books.itBalancesOnScreen': true,
  'books.fiveAccounts': true,
  'books.theWagesExpenseIsTheDebit': true,
  'books.andTheSystemItselfMayNotRestateOne': true,
  'books.norDeleteOne': true,
  'correction.thePayslipCarriesAdjustmentLines': true,
  'correction.theyNameTheRunTheyCorrect': true,
  'correction.andItIsBadgedAsAnAdjustment': true,
  'correction.andTheClosedPayslipDidNotMove': true,
  'console.noErrorsAnywhere': true,
}

let failed = 0
for (const [key, want] of Object.entries(expected)) {
  const ok = got[key] === want
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${key}`)
  if (!ok) console.log(`         want ${want}   have ${JSON.stringify(got[key])}`)
}
if (noise.length) console.log(`\nconsole noise:\n  ${noise.slice(0, 8).join('\n  ')}`)
if (failedEarly) console.error(`\nstopped early: ${failedEarly.message ?? failedEarly}`)
console.log(failed || failedEarly
  ? `\n${failed} assertion(s) failed`
  : `\nall ${Object.keys(expected).length} assertions passed`)
process.exit(failed || failedEarly ? 1 : 0)
