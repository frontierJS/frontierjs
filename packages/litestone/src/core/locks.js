// locks.js — `$lock`: the one advisory-lock primitive every flavor of the client
// shares. Lives beside the connection, not inside access, so `asSystem()` does
// not bypass it.

import { processId } from '#host'
import { suggestKey } from './args.js'
import { LockNotAcquiredError, LockReleasedByOtherError, LockExpiredError } from './errors.js'

// ─── Lock primitive ───────────────────────────────────────────────────────────
//
// Application-level named locks backed by a _locks table in the main SQLite db.
// Table is auto-created on first use — no migration, no schema declaration.
//
// Storage: main db only. Locks are ephemeral — rows exist while held, deleted
// on release. Table stays tiny (rows = concurrent holders, never accumulates).
//
// Acquire uses INSERT OR IGNORE (atomic in SQLite) — no gap between check and
// write. Expired locks are cleaned up before each acquire attempt.
//
// Usage:
//   await db.$lock('key', async () => { ... })
//   const lock = await db.$locks.acquire('key', { ttl: 60_000 })
//   try { ... } finally { await lock.release() }
//
// Default TTL: 30s. Use heartbeat() for long-running operations.
//
// One primitive for every flavor of the client. A lock is a fact about the
// connection rather than an access check, so `asSystem()` does not bypass it:
// a system caller that asks for a lock is asking for exclusion, and a no-op
// there landed 10 of 10 concurrent writers on one range (`FJS-1216`).

// A key acquire() does not read is refused rather than dropped. A dropped wait
// budget is `wait = 0`, which turns a queue into try-once and surfaces as an
// ordinary 409 with `retryable: true` — contention, to anyone reading it
// (FJS-1217). The index.d.ts typed `timeout` while this read `wait`.
const LOCK_OPTIONS = ['ttl', 'wait', 'retryEvery', 'owner']

const LOCK_OPTION_ANSWERS = {
  timeout: 'is not an option — `wait` is the milliseconds to keep retrying before refusing, and `ttl` is how long the lock lives once held',
}

