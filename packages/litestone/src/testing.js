// src/testing.js — Test helpers for Litestone
//
// Import from '@frontierjs/litestone/testing'
// Never imported in production code.

export { Factory, Seeder, runSeeder } from './seeder.js'

import { parse }                    from './core/parser.js'
import { generateDDL, modelToAccessor } from './core/ddl.js'
import { splitStatements }          from './core/migrate.js'
import { createClient }             from './core/client.js'
import { parseGateString, LEVELS }  from './plugins/gate.js'
import { DEFAULT_MESSAGES }         from './core/validate.js'
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

  const raw = new Database(path)
  raw.run('PRAGMA journal_mode = WAL')
  raw.run('PRAGMA foreign_keys = ON')
  for (const stmt of splitStatements(generateDDL(result.schema)))
    if (!stmt.startsWith('PRAGMA')) raw.run(stmt)
  raw.close()

  const db = await createClient({ parsed: result, db: path, ...clientOpts })

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
      factories[modelToAccessor(model.name)] = factoryFrom(result.schema, model.name, db)
    }
  }

  // Explicit factory classes (override auto-generated for same model name)
  for (const [name, FactoryClass] of Object.entries(factoryClasses)) {
    let f = new FactoryClass(db)
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

export function factoryFrom(schema, modelName, db) {
  const defFn = generateFactory(schema, modelName)
  const f     = new Factory(db)
  f.model      = modelName
  f.definition = defFn
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

      // Array types — [] for required, null for optional
      if (type.array) {
        out[name] = opt ? null : []
        continue
      }

      // @id on Text → '{modelName}-{seq}'
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

      // Enum type (no default → first value)
      if (type.kind === 'enum' || (type.kind === 'scalar' && type.name !== 'String' && type.name !== 'Int' &&
          type.name !== 'Float' && type.name !== 'Boolean' && type.name !== 'DateTime' &&
          type.name !== 'Json' && type.name !== 'Bytes')) {
        const enumDef = schema.enums.find(e => e.name === type.name)
        if (enumDef) {
          if (!enumDef.values.length) throw new Error(`generateFactory: enum "${type.name}" has no values`)
          out[name] = enumDef.values[0].name
          continue
        }
      }

      switch (type.name) {
        case 'String': {
          if (opt && !_hasTextConstraint(attrs)) { out[name] = null; break }
          const emailAttr = attrs.find(a => a.kind === 'email')
          if (emailAttr) {
            out[name] = rng ? `${modelName}${rng.str(4)}@test.com` : `${modelName}${seq}@test.com`
            break
          }
          const urlAttr = attrs.find(a => a.kind === 'url')
          if (urlAttr) {
            out[name] = rng ? `https://example.com/${modelName}/${rng.str(4)}` : `https://example.com/${modelName}/${seq}`
            break
          }
          const lenAttr = attrs.find(a => a.kind === 'length')
          if (lenAttr) {
            const min = lenAttr.min ?? 1
            out[name] = 'x'.repeat(min)
            break
          }
          const regexAttr = attrs.find(a => a.kind === 'regex')
          if (regexAttr) {
            out[name] = rng ? `${name}-${rng.str(4)}` : `${name}-${seq}`
            break
          }
          const containsAttr = attrs.find(a => a.kind === 'contains')
          if (containsAttr) {
            out[name] = rng ? `${containsAttr.text}-${rng.str(4)}` : `${containsAttr.text}-${seq}`
            break
          }
          // Plain text — capitalize field name
          const label = name.charAt(0).toUpperCase() + name.slice(1)
          out[name] = rng ? `${label} ${rng.str(4)}` : `${label} ${seq}`
          break
        }

        case 'Int': {
          if (opt) { out[name] = null; break }
          if (fkFields.has(name) || name.endsWith('Id')) {
            out[name] = fkDefaults[name] ?? 1
          } else {
            out[name] = seq
          }
          break
        }

        case 'Float': {
          if (opt) { out[name] = null; break }
          const gteAttr = attrs.find(a => a.kind === 'gte')
          const lteAttr = attrs.find(a => a.kind === 'lte')
          if (gteAttr != null && lteAttr != null) {
            out[name] = Math.floor((gteAttr.value + lteAttr.value) / 2)
          } else if (gteAttr != null) {
            out[name] = gteAttr.value
          } else {
            out[name] = seq * 1.0
          }
          break
        }

        case 'Boolean':
          out[name] = false
          break

        case 'DateTime': {
          if (opt) { out[name] = null; break }
          out[name] = new Date().toISOString()
          break
        }

        case 'Json':
        case 'Bytes':
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
//     await db.leads.create({ data: cases.valid })
//   })
//   for (const c of cases.invalid) {
//     test(`${c.field}: ${c.rule} rejects ${c.value}`, async () => {
//       const data = { ...cases.valid, [c.field]: c.value }
//       await expect(db.leads.create({ data })).rejects.toThrow(c.message)
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

  // @id on Integer → auto-increment
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
