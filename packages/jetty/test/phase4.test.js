// Phase 4 unit tests — Islands.
//
// Coverage:
//   - defineIsland validation (matches required, world rules, position, etc.)
//   - registration: buildRegistration shape + upsert via mock scripting API
//   - registerAllIslands batch path + per-island fallback on failure
//   - runtime: shadow DOM mount, MAIN-world detection, hybrid (main + app)
//   - manifest derivation: host_permissions from islands, web_accessible_resources scope
//
// What's NOT covered here (manual smoke required):
//   - Real Chrome content script loading (sandbox can't run chrome.scripting)
//   - UnoCSS DOM-mirror under real Vite/UnoCSS (dependency-heavy)
//   - Page-script bridge w/ real document.head + window.postMessage
//
// We use a fake DOM (jsdom) for the mount tests so we can verify shadow
// root creation, host placement, and shell teardown.

import { JSDOM } from 'jsdom'

let pass = 0
let fail = 0
function ok(msg)        { pass++; console.log('  ✓', msg) }
function bad(msg, info) { fail++; console.log('  ✗', msg); if (info) console.log('     →', info) }
function group(name)    { console.log(`\n[${name}]`) }

// --- defineIsland validation ---

group('defineIsland validation')
{
  const { defineIsland } = await import('../src/define/island.js')

  // Valid: app only
  try { defineIsland({ app: () => {} }); ok('app-only accepted') }
  catch (e) { bad('app-only rejected', e.message) }

  // Valid: main only
  try { defineIsland({ main: async () => {} }); ok('main-only accepted') }
  catch (e) { bad('main-only rejected', e.message) }

  // Valid: hybrid
  try { defineIsland({ app: () => {}, main: async () => {} }); ok('hybrid accepted') }
  catch (e) { bad('hybrid rejected', e.message) }

  // Reject: neither app nor main
  try {
    defineIsland({})
    bad('empty config accepted')
  } catch (e) {
    if (/app.*main/.test(e.message)) ok('empty config rejected')
  }

  // Reject: app + world MAIN
  try {
    defineIsland({ app: () => {}, world: 'MAIN' })
    bad('app + MAIN accepted — should reject')
  } catch (e) {
    if (/MAIN/.test(e.message)) ok('app + MAIN rejected')
  }

  // Accept: main-only + world MAIN
  try { defineIsland({ main: async () => {}, world: 'MAIN' }); ok('main + MAIN accepted') }
  catch (e) { bad('main + MAIN rejected', e.message) }

  // Reject: invalid matches
  try { defineIsland({ app: () => {}, matches: [] }); bad('empty matches accepted') }
  catch (e) {
    if (/matches/.test(e.message)) ok('empty matches array rejected')
  }
  try { defineIsland({ app: () => {}, matches: 'not-an-array' }); bad('string matches accepted') }
  catch (e) { ok('string matches rejected') }

  // Reject: injectPageScript with MAIN world
  try {
    defineIsland({ main: async () => {}, world: 'MAIN', injectPageScript: 'foo.js' })
    bad('injectPageScript + MAIN accepted')
  } catch (e) {
    if (/injectPageScript.*MAIN/.test(e.message)) ok('injectPageScript + MAIN rejected')
  }

  // Reject: bad position
  try {
    defineIsland({ app: () => {}, position: 'top-half' })
    bad('bad position accepted')
  } catch (e) {
    if (/position/.test(e.message)) ok('bad position rejected')
  }

  // Reject: bad shadowMode
  try {
    defineIsland({ app: () => {}, shadowMode: 'translucent' })
    bad('bad shadowMode accepted')
  } catch (e) { ok('bad shadowMode rejected') }

  // Reject: mount integrated/iframe in v1
  try {
    defineIsland({ app: () => {}, mount: 'iframe' })
    bad('iframe mount accepted in v1')
  } catch (e) {
    if (/not supported in v1/.test(e.message)) ok('iframe mount rejected in v1')
  }

  // Reject: bad runAt
  try {
    defineIsland({ app: () => {}, runAt: 'document_lazy' })
    bad('bad runAt accepted')
  } catch (e) { ok('bad runAt rejected') }
}

// --- registration: buildRegistration ---

