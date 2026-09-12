/**
 * sierra/junction/list — `resource.list()`, the layer above a table.
 *
 * A list is five wirings that every page restated: subscribe to the store,
 * decide where the filters live, send them to `load()`, re-run on a change, and
 * grow the window. This is those five, once. It owns no markup — `<Table>` and
 * `<FilterBar>` stay presentational and take what this hands them.
 *
 *   const invoices = createResource('invoices', {
 *     listQuery: { directives: { orderBy: '-issuedAt' } },
 *   })
 *
 *   const list = invoices.list()                               // the URL is the state
 *   const list = notes.list({ state: 'local' })                // embedded
 *   const list = notes.list({ state: 'local', where: { clientId } })
 *
 *   <FilterBar {filters} {search} value={list.query} directives={list.directives} onchange={list.apply} />
 *   <Table {columns} rows={list.rows} orderBy={list.directives.orderBy} onsort={list.sort} />
 *   {#if list.hasMore}<button on:click={list.more}>Load more</button>{/if}
 *
 * ─── Where the state lives ─────────────────────────────────────────────────
 *
 * `'url'` by default: a route-level list left local loses its filters on every
 * refresh and answers the back button with nothing, and looks correct the whole
 * time. An embedded list left on `'url'` writes to an address that is not its
 * own and shows that on the first click. The default rules out the silent one.
 *
 * In `'url'` mode `page.query` and `page.directives` ARE the state and nothing
 * here holds a copy — `apply` navigates and the change arrives back through the
 * router. The list answers only while its route is the one on screen: the
 * router commits `query` before `route`, so a navigation AWAY would otherwise
 * re-ask the server with the next page's filters before this list is torn down.
 *
 * ─── The resource file's defaults ──────────────────────────────────────────
 *
 * `listQuery` is what a list STARTS on, beneath what the caller states. Its
 * directives sit under the URL's key for key, so `?$orderBy=name` beats a
 * declared `-issuedAt`. Its filters apply only while the state carries none of
 * its own, so clearing every filter returns to them: merged under the URL key
 * for key, a default filter could not be cleared from the bar at all, because
 * clearing removes a key and the default would put it back.
 *
 * `where` is not a default. It is applied OVER the filters on every load and is
 * never part of `query`, so a bar cannot see it or widen it — which is what
 * makes an embedded list scoped rather than pre-filtered.
 */

import { createSignal, createEffect, watchPath, untrack, onCleanup } from '@frontierjs/mesa/runtime'
import { page, goto } from '../router/index.js'

const SEARCH_DEBOUNCE_MS = 300

const isEmpty = (o) => !o || Object.keys(o).length === 0

// A key present with `undefined` removes it, so a caller can clear a directive
// through the same merge that sets one.
function overlay(base, top) {
  const out = { ...base }
  for (const [k, v] of Object.entries(top ?? {})) {
    if (v === undefined) delete out[k]
    else out[k] = v
  }
  return out
}

/**
 * @param {object} resource  the resource this list reads — `load`, `more`, `hasMore`, `store`
 * @param {{ query?: object, directives?: object } | undefined} listQuery  the resource file's defaults
 * @param {object} [opts]
 * @param {'url'|'local'} [opts.state='url']
 * @param {object} [opts.where]       filters applied over the state, never shown to a bar
 * @param {object} [opts.query]       starting filters, over `listQuery.query`
 * @param {object} [opts.directives]  starting directives, over `listQuery.directives`
 * @param {number} [opts.debounce=300] milliseconds a `search` change waits
 */
