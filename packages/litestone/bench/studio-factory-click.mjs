// Studio's "🎲 Random" button — the BROWSER half.
//
//   bun bench/studio-factory-click.mjs
//
// Real Chrome over CDP (@frontierjs/mesa/drive). Starts studio and
// Chrome itself and kills both; works on a tmpdir copy of basecamp's db.
// Asserting the endpoint alone would miss the wiring — the first run of this
// listed the requested row among its own parents.
import { spawn } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openChrome } from '../../mesa/src/drive.js'
import { copyBasecampDb } from './basecamp-copy.mjs'
const R = join(dirname(fileURLToPath(import.meta.url)), '../../..'), PORT = 7503
let fails = 0
const ok = (n, c, x = '') => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  → ' + x)); if (!c) fails++ }
const work = copyBasecampDb('factory-click-')
// the schema imports @frontierjs/* packages, which resolve only with a node_modules above the copy
symlinkSync(`${R}/packages/basecamp/node_modules`, join(work, 'node_modules'))

// a studio already on the port would answer for the one started below, over a different db
if (await fetch(`http://127.0.0.1:${PORT}/`).then(() => true, () => false)) { console.log(`port ${PORT} already answers`); process.exit(1) }
const studio = spawn('bun', [`${R}/packages/litestone/src/tools/cli.js`, 'studio', `--port=${PORT}`],
  { cwd: work, env: { ...process.env, ENCRYPTION_KEY: 'a'.repeat(64) }, stdio: 'ignore' })
