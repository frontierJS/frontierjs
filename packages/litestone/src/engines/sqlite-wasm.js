// engines/sqlite-wasm.js — SQLite's own WASM build, over OPFS, as an engine.
//
// The second implementation of `core/engine.js`'s contract, and the one phase 4
// exists for (`IDEAS/homestead.md`, `FJS-D305`). It is not imported by anything:
// a host calls `createSqliteWasmEngine()` and registers what comes back, because
// the module and its 868 kB of wasm are exactly what a dynamic import is for.
//
// ─── Why this build and not wa-sqlite ─────────────────────────────────────
//
// The ruling named wa-sqlite. Its API is `async` on every path in BOTH builds —
// `sqlite3.step` is declared `async function`, because the shape is uniform
// across the asyncify and plain builds — and Litestone calls `.get()`/`.all()`
// from roughly 270 sites that do not await. SQLite's own build exposes the
// synchronous `oo1` API, so the client runs here as written.
//
// ─── Why a worker is not a choice ─────────────────────────────────────────
//
// OPFS's synchronous access handles exist only in a dedicated worker, which the
// package states itself: *only the worker versions allow you to use the origin
// private file system*. So there is no main-thread variant of this to fall back
// to — on the main thread the same build has no persistence at all. The worker
// is `src/browser/worker.js`; this file only assumes it is IN one.
//
// `opfs-sahpool` and not `opfs`: the pool pre-opens its access handles, so it
// needs neither `SharedAccessHandle` proxying nor the COOP/COEP headers the
// other VFS requires — which an app would have to set on every response, and
// which break embedding anything cross-origin.

const DEFAULT_VFS = 'fjs'

// The pool is a FIXED NUMBER of pre-opened file handles, not a quota. Each one
// can hold a database of any size; what the capacity limits is how many
// database FILES exist at once — and SQLite wants more than one per database:
// a journal, and a temp file for a large sort. Six is room for a main database,
// its journal, and a second database an app attaches, with headroom.
const DEFAULT_CAPACITY = 6

/**
 * Load the wasm, install the OPFS pool VFS, and answer an engine.
 *
 * @param {object}   opts
 * @param {Function} opts.load      `() => import('@sqlite.org/sqlite-wasm')`-shaped.
 *                                  Taken as an argument rather than imported so
 *                                  that WHERE the wasm comes from is the app's
 *                                  decision — a bundler, a CDN, a precached URL —
 *                                  and this file needs no bundler configuration
 *                                  to be readable on a server.
 * @param {string}  [opts.vfs]      VFS name. Two clients in one worker share it.
 * @param {number}  [opts.capacity] File handles to pre-open.
 */
