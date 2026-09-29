// databases.js — the database a model's rows live in, opened, and the handles
// read through it.
//
// `buildDbRegistry` turns the schema's `database` blocks and the client's
// `databases`/`access`/`readOnly` options into one connection pair per
// file; `wrapDb` is the statement cache over each. `wideDb` and `mappedDb`
// are views over a handle — exact 64-bit integers for `@big`, and `@map`
// column names read back to field names.

import { openDatabase } from './engine.js'
import { applyWal, applyBusyTimeout, busyTimeoutFor } from './pragmas.js'
import { resolve, dirname, existsSync, mkdirSync, mkdtempSync, join, tmpdir, extname } from '#host'
import { noteMintedDirectory } from './db-path.js'
import { ClientClosedError } from './errors.js'

// ─── Statement cache ──────────────────────────────────────────────────────────
// Wraps a Database with a prepared statement cache.
// query() and prepare() compile once and reuse — zero recompilation on hot paths.
// run() stays uncached — used only for transactions/pragmas (called rarely).

function wrapDb(rawDb, { maxCacheSize = 500, label = 'sqlite' } = {}) {
  // Map preserves insertion order, so delete+set on hit moves an entry to "most
  // recently used", and the first key is always the oldest. When we hit the cap,
  // evict the oldest. 500 prepared stmts is a generous default — covers a
  // reasonably complex schema's full hot set without unbounded growth in
  // long-lived processes that build many distinct WHERE shapes.
  const cache = new Map()
  // Statements kept out of the cache. A SAVEPOINT, a RELEASE and a ROLLBACK TO
  // carry a name that counts up, so each is new text and would push the hot set
  // out; a PRAGMA can carry a value. BEGIN, COMMIT and ROLLBACK are fixed text
  // and are cached — every create in a transaction pays a prepare otherwise,
  // and a prepared one is reused across commits, rollbacks and a failed
  // statement without complaint (measured, `FJS-1106`).
  const NO_CACHE = /^\s*(SAVEPOINT|RELEASE|ROLLBACK\s+TO|PRAGMA|VACUUM|ATTACH|DETACH)/i
  let closed = false
  function stmt(sql) {
    if (closed) throw new ClientClosedError(label)
    let s = cache.get(sql)
    if (s) {
      // LRU: move to end on hit. Cheap — Map.delete + Map.set is O(1).
      cache.delete(sql)
      cache.set(sql, s)
      return s
    }
    s = rawDb.prepare(sql)
    cache.set(sql, s)
    if (cache.size > maxCacheSize) {
      // Evict oldest (first inserted)
      const oldest = cache.keys().next().value
      const evicted = cache.get(oldest)
      cache.delete(oldest)
      // Best-effort finalize — Bun stmts don't strictly require it, but it
      // releases native handles sooner and avoids GC pressure under churn.
      try { evicted?.finalize?.() } catch {}
    }
    return s
  }
  return {
    query(sql)          { return stmt(sql) },
    prepare(sql)        { return stmt(sql) },
    // The connection underneath, for the two things that are not SQL: loading
    // an extension, and anything else the C API owns. `wrapDb` is a statement
    // cache and every other caller wants only that, so this is deliberately not
    // a general escape — `rawHandle()` below is the one reader.
    $raw:               rawDb,
    // run() now caches UPDATE/DELETE/INSERT — only pragmas/transactions bypass
    run(sql, ...params) {
      if (closed) throw new ClientClosedError(label)
      if (NO_CACHE.test(sql)) return rawDb.prepare(sql).run(...params)
      return stmt(sql).run(...params)
    },
    // Finalizing every cached statement is what makes a close a close. bun's
    // `close()` is `sqlite3_close_v2`: it defers the real destruction until the
    // last statement is finalized, so closing a handle while this cache holds
    // 500 of them frees NO file descriptors and leaves a client that answers a
    // cached query and throws on a fresh one (`FJS-640`). Measured: a close
    // with one live statement freed 0 fds, and finalizing it freed 3.
    close() {
      closed = true
      for (const s of cache.values()) { try { s.finalize?.() } catch {} }
      cache.clear()
    },
    get closed()        { return closed },
    $raw: rawDb,
    get cacheSize()     { return cache.size },
  }
}

