/*
 * verify-studio-access.mjs — the Access panel and the drift badge, in a browser.
 *
 * Studio is a 5000-line HTML file with no test tier, so a panel added to it is
 * unproven until something opens it. This drives a real Chrome against a real
 * `litestone studio` over the example schema and asserts what rendered.
 *
 *   node packages/litestone/test/verify-studio-access.mjs
 *
 * Starts and stops its own server on 5099 — nothing to launch first. Needs
 * Chrome on PATH or $FJS_CHROME, same as the css package's harness.
 *
 * Two traps this harness has already hit:
 *   • NEVER return a bare `null` from a probe. CDP serialises it with no
 *     `value` key, so it reads back as `undefined` and the assertion fails for
 *     a reason that has nothing to do with the page.
 *   • The drift badge is polled every 5s, so an assertion made immediately
 *     after editing the schema races the poll. Call driftLoad() and await it
 *     rather than sleeping and hoping.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as pathResolve } from 'node:path'

const PORT   = process.env.STUDIO_PORT ?? '5099'
const UI     = `http://localhost:${PORT}`
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'
const REPO   = pathResolve(import.meta.dirname, '../../..')
const SCHEMA = join(REPO, 'example/db/schema.lite')

const results = []
const t = (name, actual, expected) => results.push({ name, actual, expected })

// ─── the server, started and stopped by this file ─────────────────────────

const studio = spawn('bunx', ['litestone', 'studio', '--schema', SCHEMA, '--port', PORT], {
  cwd: join(REPO, 'example'), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
let studioOut = ''
studio.stdout.on('data', d => { studioOut += d })
studio.stderr.on('data', d => { studioOut += d })

const ORIGINAL_SCHEMA = readFileSync(SCHEMA, 'utf8')

function cleanup() {
  writeFileSync(SCHEMA, ORIGINAL_SCHEMA, 'utf8')
  try { process.kill(-studio.pid) } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${UI}/api/access`)).ok) break } catch {}
  await new Promise(r => setTimeout(r, 500))
  if (i === 59) { console.error('studio never came up:\n' + studioOut); process.exit(1) }
}

// ─── CDP ──────────────────────────────────────────────────────────────────

const profile = mkdtempSync(join(tmpdir(), 'fjs-studio-'))
const chrome  = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })

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

t('gates.rowCount',  await evaluate(`return document.querySelectorAll('#acPanel tbody tr').length`), 4)
t('gates.counts',    await evaluate(`return document.getElementById('acCounts').textContent.includes('4 models')`), true)

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
t('policies.rendered', await evaluate(`
  return document.querySelector('#acPanel .card') ? document.querySelectorAll('#acPanel .card').length : 0;
`), 1)

await evaluate(`acShow('fields'); return true`)
t('fields.rendered', await evaluate(`return document.querySelectorAll('#acPanel tbody tr').length >= 1`), true)

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
chrome.kill()
// Chrome is still flushing its profile when kill() returns, so this races it
// and throws ENOTEMPTY on a run that otherwise passed — `maxRetries` does not
// cover it, because each retry finds a NEW file written since the last. A temp
// directory left in /tmp must never turn a green drive red.
try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch {}
cleanup()
process.exit(failed ? 1 : 0)
