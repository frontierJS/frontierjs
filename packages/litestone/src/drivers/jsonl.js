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
import { noteMintedDirectory } from '../core/db-path.js'
import { dirname }    from 'path'
import { applyBusyTimeout } from '../core/pragmas.js'
import { Database }   from 'bun:sqlite'
import { buildWhere } from '../core/query.js'
import { ID_GENERATORS } from '../core/ids.js'
import { compactJsonl } from '../tools/retention.js'
import { indexPathFor, indexShapeFor, openIndexDb, ensureIndexTable, withWriteLock }
  from './jsonl-index.js'

// ─── File I/O ─────────────────────────────────────────────────────────────────

// Read a single JSON line from an open fd at a given byte offset.
// Uses low-level fd seek — O(1), does not scan from the start.
// Takes an fd (not a path) so index queries open the file ONCE per query
// instead of once per result row.
function readLineAtFd(fd, offset) {
  const chunks = []
  const buf    = Buffer.allocUnsafe(2048)
  let   pos    = offset

  while (true) {
    const n  = readSync(fd, buf, 0, buf.length, pos)
    if (n === 0) break
    const nl = buf.indexOf(0x0a, 0)       // 0x0a = '\n'
    const end = (nl >= 0 && nl < n) ? nl : n
    chunks.push(buf.slice(0, end).toString('utf8'))
    if (nl >= 0 && nl < n) break
    pos += n
  }

  const line = chunks.join('').trim()
  return line ? JSON.parse(line) : null
}

// Parse JSONL text into records, appending into `out`.
function parseLinesInto(out, content) {
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch { /* skip malformed lines */ }
  }
  return out
}

// The file and its directory, made before anything opens either it or the index
// beside it. Its own function because the LOCK is opened first now — the index
// database lives in this directory too, and `new Database()` on a path whose
// directory does not exist is `SQLITE_CANTOPEN`, which arrives as *the audit
// write failed* rather than as *the directory is missing*.
function ensureFile(filePath) {
  if (existsSync(filePath)) return
  const dir = dirname(filePath)
  // Same signal as a minted SQLite directory: a jsonl/logger database whose
  // directory did not exist is a relative declared path resolved from one
  // directory away, and it is silent — an orphan `<surface>/db/audit/` sat in
  // this repo for two days under the `*.db*` ignore rule (`FJS-449`).
  const minted = !existsSync(dir)
  mkdirSync(dir, { recursive: true })
  if (minted) noteMintedDirectory(dir, filePath)
  appendFileSync(filePath, '', 'utf8')
}

