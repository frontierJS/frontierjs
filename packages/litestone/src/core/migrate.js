// migrate.js — pristine-based SQLite diff engine
//
// Source of truth: schema.lite → DDL → in-memory "pristine" db
// The live db is a target, never a source of truth.
//
// Flow:
//   parse(schema.lite) → generateDDL() → exec on :memory: → introspect pristine
//   introspect live db
//   diff(pristine, live) → migration SQL
//
// SQLite ALTER TABLE constraints:
//   Simple ALTER:  add nullable col, add col with DEFAULT, add/drop index
//   Full rebuild:  drop col, change type, change NOT NULL, change DEFAULT,
//                  change PK, change FK, change CHECK, add @@strict

import { generateDDL, generateDDLForDatabase, generateTableDDL, generateIndexDDL, generateViewDDL, modelToTableName , detectM2MPairs, generateJoinTableDDL } from './ddl.js'
import { createHash } from 'crypto'

// ─── Introspect ───────────────────────────────────────────────────────────────
// Works on any db handle with .prepare() (Bun Database).
// Returns: { tableName: { columns, indexes, foreignKeys, strict } }

// Underscore prefix = machinery tables: _litestone_*, implicit-m2m join tables
// (_task_user, _members, _TagToTag), matching Prisma's convention.
const INTERNAL = /^(_|sqlite_|.*_fts$|.*_fts_data$|.*_fts_idx$|.*_fts_content$|.*_fts_docsize$|.*_fts_config$)/

export function introspect(db) {
  const schema = {}

  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all()
    .map(r => r.name)
    .filter(n => !INTERNAL.test(n))

  for (const t of tables) {
    const columns = db.prepare(`PRAGMA table_info("${t}")`).all().map(r => ({
      name:    r.name,
      type:    (r.type || 'TEXT').toUpperCase(),
      notnull: !!r.notnull,
      pk:      !!r.pk,
      default: r.dflt_value ?? null,
    }))

    const indexes = db.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`
    ).all(t).map(r => {
      const unique = /CREATE UNIQUE INDEX/i.test(r.sql)
      const match  = r.sql.match(/\(([^)]+)\)/)
      const cols   = match
        ? match[1].split(',').map(c => c.trim().replace(/^["'`]|["'`]$/g, ''))
        : []
      return { name: r.name, cols, unique }
    })

    const fkRows = db.prepare(`PRAGMA foreign_key_list("${t}")`).all()
    const fkMap  = new Map()
    for (const row of fkRows) {
      if (!fkMap.has(row.id))
        fkMap.set(row.id, { table: row.table, from: [], to: [], onDelete: row.on_delete, onUpdate: row.on_update })
      fkMap.get(row.id).from.push(row.from)
      fkMap.get(row.id).to.push(row.to)
    }
    const foreignKeys = [...fkMap.values()].map(fk =>
      fk.from.length === 1
        ? { from: fk.from[0], table: fk.table, to: fk.to[0], onDelete: fk.onDelete, onUpdate: fk.onUpdate }
        : { from: fk.from,    table: fk.table, to: fk.to,    onDelete: fk.onDelete, onUpdate: fk.onUpdate }
    )

    const { sql: tblSql } = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`
    ).get(t) ?? { sql: '' }

    const strict = /\)\s*STRICT\s*;?\s*$/i.test(tblSql)

    schema[t] = { columns, indexes, foreignKeys, strict }
  }

  // Views — stored separately under __views (filtered out of table comparisons)
  const viewRows = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type='view' AND sql IS NOT NULL`)
    .all()
    .filter(r => !INTERNAL.test(r.name))

  schema.__views = {}
  for (const v of viewRows) {
    schema.__views[v.name] = { sql: v.sql }
  }

  // Triggers — recorded so a change to a GENERATED trigger body can migrate.
  // Nothing read them until the @@fts + @@softDelete pair had to be repaired:
  // both databases already had the wrong triggers, and a diff that cannot see a
  // trigger reports a schema in sync while every remove() on that model throws.
  const trigRows = db
    .prepare(`SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL`)
    .all()

  schema.__triggers = {}
  for (const t of trigRows) {
    schema.__triggers[t.name] = { table: t.tbl_name, sql: t.sql }
  }

  return schema
}

// Two trigger definitions are the same trigger when SQLite would build the same
// thing from them. `IF NOT EXISTS` is stripped because buildPristine strips it
// on the way in, so the pristine side never carries it and the live side does.
export function normaliseTriggerSql(sql) {
  return sql
    .replace(/CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS/i, 'CREATE TRIGGER')
    .replace(/\s+/g, ' ')
    .replace(/;\s*$/, '')
    .trim()
}

