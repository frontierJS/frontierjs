// operations.js — the row-keeping operations a migration is asked to carry.
//
// A schema diff is a name-set diff: `description` leaving a table and `brief`
// arriving is a drop plus an add, and the rebuild that follows copies the
// columns the two tables share, so the values go with the old name. Nothing in
// `schema.lite` can say otherwise without the schema carrying history it means
// nothing without on a fresh database (`FJS-D603`, option A, refused). The
// answer is stated at the one moment it is known, which is when the migration
// is CREATED, and it is written into the file as SQL.
//
// This module is the fixed set and the document that carries it. `migrate
// create` takes the same operations three ways — a flag, a prompt, and a
// document an author such as Oracle writes — and they all arrive here as the
// same entries:
//
//   { operations: [ { op: 'rename', model: 'Issue', from: 'description', to: 'brief' } ] }
//
// `backfill` and `split` join `OPERATIONS` as entries of their own; the
// document, the validation hook and the header line do not change shape.
//
// The collective noun is provisional (`FJS-D603` rules none). *Move* belongs to
// `@@transitions`, so it is not that.

import { modelToTableName, fieldToColumnName, isStoredField } from './ddl.js'
import { quoteIdent } from './query.js'

/** The operations this build can write, and what each one promises. */
export const OPERATIONS = {
  rename: 'a column keeps its values under a new name',
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The flag spelling: `--rename Issue.description=brief`. The model, the column
 * it had, and the field that holds its values now.
 *
 * @param {string} text
 * @returns {{ op: 'rename', model: string, from: string, to: string }}
 */
export function parseRenameFlag(text) {
  const m = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)=([A-Za-z_]\w*)$/.exec(String(text).trim())
  if (!m) throw new Error(`--rename takes Model.oldColumn=newField (for example Issue.description=brief), got '${text}'`)
  return { op: 'rename', model: m[1], from: m[2], to: m[3] }
}

/**
 * Read the document an author hands `migrate create`. Shape errors are refused
 * by position and name; what an entry MEANS against a schema is
 * `resolveOperations`'s.
 *
 * @param {unknown} doc
 * @returns {object[]}
 */
export function readOperations(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.operations))
    throw new Error('the operations document is { "operations": [ { "op": "rename", "model", "from", "to" } ] }')
  for (const [i, o] of doc.operations.entries()) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`operations[${i}] is not an object`)
    if (!OPERATIONS[o.op])
      throw new Error(`operations[${i}]: '${o.op}' is not an operation litestone writes. It writes: ${Object.keys(OPERATIONS).join(', ')}`)
  }
  return doc.operations
}

/**
 * Grade the operations against the schema being migrated to, for one database.
 *
 * A model that is not declared anywhere is an error; one declared in another
 * database is left for that database's pass, because `migrate create` runs once
 * per database and is handed the whole document each time.
 *
 * @returns {{ ok: true, ops: object[] } | { ok: false, message: string }}
 */
export function resolveOperations(parseResult, dbName, operations, { pluralize = false } = {}) {
  const models = parseResult.schema.models
  const ops = []
  const seen = new Set()
  const refuse = (message) => ({ ok: false, message })

  for (const [i, o] of (operations ?? []).entries()) {
    const at = `operations[${i}] (${o?.op ?? '?'} ${o?.model}.${o?.from} → ${o?.to})`
    if (!o || o.op !== 'rename') return refuse(`${at}: '${o?.op}' is not an operation litestone writes. It writes: ${Object.keys(OPERATIONS).join(', ')}`)
    for (const key of ['model', 'from', 'to'])
      if (typeof o[key] !== 'string' || !IDENT.test(o[key])) return refuse(`${at}: \`${key}\` is a name`)

    const model = models.find(m => m.name === o.model)
    if (!model) return refuse(`${at}: the schema declares no model ${o.model}. Its models are ${models.map(m => m.name).join(', ')}`)
    if (model.attributes?.some(a => a.kind === 'external')) return refuse(`${at}: ${o.model} is @@external, so no migration of its owns its columns`)
    const home = model.attributes?.find(a => a.kind === 'db')?.name ?? 'main'
    if (home !== dbName) continue

    const field = model.fields.find(f => f.name === o.to)
    if (!field || !isStoredField(field)) return refuse(`${at}: ${o.model} declares no stored field \`${o.to}\`, so nothing holds the values. Its fields are ${model.fields.filter(isStoredField).map(f => f.name).join(', ')}`)
    const toCol = fieldToColumnName(field)
    if (model.fields.some(f => isStoredField(f) && fieldToColumnName(f) === o.from))
      return refuse(`${at}: ${o.model} still declares \`${o.from}\`. A rename removes the old name from the schema; remove it, or this is a second column and not a rename`)
    if (o.from === toCol) return refuse(`${at}: the old and the new name are the same`)

    const table = modelToTableName(model, pluralize)
    for (const key of [`${table}.${o.from}`, `${table}.${toCol}`]) {
      if (seen.has(key)) return refuse(`${at}: ${key} is named by two operations`)
      seen.add(key)
    }
    ops.push({ op: 'rename', model: o.model, field: o.to, table, from: o.from, to: toCol })
  }
  return { ok: true, ops }
}