// Append a JSON line to a file. Returns { offset, bytes }.
//
// **The offset is read and the line appended as one step, and the CALLER is what
// makes that true across processes.** `statSync(f).size` then `appendFileSync`
// is two syscalls, so a second process appending between them makes the returned
// offset name the OTHER writer's line — measured on the shipped code at 1,999 of
// 8,000, one in four, with no artificial delay. An indexed read then answers the
// wrong record with no error, which for an audit trail is the worst failure
// there is (`FJS-665`).
//
// Nothing here can close that window alone: where an O_APPEND write landed is
// not reported back, so the position is only knowable by holding a lock across
// the pair. The lock is the index database's write transaction
// (`jsonl-index.js`), taken by `create`/`createMany` — which is also where the
// index row is written, so the offset and the row naming it commit together.
function appendLine(filePath, line) {
  ensureFile(filePath)
  const offset = statSync(filePath).size
  appendFileSync(filePath, line, 'utf8')
  return { offset, bytes: Buffer.byteLength(line, 'utf8') }
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

// Keyed by the CURRENT dialect. These were `Integer`/`Real`/`Text` — the
// pre-rename names the parser now rejects outright — so every lookup missed and
// fell through to the `?? 'TEXT'` default below: an indexed `Int` column was
// created as TEXT in the index table, and numeric comparisons against it sorted
// lexicographically ('10' < '9'). Keep these keys in step with SCALARS.
// `Any` maps to SQLite's ANY, which STRICT tables support for exactly this
// case: a column whose values are identifiers of whatever type the host app
// uses. The audit log's `actorId` is one — an Int id in one app, a uuid String
// in another (which is what @frontierjs/auth issues) — and a STRICT INTEGER
// column threw `cannot store TEXT value in INTEGER column` on the first write
// with a known actor. See makeAuditModel() in core/client.js.
const FIELD_TYPES = { Int: 'INTEGER', Float: 'REAL', Boolean: 'INTEGER', DateTime: 'TEXT', String: 'TEXT', Json: 'TEXT', File: 'TEXT', Any: 'ANY' }

// ─── Default resolution ───────────────────────────────────────────────────────

function resolveDefault(field) {
  const def = field.attributes.find(a => a.kind === 'default')
  if (!def) return undefined
  const v = def.value
  if (v.kind === 'call'    && v.fn === 'now')  return new Date().toISOString()
  // A jsonl table has no DDL, so every generated default is filled here — where
  // a SQLite table gets uuid() from its column DEFAULT and the other three from
  // the client's insert path (core/ids.js is the shared owner).
  if (v.kind === 'call'    && ID_GENERATORS[v.fn]) return ID_GENERATORS[v.fn]()
  if (v.kind === 'string')  return v.value
  if (v.kind === 'number')  return v.value
  if (v.kind === 'boolean') return v.value
  if (v.kind === 'enum')    return v.value
  return undefined
}

// ─── Table factory ────────────────────────────────────────────────────────────

export function makeJsonlTable(filePath, model, schema, retention = null, maxSize = null, now = Date.now, busyTimeout = null) {
  // Run compaction immediately if retention or maxSize is configured.
  // This happens once when createClient() opens — before any queries are served.
  if (retention || maxSize) {
    try { compactJsonl(filePath, model, retention, maxSize, now) } catch { /* non-fatal */ }
  }

  // Fields that get stored in the JSONL file (no relation/computed)
  const storedFields = model.fields.filter(f =>
    f.type.kind !== 'relation' &&
    !f.attributes.some(a => a.kind === 'computed' || a.kind === 'transient')
  )

  // @id field name — optional for JSONL models (audit logs, event streams don't need one)
  const idField = model.fields.find(f => f.attributes.some(a => a.kind === 'id'))
  const idName  = idField?.name ?? null   // null = no @id declared

  // @@index attributes and the set of indexed field names.
  // When @id is present it's included so the index can do INSERT OR REPLACE (upsert by id).
  // When @id is absent (e.g. audit log), indexed fields come purely from @@index attrs —
  // _offset is the primary key in that case since every appended line has a unique offset.
  // The index's shape is `jsonl-index.js`'s, because compaction rewrites every
  // row of it and the two may not disagree about what a row is.
  const shape = indexShapeFor(model)
  const { indexAttrs, hasIndex, indexedFieldNames } = shape

  // ── Companion index.db ────────────────────────────────────────────────────

  let _indexDb = null

  // The index file, and whether the handle we hold still points at it.
  //
  // A retention compaction REWRITES the .jsonl, which moves every byte offset
  // the index holds, so `compactJsonl` deletes the file and says the index is
  // "rebuilt lazily". Nothing rebuilt it: SQLite notices its file has been
  // unlinked under an open connection and marks that connection readonly, so
  // the next append answered `SQLITE_READONLY_DBMOVED: attempt to write a
  // readonly database` from inside `insertIndexRecord` — an uncaught throw on
  // the audit path, which is fire-and-forget, so the REQUEST answered 201 and
  // the process died a tick later.
  //
  // Live rather than hypothetical, and on a clock: the sweep only removes
  // something once the oldest row is past the declared window, so a deployment
  // crashes on the first night after its retention period elapses and looks
  // like a nightly fault with nothing in the request log. Measured on
  // `example` — `POST /api/discounts` 201, then the API gone (`FJS-540`).
  //
  // One `existsSync` per index operation is what the lazy rebuild costs. It is
  // a syscall against a path the OS has cached, on a driver that already
  // appends to a file for every write, and the alternative is a process that
  // dies.
  const indexPath = indexPathFor(filePath)

  function getIndexDb() {
    if (_indexDb && existsSync(indexPath)) return _indexDb
    if (_indexDb) {
      // Gone from under us. Close the dead handle before opening the new one:
      // left open it holds the unlinked inode for the life of the process.
      try { _indexDb.close() } catch { /* already dead — the reopen is the point */ }
      _indexDb = null
    }
    _indexDb = openIndexDb(indexPath, busyTimeout)
    ensureIndexTable(_indexDb, model, shape, filePath)
    return _indexDb
  }

  /** Run this holding the file's write lock. See `jsonl-index.js`. */
  function locked(fn) { return withWriteLock(getIndexDb(), fn) }

  function insertIndexRecord(record, offset) {
    const db   = getIndexDb()
    const cols = [...indexedFieldNames, '_offset']
    const vals = [...indexedFieldNames.map(c => record[c] ?? null), offset]

    // INSERT OR REPLACE either way. With `@id` it updates a known id's offset;
    // without one, `_offset` is the primary key and a plain INSERT throws the
    // moment anything writes a line at a position the index already holds.
    //
    // That is not hypothetical and it is not a race inside one client: a jsonl
    // or logger database is schema-GLOBAL under `tenancy { strategy database }`,
    // so every tenant's client writes the audit trail through its own driver
    // instance over one file, and the first second shop to be opened crashed the
    // app with `UNIQUE constraint failed: auditLogs_idx._offset` — from inside
    // an audit write, about a table nobody named. `rebuildIndex` in `jsonl-index.js` has
    // always used OR REPLACE for the same reason.
    const verb = 'INSERT OR REPLACE'
    // db.query() caches the compiled statement (db.prepare compiles fresh every call)
    db.query(
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
    const rows = db.query(sql).all(...params)
    if (!rows.length) return []

    // One fd for the whole result set — previously each row opened and closed
    // its own file descriptor.
    const fd = openSync(filePath, 'r')
    try {
      return rows
        .map(row => readLineAtFd(fd, row._offset))
        .filter(Boolean)
    } finally {
      closeSync(fd)
    }
  }

  // ── Full scan path ───────────────────────────────────────────────────────
  //
  // Parsed-record cache. The file is append-only, so the cache is valid as
  // long as the file has only GROWN since the last load — in that case only
  // the appended byte range is read and parsed. A shrunk or same-size-but-
  // rewritten file (retention compaction) triggers a full reload.
  //
  // Previously every findMany/findFirst/count re-read and re-JSON.parsed the
  // ENTIRE file (~273ms per query on a 200k-row file, growing forever).
  // Cached records are internal — query results return the same row objects
  // only through filter/slice, so writes push CLONES into the cache to keep
  // caller mutations from leaking in.

  let _cache = null   // { size, mtimeMs, records }

  function loadAllCached() {
    if (!existsSync(filePath)) { _cache = null; return [] }
    const st = statSync(filePath)

    if (_cache && st.size === _cache.size && st.mtimeMs === _cache.mtimeMs) {
      return _cache.records
    }

    if (_cache && st.size > _cache.size) {
      // Append-only growth — read and parse just the tail.
      const fd = openSync(filePath, 'r')
      try {
        const len = st.size - _cache.size
        const buf = Buffer.allocUnsafe(len)
        let read = 0
        while (read < len) {
          const n = readSync(fd, buf, read, len - read, _cache.size + read)
          if (n === 0) break
          read += n
        }
        parseLinesInto(_cache.records, buf.slice(0, read).toString('utf8'))
        _cache.size    = st.size
        _cache.mtimeMs = st.mtimeMs
        return _cache.records
      } finally {
        closeSync(fd)
      }
    }

    // Cold load, shrink, or same-size rewrite — full parse.
    const records = parseLinesInto([], readFileSync(filePath, 'utf8'))
    _cache = { size: st.size, mtimeMs: st.mtimeMs, records }
    return records
  }

  function queryFullScan(args) {
    let records = loadAllCached()
    if (args.where)   records = records.filter(r => matchWhere(r, args.where))
    if (args.orderBy) records = applyOrderBy(records, args.orderBy)
    if (args.offset)  records = records.slice(Number(args.offset))
    if (args.limit)   records = records.slice(0, Number(args.limit))
    // Clone the returned rows — callers may mutate them, and the underlying
    // objects live in the cache. (Pre-cache behavior returned fresh objects
    // every query; this preserves that contract.)
    return records.map(r => ({ ...r }))
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
    // Fast path: no where clause → cached record count (no full-file string
    // decode; refreshes incrementally via the append-only tail parse)
    if (!args.where) {
      return loadAllCached().length
    }
    if (canUseIndex(args.where)) {
      const db     = getIndexDb()
      const params = []
      const whereSQL = buildWhere(args.where, params)
      const where    = whereSQL ? `WHERE ${whereSQL}` : ''
      return db.query(`SELECT COUNT(*) AS n FROM "${model.name}_idx" ${where}`).get(...params).n
    }
    return loadAllCached().filter(r => matchWhere(r, args.where)).length
  }

  // Push a freshly-written record into the warm cache (clone — the caller
  // owns the returned object) so the next read doesn't re-parse the tail.
  function absorbIntoCache(record, offset, bytes) {
    if (_cache && _cache.size === offset) {
      _cache.records.push({ ...record })
      _cache.size = offset + bytes
      try { _cache.mtimeMs = statSync(filePath).mtimeMs } catch { _cache = null }
    }
  }

  async function create({ data }) {
    const record = buildRecord(data)
    // Where the line lands is only knowable while holding the lock, and the
    // index row naming that offset is written under the same one, so the two
    // commit together or not at all (`FJS-665`). Unindexed there is no offset
    // and nothing to guard.
    ensureFile(filePath)                       // before the lock — the index lives here too
    const write = () => {
      const { offset, bytes } = appendLine(filePath, JSON.stringify(record) + '\n')
      absorbIntoCache(record, offset, bytes)
      if (hasIndex) insertIndexRecord(record, offset)
    }
    if (hasIndex) locked(write); else write()
    return record
  }

  async function createMany({ data, announce } = {}) {
    // A jsonl table announces nothing at all — there is no emitter down here and
    // no RETURNING to build rows from. `collection` and `none` are both
    // truthfully answered by silence; `rows` is a caller expecting per-row
    // announcements they will never receive, so it is refused BY NAME rather
    // than accepted and ignored (FJS-D34).
    if (announce === 'rows') {
      const err = new Error(
        `db.${model.name}.createMany({ announce: 'rows' }) — this model lives in a jsonl ` +
        `database, which is append-only and has no RETURNING, so no row can be announced. ` +
        `Use announce: 'collection' or 'none'.`)
      err.name      = 'CapabilityNotDeclaredError'
      err.status    = 400
      err.retryable = false
      throw err
    }
    if (!data?.length) return []
    // Serialize the whole batch into ONE buffer + ONE append, and wrap index
    // inserts in ONE transaction — previously this was N fd open/write/close
    // cycles and N implicit index-db commits.
    const records = data.map(d => buildRecord(d))
    const lines   = records.map(r => JSON.stringify(r) + '\n')

    // One lock for the batch, and it IS the transaction the index rows were
    // already written in — `withWriteLock` replaced that BEGIN/COMMIT — so the
    // batch costs the same lock it always did and gains a correct offset.
    ensureFile(filePath)                       // before the lock — the index lives here too
    const write = () => {
      const { offset } = appendLine(filePath, lines.join(''))
      let pos = offset
      const offsets = lines.map(l => { const o = pos; pos += Buffer.byteLength(l, 'utf8'); return o })
      if (_cache && _cache.size === offset) {
        for (const r of records) _cache.records.push({ ...r })
        _cache.size = pos
        try { _cache.mtimeMs = statSync(filePath).mtimeMs } catch { _cache = null }
      }
      if (hasIndex) for (let i = 0; i < records.length; i++) insertIndexRecord(records[i], offsets[i])
    }
    if (hasIndex) locked(write); else write()
    return records
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