// ─── Wide integers ────────────────────────────────────────────────────────────
//
// `@big` says a column's values use the whole 64 bits. The storage always did;
// the CROSSING did not — bun answers a JS `number` on every path, so a value
// past 2^53 was read back as a different number with nothing raised, of a value
// the database was holding correctly (`FJS-643`).
//
// `safeIntegers` is the only way to see the exact value, and it is a property of
// a prepared STATEMENT and all-or-nothing: every integer that statement returns
// comes back a BigInt, `id` and a Boolean's 0/1 included. So the two halves are
// paired and neither is optional — the statement asks for BigInts, and the row
// read puts everything that is not wide back to a number. Over-asking is merely
// slower; under-asking is the silent corruption, which is why the decision is
// made once per model rather than per call site.
// The STATEMENT is the one owner, and it has to be. Asking for BigInts at the
// statement and putting them back in the row read was the obvious split, and it
// is an enumeration: `read`/`readAll` see rows, and a wide statement also
// answers counts, aggregates and existence probes that reach a caller without
// passing either — measured, `count()` on a wide model answered `0n`. So the
// statement narrows what it returns, and there is no list of places to keep in
// step.
function wideStmt(stmt, bigFields) {
  stmt.safeIntegers(true)
  return {
    get: (...a) => narrowRow(stmt.get(...a), bigFields),
    all: (...a) => { const rows = stmt.all(...a); for (const r of rows) narrowRow(r, bigFields); return rows },
    run: (...a) => stmt.run(...a),
  }
}

// One decision per model, covering every statement its ~30 read and RETURNING
// sites build. Only a model that declares a `@big` gets one, so a schema with
// none pays nothing at all — no wrapper, no `safeIntegers`, no per-row scan.
export function wideDb(db, bigFields) {
  // Unwrap first. A wide model's `makeTable` shadows its own `readDb`, and that
  // wrapper is then handed to the include resolver and the `@from` resolver,
  // which read a DIFFERENT model — so wrapping again would narrow the target's
  // rows against the parent's field set, turning the target's own wide column
  // into a rounded number. `$plain` is what makes the decision the target's.
  const base = db.$plain ?? db
  return {
    query:   (sql) => wideStmt(base.query(sql), bigFields),
    prepare: (sql) => wideStmt(base.prepare(sql), bigFields),
    run:     (sql, ...params) => base.run(sql, ...params),
    get $plain()    { return base },
    get $raw()      { return base.$raw },
    get closed()    { return base.closed },
    get cacheSize() { return base.cacheSize },
  }
}

// ─── @map, the read direction ────────────────────────────────────────────────
//
// The same shape as wideDb and for the same reason (`FJS-761`). A mapped model's
// rows come back keyed by COLUMN — `SELECT *` and `RETURNING *` most of all —
// and the caller's whole vocabulary is field names, so the keys have to be put
// back. Doing it at the statement rather than at the ~30 sites that see a row is
// what makes it complete: a count, an aggregate and an existence probe reach a
// caller without passing either row reader, and a missed rename is a key nobody
// looks at rather than an error.
//
// Only a model that maps something gets a wrapper, so a schema with no `@map`
// pays nothing — no wrapper, no per-row scan.
function unmapRow(row, back) {
  if (!row) return row
  for (const storage in back) {
    if (!(storage in row)) continue
    // A field whose column is another field's NAME would collide. The parser
    // refuses that pair, so the only way to arrive here is a hand-built row.
    row[back[storage]] = row[storage]
    delete row[storage]
  }
  return row
}

function mappedStmt(stmt, back) {
  return {
    get: (...a) => unmapRow(stmt.get(...a), back),
    all: (...a) => { const rows = stmt.all(...a); for (const r of rows) unmapRow(r, back); return rows },
    run: (...a) => stmt.run(...a),
  }
}

export function mappedDb(db, columnMap) {
  // Column → field, inverted once per model rather than per row.
  const back = {}
  for (const field in columnMap) back[columnMap[field]] = field
  // Wraps what it is GIVEN and does not unwrap, because a model can be both wide
  // and mapped and this runs second — taking `$plain` here would drop the wide
  // wrapper and round every `@big` column on a model that also renames one.
  // `$plain` still answers the bare handle, which is what the include and
  // `@from` resolvers read: they answer for a DIFFERENT model, and renaming
  // their rows against this map would rewrite a key that means something else
  // there.
  return {
    query:   (sql) => mappedStmt(db.query(sql), back),
    prepare: (sql) => mappedStmt(db.prepare(sql), back),
    run:     (sql, ...params) => db.run(sql, ...params),
    get $plain()    { return db.$plain ?? db },
    get $raw()      { return db.$raw },
    get closed()    { return db.closed },
    get cacheSize() { return db.cacheSize },
  }
}

// The plain handle behind a wide wrapper, for the resolvers that answer for a
// model of their own.
export const plainDb = (db) => db.$plain ?? db

