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
import { detectM2MPairs, buildEdgeMap } from './ddl.js'
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
import { GatePlugin, FrontierGateGetLevel } from '../plugins/gate.js'
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
    // 409: the request conflicts with the row's current state. Junction reads
    // err.status directly — no mapper, no registration — which is the documented
    // contract for an error class you own. Without it this surfaced as a 500
    // GeneralError, telling a caller to retry something that will never work.
    this.status     = 409
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
    // 409 as well, but this one IS worth retrying — the row moved under us.
    this.status    = 409
    this.retryable = true
  }
}

// ─── @version — optimistic concurrency ────────────────────────────────────────
// The same compare-and-swap @@transitions already runs, with the column
// unfrozen: an update narrows its WHERE by the version the caller read, and no
// rows changed against a row that still exists means somebody else got there
// first. Both 409s, and the distinction between them is the useful part —
// one says "you did not tell me which row you read", the other says "you did,
// and it moved".

export class VersionRequiredError extends Error {
  constructor(model, field) {
    super(`${model}.${field} is @version — an update must carry the version it read (data.${field}). Use asSystem() for a write that is not a concurrent editor.`)
    this.name      = 'VersionRequiredError'
    this.model     = model
    this.field     = field
    // 400, not 409: nothing conflicted. The caller left out a required input,
    // and retrying the identical request will fail the identical way.
    this.status    = 400
    this.retryable = false
  }
}

export class VersionConflictError extends Error {
  constructor(model, field, expected, actual) {
    super(`Version conflict on ${model}: expected ${field} ${expected}, row is at ${actual} — it was modified after you read it`)
    this.name      = 'VersionConflictError'
    this.model     = model
    this.field     = field
    this.expected  = expected
    this.actual    = actual
    // 409 + retryable, exactly like TransitionConflictError: re-read and re-apply
    // is a real strategy here, which is what tells a caller to do it.
    this.status    = 409
    this.retryable = true
  }
}

export class TransitionGateError extends Error {
  constructor(model, field, transitionName, required, got) {
    super(`Transition '${transitionName}' on ${model}.${field} requires level ${required}, user has level ${got}`)
    this.name       = 'TransitionGateError'
    this.model      = model
    this.field      = field
    this.transition = transitionName
    this.required   = required
    this.got        = got
    this.status     = 403   // own the mapping — junction reads err.status, no registration needed
    this.retryable  = false
  }
}

