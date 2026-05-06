// Surface helpers — open Piers/Options programmatically.
//
// Spec: bare exports from `@frontierjs/jetty`. No namespace noun.
// Mirrors chrome.runtime.openOptionsPage().
//
// Phase 0: works from any extension context (Harbor, Dock, Options, Pier, Island).
// `closePier(id)` searches tabs by URL; v2 may track Pier→tabId map for cheaper close.

export async function openPier(id, opts = {}) {
  const { target = 'tab', focus = true } = opts
  const runtime = getRuntime()
  const tabs    = getTabs()
  const windows = getWindows()
  if (!runtime) throw new Error('openPier: not in extension context')

  const url = runtime.getURL(`piers/${id}.html`)

  if (target === 'window') {
    if (!windows) throw new Error('openPier: windows API unavailable (target: "window")')
    return new Promise((resolve) => {
      windows.create({ url, focused: focus }, resolve)
    })
  }

  if (!tabs) throw new Error('openPier: tabs API unavailable')
  return new Promise((resolve) => {
    tabs.create({ url, active: focus }, resolve)
  })
}

export async function openOptions() {
  const runtime = getRuntime()
  if (!runtime) throw new Error('openOptions: not in extension context')

  // Both Chrome and Firefox MV3 expose openOptionsPage. It honors options_ui
  // open_in_tab from the manifest — no second-guessing here.
  if (typeof runtime.openOptionsPage === 'function') {
    return new Promise((resolve) => runtime.openOptionsPage(resolve))
  }
  // Fallback: direct tab. Should never trigger on supported browsers.
  const tabs = getTabs()
  if (!tabs) throw new Error('openOptions: no openOptionsPage and no tabs API')
  return new Promise((resolve) => tabs.create({ url: runtime.getURL('options.html') }, resolve))
}

export async function closePier(id) {
  const runtime = getRuntime()
  const tabs    = getTabs()
  if (!runtime || !tabs) throw new Error('closePier: not in extension context')

  const url = runtime.getURL(`piers/${id}.html`)
  return new Promise((resolve) => {
    tabs.query({ url }, (matches) => {
      const ids = (matches || []).map((t) => t.id).filter((x) => x != null)
      if (ids.length === 0) return resolve(0)
      tabs.remove(ids, () => resolve(ids.length))
    })
  })
}

// --- internals ---

function getRuntime() {
  return (typeof browser !== 'undefined' && browser.runtime) ||
         (typeof chrome  !== 'undefined' && chrome.runtime)  || null
}
function getTabs() {
  return (typeof browser !== 'undefined' && browser.tabs) ||
         (typeof chrome  !== 'undefined' && chrome.tabs)  || null
}
function getWindows() {
  return (typeof browser !== 'undefined' && browser.windows) ||
         (typeof chrome  !== 'undefined' && chrome.windows)  || null
}