export async function createSqliteWasmEngine({ load, vfs = DEFAULT_VFS, capacity = DEFAULT_CAPACITY } = {}) {
  if (typeof load !== 'function')
    throw new Error("createSqliteWasmEngine: pass load: () => import('@sqlite.org/sqlite-wasm')")

  const mod      = await load()
  const initModule = mod.default ?? mod.sqlite3InitModule
  if (typeof initModule !== 'function')
    throw new Error('createSqliteWasmEngine: load() did not answer a module with a default export')

  const sqlite3 = await initModule()

  if (!sqlite3.installOpfsSAHPoolVfs) throw new Error(
    '[Litestone] this SQLite build has no OPFS pool VFS.\n' +
    '  That is what a main-thread build looks like: OPFS sync access handles exist only in a\n' +
    '  dedicated worker, so a client built here would answer every read and persist nothing.')

  // An OPFS access handle is EXCLUSIVE to one holder in the whole origin, and
  // the pool opens `capacity` of them at install. So a second tab — or a worker
  // the page before this one left running — makes every one of those opens fail
  // with `NoModificationAllowedError`, which sqlite-wasm logs per handle and
  // then reports as `removeVfs() failed with no recovery strategy`: six lines
  // naming a cleanup path, none naming the holder. Caught here so the thing
  // that throws says who has it.
  let pool
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: vfs, initialCapacity: capacity })
  } catch (err) {
    if (err?.name !== 'NoModificationAllowedError') throw err
    throw new Error(
      `[Litestone] the OPFS pool '${vfs}' is held by something else in this origin.\n` +
      '  Its access handles are exclusive and there is exactly one holder: another tab with this\n' +
      '  app open, or a worker a previous page left alive. Close the other tab and reload.',
      { cause: err })
  }

  return {
    name: `sqlite-wasm/${vfs}`,
    sync: true,
    open(path, { readonly = false } = {}) {
      // ':memory:' is SQLite's own spelling and needs no pool handle. Litestone
      // uses it for every pristine schema it builds to diff against, so it is
      // reached during migration long before an app opens its own database.
      const db = path === ':memory:'
        ? new sqlite3.oo1.DB(':memory:', 'c')
        : new pool.OpfsSAHPoolDb(path.startsWith('/') ? path : '/' + path)

      // There is no second connection to open read-only against: the pool hands
      // out one handle per file and a second `OpfsSAHPoolDb` on one path is the
      // same file opened twice. `query_only` is the same guarantee from inside.
      if (readonly) db.exec('PRAGMA query_only = ON')

      return wrap(db)
    },
    // Not part of the contract — the host's own escape for `pool.wipeFiles()`
    // and friends, which is how a device discards a database it must not keep.
    $pool: pool,
  }
}

// ─── oo1 → the contract ───────────────────────────────────────────────────
//
// `oo1.Stmt` is a cursor, not a result: `step()` advances and `get()` reads the
// row it is on, and a statement left mid-iteration holds its read. So every
// method here resets before it returns, in a `finally` — a `get()` that found a
// row and did not reset leaves the statement busy, and the NEXT use of the same
// cached statement throws about a pending operation rather than about anything
// the caller did. `core/client.js` caches statements for the life of the
// connection, which is what makes that a certainty rather than a risk.

function wrap(db) {
  const prepare = (sql) => {
    const stmt = db.prepare(sql)
    return {
      get(...params) {
        try {
          bind(stmt, params)
          return stmt.step() ? stmt.get({}) : undefined
        } finally { stmt.reset() }
      },
      all(...params) {
        try {
          bind(stmt, params)
          const rows = []
          while (stmt.step()) rows.push(stmt.get({}))
          return rows
        } finally { stmt.reset() }
      },
      run(...params) {
        try {
          bind(stmt, params)
          while (stmt.step()) { /* a RETURNING clause still has rows to drain */ }
          return { changes: db.changes() }
        } finally { stmt.reset() }
      },
      finalize() { stmt.finalize() },
    }
  }

  return {
    prepare,
    query: prepare,
    run(sql, ...params) {
      // Not cached and not prepared: this path carries the pragmas and the
      // transaction control, and `db.exec` is the only thing that takes SQL
      // holding several statements — which `PRAGMA` setup does.
      if (!params.length) { db.exec(sql); return { changes: db.changes() } }
      return prepare(sql).run(...params)
    },
    close() { db.close() },
    // `sqlite3_js_db_export` is the whole file as bytes, which is what
    // `core/backup.js` means by serialize.
    serialize() { return db.checkpointStart ? null : sqlite3Export(db) },
  }
}

// oo1 binds a single value, an array or an object; Litestone always passes
// positional arguments, and passing an empty array binds nothing — which is
// different from binding an empty object, the one value SQLite reads as a bag
// of named parameters matching none of the statement's `?`.
function bind(stmt, params) {
  stmt.clearBindings()
  if (params.length) stmt.bind(params)
}

function sqlite3Export(db) {
  const api = db.constructor?.sqlite3 ?? globalThis.sqlite3
  return api?.capi?.sqlite3_js_db_export?.(db.pointer) ?? null
}
