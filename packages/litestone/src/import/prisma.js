// prisma.js — a Prisma schema, read into .lite.
//
// The output is not the whole answer. THE REFUSAL LIST IS: every construct this
// cannot express is recorded with its model, its field, what the source said and
// what was emitted instead, so the person reading the result is told where it
// stopped being faithful rather than left to find out from a migration.
//
// Deliberately dumb. It does not repair, rename or improve the source — a
// converter that quietly fixes things up is one that cannot report anything, and
// a silent repair is the failure this whole seam exists to avoid.

import { detectPolymorphic } from './polymorphic.js'
import { BIGINT_EMITTED }   from './wide-int.js'

const SCALARS = {
  String: 'String', Int: 'Int', Float: 'Float', Boolean: 'Boolean',
  DateTime: 'DateTime', Json: 'Json', Bytes: 'Bytes',
}

// `labelOneToOne` was the workaround for FJS-563 and is OFF by default now that
// the parser pairs an unlabelled one-to-one itself. Turning it on is how you ask
// whether the fix is still needed: with it off, a regression comes back as a
// parse error naming the field.
export function convert(src, label = 'schema', { labelOneToOne: addLabels = false } = {}) {
  const gaps = []
  const gap = (kind, model, field, detail, emitted) =>
    gaps.push({ source: label, kind, model, field, detail, emitted })

  // A doc comment can hold anything, including a brace, and a brace at the
  // start of a line is how a block is closed here.
  const lines = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
  const out   = []
  const names = []
  let block = null, name = null, body = []

  const flush = () => {
    if (!block) return
    if (block === 'model')     { names.push(name); out.push(...emitModel(name, body, gap, wide)) }
    else if (block === 'enum') out.push(...emitEnum(name, body))
    else if (block === 'type') gap('composite-type', name, null, 'Prisma `type` block (an embedded document)', 'skipped')
    else if (block === 'view') gap('view', name, null, 'Prisma `view` block', 'skipped — .lite has `view`, but its body is SQL')
    block = null
    body  = []
  }

  // Before the emit loop, because whether a BigInt column is wide is a fact
  // about the MODEL — is this scalar named in some relation's `fields: [...]`,
  // is it a generated key — and `emitField` is handed one line. Once emitted a
  // BigInt is an `Int` and indistinguishable from one the source wrote, which
  // is why this reads the SOURCE.
  const wide = wideIntegerSet(lines.join('\n'))

  for (const l of lines) {
    const open = l.match(/^\s*(model|enum|type|view)\s+([A-Za-z0-9_]+)\s*\{/)
    if (open) { flush(); block = open[1]; name = open[2]; body = []; continue }
    if (block && /^\s*\}/.test(l)) { flush(); continue }
    if (block) { body.push(l); continue }
    if (/^\s*(datasource|generator)\s/.test(l)) block = 'skip'
  }
  flush()

  reportWideIntegers(wide, gap)

  const joined = out.join('\n')
  detectPolymorphic(joined, gap)
  if (!addLabels) return { lite: joined, gaps, models: names, relabelled: 0 }
  const { text, count } = labelOneToOne(joined, gap)
  return { lite: text, gaps, models: names, relabelled: count }
}

// ─── blocks ──────────────────────────────────────────────────────────────────

function emitEnum(name, body) {
  const values = body
    .map(l => l.replace(/\/\/.*$/, '').trim())
    .filter(l => l && !l.startsWith('@@'))
    .map(l => l.split(/\s+/)[0])
  return [`enum ${name} {`, ...values.map(v => '  ' + v), '}', '']
}

