/*
 * verify-studio-models.mjs — the Models diagram, the Overview panel and the rail.
 *
 * Three claims none of which a file can be read for.
 *
 * MODELS is a claim about DIMENSION: 39 identical cards in declaration order
 * carry no information, so position is dependency depth, prominence is a tier
 * read off two edge counts, hue is a name family, and focus answers what
 * touches one card. Every one of those is a rendered consequence of a
 * computation, and the failure mode is a diagram that still looks like a
 * diagram.
 *
 * OVERVIEW is a claim about being FIRST: a bare URL has to land here, and every
 * finding on it has to reach the panel that can act on the finding. A directory
 * row pointing at a panel that no longer exists is worse than no directory.
 *
 * THE RAIL is a claim about not LOSING anything when it narrows: a collapsed
 * icon keeps its accessible name, the shortcut does not fire into a text box,
 * and the diagram is redrawn because its curves are measured against a frame
 * that just moved.
 *
 *   node packages/litestone/test/verify-studio-models.mjs
 *
 * Starts and stops its own server on 7504 — test-tier tooling, inside the port
 * scheme so `fli ps` can see it. Nothing to launch first. Needs Chrome on PATH
 * or $FJS_CHROME.
 *
 * The server is spawned from `src/tools/cli.js` by path rather than through
 * `bunx litestone`, because bun resolves a workspace dependency to a COPY under
 * node_modules/.bun: a drive run through the binary would test the tree as it
 * was at the last install and pass against a broken working copy. studio.html
 * is TEXT-IMPORTED into that file, which makes it the difference between
 * driving the panel you just edited and the one you shipped.
 *
 * Traps inherited from the other two studio drives: never return a bare `null`
 * from a probe (CDP serializes it with no `value` key and it reads back as
 * `undefined`), and never assert against a poll without awaiting it. One of its
 * own: opacity is TRANSITIONED, so a computed value read in the same tick as
 * the class that changes it is the value it is leaving, not the one it is
 * going to.
 */

import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tempDir } from '../src/tmp-dirs.js'
import { join, resolve as pathResolve } from 'node:path'

const PORT   = process.env.STUDIO_PORT ?? '7504'
const UI     = `http://localhost:${PORT}`
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'
const REPO   = pathResolve(import.meta.dirname, '../../..')
const SCHEMA = join(REPO, 'example/db/schema.lite')

const results = []
const t = (name, actual, expected) => results.push({ name, actual, expected })

// ─── the server, started and stopped by this file ─────────────────────────

const CLI    = pathResolve(import.meta.dirname, '../src/tools/cli.js')
// `--no-open` or every run of this drive opens a tab on the desktop of
// whoever is running it, over whatever they were typing into.
// cwd is the APP ROOT: `.env` lives there, `example` declares @encrypted
// columns, and studio refuses to start with no encryption key.
const studio = spawn('bun', [CLI, 'studio', '--schema', SCHEMA, '--port', PORT, '--no-open'], {
  cwd: join(REPO, 'example'), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
let studioOut = ''
studio.stdout.on('data', d => { studioOut += d })
studio.stderr.on('data', d => { studioOut += d })

// Everything this run started, torn down from one place. Chrome joins the set
// once it is spawned, below — before this, cleanup() killed the studio server
// and left the browser, which does not notice its launcher has gone: it is
// reparented to init and stays up forever, holding a profile that keeps
// growing. Four of them were found alive here, and 52 profiles in one day
// (FJS-361). Synchronous throughout — an exit handler cannot await.
let chromeProc = null
let chromeProfile = null
function cleanup() {
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
// The default handler for either of these exits without an ordinary exit path.
process.on('uncaughtException',  (e) => { cleanup(); console.error(e); process.exit(1) })
process.on('unhandledRejection', (e) => { cleanup(); console.error(e); process.exit(1) })

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${UI}/api/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).ok) break } catch {}
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

