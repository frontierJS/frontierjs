/**
 * sierra/resource/tethered — `resource.tethered()`, the one door a screen lists
 * rows through (`FJS-D1318`), and the layer above a table.
 *
 * It is five wirings that every page restated: subscribe to the tether,
 * decide where the filters live, send them to `load()`, re-run on a change, and
 * grow the window. This is those five, once. It owns no markup — `<Table>` and
 * `<FilterBar>` stay presentational and take what this hands them. The tether,
 * `load`, `more` and `stale` are the machinery underneath and none of them is a
 * key of the resource, so a screen has no second way to fill a table.
 *
 *   const invoices = createResource('invoices', {
 *     tetheredQuery: { directives: { orderBy: '-issuedAt' } },
 *   })
 *
 *   const list = invoices.tethered()                               // the URL is the state
 *   const list = notes.tethered({ state: 'local' })                // embedded, or a dock that only subscribes
 *   const list = notes.tethered({ state: 'local', where: { clientId } })
 *   const list = cards.tethered({ state: 'local', where: { listId }, all: true })  // every row, not a page
 *
 *   <FilterBar {filters} {search} value={list.query} directives={list.directives} onchange={list.apply} />
 *   <Table {columns} rows={list.rows} orderBy={list.directives.orderBy} onsort={list.sort} />
 *   {#if list.hasMore}<button onclick={list.more}>Load more</button>{/if}
 *   <h1>{list.total ?? list.rows.length} Invoices</h1>        // total is null until the first answer
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
 * `tetheredQuery` is what a list STARTS on, beneath what the caller states. Its
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
 * ─── Whose rows these are ──────────────────────────────────────────────────
 *
 * A list stating no `where` and no `query` of its own IS the resource's tether:
 * every such list on a page shows one set of rows, which is what a route's list
 * and a table beside it want. A list that states a filter keeps its own rows,
 * answered by its own `load()` and moved by a push through the same matcher the
 * tether uses, so a page can hold a list per filter. `{ composed: true }` is
 * for a service that answers more than the rows, and owns its rows for that.
 *
 * ─── A composed list ───────────────────────────────────────────────────────
 *
 * `{ composed: true }` where the service's `find()` answers more than the rows —
 * an `include:`, a per-row count. It is `record(id, { composed: true })` for a
 * list, and for the same reason (`FJS-533`): the tether holds one row per entry
 * and a push carries the row alone, so a tether-backed list drops every
 * relation cell at the first announcement.
 *
 * So these rows are this list's own and never enter the tether — an entry holding
 * one screen's includes would hand them to every other list over the model. An
 * announcement on the service, or a reconnect, is the TRIGGER and the whole
 * window is read again, one request per burst. Growing the window therefore
 * widens the limit rather than resuming from a cursor: the next push re-reads
 * all of it anyway.
 */

import { createSignal, createEffect, watchPath, untrack, onCleanup } from '@frontierjs/mesa/runtime'
import { page, goto } from '../router/index.js'
import { unreachable } from './pending.js'

const SEARCH_DEBOUNCE_MS = 300

// A deploy drops every socket at once, so an unjittered re-read on reconnect is
// every client querying in the same tick. The same bound junction's tether uses.
const RECONNECT_JITTER_MS = 2000

const isEmpty = (o) => !o || Object.keys(o).length === 0

/**
 * Does this list keep its own rows? One that states a filter of its own does
 * (`FJS-D1165`); one that states none is the resource's tether. A composed list
 * has its own already.
 */
export const ownsRows = (opts) => opts?.composed !== true && (!isEmpty(opts?.where) || !isEmpty(opts?.query))

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
 * @param {object} resource  the machinery these rows are read through — `load`, `more`, `hasMore`, `tether`,
 *                           `dispose` for rows of its own, and for a composed list `find`, `on`
 *                           and `onReconnected`
 * @param {{ query?: object, directives?: object } | undefined} tetheredQuery  the resource file's defaults
 * @param {object} [opts]
 * @param {'url'|'local'} [opts.state='url']
 * @param {object} [opts.where]       filters applied over the state, never shown to a bar
 * @param {object} [opts.query]       starting filters, over `tetheredQuery.query`
 * @param {object} [opts.directives]  starting directives, over `tetheredQuery.directives`
 * @param {number} [opts.debounce=300] milliseconds a `search` change waits
 * @param {boolean} [opts.composed=false] the service's `find()` answers more than the rows
 * @param {boolean} [opts.all=false] every load grows the window to the query's end
 */
