// @ts-check
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
// `backfill` gives a column this migration adds a value for the rows already
// there. Without one, a rebuild's copy names only the columns the old table
// shares, so a new NOT NULL column has nothing to take and the file is written
// BLOCKED (`FJS-D428`). Its source is a constant, the first row of a parent, or
// one parent row the file creates:
//
//   { op: 'backfill', model: 'Job', field: 'priority', value: 'normal' }
//   { op: 'backfill', model: 'Job', field: 'companyId', first: 'Company' }
//   { op: 'backfill', model: 'Job', field: 'companyId', create: { Company: { name: 'Imported' } } }
//
// `split` copies a column the schema drops into one row per source in a model
// the same file creates, before the rebuild drops it (`FJS-D2313`):
//
//   { op: 'split', model: 'Page', column: 'body', into: 'Block', field: 'body', link: 'pageId' }
//
// The collective noun is provisional (`FJS-D603` rules none). *Move* belongs to
// `@@transitions`, so it is not that.

import { modelToTableName, fieldToColumnName, isStoredField, isSoftDelete, columnDefaultExpr } from './ddl.js'
import { quoteIdent } from './query.js'

/**
 * The operations this build can write, and what each one promises.
 *
 * @type {Record<string, string>}
 */
export const OPERATIONS = {
  rename:   'a column keeps its values under a new name',
  backfill: 'a column this migration adds takes a value for the rows already there',
  split:    'a column the schema drops is copied into one row per source in a model this migration adds',
}

// The names each entry must carry, which reach SQL only after they are read off
// the schema or the history (Invariant 8).
/** @type {Record<string, string[]>} */
const NAMES = {
  rename:   ['model', 'from', 'to'],
  backfill: ['model', 'field'],
  split:    ['model', 'column', 'into', 'field', 'link'],
}

/** @param {any} o */
const label = (o) =>
  o?.op === 'backfill' ? `backfill ${o?.model}.${o?.field}`
  : o?.op === 'split'  ? `split ${o?.model}.${o?.column} → ${o?.into}.${o?.field}`
  : `${o?.op ?? '?'} ${o?.model}.${o?.from} → ${o?.to}`

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
 * @param {any} doc
 * @returns {object[]}
 */
export function readOperations(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.operations))
    throw new Error('the operations document is { "operations": [ { "op": "rename", "model", "from", "to" }, { "op": "backfill", "model", "field", "value" or "first" or "create" } or { "op": "split", "model", "column", "into", "field", "link" } ] }')
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
 * @param {any} parseResult
 * @param {string} dbName
 * @param {any[] | null | undefined} operations
 * @param {{ pluralize?: boolean }} [opts]
 * @returns {{ ok: true, ops: object[] } | { ok: false, message: string }}
 */
