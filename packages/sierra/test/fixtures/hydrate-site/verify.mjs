/**
 * verify.mjs — prove a `hydratable: true` page is adopted as one tree.
 *
 * The 0.1 page of IDEAS/hydration.md § 2 with its assertions inverted. Under
 * islands, `Reader` read `$context.theme` as undefined and `CartA` started from
 * the store's client default while `CartB` still showed the server's 3. Here
 * the route itself runs on the client, so `Reader` has its ancestor and the
 * store holds the route's value before either cart reads it.
 *
 * The adoption check is an expando: a classic script stamps every server node
 * while the page parses, before the module entry runs. A client that replaced
 * the markup renders the same text and loses the stamp, which is the
 * regression a text comparison cannot see.
 *
 * Usage, from the sierra package root:
 *
 *   npx vite build --config test/fixtures/hydrate-site/vite.config.js
 *   node test/fixtures/hydrate-site/verify.mjs
 *
 * Needs Chrome on PATH (or $FRONTIER_CHROME).
 */

import { createServer } from 'node:http'
import { readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { findChrome } from '../../../../mesa/src/drive.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, 'dist/client')

// The carry-over warning (FJS-D2285) is printed by the build, so `--build`
// runs the build here and keeps what it printed.
let buildLog = null
if (process.argv.includes('--build')) {
  const pkg = join(HERE, '../../..')
  const run = spawnSync(join(pkg, 'node_modules/.bin/vite'), ['build', '--config', join(HERE, 'vite.config.js')], { cwd: pkg, encoding: 'utf8' })
  buildLog = `${run.stdout ?? ''}${run.stderr ?? ''}`
  process.stdout.write(buildLog)
  if (run.status !== 0) { console.error('\nthe hydrate-site build failed'); process.exit(1) }
}

const CHROME = findChrome()
if (!CHROME) { console.error('No Chrome on this machine — install Chrome or Chromium, or point $FRONTIER_CHROME at a binary'); process.exit(1) }
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`No build at ${DIST}.\nRun: npx vite build --config test/fixtures/hydrate-site/vite.config.js`)
  process.exit(1)
}

const GREETING = 'hello </script><!-- \u2028 \u2029 & done'
const IDS = ['shell', 'main', 'greeting', 'reader', 'quote', 'cart-a', 'cart-b']

// Classic, in <head>: it must be installed before the entry logs anything.
const HOOK = `<script>
  window.__log = [];
  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...a) => { window.__log.push(level + ': ' + a.map(String).join(' ')); orig(...a); };
  }
  window.addEventListener('error', (e) => window.__log.push('uncaught: ' + e.message));
  window.__fetches = [];
  const fetch0 = window.fetch.bind(window);
  window.fetch = (input, init) => { window.__fetches.push(String(input?.url ?? input)); return fetch0(input, init); };
</script>`

// Classic, at the end of <body>: it runs while the page parses, so it stamps
// the server's nodes before any module script can touch them.
const STAMP = `<script>
  for (const id of ${JSON.stringify(IDS)}) { const el = document.getElementById(id); if (el) el.__server = true; }
</script>`

// A module, so it runs after the entry, which is ahead of it in the document.
const PROBE = `
(async () => {
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (id) => $(id)?.textContent ?? null;
  await sleep(50);
  const out = {
    theme: text('reader'),
    greeting: text('greeting'),
    published: window.__published instanceof Date ? window.__published.toISOString() : typeof window.__published,
    start: [text('cart-a'), text('cart-b')],
    quote: text('quote'),
    fetches: [...window.__fetches],
    replaced: ${JSON.stringify(IDS)}.filter((id) => !$(id) || $(id).__server !== true),
  };
  $('cart-a').click();
  await sleep(50);
  out.afterA = [text('cart-a'), text('cart-b')];
  $('cart-b').click();
  await sleep(50);
  out.afterB = [text('cart-a'), text('cart-b')];
  out.entries = performance.getEntriesByType('resource')
    .map((e) => new URL(e.name).pathname).filter((p) => /\\/assets\\/hydrate-route-/.test(p));
  out.log = window.__log;
  document.title = 'RESULT' + JSON.stringify(out);
})();
`

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0])
  if (p.endsWith('/')) p += 'index.html'
  try {
    const body = await readFile(join(DIST, p))
    res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404); res.end('not found')
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const html = await readFile(join(DIST, 'index.html'), 'utf8')
const probeFile = join(DIST, '__verify_probe.html')
await writeFile(probeFile, html
  .replace('<head>', `<head>${HOOK}`)
  .replace('</body>', `${STAMP}<script type="module">${PROBE}</script></body>`))

