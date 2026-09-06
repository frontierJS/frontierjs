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
//                  change PK, change FK, change CHECK, change @@noStrict,
//                  add/drop/reorder a UNIQUE the table declares itself

import { generateDDL, generateDDLForDatabase, generateTableDDL, generateIndexDDL, generateModelDDL, generateViewDDL, modelToTableName , detectM2MPairs, generateJoinTableDDL, isStoredField } from './ddl.js'
import { createHash } from 'crypto'

// ─── Introspect ───────────────────────────────────────────────────────────────
// Works on any db handle with .prepare() (Bun Database).
// Returns: { tableName: { columns, indexes, foreignKeys, strict, checks, uniques } }

// Underscore prefix = machinery tables: _litestone_*, implicit-m2m join tables
// (_task_user, _members, _TagToTag), matching Prisma's convention.
const INTERNAL = /^(_|sqlite_|.*_fts$|.*_fts_data$|.*_fts_idx$|.*_fts_content$|.*_fts_docsize$|.*_fts_config$)/

// Every column's generation expression, read off the table's own CREATE
// statement — the only place SQLite keeps it. Neither `table_info` nor
// `table_xinfo` carries it, so without this a changed expression is invisible
// and the two schemas compare equal.
//
// Splitting at depth-0 commas rather than matching a column pattern is what
// makes an expression holding a comma or a paren safe. A miss here is safe by
// construction: the caller only asks about columns the pragma has already said
// are generated, and answers `null` for an expression it could not read, which
// the diff treats as "cannot judge" rather than as "changed".

// Walks `sql` from `i`, returning the index one past the first depth-0
// character in `stop` — respecting nesting and every quote SQLite accepts,
// which is the whole reason this is a walk and not a regex.
function scanTo(sql, i, stop) {
  let depth = 0, quote = null
  for (; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      if (ch !== quote) continue
      if (quote !== ']' && sql[i + 1] === quote) i++   // '' and "" escape themselves
      else quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch;  continue }
    if (ch === '[')                             { quote = ']'; continue }
    if (ch === '(') { depth++; continue }
    if (ch === ')' && depth > 0) { depth--; continue }
    if (depth === 0 && stop.includes(ch)) return i
  }
  return sql.length
}

export function parseGeneratedColumns(sql) {
  const out  = new Map()
  const open = sql ? sql.indexOf('(') : -1
  if (open === -1) return out

  // The column list, one top-level entry at a time. Table constraints land in
  // here too and simply never match the generated form.
  const parts = []
  for (let i = open + 1; i < sql.length; ) {
    const end = scanTo(sql, i, ',)')
    parts.push(sql.slice(i, end))
    if (sql[end] !== ',') break
    i = end + 1
  }

  for (const part of parts) {
    const name = part.trim().match(/^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\w+))/)
    if (!name) continue
    // `GENERATED ALWAYS` is optional in SQLite — `x AS (expr)` is the same column.
    const at = /\b(?:GENERATED\s+ALWAYS\s+)?AS\s*\(/i.exec(part)
    if (!at) continue
    const from = at.index + at[0].length
    const to   = scanTo(part, from, ')')
    if (to < part.length)
      out.set(name[1] ?? name[2] ?? name[3] ?? name[4], part.slice(from, to).trim())
  }

  return out
}

/**
 * Every CHECK constraint in a CREATE TABLE, normalized for comparison.
 *
 * SQLite stores the CREATE statement verbatim and offers no pragma for
 * constraints, so the text is the only place they exist. Both sides of the
 * diff come through here — `buildPristine` executes today's DDL into a scratch
 * database and introspects that — so what is compared is one emitter's output
 * against another's, which is why a normalized string is enough and an
 * expression parser is not.
 *
 * Column-level and table-level alike: a `CHECK` inside a column's definition
 * and one standing on its own are the same constraint to SQLite, and litestone
 * emits an enum's as the first and an array's as the second.
 *
 * Sorted, because a constraint moving position is not a constraint changing.
 */
