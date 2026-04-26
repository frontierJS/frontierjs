// drivers/jsonl.js — append-only JSONL database driver
//
// Models with @@db(name) where `name` has driver: jsonl route through here.
//
// Write path:  append JSON line to file
//              track byte offset in companion .index.db (if @@index declared)
//
// Read path:
//   No @@index  → stream file into memory → JS filter/sort/slice
//   With @@index → query index.db for offsets → seek to each offset in file
//
// Operations supported:  findMany, findFirst, findUnique, count, create, createMany
// Operations blocked:    update, updateMany, delete, deleteMany, upsert, remove, restore
//
// Companion index file:  <path>.index.db
//   Table: <model>_idx  — indexed fields + _offset (byte position in .jsonl)
//   Created automatically when first record is written.

import {
  existsSync, mkdirSync, appendFileSync, readFileSync,
  statSync, openSync, readSync, closeSync } from 'fs'
import { dirname }    from 'path'
import { Database }   from 'bun:sqlite'
import { buildWhere } from '../core/query.js'
import { compactJsonl } from '../tools/retention.js'

// ─── File I/O ─────────────────────────────────────────────────────────────────

// Read a single JSON line from a file at a given byte offset.
// Uses low-level fd seek — O(1), does not scan from the start.
function readLineAtOffset(filePath, offset) {
  const fd     = openSync(filePath, 'r')
  const chunks = []
  const buf    = Buffer.allocUnsafe(2048)
  let   pos    = offset

  try {
    while (true) {
      const n  = readSync(fd, buf, 0, buf.length, pos)
      if (n === 0) break
      const nl = buf.indexOf(0x0a, 0)       // 0x0a = '\n'
      const end = (nl >= 0 && nl < n) ? nl : n
      chunks.push(buf.slice(0, end).toString('utf8'))
      if (nl >= 0 && nl < n) break
      pos += n
    }
  } finally {
    closeSync(fd)
  }

  const line = chunks.join('').trim()
  return line ? JSON.parse(line) : null
}

// Load all valid records from a JSONL file into memory.
function loadAll(filePath) {
  if (!existsSync(filePath)) return []
  const content = readFileSync(filePath, 'utf8')
  const records = []
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { records.push(JSON.parse(t)) } catch { /* skip malformed lines */ }
  }
  return records
}

// Append a JSON record to a file. Returns the byte offset where the line was written.
function appendRecord(filePath, record) {
  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true })
    appendFileSync(filePath, '', 'utf8')
  }
  const offset = statSync(filePath).size
  appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8')
  return offset
}

// ─── JavaScript query engine (no-index path) ──────────────────────────────────
// Used when the model has no @@index, or the where clause touches non-indexed fields.

function matchCondition(val, cond) {
  if (cond === null || cond === undefined) return val == null
  if (typeof cond !== 'object')            return val === cond
  if ('not'        in cond && (cond.not === null ? val != null  : val === cond.not))      return false
  if ('gt'         in cond && !(val >  cond.gt))   return false
  if ('gte'        in cond && !(val >= cond.gte))  return false
  if ('lt'         in cond && !(val <  cond.lt))   return false
  if ('lte'        in cond && !(val <= cond.lte))  return false
  if ('in'         in cond && !cond.in.includes(val)) return false
  if ('notIn'      in cond && cond.notIn.includes(val)) return false
  if ('contains'   in cond && !String(val ?? '').toLowerCase().includes(String(cond.contains).toLowerCase())) return false
  if ('startsWith' in cond && !String(val ?? '').startsWith(String(cond.startsWith))) return false
  if ('endsWith'   in cond && !String(val ?? '').endsWith(String(cond.endsWith)))    return false
  return true
}

function matchWhere(record, where) {
  if (!where) return true
  if (where.AND) return where.AND.every(w  => matchWhere(record, w))
  if (where.OR)  return where.OR.some(w   => matchWhere(record, w))
  if (where.NOT) return !matchWhere(record, where.NOT)
  for (const [key, cond] of Object.entries(where)) {
    if (!matchCondition(record[key], cond)) return false
  }
  return true
}

function applyOrderBy(records, orderBy) {
  if (!orderBy) return records
  const orders = Array.isArray(orderBy) ? orderBy : [orderBy]
  return [...records].sort((a, b) => {
    for (const order of orders) {
      for (const [key, dir] of Object.entries(order)) {
        const av = a[key] ?? null, bv = b[key] ?? null
        const cmp = av < bv ? -1 : av > bv ? 1 : 0
        if (cmp !== 0) return dir === 'desc' ? -cmp : cmp
      }
    }
    return 0
  })
}

