// sql.js — a PostgreSQL `pg_dump --schema-only`, a Rails `structure.sql` or a
// MySQL/MariaDB `mysqldump`, read into .lite.
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
//
// A MySQL dump is the opposite on keys: they are written INSIDE CREATE TABLE,
// next to the columns, with backticks around every name and table options after
// the closing paren. It is told from a Postgres one by those two marks, and read
// by the same statements — one reader, so a gap kind means one thing. phpMyAdmin's
// export is the Postgres shape again: keys and AUTO_INCREMENT arrive in ALTER TABLE.

import { singularize, pascal, camel, modelName } from '@frontierjs/toolbelt/inflect'
import { mapIdentifiers } from '../core/ddl.js'
import { detectPolymorphic } from './polymorphic.js'
import { BIGINT_EMITTED, namesATable } from './wide-int.js'
import { toMinorUnits, scaleOf } from './scale.js'
import { carriesArray, ARRAY_ELEMENT_EMITTED } from './array.js'
import { predicateToLite } from '../core/migrate.js'

// A dump qualifies every name with its schema. Stripping only `public.` let
// `partman.template_x` through as a model name with a dot in it, which is not
// an identifier.
const bare   = (id) => id.replace(/"/g, '').replace(/^[a-z_]\w*\./i, '')

export function convert(src, label = 'schema') {
  const gaps = []
  const gap = (kind, model, field, detail, emitted) =>
    gaps.push({ source: label, kind, model, field, detail, emitted })

  const mysql = isMysql(src)
  const statements = split(src, mysql)
  const enums   = new Map()
  const tables  = new Map()
  const domains = new Map()

  for (const st of statements) readStatement(st, enums, tables, gap, mysql, domains)

  const out = []
  for (const [name, values] of enums) out.push(`enum ${pascal(name)} {`, ...values.map(v => '  ' + enumValue(v)), '}', '')
  for (const t of tables.values()) out.push(...emitTable(t, tables, enums, gap))

  const lite = out.join('\n')
  detectPolymorphic(lite, gap)
  return { lite, gaps, models: [...tables.values()].map(t => t.model) }
}

// A dollar-quoted function body may hold anything, semicolons included, so
// those are removed before the file is cut into statements at all.
function split(src, mysql) {
  // Backticks never appear in a Postgres dump's identifiers, and a mysqldump
  // wraps every statement the server must run in a `/*! … */;` line, which is
  // not a statement. Only whole lines are dropped: an INSERT's data may hold
  // `/*` inside a string.
  if (mysql) src = src.replace(/`/g, '').replace(/^\/\*.*\*\/;?[ \t]*$/gm, '')
  return src
    .replace(/\$\$[\s\S]*?\$\$/g, "'<body>'")
    // A psql meta-command (`\copy`, `\pset`) ends at its line and has no
    // semicolon, so left in it glues itself to the statement after it.
    .replace(/^[ \t]*\\.*$/gm, '')
    .split(/;\s*(?:\n|$)/)
    // A hand-written script also comments after a column. A trailing one
    // followed by a quote is left: it may sit inside a string literal.
    .map(s => s.replace(/^\s*--.*$/gm, '').replace(/--[^'\n]*$/gm, '').replace(/\s+/g, ' ').trim())
    .flatMap(schemaElements)
    .map(s => mysql ? s.replace(TABLE_OPTIONS, '$1') : s)
    .filter(Boolean)
}

// `CREATE SCHEMA person CREATE TABLE a(...) CREATE TABLE b(...)` is ONE
// statement holding several, and read whole it matched nothing: every table of
// a hand-written Postgres install script declared that way was silently absent.
// Each element is qualified with the schema it was declared in.
function schemaElements(st) {
  const m = st.match(/^CREATE SCHEMA (?:IF NOT EXISTS )?([\w"]+) (CREATE .*)$/i)
  if (!m) return [st]
  return m[2].split(/ (?=CREATE (?:TABLE|VIEW|INDEX|SEQUENCE)\b)/i)
    .map(e => e.replace(/^(CREATE (?:TABLE|VIEW|SEQUENCE) (?:IF NOT EXISTS )?)([\w"]+)/i, `$1${m[1]}.$2`))
}

// A mysqldump says it with backticks or ENGINE=; a hand-written MySQL script
// often has neither and is still told by its `/*!50503 … */` version comments,
// a `USE db;` line or an AUTO_INCREMENT column.
const isMysql = (src) =>
  /CREATE TABLE (?:IF NOT EXISTS )?`|\)\s*ENGINE\s*=|^\/\*!\d{5}|^USE \w+;|\bAUTO_INCREMENT\b/im.test(src)

// What follows a CREATE TABLE's closing paren. Anchored on the `=` because a
// column's own `COLLATE x` / `AUTO_INCREMENT` also follows a paren (`varchar(191)
// COLLATE …`) and cutting there would drop the rest of the table.
const TABLE_OPTIONS = /^(CREATE TABLE .*?\))\s*(?:ENGINE|AUTO_INCREMENT|(?:DEFAULT )?CHARSET|ROW_FORMAT|KEY_BLOCK_SIZE|STATS_\w+|CHECKSUM)\s*=.*$/i

function enumValue(v) {
  const clean = v.replace(/^'|'$/g, '')
  // .lite enum values are identifiers; a value that is not one has to be said
  // some other way, so it is kept verbatim and the caller is told.
  return /^[A-Za-z_]\w*$/.test(clean) ? clean : clean.replace(/[^\w]/g, '_')
}

// ─── statements ──────────────────────────────────────────────────────────────

function readStatement(st, enums, tables, gap, mysql, domains) {
  let m

  if ((m = st.match(/^CREATE TYPE ([\w."]+) AS ENUM \((.*)\)$/i))) {
    enums.set(bare(m[1]), m[2].split(',').map(v => v.trim()).filter(Boolean))
    return
  }

  // A domain is a named type over a base one. Read as its base, since a column
  // typed `"Name"` is otherwise an unknown type and lands as a guessed String.
  if ((m = st.match(/^CREATE DOMAIN ([\w."]+) (?:AS )?(.+?)(?: (?:NOT NULL|NULL|DEFAULT|CHECK|CONSTRAINT)\b.*)?$/i))) {
    domains.set(bare(m[1]), m[2].trim())
    return
  }

  if ((m = st.match(/^CREATE TABLE (?:IF NOT EXISTS )?([\w."]+) ?\((.*)\)(?: PARTITION BY .*)?$/i))) {
    const table = bare(m[1])
    const schema = m[1].replace(/"/g, '').match(/^([a-z_]\w*)\./i)?.[1]
    const t = { table, model: modelName(table), cols: [], checks: [], pk: [], fks: [], indexes: [], arcs: [], mysql, domains }
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
      // pg_dump writes every key as a later ALTER TABLE, but a hand-written
      // script of either dialect writes them here, and skipping them cost
      // every table of the MySQL employees sample its primary key.
      if (readInlineKey(part, t, gap)) continue
      if (/^(CONSTRAINT|PRIMARY KEY|UNIQUE|FOREIGN KEY|EXCLUDE)\b/i.test(part)) {
        gap('inline-constraint', t.model, null, part.slice(0, 70), 'skipped — read from the ALTER TABLE form where there is one')
        continue
      }
      t.cols.push(mysql ? inlineEnum(part, t, enums) : part)
    }
    return
  }

  if ((m = st.match(/^ALTER TABLE (?:ONLY )?([\w."]+) (.*)$/i))) {
    const t = tables.get(bare(m[1])); if (!t) return
    // A partition is where the parent's rows are stored, not a model of its
    // own; read as one, pagila's payment became 55 models of the same shape.
    const part = m[2].match(/^ATTACH PARTITION ([\w."]+)/i)
    if (part) {
      const child = tables.get(bare(part[1]))
      if (child) {
        tables.delete(child.table)
        gap('partition-folded', child.model, null, `PARTITION OF ${t.table}`,
            `folded into ${t.model} — SQLite has no declarative partitioning, so one table holds every partition's rows`)
      }
      return
    }
    for (const clause of splitTop(m[2])) readAlter(clause, t, enums, gap)
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

// One clause of an ALTER TABLE. phpMyAdmin batches several into one statement
// (`ADD PRIMARY KEY (...), ADD UNIQUE KEY ...`) and states AUTO_INCREMENT as a
// later `MODIFY`, so a column is restated here and replaces the CREATE TABLE's.
// A Postgres dump's other ALTERs (ALTER COLUMN ... SET DEFAULT) are still skipped
// quietly; a MySQL clause nothing reads is named, since the output is thinner by it.
function readAlter(clause, t, enums, gap) {
  let m
  if ((m = clause.match(/^ADD CONSTRAINT ([\w"]+) (.*)$/i))) { readKey(m[2], bare(m[1]), t); return }
  // A dump never writes these; an install script that reshapes a table after
  // creating it does, and the column it adds or drops is part of the schema.
  if ((m = clause.match(/^DROP COLUMN (?:IF EXISTS )?([\w"]+)/i))) {
    t.cols = t.cols.filter(c => bare(c.split(' ')[0]) !== bare(m[1])); return
  }
  if ((m = clause.match(/^ADD (?:COLUMN )?(?!CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|KEY|INDEX|FULLTEXT|SPATIAL)([\w"]+ .*)$/i))) {
    t.cols.push(t.mysql ? inlineEnum(m[1], t, enums) : m[1]); return
  }
  if (!t.mysql) return
  if (/^AUTO_INCREMENT\s*=/i.test(clause)) return
  if ((m = clause.match(/^ADD (.*)$/i)) && readInlineKey(m[1], t, gap)) return
  if ((m = clause.match(/^MODIFY (?:COLUMN )?([\w"]+) (.*?)(?: (?:FIRST|AFTER [\w"]+))?$/i))) {
    const at = t.cols.findIndex(c => bare(c.split(' ')[0]) === bare(m[1]))
    if (at >= 0) { t.cols[at] = inlineEnum(`${m[1]} ${m[2]}`, t, enums); return }
  }
  gap('unparsed-line', t.model, null, `ALTER TABLE ${clause}`.slice(0, 70), 'dropped')
}

// A key, foreign key or CHECK, whichever statement it arrives in: Postgres puts
// it in an ALTER TABLE ... ADD CONSTRAINT, MySQL inside CREATE TABLE. One reader,
// so the two cannot disagree about what an ON DELETE clause means.
function readKey(body, name, t) {
  let k
  if ((k = body.match(/^PRIMARY KEY \((.*)\)$/i))) t.pk = keyCols(k[1])
  else if ((k = body.match(/^FOREIGN KEY \((.*)\) REFERENCES ([\w."]+) ?\(([^)]*)\)(.*)$/i)))
    t.fks.push({ cols: keyCols(k[1]), parent: bare(k[2]),
                 ref: keyCols(k[3]),
                 onDelete: /ON DELETE CASCADE/i.test(k[4]) ? 'Cascade' : /ON DELETE SET NULL/i.test(k[4]) ? 'SetNull' : null,
                 notValid: /NOT VALID/i.test(k[4]) })
  else if ((k = body.match(/^UNIQUE(?: (?:KEY|INDEX))?(?: [\w"]+)? \((.*)\)(?: USING \w+)?$/i)))
    t.indexes.push({ unique: true, cols: keyCols(k[1]), where: null })
  else if (/^CHECK/i.test(body)) {
    const e = body.match(/^CHECK \((.*?)\)(?: NOT VALID)?$/i)
    if (e) t.checks.push({ name, expr: e[1].trim() })
  }
}

// A MySQL index may prefix-length a column (`name(191)`), which is a storage
// detail and not a different column.
const keyCols = (s) => splitTop(s).map(c => bare(c.trim().replace(/\(\d+\)/, '')))

// Returns true when the part was a key of one of the shapes written inline.
function readInlineKey(part, t, gap) {
  const k = part.replace(/^CONSTRAINT [\w"]+ (?=PRIMARY|UNIQUE|FOREIGN)/i, '')
  if (/^(PRIMARY KEY|UNIQUE|FOREIGN KEY)\b/i.test(k)) { readKey(k, null, t); return true }
  if (/^(FULLTEXT|SPATIAL) (KEY|INDEX)\b/i.test(k)) {
    gap('fulltext-index', t.model, null, k.slice(0, 70),
        'dropped — the .lite answer is @@fts on the model, which is SQLite FTS5 and not an index')
    return true
  }
  const ix = k.match(/^(?:KEY|INDEX) (?:[\w"]+ )?\((.*)\)(?: USING \w+)?$/i)
  if (!ix) return false
  t.indexes.push({ unique: false, cols: keyCols(ix[1]), where: null, raw: ix[1] })
  return true
}

// `kind enum('a','b')` is a native enum written at the column. Registered under
// the table and column it sits on, so two tables' `status` stay two enums.
function inlineEnum(part, t, enums) {
  const m = part.match(/^([\w"]+) enum ?\((.*?)\)(?= |$)(.*)$/i)
  if (!m) return part
  const name = `${t.table}_${bare(m[1])}`
  enums.set(name, splitTop(m[2]))
  return `${m[1]} ${name}${m[3]}`
}

// Split a parenthesized list on commas that are not nested.
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

// MySQL's spellings sit beside Postgres's: no word means two things. `tinyint(1)`
// is first because it is MySQL's own BOOLEAN, where any other `tinyint` is a
// number. Case-blind: a dump writes `integer` and a hand-written script `INT`,
// and the upper-case spelling read as an unknown type and became a String.
const TYPES = [
  [/^uuid$/i,                                   'String'],
  [/^(character varying|varchar|nvarchar|text|tinytext|mediumtext|longtext|citext|character|nchar|char|inet|cidr|macaddr|xml|name)\b/i, 'String'],
  [/^(tinyint\(1\)|bit\(1\))/i,                'Boolean'],
  [/^(smallint|integer|int|int2|int4|int8|bigint|serial|bigserial|smallserial|oid|tinyint|mediumint|year)\b/i, 'Int'],
  [/^(double precision|double|real|float\d*|money)\b/i, 'Float'],
  [/^bool(ean)?$/i,                             'Boolean'],
  [/^(timestamp|timestamptz|datetime|date|time)\b/i, 'DateTime'],
  [/^(jsonb|json)$/i,                           'Json'],
  [/^(bytea|tinyblob|blob|mediumblob|longblob|binary|varbinary)\b/i, 'Bytes'],
  [/^interval\b/i,                              'String'],
]

function emitTable(t, tables, enums, gap) {
  const out = [`model ${t.model} {`]
  const cols = new Map()
  const colNames = new Set(t.cols.map(c => camel(bare(c.split(' ')[0]))))
  const relNames = new Set()

  for (const raw of t.cols) {
    const col = readColumn(raw, t, enums, gap)
    if (!col) continue
    cols.set(col.name, col)

    if (t.pk.length === 1 && t.pk[0] === col.name) { col.extra.unshift('@id'); col.optional = false }

    // Looked up here rather than indexed up front: reading the column can add
    // the key it declares inline.
    const fk = t.fks.find(f => f.cols.length === 1 && f.cols[0] === col.name)

    // A 64-bit value the application SUPPLIES. A generated key and a foreign key
    // are exempt — see wide-int.js for why that is the line. A single-column
    // primary key counts as generated: a dump attaches its sequence in a later
    // ALTER, so the column itself carries no default to read. A supplied
    // snowflake primary key is therefore missed, and is the known cost.
    if (/^(bigint|int8)\b/i.test(col.srcType) && col.isArray)
      gap('bigint-array', t.model, col.name, `${col.srcType}[]`,
          'Int[] — an array is stored as JSON, whose number is a double, so a value past 2^53 reads back changed and @big cannot follow it there')
    else if (/^(bigint|int8|bigserial|serial8)\b/i.test(col.srcType) && !fk &&
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
      // Named for the column less its key suffix — `author_id` is `author`. A
      // key with no such suffix (`emp_no`, `ArtistId` is fine, `ArtistNo` is
      // not) yields the column's own name, so the relation takes its target's.
      let rel = camel(col.name.replace(/(_id|(?<=[a-z])I[dD])$/, ''))
      if (colNames.has(rel) || relNames.has(rel)) {
        let alt = camel(target.model)
        while (colNames.has(alt) || relNames.has(alt)) alt += 'Ref'
        gap('field-name-collision', t.model, col.name, `the relation on ${col.name} could not take the name ${rel}`,
            `named ${alt} — a relation field has no column, so it yields to every column and to the relations before it`)
        rel = alt
      }
      relNames.add(rel)
      out.push(`  ${rel} ${target.model}${col.optional ? '?' : ''} ` +
               `@relation(fields: [${camel(col.name)}], references: [${camel(fk.ref[0] ?? target.pk[0] ?? 'id')}]${action})`)
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
  let arced = false
  for (const c of t.checks) {
    const a = emitCheck(c, t, cols, gap, arced)
    if (a?.startsWith('@@arc')) arced = true
    if (a) attrs.push(a)
  }

  // Keyed on the COLUMN LIST rather than on the emitted text. Litestone names an
  // index for its columns, so two over one list collide whatever their predicates
  // differ by — and once a predicate is emitted, two such indexes no longer
  // produce the same string to collapse on. A real database has them, precisely
  // because a partial index is what makes a second one useful.
  //
  // The key is the list as EMITTED — direction stripped — or `(a, b)` and
  // `(a, b DESC)` were two keys and one index name. Where a plain index and a
  // partial one share a list the plain one is kept: it answers every query
  // the partial does.
  const seen = new Map()
  for (const idx of t.indexes) {
    const a = emitIndex(idx, t, cols, gap)
    if (!a) continue
    const key = `${idx.unique ? 'u:' : ''}${idx.cols.map(c => c.replace(/\s+(ASC|DESC)$/i, '').trim()).join(',')}`
    const at = seen.get(key)
    if (at === undefined) { seen.set(key, attrs.length); attrs.push(a); continue }
    const replaces = !/, where: /.test(a) && /, where: /.test(attrs[at])
    const dropped  = replaces ? attrs[at] : a
    if (replaces) attrs[at] = a
    gap('index-collapsed', t.model, null, dropped,
        'dropped — another index claims this column list, and an index is named for its columns')
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

  const extra = []
  if (t.mysql) {
    // Said before NOT NULL and DEFAULT are read: a COMMENT string may hold either
    // word, and a charset clause sits between the type and both.
    rest = rest.replace(/\bCOMMENT '(?:[^'\\]|\\.|'')*'/i, '')
               .replace(/\bON UPDATE \w+(?:\(\d*\))?/i, '')
               .replace(/\b(?:unsigned|zerofill)\b/gi, '')
               .replace(/\bCHARACTER SET \w+/i, '').replace(/\bCOLLATE \w+/i, '')
    if (/\bAUTO_INCREMENT\b/i.test(rest)) { rest = rest.replace(/\bAUTO_INCREMENT\b/i, ''); extra.push('@default(autoincrement())') }
    const chk = rest.match(/\s+CHECK \(.*\)$/i)
    if (chk) { rest = rest.slice(0, chk.index); gap('inline-constraint', t.model, name, chk[0].trim().slice(0, 70), 'skipped — a column CHECK is not read') }
    rest = rest.replace(/\s+/g, ' ').trim()
  }
  // A name on a column's own DEFAULT or CHECK says nothing .lite keeps, and
  // left in it was read as part of the type.
  rest = rest.replace(/\s*\bCONSTRAINT [\w"]+(?= )/gi, '').trim()

  // A hand-written column keys itself; a dump never does, so the corpus did not
  // find it. Read as table-level keys, or the key and the relation are dropped
  // with nothing recorded and a surrogate id invented. Taken before DEFAULT,
  // whose value would otherwise run on to the end of the line.
  const ref = rest.match(/\s+REFERENCES ([\w."]+)(?:\s*\(([^)]*)\))?((?:\s+(?:ON (?:DELETE|UPDATE) (?:CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)|MATCH \w+|NOT DEFERRABLE|DEFERRABLE|INITIALLY \w+))*)/i)
  if (ref) {
    rest = rest.replace(ref[0], '').trim()
    readKey(`FOREIGN KEY (${name}) REFERENCES ${ref[1]} (${ref[2] ?? ''})${ref[3]}`, null, t)
  }
  const inlinePk = /\s+PRIMARY KEY\b/i.test(rest)
  if (inlinePk) { rest = rest.replace(/\s+PRIMARY KEY\b/i, '').trim(); t.pk = [name] }

  const notNull = inlinePk || /\bNOT NULL\b/i.test(rest)
  rest = rest.replace(/\bNOT NULL\b/i, '').trim()

  let def = null
  const d = rest.match(/\bDEFAULT (.+?)(?:\s+(?:NOT NULL|CHECK|REFERENCES|UNIQUE|NULL)\b|$)/i)
  if (d) { def = d[1].trim(); rest = rest.replace(d[0], '').trim() }
  // A hand-written column says UNIQUE where a dump writes a constraint, and an
  // explicit NULL where a dump says nothing; left in, both were read as type.
  if (/\s+UNIQUE\b/i.test(rest)) { rest = rest.replace(/\s+UNIQUE\b/i, '').trim(); t.indexes.push({ unique: true, cols: [name], where: null }) }
  rest = rest.replace(/\s+NULL$/i, '')

  let isArray = /\[\]$/.test(rest)
  const declared = rest.replace(/\[\]$/, '').trim()
  const typeText = t.domains?.get(bare(declared)) ?? declared

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
      // A materialized search vector. .lite answers the same need with @@fts,
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

  if (isArray && !carriesArray(type, enums.has(enumName), extra)) {
    gap('array-element-type', t.model, name, `${typeText}[]`, ARRAY_ELEMENT_EMITTED)
    type = 'Json'; isArray = false
    extra.splice(0, extra.length, ...extra.filter(a => !a.startsWith('@scale')))
  }

  if (def !== null) {
    const v = pgDefault(def, type, isArray, enums.has(enumName))
    if (v === NO_DEFAULT) { /* MySQL's DEFAULT NULL says only that the column is nullable */ }
    else if (v === null) gap('dbgenerated-default', t.model, name, def.slice(0, 50), 'dropped — no .lite spelling')
    else if (v === '__ARRAY__') gap('array-default', t.model, name, `default ${def}`,
      'dropped — .lite refuses every array default, the empty one included (FJS-564)')
    else {
      const places = scaleOf(extra)
      const minor  = places === null ? v : toMinorUnits(v, places)
      if (minor === null) gap('default-over-scale', t.model, name, `default ${def}`,
        `dropped — more places than @scale(${places}) holds`)
      else extra.push(`@default(${minor})`)
    }
  }

  // The source spelling travels: whether a `bigint` is worth reporting depends
  // on whether it is a key, which is a fact about the TABLE (wide-int.js).
  return { name, type, optional: !notNull, isArray, extra, srcType: typeText }
}

const NO_DEFAULT = Symbol('no default')

function pgDefault(def, type, isArray, isEnum = false) {
  // `DEFAULT (NOW())` — a hand-written script parenthesizes what a dump does
  // not. The cast may name a schema-qualified enum: `'G'::public.mpaa_rating`.
  const d = def.replace(/^\((.*)\)$/, '$1').replace(/::[\w ."\[\]]+$/, '').trim()
  if (/^NULL$/i.test(d)) return NO_DEFAULT
  if (isEnum && /^'.*'$/.test(d)) return enumValue(d)
  // MySQL writes every default as a string, numbers and booleans included
  // (`DEFAULT '0'`), and a bit as `b'0'`.
  const lit = d.match(/^b?'(-?\d+(?:\.\d+)?)'$/i)?.[1]
  if (lit !== undefined) {
    if (type === 'Boolean') return Number(lit) ? 'true' : 'false'
    if (type === 'Int' || type === 'Float') return lit
  }
  if (type === 'Boolean' && /^[01]$/.test(d)) return d === '1' ? 'true' : 'false'
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

// A model takes one @@arc, and a table can carry two independent arcs — the
// second is emitted as the CHECK it was written as, which enforces the same rows.
function emitCheck(check, t, cols, gap, arced = false) {
  const arcCols = asArc(check.expr, cols)
  if (arcCols && arcCols.every(c => cols.has(c))) {
    const optional = arcCols.every(c => cols.get(c).optional)
    if (optional && !arced) {
      gap('check-is-an-arc', t.model, arcCols.join(', '), check.expr.slice(0, 70),
          `@@arc([${arcCols.map(camel).join(', ')}]) — an exclusive arc written as SQL; @@arc keeps a real foreign key on every member`)
      return `@@arc([${arcCols.map(camel).join(', ')}])`
    }
    if (optional)
      gap('second-arc', t.model, arcCols.join(', '), check.expr.slice(0, 70),
          'emitted as an ordinary @@check — a model takes one @@arc, and this table has two')
    else
      gap('arc-member-required', t.model, arcCols.join(', '), check.expr.slice(0, 70),
          'emitted as an ordinary @@check — @@arc needs every member optional, and one of these is NOT NULL')
  }

  const expr = translateCheck(check.expr, (id) => cols.has(id), gap, t.model)
  return expr === null ? null : `@@check(${JSON.stringify(expr)})`
}

// A CHECK written in a server's SQL, restated over .lite field names — or null,
// with the reason recorded. Shared with rails.js, whose schema.rb carries the
// same SQL in a `t.check_constraint` string.
export function translateCheck(/** @type {string} */ src, /** @type {(id: string) => boolean} */ isColumn,
                               /** @type {any} */ gap, /** @type {string} */ model) {
  // A dump casts every enum literal — `'approved'::public.quote_status` — and a
  // cast on a STRING LITERAL carries no meaning SQLite needs, since an enum
  // column is TEXT there. A cast on anything else still stops the conversion.
  // `char_length` and `num_nonnulls` are Postgres's and SQLite has neither, so
  // the build failed on `no such function`; `length` counts characters in TEXT,
  // and the sum of IS NOT NULL tests is what @@arc compiles to.
  let expr = src.replace(/('(?:[^']|'')*')::[\w."]+/g, '$1').replace(/\bchar_length\(/gi, 'length(')
    .replace(/\bnum_(non)?nulls\(([^()]*)\)/gi, (_, non, args) =>
      `(${args.split(',').map((/** @type {string} */ a) => `(${a.trim()} IS ${non ? 'NOT ' : ''}NULL)`).join(' + ')})`)
  /** @type {string | null} */
  let unknown = null
  // A word inside a string literal is a VALUE, not a column — rewriting there
  // turned `'legacy'` into an unresolved identifier called legacy.
  expr = mapIdentifiers(expr, (/** @type {string} */ id) => {
    if (isColumn(id)) return camel(id)
    if (KEYWORDS.test(id)) return null
    unknown = id
    return null
  })

  const shown = src.slice(0, 60)
  if (unknown) return gap('check-unresolved-identifier', model, null, `${shown} — '${unknown}'`,
    'DROPPED — the expression names something that is not a column of this table (a function, a cast, another table)'), null
  if (/::/.test(expr)) return gap('check-postgres-cast', model, null, shown, 'DROPPED — a :: cast is not SQLite'), null
  // Tested outside string literals: a `~` inside a pattern is a character.
  if (/!?~\*?|@>|<@|\bI?LIKE ANY\b|\bILIKE\b|\bSIMILAR TO\b/i.test(expr.replace(/'(?:[^']|'')*'/g, "''")))
    return gap('check-postgres-operator', model, null, shown,
      'DROPPED — a regex match, containment or ILIKE is Postgres, and SQLite fails to build the table'), null
  return expr
}

const KEYWORDS = /^(is|not|null|and|or|in|between|like|true|false|any|all|exists|case|when|then|else|end|length|upper|lower|trim|abs|coalesce|nullif|num_nonnulls|distinct|from)$/i

// Walk the expression, rewriting bare identifiers and leaving every quoted
// literal exactly as it is. `replace` cannot do this: a regex has no way to know
// it is inside a string.
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
