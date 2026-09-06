import { isIndexExpression, predicateToLite } from '../core/migrate.js'
import { mapIdentifiers } from '../core/ddl.js'
// src/introspect.js — Entity Generator
// Reverse-engineers an existing SQLite database into a .lite schema file.
//
// Usage:
//   litestone introspect ./existing.db --out schema.lite
//   litestone introspect ./existing.db   (prints to stdout)
//
// Handles:
//   - Column types (SQLite → .lite types)
//   - Primary keys, NOT NULL, defaults
//   - Foreign keys → @relation
//   - UNIQUE / multi-column indexes → @@index / @@unique
//   - Soft delete detection (deletedAt column)
//   - Enum detection from CHECK constraints
//   - STRICT tables → @@noStrict absent (STRICT is default in .lite)
//   - camelCase conversion from snake_case table/column names

import { introspect }             from '../core/migrate.js'
// One grading table for every converter in this package. A live database is a
// source like any other and says less than the schema that built it; `import`'s
// three tiers are what make the list of what it could not say readable.
import { tierOf, summarize }      from '../import/tiers.js'
// Mirrors the pluralizer ddl.js runs — the same table read the other way.
import { singularize as toSingular } from '@frontierjs/toolbelt/inflect'

// ─── Type mapping: SQLite types → .lite types ─────────────────────────────────

const TYPE_MAP = {
  'INTEGER': 'Int',
  'INT':     'Int',
  'BIGINT':  'Int',
  'SMALLINT':'Int',
  'TINYINT': 'Int',
  'REAL':    'Float',
  'FLOAT':   'Float',
  'DOUBLE':  'Float',
  'NUMERIC': 'Float',
  'DECIMAL': 'Float',
  'TEXT':    'String',
  'VARCHAR': 'String',
  'CHAR':    'String',
  'CLOB':    'String',
  'BLOB':    'Bytes',
  'BYTES':   'Bytes',
  'BOOLEAN': 'Boolean',
  'BOOL':    'Boolean',
}

function sqliteTypeToLite(rawType) {
  if (!rawType) return 'String'
  const upper = rawType.toUpperCase().split('(')[0].trim()
  return TYPE_MAP[upper] ?? 'String'
}

// ─── Name helpers ──────────────────────────────────────────────────────────────

function toCamelCase(str) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

function toPascalCase(str) {
  const camel = toCamelCase(str)
  return camel.charAt(0).toUpperCase() + camel.slice(1)
}

