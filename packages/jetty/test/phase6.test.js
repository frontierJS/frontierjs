// Phase 6 unit tests — Firefox parity.
//
// Coverage:
//   - buildManifest('firefox', ...) — gecko settings, service_worker default,
//     scripts[] opt-in, action/options shape (shared w/ Chrome)
//   - buildManifest unsupported browser arg
//   - buildExtension dispatches to right manifest variant
//   - buildBoth produces both dist dirs

import { resolve } from 'node:path'
import { existsSync, readFileSync, rmSync } from 'node:fs'

let pass = 0
let fail = 0
function ok(msg)        { pass++; console.log('  ✓', msg) }
function bad(msg, info) { fail++; console.log('  ✗', msg); if (info) console.log('     →', info) }
function group(name)    { console.log(`\n[${name}]`) }

// --- Firefox manifest shape ---

group('Firefox manifest shape')
{
  const { buildManifest } = await import('../src/build/manifest.js')

  // Minimal Firefox manifest (harbor + dock, gecko settings)
  {
    const m = buildManifest({
      config: {
        name:        'TestExt',
        description: 'Test',
        version:     '1.0.0',
        permissions: { declared: ['storage'] },
        firefox:     {
          geckoId:          'test@frontierjs.dev',
          strictMinVersion: 121,
        },
      },
      found: {
        harbor: { path: '/x' },
        dock:   { autoGen: true, dir: '/x', app: '/x' },
        options: null, piers: [], islands: [],
      },
      browser: 'firefox',
    })

    if (m.manifest_version === 3) ok('Firefox: manifest_version = 3')
    if (m.background?.service_worker === 'harbor.js' && m.background?.type === 'module') {
      ok('Firefox: background = service_worker by default')
    } else {
      bad('Firefox background wrong', JSON.stringify(m.background))
    }
    if (m.action?.default_popup === 'dock.html') ok('Firefox: action.default_popup set when dock present')
    if (m.browser_specific_settings?.gecko?.id === 'test@frontierjs.dev') ok('Firefox: gecko.id from config.firefox.geckoId')
    if (m.browser_specific_settings?.gecko?.strict_min_version === '121') ok('Firefox: gecko.strict_min_version stringified from config')
    // No Chrome-specific fields
    if (!('minimum_chrome_version' in m)) ok('Firefox: no minimum_chrome_version key')
  }

  // Firefox w/ scripts[] opt-in
  {
    const m = buildManifest({
      config: {
        name: 'X', description: '', version: '0.1',
        firefox: { background: { useScripts: true } },
      },
      found: { harbor: { path: '/x' }, dock: null, options: null, piers: [], islands: [] },
      browser: 'firefox',
    })
    if (Array.isArray(m.background?.scripts) && m.background.scripts[0] === 'harbor.js') {
      ok('Firefox: scripts[] form when useScripts=true')
    } else {
      bad('Firefox scripts[] wrong', JSON.stringify(m.background))
    }
    // service_worker should NOT be present when scripts[] is used
    if (!('service_worker' in (m.background ?? {}))) ok('Firefox: scripts[] form drops service_worker')
  }

  // Firefox without geckoId — should still produce a valid manifest, just no
  // browser_specific_settings. (Useful for ephemeral dev builds.)
  {
    const m = buildManifest({
      config: { name: 'X', description: '', version: '0.1' },
      found: { harbor: { path: '/x' }, dock: null, options: null, piers: [], islands: [] },
      browser: 'firefox',
    })
    if (!m.browser_specific_settings) ok('Firefox: no gecko config → no browser_specific_settings key')
  }

  // Firefox w/ islands — same host_permissions / WAR shape as Chrome
  {
    const m = buildManifest({
      config: {
        name: 'X', description: '', version: '0.1',
        permissions: { declared: ['storage'] },
        islands: { sa: { matches: ['https://*.lightning.force.com/*'] } },
        firefox: { geckoId: 'test@x.dev' },
      },
      found: {
        harbor: { path: '/x' }, dock: null, options: null, piers: [],
        islands: [{ id: 'sa', path: '/x' }],
      },
      browser: 'firefox',
    })
    if (m.permissions?.includes('scripting')) ok('Firefox: scripting perm auto-added (islands)')
    if (m.host_permissions?.includes('https://*.lightning.force.com/*')) ok('Firefox: host_permissions from island matches')
    if (m.web_accessible_resources?.[0]?.resources?.includes('islands/sa.js')) ok('Firefox: WAR includes island bundle')
  }
}

// --- Chrome regression after manifest emitter rewrite ---

