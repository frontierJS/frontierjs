// src/export.js — the governed extract.
//
// `FJS-D228` phase 1. Before this, the only way data left an FJS app was a
// person clicking the CSV button in Studio, which is a development tool and
// answers as the file's owner rather than as a principal (`FJS-D230`).
//
// ─── Why there is almost no enforcement code here ─────────────────────────
//
// Everywhere else an extract is a privileged dump: the pipeline connects as a
// service account that reads everything, and every access rule the application
// declared stops at the copy. The obvious fix is a second grader that reapplies
// the rules on the way out, and that would be a second origin for the one thing
// this package must have exactly one of.
//
// So an export is not a read path. It is a PAGINATED SCOPED READ: `$setAuth`
// returns a client whose gate and row policies compile into the SQL, and the
// extract is whatever that client answers. A gate below the level refuses at the
// first page; a row policy narrows the file rather than failing it; a field
// policy or `@guarded` column is absent because the predicate already compiled.
// Under tenancy the extract is one tenant's, because the client is.
//
// ─── The two rules that are this module's own ─────────────────────────────
//
// PROTECTED COLUMNS ARE OMITTED even from a principal who may read them. An
// interactive read is a screen and an extract is a file that leaves the machine:
// same principal, different blast radius. `includeProtected` is the escape and
// it is recorded in the manifest, because the risk is somebody adding it to a
// script once and never taking it out.
//
// THE MANIFEST RECORDS WHAT WAS LEFT OUT. A manifest that lists only what an
// extract contains is a receipt; one that names the omissions and the policies
// that applied is evidence, and it is the half that lets somebody tell an
// incomplete export from a complete one a year later.

import { isStoredField, modelToAccessor } from './core/ddl.js'
import { policyExprToString }  from './core/policy.js'
import { parseGateString }     from './plugins/gate.js'

/** Attributes that make a column protected — omitted from an extract by default. */
const PROTECTED_ATTRS = new Set(['encrypted', 'secret', 'guarded', 'hashed'])

const FORMATS = new Set(['ndjson', 'csv'])

/**
 * Every dataset this schema says may leave, model and view alike.
 * The CLI lists these; nothing else derives the set.
 */