// Trigger names litestone generates, and therefore owns: a trigger matching one
// of these is ours to drop and recreate, anything else on the table is the
// app's and is left alone.
const OWNED_TRIGGER = /_(fts_insert|fts_delete|fts_update|fts_soft_delete|fts_restore|updatedAt)$/

// ─── Pristine db ──────────────────────────────────────────────────────────────
// Executes parsed schema DDL against a fresh in-memory db.
// Returns the introspected schema of that pristine db.


// Splits a SQL string into individual statements.
// Naive semicolon-split fails on trigger bodies (BEGIN...END contains semicolons).
// This tracks BEGIN/END depth so we only split at top-level semicolons.
// Only a CREATE TRIGGER opens a BEGIN...END body. A bare BEGIN at the start
// of a statement is a *transaction* and must end at its own semicolon —
// counting it as body depth fused everything after it (COMMIT never
// decrements) into one giant statement, which then reached db.run() as a
// single multi-statement string where a failing statement is silently
// skipped instead of raised.
const TRIGGER_HEAD = /^CREATE\s+(TEMP(ORARY)?\s+)?TRIGGER\b/i

export function splitStatements(sql) {
  const stmts = []
  let   cur   = ''
  let   depth = 0   // nesting level inside a CREATE TRIGGER's BEGIN...END body

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]

    // Skip line comments
    if (ch === '-' && sql[i+1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }

    // Skip block comments
    if (ch === '/' && sql[i+1] === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i+1] === '/')) i++
      i++
      continue
    }

    // Skip strings
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch
      cur += ch
      i++
      while (i < sql.length && sql[i] !== q) {
        if (sql[i] === '\\') { cur += sql[i++] }
        cur += sql[i++]
      }
      cur += sql[i] ?? ''
      continue
    }

    // Track BEGIN/END depth for trigger bodies
    // Look for word boundaries to avoid matching "UNBOUNDED" etc.
    const word5 = sql.slice(i, i+5).toUpperCase()
    const word4 = sql.slice(i, i+4).toUpperCase()
    const word3 = sql.slice(i, i+3).toUpperCase()
    const prevIsWord = i > 0 && /\w/.test(sql[i-1])
    const nextIsWordAt = (n) => /\w/.test(sql[i+n] ?? '')

    if (!prevIsWord && word5 === 'BEGIN' && !nextIsWordAt(5)) {
      // Body depth only when this statement is a CREATE TRIGGER; a
      // transaction BEGIN stays an ordinary statement.
      if (TRIGGER_HEAD.test(cur.trimStart())) depth++
    } else if (!prevIsWord && word4 === 'CASE' && !nextIsWordAt(4)) {
      // CASE...END inside a trigger body — count it so its END doesn't
      // close the trigger body early. Outside a body, CASE is not ours
      // to track.
      if (depth > 0) depth++
    } else if (!prevIsWord && word3 === 'END' && !nextIsWordAt(3)) {
      if (depth > 0) depth--
    }

    if (ch === ';' && depth === 0) {
      const s = cur.trim()
      if (s) stmts.push(s)
      cur = ''
    } else {
      cur += ch
    }
  }
  const s = cur.trim()
  if (s) stmts.push(s)
  return stmts
}

export function buildPristine(db, parseResult) {
  const ddl = generateDDL(parseResult.schema, { foreignKeys: true })

  // Strip IF NOT EXISTS — we want errors if the schema itself is invalid
  const cleanDDL = ddl
    .replace(/CREATE TABLE IF NOT EXISTS/gi,         'CREATE TABLE')
    .replace(/CREATE INDEX IF NOT EXISTS/gi,         'CREATE INDEX')
    .replace(/CREATE UNIQUE INDEX IF NOT EXISTS/gi,  'CREATE UNIQUE INDEX')
    .replace(/CREATE VIRTUAL TABLE IF NOT EXISTS/gi, 'CREATE VIRTUAL TABLE')
    .replace(/CREATE TRIGGER IF NOT EXISTS/gi,       'CREATE TRIGGER')
    .replace(/CREATE VIEW IF NOT EXISTS/gi,          'CREATE VIEW')

  // Split into statements — handles trigger BEGIN...END blocks that contain semicolons
  const stmts = splitStatements(cleanDDL).filter(s => !s.startsWith('PRAGMA'))

  for (const stmt of stmts) {
    try {
      db.prepare(stmt + ';').run()
    } catch (e) {
      throw new Error(`Invalid schema — error executing:\n  ${stmt.slice(0, 120)}\n  → ${e.message}`)
    }
  }

  return introspect(db)
}

