// rails-to-lite.mjs — a Rails `db/schema.rb`, converted mechanically to .lite.
//
// The second front-end, and it exists for the constructs Prisma cannot express
// at all: single-table inheritance, partial indexes, and the (type, id)
// polymorphic pair. Three Prisma schemas largely agree with each other; a Rails
// one disagrees, which is the only reason to add it.
//
// Same contract as prisma-to-lite.mjs: the output is not the artifact, the
// refusal list is. It never repairs and never guesses.
//
// Two Rails facts drive most of the work:
//   · a column is NULLABLE unless `null: false`, the opposite of .lite's default
//   · a table is snake_case PLURAL and a model is PascalCase SINGULAR
//     (Invariant 2), so every name goes through @frontierjs/toolbelt/inflect —
//     the one owner — and the original is kept with @map.

import { singularize } from '@frontierjs/toolbelt/inflect'
import { detectPolymorphic } from './polymorphic.mjs'

// Rails column type → .lite type. `decimal` is handled separately (it carries a
// scale), and anything absent here is recorded rather than guessed.
const TYPES = {
  string: 'String', text: 'String', citext: 'String', uuid: 'String',
  inet: 'String', cidr: 'String', macaddr: 'String', xml: 'String',
  integer: 'Int', bigint: 'Int', smallint: 'Int',
  float: 'Float', boolean: 'Boolean',
  datetime: 'DateTime', timestamp: 'DateTime', date: 'DateTime', time: 'DateTime',
  json: 'Json', jsonb: 'Json',
  binary: 'Bytes',
}

const pascal = (snake) => snake.split('_').filter(Boolean)
  .map(p => p[0].toUpperCase() + p.slice(1)).join('')
const camel  = (snake) => { const p = pascal(snake); return p[0].toLowerCase() + p.slice(1) }
const modelOf = (table) => pascal(singularize(table))

export function convert(src, label = 'schema') {
  const gaps = []
  const gap = (kind, model, field, detail, emitted) =>
    gaps.push({ repo: label, kind, model, field, detail, emitted })

  const tables = readTables(src, gap)
  readForeignKeys(src, tables, gap)

  const lite = [...tables.values()].map(t => emitTable(t, tables, gap)).join('\n')
  detectPolymorphic(lite, gap)
  return { lite, gaps, models: [...tables.values()].map(t => t.model) }
}

// ─── reading ─────────────────────────────────────────────────────────────────

function readTables(src, gap) {
  const tables = new Map()
  const lines  = src.split('\n')
  let cur = null

  for (const raw of lines) {
    const line = raw.trim()

    const open = line.match(/^create_table "([^"]+)"(?:, (.*?))? do \|t\|$/)
    if (open) {
      const [, table, opts = ''] = open
      cur = { table, model: modelOf(table), cols: [], indexes: [], fks: [], opts }
      tables.set(table, cur)

      // `id: false` is a join table or a table keyed by something else; .lite
      // has no composite @@id (FJS-561), so it takes a surrogate and says so.
      if (/\bid:\s*false\b/.test(opts))
        gap('no-primary-key', cur.model, null, `create_table "${table}", id: false`,
            'surrogate `id String @id @default(cuid())` added — the real key is whatever @@unique names')
      else {
        const idType = opts.match(/\bid:\s*:(\w+)/)?.[1] ?? 'bigint'
        cur.idType = idType === 'uuid' ? 'String' : 'Int'
        if (/\bdefault:\s*->/.test(opts))
          gap('dbgenerated-default', cur.model, 'id', opts.match(/default:\s*->\s*\{([^}]*)\}/)?.[1]?.trim() ?? 'lambda',
              'dropped — a database-generated default has no .lite spelling')
      }
      continue
    }

    if (cur && line === 'end') { cur = null; continue }

    if (cur && line.startsWith('t.index ')) { cur.indexes.push(line); continue }
    if (cur && line.startsWith('t.')) { cur.cols.push(line); continue }
  }
  return tables
}

