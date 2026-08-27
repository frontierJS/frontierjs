// retention.js — data retention helpers
//
// Handles two kinds of retention:
//   SQLite:  DELETE WHERE createdAt < cutoff   (runs on createClient startup)
//   JSONL:   compact file by filtering old/excess lines (runs on makeJsonlTable init)
//
// Both are driven by database block declarations in schema.lite:
//
//   database logs {
//     path      env("LOGS_PATH", "./logs.db")
//     retention 30d       ← time-based: delete rows older than 30 days
//   }
//
//   database activity {
//     path    env("ACTIVITY_PATH", "./activity.jsonl")
//     driver  jsonl
//     retention 90d
//     maxSize   500mb     ← size-based: trim oldest lines when file exceeds limit
//   }

import { existsSync, readFileSync, writeFileSync, rmSync, statSync, openSync, readSync, closeSync } from 'fs'
import { modelToTableName } from '../core/ddl.js'

// ─── Duration parser ──────────────────────────────────────────────────────────
// Accepts: 30d, 90d, 1y, 24h, 60m, 3600s
// Returns: milliseconds

const DURATION_UNITS = {
  ms: 1,
  s:  1_000,
  m:  60_000,
  h:  3_600_000,
  d:  86_400_000,
  w:  604_800_000,
  y:  31_536_000_000,
}

// `what` names the caller in the error, because this is the one duration parser
// and a test clock told it had an "invalid retention duration" is being told
// about a feature it is not using.
// A clock option is `() => Date | ISO string`, a bare `Date`, or absent. One
// reading, because both passes take it and a second interpretation is how the
// jsonl half ends up sweeping to a different instant than the SQLite half.
function nowMs(now) {
  const raw = typeof now === 'function' ? now() : now
  if (raw == null)            return Date.now()
  if (typeof raw === 'number') return raw
  const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime()
  return Number.isNaN(t) ? Date.now() : t
}

export function parseDuration(str, what = 'retention') {
  if (!str) return null
  const match = String(str).match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)$/)
  if (!match) throw new Error(`Invalid ${what} duration '${str}' — expected format: 30d, 24h, 1y, 60m`)
  return Number(match[1]) * (DURATION_UNITS[match[2]] ?? 0)
}

// ─── Size parser ──────────────────────────────────────────────────────────────
// Accepts: 500mb, 1gb, 100kb, 4096b
// Returns: bytes

const SIZE_UNITS = {
  b:  1,
  kb: 1_024,
  mb: 1_048_576,
  gb: 1_073_741_824,
}

export function parseSize(str) {
  if (!str) return null
  const match = String(str).match(/^(\d+(?:\.\d+)?)(b|kb|mb|gb)$/i)
  if (!match) throw new Error(`Invalid size '${str}' — expected format: 500mb, 1gb, 100kb`)
  return Number(match[1]) * (SIZE_UNITS[match[2].toLowerCase()] ?? 0)
}

// ─── SQLite retention ─────────────────────────────────────────────────────────
// Deletes rows older than the retention period from every model in the database
// that has a `createdAt DateTime` field.
//
// Safe to call at startup — silently skips tables that don't exist yet,
// and no-ops when nothing needs deleting.
//
// The cutoff is a ROLLING INSTANT: the duration back from the moment the pass
// runs, with `d` a flat 24 hours and `y` a flat 365 days. No calendar and no
// zone enter it, so *ninety days* is ninety times twenty-four hours from now and
// not a day boundary anywhere. Stated rather than fixed — a calendar-aligned
// window needs a zone, which the seed has no way to say yet (`FJS-D143`).
//
// @param rawWriteDb  raw Bun Database handle
// @param models      array of model AST nodes belonging to this database
// @param retention   duration string e.g. '30d', '90d', '1y'
// @param pluralize   the client's table-name rule — see below
// @returns [{ model, table, removed }] for every table it touched

