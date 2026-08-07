// src/testing.js — Test helpers for Litestone
//
// Import from '@frontierjs/litestone/testing'
// Never imported in production code.

export { Factory, defineFactory, Seeder, runSeeder, loadFixture, parseCsv } from './seeder.js'
export { FAKE, fakeFor } from './fake.js'

import { parse }                    from './core/parser.js'
import { generateDDL, generateDDLForDatabase, modelToAccessor } from './core/ddl.js'
import { splitStatements }          from './core/migrate.js'
import { createClient }             from './core/client.js'
import { parseGateString, LEVELS }  from './plugins/gate.js'
import { DEFAULT_MESSAGES }         from './core/validate.js'
import { fakeFor, fakeEmail }       from './fake.js'
import { Database }                 from 'bun:sqlite'
import { Factory }                  from './seeder.js'
import { mkdirSync }                from 'fs'
import { join }                     from 'path'
import { tmpdir }                   from 'os'

// ─── makeTestClient ───────────────────────────────────────────────────────────
//
// One-call test setup: parse schema → create fresh db → apply DDL → open client.
//
// opts:
//   seed          {number}   RNG seed forwarded to all factories
//   factories     {object}   { modelName: FactoryClass, ... }
//   autoFactories {boolean}  Auto-generate factories for all sqlite models (default: false)
//   data          {Function} async (db) => {...}  seeder called after tables created
//   [createClient opts]      encryption, plugins, hooks, etc. forwarded transparently
//
// Returns: { db, factories }
//
// Note: When using autoFactories, all FK fields default to 1.
// Seed FK parents in the `data` option or use withRelation() to avoid FK violations.