export function parseChecks(sql) {
  const out  = []
  const open = sql ? sql.indexOf('(') : -1
  if (open === -1) return out

  // The same top-level walk `parseGeneratedColumns` does — one column or table
  // constraint at a time, with quotes and nesting respected.
  const parts = []
  for (let i = open + 1; i < sql.length; ) {
    const end = scanTo(sql, i, ',)')
    parts.push(sql.slice(i, end))
    if (sql[end] !== ',') break
    i = end + 1
  }

  for (const part of parts) {
    const at = /\bCHECK\s*\(/i.exec(part)
    if (!at) continue
    const from = at.index + at[0].length
    const to   = scanTo(part, from, ')')
    out.push(part.slice(from, to).replace(/\s+/g, ' ').trim())
  }

  return out.sort()
}

// The uniqueness a CREATE TABLE declares itself — `UNIQUE ("a", "b")` as a table
// constraint, `UNIQUE` inside a column definition, and a composite PRIMARY KEY.
//
// None of it reaches the index diff. SQLite builds an implicit index for each,
// and an implicit index has NULL `sql` in `sqlite_master`, which is exactly what
// the index read above filters on — so for as long as this file has existed,
// ADDING a `@@unique`, removing one, or reordering its columns produced no diff
// at all. The first two are the sharp ones: the schema declares a constraint the
// live table does not enforce, `UniqueConflictError` never fires, and the
// duplicate lands (`FJS-596`). Reordering is the performance half — the implicit
// index is prefix-matched like any other, so `(orgId, createdAt)` answers
// `WHERE orgId = ?` and the swap does not (`FJS-592`'s fact, one constraint kind
// along).
//
// Read from the pragma rather than parsed out of the CREATE statement, because
// there is one here and it answers the column ORDER directly — the same reason
// `generated` is taken from `table_xinfo` and CHECK is not. `origin` separates
// the three: `c` is an explicit CREATE INDEX, which the index diff already owns
// and must not see twice; `u` is a UNIQUE constraint in either spelling, so
// `@unique` on a column and `@@unique([thatColumn])` compare equal, which is
// right — SQLite builds the same index for both and moving between the two
// spellings changes nothing; `pk` is a composite primary key, whose column order
// is prefix-matched the same way and was invisible for the same reason.
//
// Sorted, so a constraint moving position in the CREATE TABLE is not a
// constraint changing — the rule `parseChecks` already follows.
function tableUniques(db, table) {
  return db.prepare(`PRAGMA index_list("${table}")`).all()
    .filter(r => r.origin === 'u' || r.origin === 'pk')
    .map(r => ({
      origin: r.origin,
      cols:   db.prepare(`PRAGMA index_info("${r.name}")`).all().map(c => c.name),
    }))
    .sort((a, b) => uniqueKey(a).localeCompare(uniqueKey(b)))
}

/** What makes two declared constraints the same one — the kind, and the columns IN ORDER. */
const uniqueKey = (u) => `${u.origin}:${u.cols.join(',')}`

/** …and how it reads in a plan. */
const constraintLabel = (u) => `${u.origin === 'pk' ? 'PRIMARY KEY' : 'UNIQUE'} (${u.cols.join(', ')})`

export function introspect(db) {
  const schema = {}

  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all()
    .map(r => r.name)
    .filter(n => !INTERNAL.test(n))

  for (const t of tables) {
    const { sql: tblSql } = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`
    ).get(t) ?? { sql: '' }

    // `PRAGMA table_info` OMITS generated columns, so a diff built on it is
    // blind to them in both directions: the schema declares one, the live
    // database has one, and neither side can see the other's. Adding, dropping
    // or changing the expression of a generated column emitted an empty
    // migration (FJS-407). `table_xinfo` is the same pragma that lists them —
    // `hidden` 2 = VIRTUAL, 3 = STORED — and 1 is a virtual table's own hidden
    // column, which is not a column any schema declares.
    const generated = parseGeneratedColumns(tblSql)

    const columns = db.prepare(`PRAGMA table_xinfo("${t}")`).all()
      .filter(r => r.hidden !== 1)
      .map(r => ({
        name:    r.name,
        type:    (r.type || 'TEXT').toUpperCase(),
        notnull: !!r.notnull,
        pk:      !!r.pk,
        default: r.dflt_value ?? null,
        // The pragma says WHETHER a column is generated; only the CREATE
        // statement says from what. The pragma is the authority — a column is
        // never treated as generated because the text parse thought so.
        generated: r.hidden === 2 || r.hidden === 3
          ? { mode: r.hidden === 3 ? 'stored' : 'virtual', expr: generated.get(r.name) ?? null }
          : null,
      }))

    const indexes = db.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`
    ).all(t).map(r => {
      const unique = /CREATE UNIQUE INDEX/i.test(r.sql)
      const cols   = parseIndexColumns(r.sql)
      const sorts  = parseIndexSorts(r.sql)
      return { name: r.name, cols, sorts, unique, where: indexPredicate(r.sql) }
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

    const strict = /\)\s*STRICT\s*;?\s*$/i.test(tblSql)
    const checks = parseChecks(tblSql)

    schema[t] = { columns, indexes, foreignKeys, strict, checks, uniques: tableUniques(db, t) }
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

  // Everything above reads a NAMED dimension. This reads the statements whole,
  // so the residue tripwire below has something to compare that no reader here
  // had to remember to write. An object SQLite keeps no statement for — an
  // implicit index behind a UNIQUE constraint — is not one anybody declared
  // either; `tableUniques` is what reads those.
  // Stored RAW and normalized only where two of them disagree: measured on the
  // 188-model fixture, normalizing here costs 18 ms of a 75 ms introspection
  // and every object it touches is one that then compares equal anyway.
  schema.__sql = {}
  for (const r of db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master`).all()) {
    if (INTERNAL.test(r.name) || r.sql == null) continue
    schema.__sql[`${r.type}:${r.name}`] = { table: r.tbl_name, sql: r.sql }
  }

  return schema
}

// Two CREATE statements are the same statement when SQLite would build the same
// object from them. `ALTER TABLE ADD COLUMN` appends the column text to the
// stored statement in the spacing the ALTER used, so a table that migrated
// perfectly still differs from the pristine one by a space before the closing
// bracket — measured at 162 of 694 objects across the corpus schemas, every one
// of them spacing and not one of them a difference. Whitespace around
// punctuation therefore comes out on both sides.
//
// What this cannot tell apart is two statements differing only by whitespace
// INSIDE a string literal. Nothing here emits one, and the alternative is a SQL
// parser standing behind a tripwire whose whole value is not needing one.
export function normaliseDdl(sql) {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/IF NOT EXISTS /gi, '')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim()
}

// Two trigger definitions are the same trigger when SQLite would build the same
// thing from them. `IF NOT EXISTS` is stripped because buildPristine strips it
// on the way in, so the pristine side never carries it and the live side does.
// The column list of a CREATE INDEX, split on TOP-LEVEL commas.
//
// It was `sql.match(/\(([^)]+)\)/)` in two places — here and in
// `transform/framework.js` — which stops at the first `)` it meets, so an index
// over an expression read as one column called `lower(a` (FJS-584). Harmless
// while nothing could declare one, and wrong in both copies of it.
//
// Not a SQL parser: a string literal holding a bracket inside an expression
// would still fool the depth count. It is a column list, so that is a shape
// nothing in this repo can emit and a converter reading one is told rather than
// guessed at — `isIndexExpression` is how the caller sees it is not a name.
export function parseIndexColumns(sql) {
  return rawIndexMembers(sql)
    .map(c => stripSort(c.trim()).member.replace(/^["'`]|["'`]$/g, ''))
    .filter(Boolean)
}

// A member's trailing direction, taken off before the quotes are. Without this
// `"createdAt" DESC` de-quotes to `createdAt" DESC`, which `isIndexExpression`
// then reports as an expression — the FJS-584 shape, one modifier along.
function stripSort(raw) {
  const m = /^([\s\S]+?)\s+(ASC|DESC)$/i.exec(raw)
  return m ? { member: m[1].trim(), sort: m[2].toUpperCase() } : { member: raw, sort: null }
}

// The members of a CREATE INDEX's column list, split on TOP-LEVEL commas and
// otherwise untouched. One owner, because the names and the directions are read
// off the same list and a second split is how the two end up misaligned.
function rawIndexMembers(sql) {
  const on = /\sON\s/i.exec(sql ?? '')
  if (!on) return []

  // Step over the table name before looking for the list, because a QUOTED one
  // may hold a bracket of its own and `indexOf('(')` would find that instead.
  let i = on.index + on[0].length
  while (i < sql.length && /\s/.test(sql[i])) i++
  const quote = { '"': '"', "'": "'", '`': '`', '[': ']' }[sql[i]]
  if (quote) { i++; while (i < sql.length && sql[i] !== quote) i++; i++ }

  const open = sql.indexOf('(', i)
  if (open < 0) return []

  let depth = 0, end = -1
  for (let j = open; j < sql.length; j++) {
    if (sql[j] === '(') depth++
    else if (sql[j] === ')' && --depth === 0) { end = j; break }
  }
  if (end < 0) return []

  const out = []
  let cur = '', d = 0
  for (const ch of sql.slice(open + 1, end)) {
    if (ch === '(') d++
    else if (ch === ')') d--
    if (ch === ',' && d === 0) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out
}

// The directions of a CREATE INDEX's columns, aligned with parseIndexColumns.
// Its own function rather than a second return value, because three callers
// walk that list expecting names and a shape change would reach all of them.
export function parseIndexSorts(sql) {
  return rawIndexMembers(sql).map(m => stripSort(m.trim()).sort)
}

// ─── A SQL index predicate → the .lite expression meaning the same thing ──────
//
// One owner, because THREE converters ask it: `litestone introspect` reading a
// live database, and the `sql` and `rails` readers behind `litestone import`.
// They disagreed for a few hours and that is the whole of FJS-590 — the same
// question answered twice, and one of the answers older than the feature.
//
// Only the shapes `@@index(where:)` accepts — a null test and a boolean —
// because those are the only ones a partial index can be REACHED by. Anything
// else answers null and the caller says what it dropped rather than guessing at
// it, which is the whole difference between a converter and a liar.
//
// Mixed AND/OR at one level answers null too: emitting it would be a precedence
// judgement, and getting that wrong changes which rows the index holds.
export function stripParens(t) {
  let s = t.trim()
  while (s.startsWith('(') && s.endsWith(')')) {
    let d = 0, whole = true
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') d++
      else if (s[i] === ')' && --d === 0 && i < s.length - 1) { whole = false; break }
    }
    if (!whole) break
    s = s.slice(1, -1).trim()
  }
  return s
}

function splitTop(text, word) {
  const parts = []
  const re = new RegExp(`\\b${word}\\b`, 'gi')
  let d = 0, last = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') d++
    else if (text[i] === ')') d--
    else if (d === 0) {
      re.lastIndex = i
      const m = re.exec(text)
      if (m && m.index === i) { parts.push(text.slice(last, i)); last = i + m[0].length; i = last - 1 }
    }
  }
  parts.push(text.slice(last))
  return parts.map(p => p.trim()).filter(Boolean)
}

export function predicateToLite(where, nameOf, { values = false } = {}) {
  const atom = t => {
    const x = stripParens(t)
    let m
    if ((m = /^"?([A-Za-z_]\w*)"?\s+IS\s+NOT\s+NULL$/i.exec(x))) return `${nameOf(m[1])} != null`
    if ((m = /^"?([A-Za-z_]\w*)"?\s+IS\s+NULL$/i.exec(x)))       return `${nameOf(m[1])} == null`
    // A comparison against a VALUE, for the one caller that can hold one.
    // `@@index(where:)` refuses these at parse — a partial index over a bound
    // value is matched by nothing — so emitting one there would write a .lite
    // this parser will not read, which is the fixed-point rule (FJS-594).
    // `@@unique(where:)` accepts them, because enforcement never consults the
    // planner, and `WHERE status = 'active'` is the second-commonest partial
    // unique there is.
    if (values) {
      if ((m = /^"?([A-Za-z_]\w*)"?\s*=\s*'((?:[^']|'')*)'$/.exec(x)))
        return `${nameOf(m[1])} == "${m[2].replace(/''/g, "'").replace(/(["\\])/g, '\\$1')}"`
      if ((m = /^"?([A-Za-z_]\w*)"?\s*(=|<>|!=|>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(x)))
        return `${nameOf(m[1])} ${m[2] === '=' ? '==' : m[2] === '<>' ? '!=' : m[2]} ${m[3]}`
    }
    // SQLite spells a boolean 1/0 and Postgres spells it true/false, and both
    // reach here — the first from a live database, the second from a dump the
    // importer is reading. A BARE column (`WHERE live`, legal in Postgres) is
    // deliberately not accepted: it is only a boolean if the column is one, and
    // that is a guess about a type this function is not given.
    if ((m = /^"?([A-Za-z_]\w*)"?\s*=\s*(1|true)$/i.exec(x)))     return `${nameOf(m[1])} == true`
    if ((m = /^"?([A-Za-z_]\w*)"?\s*=\s*(0|false)$/i.exec(x)))    return `${nameOf(m[1])} == false`
    return null
  }
  const body = stripParens(where ?? '')
  if (!body) return null

  const ands = splitTop(body, 'AND')
  const ors  = splitTop(body, 'OR')
  if (ands.length > 1 && ors.length > 1) return null   // precedence is not ours to decide

  const parts = ands.length > 1 ? ands : ors
  const join  = ands.length > 1 ? ' && ' : ' || '
  const out   = parts.map(atom)
  return out.every(Boolean) ? out.join(parts.length > 1 ? join : '') : null
}

// Is this member an expression rather than a column name? A converter has to
// know, because there is no `.lite` spelling for one.
export function isIndexExpression(member) {
  return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(member)
}

// A partial index's predicate is part of what the index IS. It was dropped on
// the floor here, so a partial index and a full one over the same columns
// compared equal and a changed predicate migrated nothing — while litestone
// already emits partial indexes for every @@softDelete model (FJS-576).
//
// Both sides of the comparison are this package's own emit, which is what makes
// a text match exact — the same property parseChecks relies on for CHECK.
//
// The first `)` followed by WHERE closes the column list: a column list cannot
// contain one, and a predicate cannot be followed by a second WHERE.
export function indexPredicate(sql) {
  const m = /\)\s*WHERE\s+([\s\S]+?)\s*;?\s*$/i.exec(sql ?? '')
  return m ? m[1].replace(/\s+/g, ' ').trim() : null
}

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

