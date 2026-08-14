// Studio's "🎲 Random" button — the BROWSER half.
//
//   bun bench/studio-factory-click.mjs
//
// Real Chrome over CDP (fetch + WebSocket, no puppeteer). Starts studio and
// Chrome itself and kills both; works on a tmpdir copy of basecamp's db.
// Asserting the endpoint alone would miss the wiring — the first run of this
// listed the requested row among its own parents.
import { spawn } from 'node:child_process'
import { mkdtempSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const R = '/home/j/code/FRONTIER/frontierjs', PORT = 7503, CDP = 7504
let fails = 0
const ok = (n, c, x = '') => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  → ' + x)); if (!c) fails++ }
const work = mkdtempSync(join(tmpdir(), 'factory-click-'))
cpSync(`${R}/packages/basecamp/db`, work, { recursive: true })

const studio = spawn('bun', [`${R}/packages/litestone/src/tools/cli.js`, 'studio', `--port=${PORT}`],
  { cwd: work, env: { ...process.env, ENCRYPTION_KEY: 'a'.repeat(64) }, stdio: 'ignore' })
const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${CDP}`,
  '--window-size=1500,900', '--no-sandbox', '--disable-gpu', 'about:blank'], { stdio: 'ignore' })
const waitFor = async (fn, t = 80) => { for (let i = 0; i < t; i++) { await new Promise(r => setTimeout(r, 250)); const v = await fn().catch(() => null); if (v) return v } return null }
try {
  if (!await waitFor(() => fetch(`http://127.0.0.1:${PORT}/`).then(r => r.ok))) { console.log('studio down'); process.exit(1) }
  const t = await waitFor(() => fetch(`http://127.0.0.1:${CDP}/json/list`).then(r => r.json()).then(x => { const p = x.filter(y => y.type === 'page'); return p.length ? p : null }))
  const ws = new WebSocket(t[0].webSocketDebuggerUrl)
  await new Promise(r => ws.addEventListener('open', r))
  let id = 0
  const send = (m, p = {}) => new Promise(res => { const mine = ++id
    const on = e => { const x = JSON.parse(e.data); if (x.id === mine) { ws.removeEventListener('message', on); res(x.result) } }
    ws.addEventListener('message', on); ws.send(JSON.stringify({ id: mine, method: m, params: p })) })
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value

  await send('Page.enable')
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  await waitFor(async () => (await ev(`document.querySelectorAll('#tableList .table-item').length`)) > 0)

  await ev(`selectTable('App')`)
  await waitFor(async () => (await ev(`document.querySelectorAll('#dataGrid tr').length`)) > 0)
  const btn = await ev(`(() => { const b = document.getElementById('btnRandomRow'); return { shown: b.style.display !== 'none', text: b.textContent.trim() } })()`)
  ok('button is visible on a normal table', btn?.shown === true, JSON.stringify(btn))
  ok('button is labelled', /Random/.test(btn?.text ?? ''), btn?.text)

  const before = await ev(`document.getElementById('pageInfo').textContent`)
  await ev(`document.getElementById('btnRandomRow').click()`)
  const toast = await waitFor(async () => { const v = await ev(`(() => { const t = document.getElementById('toast'); return t.classList.contains('show') ? t.textContent : null })()`); return v })
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
  const chip = await waitFor(async () => await ev(`(() => { const c = document.querySelector('#pinBar .pin-chip'); return c ? c.textContent.replace(/\\s+/g,' ').trim() : null })()`))
  ok('a chip shows the active pin', /📌 Account/.test(chip ?? ''), String(chip))
  ok('the button now reads Pinned', /Pinned/.test(await ev(`[...document.querySelectorAll('#rowDrawer button')].find(x => /Pin/.test(x.textContent)).textContent`) ?? ''))
  await ev(`closeRowDetail()`)

  const accBefore = await ev(`(async () => (await api('/table', { table: 'account', pageSize: 1 })).total)()`)
  await ev(`selectTable('Deployment')`)
  await waitFor(async () => (await ev(`document.getElementById('pageInfo').textContent`)) !== '—')
  await ev(`document.getElementById('btnRandomRow').click()`)
  const pinToast = await waitFor(async () => await ev(`(() => { const t = document.getElementById('toast'); return t.classList.contains('show') && t.classList.contains('ok') ? t.textContent : null })()`))
  ok('generated against the pin', /^Created 1 Deployment/.test(pinToast ?? ''), String(pinToast))
  ok('no account among the parents', !/account/i.test(pinToast ?? ''), String(pinToast))
  console.log('     pinned run:', String(pinToast))
  const accAfter = await ev(`(async () => (await api('/table', { table: 'account', pageSize: 1 })).total)()`)
  ok('account count unchanged', accAfter === accBefore, `${accBefore} → ${accAfter}`)

  await ev(`document.querySelector('#pinBar .pin-x').click()`)
  ok('unpin clears the chip', (await ev(`document.querySelectorAll('#pinBar .pin-chip').length`)) === 0)

  // ── refusal → the toast offers a retry, and the retry works ──────────────
  // Pick a principal the gate will refuse, then drive the offer the way a user
  // does: read the toast, click the button in it.
  await ev(`(() => { _authUsers[999] = { id: 999999, email: 'nobody@x.com' }; setAuth(_authUsers[999]) })()`)
  await new Promise(r => setTimeout(r, 900))
  await ev(`document.getElementById('btnRandomRow').click()`)
  const refusal = await waitFor(async () => await ev(`(() => { const t = document.getElementById('toast'); return t.classList.contains('show') && t.classList.contains('err') ? t.textContent : null })()`))
  ok('refusal is shown, not swallowed', /requires .* access/i.test(refusal ?? ''), String(refusal))
  const offer = await ev(`(() => { const b = document.querySelector('#toast .toast-action'); return b ? b.textContent.trim() : null })()`)
  ok('the toast offers the retry', offer === 'Retry as system', String(offer))
  console.log('     refusal:', String(refusal).slice(0, 90))

  await ev(`document.querySelector('#toast .toast-action').click()`)
  const done = await waitFor(async () => await ev(`(() => { const t = document.getElementById('toast'); return t.classList.contains('show') && t.classList.contains('ok') ? t.textContent : null })()`))
  ok('the retry created the row', /^Created 1 /.test(done ?? ''), String(done))
  ok('and says it bypassed the gate', /\(as system\)/.test(done ?? ''), String(done))
  console.log('     retry:', String(done))
  await ev(`setAuth(null)`)
  await new Promise(r => setTimeout(r, 600))

  await ev(`selectTable('auditLogs')`)
  await new Promise(r => setTimeout(r, 700))
  const hidden = await ev(`document.getElementById('btnRandomRow').style.display`)
  ok('hidden on an append-only table', hidden === 'none', hidden)
  ws.close()
} finally { studio.kill('SIGKILL'); chrome.kill('SIGKILL') }
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
