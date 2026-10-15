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
 * @param {string} [opts.nonce] — the bridge nonce, read by the page script with readPageNonce()
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
  if (opts.nonce) script.dataset.jettyNonce = opts.nonce

  const parent = opts.parent ?? document.documentElement
  parent.appendChild(script)
  return script
}

/**
 * postMessage-based channel between content script (ISOLATED) and page script
 * (MAIN). Both sides listen on `window` for messages tagged with our prefix,
 * the channel name and a nonce.
 *
 * Wire format:
 *   { __jetty: true, channel: 'X', direction: 'cs→page'|'page→cs', nonce, payload: ... }
 *
 * `event.source === window` is every script on the host page, so it names no
 * one. The content script side mints the nonce (`bridge.nonce`) and hands it
 * to the injected page script with `injectPageScript(path, { nonce })`, which
 * reads it back with `readPageNonce()`; a message without it is ignored. The
 * nonce is readable by anything that can read the DOM before the page script
 * consumes it, so it stops a page script that does not know jetty is there,
 * not one watching for it.
 *
 * The page side must be given the `nonce`; the content side mints one when
 * none is given.
 *
 * Returns { send, on, off, destroy, nonce }.
 */
export function makePageBridge(channel, { side, nonce }) {
  if (side !== 'cs' && side !== 'page') {
    throw new Error('makePageBridge: side must be "cs" or "page"')
  }
  if (side === 'page' && !nonce) {
    throw new Error('makePageBridge: the page side needs the nonce the content script minted')
  }
  nonce = nonce ?? mintNonce()
  const sendDir = side === 'cs' ? 'cs→page' : 'page→cs'
  const recvDir = side === 'cs' ? 'page→cs' : 'cs→page'

  const handlers = new Set()

  function listener(e) {
    if (e.source !== window) return
    const d = e.data
    if (!d || d.__jetty !== true) return
    if (d.channel !== channel || d.direction !== recvDir) return
    if (d.nonce !== nonce) return
    for (const fn of handlers) {
      try { fn(d.payload, d) }
      catch (err) { console.error('[jetty] page-bridge handler threw', err) }
    }
  }
  window.addEventListener('message', listener)

  return {
    nonce,
    send(payload) {
      window.postMessage({ __jetty: true, channel, direction: sendDir, nonce, payload }, '*')
    },
    on(fn)  { handlers.add(fn); return () => handlers.delete(fn) },
    off(fn) { handlers.delete(fn) },
    destroy() {
      window.removeEventListener('message', listener)
      handlers.clear()
    },
  }
}

/**
 * Page-script side: the nonce `injectPageScript(path, { nonce })` left on the
 * script's own element, removed on read so it does not sit in the DOM.
 */
export function readPageNonce() {
  const el = document.querySelector('script[data-jetty-nonce]')
  if (!el) return null
  const nonce = el.dataset.jettyNonce
  delete el.dataset.jettyNonce
  return nonce
}

// --- internals ---

function mintNonce() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function chromeRuntimeURL(path) {
  const r = (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
    ? chrome.runtime
    : (typeof browser !== 'undefined' && browser.runtime?.getURL ? browser.runtime : null)
  return r ? r.getURL(path) : null
}

function cssEscape(s) {
  return String(s).replace(/"/g, '\\"')
}