// Model name → the table `ddl.js` would derive for it, with no @@map. The
// forward direction of the function below, restated rather than imported so
// this tool keeps its one dependency on the schema core; if they ever disagree
// the schema names a table that is not there, which is the failure the caller
// of this uses it to prevent.
function tableNameFromModel(modelName) {
  return modelName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

// Table name → PascalCase singular model name
// "users"             → "User"
// "service_agreements" → "ServiceAgreement"
// "people"            → "Person"
function tableNameToModelName(tableName) {
  return toPascalCase(toSingular(tableName))
}

// ─── Default value rendering ───────────────────────────────────────────────────

// SQLite hands back a default's SOURCE TEXT, so its SHAPE says what kind it is:
// `(…)` is an expression, `'…'` is a string literal, anything else is a bare
// number or keyword. Telling them apart is the whole of this function.
//
// An EXPRESSION emitted as `@default("<its text>")` is not a near miss — it
// becomes a string-literal default, so every row written afterwards gets the SQL
// as its value instead of a uuid; and `ddl.js` doubles the quotes inside it on
// the way back out, so the text grows a level on every round trip. Measured on
// basecamp, where six models key on `@default(uuid())`.
//
// Two expressions are litestone's own (`defaultExpr` in ddl.js emits exactly
// these), so they are read back as what wrote them. Any other expression is a
// database litestone did not write, and it is handed over rather than guessed —
// `.lite` has no spelling for an arbitrary SQL default.
const UUID_EXPR = /randomblob\(4\)[\s\S]*'-4'[\s\S]*89ab[\s\S]*randomblob\(6\)/i
const CLOCK_EXPR = /^(strftime|datetime|date|time|now|julianday|unixepoch)\s*\(/i

function renderDefault(def, liteType) {
  if (def === null || def === undefined) return { attr: null, expr: null }
  const s = String(def).trim()
  if (!s || /^NULL$/i.test(s)) return { attr: null, expr: null }

  // An expression. SQLite parenthesises one in `dflt_value`; a bare function
  // call reaches us from a hand-written DDL, so both shapes are tested.
  // `PRAGMA table_info` does not always keep the parentheses SQLite stored, so
  // the unquoted shapes count too: a function call, and a `||` concatenation.
  // A real string default is quoted, so nothing here can be one.
  const inner  = /^\((.*)\)$/s.test(s) ? s.slice(1, -1).trim() : s
  const quoted = /^'/.test(s)
  const isExpr = !quoted && (/^\(/.test(s) || /^[A-Za-z_]\w*\s*\(/.test(s) || s.includes('||'))
  if (isExpr) {
    if (UUID_EXPR.test(inner))  return { attr: '@default(uuid())', expr: null }
    if (CLOCK_EXPR.test(inner)) return { attr: '@default(now())',  expr: null }
    return { attr: null, expr: inner }
  }

  if (s === 'CURRENT_TIMESTAMP' || s === 'CURRENT_DATE') return { attr: '@default(now())', expr: null }

  if (liteType === 'Boolean') {
    if (s === '0' || /^false$/i.test(s)) return { attr: '@default(false)', expr: null }
    if (s === '1' || /^true$/i.test(s))  return { attr: '@default(true)',  expr: null }
  }

  if (/^-?\d+(\.\d+)?$/.test(s)) return { attr: `@default(${s})`, expr: null }

  // A string literal. SQLite escapes an inner quote by doubling it, so the
  // doubling has to be undone here or it is re-doubled on the way back out.
  const m = /^'([\s\S]*)'$/.exec(s)
  const text = m ? m[1].replace(/''/g, "'") : s.replace(/^["`]|["`]$/g, '')
  return { attr: `@default("${text.replace(/(["\\])/g, '\\$1')}")`, expr: null }
}

// ─── Enum detection from CHECK constraints ────────────────────────────────────
// Looks for: CHECK (col IN ('a', 'b', 'c'))

function detectEnumFromCheck(tableSql, columnName) {
  if (!tableSql) return null
  // Match: CHECK("col" IN (...)) or CHECK(col IN (...))
  const re = new RegExp(
    `CHECK\\s*\\(\\s*["'\`]?${columnName}["'\`]?\\s+IN\\s*\\(([^)]+)\\)`,
    'i'
  )
  const m = tableSql.match(re)
  if (!m) return null
  const values = m[1]
    .split(',')
    .map(v => v.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
  return values.length >= 2 ? values : null
}

// ─── Generate .lite source ────────────────────────────────────────────────────

// Notes below are `//` and never `///`. A doc comment attaches to the next
// declaration, and one at the end of a model body has none to attach to — the
// generated file stops parsing, which for a converter is the whole product.
//
// Is this predicate exactly the clause @@softDelete already adds to every index
// on the model? Then it round-trips as a plain @@index — and MUST, because
// declaring it is refused as a line with no effect.
// Either spelling of the column, because `@map` means the FIELD is `deletedAt`
// and the COLUMN this reads is whatever the schema named — a schema written
// against an existing database spells it `deleted_at` and the clause in the
// index is the column's (`FJS-761`). One owner, shared with the detection at
// the top of the model, or the two disagree about whether a model soft-deletes
// and the clause is then read as part of the author's own predicate.
const SOFT_DELETE_COLS = ['deletedAt', 'deleted_at']
const SOFT_DELETE_RE   = `"?(?:${SOFT_DELETE_COLS.join('|')})"?`

function isSoftDeleteClause(where) {
  return new RegExp(`^\\(?\\s*${SOFT_DELETE_RE}\\s+IS\\s+NULL\\s*\\)?$`, 'i').test(where ?? '')
}

// SQLite's words for a referential action are not .lite's, and the translation
// only ever existed in one direction — `ddl.js` writes `SETNULL` out as
// `SET NULL`, and nothing read it back. So every generated relation carrying an
// action named one the parser refuses; the missing comma in front of it meant
// the line never reached that refusal, and stopped the whole file parsing at
// `Expected COLON, got ')'`. SET DEFAULT is SQLite's and has no .lite spelling.
const FK_ACTION = {
  'CASCADE':   'Cascade',
  'SET NULL':  'SetNull',
  'RESTRICT':  'Restrict',
  'NO ACTION': 'NoAction',
}

// What the SCHEMA declared, out of what the DATABASE holds.
//
// `createIndexes` ANDs @@softDelete's own clause onto every index on the model,
// so the stored predicate is never the declared one — and emitting it whole
// means the next migration ANDs the clause on again. Measured over `example`:
// one round trip turns `where: active == true` into
// `deletedAt == null && active == true`, and the second nests it a level deeper
// than `predicateToLite` can read, so the predicate is dropped entirely with a
// comment. A converter whose output degrades each time it is run is one nobody
// can run twice.
function declaredPredicate(where, hasSoftDelete) {
  if (!where || !hasSoftDelete) return where
  const m = new RegExp(`^\\s*\\(?\\s*${SOFT_DELETE_RE}\\s+IS\\s+NULL\\s*\\)?\\s+AND\\s+\\(([\\s\\S]+)\\)\\s*$`, 'i').exec(where)
  return m ? m[1] : where
}

// A direction is part of what an index IS, and only @@index can hold one —
// @@unique takes a plain field list, so a unique index that carries one loses it.
const sortArg = (dir) => `(sort: ${dir === 'DESC' ? 'Desc' : 'Asc'})`


// The string alone, for a caller that only wants the file. `introspectToLite`
// is the whole answer — what it could not carry is the half that decides whether
// the file is usable, and a caller reaching for a `.lite` and getting one has no
// way to ask.
export function generateLiteSchema(db, opts = {}) {
  return introspectToLite(db, opts).lite
}

export function introspectToLite(db, { camelCase = true } = {}) {
  const schema = introspect(db)

  // Same shape the four import readers use, so one `summarize` reads both.
  const gaps = []
  const gap  = (kind, model, field, detail, emitted) =>
    gaps.push({ kind, model, field, detail, emitted })

  // Said once rather than per model: it is one fact about the SOURCE — a SQLite
  // file holds tables and constraints, and none of the half that decides who may
  // read the rows. The header comment says it to whoever opens the file; this
  // says it to whoever is counting.
  gap('application-attributes', null, null,
      'a SQLite database holds no access rules',
      '@@gate, @@allow/@@deny, @allow, @secret, @guarded, @@log, @@fts, '
    + '@@transitions, @@label and every field validator are absent — add them by hand')

  const lines  = [
    '/// Generated by litestone introspect',
    '/// Note: @@gate, @@allow, @@deny, @allow, @secret, @guarded, @@log, @@fts,',
    '/// @@transitions, @@label and every field validator cannot be reverse-engineered',
    '/// from a SQLite database — it holds no access rules. Add them by hand.',
    '',
  ]

  // Collect enums discovered from CHECK constraints
  const enumDefs = {}   // enumName → Set<string>
  const columnEnumMap = {}  // `table.column` → enumName

  // First pass — detect enums
  const tableSqls = {}
  for (const tableName of Object.keys(schema)) {
    if (tableName === '__views' || !schema[tableName]?.columns) continue
    const row = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`
    ).get(tableName)
    tableSqls[tableName] = row?.sql ?? ''
  }

  // Every model name, before a single enum name is derived from one.
  const modelNames = new Set(Object.keys(schema)
    .filter(t => t !== '__views' && schema[t]?.columns)
    .map(tableNameToModelName))

  for (const [tableName, tableInfo] of Object.entries(schema)) {
    if (tableName === '__views' || !tableInfo?.columns) continue  // skip metadata keys
    const { columns } = tableInfo
    const modelName = tableNameToModelName(tableName)
    for (const col of columns) {
      const raw = detectEnumFromCheck(tableSqls[tableName], col.name)
      if (!raw) continue
      const vals = raw.filter(v => v !== '')
      if (vals.length !== raw.length)
        gap('select-not-an-enum', modelName, camelCase ? toCamelCase(col.name) : col.name,
            `CHECK admits the empty string`,
            'the empty string is dropped from the enum — .lite has no spelling for it, '
          + 'so the declared set is narrower than the CHECK')
      if (vals.length < 2) continue
      // Try to name the enum: ModelField
      const fieldName = camelCase ? toCamelCase(col.name) : col.name

      // model + field is a derived name, so it can land on one that is already
      // taken — by a MODEL (`SupplierScorecard.period` derives
      // `SupplierScorecardPeriod`, which is also a doctype) or by an enum an
      // earlier column derived. The model case is the one that does damage: the
      // parser resolves a field's type as an ENUM before a relation, so the
      // colliding model's own relation fields stop being relations and become
      // TEXT columns. Measured on erpnext, and it is the same collision
      // `frappe.js` grew a loop for — one producer was fixed and the other was
      // not looked at.
      let enumName = modelName + toPascalCase(fieldName)
      while (modelNames.has(enumName) || (enumDefs[enumName] && columnEnumMap[`${tableName}.${col.name}`] !== enumName)) {
        const alt = `${enumName}Enum`
        gap('enum-name-collision', modelName, fieldName,
            `${enumName} is already ${modelNames.has(enumName) ? 'a model' : 'an enum'}`,
            `named ${alt} instead — the set is intact and the NAME is this reader's`)
        enumName = alt
      }
      if (!enumDefs[enumName]) enumDefs[enumName] = new Set(vals)
      columnEnumMap[`${tableName}.${col.name}`] = enumName
    }
  }

  // Emit enums.
  //
  // A CHECK holds arbitrary strings and an enum member used to have to be a
  // legal identifier, so these were emitted bare and `Half-yearly` — a real
  // value in a real ERP — stopped the file at `Unexpected character '-'`. Since
  // FJS-593 a member may be a quoted string, which is the same spelling
  // `frappe.js` uses for the same reason. The empty string is not a member.
  const member = (v) => /^[A-Za-z_]\w*$/.test(v) ? v : `"${v.replace(/(["\\])/g, '\\$1')}"`
  for (const [name, vals] of Object.entries(enumDefs).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    lines.push(`enum ${name} {`)
    for (const v of vals) lines.push(`  ${member(v)}`)
    lines.push('}')
    lines.push('')
  }

  // Second pass — emit models.
  //
  // By NAME, and the enums above too. `sqlite_master` is in creation order, so a
  // table a migration rebuilt moves to the end of the file and a relation's
  // position comes from `PRAGMA foreign_key_list` — which means re-running the
  // converter over a database it already read produces a reshuffled file and an
  // unreadable diff. Nobody re-runs a converter whose output moves on its own.
  const byName = ([a], [b]) => a < b ? -1 : a > b ? 1 : 0
  for (const [tableName, tableData] of Object.entries(schema).sort(byName)) {
    if (tableName === '__views' || !tableData?.columns) continue
    const { columns, indexes, foreignKeys, strict } = tableData
    // The key's own column ORDER, which the column list cannot carry: `pk` off
    // `table_xinfo` is a boolean here, so emitting `@id` per column writes the
    // key in COLUMN order, and a table keyed `("userId","orgId")` came back as a
    // schema that builds `("orgId","userId")` with nothing said (`FJS-561`).
    // A primary key builds an implicit index and an implicit index is
    // prefix-matched, so that is a different key. `uniques` reads it off
    // `PRAGMA index_list`, in order.
    const compositePk = (tableData.uniques ?? [])
      .find(u => u.origin === 'pk' && u.cols.length > 1)?.cols ?? null
    const lostUnique = []
    const modelName = tableNameToModelName(tableName)

    // Build FK lookup: foreignKey column → { targetTable, targetCol, onDelete }
    const fkByCol = {}
    for (const fk of foreignKeys) {
      const fromCol = Array.isArray(fk.from) ? fk.from[0] : fk.from
      fkByCol[fromCol] = fk
    }

    // Detect soft delete
    const hasSoftDelete = columns.some(c => SOFT_DELETE_COLS.includes(c.name))

    lines.push(`model ${modelName} {`)

    // A relation field is virtual — it has no column — so its name has to be
    // invented, and it was invented from the TABLE IT POINTS AT. Two foreign
    // keys into one table then produce two fields with one name (`createdById`
    // and `updatedById` both become `user`), and a relation can take the name of
    // a real COLUMN — which is the one that loses data: the parser keeps one
    // field per name, so the column is gone from the next migration's table.
    // Measured on erpnext, where a self-reference on `amendedFrom` was named for
    // its table and deleted a `supplierScorecardPeriod` column on the way past.
    //
    // The name comes from the FK COLUMN instead, which is the convention the
    // emitter reads in the other direction: `@relation(fields: [authorId])` on a
    // field called `author`. Every scalar column is claimed first, so a relation
    // can never take one, and the fallbacks are tried in order.
    const taken = new Set(columns.map(c => camelCase ? toCamelCase(c.name) : c.name))
    const claim = (fk) => {
      const col   = Array.isArray(fk.from) ? fk.from[0] : fk.from
      const camel = camelCase ? toCamelCase(col) : col
      const cands = [camel.replace(/_?[Ii]d$/, ''),
                     camelCase ? toCamelCase(fk.table) : fk.table,
                     `${camel}Ref`]
      for (const c of cands) if (c && !taken.has(c)) { taken.add(c); return { name: c, forced: c !== cands[0] } }
      let i = 2, n
      do { n = `${cands[0] || 'ref'}${i++}` } while (taken.has(n))
      taken.add(n)
      return { name: n, forced: true }
    }

    // Emit relation fields (virtual, above FK columns)
    for (const fk of [...foreignKeys].sort((x, y) =>
      String(Array.isArray(x.from) ? x.from[0] : x.from).localeCompare(
      String(Array.isArray(y.from) ? y.from[0] : y.from)))) {
      const fromCol   = Array.isArray(fk.from) ? fk.from[0] : fk.from
      const toCol     = Array.isArray(fk.to)   ? fk.to[0]   : fk.to
      const refModel  = tableNameToModelName(fk.table)
      const claimed   = claim(fk)
      const fieldName = claimed.name
      if (claimed.forced)
        gap('field-name-collision', modelName, fieldName, `the relation on ${fromCol} could not take its natural name`,
            `named ${fieldName} — a relation field has no column, so it yields to every column and to the relations before it`)
      const fromField = camelCase ? toCamelCase(fromCol) : fromCol
      const toField   = camelCase ? toCamelCase(toCol)   : toCol
      const raw       = (fk.onDelete ?? '').toUpperCase()
      let   onDelete  = ''
      if (raw && raw !== 'NO ACTION') {
        const word = FK_ACTION[raw]
        if (word) onDelete = `, onDelete: ${word}`
        else gap('foreign-key-action', modelName, fieldName, `ON DELETE ${fk.onDelete}`,
                 'the relation is emitted with no action — .lite has no word for this one')
      }
      lines.push(`  ${fieldName}  ${refModel}  @relation(fields: [${fromField}], references: [${toField}]${onDelete})`)
    }

    // Emit scalar columns
    for (const col of columns) {
      const fieldName   = camelCase ? toCamelCase(col.name) : col.name
      const isFKCol     = col.name in fkByCol
      const enumKey     = `${tableName}.${col.name}`
      const enumName    = columnEnumMap[enumKey]
      const liteType    = enumName ? enumName : sqliteTypeToLite(col.type)
      const optional    = !col.notnull && !col.pk ? '?' : ''
      const attrs       = []

      // A composite key is declared once at the model level instead — the two
      // spellings are refused together, and only @@id states the order.
      if (col.pk && !compositePk)       attrs.push('@id')
      if (!col.notnull && !col.pk)      {} // optional suffix handles it
      const def     = renderDefault(col.default, liteType)
      const defAttr = def.attr
      if (defAttr)                      attrs.push(defAttr)
      if (def.expr) gap('dbgenerated-default', modelName, fieldName, `DEFAULT (${def.expr})`,
                        'no default — .lite has no spelling for an arbitrary SQL expression')

      // SQLite has five storage classes, so a column's .lite TYPE is a decision
      // the author makes and the database cannot hold: DateTime IS TEXT and
      // Boolean IS INTEGER, and reading them back as String and Int is faithful
      // to the file and thinner than the schema that wrote it. Reported only
      // where the DEFAULT is evidence — one row per TEXT column is one row per
      // column, and a report nobody reads is the same as no report.
      if (liteType === 'String' && defAttr === '@default(now())')
        gap('datetime-as-text', modelName, fieldName, 'TEXT DEFAULT (a clock function)',
            'String — DateTime is stored as exactly this, and only you know which it is')
      if (liteType === 'Int' && (col.default === '0' || col.default === '1'))
        gap('boolean-as-int', modelName, fieldName, `INTEGER DEFAULT ${col.default}`,
            'Int — Boolean is stored as exactly this, and only you know which it is')

      // A unique index over SOME rows is not @unique, and the difference is not
      // cosmetic: `WHERE deleted_at IS NULL` is uniqueness among LIVE rows, and
      // emitting it whole declares a STRONGER constraint than the database has
      // — one that then refuses writes the source accepted, permanently, since
      // a soft-deleted row keeps its slot (FJS-204, FJS-586). `.lite` cannot say
      // it, so it is handed over rather than approximated. Same call the corpus
      // converters already made.
      const soloUnique = indexes.find(idx => idx.unique && idx.cols.length === 1 && idx.cols[0] === col.name)
      if (soloUnique && !soloUnique.where) attrs.push('@unique')
      else if (soloUnique) {
        lostUnique.push(
          `  // FIXME: ${fieldName} is UNIQUE only where (${soloUnique.where}) — uniqueness over SOME rows, `
        + `which .lite cannot declare. @unique here would be stronger than the database it came from.`)
        gap('partial-index', modelName, fieldName, `UNIQUE WHERE (${soloUnique.where})`,
            'dropped whole — @unique without the predicate is STRONGER than the source')
      }

      // camelCase columns that differ from their DB name.
      //
      // Carried, not a gap: `@map` names the column the engine reads and writes
      // (`FJS-761`), so the camelCase reading is the one this tool defaults to
      // and the schema it writes reads the database it came from.
      if (camelCase && fieldName !== col.name) attrs.push(`@map("${col.name}")`)

      // A generated column reads like an ordinary one and is not one — nothing
      // writes it. Emitting it bare would produce a schema that says the column
      // is writable, which is a worse answer than the one this used to give
      // (`PRAGMA table_info` hid it entirely, so it was absent from the output).
      //
      // `@generated` takes SQL with `{field}` for a column, which is the inverse
      // of the expansion the parser does — so a `"col"` goes back to `{col}`. An
      // expression holding any other double quote cannot be spelled in that
      // string at all, and is handed over as a comment rather than mangled.
      if (col.generated) {
        const src = (col.generated.expr ?? '').replace(/"(\w+)"/g, '{$1}')
        const st  = col.generated.mode === 'stored' ? ', stored' : ''
        if (src && !src.includes('"')) attrs.push(`@generated("${src}"${st})`)
        else {
          lines.push(`  /// FIXME: ${fieldName} is GENERATED ALWAYS AS `
                   + `(${col.generated.expr ?? '?'}) ${col.generated.mode.toUpperCase()} — `
                   + `write it as @generated by hand`)
          gap('generated-expression', modelName, fieldName, col.generated.expr ?? '(unreadable)',
              'left as an ordinary column with a comment — @generated takes a double-quoted string')
        }
      }

      const attrStr = attrs.length ? '  ' + attrs.join(' ') : ''
      lines.push(`  ${fieldName}  ${liteType}${optional}${attrStr}`)
    }

    // Model-level attributes
    const modelAttrs = []

    // The name is derived BACKWARDS here and forwards by `ddl.js`, and the two
    // are not inverses: `orders` → `Order` → `order`. Every plural-table
    // database — which is Rails, Django, Laravel and most hand-written SQL —
    // therefore produced a schema whose every model named a table that does not
    // exist, and the first read was `no such table`. `@@map` is the escape
    // hatch, stated whenever the round trip does not land back on the real
    // name, which is the only fact this can check.
    if (tableNameFromModel(modelName) !== tableName)
      modelAttrs.push(`  @@map("${tableName}")`)

    if (!strict) modelAttrs.push('  @@noStrict')
    if (hasSoftDelete) modelAttrs.push('  @@softDelete')

    // Indexes.
    //
    // The two halves are NOT symmetrical, and that is the whole of this block.
    // Dropping the predicate from a UNIQUE index STRENGTHENS the constraint —
    // it refuses rows the source admitted — so a partial unique is handed over
    // rather than emitted. Dropping it from a plain index only WIDENS the index
    // — same rows answered, a bigger structure — so that is safe, and is what
    // happens when the predicate is one `@@index(where:)` cannot hold.
    const nameOf = c => (camelCase ? toCamelCase(c) : c)

    if (compositePk) modelAttrs.push(`  @@id([${compositePk.map(nameOf).join(', ')}])`)

    // Litestone derives an index's name from its COLUMNS, so it can hold one
    // index per column list — and a partial index is precisely what makes two
    // of them useful, so a real database has them. The generated schema keeps
    // the first and hands over the rest: emitting both produces a file that
    // does not parse, which for a converter is the whole product.
    const claimed = new Set()
    for (const idx of indexes) {
      const expr = idx.cols.find(c => isIndexExpression(c))
      if (expr) {
        modelAttrs.push(`  // FIXME: index "${idx.name}" is over the expression (${expr}) — .lite has no spelling for one.`)
        gap('index-expression', modelName, null, `${idx.name} ON (${expr})`, 'dropped — handed over as a comment')
        continue
      }

      // The index @@softDelete builds for ITSELF. Emitted as well, it is refused
      // by name — both are called idx_<table>_deletedAt, so the generated schema
      // cannot build the database it was read from, which for a converter is the
      // whole product. `@@softDelete` above is the declaration and it is already
      // there. This is the one index whose predicate is re-derivable, which is
      // exactly why it must not be restated.
      if (hasSoftDelete && !idx.unique && idx.cols.length === 1
          && /^deleted_?at$/i.test(idx.cols[0]) && isSoftDeleteClause(idx.where)) continue

      // A solo index with NO predicate is still dropped, which is the separate
      // gap FJS-480 names. One WITH a predicate is emitted, because the
      // predicate is the half nothing can re-derive from the column alone.
      const solo = idx.cols.length <= 1
      if (solo && (idx.unique || !idx.where)) continue

      const colList = idx.cols.map(nameOf).join(', ')
      // Only @@index can hold a direction — @@unique takes a plain field list.
      const sorted  = idx.cols.map((c, i) => nameOf(c) + (idx.sorts?.[i] ? sortArg(idx.sorts[i]) : '')).join(', ')
      if (idx.unique && idx.sorts?.some(Boolean))
        gap('index-modifier', modelName, null, `${idx.name} is UNIQUE and sorted (${idx.sorts.filter(Boolean).join(', ')})`,
            'emitted without the direction — @@unique takes a plain field list')
      const derived = `${idx.unique ? 'u:' : ''}${idx.cols.join('_')}`
      if (claimed.has(derived)) {
        modelAttrs.push(`  // FIXME: index "${idx.name}" is a second index over [${colList}]`
                      + `${idx.where ? ` — WHERE (${idx.where})` : ''}. Litestone names an index for its columns, `
                      + `so only one of them can be declared here.`)
        gap('index-collapsed', modelName, null, `${idx.name} over [${colList}]`,
            'dropped — litestone derives an index name from its columns, so it holds one per list')
        continue
      }
      claimed.add(derived)

      if (idx.unique) {
        if (!idx.where) {
          // Two NULLs never compare equal, so SQLite's index admits rows that
          // leave a member unset — and litestone refuses the bare form for
          // exactly that reason (FJS-D130). `nullsDistinct: true` is SQL's own
          // word for what the source database is already doing, so it is what
          // the source database MEANS; without it the generated file does not
          // parse.
          const nullable = idx.cols.some(c => {
            const col = columns.find(x => x.name === c)
            return col && !col.notnull && !col.pk
          })
          modelAttrs.push(`  @@unique([${colList}]${nullable ? ', nullsDistinct: true' : ''})`)
          continue
        }
        modelAttrs.push(
          `  // FIXME: [${colList}] is UNIQUE only where (${idx.where}) — uniqueness over SOME rows, `
        + `which .lite cannot declare. @@unique here would be stronger than the database it came from.`)
        gap('partial-index', modelName, null, `UNIQUE [${colList}] WHERE (${idx.where})`,
            'dropped whole — @@unique without the predicate is STRONGER than the source')
        continue
      }

      if (!idx.where)                    { modelAttrs.push(`  @@index([${sorted}])`); continue }
      // @@softDelete already gives every index on this model that clause, and
      // declaring it as well is refused, so it round-trips as a plain @@index.
      if (hasSoftDelete && isSoftDeleteClause(idx.where)) { modelAttrs.push(`  @@index([${sorted}])`); continue }

      const declared = declaredPredicate(idx.where, hasSoftDelete)
      const lite     = predicateToLite(declared, nameOf)
      if (lite) modelAttrs.push(`  @@index([${sorted}], where: ${lite})`)
      else {
        modelAttrs.push(`  @@index([${sorted}])`)
        gap('partial-index', modelName, null, `${idx.name} WHERE (${declared})`,
            'a plain index — it answers the same rows and is only larger')
        modelAttrs.push(`  // NOTE: index "${idx.name}" was partial — WHERE (${declared}). `
                      + `A plain index answers the same rows and is only larger; the predicate is not one .lite can hold.`)
      }
    }

    // ─── uniqueness the TABLE declares ───────────────────────────────────
    //
    // `email TEXT UNIQUE` and `UNIQUE (a, b)` build IMPLICIT indexes, whose
    // `sql` in `sqlite_master` is NULL — so the index walk above reaches
    // neither, and both were dropped with nothing said. A database adopted
    // through this door then declared no uniqueness at all, and `--strict`
    // passed: the one construct whose absence a later `db push` would ENFORCE
    // by rebuilding the table without it.
    //
    // `PRAGMA index_list` is where they are, which is the same reader the
    // migration differ uses for the same blind spot one layer over. `origin`
    // separates them: 'pk' is the primary key (already emitted), 'c' is an
    // explicit CREATE UNIQUE INDEX (the walk above has it), 'u' is a table
    // constraint and is what this carries.
    const declaredUniques = (tableData.uniques ?? []).filter(u => u.origin === 'u')

    for (const u of declaredUniques) {
      const fields = u.cols.map(nameOf)
      // A single column is said on the field, where a reader looks for it —
      // unless the walk above already put it there off an explicit index.
      if (fields.length === 1) {
        const line = lines.findIndex(l => new RegExp(`^  ${fields[0]}\\s`).test(l))
        if (line !== -1 && !/@unique/.test(lines[line])) lines[line] += '  @unique'
        continue
      }
      // A composite naming a NULLABLE column is refused at parse (`FJS-D130`),
      // and a schema that will not parse is not an import. The database has the
      // constraint either way, so it is handed over rather than approximated.
      const nullable = u.cols.filter(c => columns.find(col => col.name === c && !col.notnull))
      if (nullable.length) {
        gap('table-unique', modelName, null, `UNIQUE (${u.cols.join(', ')})`,
            `dropped — a composite @@unique naming a nullable column (${nullable.map(nameOf).join(', ')}) is a parse error`)
        modelAttrs.push(`  // FIXME: the table declares UNIQUE (${u.cols.join(', ')}), and .lite refuses a composite `
                      + `@@unique over a nullable column — two NULLs never compare equal, so the constraint holds `
                      + `only where nobody doubted it. State nullsDistinct: true to mean it, or move the column into a where:.`)
        continue
      }
      modelAttrs.push(`  @@unique([${fields.join(', ')}])`)
    }

    // ─── CHECK ───────────────────────────────────────────────────────────
    //
    // Carried only when every identifier in it survives unrenamed. The stored
    // text names COLUMNS and `@@check` is written in FIELD names, so a table
    // whose columns were camelCased would emit an expression naming columns
    // that no longer exist under those spellings — a schema that builds a
    // constraint against the wrong thing is worse than one that says it could
    // not carry it. The enum detector has already consumed `col IN (...)`.
    // A CHECK that became an ENUM has already been carried, in the one form
    // this language has for it — the column's type. Emitting it again as a
    // @@check would restate the same rule twice, and the second copy names
    // string literals the enum has since given names to.
    const asEnum = new Set(columns
      .filter(c => columnEnumMap[`${tableName}.${c.name}`])
      .map(c => c.name))

    for (const expr of tableData.checks ?? []) {
      if (!expr) continue
      if ([...asEnum].some(c => new RegExp(`(^|[^\\w"])"?${c}"?\\s+IN\\s*\\(`, 'i').test(expr))) continue

      // `@@check` is written in FIELD names, and a camelCase reading renames the
      // columns it references — so the expression is rewritten into the names
      // this model actually declares. `mapIdentifiers` is the same walk `ddl.js`
      // runs in the other direction when it emits the constraint, which is what
      // makes the round trip exact; a word this table has no column for is a
      // function or a keyword and is left alone.
      const byColumn = new Map(columns.map(c => [c.name, nameOf(c.name)]))
      const rewritten = mapIdentifiers(expr, (id) => {
        const field = byColumn.get(id)
        return field && field !== id ? field : null
      })
      modelAttrs.push(`  @@check(${JSON.stringify(rewritten)})`)
    }

    for (const line of lostUnique) modelAttrs.push(line)

    for (const attr of modelAttrs) lines.push(attr)

    lines.push('}')
    lines.push('')
  }

  return { lite: lines.join('\n').trimEnd() + '\n', gaps, summary: summarize(gaps) }
}