// A throw is a FAILED ASSERTION, not the end of the run.
//
// This harness collects every result and prints one report at the end, so a
// probe that threw took the report with it — the run went red naming a line
// number, and every assertion after it never ran. Measured: with Overview
// removed as the landing panel, the row that says so passed unseen because a
// later probe dereferenced a null two assertions along. Same shape as the `&&`
// that let one Studio drive hide the other for months (`FJS-773`).
async function probe(expression) {
  try { return await evaluate(expression) }
  catch (e) { return 'THREW: ' + String(e.message ?? e).split('\n')[0] }
}

async function evaluate(expression) {
  const r = await cmd('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true, returnByValue: true,
  })
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}


// A BARE url. The claim is that Overview is the front door, and `#overview`
// in the address bar would assert the router and nothing about the default.
await cmd('Page.navigate', { url: UI + '/' })
await evaluate(`
  if (document.readyState !== 'complete')
    await new Promise(r => window.addEventListener('load', r, { once: true }));
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (document.querySelector('#ovBody .card')) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
`)

// ─── Overview is the front door ───────────────────────────────────────────

t('overview.bareUrlLandsHere', await probe(`
  return {
    panel: !document.getElementById('panelOverview').hidden,
    hash:  location.hash,
    nav:   document.querySelector('[aria-current="page"]').textContent.trim(),
  };
`), { panel: true, hash: '#overview', nav: 'Overview' })

// Four sections, and the order is the order the questions get asked in.
t('overview.sectionsInOrder', await probe(`
  return [...document.querySelectorAll('#ovBody .surface-header')].map(h => h.textContent.trim().replace(/ \\d+$/, ''));
`), ['Needs attention', 'Shape', 'Access', 'Where the data is', 'Every panel, and what it answers'])

// Every finding carries the panel that can act on it. A dashboard that reports
// a problem and offers no way through to its owner is one people stop reading.
t('overview.everyFindingHasAWayThrough', await probe(`
  const rows = [...document.querySelectorAll('#ovBody .card')][0].querySelectorAll('li.list-row');
  return [...rows].every(r => /showTool\\('[a-z]+'\\)/.test(r.querySelector('button')?.getAttribute('onclick') ?? ''));
`), true)

// The tenant note. `example` is `tenancy { strategy database }`, so the base
// database holds the registry and almost nothing else — an unselected tenant
// reads as an app with no data in it, which is the wrong conclusion and the
// easy one to reach.
t('overview.saysWhichDatabaseItIsDescribing', await probe(`
  const said = document.querySelector('#ovBody .ov-facts').textContent;
  const note = [...document.querySelectorAll('#ovBody li.list-row')]
    .some(r => /no tenant open/.test(r.textContent));
  return { names: /base database|tenant /.test(said), noteWhenNoneOpen: note };
`), { names: true, noteWhenNoneOpen: true })

// Counts are re-read on every visit. Opening a tenant re-points every data
// endpoint, so a snapshot taken at boot describes a DIFFERENT database and the
// page would report the registry's rows under the tenant's name.
t('overview.countsFollowTheOpenTenant', await probe(`
  const before = Object.values(erCounts).reduce((a, b) => a + b, 0);
  const list   = await api('/tenants');
  if (!list.enabled || !(list.tenants || []).length) return 'no tenants to switch to';
  await api('/tenants/open', { id: list.tenants[0].id });
  await ovInit();
  const after = Object.values(erCounts).reduce((a, b) => a + b, 0);
  await api('/tenants/open', {});
  await ovInit();
  const back = Object.values(erCounts).reduce((a, b) => a + b, 0);
  return { moved: after !== before, restored: back === before, tenantNamed: after > 0 };
`), { moved: true, restored: true, tenantNamed: true })

// ─── the directory ────────────────────────────────────────────────────────
//
// The rail carries names; a name is what does not tell somebody opening Studio
// which of thirteen panels to click. So each card carries the QUESTION, and the
// assertion that matters is that the destination is real: a row pointing at a
// panel that has been renamed is advice that fails when taken.