export function assertLockOptions(rest) {
  const unknown = Object.keys(rest)
  if (!unknown.length) return
  const lines = unknown.map(k => {
    if (LOCK_OPTION_ANSWERS[k]) return `  ${k} ${LOCK_OPTION_ANSWERS[k]}`
    const near = suggestKey(k, LOCK_OPTIONS)
    return `  ${k}${near ? ` — did you mean \`${near}\`?` : ''}`
  })
  throw new Error(
    `$lock(): unknown option${unknown.length > 1 ? 's' : ''}\n\n` +
    `${lines.join('\n')}\n\n` +
    `  Options: ${LOCK_OPTIONS.join(', ')}`
  )
}

export function makeLockPrimitive(rawWriteDb) {
  const LOCKS_TABLE = '_locks'
  let _ensured = false

  function ensureTable() {
    if (_ensured) return
    rawWriteDb.run(`CREATE TABLE IF NOT EXISTS "${LOCKS_TABLE}" (
      "key"          TEXT    PRIMARY KEY,
      "owner"        TEXT    NOT NULL,
      "acquired_at"  INTEGER NOT NULL,
      "expires_at"   INTEGER NOT NULL,
      "heartbeat_at" INTEGER NOT NULL
    ) STRICT`)
    _ensured = true
  }

  function defaultOwner() {
    return `pid-${processId()}-${Math.random().toString(36).slice(2, 8)}`
  }

  // ── Low-level acquire ────────────────────────────────────────────────────
  // Returns true if acquired, false if lock is held by another owner.
  // Cleans up expired locks before attempting.

  function tryAcquireOnce(key, owner, ttl) {
    const now       = Date.now()
    const expiresAt = now + ttl

    // Clean up any expired lock for this key before attempting
    rawWriteDb.run(
      `DELETE FROM "${LOCKS_TABLE}" WHERE "key" = ? AND "expires_at" < ?`,
      key, now
    )

    const result = rawWriteDb.run(
      `INSERT OR IGNORE INTO "${LOCKS_TABLE}" ("key","owner","acquired_at","expires_at","heartbeat_at") VALUES (?,?,?,?,?)`,
      key, owner, now, expiresAt, now
    )
    return result.changes === 1
  }

  function getCurrentHolder(key) {
    return rawWriteDb.prepare(
      `SELECT "owner", "expires_at" FROM "${LOCKS_TABLE}" WHERE "key" = ?`
    ).get(key)
  }

  // ── $locks API ────────────────────────────────────────────────────────────

  async function acquire(key, opts = {}) {
    ensureTable()
    const {
      ttl        = 30_000,
      wait       = 0,
      retryEvery = 100,
      owner      = defaultOwner(),
      ...rest
    } = opts
    assertLockOptions(rest)

    const deadline = Date.now() + wait

    while (true) {
      const acquired = tryAcquireOnce(key, owner, ttl)
      if (acquired) {
        return {
          key,
          owner,
          acquiredAt: new Date(),
          expiresAt:  new Date(Date.now() + ttl),
          async release() {
            const existing = rawWriteDb.prepare(
              `SELECT "owner", "expires_at" FROM "${LOCKS_TABLE}" WHERE "key" = ?`
            ).get(key)
            if (!existing) return   // already gone — idempotent
            if (existing.expires_at < Date.now()) throw new LockExpiredError(key, owner)
            if (existing.owner !== owner) throw new LockReleasedByOtherError(key, owner)
            rawWriteDb.run(`DELETE FROM "${LOCKS_TABLE}" WHERE "key" = ? AND "owner" = ?`, key, owner)
          },
          async heartbeat() {
            rawWriteDb.run(
              `UPDATE "${LOCKS_TABLE}" SET "expires_at" = ?, "heartbeat_at" = ? WHERE "key" = ? AND "owner" = ?`,
              Date.now() + ttl, Date.now(), key, owner
            )
          },
        }
      }

      // Lock held — check wait budget
      if (Date.now() >= deadline) {
        const holder = getCurrentHolder(key)
        throw new LockNotAcquiredError(key, holder?.owner, holder ? new Date(holder.expires_at) : null)
      }

      // Wait and retry
      await new Promise(r => setTimeout(r, retryEvery))
    }
  }

  async function release(key, owner) {
    ensureTable()
    if (owner) {
      rawWriteDb.run(`DELETE FROM "${LOCKS_TABLE}" WHERE "key" = ? AND "owner" = ?`, key, owner)
    } else {
      rawWriteDb.run(`DELETE FROM "${LOCKS_TABLE}" WHERE "key" = ?`, key)
    }
    // Idempotent — no error if already released
  }

  async function heartbeat(key, owner, ttl = 30_000) {
    ensureTable()
    rawWriteDb.run(
      `UPDATE "${LOCKS_TABLE}" SET "expires_at" = ?, "heartbeat_at" = ? WHERE "key" = ? AND "owner" = ?`,
      Date.now() + ttl, Date.now(), key, owner
    )
  }

  function isHeld(key) {
    ensureTable()
    const row = rawWriteDb.prepare(
      `SELECT "expires_at" FROM "${LOCKS_TABLE}" WHERE "key" = ?`
    ).get(key)
    if (!row) return false
    return row.expires_at > Date.now()
  }

  function list() {
    ensureTable()
    const now  = Date.now()
    const rows = rawWriteDb.prepare(
      `SELECT * FROM "${LOCKS_TABLE}" WHERE "expires_at" > ? ORDER BY "acquired_at" ASC`
    ).all(now)
    return rows.map(r => ({
      key:         r.key,
      owner:       r.owner,
      acquiredAt:  new Date(r.acquired_at),
      expiresAt:   new Date(r.expires_at),
      heartbeatAt: new Date(r.heartbeat_at),
    }))
  }

  // ── $lock(key, fn, opts) — main convenience API ──────────────────────────

  async function $lock(key, fn, opts = {}) {
    const lock = await acquire(key, opts)
    try {
      return await fn()
    } finally {
      await lock.release().catch(() => {})   // always release, swallow expired errors
    }
  }

  $lock.acquire   = acquire
  $lock.release   = release
  $lock.heartbeat = heartbeat
  $lock.isHeld    = isHeld
  $lock.list      = list

  // Expose $locks as an alias namespace
  $lock.$locks = { acquire, release, heartbeat, isHeld, list }

  return $lock
}