export async function makeTestClient(schemaText, opts = {}) {
  const {
    seed,
    factories: factoryClasses = {},
    autoFactories = false,
    data: seederFn,
    ...clientOpts
  } = opts

  const result = parse(schemaText)
  if (!result.valid) throw new Error(`makeTestClient: schema errors:\n${result.errors.join('\n')}`)

  // Unique tmpdir — parallel test runs never collide
  const dir  = join(tmpdir(), `litestone-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'test.db')

  // A `database` block WINS over the `db:` option (documented litestone behaviour),
  // so a schema declaring `database main { path "./db/app.db" }` used to make this
  // helper open the PROJECT'S REAL DATABASE and write test rows into it. Every
  // declared path is overridden into the tmpdir so a test can never reach outside.
  const declared = result.schema.databases ?? []
  const dbOverrides = {}
  for (const d of declared) {
    dbOverrides[d.name] = {
      path: (d.driver === 'jsonl' || d.driver === 'logger')
        ? join(dir, d.name) + '/'
        : (d.name === 'main' ? path : join(dir, `${d.name}.db`)),
    }
  }

  const applyDDL = (file, ddl) => {
    const raw = new Database(file)
    raw.run('PRAGMA journal_mode = WAL')
    raw.run('PRAGMA foreign_keys = ON')
    for (const stmt of splitStatements(ddl))
      if (!stmt.startsWith('PRAGMA')) raw.run(stmt)
    raw.close()
  }

  if (declared.some(d => !d.driver || d.driver === 'sqlite')) {
    // Multi-database schema — each database gets only its own models' tables.
    for (const d of declared) {
      if (d.driver === 'jsonl' || d.driver === 'logger') continue
      applyDDL(dbOverrides[d.name].path, generateDDLForDatabase(result.schema, d.name))
    }
  } else {
    applyDDL(path, generateDDL(result.schema))
  }

  const db = await createClient({
    parsed: result,
    db:     path,
    ...clientOpts,
    databases: { ...dbOverrides, ...(clientOpts.databases ?? {}) },
  })

  if (seederFn) await seederFn(db)

  const factories = {}

  // Auto-factories: generate for all sqlite models first (lowest priority)
  if (autoFactories) {
    const modelDbMap = {}
    for (const model of result.schema.models) {
      const dbAttr = model.attributes?.find(a => a.kind === 'db')
      modelDbMap[model.name] = dbAttr?.name ?? 'main'
    }
    for (const model of result.schema.models) {
      const dbName = modelDbMap[model.name] ?? 'main'
      const dbDef  = result.schema.databases.find(d => d.name === dbName)
      const driver = dbDef?.driver ?? 'sqlite'
      if (driver === 'jsonl' || driver === 'logger') continue
      const writableFields = model.fields.filter(f => !_shouldSkipField(f, model))
      if (!writableFields.length) continue
      // `factories` is passed as the registry BEFORE it is filled — the object
      // identity is what matters, so has()/attach()/withParents() resolve against
      // whatever it holds at call time, including factories defined after this one.
      factories[modelToAccessor(model.name)] = factoryFrom(result.schema, model.name, db, factories)
    }
  }

  // Explicit factory classes (override auto-generated for same model name)
  for (const [name, FactoryClass] of Object.entries(factoryClasses)) {
    let f = new FactoryClass(db)
    // Hand-written factories get the same relation powers as generated ones.
    f._schema   = result.schema
    f._registry = factories
    if (seed != null) f = f.seed(seed)
    factories[name] = f
  }

  // Apply seed to any auto-generated factories not overridden
  if (seed != null) {
    for (const [name, f] of Object.entries(factories)) {
      if (!factoryClasses[name]) factories[name] = f.seed(seed)
    }
  }

  return { db, factories }
}

// ─── truncate ─────────────────────────────────────────────────────────────────

export async function truncate(db, modelName) {
  await db.asSystem()[modelToAccessor(modelName)].deleteMany({})
}

// ─── snapshot / restore ───────────────────────────────────────────────────────
//
// Seed once, restore between tests — the Laravel `RefreshDatabase` shape, without
// re-running the seed. Restoring is a truncate + bulk re-insert of the exact rows,
// which for test-sized data is far cheaper than seeding again.
//
//   const { db, factories } = await makeTestClient(schema, { autoFactories: true })
//   await seedEverything(db)
//   const snap = snapshot(db)
//   beforeEach(() => restore(db, snap))
//
// Deliberately raw: rows are read and written through the write connection, not
// the ORM. That keeps `@encrypted`/`@secret` columns as the exact ciphertext they
// already are (a round trip through the ORM would re-encrypt them), and skips
// gates, policies, hooks and audit logging — a restore is not an application write.
//
// NOT a substitute for a transaction: it does not isolate concurrent work. It is a
// point-in-time copy of every table in every SQLite database the client holds.

export function snapshot(db) {
  const raws = db.$rawDbs
  if (!raws) throw new Error('snapshot() requires a Litestone client with $rawDbs')

  const out = {}
  for (const [dbName, raw] of Object.entries(raws)) {
    if (!raw) continue
    const tables = _userTables(raw)
    const perDb  = {}
    for (const t of tables) perDb[t] = raw.query(`SELECT * FROM "${t}"`).all()
    out[dbName] = perDb
  }
  return out
}

export function restore(db, snap) {
  const raws = db.$rawDbs
  if (!raws) throw new Error('restore() requires a Litestone client with $rawDbs')
  if (!snap) throw new Error('restore(db, snapshot) — pass the value snapshot() returned')

  for (const [dbName, perDb] of Object.entries(snap)) {
    const raw = raws[dbName]
    if (!raw) continue

    // FKs off for the duration: rows go back in table order, not dependency order,
    // and the snapshot was consistent when taken.
    raw.run('PRAGMA foreign_keys = OFF')
    raw.run('BEGIN IMMEDIATE')
    try {
      for (const t of _userTables(raw)) raw.run(`DELETE FROM "${t}"`)
      for (const [table, rows] of Object.entries(perDb)) {
        if (!rows.length) continue
        const cols        = Object.keys(rows[0])
        const colList     = cols.map(c => `"${c}"`).join(', ')
        const placeholders = cols.map(() => '?').join(', ')
        const stmt        = raw.prepare(`INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`)
        for (const row of rows) stmt.run(...cols.map(c => row[c]))
      }
      raw.run('COMMIT')
    } catch (e) {
      raw.run('ROLLBACK')
      throw e
    } finally {
      raw.run('PRAGMA foreign_keys = ON')
    }
  }
}

/** Tables a restore may touch — excludes sqlite internals and FTS shadow tables. */
function _userTables(raw) {
  const rows = raw.query(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
  ).all()
  const names = rows.map(r => r.name)
  // An FTS5 virtual table owns shadow tables (<name>_data, _idx, _content, …).
  // Writing those directly corrupts the index; deleting the virtual table's rows
  // is what maintains them, and litestone rebuilds from triggers on the base table.
  const ftsRoots = names.filter(n => names.includes(`${n}_data`) && names.includes(`${n}_idx`))
  const shadowed = new Set(ftsRoots.flatMap(root =>
    names.filter(n => n.startsWith(`${root}_`))).concat(ftsRoots))
  return names.filter(n => !shadowed.has(n))
}

// ─── reset ────────────────────────────────────────────────────────────────────

export async function reset(db) {
  const schema = db.$schema
  if (!schema) throw new Error('reset() requires a Litestone client with $schema')
  const childFirst = _topoSort(schema.models, schema)
  const sys = db.asSystem()
  for (const name of childFirst) {
    try { await sys[modelToAccessor(name)].deleteMany({}) } catch { /* table may not exist */ }
  }
}

// ─── factoryFrom ─────────────────────────────────────────────────────────────
//
// Zero-config factory. No subclass needed.
//
//   const users = factoryFrom(schema, 'users', db)
//   const admin = await users.state({ role: 'admin' }).createOne()
//
// For traits or afterCreate, extend Factory with a subclass instead.

export function factoryFrom(schema, modelName, db, registry = null) {
  const defFn = generateFactory(schema, modelName)
  const f     = new Factory(db)
  f.model      = modelName
  f.definition = defFn
  f._schema    = schema      // enables has() / attach() / withParents()
  f._registry  = registry
  return f
}

// ─── generateFactory ─────────────────────────────────────────────────────────
//
// Returns a definition(seq, rng) function compatible with Factory.definition.
// Reads field types, attributes, and constraints from parsed schema AST.
//
// Decisions baked in:
//   @default(auth().field) → emits 1 (FK sentinel). Document: callers must
//     override or use `data` seeder to ensure FK parent with id=1 exists.
//   @secret → included (ORM encrypts on write transparently)
//   Type[]  → [] for required, null for optional

export function generateFactory(schema, modelName, options = {}) {
  const model = schema.models.find(m => m.name === modelName)
  if (!model) throw new Error(`generateFactory: model "${modelName}" not found in schema`)

  const { fkDefaults = {} } = options

  // Build set of FK field names from relation declarations
  const fkFields = new Set()
  for (const field of model.fields) {
    if (field.type.kind !== 'relation') continue
    const rel = field.attributes.find(a => a.kind === 'relation' && a.fields)
    if (!rel) continue
    const fkName = Array.isArray(rel.fields) ? rel.fields[0] : rel.fields
    if (fkName) fkFields.add(fkName)
  }

  return function definition(seq, rng) {
    const out = {}
    for (const field of model.fields) {
      if (_shouldSkipField(field, model)) continue

      const name  = field.name
      const type  = field.type
      const attrs = field.attributes
      const opt   = type.optional

      // Array types — honour @minItems, else [] for required / null for optional
      if (type.array) {
        const minItems = attrs.find(a => a.kind === 'minItems')?.value ?? 0
        if (minItems > 0) {
          out[name] = Array.from({ length: minItems }, (_, i) =>
            _scalarSample(type.name, name, seq + i))
        } else {
          out[name] = opt ? null : []
        }
        continue
      }

      // @id on String → '{modelName}-{seq}'
      const isId = attrs.some(a => a.kind === 'id')
      if (isId && type.name === 'String') {
        out[name] = rng ? `${modelName}-${rng.str(6)}` : `${modelName}-${seq}`
        continue
      }

      // @default — check before type-based rules
      const defAttr = attrs.find(a => a.kind === 'default')
      if (defAttr) {
        const v = defAttr.value
        if (v.kind === 'string')  { out[name] = v.value;    continue }
        if (v.kind === 'number')  { out[name] = v.value;    continue }
        if (v.kind === 'boolean') { out[name] = v.value;    continue }
        if (v.kind === 'enum')    { out[name] = v.value;    continue }
        if (v.kind === 'call') {
          // auth().field → emit 1 (FK sentinel, caller must seed parent)
          // NOTE: ensure a row with id=1 exists in the referenced table,
          //       or override this field via .state() / fkDefaults.
          if (v.fn === 'auth') { out[name] = fkDefaults[name] ?? 1; continue }
          // now(), uuid(), ulid(), cuid() → skip (ORM/db generates)
          continue
        }
      }

      // Enum type — first value unseeded (stable), rng.pick when seeded (variety)
      if (type.kind === 'enum' || (type.kind === 'scalar' && type.name !== 'String' && type.name !== 'Int' &&
          type.name !== 'Float' && type.name !== 'Boolean' && type.name !== 'DateTime' &&
          type.name !== 'Json' && type.name !== 'Bytes')) {
        const enumDef = schema.enums.find(e => e.name === type.name)
        if (enumDef) {
          if (!enumDef.values.length) throw new Error(`generateFactory: enum "${type.name}" has no values`)
          out[name] = rng ? rng.pick(enumDef.values).name : enumDef.values[0].name
          continue
        }
      }

      switch (type.name) {
        case 'String': {
          if (opt && !_hasTextConstraint(attrs) && !attrs.some(a => a.kind === 'phone')) {
            out[name] = null
            break
          }
          const token   = rng ? rng.str(4) : String(seq)   // uniqueness carrier
          const lenAttr = attrs.find(a => a.kind === 'length')
          const min     = lenAttr?.min ?? null
          const max     = lenAttr?.max ?? null
          let value

          const regexAttr = attrs.find(a => a.kind === 'regex')
          if (attrs.some(a => a.kind === 'email')) {
            // Keep it inside @length(max) when one is declared — a truncated
            // address would fail @email, which is the rule we are serving.
            const natural = fakeEmail(rng, seq) ?? `${modelName}${token}@test.com`
            value = max != null && max < natural.length
              ? _fitLength(`${token}@t.co`, min, max)
              : natural
          } else if (attrs.some(a => a.kind === 'url')) {
            value = `https://example.com/${modelName}/${token}`
          } else if (regexAttr) {
            // A pattern cannot be inverted in general. Generate a candidate for the
            // common subset, then CHECK it — an unsatisfiable pattern warns loudly
            // instead of writing data the schema will reject on every create.
            value = _sampleFromRegex(regexAttr.pattern, seq)
            if (value == null) {
              value = rng ? `${name}-${token}` : `${name}-${seq}`
              if (!_matchesRegex(regexAttr.pattern, value)) {
                console.warn(`generateFactory: cannot generate a value matching @regex("${regexAttr.pattern}") ` +
                  `for ${modelName}.${name} — override it with .state({ ${name}: … })`)
              }
            }
          } else if (attrs.some(a => a.kind === 'phone')) {
            value = _phoneSample(seq)
          } else {
            const starts   = attrs.find(a => a.kind === 'startsWith')?.text ?? ''
            const ends     = attrs.find(a => a.kind === 'endsWith')?.text   ?? ''
            const contains = attrs.find(a => a.kind === 'contains')?.text
            if (contains != null) {
              value = `${starts}${contains}-${token}${ends}`
            } else if (starts || ends) {
              value = `${starts}${token}${ends}`
            } else {
              // A well-known field name gets a catalogue value when seeded, so a
              // generated row reads like a row. Unseeded output is unchanged —
              // schema-derived test CASES must stay stable.
              const fake = fakeFor(name, rng)
              if (fake != null) {
                // The catalogue is a small pool — two rows CAN draw the same name.
                // A @unique column carries the seq token so it still cannot collide.
                value = attrs.some(a => a.kind === 'unique') ? `${fake} ${token}` : fake
              } else {
                // Plain text — capitalize field name
                const label = name.charAt(0).toUpperCase() + name.slice(1)
                value = rng ? `${label} ${token}` : `${label} ${seq}`
              }
            }
          }

          // @length is a hard boundary. Fitting keeps the seq/token, so a @unique
          // column still gets a distinct value per row — 'x'.repeat(min) did not,
          // and the second insert hit the UNIQUE constraint.
          out[name] = _fitLength(value, min, max, token)
          break
        }

        case 'Int': {
          if (opt) { out[name] = null; break }
          if (fkFields.has(name) || name.endsWith('Id')) {
            out[name] = fkDefaults[name] ?? 1
            break
          }
          const { low, high } = _numericBounds(attrs, 1)
          out[name] = _pickInRange(low, high, seq, true)
          break
        }

        case 'Float': {
          if (opt) { out[name] = null; break }
          const { low, high } = _numericBounds(attrs, 1)
          out[name] = _pickInRange(low, high, seq, false)
          break
        }

        case 'Boolean':
          out[name] = false
          break

        case 'DateTime': {
          if (opt) { out[name] = null; break }
          // Derived from seq, not the wall clock — the same seed must produce the
          // same row, and `new Date()` broke that for every DateTime column.
          out[name] = new Date(FACTORY_EPOCH + (seq % 3650) * 86_400_000).toISOString()
          break
        }

        case 'Json': {
          // A required column cannot take null — the write fails validation, which
          // made autoFactories unusable for any model carrying a required Json.
          out[name] = opt ? null : {}
          break
        }

        case 'Bytes': {
          out[name] = opt ? null : new Uint8Array([seq % 256])
          break
        }

        default:
          out[name] = null
          break
      }
    }
    return out
  }
}

