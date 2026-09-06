/**
 * verify.mjs — prove an embeddable widget works on a page nobody here controls.
 *
 * A unit test cannot settle any of this. The claim is that one `<script src>`,
 * on a plain HTML page with no bundler and no framework, produces a live
 * component that the host page's CSS cannot touch and that cannot touch the
 * host page's CSS. Every part of that is outside a test runner: custom element
 * upgrade, shadow DOM style scoping, event delegation inside a shadow root,
 * MutationObserver, and whether a classic script tag can run the file at all.
 *
 * The failures it guards against are all silent:
 *
 *   • an ES-module bundle behind a plain <script> — the browser refuses it,
 *     nothing renders, and the console error is on the HOST page, not here
 *   • styles mounted into document.head instead of the shadow root — works
 *     perfectly on the dev page, inherits the host's `button { … !important }`
 *     on a real one
 *   • a mount that renders markup but registers no delegation root: the widget
 *     LOOKS right and no button works (the island bug, one realm over)
 *   • a second copy of the script double-mounting into one element
 *   • a CSS asset emitted beside the script: a second request the host page was
 *     never told to make, landing in the wrong DOM
 *
 * ── Two origins, because that is what an embed is ─────────────────────────
 *
 * The widgets are served by `@frontierjs/sierra/widget/serve` — the module the
 * generated `widgets/deploy/` container runs — on its own port, and the host
 * page is served by a different server on a different one. A same-origin script
 * tag is the one arrangement no customer of a widget ever has, and it hides
 * every CORS answer the real deployment depends on.
 *
 * Usage, from the sierra package root:
 *
 *   node src/tools/cli.js widgets --config config/sierra.config.js   # from the surface root
 *   node tests/fixtures/widget-site/test/verify.mjs
 *
 * `bun run test:widgets` does both. Needs Chrome on PATH (or $FJS_CHROME).
 */