export function runSqliteRetention(rawWriteDb, models, retention, pluralize = false, now = Date.now) {
  const ms = parseDuration(retention)
  if (!ms) return []

  // The client's clock, not the wall clock. A sweep is a CROSSING — a row aging
  // past a window — and staging one is the whole reason a test freezes a clock;
  // reading `Date.now()` here made `env.clock.advance('100d')` move nothing that
  // this pass could see.
  const cutoff = new Date(nowMs(now) - ms).toISOString()
  const swept  = []

  for (const model of models) {
    // Only models with a createdAt DateTime field
    const hasCreatedAt = model.fields.some(
      f => f.name === 'createdAt' && f.type.name === 'DateTime'
    )
    if (!hasCreatedAt) continue

    // The TABLE, not the model. `DELETE FROM "AuditEvent"` names nothing — the
    // table is `audit_event` — and the throw landed in a catch commented *table
    // may not exist yet*, so retention silently kept every row for every model
    // whose name is not a case-variant of its table: any multi-word name, and
    // every name at all under `pluralize` (`FJS-521`). `Log` survived only
    // because SQLite matches identifiers case-insensitively.
    const table = modelToTableName(model, pluralize)

    // Asked rather than inferred from a throw. A table that is not there yet is
    // the legitimate first-run case and must stay quiet; a DELETE that fails
    // against a table that IS there is a defect, and the two used to be one
    // silent branch.
    const exists = rawWriteDb
      .query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(table)
    if (!exists) continue

    try {
      rawWriteDb.prepare(
        `DELETE FROM "${table}" WHERE "createdAt" < ?`
      ).run(cutoff)
      // sqlite3_changes(), not bun's `.changes` — the latter counts what the
      // FTS and cascade triggers wrote too, so the line said 17 rows removed
      // for one (FJS-320).
      const removed = rawWriteDb.query('SELECT changes() AS n').get()?.n ?? 0
      swept.push({ model: model.name, table, removed })

      if (removed > 0) {
        console.log(
          `[litestone] retention: removed ${removed} row${removed === 1 ? '' : 's'}` +
          ` from "${table}" (older than ${retention})`
        )
      }
    } catch (err) {
      // A table that exists and will not sweep is worth saying out loud: the
      // whole point of the declaration is rows going away.
      console.warn(
        `[litestone] retention: could not sweep "${table}" — ${(err && err.message) || err}`
      )
      swept.push({ model: model.name, table, removed: 0, error: String((err && err.message) || err) })
    }
  }

  return swept
}

// ─── JSONL compaction ─────────────────────────────────────────────────────────
// Rewrites the JSONL file in-place, dropping lines that are:
//   - older than the retention period (by createdAt or first DateTime field)
//   - excess lines that would push the file over maxSize (oldest dropped first)
//
// After rewriting, deletes the companion index.db so it rebuilds correctly on
// the next write. Index offsets are invalidated by the file rewrite.
//
// @param filePath   absolute path to .jsonl file
// @param model      model AST node
// @param retention  duration string e.g. '30d' (optional)
// @param maxSize    size string e.g. '500mb' (optional)
// @returns          { removed, remaining, reason } or null if nothing to do

// Read just the first line of a file (bounded chunks, no full-file decode).
function readFirstLine(filePath) {
  const fd  = openSync(filePath, 'r')
  const buf = Buffer.allocUnsafe(8192)
  const chunks = []
  let pos = 0
  try {
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, pos)
      if (n === 0) break
      const nl = buf.indexOf(0x0a)
      const end = (nl >= 0 && nl < n) ? nl : n
      chunks.push(buf.slice(0, end).toString('utf8'))
      if (nl >= 0 && nl < n) break
      pos += n
    }
  } finally {
    closeSync(fd)
  }
  return chunks.join('').trim()
}