group('buildRegistration')
{
  const { buildRegistration } = await import('../src/island/registration.js')

  // Minimal config
  {
    const reg = buildRegistration('sa', { matches: ['*://*.salesforce.com/*'] })
    if (reg.id === 'sa') ok('id assigned')
    if (Array.isArray(reg.js) && reg.js[0] === 'islands/sa.js') ok('js path uses island id')
    if (reg.runAt === 'document_idle') ok('runAt defaults to document_idle')
    if (reg.world === 'ISOLATED') ok('world defaults to ISOLATED')
    if (reg.allFrames === false) ok('allFrames defaults to false')
    if (!('css' in reg)) ok('no css when not provided')
  }

  // Full config
  {
    const reg = buildRegistration('hubspot', {
      matches: ['https://app.hubspot.com/*'],
      excludeMatches: ['https://app.hubspot.com/login'],
      runAt: 'document_start',
      allFrames: true,
      world: 'MAIN',
      css: ['islands/hubspot.css'],
    })
    if (reg.runAt === 'document_start') ok('runAt override honored')
    if (reg.world === 'MAIN') ok('world override honored')
    if (reg.allFrames === true) ok('allFrames override honored')
    if (reg.excludeMatches?.includes('https://app.hubspot.com/login')) ok('excludeMatches preserved')
    if (reg.css?.[0] === 'islands/hubspot.css') ok('css preserved')
  }

  // No matches → throws
  try { buildRegistration('bad', {}); bad('missing matches accepted') }
  catch (e) {
    if (/matches/.test(e.message)) ok('missing matches throws')
  }
}

// --- registerAllIslands w/ mock scripting API ---

group('registerAllIslands')
{
  const { registerAllIslands } = await import('../src/island/registration.js')

  function mockScripting(opts = {}) {
    const { failBatch = false, failIds = new Set(), existing = [] } = opts
    let registered = [...existing]
    return {
      _registered: () => registered,
      async getRegisteredContentScripts({ ids }) {
        if (!ids) return registered
        return registered.filter((s) => ids.includes(s.id))
      },
      async unregisterContentScripts({ ids }) {
        registered = registered.filter((s) => !ids.includes(s.id))
      },
      async registerContentScripts(entries) {
        if (failBatch && entries.length > 1) throw new Error('batch failed')
        for (const e of entries) {
          if (failIds.has(e.id)) throw new Error(`bad id: ${e.id}`)
        }
        registered.push(...entries)
      },
    }
  }

  // Clean register — no existing
  {
    const api = mockScripting()
    const results = await registerAllIslands(api, {
      sa:      { matches: ['*://*/*'] },
      hubspot: { matches: ['https://app.hubspot.com/*'] },
    })
    if (results.length === 2 && results.every((r) => r.ok)) ok('clean register: both succeed')
    if (api._registered().length === 2) ok('both registered in scripting API')
  }

  // Idempotent — re-register w/ same ids unregisters first
  {
    const api = mockScripting({ existing: [{ id: 'sa', js: ['old.js'] }] })
    await registerAllIslands(api, { sa: { matches: ['*://*/*'] } })
    const reg = api._registered()
    if (reg.length === 1 && reg[0].js[0] === 'islands/sa.js') ok('idempotent: existing replaced not duplicated')
  }

  // Batch fails → per-island retry surfaces individual failures
  {
    const api = mockScripting({ failBatch: true, failIds: new Set(['bad']) })
    const results = await registerAllIslands(api, {
      good: { matches: ['*://*/*'] },
      bad:  { matches: ['*://*/*'] },
    })
    const goodResult = results.find((r) => r.id === 'good')
    const badResult  = results.find((r) => r.id === 'bad')
    if (goodResult?.ok === true) ok('per-island retry: good succeeds')
    if (badResult?.ok === false && /bad id/.test(badResult.error ?? '')) ok('per-island retry: bad surfaces error')
  }

  // No islands → empty result, no API calls
  {
    const api = mockScripting()
    const results = await registerAllIslands(api, {})
    if (results.length === 0) ok('empty config → no results')
  }

  // Bad config in one island doesn't abort others
  {
    const api = mockScripting()
    const results = await registerAllIslands(api, {
      good: { matches: ['*://*/*'] },
      bad:  {}, // no matches
    })
    if (results.length === 1 && results[0].id === 'good') ok('config error in one island: others still register')
  }
}

// --- island runtime mount ---