// A column becoming generated, stopping being generated, changing storage or
// changing its expression are all one thing to SQLite: no ALTER reaches any of
// them, so each is a rebuild. An expression neither side could read compares
// equal — a rebuild nobody asked for is worse than a diff that says nothing,
// and the pragma has already settled the part that matters.
const sameExpr = (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

function generatedChange(live, target) {
  if (!live && !target) return null
  if (!live || !target)
    return { field: 'generated', from: live?.mode ?? null, to: target?.mode ?? null }
  if (live.mode !== target.mode)
    return { field: 'generated', from: live.mode, to: target.mode }
  if (live.expr && target.expr && !sameExpr(live.expr, target.expr))
    return { field: 'generated', from: live.expr, to: target.expr }
  return null
}

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
      const g = generatedChange(live.generated, col.generated)
      if (g) changes.push(g)
      if (changes.length) modified.push({ name: col.name, changes })
    }
  }

  for (const col of liveCols) {
    if (!pm.has(col.name)) dropped.push(col)
  }

  return { added, dropped, modified }
}

// ─── Index diff ───────────────────────────────────────────────────────────────

/** Two sorted string lists, compared. */
function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

// What makes two indexes the same index — the columns IN ORDER, their
// directions, uniqueness and the partial predicate.
//
// The order is the whole of it. A composite index is prefix-matched, so
// `@@index([a, b])` answers `WHERE a = ?` and `@@index([b, a])` does not; they
// serve different queries and are different indexes. This compared them as a
// SET, so swapping two columns was a real schema change that reported as no
// change at all (FJS-592). The direction is the same fact one column along —
// SQLite walks a b-tree either way for a single column, so a direction only
// ever matters on a composite whose columns disagree (FJS-591).
//
// What it costs is one DROP INDEX + CREATE INDEX, on the next migration, for a
// database whose live column order differs from what the schema declares. That
// is not a table rebuild, and it is the right outcome anyway: the order in
// `sqlite_master` is the order the index is actually walked in, so a difference
// there means the live index is not the one the schema asks for. The same
// argument the CHECK comparison below makes about an emitter that spelled a
// constraint differently.
function indexKey(idx) {
  const cols = idx.sorts?.some(Boolean)
    ? idx.cols.map((c, i) => `${c}${idx.sorts[i] ? ` ${idx.sorts[i]}` : ''}`)
    : idx.cols
  return `${idx.unique ? 'u' : ''}:${cols.join(',')}:${idx.where ?? ''}`
}

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
//
// TWO prefixes, because a partial `@@unique` is a `CREATE UNIQUE INDEX` and
// takes `uniq_<table>_<fields>` so that it can coexist with an `@@index` over
// the same columns (`FJS-614`). Both are litestone's.
const ownedIndex = (name, table) =>
  name.startsWith(`idx_${table}_`) || name.startsWith(`uniq_${table}_`)