t('directory.everyCardNamesAPanelThatExists', await probe(`
  const bad = [];
  for (const b of document.querySelectorAll('.ov-tool')) {
    const id = /showTool\\('([a-z]+)'\\)/.exec(b.getAttribute('onclick'))[1];
    if (!TOOLS.includes(id)) { bad.push(id + ' is not a tool'); continue; }
    b.click();
    const el = document.getElementById('panel' + id[0].toUpperCase() + id.slice(1));
    if (!el || el.hidden) bad.push(id + ' did not open');
  }
  return bad;
`), [])

t('directory.everyCardSaysWhatThePanelAnswers', await probe(`
  showTool('overview');
  await new Promise(r => setTimeout(r, 1200));
  const cards = [...document.querySelectorAll('.ov-tool')];
  return {
    some:    cards.length >= 12,
    allSaid: cards.every(c => (c.querySelector('.ov-tool-what')?.textContent ?? '').length > 20),
  };
`), { some: true, allSaid: true })

// Tenants is listed only where the app HAS tenants — a directory naming a panel
// this app does not have is worse than one that is short.
t('directory.tenantsListedOnlyWhenThereAreTenants', await probe(`
  const listed = [...document.querySelectorAll('.ov-tool-name')].some(n => n.textContent === 'Tenants');
  return listed === tenantsEnabled;
`), true)

// ─── the diagram ──────────────────────────────────────────────────────────

await evaluate(`
  showTool('schema');
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (document.querySelectorAll('.er-table').length) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
`)

// The tiers are DERIVED, so they are asserted against the derivation rather
// than against a list of model names — naming them makes the drive red the day
// somebody adds a relation to example/, which is a fixture that has stopped
// describing its subject rather than a regression.
t('tiers.everyCardMatchesItsEdgeCounts', await probe(`
  const g = erGraph();
  const wrong = [];
  for (const el of document.querySelectorAll('.er-table')) {
    const n = el.dataset.model, i = g.inDeg[n], o = g.outDeg[n];
    const want = (!i && !o) ? 'isolate' : i >= 3 ? 'hub' : i === 0 ? 'leaf' : 'connector';
    if (el.dataset.tier !== want) wrong.push(n + ' is ' + el.dataset.tier + ' want ' + want);
    if (!el.classList.contains('er-' + want)) wrong.push(n + ' has no er-' + want + ' class');
  }
  return wrong;
`), [])

// All four have to OCCUR, or a grid where everything is one tier passes the
// row above by agreeing with itself.
t('tiers.allFourOccur', await probe(`
  const seen = new Set([...document.querySelectorAll('.er-table')].map(e => e.dataset.tier));
  return [...seen].sort();
`), ['connector', 'hub', 'isolate', 'leaf'])

// The number the tier was read off is ON the card. Prominence a reader cannot
// check is a style somebody chose.
t('tiers.eachCardStatesItsNumber', await probe(`
  const g = erGraph();
  const wrong = [];
  for (const el of document.querySelectorAll('.er-table')) {
    const mark = el.querySelector('.er-tier-mark')?.textContent ?? '';
    const n = el.dataset.model;
    const want = el.dataset.tier === 'isolate' ? 'unlinked'
               : el.dataset.tier === 'leaf'    ? g.outDeg[n] + ' out'
               : g.inDeg[n] + ' in';
    if (mark !== want) wrong.push(n + ': ' + mark + ' want ' + want);
  }
  return wrong;
`), [])