export function compactJsonl(filePath, model, retention, maxSize, now = Date.now) {
  if (!existsSync(filePath)) return null
  if (!retention && !maxSize) return null

  const ms       = retention ? parseDuration(retention) : null
  const maxBytes = maxSize   ? parseSize(maxSize)       : null
  const cutoff   = ms ? new Date(nowMs(now) - ms).toISOString() : null
  // Find the timestamp field — prefer createdAt, fall back to first DateTime
  const tsField  = ms
    ? (model.fields.find(f => f.name === 'createdAt' && f.type.name === 'DateTime')?.name ??
       model.fields.find(f => f.type.name === 'DateTime')?.name)
    : null

  // ── Cheap pre-checks — skip the full-file read on the common no-op path ────
  // This runs inside createClient() on EVERY startup; without these checks a
  // large log file was fully read + JSON.parsed every boot just to discover
  // nothing needed pruning.
  const st = statSync(filePath)
  if (st.size === 0) return null
  const sizeOk = !maxBytes || st.size <= maxBytes
  if (sizeOk) {
    let timeOk = !cutoff || !tsField
    if (!timeOk) {
      // Append-only files are oldest-first: if the FIRST line is fresh, all are.
      try {
        const ts = JSON.parse(readFirstLine(filePath))?.[tsField]
        timeOk = !ts || String(ts) >= cutoff
      } catch { /* malformed first line — fall through to the full pass */ }
    }
    if (timeOk) return null
  }

  const raw   = readFileSync(filePath, 'utf8')
  let   lines = raw.split('\n').filter(l => l.trim())

  if (lines.length === 0) return null

  const before = lines.length
  const reasons = []

  // ── Time-based compaction ──────────────────────────────────────────────────

  if (cutoff && tsField) {
    const before2 = lines.length
    lines = lines.filter(line => {
      try {
        const obj = JSON.parse(line)
        const ts  = obj[tsField]
        if (!ts) return true   // no timestamp — keep it
        return String(ts) >= cutoff
      } catch {
        return true            // malformed — keep rather than silently delete
      }
    })
    if (lines.length < before2) reasons.push(`time (${retention})`)
  }

  // ── Size-based compaction ──────────────────────────────────────────────────

  if (maxBytes) {
    // Measure byte size including newlines
    const totalBytes = lines.reduce((sum, l) => sum + Buffer.byteLength(l, 'utf8') + 1, 0)

    if (totalBytes > maxBytes) {
      // Single pass from the end: keep the largest suffix that fits.
      // (The previous lines.shift() loop was O(n²) array moves — it could
      // hang startup for minutes the first time a big file crossed the limit.)
      let keepBytes = 0
      let cut = lines.length
      for (let i = lines.length - 1; i >= 0; i--) {
        const b = Buffer.byteLength(lines[i], 'utf8') + 1
        if (keepBytes + b > maxBytes) break
        keepBytes += b
        cut = i
      }
      lines = lines.slice(cut)
      reasons.push(`size (${maxSize})`)
    }
  }

  const removed = before - lines.length
  if (removed === 0) return null   // nothing changed — no rewrite needed

  // ── Rewrite file ───────────────────────────────────────────────────────────

  const newContent = lines.length ? lines.join('\n') + '\n' : ''
  writeFileSync(filePath, newContent, 'utf8')

  // ── Invalidate companion index ─────────────────────────────────────────────
  // Byte offsets are wrong after the rewrite — safer to delete and rebuild lazily.
  // The index will be repopulated on the next createMany/create call.

  const indexPath = filePath + '.index.db'
  if (existsSync(indexPath)) {
    try { rmSync(indexPath) } catch {}
  }

  console.log(
    `[litestone] retention: compacted "${model.name}" — ` +
    `removed ${removed} line${removed === 1 ? '' : 's'} via ${reasons.join(' + ')} ` +
    `(${lines.length} remaining)`
  )

  return { removed, remaining: lines.length, reason: reasons.join(' + ') }
}