import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { join, extname, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

import { serveWidgets } from '../../../../src/widget/serve.js'

// This file lives in the surface's own `test/`, so the built widgets are a
// level up — the same relationship `web/test/` has to `web/dist/`.
const HERE    = dirname(fileURLToPath(import.meta.url))
const SURFACE = resolve(HERE, '..')
const EMBEDS  = join(SURFACE, 'dist/embeds')
const CHROME  = process.env.FJS_CHROME ?? 'google-chrome'
const TYPES   = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

if (!existsSync(join(EMBEDS, 'Counter.js'))) {
  console.error(
    `No widgets built at ${EMBEDS}.\n` +
    `Run: cd tests/fixtures/widget-site && node ../../../src/tools/cli.js widgets`
  )
  process.exit(1)
}

// ─── What the build emitted ───────────────────────────────────────────────────
// Asserted off the FILES, before a browser is involved: a widget that is not one
// self-contained classic script has already failed, whatever the page then does.

const emitted = (await readdir(EMBEDS)).sort()
const counterSrc = await readFile(join(EMBEDS, 'Counter.js'), 'utf8')

const fileChecks = {
  emitted,
  // A bare `import`/`export` statement means the file is a module, and a
  // classic <script> tag cannot run it.
  hasModuleSyntax: /^\s*(import|export)\s/m.test(counterSrc),
  // The stylesheet has to be INSIDE the script.
  hasOwnCss:       counterSrc.includes('rgb(0, 128, 0)'),
  // The imported stylesheet too — that is the fold widgetCssPlugin does.
  leadHasImportedCss: (await readFile(join(EMBEDS, 'LeadForm.js'), 'utf8')).includes('rgb(0, 0, 255)'),
}

// ─── The widget origin — the deployment, not a stand-in ───────────────────────
//
// `serveWidgets` is what `sierra widgets --serve` runs and what the generated
// widgets/deploy/ container runs. Asserting the headers here means asserting the
// ones that ship; a second server written for this file would agree with itself.

const widgetOrigin = await serveWidgets({ dir: EMBEDS, host: '127.0.0.1' })

const head = await fetch(`${widgetOrigin.url}/Counter.js`, { method: 'HEAD' })
const headerChecks = {
  cors:      head.headers.get('access-control-allow-origin'),
  // The entry's URL is pasted into a host page once and never updated, so it
  // must stay revalidatable — an immutable entry is a widget nobody can fix.
  entryImmutable: /immutable/.test(head.headers.get('cache-control') ?? ''),
  contentType:    head.headers.get('content-type'),
  // Served to the open internet by definition.
  traversal: (await fetch(`${widgetOrigin.url}/../../package.json`)).status,
}

// ─── Serve the host page, on a DIFFERENT origin ───────────────────────────────

const server = createServer(async (req, res) => {
  const url = req.url.split('?')[0]
  if (url === '/' || url === '/csp') {
    const file = url === '/csp' ? 'host-csp.html' : 'host.html'
    const page = (await readFile(join(HERE, file), 'utf8'))
      .replaceAll('{{EMBEDS}}', widgetOrigin.url)
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(page)
    return
  }
  try {
    const file = join(SURFACE, 'dist', url.replace(/^\//, ''))
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404); res.end('not found')
  }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

// ─── The probe ────────────────────────────────────────────────────────────────

const PROBE = `
(async () => {
  const out = { errors: [] };
  window.addEventListener('error', e => out.errors.push(String(e.message)));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const until = async (fn, ms = 4000) => {
    for (let w = 0; w < ms; w += 25) { if (fn()) return true; await sleep(25); }
    return false;
  };

  const el      = sel => document.querySelector(sel);
  const inside  = (host, sel) => host?.shadowRoot?.querySelector(sel);

  // ── the element form ───────────────────────────────────────────────────
  const counter = el('mt-counter');
  out.upgraded  = await until(() => !!inside(counter, '#counter'));
  out.propFromData = inside(counter, '#counter')?.textContent;

  // A click, because markup alone proves nothing: a mount that renders and
  // registers no delegation root looks identical until something is pressed.
  inside(counter, '#counter')?.click();
  inside(counter, '#counter')?.click();
  out.afterTwoClicks = inside(counter, '#counter')?.textContent;

  // ── isolation, both directions ────────────────────────────────────────
  const widgetBtn = inside(counter, '#counter');
  const hostBtn   = el('#host-button');
  // The host page says button { background: red !important; font-size: 40px }.
  out.widgetBg   = getComputedStyle(widgetBtn).backgroundColor;
  out.widgetSize = getComputedStyle(widgetBtn).fontSize;
  // The widget says button { background: green }. The host's own button must
  // be untouched by it.
  out.hostBg     = getComputedStyle(hostBtn).backgroundColor;

  // ── the selector form ─────────────────────────────────────────────────
  const legacy = el('#legacy');
  out.legacyMounted = await until(() => !!inside(legacy, '#counter'));
  out.legacyProp    = inside(legacy, '#counter')?.textContent;
  // The same script twice, on the SELECTOR form. The element form is guarded by
  // customElements — the document's registry, which both copies of the module
  // see; the selector form was guarded by a module-scoped WeakMap, which each
  // copy has its own of, so the second copy mounted a second component into the
  // same box. This page has always built that case and always measured the
  // other node.
  out.selectorNodes = legacy.shadowRoot.querySelectorAll('#counter').length;

  // ── the directory form, and an imported stylesheet ────────────────────
  const lead = el('mt-lead-form');
  out.leadMounted = await until(() => !!inside(lead, '#submit'));
  out.leadProp    = inside(lead, '#field')?.value;
  // The host says .lead-form { border: 0 !important } and label { display: none }.
  out.leadBorder  = getComputedStyle(inside(lead, '.lead-form')).borderTopColor;
  out.leadLabel   = getComputedStyle(inside(lead, 'label')).display;
  inside(lead, '#submit')?.click();
  out.leadAfterClick = inside(lead, '#submit')?.textContent;

  // ── loaded twice ──────────────────────────────────────────────────────
  // Counter.js is on the page twice. One widget per element, or a host page
  // that includes the snippet in two places gets two of everything.
  out.counterNodes = counter.shadowRoot.querySelectorAll('#counter').length;

  // ── an element that arrives later ─────────────────────────────────────
  // A tag manager, a CMS, a single-page host router. Without the observer the
  // script has already run and the widget never appears.
  const late = document.createElement('div');
  late.className = 'mt-counter';
  late.dataset.start = '42';
  el('#late').appendChild(late);
  out.lateMounted = await until(() => !!inside(late, '#counter'));
  out.lateProp    = inside(late, '#counter')?.textContent;

  // ── one host element that cannot be mounted into ──────────────────────
  // #poison holds a CLOSED shadow root, so attachShadow throws. It is FIRST in
  // the document, so an unguarded loop abandons #legacy and every widget after
  // it. Both halves are asserted: the ones after it mount, AND the failure was
  // reported — a guard that swallowed it is the failure a merchant cannot debug.
  out.poisonReported = (window.__widgetLog ?? []).some(m => m.includes('could not mount'));

  // ── a host page that MOVES a mounted widget ───────────────────────────
  // Mesa's destroy() removes the mount anchor and leaves the rendered DOM, so a
  // reparent used to append a second live widget beside the first — once per
  // move, forever, each with its own state and its own traffic.
  const mover = document.createElement('mt-counter');
  mover.dataset.start = '7';
  document.body.appendChild(mover);
  await until(() => !!inside(mover, '#counter'));
  inside(mover, '#counter').click();
  el('#elsewhere').appendChild(mover);
  await sleep(50);
  out.movedNodes = mover.shadowRoot.querySelectorAll('#counter').length;
  // A move that cleared the root and did not remount passes the count alone.
  inside(mover, '#counter')?.click();
  out.movedText = inside(mover, '#counter')?.textContent;

  // ── a host page that REMOVES a selector-form widget ───────────────────
  // The element form tears down through disconnectedCallback. The selector form
  // has no lifecycle of its own, so a host SPA that removed the node left the
  // component, its effects and its subscriptions running with nothing pointing
  // at them. The observer watches removals now, not only additions.
  const doomed = document.createElement('div');
  doomed.className = 'mt-counter';
  doomed.dataset.start = '3';
  el('#elsewhere').appendChild(doomed);
  await until(() => !!inside(doomed, '#counter'));
  out.removedMountedFirst = doomed.shadowRoot.querySelectorAll('#counter').length;

  // Removed as part of a SUBTREE, which is what a host framework actually does:
  // it empties a container and never touches our element itself.
  const wrapper = document.createElement('div');
  el('#elsewhere').appendChild(wrapper);
  wrapper.appendChild(doomed);
  await sleep(30);
  wrapper.remove();
  await sleep(50);
  out.removedTornDown = doomed.shadowRoot.querySelectorAll('#counter').length;

  // The control: a sibling that was never removed is still mounted and still
  // live. A teardown that swept every widget on the page would pass the row
  // above and break the app.
  const survivor = document.createElement('div');
  survivor.className = 'mt-counter';
  survivor.dataset.start = '1';
  el('#elsewhere').appendChild(survivor);
  await until(() => !!inside(survivor, '#counter'));
  inside(survivor, '#counter').click();
  out.survivorText = inside(survivor, '#counter')?.textContent;

  // ── a shadow root the HOST already attached ───────────────────────────
  // Reading el.shadowRoot and falling back to attachShadow treats a root the
  // host page made as one of ours. Appending into it puts the widget's
  // stylesheet into THEIR adoptedStyleSheets and scopes Mesa's delegation to
  // their content, so the isolation the shadow root is for runs in neither
  // direction. The widget nests a root of its own inside theirs instead.
  const pre = document.createElement('div');
  pre.className = 'mt-counter';
  pre.dataset.start = '7';
  const hostRoot = pre.attachShadow({ mode: 'open' });
  hostRoot.innerHTML = '<p id="host-own">the host page put this here</p>';
  const hostSheets = hostRoot.adoptedStyleSheets.length;
  el('#elsewhere').appendChild(pre);

  // It still mounts — refusing the element would be a widget that silently
  // does not appear on a page where it could.
  out.preMounted = await until(() => !!hostRoot.querySelector('div')?.shadowRoot);
  // Null-safe on purpose. A dereference here aborts the whole probe, so a
  // regression in this one section would report as every row after it failing
  // too — which is what a first measurement of it actually did.
  const nested = hostRoot.querySelector('div')?.shadowRoot ?? null;
  out.preRendered = nested ? nested.querySelectorAll('#counter').length : -1;

  // The host's own content is untouched, and their root did not adopt our
  // stylesheet. This is the assertion the whole change is for.
  out.preHostContent = hostRoot.querySelector('#host-own')?.textContent;
  out.preHostSheets  = hostRoot.adoptedStyleSheets.length - hostSheets;
  // …and ours DID land, one level down. Without this the row above passes for
  // a widget that simply never got a stylesheet.
  out.preOwnSheets   = !!nested && nested.adoptedStyleSheets.length > 0;

  // Taken back off, the wrapper goes whole — the sweep walks the root we
  // mounted into and cannot reach a node one level up.
  pre.remove();
  await sleep(50);
  out.preWrapperGone   = hostRoot.querySelectorAll('div').length;
  out.preHostSurvived  = hostRoot.querySelector('#host-own')?.textContent;

  // ── @frontierjs/css inside a shadow root ──────────────────────────────
  // Invariant 13's kit declares its tokens on :root, which matches nothing in a
  // shadow tree. Read the TOKEN, not a computed background: a background passes
  // on any theme change, and the mechanism is whether the declaration lands.
  const kit = el('mt-kit');
  out.kitMounted   = await until(() => !!inside(kit, '#kit'));
  out.kitToken     = getComputedStyle(inside(kit, '#kit')).getPropertyValue('--color-primary').trim();
  // And it must not have leaked into the page that hosts it.
  out.kitTokenLeak = getComputedStyle(el('#host-button')).getPropertyValue('--color-primary').trim();

  return out;
})()
`

const CSP_PROBE = `
(async () => {
  const out = { cspViolations: [] };
  document.addEventListener('securitypolicyviolation', e => out.cspViolations.push(e.violatedDirective));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms = 4000) => {
    for (let w = 0; w < ms; w += 25) { if (fn()) return true; await sleep(25); }
    return false;
  };
  const inside = (host, sel) => host?.shadowRoot?.querySelector(sel);

  const counter = document.querySelector('mt-counter');
  out.cspMounted = await until(() => !!inside(counter, '#counter'));
  // Mesa's own scoped style — adoptedStyleSheets, never gated by CSP. If this
  // one goes red the page proves nothing about the imported sheet beside it.
  out.cspScopedBg = getComputedStyle(inside(counter, '#counter')).backgroundColor;

  const lead = document.querySelector('mt-lead-form');
  await until(() => !!inside(lead, '.lead-form'));
  // The IMPORTED stylesheet — the one that used to arrive as a <style> element
  // and be dropped in silence.
  out.cspImportedBorder = getComputedStyle(inside(lead, '.lead-form')).borderTopColor;
  return out;
})()
`

// ─── Drive Chrome ─────────────────────────────────────────────────────────────

const profile = `/tmp/fjs-widget-${process.pid}`
const chrome  = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })

const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''
  const timer = setTimeout(() => reject(new Error('Chrome did not report a debugging port')), 15000)
  chrome.stderr.on('data', (d) => {
    buf += d
    const m = buf.match(/ws:\/\/[^\s]+/)
    if (m) { clearTimeout(timer); resolve(m[0]) }
  })
})