export function exportableDatasets(schema) {
  const out = []
  for (const model of schema.models ?? []) {
    const ex = (model.attributes ?? []).find(a => a.kind === 'export')
    if (ex) out.push({ name: model.name, accessor: modelToAccessor(model.name), kind: 'model', decl: model, export: ex })
  }
  for (const view of schema.views ?? []) {
    const ex = (view.attributes ?? []).find(a => a.kind === 'export')
    if (ex) out.push({ name: view.name, accessor: view.name, kind: 'view', decl: view, export: ex })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Labels for the manifest, and NEVER the decision — `isStoredField` is that.
 * A second list that decided would drift from the first, which is exactly what
 * happened: this module tested `relation` and `computed` by hand and put a
 * `@transient` field in every CSV header with an empty value under it
 * (`FJS-983`). A kind missing from here costs a vaguer word in one manifest
 * line; a kind missing from the decision costs a phantom column in the extract.
 */
const NOT_STORED_LABELS = new Set(['computed', 'from', 'derived', 'transient', 'edge'])

function notStoredReason(f) {
  if (f.type?.kind === 'relation')    return 'relation'
  if (f.type?.kind === 'implicitM2M') return 'implicitM2M'
  const a = (f.attributes ?? []).find(x => NOT_STORED_LABELS.has(x.kind))
  return a ? a.kind : 'not stored'
}

/** The columns that leave, and the ones that do not — with the reason. */
export function columnPlan(decl, { includeProtected = false } = {}) {
  const columns = []
  const omitted = []
  for (const f of decl.fields ?? []) {
    // `isStoredField` ([ddl.js]) is the one owner of *is this a column*: a
    // relation's key is on the other side, an implicit m2m is a join table,
    // `@edge` is a side table, `@computed`/`@from`/`@derived` are read-side
    // only, and `@transient` is a payload key that is never stored at all.
    // A cursor or a CSV header over any of them invents a column the database
    // does not have.
    if (!isStoredField({ ...f, attributes: f.attributes ?? [] })) {
      omitted.push({ name: f.name, reason: notStoredReason(f) })
      continue
    }

    const protectedBy = (f.attributes ?? []).map(a => a.kind).find(a => PROTECTED_ATTRS.has(a))
    if (protectedBy && !includeProtected) { omitted.push({ name: f.name, reason: 'protected', by: `@${protectedBy}` }); continue }

    columns.push({ name: f.name, type: f.type?.name ?? 'String', protected: Boolean(protectedBy) })
  }
  return { columns, omitted }
}

// ─── Serializers ──────────────────────────────────────────────────────────
//
// NDJSON is `JSON.stringify` and therefore already right about every type this
// package can hold — an `Int @big` crosses as a string of digits because that is
// what `JSON.stringify` does with the value the client answered, which is the
// same thing every response and every audit snapshot does with it.
//
// CSV is the one a spreadsheet opens and it is where that stops being free: a
// wide integer written as a bare number is a rounded double the moment something
// parses the file, so every value goes through the same `toText` and quoting is
// by content rather than by type.

function toText(v) {
  if (v === null || v === undefined) return ''
  if (v instanceof Date)             return v.toISOString()
  if (typeof v === 'object')         return JSON.stringify(v)
  return String(v)
}

function csvCell(v) {
  const s = toText(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function makeSerializer(format, columns) {
  if (format === 'ndjson') {
    return {
      header: () => null,
      row: (row) => JSON.stringify(Object.fromEntries(columns.map(c => [c.name, row[c.name] ?? null]))),
    }
  }
  return {
    header: () => columns.map(c => csvCell(c.name)).join(','),
    row:    (row) => columns.map(c => csvCell(row[c.name])).join(','),
  }
}

// ─── The run ──────────────────────────────────────────────────────────────

/**
 * Take an extract.
 *
 * `as` is a principal row — an account the app issued, never a synthesized one:
 * a made-up principal evaluates every claim-based policy against nothing, which
 * is where three-valued logic is least safe. `system: true` is the explicit
 * escape and is stamped.
 *
 * `write` receives one line at a time and is awaited, so a caller can stream to
 * a file, a socket or an HTTP response. Nothing here holds the rows: a ten
 * million row extract must not be a value, which is why the read is
 * `findManyCursor` and never `findMany`.
 */
export async function runExport(db, name, opts = {}) {
  const {
    as = null, system = false,
    since = null, format: formatOverride = null,
    includeProtected = false, withDeleted = false,
    batch = 1000, write, now = () => new Date(),
    audit = true, tenant = null,
  } = opts

  if (typeof write !== 'function')
    throw new Error('runExport needs a write(line) sink — an extract is streamed, never returned')
  if (!as && !system)
    throw new Error(
      'runExport needs a standing: pass `as` (an account the app issued) or `system: true`. ' +
      'An export is a bulk read and there is no default caller to be.')

  const schema  = db.$schema
  const dataset = exportableDatasets(schema).find(d => d.name === name || d.accessor === name)
  if (!dataset) {
    const known = exportableDatasets(schema).map(d => d.name)
    throw new Error(
      `'${name}' declares no @@export.` +
      (known.length ? ` Datasets that do: ${known.join(', ')}.` : ' No dataset in this schema does.'))
  }

  const format = formatOverride ?? dataset.export.format
  if (!FORMATS.has(format))
    throw new Error(`Format '${format}' is not one this can write — ${[...FORMATS].join(' or ')}.`)

  const { columns, omitted } = columnPlan(dataset.decl, { includeProtected })
  const cursorColumn = dataset.export.since
  if (since && !cursorColumn)
    throw new Error(
      `'${dataset.name}' declares no @@export(since:), so there is no cursor to resume from. ` +
      `Name a sortable column in the schema, or take the whole dataset.`)

  // The scoped client IS the enforcement. Everything below reads through it.
  const client   = system ? db.asSystem() : db.$setAuth(as)
  const table    = client[dataset.accessor]
  if (!table) throw new Error(`'${dataset.accessor}' is not on this client — the schema and the database disagree`)

  const ser = makeSerializer(format, columns)
  const head = ser.header()
  if (head !== null) await write(head)

  const startedAt = now()
  let rows   = 0
  let cursor = null
  let last   = since ?? null

  // A cursor read needs a TOTAL ORDER, and not every dataset has one. A model
  // has its primary key; an aggregate view has neither a key nor a declared
  // cursor, and `findManyCursor` rightly refuses to page something it cannot
  // order uniquely — some rows would be served twice and others skipped.
  //
  // So the strategy is chosen from what the dataset actually offers rather than
  // assumed, and the offset path is not a lesser fallback: a projection over the
  // whole world is small and is answered whole, which is what an aggregate IS.
  // The columns that give the read a total order: the declared cursor, or the
  // primary key — which is a LIST, because a key can be a tuple, and empty for
  // a view. An empty list is not a weaker order, it is no order at all.
  const orderColumns = cursorColumn ? [cursorColumn] : safePrimaryKey(db, dataset.accessor)
  const where = since && cursorColumn ? { [cursorColumn]: { gt: since } } : undefined

  const common = {
    ...(where ? { where } : {}),
    ...(withDeleted ? { withDeleted: true } : {}),
  }

  const take = (row) => {
    rows++
    if (cursorColumn && row[cursorColumn] !== undefined) last = row[cursorColumn]
  }

  if (orderColumns.length) {
    // `cursor:` and not `$after:` — the `$` spelling is the transport's, and no
    // `$`-prefixed key survives the bridge (Invariant 10). This is the client.
    for (;;) {
      const page = await table.findManyCursor({
        ...common,
        orderBy: orderColumns.map(c => ({ [c]: 'asc' })),
        ...(cursor ? { cursor } : {}),
        limit: batch,
      })
      for (const row of page.items ?? []) { await write(ser.row(row)); take(row) }
      if (!page.hasMore || !page.nextCursor) break
      cursor = page.nextCursor
    }
  } else {
    for (let offset = 0; ; offset += batch) {
      const page = await table.findMany({ ...common, limit: batch, offset })
      if (!page.length) break
      for (const row of page) { await write(ser.row(row)); take(row) }
      if (page.length < batch) break
    }
  }

  const manifest = {
    feed:    dataset.name,
    kind:    dataset.kind,
    format,
    takenAt: startedAt.toISOString(),
    // The DECLARED read gate beside the principal, not the caller's resolved
    // level: a level is a fact about a session at a moment and the plugin owns
    // it, where the gate is a fact about the dataset that this file can be
    // checked against later. `readGrading` is the other half and it is the one
    // that answers *was anything grading this at all* — an ungraded read is a
    // different statement from a low one.
    takenAs: system
      ? { principal: null, system: true, declaredReadGate: declaredReadGate(dataset) }
      : { principal: as?.id ?? null, system: false, declaredReadGate: declaredReadGate(dataset),
          reads: safeReadGrading(db, dataset.accessor) },
    tenant,
    columns,
    rows,
    cursor: cursorColumn ? { column: cursorColumn, after: last ?? null } : null,
    policiesApplied: policyTextFor(schema, dataset),
    omitted,
    includeProtected,
    withDeleted,
  }

  // One row per RUN, not per row read. An export is a read and reads are not
  // logged by default — for good reason, they are high volume — but a bulk
  // extract is the single event most worth having a record of, and `$audit` is
  // the verb for something that is not a write.
  if (audit) {
    try {
      await db.$audit({
        operation: 'export',
        model:     dataset.name,
        actorId:   system ? null : (as?.id ?? null),
        actorType: system ? 'system' : 'user',
        meta:      manifest,
      })
    } catch { /* a trail that refused must not lose the extract that already left */ }
  }

  return manifest
}

/**
 * The key columns to page by, in key order. Empty where the dataset has none —
 * an aggregate view has neither a key nor a declared cursor, and `findManyCursor`
 * rightly refuses to page something it cannot order uniquely.
 *
 * `$primaryKey` answers a LIST because a key can be a tuple (`@@id([a, b])`), so
 * every column of it goes into the ORDER BY: dropping the second one would page
 * an order that is not total and serve some rows twice.
 */
function safePrimaryKey(db, accessor) {
  try {
    const k = db.$primaryKey(accessor)
    return Array.isArray(k) ? k : (k ? [k] : [])
  } catch { return [] }
}

/** The gate a read of this dataset declares — a fact about the dataset, checkable later. */
function declaredReadGate(dataset) {
  const attr = (dataset.decl.attributes ?? []).find(a => a.kind === 'gate')
  if (!attr) return null
  try { return parseGateString(attr.value).read } catch { return null }
}

/** Whether anything graded this read at all. An ungraded read is not a low one. */
function safeReadGrading(db, accessor) {
  try { return typeof db.$readGrading === 'function' ? db.$readGrading(accessor) : null }
  catch { return null }
}

/**
 * The row policies that bounded this extract, as the predicates the schema
 * declares — the same rendering `access.js` commits, so a manifest and the
 * access snapshot cannot describe one rule two ways.
 */
function policyTextFor(schema, dataset) {
  const out = []
  for (const attr of dataset.decl.attributes ?? []) {
    if (attr.kind !== 'allow' && attr.kind !== 'deny') continue
    if (!attr.operations?.includes('read')) continue
    out.push({
      kind:      attr.kind,
      expr:      policyExprToString(attr.expr),
      generated: attr.generated ?? null,
    })
  }
  return out
}