// Position is dependency. A model sits to the RIGHT of everything it points at,
// which is what makes every line flow one way.
t('layout.aModelSitsRightOfWhatItPointsAt', await probe(`
  const g = erGraph();
  const at = n => document.querySelector('[data-model="' + n + '"]').offsetLeft;
  const wrong = [];
  for (const m of schema.models) {
    if (g.tier[m.name] === 'isolate') continue;
    for (const f of m.fields) {
      if (f.type.kind !== 'relation') continue;
      const rel = (f.attributes || []).find(a => a.kind === 'relation');
      if (!rel?.fields || f.type.name === m.name) continue;
      if (g.tier[f.type.name] === 'isolate') continue;
      if (!(at(m.name) > at(f.type.name))) wrong.push(m.name + ' -> ' + f.type.name);
    }
  }
  return wrong;
`), [])

// Cards are packed against MEASURED heights. renderSchema runs at boot while
// the panel is hidden, where every offsetHeight is 0 and every card takes a
// fallback pitch — 58 overlapping pairs, on a diagram that still looked like a
// diagram. erInit re-packs on the first reveal.
t('layout.noCardOverlapsAnother', await probe(`
  const cards = [...document.querySelectorAll('.er-table')];
  const over = [];
  for (const a of cards) for (const b of cards) {
    if (a === b) continue;
    const ax2 = a.offsetLeft + a.offsetWidth, ay2 = a.offsetTop + a.offsetHeight;
    if (a.offsetLeft < b.offsetLeft + b.offsetWidth && b.offsetLeft < ax2 &&
        a.offsetTop  < b.offsetTop  + b.offsetHeight && b.offsetTop  < ay2)
      over.push(a.dataset.model + '/' + b.dataset.model);
  }
  return over.length;
`), 0)

// Isolates park past the end rather than being scattered through the columns.
t('layout.isolatesParkPastEverythingElse', await probe(`
  const g = erGraph();
  const x = n => document.querySelector('[data-model="' + n + '"]').offsetLeft;
  const iso = schema.models.filter(m => g.tier[m.name] === 'isolate').map(m => x(m.name));
  const rest = schema.models.filter(m => g.tier[m.name] !== 'isolate').map(m => x(m.name));
  return { some: iso.length > 0, allPast: Math.min(...iso) > Math.max(...rest) };
`), { some: true, allPast: true })

// ─── families ─────────────────────────────────────────────────────────────
//
// A stem is a family only where two or more models share it, and the hues are
// walked by the golden angle rather than hashed: a hash of the NAME destroys
// the similarity being asked about, and a hash of the stem cannot promise two
// families look different.

t('families.aStemOfOneIsNotAFamily', await probe(`
  const f = erFamilies();
  const wrong = f.shared.filter(k => (f.members[k] || []).length < 2);
  const singles = Object.keys(f.members).filter(k => f.members[k].length === 1 && f.hue[k] != null);
  return { sharedAllPlural: wrong.length === 0, noSingletonColored: singles.length === 0 };
`), { sharedAllPlural: true, noSingletonColored: true })

t('families.knownGroupingsAreOneFamilyEach', await probe(`
  const f = erFamilies();
  const same = (...names) => new Set(names.map(n => f.stem[n])).size === 1 && f.stem[names[0]] != null;
  return {
    product: same('Product', 'ProductVariant', 'ProductImage'),
    order:   same('Order', 'OrderLine'),
    cart:    same('Cart', 'CartLine'),
    // Asked of the STEMMER, not the family map: a singleton stem is absent
    // from that map, so comparing two undefineds answers false and would have
    // read as Customer and CustomField being one family.
    apart:   erStem('Customer') !== erStem('CustomField'),
  };
`), { product: true, order: true, cart: true, apart: true })

// The hues have to be far apart, which is the whole reason they are walked
// rather than hashed. 9 families in 360 degrees collide often under a hash.
t('families.huesAreSeparated', await probe(`
  const f = erFamilies();
  const hues = f.shared.map(k => f.hue[k]).sort((a, b) => a - b);
  if (hues.length < 2) return 'fewer than two families';
  let min = 360;
  for (let i = 1; i < hues.length; i++) min = Math.min(min, hues[i] - hues[i - 1]);
  return { count: hues.length >= 2, spacedBy: min >= 15 };
`), { count: true, spacedBy: true })

