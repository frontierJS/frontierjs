/*
 * verify-studio-access.mjs — the Access panel and the drift badge, in a browser.
 *
 * Studio is a 5000-line HTML file with no test tier, so a panel added to it is
 * unproven until something opens it. This drives a real Chrome against a real
 * `litestone studio` over the example schema and asserts what rendered.
 *
 *   node packages/litestone/test/verify-studio-access.mjs
 *
 * Starts and stops its own server on 7502 — test-tier tooling, inside the port
 * scheme so `fli ps` can see it. Nothing to launch first. Needs
 * Chrome on PATH or $FJS_CHROME, same as the css package's harness.
 *
 * Two traps this harness has already hit:
 *   • NEVER return a bare `null` from a probe. CDP serializes it with no
 *     `value` key, so it reads back as `undefined` and the assertion fails for
 *     a reason that has nothing to do with the page.
 *   • The drift badge is polled every 5s, so an assertion made immediately
 *     after editing the schema races the poll. Call driftLoad() and await it
 *     rather than sleeping and hoping.
 */

import { spawn } from 'node:child_process'
import { rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tempDir } from '../src/tmp-dirs.js'
import { join, resolve as pathResolve } from 'node:path'

const PORT   = process.env.STUDIO_PORT ?? '7502'
const UI     = `http://localhost:${PORT}`
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'
const REPO   = pathResolve(import.meta.dirname, '../../..')
const SCHEMA = join(REPO, 'example/db/schema.lite')

const results = []
const t = (name, actual, expected) => results.push({ name, actual, expected })

// ─── the server, started and stopped by this file ─────────────────────────

