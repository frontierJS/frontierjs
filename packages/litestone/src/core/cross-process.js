// ─── cross-process.js — a write announced past this process ──────────────────
//
// `$tapEvents` is a callback list on one client, so a second process announces
// nothing to the first — and `docs/concurrency.md` recommends running one. A
// worker's writes, or a second replica's, reached a serving process's
// subscribers never, silently and permanently (`FJS-642`). SQLite has no
// central server, so there is nothing to LISTEN to: `sqlite3_update_hook`, the
// pre-update hook and the sessions API are all in-process by construction.
//
// So an announcement is RECORDED, in a table in the same database, and every
// other process on this machine reads it. Declared per database —
// `database main { announce crossProcess }` — because it is a fact about the
// deployment and it costs a row per write.
//
// ── What travels, and what deliberately does not ─────────────────────────────
//
// The id, never the row. The in-process event carries the row it just wrote,
// and writing that into a side table would put the plaintext of every
// `@encrypted` and `@guarded` column into the database beside the ciphertext —
// undoing encryption at rest to save a read. The receiving process re-reads
// through its own client instead, which also makes the row the same SHAPE its
// own reads produce: plugin read hooks run, a `File` reference resolves to a
// URL, the field policies apply (`FJS-541` is what a differently-shaped read
// costs). A removal carries only the id, because there is nothing left to read.
//
// ── What this does NOT promise ───────────────────────────────────────────────
//
// **At-most-once across a crash.** The announcement is recorded after the
// write's own transaction has committed — `FJS-D170` holds announcements until
// COMMIT precisely because an announcement is a claim that a row is there — so
// a process that dies in the microseconds between the two loses that one
// announcement. The same trade `ctx.afterCommit` states in Junction, and the
// same reason: making it exactly-once means moving twelve write paths' announce
// inside their transaction, which is a different change with its own risk.
//
// **One machine.** Two processes sharing a FILE. A second machine shares no
// file and hears nothing, which is stated rather than approximated.

import { watch } from 'node:fs'
import { dirname } from 'node:path'

export const EVENTS_TABLE = '_litestone_events'

// How long a recorded announcement is kept. Long enough that a subscriber
// briefly behind catches up by reading rows; short enough that the table does
// not grow without bound. A subscriber further behind than this is told so —
// see `onGap` — rather than silently missing the rows that were swept.
export const DEFAULT_RETENTION_MS = 10 * 60 * 1000

// The backstop poll. `fs.watch` wakes in under a millisecond (measured) and is
// what makes this cheap; the poll is only ever catching what a watch could not
// see — an inotify limit, a filesystem that does not report, a platform that
// coalesces. Slow on purpose: it is a safety net, not the mechanism.
export const DEFAULT_POLL_MS = 2000

export function ensureEventsTable(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS "${EVENTS_TABLE}" (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      origin  TEXT    NOT NULL,
      event   TEXT    NOT NULL,
      model   TEXT    NOT NULL,
      scope   TEXT    NOT NULL,
      count   INTEGER NOT NULL DEFAULT 1,
      recordId TEXT,
      detail  TEXT,
      at      TEXT    NOT NULL
    )
  `)
  // AUTOINCREMENT so an id is never reused after a delete — the sweep removes
  // from the front, and a reused id would put a row BEHIND a cursor that has
  // already passed it, which is a subscriber silently missing a write.
  db.run(`CREATE INDEX IF NOT EXISTS "${EVENTS_TABLE}_at" ON "${EVENTS_TABLE}" (at)`)
}

/**
 * The writer. Prepared once per client and called on every announced write, so
 * it takes the statement rather than the database.
 */
export function makeEventRecorder(db, origin, now) {
  const stmt = db.prepare(
    `INSERT INTO "${EVENTS_TABLE}" (origin, event, model, scope, count, recordId, detail, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)

  return function record({ event, model, scope, count, recordId, detail }) {
    try {
      stmt.run(origin, event, model, scope ?? 'row', count ?? 1,
        recordId == null ? null : String(recordId),
        detail ? JSON.stringify(detail) : null,
        now().toISOString())
    } catch (err) {
      // An Observer may not fail the write that announced it (`FJS-D06`), and
      // this runs after that write has committed — throwing here would report a
      // write that succeeded as having failed.
      console.warn(`[litestone] could not record a cross-process announcement: ${err?.message ?? err}`)
    }
  }
}

