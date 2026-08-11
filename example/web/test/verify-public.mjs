/**
 * web/test/verify-public.mjs — the PRERENDERED drive.
 *
 * The other five drives all test the SPA: a page whose every byte arrives from
 * JavaScript. This one tests the opposite half — `bun run build:public` emits
 * `web/dist/public/catalog/index.html`, a file with the whole catalogue already
 * in it and no application in sight, and the claim under test is that two
 * components inside that file come alive when a browser parses it.
 *
 * That claim cannot be settled by a unit test. It needs the HTML parser's
 * treatment of comment markers, a module script actually executing, one dynamic
 * import per island, event delegation registered by mount(), and — for the
 * second island — a real request to the running API. So this serves the built
 * directory and drives it over CDP.
 *
 * The specific failure it exists to catch is silent: an island that renders
 * perfect markup and never mounts looks exactly like a working page until
 * somebody types in the search box. So every assertion here is an interaction
 * or a network fact, never a snapshot.
 *
 *   bun run api            # terminal 1 — LiveStock talks to it
 *   bun run build:public
 *   bun run verify:public
 *
 * Needs Chrome on PATH or $FJS_CHROME. This drive signs in NOWHERE: the page is
 * public, so it costs nothing against the login limiter.
 *
 * The same harness traps as verify.mjs apply — never return a bare `null` from
 * a probe (CDP drops it), and never start an evaluated expression with a bare
 * `return` on its own line.
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE   = dirname(fileURLToPath(import.meta.url))
const DIST   = join(HERE, '..', 'dist', 'public')
const API    = process.env.API_URL ?? 'http://localhost:8110'
const PORT   = Number(process.env.PUBLIC_PORT ?? 5320)
const ORIGIN = `http://localhost:${PORT}`
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain',
  '.xml': 'application/xml',
}

// ─── preflight ────────────────────────────────────────────────────────────
if (!existsSync(join(DIST, 'catalog', 'index.html'))) {
  console.error(`No build at ${DIST}.\nRun: bun run build:public`)
  process.exit(1)
}
try {
  const r = await fetch(`${API}/health`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
} catch (e) {
  console.error(`Cannot reach the API at ${API} — is \`bun run api\` up? (${e.message})`)
  process.exit(1)
}

// ─── the server ───────────────────────────────────────────────────────────
// No SPA fallback on purpose: a static site has no router, so a missing file is
// a 404 and pretending otherwise would hide a page that failed to emit. `/api`
// is proxied because one of the two islands is supposed to reach the shop.
const server = createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN)

  if (url.pathname.startsWith('/api')) {
    try {
      const upstream = await fetch(API + url.pathname + url.search, {
        method: req.method,
        headers: { ...req.headers, host: new URL(API).host },
      })
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      res.end(Buffer.from(await upstream.arrayBuffer()))
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`cannot reach the API at ${API}: ${e.message}`)
    }
    return
  }

  let p = url.pathname
  if (p.endsWith('/')) p += 'index.html'
  try {
    const body = await readFile(join(DIST, p))
    res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end(`${p} is not in the build`)
  }
})
await new Promise((r) => server.listen(PORT, r))

// ─── what shipped, before a browser touches it ────────────────────────────
// Read as a crawler reads it: one fetch, no JavaScript. Everything here is a
// statement about the FILE, and it is checked first because a page that is
// wrong on disk cannot be made right by hydration.
const rawHTML = await fetch(`${ORIGIN}/catalog/`).then((r) => r.text())

const got = {}
const t = (label, value) => { got[label] = value }

t('raw.productNames', ['Canvas Tote', 'Enamel Mug', 'Field Notebook']
  .every((n) => rawHTML.includes(n)))
t('raw.islands', [...rawHTML.matchAll(/<!--mesa-island (\{.*?\})-->/g)]
  .map((m) => JSON.parse(m[1].replace(/\\u002d/g, '-').replace(/\\u003e/g, '>')))
  .map((i) => `${i.component}:${i.directive}`))
t('raw.scriptTags', [...rawHTML.matchAll(/<script\b[^>]*>/g)].length)
t('raw.onlyScriptIsIslands', /<script type="module" src="\/assets\/islands-[^"]+\.js"><\/script>/.test(rawHTML))
// The catalogue is baked in; nothing gated is. `Customer.notes` is @allow'd to
// admins and every seeded customer has an @shop.test address — neither may
// appear in a file a CDN will hand to anyone.
t('raw.noGatedData', !/@shop\.test|"notes"|correct-horse/.test(rawHTML))
// A prerendered page is the app, not a fragment of it: the design system the
// SPA links from index.html has to reach it too, and the theme is a class on
// <body>. Until 2026-08-06 neither did — the page shipped every
// @frontierjs/css class name and not one rule behind them.
t('raw.stylesheet', /<link rel="stylesheet" href="\/assets\/[^"]+\.css">/.test(rawHTML))
t('raw.bodyClass', (rawHTML.match(/<body class="([^"]*)"/) ?? [])[1])

// ─── CDP ──────────────────────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'fjs-public-'))
const chrome  = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })

chrome.on('error', (e) => { console.error(`Could not launch ${CHROME}: ${e.message}`); process.exit(1) })

const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''
  const timer = setTimeout(() => reject(new Error('Chrome never announced a DevTools port')), 15000)
  chrome.stderr.on('data', (d) => {
    buf += d
    const m = buf.match(/ws:\/\/[^\s]+/)
    if (m) { clearTimeout(timer); resolve(m[0]) }
  })
})

const browser = new WebSocket(wsUrl)
await new Promise((r) => browser.addEventListener('open', r, { once: true }))

let nextId = 1
const pending = new Map()
const consoleErrors = []

function send(socket, method, params = {}, sessionId) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => pending.has(id) && reject(new Error(`${method} timed out`)), 30000)
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
    consoleErrors.push('exception: ' + (msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text))
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type))
    consoleErrors.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
})

const { targetId }  = await send(browser, 'Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send(browser, 'Target.attachToTarget', { targetId, flatten: true })
const cmd = (method, params) => send(browser, method, params, sessionId)

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

let failed = 0
try {
  await cmd('Page.navigate', { url: `${ORIGIN}/catalog/` })
  await evaluate(`
    if (document.readyState !== 'complete')
      await new Promise(r => window.addEventListener('load', r, { once: true }));
    window.sleep = ms => new Promise(r => setTimeout(r, ms));
    window.waitFor = async (fn, ms = 8000) => {
      const t0 = Date.now();
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error('waitFor timed out: ' + fn);
        await sleep(40);
      }
    };
    // Mounting REPLACES the prerendered markup, so element identity changing is
    // the precise signal that an island went live. A sleep is not: the mount is
    // a dynamic import, and an early interaction lands on inert markup and
    // reads as a product failure.
    window.__before = { search: document.getElementById('catalog-search'), stock: document.getElementById('live-stock') };
    window.chunks = () => performance.getEntriesByType('resource')
      .map(e => (e.name.match(/island-([A-Za-z0-9]+)-/) || [])[1]).filter(Boolean).sort();
    window.apiCalls = () => performance.getEntriesByType('resource')
      .filter(e => e.name.includes('/api/')).map(e => new URL(e.name).pathname);
    return true;
  `)

  // 1 ─ the list island comes alive
  t('list.wentLive', await evaluate(`
    await waitFor(() => document.getElementById('catalog-search') !== __before.search);
    return true;
  `))

  // 2 ─ and it is interactive: typing filters rows that were baked into the file
  t('filter.mug', await evaluate(`
    const box = document.getElementById('catalog-search');
    box.value = 'mug';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => document.querySelectorAll('#catalog-list li').length === 1);
    return {
      count: document.getElementById('catalog-count').textContent.trim().replace(/\\s+/g, ' '),
      skus:  [...document.querySelectorAll('#catalog-list li')].map(li => li.dataset.sku),
    };
  `))

  // 3 ─ a search matching nothing says so, from the {#if} in the island
  t('filter.empty', await evaluate(`
    const box = document.getElementById('catalog-search');
    box.value = 'zzz';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => document.getElementById('catalog-empty'));
    return document.querySelectorAll('#catalog-list li').length;
  `))

  // 4 ─ and clearing it brings every prerendered row back
  t('filter.cleared', await evaluate(`
    const box = document.getElementById('catalog-search');
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => document.querySelectorAll('#catalog-list li').length === 4);
    return document.getElementById('catalog-count').textContent.trim().replace(/\\s+/g, ' ');
  `))

  // 5 ─ the list island made no request. Its data was read at BUILD time,
  //     through the app's own Litestone client, and checked against @@gate
  //     before the page was allowed to exist.
  t('list.madeNoRequest', await evaluate(`return apiCalls()`))

  // 6 ─ the below-the-fold island has cost nothing yet: its chunk is not
  //     downloaded, which is the whole point of declaring a directive.
  t('lazy.beforeScroll', await evaluate(`return chunks()`))

  // 7 ─ scroll it into view. This is the last thing done to the page for a
  //     reason: headless Chrome delivers IntersectionObserver records only
  //     while it has a rendering lifecycle, and asserting the resource list at
  //     the moment of the scroll is what makes the claim above survive the
  //     ordering (see packages/sierra/tests/fixtures/island-site/verify.mjs).
  t('lazy.afterScroll', await evaluate(`
    document.getElementById('live-stock').scrollIntoView();
    await waitFor(() => chunks().includes('LiveStock'), 10000);
    return chunks();
  `))

  // 8 ─ and it went live and asked the shop what can be sold today
  t('live.wentLive', await evaluate(`
    await waitFor(() => document.getElementById('live-stock') !== __before.stock);
    // The island's own three states. Waiting on the count alone turns "the API
    // said no" into a timeout, which reads as an island that never mounted.
    await waitFor(() => document.getElementById('live-stock-state')?.textContent.trim() !== 'Checking with the shop…');
    return document.getElementById('live-stock-state').textContent.trim().replace(/\\s+/g, ' ');
  `))
  t('live.count', await evaluate(`
    return Number(document.getElementById('live-stock-count').textContent.trim());
  `))
  // The prerendered list carries no prices; this one does, because it came from
  // the API rather than from the file.
  t('live.pricesFromApi', await evaluate(`
    const badges = [...document.querySelectorAll('#live-stock-list li .badge')].map(b => b.textContent.trim());
    return { count: badges.length, allNumeric: badges.every(b => b !== '' && !Number.isNaN(Number(b))) };
  `))
  t('live.calledApi', await evaluate(`return apiCalls()`))

  // 9 ─ the stylesheet is not merely linked, it applies: a token the theme
  //     class defines is what a component's colour resolves through.
  t('style.themeApplied', await evaluate(`
    const brand = getComputedStyle(document.body).getPropertyValue('--color-primary').trim();
    const badge = document.querySelector('#catalog-list .badge');
    return { brand, badgeStyled: getComputedStyle(badge).borderRadius !== '' && getComputedStyle(badge).display !== 'inline' };
  `))

  // 10 ─ the static half of the page never moved
  t('static.heading', await evaluate(`return document.querySelector('h1').textContent.trim()`))

  t('consoleErrors', consoleErrors)
} catch (err) {
  console.error(`\nDrive threw: ${err.message}`)
  failed = 1
} finally {
  chrome.kill()
  server.close()
  // Chrome is still unlinking its own profile as this runs; a failure to remove
  // a temp directory is not a failure of the app.
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}

// ─── the claims ───────────────────────────────────────────────────────────
const expected = {
  'raw.productNames':      true,
  'raw.islands':           ['CatalogList:load', 'LiveStock:visible'],
  'raw.scriptTags':        1,
  'raw.onlyScriptIsIslands': true,
  'raw.noGatedData':       true,
  'raw.stylesheet':        true,
  'raw.bodyClass':         'app theme-default',

  'list.wentLive':         true,
  'filter.mug':            { count: '1 of 4 products', skus: ['EM-002'] },
  'filter.empty':          0,
  'filter.cleared':        '4 of 4 products',
  'list.madeNoRequest':    [],

  'lazy.beforeScroll':     ['CatalogList'],
  'lazy.afterScroll':      ['CatalogList', 'LiveStock'],

  'live.wentLive':         '4 of 4 products can be ordered today.',
  'live.count':            4,
  'live.pricesFromApi':    { count: 4, allNumeric: true },
  'live.calledApi':        ['/api/products'],

  'style.themeApplied':    { brand: '#0d83dd', badgeStyled: true },
  'static.heading':        'Catalog',
  'consoleErrors':         [],
}

for (const [key, want] of Object.entries(expected)) {
  const have = got[key]
  const ok = JSON.stringify(have) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${key}`)
  if (!ok) {
    console.log(`         want ${JSON.stringify(want)}`)
    console.log(`         have ${JSON.stringify(have)}`)
  }
}

console.log(failed ? `\n${failed} assertion(s) failed` : `\nall ${Object.keys(expected).length} assertions passed`)
process.exit(failed ? 1 : 0)