function diffIndexes(pristineIdxs, liveIdxs, table) {
  const pm = new Map(pristineIdxs.map(i => [indexKey(i), i]))
  const lm = new Map(liveIdxs.map(i => [indexKey(i), i]))

  // A pair that matches on shape and differs on NAME is one litestone renamed:
  // the name is derived, so a difference means this build derives it
  // differently than the build that wrote the database. It is a drop and a
  // create, which is what any other index change costs.
  //
  // The name is deliberately NOT part of `indexKey`. A HAND-MADE index of the
  // same shape under another name matches today and is left alone; keying on
  // the name would make it `foreign` and create litestone's beside it, so a
  // database would carry two identical indexes and pay for both on every write.
  // `ownedIndex` is what separates the two cases, and it is asked of the LIVE
  // name — the one litestone would be dropping.
  // Grouped rather than looked up in `lm`, which keeps one entry per key: a
  // database can hold two indexes of one shape (litestone's, and a hand-made
  // copy), and picking whichever landed in the map last would decide a rename
  // on insertion order.
  const byKey = new Map()
  for (const i of liveIdxs) {
    const k = indexKey(i)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(i)
  }
  const renamedLive = []
  const renamed = pristineIdxs.filter(p => {
    const same = byKey.get(indexKey(p)) ?? []
    if (same.some(l => l.name === p.name)) return false      // already the right name
    const owned = same.find(l => ownedIndex(l.name, table))
    if (!owned) return false
    renamedLive.push(owned)
    return true
  })

  return {
    added:   pristineIdxs.filter(i => !lm.has(indexKey(i))).concat(renamed),
    dropped: liveIdxs.filter(i => !pm.has(indexKey(i)) && ownedIndex(i.name, table))
                     .concat(renamedLive),
    foreign: liveIdxs.filter(i => !pm.has(indexKey(i)) && !ownedIndex(i.name, table)),
  }
}

