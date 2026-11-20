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
// We use a fake DOM (happy-dom) for the mount tests so we can verify shadow
// root creation, host placement, and shell teardown.

import { Window } from 'happy-dom'

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
  try { defineIsland({ app: { render() {} } }); ok('app-only accepted') }
  catch (e) { bad('app-only rejected', e.message) }

  // Valid: main only
  try { defineIsland({ main: async () => {} }); ok('main-only accepted') }
  catch (e) { bad('main-only rejected', e.message) }

  // Valid: hybrid
  try { defineIsland({ app: { render() {} }, main: async () => {} }); ok('hybrid accepted') }
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
    defineIsland({ app: { render() {} }, world: 'MAIN' })
    bad('app + MAIN accepted — should reject')
  } catch (e) {
    if (/MAIN/.test(e.message)) ok('app + MAIN rejected')
  }

  // Accept: main-only + world MAIN
  try { defineIsland({ main: async () => {}, world: 'MAIN' }); ok('main + MAIN accepted') }
  catch (e) { bad('main + MAIN rejected', e.message) }

  // Reject: invalid matches
  try { defineIsland({ app: { render() {} }, matches: [] }); bad('empty matches accepted') }
  catch (e) {
    if (/matches/.test(e.message)) ok('empty matches array rejected')
  }
  try { defineIsland({ app: { render() {} }, matches: 'not-an-array' }); bad('string matches accepted') }
  catch (_e) { ok('string matches rejected') }

  // Reject: injectPageScript with MAIN world
  try {
    defineIsland({ main: async () => {}, world: 'MAIN', injectPageScript: 'foo.js' })
    bad('injectPageScript + MAIN accepted')
  } catch (e) {
    if (/injectPageScript.*MAIN/.test(e.message)) ok('injectPageScript + MAIN rejected')
  }

  // Reject: bad position
  try {
    defineIsland({ app: { render() {} }, position: 'top-half' })
    bad('bad position accepted')
  } catch (e) {
    if (/position/.test(e.message)) ok('bad position rejected')
  }

  // Reject: bad shadowMode
  try {
    defineIsland({ app: { render() {} }, shadowMode: 'translucent' })
    bad('bad shadowMode accepted')
  } catch (_e) { ok('bad shadowMode rejected') }

  // Reject: mount integrated/iframe in v1
  try {
    defineIsland({ app: { render() {} }, mount: 'iframe' })
    bad('iframe mount accepted in v1')
  } catch (e) {
    if (/not supported in v1/.test(e.message)) ok('iframe mount rejected in v1')
  }

  // Reject: bad runAt
  try {
    defineIsland({ app: { render() {} }, runAt: 'document_lazy' })
    bad('bad runAt accepted')
  } catch (_e) { ok('bad runAt rejected') }
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

  // inject: 'gesture' is never registered
  if (buildRegistration('clip', { inject: 'gesture' }) === null) ok("inject: 'gesture' builds no registration")
  else bad("inject: 'gesture' built a registration")
  if (buildRegistration('sa', { inject: 'matches', matches: ['*://*/*'] })?.id === 'sa') ok("inject: 'matches' registers")
  else bad("inject: 'matches' built nothing")

  try { buildRegistration('clip', { inject: 'bogus', matches: ['*://*/*'] }); bad('bogus inject accepted') }
  catch (e) {
    if (/island "clip"/.test(e.message) && /inject/.test(e.message) && /bogus/.test(e.message)) ok('bogus inject refused by island and value')
    else bad('bogus inject message wrong', e.message)
  }

  // No matches → throws
  try { buildRegistration('bad', {}); bad('missing matches accepted') }
  catch (e) {
    if (/matches/.test(e.message) && /inject: 'gesture'/.test(e.message)) ok('missing matches throws and names inject: gesture')
    else bad('missing matches message wrong', e.message)
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

  // A gesture island is skipped, never registered
  {
    const api = mockScripting()
    const results = await registerAllIslands(api, {
      clip: { inject: 'gesture' },
      sa:   { matches: ['*://*/*'] },
    })
    if (results.length === 1 && results[0].id === 'sa' && api._registered().length === 1) ok('registerAll skips a gesture island')
    else bad('registerAll registered a gesture island', JSON.stringify(api._registered()))

    const { registerIsland, reloadIslandTabs } = await import('../src/island/registration.js')
    try { await registerIsland(api, 'clip', { inject: 'gesture' }); bad('registerIsland accepted a gesture island') }
    catch (e) {
      if (/island "clip"/.test(e.message) && /gesture/.test(e.message)) ok('registerIsland refuses a gesture island by name')
      else bad('registerIsland message wrong', e.message)
    }

    let queried = false
    const n = await reloadIslandTabs({ query: async () => { queried = true; return [] } }, undefined)
    if (n === 0 && !queried) ok('reloadIslandTabs is a no-op for a gesture island')
    else bad('reloadIslandTabs touched tabs for a gesture island')
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
  // Set up happy-dom; install on globalThis.
  const win = new Window({ url: 'https://app.example.com/' })
  globalThis.window   = win
  globalThis.document = win.document
  globalThis.MutationObserver = win.MutationObserver
  globalThis.HTMLElement = win.HTMLElement
  globalThis.Element = win.Element
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
      app: { render(root) { appCalled = true; root.innerHTML = '<p>hi</p>' } },
      shadowMode: 'open',
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

  // A { render(root, props) } stub receives the real root and the props
  {
    let got = null
    const handle = await runIsland({
      app: { render(root, props) { got = { root, props }; root.innerHTML = '<i>stub</i>' } },
      shadowMode: 'open',
    }, { id: 'stub-shape', type: 'island' })
    const host = document.body.querySelector('[data-jetty-island="stub-shape"]')
    if (got && got.root === host?.shadowRoot) ok('render stub receives the island shadow root')
    else bad('render stub did not receive the shadow root', String(got?.root))
    if (got?.props?.id === 'stub-shape' && 'harbor' in (got?.props ?? {})) ok('render stub receives the props')
    else bad('render stub props wrong', JSON.stringify(Object.keys(got?.props ?? {})))
    handle.destroy()
  }

  // Re-injection: a second run of the same island id does nothing
  {
    let mains = 0, apps = 0
    const cfg = {
      main: async () => { mains++ },
      app:  { render() { apps++ } },
    }
    const first  = await runIsland(cfg, { id: 'again', type: 'island' })
    const second = await runIsland(cfg, { id: 'again', type: 'island' })
    if (mains === 1 && apps === 1) ok('re-injected island runs main() and app once')
    else bad('re-injected island ran twice', `mains=${mains} apps=${apps}`)
    if (document.body.querySelectorAll('[data-jetty-island="again"]').length === 1) ok('re-injected island mounts one host')
    else bad('re-injected island mounted two hosts')
    second.destroy()
    first.destroy()
    await runIsland(cfg, { id: 'again', type: 'island' })
    if (mains === 2) ok('a destroyed island can be injected again')
    else bad('destroy did not release the island', `mains=${mains}`)
    document.body.querySelector('[data-jetty-island="again"]')?.remove()
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
      app:  { render() { order.push('app') } },
    }, { id: 'hybrid', type: 'island' })
    if (JSON.stringify(order) === '["main","app"]') ok('hybrid: main runs before app')
    document.body.querySelector('[data-jetty-island="hybrid"]')?.remove()
  }

  // main throws → app does not run
  {
    let appRan = false
    await runIsland({
      main: async () => { throw new Error('oops') },
      app:  { render() { appRan = true } },
    }, { id: 'aborted', type: 'island' })
    if (!appRan) ok('main throw: app skipped')
  }

  // Position: fixed-top-right
  {
    const handle = await runIsland({
      app: { render(root) { root.innerHTML = '<div>fixed</div>' } },
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
      app: { render(root) { root.innerHTML = '<div>anchored</div>' } },
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
      app: { render(root) { root.innerHTML = '<p>closed</p>' } },
      shadowMode: 'closed',
    }, { id: 'closed', type: 'island' })

    const host = document.body.querySelector('[data-jetty-island="closed"]')
    // the root is closed, so a host exists and nothing reaches through it
    if (host && host.shadowRoot === null) ok('closed shadow: host element exists, root unreachable')
    else bad('closed shadow: root reachable or host missing')
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
      app: { render() { /* should not run */ } },
    }, { id: 'mainworld-app', type: 'island' })

    if (!document.body.querySelector('[data-jetty-island="mainworld-app"]')) {
      ok('main-world detection prevents app mount')
    } else {
      bad('main-world detection failed — host element created')
    }
    handle.destroy()

    globalThis.chrome = savedChrome
  }

  // Cleanup happy-dom
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

