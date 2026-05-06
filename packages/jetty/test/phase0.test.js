// Phase 0 smoke test.
//
// What this verifies:
//   1. Build succeeds against the basic-ext fixture
//   2. dist/chrome/ contains all required artifacts
//   3. manifest.json is valid MV3 w/ expected references
//   4. References in manifest resolve to actual files
//   5. Module imports work in Node (defineHarbor doesn't auto-boot w/o chrome)
//
// What this does NOT verify (out of scope until later phases):
//   - Real Chrome loads the extension (manual; phase 0 exit criterion)
//   - Port protocol works (Phase 1)
//   - Junction connects (Phase 2)

import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildExtension } from '../src/build/index.js'

const HERE        = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(HERE, 'fixtures/basic-ext')

let pass = 0
let fail = 0

function ok(msg)        { pass++; console.log('  ✓', msg) }
function bad(msg, info) { fail++; console.log('  ✗', msg); if (info) console.log('     →', info) }
function group(name)    { console.log(`\n[${name}]`) }

// --- Run build ---

group('build')
let result
try {
  result = await buildExtension({ root: FIXTURE_DIR, browser: 'chrome', verbose: false })
  ok('build succeeded')
} catch (err) {
  bad('build threw', err.message)
  process.exit(1)
}

const dist = result.distDir

// --- Artifacts ---

group('artifacts')
const required = ['manifest.json', 'harbor.js', 'dock.html', 'dock.js']
for (const f of required) {
  const path = join(dist, f)
  if (existsSync(path) && statSync(path).isFile()) ok(`exists: ${f}`)
  else bad(`missing: ${f}`, path)
}

// Icon copied
if (existsSync(join(dist, 'icons/icon-128.png'))) ok('public/ icons copied')
else bad('icon missing in dist')

// --- Manifest shape ---

group('manifest')
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))

if (manifest.manifest_version === 3)              ok('manifest_version = 3')
else                                              bad('manifest_version wrong', manifest.manifest_version)

if (manifest.name === 'Phase 0 Smoke Ext')        ok('name correct')
else                                              bad('name wrong', manifest.name)

if (manifest.background?.service_worker === 'harbor.js') ok('background.service_worker → harbor.js')
else                                              bad('background.service_worker wrong', manifest.background)

if (manifest.background?.type === 'module')       ok('background.type = module')
else                                              bad('background.type wrong', manifest.background?.type)

if (manifest.action?.default_popup === 'dock.html') ok('action.default_popup → dock.html')
else                                              bad('action.default_popup wrong', manifest.action)

if (Array.isArray(manifest.permissions) && manifest.permissions.includes('storage')) {
  ok('permissions includes storage')
} else {
  bad('permissions missing storage', manifest.permissions)
}

// Fixture grew an Island in Phase 4 — expect scripting permission auto-added.
if (manifest.permissions.includes('scripting')) ok('scripting perm auto-added (fixture has 1 island)')
else                                            bad('scripting perm missing despite island in config')

// --- Manifest refs resolve to files ---

group('manifest references resolve')
function refExists(ref, label) {
  const p = join(dist, ref)
  if (existsSync(p)) ok(`ref exists: ${label} → ${ref}`)
  else bad(`broken ref: ${label} → ${ref}`)
}
refExists(manifest.background.service_worker, 'background.service_worker')
refExists(manifest.action.default_popup,      'action.default_popup')
for (const [size, p] of Object.entries(manifest.icons || {})) refExists(p, `icons[${size}]`)

// --- Module behavior ---

group('module behavior in node')

// defineHarbor in Node should NOT auto-boot (no chrome global)
const { defineHarbor } = await import('../src/index.js')
const harbor = defineHarbor({ run: async () => { throw new Error('should not auto-run in node') } })

if (harbor && typeof harbor._boot === 'function') ok('defineHarbor returns object with _boot()')
else bad('defineHarbor return shape wrong', JSON.stringify(harbor))

if (harbor._ready === null) ok('no auto-boot in non-extension context (_ready === null)')
else bad('auto-booted in node — should be inert', String(harbor._ready))

// Manual boot via _boot() w/ no chrome — storage path returns inert area, run still executes
let manualBootRan = false
const harbor2 = defineHarbor({ run: async () => { manualBootRan = true } })
await harbor2._boot()
if (manualBootRan) ok('manual _boot() invokes run()')
else bad('manual _boot() did not invoke run()')

// defineDock overload: function and object forms
const { defineDock } = await import('../src/index.js')
try {
  defineDock(() => {}); ok('defineDock(fn) accepted')
} catch (e) { bad('defineDock(fn) threw', e.message) }
try {
  defineDock({ app: () => {} }); ok('defineDock({app}) accepted')
} catch (e) { bad('defineDock({app}) threw', e.message) }
try {
  defineDock({ render: () => {} }); ok('defineDock({render}) accepted as app shorthand')
} catch (e) { bad('defineDock({render}) threw', e.message) }
try {
  defineDock({})
  bad('defineDock({}) accepted — should reject (no app)')
} catch (e) { ok('defineDock({}) rejected w/ clear error') }

// Island validation
const { defineIsland } = await import('../src/index.js')
try {
  defineIsland({})
  bad('defineIsland({}) accepted — should require app or main')
} catch (e) { ok('defineIsland({}) rejected (need app or main)') }
try {
  defineIsland({ app: () => {}, world: 'MAIN' })
  bad('defineIsland({app, world: MAIN}) accepted — should reject')
} catch (e) { ok('defineIsland({app, world: MAIN}) rejected') }
try {
  defineIsland({ main: async () => {}, world: 'MAIN' })
  ok('defineIsland({main, world: MAIN}) accepted')
} catch (e) { bad('defineIsland({main, world: MAIN}) threw', e.message) }

// Protocol port name format
const { makePortName, parsePortName, PROTOCOL_VERSION } = await import('../src/runtime/protocol.js')
const name = makePortName('island', 'sa-leads')
if (name === `island:sa-leads:v${PROTOCOL_VERSION}`) ok('makePortName format correct')
else bad('makePortName format wrong', name)
const parsed = parsePortName(name)
if (parsed?.type === 'island' && parsed.id === 'sa-leads' && parsed.version === PROTOCOL_VERSION) {
  ok('parsePortName roundtrip')
} else {
  bad('parsePortName roundtrip broken', JSON.stringify(parsed))
}
if (parsePortName('garbage') === null) ok('parsePortName rejects invalid')
else                                    bad('parsePortName accepted garbage')

// Per-browser merge
const { applyBrowserOverrides, deepMerge } = await import('../src/build/config-loader.js')
const merged = applyBrowserOverrides(
  { permissions: { declared: ['storage'] }, chrome: { permissions: { declared: ['tabs'] } } },
  'chrome'
)
if (JSON.stringify(merged.permissions.declared) === JSON.stringify(['tabs'])) {
  ok('per-browser arrays REPLACE not concat')
} else {
  bad('per-browser merge wrong', JSON.stringify(merged.permissions.declared))
}
const deep = deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 99, z: 3 } })
if (deep.a.x === 1 && deep.a.y === 99 && deep.a.z === 3) ok('deepMerge objects recurse')
else bad('deepMerge object recursion broken', JSON.stringify(deep))

// --- Summary ---

console.log('')
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
