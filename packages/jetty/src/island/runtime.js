// island-runtime.js — the runtime side of an Island.
//
// Called by an island's auto-generated content script entry. Three usage
// patterns are supported per spec:
//
//   1. UI-only       — defineIsland({ app, mount, position, anchor, ... })
//                      Mounts a Mesa app inside a shadow root.
//   2. Code-only     — defineIsland({ main: async (ctx) => { ... } })
//                      Runs imperative code; no UI. Used for analytics,
//                      DOM scraping, presence beacons, etc.
//   3. Hybrid        — defineIsland({ app, main, injectPageScript? })
//                      Both UI and code; main() runs first (typically sets
//                      up data the app reads).
//
// World handling:
//   - world: 'ISOLATED' (default) — content script runs in extension realm,
//     can use chrome.runtime.connect, mounts shadow DOM in document.
//   - world: 'MAIN' — content script runs in page realm. Cannot use
//     chrome.runtime.* APIs. UI mounting in MAIN world is forbidden by
//     defineIsland validation (Phase 0 already enforces this) — the only
//     legitimate MAIN-world use is `main`-only islands that need page globals.
//
// PageScript injection (`injectPageScript: 'foo.js'` in island config) is
// supported for ISOLATED world only — the content script injects a <script>
// tag pointing to the extension's foo.js, which runs in MAIN world, and the
// two communicate via window.postMessage. See ./page-script.js.

import { connectHarbor }     from '../runtime/connect-harbor.js'
import { mount }              from '../runtime/mount.js'
import { _registerActivePort } from '../resources/active-port.js'
import { bootstrapUnoMirror } from './unocss-mirror.js'
import { injectPageScript }   from './page-script.js'

/**
 * Run an island. Called by the auto-generated content-script entry,
 * which imports the user's island module and invokes runIsland(islandModule, meta).
 *
 * @param {object} islandModule — what defineIsland({...}) returned
 * @param {object} meta         — { id, type: 'island' }, set by auto-gen
 * @returns {Promise<{ destroy: () => void }>}
 */
export async function runIsland(islandModule, meta) {
  const cfg = islandModule
  const id  = meta.id

  // World check: in MAIN world, chrome.runtime is not available, so we cannot
  // open a port to harbor. MAIN-world islands are always main()-only.
  const inMainWorld = !hasChromeRuntime()
  if (inMainWorld && cfg.app) {
    console.error(`[island:${id}] config error: \`app\` cannot run in MAIN world (no shadow DOM bridge). ` +
                  `Move UI to an ISOLATED-world island.`)
    return inertHandle()
  }

  // Open port to harbor. MAIN-world islands skip this — their ctx.harbor is null.
  let harbor = null
  if (!inMainWorld) {
    try {
      harbor = await connectHarbor({ type: 'island', id })
      // Register as active port so getConnectionState() / login() / logout()
      // imports in the user's island code see the right port. Without this,
      // these helpers are inert and getConnectionState() always returns
      // `authenticated: false` even after the user signs in via the popup.
      _registerActivePort(harbor)
    } catch (e) {
      console.warn(`[island:${id}] harbor connection failed:`, e.message)
    }
  }

  // Inject page script if requested (ISOLATED world only).
  let pageScriptInjected = null
  if (cfg.injectPageScript && !inMainWorld) {
    try {
      pageScriptInjected = injectPageScript(cfg.injectPageScript)
    } catch (e) {
      console.warn(`[island:${id}] injectPageScript failed:`, e.message)
    }
  }

  const ctx = {
    harbor,
    id,
    pageScript: pageScriptInjected,
  }

  // Run main() first if present. Hybrid islands rely on main() to populate
  // data the app then reads. main() that throws aborts the rest of mount.
  if (typeof cfg.main === 'function') {
    try {
      await cfg.main(ctx)
    } catch (e) {
      console.error(`[island:${id}] main() threw:`, e)
      return inertHandle()
    }
  }

  // No app → code-only island, we're done.
  if (!cfg.app) return inertHandle()

  // From here on we're mounting UI. Wait for body so document.body operations work.
  await documentReady()

  // Build the host element + shadow root for the island's UI.
  const { host, shadow, hostInDoc } = mountIslandShell(id, cfg)

  // Mount the Mesa app inside the shadow root.
  const mountHandle = await mount(shadow, cfg.app, { harbor, id, ...ctx })

  // UnoCSS DOM-mirror: copy classes used in shadow → mirror in host doc, copy
  // generated styles back into the shadow. Disabled if the consumer turns it
  // off explicitly (cfg.unocss === false).
  let unoHandle = null
  if (cfg.unocss !== false) {
    try {
      unoHandle = bootstrapUnoMirror(shadow, document.body, cfg.unoOptions ?? {})
    } catch (e) {
      console.warn(`[island:${id}] UnoCSS mirror bootstrap failed:`, e.message)
    }
  }

  return {
    destroy() {
      try { unoHandle?.destroy?.() } catch {}
      try { mountHandle?.destroy?.() } catch {}
      try { hostInDoc.remove() } catch {}
    },
  }
}

