// prisma-to-lite.mjs — a Prisma schema, converted mechanically to .lite.
//
// The output is not the artifact. THE REFUSAL LIST IS: every construct this
// cannot express is recorded with its model, its field and what was emitted
// instead, so a run over N real repositories answers "what does .lite not say"
// without anybody guessing in advance. A gap found this way is one nobody
// anticipated, which is the half a `fli check` rule can never reach.
//
// Deliberately dumb. It does not repair, rename or improve the source — a
// converter that quietly fixes things up is one that cannot find anything.
//
// The product form of this is `litestone import --from prisma`, which does not
// exist; see IDEAS/proving-grounds.md § The corpus. This copy exists to
// regenerate the fixtures beside it.

import { detectPolymorphic } from './polymorphic.mjs'

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
    gaps.push({ repo: label, kind, model, field, detail, emitted })

  // A doc comment can hold anything, including a brace, and a brace at the
  // start of a line is how a block is closed here.
  const lines = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
  const out   = []
  const names = []
  let block = null, name = null, body = []

  const flush = () => {
    if (!block) return
    if (block === 'model')     { names.push(name); out.push(...emitModel(name, body, gap)) }
    else if (block === 'enum') out.push(...emitEnum(name, body))
    else if (block === 'type') gap('composite-type', name, null, 'Prisma `type` block (an embedded document)', 'skipped')
    else if (block === 'view') gap('view', name, null, 'Prisma `view` block', 'skipped — .lite has `view`, but its body is SQL')
    block = null
    body  = []
  }

  for (const l of lines) {
    const open = l.match(/^\s*(model|enum|type|view)\s+([A-Za-z0-9_]+)\s*\{/)
    if (open) { flush(); block = open[1]; name = open[2]; body = []; continue }
    if (block && /^\s*\}/.test(l)) { flush(); continue }
    if (block) { body.push(l); continue }
    if (/^\s*(datasource|generator)\s/.test(l)) block = 'skip'
  }
  flush()

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

function emitModel(name, body, gap) {
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
    const f = emitField(name, fname, ptype, !!list, !!opt, rest || '', gap)
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
    // FJS-561: there is no @@id. A surrogate key is a DIFFERENT statement — it
    // admits a second identity for the same tuple — so it is emitted as one.
    const cols = compositeId.match(/\[([^\]]*)\]/)?.[1] ?? ''
    gap('composite-primary-key', name, null, `@@id([${cols}])`,
        'surrogate `id String @id @default(cuid())` + `@@unique([…])` — admits a second identity for the same tuple')
    if (!hasIdField) fields.unshift('  id String @id @default(cuid())')
    else if (!hasIdMarker) fields = fields.map(f => /^\s{2}id\s/.test(f) ? f.replace(/^(\s{2}id\s+\w+\??)/, '$1 @id') : f)
    attrs.push(`@@unique([${cols}])`)
  } else if (!hasIdMarker && !hasIdField) {
    gap('no-primary-key', name, null, 'the model declares no @id', 'surrogate `id String @id @default(cuid())` added')
    fields.unshift('  id String @id @default(cuid())')
  }

  return [`model ${name} {`, ...fields, ...(attrs.length ? ['', ...attrs.map(a => '  ' + a)] : []), '}', '']
}

// ─── fields ──────────────────────────────────────────────────────────────────

function emitField(model, fname, ptype, isList, isOpt, rest, gap) {
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
    type = 'Int'
    gap('bigint', model, fname, 'BigInt', 'Int — SQLite INTEGER is 64-bit, so the range holds; the name does not')
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
    if (/\(sort:|type:|ops:|length:/.test(line)) gap('index-modifier', model, null, line.trim(), 'modifiers stripped')

    let clean = cols, prev
    do { prev = clean; clean = clean.replace(/\([^()]*\)/g, '') } while (clean !== prev)
    clean = clean.split(',').map(c => c.trim()).filter(Boolean).join(', ')

    if (/unique/.test(line) && clean.includes(',')) {
      const nullable = clean.split(',').map(c => c.trim()).filter(c => optional.has(c))
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
