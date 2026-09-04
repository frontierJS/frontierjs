// core/pragmas.js — the wait every SQLite connection owes a second writer.
//
// SQLite serialises writers with a file lock. A connection that finds the lock
// held either WAITS or fails immediately with `SQLITE_BUSY`, and which one it
// does is `busy_timeout` — zero by default, so *fails immediately* is what a
// connection gets unless somebody says otherwise.
//
// This existed on four connections and not on the other four (`FJS-569`), which
// made "does this database wait?" an accident of which file opened it. Measured
// with one connection holding the write lock: with the timeout the second waits
// 5007ms, without it the second fails in **1ms**. The gap was not theoretical —
// a second API process beside a running one died on its first audit write,
// because the `logger` index is the one database with no wait at all AND the one
// every tenant and every process shares.
//
// So the floor is one number in one place, applied by every site that opens a
// connection. The extras stay local: a write connection wants a page size and a
// checkpoint policy, a read connection wants `query_only`, and an index beside a
// JSONL file wants neither.
//
// ─── What this is NOT ─────────────────────────────────────────────────────
//
// **It is not a substitute for not contending.** `bun:sqlite` is synchronous, so
// a connection waiting on the lock blocks the thread it is on — in a single
// process that is the event loop, and a five-second wait is five seconds of a
// server answering nobody. Worse, it can deadlock outright: the waiter blocks
// the loop, so the holder's own continuation never runs to commit, so the wait
// can only ever expire. (Measured, and it is why `$transaction` takes a FIFO
// lock per client: two transactions on one client queue in JS and never reach
// this code.)
//
// What the timeout is genuinely for is **another process** — a second API, a
// job runner, `fli tinker`, a migration — where the holder makes progress
// independently and the waiter has something to wait FOR. There a 1.5s hold is
// waited out and the write commits.
//
// `docs/concurrency.md` is the whole of it, including what to do instead.
//
// ─── Where the number comes from ──────────────────────────────────────────
//
// **Option → env → default**, the same precedence `resolveTenancy` uses, and
// there is deliberately no fourth source: `database { }` in the seed is refused
// as a home for this (`FJS-D155`). How long to wait for another process is a
// fact about THIS process, and the same schema is opened by an API answering a
// person and by a queue draining a batch, which want opposite answers — a
// declaration is one answer to a question that differs by who is asking.
// Code is written against the process, exactly as a relative `database { path }`
// is resolved against it.

/** Milliseconds a connection waits for the write lock when nobody says otherwise.
 *
 * Long enough to cover an ordinary transaction from another process, short
 * enough that a genuinely stuck one is reported rather than hidden. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000

/** Process-wide override, for a caller that constructs no client — the CLI, a
 *  migration run against a live database, a queue worker started by a supervisor
 *  that can set an environment and cannot pass an option. */
export const BUSY_TIMEOUT_ENV = 'LITESTONE_BUSY_TIMEOUT'

const bad = (msg) => { const e = new Error(msg); e.name = 'BusyTimeoutError'; throw e }

function check(ms, where) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || !Number.isInteger(ms) || ms < 0)
    bad(`busyTimeout ${where} must be a whole number of milliseconds (0 or more), got ${JSON.stringify(ms)}`)
  return ms
}

/**
 * Read the env override, or `null` when it is unset.
 *
 * Refused rather than ignored when it is not a number: an unreadable value here
 * means every connection in the process silently takes the default, which is the
 * failure the variable was set to prevent.
 */
function fromEnv() {
  const raw = globalThis.process?.env?.[BUSY_TIMEOUT_ENV]
  if (raw == null || raw === '') return null
  const ms = Number(raw)
  if (!Number.isInteger(ms) || ms < 0)
    bad(`${BUSY_TIMEOUT_ENV} must be a whole number of milliseconds (0 or more), got ${JSON.stringify(raw)}`)
  return ms
}

/**
 * `busyTimeout` for one database → milliseconds.
 *
 * `stated` is whatever that connection's caller resolved (a number, or nothing).
 * A stated `0` is honored and means *fail immediately*, which is a real answer:
 * it is what a test asserting contention wants, and what a fire-and-forget write
 * that must never block the loop wants.
 */
export function resolveBusyTimeout(stated) {
  if (stated != null) return check(stated, 'option')
  return fromEnv() ?? DEFAULT_BUSY_TIMEOUT_MS
}

/**
 * Narrow a client's `busyTimeout` option to one database.
 *
 * Accepts a number (every connection) or an object keyed by database name with
 * an optional `default`. The object form exists for the database this issue was
 * filed about: an audit `logger` index is written fire-and-forget and its
 * failure is swallowed, so blocking the event loop for seconds to place a row
 * nobody is waiting for is the wrong trade — `{ default: 5000, audit: 250 }`
 * says so.
 */
export function busyTimeoutFor(config, dbName) {
  if (config == null || typeof config === 'number') return config
  return config[dbName] ?? config.default
}

/**
 * Refuse a malformed `busyTimeout` at `createClient` time rather than at the
 * connection that would have used it.
 *
 * `knownDbNames` makes a misspelled database name an error naming it. A dropped
 * key here is a database that silently keeps the default, which is exactly the
 * class of silence this whole issue is about.
 */
export function validateBusyTimeout(config, knownDbNames = []) {
  if (config == null) return config
  if (typeof config === 'number') return check(config, 'option')
  if (typeof config !== 'object' || Array.isArray(config))
    bad(`busyTimeout must be a number of milliseconds or an object keyed by database name, got ${JSON.stringify(config)}`)

  const known = new Set([...knownDbNames, 'main', 'default'])
  for (const [key, ms] of Object.entries(config)) {
    if (!known.has(key))
      bad(`busyTimeout names database '${key}', which this schema does not declare. Known: ${[...known].sort().join(', ')}`)
    check(ms, `for '${key}'`)
  }
  return config
}

/**
 * Apply the wait. Every `new Database(...)` in this package calls this.
 *
 * Takes the raw handle rather than a wrapper, because the sites that need it
 * most are the ones that never build a wrapper — the JSONL companion index, the
 * tenant registry, a migration handle opened for one statement. `timeout` is
 * omitted by the callers that hold no option (the CLI), which is what makes the
 * environment variable reach them.
 */
export function applyBusyTimeout(db, timeout) {
  db.run(`PRAGMA busy_timeout = ${resolveBusyTimeout(timeout)}`)
}