// --- harbor islands.inject ---

group('harbor — islands.inject')
{
  const savedChrome = globalThis.chrome
  const calls = []
  // No runtime.id: defineHarbor stays out of extension context, so no listener and no boot.
  globalThis.chrome = {
    scripting: {
      async executeScript(opts) { calls.push(['executeScript', opts]) },
      async insertCSS(opts)     { calls.push(['insertCSS', opts]) },
    },
  }
  try {
    const { defineHarbor } = await import('../src/define/harbor.js')
    const harbor = defineHarbor({
      islands: {
        clip:  { inject: 'gesture', css: ['islands/clip.css'], world: 'MAIN', allFrames: true },
        plain: { inject: 'gesture' },
        sa:    { matches: ['*://*/*'] },
      },
    })

    if (typeof harbor.islands?.inject === 'function') ok('defineHarbor returns islands synchronously')
    else bad('handle has no islands.inject')

    await harbor.islands.inject('clip', 7)
    const [css, exec] = calls
    if (css?.[0] === 'insertCSS' && css[1].target.tabId === 7 && css[1].target.allFrames === true &&
        css[1].files[0] === 'islands/clip.css') ok('inject: insertCSS with target and css files')
    else bad('inject: insertCSS wrong', JSON.stringify(css))
    if (exec?.[0] === 'executeScript' && exec[1].target.tabId === 7 && exec[1].files[0] === 'islands/clip.js' &&
        exec[1].world === 'MAIN') ok('inject: executeScript with target, files and world')
    else bad('inject: executeScript wrong', JSON.stringify(exec))

    calls.length = 0
    await harbor.islands.inject('plain', 9)
    if (calls.length === 1 && calls[0][1].world === 'ISOLATED' && calls[0][1].target.allFrames === false) ok('inject: world ISOLATED and allFrames false by default, no CSS call')
    else bad('inject: defaults wrong', JSON.stringify(calls))

    try { await harbor.islands.inject('sa', 1); bad('inject accepted a matches island') }
    catch (e) { if (/"sa"/.test(e.message) && /gesture/.test(e.message)) ok('inject refuses a matches island by name'); else bad('inject message wrong', e.message) }
    try { await harbor.islands.inject('nope', 1); bad('inject accepted an unknown id') }
    catch (e) { if (/"nope"/.test(e.message)) ok('inject refuses an unknown id by name'); else bad('inject unknown message wrong', e.message) }
  } finally {
    globalThis.chrome = savedChrome
  }
}

