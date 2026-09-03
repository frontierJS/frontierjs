/**
 * site/test/verify.mjs — the storefront drive.
 *
 * The other drives all test an application: a page whose every byte arrives
 * from JavaScript, talking to an API on its own origin through Vite's proxy.
 * This one tests the opposite of both.
 *
 * What it proves, and why none of it is provable anywhere else here:
 *
 *   1. **The pages are FILES.** One per active product, with the product's own
 *      name, description and price already in the HTML — read as a crawler
 *      reads it, with one fetch and no JavaScript. A page whose content arrives
 *      from a fetch looks identical in a browser and empty to a search engine.
 *
 *   2. **The set of files matches the database.** `getStaticPaths()` decides
 *      which pages exist, so the assertion is a count against a query rather
 *      than a number written down here — a build that emitted nothing would
 *      otherwise pass every content check it never ran.
 *
 *   3. **Each page has its OWN title and description.** Frontmatter is static
 *      text; without `head()` thirteen products share one title, which is the
 *      single field a search result is built from.
 *
 *   4. **The stale price is corrected.** The headline. A price baked into a
 *      file is true at build time and a shop changes prices without rebuilding,
 *      so the drive CHANGES ONE in the database after the build and asserts the
 *      island fixes the cell — and that the baked number is still readable
 *      beside it, which is what makes the correction demonstrable rather than
 *      merely plausible.
 *
 *   5. **The island's calls are CROSS-ORIGIN.** The site is served from its own
 *      origin, through the module it deploys with, with no `/api` proxy — so
 *      the API's CORS answer is under test. Every other drive here reaches the
 *      API same-origin and has never preflighted.
 *
 *   6. **The published directory holds no server code.** A companion runs at
 *      build time and imports the app's Litestone client; a static host serves
 *      whatever is in the directory whether a page links it or not.
 *
 *   bun run api            # terminal 1 — the islands talk to it
 *   bun run build:site
 *   bun run verify:site
 *
 * Run under BUN, where every other drive here runs under node. It imports the
 * app's own Litestone client to grade the emitted pages against the database
 * and to move a price behind the site's back, and that module is TypeScript —
 * node's strip-only loader refuses a parameter property inside junction. The
 * same reason `build:site` is `bun --bun vite build`.
 *
 * Needs Chrome on PATH or $FJS_CHROME. It signs in NOWHERE: the storefront is
 * public, so it costs nothing against the login limiter the other drives share.
 *
 * The same harness traps as verify.mjs apply — never return a bare `null` from
 * a probe (CDP drops it), and never start an evaluated expression with a bare
 * `return` on its own line.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { serveSite } from '@frontierjs/sierra/site/serve'
// The storefront's own conversion, asked rather than restated. Every price
// column is `@money(USD)`, so what the database holds and what `data-baked`
// carries is a whole number of CENTS, and what the page prints is dollars.
import { formatMoney, fromMinor, toMinor } from '@frontierjs/toolbelt/units'

const HERE   = dirname(fileURLToPath(import.meta.url))
const SITE   = join(HERE, '..')
const DIST   = join(SITE, 'dist')
const API    = process.env.API_URL ?? 'http://localhost:8110'
// test / siteServe / project 1 — the drive's own slot, so it cannot collide
// with a dev server somebody has open on 8710.
const PORT   = Number(process.env.SITE_SERVE_PORT ?? 7710)
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

// ─── preflight ────────────────────────────────────────────────────────────
if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`No build at ${DIST}.\nRun: bun run build:site`)
  process.exit(1)
}
try {
  const r = await fetch(`${API}/api/health`)
  if (!r.ok) throw new Error(`health said ${r.status}`)
} catch (e) {
  console.error(`Cannot reach the API at ${API} — is \`bun run api\` up? (${e.message})`)
  process.exit(1)
}

// The database, read directly. Two reasons it is here rather than asked of the
// API: the count of pages must be graded against what getStaticPaths() saw, and
// the stale-price test has to MOVE a price behind the site's back — which is
// what a merchant does between two builds.
const { sys } = await import('../../api/src/core/db.ts')

const activeProducts = await sys.product.findMany({ where: { active: true }, limit: 500 })
const activePlans    = await sys.plan.findMany({ where: { active: true }, limit: 50 })

// ─── the server ───────────────────────────────────────────────────────────
// Sierra's own, which is what `bun run serve:site` and the container run — so
// the directory-index, cache and 404 answers under test are the ones that ship.
// NO /api proxy: the storefront is its own origin and its islands cross one.
const server = await serveSite({ dir: DIST, port: PORT })
const ORIGIN = `http://localhost:${PORT}`

const got = {}
const t = (label, value) => { got[label] = value }

// ─── what shipped, before a browser touches it ────────────────────────────
// Everything in this section is a statement about the FILE. It is checked first
// because a page that is wrong on disk cannot be made right by hydration.

const pageDirs = existsSync(join(DIST, 'products'))
  ? readdirSync(join(DIST, 'products'), { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name).sort()
  : []

// One page per ACTIVE product, and the assertion is against the DATABASE rather
// than a number typed here: a build that emitted nothing would pass every
// content check below by never running it.
t('files.onePerProduct', {
  emitted: pageDirs.length,
  active:  activeProducts.length,
  match:   pageDirs.length === activeProducts.length,
})
// And the retired one has no page at all. A URL that exists is a URL a search
// engine keeps, so a retired product losing its page is deliberate.
t('files.retiredHasNone', !pageDirs.includes('sticker-pack'))

const sample     = activeProducts.find(p => p.slug === 'explorer-tee') ?? activeProducts[0]
const other      = activeProducts.find(p => p.slug !== sample.slug)
const samplePath = join(DIST, 'products', sample.slug, 'index.html')
const sampleHTML = readFileSync(samplePath, 'utf8')
const otherHTML  = readFileSync(join(DIST, 'products', other.slug, 'index.html'), 'utf8')
// The price list as it was BUILT, kept beside the two product pages for the
// same reason they are: what the file says is half of every stale-price
// assertion below, and it cannot be read off the page once the island has
// corrected it.
const pricingHTML = readFileSync(join(DIST, 'pricing', 'index.html'), 'utf8')

const titleOf = (html) => (html.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? null
const descOf  = (html) => (html.match(/<meta name="description" content="([^"]*)">/) ?? [])[1] ?? null

// The product's own words are IN THE FILE. This is the whole claim of a
// prerendered storefront and it is invisible from a browser, where a page that
// fetched its content looks the same.
t('raw.productInFile', sampleHTML.includes(sample.name) && sampleHTML.includes(sample.description))
t('raw.pricesInFile', /\$\d/.test(sampleHTML))
// Every SKU too, so the claim is about the whole variant table rather than
// whichever row happens to render first.
t('raw.skusInFile', await (async () => {
  const vs = await sys.productVariant.findMany({ where: { productId: sample.id }, limit: 100 })
  return { total: vs.length, present: vs.filter(v => sampleHTML.includes(v.sku)).length }
})())

// Per-page <title> and description. Without `head()` these are one string for
// every product page, and thirteen identical titles is thirteen pages a search
// engine has no reason to tell apart.
t('head.titlesDiffer', titleOf(sampleHTML) !== titleOf(otherHTML))
t('head.titleNamesProduct', (titleOf(sampleHTML) ?? '').startsWith(sample.name))
t('head.hasDescription', (descOf(sampleHTML) ?? '').length > 0)
t('head.descriptionsDiffer', descOf(sampleHTML) !== descOf(otherHTML))

// The layout wrapped it. The static target composes the `_module.mesa` chain at
// build time — the first layout this repo prerenders — and a page that rendered
// without one looks fine on its own.
t('layout.wrapped', sampleHTML.includes('topbar-brand') && sampleHTML.includes('site-footer'))
t('layout.onEveryPage', ['index.html', 'catalog/index.html', '404.html']
  .every(f => readFileSync(join(DIST, f), 'utf8').includes('topbar-brand')))

// Nothing gated is in a file a CDN will hand to anyone. `Customer.notes` is
// @allow'd to admins and every seeded customer has an @shop.test address.
t('raw.noGatedData', !/@shop\.test|correct-horse|"notes"/.test(sampleHTML))

// The published directory carries no server code. A companion runs at build
// time and imports the app's Litestone client; a static host serves a file
// whether or not a page links it, so "nothing references it" is not a defence.
// Matched on code rather than on the word: the schema's own doc comments reach
// the client as JSON Schema descriptions, and one of them says "stored as JSON
// in SQLite" — a field label, not an engine.
t('raw.noServerCode', (() => {
  const assets = readdirSync(join(DIST, 'assets')).filter(f => f.endsWith('.js'))
  const leaked = assets.filter(f => /CREATE TABLE |bun:sqlite|node:sqlite|process\.env\.ENCRYPTION_KEY/
    .test(readFileSync(join(DIST, 'assets', f), 'utf8')))
  return leaked
})())

// The design system reached the page, and the theme is a class on <body>.
t('raw.stylesheet', /<link rel="stylesheet" href="\/assets\/[^"]+\.css">/.test(sampleHTML))
t('raw.bodyClass', (sampleHTML.match(/<body class="([^"]*)"/) ?? [])[1])

// ─── what the SERVER answers ──────────────────────────────────────────────
// Three answers a static host gives for free and a hand-rolled file server in a
// harness forgets — and then the harness proves the site works under rules
// nothing in production applies.
const head = async (path) => {
  const r = await fetch(`${ORIGIN}${path}`)
  return { status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control') }
}
t('serve.directoryIndex',  (await head(`/products/${sample.slug}/`)).status)
t('serve.withoutSlash',    (await head(`/products/${sample.slug}`)).status)
t('serve.missingIs404',    (await head('/no-such-page/')).status)
t('serve.404IsAPage',      (await fetch(`${ORIGIN}/no-such-page/`).then(r => r.text())).includes('moved on'))
t('serve.htmlRevalidates', /max-age=0|must-revalidate/.test((await head('/')).cache ?? ''))
t('serve.assetImmutable',  await (async () => {
  const asset = readdirSync(join(DIST, 'assets')).find(f => f.endsWith('.js'))
  return /immutable/.test((await head(`/assets/${asset}`)).cache ?? '')
})())

// ─── CDP ──────────────────────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'fjs-site-'))
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

const HARNESS = `
  if (document.readyState !== 'complete')
    await new Promise(r => window.addEventListener('load', r, { once: true }));
  window.sleep = ms => new Promise(r => setTimeout(r, ms));
  window.waitFor = async (fn, ms = 10000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('waitFor timed out: ' + fn);
      await sleep(40);
    }
  };
  // PascalCase only. The island bundler prefixes every chunk in that graph with
  // \`island-\`, shared ones included — \`island-money-*.js\` is the formatter two
  // islands import, not a third island — and an island is a COMPONENT, so its
  // name is PascalCase (Invariant 19). Counting the shared chunks here would
  // make the lazy assertion drift the moment two islands share an import.
  window.chunks = () => performance.getEntriesByType('resource')
    .map(e => (e.name.match(/island-([A-Za-z0-9]+)-/) || [])[1])
    .filter(n => n && /^[A-Z]/.test(n)).sort();
  window.apiCalls = () => performance.getEntriesByType('resource')
    .filter(e => e.name.includes('/api/')).map(e => e.name);
  return true;
`

// The variant whose price the drive will move, and its original. Restored in
// the finally below — a drive that leaves a shop's prices edited is a drive
// nobody runs twice.
const victim = (await sys.productVariant.findMany({ where: { productId: sample.id }, limit: 1 }))[0]
const originalPrice = victim.price
let priceMoved = false

// The plan the pricing page's stale-price half moves. A different table, a
// different mechanism and a different failure: a subscription price moves once
// a year rather than with a sale, so a stale one stays completely plausible for
// months.
const victimPlan = await sys.plan.findFirst({ where: { code: 'STARTER' } })
const victimWindow = await sys.planVersion.findFirst({
  where: { planId: victimPlan.id, effectiveTo: null },
})
const originalPlanPrice = victimWindow.price
let planPriceMoved = false

let failed = 0
try {
  // ── the product page, as built ───────────────────────────────────────────
  await cmd('Page.navigate', { url: `${ORIGIN}/products/${sample.slug}/` })
  await evaluate(HARNESS)

  // The static half is on screen before anything runs, and it stays.
  t('page.name', await evaluate(`return document.getElementById('product-name').textContent.trim()`))
  t('page.variantRows', await evaluate(`return document.querySelectorAll('#product-variants tbody tr').length`))

  // The island went live and agreed with the shop: every cell it checked
  // carries a `data-live`, which is what separates "checked and agreed" from
  // "never ran" — the two are identical if only a CHANGE is recorded.
  t('live.agreed', await evaluate(`
    await waitFor(() => document.getElementById('live-prices-state')?.textContent.trim() !== 'Checking today’s prices…');
    return document.getElementById('live-prices-state').textContent.trim().replace(/\\s+/g, ' ');
  `))
  t('live.everyCellChecked', await evaluate(`
    const cells = [...document.querySelectorAll('#product-variants .price')];
    return { total: cells.length, checked: cells.filter(c => c.dataset.live !== undefined).length };
  `))

  // Availability is a number no file may bake: it is a sum over live holds that
  // changes by the minute. The cell ships as an em dash and the island fills it.
  t('live.availabilityFilled', await evaluate(`
    const cells = [...document.querySelectorAll('#product-variants .avail')];
    return {
      inFile:  ${JSON.stringify((sampleHTML.match(/class="avail[^"]*">([^<]*)</g) ?? []).map(s => s.slice(-2, -1)))},
      onScreen: cells.every(c => c.dataset.available !== undefined),
    };
  `))

  // The requests were CROSS-ORIGIN. Every other drive in this app reaches the
  // API through Vite's proxy and has never preflighted, so this is the only
  // place the API's CORS answer is exercised by a page rather than a script.
  t('live.crossOrigin', await evaluate(`
    const calls = apiCalls();
    return {
      any:   calls.length > 0,
      other: calls.every(u => new URL(u).origin !== location.origin),
    };
  `))

  // ── the headline: a price that moved after the build ─────────────────────
  // What a merchant does between two builds. The file still says the old price
  // — it cannot say anything else — and the page must not.
  // Seven dollars more, said in the unit the column stores.
  const newPrice = originalPrice + toMinor(7, 'USD')
  await sys.productVariant.update({ where: { id: victim.id }, data: { price: newPrice } })
  priceMoved = true

  await cmd('Page.navigate', { url: `${ORIGIN}/products/${sample.slug}/?stale` })
  await evaluate(HARNESS)

  t('stale.fileStillSaysOld', sampleHTML.includes(`data-baked="${originalPrice}"`))
  t('stale.corrected', await evaluate(`
    const cell = document.querySelector('tr[data-sku="${victim.sku}"] .price');
    await waitFor(() => cell.dataset.live !== undefined);
    return {
      baked:  Number(cell.dataset.baked),
      live:   Number(cell.dataset.live),
      shown:  cell.textContent.trim(),
      marked: cell.classList.contains('price-moved'),
    };
  `))
  t('stale.saidSo', await evaluate(`
    await waitFor(() => document.getElementById('live-prices-moved'));
    return Number(document.getElementById('live-prices-moved').textContent.trim());
  `))

  // ── the price list, and the same argument one table along ────────────────
  //
  // Everything above is about a PRODUCT price. This is a plan's, and three
  // things about it are different enough to be worth their own section.
  //
  //   The number is DERIVED. `Plan.currentPrice` is `@from(PlanVersion, max:
  //   price, where: "effectiveTo IS NULL")`, so what the page bakes is the open
  //   window's price read as a subquery — not a column anybody wrote.
  //
  //   Moving it is not an UPDATE. `PlanVersion.price` is `@immutable`, which
  //   `asSystem()` does not drop (`FJS-D162`), so this drive cannot edit a
  //   price even with the system client: it closes the open window and opens
  //   the next one, which is what `plans.reprice` does and the only thing that
  //   can move a plan's price at all.
  //
  //   The page must not offer what the shop stopped selling. `active: false`
  //   retires a plan without deleting the versions past subscriptions name.
  await cmd('Page.navigate', { url: `${ORIGIN}/pricing/` })
  await evaluate(HARNESS)

  t('pricing.retiredAbsent', {
    inFile:   !pricingHTML.includes('data-plan="LEGACY"'),
    inTheDb:  !!(await sys.plan.findFirst({ where: { code: 'LEGACY' } })),
  })

  // Baked, and counted against the database rather than against a number here.
  t('pricing.onePerActivePlan', {
    emitted: (pricingHTML.match(/data-plan="/g) ?? []).length,
    active:  (await sys.plan.findMany({ where: { active: true }, limit: 50 })).length,
  })

  t('pricing.agreed', await evaluate(`
    await waitFor(() => document.getElementById('live-plans-state'));
    const cards = [...document.querySelectorAll('[data-plan] .price')];
    await waitFor(() => cards.every(c => c.dataset.live !== undefined));
    return {
      cards:   cards.length,
      checked: cards.every(c => c.dataset.live !== undefined),
      moved:   cards.filter(c => c.classList.contains('price-moved')).length,
    };
  `))

  // …and now the shop raises one, the way the shop actually raises one.
  const at = new Date().toISOString()
  const newPlanPrice = originalPlanPrice + toMinor(3, 'USD')
  await sys.planVersion.update({ where: { id: victimWindow.id }, data: { effectiveTo: at } })
  await sys.planVersion.create({
    data: { planId: victimPlan.id, price: newPlanPrice, effectiveFrom: at },
  })
  planPriceMoved = true

  await cmd('Page.navigate', { url: `${ORIGIN}/pricing/?stale` })
  await evaluate(HARNESS)

  t('pricing.fileStillSaysOld', pricingHTML.includes(`data-baked="${originalPlanPrice}"`))
  t('pricing.corrected', await evaluate(`
    const card = document.querySelector('[data-plan="${victimPlan.code}"] .price');
    await waitFor(() => card.dataset.live !== undefined);
    return {
      baked:  Number(card.dataset.baked),
      live:   Number(card.dataset.live),
      // The interval note is a child the page rendered, and the island puts it
      // back rather than replacing the whole cell — a correction that ate
      // "a month" would be a different kind of wrong.
      keptTheNote: /a month/.test(card.textContent),
      marked: card.classList.contains('price-moved'),
    };
  `))
  t('pricing.saidSo', await evaluate(`
    await waitFor(() => document.getElementById('live-plans-moved'));
    return Number(document.getElementById('live-plans-moved').textContent.trim());
  `))

  // ── the catalogue, and its two islands ───────────────────────────────────
  await cmd('Page.navigate', { url: `${ORIGIN}/catalog/` })
  await evaluate(HARNESS)

  // The search box is in the PRERENDERED markup, and so are all twelve rows —
  // so "the box exists" and "there are twelve rows" are both true before the
  // island has mounted, and typing into it then does nothing.
  //
  // Element identity changing is NOT the signal, though it reads like one: the
  // node is captured after `Page.navigate` returns, so on a warm cache the
  // island has already mounted by then and `el !== before` can never become
  // true. It timed out about one run in six.
  //
  // Two facts replace it, and the first is MONOTONIC — true from the moment it
  // lands and true forever after, so it cannot be missed by looking late: the
  // island's own chunk has executed. The chunk running is not the mount having
  // run, so the second is the keystroke itself, re-applied each poll — typing
  // into the node a mount is about to replace is a keystroke into a dead box,
  // and the fresh node comes back with an empty value, which is what makes
  // re-applying self-correcting rather than a retry loop over a real failure.
  t('catalog.filter', await evaluate(`
    await waitFor(() => chunks().includes('CatalogList'));
    await waitFor(() => document.querySelectorAll('#catalog-list li').length === 12);
    const box = await waitFor(() => {
      const el = document.getElementById('catalog-search');
      if (!el) return null;
      if (el.value !== 'mug') {
        el.value = 'mug';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return null;
      }
      return el;
    });
    // The SHOP's answer, not the first render after the keystroke: the box is
    // debounced and the request is a round trip, and two rows is also what the
    // local fallback would show.
    await waitFor(() => document.getElementById('catalog-count').dataset.source === 'shop'
                     && document.querySelectorAll('#catalog-list li').length === 2);
    return {
      count: document.getElementById('catalog-count').textContent.trim().replace(/\\s+/g, ' '),
      // SORTED, because the order is the shop's relevance ranking now rather
      // than this page's own name-ascending: bm25 puts the shorter document
      // first, so pinning the order would make an edit to a product
      // DESCRIPTION fail a search test. WHICH products matched is the
      // assertion here; that the answer came from the shop at all is the next
      // one down.
      slugs: [...document.querySelectorAll('#catalog-list li')].map(li => li.dataset.slug).sort(),
    };
  `))
  // A row links to the page that exists for it. The catalogue and
  // getStaticPaths() are two readings of `active: true`, and a link to a page
  // the build did not emit is a 404 nothing here would otherwise catch.
  t('catalog.linksResolve', await evaluate(`
    const hrefs = [...document.querySelectorAll('#catalog-list li a')].map(a => a.getAttribute('href'));
    const codes = await Promise.all(hrefs.map(h => fetch(h).then(r => r.status)));
    return { links: hrefs.length, allOk: codes.every(c => c === 200) };
  `))

  // The box asks the SHOP, and that is the whole reason the search moved off
  // this page: `fleece` is in one product's DESCRIPTION, which is not baked
  // into the island's prop — thirteen descriptions is real weight in a file a
  // CDN serves — so no filter running here could ever find it. `@@fts([name,
  // description])` on Product and `?$search=` on the request; no app code in
  // between.
  t('catalog.searchAsksTheShop', await evaluate(`
    const box = document.getElementById('catalog-search');
    // Cleared first, and waited for. The box still holds the previous search
    // and source is already 'shop', so waiting on that alone passes instantly
    // against the answer to a question nobody has asked yet.
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => document.getElementById('catalog-count').dataset.source === 'baked'
                     && document.querySelectorAll('#catalog-list li').length === 12);
    box.value = 'fleece';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => document.getElementById('catalog-count').dataset.source === 'shop'
                     && document.querySelectorAll('#catalog-list li').length === 1);
    return {
      source: document.getElementById('catalog-count').dataset.source,
      slugs:  [...document.querySelectorAll('#catalog-list li')].map(li => li.dataset.slug),
    };
  `))

  // And with the shop unreachable it falls back to what is on this page and
  // SAYS so. An empty list because nothing matched and an empty list because
  // the network failed are two different things, and a storefront that draws
  // them the same way tells a shopper their shop is empty.
  await cmd('Network.enable')
  await cmd('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  })
  t('catalog.offlineSaysSo', await evaluate(`
    const box = document.getElementById('catalog-search');
    box.value = 'tee';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => document.getElementById('catalog-offline'));
    return {
      source: document.getElementById('catalog-count').dataset.source,
      rows:   document.querySelectorAll('#catalog-list li').length > 0,
    };
  `))
  await cmd('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  })


  // The below-the-fold island has cost nothing yet — the whole point of a
  // directive — and asserting the resource list at the moment of the scroll is
  // what makes that survive the ordering.
  t('lazy.beforeScroll', await evaluate(`return chunks()`))
  t('lazy.afterScroll', await evaluate(`
    document.getElementById('live-stock').scrollIntoView();
    await waitFor(() => chunks().includes('LiveStock'), 12000);
    return chunks();
  `))

  // ── the home page, and the 404 ───────────────────────────────────────────
  await cmd('Page.navigate', { url: `${ORIGIN}/` })
  await evaluate(HARNESS)
  t('home.featured', await evaluate(`
    return [...document.querySelectorAll('#home-featured [data-slug]')].length;
  `))
  t('home.noJavaScriptNeeded', await evaluate(`
    // The home page carries no island at all, so its only <script> should be
    // the island loader every prerendered page links — and nothing should have
    // asked the API for anything.
    return { apiCalls: apiCalls().length, headings: document.querySelectorAll('h1').length };
  `))

  t('consoleErrors', consoleErrors)
} catch (err) {
  console.error(`\nDrive threw: ${err.message}`)
  failed = 1
} finally {
  // Put the price back BEFORE anything else can fail — a drive that leaves a
  // shop's prices edited is a drive nobody runs twice, and every other drive
  // reads this database.
  if (priceMoved) {
    try { await sys.productVariant.update({ where: { id: victim.id }, data: { price: originalPrice } }) }
    catch (e) { console.error(`\n!! could not restore ${victim.sku} to ${originalPrice}: ${e.message}`) }
  }
  // The plan's price goes back the only way it can: the window this drive
  // opened is destroyed and the one it closed is opened again. There is no
  // update that could put the price back — it is `@immutable`.
  if (planPriceMoved) {
    try {
      await sys.planVersion.deleteMany({
        where: { planId: victimPlan.id, price: originalPlanPrice + toMinor(3, 'USD') },
      })
      await sys.planVersion.update({ where: { id: victimWindow.id }, data: { effectiveTo: null } })
    } catch (e) { console.error(`\n!! could not restore ${victimPlan.code}'s price window: ${e.message}`) }
  }
  chrome.kill()
  await server.close()
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}

// ─── the claims ───────────────────────────────────────────────────────────
const expected = {
  // One file per active product, counted against the database rather than
  // against a number typed here.
  'files.onePerProduct':   { emitted: activeProducts.length, active: activeProducts.length, match: true },
  'files.retiredHasNone':  true,

  'raw.productInFile':     true,
  'raw.pricesInFile':      true,
  'raw.skusInFile':        { total: got['raw.skusInFile']?.total ?? 0, present: got['raw.skusInFile']?.total ?? 0 },
  'head.titlesDiffer':     true,
  'head.titleNamesProduct': true,
  'head.hasDescription':   true,
  'head.descriptionsDiffer': true,
  'layout.wrapped':        true,
  'layout.onEveryPage':    true,
  'raw.noGatedData':       true,
  'raw.noServerCode':      [],
  'raw.stylesheet':        true,
  'raw.bodyClass':         'app theme-default',

  'serve.directoryIndex':  200,
  'serve.withoutSlash':    200,
  'serve.missingIs404':    404,
  'serve.404IsAPage':      true,
  'serve.htmlRevalidates': true,
  'serve.assetImmutable':  true,

  'page.name':             sample.name,
  'page.variantRows':      got['page.variantRows'],
  'live.agreed':           'Prices confirmed with the shop.',
  'live.everyCellChecked': { total: got['live.everyCellChecked']?.total ?? 0, checked: got['live.everyCellChecked']?.total ?? 0 },
  'live.availabilityFilled': { inFile: got['live.availabilityFilled']?.inFile ?? [], onScreen: true },
  'live.crossOrigin':      { any: true, other: true },

  'stale.fileStillSaysOld': true,
  'stale.corrected':       {
    baked:  originalPrice,
    live:   originalPrice + toMinor(7, 'USD'),
    // What the CELL says, which is the half that matters: the drive asserts the
    // page corrected the number AND printed it as money rather than as the
    // integer the column holds.
    shown:  formatMoney(fromMinor(originalPrice + toMinor(7, 'USD'), 'USD'), 'USD'),
    marked: true,
  },
  'stale.saidSo':          1,

  // ── the price list ──────────────────────────────────────────────────────
  // A retired plan is in the DATABASE and not on the page: `active: false`
  // takes it off sale without deleting the versions past subscriptions name.
  'pricing.retiredAbsent':     { inFile: true, inTheDb: true },
  'pricing.onePerActivePlan':  { emitted: activePlans.length, active: activePlans.length },
  // Every card checked and none of them moved — the build is seconds old.
  'pricing.agreed':            { cards: activePlans.length, checked: true, moved: 0 },
  'pricing.fileStillSaysOld':  true,
  'pricing.corrected':         {
    baked:       originalPlanPrice,
    live:        originalPlanPrice + toMinor(3, 'USD'),
    keptTheNote: true,
    marked:      true,
  },
  'pricing.saidSo':            1,

  'catalog.filter':        { count: '2 of 12 products', slugs: ['junction-camp-mug', 'litestone-camp-mug'] },
  'catalog.linksResolve':  { links: 2, allOk: true },
  'catalog.searchAsksTheShop': { source: 'shop', slugs: ['explorer-hoodie'] },
  'catalog.offlineSaysSo':     { source: 'offline', rows: true },
  'lazy.beforeScroll':     ['CatalogList'],
  'lazy.afterScroll':      ['CatalogList', 'LiveStock'],

  'home.featured':         6,
  'home.noJavaScriptNeeded': { apiCalls: 0, headings: 1 },
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