// ─── generateGateMatrix ───────────────────────────────────────────────────────
//
// Returns array of test cases for @@gate on a model.
// Each case: { op, level, label, expect }
//
// Usage:
//   const matrix = generateGateMatrix(schema, 'posts')
//   for (const { op, level, label, expect } of matrix) {
//     test(`${op} as ${label} → ${expect}`, async () => { ... })
//   }

export function generateGateMatrix(schema, modelName) {
  const model = schema.models.find(m => m.name === modelName)
  if (!model) throw new Error(`generateGateMatrix: model "${modelName}" not found in schema`)

  const gateAttr = model.attributes?.find(a => a.kind === 'gate')
  if (!gateAttr) return []

  const gate = parseGateString(gateAttr.value)
  const ops  = ['read', 'create', 'update', 'delete']

  // Reverse lookup: level number → label string
  const levelLabel = {}
  for (const [name, val] of Object.entries(LEVELS)) levelLabel[val] = name
  const getLabel = (n) => levelLabel[n] ?? `LEVEL_${n}`

  const cases = []
  for (const op of ops) {
    const required = gate[op]

    if (required === 9) {
      // LOCKED — nothing passes, emit deny at SYSTEM (8)
      cases.push({ op, level: 8, label: getLabel(8), expect: 'deny' })
      continue
    }

    // Allow case — exact required level
    cases.push({ op, level: required, label: getLabel(required), expect: 'allow' })

    // Deny case — one below required (skip when required is 0, no level below STRANGER)
    if (required > 0) {
      cases.push({ op, level: required - 1, label: getLabel(required - 1), expect: 'deny' })
    }
  }

  return cases
}

