/**
 * local-db.js — the device's own SQLite, as sierra's read store.
 *
 * `FJS-D307`'s storage swap, and the thing it buys is one sentence: the list
 * cache answers the exact question it was given and a real query engine answers
 * any of them. A screen that filters, sorts or pages differently offline is the
 * difference between a cache and a database.
 *
 * Opened lazily, once, from `configureLocalDb()` — which `virtual:sierra` calls
 * when the app's config says `offline: { db: true }`. An app that says nothing
 * never loads this module's worker and never fetches its wasm.
 *
 * ── A cache does not re-grade what it was given ────────────────────────────
 *
 * Every row here arrived in an answer the SERVER gave this caller: it is written
 * on the way through a successful `load()` and by nothing else. So it is read
 * back the way `list-cache.js` reads its rows back — replayed, not re-decided —
 * which is why the local read goes through `asSystem()`.
 *
 * That is not the gate being skipped, it is the gate not being asked twice by a
 * grader that would answer differently. A local client auto-installs
 * `FrontierGateGetLevel`, and the app's own resolver is a DIFFERENT function:
 * measured on `example`, the two grade one account 3 and 4, and `Order` is
 * `@@gate("0.4.4.5")`. Re-grading here would make an offline list differ from
 * the online one with nothing raised. Invariant 6 is untouched — the server
 * enforces regardless and the client was never the authority — and the rows are
 * dropped whenever the identity changes, like every other per-principal thing
 * this package holds.
 *
 * ── Only a `@@sync` model has a table here at all ──────────────────────────
 *
 * The device schema is the projection litestone's `deviceSchema()` makes, so a
 * model that never declared `@@sync` has no table to write to and no table to
 * read from. The permission to keep rows on a device is the schema's word
 * (`FJS-D298`), stated once, upstream of this file.
 */

import { normalizeOrderBy, normalizeSelect } from '@frontierjs/junction/client'

let _config = null
let _client = null
let _opening = null
let _closing = null

/**
 * Called by `virtual:sierra` when the app configured `offline: { db: true }`.
 *
 * The engine is started HERE rather than on the first read that needs it. A
 * write-through is a side effect of a load and is deliberately not awaited, so
 * a page that is opened and left inside the second the worker takes to compile
 * SQLite keeps nothing at all — and *have the rows before the outage* is the
 * whole feature. An app that never asked for a database never reaches this
 * line, and the bytes are already in the shell's precache.
 */
export function configureLocalDb(config) {
  _config = config
  localDb().catch(() => {})
}

/** Is there one to talk to? Asked before every write-through, which must cost nothing when off. */
export const localDbConfigured = () => !!_config

/**
 * The client, opened on first use.
 *
 * Answers null rather than throwing on any failure — no OPFS, a worker that
 * will not start, a device out of quota. A local database is an IMPROVEMENT on
 * a failure path; an app that cannot have one must still run, exactly as it did
 * before this existed.
 */
export async function localDb() {
  if (!_config) return null
  if (_client) return _client
  if (_opening) return _opening

  _opening = (async () => {
    try {
      // A clear in flight is still holding the OPFS pool — it empties the
      // tables and then closes the worker. Opening a second one over the same
      // files while that happens does not fail, it kills the renderer
      // (`FJS-1179`), and the window is real: an identity change clears here
      // and cycles the socket, and the reconnect warms.
      if (_closing) await _closing

      const [{ createBrowserClient }, { openWorker }, schema] = await Promise.all([
        import('@frontierjs/litestone/browser'),
        import('./local-db-open.js'),
        fetch(_config.schemaUrl).then(r => r.json()),
      ])
      if (!schema) return null

      // A WORKER rather than a URL, and the difference is not style: a bundler
      // rewrites `new Worker(new URL(…, import.meta.url))` and nothing else, so
      // handing `createBrowserClient` a bare URL to construct for itself leaves
      // the built app asking for a file beside its hashed entry chunk that
      // nothing wrote. Measured: the fetch failed, the page said nothing, and
      // every offline read fell through to the list cache — which looks exactly
      // like the feature working. `openWorker` answers null when the build
      // stubbed it out, which is an app that never asked for a database.
      const worker = openWorker()
      if (!worker) return null

      _client = await createBrowserClient({
        worker,
        wasmUrl: _config.wasmUrl,
        schema,
        db:      _config.db ?? '/fjs-local.db',
      })
      return _client
    } catch (err) {
      console.warn(`[Sierra] the local database did not open, so reads fall back to the list cache: ${err?.message ?? err}`)
      return null
    } finally {
      _opening = null
    }
  })()

  return _opening
}

/**
 * The accessor a model is reached by on the client.
 *
 * Asked of the client's own `$models` rather than derived: litestone decides how
 * a model name becomes a table accessor, and a second derivation here would be
 * right until the day it was not — and wrong then in the way that answers an
 * empty list rather than an error.
 */
