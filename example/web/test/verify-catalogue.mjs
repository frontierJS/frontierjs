/**
 * web/test/verify-catalogue.mjs — the catalogue, in a real browser.
 *
 * Started by `bun run verify:catalogue`. Unlike the other drives this one
 * starts BOTH servers itself and stops them again, because the thing it proves
 * spans them: a `File` column stores a reference in SQLite, the API serves the
 * bytes out of its own object storage, and the browser has to end up with an
 * <img> that decoded. A drive that assumed a running pair would pass against
 * whichever build those were serving.
 *
 * Two traps this file exists to stay out of:
 *
 *   · A dev server transforms a .mesa module once and caches it for the life of
 *     the process, so a compiler or component edit is invisible to a server
 *     that was already up. Both are started here, per run.
 *   · An <img> that is PRESENT is not an <img> that loaded. `naturalWidth` is 0
 *     for a broken image and the element is in the DOM either way, so every
 *     image assertion below reads naturalWidth and never querySelector alone.
 */
import { spawn, execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const API  = process.env.API_URL ?? 'http://localhost:8110'
const UI   = process.env.UI_URL  ?? 'http://localhost:8010'

const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

// ─── Servers ───────────────────────────────────────────────────────────────

const procs = []
// `detached` is what makes stopAll work. `npx vite` is a launcher: SIGTERM to
// the process this holds kills the launcher and leaves vite itself on 8010, so
// the NEXT drive refuses the port and says a dev server is running from an
// earlier run — which it is, and nothing said which run. Detached puts each
// server in its own process group, and stopAll signals the group.
function start(cmd, args, name) {
  const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stdout.on('data', () => {})
  p.stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(`[${name}] ${d}`) })
  procs.push(p)
  return p
}
const stopAll = () => {
  for (const p of procs) {
    // The GROUP, negative pid. Falls back to the process itself where the
    // group is already gone, so a second call is not an error.
    try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGTERM') } catch {} }
  }
}
process.on('exit', stopAll)
process.on('SIGINT', () => { stopAll(); process.exit(130) })

async function waitFor(url, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  console.error(`${label} never answered on ${url}`)
  return false
}

// Refuse a port that already answers rather than joining it. Vite hops to the
// next free port in silence and a dev server serves the code it STARTED with,
// so a leftover from the previous run would be tested instead of this one —
// and it would pass, against the old build.
for (const [port, what] of [[8110, 'the API'], [8010, 'the dev server']]) {
  let busy = false
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) {
    console.error(`port ${port} already answers — ${what} is still running from an earlier run.\n` +
                  `stop it first (\`bun run stop\`); this drive starts its own.`)
    process.exit(1)
  }
}

// Seeding is a step, not a boot side effect, so this drive takes it. Against an
// empty database every assertion below fails as "the row is not there", which
// reads as a regression in whatever was just changed. Idempotent — a seeded
// database costs one pass of existence checks.
execFileSync('bun', ['run', 'db/seed.ts'], { cwd: ROOT, stdio: 'ignore' })

start('bun', ['run', 'api/index.ts'], 'api')
start('npx', ['vite', '-c', 'web/config/vite.config.js'], 'web')

if (!await waitFor(`${API}/api/products`, 'api')) { stopAll(); process.exit(1) }
if (!await waitFor(UI, 'web'))                    { stopAll(); process.exit(1) }

// ─── Chrome over CDP ───────────────────────────────────────────────────────

const chrome = start(CHROME, [
  '--headless=new', '--remote-debugging-port=9222', '--disable-gpu',
  '--no-sandbox', '--window-size=1400,1000', 'about:blank',
], 'chrome')

let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const v = await (await fetch('http://localhost:9222/json/version')).json()
    wsUrl = v.webSocketDebuggerUrl
  } catch { await new Promise(r => setTimeout(r, 250)) }
}
if (!wsUrl) { console.error('chrome never came up'); stopAll(); process.exit(1) }

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
function send(method, params = {}, sessionId) {
  const id = ++msgId
  return new Promise(res => {
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params, sessionId }))
  })
}

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)

async function goto(path, waitSel, atLeast = 1) {
  await send('Page.navigate', { url: UI + path }, sessionId)
  // Settle on the CONTENT this page is about, never on a fixed sleep and never
  // on the shell. The layout's nav and heading are in `main` before a single
  // row has been fetched, so a text-length check passes while the table is
  // still empty — which is a drive that fails on a slow run and passes on a
  // fast one, in whichever assertion happened to be first.
  for (let i = 0; i < 100; i++) {
    const n = await evaluate(`document.querySelectorAll('${waitSel}').length`)
    if (n >= atLeast) return
    await new Promise(r => setTimeout(r, 150))
  }
  throw new Error(`${path}: never rendered ${atLeast}× \`${waitSel}\``)
}

async function settleImages(sel) {
  // An <img> is in the DOM the moment the row renders and has naturalWidth 0
  // until the bytes arrive. Every image assertion below reads naturalWidth, so
  // they all have to wait for this rather than for the row.
  for (let i = 0; i < 60; i++) {
    const ok = await evaluate(`(() => {
      const els = [...document.querySelectorAll('${sel}')]
      return els.length > 0 && els.every(i => i.complete && i.naturalWidth > 0)
    })()`)
    if (ok) return
    await new Promise(r => setTimeout(r, 150))
  }
}

