/**
 * verify.mjs — prove a prerendered island is actually interactive.
 *
 * Unit tests cannot settle this one. The claim is that a page built by
 * `target: 'static'` — HTML with comment markers in it, plus a bundle Sierra
 * generated — comes alive when a real browser parses and runs it. Every part of
 * that is outside a test runner: the HTML parser's treatment of comment
 * markers, module script execution, event delegation, and whether the thing
 * responds to a click at all.
 *
 * The failure this guards against is specific and silent: an island that mounts
 * with a bare `Comp(anchor, props, null)` renders perfect markup and registers
 * no delegation root, so the page LOOKS right and no button works. That is why
 * the assertion is a click and not a snapshot.
 *
 * Usage, from the sierra package root:
 *
 *   npx vite build --config tests/fixtures/island-site/vite.config.js
 *   node tests/fixtures/island-site/verify.mjs
 *
 * Needs Chrome on PATH (or $FJS_CHROME), same as the css package's harness.
 * Exits non-zero and prints what differed if any assertion fails.
 */

import { createServer } from 'node:http'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, 'dist/client')

const CHROME = process.env.FJS_CHROME ?? 'google-chrome'
const TYPES  = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(
    `No build at ${DIST}.\n` +
    `Run: npx vite build --config tests/fixtures/island-site/vite.config.js`
  )
  process.exit(1)
}