// From `src/tools/cli.js` by path rather than `bunx litestone`: bun resolves a
// workspace dependency to a COPY under node_modules/.bun, so the binary runs
// the tree as it was at the last install and passes against a broken working
// copy. studio.html is TEXT-IMPORTED into that file, which makes this the
// difference between driving the panel you just edited and the one you shipped.
//
// `--no-open` or every run of this drive opens a tab on the desktop of
// whoever is running it, over whatever they were typing into.
//
// cwd is the APP ROOT, which is where `.env` lives: `example` declares
// @encrypted columns and studio refuses to start without the key.
const CLI    = pathResolve(import.meta.dirname, '../src/tools/cli.js')
const studio = spawn('bun', [CLI, 'studio', '--schema', SCHEMA, '--port', PORT, '--no-open'], {
  cwd: join(REPO, 'example'), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
let studioOut = ''
studio.stdout.on('data', d => { studioOut += d })
studio.stderr.on('data', d => { studioOut += d })

const ORIGINAL_SCHEMA = readFileSync(SCHEMA, 'utf8')

// Everything this run started or altered, undone from one place. Chrome joins
// the set once it is spawned, below — before this, cleanup() restored the
// schema and killed the studio server and left the browser, which does not
// notice its launcher has gone: it is reparented to init and stays up forever,
// holding a profile that keeps growing. Four of them were found alive here,
// and 52 profiles in one day (FJS-361). Synchronous — an exit handler cannot
// await, and this one also has a schema file to put back.
let chromeProc = null
let chromeProfile = null
function cleanup() {
  writeFileSync(SCHEMA, ORIGINAL_SCHEMA, 'utf8')
  try { process.kill(-studio.pid) } catch {}
  if (chromeProc) { try { chromeProc.kill('SIGKILL') } catch {} ; chromeProc = null }
  if (chromeProfile) {
    // The wait is not optional. Removing the profile straight after the kill
    // does not fail, it SUCCEEDS, and Chrome writes the directory back while
    // it shuts down — measured in mesa's drive.mjs, where 0ms left 16MB back
    // on disk and 200ms did not. An exit handler cannot await, so block.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
    try { rmSync(chromeProfile, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) } catch {}
    chromeProfile = null
  }
}
process.on('exit', cleanup)
process.on('SIGINT',  () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })
// The default handler for either of these exits without an ordinary exit path,
// which would leave the schema file rewritten as well as Chrome running.
process.on('uncaughtException',  (e) => { cleanup(); console.error(e); process.exit(1) })
process.on('unhandledRejection', (e) => { cleanup(); console.error(e); process.exit(1) })

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${UI}/api/access`)).ok) break } catch {}
  await new Promise(r => setTimeout(r, 500))
  if (i === 59) { console.error('studio never came up:\n' + studioOut); process.exit(1) }
}

// ─── CDP ──────────────────────────────────────────────────────────────────

const profile = tempDir('fjs-studio-')
const chrome  = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })

chromeProc = chrome
chromeProfile = profile

chrome.on('error', (e) => { console.error(`Could not launch ${CHROME}: ${e.message}`); process.exit(1) })

const wsUrl = await new Promise((res, rej) => {
  let buf = ''
  const timer = setTimeout(() => rej(new Error('Chrome never announced a DevTools port')), 15000)
  chrome.stderr.on('data', (d) => {
    buf += d
    const m = buf.match(/ws:\/\/[^\s]+/)
    if (m) { clearTimeout(timer); res(m[0]) }
  })
})

const browser = new WebSocket(wsUrl)
await new Promise((r) => browser.addEventListener('open', r, { once: true }))

let nextId = 1
const pending = new Map()
function send(method, params = {}, sessionId) {
  const id = nextId++
  browser.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej })
    setTimeout(() => pending.has(id) && rej(new Error(`${method} timed out`)), 30000)
  })
}

const consoleErrors = []
browser.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve: rs, reject: rj } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? rj(new Error(msg.error.message)) : rs(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown')
    consoleErrors.push('exception: ' + (msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text))
  if (msg.method === 'Runtime.consoleAPICalled' && ['error'].includes(msg.params.type))
    consoleErrors.push('error: ' + msg.params.args.map(a => a.value ?? a.description ?? '').join(' '))
})

const { targetId }  = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const cmd = (m, p) => send(m, p, sessionId)
await cmd('Page.enable')
await cmd('Runtime.enable')

async function evaluate(expression) {
  const r = await cmd('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true, returnByValue: true,
  })
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

await cmd('Page.navigate', { url: UI + '/#access' })
await evaluate(`
  if (document.readyState !== 'complete')
    await new Promise(r => window.addEventListener('load', r, { once: true }));
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (document.querySelector('#acPanel table')) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
`)

// ─── the panel ────────────────────────────────────────────────────────────

t('panel.visible',   await evaluate(`return !document.getElementById('panelAccess').hidden`), true)
t('nav.current',     await evaluate(`return document.getElementById('navAccess').getAttribute('aria-current')`), 'page')

// DERIVED, not typed. These were literal 4s frozen at an `example` that had
// four models; it has 39 now, so the drive failed on every run and reported a
// fixture that had stopped describing its subject as a regression in the panel.
// A UI drive's question is *did the panel render what it was given*, so the
// expectation comes from the same endpoint the panel reads — whether that
// endpoint is RIGHT is a different question, and `access.snapshot.md` is
// already the thing that gates it.
const surface     = await (await fetch(`${UI}/api/access`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
})).json()
const modelCount  = surface.models.length
const policyCount = surface.models.filter(m => m.policies && Object.keys(m.policies).length).length

// One card per (model, field): a model may declare @@transitions on two columns,
// and a header naming one field over rows belonging to both is a diagram of a
// machine that does not exist. Derived from the payload for FJS-773's reason —
// a typed-in count freezes against a fixture and reports it as a regression.
const moveCards = surface.models
  .filter(m => m.transitions.length)
  .flatMap(m => [...new Set(m.transitions.map(t => t.field))].map(f => ({ m, f })))
const moveRows  = surface.counts.transitions

t('gates.rowCount',  await evaluate(`return document.querySelectorAll('#acPanel tbody tr').length`), modelCount)
t('gates.counts',    await evaluate(`return document.getElementById('acCounts').textContent.includes('${modelCount} models')`), true)

// STRANGER on read is the thing worth catching the eye — example's models are
// all `0.4.4.5`, so read is level 0 and must carry the warning tone.
t('gates.strangerToned', await evaluate(`
  const cell = document.querySelector('#acPanel tbody tr td:nth-child(2) .badge');
  return cell.className.includes('warning') && cell.textContent.includes('STRANGER');
`), true)

// ─── by level — the view the markdown file cannot produce ─────────────────

await evaluate(`acShow('level'); return true`)
t('level.defaultIs4', await evaluate(`return document.querySelector('#acPanel .alert').textContent.includes('4 USER')`), true)

// Order is `0.4.4.5`: at USER(4) read/create/update pass and delete does not.
t('level.4.deleteDenied', await evaluate(`
  const rows = [...document.querySelectorAll('#acPanel tbody tr')];
  const order = rows.find(r => r.textContent.trim().startsWith('Order'));
  return order.querySelector('td:nth-child(5) .badge').textContent.trim();
`), 'deny')

t('level.4.readAllowed', await evaluate(`
  const rows = [...document.querySelectorAll('#acPanel tbody tr')];
  const order = rows.find(r => r.textContent.trim().startsWith('Order'));
  return order.querySelector('td:nth-child(2) .badge').textContent.trim();
`), 'allow')

// At STRANGER(0) only the reads survive.
await evaluate(`acSetLevel(0); return true`)
t('level.0.createDenied', await evaluate(`
  const rows = [...document.querySelectorAll('#acPanel tbody tr')];
  const order = rows.find(r => r.textContent.trim().startsWith('Order'));
  return order.querySelector('td:nth-child(3) .badge').textContent.trim();
`), 'deny')

// SYSTEM(8) is not "highest wins" — a gate of 8 admits only 8, and a gate of 4
// still admits it. Notification declares `0.8.4.8`, which is the case that
// catches a naive `level >= required`.
await evaluate(`acSetLevel(8); return true`)
t('level.8.systemGateAllowed', await evaluate(`
  const rows = [...document.querySelectorAll('#acPanel tbody tr')];
  const n = rows.find(r => r.textContent.trim().startsWith('Notification'));
  return n.querySelector('td:nth-child(3) .badge').textContent.trim();
`), 'allow')

await evaluate(`acSetLevel(7); return true`)
t('level.7.systemGateDenied', await evaluate(`
  const rows = [...document.querySelectorAll('#acPanel tbody tr')];
  const n = rows.find(r => r.textContent.trim().startsWith('Notification'));
  return n.querySelector('td:nth-child(3) .badge').textContent.trim();
`), 'deny')

// ─── policies and fields ──────────────────────────────────────────────────

await evaluate(`acShow('policies'); return true`)
// The Claims card sits above these and is not one of them — it is about the
// schema rather than about a model, so it carries an id and is excluded here.
t('policies.rendered', await evaluate(`
  return document.querySelectorAll('#acPanel .card:not(#acClaimsCard)').length;
`), policyCount)

await evaluate(`acShow('fields'); return true`)
t('fields.rendered', await evaluate(`return document.querySelectorAll('#acPanel tbody tr').length >= 1`), true)

// ─── claims ───────────────────────────────────────────────────────────────
//
// The panel's whole claim is that a name resolving to nothing LOOKS the same as
// one that resolves. So the graded rows are asserted beside an ungraded one —
// and `example` has none, deliberately, which is why the second half edits the
// schema to make one rather than asserting against a fixture that already
// disagrees with the app.
await evaluate(`acShow('policies'); return true`)

const claims = surface.claims

t('claims.cardRendered', await evaluate(`
  return Boolean(document.getElementById('acClaimsCard'));
`), true)

t('claims.rowPerName', await evaluate(`
  const card = [...document.querySelectorAll('#acPanel .card')]
    .find(c => c.querySelector('.surface-header b')?.textContent.trim() === 'Claims');
  return card.querySelectorAll('tbody tr').length;
`), claims.used.length)

// The SOURCE is the half that makes the badge actionable: `cartToken` is a
// top-level `claim` and `isAdmin` is one of the framework's own, and a panel
// printing one word for both says nothing about where to go and change it.
const bySource = Object.fromEntries(claims.used.map(c => [c.name, c.source]))
t('claims.sourceNamed', await evaluate(`
  const card = [...document.querySelectorAll('#acPanel .card')]
    .find(c => c.querySelector('.surface-header b')?.textContent.trim() === 'Claims');
  const row = [...card.querySelectorAll('tbody tr')]
    .find(r => r.querySelector('code')?.textContent.trim() === 'auth().cartToken');
  return row.querySelector('td:nth-child(3)').textContent.trim();
`), bySource.cartToken)

t('claims.allGradedOnExample', await evaluate(`
  const card = [...document.querySelectorAll('#acPanel .card')]
    .find(c => c.querySelector('.surface-header b')?.textContent.trim() === 'Claims');
  return card.querySelectorAll('tbody .badge.danger').length;
`), 0)

// ─── moves ────────────────────────────────────────────────────────────────
//
// A state machine is access: `@@transitions` says which changes exist, and a
// per-move @gate is a permission no @@gate on the model can express. Every
// assertion here is PAIRED with its opposite — a gated move beside an
// inherited one, a terminal state beside the states that are not — because a
// panel rendering every move identically satisfies any test that only asks
// whether the rows appeared.
await evaluate(`acShow('moves'); return true`)

t('moves.cardsPerModelField', await evaluate(`return document.querySelectorAll('#acPanel .card').length`), moveCards.length)
t('moves.rowCount',           await evaluate(`return document.querySelectorAll('#acPanel tbody tr').length`), moveRows)
t('moves.countsLine',         await evaluate(`return document.getElementById('acCounts').textContent.includes('${moveRows} declared moves')`), true)

// The pair the panel exists for. `Order.refund` is @gate(5) on a model that
// updates at 4, so the badge has to say 5 — and `pay`, which inherits, has to
// say something else, or a panel printing the model's gate on every row passes.
const gated    = surface.models.flatMap(m => m.transitions).find(t => t.gate != null)
const inherit  = surface.models.flatMap(m => m.transitions).find(t => t.gate == null)

t('moves.gateShown', await evaluate(`
  const row = [...document.querySelectorAll('#acPanel tbody tr')]
    .find(r => r.querySelector('td b')?.textContent.trim() === ${JSON.stringify(gated.name)});
  return row.querySelector('td:nth-child(4) .badge')?.textContent.trim();
`), `${gated.gate} ${['STRANGER','VISITOR','READER','CREATOR','USER','ADMINISTRATOR','OWNER','SYSADMIN','SYSTEM','LOCKED'][gated.gate]}`)

t('moves.inheritedGateIsNotABadge', await evaluate(`
  const row = [...document.querySelectorAll('#acPanel tbody tr')]
    .find(r => r.querySelector('td b')?.textContent.trim() === ${JSON.stringify(inherit.name)});
  return Boolean(row.querySelector('td:nth-child(4) .badge'));
`), false)

// A state that is only ever a `to` can never be left, which is a design
// statement rather than a rendering detail. Derived, and asserted with a
// non-terminal state from the same machine beside it.
const withTerminal = moveCards.map(({ m, f }) => {
  const moves = m.transitions.filter(t => t.field === f)
  const froms = new Set(moves.flatMap(t => t.from))
  return { m, f, terminal: [...new Set(moves.map(t => t.to))].filter(x => !froms.has(x)), froms: [...froms] }
}).find(c => c.terminal.length)

t('moves.terminalNamed', await evaluate(`
  const card = [...document.querySelectorAll('#acPanel .card')]
    .find(c => c.querySelector('.surface-header b')?.textContent.trim() === ${JSON.stringify(withTerminal.m.name)});
  return card.querySelector('.alert')?.textContent.includes(${JSON.stringify(withTerminal.terminal[0])});
`), true)

t('moves.nonTerminalNotNamed', await evaluate(`
  const card = [...document.querySelectorAll('#acPanel .card')]
    .find(c => c.querySelector('.surface-header b')?.textContent.trim() === ${JSON.stringify(withTerminal.m.name)});
  return card.querySelector('.alert')?.textContent.includes(${JSON.stringify(withTerminal.froms[0])});
`), false)

// ─── an ungraded claim ────────────────────────────────────────────────────
//
// The negative control for everything above, and it cannot come from `example`:
// the app is correct, so the only way to see the failing side is to introduce
// it. A misspelling — `auth().isStaf` — is exactly the shape FJS-666 is about,
// and it parses, builds and reads as a policy doing its job.
{
  const edited = ORIGINAL_SCHEMA.replace("@@allow('read', auth().isStaff)", "@@allow('read', auth().isStaf)")
  if (edited === ORIGINAL_SCHEMA) { console.error('claims: no isStaff read policy to misspell'); process.exit(1) }
  writeFileSync(SCHEMA, edited, 'utf8')

  await evaluate(`_access = await api('/access'); acShow('policies'); return true`)

  t('claims.ungradedIsFlagged', await evaluate(`
    const card = document.getElementById('acClaimsCard');
    const row = [...card.querySelectorAll('tbody tr')]
      .find(r => r.querySelector('code')?.textContent.trim() === 'auth().isStaf');
    return row.querySelector('.badge.danger')?.textContent.trim();
  `), 'ungraded')

  // A count in a header nobody can act on is decoration. The model card
  // carrying the typo has to say so too, or the reader is told a claim is
  // ungraded and left to grep for it.
  t('claims.modelCardMarked', await evaluate(`
    const cards = [...document.querySelectorAll('#acPanel .card:not(#acClaimsCard)')]
      .filter(c => c.querySelector('.badge.danger')?.textContent.trim() === 'ungraded claim');
    return cards.length > 0;
  `), true)

  // And the model that does NOT name it must stay unmarked, or a panel marking
  // everything passes the row above.
  t('claims.unaffectedModelUnmarked', await evaluate(`
    const card = [...document.querySelectorAll('#acPanel .card')]
      .find(c => c.querySelector('.surface-header b')?.textContent.trim() === 'Cart');
    return card ? Boolean(card.querySelector('.badge.danger')) : false;
  `), false)

  writeFileSync(SCHEMA, ORIGINAL_SCHEMA, 'utf8')
  await evaluate(`_access = await api('/access'); acRender(); return true`)
}

// ─── drift ────────────────────────────────────────────────────────────────

// Asserted as a DELTA rather than against a clean tree. The snapshot committed
// in this repo may legitimately be stale while someone is mid-edit, and a drive
// that demands a clean start fails for a reason that has nothing to do with the
// code under test. What is being tested is that an edit CHANGES the answer.
t('drift.fileCleanAtStart', await evaluate(`await driftLoad(); return _drift.file.changed`), false)

// Edit the schema under the running server — the exact case Studio could not
// see before, because it parses once at boot.
writeFileSync(SCHEMA, ORIGINAL_SCHEMA.replace('@@gate("0.4.4.5")', '@@gate("0.4.4.4")'), 'utf8')

t('drift.fileChangeSeen', await evaluate(`await driftLoad(); return _drift.file.changed`), true)
t('drift.snapshotGoesStale', await evaluate(`return _drift.snapshot.current`), false)
t('drift.badgeAppears', await evaluate(`return !document.getElementById('driftBadge').hidden`), true)
t('drift.namesTheFileCause', await evaluate(`
  return document.getElementById('driftBadge').title.includes('schema file edited');
`), true)

// The panel reads through to the file rather than the boot parse.
t('drift.panelFollowsFile', await evaluate(`
  _access = null; await acInit(); acShow('gates');
  const rows = [...document.querySelectorAll('#acPanel tbody tr')];
  return rows.some(r => r.textContent.includes('0.4.4.4'));
`), true)

writeFileSync(SCHEMA, ORIGINAL_SCHEMA, 'utf8')
t('drift.clearsOnRestore', await evaluate(`await driftLoad(); return _drift.file.changed`), false)

t('consoleErrors', consoleErrors, [])

// ─── report ───────────────────────────────────────────────────────────────

let failed = 0
for (const { name, actual, expected } of results) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`}`)
}

console.log(failed ? `\n${failed} assertion(s) failed` : `\nall ${results.length} assertions passed`)

try { browser.close() } catch {}
cleanup()
process.exit(failed ? 1 : 0)
