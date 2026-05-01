// ddl.js — schema AST → SQLite DDL
// Takes the output of parse() and produces CREATE TABLE / CREATE INDEX / etc.

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

// Basic English pluralizer — covers 95% of real model names.
// @@map is the escape hatch for anything irregular.
function pluralizeWord(word) {
  if (/(?:s|x|z|ch|sh)$/i.test(word)) return word + 'es'  // bus→buses, box→boxes
  if (/[^aeiou]y$/i.test(word))        return word.slice(0, -1) + 'ies'  // category→categories
  // common irregulars
  const irregulars = {
    person: 'people', child: 'children', man: 'men', woman: 'women',
    tooth: 'teeth',   foot: 'feet',      mouse: 'mice', goose: 'geese',
    ox: 'oxen',       leaf: 'leaves',    life: 'lives', knife: 'knives',
    index: 'indices', matrix: 'matrices', vertex: 'vertices',
    analysis: 'analyses', basis: 'bases', crisis: 'crises',
    datum: 'data', medium: 'media', criterion: 'criteria',
  }
  const lower = word.toLowerCase()
  if (irregulars[lower]) return word.slice(0, word.length - lower.length) + irregulars[lower]
  return word + 's'
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

function sqlType(fieldType) {
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
  if (v.kind === 'fieldRef') return null  // runtime-only — copied from sibling field at write time
  if (v.kind === 'call') {
    if (v.fn === 'auth') return null  // runtime-only — stamped from ctx.auth, not a SQL DEFAULT
    switch (v.fn) {
      case 'now':   return `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
      case 'uuid':  return `(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))))`
      case 'cuid':  return null  // no native SQLite equivalent — client generates at insert time
      case 'ulid':  return null  // no native SQLite equivalent — client generates at insert time
      default:      return null
    }
  }
  return null
}

// ─── Column definition ────────────────────────────────────────────────────────

function columnDef(field, schema = null) {
  const parts = [`  "${field.name}" ${sqlType(field.type)}`]

  // NOT NULL — unless optional, and not for GENERATED/funcCall columns
  // SQLite rejects NOT NULL on GENERATED ALWAYS AS columns
  const isGenerated = field.attributes.find(a => a.kind === 'generated' || a.kind === 'funcCall')
  if (field.type.array) {
    // Arrays: always NOT NULL (empty array is the null state), always default to '[]'
    parts.push('NOT NULL')
  } else if (!field.type.optional && !isGenerated) {
    parts.push('NOT NULL')
  }

  // PRIMARY KEY (single-column — composite handled at table level)
  const isId = field.attributes.find(a => a.kind === 'id')
  if (isId) parts.push('PRIMARY KEY')

  // UNIQUE
  const isUnique = field.attributes.find(a => a.kind === 'unique')
  if (isUnique) parts.push('UNIQUE')

  // DEFAULT — @updatedAt implies DEFAULT now() so INSERT works without supplying the value
  const updatedAtAttr = field.attributes.find(a => a.kind === 'updatedAt')
  const def  = field.attributes.find(a => a.kind === 'default')
  const expr = defaultExpr(def) ?? (updatedAtAttr ? `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` : null)
  if (expr) parts.push(`DEFAULT ${expr}`)

  // Array default — always '[]', overrides any @default
  if (field.type.array) {
    const hasDefault = field.attributes.find(a => a.kind === 'default')
    if (!hasDefault) parts.push(`DEFAULT '[]'`)
    parts.push(`CHECK (json_valid("${field.name}") AND json_type("${field.name}") = 'array')`)
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

  // CHECK
  const chk = field.attributes.find(a => a.kind === 'check')
  if (chk) parts.push(`CHECK (${chk.expr})`)

  return parts.join(' ')
}

// ─── Table constraints ────────────────────────────────────────────────────────

function tableConstraints(model) {
  const lines = []

  // Composite primary key — if more than one @id field
  const pkFields = model.fields.filter(f => f.attributes.find(a => a.kind === 'id'))
  if (pkFields.length > 1) {
    const cols = pkFields.map(f => `"${f.name}"`).join(', ')
    lines.push(`  PRIMARY KEY (${cols})`)
  }

  // @@unique constraints
  for (const attr of model.attributes) {
    if (attr.kind === 'uniqueIndex') {
      const cols = attr.fields.map(f => `"${f}"`).join(', ')
      lines.push(`  UNIQUE (${cols})`)
    }
  }

  // Foreign keys from @relation attributes
  for (const field of model.fields) {
    const rel = field.attributes.find(a => a.kind === 'relation')
    if (!rel?.fields) continue  // skip back-reference fields (no fields: [...])

    const fromCols = rel.fields.map(f => `"${f}"`).join(', ')
    const toCols   = rel.references.map(f => `"${f}"`).join(', ')
    let fk = `  FOREIGN KEY (${fromCols}) REFERENCES "${field.type.name}" (${toCols})`
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
  const enumDef = schema.enums.find(e => e.name === field.type.name)
  if (!enumDef) return null
  const values = enumDef.values.map(v => `'${v.name}'`).join(', ')
  return `  CHECK ("${field.name}" IN (${values}))`
}

// ─── CREATE TABLE ─────────────────────────────────────────────────────────────

function createTable(model, schema, tableName) {  // schema needed for funcCall expansion; tableName pre-derived
  const strict = isStrict(model)

  // Exclude relation navigation fields (virtual, no column) and @computed/@from fields (app-layer only).
  // @generated fields ARE included — they become GENERATED ALWAYS AS columns in SQLite.
  const columnFields = model.fields.filter(f =>
    f.type.kind !== 'relation' &&
    !f.attributes.find(a => a.kind === 'computed') &&
    !f.attributes.find(a => a.kind === 'from')
  )

  const colDefs      = columnFields.map(f => columnDef(f, schema))
  const enumChecks   = columnFields.map(f => enumCheck(f, schema)).filter(Boolean)
  const constraints  = tableConstraints(model)
  const allDefs      = [...colDefs, ...enumChecks, ...constraints]

  const strictClause = strict ? ' STRICT' : ''
  const body = allDefs.join(',\n')

  return `CREATE TABLE IF NOT EXISTS "${tableName}" (\n${body}\n)${strictClause};`
}

// ─── CREATE INDEX ─────────────────────────────────────────────────────────────

function createIndexes(model, softDelete = false, tableName) {
  const lines = []
  const partial = softDelete ? ` WHERE "deletedAt" IS NULL` : ''

  for (const attr of model.attributes) {
    if (attr.kind !== 'index') continue
    const cols   = attr.fields.map(f => `"${f}"`).join(', ')
    // Partial indexes on soft-delete tables — only index live rows.
    // Smaller index, better cache fit, faster queries.
    lines.push(`CREATE INDEX IF NOT EXISTS "idx_${tableName}_${attr.fields.join('_')}" ON "${tableName}" (${cols})${partial};`)
  }

  // Auto-generate a partial index on deletedAt itself for soft-delete tables.
  // Makes WHERE deletedAt IS NULL counts and existence checks very fast.
  if (softDelete) {
    lines.push(`CREATE INDEX IF NOT EXISTS "idx_${tableName}_deletedAt" ON "${tableName}" ("deletedAt") WHERE "deletedAt" IS NULL;`)
  }

  return lines
}

// ─── CREATE VIRTUAL TABLE (FTS5) ──────────────────────────────────────────────

function createFts(model, tableName) {
  const fts = model.attributes.find(a => a.kind === 'fts')
  if (!fts) return null

  const contentCols   = fts.fields.join(', ')
  const hasSoftDelete = model.attributes.some(a => a.kind === 'softDelete')
  const parts = [
    `CREATE VIRTUAL TABLE IF NOT EXISTS "${tableName}_fts" USING fts5(`,
    `  ${contentCols},`,
    `  content="${tableName}",`,
    `  content_rowid="id"`,
    `);`,
    ``,
    `-- Triggers to keep FTS index in sync`,
    `CREATE TRIGGER IF NOT EXISTS "${tableName}_fts_insert" AFTER INSERT ON "${tableName}" BEGIN`,
    `  INSERT INTO "${tableName}_fts"(rowid, ${contentCols}) VALUES (new.id, ${fts.fields.map(f => `new.${f}`).join(', ')});`,
    `END;`,
    `CREATE TRIGGER IF NOT EXISTS "${tableName}_fts_delete" AFTER DELETE ON "${tableName}" BEGIN`,
    `  INSERT INTO "${tableName}_fts"("${tableName}_fts", rowid, ${contentCols}) VALUES ('delete', old.id, ${fts.fields.map(f => `old.${f}`).join(', ')});`,
    `END;`,
    `CREATE TRIGGER IF NOT EXISTS "${tableName}_fts_update" AFTER UPDATE ON "${tableName}" BEGIN`,
    `  INSERT INTO "${tableName}_fts"("${tableName}_fts", rowid, ${contentCols}) VALUES ('delete', old.id, ${fts.fields.map(f => `old.${f}`).join(', ')});`,
    `  INSERT INTO "${tableName}_fts"(rowid, ${contentCols}) VALUES (new.id, ${fts.fields.map(f => `new.${f}`).join(', ')});`,
    `END;`,
  ]

  // On @@softDelete models, soft-deleting (setting deletedAt) should remove
  // the row from the FTS index so deleted records don't show up in searches.
  if (hasSoftDelete) {
    parts.push(
      ``,
      `-- Remove from FTS index on soft delete (deletedAt set)`,
      `CREATE TRIGGER IF NOT EXISTS "${tableName}_fts_soft_delete" AFTER UPDATE OF "deletedAt" ON "${tableName}"`,
      `WHEN old."deletedAt" IS NULL AND new."deletedAt" IS NOT NULL BEGIN`,
      `  INSERT INTO "${tableName}_fts"("${tableName}_fts", rowid, ${contentCols}) VALUES ('delete', old.id, ${fts.fields.map(f => `old.${f}`).join(', ')});`,
      `END;`,
      `-- Re-add to FTS index on restore (deletedAt cleared)`,
      `CREATE TRIGGER IF NOT EXISTS "${tableName}_fts_restore" AFTER UPDATE OF "deletedAt" ON "${tableName}"`,
      `WHEN old."deletedAt" IS NOT NULL AND new."deletedAt" IS NULL BEGIN`,
      `  INSERT INTO "${tableName}_fts"(rowid, ${contentCols}) VALUES (new.id, ${fts.fields.map(f => `new.${f}`).join(', ')});`,
      `END;`,
    )
  }

  return parts.join('\n')
}


// ─── updatedAt trigger ────────────────────────────────────────────────────────
// If a model has an `updatedAt DateTime` field (without @hardDelete or any
// special flag — just the field name), generate an AFTER UPDATE trigger that
// sets it to the current UTC timestamp automatically.
//
// This fires at the SQLite level, so it works correctly for:
//   - client writes (update, updateMany)
//   - direct SQL writes
//   - migrations that modify rows

function createUpdatedAtTrigger(model, tableName) {
  const hasUpdatedAt = model.fields.find(
    f => f.name === 'updatedAt' && f.type.name === 'DateTime'
  )
  if (!hasUpdatedAt) return null

  return [
    `-- Auto-update updatedAt on every row change`,
    `CREATE TRIGGER IF NOT EXISTS "${tableName}_updatedAt"`,
    `AFTER UPDATE ON "${tableName}"`,
    `WHEN NEW."updatedAt" = OLD."updatedAt"`,
    `BEGIN`,
    `  UPDATE "${tableName}" SET "updatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE rowid = NEW.rowid;`,
    `END;`,
  ].join('\n')
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
    const cycle = models.filter(m => !sorted.includes(m)).map(m => m.name)
    throw new Error(`Circular foreign key reference detected between: ${cycle.join(', ')}`)
  }

  return sorted
}