// buildPristineForDatabase — same as buildPristine but scoped to a single named database.
// Used by the per-database migration engine.
export function buildPristineForDatabase(db, parseResult, dbName) {
  const ddl = generateDDLForDatabase(parseResult.schema, dbName, { foreignKeys: true })

  const cleanDDL = ddl
    .replace(/CREATE TABLE IF NOT EXISTS/gi,         'CREATE TABLE')
    .replace(/CREATE INDEX IF NOT EXISTS/gi,         'CREATE INDEX')
    .replace(/CREATE UNIQUE INDEX IF NOT EXISTS/gi,  'CREATE UNIQUE INDEX')
    .replace(/CREATE VIRTUAL TABLE IF NOT EXISTS/gi, 'CREATE VIRTUAL TABLE')
    .replace(/CREATE TRIGGER IF NOT EXISTS/gi,       'CREATE TRIGGER')
    .replace(/CREATE VIEW IF NOT EXISTS/gi,          'CREATE VIEW')

  const stmts = splitStatements(cleanDDL).filter(s => !s.startsWith('PRAGMA'))

  for (const stmt of stmts) {
    try {
      db.prepare(stmt + ';').run()
    } catch (e) {
      throw new Error(`Invalid schema for database '${dbName}' — error executing:\n  ${stmt.slice(0, 120)}\n  → ${e.message}`)
    }
  }

  return introspect(db)
}

// ─── Column diff ──────────────────────────────────────────────────────────────

function diffColumns(pristineCols, liveCols) {
  const pm = new Map(pristineCols.map(c => [c.name, c]))
  const lm = new Map(liveCols.map(c => [c.name, c]))

  const added    = []
  const dropped  = []
  const modified = []

  for (const col of pristineCols) {
    if (!lm.has(col.name)) {
      added.push(col)
    } else {
      const live    = lm.get(col.name)
      const changes = []
      if (live.type    !== col.type)    changes.push({ field: 'type',    from: live.type,    to: col.type })
      if (live.notnull !== col.notnull) changes.push({ field: 'notnull', from: live.notnull, to: col.notnull })
      if (live.pk      !== col.pk)      changes.push({ field: 'pk',      from: live.pk,      to: col.pk })
      const ld = live.default?.trim() ?? null
      const pd = col.default?.trim()  ?? null
      if (ld !== pd) changes.push({ field: 'default', from: ld, to: pd })
      if (changes.length) modified.push({ name: col.name, changes })
    }
  }

  for (const col of liveCols) {
    if (!pm.has(col.name)) dropped.push(col)
  }

  return { added, dropped, modified }
}

// ─── Index diff ───────────────────────────────────────────────────────────────

function indexKey(idx) { return `${idx.unique ? 'u' : ''}:${[...idx.cols].sort().join(',')}` }

// Every index litestone generates for a model table is named
// `idx_<table>_<fields>` (createIndexes in ddl.js), so the prefix is what
// litestone owns. An index with any other name was created by the app — in a JS
// migration, or straight against the database — and litestone did not put it
// there, so it does not take it away. Before this, an index the app added was
// live-and-not-pristine, which lands in `dropped`, and the next schema change of
// ANY kind removed it: not an error, not a rebuild, just a query plan that
// silently collapsed.
//
// A hand-made index NAMED `idx_<table>_…` is still dropped. That is the name
// litestone would generate for the same `@@index`, so treating it as litestone's
// is the honest reading, and stated in docs/migrations.md.
//
// Join and side tables need no exception: their generated indexes exist
// identically in pristine and live, so they never reach `dropped`.
const ownedIndex = (name, table) => name.startsWith(`idx_${table}_`)

function diffIndexes(pristineIdxs, liveIdxs, table) {
  const pm = new Map(pristineIdxs.map(i => [indexKey(i), i]))
  const lm = new Map(liveIdxs.map(i => [indexKey(i), i]))
  return {
    added:   pristineIdxs.filter(i => !lm.has(indexKey(i))),
    dropped: liveIdxs.filter(i => !pm.has(indexKey(i)) && ownedIndex(i.name, table)),
    foreign: liveIdxs.filter(i => !pm.has(indexKey(i)) && !ownedIndex(i.name, table)),
  }
}

