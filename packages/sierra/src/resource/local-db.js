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
 * `@@gate(0.4.4.5)`. Re-grading here would make an offline list differ from
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

import { normalizeOrderBy, normalizeSelect } from '@frontierjs/toolbelt/query'

let _config = null
let _client = null
let _opening = null
let _closing = null
// The device schema the client was opened over: what says which columns of a
// row the server answered are not the device's to write.
let _schema = null

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
  _watchPage()
  localDb().catch(() => {})
}

// Litestone's client rejects an open in flight when the page hides, and that is
// a navigation, not a database that failed to open. Registered here, before the
// client's own `pagehide` listener exists, so this one runs first and the
// rejection finds the flag already set. A page restored from the back/forward
// cache is a live page again.
let _leaving = false
let _watching = false
function _watchPage() {
  if (_watching || typeof globalThis.addEventListener !== 'function') return
  _watching = true
  globalThis.addEventListener('pagehide', () => { _leaving = true })
  globalThis.addEventListener('pageshow', () => { _leaving = false })
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
      _schema = schema
      return _client
    } catch (err) {
      if (_leaving) return null
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
 * Failure is silent on purpose — this is a side effect of a read that already
 * succeeded, and a screen must not fail because a device could not write.
 */
export async function writeThrough(model, rows, whole = null) {
  try {
    return await writeRows(model, rows, whole)
  } catch (err) {
    // Once per MODEL. Whatever makes one write-through of a model fail usually
    // makes every one of them fail, so a warning per read is a console nobody
    // can use; but keyed once per document, the first model to fail hid every
    // other one, and a device that holds nothing is only discovered offline.
    _warnOnce(`wrote nothing of ${model} to the device`, err)
    return false
  }
}

/**
 * The write itself, which THROWS what the device refused.
 *
 * `upsertMany` and not a row at a time: an autocommit INSERT over OPFS is one
 * filesystem sync, measured at 9.23 ms against 0.033 ms batched, which is the
 * difference between a page that pauses and one that does not. The batch is one
 * transaction, so one refused row refuses all of it. A parent the device does
 * not hold is not a refusal: the device's connection does not enforce foreign
 * keys, because it holds a window the server's keys were enforced over
 * (`FJS-D485`), so a screen's `load()` writes in whatever order it arrives.
 *
 * **`whole` is `{ where, idField }` when the rows are the server's WHOLE answer
 * to `where`** — see `answeredWhole()`. Every row the device holds under that
 * `where` and the answer did not name is then taken off: an upsert alone never
 * removes anything, so a row deleted on the server, or one that left the
 * question, stayed on the device and answered offline reads for good
 * (`FJS-2256`). An empty whole answer is written for the same reason.
 *
 * Answers false where there is nothing to write to: no config, no rows and no
 * whole answer, no database, or a model the device does not hold.
 */
export async function writeRows(model, rows, whole = null) {
  if (!_config || !Array.isArray(rows)) return false
  if (rows.length === 0 && !whole) return false
  const db = await localDb()
  if (!db) return false
  const accessor = accessorFor(db, model)
  if (!accessor) return false

  const table = db.asSystem()[accessor]
  if (rows.length) {
    const shape = _shapeOf(model)
    await _land(table, shape ? rows.map(r => _writable(r, shape)) : rows, shape)
  }
  if (whole) await _dropAbsent(model, table, rows, whole)
  return true
}

// ─── what of the server's row the device can write ─────────────────────────────

// Columns the client refuses to write by name (`_virtualWriteKeys` in
// litestone's core/client.js): a value computed on read, with no column behind it.
const SERVER_OWNED = new Set(['computed', 'generated', 'funcCall', 'derived', 'transient', 'from'])

const _shapes = new Map()

/** The columns of `model` the device cannot write, and its key; null where the schema is not known. */
function _shapeOf(model) {
  if (_shapes.has(model)) return _shapes.get(model)
  const m = _schema?.schema?.models?.find(x => x.name === model)
  const shape = m && {
    owned: new Set(m.fields.filter(f => f.attributes?.some(a => SERVER_OWNED.has(a.kind))).map(f => f.name)),
    key:   m.fields.filter(f => f.attributes?.some(a => a.kind === 'id')).map(f => f.name),
  }
  _shapes.set(model, shape ?? null)
  return shape ?? null
}

function _writable(row, { owned }) {
  if (!row || !owned.size || !Object.keys(row).some(k => owned.has(k))) return row
  return Object.fromEntries(Object.entries(row).filter(([k]) => !owned.has(k)))
}

// A `select`ed answer is a slice of a row, and an insert needs the row. The
// slice is merged over the row the device holds, so a held row takes the new
// values in one batch; one the device does not hold cannot be built from a
// slice and is left for a read that asks for all of it.
async function _land(table, rows, shape) {
  try {
    return await _upsert(table, rows)
  } catch (err) {
    if (err?.name !== 'ValidationError' || shape?.key.length !== 1) throw err
    const [id] = shape.key
    const held = new Map((await table.findMany({
      where: { [id]: { in: rows.map(r => r?.[id]).filter(v => v != null) } },
    })).map(r => [r[id], _writable(r, shape)]))
    const merged = rows.filter(r => r?.[id] != null).map(r => held.has(r[id]) ? { ...held.get(r[id]), ...r } : r)
    try {
      return await _upsert(table, merged)
    } catch (again) {
      if (again?.name !== 'ValidationError') throw again
      // A batch is one transaction; what no merge completes is dropped row by row.
      for (const r of merged) {
        try { await _upsert(table, [r]) } catch (one) { if (one?.name !== 'ValidationError') throw one }
      }
    }
  }
}

// An update gate of 9 refuses the system client too, and upsertMany grades its
// conflict half as an update (`FJS-1700`). Such a row never changes on the
// server, so replaying it insert-only loses nothing — and without this an
// append-only ledger like `@@gate(5.5.9.9)` kept nothing on the device.
//
// A `@@softDelete` column is written by remove() and restore() and by no
// update-family verb (`FJS-D923`), and a row's keys are the conflict half
// unless `update:` says otherwise. The insert half still carries `deletedAt`;
// the conflict half leaves it, which loses nothing: the device never soft-deletes
// (`_dropAbsent` purges), so a row the server restored is inserted afresh.
async function _upsert(table, rows, update) {
  const args = update ? { data: rows, update } : { data: rows }
  try {
    await table.upsertMany(args)
  } catch (err) {
    if (!update && err?.name === 'SoftDeleteWriteError') {
      const keys = [...new Set(rows.flatMap(r => Object.keys(r ?? {})))]
      return _upsert(table, rows, keys.filter(k => k !== 'deletedAt'))
    }
    if (!(err?.code === 'ACCESS_DENIED' && err.operation === 'update' && err.required === 9)) throw err
    if (update && !update.length) throw err
    await table.upsertMany({ data: rows, update: [] })
  }
}

/**
 * Was this answer everything the server holds for its `where`?
 *
 * The question `hasMore()` asks, answered the way junction's live list answers
 * it — `total` where the server counted, its own `hasMore` where it did not —
 * so the warm, which reads a bare envelope, and a `load()`, which reads the
 * list's state, cannot disagree about the same answer. A page past the first,
 * a cursor and a search are never whole: each names a slice of the `where`,
 * and taking off what a slice left out would empty the rest of the table.
 *
 * `res` is the envelope, a bare array — a service answering no metadata is a
 * list with no page 2, which is what `hasMore()` says of it too — or
 * `{ data, hasMore }` from a live list that has already decided.
 */
export function answeredWhole(res, directives) {
  const d = directives ?? {}
  if (d.search || d.after != null || Number(d.offset ?? 0) > 0) return false
  if (Array.isArray(res)) return true
  if (!Array.isArray(res?.data)) return false
  const offset = typeof res.offset === 'number' ? res.offset : 0
  if (offset > 0) return false
  return typeof res.total === 'number' ? res.total <= res.data.length : res.hasMore !== true
}

// The device's rows under `where`, less the ones the answer named. Read with
// the same `where` `readLocal` answers an offline read with, so what this takes
// off is exactly what that read would otherwise have shown. A `where` the
// device cannot evaluate — a relation that did not cross — takes nothing off,
// and `readLocal` declines the same question, so nothing stale is shown either.
async function _dropAbsent(model, table, rows, { where, idField }) {
  // A `select` that left the key out names no row, and every held row would
  // read as one the answer did not name.
  // A `select` that left the key out names no row, and every held row would
  // read as one the answer did not name.
  // A `select` that left the key out names no row, and every held row would
  // read as one the answer did not name.
  if (!idField || rows.some(r => r?.[idField] == null)) return
  try {
    const named = new Set(rows.map(r => String(r?.[idField])))
    const held  = await table.findMany({ where: where ?? {}, select: { [idField]: true } })
    const gone  = held.map(r => r?.[idField]).filter(id => id != null && !named.has(String(id)))
    if (gone.length) await table.deleteMany({ where: { [idField]: { in: gone } } })
  } catch (err) {
    // A delete gate of 9 refuses the system client as an update gate does, and
    // such a model's rows are never removed on the server either.
    _warnOnce(`took nothing off ${model} that the server no longer answers`, err)
  }
}

/**
 * Take rows off the device by key — a `remove` the server acknowledged.
 *
 * A side effect of a write that already landed, so it never throws: a device
 * that could not drop the row has the next whole answer to take it off.
 */
export async function dropRows(model, idField, ids) {
  const keys = (ids ?? []).filter(id => id != null)
  if (!_config || !idField || !keys.length) return false
  try {
    const db = await localDb()
    if (!db) return false
    const accessor = accessorFor(db, model)
    if (!accessor) return false
    await db.asSystem()[accessor].deleteMany({ where: { [idField]: { in: keys } } })
    return true
  } catch (err) {
    _warnOnce(`kept a row of ${model} the server removed`, err)
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
 * The same call the SERVER's derived find makes — `findMany({ where, limit,
 * offset, orderBy, select })`, or `search(term, …)` under a `$search` — because a junction service over a litestone
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

    // A search is the engine's `search()`, as it is on the server; left out of
    // `args` it was a read of the whole table, stored as the screen's rows
    // (`FJS-1311`). A device schema with no FTS index refuses it by name.
    const table = db.asSystem()[accessor]
    const rows = d.search
      ? await table.search(d.search, args)
      : await table.findMany(args)
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
export function _resetLocalDb() { _config = null; _client = null; _schema = null; _shapes.clear(); _opening = null; _closing = null; _leaving = false; _watching = false; _warned.clear() }

/**
 * Test seam: stand a client in for the one a worker would have opened.
 *
 * The engine needs a browser, and what this file owns is the SEAM rather than
 * the engine — when it writes, when it reads, and what it does when the device
 * cannot answer. Injected here rather than spied on from outside, because the
 * callers below hold a module-local binding that no namespace spy can reach.
 */
export function _useLocalDbClient(client, config = {}) {
  const { deviceSchema = null, ...rest } = config
  _config = { schemaUrl: '/x.json', wasmUrl: '/y.js', ...rest }
  _client = client
  _schema = deviceSchema
  _shapes.clear()
  _opening = null
  _closing = null
}