// A spine on a card, and the same hue on an edge whose two ends are one family.
// The pair is what makes Order -> OrderLine followable in a field of crossing
// links; the spine is what you scan and the line is what you follow.
t('families.spineAndEdgeCarryTheSameHue', await probe(`
  const f = erFamilies();
  const el = [...document.querySelectorAll('.er-fam')][0];
  // Reported rather than dereferenced. With families removed this threw a
  // TypeError and killed the run before the report printed — a red run either
  // way, but one that names a line number instead of the feature that is gone.
  if (!el) return 'no card carries a family';
  const fam = el.dataset.family;
  const paths = [...document.querySelectorAll('path.er-link-fam')];
  return {
    spined:    document.querySelectorAll('.er-fam').length === Object.keys(f.stem).length,
    onlyKin:   paths.every(p => f.stem[p.dataset.from] && f.stem[p.dataset.from] === f.stem[p.dataset.to]),
    someLinks: paths.length > 0,
    hueOnCard: el.style.getPropertyValue('--er-family') === String(f.hue[fam]),
    thick:     getComputedStyle(el).borderInlineStartWidth === '4px',
  };
`), { spined: true, onlyKin: true, someLinks: true, hueOnCard: true, thick: true })

// ─── focus, and the pin ───────────────────────────────────────────────────
//
// The static channels answer WHERE DO I LOOK. This is the only one that can
// answer WHAT TOUCHES THIS ONE, because that is asked one card at a time.

t('focus.dimsEverythingNotTouchingTheCard', await probe(`
  const name = [...document.querySelectorAll('.er-table')]
    .map(e => e.dataset.model).find(n => erGraph().neighbors[n].size >= 2);
  erFocus(name);
  // Opacity is transitioned: read in the same tick and it is the value being
  // left, not the value being gone to.
  await new Promise(r => setTimeout(r, 400));
  const cards = [...document.querySelectorAll('.er-table')];
  const near  = cards.filter(c => c.classList.contains('er-near')).map(c => c.dataset.model).sort();
  const want  = [name, ...erGraph().neighbors[name]].sort();
  const dim   = cards.filter(c => getComputedStyle(c).opacity === '0.2').length;
  const lit   = document.querySelectorAll('.er-link-on').length;
  erFocus(null);
  return { near: JSON.stringify(near) === JSON.stringify(want), dimmed: dim === cards.length - want.length, someLit: lit > 0 };
`), { near: true, dimmed: true, someLit: true })

t('focus.clearingRestoresEverything', await probe(`
  erFocus(null);
  await new Promise(r => setTimeout(r, 400));
  return {
    marked:  document.querySelectorAll('.er-near').length,
    dimmed:  [...document.querySelectorAll('.er-table')].filter(c => getComputedStyle(c).opacity === '0.2').length,
    onLinks: document.querySelectorAll('.er-link-on').length,
  };
`), { marked: 0, dimmed: 0, onLinks: 0 })

// A pin outlives the pointer, which hover cannot on a canvas taller than the
// window: the pointer leaves the card on the way down.
t('pin.survivesAHoverElsewhereAndARerender', await probe(`
  const [a, b] = [...document.querySelectorAll('.er-table')].map(e => e.dataset.model);
  erPin(a);
  erFocus(b);                       // the pointer, moving on
  // Asserted against what is ON SCREEN, not against the variable. erFocus never
  // writes _erPinned, so reading it back proved only that a function did not do
  // something it never does — measured: with the pin's own guard removed, the
  // drive still passed.
  const near = [...document.querySelectorAll('.er-near')].map(e => e.dataset.model).sort();
  const afterHover = JSON.stringify(near) === JSON.stringify([a, ...erGraph().neighbors[a]].sort());
  renderSchema();                   // every card is replaced
  await new Promise(r => setTimeout(r, 500));
  const marked = [...document.querySelectorAll('.er-pinned')].map(e => e.dataset.model);
  erPin(null);
  return { heldThroughHover: afterHover, reappliedAfterRender: JSON.stringify(marked) === JSON.stringify([a]) };
`), { heldThroughHover: true, reappliedAfterRender: true })