// ─── Declared-uniqueness diff ─────────────────────────────────────────────────

// A table constraint can only change by rebuilding the table — there is no
// ALTER for one — so this is the whole of the cost, and it is why the cheap
// half (`FJS-592`, a reordered `@@index`, one DROP + CREATE) shipped alone.
//
// Measured before it was taken, the way FJS-592 was: the two live databases in
// this repo — `example/db/shops/flagship.db` and `packages/basecamp/db/basecamp.db`
// — each diffed against its own schema with this in place, both zero churn. That is not luck — the emitter writes
// declaration order, so for any database litestone created the live order
// already IS the pristine order, and the only schema that migrates is one whose
// declaration genuinely moved.
function diffUniques(pristineUniques, liveUniques) {
  const pk = new Set(pristineUniques.map(uniqueKey))
  const lk = new Set(liveUniques.map(uniqueKey))
  return {
    added:   pristineUniques.filter(u => !lk.has(uniqueKey(u))),
    dropped: liveUniques.filter(u => !pk.has(uniqueKey(u))),
  }
}

// ─── FK diff ──────────────────────────────────────────────────────────────────

// Both actions. `introspect` has always read `onUpdate` and this dropped it, so
// a relation whose ON UPDATE moved compared equal — the enumeration's seventh
// missed dimension, and the first thing the residue tripwire named. SQLite
// reports NO ACTION for an unstated action on both sides, so an absent
// `onUpdate` and an explicit one that means the same thing still compare equal.
function fkKey(fk) {
  const from = Array.isArray(fk.from) ? fk.from.join(',') : fk.from
  const to   = Array.isArray(fk.to)   ? fk.to.join(',')   : fk.to
  return `${from}→${fk.table}.${to}:${fk.onDelete ?? 'NO ACTION'}/${fk.onUpdate ?? 'NO ACTION'}`
}