function readForeignKeys(src, tables, gap) {
  for (const line of src.split('\n')) {
    const m = line.trim().match(/^add_foreign_key "([^"]+)", "([^"]+)"(?:, (.*))?$/)
    if (!m) continue
    const [, child, parent, opts = ''] = m
    const t = tables.get(child)
    if (!t) continue
    t.fks.push({
      parent,
      column:   opts.match(/column:\s*"([^"]+)"/)?.[1] ?? `${singularize(parent)}_id`,
      primary:  opts.match(/primary_key:\s*"([^"]+)"/)?.[1] ?? 'id',
      onDelete: opts.match(/on_delete:\s*:(\w+)/)?.[1] ?? null,
      validate: /validate:\s*false/.test(opts),
    })
  }
}

// ─── emitting ────────────────────────────────────────────────────────────────

function emitTable(t, tables, gap) {
  const out = [`model ${t.model} {`]
  const byColumn = new Map()

  out.push(t.idType === 'String'
    ? '  id String @id @default(uuid())'
    : t.idType === 'Int' ? '  id Int @id @default(autoincrement())'
    : '  id String @id @default(cuid())')

  const fkByColumn = new Map(t.fks.map(f => [f.column, f]))

  for (const raw of t.cols) {
    const col = readColumn(raw, t, gap)
    if (!col) continue
    byColumn.set(col.name, col)

    const fk = fkByColumn.get(col.name)
    if (fk) {
      const target = tables.get(fk.parent)
      if (target) {
        const action = fk.onDelete === 'cascade' ? ', onDelete: Cascade'
          : fk.onDelete === 'nullify' ? ', onDelete: SetNull' : ''
        col.relation = { field: camel(col.name.replace(/_id$/, '')), target: target.model, action }
        if (fk.validate)
          gap('unvalidated-foreign-key', t.model, col.name, 'add_foreign_key … validate: false',
              'emitted as an ordinary relation — Postgres NOT VALID has no .lite spelling, and the existing rows may violate it')
      }
    }
    out.push(renderColumn(col))
    if (col.relation)
      out.push(`  ${col.relation.field} ${col.relation.target}${col.optional ? '?' : ''} ` +
               `@relation(fields: [${camel(col.name)}], references: [id]${col.relation.action})`)
  }

  // Dropping a partial predicate or an opclass can make two DIFFERENT source
  // indexes identical, and litestone derives an index name from its columns, so
  // emitting both is one CREATE INDEX twice.
  const seen = new Set()
  for (const raw of t.indexes) {
    const a = emitIndex(raw, t, byColumn, gap)
    if (!a) continue
    if (seen.has(a)) {
      gap('index-collapsed', t.model, null, a, 'dropped — identical to an earlier index once its predicate or modifiers were stripped')
      continue
    }
    seen.add(a)
    out.push(`  ${a}`)
  }

  out.push('}', '')
  return out.join('\n')
}

