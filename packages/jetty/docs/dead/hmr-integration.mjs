// HMR integration test — verifies the full Mesa HMR pipeline:
//   1. mesa-plugin's injectJettyHMR wraps compiled output correctly
//   2. mounted component registers itself on globalThis.__jettyMesa
//   3. __jettyMesa.hot_update swaps the component in-place
//
// Runs against a real jsdom + real Mesa + real jetty mount path.
// Doesn't run a full Vite build — too heavy; we test the wrapping output
// directly.

import { JSDOM } from 'jsdom'
import { compileSource } from '/home/claude/repo/reading-list/frontierjs/mesa/compiler.js'
import { setRenderEnvironment } from '/home/claude/repo/reading-list/frontierjs/mesa/runtime.js'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── Set up jsdom ────────────────────────────────────────────────────────────
const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/' })
const { window } = dom
for (const k of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Comment', 'Text', 'DocumentFragment', 'ShadowRoot', 'MutationObserver', 'Event', 'CustomEvent']) global[k] = window[k]
global.requestAnimationFrame = (fn) => setTimeout(fn, 0)
global.queueMicrotask = (fn) => Promise.resolve().then(fn)
global.location = window.location
setRenderEnvironment(true)

// ── Tiny test helpers ──────────────────────────────────────────────────────
let pass = 0, fail = 0
function ok(msg) { pass++; console.log('  ✓ ' + msg) }
function bad(msg, info = '') { fail++; console.log('  ✗ ' + msg + (info ? ' — ' + info : '')) }
function eq(actual, expected, msg) {
  if (actual === expected) ok(msg)
  else bad(msg, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// ── Apply the mesa-plugin's injectJettyHMR (extract via dynamic import) ───
// We can't import it directly (it's not exported), so re-implement the call
// path: load mesa-plugin, instantiate it with dev:true, run transform on a
// .mesa source.
const { mesaPlugin } = await import('/home/claude/repo/reading-list/frontierjs/jetty/src/build/mesa-plugin.js')

const tmp = mkdtempSync(join(tmpdir(), 'jetty-hmr-test-'))

const v1 = `<script>
  let count = 0
  function inc() { count = count + 1 }
</script>
<button on:click={inc}>v1: {count}</button>`

const v2 = `<script>
  let count = 0
  function inc() { count = count + 2 }
</script>
<button on:click={inc}>v2: {count}</button>`

const v1Path = join(tmp, 'Test.mesa')
const v2Path = join(tmp, 'Test.mesa')  // same path → same hmr id

// Compile via the plugin in dev mode
const plugin = mesaPlugin({
  extRoot: '/home/claude/repo/reading-list',
  dev: true,
  // Use the bundled Mesa
  mesaPackageRoot: '/home/claude/repo/reading-list/frontierjs/mesa',
})

// Drive the plugin lifecycle the way Vite would
const ctx = {
  warn: (m) => {},
  error: (m) => { throw new Error(m) },
}
plugin.configResolved.call(ctx, { command: 'serve', root: '/home/claude/repo/reading-list' })
await plugin.buildStart.call(ctx)

writeFileSync(v1Path, v1)
const r1 = await plugin.transform.call(ctx, v1, v1Path)
if (!r1?.code) { bad('plugin returned no code for v1'); process.exit(1) }

// Verify HMR wrapping is present
if (r1.code.includes('__mesaOrigFn')) ok('v1 has __mesaOrigFn')
else bad('v1 missing __mesaOrigFn')

if (r1.code.includes('__jettyMesa.register')) ok('v1 has __jettyMesa.register call')
else bad('v1 missing __jettyMesa.register')

if (r1.code.includes('__hmrMark = document.createComment')) ok('v1 wrapper creates hmrMark')
else bad('v1 missing hmrMark creation')

if (r1.code.includes('export function __setMark')) ok('v1 exports __setMark')
else bad('v1 missing __setMark export')

if (r1.code.includes('export { __mesaOrigFn }')) ok('v1 re-exports __mesaOrigFn')
else bad('v1 missing __mesaOrigFn re-export')

// ── Now load the dev-client to set up globalThis.__jettyMesa ──────────────
await import('/home/claude/repo/reading-list/frontierjs/jetty/src/dev/dev-client.js')
if (typeof globalThis.__jettyMesa?.register === 'function') ok('__jettyMesa.register installed')
else bad('__jettyMesa not installed')
if (typeof globalThis.__jettyMesa?.hot_update === 'function') ok('__jettyMesa.hot_update installed')
else bad('hot_update not installed')

// ── Build runnable modules from compiled output ───────────────────────────
// The compiled output imports @frontierjs/mesa/runtime — replace with absolute file path.
function rewriteImports(code) {
  return code
    .replace(/from\s+['"]@frontierjs\/mesa\/runtime\.js['"]/g, `from '/home/claude/repo/reading-list/frontierjs/mesa/runtime.js'`)
    .replace(/from\s+['"]@frontierjs\/mesa\/runtime['"]/g, `from '/home/claude/repo/reading-list/frontierjs/mesa/runtime.js'`)
}

const v1ModPath = join(tmp, 'v1-mod.mjs')
writeFileSync(v1ModPath, rewriteImports(r1.code))
const v1Mod = await import(v1ModPath)
if (typeof v1Mod.default === 'function') ok('v1 default export is fn')
if (typeof v1Mod.__mesaOrigFn === 'function') ok('v1 __mesaOrigFn export is fn')
if (typeof v1Mod.__setMark === 'function') ok('v1 __setMark export is fn')

// ── Mount the v1 component using jetty's mount() ──────────────────────────
const { mount } = await import('/home/claude/repo/reading-list/frontierjs/jetty/src/runtime/mount.js')

const root = window.document.getElementById('root')
await mount(root, v1Mod.default, {})

// Verify mounted output contains "v1:"
if (root.textContent.includes('v1:')) ok('v1 component mounted (text: ' + root.textContent.trim() + ')')
else bad('v1 not visible', `text: ${root.textContent}`)

// Verify a mesa:hmr comment is present
const allComments = []
const walker = window.document.createTreeWalker(root, /* SHOW_COMMENT */ 0x80)
let n
while ((n = walker.nextNode())) allComments.push(n.nodeValue)
const hmrMarks = allComments.filter((c) => c.includes('mesa:hmr:'))
if (hmrMarks.length > 0) ok(`hmrMark comment present (${hmrMarks.length})`)
else bad('hmrMark comment missing', `found: ${JSON.stringify(allComments)}`)

// ── Now compile v2 and trigger hot update ─────────────────────────────────
const r2 = await plugin.transform.call(ctx, v2, v2Path)
if (!r2?.code) { bad('plugin returned no code for v2'); process.exit(1) }
const v2ModPath = join(tmp, 'v2-mod.mjs')
writeFileSync(v2ModPath, rewriteImports(r2.code))
const v2Mod = await import(v2ModPath)

// Call hot_update — id should match the relativized id mesa-plugin emits.
// Since v1Path and v2Path are both /tmp/.../Test.mesa, the id is the path
// relative to extRoot. extRoot=/home/claude/repo/reading-list, but the file
// is in /tmp/... — so id is the full /tmp/.../Test.mesa absolute path.
const expectedId = v1Path.replace(/\\/g, '/')

const swapped = globalThis.__jettyMesa.hot_update(expectedId, v2Mod)
if (swapped > 0) ok(`hot_update swapped ${swapped} instance(s)`)
else bad('hot_update did not swap', `id=${expectedId}, registry has=${Array.from((globalThis.__jettyMesa.has?.bind?.(globalThis.__jettyMesa) || (() => false))(expectedId) ? [expectedId] : ['(none)'])}`)

// Verify v2 is now visible
if (root.textContent.includes('v2:')) ok('v2 visible after hot_update (text: ' + root.textContent.trim() + ')')
else bad('v2 not visible after hot_update', `text: ${root.textContent}`)

// Click the new v2 button and verify it uses v2's increment-by-2 logic
const btn = root.querySelector('button')
if (btn) {
  btn.click()
  await new Promise((r) => setTimeout(r, 10))
  // v2 increments by 2 per click; one click → "v2: 2"
  if (root.textContent.includes('v2: 2')) ok('v2 logic active (click → +2)')
  else bad('v2 logic not active', `text after click: ${root.textContent}`)
} else {
  bad('no button found after hot_update')
}

// ── Verify multiple hot updates compound correctly ────────────────────────
const v3 = `<script>
  let count = 99
</script>
<button>v3: {count}</button>`
const v3ModPath = join(tmp, 'v3-mod.mjs')
const r3 = await plugin.transform.call(ctx, v3, v1Path)
writeFileSync(v3ModPath, rewriteImports(r3.code))
const v3Mod = await import(v3ModPath)
const swapped3 = globalThis.__jettyMesa.hot_update(expectedId, v3Mod)
if (swapped3 === 1) ok('second hot_update swapped 1 instance')
else bad('second hot_update count wrong', String(swapped3))
if (root.textContent.includes('v3: 99')) ok('v3 visible after second hot_update')
else bad('v3 not visible', `text: ${root.textContent}`)

// ── Verify hot_update with no registered instances returns 0 ──────────────
const noopResult = globalThis.__jettyMesa.hot_update('does-not-exist', () => {})
if (noopResult === 0) ok('hot_update on unknown id returns 0')
else bad('hot_update on unknown id wrong', String(noopResult))

// ── Summary ────────────────────────────────────────────────────────────────
console.log()
if (fail === 0) console.log(`HMR test: ${pass} passed, ${fail} failed ✓`)
else            console.log(`HMR test: ${pass} passed, ${fail} failed ✗`)
process.exit(fail === 0 ? 0 : 1)