// ─── Implicit M2M ─────────────────────────────────────────────────────────────
// Detect mutual Model[] fields (no @relation) and generate a join table for each.
// Join table name: _modela_modelb (alphabetical, lowercase)
// Columns:        modelaId, modelbId (camelCase of model name + "Id")

export function detectM2MPairs(schema) {
  const pairs = []
  const seen  = new Set()

  for (const model of schema.models) {
    for (const field of model.fields) {
      if (field.type.kind !== 'implicitM2M') continue
      const [a, b] = [model.name, field.type.name].sort()
      const key    = `${a}__${b}`
      if (seen.has(key)) continue
      seen.add(key)

      const colA      = a.charAt(0).toLowerCase() + a.slice(1) + 'Id'
      const colB      = b.charAt(0).toLowerCase() + b.slice(1) + 'Id'
      const joinTable = `_${a.toLowerCase()}_${b.toLowerCase()}`
      pairs.push({ modelA: a, modelB: b, joinTable, colA, colB })
    }
  }
  return pairs
}

export function generateJoinTableDDL(pair, ifNotExists = true) {
  const ie = ifNotExists ? 'IF NOT EXISTS ' : ''
  return [
    `CREATE TABLE ${ie}"${pair.joinTable}" (`,
    `  "${pair.colA}" INTEGER NOT NULL REFERENCES "${pair.modelA}"("id") ON DELETE CASCADE,`,
    `  "${pair.colB}" INTEGER NOT NULL REFERENCES "${pair.modelB}"("id") ON DELETE CASCADE,`,
    `  PRIMARY KEY ("${pair.colA}", "${pair.colB}")`,
    `) STRICT;`,
    `CREATE INDEX IF NOT EXISTS "${pair.joinTable}_${pair.colB}_idx" ON "${pair.joinTable}"("${pair.colB}");`,
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

    parts.push(createTable(model, schema, tableName))

    const indexes = createIndexes(model, isSoftDelete(model), tableName)
    if (indexes.length) parts.push(indexes.join('\n'))

    const fts = createFts(model, tableName)
    if (fts) parts.push(fts)

    const updatedAt = createUpdatedAtTrigger(model, tableName)
    if (updatedAt) parts.push(updatedAt)

    sections.push(parts.join('\n'))
  }

  // Implicit m2m join tables (generated after all models so FKs resolve)
  const m2mPairs = detectM2MPairs(schema)
  for (const pair of m2mPairs) {
    sections.push(generateJoinTableDDL(pair))
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
  return createTable(model, schema, modelToTableName(model, pluralize))
}

/**
 * Generate just the indexes for a model.
 */
export function generateIndexDDL(model, softDelete = false, { pluralize = false } = {}) {
  return createIndexes(model, softDelete ?? isSoftDelete(model), modelToTableName(model, pluralize))
}