// The probe runs inside the page, after the island bundle has had a chance to
// run. `client:load` mounts as soon as the module executes; `client:idle` waits
// for requestIdleCallback, hence the delay before clicking.
const PROBE = `
(async () => {
  const out = { errors: [] };
  window.addEventListener('error', e => out.errors.push(String(e.message)));

  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Mounting REPLACES the prerendered markup, so the element identity changing
  // is the precise signal that an island went live. A fixed sleep is not: the
  // mount is a dynamic import, and an early click lands on inert prerendered
  // markup and reads as a product failure.
  const refs = {};
  for (const id of ['counter', 'later', 'seen', 'narrow', 'wide', 'below', 'outer', 'inner']) refs[id] = $(id);
  const mounted = async (id, ms = 4000) => {
    for (let w = 0; w < ms; w += 25) {
      if ($(id) && $(id) !== refs[id]) return true;
      await sleep(25);
    }
    return false;
  };

  // Which island chunks the browser actually downloaded. The point of
  // per-island splitting: a chunk must not be fetched until its directive
  // fires, and a directive that never fires must cost nothing at all.
  const fetched = () => performance.getEntriesByType('resource')
    .map(e => (e.name.match(/island-([A-Za-z0-9]+)-/) || [])[1])
    .filter(Boolean).sort();

  // The scroll happens FIRST, and this is not a stylistic choice. Under
  // --virtual-time-budget the page gets a rendering lifecycle around load and
  // then effectively none, and IntersectionObserver only delivers records
  // during one. Scrolling late means the record lands after the last frame that
  // will ever happen: the island stays unmounted and the harness reports a
  // product failure that is really a headless artifact. Scrolling before the
  // first lifecycle is deterministic (measured: 5/5 vs ~1/5).
  //
  // The claim being tested survives the reordering intact — that a below-the-
  // fold island is not FETCHED until it becomes visible — because what proves
  // it is the resource list at the moment of the scroll, not the clock.
  out.notFetchedYet = ['Below', 'Wide'].filter(n => fetched().includes(n));
  $('scroller').scrollTop = 99999;

  out.prerenderedCounter = $('counter').textContent;

  await mounted('counter');                     // client:load
  $('counter').click(); $('counter').click();
  out.afterTwoClicks = $('counter').textContent;

  await mounted('later');                       // client:idle
  $('later').click();
  out.afterOneClick = $('later').textContent;

  // A nested island. Outer is client:load; Inner is client:idle INSIDE it, and
  // must be live as soon as Outer mounts — a live parent renders its own
  // children, so the inner directive never gets to run on its own.
  await mounted('outer');
  $('outer').click();
  out.outerAfterClick = $('outer').textContent;
  out.innerWentLive   = await mounted('inner');
  $('inner').click(); $('inner').click();
  out.innerAfterClicks = $('inner').textContent;
  // Mounting Outer removes the range between ITS markers, which is where the
  // inner island's prerendered markup sits. Removing the scan-time list instead
  // would strand it beside Outer's fresh render — two #inner nodes, one dead.
  out.innerNodeCount = document.querySelectorAll('#inner').length;

  await mounted('seen');                        // client:visible, already in view
  $('seen').click();
  out.seenInViewport = $('seen').textContent;

  await mounted('narrow');                      // client:media, query matches
  $('narrow').click();
  out.narrowAfterClick = $('narrow').textContent;

  // client:media whose query can never match: must stay exactly as prerendered.
  $('wide').click();
  out.wideAfterClick = $('wide').textContent;
  out.wideStillPrerendered = $('wide') === refs.wide;

  out.staticHeading  = document.querySelector('h1').textContent;
  out.inertUntouched = $('inert').textContent;

  const bg = id => getComputedStyle($(id)).backgroundColor;
  out.styledOwnBg  = bg('styled');
  out.outerOwnBg   = bg('outer-box');
  out.innerOwnBg   = bg('inner');
  out.counterNotBg = bg('counter');
  out.laterNotBg   = bg('later');

  // CSS ships once, per component. The scope hash is content-addressed, so the
  // prerendered <style id="mHASH"> is the same id the island's chunk would
  // inject under — and addStyles skips an id already in the document. Before
  // that, the same rules were on the page three times: Mesa's blob, Sierra's
  // blob, and the runtime's injection under a second hash.
  //
  // Three components carry CSS, so this pins more than the dedupe: one tag per
  // component, one id each, and an order that survives later mounts.
  const styleEls = () => [...document.querySelectorAll('style')];
  const copies = needle => styleEls().filter(el => el.textContent.includes(needle)).length;
  out.styleTags       = styleEls().length;
  out.styleIds        = styleEls().map(el => el.id || '(anonymous)');
  out.uniqueStyleIds  = new Set(out.styleIds).size;
  out.ruleCopies      = copies('rgb(10, 20, 30)');   // Styled
  out.outerRuleCopies = copies('rgb(1, 2, 3)');      // Outer
  out.innerRuleCopies = copies('rgb(70, 80, 90)');   // Inner, a nested island

  // client:visible, scrolled into view at the top of this probe.
  out.belowMounted = await mounted('below');
  $('below').click();
  out.belowAfterScroll = $('below').textContent;

  // Every island that mounted fetched its chunk; Wide, whose query matches
  // nothing, never did. Inner rides along with Outer — it is a static import of
  // Outer's chunk, which is the right cost for nesting: one component, one
  // chunk, fetched once.
  out.fetchedAtEnd = fetched();

  // A late mount must not add a fourth <style> or reorder the three: the ids
  // are the same ids, in the same places, after everything on the page is live.
  out.styleIdsAfterScroll = styleEls().map(el => el.id || '(anonymous)');

  // Everything the loader said, in order. A subsumed island used to reach
  // mount() with a detached anchor and get logged as a load failure — correct
  // behavior, reported as breakage.
  out.islandLog = (window.__islandLog ?? []).filter(m => m.includes('[Sierra islands]'));

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

// The console hook is a CLASSIC script in <head>, not part of the probe. Inline
// classic scripts run during parsing; the island bundle is a module script and
// so runs after it. The probe cannot install this itself — it is a module too,
// and by the time it runs every client:load island has already mounted and
// anything logged during that is gone.
const HOOK = `<script>
  window.__islandLog = [];
  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...a) => { window.__islandLog.push(level + ': ' + a.map(String).join(' ')); orig(...a); };
  }
