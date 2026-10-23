// trail-entries.js — the trail's record of a completed verb: which fields
// and models this table logs, the entry each verb emits, and the redaction
// that keeps a protected value out of the trail (root `CLAUDE.md` § 7). The
// log configuration is read once per table, so an unlogged table pays one
// boolean on its hot path.
//
// Built once per table by `makeTable`, which hands it the transaction manager,
// the id field and the select parser, and takes back the emitters.

import { GATE_LIFT, liftsGate } from '../plugins/gate.js'
import { opaqueMark } from './encryption.js'
import { REDACTED } from '@frontierjs/toolbelt/redact'
import { isProtected } from './schema-maps.js'
import { trailModelName, buildLogEntry, trailRowValues, fireLog } from './audit-log.js'

export function makeTrailEntries(shape, ctx, deps) {
  const { modelName, fieldPolicy } = shape
  const { tx, idField, parseArgs } = deps

  // ── Logging helpers ───────────────────────────────────────────────────────
  //
  // All log configuration is pre-computed once at makeTable() time.
  // Tables with no @trail / @@trail get tableHasLogWork = false — the hot path
  // (findMany, create, update, remove, delete) checks this single boolean and
  // exits immediately with zero allocation cost.
  //
  // Design:
  //   tableFieldLogs  — Map<fieldName, [{db, reads, writes}]> for THIS table only
  //   tableModelLogs  — [{db, reads, writes}] for THIS table only, or null
  //   tableHasLogWork  — pre-computed boolean: skip all log work if false
  //   tableNeedsModel — pre-computed: does any @@trail declaration exist for this table
  //   tableNeedsField — pre-computed: does any @trail declaration exist for this table

  // Both keyed by THIS model in `shapeFor`, by model name: keyed by table name
  // they matched only while the two spellings agreed, and under PascalCase
  // every field-level @trail recorded nothing and said nothing.
  const tableFieldLogs   = shape.fieldLogs
  const tableModelLogs   = shape.modelLogs
  // An @@anonymous table has no log (the parser refuses one) and still takes
  // this path, because its writes are what a logged write in the same
  // transaction is refused against (`FJS-D349`).
  const tableAnonymous   = shape.model.attributes.some(a => a.kind === 'anonymous')
  const tableLogsWrites  = !!tableModelLogs?.some(l => l.writes) || [...tableFieldLogs.values()].some(cs => cs.some(c => c.writes))
  const tableHasLogWork  = tableFieldLogs.size > 0 || (tableModelLogs?.length > 0) || tableAnonymous
  const tableNeedsField  = tableFieldLogs.size > 0
  const tableNeedsModel  = tableModelLogs?.length > 0

  // Pre-resolve log tables at startup so getLogTable() is O(1) on hot paths.
  // Map<dbName, logTable>
  const _logTableCache = new Map()
  function getLogTable(dbName) {
    if (_logTableCache.has(dbName)) return _logTableCache.get(dbName)
    const dbEntry = ctx.trailDbMap?.[dbName]
    // A SQL trail is an ordinary table and is written through a SYSTEM context:
    // the row is the engine's record of what happened, not something the
    // calling principal is asking to insert, so it must not be graded by the
    // trail model's own `@@gate` — which is exactly the gate an app puts there
    // to make the trail append-only and readable by staff alone.
    const table   = !dbEntry ? null
      : dbEntry.kind === 'sql'
        ? (ctx.sqlLogTableFor?.(dbEntry.trailModel) ?? null)
        : (ctx.jsonlTableCache?.[dbEntry.trailModel ?? trailModelName(dbName)] ?? null)
    // Only cache hits — a null result may mean jsonlTableCache wasn't ready yet
    // (timing: initial makeAllTables runs before ctx.jsonlTableCache is assigned).
    if (table) _logTableCache.set(dbName, table)
    return table
  }

  // Extract record ids from an array of rows using this table's @id field.
  function extractIds(rows) {
    if (!rows?.length) return []
    return rows.map(r => r[idField]).filter(id => id != null)
  }

  // A logged read whose `select` leaves out the id still has to name its rows:
  // the entry was written with actor and clock and `records: []`, a trail with
  // a hole a reviewer cannot see (FJS-1422). So the STATEMENT selects the id,
  // and `finalize` with the caller's own parse strips it again. `distinct`
  // keeps the caller's select, since an id would make every row distinct.
  function logReadParse(select, include, ps, distinct, windowNames = null) {
    if (!tableHasLogWork || tableAnonymous || !select || select[idField] || distinct === true) return ps
    return parseArgs({ ...select, [idField]: true }, include, windowNames)
  }

  // Emit a log entry fire-and-forget to a trail database.
  function emitLog(dbName, entry) {
    const table = getLogTable(dbName)
    if (!table) return
    const built = buildLogEntry(entry, ctx, ctx.onLog)
    fireLog(table, trailRowValues(built), ctx._logStats)
  }

  // ── Audit redaction ─────────────────────────────────────────────────────
  // A protected field's VALUE must never reach a log entry. The audit trail
  // exists to record THAT a field was written — by whom, to which rows, when —
  // not what it holds. Logging the plaintext would defeat the @encrypted it
  // sits next to: the database row is ciphertext while the JSONL beside it is
  // not, and the log file has none of the column's read protections.
  //
  // This matters most for @secret, which expands to
  // @encrypted + @guarded + @trail(<first trail db>) — so declaring a
  // trail database is on its own enough to start logging every @secret field.
  // Redaction is what makes that expansion safe.
  //
  // null is preserved rather than redacted: it holds nothing to leak, and
  // keeping it means a null → value transition is still visible in the trail.
  //
  // A @hashed digest is redacted too: it is the value every read path refuses
  // to hand back, and a stable keyed identifier, so a digest in a 409 lets a
  // caller ask whose value matches whose (FJS-1250).
  //
  // A @personal value is not a secret, and a reader of the row may see it, but
  // the trail outlives the row: an erased person's email would otherwise stay
  // in every snapshot for the trail's whole retention (FJS-D657). It logs as
  // `[personal]` so the entry still says which kind of value was dropped. A
  // column that is both protected and personal logs as `[redacted]`.
  //
  // An @opaque value is stored sealed by a client, so the trail writes a digest
  // of the stored bytes and not the bytes (FJS-D1158): an edit's entry still
  // says WHICH sealed column moved. A mark that is a function takes the value.
  const logMarks = new Map()
  for (const [f, p] of Object.entries(fieldPolicy)) {
    if (isProtected(p))   logMarks.set(f, REDACTED)
    else if (p.personal)  logMarks.set(f, '[personal]')
    else if (p.opaque)    logMarks.set(f, opaqueMark)
  }
  const markOf = (mark, value) => (typeof mark === 'function' ? mark(value) : mark)
  const hasProtectedLogFields = logMarks.size > 0

  // Field-level entries: the entry IS about this field, so it stays — only the
  // value is replaced.
  function redactValue(field, value) {
    if (value == null) return null
    return markOf(logMarks.get(field) ?? value, value)
  }

  // Model-level entries: before/after are whole rows. Copy on write — these
  // objects are the rows handed back to the caller and must not be mutated.
  function redactSnapshot(row) {
    if (!row || !hasProtectedLogFields || typeof row !== 'object') return row
    let out = null
    for (const [f, mark] of logMarks) {
      if (row[f] == null) continue
      if (!out) out = { ...row }
      out[f] = markOf(mark, row[f])
    }
    return out ?? row
  }

  // The trail's image of a row a write read back. That row is shaped for the
  // CALLER, whose read strips a protected column, so a scoped caller's
  // `system: ['apiKey']` write logged null to null and an image without the
  // column (FJS-2297). Where the stored row holds a value the caller's row
  // lacks, the image carries its mark — never the value.
  function trailImage(raw, shaped) {
    if (!raw || !shaped || !hasProtectedLogFields) return shaped
    let out = null
    for (const [f, mark] of logMarks) {
      if (raw[f] == null || f in shaped) continue
      if (!out) out = { ...shaped }
      out[f] = markOf(mark, raw[f])
    }
    return out ?? shaped
  }

  // Emit field-level and model-level log entries for a completed operation.
  // Called once per operation — extracts ids once, shared by both helpers.
  // operation: 'read' | 'write' | 'create' | 'update' | 'delete'
  function emitLogs(operation, rows, { before: beforeMap, after: afterMap, transition = null, ids: readIds = null, system = null, written = null } = {}) {
    const lifted = liftsGate(system) ? [GATE_LIFT] : null
    if (!tableHasLogWork) return          // ← fast exit for unlogged tables
    if (operation !== 'read' && (tableAnonymous || tableLogsWrites) && tx.owns()) {
      const other = tx.noteWrite(modelName, tableAnonymous)
      if (other) {
        const [anon, logged] = tableAnonymous ? [modelName, other] : [other, modelName]
        throw new Error(
          `${modelName}: refused a write in a transaction that also wrote ${other}. ${anon} is @@anonymous and ` +
          `${logged} is logged, and the trail's clock in order re-attributes every ${anon} row. ` +
          `Drop the log on ${logged} — writing the two in separate transactions leaves the same join and only escapes this check (FJS-D349)`)
      }
    }
    if (tableAnonymous) return
    const ids = readIds ?? extractIds(rows)         // extract once, shared below

    // ── Field-level logs ──────────────────────────────────────────────────
    if (tableNeedsField) {
      const isReadOp  = operation === 'read'
      const isWriteOp = !isReadOp   // create, update, delete are all writes
      for (const [field, configs] of tableFieldLogs) {
        for (const { db, reads, writes } of configs) {
          if (isReadOp  && !reads)  continue
          if (isWriteOp && !writes) continue

          // A write of the ROW is a write of this field only where the data
          // named it: otherwise creating an account with no password logs
          // `create · account · saPassword`, and so does an update of its time
          // zone (FJS-2048). The returned row can't say, since read() strips a
          // guarded or hashed field; `written` is the data as it was bound.
          // A path with no `written` logs the field as it always did. One
          // entry per row (upsertMany, createMany) narrows the records to the
          // rows that named it.
          let records = ids
          if (written && (operation === 'create' || operation === 'update')) {
            const names = operation === 'create'
              ? d => d?.[field] != null
              : d => field in d || Object.keys(d).some(k => k.startsWith(`${field}.`))
            const given = written.flatMap((d, i) => names(d) ? [i] : [])
            if (!given.length) continue
            if (given.length < written.length && rows.length === written.length) records = extractIds(given.map(i => rows[i]))
          }

          emitLog(db, {
            operation,
            model:   modelName,
            field,
            transition,
            records,
            before:  beforeMap ? redactValue(field, beforeMap[field] ?? null) : null,
            after:   afterMap  ? redactValue(field, afterMap[field]  ?? null) : null,
            lifted,
          })
        }
      }
    }

    // ── Model-level logs ──────────────────────────────────────────────────
    if (tableNeedsModel) {
      for (const { db, reads, writes } of tableModelLogs) {
        const isWrite = operation === 'create' || operation === 'update' || operation === 'delete'
        if (operation === 'read' && !reads)  continue
        if (isWrite              && !writes) continue

        emitLog(db, {
          operation,
          model:   modelName,
          field:   null,
          transition,
          records: ids,
          before:  beforeMap ? redactSnapshot(beforeMap) : null,
          after:   afterMap  ? redactSnapshot(afterMap)  : null,
          lifted,
        })
      }
    }
  }

  return { tableHasLogWork, extractIds, logReadParse, redactValue, trailImage, emitLogs }
}