group('Chrome manifest regression')
{
  const { buildManifest } = await import('../src/build/manifest.js')

  const m = buildManifest({
    config: {
      name: 'ChromeExt', description: '', version: '0.1.0',
      permissions: { declared: ['storage'] },
      chrome: { minVersion: 110 },
    },
    found: {
      harbor: { path: '/x' },
      dock:   { autoGen: true, dir: '/x', app: '/x' },
      options: null, piers: [], islands: [],
    },
    browser: 'chrome',
  })

  if (m.background?.service_worker === 'harbor.js') ok('Chrome: background.service_worker preserved')
  if (m.minimum_chrome_version === '110') ok('Chrome: minimum_chrome_version stringified')
  if (!m.browser_specific_settings) ok('Chrome: no browser_specific_settings')
  if (m.action?.default_popup === 'dock.html') ok('Chrome: action.default_popup preserved')
}

// --- buildManifest dispatches ---

group('buildManifest dispatch')
{
  const { buildManifest } = await import('../src/build/manifest.js')

  // Unsupported browser throws
  try {
    buildManifest({ config: { name: 'x', version: '1' }, found: { harbor: null, dock: null, options: null, piers: [], islands: [] }, browser: 'safari' })
    bad('safari accepted')
  } catch (e) {
    if (/unsupported browser/.test(e.message)) ok('unsupported browser rejected')
  }
}

// --- buildExtension end-to-end (Firefox) ---

group('buildExtension — firefox')
{
  const { buildExtension } = await import('../src/build/index.js')
  const fixtureRoot = resolve('test/fixtures/basic-ext')

  // Clean before
  const ffDir = resolve(fixtureRoot, 'dist/firefox')
  if (existsSync(ffDir)) rmSync(ffDir, { recursive: true, force: true })

  const result = await buildExtension({ root: fixtureRoot, browser: 'firefox' })
  if (existsSync(result.distDir)) ok('firefox dist dir created')
  if (existsSync(resolve(result.distDir, 'manifest.json'))) ok('firefox manifest written')

  const manifest = JSON.parse(readFileSync(resolve(result.distDir, 'manifest.json'), 'utf8'))
  if (manifest.browser_specific_settings?.gecko?.id === 'jetty-fixture@frontierjs.dev') ok('fixture: gecko.id present')
  if (manifest.background?.service_worker === 'harbor.js') ok('fixture: firefox background.service_worker default')
  if (!('minimum_chrome_version' in manifest)) ok('fixture: no Chrome-specific keys in firefox manifest')

  // Same bundles produced
  if (existsSync(resolve(result.distDir, 'harbor.js'))) ok('firefox: harbor.js emitted')
  if (existsSync(resolve(result.distDir, 'dock.js')))   ok('firefox: dock.js emitted')
  if (existsSync(resolve(result.distDir, 'islands/demo.js'))) ok('firefox: islands/demo.js emitted')
}

// --- buildBoth ---

group('buildBoth')
{
  const { buildBoth } = await import('../src/build/index.js')
  const fixtureRoot = resolve('test/fixtures/basic-ext')

  // Clean before
  for (const d of ['dist/chrome', 'dist/firefox']) {
    const p = resolve(fixtureRoot, d)
    if (existsSync(p)) rmSync(p, { recursive: true, force: true })
  }

  const { chrome, firefox } = await buildBoth({ root: fixtureRoot })
  if (existsSync(chrome.distDir) && existsSync(firefox.distDir)) ok('buildBoth: both dist dirs created')

  const cm = JSON.parse(readFileSync(resolve(chrome.distDir, 'manifest.json'), 'utf8'))
  const fm = JSON.parse(readFileSync(resolve(firefox.distDir, 'manifest.json'), 'utf8'))

  if ('minimum_chrome_version' in cm) ok('buildBoth: chrome manifest has Chrome-specific keys')
  if ('browser_specific_settings' in fm) ok('buildBoth: firefox manifest has gecko keys')
  if (!('browser_specific_settings' in cm)) ok('buildBoth: chrome manifest has NO gecko keys')
  if (!('minimum_chrome_version' in fm)) ok('buildBoth: firefox manifest has NO chrome version key')

  // Same shared content
  if (cm.permissions?.length === fm.permissions?.length) ok('buildBoth: permissions match across browsers')
  if (JSON.stringify(cm.host_permissions) === JSON.stringify(fm.host_permissions)) ok('buildBoth: host_permissions match')
  if (JSON.stringify(cm.web_accessible_resources) === JSON.stringify(fm.web_accessible_resources)) ok('buildBoth: WAR matches')
}

// --- summary ---

console.log('')
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