export function createTethered(resource, tetheredQuery, opts = {}) {
  const {
    state    = 'url',
    where    = {},
    debounce = SEARCH_DEBOUNCE_MS,
  } = opts
  const composed = opts.composed === true
  const whole    = opts.all === true
  if (state !== 'url' && state !== 'local') {
    throw new Error(`[tethered] state must be 'url' or 'local', got ${JSON.stringify(state)}`)
  }
  // A composed list re-reads its whole window on every announcement, so a
  // composed list of every row re-reads the table on every write to it.
  if (composed && whole) {
    throw new Error(`[tethered] { all: true } cannot be composed — every push would re-read every row.\n` +
      `  Drop the include from find(), or page a composed list with more().`)
  }

  const startQuery      = overlay(tetheredQuery?.query,      opts.query)
  const startDirectives = overlay(tetheredQuery?.directives, opts.directives)

  // ─── State ──────────────────────────────────────────────────────────────

  const [rows,      setRows]      = createSignal(composed ? [] : resource.tether.get())
  const [loading,   setLoading]   = createSignal(false)
  const [error,     setError]     = createSignal(null)
  const [more,      setMore]      = createSignal(false)
  const [total,     setTotal]     = createSignal(null)
  const [localQ,    setLocalQ]    = createSignal(startQuery)
  const [localD,    setLocalD]    = createSignal(startDirectives)

  let timer       = null
  let reconnectTimer = null

  const route = state === 'url' ? page.route : null

  // Inside an effect so a component that forgets `destroy` still releases the
  // tether: the effect is owned by whatever scope created the list, and its
  // cleanups run when that scope is torn down. Nothing in the body is read
  // reactively, so it never re-runs.
  const release = createEffect(() => {
    if (composed) {
      onCleanup(resource.on('*', announced))
      onCleanup(resource.onReconnected(() => {
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(announced, Math.random() * RECONNECT_JITTER_MS)
      }))
    } else {
      const unsubscribe = untrack(() => resource.tether.subscribe((next) => {
        setRows(next)
        setMore(resource.hasMore())
        setTotal(resource.total?.() ?? null)
      }))
      onCleanup(unsubscribe)
      if (resource.dispose) onCleanup(resource.dispose)
    }
    onCleanup(() => clearTimeout(timer))
    onCleanup(() => clearTimeout(reconnectTimer))
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
        // Silence falls to `load()`, the one owner of the device and the list
        // cache: `composed` is a word about the response envelope, and without
        // this it also opted the screen out of offline (FJS-1281). Offline the
        // rows are the device's, bare of what the find composed onto them.
        let res
        try {
          res = await resource.find(query, directives)
        } catch (err) {
          if (!unreachable(err)) throw err
          const rows = await resource.load(query, directives)
          if (stamp !== issued) return
          setRows(rows)
          setMore(false)
          setTotal(null)
          return
        }
        if (stamp !== issued) return
        let data = res?.data ?? []
        if (extent == null && typeof res?.limit === 'number') pageSize = res.limit
        // The server clamps a limit to its page cap, so a window past it comes
        // back one page long; the rest is walked by cursor. Rows are set once,
        // at the end, so a screen never reads the first page of a window it is
        // re-asking.
        const first = res
        while (extent != null && data.length < extent && res?.hasMore === true && typeof res.endCursor === 'string') {
          res = await resource.find(query, { ...directives, limit: extent - data.length, after: res.endCursor })
          if (stamp !== issued) return
          if (!res?.data?.length) break
          data = [...data, ...res.data]
        }
        setRows(data)
        // A cursor page carries no total, so the count is the first read's.
        const count = first?.total
        setMore(res?.hasMore === true || (typeof count === 'number' && count > data.length))
        setTotal(typeof count === 'number' ? count : null)
      } else {
        const loaded = await resource.load(query, currentDirectives())
        if (stamp !== issued) return
        resource.loaded?.(loaded)
        if (whole) await drain(stamp)
        if (stamp !== issued) return
        setMore(resource.hasMore())
        setTotal(resource.total?.() ?? null)
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
    return goto(page.pathname, query, { directives: changedFrom(startDirectives, directives), replace })
  }

  /**
   * Replace the state with the two halves `<FilterBar>` emits. Each half
   * REPLACES rather than merges, because the bar hands back the whole bag it
   * holds and clears a value by leaving its key out — a merge would keep the
   * search a person just deleted. A half left `undefined` keeps what is there.
   *
   * A change made only of typing — `search`, or a `contains` filter, which is
   * a box typed into the same way — waits for the typing to stop and replaces
   * the history entry, so a box does not refetch or push an entry per
   * keystroke; any other change goes at once.
   */
  function apply(query, directives) {
    const nextQuery      = query      ?? currentQuery()
    const nextDirectives = directives ?? currentDirectives()
    const was            = currentQuery()
    clearTimeout(timer)

    const moved  = movedKeys(nextQuery, was)
    const typing = sameBag(omit(nextDirectives, 'search'), omit(currentDirectives(), 'search'))
      && moved.every(k => typed(nextQuery[k]) && typed(was[k]))
      && (moved.length > 0 || nextDirectives.search !== currentDirectives().search)

    if (typing && debounce > 0) {
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

  // `{ all: true }`: the window grown to the query's end after every load,
  // inside the load, so a filter change or a reload is whole again rather than
  // page one. It stops on a page that added nothing as well as on `hasMore`:
  // a window that holds the end can still answer `hasMore` true (FJS-2617,
  // FJS-D906), and a loop on `hasMore` alone spins on resolved promises. A
  // refused page throws to `run`, which reports it on `error` and stops.
  async function drain(stamp) {
    while (resource.hasMore()) {
      const added = await resource.more()
      if (stamp !== issued || !added?.length) return
    }
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
    get total()      { return total() },
    apply,
    sort,
    more:   growWindow,
    reload: () => untrack(run),
    destroy,
  }
}

// What the address carries is what was CHANGED from the start. `<FilterBar>`
// and `sort` hand back the whole bag, the start included, so the view's own
// `populate` or `onlyDeleted` came out as `?$populate=…` and a reload of that
// address carried it on (FJS-1957). Left off, `currentDirectives()` lays the
// start back underneath, so a value returned to its default drops out too.
function changedFrom(start, directives) {
  const out = {}
  for (const [k, v] of Object.entries(directives ?? {})) {
    if (k in start && JSON.stringify(start[k]) === JSON.stringify(v)) continue
    out[k] = v
  }
  return out
}

function omit(o, key) {
  const { [key]: _, ...rest } = o
  return rest
}

function movedKeys(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
}

/** Absent, or `{ contains: text }` — what a typed-into filter box writes. */
function typed(v) {
  if (v === undefined) return true
  return v !== null && typeof v === 'object' && Object.keys(v).length === 1 && typeof v.contains === 'string'
}

function sameBag(a, b) {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]))
}