// The `bun:sqlite` Database under however many wrappers are on it. `wideDb`,
// `mappedDb` and the read router each expose `$plain` pointing one layer in, so
// this walks down and then reads the statement cache's own handle. Bounded
// rather than `while (true)`, because a wrapper that pointed at itself would
// otherwise hang the read that asked.
export function rawHandle(db) {
  let cur = db
  for (let i = 0; i < 8 && cur; i++) {
    if (cur.$raw) return cur.$raw
    if (!cur.$plain || cur.$plain === cur) break
    cur = cur.$plain
  }
  return cur?.$raw ?? null
}

// Mutates — the object came straight from SQLite and is not shared. A wide
// column hands over DIGITS rather than a BigInt because `JSON.stringify` throws
// on one, which is every HTTP response, every WS frame and every `before`/
// `after` audit snapshot; node-postgres answers int8 the same way, for the same
// reason. Everything else goes back to a number: `safeIntegers` is all-or-
// nothing per statement, so `id`, a count and a Boolean's 0/1 arrive wide too,
// and a caller must not be able to tell that this model has a `@big` column in
// it from the type of a column that has not.
function narrowRow(row, bigFields) {
  if (!row) return row
  for (const k in row) {
    const v = row[k]
    if (typeof v !== 'bigint') continue
    // A key that is not a declared field is an alias — `_max__snowflake`, a
    // window's row number, a count. Rather than teach this an alias convention
    // it cannot verify, the fallback is the value itself: one that fits becomes
    // the number every caller expects, and one that does not becomes digits,
    // because a wrong number is the defect and an unexpected string is not.
    row[k] = bigFields.has(k) || v > MAX_SAFE || v < MIN_SAFE ? String(v) : Number(v)
  }
  return row
}
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE = -MAX_SAFE

// pathDef: { kind: 'literal', value } | { kind: 'env', var, default }
// override: optional string from createClient options.databases[name].path
function resolveDbPath(pathDef, override, anchor = null) {
  // An override comes from code — `createClient({ db })`, `databases: {…}` —
  // and code is written against the process, not against the schema file.
  if (override) return override === ':memory:' ? ':memory:' : resolve(override)

  const against = v => v === ':memory:' ? ':memory:'
                     : anchor            ? resolve(anchor, v)
                     : resolve(v)

  if (pathDef.kind === 'env') {
    const val = process.env[pathDef.var] ?? pathDef.default
    if (!val) throw new Error(`database path: env var '${pathDef.var}' is not set and has no default`)
    return against(val)
  }
  return against(pathDef.value)
}

// Open a SQLite database pair (write + read) with standard Litestone pragmas.
function openSqliteConnections(absPath, busyTimeout) {
  // SQLite can create a DB file but not its parent directory. If the configured
  // path points into a directory that doesn't exist yet, pre-create it so the
  // first `litestone repl`/`studio`/`createClient` call doesn't fail with a
  // cryptic SQLITE_CANTOPEN. Skip for :memory: and relative-to-nothing paths.
  if (absPath !== ':memory:') {
    try {
      const dir = dirname(absPath)
      if (dir && dir !== '.' && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
        noteMintedDirectory(dir, absPath)
      }
    } catch { /* fall through — let the Database() call surface the real error */ }
  }

  let rawWriteDb
  try {
    rawWriteDb = openDatabase(absPath)
  } catch (err) {
    if (err?.code === 'SQLITE_CANTOPEN') {
      const hint = absPath === ':memory:'
        ? ''
        : `\n  path: ${absPath}\n  Check that the parent directory exists and is writable.`
      const e = new Error(`unable to open SQLite database: ${err.message}${hint}`)
      e.code = err.code
      e.cause = err
      throw e
    }
    throw err
  }
  // The busy timeout goes FIRST, before any pragma that can contend for a
  // lock. `journal_mode = WAL` takes a brief exclusive lock and runs WAL
  // recovery, so two processes opening one file at the same moment race here —
  // and with the timeout applied after it the loser had nothing to wait on and
  // threw `SQLITE_BUSY_RECOVERY` out of `createClient`, before a line of the
  // app had run. Measured at 1 in 10 simultaneous boots (`FJS-655`).
  applyWal(rawWriteDb, busyTimeout)
  rawWriteDb.run('PRAGMA foreign_keys = ON')
  rawWriteDb.run('PRAGMA page_size = 8192')
  rawWriteDb.run('PRAGMA synchronous = NORMAL')
  rawWriteDb.run('PRAGMA cache_size = -32768')
  rawWriteDb.run('PRAGMA temp_store = MEMORY')
  rawWriteDb.run('PRAGMA mmap_size = 268435456')
  rawWriteDb.run('PRAGMA wal_autocheckpoint = 1000')

  // :memory: databases cannot be opened as a separate read-only connection —
  // reuse the write connection for reads instead.
  const isMemory = absPath === ':memory:'
  const rawReadDb = isMemory ? rawWriteDb : openDatabase(absPath, { readonly: true })
  if (!isMemory) {
    // Same order as the writer, and for the same reason: a reader does not
    // queue behind a writer in WAL, but it does during a checkpoint and on the
    // recovery a crashed writer leaves behind — which is exactly when the
    // timeout has to already be set.
    applyBusyTimeout(rawReadDb, busyTimeout)
    rawReadDb.run('PRAGMA foreign_keys = ON')
    rawReadDb.run('PRAGMA query_only = ON')
    rawReadDb.run('PRAGMA cache_size = -32768')
    rawReadDb.run('PRAGMA temp_store = MEMORY')
    rawReadDb.run('PRAGMA mmap_size = 268435456')
  }

  return {
    rawWriteDb,
    rawReadDb,
    writeDb: wrapDb(rawWriteDb, { label: `write ${absPath}` }),
    readDb:  wrapDb(rawReadDb,  { label: `read ${absPath}` }),
  }
}