function emitModel(name, body, gap, wide) {
  let fields = []
  const attrs = [], optional = new Set(), deferred = []
  let compositeId = null

  for (const raw of body) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    if (!line) continue
    if (line.startsWith('@@')) { deferred.push(line); continue }

    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_]+)(\[\])?(\?)?\s*(.*)$/)
    if (!m) { gap('unparsed-line', name, null, line.slice(0, 80), 'dropped'); continue }
    const [, fname, ptype, list, opt, rest] = m
    if (opt) optional.add(fname)
    const f = emitField(name, fname, ptype, !!list, !!opt, rest || '', gap, wide)
    if (f) fields.push(f)
  }

  // Model attributes are read after every field, because @@unique has to know
  // which of its columns are nullable before it can say nullsDistinct.
  const seen = new Set()
  for (const line of deferred) {
    const a = modelAttr(line, name, gap, optional)
    if (a === COMPOSITE_ID) { compositeId = line; continue }
    if (!a) continue
    // Stripping an opclass or an index type can make two DIFFERENT source
    // indexes identical, and litestone derives an index name from its columns,
    // so emitting both is one CREATE INDEX twice.
    if (seen.has(a)) { gap('index-collapsed', name, null, a, 'dropped — identical to an earlier index once its modifiers were stripped'); continue }
    seen.add(a)
    attrs.push(a)
  }

  const hasIdField  = fields.some(f => /^\s{2}id\s/.test(f))
  const hasIdMarker = fields.some(f => /@id\b/.test(f))

  if (compositeId) {
    // Carried, not surrogated. `@@id` is the same spelling here and it means the
    // same thing, so this reads across with nothing lost and nothing graded —
    // it used to invent `id String @id @default(cuid())` plus `@@unique([…])`,
    // which is a DIFFERENT statement (it admits a second identity for the same
    // tuple) and was the first wall a mechanical import met (`FJS-561`).
    const cols = compositeId.match(/\[([^\]]*)\]/)?.[1] ?? ''
    attrs.unshift(`@@id([${cols}])`)
  } else if (!hasIdMarker && !hasIdField) {
    gap('no-primary-key', name, null, 'the model declares no @id', 'surrogate `id String @id @default(cuid())` added')
    fields.unshift('  id String @id @default(cuid())')
  }

  return [`model ${name} {`, ...fields, ...(attrs.length ? ['', ...attrs.map(a => '  ' + a)] : []), '}', '']
}

// ─── fields ──────────────────────────────────────────────────────────────────

