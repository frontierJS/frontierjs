// client.js — Litestone query client
//
// Key design decisions:
//   Dual connections:  readDb (readonly) + writeDb — WAL mode allows concurrent reads
//   Soft delete:       models with deletedAt field get auto-filtering + soft ops
//   Statement cache:   compiled statements reused across calls via wrapDb()

import { Database }     from 'bun:sqlite'
import { resolve, join, dirname, extname } from 'path'
import { tmpdir } from 'os'
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'fs'
import { parse, parseFile } from './parser.js'
import { isSoftDelete, isSoftDeleteCascade, modelToTableName, modelToAccessor } from './ddl.js'
import { detectM2MPairs } from './ddl.js'
import {
  buildWhere, buildOrderBy, buildRelationOrderBy,
  buildWindowCols,
  isRawClause, sql,
  isNamedAgg, buildNamedAggExpr, extractNamedAggs,
  parseSelectArg, trimAllToSelect,
  deserializeRow, serializeRow,
  coerceBooleans, serializeBooleans,
  encodeCursor, decodeCursor,
  normaliseOrderBy, buildCursorWhere, extractCursorValues,
} from './query.js'
import { validate, applyTransforms, buildValidationMap, ValidationError } from './validate.js'
import { PluginRunner, AccessDeniedError } from './plugin.js'
import { buildPolicyMap, buildPolicyFilter, checkCreatePolicy, checkPostUpdatePolicy, evalJs } from './policy.js'
import { makeJsonlTable } from '../drivers/jsonl.js'
import { runSqliteRetention } from '../tools/retention.js'
export { ValidationError } from './validate.js'

// ─── Transition error types ──────────────────────────────────────────────────

export class TransitionViolationError extends Error {
  constructor(model, field, from, to, allowed) {
    super(`Cannot transition ${model}.${field} from '${from}' to '${to}' — valid transitions from '${from}': ${allowed.length ? allowed.map(a => `'${a}'`).join(', ') : 'none'}`)
    this.name       = 'TransitionViolationError'
    this.model      = model
    this.field      = field
    this.from       = from
    this.to         = to
    this.retryable  = false
  }
}

export class TransitionConflictError extends Error {
  constructor(model, field, expected, to) {
    super(`Transition conflict on ${model}.${field}: row was modified before update could complete (expected '${expected}', transition to '${to}')`)
    this.name      = 'TransitionConflictError'
    this.model     = model
    this.field     = field
    this.expected  = expected
    this.to        = to
    this.retryable = true
  }
}

export class TransitionNotFoundError extends Error {
  constructor(model, transitionName, available) {
    super(`Transition '${transitionName}' not found on ${model} — available: ${available.length ? available.map(t => `'${t}'`).join(', ') : 'none'}`)
    this.name           = 'TransitionNotFoundError'
    this.model          = model
    this.transition     = transitionName
    this.retryable      = false
  }
}

// ─── Lock error types ────────────────────────────────────────────────────────

export class LockNotAcquiredError extends Error {
  constructor(key, currentOwner, expiresAt) {
    super(`Lock '${key}' is held by another owner and could not be acquired${currentOwner ? ` (held by: ${currentOwner})` : ''}`)
    this.name         = 'LockNotAcquiredError'
    this.key          = key
    this.currentOwner = currentOwner ?? null
    this.expiresAt    = expiresAt ?? null
    this.retryable    = true
  }
}

export class LockReleasedByOtherError extends Error {
  constructor(key, owner) {
    super(`Lock '${key}' was released or expired by another owner before explicit release`)
    this.name     = 'LockReleasedByOtherError'
    this.key      = key
    this.owner    = owner
    this.retryable = false
  }
}

export class LockExpiredError extends Error {
  constructor(key, owner) {
    super(`Lock '${key}' expired (TTL elapsed) before explicit release — increase TTL or add heartbeat`)
    this.name      = 'LockExpiredError'
    this.key       = key
    this.owner     = owner
    this.retryable = false
  }
}

// ─── Statement cache ──────────────────────────────────────────────────────────
// Wraps a Database with a prepared statement cache.
// query() and prepare() compile once and reuse — zero recompilation on hot paths.
// run() stays uncached — used only for transactions/pragmas (called rarely).

function wrapDb(rawDb, { maxCacheSize = 500 } = {}) {
  // Map preserves insertion order, so delete+set on hit moves an entry to "most
  // recently used", and the first key is always the oldest. When we hit the cap,
  // evict the oldest. 500 prepared stmts is a generous default — covers a
  // reasonably complex schema's full hot set without unbounded growth in
  // long-lived processes that build many distinct WHERE shapes.
  const cache = new Map()
  // Statements that must NOT be cached — they carry session state and
  // Bun/SQLite will throw on reuse across transaction boundaries.
  const NO_CACHE = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|VACUUM|ATTACH|DETACH)/i
  function stmt(sql) {
    let s = cache.get(sql)
    if (s) {
      // LRU: move to end on hit. Cheap — Map.delete + Map.set is O(1).
      cache.delete(sql)
      cache.set(sql, s)
      return s
    }
    s = rawDb.prepare(sql)
    cache.set(sql, s)
    if (cache.size > maxCacheSize) {
      // Evict oldest (first inserted)
      const oldest = cache.keys().next().value
      const evicted = cache.get(oldest)
      cache.delete(oldest)
      // Best-effort finalize — Bun stmts don't strictly require it, but it
      // releases native handles sooner and avoids GC pressure under churn.
      try { evicted?.finalize?.() } catch {}
    }
    return s
  }
  return {
    query(sql)          { return stmt(sql) },
    prepare(sql)        { return stmt(sql) },
    // run() now caches UPDATE/DELETE/INSERT — only pragmas/transactions bypass
    run(sql, ...params) {
      if (NO_CACHE.test(sql)) return rawDb.prepare(sql).run(...params)
      return stmt(sql).run(...params)
    },
    $raw: rawDb,
    get cacheSize()     { return cache.size },
  }
}

// ─── Schema analysis ──────────────────────────────────────────────────────────


// ─── Auto-ID map ──────────────────────────────────────────────────────────────
// Detects @id fields with @default(uuid()), @default(ulid()), @default(cuid()).
// When the id field is missing from create data, the client generates it.
//
// uuid()  — crypto.randomUUID() — RFC 4122 v4, available in Bun + Node 16+
// ulid()  — Universally Unique Lexicographically Sortable Identifier
//           26-char base32, millisecond-precision timestamp prefix.
//           Pure JS implementation — no dependencies.
// cuid()  — collision-resistant IDs. We use cuid2-style (c + random base36).
//           For production use, replace with the 'cuid2' npm package.


// ── ULID implementation (spec-compliant, no deps) ─────────────────────────────
const ULID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function generateUlid() {
  const now   = Date.now()
  let ts = ''
  let t  = now
  for (let i = 9; i >= 0; i--) { ts = ULID_CHARS[t % 32] + ts; t = Math.floor(t / 32) }
  let rand = ''
  const bytes = randomBytes(10)
  // Encode 80 bits of randomness into 16 base32 chars
  let acc = 0, bits = 0
  for (const byte of bytes) {
    acc  = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      rand += ULID_CHARS[(acc >> bits) & 31]
    }
  }
  return ts + rand
}

// ── cuid2-style fallback (use 'cuid2' npm package for production) ─────────────
function generateCuid() {
  const bytes = randomBytes(16)
  return 'c' + bytes.toString('base64url').replace(/[^a-z0-9]/g, '').slice(0, 24)
}

// ── nanoid (URL-safe, default 21 chars, optional custom alphabet) ─────────────
function generateNanoid(size = 21, alphabet = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict') {
  const bytes = randomBytes(size)
  let id = ''
  for (let i = 0; i < size; i++) {
    id += alphabet[bytes[i] & (alphabet.length - 1 > 255 ? 255 : alphabet.length - 1)]
  }
  return id
}

const ID_GENERATORS = {
  uuid:   () => crypto.randomUUID(),
  ulid:   generateUlid,
  cuid:   generateCuid,
  nanoid: generateNanoid,
}

function buildAutoIdMap(schema) {
  const map = {}
  for (const model of schema.models) {
    for (const field of model.fields) {
      const isId  = field.attributes.find(a => a.kind === 'id')
      const def   = field.attributes.find(a => a.kind === 'default')
      if (!isId || !def || def.value?.kind !== 'call') continue
      const fn = def.value.fn
      if (ID_GENERATORS[fn]) {
        map[model.name] = { field: field.name, generate: ID_GENERATORS[fn] }
      }
    }
  }
  return map
}

// ─── Auth default map ────────────────────────────────────────────────────────
// { modelName: [{ field, authField }] }
// For fields with @default(auth().someField) — value stamped from ctx.auth at create time.
// These are runtime-only; no SQL DEFAULT expression is emitted in DDL.

function buildAuthDefaultMap(schema) {
  const map = {}
  for (const model of schema.models) {
    for (const field of model.fields) {
      const def = field.attributes.find(a => a.kind === 'default')
      if (def?.value?.kind !== 'call' || def.value.fn !== 'auth') continue
      if (!map[model.name]) map[model.name] = []
      map[model.name].push({ field: field.name, authField: def.value.field })
    }
  }
  return map
}

// ─── Self-relation map ────────────────────────────────────────────────────────
// { modelName: [{ relationField, fkField, referencedField }] }
// Detects self-referential relations for recursive CTE queries.
// e.g. categories.children → parentId → id

function buildSelfRelationMap(schema) {
  const map = {}
  for (const model of schema.models) {
    const selfRels = []
    for (const field of model.fields) {
      if (field.type.kind !== 'relation') continue
      if (field.type.name !== model.name) continue
      const rel = field.attributes.find(a => a.kind === 'relation' && a.fields)
      if (!rel) continue  // hasMany side — skip, we want the belongsTo (FK) side
      selfRels.push({
        relationField:   field.name,
        fkField:         Array.isArray(rel.fields)     ? rel.fields[0]     : rel.fields,
        referencedField: Array.isArray(rel.references) ? rel.references[0] : rel.references,
      })
    }
    if (selfRels.length) map[model.name] = selfRels
  }
  return map
}

// ─── @default(fieldName) — field reference defaults ──────────────────────────
// { modelName: [{ field, sourceField }] }
// On create, if `field` is absent from data, copy value from `sourceField`.
// Applied BEFORE @slug and other transforms so @default(title) @slug works.

function buildFieldRefDefaultMap(schema) {
  const map = {}
  for (const model of schema.models) {
    const fieldNames = new Set(model.fields.map(f => f.name))
    for (const field of model.fields) {
      const def = field.attributes.find(a => a.kind === 'default')
      if (def?.value?.kind !== 'fieldRef') continue
      const sourceField = def.value.field
      if (!fieldNames.has(sourceField)) continue
      if (!map[model.name]) map[model.name] = []
      map[model.name].push({ field: field.name, sourceField })
    }
  }
  return map
}

// ─── @updatedBy map ───────────────────────────────────────────────────────────
// { modelName: [{ field, authField }] }
// @updatedBy          → stamps ctx.auth.id on every update
// @updatedBy(auth().field) → stamps ctx.auth[field] on every update
// Skipped silently if ctx.auth is null.

function buildUpdatedByMap(schema) {
  const map = {}
  for (const model of schema.models) {
    for (const field of model.fields) {
      const attr = field.attributes.find(a => a.kind === 'updatedBy')
      if (!attr) continue
      if (!map[model.name]) map[model.name] = []
      map[model.name].push({ field: field.name, authField: attr.authField ?? 'id' })
    }
  }
  return map
}
// { modelName: [{ field, scope }] }
// field: the field that gets the auto-incremented value
// scope: the field whose value defines the partition (e.g. accountId)
//
// Example: quoteNumber @sequence(scope: accountId)
//   → { quotes: [{ field: 'quoteNumber', scope: 'accountId' }] }

function buildSequenceMap(schema) {
  const map = {}
  for (const model of schema.models) {
    const seqs = []
    for (const field of model.fields) {
      const attr = field.attributes.find(a => a.kind === 'sequence')
      if (attr) seqs.push({ field: field.name, scope: attr.scope })
    }
    if (seqs.length) map[model.name] = seqs
  }
  return map
}

// ─── Sequence counter table ───────────────────────────────────────────────────
// Created once at client init. One row per (model, field, scope value).
// Uses a single atomic upsert — safe under SQLite's single-writer guarantee.

const SEQUENCE_TABLE = '_litestone_sequences'

function ensureSequenceTable(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS "${SEQUENCE_TABLE}" (
      model   TEXT    NOT NULL,
      field   TEXT    NOT NULL,
      scope   TEXT    NOT NULL,
      lastNum INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (model, field, scope)
    )
  `)
}

function nextSequenceValue(db, model, field, scopeValue) {
  // Atomic increment — SQLite serialises all writes so this is race-free
  db.run(
    `INSERT INTO "${SEQUENCE_TABLE}" (model, field, scope, lastNum)
     VALUES (?, ?, ?, 1)
     ON CONFLICT (model, field, scope)
     DO UPDATE SET lastNum = lastNum + 1`,
    model, field, String(scopeValue)
  )
  const row = db.query(
    `SELECT lastNum FROM "${SEQUENCE_TABLE}" WHERE model = ? AND field = ? AND scope = ?`
  ).get(model, field, String(scopeValue))
  return row.lastNum
}

// Apply @sequence fields to a single data row before INSERT.
// Only fires if the field is absent — explicit values are respected but still
// bump the counter so the sequence stays monotonic.
//
// `modelName` is the PascalCase schema name (e.g. "User") — used both to look up
// the sequences defined on that model AND as the key stored in _litestone_sequences.
// Keeping these consistent matters because the counter is scoped by (model, field, scope).
function applySequences(data, modelName, sequenceMap, writeDb) {
  const seqs = sequenceMap?.[modelName]
  if (!seqs?.length || !data) return data
  let out = data
  for (const { field, scope } of seqs) {
    const scopeValue = out[scope]
    if (scopeValue == null) continue  // can't sequence without a scope value
    const explicitValue = out[field] != null ? Number(out[field]) : null
    if (explicitValue != null) {
      // Explicit value: sync the counter to max(current, explicit) so next auto continues from here
      writeDb.run(
        `INSERT INTO "${SEQUENCE_TABLE}" (model, field, scope, lastNum)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (model, field, scope)
         DO UPDATE SET lastNum = MAX(lastNum, excluded.lastNum)`,
        modelName, field, String(scopeValue), explicitValue
      )
    } else {
      // Auto: bump and use the new counter value
      const next = nextSequenceValue(writeDb, modelName, field, scopeValue)
      if (out === data) out = { ...data }
      out[field] = next
    }
  }
  return out
}


import { createCipheriv, createDecipheriv, randomBytes, createHmac } from 'crypto'

// ─── Encryption ───────────────────────────────────────────────────────────────
// Two modes:
//   Standard (@encrypted)              — AES-256-GCM, random IV, non-deterministic
//   Searchable (@encrypted(searchable)) — HMAC-SHA256, deterministic, queryable
//
// Ciphertext format (base64url):
//   standard:   v1.<base64url(iv + tag + ciphertext)>
//   searchable: v1s.<base64url(hmac)>

const ENC_PREFIX      = 'v1.'
const ENC_S_PREFIX    = 'v1s.'
const GCM_IV_LEN      = 12
const GCM_TAG_LEN     = 16
const HMAC_ALG        = 'sha256'

function encryptField(plaintext, key) {
  if (plaintext == null) return plaintext
  const iv         = randomBytes(GCM_IV_LEN)
  const cipher     = createCipheriv('aes-256-gcm', key, iv)
  const encrypted  = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag        = cipher.getAuthTag()
  const payload    = Buffer.concat([iv, tag, encrypted])
  return ENC_PREFIX + payload.toString('base64url')
}

function decryptField(ciphertext, key) {
  if (ciphertext == null) return ciphertext
  if (!String(ciphertext).startsWith(ENC_PREFIX)) return ciphertext  // not encrypted
  const payload    = Buffer.from(String(ciphertext).slice(ENC_PREFIX.length), 'base64url')
  const iv         = payload.subarray(0, GCM_IV_LEN)
  const tag        = payload.subarray(GCM_IV_LEN, GCM_IV_LEN + GCM_TAG_LEN)
  const encrypted  = payload.subarray(GCM_IV_LEN + GCM_TAG_LEN)
  const decipher   = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(encrypted) + decipher.final('utf8')
}

function encryptSearchable(plaintext, key) {
  if (plaintext == null) return plaintext
  const hmac = createHmac(HMAC_ALG, key).update(String(plaintext)).digest('base64url')
  return ENC_S_PREFIX + hmac
}

function isCiphertext(value) {
  const s = String(value ?? '')
  return s.startsWith(ENC_PREFIX) || s.startsWith(ENC_S_PREFIX)
}

// Normalise key: hex string, Buffer, or Uint8Array → 32-byte Buffer
function normaliseKey(raw) {
  if (!raw || (typeof raw === 'string' && !raw.trim())) return null
  if (typeof raw === 'string') return Buffer.from(raw, 'hex')
  return Buffer.from(raw)
}

// ─── Field policy map ─────────────────────────────────────────────────────────
// Per model, per field:
//   omit:      'lists' | 'all' | null
//   guarded:   'select' | 'all' | null
//   encrypted: { searchable: bool } | null
//
// @encrypted implies guarded: 'all'

function buildFieldPolicyMap(schema) {
  const map = {}
  for (const model of schema.models) {
    map[model.name] = {}
    for (const field of model.fields) {
      const omitAttr      = field.attributes.find(a => a.kind === 'omit')
      const guardedAttr   = field.attributes.find(a => a.kind === 'guarded')
      const encryptedAttr = field.attributes.find(a => a.kind === 'encrypted')
      const fieldAllows   = field.attributes.filter(a => a.kind === 'fieldAllow')

      if (!omitAttr && !guardedAttr && !encryptedAttr && !fieldAllows.length) continue

      // Build per-op allow expression lists: { read: [expr,...], write: [expr,...] }
      const allow = fieldAllows.length ? { read: [], write: [] } : null
      for (const fa of fieldAllows) {
        if (fa.operations.includes('read'))  allow.read.push(fa.expr)
        if (fa.operations.includes('write')) allow.write.push(fa.expr)
      }

      map[model.name][field.name] = {
        omit:      omitAttr?.level    ?? null,
        guarded:   encryptedAttr      ? 'all'
                   : guardedAttr?.level ?? null,
        encrypted: encryptedAttr ? { searchable: encryptedAttr.searchable ?? false } : null,
        allow,    // null if no @allow on this field
      }
    }
  }
  return map
}

// ─── Secret map ───────────────────────────────────────────────────────────────
// Tracks @secret fields for key rotation.  Only fields with rotate:true
// are re-encrypted when db.$rotateKey(newKey) is called.

function buildSecretMap(schema) {
  const map = {}
  for (const model of schema.models) {
    for (const field of model.fields) {
      const secretAttr = field.attributes.find(a => a.kind === 'secret')
      if (!secretAttr) continue
      if (!map[model.name]) map[model.name] = {}
      map[model.name][field.name] = { rotate: secretAttr.rotate !== false }
    }
  }
  return map
}

function buildJsonMap(schema) {  const map = {}
  for (const model of schema.models) {
    map[model.name] = new Set(
      // Include Json fields AND array fields — both stored as JSON text
      model.fields.filter(f => f.type.name === 'Json' || f.type.array).map(f => f.name)
    )
  }
  return map
}

function buildGeneratedMap(schema) {
  const map = {}
  for (const model of schema.models) {
    map[model.name] = new Set(
      model.fields
        .filter(f => f.attributes.find(a => a.kind === 'generated' || a.kind === 'funcCall'))
        .map(f => f.name)
    )
  }
  return map
}

// ─── @from map ───────────────────────────────────────────────────────────────
// { modelName: { fieldName: { subquerySql, isObject } } }
// subquerySql: the correlated subquery string to inject into SELECT
// isObject: true for last/first (returns JSON-encoded row), false for scalars
//
// FK inference: finds the field on the target model whose type is this model
// and has @relation(fields: [...]) — that's the FK field pointing back.

function buildFromMap(schema, pluralize = false) {
  const map = {}
  for (const model of schema.models) {
    const fromFields = model.fields.filter(f => f.attributes.find(a => a.kind === 'from'))
    if (!fromFields.length) continue
    map[model.name] = {}

    // Outer table — model.name is PascalCase, SQL uses the derived table name.
    const selfTable = modelToTableName(model, pluralize)

    for (const field of fromFields) {
      const attr = field.attributes.find(a => a.kind === 'from')
      const { target, op, opValue, where, orderBy } = attr

      const targetModel = schema.models.find(m => m.name === target)
      if (!targetModel) continue
      const targetTable = modelToTableName(targetModel, pluralize)

      // Infer FK: find field on targetModel with @relation pointing back to model
      const fkField = targetModel.fields.find(f => {
        const rel = f.attributes.find(a => a.kind === 'relation' && a.fields)
        if (!rel) return false
        return f.type.name === model.name
      })

      // FK column name on the target table
      let fkCol = null
      if (fkField) {
        const rel = fkField.attributes.find(a => a.kind === 'relation')
        fkCol = Array.isArray(rel.fields) ? rel.fields[0] : rel.fields
      } else {
        // Fallback: look for a field named <modelName>Id
        const fallback = targetModel.fields.find(f => f.name === `${model.name}Id`)
        if (fallback) fkCol = fallback.name
      }

      if (!fkCol) continue  // can't infer FK — skip (validation catches this)

      const idField = model.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
      const whereParts = [`"${fkCol}" = "${selfTable}"."${idField}"`]
      if (where) whereParts.push(`(${where})`)
      const whereClause = whereParts.join(' AND ')

      let subquerySql, isObject = false

      switch (op) {
        case 'last':
        case 'first': {
          isObject = true
          const orderField = orderBy ?? idField
          const dir = op === 'last' ? 'DESC' : 'ASC'
          // Build json_object(...) from all scalar fields of target model
          const scalarFields = targetModel.fields.filter(f =>
            f.type.kind !== 'relation' &&
            !f.attributes.some(a => a.kind === 'computed' || a.kind === 'from' || a.kind === 'generated' || a.kind === 'funcCall')
          )
          const jsonArgs = scalarFields.map(f => `'${f.name}', "${f.name}"`).join(', ')
          subquerySql = `(SELECT json_object(${jsonArgs}) FROM "${targetTable}" WHERE ${whereClause} ORDER BY "${orderField}" ${dir} LIMIT 1)`
          break
        }
        case 'count':
          subquerySql = `(SELECT COUNT(*) FROM "${targetTable}" WHERE ${whereClause})`
          break
        case 'sum':
          subquerySql = `(SELECT COALESCE(SUM("${opValue}"), 0) FROM "${targetTable}" WHERE ${whereClause})`
          break
        case 'max':
          subquerySql = `(SELECT MAX("${opValue}") FROM "${targetTable}" WHERE ${whereClause})`
          break
        case 'min':
          subquerySql = `(SELECT MIN("${opValue}") FROM "${targetTable}" WHERE ${whereClause})`
          break
        case 'exists':
          subquerySql = `(SELECT EXISTS(SELECT 1 FROM "${targetTable}" WHERE ${whereClause}))`
          break
      }

      map[model.name][field.name] = { subquerySql, isObject, isBool: op === 'exists' }
    }
  }
  return map
}

function buildComputedSet(schema) {
  const map = {}
  for (const model of schema.models) {
    map[model.name] = new Set(
      model.fields.filter(f => f.attributes.find(a => a.kind === 'computed')).map(f => f.name)
    )
  }
  return map
}


function buildBoolMap(schema) {
  const map = {}
  for (const model of schema.models) {
    map[model.name] = new Set(
      model.fields.filter(f => f.type.name === 'Boolean').map(f => f.name)
    )
  }
  return map
}


// ─── Enum map ─────────────────────────────────────────────────────────────────
// { modelName: { fieldName: Set<string> } }
// Used for friendly validation before writes hit SQLite's CHECK constraint.

// ─── Transition map ───────────────────────────────────────────────────────────
// { modelName: { fieldName: { enumName, transitions: { name: { from, to } } } } }
// Only populated for fields whose enum has a transitions block.

function buildTransitionMap(schema) {
  const enumTransitions = {}
  for (const e of schema.enums) {
    if (e.transitions) enumTransitions[e.name] = e.transitions
  }
  const map = {}
  for (const model of schema.models) {
    for (const field of model.fields) {
      if (field.type.kind !== 'scalar' && field.type.kind !== 'enum') continue
      const enumName = field.type.name
      if (!enumTransitions[enumName]) continue
      if (!map[model.name]) map[model.name] = {}
      map[model.name][field.name] = { enumName, transitions: enumTransitions[enumName] }
    }
  }
  return map
}

function buildEnumMap(schema) {
  const enumValues = {}
  for (const e of schema.enums) {
    enumValues[e.name] = new Set(e.values.map(v => v.name))
  }
  const map = {}
  for (const model of schema.models) {
    map[model.name] = {}
    for (const field of model.fields) {
      if (field.type.kind === 'enum' && enumValues[field.type.name]) {
        map[model.name][field.name] = {
          values:   enumValues[field.type.name],
          enumName: field.type.name,
          optional: field.type.optional,
        }
      }
    }
  }
  return map
}


// ─── Soft delete cascade map ──────────────────────────────────────────────────
// { modelName: boolean } — true if @@softDeleteCascade is set on the model

function buildSoftDeleteCascadeMap(schema) {
  const map = {}
  for (const model of schema.models) {
    map[model.name] = !!model.attributes.find(a => a.kind === 'softDelete' && a.cascade)
  }
  return map
}

// Walk the hasMany edges of the relationMap to collect all child tables
// that also have soft delete. Returns an array of
// { childModel, childTable, parentModel, parentTable, foreignKey, referencedKey, hardDelete }
// in BFS order.
//
// relationMap is keyed by PascalCase model name (e.g. "User"), and rel.targetModel
// is also PascalCase, so the BFS traverses model names. SQL table names are derived
// on the way out via modelToTable, which converts the PascalCase model to its
// snake_case (or plural) SQL name.
function getCascadeTargets(modelName, relationMap, softDeleteMap, modelToTable) {
  const targets  = []
  const visited  = new Set([modelName])
  const queue    = [modelName]

  while (queue.length) {
    const parent = queue.shift()
    for (const [relName, rel] of Object.entries(relationMap[parent] ?? {})) {
      if (rel.kind !== 'hasMany') continue
      const child = rel.targetModel
      if (visited.has(child)) continue
      visited.add(child)
      // @hardDelete children are always included regardless of their own softDelete setting.
      // Non-hardDelete children must also be a soft-delete table to cascade.
      if (!rel.hardDelete && !softDeleteMap[child]) continue
      targets.push({
        childModel:    child,
        childTable:    modelToTable(child),
        parentModel:   parent,
        parentTable:   modelToTable(parent),
        // Back-compat aliases — older call sites might still destructure these.
        foreignKey:    rel.foreignKey,
        referencedKey: rel.referencedKey,
        hardDelete:    rel.hardDelete ?? false,
      })
      // Only recurse into soft-delete children — hard-delete children are terminal
      if (!rel.hardDelete) queue.push(child)
    }
  }

  return targets
}

function buildRelationMap(schema) {
  const map = {}
  for (const model of schema.models) {
    if (!map[model.name]) map[model.name] = {}
    for (const field of model.fields) {
      if (field.type.kind !== 'relation') continue
      const rel = field.attributes.find(a => a.kind === 'relation' && a.fields)
      if (!rel) continue
      map[model.name][field.name] = {
        kind:          'belongsTo',
        targetModel:   field.type.name,
        foreignKey:    Array.isArray(rel.fields)     ? rel.fields[0]     : rel.fields,
        referencedKey: Array.isArray(rel.references) ? rel.references[0] : rel.references,
      }
      const target = field.type.name
      if (!map[target]) map[target] = {}
      // Find the parent's hasMany back-ref field — its name is what users use
      // in include/orderBy/select. Under PascalCase singular models, the field
      // name will differ from model.name (e.g. books Book[] on Author).
      const parentModel = schema.models.find(m => m.name === target)
      const backrefField = parentModel?.fields.find(f =>
        f.type.name === model.name && f.type.array && f.type.kind === 'relation'
      )
      const backrefName = backrefField?.name ?? model.name  // fallback to old behavior if no field declared
      if (!map[target][backrefName]) {
        // @hardDelete lives on the PARENT's hasMany back-ref field (e.g. accounts.sessions[] @hardDelete)
        const hardDelete = backrefField?.attributes.some(a => a.kind === 'hardDelete') ?? false
        map[target][backrefName] = {
          kind:          'hasMany',
          targetModel:   model.name,
          foreignKey:    Array.isArray(rel.fields)     ? rel.fields[0]     : rel.fields,
          referencedKey: Array.isArray(rel.references) ? rel.references[0] : rel.references,
          hardDelete,
        }
      }
    }
  }

  // Implicit m2m — add manyToMany entries for both sides of each pair
  const m2mPairs = detectM2MPairs(schema)
  for (const pair of m2mPairs) {
    if (!map[pair.modelA]) map[pair.modelA] = {}
    if (!map[pair.modelB]) map[pair.modelB] = {}

    // Field name is the camelCase of the target model (lowercased first char) + 's'
    // But we need to find the actual field name declared in the schema
    // Look it up from the schema directly
    const modelA = schema.models.find(m => m.name === pair.modelA)
    const modelB = schema.models.find(m => m.name === pair.modelB)

    // A's field that points to B
    const fieldAtoB = modelA?.fields.find(f => f.type.kind === 'implicitM2M' && f.type.name === pair.modelB)
    // B's field that points to A
    const fieldBtoA = modelB?.fields.find(f => f.type.kind === 'implicitM2M' && f.type.name === pair.modelA)

    if (fieldAtoB) {
      map[pair.modelA][fieldAtoB.name] = {
        kind:        'manyToMany',
        targetModel: pair.modelB,
        joinTable:   pair.joinTable,
        selfKey:     pair.colA,    // join table column for THIS model
        targetKey:   pair.colB,    // join table column for TARGET model
      }
    }
    if (fieldBtoA) {
      map[pair.modelB][fieldBtoA.name] = {
        kind:        'manyToMany',
        targetModel: pair.modelA,
        joinTable:   pair.joinTable,
        selfKey:     pair.colB,    // join table column for THIS model
        targetKey:   pair.colA,    // join table column for TARGET model
      }
    }
  }

  return map
}

// ─── Soft delete map ──────────────────────────────────────────────────────────
// { modelName: boolean } — true if the model uses soft delete

function buildSoftDeleteMap(schema) {
  const map = {}
  for (const model of schema.models) {
    map[model.name] = isSoftDelete(model)
  }
  return map
}


// ─── FTS map ──────────────────────────────────────────────────────────────────
// { modelName: string[] | null } — indexed field names if @@fts, else null

function buildFtsMap(schema) {
  const map = {}
  for (const model of schema.models) {
    const attr = model.attributes.find(a => a.kind === 'fts')
    map[model.name] = attr ? attr.fields : null
  }
  return map
}

// Current ISO timestamp for soft deletes
function nowISO() {
  return new Date().toISOString()
}

// ─── Extensions loading ───────────────────────────────────────────────────────

async function loadComputedFields(computedInput) {
  if (!computedInput) return {}
  // Accept an object directly — { modelName: { fieldName: fn } }
  if (typeof computedInput === 'object') return computedInput
  // Otherwise treat as a file path
  const abs = resolve(computedInput)
  try {
    const mod = await import(`file://${abs}`)
    return mod.default ?? mod
  } catch (e) {
    throw new Error(`Failed to load computed functions file: ${abs}\n  ${e.message}`)
  }
}