// A stub db that throws clearly when accessed on a restricted database.
function makeThrowingDb(dbName, reason) {
  const msg = reason === false
    ? `Database '${dbName}' is not accessible in this client (access: false)`
    : `Database '${dbName}' is readonly in this client — write operations are not allowed`
  const stub = () => { throw new Error(msg) }
  return { query: stub, prepare: stub, run: stub, $raw: null, get cacheSize() { return 0 } }
}

// Merge readOnly shorthand into accessConfig.
// readOnly: true  →  every SQLite database in the schema gets access: 'readonly'
// Explicit accessConfig entries always win over readOnly shorthand.
export function resolveAccessConfig(accessConfig, readOnly, schema) {
  if (!readOnly) return accessConfig ?? {}
  const base = {}
  for (const db of schema.databases) {
    if (!db.driver || db.driver === 'sqlite') base[db.name] = 'readonly'
  }
  // 'main' covers single-db schemas that have no database blocks
  base.main = 'readonly'
  // Explicit accessConfig overrides the shorthand
  return { ...base, ...(accessConfig ?? {}) }
}

// Build the registry of live database connections from schema.databases + options.
// Returns: { dbName: { rawWriteDb, rawReadDb, writeDb, readDb, driver, access, absPath } }
//
// Rules:
//   - The unit is the FILE: two database blocks resolving to one path share one
//     connection pair
//   - 'main' must be declared in schema OR dbPath option provided; when both,
//     dbPath arrives as dbOverrides.main and overrides the declaration
//   - access: 'readwrite' (default) | 'readonly' | false (no connection)
//   - jsonl/logger driver: no SQLite connections — path stored only
//
// Two declarations can name one file. Under `strategy database` every sqlite
// database is redirected to the tenant's own file, and a literal path can also
// be repeated. SQLite allows one writer per file and the transaction manager
// takes a write lock on each connection — so a second connection to one file
// waits for a lock the caller itself is holding, answers
// `database is locked` and cannot ever get it (`FJS-958`). Reads succeed
// throughout, so the shape looks correct until something writes.
//
// ':memory:' is excluded from the grouping: every `openDatabase(':memory:')` is
// a database of its own, so those names really are separate files and sharing
// one handle would put two schemas' tables in it.
export function buildDbRegistry(schema, dbPath, dbOverrides, accessConfig, inMemory = false, anchor = null, busyTimeout = null) {
  const registry = {}

  const pathFor = db => resolveDbPath(db.path, dbOverrides[db.name]?.path, anchor)
  const isSqlite = db => !db.driver || db.driver === 'sqlite'

  // Which files anything writes to. Asked before the first open, because a
  // readonly block closes the write handle and a readwrite block on the same
  // file would then be served a closed one.
  const writable = new Set()
  for (const db of schema.databases) {
    if (!isSqlite(db) || (accessConfig[db.name] ?? 'readwrite') !== 'readwrite') continue
    const p = pathFor(db)
    if (p !== ':memory:') writable.add(p)
  }
  if (dbPath && !schema.databases.some(d => d.name === 'main') && (accessConfig.main ?? 'readwrite') === 'readwrite') {
    if (dbPath !== ':memory:') writable.add(resolve(dbPath))
  }

  // absPath → the connection pair already open on it.
  const opened = new Map()

  // A per-database `busyTimeout` cannot differ for one file, so the first
  // declaration to open it decides — schema order, and main is normally first.
  function connectionsFor(absPath, name, wantsWrite) {
    const shared = absPath === ':memory:' ? null : opened.get(absPath)
    if (shared) return shared
    const conns = openSqliteConnections(absPath, busyTimeoutFor(busyTimeout, name))
    if (!wantsWrite) {
      conns.rawWriteDb.close()
      conns.rawWriteDb = null
      conns.writeDb    = null
    }
    if (absPath !== ':memory:') opened.set(absPath, conns)
    return conns
  }

  for (const db of schema.databases) {
    const access  = accessConfig[db.name] ?? 'readwrite'
    const absPath = pathFor(db)

    if (db.driver === 'jsonl' || db.driver === 'logger') {
      // In-memory mode: use a unique tmpdir so test runs don't pollute the filesystem.
      // The dir is created immediately so the driver can write to it.
      let resolvedPath = absPath
      if (inMemory) {
        resolvedPath = mkdtempSync(join(tmpdir(), `litestone-${db.name}-`)) + '/'
      }
      registry[db.name] = { driver: db.driver, access, absPath: resolvedPath, retention: db.retention, maxSize: db.maxSize, logModel: db.logModel, busyTimeout: busyTimeoutFor(busyTimeout, db.name), rawWriteDb: null, rawReadDb: null, writeDb: null, readDb: null }
      continue
    }

    // `access: false` opens nothing of its own. Another block on the same file
    // may still open it — the refusal is this NAME's, not the file's.
    if (access === false) {
      registry[db.name] = { driver: 'sqlite', access: false, absPath, retention: null, logModel: db.logModel, rawWriteDb: null, rawReadDb: null, writeDb: makeThrowingDb(db.name, false), readDb: makeThrowingDb(db.name, false) }
      continue
    }

    const wantsWrite = absPath === ':memory:' ? access === 'readwrite' : writable.has(absPath)
    const conns = connectionsFor(absPath, db.name, wantsWrite)

    if (access === 'readonly') {
      registry[db.name] = { driver: 'sqlite', access: 'readonly', absPath, retention: db.retention, logModel: db.logModel, rawWriteDb: null, rawReadDb: conns.rawReadDb, writeDb: makeThrowingDb(db.name, 'readonly'), readDb: conns.readDb }
    } else {
      registry[db.name] = { driver: 'sqlite', access: 'readwrite', absPath, retention: db.retention, logModel: db.logModel, ...conns }
    }
  }

  // If no 'main' database block declared, use dbPath option as implicit main
  if (!registry.main) {
    if (!dbPath) throw new Error(`No 'database main' block in schema and no db path provided`)
    const access  = accessConfig.main ?? 'readwrite'
    const absPath = dbPath === ':memory:' ? ':memory:' : resolve(dbPath)
    if (access === false) {
      registry.main = { driver: 'sqlite', access: false, absPath, retention: null, rawWriteDb: null, rawReadDb: null, writeDb: makeThrowingDb('main', false), readDb: makeThrowingDb('main', false) }
    } else {
      const wantsWrite = absPath === ':memory:' ? access === 'readwrite' : writable.has(absPath)
      const conns = connectionsFor(absPath, 'main', wantsWrite)
      registry.main = access === 'readonly'
        ? { driver: 'sqlite', access: 'readonly', absPath, retention: null, rawWriteDb: null, rawReadDb: conns.rawReadDb, writeDb: makeThrowingDb('main', 'readonly'), readDb: conns.readDb }
        : { driver: 'sqlite', access: 'readwrite', absPath, retention: null, ...conns }
    }
  }

  return registry
}
// Build a map of model name → database name from @@db model attributes.
// Models without @@db fall through to 'main'.
export function buildModelDbMap(schema) {
  const map = {}
  for (const model of schema.models) {
    const dbAttr = model.attributes.find(a => a.kind === 'db')
    map[model.name] = dbAttr?.name ?? 'main'
  }
  return map
}

// Derive the physical file path for a JSONL model.
//
// Single-model convenience: if absPath ends in '.jsonl' it IS the file.
//   database logs { path "./requests.jsonl" }  →  one model, one file
//
// Multi-model (directory): if absPath has no .jsonl extension, treat it as
// a directory and place each model in its own file.
//   database audit { path "./audit/" }
//     model fieldReads  @@db(audit)  →  ./audit/fieldReads.jsonl
//     model requestLogs @@db(audit)  →  ./audit/requestLogs.jsonl
//
// The directory is created automatically on first use.
export function jsonlFilePath(absPath, modelName) {
  if (extname(absPath) === '.jsonl') {
    // Explicit single-file path — use it directly
    return absPath
  }
  // Directory mode — one file per model
  return join(absPath, `${modelName}.jsonl`)
}