// ─── FK diff ──────────────────────────────────────────────────────────────────

function fkKey(fk) {
  const from = Array.isArray(fk.from) ? fk.from.join(',') : fk.from
  const to   = Array.isArray(fk.to)   ? fk.to.join(',')   : fk.to
  return `${from}→${fk.table}.${to}:${fk.onDelete ?? 'NO ACTION'}`
}

function fksEqual(a, b) {
  const ak = new Set(a.map(fkKey))
  const bk = new Set(b.map(fkKey))
  if (ak.size !== bk.size) return false
  for (const k of ak) if (!bk.has(k)) return false
  return true
}

// ─── Full diff ────────────────────────────────────────────────────────────────

const META_KEYS = new Set(['__views', '__triggers'])

export function diffSchemas(pristine, live, parseResult, dbName = 'main', { pluralize = false } = {}) {
  // Filter the meta buckets out of the table name sets
  const pristineNames = new Set(Object.keys(pristine).filter(k => !META_KEYS.has(k)))
  const liveNames     = new Set(Object.keys(live).filter(k => !META_KEYS.has(k)))

  // Filter models to those belonging to this database, excluding @@external
  const dbModels = parseResult.schema.models.filter(m => {
    if (m.attributes?.some(a => a.kind === 'external')) return false
    const dbAttr = m.attributes?.find(a => a.kind === 'db')
    return (dbAttr?.name ?? 'main') === dbName
  })

  // Materialized views for this database — they appear as tables in pristine/live
  const dbMatViews = (parseResult.schema.views ?? [])
    .filter(v => v.materialized && (v.db ?? 'main') === dbName)

  // Compare by derived table name (snake_case, optionally pluralized) — not by
  // the raw model name. Under the PascalCase convention, `model User` produces
  // table "user", so the previous `pristineNames.has(m.name)` check never matched.
  const newTables = dbModels
    .filter(m => {
      const t = modelToTableName(m, pluralize)
      return pristineNames.has(t) && !liveNames.has(t)
    })

  // New materialized views (their table doesn't exist in live yet)
  const newMatViews = dbMatViews
    .filter(v => pristineNames.has(v.name) && !liveNames.has(v.name))

  // Regular views for this database
  const dbRegViews = (parseResult.schema.views ?? [])
    .filter(v => !v.materialized && (v.db ?? 'main') === dbName)
  const liveViews = live.__views ?? {}

  const newViews = dbRegViews.filter(v => !liveViews[v.name])
  const changedViews = dbRegViews.filter(v => {
    if (!liveViews[v.name]) return false
    // Normalize whitespace and compare SQL bodies
    const norm = s => s.replace(/\s+/g, ' ').trim().replace(/;$/, '')
    const expected = norm(`CREATE VIEW "${v.name}" AS\n${v.sql}`)
    return norm(liveViews[v.name].sql) !== expected
  })

  // External table names — never drop these even if not in pristine.
  // Compare by derived table name (same convention as pristine/live).
  const externalNames = new Set(
    parseResult.schema.models
      .filter(m => m.attributes?.some(a => a.kind === 'external'))
      .map(m => modelToTableName(m, pluralize))
  )

  const droppedTables = [...liveNames].filter(n => !pristineNames.has(n) && !externalNames.has(n))

  const tableDiffs = []

  for (const name of pristineNames) {
    if (!liveNames.has(name)) continue

    const p = pristine[name]
    const l = live[name]

    const cols         = diffColumns(p.columns, l.columns)
    const indexes      = diffIndexes(p.indexes, l.indexes, name)
    const fkChanged    = !fksEqual(p.foreignKeys, l.foreignKeys)
    const strictChanged = p.strict !== l.strict

    const needsRebuild =
      cols.dropped.length  > 0 ||
      cols.modified.length > 0 ||
      fkChanged            ||
      strictChanged

    // Cols we can safely ADD COLUMN — nullable, or has a default, not PK
    const simpleAdds  = needsRebuild ? [] : cols.added.filter(c => !c.pk && (!c.notnull || c.default !== null))
    // Cols we can't add automatically — NOT NULL, no default
    const blockedAdds = needsRebuild ? [] : cols.added.filter(c => !c.pk && c.notnull && c.default === null)

    const hasChanges =
      needsRebuild           ||
      simpleAdds.length  > 0 ||
      blockedAdds.length > 0 ||
      indexes.added.length   > 0 ||
      indexes.dropped.length > 0

    if (hasChanges) {
      tableDiffs.push({ name, needsRebuild, simpleAdds, blockedAdds, cols, indexes, fkChanged, strictChanged })
    }
  }

  // Triggers — only over tables this database still has, and only the ones
  // litestone generates. A trigger the app wrote is not in pristine, so it is
  // never dropped here.
  //
  // A rebuilt table needs every one of its triggers restated even when the
  // bodies match: rebuildSQL drops the table, which takes its triggers with it,
  // and nothing put them back. A model with @@fts came out of a column-drop
  // migration with an index that had silently stopped updating.
  const pristineTrigs = pristine.__triggers ?? {}
  const liveTrigs     = live.__triggers ?? {}
  const rebuilding    = new Set(tableDiffs.filter(d => d.needsRebuild).map(d => d.name))
  const inScope       = (t) => liveNames.has(t) && pristineNames.has(t)

  const changedTriggers = []
  for (const [name, p] of Object.entries(pristineTrigs)) {
    if (!inScope(p.table)) continue
    const l = liveTrigs[name]
    if (rebuilding.has(p.table) || !l || normaliseTriggerSql(l.sql) !== normaliseTriggerSql(p.sql))
      changedTriggers.push({ name, table: p.table, sql: p.sql })
  }
  const droppedTriggers = Object.entries(liveTrigs)
    .filter(([name, l]) => !pristineTrigs[name] && OWNED_TRIGGER.test(name) &&
                           inScope(l.table) && !rebuilding.has(l.table))
    .map(([name, l]) => ({ name, table: l.table }))

  // A rebuild drops the table, and a trigger the app wrote exists only in the
  // live database — there is nothing to restate it from. Litestone does not
  // support carrying one through a rebuild (FJS-183); what it can do is say so
  // where the author will read it, rather than let a behaviour disappear.
  //
  // A VIEW is not in that class, and must not be treated as if it were: a view
  // is a stored SELECT with no state and no side effects, so it can be dropped
  // and recreated verbatim. Left in place it does not merely disappear — it
  // takes the whole migration down, because `ALTER TABLE … RENAME` reparses
  // every view in the schema and one pointing at the table just dropped is an
  // error. A model carrying a `view` over it was un-rebuildable.
  const viewsOn = (table) => {
    // Over-approximate on purpose: dropping and recreating a view that did not
    // need it costs nothing, and missing one costs the migration.
    const re = new RegExp(`\\b${table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    return Object.entries(liveViews)
      .filter(([, v]) => re.test(v.sql.replace(/"/g, ' ')))
  }
  const changedViewNames = new Set(changedViews.map(v => v.name))

  for (const d of tableDiffs) {
    if (!d.needsRebuild) continue
    d.foreignTriggers = Object.entries(liveTrigs)
      .filter(([name, l]) => l.table === d.name && !OWNED_TRIGGER.test(name))
      .map(([name]) => name)

    const dependent = viewsOn(d.name)
    d.dropViews = dependent.map(([name]) => name)
    // A view the schema is redefining anyway is recreated at the end of the
    // migration from its NEW body. Restating the old one in between would fail
    // where the rebuild is what the new body accounts for.
    d.restoreViews = dependent
      .filter(([name]) => !changedViewNames.has(name))
      .map(([name, v]) => ({ name, sql: v.sql }))
  }

  return {
    newTables,
    newMatViews,
    newViews,
    changedViews,
    droppedTables,
    tableDiffs,
    changedTriggers,
    droppedTriggers,
    hasChanges: newTables.length > 0 || newMatViews.length > 0 ||
                newViews.length > 0   || changedViews.length > 0 ||
                droppedTables.length  > 0 || tableDiffs.length > 0 ||
                changedTriggers.length > 0 || droppedTriggers.length > 0,
  }
}

// ─── SQL generation ───────────────────────────────────────────────────────────

// The next statement after the copy is `DROP TABLE`, so a copy that lost rows
// destroys them one line later and reports success. Nothing above SQLite is
// watching: the runner executes statements, and a smaller row count is not an
// error to any of them.
//
// SQLite has no assertion — `RAISE()` is legal only inside a trigger body — so
// the comparison is written as a CHECK on a temp table that holds exactly one
// row. The constraint NAME is the message, because that is what SQLite prints:
// `CHECK constraint failed: rebuild of order lost rows`. It aborts the
// statement, the runner's transaction rolls back, and the old table is still
// there.
//
// Emitted even when nothing is copied — a rebuild sharing no column with the
// old table is precisely the case that empties it in silence today.
function rowCountGuard(tableName, tmp) {
  return [
    `-- the copy must not have lost rows — the next statement drops the original`,
    `CREATE TEMP TABLE "_litestone_rowcount" (`,
    `  ok INTEGER CONSTRAINT "rebuild of ${tableName} lost rows" CHECK (ok = 1)`,
    `);`,
    `INSERT INTO "_litestone_rowcount" (ok)`,
    `  SELECT CASE WHEN (SELECT count(*) FROM "${tmp}") = (SELECT count(*) FROM "${tableName}") THEN 1 ELSE 0 END;`,
    `DROP TABLE "_litestone_rowcount";`,
    ``,
  ]
}

function rebuildSQL(model, parseResult, pluralize = false, diff = null) {
  // Must match createTable's physical columns exactly — implicit m2m and @edge
  // fields have no host column, so they can't appear in the INSERT ... SELECT.
  const targetFields   = model.fields.filter(f =>
    f.type.kind !== 'relation' &&
    f.type.kind !== 'implicitM2M' &&
    !f.attributes.find(a => a.kind === 'edge')
  )
  const targetColNames = targetFields.map(f => f.name)
  const tableName      = modelToTableName(model, pluralize)
  const tmp            = `${tableName}__new`

  // Copy only columns the OLD table also has. A column that is being ADDED in
  // this rebuild must not appear in the SELECT: SQLite resolves an unknown
  // double-quoted identifier as a string literal, so `SELECT "bio" FROM old`
  // doesn't error — it writes the literal 'bio' into every row (or fails the
  // whole copy when the target column's type rejects TEXT). Omitting added
  // columns lets their DEFAULT (or NULL) fill them.
  const addedNames = new Set((diff?.cols?.added ?? []).map(c => c.name))
  const copyNames  = targetColNames.filter(n => !addedNames.has(n))
  const copyCols   = copyNames.map(n => `"${n}"`).join(', ')

  const fullDDL   = generateTableDDL(model, parseResult.schema, { pluralize })
  const isStrict  = fullDDL.trimEnd().endsWith('STRICT;')
  const bodyMatch = fullDDL.match(/\(\n([\s\S]+)\n\)(?: STRICT)?;/)
  const body      = bodyMatch ? bodyMatch[1] : '  -- see schema.lite'

  const lines = []
  lines.push(`-- rebuild "${tableName}" — full table reconstruction required`)
  lines.push(`CREATE TABLE "${tmp}" (`)
  lines.push(body)
  lines.push(isStrict ? `) STRICT;` : `);`)
  lines.push(``)
  if (copyNames.length) {
    lines.push(`INSERT INTO "${tmp}" (${copyCols})`)
    lines.push(`  SELECT ${copyCols} FROM "${tableName}";`)
  } else {
    lines.push(`-- no columns shared with the old table — nothing to copy`)
  }
  lines.push(``)
  lines.push(...rowCountGuard(tableName, tmp))
  lines.push(`DROP TABLE "${tableName}";`)
  lines.push(`ALTER TABLE "${tmp}" RENAME TO "${tableName}";`)
  return lines.join('\n')
}

export function generateMigrationSQL(diffResult, parseResult, { pluralize = false } = {}) {
  const { newTables, newMatViews, newViews, changedViews, droppedTables, tableDiffs,
          changedTriggers, droppedTriggers } = diffResult
  const lines = []

  lines.push(`PRAGMA foreign_keys = OFF;`)
  lines.push(`BEGIN;`)
  lines.push(``)

  // Implicit m2m join tables are invisible to introspection (underscore
  // prefix), so the diff never lists them — emit them unconditionally with
  // IF NOT EXISTS so adding an m2m to an existing DB creates its join table.
  {
    const pairs = detectM2MPairs(parseResult.schema, pluralize)
    if (pairs.length) {
      lines.push(`-- ─── implicit m2m join tables (idempotent) ${'─'.repeat(24)}`)
      for (const pair of pairs) lines.push(generateJoinTableDDL(pair, true))
      lines.push(``)
    }
  }

  if (newTables.length) {
    lines.push(`-- ─── new tables ${'─'.repeat(52)}`)
    lines.push(``)
    for (const model of newTables) {
      if (model.comments?.length)
        lines.push(model.comments.map(c => `-- ${c}`).join('\n'))
      lines.push(generateTableDDL(model, parseResult.schema, { pluralize }))
      const idxSQL = generateIndexDDL(model, false, { pluralize })
      if (idxSQL.length) lines.push(idxSQL.join('\n'))
      lines.push(``)
    }
  }

  if (newMatViews?.length) {
    lines.push(`-- ─── new materialized views ${'─'.repeat(40)}`)
    lines.push(``)
    for (const view of newMatViews) {
      lines.push(generateViewDDL(view))
      lines.push(``)
    }
  }

  if (droppedTables.length) {
    lines.push(`-- ─── dropped tables ${'─'.repeat(48)}`)
    lines.push(`-- These tables exist in the db but not in schema.lite.`)
    lines.push(`-- Uncomment to drop them (destructive — data will be lost):`)
    lines.push(``)
    for (const name of droppedTables)
      lines.push(`-- DROP TABLE IF EXISTS "${name}";`)
    lines.push(``)
  }

  if (tableDiffs.length) {
    lines.push(`-- ─── modified tables ${'─'.repeat(47)}`)
    lines.push(``)

    for (const d of tableDiffs) {
      // d.name is a SQL table name (snake_case). Match against the pristine
      // model's derived table name — m.name is PascalCase and won't equal d.name
      // under the PascalCase model convention.
      const model = parseResult.schema.models.find(m => modelToTableName(m, pluralize) === d.name)

      if (d.needsRebuild) {
        // A rebuild that ADDS a NOT NULL column with no DEFAULT has no value
        // to give existing rows — same rule as blockedAdds on the ALTER path.
        // Emit the whole rebuild commented out with the fix options instead
        // of generating SQL that destroys or corrupts the table.
        const blocked = (d.cols?.added ?? []).filter(c => c.notnull && c.default == null)
        if (blocked.length) {
          lines.push(`-- "${d.name}": rebuild BLOCKED — adds NOT NULL column(s) with no DEFAULT:`)
          for (const c of blocked) lines.push(`--     ${c.name} ${c.type}`)
          lines.push(`-- Existing rows have no value for them. Fix one of:`)
          lines.push(`--   • add a @default() to the field, or make it optional (?)`)
          lines.push(`--   • hand-write the copy below with a value expression for each blocked column`)
          lines.push(`--   • if the table is empty, uncomment the rebuild as-is`)
          lines.push(rebuildSQL(model, parseResult, pluralize, d).split('\n').map(l => `-- ${l}`).join('\n'))
          lines.push(``)
          continue
        }

        // Said before the SQL, because after it the objects are already gone.
        const lost = [
          ...(d.foreignTriggers ?? []).map(n => `trigger "${n}"`),
          ...(d.indexes.foreign ?? []).map(i => `index "${i.name}"`),
        ]
        if (lost.length) {
          lines.push(`-- "${d.name}": this rebuild DROPS the table, which destroys:`)
          for (const l of lost) lines.push(`--     ${l}`)
          lines.push(`-- Litestone did not create these and cannot restate them — recreate`)
          lines.push(`-- them below, or in a JS migration that runs after this file.`)
        }
        // Out of the way before the rename, which reparses every view.
        if (d.dropViews?.length) {
          lines.push(`-- "${d.name}": views over it, dropped for the rebuild and restored after`)
          for (const v of d.dropViews) lines.push(`DROP VIEW IF EXISTS "${v}";`)
          lines.push(``)
        }
        lines.push(rebuildSQL(model, parseResult, pluralize, d))
        lines.push(``)
        const idxSQL = generateIndexDDL(model, false, { pluralize })
        if (idxSQL.length) {
          lines.push(`-- recreate indexes for "${d.name}"`)
          lines.push(idxSQL.join('\n'))
          lines.push(``)
        }
        for (const v of d.restoreViews ?? []) {
          lines.push(v.sql.trim().replace(/;?$/, ';'))
          // SQLite does not resolve a view body at CREATE time, so a view over a
          // column this rebuild just dropped is recreated happily and fails only
          // when something selects from it — in production, months later. Read
          // zero rows from it here instead: inside the migration's transaction,
          // so a view the schema change invalidated rolls the whole thing back.
          lines.push(`SELECT 1 FROM "${v.name}" LIMIT 0;`)
        }
        if (d.restoreViews?.length) lines.push(``)
        continue
      }

      if (d.simpleAdds.length) {
        lines.push(`-- "${d.name}": add columns`)
        for (const col of d.simpleAdds) {
          const notNull = col.notnull && col.default !== null ? ` NOT NULL` : ``
          const def     = col.default !== null ? ` DEFAULT ${col.default}` : ``
          lines.push(`ALTER TABLE "${d.name}" ADD COLUMN "${col.name}" ${col.type}${notNull}${def};`)
        }
        lines.push(``)
      }

      if (d.blockedAdds.length) {
        lines.push(`-- "${d.name}": blocked columns — NOT NULL with no DEFAULT`)
        lines.push(`-- Fix: make optional (?), add a @default(), or do a manual rebuild.`)
        for (const col of d.blockedAdds)
          lines.push(`-- ALTER TABLE "${d.name}" ADD COLUMN "${col.name}" ${col.type} NOT NULL;  -- BLOCKED`)
        lines.push(``)
      }

      if (d.indexes.dropped.length) {
        lines.push(`-- "${d.name}": drop stale indexes`)
        for (const idx of d.indexes.dropped)
          lines.push(`DROP INDEX IF EXISTS "${idx.name}";`)
        lines.push(``)
      }

      if (d.indexes.added.length) {
        lines.push(`-- "${d.name}": add indexes`)
        for (const idx of d.indexes.added) {
          const u    = idx.unique ? 'UNIQUE ' : ''
          const cols = idx.cols.map(c => `"${c}"`).join(', ')
          lines.push(`CREATE ${u}INDEX IF NOT EXISTS "${idx.name}" ON "${d.name}" (${cols});`)
        }
        lines.push(``)
      }
    }
  }

  if (newViews?.length) {
    lines.push(`-- ─── new views ${'─'.repeat(54)}`)
    lines.push(``)
    for (const view of newViews) {
      lines.push(generateViewDDL(view))
      lines.push(``)
    }
  }

  if (changedViews?.length) {
    lines.push(`-- ─── changed views (drop + recreate) ${'─'.repeat(31)}`)
    lines.push(``)
    for (const view of changedViews) {
      lines.push(`DROP VIEW IF EXISTS "${view.name}";`)
      lines.push(generateViewDDL(view))
      lines.push(``)
    }
  }

  if (changedTriggers?.length || droppedTriggers?.length) {
    lines.push(`-- ─── generated triggers (drop + recreate) ${'─'.repeat(26)}`)
    lines.push(``)
    for (const t of droppedTriggers ?? []) lines.push(`DROP TRIGGER IF EXISTS "${t.name}";`)
    for (const t of changedTriggers ?? []) {
      lines.push(`DROP TRIGGER IF EXISTS "${t.name}";`)
      lines.push(t.sql.trim().replace(/;?$/, ';'))
    }
    lines.push(``)
  }

  lines.push(`COMMIT;`)
  lines.push(`PRAGMA foreign_keys = ON;`)

  return lines.join('\n')
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export function summariseDiff(diffResult) {
  if (!diffResult.hasChanges) return '✓ schema is in sync — no changes needed'

  const lines = []

  for (const m of diffResult.newTables)
    lines.push(`  + ${m.name}  (new table)`)

  for (const n of diffResult.droppedTables)
    lines.push(`  ? ${n}  (in db, not in schema)`)

  for (const d of diffResult.tableDiffs) {
    lines.push(`  ~ ${d.name}  ${d.needsRebuild ? '[rebuild]' : '[alter]'}`)
    for (const c of d.cols.added)
      lines.push(`      + col  ${c.name} ${c.type}${c.notnull && !c.default ? '  ⚠ NOT NULL no default' : ''}`)
    for (const c of d.cols.dropped)
      lines.push(`      - col  ${c.name}`)
    for (const c of d.cols.modified)
      for (const ch of c.changes)
        lines.push(`      ~ col  ${c.name}  ${ch.field}: ${JSON.stringify(ch.from)} → ${JSON.stringify(ch.to)}`)
    if (d.fkChanged)     lines.push(`      ~ foreign keys changed`)
    if (d.strictChanged) lines.push(`      ~ strict mode changed`)
    for (const i of d.indexes.added)
      lines.push(`      + idx  (${i.cols.join(', ')})`)
    for (const i of d.indexes.dropped)
      lines.push(`      - idx  ${i.name}`)
  }

  for (const t of diffResult.changedTriggers ?? [])
    lines.push(`  ~ ${t.table}  trigger ${t.name}  (recreate)`)
  for (const t of diffResult.droppedTriggers ?? [])
    lines.push(`  - ${t.table}  trigger ${t.name}  (retired)`)

  return lines.join('\n')
}

// ─── Checksum ─────────────────────────────────────────────────────────────────

export function checksum(str) {
  return createHash('sha256').update(str).digest('hex').slice(0, 16)
}