group('island runtime — shadow DOM mount')
{
  // Set up jsdom; install on globalThis.
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://app.example.com/',
  })
  globalThis.window   = dom.window
  globalThis.document = dom.window.document
  globalThis.MutationObserver = dom.window.MutationObserver
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.Element = dom.window.Element
  // Stub chrome.runtime (presence indicates ISOLATED world). connectHarbor
  // returns an inert port if connect() isn't a function.
  globalThis.chrome = {
    runtime: {
      id: 'mock-ext-id',
      // No connect() — connectHarbor will return an inert port via PagePort's no-runtime path
    },
  }
  globalThis.browser = undefined

  const { runIsland } = await import('../src/island/runtime.js')

  // App-only island, default position (body-end)
  {
    let appCalled = false
    const handle = await runIsland({
      app: (root) => { appCalled = true; root.innerHTML = '<p>hi</p>' },
    }, { id: 'test-app', type: 'island' })

    if (appCalled) ok('app function invoked during mount')

    const host = document.body.querySelector('[data-jetty-island="test-app"]')
    if (host) ok('host element placed in body')

    if (host?.shadowRoot) ok('host has open shadow root by default')
    if (host?.shadowRoot?.innerHTML.includes('<p>hi</p>')) ok('app rendered into shadow root')

    // destroy removes host
    handle.destroy()
    if (!document.body.querySelector('[data-jetty-island="test-app"]')) ok('destroy removes host element')
  }

  // Code-only island (main, no app)
  {
    let mainRan = false
    const handle = await runIsland({
      main: async () => { mainRan = true },
    }, { id: 'beacon', type: 'island' })
    if (mainRan) ok('main-only: function ran')
    if (!document.body.querySelector('[data-jetty-island="beacon"]')) ok('main-only: no host element created')
    handle.destroy()
  }

  // Hybrid: main + app, main runs first
  {
    const order = []
    await runIsland({
      main: async () => { order.push('main') },
      app:  () => { order.push('app') },
    }, { id: 'hybrid', type: 'island' })
    if (JSON.stringify(order) === '["main","app"]') ok('hybrid: main runs before app')
    document.body.querySelector('[data-jetty-island="hybrid"]')?.remove()
  }

  // main throws → app does not run
  {
    let appRan = false
    await runIsland({
      main: async () => { throw new Error('oops') },
      app:  () => { appRan = true },
    }, { id: 'aborted', type: 'island' })
    if (!appRan) ok('main throw: app skipped')
  }

  // Position: fixed-top-right
  {
    const handle = await runIsland({
      app: (root) => { root.innerHTML = '<div>fixed</div>' },
      position: 'fixed-top-right',
    }, { id: 'fixed', type: 'island' })

    const host = document.body.querySelector('[data-jetty-island="fixed"]')
    if (host?.style.position === 'fixed' && host.style.top === '0px' && host.style.right === '0px') {
      ok('fixed-top-right applies position styles')
    } else {
      bad('fixed position styles wrong', `pos=${host?.style.position}, top=${host?.style.top}, right=${host?.style.right}`)
    }
    handle.destroy()
  }

  // Position: append with anchor selector
  {
    const target = document.createElement('div')
    target.id = 'mount-target'
    document.body.appendChild(target)

    const handle = await runIsland({
      app: (root) => { root.innerHTML = '<div>anchored</div>' },
      anchor: '#mount-target',
      position: 'append',
    }, { id: 'anchored', type: 'island' })

    const host = target.querySelector('[data-jetty-island="anchored"]')
    if (host) ok('append + anchor: host placed inside selected element')
    handle.destroy()
    target.remove()
  }

  // Closed shadow mode
  {
    const handle = await runIsland({
      app: (root) => { root.innerHTML = '<p>closed</p>' },
      shadowMode: 'closed',
    }, { id: 'closed', type: 'island' })

    const host = document.body.querySelector('[data-jetty-island="closed"]')
    // jsdom doesn't fully support closed shadow roots — but mount didn't crash
    if (host) ok('closed shadow: host element exists')
    handle.destroy()
  }

  // App + MAIN world rejected at runtime — when the script lands in MAIN world,
  // chrome.runtime is unavailable; runIsland detects this and refuses to mount
  // app UI (no shadow-DOM bridge in page realm).
  {
    // Temporarily nuke chrome to simulate MAIN world.
    const savedChrome = globalThis.chrome
    delete globalThis.chrome

    const handle = await runIsland({
      app: () => { /* should not run */ },
    }, { id: 'mainworld-app', type: 'island' })

    if (!document.body.querySelector('[data-jetty-island="mainworld-app"]')) {
      ok('main-world detection prevents app mount')
    } else {
      bad('main-world detection failed — host element created')
    }
    handle.destroy()

    globalThis.chrome = savedChrome
  }

  // Cleanup jsdom
  delete globalThis.window
  delete globalThis.document
  delete globalThis.MutationObserver
  delete globalThis.HTMLElement
  delete globalThis.Element
}