// --- shell + positioning ---

/**
 * Build the island shell:
 *   - host element (the DOM element placed in the page)
 *   - shadow root (closed by default; open if cfg.shadowMode === 'open')
 *
 * Positioning honors cfg.position + cfg.anchor:
 *   position: 'append' (default) | 'prepend' | 'before' | 'after' | 'replace' |
 *             'fixed-top-right' | 'fixed-bottom-right' | ... | 'body-end' (default for free-floating)
 *   anchor:   CSS selector | function () => Element | undefined for body-end
 */
function mountIslandShell(id, cfg) {
  const host = document.createElement('div')
  host.setAttribute('data-jetty-island', id)
  // Reset most inherited styles. Components decide their own layout inside the shadow.
  host.style.cssText = baseHostStyle(cfg)

  const shadowMode = cfg.shadowMode ?? 'open' // open by default — easier to debug; use 'closed' for hard isolation
  const shadow = host.attachShadow({ mode: shadowMode })

  // Place the host in the document.
  const position = cfg.position ?? (cfg.anchor ? 'append' : 'body-end')
  const anchor   = resolveAnchor(cfg.anchor)

  let hostInDoc = host
  switch (position) {
    case 'append':
      (anchor ?? document.body).appendChild(host)
      break
    case 'prepend':
      (anchor ?? document.body).prepend(host)
      break
    case 'before':
      if (!anchor) throw new Error(`[island:${id}] position:'before' requires anchor`)
      anchor.parentNode.insertBefore(host, anchor)
      break
    case 'after':
      if (!anchor) throw new Error(`[island:${id}] position:'after' requires anchor`)
      anchor.parentNode.insertBefore(host, anchor.nextSibling)
      break
    case 'replace':
      if (!anchor) throw new Error(`[island:${id}] position:'replace' requires anchor`)
      anchor.parentNode.replaceChild(host, anchor)
      break
    case 'body-end':
      document.body.appendChild(host)
      break
    case 'body-start':
      document.body.prepend(host)
      break
    default:
      // fixed-* shorthands — apply absolute positioning to the host
      applyFixedPosition(host, position)
      document.body.appendChild(host)
  }

  return { host, shadow, hostInDoc }
}

function baseHostStyle(cfg) {
  // Default: 'all: initial' — neutralizes inherited host-page styles. Customizable.
  if (cfg.hostStyle === false) return ''
  if (typeof cfg.hostStyle === 'string') return cfg.hostStyle
  return 'all: initial; display: contents;'
}

function resolveAnchor(anchor) {
  if (!anchor) return null
  if (typeof anchor === 'string') return document.querySelector(anchor)
  if (typeof anchor === 'function') {
    try { return anchor() } catch { return null }
  }
  if (anchor instanceof Element) return anchor
  return null
}

function applyFixedPosition(host, position) {
  host.style.position = 'fixed'
  host.style.zIndex = '2147483647'
  switch (position) {
    case 'fixed-top-left':     host.style.top = '0';    host.style.left = '0';    break
    case 'fixed-top-right':    host.style.top = '0';    host.style.right = '0';   break
    case 'fixed-bottom-left':  host.style.bottom = '0'; host.style.left = '0';    break
    case 'fixed-bottom-right': host.style.bottom = '0'; host.style.right = '0';   break
    default:
      console.warn(`[island] unknown position "${position}", defaulting to body-end`)
  }
}

// --- helpers ---

function hasChromeRuntime() {
  return (typeof chrome !== 'undefined' && chrome.runtime?.id) ||
         (typeof browser !== 'undefined' && browser.runtime?.id)
}

function documentReady() {
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    if (document.body) return Promise.resolve()
  }
  return new Promise((resolve) => {
    if (document.body) return resolve()
    const observer = new MutationObserver(() => {
      if (document.body) {
        observer.disconnect()
        resolve()
      }
    })
    observer.observe(document.documentElement, { childList: true })
  })
}

function inertHandle() {
  return { destroy: () => {} }
}