function emitField(model, fname, ptype, isList, isOpt, rest, gap, wide) {
  const extra = []
  let type = SCALARS[ptype]

  if (ptype === 'Decimal') {
    const places = rest.match(/@db\.Decimal\(\s*\d+\s*,\s*(\d+)\s*\)/)
    if (places && +places[1] <= 9) { type = 'Int'; extra.push(`@scale(${places[1]})`) }
    else if (places) {
      type = 'Float'
      gap('scale-over-9', model, fname, `@db.Decimal(?, ${places[1]})`,
          'Float — @scale caps at 9 places, because the minor-unit integer runs out of room in front of the point')
    } else {
      type = 'Int'
      extra.push('@scale(2)')
      gap('decimal-no-precision', model, fname, 'Decimal with no @db.Decimal(p, s)', 'Int @scale(2) — a GUESS')
    }
  } else if (ptype === 'BigInt') {
    // Whether this column is a key or a foreign key is a fact about the MODEL
    // and this function is handed a line, so the set is decided up front and
    // passed in. A list is left narrow — an array column is JSON text and
    // JSON's number IS the double, which is what @big exists to get past.
    type = 'Int'
    if (!isList && wide?.has(`${model}.${fname}`)) extra.push('@big')
  } else if (ptype === 'Unsupported') {
    gap('unsupported-column', model, fname, rest.slice(0, 60), 'field dropped')
    return null
  } else if (!type) {
    type = ptype  // an enum or a relation target — resolved by the parser, not here
  }

  if (/@ignore\b/.test(rest)) { gap('ignored-field', model, fname, '@ignore', 'field dropped'); return null }

  for (const native of rest.match(/@db\.[A-Za-z]+(\([^)]*\))?/g) || []) {
    if (ptype === 'Decimal') continue
    gap('native-type', model, fname, native, 'dropped — .lite has no field-level native type')
  }

  const relArgs = balanced(rest, '@relation(')
  if (relArgs !== null) {
    const fieldsArg = relArgs.match(/fields:\s*\[([^\]]*)\]/)?.[1]
    const refsArg   = relArgs.match(/references:\s*\[([^\]]*)\]/)?.[1]
    const label     = relArgs.match(/^\s*"([^"]*)"/)?.[1] ?? relArgs.match(/name:\s*"([^"]*)"/)?.[1]
    const actions   = relArgs.match(/on(?:Delete|Update):\s*\w+/g) || []
    if (fieldsArg && refsArg) {
      const parts = []
      if (label) parts.push(`"${label}"`)
      parts.push(`fields: [${fieldsArg}]`, `references: [${refsArg}]`, ...actions)
      extra.push(`@relation(${parts.join(', ')})`)
      if (fieldsArg.split(',').length > 1)
        gap('composite-foreign-key', model, fname, `fields: [${fieldsArg}]`, 'emitted as written')
    } else if (label) extra.push(`@relation("${label}")`)
  }

  if (/@id\b/.test(rest))        extra.push('@id')
  if (/@unique\b/.test(rest))    extra.push('@unique')
  if (/@updatedAt\b/.test(rest)) extra.push('@updatedAt')

  const mapped = rest.match(/@map\("([^"]*)"\)/)
  if (mapped) extra.push(`@map("${mapped[1]}")`)

  const def = balanced(rest, '@default(')
  if (def !== null) {
    const d = def.trim()
    if (/^dbgenerated\(/.test(d)) gap('dbgenerated-default', model, fname, d.slice(0, 50), 'default dropped')
    else if (/^auto\(\)/.test(d)) gap('mongo-auto-default', model, fname, d, 'default dropped')
    else if (/^(uuid|cuid)\(\s*\d+\s*\)/.test(d)) {
      const fn = d.match(/^(uuid|cuid)/)[1]
      gap('versioned-id-generator', model, fname, d,
          `${fn}() — the version argument is dropped; ulid() is the time-ordered generator .lite ships`)
      extra.push(`@default(${fn}())`)
    } else if (/^\[/.test(d)) {
      gap('array-default', model, fname, `${ptype}[] @default(${d})`,
          'dropped — .lite refuses every array default, the empty one included (FJS-564)')
    } else extra.push(`@default(${d})`)
  }

  const t = type + (isList ? '[]' : '') + (isOpt ? '?' : '')
  return `  ${fname} ${t}${extra.length ? ' ' + extra.join(' ') : ''}`
}

// ─── model attributes ────────────────────────────────────────────────────────

const COMPOSITE_ID = Symbol('composite-id')

// Prisma's typed predicate literal → the .lite expression language.
//
// `{ published: { not: false } }` · `{ status: "active" }` · `{ deletedAt: null }`
// · `{ deletedAt: { not: null } }`. Shallow and deliberately narrow: anything
// with an operator this does not name, a nested relation or a list is answered
// `null` and the caller drops the whole constraint rather than emitting a
// weaker or stronger one. A comma at depth 0 is an AND, which is what Prisma
// means by two keys in one object.
function prismaWhereToLite(src) {
  const body = src.trim().replace(/^\{|\}$/g, '').trim()
  if (!body) return null
  const parts = splitTopLevel(body)
  const out = []
  for (const part of parts) {
    const m = /^([A-Za-z_]\w*)\s*:\s*([\s\S]+)$/.exec(part.trim())
    if (!m) return null
    const [, col, rawVal] = m
    let val = rawVal.trim(), op = '=='
    const not = /^\{\s*not\s*:\s*([\s\S]+?)\s*\}$/.exec(val)
    if (not) { op = '!='; val = not[1].trim() }
    else if (val.startsWith('{')) return null      // an operator this does not name
    if (val === 'null' || val === 'true' || val === 'false' || /^-?\d+(\.\d+)?$/.test(val))
      out.push(`${col} ${op} ${val}`)
    else if (/^"(?:[^"\\]|\\.)*"$/.test(val))
      out.push(`${col} ${op} ${val}`)
    else return null
  }
  return out.join(' && ')
}

