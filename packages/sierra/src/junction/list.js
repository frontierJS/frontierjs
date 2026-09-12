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
 *
 * ─── A composed list ───────────────────────────────────────────────────────
 *
 * `{ composed: true }` where the service's `find()` answers more than the rows —
 * an `include:`, a per-row count. It is `record(id, { composed: true })` for a
 * list, and for the same reason (`FJS-533`): the store holds one row per node
 * and a push carries the row alone, so a store-backed list drops every
 * relation cell at the first announcement.
 *
 * So these rows are this list's own and never enter the store — a node holding
 * one screen's includes would hand them to every other list over the model. An
 * announcement on the service, or a reconnect, is the TRIGGER and the whole
 * window is read again, one request per burst. Growing the window therefore
 * widens the limit rather than resuming from a cursor: the next push re-reads
 * all of it anyway.
 */

import { createSignal, createEffect, watchPath, untrack, onCleanup } from '@frontierjs/mesa/runtime'
import { page, goto } from '../router/index.js'

const SEARCH_DEBOUNCE_MS = 300

// A deploy drops every socket at once, so an unjittered re-read on reconnect is
// every client querying in the same tick. The same bound junction's store uses.
const RESYNC_JITTER_MS = 2000

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
 * @param {object} resource  the resource this list reads — `load`, `more`, `hasMore`, `store`,
 *                           and for a composed list `find`, `on` and `onResync`
 * @param {{ query?: object, directives?: object } | undefined} listQuery  the resource file's defaults
 * @param {object} [opts]
 * @param {'url'|'local'} [opts.state='url']
 * @param {object} [opts.where]       filters applied over the state, never shown to a bar
 * @param {object} [opts.query]       starting filters, over `listQuery.query`
 * @param {object} [opts.directives]  starting directives, over `listQuery.directives`
 * @param {number} [opts.debounce=300] milliseconds a `search` change waits
 * @param {boolean} [opts.composed=false] the service's `find()` answers more than the rows
 */
export function createList(resource, listQuery, opts = {}) {
  const {
    state    = 'url',
    where    = {},
    debounce = SEARCH_DEBOUNCE_MS,
  } = opts
  const composed = opts.composed === true
  if (state !== 'url' && state !== 'local') {
    throw new Error(`[list] state must be 'url' or 'local', got ${JSON.stringify(state)}`)
  }

  const startQuery      = overlay(listQuery?.query,      opts.query)
  const startDirectives = overlay(listQuery?.directives, opts.directives)

  // ─── State ──────────────────────────────────────────────────────────────

  const [rows,      setRows]      = createSignal(composed ? [] : resource.store.get())
  const [loading,   setLoading]   = createSignal(false)
  const [error,     setError]     = createSignal(null)
  const [more,      setMore]      = createSignal(false)
  const [localQ,    setLocalQ]    = createSignal(startQuery)
  const [localD,    setLocalD]    = createSignal(startDirectives)

  let timer       = null
  let resyncTimer = null

  const route = state === 'url' ? page.route : null

  // Inside an effect so a component that forgets `destroy` still releases the
  // store: the effect is owned by whatever scope created the list, and its
  // cleanups run when that scope is torn down. Nothing in the body is read
  // reactively, so it never re-runs.
  const release = createEffect(() => {
    if (composed) {
      onCleanup(resource.on('*', announced))
      onCleanup(resource.onResync(() => {
        clearTimeout(resyncTimer)
        resyncTimer = setTimeout(announced, Math.random() * RESYNC_JITTER_MS)
      }))
    } else {
      const unsubscribe = untrack(() => resource.store.subscribe((next) => {
        setRows(next)
        setMore(resource.hasMore())
      }))
      onCleanup(unsubscribe)
    }
    onCleanup(() => clearTimeout(timer))
    onCleanup(() => clearTimeout(resyncTimer))
  })

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
  // A composed list's burst state. `running` is the read in flight; `dirty`
  // says an announcement arrived during it, so its answer may already be old
  // and one more read follows — rather than a request per announcement racing
  // to write the rows in arrival order.
  let running = false
  let dirty   = false
  // How many rows a composed read asks for once the window has grown. Null is
  // the state's own limit; a change of state resets it.
  let extent  = null
  // The page a composed read was answered with — the server's, off the
  // envelope, since a caller naming no limit still got one.
  let pageSize = null

  async function run() {
    const stamp = ++issued
    running = true
    setLoading(true)
    setError(null)
    try {
      const query = { ...currentQuery(), ...where }
      if (composed) {
        const directives = extent == null ? currentDirectives() : { ...currentDirectives(), limit: extent }
        const res = await resource.find(query, directives)
        if (stamp !== issued) return
        const data = res?.data ?? []
        if (extent == null && typeof res?.limit === 'number') pageSize = res.limit
        setRows(data)
        setMore(res?.hasMore === true || (typeof res?.total === 'number' && res.total > data.length))
      } else {
        await resource.load(query, currentDirectives())
        if (stamp !== issued) return
        setMore(resource.hasMore())
      }
    } catch (err) {
      if (stamp === issued) setError(err)
    } finally {
      if (stamp === issued) {
        running = false
        setLoading(false)
        if (dirty) {
          dirty = false
          untrack(run)
        }
      }
    }
  }

  function announced() {
    if (state === 'url' && page.route !== route) return
    if (running) { dirty = true; return }
    untrack(run)
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
    extent = null
    dirty  = false
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
    if (composed) {
      extent = rows().length + (pageSize ?? currentDirectives().limit ?? rows().length)
      return untrack(run)
    }
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
