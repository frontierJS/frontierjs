// Full-flow HMR test — runs against the actual bundled dock.js produced by
// jetty-dev-ext. Verifies that:
//   1. globalThis.__jettyMesa registry is installed when bundle loads
//   2. globalThis.__JETTY_HMR_APPS["dock"] is published with __mesaOrigFn/__setMark
//   3. Mount happens (sentinel-guarded — only first run)
//   4. After modifying App.mesa and rebuilding, dynamic-importing the new
//      dock.js re-publishes the new App, and __jettyMesa.hot_update swaps it.
//
// This is the closest we can get to real-Chrome behavior in node — it loads
// the actual production-shaped bundles, just in jsdom instead of Chrome.

import { JSDOM } from 'jsdom'
import { writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execSync } from 'node:child_process'

// ── Setup jsdom ────────────────────────────────────────────────────────────
const DOCK_HTML_PATH = '/home/claude/repo/reading-list/dist/chrome/dock.html'
const DOCK_DIR       = dirname(DOCK_HTML_PATH)
if (!existsSync(DOCK_HTML_PATH)) {
  console.error('Need a dev build first: cd /home/claude/repo/reading-list && npx jetty-dev-ext --root=. --browser=chrome')
  process.exit(1)
}

const html = readFileSync(DOCK_HTML_PATH, 'utf8')
const dom = new JSDOM(html, {
  url: `file://${DOCK_HTML_PATH}`,
  runScripts: 'outside-only',
  pretendToBeVisual: true,
})
const { window } = dom
for (const k of ['window','document','HTMLElement','Element','Node','Comment','Text','DocumentFragment','ShadowRoot','MutationObserver','Event','CustomEvent','customElements']) {
  if (window[k] !== undefined) {
    try { global[k] = window[k] } catch {}
  }
}
global.location = window.location
global.requestAnimationFrame = (fn) => setTimeout(fn, 0)
global.queueMicrotask = (fn) => Promise.resolve().then(fn)

// Stub chrome — popup needs chrome.runtime.connect
const fakePort = {
  _listeners: { message: [], disconnect: [] },
  postMessage(msg) {
    // Simulate a harbor that always responds with empty results
    const reply = { type: 'response', id: msg.id, result: { items: [] } }
    setTimeout(() => {
      for (const fn of this._listeners.message) fn(reply, this)
    }, 0)
  },
  onMessage:    { addListener: (fn) => fakePort._listeners.message.push(fn) },
  onDisconnect: { addListener: (fn) => fakePort._listeners.disconnect.push(fn) },
  disconnect()  {},
}
global.chrome = {
  runtime: {
    id: 'fake-ext-id',
    getURL: (p) => `file://${DOCK_DIR}/${p}`,
    connect: () => fakePort,
    openOptionsPage: () => {},
  },
  tabs: { query: async () => [], create: async () => {} },
  storage: { local: { get: async () => ({}), set: async () => {}, clear: async () => {} } },
}

let pass = 0, fail = 0
function ok(msg)  { pass++; console.log('  ✓ ' + msg) }
function bad(msg, info='') { fail++; console.log('  ✗ ' + msg + (info ? ' — ' + info : '')) }

// Stub relList.supports("modulepreload") to return true so Vite's polyfill
// no-ops — otherwise it tries to fetch each modulepreload link via fetch(),
// which doesn't support file:// URLs in node.
const origCreateElement = window.document.createElement.bind(window.document)
window.document.createElement = function(tag) {
  const el = origCreateElement(tag)
  if (tag === 'link' && el.relList) {
    const origSupports = el.relList.supports?.bind(el.relList)
    el.relList.supports = (token) => token === 'modulepreload' ? true : (origSupports?.(token) ?? false)
  }
  return el
}

// ── Stub WebSocket so dev-client doesn't try real connection ──────────────
let wsClient = null
class FakeWS {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this._listeners = { open: [], message: [], close: [], error: [] }
    setTimeout(() => {
      this.readyState = 1
      for (const fn of this._listeners.open) fn({})
      wsClient = this
    }, 0)
  }
  addEventListener(ev, fn) { (this._listeners[ev] ||= []).push(fn) }
  send(_data) {}
  close() {
    this.readyState = 3
    for (const fn of this._listeners.close) fn({})
  }
  // Test helper
  __deliver(msg) {
    for (const fn of this._listeners.message) fn({ data: JSON.stringify(msg) })
  }
}
global.WebSocket = FakeWS

// ── Load the actual bundled dock.js ───────────────────────────────────────
console.log('Loading bundled dock.js...')

// The bundled dock.js uses chunk imports relative to its own path.
// Dynamic import via file:// URL respects relative imports.
const dockMod = await import(`file://${DOCK_DIR}/dock.js`)
// Wait a tick for top-level await + WS connection
await new Promise((r) => setTimeout(r, 100))

// 1. Registry installed
if (typeof globalThis.__jettyMesa?.register === 'function') ok('__jettyMesa.register installed')
else bad('__jettyMesa not installed')
if (typeof globalThis.__jettyMesa?.hot_update === 'function') ok('__jettyMesa.hot_update installed')
else bad('hot_update not installed')