function modelAttr(line, model, gap, optional) {
  if (/^@@id\b/.test(line)) return COMPOSITE_ID
  if (/^@@ignore\b/.test(line)) { gap('ignored-model', model, null, '@@ignore', 'kept — .lite has no opt-out'); return null }
  if (/^@@schema\(/.test(line)) { gap('multi-schema', model, null, line, 'dropped'); return null }

  if (/^@@fulltext\(/.test(line)) {
    const cols = bracket(line) ?? ''
    gap('fulltext', model, null, line, `@@fts([${cols}]) — SQLite FTS5, a different engine rather than a translation`)
    return `@@fts([${cols}])`
  }

  if (/^@@(index|unique)\(/.test(line)) {
    const cols = bracket(line) ?? ''
    // `sort:` survives on an @@index — it is the same spelling `.lite` takes,
    // and ZenStack v2 and v3 declare `@@index` byte-identically and mark it
    // `@@@prisma`, so this crosses all three unchanged. `type:`/`ops:` are a
    // Postgres access method and an opclass, and `length:` is MySQL's prefix
    // index — none has a SQLite answer, and a @@unique takes no direction here.
    const isIndex = !/unique/.test(line)
    if (/\(sort:/.test(line) && !isIndex)
      gap('index-modifier', model, null, line.trim(), 'sort dropped — a @@unique takes no direction in .lite')
    if (/type:|ops:|length:/.test(line))
      gap('index-modifier', model, null, line.trim(), 'access method, opclass or prefix length stripped — no SQLite equivalent')

    // Keep `col(sort: Desc)` and strip every other per-column argument.
    const keepSort = (member) => {
      const dir = isIndex && /\(\s*sort:\s*(Asc|Desc)\s*\)/i.exec(member)
      const name = member.replace(/\([\s\S]*\)/, '').trim()
      return dir ? `${name}(sort: ${dir[1][0].toUpperCase()}${dir[1].slice(1).toLowerCase()})` : name
    }
    const clean = splitTopLevel(cols).map(keepSort).filter(Boolean).join(', ')

    if (/unique/.test(line) && clean.includes(',')) {
      const nullable = clean.split(',').map(c => c.trim()).filter(c => optional.has(c))  // a @@unique carries no direction
      if (nullable.length) {
        // FJS-D130. Two NULLs never compare equal, so the index admits the pair
        // twice; nullsDistinct is how a schema says it meant that.
        gap('composite-unique-over-nullable', model, null,
            `@@unique([${clean}]) with ${nullable.join(', ')} optional`,
            'nullsDistinct: true — SQL\'s own word for what SQLite already does (FJS-D130)')
        return `@@unique([${clean}], nullsDistinct: true)`
      }
    }

    const named = line.match(/name:\s*"([^"]*)"/) || line.match(/map:\s*"([^"]*)"/)
    if (named) gap('index-name', model, null, `name/map: "${named[1]}"`, 'dropped — litestone derives index names')

    // Prisma 7.4's partial index, behind its `partialIndexes` preview flag, and
    // the same argument name .lite uses. Two predicate forms and only one of
    // them can be read: a typed object literal is structure this can walk, and
    // `raw("…")` is a SQL string with no schema behind it — .lite has no
    // verbatim predicate anywhere, and inventing one for this would be a second
    // spelling of a predicate in a language that has one.
    //
    // Carried on a @@unique alone. On an @@index the predicate is dropped and
    // the index only widens; on a UNIQUE it is the constraint, so emitting it
    // whole is the only reading that is not a stronger claim than the source.
    const pred = line.match(/\bwhere:\s*([\s\S]*?)\s*\)\s*$/)?.[1]
    if (pred) {
      const asRaw  = /^raw\s*\(/.test(pred)
      const asLite = asRaw ? null : prismaWhereToLite(pred)
      gap('partial-index', model, clean, `${isIndex ? '' : 'unique '}where: ${pred.slice(0, 60)}`,
          !isIndex && asLite ? `carried whole — where: ${asLite}`
        : asRaw              ? 'DROPPED — raw("…") is a SQL string and .lite has no verbatim predicate'
        : isIndex            ? 'emitted without the predicate — a plain index answers the same rows and is only larger'
                             : 'DROPPED — emitting it unconditionally would be a stronger constraint than the source declares')
      if (!isIndex) return asLite ? `@@unique([${clean}], where: ${asLite})` : null
    }
    return `@@${/unique/.test(line) ? 'unique' : 'index'}([${clean}])`
  }

  if (/^@@map\(/.test(line)) {
    const v = line.match(/"([^"]*)"/)?.[1]   // Prisma also accepts @@map(name: "x")
    return v ? `@@map("${v}")` : null
  }

  gap('unknown-model-attribute', model, null, line.trim(), 'dropped')
  return null
}

// ─── the one-to-one pass ─────────────────────────────────────────────────────

// FJS-563: a singular back-reference must be labelled on both sides, or the
// parser reports `unknown type 'B'` for a model it has registered. A list
// back-reference pairs unlabelled. Prisma requires no label either way, so
// every ported one-to-one arrives broken.
function labelOneToOne(src, gap) {
  const lines = src.split('\n')
  const models = new Map()
  let cur = null

  lines.forEach((l, i) => {
    const m = l.match(/^model (\w+) \{/)
    if (m) { cur = { name: m[1], fields: [] }; models.set(m[1], cur); return }
    if (/^\}/.test(l)) { cur = null; return }
    if (!cur) return
    const f = l.match(/^  (\w+) (\w+)(\[\])?(\?)?(.*)$/)
    if (f) cur.fields.push({ i, name: f[1], type: f[2], list: !!f[3], rest: f[5] || '' })
  })

  let count = 0
  for (const [name, model] of models) {
    for (const f of model.fields) {
      if (!models.has(f.type) || f.list || /@relation\(/.test(f.rest)) continue
      const owners = models.get(f.type).fields
        .filter(g => g.type === name && /@relation\(fields:/.test(g.rest) && !/@relation\("/.test(g.rest))
      if (owners.length !== 1) {
        gap('ambiguous-one-to-one', name, f.name,
            `${owners.length} candidate owning fields on ${f.type}`, 'left unlabelled — still an error')
        continue
      }
      const label = `${name}_${f.name}`
      lines[f.i] = lines[f.i] + ` @relation("${label}")`
      lines[owners[0].i] = lines[owners[0].i].replace('@relation(', `@relation("${label}", `)
      gap('unlabelled-one-to-one', name, f.name, `${name}.${f.name} ${f.type} — the non-owning side of a 1:1`,
          `@relation("${label}") added to BOTH sides; unlabelled, the parser reports "unknown type '${f.type}'" (FJS-563)`)
      count++
    }
  }
  return { text: lines.join('\n'), count }
}

// A BigInt column whose values are SUPPLIED rather than generated. `.lite` has
// no wider integer, so every one of them becomes `Int`; what separates the ones
// worth reporting is whether anything can reach 2^53 (wide-int.js).
//
// Structural, never by name: a scalar named in some relation's `fields: [...]`
// holds another model's key, and an `@id @default(autoincrement())` counts from
// one. Everything else is a value the application writes — `appInstallationId`
// included, which is a GitHub id and exactly the case a name rule would skip.
function wideIntegerSet(src) {
  let cur = null
  const models = new Map()

  for (const l of src.split('\n')) {
    const m = l.match(/^model (\w+) \{/)
    if (m) { cur = { name: m[1], fields: [], owned: new Set() }; models.set(m[1], cur); continue }
    if (/^\}/.test(l)) { cur = null; continue }
    if (!cur) continue

    // The SOURCE is column-aligned where the emitted output is not, so the
    // separator is a run of spaces rather than one.
    const f = l.match(/^\s{2,}(\w+)\s+(\w+)(\[\])?(\??)(.*)$/)
    if (!f) continue
    const rest = f[5] || ''
    cur.fields.push({ name: f[1], type: f[2], rest })
    const owns = rest.match(/@relation\([^)]*fields:\s*\[([^\]]*)\]/)
    if (owns) for (const c of owns[1].split(',')) cur.owned.add(c.trim())
  }

  const wide = new Set()
  for (const model of models.values())
    for (const f of model.fields) {
      if (f.type !== 'BigInt') continue
      if (model.owned.has(f.name)) continue
      if (/@id\b/.test(f.rest) && /@default\(\s*autoincrement\(\)/.test(f.rest)) continue
      wide.add(`${model.name}.${f.name}`)
    }
  return wide
}

// The report is the same set said out loud. Split from the walk above because
// the walk now has a second caller — the emitter, which needs the answer before
// it writes the line rather than after.
function reportWideIntegers(wide, gap) {
  for (const key of wide) {
    const [model, field] = key.split('.')
    gap('bigint', model, field, 'BigInt', BIGINT_EMITTED)
  }
  return wide.size
}

// ─── two balanced readers ────────────────────────────────────────────────────

// Prisma nests calls inside @default(…) — dbgenerated("now()"), now(), auto() —
// and column lists inside @@index([a(ops: raw("…"))]). A non-greedy regex drops
// the outer delimiter, and the emitted schema then fails to parse three screens
// later, which reads exactly like a language gap and is not one.
function balanced(s, open) {
  const i = s.indexOf(open)
  if (i < 0) return null
  let depth = 0
  for (let j = i + open.length - 1; j < s.length; j++) {
    if (s[j] === '(') depth++
    else if (s[j] === ')') { depth--; if (!depth) return s.slice(i + open.length, j) }
  }
  return null
}

function bracket(s) {
  const i = s.indexOf('[')
  if (i < 0) return null
  let depth = 0
  for (let j = i; j < s.length; j++) {
    if (s[j] === '[') depth++
    else if (s[j] === ']') { depth--; if (!depth) return s.slice(i + 1, j) }
  }
  return null
}

// A bracketed column list, split on TOP-LEVEL commas — a per-column argument
// may hold one, and `split(',')` cuts the member in half.
function splitTopLevel(list) {
  const out = []
  let cur = '', d = 0
  for (const ch of list) {
    if (ch === '(') d++
    else if (ch === ')') d--
    if (ch === ',' && d === 0) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out.map(c => c.trim()).filter(Boolean)
}
