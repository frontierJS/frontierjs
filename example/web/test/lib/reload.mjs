// web/test/lib/reload.mjs — a browser drive's detector for a reload nobody asked for.
//
// Vite full-reloads the page when a watched module changes -- a plain JS file
// under a workspace package is watched, and two sessions share one tree. The
// failure then reads as a bug on whatever screen the drive had reached
// (`Inspected target navigated or closed`, a form that seems to submit
// natively, a timeout), and nothing says the page reloaded. A drive navigates
// the main frame only through Page.navigate (or `during`, for a navigation it
// starts from inside the page), so a navigation arriving outside both is
// somebody's edit.
//
//   const browser = await openChrome()
//   const reload = watchReloads(browser)       // before cmd is destructured
//   ...
//   await reload.settle()                      // in a failure path, then read it
//
// The process then exits 1 naming the cause whatever path it leaves by, so a
// drive adds no check of its own. The evaluate that dies with the old document
// rejects BEFORE the navigation event arrives, hence `settle`.

/** Wait a beat for a navigation event that trails the call it killed. */
const BEAT_MS = 1000

export function watchReloads(browser) {
  let navigating = 0
  let reloaded   = null

  browser.on('Page.frameNavigated', (p) => {
    if (p.frame.parentId || navigating) return
    reloaded ??= p.frame.url
  })

  async function during(fn) {
    navigating++
    try { return await fn() } finally { navigating-- }
  }

  // Wrapped in place: every drive destructures `cmd` from the browser once.
  const send = browser.cmd
  browser.cmd = (method, params) => method === 'Page.navigate' ? during(() => send(method, params)) : send(method, params)

  const message = () => reloaded &&
    `the page was RELOADED under the drive (navigated to ${reloaded} with no navigation in flight) -- ` +
    'a watched file changed; see "[vite] (client) page reload" in the web server log, and rerun when the tree is quiet'

  process.on('exit', () => {
    if (!reloaded) return
    console.error('\n' + message())
    process.exitCode = 1
  })

  return {
    during,
    message,
    get reloaded() { return reloaded },
    settle: () => new Promise((r) => setTimeout(r, BEAT_MS)),
  }
}