// Extract all top-level field names referenced in a where clause
function extractWhereFields(where) {
  const fields = new Set()
  if (!where || typeof where !== 'object') return fields
  for (const key of Object.keys(where)) {
    if (key === 'AND' || key === 'OR') {
      const arr = Array.isArray(where[key]) ? where[key] : [where[key]]
      for (const w of arr) extractWhereFields(w).forEach(f => fields.add(f))
    } else if (key !== 'NOT') {
      fields.add(key)
    }
  }
  return fields
}

// ─── SQLite type mapping ───────────────────────────────────────────────────────

const FIELD_TYPES = { Integer: 'INTEGER', Real: 'REAL', Boolean: 'INTEGER', DateTime: 'TEXT', Text: 'TEXT', Json: 'TEXT', File: 'TEXT' }

// ─── Default resolution ───────────────────────────────────────────────────────

function resolveDefault(field) {
  const def = field.attributes.find(a => a.kind === 'default')
  if (!def) return undefined
  const v = def.value
  if (v.kind === 'call'    && v.fn === 'now')  return new Date().toISOString()
  if (v.kind === 'call'    && v.fn === 'uuid') return crypto.randomUUID()
  if (v.kind === 'string')  return v.value
  if (v.kind === 'number')  return v.value
  if (v.kind === 'boolean') return v.value
  if (v.kind === 'enum')    return v.value
  return undefined
}

// ─── Table factory ────────────────────────────────────────────────────────────