const { default: WebSocket } = await import('ws').catch(() => ({ default: globalThis.WebSocket }))
const ws = new WebSocket(wsUrl)
await new Promise(r => ws.addEventListener('open', r))

let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}, sessionId) => new Promise(r => {
  const n = ++id
  pending.set(n, r)
  ws.send(JSON.stringify({ id: n, method, params, sessionId }))
})

const { result: target } = await send('Target.createTarget', { url: 'about:blank' })
const { result: attach } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
const session = attach.sessionId

await send('Page.enable', {}, session)
await send('Runtime.enable', {}, session)
await send('Page.navigate', { url: origin }, session)
await new Promise(r => setTimeout(r, 1500))

const { result } = await send('Runtime.evaluate', {
  expression: PROBE, awaitPromise: true, returnByValue: true,
}, session)

// ── the same widgets, on a host page with a strict CSP ────────────────────────
// A bank, a government site, anything behind a WAF: `style-src 'self'` blocks an
// injected <style> element and nothing in the widget can observe it, because
// Mesa's own scoped styles arrive through adoptedStyleSheets and are not gated.
// So it half-renders. The page asserts BOTH stylesheets under one policy — a fix
// that broke both would look like a fix that broke neither.
await send('Page.navigate', { url: `${origin}/csp` }, session)
await new Promise(r => setTimeout(r, 1500))
const { result: csp } = await send('Runtime.evaluate', {
  expression: CSP_PROBE, awaitPromise: true, returnByValue: true,
}, session)