// A drag ends in a click event too. Without this the pin toggles every time
// somebody moves a card, which is the one gesture the canvas is for.
t('pin.aDragDoesNotPin', await probe(`
  const el = document.querySelector('.er-table');
  const at = (type, dx, dy) => el.dispatchEvent(new MouseEvent(type, {
    bubbles: true, clientX: 100 + dx, clientY: 100 + dy,
  }));
  erPin(null);
  at('mousedown', 0, 0);
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 160, clientY: 140 }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const afterDrag = _erPinned;
  // …and the same gesture WITHOUT movement must pin, or a guard that refused
  // everything would pass the line above.
  at('mousedown', 0, 0);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const afterClick = _erPinned;
  erPin(null);
  // A card somebody moved keeps its place, which is the point — and would make
  // every later layout assertion a statement about this drive rather than about
  // the panel. Put it back.
  _erDragged.clear();
  erLayout(true);
  await new Promise(r => setTimeout(r, 300));
  return { dragDidNot: afterDrag === null, clickDid: afterClick === el.dataset.model };
`), { dragDidNot: true, clickDid: true })

// ─── the row overlay ──────────────────────────────────────────────────────
//
// Off by default: it measures the DATA where everything else here measures the
// design, and turning it on is how a reader says which one they are asking.

t('rows.offByDefaultAndAddsABarPerCard', await probe(`
  const before = document.querySelectorAll('.er-rows').length;
  erToggleRows();
  await new Promise(r => setTimeout(r, 400));
  const after = document.querySelectorAll('.er-rows').length;
  const cards = document.querySelectorAll('.er-table').length;
  const overlapping = (() => {
    const cs = [...document.querySelectorAll('.er-table')];
    let n = 0;
    for (const a of cs) for (const b of cs) {
      if (a === b) continue;
      if (a.offsetLeft < b.offsetLeft + b.offsetWidth && b.offsetLeft < a.offsetLeft + a.offsetWidth &&
          a.offsetTop  < b.offsetTop  + b.offsetHeight && b.offsetTop  < a.offsetTop + a.offsetHeight) n++;
    }
    return n;
  })();
  erToggleRows();
  await new Promise(r => setTimeout(r, 400));
  // The bar changes every card's height, so a layout that only placed NEW
  // models would leave the whole diagram overlapping by exactly one bar.
  return { offAtFirst: before === 0, oneEach: after === cards, stillNoOverlap: overlapping === 0 };
`), { offAtFirst: true, oneEach: true, stillNoOverlap: true })

// Log-scaled, because row counts span orders of magnitude and a linear bar
// draws every table but the largest as nothing.
t('rows.barIsLogScaled', await probe(`
  const keep = { ...erCounts }, keepMax = _erMaxRows;
  const names = schema.models.map(m => m.name);
  const vals  = [0, 4, 900, 480000];
  names.forEach((n, i) => erCounts[n] = vals[i % vals.length]);
  _erMaxRows = Math.max(...Object.values(erCounts));
  erToggleRows();
  await new Promise(r => setTimeout(r, 400));
  const seen = {};
  for (const c of document.querySelectorAll('.er-table')) {
    const n = c.querySelector('.er-rows span').textContent;
    seen[n] = parseInt(c.querySelector('.er-rows-fill').style.inlineSize, 10) || 0;
  }
  erToggleRows();
  erCounts = keep; _erMaxRows = keepMax;
  await new Promise(r => setTimeout(r, 300));
  const zero = seen['0'], small = seen['4'], mid = seen['900'], big = seen['480,000'];
  return {
    emptyIsEmpty: zero === 0,
    ordered:      small < mid && mid < big && big === 100,
    // The point of the log: 4 rows against 480,000 must still be VISIBLE.
    smallVisible: small >= 5,
    // …and linear would put it at 0. This is the negative control.
    notLinear:    small > Math.round(4 / 480000 * 100),
  };
`), { emptyIsEmpty: true, ordered: true, smallVisible: true, notLinear: true })