let dom = ''
try {
  const chrome = spawn(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=20000',
    '--dump-dom', `http://127.0.0.1:${port}/__verify_probe.html`,
  ])
  chrome.stdout.on('data', (d) => { dom += d })
  chrome.on('error', (e) => { console.error(`Could not launch ${CHROME}: ${e.message}`); process.exit(1) })
  await new Promise((r) => chrome.on('close', r))
} finally {
  server.close()
  await rm(probeFile, { force: true })
}

const match = dom.match(/<title>RESULT(.*?)<\/title>/s)
if (!match) {
  console.error('The probe never reported. First 1500 chars of the DOM:\n' + dom.slice(0, 1500))
  process.exit(1)
}
// The title is serialized as HTML text, so its JSON comes back entity-escaped.
const got = JSON.parse(match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'))

const failures = []
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

check(got.theme === 'theme: dark', 'Reader reads the route\'s $context after adoption', JSON.stringify(got.theme))
check(got.greeting === GREETING, 'load() data reaches the client as written', JSON.stringify(got.greeting))
check(got.published === '2026-11-21T15:04:00.000Z', 'a Date from load() reaches the route as a Date', JSON.stringify(got.published))
check(got.start[0] === 'A: 3' && got.start[1] === 'B: 3', 'both carts start from the value the route wrote from load(), before either is written', JSON.stringify(got.start))
check(got.quote === 'quote from the server', 'the {#await} shows the server\'s settled value', JSON.stringify(got.quote))
check(got.fetches.length === 0, 'the {#await} makes no request on load: its value came in the page', JSON.stringify(got.fetches))
check(got.replaced.length === 0, 'the server\'s nodes are adopted, not replaced', `replaced: ${got.replaced.join(', ')}`)
check(got.afterA[0] === 'A: 4' && got.afterA[1] === 'B: 4', 'a click in A reaches B', JSON.stringify(got.afterA))
check(got.afterB[0] === 'A: 5' && got.afterB[1] === 'B: 5', 'a click in B reaches A', JSON.stringify(got.afterB))
check(got.entries.length === 1, 'exactly one route entry loads', JSON.stringify(got.entries))
check(got.log.length === 0, 'no warning or error on the console (no hydration mismatch)', got.log.join(' | '))

// What the build emitted, read off disk.
const pages = { index: html, about: await readFile(join(DIST, 'about/index.html'), 'utf8') }
const entryOf = (page) => [...page.matchAll(/<script type="module" src="([^"]+)"/g)].map((m) => m[1])
check(entryOf(pages.index).length === 1 && entryOf(pages.about).length === 1, 'each page names one module script',
  JSON.stringify({ index: entryOf(pages.index), about: entryOf(pages.about) }))
check(entryOf(pages.index)[0] !== entryOf(pages.about)[0], 'each route has its own entry', entryOf(pages.index)[0])
const assets = await readdir(join(DIST, 'assets'))
const withStore = []
for (const f of assets.filter((f) => f.endsWith('.js'))) {
  if (/count:\s*0/.test(await readFile(join(DIST, 'assets', f), 'utf8'))) withStore.push(f)
}
check(withStore.length === 1, 'the cart store is one shared chunk', JSON.stringify(withStore))

if (buildLog !== null) {
  const carried = buildLog.split('\n').filter((l) => l.includes("hydratable: store 'cart'"))
  check(carried.some((l) => l.includes("store 'cart' starts page /about/ holding a value page / wrote")),
    'the build warns that /about/ starts holding the cart / wrote', carried.join(' | ') || 'no warning printed')
  check(!carried.some((l) => l.includes('page /plain/')), 'a page that does not watch the cart is not warned about', carried.join(' | '))
} else check(false, 'the carry-over warning is checked', 'run with --build so the build output can be read')

if (failures.length) {
  console.error(`\n${failures.length} hydration check(s) failed`)
  process.exit(1)
}
console.log('\nhydration verified in a real browser')