const got = { ...fileChecks, ...headerChecks, ...(result?.result?.value ?? {}), ...(csp?.result?.value ?? {}) }

chrome.kill()
server.close()
await widgetOrigin.close()

// ─── Assertions ───────────────────────────────────────────────────────────────

const EXPECTED = {
  // Two widgets in, two scripts out — and nothing else. A .css beside them is a
  // request the host page was never told to make.
  emitted:            ['Counter.js', 'Kit.js', 'LeadForm.js'],
  hasModuleSyntax:    false,   // IIFE — a classic <script> can run it
  hasOwnCss:          true,    // the component's <style>, inside the script
  leadHasImportedCss: true,    // an imported stylesheet, folded in

  // The deployment's own answers, from the module that ships as widgets/deploy/.
  cors:               '*',
  entryImmutable:     false,   // the URL is permanent; the file behind it is not
  contentType:        'text/javascript; charset=utf-8',
  traversal:          404,     // `..` may not walk out of the served directory

  upgraded:           true,
  propFromData:       'count: 5',        // data-start="5" reached the prop
  afterTwoClicks:     'count: 7',        // delegation is live inside the shadow root

  widgetBg:           'rgb(0, 128, 0)',  // its own green, not the host's red !important
  widgetSize:         '20px',            // not the host's 40px !important
  hostBg:             'rgb(255, 0, 0)',  // the host's own button, untouched by the widget

  legacyMounted:      true,
  legacyProp:         'count: 100',

  leadMounted:        true,
  leadProp:           'ABC-1',
  leadBorder:         'rgb(0, 0, 255)',  // its imported stylesheet won, not the host's border: 0
  leadLabel:          'inline',          // the host's label { display: none } did not reach in
  leadAfterClick:     'sent',

  counterNodes:       1,                 // the script ran twice; one widget
  selectorNodes:      1,                 // …and the selector form, which is the half that failed
  lateMounted:        true,
  lateProp:           'count: 42',

  // One element on the page cannot be mounted into. Everything after it still
  // mounts (legacyMounted, leadMounted, kitMounted above), and it was reported.
  poisonReported:     true,

  movedNodes:         1,                 // a reparent is one widget, not two
  movedText:          'count: 8',        // …and it is a fresh, live mount: props re-read, click counts

  // FJS-825 — the selector form had no teardown at all.
  removedMountedFirst: 1,                 // it really was mounted before removal
  removedTornDown:     0,                 // …and removing its ancestor tore it down
  survivorText:       'count: 2',         // the control: an untouched sibling is still live

  // A shadow root the HOST attached — the widget nests rather than moving in.
  preMounted:      true,
  preRendered:     1,
  preHostContent:  'the host page put this here',
  preHostSheets:   0,      // their root adopted nothing of ours
  preOwnSheets:    true,   // …and ours landed one level down, so 0 above means isolated
  preWrapperGone:  0,      // the nested root is removed whole
  preHostSurvived: 'the host page put this here',

  kitMounted:         true,
  kitToken:           '#0d83dd',         // @frontierjs/css, resolved inside a shadow root
  kitTokenLeak:       '',                // and not leaked into the host page

  cspMounted:         true,
  cspScopedBg:        'rgb(0, 128, 0)',  // adoptedStyleSheets: never gated, the control
  cspImportedBorder:  'rgb(0, 0, 255)',  // the imported sheet, under style-src 'self'
  cspViolations:      [],

  errors:             [],
}

let failed = 0
for (const [key, want] of Object.entries(EXPECTED)) {
  const have = got[key]
  const ok = JSON.stringify(have) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${key}`)
  if (!ok) {
    console.log(`         want ${JSON.stringify(want)}`)
    console.log(`         have ${JSON.stringify(have)}`)
  }
}

console.log()
if (failed) {
  console.log(`${failed} assertion(s) failed`)
  process.exit(1)
}
console.log(`all ${Object.keys(EXPECTED).length} assertions passed`)
process.exit(0)