// ─── the rail ─────────────────────────────────────────────────────────────

t('rail.collapsesAndKeepsEveryName', await probe(`
  const rail = document.getElementById('studioRail');
  const wide = Math.round(rail.getBoundingClientRect().width);
  toggleRail();
  await new Promise(r => setTimeout(r, 300));
  const narrow = Math.round(rail.getBoundingClientRect().width);
  const links  = [...document.querySelectorAll('.sidebar .navlink')];
  return {
    narrower:  narrow < wide / 2,
    // .visually-hidden, not display:none — a collapsed rail still announces
    // Browse rather than an unnamed link with a picture in it.
    named:     links.every(a => a.textContent.trim().length > 0),
    unpainted: links.every(a => a.querySelector('.navlink-text').getBoundingClientRect().width <= 2),
    titled:    links.every(a => a.title.length > 0),
    announced: document.getElementById('railToggle').getAttribute('aria-expanded') === 'false',
  };
`), { narrower: true, named: true, unpainted: true, titled: true, announced: true })

// Every curve ends on the card it names. Not a claim about the rail: cards are
// absolutely positioned inside the canvas, so narrowing the frame moves the
// canvas and not the coordinates — measured, by deleting setRail's redraw and
// watching this pass. It stays because it is the one assertion that would catch
// a drawing bug of any origin, and it is asked here because a frame that just
// moved is the cheapest moment to ask it.
t('links.everyCurveEndsOnItsTargetCard', await probe(`
  const wrong = [];
  for (const p of document.querySelectorAll('path.er-link')) {
    const to = document.querySelector('[data-model="' + p.dataset.to + '"]');
    const end = p.getAttribute('d').split(' ').pop().split(',').map(Number);
    const l = to.offsetLeft, r = l + to.offsetWidth;
    if (end[0] < l - 2 || end[0] > r + 2) wrong.push(p.dataset.from + '->' + p.dataset.to);
  }
  return wrong;
`), [])

t('rail.theChoiceSurvivesAReload', await probe(`
  return { stored: localStorage.getItem('litestone.studio.rail') };
`), { stored: '1' })

await cmd('Page.navigate', { url: UI + '/' })
await evaluate(`
  if (document.readyState !== 'complete')
    await new Promise(r => window.addEventListener('load', r, { once: true }));
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (document.querySelector('#ovBody .card')) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
`)
t('rail.comesBackCollapsed', await probe(`
  return document.body.classList.contains('rail-collapsed');
`), true)

// The shortcut is refused while a field has focus, or it eats a backslash typed
// into the SQL box — which is a shortcut people turn off.
t('rail.theShortcutDoesNotFireIntoAField', await probe(`
  showTool('query');
  await new Promise(r => setTimeout(r, 400));
  const box = document.querySelector('#panelQuery textarea, #panelQuery input');
  box.focus();
  const before = document.body.classList.contains('rail-collapsed');
  // Dispatched on an ELEMENT. A real keydown's target is always one — body at
  // minimum — and other handlers on this page read tagName and closest() off
  // it, so firing at the document tests a shape the browser never produces.
  box.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', bubbles: true }));
  const afterInField = document.body.classList.contains('rail-collapsed');
  box.blur();
  // The same key with nothing focused must toggle, or a guard that refused
  // every keypress would pass the line above.
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', bubbles: true }));
  const afterOutside = document.body.classList.contains('rail-collapsed');
  if (afterOutside !== before) toggleRail();
  return { ignoredInField: afterInField === before, toggledOutside: afterOutside !== before };
`), { ignoredInField: true, toggledOutside: true })

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
