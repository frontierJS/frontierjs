// dev-client.js — runtime-side WebSocket client.
//
// Injected at build time into harbor / page / island bundles when running
// `fli dev:ext`. The injection emits a top-level call to startDevClient()
// with the right clientType. Production builds don't include this module
// (the dev plugin is conditional).
//
// Reactions per event:
//   - 'extension:reload'   → chrome.runtime.reload()  (only Harbor reacts;
//                            Pages/Islands ignore — Harbor's reload tears
//                            them down anyway)
//   - 'page:reload'        → location.reload() if our clientType matches target
//   - 'island:reload-tabs' → Harbor calls chrome.tabs.reload() for matches
//                            (Islands themselves ignore — when their tabs
//                            reload, they get a fresh script instance)
//   - 'mesa:hot-update'    → Pages re-import their entry bundle (cache-busted)
//                            to fetch the new compiled component, then swap
//                            it in-place via the Mesa HMR registry. No full
//                            page reload — DOM stays put except for the
//                            component being updated.
//
// Reconnect: the WS connects on script load; if it disconnects (server
// killed, file edited that takes the build down), we retry every 1s with
// jitter. No exponential backoff — dev mode, fast feedback wins.

import { swapInstances } from '@frontierjs/mesa/vite/swap'

const RECONNECT_BASE_MS = 1000

// ── Mesa HMR registry ────────────────────────────────────────────────────────
//
// Mounted Mesa components register themselves here via globalThis.__jettyMesa.
// On a hot-update event, we look up registered instances by module id, tear
// down their DOM between hmrMark and anchor, and re-call the NEW component
// fn (provided by dev-client after dynamic-importing the rebuilt entry).
//
// The DOM swap itself is Mesa's — `@frontierjs/mesa/vite/swap`, imported
// rather than copied (`FJS-259`). What stays here is jetty's own half: the
// registry on `globalThis` rather than module exports, because an MV3 content
// script is a classic script and there is no module graph to share; the two
// module shapes `hot_update` accepts; and a count for the dev client to report.
// That module carries no `import.meta` for the same reason (`FJS-030`).

if (typeof globalThis !== 'undefined' && !globalThis.__jettyMesa) {
  const _registry = new Map()  // id → Set<{hmrMark,anchor,props,block,fn}>

  globalThis.__jettyMesa = {
    register(id, hmrMark, anchor, props, block, fn) {
      if (!_registry.has(id)) _registry.set(id, new Set())
      const entry = { hmrMark, anchor, props, block, fn }
      _registry.get(id).add(entry)
      return () => {
        const set = _registry.get(id)
        if (set) { set.delete(entry); if (!set.size) _registry.delete(id) }
      }
    },

    hot_update(id, newModuleOrFn) {
      const entries = _registry.get(id)
      if (!entries?.size) {
        console.warn(`[jetty:mesa-hmr] no registered instances for ${id}`)
        return 0
      }

      // Accept either the module's default export (the wrapper) or the
      // bare __mesaOrigFn. We need both the inner fn (to call) and the
      // __setMark fn (to inject the existing hmrMark before re-render).
      let newFn, newSetMark
      if (newModuleOrFn && typeof newModuleOrFn === 'object') {
        // Module shape: { default, __mesaOrigFn, __setMark }
        newFn      = newModuleOrFn.__mesaOrigFn ?? newModuleOrFn.default
        newSetMark = newModuleOrFn.__setMark
      } else if (typeof newModuleOrFn === 'function') {
        // Function shape: either the wrapper (with __setMark sibling export
        // attached) or the bare __mesaOrigFn (with __setMark attached).
        newFn      = newModuleOrFn.__mesaOrigFn ?? newModuleOrFn
        newSetMark = newModuleOrFn.__setMark
      }
      if (typeof newFn !== 'function') {
        console.warn(`[jetty:mesa-hmr] hot_update: invalid newFn for ${id}`)
        return 0
      }

      const count = swapInstances(entries, newFn, newSetMark, id.split('/').pop())

      if (count > 0) {
        console.debug(`[jetty:mesa-hmr] ♻ ${id.split('/').pop()} — ${count} instance(s)`)
      } else {
        console.warn(`[jetty:mesa-hmr] ${id} — no live instances`)
      }
      return count
    },

    // Lookup helper — returns true if any instance is registered for the id.
    has(id) {
      const set = _registry.get(id)
      return !!(set && set.size)
    },
  }
}