async function evaluate(expr) {
  const { result } = await send('Runtime.evaluate', {
    expression: `(async () => (${expr}))()`,
    awaitPromise: true, returnByValue: true,
  }, sessionId)
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result?.result?.value
}

// ─── Assertions ────────────────────────────────────────────────────────────

let pass = 0, fail = 0
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else    { fail++; console.log(`  ✗ ${name}\n      got      ${JSON.stringify(actual)}\n      expected ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}`) }
}

console.log('\n  catalogue — the API')

const products = await (await fetch(`${API}/api/products?$limit=100`)).json()
const variants = await (await fetch(`${API}/api/product-variants?$limit=200`)).json()
const images   = await (await fetch(`${API}/api/product-images?$limit=100`)).json()

check('13 products seeded',        products.total, 13)
check('43 variants seeded',        variants.total, 43)
check('19 photographs seeded',     images.total,   19)
check('every image resolved to a URL', images.data.every(i => typeof i.file === 'string' && i.file.startsWith('http')), true)

// The File round trip: the ref the row carries has to be bytes the API serves.
const head = await fetch(images.data[0].file)
check('image URL serves bytes',    head.ok && head.headers.get('content-type'), 'image/png')

// The composite @@unique is the whole reason the option columns are not
// nullable — assert it holds through the API, not just in SQLite.
const dup = await fetch(`${API}/api/product-variants`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ productId: 1, sku: 'DRIVE-DUP', colour: 'Night Navy', size: 'm', price: 1 }),
})
check('anonymous variant write refused (@@gate)', dup.status, 401)

console.log('\n  catalogue — the products list')

await goto('/products/', '.product-row', 10)

// Ten rows, not thirteen: the page size is a PREFERENCE, set on /settings/ and
// defaulting to 10, so a full catalogue is two pages. The pager is what says
// all thirteen arrived.
check('one page of rows renders', await evaluate(`document.querySelectorAll('.product-row').length`), 10)
check('the pager counts all 13',
      await evaluate(`document.body.innerText.includes('13')`), true)
check('a price renders',
      await evaluate(`[...document.querySelectorAll('.product-row td')].some(td => td.textContent.includes('$'))`), true)

await settleImages('img.thumb')
check('every thumbnail decoded',
      await evaluate(`[...document.querySelectorAll('img.thumb')].filter(i => i.naturalWidth > 0).length`),
      n => n === 10)
check('a retired product is pilled',
      await evaluate(`[...document.querySelectorAll('.product-row')].some(r => r.textContent.includes('retired'))`), true)
check('an out-of-stock family is pilled',
      await evaluate(`[...document.querySelectorAll('.product-row')].some(r => r.textContent.includes('out of stock'))`), true)

console.log('\n  catalogue — one product')

await goto('/products/1/', 'table.grid tbody tr', 4)

await settleImages('img.hero, .swatch img')
check('hero photograph decoded',
      await evaluate(`(document.querySelector('img.hero')?.naturalWidth ?? 0) > 0`), true)
check('four colourway swatches',
      await evaluate(`document.querySelectorAll('.swatch').length`), 4)
check('every swatch decoded',
      await evaluate(`[...document.querySelectorAll('.swatch img')].every(i => i.naturalWidth > 0)`), true)
check('variant grid is 4 colours x 3 sizes',
      await evaluate(`[document.querySelectorAll('table.grid tbody tr').length,
                       document.querySelectorAll('table.grid thead th').length - 1]`), [4, 3])
check('sizes are in enum order, not alphabetical',
      await evaluate(`[...document.querySelectorAll('table.grid thead th')].slice(1).map(th => th.textContent.trim())`),
      ['s', 'm', 'l'])
check('the empty colourway says sold out',
      await evaluate(`[...document.querySelectorAll('table.grid tbody tr')]
        .find(r => r.textContent.includes('Olive'))?.textContent.includes('sold out')`), true)
check('twelve SKUs on screen',
      await evaluate(`[...document.querySelectorAll('table.grid tbody td')].filter(td => /FJS-TEE-/.test(td.textContent)).length`), 12)

// A swatch is a real control, not a decorated div — clicking it changes the hero.
//
// Whichever swatch is NOT already chosen. The buy box picks a colourway on
// load — the first one with stock — and it also owns the hero, so naming a
// colour here would assert nothing on the run where that colour is the
// default.
const before = await evaluate(`document.querySelector('img.hero')?.src ?? ''`)
await evaluate(`([...document.querySelectorAll('.swatch')]
  .find(b => b.getAttribute('aria-pressed') !== 'true')?.click(), true)`)
await new Promise(r => setTimeout(r, 400))
const after = await evaluate(`document.querySelector('img.hero')?.src ?? ''`)
check('clicking a swatch swaps the hero', before !== after && after.length > 0, true)

console.log(`\n  ${pass} passed, ${fail} failed\n`)
stopAll()
process.exit(fail ? 1 : 0)