function fksEqual(a, b) {
  const ak = new Set(a.map(fkKey))
  const bk = new Set(b.map(fkKey))
  if (ak.size !== bk.size) return false
  for (const k of ak) if (!bk.has(k)) return false
  return true
}

// ─── Full diff ────────────────────────────────────────────────────────────────

const META_KEYS = new Set(['__views', '__triggers', '__sql'])

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

    // ── A CHECK constraint that moved ────────────────────────────────────
    //
    // This file's own header has listed *change CHECK* as a full rebuild since
    // it was written, and nothing compared one: the diff read columns, indexes,
    // foreign keys and STRICT, and a CHECK is on none of those. So every CHECK
    // litestone emits was frozen at CREATE TABLE and never migrated.
    //
    // **An enum gaining a member is the case, and it is the commonest schema
    // change there is.** The new member is emitted into the DDL, the snapshot
    // regenerates, the app boots, and every write of that value is refused at
    // runtime with SQLite's words about a constraint (`FJS-466`).
    //
    // Narrowing is not a fail-open twin, which is worth knowing rather than
    // assuming: litestone's own validator refuses a value the enum no longer
    // declares before any SQL is built, so a removed member stops being
    // writable immediately. Only the widening direction is stuck.
    //
    // Both sides are litestone-generated text read back out of `sqlite_master`,
    // so a string comparison is exact here in a way it would not be for an
    // expression somebody typed. The cost is that a database created by an
    // emitter that spelled a CHECK differently rebuilds once on upgrade, which
    // is the right outcome anyway — it is the rebuild that brings it up to date.
    const checksChanged = !arraysEqual(p.checks ?? [], l.checks ?? [])

    // The same argument one constraint kind along, and the sharper half of it:
    // a CHECK that never migrated refused a write the schema allows, and a
    // UNIQUE that never migrated ALLOWS a write the schema refuses. See
    // `tableUniques`.
    const uniques        = diffUniques(p.uniques ?? [], l.uniques ?? [])
    const uniquesChanged = uniques.added.length > 0 || uniques.dropped.length > 0

    // A generated column ALTERs in only one shape. SQLite refuses `ADD COLUMN`
    // for a STORED one outright — `cannot add a STORED column` — and a VIRTUAL
    // one is fine, but only when the expression could be read: emitting the
    // ALTER without it would add a plain, writable column of the same name.
    //
    // A DEFAULT that is an EXPRESSION is the same shape and cost the app that
    // found it a crash at boot. SQLite allows an expression default in
    // `CREATE TABLE` and refuses one in `ALTER TABLE ADD COLUMN` — it wants a
    // constant there, and `@default(now())` emits
    // `DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`. The ALTER was
    // generated anyway and threw `near "(": syntax error` from inside
    // `autoMigrate`, naming no column and no schema line (`FJS-605`). A rebuild
    // handles it correctly and already does: the copy omits added columns, so
    // the new table's own DEFAULT fills them.
    // Anything that is not a LITERAL. Tested that way round rather than by
    // looking for a leading `(`, because what is compared here is SQLite's own
    // reading of the pristine database and it does not always keep the parens
    // the emitter wrote — so the narrow test passed the check and threw at the
    // ALTER anyway.
    const LITERAL = /^(?:'(?:[^']|'')*'|-?\d+(?:\.\d+)?|NULL|TRUE|FALSE|X'[0-9a-fA-F]*')$/i
    const exprDefault = (c) => typeof c.default === 'string' && !LITERAL.test(c.default.trim())
    const rebuildAdds = cols.added.filter(c =>
      (c.generated && (c.generated.mode === 'stored' || !c.generated.expr)) || exprDefault(c))

    const needsRebuild =
      cols.dropped.length  > 0 ||
      cols.modified.length > 0 ||
      rebuildAdds.length   > 0 ||
      fkChanged            ||
      strictChanged        ||
      checksChanged        ||
      uniquesChanged

    // Cols we can safely ADD COLUMN — nullable, or has a default, not PK.
    // A generated column is neither: it has no default and nothing writes it,
    // so NOT NULL on one is not the trap it is on a plain column.
    const simpleAdds  = needsRebuild ? [] : cols.added.filter(c => !c.pk && (c.generated || !c.notnull || c.default !== null))
    // Cols we can't add automatically — NOT NULL, no default
    const blockedAdds = needsRebuild ? [] : cols.added.filter(c => !c.pk && !c.generated && c.notnull && c.default === null)

    const hasChanges =
      needsRebuild           ||
      simpleAdds.length  > 0 ||
      blockedAdds.length > 0 ||
      indexes.added.length   > 0 ||
      indexes.dropped.length > 0

    if (hasChanges) {
      tableDiffs.push({ name, needsRebuild, simpleAdds, blockedAdds, cols, indexes, fkChanged, strictChanged, checksChanged, uniques, uniquesChanged })
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
  // where the author will read it, rather than let a behavior disappear.
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

  // ── The residue tripwire ────────────────────────────────────────────────
  //
  // Everything above compares an ENUMERATED list of dimensions: columns,
  // indexes, foreign keys, STRICT, CHECKs, table uniques, triggers, views. A
  // dimension nobody added to that list is not reported as different — it is
  // reported as IN SYNC, over a database that is not the declared one, and the
  // history of that is six issues long, each one a dimension arriving in the
  // emitter and not here (generated columns, CHECK, table uniques, index order,
  // index sorts, index predicates).
  //
  // So once the enumeration has had its say, the two `sqlite_master`s are
  // compared whole and the leftovers are named. It generates no migration and
  // is deliberately NOT part of `hasChanges`: there is nothing in this file that
  // could write one for a dimension it cannot see, and a change that never
  // resolves would migrate on every boot for ever. What it produces is the one
  // thing an enumeration cannot produce for itself — the statement that
  // something is left over.
  const settled = new Set(tableDiffs.map(d => d.name))
  const named   = new Set([
    ...changedTriggers.map(t => `trigger:${t.name}`),
    ...droppedTriggers.map(t => `trigger:${t.name}`),
  ])

  const residue = []
  const pSql = pristine.__sql ?? {}
  const lSql = live.__sql ?? {}
  for (const key of new Set([...Object.keys(pSql), ...Object.keys(lSql)])) {
    if (named.has(key)) continue
    const sep   = key.indexOf(':')
    const type  = key.slice(0, sep)
    const name  = key.slice(sep + 1)
    // A view's whole text is already compared by `changedViews`, which is the
    // one dimension here that was never an enumeration.
    if (type === 'view') continue

    const p = pSql[key]
    const l = lSql[key]
    const table = (p ?? l).table
    // Only tables both sides have and this database owns. A table on one side
    // only is `newTables`/`droppedTables`, which is a migration and is said.
    if (!pristineNames.has(table) || !liveNames.has(table)) continue
    if (settled.has(table) || externalNames.has(table)) continue

    // An index or trigger the APP wrote exists in the live database and in no
    // pristine one, by design — `diffIndexes` leaves those alone by this same
    // test and this must not overturn it from behind.
    if (!p) {
      if (type === 'index'   && !ownedIndex(name, table)) continue
      if (type === 'trigger' && !OWNED_TRIGGER.test(name)) continue
    }
    if (p?.sql === l?.sql) continue
    const pn = p ? normaliseDdl(p.sql) : null
    const ln = l ? normaliseDdl(l.sql) : null
    if (pn === ln) continue
    residue.push({ type, name, table, pristine: pn, live: ln })
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
    residue,
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
  const targetFields   = model.fields.filter(isStoredField)
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

  // A GENERATED column is computed, never copied. SQLite refuses an INSERT
  // naming one — `cannot INSERT into generated column` — so listing it fails
  // the whole rebuild, and the rebuild is the only path available: ADD COLUMN
  // cannot add a STORED generated column to a table that has rows.
  //
  // Excluded by KIND rather than by being newly added, because the failure is
  // a property of the column and not of this diff: a table that has carried a
  // generated column for a year hits it the moment anything else about that
  // table forces a rebuild. Dropping it from the copy is not a loss — the new
  // table computes it from the columns that were copied.
  const generatedNames = new Set(
    targetFields
      .filter(f => f.attributes?.some(a => a.kind === 'generated' || a.kind === 'funcCall'))
      .map(f => f.name),
  )

  const copyNames = targetColNames.filter(n => !addedNames.has(n) && !generatedNames.has(n))
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
      // Everything the model emits, not the table and a partial index list.
      // This was `generateTableDDL` + `generateIndexDDL(model, false, …)`, and
      // the explicit `false` defeated that function's own
      // `softDelete ?? isSoftDelete(model)` — so a migration built a
      // `@@softDelete` model with neither its `deletedAt` index nor the
      // `WHERE "deletedAt" IS NULL` clause its other indexes carry, and no
      // `@@fts` table, no FTS triggers and no `@updatedAt` trigger at all.
      // A deployed app therefore had a DIFFERENT database from the one
      // `db push` builds in development: search over a table that does not
      // exist, and a stamp that never moves. `generateModelDDL` is the one
      // owner of *everything one model emits* and its comment names this
      // exact failure — a caller assembling the pieces by hand gets whichever
      // ones it knew about when it was written.
      lines.push(generateModelDDL(model, parseResult.schema, { pluralize }))
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

        // A rebuild drops the table, which takes every object on it. Litestone's
        // own are regenerated from the schema; one the app created exists only
        // in the live database and there is nothing to restate it from.
        //
        // Named BEFORE the SQL used to be the answer, and the answer was wrong
        // for the one reader who matters — somebody applying a migration without
        // reading it, who is exactly who a generated file is for. So the rebuild
        // is emitted COMMENTED OUT, the same shape the un-defaultable column
        // above uses, because both are *litestone cannot decide this for you*
        // and one mechanism for that is better than two (FJS-183).
        //
        // Re-emitting a captured trigger verbatim was the third option and is
        // not taken: its body may name a column this rebuild drops, so it would
        // restate SQL that fails at CREATE or, worse, at the next write.
        const lost = [
          ...(d.foreignTriggers ?? []).map(n => `trigger "${n}"`),
          ...(d.indexes.foreign ?? []).map(i => `index "${i.name}"`),
        ]
        if (lost.length) {
          lines.push(`-- "${d.name}": rebuild BLOCKED — it DROPS the table, which destroys:`)
          for (const l of lost) lines.push(`--     ${l}`)
          lines.push(`-- Litestone did not create these and cannot restate them. Fix one of:`)
          lines.push(`--   • recreate each one below the rebuild, then uncomment it`)
          lines.push(`--   • move it into the schema, where litestone regenerates it`)
          lines.push(`--   • if it is no longer wanted, drop it by hand and uncomment`)
          lines.push(rebuildSQL(model, parseResult, pluralize, d).split('\n').map(l => `-- ${l}`).join('\n'))
          lines.push(``)
          continue
        }
        // Out of the way before the rename, which reparses every view.
        if (d.dropViews?.length) {
          lines.push(`-- "${d.name}": views over it, dropped for the rebuild and restored after`)
          for (const v of d.dropViews) lines.push(`DROP VIEW IF EXISTS "${v}";`)
          lines.push(``)
        }
        lines.push(rebuildSQL(model, parseResult, pluralize, d))
        lines.push(``)
        const idxSQL = generateIndexDDL(model, undefined, { pluralize })
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
          if (col.generated) {
            // Only VIRTUAL reaches here; a STORED one forced the rebuild above.
            const nn = col.notnull ? ` NOT NULL` : ``
            lines.push(`ALTER TABLE "${d.name}" ADD COLUMN "${col.name}" ${col.type}${nn} GENERATED ALWAYS AS (${col.generated.expr}) VIRTUAL;`)
            continue
          }
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
          const u     = idx.unique ? 'UNIQUE ' : ''
          // The direction travels, or the drop above is followed by a CREATE of
          // the very index it just removed and the migration is a no-op that
          // reports success.
          const cols  = idx.cols
            .map((c, i) => `"${c}"${idx.sorts?.[i] ? ` ${idx.sorts[i]}` : ''}`)
            .join(', ')
          const where = idx.where ? ` WHERE ${idx.where}` : ''
          lines.push(`CREATE ${u}INDEX IF NOT EXISTS "${idx.name}" ON "${d.name}" (${cols})${where};`)
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

// One line per leftover, appended to whatever the enumeration said. Kept out of
// the early return, because "in sync — no changes needed" is exactly the
// sentence a residue makes false.
function residueLines(diffResult) {
  return (diffResult.residue ?? []).map(r =>
    `  ! ${r.type} ${r.name}  (differs in a way the differ cannot name)\n` +
    `      declared: ${r.pristine ?? '(absent)'}\n` +
    `      live    : ${r.live ?? '(absent)'}`)
}

export function summariseDiff(diffResult) {
  const leftovers = residueLines(diffResult)
  if (!diffResult.hasChanges)
    return leftovers.length
      ? ['✓ schema is in sync on every dimension the differ reads — and:', ...leftovers].join('\n')
      : '✓ schema is in sync — no changes needed'

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
    // Named, because the commonest cause is an enum gaining a member and the
    // rebuild that follows is the whole table — worth seeing in a plan rather
    // than discovering in the row count.
    if (d.checksChanged) lines.push(`      ~ CHECK constraints changed (an enum's members, or an @check)`)
    // Named per constraint rather than as one flag, because a rebuild that ADDS
    // uniqueness is the one that can fail on the copy — the rows that violate it
    // are already there — and which columns those are is the whole of what the
    // reader needs to go and look.
    for (const u of d.uniques?.added   ?? []) lines.push(`      + ${constraintLabel(u)}  (rebuild; the copy fails if existing rows violate it)`)
    for (const u of d.uniques?.dropped ?? []) lines.push(`      - ${constraintLabel(u)}`)
    for (const i of d.indexes.added)
      lines.push(`      + idx  (${i.cols.join(', ')})`)
    for (const i of d.indexes.dropped)
      lines.push(`      - idx  ${i.name}`)
  }

  for (const t of diffResult.changedTriggers ?? [])
    lines.push(`  ~ ${t.table}  trigger ${t.name}  (recreate)`)
  for (const t of diffResult.droppedTriggers ?? [])
    lines.push(`  - ${t.table}  trigger ${t.name}  (retired)`)

  return [...lines, ...leftovers].join('\n')
}

// ─── Checksum ─────────────────────────────────────────────────────────────────

export function checksum(str) {
  return createHash('sha256').update(str).digest('hex').slice(0, 16)
}
