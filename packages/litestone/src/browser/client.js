// browser/client.js — the page's half of the browser client.
//
// `createBrowserClient()` answers something that looks like a Litestone client
// and is a proxy over a worker. `db.count.findMany({ where })` is the same
// expression it is on a server, and it has always been awaited, which is why
// the worker fits under it with nothing rewritten (`IDEAS/homestead.md` phase
// 4, `FJS-D305`).
//
// ─── What this is NOT ─────────────────────────────────────────────────────
//
// **`$transaction` is refused, by name — and the answer is `createMany`.** A
// callback runs on the PAGE, so a transaction opened for it would hold SQLite's
// write lock across main-thread event-loop turns — across a `fetch`, a render,
// or a user who walked away — and the deadlock shape `core/pragmas.js`
// documents becomes reachable from a click.
//
// What a caller actually wants here is one message the worker runs end to end,
// and litestone has had that verb all along: `createMany` and `upsertMany`
// carry their rows in a single call. **It is not a nicety, it is the whole
// difference between a feature and a hang** — measured in Chrome, an autocommit
// INSERT over OPFS is one filesystem sync, so 2,000 rows cost 0.033 ms each
// batched and 9.23 ms each one at a time. That is 0.3 seconds against 46 for a
// 5,000-row hydration. The engine itself is not the cost: batched, it matches
// `bun:sqlite` on a server to within a rounding error.
//
// **It is not a second query implementation.** Every answer comes from the same
// `core/client.js`, the same gates and the same SQL — which is the whole claim
// phase 4 exists to make, and the reason `x-gate` on the client stays a UI
// affordance that the server re-checks regardless (Invariant 6).

const DEFAULT_DB = '/litestone.db'

// A method name is anything; a MODEL name is checked against what the worker
// reported, because a typo there is the failure that otherwise arrives as a
// message rejected in another thread with no stack a reader recognizes.
const CLIENT_KEYS = new Set(['asSystem', '$setAuth', '$scopedBy', '$close', '$models', '$engine', 'then'])

/**
 * @param {object} opts
 * @param {string|URL} opts.worker   URL of a module worker whose body is
 *                                   `@frontierjs/litestone/browser/worker`.
 *                                   Passed in rather than constructed here:
 *                                   every bundler spells worker URLs
 *                                   differently and guessing is how this breaks
 *                                   in exactly one of them.
 * @param {string} opts.wasmUrl      URL of the SQLite wasm ES module.
 * @param {string|object} opts.schema  The `.lite` source as text, or a parse
 *                                   result the host already made. A browser has
 *                                   no filesystem, so neither can be read from
 *                                   disk — and a real app sends the PARSED form,
 *                                   because a projection of it is how a device
 *                                   gets the models it needs without the prose
 *                                   (`FJS-D204`) or the policies (`FJS-D303`).
 * @param {string} [opts.db]         The database's name in OPFS.
 */