export class TransitionNotFoundError extends Error {
  constructor(model, transitionName, available) {
    super(`Transition '${transitionName}' not found on ${model} — available: ${available.length ? available.map(t => `'${t}'`).join(', ') : 'none'}`)
    this.name           = 'TransitionNotFoundError'
    this.model          = model
    this.transition     = transitionName
    // 400: the payload named a transition this model does not declare. That is
    // a malformed request, not a state conflict.
    this.status         = 400
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

// ─── @createdBy map ───────────────────────────────────────────────────────────
// { modelName: [{ field, authField }] }
// @createdBy               → stamps ctx.auth.id on create
// @createdBy(auth().field) → stamps ctx.auth[field] on create
//
// A STAMP, not a default — unlike @default(auth().id) the principal wins over a
// caller-supplied value, so an authenticated caller cannot forge authorship by
// putting the column in the payload. Skipped entirely when ctx.auth is null,
// which is what lets asSystem() seeders and backfills carry authorship in.

// ─── @version map ─────────────────────────────────────────────────────────────
// { modelName: fieldName } — at most one per model, enforced in the parser.

function buildVersionMap(schema) {
  const map = {}
  for (const model of schema.models) {
    const field = model.fields.find(f => f.attributes.some(a => a.kind === 'version'))
    if (field) map[model.name] = field.name
  }
  return map
}

function buildCreatedByMap(schema) {
  const map = {}
  for (const model of schema.models) {
    for (const field of model.fields) {
      const attr = field.attributes.find(a => a.kind === 'createdBy')
      if (!attr) continue
      if (!map[model.name]) map[model.name] = []
      map[model.name].push({ field: field.name, authField: attr.authField ?? 'id' })
    }
  }
  return map
}

// ─── ctx.auth → columns ───────────────────────────────────────────────────────
// The two ways a write picks up the principal, and the one place each lives.
// Both take a { field, authField }[] and return `data` untouched when there is
// nothing to do, so a model with neither allocates nothing.
//
// The distinction is the whole reason @createdBy is not @default(auth().id):
//
//   stampFromAuth     — the principal WINS. @createdBy / @updatedBy. A caller
//                       cannot forge authorship by putting the column in the payload.
//   applyAuthDefaults — the payload WINS. @default(auth().field), which is a
//                       default and documented as one.
//
// Neither fires without ctx.auth, which is what lets asSystem() seeders,
// imports and backfills carry an explicit author in.

function stampFromAuth(data, list, auth) {
  if (!list?.length || !auth) return data
  const stamps = {}
  for (const { field, authField } of list)
    if (auth[authField] != null) stamps[field] = auth[authField]
  return Object.keys(stamps).length ? { ...(data ?? {}), ...stamps } : data
}

function applyAuthDefaults(data, list, auth) {
  if (!list?.length || !auth) return data
  const stamps = {}
  for (const { field, authField } of list)
    if (data?.[field] == null && auth[authField] != null) stamps[field] = auth[authField]
  return Object.keys(stamps).length ? { ...(data ?? {}), ...stamps } : data
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
  // Atomic increment — SQLite serialises all writes so this is race-free.
  // Single statement (upsert + RETURNING) instead of upsert-then-select.
  const row = db.query(
    `INSERT INTO "${SEQUENCE_TABLE}" (model, field, scope, lastNum)
     VALUES (?, ?, ?, 1)
     ON CONFLICT (model, field, scope)
     DO UPDATE SET lastNum = lastNum + 1
     RETURNING lastNum`
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

// ─── Does this schema declare anything raw SQL would bypass? ─────────────────
//
// FJS-005. `sql` goes straight to the read connection: no @@gate, no @@allow,
// no @guarded, no @scoped, no @@softDelete. For a deliberate escape hatch that
// is defensible. What was not defensible is that it was the SAME function on
// every proxy — `db.$setAuth(user).sql` closed over the user and never read it,
// so a caller who had done everything right got every row in the table.
//
// Measured on one model with @@allow + @guarded + @@softDelete:
//
//   $setAuth({id:1}).invoice.findMany()   → 1 row,  ssn absent
//   $setAuth({id:1}).sql`SELECT * ...`    → 3 rows, ssn in plaintext, incl.
//                                            another owner's and a deleted one
//
// The unscoped client is the wider gap, not the narrower one: an unauthenticated
// `db.invoice.findMany()` returns **0** rows, because the policy evaluates with
// auth() == null and matches nothing, while `db.sql` returns all 3. So this is
// not "the scoped proxy drops its scope" — it is that `sql` ignores the schema
// on every path and the ORM never does.
//
// The rule: when a schema declares access rules, raw SQL is available through
// asSystem() only. Coarse on purpose — deciding per statement means parsing the
// statement, and a hand-written SQL validator that is subtly wrong grants a
// FALSE guarantee, which is worse than an honest raw hatch. (SQLite's own
// authorizer would be the right mechanism; bun:sqlite does not expose it.)
//
// Scoped raw SQL as a real capability — a per-identity view set — is designed in
// IDEAS/scoped-sql.md and deliberately not built: it is a feature, this is the
// defect, and the consumer that made it urgent does not exist yet.

/** Model-level attributes the ORM enforces and raw SQL does not. */
const ACCESS_MODEL_ATTRS = new Set(['gate', 'allow', 'deny'])

/**
 * Field-level ones. `@omit` and `@@softDelete` are deliberately NOT here: they
 * shape what a read returns rather than who may read it, and refusing raw SQL
 * for a soft-delete column would fire on most schemas for a lifecycle rule
 * rather than an access one.
 */
const ACCESS_FIELD_ATTRS = new Set(['guarded', 'encrypted', 'secret', 'fieldAllow', 'scoped'])

function schemaDeclaresAccessRules(schema) {
  for (const model of schema.models ?? []) {
    if ((model.attributes ?? []).some(a => ACCESS_MODEL_ATTRS.has(a.kind))) return true
    for (const field of model.fields ?? [])
      if ((field.attributes ?? []).some(a => ACCESS_FIELD_ATTRS.has(a.kind))) return true
  }
  return false
}

function rawSqlRefusal(surface) {
  return new Error(
    `${surface} — this schema declares access rules, and raw SQL applies none of them.\n\n` +
    `A raw statement reads the base table: @@gate, @@allow/@@deny, @guarded, @scoped and\n` +
    `@@softDelete are all enforced above SQLite, so none of them survive the trip. The ORM\n` +
    `filters rows and withholds columns; \`sql\` does not.\n\n` +
    `If you mean to bypass them, say so — that is what asSystem() is for:\n\n` +
    `    db.asSystem().sql\`SELECT ...\`\n\n` +
    `If you want the rules applied, stay on the ORM. For an expression the query builder\n` +
    `cannot express, \`where: { $raw: sql\`...\` }\` keeps every policy:\n\n` +
    `    db.invoice.findMany({ where: { $raw: sql\`json_extract(meta,'$.tier') = \${3}\` } })\n\n` +
    `Scoped raw SQL is designed (IDEAS/scoped-sql.md) and not built.`
  )
}

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
        // Whether the DECLARED type is Json. Captured here, beside the other
        // per-field facts, because the encrypt/decrypt steps both need it and
        // neither has the schema in scope. Without it `@encrypted` on a Json
        // field silently destroyed the value: encryptField does
        // String(plaintext), an object stringifies to '[object Object]', and
        // what got encrypted was a faithful ciphertext of that — unrecoverable,
        // with nothing thrown.
        json:      field.type?.name === 'Json',
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
      // Include Json fields AND array fields — both stored as JSON text.
      // Exclude @edge fields — they live on a join/side table, not the host row.
      model.fields.filter(f => (f.type.name === 'Json' || f.type.array) && !f.attributes.find(a => a.kind === 'edge')).map(f => f.name)
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

      // FK column on the target table + the column it references on THIS model.
      // The referenced column is usually the @id, but relations can reference a
      // non-PK @unique column (e.g. Translation.verseId references Verse.verseId).
      // Correlating on the actual referenced column — not the assumed PK — is
      // what makes @from work for those reverse relations.
      const idField = model.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
      let fkCol = null
      let refCol = idField
      if (fkField) {
        const rel = fkField.attributes.find(a => a.kind === 'relation')
        fkCol  = Array.isArray(rel.fields)     ? rel.fields[0]     : rel.fields
        refCol = (Array.isArray(rel.references) ? rel.references[0] : rel.references) ?? idField
      } else {
        // Fallback: look for a field named <modelName>Id
        const fallback = targetModel.fields.find(f => f.name === `${model.name}Id`)
        if (fallback) fkCol = fallback.name
      }

      if (!fkCol) continue  // can't infer FK — skip (validation catches this)

      const whereParts = [`"${fkCol}" = "${selfTable}"."${refCol}"`]
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
// { modelName: { fieldName: { enumName, transitions: { name: { from, to, gate } } } } }
//
// Reads @@transitions model attributes only. The `enum X { transitions { ... } }`
// shorthand was already desugared into those attributes by resolveTransitions()
// in the parser, so there is exactly one representation to enforce against.

function buildTransitionMap(schema) {
  const map = {}
  for (const model of schema.models) {
    for (const attr of model.attributes ?? []) {
      if (attr.kind !== 'transitions') continue
      const field = model.fields.find(f => f.name === attr.field)
      if (!map[model.name]) map[model.name] = {}
      map[model.name][attr.field] = {
        enumName:    field?.type?.name ?? null,
        transitions: attr.transitions,
      }
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
      // Match the back-ref array by relation LABEL (Prisma parity): an FK
      // labeled "sentByUser" pairs with the parent array labeled "sentByUser";
      // unlabeled FKs pair with unlabeled arrays. This lets two hasMany
      // relations coexist between the same pair of models.
      const relLabel = rel.name ?? null
      const backrefField = parentModel?.fields.find(f =>
        f.type.name === model.name && f.type.array && f.type.kind === 'relation' &&
        ((f.attributes.find(a => a.kind === 'relation')?.name ?? null) === relLabel)
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

  // Implicit m2m — one manyToMany entry per relation END, keyed by field name.
  // detectM2MPairs is label-aware: several m2m relations may exist between the
  // same two models (each with its own join table), including self-relations.
  const m2mPairs = detectM2MPairs(schema)
  for (const pair of m2mPairs) {
    if (!map[pair.modelA]) map[pair.modelA] = {}
    if (!map[pair.modelB]) map[pair.modelB] = {}

    if (pair.self) {
      // Self m2m: both ends live on the same model with distinct fields.
      // selfFields maps each field to its (selfKey, targetKey) direction.
      for (const [fieldName, dir] of Object.entries(pair.selfFields ?? {})) {
        map[pair.modelA][fieldName] = {
          kind:        'manyToMany',
          targetModel: pair.modelA,
          joinTable:   pair.joinTable,
          selfKey:     dir.selfKey,
          targetKey:   dir.targetKey,
        }
      }
      continue
    }

    if (pair.fieldA) {
      map[pair.modelA][pair.fieldA] = {
        kind:        'manyToMany',
        targetModel: pair.modelB,
        joinTable:   pair.joinTable,
        selfKey:     pair.colA,    // join table column for THIS model
        targetKey:   pair.colB,    // join table column for TARGET model
      }
    }
    if (pair.fieldB) {
      map[pair.modelB][pair.fieldB] = {
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

// Suggest the closest match for an unknown key from a set of valid keys.
// Used in write-data validation to give users actionable typo hints —
// "Unknown field 'emial' on User. Did you mean: email?". Levenshtein with a
// small ceiling, since field names are short and typos are usually 1–2 edits.
function suggestKey(unknown, allowed) {
  if (!unknown) return null
  const lower = String(unknown).toLowerCase()
  let best = null
  let bestDist = Infinity
  for (const candidate of allowed) {
    const cand = String(candidate).toLowerCase()
    // Cheap pre-filter: skip candidates whose length differs by > 3
    if (Math.abs(cand.length - lower.length) > 3) continue
    const d = editDistance(lower, cand)
    if (d < bestDist) { bestDist = d; best = candidate }
  }
  // Threshold: allow up to 2 edits for very short names (so transposition
  // typos like "naem" → "name" qualify), scaling up to ~1/3 of the input
  // length for longer names. Also require the suggestion to keep more chars
  // than it changes — otherwise short typos like "x" match anything.
  const threshold = Math.max(2, Math.floor(lower.length / 3))
  if (bestDist > threshold) return null
  if (bestDist >= lower.length) return null
  return best
}

// ─── Query-arg validation ─────────────────────────────────────────────────────
// Reads WARN on unknown where-fields (once per model+field per process) and
// keep executing; writes REJECT — a typo'd filter on a write is a mis-scoped
// destructive operation (`updateMany({ where: { nam: 'x' } })` with the key
// dropped would match every row). take/skip are rejected everywhere with a
// pointer to limit/offset. AND/OR/NOT are descended into; relation
// sub-filters are not (their keys belong to the related model).
const _whereWarnOnce = new Set()

function checkWhereKeys(where, allowed, modelName, method, isWrite) {
  if (!where || typeof where !== 'object' || Array.isArray(where)) return
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND' || k === 'OR' || k === 'NOT') {
      for (const w of Array.isArray(v) ? v : [v]) checkWhereKeys(w, allowed, modelName, method, isWrite)
      continue
    }
    if (k === '$raw' || allowed.has(k)) continue
    const hint = suggestKey(k, allowed)
    const msg = `Unknown field '${k}' in where for ${modelName}.${method}.` +
      (hint ? ` Did you mean: ${hint}?` : ` Valid fields: ${[...allowed].sort().join(', ')}`)
    if (isWrite) throw new ValidationError([{ path: ['where', k], message: msg }])
    const once = `${modelName}.${k}`
    if (!_whereWarnOnce.has(once)) {
      _whereWarnOnce.add(once)
      console.warn(`[litestone] ${msg}`)
    }
  }
}

const ARG_READ_METHODS = [
  'findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow',
  'count', 'exists', 'findManyAndCount', 'aggregate', 'groupBy', 'findManyCursor',
]
const ARG_WRITE_METHODS = [
  'update', 'updateMany', 'remove', 'removeMany', 'delete', 'deleteMany', 'restore', 'upsert',
]

// Non-mutating wrapper: returns a shallow copy so shared/cached table objects
// (jsonl cache, per-scope rebuilds) never accumulate nested wrappers.
function withArgValidation(table, model, ctx) {
  if (!table || !model) return table
  const allowed = new Set(model.fields.map(f => f.name))
  for (const d of Object.values(ctx.edgeMap?.[model.name] ?? {})) allowed.add(d.as)
  const modelName = model.name

  const checkTakeSkip = (args, method) => {
    if (!args || typeof args !== 'object') return
    for (const bad of ['take', 'skip']) {
      if (bad in args) throw new ValidationError([{
        path:    [bad],
        message: `'${bad}' is not a Litestone option on ${modelName}.${method} — use ` +
                 (bad === 'take' ? `'limit' (max rows to return)` : `'offset' (rows to skip)`),
      }])
    }
  }

  // async wrappers so a validation failure is a REJECTION, matching how the
  // underlying methods fail — a sync throw from a promise-returning API is a
  // third failure mode nobody handles.
  const out = { ...table }
  const wrap = (method, isWrite) => {
    const fn = table[method]
    if (typeof fn !== 'function') return
    out[method] = async (args = {}) => {
      checkTakeSkip(args, method)
      checkWhereKeys(args?.where, allowed, modelName, method, isWrite)
      return fn.call(table, args)
    }
  }
  for (const m of ARG_READ_METHODS)  wrap(m, false)
  for (const m of ARG_WRITE_METHODS) wrap(m, true)

  // search(query, opts) — the where filter rides in opts
  if (typeof table.search === 'function') {
    const fn = table.search
    out.search = async (q, opts = {}) => {
      checkTakeSkip(opts, 'search')
      checkWhereKeys(opts?.where, allowed, modelName, 'search', false)
      return fn.call(table, q, opts)
    }
  }
  return out
}

function editDistance(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  // Iterative DP with two rows — O(min(a,b)) memory.
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  let curr = new Array(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        curr[j - 1] + 1,        // insertion
        prev[j]   + 1,          // deletion
        prev[j - 1] + cost,     // substitution
      )
    }
    [prev, curr] = [curr, prev]
  }
  return prev[b.length]
}

function buildSoftDeleteMap(schema) {
  const map = {}
  for (const model of schema.models) {
    map[model.name] = isSoftDelete(model)
  }
  return map
}

// ─── @@hasTemplates map ───────────────────────────────────────────────────────
// { modelName: string | null } — name of the marker column if the model has
// @@hasTemplates, otherwise null. Lookup is hot-path on every read query so
// we keep it as a pre-computed plain object.

function buildHasTemplatesMap(schema) {
  const map = {}
  for (const model of schema.models) {
    const attr = model.attributes.find(a => a.kind === 'hasTemplates')
    map[model.name] = attr ? attr.field : null
  }
  return map
}

// ─── Co-FK map ────────────────────────────────────────────────────────────────
// For nested writes, identify FK columns that exist on BOTH the parent and the
// child and reference the same target table. These are propagated from parent
// to child during nested create/update — preventing referential drift like a
// child line item ending up with a different tenantId than its parent order.
//
// Shape: { parentModel: { childModel: [<fk_col_name>, ...] } }
//
// A column qualifies as a co-FK when:
//   1. Both parent and child have a belongsTo relation with the same FK name
//   2. Both relations point at the same target model
//   3. Both reference the same target column (always 'id' in practice, but
//      we check explicitly so multi-PK targets don't surprise us)
//
// The PK of the parent that becomes the child's FK in a hasMany relation
// (e.g. `account.id` → `users.accountId`) is excluded — that's already
// handled by the existing FK injection at processHasManyNested time.

function buildCoFkMap(schema, relationMap) {
  const map = {}
  for (const parentModel of schema.models) {
    const parentRels = relationMap[parentModel.name] ?? {}
    // Collect parent's belongsTo FKs: { columnName: { target, references } }
    const parentBT = {}
    for (const rel of Object.values(parentRels)) {
      if (rel.kind !== 'belongsTo') continue
      parentBT[rel.foreignKey] = { target: rel.targetModel, references: rel.referencedKey }
    }
    if (!Object.keys(parentBT).length) continue

    // Walk every other model — anyone whose belongsTo overlaps with parent's
    // belongsTo on column name AND target IS a co-FK candidate.
    for (const childModel of schema.models) {
      if (childModel.name === parentModel.name) continue
      const childRels = relationMap[childModel.name] ?? {}
      const overlaps = []
      for (const rel of Object.values(childRels)) {
        if (rel.kind !== 'belongsTo') continue
        const p = parentBT[rel.foreignKey]
        if (!p) continue
        if (p.target !== rel.targetModel) continue
        if (p.references !== rel.referencedKey) continue
        overlaps.push(rel.foreignKey)
      }
      if (overlaps.length) {
        if (!map[parentModel.name]) map[parentModel.name] = {}
        map[parentModel.name][childModel.name] = overlaps
      }
    }
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

function makeTxManager(db, state = { depth: 0 }) {
  let spCount = 0

  function begin() {
    // BEGIN IMMEDIATE (matching the $transaction doc comment): take the write
    // lock up front. A deferred BEGIN upgrades to a write lock mid-transaction,
    // which under concurrency surfaces as avoidable SQLITE_BUSY retries.
    if (state.depth === 0) { db.run('BEGIN IMMEDIATE') }
    else { spCount++; db.run(`SAVEPOINT sp_${spCount}`) }
    state.depth++
    return state.depth === 1 ? null : spCount
  }

  function commit(sp) {
    state.depth--
    if (sp == null) db.run('COMMIT')
    else            db.run(`RELEASE sp_${sp}`)
  }

  function rollback(sp) {
    state.depth--
    if (sp == null) db.run('ROLLBACK')
    else { db.run(`ROLLBACK TO sp_${sp}`); db.run(`RELEASE sp_${sp}`) }
  }

  function wrap(fn) {
    const sp = begin()
    try { const r = fn(); commit(sp); return r }
    catch (e) { rollback(sp); throw e }
  }

  return { begin, commit, rollback, wrap, state }
}

// ─── Read routing ─────────────────────────────────────────────────────────────
//
// Reads normally go to the readonly WAL connection, which is what lets them run
// concurrently with writes. Inside a transaction that is wrong: the writes are
// uncommitted on the write connection, and WAL isolation means the read
// connection cannot see them. A create() followed by a findMany() in the same
// $transaction returned [] — the row existed, the reader was looking at a
// snapshot taken before it.
//
// While a transaction is open, reads route to the write connection instead, which
// observes its own uncommitted work. Outside one, nothing changes.

function makeReadRouter(readDb, writeDb, txState) {
  return {
    query:  (sql) => (txState.depth > 0 ? writeDb : readDb).query(sql),
    inTx:   () => txState.depth > 0,
    get cacheSize()  { return readDb.cacheSize },
    set cacheSize(v) { readDb.cacheSize = v },
  }
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

// ─── @@hasTemplates WHERE injection ───────────────────────────────────────────
// Prepend the isTemplate = 0 filter to any existing where clause. Same shape
// as soft-delete: default mode hides templates, mode flags opt in.
//
// `field` is the configured marker column (defaults to 'isTemplate' but can
// be overridden via @@hasTemplates(field: "isPreset")).

function injectHasTemplatesFilter(where, mode, field = 'isTemplate') {
  // mode: 'instances' (default) | 'withTemplates' | 'onlyTemplates'
  if (mode === 'withTemplates') return where
  if (mode === 'onlyTemplates') {
    const filter = { [field]: true }
    if (!where) return filter
    return { AND: [filter, where] }
  }
  // 'instances' — default
  const filter = { [field]: false }
  if (!where) return filter
  return { AND: [filter, where] }
}

// ─── Include resolution ───────────────────────────────────────────────────────
// One query per relation level, batched with IN — never N queries per row.
// Uses readDb for all include fetches.

// Coerce a raw edge column value (from a join/side table) to its JS type.
function coerceEdgeValue(raw, desc) {
  if (raw == null) return raw
  const tn = desc.type?.name
  if (tn === 'Boolean') return !!raw
  if (tn === 'Json')    { try { return JSON.parse(raw) } catch { return raw } }
  return raw
}

function resolveIncludes(readDb, rows, include, modelName, ctx) {
  if (!include || !rows.length) return rows

  const { relationMap, jsonMap, edgeMap, computedSets, softDeleteMap, computedFns } = ctx
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
        // Default _count behaviour mirrors normal reads — exclude templates.
        // The relInclude here is `spec`, parsed above; we don't currently
        // surface withTemplates/onlyTemplates on _count selectors (matches
        // soft-delete: no withDeleted on _count either).
        const targetHt = ctx.hasTemplatesMap?.[rel.targetModel] ?? null
        const htExtra  = targetHt ? ` AND "${targetHt}" = 0` : ''
        // Build optional where filter using buildWhere
        let whereExtra = ''
        const whereParams = []
        if (where) {
          const ws = buildWhere(where, whereParams)
          if (ws) whereExtra = ` AND (${ws})`
        }
        sql = `SELECT "${rel.foreignKey}" as __pk, COUNT(*) as __n FROM "${modelToTable(rel.targetModel)}" WHERE "${rel.foreignKey}" IN (${ph})${sdExtra}${htExtra}${whereExtra} GROUP BY "${rel.foreignKey}"`
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
    // Optional per-include filter: include: { posts: { where: { published: true } } }
    const relWhere = typeof relInclude === 'object' && relInclude !== true
      ? relInclude.where ?? null : null
    const relWhereSql = (extraAlias) => {
      if (!relWhere) return { clause: '', params: [] }
      const p = []
      const ws = buildWhere(relWhere, p, null, extraAlias ?? null, null)
      return { clause: ws ? ` AND (${ws})` : '', params: p }
    }
    // Soft delete mode for related table
    const nestedMode    = typeof relInclude === 'object' && relInclude !== true
      ? relInclude.withDeleted ? 'withDeleted' : relInclude.onlyDeleted ? 'onlyDeleted' : 'live'
      : 'live'
    // @@hasTemplates mode for related table — same shape as soft-delete mode.
    const nestedHtMode  = typeof relInclude === 'object' && relInclude !== true
      ? relInclude.withTemplates ? 'withTemplates' : relInclude.onlyTemplates ? 'onlyTemplates' : 'instances'
      : 'instances'

    const targetJsonFields  = jsonMap[rel.targetModel]      ?? new Set()
    const targetSoftDelete  = softDeleteMap[rel.targetModel] ?? false
    const targetHtField     = ctx.hasTemplatesMap?.[rel.targetModel] ?? null
    const targetHasTemplates = targetHtField !== null

    // Build the @@hasTemplates SQL fragment for nested includes. Same logic as
    // injectHasTemplatesFilter but emitted as raw SQL alongside the existing
    // hand-built sdWhere — these include paths bypass buildWhere entirely for
    // performance, so the filter has to be appended manually here.
    const htClause = (targetHasTemplates && nestedHtMode !== 'withTemplates')
      ? (nestedHtMode === 'onlyTemplates'
          ? `"${targetHtField}" = 1`
          : `"${targetHtField}" = 0`)
      : null

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
      // Append @@hasTemplates filter — composes onto whatever sdWhere produced.
      if (htClause) sdWhere = `${sdWhere} AND ${htClause}`
      // Per-include where filter (belongsTo: filters the parent → nulls if excluded)
      const rw = relWhereSql(null)

      const related = readDb
        .query(`SELECT ${sqlCols} FROM "${modelToTable(rel.targetModel)}" WHERE ${sdWhere}${rw.clause}`)
        .all(...sdParams, ...rw.params)
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
      const rwM = relWhereSql('t')   // target aliased `t` in the m2m join query

      // @edge fields on the target that decorate THIS join → surface under their
      // namespace, pulled from the join row (the traversal binds the dimension).
      const edgeDescs = Object.values(edgeMap?.[rel.targetModel] ?? {})
        .filter(d => d.storage === 'decorate' && d.table === rel.joinTable)
      const edgeSelect = edgeDescs.map(d => `, j."${d.col}" AS "__edge_${d.col}"`).join('')

      const rawRows = readDb
        .query(
          `SELECT t.*, j."${rel.selfKey}" AS __jSelfKey${edgeSelect} FROM "${modelToTable(rel.targetModel)}" t ` +
          `INNER JOIN "${rel.joinTable}" j ON j."${rel.targetKey}" = t."id" ` +
          `WHERE j."${rel.selfKey}" IN (${ph})${rwM.clause}`
        )
        .all(...pkValues, ...rwM.params)

      // Strip __jSelfKey before processing so it doesn't leak into the output row
      const selfKeys = rawRows.map(r => { const k = r.__jSelfKey; delete r.__jSelfKey; return k })

      // Pull edge values off each raw row (and strip the temp cols) before shaping.
      const edgeBags = rawRows.map(r => {
        if (!edgeDescs.length) return null
        const bag = {}
        for (const d of edgeDescs) {
          const alias = `__edge_${d.col}`
          const raw = r[alias]
          delete r[alias]
          ;(bag[d.as] ??= {})[d.field] = coerceEdgeValue(raw, d)
        }
        return bag
      })

      const related = rawRows
        .map(r => applyComputed(coerceBooleans(deserializeRow(r, targetJsonFields), ctx.boolMap?.[rel.targetModel] ?? new Set()), rel.targetModel, computedFns, ctx))

      // Attach namespaced edge values onto each shaped target row.
      if (edgeDescs.length) {
        for (let i = 0; i < related.length; i++) {
          const bag = edgeBags[i]
          if (bag) for (const ns in bag) related[i][ns] = { ...(related[i][ns] ?? {}), ...bag[ns] }
        }
      }

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
      if (htClause) sdWhere = `${sdWhere} AND ${htClause}`
      const rwH = relWhereSql(null)

      const related = readDb
        .query(`SELECT ${sqlCols} FROM "${modelToTable(rel.targetModel)}" WHERE ${sdWhere}${rwH.clause}`)
        .all(...pkValues, ...rwH.params)
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

  // Precompute the merged (event + change) listener array per event —
  // previously two array spreads ran on every single write.
  const merged = {}
  for (const event of Object.keys(listeners)) {
    if (event === 'change') continue
    merged[event] = [...(listeners[event] ?? []), ...(listeners.change ?? [])]
  }
  const changeOnly = listeners.change ?? []

  return {
    emit(event, eventCtx, clientCtx) {
      // Fire-and-forget — never blocks the caller
      const fns = merged[event] ?? changeOnly
      if (!fns.length) return
      // setImmediate fires after the caller's await resolves, without the
      // timer-heap overhead and ~1ms clamping of setTimeout(0)
      setImmediate(() => {
        for (const fn of fns) {
          try { fn(eventCtx, clientCtx) } catch (e) { console.warn(`litestone event listener error (${event}):`, e) }
        }
      })
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

  // @@hasTemplates marker column name, or null if this model doesn't opt in.
  // Read paths inject `<field> = false` by default; `withTemplates` /
  // `onlyTemplates` query args opt out / invert the filter.
  const hasTemplatesField = ctx.hasTemplatesMap?.[modelName] ?? null
  const hasTemplates      = hasTemplatesField !== null

  // Pre-build allowed write keys for this model. Used by writeData to detect
  // typos before SQL — a typo would otherwise surface as the cryptic SQLite
  // error "table X has no column named Y". This set covers:
  //   - all scalar field names                       (user.email)
  //   - all relation names                           (user.account, user.posts)
  //     — relations with nested op shape are extracted before writeData,
  //       but they may also appear with scalar values during a typo
  //       (e.g. user wrote `account: 1` meaning accountId), and the
  //       suggestion machinery is still useful.
  //   - all FK columns derived from belongsTo relations (user.accountId)
  //   - "id" — always allowed as primary key
  //
  // Computed and generated fields are NOT writable, so they're omitted; if a
  // user passes one we want to surface the typo with a helpful hint.
  const _modelForKeys = ctx.models?.[modelName]
  const _allowedWriteKeys = new Set()
  if (_modelForKeys) {
    for (const f of _modelForKeys.fields) {
      const isComputed  = f.attributes?.find(a => a.kind === 'computed')
      const isGenerated = f.attributes?.find(a => a.kind === 'generated' || a.kind === 'funcCall')
      if (!isComputed && !isGenerated) _allowedWriteKeys.add(f.name)
    }
  }
  const _modelRels = ctx.relationMap?.[modelName] ?? {}

  // ── @edge / @scoped write helpers ─────────────────────────────────────────────
  const _edges = ctx.edgeMap?.[modelName] ?? {}
  const _edgeNamespaces = new Set(Object.values(_edges).map(d => d.as))

  // Peel edge namespaces out of a write's data. `data.projectEdge = { isImportant }`
  // → edgeWrites [{ desc, value }], and the namespace key removed from the row data.
  function extractEdgeWrites(data) {
    if (!data || !_edgeNamespaces.size) return { data, edgeWrites: [] }
    const edgeWrites = []
    let cleaned = null
    for (const ns of _edgeNamespaces) {
      const bag = data[ns]
      if (bag == null || typeof bag !== 'object' || Array.isArray(bag)) continue
      if (!cleaned) cleaned = { ...data }
      for (const [fname, value] of Object.entries(bag)) {
        const desc = _edges[fname]
        if (desc && desc.as === ns) edgeWrites.push({ desc, value })
      }
      delete cleaned[ns]
    }
    return { data: cleaned ?? data, edgeWrites }
  }

  function serializeEdgeValue(value, desc) {
    if (value == null) return null
    const tn = desc.type?.name
    if (tn === 'Boolean') return value ? 1 : 0
    if (tn === 'Json')    return JSON.stringify(value)
    return value
  }

  // Resolve the dimension id an edge write targets: auth().id for @scoped,
  // otherwise the bound value from a per-query scopedBy arg or ctx.scopedBy.
  function resolveEdgeDim(desc, scopedBy) {
    if (desc.auth) return ctx.auth?.id ?? null
    return scopedBy?.[desc.key] ?? ctx.scopedBy?.[desc.key] ?? null
  }

  // Upsert edge values onto the join/side row for the bound dimension.
  //   own      → INSERT … ON CONFLICT upsert (materialize the row, D4)
  //   decorate → UPDATE only; 0 rows means no membership → EDGE_NO_MEMBERSHIP (D12)
  function applyEdgeWrites(edgeWrites, hostId, scopedBy) {
    if (!edgeWrites?.length) return
    const groups = new Map()   // table|dimId → { desc0, dimId, cols }
    for (const { desc, value } of edgeWrites) {
      const dimId = resolveEdgeDim(desc, scopedBy)
      if (dimId == null) {
        if (desc.onMissing === 'skip') continue
        throw new Error(`@edge '${modelName}.${desc.field}': cannot resolve dimension '${desc.key}' — bind it with scopedBy({ ${desc.key} }) or $setAuth`)
      }
      const gkey = `${desc.table}|${dimId}`
      let g = groups.get(gkey)
      if (!g) { g = { desc0: desc, dimId, cols: {} }; groups.set(gkey, g) }
      g.cols[desc.col] = serializeEdgeValue(value, desc)
    }
    for (const g of groups.values()) {
      const { table, hostCol, dimCol, storage, field } = g.desc0
      const colNames = Object.keys(g.cols)
      const colVals  = colNames.map(c => g.cols[c])
      if (storage === 'own') {
        const allCols = [hostCol, dimCol, ...colNames]
        const sql = `INSERT INTO "${table}" (${allCols.map(c => `"${c}"`).join(', ')}) VALUES (${allCols.map(() => '?').join(', ')}) ` +
          `ON CONFLICT("${hostCol}", "${dimCol}") DO UPDATE SET ${colNames.map(c => `"${c}"=excluded."${c}"`).join(', ')}`
        writeDb.run(sql, hostId, g.dimId, ...colVals)
      } else {
        const sql = `UPDATE "${table}" SET ${colNames.map(c => `"${c}"=?`).join(', ')} WHERE "${hostCol}"=? AND "${dimCol}"=?`
        const res = writeDb.run(sql, ...colVals, hostId, g.dimId)
        if (!res.changes) {
          const err = new Error(`@edge '${modelName}.${field}': no membership for ${hostCol}=${hostId} / ${dimCol}=${g.dimId} — link the relationship first`)
          err.code = 'EDGE_NO_MEMBERSHIP'
          throw err
        }
      }
    }
  }

  function edgeDefault(desc) {
    const d = desc.default
    if (d == null) return null
    if (typeof d === 'object' && 'value' in d) return d.value
    return d
  }

  // Flat read: resolve each edge namespace for the bound dimension and attach it
  // onto every top-level row. Bound = auth().id for @scoped, or scopedBy[key].
  // @scoped with no viewer (asSystem/no auth) → the field's @default (D3);
  // an unbound non-auth edge is simply left absent (its error surfaces on filter).
  function attachFlatEdges(rows, scopedBy) {
    if (!rows?.length || !_edgeNamespaces.size) return
    const byTable = new Map()   // one storage table = one dimension shape
    for (const desc of Object.values(_edges)) {
      let g = byTable.get(desc.table)
      if (!g) { g = { d0: desc, cols: [] }; byTable.set(desc.table, g) }
      g.cols.push(desc)
    }
    for (const g of byTable.values()) {
      const d0 = g.d0
      const dimId = d0.auth ? (ctx.auth?.id ?? null)
                            : (scopedBy?.[d0.key] ?? ctx.scopedBy?.[d0.key] ?? null)
      if (dimId == null) {
        if (d0.auth) for (const row of rows) for (const desc of g.cols) (row[desc.as] ??= {})[desc.field] = edgeDefault(desc)
        continue
      }
      const hostIds = [...new Set(rows.map(r => r[_pkField]).filter(v => v != null))]
      if (!hostIds.length) continue
      const ph      = hostIds.map(() => '?').join(', ')
      const colList = g.cols.map(c => `"${c.col}"`).join(', ')
      const found   = readDb
        .query(`SELECT "${d0.hostCol}" AS __h, ${colList} FROM "${d0.table}" WHERE "${d0.hostCol}" IN (${ph}) AND "${d0.dimCol}" = ?`)
        .all(...hostIds, dimId)
      const byHost = new Map()
      for (const fr of found) byHost.set(fr.__h, fr)
      for (const row of rows) {
        const fr = byHost.get(row[_pkField])
        for (const desc of g.cols) (row[desc.as] ??= {})[desc.field] = fr ? coerceEdgeValue(fr[desc.col], desc) : edgeDefault(desc)
      }
    }
  }

  // Bound dimensions for the WHERE currently being compiled (set by read methods
  // just before buildSQL; read synchronously by edgeFilterSql — no await between).
  let _scopedByForBuild = null

  function _ecp(v) { return typeof v === 'boolean' ? (v ? 1 : 0) : v }

  // Compile where:{ <namespace>: { field: pred } } → EXISTS against the edge's
  // join/side table, scoped to the bound dimension. Unbound non-auth → error (D3);
  // @scoped with no viewer → matches nothing.
  function edgeFilterSql(namespace, predicate, params, tableAlias) {
    const cols = Object.values(_edges).filter(d => d.as === namespace)
    if (!cols.length) return undefined
    const d0 = cols[0]
    const dimId = d0.auth ? (ctx.auth?.id ?? null)
                          : (_scopedByForBuild?.[d0.key] ?? ctx.scopedBy?.[d0.key] ?? null)
    if (dimId == null) {
      if (!d0.auth) throw new Error(`@edge filter '${modelName}.${namespace}': dimension '${d0.key}' not bound — add scopedBy({ ${d0.key} })`)
      return '(1 = 0)'
    }
    const host  = `${tableAlias ? `${tableAlias}.` : `"${tableName}".`}"id"`
    const alias = '_je'
    const inner = [], innerParams = []
    for (const [field, val] of Object.entries(predicate ?? {})) {
      const desc = cols.find(c => c.field === field)
      if (!desc) continue
      const col = `${alias}."${desc.col}"`
      if (val === null) { inner.push(`${col} IS NULL`); continue }
      if (typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
        for (const [op, v] of Object.entries(val)) {
          if      (op === 'not') { if (v === null) inner.push(`${col} IS NOT NULL`); else { inner.push(`${col} != ?`); innerParams.push(_ecp(v)) } }
          else if (op === 'gt')  { inner.push(`${col} > ?`);  innerParams.push(_ecp(v)) }
          else if (op === 'gte') { inner.push(`${col} >= ?`); innerParams.push(_ecp(v)) }
          else if (op === 'lt')  { inner.push(`${col} < ?`);  innerParams.push(_ecp(v)) }
          else if (op === 'lte') { inner.push(`${col} <= ?`); innerParams.push(_ecp(v)) }
          else if (op === 'in')  { inner.push(`${col} IN (${v.map(() => '?').join(', ')})`); v.forEach(x => innerParams.push(_ecp(x))) }
          else if (op === 'contains') { inner.push(`${col} LIKE ?`); innerParams.push(`%${v}%`) }
        }
      } else {
        inner.push(`${col} = ?`); innerParams.push(_ecp(val))
      }
    }
    const innerSql = inner.length ? ' AND ' + inner.join(' AND ') : ''
    params.push(dimId, ...innerParams)
    return `EXISTS (SELECT 1 FROM "${d0.table}" ${alias} WHERE ${alias}."${d0.hostCol}" = ${host} AND ${alias}."${d0.dimCol}" = ?${innerSql})`
  }

  // Dispatcher passed to buildWhere as its relFilter: edge namespace → edgeFilterSql,
  // otherwise fall through to the relation filter (some/every/none).
  function edgeOrRelFilter(key, val, params, tableAlias) {
    if (_edgeNamespaces.has(key)) return edgeFilterSql(key, val, params, tableAlias)
    return relationFilterSql(key, val, params, tableAlias)
  }
  for (const relName of Object.keys(_modelRels)) {
    const rel = _modelRels[relName]
    _allowedWriteKeys.add(relName)
    // Only add FK columns for belongsTo relations — those are the ones whose
    // FK lives on THIS table. hasMany / m2m carry foreignKey metadata too,
    // but the column is on the OTHER table and would falsely accept typos
    // like `users: { create: ... }` paired with a stray `accountId` on the
    // parent (which has no such column).
    if (rel?.kind === 'belongsTo' && rel.foreignKey) _allowedWriteKeys.add(rel.foreignKey)
  }
  // Always allow id even if not declared (legacy/edge-case schemas)
  _allowedWriteKeys.add('id')

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

  // Cascade targets are a pure function of the (immutable) schema — compute the
  // BFS once per table instead of on every remove()/removeMany()/restore().
  // _cascadeParents lets the cascade loop skip the child-PK readback SELECT for
  // leaf tables: nothing downstream consumes their PKs.
  let _cascadeTargetsCache = null
  let _cascadeParents      = null
  function _cascadeTargets() {
    if (!_cascadeTargetsCache) {
      _cascadeTargetsCache = getCascadeTargets(modelName, ctx.relationMap, ctx.softDeleteMap, _modelToTable)
      _cascadeParents      = new Set(_cascadeTargetsCache.map(t => t.parentModel))
    }
    return _cascadeTargetsCache
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

  // Resolve the caller's gate level for this model. GatePlugin owns the scale and
  // the per-request cache (ctx.levelFor). When a transition declares @gate the
  // plugin is guaranteed present — createClient auto-installs one — so a missing
  // resolver means something is misconfigured, and refusing is the safe read.
  async function transitionLevel() {
    if (typeof ctx.levelFor !== 'function') return 0
    return await ctx.levelFor(modelName, ctx)
  }

  async function checkTransitions(data, whereParams, whereSql) {
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

      // The move is legal — is this caller allowed to make it? A transition gate
      // is a floor on top of @@gate's update level, which has already passed to
      // get here: shipping an order and refunding one are not the same authority.
      const required = transitions[matchedName].gate
      if (required != null) {
        const level = await transitionLevel()
        if (level < required)
          throw new TransitionGateError(tableName, fieldName, matchedName, required, level)
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
    // buildLogMap keys these `ModelName.fieldName` (see its header), and the
    // model-level map below is looked up by `modelName` too. Comparing against
    // tableName only matched while model name == table name — i.e. lowercase
    // model names. Under the mandatory PascalCase convention `Post` !== `post`,
    // so every field-level @log was silently dropped and @log(audit) on a field
    // recorded nothing at all.
    if (model !== modelName) continue
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

  // ── Audit redaction ─────────────────────────────────────────────────────
  // A protected field's VALUE must never reach a log entry. The audit trail
  // exists to record THAT a field was written — by whom, to which rows, when —
  // not what it holds. Logging the plaintext would defeat the @encrypted it
  // sits next to: the database row is ciphertext while the JSONL beside it is
  // not, and the log file has none of the column's read protections.
  //
  // This matters most for @secret, which expands to
  // @encrypted + @guarded(all) + @log(<first logger db>) — so declaring a
  // logger database is on its own enough to start logging every @secret field.
  // Redaction is what makes that expansion safe.
  //
  // null is preserved rather than redacted: it holds nothing to leak, and
  // keeping it means a null → value transition is still visible in the trail.
  const REDACTED = '[redacted]'
  const protectedLogFields = new Set(
    Object.keys(fieldPolicy).filter(f => fieldPolicy[f].encrypted || fieldPolicy[f].guarded)
  )
  const hasProtectedLogFields = protectedLogFields.size > 0

  // Field-level entries: the entry IS about this field, so it stays — only the
  // value is replaced.
  function redactValue(field, value) {
    if (value == null) return null
    return protectedLogFields.has(field) ? REDACTED : value
  }

  // Model-level entries: before/after are whole rows. Copy on write — these
  // objects are the rows handed back to the caller and must not be mutated.
  function redactSnapshot(row) {
    if (!row || !hasProtectedLogFields || typeof row !== 'object') return row
    let out = null
    for (const f of protectedLogFields) {
      if (row[f] == null) continue
      if (!out) out = { ...row }
      out[f] = REDACTED
    }
    return out ?? row
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
            before:  beforeMap ? redactValue(field, beforeMap[field] ?? null) : null,
            after:   afterMap  ? redactValue(field, afterMap[field]  ?? null) : null,
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
          before:  beforeMap ? redactSnapshot(beforeMap) : null,
          after:   afterMap  ? redactSnapshot(afterMap)  : null,
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

          // Mirror of the write step: a Json field was serialized before it was
          // encrypted, so it is parsed after it is decrypted.
          //
          // The parse gets its OWN try/catch rather than riding the outer one,
          // which sets the field to null. A row written before this was fixed
          // decrypts to the literal string '[object Object]' — real data that is
          // already lost. Surfacing that beats blanking it: null reads as "this
          // was empty", the string reads as "something went wrong here", and
          // only the second sends anyone looking.
          if (policy.json && typeof out[fieldName] === 'string') {
            try { out[fieldName] = JSON.parse(out[fieldName]) } catch {}
          }
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
  // requireAll: create-shaped writes (create/createMany/upsert-insert) enforce
  // required fields up front; update-shaped writes stay partial.
  function writeData(data, { requireAll = false } = {}) {
    const model = ctx.models[modelName]

    // Unknown keys in the data payload are silently stripped — mass-assignment
    // protection, so a form/request body can be passed straight in without
    // whitelisting. (Deliberate policy choice 2026-08-01; typos in required
    // fields still surface via the required-field check below, and typo'd
    // *filters* are handled separately in where validation.)
    if (model && data && typeof data === 'object' && !Array.isArray(data)) {
      let cleaned = null
      for (const k of Object.keys(data)) {
        if (_allowedWriteKeys.has(k) || _edgeNamespaces.has(k)) continue
        if (!cleaned) cleaned = { ...data }
        delete cleaned[k]
      }
      if (cleaned) data = cleaned
    }

    // Required-field pre-flight. The schema knows requiredness; without this
    // a missing NOT NULL field surfaced as SQLite's raw "NOT NULL constraint
    // failed" instead of a ValidationError shaped like every other field rule.
    if (model && requireAll) {
      const missing = []
      for (const f of model.fields) {
        // Arrays always carry a DDL-level DEFAULT '[]' (empty array is the
        // null state — see ddl.js), so they are never required.
        if (f.type.optional || f.type.array || f.type.kind === 'relation' || f.type.kind === 'implicitM2M') continue
        const attrs = f.attributes ?? []
        if (attrs.some(a =>
          a.kind === 'default'  || a.kind === 'updatedAt' || a.kind === 'sequence' ||
          a.kind === 'computed' || a.kind === 'generated' || a.kind === 'funcCall' ||
          a.kind === 'from'     || a.kind === 'edge')) continue
        // Int @id with no default is SQLite's autoincrementing rowid alias
        if (attrs.some(a => a.kind === 'id') && f.type.name === 'Int') continue
        if (data?.[f.name] == null) {
          // @required("…") carries the wording; @label("Customer") names the
          // field when there is none. Neither creates the rule — the absence of
          // `?` above did.
          const custom = attrs.find(a => a.kind === 'required')?.message
          const label  = attrs.find(a => a.kind === 'label')?.text ?? f.name
          missing.push({ path: [f.name], message: custom ?? `${label} is required` })
        }
      }
      if (missing.length) throw new ValidationError(missing)
    }

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
        // Type validation: String[] → all strings, Int[] → all integers
        if (field.type.name === 'Int' && !val.every(v => Number.isInteger(v)))
          throw new ValidationError([{ path: [field.name], message: `${field.name} (Integer[]) must contain only integers` }])
        if (field.type.name === 'String' && !val.every(v => typeof v === 'string'))
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

        // A Json field is serialized to text BEFORE encryption, because
        // encryptField's String(plaintext) turns an object into
        // '[object Object]' and encrypts that — destroying the value with
        // nothing thrown. serializeRow() runs AFTER this block and stringifies
        // the ciphertext again, and read() mirrors it exactly (JSON.parse then
        // decrypt), so the round trip is symmetric and the stored column is
        // still a JSON string as the column type says.
        const plain = policy.json ? JSON.stringify(val) : val

        transformed[fieldName] = policy.encrypted.searchable
          ? encryptSearchable(plain, ctx.encKey)
          : encryptField(plain, ctx.encKey)
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
  // ── Relation filter resolver ───────────────────────────────────────────────
  // Compiles { relation: { some|every|none: WHERE } } (and is/isNot for a
  // to-one relation) into a correlated EXISTS subquery. Returns undefined when
  // `relName` isn't a relation on THIS model, so buildWhere falls through to
  // normal column handling.
  function relationFilterSql(relName, cond, params, tableAlias) {
    const rel = ctx.relationMap?.[modelName]?.[relName]
    if (!rel) return undefined   // not a relation → normal column

    const parentRefKey = rel.referencedKey ?? 'id'
    const parentCol = `${tableAlias ? `${tableAlias}.` : `"${tableName}".`}"${rel.kind === 'belongsTo' ? rel.foreignKey : parentRefKey}"`
    const targetTable = _modelToTable(rel.targetModel)
    const targetSoft  = ctx.softDeleteMap?.[rel.targetModel] ? ` AND t."deletedAt" IS NULL` : ''

    // Build the inner WHERE against the target table (aliased `t`).
    const innerOf = (w) => {
      if (!w || (typeof w === 'object' && !Object.keys(w).length)) return ''
      const p = []
      const sql = buildWhere(w, p, null, 't', null, relationFilterSql)
      return { sql, p }
    }

    // Correlated FROM+WHERE that ties the target back to this parent row.
    let corr
    if (rel.kind === 'hasMany') {
      corr = `FROM "${targetTable}" t WHERE t."${rel.foreignKey}" = ${parentCol}${targetSoft}`
    } else if (rel.kind === 'manyToMany') {
      corr = `FROM "${rel.joinTable}" j INNER JOIN "${targetTable}" t ON t."id" = j."${rel.targetKey}" WHERE j."${rel.selfKey}" = ${parentCol}${targetSoft}`
    } else { // belongsTo
      corr = `FROM "${targetTable}" t WHERE t."${parentRefKey}" = ${parentCol}${targetSoft}`
    }

    const clauses = []
    for (const [mode, w] of Object.entries(cond)) {
      const inner = innerOf(w)
      const andInner = inner && inner.sql ? ` AND (${inner.sql})` : ''
      if (mode === 'some' || mode === 'is') {
        clauses.push(`EXISTS (SELECT 1 ${corr}${andInner})`)
        if (inner) params.push(...inner.p)
      } else if (mode === 'none' || mode === 'isNot') {
        clauses.push(`NOT EXISTS (SELECT 1 ${corr}${andInner})`)
        if (inner) params.push(...inner.p)
      } else if (mode === 'every') {
        // No child violates the condition: NOT EXISTS(child WHERE NOT(cond))
        const notInner = inner && inner.sql ? ` AND NOT (${inner.sql})` : ' AND 0'
        clauses.push(`NOT EXISTS (SELECT 1 ${corr}${notInner})`)
        if (inner) params.push(...inner.p)
      } else {
        throw new Error(`Relation filter on "${relName}": unknown operator "${mode}" (use some/every/none${rel.kind === 'belongsTo' ? '/is/isNot' : ''})`)
      }
    }
    return clauses.join(' AND ')
  }

  function buildWhereWithEncryption(where, params, tableAlias = null) {
    if (!where) return buildWhere(where, params, _fromExprMap, tableAlias, _typedJsonMap, edgeOrRelFilter)
    let rewritten = where
    if (ctx.encKey) {
      rewritten = rewriteEncryptedWhere(where)
      if (rewritten?.__impossible) {
        const prefix = tableAlias ? `${tableAlias}.` : ''
        return `${prefix}"id" IS NULL AND ${prefix}"id" IS NOT NULL`
      }
    }
    return buildWhere(rewritten, params, _fromExprMap, tableAlias, _typedJsonMap, edgeOrRelFilter)
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

  // Unique/PK columns eligible as an ON CONFLICT target for the upsert fast
  // path. Built lazily — schema is immutable after createClient.
  let _upsertUniqueColsCache = null
  function _upsertUniqueCols() {
    if (_upsertUniqueColsCache) return _upsertUniqueColsCache
    const s = new Set()
    for (const f of ctx.models[modelName]?.fields ?? []) {
      if (f.attributes.some(a => a.kind === 'id' || a.kind === 'unique')) s.add(f.name)
    }
    return (_upsertUniqueColsCache = s)
  }

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
  // Disabled for @@hasTemplates models — they need an additional column predicate
  // (`isTemplate = 0`) on every read, which combinatorially expands fast-path
  // SQL variants. The slow build-SQL path handles them correctly.
  const _fastFindManySql = (softDelete && !hasTemplates && !ctx.hasPolicies && !_staticGlobalFilter && !_dynamicGlobalFilter && !plugins?.hasPlugins)
    ? `${_baseSqlWithFrom} WHERE "deletedAt" IS NULL`
    : null

  // Is a transaction open? The two fast paths below hold statements prepared
  // against the read connection, which cannot observe uncommitted writes, so both
  // stand down while one is. `inTx` is absent on plain/read-only connections.
  const _inTx = () => readDb.inTx?.() === true

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
    !_hasFrom &&
    !hasTemplates
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

  function buildSQL({ where, orderBy, limit, offset, parsedSelect, sdMode = 'live', htMode = 'instances', distinct = false, windowSpec = null } = {}) {
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
    // Inject soft delete and @@hasTemplates filters before building WHERE.
    // Both are AND-composed onto whatever the caller passed; both fall back to
    // pass-through if the model doesn't opt in.
    const sdWhere = softDelete
      ? injectSoftDeleteFilter(mergedWhere, sdMode)
      : mergedWhere
    const effectiveWhere = applyHtFilter(sdWhere, htMode)
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

  // @@hasTemplates mode from args. Same shape as sdMode: default hides templates,
  // explicit flags opt into mixed or template-only views.
  function htMode(args) {
    if (!hasTemplates) return 'instances'
    if (args?.withTemplates) return 'withTemplates'
    if (args?.onlyTemplates) return 'onlyTemplates'
    return 'instances'
  }

  // Compose: apply hasTemplates filter on top of soft-delete-filtered where.
  // Both filters AND together at the WHERE level — orthogonal concerns.
  function applyHtFilter(where, mode) {
    if (!hasTemplates) return where
    return injectHasTemplatesFilter(where, mode, hasTemplatesField)
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
  async function processHasManyNested(nested, parentPk, parentRow) {
    const rels = relationMap[modelName] ?? {}
    // Pre-resolve co-FK fields keyed by child model — used below to copy
    // parent's tenantId/accountId/etc into child rows during nested writes.
    const coFkForParent = ctx.coFkMap?.[modelName] ?? {}

    // Helper: merge parent's co-FK values into a child create payload.
    // Strict by default (parent wins), opt-out via allowChildFkOverride.
    function applyCoFk(childModel, childRow) {
      const cols = coFkForParent[childModel]
      if (!cols || !cols.length || !parentRow) return childRow
      const result = { ...childRow }
      for (const col of cols) {
        // Only propagate when parent has a real (non-null) value.
        if (parentRow[col] == null) continue
        if (ctx.allowChildFkOverride) {
          // Permissive: child's explicit value wins; only fill if missing/null.
          if (result[col] == null) result[col] = parentRow[col]
        } else {
          // Strict (default): always overwrite. This is the safe choice — a
          // child carrying a different tenantId/accountId than its parent is
          // referentially inconsistent and should never silently happen.
          result[col] = parentRow[col]
        }
      }
      return result
    }

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
            const created = await tbl.create({ data: applyCoFk(rel.targetModel, row) })
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
        for (const row of rows) await tbl.create({ data: { ...applyCoFk(rel.targetModel, row), ...fk } })
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
          const htFilteredWhere = applyHtFilter(sdFilteredWhere, 'instances')
          const anchorSql    = buildWhereWithEncryption(htFilteredWhere, anchorParams)
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
      // Skipped inside a transaction: this statement was prepared against the
      // READ connection at table-build time, so it cannot see uncommitted writes.
      // The normal path goes through readDb.query(), which routes to the write
      // connection while a transaction is open.
      if (_fastStmt && !_inTx() && !args.where && !args.orderBy && !args.limit && !args.offset && !args.select && !args.include && !args.withDeleted && !args.onlyDeleted && !args.window && !args.distinct && !plugins?.hasPlugins && !hookRunner && !tableHasAnyLog) {
        const _needsTiming = ctx.onQuery || ctx._queryListeners.size
        const _t0 = _needsTiming ? performance.now() : 0
        const rows = readAll(_fastStmt.all(), { mode: 'list' })
        if (_needsTiming) fireQuery({ operation: 'findMany', args, sql: _fastFindManySql, params: [], duration: performance.now() - _t0, rowCount: rows.length })
        return rows
      }
      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
      const hctx = hookRunner ? { model: modelName, operation: 'findMany', args, schema: ctx.models[modelName] } : null
      if (hctx && hookRunner.hasBefore('findMany')) hookRunner.runBefore(hctx, ctx)
      const { where, include, orderBy, limit, offset, select, distinct, scopedBy } = hctx ? hctx.args : args
      _scopedByForBuild = scopedBy ?? null
      const windowSpec      = args.window ?? null
      const mode            = sdMode(hctx ? hctx.args : args)
      const htm             = htMode(hctx ? hctx.args : args)
      const ps              = parseArgs(select, include)
      const { sql, params } = buildSQL({ where, orderBy, limit, offset, parsedSelect: ps, sdMode: mode, htMode: htm, distinct: distinct === true, windowSpec })
      const _nt = needsTiming()
      const _fmT0 = _nt ? performance.now() : 0
      let rows              = readAll(readDb.query(sql).all(...params), { mode: 'list', selectedFields: ps?.requestedFields })
      if (_nt) fireQuery({ operation: 'findMany', args, sql, params, duration: _nt ? performance.now() - _fmT0 : 0, rowCount: rows.length })
      withIncludes(rows, ps, include)
      rows = finalise(rows, ps)
      attachFlatEdges(rows, scopedBy)
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
      const { where, include, orderBy, select, scopedBy } = hctx ? hctx.args : args
      _scopedByForBuild = scopedBy ?? null
      const mode            = sdMode(hctx ? hctx.args : args)
      const htm             = htMode(hctx ? hctx.args : args)
      const ps              = parseArgs(select, include)
      const { sql, params } = buildSQL({ where, orderBy, limit: 1, parsedSelect: ps, sdMode: mode, htMode: htm })
      const _nt = needsTiming()
      const _ffT0 = _nt ? performance.now() : 0
      let row               = read(readDb.query(sql).get(...params), { mode: 'list', selectedFields: ps?.requestedFields })
      if (_nt) fireQuery({ operation: 'findFirst', args, sql, params, duration: _nt ? performance.now() - _ffT0 : 0, rowCount: row ? 1 : 0 })
      if (row) { withIncludes([row], ps, include); row = finaliseOne(row, ps); attachFlatEdges([row], scopedBy) }
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
      // Same reason as the findMany fast path: prepared against the read connection.
      if (_fastFindUniqueStmt && !_inTx() && !_edgeNamespaces.size) {
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
      const { where, include, select, scopedBy } = args
      _scopedByForBuild = scopedBy ?? null
      const mode            = sdMode(args)
      const htm             = htMode(args)
      const ps              = parseArgs(select, include)
      const { sql, params } = buildSQL({ where, limit: 2, parsedSelect: ps, sdMode: mode, htMode: htm })
      const _nt = needsTiming()
      const _fuT0 = _nt ? performance.now() : 0
      const rows            = readAll(readDb.query(sql).all(...params), { mode: 'single', selectedFields: ps?.requestedFields })
      if (_nt) fireQuery({ operation: 'findUnique', args, sql, params, duration: _nt ? performance.now() - _fuT0 : 0, rowCount: rows.length })
      if (rows.length > 1) throw new Error(`findUnique on "${tableName}" returned more than one row`)
      const row = rows[0] ?? null
      if (row) { withIncludes([row], ps, include); const _r = finaliseOne(row, ps); attachFlatEdges([_r], scopedBy); return _r }
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
      const { where, scopedBy } = hctx ? hctx.args : args
      _scopedByForBuild = scopedBy ?? null
      const mode      = sdMode(hctx ? hctx.args : args)
      const htm       = htMode(hctx ? hctx.args : args)
      const params    = []
      // Merge global filter + plugin read filters + policy filter (same as buildSQL does)
      const rawFilter    = globalFilters[accessor]
      const globalFilter = typeof rawFilter === 'function' ? rawFilter(ctx) : rawFilter
      const pluginFilters = plugins?.hasPlugins ? plugins.getReadFilters(modelName, ctx) : []
      const allFilters   = [globalFilter, ...pluginFilters].filter(Boolean)
      const mergedWhere  = allFilters.length
        ? (where ? { AND: [...allFilters, where] } : allFilters.length === 1 ? allFilters[0] : { AND: allFilters })
        : where
      const sdWhere       = softDelete ? injectSoftDeleteFilter(mergedWhere, mode) : mergedWhere
      const effectiveWhere = applyHtFilter(sdWhere, htm)
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
    // db.user.exists({ where: { email: 'alice@example.com' } })
    // → true | false
    async exists(args = {}) {
      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
      const hctx = hookRunner ? { model: modelName, operation: 'exists', args, schema: ctx.models[modelName] } : null
      if (hctx && hookRunner.hasBefore('exists')) hookRunner.runBefore(hctx, ctx)
      const { where } = hctx ? hctx.args : args
      const mode      = sdMode(hctx ? hctx.args : args)
      const htm       = htMode(hctx ? hctx.args : args)
      const params    = []
      const rawFilter    = globalFilters[accessor]
      const globalFilter = typeof rawFilter === 'function' ? rawFilter(ctx) : rawFilter
      const pluginFilters = plugins?.hasPlugins ? plugins.getReadFilters(modelName, ctx) : []
      const allFilters   = [globalFilter, ...pluginFilters].filter(Boolean)
      const mergedWhere  = allFilters.length
        ? (where ? { AND: [...allFilters, where] } : allFilters.length === 1 ? allFilters[0] : { AND: allFilters })
        : where
      const sdWhere       = softDelete ? injectSoftDeleteFilter(mergedWhere, mode) : mergedWhere
      const effectiveWhere = applyHtFilter(sdWhere, htm)
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
    // db.user.findManyAndCount({ where, orderBy, limit, offset, select, include })
    // → { rows: [...], total: 42 }
    async findManyAndCount(args = {}) {
      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
      const hctx = hookRunner ? { model: modelName, operation: 'findMany', args, schema: ctx.models[modelName] } : null
      if (hctx && hookRunner.hasBefore('findMany')) hookRunner.runBefore(hctx, ctx)
      const { where, include, orderBy, limit, offset, select, distinct } = hctx ? hctx.args : args
      const mode = sdMode(hctx ? hctx.args : args)
      const htm  = htMode(hctx ? hctx.args : args)
      const ps   = parseArgs(select, include)

      // ── rows query (with limit/offset) ──────────────────────────────────
      const { sql, params } = buildSQL({ where, orderBy, limit, offset, parsedSelect: ps, sdMode: mode, htMode: htm, distinct: distinct === true })
      const _nt = needsTiming()
      const _t0 = _nt ? performance.now() : 0
      let rows = readAll(readDb.query(sql).all(...params), { mode: 'list', selectedFields: ps?.requestedFields })
      fireQuery({ operation: 'findMany', args, sql, params, duration: _nt ? performance.now() - _t0 : 0, rowCount: rows.length })
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
      const sdMergedWhere = softDelete ? injectSoftDeleteFilter(mergedWhere, mode) : mergedWhere
      const effectiveWhere = applyHtFilter(sdMergedWhere, htm)
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
    //   db.order.query({ where: { status: 'paid' }, limit: 20 })
    //   db.order.query({ by: ['status'], _count: true })
    //   db.order.query({ _count: true, _sum: { amount: true } })
    //   db.order.query({ window: { rn: { rowNumber: true, orderBy: { id: 'asc' } } } })
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
    // db.order.aggregate({ _sum: { amount: true }, _avg: { amount: true }, _count: true, _min: { amount: true }, _max: { amount: true }, where: {...} })
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
      const sdEffective = softDelete ? injectSoftDeleteFilter(mergedWhere, 'live') : mergedWhere
      const effectiveWhere = applyHtFilter(sdEffective, 'instances')
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

      const _nt = needsTiming()
      const _t0 = _nt ? performance.now() : 0
      const raw = readDb.query(sql).get(...params) ?? {}
      fireQuery({ operation: 'aggregate', args, sql, params, duration: _nt ? performance.now() - _t0 : 0, rowCount: 1 })

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
    // db.order.groupBy({ by: ['status'], _count: true, _sum: { amount: true }, where: {...}, having: {...}, orderBy: {...}, limit, offset })
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
        if (intervalFieldDef && intervalFieldDef.type.name !== 'DateTime' && intervalFieldDef.type.name !== 'String')
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
      const sdEffective = softDelete ? injectSoftDeleteFilter(mergedWhere, 'live') : mergedWhere
      const effectiveWhere = applyHtFilter(sdEffective, 'instances')
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

      const _nt = needsTiming()
      const _t0 = _nt ? performance.now() : 0
      const raw = readDb.query(sql).all(...params)
      fireQuery({ operation: 'groupBy', args, sql, params, duration: _nt ? performance.now() - _t0 : 0, rowCount: raw.length })

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
    async create({ data, include, select, scopedBy } = {}) {
      if (ctx.hasPolicies) checkCreatePolicy(modelName, data, ctx, ctx.policyMap, ctx.schema, ctx.relationMap)
      if (plugins?.hasPlugins) await plugins.beforeCreate(modelName, { data, include, select }, ctx)
      // Auto-generate @id if field uses @default(uuid/ulid/cuid) and not provided
      const autoId = ctx.autoIdMap?.[modelName]
      if (autoId && (data == null || data[autoId.field] == null)) {
        data = { ...(data ?? {}), [autoId.field]: autoId.generate() }
      }
      data = applyAuthDefaults(data, ctx.authDefaultMap?.[modelName], ctx.auth)
      data = stampFromAuth(data, ctx.createdByMap?.[modelName], ctx.auth)
      // A new row is version 1, whatever the payload says. Honouring a supplied
      // version would let a client start a row at 500 and make the first real
      // editor's read look stale.
      if (ctx.versionMap?.[modelName]) data = { ...(data ?? {}), [ctx.versionMap[modelName]]: 1 }
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
      const { data: _scalarNoEdge, edgeWrites } = extractEdgeWrites(scalar)
      // belongsTo ops first — injects FK values before insert
      const extraFKs = await processBelongsToNested(nested)
      data = { ..._scalarNoEdge, ...extraFKs }

      const hctx = hookRunner ? { model: modelName, operation: 'create', args: { data, include, select }, schema: ctx.models[modelName] } : null
      if (hctx && hookRunner.hasBefore('create')) { hookRunner.runBefore(hctx, ctx); data = hctx.args.data }
      const row   = writeData(data, { requireAll: true })
      const cols  = Object.keys(row)
      // cols can be empty when all fields are optional and none were supplied,
      // or when all fields were stripped by @allow write policies.
      // SQLite requires DEFAULT VALUES syntax when no columns are specified.
      const _noReturn = select === false && !nested.length && !edgeWrites.length
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
      // hasMany ops after — children need parent PK + parent row (for co-FK propagation)
      const pkField = ctx.models[modelName]?.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
      await processHasManyNested(nested, created[pkField], created)
      applyEdgeWrites(edgeWrites, created[pkField], scopedBy)
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
      const createdByStamps = ctx.createdByMap?.[modelName]
      const versionField    = ctx.versionMap?.[modelName]
      let rows, _cmSql, _cmInserted = null
      let count = 0
      const _nt = needsTiming()
      const _cmT0 = _nt ? performance.now() : 0
      // The whole batch — including @sequence counter bumps — runs inside one
      // transaction. Previously applySequences ran per row BEFORE the tx, so a
      // @sequence model paid 2 auto-commit statements per row (~16x slower) and
      // counter bumps stayed committed even if the batch insert failed.
      tx.wrap(() => {
        rows = data.map(item => {
          let d = item
          if (autoId && (d == null || d[autoId.field] == null))
            d = { ...(d ?? {}), [autoId.field]: autoId.generate() }
          d = applyAuthDefaults(d, authDefaults, ctx.auth)
          d = stampFromAuth(d, createdByStamps, ctx.auth)
          if (versionField) d = { ...(d ?? {}), [versionField]: 1 }
          // Apply @sequence per row — each row gets its own counter increment
          d = applySequences(d, modelName, ctx.sequenceMap, writeDb)
          return writeData(d, { requireAll: true })
        })

        // Derive column list from the first processed row (post-transforms)
        const cols = Object.keys(rows[0])
        _cmSql = `INSERT INTO "${tableName}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
              + (tableHasAnyLog ? ` RETURNING *` : '')
        const stmt = writeDb.prepare(_cmSql)
        // RETURNING on a logged model: an @id @default(autoincrement()) row has no
        // id until SQLite assigns one, and a log entry naming no rows is not a trail.
        if (tableHasAnyLog) _cmInserted = []
        for (const row of rows) {
          const args = cols.map(c => row[c] ?? null)
          if (tableHasAnyLog) { const r = stmt.get(...args); if (r) _cmInserted.push(r) }
          else stmt.run(...args)
          count++
        }
      })
      fireQuery({ operation: 'createMany', args: { data }, sql: _cmSql, params: null, duration: _nt ? performance.now() - _cmT0 : 0, rowCount: count })
      if (_cmInserted?.length) emitLogs('create', _cmInserted)
      return { count }
    },

    // ── update ──────────────────────────────────────────────────────────────
    // Returns the updated row, or null in these cases:
    //   • No row matched the where clause
    //   • A @@allow/@@deny policy blocked the update
    //   • A post-update policy rollback was triggered
    // Callers that need to distinguish can check count() before/after,
    // or enable policyDebug to see which policy blocked.
    async update({ where, data, include, select, scopedBy, _bypassVersion } = {}) {
      if (plugins?.hasPlugins) await plugins.beforeUpdate(modelName, { where, data, include, select }, ctx)
      const hctx = hookRunner ? { model: modelName, operation: 'update', args: { where, data, include, select }, schema: ctx.models[modelName] } : null
      if (hctx && hookRunner.hasBefore('update')) { hookRunner.runBefore(hctx, ctx); where = hctx.args.where; data = hctx.args.data }
      data = stampFromAuth(data, ctx.updatedByMap?.[modelName], ctx.auth)

      // ── @version — take the caller's expected version off the payload ───────
      // It is a precondition, not a value to write: the column is bumped by SQL
      // below, never SET to what arrived. asSystem() skips the check for the
      // same reason it skips gates — a migration or a job is not a second editor.
      const _versionField = ctx.versionMap?.[modelName]
      let   _expectVersion = null
      if (_versionField) {
        const supplied = data?.[_versionField]
        if (!ctx.isSystem && !_bypassVersion) {
          if (!Number.isInteger(supplied))
            throw new VersionRequiredError(modelName, _versionField)
          _expectVersion = supplied
        }
        if (data && _versionField in data) { data = { ...data }; delete data[_versionField] }
      }

      const { scalar, nested } = extractNestedWrites(data)
      const { data: _scalarNoEdge, edgeWrites } = extractEdgeWrites(scalar)
      const extraFKs = await processBelongsToNested(nested)
      data = { ..._scalarNoEdge, ...extraFKs }

      const row       = writeData(data)
      const setParams = []
      const setCols   = Object.keys(row)
        .map(c => { setParams.push(row[c] ?? null); return `"${c}" = ?` })
        .join(', ')
      const whereParams = []
      const sdWhereW = softDelete ? injectSoftDeleteFilter(where, 'live') : where
      const effectiveWhere = applyHtFilter(sdWhereW, 'instances')
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
      const _transResult = await checkTransitions(row, whereParams, whereSql)
      // If transitions apply, narrow WHERE to include AND field = currentValue (optimistic lock)
      const { sql: _txWhereSql, params: _txWhereParams } = _transResult
        ? applyTransitionWhereClause(_transResult, finalWhereSql, finalWhereParams)
        : { sql: finalWhereSql, params: finalWhereParams }

      // ── @version — the compare half of the swap ─────────────────────────────
      // Same shape as applyTransitionWhereClause above: narrow the WHERE by the
      // value the caller read, so a row that moved simply does not match. The
      // bump rides the SET clause, which also means a versioned update always
      // has a column to write even when `data` was otherwise empty.
      const _vWhereSql    = _expectVersion == null ? _txWhereSql : `(${_txWhereSql}) AND "${_versionField}" = ?`
      const _vWhereParams = _expectVersion == null ? _txWhereParams : [..._txWhereParams, _expectVersion]
      const _setColsV     = !_versionField ? setCols
        : [setCols, `"${_versionField}" = "${_versionField}" + 1`].filter(Boolean).join(', ')

      // No rows changed can mean three different things. Not-found and
      // policy-blocked both return null (the documented contract); a row that is
      // still there at a different version is the one worth raising, because the
      // caller can re-read and re-apply.
      const throwIfVersionMoved = () => {
        if (_expectVersion == null) return
        const cur = readDb.query(`SELECT "${_versionField}" AS v FROM "${tableName}" WHERE ${whereSql}`).get(...whereParams)
        if (cur && cur.v !== _expectVersion)
          throw new VersionConflictError(modelName, _versionField, _expectVersion, cur.v)
      }

      let updated = null
      if (_setColsV) {
        // select: false + no post-update side-effects → use run(), skip RETURNING entirely
        // Note: tableHasAnyLog forces RETURNING even with select: false — the log needs
        // before/after snapshots. select: false has no perf benefit on @@log models.
        const _canSkipReturn = select === false
          && !tableHasAnyLog
          && !(ctx.hasPolicies && ctx.policyMap?.[modelName]?.['post-update'])
          && !nested.length
          && !edgeWrites.length
        if (_canSkipReturn) {
          const _upSql = `UPDATE "${tableName}" SET ${_setColsV} WHERE ${_vWhereSql}`
          const _upParams = [...setParams, ..._vWhereParams]
          const _nt = needsTiming()
          const _upT0 = _nt ? performance.now() : 0
          const result = writeDb.run(_upSql, ..._upParams)
          fireQuery({ operation: 'update', args: { where, data, include, select }, sql: _upSql, params: _upParams, duration: _nt ? performance.now() - _upT0 : 0, rowCount: result.changes })
          if (!result.changes) {
            if (_transResult) throw new TransitionConflictError(tableName, _transResult.field, _transResult.from, _transResult.to)
            throwIfVersionMoved()
            return null
          }
          if (hctx) { hctx.result = null; if (hookRunner?.hasAfter('update')) hookRunner.runAfter(hctx, ctx) }
          if (emitter) emitter.emit('update', { model: modelName, operation: 'update', result: null, schema: ctx.models[modelName] }, ctx)
          if (plugins?.hasPlugins) await plugins.afterWrite(modelName, 'update', null, ctx)
          return null
        }
        const _upSql = `UPDATE "${tableName}" SET ${_setColsV} WHERE ${_vWhereSql} RETURNING *`
        const _upParams = [...setParams, ..._vWhereParams]
        const _nt = needsTiming()
        const _upT0 = _nt ? performance.now() : 0
        // RETURNING * gives the updated row directly — no follow-up SELECT needed.
        // Uses writeDb so it works inside open transactions.
        updated = read(writeDb.query(_upSql).get(..._upParams), { mode: 'single' })
        fireQuery({ operation: 'update', args: { where, data, include, select }, sql: _upSql, params: _upParams, duration: _nt ? performance.now() - _upT0 : 0, rowCount: updated ? 1 : 0 })
        if (!updated) {
          if (_transResult) throw new TransitionConflictError(tableName, _transResult.field, _transResult.from, _transResult.to)
          throwIfVersionMoved()
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
      await processHasManyNested(nested, updated[pkField], updated)
      applyEdgeWrites(edgeWrites, updated[pkField], scopedBy)
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
      // Same stamp update() runs. Missing it here was worse than missing it
      // anywhere else: @updatedAt is a SQL trigger, so the timestamp moved while
      // the identity beside it stayed at whoever wrote last through update() —
      // a row reading "just edited by Bob" when Ann edited it.
      data = stampFromAuth(data, ctx.updatedByMap?.[modelName], ctx.auth)
      // @version bumps here but is never required: a where clause matching many
      // rows matches many versions, so there is no single value to compare
      // against. Bumping is the part that matters — without it a bulk write
      // would leave every open editor's version looking current.
      const _umVersion = ctx.versionMap?.[modelName]
      if (_umVersion && data && _umVersion in data) { data = { ...data }; delete data[_umVersion] }
      const row      = writeData(data)
      const params   = []
      const setCols  = [
        ...Object.keys(row).map(c => { params.push(row[c] ?? null); return `"${c}" = ?` }),
        ...(_umVersion ? [`"${_umVersion}" = "${_umVersion}" + 1`] : []),
      ].join(', ')
      const sdWhereW = softDelete ? injectSoftDeleteFilter(where, 'live') : where
      const effectiveWhere = applyHtFilter(sdWhereW, 'instances')
      const whereSql = buildWhereWithEncryption(effectiveWhere, params)
      const updateManyPolicy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'update', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
      if (updateManyPolicy) params.push(...updateManyPolicy.params)
      const finalWhere = whereSql && updateManyPolicy ? `(${whereSql}) AND (${updateManyPolicy.sql})`
                       : whereSql || updateManyPolicy?.sql || null
      // A logged model takes RETURNING so the trail can name the rows it changed.
      // Still one statement — bulk ops record WHICH rows and WHAT operation, never
      // their contents (same shape as createMany; see emitLogs).
      const _umSql = `UPDATE "${tableName}" SET ${setCols}${finalWhere ? ` WHERE ${finalWhere}` : ''}`
                   + (tableHasAnyLog ? ` RETURNING *` : '')
      const _nt = needsTiming()
      const _umT0 = _nt ? performance.now() : 0
      const _umRows = tableHasAnyLog ? writeDb.query(_umSql).all(...params) : null
      const count = _umRows ? _umRows.length : writeDb.run(_umSql, ...params).changes
      fireQuery({ operation: 'updateMany', args: { where, data }, sql: _umSql, params, duration: _nt ? performance.now() - _umT0 : 0, rowCount: count })
      if (_umRows?.length) emitLogs('update', _umRows)
      return { count }
    },

    // ── upsert ──────────────────────────────────────────────────────────────
    async upsert({ where, create: createData, update: updateData, include, select } = {}) {
      // ── Single-statement fast path ─────────────────────────────────────────
      // When no hooks / plugins / policies / events / logs / transitions /
      // soft-delete / global filters / field policies / sequences / nested
      // writes are in play and `where` targets exactly one unique column,
      // compile to one cached `INSERT ... ON CONFLICT(col) DO UPDATE ...
      // RETURNING *` — one round trip instead of findFirst + update/create
      // (measured ~6x). Any feature that needs the split path falls through
      // to the original read-then-write implementation below.
      fastPath: if (
        !plugins?.hasPlugins && !hookRunner && !emitter &&
        !ctx.hasPolicies && !tableHasAnyLog && !_tableTransitions &&
        !softDelete && !hasTemplates && !hasFieldPolicy && !_rawFilter &&
        !ctx.sequenceMap?.[modelName]?.length &&
        !ctx.updatedByMap?.[modelName]?.length &&
        !ctx.versionMap?.[modelName] &&
        include === undefined && select === undefined &&
        where && createData && updateData && Object.keys(updateData).length
      ) {
        const wKeys = Object.keys(where)
        if (wKeys.length !== 1) break fastPath
        const wKey = wKeys[0]
        const wVal = where[wKey]
        const wt = typeof wVal
        if (wVal == null || (wt !== 'string' && wt !== 'number' && wt !== 'bigint' && wt !== 'boolean')) break fastPath
        if (!_upsertUniqueCols().has(wKey)) break fastPath
        if (extractNestedWrites(createData).nested.length) break fastPath
        if (extractNestedWrites(updateData).nested.length) break fastPath

        // Same data massage as create(): auto-@id, auth()/field-ref defaults
        let cData = createData
        const _fpAutoId = ctx.autoIdMap?.[modelName]
        if (_fpAutoId && cData[_fpAutoId.field] == null)
          cData = { ...cData, [_fpAutoId.field]: _fpAutoId.generate() }
        cData = applyAuthDefaults(cData, ctx.authDefaultMap?.[modelName], ctx.auth)
        cData = stampFromAuth(cData, ctx.createdByMap?.[modelName], ctx.auth)
        const _fpFieldRefs = ctx.fieldRefDefaultMap?.[modelName]
        if (_fpFieldRefs?.length) {
          const stamps = {}
          for (const { field, sourceField } of _fpFieldRefs) {
            if (cData[field] == null && cData[sourceField] != null) stamps[field] = cData[sourceField]
          }
          if (Object.keys(stamps).length) cData = { ...cData, ...stamps }
        }

        // writeData runs transforms + validation on both branches' data
        const insRow = writeData({ ...cData, [wKey]: cData[wKey] ?? wVal }, { requireAll: true })
        const updRow = writeData(updateData)
        const insCols = Object.keys(insRow)
        const updCols = Object.keys(updRow).filter(c => c !== wKey)
        if (!insCols.length || !updCols.length) break fastPath

        const _fpSql =
          `INSERT INTO "${tableName}" (${insCols.map(c => `"${c}"`).join(', ')}) ` +
          `VALUES (${insCols.map(() => '?').join(', ')}) ` +
          `ON CONFLICT("${wKey}") DO UPDATE SET ${updCols.map(c => `"${c}" = ?`).join(', ')} ` +
          `RETURNING *`
        const _fpParams = [...insCols.map(c => insRow[c] ?? null), ...updCols.map(c => updRow[c] ?? null)]
        const _nt = needsTiming()
        const _fpT0 = _nt ? performance.now() : 0
        try {
          const result = read(writeDb.query(_fpSql).get(..._fpParams), { mode: 'single' })
          fireQuery({ operation: 'upsert', args: { where, create: createData, update: updateData }, sql: _fpSql, params: _fpParams, duration: _nt ? performance.now() - _fpT0 : 0, rowCount: result ? 1 : 0 })
          return result
        } catch (e) {
          // A unique conflict on a DIFFERENT column than the ON CONFLICT target
          // can't be handled by this statement — fall through to the
          // read-then-write path, which preserves the original semantics.
          if (e?.code === 'SQLITE_CONSTRAINT_UNIQUE' || e?.errno === 2067 ||
              (e?.message && e.message.includes('UNIQUE constraint failed'))) break fastPath
          throw e
        }
      }

      // Use findFirst to determine path, but wrap the create in a savepoint so
      // a concurrent insert between our check and our insert doesn't cause a
      // unique constraint error — instead we retry as an update.
      // The window for this race is tiny under SQLite's single-writer guarantee,
      // but it can happen with async code that yields between findFirst and create.
      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, { where }, ctx)
      // _bypassVersion: an upsert is "make this row look like X", reached by
      // natural key from a sync or an import. The caller does not know whether
      // the row exists, so it cannot have read a version to assert. It still
      // BUMPS — an editor holding version 3 must lose to an upsert that landed
      // after them. Concurrent editing is what update() is for.
      const existing = await this.findFirst({ where })
      if (existing) {
        return this.update({ where, data: updateData, include, select, _bypassVersion: true })
      }
      // Attempt create; if unique constraint fires (race), fall back to update
      try {
        return await this.create({ data: createData, include, select })
      } catch (e) {
        if (e?.code === 'SQLITE_CONSTRAINT_UNIQUE' || e?.errno === 2067 ||
            (e?.message && e.message.includes('UNIQUE constraint failed'))) {
          return this.update({ where, data: updateData, include, select, _bypassVersion: true })
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
    //   await db.post.upsertMany({
    //     data: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }],
    //   })
    //
    //   // Custom conflict target (e.g. unique slug)
    //   await db.post.upsertMany({
    //     data: [{ slug: 'hello', title: 'Hello' }],
    //     conflictTarget: ['slug'],
    //     update: ['title'],   // only update these fields on conflict
    //   })

    async upsertMany({ data, conflictTarget, update: updateFields } = {}) {
      if (!data?.length) return { count: 0 }
      if (plugins?.hasPlugins) await plugins.beforeCreate(modelName, { data }, ctx)

      const autoId       = ctx.autoIdMap?.[modelName]
      const authDefaults = ctx.authDefaultMap?.[modelName]
      const createdBys   = ctx.createdByMap?.[modelName]
      const updatedBys   = ctx.updatedByMap?.[modelName]
      const usVersion    = ctx.versionMap?.[modelName]

      // Which author columns WE are about to fill. An upsert is an insert for
      // some rows and an update for others, and a create-time column must not
      // ride the ON CONFLICT SET clause — a conflict is an update, and an update
      // may not rewrite who created the row. Columns the CALLER supplied are not
      // in this set: naming one is an explicit request, and excluding it would
      // change behaviour that predates the stamps.
      const supplied = new Set()
      for (const item of data) for (const k of Object.keys(item ?? {})) supplied.add(k)
      const authorCols = new Set(
        [...(createdBys ?? []), ...(authDefaults ?? [])]
          .map(s => s.field).filter(f => !supplied.has(f)))

      let sql
      let count = 0
      // Split for the audit trail — an upsert is a create for some rows and an
      // update for others, and the log entry says which. Only computed on a
      // logged model: it costs one SELECT over the batch's conflict keys.
      let _usCreated = null, _usUpdated = null
      const _nt = needsTiming()
      const _usT0 = _nt ? performance.now() : 0
      // Whole batch (incl. @sequence bumps) inside one transaction — see createMany.
      tx.wrap(() => {
        const rows = data.map(item => {
          let d = item
          if (autoId && (d == null || d[autoId.field] == null))
            d = { ...(d ?? {}), [autoId.field]: autoId.generate() }
          d = applyAuthDefaults(d, authDefaults, ctx.auth)
          d = stampFromAuth(d, createdBys, ctx.auth)
          d = stampFromAuth(d, updatedBys, ctx.auth)
          if (usVersion) d = { ...(d ?? {}), [usVersion]: 1 }
          d = applySequences(d, modelName, ctx.sequenceMap, writeDb)
          return writeData(d, { requireAll: true })
        })

        const cols    = Object.keys(rows[0])
        const target  = conflictTarget
          ? (Array.isArray(conflictTarget) ? conflictTarget : [conflictTarget])
          : [idField]

        // Build UPDATE SET clause — only the fields that aren't in the conflict target
        // An explicit `update:` list still wins outright — naming an author
        // column there is a deliberate request to move it on conflict.
        const updateCols = updateFields
          ? (Array.isArray(updateFields) ? updateFields : [updateFields]).filter(c => cols.includes(c))
          : cols.filter(c => !target.includes(c) && !authorCols.has(c))

        sql = `INSERT INTO "${tableName}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`

        // @version rides the INSERT at 1 and is BUMPED on conflict, never taken
        // from `excluded` — that would reset an existing row to 1 and make every
        // stale editor's version look current again.
        const setPairs = updateCols
          .filter(c => c !== usVersion)
          .map(c => `"${c}" = excluded."${c}"`)
        if (usVersion) setPairs.push(`"${usVersion}" = "${tableName}"."${usVersion}" + 1`)

        if (setPairs.length) {
          const conflictSql = target.map(c => `"${c}"`).join(', ')
          sql += ` ON CONFLICT(${conflictSql}) DO UPDATE SET ${setPairs.join(', ')}`
        } else {
          sql += ` ON CONFLICT DO NOTHING`
        }

        // Which conflict keys already exist — read BEFORE the writes, or every
        // row would look like an update.
        let present = null
        const keyOf = row => JSON.stringify(target.map(c => row[c] ?? null))
        if (tableHasAnyLog) {
          const clause = target.map(c => `"${c}" = ?`).join(' AND ')
          const lookup = writeDb.prepare(`SELECT 1 FROM "${tableName}" WHERE ${clause} LIMIT 1`)
          present = new Set()
          for (const row of rows) {
            if (lookup.get(...target.map(c => row[c] ?? null))) present.add(keyOf(row))
          }
          _usCreated = []
          _usUpdated = []
        }

        // RETURNING on a logged model, so the entry names rows by their real id —
        // see createMany. ON CONFLICT DO NOTHING returns nothing for a skipped row.
        if (tableHasAnyLog) sql += ` RETURNING *`
        const stmt = writeDb.prepare(sql)
        for (const row of rows) {
          const args = cols.map(c => row[c] ?? null)
          if (tableHasAnyLog) {
            const written = stmt.get(...args)
            if (written) (present.has(keyOf(row)) ? _usUpdated : _usCreated).push(written)
          } else {
            stmt.run(...args)
          }
          count++
        }
      })
      fireQuery({ operation: 'upsertMany', args: { data, conflictTarget, update: updateFields }, sql, params: null, duration: _nt ? performance.now() - _usT0 : 0, rowCount: count })
      if (_usCreated?.length) emitLogs('create', _usCreated)
      if (_usUpdated?.length) emitLogs('update', _usUpdated)
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
      const sdWhereW = softDelete ? injectSoftDeleteFilter(where, 'live') : where
      const effectiveWhere = applyHtFilter(sdWhereW, 'instances')
      const whereSql = buildWhereWithEncryption(effectiveWhere, params)
      if (!whereSql) throw new Error(`remove on "${tableName}" requires a where clause`)
      const removePolicy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'delete', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
      const removeFinalSql = removePolicy ? `(${whereSql}) AND (${removePolicy.sql})` : whereSql
      const removeFinalParams = removePolicy ? [...params, ...removePolicy.params] : params

      // No unconditional pre-SELECT: the soft path gets the row back from
      // UPDATE ... RETURNING and the hard path from DELETE ... RETURNING, so
      // remove() is one statement on the common path instead of two. The
      // pre-delete "before" snapshot for logging is reconstructed from the
      // RETURNING row (soft delete only changes deletedAt, which was NULL).

      if (softDelete) {
        const ts = nowISO()
        const _rmSql = `UPDATE "${tableName}" SET "deletedAt" = ? WHERE ${removeFinalSql} RETURNING *`
        const _nt = needsTiming()
        const _rmT0 = _nt ? performance.now() : 0
        const softResult = read(writeDb.query(_rmSql).get(ts, ...removeFinalParams), { mode: 'single' })
        fireQuery({ operation: 'remove', args: { where }, sql: _rmSql, params: [ts, ...removeFinalParams], duration: _nt ? performance.now() - _rmT0 : 0, rowCount: softResult ? 1 : 0 })
        if (!softResult) return null

        // Cascade soft delete to child tables if @@softDeleteCascade is set
        if (softDeleteCascade) {
          const cascadeTargets = _cascadeTargets()
          if (cascadeTargets.length > 0) {
            // Track affected PK values per table so multi-level cascades work correctly
            // e.g. accounts(id=1) → users(id=1,2) → posts: use users' ids for posts cascade
            const affectedPKs = new Map([[modelName, [softResult.id]]])
            for (const { childModel, childTable, foreignKey, referencedKey, parentModel, hardDelete } of cascadeTargets) {
              const parentPKs = affectedPKs.get(parentModel) ?? []
              if (!parentPKs.length) continue
              const ph = parentPKs.map(() => '?').join(',')
              if (hardDelete) {
                // @hardDelete: physically remove child rows instead of stamping deletedAt
                writeDb.run(`DELETE FROM "${childTable}" WHERE "${foreignKey}" IN (${ph})`, ...parentPKs)
                // Hard-delete children are terminal — no need to track their PKs for further cascade
              } else if (_cascadeParents.has(childModel)) {
                writeDb.run(`UPDATE "${childTable}" SET "deletedAt" = ? WHERE "${foreignKey}" IN (${ph}) AND "deletedAt" IS NULL`, ts, ...parentPKs)
                const childPKs = readDb.query(`SELECT "${referencedKey}" FROM "${childTable}" WHERE "${foreignKey}" IN (${ph})`).all(...parentPKs).map(r => r[referencedKey])
                affectedPKs.set(childModel, childPKs)
              } else {
                // Leaf child — nothing downstream consumes its PKs, skip the readback SELECT
                writeDb.run(`UPDATE "${childTable}" SET "deletedAt" = ? WHERE "${foreignKey}" IN (${ph}) AND "deletedAt" IS NULL`, ts, ...parentPKs)
              }
            }
          }
        }

        if (emitter) emitter.emit('remove', { model: modelName, operation: 'remove', result: softResult, schema: ctx.models[modelName] }, ctx)
        if (plugins?.hasPlugins) await plugins.afterWrite(modelName, 'delete', softResult, ctx)
        // ── Logging ──────────────────────────────────────────────────────────
        if (tableHasAnyLog) emitLogs('delete', [softResult], { before: { ...softResult, deletedAt: null } })
        return softResult
      }

      const _rmHSql = `DELETE FROM "${tableName}" WHERE ${removeFinalSql} RETURNING *`
      const _nt = needsTiming()
      const _rmHT0 = _nt ? performance.now() : 0
      const row = read(writeDb.query(_rmHSql).get(...removeFinalParams), { mode: 'single' })
      fireQuery({ operation: 'remove', args: { where }, sql: _rmHSql, params: removeFinalParams, duration: _nt ? performance.now() - _rmHT0 : 0, rowCount: row ? 1 : 0 })
      if (!row) return null
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
      const sdWhereW = softDelete ? injectSoftDeleteFilter(where, 'live') : where
      const effectiveWhere = applyHtFilter(sdWhereW, 'instances')
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
          const cascadeTargets = _cascadeTargets()
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
                if (_cascadeParents.has(childModel)) {
                  const childPKs = readDb.query(`SELECT "${referencedKey}" FROM "${childTable}" WHERE "${foreignKey}" IN (${ph})`).all(...parentPKs).map(r => r[referencedKey])
                  affectedPKs.set(childModel, childPKs)
                }
              }
            }
          }
        }

        // RETURNING only on a logged model — see updateMany.
        const _rmsSql = `UPDATE "${tableName}" SET "deletedAt" = ?${rmFinalSql ? ` WHERE ${rmFinalSql}` : ''}`
                      + (tableHasAnyLog ? ` RETURNING *` : '')
        const _rmsRows = tableHasAnyLog ? writeDb.query(_rmsSql).all(ts, ...params) : null
        const softCount = _rmsRows ? _rmsRows.length : writeDb.run(_rmsSql, ts, ...params).changes
        if (_rmsRows?.length) emitLogs('delete', _rmsRows)
        return { count: softCount }
      }

      const _rmnSql = `DELETE FROM "${tableName}"${rmFinalSql ? ` WHERE ${rmFinalSql}` : ''}`
                    + (tableHasAnyLog ? ` RETURNING *` : '')
      const _nt = needsTiming()
      const _rmnT0 = _nt ? performance.now() : 0
      const _rmnRows = tableHasAnyLog ? writeDb.query(_rmnSql).all(...params) : null
      const count = _rmnRows ? _rmnRows.length : writeDb.run(_rmnSql, ...params).changes
      fireQuery({ operation: 'removeMany', args: { where }, sql: _rmnSql, params, duration: _nt ? performance.now() - _rmnT0 : 0, rowCount: count })
      if (plugins?.hasPlugins && affectedRows.length)
        await plugins.afterDelete(modelName, affectedRows, ctx)
      if (_rmnRows?.length) emitLogs('delete', _rmnRows)
      return { count }
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
        const cascadeTargets = _cascadeTargets()
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
            if (_cascadeParents.has(childModel)) {
              const childPKs = readDb.query(`SELECT "${referencedKey}" FROM "${childTable}" WHERE "${foreignKey}" IN (${ph})`).all(...parentPKs).map(r => r[referencedKey])
              affectedPKs.set(childModel, childPKs)
            }
          }
        }
      }

      const _rsSql = `UPDATE "${tableName}" SET "deletedAt" = NULL WHERE ${whereSql} RETURNING *`
      const _nt = needsTiming()
      const _rsT0 = _nt ? performance.now() : 0
      const restored = writeDb.query(_rsSql).all(...params)
      fireQuery({ operation: 'restore', args: { where }, sql: _rsSql, params, duration: _nt ? performance.now() - _rsT0 : 0, rowCount: restored.length })
      // Un-deleting is a write and belongs in the trail. It logs as 'update' —
      // the entry vocabulary is create|update|delete|read, and a restored row is
      // a row that changed state, not one that was created.
      if (tableHasAnyLog && restored.length) emitLogs('update', restored)
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
    //   const p1 = await db.user.findManyCursor({ limit: 50, orderBy: { id: 'asc' } })
    //   const p2 = await db.user.findManyCursor({ limit: 50, orderBy: { id: 'asc' }, cursor: p1.nextCursor })
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
      withTemplates = false,
      onlyTemplates = false,
    } = {}) {
      if (!ftsFields) {
        throw new Error(
          `search() is not available on "${tableName}" — add @@fts([field1, field2]) to the model`
        )
      }

      const ftsTable = `${tableName}_fts`
      const mode     = withDeleted ? 'withDeleted' : onlyDeleted ? 'onlyDeleted' : 'live'
      const htm      = withTemplates ? 'withTemplates' : onlyTemplates ? 'onlyTemplates' : 'instances'

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
      const idFilter     = { id: { in: rowids } }
      const effectiveWhere = applyHtFilter(
        softDelete
          ? injectSoftDeleteFilter(
              where ? { AND: [idFilter, where] } : idFilter,
              mode
            )
          : (where ? { AND: [idFilter, where] } : idFilter),
        htm
      )

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
                    + (tableHasAnyLog ? ` RETURNING *` : '')
      const _nt = needsTiming()
      const _dmnT0 = _nt ? performance.now() : 0
      const _dmnRows = tableHasAnyLog ? writeDb.query(_dmnSql).all(...params) : null
      const result = { changes: _dmnRows ? _dmnRows.length : writeDb.run(_dmnSql, ...params).changes }
      fireQuery({ operation: 'deleteMany', args: { where }, sql: _dmnSql, params, duration: _nt ? performance.now() - _dmnT0 : 0, rowCount: result.changes })
      if (plugins?.hasPlugins && affectedRows.length)
        await plugins.afterDelete(modelName, affectedRows, ctx)
      if (_dmnRows?.length) emitLogs('delete', _dmnRows)
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

    // ── transitions ─────────────────────────────────────────────────────────
    // The legal next states for this record at this caller's level — the thing
    // a UI needs to render exactly the right buttons and nothing else.
    //
    // Accepts a row (no round trip) or an id (one read). Returns every move
    // legal from the record's current value, each flagged with `allowed`:
    // a gated move the caller can't make is reported, not hidden, because a
    // greyed-out button is usually better UI than a missing one. Callers that
    // want only the usable ones filter on `allowed`.
    //
    // Mirrored on the client by sierra's resource.transitions(row, level),
    // which reads the same shape out of the JSON Schema's x-transitions.
    async transitions(idOrRow) {
      if (!_tableTransitions) return []

      let row = idOrRow
      if (row == null || typeof row !== 'object')
        row = await this.findUnique({ where: { [idField]: idOrRow } })
      if (!row) return []

      // Only resolve a level if some reachable transition actually gates.
      let level = null
      const levelFor = async () => (level ??= ctx.isSystem ? 8 : await transitionLevel())

      const out = []
      for (const [fieldName, spec] of Object.entries(_tableTransitions)) {
        const currentValue = row[fieldName]
        if (currentValue == null) continue
        for (const [name, { from, to, gate }] of Object.entries(spec.transitions)) {
          if (!from.includes(currentValue)) continue
          const allowed = gate == null ? true : (await levelFor()) >= gate
          out.push({ name, field: fieldName, from: currentValue, to, gate: gate ?? null, allowed })
        }
      }
      return out
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
      f('operation',  'String'),
      f('model',      'String'),
      f('field',      'String',     true),
      f('records',    'Json'),
      f('before',     'Json',     true),
      f('after',      'Json',     true),
      // NOT Int. The actor is whatever the host app's users are keyed by, and
      // @frontierjs/auth issues `id String @id @default(uuid())` — so an Int
      // column threw SQLITE_CONSTRAINT_DATATYPE on the first audited write with
      // a known actor, taking the request with it. `Any` is a real SQLite STRICT
      // column type; the jsonl driver maps it, and the .jsonl itself was always
      // untyped JSON.
      f('actorId',    'Any',  true),
      f('actorType',  'String',     true),
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
  allowChildFkOverride = false,     // false (default) → parent's co-FK silently overwrites child's value
                                    // true → explicit child value wins; missing values still auto-filled
} = {}) {

  // ── Parse schema ───────────────────────────────────────────────────────────
  // Resolution order: parsed > schema (inline string) > path (file)
  //
  //   createClient({ path: './db/schema.lite' })
  //   createClient({ schema: `model User { id Int @id }`, db: ':memory:' })
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

  // View-as-model stubs let ctx.models[viewName] resolve in makeTable for read
  // operations (findMany etc. on views). View field AST doesn't carry the
  // `attributes` array that model fields have, so we backfill empty arrays
  // here — without this, every model loop in DDL/validate that calls
  // f.attributes.find(...) will throw on the stub.
  const viewModelStubs = (rawSchema.views ?? []).map(view => ({
    name:       view.name,
    fields:     view.fields.map(f => ({
      name:       f.name,
      type:       f.type,
      attributes: f.attributes ?? [],
      comments:   f.comments   ?? [],
    })),
    // @@external prevents DDL from trying to CREATE TABLE this stub — the
    // actual CREATE VIEW / CREATE TABLE-for-materialized-view emit later in
    // generateDDL handles views correctly. Without @@external, the model loop
    // would emit a duplicate CREATE TABLE for the view name.
    attributes: [
      { kind: 'db', name: view.db ?? 'main' },
      { kind: 'external' },
    ],
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

  // Shared with the transaction manager below. Every read connection is wrapped
  // BEFORE anything destructures the registry, so tables, views, includes and
  // cache reporting all get the routing version.
  const txState = { depth: 0 }
  for (const conn of Object.values(dbRegistry)) {
    // Read-only clients keep the plain connection: their writeDb is a throwing
    // stub, and they can never open a transaction to route into it.
    if (conn.driver === 'jsonl' || conn.driver === 'logger') continue
    if (!conn.readDb || !conn.rawWriteDb) continue
    conn.readDb = makeReadRouter(conn.readDb, conn.writeDb, txState)
  }


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
          const [{ generateDDL, generateDDLForDatabase }, { splitStatements }] = await Promise.all([
            import('./ddl.js'), import('./migrate.js')
          ])
          ddlMods = { generateDDL, generateDDLForDatabase, splitStatements }
        }
        // Scope DDL to THIS database's models. Using the full-schema DDL here
        // put every model's tables into every fresh database in multi-DB
        // schemas (main got analytics' tables and vice versa), which then
        // showed up as permanent phantom drift in migration diffs.
        const hasDbBlocks = schema.databases?.some(d => !d.driver || d.driver === 'sqlite')
        const ddl = hasDbBlocks
          ? ddlMods.generateDDLForDatabase(schema, dbName, { foreignKeys: true, pluralize: pluralizeTableNames })
          : ddlMods.generateDDL(schema, { foreignKeys: true, pluralize: pluralizeTableNames })
        for (const stmt of ddlMods.splitStatements(ddl)) {
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
  const edgeMap       = buildEdgeMap(schema, pluralizeTableNames)
  const coFkMap       = buildCoFkMap(schema, relationMap)
  const softDeleteMap        = buildSoftDeleteMap(schema)
  const softDeleteCascadeMap = buildSoftDeleteCascadeMap(schema)
  const hasTemplatesMap      = buildHasTemplatesMap(schema)
  const boolMap        = buildBoolMap(schema)
  const autoIdMap      = buildAutoIdMap(schema)
  const authDefaultMap     = buildAuthDefaultMap(schema)
  const fieldRefDefaultMap = buildFieldRefDefaultMap(schema)
  const updatedByMap       = buildUpdatedByMap(schema)
  const createdByMap       = buildCreatedByMap(schema)
  const versionMap         = buildVersionMap(schema)
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
  const encryptedFields = []
  for (const m of schema.models)
    for (const f of m.fields)
      if (f.attributes.find(a => a.kind === 'encrypted'))
        encryptedFields.push(`${m.name}.${f.name}`)
  const hasEncryptedFields = encryptedFields.length > 0
  if (hasEncryptedFields && !encKey) {
    // Look for env vars the user *probably* intended to pass — common naming
    // patterns and any var matching a 64-char hex string. Helps diagnose the
    // forgot-to-forward-the-env case (Bun loads .env, but createClient still
    // needs an explicit `encryptionKey:` argument).
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {}
    const conventional = [
      'ENCRYPTION_KEY', 'LITESTONE_KEY',
      'LITESTONE_ENCRYPTION_KEY', 'DB_ENCRYPTION_KEY',
    ].filter(k => typeof env[k] === 'string' && env[k].length > 0)

    const looksLikeKey = (v) => typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v)
    const heuristic = Object.keys(env)
      .filter(k => !conventional.includes(k))
      .filter(k => looksLikeKey(env[k]))
      .slice(0, 3) // cap to avoid noise

    const lines = [
      'Schema has @encrypted fields but no encryption key was provided.',
      `  affected fields: ${encryptedFields.slice(0, 5).join(', ')}` +
        (encryptedFields.length > 5 ? ` (+${encryptedFields.length - 5} more)` : ''),
      '',
      "Fix: pass encryptionKey to createClient():",
      "  createClient({ schema: '...', encryptionKey: process.env.ENCRYPTION_KEY })",
    ]
    if (conventional.length > 0) {
      lines.push(
        '',
        `Detected ${conventional.map(k => `process.env.${k}`).join(', ')} in your environment ` +
          `but it wasn't passed in. Bun auto-loads .env, but createClient still ` +
          `needs an explicit \`encryptionKey:\` argument.`,
      )
    } else if (heuristic.length > 0) {
      lines.push(
        '',
        `Hint: these env vars look like 32-byte hex keys — did you mean one of them?`,
        ...heuristic.map(k => `  process.env.${k}`),
      )
    } else {
      lines.push(
        '',
        'No likely key found in process.env. Generate one with:',
        '  openssl rand -hex 32',
        'and add to .env as ENCRYPTION_KEY=...',
      )
    }
    throw new Error(lines.join('\n'))
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

  // Transaction manager operates on the write connection. It shares `txState`
  // with the read routers above, so an open transaction pulls reads onto this
  // same connection — otherwise they cannot see its uncommitted writes.
  const tx = makeTxManager(writeDb, txState)

  // Normalise global filters: { tableName: whereObject | (ctx) => whereObject }
  const globalFilters = filters ?? {}

  // ── Default gate enforcement ──────────────────────────────────────────────
  // A model that declares @@gate gets enforcement even when the app installs
  // no GatePlugin — the declaration is the contract, and a declared gate that
  // silently does nothing is a fail-open security default. The shipped
  // FrontierGateGetLevel resolver is the default; installing your own
  // GatePlugin({ getLevel }) replaces it entirely. Models without @@gate are
  // untouched: no gate declared, no gate enforced.
  //
  // A @@transitions clause carrying @gate(N) needs a level resolver for the
  // same reason, so it triggers the same auto-install.
  let effectivePlugins = plugins ?? []
  const _anyGates = schema.models.some(m => m.attributes?.some(a =>
    a.kind === 'gate' ||
    (a.kind === 'transitions' && Object.values(a.transitions).some(t => t.gate != null))
  ))
  if (_anyGates && !effectivePlugins.some(p => p instanceof GatePlugin)) {
    effectivePlugins = [...effectivePlugins, new GatePlugin({ getLevel: FrontierGateGetLevel })]
  }

  // Plugin runner — orchestrates all installed plugins
  const pluginRunner = new PluginRunner(effectivePlugins)

  // Shared context threaded through include resolution + table ops
  const ctx = {
    relationMap, jsonMap, edgeMap, computedSets,
    softDeleteMap, softDeleteCascadeMap, hasTemplatesMap, ftsMap, boolMap, enumMap, autoIdMap, authDefaultMap, fieldRefDefaultMap, updatedByMap, createdByMap, versionMap, selfRelationMap, sequenceMap, computedFns, tx,
    coFkMap,
    // Default: parent values silently overwrite any child-supplied co-FK
    // values during nested writes — this is the safe choice that prevents
    // referential drift like a child line item ending up with a different
    // tenantId than its parent order. Setting allowChildFkOverride:true flips
    // the policy so an explicit child value wins, but a missing one still
    // gets auto-filled.
    allowChildFkOverride: allowChildFkOverride === true,
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
  function buildTableForModel(model, ctx) {
    const dbName    = modelDbMap[model.name] ?? 'main'
    const conn      = dbRegistry[dbName] ?? dbRegistry.main
    const sqlTable  = modelToTableName(model, pluralizeTableNames)

    if (conn.driver === 'jsonl' || conn.driver === 'logger') {
      return withArgValidation(jsonlTableCache[model.name], model, ctx)
    }
    return withArgValidation(makeTable(
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
    ), model, ctx)
  }

  function makeAllTables(ctx) {
    const tables = {}

    // ── Models ──────────────────────────────────────────────────────────────
    for (const model of schema.models) {
      tables[modelToAccessor(model.name)] = buildTableForModel(model, ctx)
    }

    // ── Views ───────────────────────────────────────────────────────────────
    // Views are read-only. Regular views (CREATE VIEW) and materialized views
    // (real tables) both use makeTable for read operations; writes are blocked.
    for (const view of (schema.views ?? [])) {
      const built = buildTableForView(view, ctx)
      if (built) tables[view.name] = built
    }

    return tables
  }

  function buildTableForView(view, ctx) {
      const dbName = view.db ?? 'main'
      const conn   = dbRegistry[dbName] ?? dbRegistry.main
      if (conn.driver === 'jsonl' || conn.driver === 'logger') return null

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
      return {
        findMany:          baseTable.findMany.bind(baseTable),
        findFirst:         baseTable.findFirst.bind(baseTable),
        findUnique:        baseTable.findUnique.bind(baseTable),
        findFirstOrThrow:  baseTable.findFirstOrThrow.bind(baseTable),
        findUniqueOrThrow: baseTable.findUniqueOrThrow.bind(baseTable),
        count:             baseTable.count.bind(baseTable),
        exists:            baseTable.exists.bind(baseTable),
        aggregate:         baseTable.aggregate.bind(baseTable),
        groupBy:           baseTable.groupBy.bind(baseTable),
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

  // Accessor-name → builder lookup, used by the lazy per-auth table proxy.
  // Built once — schema is immutable after createClient.
  const _tableBuilders = new Map()
  for (const model of schema.models) _tableBuilders.set(modelToAccessor(model.name), (ctx) => buildTableForModel(model, ctx))
  for (const view of (schema.views ?? [])) _tableBuilders.set(view.name, (ctx) => buildTableForView(view, ctx))
  const _tableAccessorNames = [..._tableBuilders.keys()]

  // Lazily-constructed tables object for auth-scoped clients. $setAuth used to
  // eagerly rebuild EVERY table (~40 closures per model) per call — ~105µs on a
  // 15-model schema, paid per request since req.user is a fresh object each
  // time. Now a table is built on first access, so $setAuth is O(models touched).
  function makeLazyTables(ctx) {
    const cache = Object.create(null)
    const get = (prop) => {
      if (cache[prop] !== undefined) return cache[prop]
      const build = _tableBuilders.get(prop)
      if (!build) return undefined
      const t = build(ctx)
      if (t != null) cache[prop] = t
      return t
    }
    return new Proxy({}, {
      get(_, prop) { return typeof prop === 'string' ? get(prop) : undefined },
      has(_, prop) { return typeof prop === 'string' && _tableBuilders.has(prop) },
      ownKeys() { return _tableAccessorNames },
      getOwnPropertyDescriptor(_, prop) {
        if (typeof prop === 'string' && _tableBuilders.has(prop))
          return { configurable: true, enumerable: true, get: () => get(prop) }
        return undefined
      },
    })
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
        } else if (k === 'data') {
          // `data` is a write-only default (see scopeDataDefault) — never a read arg
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

  // ── scope write helpers ────────────────────────────────────────────────────
  // Create-time data default for a scope stack: an explicit `data` object on the
  // scope, or — for a flat-equality where like { type: 'lead' } — the equalities
  // themselves. Operators, AND/OR/NOT, and nested/complex wheres contribute
  // nothing. An explicit `data` (even `{}`) on a scope suppresses inference for it,
  // so you can filter without stamping.
  function scopeDataDefault(resolvedScopeArgs) {
    const data = {}
    for (const sa of resolvedScopeArgs) {
      if ('data' in sa) {
        if (sa.data && typeof sa.data === 'object' && !Array.isArray(sa.data)) Object.assign(data, sa.data)
        continue
      }
      const w = sa.where
      if (w && typeof w === 'object' && !Array.isArray(w)) {
        for (const [k, v] of Object.entries(w)) {
          if (v === null || typeof v === 'object') continue
          if (k === 'AND' || k === 'OR' || k === 'NOT') continue
          data[k] = v
        }
      }
    }
    return data
  }

  function scopeWhereClause(resolvedScopeArgs) {
    const wheres = resolvedScopeArgs.map(sa => sa.where).filter(w => w != null)
    if (!wheres.length) return null
    return wheres.length === 1 ? wheres[0] : { AND: wheres }
  }

  const andWhere = (a, b) => (!a ? b : !b ? a : { AND: [a, b] })

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

    // ── Writes under a scope ──────────────────────────────────────────────────
    // create/createMany stamp the scope's data default (caller data wins);
    // update/delete/etc. AND-merge the scope where so a write can only touch rows
    // inside the subset (you can't update a client through db.contact.leads).
    const SCOPED_CREATE_METHODS = ['create', 'createMany']
    const SCOPED_WHERE_METHODS  = ['update', 'updateMany', 'remove', 'removeMany', 'delete', 'deleteMany', 'restore']

    const stampData = (methodName, callerArgs, dataDefault) => {
      if (!dataDefault || !Object.keys(dataDefault).length) return callerArgs
      const a = { ...callerArgs }
      if (methodName === 'createMany') a.data = (a.data ?? []).map(r => ({ ...dataDefault, ...r }))
      else                            a.data = { ...dataDefault, ...(a.data ?? {}) }
      return a
    }

    for (const m of SCOPED_CREATE_METHODS) {
      if (typeof tableAccessor[m] !== 'function') continue
      callable[m] = (callerArgs = {}) => {
        const resolved = resolveScopeStack(scopeStack, ctxResolver())
        return tableAccessor[m](stampData(m, callerArgs, scopeDataDefault(resolved)))
      }
    }

    for (const m of SCOPED_WHERE_METHODS) {
      if (typeof tableAccessor[m] !== 'function') continue
      callable[m] = (callerArgs = {}) => {
        const resolved = resolveScopeStack(scopeStack, ctxResolver())
        return tableAccessor[m]({ ...callerArgs, where: andWhere(scopeWhereClause(resolved), callerArgs?.where) })
      }
    }

    // upsert / upsertMany: stamp the create default (the conflict-target where is
    // left untouched — merging the scope filter into it would break conflict detection).
    if (typeof tableAccessor.upsert === 'function') {
      callable.upsert = (callerArgs = {}) => {
        const resolved = resolveScopeStack(scopeStack, ctxResolver())
        const dd = scopeDataDefault(resolved)
        return tableAccessor.upsert(Object.keys(dd).length ? { ...callerArgs, create: { ...dd, ...(callerArgs.create ?? {}) } } : callerArgs)
      }
    }
    if (typeof tableAccessor.upsertMany === 'function') {
      callable.upsertMany = (callerArgs = {}) => {
        const resolved = resolveScopeStack(scopeStack, ctxResolver())
        const dd = scopeDataDefault(resolved)
        return tableAccessor.upsertMany(Object.keys(dd).length ? { ...callerArgs, data: (callerArgs.data ?? []).map(r => ({ ...dd, ...r })) } : callerArgs)
      }
    }

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
  // Wrap one table accessor: same methods, plus scope properties as getters.
  // Uses a Proxy so we don't modify the original tableAccessor (which might
  // be referenced elsewhere — by ctx.tables, by the unscoped client, etc.)
  function wrapTableWithScopes(tableAccessor, scopeMap, ctxResolver) {
    return new Proxy(tableAccessor, {
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
  }

  function installScopes(tablesObj, ctxResolver) {
    if (!Object.keys(scopesByAccessor).length) return tablesObj

    const out = { ...tablesObj }
    for (const [accessor, scopeMap] of Object.entries(scopesByAccessor)) {
      const tableAccessor = out[accessor]
      if (!tableAccessor) continue
      out[accessor] = wrapTableWithScopes(tableAccessor, scopeMap, ctxResolver)
    }
    return out
  }

  // Lazy variant of installScopes for the per-auth table proxies — wraps each
  // accessor with its scopes on first access instead of spreading (and thereby
  // materializing) the whole tables object up front.
  function installScopesLazy(tablesProxy, ctxResolver) {
    if (!Object.keys(scopesByAccessor).length) return tablesProxy
    const cache = Object.create(null)
    const get = (prop) => {
      if (cache[prop] !== undefined) return cache[prop]
      const t = tablesProxy[prop]
      if (t === undefined) return undefined
      const scopeMap = scopesByAccessor[prop]
      const wrapped = scopeMap ? wrapTableWithScopes(t, scopeMap, ctxResolver) : t
      cache[prop] = wrapped
      return wrapped
    }
    return new Proxy({}, {
      get(_, prop) { return typeof prop === 'string' ? get(prop) : undefined },
      has(_, prop) { return typeof prop === 'string' && prop in tablesProxy },
      ownKeys() { return Reflect.ownKeys(tablesProxy) },
      getOwnPropertyDescriptor(_, prop) {
        if (typeof prop === 'string' && prop in tablesProxy)
          return { configurable: true, enumerable: true, get: () => get(prop) }
        return undefined
      },
    })
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

  // Computed once. A schema with no access declarations has nothing for raw SQL
  // to bypass, so `db.sql` there is unchanged.
  const _hasAccessRules = schemaDeclaresAccessRules(schema)

  /** The one raw runner. There were three byte-identical copies of this. */
  function _runRawSql(strings, values) {
    let query = ''
    for (let i = 0; i < strings.length; i++) {
      query += strings[i]
      if (i < values.length) query += '?'
    }
    return readDb.query(query.trim()).all(...values)
  }

  async function sql(strings, ...values) {
    if (_hasAccessRules) throw rawSqlRefusal('db.sql')
    return _runRawSql(strings, values)
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

    const ROTATE_BATCH = 1000

    for (const [dbName, models] of Object.entries(byDb)) {
      const conn = dbRegistry[dbName]
      const rawDb = conn?.rawWriteDb
      if (!rawDb) continue   // jsonl or disabled — skip

      // One write transaction per database — per-row auto-commit is ~1000x
      // slower (one WAL commit per UPDATE). BEGIN IMMEDIATE takes the write
      // lock up front so we don't upgrade mid-rotation.
      rawDb.run('BEGIN IMMEDIATE')
      try {
        for (const { modelName, modelDef, rotatableFields } of models) {
          const tableName = modelToTableName(modelDef, pluralizeTableNames)
          const cols      = rotatableFields.map(f => `"${f}"`).join(', ')
          // Alias rowid explicitly — when a table has INTEGER PRIMARY KEY, rowid
          // is an alias for that column and SQLite's driver collapses the duplicate,
          // dropping the `rowid` key from the returned row object.
          // Page by rowid instead of loading the whole table into memory.
          const pageStmt = rawDb.query(
            `SELECT rowid AS __litestone_rowid, ${cols} FROM "${tableName}" WHERE rowid > ? ORDER BY rowid LIMIT ${ROTATE_BATCH}`
          )
          let updated   = 0
          let lastRowid = -9007199254740991   // below any real rowid

          while (true) {
            const rows = pageStmt.all(lastRowid)
            if (!rows.length) break
            for (const row of rows) {
              lastRowid = row.__litestone_rowid
              const sets = []
              const vals = []
              for (const fieldName of rotatableFields) {
                if (row[fieldName] == null) continue
                const plain = decryptField(row[fieldName], ctx.encKey)
                sets.push(`"${fieldName}" = ?`)
                vals.push(encryptField(plain, newKey))
              }
              if (!sets.length) continue
              // rawDb.query() caches the prepared statement per distinct SQL shape
              rawDb.query(`UPDATE "${tableName}" SET ${sets.join(', ')} WHERE rowid = ?`).run(...vals, row.__litestone_rowid)
              updated++
            }
            if (rows.length < ROTATE_BATCH) break
          }

          results[modelName] = { rows: updated, fields: rotatableFields.length }
        }
        rawDb.run('COMMIT')
      } catch (err) {
        try { rawDb.run('ROLLBACK') } catch {}
        throw err
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
    // No guard: asSystem() IS the documented bypass, and refusing here would
    // leave no way to run a raw statement at all.
    async function sysSql(strings, ...values) {
      return _runRawSql(strings, values)
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
    // Tables are built lazily on first access — $setAuth per request is
    // O(models actually touched), not O(all models). See makeLazyTables.
    const rawAuthTables = makeLazyTables(authCtx)
    authCtx.tables = rawAuthTables
    // Apply scopes — auth ctx is fixed for this $setAuth() call, so the
    // ctxResolver returns authCtx directly. Dynamic where(ctx) sees user.
    const authTables = installScopesLazy(rawAuthTables, () => authCtx)

    // The reported hole. This closed over `user` and never read it, so it was
    // byte-identical to the unscoped `sql` — while `authQuery` directly below
    // goes to real trouble to keep the same auth context alive through
    // $transaction. Same proxy, same closure: one preserved the scope, one
    // silently dropped it.
    async function authSql(strings, ...values) {
      if (_hasAccessRules) throw rawSqlRefusal('db.$setAuth(user).sql')
      return _runRawSql(strings, values)
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

    const authProxy = new Proxy({ sql: authSql, query: authQuery, $transaction, $backup, $walStatus, $rotateKey, $attach, $detach, $db: rawWriteDb, asSystem, $setAuth, $scopedBy: (b) => _makeScopedProxy({ scopedBy: b, auth: user }) }, {
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

  // ── $scopedBy — bind edge dimensions for subsequent ops (D13) ──────────────────
  // db.$scopedBy({ projectId: 123 }).task.findMany() — chainable with $setAuth.
  // The runtime reads ctx.scopedBy in edge resolve/read/filter, so binding is just
  // building tables from a ctx that carries the dimension bag.
  function _makeScopedProxy(overrides) {
    const sCtx = { ...ctx, ...overrides }
    const rawTables = makeLazyTables(sCtx)
    sCtx.tables = rawTables
    const tables = installScopesLazy(rawTables, () => sCtx)
    const target = {
      $scopedBy: (b) => _makeScopedProxy({ ...overrides, scopedBy: { ...(overrides.scopedBy ?? {}), ...(b ?? {}) } }),
      $setAuth:  (u) => _makeScopedProxy({ ...overrides, auth: u }),
      asSystem, $transaction, $backup, $walStatus, $rotateKey, $attach, $detach, $db: rawWriteDb,
    }
    return new Proxy(target, {
      get(t, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'then' || prop === 'catch' || prop === 'finally' || prop === 'toJSON') return undefined
        if (prop in t)          return Reflect.get(t, prop)
        if (prop in tables)     return tables[prop]
        if (prop === '$close')  return () => _closeAll()
        if (prop === '$schema') return schema
        if (prop === '$scope')  return overrides.scopedBy ?? {}
        if (prop === '$auth')   return overrides.auth ?? null
        if (prop === '$enums')  return Object.fromEntries(schema.enums.map(e => [e.name, [...e.values.map(v => v.name)]]))
        throw new Error(`"${prop}" is not a table in this schema. Tables: ${Object.keys(tables).join(', ')}`)
      },
      ownKeys(t)   { return [...Reflect.ownKeys(t), ...Object.keys(tables)] },
      has(t, prop) { return prop in t || prop in tables },
    })
  }
  function $scopedBy(bindings) {
    return _makeScopedProxy({ scopedBy: { ...(ctx.scopedBy ?? {}), ...(bindings ?? {}) }, auth: ctx.auth })
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
      if (prop === '$scopedBy')       return $scopedBy
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
        '$close', '$attached', '$schema', '$relations', '$softDelete', '$cacheSize', '$config', '$databases', '$rawDbs', '$tapQuery', '$enums', '$setAuth', '$scopedBy', '$lock', '$locks', '$db',
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