export function startDevClient({ port, clientType, onEvent } = {}) {
  if (!port) {
    console.warn('[jetty:dev-client] no port provided — dev WS disabled')
    return { close: () => {} }
  }
  if (typeof clientType !== 'string') {
    throw new Error('startDevClient: clientType is required')
  }

  let ws            = null
  let closed        = false
  let reconnectTimer = null

  function connect() {
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`)
    } catch (e) {
      scheduleReconnect()
      return
    }

    ws.addEventListener('open', () => {
      console.log(`[jetty:dev-client] connected (${clientType})`)
      try { ws.send(JSON.stringify({ kind: 'identify', clientType })) } catch {}
    })

    ws.addEventListener('message', (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      handleEvent(msg)
    })

    ws.addEventListener('close', () => {
      ws = null
      if (!closed) scheduleReconnect()
    })

    ws.addEventListener('error', () => {
      // close follows; let it handle reconnect.
    })
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return
    const jitter = Math.floor(Math.random() * 250)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (!closed) connect()
    }, RECONNECT_BASE_MS + jitter)
  }

  function handleEvent(msg) {
    if (!msg || typeof msg !== 'object' || !msg.kind) return

    // Always allow user hook first — useful for tests/diagnostics.
    if (typeof onEvent === 'function') {
      try { onEvent(msg) } catch (err) { console.error('[jetty:dev-client] onEvent threw', err) }
    }

    switch (msg.kind) {
      case 'hello':
      case 'ping':
        return // diagnostic only

      case 'extension:reload':
        // Only Harbor reloads the whole extension. Pages/Islands wait —
        // their tabs / popups will be torn down by the reload anyway.
        if (clientType === 'harbor') {
          console.log(`[jetty:dev-client] extension:reload (${msg.reason ?? 'unknown'})`)
          tryChromeReload()
        }
        return

      case 'page:reload':
        // Each Page reacts to its own target. We match exactly: 'dock',
        // 'options', or 'pier:<id>'.
        if (msg.target && msg.target === clientType) {
          console.log(`[jetty:dev-client] page:reload (${clientType})`)
          tryLocationReload()
        }
        return

      case 'mesa:hot-update':
        // Surface-targeted: only the matching client handles it.
        if (msg.target && msg.target === clientType) {
          handleMesaHotUpdate(msg).catch((err) => {
            console.error('[jetty:dev-client] mesa:hot-update failed:', err)
            console.warn('[jetty:dev-client] falling back to page reload')
            tryLocationReload()
          })
        }
        return

      case 'island:reload-tabs':
        // Only Harbor reacts — it has chrome.tabs access. Islands themselves
        // get fresh script instances when the tabs reload.
        if (clientType === 'harbor' && msg.islandId) {
          console.log(`[jetty:dev-client] island:reload-tabs (${msg.islandId})`)
          tryReloadIslandTabs(msg.islandId)
        }
        return

      case 'rebuild':
        // No client-side action — bundle gets rebuilt by Vite, file system
        // change picks it up next time the page loads. Logged for visibility.
        console.log(`[jetty:dev-client] rebuild (${msg.file ?? '?'})`)
        return

      default:
        // Forward unknown events to onEvent (already done above) and log.
        console.log('[jetty:dev-client] unknown event:', msg.kind)
    }
  }

  function tryChromeReload() {
    const r = (typeof chrome !== 'undefined' && chrome.runtime?.reload)
      ? chrome.runtime
      : (typeof browser !== 'undefined' && browser.runtime?.reload ? browser.runtime : null)
    if (r) r.reload()
    else console.warn('[jetty:dev-client] chrome.runtime.reload unavailable')
  }

  function tryLocationReload() {
    if (typeof location !== 'undefined' && location.reload) {
      location.reload()
    }
  }

  /**
   * Handle mesa:hot-update by re-importing the surface entry bundle and
   * swapping the new component into the registered mount points.
   *
   * The entry bundle is at a known relative URL — for a page running at
   * .../dock.html, the entry script is at ./dock.js. We append a cache-buster
   * so the browser fetches a fresh module graph for the entry chunk.
   *
   * The auto-gen'd main.js is sentinel-protected so re-import does NOT
   * remount; it only refreshes the global App registry. We then read the
   * new App from globalThis.__JETTY_HMR_APPS[clientType] and call
   * __jettyMesa.hot_update(moduleId, App).
   */
  async function handleMesaHotUpdate(msg) {
    const moduleId = msg.moduleId
    if (!moduleId) {
      console.warn('[jetty:dev-client] mesa:hot-update missing moduleId')
      return
    }

    // Compute the entry URL. clientType maps directly to the bundle filename:
    //   'dock'         → dock.js
    //   'options'      → options.js
    //   'pier:library' → piers/library.js
    let entryPath
    if (clientType === 'dock')          entryPath = 'dock.js'
    else if (clientType === 'options')  entryPath = 'options.js'
    else if (clientType.startsWith('pier:')) entryPath = `piers/${clientType.slice('pier:'.length)}.js`
    else {
      console.warn(`[jetty:dev-client] mesa:hot-update on unsupported clientType: ${clientType}`)
      return
    }

    const url = new URL(entryPath, location.href)
    url.searchParams.set('v', String(Date.now()))

    console.log(`[jetty:dev-client] mesa:hot-update fetching ${url.pathname}${url.search}`)

    // Dynamic import the new entry. The module's top-level code runs:
    //   - dev-client startup is sentinel-protected (no second WS)
    //   - mount() is gated on __jettyHmrFirstRun (skipped — we're already mounted)
    //   - App import re-evaluates and globalThis.__JETTY_HMR_APPS[clientType] = new App
    await import(/* @vite-ignore */ url.href)

    const newApp = globalThis.__JETTY_HMR_APPS?.[clientType]
    if (typeof newApp !== 'function') {
      console.warn('[jetty:dev-client] new App not published; falling back to reload')
      tryLocationReload()
      return
    }

    // hot_update accepts either the wrapper (default export) or the bare
    // __mesaOrigFn — it figures out the shape internally. We pass App as-is.
    // If the wrapper has a __setMark sibling export, we attach it so
    // hot_update can find it via the function (vs the module).
    const swapped = globalThis.__jettyMesa.hot_update(moduleId, newApp)
    if (!swapped) {
      // No registered instances for this id — full reload.
      console.warn(`[jetty:dev-client] no instances for ${moduleId}; reloading`)
      tryLocationReload()
    }
  }

  async function tryReloadIslandTabs(islandId) {
    // Harbor needs the island's match patterns. They're set at build time
    // via __JETTY_ISLAND_MATCHES__ — a global the dev plugin injects in
    // dev builds (see dev-plugin.js).
    const matchesMap = (typeof globalThis !== 'undefined' && globalThis.__JETTY_ISLAND_MATCHES__) || {}
    const matches = matchesMap[islandId]
    if (!matches?.length) {
      console.warn(`[jetty:dev-client] no matches known for island "${islandId}" — skipping reload`)
      return
    }
    const tabs = (typeof chrome !== 'undefined' && chrome.tabs)
      ? chrome.tabs
      : (typeof browser !== 'undefined' && browser.tabs ? browser.tabs : null)
    if (!tabs) {
      console.warn('[jetty:dev-client] chrome.tabs unavailable — skipping island reload')
      return
    }
    try {
      const matched = await tabs.query({ url: matches })
      for (const tab of matched ?? []) {
        if (tab.id != null) {
          try { await tabs.reload(tab.id) } catch {/* tab gone */}
        }
      }
    } catch (e) {
      console.warn('[jetty:dev-client] island tab reload failed:', e.message)
    }
  }

  // Kick off
  connect()

  return {
    close() {
      closed = true
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      if (ws) try { ws.close() } catch {}
      ws = null
    },
  }
}