/**
 * The reader. Wakes on a filesystem event, falls back to a slow poll, and hands
 * every row another process wrote to `onEvent`.
 *
 * `onGap` is called instead when the cursor has fallen behind retention — the
 * rows that would have said what changed are gone, so the only honest answer is
 * *something changed, re-read*. It is the one case that degrades to the coarse
 * signal, and it is reported rather than hidden.
 */
export function createEventWatcher({
  db, file, origin, onEvent, onGap,
  pollMs = DEFAULT_POLL_MS,
  retentionMs = DEFAULT_RETENTION_MS,
  now = () => new Date(),
  onError = (err) => console.warn(`[litestone] cross-process watcher: ${err?.message ?? err}`),
}) {
  // Start at the end: an app that has just opened has not missed anything, and
  // replaying the table's history would announce every write since the last
  // sweep to a browser that has just loaded the current rows.
  let cursor = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM "${EVENTS_TABLE}"`).get().id
  let stopped = false
  let draining = false
  let watcher = null
  let timer = null

  // Every row, this process's own included, and the loop below skips its own.
  // Filtering them out HERE and then advancing the cursor to MAX(id) to get
  // past them is the obvious version and it drops writes: a foreign row
  // committed between the SELECT and the MAX is behind the cursor and is never
  // delivered. It failed 6 runs in 8 and it is exactly the silent staleness
  // this whole layer exists to remove, so the cursor only ever moves over a row
  // that was actually looked at.
  const since   = db.prepare(
    `SELECT * FROM "${EVENTS_TABLE}" WHERE id > ? ORDER BY id ASC LIMIT 500`)
  const lowest  = db.prepare(`SELECT COALESCE(MIN(id), 0) AS id FROM "${EVENTS_TABLE}"`)
  const highest = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM "${EVENTS_TABLE}"`)
  const sweep   = db.prepare(`DELETE FROM "${EVENTS_TABLE}" WHERE at < ?`)

  let lastSweep = 0

  function drain() {
    if (stopped || draining) return
    draining = true
    try {
      // Has the sweep taken rows this subscriber had not read? MIN(id) climbing
      // past the cursor is the only evidence, since a swept row leaves nothing
      // behind — and the cursor is checked BEFORE reading, or a gap is reported
      // as the rows that happen to remain.
      const min = lowest.get().id
      if (cursor > 0 && min > cursor + 1) {
        cursor = highest.get().id
        onGap?.()
        return
      }

      for (;;) {
        const rows = since.all(cursor)
        if (!rows.length) break
        for (const row of rows) {
          cursor = row.id
          // Its own: already announced in-process the moment it was written.
          // Re-announcing would double every event and re-enter any subscriber
          // that writes.
          if (row.origin === origin) continue
          try { onEvent(decode(row)) } catch (err) { onError(err) }
        }
        if (rows.length < 500) break
      }

      const t = Date.now()
      if (t - lastSweep > retentionMs / 2) {
        lastSweep = t
        try { sweep.run(new Date(now().getTime() - retentionMs).toISOString()) } catch (err) { onError(err) }
      }
    } catch (err) {
      onError(err)
    } finally {
      draining = false
    }
  }

  // `data_version` is the cheap gate for the poll — 2.5 µs prepared, and it does
  // not move for this connection's own commits, so an app writing alone never
  // reads the table at all. It is FROZEN inside a read transaction, which is
  // why nothing here opens one.
  const dataVersion = db.prepare('PRAGMA data_version')
  let seenVersion = dataVersion.get().data_version

  function poll() {
    if (stopped) return
    let v
    try { v = dataVersion.get().data_version } catch (err) { onError(err); return }
    if (v === seenVersion) return
    seenVersion = v
    drain()
  }

  try {
    // The DIRECTORY rather than the file: in WAL the commits land in `-wal`, and
    // a watch on the database file alone sees nothing until a checkpoint.
    watcher = watch(dirname(file), () => { if (!stopped) drain() })
    watcher.unref?.()
  } catch (err) {
    // A platform or a filesystem that cannot watch is not a failure — the poll
    // is the whole mechanism there, and it is already running.
    onError(err)
  }

  timer = setInterval(poll, pollMs)
  timer.unref?.()

  return {
    stop() {
      stopped = true
      try { watcher?.close() } catch {}
      clearInterval(timer)
    },
    // For a test that must not wait for a timer or a filesystem.
    drain,
    get cursor() { return cursor },
  }
}

function decode(row) {
  return {
    event:    row.event,
    model:    row.model,
    scope:    row.scope,
    count:    row.count,
    recordId: row.recordId,
    detail:   row.detail ? JSON.parse(row.detail) : null,
    at:       row.at,
    origin:   row.origin,
  }
}