// --- manifest: gesture island ---

group('manifest — gesture island')
{
  const { buildManifest } = await import('../src/build/manifest.js')
  const manifest = buildManifest({
    config: { name: 'X', version: '0.1.0', permissions: { declared: ['storage'] }, islands: { clip: { inject: 'gesture' } } },
    found: { harbor: { path: '/x' }, dock: null, options: null, piers: [], islands: [{ id: 'clip', path: '/x' }] },
    browser: 'chrome',
  })
  if (!manifest.host_permissions) ok('gesture island adds no host_permissions')
  else bad('gesture island added host_permissions', JSON.stringify(manifest.host_permissions))
  if (manifest.permissions.includes('activeTab') && manifest.permissions.includes('scripting')) ok('gesture island adds activeTab and scripting')
  else bad('gesture island permissions wrong', JSON.stringify(manifest.permissions))
  if (manifest.web_accessible_resources?.[0]?.resources?.[0] === 'islands/clip.js') ok('gesture island keeps its web_accessible_resources entry')
  else bad('gesture island lost its WAR entry', JSON.stringify(manifest.web_accessible_resources))

  const plain = buildManifest({
    config: { name: 'X', version: '0.1.0', islands: { sa: { matches: ['https://a.test/*'] } } },
    found: { harbor: { path: '/x' }, dock: null, options: null, piers: [], islands: [{ id: 'sa', path: '/x' }] },
    browser: 'chrome',
  })
  if (!plain.permissions.includes('activeTab')) ok('a matches island does not add activeTab')
  else bad('a matches island added activeTab')
}

// --- summary ---

console.log('')
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