/**
 * Grade resolved operations against the migration HISTORY, the thing the
 * statements run on. The names are interpolated into SQL by `renameStatement`,
 * so what lets them in is that each one was read off a column that exists there
 * (Invariant 8).
 *
 * @returns {string|null} a refusal, or null
 */
export function checkAgainstHistory(ops, shadowSchema) {
  for (const o of ops) {
    const t = shadowSchema?.[o.table]
    const cols = new Set((t?.columns ?? []).map(c => c.name))
    const at = `${o.model}.${o.from} → ${o.to}`
    if (!t) return `${at}: the migration history builds no table ${o.table}, so there is nothing to rename in`
    if (!cols.has(o.from))
      return `${at}: the migration history has no column ${o.table}.${o.from}` +
             (cols.has(o.to) ? ` — but it already has ${o.to}, so the rename was made` : `. Its columns are ${[...cols].join(', ')}`)
    if (cols.has(o.to)) return `${at}: the migration history already has ${o.table}.${o.to}, which a rename would overwrite`
  }
  return null
}

/** One operation as the statement the file carries. */
export function renameStatement(o) {
  return `ALTER TABLE ${quoteIdent(o.table)} RENAME COLUMN ${quoteIdent(o.from)} TO ${quoteIdent(o.to)};`
}

/** The line a header and a summary say it with. */
export function describeOperation(o) {
  return `${o.op} ${o.model}.${o.from} → ${o.to}  (the values stay)`
}

/**
 * Pairs of a column that left and a column that arrived, of the same type and
 * the only such on that table. Far more often a rename than a coincidence, and
 * only ever a QUESTION: the guess changes a sentence or a prompt, never a file.
 *
 * @returns {{ model: string, table: string, from: string, to: string, field: string, type: string }[]}
 */
export function guessRenames(tableDiffs, parseResult, { pluralize = false } = {}) {
  const out = []
  for (const d of tableDiffs ?? []) {
    const dropped = d.cols?.dropped ?? []
    const added   = d.cols?.added ?? []
    const model   = parseResult.schema.models.find(m => modelToTableName(m, pluralize) === d.name)
    if (!model) continue
    for (const gone of dropped) {
      const sameKind = (c, side) => side.filter(x => x.type === c.type)
      const arrived = sameKind(gone, added)
      if (arrived.length !== 1 || sameKind(arrived[0], dropped).length !== 1) continue
      const field = model.fields.find(f => isStoredField(f) && fieldToColumnName(f) === arrived[0].name)
      if (!field) continue
      out.push({ model: model.name, table: d.name, from: gone.name, to: field.name, field: field.name, type: gone.type })
    }
  }
  return out
}

/**
 * Ask about each guess. `ask(question)` answers a string, so a terminal and a
 * test are the same code. Default is NO: a wrong yes carries one column's
 * values into another, silently, and a wrong no leaves the DESTRUCTIVE box that
 * stops apply.
 *
 * @returns {Promise<object[]>} the accepted guesses as rename operations
 */
export async function askRenames(guesses, ask) {
  const out = []
  for (const g of guesses) {
    const answer = String(await ask(`${g.model}.${g.from} is gone and ${g.to} (${g.type}) is new — is it the same column renamed? Its values stay. [y/N] `)).trim().toLowerCase()
    if (answer === 'y' || answer === 'yes') out.push({ op: 'rename', model: g.model, from: g.from, to: g.to })
  }
  return out
}