function readColumn(raw, t, gap) {
  // t.string "name", default: "", null: false, array: true
  const m = raw.match(/^t\.(\w+)\s+"([^"]+)"(?:,\s*(.*))?$/)
  if (!m) { gap('unparsed-line', t.model, null, raw.slice(0, 80), 'dropped'); return null }
  const [, railsType, name, opts = ''] = m

  let type = TYPES[railsType]
  const extra = []

  if (railsType === 'decimal') {
    const scale = opts.match(/scale:\s*(\d+)/)?.[1]
    if (scale && +scale <= 9) { type = 'Int'; extra.push(`@scale(${scale})`) }
    else if (scale) {
      type = 'Float'
      gap('scale-over-9', t.model, name, `decimal scale: ${scale}`,
          'Float — @scale caps at 9 places, because the minor-unit integer runs out of room in front of the point')
    } else {
      type = 'Float'
      gap('decimal-no-precision', t.model, name, 'decimal with no scale:', 'Float — no scale to carry')
    }
  } else if (!type) {
    type = 'String'
    gap('unknown-column-type', t.model, name, `t.${railsType}`, 'String — no .lite equivalent, and the values are unknown')
  }

  const isArray  = /\barray:\s*true\b/.test(opts)
  // Rails columns are NULLABLE unless told otherwise — the opposite of .lite.
  const optional = !/\bnull:\s*false\b/.test(opts)

  const def = opts.match(/\bdefault:\s*(->\s*\{[^}]*\}|"(?:[^"\\]|\\.)*"|\[[^\]]*\]|\{[^}]*\}|[^,]+)/)?.[1]?.trim()
  if (def !== undefined) {
    if (/^->/.test(def))
      gap('dbgenerated-default', t.model, name, def.slice(0, 50), 'dropped — no .lite spelling for a database-generated default')
    else if (isArray || /^\[/.test(def))
      gap('array-default', t.model, name, `${railsType}[] default: ${def}`,
          'dropped — .lite refuses every array default, the empty one included (FJS-564)')
    else if (/^\{/.test(def))
      gap('json-object-default', t.model, name, `default: ${def}`,
          `@default("${def.replace(/"/g, '\\"')}") is the .lite spelling for a Json default — emitted as a string`)
    else if (def === 'nil') { /* nothing to say */ }
    else extra.push(`@default(${railsDefault(def, type)})`)
  }

  return { name, type, optional, isArray, extra, relation: null }
}

function railsDefault(def, type) {
  if (type === 'Boolean') return def === 'true' ? 'true' : 'false'
  if (type === 'DateTime' && /now|current_timestamp/i.test(def)) return 'now()'
  if (/^".*"$/.test(def)) return def
  if (/^-?\d+(\.\d+)?$/.test(def)) return def
  return JSON.stringify(def.replace(/^"|"$/g, ''))
}

function renderColumn(col) {
  const name = camel(col.name)
  const bits = [...col.extra]
  if (name !== col.name) bits.unshift(`@map("${col.name}")`)
  const t = col.type + (col.isArray ? '[]' : '') + (col.optional ? '?' : '')
  return `  ${name} ${t}${bits.length ? ' ' + bits.join(' ') : ''}`
}

function emitIndex(raw, t, byColumn, gap) {
  const cols = raw.match(/^t\.index \[([^\]]*)\]/)?.[1]
  if (!cols) return null

  const names = cols.split(',').map(c => c.trim().replace(/^"|"$/g, ''))
    .filter(c => byColumn.has(c)).map(camel)
  if (!names.length) return null

  // A partial index is a different object — `unique … where deleted_at IS NULL`
  // is uniqueness among LIVE rows, which .lite cannot say, so emitting it whole
  // would be a stronger constraint than the source has.
  const where = raw.match(/where:\s*"((?:[^"\\]|\\.)*)"/)?.[1]
  const unique = /unique:\s*true/.test(raw)
  if (where) {
    gap('partial-index', t.model, names.join(', '), `${unique ? 'unique ' : ''}index where: ${where.slice(0, 60)}`,
        unique ? 'DROPPED — emitting it unconditionally would be a stronger constraint than the source declares'
               : 'emitted without the predicate — an ordinary index over the same columns')
    if (unique) return null
  }
  if (/opclass:|using:\s*:g/.test(raw))
    gap('index-modifier', t.model, names.join(', '), raw.trim().slice(0, 70), 'modifiers stripped')

  if (unique) {
    const nullable = names.filter(n => {
      const src = [...byColumn.values()].find(c => camel(c.name) === n)
      return src?.optional
    })
    if (nullable.length && names.length > 1) {
      gap('composite-unique-over-nullable', t.model, null,
          `@@unique([${names.join(', ')}]) with ${nullable.join(', ')} nullable`,
          "nullsDistinct: true — SQL's own word for what SQLite already does (FJS-D130)")
      return `@@unique([${names.join(', ')}], nullsDistinct: true)`
    }
    return `@@unique([${names.join(', ')}])`
  }
  return `@@index([${names.join(', ')}])`
}