export async function createBrowserClient({ worker, wasmUrl, schema, db = DEFAULT_DB, vfs, capacity, options } = {}) {
  if (!worker)  throw new Error('createBrowserClient: pass worker: new URL(…, import.meta.url)')
  if (!wasmUrl) throw new Error('createBrowserClient: pass wasmUrl: the URL of the SQLite wasm module')
  if (!schema)  throw new Error('createBrowserClient: pass schema: the .lite source as text')

  const w = worker instanceof Worker ? worker : new Worker(worker, { type: 'module' })

  let nextId = 0
  const waiting = new Map()

  w.onmessage = ({ data }) => {
    const pending = waiting.get(data.id)
    if (!pending) return
    waiting.delete(data.id)
    data.err ? pending.reject(rebuild(data.err)) : pending.resolve(data.ok)
  }

  // A worker that fails to parse fires `error` and never answers, so every call
  // would hang. Rejecting everything outstanding turns that into one message.
  w.onerror = (event) => {
    const err = new Error(`[Litestone] the client worker failed: ${event.message ?? 'unknown error'}`)
    for (const { reject } of waiting.values()) reject(err)
    waiting.clear()
  }

  const post = (op, payload = {}) => new Promise((resolve, reject) => {
    // A terminated worker answers nothing, so a call made after the document
    // let it go would wait for all time rather than fail.
    if (closed) return reject(new Error(GONE))
    const id = ++nextId
    waiting.set(id, { resolve, reject })
    w.postMessage({ id, op, ...payload })
  })

  // ── The worker does not outlive the document ──────────────────────────────
  //
  // **A navigation does not close a worker**, and this one holds OPFS access
  // handles that are EXCLUSIVE. The leaving page's worker is still alive while
  // the arriving page's opens, the two fight over the same pool, and in Chrome
  // that does not fail — it kills the RENDERER, taking the page and the app's
  // service worker with it. From the outside that reads as a hang: the tab
  // stops answering, and so does every CDP call a drive makes against it
  // (`FJS-1179`, found on the second visit to one screen).
  //
  // `pagehide` and not `unload`, because `unload` does not fire on a page that
  // goes into the back/forward cache — and that page is the one whose worker
  // outlives it longest. A restored page finds a closed client and opens a new
  // one, which is why this releases the BINDINGS as well as the thread.
  let closed = false
  const release = () => {
    closed = true
    try { w.terminate() } catch { /* already gone */ }
    for (const { reject } of waiting.values()) reject(new Error(GONE))
    waiting.clear()
  }
  if (typeof addEventListener === 'function') addEventListener('pagehide', release)

  const opened = await post('open', { schema, db, wasmUrl, vfs, capacity, options })
  const models = new Set(opened.models)

  const make = (flavor) => new Proxy({}, {
    get(_, key) {
      if (typeof key !== 'string') return undefined

      // `await createBrowserClient()` hands the result to the microtask queue,
      // which asks a Proxy for `then` and calls anything it finds — so a
      // client that answered a function here would be awaited forever.
      if (key === 'then')      return undefined
      if (key === '$models')   return [...models]
      if (key === '$engine')   return opened.engine
      if (key === 'asSystem')  return () => make({ kind: 'system' })
      if (key === '$setAuth')  return (user) => make({ kind: 'auth', user })
      if (key === '$close')    return async () => { try { await post('close') } finally { release() } }
      if (key === '$transaction') return () => { throw new Error(REFUSAL) }

      if (!models.has(key)) throw new Error(
        `[Litestone] '${key}' is not a model in this schema. Models: ${[...models].join(', ')}`)

      return new Proxy({}, {
        get(_t, method) {
          if (typeof method !== 'string' || method === 'then') return undefined
          return (...args) => post('call', { flavor, model: key, method, args })
        },
      })
    },
  })

  return make({ kind: 'none' })
}

const GONE =
  '[Litestone] this browser client is closed — the page it belonged to went away.\n' +
  '  Open another with createBrowserClient(); the database itself is untouched.'

const REFUSAL =
  '[Litestone] $transaction is not available on a browser client.\n' +
  '  The callback runs on the page, so the write lock would be held across main-thread turns —\n' +
  '  across a fetch, a render, or a user who walked away.\n' +
  '  For many rows at once use createMany() or upsertMany(), which carry their rows in ONE call\n' +
  '  and are the thing that makes a hydration take 0.3s instead of 46s.\n' +
  '  For an offline WRITE, the pending queue replays it against the server (FJS-D301).'

// The worker sends a plain object because an Error loses its own properties to
// structuredClone. Rebuilt here so that `err.code === 'ACCESS_DENIED'` is the
// same expression a caller writes on the server.
function rebuild(shape) {
  const err = new Error(shape.message)
  err.name = shape.name ?? 'Error'
  for (const [key, value] of Object.entries(shape))
    if (key !== 'message' && key !== 'name') err[key] = value
  return err
}