// ─── Transaction manager ──────────────────────────────────────────────────────
// Uses SAVEPOINTs for nesting so $transaction + createMany compose safely.

function makeTxManager(db) {
  let depth = 0
  let spCount = 0

  function begin() {
    if (depth === 0) { db.run('BEGIN') }
    else { spCount++; db.run(`SAVEPOINT sp_${spCount}`) }
    depth++
    return depth === 1 ? null : spCount
  }

  function commit(sp) {
    depth--
    if (sp == null) db.run('COMMIT')
    else            db.run(`RELEASE sp_${sp}`)
  }

  function rollback(sp) {
    depth--
    if (sp == null) db.run('ROLLBACK')
    else { db.run(`ROLLBACK TO sp_${sp}`); db.run(`RELEASE sp_${sp}`) }
  }

  function wrap(fn) {
    const sp = begin()
    try { const r = fn(); commit(sp); return r }
    catch (e) { rollback(sp); throw e }
  }

  return { begin, commit, rollback, wrap }
}

// ─── Computed fields ──────────────────────────────────────────────────────────

function applyComputed(row, modelName, computedFns, ctx) {
  if (!row) return row
  const fns = computedFns?.[modelName]
  if (!fns) return row
  const out = { ...row }
  for (const [field, fn] of Object.entries(fns)) {
    if (typeof fn === 'function') out[field] = fn(out, ctx)
  }
  return out
}

// ─── Strip unwritable fields ──────────────────────────────────────────────────

function stripVirtual(data, generatedFields, computedFields, fromFieldNames = null) {
  if (!data) return data
  const out = { ...data }
  for (const f of generatedFields) delete out[f]
  for (const f of computedFields)  delete out[f]
  if (fromFieldNames) for (const f of fromFieldNames) delete out[f]
  return out
}

// ─── Soft delete WHERE injection ──────────────────────────────────────────────
// Prepend the deletedAt IS NULL filter to any existing where clause.

function injectSoftDeleteFilter(where, mode) {
  // mode: 'live' (default) | 'withDeleted' | 'onlyDeleted'
  if (mode === 'withDeleted') return where
  if (mode === 'onlyDeleted') {
    const filter = { deletedAt: { not: null } }
    if (!where) return filter
    return { AND: [filter, where] }
  }
  // 'live' — default
  const filter = { deletedAt: null }
  if (!where) return filter
  return { AND: [filter, where] }
}

// ─── Include resolution ───────────────────────────────────────────────────────
// One query per relation level, batched with IN — never N queries per row.
// Uses readDb for all include fetches.

function resolveIncludes(readDb, rows, include, modelName, ctx) {
  if (!include || !rows.length) return rows

  const { relationMap, jsonMap, computedSets, softDeleteMap, computedFns } = ctx
  const tableRelations = relationMap[modelName] ?? {}

  // Resolve a PascalCase model name to its SQL table name. Relations in relationMap
  // carry the target as a model name; SQL emits the table name.
  const modelToTable = (mName) => {
    const m = ctx.schema?.models.find(x => x.name === mName)
    return m ? modelToTableName(m, ctx.pluralize ?? false) : mName
  }

  // ── _count in include ──────────────────────────────────────────────────────
  // Supports three forms per key:
  //   posts: true                                        — unfiltered count
  //   posts: { where: { published: true } }             — filtered, key = relation name
  //   published_posts: { relation: 'posts', where: { published: true } }  — filtered alias
  //
  // Multiple filtered counts of the same relation are supported via aliases.
  // All counts are batched — one GROUP BY query per distinct (relation, where) pair.
  if (include._count) {
    const countSpec = include._count === true
      ? Object.fromEntries(Object.keys(tableRelations).filter(k => {
          const r = tableRelations[k]
          return r.kind === 'hasMany' || r.kind === 'manyToMany'
        }).map(k => [k, true]))
      : (include._count.select ?? include._count)

    const idField = ctx.models[modelName]?.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
    const pkValues = [...new Set(rows.map(r => r[idField]).filter(v => v != null))]
    const ph = pkValues.map(() => '?').join(', ')

    for (const [alias, spec] of Object.entries(countSpec)) {
      if (!spec) continue

      // Resolve relation name and optional where filter
      const relName  = (typeof spec === 'object' && spec.relation) ? spec.relation : alias
      const where    = (typeof spec === 'object' && spec !== true)  ? (spec.where ?? null) : null

      const rel      = tableRelations[relName]
      if (!rel) continue
      if (rel.kind !== 'hasMany' && rel.kind !== 'manyToMany') continue

      let sql, results

      if (rel.kind === 'manyToMany') {
        // M2M: count via join table — where filters not supported on join table, skip
        sql = `SELECT "${rel.selfKey}" as __pk, COUNT(*) as __n FROM "${rel.joinTable}" WHERE "${rel.selfKey}" IN (${ph}) GROUP BY "${rel.selfKey}"`
        results = readDb.query(sql).all(...pkValues)
      } else {
        const sdExtra = softDeleteMap[rel.targetModel] ? ` AND "deletedAt" IS NULL` : ''
        // Build optional where filter using buildWhere
        let whereExtra = ''
        const whereParams = []
        if (where) {
          const ws = buildWhere(where, whereParams)
          if (ws) whereExtra = ` AND (${ws})`
        }
        sql = `SELECT "${rel.foreignKey}" as __pk, COUNT(*) as __n FROM "${modelToTable(rel.targetModel)}" WHERE "${rel.foreignKey}" IN (${ph})${sdExtra}${whereExtra} GROUP BY "${rel.foreignKey}"`
        results = readDb.query(sql).all(...pkValues, ...whereParams)
      }

      const counts = new Map(results.map(r => [r.__pk, r.__n]))
      for (const row of rows) {
        if (!row._count) row._count = {}
        row._count[alias] = counts.get(row[idField]) ?? 0
      }
    }
  }

  for (const [relName, relInclude] of Object.entries(include)) {
    if (relName === '_count') continue
    if (!relInclude) continue

    const rel = tableRelations[relName]
    if (!rel) throw new Error(`Unknown relation "${relName}" on "${modelName}"`)

    const nestedInclude = typeof relInclude === 'object' && relInclude !== true
      ? relInclude.include ?? null : null
    const nestedSelect  = typeof relInclude === 'object' && relInclude !== true
      ? relInclude.select  ?? null : null
    // Soft delete mode for related table
    const nestedMode    = typeof relInclude === 'object' && relInclude !== true
      ? relInclude.withDeleted ? 'withDeleted' : relInclude.onlyDeleted ? 'onlyDeleted' : 'live'
      : 'live'

    const targetJsonFields  = jsonMap[rel.targetModel]      ?? new Set()
    const targetSoftDelete  = softDeleteMap[rel.targetModel] ?? false

    if (rel.kind === 'belongsTo') {
      const fkValues = [...new Set(rows.map(r => r[rel.foreignKey]).filter(v => v != null))]
      if (!fkValues.length) { rows.forEach(r => r[relName] = null); continue }

      const parsedNested = nestedSelect
        ? parseSelectArg(nestedSelect, rel.targetModel, relationMap, computedSets, nestedInclude)
        : null

      let sqlCols = parsedNested?.sqlCols ?? '*'
      if (parsedNested && sqlCols !== '*' && !sqlCols.includes(`"${rel.referencedKey}"`)) {
        sqlCols = `"${rel.referencedKey}", ${sqlCols}`
        parsedNested.injectedFKs.add(rel.referencedKey)
      }

      // Build WHERE with soft delete filter for target table
      const sdParams = []
      let sdWhere = ''
      if (targetSoftDelete && nestedMode !== 'withDeleted') {
        const ph   = fkValues.map(() => '?').join(', ')
        const sdFilter = nestedMode === 'onlyDeleted'
          ? `"deletedAt" IS NOT NULL AND "${rel.referencedKey}" IN (${ph})`
          : `"deletedAt" IS NULL AND "${rel.referencedKey}" IN (${ph})`
        sdWhere = sdFilter
        sdParams.push(...fkValues)
      } else {
        const ph = fkValues.map(() => '?').join(', ')
        sdWhere = `"${rel.referencedKey}" IN (${ph})`
        sdParams.push(...fkValues)
      }

      const related = readDb
        .query(`SELECT ${sqlCols} FROM "${modelToTable(rel.targetModel)}" WHERE ${sdWhere}`)
        .all(...sdParams)
        .map(r => applyComputed(coerceBooleans(deserializeRow(r, targetJsonFields), ctx.boolMap?.[rel.targetModel] ?? new Set()), rel.targetModel, computedFns, ctx))

      const mergedInclude = { ...(nestedInclude ?? {}), ...(parsedNested?.relationSelects ?? {}) }
      if (Object.keys(mergedInclude).length)
        resolveIncludes(readDb, related, mergedInclude, rel.targetModel, ctx)

      const byKey = new Map(related.map(r => [r[rel.referencedKey], r]))
      for (const row of rows) {
        const raw = byKey.get(row[rel.foreignKey]) ?? null
        row[relName] = raw && parsedNested
          ? Object.fromEntries(Object.entries(raw).filter(([k]) => parsedNested.requestedFields.has(k) && !parsedNested.injectedFKs.has(k)))
          : raw
      }

    } else if (rel.kind === 'manyToMany') {
      // Implicit m2m — JOIN through the join table.
      // Select j.selfKey alongside t.* so we can group in one pass — no second query.
      const pkField  = rel.referencedKey ?? 'id'
      const pkValues = [...new Set(rows.map(r => r[pkField]).filter(v => v != null))]
      if (!pkValues.length) { rows.forEach(r => r[relName] = []); continue }

      const ph      = pkValues.map(() => '?').join(', ')
      const rawRows = readDb
        .query(
          `SELECT t.*, j."${rel.selfKey}" AS __jSelfKey FROM "${modelToTable(rel.targetModel)}" t ` +
          `INNER JOIN "${rel.joinTable}" j ON j."${rel.targetKey}" = t."id" ` +
          `WHERE j."${rel.selfKey}" IN (${ph})`
        )
        .all(...pkValues)

      // Strip __jSelfKey before processing so it doesn't leak into the output row
      const selfKeys = rawRows.map(r => { const k = r.__jSelfKey; delete r.__jSelfKey; return k })

      const related = rawRows
        .map(r => applyComputed(coerceBooleans(deserializeRow(r, targetJsonFields), ctx.boolMap?.[rel.targetModel] ?? new Set()), rel.targetModel, computedFns, ctx))

      const mergedInclude = nestedInclude ?? {}
      if (Object.keys(mergedInclude).length)
        resolveIncludes(readDb, related, mergedInclude, rel.targetModel, ctx)

      const grouped = new Map()
      for (const row of rows) grouped.set(row[pkField], [])
      for (let i = 0; i < related.length; i++) {
        const arr = grouped.get(selfKeys[i])
        if (arr) arr.push(related[i])
      }

      for (const row of rows) {
        row[relName] = grouped.get(row[pkField]) ?? []
      }

    } else {
      const pkValues = [...new Set(rows.map(r => r[rel.referencedKey]).filter(v => v != null))]
      if (!pkValues.length) { rows.forEach(r => r[relName] = []); continue }

      const parsedNested = nestedSelect
        ? parseSelectArg(nestedSelect, rel.targetModel, relationMap, computedSets, nestedInclude)
        : null

      let sqlCols = parsedNested?.sqlCols ?? '*'
      if (parsedNested && sqlCols !== '*' && !sqlCols.includes(`"${rel.foreignKey}"`)) {
        sqlCols = `"${rel.foreignKey}", ${sqlCols}`
        parsedNested.injectedFKs.add(rel.foreignKey)
      }

      const ph = pkValues.map(() => '?').join(', ')
      let sdWhere
      if (targetSoftDelete && nestedMode !== 'withDeleted') {
        const sdClause = nestedMode === 'onlyDeleted' ? '"deletedAt" IS NOT NULL' : '"deletedAt" IS NULL'
        sdWhere = `${sdClause} AND "${rel.foreignKey}" IN (${ph})`
      } else {
        sdWhere = `"${rel.foreignKey}" IN (${ph})`
      }

      const related = readDb
        .query(`SELECT ${sqlCols} FROM "${modelToTable(rel.targetModel)}" WHERE ${sdWhere}`)
        .all(...pkValues)
        .map(r => applyComputed(coerceBooleans(deserializeRow(r, targetJsonFields), ctx.boolMap?.[rel.targetModel] ?? new Set()), rel.targetModel, computedFns, ctx))

      const mergedInclude = { ...(nestedInclude ?? {}), ...(parsedNested?.relationSelects ?? {}) }
      if (Object.keys(mergedInclude).length)
        resolveIncludes(readDb, related, mergedInclude, rel.targetModel, ctx)

      const grouped = new Map()
      for (const r of related) {
        const k = r[rel.foreignKey]
        if (!grouped.has(k)) grouped.set(k, [])
        grouped.get(k).push(r)
      }

      for (const row of rows) {
        const group = grouped.get(row[rel.referencedKey]) ?? []
        row[relName] = parsedNested
          ? group.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => parsedNested.requestedFields.has(k) && !parsedNested.injectedFKs.has(k))))
          : group
      }
    }
  }

  return rows
}


// ─── Hook + event engine ──────────────────────────────────────────────────────
//
// TWO distinct systems:
//
// 1. Transform hooks  — synchronous middleware, run IN the query pipeline.
//    Can mutate args.data before write, or transform result rows after read.
//    Registered as: hooks.before.{operation|setters|getters|all}
//                   hooks.after.{operation|setters|getters|all}
//
// 2. Event listeners  — async callbacks, fire AFTER commit completes.
//    The caller already has their result. Used for side effects.
//    Registered as: on.{create|update|remove|change}
//
// Operation groups:
//   setters  — create, createMany, update, updateMany, upsert
//   getters  — findMany, findFirst, findUnique, findManyCursor, count, search
//   all      — everything
//
// Context shape (same for both systems):
//   { model, operation, args, result, schema }
//   args   — mutable in before hooks (changes affect the actual query)
//   result — present in after hooks + events (read-only in events)

const SETTER_OPS = new Set(['create','createMany','update','updateMany','upsert','upsertMany','remove','removeMany','delete','deleteMany'])
const GETTER_OPS = new Set(['findMany','findFirst','findUnique','findManyCursor','count','search'])

function buildHookRunner(hooks) {
  if (!hooks) return null

  // Flatten hook config into { before: Map<op, [fn]>, after: Map<op, [fn]> }
  function expand(phase) {
    const map = new Map()
    const cfg = hooks[phase]
    if (!cfg) return map

    for (const [key, fns] of Object.entries(cfg)) {
      const arr = Array.isArray(fns) ? fns : [fns]
      if (key === 'all') {
        // Apply to every operation
        for (const op of [...SETTER_OPS, ...GETTER_OPS]) {
          if (!map.has(op)) map.set(op, [])
          map.get(op).push(...arr)
        }
      } else if (key === 'setters') {
        for (const op of SETTER_OPS) {
          if (!map.has(op)) map.set(op, [])
          map.get(op).push(...arr)
        }
      } else if (key === 'getters') {
        for (const op of GETTER_OPS) {
          if (!map.has(op)) map.set(op, [])
          map.get(op).push(...arr)
        }
      } else {
        // Exact operation name
        if (!map.has(key)) map.set(key, [])
        map.get(key).push(...arr)
      }
    }
    return map
  }

  const before = expand('before')
  const after  = expand('after')

  return {
    // Run before hooks — mutates ctx.args in place, returns ctx
    runBefore(hctx, clientCtx) {
      const fns = before.get(hctx.operation) ?? []
      for (const fn of fns) {
        const result = fn(clientCtx, hctx)
        if (result && typeof result === 'object') Object.assign(hctx, result)
      }
      return hctx
    },
    // Run after hooks — mutates hctx.result in place, returns hctx
    runAfter(hctx, clientCtx) {
      const fns = after.get(hctx.operation) ?? []
      for (const fn of fns) {
        const result = fn(clientCtx, hctx)
        if (result && typeof result === 'object' && 'result' in result) {
          hctx.result = result.result
        }
      }
      return hctx
    },
    hasBefore: (op) => (before.get(op)?.length ?? 0) > 0,
    hasAfter:  (op) => (after.get(op)?.length ?? 0) > 0,
  }
}

function buildEventEmitter(onEvent) {
  if (!onEvent) return null
  // Normalise: onEvent.create, onEvent.update, onEvent.remove, onEvent.change
  // Each can be a single function or array of functions
  const listeners = {}
  for (const [event, fns] of Object.entries(onEvent)) {
    listeners[event] = Array.isArray(fns) ? fns : [fns]
  }

  return {
    emit(event, eventCtx, clientCtx) {
      // Fire-and-forget — never blocks the caller
      const fns = [...(listeners[event] ?? []), ...(listeners.change ?? [])]
      if (!fns.length) return
      // setTimeout(0) ensures event fires after the caller's await resolves
      setTimeout(() => {
        for (const fn of fns) {
          try { fn(eventCtx, clientCtx) } catch (e) { console.warn(`litestone event listener error (${event}):`, e) }
        }
      }, 0)
    }
  }
}

// ─── HAVING clause builder for groupBy() ─────────────────────────────────────
// Converts { gt: 5 } or scalar 5 into a SQL fragment like "COUNT(*) > ?"
function buildAggHaving(expr, cond, params) {
  if (cond == null) return null
  if (typeof cond !== 'object') {
    params.push(cond)
    return `${expr} = ?`
  }
  const parts = []
  for (const [op, val] of Object.entries(cond)) {
    switch (op) {
      case 'gt':  params.push(val); parts.push(`${expr} > ?`);  break
      case 'gte': params.push(val); parts.push(`${expr} >= ?`); break
      case 'lt':  params.push(val); parts.push(`${expr} < ?`);  break
      case 'lte': params.push(val); parts.push(`${expr} <= ?`); break
      case 'not': params.push(val); parts.push(`${expr} != ?`); break
    }
  }
  return parts.length ? parts.join(' AND ') : null
}



