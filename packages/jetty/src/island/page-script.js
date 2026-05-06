// page-script.js — inject scripts into page's MAIN world (page realm).
//
// Two use cases this supports:
//
//   1. Island declared with `world: 'MAIN'` in jetty.config.js. Chrome
//      handles registration at the manifest level — the content script IS
//      the page script, runs in page realm, has access to page globals.
//      This module isn't needed for that path; chrome does it.
//
//   2. Hybrid island (`world: 'ISOLATED'` default + injectPageScript option).
//      Island runs in ISOLATED world (default), wants to access page globals
//      (like a customer-tracking SDK exposed on `window`). Solution: inject
//      a <script> tag pointing to a separately-bundled page script. The page
//      script runs in MAIN world; it talks to the content script via
//      postMessage on a custom event channel.
//
// Spec: defineIsland({ app, main, injectPageScript: 'page-bridge.js' }) —
// jetty's build pipeline is responsible for emitting the named file as a
// web-accessible resource.

/**
 * Inject a script file from the extension's web-accessible resources into
 * the page's MAIN world. Idempotent — repeated calls return the existing
 * <script> element.
 *
 * @param {string} resourcePath  — path within the extension package, e.g. 'page-bridge.js'
 * @param {Object} [opts]
 * @param {Element} [opts.parent=document.documentElement] — where to inject
 * @returns {HTMLScriptElement}
 */
export function injectPageScript(resourcePath, opts = {}) {
  const url = chromeRuntimeURL(resourcePath)
  if (!url) throw new Error('injectPageScript: chrome.runtime unavailable')

  // Idempotent: dedupe by URL.
  const existing = document.querySelector(`script[data-jetty-page-script="${cssEscape(url)}"]`)
  if (existing) return existing

  const script = document.createElement('script')
  script.src = url
  script.type = 'module'
  script.dataset.jettyPageScript = url

  const parent = opts.parent ?? document.documentElement
  parent.appendChild(script)
  return script
}

/**
 * postMessage-based channel between content script (ISOLATED) and page script
 * (MAIN). Both sides listen on `window` for messages tagged with our prefix
 * and the channel name.
 *
 * Wire format:
 *   { __jetty: true, channel: 'X', direction: 'cs→page'|'page→cs', payload: ... }
 *
 * Both sides ignore messages from origins other than the page itself
 * (event.source !== window) to avoid cross-origin chatter.
 *
 * Returns { send, on, off, destroy }.
 */
export function makePageBridge(channel, { side }) {
  if (side !== 'cs' && side !== 'page') {
    throw new Error('makePageBridge: side must be "cs" or "page"')
  }
  const sendDir = side === 'cs' ? 'cs→page' : 'page→cs'
  const recvDir = side === 'cs' ? 'page→cs' : 'cs→page'

  const handlers = new Set()

  function listener(e) {
    if (e.source !== window) return
    const d = e.data
    if (!d || d.__jetty !== true) return
    if (d.channel !== channel || d.direction !== recvDir) return
    for (const fn of handlers) {
      try { fn(d.payload, d) }
      catch (err) { console.error('[jetty] page-bridge handler threw', err) }
    }
  }
  window.addEventListener('message', listener)

  return {
    send(payload) {
      window.postMessage({ __jetty: true, channel, direction: sendDir, payload }, '*')
    },
    on(fn)  { handlers.add(fn); return () => handlers.delete(fn) },
    off(fn) { handlers.delete(fn) },
    destroy() {
      window.removeEventListener('message', listener)
      handlers.clear()
    },
  }
}

// --- internals ---

function chromeRuntimeURL(path) {
  const r = (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
    ? chrome.runtime
    : (typeof browser !== 'undefined' && browser.runtime?.getURL ? browser.runtime : null)
  return r ? r.getURL(path) : null
}

function cssEscape(s) {
  return String(s).replace(/"/g, '\\"')
}