export function makeJsonlTable(filePath, model, schema, retention = null, maxSize = null) {
  // Run compaction immediately if retention or maxSize is configured.
  // This happens once when createClient() opens — before any queries are served.
  if (retention || maxSize) {
    try { compactJsonl(filePath, model, retention, maxSize) } catch { /* non-fatal */ }
  }

  // Fields that get stored in the JSONL file (no relation/computed)
  const storedFields = model.fields.filter(f =>
    f.type.kind !== 'relation' &&
    !f.attributes.some(a => a.kind === 'computed')
  )

  // @id field name — optional for JSONL models (audit logs, event streams don't need one)
  const idField = model.fields.find(f => f.attributes.some(a => a.kind === 'id'))
  const idName  = idField?.name ?? null   // null = no @id declared

  // @@index attributes and the set of indexed field names.
  // When @id is present it's included so the index can do INSERT OR REPLACE (upsert by id).
  // When @id is absent (e.g. audit log), indexed fields come purely from @@index attrs —
  // _offset is the primary key in that case since every appended line has a unique offset.
  const indexAttrs        = model.attributes.filter(a => a.kind === 'index')
  const hasIndex          = indexAttrs.length > 0
  const indexedFieldNames = idName
    ? [...new Set([idName, ...indexAttrs.flatMap(a => a.fields)])]
    : [...new Set(indexAttrs.flatMap(a => a.fields))]

  // ── Companion index.db ────────────────────────────────────────────────────

  let _indexDb = null

  function getIndexDb() {
    if (_indexDb) return _indexDb
    _indexDb = new Database(filePath + '.index.db')

    // Build index table: indexed fields + _offset
    // Primary key is the @id field when present, otherwise _offset itself.
    const colDefs = indexedFieldNames.map(name => {
      const f    = storedFields.find(f => f.name === name)
      const type = f ? (FIELD_TYPES[f.type.name] ?? 'TEXT') : 'TEXT'
      return `  "${name}" ${type}`
    })
    colDefs.push(`  "_offset" INTEGER NOT NULL`)

    const pk = idName ? `PRIMARY KEY ("${idName}")` : `PRIMARY KEY ("_offset")`

    _indexDb.run(
      `CREATE TABLE IF NOT EXISTS "${model.name}_idx" (\n${colDefs.join(',\n')},\n` +
      `  ${pk}\n) STRICT;`
    )

    // Indexes from @@index attrs
    for (const attr of indexAttrs) {
      const cols    = attr.fields.map(f => `"${f}"`).join(', ')
      const idxName = `idx_${model.name}_${attr.fields.join('_')}`
      _indexDb.run(`CREATE INDEX IF NOT EXISTS "${idxName}" ON "${model.name}_idx" (${cols});`)
    }

    return _indexDb
  }

  function insertIndexRecord(record, offset) {
    const db   = getIndexDb()
    const cols = [...indexedFieldNames, '_offset']
    const vals = [...indexedFieldNames.map(c => record[c] ?? null), offset]

    // With @id: INSERT OR REPLACE so re-indexing a known id updates its offset.
    // Without @id: plain INSERT — _offset is always unique (each line has its own position).
    const verb = idName ? 'INSERT OR REPLACE' : 'INSERT'
    db.prepare(
      `${verb} INTO "${model.name}_idx" (${cols.map(c => `"${c}"`).join(', ')}) ` +
      `VALUES (${cols.map(() => '?').join(', ')})`
    ).run(...vals)
  }

  // ── Index eligibility check ───────────────────────────────────────────────
  // Returns true if the where clause only touches indexed fields

  function canUseIndex(where) {
    if (!hasIndex || !where) return false
    const queryFields = extractWhereFields(where)
    const allIndexed  = new Set(indexedFieldNames)
    return queryFields.size > 0 && [...queryFields].every(f => allIndexed.has(f))
  }

  // ── Index query path ─────────────────────────────────────────────────────

  function queryViaIndex(args) {
    const db     = getIndexDb()
    const params = []
    const whereSQL = buildWhere(args.where, params)
    const where    = whereSQL ? `WHERE ${whereSQL}` : ''

    let orderSQL = ''
    if (args.orderBy) {
      const orders = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]
      const parts  = orders.flatMap(o => Object.entries(o).map(([k, v]) => `"${k}" ${v.toUpperCase()}`))
      orderSQL = `ORDER BY ${parts.join(', ')}`
    }

    const limitSQL  = args.limit  ? `LIMIT ${args.limit}`   : ''
    const offsetSQL = args.offset ? `OFFSET ${args.offset}` : ''

    const sql  = `SELECT "_offset" FROM "${model.name}_idx" ${where} ${orderSQL} ${limitSQL} ${offsetSQL}`.trim()
    const rows = db.prepare(sql).all(...params)

    return rows
      .map(row => readLineAtOffset(filePath, row._offset))
      .filter(Boolean)
  }

  // ── Full scan path ───────────────────────────────────────────────────────

  function queryFullScan(args) {
    let records = loadAll(filePath)
    if (args.where)   records = records.filter(r => matchWhere(r, args.where))
    if (args.orderBy) records = applyOrderBy(records, args.orderBy)
    if (args.offset)  records = records.slice(Number(args.offset))
    if (args.limit)   records = records.slice(0, Number(args.limit))
    return records
  }

  // ── Write helpers ────────────────────────────────────────────────────────

  function buildRecord(data) {
    const record = {}
    for (const field of storedFields) {
      if (data[field.name] !== undefined) {
        record[field.name] = data[field.name]
      } else {
        const def = resolveDefault(field)
        record[field.name] = def !== undefined ? def : null
      }
    }
    return record
  }

  function throwAppendOnly(op) {
    throw new Error(
      `db.${model.name}.${op}() — jsonl databases are append-only.\n` +
      `Only create() and createMany() are supported.\n` +
      `To query, use findMany() or findFirst().`
    )
  }

  // ── Public interface ─────────────────────────────────────────────────────

  async function findMany(args = {}) {
    if (canUseIndex(args.where)) return queryViaIndex(args)
    return queryFullScan(args)
  }

  async function findFirst(args = {}) {
    const results = await findMany({ ...args, limit: 1 })
    return results[0] ?? null
  }

  async function findUnique({ where } = {}) {
    return findFirst({ where })
  }

  async function findFirstOrThrow(args = {}) {
    const r = await findFirst(args)
    if (!r) throw new Error(`${model.name}: record not found`)
    return r
  }

  async function findUniqueOrThrow(args = {}) {
    return findFirstOrThrow(args)
  }

  async function count(args = {}) {
    // Fast path: no where clause → just count lines in file
    if (!args.where) {
      if (!existsSync(filePath)) return 0
      const content = readFileSync(filePath, 'utf8')
      return content.split('\n').filter(l => l.trim()).length
    }
    const records = await findMany(args)
    return records.length
  }

  async function create({ data }) {
    const record = buildRecord(data)
    const offset = appendRecord(filePath, record)
    if (hasIndex) insertIndexRecord(record, offset)
    return record
  }

  async function createMany({ data }) {
    return Promise.all(data.map(d => create({ data: d })))
  }

  return {
    findMany,
    findFirst,
    findUnique,
    findFirstOrThrow,
    findUniqueOrThrow,
    count,
    create,
    createMany,
    findManyCursor:   async (args) => {                  // wrap to match cursor result shape
      const rows = await findMany(args)
      return { items: rows, hasMore: false, nextCursor: null }
    },
    // Append-only — these all throw
    update:      () => throwAppendOnly('update'),
    updateMany:  () => throwAppendOnly('updateMany'),
    delete:      () => throwAppendOnly('delete'),
    deleteMany:  () => throwAppendOnly('deleteMany'),
    upsert:      () => throwAppendOnly('upsert'),
    upsertMany:  () => throwAppendOnly('upsertMany'),
    remove:      () => throwAppendOnly('remove'),
    removeMany:  () => throwAppendOnly('removeMany'),
    restore:     () => throwAppendOnly('restore'),
    optimizeFts: () => { throw new Error(`db.${model.name}.optimizeFts() — not supported on jsonl databases`) },
    search:      () => { throw new Error(`db.${model.name}.search() — FTS is not supported on jsonl databases`) },
    // Internal — called by $close
    _close() { if (_indexDb) { try { _indexDb.close() } catch {} ; _indexDb = null } },
  }
}