function accessorFor(db, model) {
  if (!model) return null
  const models = db.$models ?? []
  const lower  = model.toLowerCase()
  return models.find(m => m.toLowerCase() === lower) ?? null
}

/**
 * Keep what the server just answered.
 *
 * `upsertMany` and not a row at a time: an autocommit INSERT over OPFS is one
 * filesystem sync, measured at 9.23 ms against 0.033 ms batched, which is the
 * difference between a page that pauses and one that does not.
 *
 * Failure is silent on purpose — this is a side effect of a read that already
 * succeeded, and a screen must not fail because a device could not write.
 */
export async function writeThrough(model, rows) {
  if (!_config || !Array.isArray(rows) || rows.length === 0) return false
  try {
    const db = await localDb()
    if (!db) return false
    const accessor = accessorFor(db, model)
    if (!accessor) return false

    await db.asSystem()[accessor].upsertMany({ data: rows })
    return true
  } catch (err) {
    // ONCE, and then never again. Whatever makes one write-through fail makes
    // every one of them fail, so a warning per read would be a console nobody
    // can use — and no warning at all is a device that quietly never holds
    // anything, which is the failure this whole file exists to prevent and the
    // one that is only discovered offline.
    _warnOnce('wrote nothing to the device', err)
    return false
  }
}

const _warned = new Set()
function _warnOnce(what, err) {
  if (_warned.has(what)) return
  _warned.add(what)
  console.warn(`[Sierra] the local database ${what}: ${err?.message ?? err}`)
}

/**
 * Answer a read from the device.
 *
 * The same arguments the SERVER's derived find builds — `{ where, limit,
 * offset, orderBy, select }` — because a junction service over a litestone
 * model passes the caller's filters through as the `where` and its directives
 * as the rest. What differs is only what is there to be found.
 *
 * **`orderBy` and `select` are the two directives that do not travel as
 * themselves**, and the translation is junction's rather than this file's. A
 * screen states `orderBy: '-id'` because that is the wire's spelling; SQLite
 * takes `[{ id: 'desc' }]` and throws on the other. Spelled here it would be a
 * second answer to a settled question — and it was, and the throw fell through
 * to the list cache underneath, so every sorted list offline was answered by
 * the cache and the database was off and green (`FJS-1179`).
 *
 * `null` means *this device cannot answer*, which is not the same as an empty
 * list and must never be rendered as one.
 */
export async function readLocal(model, query, directives) {
  if (!_config) return null
  try {
    const db = await localDb()
    if (!db) return null
    const accessor = accessorFor(db, model)
    if (!accessor) return null

    const d = directives ?? {}
    const args = { where: query ?? {} }
    if (d.limit  != null) args.limit  = d.limit
    if (d.offset != null) args.offset = d.offset
    if (d.orderBy)        args.orderBy = normalizeOrderBy(d.orderBy)
    if (d.select)         args.select  = normalizeSelect(d.select)

    const rows = await db.asSystem()[accessor].findMany(args)
    return Array.isArray(rows) ? rows : null
  } catch (err) {
    _warnOnce(`could not answer a read of ${model}`, err)
    // A filter the local schema cannot answer — a relation that did not cross,
    // a `$search` with no FTS table — is *cannot answer* rather than *no rows*,
    // and the caller falls back to the list cache underneath.
    return null
  }
}

/**
 * Somebody signed out. Rows a gate let the PREVIOUS caller read are theirs.
 *
 * Published as `_closing` while it runs, so the next `localDb()` waits rather
 * than opening a second worker over a pool this one still holds.
 */
export async function clearLocalDb() {
  const db = _client
  _client = null
  if (!db) return

  _closing = (async () => {
    try {
      for (const accessor of db.$models ?? [])
        await db.asSystem()[accessor].deleteMany({ where: {} })
    } catch { /* a database we cannot clear is one we stop reading */ }
    try { await db.$close() } catch { /* already gone */ }
  })()

  try { await _closing } finally { _closing = null }
}

/** Test seam: forget the configuration and the open client. */
export function _resetLocalDb() { _config = null; _client = null; _opening = null; _closing = null }

/**
 * Test seam: stand a client in for the one a worker would have opened.
 *
 * The engine needs a browser, and what this file owns is the SEAM rather than
 * the engine — when it writes, when it reads, and what it does when the device
 * cannot answer. Injected here rather than spied on from outside, because the
 * callers below hold a module-local binding that no namespace spy can reach.
 */
export function _useLocalDbClient(client, config = {}) {
  _config = { schemaUrl: '/x.json', wasmUrl: '/y.js', ...config }
  _client = client
  _opening = null
  _closing = null
}