// 2. App published
const App = globalThis.__JETTY_HMR_APPS?.dock
if (typeof App === 'function') ok('App published in __JETTY_HMR_APPS["dock"]')
else { bad('App missing'); console.log('keys:', Object.keys(globalThis.__JETTY_HMR_APPS || {})) }

if (typeof App?.__mesaOrigFn === 'function') ok('App has __mesaOrigFn property')
else bad('App.__mesaOrigFn missing')

if (typeof App?.__setMark === 'function') ok('App has __setMark property')
else bad('App.__setMark missing')

// 3. Mount happened — sentinel set, root has content
if (globalThis.__JETTY_MOUNTED_DOCK__) ok('mount sentinel set')
else bad('sentinel not set')

if (globalThis.__JETTY_DEV_CLIENT_STARTED__) ok('dev-client started')
else bad('dev-client not started')

const root = window.document.getElementById('app')
const initialText = root?.textContent ?? ''
console.log('  [info] initial root.textContent length:', initialText.length)

// Even with empty data the dock should render the static structure
// (header, save button, footer) — empty list is fine.
if (initialText.length > 0) ok(`dock rendered (${initialText.length} chars)`)
else bad('dock rendered empty', 'innerHTML: ' + (root?.innerHTML?.slice(0,200) ?? 'null'))

// 4. Find the hmrMark comment
const treeWalker = window.document.createTreeWalker(root, /* SHOW_COMMENT */ 0x80)
let n, hmrComments = []
while ((n = treeWalker.nextNode())) {
  if (n.nodeValue && n.nodeValue.includes('mesa:hmr:')) hmrComments.push(n.nodeValue.trim())
}
if (hmrComments.length > 0) ok(`hmrMark comment present: ${hmrComments[0]}`)
else bad('hmrMark missing — registration won\'t work')

// 5. Check registration actually happened
const moduleId = 'src/dock/App.mesa'
if (globalThis.__jettyMesa.has(moduleId)) ok(`registry has entry for ${moduleId}`)
else bad('no registry entry for dock', `keys: ${Array.from(globalThis.__jettyMesa.has?.toString() || ['?'])}`)

// ── Now simulate a hot update ──────────────────────────────────────────────
// We need to:
//   1. Modify src/dock/App.mesa
//   2. Re-run jetty-dev-ext to rebuild
//   3. Trigger the dev-client mesa:hot-update event
//   4. Verify the dock UI reflects the new content
//
// Step 2 is heavy (~4s). Skip the real rebuild — instead, monkey-patch the
// bundle output: write an alternative dock.js with a modified component that
// returns "HMR_MARKER" as text, then send the WS event and verify the swap.

console.log()
console.log('Simulating hot update by writing modified dock.js to disk...')

// Read the current dock.js, find the main string ("Reading List") and replace
// with a marker. This simulates what a user-edited rebuild would produce.
const currentDockJs = readFileSync(`${DOCK_DIR}/dock.js`, 'utf8')
// Substitute one of the visible strings in the bundle with a marker.
// 'Reading List' appears in the dock template.
const HMR_MARKER = 'HMR_HOT_MARKER_XYZ'
const modifiedDockJs = currentDockJs.replace(/Reading List/g, HMR_MARKER)
if (!modifiedDockJs.includes(HMR_MARKER)) {
  bad('could not find a string to substitute in dock.js — text-substitution failed')
} else {
  // Write to alternate path so first import doesn't get overwritten cache.
  // Actually browser cache is per-URL. We'll just write back to dock.js so
  // a cache-buster query brings in the new version.
  writeFileSync(`${DOCK_DIR}/dock.js`, modifiedDockJs)
  ok('wrote modified dock.js')

  // Trigger the hot-update event via the fake WebSocket
  if (!wsClient) {
    bad('no WS client connected')
  } else {
    wsClient.__deliver({
      kind: 'mesa:hot-update',
      target: 'dock',
      moduleId: 'src/dock/App.mesa',
      file: 'src/dock/App.mesa',
    })
    // Wait for the dynamic import + swap
    await new Promise((r) => setTimeout(r, 200))

    // Check root reflects new content
    const newText = root.textContent
    if (newText.includes(HMR_MARKER)) {
      ok('hot update applied — DOM shows new content')
    } else {
      bad('hot update did not swap', `text snippet: ${newText.slice(0, 200)}`)
    }

    // Sentinel still set (we didn't remount)
    if (globalThis.__JETTY_MOUNTED_DOCK__) ok('mount sentinel still set after HMR')
    else bad('sentinel lost')
  }

  // Restore original
  writeFileSync(`${DOCK_DIR}/dock.js`, currentDockJs)
}

console.log()
if (fail === 0) console.log(`Full-flow HMR test: ${pass} passed, 0 failed ✓`)
else            console.log(`Full-flow HMR test: ${pass} passed, ${fail} failed ✗`)
process.exit(fail === 0 ? 0 : 1)
