// @ts-check
// stamps.js — the values a write puts in a row that the caller's payload did
// not carry: generated defaults, the principal (`@createdBy`, `@updatedBy`,
// `@default(auth().x)`), and `@sequence` counters.

/** @import { DbHandle } from './databases.js' */

/** @typedef {Record<string, unknown>} Row */

/**
 * @param {Row | null | undefined} data
 * @param {{ field: string, generate: () => unknown }[] | null | undefined} entries
 * @param {Set<string> | null} [stamped]
 */
export function applyGeneratedDefaults(data, entries, stamped = null) {
  if (!entries?.length) return data
  let out = data
  for (const { field, generate } of entries) {
    if (out != null && field in out) continue
    stamped?.add(field)
    out = { ...(out ?? {}), [field]: generate() }
  }
  return out
}

// ─── ctx.auth → columns ───────────────────────────────────────────────────────
// The two ways a write picks up the principal, and the one place each lives.
// Both take a { field, authField }[] and return `data` untouched when there is
// nothing to do, so a model with neither allocates nothing.
//
// The distinction is the whole reason @createdBy is not @default(auth().id):
//
//   stampFromAuth     — the principal WINS. @createdBy / @updatedBy. A caller
//                       cannot forge authorship by putting the column in the payload.
//   applyAuthDefaults — the payload WINS. @default(auth().field), which is a
//                       default and documented as one.
//
// Neither fires without ctx.auth, which is what lets asSystem() seeders,
// imports and backfills carry an explicit author in.

// Every stamp below takes an optional `stamped` Set and records the columns it
// INJECTED — the ones the caller's payload did not carry. The @guarded and
// @system write refusals grade what the CALLER sent, and writeData sees the
// payload after the engine has added its own columns to it, so without this a
// guarded column with a generated default refused its own stamp and made the
// model uncreatable (FJS-565). Absence of the key is the test, not a null
// value: naming a guarded column and setting it to null is still naming it.
/**
 * @param {Set<string> | null | undefined} stamped
 * @param {Row | null | undefined} data
 * @param {string} field
 */
export function noteStamp(stamped, data, field) {
  if (stamped && !(data != null && field in data)) stamped.add(field)
}

/**
 * @param {Row | null | undefined} data
 * @param {{ field: string, authField: string }[] | null | undefined} list
 * @param {Row | null | undefined} auth
 * @param {Set<string> | null} [stamped]
 */
export function stampFromAuth(data, list, auth, stamped = null) {
  if (!list?.length || !auth) return data
  /** @type {Row} */
  const stamps = {}
  for (const { field, authField } of list)
    if (auth[authField] != null) { stamps[field] = auth[authField]; noteStamp(stamped, data, field) }
  return Object.keys(stamps).length ? { ...(data ?? {}), ...stamps } : data
}

// An explicit null beats a default (FJS-2032), so a data move can write a row
// whose author is gone; `fillsNull` is tenancy's claim column, where it cannot.
/**
 * @param {Row | null | undefined} data
 * @param {{ field: string, authField: string, fillsNull?: boolean }[] | null | undefined} list
 * @param {Row | null | undefined} auth
 * @param {Set<string> | null} [stamped]
 */
export function applyAuthDefaults(data, list, auth, stamped = null) {
  if (!list?.length || !auth) return data
  /** @type {Row} */
  const stamps = {}
  for (const { field, authField, fillsNull } of list) {
    const open = fillsNull ? data?.[field] == null : data?.[field] === undefined
    if (open && auth[authField] != null) { stamps[field] = auth[authField]; noteStamp(stamped, data, field) }
  }
  return Object.keys(stamps).length ? { ...(data ?? {}), ...stamps } : data
}

// ─── Sequence counter table ───────────────────────────────────────────────────
// Created once at client init. One row per (model, field, scope value).
// Uses a single atomic upsert — safe under SQLite's single-writer guarantee.

const SEQUENCE_TABLE = '_litestone_sequences'

/** @param {DbHandle} db */
export function ensureSequenceTable(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS "${SEQUENCE_TABLE}" (
      model   TEXT    NOT NULL,
      field   TEXT    NOT NULL,
      scope   TEXT    NOT NULL,
      lastNum INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (model, field, scope)
    )
  `)
}

/**
 * @param {DbHandle} db
 * @param {string} model
 * @param {string} field
 * @param {unknown} scopeValue
 */
function nextSequenceValue(db, model, field, scopeValue) {
  // Atomic increment — SQLite serializes all writes so this is race-free.
  // Single statement (upsert + RETURNING) instead of upsert-then-select.
  const row = db.query(
    `INSERT INTO "${SEQUENCE_TABLE}" (model, field, scope, lastNum)
     VALUES (?, ?, ?, 1)
     ON CONFLICT (model, field, scope)
     DO UPDATE SET lastNum = lastNum + 1
     RETURNING lastNum`
  ).get(model, field, String(scopeValue))
  return row.lastNum
}

// Apply @sequence fields to a single data row before INSERT.
// Only fires if the field is absent — explicit values are respected but still
// bump the counter so the sequence stays monotonic.
//
// `modelName` is the PascalCase schema name (e.g. "User") — used both to look up
// the sequences defined on that model AND as the key stored in _litestone_sequences.
// Keeping these consistent matters because the counter is scoped by (model, field, scope).
/**
 * @param {Row | null | undefined} data
 * @param {string} modelName
 * @param {{ field: string, scope: string }[]} seqs   the model's `@sequence` fields — `shape.sequences`
 * @param {DbHandle} writeDb
 * @param {Set<string> | null} [stamped]
 */
export function applySequences(data, modelName, seqs, writeDb, stamped = null) {
  if (!seqs.length || !data) return data
  let out = data
  for (const { field, scope } of seqs) {
    const scopeValue = out[scope]
    if (scopeValue == null) continue  // can't sequence without a scope value
    const explicitValue = out[field] != null ? Number(out[field]) : null
    if (explicitValue != null) {
      // Explicit value: sync the counter to max(current, explicit) so next auto continues from here
      writeDb.run(
        `INSERT INTO "${SEQUENCE_TABLE}" (model, field, scope, lastNum)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (model, field, scope)
         DO UPDATE SET lastNum = MAX(lastNum, excluded.lastNum)`,
        modelName, field, String(scopeValue), explicitValue
      )
    } else {
      // Auto: bump and use the new counter value
      const next = nextSequenceValue(writeDb, modelName, field, scopeValue)
      noteStamp(stamped, data, field)
      if (out === data) out = { ...data }
      out[field] = next
    }
  }
  return out
}