function makeTable(
  readDb, writeDb,
  tableName,    // SQL table name (e.g., "user" — used in FROM/INTO clauses)
  modelName,    // Model name as declared in schema (e.g., "User" — used to look up per-model maps)
  jsonFields, generatedFields, computedFields,
  softDelete,
  ftsFields,
  boolFields,
  enumFields,
  softDeleteCascade,
  fieldPolicy,
  fromFields,
  ctx
) {
  const { relationMap, computedSets, computedFns, tx, hookRunner, emitter, globalFilters } = ctx
  const plugins = ctx.plugins   // PluginRunner
  const hasFieldPolicy = Object.keys(fieldPolicy).length > 0

  // Accessor key (camelCase singular, e.g. "user", "serviceAgreement") — used
  // to look up user-facing config like `filters:` that users keyed using the
  // same name they access on `db.*`.
  const accessor = modelToAccessor(modelName)

  // Resolve a PascalCase model name to its SQL table name. Used when cascading
  // through relationMap, which yields model names, to emit DELETE/UPDATE against
  // the correctly-derived (snake_case, optionally plural) child table.
  const _modelToTable = (mName) => {
    const m = ctx.schema?.models.find(x => x.name === mName)
    return m ? modelToTableName(m, ctx.pluralize ?? false) : mName
  }

  // ── Transition enforcement ───────────────────────────────────────────────
  //
  // Runs on update() and upsert() when the data touches a transitions-typed field.
  // Returns { transitionName, field, from, to } or null if no transition field touched.
  // Throws TransitionViolationError or TransitionConflictError.
  //
  // NOTE: updateMany() is NOT enforced — bulk ops skip transition checks.
  // This is intentional: updateMany is a power tool and callers take responsibility.
  // Document: use update() in a loop or $transaction when transition safety is required.
  //
  // SYSTEM bypass: ctx.isSystem skips enforcement and logs a warning.
  //
  const _tableTransitions = ctx.transitionMap?.[modelName] ?? null

  function checkTransitions(data, whereParams, whereSql) {
    if (!_tableTransitions) return null
    if (ctx.isSystem) return null   // SYSTEM always bypasses — logged below

    // Find the first transitions-typed field in the data being written
    for (const [fieldName, spec] of Object.entries(_tableTransitions)) {
      if (!(fieldName in data)) continue
      const newValue = data[fieldName]
      if (newValue == null) continue

      // Fetch current value — needed to validate from-state
      const current = readDb.query(`SELECT "${fieldName}" FROM "${tableName}" WHERE ${whereSql}`).get(...whereParams)
      if (!current) return null   // record not found — let update() handle that
      const currentValue = current[fieldName]
      if (currentValue == null) return null   // null current — no from-state to check
      if (currentValue === newValue) return null   // no change — nothing to enforce

      // Find a valid transition: from includes currentValue, to === newValue
      const transitions = spec.transitions
      let matchedName = null
      for (const [tName, { from, to }] of Object.entries(transitions)) {
        if (to === newValue && from.includes(currentValue)) { matchedName = tName; break }
      }

      if (!matchedName) {
        // Build list of valid target values from currentValue for error message
        const validTargets = Object.values(transitions)
          .filter(t => t.from.includes(currentValue))
          .map(t => t.to)
        throw new TransitionViolationError(tableName, fieldName, currentValue, newValue, validTargets)
      }

      return { transitionName: matchedName, field: fieldName, from: currentValue, to: newValue }
    }
    return null
  }

  function applyTransitionWhereClause(transitionResult, finalWhereSql, finalWhereParams) {
    if (!transitionResult) return { sql: finalWhereSql, params: finalWhereParams }
    // Add WHERE field = currentValue for optimistic concurrency
    return {
      sql:    `(${finalWhereSql}) AND "${transitionResult.field}" = ?`,
      params: [...finalWhereParams, transitionResult.from],
    }
  }

  function emitTransitionEvent(transitionResult, record) {
    if (!transitionResult || !emitter) return
    if (ctx.isSystem) {
      console.warn(`[litestone] SYSTEM bypassed transition on ${tableName}.${transitionResult.field}: '${transitionResult.from}' -> '${transitionResult.to}'`)
      return
    }
    emitter.emit('transition', {
      model:      tableName,
      transition: transitionResult.transitionName,
      field:      transitionResult.field,
      from:       transitionResult.from,
      to:         transitionResult.to,
      record,
    }, ctx)
  }

  // ── Query event emitter ───────────────────────────────────────────────────
  // Zero-cost when no onQuery configured and no $tapQuery listeners active.
  // Fires both the config-time onQuery hook (production logging) and any
  // runtime $tapQuery taps (Studio REPL, testing). Never throws, never blocks.
  const _dbName = ctx.modelDbMap?.[modelName] ?? 'main'
  function fireQuery(event) {
    if (!ctx.onQuery && !ctx._queryListeners.size) return
    const e = { model: tableName, database: _dbName, actorId: ctx.auth?.id ?? null, ...event }
    if (ctx.onQuery) { try { const r = ctx.onQuery(e); if (r?.catch) r.catch(() => {}) } catch {} }
    if (ctx._queryListeners.size) for (const fn of ctx._queryListeners) { try { const r = fn(e); if (r?.catch) r.catch(() => {}) } catch {} }
  }

  // Hot-path optimization: most installations don't set onQuery and don't have
  // listeners attached. Cache a boolean checker so each read can skip the
  // performance.now() and event-object allocation entirely.
  // The check itself is cheap (two property accesses) but consistent inlining
  // makes the v8 JIT happier when the result is used in conditional branches.
  function needsTiming() {
    return !!(ctx.onQuery || ctx._queryListeners.size)
  }

  // Derive the primary key field name for this table (used by upsertMany default conflict target)
  const idField = ctx.models[modelName]?.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'

  // ── Logging helpers ───────────────────────────────────────────────────────
  //
  // All log configuration is pre-computed once at makeTable() time.
  // Tables with no @log / @@log get tableHasAnyLog = false — the hot path
  // (findMany, create, update, remove, delete) checks this single boolean and
  // exits immediately with zero allocation cost.
  //
  // Design:
  //   tableFieldLogs  — Map<fieldName, [{db, reads, writes}]> for THIS table only
  //   tableModelLogs  — [{db, reads, writes}] for THIS table only, or null
  //   tableHasAnyLog  — pre-computed boolean: skip all log work if false
  //   tableNeedsModel — pre-computed: does any @@log declaration exist for this table
  //   tableNeedsField — pre-computed: does any @log declaration exist for this table

  const _rawFieldLogs = ctx.logMap?.fields ?? {}
  const _rawModelLogs = ctx.logMap?.models ?? {}

  // Build per-table field log map (only entries for this table, key = fieldName only)
  const tableFieldLogs = new Map()
  for (const [key, configs] of Object.entries(_rawFieldLogs)) {
    const dot = key.indexOf('.')
    if (dot === -1) continue
    const model = key.slice(0, dot)
    if (model !== tableName) continue
    const field = key.slice(dot + 1)
    tableFieldLogs.set(field, configs)
  }

  const tableModelLogs   = _rawModelLogs[modelName] ?? null
  const tableHasAnyLog   = tableFieldLogs.size > 0 || (tableModelLogs?.length > 0)
  const tableNeedsField  = tableFieldLogs.size > 0
  const tableNeedsModel  = tableModelLogs?.length > 0

  // Pre-resolve log tables at startup so getLogTable() is O(1) on hot paths.
  // Map<dbName, logTable>
  const _logTableCache = new Map()
  function getLogTable(dbName) {
    if (_logTableCache.has(dbName)) return _logTableCache.get(dbName)
    const dbEntry = ctx.loggerDbMap?.[dbName]
    const table   = dbEntry
      ? (ctx.jsonlTableCache?.[dbEntry.logModel ?? (dbName + 'Logs')] ?? null)
      : null
    // Only cache hits — a null result may mean jsonlTableCache wasn't ready yet
    // (timing: initial makeAllTables runs before ctx.jsonlTableCache is assigned).
    if (table) _logTableCache.set(dbName, table)
    return table
  }

  // Extract record ids from an array of rows using this table's @id field.
  function extractIds(rows) {
    if (!rows?.length) return []
    return rows.map(r => r[idField]).filter(id => id != null)
  }

  // Emit a log entry fire-and-forget to a logger database.
  function emitLog(dbName, entry) {
    const table = getLogTable(dbName)
    if (!table) return
    fireLog(table, buildLogEntry(entry, ctx, ctx.onLog))
  }

  // Emit field-level and model-level log entries for a completed operation.
  // Called once per operation — extracts ids once, shared by both helpers.
  // operation: 'read' | 'write' | 'create' | 'update' | 'delete'
  function emitLogs(operation, rows, { before: beforeMap, after: afterMap } = {}) {
    if (!tableHasAnyLog) return          // ← fast exit for unlogged tables
    const ids = extractIds(rows)         // extract once, shared below

    // ── Field-level logs ──────────────────────────────────────────────────
    if (tableNeedsField) {
      const isReadOp  = operation === 'read'
      const isWriteOp = !isReadOp   // create, update, delete are all writes
      for (const [field, configs] of tableFieldLogs) {
        for (const { db, reads, writes } of configs) {
          if (isReadOp  && !reads)  continue
          if (isWriteOp && !writes) continue

          emitLog(db, {
            operation,
            model:   tableName,
            field,
            records: ids,
            before:  beforeMap ? (beforeMap[field] ?? null) : null,
            after:   afterMap  ? (afterMap[field]  ?? null) : null,
          })
        }
      }
    }

    // ── Model-level logs ──────────────────────────────────────────────────
    if (tableNeedsModel) {
      for (const { db, reads, writes } of tableModelLogs) {
        const isWrite = operation === 'create' || operation === 'update' || operation === 'delete'
        if (operation === 'read' && !reads)  continue
        if (isWrite              && !writes) continue

        emitLog(db, {
          operation,
          model:   tableName,
          field:   null,
          records: ids,
          before:  beforeMap ?? null,
          after:   afterMap  ?? null,
        })
      }
    }
  }

  // ── Field policy helpers ──────────────────────────────────────────────────
  // Strip and decrypt fields according to @omit/@guarded/@encrypted rules.
  // mode: 'list'   — findMany / findFirst (strictest — strips @omit)
  //       'single' — findUnique           (@omit included, @guarded still stripped)
  //       'select' — explicit select      (@omit/@omit(all) bypassed if field selected)
  function applyFieldPolicy(row, { mode = 'list', selectedFields = null } = {}) {
    if (!row || !hasFieldPolicy) return row
    const isSystem = ctx.isSystem
    const out = { ...row }

    for (const fieldName in fieldPolicy) {
      const policy = fieldPolicy[fieldName]
      const { omit, guarded, encrypted, allow } = policy
      const explicitlySelected = selectedFields?.has(fieldName)

      // ── Determine if field should be stripped ────────────────────────────
      let strip = false

      if (encrypted) {
        strip = !isSystem
      } else if (guarded === 'all') {
        strip = !isSystem
      } else if (guarded === 'select') {
        strip = !isSystem
      } else if (omit === 'all') {
        strip = !explicitlySelected
      } else if (omit === 'lists') {
        strip = mode === 'list' && !explicitlySelected
      } else if (allow?.read?.length && !isSystem) {
        const permitted = allow.read.some(expr =>
          evalJs(expr, ctx, out, modelName, ctx.policyMap ?? {}, ctx.relationMap)
        )
        if (!permitted) strip = true
      }

      if (strip) {
        delete out[fieldName]
        continue
      }

      // ── Decrypt if field is present and encrypted ─────────────────────────
      if (encrypted && fieldName in out && out[fieldName] != null) {
        try {
          out[fieldName] = decryptField(out[fieldName], ctx.encKey)
        } catch {
          out[fieldName] = null
        }
      }
    }

    return out
  }

  // ── Read helpers ──────────────────────────────────────────────────────────
  // Pre-compute per-table flags for read()
  const _hasJson     = jsonFields.size > 0
  const _hasBool     = boolFields.size > 0
  const _hasComputed = (computedSets[modelName]?.size ?? 0) > 0

  // ── @from deserialization ─────────────────────────────────────────────────
  // last/first return JSON strings from json_object() → parse to object
  // exists returns 0/1 integer → coerce to boolean
  function deserializeFromFields(row) {
    const out = { ...row }
    for (const [name] of _fromEntries) {
      if (!(name in out)) continue
      if (_fromObjectFields.has(name)) {
        out[name] = out[name] != null
          ? (typeof out[name] === 'string' ? JSON.parse(out[name]) : out[name])
          : null
      } else if (_fromBoolFields.has(name)) {
        out[name] = out[name] === 1 || out[name] === true
      }
    }
    return out
  }

  function read(row, opts = {}) {
    if (!row) return null
    if (!_hasJson && !_hasBool && !_hasComputed && !hasFieldPolicy && !_hasFrom) return row
    let r = row
    if (_hasJson || _hasBool) {
      const out = { ...r }
      if (_hasJson) {
        for (const field of jsonFields) {
          if (field in out && typeof out[field] === 'string') {
            try { out[field] = JSON.parse(out[field]) } catch {}
          }
        }
      }
      if (_hasBool) {
        for (const field of boolFields) {
          if (field in out && out[field] !== null) {
            out[field] = out[field] === 1 || out[field] === true
          }
        }
      }
      r = out
    }
    if (_hasFrom) r = deserializeFromFields(r)
    if (_hasComputed) r = applyComputed(r, modelName, computedFns, ctx)
    if (hasFieldPolicy) r = applyFieldPolicy(r, opts)
    return r
  }
  function readAll(rows, opts = {}) {
    // Fast path — no transforms needed, return rows as-is
    if (!_hasJson && !_hasBool && !_hasComputed && !hasFieldPolicy && !_hasFrom) return rows
    return rows.map(r => {
      if (_hasJson || _hasBool) {
        const out = { ...r }
        if (_hasJson) {
          for (const field of jsonFields) {
            if (field in out && typeof out[field] === 'string') {
              try { out[field] = JSON.parse(out[field]) } catch {}
            }
          }
        }
        if (_hasBool) {
          for (const field of boolFields) {
            if (field in out && out[field] !== null) {
              out[field] = out[field] === 1 || out[field] === true
            }
          }
        }
        r = out
      }
      if (_hasFrom)      r = deserializeFromFields(r)
      if (_hasComputed)  r = applyComputed(r, modelName, computedFns, ctx)
      if (hasFieldPolicy) r = applyFieldPolicy(r, opts)
      return r
    })
  }

  // ── Write helper ──────────────────────────────────────────────────────────
  function writeData(data) {
    const model = ctx.models[modelName]
    const transformed = model ? applyTransforms(data, model) : { ...data }
    if (model && ctx.hasValidation[modelName]) validate(transformed, model, computedFns, ctx.typeMap)
    // Validate array fields
    if (model) {
      for (const field of model.fields) {
        if (!field.type.array) continue
        const val = transformed[field.name]
        if (val == null) continue
        if (!Array.isArray(val))
          throw new ValidationError([{ path: [field.name], message: `${field.name} must be an array` }])
        // @minItems
        const minItems = field.attributes.find(a => a.kind === 'minItems')
        if (minItems && val.length < minItems.value)
          throw new ValidationError([{ path: [field.name], message: `${field.name} must have at least ${minItems.value} item(s)` }])
        // @maxItems
        const maxItems = field.attributes.find(a => a.kind === 'maxItems')
        if (maxItems && val.length > maxItems.value)
          throw new ValidationError([{ path: [field.name], message: `${field.name} must have at most ${maxItems.value} item(s)` }])
        // @uniqueItems
        const uniqueItems = field.attributes.find(a => a.kind === 'uniqueItems')
        if (uniqueItems && new Set(val.map(String)).size !== val.length)
          throw new ValidationError([{ path: [field.name], message: `${field.name} must have unique items` }])
        // Type validation: Text[] → all strings, Integer[] → all integers
        if (field.type.name === 'Integer' && !val.every(v => Number.isInteger(v)))
          throw new ValidationError([{ path: [field.name], message: `${field.name} (Integer[]) must contain only integers` }])
        if (field.type.name === 'Text' && !val.every(v => typeof v === 'string'))
          throw new ValidationError([{ path: [field.name], message: `${field.name} (Text[]) must contain only strings` }])
      }
    }

    // Encrypt @encrypted fields before write
    if (ctx.encKey && hasFieldPolicy) {
      for (const [fieldName, policy] of Object.entries(fieldPolicy)) {
        if (!policy.encrypted) continue
        if (!(fieldName in transformed)) continue
        const val = transformed[fieldName]
        if (val == null) continue
        if (isCiphertext(val)) continue  // already encrypted (e.g. re-save)
        transformed[fieldName] = policy.encrypted.searchable
          ? encryptSearchable(val, ctx.encKey)
          : encryptField(val, ctx.encKey)
      }
    }

    // Validate enum fields with friendly errors before hitting SQLite's CHECK
    for (const [field, meta] of Object.entries(enumFields)) {
      const val = transformed[field]
      if (val == null) {
        if (!meta.optional && field in transformed)
          throw new ValidationError([{ path: [field], message: `must be one of: ${[...meta.values].join(', ')}` }])
        continue
      }
      if (!meta.values.has(String(val))) {
        throw new ValidationError([{
          path:    [field],
          message: `invalid ${meta.enumName} value "${val}" — must be one of: ${[...meta.values].join(', ')}`,
        }])
      }
    }
    // @allow('write', expr) — silently drop restricted fields before write
    if (!ctx.isSystem) {
      for (const [fieldName, policy] of Object.entries(fieldPolicy)) {
        if (!policy.allow?.write?.length) continue
        if (!(fieldName in transformed)) continue
        const permitted = policy.allow.write.some(expr =>
          evalJs(expr, ctx, transformed, modelName, ctx.policyMap ?? {}, ctx.relationMap)
        )
        if (!permitted) delete transformed[fieldName]
      }
    }

    return serializeRow(
      serializeBooleans(
        stripVirtual(transformed, generatedFields, computedFields, _hasFrom ? Object.keys(fromFields) : null),
        boolFields
      ),
      jsonFields
    )
  }

  // ── Encrypt WHERE values for @encrypted(searchable) fields ───────────────
  // Wraps buildWhere so that equality comparisons on searchable encrypted
  // fields automatically hash the query value before comparing ciphertext.
  // _fromExprMap is defined later (after _fromEntries) and passed into buildWhere.
  // tableAlias is optional — passed only when the outer FROM uses an alias
  // (e.g. relation orderBy adds JOINs, so columns need `t.` qualification).
  function buildWhereWithEncryption(where, params, tableAlias = null) {
    if (!where) return buildWhere(where, params, _fromExprMap, tableAlias, _typedJsonMap)
    let rewritten = where
    if (ctx.encKey) {
      rewritten = rewriteEncryptedWhere(where)
      if (rewritten?.__impossible) {
        const prefix = tableAlias ? `${tableAlias}.` : ''
        return `${prefix}"id" IS NULL AND ${prefix}"id" IS NOT NULL`
      }
    }
    return buildWhere(rewritten, params, _fromExprMap, tableAlias, _typedJsonMap)
  }

  function rewriteEncryptedWhere(where) {
    if (!where || typeof where !== 'object') return where
    if (Array.isArray(where)) return where.map(rewriteEncryptedWhere)

    const out = {}
    for (const [key, val] of Object.entries(where)) {
      if (key === 'AND' || key === 'OR' || key === 'NOT') {
        out[key] = rewriteEncryptedWhere(val)
        continue
      }
      const policy = fieldPolicy[key]
      if (policy?.encrypted?.searchable && val !== null && typeof val !== 'object') {
        // Scalar equality on searchable encrypted field — hash the query value
        out[key] = encryptSearchable(val, ctx.encKey)
      } else if (policy?.encrypted && !policy.encrypted.searchable && val !== null) {
        // Non-searchable encrypted field in WHERE — stored ciphertext never equals
        // the plaintext query value, so this WHERE can never match. Return a
        // condition on the id field that can never match.
        return { __impossible: true }
      } else {
        out[key] = val
      }
    }
    return out
  }

  // ── SELECT builder ────────────────────────────────────────────────────────
  // Pre-compute static global filter (function filters evaluated per-call since ctx changes)
  const _rawFilter = globalFilters[accessor]
  const _staticGlobalFilter = (typeof _rawFilter !== 'function') ? (_rawFilter ?? null) : null
  const _dynamicGlobalFilter = (typeof _rawFilter === 'function') ? _rawFilter : null

  // Pre-compute base SELECT — reused by every buildSQL call
  const _baseSql = `SELECT * FROM "${tableName}"`

  // ── @from subquery injection ───────────────────────────────────────────────
  // For each @from field, inject a named correlated subquery into the SELECT list.
  // These are always present — no include needed.
  const _fromEntries  = Object.entries(fromFields)   // [fieldName, { subquerySql, isObject }]
  const _hasFrom      = _fromEntries.length > 0
  // Pre-build fromExprMap for buildWhere — substitutes @from field keys with their subquery SQL
  const _fromExprMap  = _hasFrom
    ? Object.fromEntries(_fromEntries.map(([n, {subquerySql}]) => [n, subquerySql]))
    : null

  // ── Typed JSON path pushdown setup ──────────────────────────────────────────
  // For each Json @type(T) field on this model, register the type so buildWhere
  // can compile { addr: { city: 'NYC' } } to json_extract("addr", '$.city') = ?.
  // Also expose the schema's full type registry as $nestedTypes so the where
  // builder can recurse into nested @type fields.
  const _modelDecl = ctx.models[modelName]
  let _typedJsonMap = null
  if (_modelDecl && ctx.typeMap && ctx.typeMap.size > 0) {
    const localMap = {}
    let anyTyped = false
    for (const f of _modelDecl.fields) {
      if (f.type.name !== 'Json') continue
      const typeAttr = f.attributes.find(a => a.kind === 'type')
      if (!typeAttr) continue
      const typeDecl = ctx.typeMap.get(typeAttr.name)
      if (!typeDecl) continue
      localMap[f.name] = typeDecl
      anyTyped = true
    }
    if (anyTyped) {
      // Attach the full registry (under a sentinel key) for nested-type
      // resolution. The sentinel '$nestedTypes' starts with '$' which is not a
      // legal field name in .lite, so it can't collide with a real field.
      localMap.$nestedTypes = ctx.typeMap
      _typedJsonMap = localMap
    }
  }
  // The base SELECT with all @from subqueries appended
  const _baseSqlWithFrom = _hasFrom
    ? `SELECT "${tableName}".*, ${_fromEntries.map(([n, {subquerySql}]) => `${subquerySql} AS "${n}"`).join(', ')} FROM "${tableName}"`
    : _baseSql
  // Set of @from field names that return JSON objects (need deserialization)
  const _fromObjectFields = _hasFrom
    ? new Set(_fromEntries.filter(([,{isObject}]) => isObject).map(([n]) => n))
    : null
  const _fromBoolFields = _hasFrom
    ? new Set(_fromEntries.filter(([,{isBool}]) => isBool).map(([n]) => n))
    : null
  // Pre-compute the ultra-common case: findMany({}) on a soft-delete table with no policy/filter
  const _fastFindManySql = (softDelete && !ctx.hasPolicies && !_staticGlobalFilter && !_dynamicGlobalFilter && !plugins?.hasPlugins)
    ? `${_baseSqlWithFrom} WHERE "deletedAt" IS NULL`
    : null

  // Pre-cache the prepared statement for the most common query pattern.
  // Eliminates Map lookup in wrapDb on every findMany({}) call.
  // Try-guarded for @@external tables that don't exist at createClient time.
  let _fastStmt = null
  if (_fastFindManySql) {
    try { _fastStmt = readDb.query(_fastFindManySql) }
    catch { _fastStmt = null }
  }

  // Fast path #2: findUnique({ where: { <pk>: value } })
  // The single most common query in any app: lookup-by-id. Skip buildSQL entirely.
  // Conditions: no policies, no global filter, no plugins, no field encryption,
  //             no @from fields (would need subquery in SELECT). Soft-delete fine
  //             (we add the deletedAt clause in the precomputed SQL).
  // The PK field name is derived from `idField` already computed below; we need
  // to compute it earlier here. Find it inline.
  const _pkField = ctx.models[modelName]?.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? null
  const _canFastFindUnique = (
    _pkField &&
    !ctx.hasPolicies &&
    !_staticGlobalFilter && !_dynamicGlobalFilter &&
    !plugins?.hasPlugins &&
    Object.keys(fieldPolicy).length === 0 &&
    !_hasFrom
  )
  const _fastFindUniqueSql = _canFastFindUnique
    ? (softDelete
        ? `SELECT * FROM "${tableName}" WHERE "${_pkField}" = ? AND "deletedAt" IS NULL LIMIT 2`
        : `SELECT * FROM "${tableName}" WHERE "${_pkField}" = ? LIMIT 2`)
    : null
  // External (@@external) tables may not exist at createClient time — preparing
  // a statement against them throws. Skip the fast path in that case; the
  // regular findUnique path will resolve at query time.
  let _fastFindUniqueStmt = null
  if (_fastFindUniqueSql) {
    try { _fastFindUniqueStmt = readDb.query(_fastFindUniqueSql) }
    catch { _fastFindUniqueStmt = null }
  }

  function buildSQL({ where, orderBy, limit, offset, parsedSelect, sdMode = 'live', distinct = false, windowSpec = null } = {}) {
    const params   = []

    // ── Ultra-fast path: no where, no order, no limit, live mode, no policy/filters ──
    if (_fastFindManySql && !where && !orderBy && limit == null && offset == null && sdMode === 'live' && !parsedSelect && !windowSpec && !distinct) {
      return { sql: _fastFindManySql, params }
    }

    // Merge global filter + plugin read filters + query where
    const globalFilter = _dynamicGlobalFilter ? _dynamicGlobalFilter(ctx) : _staticGlobalFilter
    const pluginFilters = plugins?.hasPlugins ? plugins.getReadFilters(modelName, ctx) : []
    const allFilters = globalFilter
      ? (pluginFilters.length ? [globalFilter, ...pluginFilters] : [globalFilter])
      : pluginFilters
    const mergedWhere = allFilters.length
      ? (where ? { AND: [...allFilters, where] } : allFilters.length === 1 ? allFilters[0] : { AND: allFilters })
      : where
    // Row-level policy filter — injected as raw SQL after mergedWhere
    const policyResult = ctx.hasPolicies ? buildPolicyFilter(modelName, 'read', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
    // Inject soft delete filter before building WHERE
    const effectiveWhere = softDelete
      ? injectSoftDeleteFilter(mergedWhere, sdMode)
      : mergedWhere
    // Build relation orderBy first so we know if JOINs will be present.
    // When JOINs are added, column refs in WHERE must be qualified with `t.`
    // to avoid ambiguous column errors (e.g. `id` exists on both joined tables).
    const { joinClauses, orderParts } = buildRelationOrderBy(orderBy, modelName, relationMap, _modelToTable)
    const hasJoins  = joinClauses.length > 0
    const whereAlias = hasJoins ? 't' : null
    const whereSql  = buildWhereWithEncryption(effectiveWhere, params, whereAlias)
    // When JOINs exist, buildRelationOrderBy returns the full ordered list
    // (flat + relation, flat prefixed with `t.`). Don't double-emit flat parts.
    const flatOrderSql = hasJoins ? '' : buildOrderBy(orderBy)
    const orderSql = [flatOrderSql, ...orderParts].filter(Boolean).join(', ')
    const sqlCols   = parsedSelect?.sqlCols ?? '*'
    const needsAlias = joinClauses.length > 0 || orderParts.length > 0
    const distinctKw = distinct ? 'DISTINCT ' : ''
    let basePart
    if (sqlCols === '*') {
      basePart = needsAlias
        ? `SELECT ${distinctKw}t.* FROM "${tableName}" t`
        : (distinct ? `SELECT DISTINCT * FROM "${tableName}"` : _baseSqlWithFrom)
    } else {
      const fromCols = parsedSelect?.requestedFrom?.size
        ? [...parsedSelect.requestedFrom].map(n => `${fromFields[n].subquerySql} AS "${n}"`).join(', ')
        : null
      const selectExpr = fromCols ? `${sqlCols}, ${fromCols}` : sqlCols
      basePart = needsAlias
        ? `SELECT ${distinctKw}${selectExpr} FROM "${tableName}" t`
        : (fromCols
            ? `SELECT ${distinctKw}${selectExpr} FROM "${tableName}"`
            : `SELECT ${distinctKw}${sqlCols} FROM "${tableName}"`)
    }
    // Splice relation JOINs between FROM and WHERE
    let sql = joinClauses.length
      ? `${basePart} ${joinClauses.join(' ')}`
      : basePart
    // Combine query WHERE with policy filter
    if (whereSql && policyResult)      sql += ` WHERE (${whereSql}) AND (${policyResult.sql})`
    else if (whereSql)                 sql += ` WHERE ${whereSql}`
    else if (policyResult)             sql += ` WHERE ${policyResult.sql}`
    if (policyResult) params.push(...policyResult.params)
    if (orderSql)       sql += ` ORDER BY ${orderSql}`
    if (limit  != null) sql += ` LIMIT ${Number(limit)}`
    if (offset != null) sql += ` OFFSET ${Number(offset)}`

    // ── Window functions ──────────────────────────────────────────────────
    // Inject as a wrapping subquery so LIMIT/OFFSET applies after window computation.
    // Without the wrap, LIMIT would reduce rows before RANK() etc. are evaluated.
    if (windowSpec) {
      const windowCols = buildWindowCols(windowSpec, params)
      if (windowCols.length) {
        if (limit == null && offset == null) {
          // No pagination — inline window functions directly in SELECT, no subquery needed.
          // This avoids materializing a full subquery when scanning the whole table.
          const windowExpr = windowCols.join(', ')
          const inlineSql = sql.replace(/^SELECT /, `SELECT ${windowExpr}, `)
          return { sql: inlineSql, params }
        }
        // With LIMIT/OFFSET: wrap in subquery so pagination applies AFTER window computation.
        // Without the wrap, LIMIT would reduce rows before RANK() etc. are evaluated.
        const innerSql = sql
          .replace(/ LIMIT \d+$/, '')
          .replace(/ LIMIT \d+ OFFSET \d+$/, '')
          .replace(/ OFFSET \d+$/, '')
        const outerSelect = `*, ${windowCols.join(', ')}`
        let outerSql = `SELECT ${outerSelect} FROM (${innerSql}) _w`
        if (orderSql)       outerSql += ` ORDER BY ${orderSql}`
        if (limit  != null) outerSql += ` LIMIT ${Number(limit)}`
        if (offset != null) outerSql += ` OFFSET ${Number(offset)}`
        return { sql: outerSql, params }
      }
    }

    return { sql, params }
  }

  // Pre-build fromSets for this table — passed to parseSelectArg
  const _fromSets = _hasFrom ? { [modelName]: new Set(Object.keys(fromFields)) } : null

  function parseArgs(select, include) {
    return parseSelectArg(select, modelName, relationMap, computedSets, include, _fromSets)
  }

  function withIncludes(rows, ps, rawInclude) {
    const include = ps ? { ...ps.relationSelects } : rawInclude
    if (include && Object.keys(include).length)
      resolveIncludes(readDb, rows, include, modelName, ctx)
    return rows
  }

  function finalise(rows, ps) {
    return ps ? trimAllToSelect(rows, ps.requestedFields, ps.injectedFKs) : rows
  }
  function finaliseOne(row, ps) {
    if (!ps || !row) return row
    return Object.fromEntries(
      Object.entries(row).filter(([k]) => ps.requestedFields.has(k) && !ps.injectedFKs.has(k))
    )
  }

  // Soft-delete mode from args
  function sdMode(args) {
    if (!softDelete) return 'live'
    if (args?.withDeleted) return 'withDeleted'
    if (args?.onlyDeleted) return 'onlyDeleted'
    return 'live'
  }

  // ── Nested writes ──────────────────────────────────────────────────────────
  // Split data into scalar fields and nested relation ops.
  //
  // Supported on create():
  //   belongsTo (this table holds the FK):
  //     { connect: { id } }                  — use existing parent, inject FK
  //     { create: { ...data } }              — create parent first, inject FK
  //     { connectOrCreate: { where, create } } — find or create parent
  //
  //   hasMany (child table holds the FK):
  //     { create: row | [rows] }             — create children with FK injected
  //     { connect: where | [wheres] }        — update children FK to this PK
  //
  // Supported on update():
  //   belongsTo: connect, create, connectOrCreate
  //   hasMany:   create, connect, disconnect, delete, update

  function extractNestedWrites(data) {
    if (!data) return { scalar: {}, nested: {} }
    const rels = relationMap[modelName] ?? {}
    const scalar = {}, nested = {}
    const OP_KEYS = new Set(['create','connect','connectOrCreate','disconnect','delete','update','set'])
    for (const [k, v] of Object.entries(data)) {
      // Nested write if: key is a known relation (any kind) AND value looks like an op object
      if (k in rels && v !== null && typeof v === 'object' && !Array.isArray(v)
          && Object.keys(v).some(op => OP_KEYS.has(op))) {
        nested[k] = v
      } else {
        scalar[k] = v
      }
    }
    return { scalar, nested }
  }

  // belongsTo ops — run BEFORE parent insert/update, return FK fields to inject
  async function processBelongsToNested(nested) {
    const extra = {}
    const rels = relationMap[modelName] ?? {}
    for (const [fieldName, ops] of Object.entries(nested)) {
      const rel = rels[fieldName]
      if (!rel || rel.kind !== 'belongsTo') continue
      // ctx.tables is keyed by accessor (camelCase singular), not model name.
      const tbl = ctx.tables?.[modelToAccessor(rel.targetModel)]
      if (!tbl) continue

      if (ops.connect) {
        const target = await tbl.findFirst({ where: ops.connect })
        if (!target) throw new Error(`Nested connect on "${fieldName}": no "${rel.targetModel}" record found`)
        extra[rel.foreignKey] = target[rel.referencedKey]
      } else if (ops.create) {
        const target = await tbl.create({ data: ops.create })
        extra[rel.foreignKey] = target[rel.referencedKey]
      } else if (ops.connectOrCreate) {
        const { where: coWhere, create: coCreate } = ops.connectOrCreate
        let target = await tbl.findFirst({ where: coWhere })
        if (!target) target = await tbl.create({ data: coCreate })
        extra[rel.foreignKey] = target[rel.referencedKey]
      }
    }
    return extra
  }

  // hasMany ops — run AFTER parent insert/update
  async function processHasManyNested(nested, parentPk) {
    const rels = relationMap[modelName] ?? {}
    for (const [fieldName, ops] of Object.entries(nested)) {
      const rel = rels[fieldName]
      if (!rel) continue
      // ctx.tables is keyed by accessor (camelCase singular), not model name.
      const tbl = ctx.tables?.[modelToAccessor(rel.targetModel)]
      if (!tbl) continue

      if (rel.kind === 'manyToMany') {
        // ── Implicit m2m ops — manipulate join table directly ──────────────
        const jt = rel.joinTable
        const sk = rel.selfKey    // join col for this model
        const tk = rel.targetKey  // join col for target model

        if (ops.create) {
          const rows = Array.isArray(ops.create) ? ops.create : [ops.create]
          for (const row of rows) {
            const created = await tbl.create({ data: row })
            writeDb.run(`INSERT OR IGNORE INTO "${jt}" ("${sk}", "${tk}") VALUES (?, ?)`, parentPk, created.id)
          }
        }
        if (ops.connect) {
          const wheres = Array.isArray(ops.connect) ? ops.connect : [ops.connect]
          for (const where of wheres) {
            const target = await tbl.findFirst({ where })
            if (!target) throw new Error(`m2m connect on "${fieldName}": no "${rel.targetModel}" found`)
            writeDb.run(`INSERT OR IGNORE INTO "${jt}" ("${sk}", "${tk}") VALUES (?, ?)`, parentPk, target.id)
          }
        }
        if (ops.disconnect) {
          const wheres = Array.isArray(ops.disconnect) ? ops.disconnect : [ops.disconnect]
          for (const where of wheres) {
            const target = await tbl.findFirst({ where })
            if (!target) continue
            writeDb.run(`DELETE FROM "${jt}" WHERE "${sk}" = ? AND "${tk}" = ?`, parentPk, target.id)
          }
        }
        if (ops.delete) {
          const wheres = Array.isArray(ops.delete) ? ops.delete : [ops.delete]
          for (const where of wheres) {
            const target = await tbl.findFirst({ where })
            if (!target) continue
            writeDb.run(`DELETE FROM "${jt}" WHERE "${sk}" = ? AND "${tk}" = ?`, parentPk, target.id)
            await tbl.delete({ where: { id: target.id } })
          }
        }
        if (ops.set) {
          // Replace entire relation — DELETE all join rows, INSERT new ones
          writeDb.run(`DELETE FROM "${jt}" WHERE "${sk}" = ?`, parentPk)
          const wheres = Array.isArray(ops.set) ? ops.set : [ops.set]
          for (const where of wheres) {
            const target = await tbl.findFirst({ where })
            if (!target) throw new Error(`m2m set on "${fieldName}": no "${rel.targetModel}" found matching ${JSON.stringify(where)}`)
            writeDb.run(`INSERT OR IGNORE INTO "${jt}" ("${sk}", "${tk}") VALUES (?, ?)`, parentPk, target.id)
          }
        }
        continue
      }

      // ── Standard hasMany ops ───────────────────────────────────────────────
      if (rel.kind !== 'hasMany') continue
      const fk = { [rel.foreignKey]: parentPk }

      if (ops.create) {
        const rows = Array.isArray(ops.create) ? ops.create : [ops.create]
        for (const row of rows) await tbl.create({ data: { ...row, ...fk } })
      }
      if (ops.connect) {
        const wheres = Array.isArray(ops.connect) ? ops.connect : [ops.connect]
        for (const where of wheres) await tbl.update({ where, data: fk })
      }
      if (ops.disconnect) {
        const wheres = Array.isArray(ops.disconnect) ? ops.disconnect : [ops.disconnect]
        for (const where of wheres) await tbl.update({ where, data: { [rel.foreignKey]: null } })
      }
      if (ops.delete) {
        const wheres = Array.isArray(ops.delete) ? ops.delete : [ops.delete]
        for (const where of wheres) await tbl.delete({ where })
      }
      if (ops.update) {
        const updates = Array.isArray(ops.update) ? ops.update : [ops.update]
        for (const { where, data } of updates) await tbl.update({ where, data })
      }
    }
  }

  return {

    // ── findMany ────────────────────────────────────────────────────────────
    async findMany(args = {}) {
      // ── Recursive CTE path ───────────────────────────────────────────────
      if (args.recursive) {
        const rec = args.recursive === true
          ? { direction: 'descendants' }
          : { direction: 'descendants', ...args.recursive }

        const selfRels = ctx.selfRelationMap?.[modelName]
        if (!selfRels?.length)
          throw new Error(`findMany({ recursive }) — model '${tableName}' has no self-referential relation`)

        // Resolve which self-relation(s) to traverse
        let relsToUse = selfRels
        if (rec.via) {
          const found = selfRels.find(r => r.relationField === rec.via || r.fkField === rec.via)
          if (!found) throw new Error(`findMany({ recursive }) — 'via: "${rec.via}"' not found on model '${tableName}'`)
          relsToUse = [found]
        }

        const multiRel = relsToUse.length > 1

        // Run one CTE per self-relation and union results
        const allRows = []
        for (const rel of relsToUse) {
          const { fkField, referencedField } = rel

          // Build anchor WHERE (same filters as normal findMany)
          const anchorParams = []
          const anchorWhere  = args.where
          const sdFilteredWhere = softDelete ? injectSoftDeleteFilter(anchorWhere, 'live') : anchorWhere
          const anchorSql    = buildWhereWithEncryption(sdFilteredWhere, anchorParams)
          const policyResult = ctx.hasPolicies ? buildPolicyFilter(modelName, 'read', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null

          let anchorFilter = anchorSql ?? ''
          if (policyResult) {
            anchorFilter = anchorFilter ? `(${anchorFilter}) AND (${policyResult.sql})` : policyResult.sql
            anchorParams.push(...policyResult.params)
          }

          const maxDepth = rec.maxDepth ?? 1000

          let cteSql, cteParams

          if (rec.direction === 'descendants') {
            // Start at anchor nodes, walk down via fkField → referencedField
            cteSql = `
WITH RECURSIVE _tree("${referencedField}", _depth) AS (
  SELECT "${referencedField}", 0 FROM "${tableName}"
  ${anchorFilter ? `WHERE ${anchorFilter}` : ''}
  UNION ALL
  SELECT c."${referencedField}", t._depth + 1
  FROM "${tableName}" c
  JOIN _tree t ON c."${fkField}" = t."${referencedField}"
  WHERE t._depth < ${maxDepth}
)
SELECT "${tableName}".*, _tree._depth
FROM "${tableName}"
JOIN _tree ON "${tableName}"."${referencedField}" = _tree."${referencedField}"
WHERE _tree._depth > 0`
            cteParams = [...anchorParams]
          } else {
            // ancestors — start at anchor, walk up via referencedField → fkField
            cteSql = `
WITH RECURSIVE _tree("${fkField}", _depth) AS (
  SELECT "${fkField}", 1 FROM "${tableName}"
  ${anchorFilter ? `WHERE ${anchorFilter}` : ''}
  UNION ALL
  SELECT c."${fkField}", t._depth + 1
  FROM "${tableName}" c
  JOIN _tree t ON c."${referencedField}" = t."${fkField}"
  WHERE t._depth < ${maxDepth} AND t."${fkField}" IS NOT NULL
)
SELECT "${tableName}".*, _tree._depth
FROM "${tableName}"
JOIN _tree ON "${tableName}"."${referencedField}" = _tree."${fkField}"
WHERE _tree."${fkField}" IS NOT NULL`
            cteParams = [...anchorParams]
          }

          // Apply orderBy / limit / offset to the outer query
          if (args.orderBy) {
            const orderParts = []
            const ob = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]
            for (const o of ob) {
              for (const [k, v] of Object.entries(o)) {
                if (k === '_depth') orderParts.push(`_tree._depth ${v === 'desc' ? 'DESC' : 'ASC'}`)
                else orderParts.push(`"${tableName}"."${k}" ${v === 'desc' ? 'DESC' : 'ASC'}`)
              }
            }
            if (orderParts.length) cteSql += ` ORDER BY ${orderParts.join(', ')}`
          }
          if (args.limit  != null) cteSql += ` LIMIT ${Number(args.limit)}`
          if (args.offset != null) cteSql += ` OFFSET ${Number(args.offset)}`

          const raw = readAll(readDb.query(cteSql.trim()).all(...cteParams), { mode: 'list' })
          fireQuery({ operation: 'findMany', args, sql: cteSql, params: cteParams, duration: 0, rowCount: raw.length })

          // Inject _depth and optionally _via
          for (const row of raw) {
            row._depth = row._depth ?? 0
            if (multiRel) row._via = rel.fkField
          }
          allRows.push(...raw)
        }

        // Deduplicate by referencedField when multi-relation union
        const idField = relsToUse[0].referencedField
        const seen = new Set()
        const deduped = multiRel
          ? allRows.filter(r => { const k = `${r[idField]}:${r._via}`; if (seen.has(k)) return false; seen.add(k); return true })
          : allRows

        if (!rec.nested) return deduped

        // Build nested tree structure
        const idKey = relsToUse[0].referencedField
        const fkKey = relsToUse[0].fkField
        const anchorIds = new Set()
        // Get anchor node IDs from a quick findMany
        const anchors = await this.findMany({ ...args, recursive: undefined })
        for (const a of anchors) anchorIds.add(a[idKey])

        const byId = {}
        for (const row of deduped) { byId[row[idKey]] = { ...row, children: [] } }
        const roots = []
        for (const row of deduped) {
          const parent = byId[row[fkKey]]
          if (parent && !anchorIds.has(row[idKey])) parent.children.push(byId[row[idKey]])
          else if (anchorIds.has(row[fkKey]) || !parent) roots.push(byId[row[idKey]])
        }
        return roots
      }

      // ── Inline fast path: findMany() / findMany({}) with no plugins/hooks/logging ──
      if (_fastStmt && !args.where && !args.orderBy && !args.limit && !args.offset && !args.select && !args.include && !args.withDeleted && !args.onlyDeleted && !args.window && !args.distinct && !plugins?.hasPlugins && !hookRunner && !tableHasAnyLog) {
        const _needsTiming = ctx.onQuery || ctx._queryListeners.size
        const _t0 = _needsTiming ? performance.now() : 0
        const rows = readAll(_fastStmt.all(), { mode: 'list' })
        if (_needsTiming) fireQuery({ operation: 'findMany', args, sql: _fastFindManySql, params: [], duration: performance.now() - _t0, rowCount: rows.length })
        return rows
      }
      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
      const hctx = hookRunner ? { model: modelName, operation: 'findMany', args, schema: ctx.models[modelName] } : null
      if (hctx && hookRunner.hasBefore('findMany')) hookRunner.runBefore(hctx, ctx)
      const { where, include, orderBy, limit, offset, select, distinct } = hctx ? hctx.args : args
      const windowSpec      = args.window ?? null
      const mode            = sdMode(hctx ? hctx.args : args)
      const ps              = parseArgs(select, include)
      const { sql, params } = buildSQL({ where, orderBy, limit, offset, parsedSelect: ps, sdMode: mode, distinct: distinct === true, windowSpec })
      const _nt = needsTiming()
      const _fmT0 = _nt ? performance.now() : 0
      let rows              = readAll(readDb.query(sql).all(...params), { mode: 'list', selectedFields: ps?.requestedFields })
      if (_nt) fireQuery({ operation: 'findMany', args, sql, params, duration: _nt ? performance.now() - _fmT0 : 0, rowCount: rows.length })
      withIncludes(rows, ps, include)
      rows = finalise(rows, ps)
      if (plugins?.hasPlugins) await plugins.afterRead(modelName, rows, ctx, { select })
      if (hctx && hookRunner.hasAfter('findMany')) { hctx.result = rows; hookRunner.runAfter(hctx, ctx); rows = hctx.result }
      if (tableHasAnyLog && rows.length > 0) emitLogs('read', rows)
      return rows
    },

    // ── findFirst ───────────────────────────────────────────────────────────
    async findFirst(args = {}) {
      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
      const hctx = hookRunner ? { model: modelName, operation: 'findFirst', args, schema: ctx.models[modelName] } : null
      if (hctx && hookRunner.hasBefore('findFirst')) hookRunner.runBefore(hctx, ctx)
      const { where, include, orderBy, select } = hctx ? hctx.args : args
      const mode            = sdMode(hctx ? hctx.args : args)
      const ps              = parseArgs(select, include)
      const { sql, params } = buildSQL({ where, orderBy, limit: 1, parsedSelect: ps, sdMode: mode })
      const _nt = needsTiming()
      const _ffT0 = _nt ? performance.now() : 0
      let row               = read(readDb.query(sql).get(...params), { mode: 'list', selectedFields: ps?.requestedFields })
      if (_nt) fireQuery({ operation: 'findFirst', args, sql, params, duration: _nt ? performance.now() - _ffT0 : 0, rowCount: row ? 1 : 0 })
      if (row) { withIncludes([row], ps, include); row = finaliseOne(row, ps) }
      else row = null
      if (plugins?.hasPlugins && row) await plugins.afterRead(modelName, [row], ctx, { select })
      if (hctx && hookRunner.hasAfter('findFirst')) { hctx.result = row; hookRunner.runAfter(hctx, ctx); row = hctx.result }
      // ── Logging ──────────────────────────────────────────────────────────────
      if (tableHasAnyLog && row) emitLogs('read', [row])
      return row
    },

    // ── findUnique ──────────────────────────────────────────────────────────
    async findUnique(args = {}) {
      // ── Ultra-fast path: findUnique({ where: { <pk>: value } }) ──
      // Skip buildSQL, parseArgs, soft-delete filter assembly entirely.
      // Bypass conditions are pre-checked at table-build time (_canFastFindUnique).
      if (_fastFindUniqueStmt) {
        const w = args.where
        if (w && !args.include && !args.select && !args.withDeleted && !args.onlyDeleted) {
          // Single-key object pointing at the PK with a scalar value
          const keys = Object.keys(w)
          if (keys.length === 1 && keys[0] === _pkField) {
            const v = w[_pkField]
            if (v !== null && (typeof v !== 'object' || v instanceof Date)) {
              const _nt = needsTiming()
              const _t0 = _nt ? performance.now() : 0
              const rows = readAll(_fastFindUniqueStmt.all(v), { mode: 'single' })
              if (_nt) fireQuery({ operation: 'findUnique', args, sql: _fastFindUniqueSql, params: [v], duration: _nt ? performance.now() - _t0 : 0, rowCount: rows.length })
              if (rows.length > 1) throw new Error(`findUnique on "${tableName}" returned more than one row`)
              return rows[0] ?? null
            }
          }
        }
      }

      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
      const { where, include, select } = args
      const mode            = sdMode(args)
      const ps              = parseArgs(select, include)
      const { sql, params } = buildSQL({ where, limit: 2, parsedSelect: ps, sdMode: mode })
      const _nt = needsTiming()
      const _fuT0 = _nt ? performance.now() : 0
      const rows            = readAll(readDb.query(sql).all(...params), { mode: 'single', selectedFields: ps?.requestedFields })
      if (_nt) fireQuery({ operation: 'findUnique', args, sql, params, duration: _nt ? performance.now() - _fuT0 : 0, rowCount: rows.length })
      if (rows.length > 1) throw new Error(`findUnique on "${tableName}" returned more than one row`)
      const row = rows[0] ?? null
      if (row) { withIncludes([row], ps, include); return finaliseOne(row, ps) }
      return null
    },


    // ── findFirstOrThrow ─────────────────────────────────────────────────────
    // Like findFirst but throws NotFoundError if no row matches.
    async findFirstOrThrow(args = {}) {
      const row = await this.findFirst(args)
      if (!row) throw Object.assign(
        new Error(`No "${tableName}" record found matching the given where clause`),
        { code: 'NOT_FOUND', model: tableName }
      )
      return row
    },

    // ── findUniqueOrThrow ────────────────────────────────────────────────────
    // Like findUnique but throws NotFoundError if no row matches.
    async findUniqueOrThrow(args = {}) {
      const row = await this.findUnique(args)
      if (!row) throw Object.assign(
        new Error(`No "${tableName}" record found matching the given where clause`),
        { code: 'NOT_FOUND', model: tableName }
      )
      return row
    },

    // ── count ───────────────────────────────────────────────────────────────
    async count(args = {}) {
      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
      const hctx = hookRunner ? { model: modelName, operation: 'count', args, schema: ctx.models[modelName] } : null
      if (hctx && hookRunner.hasBefore('count')) hookRunner.runBefore(hctx, ctx)
      const { where } = hctx ? hctx.args : args
      const mode      = sdMode(hctx ? hctx.args : args)
      const params    = []
      // Merge global filter + plugin read filters + policy filter (same as buildSQL does)
      const rawFilter    = globalFilters[accessor]
      const globalFilter = typeof rawFilter === 'function' ? rawFilter(ctx) : rawFilter
      const pluginFilters = plugins?.hasPlugins ? plugins.getReadFilters(modelName, ctx) : []
      const allFilters   = [globalFilter, ...pluginFilters].filter(Boolean)
      const mergedWhere  = allFilters.length
        ? (where ? { AND: [...allFilters, where] } : allFilters.length === 1 ? allFilters[0] : { AND: allFilters })
        : where
      const effectiveWhere = softDelete ? injectSoftDeleteFilter(mergedWhere, mode) : mergedWhere
      const whereSql  = buildWhereWithEncryption(effectiveWhere, params)
      // Policy filter for count
      const countPolicy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'read', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
      let   sql       = `SELECT COUNT(*) as n FROM "${tableName}"`
      if (whereSql && countPolicy) sql += ` WHERE (${whereSql}) AND (${countPolicy.sql})`
      else if (whereSql)           sql += ` WHERE ${whereSql}`
      else if (countPolicy)        sql += ` WHERE ${countPolicy.sql}`
      if (countPolicy) params.push(...countPolicy.params)
      const _nt = needsTiming()
      const _cT0 = _nt ? performance.now() : 0
      let result = readDb.query(sql).get(...params).n
      if (_nt) fireQuery({ operation: 'count', args, sql, params, duration: _nt ? performance.now() - _cT0 : 0, rowCount: result })
      if (hctx && hookRunner.hasAfter('count')) { hctx.result = result; hookRunner.runAfter(hctx, ctx); result = hctx.result }
      return result
    },

    // ── exists ───────────────────────────────────────────────────────────────
    // Returns true if at least one row matches the where clause, false otherwise.
    // Uses SELECT 1 ... LIMIT 1 — SQLite short-circuits on the first matching row,
    // making this faster than count() when you only need a boolean.
    //
    // db.users.exists({ where: { email: 'alice@example.com' } })
    // → true | false
    async exists(args = {}) {
      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
      const hctx = hookRunner ? { model: modelName, operation: 'exists', args, schema: ctx.models[modelName] } : null
      if (hctx && hookRunner.hasBefore('exists')) hookRunner.runBefore(hctx, ctx)
      const { where } = hctx ? hctx.args : args
      const mode      = sdMode(hctx ? hctx.args : args)
      const params    = []
      const rawFilter    = globalFilters[accessor]
      const globalFilter = typeof rawFilter === 'function' ? rawFilter(ctx) : rawFilter
      const pluginFilters = plugins?.hasPlugins ? plugins.getReadFilters(modelName, ctx) : []
      const allFilters   = [globalFilter, ...pluginFilters].filter(Boolean)
      const mergedWhere  = allFilters.length
        ? (where ? { AND: [...allFilters, where] } : allFilters.length === 1 ? allFilters[0] : { AND: allFilters })
        : where
      const effectiveWhere = softDelete ? injectSoftDeleteFilter(mergedWhere, mode) : mergedWhere
      const whereSql  = buildWhereWithEncryption(effectiveWhere, params)
      const existsPolicy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'read', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
      let   sql       = `SELECT 1 as _e FROM "${tableName}"`
      if (whereSql && existsPolicy) sql += ` WHERE (${whereSql}) AND (${existsPolicy.sql})`
      else if (whereSql)            sql += ` WHERE ${whereSql}`
      else if (existsPolicy)        sql += ` WHERE ${existsPolicy.sql}`
      if (existsPolicy) params.push(...existsPolicy.params)
      sql += ` LIMIT 1`
      const _nt = needsTiming()
      const _eT0 = _nt ? performance.now() : 0
      let result = readDb.query(sql).get(...params) !== null
      if (_nt) fireQuery({ operation: 'exists', args, sql, params, duration: _nt ? performance.now() - _eT0 : 0, rowCount: result ? 1 : 0 })
      if (hctx && hookRunner.hasAfter('exists')) { hctx.result = result; hookRunner.runAfter(hctx, ctx); result = hctx.result }
      return result
    },

    // ── findManyAndCount ─────────────────────────────────────────────────────
    // Returns { rows, total } in one call — same WHERE applied to both.
    // total = count ignoring limit/offset (for pagination UI).
    // Guaranteed consistent: both queries share identical WHERE/policy/filter context.
    //
    // db.users.findManyAndCount({ where, orderBy, limit, offset, select, include })
    // → { rows: [...], total: 42 }
    async findManyAndCount(args = {}) {
      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
      const hctx = hookRunner ? { model: modelName, operation: 'findMany', args, schema: ctx.models[modelName] } : null
      if (hctx && hookRunner.hasBefore('findMany')) hookRunner.runBefore(hctx, ctx)
      const { where, include, orderBy, limit, offset, select, distinct } = hctx ? hctx.args : args
      const mode = sdMode(hctx ? hctx.args : args)
      const ps   = parseArgs(select, include)

      // ── rows query (with limit/offset) ──────────────────────────────────
      const { sql, params } = buildSQL({ where, orderBy, limit, offset, parsedSelect: ps, sdMode: mode, distinct: distinct === true })
      const _t0 = performance.now()
      let rows = readAll(readDb.query(sql).all(...params), { mode: 'list', selectedFields: ps?.requestedFields })
      fireQuery({ operation: 'findMany', args, sql, params, duration: performance.now() - _t0, rowCount: rows.length })
      withIncludes(rows, ps, include)
      rows = finalise(rows, ps)

      // ── count query (same WHERE, no limit/offset) ─────────────────────
      const countParams = []
      const globalFilter = _dynamicGlobalFilter ? _dynamicGlobalFilter(ctx) : _staticGlobalFilter
      const pluginFilters = plugins?.hasPlugins ? plugins.getReadFilters(modelName, ctx) : []
      const allFilters = globalFilter ? [globalFilter, ...pluginFilters] : pluginFilters
      const mergedWhere = allFilters.length
        ? (where ? { AND: [...allFilters, where] } : allFilters.length === 1 ? allFilters[0] : { AND: allFilters })
        : where
      const effectiveWhere = softDelete ? injectSoftDeleteFilter(mergedWhere, mode) : mergedWhere
      const whereSql = buildWhereWithEncryption(effectiveWhere, countParams)
      const policyResult = ctx.hasPolicies ? buildPolicyFilter(modelName, 'read', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
      let countSql = `SELECT COUNT(*) as n FROM "${tableName}"`
      if (whereSql && policyResult) countSql += ` WHERE (${whereSql}) AND (${policyResult.sql})`
      else if (whereSql)            countSql += ` WHERE ${whereSql}`
      else if (policyResult)        countSql += ` WHERE ${policyResult.sql}`
      if (policyResult) countParams.push(...policyResult.params)
      const total = readDb.query(countSql).get(...countParams).n

      if (plugins?.hasPlugins) await plugins.afterRead(modelName, rows, ctx, { select })
      if (hctx && hookRunner.hasAfter('findMany')) { hctx.result = rows; hookRunner.runAfter(hctx, ctx); rows = hctx.result }
      if (tableHasAnyLog && rows.length > 0) emitLogs('read', rows)

      return { rows, total }
    },

    // ── query — unified dispatcher ────────────────────────────────────────────
    // Routes a single args object to findMany(), groupBy(), or aggregate()
    // based on the shape of the args. Designed for API layers that receive
    // query descriptors from untrusted input (e.g. req.query).
    //
    // Routing rules:
    //   args.by                                  → groupBy(args)
    //   args._count / _sum / _avg / _min / _max
    //     / _stringAgg / named aggs, no 'by'    → aggregate(args)
    //   everything else                          → findMany(args)
    //
    // Examples:
    //   db.orders.query({ where: { status: 'paid' }, limit: 20 })
    //   db.orders.query({ by: ['status'], _count: true })
    //   db.orders.query({ _count: true, _sum: { amount: true } })
    //   db.orders.query({ window: { rn: { rowNumber: true, orderBy: { id: 'asc' } } } })
    async query(args = {}) {
      if (args.by) {
        return this.groupBy(args)
      }
      const AGG_KEYS = ['_count', '_sum', '_avg', '_min', '_max', '_stringAgg']
      const hasAgg = AGG_KEYS.some(k => k in args)
        || Object.keys(args).some(k => isNamedAgg(k, args[k]))
      if (hasAgg) {
        return this.aggregate(args)
      }
      return this.findMany(args)
    },

    // ── aggregate ────────────────────────────────────────────────────────────
    // db.orders.aggregate({ _sum: { amount: true }, _avg: { amount: true }, _count: true, _min: { amount: true }, _max: { amount: true }, where: {...} })
    // Returns: { _sum: { amount: 1200 }, _avg: { amount: 40 }, _count: 30, _min: { amount: 5 }, _max: { amount: 200 } }
    async aggregate(args = {}) {
      const { where, _count, _sum, _avg, _min, _max, _stringAgg } = args
      const params = []

      // Build WHERE (reuses count() pattern)
      const rawFilter    = _dynamicGlobalFilter ? _dynamicGlobalFilter(ctx) : _staticGlobalFilter
      const pluginFilters = plugins?.hasPlugins ? plugins.getReadFilters(modelName, ctx) : []
      const allFilters   = rawFilter ? [rawFilter, ...pluginFilters] : pluginFilters
      const mergedWhere  = allFilters.length
        ? (where ? { AND: [...allFilters, where] } : allFilters.length === 1 ? allFilters[0] : { AND: allFilters })
        : where
      const effectiveWhere = softDelete ? injectSoftDeleteFilter(mergedWhere, 'live') : mergedWhere
      const whereSql = buildWhereWithEncryption(effectiveWhere, params)
      const policyResult = ctx.hasPolicies ? buildPolicyFilter(modelName, 'read', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null

      // Build SELECT columns
      const selects = []
      if (_count) {
        // _count: true → COUNT(*)
        // _count: { distinct: 'field' } → COUNT(DISTINCT "field")
        if (typeof _count === 'object' && _count.distinct) {
          selects.push(`COUNT(DISTINCT "${_count.distinct}") AS "__count"`)
        } else {
          selects.push(`COUNT(*) AS "__count"`)
        }
      }
      for (const agg of ['_sum', '_avg', '_min', '_max']) {
        const spec = args[agg]
        if (!spec || spec === true) continue
        const fn = { _sum: 'SUM', _avg: 'AVG', _min: 'MIN', _max: 'MAX' }[agg]
        for (const [field, wanted] of Object.entries(spec)) {
          if (!wanted) continue
          selects.push(`${fn}("${field}") AS "${agg}__${field}"`)
        }
      }
      // _stringAgg: { field: 'name', separator: ', ', orderBy: 'name' }
      if (_stringAgg) {
        const { field, separator = ',', orderBy: saOrderBy } = _stringAgg
        if (!field) throw new Error('aggregate() _stringAgg requires a field')
        // SQLite syntax: GROUP_CONCAT(col, separator ORDER BY ...) — separator
        // MUST precede ORDER BY. Putting ORDER BY before the separator silently
        // causes the separator to be ignored and the default "," is used.
        const orderClause = saOrderBy ? ` ORDER BY "${saOrderBy}"` : ''
        selects.push(`GROUP_CONCAT("${field}", ?${orderClause}) AS "__stringAgg__${field}"`)
        params.push(separator)
      }

      // Named aggregates: any _-prefixed key with { count/sum/avg/min/max, filter? }
      const namedAggs = extractNamedAggs(args).filter(([k]) =>
        !['_count','_sum','_avg','_min','_max','_stringAgg'].includes(k)
      )
      for (const [key, spec] of namedAggs) {
        selects.push(buildNamedAggExpr(key, spec, params))
      }

      if (!selects.length) throw new Error('aggregate() requires at least one aggregation (_count, _sum, _avg, _min, _max, _stringAgg, or a named aggregate)')

      let sql = `SELECT ${selects.join(', ')} FROM "${tableName}"`
      if (whereSql && policyResult) sql += ` WHERE (${whereSql}) AND (${policyResult.sql})`
      else if (whereSql)            sql += ` WHERE ${whereSql}`
      else if (policyResult)        sql += ` WHERE ${policyResult.sql}`
      if (policyResult) params.push(...policyResult.params)

      const _t0 = performance.now()
      const raw = readDb.query(sql).get(...params) ?? {}
      fireQuery({ operation: 'aggregate', args, sql, params, duration: performance.now() - _t0, rowCount: 1 })

      // Shape result
      const result = {}
      if (_count)      result._count = raw.__count ?? 0
      for (const agg of ['_sum', '_avg', '_min', '_max']) {
        const spec = args[agg]
        if (!spec || spec === true) continue
        result[agg] = {}
        for (const [field, wanted] of Object.entries(spec)) {
          if (!wanted) continue
          result[agg][field] = raw[`${agg}__${field}`] ?? null
        }
      }
      if (_stringAgg) {
        result._stringAgg = { [_stringAgg.field]: raw[`__stringAgg__${_stringAgg.field}`] ?? null }
      }
      // Named aggregates
      for (const [key] of namedAggs) {
        result[key] = raw[`__nagg__${key}`] ?? null
      }
      return result
    },

    // ── groupBy ──────────────────────────────────────────────────────────────
    // db.orders.groupBy({ by: ['status'], _count: true, _sum: { amount: true }, where: {...}, having: {...}, orderBy: {...}, limit, offset })
    // Returns: [{ status: 'paid', _count: 10, _sum: { amount: 500 } }, ...]
    async groupBy(args = {}) {
      const { by, where, having, orderBy, limit, offset, _count, _sum, _avg, _min, _max, _stringAgg, fillGaps } = args
      const interval = args.interval   // { fieldName: 'unit' }
      if (!by?.length) throw new Error('groupBy() requires a "by" array of field names')

      // ── Interval / date truncation ───────────────────────────────────────
      // interval: { createdAt: 'month' }
      // Only one interval field supported per query.
      let intervalField = null, intervalUnit = null
      if (interval) {
        const entries = Object.entries(interval)
        if (entries.length !== 1)
          throw new Error('groupBy() interval only supports one field at a time')
        ;[intervalField, intervalUnit] = entries[0]

        // Validate unit
        const VALID_UNITS = ['year', 'quarter', 'month', 'week', 'day', 'hour']
        if (!VALID_UNITS.includes(intervalUnit))
          throw new Error(`groupBy() interval unit '${intervalUnit}' is invalid. Use: ${VALID_UNITS.join(', ')}`)

        // Validate field is DateTime on the model
        const modelDef = ctx.models[modelName]
        const intervalFieldDef = modelDef?.fields.find(f => f.name === intervalField)
        if (intervalFieldDef && intervalFieldDef.type.name !== 'DateTime' && intervalFieldDef.type.name !== 'Text')
          throw new Error(`groupBy() interval field '${intervalField}' must be a DateTime field, got '${intervalFieldDef.type.name}'`)
      }

      // Build STRFTIME expression for a given field + unit
      function strftimeExpr(field, unit) {
        const col = `"${tableName}"."${field}"`
        switch (unit) {
          case 'year':    return `STRFTIME('%Y', ${col})`
          case 'quarter': return `STRFTIME('%Y', ${col}) || '-Q' || (((CAST(STRFTIME('%m', ${col}) AS INTEGER) - 1) / 3) + 1)`
          case 'month':   return `STRFTIME('%Y-%m', ${col})`
          case 'week':    return `STRFTIME('%Y-W%W', ${col})`
          case 'day':     return `STRFTIME('%Y-%m-%d', ${col})`
          case 'hour':    return `STRFTIME('%Y-%m-%dT%H', ${col})`
        }
      }

      // CTE step for gap-filling: advance by one interval unit
      function cteStep(unit) {
        switch (unit) {
          case 'year':    return '+1 year'
          case 'quarter': return '+3 months'
          case 'month':   return '+1 month'
          case 'week':    return '+7 days'
          case 'day':     return '+1 day'
          case 'hour':    return '+1 hour'
        }
      }

      // CTE date format for comparison with STRFTIME output
      function cteDateFormat(unit) {
        switch (unit) {
          case 'year':    return '%Y'
          case 'quarter': return null   // special case handled below
          case 'month':   return '%Y-%m'
          case 'week':    return '%Y-W%W'
          case 'day':     return '%Y-%m-%d'
          case 'hour':    return '%Y-%m-%dT%H'
        }
      }

      const params = []

      // WHERE clause
      const rawFilter    = _dynamicGlobalFilter ? _dynamicGlobalFilter(ctx) : _staticGlobalFilter
      const pluginFilters = plugins?.hasPlugins ? plugins.getReadFilters(modelName, ctx) : []
      const allFilters   = rawFilter ? [rawFilter, ...pluginFilters] : pluginFilters
      const mergedWhere  = allFilters.length
        ? (where ? { AND: [...allFilters, where] } : allFilters.length === 1 ? allFilters[0] : { AND: allFilters })
        : where
      const effectiveWhere = softDelete ? injectSoftDeleteFilter(mergedWhere, 'live') : mergedWhere
      const whereSql = buildWhereWithEncryption(effectiveWhere, params)
      const policyResult = ctx.hasPolicies ? buildPolicyFilter(modelName, 'read', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null

      // ── SELECT columns ───────────────────────────────────────────────────
      const groupByCols = []   // SQL expressions for GROUP BY
      const selectCols  = []   // SQL expressions for SELECT

      for (const f of by) {
        if (f === intervalField) {
          const expr = strftimeExpr(intervalField, intervalUnit)
          selectCols.push(`${expr} AS "${intervalField}"`)
          groupByCols.push(expr)
        } else {
          selectCols.push(`"${tableName}"."${f}"`)
          groupByCols.push(`"${tableName}"."${f}"`)
        }
      }

      if (_count) {
        if (typeof _count === 'object' && _count.distinct) {
          selectCols.push(`COUNT(DISTINCT "${_count.distinct}") AS "__count"`)
        } else {
          selectCols.push(`COUNT(*) AS "__count"`)
        }
      }
      for (const agg of ['_sum', '_avg', '_min', '_max']) {
        const spec = args[agg]
        if (!spec || spec === true) continue
        const fn = { _sum: 'SUM', _avg: 'AVG', _min: 'MIN', _max: 'MAX' }[agg]
        for (const [field, wanted] of Object.entries(spec)) {
          if (!wanted) continue
          selectCols.push(`${fn}("${field}") AS "${agg}__${field}"`)
        }
      }
      if (_stringAgg) {
        const { field, separator = ',', orderBy: saOrderBy } = _stringAgg
        if (!field) throw new Error('groupBy() _stringAgg requires a field')
        // SQLite: separator must come before ORDER BY in GROUP_CONCAT.
        const orderClause = saOrderBy ? ` ORDER BY "${saOrderBy}"` : ''
        selectCols.push(`GROUP_CONCAT("${field}", ?${orderClause}) AS "__stringAgg__${field}"`)
        params.push(separator)
      }

      // Named aggregates
      const namedAggs = extractNamedAggs(args).filter(([k]) =>
        !['_count','_sum','_avg','_min','_max','_stringAgg'].includes(k)
      )
      for (const [key, spec] of namedAggs) {
        selectCols.push(buildNamedAggExpr(key, spec, params))
      }

      // ── Gap filling — infer range from where clause if fillGaps: true ───
      // fillGaps: true        → infer from where[intervalField].gte/lte
      // fillGaps: false       → disable (even if interval is set)
      // fillGaps: { start, end } → explicit range
      // default when interval present → true (infer)
      let gapStart = null, gapEnd = null
      const shouldFill = interval && fillGaps !== false

      if (shouldFill) {
        if (fillGaps && typeof fillGaps === 'object' && fillGaps.start && fillGaps.end) {
          // Explicit range
          gapStart = fillGaps.start
          gapEnd   = fillGaps.end
        } else {
          // Infer from where clause — look for where[intervalField].gte/.gt and .lte/.lt
          const fieldWhere = where?.[intervalField]
          if (fieldWhere && typeof fieldWhere === 'object') {
            gapStart = fieldWhere.gte ?? fieldWhere.gt ?? null
            gapEnd   = fieldWhere.lte ?? fieldWhere.lt ?? null
          }
          // No range found — fall back to sparse (no gap fill)
          if (!gapStart || !gapEnd) {
            gapStart = null; gapEnd = null
          }
        }
      }

      // ── Build SQL ────────────────────────────────────────────────────────
      let sql

      if (gapStart && gapEnd && intervalField) {
        // Gap-fill path: recursive CTE generates all intervals, LEFT JOIN data
        const step   = cteStep(intervalUnit)
        const fmt    = cteDateFormat(intervalUnit)

        // CTE generates one row per interval between gapStart and gapEnd
        // For quarter, we generate dates and format them the same way as STRFTIME expr
        const cteLabel = intervalUnit === 'quarter'
          ? `STRFTIME('%Y', d) || '-Q' || (((CAST(STRFTIME('%m', d) AS INTEGER) - 1) / 3) + 1)`
          : `STRFTIME('${fmt}', d)`

        // Gap rows: SELECT from intervals LEFT JOIN, emit cteLabel for the interval field
        // Data rows: SELECT from main table with strftimeExpr — same as non-gap path
        // We need two separate SELECT column lists:
        //   gapCols: uses cteLabel (references intervals.d)
        //   dataCols: uses strftimeExpr (references tableName.intervalField)

        const otherByFields = by.filter(f => f !== intervalField)

        // Gap row columns
        const gapCols = [
          `${cteLabel} AS "${intervalField}"`,
          ...otherByFields.map(f => `NULL AS "${f}"`),
          ...(_count ? [`0 AS "__count"`] : []),
          ...['_sum', '_avg', '_min', '_max'].flatMap(agg => {
            const spec = args[agg]
            if (!spec || spec === true) return []
            return Object.entries(spec)
              .filter(([, v]) => v)
              .map(([field]) => `${agg === '_sum' ? '0' : 'NULL'} AS "${agg}__${field}"`)
          }),
        ]

        // Data row columns (same as selectCols — already built above with strftimeExpr)
        // dataWhere is used TWICE in the SQL: once in existsSubquery (NOT IN), once in UNION ALL.
        // SQLite processes ? params left-to-right so we push the where params twice.
        const dataWhereParts = []
        if (whereSql) dataWhereParts.push(whereSql)
        if (policyResult) dataWhereParts.push(policyResult.sql)
        const dataWhere = dataWhereParts.length ? ` WHERE ${dataWhereParts.join(' AND ')}` : ''

        // Collect the where params that go into the data WHERE clause
        const whereOnlyParams = params.slice()  // snapshot of params so far (already has whereSql values)
        params.length = 0  // reset — we'll re-push in the right order

        // Order: existsSubquery params first, then UNION ALL params
        params.push(...whereOnlyParams)  // existsSubquery
        if (policyResult) params.push(...policyResult.params)  // existsSubquery policy
        params.push(...whereOnlyParams)  // UNION ALL
        if (policyResult) params.push(...policyResult.params)  // UNION ALL policy

        // The data subquery for the NOT IN check
        const existsSubquery = `SELECT "${intervalField}" FROM "${tableName}"${dataWhere} GROUP BY ${groupByCols.join(', ')}`

        sql = `
WITH RECURSIVE intervals(d) AS (
  SELECT date('${gapStart}')
  UNION ALL
  SELECT date(d, '${step}') FROM intervals WHERE date(d, '${step}') <= date('${gapEnd}')
)
SELECT ${gapCols.join(', ')}
FROM intervals
WHERE ${cteLabel} NOT IN (${existsSubquery})
UNION ALL
SELECT ${selectCols.join(', ')} FROM "${tableName}"${dataWhere} GROUP BY ${groupByCols.join(', ')}
`.trim()

        // NOTE: Potential optimization — if a 'calendar' table exists in this DB
        // (populated via 'litestone seed run calendar'), replace the recursive CTE
        // with a direct SELECT from calendar WHERE date BETWEEN gapStart AND gapEnd.
        // Calendar table has a B-tree index on 'date', making day-level queries
        // over multi-year ranges significantly faster. Not implemented — CTE is
        // sufficient for most use cases. Run `litestone seed run calendar`
        // to populate the table from the bundled seed.

      } else {
        // No gap fill — standard groupBy
        let baseSql = `SELECT ${selectCols.join(', ')} FROM "${tableName}"`
        if (whereSql && policyResult) baseSql += ` WHERE (${whereSql}) AND (${policyResult.sql})`
        else if (whereSql)            baseSql += ` WHERE ${whereSql}`
        else if (policyResult)        baseSql += ` WHERE ${policyResult.sql}`
        if (policyResult) params.push(...policyResult.params)
        baseSql += ` GROUP BY ${groupByCols.join(', ')}`
        sql = baseSql
      }

      // HAVING
      if (having) {
        const havingParts = []
        for (const [aggKey, spec] of Object.entries(having)) {
          if (aggKey === '_count') {
            const expr = buildAggHaving('COUNT(*)', spec, params)
            if (expr) havingParts.push(expr)
          } else {
            const fn = { _sum: 'SUM', _avg: 'AVG', _min: 'MIN', _max: 'MAX' }[aggKey]
            if (!fn) continue
            for (const [field, cond] of Object.entries(spec)) {
              const expr = buildAggHaving(`${fn}("${field}")`, cond, params)
              if (expr) havingParts.push(expr)
            }
          }
        }
        if (havingParts.length) sql += ` HAVING ${havingParts.join(' AND ')}`
      }

      // ORDER BY
      if (orderBy) {
        const orderParts = []
        for (const [key, val] of Object.entries(orderBy)) {
          if (key === '_count') {
            orderParts.push(`COUNT(*) ${val === 'desc' ? 'DESC' : 'ASC'}`)
          } else if (key === '_stringAgg') {
            // orderBy: { _stringAgg: 'asc' } — order by the concatenated result
            if (_stringAgg?.field) {
              orderParts.push(`GROUP_CONCAT("${_stringAgg.field}") ${val === 'desc' ? 'DESC' : 'ASC'}`)
            }
          } else if (key.startsWith('_')) {
            const fn = { _sum: 'SUM', _avg: 'AVG', _min: 'MIN', _max: 'MAX' }[key]
            if (fn && typeof val === 'object') {
              for (const [field, dir] of Object.entries(val)) {
                orderParts.push(`${fn}("${field}") ${dir === 'desc' ? 'DESC' : 'ASC'}`)
              }
            }
          } else if (key === intervalField) {
            // Order by the truncated interval expression
            orderParts.push(`"${key}" ${val === 'desc' ? 'DESC' : 'ASC'}`)
          } else {
            orderParts.push(`"${key}" ${val === 'desc' ? 'DESC' : 'ASC'}`)
          }
        }
        if (orderParts.length) sql += ` ORDER BY ${orderParts.join(', ')}`
      }

      if (limit  != null) sql += ` LIMIT ${Number(limit)}`
      if (offset != null) sql += ` OFFSET ${Number(offset)}`

      const _t0 = performance.now()
      const raw = readDb.query(sql).all(...params)
      fireQuery({ operation: 'groupBy', args, sql, params, duration: performance.now() - _t0, rowCount: raw.length })

      // Shape results
      return raw.map(r => {
        const out = {}
        for (const f of by) out[f] = r[f]
        if (_count) out._count = r.__count ?? 0
        for (const agg of ['_sum', '_avg', '_min', '_max']) {
          const spec = args[agg]
          if (!spec || spec === true) continue
          out[agg] = {}
          for (const [field, wanted] of Object.entries(spec)) {
            if (!wanted) continue
            out[agg][field] = r[`${agg}__${field}`] ?? null
          }
        }
        if (_stringAgg) {
          out._stringAgg = { [_stringAgg.field]: r[`__stringAgg__${_stringAgg.field}`] ?? null }
        }
        // Named aggregates
        for (const [key] of namedAggs) {
          out[key] = r[`__nagg__${key}`] ?? null
        }
        return out
      })
    },

    // ── create ──────────────────────────────────────────────────────────────
    async create({ data, include, select } = {}) {
      if (ctx.hasPolicies) checkCreatePolicy(modelName, data, ctx, ctx.policyMap, ctx.schema, ctx.relationMap)
      if (plugins?.hasPlugins) await plugins.beforeCreate(modelName, { data, include, select }, ctx)
      // Auto-generate @id if field uses @default(uuid/ulid/cuid) and not provided
      const autoId = ctx.autoIdMap?.[modelName]
      if (autoId && (data == null || data[autoId.field] == null)) {
        data = { ...(data ?? {}), [autoId.field]: autoId.generate() }
      }
      // Stamp @default(auth().field) values from ctx.auth if not already provided
      const authDefaults = ctx.authDefaultMap?.[modelName]
      if (authDefaults?.length && ctx.auth) {
        const stamps = {}
        for (const { field, authField } of authDefaults) {
          if ((data == null || data[field] == null) && ctx.auth[authField] != null) {
            stamps[field] = ctx.auth[authField]
          }
        }
        if (Object.keys(stamps).length) data = { ...(data ?? {}), ...stamps }
      }
      // Apply @default(fieldName) — copy value from sibling field if not already provided
      // Must run BEFORE writeData/applyTransforms so @slug and other transforms see the value
      const fieldRefDefaults = ctx.fieldRefDefaultMap?.[modelName]
      if (fieldRefDefaults?.length) {
        const stamps = {}
        for (const { field, sourceField } of fieldRefDefaults) {
          if ((data == null || data[field] == null) && data?.[sourceField] != null) {
            stamps[field] = data[sourceField]
          }
        }
        if (Object.keys(stamps).length) data = { ...(data ?? {}), ...stamps }
      }
      // Apply @sequence fields — inject per-scope auto-incremented values
      data = applySequences(data, modelName, ctx.sequenceMap, writeDb)
      // Split nested write ops from scalar fields
      const { scalar, nested } = extractNestedWrites(data)
      // belongsTo ops first — injects FK values before insert
      const extraFKs = await processBelongsToNested(nested)
      data = { ...scalar, ...extraFKs }

      const hctx = hookRunner ? { model: modelName, operation: 'create', args: { data, include, select }, schema: ctx.models[modelName] } : null
      if (hctx && hookRunner.hasBefore('create')) { hookRunner.runBefore(hctx, ctx); data = hctx.args.data }
      const row   = writeData(data)
      const cols  = Object.keys(row)
      // cols can be empty when all fields are optional and none were supplied,
      // or when all fields were stripped by @allow write policies.
      // SQLite requires DEFAULT VALUES syntax when no columns are specified.
      const _noReturn = select === false && !nested.length
      const _crSql = cols.length
        ? `INSERT INTO "${tableName}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})${_noReturn ? '' : ' RETURNING *'}`
        : `INSERT INTO "${tableName}" DEFAULT VALUES${_noReturn ? '' : ' RETURNING *'}`
      const _crParams = cols.length ? cols.map(c => row[c] ?? null) : []
      const _nt = needsTiming()
      const _crT0 = _nt ? performance.now() : 0

      // select: false — skip RETURNING, use run() for zero overhead
      if (_noReturn) {
        const result = writeDb.run(_crSql, ..._crParams)
        fireQuery({ operation: 'create', args: { data, include, select }, sql: _crSql, params: _crParams, duration: _nt ? performance.now() - _crT0 : 0, rowCount: result.changes })
        if (!result.changes) return null
        if (hctx) { hctx.result = null; if (hookRunner?.hasAfter('create')) hookRunner.runAfter(hctx, ctx) }
        if (emitter) emitter.emit('create', { model: modelName, operation: 'create', result: null, schema: ctx.models[modelName] }, ctx)
        if (plugins?.hasPlugins) await plugins.afterWrite(modelName, 'create', null, ctx)
        return null
      }

      // RETURNING * gives the inserted row directly — no follow-up SELECT needed.
      // Uses writeDb so it works inside open transactions.
      let created = read(writeDb.query(_crSql).get(..._crParams), { mode: 'single' })
      fireQuery({ operation: 'create', args: { data, include, select }, sql: _crSql, params: _crParams, duration: _nt ? performance.now() - _crT0 : 0, rowCount: created ? 1 : 0 })
      if (!created) return null
      // hasMany ops after — children need parent PK
      const pkField = ctx.models[modelName]?.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
      await processHasManyNested(nested, created[pkField])
      const ps = parseArgs(select, include)
      if (ps || include) withIncludes([created], ps, include)
      created = finaliseOne(created, ps)
      if (hctx) { hctx.result = created; if (hookRunner.hasAfter('create')) hookRunner.runAfter(hctx, ctx); created = hctx.result }
      if (emitter) emitter.emit('create', { model: modelName, operation: 'create', result: created, schema: ctx.models[modelName] }, ctx)
      if (plugins?.hasPlugins) await plugins.afterWrite(modelName, 'create', created, ctx)
      // ── Logging ──────────────────────────────────────────────────────────────
      if (tableHasAnyLog && created) emitLogs('create', [created], { after: created })
      return created
    },

    // ── createMany ──────────────────────────────────────────────────────────
    async createMany({ data } = {}) {
      if (!data?.length) return { count: 0 }
      if (ctx.hasPolicies) for (const row of data) checkCreatePolicy(modelName, row, ctx, ctx.policyMap, ctx.schema, ctx.relationMap)
      if (plugins?.hasPlugins) await plugins.beforeCreate(modelName, { data }, ctx)

      // Auto-generate @id and run writeData (transforms + validation) on every row
      // before touching the DB — so @email, @lower, @trim, @encrypted, enum checks
      // all fire consistently, same as single create().
      const autoId      = ctx.autoIdMap?.[modelName]
      const authDefaults = ctx.authDefaultMap?.[modelName]
      const rows = data.map(item => {
        let d = item
        if (autoId && (d == null || d[autoId.field] == null))
          d = { ...(d ?? {}), [autoId.field]: autoId.generate() }
        // Stamp @default(auth().field) values from ctx.auth if not already provided
        if (authDefaults?.length && ctx.auth) {
          const stamps = {}
          for (const { field, authField } of authDefaults) {
            if ((d == null || d[field] == null) && ctx.auth[authField] != null) {
              stamps[field] = ctx.auth[authField]
            }
          }
          if (Object.keys(stamps).length) d = { ...(d ?? {}), ...stamps }
        }
        // Apply @sequence per row — each row gets its own counter increment
        d = applySequences(d, modelName, ctx.sequenceMap, writeDb)
        return writeData(d)
      })

      // Derive column list from the first processed row (post-transforms)
      const cols = Object.keys(rows[0])
      const _cmSql = `INSERT INTO "${tableName}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      const stmt = writeDb.prepare(_cmSql)
      let count = 0
      const _nt = needsTiming()
      const _cmT0 = _nt ? performance.now() : 0
      tx.wrap(() => {
        for (const row of rows) {
          stmt.run(...cols.map(c => row[c] ?? null))
          count++
        }
      })
      fireQuery({ operation: 'createMany', args: { data }, sql: _cmSql, params: null, duration: _nt ? performance.now() - _cmT0 : 0, rowCount: count })
      if (tableHasAnyLog && rows.length > 0) emitLogs('create', rows)
      return { count }
    },

    // ── update ──────────────────────────────────────────────────────────────
    // Returns the updated row, or null in these cases:
    //   • No row matched the where clause
    //   • A @@allow/@@deny policy blocked the update
    //   • A post-update policy rollback was triggered
    // Callers that need to distinguish can check count() before/after,
    // or enable policyDebug to see which policy blocked.
    async update({ where, data, include, select } = {}) {
      if (plugins?.hasPlugins) await plugins.beforeUpdate(modelName, { where, data, include, select }, ctx)
      const hctx = hookRunner ? { model: modelName, operation: 'update', args: { where, data, include, select }, schema: ctx.models[modelName] } : null
      if (hctx && hookRunner.hasBefore('update')) { hookRunner.runBefore(hctx, ctx); where = hctx.args.where; data = hctx.args.data }
      // Stamp @updatedBy fields from ctx.auth
      const _updatedBy = ctx.updatedByMap?.[modelName]
      if (_updatedBy?.length && ctx.auth) {
        const stamps = {}
        for (const { field, authField } of _updatedBy) {
          const val = ctx.auth[authField]
          if (val != null) stamps[field] = val
        }
        if (Object.keys(stamps).length) data = { ...(data ?? {}), ...stamps }
      }
      const { scalar, nested } = extractNestedWrites(data)
      const extraFKs = await processBelongsToNested(nested)
      data = { ...scalar, ...extraFKs }

      const row       = writeData(data)
      const setParams = []
      const setCols   = Object.keys(row)
        .map(c => { setParams.push(row[c] ?? null); return `"${c}" = ?` })
        .join(', ')
      const whereParams = []
      const effectiveWhere = softDelete ? injectSoftDeleteFilter(where, 'live') : where
      const whereSql = buildWhereWithEncryption(effectiveWhere, whereParams)
      if (!whereSql) throw new Error(`update on "${tableName}" requires a where clause`)
      // Append update policy filter to WHERE
      const updatePolicy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'update', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
      const finalWhereSql = updatePolicy ? `(${whereSql}) AND (${updatePolicy.sql})` : whereSql
      const finalWhereParams = updatePolicy ? [...whereParams, ...updatePolicy.params] : whereParams

      // ── Logging + post-update rollback: capture before snapshot ────────────
      // Also needed when post-update policy exists so rollback has data to revert with.
      const needsBeforeRow = tableHasAnyLog || (ctx.hasPolicies && ctx.policyMap?.[modelName]?.['post-update'])
      const beforeRow = needsBeforeRow
        ? read(readDb.query(`SELECT * FROM "${tableName}" WHERE ${whereSql}`).get(...whereParams), { mode: 'single' })
        : null

      // ── Transition enforcement ────────────────────────────────────────────
      // Check before SQL: validates from-state, throws TransitionViolationError if invalid.
      // Note: uses whereParams (original, no policy filter) for the current-value SELECT.
      const _transResult = checkTransitions(row, whereParams, whereSql)
      // If transitions apply, narrow WHERE to include AND field = currentValue (optimistic lock)
      const { sql: _txWhereSql, params: _txWhereParams } = _transResult
        ? applyTransitionWhereClause(_transResult, finalWhereSql, finalWhereParams)
        : { sql: finalWhereSql, params: finalWhereParams }

      let updated = null
      if (setCols) {
        // select: false + no post-update side-effects → use run(), skip RETURNING entirely
        // Note: tableHasAnyLog forces RETURNING even with select: false — the log needs
        // before/after snapshots. select: false has no perf benefit on @@log models.
        const _canSkipReturn = select === false
          && !tableHasAnyLog
          && !(ctx.hasPolicies && ctx.policyMap?.[modelName]?.['post-update'])
          && !nested.length
        if (_canSkipReturn) {
          const _upSql = `UPDATE "${tableName}" SET ${setCols} WHERE ${_txWhereSql}`
          const _upParams = [...setParams, ..._txWhereParams]
          const _nt = needsTiming()
          const _upT0 = _nt ? performance.now() : 0
          const result = writeDb.run(_upSql, ..._upParams)
          fireQuery({ operation: 'update', args: { where, data, include, select }, sql: _upSql, params: _upParams, duration: _nt ? performance.now() - _upT0 : 0, rowCount: result.changes })
          if (!result.changes) {
            if (_transResult) throw new TransitionConflictError(tableName, _transResult.field, _transResult.from, _transResult.to)
            return null
          }
          if (hctx) { hctx.result = null; if (hookRunner?.hasAfter('update')) hookRunner.runAfter(hctx, ctx) }
          if (emitter) emitter.emit('update', { model: modelName, operation: 'update', result: null, schema: ctx.models[modelName] }, ctx)
          if (plugins?.hasPlugins) await plugins.afterWrite(modelName, 'update', null, ctx)
          return null
        }
        const _upSql = `UPDATE "${tableName}" SET ${setCols} WHERE ${_txWhereSql} RETURNING *`
        const _upParams = [...setParams, ..._txWhereParams]
        const _nt = needsTiming()
        const _upT0 = _nt ? performance.now() : 0
        // RETURNING * gives the updated row directly — no follow-up SELECT needed.
        // Uses writeDb so it works inside open transactions.
        updated = read(writeDb.query(_upSql).get(..._upParams), { mode: 'single' })
        fireQuery({ operation: 'update', args: { where, data, include, select }, sql: _upSql, params: _upParams, duration: _nt ? performance.now() - _upT0 : 0, rowCount: updated ? 1 : 0 })
        if (!updated) {
          if (_transResult) throw new TransitionConflictError(tableName, _transResult.field, _transResult.from, _transResult.to)
          return null
        }
      } else {
        // No columns to set — read back to return current row
        updated = read(readDb.query(`SELECT * FROM "${tableName}" WHERE ${whereSql}`).get(...whereParams), { mode: 'single' })
      }
      if (!updated) return null

      // ── post-update policy ───────────────────────────────────────────────
      // Evaluate post-update conditions against the new row state.
      // Run inside a transaction so we can rollback on failure.
      if (ctx.hasPolicies && ctx.policyMap[modelName]?.['post-update']) {
        try {
          checkPostUpdatePolicy(modelName, updated, ctx, ctx.policyMap, ctx.schema, ctx.relationMap)
        } catch (e) {
          // Rollback the update by re-querying and reverting
          if (beforeRow) {
            const revertCols = Object.keys(beforeRow).filter(k => k !== idField)
            if (revertCols.length) {
              const revertParams = revertCols.map(k => beforeRow[k] ?? null)
              revertParams.push(updated[idField])
              writeDb.run(
                `UPDATE "${tableName}" SET ${revertCols.map(c => `"${c}" = ?`).join(', ')} WHERE "${idField}" = ?`,
                ...revertParams
              )
            }
          }
          throw e
        }
      }

      const pkField = ctx.models[modelName]?.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
      await processHasManyNested(nested, updated[pkField])
      const ps = parseArgs(select === false ? null : select, include)
      if (ps || include) withIncludes([updated], ps, include)
      const finalRow = select === false ? null : finaliseOne(updated, ps)
      if (hctx) { hctx.result = finalRow; if (hookRunner.hasAfter('update')) hookRunner.runAfter(hctx, ctx) }
      if (emitter) emitter.emit('update', { model: modelName, operation: 'update', result: finalRow, schema: ctx.models[modelName] }, ctx)
      emitTransitionEvent(_transResult, updated)
      if (plugins?.hasPlugins) await plugins.afterWrite(modelName, 'update', finalRow, ctx)
      // ── Logging: emit after ───────────────────────────────────────────────
      if (tableHasAnyLog && updated) emitLogs('update', [updated], { before: beforeRow, after: updated })
      return finalRow
    },

    // ── updateMany ──────────────────────────────────────────────────────────
    async updateMany({ where, data } = {}) {
      if (plugins?.hasPlugins) await plugins.beforeUpdate(modelName, { where, data }, ctx)
      const row      = writeData(data)
      const params   = []
      const setCols  = Object.keys(row)
        .map(c => { params.push(row[c] ?? null); return `"${c}" = ?` })
        .join(', ')
      const effectiveWhere = softDelete ? injectSoftDeleteFilter(where, 'live') : where
      const whereSql = buildWhereWithEncryption(effectiveWhere, params)
      const updateManyPolicy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'update', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
      if (updateManyPolicy) params.push(...updateManyPolicy.params)
      const finalWhere = whereSql && updateManyPolicy ? `(${whereSql}) AND (${updateManyPolicy.sql})`
                       : whereSql || updateManyPolicy?.sql || null
      const _umSql = `UPDATE "${tableName}" SET ${setCols}${finalWhere ? ` WHERE ${finalWhere}` : ''}`
      const _nt = needsTiming()
      const _umT0 = _nt ? performance.now() : 0
      const result   = writeDb.run(_umSql, ...params)
      fireQuery({ operation: 'updateMany', args: { where, data }, sql: _umSql, params, duration: _nt ? performance.now() - _umT0 : 0, rowCount: result.changes })
      return { count: result.changes }
    },

    // ── upsert ──────────────────────────────────────────────────────────────
    async upsert({ where, create: createData, update: updateData, include, select } = {}) {
      // Use findFirst to determine path, but wrap the create in a savepoint so
      // a concurrent insert between our check and our insert doesn't cause a
      // unique constraint error — instead we retry as an update.
      // The window for this race is tiny under SQLite's single-writer guarantee,
      // but it can happen with async code that yields between findFirst and create.
      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, { where }, ctx)
      const existing = await this.findFirst({ where })
      if (existing) {
        return this.update({ where, data: updateData, include, select })
      }
      // Attempt create; if unique constraint fires (race), fall back to update
      try {
        return await this.create({ data: createData, include, select })
      } catch (e) {
        if (e?.code === 'SQLITE_CONSTRAINT_UNIQUE' || e?.errno === 2067 ||
            (e?.message && e.message.includes('UNIQUE constraint failed'))) {
          return this.update({ where, data: updateData, include, select })
        }
        throw e
      }
    },

    // ── upsertMany ──────────────────────────────────────────────────────────
    // Bulk upsert — one SQL statement, one round trip.
    // Uses INSERT OR REPLACE under the hood — SQLite deletes then re-inserts
    // on conflict, so @id auto-increment is preserved only when you supply
    // the id explicitly. If you omit id, SQLite assigns a new one.
    //
    // conflictTarget — the column(s) that define uniqueness (default: idField).
    // All supplied fields are updated on conflict; unspecified fields keep
    // their existing values.
    //
    //   await db.posts.upsertMany({
    //     data: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }],
    //   })
    //
    //   // Custom conflict target (e.g. unique slug)
    //   await db.posts.upsertMany({
    //     data: [{ slug: 'hello', title: 'Hello' }],
    //     conflictTarget: ['slug'],
    //     update: ['title'],   // only update these fields on conflict
    //   })

    async upsertMany({ data, conflictTarget, update: updateFields } = {}) {
      if (!data?.length) return { count: 0 }
      if (plugins?.hasPlugins) await plugins.beforeCreate(modelName, { data }, ctx)

      const autoId = ctx.autoIdMap?.[modelName]
      const rows = data.map(item => {
        let d = item
        if (autoId && (d == null || d[autoId.field] == null))
          d = { ...(d ?? {}), [autoId.field]: autoId.generate() }
        d = applySequences(d, modelName, ctx.sequenceMap, writeDb)
        return writeData(d)
      })

      const cols    = Object.keys(rows[0])
      const target  = conflictTarget
        ? (Array.isArray(conflictTarget) ? conflictTarget : [conflictTarget])
        : [idField]

      // Build UPDATE SET clause — only the fields that aren't in the conflict target
      const updateCols = updateFields
        ? (Array.isArray(updateFields) ? updateFields : [updateFields]).filter(c => cols.includes(c))
        : cols.filter(c => !target.includes(c))

      let sql = `INSERT INTO "${tableName}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`

      if (updateCols.length) {
        const conflictSql = target.map(c => `"${c}"`).join(', ')
        const setSql      = updateCols.map(c => `"${c}" = excluded."${c}"`).join(', ')
        sql += ` ON CONFLICT(${conflictSql}) DO UPDATE SET ${setSql}`
      } else {
        sql += ` ON CONFLICT DO NOTHING`
      }

      const stmt = writeDb.prepare(sql)
      let count = 0
      const _nt = needsTiming()
      const _usT0 = _nt ? performance.now() : 0
      tx.wrap(() => {
        for (const row of rows) {
          stmt.run(...cols.map(c => row[c] ?? null))
          count++
        }
      })
      fireQuery({ operation: 'upsertMany', args: { data, conflictTarget, update: updateFields }, sql, params: null, duration: _nt ? performance.now() - _usT0 : 0, rowCount: count })
      return { count }
    },

    // ── remove ─────────────────────────────────────────────────────────────
    // The default removal operation — always does the right thing:
    //   soft-delete tables  → sets deletedAt = now() (+ cascades if @@softDeleteCascade)
    //   hard-delete tables  → real DELETE FROM
    // Use delete() only when you explicitly need to bypass soft delete.
    async remove({ where } = {}) {
      if (plugins?.hasPlugins) await plugins.beforeDelete(modelName, { where }, ctx)
      const params   = []
      const effectiveWhere = softDelete ? injectSoftDeleteFilter(where, 'live') : where
      const whereSql = buildWhereWithEncryption(effectiveWhere, params)
      if (!whereSql) throw new Error(`remove on "${tableName}" requires a where clause`)
      const removePolicy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'delete', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
      const removeFinalSql = removePolicy ? `(${whereSql}) AND (${removePolicy.sql})` : whereSql
      const removeFinalParams = removePolicy ? [...params, ...removePolicy.params] : params

      const row = read(readDb.query(`SELECT * FROM "${tableName}" WHERE ${removeFinalSql}`).get(...removeFinalParams))
      if (!row) return null

      if (softDelete) {
        const ts = nowISO()
        const _rmSql = `UPDATE "${tableName}" SET "deletedAt" = ? WHERE ${removeFinalSql} RETURNING *`
        const _nt = needsTiming()
        const _rmT0 = _nt ? performance.now() : 0
        const softResult = read(writeDb.query(_rmSql).get(ts, ...removeFinalParams), { mode: 'single' })
        fireQuery({ operation: 'remove', args: { where }, sql: _rmSql, params: [ts, ...removeFinalParams], duration: _nt ? performance.now() - _rmT0 : 0, rowCount: softResult ? 1 : 0 })
        if (!softResult) return null

        // Cascade soft delete to child tables if @@softDeleteCascade is set
        if (softDeleteCascade && row) {
          const cascadeTargets = getCascadeTargets(modelName, ctx.relationMap, ctx.softDeleteMap, _modelToTable)
          if (cascadeTargets.length > 0) {
            // Track affected PK values per table so multi-level cascades work correctly
            // e.g. accounts(id=1) → users(id=1,2) → posts: use users' ids for posts cascade
            const affectedPKs = new Map([[modelName, [row.id]]])
            for (const { childModel, childTable, foreignKey, referencedKey, parentModel, hardDelete } of cascadeTargets) {
              const parentPKs = affectedPKs.get(parentModel) ?? []
              if (!parentPKs.length) continue
              const ph = parentPKs.map(() => '?').join(',')
              if (hardDelete) {
                // @hardDelete: physically remove child rows instead of stamping deletedAt
                writeDb.run(`DELETE FROM "${childTable}" WHERE "${foreignKey}" IN (${ph})`, ...parentPKs)
                // Hard-delete children are terminal — no need to track their PKs for further cascade
              } else {
                writeDb.run(`UPDATE "${childTable}" SET "deletedAt" = ? WHERE "${foreignKey}" IN (${ph}) AND "deletedAt" IS NULL`, ts, ...parentPKs)
                const childPKs = readDb.query(`SELECT "${referencedKey}" FROM "${childTable}" WHERE "${foreignKey}" IN (${ph})`).all(...parentPKs).map(r => r[referencedKey])
                affectedPKs.set(childModel, childPKs)
              }
            }
          }
        }

        if (emitter) emitter.emit('remove', { model: modelName, operation: 'remove', result: softResult, schema: ctx.models[modelName] }, ctx)
        if (plugins?.hasPlugins) await plugins.afterWrite(modelName, 'delete', softResult, ctx)
        // ── Logging ──────────────────────────────────────────────────────────
        if (tableHasAnyLog) emitLogs('delete', [softResult], { before: row })
        return softResult
      }

      const _rmHSql = `DELETE FROM "${tableName}" WHERE ${removeFinalSql}`
      const _nt = needsTiming()
      const _rmHT0 = _nt ? performance.now() : 0
      writeDb.run(_rmHSql, ...removeFinalParams)
      fireQuery({ operation: 'remove', args: { where }, sql: _rmHSql, params: removeFinalParams, duration: _nt ? performance.now() - _rmHT0 : 0, rowCount: 1 })
      if (emitter) emitter.emit('remove', { model: modelName, operation: 'remove', result: row, schema: ctx.models[modelName] }, ctx)
      if (plugins?.hasPlugins) await plugins.afterWrite(modelName, 'delete', row, ctx)
      if (plugins?.hasPlugins) await plugins.afterDelete(modelName, [row], ctx)
      // ── Logging ───────────────────────────────────────────────────────────
      if (tableHasAnyLog && row) emitLogs('delete', [row], { before: row })
      return row
    },

    // ── removeMany ─────────────────────────────────────────────────────────
    // Bulk version of remove() — same semantics: soft delete on soft-delete tables,
    // real DELETE FROM on hard-delete tables.
    async removeMany({ where } = {}) {
      if (plugins?.hasPlugins) await plugins.beforeDelete(modelName, { where }, ctx)
      const params   = []
      const effectiveWhere = softDelete ? injectSoftDeleteFilter(where, 'live') : where
      const whereSql = buildWhereWithEncryption(effectiveWhere, params)
      const removeManyPolicy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'delete', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
      if (removeManyPolicy) params.push(...removeManyPolicy.params)
      const rmFinalSql = whereSql && removeManyPolicy ? `(${whereSql}) AND (${removeManyPolicy.sql})`
                       : whereSql || removeManyPolicy?.sql || null

      // Prefetch affected rows before SQL so afterDelete gets them.
      // Only done when plugins are listening — avoids the SELECT cost otherwise.
      const affectedRows = plugins?.hasPlugins
        ? readAll(readDb.query(`SELECT * FROM "${tableName}"${rmFinalSql ? ` WHERE ${rmFinalSql}` : ''}`).all(...params))
        : []

      if (softDelete) {
        const ts = nowISO()

        // If cascading, fetch affected PKs first so we can cascade precisely
        if (softDeleteCascade) {
          const cascadeTargets = getCascadeTargets(modelName, ctx.relationMap, ctx.softDeleteMap, _modelToTable)
          if (cascadeTargets.length > 0) {
            const effectiveWhere2 = injectSoftDeleteFilter(where, 'live')
            const params2 = []
            const whereSql2 = buildWhereWithEncryption(effectiveWhere2, params2)
            const liveRows = readDb.query(`SELECT * FROM "${tableName}"${whereSql2 ? ` WHERE ${whereSql2}` : ''}`).all(...params2)
            // Seed affected PKs with root table values
            const firstTarget = cascadeTargets[0]
            const rootPKCol = firstTarget ? firstTarget.referencedKey : 'id'
            const affectedPKs = new Map([[modelName, liveRows.map(r => r[rootPKCol])]])
            for (const { childModel, childTable, foreignKey, referencedKey, parentModel, hardDelete } of cascadeTargets) {
              const parentPKs = affectedPKs.get(parentModel) ?? []
              if (!parentPKs.length) continue
              const ph = parentPKs.map(() => '?').join(',')
              if (hardDelete) {
                writeDb.run(`DELETE FROM "${childTable}" WHERE "${foreignKey}" IN (${ph})`, ...parentPKs)
              } else {
                writeDb.run(`UPDATE "${childTable}" SET "deletedAt" = ? WHERE "${foreignKey}" IN (${ph}) AND "deletedAt" IS NULL`, ts, ...parentPKs)
                const childPKs = readDb.query(`SELECT "${referencedKey}" FROM "${childTable}" WHERE "${foreignKey}" IN (${ph})`).all(...parentPKs).map(r => r[referencedKey])
                affectedPKs.set(childModel, childPKs)
              }
            }
          }
        }

        const result = writeDb.run(
          `UPDATE "${tableName}" SET "deletedAt" = ?${rmFinalSql ? ` WHERE ${rmFinalSql}` : ''}`,
          ts, ...params
        )
        return { count: result.changes }
      }

      const _rmnSql = `DELETE FROM "${tableName}"${rmFinalSql ? ` WHERE ${rmFinalSql}` : ''}`
      const _nt = needsTiming()
      const _rmnT0 = _nt ? performance.now() : 0
      const result = writeDb.run(_rmnSql, ...params)
      fireQuery({ operation: 'removeMany', args: { where }, sql: _rmnSql, params, duration: _nt ? performance.now() - _rmnT0 : 0, rowCount: result.changes })
      if (plugins?.hasPlugins && affectedRows.length)
        await plugins.afterDelete(modelName, affectedRows, ctx)
      return { count: result.changes }
    },

    // ── restore ─────────────────────────────────────────────────────────────
    // Soft-delete tables only — sets deletedAt = NULL.
    async restore({ where } = {}) {
      if (!softDelete) throw new Error(`restore() is only available on soft-delete tables (deletedAt field). Use delete() for hard deletes.`)
      const params   = []
      // Restore targets deleted rows
      const effectiveWhere = injectSoftDeleteFilter(where, 'onlyDeleted')
      const whereSql = buildWhereWithEncryption(effectiveWhere, params)
      if (!whereSql) throw new Error(`restore on "${tableName}" requires a where clause`)
      // If cascading, restore child tables too (reverse of delete cascade)
      if (softDeleteCascade) {
        const cascadeTargets = getCascadeTargets(modelName, ctx.relationMap, ctx.softDeleteMap, _modelToTable)
        if (cascadeTargets.length > 0) {
          const params2 = []
          const whereSql2 = buildWhereWithEncryption(effectiveWhere, params2)
          const deletedRows = readDb.query(`SELECT * FROM "${tableName}" WHERE ${whereSql2}`).all(...params2)
          const firstTarget = cascadeTargets[0]
          const rootPKCol = firstTarget ? firstTarget.referencedKey : 'id'
          const affectedPKs = new Map([[modelName, deletedRows.map(r => r[rootPKCol])]])
          for (const { childModel, childTable, foreignKey, referencedKey, parentModel, hardDelete } of cascadeTargets) {
            const parentPKs = affectedPKs.get(parentModel) ?? []
            if (!parentPKs.length) continue
            const ph = parentPKs.map(() => '?').join(',')
            if (hardDelete) continue  // hard-deleted children are gone — cannot restore
            writeDb.run(`UPDATE "${childTable}" SET "deletedAt" = NULL WHERE "${foreignKey}" IN (${ph})`, ...parentPKs)
            const childPKs = readDb.query(`SELECT "${referencedKey}" FROM "${childTable}" WHERE "${foreignKey}" IN (${ph})`).all(...parentPKs).map(r => r[referencedKey])
            affectedPKs.set(childModel, childPKs)
          }
        }
      }

      const _rsSql = `UPDATE "${tableName}" SET "deletedAt" = NULL WHERE ${whereSql} RETURNING *`
      const _nt = needsTiming()
      const _rsT0 = _nt ? performance.now() : 0
      const restored = writeDb.query(_rsSql).all(...params)
      fireQuery({ operation: 'restore', args: { where }, sql: _rsSql, params, duration: _nt ? performance.now() - _rsT0 : 0, rowCount: restored.length })
      return { count: restored.length }
    },



    // ── findManyCursor ──────────────────────────────────────────────────────
    // Cursor-based pagination — O(log n) via index, unlike offset pagination.
    //
    // Returns { items, nextCursor, hasMore }
    //   items:       the page of rows
    //   nextCursor:  opaque token to pass as `cursor` on the next call
    //   hasMore:     true if there are more rows after this page
    //
    // Usage:
    //   const p1 = await db.users.findManyCursor({ limit: 50, orderBy: { id: 'asc' } })
    //   const p2 = await db.users.findManyCursor({ limit: 50, orderBy: { id: 'asc' }, cursor: p1.nextCursor })
    //
    // Multi-field ordering is supported:
    //   orderBy: [{ createdAt: 'desc' }, { id: 'asc' }]
    //   The cursor encodes all orderBy field values from the last row.
    //
    // All findMany options work: where, include, select, withDeleted, onlyDeleted.
    // The orderBy fields must be present in the SELECT — they're injected automatically.

    async findManyCursor(args = {}) {
      const {
        cursor,
        limit    = 20,
        where,
        select,
        include,
        orderBy,
        withDeleted = false,
        onlyDeleted = false,
      } = args

      const mode   = softDelete
        ? (withDeleted ? 'withDeleted' : onlyDeleted ? 'onlyDeleted' : 'live')
        : 'live'

      // Normalise orderBy — always an array of { col, dir }
      const fields = normaliseOrderBy(orderBy)

      // Decode cursor if provided
      const cursorValues = cursor ? decodeCursor(cursor) : null

      // Build the combined WHERE clause:
      //   soft delete filter AND user where AND cursor where
      const params = []

      const sdWhere   = softDelete ? injectSoftDeleteFilter(where, mode) : where
      const baseWhere = buildWhereWithEncryption(sdWhere, params)

      const cursorClause = cursorValues
        ? buildCursorWhere(fields, cursorValues, params)
        : ''

      let whereSql = ''
      if (baseWhere && cursorClause) {
        whereSql = `(${baseWhere}) AND (${cursorClause})`
      } else if (baseWhere) {
        whereSql = baseWhere
      } else if (cursorClause) {
        whereSql = cursorClause
      }

      // Build SELECT — ensure all orderBy fields are present for cursor extraction
      const ps = parseArgs(select, include)

      // If select is restrictive, inject orderBy fields so we can extract cursor
      let sqlCols = ps?.sqlCols ?? '*'
      const injectedOrderCols = new Set()
      if (ps && sqlCols !== '*') {
        for (const { col } of fields) {
          if (!sqlCols.includes(`"${col}"`)) {
            sqlCols = `"${col}", ${sqlCols}`
            injectedOrderCols.add(col)
          }
        }
      }

      // Build ORDER BY
      const orderSql = fields.map(({ col, dir }) => `"${col}" ${dir}`).join(', ')

      // Fetch limit + 1 to detect hasMore
      const fetchLimit = limit + 1

      let sql = `SELECT ${sqlCols} FROM "${tableName}"`
      if (whereSql)   sql += ` WHERE ${whereSql}`
      sql += ` ORDER BY ${orderSql}`
      sql += ` LIMIT ${fetchLimit}`

      const _nt = needsTiming()

      const _fmcT0 = _nt ? performance.now() : 0
      const rawRows = readDb.query(sql).all(...params)
      if (_nt) fireQuery({ operation: 'findManyCursor', args, sql, params, duration: _nt ? performance.now() - _fmcT0 : 0, rowCount: rawRows.length })

      // Detect hasMore by checking if we got an extra row
      const hasMore = rawRows.length > limit
      const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows

      // Deserialize + compute
      const rows = readAll(pageRows)

      // Resolve includes
      withIncludes(rows, ps, include)

      // Extract cursor from last row (before trimming — need orderBy field values)
      let nextCursor = null
      if (hasMore && rows.length > 0) {
        const lastRow = rows[rows.length - 1]
        const cursorData = extractCursorValues(lastRow, fields)
        nextCursor = encodeCursor(cursorData)
      }

      // Trim to select (strip injected orderBy cols if not requested)
      let finalRows = rows
      if (ps) {
        // Add injected order cols to injectedFKs so they get stripped
        const augmentedInjected = new Set([...ps.injectedFKs, ...injectedOrderCols])
        finalRows = trimAllToSelect(rows, ps.requestedFields, augmentedInjected)
      }

      return { items: finalRows, nextCursor, hasMore }
    },

    // ── search ──────────────────────────────────────────────────────────────
    // Full-text search via FTS5. Only available on models with @@fts([...]).
    //
    // Options:
    //   query      FTS5 query string — supports phrase "exact match", prefix foo*,
    //              boolean AND/OR/NOT, column filters col:term
    //   limit      max rows to return (default 20)
    //   offset     skip rows (default 0)
    //   where      additional filter on base table (applied after FTS match)
    //   select     column allowlist (same as findMany)
    //   include    relations to include (same as findMany)
    //   highlight  { field, open, close } — wrap matched terms in HTML
    //   snippet    { field, open, close, length } — extract matched context window
    //   withRank   include _rank (BM25 score) on each row — default true
    //   withDeleted / onlyDeleted — soft delete mode (same as findMany)
    //
    // Returns rows from the base table ordered by relevance (best match first).
    // Adds _rank (BM25), _highlight, _snippet where requested.

    async search(query, {
      limit       = 20,
      offset      = 0,
      where,
      select,
      include,
      highlight,
      snippet,
      withRank    = true,
      withDeleted = false,
      onlyDeleted = false,
    } = {}) {
      if (!ftsFields) {
        throw new Error(
          `search() is not available on "${tableName}" — add @@fts([field1, field2]) to the model`
        )
      }

      const ftsTable = `${tableName}_fts`
      const mode     = withDeleted ? 'withDeleted' : onlyDeleted ? 'onlyDeleted' : 'live'

      // ── Step 1: query FTS table for matching rowids + rank ─────────────────
      // FTS5 rank column is BM25 — lower (more negative) = better match.
      // We ORDER BY rank ASC so best matches come first.

      const ftsParams  = []
      let   ftsSql     = `SELECT rowid, rank`

      // Optional highlight — wraps matched terms in open/close tags
      if (highlight) {
        const fieldIdx = ftsFields.indexOf(highlight.field)
        if (fieldIdx === -1) throw new Error(
          `highlight.field "${highlight.field}" is not an FTS field on "${tableName}". FTS fields: ${ftsFields.join(', ')}`
        )
        const open  = highlight.open  ?? '<mark>'
        const close = highlight.close ?? '</mark>'
        ftsSql += `, highlight(${ftsTable}, ${fieldIdx}, ?, ?) as _highlight`
        ftsParams.push(open, close)
      }

      // Optional snippet — extracts a short window of context around the match
      if (snippet) {
        const fieldIdx = ftsFields.indexOf(snippet.field)
        if (fieldIdx === -1) throw new Error(
          `snippet.field "${snippet.field}" is not an FTS field on "${tableName}". FTS fields: ${ftsFields.join(', ')}`
        )
        const open   = snippet.open   ?? '<mark>'
        const close  = snippet.close  ?? '</mark>'
        const ellip  = snippet.ellipsis ?? '…'
        const tokens = snippet.length  ?? 15
        ftsSql += `, snippet(${ftsTable}, ${fieldIdx}, ?, ?, ?, ?) as _snippet`
        ftsParams.push(open, close, ellip, tokens)
      }

      ftsSql += ` FROM "${ftsTable}" WHERE "${ftsTable}" MATCH ? ORDER BY rank`
      ftsParams.push(query)  // MATCH ? must come last

      if (limit  != null) ftsSql += ` LIMIT ${Number(limit)}`
      if (offset)         ftsSql += ` OFFSET ${Number(offset)}`

      const _nt = needsTiming()

      const _srT0 = _nt ? performance.now() : 0
      const ftsRows = readDb.query(ftsSql).all(...ftsParams)
      fireQuery({ operation: 'search', args: { query, where, limit, offset }, sql: ftsSql, params: ftsParams, duration: _nt ? performance.now() - _srT0 : 0, rowCount: ftsRows.length })
      if (!ftsRows.length) return []

      // ── Step 2: fetch full rows from base table for the matching IDs ───────
      // Preserve FTS rank order by using a CASE WHEN expression.

      const rowids      = ftsRows.map(r => r.rowid)
      const rankByRowid = new Map(ftsRows.map(r => [r.rowid, r.rank]))
      const hlByRowid   = highlight ? new Map(ftsRows.map(r => [r.rowid, r._highlight])) : null
      const snipByRowid = snippet   ? new Map(ftsRows.map(r => [r.rowid, r._snippet]))   : null

      // Build base query — apply soft delete filter + any extra where
      const baseParams   = []
      const inClause     = rowids.map(() => '?').join(', ')
      const idFilter     = { id: { in: rowids } }
      const effectiveWhere = softDelete
        ? injectSoftDeleteFilter(
            where ? { AND: [idFilter, where] } : idFilter,
            mode
          )
        : (where ? { AND: [idFilter, where] } : idFilter)

      const whereSql = buildWhereWithEncryption(effectiveWhere, baseParams)

      const ps         = parseArgs(select, include)
      const sqlCols    = ps?.sqlCols ?? '*'
      let   baseSql    = `SELECT ${sqlCols} FROM "${tableName}" WHERE ${whereSql}`

      const baseRows = readAll(readDb.query(baseSql).all(...baseParams))
      if (!baseRows.length) return []

      // ── Step 3: attach rank + extras, sort by original FTS rank order ──────
      const rowById = new Map(baseRows.map(r => [r.id, r]))

      const result = []
      for (const ftsRow of ftsRows) {
        const row = rowById.get(ftsRow.rowid)
        if (!row) continue  // filtered out by where clause or soft delete

        if (withRank)  row._rank      = ftsRow.rank
        if (hlByRowid) row._highlight = hlByRowid.get(ftsRow.rowid)
        if (snipByRowid) row._snippet = snipByRowid.get(ftsRow.rowid)

        result.push(row)
      }

      // ── Step 4: resolve includes + trim select ────────────────────────────
      withIncludes(result, ps, include)
      return finalise(result, ps)
    },

    // ── delete ──────────────────────────────────────────────────────────────
    // Always a real DELETE FROM — bypasses soft delete on all tables.
    // Requires a where clause to prevent accidental mass deletion.
    async delete({ where } = {}) {
      if (plugins?.hasPlugins) await plugins.beforeDelete(modelName, { where }, ctx)
      const params   = []
      const whereSql = buildWhere(where, params)
      if (!whereSql) throw new Error(`delete on "${tableName}" requires a where clause — use deleteMany({}) to delete all rows`)
      const delPolicy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'delete', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
      const delFinalSql = delPolicy ? `(${whereSql}) AND (${delPolicy.sql})` : whereSql
      const delFinalParams = delPolicy ? [...params, ...delPolicy.params] : params
      const row = read(readDb.query(`SELECT * FROM "${tableName}" WHERE ${delFinalSql}`).get(...delFinalParams))
      const _delSql = `DELETE FROM "${tableName}" WHERE ${delFinalSql}`
      const _nt = needsTiming()
      const _delT0 = _nt ? performance.now() : 0
      writeDb.run(_delSql, ...delFinalParams)
      fireQuery({ operation: 'delete', args: { where }, sql: _delSql, params: delFinalParams, duration: _nt ? performance.now() - _delT0 : 0, rowCount: 1 })
      if (plugins?.hasPlugins) await plugins.afterWrite(modelName, 'delete', row, ctx)
      if (plugins?.hasPlugins) await plugins.afterDelete(modelName, [row].filter(Boolean), ctx)
      // ── Logging ───────────────────────────────────────────────────────────
      if (tableHasAnyLog && row) emitLogs('delete', [row], { before: row })
      return row
    },

    // ── deleteMany ──────────────────────────────────────────────────────────
    // Real DELETE FROM — bypasses soft delete. where is optional (deletes all if omitted).
    async deleteMany({ where } = {}) {
      if (plugins?.hasPlugins) await plugins.beforeDelete(modelName, { where }, ctx)
      const params   = []
      const whereSql = buildWhere(where, params)
      const delManyPolicy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'delete', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
      if (delManyPolicy) params.push(...delManyPolicy.params)
      const dmFinalSql = whereSql && delManyPolicy ? `(${whereSql}) AND (${delManyPolicy.sql})`
                       : whereSql || delManyPolicy?.sql || null

      // Prefetch affected rows before SQL so afterDelete gets them.
      // Only done when plugins are listening — avoids the SELECT cost otherwise.
      const affectedRows = plugins?.hasPlugins
        ? readAll(readDb.query(`SELECT * FROM "${tableName}"${dmFinalSql ? ` WHERE ${dmFinalSql}` : ''}`).all(...params))
        : []

      const _dmnSql = `DELETE FROM "${tableName}"${dmFinalSql ? ` WHERE ${dmFinalSql}` : ''}`
      const _nt = needsTiming()
      const _dmnT0 = _nt ? performance.now() : 0
      const result = writeDb.run(_dmnSql, ...params)
      fireQuery({ operation: 'deleteMany', args: { where }, sql: _dmnSql, params, duration: _nt ? performance.now() - _dmnT0 : 0, rowCount: result.changes })
      if (plugins?.hasPlugins && affectedRows.length)
        await plugins.afterDelete(modelName, affectedRows, ctx)
      return { count: result.changes }
    },

    // ── transition ──────────────────────────────────────────────────────────
    // Explicit named-transition method.
    // Resolves transition name → target value from the enum's transitions block,
    // then calls update() with enforcement applied.
    //
    // Throws:
    //   TransitionNotFoundError  — transition name not in enum
    //   TransitionViolationError — current state not in transition's from
    //   TransitionConflictError  — race condition (retryable: true)
    //
    // Skips enforcement for SYSTEM auth (same as update()).
    //
    // updateMany() is NOT covered — transition safety requires single-row update().
    async transition(id, transitionName) {
      if (!_tableTransitions) throw new Error(`transition() is not available on "${tableName}" — no transitions block declared on any enum field`)

      // Find which field + enum has this transition name
      let targetField = null, targetValue = null
      for (const [fieldName, spec] of Object.entries(_tableTransitions)) {
        const t = spec.transitions[transitionName]
        if (t) { targetField = fieldName; targetValue = t.to; break }
      }
      if (!targetField) {
        const available = Object.values(_tableTransitions).flatMap(s => Object.keys(s.transitions))
        throw new TransitionNotFoundError(tableName, transitionName, [...new Set(available)])
      }

      return this.update({ where: { [idField]: id }, data: { [targetField]: targetValue } })
    },

    // ── optimizeFts ─────────────────────────────────────────────────────────
    // Merges fragmented FTS5 index segments into fewer, larger ones.
    // Automatically available on any model with @@fts — throws if called on
    // a model without FTS enabled.
    //
    // When to call it:
    //   - After bulk inserts / imports (most impactful — collapses many tiny segments)
    //   - Nightly on high-write-volume tables
    //   - On low-write tables: rarely or never needed
    //
    // It's a no-op if the index is already tight, so safe to call unconditionally.

    optimizeFts() {
      if (!ftsFields) {
        throw new Error(
          `optimizeFts() is not available on "${tableName}" — add @@fts([field1, field2]) to the model`
        )
      }
      writeDb.run(`INSERT INTO "${tableName}_fts"("${tableName}_fts") VALUES('optimize')`)
      return { optimized: true, table: `${tableName}_fts` }
    },

  }
}

// ─── Multi-database helpers ───────────────────────────────────────────────────

// Resolve a database path definition to an absolute filesystem path.
// pathDef: { kind: 'literal', value } | { kind: 'env', var, default }
// override: optional string from createClient options.databases[name].path
function resolveDbPath(pathDef, override) {
  if (override) return override === ':memory:' ? ':memory:' : resolve(override)
  if (pathDef.kind === 'env') {
    const val = process.env[pathDef.var] ?? pathDef.default
    if (!val) throw new Error(`database path: env var '${pathDef.var}' is not set and has no default`)
    return val === ':memory:' ? ':memory:' : resolve(val)
  }
  const v = pathDef.value
  return v === ':memory:' ? ':memory:' : resolve(v)
}

// Open a SQLite database pair (write + read) with standard Litestone pragmas.
function openSqliteConnections(absPath) {
  // SQLite can create a DB file but not its parent directory. If the configured
  // path points into a directory that doesn't exist yet, pre-create it so the
  // first `litestone repl`/`studio`/`createClient` call doesn't fail with a
  // cryptic SQLITE_CANTOPEN. Skip for :memory: and relative-to-nothing paths.
  if (absPath !== ':memory:') {
    try {
      const dir = dirname(absPath)
      if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    } catch { /* fall through — let the Database() call surface the real error */ }
  }

  let rawWriteDb
  try {
    rawWriteDb = new Database(absPath)
  } catch (err) {
    if (err?.code === 'SQLITE_CANTOPEN') {
      const hint = absPath === ':memory:'
        ? ''
        : `\n  path: ${absPath}\n  Check that the parent directory exists and is writable.`
      const e = new Error(`unable to open SQLite database: ${err.message}${hint}`)
      e.code = err.code
      e.cause = err
      throw e
    }
    throw err
  }
  rawWriteDb.run('PRAGMA journal_mode = WAL')
  rawWriteDb.run('PRAGMA foreign_keys = ON')
  rawWriteDb.run('PRAGMA page_size = 8192')
  rawWriteDb.run('PRAGMA synchronous = NORMAL')
  rawWriteDb.run('PRAGMA cache_size = -32768')
  rawWriteDb.run('PRAGMA temp_store = MEMORY')
  rawWriteDb.run('PRAGMA mmap_size = 268435456')
  rawWriteDb.run('PRAGMA busy_timeout = 5000')
  rawWriteDb.run('PRAGMA wal_autocheckpoint = 1000')

  // :memory: databases cannot be opened as a separate read-only connection —
  // reuse the write connection for reads instead.
  const isMemory = absPath === ':memory:'
  const rawReadDb = isMemory ? rawWriteDb : new Database(absPath, { readonly: true })
  if (!isMemory) {
    rawReadDb.run('PRAGMA foreign_keys = ON')
    rawReadDb.run('PRAGMA query_only = ON')
    rawReadDb.run('PRAGMA cache_size = -32768')
    rawReadDb.run('PRAGMA temp_store = MEMORY')
    rawReadDb.run('PRAGMA mmap_size = 268435456')
  }

  return {
    rawWriteDb,
    rawReadDb,
    writeDb: wrapDb(rawWriteDb),
    readDb:  wrapDb(rawReadDb),
  }
}

// A stub db that throws clearly when accessed on a restricted database.
function makeThrowingDb(dbName, reason) {
  const msg = reason === false
    ? `Database '${dbName}' is not accessible in this client (access: false)`
    : `Database '${dbName}' is readonly in this client — write operations are not allowed`
  const stub = () => { throw new Error(msg) }
  return { query: stub, prepare: stub, run: stub, $raw: null, get cacheSize() { return 0 } }
}

// Merge readOnly shorthand into accessConfig.
// readOnly: true  →  every SQLite database in the schema gets access: 'readonly'
// Explicit accessConfig entries always win over readOnly shorthand.
function resolveAccessConfig(accessConfig, readOnly, schema) {
  if (!readOnly) return accessConfig ?? {}
  const base = {}
  for (const db of schema.databases) {
    if (!db.driver || db.driver === 'sqlite') base[db.name] = 'readonly'
  }
  // 'main' covers single-db schemas that have no database blocks
  base.main = 'readonly'
  // Explicit accessConfig overrides the shorthand
  return { ...base, ...(accessConfig ?? {}) }
}

// Build the registry of live database connections from schema.databases + options.
// Returns: { dbName: { rawWriteDb, rawReadDb, writeDb, readDb, driver, access, absPath } }
//
// Rules:
//   - Each database block in schema gets its own connection pair
//   - 'main' must be declared in schema OR dbPath option provided
//   - access: 'readwrite' (default) | 'readonly' | false (no connection)
//   - jsonl/logger driver: no SQLite connections — path stored only
function buildDbRegistry(schema, dbPath, dbOverrides, accessConfig, inMemory = false) {
  const registry = {}

  for (const db of schema.databases) {
    const access  = accessConfig[db.name] ?? 'readwrite'
    const absPath = resolveDbPath(db.path, dbOverrides[db.name]?.path)

    if (db.driver === 'jsonl' || db.driver === 'logger') {
      // In-memory mode: use a unique tmpdir so test runs don't pollute the filesystem.
      // The dir is created immediately so the driver can write to it.
      let resolvedPath = absPath
      if (inMemory) {
        resolvedPath = mkdtempSync(join(tmpdir(), `litestone-${db.name}-`)) + '/'
      }
      registry[db.name] = { driver: db.driver, access, absPath: resolvedPath, retention: db.retention, maxSize: db.maxSize, logModel: db.logModel, rawWriteDb: null, rawReadDb: null, writeDb: null, readDb: null }
      continue
    }

    if (access === false) {
      registry[db.name] = { driver: 'sqlite', access: false, absPath, retention: null, rawWriteDb: null, rawReadDb: null, writeDb: makeThrowingDb(db.name, false), readDb: makeThrowingDb(db.name, false) }
      continue
    }

    const conns = openSqliteConnections(absPath)

    if (access === 'readonly') {
      conns.rawWriteDb.close()
      registry[db.name] = { driver: 'sqlite', access: 'readonly', absPath, retention: db.retention, rawWriteDb: null, rawReadDb: conns.rawReadDb, writeDb: makeThrowingDb(db.name, 'readonly'), readDb: conns.readDb }
    } else {
      registry[db.name] = { driver: 'sqlite', access: 'readwrite', absPath, retention: db.retention, ...conns }
    }
  }

  // If no 'main' database block declared, use dbPath option as implicit main
  if (!registry.main) {
    if (!dbPath) throw new Error(`No 'database main' block in schema and no db path provided`)
    const access  = accessConfig.main ?? 'readwrite'
    const absPath = dbPath === ':memory:' ? ':memory:' : resolve(dbPath)
    if (access === false) {
      registry.main = { driver: 'sqlite', access: false, absPath, retention: null, rawWriteDb: null, rawReadDb: null, writeDb: makeThrowingDb('main', false), readDb: makeThrowingDb('main', false) }
    } else if (access === 'readonly') {
      const conns = openSqliteConnections(absPath)
      conns.rawWriteDb.close()
      registry.main = { driver: 'sqlite', access: 'readonly', absPath, retention: null, rawWriteDb: null, rawReadDb: conns.rawReadDb, writeDb: makeThrowingDb('main', 'readonly'), readDb: conns.readDb }
    } else {
      registry.main = { driver: 'sqlite', access: 'readwrite', absPath, retention: null, ...openSqliteConnections(absPath) }
    }
  }

  return registry
}

// Build a map of model name → database name from @@db model attributes.
// Models without @@db fall through to 'main'.
function buildModelDbMap(schema) {
  const map = {}
  for (const model of schema.models) {
    const dbAttr = model.attributes.find(a => a.kind === 'db')
    map[model.name] = dbAttr?.name ?? 'main'
  }
  return map
}

// Derive the physical file path for a JSONL model.
//
// Single-model convenience: if absPath ends in '.jsonl' it IS the file.
//   database logs { path "./requests.jsonl" }  →  one model, one file
//
// Multi-model (directory): if absPath has no .jsonl extension, treat it as
// a directory and place each model in its own file.
//   database audit { path "./audit/" }
//     model fieldReads  @@db(audit)  →  ./audit/fieldReads.jsonl
//     model requestLogs @@db(audit)  →  ./audit/requestLogs.jsonl
//
// The directory is created automatically on first use.
function jsonlFilePath(absPath, modelName) {
  if (extname(absPath) === '.jsonl') {
    // Explicit single-file path — use it directly
    return absPath
  }
  // Directory mode — one file per model
  return join(absPath, `${modelName}.jsonl`)
}

// ─── Logger driver helpers ────────────────────────────────────────────────────

// The auto-generated model AST for driver:logger databases in auto mode.
// Shape is fixed — owned by Litestone, not the user.
// Model name: <dbName>Logs  e.g. audit → auditLogs
function makeLoggerAutoModel(dbName) {
  const name = dbName + 'Logs'
  const f = (fieldName, typeName, optional = false) => ({
    name: fieldName,
    type: { kind: 'scalar', name: typeName, optional, array: false },
    attributes: [],
    comments: [],
  })
  return {
    name,
    fields: [
      f('operation',  'Text'),
      f('model',      'Text'),
      f('field',      'Text',     true),
      f('records',    'Json'),
      f('before',     'Json',     true),
      f('after',      'Json',     true),
      f('actorId',    'Integer',  true),
      f('actorType',  'Text',     true),
      f('meta',       'Json',     true),
      { name: 'createdAt', type: { kind: 'scalar', name: 'DateTime', optional: false, array: false },
        attributes: [{ kind: 'default', value: { kind: 'call', fn: 'now' } }], comments: [] },
    ],
    attributes: [
      { kind: 'db',    name: dbName },
      { kind: 'index', fields: ['actorId'] },
      { kind: 'index', fields: ['model'] },
    ],
    comments: [],
  }
}

// Build a map of @log and @@log declarations from the schema.
// Returns:
//   fields: { 'ModelName.fieldName': [{ db, reads, writes }] }
//   models: { 'ModelName':           [{ db, reads, writes }] }
function buildLogMap(schema) {
  const fields = {}
  const models = {}

  for (const model of schema.models) {
    // Field-level @log
    for (const field of model.fields) {
      const logAttr = field.attributes.find(a => a.kind === 'log')
      if (!logAttr) continue
      const key = `${model.name}.${field.name}`
      if (!fields[key]) fields[key] = []
      fields[key].push({ db: logAttr.db, reads: logAttr.reads, writes: logAttr.writes })
    }
    // Model-level @@log (can appear multiple times)
    for (const attr of model.attributes) {
      if (attr.kind !== 'log') continue
      if (!models[model.name]) models[model.name] = []
      models[model.name].push({ db: attr.db, reads: attr.reads, writes: attr.writes })
    }
  }

  return { fields, models }
}

// Build the log entry object from the standard fields + onLog.
// ctx is the request context (has ctx.auth).
// onLog is the user-supplied function from createClient options.
function buildLogEntry({ operation, model, field, records, before, after }, ctx, onLog) {
  const entry = {
    operation,
    model,
    field:     field    ?? null,
    records:   JSON.stringify(records ?? []),
    before:    before   != null ? JSON.stringify(before)  : null,
    after:     after    != null ? JSON.stringify(after)   : null,
    actorId:   ctx.auth?.id   ?? null,
    actorType: ctx.auth?.type ?? (ctx.auth ? 'user' : null),
    meta:      null,
    createdAt: new Date().toISOString(),
  }

  if (onLog) {
    try {
      const extra = onLog(entry, ctx) ?? {}
      if ('actorId'   in extra && extra.actorId   != null) entry.actorId   = extra.actorId
      if ('actorType' in extra && extra.actorType != null) entry.actorType = extra.actorType
      if ('meta'      in extra && extra.meta      != null) entry.meta      = JSON.stringify(extra.meta)
    } catch {}
  }

  return entry
}

// Fire-and-forget write to a log table.
// Never blocks, never throws to caller.
// Uses setImmediate (or setTimeout fallback) to push the I/O outside the current
// event loop tick entirely — avoids microtask-queue I/O stacking on hot paths.
function fireLog(logTable, entry) {
  if (!logTable) return
  const write = () => { try { logTable.create({ data: entry }) } catch {} }
  if (typeof setImmediate === 'function') setImmediate(write)
  else setTimeout(write, 0)
}

// ─── Client factory ───────────────────────────────────────────────────────────

/**
 * Create a Litestone query client.
 *
 * @param {string} schemaPath  path to the .lite schema file, or an inline schema string
 * @param {object} [options]
 * @param {string} [options.db]          path to the main SQLite database (if not declared in schema)
 * @param {string|object} [options.computed]  computed field functions object or path to file
 *
 * @example
 * // Schema declares all database paths via database blocks (recommended)
 * const db = await createClient('./schema.lite')
 *
 * // Simple single-database — pass db path via options when no database block in schema
 * const db = await createClient('./schema.lite', { db: './app.db' })
 */
export async function createClient({
  path:       schemaFilePath,  // path to .lite file  — e.g. './db/schema.lite'
  schema:     schemaInline,    // inline schema string — e.g. `model users { ... }`
  parsed:     schemaPreParsed, // pre-parsed parseResult (advanced)
  db:         dbPath,
  computed: computedInput,
  encryptionKey,       // 64-char hex string — required for @encrypted / @secret fields
  hooks,
  onEvent,
  filters,
  plugins:    plugins,
  databases:  dbOverrides,   // ':memory:' | { dbName: { path } } — override db paths
  access:     accessConfig,
  readOnly,              // true — shorthand for access: { '*': 'readonly' } on all SQLite dbs
  pluralize:  pluralizeTableNames = false,  // true — pluralize snake_case table names (user→users)
  onLog,
  onQuery,
  policyDebug = false,
  scopes:     scopeRegistry = {},   // { ModelName: { scopeName: scopeDef, ... } }
} = {}) {

  // ── Parse schema ───────────────────────────────────────────────────────────
  // Resolution order: parsed > schema (inline string) > path (file)
  //
  //   createClient({ path: './db/schema.lite' })
  //   createClient({ schema: `model users { id Integer @id }`, db: ':memory:' })
  //   createClient({ parsed: parseFile('./db/schema.lite') })
  const parseResult = (() => {
    if (schemaPreParsed) return schemaPreParsed
    if (schemaInline)    return schemaInline.includes('\n') || !schemaInline.endsWith('.lite')
                           ? parse(schemaInline)
                           : parseFile(resolve(schemaInline))
    if (schemaFilePath)  return parseFile(resolve(schemaFilePath))
    throw new Error(
      'createClient() requires one of:\n' +
      '  path:   \'./db/schema.lite\'\n' +
      '  schema: `model users { ... }`\n' +
      '  parsed: parseFile(...)'
    )
  })()

  if (!parseResult.valid)
    throw new Error(`schema.lite has errors:\n${parseResult.errors.join('\n')}`)

  // ── Build working schema ──────────────────────────────────────────────────
  // Start from the parsed schema, then augment with:
  //   • auto logger models (<dbName>Logs) for driver:logger databases in auto mode
  //   • view-as-model stubs so ctx.models[viewName] works inside makeTable
  const rawSchema     = parseResult.schema
  const autoLogModels = rawSchema.databases
    .filter(db => db.driver === 'logger' && !db.logModel)
    .map(db => makeLoggerAutoModel(db.name))

  const viewModelStubs = (rawSchema.views ?? []).map(view => ({
    name:       view.name,
    fields:     view.fields,
    attributes: [{ kind: 'db', name: view.db ?? 'main' }],
    comments:   [],
  }))

  const extraModels = [...autoLogModels, ...viewModelStubs]
  const schema = extraModels.length > 0
    ? { ...rawSchema, models: [...rawSchema.models, ...extraModels] }
    : rawSchema

  // ── Validate ───────────────────────────────────────────────────────────────
  if (!schema.databases.length && !dbPath) {
    throw new Error(
      `createClient() requires either:\n` +
      `  • database blocks in your schema.lite file, OR\n` +
      `  • a db path: createClient({ path: './schema.lite', db: './app.db' })`
    )
  }

  // ── Open database connections ──────────────────────────────────────────────
  // 'databases: :memory:' shorthand — force all SQLite databases to in-memory.
  // Works for both multi-DB schemas (database blocks) and single-DB schemas.
  const inMemory = dbOverrides === ':memory:'
  const resolvedOverrides = inMemory
    ? Object.fromEntries((schema.databases ?? [])
        .filter(d => !d.driver || d.driver === 'sqlite')
        .map(d => [d.name, { path: ':memory:' }]))
    : (dbOverrides ?? {})
  const resolvedDbPath = inMemory ? ':memory:' : dbPath

  const dbRegistry  = buildDbRegistry(schema, resolvedDbPath, resolvedOverrides, resolveAccessConfig(accessConfig, readOnly, schema), inMemory)
  const modelDbMap  = buildModelDbMap(schema)


// ─── Lock primitive ───────────────────────────────────────────────────────────
//
// Application-level named locks backed by a _locks table in the main SQLite db.
// Table is auto-created on first use — no migration, no schema declaration.
//
// Storage: main db only. Locks are ephemeral — rows exist while held, deleted
// on release. Table stays tiny (rows = concurrent holders, never accumulates).
//
// Acquire uses INSERT OR IGNORE (atomic in SQLite) — no gap between check and
// write. Expired locks are cleaned up before each acquire attempt.
//
// Usage:
//   await db.$lock('key', async () => { ... })
//   const lock = await db.$locks.acquire('key', { ttl: 60_000 })
//   try { ... } finally { await lock.release() }
//
// Default TTL: 30s. Use heartbeat() for long-running operations.
// SYSTEM auth bypasses lock enforcement (for migrations, data repair, seeding).

function makeLockPrimitive(rawWriteDb, getIsSystem) {
  const LOCKS_TABLE = '_locks'
  let _ensured = false

  function ensureTable() {
    if (_ensured) return
    rawWriteDb.run(`CREATE TABLE IF NOT EXISTS "${LOCKS_TABLE}" (
      "key"          TEXT    PRIMARY KEY,
      "owner"        TEXT    NOT NULL,
      "acquired_at"  INTEGER NOT NULL,
      "expires_at"   INTEGER NOT NULL,
      "heartbeat_at" INTEGER NOT NULL
    ) STRICT`)
    _ensured = true
  }

  function defaultOwner() {
    return `pid-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  }

  // ── Low-level acquire ────────────────────────────────────────────────────
  // Returns true if acquired, false if lock is held by another owner.
  // Cleans up expired locks before attempting.

  function tryAcquireOnce(key, owner, ttl) {
    const now       = Date.now()
    const expiresAt = now + ttl

    // Clean up any expired lock for this key before attempting
    rawWriteDb.run(
      `DELETE FROM "${LOCKS_TABLE}" WHERE "key" = ? AND "expires_at" < ?`,
      key, now
    )

    const result = rawWriteDb.run(
      `INSERT OR IGNORE INTO "${LOCKS_TABLE}" ("key","owner","acquired_at","expires_at","heartbeat_at") VALUES (?,?,?,?,?)`,
      key, owner, now, expiresAt, now
    )
    return result.changes === 1
  }

  function getCurrentHolder(key) {
    return rawWriteDb.prepare(
      `SELECT "owner", "expires_at" FROM "${LOCKS_TABLE}" WHERE "key" = ?`
    ).get(key)
  }

  // ── $locks API ────────────────────────────────────────────────────────────

  async function acquire(key, opts = {}) {
    ensureTable()
    const {
      ttl        = 30_000,
      wait       = 0,
      retryEvery = 100,
      owner      = defaultOwner(),
    } = opts

    const deadline = Date.now() + wait

    while (true) {
      const acquired = tryAcquireOnce(key, owner, ttl)
      if (acquired) {
        return {
          key,
          owner,
          acquiredAt: new Date(),
          expiresAt:  new Date(Date.now() + ttl),
          async release() {
            const existing = rawWriteDb.prepare(
              `SELECT "owner", "expires_at" FROM "${LOCKS_TABLE}" WHERE "key" = ?`
            ).get(key)
            if (!existing) return   // already gone — idempotent
            if (existing.expires_at < Date.now()) throw new LockExpiredError(key, owner)
            if (existing.owner !== owner) throw new LockReleasedByOtherError(key, owner)
            rawWriteDb.run(`DELETE FROM "${LOCKS_TABLE}" WHERE "key" = ? AND "owner" = ?`, key, owner)
          },
          async heartbeat() {
            rawWriteDb.run(
              `UPDATE "${LOCKS_TABLE}" SET "expires_at" = ?, "heartbeat_at" = ? WHERE "key" = ? AND "owner" = ?`,
              Date.now() + ttl, Date.now(), key, owner
            )
          },
        }
      }

      // Lock held — check wait budget
      if (Date.now() >= deadline) {
        const holder = getCurrentHolder(key)
        throw new LockNotAcquiredError(key, holder?.owner, holder ? new Date(holder.expires_at) : null)
      }

      // Wait and retry
      await new Promise(r => setTimeout(r, retryEvery))
    }
  }

  async function release(key, owner) {
    ensureTable()
    if (owner) {
      rawWriteDb.run(`DELETE FROM "${LOCKS_TABLE}" WHERE "key" = ? AND "owner" = ?`, key, owner)
    } else {
      rawWriteDb.run(`DELETE FROM "${LOCKS_TABLE}" WHERE "key" = ?`, key)
    }
    // Idempotent — no error if already released
  }

  async function heartbeat(key, owner, ttl = 30_000) {
    ensureTable()
    rawWriteDb.run(
      `UPDATE "${LOCKS_TABLE}" SET "expires_at" = ?, "heartbeat_at" = ? WHERE "key" = ? AND "owner" = ?`,
      Date.now() + ttl, Date.now(), key, owner
    )
  }

  function isHeld(key) {
    ensureTable()
    const row = rawWriteDb.prepare(
      `SELECT "expires_at" FROM "${LOCKS_TABLE}" WHERE "key" = ?`
    ).get(key)
    if (!row) return false
    return row.expires_at > Date.now()
  }

  function list() {
    ensureTable()
    const now  = Date.now()
    const rows = rawWriteDb.prepare(
      `SELECT * FROM "${LOCKS_TABLE}" WHERE "expires_at" > ? ORDER BY "acquired_at" ASC`
    ).all(now)
    return rows.map(r => ({
      key:         r.key,
      owner:       r.owner,
      acquiredAt:  new Date(r.acquired_at),
      expiresAt:   new Date(r.expires_at),
      heartbeatAt: new Date(r.heartbeat_at),
    }))
  }

  // ── $lock(key, fn, opts) — main convenience API ──────────────────────────

  async function $lock(key, fn, opts = {}) {
    // SYSTEM bypass — skip lock entirely for migrations, data repair, seeding
    if (getIsSystem?.()) return fn()

    const lock = await acquire(key, opts)
    try {
      return await fn()
    } finally {
      await lock.release().catch(() => {})   // always release, swallow expired errors
    }
  }

  $lock.acquire   = acquire
  $lock.release   = release
  $lock.heartbeat = heartbeat
  $lock.isHeld    = isHeld
  $lock.list      = list

  // Expose $locks as an alias namespace
  $lock.$locks = { acquire, release, heartbeat, isHeld, list }

  return $lock
}

  // Main connection aliases — used by transaction manager, backup, attach, etc.
  const { rawWriteDb, rawReadDb, writeDb, readDb } = dbRegistry.main

  // ── Auto-apply DDL for fresh databases ────────────────────────────────────
  // Only runs when a sqlite DB has zero user tables — i.e. brand-new file.
  // Skips the sqlite_master query entirely when the DB file already has size > 4KB
  // (SQLite page size is 4KB minimum; an empty DB is exactly one page).
  {
    let ddlMods = null
    for (const [dbName, conn] of Object.entries(dbRegistry)) {
      if (conn.driver !== 'sqlite' || !conn.rawWriteDb || !conn.absPath) continue
      // Fast skip: if the file is larger than one empty SQLite page, tables exist
      const absPath = conn.absPath
      if (absPath !== ':memory:') {
        try {
          const { statSync } = await import('fs')
          if (statSync(absPath).size > 8192) continue   // clearly not empty
        } catch {}
      }
      const existing = conn.rawWriteDb.query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestone%' AND name NOT LIKE '_locks%'`
      ).all()
      if (existing.length === 0) {
        if (!ddlMods) {
          const [{ generateDDL }, { splitStatements }] = await Promise.all([
            import('./ddl.js'), import('./migrate.js')
          ])
          ddlMods = { generateDDL, splitStatements }
        }
        for (const stmt of ddlMods.splitStatements(ddlMods.generateDDL(schema))) {
          if (!stmt.startsWith('PRAGMA')) conn.rawWriteDb.run(stmt)
        }
      }
    }
  }

  const computedFns   = await loadComputedFields(computedInput)

  // ── Lock primitive — auto-creates _locks in main db on first use ──────────
  let _isSystemCtx = false
  const lockPrimitive = makeLockPrimitive(rawWriteDb, () => _isSystemCtx)

  // ── Build log map ──────────────────────────────────────────────────────────
  // Scans schema for @log/@@@log attributes — used by makeTable to fire entries.
  const logMap = buildLogMap(schema)

  // ── SQLite retention — run on startup ──────────────────────────────────────
  // For each SQLite database with a retention policy, delete rows older than
  // the declared period from every model in that database with a createdAt field.
  for (const [dbName, conn] of Object.entries(dbRegistry)) {
    if (conn.driver === 'sqlite' && conn.retention && conn.rawWriteDb) {
      const dbModels = schema.models.filter(m => {
        const dbAttr = m.attributes.find(a => a.kind === 'db')
        return (dbAttr?.name ?? 'main') === dbName
      })
      runSqliteRetention(conn.rawWriteDb, dbModels, conn.retention)
    }
  }
  const jsonMap       = buildJsonMap(schema)
  const generatedMap  = buildGeneratedMap(schema)
  const fromMap       = buildFromMap(schema, pluralizeTableNames)
  const computedSets  = buildComputedSet(schema)
  const relationMap   = buildRelationMap(schema)
  const softDeleteMap        = buildSoftDeleteMap(schema)
  const softDeleteCascadeMap = buildSoftDeleteCascadeMap(schema)
  const boolMap        = buildBoolMap(schema)
  const autoIdMap      = buildAutoIdMap(schema)
  const authDefaultMap     = buildAuthDefaultMap(schema)
  const fieldRefDefaultMap = buildFieldRefDefaultMap(schema)
  const updatedByMap       = buildUpdatedByMap(schema)
  const selfRelationMap    = buildSelfRelationMap(schema)
  const sequenceMap    = buildSequenceMap(schema)
  const enumMap        = buildEnumMap(schema)
  const transitionMap  = buildTransitionMap(schema)
  const ftsMap        = buildFtsMap(schema)
  const validationMap  = buildValidationMap(schema)
  const fieldPolicyMap = buildFieldPolicyMap(schema)
  const secretMap      = buildSecretMap(schema)
  const policyMap      = buildPolicyMap(schema)
  const hookRunner     = buildHookRunner(hooks ?? null)
  const emitter        = buildEventEmitter(onEvent ?? null)

  // Create sequence counter table on every database that has @sequence fields
  if (Object.keys(sequenceMap).length > 0) {
    const seqDbs = new Set(Object.keys(sequenceMap).map(m => modelDbMap[m] ?? 'main'))
    for (const dbName of seqDbs) {
      const conn = dbRegistry[dbName]
      if (conn?.rawWriteDb) ensureSequenceTable(conn.rawWriteDb)
    }
  }

  // Validate encryption key — fail fast if @encrypted fields exist but no key given
  const encKey = normaliseKey(encryptionKey ?? null)
  const hasEncryptedFields = schema.models.some(m =>
    m.fields.some(f => f.attributes.find(a => a.kind === 'encrypted'))
  )
  if (hasEncryptedFields && !encKey) {
    throw new Error(
      'Schema has @encrypted fields but no encryption key was provided.\n' +
      'Pass { encryptionKey: process.env.ENCRYPTION_KEY } to createClient().'
    )
  }
  if (encKey && encKey.length !== 32) {
    throw new Error(`Encryption key must be 32 bytes (got ${encKey.length}). Use a 32-byte (64 hex char) key.`)
  }

  // Model index for validation + transforms inside makeTable
  const modelIndex = Object.fromEntries(schema.models.map(m => [m.name, m]))

  // Type index for typed-JSON validation. `Json @type(T)` field lookups need a
  // way to find the type's shape. Keyed by type name. Empty Map if no types
  // declared — keeps the makeTable hot path branch-free.
  const typeMap = new Map((schema.types ?? []).map(t => [t.name, t]))

  // Warn about @computed fields with no extension
  for (const model of schema.models) {
    for (const field of computedSets[model.name] ?? []) {
      if (!computedFns?.[model.name]?.[field]) {
        console.warn(`⚠  @computed field "${model.name}.${field}" has no compute function defined`)
      }
    }
  }

  // Transaction manager operates on the write connection
  const tx = makeTxManager(writeDb)

  // Normalise global filters: { tableName: whereObject | (ctx) => whereObject }
  const globalFilters = filters ?? {}

  // Plugin runner — orchestrates all installed plugins
  const pluginRunner = new PluginRunner(plugins ?? [])

  // Shared context threaded through include resolution + table ops
  const ctx = {
    relationMap, jsonMap, computedSets,
    softDeleteMap, softDeleteCascadeMap, ftsMap, boolMap, enumMap, autoIdMap, authDefaultMap, fieldRefDefaultMap, updatedByMap, selfRelationMap, sequenceMap, computedFns, tx,
    transitionMap,
    models:        modelIndex,
    schema,
    hasValidation: validationMap,
    typeMap,
    fieldPolicyMap,
    policyMap,
    hasPolicies:   Object.keys(policyMap).length > 0,
    policyDebug,
    encKey,
    isSystem:      false,
    hookRunner,
    emitter,
    globalFilters,
    plugins:       pluginRunner,
    auth:          null,
    readDb,
    logMap,
    onLog:        onLog ?? null,
    onQuery:       onQuery ?? null,
    _queryListeners: new Set(),    // runtime taps — shared ref across all scoped ctx copies
    modelDbMap,
    pluralize:     pluralizeTableNames,   // used by makeTable to derive child SQL table names during cascades
    // Map of dbName → { logModel } for driver:logger databases — used by makeTable
    loggerDbMap:   Object.fromEntries(
      Object.entries(dbRegistry)
        .filter(([, v]) => v.driver === 'logger')
        .map(([k, v]) => [k, { logModel: v.logModel }])
    ),
  }

  // Init plugins — runs onInit for all plugins with schema + ctx
  pluginRunner.init(schema, ctx)

  // Track jsonl table instances so _closeAll can close their index dbs
  const jsonlTables = []

  // JSONL tables are stateless with respect to auth context — they don't use ctx
  // (no field policies, no gate checks, no hooks). Create once and share across
  // all makeAllTables calls so compaction only runs once per createClient().
  const jsonlTableCache = {}
  for (const model of schema.models) {
    const dbName = modelDbMap[model.name] ?? 'main'
    const conn   = dbRegistry[dbName] ?? dbRegistry.main
    if (conn.driver === 'jsonl' || conn.driver === 'logger') {
      const filePath = jsonlFilePath(conn.absPath, model.name)
      const table    = makeJsonlTable(filePath, model, schema, conn.retention, conn.maxSize)
      jsonlTableCache[model.name] = table
      jsonlTables.push(table)
    }
  }

  // Expose jsonlTableCache on ctx so makeTable log hooks can look up log tables by model name
  ctx.jsonlTableCache = jsonlTableCache

  // makeAllTables — builds all table handlers with per-model database routing.
  // Called once for the main client, and again for each asSystem()/setAuth() scope.
  function makeAllTables(ctx) {
    const tables = {}

    // ── Models ──────────────────────────────────────────────────────────────
    for (const model of schema.models) {
      const dbName    = modelDbMap[model.name] ?? 'main'
      const conn      = dbRegistry[dbName] ?? dbRegistry.main
      const accessor  = modelToAccessor(model.name)
      const sqlTable  = modelToTableName(model, pluralizeTableNames)

      if (conn.driver === 'jsonl' || conn.driver === 'logger') {
        tables[accessor] = jsonlTableCache[model.name]
      } else {
        tables[accessor] = makeTable(
          conn.readDb,
          conn.writeDb,
          sqlTable,
          model.name,
          jsonMap[model.name]              ?? new Set(),
          generatedMap[model.name]         ?? new Set(),
          computedSets[model.name]         ?? new Set(),
          softDeleteMap[model.name]        ?? false,
          ftsMap[model.name]               ?? null,
          boolMap[model.name]              ?? new Set(),
          enumMap[model.name]              ?? {},
          softDeleteCascadeMap[model.name] ?? false,
          fieldPolicyMap[model.name]       ?? {},
          fromMap[model.name]              ?? {},
          ctx,
        )
      }
    }

    // ── Views ───────────────────────────────────────────────────────────────
    // Views are read-only. Regular views (CREATE VIEW) and materialized views
    // (real tables) both use makeTable for read operations; writes are blocked.
    for (const view of (schema.views ?? [])) {
      const dbName = view.db ?? 'main'
      const conn   = dbRegistry[dbName] ?? dbRegistry.main
      if (conn.driver === 'jsonl' || conn.driver === 'logger') continue

      const baseTable = makeTable(
        conn.readDb,
        conn.writeDb,
        view.name,
        view.name,
        new Set(), new Set(), new Set(),
        false, null, new Set(), {},
        false, {}, {},
        ctx,
      )

      const writeBlocked = () => {
        throw new Error(`"${view.name}" is a view — write operations are not supported`)
      }
      tables[view.name] = {
        findMany:          baseTable.findMany.bind(baseTable),
        findFirst:         baseTable.findFirst.bind(baseTable),
        findUnique:        baseTable.findUnique.bind(baseTable),
        findFirstOrThrow:  baseTable.findFirstOrThrow.bind(baseTable),
        findUniqueOrThrow: baseTable.findUniqueOrThrow.bind(baseTable),
        count:             baseTable.count.bind(baseTable),
        findManyCursor:    baseTable.findManyCursor.bind(baseTable),
        create: writeBlocked, createMany: writeBlocked,
        update: writeBlocked, updateMany: writeBlocked,
        upsert: writeBlocked, upsertMany: writeBlocked,
        remove: writeBlocked, removeMany: writeBlocked,
        restore: writeBlocked, delete: writeBlocked,
        deleteMany: writeBlocked, search: writeBlocked,
        optimizeFts: writeBlocked,
      }
    }

    return tables
  }

  const tables = makeAllTables(ctx)

  // Expose tables on ctx so makeTable can do recursive nested writes
  ctx.tables = tables

  // ── Scopes ─────────────────────────────────────────────────────────────────
  // Reusable named query fragments registered by the app at createClient time.
  // See docs/querying.md → Scopes for the full design.
  //
  // scopeRegistry: { ModelName: { scopeName: scopeDef, ... } }
  //
  // A scopeDef is one of:
  //   - { where, orderBy?, limit?, ... }            — static args (object literal)
  //   - { where: (ctx) => ({ ... }), ... }          — dynamic where, evaluated per-call
  //
  // Parameterised scopes are NOT supported — write a function that returns a
  // where clause and pass it as a caller override instead. See spec for rationale.
  //
  // Internal shape after validation: scopesByAccessor[accessor][scopeName] = scopeDef
  const scopesByAccessor = {}

  // Methods that scopes are not allowed to shadow. Computed from a real table
  // accessor at runtime so this list updates automatically when methods are added.
  // We pick any non-view table to introspect — views have a reduced surface.
  const reservedMethodNames = (() => {
    const sample = Object.values(tables).find(t => t && typeof t.findMany === 'function' && typeof t.create === 'function')
    if (!sample) return new Set(['findMany','findFirst','findUnique','count','create','update','remove','delete','aggregate','groupBy','query'])
    return new Set(Object.keys(sample).filter(k => typeof sample[k] === 'function'))
  })()

  for (const [modelName, scopeMap] of Object.entries(scopeRegistry)) {
    const model = modelIndex[modelName]
    if (!model) {
      throw new Error(`scopes: unknown model "${modelName}". Schema models: ${Object.keys(modelIndex).join(', ')}`)
    }
    const accessor = modelToAccessor(modelName)
    if (!tables[accessor]) {
      throw new Error(`scopes: model "${modelName}" has no table accessor (driver may not support scopes)`)
    }

    // Relation field names on this model — scope names that match a relation
    // are confusing because users might expect `db.user.posts()` to mean a query.
    const relationFieldNames = new Set(
      model.fields
        .filter(f => f.type?.kind === 'relation')
        .map(f => f.name)
    )

    const validatedScopes = {}
    for (const [scopeName, rawScope] of Object.entries(scopeMap ?? {})) {
      // Name guards
      if (scopeName.startsWith('_') || scopeName.startsWith('$')) {
        throw new Error(`scopes: "${modelName}.${scopeName}" — scope names cannot start with "_" or "$" (reserved for internals)`)
      }
      if (reservedMethodNames.has(scopeName)) {
        throw new Error(`scopes: "${modelName}.${scopeName}" conflicts with a built-in table method. Pick another name.`)
      }
      if (relationFieldNames.has(scopeName)) {
        throw new Error(`scopes: "${modelName}.${scopeName}" conflicts with the relation field of the same name. Pick another name.`)
      }

      // Shape guard. We accept anything object-shaped — runtime mistakes (typos
      // in keys) surface naturally when the scope is used. We do NOT accept
      // a top-level function: that would have meant a parameterised scope, which
      // is intentionally not supported in v1 (see spec).
      if (rawScope == null || typeof rawScope !== 'object' || Array.isArray(rawScope)) {
        throw new Error(`scopes: "${modelName}.${scopeName}" must be an object like { where, orderBy?, limit?, ... }. Got ${Array.isArray(rawScope) ? 'an array' : typeof rawScope}.`)
      }

      validatedScopes[scopeName] = rawScope
    }

    scopesByAccessor[accessor] = validatedScopes
  }

  // ── mergeScopeArgs ─────────────────────────────────────────────────────────
  // Combines a stack of resolved scope args with a caller's args object.
  // Rules:
  //   - where: AND of all non-null where clauses (scope where's, then caller's)
  //   - other keys (orderBy, limit, offset, include, select, distinct,
  //     withDeleted, onlyDeleted, etc.): last writer wins, with caller as final
  //
  // resolvedScopeArgs: array of {where?, orderBy?, ...} in left-to-right order.
  // callerArgs: the user's own args object passed to the terminal method, or null.
  function mergeScopeArgs(resolvedScopeArgs, callerArgs) {
    const out = {}
    const wheres = []

    const apply = (a) => {
      if (!a) return
      for (const [k, v] of Object.entries(a)) {
        if (k === 'where') {
          if (v != null) wheres.push(v)
        } else {
          out[k] = v   // last write wins
        }
      }
    }

    for (const sa of resolvedScopeArgs) apply(sa)
    apply(callerArgs)

    if (wheres.length === 1) out.where = wheres[0]
    else if (wheres.length > 1) out.where = { AND: wheres }
    return out
  }

  // ── resolveScopeStack ─────────────────────────────────────────────────────
  // Evaluates a stack of scope definitions against a ctx, materialising
  // dynamic `where` functions. Returns array of resolved arg objects.
  function resolveScopeStack(scopeStack, evalCtx) {
    return scopeStack.map(scopeDef => {
      const out = {}
      for (const [k, v] of Object.entries(scopeDef)) {
        if (k === 'where' && typeof v === 'function') {
          out.where = v(evalCtx)
        } else {
          out[k] = v
        }
      }
      return out
    })
  }

  // ── buildScopedAccessor ───────────────────────────────────────────────────
  // Given a real table accessor and a stack of scope defs, build a callable
  // function-with-properties:
  //
  //   - Calling it (`accessor()`) → findMany under the scope stack
  //   - accessor.findMany / .findFirst / .count / .aggregate / .groupBy / etc.
  //     all work and merge scope args before forwarding
  //   - accessor.<scopeName> → another scoped accessor (chaining)
  //
  // Methods that don't take a where-shaped first arg (search, optimizeFts) are
  // exposed as-is when no scope stack would change behaviour, otherwise throw.
  //
  // tableAccessor: the real table object from `tables[accessor]`
  // scopeStack:    array of scope defs accumulated so far (left-to-right)
  // scopeMap:      { scopeName: scopeDef } — for further chaining
  // ctxResolver:   () => ctx — gives current ctx for dynamic where (so auth
  //                changes per $setAuth call don't get baked in at build time)
  function buildScopedAccessor(tableAccessor, scopeStack, scopeMap, ctxResolver) {
    // Methods that take a standard {where, orderBy, ...} arg and benefit from
    // scope merging. Listed explicitly so we know to forward through merge.
    const SCOPED_READ_METHODS = ['findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy', 'findManyCursor', 'query']

    // Build the merged-args function for a single method
    const wrapMethod = (methodName) => {
      const fn = tableAccessor[methodName]
      if (typeof fn !== 'function') return undefined
      return (callerArgs = {}) => {
        const evalCtx = ctxResolver()
        const resolved = resolveScopeStack(scopeStack, evalCtx)
        const merged   = mergeScopeArgs(resolved, callerArgs)
        return fn.call(tableAccessor, merged)
      }
    }

    // Default-call → findMany under the scope. Function form so users can use
    // `db.customer.active()` directly without remembering the method name.
    const callable = (callerArgs = {}) => wrapMethod('findMany')(callerArgs)

    // Attach all standard read methods.
    for (const m of SCOPED_READ_METHODS) {
      const wrapped = wrapMethod(m)
      if (wrapped) callable[m] = wrapped
    }

    // search() takes a query string + opts, not {where, ...}. We allow it but
    // post-AND the scope where via opts.where, which is the natural composition.
    if (typeof tableAccessor.search === 'function') {
      callable.search = (queryStr, opts = {}) => {
        const evalCtx  = ctxResolver()
        const resolved = resolveScopeStack(scopeStack, evalCtx)
        const merged   = mergeScopeArgs(resolved, opts)
        return tableAccessor.search(queryStr, merged)
      }
    }

    // Writes (create/update/remove/etc.) under a scope are intentionally NOT
    // exposed. A scope is a read-time filter, not a write target. If users
    // want to write through a scope's filter they can call
    // db.<model>.updateMany({ where: ... }) directly.

    // Attach scope-name properties for chaining. Each one returns a NEW scoped
    // accessor with the scope appended to the stack. We define these lazily as
    // getters so the closure captures `name` correctly.
    for (const [name, def] of Object.entries(scopeMap ?? {})) {
      Object.defineProperty(callable, name, {
        enumerable: true,
        get() {
          return buildScopedAccessor(tableAccessor, [...scopeStack, def], scopeMap, ctxResolver)
        },
      })
    }

    return callable
  }

  // ── installScopes ─────────────────────────────────────────────────────────
  // Wraps a tables object so that each model accessor exposes its scopes as
  // properties. The original table (with all methods) remains directly callable
  // — scopes are added on top.
  //
  // For chaining, each scope returns a buildScopedAccessor (a function-with-
  // properties) that itself exposes all the model's scope names as further
  // chaining points.
  //
  // ctxResolver lets each scope resolution see the current ctx — important
  // for auth-scoped clients where ctx.auth changes per $setAuth() call.
  function installScopes(tablesObj, ctxResolver) {
    if (!Object.keys(scopesByAccessor).length) return tablesObj

    const out = { ...tablesObj }
    for (const [accessor, scopeMap] of Object.entries(scopesByAccessor)) {
      const tableAccessor = out[accessor]
      if (!tableAccessor) continue

      // Wrap the table accessor: same methods, plus scope properties as getters.
      // Use a Proxy so we don't modify the original tableAccessor (which might
      // be referenced elsewhere — by ctx.tables, by the unscoped client, etc.)
      const wrapper = new Proxy(tableAccessor, {
        get(target, prop) {
          if (typeof prop === 'string' && scopeMap[prop]) {
            return buildScopedAccessor(target, [scopeMap[prop]], scopeMap, ctxResolver)
          }
          return Reflect.get(target, prop)
        },
        has(target, prop) {
          return Reflect.has(target, prop) || (typeof prop === 'string' && prop in scopeMap)
        },
        ownKeys(target) {
          return [...Reflect.ownKeys(target), ...Object.keys(scopeMap)]
        },
        getOwnPropertyDescriptor(target, prop) {
          if (typeof prop === 'string' && scopeMap[prop]) {
            return { configurable: true, enumerable: true, get: () => buildScopedAccessor(target, [scopeMap[prop]], scopeMap, ctxResolver) }
          }
          return Reflect.getOwnPropertyDescriptor(target, prop)
        },
      })
      out[accessor] = wrapper
    }
    return out
  }

  // Apply scopes to the main tables. Auth/system proxies install their own
  // scope wrappers below using their own ctxResolver.
  const scopedTables = installScopes(tables, () => ctx)

  // $transaction — wraps async callback in BEGIN IMMEDIATE / COMMIT
  let clientProxy
  async function $transaction(fn) {
    const sp = tx.begin()
    try {
      const result = await fn(clientProxy)
      tx.commit(sp)
      return result
    } catch (e) {
      tx.rollback(sp)
      throw e
    }
  }

  // ── query — multi-model dispatcher ─────────────────────────────────────────
  // Runs many per-table query() calls in one snapshot transaction and returns
  // a named-result object keyed by the spec's keys.
  //
  // Each entry routes through the per-table query() dispatcher, which itself
  // routes by shape — args.by → groupBy, agg keys → aggregate, else findMany.
  //
  // Spec keys are either:
  //   - a model accessor name (e.g. `user`, `order`) — runs db[key].query(args)
  //   - any name + an explicit `model:` field — runs db[args.model].query(rest)
  //     (lets you query the same model multiple times with different args)
  //
  // Snapshot consistency: all reads observe the same point-in-time. If any one
  // entry throws, the whole batch fails (transaction rolls back). For partial
  // tolerance, call db.<model>.query() per model and use Promise.allSettled().
  //
  // Designed for API layers that take query descriptors from untrusted input
  // (e.g. a single HTTP endpoint that accepts a JSON body of name→args).
  //
  // Examples:
  //   const { user, order } = await db.query({
  //     user:  { where: { status: 'active' }, limit: 10 },
  //     order: { _count: true, _sum: { amount: true } },
  //   })
  //
  //   // Aliased — same model queried twice
  //   const { activeUsers, inactiveUsers } = await db.query({
  //     activeUsers:   { model: 'user', where: { active: true } },
  //     inactiveUsers: { model: 'user', where: { active: false } },
  //   })
  async function query(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec))
      throw new Error('db.query: spec must be an object of { name: queryArgs, ... }')

    return $transaction(async (tx) => {
      const out = {}
      for (const [key, rawArgs] of Object.entries(spec)) {
        const args = rawArgs ?? {}
        // Alias form: { someKey: { model: 'user', ...args } } — strips `model`
        // before dispatch so the per-table query() doesn't see it.
        const accessor = args.model ?? key
        const tbl = tx[accessor]
        if (!tbl)
          throw new Error(`db.query: '${accessor}' is not a model accessor. Available: ${Object.keys(tables).join(', ')}`)
        if (typeof tbl.query !== 'function')
          throw new Error(`db.query: '${accessor}' has no query() method`)
        const { model: _drop, ...passArgs } = args
        out[key] = await tbl.query(passArgs)
      }
      return out
    })
  }

  async function sql(strings, ...values) {
    let query = ''
    for (let i = 0; i < strings.length; i++) {
      query += strings[i]
      if (i < values.length) query += '?'
    }
    return readDb.query(query.trim()).all(...values)
  }


  // ── $rotateKey ─────────────────────────────────────────────────────────────
  // Re-encrypts all @secret(rotate: true) fields using the current key → newKey.
  // Runs in a single write transaction across all affected databases.
  // Call this when rotating encryption keys. Restart the app with newKey after.
  //
  // Usage:
  //   const stats = await db.$rotateKey(process.env.NEW_ENCRYPTION_KEY)
  //   // → { users: { rows: 42, fields: 1 }, payments: { rows: 7, fields: 2 } }
  //
  // Fields marked @secret(rotate: false) are skipped — they stay bound to
  // the original key and must be migrated manually if the key changes.

  async function $rotateKey(rawNewKey) {
    // Early return if no @secret fields — nothing to rotate, no key required
    if (!Object.keys(secretMap).length) return {}

    if (!ctx.encKey)
      throw new Error('$rotateKey requires an encryption key on this client — pass { encryptionKey: process.env.ENCRYPTION_KEY } to createClient()')

    const newKey = normaliseKey(rawNewKey)
    if (!newKey || newKey.length !== 32)
      throw new Error('New encryption key must be 32 bytes (64 hex chars)')

    const results = {}

    // Group rotatable fields by their target database so each DB gets one transaction
    const byDb = {}
    for (const [modelName, fields] of Object.entries(secretMap)) {
      const rotatableFields = Object.entries(fields)
        .filter(([, opts]) => opts.rotate)
        .map(([fieldName]) => fieldName)
      if (!rotatableFields.length) continue

      const modelDef = schema.models.find(m => m.name === modelName)
      const dbName   = modelDef?.attributes.find(a => a.kind === 'db')?.name ?? 'main'
      if (!byDb[dbName]) byDb[dbName] = []
      byDb[dbName].push({ modelName, modelDef, rotatableFields })
    }

    for (const [dbName, models] of Object.entries(byDb)) {
      const conn = dbRegistry[dbName]
      const rawDb = conn?.rawWriteDb
      if (!rawDb) continue   // jsonl or disabled — skip

      for (const { modelName, modelDef, rotatableFields } of models) {
        const tableName = modelToTableName(modelDef, pluralizeTableNames)
        const cols      = rotatableFields.map(f => `"${f}"`).join(', ')
        // Alias rowid explicitly — when a table has INTEGER PRIMARY KEY, rowid
        // is an alias for that column and SQLite's driver collapses the duplicate,
        // dropping the `rowid` key from the returned row object.
        const rows      = rawDb.query(`SELECT rowid AS __litestone_rowid, ${cols} FROM "${tableName}"`).all()
        let   updated   = 0

        for (const row of rows) {
          const sets = []
          const vals = []
          for (const fieldName of rotatableFields) {
            if (row[fieldName] == null) continue
            const plain = decryptField(row[fieldName], ctx.encKey)
            sets.push(`"${fieldName}" = ?`)
            vals.push(encryptField(plain, newKey))
          }
          if (!sets.length) continue
          rawDb.run(`UPDATE "${tableName}" SET ${sets.join(', ')} WHERE rowid = ?`, ...vals, row.__litestone_rowid)
          updated++
        }

        results[modelName] = { rows: updated, fields: rotatableFields.length }
      }
    }

    // Update ctx.encKey so subsequent reads/writes on this client use the new key
    if (Object.keys(results).length > 0) ctx.encKey = newKey

    return results
  }


  // ── $backup ────────────────────────────────────────────────────────────────
  // Hot backup — copies the live database to a file while it's running.
  // Safe to call at any time, including during active reads/writes.
  // Uses Bun's db.serialize() which reads the committed db state atomically.
  //
  // Usage:
  //   await db.$backup('./backups/prod-2024-01-15.db')
  //   await db.$backup('./backup.db', { vacuum: true })  // VACUUM INTO — compact first

  function $walStatus() {
    // PRAGMA wal_checkpoint=NOOP (SQLite 3.51.0+) reports WAL frame counts
    // without triggering a checkpoint. Safe to call at any time, even under load.
    // Returns: { busy, frames, checkpointed }
    //   busy:         true if a checkpoint is blocked by active readers
    //   frames:       total WAL frames since last full checkpoint
    //   checkpointed: frames already checkpointed
    // For multi-DB schemas returns { dbName: { busy, frames, checkpointed }, ... }
    const result = {}
    for (const [name, conn] of Object.entries(dbRegistry)) {
      if (!conn.rawWriteDb) continue
      try {
        const row = conn.rawWriteDb.query('PRAGMA wal_checkpoint(NOOP)').get()
        result[name] = row
          ? { busy: row.busy === 1, frames: row.log, checkpointed: row.checkpointed }
          : null
      } catch { result[name] = null }
    }
    const keys = Object.keys(result)
    return keys.length === 1 ? result[keys[0]] : result
  }

  async function $backup(destPath, { vacuum = false } = {}) {
    const abs = resolve(destPath)

    // SQLite-only — backs up all open SQLite connections.
    // For a full backup including JSONL/logger databases, use: litestone backup
    const sqliteDbs = Object.entries(dbRegistry)
      .filter(([, conn]) => conn.driver === 'sqlite' && conn.rawWriteDb)

    async function backupOne(db, dest) {
      if (vacuum) {
        db.run(`PRAGMA wal_checkpoint(TRUNCATE)`)
        db.prepare(`VACUUM INTO ?`).run(dest)
      } else {
        if (typeof db.serialize === 'function') {
          const bytes = db.serialize()
          await Bun.write(dest, bytes)
        } else {
          db.run(`PRAGMA wal_checkpoint(TRUNCATE)`)
          db.prepare(`VACUUM INTO ?`).run(dest)
        }
      }
      return (await Bun.file(dest).stat()).size
    }

    if (sqliteDbs.length > 1) {
      mkdirSync(abs, { recursive: true })
      const results = {}
      for (const [name, conn] of sqliteDbs) {
        const dest = resolve(abs, `${name}.db`)
        results[name] = { driver: 'sqlite', path: dest, size: await backupOne(conn.rawWriteDb, dest), vacuumed: vacuum }
      }
      return results
    }

    const size = await backupOne(rawWriteDb, abs)
    return { path: abs, size, vacuumed: vacuum }
  }

  // ── $attach ────────────────────────────────────────────────────────────────
  // Attach another SQLite database file under an alias.
  // After attaching, all db.sql queries can reference alias.tableName.
  // Both the write connection and read connection attach the same file.
  //
  // Usage:
  //   await db.$attach('./archive.db', 'archive')
  //   const rows = await db.sql`SELECT * FROM users UNION ALL SELECT * FROM archive.users`
  //   await db.$detach('archive')

  const _attached = new Set()

  function $attach(filePath, alias) {
    const abs = resolve(filePath)
    if (_attached.has(alias)) {
      throw new Error(`alias "${alias}" is already attached — call $detach("${alias}") first`)
    }
    // Attach on both connections so reads and writes can both access it
    rawWriteDb.prepare(`ATTACH DATABASE ? AS "${alias}"`).run(abs)
    rawReadDb.prepare(`ATTACH DATABASE ? AS "${alias}"`).run(abs)
    _attached.add(alias)
    return clientProxy  // chainable: await db.$attach('a.db', 'a').$attach('b.db', 'b')
  }

  function $detach(alias) {
    if (!_attached.has(alias)) {
      throw new Error(`alias "${alias}" is not attached`)
    }
    rawWriteDb.prepare(`DETACH DATABASE "${alias}"`).run()
    rawReadDb.prepare(`DETACH DATABASE "${alias}"`).run()
    _attached.delete(alias)
    return clientProxy
  }

  function $attachedDatabases() {
    return [..._attached]
  }

  // db.asSystem() — returns a scoped wrapper where ctx.isSystem = true.
  // All table operations through this wrapper bypass @guarded, @encrypted,
  // and @@gate checks. Use for auth checks, background jobs, admin operations.
  //
  // Memoized — built once on first call, same instance returned every time.
  // This is intentional and safe: asSystem() carries no per-request state
  // (no auth, no user identity). It is purely a capability flag on a shared
  // read/write connection. In multi-tenant setups, all tenants share the same
  // asSystem() instance — that is correct because the system context is
  // explicitly identity-free by design.
  //
  // If you need both system-level access AND a user identity (e.g. for audit
  // logging), use db.$setAuth(user).asSystem() instead — that path is NOT
  // memoized and creates a fresh scoped client per user.
  let _systemProxy = null
  function asSystem() {
    if (_systemProxy) return _systemProxy
    const sysCtx = { ...ctx, isSystem: true }
    const rawSysTables = makeAllTables(sysCtx)
    sysCtx.tables = rawSysTables
    // Apply scopes — system ctx is fixed for the lifetime of asSystem(), so the
    // ctxResolver returns sysCtx directly.
    const sysTables = installScopes(rawSysTables, () => sysCtx)
    async function sysSql(strings, ...values) {
      let query = ''
      for (let i = 0; i < strings.length; i++) {
        query += strings[i]
        if (i < values.length) query += '?'
      }
      return readDb.query(query.trim()).all(...values)
    }
    const sys$lock = async (key, fn, opts = {}) => fn()
    sys$lock.acquire   = lockPrimitive.acquire ?? lockPrimitive.$locks?.acquire
    sys$lock.release   = lockPrimitive.release ?? lockPrimitive.$locks?.release
    sys$lock.heartbeat = lockPrimitive.heartbeat ?? lockPrimitive.$locks?.heartbeat
    sys$lock.isHeld    = lockPrimitive.isHeld ?? lockPrimitive.$locks?.isHeld
    sys$lock.list      = lockPrimitive.list ?? lockPrimitive.$locks?.list
    sys$lock.$locks    = lockPrimitive.$locks

    // System-scoped multi-model query — uses sysTables so each batched query
    // bypasses gate/policies/guarded fields, matching this proxy's contract.
    async function sysQuery(spec) {
      if (!spec || typeof spec !== 'object' || Array.isArray(spec))
        throw new Error('db.query: spec must be an object of { name: queryArgs, ... }')
      return $transaction(async () => {
        const out = {}
        for (const [key, rawArgs] of Object.entries(spec)) {
          const args = rawArgs ?? {}
          const accessor = args.model ?? key
          const tbl = sysTables[accessor]
          if (!tbl)
            throw new Error(`db.query: '${accessor}' is not a model accessor. Available: ${Object.keys(sysTables).join(', ')}`)
          if (typeof tbl.query !== 'function')
            throw new Error(`db.query: '${accessor}' has no query() method`)
          const { model: _drop, ...passArgs } = args
          out[key] = await tbl.query(passArgs)
        }
        return out
      })
    }

    _systemProxy = new Proxy({ sql: sysSql, query: sysQuery, $transaction, $backup, $walStatus, $rotateKey, $attach, $detach, $db: rawWriteDb, $lock: sys$lock, $locks: lockPrimitive.$locks }, {
      get(target, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'then' || prop === 'catch' || prop === 'finally' || prop === 'toJSON') return undefined
        if (prop in target)     return Reflect.get(target, prop)
        if (prop in sysTables)  return sysTables[prop]
        if (prop === '$close')  return () => _closeAll()
        if (prop === '$schema') return schema
        if (prop === '$enums')  return Object.fromEntries(schema.enums.map(e => [e.name, [...e.values.map(v => v.name)]]))
        throw new Error(`"${prop}" is not a table in this schema.`)
      }
    })
    return _systemProxy
  }

  // ── $setAuth ───────────────────────────────────────────────────────────────
  // Returns a new scoped client with ctx.auth set to the given user.
  // Plugins (e.g. GatePlugin) read ctx.auth to determine access level.
  // This is the per-request call — create once at startup, $setAuth per request.
  //
  // Usage:
  //   const db = createClient('./app.db', './schema.lite', { plugins: [...] })
  //   const userDb = db.$setAuth(req.user)
  //   await userDb.posts.findMany()   // policies enforced for req.user
  //
  // Composes with asSystem():
  //   db.asSystem()                  // bypasses field policies + gate (system level 7)
  //   db.$setAuth(user).asSystem()   // auth set but system still bypasses gate

  const _authClients = new WeakMap()
  function $setAuth(user) {
    if (user != null && typeof user === 'object' && _authClients.has(user)) return _authClients.get(user)

    const authCtx = { ...ctx, auth: user }
    const rawAuthTables = makeAllTables(authCtx)
    authCtx.tables = rawAuthTables
    // Apply scopes — auth ctx is fixed for this $setAuth() call, so the
    // ctxResolver returns authCtx directly. Dynamic where(ctx) sees user.
    const authTables = installScopes(rawAuthTables, () => authCtx)

    async function authSql(strings, ...values) {
      let query = ''
      for (let i = 0; i < strings.length; i++) {
        query += strings[i]
        if (i < values.length) query += '?'
      }
      return readDb.query(query.trim()).all(...values)
    }

    // Auth-scoped multi-model query — runs in $transaction but uses the
    // auth proxy's tables (which carry ctx.auth), not the outer client's.
    // Without this, $transaction would pass `clientProxy` (unscoped) and
    // silently strip the auth context from every batched query.
    let _authProxyRef
    async function authQuery(spec) {
      if (!spec || typeof spec !== 'object' || Array.isArray(spec))
        throw new Error('db.query: spec must be an object of { name: queryArgs, ... }')
      return $transaction(async () => {
        const out = {}
        for (const [key, rawArgs] of Object.entries(spec)) {
          const args = rawArgs ?? {}
          const accessor = args.model ?? key
          const tbl = _authProxyRef[accessor]
          if (!tbl)
            throw new Error(`db.query: '${accessor}' is not a model accessor. Available: ${Object.keys(authTables).join(', ')}`)
          if (typeof tbl.query !== 'function')
            throw new Error(`db.query: '${accessor}' has no query() method`)
          const { model: _drop, ...passArgs } = args
          out[key] = await tbl.query(passArgs)
        }
        return out
      })
    }

    const authProxy = new Proxy({ sql: authSql, query: authQuery, $transaction, $backup, $walStatus, $rotateKey, $attach, $detach, $db: rawWriteDb, asSystem, $setAuth }, {
      get(target, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'then' || prop === 'catch' || prop === 'finally' || prop === 'toJSON') return undefined
        if (prop in target)             return Reflect.get(target, prop)
        if (prop === '$setAuth')        return $setAuth
        if (prop === 'asSystem')        return asSystem
        if (prop in authTables)         return authTables[prop]
        if (prop === '$close')          return () => _closeAll()
        if (prop === '$schema')         return schema
        if (prop === '$auth')           return user
        if (prop === '$cacheSize')      return _cacheSize()
        if (prop === '$enums')          return Object.fromEntries(schema.enums.map(e => [e.name, [...e.values.map(v => v.name)]]))
        throw new Error(`"${prop}" is not a table in this schema. Tables: ${Object.keys(authTables).join(', ')}`)
      },
      ownKeys(target) {
        return [...Reflect.ownKeys(target), ...Object.keys(authTables), '$close', '$schema', '$auth', '$cacheSize', '$enums']
      },
      has(target, prop) { return prop in target || prop in authTables },
      getOwnPropertyDescriptor(target, prop) {
        if (prop in authTables) return { configurable: true, enumerable: true, writable: false }
        return Reflect.getOwnPropertyDescriptor(target, prop)
      },
    })

    // Now that authProxy is built, wire it into authQuery's closure so the
    // batched query() resolves accessors against this auth-scoped proxy.
    _authProxyRef = authProxy

    if (user != null && typeof user === 'object') _authClients.set(user, authProxy)
    return authProxy
  }

  // Close all database connections in the registry + jsonl index dbs
  function _closeAll() {
    for (const a of _attached) {
      try { rawWriteDb.prepare(`DETACH DATABASE "${a}"`).run() } catch {}
    }
    // Checkpoint WAL on each SQLite write connection before closing.
    // Prevents large WAL files being left behind and speeds up next open.
    for (const conn of Object.values(dbRegistry)) {
      try { conn.rawWriteDb?.run('PRAGMA wal_checkpoint(TRUNCATE)') } catch {}
      try { conn.rawWriteDb?.close() } catch {}
      try { conn.rawReadDb?.close()  } catch {}
    }
    for (const table of jsonlTables) {
      try { table._close?.() } catch {}
    }
  }

  // Cache size summary across all sqlite databases
  function _cacheSize() {
    const result = {}
    for (const [name, conn] of Object.entries(dbRegistry)) {
      if (conn.driver === 'sqlite' && conn.readDb && conn.writeDb) {
        result[name] = { read: conn.readDb.cacheSize, write: conn.writeDb.cacheSize }
      }
    }
    // Single-DB convenience: return flat { read, write } when only main exists
    const keys = Object.keys(result)
    if (keys.length === 1 && keys[0] === 'main') return result.main
    return result
  }

  clientProxy = new Proxy({ sql, query, $transaction, $backup, $walStatus, $rotateKey, $attach, $detach, $db: rawWriteDb, asSystem, $setAuth }, {
    get(target, prop) {
      if (typeof prop === 'symbol')   return undefined
      if (prop === 'then')            return undefined
      if (prop === 'catch')           return undefined
      if (prop === 'finally')         return undefined
      if (prop === 'toJSON')          return undefined
      if (prop in target)             return Reflect.get(target, prop)
      if (prop === 'asSystem')        return asSystem
      if (prop === '$setAuth')        return $setAuth
      if (prop in scopedTables)       return scopedTables[prop]
      if (prop === '$close')          return () => _closeAll()
      if (prop === '$attached')       return $attachedDatabases()
      if (prop === '$schema')         return schema
      if (prop === '$relations')      return relationMap
      if (prop === '$softDelete')     return softDeleteMap
      if (prop === '$cacheSize')      return _cacheSize()
      if (prop === '$config') {
        const absSchema = schemaFilePath ? resolve(schemaFilePath) : null
        return {
          schemaPath:    absSchema,
          migrationsDir: absSchema ? join(dirname(absSchema), 'migrations') : null,
        }
      }
      if (prop === '$databases')      return Object.fromEntries(Object.entries(dbRegistry).map(([k, v]) => [k, { driver: v.driver, access: v.access, path: v.absPath }]))
      if (prop === '$rawDbs')         return Object.fromEntries(Object.entries(dbRegistry).map(([k, v]) => [k, v.rawWriteDb ?? null]))
      if (prop === '$db')             return rawWriteDb
      if (prop === '$tapQuery')       return (fn) => { ctx._queryListeners.add(fn); return () => ctx._queryListeners.delete(fn) }
      if (prop === '$lock')           return lockPrimitive
      if (prop === '$locks')          return lockPrimitive.$locks
      if (prop === '$enums')          return Object.fromEntries(schema.enums.map(e => [e.name, [...e.values.map(v => v.name)]]))
      throw new Error(`"${prop}" is not a table in this schema. Tables: ${Object.keys(scopedTables).join(', ')}`)
    },
    ownKeys(target) {
      const viewNames = (schema.views ?? []).map(v => v.name)
      return [
        ...Reflect.ownKeys(target),
        ...Object.keys(scopedTables),
        ...viewNames,
        '$close', '$attached', '$schema', '$relations', '$softDelete', '$cacheSize', '$config', '$databases', '$rawDbs', '$tapQuery', '$enums', '$setAuth', '$lock', '$locks', '$db',
      ]
    },
    has(target, prop) {
      return prop in target || prop in scopedTables
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop in scopedTables) return { configurable: true, enumerable: true, writable: false }
      return Reflect.getOwnPropertyDescriptor(target, prop)
    },
  })

  return clientProxy
}
