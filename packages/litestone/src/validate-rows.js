// validate-rows.js — which stored rows would this schema refuse?
//
// A constraint is enforced twice here: once by SQLite, once at the client
// boundary. The SQLite half travels with the table, so changing it is a
// migration and the differ has to agree before a row exists that breaks it.
// The client half travels with the PROCESS — `@email`, `@length`, `@regex`,
// `@minItems`, an array's element type, and the shape of a `Json @type(T)` all
// emit no CHECK — so tightening one governs the next write and says nothing
// about the rows already down.
//
// Those rows do not become invalid loudly. They read back exactly as before,
// every snapshot and every migration reports in sync, and the first anyone
// hears of it is a caller editing an old row and being refused over a column
// they never sent. This walk is the only thing that asks.
//
// It is a READ and it changes nothing. What it answers is a report, and the
// caller decides: backfill the rows, or loosen the rule back.
//
// Never imported by production code — this is an ops surface, like release.js
// and access.js beside it.

import { validate } from './core/validate.js'
import { modelToAccessor } from './core/ddl.js'

// A driver with no migrations has no declared shape to hold a row to, so a
// finding against one would be about the schema rather than about the data.
const SKIP_DRIVERS = {
  jsonl:  'jsonl driver — no migrations and no schema to hold a row to',
  logger: 'logger driver — its rows are written by the audit trail, not by a caller',
}

// Every row failing is a different fact from some rows failing: a rule no row
// satisfies is a deploy that half-landed, and one a few rows break is data that
// drifted. The rollup says which, and it is ADDITIONAL — the rows are listed
// either way, because *fix the schema* and *fix these rows* are both answers
// somebody has to be able to act on, and a count with no row to look at is not
// actionable. No threshold: a model of one bad row is a model of one bad row,
// and inventing a floor here would be a judgment this file cannot make.
const ALL = (rows, failing) => rows > 0 && rows === failing

/**
 * Walk the stored rows and report the ones the schema would now refuse.
 *
 * @param {object} db         a litestone client
 * @param {object} [opts]
 * @param {string[]} [opts.models]  only these models (PascalCase names)
 * @param {number} [opts.limit]     stop after this many findings per model
 * @returns {Promise<{
 *   ok: boolean,
 *   checked: {model: string, rows: number, failing: number}[],
 *   findings: {model: string, id: unknown, errors: {path: string[], message: string}[]}[],
 *   models: {model: string, rows: number, failing: number, errors: object[]}[],
 *   skipped: {model: string, reason: string}[],
 * }>}
 */
export async function validateRows(db, { models = null, limit = 100 } = {}) {
  const schema = db.$schema
  const dbs    = db.$databases

  // The schema's own types and enums, rebuilt the way createClient builds them.
  // Read off `$schema` rather than reached for inside the client: this module
  // is an ops surface and must not depend on the shape of a ctx.
  const typeMap = new Map((schema.types ?? []).map(t => [t.name, t]))
  const enumMap = new Map((schema.enums ?? []).map(e => [e.name, e.values.map(v => v.name)]))

  // As SYSTEM, deliberately. A caller-scoped read of a gated model answers [],
  // which is the same shape as a model with nothing wrong — so the walk would
  // pass loudest on exactly the models whose rows are most protected.
  const sys = db.asSystem()

  const checked  = []
  const findings = []
  const modelRows = []
  const skipped  = []

  for (const model of schema.models) {
    if (models && !models.includes(model.name)) continue

    const driver = dbs[model.attributes.find(a => a.kind === 'db')?.name ?? 'main']?.driver
    if (SKIP_DRIVERS[driver]) {
      skipped.push({ model: model.name, reason: SKIP_DRIVERS[driver] })
      continue
    }

    const accessor = modelToAccessor(model.name)
    if (!sys[accessor]) continue

    // Soft-deleted and template rows are in: a restore and a
    // `withTemplates` update are both writes, and both would be refused.
    const rows = await sys[accessor].findMany({ withDeleted: true, withTemplates: true })

    // The id as the row reports it, so a finding is addressable. A model with a
    // tuple key has no single one and is named by its whole key.
    const key = db.$primaryKey(accessor)
    const idOf = row => Array.isArray(key)
      ? (key.length === 1 ? row[key[0]] : Object.fromEntries(key.map(k => [k, row[k]])))
      : row[key]

    const failures = []
    for (const row of rows) {
      try {
        validate(row, model, null, typeMap, enumMap)
      } catch (e) {
        // A ValidationError carries the per-field list; anything else is this
        // walk failing rather than the row, and is reported as one finding
        // saying so rather than swallowed.
        failures.push({
          model:  model.name,
          id:     idOf(row),
          errors: e.errors ?? [{ path: ['_row'], message: e.message }],
        })
      }
    }

    checked.push({ model: model.name, rows: rows.length, failing: failures.length })

    if (ALL(rows.length, failures.length)) {
      modelRows.push({
        model:   model.name,
        rows:    rows.length,
        failing: failures.length,
        // One row's errors stand for all of them — they are the same rule.
        errors:  failures[0].errors,
      })
    }
    // `limit` caps what is PRINTED, never what was counted: `checked` carries
    // the true number, or a capped report reads as a smaller problem.
    findings.push(...failures.slice(0, limit))
  }

  return {
    ok: findings.length === 0 && modelRows.length === 0,
    checked,
    findings,
    models: modelRows,
    skipped,
  }
}