// ─── generateValidationCases ──────────────────────────────────────────────────
//
// Returns { valid, invalid, boundary } for a model.
//
//   valid    — complete valid record (from generateFactory)
//   invalid  — one failing case per constraint
//   boundary — boundary values that should pass
//
// Usage:
//   const cases = generateValidationCases(schema, 'leads')
//   test('valid data passes', async () => {
//     await db.lead.create({ data: cases.valid })
//   })
//   for (const c of cases.invalid) {
//     test(`${c.field}: ${c.rule} rejects ${c.value}`, async () => {
//       const data = { ...cases.valid, [c.field]: c.value }
//       await expect(db.lead.create({ data })).rejects.toThrow(c.message)
//     })
//   }

export function generateValidationCases(schema, modelName) {
  const model = schema.models.find(m => m.name === modelName)
  if (!model) throw new Error(`generateValidationCases: model "${modelName}" not found in schema`)

  const defFn = generateFactory(schema, modelName)
  const valid  = defFn(1, null)
  const invalid  = []
  const boundary = []

  for (const field of model.fields) {
    if (field.type.kind === 'relation') continue
    if (field.type.array) continue

    const name  = field.name
    const isInt = field.type.name === 'Int'
    const isOpt = field.type.optional

    for (const attr of field.attributes) {
      switch (attr.kind) {
        case 'email':
          invalid.push({ field: name, value: 'not-an-email', rule: '@email',
            expect: 'fail', message: DEFAULT_MESSAGES.email() })
          break

        case 'url':
          invalid.push({ field: name, value: 'not-a-url', rule: '@url',
            expect: 'fail', message: DEFAULT_MESSAGES.url() })
          break

        case 'date':
          invalid.push({ field: name, value: 'not-a-date', rule: '@date',
            expect: 'fail', message: DEFAULT_MESSAGES.date() })
          break

        case 'datetime':
          invalid.push({ field: name, value: 'not-a-datetime', rule: '@datetime',
            expect: 'fail', message: DEFAULT_MESSAGES.datetime() })
          break

        case 'regex': {
          invalid.push({ field: name, value: '!!!', rule: `@regex(${attr.pattern})`,
            expect: 'fail', message: DEFAULT_MESSAGES.regex(attr.pattern) })
          break
        }

        case 'length': {
          const { min, max } = attr
          const rule = `@length(${min ?? ''},${max ?? ''})`
          if (min != null && min > 0) {
            invalid.push({ field: name, value: '', rule,
              expect: 'fail', message: DEFAULT_MESSAGES.length(min, max) })
            boundary.push({ field: name, value: 'x'.repeat(min), rule,
              expect: 'pass', message: '' })
          }
          if (max != null) {
            invalid.push({ field: name, value: 'x'.repeat(max + 1), rule,
              expect: 'fail', message: DEFAULT_MESSAGES.length(min, max) })
            boundary.push({ field: name, value: 'x'.repeat(max), rule,
              expect: 'pass', message: '' })
          }
          break
        }

        case 'gte': {
          const delta = isInt ? 1 : 0.01
          invalid.push({ field: name, value: attr.value - delta, rule: `@gte(${attr.value})`,
            expect: 'fail', message: DEFAULT_MESSAGES.gte(attr.value) })
          boundary.push({ field: name, value: attr.value, rule: `@gte(${attr.value})`,
            expect: 'pass', message: '' })
          break
        }

        case 'gt': {
          const delta = isInt ? 1 : 0.01
          invalid.push({ field: name, value: attr.value, rule: `@gt(${attr.value})`,
            expect: 'fail', message: DEFAULT_MESSAGES.gt(attr.value) })
          boundary.push({ field: name, value: attr.value + delta, rule: `@gt(${attr.value})`,
            expect: 'pass', message: '' })
          break
        }

        case 'lte': {
          const delta = isInt ? 1 : 0.01
          invalid.push({ field: name, value: attr.value + delta, rule: `@lte(${attr.value})`,
            expect: 'fail', message: DEFAULT_MESSAGES.lte(attr.value) })
          boundary.push({ field: name, value: attr.value, rule: `@lte(${attr.value})`,
            expect: 'pass', message: '' })
          break
        }

        case 'lt': {
          const delta = isInt ? 1 : 0.01
          invalid.push({ field: name, value: attr.value, rule: `@lt(${attr.value})`,
            expect: 'fail', message: DEFAULT_MESSAGES.lt(attr.value) })
          boundary.push({ field: name, value: attr.value - delta, rule: `@lt(${attr.value})`,
            expect: 'pass', message: '' })
          break
        }

        case 'startsWith':
          invalid.push({ field: name, value: `wrong${attr.text}`, rule: `@startsWith("${attr.text}")`,
            expect: 'fail', message: DEFAULT_MESSAGES.startsWith(attr.text) })
          break

        case 'endsWith':
          invalid.push({ field: name, value: `${attr.text}wrong`, rule: `@endsWith("${attr.text}")`,
            expect: 'fail', message: DEFAULT_MESSAGES.endsWith(attr.text) })
          break

        case 'contains':
          invalid.push({ field: name, value: 'nope', rule: `@contains("${attr.text}")`,
            expect: 'fail', message: DEFAULT_MESSAGES.contains(attr.text) })
          break
      }
    }
  }

  return { valid, invalid, boundary }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _shouldSkipField(field, model) {
  const attrs = field.attributes
  const name  = field.name
  const type  = field.type

  if (type.kind === 'relation' || type.kind === 'implicitM2M') return true   // virtual
  if (type.name === 'File')     return true   // file upload concern

  if (attrs.some(a => a.kind === 'computed')) return true
  if (attrs.some(a => a.kind === 'from'))     return true  // subquery — not writable
  if (attrs.some(a => a.kind === 'generated')) return true
  if (attrs.some(a => a.kind === 'funcCall'))  return true
  // @sequence — the db owns this counter. An explicit value IS honoured and moves
  // the counter forward, so emitting one both defeats the feature and collides
  // with any @@unique([scope, seqField]) declared alongside it.
  if (attrs.some(a => a.kind === 'sequence')) return true

  // @id on Int → auto-increment
  const isId  = attrs.some(a => a.kind === 'id')
  if (isId && type.name === 'Int') return true

  const defAttr = attrs.find(a => a.kind === 'default')
  if (defAttr) {
    // @updatedAt implies DEFAULT in DDL — skip
    if (attrs.some(a => a.kind === 'updatedAt')) return true
    // @default(now()), uuid(), ulid(), cuid() — db/ORM generates
    if (defAttr.value?.kind === 'call' && defAttr.value.fn !== 'auth') return true
  }
  if (attrs.some(a => a.kind === 'updatedAt')) return true

  // @createdBy / @updatedBy are stamped from ctx.auth — a factory value would
  // be overwritten under $setAuth and is meaningless without it
  if (attrs.some(a => a.kind === 'createdBy' || a.kind === 'updatedBy')) return true

  // @version is owned by the client — always 1 on create, bumped by SQL after
  if (attrs.some(a => a.kind === 'version')) return true

  // Well-known auto-timestamp fields
  if (name === 'createdAt') return true
  if (name === 'updatedAt') return true
  if (name === 'deletedAt') return true   // soft delete marker, never set on create

  return false
}

function _hasTextConstraint(attrs) {
  const constraintKinds = new Set(['email','url','regex','length','startsWith','endsWith','contains'])
  return attrs.some(a => constraintKinds.has(a.kind))
}

// Fixed base date for generated DateTime values — 2024-01-01T00:00:00.000Z.
const FACTORY_EPOCH = Date.UTC(2024, 0, 1)

/** Pad to `min`, truncate to `max`. Padding carries `token` so the value stays unique. */
function _fitLength(value, min, max, token = '') {
  let out = String(value)
  if (min != null && out.length < min) {
    // Pad with the token first (keeps uniqueness), then filler.
    while (out.length < min && token) out += token
    while (out.length < min) out += 'x'
  }
  if (max != null && out.length > max) out = out.slice(0, max)
  return out
}

/**
 * Resolve @gte/@gt/@lte/@lt into an inclusive [low, high]. `step` converts an
 * exclusive bound into an inclusive one. Either end may be null (unbounded).
 */
function _numericBounds(attrs, step) {
  const gte = attrs.find(a => a.kind === 'gte')
  const gt  = attrs.find(a => a.kind === 'gt')
  const lte = attrs.find(a => a.kind === 'lte')
  const lt  = attrs.find(a => a.kind === 'lt')

  let low  = gte ? gte.value : (gt ? gt.value + step : null)
  let high = lte ? lte.value : (lt ? lt.value - step : null)

  // Exclusive bounds on both ends of a narrow range can cross — fall back to the
  // midpoint of the raw bounds, which satisfies both.
  if (low != null && high != null && low > high) {
    const mid = ((gte ?? gt).value + (lte ?? lt).value) / 2
    low = high = mid
  }
  return { low, high }
}

/** A value inside [low, high] that still varies with seq, so @unique survives. */
function _pickInRange(low, high, seq, isInt) {
  if (low == null && high == null) return isInt ? seq : seq * 1.0
  if (low != null && high != null) {
    if (low === high) return low
    // Midpoint when seq is the first row (pins the documented @gte(0)@lte(100) → 50),
    // then walk the range so repeated creates do not collide.
    const span = high - low
    if (!isInt) return low + span / 2
    const offset = Math.floor(span / 2) + (seq - 1)
    return low + (offset % (span + 1))
  }
  if (low  != null) return isInt ? low  + ((seq - 1) % 1000) : low
  return isInt ? high - ((seq - 1) % 1000) : high
}

/** E.164-ish value that satisfies litestone's @phone rule and varies with seq. */
function _phoneSample(seq) {
  return `+1555${String(seq % 10_000_000).padStart(7, '0')}`
}

function _matchesRegex(pattern, value) {
  try { return new RegExp(pattern).test(String(value)) } catch { return false }
}

/** One element for an array field, typed by the element's scalar type. */
function _scalarSample(typeName, fieldName, i) {
  switch (typeName) {
    case 'Int':      return i
    case 'Float':    return i * 1.0
    case 'Boolean':  return false
    case 'DateTime': return new Date(FACTORY_EPOCH + (i % 3650) * 86_400_000).toISOString()
    case 'Json':     return {}
    default:         return `${fieldName}-${i}`
  }
}

// ─── _sampleFromRegex ─────────────────────────────────────────────────────────
//
// Generates a string matching the common subset of regex used in schemas:
// anchors, literals, escapes (\d \w \s \. …), character classes with ranges and
// negation, groups, alternation, and the {n} {n,m} ? + * quantifiers.
//
// Returns null for anything outside that subset (lookarounds, backreferences) or
// when the generated candidate does not actually match — the caller warns rather
// than emitting a value the validator will reject.

function _sampleFromRegex(pattern, seq) {
  let out
  try { out = _regexGen(pattern, seq) } catch { return null }
  if (out == null) return null
  return _matchesRegex(pattern, out) ? out : null
}

function _regexGen(pattern, seq) {
  let src = pattern
  if (src.startsWith('^')) src = src.slice(1)
  if (src.endsWith('$') && !src.endsWith('\\$')) src = src.slice(0, -1)

  let i = 0
  const parseAlternation = (stop) => {
    const branches = [parseSequence(stop)]
    while (i < src.length && src[i] === '|') { i++; branches.push(parseSequence(stop)) }
    return branches[0]   // first branch — deterministic and always valid
  }

  const parseSequence = (stop) => {
    let out = ''
    while (i < src.length && src[i] !== '|' && !(stop && src[i] === stop)) {
      out += parseQuantified()
    }
    return out
  }

  const parseQuantified = () => {
    const atom = parseAtom()
    let min = 1
    if (src[i] === '{') {
      const close = src.indexOf('}', i)
      if (close === -1) throw new Error('unbalanced {')
      const body = src.slice(i + 1, close)
      i = close + 1
      min = parseInt(body.split(',')[0], 10)
      if (Number.isNaN(min)) throw new Error('bad quantifier')
    } else if (src[i] === '?') { i++; min = 0 }
    else if (src[i] === '*')   { i++; min = 0 }
    else if (src[i] === '+')   { i++; min = 1 }
    if (src[i] === '?') i++    // lazy modifier — same output
    return atom.repeat(min)
  }

  const parseAtom = () => {
    const ch = src[i]
    if (ch === '(') {
      i++
      if (src.slice(i, i + 2) === '?:') i += 2
      else if (src[i] === '?') throw new Error('lookaround unsupported')
      const inner = parseAlternation(')')
      if (src[i] !== ')') throw new Error('unbalanced (')
      i++
      return inner
    }
    if (ch === '[') {
      i++
      let neg = false
      if (src[i] === '^') { neg = true; i++ }
      const members = []
      while (i < src.length && src[i] !== ']') {
        let c = src[i]
        if (c === '\\') { i++; members.push(..._escapeChars(src[i])); i++; continue }
        if (src[i + 1] === '-' && src[i + 2] && src[i + 2] !== ']') {
          for (let k = src.charCodeAt(i); k <= src.charCodeAt(i + 2); k++) members.push(String.fromCharCode(k))
          i += 3
          continue
        }
        members.push(c); i++
      }
      if (src[i] !== ']') throw new Error('unbalanced [')
      i++
      const pool = neg ? 'abcdefghijklmnopqrstuvwxyz0123456789'.split('').filter(c => !members.includes(c)) : members
      if (!pool.length) throw new Error('empty class')
      return pool[seq % pool.length]
    }
    if (ch === '\\') {
      i++
      const chars = _escapeChars(src[i]); i++
      return chars[seq % chars.length]
    }
    if (ch === '.') { i++; return 'a' }
    if (ch === undefined) throw new Error('unexpected end')
    i++
    return ch
  }

  const out = parseAlternation(null)
  if (i < src.length) throw new Error('trailing input')
  return out
}

function _escapeChars(c) {
  switch (c) {
    case 'd': return '0123456789'.split('')
    case 'w': return 'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')
    case 's': return [' ']
    case 'D': return 'abcdefghijklmnopqrstuvwxyz'.split('')
    case 'W': return ['-']
    case 'S': return 'abcdefghijklmnopqrstuvwxyz'.split('')
    case 'n': return ['\n']
    case 't': return ['\t']
    default:  return [c]
  }
}

function _topoSort(models, schema) {
  const deps = new Map(models.map(m => [m.name, new Set()]))
  for (const model of models) {
    for (const field of model.fields) {
      if (field.type.kind !== 'relation') continue
      const relAttr = field.attributes.find(a => a.kind === 'relation')
      const target  = field.type.name
      if (target && deps.has(target) && target !== model.name) {
        if (relAttr?.fields?.length || (!relAttr && !field.type.array)) {
          deps.get(model.name).add(target)
        }
      }
    }
  }
  const result   = []
  const inDegree = new Map(models.map(m => [m.name, 0]))
  for (const [, depSet] of deps)
    for (const dep of depSet)
      inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1)
  const queue = [...models.map(m => m.name).filter(n => inDegree.get(n) === 0)]
  while (queue.length) {
    const name = queue.shift()
    result.push(name)
    for (const dep of (deps.get(name) ?? [])) {
      const d = (inDegree.get(dep) ?? 1) - 1
      inDegree.set(dep, d)
      if (d === 0) queue.push(dep)
    }
  }
  for (const m of models) if (!result.includes(m.name)) result.push(m.name)
  return result
}
