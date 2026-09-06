// ddl.js — schema AST → SQLite DDL
// Takes the output of parse() and produces CREATE TABLE / CREATE INDEX / etc.

// The plural rules are @frontierjs/toolbelt's, not a copy — a table name and
// the model name a resolver derives back from it have to be the same rules run
// twice (Invariant 2). @@map is the escape hatch for anything they cannot reach.
import { pluralize as pluralizeWord } from '@frontierjs/toolbelt/inflect'

// One owner for the range a scaled column may hold — the validator's, because
// the boundary and the table have to refuse the same value.
import { EXACT_INT_MAX } from './validate.js'

// ─── Type mapping ─────────────────────────────────────────────────────────────
// Prisma-style names → SQLite storage classes
// Json is stored as TEXT — SQLite has no native JSON type but json_extract() works on TEXT

const TYPE_MAP = {
  String:   'TEXT',
  Int:      'INTEGER',
  Float:    'REAL',
  Bytes:    'BLOB',
  Boolean:  'INTEGER',   // SQLite has no BOOLEAN — 0/1
  DateTime: 'TEXT',      // ISO8601 string — most portable
  Json:     'TEXT',      // json_extract() / json_each() work on TEXT
  File:     'TEXT',      // JSON reference object — bytes live in object storage
}

// ─── Model name → table name / accessor ──────────────────────────────────────
//
// Model names are PascalCase singular (User, ServiceAgreement).
// Table names are snake_case of the model name, optionally pluralized.
// Client accessors are camelCase of the model name (always singular).
//
// @@map("custom_name") always wins over any derivation.

// PascalCase / camelCase → snake_case
// "ServiceAgreement" → "service_agreement"
// "userProfile"      → "user_profile"
function toSnakeCase(name) {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g,     '$1_$2')
    .toLowerCase()
}

// PascalCase → camelCase  ("ServiceAgreement" → "serviceAgreement")
function toCamelCase(name) {
  return name.charAt(0).toLowerCase() + name.slice(1)
}

/**
 * Derive the SQL table name from a model.
 *
 * Resolution order:
 *  1. @@map("custom_name") — always wins
 *  2. toSnakeCase(model.name) + optional pluralize
 *
 * @param {object} model    — parsed model AST node
 * @param {boolean} [pluralize=false] — pluralize the snake_case name
 */
export function modelToTableName(model, pluralize = false) {
  const mapAttr = model.attributes.find(a => a.kind === 'map')
  if (mapAttr?.name) return mapAttr.name
  const snake = toSnakeCase(model.name)
  return pluralize ? pluralizeWord(snake) : snake
}

/**
 * Derive the SQL column name from a field.
 *
 * The field-level counterpart of `modelToTableName`, and it has to be a
 * function rather than a read of `field.name`: `@map` parsed and was applied by
 * nothing, so a schema carrying `fullName @map("full_name")` described a table
 * it could not read (`FJS-761`). Everything that emits a column identifier goes
 * through here.
 */
export function fieldToColumnName(field) {
  const mapAttr = field?.attributes?.find(a => a.kind === 'map')
  return mapAttr?.name || field?.name
}

/**
 * A model's field name → column name, for the names that DIFFER.
 *
 * Empty for a model that maps nothing, which is what lets every caller skip the
 * translation entirely rather than walking a full identity map per statement.
 */
export function columnMapFor(model) {
  const map = {}
  for (const f of model?.fields ?? []) {
    const col = fieldToColumnName(f)
    if (col !== f.name) map[f.name] = col
  }
  return map
}

/** One name through a model's map. A field the map does not name is its own column. */
export const mapCol = (map, name) => (map && map[name]) || name

/**
 * Walk the identifiers in a SQL expression, leaving string literals alone.
 *
 * `fn` answers a replacement or `null` to keep the word as it stands. A word
 * inside `'…'` is a VALUE and is never offered — rewriting there turned
 * `'legacy'` into an identifier called legacy. Shared with the importer, which
 * runs it in the other direction: a column read out of a foreign database
 * becomes a field name there, and a field name becomes a column here.
 */
export function mapIdentifiers(expr, fn) {
  let out = '', i = 0
  while (i < expr.length) {
    const ch = expr[i]
    if (ch === "'") {
      const end = expr.indexOf("'", i + 1)
      const stop = end === -1 ? expr.length : end + 1
      out += expr.slice(i, stop); i = stop; continue
    }
    if (ch === '"') {
      const end = expr.indexOf('"', i + 1)
      const stop = end === -1 ? expr.length : end + 1
      const id = expr.slice(i + 1, end === -1 ? expr.length : end)
      const mapped = /^[a-z_]\w*$/i.test(id) ? fn(id) : null
      out += mapped ?? expr.slice(i, stop); i = stop; continue
    }
    const word = expr.slice(i).match(/^[a-z_][a-z0-9_]*/i)
    if (word) { out += fn(word[0]) ?? word[0]; i += word[0].length; continue }
    out += ch; i++
  }
  return out
}

/**
 * An author-written SQL expression, in COLUMN space.
 *
 * `@@check` is emitted verbatim and names FIELDS, so a model that renames one
 * with `@map` described a constraint over a column that is not there — the
 * table then fails to CREATE, naming the field (`FJS-761`).
 */
export function mapExprCols(expr, cmap) {
  if (!expr || !cmap || Object.keys(cmap).length === 0) return expr
  return mapIdentifiers(expr, (id) => {
    const c = cmap[id]
    if (!c) return null
    // BARE where the name allows it, and the reason is the error message rather
    // than the SQL. SQLite reports an unnamed CHECK by its own source text, and
    // an expression that OPENS with a quoted identifier is reported as that
    // identifier alone — `CHECK ("page_count" >= 0)` comes back as
    // `page_count`. `asCheckViolation` finds the declaration that owns the
    // message by matching that text, so quoting every mapped column turned
    // every violation on a mapped model into the generic sentence. An author
    // who quotes their own column already loses the message the same way, so
    // this keeps the two spellings symmetric rather than inventing a rule.
    return SAFE_BARE_IDENT.test(c) ? c : `"${c}"`
  })
}

