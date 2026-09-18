// core/engine.js — what a SQL engine is, stated once.
//
// Nine files under `src/` opened a database, and each one of them imported
// `bun:sqlite` and wrote `new Database(path)`. That is nine answers to *what
// runs the SQL*, and they agreed only because there was one candidate. The
// moment there is a second — a browser reading its own rows with no server
// (`IDEAS/homestead.md` phase 4, `FJS-D305`) — nine answers is nine places to
// change and eight places to forget.
//
// So the engine is a value, `openDatabase()` is the only way to get a
// connection, and `src/engines/` holds the implementations. `bun:sqlite` is
// named in exactly one file, which is a fact a test asserts rather than a
// convention a reader is asked to keep.
//
// ─── The contract is SYNCHRONOUS, and that is the whole decision ──────────
//
// `db.user.findMany()` has always been `async`, so the PUBLIC surface could
// carry an engine that answers promises. The internals could not: `.get()` and
// `.all()` are called from roughly 270 sites inside `core/client.js` alone,
// none of which await, and every one of them would answer a pending Promise
// that reads as an object and is never a row. Nothing would throw. A filter
// would simply stop filtering.
//
// This is not hypothetical and it is what decided the browser engine.
// `wa-sqlite`'s API is `async` on every path — `sqlite3.step` is declared
// `async function` in both the plain and the asyncify build, because the shape
// is uniform across them — so a seam that accepted it would be a seam nothing
// could satisfy without rewriting the query engine. SQLite's own build exposes
// a synchronous `oo1` API over the `opfs-sahpool` VFS, which is the one that
// fits here (`FJS-D305` § note).
//
// An engine therefore declares `sync: true` and one that does not is refused
// BY NAME at registration, which is the cheapest moment to find out. A refusal
// that arrives at open time would already be past the point where the app
// could do anything else.
//
// ─── The surface an engine owes ───────────────────────────────────────────
//
// Smaller than the call-site count suggests, because `wrapDb()` in client.js
// is the statement cache every read goes through and it uses five methods.
//
//   engine.open(path, { readonly })  →  Db
//
//   Db.prepare(sql)      →  Stmt      compile, no cache of its own
//   Db.query(sql)        →  Stmt      the same thing; both spellings are in use
//   Db.run(sql, ...args) →  { changes }
//   Db.close()
//   Db.serialize()       →  Uint8Array   backup only, and optional
//
//   Stmt.get(...args)    →  row | undefined | null
//   Stmt.all(...args)    →  row[]
//   Stmt.run(...args)    →  { changes }
//   Stmt.finalize()      optional — see wrapDb's close, `FJS-640`
//   Stmt.safeIntegers(b) optional — `@big`, see wideStmt
//
// `path` is a filesystem path or `':memory:'`. An engine with no filesystem
// reads it as an opaque name for a database, which is what OPFS does with it.
//
// A failure to open must carry `code: 'SQLITE_CANTOPEN'`, because client.js
// turns exactly that one into the message naming the parent directory.

// ─── Which engine is here ─────────────────────────────────────────────────
//
// `#sql-engine` is a subpath import in this package's own `package.json`, and
// it resolves by CONDITION: `bun:sqlite` on a server, `engines/none.js` under
// the `browser` condition. A bundler therefore never follows an import into a
// runtime builtin it cannot resolve, and no entry point has to remember a
// side-effect line — which is the version of this that breaks, because the
// entry point somebody adds next is the one that forgets.
import defaultEngine from '#sql-engine'

// The registered engine. There is one, because a client holding connections
// from two engines would be one transaction manager over two implementations
// of what a transaction is.
let current = null

const REQUIRED = ['open']

// ─── Registration ─────────────────────────────────────────────────────────

// An engine is `{ name, sync, open }`. `name` is what a refusal quotes, so it
// is required — an engine that will not say what it is cannot be reported.
export function setEngine(engine) {
  if (!engine || typeof engine !== 'object')
    throw new Error('setEngine: expected an engine object — { name, sync, open }')
  if (typeof engine.name !== 'string' || !engine.name)
    throw new Error('setEngine: an engine must name itself')
  for (const m of REQUIRED)
    if (typeof engine[m] !== 'function')
      throw new Error(`setEngine: engine '${engine.name}' has no ${m}()`)
  if (engine.sync !== true)
    throw new Error(
      `setEngine: engine '${engine.name}' does not declare sync: true.\n` +
      "  Litestone's query internals call .get() and .all() without awaiting, so an engine\n" +
      '  that answers promises returns a pending Promise where a row belongs and nothing\n' +
      '  throws. Run an asynchronous engine in a worker and expose a synchronous handle.')
  current = engine
  return engine
}

export function currentEngine() {
  return current
}

// Named apart from `setEngine(null)` so that *no engine* is a state something
// asked for, rather than an argument that slipped through.
export function clearEngine() {
  current = null
}

// ─── Opening ──────────────────────────────────────────────────────────────

if (defaultEngine) setEngine(defaultEngine)

export function openDatabase(path, options = {}) {
  if (!current)
    throw new Error(
      'no SQL engine is registered.\n' +
      "  Litestone's own entry points register one; a host that imports a module directly\n" +
      "  registers it with setEngine() from '@frontierjs/litestone/engine'.")
  return current.open(path, options)
}