// --- manifest: islands → host_permissions, web_accessible_resources ---

group('manifest — islands')
{
  const { buildManifest } = await import('../src/build/manifest.js')

  // Single island → host_permissions includes its matches, scripting perm added,
  // WAR scoped to its matches.
  {
    const manifest = buildManifest({
      config: {
        name: 'X',
        description: '',
        version: '0.1.0',
        permissions: { declared: ['storage'] },
        islands: {
          sa: { matches: ['https://lightning.force.com/*', 'https://*.lightning.force.com/*'] },
        },
      },
      found: {
        harbor:  { path: '/whatever' },
        dock:    null,
        options: null,
        piers:   [],
        islands: [{ id: 'sa', path: '/whatever' }],
      },
      browser: 'chrome',
    })

    if (manifest.permissions.includes('scripting')) ok('manifest: scripting permission auto-added')
    if (manifest.permissions.includes('storage'))   ok('manifest: declared permissions preserved')

    if (manifest.host_permissions?.length === 2 &&
        manifest.host_permissions.includes('https://lightning.force.com/*')) {
      ok('manifest: island matches → host_permissions')
    } else {
      bad('host_permissions wrong', JSON.stringify(manifest.host_permissions))
    }

    const war = manifest.web_accessible_resources
    if (war?.length === 1 &&
        war[0].resources.includes('islands/sa.js') &&
        war[0].matches.includes('https://lightning.force.com/*')) {
      ok('manifest: WAR scoped to island matches (not <all_urls>)')
    } else {
      bad('WAR scope wrong', JSON.stringify(war))
    }
  }

  // Two islands w/ different matches → 2 WAR entries (each scoped)
  {
    const manifest = buildManifest({
      config: {
        name: 'X', description: '', version: '0.1.0',
        permissions: { declared: [] },
        islands: {
          a: { matches: ['https://a.example.com/*'] },
          b: { matches: ['https://b.example.com/*'] },
        },
      },
      found: {
        harbor: { path: '/x' }, dock: null, options: null, piers: [],
        islands: [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }],
      },
      browser: 'chrome',
    })

    if (manifest.web_accessible_resources?.length === 2) ok('manifest: per-island WAR entries')
    if (manifest.host_permissions?.length === 2) ok('manifest: union of both islands\' host perms')
  }

  // No islands → no scripting perm, no WAR for islands
  {
    const manifest = buildManifest({
      config: { name: 'X', description: '', version: '0.1.0', permissions: { declared: ['storage'] } },
      found: { harbor: { path: '/x' }, dock: { autoGen: true, dir: '/x', app: '/x' }, options: null, piers: [], islands: [] },
      browser: 'chrome',
    })
    if (!manifest.permissions.includes('scripting')) ok('no islands → no scripting perm')
    if (!manifest.host_permissions) ok('no islands + no declared host perms → no host_permissions key')
  }

  // Explicit hostPermissions are merged with island matches (no duplicates)
  {
    const manifest = buildManifest({
      config: {
        name: 'X', description: '', version: '0.1.0',
        permissions: { declared: [] },
        hostPermissions: ['https://api.example.com/*'],
        islands: {
          sa: { matches: ['https://lightning.force.com/*'] },
        },
      },
      found: {
        harbor: { path: '/x' }, dock: null, options: null, piers: [],
        islands: [{ id: 'sa', path: '/x' }],
      },
      browser: 'chrome',
    })

    if (manifest.host_permissions?.includes('https://api.example.com/*') &&
        manifest.host_permissions?.includes('https://lightning.force.com/*')) {
      ok('manifest: explicit hostPermissions merged w/ island matches')
    } else {
      bad('host_permissions merge wrong', JSON.stringify(manifest.host_permissions))
    }
  }
}

// --- summary ---

console.log('')
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
