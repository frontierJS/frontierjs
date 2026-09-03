// sql.js — a PostgreSQL `pg_dump --schema-only` or Rails `structure.sql`, read
// into .lite.
//
// The reader that reaches surfaces the other three cannot put any input in front
// of: a dump carries CHECK constraints, views and native enums, none of which
// Prisma has and Rails' schema.rb mostly does not.
//
// Same contract as its siblings — the output is not the whole answer, the
// refusal list is; it never repairs and never guesses.
//
// Two shapes make a dump harder to read than a schema.rb:
//   · keys and foreign keys arrive as separate ALTER TABLE statements, split
//     across lines, long after the table
//   · almost everything is noise — sequences, functions, triggers, COMMENT ON,
//     SET, ACL — so the reader is a whitelist and records what it skipped

import { singularize } from '@frontierjs/toolbelt/inflect'
import { detectPolymorphic } from './polymorphic.js'
import { BIGINT_EMITTED, namesATable } from './wide-int.js'
import { predicateToLite } from '../core/migrate.js'

const pascal = (s) => s.split('_').filter(Boolean).map(p => p[0].toUpperCase() + p.slice(1)).join('')
const camel  = (s) => { const p = pascal(s); return p[0].toLowerCase() + p.slice(1) }
const modelOf = (t) => pascal(singularize(t))
// A dump qualifies every name with its schema. Stripping only `public.` let
// `partman.template_x` through as a model name with a dot in it, which is not
// an identifier.
const bare   = (id) => id.replace(/"/g, '').replace(/^[a-z_]\w*\./i, '')

export function convert(src, label = 'schema') {
  const gaps = []
  const gap = (kind, model, field, detail, emitted) =>
    gaps.push({ source: label, kind, model, field, detail, emitted })

  const statements = split(src)
  const enums  = new Map()
  const tables = new Map()

  for (const st of statements) readStatement(st, enums, tables, gap)

  const out = []
  for (const [name, values] of enums) out.push(`enum ${pascal(name)} {`, ...values.map(v => '  ' + enumValue(v)), '}', '')
  for (const t of tables.values()) out.push(...emitTable(t, tables, enums, gap))

  const lite = out.join('\n')
  detectPolymorphic(lite, gap)
  return { lite, gaps, models: [...tables.values()].map(t => t.model) }
}

// A dollar-quoted function body may hold anything, semicolons included, so
// those are removed before the file is cut into statements at all.
function split(src) {
  return src
    .replace(/\$\$[\s\S]*?\$\$/g, "'<body>'")
    .split(/;\s*\n/)
    .map(s => s.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function enumValue(v) {
  const clean = v.replace(/^'|'$/g, '')
  // .lite enum values are identifiers; a value that is not one has to be said
  // some other way, so it is kept verbatim and the caller is told.
  return /^[A-Za-z_]\w*$/.test(clean) ? clean : clean.replace(/[^\w]/g, '_')
}

// ─── statements ──────────────────────────────────────────────────────────────

function readStatement(st, enums, tables, gap) {
  let m

  if ((m = st.match(/^CREATE TYPE ([\w."]+) AS ENUM \((.*)\)$/i))) {
    enums.set(bare(m[1]), m[2].split(',').map(v => v.trim()).filter(Boolean))
    return
  }

  if ((m = st.match(/^CREATE TABLE (?:IF NOT EXISTS )?([\w."]+) \((.*)\)(?: PARTITION BY .*)?$/i))) {
    const table = bare(m[1])
    const schema = m[1].replace(/"/g, '').match(/^([a-z_]\w*)\./i)?.[1]
    const t = { table, model: modelOf(table), cols: [], checks: [], pk: [], fks: [], indexes: [], arcs: [] }
    if (tables.has(table)) {
      gap('table-name-collision', t.model, null, `${m[1]} collides with an earlier ${table}`,
          'skipped — .lite has no schema qualifier, so two schemas cannot both contribute this name')
      return
    }
    if (schema && schema !== 'public')
      gap('non-public-schema', t.model, null, `${schema}.${table}`, 'emitted unqualified — .lite has no schema namespace')
    tables.set(table, t)
    if (/PARTITION BY/i.test(st))
      gap('partitioned-table', t.model, null, 'PARTITION BY', 'emitted as one table — SQLite has no declarative partitioning')
    for (const part of splitTop(m[2])) {
      const chk = part.match(/^CONSTRAINT ([\w"]+) CHECK \((.*)\)$/i)
      if (chk) { t.checks.push({ name: bare(chk[1]), expr: chk[2].trim() }); continue }
      if (/^(CONSTRAINT|PRIMARY KEY|UNIQUE|FOREIGN KEY|EXCLUDE)\b/i.test(part)) {
        gap('inline-constraint', t.model, null, part.slice(0, 70), 'skipped — read from the ALTER TABLE form where there is one')
        continue
      }
      t.cols.push(part)
    }
    return
  }

  if ((m = st.match(/^ALTER TABLE (?:ONLY )?([\w."]+) ADD CONSTRAINT ([\w"]+) (.*)$/i))) {
    const t = tables.get(bare(m[1])); if (!t) return
    const body = m[3]
    let k
    if ((k = body.match(/^PRIMARY KEY \((.*)\)$/i))) t.pk = k[1].split(',').map(c => bare(c.trim()))
    else if ((k = body.match(/^FOREIGN KEY \((.*)\) REFERENCES ([\w."]+)\(([^)]*)\)(.*)$/i)))
      t.fks.push({ cols: k[1].split(',').map(c => bare(c.trim())), parent: bare(k[2]),
                   ref: k[3].split(',').map(c => bare(c.trim())),
                   onDelete: /ON DELETE CASCADE/i.test(k[4]) ? 'Cascade' : /ON DELETE SET NULL/i.test(k[4]) ? 'SetNull' : null,
                   notValid: /NOT VALID/i.test(k[4]) })
    else if ((k = body.match(/^UNIQUE \((.*)\)$/i))) t.indexes.push({ unique: true, cols: k[1].split(',').map(c => bare(c.trim())), where: null })
    else if (/^CHECK/i.test(body)) {
      const e = body.match(/^CHECK \((.*?)\)(?: NOT VALID)?$/i)
      if (e) t.checks.push({ name: bare(m[2]), expr: e[1].trim() })
    }
    return
  }

  if ((m = st.match(/^CREATE (UNIQUE )?INDEX (?:IF NOT EXISTS )?([\w"]+) ON (?:ONLY )?([\w."]+)(?: USING \w+)? \((.*?)\)(?: WHERE (.*))?$/i))) {
    const t = tables.get(bare(m[3])); if (!t) return
    t.indexes.push({ unique: !!m[1], cols: splitTop(m[4]).map(c => bare(c.trim())), where: m[5] ?? null, raw: m[4] })
    return
  }

  if (/^CREATE (OR REPLACE )?(MATERIALIZED )?VIEW/i.test(st)) {
    const name = st.match(/VIEW ([\w."]+)/i)?.[1]
    gap('view', bare(name ?? '?'), null, 'CREATE VIEW',
        "skipped — .lite's `view` needs its columns DECLARED plus an @@sql body, and a Postgres body is not SQLite")
    return
  }
}

// Split a parenthesised list on commas that are not nested.
function splitTop(s) {
  const out = []
  let depth = 0, cur = '', q = false
  for (const ch of s) {
    if (ch === "'") q = !q
    if (!q && ch === '(') depth++
    if (!q && ch === ')') depth--
    if (!q && ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

// ─── emitting ────────────────────────────────────────────────────────────────

const TYPES = [
  [/^uuid$/,                                   'String'],
  [/^(character varying|varchar|text|citext|character|char|inet|cidr|macaddr|xml|name)\b/, 'String'],
  [/^(smallint|integer|int|int2|int4|int8|bigint|serial|bigserial|smallserial|oid)\b/,     'Int'],
  [/^(double precision|real|float\d*|money)\b/, 'Float'],
  [/^bool(ean)?$/,                             'Boolean'],
  [/^(timestamp|timestamptz|date|time)\b/,     'DateTime'],
  [/^(jsonb|json)$/,                           'Json'],
  [/^bytea$/,                                  'Bytes'],
  [/^interval\b/,                              'String'],
]

function emitTable(t, tables, enums, gap) {
  const out = [`model ${t.model} {`]
  const cols = new Map()
  const fkByCol = new Map()
  for (const fk of t.fks) if (fk.cols.length === 1) fkByCol.set(fk.cols[0], fk)

  for (const raw of t.cols) {
    const col = readColumn(raw, t, enums, gap)
    if (!col) continue
    cols.set(col.name, col)

    if (t.pk.length === 1 && t.pk[0] === col.name) { col.extra.unshift('@id'); col.optional = false }

    const fk = fkByCol.get(col.name)

    // A 64-bit value the application SUPPLIES. A generated key and a foreign key
    // are exempt — see wide-int.js for why that is the line. A single-column
    // primary key counts as generated: a dump attaches its sequence in a later
    // ALTER, so the column itself carries no default to read. A supplied
    // snowflake primary key is therefore missed, and is the known cost.
    if (/^(bigint|int8|bigserial|serial8)\b/i.test(col.srcType) && !fk &&
        !col.extra.includes('@id') && !col.extra.includes('@default(autoincrement())') &&
        !namesATable(col.name, (n) => tables.has(n), singularize)) {
      // Before `render(col)`, or the attribute is reported and not emitted.
      col.extra.push('@big')
      gap('bigint', t.model, col.name, col.srcType, BIGINT_EMITTED)
    }
    const target = fk && tables.get(fk.parent)
    out.push(render(col))
    if (target) {
      const action = fk.onDelete ? `, onDelete: ${fk.onDelete}` : ''
      out.push(`  ${camel(col.name.replace(/_id$/, ''))} ${target.model}${col.optional ? '?' : ''} ` +
               `@relation(fields: [${camel(col.name)}], references: [${camel(fk.ref[0])}]${action})`)
      if (fk.notValid)
        gap('unvalidated-foreign-key', t.model, col.name, 'NOT VALID',
            'emitted as an ordinary relation — existing rows may already violate it')
    }
  }

  const hasIdCol = cols.has('id')
  let compositePk = null
  if (!t.pk.length) {
    gap('no-primary-key', t.model, null, 'no PRIMARY KEY',
        hasIdCol ? "the existing `id` column was marked @id" : 'surrogate `id String @id @default(cuid())` added')
    if (hasIdCol) promoteId(out)
    else out.splice(1, 0, '  id String @id @default(cuid())')
  } else if (t.pk.length > 1) {
    // Carried in the key's own column ORDER, which is the half a surrogate plus
    // `@@unique([…])` could never hold: a primary key builds an implicit index
    // and an implicit index is prefix-matched (`FJS-561`).
    //
    // Unless a member is NULLABLE, which SQLite permits on a rowid table and
    // `@@id` refuses — a key that does not identify anything. There the
    // surrogate is the honest reading and stays graded, because the tuple the
    // source called a key admits several rows that leave a member unset.
    const nullable = t.pk.filter(c => cols.get(c)?.optional)
    if (nullable.length) {
      gap('composite-primary-key', t.model, null, `PRIMARY KEY (${t.pk.join(', ')})`,
          `surrogate id + @@unique([…], nullsDistinct: true) — ${nullable.join(', ')} is nullable, ` +
          `so the source's own key does not identify a row`)
      if (hasIdCol) promoteId(out)
      else out.splice(1, 0, '  id String @id @default(cuid())')
      t.indexes.push({ unique: true, cols: t.pk, where: null })
    } else {
      compositePk = t.pk
    }
  }

  const attrs = []
  // First, so the key reads at the top of the model's own attribute block.
  if (compositePk) attrs.push(`@@id([${compositePk.map(camel).join(', ')}])`)
  for (const c of t.checks) {
    const a = emitCheck(c, t, cols, gap)
    if (a) attrs.push(a)
  }

  // Keyed on the COLUMN LIST rather than on the emitted text. Litestone names an
  // index for its columns, so two over one list collide whatever their predicates
  // differ by — and once a predicate is emitted, two such indexes no longer
  // produce the same string to collapse on. A real database has them, precisely
  // because a partial index is what makes a second one useful.
  const seen = new Set()
  for (const idx of t.indexes) {
    const a = emitIndex(idx, t, cols, gap)
    if (!a) continue
    const key = `${idx.unique ? 'u:' : ''}${idx.cols.join(',')}`
    if (seen.has(key)) { gap('index-collapsed', t.model, null, a, 'dropped — an earlier index already claims this column list, and an index is named for its columns'); continue }
    seen.add(key); attrs.push(a)
  }

  if (attrs.length) out.push('', ...attrs.map(a => '  ' + a))
  out.push('}', '')
  return out
}

// A table with an `id` column that is not its declared primary key still has
// exactly one column called id, and .lite needs one @id — so the column is
// promoted rather than shadowed by a second field of the same name.
function promoteId(out) {
  const i = out.findIndex(l => /^  id \w/.test(l))
  if (i >= 0 && !/@id\b/.test(out[i])) out[i] = out[i].replace(/^(  id \w+\??)/, '$1 @id')
}

function readColumn(raw, t, enums, gap) {
  const m = raw.match(/^([\w"]+) (.+)$/)
  if (!m) { gap('unparsed-line', t.model, null, raw.slice(0, 70), 'dropped'); return null }
  const name = bare(m[1])
  let rest = m[2]

  const notNull = /\bNOT NULL\b/i.test(rest)
  rest = rest.replace(/\bNOT NULL\b/i, '').trim()

  let def = null
  const d = rest.match(/\bDEFAULT (.+?)(?:\s+(?:NOT NULL|CHECK|REFERENCES)\b|$)/i)
  if (d) { def = d[1].trim(); rest = rest.replace(d[0], '').trim() }

  const isArray = /\[\]$/.test(rest)
  const typeText = rest.replace(/\[\]$/, '').trim()
  const extra = []

  let type = null
  const enumName = bare(typeText)
  if (enums.has(enumName)) type = pascal(enumName)
  if (!type) {
    const num = typeText.match(/^numeric\((\d+),\s*(\d+)\)/i) || typeText.match(/^decimal\((\d+),\s*(\d+)\)/i)
    if (num) {
      if (+num[2] <= 9) { type = 'Int'; extra.push(`@scale(${num[2]})`) }
      else { type = 'Float'; gap('scale-over-9', t.model, name, `numeric(${num[1]}, ${num[2]})`, 'Float — @scale caps at 9 places') }
    } else if (/^(numeric|decimal)\b/i.test(typeText)) {
      type = 'Float'; gap('decimal-no-precision', t.model, name, typeText, 'Float — no scale to carry')
    }
  }
  if (!type) for (const [re, lite] of TYPES) if (re.test(typeText)) { type = lite; break }
  if (!type) {
    type = 'String'
    if (/^tsvector$/i.test(typeText))
      // A materialised search vector. .lite answers the same need with @@fts,
      // which is SQLite FTS5 — a different engine on a different table, so it is
      // a REPLACEMENT the author makes and never a column this can convert.
      gap('search-vector-column', t.model, name, typeText,
          'String — the .lite answer is @@fts on the model, which is SQLite FTS5 and not a column')
    else if (/^(public\.)?(half)?vec(tor)?\b|^(public\.)?sparsevec\b/i.test(typeText))
      gap('vector-column', t.model, name, typeText,
          'String — .lite has no vector type, and no index that would make one useful')
    else
      gap('unknown-column-type', t.model, name, typeText.slice(0, 40), 'String — no .lite equivalent')
  }

  if (def !== null) {
    const v = pgDefault(def, type, isArray)
    if (v === null) gap('dbgenerated-default', t.model, name, def.slice(0, 50), 'dropped — no .lite spelling')
    else if (v === '__ARRAY__') gap('array-default', t.model, name, `default ${def}`,
      'dropped — .lite refuses every array default, the empty one included (FJS-564)')
    else extra.push(`@default(${v})`)
  }

  // The source spelling travels: whether a `bigint` is worth reporting depends
  // on whether it is a key, which is a fact about the TABLE (wide-int.js).
  return { name, type, optional: !notNull, isArray, extra, srcType: typeText }
}

function pgDefault(def, type, isArray) {
  const d = def.replace(/::[\w "\[\]]+$/, '').trim()          // drop the cast
  if (isArray || /^ARRAY\[|^'\{.*\}'$/.test(d)) return '__ARRAY__'
  if (/^nextval\(/i.test(d)) return 'autoincrement()'
  if (/^gen_random_uuid\(\)|^uuid_generate_v\d\(\)/i.test(d)) return 'uuid()'
  if (/^(now\(\)|CURRENT_TIMESTAMP|statement_timestamp\(\))/i.test(d)) return 'now()'
  if (/^(true|false)$/i.test(d)) return d.toLowerCase()
  if (/^-?\d+(\.\d+)?$/.test(d)) return d
  if (/^'.*'$/.test(d)) return JSON.stringify(d.slice(1, -1))
  if (/^\w+\(/.test(d)) return null                            // any other function call
  return null
}

function render(col) {
  const name = camel(col.name)
  const bits = [...col.extra]
  if (name !== col.name) bits.unshift(`@map("${col.name}")`)
  const t = col.type + (col.isArray ? '[]' : '') + (col.optional ? '?' : '')
  return `  ${name} ${t}${bits.length ? ' ' + bits.join(' ') : ''}`
}

// ─── CHECK, and the arc hiding inside some of them ───────────────────────────

// `(a IS NOT NULL) <> (b IS NOT NULL)` is an exclusive arc written in SQL, and
// `num_nonnulls(a, b, c) = 1` is the same thing for more than two. @@arc says it
// directly and keeps a real foreign key on every member, so it is emitted where
// the shape is unambiguous — this is the one place the converter translates a
// constraint into a different construct, and it says so.
function asArc(expr, cols) {
  const pair = expr.match(/^\(*\s*\(([\w"]+) IS NOT NULL\)\s*<>\s*\(([\w"]+) IS NOT NULL\)\s*\)*$/i)
  if (pair) return [bare(pair[1]), bare(pair[2])]
  const many = expr.match(/^\(*num_nonnulls\(([^)]*)\)\s*=\s*1\)*$/i)
  if (many) return many[1].split(',').map(c => bare(c.trim()))
  return null
}

function emitCheck(check, t, cols, gap) {
  const arcCols = asArc(check.expr, cols)
  if (arcCols && arcCols.every(c => cols.has(c))) {
    const optional = arcCols.every(c => cols.get(c).optional)
    if (optional) {
      gap('check-is-an-arc', t.model, arcCols.join(', '), check.expr.slice(0, 70),
          `@@arc([${arcCols.map(camel).join(', ')}]) — an exclusive arc written as SQL; @@arc keeps a real foreign key on every member`)
      return `@@arc([${arcCols.map(camel).join(', ')}])`
    }
    gap('arc-member-required', t.model, arcCols.join(', '), check.expr.slice(0, 70),
        'emitted as an ordinary @@check — @@arc needs every member optional, and one of these is NOT NULL')
  }

  // A dump casts every enum literal — `'approved'::public.quote_status` — and a
  // cast on a STRING LITERAL carries no meaning SQLite needs, since an enum
  // column is TEXT there. Dropping those first recovers the checks that are
  // ordinary comparisons wearing Postgres punctuation; a cast on anything else
  // still stops the conversion below.
  let expr = check.expr.replace(/('(?:[^']|'')*')::[\w."]+/g, '$1')
  let unknown = null
  // A word inside a string literal is a VALUE, not a column — rewriting there
  // turned `'legacy'` into an unresolved identifier called legacy.
  expr = mapIdentifiers(expr, (id) => {
    if (cols.has(id)) return camel(id)
    if (KEYWORDS.test(id)) return null
    unknown = id
    return null
  })

  if (unknown) {
    gap('check-unresolved-identifier', t.model, null, `${check.expr.slice(0, 60)} — '${unknown}'`,
        'DROPPED — the expression names something that is not a column of this table (a function, a cast, another table)')
    return null
  }
  if (/::/.test(expr)) {
    gap('check-postgres-cast', t.model, null, check.expr.slice(0, 60), 'DROPPED — a :: cast is not SQLite')
    return null
  }
  return `@@check(${JSON.stringify(expr)})`
}

const KEYWORDS = /^(is|not|null|and|or|in|between|like|true|false|any|all|exists|case|when|then|else|end|char_length|length|abs|coalesce|nullif|num_nonnulls|distinct|from)$/i

// Walk the expression, rewriting bare identifiers and leaving every quoted
// literal exactly as it is. `replace` cannot do this: a regex has no way to know
// it is inside a string.
function mapIdentifiers(expr, fn) {
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

function emitIndex(idx, t, cols, gap) {
  const names = idx.cols.map(c => c.replace(/\s+(ASC|DESC)$/i, '').trim())
  if (names.some(n => !cols.has(n))) {
    gap('index-expression', t.model, null, (idx.raw ?? names.join(', ')).slice(0, 60),
        'dropped — an index over an expression rather than plain columns')
    return null
  }
  const camelNames = names.map(camel)

  // A predicate `@@index(where:)` can hold is emitted WHOLE; one it cannot is
  // dropped, which only widens the index (FJS-586, FJS-590).
  //
  // A UNIQUE one is CARRIED now that `@@unique(where:)` exists (FJS-603) — and
  // the two grammars differ, which is why the value form is asked for here and
  // not on the index path: a partial unique may compare against a value and a
  // partial index may not. One the reading still cannot express is dropped
  // WHOLE rather than emitted unconditionally, because there the predicate is
  // the difference between uniqueness among some rows and among all of them,
  // and a stronger constraint than the source declares refuses rows the source
  // permits.
  const nullableCols = camelNames.filter((n, i) => cols.get(names[i])?.optional)
  let whereLite = null
  if (idx.where) {
    // A tuple with a nullable member takes `nullsDistinct: true`, and that
    // cannot be combined with a predicate — so a partial unique over one is
    // dropped rather than emitted as a schema this parser refuses. Anything
    // that WRITES .lite owes the round trip (FJS-594).
    const blocked = idx.unique && nullableCols.length && camelNames.length > 1
    whereLite = blocked ? null : predicateToLite(idx.where, camel, { values: !!idx.unique })
    gap('partial-index', t.model, camelNames.join(', '), `${idx.unique ? 'unique ' : ''}WHERE ${idx.where.slice(0, 50)}`,
        whereLite && idx.unique ? `carried whole — where: ${whereLite}`
      : whereLite   ? `emitted whole — where: ${whereLite}`
      : blocked     ? `DROPPED — ${nullableCols.join(', ')} is nullable, so the tuple needs nullsDistinct, which a predicate excludes`
      : idx.unique  ? 'DROPPED — emitting it unconditionally would be a stronger constraint than the source declares'
                    : 'emitted without the predicate — a plain index answers the same rows and is only larger')
    if (idx.unique && !whereLite) return null
    if (idx.unique) return `@@unique([${camelNames.join(', ')}], where: ${whereLite})`
  }

  if (idx.unique) {
    const nullable = nullableCols
    if (nullable.length && camelNames.length > 1) {
      gap('composite-unique-over-nullable', t.model, null,
          `@@unique([${camelNames.join(', ')}]) with ${nullable.join(', ')} nullable`,
          "nullsDistinct: true — SQL's own word for what SQLite already does (FJS-D130)")
      return `@@unique([${camelNames.join(', ')}], nullsDistinct: true)`
    }
    return `@@unique([${camelNames.join(', ')}])`
  }
  return `@@index([${camelNames.join(', ')}]${whereLite ? `, where: ${whereLite}` : ''})`
}
