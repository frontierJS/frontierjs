/**
 * router/memory-history.js — an address with no address bar, for a router
 * running where there is no `window`: the terminal shell (`FJS-D809`), and a
 * test that wants navigation without a document.
 *
 *   initRouter(tree, components, loaders, { history: createMemoryHistory('/orders/') })
 *
 * It has the members of `window.history` the router uses, plus the
 * `location` it would otherwise read off `window`, so the router reads one
 * address in either place. `listen(fn)` is the `popstate` listener: `back`,
 * `forward` and `go` move the entry and then call it on the next microtask,
 * and a push or a replace never does.
 *
 * The origin is fixed. Nothing else answers at it, so a link resolved against
 * it either stays on it, and is the app's, or names another host and is not.
 */
const ORIGIN = 'http://localhost'

/**
 * @param {string} [initial='/']  the first entry's path, search and hash
 */
export function createMemoryHistory(initial = '/') {
  const entries = [{ url: new URL(initial, ORIGIN), state: null }]
  let at = 0
  const listeners = new Set()

  const location = {
    get href()     { return entries[at].url.href },
    get protocol() { return entries[at].url.protocol },
    get host()     { return entries[at].url.host },
    get origin()   { return entries[at].url.origin },
    get pathname() { return entries[at].url.pathname },
    get search()   { return entries[at].url.search },
    get hash()     { return entries[at].url.hash },
  }

  // A browser refuses a push to another origin with a SecurityError; so does this.
  const entry = (state, url) => {
    const to = url == null ? entries[at].url : new URL(url, entries[at].url)
    if (to.origin !== ORIGIN) throw new Error(`[Sierra] cannot move a memory history to ${to.href}`)
    return { url: to, state: state ?? null }
  }

  const go = (delta = 0) => {
    const to = at + delta
    if (delta === 0 || to < 0 || to >= entries.length) return
    at = to
    // A browser's `go` returns before `popstate` fires. A guard refusing a
    // popstate calls `go` to put the entry back, so a synchronous call would
    // re-enter the navigation that is still refusing.
    const event = { state: entries[at].state }
    queueMicrotask(() => { for (const fn of [...listeners]) fn(event) })
  }

  return {
    location,
    get state()  { return entries[at].state },
    get length() { return entries.length },
    pushState(state, _title, url) {
      entries.splice(at + 1, Infinity, entry(state, url))
      at++
    },
    replaceState(state, _title, url) {
      entries[at] = entry(state, url)
    },
    back()    { go(-1) },
    forward() { go(1) },
    go,
    listen(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