export function resolveOperations(parseResult, dbName, operations, { pluralize = false } = {}) {
  const models = parseResult.schema.models
  const ops = []
  const seen = new Set()
  /** @type {(message: string) => { ok: false, message: string }} */
  const refuse = (message) => ({ ok: false, message })

  for (const [i, o] of (operations ?? []).entries()) {
    const at = `operations[${i}] (${label(o)})`
    if (!o || !Object.hasOwn(OPERATIONS, o.op)) return refuse(`${at}: '${o?.op}' is not an operation litestone writes. It writes: ${Object.keys(OPERATIONS).join(', ')}`)
    for (const key of NAMES[o.op])
      if (typeof o[key] !== 'string' || !IDENT.test(o[key])) return refuse(`${at}: \`${key}\` is a name`)

    const model = models.find((/** @type {any} */ m) => m.name === o.model)
    if (!model) return refuse(`${at}: the schema declares no model ${o.model}. Its models are ${models.map((/** @type {any} */ m) => m.name).join(', ')}`)
    if (model.attributes?.some((/** @type {any} */ a) => a.kind === 'external')) return refuse(`${at}: ${o.model} is @@external, so no migration of its owns its columns`)
    const home = model.attributes?.find((/** @type {any} */ a) => a.kind === 'db')?.name ?? 'main'
    if (home !== dbName) continue

    if (o.op === 'backfill' || o.op === 'split') {
      const b = o.op === 'backfill'
        ? resolveBackfill(o, model, models, home, at, pluralize)
        : resolveSplit(o, model, models, home, at, pluralize)
      if (typeof b === 'string') return refuse(b)
      const key = o.op === 'backfill' ? `${b.table}.${b.column}` : `${b.intoTable}.${b.toColumn}`
      if (seen.has(key)) return refuse(`${at}: ${key} is named by two operations`)
      seen.add(key)
      if (b.insert) {
        if (seen.has(`create ${b.parentTable}`)) return refuse(`${at}: two backfills each create a ${b.first} row, and the read takes the newest, so both would link to the second; create it once and link the other with \`first\` when ${b.first} had no rows`)
        seen.add(`create ${b.parentTable}`)
      }
      ops.push(b)
      continue
    }

    const field = model.fields.find((/** @type {any} */ f) => f.name === o.to)
    if (!field || !isStoredField(field)) return refuse(`${at}: ${o.model} declares no stored field \`${o.to}\`, so nothing holds the values. Its fields are ${model.fields.filter(isStoredField).map((/** @type {any} */ f) => f.name).join(', ')}`)
    const toCol = fieldToColumnName(field)
    if (model.fields.some((/** @type {any} */ f) => isStoredField(f) && fieldToColumnName(f) === o.from))
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

// A string is quoted with its quotes doubled; nothing else a caller hands in
// reaches the file as SQL text.
/** @param {any} v */
function sqlLiteral(v) {
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'boolean') return v ? '1' : '0'
  return null
}

/**
 * One backfill entry against the schema: the column it fills and the source,
 * or a refusal.
 *
 * @param {any} o
 * @param {any} model
 * @param {any[]} models
 * @param {string} home
 * @param {string} at
 * @param {boolean} pluralize
 * @returns {any} the resolved entry, or a refusal string
 */
function resolveBackfill(o, model, models, home, at, pluralize) {
  const field = model.fields.find((/** @type {any} */ f) => f.name === o.field)
  if (!field || !isStoredField(field))
    return `${at}: ${o.model} declares no stored field \`${o.field}\` to fill. Its fields are ${model.fields.filter(isStoredField).map((/** @type {any} */ f) => f.name).join(', ')}`
  if (field.attributes?.some((/** @type {any} */ a) => a.kind === 'generated' || a.kind === 'funcCall'))
    return `${at}: ${o.model}.${o.field} is computed, so nothing fills it`
  const sources = ['value', 'first', 'create'].filter(k => Object.hasOwn(o, k))
  if (sources.length !== 1)
    return `${at}: a backfill states one source — \`value\` (a constant), \`first\` (the model whose first row every existing row takes) or \`create\` (one new parent row every existing row links to)`
  const base = { op: 'backfill', model: o.model, field: o.field, table: modelToTableName(model, pluralize), column: fieldToColumnName(field) }

  if (sources[0] === 'value') {
    const literal = sqlLiteral(o.value)
    if (literal === null) return `${at}: \`value\` is a string, a finite number or a boolean, got ${JSON.stringify(o.value)}`
    return { ...base, value: o.value, literal }
  }

  const created = sources[0] === 'create'
  if (created && (!o.create || typeof o.create !== 'object' || Array.isArray(o.create) || Object.keys(o.create).length !== 1))
    return `${at}: \`create\` names one model and the row it gets, { Company: { name: 'Imported' } }`
  const parentName = created ? Object.keys(o.create)[0] : o.first
  if (typeof parentName !== 'string' || !IDENT.test(parentName)) return `${at}: \`first\` is the name of the model whose first row the existing rows take`
  const parent = models.find((/** @type {any} */ m) => m.name === parentName)
  if (!parent) return `${at}: the schema declares no model ${parentName}. Its models are ${models.map((/** @type {any} */ m) => m.name).join(', ')}`
  const parentHome = parent.attributes?.find((/** @type {any} */ a) => a.kind === 'db')?.name ?? 'main'
  if (parentHome !== home) return `${at}: ${parentName} lives in database ${parentHome} and ${o.model} in ${home}, so one statement cannot read both`
  const link = model.fields.find((/** @type {any} */ f) => f.type?.kind === 'relation' &&
    f.attributes?.some((/** @type {any} */ a) => a.kind === 'relation' && a.fields?.includes(o.field)))
  if (link && link.type.name !== parentName) return `${at}: ${o.model}.${o.field} links to ${link.type.name}, not ${parentName}`
  const rel = link?.attributes.find((/** @type {any} */ a) => a.kind === 'relation')
  const keyName = rel?.references?.[rel.fields.indexOf(o.field)]
    ?? parent.fields.find((/** @type {any} */ f) => f.attributes?.some((/** @type {any} */ a) => a.kind === 'id'))?.name
  const key = parent.fields.find((/** @type {any} */ f) => f.name === keyName)
  if (!key) return `${at}: ${parentName} has no @id field for the rows to take`
  // A trashed parent is still a row, and every existing row would link to it.
  const trashed = isSoftDelete(parent) ? parent.fields.find((/** @type {any} */ f) => f.name === 'deletedAt') : null
  const live = trashed ? ` WHERE ${quoteIdent(fieldToColumnName(trashed))} IS NULL` : ''
  const resolved = { ...base, first: parentName, parentTable: modelToTableName(parent, pluralize), parentKey: fieldToColumnName(key), live }
  if (!created) return resolved

  const values = o.create[parentName]
  if (!values || typeof values !== 'object' || Array.isArray(values)) return `${at}: \`create.${parentName}\` is the row, { field: value }`
  const columns = [], literals = []
  for (const [name, v] of Object.entries(values)) {
    const f = parent.fields.find((/** @type {any} */ x) => x.name === name)
    if (!f || !isStoredField(f)) return `${at}: ${parentName} declares no stored field \`${name}\`. Its fields are ${parent.fields.filter(isStoredField).map((/** @type {any} */ x) => x.name).join(', ')}`
    const literal = sqlLiteral(v)
    if (literal === null) return `${at}: \`create.${parentName}.${name}\` is a string, a finite number or a boolean, got ${JSON.stringify(v)}`
    columns.push(fieldToColumnName(f)); literals.push(literal)
  }
  const unfilled = needsValue(parent, Object.keys(values))
  if (unfilled) return `${at}: ${parentName}.${unfilled} is required and has no SQL default, so the row needs it in \`create.${parentName}\``
  return { ...resolved, insert: { columns, literals } }
}

// The first required stored field an INSERT naming only `given` leaves without a
// value, or null. A default the client stamps (`cuid()`, `auth()`) is no value
// to a statement in a file (`columnDefaultExpr`); an integer @id is the rowid.
/** @param {any} model @param {string[]} given */
function needsValue(model, given) {
  for (const f of model.fields.filter(isStoredField)) {
    if (given.includes(f.name) || f.type?.optional) continue
    if (f.attributes?.some((/** @type {any} */ a) => a.kind === 'generated' || a.kind === 'funcCall')) continue
    if (columnDefaultExpr(f) != null) continue
    if (f.type?.name === 'Int' && f.attributes?.some((/** @type {any} */ a) => a.kind === 'id')) continue
    return f.name
  }
  return null
}

/**
 * One split entry against the schema: the model it copies into, the link back
 * to the source and the key that link holds, or a refusal.
 *
 * @param {any} o
 * @param {any} model the source
 * @param {any[]} models
 * @param {string} home
 * @param {string} at
 * @param {boolean} pluralize
 * @returns {any} the resolved entry, or a refusal string
 */
function resolveSplit(o, model, models, home, at, pluralize) {
  const into = models.find((/** @type {any} */ m) => m.name === o.into)
  if (!into) return `${at}: the schema declares no model ${o.into}. Its models are ${models.map((/** @type {any} */ m) => m.name).join(', ')}`
  const intoHome = into.attributes?.find((/** @type {any} */ a) => a.kind === 'db')?.name ?? 'main'
  if (intoHome !== home) return `${at}: ${o.into} lives in database ${intoHome} and ${o.model} in ${home}, so one statement cannot read both`
  const stored = into.fields.filter(isStoredField)
  const field = stored.find((/** @type {any} */ f) => f.name === o.field)
  if (!field) return `${at}: ${o.into} declares no stored field \`${o.field}\` to copy into. Its fields are ${stored.map((/** @type {any} */ f) => f.name).join(', ')}`
  const link = into.fields.find((/** @type {any} */ f) => f.type?.kind === 'relation' && f.type.name === o.model &&
    f.attributes?.some((/** @type {any} */ a) => a.kind === 'relation' && a.fields?.length === 1 && a.fields[0] === o.link))
  if (!link) return `${at}: ${o.into}.${o.link} is not the key of a link to ${o.model}, so a copied row could not say which ${o.model} it came from`
  const rel = link.attributes.find((/** @type {any} */ a) => a.kind === 'relation')
  const key = model.fields.find((/** @type {any} */ f) => f.name === rel.references?.[0])
  if (!key) return `${at}: ${o.model} has no field ${rel.references?.[0]} for ${o.into}.${o.link} to hold`
  const linkField = stored.find((/** @type {any} */ f) => f.name === o.link)
  const unfilled = needsValue(into, [o.field, o.link])
  if (unfilled) return `${at}: ${o.into}.${unfilled} is required and has no SQL default, so a copied row has no value for it`
  return {
    op: 'split', model: o.model, column: o.column, into: o.into, field: o.field, link: o.link,
    table: modelToTableName(model, pluralize), sourceKey: fieldToColumnName(key),
    intoTable: modelToTableName(into, pluralize), toColumn: fieldToColumnName(field), linkColumn: fieldToColumnName(linkField),
  }
}

/**
 * Grade resolved operations against the schema the statements run on: the
 * migration HISTORY for `create`, the live database for `dry-run` (`what`).
 * The names are interpolated into SQL by `renameStatement`, so what lets them
 * in is that each one was read off a column that exists there (Invariant 8).
 *
 * @param {any[]} ops
 * @param {any} shadowSchema
 * @param {string} [what]
 * @returns {string|null} a refusal, or null
 */
export function checkAgainstHistory(ops, shadowSchema, what = 'the migration history') {
  for (const o of ops) {
    const t = shadowSchema?.[o.table]
    const cols = new Set((t?.columns ?? []).map((/** @type {any} */ c) => c.name))
    if (o.op === 'split') {
      const at = `split ${o.model}.${o.column} → ${o.into}.${o.field}`
      if (!t) return `${at}: ${what} builds no table ${o.table}, so there are no values to copy`
      if (!cols.has(o.column)) return `${at}: ${what} has no column ${o.table}.${o.column}. Its columns are ${[...cols].join(', ')}`
      // Into a table that already holds rows, the row-count check below the copy
      // cannot tell copied rows from the ones that were there.
      if (shadowSchema?.[o.intoTable]) return `${at}: ${what} already builds ${o.intoTable}; a split copies into a model this migration adds`
      continue
    }
    if (o.op === 'backfill') {
      const at = `backfill ${o.model}.${o.field}`
      if (!t) return `${at}: ${what} builds no table ${o.table}, so there are no rows to fill — the table is new, and the backfill is not needed`
      if (cols.has(o.column)) return `${at}: ${what} already has ${o.table}.${o.column}; a backfill fills only a column this migration adds`
      continue
    }
    const at = `${o.model}.${o.from} → ${o.to}`
    if (!t) return `${at}: ${what} builds no table ${o.table}, so there is nothing to rename in`
    if (!cols.has(o.from))
      return `${at}: ${what} has no column ${o.table}.${o.from}` +
             (cols.has(o.to) ? ` — but it already has ${o.to}, so the rename was made` : `. Its columns are ${[...cols].join(', ')}`)
    if (cols.has(o.to)) return `${at}: ${what} already has ${o.table}.${o.to}, which a rename would overwrite`
  }
  return null
}

/**
 * One operation as the statement the file carries.
 *
 * @param {any} o
 */
export function renameStatement(o) {
  return `ALTER TABLE ${quoteIdent(o.table)} RENAME COLUMN ${quoteIdent(o.from)} TO ${quoteIdent(o.to)};`
}

/**
 * The statements that run before the diff's: a rename has happened by the time
 * the rest of the file reads the table. A backfill has no statement of its own;
 * it is a value expression in the copy (`backfillExpression`).
 *
 * @param {any[]} ops
 */
export function renameStatements(ops) {
  return ops.filter(o => o.op === 'rename').map(renameStatement)
}

/**
 * What a backfilled column takes for each existing row. Both names were read
 * off the schema, not taken from the document (Invariant 8).
 *
 * @param {any} o
 */
export function backfillExpression(o) {
  // A created parent is the newest row: its INSERT ran in this file, after every
  // row the table already held.
  return o.first
    ? `(SELECT ${quoteIdent(o.parentKey)} FROM ${quoteIdent(o.parentTable)}${o.live ?? ''} ORDER BY rowid${o.insert ? ' DESC' : ''} LIMIT 1)`
    : o.literal
}

/**
 * The statements that run after the new tables and before any rebuild, where
 * the table a row goes into and the column a value comes from both exist
 * (`FJS-D2313`). A split's copy is followed by a count the constraint name
 * explains when it fails.
 *
 * A created parent is inserted only over a table that has rows: a fresh
 * database replays this file too, and would otherwise start with a parent row
 * nobody asked for.
 *
 * @param {any[]} ops
 * @returns {string[]}
 */
export function carryStatements(ops) {
  const out = []
  for (const o of ops) {
    if (o.op === 'backfill' && o.insert) {
      out.push(`INSERT INTO ${quoteIdent(o.parentTable)} (${o.insert.columns.map(quoteIdent).join(', ')}) ` +
               `SELECT ${o.insert.literals.join(', ')} WHERE EXISTS (SELECT 1 FROM ${quoteIdent(o.table)});`)
      continue
    }
    if (o.op !== 'split') continue
    const [into, src, col] = [quoteIdent(o.intoTable), quoteIdent(o.table), quoteIdent(o.column)]
    const copied = `${src} WHERE ${col} IS NOT NULL`
    out.push(
      `INSERT INTO ${into} (${quoteIdent(o.linkColumn)}, ${quoteIdent(o.toColumn)}) SELECT ${quoteIdent(o.sourceKey)}, ${col} FROM ${copied};`,
      `-- check: one ${o.into} row per ${o.model} with a ${o.column}`,
      `CREATE TEMP TABLE "_litestone_split" (`,
      `  ok INTEGER CONSTRAINT ${quoteIdent(`split ${o.model}.${o.column} into ${o.into}.${o.field} copied a different number of rows than ${o.model} holds values`)} CHECK (ok = 1)`,
      `);`,
      `INSERT INTO "_litestone_split" (ok)`,
      `  SELECT CASE WHEN (SELECT count(*) FROM ${into}) = (SELECT count(*) FROM ${copied}) THEN 1 ELSE 0 END;`,
      `DROP TABLE "_litestone_split";`,
    )
  }
  return out
}

/**
 * Whether the parent is empty is known only where the file is APPLIED, and an
 * empty parent turns the expression into NULL — refused by the column as a bare
 * `NOT NULL constraint failed` that names no operation. The guard refuses first
 * with the constraint name as the message, and passes on a table with no rows,
 * which is every table the shadow replays.
 *
 * @param {any} o
 * @param {string} table the table whose rows are filled, under the name it has where the guard runs
 * @returns {string[]}
 */
export function backfillGuard(o, table = o.table) {
  if (!o.first || o.insert) return []
  const name = `backfill ${o.model}.${o.field} first ${o.first}: ${o.first} has no rows, so the ${o.model} rows already ` +
               `there have none to take — create one before this migration, or backfill a value`
  return [
    `CREATE TEMP TABLE "_litestone_backfill" (`,
    `  ok INTEGER CONSTRAINT ${quoteIdent(name)} CHECK (ok = 1)`,
    `);`,
    `INSERT INTO "_litestone_backfill" (ok)`,
    `  SELECT CASE WHEN EXISTS (SELECT 1 FROM ${quoteIdent(table)}) AND NOT EXISTS (SELECT 1 FROM ${quoteIdent(o.parentTable)}${o.live ?? ''}) THEN 0 ELSE 1 END;`,
    `DROP TABLE "_litestone_backfill";`,
  ]
}

/**
 * The line a header and a summary say it with.
 *
 * @param {any} o
 */
export function describeOperation(o) {
  if (o.op === 'backfill')
    return `backfill ${o.model}.${o.field} ← ${o.insert ? `a new ${o.first} row` : o.first ? `the first ${o.first} row` : o.literal}  (the rows already there take it)`
  if (o.op === 'split')
    return `split ${o.model}.${o.column} → ${o.into}.${o.field}  (one ${o.into} row per ${o.model} with a value, linked by ${o.link})`
  return `${o.op} ${o.model}.${o.from} → ${o.to}  (the values stay)`
}

/**
 * Pairs of a column that left and a column that arrived, of the same type and
 * the only such on that table. Far more often a rename than a coincidence, and
 * only ever a QUESTION: the guess changes a sentence or a prompt, never a file.
 *
 * @param {any[] | null | undefined} tableDiffs
 * @param {any} parseResult
 * @param {{ pluralize?: boolean }} [opts]
 * @returns {{ model: string, table: string, from: string, to: string, field: string, type: string }[]}
 */
export function guessRenames(tableDiffs, parseResult, { pluralize = false } = {}) {
  const out = []
  for (const d of tableDiffs ?? []) {
    const dropped = d.cols?.dropped ?? []
    const added   = d.cols?.added ?? []
    const model   = parseResult.schema.models.find((/** @type {any} */ m) => modelToTableName(m, pluralize) === d.name)
    if (!model) continue
    for (const gone of dropped) {
      const sameKind = (/** @type {any} */ c, /** @type {any[]} */ side) => side.filter((/** @type {any} */ x) => x.type === c.type)
      const arrived = sameKind(gone, added)
      if (arrived.length !== 1 || sameKind(arrived[0], dropped).length !== 1) continue
      const field = model.fields.find((/** @type {any} */ f) => isStoredField(f) && fieldToColumnName(f) === arrived[0].name)
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
 * @param {any[]} guesses
 * @param {(question: string) => any} ask
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