export function createList(resource, listQuery, opts = {}) {
  const {
    state    = 'url',
    where    = {},
    debounce = SEARCH_DEBOUNCE_MS,
  } = opts
  if (state !== 'url' && state !== 'local') {
    throw new Error(`[list] state must be 'url' or 'local', got ${JSON.stringify(state)}`)
  }

  const startQuery      = overlay(listQuery?.query,      opts.query)
  const startDirectives = overlay(listQuery?.directives, opts.directives)

  // ─── State ──────────────────────────────────────────────────────────────

  const [rows,      setRows]      = createSignal(resource.store.get())
  const [loading,   setLoading]   = createSignal(false)
  const [error,     setError]     = createSignal(null)
  const [more,      setMore]      = createSignal(false)
  const [localQ,    setLocalQ]    = createSignal(startQuery)
  const [localD,    setLocalD]    = createSignal(startDirectives)

  let timer = null

  // Inside an effect so a component that forgets `destroy` still releases the
  // store: the effect is owned by whatever scope created the list, and its
  // cleanups run when that scope is torn down. Nothing in the body is read
  // reactively, so it never re-runs.
  const release = createEffect(() => {
    const unsubscribe = untrack(() => resource.store.subscribe((next) => {
      setRows(next)
      setMore(resource.hasMore())
    }))
    onCleanup(unsubscribe)
    onCleanup(() => clearTimeout(timer))
  })

  const route = state === 'url' ? page.route : null

  function currentQuery() {
    if (state === 'local') return localQ()
    return isEmpty(page.query) ? startQuery : page.query
  }

  function currentDirectives() {
    if (state === 'local') return localD()
    return overlay(startDirectives, page.directives)
  }

  // ─── Loading ────────────────────────────────────────────────────────────

  let issued = 0
  async function run() {
    const stamp = ++issued
    setLoading(true)
    setError(null)
    try {
      await resource.load({ ...currentQuery(), ...where }, currentDirectives())
      if (stamp !== issued) return
      setMore(resource.hasMore())
    } catch (err) {
      if (stamp === issued) setError(err)
    } finally {
      if (stamp === issued) setLoading(false)
    }
  }

  const stop = createEffect(() => {
    if (state === 'url') {
      watchPath(page, 'query')[0]()
      watchPath(page, 'directives')[0]()
      if (page.route !== route) return
    } else {
      localQ()
      localD()
    }
    untrack(run)
  })

  // ─── Changing it ────────────────────────────────────────────────────────

  function commit(query, directives, { replace }) {
    if (state === 'local') {
      setLocalQ(query)
      setLocalD(directives)
      return
    }
    return goto(page.pathname, query, { directives, replace })
  }

  /**
   * Replace the state with the two halves `<FilterBar>` emits. Each half
   * REPLACES rather than merges, because the bar hands back the whole bag it
   * holds and clears a value by leaving its key out — a merge would keep the
   * search a person just deleted. A half left `undefined` keeps what is there.
   *
   * A change to `search` alone waits for the typing to stop and replaces the
   * history entry, so a search box does not refetch or push an entry per
   * keystroke; any other change goes at once.
   */
  function apply(query, directives) {
    const nextQuery      = query      ?? currentQuery()
    const nextDirectives = directives ?? currentDirectives()
    clearTimeout(timer)

    const searchOnly = sameBag(nextQuery, currentQuery())
      && sameBag(omit(nextDirectives, 'search'), omit(currentDirectives(), 'search'))
      && nextDirectives.search !== currentDirectives().search

    if (searchOnly && debounce > 0) {
      timer = setTimeout(() => commit(nextQuery, nextDirectives, { replace: state === 'url' }), debounce)
      return
    }
    return commit(nextQuery, nextDirectives, { replace: false })
  }

  /** The ordering `<Table onsort>` reports, as one call. */
  function sort(orderBy) {
    return apply(undefined, overlay(currentDirectives(), { orderBy }))
  }

  async function growWindow() {
    setError(null)
    try {
      await resource.more()
    } catch (err) {
      setError(err)
    }
    setMore(resource.hasMore())
  }

  function destroy() {
    stop()
    release()
  }

  return {
    get rows()       { return rows() },
    get query()      { return state === 'url' ? (watchPath(page, 'query')[0](), currentQuery()) : localQ() },
    get directives() { return state === 'url' ? (watchPath(page, 'directives')[0](), currentDirectives()) : localD() },
    get loading()    { return loading() },
    get error()      { return error() },
    get hasMore()    { return more() },
    apply,
    sort,
    more:   growWindow,
    reload: () => untrack(run),
    destroy,
  }
}

function omit(o, key) {
  const { [key]: _, ...rest } = o
  return rest
}

function sameBag(a, b) {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]))
}