const browser = await openChrome({ windowSize: '1500,900' })
const waitFor = async (fn, t = 80) => { for (let i = 0; i < t; i++) { await new Promise(r => setTimeout(r, 250)); const v = await fn().catch(() => null); if (v) return v } return null }
try {
  if (!await waitFor(() => fetch(`http://127.0.0.1:${PORT}/`).then(r => r.ok))) { console.log('studio down'); process.exit(1) }
  const send = browser.cmd
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value

  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  await waitFor(async () => (await ev(`document.querySelectorAll('#tableList .table-item').length`)) > 0)

  await ev(`selectTable('App')`)
  await waitFor(async () => (await ev(`document.querySelectorAll('#dataGrid tr').length`)) > 0)
  const btn = await ev(`(() => { const b = document.getElementById('btnRandomRow'); return { shown: !b.hidden, text: b.textContent.trim() } })()`)
  ok('button is visible on a normal table', btn?.shown === true, JSON.stringify(btn))
  ok('button is labeled', /Random/.test(btn?.text ?? ''), btn?.text)

  const before = await ev(`document.getElementById('pageInfo').textContent`)
  await ev(`document.getElementById('btnRandomRow').click()`)
  const toast = await waitFor(async () => { const v = await ev(`(() => { const t = document.getElementById('toast'); return !t.hidden ? t.textContent : null })()`); return v })
  ok('a toast reported the write', !!toast, String(toast))
  ok('toast names the parents it also made', /also/.test(toast ?? ''), String(toast))
  ok('the row is not listed as its own parent',
     !/\bapp\b/i.test((toast ?? '').split('also')[1] ?? ''), String(toast))
  console.log('     toast:', toast)
  const after = await waitFor(async () => { const v = await ev(`document.getElementById('pageInfo').textContent`); return v !== before ? v : null })
  ok('grid reloaded with the new row', !!after, `${before} → ${after}`)
  console.log(`     ${before} → ${after}`)

  // ── pin a row from its detail drawer, then generate against it ───────────
  await ev(`selectTable('Account')`)
  await waitFor(async () => (await ev(`document.querySelectorAll('#dataGrid tr.data-row, #dataGrid tbody tr').length`)) > 0)
  await ev(`(() => { const tr = document.querySelector('#dataGrid tbody tr'); tr && tr.click() })()`)
  await ev(`openRowDetail()`)
  const pinBtn = await waitFor(async () => await ev(`(() => { const b = [...document.querySelectorAll('#rowDrawer button')].find(x => /Pin/.test(x.textContent)); return b ? b.textContent.trim() : null })()`))
  ok('the drawer offers a pin', /📌 Pin/.test(pinBtn ?? ''), String(pinBtn))
  await ev(`[...document.querySelectorAll('#rowDrawer button')].find(x => /Pin/.test(x.textContent)).click()`)
  const chip = await waitFor(async () => await ev(`(() => { const c = document.querySelector('#pinBar .pill'); return c ? c.textContent.replace(/\\s+/g,' ').trim() : null })()`))
  ok('a chip shows the active pin', /📌 Account/.test(chip ?? ''), String(chip))
  ok('the button now reads Pinned', /Pinned/.test(await ev(`[...document.querySelectorAll('#rowDrawer button')].find(x => /Pin/.test(x.textContent)).textContent`) ?? ''))
  await ev(`closeRowDetail()`)

  const accBefore = await ev(`(async () => (await api('/table', { table: 'account', pageSize: 1 })).total)()`)
  await ev(`selectTable('Deployment')`)
  await waitFor(async () => (await ev(`document.getElementById('pageInfo').textContent`)) !== '—')
  await ev(`document.getElementById('btnRandomRow').click()`)
  const pinToast = await waitFor(async () => await ev(`(() => { const t = document.getElementById('toast'); return !t.hidden && t.classList.contains('success') ? t.textContent : null })()`))
  ok('generated against the pin', /^Created 1 Deployment/.test(pinToast ?? ''), String(pinToast))
  ok('no account among the parents', !/account/i.test(pinToast ?? ''), String(pinToast))
  console.log('     pinned run:', String(pinToast))
  const accAfter = await ev(`(async () => (await api('/table', { table: 'account', pageSize: 1 })).total)()`)
  ok('account count unchanged', accAfter === accBefore, `${accBefore} → ${accAfter}`)

  await ev(`document.querySelector('#pinBar .pill-close').click()`)
  ok('unpin clears the chip', (await ev(`document.querySelectorAll('#pinBar .pill').length`)) === 0)

  // ── refusal → the toast offers a retry, and the retry works ──────────────
  // Pick a principal the gate will refuse, then drive the offer the way a user
  // does: read the toast, click the button in it.
  await ev(`(() => { _authUsers[999] = { id: 999999, email: 'nobody@x.com' }; setAuth(_authUsers[999]) })()`)
  await new Promise(r => setTimeout(r, 900))
  await ev(`document.getElementById('btnRandomRow').click()`)
  const refusal = await waitFor(async () => await ev(`(() => { const t = document.getElementById('toast'); return !t.hidden && t.classList.contains('danger') ? t.textContent : null })()`))
  ok('refusal is shown, not swallowed', /requires .* access/i.test(refusal ?? ''), String(refusal))
  const offer = await ev(`(() => { const b = document.querySelector('#toast button'); return b ? b.textContent.trim() : null })()`)
  ok('the toast offers the retry', offer === 'Retry as system', String(offer))
  console.log('     refusal:', String(refusal).slice(0, 90))

  await ev(`document.querySelector('#toast button').click()`)
  const done = await waitFor(async () => await ev(`(() => { const t = document.getElementById('toast'); return !t.hidden && t.classList.contains('success') ? t.textContent : null })()`))
  ok('the retry created the row', /^Created 1 /.test(done ?? ''), String(done))
  ok('and says it bypassed the gate', /\(as system\)/.test(done ?? ''), String(done))
  console.log('     retry:', String(done))
  await ev(`setAuth(null)`)
  await new Promise(r => setTimeout(r, 600))

  await ev(`selectTable('AuditTrail')`)
  await new Promise(r => setTimeout(r, 700))
  const hidden = await ev(`document.getElementById('btnRandomRow').hidden`)
  ok('hidden on an append-only table', hidden === true, String(hidden))
} finally { studio.kill('SIGKILL'); await browser.close() }
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
