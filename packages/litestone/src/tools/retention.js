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

import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs'

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

export function parseDuration(str) {
  if (!str) return null
  const match = String(str).match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)$/)
  if (!match) throw new Error(`Invalid retention duration '${str}' — expected format: 30d, 24h, 1y, 60m`)
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
// @param rawWriteDb  raw Bun Database handle
// @param models      array of model AST nodes belonging to this database
// @param retention   duration string e.g. '30d', '90d', '1y'

export function runSqliteRetention(rawWriteDb, models, retention) {
  const ms = parseDuration(retention)
  if (!ms) return

  const cutoff = new Date(Date.now() - ms).toISOString()

  for (const model of models) {
    // Only models with a createdAt DateTime field
    const hasCreatedAt = model.fields.some(
      f => f.name === 'createdAt' && f.type.name === 'DateTime'
    )
    if (!hasCreatedAt) continue

    try {
      const result = rawWriteDb.prepare(
        `DELETE FROM "${model.name}" WHERE "createdAt" < ?`
      ).run(cutoff)

      if (result.changes > 0) {
        console.log(
          `[litestone] retention: removed ${result.changes} row${result.changes === 1 ? '' : 's'}` +
          ` from "${model.name}" (older than ${retention})`
        )
      }
    } catch {
      // Table may not exist yet on first run — silent skip
    }
  }
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

export function compactJsonl(filePath, model, retention, maxSize) {
  if (!existsSync(filePath)) return null
  if (!retention && !maxSize) return null

  const raw   = readFileSync(filePath, 'utf8')
  let   lines = raw.split('\n').filter(l => l.trim())

  if (lines.length === 0) return null

  const before = lines.length
  const reasons = []

  // ── Time-based compaction ──────────────────────────────────────────────────

  if (retention) {
    const ms = parseDuration(retention)
    if (ms) {
      const cutoff = new Date(Date.now() - ms).toISOString()

      // Find the timestamp field — prefer createdAt, fall back to first DateTime
      const tsField =
        model.fields.find(f => f.name === 'createdAt' && f.type.name === 'DateTime')?.name ??
        model.fields.find(f => f.type.name === 'DateTime')?.name

      if (tsField) {
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
    }
  }

  // ── Size-based compaction ──────────────────────────────────────────────────

  if (maxSize) {
    const maxBytes = parseSize(maxSize)
    if (maxBytes) {
      // Measure byte size including newlines
      let totalBytes = lines.reduce((sum, l) => sum + Buffer.byteLength(l, 'utf8') + 1, 0)

      if (totalBytes > maxBytes) {
        while (lines.length > 0 && totalBytes > maxBytes) {
          const removed = lines.shift()
          totalBytes -= Buffer.byteLength(removed, 'utf8') + 1
        }
        reasons.push(`size (${maxSize})`)
      }
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