// Quoting is what a name needs when it could be read as something else. A
// keyword or a name with punctuation in it is quoted and takes the generic
// message with it, which is the trade named in mapExprCols.
const SQL_KEYWORDS = new Set([
  'abort', 'action', 'add', 'all', 'alter', 'and', 'as', 'asc', 'between', 'by',
  'case', 'cast', 'check', 'collate', 'column', 'commit', 'constraint', 'create',
  'cross', 'default', 'delete', 'desc', 'distinct', 'drop', 'else', 'end',
  'escape', 'except', 'exists', 'filter', 'for', 'from', 'full', 'group',
  'having', 'if', 'in', 'index', 'inner', 'insert', 'intersect', 'into', 'is',
  'isnull', 'join', 'left', 'like', 'limit', 'match', 'natural', 'not',
  'notnull', 'null', 'of', 'offset', 'on', 'or', 'order', 'outer', 'primary',
  'references', 'regexp', 'right', 'select', 'set', 'table', 'then', 'to',
  'transaction', 'union', 'unique', 'update', 'using', 'values', 'view', 'when',
  'where', 'with',
])
const SAFE_BARE_IDENT = {
  test: (name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !SQL_KEYWORDS.has(name.toLowerCase()),
}

/**
 * Derive the client accessor key from a model name.
 * Always camelCase singular — never pluralized.
 *
 * "User"              → "user"
 * "ServiceAgreement"  → "serviceAgreement"
 */
export function modelToAccessor(modelName) {
  return toCamelCase(modelName)
}


// A model has soft delete if it has @@softDelete (explicit).
// Cascade is opt-in: @@softDelete(cascade).

export function isSoftDelete(model) {
  return !!model.attributes.find(a => a.kind === 'softDelete')
}

export function isSoftDeleteCascade(model) {
  return !!model.attributes.find(a => a.kind === 'softDelete' && a.cascade)
}

// ─── Strict mode ─────────────────────────────────────────────────────────────
// STRICT is ON by default. Opt out with @@noStrict.
// This prevents the classic SQLite gotcha of storing "hello" in an INTEGER column.

export function isStrict(model) {
  if (model.attributes.find(a => a.kind === 'noStrict')) return false
  return true  // default: strict
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function sqlType(fieldType) {
  if (fieldType.array)           return 'TEXT'  // arrays stored as JSON text
  if (fieldType.kind === 'enum') return 'TEXT'
  return TYPE_MAP[fieldType.name] ?? 'TEXT'
}

function defaultExpr(attr) {
  if (!attr) return null
  const v = attr.value
  if (v.kind === 'string')  return `'${v.value.replace(/'/g, "''")}'`
  if (v.kind === 'number')  return String(v.value)
  if (v.kind === 'boolean') return v.value ? '1' : '0'
  if (v.kind === 'enum')     return `'${v.value}'`
  // An array column is JSON TEXT, so its default is the JSON text of the list.
  // An enum element is its member name — the same string the scalar enum
  // default emits, which is what makes a set and a single value comparable.
  if (v.kind === 'array')
    return `'${JSON.stringify(v.values.map(e => e.value)).replace(/'/g, "''")}'`
  if (v.kind === 'fieldRef') return null  // runtime-only — copied from sibling field at write time
  if (v.kind === 'call') {
    if (v.fn === 'auth') return null  // runtime-only — stamped from ctx.auth, not a SQL DEFAULT
    switch (v.fn) {
      case 'now':   return `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
      case 'uuid':  return `(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))))`
      // No native SQLite equivalent for these three — the client generates them
      // at insert time, from core/ids.js (FJS-423).
      case 'cuid':   return null
      case 'ulid':   return null
      case 'nanoid': return null
      default:       return null
    }
  }
  return null
}

// ─── Column default ───────────────────────────────────────────────────────────
//
// Whether an INSERT that omits this column succeeds — which is the question
// `release.js` asks of a new required field, and it has to be the same answer
// the DDL gives or the two disagree about the same schema.
//
// `@updatedAt` implies DEFAULT now() and `@version` implies DEFAULT 1; an array
// column defaults to '[]' unless it declares its own, because an empty array is
// its null state. Everything else with no SQL expression (`auth()`, `cuid()`,
// a sibling field) is stamped by the client at write time and is therefore NOT
// a default as far as a hand-written INSERT is concerned.

export function columnDefaultExpr(field) {
  const attrs = field.attributes ?? []
  const expr  = defaultExpr(attrs.find(a => a.kind === 'default'))
    ?? (attrs.some(a => a.kind === 'updatedAt') ? `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` : null)
    ?? (attrs.some(a => a.kind === 'version')   ? '1' : null)

  if (field.type?.array) return expr ?? `'[]'`
  return expr
}

// ─── Column definition ────────────────────────────────────────────────────────

function columnDef(field, schema = null, compositePk = false, strict = true) {
  const col   = fieldToColumnName(field)
  const parts = [`  "${col}" ${sqlType(field.type)}`]

  // NOT NULL — unless optional, and not for GENERATED/funcCall columns
  // SQLite rejects NOT NULL on GENERATED ALWAYS AS columns
  const isGenerated = field.attributes.find(a => a.kind === 'generated' || a.kind === 'funcCall')
  if (field.type.array) {
    // Arrays: always NOT NULL (empty array is the null state), always default to '[]'
    parts.push('NOT NULL')
  } else if (!field.type.optional && !isGenerated) {
    parts.push('NOT NULL')
  }

  // PRIMARY KEY (single-column only — a composite PK is emitted once at the
  // table level by tableConstraints, so suppress the per-column keyword then).
  const isId = field.attributes.find(a => a.kind === 'id')
  if (isId && !compositePk) parts.push('PRIMARY KEY')

  // UNIQUE
  const isUnique = field.attributes.find(a => a.kind === 'unique')
  if (isUnique) parts.push('UNIQUE')

  // DEFAULT — one owner, columnDefaultExpr, because release.js asks the same
  // question of the same field and a second copy of the rule would drift
  const expr = columnDefaultExpr(field)
  if (expr) parts.push(`DEFAULT ${expr}`)

  if (field.type.array) {
    parts.push(`CHECK (json_valid("${col}") AND json_type("${col}") = 'array')`)
  }

  // GENERATED (computed column) — from explicit @generated
  const gen = field.attributes.find(a => a.kind === 'generated')
  if (gen) {
    const storage = gen.stored ? 'STORED' : 'VIRTUAL'
    parts.push(`GENERATED ALWAYS AS (${gen.expr}) ${storage}`)
  }

  // GENERATED from a schema function call — @funcName(arg1, arg2)
  // Expands the function's @@expr template, substituting {param} → "field"
  const call = field.attributes.find(a => a.kind === 'funcCall')
  if (call && schema) {
    const fn = schema.functions?.find(f => f.name === call.fn)
    if (fn) {
      let expr = fn.expr
      fn.params.forEach((p, i) => {
        expr = expr.replaceAll(`{${p.name}}`, `"${call.args[i]}"`)
      })
      parts.push(`GENERATED ALWAYS AS (${expr}) STORED`)
    }
  }

  // @scale / @money — the column holds minor units and the promise is that what
  // goes in comes back. The round trip goes through a JS number at both ends, so
  // it stops being exact at 2^53: past that the rounded double is stored and a
  // different number is read back, silently (`FJS-583`). A CHECK rather than the
  // validator alone because four writers never reach the boundary — a migration,
  // a seed, a raw statement and `asSystem()`, which drops every rule this package
  // owns and cannot drop this one.
  if (field.attributes.some(a => a.kind === 'scale' || a.kind === 'money'))
    parts.push(`CHECK ("${col}" BETWEEN -${EXACT_INT_MAX} AND ${EXACT_INT_MAX})`)

  // @big — and the CHECK is emitted only where STRICT is off, which is the
  // opposite of the pair above and is a measurement rather than a judgement.
  // @scale's bound is NARROWER than the column's own, so nothing but a CHECK can
  // hold it; @big's bound IS the column's own, and STRICT already refuses every
  // way past it — a value beyond int64 (which SQLite otherwise demotes to REAL
  // 9.22e+18), a non-numeric string, and a fraction, each measured. So on a
  // STRICT table the CHECK's message never appears, and a constraint that
  // cannot fire is worse than none. `@@noStrict` is the one shape that turned
  // that off, and there it is the only thing standing between a wide column and
  // a silent REAL.
  if (!strict && field.attributes.some(a => a.kind === 'big'))
    parts.push(`CHECK ("${col}" IS NULL OR typeof("${col}") = 'integer')`)

  // CHECK
  const chk = field.attributes.find(a => a.kind === 'check')
  if (chk) parts.push(`CHECK (${chk.expr})`)

  return parts.join(' ')
}

// ─── Table constraints ────────────────────────────────────────────────────────

function tableConstraints(model, schema, pluralize = false) {
  const lines = []
  const cmap  = columnMapFor(model)

  // Composite primary key — if more than one @id field.
  //
  // The ORDER is `@@id`'s field list where the model declares one, and field
  // declaration order otherwise. They are two different facts: a primary key
  // builds an implicit index and an implicit index is prefix-matched, so
  // `PRIMARY KEY (orgId, userId)` answers `WHERE orgId = ?` and the swap does
  // not. With field-level `@id` alone there is nowhere to say it, which is what
  // `@@id` is for (`FJS-561`).
  const idOrder  = model.attributes.find(a => a.kind === 'id')?.fields
  const pkFields = model.fields.filter(f => f.attributes.find(a => a.kind === 'id'))
  if (pkFields.length > 1) {
    const names = idOrder ?? pkFields.map(f => f.name)
    const cols  = names.map(n => `"${mapCol(cmap, n)}"`).join(', ')
    lines.push(`  PRIMARY KEY (${cols})`)
  }

  // @@unique constraints
  for (const attr of model.attributes) {
    if (attr.kind === 'uniqueIndex') {
      const cols = attr.fields.map(f => `"${mapCol(cmap, f)}"`).join(', ')
      lines.push(`  UNIQUE (${cols})`)
    }
  }

  // @@check — the row invariants, emitted verbatim.
  //
  // The expression is written straight through because it is the author's SQL
  // and nothing here can judge it. The migrator compares CHECK text between the
  // pristine schema and the live table, so an edited expression rebuilds; both
  // sides are this emitter's own output, which is what makes a string
  // comparison exact there.
  for (const attr of model.attributes) {
    if (attr.kind === 'check') lines.push(`  CHECK (${mapExprCols(attr.expr, cmap)})`)
  }

  // @@arc — exclusive foreign keys, counted.
  //
  // SQLite spells a boolean as 0 or 1, so summing the IS NOT NULL tests counts
  // the set members and the comparison is the whole constraint. Derived rather
  // than written by the author, which is what a renamed column can be caught
  // against at parse; the migrator's CHECK-text comparison stays exact because
  // both sides are this emitter's output.
  for (const attr of model.attributes) {
    if (attr.kind === 'arc') lines.push(`  CHECK (${arcCheckExpr(attr, cmap)})`)
  }

  // Foreign keys from @relation attributes
  for (const field of model.fields) {
    const rel = field.attributes.find(a => a.kind === 'relation')
    if (!rel?.fields) continue  // skip back-reference fields (no fields: [...])

    // Resolve the TARGET's actual table name — @@map / pluralize aware.
    // Referencing the raw model name broke every FK on @@map'd schemas.
    const targetModel = schema?.models.find(m => m.name === field.type.name)
    // Each side takes its OWN model's map. `references:` names fields on the
    // TARGET, so mapping them through this model's would resolve a name that
    // happens to exist on both and leave the rest alone.
    const targetMap = targetModel ? columnMapFor(targetModel) : null
    const fromCols = rel.fields.map(f => `"${mapCol(cmap, f)}"`).join(', ')
    const toCols   = rel.references.map(f => `"${mapCol(targetMap, f)}"`).join(', ')
    const targetTable = targetModel ? modelToTableName(targetModel, pluralize) : field.type.name
    let fk = `  FOREIGN KEY (${fromCols}) REFERENCES "${targetTable}" (${toCols})`
    if (rel.onDelete) fk += ` ON DELETE ${rel.onDelete.toUpperCase().replace('SETNULL', 'SET NULL').replace('NOACTION', 'NO ACTION')}`
    if (rel.onUpdate) fk += ` ON UPDATE ${rel.onUpdate.toUpperCase().replace('SETNULL', 'SET NULL').replace('NOACTION', 'NO ACTION')}`
    lines.push(fk)
  }

  return lines
}

// ─── Enum CHECK constraint ────────────────────────────────────────────────────
// SQLite has no ENUM type — enforce via CHECK constraint

function enumCheck(field, schema) {
  if (field.type.kind !== 'enum') return null
  // An enum ARRAY is JSON text. `IN (...)` would compare the whole document
  // against a single value, so every non-empty array fails the constraint.
  // Reading its elements needs json_each, and a CHECK may not contain the
  // subquery that would take — membership is checked at the client boundary.
  if (field.type.array) return null
  const enumDef = schema.enums.find(e => e.name === field.type.name)
  if (!enumDef) return null
  // A member may be a quoted string, so it may hold an apostrophe. SQL escapes
  // one by doubling it; without this a member like `Don't ship` closes the
  // literal and the whole CREATE TABLE stops parsing.
  const values = enumDef.values.map(v => `'${String(v.name).replace(/'/g, "''")}'`).join(', ')
  return `  CHECK ("${fieldToColumnName(field)}" IN (${values}))`
}

// ─── What becomes a column ────────────────────────────────────────────────────
//
// The one answer, because two of them drift: CREATE TABLE and the rebuild's
// INSERT … SELECT have to name the same set, and SQLite resolves an unknown
// double-quoted identifier as a STRING LITERAL rather than erroring — so a
// disagreement copies the column's own name into every row instead of failing.
//
// @generated fields ARE columns — they become GENERATED ALWAYS AS. The rest of
// the exclusions are values that live somewhere else: a relation's key is on
// the other side, an implicit m2m is a join table, @edge/@scoped is a side
// table, @computed/@from/@derived are read-side only, and @transient is a
// payload key that is never stored at all.
export function isStoredField(f) {
  if (f.type.kind === 'relation' || f.type.kind === 'implicitM2M') return false
  return !f.attributes.find(a =>
    a.kind === 'computed'  || a.kind === 'from' || a.kind === 'derived' ||
    a.kind === 'transient' || a.kind === 'edge')
}

// ─── CREATE TABLE ─────────────────────────────────────────────────────────────

function createTable(model, schema, tableName, pluralize = false) {  // schema needed for funcCall expansion; tableName pre-derived
  const strict = isStrict(model)

  const columnFields = model.fields.filter(isStoredField)

  const pkCount      = model.fields.filter(f => f.attributes.some(a => a.kind === 'id')).length
  const colDefs      = columnFields.map(f => columnDef(f, schema, pkCount > 1, strict))
  const enumChecks   = columnFields.map(f => enumCheck(f, schema)).filter(Boolean)
  const constraints  = tableConstraints(model, schema, pluralize)
  const allDefs      = [...colDefs, ...enumChecks, ...constraints]

  const strictClause = strict ? ' STRICT' : ''
  const body = allDefs.join(',\n')

  return `CREATE TABLE IF NOT EXISTS "${tableName}" (\n${body}\n)${strictClause};`
}

// ─── CREATE INDEX ─────────────────────────────────────────────────────────────

function createIndexes(model, softDelete = false, tableName) {
  const lines = []
  const cmap  = columnMapFor(model)
  const soft  = softDelete ? `"${mapCol(cmap, 'deletedAt')}" IS NULL` : null

  for (const attr of model.attributes) {
    if (attr.kind !== 'index') continue
    // A direction is part of what the index IS. SQLite walks a b-tree in either
    // direction, so `DESC` earns its place on a COMPOSITE index whose columns
    // disagree — which is the shape a caller declares it for. The index NAME is
    // derived from the field list and not from this, so adding a direction does
    // not rename an existing index; the migrator sees the change through
    // `indexKey`, which carries the sorts.
    const cols = attr.fields
      .map((f, i) => `"${mapCol(cmap, f)}"${attr.sorts?.[i] ? ` ${attr.sorts[i]}` : ''}`)
      .join(', ')

    // Partial indexes on soft-delete tables — only index live rows. Smaller
    // index, better cache fit, and reachable because every read on such a model
    // carries the same clause.
    //
    // A DECLARED predicate (@@index(where:)) is ANDed with it rather than
    // replacing it: the soft-delete clause is what makes the index reachable on
    // such a model at all, so honouring the declaration by dropping it would
    // silently un-optimize every read. `whereSql` is the parser's own compiled
    // output — the same compiler a query goes through — which is what makes the
    // two byte-identical and therefore matchable.
    const parts = [soft, mapExprCols(attr.whereSql, cmap)].filter(Boolean)
    const where = parts.length === 0 ? ''
                : parts.length === 1 ? ` WHERE ${parts[0]}`
                : ` WHERE ${parts.map(p => `(${p})`).join(' AND ')}`

    lines.push(`CREATE INDEX IF NOT EXISTS "idx_${tableName}_${attr.fields.join('_')}" ON "${tableName}" (${cols})${where};`)
  }

  // @@unique([cols], where: …) — a CREATE UNIQUE INDEX, never a table
  // constraint, because no dialect takes a predicate on one.
  //
  // The soft-delete clause is NOT ANDed in, and that is the one line this
  // feature turns on. On an @@index the AND is an optimization — the clause is
  // what makes the index reachable on such a model. On a UNIQUE index the
  // predicate IS the constraint, so ANDing it is FJS-204's rejected derivation
  // arriving through the back door: the deleted row stops holding its @unique
  // slot, and SoftDeletedUniqueError can never fire because the index no longer
  // covers the row that would raise it. An author who wants uniqueness among
  // live rows writes `deletedAt == null` themselves, and then they have said it.
  for (const attr of model.attributes) {
    if (attr.kind !== 'partialUnique') continue
    const cols = attr.fields.map(f => `"${mapCol(cmap, f)}"`).join(', ')
    // `uniq_` and not `idx_`, because the two are different KINDS of thing over
    // the same columns and both are legitimate on one model: `@@index([a])` is
    // the ordinary lookup and `@@unique([a], where: …)` is *at most one row
    // where the predicate holds*. Sharing the derivation made the second
    // undeclarable, and the refusal offered two ways out — different columns,
    // or one predicate covering both — neither of which exists for that pair
    // (`FJS-614`). A partial unique covers only the rows its predicate admits,
    // so it cannot stand in for the lookup, which is the same reason `advise`
    // does not count one as foreign-key coverage.
    //
    // The prefix IS the ownership test in `migrate.js`, so a new one has to be
    // recognized there or litestone stops dropping its own index.
    lines.push(`CREATE UNIQUE INDEX IF NOT EXISTS "uniq_${tableName}_${attr.fields.join('_')}" ON "${tableName}" (${cols}) WHERE ${mapExprCols(attr.whereSql, cmap)};`)
  }

  // Auto-generate a partial index on deletedAt itself for soft-delete tables.
  // Makes WHERE deletedAt IS NULL counts and existence checks very fast.
  if (softDelete) {
    const dc = mapCol(cmap, 'deletedAt')
    lines.push(`CREATE INDEX IF NOT EXISTS "idx_${tableName}_deletedAt" ON "${tableName}" ("${dc}") WHERE "${dc}" IS NULL;`)
  }

  return lines
}

// ─── CREATE VIRTUAL TABLE (FTS5) ──────────────────────────────────────────────

function createFts(model, tableName) {
  const fts = model.attributes.find(a => a.kind === 'fts')
  if (!fts) return null

  const cmap = columnMapFor(model)
  // The FTS table's own columns are litestone's and stay FIELD names — search()
  // reads them back and they are never the source table's. What the triggers
  // reference through `new.`/`old.` is the source row, which is columns.
  const contentCols   = fts.fields.join(', ')
  const rowidCol      = mapCol(cmap, 'id')
  const hasSoftDelete = model.attributes.some(a => a.kind === 'softDelete')
  // unicode61 is FTS5's implicit default — only emit a tokenize clause when
  // the user picked something else. Keeps the DDL clean for the common case
  // and avoids relying on us hardcoding the same default FTS5 uses internally.
  const tokenize = fts.tokenize && fts.tokenize !== 'unicode61'
    ? `,\n  tokenize='${fts.tokenize}'`
    : ''
  const oldVals = fts.fields.map(f => `old.${mapCol(cmap, f)}`).join(', ')
  const newVals = fts.fields.map(f => `new.${mapCol(cmap, f)}`).join(', ')

  // The index mirrors the table row for row, soft-deleted rows included, and
  // the ONE reader — search() — excludes them in its own WHERE, which is also
  // what makes its withDeleted/onlyDeleted options mean anything.
  //
  // Keeping deleted rows out of the index instead costs a second owner of the
  // same decision, and that is what made @@softDelete + @@fts unusable: this
  // unconditional AFTER UPDATE trigger and an AFTER UPDATE OF "deletedAt" one
  // BOTH fired on a soft delete, issuing two 'delete' commands for one docid.
  // FTS5 answers that with `database disk image is malformed` — a message
  // naming neither the model, the FTS table, nor the two attributes that
  // cannot both be declared, so every remove() on such a model read as a
  // corrupt database file.
  const parts = [
    `CREATE VIRTUAL TABLE IF NOT EXISTS "${tableName}_fts" USING fts5(`,
    `  ${contentCols},`,
    `  content="${tableName}",`,
    `  content_rowid="${rowidCol}"${tokenize}`,
    `);`,
    ``,
    `-- Triggers to keep FTS index in sync.`,
    `-- Dropped first: IF NOT EXISTS keeps a stale body forever, and a trigger is`,
    `-- cheap to recreate, so re-applying the DDL repairs a wrong trigger set.`,
    `DROP TRIGGER IF EXISTS "${tableName}_fts_insert";`,
    `DROP TRIGGER IF EXISTS "${tableName}_fts_delete";`,
    `DROP TRIGGER IF EXISTS "${tableName}_fts_update";`,
    ...(hasSoftDelete ? [
      `DROP TRIGGER IF EXISTS "${tableName}_fts_soft_delete";`,
      `DROP TRIGGER IF EXISTS "${tableName}_fts_restore";`,
    ] : []),
    `CREATE TRIGGER "${tableName}_fts_insert" AFTER INSERT ON "${tableName}" BEGIN`,
    `  INSERT INTO "${tableName}_fts"(rowid, ${contentCols}) VALUES (new.${rowidCol}, ${newVals});`,
    `END;`,
    `CREATE TRIGGER "${tableName}_fts_delete" AFTER DELETE ON "${tableName}" BEGIN`,
    `  INSERT INTO "${tableName}_fts"("${tableName}_fts", rowid, ${contentCols}) VALUES ('delete', old.${rowidCol}, ${oldVals});`,
    `END;`,
    `CREATE TRIGGER "${tableName}_fts_update" AFTER UPDATE ON "${tableName}" BEGIN`,
    `  INSERT INTO "${tableName}_fts"("${tableName}_fts", rowid, ${contentCols}) VALUES ('delete', old.${rowidCol}, ${oldVals});`,
    `  INSERT INTO "${tableName}_fts"(rowid, ${contentCols}) VALUES (new.${rowidCol}, ${newVals});`,
    `END;`,
  ]

  return parts.join('\n')
}


// ─── The stamp columns ────────────────────────────────────────────────────────
// A field carrying `@updatedAt` is stamped by the CLIENT, on create and on
// update alike, from the clock that client was given (`FJS-531`). It used to be
// an AFTER UPDATE trigger, which could only ever read SQLite's own clock — so a
// suite that froze the clock still got today, and the crossing a frozen clock
// exists to stage could not be staged. `litestone migrate` retires an existing
// trigger; the walk that does it is `droppedTriggers` in `migrate.js`.
//
// The ATTRIBUTE decides, and the name `updatedAt` is a fallback for a schema
// relying on it. Binding to the name alone made the attribute decorative
// wherever the two agreed and a silent no-op wherever they did not: a second
// stamp column compiled, read as though it worked and never moved, while the
// DEFAULT on insert left every row carrying a plausible timestamp that had
// simply stopped advancing (FJS-394).
//
// The column DEFAULT stays and is the floor for a write that does not come
// through the client: a raw INSERT still stamps. A raw UPDATE does not, and
// that is the price of the clock being readable.
//
// `@@external` answers none: generateDDL emits nothing for that table, so the
// client must not stamp a column litestone does not own.

// One field's answer, so the client can ask it per field while `updatedAtFields`
// asks it per model.
export function isUpdatedAtField(field) {
  return (field.attributes ?? []).some(a => a.kind === 'updatedAt') ||
         (field.name === 'updatedAt' && field.type?.name === 'DateTime')
}

export function updatedAtFields(model) {
  if ((model.attributes ?? []).some(a => a.kind === 'external')) return []
  return (model.fields ?? []).filter(isUpdatedAtField)
}

// ─── Topological sort ─────────────────────────────────────────────────────────
// Emit tables in FK dependency order so FOREIGN KEY references are always valid
// Uses Kahn's algorithm — also detects circular references

function topoSort(models) {
  const nameToModel = new Map(models.map(m => [m.name, m]))
  const deps = new Map(models.map(m => {
    const foreignRefs = m.fields
      .filter(f => f.type.kind === 'relation' && f.attributes.find(a => a.kind === 'relation' && a.fields))
      .map(f => f.type.name)
      .filter(name => nameToModel.has(name) && name !== m.name)
    return [m.name, new Set(foreignRefs)]
  }))

  const sorted  = []
  const ready   = models.filter(m => deps.get(m.name).size === 0).map(m => m.name)
  const inDegree = new Map([...deps.entries()].map(([k, v]) => [k, v.size]))

  // Build reverse graph: who depends on me
  const dependents = new Map(models.map(m => [m.name, []]))
  for (const [name, d] of deps) {
    for (const dep of d) dependents.get(dep)?.push(name)
  }

  while (ready.length) {
    const name = ready.shift()
    sorted.push(nameToModel.get(name))
    for (const dep of dependents.get(name) ?? []) {
      inDegree.set(dep, inDegree.get(dep) - 1)
      if (inDegree.get(dep) === 0) ready.push(dep)
    }
  }

  if (sorted.length !== models.length) {
    // Circular FK references (e.g. Account.ownerId → User, User.accountId →
    // Account) are legal in SQLite: CREATE TABLE may reference a table that
    // doesn't exist yet — FKs resolve lazily at DML time. Emit the models
    // stuck in the cycle in declaration order instead of failing. Kahn's
    // output above still orders everything OUTSIDE the cycle correctly.
    const emitted = new Set(sorted.map(m => m.name))
    const cyclic  = models.filter(m => !emitted.has(m.name))
    if (typeof console !== 'undefined') {
      console.warn(
        `[litestone] Circular foreign key reference between: ${cyclic.map(m => m.name).join(', ')} — ` +
        `emitting in declaration order (SQLite resolves FKs lazily, so this is safe).`
      )
    }
    sorted.push(...cyclic)
  }

  return sorted
}

// ─── Implicit M2M ─────────────────────────────────────────────────────────────
// Detect mutual Model[] fields (no @relation) and generate a join table for each.
// Join table name: _modela_modelb (alphabetical, lowercase)
// Columns:        modelaId, modelbId (camelCase of model name + "Id")

// Detect implicit many-to-many relations — one entry per RELATION, not per
// model pair. Labeled relations (@relation("members") / @relation(name: "members"))
// pair by label, so two models can carry several m2m relations side by side,
// including self-relations (Tag ↔ Tag).
//
// Join table naming (Prisma parity for labeled relations):
//   unlabeled, distinct models →  _modela_modelb   cols: modelaId / modelbId  (legacy)
//   labeled                    →  _<label>          cols: "A" / "B"            (Prisma layout)
//   self (labeled or not)      →  cols "A" / "B"    ("A" = first-declared field's far side)
//
// "A" is the alphabetically-first model (Prisma convention), so existing
// Prisma SQLite files line up byte-for-byte with labeled relations.

const relLabel = (field) => field.attributes?.find(a => a.kind === 'relation')?.name ?? null

// The @id field of a model, as { name, type } for the join table's FK column.
//
// Both are carried on the pair rather than assumed. The join table used to
// declare `"postId" INTEGER … REFERENCES "post"("id")` whatever the models
// said, so a schema whose ids are `String @id @default(uuid())` — which is
// every app in this repo — got a STRICT table that refused its own keys:
// `cannot store TEXT value in INTEGER column _post_tag.postId`, on the first
// connect, naming a table nobody wrote.
function joinKeyOf(model, modelName) {
  const pk = model?.fields.find(f => f.attributes.some(a => a.kind === 'id'))
  if (!pk) return { name: 'id', type: 'INTEGER' }
  return { name: pk.name, type: sqlType(pk.type) }
}

export function detectM2MPairs(schema, pluralize = false) {
  const rels = []
  const seen = new Set()

  for (const model of schema.models) {
    for (const field of model.fields) {
      if (field.type.kind !== 'implicitM2M') continue
      const label  = relLabel(field)
      const target = schema.models.find(m => m.name === field.type.name)
      if (!target) continue
      const self   = target.name === model.name

      // Find the mirror field: same label (or both unlabeled), pointing back.
      const mirror = self
        ? model.fields.find(f => f !== field && f.type.kind === 'implicitM2M' && f.type.name === model.name && relLabel(f) === label)
        : target.fields.find(f => f.type.kind === 'implicitM2M' && f.type.name === model.name && relLabel(f) === label)
      if (!mirror) continue   // parser validation reports this — skip here

      // Dedupe: one entry per relation (label + sorted models, or self field pair)
      const [a, b] = [model.name, target.name].sort()
      const key = self
        ? `${a}__${a}__${label ?? [field.name, mirror.name].sort().join('~')}`
        : `${a}__${b}__${label ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)

      const mA = schema.models.find(m => m.name === a)
      const mB = schema.models.find(m => m.name === b)
      const tableA = mA ? modelToTableName(mA, pluralize) : a
      const tableB = mB ? modelToTableName(mB, pluralize) : b
      const keyA   = joinKeyOf(mA, a)
      const keyB   = joinKeyOf(mB, b)

      if (self) {
        // Deterministic direction: first-DECLARED field is the "A end" —
        // traversing it returns ids stored in column "A".
        const fields   = model.fields.filter(f => f.type.kind === 'implicitM2M' && f.type.name === model.name && relLabel(f) === label)
        const [f1, f2] = fields          // declaration order
        rels.push({
          relName: label, self: true,
          modelA: a, modelB: b, tableA, tableB,
          pkA: keyA.name, pkB: keyB.name, typeA: keyA.type, typeB: keyB.type,
          joinTable: label ? `_${label}` : `_${a.toLowerCase()}_${b.toLowerCase()}`,
          colA: 'A', colB: 'B',
          fieldA: f2?.name ?? null,   // field on modelA whose join column is colA…
          fieldB: f1?.name ?? null,   // …see buildRelationMap for the self mapping
          selfFields: { [f1.name]: { selfKey: 'B', targetKey: 'A' },
                        ...(f2 ? { [f2.name]: { selfKey: 'A', targetKey: 'B' } } : {}) },
        })
      } else {
        const fieldOnA = (model.name === a ? field : mirror).name
        const fieldOnB = (model.name === a ? mirror : field).name
        const labeled  = label != null
        rels.push({
          relName: label, self: false,
          modelA: a, modelB: b, tableA, tableB,
          pkA: keyA.name, pkB: keyB.name, typeA: keyA.type, typeB: keyB.type,
          joinTable: labeled ? `_${label}` : `_${a.toLowerCase()}_${b.toLowerCase()}`,
          colA: labeled ? 'A' : a.charAt(0).toLowerCase() + a.slice(1) + 'Id',
          colB: labeled ? 'B' : b.charAt(0).toLowerCase() + b.slice(1) + 'Id',
          fieldA: fieldOnA,
          fieldB: fieldOnB,
        })
      }
    }
  }
  return rels
}

export function generateJoinTableDDL(pair, ifNotExists = true) {
  const ie = ifNotExists ? 'IF NOT EXISTS ' : ''
  // @edge columns decorating this join (added by collectEdges via generateDDL).
  const edgeCols = (pair.edgeColumns ?? []).map(c => `${c},`)
  return [
    `CREATE TABLE ${ie}"${pair.joinTable}" (`,
    `  "${pair.colA}" ${pair.typeA ?? 'INTEGER'} NOT NULL REFERENCES "${pair.tableA ?? pair.modelA}"("${pair.pkA ?? 'id'}") ON DELETE CASCADE,`,
    `  "${pair.colB}" ${pair.typeB ?? 'INTEGER'} NOT NULL REFERENCES "${pair.tableB ?? pair.modelB}"("${pair.pkB ?? 'id'}") ON DELETE CASCADE,`,
    ...edgeCols,
    `  PRIMARY KEY ("${pair.colA}", "${pair.colB}")`,
    `) STRICT;`,
    `CREATE INDEX IF NOT EXISTS "${pair.joinTable}_${pair.colB}_idx" ON "${pair.joinTable}"("${pair.colB}");`,
  ].join('\n')
}

// ─── @edge / @scoped storage ──────────────────────────────────────────────────
// An @edge value lives on a relationship, never on its host row. Two shapes:
//   decorate   — columns added to an existing implicit-m2m join table (the ref
//                already has a mutual Model[] relation to the host)
//   create-own — a dedicated side table (hostId, dimId, <cols>) when no such
//                relation exists (the @scoped / personalization case)
// Both are byte-for-byte the explicit join model you'd hand-write, so eject is
// a rename with no data migration.

const _lowerFirst = s => s.charAt(0).toLowerCase() + s.slice(1)

// Every @edge field across the schema, with its resolved descriptor.
export function collectEdges(schema) {
  const edges = []
  for (const model of schema.models) {
    for (const field of model.fields) {
      const e = field.attributes.find(a => a.kind === 'edge')
      if (!e) continue
      edges.push({ hostModel: model, hostName: model.name, field, ...e })
    }
  }
  return edges
}

// Classify each edge as decorate (matches an m2m pair) or create-own (its own
// side table), returning { pairs, ownGroups } ready for DDL. Mutates pairs by
// attaching `.edgeColumns`.
export function planEdgeStorage(schema, m2mPairs, pluralize = false) {
  const ownGroups = new Map()   // sideTable → { sideTable, hostTable, dimTable, hostCol, dimCol, cols }
  for (const edge of collectEdges(schema)) {
    const refModel = schema.models.find(m => m.name === edge.ref)
    const pair = m2mPairs.find(p => {
      const set = new Set([p.modelA, p.modelB])
      return set.has(edge.hostName) && set.has(edge.ref)
    })
    const colDef = columnDef(edge.field, schema)
    if (pair) {
      (pair.edgeColumns ??= []).push(colDef)
    } else {
      const hostTable = modelToTableName(edge.hostModel, pluralize)
      const dimTable  = refModel ? modelToTableName(refModel, pluralize) : edge.ref
      const hostCol   = `${_lowerFirst(edge.hostName)}Id`
      const dimCol    = edge.key
      const [la, lb]  = [edge.hostName, edge.ref].map(_lowerFirst).sort()
      const sideTable = `_${la}_${lb}`
      // Same rule as the m2m join table: the FK takes the referenced model's
      // own @id name and type, never the literal `id INTEGER`.
      const hostKey   = joinKeyOf(edge.hostModel, edge.hostName)
      const dimKey    = joinKeyOf(refModel, edge.ref)
      const g = ownGroups.get(sideTable) ?? {
        sideTable, hostTable, dimTable, hostCol, dimCol, cols: [],
        hostPk: hostKey.name, dimPk: dimKey.name, hostType: hostKey.type, dimType: dimKey.type,
      }
      g.cols.push(colDef)
      ownGroups.set(sideTable, g)
    }
  }
  return { pairs: m2mPairs, ownGroups: [...ownGroups.values()] }
}

// Runtime edge map: per-model, per-field storage descriptor the client uses to
// read/write/filter edge values. Naming here is authoritative — it MUST match the
// DDL (join columns from detectM2MPairs, side tables from planEdgeStorage), so
// both derive from the same helpers.
//   decorate → { storage, table: <joinTable>, hostCol, dimCol, col, ... }
//   own      → { storage, table: <sideTable>, hostCol, dimCol, col, hostTable, dimTable, ... }
export function buildEdgeMap(schema, pluralize = false) {
  const m2mPairs = detectM2MPairs(schema, pluralize)
  const map = {}
  for (const edge of collectEdges(schema)) {
    const host     = edge.hostName
    const refModel = schema.models.find(m => m.name === edge.ref)
    const pair = m2mPairs.find(p => {
      const s = new Set([p.modelA, p.modelB])
      return s.has(host) && s.has(edge.ref)
    })
    let desc
    if (pair) {
      const hostCol = host      === pair.modelA ? pair.colA : pair.colB
      const dimCol  = edge.ref  === pair.modelA ? pair.colA : pair.colB
      desc = { storage: 'decorate', table: pair.joinTable, hostCol, dimCol }
    } else {
      const hostTable = modelToTableName(edge.hostModel, pluralize)
      const dimTable  = refModel ? modelToTableName(refModel, pluralize) : edge.ref
      const [la, lb]  = [host, edge.ref].map(_lowerFirst).sort()
      desc = { storage: 'own', table: `_${la}_${lb}`, hostCol: `${_lowerFirst(host)}Id`, dimCol: edge.key, hostTable, dimTable }
    }
    const defAttr = edge.field.attributes.find(a => a.kind === 'default')
    desc = {
      ...desc,
      field: edge.field.name, col: edge.field.name, type: edge.field.type,
      ref: edge.ref, key: edge.key, as: edge.as, onMissing: edge.onMissing, auth: edge.auth,
      default: defAttr ? defAttr.value : undefined,
    }
    ;(map[host] ??= {})[edge.field.name] = desc
  }
  return map
}

export function generateEdgeSideTableDDL(g, ifNotExists = true) {
  const ie = ifNotExists ? 'IF NOT EXISTS ' : ''
  return [
    `CREATE TABLE ${ie}"${g.sideTable}" (`,
    `  "${g.hostCol}" ${g.hostType ?? 'INTEGER'} NOT NULL REFERENCES "${g.hostTable}"("${g.hostPk ?? 'id'}") ON DELETE CASCADE,`,
    `  "${g.dimCol}" ${g.dimType ?? 'INTEGER'} NOT NULL REFERENCES "${g.dimTable}"("${g.dimPk ?? 'id'}") ON DELETE CASCADE,`,
    ...g.cols.map(c => `${c},`),
    `  PRIMARY KEY ("${g.hostCol}", "${g.dimCol}")`,
    `) STRICT;`,
    `CREATE INDEX IF NOT EXISTS "${g.sideTable}_${g.dimCol}_idx" ON "${g.sideTable}"("${g.dimCol}");`,
  ].join('\n')
}

// ─── CREATE VIEW ─────────────────────────────────────────────────────────────
// Regular (non-materialized) views — pure SQL sugar, read-only.
// The @@sql body is embedded verbatim into CREATE VIEW.
// View fields are not used for DDL — they're just for the schema AST / type info.

function createView(view) {
  const sql = view.sql.trim().replace(/;$/, '')  // strip trailing semicolon if present
  return `CREATE VIEW IF NOT EXISTS "${view.name}" AS\n${sql};`
}

// ─── MATERIALIZED VIEW ────────────────────────────────────────────────────────
// Materialized views are real tables kept in sync via triggers.
// Strategy: full refresh — on any write to a source table, DELETE + re-INSERT.
// Simpler and safer than incremental updates for aggregation queries.
//
// DDL emitted:
//   CREATE TABLE "viewName" (field columns...) STRICT;
//   CREATE TRIGGER "viewName_refresh_on_source_insert" AFTER INSERT ON "source" ...
//   CREATE TRIGGER "viewName_refresh_on_source_update" AFTER UPDATE ON "source" ...
//   CREATE TRIGGER "viewName_refresh_on_source_delete" AFTER DELETE ON "source" ...

function createMaterializedView(view) {
  const lines = []

  // ── Table definition ──────────────────────────────────────────────────────

  const colDefs = view.fields.map(f => {
    const sqlT = TYPE_MAP[f.type.name] ?? 'TEXT'
    const notNull = !f.type.optional ? ' NOT NULL' : ''
    return `  "${f.name}" ${sqlT}${notNull}`
  })

  lines.push(
    `-- Materialized view: ${view.name}`,
    `-- Kept in sync with: ${view.refreshOn.join(', ')}`,
    `CREATE TABLE IF NOT EXISTS "${view.name}" (`,
    colDefs.join(',\n'),
    `) STRICT;`,
  )

  // ── Refresh triggers — one set per @@refreshOn source ────────────────────
  // Each trigger does a full DELETE + re-INSERT from the @@sql query.

  const refreshSql = view.sql.trim().replace(/;$/, '')

  for (const source of view.refreshOn) {
    const base = `"${view.name}_refresh_on_${source}`

    lines.push(
      ``,
      `-- Refresh ${view.name} on any write to ${source}`,
      `CREATE TRIGGER IF NOT EXISTS ${base}_insert" AFTER INSERT ON "${source}" BEGIN`,
      `  DELETE FROM "${view.name}";`,
      `  INSERT INTO "${view.name}" ${refreshSql};`,
      `END;`,
      `CREATE TRIGGER IF NOT EXISTS ${base}_update" AFTER UPDATE ON "${source}" BEGIN`,
      `  DELETE FROM "${view.name}";`,
      `  INSERT INTO "${view.name}" ${refreshSql};`,
      `END;`,
      `CREATE TRIGGER IF NOT EXISTS ${base}_delete" AFTER DELETE ON "${source}" BEGIN`,
      `  DELETE FROM "${view.name}";`,
      `  INSERT INTO "${view.name}" ${refreshSql};`,
      `END;`,
    )
  }

  return lines.join('\n')
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate full SQLite DDL from a parsed schema.
 *
 * @param {object} schema  — output of parse()
 * @param {object} options
 * @param {boolean} options.foreignKeys  — emit PRAGMA foreign_keys = ON (default true)
 * @param {boolean} options.ifNotExists  — use CREATE TABLE IF NOT EXISTS (default true)
 * @returns {string}  complete DDL script
 */
export function generateDDL(schema, { foreignKeys = true, pluralize = false } = {}) {
  const sections = []

  if (foreignKeys) {
    sections.push('PRAGMA foreign_keys = ON;')
  }

  const sorted = topoSort(schema.models)

  for (const model of sorted) {
    // @@external — table managed outside Litestone, skip DDL entirely
    if (model.attributes.some(a => a.kind === 'external')) continue

    const tableName = modelToTableName(model, pluralize)
    const parts = []

    // Doc comment
    if (model.comments.length) {
      parts.push(model.comments.map(c => `-- ${c}`).join('\n'))
    }

    parts.push(generateModelDDL(model, schema, { pluralize }))

    sections.push(parts.join('\n'))
  }

  // Implicit m2m join tables (generated after all models so FKs resolve).
  // @edge columns decorate these; @edge/@scoped with no relation get side tables.
  const m2mPairs = detectM2MPairs(schema, pluralize)
  const { ownGroups } = planEdgeStorage(schema, m2mPairs, pluralize)
  for (const pair of m2mPairs) {
    sections.push(generateJoinTableDDL(pair))
  }
  for (const g of ownGroups) {
    sections.push(generateEdgeSideTableDDL(g))
  }

  // Views — after all tables since they reference them
  for (const view of (schema.views ?? [])) {
    if (view.materialized) {
      sections.push(createMaterializedView(view))
    } else {
      sections.push(createView(view))
    }
  }

  return sections.join('\n\n')
}

/**
 * Generate DDL scoped to a single named database.
 * Used by the migration engine to produce per-database DDL files.
 *
 * Models with @@db(name) matching dbName are included.
 * Models with no @@db are included only when dbName === 'main'.
 * Views follow the same rule.
 *
 * @param {object} schema   — output of parse()
 * @param {string} dbName   — database name (e.g. 'main', 'logs', 'analytics')
 * @param {object} options
 */
export function generateDDLForDatabase(schema, dbName, { foreignKeys = true, pluralize = false } = {}) {
  // Filter models that belong to this database
  const models = schema.models.filter(m => {
    const dbAttr = m.attributes.find(a => a.kind === 'db')
    return (dbAttr?.name ?? 'main') === dbName
  })

  // Filter views that belong to this database
  const views = (schema.views ?? []).filter(v => (v.db ?? 'main') === dbName)

  // Build a filtered schema for topoSort and DDL generation
  const filteredSchema = { ...schema, models, views }

  return generateDDL(filteredSchema, { foreignKeys, pluralize })
}

/**
 * Generate DDL for a single view — useful for migrations.
 */
export function generateViewDDL(view) {
  return view.materialized ? createMaterializedView(view) : createView(view)
}

/**
 * Generate DDL for a single model — useful for migrations.
 */
export function generateTableDDL(model, schema, { pluralize = false } = {}) {
  return createTable(model, schema, modelToTableName(model, pluralize), pluralize)
}

/**
 * Generate just the indexes for a model.
 */
// `softDelete` defaulted to `false`, which made the `?? isSoftDelete(model)`
// beside it unreachable for every caller — `false ?? x` is `false` — so this
// function never emitted a partial index for anyone, and the migrator's rebuild
// path used it to recreate the indexes of a @@softDelete model as FULL ones
// (FJS-577, the same shape as FJS-443 in a branch its fix did not reach).
// Absent now means ask the model, which is the only answer a caller who does
// not state one can have meant.
export function generateIndexDDL(model, softDelete, { pluralize = false } = {}) {
  return createIndexes(model, softDelete ?? isSoftDelete(model), modelToTableName(model, pluralize))
}

/**
 * Everything one model emits — the table, its indexes, its FTS index and its
 * updatedAt trigger.
 *
 * generateDDL calls this rather than repeating the four, because a caller
 * assembling them by hand gets whichever ones it knew about when it was
 * written: asking for a model's DDL and receiving the table and the indexes
 * alone is a silently partial answer, and the two it drops are exactly the ones
 * an attribute adds.
 */
export function generateModelDDL(model, schema, { pluralize = false } = {}) {
  const tableName = modelToTableName(model, pluralize)
  const parts     = [createTable(model, schema, tableName, pluralize)]

  const indexes = createIndexes(model, isSoftDelete(model), tableName)
  if (indexes.length) parts.push(indexes.join('\n'))

  const fts = createFts(model, tableName)
  if (fts) parts.push(fts)

  return parts.join('\n')
}

// The SQL an @@arc compiles to, and the one place it is spelt.
//
// The emitter writes it into the table and client.js matches SQLite's reported
// CHECK text back against it to find the declaration that owns the message. A
// second spelling would not fail — it would fall through to "this record is not
// valid", which is the generic sentence the message exists to replace.
export function arcCheckExpr(attr, cmap = null) {
  const terms = attr.fields.map(f => `("${mapCol(cmap, f)}" IS NOT NULL)`).join(' + ')
  return `(${terms}) ${attr.optional ? '<=' : '='} 1`
}

// What a violated arc says to a person, when the author wrote no message.
// Column names rather than labels: a model-level rule spans columns and marks no
// box, so the only useful thing to name is which columns are in the choice.
export function arcDefaultMessage(attr) {
  const list = attr.fields.join(', ')
  return attr.optional
    ? `at most one of ${list} may be set`
    : `exactly one of ${list} must be set`
}