</script>`

const probeFile = join(DIST, '__verify_probe.html')
const html = await readFile(join(DIST, 'index.html'), 'utf8')
await writeFile(
  probeFile,
  html.replace('<head>', `<head>${HOOK}`)
      .replace('</body>', `<script type="module">${PROBE}</script></body>`)
)

let dom = ''
try {
  const chrome = spawn(CHROME, [
    // The budget is virtual time for the WHOLE page, and every island the
    // fixture gains spends some of it. At 30000 the last island — `Below`,
    // which needs a scroll, an IntersectionObserver callback and a chunk fetch
    // — intermittently ran out and reported as never mounting.
    '--headless', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=60000',
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
const got = JSON.parse(match[1])

const expected = {
  errors:             [],
  prerenderedCounter: 'count: 7',   // props survived the marker into the prerender
  afterTwoClicks:     'count: 9',   // client:load island is live and delegating events
  afterOneClick:      'idle: 1',    // client:idle mounted too
  seenInViewport:     'Seen: 1',    // client:visible, intersecting from the start
  narrowAfterClick:   'Narrow: 1',  // client:media whose query matches
  wideAfterClick:     'Wide: 0',    // client:media whose query never matches — never mounts
  belowAfterScroll:   'Below: 1',   // client:visible, mounted on scroll
  belowMounted:       true,
  wideStillPrerendered: true,   // never mounted, so still the prerendered node

  // A nested island comes alive with its parent, exactly once, and says nothing.
  outerAfterClick:    'Outer: 1',
  innerWentLive:      true,
  innerAfterClicks:   'Inner: 2',
  innerNodeCount:     1,
  islandLog:          [],

  inertUntouched:     'no island here',
  staticHeading:      'static heading',

  styledOwnBg:        'rgb(10, 20, 30)',      // a component styles its own root
  outerOwnBg:         'rgb(1, 2, 3)',
  innerOwnBg:         'rgb(70, 80, 90)',      // and a nested one keeps its own
  counterNotBg:       'rgb(239, 239, 239)',   // and no one else's — UA default
  laterNotBg:         'rgb(239, 239, 239)',

  // Three components carry CSS → three tags, three ids, one copy of each rule.
  styleTags:           3,
  uniqueStyleIds:      3,
  ruleCopies:          1,
  outerRuleCopies:     1,
  innerRuleCopies:     1,

  // Per-island splitting: an island that is not visible yet has cost nothing at
  // the moment it is scrolled to, and one whose query never matches costs
  // nothing ever — it is absent from the final list too.
  notFetchedYet: [],
  fetchedAtEnd:  ['Below', 'Counter', 'Inner', 'Later', 'Narrow', 'Outer', 'Seen', 'Styled'],
}

let failed = 0
for (const [k, want] of Object.entries(expected)) {
  const have = got[k]
  const ok = JSON.stringify(have) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? '  ✓' : '  ✗'} ${k}: ${JSON.stringify(have)}${ok ? '' : `  (expected ${JSON.stringify(want)})`}`)
}

// Ordering, which a count alone cannot see. The served HTML fixes the order of
// the three <style> blocks; live mounting must not disturb it — not when a
// client:load island injects its own copy, and not when a chunk arrives late
// after a scroll. Compared against the file rather than a hardcoded list, so
// this stays true when the fixture's CSS changes.
const servedIds = [...(await readFile(join(DIST, 'index.html'), 'utf8'))
  .matchAll(/<style id="([^"]+)"/g)].map((m) => m[1])
for (const [label, ids] of [['at load', got.styleIds], ['after a late mount', got.styleIdsAfterScroll]]) {
  const ok = JSON.stringify(ids) === JSON.stringify(servedIds)
  if (!ok) failed++
  console.log(`${ok ? '  ✓' : '  ✗'} <style> order ${label}: ${JSON.stringify(ids)}` +
              `${ok ? '' : `  (served order ${JSON.stringify(servedIds)})`}`)
}

// A page with no island must ship no script — the point of islands, and the
// thing most easily regressed by "just inject it everywhere".
const plain = await readFile(join(DIST, 'plain/index.html'), 'utf8')
const plainClean = !plain.includes('<script type="module"')
if (!plainClean) failed++
console.log(`${plainClean ? '  ✓' : '  ✗'} island-free page ships no module script`)

console.log(failed === 0 ? '\nislands verified in a real browser\n' : `\n${failed} assertion(s) failed\n`)
process.exit(failed === 0 ? 0 : 1)
