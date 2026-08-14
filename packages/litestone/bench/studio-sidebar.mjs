// Does the studio sidebar stay usable when the schema is big?
//
//   bun bench/studio-sidebar.mjs                     # basecamp, 38 models
//   H=400 bun bench/studio-sidebar.mjs               # short viewport
//   bun bench/studio-sidebar.mjs <schema> <cwd>      # any other app
//
// Starts studio and Chrome itself and kills both.
// Real Chrome over CDP (fetch + WebSocket, no puppeteer) because this is a
// computed-layout question: scrollHeight vs clientHeight and whether the Tools
// nav is inside the viewport. Asserting on the CSS text would prove nothing.
import { spawn } from 'node:child_process'
const R = '/home/j/code/FRONTIER/frontierjs'
const SCHEMA = process.argv[2] ?? `${R}/packages/basecamp/db/schema.lite`
const CWD    = process.argv[3] ?? `${R}/packages/basecamp/db`
const PORT = 7503, CDP = 7504
let fails = 0
const ok = (n, c, x = '') => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  → ' + x)); if (!c) fails++ }

const studio = spawn('bun', [`${R}/packages/litestone/src/tools/cli.js`, 'studio', `--port=${PORT}`],
  { cwd: CWD, env: { ...process.env, ENCRYPTION_KEY: 'a'.repeat(64) }, stdio: ['ignore','pipe','pipe'] })
let slog = ''; studio.stdout.on('data', d => slog += d); studio.stderr.on('data', d => slog += d)

const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${CDP}`,
  `--window-size=1400,${process.env.H ?? 700}`, '--no-sandbox', '--disable-gpu', 'about:blank'], { stdio: 'ignore' })

const waitFor = async (fn, tries = 60) => {
  for (let i = 0; i < tries; i++) { await new Promise(r => setTimeout(r, 250)); const v = await fn().catch(() => null); if (v) return v }
  return null
}
try {
  if (!await waitFor(() => fetch(`http://127.0.0.1:${PORT}/`).then(r => r.ok))) { console.log('studio down\n' + slog.slice(0, 900)); process.exit(1) }
  // a profile with extensions lists background_page targets first — take the PAGE
  const targets = await waitFor(() => fetch(`http://127.0.0.1:${CDP}/json/list`).then(r => r.json()).then(t => { const p = t.filter(x => x.type === 'page'); return p.length ? p : null }))
  if (!targets) { console.log('chrome down'); process.exit(1) }

  const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
  await new Promise(r => ws.addEventListener('open', r))
  let id = 0
  const send = (method, params = {}) => new Promise(res => {
    const mine = ++id
    const on = e => { const m = JSON.parse(e.data); if (m.id === mine) { ws.removeEventListener('message', on); res(m.result) } }
    ws.addEventListener('message', on); ws.send(JSON.stringify({ id: mine, method, params }))
  })
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    return r?.result?.value
  }

  await send('Page.enable')
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  // studio fills #tableList from an async /api/info — wait for the rows, not load
  const n = await waitFor(async () => {
    const c = await evaluate(`document.querySelectorAll('#tableList .table-item').length`)
    return c > 0 ? c : null
  })
  ok('table list populated', n > 20, `${n} tables — need a big schema to reproduce`)

  const m = await evaluate(`(() => {
    const list = document.getElementById('tableList')
    const bar  = document.querySelector('.sidebar')
    const tools = [...document.querySelectorAll('.sidebar-label')].find(e => e.textContent.trim() === 'Tools')
    const lite  = document.getElementById('navLite')
    const r = e => { const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom } }
    return {
      listScroll: list.scrollHeight, listClient: list.clientHeight,
      overflowY: getComputedStyle(list).overflowY,
      barBottom: r(bar).bottom, vh: window.innerHeight,
      toolsBottom: tools ? r(tools).bottom : null,
      liteBottom: lite ? r(lite).bottom : null,
      scrolled: (() => { list.scrollTop = 99999; return list.scrollTop })(),
      barScrolls: bar.scrollHeight > bar.clientHeight,
      liteAfterScroll: (() => { bar.scrollTop = 99999; const b = r(lite).bottom; return b })(),
    }
  })()`)
  console.log('   ', JSON.stringify(m))

  ok('table list overflows its box', m.listScroll > m.listClient, `${m.listScroll} vs ${m.listClient}`)
  ok('table list is scrollable', m.overflowY === 'auto' || m.overflowY === 'scroll', m.overflowY)
  ok('table list actually scrolls', m.scrolled > 0, `scrollTop stayed ${m.scrolled}`)
  ok('some tables are visible', m.listClient >= 90, `list is ${m.listClient}px tall — collapsed`)
  ok('sidebar fits the viewport', m.barBottom <= m.vh + 1, `${m.barBottom} > ${m.vh}`)
  ok('Tools heading is on screen', m.toolsBottom !== null && m.toolsBottom <= m.vh, `${m.toolsBottom} vs ${m.vh}`)
  ok('last nav item reachable', m.liteAfterScroll <= m.vh + 1,
     `${m.liteAfterScroll} vs ${m.vh} after scrolling the sidebar (sidebar scrolls: ${m.barScrolls})`)
  ws.close()
} finally { studio.kill('SIGKILL'); chrome.kill('SIGKILL') }
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
