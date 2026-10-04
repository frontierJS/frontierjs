// client.js — Litestone query client
//
// Key design decisions:
//   Dual connections:  readDb (readonly) + writeDb — WAL mode allows concurrent reads
//   Soft delete:       models with deletedAt field get auto-filtering + soft ops
//   Statement cache:   compiled statements reused across calls via wrapDb()

import { currentEngine } from './engine.js'
import { validateBusyTimeout } from './pragmas.js'
import { resolve, join, dirname, mkdirSync, AsyncLocalStorage } from '#host'
import { resolveAnchor } from './db-path.js'
import { parse, parseFile, pointColumns } from './parser.js'
import { modelToTableName, modelToAccessor, updatedAtFields, isStoredField } from './ddl.js'
import { buildSealMap } from './seal.js'
import { buildValueSetMap, enforceValueSets } from './valuesets.js'
import { buildEdgeMap, arcCheckExpr, arcDefaultMessage, columnMapFor, mapExprCols } from './ddl.js'
import {
  buildWhere, buildOrderBy, buildRelationOrderBy, buildWindowCols, rawClause, isNamedAgg,
  buildNamedAggExpr, extractNamedAggs, parseSelectArg, trimAllToSelect, vectorOrderPlan,
  orderByAfterVector, vectorQueryBytes, deserializeRow, serializeRow, coerceBooleans,
  serializeBooleans, encodeCursor, decodeCursor, normalizeOrderBy, buildCursorWhere,
  extractCursorValues, cursorOrderSql, filterableKeysFor, sortableKeysFor,
  aggregatableKeysFor,
} from './query.js'
import { scoreByDistance, DISTANCE_FIELD } from './vector.js'
import { validate, applyTransforms, hasTransforms, transformValue, buildValidationMap, validateJsonPatch, ValidationError } from './validate.js'
import { createCardinalityLedger, refuseChildlessCreate } from './cardinality.js'
import { createExclusionLedger } from './exclusion.js'
import { PluginRunner, AccessDeniedError } from './plugin.js'
import { GatePlugin, FrontierGateGetLevel, levelPasses, GATE_LIFT, liftsGate } from '../plugins/gate.js'
import { CapabilityPlugin, requireCapability, requireGrantSubset } from '../plugins/capability.js'
import { capabilityDeclarations, capabilityNames } from './capabilities.js'
import {
  buildPolicyMap, buildScopeMap, compileScope, compileStatic, policyExprToString,
  buildPolicyFilter, checkCreatePolicy, checkPostUpdatePolicy, policyVerdict, evalJs,
  compileFieldPredicate, delegationProblems, buildClaimSet, checkFieldPolicies,
  authClaimsUsed,
} from './policy.js'
import {
  encryptField, decryptField, encryptDeterministic, hashField, normalizeKey,
  comparisonEncoderFor, parseEnvelope, verifiesAs, makeKeyring, legacyForm,
} from './encryption.js'
import { backupSqliteTo } from './backup.js'
import { resolveTenancy } from './tenancy.js'
import { makeJsonlTable } from '../drivers/jsonl.js'
import { isServerAssignedId, isServerFilled } from './ids.js'
import { runSqliteRetention, compactJsonl } from '../tools/retention.js'
import { ensureEventsTable, makeEventRecorder, createEventWatcher } from './cross-process.js'
import {
  TransitionViolationError, TransitionConflictError, VersionRequiredError,
  VersionConflictError, SyncConflictError, TransitionGateError, TransitionSystemError,
  TransitionNotFoundError, BulkTransitionError, SoftDeletedUniqueError, SealedDocumentError,
  UniqueConflictError, uniqueConflictColumns, checkViolationExpr, isCheckViolation,
  isUniqueConflict, ForeignKeyError, isForeignKeyFailure, CapabilityNotDeclaredError, LockNotAcquiredError,
  LockReleasedByOtherError, LockExpiredError,
} from './errors.js'
import { threeWay } from './three-way.js'
import { buildCommitmentMap, dueSql, readBy } from './commitment.js'
import { dueAt, offsetSpans, partsIn, plainDateIn } from '@frontierjs/toolbelt/datetime'
import {
  buildAutoIdMap, buildGeneratedDefaultMap, buildAuthDefaultMap, buildLiteralDefaultMap, buildSelfRelationMap,
  buildFieldRefDefaultMap, buildUpdatedByMap, buildVersionMap, buildCreatedByMap, buildSyncMap,
  buildSequenceMap, schemaDeclaresAccessRules, buildFieldPolicyMap, buildSecretMap,
  buildJsonMap, buildGeneratedMap, buildFromMap, buildCardinalityMap, buildExclusionMap, buildComputedSet, buildBoolMap, buildBigMap,
  buildAffinityMap,
  buildFilterKindMap, buildTransitionMap, buildEnumMap, buildSoftDeleteCascadeMap,
  getCascadeTargets, buildRelationMap, buildFieldReadMap, buildGuardedMap,
  buildSoftDeleteMap, buildHasTemplatesMap, buildEffectiveMap, buildCoFkMap, buildFtsMap, nowISO,
} from './schema-maps.js'
import {
  wideDb, mappedDb, rawHandle, resolveAccessConfig, buildDbRegistry, buildModelDbMap,
  jsonlFilePath,
} from './databases.js'
import {
  applyGeneratedDefaults, noteStamp, stampFromAuth, applyAuthDefaults, ensureSequenceTable,
  applySequences,
} from './stamps.js'
import {
  suggestKey, enumOptions, pointFieldsOf, liftNearOrders, sortHopFor, globalFilterKeysFor,
  globalFilterRefusal, _guardedNames, _shownSet, collectWhereKeyProblems,
  collectOrderByKeyProblems, collectAggKeyProblems, VIEW_REFUSED, withArgValidation,
} from './args.js'
import { loadComputedFields, normalizeComputed, applyComputed } from './computed.js'
import { makeTxManager, makeReadRouter } from './transaction.js'
import { applyFieldPolicyTo } from './field-policy.js'
import { fromSelectExpr, resolveFromRowRefs, coerceEdgeValue, resolveIncludes } from './include.js'
import { gatedFromFields } from './from-gate.js'
import { refuseUntrustedSchema } from './untrusted.js'
import {
  checkAnnounce, emitQuery, queryTapped, buildHookRunner, installHooks, buildEventEmitter,
} from './hooks.js'
import { makeLoggerAutoModel, buildLogMap, buildLogEntry, fireLog } from './audit-log.js'
// buildRelationMap is part of this module's published surface — junction and the
// tools import it from here.
export { buildRelationMap } from './schema-maps.js'
export { ValidationError } from './validate.js'
// Re-exported wholesale rather than by name so a class added to errors.js cannot
// be missing here — this path is what 76 call sites import them from.
export * from './errors.js'

// ─── ownKeys ──────────────────────────────────────────────────────────────────
// Every client proxy answers ownKeys by concatenating the target's real keys
// with the tables, the views and a hand-written list of `$` accessors — and a
// proxy whose ownKeys returns the same name twice makes the ENGINE throw:
//
//   TypeError: Proxy handler's 'ownKeys' trap result must not contain
//              any duplicate names
//
// `$setAuth` and `$db` were on the target AND in the literal list, so
// Object.keys(db), Object.getOwnPropertyNames(db), {...db}, `for…in` and
// JSON.stringify(db) all threw on the top-level client. Two strings, and the
// symptom named proxy internals rather than either of them — Junction ended up
// wrapping its own Object.keys(db) in a try/catch to stop the noise replacing a
// "model not found" diagnostic (`FJS-014`).
//
// Route every trap through this rather than fixing the two names: the literal
// lists have grown before, and the next property added to a target would
// reintroduce the same failure with no test able to predict which one.
const dedupeKeys = (...groups) => [...new Set(groups.flat())]

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

// checkTransitions' answer for a row outside the caller's read scope — distinct
// from null, which means *no move applies* and lets the write go on.
const NOT_VISIBLE      = Symbol('not-visible')

// The operators a Json column takes on its WHOLE value. A `where` on an
// extensible column carrying one of these is comparing the document, not
// reaching into it.
const JSON_WHOLE_OPS = new Set(['equals', 'not', 'in', 'notIn', 'isNull', 'isNotNull'])

// ─── The flavor of client a call is running as ────────────────────────────
//
// A table object is built from a ~5,900-line closure and every table a request
// touches used to be rebuilt, because `$setAuth(user)` cannot reuse one: the
// principal differs per request, so `makeTable` ran again for each flavor
// (`FJS-722`). Measured on the 188-model fixture, a request touching five
// models paid 261 µs doing it, and a fully materialized scoped client held
// 3.6 MB — which under `strategy database` is per tenant.
//
// What made it fixable is what the build actually READS. Inside `makeTable`,
// every reference to the four keys a flavor decides — `auth`, `isSystem`,
// `scopedBy`, `tables` — is inside a method body; not one is read while the
// object is being constructed. Everything read at build time is schema-derived
// and identical for every flavor. So the object being rebuilt never depended on
// the thing that forced the rebuild.
//
// The table is therefore built ONCE against a ctx whose four flavor keys are
// getters over this store, and a flavor is a store rather than a context. No
// method body changed: they still write `ctx.auth`.
//
// **A read outside a flavor scope THROWS** (`FJS-D200`'s answer, one realm
// down). The alternative was to fall back to the unscoped root, which would let
// a floating promise or a `setTimeout` escaping its call run as nobody, with a
// 200 and no row — `FJS-687`'s failure with the loud half removed. Every path
// that reaches a table enters a scope, the root client's own included, so the
// refusal fires only for a read that genuinely outlived its call.
const _flavor = new AsyncLocalStorage()

const FLAVOR_REFUSAL = (key) =>
  `[Litestone] '${key}' was read outside a call. A table is shared across every ` +
  `flavor of client and reads the caller from the call in progress, so this is ` +
  `what a floating promise, a setTimeout or an un-awaited effect escaping its ` +
  `call looks like — the async context is gone and there is no principal to ` +
  `answer with.\n` +
  `Capture what you need before the call returns, or run the work through the ` +
  `client you meant: db.$setAuth(user), db.asSystem(), db.$scopedBy({...}).`

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

// ─── @@expires / @@effective WHERE injection ──────────────────────────────────
// The window. Third of the three exclusions and the only one whose edge is a
// VALUE rather than a column being null or false — which is why `asOf` exists
// at all: `expiresAt > now` is the one-sided case of
// `from <= asOf AND (to IS NULL OR to > asOf)`, so a boolean-only spelling
// would have been a flag where a value belongs. One predicate for both words;
// whether a read that states nothing reaches it is `effMode`'s question.
//
// The interval is half-open — `[from, to)` — which is the interval this repo
// already reads a billing and a pay period by (`FJS-D143`), so a row opening on
// the instant another closes belongs to exactly one of them.
//
// A nullable `to` means *still in force*, and a nullable `from` means *always
// has been*. Both are expressed as an OR against NULL rather than a COALESCE,
// because an index on the column is usable by the first and not by the second.

function injectEffectiveFilter(where, mode, cols, asOf) {
  // mode: 'inForce' (default) | 'withExpired' | 'onlyExpired'
  if (mode === 'withExpired') return where

  const { from, to } = cols
  const started = from ? { OR: [{ [from]: null }, { [from]: { lte: asOf } }] } : null
  const ended   = to   ? { OR: [{ [to]:   null }, { [to]:   { gt:  asOf } }] } : null

  let filter
  if (mode === 'onlyExpired') {
    // The complement, and it is a complement rather than a second predicate:
    // NOT in force is *not started yet* OR *already over*. Spelling it as
    // `to <= asOf` alone would silently drop every row whose window has not
    // opened, which on a two-sided declaration is most of what a caller asking
    // for the excluded rows is looking for.
    const notStarted = from ? { [from]: { gt:  asOf } } : null
    const over       = to   ? { [to]:   { lte: asOf } } : null
    const parts = [notStarted, over].filter(Boolean)
    filter = parts.length === 1 ? parts[0] : { OR: parts }
  } else {
    const parts = [started, ended].filter(Boolean)
    filter = parts.length === 1 ? parts[0] : { AND: parts }
  }

  if (!where) return filter
  return { AND: [filter, where] }
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


// ─── rows changed ─────────────────────────────────────────────────────────────
// bun:sqlite's `.changes` is a total-changes delta, so it counts what TRIGGERS
// and FOREIGN KEY actions wrote as well as the rows the statement named: one
// updated row on an `@@fts` model reported 17, and the ordinary `updatedAt`
// trigger doubles every count on every model that carries the column. SQL
// `changes()` is sqlite3_changes(), which counts only rows the statement itself
// addressed. Read it off the SAME connection with no write in between — every
// caller here is straight-line and has no await between the two.
function rowsChanged(db) {
  return db.query('SELECT changes() AS n').get()?.n ?? 0
}

// The row as the auth stamps will leave it, for a create policy to grade on
// the batch paths, which stamp later inside the transaction. Graded bare,
// `ownerId @default(auth().id)` under `ownerId == auth().id` refuses every
// create omitting the column (FJS-1402); a stamp fills only an absent key, so
// what the caller sent is still graded as sent.
function authStamped(row, modelName, ctx) {
  return stampFromAuth(applyAuthDefaults(row, ctx.authDefaultMap?.[modelName], ctx.auth), ctx.createdByMap?.[modelName], ctx.auth)
}

// The three arguments are three different lifetimes, and that is the whole of
// why they are separate. `readDb`/`writeDb` are the CONNECTION. `shape` is what
// the SCHEMA says about this one model — derived once at client build, identical
// for every caller. `ctx` is the FLAVOR: the principal, the scope stack, the
// system flag, and the maps that read them. This function runs once per model
// per flavor, so a client over 45 models builds it 180 times.
//
// `shape` used to be thirteen positional arguments. The view call site passed
// blanks for the ones it has no answer to (`new Set(), new Set(), false, null,
// …`), so inserting a parameter in the middle shifted every argument after it
// past that call with nothing to say so.
function makeTable(readDb, writeDb, shape, ctx) {
  const {
    tableName,                       // SQL table name ("user" — used in FROM/INTO clauses)
    modelName,                       // Model name as declared ("User" — used to look up per-model maps)
    jsonFields        = new Set(),
    generatedFields   = new Set(),
    computedFields    = new Set(),
    softDelete        = false,
    ftsFields         = null,
    boolFields        = new Set(),
    enumFields        = {},
    fieldKinds        = new Map(),
    softDeleteCascade = false,
    fieldPolicy       = {},
    fromFields        = {},
    bigFields         = new Set(),
    columnMap         = {},
  } = shape

  // Both halves of `@big`, decided once. The statement wrapper is what makes
  // every `SELECT *` and `RETURNING *` below answer exact values; `narrowRow` in
  // read/readAll is what puts the rest back.
  const _hasBig = bigFields.size > 0
  if (_hasBig) { readDb = wideDb(readDb, bigFields); writeDb = wideDb(writeDb, bigFields) }

  // ── @map ──────────────────────────────────────────────────────────────────
  //
  // A field's name and its column are two different strings on a model that
  // declares `@map`, and everything above this line speaks the field's. `col()`
  // is the one translation and it is applied where an identifier is written
  // INTO SQL — never to a row, a payload key or a message, all of which are the
  // caller's vocabulary.
  //
  // The read direction is the statement's, for the reason `wideDb` gives one
  // paragraph up: `SELECT *` and `RETURNING *` answer storage keys, and the
  // sites that see a row are an enumeration nobody can keep in step. A miss on
  // the write side is `no such column` and stops; a miss on the read side is a
  // key nothing reads, which is silent.
  const _mapped = Object.keys(columnMap).length > 0
  const col = _mapped ? (name) => columnMap[name] ?? name : (name) => name
  if (_mapped) { readDb = mappedDb(readDb, columnMap); writeDb = mappedDb(writeDb, columnMap) }

  // The other direction, for the two answers that arrive from SQLITE naming a
  // column: a unique conflict and a CHECK violation. Both become a sentence a
  // caller reads and both are then used to look values up in the caller's own
  // payload, so a column name reaching either is wrong twice over.
  const _fieldOf = (() => {
    if (!_mapped) return (c) => c
    const back = {}
    for (const f in columnMap) back[columnMap[f]] = f
    return (c) => back[c] ?? c
  })()
  const { relationMap, computedSets, computedFns, tx, emitter, globalFilters } = ctx
  const plugins = ctx.plugins   // PluginRunner
  const hasFieldPolicy = Object.keys(fieldPolicy).length > 0
  const _hasEnumFields = Object.keys(enumFields).length > 0

  // A @derived field is an EXPRESSION, not a column, so anywhere a bare
  // `"name"` would be emitted it has to be substituted instead — otherwise
  // SQLite reads the quoted identifier as a string constant and the aggregate
  // answers the field's own NAME, which is FJS-202 arriving through a new field
  // kind. The read pipeline gets this from `_fromExprMap`; aggregate and groupBy
  // build their own SELECTs and ask here.
  const _derivedSql = (name) => (fromFields[name]?.derived ? fromFields[name].subquerySql : null)
  const _aggCol     = (name) => _derivedSql(name) ?? `"${col(name)}"`

  // ── a UNIQUE conflict, said in the caller's own words ───────────────────────
  //
  // Only ever runs on the failing path, so the happy path pays nothing. Two
  // questions in order, because the answers are different actions.
  //
  // A DELETED row holding the value is asked first, with one extra SELECT
  // against the deleted rows alone: a soft-deleted row keeps its @unique values
  // and the way out is restore-or-release, which nothing in SQLite's message
  // hints at (FJS-204).
  //
  // Otherwise a live row holds it, which is the ordinary case — and it used to
  // be the one path with no answer at all, escaping as SQLite's own sentence
  // inside a 500 (FJS-441).
  //
  // Every write path that can hit the constraint routes through here, because
  // they gave four different answers to one question — two of them silently
  // (FJS-276).
  function asUniqueConflict(err, data) {
    if (!isUniqueConflict(err) || err instanceof UniqueConflictError) return err
    const cols = uniqueConflictColumns(err)?.map(_fieldOf)
    if (!cols?.length) return err
    const rows = Array.isArray(data) ? data : [data]
    if (softDelete) {
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        if (cols.some(c => row[c] === undefined)) continue
        const where = {}
        for (const c of cols) where[c] = row[c]
        let hit = null
        try { hit = readDb.query(
          `SELECT * FROM "${tableName}" WHERE ${cols.map(c => `"${col(c)}" = ?`).join(' AND ')} AND "${col('deletedAt')}" IS NOT NULL LIMIT 1`
        ).get(...cols.map(c => row[c] ?? null)) } catch { return err }
        if (!hit) continue
        const idField = ctx.models[modelName]?.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
        return new SoftDeletedUniqueError(modelName, cols, cols.map(c => redactValue(c, row[c])), hit[idField], idField)
      }
    }
    // A live row holds the value, which is the ordinary case and the one that
    // used to escape as a 500 carrying `product_variant.sku`.
    const named = rows.find(r => r && typeof r === 'object' && cols.some(c => r[c] !== undefined))
    return new UniqueConflictError(
      modelName, cols,
      cols.map(c => (named?.[c] === undefined ? undefined : redactValue(c, named[c]))))
  }

  // A CHECK the row did not satisfy.
  //
  // It used to escape as SQLite's own sentence inside a 500 — the server saying
  // it broke about a request it understood perfectly, and a validation problem
  // at that. `@@unique` has had the translated answer since `FJS-441`; `@check`
  // is the same class and had never been given one (`FJS-534`).
  //
  // It becomes a `ValidationError` rather than a class of its own, because the
  // way out is the way out of every other validation failure: send a different
  // value. Two errors exist where two RECOVERIES exist — restore-or-release
  // against send-another-value is why `SoftDeletedUniqueError` is separate from
  // `UniqueConflictError` — and there is only one here.
  //
  // **The expression is for the developer and never for the person.** It goes on
  // `err.constraint` and into the summary message, and it stays out of the
  // per-field `errors[]` a form renders: `qty > 0` under a control is SQL
  // reaching somebody who did not write it. An author who wants a sentence
  // there writes one — `@check("qty > 0", "must be at least one")`.
  function asCheckViolation(err) {
    if (!isCheckViolation(err) || err instanceof ValidationError) return err
    const expr = checkViolationExpr(err)
    if (!expr) return err

    const model = ctx.models[modelName]
    const norm  = (e) => String(e ?? '').replace(/\s+/g, ' ').trim()
    const want  = norm(expr)
    // SQLite reports the text the EMITTER wrote, which is in column space on a
    // mapped model, and every `expr` compared against it here is the author's
    // and names fields. Run through the same translation the emitter used, or
    // no declaration matches and every violation falls through to the generic
    // sentence these branches exist to replace.
    const asWritten = (e) => norm(mapExprCols(e, columnMap))

    // A field's own check names the column, so the message lands on the box.
    const field = model?.fields?.find(f =>
      f.attributes?.some(a => a.kind === 'check' && asWritten(a.expr) === want))
    if (field) {
      const declared = field.attributes.find(a => a.kind === 'check' && asWritten(a.expr) === want)
      const out = new ValidationError([
        { path: [field.name], message: declared?.message ?? 'is not valid' },
      ])
      out.model      = modelName
      out.constraint = expr
      return out
    }

    // `@required(where: …)` is the same technique as the arc below — rebuild
    // what the emitter wrote and compare — and it is the branch that makes the
    // declaration worth having over a hand-written `@@check`. SQLite reports a
    // violation by the constraint's SOURCE TEXT and has no field to blame, so
    // without this the refusal is the generic form-level sentence: correct, and
    // no use to somebody looking at five boxes wondering which one it means.
    //
    // The message and the path both come from `requiredFailure`, which is the
    // one owner of *why this field cannot be left without a value* — so a
    // conditional required says the same sentence as an unconditional one, and
    // `@required(where: …, "…")`'s wording is picked up for free by the same
    // lookup that reads `@required("…")`.
    const condReq = model?.fields?.find(f => {
      const req = f.attributes?.find(a => a.kind === 'required' && a.whereSql)
      if (!req) return false
      return norm(`NOT (${mapExprCols(req.whereSql, columnMap)}) OR "${col(f.name)}" IS NOT NULL`) === want
    })
    if (condReq) {
      const out = new ValidationError([requiredFailure(condReq)])
      out.model      = modelName
      out.constraint = expr
      return out
    }

    // An @@arc compiles to a CHECK with no `expr` of its own, so it is found by
    // rebuilding the SQL the emitter wrote. Without this branch every arc
    // violation falls through to the generic sentence below, which is the
    // failure `FJS-534` describes one attribute earlier.
    const arc = model?.attributes?.find(a =>
      a.kind === 'arc' && norm(arcCheckExpr(a, columnMap)) === want)
    if (arc) {
      const out = new ValidationError([
        { path: [], message: arc.message ?? arcDefaultMessage(arc) },
      ])
      out.model      = modelName
      out.constraint = expr
      return out
    }

    // A model-level one spans columns by definition, so there is no single box
    // to mark and the empty path is the form-level answer — the shape
    // `VersionConflictError` already takes for a refusal about a whole record.
    const declared = model?.attributes?.find(a => a.kind === 'check' && asWritten(a.expr) === want)
    const out = new ValidationError([
      { path: [], message: declared?.message ?? 'this record is not valid' },
    ])
    out.model      = modelName
    out.constraint = expr
    return out
  }

  // One owner for "SQLite refused this write". Both constraints route through
  // here, because eight call sites each choosing which translator to try is how
  // one of them ends up trying neither.
  function asConstraintError(err, data) {
    if (isCheckViolation(err)) return asCheckViolation(err)
    if (isForeignKeyFailure(err)) return asMissingParent(err, data)
    return asUniqueConflict(err, data)
  }

  // ── a foreign key naming a row that is not there (FJS-1454) ────────────────
  //
  // SQLite names neither the column nor the value, so each declared key the
  // row carries is looked up in its parent until one is missing. Physical
  // names come from the table's own foreign_key_list, so `@map` needs no second
  // spelling. Failing path only.
  function asMissingParent(err, data) {
    if (err instanceof ForeignKeyError) return err
    const row = Array.isArray(data) ? data[0] : data
    try {
      // One entry per column; a composite key shares its `id` across them.
      const keys = new Map()
      for (const fk of writeDb.query(`PRAGMA foreign_key_list("${tableName}")`).all()) {
        if (!keys.has(fk.id)) keys.set(fk.id, [])
        keys.get(fk.id).push(fk)
      }
      for (const cols of keys.values()) {
        const fields = cols.map(c => _fieldOf(c.from))
        const values = fields.map(f => row?.[f])
        if (values.some(v => v == null)) continue
        const hit = readDb.query(
          `SELECT 1 FROM "${cols[0].table}" WHERE ${cols.map(c => `"${c.to}" = ?`).join(' AND ')} LIMIT 1`
        ).get(...values)
        if (hit) continue
        const [relation, rel] = Object.entries(ctx.relationMap?.[modelName] ?? {})
          .find(([, r]) => r.kind === 'belongsTo' && r.foreignKey === fields[0]) ?? []
        return parentRefusal(relation, fields, values, rel?.targetModel ?? cols[0].table)
      }
    } catch { return err }
    return new ForeignKeyError(modelName)
  }

  // The one spelling of *that parent is not there*, for a missing parent and a
  // hidden one alike: a difference between the two answers is the oracle.
  function parentRefusal(relation, fields, values, target) {
    const one = fields.length === 1
    const out = new ForeignKeyError(modelName, {
      relation,
      field:  one ? fields[0] : fields,
      value:  one ? redactValue(fields[0], values[0]) : fields.map((f, i) => redactValue(f, values[i])),
      target,
    })
    Object.defineProperty(out, 'key', { value: { fields, values }, enumerable: false })
    return out
  }

  // An update naming the parent a row already has moves nothing: a form posts
  // the whole row back, and a row that may be edited under a parent its editor
  // cannot read must stay editable. Only a matched row the write would MOVE
  // makes the hidden parent the caller's choice. Inside the write's unit.
  function movesOnto(refusal, whereSql, whereParams) {
    const { fields, values } = refusal.key
    return !!writeDb.query(
      `SELECT 1 FROM "${tableName}" WHERE ${whereSql ? `(${whereSql}) AND ` : ''}` +
      `NOT (${fields.map(f => `"${col(f)}" IS ?`).join(' AND ')}) LIMIT 1`
    ).get(...whereParams, ...values.map(_ecp))
  }

  // ── a foreign key naming a parent the caller cannot read ───────────────────
  //
  // A row the caller cannot read answers as missing, and naming it as a parent
  // is a read. SQLite admits the key because the row exists, so Alice could
  // file a Task under Bob's Project — one `findUnique` told her is not there —
  // and the difference between that success and Project 999's refusal told her
  // which ids are real. Asked of the parent table's own `exists()` under the
  // caller, so the gate, the read filters, soft delete and the read policy are
  // the definition every read already uses. asSystem() is the blind reference,
  // and a key the engine stamped is its statement rather than the caller's.
  const _parentKeys = (ctx.models[modelName]?.fields ?? []).flatMap(f => {
    if (f.type?.kind !== 'relation') return []
    const a = f.attributes.find(x => x.kind === 'relation' && x.fields)
    return a ? [{ relation: f.name, target: f.type.name, fields: [a.fields].flat(), references: [a.references].flat() }] : []
  })

  async function canRead(tbl, where) {
    try { return await tbl.exists({ where }) }
    catch (e) { if (e instanceof AccessDeniedError) return false; throw e }
  }

  // Graded before the write and THROWN where SQLite's own refusal of a missing
  // parent would land — after validation, at the row's place in a batch — so
  // the two answers differ in nothing, order included. Only a parent that
  // EXISTS and is hidden is refused here: a missing one is SQLite's to refuse,
  // and it may be a row this same call is writing — an earlier row of the
  // batch, or the row itself.
  //
  // `stamped` is per row, as writeData's is: one row's stamp must not excuse
  // another row's caller-named key.
  async function hiddenParents(rows, stamped = []) {
    const out = []
    if (ctx.isSystem || !_parentKeys.length) return out
    for (const p of _parentKeys) {
      const tbl  = ctx.tables?.[modelToAccessor(p.target)]
      const sink = ctx.cascadeSinkFor?.(p.target)
      if (!tbl || !sink) continue
      const verdict = new Map()
      for (const [i, row] of rows.entries()) {
        if (out[i] || !row || typeof row !== 'object' || !p.fields.every(f => f in row)) continue
        if (p.fields.every(f => stamped[i]?.has(f))) continue
        const values = p.fields.map(f => row[f])
        if (values.some(v => v == null || typeof v === 'object')) continue
        const key = JSON.stringify(values)
        if (!verdict.has(key)) verdict.set(key,
          await canRead(tbl, Object.fromEntries(p.references.map((r, j) => [r, values[j]]))) ||
          !sink.rowsWhere(p.references[0], [values[0]]).some(r => p.references.every((f, j) => r[f] == values[j])))
        if (!verdict.get(key)) out[i] = parentRefusal(p.relation, p.fields, values, p.target)
      }
    }
    return out
  }

  // checkCreatePolicy, with one answer for a parent the create names. Under row
  // tenancy a child scoped through its parent is denied when that parent is not
  // in the caller's tenant, which a missing row and another tenant's both are,
  // and a private one in the caller's own tenant is not. RETURNS that refusal,
  // for the caller to throw where hiddenParents' lands: thrown here, before
  // validation and ahead of earlier rows of a batch, a payload that also fails
  // validation told a missing parent from a hidden one (FJS-1704).
  function checkCreate(row) {
    const v = checkCreatePolicy(modelName, row, ctx, ctx.policyMap, ctx.schema, ctx.relationMap)
    if (!v) return
    const p = _parentKeys.find(k => k.relation === v.parent)
    if (!p) throw new AccessDeniedError(v.message, { model: modelName, operation: 'create' })
    return parentRefusal(p.relation, p.fields, p.fields.map(f => row?.[f]), p.target)
  }

  // Two parent refusals for one row answer as the relation hiddenParents would
  // have met first, whichever of the two found it.
  function firstRefusal(a, b) {
    if (!a || !b) return a ?? b
    const at = r => _parentKeys.findIndex(k => k.relation === r.relation)
    return at(b) < at(a) ? b : a
  }

  // ── a delete a child still refers to (FJS-1454) ────────────────────────────
  //
  // The refusing child may sit under a cascade, so the walk follows every
  // Cascade relation from `rows` and stops at the first child whose relation
  // does not let go of its parent. Run after the refused DELETE rolled back.
  //
  // The walk is a system lookup, so every blocker is kept and
  // `nameBlockerForCaller` picks the one this caller may be told about.
  function asRestrictedDelete(err, rows) {
    if (!isForeignKeyFailure(err) || err instanceof ForeignKeyError) return err
    try {
      let frontier = [[modelName, rows]]
      const seen = new Set()
      const blockers = []
      while (frontier.length) {
        const next = []
        for (const [parent, parentRows] of frontier) {
          for (const rel of Object.values(ctx.relationMap?.[parent] ?? {})) {
            if (rel.kind !== 'hasMany' || rel.onDelete === 'SetNull' || rel.onDelete === 'SetDefault') continue
            const sink = ctx.cascadeSinkFor?.(rel.targetModel)
            if (!sink) continue
            const keys = [...new Set(parentRows.map(r => r[rel.referencedKey]).filter(v => v != null))]
            if (!keys.length) continue
            const found = sink.rowsWhere(rel.foreignKey, keys)
              .filter(r => !seen.has(`${rel.targetModel}\0${r[sink.idField]}`))
            if (!found.length) continue
            if (rel.onDelete !== 'Cascade') {
              blockers.push({ model: rel.targetModel, idField: sink.idField, ids: found.map(r => r[sink.idField]) })
              continue
            }
            for (const r of found) seen.add(`${rel.targetModel}\0${r[sink.idField]}`)
            next.push([rel.targetModel, found])
          }
        }
        frontier = next
      }
      if (blockers.length) {
        const out = new ForeignKeyError(modelName, { child: { model: blockers[0].model, id: blockers[0].ids[0] } })
        Object.defineProperty(out, 'blockers', { value: blockers, enumerable: false })
        return out
      }
    } catch { return err }
    return new ForeignKeyError(modelName)
  }

  // The first blocking child the caller can read is named by id; when every
  // one is hidden, only its model is — a model is schema, an id is data. That
  // the delete is refused at all cannot be hidden under Restrict.
  async function nameBlockerForCaller(err) {
    const blockers = err?.blockers
    if (!blockers || ctx.isSystem) return err
    for (const { model, idField, ids } of blockers) {
      const tbl = ctx.tables?.[modelToAccessor(model)]
      if (!tbl) continue
      for (let i = 0; i < ids.length; i += 500) {
        let hit = null
        try { hit = await tbl.findFirst({ where: { [idField]: { in: ids.slice(i, i + 500) } }, select: { [idField]: true } }) }
        catch (e) { if (!(e instanceof AccessDeniedError)) throw e }
        if (hit) return new ForeignKeyError(modelName, { child: { model, id: hit[idField] } })
      }
    }
    return new ForeignKeyError(modelName, { child: { model: blockers[0].model } })
  }

  // ── which row of a batch ────────────────────────────────────────────────────
  //
  // A batch write throws SQLite's own message, which names the COLUMN and never
  // the row: `UNIQUE constraint failed: post.slug` against a 500-row import
  // leaves bisecting the batch by hand as the only way to find the row that did
  // it. The loop knows the index, so the error says it — as `data[i]`, the
  // subscript the caller can go and look at, not a 1-based ordinal (FJS-207).
  //
  // The whole batch is inside one transaction, so nothing landed; saying so is
  // the difference between re-running the import and hunting for partial rows.
  //
  // A unique conflict also names the values that collided, redacted the way the
  // audit trail redacts them — a @unique column may be @encrypted, where the
  // stored value is ciphertext and belongs in an error message even less than a
  // plaintext would.
  //
  // The error is annotated rather than replaced: its class is what carries the
  // status and `retryable` past the boundary, and a batch wrapper would flatten
  // SoftDeletedUniqueError's 409 into an unclassified 500.
  function asBatchRowError(err, index, total, row) {
    if (!err || typeof err !== 'object' || err.batchIndex != null) return err
    err.batchIndex = index
    err.batchSize  = total
    // A translated conflict already names the columns and their values, so
    // repeating them here gives one sentence saying it twice.
    const cols  = err.fields ? null : isUniqueConflict(err) ? uniqueConflictColumns(err)?.map(_fieldOf) : null
    const named = cols?.length && row
      ? ` (${cols.map(c => `${c} = ${JSON.stringify(redactValue(c, row[c] ?? null))}`).join(', ')})`
      : ''
    // Litestone's own errors already open with the model name; repeating it
    // gives `Post: data[1] … Post: a soft-deleted row …`.
    const rest = err.message?.startsWith(`${modelName}: `)
      ? err.message.slice(modelName.length + 2)
      : err.message
    try {
      err.message = `${modelName}: data[${index}] of ${total}${named} failed — nothing in the batch was written. ${rest}`
    } catch { /* a frozen message keeps the properties above */ }
    return err
  }

  // ── what an aggregate may name ──────────────────────────────────────────────
  //
  // `read()` answers "may this caller see this field" per ROW, in
  // applyFieldPolicyTo. aggregate and groupBy build no row: they project the
  // column straight out of SQLite, so the same question has to be asked of the
  // NAME here or it is not asked at all. It was not — `_max` over a @guarded
  // salary answered it, and `_stringAgg` over one answered the whole column
  // joined with commas, which is not an aggregate but a dump (FJS-273).
  //
  // The ladder mirrors applyFieldPolicyTo's, with one addition it cannot have:
  // a field-level @allow('read') is a predicate over a row, and an aggregate has
  // no row to evaluate it against, so it is refused rather than guessed at.
  const _aggKeySets = ctx.models?.[modelName] ? aggregatableKeysFor(ctx.models[modelName]) : null

  function fieldReadRefusal(name) {
    const p = fieldPolicy[name]
    if (!p) return null
    if (p.hashed)                     return `is @hashed — the column holds a one-way digest, so the answer would be about digests ` +
                                             `rather than values. A digest can be matched in a where and never read back, by any caller`
    // Before the system early-return, because this is not an access rule: a
    // vector is float32 packed into a blob, so MAX/MIN order it as opaque text
    // and SUM/AVG read it as 0. asSystem() does not make any of that mean more.
    if (p.vector)                     return `is @vector(${p.vector.dim}) — the column holds packed float32, which aggregates as ` +
                                             `opaque bytes. Similarity is an ordering: orderBy { ${name}: { near: v } }`
    if (ctx.isSystem) return null
    if (p.encrypted)                  return `is @encrypted — a non-system read is stripped, and the stored column is ciphertext`
    if (p.guarded)                    return `is @guarded — a system-context column. Use asSystem() for a read that is not a caller's`
    if (p.omit === 'all')             return `is @omit(all) — excluded from every read`
    if (p.allow?.read?.length)        return `carries a field-level @allow('read', …), which is decided per row — an aggregate has no ` +
                                             `row to decide it against, so it cannot be answered for some rows and not others`
    return null
  }

  // op names the argument in the error path, so a caller sees which one it was.
  // valueRead is false for `by:` and `_count: { distinct }` — they need a real
  // column and nothing more.
  function refuseAggregateKeys(op, names, valueRead = true) {
    const flat = names.filter(n => typeof n === 'string')
    if (_aggKeySets) {
      const problems = collectAggKeyProblems(flat, _aggKeySets, op, valueRead)
      if (problems.length) throw new ValidationError(problems.map(p => ({
        path: [op, p.key], message: p.message.replace('%MODEL%', modelName),
      })))
    }
    if (!hasFieldPolicy) return
    for (const name of flat) {
      const why = fieldReadRefusal(name)
      if (why) throw new ValidationError([{ path: [op, name], message:
        `Cannot ${op} '${name}' on ${modelName} — it ${why}.` }])
    }
  }

  // The field names a named aggregate reads, if any. `count: true` / `'*'`
  // counts rows rather than a column.
  function namedAggFields(specs) {
    const out = []
    for (const spec of specs) {
      if (!spec || typeof spec !== 'object') continue
      for (const fn of ['count', 'sum', 'avg', 'min', 'max']) {
        if (!(fn in spec)) continue
        const v = spec[fn]
        if (typeof v === 'string' && v !== '*') out.push(v)
      }
    }
    return out
  }

  // @@hasTemplates marker column name, or null if this model doesn't opt in.
  // Read paths inject `<field> = false` by default; `withTemplates` /
  // `onlyTemplates` query args opt out / invert the filter.
  // Whether this model declares any @@scope. Checked before walking a where for
  // `$scope`, so a schema with none pays one boolean per read.
  const _hasScopes = Object.keys(ctx.scopeMap?.[modelName] ?? {}).length > 0

  // Fields declaring @trim/@lower/@upper/@slug, or null when none do — the
  // same one-boolean cost for a where on a model without them.
  const transformedOf = (model) => {
    const fields = (ctx.models?.[model]?.fields ?? []).filter(hasTransforms)
    return fields.length ? new Map(fields.map(f => [f.name, f])) : null
  }
  const _transformed = transformedOf(modelName)

  const hasTemplatesField = ctx.hasTemplatesMap?.[modelName] ?? null
  const hasTemplates      = hasTemplatesField !== null

  // The window, or null if this model declares none. `{ from, to, kind, imposed }`
  // — `from` is null on an `@@expires` model, `kind` is 'instant' or 'day'
  // depending on whether the columns are `DateTime` or `String @date`, and
  // `imposed` is which of the two words declared it.
  const effective = ctx.effectiveMap?.[modelName] ?? null

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
  // name → why it cannot be written. Kept separately because these names are
  // absent from _allowedWriteKeys and would otherwise be dropped by the
  // unknown-key strip, which is silent by design — so a caller who set a
  // @generated column learned nothing, on a write that could never land.
  const _virtualWriteKeys = new Map()
  if (_modelForKeys) {
    for (const f of _modelForKeys.fields) {
      const isComputed  = f.attributes?.find(a => a.kind === 'computed')
      const isGenerated = f.attributes?.find(a => a.kind === 'generated' || a.kind === 'funcCall')
      const isDerived   = f.attributes?.find(a => a.kind === 'derived')
      const isTransient = f.attributes?.find(a => a.kind === 'transient')
      const isFrom      = f.attributes?.find(a => a.kind === 'from')
      if (!isComputed && !isGenerated && !isDerived && !isTransient && !isFrom) _allowedWriteKeys.add(f.name)
      else _virtualWriteKeys.set(f.name,
          isComputed  ? `${f.name} is @computed — it is derived in JS on read and is not a column, so it cannot be written`
        : isDerived   ? `${f.name} is @derived — its value comes from its expression over this row, so writing it would be overwritten by the next read`
          // A @from field is a subquery over the TARGET, so a value written here
          // has nowhere to land and the next read answers the aggregate anyway.
          // Seed the target's rows instead.
        : isFrom      ? `${f.name} is @from(${isFrom.target}, ${isFrom.op}) — it is a subquery over ${isFrom.target} evaluated on read, not a column, so it cannot be written. Write the ${isFrom.target} rows it counts instead`
          // The one of these that a CALLER is meant to send. It reached the Data
          // boundary because nothing lifted it off the payload — an app writing
          // through the client directly, or a service that took the value from
          // ctx.transients and passed ctx.data on whole.
        : isTransient ? `${f.name} is @transient — the API accepts it and nothing stores it, so it has no column. Read it from ctx.transients and leave it out of the write`
        :               `${f.name} is @generated — its value comes from its ${isGenerated?.template ? 'template' : 'expression'} and cannot be written`)
    }
  }
  // The write half of @guarded. Precomputed because the set is empty on most
  // models, so the per-write cost is a size test.
  const _guardedWriteKeys = new Set(
    Object.keys(fieldPolicy).filter(name => fieldPolicy[name].guarded)
  )
  // @system — the same lock on the write side and nothing on the read side.
  const _systemWriteKeys = new Set(
    Object.keys(fieldPolicy).filter(name => fieldPolicy[name].system)
  )
  // @immutable — written at create and frozen after, for everybody including
  // asSystem(). Precomputed for the same reason the two above are.
  const _immutableWriteKeys = new Set(
    Object.keys(fieldPolicy).filter(name => fieldPolicy[name].immutable)
  )
  // @capability — the column tier of the grid. Precomputed for the same reason:
  // empty on almost every model, so the per-write cost is a size test.
  const _capabilityWriteKeys = ctx.capabilityMap?.[modelName]?.columns ?? new Set()
  // The columns that HOLD capabilities, as opposed to the ones a capability grades.
  // Typed `Capability[]` — litestone synthesizes that enum from the schema's own
  // surface, so the type carries both the typo refusal and the escalation guard.
  const _grantColumns = new Set(
    (_modelForKeys?.fields ?? []).filter(f => f.type?.name === 'Capability').map(f => f.name))
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
  // A BULK write may not name a transitions field at all (`FJS-671`).
  //
  // `updateMany` matches rows with a WHERE and never reads them, so there is no
  // `from` to grade — which made the state machine, its per-move `@gate`s and
  // its `@system` markings unreachable through one verb. Measured: a level-4
  // caller holding no capability made a `@gate(5)` move, a `@system` move, and
  // a move the schema does not declare, all by asking `updateMany` instead of
  // `update`. `FJS-044` ruled that skip deliberate and the reasoning survives
  // for every OTHER column; what it could not weigh is the capability grid and
  // `access.snapshot.md`, which arrived later and state a move's gate with no
  // per-verb qualification — so the artefact a reviewer reads certified
  // enforcement one verb did not apply. Refusing one KEY is narrower than
  // removing the tool.
  //
  // Refused for `asSystem()` as for everyone: the machine is integrity, not
  // authority, and a system principal lifts only authority (`FJS-D502`). A row
  // put where no move leads goes through `sys.sql`, the bypass that says so.
  //
  const _tableTransitions = ctx.transitionMap?.[modelName] ?? null
  const _tableCapabilities = ctx.capabilityMap?.[modelName] ?? null

  // Which transitions-typed column a bulk payload names, or null. `verb` is
  // carried into the message so the refusal names the call that was made.
  function _bulkTransitionField(data, verb) {
    if (!_tableTransitions || !data) return null
    for (const field of Object.keys(_tableTransitions)) {
      if (!(field in data)) continue
      return field
    }
    return null
  }

  // Where a row may START (`FJS-D470`): the column's @default and nowhere else,
  // for every principal. `create` is the one write with no from-state, so a
  // gated destination named on the way in was reached without the move — a
  // USER(4) created a LeaveRequest `approved`, and nothing on the row said how
  // (`FJS-1257`). A row that belongs further along is created at the entry and
  // walked there by its declared moves.
  function refuseOffEntry(rows) {
    if (!_tableTransitions) return
    for (const [field, spec] of Object.entries(_tableTransitions)) {
      const norm = spec.isBoolean ? (v) => (v == null ? v : !!v) : (v) => v
      // A value the enum does not name is writeData's refusal, which lists the
      // members; answering it here would say where the row starts instead.
      const members = ctx.enumMap?.[modelName]?.[field]?.values
      for (const row of rows) {
        if (row == null || !(field in row) || row[field] == null) continue
        if (members && !members.has(row[field])) continue
        if (norm(row[field]) !== spec.entry)
          throw new TransitionViolationError(modelName, field, null, row[field], [spec.entry])
      }
    }
  }

  // Resolve the caller's gate level for this model. GatePlugin owns the scale and
  // the per-request cache (ctx.levelFor). When a transition declares @gate the
  // plugin is guaranteed present — createClient auto-installs one — so a missing
  // resolver means something is misconfigured, and refusing is the safe read.
  async function transitionLevel() {
    if (typeof ctx.levelFor !== 'function') return 0
    return await ctx.levelFor(modelName, ctx)
  }

  // What this caller could READ of the table, as one WHERE fragment beside the
  // caller's own: the global filter, the plugins' read filters, then the read
  // policy — the composition `exists()` uses, in its bind order. Soft delete and
  // templates are not here because the update's own where already carries them.
  // null when nothing narrows.
  function callerReadScope() {
    const params  = []
    const filters = [resolveGlobalFilter(), ...(plugins?.hasPlugins ? plugins.getReadFilters(modelName, ctx) : [])].filter(Boolean)
    const filterSql = filters.length
      ? buildWhereWithEncryption(filters.length === 1 ? filters[0] : { AND: filters }, params)
      : ''
    const policy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'read', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
    if (policy) params.push(...policy.params)
    const parts = [filterSql, policy?.sql].filter(Boolean)
    return parts.length ? { sql: parts.map(p => `(${p})`).join(' AND '), params } : null
  }

  async function checkTransitions(data, whereParams, whereSql, systemFields = null, requestedMove = null) {
    if (!_tableTransitions) return null

    // Whether this CALLER may make this MOVE — the three refusals that are
    // true whatever the row is doing. One function because two paths reach it:
    // a move matched from (from, to) on an ordinary update, and a move asked
    // for by NAME through transition(). Two copies would be two answers to one
    // question the first time either learned something (Invariant 4).
    const gradeMove = async (fieldName, moveName, move) => {
      // @gate(9) is a move declared for its from-state and made by nobody, the
      // system client included, as a 9 is on @@gate.
      if (move.gate === 9) throw new TransitionGateError(tableName, fieldName, moveName, 9, ctx.isSystem ? 8 : await transitionLevel())

      // Everything below is authority — who may make the move — which is what
      // `asSystem()` lifts. The move itself, its from-state and its
      // compare-and-swap, still holds (`FJS-D502`).
      if (ctx.isSystem) return

      // A transition gate is a floor on top of @@gate's update level, which has
      // already passed to get here: shipping an order and refunding one are not
      // the same authority.
      //
      // levelPasses() and not `level < required`: 8 and 9 are sentinels rather
      // than rungs, so a comparison spelled by hand reads @gate(8) as *7 is
      // nearly enough* on the day a resolver stops clamping.
      if (move.gate != null) {
        const level = await transitionLevel()
        if (!levelPasses(move.gate, level))
          throw new TransitionGateError(tableName, fieldName, moveName, move.gate, level)
      }

      // ── The capability half of the same question ────────────────────────
      // A named move is one of the four things a capability can refer to
      // (`FJS-D139`), and it is graded HERE rather than in the plugin because
      // this is the only place that knows which move a write turned out to be:
      // `transition(id, 'pay')` and an update setting the column are the same
      // move, and both arrive as a payload. ANDed with the gate above it
      // (`FJS-D146`) — the gate is a floor, so both have to pass.
      if (_tableCapabilities?.moves.has(moveName))
        requireCapability(modelName, moveName, ctx)

      // ── @system, the move half ──────────────────────────────────────────
      // The same statement `@system` makes about a column, made about a MOVE:
      // the application decides it and a caller may only ask. The escape is the
      // column mechanism unchanged — name the field on the write — because a
      // move IS a write to that column and there is no reason for two hatches.
      if (move.system) {
        const named = Array.isArray(systemFields) ? systemFields : systemFields ? [systemFields] : []
        if (!named.includes(fieldName))
          throw new TransitionSystemError(tableName, fieldName, moveName)
      }
    }

    // Find the first transitions-typed field in the data being written
    for (const [fieldName, spec] of Object.entries(_tableTransitions)) {
      if (!(fieldName in data)) continue
      let newValue = data[fieldName]
      if (newValue == null) continue

      // Fetch current value — needed to validate from-state — through the
      // caller's READ scope. Every refusal below names the move, its gate or the
      // row's state, so reaching one on a row this caller cannot read tells them
      // the row exists (`FJS-1093`). Outside the scope it is NOT_VISIBLE, and
      // update() answers null before any refusal reader runs, exactly as for a
      // row that is not there — § Rule one in access-control.md.
      const scope = callerReadScope()
      const current = readDb.query(
        `SELECT "${col(fieldName)}" AS "${fieldName}" FROM "${tableName}" WHERE (${whereSql})${scope ? ` AND (${scope.sql})` : ''}`,
      ).get(...whereParams, ...(scope?.params ?? []))
      if (!current) return NOT_VISIBLE
      // The raw column, not a read() row, so a boolean arrives as 1/0; the write
      // payload is coerced the same way and the declaration holds real booleans.
      // Unnormalized, `0 === false` is false so a no-op looked like a move, and
      // `to === 1` matched no transition so every real move looked illegal.
      const norm = spec.isBoolean ? (v) => (v == null ? v : !!v) : (v) => v
      const currentValue = norm(current[fieldName])
      newValue = norm(newValue)
      if (currentValue == null) return null   // null current — no from-state to check

      const transitions = spec.transitions

      // ── A move asked for by NAME ─────────────────────────────────────────
      // `transition(id, 'calculate')` and `update({ data: { status } })` are
      // the same write and they are not the same QUESTION, and until now the
      // difference was lost on the way down: transition() desugars into
      // update(), so all that arrived was a column and a value.
      //
      // It matters at exactly one row state — the one the move was taking it
      // to. Carrying the value a row ALREADY holds is legitimate on an update,
      // because a form round-trips the whole row, so the check returned early
      // and enforced nothing. Asked for by NAME the same state means the
      // opposite: the move did not happen here, somebody else made it, and the
      // caller was told it succeeded (`FJS-611`).
      //
      // The early return took the gate, the capability and `@system` with it,
      // so a move `@gate(5)` and a move `@system` were both makeable by any
      // caller who could update the model, as long as the row was already at
      // the target. Measured: both succeeded.
      const named = requestedMove ? transitions[requestedMove] : null
      if (named) {
        // Graded BEFORE the row's state, and the order is the substance. A
        // gate, a capability and `@system` are statements about the CALLER and
        // the declared move — true whatever the row is doing — so a caller who
        // could never have made this move is told that, rather than being told
        // somebody beat them to it, which is both wrong and a fact about the
        // row they were not owed.
        await gradeMove(fieldName, requestedMove, named)

        if (currentValue === named.to)
          throw new TransitionConflictError(tableName, fieldName, named.from, named.to,
            { actual: currentValue, move: requestedMove })

        if (!named.from.includes(currentValue))
          throw new TransitionViolationError(tableName, fieldName, currentValue, named.to,
            Object.values(transitions).filter(t => t.from.includes(currentValue)).map(t => t.to))

        return { transitionName: requestedMove, field: fieldName, from: currentValue, to: named.to }
      }

      if (currentValue === newValue) return null   // no change — nothing to enforce

      // Find a valid transition: from includes currentValue, to === newValue
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

      // The move is legal — is this caller allowed to make it?
      await gradeMove(fieldName, matchedName, transitions[matchedName])

      return { transitionName: matchedName, field: fieldName, from: currentValue, to: newValue }
    }
    return null
  }

  // ── Seal guards ───────────────────────────────────────────────────────────
  //
  // `@sealed` on a parent's relation, plus a `@seals` move on that parent, says
  // these child rows are part of a document. The check has to read the PARENT's
  // current state, so it is a predicate rather than a payload refusal — the same
  // tier as the transition compare-and-swap above and composed the same way.
  //
  // It is deliberately NOT lifted by asSystem(). A seal is the @immutable tier —
  // a statement about what the row IS — where the gate, the row policies and
  // @guarded are all statements about who is asking.
  const _sealSelf    = ctx.sealMap?.[modelName]?.self    ?? null
  const _sealParents = ctx.sealMap?.[modelName]?.parents ?? []

  // Correlated: every sealed parent of the row being written is still unsealed.
  // Goes in a WHERE, so it works for update and for delete, where the child row
  // is what supplies the foreign key.
  function sealWhereClause(whereSql, whereParams) {
    if (!_sealParents.length) return { sql: whereSql, params: whereParams }
    const parts  = []
    const params = [...whereParams]
    _sealParents.forEach((p, i) => {
      const a = `_seal${i}`
      parts.push(
        `NOT EXISTS (SELECT 1 FROM "${p.parentTable}" "${a}" WHERE "${a}"."${p.referencedKey}" = ` +
        `"${tableName}"."${p.foreignKey}" AND "${a}"."${p.column}" IN (${p.states.map(() => '?').join(', ')}))`)
      params.push(...p.states.map(_ecp))
    })
    const guard = parts.join(' AND ')
    return { sql: whereSql ? `(${whereSql}) AND ${guard}` : guard, params }
  }

  // The create half. There is no child row yet, so the parent is named by the
  // foreign key in the PAYLOAD — and an absent one is no parent to be sealed by,
  // which is what makes an optional relation keep working.
  // The SQL is the same for every row of the model, so it is built once; only
  // the bound foreign key varies. A NULL one matches no parent, which makes
  // NOT EXISTS true — an optional relation has no document to be sealed by, and
  // that falls out rather than being special-cased.
  const _sealInsertSql = _sealParents.length
    ? _sealParents.map(p =>
        `NOT EXISTS (SELECT 1 FROM "${p.parentTable}" WHERE "${p.referencedKey}" = ? AND ` +
        `"${p.column}" IN (${p.states.map(() => '?').join(', ')}))`).join(' AND ')
    : null

  function sealInsertGuard(row) {
    if (!_sealInsertSql) return null
    const params = []
    const named  = []
    for (const p of _sealParents) {
      const fk = row?.[p.foreignKey] ?? null
      params.push(fk, ...p.states.map(_ecp))
      if (fk != null) named.push({ ...p, id: fk })
    }
    return { sql: _sealInsertSql, params, parents: named }
  }

  // Why did that write touch nothing? Asked only on the failure path, and only
  // after everything else has had its say — a caller refused by a policy has to
  // be told THAT, not told the document is sealed.
  function sealRefusal(parents, operation) {
    for (const p of parents ?? []) {
      const row = readDb.query(
        `SELECT "${p.column}" AS s FROM "${p.parentTable}" WHERE "${p.referencedKey}" = ? LIMIT 1`).get(p.id)
      if (row && p.states.some(s => _ecp(s) === row.s))
        return new SealedDocumentError(modelName, {
          parent: p.parentModel, parentId: p.id, state: row.s,
          relation: p.relation, operation, idField: p.referencedKey,
        })
    }
    return null
  }

  // The same question for a write the guard rode in a WHERE: re-run the caller's
  // own criteria WITHOUT the seal conjunct, and if a row comes back the seal is
  // what refused it.
  function sealRefusalFor(whereSql, whereParams, operation) {
    if (!_sealParents.length) return null
    for (const p of _sealParents) {
      // A correlated subquery rather than a JOIN: the caller's own where is
      // unqualified (`"id" = ?`), so a second table in the FROM makes it
      // ambiguous — and on a self-referential @sealed relation it is the SAME
      // table, where no qualification could have helped.
      const ph  = p.states.map(() => '?').join(', ')
      const sql =
        `SELECT "${p.foreignKey}" AS fk, ` +
        `(SELECT "_p"."${p.column}" FROM "${p.parentTable}" "_p" WHERE "_p"."${p.referencedKey}" = "${tableName}"."${p.foreignKey}") AS s ` +
        `FROM "${tableName}" WHERE ${whereSql || '1=1'} AND EXISTS (SELECT 1 FROM "${p.parentTable}" "_q" ` +
        `WHERE "_q"."${p.referencedKey}" = "${tableName}"."${p.foreignKey}" AND "_q"."${p.column}" IN (${ph})) LIMIT 1`
      const row = readDb.query(sql).get(...whereParams, ...p.states.map(_ecp))
      if (row)
        return new SealedDocumentError(modelName, {
          parent: p.parentModel, parentId: row.fk, state: row.s,
          relation: p.relation, operation, idField: p.referencedKey,
        })
    }
    return null
  }

  // The sealing model's OWN columns. `@immutable` on a model that declares a
  // `@seals` move means *frozen at the seal* rather than *frozen at create*, so
  // it stops being answerable from the payload and becomes a state guard like
  // the rest of them.
  //
  // It applies ONLY where the payload names a frozen column. Narrowing every
  // update on the model would refuse `settle: issued -> paid`, which is a move
  // the machine declares out of a state the seal put the row in.
  function sealSelfClause(data, whereSql, whereParams) {
    if (!_sealSelf || !_immutableWriteKeys.size || !data || typeof data !== 'object' || Array.isArray(data))
      return { sql: whereSql, params: whereParams, frozen: [] }
    const frozen = Object.keys(data).filter(k => _immutableWriteKeys.has(k))
    if (!frozen.length) return { sql: whereSql, params: whereParams, frozen: [] }
    return {
      sql:    `(${whereSql}) AND "${_sealSelf.column}" NOT IN (${_sealSelf.states.map(() => '?').join(', ')})`,
      params: [...whereParams, ..._sealSelf.states.map(_ecp)],
      frozen,
    }
  }

  function throwIfSealedSelf(frozen, whereSql, whereParams) {
    if (!frozen?.length) return
    const row = readDb.query(
      `SELECT "${_sealSelf.column}" AS s FROM "${tableName}" WHERE ${whereSql} LIMIT 1`).get(...whereParams)
    if (row && _sealSelf.states.some(v => _ecp(v) === row.s))
      throw new SealedDocumentError(modelName, {
        parent: modelName, parentId: null, state: row.s, operation: 'freeze', fields: frozen,
      })
  }

  function throwIfSealed(whereSql, whereParams, operation) {
    const refusal = sealRefusalFor(whereSql, whereParams, operation)
    if (refusal) throw refusal
  }

  function applyTransitionWhereClause(transitionResult, finalWhereSql, finalWhereParams) {
    if (!transitionResult) return { sql: finalWhereSql, params: finalWhereParams }
    // Add WHERE field = currentValue for optimistic concurrency
    return {
      sql:    `(${finalWhereSql}) AND "${col(transitionResult.field)}" = ?`,
      // _ecp: a boolean state is stored 1/0, and a raw `false` binds as nothing
      // the column ever equals — the swap would match no row and every move on a
      // Boolean machine would report a conflict.
      params: [...finalWhereParams, _ecp(transitionResult.from)],
    }
  }

  // ── Write event emitter ───────────────────────────────────────────────────
  // Two audiences for one event: the config-time `onEvent` listeners, fixed at
  // createClient, and any runtime `$tapEvents` taps. Zero-cost when neither
  // exists — the guard runs before the payload is built, which is what keeps
  // the fast paths below reachable for an app that subscribes to nothing.
  //
  // A tap gets `event` folded INTO the payload rather than as a second
  // argument: a subscriber that must handle every kind (Junction announcing a
  // write it did not make) would otherwise re-derive the name from `operation`,
  // which a transition event does not carry.
  function fireEvent(event, eventCtx) {
    // Recorded BEFORE the local-audience guard, and that is the whole of what
    // makes it cross-process: the subscriber this row is for is in another
    // process, so whether anything here is listening says nothing about whether
    // the announcement is wanted (`FJS-642`).
    recordCrossProcess(event, eventCtx)
    if (!emitter && !ctx._eventListeners.size) return
    // An announcement is a claim that a row is there. Inside this context's own
    // transaction it is not there yet and may never be, so it is held and
    // flushed on COMMIT — one funnel, so every announcement in the package gets
    // this and no call site is asked to remember (`FJS-D170`).
    if (tx.owns()) { tx.queueEvent(() => dispatchEvent(event, eventCtx)); return }
    dispatchEvent(event, eventCtx)
  }

  // The id and never the row (`cross-process.js` says why): writing the row
  // would put the plaintext of every @encrypted and @guarded column into a
  // table beside the ciphertext. A collection-scoped write has no row to name
  // and travels as its count, which is the shape `changed` already has
  // (`FJS-D34`).
  function recordCrossProcess(event, eventCtx) {
    const record = ctx._crossProcess?.recorders?.[ctx.modelDbMap?.[modelName] ?? 'main']
    if (!record) return
    const row = eventCtx.result ?? eventCtx.record ?? null
    record({
      event,
      model:    modelName,
      scope:    eventCtx.scope ?? 'row',
      count:    eventCtx.count ?? 1,
      recordId: eventCtx.scope === 'collection' ? null : row?.[idField] ?? null,
      detail:   event === 'transition'
        ? { transition: eventCtx.transition, field: eventCtx.field, from: eventCtx.from, to: eventCtx.to }
        : null,
    })
  }

  function dispatchEvent(event, eventCtx) {
    if (emitter) emitter.emit(event, eventCtx, ctx)
    if (!ctx._eventListeners.size) return
    const e = { event, ...eventCtx }
    // Deferred and swallowed, exactly like the emitter's own dispatch: a
    // subscriber is an Observer (FJS-D06) and may not fail the write that
    // announced it.
    setImmediate(() => {
      for (const fn of ctx._eventListeners) {
        try { const r = fn(e, ctx); if (r?.catch) r.catch(() => {}) }
        catch (err) { console.warn(`litestone event tap error (${event}):`, err) }
      }
    })
  }

  // `hasAudience` and not `!emitter && !listeners`: a recorded announcement is
  // for a subscriber in ANOTHER process, so the guards that decide whether to
  // build a payload cannot ask only about this one (`FJS-642`). Still zero-cost
  // for an app that declares nothing and subscribes to nothing, which is what
  // these guards are for.
  const hasAudience = () => !!(emitter || ctx._eventListeners.size || ctx._crossProcess)

  function emitTransitionEvent(transitionResult, record) {
    if (!transitionResult || !hasAudience()) return
    fireEvent('transition', {
      // `modelName`, like every other event this client fires. It used to be
      // `tableName`, so a subscriber handling both kinds got `Order` from an
      // update and `order` from the transition that caused it, and any lookup
      // keyed by the model name silently missed one of the two.
      model:      modelName,
      transition: transitionResult.transitionName,
      field:      transitionResult.field,
      from:       transitionResult.from,
      to:         transitionResult.to,
      record,
      // `scope` is on every event or a consumer has to treat its absence as a
      // third case. A transition is always one row's.
      scope:      'row',
      count:      1,
    })
  }

  // ── The two shapes a write announcement can take ──────────────────────────
  // A write that read its row back can say WHICH row changed. A bulk statement
  // answers `{count}` and never builds the rows, so it can only say how many
  // and under what filter — and a consumer holding no row has to re-ask rather
  // than guess. Saying NOTHING is the third option and it is the one that was
  // there: every bulk write and every hard delete was invisible, so a job that
  // `createMany`d a hundred rows left every open tab stale (FJS-307).
  //
  // `scope` is the discriminator and it is stated rather than inferred, because
  // `result: null` is not the same fact on both — a `select: false` write is a
  // ROW write that has no row to hand over.
  //
  // The audience check leads in both, so an app that subscribes to nothing does
  // not pay for the payload it would build.
  // `transition` is set only when THIS write is a named move AND the transition
  // event below is actually going to fire. A consumer announcing one thing per
  // write has no other way to know that a second event is coming for the same
  // row: it would either announce twice, or skip an update whose transition
  // event was suppressed (a SYSTEM write, where the move is deliberately not
  // announced) and announce nothing at all.
  // ── Relation cardinality ───────────────────────────────────────────────────
  //
  // Both ends move a count, so both are noted: writing a PARENT can leave one
  // with no children, and writing a CHILD moves the parent it names. The grade
  // itself is at the outermost commit (`cardinality.js`).
  const _cardNotes = tx.ledger
    && ((ctx.cardinalityMap?.byParent?.[modelName]?.length ?? 0)
      + (ctx.cardinalityMap?.byChild?.[modelName]?.length ?? 0)) > 0
  function noteCardinality(row, before = null) {
    if (!_cardNotes || !row) return
    tx.ledger.noteParent(modelName, row)
    tx.ledger.noteChild(modelName, row, before)
  }
  // A write that names its rows with a WHERE moves parents only the database
  // knows, and only BEFORE the statement runs. Takes the SQL the caller has
  // already built rather than a where object, so the rows noted are exactly the
  // rows written — a second compile of the same filter is a second answer.
  //
  // The columns are aliased back to FIELD names because that is what the ledger
  // reads; under `@map` the two differ and an unaliased row would note
  // `undefined` for every parent, which is silently no parents at all.
  function noteCardinalityBySql(whereSql, params) {
    if (!_cardNotes) return
    const rules = ctx.cardinalityMap?.byChild?.[modelName] ?? []
    if (!rules.length) return
    const pairs = [...new Map(rules.flatMap(r =>
      r.fkColumns.map((c, i) => [c, r.fkFields[i]]))).entries()]
    const sel = pairs.map(([c, f]) => `"${c}" AS "${f}"`).join(', ')
    const sql = `SELECT DISTINCT ${sel} FROM "${tableName}"${whereSql ? ` WHERE ${whereSql}` : ''}`
    for (const row of writeDb.query(sql).all(...params)) tx.ledger.noteChild(modelName, row)
  }

  // ── Exclusion scopes ───────────────────────────────────────────────────────
  //
  // A write that lands a row, or moves its key or its range, notes the key; the
  // grade over every member of the scope is at the outermost commit
  // (`exclusion.js`). A delete is never noted: removing a row cannot make two
  // overlap, and grading the key would refuse a delete for an overlap it did
  // not cause.
  const _exclScopes = tx.exclusions ? (ctx.exclusionMap?.byModel?.[modelName] ?? []) : []
  const _exclNotes  = _exclScopes.length > 0
  const _exclFields = new Set(_exclScopes.flatMap(name =>
    ctx.exclusionMap.scopes[name].members.filter(m => m.model === modelName)
      .flatMap(m => [m.keyField, ...m.range, ...m.whereFields])))
  // Only a write naming the key, an end of the range or a field of `where:`
  // can move a row into another's range; every other update keeps its fast path.
  const exclTouched = (data) => _exclNotes && data != null && Object.keys(data).some(k => _exclFields.has(k))
  function noteExclusion(row) {
    if (_exclNotes && row) tx.exclusions.note(modelName, row)
  }
  // The key a row holds BEFORE an update: a write that leaves the key alone
  // still moves the range under it, and the payload does not name it.
  function noteExclusionBySql(whereSql, params) {
    if (!_exclNotes) return
    const keys = [...new Set(_exclScopes.map(name =>
      ctx.exclusionMap.scopes[name].members.find(m => m.model === modelName)))]
    const sel = [...new Map(keys.map(m => [m.keyColumn, m.keyField])).entries()]
      .map(([c, f]) => `"${c}" AS "${f}"`).join(', ')
    const sql = `SELECT DISTINCT ${sel} FROM "${tableName}"${whereSql ? ` WHERE ${whereSql}` : ''}`
    for (const row of writeDb.query(sql).all(...params)) tx.exclusions.note(modelName, row)
  }

  function fireRowEvent(event, operation, result, transition = null) {
    if (!hasAudience()) return
    fireEvent(event, {
      model: modelName, operation, result, scope: 'row', count: 1,
      ...(transition ? { transition } : {}),
      schema: ctx.models[modelName],
    })
  }

  function fireCollectionEvent(event, operation, where, count) {
    // Nothing matched, so nothing changed. A filter that hit no rows must not
    // send every open tab back to the server.
    if (!count) return
    if (!hasAudience()) return
    fireEvent(event, { model: modelName, operation, result: null, scope: 'collection', count, where, schema: ctx.models[modelName] })
  }

  /**
   * What this bulk call should announce, and whether it has to fetch rows to do
   * it: `{ mode, wantRows }`. Precedence is **option → client → 'collection'**,
   * the same shape `resolveTenancy` uses one realm over.
   *
   * `wantRows` is ANDed with the audience, so an app that opted in and has no
   * subscriber does not pay for the RETURNING it would throw away.
   */
  function announceFor(option) {
    const mode = checkAnnounce(option, `${modelName}`) ?? ctx.announce ?? 'collection'
    return { mode, wantRows: mode === 'rows' && hasAudience() }
  }

  /**
   * Announce a bulk write, given whatever rows the statement returned.
   *
   * One place, because the alternative is the same three-way branch written out
   * at five call sites — which is how one of them ends up announcing a raw row.
   * Rows go through `read()` first: a subscriber must not receive a `@guarded`
   * or `@encrypted` column that every other event path strips.
   */
  function announceBulk({ mode, event, operation, where, count, rows }) {
    if (mode === 'none') return
    if (mode === 'rows' && rows) {
      for (const r of rows) fireRowEvent(event, operation, read(r, { mode: 'single', hydrateFrom: true }))
      return
    }
    fireCollectionEvent(event, operation, where, count)
  }

  // ── Query event emitter ───────────────────────────────────────────────────
  // Zero-cost when no onQuery configured and no $tapQuery listeners active.
  // Fires both the config-time onQuery hook (production logging) and any
  // runtime $tapQuery taps (Studio REPL, testing). Never throws, never blocks.
  const _dbName = ctx.modelDbMap?.[modelName] ?? 'main'
  function fireQuery(event) {
    emitQuery(ctx, tableName, _dbName, event)
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
  // Tables with no @log / @@log get tableHasLogWork = false — the hot path
  // (findMany, create, update, remove, delete) checks this single boolean and
  // exits immediately with zero allocation cost.
  //
  // Design:
  //   tableFieldLogs  — Map<fieldName, [{db, reads, writes}]> for THIS table only
  //   tableModelLogs  — [{db, reads, writes}] for THIS table only, or null
  //   tableHasLogWork  — pre-computed boolean: skip all log work if false
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
  // An @@anonymous table has no log (the parser refuses one) and still takes
  // this path, because its writes are what a logged write in the same
  // transaction is refused against (`FJS-D349`).
  const tableAnonymous   = ctx.models[modelName]?.attributes?.some(a => a.kind === 'anonymous') ?? false
  const tableLogsWrites  = !!tableModelLogs?.some(l => l.writes) || [...tableFieldLogs.values()].some(cs => cs.some(c => c.writes))
  const tableHasLogWork  = tableFieldLogs.size > 0 || (tableModelLogs?.length > 0) || tableAnonymous
  const tableNeedsField  = tableFieldLogs.size > 0
  const tableNeedsModel  = tableModelLogs?.length > 0

  // Pre-resolve log tables at startup so getLogTable() is O(1) on hot paths.
  // Map<dbName, logTable>
  const _logTableCache = new Map()
  function getLogTable(dbName) {
    if (_logTableCache.has(dbName)) return _logTableCache.get(dbName)
    const dbEntry = ctx.loggerDbMap?.[dbName]
    // A SQL trail is an ordinary table and is written through a SYSTEM context:
    // the row is the engine's record of what happened, not something the
    // calling principal is asking to insert, so it must not be graded by the
    // trail model's own `@@gate` — which is exactly the gate an app puts there
    // to make the trail append-only and readable by staff alone.
    const table   = !dbEntry ? null
      : dbEntry.kind === 'sql'
        ? (ctx.sqlLogTableFor?.(dbEntry.logModel) ?? null)
        : (ctx.jsonlTableCache?.[dbEntry.logModel ?? (dbName + 'Logs')] ?? null)
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

  // A logged read whose `select` leaves out the id still has to name its rows:
  // the entry was written with actor and clock and `records: []`, a trail with
  // a hole a reviewer cannot see (FJS-1422). So the STATEMENT selects the id,
  // and `finalize` with the caller's own parse strips it again. `distinct`
  // keeps the caller's projection, since an id would make every row distinct.
  function logReadParse(select, include, ps, distinct) {
    if (!tableHasLogWork || tableAnonymous || !select || select[idField] || distinct === true) return ps
    return parseArgs({ ...select, [idField]: true }, include)
  }

  // Emit a log entry fire-and-forget to a logger database.
  function emitLog(dbName, entry) {
    const table = getLogTable(dbName)
    if (!table) return
    fireLog(table, buildLogEntry(entry, ctx, ctx.onLog), ctx._logStats)
  }

  // ── Audit redaction ─────────────────────────────────────────────────────
  // A protected field's VALUE must never reach a log entry. The audit trail
  // exists to record THAT a field was written — by whom, to which rows, when —
  // not what it holds. Logging the plaintext would defeat the @encrypted it
  // sits next to: the database row is ciphertext while the JSONL beside it is
  // not, and the log file has none of the column's read protections.
  //
  // This matters most for @secret, which expands to
  // @encrypted + @guarded + @log(<first logger db>) — so declaring a
  // logger database is on its own enough to start logging every @secret field.
  // Redaction is what makes that expansion safe.
  //
  // null is preserved rather than redacted: it holds nothing to leak, and
  // keeping it means a null → value transition is still visible in the trail.
  //
  // A @hashed digest is redacted too: it is the value every read path refuses
  // to hand back, and a stable keyed identifier, so a digest in a 409 lets a
  // caller ask whose value matches whose (FJS-1250).
  const REDACTED = '[redacted]'
  const protectedLogFields = new Set(
    Object.keys(fieldPolicy).filter(f => fieldPolicy[f].encrypted || fieldPolicy[f].guarded || fieldPolicy[f].hashed)
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
  function emitLogs(operation, rows, { before: beforeMap, after: afterMap, transition = null, ids: readIds = null, system = null } = {}) {
    const lifted = liftsGate(system) ? [GATE_LIFT] : null
    if (!tableHasLogWork) return          // ← fast exit for unlogged tables
    if (operation !== 'read' && (tableAnonymous || tableLogsWrites) && tx.owns()) {
      const other = tx.noteWrite(modelName, tableAnonymous)
      if (other) {
        const [anon, logged] = tableAnonymous ? [modelName, other] : [other, modelName]
        throw new Error(
          `${modelName}: refused a write in a transaction that also wrote ${other}. ${anon} is @@anonymous and ` +
          `${logged} is logged, and the trail's clock in order re-attributes every ${anon} row. ` +
          `Drop the log on ${logged} — writing the two in separate transactions leaves the same join and only escapes this check (FJS-D349)`)
      }
    }
    if (tableAnonymous) return
    const ids = readIds ?? extractIds(rows)         // extract once, shared below

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
            transition,
            records: ids,
            before:  beforeMap ? redactValue(field, beforeMap[field] ?? null) : null,
            after:   afterMap  ? redactValue(field, afterMap[field]  ?? null) : null,
            lifted,
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
          transition,
          records: ids,
          before:  beforeMap ? redactSnapshot(beforeMap) : null,
          after:   afterMap  ? redactSnapshot(afterMap)  : null,
          lifted,
        })
      }
    }
  }

  // ── What a foreign key's `onDelete: Cascade` takes with a row ─────────────
  // SQLite removes those rows inside the parent's own DELETE, so the plugins
  // and the trail heard of the one row the caller named and nothing under it:
  // deleting a person wrote no `application.delete` line and left every résumé
  // in the file store (FJS-1497). The parent reads the doomed rows in the same
  // exclusive unit as its DELETE, then hands each child table its own.
  ctx.registerCascadeSink?.(modelName, {
    idField,
    hears: !!plugins?.hasPlugins || tableHasLogWork,
    rowsWhere(fk, keys) {
      const out = []
      for (let i = 0; i < keys.length; i += 500) {
        const chunk = keys.slice(i, i + 500)
        out.push(...readDb.query(`SELECT * FROM "${tableName}" WHERE "${col(fk)}" IN (${chunk.map(() => '?').join(',')})`).all(...chunk))
      }
      return readAll(out)
    },
    async removed(rows) {
      if (plugins?.hasPlugins) await plugins.afterDelete(modelName, rows, ctx)
      if (tableHasLogWork) emitLogs('delete', rows)
    },
  })

  // null when no model the cascade can reach has a plugin or a log to tell,
  // which is every app without one, so the walk costs those nothing.
  let _cascadeHeard = null
  function cascadeHeard() {
    if (_cascadeHeard !== null) return _cascadeHeard
    _cascadeHeard = false
    if (!ctx.cascadeSinkFor) return false
    const seen = new Set([modelName])
    const queue = [modelName]
    while (queue.length) {
      for (const rel of Object.values(ctx.relationMap?.[queue.shift()] ?? {})) {
        if (rel.kind !== 'hasMany' || rel.onDelete !== 'Cascade' || seen.has(rel.targetModel)) continue
        seen.add(rel.targetModel)
        queue.push(rel.targetModel)
        if (ctx.cascadeSinkFor(rel.targetModel)?.hears) return (_cascadeHeard = true)
      }
    }
    return false
  }

  // Every row the cascade will remove under `rows`, as [sink, rows] per child
  // model and hop. Run BEFORE the DELETE, inside its exclusive unit.
  function cascadeDoomed(rows) {
    if (!rows?.length || !cascadeHeard()) return null
    const doomed = []
    const seen = new Set()
    let frontier = [[modelName, rows]]
    while (frontier.length) {
      const next = []
      for (const [parent, parentRows] of frontier) {
        for (const rel of Object.values(ctx.relationMap?.[parent] ?? {})) {
          if (rel.kind !== 'hasMany' || rel.onDelete !== 'Cascade') continue
          const sink = ctx.cascadeSinkFor(rel.targetModel)
          if (!sink) continue
          const keys = [...new Set(parentRows.map(r => r[rel.referencedKey]).filter(v => v != null))]
          if (!keys.length) continue
          // A self-relation or a diamond reaches a row twice; SQLite removes it once.
          const found = sink.rowsWhere(rel.foreignKey, keys).filter(r => {
            const k = `${rel.targetModel}\0${r[sink.idField]}`
            if (seen.has(k)) return false
            seen.add(k)
            return true
          })
          if (!found.length) continue
          doomed.push([sink, found])
          next.push([rel.targetModel, found])
        }
      }
      frontier = next
    }
    return doomed.length ? doomed : null
  }

  async function cascadeRemoved(doomed) {
    if (doomed) for (const [sink, rows] of doomed) await sink.removed(rows)
  }

  // ── Field policy helpers ──────────────────────────────────────────────────
  // The rules themselves are applyFieldPolicyTo, at module level — an include
  // has to apply them to a model that is not this one.
  function applyFieldPolicy(row, opts) {
    if (!row || !hasFieldPolicy) return row
    return applyFieldPolicyTo(row, modelName, fieldPolicy, ctx, opts)
  }

  // ── Read helpers ──────────────────────────────────────────────────────────
  // Pre-compute per-table flags for read()
  //
  // The @@extensible mirror is the blob re-keyed by slot: an index's copy,
  // rebuilt from the blob on every write and never read back. A reader has the
  // blob, and one handed the mirror too gets an object under a name its JSON
  // Schema never declared, which a browser then takes for composed data
  // (`FJS-1426`). So no read answers it.
  const _extMirror = (() => {
    const ext = ctx.models[modelName]?.attributes?.find(a => a.kind === 'extensible')
    return ext?.max ? `${ext.column}Slots` : null
  })()
  const _dropMirror = (r) => {
    if (!_extMirror || !r || !(_extMirror in r)) return r
    const { [_extMirror]: _m, ...rest } = r
    return rest
  }
  const _hasJson     = jsonFields.size > 0
  const _hasBool     = boolFields.size > 0
  const _hasComputed = (computedSets[modelName]?.size ?? 0) > 0

  // ── @from deserialization ─────────────────────────────────────────────────
  // last/first return JSON strings from json_object() → parse to object
  // exists returns 0/1 integer → coerce to boolean
  // `hidden` is gatedFromFields' answer for this read: each is read as null.
  function deserializeFromFields(row, hidden = null) {
    const out = { ...row }
    for (const [name] of _fromEntries) {
      if (!(name in out)) continue
      if (hidden?.has(name)) {
        out[name] = null
      } else if (_fromObjectFields.has(name)) {
        out[name] = out[name] != null
          ? (typeof out[name] === 'string' ? JSON.parse(out[name]) : out[name])
          : null
      } else if (_fromBoolFields.has(name)) {
        out[name] = out[name] === 1 || out[name] === true
      }
    }
    return out
  }

  // A write returns its row through RETURNING, which is table columns only —
  // SQLite cannot put a correlated subquery there. So a created or updated row
  // came back with no @from field at all, and since applyComputed runs either
  // way, a @computed field over one answered a plausible 0. The caller then
  // held a row that disagreed with the same row refetched, and junction hands
  // that row straight to the HTTP response AND the `svc updated` broadcast, so
  // every open tab replaced a correct row with a degraded one.
  //
  // One extra SELECT, only for a model that declares @from and only on the
  // write paths that opt in — a read already carries the values, and hydrating
  // whenever a key happened to be missing would fire a query per row for a
  // `select` that legitimately excluded them.
  function hydrateFromFields(row) {
    if (!_hasFrom || !row || row[idField] == null) return row
    const cols = _fromEntries.map(([n, { subquerySql }]) => `${subquerySql} AS "${n}"`).join(', ')
    const vals = readDb
      .query(`SELECT ${cols} FROM "${tableName}" WHERE "${idField}" = ?`)
      .get(row[idField])
    return vals ? { ...row, ...vals } : row
  }

  // Which computed fields this read should run. `selectedFields` is the
  // caller's select and answers it on every path that has one; `computedFields`
  // is for a path that builds its own SELECT and must not also opt into the
  // field-policy meaning of `selectedFields` (findManyCursor, search).
  function computedWanted(opts) {
    return opts.computedFields ?? opts.selectedFields ?? null
  }

  // The JSON-parse and boolean-coerce pass, shared by read/readAll.
  function shapeScalars(r) {
    if (!_hasJson && !_hasBool) return r
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
        if (field in out && out[field] !== null) out[field] = out[field] === 1 || out[field] === true
      }
    }
    return out
  }

  function read(row, opts = {}) {
    if (!row) return null
    if (!_hasJson && !_hasBool && !_hasComputed && !hasFieldPolicy && !_hasFrom) return _dropMirror(row)
    let r = opts.hydrateFrom ? hydrateFromFields(row) : row
    // Row references resolve before applyComputed below, so a @computed field
    // over `row.lastOrder.amount` still sees a row rather than its id.
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
    if (_hasFrom) {
      r = deserializeFromFields(r, gatedFromFields(_tableFrom, ctx))
      if (_hasRowRef) resolveFromRowRefs(readDb, [r], _tableFrom, ctx)
    }
    if (_hasComputed) r = applyComputed(r, modelName, computedFns, ctx, computedWanted(opts))
    if (hasFieldPolicy) r = applyFieldPolicy(r, opts)
    return _dropMirror(r)
  }
  function readAll(rows, opts = {}) {
    // Fast path — no transforms needed, return rows as-is
    if (!_hasJson && !_hasBool && !_hasComputed && !hasFieldPolicy && !_hasFrom) return _extMirror ? rows.map(_dropMirror) : rows
    const wanted = computedWanted(opts)
    const hidden = _hasFrom ? gatedFromFields(_tableFrom, ctx) : null
    // Two passes when a row reference is in play: every row's id is resolved in
    // one query, then the per-row transforms run. One pass would be a query per
    // row, and applyComputed would run before the row it reads exists.
    if (_hasRowRef) {
      const staged = rows.map(r => deserializeFromFields(shapeScalars(r), hidden))
      resolveFromRowRefs(readDb, staged, _tableFrom, ctx)
      return staged.map(r => {
        let out = _hasComputed ? applyComputed(r, modelName, computedFns, ctx, wanted) : r
        if (hasFieldPolicy) out = applyFieldPolicy(out, opts)
        return _dropMirror(out)
      })
    }
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
      if (_hasFrom)      r = deserializeFromFields(r, hidden)
      if (_hasComputed)  r = applyComputed(r, modelName, computedFns, ctx, wanted)
      if (hasFieldPolicy) r = applyFieldPolicy(r, opts)
      return _dropMirror(r)
    })
  }

  // ── Write helper ──────────────────────────────────────────────────────────
  // requireAll: create-shaped writes (create/createMany/upsert-insert) enforce
  // required fields up front; update-shaped writes stay partial.
  // ── atomic update operators ────────────────────────────────────────────────
  //
  // `{ views: { increment: 1 } }` compiles to `SET "views" = "views" + ?` —
  // one statement, no read, and two concurrent callers cannot lose one of the
  // two increments. Read-modify-write in JS can and does, and `@version` only
  // turns that race into a thrown conflict the caller has to retry (FJS-D27).
  //
  // The whole payload is otherwise VALUES, and the objection to operators was
  // that `{ views: { increment: 1 } }` and `{ addr: { city: 'x' } }` are one
  // shape to a parser. They are not one shape to a parser that knows the
  // column, which this one does: an operator is only read as an operator on a
  // column whose DECLARED type can carry it, and everything else is refused by
  // name rather than guessed at.
  //
  // Update only. There is no value to change on a create, and an operator there
  // is a caller who thinks they are updating.
  const NUMERIC_OPS = { increment: '+', decrement: '-', multiply: '*', divide: '/' }
  const ARRAY_OPS   = new Set(['push'])
  const ALL_OPS     = [...Object.keys(NUMERIC_OPS), ...ARRAY_OPS]

  // `$merge` — the document operator, and the one that wears a `$`.
  //
  // The other five are read off a plain key because the COLUMN decides, and a
  // numeric or array column cannot hold an object, so `{ increment: 1 }` there
  // is unambiguous. A Json column CAN, which is why `extractWriteOps` skips it
  // entirely today — and the cost of that skip is that
  // `{ doc: { increment: 1 } }` stores `{"increment":1}` as the document. A
  // document's own key can equally be spelled `merge`, so this one is not a
  // bare word: `$merge` cannot collide with a key, because the same character
  // is already reserved on every other boundary here.
  const MERGE_OP = '$merge'

  // A bound this write can violate and nobody can check: the new value is
  // computed inside SQLite, so `validate()` never sees it. Refused rather than
  // skipped — a validator that silently stops applying is worse than one that
  // says it cannot. `minItems` is not here: push only ever grows the array.
  const _uncheckableWith = (field) => field.attributes
    .filter(a => ['lt', 'lte', 'gt', 'gte', 'maxItems', 'uniqueItems'].includes(a.kind))
    .map(a => `@${a.kind}`)
  const _checkOp = { lt: '<', lte: '<=', gt: '>', gte: '>=' }
  // One expression, since a field carries one `@check`.
  const _checkSpelling = (field, column) => {
    const terms = field.attributes.flatMap(a =>
      _checkOp[a.kind]        ? [`${column} ${_checkOp[a.kind]} ${a.value}`]
      : a.kind === 'maxItems' ? [`json_array_length(${column}) <= ${a.value}`]
      : [])
    return terms.length ? `@check("${terms.join(' AND ')}")` : null
  }

  const _fieldsByName = new Map((ctx.models?.[modelName]?.fields ?? []).map(f => [f.name, f]))
  const NUMERIC_TYPES = new Set(['Int', 'Float', 'BigInt', 'Decimal'])

  function refuseOp(key, msg) { throw new ValidationError([{ path: [key], message: msg }]) }

  // Splits `data` into the values half and the operator half. Returns the
  // original object untouched when there is no operator in it, which is every
  // write but the ones that asked for one.
  function extractWriteOps(data, { where = 'update' } = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { data, ops: [] }

    let plain = null
    const ops = []
    for (const [key, val] of Object.entries(data)) {
      if (val === null || typeof val !== 'object' || Array.isArray(val) || val instanceof Date || ArrayBuffer.isView(val)) continue
      const opKeys = Object.keys(val).filter(k => ALL_OPS.includes(k))
      // ── $merge, ahead of everything ──────────────────────────────────────
      // It has to be read before the ALL_OPS bail (it is not in that list) and
      // before the Json skip below (which is the whole reason it exists).
      if (Object.prototype.hasOwnProperty.call(val, MERGE_OP)) {
        const mf = _fieldsByName.get(key)
        if (!mf) {
          const dot  = key.indexOf('.')
          const head = dot > 0 ? key.slice(0, dot) : null
          const hf   = head && _fieldsByName.get(head)
          if (hf) refuseOp(key, pathWriteRefusal(key, head, hf))
          refuseOp(key, `${key} is not a column on ${modelName}, so "${MERGE_OP}" has nothing to apply to`)
        }
        if (Object.keys(val).length > 1)
          refuseOp(key, `${key} mixes "${MERGE_OP}" with ${Object.keys(val).filter(k => k !== MERGE_OP).map(k => `"${k}"`).join(', ')} — an operator stands alone`)
        if (mf.type.name !== 'Json' || mf.type.array)
          refuseOp(key, `"${MERGE_OP}" merges into a document and ${key} is ${mf.type.name}${mf.type.array ? '[]' : ''}. State the value itself`)
        if (where !== 'update')
          refuseOp(key, `"${MERGE_OP}" merges into a document that is already there, so it belongs on update, not ${where}. State the document itself`)
        // The stored text is ciphertext, so json_patch would merge into base64
        // and produce something that is neither. Same class as push on a
        // non-array: the declared type is what makes the operator safe.
        if (mf.attributes.some(a => a.kind === 'encrypted' || a.kind === 'secret'))
          refuseOp(key, `${key} is @${mf.attributes.some(a => a.kind === 'secret') ? 'secret' : 'encrypted'}, so what is stored is ciphertext and "${MERGE_OP}" would patch that rather than the document. Read it, change it and write it back`)

        const patch = val[MERGE_OP]
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch))
          refuseOp(key, `"${MERGE_OP}" takes an object of the keys to change, got ${patch === null ? 'null' : Array.isArray(patch) ? 'an array' : typeof patch}`)

        // A described column is graded; an undescribed one has no declared
        // shape, so there is no invariant a merge could break and nothing to
        // grade against. The mode is the column's own optionality: json_patch
        // REPLACES a null target rather than merging into it, so a nullable
        // column's patch is a create.
        const typeAttr = mf.attributes.find(a => a.kind === 'type')
        if (typeAttr && ctx.typeMap?.size) {
          const errs = validateJsonPatch(
            patch, typeAttr.name, ctx.typeMap, typeAttr.strict !== false,
            [key], mf.type.optional ? 'create' : 'partial', ctx.enumTypeMap)
          if (errs.length) throw new ValidationError(errs)
        }
        // coalesce because json_patch(NULL, …) answers NULL and raises nothing,
        // which would empty the column rather than fill it.
        ops.push({ col: key, expr: `json_patch(coalesce("${col(key)}", '{}'), ?)`, params: [JSON.stringify(patch)] })
        if (!plain) plain = { ...data }
        delete plain[key]
        continue
      }

      if (!opKeys.length) continue

      const field = _fieldsByName.get(key)
      // A typed-Json column legitimately takes an object, and one of its own
      // sub-keys could be spelled `increment`. The column decides, so this is
      // not reachable for it.
      if (field && field.type.name === 'Json') continue

      if (opKeys.length > 1)
        refuseOp(key, `${key} was given ${opKeys.length} operators (${opKeys.join(', ')}) — one write applies one, and which ran first would decide the answer`)
      if (Object.keys(val).length > 1)
        refuseOp(key, `${key} mixes the operator "${opKeys[0]}" with ${Object.keys(val).filter(k => k !== opKeys[0]).map(k => `"${k}"`).join(', ')} — an operator stands alone`)

      const op      = opKeys[0]
      const operand = val[op]

      if (!field) {
        // A PATH reaches here before writeData does, so the operator branch was
        // answering "settings.tags is not a column" where the value branch
        // answers the path refusal — one mistake, two sentences (FJS-658).
        const dot  = key.indexOf('.')
        const head = dot > 0 ? key.slice(0, dot) : null
        const hf   = head && _fieldsByName.get(head)
        if (hf) refuseOp(key, pathWriteRefusal(key, head, hf))
        refuseOp(key, `${key} is not a column on ${modelName}, so "${op}" has nothing to apply to`)
      }
      if (where !== 'update')
        refuseOp(key, `"${op}" changes a value that is already there, so it belongs on update, not ${where}. State the value itself`)

      const uncheckable = _uncheckableWith(field)
      if (uncheckable.length) {
        // The old advice here was read-modify-write, which loses updates under
        // concurrency — 50 increments that way left a counter at 1 (FJS-1405).
        // A CHECK is the bound SQLite holds while it computes, so name that.
        const check = _checkSpelling(field, col(key))
        refuseOp(key, `${key} carries ${uncheckable.join(' and ')}, and "${op}" computes its new value inside SQLite where no validator can see it. ` +
                      (check
                        ? `State the bound as ${check} instead — SQLite holds a CHECK on every write, this one included, where reading the row and writing it back loses updates to concurrent writers`
                        : `@uniqueItems has no CHECK spelling, since SQLite allows no subquery in one, so write the whole array`))
      }

      if (NUMERIC_OPS[op]) {
        if (field.type.array || !NUMERIC_TYPES.has(field.type.name))
          refuseOp(key, `"${op}" needs a numeric column and ${key} is ${field.type.name}${field.type.array ? '[]' : ''}`)
        if (typeof operand !== 'number' || !Number.isFinite(operand))
          refuseOp(key, `"${op}" takes a finite number, got ${operand === null ? 'null' : typeof operand}`)
        // SQLite answers NULL for x/0, so the column would be quietly emptied.
        if (op === 'divide' && operand === 0)
          refuseOp(key, `divide by zero would set ${key} to NULL — SQLite has no error for it`)
        ops.push({ col: key, expr: `"${col(key)}" ${NUMERIC_OPS[op]} ?`, params: [operand] })
      } else {
        // push. json_insert on a column that is not a JSON ARRAY is a silent
        // no-op (an object) or malformed JSON (a scalar), so the declared type
        // is the only thing that makes this safe.
        if (!field.type.array)
          refuseOp(key, `"push" needs an array column and ${key} is ${field.type.name}`)
        const items = Array.isArray(operand) ? operand : [operand]
        // An enum member is a declaration, not a string — `{ name, comments }`.
        const enumValues = ctx.schema?.enums?.find(e => e.name === field.type.name)
          ?.values.map(v => (typeof v === 'string' ? v : v.name))
        for (const item of items) {
          if (item === null || typeof item === 'object')
            refuseOp(key, `"push" takes values, and ${key} was given ${item === null ? 'null' : 'an object'} — an array column holds scalars`)
          if (enumValues && !enumValues.includes(item))
            refuseOp(key, `"push" was given '${item}', which is not a member of ${field.type.name} (${enumValues.join(', ')})`)
        }
        // An empty push still takes the key off the payload — leaving it there
        // sends `{ push: [] }` to writeData as the column's new VALUE.
        if (items.length) {
          // coalesce because json_insert(NULL, …) answers NULL and raises
          // nothing. Litestone's own DDL emits an array column NOT NULL DEFAULT
          // '[]', so this only bites a column something else created — the
          // guard costs one function call and the failure it prevents is a
          // value dropped with a success reported.
          const slots = items.map(() => `'$[#]', ?`).join(', ')
          ops.push({ col: key, expr: `json_insert(coalesce("${col(key)}", '[]'), ${slots})`, params: items })
        }
      }

      if (!plain) plain = { ...data }
      delete plain[key]
    }

    return { data: plain ?? data, ops }
  }

  // ── @allow('write', …) on a FIELD, compiled into the SET ─────────────────────
  //
  // `FJS-D129`: the predicate is answered where the row is. In an UPDATE a bare
  // column reference IS the stored row, so `CASE WHEN <pred> THEN ? ELSE "col"
  // END` writes the value for the rows this caller may write it on and leaves
  // the rest exactly as they were — per row, which is the half no JS evaluation
  // of one payload can do for a bulk update.
  const _fieldWriteExprs = {}
  for (const [name, p] of Object.entries(fieldPolicy))
    if (p.allow?.write?.length) _fieldWriteExprs[name] = p.allow.write
  const _hasFieldWrite = Object.keys(_fieldWriteExprs).length > 0

  // The sentence a dot-path write key gets. Two readings, because the way out
  // differs: a document column takes the whole document (there is no path
  // syntax on a write, only on a where), and a scalar one has no inside at all.
  function pathWriteRefusal(key, head, field) {
    const tail = key.slice(head.length + 1)
    if (field.type.name === 'Json')
      return `"${key}" reads as a path into "${head}", and a write takes the whole document — ` +
             `there is no path syntax on this side (a where has one). Read the row, change ` +
             `"${tail}", and write "${head}" back; nothing here merges into a stored value.`
    return `"${key}" reads as a path into "${head}", which is ${field.type.name}${field.type.array ? '[]' : ''} ` +
           `and has no "${tail}" inside it. Write "${head}" itself.`
  }

  function setFragment(field, value, setParams) {
    if (!_hasFieldWrite) { setParams.push(value ?? null); return `"${col(field)}" = ?` }
    return setFragmentExpr(field, '?', [value ?? null], setParams)
  }

  // The same guard for a value SQLite computes rather than one we bind. An
  // atomic operator was spliced into the SET clause whole, so it never passed
  // through here at all: a caller who could not write `views` could increment
  // it, and one who could not write `tags` could push to it (FJS-659). The
  // predicate is the WHEN either way — what changes is that the THEN is an
  // expression reading the stored column instead of a parameter, which is why
  // this takes the fragment rather than the value.
  function setFragmentExpr(field, expr, params, setParams) {
    const exprs = _hasFieldWrite ? _fieldWriteExprs[field] : null
    const pred  = exprs && compileFieldPredicate(
      modelName, exprs, 'update', ctx, ctx.policyMap ?? {}, ctx.schema, ctx.relationMap)
    // The policy is keyed by the FIELD and the assignment names the COLUMN.
    const c = col(field)
    if (!pred) { setParams.push(...params); return `"${c}" = ${expr}` }
    // The WHEN precedes the THEN in the text, so its parameters go first.
    setParams.push(...pred.params, ...params)
    return `"${c}" = CASE WHEN ${pred.sql} THEN ${expr} ELSE "${c}" END`
  }

  /**
   * Why this field cannot be left without a value, in the field's own wording.
   *
   * One owner because two callers ask it — a create-shaped write with the key
   * missing, and any write clearing it with an explicit `null`. Two sentences
   * for one rule is how the second one ends up saying something the first does
   * not.
   *
   * `@required("…")` carries the wording; `@label("Customer")` names the field
   * when there is none. Neither creates the rule — the absence of `?` did.
   */
  // ── @@extensible, resolved once per table ───────────────────────────────────
  //
  // The pool's shape is a fact about the SCHEMA, so it is read here; which key
  // holds which slot is a fact about the DATA, so that is read below.
  const _extensible = (() => {
    const ext = ctx.models[modelName]?.attributes?.find(a => a.kind === 'extensible')
    if (!ext?.max) return null   // no pool means no mirror to keep
    const decl = ctx.models[ext.declaredBy]
    // Which enum member means a numeric slot is decided by the SEED's own
    // `max:` keys and the affinity the expansion gave them, so this asks the
    // expanded columns rather than matching on the word 'number'. It reads the
    // stamped kind and not the column's first letter: the letter is an artefact
    // of how the pool was named, and a member renamed from `number` to
    // `numeric` would have moved every value into a text slot with nothing
    // failing.
    const numeric = new Set(ctx.models[modelName].fields
      .filter(f => f.extKind && f.type.name === 'Float').map(f => f.extKind))
    return {
      column:      ext.column,
      mirror:      `${ext.column}Slots`,
      declaredBy:  ext.declaredBy,
      declTable:   decl ? modelToTableName(decl, ctx.pluralize ?? false) : null,
      kindOf:      (k) => (numeric.has(k) ? 'number' : 'text'),
    }
  })()

  /**
   * This model's declarations, read straight off the declaring table.
   *
   * A raw read rather than the declaring table's own verbs, because this runs
   * INSIDE a write of a different model: going back through the API would apply
   * that model's gate to a caller who is writing a customer, and refuse a write
   * for want of a permission on a table they never named. What the mirror is
   * built from is not a thing the caller is reading.
   *
   * Cached per client and dropped whenever the declaring table is written, so a
   * key declared at three o'clock is projected by the next write rather than by
   * the next process.
   */
  /**
   * The pool `target` declares — its slots in INDEX order and the kind each one
   * holds — or null where that model has no pool.
   *
   * Takes a model NAME rather than reading this table's own, because its caller
   * is the DECLARING table: one declaring table serves every extensible model,
   * so the pool a row is allocated out of is chosen per row and never per
   * client. `Customer` may have a pool while `Product` has none, and both are
   * declared through the same table on the same day.
   */
  function extPoolFor(target) {
    const model = ctx.models?.[target]
    if (!model?.attributes?.some(a => a.kind === 'extensible' && a.max)) return null
    const index = model.attributes.find(a => a.kind === 'index' && a.generated === 'extensible')
    if (!index) return null
    // Slots only: row tenancy leads the index with its tenant column, which is
    // an index prefix and not a slot anything can be allocated into.
    const kinds = new Map(model.fields.filter(f => f.extKind).map(f => [f.name, f.extKind]))
    return {
      order: index.fields.filter(s => kinds.has(s)),
      kind:  Object.fromEntries(kinds),
    }
  }

  function _extDeclarations(tenant) {
    if (!_extensible?.declTable) return []
    const cache = (ctx.extDecl ??= new Map())
    const at    = _extTenantCol ? `${modelName}\0${tenant}` : modelName
    const hit   = cache.get(at)
    if (hit) return hit
    const rows = (_extTenantCol
      ? readDb.query(`SELECT "key", "type", "slot" FROM "${_extensible.declTable}" WHERE "model" = ? AND "${_extTenantCol}" = ?`).all(modelName, tenant)
      : readDb.query(`SELECT "key", "type", "slot" FROM "${_extensible.declTable}" WHERE "model" = ?`).all(modelName)) ?? []
    cache.set(at, rows)
    return rows
  }

  // Under row tenancy every tenant shares the declaring TABLE, so each raw read
  // of it is narrowed to one tenant — unnarrowed, one tenant's declaration took
  // another's slot and promoted its values into an indexed column (`FJS-1290`).
  // Null where there is nothing to narrow: no row tenancy, or a declaring model
  // with no tenant column, whose declarations are the installation's on purpose.
  const _extTenantCol = (() => {
    const t = ctx.schema?.tenancy
    if (t?.strategy !== 'row') return null
    const decl = ctx.models?.[_extensible ? _extensible.declaredBy : modelName]
    return decl?.fields?.some(f => f.name === t.column) ? t.column : null
  })()

  // Which tenant a pool read is for: the one the payload states, else the
  // caller's claim, else the one a filter pins. A system call naming none is
  // refused rather than read across every tenant, because the wrong tenant's
  // declarations map a value into a slot with nothing failing.
  function extTenant(data, where) {
    const col = _extTenantCol
    if (data && data[col] != null) return data[col]
    const claim = ctx.auth?.[ctx.schema.tenancy.claim]
    if (claim != null) return claim
    const pinned = where?.[col]
    if (pinned != null && typeof pinned !== 'object') return pinned
    throw new ValidationError([{ path: [col], message:
      `${modelName}: @@extensible under row tenancy reads declarations per tenant, and this call names none — ` +
      `state '${col}' on it, or make it as the tenant` }])
  }

  function requiredFailure(f) {
    const attrs  = f.attributes ?? []
    const custom = attrs.find(a => a.kind === 'required')?.message
    const label  = attrs.find(a => a.kind === 'label')?.text ?? f.name
    return {
      path: [f.name],
      // A required @system column is the one case where "is required" names the
      // wrong party. The caller was never asked for it — the client schema
      // leaves it out of `required` on purpose — so the app forgot to fill it,
      // and the message has to say which side is missing.
      message: attrs.some(a => a.kind === 'system')
        ? `${label} is @system and was not supplied — the application fills it, with \`system: ['${f.name}']\` on the call`
        : custom ?? `${label} is required`,
    }
  }

  // ─── the cold halves of writeData ─────────────────────────────────────────
  //
  // Every write passes through writeData, and these are the parts most writes
  // never reach: an @@extensible model, a protected column in the payload, a
  // refusal being worded. Inline they doubled its bytecode, and past that size
  // JSC stopped optimizing it well enough that a one-column update ran 40%
  // slower with the same work to do (`FJS-1108`). The conditions stay in
  // writeData, so what these cost is a call on the rare path only.

  function allocateExtSlot(data, stamped) {
    const pool = extPoolFor(String(data.model ?? ''))
    let slot = null
    if (pool) {
      // Raw, and narrowed by model, for the reason `_extDeclarations` is:
      // this runs inside somebody's write and must not put the declaring
      // table's own gate in front of it. Narrowed because one declaring table
      // serves every extensible model and `t1` on a customer is not `t1` on a
      // product.
      const taken = new Set((_extTenantCol
        ? readDb.query(`SELECT "slot" FROM "${tableName}" WHERE "model" = ? AND "slot" IS NOT NULL AND "${_extTenantCol}" = ?`).all(String(data.model), extTenant(data))
        : readDb.query(`SELECT "slot" FROM "${tableName}" WHERE "model" = ? AND "slot" IS NOT NULL`).all(String(data.model))
      ).map(r => r.slot))
      // First free of the matching kind, in INDEX order — so the field a
      // tenant declares first lands leftmost, where a one-term query reaches
      // it. A full pool answers null, which is the ordinary end of a pool and
      // not a failure: the field still stores and still renders.
      slot = pool.order.find(s => pool.kind[s] === String(data.type) && !taken.has(s)) ?? null
    }
    data    = { ...data, slot }
    stamped = stamped ? new Set([...stamped, 'slot']) : new Set(['slot'])
    return [data, stamped]
  }

  function mirrorExtSlots(data, stamped) {
    const declared = _extDeclarations(_extTenantCol ? extTenant(data) : undefined)
    const blob     = data[_extensible.column]
    const slots    = {}
    // An unpromoted or absent key is omitted rather than written null: a
    // missing JSON path and a null one both read NULL through json_extract,
    // so writing it costs bytes on every row and buys nothing.
    if (blob && typeof blob === 'object') {
      for (const d of declared) {
        if (!d.slot) continue
        const v = blob[d.key]
        if (v === undefined || v === null || v === '') continue
        // The column's affinity is REAL or TEXT and nothing coerces on the
        // way in, so a number arriving as a string would sort as text and
        // compare wrong.
        if (_extensible.kindOf(d.type) === 'number') {
          const n = Number(v)
          if (Number.isFinite(n)) slots[d.slot] = n
        } else {
          slots[d.slot] = String(v)
        }
      }
    }
    data = { ...data, [_extensible.mirror]: slots }
    // The framework filled it, so the @system refusal below has to let it
    // past — the same hatch `@updatedBy` and the tenancy stamp ride on.
    stamped = stamped ? new Set([...stamped, _extensible.mirror]) : new Set([_extensible.mirror])
    return [data, stamped]
  }

  function refuseGuardedWrite(data, stamped) {
    const denied = Object.keys(data).filter(k => _guardedWriteKeys.has(k) && !stamped?.has(k))
    if (denied.length) throw new AccessDeniedError(
      `${modelName}: ${denied.map(f => `"${f}"`).join(', ')} ${denied.length > 1 ? 'are' : 'is'} @guarded — ` +
      `a system-context column on write as well as read. Write it through asSystem(), or leave it out of the ` +
      `payload. For a column some callers may write, @allow('write', …) is the tool; @guarded answers both ` +
      `halves at once, which is why the two cannot sit on one field.`,
      { model: modelName, operation: 'write' }
    )
  }

  function refuseSystemWrite(data, system, stamped) {
    const allowed = new Set(Array.isArray(system) ? system : system ? [system] : [])
    // `stamped` for @guarded's reason — a @system column with a generated
    // default is written by the application in the most literal sense.
    const denied  = Object.keys(data).filter(k => _systemWriteKeys.has(k) && !allowed.has(k) && !stamped?.has(k))
    if (denied.length) throw new AccessDeniedError(
      `${modelName}: ${denied.map(f => `"${f}"`).join(', ')} ${denied.length > 1 ? 'are' : 'is'} @system — ` +
      `readable by anyone, written by the application rather than by its caller. Name the column on the call ` +
      `to write it and keep every other rule:\n\n` +
      `    db.${modelName.charAt(0).toLowerCase() + modelName.slice(1)}.update({ where, data, system: [${denied.map(f => `'${f}'`).join(', ')}] })\n\n` +
      `asSystem() writes it too, and drops the gate, the row policies and the audit actor with it.`,
      { model: modelName, operation: 'write' }
    )
  }

  // ── system: [...], what a call may name ─────────────────────────────────
  // A @system column, a field whose moves are declared, or the gate
  // (`FJS-D575`). An entry naming nothing a call lifts is refused rather than
  // ignored: a misspelled or renamed column then reads as permission in review
  // and grants none, and `system: true` — transition()'s spelling, which knows
  // its own column — was accepted on a write and allowed nothing.
  function refuseSystemEntries(system, ops) {
    if (system == null) return
    const lower = modelName.charAt(0).toLowerCase() + modelName.slice(1)
    for (const e of Array.isArray(system) ? system : [system]) {
      if (typeof e !== 'string') throw new Error(
        `${modelName}: system names what the call writes as the application, as a list — got ${JSON.stringify(e)}. ` +
        `A @system column by name, or '${GATE_LIFT}' to grade the call SYSTEM against the model's own gate:\n\n` +
        `    db.${lower}.${ops[0]}({ data, system: ['${GATE_LIFT}'] })\n\n` +
        `transition() takes system: true because the move already names its column.`)
      if (e === GATE_LIFT) {
        if (ctx.gateFor?.(modelName, ops[0]) == null) throw new Error(
          `${modelName}: system: ['${GATE_LIFT}'] — the model declares no @@gate, so there is nothing to lift.`)
        continue
      }
      if (e.startsWith('@')) throw new Error(
        `${modelName}: system: ['${e}'] — '${GATE_LIFT}' is the one guarantee a call may lift by name. ` +
        `asSystem() lifts the rest, and lifts them together.`)
      if (!_systemWriteKeys.has(e) && !_tableTransitions?.[e]) throw new Error(
        `${modelName}: system: ['${e}'] — "${e}" is not a @system column` +
        `${_tableTransitions ? ' or a field with declared moves' : ''}, so naming it lifts nothing.`)
    }
  }

  function refuseImmutableWrite(data, stamped) {
    const denied = Object.keys(data).filter(k => _immutableWriteKeys.has(k) && !stamped?.has(k))
    if (denied.length) throw new ValidationError(
      denied.map(f => ({
        path: [f],
        message: `${f} is @immutable — written once, when the row was created, and not again. ` +
                 `Leave it out of the payload; to correct the value, write a new row that supersedes this one.`,
      })),
      { model: modelName, operation: 'write' }
    )
  }

  function refuseMissingRequired(model, data) {
    const missing = []
    for (const f of model.fields) {
      // Arrays always carry a DDL-level DEFAULT '[]' (empty array is the
      // null state — see ddl.js), so they are never required.
      if (f.type.optional || f.type.array || f.type.kind === 'relation' || f.type.kind === 'implicitM2M') continue
      const attrs = f.attributes ?? []
      if (isServerFilled(f)) continue
      // A required @transient field is required OF THE CALLER, on the wire,
      // where the API validates it. It is lifted off the payload before the
      // write, so demanding it here would refuse every write that obeyed it.
      if (attrs.some(a => a.kind === 'transient')) continue
      // An `@id` the SERVER assigns — an autoincrementing rowid alias, or a
      // declared default. One owner with the create-mode JSON Schema, because
      // the two answered it separately and disagreed: this tested the TYPE and
      // not the key, so an `Int` member of a composite key was treated as a
      // rowid alias, and a create that omitted it reached SQLite and came back
      // as a raw `NOT NULL constraint failed` naming a physical table
      // (`FJS-608`). `PRIMARY KEY (a, b)` is never a rowid alias.
      if (isServerAssignedId(f, model)) continue
      if (data?.[f.name] == null) missing.push(requiredFailure(f))
    }
    if (missing.length) throw new ValidationError(missing)
  }

  function refuseClearingRequired(data) {
    const clearing = []
    for (const key of Object.keys(data ?? {})) {
      if (data[key] !== null) continue
      const f = _fieldsByName.get(key)
      // A virtual column is refused by name upstream (`_virtualWriteKeys`) and
      // is not a column here either; an optional one is what `null` is for.
      if (!f || f.type.optional || !isStoredField(f)) continue
      clearing.push(requiredFailure(f))
    }
    if (clearing.length) throw new ValidationError(clearing)
  }

  function protectEncryptedFields(transformed) {
    for (const [fieldName, policy] of Object.entries(fieldPolicy)) {
      if (!policy.encrypted && !policy.hashed) continue
      if (!(fieldName in transformed)) continue
      const val = transformed[fieldName]
      if (val == null) continue
      // ── Is this already protected, or does it merely LOOK it? ──────────
      //
      // `isCiphertext(val)` read three characters and answered yes, so a
      // caller sending `v1.` plus their own text had it stored VERBATIM in a
      // column the app promises is encrypted — and read back as `null`, since
      // the decrypt then failed. The same one function gated the HASH path,
      // so a `v1.` value skipped hashing too and a `@hashed` column ended up
      // holding something that is not a digest of anything (`FJS-715`).
      //
      // Three things replace it. The MODE must match the column's own
      // protection. The value must actually VERIFY — GCM's tag is the answer
      // and a forgery cannot produce one. And a non-system caller may not
      // send one at all: a caller never legitimately holds ciphertext, so the
      // shape is either an accident (a value that starts `v1.`) or an
      // attempt, and both are better refused by name than stored in clear.
      const wantMode = policy.hashed ? 'hash' : 'enc'
      const env      = parseEnvelope(val)
      if (env) {
        if (!ctx.isSystem)
          throw new ValidationError([{ path: [fieldName], message:
            `${fieldName} looks like a stored ${env.mode === 'hash' ? 'digest' : 'ciphertext'} ` +
            `(it begins '${env.prefix}'). A caller sends the value itself — this column is ` +
            `${policy.hashed ? '@hashed' : '@encrypted'} and the encoding is the database's.` }])
        // A system write MAY carry one: a re-save, a restore, a backfill. It
        // is skipped only where it is genuinely that value's own encoding —
        // otherwise it falls through and is protected like any other string,
        // which is what makes a `v1.` in a `@hashed` column get hashed.
        if (verifiesAs(val, ctx.enc.ring ?? ctx.enc.key, wantMode)) continue
      }

      // A Json field is serialized to text BEFORE encryption, because
      // encryptField's String(plaintext) turns an object into
      // '[object Object]' and encrypts that — destroying the value with
      // nothing thrown. serializeRow() runs AFTER this block and stringifies
      // the ciphertext again, and read() mirrors it exactly (JSON.parse then
      // decrypt), so the round trip is symmetric and the stored column is
      // still a JSON string as the column type says.
      const plain = policy.json ? JSON.stringify(val) : val

      transformed[fieldName] = policy.hashed                 ? hashField(plain, ctx.enc.key)
                             : policy.encrypted.deterministic ? encryptDeterministic(plain, ctx.enc.key)
                             :                                  encryptField(plain, ctx.enc.key)
    }
  }

  function refuseBadEnums(transformed) {
    for (const [field, meta] of Object.entries(enumFields)) {
      const val = transformed[field]
      // An enum ARRAY has no CHECK behind it — SQLite cannot read the elements
      // of a JSON array without a subquery, and a CHECK may not contain one. So
      // this loop IS the boundary for a set-valued enum, not a nicer message in
      // front of one. Array-ness, @minItems and friends were checked in
      // validate() above.
      if (meta.array) {
        if (!Array.isArray(val)) continue
        const bad = val.filter(v => !meta.values.has(String(v)))
        if (bad.length) {
          throw new ValidationError([{
            path:    [field],
            message: `invalid ${meta.enumName} value${bad.length > 1 ? 's' : ''} ` +
                     `${bad.map(v => `"${v}"`).join(', ')} — ${enumOptions(meta, bad[0])}`,
          }])
        }
        continue
      }
      if (val == null) {
        if (!meta.optional && field in transformed)
          throw new ValidationError([{ path: [field], message: `must be one of: ${[...meta.values].join(', ')}` }])
        continue
      }
      if (!meta.values.has(String(val))) {
        throw new ValidationError([{
          path:    [field],
          message: `invalid ${meta.enumName} value "${val}" — ${enumOptions(meta, val)}`,
        }])
      }
    }
  }

  function dropFieldWriteDenied(transformed) {
    for (const [fieldName, policy] of Object.entries(fieldPolicy)) {
      if (!policy.allow?.write?.length) continue
      if (!(fieldName in transformed)) continue
      const permitted = policy.allow.write.some(expr =>
        evalJs(expr, ctx, transformed, modelName, ctx.policyMap ?? {}, ctx.relationMap, 'create')
      )
      if (!permitted) delete transformed[fieldName]
    }
  }

  function refuseUnbindable(row) {
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === 'function')
        throw new ValidationError([{ path: [k], message: `${k} was given a function — you probably forgot to call it` }])
      if (typeof v === 'symbol')
        throw new ValidationError([{ path: [k], message: `${k} was given a symbol — symbols cannot be stored` }])
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !ArrayBuffer.isView(v))
        throw new ValidationError([{ path: [k], message:
          `${k} was given an object where a value was expected. The atomic operators — ` +
          `increment, decrement, multiply, divide on a numeric column, push on an array one — ` +
          `apply on update only, and only to a column whose declared type carries them; ` +
          `anything else is a value, read it, change it and write it back` }])
    }
  }

  function writeData(data, { requireAll = false, system = null, fieldWrite = 'js', stamped = null, creating = false } = {}) {
    const model = ctx.models[modelName]

    // Unknown keys in the data payload are silently stripped — mass-assignment
    // protection, so a form/request body can be passed straight in without
    // whitelisting. (Deliberate policy choice 2026-08-01; typos in required
    // fields still surface via the required-field check below, and typo'd
    // *filters* are handled separately in where validation.)
    // A key set to `undefined` is dropped with them. The column list comes from
    // Object.keys, so a present-but-undefined key becomes an explicit NULL bind
    // — which defeats the DDL DEFAULT and fails a NOT NULL column. `{ views:
    // form.views }` off a form that had no views field is the shape that hits
    // it. Only `null` clears (Invariant 9).
    if (model && data && typeof data === 'object' && !Array.isArray(data)) {
      let cleaned = null
      for (const k of Object.keys(data)) {
        if (data[k] === undefined) {
          if (!cleaned) cleaned = { ...data }
          delete cleaned[k]
          continue
        }
        if (_allowedWriteKeys.has(k) || _edgeNamespaces.has(k)) continue
        // Stripping an UNKNOWN key silently is the mass-assignment protection.
        // Stripping a key the model declares but cannot store is a different
        // thing wearing the same clothes, and the caller has to hear about it.
        const why = _virtualWriteKeys.get(k)
        if (why) throw new ValidationError([{ path: [k], message: why }])
        // A PATH is the third thing wearing those clothes, and it was being read
        // as the first: `{ 'settings.commute': … }` names a column this model
        // has, so it is not a form body passing through — it is a caller who
        // meant something the boundary could have named (FJS-658).
        const dot = k.indexOf('.')
        const head = dot > 0 ? k.slice(0, dot) : null
        const headField = head && _fieldsByName.get(head)
        if (headField) throw new ValidationError([{ path: [k], message: pathWriteRefusal(k, head, headField) }])
        if (!cleaned) cleaned = { ...data }
        delete cleaned[k]
      }
      if (cleaned) data = cleaned
    }

    // A write to a table somebody DECLARES from invalidates every cached list:
    // a field declared at three o'clock has to be projected by the next write,
    // not by the next process.
    if (ctx.extDeclarers?.has(modelName)) ctx.extDecl?.clear()

    // ── @@extensible — the slot a declaration takes ───────────────────────
    //
    // Allocated here rather than by the app, because the three things it takes
    // are all facts the schema states: the pool, the order, and which slots are
    // already spoken for. An app writing this by hand has to read `max:` back
    // out of the parsed seed to get the pool and off the generated `@@index` to
    // get the order, which is the same fact restated in a second place — and
    // the place it goes wrong is silent, since a declaration with no slot
    // stores, renders and edits exactly like one that has one. Every field then
    // reads as *the pool is full*, every query still answers correctly, and
    // only the plan is different.
    //
    // Absent means allocate; a slot the payload STATES is honored. An import
    // restoring declarations has to be able to say which slot each one held,
    // and re-deriving them would repoint live fields onto slots whose mirrors
    // were written for somebody else — which does not self-heal the way the
    // mirror does, because the values are already in the wrong columns.
    if (creating && ctx.extDeclarers?.has(modelName)
        && data && typeof data === 'object' && !Array.isArray(data)
        && !('slot' in data) && _fieldsByName.has('slot')) [data, stamped] = allocateExtSlot(data, stamped)

    // ── @@extensible — the slot mirror ────────────────────────────────────
    //
    // The tenant's keys go in the blob; the mirror is the same values re-keyed
    // onto the pooled columns so a query can reach an index. It is DERIVED, so
    // the caller never sends it and never has to know a slot exists.
    //
    // Here rather than in each write verb because `writeData` is the one place
    // every payload passes through: `makeTable` hand-restates its rule sequence
    // per method, so a derived column added at eight call sites has a ninth
    // nobody noticed, and a mirror that is not rebuilt is a query that matches
    // the value a row used to hold.
    //
    // Rebuilt WHOLE rather than merged: a key removed from the blob has to
    // leave the mirror too, or a query goes on finding a row by a value it no
    // longer has. Absent means leave it alone — a patch naming other columns is
    // not a statement about these — and Invariant 9's explicit null clears.
    if (_extensible && data && typeof data === 'object' && !Array.isArray(data)
        && _extensible.column in data) [data, stamped] = mirrorExtSlots(data, stamped)

    // ── @guarded, the write half ──────────────────────────────────────────
    // @guarded is a system-context lock in both directions. The read strips the
    // column; without this the same caller could still SET it, so the column was
    // invisible and writable at once — nobody could see what they overwrote and
    // the owner could not see that they had (FJS-235). The strip made a landed
    // write look exactly like a refusal, which is why it went unnoticed.
    //
    // Refused by name rather than dropped the way a field @allow('write') is:
    // naming a guarded column is not a form body passing through, and a silent
    // drop is the shape being fixed. @encrypted alone does NOT reach here — it
    // hides a value from a reader, and the caller supplying a secret is
    // routinely not the system.
    //
    // It grades the CALLER's keys, which is not the same set as the payload's:
    // by the time writeData is handed one, the create path has stamped
    // @default(uuid()) / @createdBy / @version / @sequence / @default(auth().x)
    // into it. Grading the payload made a guarded column refuse its own stamp,
    // so `@guarded @default(nanoid())` — a token the engine mints and no caller
    // may set, which is the shape this pairing exists for — made the model
    // uncreatable by anyone below system (FJS-565). `stamped` is what the
    // stamps injected; every caller of writeData that stamps passes one, and an
    // entry point that forgets is refused rather than let through, which is the
    // safe direction for a fail-closed rule.
    if (!ctx.isSystem && _guardedWriteKeys.size && data && typeof data === 'object' && !Array.isArray(data)) refuseGuardedWrite(data, stamped)

    // ── @system, the write half ───────────────────────────────────────────
    // The column reads like any other and is written by the application, not by
    // the person using it — a tracking code a courier job books, an API key's
    // hint, a workspace stamped from a header. Before this the schema could not
    // say so, so a generated form offered a text box whose value a worker
    // overwrote a second later (FJS-095).
    //
    // Refused by name rather than dropped, for @guarded's reason: the client is
    // told `readOnly` and a generated form does not offer the column at all, so
    // a payload naming it is code that meant to write it. A field
    // @allow('write', …) still DROPS — there the same payload is legitimate for
    // another caller, and a form body passing through an ordinary one is
    // expected traffic.
    //
    // Nothing above this refuses it earlier. Junction's autoValidate does not
    // read `readOnly`, and must not start: `@version` is readOnly in the update
    // schema and a patch is REQUIRED to carry it back. So this is the boundary
    // that answers, and it answers 403 rather than 400.
    //
    // The narrow hatch is `system: ['col']` on the call, which keeps every
    // other protection — the gate, the row policies, soft-delete, the audit
    // actor — where asSystem() drops all of them to write one column. Naming
    // the field IS the statement: an escape hatch may not disable a guarantee
    // silently.
    if (!ctx.isSystem && _systemWriteKeys.size && data && typeof data === 'object' && !Array.isArray(data)) refuseSystemWrite(data, system, stamped)

    // ── @immutable, the write half ────────────────────────────────────────
    // Written once, at create, and frozen after — what a DOCUMENT is
    // (`FJS-D162`). An invoice's number, the instant it was issued and the
    // total it was issued for are a statement about a moment, and a correction
    // is a credit note rather than an edit.
    //
    // It refuses the KEY and never compares the value, which is the only thing
    // a rule here could do: nothing in this language can see the stored row
    // beside the incoming one. So *I sent the same total back* is refused too,
    // and that is the behavior wanted — a form that round-trips a frozen
    // column is a form that would have overwritten it the day somebody changed
    // the box.
    //
    // Outside the `!ctx.isSystem` guard the two blocks above share, and that is
    // the whole substance of the ruling: a renewal job and a payment settler
    // both run as system, so a rule they may drop is a rule absent from every
    // caller that actually writes an invoice. `@check` and `@@check` are the
    // company it keeps (`FJS-519`); a raw UPDATE still bypasses it, as it does
    // one of those.
    //
    // `creating` defaults to false, so an entry point that forgets to say it is
    // a create refuses rather than lets through — @guarded's own reasoning, and
    // the safe direction for a fail-closed rule.
    // On a SEALING model the freeze has a moment, so it cannot be answered from
    // the payload: `@immutable` there means *frozen at the seal*, and the row is
    // editable while it is still a draft. The refusal moves into the WHERE with
    // the other state guards; `_sealImmutable` below is where the keys go.
    if (!creating && _immutableWriteKeys.size && !_sealSelf && data && typeof data === 'object' && !Array.isArray(data)) refuseImmutableWrite(data, stamped)

    // ── @capability, the column tier ──────────────────────────────────────
    // `Server.update` says a caller may write the row; `Server.hostname` says
    // this one column needs a grant of its own (`FJS-D147`). Opt-in per column
    // rather than derived, because deriving every writable column gives basecamp
    // 461 capabilities and no picker can show that.
    //
    // Refused by name rather than dropped, which is the difference between this
    // and a field @allow('write', …) that happens to name a capability: a
    // capability THROWS (`FJS-D146`), because it is verb-scoped and refusing
    // leaks nothing about any row.
    //
    // Only the WRITE tier is here. A per-column READ wants the predicate
    // spelling — @allow('read', 'X' in auth().capabilities) — because a column
    // read must STRIP rather than refuse, or a caller who never named the column
    // gets a 403 on an ordinary list.
    //
    // The payload this reads is the one AFTER the create path applies its stamps,
    // which is why @capability beside @default(auth().x) is refused at parse: the
    // stamp would refuse itself and take every create with it.
    // CREATE only. On an update the plugin's `_checkUpdate` owns this, because
    // there the column grant REPLACES `Model.update` for the keys it covers and
    // that partition needs the whole payload in one place. A create is the other
    // shape: `Model.create` is the grant for making the row exist at all and is
    // not the one a column grant was meant to withhold, so both apply.
    if (!ctx.isSystem && requireAll && _capabilityWriteKeys.size &&
        data && typeof data === 'object' && !Array.isArray(data)) {
      for (const k of Object.keys(data))
        if (_capabilityWriteKeys.has(k)) requireCapability(modelName, k, ctx)
    }

    // ── The escalation guard on a grant column ────────────────────────────
    // The values are already known to be REAL capabilities — that is the enum's
    // job, one layer down. This asks the other question: may this caller hand
    // them out. Subset, never a rank (`FJS-529`).
    if (!ctx.isSystem && _grantColumns.size && data && typeof data === 'object' && !Array.isArray(data)) {
      for (const k of Object.keys(data))
        if (_grantColumns.has(k)) requireGrantSubset(modelName, k, data[k], ctx)
    }

    // Required-field pre-flight. The schema knows requiredness; without this
    // a missing NOT NULL field surfaced as SQLite's raw "NOT NULL constraint
    // failed" instead of a ValidationError shaped like every other field rule.
    if (model && requireAll) refuseMissingRequired(model, data)

    // The OTHER thing a payload can say, and the one shape that is
    // unambiguously wrong.
    //
    // An absent key on a partial write means *leave it alone*, which is why the
    // block above is create-shaped only and correctly so. An explicit `null` is
    // Invariant 9's *clear this*, and clearing is exactly what a NOT NULL column
    // cannot do — so with nothing checking it, the payload nobody could defend
    // was the one that reached SQLite: a bare `NOT NULL constraint failed:
    // item.name`, which declares no status and lands as a 500 with a null body,
    // where the same mistake on a create is a 400 naming the field (`FJS-669`).
    // `FJS-608` is the same class one door along and was fixed the same way, by
    // testing the KEY rather than letting the database answer.
    //
    // `@default` does not exempt here, where it does above: a default fills an
    // ABSENT key and this key is present. Measured — `qty: null` on
    // `Int @default(1)` reaches SQLite and is refused by it.
    //
    // `undefined` is not this, and is not handled here: the strip above deletes
    // an undefined-valued key and reassigns `data`, so this loop cannot see one.
    // `=== null` is still what it should say — the rule is about the value, and
    // stating it here is what keeps this correct if that strip ever moves.
    else if (model) refuseClearingRequired(data)

    const transformed = model ? applyTransforms(data, model) : { ...data }
    // Array rules — shape, element type, @minItems/@maxItems/@uniqueItems —
    // live in validate.js with every other rule, and `buildValidationMap` flags
    // a model with any array field so this call is reached. They were enforced
    // here once, with their wording built at the throw site, so an authored
    // `@minItems(2, "Pick at least two tags")` reached the browser through
    // `x-messages` and was ignored by the server (FJS-194).
    if (model && ctx.hasValidation[modelName]) validate(transformed, model, computedFns, ctx.typeMap, ctx.enumTypeMap)

    // Encrypt @encrypted / hash @hashed fields before write
    if (ctx.enc.key && hasFieldPolicy) protectEncryptedFields(transformed)

    // Validate enum fields with friendly errors before hitting SQLite's CHECK
    if (_hasEnumFields) refuseBadEnums(transformed)
    // @allow('write', expr) — silently drop restricted fields before write.
    // Dropped rather than refused because the predicate is per-caller: the same
    // payload is legitimate for an admin, so a form body reaching an ordinary
    // caller is expected traffic. @guarded above is the other answer, for a
    // column no caller may write at all.
    //
    // **This is the CREATE half only** (`FJS-D129`). Here the payload IS the row
    // being created, so grading the predicate against it is the same thing
    // `checkCreatePolicy` does one layer up and is correct. On an UPDATE it is
    // not: the row exists, and evaluating `auth().id == ownerId` against the
    // PAYLOAD is wrong in both directions — a payload omitting `ownerId` grades
    // against `undefined` and drops a column the owner was entitled to write,
    // and a payload STATING `ownerId: me` grades against the caller's own
    // assertion and writes the column on somebody else's row (`FJS-433`, and
    // that second one is fail-open). The update paths pass `fieldWrite: 'sql'`
    // and the predicate becomes the WHEN of a CASE in the SET, where it reads
    // the stored row.
    if (!ctx.isSystem && fieldWrite === 'js') dropFieldWriteDenied(transformed)

    const row = serializeRow(
      serializeBooleans(
        stripVirtual(transformed, generatedFields, computedFields, _hasFrom ? Object.keys(fromFields) : null),
        boolFields
      ),
      jsonFields
    )

    // Everything above has run, so every remaining value is about to become a
    // bind parameter. A plain object here is the one unbindable value bun:sqlite
    // does not throw on — it reads it as a bag of NAMED parameters, matches none
    // of the statement's positional `?`, and executes with EVERY binding dropped
    // including the WHERE. The write silently changes nothing and `update`
    // reports it as "no such row". Json columns are already text by this point,
    // so anything still an object is genuinely unbindable.
    refuseUnbindable(row)
    return row
  }

  // Hydration for the grouped and aggregated paths, which return SQLite's own
  // values rather than going through a row read — so an array column came back
  // as its JSON text and a Boolean as 0/1, and a value's TYPE depended on which
  // method asked for it.
  //
  // Only for values still in the column's own domain: the `by` keys of a
  // groupBy, and `_min`/`_max`. NOT `_sum`/`_avg`, where the number is no longer
  // of the column's type — the sum of a Boolean column is a count, and coercing
  // that back would answer 3 as `false`.
  // `_min`/`_max` of a wide column is still of that column's type, and reaches
  // here keyed by the FIELD name after the aggregate has unpacked its aliases —
  // which is the only place that mapping is known. Without it the answer is a
  // number whenever the extreme happened to fit, so the type of an aggregate
  // would depend on the data in the table.
  const hydrateCols = (obj) => {
    if (!obj) return obj
    if (_hasBig) for (const k of bigFields) if (typeof obj[k] === 'number') obj[k] = String(obj[k])
    return coerceBooleans(deserializeRow(obj, jsonFields), boolFields)
  }

  // ── Encode WHERE values for matchable protected fields ───────────────────
  // Wraps buildWhere so an equality comparison on an @encrypted(deterministic) or
  // @hashed field encodes the operand the same way the column was encoded first.
  // _fromExprMap is defined later (after _fromEntries) and passed into buildWhere.
  // tableAlias is optional — passed only when the outer FROM uses an alias
  // (e.g. relation orderBy adds JOINs, so columns need `t.` qualification).
  // ── Relation filter resolver ───────────────────────────────────────────────
  // Compiles { relation: { some|every|none: WHERE } } (and is/isNot for a
  // to-one relation) into a correlated EXISTS subquery. Returns undefined when
  // `relName` isn't a relation on THIS model, so buildWhere falls through to
  // normal column handling.
  function relationFilterSql(relName, cond, params, tableAlias) {
    return relationFilterOn(modelName, 0, relName, cond, params, tableAlias)
  }
  // A nested where is resolved against the model it sits in, and each level
  // takes its own alias: resolved against the query's model, `labels: { some:
  // { label: { is } } }` looked `label` up on Issue and compiled it as a column
  // (FJS-1314), and a second `t` would shadow the first, so the inner
  // correlation would compare the target to itself.
  function relationFilterOn(owner, depth, relName, cond, params, tableAlias) {
    const rel = ctx.relationMap?.[owner]?.[relName]
    if (!rel) return undefined   // not a relation → normal column

    const parentRefKey = rel.referencedKey ?? (rel.kind === 'manyToMany' ? rel.selfPk : null) ?? 'id'
    // The parent side is the OWNER's column; everything aliased `t` is the
    // target's, so the two take different maps.
    const omap = ctx.columnMaps?.[owner]
    const oc   = owner === modelName ? col : (nm) => omap?.[nm] ?? nm
    const tmap = ctx.columnMaps?.[rel.targetModel]
    const tc   = tmap && Object.keys(tmap).length ? (nm) => tmap[nm] ?? nm : (nm) => nm
    const parentCol = `${tableAlias ? `${tableAlias}.` : `"${tableName}".`}"${oc(rel.kind === 'belongsTo' ? rel.foreignKey : parentRefKey)}"`
    const t = depth ? `t${depth}` : 't'
    const j = depth ? `j${depth}` : 'j'
    const targetTable = _modelToTable(rel.targetModel)
    const targetSoft  = ctx.softDeleteMap?.[rel.targetModel] ? ` AND ${t}."${tc('deletedAt')}" IS NULL` : ''

    // Build the inner WHERE against the target table (aliased `t`, `t1`, … by depth).
    // The target's own write transforms apply here; the outer rewrite only
    // knows this model's fields, so `user: { is: { email } }` on a `@lower`
    // email compared the raw spelling and matched nothing (`FJS-1468`).
    const targetTransformed = transformedOf(rel.targetModel)
    const innerOf = (w) => {
      if (!w || (typeof w === 'object' && !Object.keys(w).length)) return ''
      if (targetTransformed) w = rewriteTransformedWhere(w, targetTransformed)
      const p = []
      const sql = buildWhere(w, p, null, t, null,
        (k, v, pp, al) => relationFilterOn(rel.targetModel, depth + 1, k, v, pp, al), ctx.filterKindMap?.[rel.targetModel], tmap)
      return { sql, p }
    }

    // Correlated FROM+WHERE that ties the target back to this parent row.
    let corr
    if (rel.kind === 'hasMany') {
      corr = `FROM "${targetTable}" ${t} WHERE ${t}."${tc(rel.foreignKey)}" = ${parentCol}${targetSoft}`
    } else if (rel.kind === 'manyToMany') {
      corr = `FROM "${rel.joinTable}" ${j} INNER JOIN "${targetTable}" ${t} ON ${t}."${tc(rel.targetPk ?? 'id')}" = ${j}."${rel.targetKey}" WHERE ${j}."${rel.selfKey}" = ${parentCol}${targetSoft}`
    } else { // belongsTo
      corr = `FROM "${targetTable}" ${t} WHERE ${t}."${tc(parentRefKey)}" = ${parentCol}${targetSoft}`
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
        // A ValidationError, for the same reason the scalar operator refusal in
        // query.js is one: the operator came off a caller's query string, so a
        // 500 blames the server for what the request got wrong.
        throw new ValidationError([{ path: ['where', relName], message:
          `unknown relation operator "${mode}" (use some/every/none${rel.kind === 'belongsTo' ? '/is/isNot' : ''})` }])
      }
    }
    return clauses.join(' AND ')
  }

  // A `$scope` becomes a `$raw` before anything else looks at the where.
  // Desugaring rather than adding a case to buildWhere is what makes it compose
  // for free: `{ $scope: 'overdue', status: 'open' }` conjoins, a scope nested
  // under AND/OR/NOT nests, and the parameters land in the position `$raw`'s
  // already do — one owner of each, instead of a second implementation.
  function expandScopes(where) {
    if (!where || typeof where !== 'object') return where
    if (Array.isArray(where)) return where.map(expandScopes)
    if (!('$scope' in where)) {
      let changed = false
      const out = {}
      for (const [k, v] of Object.entries(where)) {
        out[k] = (k === 'AND' || k === 'OR' || k === 'NOT') ? expandScopes(v) : v
        if (out[k] !== v) changed = true
      }
      return changed ? out : where
    }
    const { $scope, ...rest } = where
    const names = Array.isArray($scope) ? $scope : [$scope]
    if (!names.length)
      throw new ValidationError([{ path: ['where', '$scope'], message:
        `$scope was given an empty list — omit it, or name a scope` }])
    for (const n of names)
      if (typeof n !== 'string')
        throw new ValidationError([{ path: ['where', '$scope'], message:
          `$scope names a declared @@scope, so it is a string — got ${n === null ? 'null' : typeof n}` }])
    const clauses = names.map(n =>
      compileScope(modelName, n, ctx, ctx.scopeMap, ctx.policyMap, ctx.schema, relationMap))
    // Several scopes AND, and they AND with the rest of the where. A disjunction
    // is written as its own scope, where the OR is in the expression language
    // and both compilers can see it.
    const merged = clauses.length === 1
      ? clauses[0]
      : rawClause(clauses.map(c => `(${c.sql})`).join(' AND '), clauses.flatMap(c => c.params))
    const out = expandScopes(rest)
    // `$raw` is a single slot, so a caller using both needs them conjoined.
    return out.$raw
      ? { ...out, $raw: rawClause(`(${merged.sql}) AND (${out.$raw.sql})`, [...merged.params, ...out.$raw.params]) }
      : { ...out, $raw: merged }
  }

  function buildWhereWithEncryption(where, params, tableAlias = null, outerIsAliased = tableAlias === 't') {
    const fromMap = outerIsAliased ? _fromExprMapAliased : _fromExprMap
    if (!where) return buildWhere(where, params, fromMap, tableAlias, _typedJsonMap, edgeOrRelFilter, fieldKinds, columnMap, _pointMap)
    where = _hasScopes ? expandScopes(where) : where
    where = _extensible ? rewriteExtensibleWhere(where, _extTenantCol ? () => extTenant(null, where) : null) : where
    where = _transformed ? rewriteTransformedWhere(where) : where
    let rewritten = where
    if (ctx.enc.key) {
      rewritten = rewriteEncryptedWhere(where)
      if (rewritten?.__impossible) {
        const prefix = tableAlias ? `${tableAlias}.` : ''
        return `${prefix}"id" IS NULL AND ${prefix}"id" IS NOT NULL`
      }
    }
    return buildWhere(rewritten, params, fromMap, tableAlias, _typedJsonMap, edgeOrRelFilter, fieldKinds, columnMap, _pointMap)
  }

  /**
   * `where: { fields: { tier: 'gold' } }` → `where: { t1: 'gold' }`.
   *
   * The tenant's own key is what crosses the wire and the slot never leaves the
   * Data boundary — a caller cannot know which pooled column their field landed
   * in, and should not have to.
   *
   * Nested under the blob column rather than spelled bare, because a bare
   * `{ tier: … }` cannot be told from a real column of that name: the
   * declarations are DATA, so a tenant could declare `name` tomorrow and shadow
   * or be shadowed by a column, silently, depending on which won. Under the
   * column there is no collision to resolve.
   *
   * A key that is not declared, or is declared and holds no slot, is REFUSED by
   * name rather than dropped or scanned. Dropping widens the result set in
   * silence, which is the failure this whole feature exists to prevent — the
   * request succeeds, the count looks plausible, and the answer is about more
   * rows than were asked for.
   */
  function rewriteExtensibleWhere(where, tenantOf) {
    if (!where || typeof where !== 'object') return where
    if (Array.isArray(where)) return where.map(w => rewriteExtensibleWhere(w, tenantOf))

    const out = {}
    for (const [key, val] of Object.entries(where)) {
      if (key === 'AND' || key === 'OR' || key === 'NOT') {
        out[key] = rewriteExtensibleWhere(val, tenantOf)
        continue
      }
      // Only the blob, and only when handed an object of keys. An operator
      // object (`{ equals: … }`) is the column being compared whole, which is
      // what a Json column has always meant and still does.
      if (key !== _extensible.column || !val || typeof val !== 'object' || Array.isArray(val)
          || Object.keys(val).some(k => JSON_WHOLE_OPS.has(k))) {
        out[key] = val
        continue
      }

      const declared = _extDeclarations(tenantOf?.())
      const byKey    = new Map(declared.map(d => [d.key, d]))
      for (const [k, v] of Object.entries(val)) {
        const d = byKey.get(k)
        if (!d) throw new ValidationError([{ path: [_extensible.column, k], message:
          `'${k}' is not a field this ${modelName} declares` +
          (declared.length ? `. Declared: ${declared.map(x => x.key).join(', ')}` : ' — nothing is declared yet') }])
        if (!d.slot) throw new ValidationError([{ path: [_extensible.column, k], message:
          `'${k}' is declared but holds no slot, so there is no index to read it by and no filter that would be honest. ` +
          `It stores and it displays; raising the pool with max: is what makes it filterable` }])
        out[d.slot] = v
      }
    }
    return out
  }

  // An equality operand goes through the field's write transforms. A value the
  // write would have changed can never be stored, so compared raw it matched
  // nothing and said nothing: `Mixed.Case@Example.test` stored lowercased and
  // was never found by the login that typed it back (`FJS-1456`). Runs before
  // the encryption rewrite, the order a write takes. Only equality — trimming
  // a `contains` operand or upper-casing a range bound changes the question.
  function rewriteTransformedWhere(where, transformed = _transformed) {
    if (!where || typeof where !== 'object') return where
    if (Array.isArray(where)) return where.map(w => rewriteTransformedWhere(w, transformed))

    const out = {}
    for (const [key, val] of Object.entries(where)) {
      if (key === 'AND' || key === 'OR' || key === 'NOT') {
        out[key] = rewriteTransformedWhere(val, transformed)
        continue
      }
      const field = transformed.get(key)
      const one   = (v) => v === null || typeof v === 'object' ? v : transformValue(field, v)
      if (!field || val === null) out[key] = val
      else if (Array.isArray(val)) out[key] = val.map(one)
      else if (typeof val !== 'object') out[key] = one(val)
      else {
        const ops = { ...val }
        for (const op of ['equals', 'not']) if (op in ops) ops[op] = one(ops[op])
        for (const op of ['in', 'notIn']) if (Array.isArray(ops[op])) ops[op] = ops[op].map(one)
        out[key] = ops
      }
    }
    return out
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

      // Both matchable modes take the SAME rewrite — encode the operand the way the
      // column was encoded, then compare bytes to bytes. Only the encoder differs,
      // and only equality survives either encoding. `comparisonEncoderFor` is the
      // one owner of that choice; policy.js asks it too.
      const encoder = comparisonEncoderFor(policy)
      const encode  = encoder?.encode ? (v) => encoder.encode(v, ctx.enc.key) : null

      // ── One value, every key on the ring ──────────────────────────────────
      //
      // Deterministic encoding is a function of the KEY, so an operand encoded
      // under the current key does not equal the same value stored under a
      // previous one — and a schema mid-rotation holds both. Encoding under one
      // key made every equality filter over a not-yet-rotated row answer
      // NOTHING, silently, which is the failure `previousEncryptionKeys` would
      // otherwise have created by making that state supported (`FJS-714`).
      //
      // Widened to a set rather than left to the caller: there is no request a
      // caller could make that would find the row, and no error would have been
      // raised to tell them so. With one key on the ring `encodeSet` answers one
      // element and the scalar path is kept, so the common query's SQL is
      // unchanged.
      // The set is ALWAYS widened, not only for a ring of two, and the second
      // reason is the one no test here could see: the payload is byte-identical
      // across envelope versions, so a value stored before the key id existed
      // reads `v1d.<p>` where this encodes `v2d.<kid>.<p>`. Equality compares
      // the whole string, so every deterministic and `@hashed` lookup in every
      // EXISTING database would have answered nothing, silently — and every
      // suite in this repo builds a fresh one.
      const ring      = ctx.enc.ring?.all ?? (ctx.enc.key ? [ctx.enc.key] : [])
      const multiKey  = !!encode
      const encodeSet = (v) => [...new Set(ring.flatMap(k => {
        const now = encoder.encode(v, k)
        const was = legacyForm(now)
        return was ? [now, was] : [now]
      }))]

      if (encode && val !== null && typeof val !== 'object') {
        out[key] = multiKey ? { in: encodeSet(val) } : encode(val)
      } else if (encode && Array.isArray(val)) {
        // The bare-array shorthand is `in`, so it encodes like `in`.
        out[key] = multiKey
          ? { in: val.flatMap(v => v === null ? [null] : encodeSet(v)) }
          : val.map(v => v === null ? null : encode(v))
      } else if (encode && val !== null && typeof val === 'object') {
        // An OPERATOR object. Each spelling of equality has to be encoded on its
        // own — the scalar branch above covers `{ email: x }` and nothing else, so
        // `{ in: [x] }` compared plaintext against stored bytes and answered
        // nothing, and `{ not: x }` answered EVERY row, the excluded one included,
        // because plaintext never equals ciphertext.
        const rewritten = {}
        for (const [op, operand] of Object.entries(val)) {
          const enc = (v) => v === null ? null : encode(v)
          const many = (v) => v === null ? [null] : encodeSet(v)
          if (op === 'equals' || op === 'not') {
            // `equals` widens to `in` and `not` to `notIn` — the same question
            // asked of every key the ring holds.
            if (multiKey) { rewritten[op === 'equals' ? 'in' : 'notIn'] = many(operand) }
            else          { rewritten[op] = enc(operand) }
          } else if (op === 'in' || op === 'notIn') {
            rewritten[op] = Array.isArray(operand)
              ? (multiKey ? operand.flatMap(many) : operand.map(enc))
              : operand
          } else {
            // Deterministic encryption and an HMAC preserve equality and nothing
            // else — no ordering, no substrings. Refuse rather than compare
            // against the stored bytes and answer something plausible.
            throw new ValidationError([{ path: ['where', key], message:
              `'${key}' is ${encoder.label} — it can answer equality (equals, not, in, notIn) and cannot answer '${op}', ` +
              `because neither preserves ordering or substrings` }])
          }
        }
        out[key] = rewritten
      } else if (policy?.encrypted && !policy.encrypted.deterministic && val !== null) {
        // Plain @encrypted field in WHERE — stored ciphertext never equals
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

  // ── The one place a global filter becomes a value ─────────────────────────
  //
  // A STATIC filter is judged at createClient, which refuses one that cannot
  // match any row. A FUNCTION filter is handed `ctx` and has no answer until a
  // query asks it, so it is judged here — the first moment there is something
  // to judge, and the same rule.
  //
  // What it catches is not a filter that returns too few rows. `{ comp: 'A' }`
  // over a @computed field compiles to `WHERE "comp" = ?`, and SQLite resolves
  // an identifier it cannot bind as a string LITERAL: the predicate becomes
  // `'comp' = 'A'`, false for every row, so the model reads as empty for every
  // caller. `{ comp: 'comp' }` becomes `'comp' = 'comp'` and returns EVERY row
  // of it, including rows whose computed value is something else (FJS-215).
  //
  // The check is skipped outright on a model with nothing that can produce the
  // problem, so the ordinary read pays for it once, at construction.
  const _filterCheckKeys = _dynamicGlobalFilter && ctx.models[modelName]
    ? globalFilterKeysFor(ctx.models[modelName], ctx.edgeMap)
    : null

  function resolveGlobalFilter() {
    if (!_dynamicGlobalFilter) return _staticGlobalFilter
    const filter = _dynamicGlobalFilter(ctx)
    if (!filter || !_filterCheckKeys) return filter ?? null
    const [bad] = collectWhereKeyProblems(
      filter, _filterCheckKeys.filterable, _filterCheckKeys.computed, _filterCheckKeys.encrypted,
      [], null, _filterCheckKeys.transient,
    )
    if (bad) throw new ValidationError([{
      path:    ['filters', accessor, bad.key],
      message: globalFilterRefusal(accessor, modelName, bad),
    }])
    return filter
  }

  // Unique/PK columns eligible as an ON CONFLICT target for the upsert fast
  // path. Built lazily — schema is immutable after createClient.
  // The primary key's columns, IN KEY ORDER.
  //
  // `expandCompositeId` stamps `@id` on every member of an `@@id([a, b])`, so
  // asking the fields which one is the key answers all of them and in
  // DECLARATION order, which is not the key's — and the key's order is the one
  // fact `@id` per field cannot carry. The model attribute is where it is
  // stated, so that is what is read, with the single-column case falling back
  // to the field.
  let _keyColsCache = null
  // Declared `Type?`. Read from the model rather than asked of the caller, and
  // memoized because a cursor asks it per field per page.
  let _nullableCache = null
  function _isNullable(col) {
    if (!_nullableCache) {
      _nullableCache = new Set()
      for (const f of ctx.models[modelName]?.fields ?? [])
        if (f.type?.optional) _nullableCache.add(f.name)
    }
    return _nullableCache.has(col)
  }

  function _keyCols() {
    if (_keyColsCache) return _keyColsCache
    const model = ctx.models[modelName]
    const composite = model?.attributes?.find(a => a.kind === 'id')
    if (composite?.fields?.length) return (_keyColsCache = [...composite.fields])
    const single = model?.fields?.find(f => f.attributes.some(a => a.kind === 'id'))
    return (_keyColsCache = single ? [single.name] : [])
  }

  // Columns that identify a row ON THEIR OWN.
  //
  // A member of a composite key is NOT one of them, and treating it as one is
  // silent data loss rather than a wrong answer: with `@@id([userId, teamId])`
  // and `orderBy: { userId }`, three rows paged two at a time served the first
  // two and then answered EMPTY, because the cursor said `userId > 1` and every
  // remaining row shares that userId (`FJS-694`). The tuple is unique; no
  // column of it is.
  let _upsertUniqueColsCache = null
  function _upsertUniqueCols() {
    if (_upsertUniqueColsCache) return _upsertUniqueColsCache
    const s = new Set()
    const keyIsSingle = _keyCols().length === 1
    for (const f of ctx.models[modelName]?.fields ?? []) {
      const isId = f.attributes.some(a => a.kind === 'id')
      if (f.attributes.some(a => a.kind === 'unique') || (isId && keyIsSingle)) s.add(f.name)
    }
    return (_upsertUniqueColsCache = s)
  }

  // ── The cursor's sort keys, and the tiebreaker ──────────────────────────
  // A keyset cursor is a position in a TOTAL order, and an ordering with no
  // unique column is not one: two rows sharing a `createdAt` sit either side
  // of a page boundary and the comparison cannot separate them, so one is
  // served twice and one is never served at all. No error, no gap — the
  // silent-wrong-data class, and the reason the keyset literature calls a
  // unique tiebreaker a correctness requirement rather than a tuning knob.
  //
  // The schema declares which columns are unique, so this is DERIVED rather
  // than asked of the caller: the model's own id is appended, in the last
  // sort key's direction, and nobody writing an application types the word
  // cursor (`FJS-D145`). The order the caller asked for is unchanged — what
  // is added is determinism among rows it left equal.
  //
  // It REFUSES only when there is nothing to append, which is a model with no
  // unique column at all. Paging that by keyset cannot be made correct, and
  // `limit`/`offset` is the honest answer.
  //
  // One owner, because the far side mints the FIRST window's edge off an
  // ordinary page (junction's `find`) and an edge that disagreed with this
  // about the tiebreaker would name a position the next page does not resume
  // from — a scan that skips a row, which is the thing this exists to stop.
  function cursorFields(orderBy) {
    // Before `normalizeOrderBy`, which reads any `near` as a coordinate and
    // refuses this one asking for a lat and a lng. A @vector near-order is a
    // real ordering everywhere else in this client, so the message has to say
    // why THIS read cannot take it: a keyset cursor resumes from a value the
    // row holds, and a distance belongs to the query vector rather than to the
    // row — the next page would have to carry the vector to mean anything, and
    // any change to it would silently renumber the window.
    const vecPlan = vectorOrderPlan(orderBy, _vectorMap)
    if (vecPlan) throw new Error(
      `${modelName}.findManyCursor: orderBy "${vecPlan.field}" is a @vector, and a cursor pages by a value the row ` +
      'holds. A distance belongs to the query vector, not to the row. Page a similarity list with limit/offset.')

    const keyCols = _keyCols()
    // `normalizeOrderBy` defaults to the literal `id`, which it has to — it is
    // a pure function with no model in scope. Here there IS one, and a
    // composite-keyed model has no column called `id`: the default ordering
    // named one that does not exist, so every derived list over such a model
    // was a 400 (`FJS-694`).
    const fields = orderBy
      ? normalizeOrderBy(orderBy)
      : keyCols.map(c => ({ col: c, dir: 'ASC', nulls: 'FIRST' }))

    // Whether the column can hold NULL, read off the model. `buildCursorWhere`
    // needs it because the NULL-aware form costs an `OR` on the comparison, and
    // an `OR` is what stops SQLite using the index the whole keyset scan exists
    // for. A column that cannot be null compiles exactly what it always did.
    for (const f of fields) f.nullable = _isNullable(f.col)

    // A distance key is measured off two GENERATED columns rather than read out
    // of one, so the field carries their names — `buildCursorWhere` is a pure
    // function with no model in scope and the point declaration is here.
    for (const f of fields) {
      if (!f.near) continue
      const pt = _pointMap?.[f.col]
      if (!pt) throw new Error(
        `${modelName}.findManyCursor: orderBy "${f.col}" is not a @point, so it has no distance to page by`)
      const [latName, lngName] = pointColumns(f.col, pt)
      f.latCol = latName
      f.lngCol = lngName
    }

    const uniqueCols = _upsertUniqueCols()
    if (fields.some(f => uniqueCols.has(f.col))) return fields

    // The whole key, or none of it. Appending the first column of a tuple
    // leaves an ordering that is still not total, which is the shape that loses
    // rows in silence.
    const named   = new Set(fields.map(f => f.col))
    const missing = keyCols.filter(c => !named.has(c))
    if (!keyCols.length) throw new Error(
      `${modelName}.findManyCursor: orderBy ${JSON.stringify(orderBy)} is not a total order and ` +
      `this model declares no unique column to break the tie with, so a cursor would serve some ` +
      `rows twice and skip others. Order by a @unique column, or page with limit/offset.`)
    // The appended key columns cannot be null — they are the model's own key —
    // but the position is stated rather than left undefined, because
    // `buildCursorWhere` reads it on every field and a missing one would be
    // read as the ASC default by accident rather than by decision.
    const dir = fields[fields.length - 1]?.dir ?? 'ASC'
    for (const col of missing) fields.push({ col, dir, nulls: dir === 'DESC' ? 'LAST' : 'FIRST' })
    return fields
  }


  // ── @updatedAt — stamped in the STATEMENT, from the client's clock ──────────
  // There is no DDL trigger any more and that is what makes RETURNING sound.
  // SQLite evaluates RETURNING BEFORE an AFTER trigger fires, so while one
  // existed the caller could be handed the value this statement named while the
  // row already held the trigger's (FJS-396) — junction gives that row to the
  // HTTP response AND the `svc updated` broadcast, so every open tab replaced a
  // correct row with a stale one. Naming the column made NEW differ from OLD
  // and stood the trigger down, which closed it for as long as the two values
  // differed — and they are equal whenever the clock has not moved between two
  // writes to one row, which under an injected clock is every write after the
  // first (FJS-531). One writer, no trigger, no window.
  const _stampCols = updatedAtFields(ctx.models[modelName] ?? {}).map(f => f.name)

  // `named` is the list of columns this statement already sets, which is what the
  // trigger's `WHEN NEW.c IS OLD.c` guard means: a write naming the stamp keeps
  // its own value. Write ops (`increment`, `push`) cannot reach a stamp column
  // — extractWriteOps refuses a non-numeric, non-array target — so the columns
  // of the row being written are the whole set.
  function stampSets(named) {
    if (!_stampCols.length) return []
    // A literal rather than a bind: this is appended to seven different SET
    // lists whose parameter arrays are built separately, and a value that is
    // positional in one of them and not the others is the bug this avoids. The
    // text is machine-generated, never caller-supplied — but `now` IS the
    // caller's function, so its answer is escaped rather than trusted.
    const _at = nowISO(ctx.stampClock ?? ctx.now).replace(/'/g, "''")
    return _stampCols.filter(c => !named.includes(c)).map(c => `"${col(c)}" = '${_at}'`)
  }

  // Pre-compute base SELECT — reused by every buildSQL call
  const _baseSql = `SELECT * FROM "${tableName}"`

  // ── @from subquery injection ───────────────────────────────────────────────
  // For each @from field, inject a named correlated subquery into the SELECT list.
  // These are always present — no include needed.
  const _fromEntries  = Object.entries(fromFields)   // [fieldName, { subquerySql, isObject }]
  const _hasFrom      = _fromEntries.length > 0
  const _tableFrom    = fromFields
  // A @from answered again after the read, under the caller's row policy.
  const _hasRowRef    = _fromEntries.some(([, d]) => d.rowRef || d.aggRef)
  // Pre-build fromExprMap for buildWhere — substitutes @from field keys with their subquery SQL.
  // Two maps: a relation orderBy aliases the outer table to `t`, and the
  // correlation inside each subquery has to name whichever one this query used.
  const _fromExprMap  = _hasFrom
    ? Object.fromEntries(_fromEntries.map(([n, {subquerySql}]) => [n, subquerySql]))
    : null
  const _fromExprMapAliased = _hasFrom
    ? Object.fromEntries(_fromEntries.map(([n, {subquerySqlAliased}]) => [n, subquerySqlAliased]))
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
  // ── @point setup ────────────────────────────────────────────────────────────
  // `{ name: { lat, lng } }` for every point on this model, so the where and
  // orderBy builders can name the generated columns the DDL emitted — and, just
  // as importantly, so they can REFUSE every other operator on the field by
  // name rather than comparing its JSON as text.
  const _pointMap = (() => {
    const out = {}
    for (const f of _modelDecl?.fields ?? []) {
      const pt = f.attributes.find(a => a.kind === 'point')
      if (pt) out[f.name] = { lat: pt.lat, lng: pt.lng }
    }
    return Object.keys(out).length ? out : null
  })()

  // `@vector(n)` — the dimension, per field, for `orderBy: { col: { near: v } }`
  // (`FJS-D333`). Same shape as the point map above and for the same reason: the
  // ordering is compiled from the DECLARATION rather than measured off whatever
  // bytes are in hand, because two vectors of different lengths have no
  // comparison and the length of the query vector is the caller's.
  const _vectorMap = (() => {
    const out = {}
    for (const f of _modelDecl?.fields ?? []) {
      const vec = f.attributes.find(a => a.kind === 'vector')
      if (vec) out[f.name] = { dim: vec.dim }
    }
    return Object.keys(out).length ? out : null
  })()


  // `@vector` is out of the default payload (`FJS-D328`), and this is the half
  // that makes the exclusion worth having. `applyFieldPolicyTo` strips it from
  // the row, which is the CONTRACT — but a strip happens after the bytes have
  // been read out of SQLite and copied through `read()`. Measured against the
  // same model with the attribute removed, at 1536 dimensions: 0.118 ms -> 0.032
  // ms for twenty rows, 2.48 ms -> 0.56 ms for a thousand. So `SELECT *` is
  // replaced by the columns that are not vectors.
  //
  // The list is `model.fields.filter(isStoredField)` — `ddl.js`'s own
  // `columnFields`, which is what decides the table's columns, so it cannot
  // name one that is not there or miss a `@generated` one that is.
  const _defaultCols = _vectorMap
    ? (_modelDecl?.fields ?? [])
        .filter(isStoredField)
        .filter(f => !_vectorMap[f.name])
        .map(f => `"${col(f.name)}"`)
    : null

  // `*` for every model that declares no vector, so nothing else in this file
  // changes shape. `withVectors` is how the JS distance path asks for the
  // column it is about to rank by.
  const _starCols = (alias = '', withVectors = false) =>
    !_defaultCols || withVectors
      ? `${alias}*`
      : _defaultCols.map(c => `${alias}${c}`).join(', ')

  // ─── the vector ordering's engine half ──────────────────────────────────
  //
  // `FJS-D331`: the extension is an accelerator a server may install, so this
  // answers null on an engine without it and the ordering refuses BY NAME
  // rather than emitting SQL SQLite has no function for.
  //
  // Arming is per CONNECTION and deliberately not done at open — measured,
  // loading the extension there takes a connection from 0.115 ms to 0.650 ms,
  // and litestone opens one per pristine migration diff, per template clone and
  // per tenant, almost none of which run a similarity query. So the read that
  // needs it arms the handle it is about to use; `arm` is idempotent.
  const _vectorFn = (db) => {
    const cap = currentEngine()?.vector
    if (!cap || !_vectorMap) return null
    const handle = rawHandle(db)
    if (!handle) return null
    cap.arm(handle)
    return cap.cosineDistance
  }

  // The base SELECT with all @from subqueries appended
  const _baseSqlWithFrom = _hasFrom
    ? `SELECT ${_starCols(`"${tableName}".`)}, ${_fromEntries.map(([n, {subquerySql}]) => `${subquerySql} AS "${n}"`).join(', ')} FROM "${tableName}"`
    : (_defaultCols ? `SELECT ${_starCols()} FROM "${tableName}"` : _baseSql)
  // Set of @from field names that return JSON objects (need deserialization)
  const _fromObjectFields = _hasFrom
    ? new Set(_fromEntries.filter(([,{isObject}]) => isObject).map(([n]) => n))
    : null
  const _fromBoolFields = _hasFrom
    ? new Set(_fromEntries.filter(([,{isBool}]) => isBool).map(([n]) => n))
    : null
  // Pre-compute the ultra-common case: findMany({}) on a soft-delete table with no policy/filter
  // Disabled for @@hasTemplates and windowed models — both need an
  // additional predicate on every read (`isTemplate = 0`, and a window against
  // a value that changes between two calls), which combinatorially expands
  // fast-path SQL variants. The slow build-SQL path handles them correctly.
  const _fastFindManySql = (softDelete && !hasTemplates && !effective && !ctx.hasPolicies && !_staticGlobalFilter && !_dynamicGlobalFilter && !plugins?.hasPlugins)
    ? `${_baseSqlWithFrom} WHERE "${col('deletedAt')}" IS NULL`
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
    !hasTemplates &&
    !effective
  )
  const _fastFindUniqueSql = _canFastFindUnique
    ? (softDelete
        ? `SELECT ${_starCols()} FROM "${tableName}" WHERE "${col(_pkField)}" = ? AND "${col('deletedAt')}" IS NULL LIMIT 2`
        : `SELECT ${_starCols()} FROM "${tableName}" WHERE "${col(_pkField)}" = ? LIMIT 2`)
    : null
  // External (@@external) tables may not exist at createClient time — preparing
  // a statement against them throws. Skip the fast path in that case; the
  // regular findUnique path will resolve at query time.
  let _fastFindUniqueStmt = null
  if (_fastFindUniqueSql) {
    try { _fastFindUniqueStmt = readDb.query(_fastFindUniqueSql) }
    catch { _fastFindUniqueStmt = null }
  }

  function buildSQL({ where, orderBy, limit, offset, parsedSelect, sdMode = 'live', htMode = 'instances', effMode = 'inForce', asOf = null, distinct = false, windowSpec = null, withVectors = false } = {}) {
    const params   = []

    // ── Ultra-fast path: no where, no order, no limit, live mode, no policy/filters ──
    if (_fastFindManySql && !withVectors && !where && !orderBy && limit == null && offset == null && sdMode === 'live' && !parsedSelect && !windowSpec && !distinct) {
      return { sql: _fastFindManySql, params }
    }

    // Merge global filter + plugin read filters + query where
    const globalFilter = resolveGlobalFilter()
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
    let exclWhere = applyHtFilter(sdWhere, htMode)
    if (effective) exclWhere = injectEffectiveFilter(exclWhere, effMode, effective, asOf)

    // A similarity ordering carries its own guard. The extension throws on a
    // null operand rather than ranking the row last, so an un-embedded row
    // would fail the whole read instead of losing — `vectorOrderPlan` is the
    // one owner of which field that applies to. ANDed as an ordinary where so
    // it composes with the policy, the soft-delete clause and the caller's own
    // filter rather than being appended to finished SQL.
    const _vecPlan = vectorOrderPlan(orderBy, _vectorMap)
    if (_vecPlan) {
      exclWhere = {
        AND: [
          ...(exclWhere ? [exclWhere] : []),
          { [_vecPlan.field]: { not: null } },
        ],
      }
    }
    // Build relation orderBy first so we know if JOINs will be present.
    // When JOINs are added, column refs in WHERE must be qualified with `t.`
    // to avoid ambiguous column errors (e.g. `id` exists on both joined tables).
    // Two builders see the same orderBy and only one of them is authoritative,
    // so each collects its own params: with JOINs buildRelationOrderBy emits the
    // whole list, without them buildOrderBy emits the flat parts and
    // buildRelationOrderBy contributes only the relation subqueries, which bind
    // nothing. Sharing one array would push a `$raw`'s params twice.
    const _relOrderParams  = []
    const _flatOrderParams = []
    const { joinClauses, orderParts } = buildRelationOrderBy(orderBy, modelName, relationMap, _modelToTable, _relOrderParams, _pointMap, _vectorMap, _vectorFn(readDb), columnMap)
    const hasJoins  = joinClauses.length > 0
    // The table is aliased for a relation AGGREGATE orderBy too, which adds an
    // order part and no join — so the alias question and the join question are
    // not the same question, and a @from correlation in the WHERE has to follow
    // the alias. Column refs still only need qualifying when a join could make
    // them ambiguous, which is `hasJoins`.
    const needsAlias = joinClauses.length > 0 || orderParts.length > 0
    const whereAlias = hasJoins ? 't' : null

    // `FJS-D329`: the ordering puts the number it sorted by on the row, the way
    // `search()` already returns `_rank`. No cutoff option — a cosine threshold
    // is a number every corpus guesses differently, so the app gets the value
    // and decides.
    //
    // The vector is bound twice, here and again in the ORDER BY term, and that
    // is the price of each order builder staying self-contained: `search()`
    // builds its own SELECT and emits the same term through `buildOrderBy`, so
    // ordering by the alias instead would compile to a column that read's SELECT
    // does not have. Six kB bound twice is nothing beside the scan it orders.
    //
    // Pushed into `params` BEFORE the where, because a SELECT expression's
    // placeholder comes first in the statement and these are positional.
    const _vecSqlFn = _vecPlan ? _vectorFn(readDb) : null
    let _distTail = ''
    if (_vecSqlFn) {
      params.push(vectorQueryBytes(_vecPlan.near, _vecPlan.dim, _vecPlan.field))
      _distTail = `, ${_vecSqlFn}(${needsAlias ? 't.' : ''}"${col(_vecPlan.field)}", ?) AS "${DISTANCE_FIELD}"`
    }

    const whereSql  = buildWhereWithEncryption(exclWhere, params, whereAlias, needsAlias)
    // When JOINs exist, buildRelationOrderBy returns the full ordered list
    // (flat + relation, flat prefixed with `t.`). Don't double-emit flat parts.
    const flatOrderSql = hasJoins ? '' : buildOrderBy(orderBy, _flatOrderParams, columnMap, _pointMap, _vectorMap, _vectorFn(readDb))
    const orderSql = [flatOrderSql, ...orderParts].filter(Boolean).join(', ')
    const orderParams = hasJoins ? _relOrderParams : _flatOrderParams
    const sqlCols   = parsedSelect?.sqlCols ?? '*'
    const distinctKw = distinct ? 'DISTINCT ' : ''
    // A @from subquery correlates to the outer table by name, so an aliased
    // query needs the aliased variant. Emitting the plain one under `t` fails
    // as `no such column: <table>.<pk>`; emitting neither — which is what
    // `SELECT t.*` did — dropped every @from field to undefined, and any
    // @computed field reading one then computed from undefined in silence.
    const fromExpr = n => needsAlias ? fromFields[n].subquerySqlAliased : fromFields[n].subquerySql
    let basePart
    if (sqlCols === '*') {
      const allFromCols = needsAlias && _hasFrom
        ? _fromEntries.map(([n]) => `${fromExpr(n)} AS "${n}"`).join(', ')
        : null
      basePart = needsAlias
        ? `SELECT ${distinctKw}${_starCols('t.', withVectors)}${allFromCols ? `, ${allFromCols}` : ''}${_distTail} FROM "${tableName}" t`
        : (distinct || _distTail || withVectors
            ? `SELECT ${distinctKw}${_starCols('', withVectors)}${_hasFrom ? `, ${_fromEntries.map(([n, { subquerySql }]) => `${subquerySql} AS "${n}"`).join(', ')}` : ''}${_distTail} FROM "${tableName}"`
            : _baseSqlWithFrom)
    } else {
      const fromCols = parsedSelect?.requestedFrom?.size
        ? [...parsedSelect.requestedFrom].map(n => `${fromExpr(n)} AS "${n}"`).join(', ')
        : null
      const selectExpr = fromCols ? `${sqlCols}, ${fromCols}` : sqlCols
      basePart = needsAlias
        ? `SELECT ${distinctKw}${selectExpr}${_distTail} FROM "${tableName}" t`
        : `SELECT ${distinctKw}${fromCols ? selectExpr : sqlCols}${_distTail} FROM "${tableName}"`
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
    // After the policy's params, because the policy is ANDed into the WHERE and
    // ORDER BY comes after it in the statement.
    if (orderSql)       { sql += ` ORDER BY ${orderSql}`; params.push(...orderParams) }
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

  // Pre-build the @from map for this table — passed to parseSelectArg, which
  // reads the defs and not only the names.
  const _fromSets = _hasFrom ? { [modelName]: new Map(Object.entries(fromFields)) } : null

  function parseArgs(select, include) {
    return parseSelectArg(select, modelName, relationMap, computedSets, include, _fromSets, computedFns, columnMap)
  }

  function withIncludes(rows, ps, rawInclude) {
    const include = ps ? { ...ps.relationSelects } : rawInclude
    if (include && Object.keys(include).length)
      resolveIncludes(readDb, rows, include, modelName, ctx)
    return rows
  }

  function finalize(rows, ps) {
    return ps ? trimAllToSelect(rows, ps.requestedFields, ps.injectedFKs) : rows
  }
  function finalizeOne(row, ps) {
    if (!ps || !row) return row
    return Object.fromEntries(
      Object.entries(row).filter(([k]) => ps.requestedFields.has(k) && !ps.injectedFKs.has(k))
    )
  }

  // Soft-delete mode from args.
  //
  // `onlyDeleted` on a model that declares no @@softDelete is REFUSED, not
  // dropped: it means *the deleted ones and nothing else*, and answering the
  // live rows is the opposite of what was asked, with nothing anywhere saying
  // the flag did not apply (FJS-293).
  //
  // `withDeleted` is the asymmetry, and it is deliberate. It asks to WIDEN, and
  // on a model that hides nothing the full row set already IS everything — so
  // the answer is right rather than accidentally right, and generic code that
  // does not know the model (Studio's row browser, an admin screen with a *show
  // deleted* toggle) is not writing a mistake. Only the flag that cannot be
  // satisfied refuses.
  function sdMode(args) {
    if (!softDelete) {
      if (args?.onlyDeleted) throw new CapabilityNotDeclaredError(modelName, 'onlyDeleted', '@@softDelete',
        'Every row here is live, so there is no deleted-only view to ask for.')
      return 'live'
    }
    if (args?.withDeleted) return 'withDeleted'
    if (args?.onlyDeleted) return 'onlyDeleted'
    return 'live'
  }

  // @@hasTemplates mode from args. Same shape as sdMode, same asymmetry.
  function htMode(args) {
    if (!hasTemplates) {
      if (args?.onlyTemplates) throw new CapabilityNotDeclaredError(modelName, 'onlyTemplates', '@@hasTemplates',
        'This model has no template rows, so there is no template-only view to ask for.')
      return 'instances'
    }
    if (args?.withTemplates) return 'withTemplates'
    if (args?.onlyTemplates) return 'onlyTemplates'
    return 'instances'
  }

  // The window's mode from args. Same shape as the two above, same asymmetry —
  // and `asOf` sits on the WIDENING side of it with `withExpired`, deliberately.
  // It re-points a window rather than asking for rows a model does not have, so
  // on a model that declares none the full row set already IS every row in
  // force at every instant; refusing it would break exactly the generic caller
  // the asymmetry exists to protect — a row browser with an *as at* control,
  // which cannot know which of twenty models has a window.
  //
  // An ASKED window (`@@effective`) filters only when `asOf` is stated — with
  // nothing stated every row comes back, which is the pointer and the history
  // read working (`FJS-D352`). `onlyExpired` on one still needs a moment to be
  // out of force AT, and it has none of its own to supply.
  function effMode(args) {
    if (!effective) {
      if (args?.onlyExpired) throw new CapabilityNotDeclaredError(modelName, 'onlyExpired', '@@expires or @@effective',
        'Every row here counts at every instant, so there is no out-of-window view to ask for.')
      return 'inForce'
    }
    if (args?.withExpired) return 'withExpired'
    if (!effective.imposed && args?.asOf == null) {
      if (args?.onlyExpired) throw new ValidationError([{ path: ['onlyExpired'], message:
        `onlyExpired on ${modelName} needs asOf — its @@effective window is asked rather than imposed, ` +
        `so there is no moment to be out of force at until the read states one` }])
      return 'withExpired'
    }
    if (args?.onlyExpired) return 'onlyExpired'
    return 'inForce'
  }

  // What the window is read AT. Unstated is the client's own clock, which is
  // what makes expiry testable at all: `createTestEnv`'s `clock.advance()`
  // moves this, where a `new Date()` written into a service moves nothing.
  //
  // A day window reads a DAY, and the reading is UTC. That is the honest
  // default rather than the right one — *today* is a day derived from an
  // instant and therefore owes a zone (`FJS-D143`), which this declaration does
  // not yet carry. Only an `@@expires` over days reaches the default at all: an
  // `@@effective` window with nothing stated is not filtered.
  const DAY = /^\d{4}-\d{2}-\d{2}$/
  function effAsOf(args) {
    const stated = args?.asOf
    if (stated == null) {
      const iso = nowISO(ctx.now)
      return effective?.kind === 'day' ? iso.slice(0, 10) : iso
    }
    // A write does not take a window to read at. `withExpired` is how a write
    // reaches a row outside the window — the same escape `update({ withDeleted:
    // true })` already is — while a write made *as the world stood* at a past
    // instant is bitemporality, which this declaration does not carry and must
    // not ship by accident as a directive default.
    const value = stated instanceof Date ? stated.toISOString() : String(stated)
    if (effective?.kind === 'day') {
      if (!DAY.test(value)) throw new ValidationError([{ path: ['asOf'], message:
        `asOf must be a plain date (YYYY-MM-DD) on ${modelName} — its window is over days, not instants. Got '${value}'` }])
      return value
    }
    if (Number.isNaN(Date.parse(value))) throw new ValidationError([{ path: ['asOf'], message:
      `asOf must be an instant on ${modelName} — an ISO date-time. Got '${value}'` }])
    return value
  }

  // The window's half of the compose. Asked on EVERY read for `applySdFilter`'s
  // reason: guarding the call with `effective ? … : where` is what lets a flag
  // this model cannot honor through without a word.
  function applyEffFilter(where, args) {
    const mode = effMode(args)
    if (!effective) return where
    return injectEffectiveFilter(where, mode, effective, effAsOf(args))
  }

  // The same step where the modes were resolved earlier and `args` is no longer
  // the thing in hand. Both exist for `applySdFilter`'s reason — the call is
  // made on every read, including on models that declare no window, so a flag
  // this model cannot honor is refused rather than passing through in silence.
  function applyEff(where, mode, asOf) {
    if (!effective) return where
    return injectEffectiveFilter(where, mode, effective, asOf)
  }

  // Compose: apply hasTemplates filter on top of soft-delete-filtered where.
  // Both filters AND together at the WHERE level — orthogonal concerns.
  // `recursive` is a findMany shape. A method that cannot walk a tree has to
  // say so: count({ recursive }) counted the ANCHORS and answered a plausible
  // number for a question nobody asked.
  function refuseRecursive(op, args) {
    if (args?.recursive)
      throw new ValidationError([{ path: ['recursive'], message:
        `${op}() does not take 'recursive' — only findMany walks a tree. Read the length of the findMany({ recursive }) result, or pass on the ids it gives you` }])
  }

  // A row that is its own ancestor has no root for a tree read to start from,
  // and the walk only survives it because of the depth ceiling. Refusing the
  // write that closes the loop is both cheaper than carrying it on every read
  // and the only place that can name the field that was wrong.
  function assertNoParentCycle(rowIds, data) {
    const rels = ctx.selfRelationMap?.[modelName]
    if (!rels?.length || !data) return
    for (const rel of rels) {
      if (!(rel.fkField in data)) continue
      const parentId = data[rel.fkField]
      if (parentId == null) continue
      const up = (id) => readDb.query(`SELECT "${rel.fkField}" AS p FROM "${tableName}" WHERE "${rel.referencedField}" = ?`).get(id)?.p ?? null
      for (const rowId of rowIds) {
        if (rowId == null) continue
        if (rowId === parentId)
          throw new ValidationError([{ path: [rel.fkField], message:
            `${rel.fkField} points at the row itself — a row cannot be its own ${rel.relationField}` }])
        const seen = new Set([parentId])
        let cur = up(parentId)
        while (cur != null && !seen.has(cur)) {
          if (cur === rowId)
            throw new ValidationError([{ path: [rel.fkField], message:
              `${rel.fkField} would make "${rowId}" its own ancestor — the ${rel.relationField} chain above ${parentId} already passes through it` }])
          seen.add(cur)
          cur = up(cur)
        }
      }
    }
  }

  function applyHtFilter(where, mode) {
    if (!hasTemplates) return where
    return injectHasTemplatesFilter(where, mode, hasTemplatesField)
  }

  // The soft-delete half of the same pair. It exists so that sdMode is asked on
  // EVERY read, not only on the models that can answer it: guarding the call
  // with `softDelete ? … : where` is what let a flag this model cannot honor
  // through without a word.
  function applySdFilter(where, args) {
    const mode = sdMode(args)
    if (!softDelete) return where
    return injectSoftDeleteFilter(where, mode)
  }

  // ── What a HARD delete narrows by ─────────────────────────────────────────
  //
  // The two exclusions are not the same kind of thing, and this is the one
  // place they part company.
  //
  // Soft delete: `delete` is the purge hatch and bypasses the `deletedAt`
  // filter by design — that is its stated contract, and the reason it exists
  // beside `remove`. A FLAG still narrows it, so `deleteMany({ onlyDeleted:
  // true })` purges exactly the rows already soft-deleted, which is the thing
  // people were writing raw SQL for.
  //
  // Templates: the filter applies, like every other statement. A template is a
  // live row in a parallel category, not an end state — so `deleteMany({ where:
  // { cost: { lt: 5 } } })` destroying template rows that no read of the model
  // can see is data loss the caller has no way to anticipate (FJS-176). Opt in
  // with `withTemplates` / `onlyTemplates`, the same words the reads take.
  //
  // The window: an `@@expires` filter applies, with templates rather than with
  // soft delete. **There is no verb pair to honor** — soft delete's bypass is
  // the contract of `delete` AGAINST `remove`, and `@@expires` declares no
  // verb, so a bypass here would mean nothing in particular. A sweep that wants
  // the dead rows says `onlyExpired`, which is the intent it was spelling by
  // hand with a cutoff anyway. An `@@effective` window reaches a delete the way
  // it reaches a read: only when `asOf` is stated.
  function _hardDeleteWhere({ where, withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf }) {
    const sdFlagMode = sdMode({ withDeleted, onlyDeleted })
    const sdW = sdFlagMode === 'live' ? where : injectSoftDeleteFilter(where, sdFlagMode)
    const htW = applyHtFilter(sdW, htMode({ withTemplates, onlyTemplates }))
    // `asOf` rides with the flags, or a sweep that states an instant deletes at
    // `now` instead and matches nothing — which is silent, because a delete
    // that removed no rows answers a count rather than an error.
    return applyEffFilter(htW, { withExpired, onlyExpired, asOf })
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

  // `hasNested` is a BOOLEAN and not something a caller derives, because `nested`
  // is an object and `nested.length` is `undefined` rather than an error — which
  // is falsy, so three guards spelled that way all read *there are no nested
  // writes* and all three were wrong. It cost a create with `select: false`
  // every one of its children, silently (`FJS-615`).
  function extractNestedWrites(data) {
    if (!data) return { scalar: {}, nested: {}, hasNested: false }
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
    return { scalar, nested, hasNested: Object.keys(nested).length > 0 }
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
        // The same answer the foreign key itself gets, hidden or missing.
        if (!target) {
          const byKey = Object.keys(ops.connect).length === 1 && rel.referencedKey in ops.connect
          throw parentRefusal(fieldName, [rel.foreignKey], [byKey ? ops.connect[rel.referencedKey] : ops.connect], rel.targetModel)
        }
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
        const tpk = rel.targetPk ?? 'id'   // the target's @id COLUMN, not the word "id"

        // A join row is written with INSERT OR IGNORE so connecting twice is
        // idempotent — which also means a NULL key is ignored rather than
        // refused. Reading the target's key by the literal name `id` therefore
        // produced a connect that reported success and wrote nothing on any
        // model keyed by something else. Refuse the undefined instead.
        const keyOf = (row) => {
          const v = row?.[tpk]
          if (v == null)
            throw new Error(`m2m on "${fieldName}": "${rel.targetModel}" row has no "${tpk}" to join on`)
          return v
        }

        if (ops.create) {
          const rows = Array.isArray(ops.create) ? ops.create : [ops.create]
          for (const row of rows) {
            const created = await tbl.create({ data: applyCoFk(rel.targetModel, row) })
            writeDb.run(`INSERT OR IGNORE INTO "${jt}" ("${sk}", "${tk}") VALUES (?, ?)`, parentPk, keyOf(created))
          }
        }
        if (ops.connect) {
          const wheres = Array.isArray(ops.connect) ? ops.connect : [ops.connect]
          for (const where of wheres) {
            const target = await tbl.findFirst({ where })
            if (!target) throw new Error(`m2m connect on "${fieldName}": no "${rel.targetModel}" found`)
            writeDb.run(`INSERT OR IGNORE INTO "${jt}" ("${sk}", "${tk}") VALUES (?, ?)`, parentPk, keyOf(target))
          }
        }
        if (ops.disconnect) {
          const wheres = Array.isArray(ops.disconnect) ? ops.disconnect : [ops.disconnect]
          for (const where of wheres) {
            const target = await tbl.findFirst({ where })
            if (!target) continue
            writeDb.run(`DELETE FROM "${jt}" WHERE "${sk}" = ? AND "${tk}" = ?`, parentPk, keyOf(target))
          }
        }
        if (ops.delete) {
          const wheres = Array.isArray(ops.delete) ? ops.delete : [ops.delete]
          for (const where of wheres) {
            const target = await tbl.findFirst({ where })
            if (!target) continue
            writeDb.run(`DELETE FROM "${jt}" WHERE "${sk}" = ? AND "${tk}" = ?`, parentPk, keyOf(target))
            await tbl.delete({ where: { [tpk]: keyOf(target) } })
          }
        }
        if (ops.set) {
          // Replace entire relation — DELETE all join rows, INSERT new ones
          writeDb.run(`DELETE FROM "${jt}" WHERE "${sk}" = ?`, parentPk)
          const wheres = Array.isArray(ops.set) ? ops.set : [ops.set]
          for (const where of wheres) {
            const target = await tbl.findFirst({ where })
            if (!target) throw new Error(`m2m set on "${fieldName}": no "${rel.targetModel}" found matching ${JSON.stringify(where)}`)
            writeDb.run(`INSERT OR IGNORE INTO "${jt}" ("${sk}", "${tk}") VALUES (?, ?)`, parentPk, keyOf(target))
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

  // installHooks wraps this object — see its header. Hooks are the OUTERMOST
  // layer: a before hook sees the arguments as the caller wrote them, ahead of
  // the plugin door and of any stamping this file does.
  return installHooks({

    // ── findMany ────────────────────────────────────────────────────────────
    async findMany(args = {}) {
      // ── Recursive CTE path ───────────────────────────────────────────────
      // A tree read is a read: the plugin door, the row policy and the
      // soft-delete filter all apply, and they apply at every level. The walk
      // carries the same visibility predicate as the anchor, so a row the
      // caller cannot see hides its whole subtree — the alternative hands back
      // the children of a row the caller was refused. The CTE resolves ids
      // only and the rows come back through findMany, so select / include /
      // @computed / @from keep one owner instead of a second copy here.
      if (args.recursive) {
        if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)

        const rec = args.recursive === true
          ? { direction: 'descendants' }
          : { direction: 'descendants', ...args.recursive }

        const selfRels = ctx.selfRelationMap?.[modelName]
        if (!selfRels?.length)
          throw new Error(`findMany({ recursive }) — model '${tableName}' has no self-referential relation`)

        // The CTE names four columns of its own; a model column of the same
        // name would resolve to the CTE inside the walk and answer nonsense.
        const reserved = ['_id', '_pid', '_depth', '_path']
        for (const f of ctx.models[modelName]?.fields ?? [])
          if (reserved.includes(f.name))
            throw new Error(`findMany({ recursive }) — '${tableName}' declares a field named '${f.name}', which the tree query uses for itself`)

        let relsToUse = selfRels
        if (rec.via) {
          const found = selfRels.find(r => r.relationField === rec.via || r.fkField === rec.via)
          if (!found) throw new Error(`findMany({ recursive }) — 'via: "${rec.via}"' not found on model '${tableName}'`)
          relsToUse = [found]
        }
        if (rec.nested && (args.limit != null || args.offset != null))
          throw new ValidationError([{ path: ['recursive'], message:
            `recursive: { nested: true } cannot take limit or offset — they would cut branches out of the tree. Use maxDepth, or take the flat result and page that` }])

        const multiRel = relsToUse.length > 1
        const mode     = sdMode(args)
        const htm      = htMode(args)
        const em       = effMode(args)
        const asOf     = effective ? effAsOf(args) : null
        const maxDepth = rec.maxDepth ?? 1000

        // Built once, bound at every level it appears in: the anchor SELECT and
        // each step of the walk.
        const visParams = []
        const visWhere  = applyEff(applyHtFilter(softDelete ? injectSoftDeleteFilter(null, mode) : null, htm), em, asOf)
        let   visSql    = visWhere ? buildWhereWithEncryption(visWhere, visParams) : null
        const readPolicy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'read', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
        if (readPolicy) {
          visSql = visSql ? `(${visSql}) AND (${readPolicy.sql})` : readPolicy.sql
          visParams.push(...readPolicy.params)
        }

        const idField = relsToUse[0].referencedField
        const found   = new Map()   // id → { depth, via }

        for (const rel of relsToUse) {
          const { fkField, referencedField } = rel

          const anchorParams = []
          const anchorSql    = args.where ? buildWhereWithEncryption(args.where, anchorParams) : null
          let   anchorFilter = anchorSql ?? ''
          if (visSql) {
            anchorFilter = anchorFilter ? `(${anchorFilter}) AND (${visSql})` : visSql
            anchorParams.push(...visParams)
          }

          // SQLite has no CYCLE clause. The GROUP BY below already dedupes the
          // ANSWER, so _path is about the walk: without it a stored cycle is
          // ended only by the depth ceiling, so a two-row loop scans maxDepth
          // rows — 1000 by default, and whatever a caller raised it to.
          const step = rec.direction === 'ancestors'
            ? `"${tableName}"."${referencedField}" = _t._pid`
            : `"${tableName}"."${fkField}" = _t._id`

          const cteSql = `
WITH RECURSIVE _t(_id, _pid, _depth, _path) AS (
  SELECT "${referencedField}", "${fkField}", 0, ',' || "${referencedField}" || ','
  FROM "${tableName}"${anchorFilter ? `\n  WHERE ${anchorFilter}` : ''}
  UNION ALL
  SELECT "${tableName}"."${referencedField}", "${tableName}"."${fkField}", _t._depth + 1,
         _t._path || "${tableName}"."${referencedField}" || ','
  FROM "${tableName}" JOIN _t ON ${step}
  WHERE _t._depth < ${Number(maxDepth)}
    AND instr(_t._path, ',' || "${tableName}"."${referencedField}" || ',') = 0${visSql ? `\n    AND (${visSql})` : ''}
)
SELECT _id, MIN(_depth) AS _depth FROM _t GROUP BY _id`.trim()

          const cteParams = visSql ? [...anchorParams, ...visParams] : anchorParams
          const _nt  = needsTiming()
          const _t0  = _nt ? performance.now() : 0
          const hits = readDb.query(cteSql).all(...cteParams)
          if (_nt) fireQuery({ operation: 'findMany', args, sql: cteSql, params: cteParams, duration: performance.now() - _t0, rowCount: hits.length })

          for (const h of hits) {
            const prev = found.get(h._id)
            if (!prev || h._depth < prev.depth) found.set(h._id, { depth: h._depth, via: rel.fkField })
          }
        }

        // Depth 0 is the anchor itself. It is not part of its own subtree, and
        // it is only fetched at all so `nested` can tell a root from a child.
        const wanted = [...found.entries()].filter(([, v]) => rec.nested || v.depth > 0).map(([id]) => id)
        if (!wanted.length) return []

        const obList      = args.orderBy ? (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) : []
        const byDepth     = obList.some(o => '_depth' in o)
        const obColumns   = obList.map(o => { const c = { ...o }; delete c._depth; return c }).filter(o => Object.keys(o).length)

        // The rows themselves come back through the ordinary read, which is
        // what applies the gate, the select, the includes and the derived fields.
        let rows = await this.findMany({
          ...args,
          recursive: undefined,
          where:     { [idField]: { in: wanted } },
          orderBy:   byDepth ? undefined : (obColumns.length ? obColumns : undefined),
          limit:     byDepth || rec.nested ? undefined : args.limit,
          offset:    byDepth || rec.nested ? undefined : args.offset,
        })

        for (const row of rows) {
          const hit = found.get(row[idField])
          row._depth = hit?.depth ?? 0
          if (multiRel) row._via = hit?.via
        }

        if (byDepth) {
          rows = [...rows].sort((a, b) => {
            for (const o of obList) {
              for (const [k, v] of Object.entries(o)) {
                const av = k === '_depth' ? a._depth : a[k]
                const bv = k === '_depth' ? b._depth : b[k]
                if (av === bv) continue
                const dir = (typeof v === 'object' ? v?.dir : v) === 'desc' ? -1 : 1
                return (av > bv ? 1 : -1) * dir
              }
            }
            return 0
          })
          if (!rec.nested) {
            const from = args.offset ?? 0
            rows = rows.slice(from, args.limit != null ? from + args.limit : undefined)
          }
        }

        if (!rec.nested) return rows

        // Nested — the anchor is the frame, not a node, so its children are the
        // roots and it does not appear in the result.
        const byId  = new Map(rows.map(r => [r[idField], Object.assign(r, { children: [] })]))
        const fkKey = relsToUse[0].fkField
        const roots = []
        for (const node of byId.values()) {
          if (node._depth === 0) continue
          const parent = byId.get(node[fkKey])
          if (parent && parent._depth > 0) parent.children.push(node)
          else roots.push(node)
        }
        return roots
      }

      // ── Inline fast path: findMany() / findMany({}) with no plugins/hooks/logging ──
      // Skipped inside a transaction: this statement was prepared against the
      // READ connection at table-build time, so it cannot see uncommitted writes.
      // The normal path goes through readDb.query(), which routes to the write
      // connection while a transaction is open.
      if (_fastStmt && !_inTx() && !args.where && !args.orderBy && !args.limit && !args.offset && !args.select && !args.include && !args.withDeleted && !args.onlyDeleted && !args.window && !args.distinct && !plugins?.hasPlugins && !tableHasLogWork) {
        const _needsTiming = ctx.onQuery || ctx._queryListeners.size
        const _t0 = _needsTiming ? performance.now() : 0
        const rows = readAll(_fastStmt.all(), { mode: 'list' })
        if (_needsTiming) fireQuery({ operation: 'findMany', args, sql: _fastFindManySql, params: [], duration: performance.now() - _t0, rowCount: rows.length })
        return rows
      }
      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
      const { where, include, orderBy, limit, offset, select, distinct, scopedBy } = args
      _scopedByForBuild = scopedBy ?? null
      const windowSpec      = args.window ?? null
      const mode            = sdMode(args)
      const htm             = htMode(args)
      const em              = effMode(args)
      const asOf            = effective ? effAsOf(args) : null
      const ps              = parseArgs(select, include)
      const psLog           = logReadParse(select, include, ps, distinct)

      // ── the similarity ordering's two halves (`FJS-D331`) ────────────────
      //
      // The comparison has two implementations and the extension is the
      // optional one. A server that installed `sqlite-vec` compiles the
      // ordering into the statement; everything else scores here. That is not a
      // fallback: SQLite's own wasm build carries `SQLITE_OMIT_LOAD_EXTENSION`,
      // so the browser engine cannot load an extension at any version and the
      // JS path is its only answer.
      //
      // What moves to JavaScript is the ORDER and therefore the PAGE. `limit`
      // and `offset` cannot travel in the statement, because SQLite is ranking
      // nothing and `LIMIT 10` would take the first ten rows it happened to
      // read. So the scan is the whole filtered set — which is why the record
      // calls the caller's `where` the prune rather than an optimization, and
      // why a gate or a row policy in front of this read PAYS for itself:
      // measured, a quarter of the rows ran 2.3x faster in Chrome.
      const _vecPlan = vectorOrderPlan(orderBy, _vectorMap)
      const _jsVec   = _vecPlan && !_vectorFn(readDb) ? _vecPlan : null

      let sql, params, rawRows
      if (_jsVec) {
        // Graded before the scan and by the SQL path's own function, so a wrong
        // dimension, a zero vector and a NaN are refused in the same sentence
        // on both engines rather than in whatever words each half reached for.
        vectorQueryBytes(_jsVec.near, _jsVec.dim, _jsVec.field)

        // The column being ranked has to be IN the row, and `@vector` is out of
        // the default payload (`FJS-D328`) — so the SCAN's select is widened
        // and `read()` is still handed the caller's own, which strips the
        // column again unless they asked for it.
        const psScan = select ? parseArgs({ ...select, ...(psLog !== ps && { [idField]: true }), [_jsVec.field]: true }, include) : ps

        // The same guard the compiled path ANDs on, stated here because the
        // ordering it is derived from has been taken out of this query.
        const scanWhere = { AND: [...(where ? [where] : []), { [_jsVec.field]: { not: null } }] }

        ;({ sql, params } = buildSQL({
          where: scanWhere, orderBy: orderByAfterVector(orderBy, _jsVec.field),
          parsedSelect: psScan, sdMode: mode, htMode: htm, effMode: em, asOf, distinct: distinct === true, windowSpec,
          withVectors: true,
        }))
        rawRows = scoreByDistance(readDb.query(sql).all(...params), _jsVec.near, {
          column: col(_jsVec.field), dim: _jsVec.dim, dir: _jsVec.dir,
          take: limit  == null ? Infinity : Number(limit),
          skip: offset == null ? 0        : Number(offset),
        })
      } else {
        ;({ sql, params } = buildSQL({ where, orderBy, limit, offset, parsedSelect: psLog, sdMode: mode, htMode: htm, effMode: em, asOf, distinct: distinct === true, windowSpec }))
        rawRows = readDb.query(sql).all(...params)
      }

      // Carried across `finalize`, which trims to the caller's `select` and
      // would drop a name that is not a field. Both paths produce it — the
      // compiled one as a SELECT alias, this one from `scoreByDistance` — and
      // it is positional because every step from here maps one row to one row.
      const _dists = _vecPlan ? rawRows.map(r => r[DISTANCE_FIELD]) : null

      const _nt = needsTiming()
      const _fmT0 = _nt ? performance.now() : 0
      let rows              = readAll(rawRows, { mode: 'list', selectedFields: psLog?.requestedFields })
      if (_nt) fireQuery({ operation: 'findMany', args, sql, params, duration: _nt ? performance.now() - _fmT0 : 0, rowCount: rows.length })
      const _logIds = psLog !== ps ? extractIds(rows) : null
      withIncludes(rows, ps, include)
      rows = finalize(rows, ps)
      if (_dists) for (let i = 0; i < rows.length; i++) rows[i][DISTANCE_FIELD] = _dists[i]
      attachFlatEdges(rows, scopedBy)
      if (plugins?.hasPlugins) await plugins.afterRead(modelName, rows, ctx, { select })
      if (tableHasLogWork && rows.length > 0) emitLogs('read', rows, { ids: _logIds })
      return rows
    },

    // ── findFirst ───────────────────────────────────────────────────────────
    async findFirst(args = {}) {
      refuseRecursive('findFirst', args)
      // Ranked in JavaScript, the whole candidate set is scored before the
      // first row is known, so a `LIMIT 1` in the statement would hand back
      // whichever row SQLite happened to read first. `findMany` owns that path
      // and runs the plugin door itself.
      if (vectorOrderPlan(args.orderBy, _vectorMap) && !_vectorFn(readDb))
        return (await this.findMany({ ...args, limit: 1 }))[0] ?? null
      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
      const { where, include, orderBy, select, scopedBy } = args
      _scopedByForBuild = scopedBy ?? null
      const mode            = sdMode(args)
      const htm             = htMode(args)
      const em              = effMode(args)
      const asOf            = effective ? effAsOf(args) : null
      const ps              = parseArgs(select, include)
      const psLog           = logReadParse(select, include, ps)
      const { sql, params } = buildSQL({ where, orderBy, limit: 1, parsedSelect: psLog, sdMode: mode, htMode: htm, effMode: em, asOf })
      const _nt = needsTiming()
      const _ffT0 = _nt ? performance.now() : 0
      const _raw            = readDb.query(sql).get(...params)
      const _dist           = _raw ? _raw[DISTANCE_FIELD] : undefined
      let row               = read(_raw, { mode: 'list', selectedFields: psLog?.requestedFields })
      const _logIds         = psLog !== ps && row ? extractIds([row]) : null
      if (_nt) fireQuery({ operation: 'findFirst', args, sql, params, duration: _nt ? performance.now() - _ffT0 : 0, rowCount: row ? 1 : 0 })
      if (row) {
        withIncludes([row], ps, include); row = finalizeOne(row, ps); attachFlatEdges([row], scopedBy)
        // `finalize` trims to the caller's select, which knows no field of this
        // name — same restamp findMany makes, and for the same reason.
        if (_dist !== undefined) row[DISTANCE_FIELD] = _dist
      }
      else row = null
      if (plugins?.hasPlugins && row) await plugins.afterRead(modelName, [row], ctx, { select })
      // ── Logging ──────────────────────────────────────────────────────────────
      if (tableHasLogWork && row) emitLogs('read', [row], { ids: _logIds })
      return row
    },

    // ── findUnique ──────────────────────────────────────────────────────────
    async findUnique(args = {}) {
      refuseRecursive('findUnique', args)
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
              // The plugin hooks are not skipped here — `_canFastFindUnique`
              // requires there to be none. The LOG is a separate question: a
              // table can declare `@@log` with no plugin installed anywhere.
              if (tableHasLogWork && rows[0]) emitLogs('read', [rows[0]])
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
      const em              = effMode(args)
      const asOf            = effective ? effAsOf(args) : null
      const ps              = parseArgs(select, include)
      const psLog           = logReadParse(select, include, ps)
      const { sql, params } = buildSQL({ where, limit: 2, parsedSelect: psLog, sdMode: mode, htMode: htm, effMode: em, asOf })
      const _nt = needsTiming()
      const _fuT0 = _nt ? performance.now() : 0
      const rows            = readAll(readDb.query(sql).all(...params), { mode: 'single', selectedFields: psLog?.requestedFields })
      const _logIds         = psLog !== ps ? extractIds(rows) : null
      if (_nt) fireQuery({ operation: 'findUnique', args, sql, params, duration: _nt ? performance.now() - _fuT0 : 0, rowCount: rows.length })
      if (rows.length > 1) throw new Error(`findUnique on "${tableName}" returned more than one row`)
      let row = rows[0] ?? null
      if (row) { withIncludes([row], ps, include); row = finalizeOne(row, ps); attachFlatEdges([row], scopedBy) }
      // The same tail `findFirst`, `findMany` and `findManyAndCount` all have,
      // and it had never been here. Two consequences, both silent:
      //
      //   · every plugin's read hook was skipped for the single most common
      //     read an app makes. `ExternalRefPlugin` resolves a stored ref into a
      //     public URL in `onAfterRead`, so a `File` column came back as its raw
      //     `{"key":…,"provider":…}` from `get(id)` and as a URL from the same
      //     column read by `find` — an `<img src>` that works in a list and is
      //     broken on the detail screen beside it, and an edit form handed the
      //     storage handle instead of the photograph (`FJS-541`).
      //   · a `@@log` model recorded reads through every path but this one.
      //
      // `beforeRead` above was already here, which is what made the gap look
      // like plugin support rather than half of it.
      if (plugins?.hasPlugins && row) await plugins.afterRead(modelName, [row], ctx, { select })
      if (tableHasLogWork && row) emitLogs('read', [row], { ids: _logIds })
      return row
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
      refuseRecursive('count', args)
      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
      const { where, scopedBy } = args
      _scopedByForBuild = scopedBy ?? null
      const mode      = sdMode(args)
      const htm       = htMode(args)
      const em        = effMode(args)
      const asOf      = effective ? effAsOf(args) : null
      const params    = []
      // Merge global filter + plugin read filters + policy filter (same as buildSQL does)
      const globalFilter = resolveGlobalFilter()
      const pluginFilters = plugins?.hasPlugins ? plugins.getReadFilters(modelName, ctx) : []
      const allFilters   = [globalFilter, ...pluginFilters].filter(Boolean)
      const mergedWhere  = allFilters.length
        ? (where ? { AND: [...allFilters, where] } : allFilters.length === 1 ? allFilters[0] : { AND: allFilters })
        : where
      const sdWhere       = softDelete ? injectSoftDeleteFilter(mergedWhere, mode) : mergedWhere
      const exclWhere = applyEff(applyHtFilter(sdWhere, htm), em, asOf)
      const whereSql  = buildWhereWithEncryption(exclWhere, params)
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
      refuseRecursive('exists', args)
      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
      const { where } = args
      const mode      = sdMode(args)
      const htm       = htMode(args)
      const em        = effMode(args)
      const asOf      = effective ? effAsOf(args) : null
      const params    = []
      const globalFilter = resolveGlobalFilter()
      const pluginFilters = plugins?.hasPlugins ? plugins.getReadFilters(modelName, ctx) : []
      const allFilters   = [globalFilter, ...pluginFilters].filter(Boolean)
      const mergedWhere  = allFilters.length
        ? (where ? { AND: [...allFilters, where] } : allFilters.length === 1 ? allFilters[0] : { AND: allFilters })
        : where
      const sdWhere       = softDelete ? injectSoftDeleteFilter(mergedWhere, mode) : mergedWhere
      const exclWhere = applyEff(applyHtFilter(sdWhere, htm), em, asOf)
      const whereSql  = buildWhereWithEncryption(exclWhere, params)
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
      refuseRecursive('findManyAndCount', args)
      // Same reason as findFirst: the page is decided in JavaScript, so the
      // rows come from findMany. The count is the same question either way —
      // it asks the WHERE and never the ordering.
      if (vectorOrderPlan(args.orderBy, _vectorMap) && !_vectorFn(readDb)) {
        const rows  = await this.findMany(args)
        const total = await this.count(args)
        return { rows, total }
      }
      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
      const { where, include, orderBy, limit, offset, select, distinct } = args
      const mode = sdMode(args)
      const htm  = htMode(args)
      const em   = effMode(args)
      const asOf = effective ? effAsOf(args) : null
      const ps   = parseArgs(select, include)
      const psLog = logReadParse(select, include, ps, distinct)

      // ── rows query (with limit/offset) ──────────────────────────────────
      const { sql, params } = buildSQL({ where, orderBy, limit, offset, parsedSelect: psLog, sdMode: mode, htMode: htm, effMode: em, asOf, distinct: distinct === true })
      const _nt = needsTiming()
      const _t0 = _nt ? performance.now() : 0
      const rawRows = readDb.query(sql).all(...params)
      const _dists  = vectorOrderPlan(orderBy, _vectorMap) ? rawRows.map(r => r[DISTANCE_FIELD]) : null
      let rows = readAll(rawRows, { mode: 'list', selectedFields: psLog?.requestedFields })
      fireQuery({ operation: 'findMany', args, sql, params, duration: _nt ? performance.now() - _t0 : 0, rowCount: rows.length })
      const _logIds = psLog !== ps ? extractIds(rows) : null
      withIncludes(rows, ps, include)
      rows = finalize(rows, ps)
      if (_dists) for (let i = 0; i < rows.length; i++) rows[i][DISTANCE_FIELD] = _dists[i]

      // ── count query (same WHERE, no limit/offset) ─────────────────────
      const countParams = []
      const globalFilter = resolveGlobalFilter()
      const pluginFilters = plugins?.hasPlugins ? plugins.getReadFilters(modelName, ctx) : []
      const allFilters = globalFilter ? [globalFilter, ...pluginFilters] : pluginFilters
      const mergedWhere = allFilters.length
        ? (where ? { AND: [...allFilters, where] } : allFilters.length === 1 ? allFilters[0] : { AND: allFilters })
        : where
      const sdMergedWhere = softDelete ? injectSoftDeleteFilter(mergedWhere, mode) : mergedWhere
      const exclWhere = applyEff(applyHtFilter(sdMergedWhere, htm), em, asOf)
      const whereSql = buildWhereWithEncryption(exclWhere, countParams)
      const policyResult = ctx.hasPolicies ? buildPolicyFilter(modelName, 'read', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
      let countSql = `SELECT COUNT(*) as n FROM "${tableName}"`
      if (whereSql && policyResult) countSql += ` WHERE (${whereSql}) AND (${policyResult.sql})`
      else if (whereSql)            countSql += ` WHERE ${whereSql}`
      else if (policyResult)        countSql += ` WHERE ${policyResult.sql}`
      if (policyResult) countParams.push(...policyResult.params)
      const total = readDb.query(countSql).get(...countParams).n

      if (plugins?.hasPlugins) await plugins.afterRead(modelName, rows, ctx, { select })
      if (tableHasLogWork && rows.length > 0) emitLogs('read', rows, { ids: _logIds })

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
      refuseRecursive('aggregate', args)
      // A @@gate is a plugin's beforeRead, and three read methods never called
      // it: a model gated at SYSADMIN answered a level-4 caller's COUNT, its
      // GROUP BY and its full-text search. A row policy compiles into the WHERE
      // and did apply, which is what hid this — the gate is the layer that
      // refuses OUTRIGHT, and it is the one an aggregate over a gated model
      // needs (FJS-262).
      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
      const { where, _count, _sum, _avg, _min, _max, _stringAgg } = args
      // Every name this method can put inside a quoted identifier. Missing one
      // is silent: SQLite reads the unresolvable identifier as a string constant
      // and the aggregate answers it (FJS-202).
      refuseAggregateKeys('aggregate', [
        ...[_sum, _avg, _min, _max].filter(v => v && typeof v === 'object').flatMap(v => Object.keys(v)),
        ...(_stringAgg && typeof _stringAgg === 'object' ? [_stringAgg.field, _stringAgg.orderBy] : []),
        ...namedAggFields(extractNamedAggs(args).map(([, spec]) => spec)),
      ])
      if (_count && typeof _count === 'object' && _count.distinct)
        refuseAggregateKeys('aggregate', [_count.distinct], false)
      const params = []
      // A SELECT-list value (a _stringAgg separator, a named aggregate's
      // filter) is bound before the WHERE's, because it comes first in the
      // statement. Pushed onto one array they bound in the wrong order: a
      // separator compared against the where's column and the where's value
      // joined the strings, so _stringAgg beside any where answered [].
      const selectParams = []

      // Build WHERE (reuses count() pattern)
      const rawFilter    = resolveGlobalFilter()
      const pluginFilters = plugins?.hasPlugins ? plugins.getReadFilters(modelName, ctx) : []
      const allFilters   = rawFilter ? [rawFilter, ...pluginFilters] : pluginFilters
      const mergedWhere  = allFilters.length
        ? (where ? { AND: [...allFilters, where] } : allFilters.length === 1 ? allFilters[0] : { AND: allFilters })
        : where
      // The flags, not a hardcoded 'live'/'instances'. Both were pinned here, so
      // `aggregate({ _count: true, onlyDeleted: true })` counted the LIVE rows
      // and `onlyTemplates` counted the instances — the opposite answer to the
      // question asked, from the method whose whole output is one number
      // nothing can cross-check (FJS-263).
      const sdWhereR = applySdFilter(mergedWhere, args)
      const exclWhere = applyEffFilter(applyHtFilter(sdWhereR, htMode(args)), args)
      const whereSql = buildWhereWithEncryption(exclWhere, params)
      const policyResult = ctx.hasPolicies ? buildPolicyFilter(modelName, 'read', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null

      // Build SELECT columns
      const selects = []
      if (_count) {
        // _count: true → COUNT(*)
        // _count: { distinct: 'field' } → COUNT(DISTINCT "field")
        if (typeof _count === 'object' && _count.distinct) {
          selects.push(`COUNT(DISTINCT ${_aggCol(_count.distinct)}) AS "__count"`)
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
          selects.push(`${fn}(${_aggCol(field)}) AS "${agg}__${field}"`)
        }
      }
      // _stringAgg: { field: 'name', separator: ', ', orderBy: 'name' }
      if (_stringAgg) {
        const { field, separator = ',', orderBy: saOrderBy } = _stringAgg
        if (!field) throw new Error('aggregate() _stringAgg requires a field')
        // SQLite syntax: GROUP_CONCAT(col, separator ORDER BY ...) — separator
        // MUST precede ORDER BY. Putting ORDER BY before the separator silently
        // causes the separator to be ignored and the default "," is used.
        const orderClause = saOrderBy ? ` ORDER BY ${_aggCol(saOrderBy)}` : ''
        selects.push(`GROUP_CONCAT(${_aggCol(field)}, ?${orderClause}) AS "__stringAgg__${field}"`)
        selectParams.push(separator)
      }

      // Named aggregates: any _-prefixed key with { count/sum/avg/min/max, filter? }
      const namedAggs = extractNamedAggs(args).filter(([k]) =>
        !['_count','_sum','_avg','_min','_max','_stringAgg'].includes(k)
      )
      for (const [key, spec] of namedAggs) {
        selects.push(buildNamedAggExpr(key, spec, selectParams))
      }

      if (!selects.length) throw new Error('aggregate() requires at least one aggregation (_count, _sum, _avg, _min, _max, _stringAgg, or a named aggregate)')

      let sql = `SELECT ${selects.join(', ')} FROM "${tableName}"`
      if (whereSql && policyResult) sql += ` WHERE (${whereSql}) AND (${policyResult.sql})`
      else if (whereSql)            sql += ` WHERE ${whereSql}`
      else if (policyResult)        sql += ` WHERE ${policyResult.sql}`
      if (policyResult) params.push(...policyResult.params)

      const _nt = needsTiming()
      const _t0 = _nt ? performance.now() : 0
      params.unshift(...selectParams)
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
        if (agg === '_min' || agg === '_max') result[agg] = hydrateCols(result[agg])
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
      refuseRecursive('groupBy', args)
      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
      const { by, where, having, orderBy, limit, offset, _count, _sum, _avg, _min, _max, _stringAgg, fillGaps, timeZone } = args
      const interval = args.interval   // { fieldName: 'unit' }
      // S3: an interval is cut on the wall clock of `timeZone` (IANA), not UTC's.
      // Refused without an interval, where it would mean nothing and quietly
      // be ignored — the shape of every silent wrong answer a report can give.
      if (timeZone != null) {
        if (!interval)
          throw new ValidationError([{ path: ['timeZone'], message: `groupBy() timeZone cuts an interval — pass interval: { <DateTime field>: 'month' } beside it` }])
        try { offsetSpans(0, 0, timeZone) }
        catch { throw new ValidationError([{ path: ['timeZone'], message: `groupBy() timeZone '${timeZone}' is not an IANA time zone (e.g. 'Asia/Tokyo')` }]) }
      }
      let zoneShift = null   // set below, once the WHERE is built
      if (!by?.length) throw new Error('groupBy() requires a "by" array of field names')
      // `by` is the naming tier — a GROUP BY over stored text is at least
      // self-consistent, so an opaque column passes here and not below. It
      // reached SQLite unchecked, which answered `no such column: order.label`:
      // a refusal, but one naming a table rather than the model and never the
      // reason.
      refuseAggregateKeys('groupBy', by, false)
      refuseAggregateKeys('groupBy', [
        ...[_sum, _avg, _min, _max].filter(v => v && typeof v === 'object').flatMap(v => Object.keys(v)),
        ...(_stringAgg && typeof _stringAgg === 'object' ? [_stringAgg.field, _stringAgg.orderBy] : []),
        ...namedAggFields(extractNamedAggs(args).map(([, spec]) => spec)),
      ])
      if (_count && typeof _count === 'object' && _count.distinct)
        refuseAggregateKeys('groupBy', [_count.distinct], false)

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

        // It becomes STRFTIME('%Y', "table"."field") — a quoted identifier like
        // any other, so an unknown name is a string constant and every row
        // groups together. The type check below only ever ran when the field
        // WAS found.
        refuseAggregateKeys('groupBy interval', [intervalField], false)

        // Validate field is DateTime on the model
        const modelDef = ctx.models[modelName]
        const intervalFieldDef = modelDef?.fields.find(f => f.name === intervalField)
        if (intervalFieldDef && intervalFieldDef.type.name !== 'DateTime' && intervalFieldDef.type.name !== 'String')
          throw new Error(`groupBy() interval field '${intervalField}' must be a DateTime field, got '${intervalFieldDef.type.name}'`)
      }

      // ── `having` and an aggregate `orderBy` name columns too ──────────────
      //
      // Both put a caller's name inside an aggregate expression and neither
      // reached refuseAggregateKeys, so the ladder that refuses `_max` over a
      // @guarded column refused nothing here: a binary search on a HAVING
      // threshold recovered an exact value in 18 requests and one aggregate
      // sort ordered every group by it — `FJS-393`'s attack on the two
      // grammars that had no walk (`FJS-954`). The same gap swallowed a typo,
      // because SQLite reads an unresolvable quoted identifier as a string
      // constant and `SUM('nope') > 1` is simply false (`FJS-202`).
      //
      // Checked here rather than beside the other refusals because `orderBy`
      // may name the interval field, which is resolved just above.
      const AGG_FNS = { _sum: 'SUM', _avg: 'AVG', _min: 'MIN', _max: 'MAX' }
      if (having && typeof having === 'object') {
        const names = []
        for (const [aggKey, spec] of Object.entries(having)) {
          if (aggKey === '_count') continue
          if (!(aggKey in AGG_FNS))
            throw new ValidationError([{ path: ['having', aggKey], message:
              `Unknown having key '${aggKey}' on ${modelName}.groupBy. A HAVING filters an aggregate: ` +
              `_count, ${Object.keys(AGG_FNS).join(', ')}. A named aggregate cannot be filtered here — it is ` +
              `computed in the SELECT, so filter the returned rows.` }])
          if (spec && typeof spec === 'object') names.push(...Object.keys(spec))
        }
        refuseAggregateKeys('having', names)
      }
      if (orderBy && typeof orderBy === 'object') {
        const groupKeys = new Set(by)
        if (intervalField) groupKeys.add(intervalField)
        const names = []
        for (const [key, val] of Object.entries(orderBy)) {
          if (key === '$raw')
            // A fragment written for findMany names columns this statement does
            // not have. Refused rather than emitted as `"$raw" ASC`, which
            // SQLite reads as a string constant and sorts by nothing.
            throw new ValidationError([{ path: ['orderBy', '$raw'], message:
              `orderBy $raw is not supported on groupBy — its ORDER BY is over the group keys and aggregates, ` +
              `not over ${modelName}'s columns. Put the expression in the aggregate, or sort the result in JS` }])
          if (key === '_count' || key === '_stringAgg') continue
          if (key in AGG_FNS) {
            if (val && typeof val === 'object') names.push(...Object.keys(val))
            continue
          }
          if (key.startsWith('_'))
            throw new ValidationError([{ path: ['orderBy', key], message:
              `Cannot orderBy '${key}' on ${modelName}.groupBy — a named aggregate is computed in the SELECT and ` +
              `cannot be sorted on. Sort the returned rows, or ask for it as ${Object.keys(AGG_FNS).join(' / ')}.` }])
          if (!groupKeys.has(key))
            throw new ValidationError([{ path: ['orderBy', key], message:
              `Cannot orderBy '${key}' on ${modelName}.groupBy — a groupBy sorts by a group key or an aggregate, and ` +
              `'${key}' is neither. Group keys: ${[...groupKeys].join(', ')}. Aggregates: _count, ` +
              `${Object.keys(AGG_FNS).join(', ')}.` }])
        }
        refuseAggregateKeys('orderBy', names)
      }

      // Build STRFTIME expression for a given field + unit. With a time zone the
      // instant is first moved onto that zone's wall clock (`zoneShift`).
      function strftimeExpr(field, unit) {
        // `expr` and not `col`, which is this table's field → column resolver.
        const raw  = `"${tableName}"."${col(field)}"`
        const expr = zoneShift ? `DATETIME(${raw}, ${zoneShift})` : raw
        switch (unit) {
          case 'year':    return `STRFTIME('%Y', ${expr})`
          case 'quarter': return `STRFTIME('%Y', ${expr}) || '-Q' || (((CAST(STRFTIME('%m', ${expr}) AS INTEGER) - 1) / 3) + 1)`
          case 'month':   return `STRFTIME('%Y-%m', ${expr})`
          case 'week':    return `STRFTIME('%Y-W%W', ${expr})`
          case 'day':     return `STRFTIME('%Y-%m-%d', ${expr})`
          case 'hour':    return `STRFTIME('%Y-%m-%dT%H', ${expr})`
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
      // A SELECT-list value (a _stringAgg separator, a named aggregate's
      // filter) is bound before the WHERE's, because it comes first in the
      // statement. Pushed onto one array they bound in the wrong order: a
      // separator compared against the where's column and the where's value
      // joined the strings, so _stringAgg beside any where answered [].
      const selectParams = []

      // WHERE clause
      const rawFilter    = resolveGlobalFilter()
      const pluginFilters = plugins?.hasPlugins ? plugins.getReadFilters(modelName, ctx) : []
      const allFilters   = rawFilter ? [rawFilter, ...pluginFilters] : pluginFilters
      const mergedWhere  = allFilters.length
        ? (where ? { AND: [...allFilters, where] } : allFilters.length === 1 ? allFilters[0] : { AND: allFilters })
        : where
      // Same as aggregate: the flags, not a hardcoded mode (FJS-263).
      const sdWhereR = applySdFilter(mergedWhere, args)
      const exclWhere = applyEffFilter(applyHtFilter(sdWhereR, htMode(args)), args)
      const whereSql = buildWhereWithEncryption(exclWhere, params)
      const policyResult = ctx.hasPolicies ? buildPolicyFilter(modelName, 'read', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null

      // ── The zone, as SQL ─────────────────────────────────────────────────
      // SQLite has no zone database and bun:sqlite can register no function,
      // so the zone is stated as the fixed offsets it keeps over the rows this
      // call reads (toolbelt's offsetSpans) and a CASE picks each row's:
      // DATETIME(t, '+32400 seconds') is Tokyo's wall clock for t. Everything
      // inlined is a number this code computed; nothing the caller sent.
      // One extra MIN/MAX over the same WHERE bounds the spans: a summer-time
      // zone is two per year read, one per year of rows rather than a century.
      if (timeZone != null) {
        const rawCol = `"${tableName}"."${col(intervalField)}"`
        const parts = [whereSql, policyResult?.sql].filter(Boolean)
        const range = readDb.query(
          `SELECT MIN(julianday(${rawCol})) AS lo, MAX(julianday(${rawCol})) AS hi FROM "${tableName}"` +
          (parts.length ? ` WHERE ${parts.map(p => `(${p})`).join(' AND ')}` : ''),
        ).get(...params, ...(policyResult?.params ?? []))
        const msOf = jd => Math.round((jd - 2440587.5) * 86400000)
        const spans = range?.lo != null ? offsetSpans(msOf(range.lo), msOf(range.hi), timeZone) : [{ offset: 0 }]
        const mod = offset => `'${offset >= 0 ? '+' : ''}${offset / 1000} seconds'`
        zoneShift = spans.length === 1
          ? mod(spans[0].offset)
          : `CASE ${spans.slice(1).map((sp, i) =>
              `WHEN julianday(${rawCol}) < ${sp.from / 86400000 + 2440587.5} THEN ${mod(spans[i].offset)}`).join(' ')} ` +
            `ELSE ${mod(spans[spans.length - 1].offset)} END`
      }

      // ── SELECT columns ───────────────────────────────────────────────────
      const groupByCols = []   // SQL expressions for GROUP BY
      const selectCols  = []   // SQL expressions for SELECT

      for (const f of by) {
        if (f === intervalField) {
          const expr = strftimeExpr(intervalField, intervalUnit)
          selectCols.push(`${expr} AS "${intervalField}"`)
          groupByCols.push(expr)
        } else {
          // A derived key groups by its expression and is aliased to its name,
          // so the returned row carries the field the caller asked for.
          const d = _derivedSql(f)
          // Aliased back to the FIELD, so a grouped row carries the key the
          // caller grouped by rather than the column it is stored under.
          selectCols.push(d ? `${d} AS "${f}"` : `"${tableName}"."${col(f)}" AS "${f}"`)
          groupByCols.push(d ?? `"${tableName}"."${col(f)}"`)
        }
      }

      if (_count) {
        if (typeof _count === 'object' && _count.distinct) {
          selectCols.push(`COUNT(DISTINCT ${_aggCol(_count.distinct)}) AS "__count"`)
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
          selectCols.push(`${fn}(${_aggCol(field)}) AS "${agg}__${field}"`)
        }
      }
      if (_stringAgg) {
        const { field, separator = ',', orderBy: saOrderBy } = _stringAgg
        if (!field) throw new Error('groupBy() _stringAgg requires a field')
        // SQLite: separator must come before ORDER BY in GROUP_CONCAT.
        const orderClause = saOrderBy ? ` ORDER BY ${_aggCol(saOrderBy)}` : ''
        selectCols.push(`GROUP_CONCAT(${_aggCol(field)}, ?${orderClause}) AS "__stringAgg__${field}"`)
        selectParams.push(separator)
      }

      // Named aggregates
      const namedAggs = extractNamedAggs(args).filter(([k]) =>
        !['_count','_sum','_avg','_min','_max','_stringAgg'].includes(k)
      )
      for (const [key, spec] of namedAggs) {
        selectCols.push(buildNamedAggExpr(key, spec, selectParams))
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
      // Each bound becomes a calendar date — the zone's, when there is one —
      // and is BOUND, never written into the statement. It was interpolated as
      // date('${gapStart}'), and since it arrives from fillGaps or the where
      // over the aggregate verb, a caller could close the quote and read any
      // table one bit per call (FJS-1650). A value that is not a date is
      // refused by name rather than coerced.
      const gapDate = (v, which) => {
        const ms = v instanceof Date ? v.getTime()
          : typeof v === 'number' ? v
          : typeof v === 'string' ? Date.parse(v)
          : NaN
        if (!Number.isFinite(ms))
          throw new ValidationError([{ path: ['fillGaps', which], message: `groupBy() gap fill ${which} ${JSON.stringify(v)} is not a date or an instant` }])
        // An hour bucket walks a wall clock to the hour, everything else a date.
        if (intervalUnit === 'hour') {
          if (!timeZone) return new Date(ms).toISOString().slice(0, 13).replace('T', ' ') + ':00:00'
          const p = partsIn(ms, timeZone)
          const two = n => String(n).padStart(2, '0')
          return `${String(p.year).padStart(4, '0')}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:00:00`
        }
        return timeZone ? plainDateIn(ms, timeZone) : new Date(ms).toISOString().slice(0, 10)
      }
      if (gapStart && gapEnd) {
        gapStart = gapDate(gapStart, 'start')
        gapEnd   = gapDate(gapEnd, 'end')
        // A recursive CTE makes one row per interval, and both bounds are the
        // caller's: a century of hours is 876,000 rows built per request.
        const MAX_GAP_INTERVALS = 10_000
        const UNIT_MS = { year: 365 * 864e5, quarter: 90 * 864e5, month: 28 * 864e5, week: 7 * 864e5, day: 864e5, hour: 36e5 }
        const span = Date.parse(gapEnd.replace(' ', 'T') + (gapEnd.length > 10 ? 'Z' : 'T00:00:00Z')) - Date.parse(gapStart.replace(' ', 'T') + (gapStart.length > 10 ? 'Z' : 'T00:00:00Z'))
        if (span / UNIT_MS[intervalUnit] > MAX_GAP_INTERVALS)
          throw new ValidationError([{ path: ['fillGaps'], message: `groupBy() gap fill from ${gapStart} to ${gapEnd} is more than ${MAX_GAP_INTERVALS} ${intervalUnit}s — narrow the range or pass fillGaps: false` }])
      }

      // ── Build SQL ────────────────────────────────────────────────────────
      let sql

      if (gapStart && gapEnd && intervalField) {
        // Gap-fill path: recursive CTE generates all intervals, LEFT JOIN data
        const step   = cteStep(intervalUnit)
        const fmt    = cteDateFormat(intervalUnit)
        // date() drops the time, so date(d, '+1 hour') is d again and the CTE
        // never ended: one request with interval hour and a gap fill held a
        // core for good. An hour walks datetime().
        const at     = intervalUnit === 'hour' ? 'datetime' : 'date'

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

        // Order: the CTE's two bounds, then existsSubquery, then UNION ALL
        params.push(gapStart, gapEnd)     // intervals CTE
        params.push(...whereOnlyParams)  // existsSubquery
        if (policyResult) params.push(...policyResult.params)  // existsSubquery policy
        params.push(...selectParams)     // UNION ALL's SELECT list
        params.push(...whereOnlyParams)  // UNION ALL
        if (policyResult) params.push(...policyResult.params)  // UNION ALL policy

        // The data subquery for the NOT IN check: the bucket LABEL of every
        // interval that has rows. It selected the raw column, which never
        // equals a label, so every interval with data came back twice — once
        // as a 0 gap row and once with its counts.
        const existsSubquery = `SELECT ${strftimeExpr(intervalField, intervalUnit)} FROM "${tableName}"${dataWhere} GROUP BY ${groupByCols.join(', ')}`

        sql = `
WITH RECURSIVE intervals(d) AS (
  SELECT ${at}(?)
  UNION ALL
  SELECT ${at}(d, '${step}') FROM intervals WHERE ${at}(d, '${step}') <= ${at}(?)
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
        params.unshift(...selectParams)
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
              const expr = buildAggHaving(`${fn}(${_aggCol(field)})`, cond, params)
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
              orderParts.push(`GROUP_CONCAT(${_aggCol(_stringAgg.field)}) ${val === 'desc' ? 'DESC' : 'ASC'}`)
            }
          } else if (key.startsWith('_')) {
            const fn = { _sum: 'SUM', _avg: 'AVG', _min: 'MIN', _max: 'MAX' }[key]
            if (fn && typeof val === 'object') {
              for (const [field, dir] of Object.entries(val)) {
                orderParts.push(`${fn}(${_aggCol(field)}) ${dir === 'desc' ? 'DESC' : 'ASC'}`)
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
        let out = {}
        for (const f of by) out[f] = r[f]
        out = hydrateCols(out)
        if (_count) out._count = r.__count ?? 0
        for (const agg of ['_sum', '_avg', '_min', '_max']) {
          const spec = args[agg]
          if (!spec || spec === true) continue
          out[agg] = {}
          for (const [field, wanted] of Object.entries(spec)) {
            if (!wanted) continue
            out[agg][field] = r[`${agg}__${field}`] ?? null
          }
          if (agg === '_min' || agg === '_max') out[agg] = hydrateCols(out[agg])
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
    async create({ data, include, select, scopedBy, system } = {}) {
      // Before the INSERT and before the transaction: a create of a model whose
      // relation declares a minimum, naming no children, can never satisfy it,
      // and answering that with a COUNT would cost the single-row fast path
      // (`FJS-1106`) for a row that is refused either way.
      const _cardRequires = ctx.cardinalityMap?.requiresChildren?.[modelName]
      if (_cardRequires) { const r = refuseChildlessCreate(_cardRequires, data); if (r) throw r }
      refuseSystemEntries(system, ['create'])
      await enforceValueSets(modelName, [data], ctx)
      // The plugins first: a value one writes into the payload is a value the
      // row lands with, and grading before it would pass it ungraded (FJS-1307).
      if (plugins?.hasPlugins) await plugins.beforeCreate(modelName, { data, include, select, system }, ctx)
      refuseOffEntry([data])
      // Auto-generate @id if field uses @default(uuid/ulid/cuid) and not provided
      // What the ENGINE puts in this payload, so the @guarded/@system refusals
      // in writeData can grade the caller's keys alone (FJS-565).
      const stamped = new Set()
      const autoId = ctx.autoIdMap?.[modelName]
      if (autoId && (data == null || data[autoId.field] == null)) {
        noteStamp(stamped, data, autoId.field)
        data = { ...(data ?? {}), [autoId.field]: autoId.generate() }
      }
      data = applyGeneratedDefaults(data, ctx.generatedDefaultMap?.[modelName], stamped)
      data = applyAuthDefaults(data, ctx.authDefaultMap?.[modelName], ctx.auth, stamped)
      data = stampFromAuth(data, ctx.createdByMap?.[modelName], ctx.auth, stamped)
      // After the auth stamps, never before — see authStamped (FJS-1402).
      const _crParent = ctx.hasPolicies ? checkCreate(data) : undefined
      // A new row is version 1, whatever the payload says. Honouring a supplied
      // version would let a client start a row at 500 and make the first real
      // editor's read look stale.
      if (ctx.versionMap?.[modelName]) {
        noteStamp(stamped, data, ctx.versionMap[modelName])
        data = { ...(data ?? {}), [ctx.versionMap[modelName]]: 1 }
      }
      // Apply @default(fieldName) — copy value from sibling field if not already provided
      // Must run BEFORE writeData/applyTransforms so @slug and other transforms see the value
      const fieldRefDefaults = ctx.fieldRefDefaultMap?.[modelName]
      if (fieldRefDefaults?.length) {
        const stamps = {}
        for (const { field, sourceField } of fieldRefDefaults) {
          if ((data == null || data[field] == null) && data?.[sourceField] != null) {
            noteStamp(stamped, data, field)
            stamps[field] = data[sourceField]
          }
        }
        if (Object.keys(stamps).length) data = { ...(data ?? {}), ...stamps }
      }
      extractWriteOps(data, { where: 'create' })
      const _crHidden = firstRefusal(_crParent, (await hiddenParents([data], [stamped]))[0])

      // ── Everything that touches the database, as one unit ────────────────
      //
      // A create is not one statement: a @sequence counter bump, the parent
      // rows a belongsTo nested write makes, the INSERT, the children, the join
      // rows. Run bare they were four to N auto-commits, so a child violating a
      // @unique left a committed parent behind and a failed insert kept the
      // counter it had already bumped — and, arriving while another context held
      // a transaction, the whole lot silently joined it and went with its
      // rollback (`FJS-638`). The lock is what stops the second; the transaction
      // is what stops the first. `exclusive` rather than `wrapExclusive` because
      // the nested writes are themselves table calls and therefore async; a
      // genuine nesting takes a SAVEPOINT and never waits on its own caller.
      //
      // The INSERT and what it reads back, synchronously: no await may sit
      // between the decision below and the statement, or a transaction can open
      // in the gap and the insert joins it.
      function insertRow(hasNested, edgeWrites) {
        if (ctx.selfRelationMap?.[modelName])
          assertNoParentCycle([data?.[ctx.selfRelationMap[modelName][0].referencedField]], data)
        const row   = writeData(data, { requireAll: true, system, stamped, creating: true })
        if (_crHidden) throw _crHidden
        const cols  = Object.keys(row)
        // cols can be empty when all fields are optional and none were supplied,
        // or when all fields were stripped by @allow write policies.
        // SQLite requires DEFAULT VALUES syntax when no columns are specified.
        // A hasMany create needs the parent's id, which only RETURNING answers —
        // so skipping it here is not a saving, it is the children going missing.
        const _noReturn = select === false && !hasNested && !edgeWrites.length
        // A guarded insert is `INSERT … SELECT … WHERE`, because an INSERT has no
        // WHERE of its own. Zero rows changed is the refusal, and sealRefusal is
        // what turns that into a sentence.
        const _crSeal = cols.length ? sealInsertGuard(row) : null
        const _crSql = cols.length
          ? _crSeal
            ? `INSERT INTO "${tableName}" (${cols.map(c => `"${col(c)}"`).join(', ')}) SELECT ${cols.map(() => '?').join(', ')} WHERE ${_crSeal.sql}${_noReturn ? '' : ' RETURNING *'}`
            : `INSERT INTO "${tableName}" (${cols.map(c => `"${col(c)}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})${_noReturn ? '' : ' RETURNING *'}`
          : `INSERT INTO "${tableName}" DEFAULT VALUES${_noReturn ? '' : ' RETURNING *'}`
        const _crParams = cols.length
          ? [...cols.map(c => row[c] ?? null), ...(_crSeal?.params ?? [])]
          : []
        const _nt = needsTiming()
        const _crT0 = _nt ? performance.now() : 0

        // select: false — skip RETURNING, use run() for zero overhead
        if (_noReturn) {
          let result
          try { result = writeDb.run(_crSql, ..._crParams) }
          catch (e) { throw asConstraintError(e, row) }
          const _crChanges = rowsChanged(writeDb)
          fireQuery({ operation: 'create', args: { data, include, select }, sql: _crSql, params: _crParams, duration: _nt ? performance.now() - _crT0 : 0, rowCount: _crChanges })
          if (!_crChanges) {
            const refusal = sealRefusal(_crSeal?.parents, 'create')
            if (refusal) throw refusal
            return { done: true, row: null }
          }
          // A row write with no row: `select: false` skipped the RETURNING. Still
          // a row event — one row changed and this cannot say which.
          fireRowEvent('create', 'create', null)
          return { done: true, row: null }
        }

        // RETURNING * gives the inserted row directly — no follow-up SELECT needed.
        // Uses writeDb so it works inside open transactions.
        let created
        try { created = read(writeDb.query(_crSql).get(..._crParams), { mode: 'single', hydrateFrom: true }) }
        catch (e) { throw asConstraintError(e, row) }
        fireQuery({ operation: 'create', args: { data, include, select }, sql: _crSql, params: _crParams, duration: _nt ? performance.now() - _crT0 : 0, rowCount: created ? 1 : 0 })
        if (!created) {
          const refusal = sealRefusal(_crSeal?.parents, 'create')
          if (refusal) throw refusal
          return { done: true, row: null }
        }
        return { done: false, row: created }
      }

      // One INSERT with no transaction open on this connection is already its
      // own unit — SQLite's autocommit — and nothing can open one before it
      // runs, because nothing between here and the statement yields. Taking the
      // lock, the async scope and a BEGIN/COMMIT for it cost a single-row create
      // 82% (`FJS-1106`). A @sequence bump, a nested write and an edge write are
      // further statements, so they keep the transaction.
      let _crOut
      const _crSplit = ctx.sequenceMap?.[modelName]?.length ? null : extractNestedWrites(data)
      const _crEdges = _crSplit && !_crSplit.hasNested ? extractEdgeWrites(_crSplit.scalar) : null
      // A write that moves a count has to reach `commit`, which is where the
      // count is graded — the autocommit path never opens a transaction, so a
      // child inserted through it is never graded at all (`FJS-969`'s shape one
      // realm over: the fast paths are the ones a rule misses). Asked of the
      // MODEL, so a schema declaring no bound keeps the path (`FJS-1106`).
      if (_crEdges && !_crEdges.edgeWrites.length && tx.state.depth === 0 && !_cardNotes && !_exclNotes) {
        data   = _crEdges.data
        _crOut = insertRow(false, _crEdges.edgeWrites)
      } else {
        _crOut = await tx.exclusive(async () => {
          // Apply @sequence fields — inject per-scope auto-incremented values.
          // Ahead of the split, because the split is what the INSERT is built
          // from: injecting a sequence into `data` after it has been taken apart
          // writes the row without the column.
          data = applySequences(data, modelName, ctx.sequenceMap, writeDb, stamped)
          // Split nested write ops from scalar fields
          const { scalar, nested, hasNested } = extractNestedWrites(data)
          const { data: _scalarNoEdge, edgeWrites } = extractEdgeWrites(scalar)
          // belongsTo ops first — injects FK values before insert
          const extraFKs = await processBelongsToNested(nested)
          data = { ..._scalarNoEdge, ...extraFKs }

          const inserted = insertRow(hasNested, edgeWrites)
          // Inside the transaction, because the grade runs at ITS commit. Noted
          // after it returns and the ledger is graded by the NEXT write's
          // commit instead — which still reads the right COUNT, so it looks
          // correct for as long as consecutive writes share a parent.
          //
          // `select: false` with nothing nested skips the RETURNING, so there is
          // no row — and a child's foreign key is in the payload either way. The
          // parent side needs no fallback: a childless create is refused before
          // this point, and one carrying children has nested writes and a row.
          noteCardinality(inserted.row ?? data)
          noteExclusion(inserted.row ?? data)
          if (inserted.done) return inserted
          const created = inserted.row
          // hasMany ops after — children need parent PK + parent row (for co-FK propagation)
          const pkField = ctx.models[modelName]?.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
          await processHasManyNested(nested, created[pkField], created)
          applyEdgeWrites(edgeWrites, created[pkField], scopedBy)
          return inserted
        })
      }
      // ── Committed from here ──────────────────────────────────────────────
      if (_crOut.done) {
        if (plugins?.hasPlugins) await plugins.afterWrite(modelName, 'create', _crOut.row, ctx)
        return null
      }
      let created = _crOut.row
      const ps = parseArgs(select, include)
      if (ps || include) withIncludes([created], ps, include)
      created = finalizeOne(created, ps)
      fireRowEvent('create', 'create', created)
      if (plugins?.hasPlugins) await plugins.afterWrite(modelName, 'create', created, ctx)
      // ── Logging ──────────────────────────────────────────────────────────────
      if (tableHasLogWork && created) emitLogs('create', [created], { after: created, system })
      // `select: false` still means *do not hand me the row*. A nested write
      // needs the parent's id, so RETURNING could not be skipped — but that is
      // this method's need and it does not change what the caller asked for.
      // The announcement keeps the row, because it HAS one: `null` there means
      // the RETURNING was skipped, which is now a different fact.
      return select === false ? null : created
    },

    // ── createMany ──────────────────────────────────────────────────────────
    async createMany({ data, system, announce } = {}) {
      if (!data?.length) return { count: 0 }
      // Resolved before any work: an unknown value is a caller that meant
      // something, and refusing it after the write has landed helps nobody.
      const { mode: _cmMode, wantRows: _cmWantRows } = announceFor(announce)
      // A logged model already takes RETURNING, so opting in costs it nothing.
      const _cmNeedRows = tableHasLogWork || _cmWantRows
      // Operators are refused on a create-shaped write, and this is where that
      // refusal is made for a bulk one. It used to be reached only by the
      // object-where-a-value-belongs guard in writeData, which cannot see
      // `$merge`: a Json column legitimately takes an object, so the operator
      // was stored as the document — `{"$merge":{"a":1}}`.
      for (const row of data) extractWriteOps(row, { where: 'createMany' })
      refuseSystemEntries(system, ['create'])
      await enforceValueSets(modelName, data, ctx)
      if (plugins?.hasPlugins) await plugins.beforeCreate(modelName, { data, system }, ctx)
      refuseOffEntry(data)
      const _cmParent = ctx.hasPolicies ? data.map(row => checkCreate(authStamped(row, modelName, ctx))) : []
      // The rows as the caller wrote them: every stamp lands later, inside the unit.
      const _cmHidden = await hiddenParents(data)
      for (const [i, r] of _cmParent.entries()) _cmHidden[i] = firstRefusal(r, _cmHidden[i])

      // Auto-generate @id and run writeData (transforms + validation) on every row
      // before touching the DB — so @email, @lower, @trim, @encrypted, enum checks
      // all fire consistently, same as single create().
      const autoId      = ctx.autoIdMap?.[modelName]
      const genDefaults = ctx.generatedDefaultMap?.[modelName]
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
      await tx.wrapExclusive(() => {
        rows = data.map((item, i) => {
          let d = item
          // Per ROW — rows are not required to be uniform, so one shared set
          // would let row 0's stamp excuse row 1's caller-supplied column.
          const stamped = new Set()
          if (autoId && (d == null || d[autoId.field] == null)) {
            noteStamp(stamped, d, autoId.field)
            d = { ...(d ?? {}), [autoId.field]: autoId.generate() }
          }
          d = applyGeneratedDefaults(d, genDefaults, stamped)
          d = applyAuthDefaults(d, authDefaults, ctx.auth, stamped)
          d = stampFromAuth(d, createdByStamps, ctx.auth, stamped)
          if (versionField) { noteStamp(stamped, d, versionField); d = { ...(d ?? {}), [versionField]: 1 } }
          // Apply @sequence per row — each row gets its own counter increment
          d = applySequences(d, modelName, ctx.sequenceMap, writeDb, stamped)
          // A validation failure here names the field and, without this, no row.
          // The row itself is NOT passed on: it is the caller's payload before
          // writeData ran, so a @encrypted value in it is still plaintext.
          try { return writeData(d, { requireAll: true, system, stamped, creating: true }) }
          catch (e) { throw asBatchRowError(e, i, data.length, null) }
        })

        // One prepared statement PER ROW SHAPE, not one for the batch. Rows are
        // not required to be uniform: deriving the column list from row 0 made
        // row 0 decide what every other row may write, so a wider row silently
        // lost its extra columns and a narrower one bound NULL over a column
        // the caller never mentioned — defeating its DDL DEFAULT.
        // Rows are still inserted in caller order, because an autoincrement id
        // is assigned in insert order and grouping would renumber them.
        const stmts = new Map()
        const stmtFor = (cols) => {
          // '\x00' as an ESCAPE, never a raw NUL byte in the source: a literal NUL
          // makes grep classify this file as binary and skip it silently, which
          // hides every match in the largest file in the package.
          const key = cols.join('\x00')
          let entry = stmts.get(key)
          if (!entry) {
            // The seal guard turns VALUES into SELECT … WHERE, exactly as it
            // does on the single create. The predicate is the same for every
            // row of the model, so it belongs in the cached statement.
            const sql = _sealInsertSql
              ? `INSERT INTO "${tableName}" (${cols.map(c => `"${col(c)}"`).join(', ')}) SELECT ${cols.map(() => '?').join(', ')} WHERE ${_sealInsertSql}`
              : `INSERT INTO "${tableName}" (${cols.map(c => `"${col(c)}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
            entry = { cols, sql: sql + (_cmNeedRows ? ` RETURNING *` : ''), stmt: null }
            entry.stmt = writeDb.prepare(entry.sql)
            stmts.set(key, entry)
          }
          return entry
        }
        // RETURNING on a logged model: an @id @default(autoincrement()) row has no
        // id until SQLite assigns one, and a log entry naming no rows is not a trail.
        if (_cmNeedRows) _cmInserted = []
        for (const [_i, row] of rows.entries()) {
          if (_cmHidden[_i]) throw asBatchRowError(_cmHidden[_i], count, rows.length, row)
          const { cols, stmt } = stmtFor(Object.keys(row))
          const _cmSeal = sealInsertGuard(row)
          const args = [...cols.map(c => row[c] ?? null), ...(_cmSeal?.params ?? [])]
          let _cmWrote = true
          try {
            if (_cmNeedRows) { const r = stmt.get(...args); if (r) _cmInserted.push(r); else if (_cmSeal) _cmWrote = false }
            else if (_cmSeal) { stmt.run(...args); _cmWrote = rowsChanged(writeDb) > 0 }
            else stmt.run(...args)
          } catch (e) { throw asBatchRowError(asConstraintError(e, row), count, rows.length, row) }
          // A batch is all-or-nothing here: a row the seal refused is named the
          // same way a row a constraint refused is, because silently writing
          // nine of ten rows is the failure this method's own error shape exists
          // to prevent.
          if (!_cmWrote) {
            const refusal = sealRefusal(_cmSeal?.parents, 'create')
            if (refusal) throw asBatchRowError(refusal, count, rows.length, row)
          }
          noteCardinality(row)
          noteExclusion(row)
          count++
        }
        // A mixed batch has no single SQL to report. Uniform — the ordinary
        // case — reports exactly what it did before.
        _cmSql = [...stmts.values()].map(e => e.sql).join('\n')
      })
      fireQuery({ operation: 'createMany', args: { data }, sql: _cmSql, params: null, duration: _nt ? performance.now() - _cmT0 : 0, rowCount: count })
      if (tableHasLogWork && _cmInserted?.length) emitLogs('create', _cmInserted, { system })
      // No `where` on the collection form — a batch names its rows by supplying
      // them, and their ids exist only after SQLite assigns them.
      announceBulk({ mode: _cmMode, event: 'create', operation: 'createMany', count, rows: _cmInserted })
      return { count }
    },

    // ── update ──────────────────────────────────────────────────────────────
    // Returns the updated row, or null in these cases:
    //   • No row matched the where clause
    //   • A @@allow/@@deny policy blocked the update
    //   • A post-update policy rollback was triggered
    // Callers that need to distinguish can check count() before/after,
    // or enable policyDebug to see which policy blocked.
    async update({ where, data, include, select, scopedBy, system, _bypassVersion, _move, base,
                   withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf } = {}) {
      refuseSystemEntries(system, ['update'])
      await enforceValueSets(modelName, [data], ctx, { where })
      if (plugins?.hasPlugins) await plugins.beforeUpdate(modelName, { where, data, include, select, system }, ctx)
      const stamped = new Set()
      data = stampFromAuth(data, ctx.updatedByMap?.[modelName], ctx.auth, stamped)
      const [_upHidden] = await hiddenParents([data], [stamped])

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

      // ── @@sync(field) — the base row a per-column merge compares against ────
      // Refused by name where nothing would read it, rather than dropped. A
      // base that is silently ignored looks exactly like a merge that found no
      // conflict, which is the one failure this mechanism cannot afford to make
      // quietly: the caller believes two writers were reconciled and one of
      // them was overwritten.
      const _syncPolicy = ctx.syncMap?.[modelName]
      if (base !== undefined && _syncPolicy !== 'field') throw new Error(
        `[litestone] update on "${modelName}" was given a base row, and only @@sync(field) reads one. ` +
        `This model declares ${_syncPolicy ? `@@sync(${_syncPolicy})` : 'no @@sync policy'}. ` +
        `A base is the row as the writer read it, and it is what lets two people who edited different ` +
        `columns both win — without @@sync(field) there is nothing to compare it against.`)

      // A merge compares the patch against the STORED row, so a column whose
      // stored form is not its value form cannot be compared: `@encrypted` is
      // ciphertext and re-encrypts to different bytes each time, `@hashed` is
      // one-way. Comparing either reports a conflict on every write that names
      // it, including one nobody else touched — a false conflict, which is
      // worse than a refusal because it looks like the feature working.
      // Refused by name rather than merged or skipped; a device cannot reach
      // this anyway, since `host/browser.js` refuses `@encrypted` outright.
      if (base !== undefined) {
        const _opaque = Object.keys(data ?? {}).filter(f => fieldPolicy[f]?.encrypted || fieldPolicy[f]?.hashed)
        if (_opaque.length) throw new Error(
          `[litestone] update on "${modelName}" carries a base and writes ${_opaque.join(', ')}, ` +
          `which @@sync(field) cannot compare: the stored value is an encoding, not the value. ` +
          `Write those columns in a call of their own, without a base.`)
      }

      // ── Everything that touches the database, as one unit ────────────────
      //
      // An update is not one statement either: the parent rows a belongsTo
      // write makes, the UPDATE, the children, the join rows — and the
      // post-update policy check, whose refusal used to be undone by a
      // COMPENSATING UPDATE of the before-snapshot rather than by a rollback.
      // That is visible to concurrent readers in the window, is lost outright
      // if the process dies between the two, and clobbers anything that landed
      // in between. Inside a real transaction the throw IS the rollback
      // (`FJS-638`).
      let updated, beforeRaw, beforeRow, _transResult
      // Did this patch name anything at all? Set inside the transaction and read
      // after it, because what a write with nothing to say must NOT do is decided
      // out here: announce, and file an audit entry (`FJS-368`).
      let _wroteNothing = false
      // Pure — the split reads the payload and nothing else, so it can decide
      // below whether this update needs a transaction at all.
      const { scalar, nested, hasNested } = extractNestedWrites(data)
      const { data: _scalarNoEdge, edgeWrites } = extractEdgeWrites(scalar)
      const _postUpdatePolicy = Boolean(ctx.hasPolicies && ctx.policyMap?.[modelName]?.['post-update'])
      // One UPDATE with no transaction open is its own unit, as a one-statement
      // create is (`FJS-1106`). What keeps the transaction: a nested or edge
      // write (more statements), a post-update policy (its refusal IS the
      // rollback), and @@transitions (the move is graded across an await, and a
      // transaction could open in that gap). On this path the body reaches its
      // statement without yielding — `_upJoined` below is what says so if an
      // edit ever adds an await ahead of it (`FJS-1107`).
      // A hidden parent is thrown only once the UPDATE has reached a row, as
      // SQLite's own refusal is — so it needs a rollback to throw into.
      const _upOwnUnit = !hasNested && !edgeWrites.length && !_postUpdatePolicy && !_upHidden
        && !_tableTransitions && tx.state.depth === 0 && !_cardNotes && !exclTouched(data)
      const _upBody = async () => {
        const extraFKs = hasNested ? await processBelongsToNested(nested) : {}
        data = { ..._scalarNoEdge, ...extraFKs }

        const whereParams = []
        const _flags = { withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf }
        const sdWhereW = applySdFilter(where, _flags)
        const exclWhere = applyEffFilter(applyHtFilter(sdWhereW, htMode(_flags)), _flags)
        const whereSql = buildWhereWithEncryption(exclWhere, whereParams)
        if (!whereSql) throw new Error(`update on "${tableName}" requires a where clause`)

        // ── @@sync(field) — merge, or name the columns two people contend over ─
        // The WHERE is built above this and the SET below it, because the merge
        // decides what the SET says: a column the writer did not actually move
        // is dropped, and one only they moved is applied against the row as it
        // stands now rather than the one they read.
        //
        // Costs one read and only on the losing side of a race — a version that
        // still matches never reaches here, so a model declaring `field` pays
        // nothing for it on an uncontested write.
        if (base !== undefined && _expectVersion != null) {
          const _cur = readDb.query(`SELECT * FROM "${tableName}" WHERE ${whereSql}`).get(...whereParams)
          if (_cur && _cur[col(_versionField)] !== _expectVersion) {
            const _remote = {}
            for (const f of Object.keys(data ?? {})) _remote[f] = _cur[col(f)]
            const { apply, conflicts } = threeWay({ base, local: data, remote: _remote })
            // Invariant 7 through a new door: a protected column says THAT it
            // diverged and never what either side holds, so take-local or
            // take-remote stays answerable without rendering the value
            // (`FJS-D336`).
            if (conflicts.length) throw new SyncConflictError(modelName, conflicts.map(c => ({
              column: c.column,
              base:   redactValue(c.column, c.base),
              local:  redactValue(c.column, c.local),
              remote: redactValue(c.column, c.remote),
            })))
            data = apply
            // The row moved and the merge says nobody contested it, so the
            // precondition becomes where the row actually is — otherwise the
            // statement below matches nothing and reports the conflict this
            // just resolved.
            _expectVersion = _cur[col(_versionField)]
          }
        }

        const { data: _upValues, ops: _upOps } = extractWriteOps(data)
        const row       = writeData(_upValues, { system, fieldWrite: 'sql', stamped })
        const setParams = []
        const setCols   = [
          ...Object.keys(row).map(c => setFragment(c, row[c], setParams)),
          ..._upOps.map(o => setFragmentExpr(o.col, o.expr, o.params, setParams)),
        ].join(', ')
        if (ctx.selfRelationMap?.[modelName] && ctx.selfRelationMap[modelName].some(r => r.fkField in (data ?? {}))) {
          const _idf = ctx.selfRelationMap[modelName][0].referencedField
          assertNoParentCycle(
            readDb.query(`SELECT "${_idf}" AS _id FROM "${tableName}" WHERE ${whereSql}`).all(...whereParams).map(r => r._id),
            data,
          )
        }
        // Append update policy filter to WHERE
        const updatePolicy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'update', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
        const finalWhereSql = updatePolicy ? `(${whereSql}) AND (${updatePolicy.sql})` : whereSql
        const finalWhereParams = updatePolicy ? [...whereParams, ...updatePolicy.params] : whereParams

        // ── Logging + post-update rollback: capture before snapshot ────────────
        // Also needed when post-update policy exists so rollback has data to revert with.
        const needsBeforeRow = tableHasLogWork || (ctx.hasPolicies && ctx.policyMap?.[modelName]?.['post-update'])
        // Two snapshots of one row, and the rollback needs the RAW one. read()
        // parses Json to objects and coerces booleans, and a SQLite parameter
        // cannot be an object — reverting from it threw "Binding expected string,
        // TypedArray, boolean, number, bigint or null" out of the revert, so the
        // denial never surfaced AND the denied write stayed applied. Its keys are
        // also the table's columns exactly: read() adds computed and @from fields
        // that no UPDATE can name, and strips @guarded ones.
        beforeRaw = needsBeforeRow
          ? readDb.query(`SELECT * FROM "${tableName}" WHERE ${whereSql}`).get(...whereParams)
          : null
        beforeRow = beforeRaw ? read(beforeRaw, { mode: 'single' }) : null

        // ── Transition enforcement ────────────────────────────────────────────
        // Check before SQL: validates from-state, throws TransitionViolationError if invalid.
        // Note: uses whereParams (original, no policy filter) for the current-value SELECT.
        _transResult = _tableTransitions ? await checkTransitions(row, whereParams, whereSql, system, _move) : null
        // Every no-match reader below reads the row UNSCOPED to name why — the
        // version, the seal, the move's refusal — so a row outside the caller's
        // read scope leaves before any of them can describe it.
        if (_transResult === NOT_VISIBLE) return true
        // If transitions apply, narrow WHERE to include AND field = currentValue (optimistic lock)
        const { sql: _txWhereSql, params: _txWhereParams } = _transResult
          ? applyTransitionWhereClause(_transResult, finalWhereSql, finalWhereParams)
          : { sql: finalWhereSql, params: finalWhereParams }

        // ── @version — the compare half of the swap ─────────────────────────────
        // Same shape as applyTransitionWhereClause above: narrow the WHERE by the
        // value the caller read, so a row that moved simply does not match. The
        // bump rides the SET clause, which also means a versioned update always
        // has a column to write even when `data` was otherwise empty.
        const _vWhereSql0    = _expectVersion == null ? _txWhereSql : `(${_txWhereSql}) AND "${col(_versionField)}" = ?`
        const _vWhereParams0 = _expectVersion == null ? _txWhereParams : [..._txWhereParams, _expectVersion]
        // The third link in the same chain: the caller's where, then the policy,
        // then the move's from-state, then the version, then the seal. Each one
        // narrows and none of them reports — the row simply does not match, which
        // is what makes the refusal helpers below the whole of the diagnosis.
        const _vSealed = sealWhereClause(_vWhereSql0, _vWhereParams0)
        // …and the model's own columns, where it is one that seals.
        const _vSelf = sealSelfClause(data, _vSealed.sql, _vSealed.params)
        const _vWhereSql    = _vSelf.sql
        const _vWhereParams = _vSelf.params
        // The bump rides the SET clause — but only where the caller actually
        // wrote something. It used to be appended unconditionally, which meant a
        // versioned update MANUFACTURED a column to write when `data` was
        // otherwise empty, so a patch whose only key was `version` was a real
        // write: the column went up, `@updatedAt` moved with it, and every other
        // open editor of that row was told it was stale for a change nobody made
        // (`FJS-368`). The value is a precondition the client sends back, not a
        // value to write, so a form submitted with nothing edited became a write.
        //
        // A model with no `@version` already answered this correctly — the else
        // branch below reads the row back and issues no statement — so the two
        // spellings disagreed about the same patch, which is the whole finding.
        // Nested and edge writes are a real change to this row's meaning and
        // still earn the bump; only a patch that names nothing at all does not.
        const _touchesRow   = Boolean(setCols) || hasNested || edgeWrites.length > 0
        _wroteNothing       = !_touchesRow
        const _setColsBase  = !_versionField || !_touchesRow ? setCols
          : [setCols, `"${col(_versionField)}" = "${col(_versionField)}" + 1`].filter(Boolean).join(', ')
        // Only a write that had something to say moves the stamp: an update
        // naming no column issues no statement at all below, and the trigger it
        // used to lean on never fired for one either.
        const _setColsV     = _setColsBase
          ? [_setColsBase, ...stampSets(Object.keys(row))].join(', ')
          : _setColsBase

        // No rows changed can mean three different things. Not-found and
        // policy-blocked both return null (the documented contract); a row that is
        // still there at a different version is the one worth raising, because the
        // caller can re-read and re-apply.
        const throwIfVersionMoved = () => {
          if (_expectVersion == null) return
          const cur = readDb.query(`SELECT "${col(_versionField)}" AS v FROM "${tableName}" WHERE ${whereSql}`).get(...whereParams)
          if (cur && cur.v !== _expectVersion)
            throw new VersionConflictError(modelName, _versionField, _expectVersion, cur.v)
        }

        // A transition that changed no rows is one of two opposite things, and
        // they take opposite answers: a racing writer moved the row, which is
        // worth retrying, or the update POLICY excluded it, which never is.
        // checkTransitions already proved the row existed at `from` before the
        // statement ran, so re-reading that one column separates them — still at
        // `from` means nothing moved and the policy is what refused.
        //
        // Both used to report a conflict, so a policy refusal reached a caller as
        // a 409 with retryable: true and isStaleWrite() re-applied it forever,
        // against a rule that would refuse every attempt — while telling the
        // person the row had changed when it had not.
        const throwTransitionRefusal = () => {
          if (updatePolicy) {
            const cur = readDb.query(`SELECT "${_transResult.field}" AS v FROM "${tableName}" WHERE ${whereSql}`).get(...whereParams)
            if (cur && cur.v === _transResult.from) throw new AccessDeniedError(
              `"${modelName}.${_transResult.transitionName}" was refused by an @@allow/@@deny policy on update`,
              { model: modelName, operation: 'update' },
            )
          }
          // Where the row actually ended up is what makes the answer usable, and
          // it is what decides whether a retry can ever work — so it is read
          // rather than left unknown. The policy branch above has already read
          // this column when there is an update policy; one more read on the
          // losing side of a race is not a cost worth carrying a flag for.
          const cur = readDb.query(`SELECT "${_transResult.field}" AS v FROM "${tableName}" WHERE ${whereSql}`).get(...whereParams)
          throw new TransitionConflictError(tableName, _transResult.field, _transResult.from, _transResult.to,
            { actual: cur ? cur.v : undefined, move: _transResult.transitionName })
        }

        // Nothing below yields before the statement. An update that chose to run
        // without a transaction and finds one open now would join it and go
        // with its rollback, which is the defect `FJS-638` closed — so it says
        // so rather than writing.
        if (_upOwnUnit && tx.state.depth !== 0) throw new Error(
          `[litestone] update on "${modelName}" decided to run as its own statement and a transaction opened ` +
          `before it wrote — something in update() now yields ahead of the write. This is a defect in litestone (FJS-1107).`)

        updated = null
        if (_setColsV && exclTouched(data)) {
          noteExclusionBySql(_vWhereSql, _vWhereParams)
          noteExclusion(data)
        }
        if (_setColsV) {
          // select: false + no post-update side-effects → use run(), skip RETURNING entirely
          // Note: tableHasLogWork forces RETURNING even with select: false — the log needs
          // before/after snapshots. select: false has no perf benefit on @@log models.
          const _canSkipReturn = select === false
            && !tableHasLogWork
            && !(ctx.hasPolicies && ctx.policyMap?.[modelName]?.['post-update'])
            && !hasNested
            && !edgeWrites.length
          if (_canSkipReturn) {
            const _upSql = `UPDATE "${tableName}" SET ${_setColsV} WHERE ${_vWhereSql}`
            const _upParams = [...setParams, ..._vWhereParams]
            const _nt = needsTiming()
            const _upT0 = _nt ? performance.now() : 0
            // An update moving a column ONTO a value another row holds raises the
            // same constraint a create does, and had none of the same answers.
            try { writeDb.run(_upSql, ..._upParams) }
            catch (e) { throw asConstraintError(e, row) }
            const _upChanges = rowsChanged(writeDb)
            fireQuery({ operation: 'update', args: { where, data, include, select }, sql: _upSql, params: _upParams, duration: _nt ? performance.now() - _upT0 : 0, rowCount: _upChanges })
            if (!_upChanges) {
              if (_transResult) throwTransitionRefusal()
              throwIfVersionMoved()
              throwIfSealedSelf(_vSelf.frozen, _vWhereSql0, _vWhereParams0)
              throwIfSealed(_vWhereSql0, _vWhereParams0, 'update')
              return true
            }
            fireRowEvent('update', 'update', null)
            if (plugins?.hasPlugins) await plugins.afterWrite(modelName, 'update', null, ctx)
            return true
          }
          const _upSql = `UPDATE "${tableName}" SET ${_setColsV} WHERE ${_vWhereSql} RETURNING *`
          const _upParams = [...setParams, ..._vWhereParams]
          const _nt = needsTiming()
          const _upT0 = _nt ? performance.now() : 0
          // RETURNING * gives the updated row directly — no follow-up SELECT needed.
          // Uses writeDb so it works inside open transactions.
          // The parent this row names BEFORE the statement: an update that moves
          // a foreign key leaves one parent as surely as it joins another, and
          // afterwards no row points at the old one.
          noteCardinalityBySql(_vWhereSql, _vWhereParams)
          const _upMoves = _upHidden && movesOnto(_upHidden, _vWhereSql, _vWhereParams)
          try { updated = read(writeDb.query(_upSql).get(..._upParams), { mode: 'single', hydrateFrom: true }) }
          catch (e) { throw asConstraintError(e, row) }
          if (updated && _upMoves) throw _upHidden
          noteCardinality(updated)
          fireQuery({ operation: 'update', args: { where, data, include, select }, sql: _upSql, params: _upParams, duration: _nt ? performance.now() - _upT0 : 0, rowCount: updated ? 1 : 0 })
          if (!updated) {
            if (_transResult) throwTransitionRefusal()
            throwIfVersionMoved()
            throwIfSealedSelf(_vSelf.frozen, _vWhereSql0, _vWhereParams0)
            throwIfSealed(_vWhereSql0, _vWhereParams0, 'update')
            return true
          }
        } else {
          // No columns to set — read back to return current row.
          //
          // The precondition is still a question, and it is asked here for the
          // same reason it is asked on the writing path: the caller is telling
          // this boundary which version they read, and a stale one means their
          // view is wrong whether or not they were writing. Answering a no-op
          // success would confirm a stale screen.
          throwIfVersionMoved()
          updated = read(readDb.query(`SELECT * FROM "${tableName}" WHERE ${whereSql}`).get(...whereParams), { mode: 'single', hydrateFrom: true })
        }
        if (!updated) return null

        // ── post-update policy ───────────────────────────────────────────────
        // Evaluate post-update conditions against the new row state. The throw
        // is the rollback: this runs inside the transaction opened above, so
        // the refused write is never visible and never has to be undone. It
        // used to be undone by writing the before-snapshot back, which is a
        // different thing wearing the same word — the denied state was readable
        // by anything looking in the window, a crash between the two left it
        // permanently, and a concurrent write landing in between was clobbered
        // by the revert.
        if (ctx.hasPolicies && ctx.policyMap[modelName]?.['post-update'])
          checkPostUpdatePolicy(modelName, updated, ctx, ctx.policyMap, ctx.schema, ctx.relationMap)

        const pkField = ctx.models[modelName]?.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
        await processHasManyNested(nested, updated[pkField], updated)
        applyEdgeWrites(edgeWrites, updated[pkField], scopedBy)
        return false
      }
      const _upDone = _upOwnUnit ? await _upBody() : await tx.exclusive(_upBody)
      // ── Committed from here ──────────────────────────────────────────────
      if (_upDone) return null
      const ps = parseArgs(select === false ? null : select, include)
      if (ps || include) withIncludes([updated], ps, include)
      const finalRow = select === false ? null : finalizeOne(updated, ps)
      // The same suppression `emitTransitionEvent` applies, asked here so the
      // update can say whether the move is going to be announced separately.
      // A patch that named no column wrote nothing, so there is nothing to
      // announce, nothing for a plugin to observe and nothing to file. It used
      // to do all three: every open tab was sent back to the server and the
      // trail gained an `update` entry whose before and after are the same row
      // (`FJS-368`). `fireCollectionEvent` has said the same thing one scope
      // along for as long as it has existed — *nothing matched, so nothing
      // changed* — and this is that rule for a single row.
      //
      // The row is still READ BACK and returned, which is what separates a no-op
      // from a refusal: the caller asked what the row is and gets an answer.
      if (!_wroteNothing) {
        fireRowEvent('update', 'update', finalRow,
          _transResult ? _transResult.transitionName : null)
        emitTransitionEvent(_transResult, updated)
        if (plugins?.hasPlugins) await plugins.afterWrite(modelName, 'update', finalRow, ctx)
        // ── Logging: emit after ─────────────────────────────────────────────
        // The move by name, and not only for an announced one: an abandon and a
        // cancel write the same before and after, so a SYSTEM-scoped move that
        // is not announced is exactly the one the trail must still tell apart.
        if (tableHasLogWork && updated) emitLogs('update', [updated], {
          before: beforeRow, after: updated, transition: _transResult?.transitionName ?? null, system,
        })
      }
      return finalRow
    },

    // ── updateMany ──────────────────────────────────────────────────────────
    async updateMany({ where, data, system, announce, withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf } = {}) {
      const _umMove = _bulkTransitionField(data, 'updateMany')
      if (_umMove) throw new BulkTransitionError(modelName, _umMove, 'updateMany')
      const { mode: _umMode, wantRows: _umWantRows } = announceFor(announce)
      refuseSystemEntries(system, ['update'])
      await enforceValueSets(modelName, [data], ctx, { where })
      if (plugins?.hasPlugins) await plugins.beforeUpdate(modelName, { where, data, system }, ctx)
      // Same stamp update() runs. Missing it here was worse than missing it
      // anywhere else: @updatedAt is a SQL trigger, so the timestamp moved while
      // the identity beside it stayed at whoever wrote last through update() —
      // a row reading "just edited by Bob" when Ann edited it.
      const stamped = new Set()
      data = stampFromAuth(data, ctx.updatedByMap?.[modelName], ctx.auth, stamped)
      const [_umHidden] = await hiddenParents([data], [stamped])
      // @version bumps here but is never required: a where clause matching many
      // rows matches many versions, so there is no single value to compare
      // against. Bumping is the part that matters — without it a bulk write
      // would leave every open editor's version looking current.
      const _umVersion = ctx.versionMap?.[modelName]
      if (_umVersion && data && _umVersion in data) { data = { ...data }; delete data[_umVersion] }
      const { data: _umValues, ops: _umOps } = extractWriteOps(data)
      const row       = writeData(_umValues, { system, fieldWrite: 'sql', stamped })
      // SET params and WHERE params are collected apart and joined at the end.
      // Sharing one array made the statement depend on the order the two halves
      // happened to be built in, which is why the empty-SET case below could not
      // be handled where it belongs.
      const setParams = []
      const setCols  = [
        ...Object.keys(row).map(c => setFragment(c, row[c], setParams)),
        ..._umOps.map(o => setFragmentExpr(o.col, o.expr, o.params, setParams)),
        ...(_umVersion ? [`"${col(_umVersion)}" = "${col(_umVersion)}" + 1`] : []),
      ].join(', ')
      const whereParams = []
      const _flags = { withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf }
      const sdWhereW = applySdFilter(where, _flags)
      const exclWhere = applyEffFilter(applyHtFilter(sdWhereW, htMode(_flags)), _flags)
      const whereSql = buildWhereWithEncryption(exclWhere, whereParams)
      const updateManyPolicy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'update', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
      if (updateManyPolicy) whereParams.push(...updateManyPolicy.params)
      const finalWhere0 = whereSql && updateManyPolicy ? `(${whereSql}) AND (${updateManyPolicy.sql})`
                        : whereSql || updateManyPolicy?.sql || null
      const _umSeal     = sealWhereClause(finalWhere0, whereParams)
      const _umSelf     = sealSelfClause(data, _umSeal.sql, _umSeal.params)
      const finalWhere  = _umSelf.sql || null
      const _umWhereP   = _umSelf.params

      // No columns left to set. `UPDATE "t" SET  WHERE …` is a SQL syntax error,
      // and the payload that lands here is an ordinary form post whose fields no
      // longer match the model — stripping unknown keys is the mass-assignment
      // protection doing its job, so this is reachable without any mistake at the
      // call site. `update` answers the unchanged row; the bulk analogue is the
      // count of rows the where matched, having written nothing to them.
      if (!setCols) {
        const _cSql = `SELECT COUNT(*) AS n FROM "${tableName}"${finalWhere ? ` WHERE ${finalWhere}` : ''}`
        const count = readDb.query(_cSql).get(..._umWhereP)?.n ?? 0
        fireQuery({ operation: 'updateMany', args: { where, data }, sql: _cSql, params: _umWhereP, duration: 0, rowCount: count })
        return { count }
      }
      const params = [...setParams, ..._umWhereP]
      // Stamped after the empty-payload return above, for the same reason
      // update() stamps only a statement that had something else to say.
      const _umSetCols = [setCols, ...stampSets(Object.keys(row))].join(', ')
      // A logged model takes RETURNING so the trail can name the rows it changed.
      // Still one statement — bulk ops record WHICH rows and WHAT operation, never
      // their contents (same shape as createMany; see emitLogs).
      const _umNeedRows = tableHasLogWork || _umWantRows
      const _umSql = `UPDATE "${tableName}" SET ${_umSetCols}${finalWhere ? ` WHERE ${finalWhere}` : ''}`
                   + (_umNeedRows ? ` RETURNING *` : '')
      const _nt = needsTiming()
      const _umT0 = _nt ? performance.now() : 0
      // The lock, so a bulk write cannot be swallowed by another context's
      // open transaction and lost on its rollback (`FJS-638`).
      let _umRows = null
      let count
      await tx.wrapExclusive(() => {
        // The parents these rows name now — an update that moves a foreign key
        // leaves one parent as surely as it joins another, and after the
        // statement the old one is unreachable from any row.
        noteCardinalityBySql(finalWhere, _umWhereP)
        if (exclTouched(data)) { noteExclusionBySql(finalWhere, _umWhereP); noteExclusion(data) }
        const _umMoves = _umHidden && movesOnto(_umHidden, finalWhere, _umWhereP)
        try {
          _umRows = _umNeedRows ? writeDb.query(_umSql).all(...params) : null
          if (!_umRows) writeDb.run(_umSql, ...params)
        } catch (e) { throw asConstraintError(e, row) }
        count = _umRows ? _umRows.length : rowsChanged(writeDb)
        // Thrown only when a row was reached, as SQLite's own refusal is; the unit rolls back.
        if (count && _umMoves) throw _umHidden
        if (_umRows) for (const r of _umRows) noteCardinality(read(r))
        else noteCardinalityBySql(finalWhere, _umWhereP)
      })
      fireQuery({ operation: 'updateMany', args: { where, data }, sql: _umSql, params, duration: _nt ? performance.now() - _umT0 : 0, rowCount: count })
      if (tableHasLogWork && _umRows?.length) emitLogs('update', _umRows, { system })
      announceBulk({ mode: _umMode, event: 'update', operation: 'updateMany', where, count, rows: _umRows })
      return { count }
    },

    // ── upsert ──────────────────────────────────────────────────────────────
    async upsert({ where, create: createData, update: updateData, include, select, system,
                   withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf } = {}) {
      // An operator is refused here rather than passed to the update half. This
      // method has a single-statement fast path whose SET clause reads from
      // `excluded`, and a slow path that calls update() — one would apply the
      // operator and the other could not, which is the drift the refusal exists
      // to prevent.
      extractWriteOps(createData, { where: 'upsert' })
      extractWriteOps(updateData, { where: 'upsert' })
      refuseSystemEntries(system, ['create', 'update'])
      // The fast path's two halves; the slow path is create() and update(),
      // which grade their own.
      const _upsHidden = await hiddenParents([createData, updateData])
      // ── an upsert addressed by a relator's relata ──────────────────────
      //
      // Refused rather than answered, because the answer would be a wrong one
      // that compiles. The fast path below needs ONE unique column, so a pair
      // never reaches it and every relator upsert falls to the slow path —
      // findFirst, then update what it found. On a repeatable relationship
      // `{recipeId, serverId}` matches every run there has ever been, so the
      // call silently overwrites the oldest instead of recording a new one.
      //
      // The declaration is what gives this the authority to be sure. A relator
      // states how its rows are identified, so an upsert addressing them any
      // other way is provably not the write the caller meant — which is not
      // something litestone can say about an ordinary non-unique `where`.
      const _relator = ctx.models[modelName]?.attributes?.find(a => a.kind === 'relator')
      if (_relator && where) {
        const given = new Set(Object.keys(where))
        if (_relator.fields.some(f => given.has(f))) {
          const keyed = _relator.repeat === 'once' ? _relator.fields
                      : _relator.discriminator     ? [..._relator.fields, _relator.discriminator]
                      : null
          const missing = keyed?.filter(c => !given.has(c)) ?? null
          if (!keyed) throw new ValidationError([{
            path: ['where'],
            message:
              `${modelName} declares @@relator([${_relator.fields.join(', ')}], many), so the same pair may ` +
              `happen any number of times and there is no row for these columns to name. An upsert here would ` +
              `overwrite an earlier one. Use create(), or address the row by its id.`,
          }])
          if (missing.length) throw new ValidationError([{
            path: ['where'],
            message:
              `${modelName} declares @@relator([${_relator.fields.join(', ')}], many: ${_relator.discriminator}), ` +
              `so what identifies a row is ${keyed.join(' + ')} — and this where names ` +
              `${missing.join(', ')} nowhere. Without it these columns match every occurrence, and the upsert ` +
              `would overwrite one of them. Name ${missing.join(' and ')}, or address the row by its id.`,
          }])
        }
      }
      // Both halves, because either may be the one that lands — and they are two
      // calls rather than one array: a create-shaped payload IS the row, while
      // the update half is about a row that already exists, so a dependent
      // binding grades it against `where` (`FJS-D122`).
      await enforceValueSets(modelName, [createData], ctx)
      await enforceValueSets(modelName, [updateData], ctx, { where })
      refuseOffEntry([createData])
      // Threaded through to both halves: the lookup has to SEE the row the
      // update would write, or an upsert against an excluded row reads as
      // absent and tries to INSERT one that is already there.
      const _upFlags = { withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf }
      // ── Single-statement fast path ─────────────────────────────────────────
      // When no hooks / plugins / policies / events / logs / transitions /
      // soft-delete / window / global filters / field policies / sequences /
      // nested writes are in play and `where` targets exactly one unique column,
      // compile to one cached `INSERT ... ON CONFLICT(col) DO UPDATE ...
      // RETURNING *` — one round trip instead of findFirst + update/create
      // (measured ~6x). Any feature that needs the split path falls through
      // to the original read-then-write implementation below.
      fastPath: if (
        !plugins?.hasPlugins && !emitter && !ctx._eventListeners.size &&
        !ctx.hasPolicies && !tableHasLogWork && !_tableTransitions && !_exclNotes &&
        !softDelete && !hasTemplates && !effective && !hasFieldPolicy && !_rawFilter &&
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
        // The fast path compiles one INSERT … ON CONFLICT and has nowhere to put
        // a nested write, so it must decline the call rather than take it: read
        // as *no nested writes*, this handed `{ create: [...] }` to the column
        // validator, which refused a legitimate write with `lines: must be an
        // array`.
        if (extractNestedWrites(createData).hasNested) break fastPath
        if (extractNestedWrites(updateData).hasNested) break fastPath

        // Same data massage as create(): auto-@id, auth()/field-ref defaults
        let cData = createData
        const _fpStamped = new Set()
        const _fpAutoId = ctx.autoIdMap?.[modelName]
        if (_fpAutoId && cData[_fpAutoId.field] == null) {
          noteStamp(_fpStamped, cData, _fpAutoId.field)
          cData = { ...cData, [_fpAutoId.field]: _fpAutoId.generate() }
        }
        cData = applyGeneratedDefaults(cData, ctx.generatedDefaultMap?.[modelName], _fpStamped)
        cData = applyAuthDefaults(cData, ctx.authDefaultMap?.[modelName], ctx.auth, _fpStamped)
        cData = stampFromAuth(cData, ctx.createdByMap?.[modelName], ctx.auth, _fpStamped)
        const _fpFieldRefs = ctx.fieldRefDefaultMap?.[modelName]
        if (_fpFieldRefs?.length) {
          const stamps = {}
          for (const { field, sourceField } of _fpFieldRefs) {
            if (cData[field] == null && cData[sourceField] != null) {
              noteStamp(_fpStamped, cData, field)
              stamps[field] = cData[sourceField]
            }
          }
          if (Object.keys(stamps).length) cData = { ...cData, ...stamps }
        }

        // A field write predicate has to read the STORED row, and this branch is
        // one statement with no row in hand — its DO UPDATE would grade the
        // payload, which is exactly the fail-open `FJS-433` describes. The slow
        // path reads then updates, where the CASE in the SET applies.
        if (_hasFieldWrite) break fastPath

        // writeData runs transforms + validation on both branches' data
        const insRow = writeData({ ...cData, [wKey]: cData[wKey] ?? wVal }, { requireAll: true, system, stamped: _fpStamped, creating: true })
        const updRow = writeData(updateData, { system })
        if (_upsHidden[0]) throw _upsHidden[0]
        // update() asks whether the key MOVES, which one statement cannot.
        if (_upsHidden[1]) break fastPath
        const insCols = Object.keys(insRow)
        const updCols = Object.keys(updRow).filter(c => c !== wKey)
        if (!insCols.length || !updCols.length) break fastPath
        if (_sealInsertSql) break fastPath
        if (_sealSelf && _immutableWriteKeys.size) break fastPath

        // Only the DO UPDATE branch needs the stamp — an INSERT takes the
        // column DEFAULT, which is the same expression.
        const _fpSets = [...updCols.map(c => `"${col(c)}" = ?`), ...stampSets(updCols)]
        const _fpSql =
          `INSERT INTO "${tableName}" (${insCols.map(c => `"${col(c)}"`).join(', ')}) ` +
          `VALUES (${insCols.map(() => '?').join(', ')}) ` +
          `ON CONFLICT("${wKey}") DO UPDATE SET ${_fpSets.join(', ')} ` +
          `RETURNING *`
        const _fpParams = [...insCols.map(c => insRow[c] ?? null), ...updCols.map(c => updRow[c] ?? null)]
        const _nt = needsTiming()
        const _fpT0 = _nt ? performance.now() : 0
        try {
          const result = read(writeDb.query(_fpSql).get(..._fpParams), { mode: 'single', hydrateFrom: true })
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
      // `system` reaches both halves: dropped here, a column the call named was
      // refused on this path and written on the fast one.
      const existing = await this.findFirst({ where, ..._upFlags })
      if (existing) {
        return this.update({ where, data: updateData, include, select, system, _bypassVersion: true, ..._upFlags })
      }
      // Attempt create; if unique constraint fires (race), fall back to update.
      //
      // The fallback assumes the conflict means a LIVE row appeared between the
      // findFirst above and this insert, which is true of a race and false of a
      // soft-deleted row: the update filters deleted rows too, so it matched
      // nothing and upsert answered `null` having written nothing at all
      // (FJS-276). `create` names that case now, and it must not be swallowed
      // here — an upsert cannot resurrect a row the caller did not ask it to.
      try {
        return await this.create({ data: createData, include, select, system })
      } catch (e) {
        if (e instanceof SoftDeletedUniqueError) throw e
        if (isUniqueConflict(e)) {
          return this.update({ where, data: updateData, include, select, system, _bypassVersion: true, ..._upFlags })
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

    async upsertMany({ data, conflictTarget, update: updateFields, system, announce } = {}) {
      // The `update:` half is an ON CONFLICT SET over rows nobody read, which is
      // `updateMany`'s problem exactly. The insert half is a create, graded
      // against the entry below.
      const _upMove = _bulkTransitionField(updateFields, 'upsertMany')
      if (_upMove) throw new BulkTransitionError(modelName, _upMove, 'upsertMany')
      if (!data?.length) return { count: 0 }
      for (const row of data) extractWriteOps(row, { where: 'upsertMany' })
      refuseSystemEntries(system, ['create', 'update'])
      await enforceValueSets(modelName, data, ctx)
      const { mode: _usMode, wantRows: _usWantRows } = announceFor(announce)
      // The create/update split costs one SELECT per row and is what a logged
      // model already pays for its trail. At the `rows` tier it is worth paying
      // again: the caller asked for precision, and knowing which half a row fell
      // in is the difference between announcing `create` and announcing `update`
      // — the compromise the collection form has to make and this one does not.
      const _usNeedRows = tableHasLogWork || _usWantRows
      if (plugins?.hasPlugins) await plugins.beforeCreate(modelName, { data, system }, ctx)
      // The conflict half is an update and is graded as one — without this a
      // caller below the update gate overwrote any row by naming its key
      // (`FJS-1700`). Graded whether or not a row conflicts, as updateMany is
      // for a where that matches nothing: the standing is the call's, not the
      // row's. Only an explicit `update: []` is insert-only. The shape carries
      // the KEYS the conflict would set, which is what a capability grades.
      if (plugins?.hasPlugins && !(Array.isArray(updateFields) && !updateFields.length)) {
        const _usKeys = updateFields
          ? [updateFields].flat()
          : [...new Set(data.flatMap(d => Object.keys(d)))]
              .filter(k => !(conflictTarget ? [conflictTarget].flat() : [idField]).includes(k))
        await plugins.beforeUpdate(modelName, { data: Object.fromEntries(_usKeys.map(k => [k, undefined])), system }, ctx)
      }
      refuseOffEntry(data)
      const _usHidden = await hiddenParents(data)

      const autoId       = ctx.autoIdMap?.[modelName]
      const genDefaults  = ctx.generatedDefaultMap?.[modelName]
      const authDefaults = ctx.authDefaultMap?.[modelName]
      const createdBys   = ctx.createdByMap?.[modelName]
      const updatedBys   = ctx.updatedByMap?.[modelName]
      const usVersion    = ctx.versionMap?.[modelName]

      // Which author columns WE are about to fill. An upsert is an insert for
      // some rows and an update for others, and a create-time column must not
      // ride the ON CONFLICT SET clause — a conflict is an update, and an update
      // may not rewrite who created the row. Columns the CALLER supplied are not
      // in this set: naming one is an explicit request, and excluding it would
      // change behavior that predates the stamps.
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
      await tx.wrapExclusive(() => {
        const rows = data.map((item, i) => {
          let d = item
          const stamped = new Set()   // per row — see createMany
          if (autoId && (d == null || d[autoId.field] == null)) {
            noteStamp(stamped, d, autoId.field)
            d = { ...(d ?? {}), [autoId.field]: autoId.generate() }
          }
          d = applyGeneratedDefaults(d, genDefaults, stamped)
          d = applyAuthDefaults(d, authDefaults, ctx.auth, stamped)
          d = stampFromAuth(d, createdBys, ctx.auth, stamped)
          d = stampFromAuth(d, updatedBys, ctx.auth, stamped)
          if (usVersion) { noteStamp(stamped, d, usVersion); d = { ...(d ?? {}), [usVersion]: 1 } }
          d = applySequences(d, modelName, ctx.sequenceMap, writeDb, stamped)
          try { return writeData(d, { requireAll: true, system, stamped, creating: true }) }
          catch (e) { throw asBatchRowError(e, i, data.length, null) }
        })

        const target  = conflictTarget
          ? (Array.isArray(conflictTarget) ? conflictTarget : [conflictTarget])
          : [idField]

        // ON CONFLICT DO UPDATE is resolved by SQLite, which has never heard of
        // soft delete — so a batch whose conflict key matched a DELETED row
        // wrote the update INTO that row and reported `{count: 1}`. The write
        // landed where no read returns it and `deletedAt` was never cleared, so
        // it was invisible for good and the caller was told it succeeded
        // (FJS-276). Asked BEFORE the statement runs, because afterwards the
        // write has already happened.
        if (softDelete) {
          for (const [i, row] of rows.entries()) {
            if (target.some(c => row[c] === undefined)) continue
            const hit = writeDb.query(
              `SELECT * FROM "${tableName}" WHERE ${target.map(c => `"${col(c)}" = ?`).join(' AND ')} ` +
              `AND "${col('deletedAt')}" IS NOT NULL LIMIT 1`
            ).get(...target.map(c => row[c] ?? null))
            if (hit) throw asBatchRowError(new SoftDeletedUniqueError(
              modelName, target, target.map(c => row[c]), hit[idField], idField), i, rows.length, row)
          }
        }

        // ── Which rows are inserts and which are updates ─────────────────────
        //
        // Both halves are policied and they are policied by DIFFERENT rules, so
        // the split has to be known before either can be applied: a row that
        // will insert is a create and a row that will conflict is an update.
        // It was neither — `create()` refused planting a row owned by somebody
        // else and `upsertMany` planted it, `update()` refused writing to their
        // row and `upsertMany` wrote it (`FJS-720`). `createMany` has always
        // checked the create policy one verb along, which is what makes the
        // cost known rather than guessed: the same lookup the audit trail
        // already pays for on a logged model.
        // The lookup is what the CREATE half needs, so it is paid for policies
        // alone: the template guard rides the statement's own WHERE and knows
        // nothing about which rows already exist.
        let present = null
        const keyOf = row => JSON.stringify(target.map(c => row[c] ?? null))
        if (_usNeedRows || ctx.hasPolicies) {
          const clause = target.map(c => `"${c}" = ?`).join(' AND ')
          const lookup = writeDb.prepare(`SELECT 1 FROM "${tableName}" WHERE ${clause} LIMIT 1`)
          present = new Set()
          for (const row of rows) {
            if (lookup.get(...target.map(c => row[c] ?? null))) present.add(keyOf(row))
          }
          if (_usNeedRows) { _usCreated = []; _usUpdated = [] }
        }

        // The INSERT half, refused whole like `createMany`'s — a batch is one
        // call, and half of it landing is a worse answer than none of it.
        if (ctx.hasPolicies) {
          for (const [i, row] of rows.entries()) {
            if (present.has(keyOf(row))) continue
            try { _usHidden[i] = firstRefusal(checkCreate(authStamped(data[i], modelName, ctx)), _usHidden[i]) }
            catch (e) { throw asBatchRowError(e, i, rows.length, data[i]) }
          }
        }

        // The UPDATE half rides SQLite's own `DO UPDATE … WHERE`, where an
        // unqualified column is the EXISTING row — which is exactly the row the
        // update policy is about, and the same predicate `updateMany` puts in
        // its WHERE. A row the policy excludes is skipped rather than refused,
        // for `updateMany`'s reason: a bulk write narrows, it does not throw.
        const _usUpdPolicy = ctx.hasPolicies
          ? buildPolicyFilter(modelName, 'update', ctx, ctx.policyMap, ctx.schema, ctx.relationMap)
          : null
        // A template is a live row in a parallel category, so a bulk write must
        // not reach one it did not ask for — the rule `updateMany` applies
        // through `applyHtFilter` and this statement builds no WHERE to carry.
        const _usGuards = [
          ...(_usUpdPolicy ? [_usUpdPolicy.sql] : []),
          ...(hasTemplatesField ? [`"${hasTemplatesField}" = 0`] : []),
        ]
        const _usGuardSql    = _usGuards.length ? _usGuards.join(' AND ') : null
        const _usGuardParams = _usUpdPolicy?.params ?? []

        // One statement per row shape — see createMany. The SET clause is
        // derived from the shape's own columns, so a row carrying a column the
        // batch's first row omitted updates it on conflict rather than losing it.
        const stmts = new Map()
        const stmtFor = (cols) => {
          const key = cols.join(' ')
          let entry = stmts.get(key)
          if (entry) return entry

          // Build UPDATE SET clause — only the fields that aren't in the conflict target
          // An explicit `update:` list still wins outright — naming an author
          // column there is a deliberate request to move it on conflict.
          const updateCols = updateFields
            ? (Array.isArray(updateFields) ? updateFields : [updateFields]).filter(c => cols.includes(c))
            : cols.filter(c => !target.includes(c) && !authorCols.has(c))

          let s = _sealInsertSql
            ? `INSERT INTO "${tableName}" (${cols.map(c => `"${col(c)}"`).join(', ')}) SELECT ${cols.map(() => '?').join(', ')} WHERE ${_sealInsertSql}`
            : `INSERT INTO "${tableName}" (${cols.map(c => `"${col(c)}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`

          // @version rides the INSERT at 1 and is BUMPED on conflict, never taken
          // from `excluded` — that would reset an existing row to 1 and make every
          // stale editor's version look current again.
          const setPairs = updateCols
            .filter(c => c !== usVersion)
            .map(c => `"${c}" = excluded."${c}"`)
          if (usVersion) setPairs.push(`"${usVersion}" = "${tableName}"."${usVersion}" + 1`)
          // A conflict is an update, so it stamps. `setPairs.length` is what
          // decides whether this row updates at all, so the stamp is added
          // after that test and never turns a DO NOTHING into a DO UPDATE.
          if (setPairs.length) setPairs.push(...stampSets(updateCols))

          if (setPairs.length) {
            const conflictSql = target.map(c => `"${c}"`).join(', ')
            s += ` ON CONFLICT(${conflictSql}) DO UPDATE SET ${setPairs.join(', ')}`
            if (_usGuardSql) s += ` WHERE ${_usGuardSql}`
          } else {
            s += ` ON CONFLICT DO NOTHING`
          }

          // RETURNING on a logged model, so the entry names rows by their real id —
          // see createMany. ON CONFLICT DO NOTHING returns nothing for a skipped row.
          if (_usNeedRows) s += ` RETURNING *`
          entry = { cols, sql: s, stmt: writeDb.prepare(s) }
          stmts.set(key, entry)
          return entry
        }

        for (const [_i, row] of rows.entries()) {
          if (_usHidden[_i]) throw asBatchRowError(_usHidden[_i], count, rows.length, row)
          const { cols, stmt } = stmtFor(Object.keys(row))
          const _usSeal = sealInsertGuard(row)
          // The guard's params bind LAST, because `ON CONFLICT … WHERE` is the
          // tail of the statement — after the VALUES and after the seal's own
          // WHERE on the `INSERT … SELECT` form.
          const args = [...cols.map(c => row[c] ?? null), ...(_usSeal?.params ?? []), ..._usGuardParams]
          // A conflict TARGET is handled by ON CONFLICT; anything else — a second
          // @unique, a NOT NULL, an FK — still reaches here as SQLite's message.
          let _usWrote = true
          try {
            if (_usNeedRows) {
              const written = stmt.get(...args)
              if (written) (present.has(keyOf(row)) ? _usUpdated : _usCreated).push(written)
              else if (_usSeal || _usGuardSql) _usWrote = false
            } else {
              stmt.run(...args)
              if (_usSeal || _usGuardSql) _usWrote = rowsChanged(writeDb) > 0
            }
          } catch (e) { throw asBatchRowError(asConstraintError(e, row), count, rows.length, row) }
          // Named like a constraint failure rather than counted: a batch that
          // reports writing a row it did not write is worse than one that stops,
          // and `ON CONFLICT DO NOTHING` is the only other way to get here.
          //
          // A row the update GUARD skipped is the third way and is not a
          // refusal: `updateMany` narrows its WHERE and counts what it moved, so
          // this counts what it moved too. Which is also why the count has to be
          // read from SQLite rather than assumed — the reason this branch exists.
          if (!_usWrote) {
            const refusal = sealRefusal(_usSeal?.parents, 'create')
            if (refusal) throw asBatchRowError(refusal, count, rows.length, row)
          }
          if (_usWrote) { noteExclusion(row); count++ }
        }
        sql = [...stmts.values()].map(e => e.sql).join('\n')
      })
      fireQuery({ operation: 'upsertMany', args: { data, conflictTarget, update: updateFields }, sql, params: null, duration: _nt ? performance.now() - _usT0 : 0, rowCount: count })
      if (tableHasLogWork) {
        if (_usCreated?.length) emitLogs('create', _usCreated, { system })
        if (_usUpdated?.length) emitLogs('update', _usUpdated, { system })
      }
      // At the `rows` tier the split is known, so each half announces truthfully.
      // The COLLECTION form has to pick one for the whole batch and picks
      // `update`: to a list every row named here now exists with new values, and
      // `create` would be wrong for the conflicting majority, which is the
      // ordinary case for an upsert.
      if (_usMode === 'rows' && _usCreated) {
        announceBulk({ mode: 'rows', event: 'create', operation: 'upsertMany', count: _usCreated.length, rows: _usCreated })
        announceBulk({ mode: 'rows', event: 'update', operation: 'upsertMany', count: _usUpdated.length, rows: _usUpdated })
      } else {
        announceBulk({ mode: _usMode, event: 'update', operation: 'upsertMany', count })
      }
      return { count }
    },

    // ── remove ─────────────────────────────────────────────────────────────
    // The default removal operation — always does the right thing:
    //   soft-delete tables  → sets deletedAt = now() (+ cascades under @@softDelete(cascade))
    //   hard-delete tables  → real DELETE FROM
    // Use delete() only when you explicitly need to bypass soft delete.
    async remove({ where, withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf } = {}) {
      if (plugins?.hasPlugins) await plugins.beforeDelete(modelName, { where }, ctx)
      const params   = []
      const _flags = { withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf }
      const sdWhereW = applySdFilter(where, _flags)
      const exclWhere = applyEffFilter(applyHtFilter(sdWhereW, htMode(_flags)), _flags)
      const whereSql = buildWhereWithEncryption(exclWhere, params)
      if (!whereSql) throw new Error(`remove on "${tableName}" requires a where clause`)
      const removePolicy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'delete', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
      const removeFinalSql0    = removePolicy ? `(${whereSql}) AND (${removePolicy.sql})` : whereSql
      const removeFinalParams0 = removePolicy ? [...params, ...removePolicy.params] : params
      // A soft remove is still a removal FROM the document — the row leaves every
      // read of it — so both halves of remove() carry the guard.
      const { sql: removeFinalSql, params: removeFinalParams } =
        sealWhereClause(removeFinalSql0, removeFinalParams0)

      // No unconditional pre-SELECT: the soft path gets the row back from
      // UPDATE ... RETURNING and the hard path from DELETE ... RETURNING, so
      // remove() is one statement on the common path instead of two. The
      // pre-delete "before" snapshot for logging is reconstructed from the
      // RETURNING row (soft delete only changes deletedAt, which was NULL).

      if (softDelete) {
        const ts = nowISO(ctx.now)
        const _rmSets = [`"${col('deletedAt')}" = ?`, ...stampSets(['deletedAt'])].join(', ')
        const _rmSql = `UPDATE "${tableName}" SET ${_rmSets} WHERE ${removeFinalSql} RETURNING *`
        const _nt = needsTiming()
        const _rmT0 = _nt ? performance.now() : 0
        // The stamp and every row the cascade reaches are one unit. Run bare
        // they were N auto-commits, so a cascade that failed part way left a
        // parent removed and half its children live — and the whole walk could
        // be swallowed by another context's open transaction (`FJS-638`). No
        // await inside, so the cheaper sync-body entry point applies.
        let softResult
        await tx.wrapExclusive(() => {
        softResult = read(writeDb.query(_rmSql).get(ts, ...removeFinalParams), { mode: 'single', hydrateFrom: true })
        // A soft delete is a write that moves a COUNT: the row is still there
        // and is no longer one of its parent's children.
        noteCardinality(softResult)
        fireQuery({ operation: 'remove', args: { where }, sql: _rmSql, params: [ts, ...removeFinalParams], duration: _nt ? performance.now() - _rmT0 : 0, rowCount: softResult ? 1 : 0 })
        if (!softResult) return

        // Cascade soft delete to child tables under @@softDelete(cascade)
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
        })
        if (!softResult) { throwIfSealed(removeFinalSql0, removeFinalParams0, 'remove'); return null }

        fireRowEvent('remove', 'remove', softResult)
        if (plugins?.hasPlugins) await plugins.afterWrite(modelName, 'delete', softResult, ctx)
        // ── Logging ──────────────────────────────────────────────────────────
        if (tableHasLogWork) emitLogs('delete', [softResult], { before: { ...softResult, deletedAt: null } })
        return softResult
      }

      const _rmHSql = `DELETE FROM "${tableName}" WHERE ${removeFinalSql} RETURNING *`
      const _nt = needsTiming()
      const _rmHT0 = _nt ? performance.now() : 0
      // The one-statement path stays one statement unless a cascade below has
      // someone to tell, which needs the row before it is gone.
      let _rmHDoomed = null
      const row = await tx.wrapExclusive(() => {
        if (cascadeHeard()) _rmHDoomed = cascadeDoomed(
          readAll(readDb.query(`SELECT * FROM "${tableName}" WHERE ${removeFinalSql}`).all(...removeFinalParams)))
        return read(writeDb.query(_rmHSql).get(...removeFinalParams), { mode: 'single', hydrateFrom: true })
      })
      fireQuery({ operation: 'remove', args: { where }, sql: _rmHSql, params: removeFinalParams, duration: _nt ? performance.now() - _rmHT0 : 0, rowCount: row ? 1 : 0 })
      if (!row) { throwIfSealed(removeFinalSql0, removeFinalParams0, 'remove'); return null }
      fireRowEvent('remove', 'remove', row)
      if (plugins?.hasPlugins) await plugins.afterWrite(modelName, 'delete', row, ctx)
      if (plugins?.hasPlugins) await plugins.afterDelete(modelName, [row], ctx)
      // ── Logging ───────────────────────────────────────────────────────────
      if (tableHasLogWork && row) emitLogs('delete', [row], { before: row })
      await cascadeRemoved(_rmHDoomed)
      return row
    },

    // ── removeMany ─────────────────────────────────────────────────────────
    // Bulk version of remove() — same semantics: soft delete on soft-delete tables,
    // real DELETE FROM on hard-delete tables.
    async removeMany({ where, announce, withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf } = {}) {
      const { mode: _rmMode, wantRows: _rmWantRows } = announceFor(announce)
      const _rmNeedRows = tableHasLogWork || _rmWantRows
      if (plugins?.hasPlugins) await plugins.beforeDelete(modelName, { where }, ctx)
      const params   = []
      const _flags = { withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf }
      const sdWhereW = applySdFilter(where, _flags)
      const exclWhere = applyEffFilter(applyHtFilter(sdWhereW, htMode(_flags)), _flags)
      const whereSql = buildWhereWithEncryption(exclWhere, params)
      const removeManyPolicy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'delete', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
      if (removeManyPolicy) params.push(...removeManyPolicy.params)
      const rmFinalSql0 = whereSql && removeManyPolicy ? `(${whereSql}) AND (${removeManyPolicy.sql})`
                        : whereSql || removeManyPolicy?.sql || null
      // `params` already holds the where's binds then the policy's, in the order
      // the SQL reads them; the guard is appended last, so its binds go last.
      const _rmSeal    = sealWhereClause(rmFinalSql0, [])
      const rmFinalSql = _rmSeal.sql || null
      params.push(..._rmSeal.params)

      // Prefetch affected rows before SQL so afterDelete gets them.
      // Only done when plugins are listening — avoids the SELECT cost otherwise.
      const affectedRows = plugins?.hasPlugins
        ? readAll(readDb.query(`SELECT * FROM "${tableName}"${rmFinalSql ? ` WHERE ${rmFinalSql}` : ''}`).all(...params))
        : []

      if (softDelete) {
        const ts = nowISO(ctx.now)

        // If cascading, fetch affected PKs first so we can cascade precisely
        if (softDeleteCascade) {
          const cascadeTargets = _cascadeTargets()
          if (cascadeTargets.length > 0) {
            const exclWhere2 = injectSoftDeleteFilter(where, 'live')
            const params2 = []
            const whereSql2 = buildWhereWithEncryption(exclWhere2, params2)
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
        const _rmsSets = [`"${col('deletedAt')}" = ?`, ...stampSets(['deletedAt'])].join(', ')
        const _rmsSql = `UPDATE "${tableName}" SET ${_rmsSets}${rmFinalSql ? ` WHERE ${rmFinalSql}` : ''}`
                      + (_rmNeedRows ? ` RETURNING *` : '')
        let _rmsRows, softCount
        await tx.wrapExclusive(() => {
          noteCardinalityBySql(rmFinalSql, params)
          _rmsRows = _rmNeedRows ? writeDb.query(_rmsSql).all(ts, ...params) : null
          if (!_rmsRows) writeDb.run(_rmsSql, ts, ...params)
          softCount = _rmsRows ? _rmsRows.length : rowsChanged(writeDb)
        })
        if (tableHasLogWork && _rmsRows?.length) emitLogs('delete', _rmsRows)
        announceBulk({ mode: _rmMode, event: 'remove', operation: 'removeMany', where, count: softCount, rows: _rmsRows })
        return { count: softCount }
      }

      const _rmnSql = `DELETE FROM "${tableName}"${rmFinalSql ? ` WHERE ${rmFinalSql}` : ''}`
                    + (_rmNeedRows ? ` RETURNING *` : '')
      const _nt = needsTiming()
      const _rmnT0 = _nt ? performance.now() : 0
      // The lock, so a bulk write cannot be swallowed by another context's
      // open transaction and lost on its rollback (`FJS-638`).
      let _rmnRows, count, _rmDoomed = null
      await tx.wrapExclusive(() => {
        if (cascadeHeard()) _rmDoomed = cascadeDoomed(plugins?.hasPlugins ? affectedRows
          : readAll(readDb.query(`SELECT * FROM "${tableName}"${rmFinalSql ? ` WHERE ${rmFinalSql}` : ''}`).all(...params)))
        _rmnRows = _rmNeedRows ? writeDb.query(_rmnSql).all(...params) : null
        if (!_rmnRows) writeDb.run(_rmnSql, ...params)
        count = _rmnRows ? _rmnRows.length : rowsChanged(writeDb)
      })
      fireQuery({ operation: 'removeMany', args: { where }, sql: _rmnSql, params, duration: _nt ? performance.now() - _rmnT0 : 0, rowCount: count })
      if (plugins?.hasPlugins && affectedRows.length)
        await plugins.afterDelete(modelName, affectedRows, ctx)
      if (tableHasLogWork && _rmnRows?.length) emitLogs('delete', _rmnRows)
      await cascadeRemoved(_rmDoomed)
      announceBulk({ mode: _rmMode, event: 'remove', operation: 'removeMany', where, count, rows: _rmnRows })
      return { count }
    },

    // ── $declaredFields ─────────────────────────────────────────────────────
    //
    // What THIS model's tenant has declared, off the model `@@extensible` names.
    //
    // It exists because the read is scoped by a value nobody can see they are
    // missing: one declaring table serves every extensible model, so a plain
    // `findMany({})` answers with another model's keys and the failure is
    // total silence — a key declared on a product becomes an accepted segment
    // term over customers that matches NOBODY, request succeeding, count
    // plausible. Two services in one app got this wrong the day a second model
    // became extensible, which is what moved the scoping in here.
    //
    // The caller's own client is used, so the declaring model's `@@gate` and
    // every row policy on it apply exactly as they would to a direct read.
    async $declaredFields(opts = {}) {
      const ext = ctx.models[modelName]?.attributes?.find(a => a.kind === 'extensible')
      if (!ext) throw new CapabilityNotDeclaredError(modelName, '$declaredFields()', '@@extensible',
        'Nothing declares keys for this model, so there is no list to answer with.')
      // ctx.tables is keyed by accessor (camelCase singular), not model name.
      const tbl = ctx.tables?.[modelToAccessor(ext.declaredBy)]
      if (!tbl) throw new Error(`${modelName}.$declaredFields(): no table for '${ext.declaredBy}'`)
      return await tbl.findMany({
        ...opts,
        where: { ...(opts.where ?? {}), model: modelName },
      })
    },

    // ── restore ─────────────────────────────────────────────────────────────
    // Soft-delete tables only — sets deletedAt = NULL.
    //
    // Un-deleting is an UPDATE of `deletedAt` and is graded as one: the update
    // gate through `beforeUpdate`, and the update policy ANDed into the WHERE,
    // which is also where a row tenancy's `@@deny` arrives. A row outside it is
    // not restored and not reported — § Rule one. The cascade walks from the
    // rows that scope admits, never from the caller's where alone, or a refused
    // parent's children come back without it (`FJS-1096`).
    async restore({ where } = {}) {
      if (!softDelete) throw new CapabilityNotDeclaredError(modelName, 'restore()', '@@softDelete',
        'A row here is either present or gone — delete() is the only removal, and it has no way back.')
      if (plugins?.hasPlugins) await plugins.beforeUpdate(modelName, { where, data: { deletedAt: null } }, ctx)
      const params   = []
      // Restore targets deleted rows
      const exclWhere = injectSoftDeleteFilter(where, 'onlyDeleted')
      const baseWhereSql = buildWhereWithEncryption(exclWhere, params)
      if (!baseWhereSql) throw new Error(`restore on "${tableName}" requires a where clause`)
      const restorePolicy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'update', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
      const whereSql = restorePolicy ? `(${baseWhereSql}) AND (${restorePolicy.sql})` : baseWhereSql
      if (restorePolicy) params.push(...restorePolicy.params)
      // The children and the parent come back together, or neither does — the
      // walk below is many statements and used to be that many auto-commits
      // (`FJS-638`).
      let restored
      await tx.wrapExclusive(() => {
      // If cascading, restore child tables too (reverse of delete cascade).
      // Only the children holding the ROOT'S stamp: remove() stamps every live
      // child with its own timestamp and leaves an already-deleted child with
      // an older one, so matching the stamp is what separates what this
      // cascade removed from what somebody deleted on its own (`FJS-1583`).
      // One walk per stamp, because `where` can match roots removed apart.
      if (softDeleteCascade) {
        const cascadeTargets = _cascadeTargets()
        if (cascadeTargets.length > 0) {
          const deletedRows = readDb.query(`SELECT * FROM "${tableName}" WHERE ${whereSql}`).all(...params)
          const firstTarget = cascadeTargets[0]
          const rootPKCol = firstTarget ? firstTarget.referencedKey : 'id'
          const byStamp = new Map()
          for (const r of deletedRows) {
            const stamp = r[col('deletedAt')]
            byStamp.set(stamp, [...(byStamp.get(stamp) ?? []), r[rootPKCol]])
          }
          for (const [stamp, rootPKs] of byStamp) {
            const affectedPKs = new Map([[modelName, rootPKs]])
            for (const { childModel, childTable, foreignKey, referencedKey, parentModel, hardDelete } of cascadeTargets) {
              const parentPKs = affectedPKs.get(parentModel) ?? []
              if (!parentPKs.length) continue
              if (hardDelete) continue  // hard-deleted children are gone — cannot restore
              const ph = parentPKs.map(() => '?').join(',')
              // Read before the write: after it, the stamp that names them is gone.
              if (_cascadeParents.has(childModel)) {
                const childPKs = readDb.query(`SELECT "${referencedKey}" FROM "${childTable}" WHERE "${foreignKey}" IN (${ph}) AND "deletedAt" = ?`).all(...parentPKs, stamp).map(r => r[referencedKey])
                affectedPKs.set(childModel, childPKs)
              }
              writeDb.run(`UPDATE "${childTable}" SET "deletedAt" = NULL WHERE "${foreignKey}" IN (${ph}) AND "deletedAt" = ?`, ...parentPKs, stamp)
            }
          }
        }
      }

      const _rsSets = [`"${col('deletedAt')}" = NULL`, ...stampSets(['deletedAt'])].join(', ')
      const _rsSql = `UPDATE "${tableName}" SET ${_rsSets} WHERE ${whereSql} RETURNING *`
      const _nt = needsTiming()
      const _rsT0 = _nt ? performance.now() : 0
      restored = writeDb.query(_rsSql).all(...params)
      for (const r of restored) { noteCardinality(read(r)); noteExclusion(read(r)) }
      fireQuery({ operation: 'restore', args: { where }, sql: _rsSql, params, duration: _nt ? performance.now() - _rsT0 : 0, rowCount: restored.length })
      })
      // Un-deleting is a write and belongs in the trail. It logs as 'update' —
      // the entry vocabulary is create|update|delete|read, and a restored row is
      // a row that changed state, not one that was created.
      if (tableHasLogWork && restored.length) emitLogs('update', restored)
      // The rows, shaped — not `{ count }`. Three sources claimed three
      // different answers here (index.d.ts said one row, CLAUDE.md said an
      // array, the code returned a count), so the TypeScript declaration
      // accepted `(await restore(…)).id` for something that never had one.
      // An array is the honest shape: `where` can match many, and RETURNING
      // already had the rows before they were thrown away. They were also raw
      // — no JSON parse, no boolean coercion, no computed fields — so anything
      // that had reached for them would have got a shape no other read
      // produces. restore mirrors remove, which returns its row.
      const restoredRows = restored.map(r => read(r, { mode: 'single', hydrateFrom: true }))
      // One event per row rather than a collection one: `where` can match many,
      // but RETURNING already built every row and the caller is handed them, so
      // the memory a per-row announcement would cost is spent either way.
      // `update` for the same reason the log entry says update — a restored row
      // is one that changed state, not one that was created — and to a list
      // holding the default (live) filter it arrives exactly as a patch does.
      for (const r of restoredRows) fireRowEvent('update', 'restore', r)
      return restoredRows
    },


    // The ordering a window is walked in — the caller's, plus whatever it takes
    // to make it TOTAL.
    //
    // The first window is an ordinary page and the cursor is minted off its
    // last row, so the two have to be walked in the same order or the edge
    // names a position that page did not stop at. It rarely shows: an ordering
    // is only partial where two rows tie on every sort key, which for a
    // `createdAt` is a burst of writes inside one millisecond — the ordinary
    // case for anything a hook writes, and invisible in every fixture built one
    // row at a time. Measured on basecamp's audit trail: five rows sharing one
    // timestamp across the edge lost two of themselves, quietly.
    //
    // `null` rather than a throw where no tie can be broken. A caller asking
    // for a cursor by name is told why (`findManyCursor`); a caller merely
    // reading a list is asking for none, and refusing that read would turn a
    // window into a requirement.
    orderTotal(orderBy) {
      let fields
      try { fields = cursorFields(orderBy) } catch { return null }
      // The object form ONLY where the null position is not the one SQLite
      // would take anyway. The ordinary page is walked with this ordering and
      // the cursor is compared against it, so a `nulls` the caller stated has
      // to survive the round trip or the two disagree about which side of the
      // nulls the window resumes from (`FJS-780`). Emitting it unconditionally
      // would put `NULLS FIRST` on every list in the repo — the same order, and
      // an ORDER BY the planner has to be re-measured against for no gain.
      return fields.map(f => {
        const dir      = f.dir.toLowerCase()
        // A distance key round-trips as a distance key. This answer is used as
        // the scan's ACTUAL orderBy and is handed to `cursorFor`, so collapsing
        // it to `{ site: 'asc' }` would name the one spelling a point refuses —
        // the ordinary page 400s and the window is never minted. The nulls
        // position is `buildOrderBy`'s own for this shape and is not restated.
        if (f.near) return { [f.col]: { near: f.near, dir } }
        const implicit = f.dir === 'DESC' ? 'LAST' : 'FIRST'
        return { [f.col]: f.nulls && f.nulls !== implicit
          ? { dir, nulls: f.nulls.toLowerCase() }
          : dir }
      })
    },

    // The edge of a window, minted from a row somebody already has.
    //
    // The first window is an ordinary page — junction's `find` runs
    // findManyAndCount and then asks this for the last row's position, so
    // growing a window costs no extra query and a list that never grows one
    // pays nothing. Answers `null` where the row lacks a sort key, which is a
    // `select` that dropped one: a cursor built from an absent value names a
    // position that is not there.
    cursorFor(row, orderBy) {
      if (!row) return null
      const fields = cursorFields(orderBy)
      for (const { col } of fields) if (!(col in row)) return null
      return encodeCursor(extractCursorValues(row, fields))
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
      refuseRecursive('findManyCursor', args)
      // The gate lives in a plugin's beforeRead, and this path did not call it —
      // so a model gated at SYSADMIN answered a level-4 caller in full, and the
      // one read method built for paging through a large table was the one that
      // asked nothing (FJS-262).
      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
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

      const mode   = sdMode({ withDeleted, onlyDeleted })

      const fields = cursorFields(orderBy)

      // Graded against THIS query's ordering, which is the same `fields` the
      // token was minted from — so a cursor from another sort is refused by
      // name rather than answering an empty page (`FJS-779`).
      const cursorValues = cursor ? decodeCursor(cursor, fields) : null

      // Build the combined WHERE clause:
      //   global filter AND plugin filters AND soft delete AND @@hasTemplates
      //   AND user where AND cursor where AND the row policy
      //
      // This path builds its own SQL, which is how it came to apply none of the
      // first four and neither the policy: `findMany` answered one row where
      // `findManyCursor` answered every row in the table, another owner's and
      // another tenant's included. Composed in the same ORDER as buildSQL, and
      // the policy is appended last as raw SQL with its params after the
      // cursor's — positional binds, so the order is the correctness (FJS-262).
      const params = []

      const globalFilter  = resolveGlobalFilter()
      const pluginFilters = plugins?.hasPlugins ? plugins.getReadFilters(modelName, ctx) : []
      const allFilters    = globalFilter ? [globalFilter, ...pluginFilters] : pluginFilters
      const mergedWhere   = allFilters.length
        ? (where ? { AND: [...allFilters, where] } : allFilters.length === 1 ? allFilters[0] : { AND: allFilters })
        : where
      const policyResult = ctx.hasPolicies
        ? buildPolicyFilter(modelName, 'read', ctx, ctx.policyMap, ctx.schema, ctx.relationMap)
        : null

      const sdWhere   = softDelete ? injectSoftDeleteFilter(mergedWhere, mode) : mergedWhere
      const htWhere   = applyEffFilter(applyHtFilter(sdWhere, htMode(args)), args)
      const baseWhere = buildWhereWithEncryption(htWhere, params)

      const cursorClause = cursorValues
        ? buildCursorWhere(fields, cursorValues, params, columnMap)
        : ''

      let whereSql = ''
      if (baseWhere && cursorClause) {
        whereSql = `(${baseWhere}) AND (${cursorClause})`
      } else if (baseWhere) {
        whereSql = baseWhere
      } else if (cursorClause) {
        whereSql = cursorClause
      }
      if (policyResult) {
        whereSql = whereSql ? `(${whereSql}) AND (${policyResult.sql})` : policyResult.sql
        params.push(...policyResult.params)
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

      // @from subqueries — this path builds its own SQL, so it has to append
      // them itself. Without this a cursor page carried NO @from field at all
      // and any @computed field reading one computed from undefined: a
      // plausible 0 rather than an error, on the paginated path only, so the
      // same query answered differently through findMany.
      if (_hasFrom) {
        if (sqlCols === '*') {
          sqlCols = `"${tableName}".*, ` +
            _fromEntries.map(([n, { subquerySql }]) => `${subquerySql} AS "${n}"`).join(', ')
        } else if (ps?.requestedFrom?.size) {
          sqlCols += ', ' + [...ps.requestedFrom]
            .map(n => `${fromFields[n].subquerySql} AS "${n}"`).join(', ')
        }
      }

      // Build ORDER BY — including where the NULLs sit, which this dropped.
      // `findMany` honours a stated `nulls` and this did not, so the two
      // disagreed about the order for the same `orderBy`: the scan walked one
      // arrangement and the cursor was compared against another, which is the
      // same lost-rows failure as `FJS-780` one layer up. `fields` carries the
      // position now, defaulted to SQLite's own where nothing stated it.
      const orderSql = cursorOrderSql(fields, params)

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
      const rows = readAll(pageRows, { computedFields: ps?.requestedFields })

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
    //   orderBy    sort the MATCHED rows by a column instead of by relevance
    //   select     column allowlist (same as findMany)
    //   include    relations to include (same as findMany)
    //   highlight  { field, open, close } — wrap matched terms in HTML
    //   snippet    { field, open, close, length } — extract matched context window
    //   withRank   include _rank (BM25 score) on each row — default true
    //   withDeleted / onlyDeleted — soft delete mode (same as findMany)
    //
    // Returns rows from the base table ordered by relevance (best match first),
    // or by `orderBy` when the caller states one.
    // Adds _rank (BM25), _highlight, _snippet where requested.
    //
    // ── where the paging happens, and why it MOVES ─────────────────────────
    //
    // By relevance, step 1 pages on the FTS index itself: rank lives there, so
    // LIMIT lets SQLite stop early. A caller's order is over BASE columns the
    // index does not carry, and the fts table carries columns of the SAME NAMES
    // as the indexed ones — so ordering in step 1 would need a join in which
    // an unqualified column is ambiguous and SQLite picks one silently.
    //
    // So the ordered path collects every matching rowid in step 1 and pages in
    // step 2, over the base table alone, through the same `buildOrderBy` and
    // the same `columnMap` every other read uses. Materializing the match set
    // is the cost of the request rather than of the implementation: no engine
    // can page a base-column order without knowing what matched. The relevance
    // path is untouched and stays the default.

    async search(query, {
      limit       = 20,
      offset      = 0,
      where,
      orderBy,
      select,
      include,
      highlight,
      snippet,
      withRank    = true,
      withDeleted = false,
      onlyDeleted = false,
      withTemplates = false,
      onlyTemplates = false,
      withExpired = false,
      onlyExpired = false,
      asOf,
    } = {}) {
      if (!ftsFields) {
        throw new CapabilityNotDeclaredError(modelName, 'search()', '@@fts',
          `Add @@fts([field1, field2]) to ${modelName} to make it searchable.`)
      }

      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, { where, limit, offset }, ctx)

      const ftsTable = `${tableName}_fts`
      const mode     = sdMode({ withDeleted, onlyDeleted })
      const htm      = htMode({ withTemplates, onlyTemplates })
      const em       = effMode({ withExpired, onlyExpired, asOf })
      const asOfAt   = effective ? effAsOf({ asOf }) : null

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

      ftsSql += ` FROM "${ftsTable}" WHERE "${ftsTable}" MATCH ?`
      ftsParams.push(query)  // MATCH ? comes before the filter's params, as here

      // The index mirrors the table, so soft-deleted, template and where-excluded
      // rows are in it and would otherwise spend slots the LIMIT below then
      // throws away — a search asking for 20 answering 13, with nothing to say
      // why. Narrowing here rather than after also makes `offset` mean pages of
      // matching rows rather than pages of index entries.
      //
      // The global filter, the plugin read filters and the row policy are part
      // of that narrowing, and were part of neither step: `findMany` answered
      // one row where `search` answered every row in the table, another owner's
      // and another tenant's included (FJS-262). Merged ONCE here and used by
      // both steps, so the two cannot drift.
      const searchGlobal  = resolveGlobalFilter()
      const searchPlugins = plugins?.hasPlugins ? plugins.getReadFilters(modelName, ctx) : []
      const searchFilters = searchGlobal ? [searchGlobal, ...searchPlugins] : searchPlugins
      const withFilters   = (w) => searchFilters.length
        ? (w ? { AND: [...searchFilters, w] } : searchFilters.length === 1 ? searchFilters[0] : { AND: searchFilters })
        : w
      const searchPolicy = ctx.hasPolicies
        ? buildPolicyFilter(modelName, 'read', ctx, ctx.policyMap, ctx.schema, ctx.relationMap)
        : null

      const filterParams = []
      const preFilter    = withFilters(where) ?? {}
      let   filterSql    = buildWhereWithEncryption(
        applyEff(applyHtFilter(softDelete ? injectSoftDeleteFilter(preFilter, mode) : preFilter, htm), em, asOfAt),
        filterParams
      )
      if (searchPolicy) {
        filterSql = filterSql && filterSql !== '1=1'
          ? `(${filterSql}) AND (${searchPolicy.sql})`
          : searchPolicy.sql
        filterParams.push(...searchPolicy.params)
      }
      // Correlated on the hit's rowid, so the filter runs once per MATCH. As
      // `rowid IN (SELECT rowid FROM t WHERE …)` SQLite built the list of every
      // readable row and re-read it under the FTS scan: 300-800 ms for a
      // two-hop policy over 12k rows that matched one or eight (FJS-1692).
      if (filterSql && filterSql !== '1=1') {
        ftsSql += ` AND EXISTS (SELECT 1 FROM "${tableName}" WHERE "${tableName}".rowid = "${ftsTable}".rowid AND (${filterSql}))`
        ftsParams.push(...filterParams)
      }

      // A caller's order is applied in step 2, so this pass has to hand it the
      // WHOLE match set — a LIMIT here would page by relevance and then sort
      // the page, which is a different query and looks like a working one.
      const ordered = orderBy != null

      ftsSql += ` ORDER BY rank`

      if (!ordered) {
        if (limit  != null) ftsSql += ` LIMIT ${Number(limit)}`
        if (offset)         ftsSql += ` OFFSET ${Number(offset)}`
      }

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
      const merged       = withFilters(where) ?? {}
      const exclWhere = applyEff(
        applyHtFilter(softDelete ? injectSoftDeleteFilter(merged, mode) : merged, htm),
        em, asOfAt
      )

      let whereSql = buildWhereWithEncryption(exclWhere, baseParams)
      // The index is keyed on the source rowid, not `id` (a String id cannot be
      // an FTS5 rowid), so the hits are rejoined on rowid.
      const rowidSql = `rowid IN (${rowids.map(() => '?').join(', ')})`
      whereSql = whereSql && whereSql !== '1=1' ? `${rowidSql} AND (${whereSql})` : rowidSql
      baseParams.unshift(...rowids)
      // The pre-filter above already narrowed the rowids, so this is belt and
      // braces — and it is the half that must not be dropped: step 2 is what
      // returns the rows, and a future edit that skips the pre-filter for a
      // cheap query would otherwise hand them all back.
      if (searchPolicy) {
        whereSql = whereSql ? `(${whereSql}) AND (${searchPolicy.sql})` : searchPolicy.sql
        baseParams.push(...searchPolicy.params)
      }

      const ps         = parseArgs(select, include)
      let   sqlCols    = ps?.sqlCols ?? '*'
      // Step 2 builds its own SELECT, so it appends the @from subqueries itself
      // — the same reason findManyCursor and resolveIncludes do.
      if (_hasFrom) {
        if (sqlCols === '*') {
          sqlCols = `*, ${fromSelectExpr(fromFields)}`
        } else if (ps?.requestedFrom?.size) {
          sqlCols += ', ' + [...ps.requestedFrom]
            .map(n => `${fromFields[n].subquerySql} AS "${n}"`).join(', ')
        }
      }
      let   baseSql    = `SELECT rowid AS __fts_rowid, ${sqlCols} FROM "${tableName}" WHERE ${whereSql}`

      // The caller's order, over the base table alone — the same builder and
      // the same columnMap findMany uses, so a `@map`ped column and a `@from`
      // rollup sort here exactly as they do there. The KEYS were graded before
      // the call (`checkOrderBy`), which matters more here than anywhere: a bad
      // sort key answers the right rows in the wrong order, and nothing about
      // that is visible.
      if (ordered) {
        const orderSql = buildOrderBy(orderBy, baseParams, columnMap, _pointMap, _vectorMap, _vectorFn(readDb))
        if (orderSql) baseSql += ` ORDER BY ${orderSql}`
        if (limit != null) baseSql += ` LIMIT ${Number(limit)}`
        if (offset)        baseSql += ` OFFSET ${Number(offset)}`
      }

      const baseRows = readAll(readDb.query(baseSql).all(...baseParams), { computedFields: ps?.requestedFields })
      if (!baseRows.length) return []

      // ── Step 3: attach rank + extras, in the order the query decided ──────
      //
      // Two orders and the walk decides which survives. By relevance the rows
      // come back in whatever order SQLite read them, so the FTS hits are
      // walked and the rows looked up. Under a caller's order step 2 already
      // sorted AND paged, so walking the hits would put rank back — the rows
      // are walked instead and the per-row extras looked up by rowid.
      const result = [], rids = []

      if (ordered) {
        for (const row of baseRows) {
          rids.push(row.__fts_rowid)
          delete row.__fts_rowid
          result.push(row)
        }
      } else {
        const rowById = new Map(baseRows.map(r => { const rid = r.__fts_rowid; delete r.__fts_rowid; return [rid, r] }))
        for (const ftsRow of ftsRows) {
          const row = rowById.get(ftsRow.rowid)
          if (!row) continue  // filtered out by where clause or soft delete
          rids.push(ftsRow.rowid)
          result.push(row)
        }
      }

      // ── Step 4: resolve includes + trim select, then the extras ───────────
      // The extras are not columns, so the trim to a `select` dropped them:
      // `search(q, { select })` answered without `_rank` and said nothing
      // (FJS-1694).
      withIncludes(result, ps, include)
      return finalize(result, ps).map((row, i) => {
        const rid = rids[i]
        if (withRank)    row._rank      = rankByRowid.get(rid)
        if (hlByRowid)   row._highlight = hlByRowid.get(rid)
        if (snipByRowid) row._snippet   = snipByRowid.get(rid)
        return row
      })
    },

    // ── delete ──────────────────────────────────────────────────────────────
    // Always a real DELETE FROM — bypasses soft delete on all tables.
    // Requires a where clause to prevent accidental mass deletion.
    async delete({ where, withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf } = {}) {
      if (plugins?.hasPlugins) await plugins.beforeDelete(modelName, { where }, ctx)
      const params   = []
      // The guard reads the CALLER's where. The filters below add clauses of
      // their own, and a `delete({})` whose emptiness they papered over would
      // stop being refused.
      if (!buildWhere(where, [], null, null, null, null, fieldKinds, columnMap))
        throw new Error(`delete on "${tableName}" requires a where clause — use deleteMany({}) to delete all rows`)
      // Through `buildWhereWithEncryption` like every other where in the client:
      // a `@encrypted(deterministic: true)` or `@hashed` column stores bytes the
      // caller never sends, so a raw comparison against the plaintext matches
      // nothing — and a DELETE that matches nothing reports a plausible zero
      // (FJS-600). Scope expansion, `@from` and typed JSON ride the same call.
      const whereSql = buildWhereWithEncryption(
        _hardDeleteWhere({ where, withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf }), params)
      const delPolicy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'delete', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
      const delFinalSql0    = delPolicy ? `(${whereSql}) AND (${delPolicy.sql})` : whereSql
      const delFinalParams0 = delPolicy ? [...params, ...delPolicy.params] : params
      const { sql: delFinalSql, params: delFinalParams } =
        sealWhereClause(delFinalSql0, delFinalParams0)
      // The row is still present here, so the @from subqueries can ride on the
      // pre-delete SELECT rather than costing a second query — after the DELETE
      // there is no outer row for them to correlate to.
      const _delCols = _hasFrom ? `*, ${fromSelectExpr(fromFields)}` : '*'
      const _delSql = `DELETE FROM "${tableName}" WHERE ${delFinalSql}`
      const _nt = needsTiming()
      const _delT0 = _nt ? performance.now() : 0
      // The read and the DELETE are one unit: the row is what the caller is
      // handed back and what the audit trail records, so a write landing
      // between them reports a row that is not the one that was removed.
      let _delDoomed = null
      const row = await tx.wrapExclusive(() => {
        const r = read(readDb.query(`SELECT ${_delCols} FROM "${tableName}" WHERE ${delFinalSql}`).get(...delFinalParams))
        if (!r) return null
        noteCardinality(r)
        _delDoomed = cascadeDoomed([r])
        try { writeDb.run(_delSql, ...delFinalParams) }
        catch (e) { throw asRestrictedDelete(e, [r]) }
        return r
      }).catch(async e => { throw await nameBlockerForCaller(e) })
      if (!row) throwIfSealed(delFinalSql0, delFinalParams0, 'delete')
      fireQuery({ operation: 'delete', args: { where }, sql: _delSql, params: delFinalParams, duration: _nt ? performance.now() - _delT0 : 0, rowCount: 1 })
      if (plugins?.hasPlugins) await plugins.afterWrite(modelName, 'delete', row, ctx)
      if (plugins?.hasPlugins) await plugins.afterDelete(modelName, [row].filter(Boolean), ctx)
      // Announced as `remove`: the event names what happened to the row from a
      // reader's side, and a hard delete and a soft one are the same thing to
      // anything holding a list. This had the row all along — the pre-DELETE
      // SELECT above — and announced nothing, while its sibling `remove` fired
      // from the same region (FJS-307).
      if (row) fireRowEvent('remove', 'delete', row)
      // ── Logging ───────────────────────────────────────────────────────────
      if (tableHasLogWork && row) emitLogs('delete', [row], { before: row })
      await cascadeRemoved(_delDoomed)
      return row
    },

    // ── deleteMany ──────────────────────────────────────────────────────────
    // Real DELETE FROM — bypasses soft delete. where is optional (deletes all if omitted).
    async deleteMany({ where, announce, withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf } = {}) {
      const { mode: _dmMode, wantRows: _dmWantRows } = announceFor(announce)
      const _dmNeedRows = tableHasLogWork || _dmWantRows
      if (plugins?.hasPlugins) await plugins.beforeDelete(modelName, { where }, ctx)
      const params   = []
      const whereSql = buildWhereWithEncryption(
        _hardDeleteWhere({ where, withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf }), params)
      const delManyPolicy = ctx.hasPolicies ? buildPolicyFilter(modelName, 'delete', ctx, ctx.policyMap, ctx.schema, ctx.relationMap) : null
      if (delManyPolicy) params.push(...delManyPolicy.params)
      const dmFinalSql0 = whereSql && delManyPolicy ? `(${whereSql}) AND (${delManyPolicy.sql})`
                        : whereSql || delManyPolicy?.sql || null
      const _dmSeal    = sealWhereClause(dmFinalSql0, [])
      const dmFinalSql = _dmSeal.sql || null
      params.push(..._dmSeal.params)

      // Prefetch affected rows before SQL so afterDelete gets them.
      // Only done when plugins are listening — avoids the SELECT cost otherwise.
      const affectedRows = plugins?.hasPlugins
        ? readAll(readDb.query(`SELECT * FROM "${tableName}"${dmFinalSql ? ` WHERE ${dmFinalSql}` : ''}`).all(...params))
        : []

      const _dmnSql = `DELETE FROM "${tableName}"${dmFinalSql ? ` WHERE ${dmFinalSql}` : ''}`
                    + (_dmNeedRows ? ` RETURNING *` : '')
      const _nt = needsTiming()
      const _dmnT0 = _nt ? performance.now() : 0
      // The lock, so a bulk write cannot be swallowed by another context's
      // open transaction and lost on its rollback (`FJS-638`).
      let _dmnRows, result, _dmDoomed = null
      await tx.wrapExclusive(() => {
        noteCardinalityBySql(dmFinalSql, params)
        if (cascadeHeard()) _dmDoomed = cascadeDoomed(plugins?.hasPlugins ? affectedRows
          : readAll(readDb.query(`SELECT * FROM "${tableName}"${dmFinalSql ? ` WHERE ${dmFinalSql}` : ''}`).all(...params)))
        _dmnRows = _dmNeedRows ? writeDb.query(_dmnSql).all(...params) : null
        if (!_dmnRows) writeDb.run(_dmnSql, ...params)
        result = { changes: _dmnRows ? _dmnRows.length : rowsChanged(writeDb) }
      })
      fireQuery({ operation: 'deleteMany', args: { where }, sql: _dmnSql, params, duration: _nt ? performance.now() - _dmnT0 : 0, rowCount: result.changes })
      if (plugins?.hasPlugins && affectedRows.length)
        await plugins.afterDelete(modelName, affectedRows, ctx)
      if (tableHasLogWork && _dmnRows?.length) emitLogs('delete', _dmnRows)
      await cascadeRemoved(_dmDoomed)
      announceBulk({ mode: _dmMode, event: 'remove', operation: 'deleteMany', where, count: result.changes, rows: _dmnRows })
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
    async transition(id, transitionName, { system = false } = {}) {
      if (!_tableTransitions) throw new CapabilityNotDeclaredError(modelName, 'transition()', '@@transitions',
        'No enum field on this model declares a transitions block, so there are no named moves to make.')

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

      // `{ system: true }` becomes the column mechanism: a move is a write to
      // this field, so the two hatches are one. Stated as a boolean here because
      // the caller has already named the move, and the field it writes is not
      // something they should have to look up.
      // `_move` is the whole of what transition() knows and update() cannot
      // derive: WHICH move was asked for. Without it a move onto the state the
      // row already holds is indistinguishable from a form round-tripping an
      // unchanged column, and the second of those must stay a silent no-op
      // (`FJS-611`).
      return this.update({
        where: { [idField]: id },
        data:  { [targetField]: targetValue },
        _move: transitionName,
        ...(system ? { system: [targetField] } : {}),
      })
    },

    // ── due ─────────────────────────────────────────────────────────────────
    // Which rows owe a declared `@@commitment` transition by `by` — the
    // client's clock unless stated — and when each one fell due. One query per
    // declaration: the transition's from-state and `while:` in the WHERE, and
    // the due time as an expression over the row, so an edited anchor moves the
    // answer with no queue entry to go stale.
    //
    // It is a READ through `findMany`, so the caller's gate, row policy,
    // soft-delete and window all apply; the sweep that fires commitments asks
    // it of a system client. Making the transition is not this method's — a
    // row it returns may have moved by the time anybody acts, which is why the
    // fire asks again with `where` naming the row.
    async due({ by, timeZone, transition, where } = {}) {
      const decls = ctx.commitmentMap?.[modelName]
      if (!decls) throw new CapabilityNotDeclaredError(modelName, 'due()', '@@commitment',
        'Nothing on this model is owed at a time, so no row can be due.')
      const chosen = transition == null ? decls : decls.filter(d => d.name === transition)
      if (!chosen.length) throw new ValidationError([{ path: ['transition'], message:
        `${modelName} owes no commitment named '${transition}' — declared: ${decls.map(d => d.name).join(', ')}` }])

      const at = by ?? nowISO(ctx.now)
      const out = []
      for (const d of chosen) {
        const limit = readBy(d.kind, at, timeZone)
        if (limit == null) throw new ValidationError([{ path: ['by'], message:
          `by must be an instant — a Date or an ISO date-time. Got '${by}'` }])
        // The from-state is the TARGET's. Across a relation it is a relation
        // filter, so a subscription an older invoice already lapsed leaves
        // every later invoice owing nothing — rather than each one firing into
        // a refused move on every sweep for as long as it stays unpaid — and a
        // null relation matches no row at all (`FJS-D362`).
        const from = { [d.field]: { in: d.from } }
        const due  = dueSql(d)
        const cond = [d.via ? { [d.via]: { is: from } } : from,
                      { $raw: rawClause(`${due.sql} <= ?`, [...due.params, limit]) }]
        if (d.while) {
          const w = compileStatic(d.while, modelName, ctx.schema, relationMap)
          cond.push({ $raw: rawClause(w.sql, w.params) })
        }
        if (where) cond.push(where)
        const targetId = d.via
          ? ctx.models[d.target]?.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
          : idField
        const keep = [idField, d.on, ...(d.offset?.field ? [d.offset.field] : [])]
        const select = Object.fromEntries(keep.map(k => [k, true]))
        if (d.via) select[d.via] = { select: { [targetId]: true } }
        const rows = await this.findMany({ where: { AND: cond }, select })
        for (const row of rows) out.push({
          transition: d.name,
          id:         row[idField],
          dueAt:      dueAt(d, row),
          target:     { model: d.target, accessor: modelToAccessor(d.target), transition: d.transition,
                        id: d.via ? row[d.via][targetId] : row[idField] },
        })
      }
      return out
    },

    // ── transitions ─────────────────────────────────────────────────────────
    // The legal next states for this record at this caller's level — the thing
    // a UI needs to render exactly the right buttons and nothing else.
    //
    // Accepts a row (no round trip) or an id (one read). Returns every move
    // legal from the record's current value, each flagged with `allowed`:
    // a gated move the caller can't make is reported, not hidden, because a
    // grayed-out button is usually better UI than a missing one. Callers that
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

      // ── the policy half ─────────────────────────────────────────────────
      // A move is an update, so a row policy refuses it exactly as a gate does
      // — and until FJS-495 this method consulted only the gate, so a caller
      // holding the level and failing the policy was shown a button that
      // answered 403 the moment they pressed it.
      //
      // TWO questions, and only one of them varies per move. The `update`
      // policy is about the row as it IS, so it is one evaluation for the whole
      // call. `post-update` is about the row as it WOULD BE, so it is one per
      // distinct TARGET — a machine's moves usually share few of those, and
      // both are memoized, which is what keeps this off the per-row cost the
      // issue was worried about.
      //
      // The would-be row is the current one with the column moved. That is what
      // the transition writes and nothing else, `@updatedAt` aside.
      //
      // Undecidable is PERMISSIVE here and nowhere else. `evalJs` throws on a
      // `check()` over a relation it cannot walk, and this is an affordance:
      // the Data boundary refuses regardless, so the honest failure is to offer
      // a button that gets refused rather than to hide one that would work.
      // `policyVerdict` deliberately does not catch — see its own note.
      const policies = ctx.hasPolicies ? ctx.policyMap?.[modelName] : null
      const admits   = (op, r) => {
        if (!policies?.[op]) return true
        try { return policyVerdict(modelName, r, ctx, ctx.policyMap, ctx.relationMap, op).ok }
        catch { return true }
      }

      let updateOk = null
      const postOk = new Map()

      const out = []
      for (const [fieldName, spec] of Object.entries(_tableTransitions)) {
        const currentValue = row[fieldName]
        if (currentValue == null) continue
        for (const [name, { from, to, gate, system }] of Object.entries(spec.transitions)) {
          if (!from.includes(currentValue)) continue

          // `@system` is asked FIRST and it is the cheapest: no level to
          // resolve and no policy to evaluate, because the answer is the same
          // at every level. It is also the one a screen must render
          // differently — a gate refusal says *ask somebody more senior*, and
          // this one cannot be answered by any caller at all.
          let allowed   = !(system && !ctx.isSystem)
          let refusedBy = allowed ? null : 'system'

          if (allowed && gate != null) {
            allowed   = levelPasses(gate, await levelFor())
            refusedBy = allowed ? null : 'gate'
          }

          if (allowed && policies) {
            updateOk ??= admits('update', row)
            if (!postOk.has(to)) postOk.set(to, admits('post-update', { ...row, [fieldName]: to }))
            allowed   = updateOk && postOk.get(to)
            refusedBy = allowed ? null : 'policy'
          }

          // `refusedBy` says which half said no, because a screen has three
          // different things to render: *not you, ever* (`system`), *you are
          // not senior enough* (`gate`) and *not this record* (`policy`). A
          // status alone cannot carry that, and the caller would otherwise
          // guess from the gate being non-null — wrong for every ungated move a
          // policy refuses, and wrong for every `@system` one.
          out.push({ name, field: fieldName, from: currentValue, to,
                     gate: gate ?? null, system: Boolean(system), allowed, refusedBy })
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
        throw new CapabilityNotDeclaredError(modelName, 'optimizeFts()', '@@fts',
          `Add @@fts([field1, field2]) to ${modelName} — there is no index to merge without one.`)
      }
      writeDb.run(`INSERT INTO "${tableName}_fts"("${tableName}_fts") VALUES('optimize')`)
      return { optimized: true, table: `${tableName}_fts` }
    },

  }, ctx, modelName)
}

// ─── Multi-database helpers ───────────────────────────────────────────────────

// Resolve a database path definition to an absolute filesystem path.
// Re-exported for the CLI, which answers the same question before a client
// exists. The rule itself is core/db-path.js.
export { schemaAnchor } from './db-path.js'

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
// ─── The options this client takes ───────────────────────────────────────────
//
// An unknown OPTION was dropped the way JavaScript drops any undeclared key,
// while an unknown PROPERTY on the built client throws by design — so a typo'd
// accessor was loud and a typo'd capability quietly did not apply (FJS-579).
// Five of this package's own test files passed `autoMigrate: true`, which has
// never been an option; all five open a fresh database, where creating and
// migrating are the same thing, so all five passed either way.
//
// The list below is for the SUGGESTION only. The refusal comes from the rest
// object, so a name missing here costs a "did you mean" and never a wrong
// answer — and `test/client-options.test.ts` parses the destructure and fails
// if the two disagree.
const CLIENT_OPTIONS = [
  'path', 'schema', 'parsed', 'resolveFrom', 'db', 'computed', 'encryptionKey',
  'hooks', 'onEvent', 'announce', 'filters', 'plugins', 'databases', 'access',
  'readOnly', 'busyTimeout', 'pluralize', 'onLog', 'onQuery', 'policyDebug',
  'now', 'scopes', 'allowChildFkOverride', 'logContext', 'claims', 'untrusted',
  'previousEncryptionKeys',
]

// A key with a real answer says it, rather than being suggested at — the
// suggestion is for a typo, and these are not typos.
const OPTION_ANSWERS = {
  autoMigrate:
    'is not an option. `autoMigrate(client)` is the exported function that diffs the schema\n' +
    '    against the open database and applies the difference:\n\n' +
    "        import { createClient, autoMigrate } from '@frontierjs/litestone'\n" +
    "        const db = await createClient({ path: './db/schema.lite' })\n" +
    '        await autoMigrate(db)\n\n' +
    '    It is a separate call rather than a flag because migrating on open has a hazard in\n' +
    '    it: a process holding the schema it booted with can move the database ahead of the\n' +
    '    code it is serving, on an ordinary request (FJS-566).',
}

function assertClientOptions(rest) {
  const unknown = Object.keys(rest)
  if (!unknown.length) return
  const lines = unknown.map(k => {
    if (OPTION_ANSWERS[k]) return `  ${k} ${OPTION_ANSWERS[k]}`
    // The answered names are candidates too: `autoMigrateee` is a misspelling of
    // a thing that is not an option, and pointing at the nearest real option
    // would be a worse answer than the one there is (FJS-579 measured that spelling).
    const near = suggestKey(k, [...CLIENT_OPTIONS, ...Object.keys(OPTION_ANSWERS)])
    if (near && OPTION_ANSWERS[near]) return `  ${k} — \`${near}\` ${OPTION_ANSWERS[near]}`
    return `  ${k}${near ? ` — did you mean \`${near}\`?` : ''}`
  })
  throw new Error(
    `createClient(): unknown option${unknown.length > 1 ? 's' : ''}\n\n` +
    `${lines.join('\n')}\n\n` +
    `  Options: ${CLIENT_OPTIONS.join(', ')}`
  )
}

// Said once per distinct set of ungraded claim names, for the life of the process.
const UNGRADED_CLAIMS_SAID = new Set()

export async function createClient({
  path:       schemaFilePath,  // path to .lite file  — e.g. './db/schema.lite'
  schema:     schemaInline,    // inline schema string — e.g. `model users { ... }`
  parsed:     schemaPreParsed, // pre-parsed parseResult (advanced)
  resolveFrom = 'cwd',         // where a relative `database { path }` is anchored:
                               // 'cwd' (default) · 'schema' (the app root, from the
                               // schema FILE) · a directory · a file: URL. An app
                               // assembling its schema in memory has no file, so it
                               // states the root — see core/db-path.js

  db:         dbPath,
  computed: computedInput,
  encryptionKey,       // 64-char hex string — required for @encrypted / @secret fields
  previousEncryptionKeys,  // string[] — keys this client can still READ but never writes.
                           // A rotation runs one transaction per DATABASE, so a crash
                           // between two commits leaves a schema in two keys; holding the
                           // old one is what makes that readable and the rotation
                           // resumable rather than a loss (`FJS-714`)
  hooks,
  onEvent,
  announce:   announceDefault,  // 'collection' (default) | 'rows' | 'none' — what a BULK
                                // write tells a subscriber. The floor; a call overrides it
  filters,
  plugins:    plugins,
  databases:  dbOverrides,   // ':memory:' | { dbName: { path } } — override db paths
  access:     accessConfig,
  readOnly,              // true — shorthand for access: { '*': 'readonly' } on all SQLite dbs
  busyTimeout,           // ms a connection waits for another PROCESS's write lock before
                         // SQLITE_BUSY. A number for every connection, or { default, <db> }
                         // per database; 0 means fail immediately. Absent reads
                         // LITESTONE_BUSY_TIMEOUT, then 5000. There is deliberately no
                         // `database { }` spelling — see core/pragmas.js and FJS-D154
  pluralize:  pluralizeTableNames = false,  // true — pluralize snake_case table names (user→users)
  onLog,
  logContext,
  onQuery,
  policyDebug = false,
  now,                   // () => Date | ISO string — the clock this client reads and
                         // writes: `now()` in a policy predicate, `@@softDelete`'s stamp,
                         // `@default(now())`, `@updatedAt` on create and update, and the
                         // retention cutoff. Injected so a test can freeze it and a report
                         // can pin it; absent means the wall clock. What it does NOT reach
                         // is SQL that runs without it — a raw statement, and a `@derived`
                         // expression, which is compiled once at startup (`FJS-531`).
  claims,                // string[] — the claim names this app's principal carries
                         // beyond the @@auth model's own columns: a value resolved PER
                         // REQUEST, which is on no row and in no schema (a cart token,
                         // an impersonation). Declaring it is what lets `auth().x` be
                         // graded at all — a name outside the set is refused by name
                         // rather than compiling to NULL and being read opposite ways
                         // by the two interpreters (`FJS-666`)
  scopes:     scopeRegistry = {},   // { ModelName: { scopeName: scopeDef, ... } }
  allowChildFkOverride = false,     // false (default) → parent's co-FK silently overwrites child's value
                                    // true → explicit child value wins; missing values still auto-filled
  untrusted = false,     // true — `schema` is text the app did not write (a row, a tenant's
                         // model): parsed as text only, held to the one `db` given, and any
                         // database / import / @@auth / @@db … refused by name (FJS-1633)
  ...unknownOptions
} = {}) {

  assertClientOptions(unknownOptions)

  if (untrusted) {
    if (typeof schemaInline !== 'string' || schemaFilePath || schemaPreParsed)
      throw new Error('createClient({ untrusted: true }) takes the schema as text in `schema` — not a path, and not a parse')
    if (dbPath == null || dbOverrides)
      throw new Error('createClient({ untrusted: true }) needs `db` — the one database file the schema is held to — and takes no `databases` overrides')
  }

  // ── Parse schema ───────────────────────────────────────────────────────────
  // Resolution order: parsed > schema (inline string) > path (file)
  //
  //   createClient({ path: './db/schema.lite' })
  //   createClient({ schema: `model User { id Int @id }`, db: ':memory:' })
  //   createClient({ parsed: parseFile('./db/schema.lite') })
  // A `schema:` that is really a FILE PATH is read as one below, and
  // `resolveFrom: 'schema'` then has to anchor on it: the option's contract is
  // *the app root, from the schema file*, and the file was handed over — under
  // the other key. Without this the anchor is null, every relative database
  // path silently falls back to the working directory, and a command run from a
  // surface opens a NEW, EMPTY database (`FJS-449`'s shape) with the option that
  // was supposed to prevent it set.
  if (!schemaFilePath && typeof schemaInline === 'string' &&
      !schemaInline.includes('\n') && schemaInline.endsWith('.lite'))
    schemaFilePath = resolve(schemaInline)

  const parseResult = (() => {
    if (schemaPreParsed) return schemaPreParsed
    // Text, always: a one-line string ending in .lite is otherwise READ FROM
    // DISK below, which untrusted text must never get to choose.
    if (untrusted) return parse(schemaInline)
    if (schemaInline) {
      if (!(schemaInline.includes('\n') || !schemaInline.endsWith('.lite')))
        return parseFile(resolve(schemaInline))
      // An inline string has no directory, so a relative `import` in it can be
      // resolved against nothing and is DROPPED — valid, no error, no warning.
      // That is the whole failure: the schema states something and the build
      // reads a smaller one, so a model, an `extend`, a policy and a claim all
      // go missing at once and every artefact agrees with the smaller schema
      // (`FJS-670`). Said by name, with the fix where `path` was handed over
      // and ignored — which is the shape it actually reaches people in.
      const dropped = [...schemaInline.matchAll(/^\s*import\s+["']([^"']+)["']/gm)].map(m => m[1])
      if (dropped.length)
        console.warn(
          `[litestone] createClient({ schema }) dropped ${dropped.length} import` +
          `${dropped.length > 1 ? 's' : ''}: ${dropped.join(', ')} — an inline schema has no ` +
          `directory to resolve them against.` +
          (schemaFilePath
            ? ` Pass path: '${schemaFilePath}' ALONE (a schema string wins the resolution order) ` +
              `and litestone reads it with parseFile, which resolves them.`
            : ` Pass path: './db/schema.lite' instead, or resolve them yourself before parsing.`))
      return parse(schemaInline)
    }
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
  if (untrusted) refuseUntrustedSchema(parseResult.schema)

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
    : { ...(dbOverrides ?? {}) }
  const resolvedDbPath = inMemory ? ':memory:' : dbPath

  // `db` names main's path, whether or not the schema declares `database main`.
  // It used to apply only when the declaration was absent, so a test passing
  // db: ':memory:' against a schema that declares one wrote the declared file
  // and said nothing. The more specific channel still wins.
  if (dbPath && !inMemory && !resolvedOverrides.main) resolvedOverrides.main = { path: dbPath }

  const dbRegistry  = buildDbRegistry(schema, resolvedDbPath, resolvedOverrides, resolveAccessConfig(accessConfig, readOnly, schema), inMemory, resolveAnchor(resolveFrom, schemaFilePath), validateBusyTimeout(busyTimeout, (schema.databases ?? []).map(d => d.name)))
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
//
// One primitive for every flavor of the client. A lock is a fact about the
// connection rather than an access check, so `asSystem()` does not bypass it:
// a system caller that asks for a lock is asking for exclusion, and a no-op
// there landed 10 of 10 concurrent writers on one range (`FJS-1216`).

// A key acquire() does not read is refused rather than dropped. A dropped wait
// budget is `wait = 0`, which turns a queue into try-once and surfaces as an
// ordinary 409 with `retryable: true` — contention, to anyone reading it
// (FJS-1217). The index.d.ts typed `timeout` while this read `wait`.
const LOCK_OPTIONS = ['ttl', 'wait', 'retryEvery', 'owner']

const LOCK_OPTION_ANSWERS = {
  timeout: 'is not an option — `wait` is the milliseconds to keep retrying before refusing, and `ttl` is how long the lock lives once held',
}

function assertLockOptions(rest) {
  const unknown = Object.keys(rest)
  if (!unknown.length) return
  const lines = unknown.map(k => {
    if (LOCK_OPTION_ANSWERS[k]) return `  ${k} ${LOCK_OPTION_ANSWERS[k]}`
    const near = suggestKey(k, LOCK_OPTIONS)
    return `  ${k}${near ? ` — did you mean \`${near}\`?` : ''}`
  })
  throw new Error(
    `$lock(): unknown option${unknown.length > 1 ? 's' : ''}\n\n` +
    `${lines.join('\n')}\n\n` +
    `  Options: ${LOCK_OPTIONS.join(', ')}`
  )
}

function makeLockPrimitive(rawWriteDb) {
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
      ...rest
    } = opts
    assertLockOptions(rest)

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
    // How many database names each file carries. A file two blocks share is
    // fresh for one of them and already built for the other, so neither the
    // size shortcut nor an empty `sqlite_master` can answer *is this database
    // fresh* — main's own DDL is what grew the file (`FJS-958`).
    const nameCount = new Map()
    for (const conn of Object.values(dbRegistry)) {
      if (conn.driver !== 'sqlite' || !conn.absPath || conn.absPath === ':memory:') continue
      nameCount.set(conn.absPath, (nameCount.get(conn.absPath) ?? 0) + 1)
    }
    for (const [dbName, conn] of Object.entries(dbRegistry)) {
      if (conn.driver !== 'sqlite' || !conn.rawWriteDb || !conn.absPath) continue
      // Fast skip: if the file is larger than one empty SQLite page, tables exist
      const absPath = conn.absPath
      if (absPath !== ':memory:' && (nameCount.get(absPath) ?? 0) < 2) {
        try {
          const { statSync } = await import('#host')
          if (statSync(absPath).size > 8192) continue   // clearly not empty
        } catch {}
      }
      const existing = new Set(conn.rawWriteDb.query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestone%' AND name NOT LIKE '_locks%'`
      ).all().map((r) => r.name))
      // Asked of THIS database's own tables rather than of the file's.
      const mine = schema.models
        .filter(m => (modelDbMap[m.name] ?? 'main') === dbName)
        .map(m => modelToTableName(m, pluralizeTableNames))
      if (mine.length && !mine.some(t => existing.has(t))) {
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

  // ── Every view compiles, now (FJS-1632) ────────────────────────────────
  // CREATE VIEW resolves no names, so a view whose @@sql names a column that
  // is not there built fine and failed at the first read, with SQLite's
  // 'no such column' and no view named. Preparing a SELECT over each view
  // resolves them. Only a view the file already holds: one a pending
  // migration has yet to create is the migration's to report.
  for (const view of schema.views ?? []) {
    if (view.materialized) continue
    const conn = dbRegistry[view.db ?? 'main']
    if (conn?.driver !== 'sqlite' || !conn.rawWriteDb) continue
    const exists = conn.rawWriteDb.query(`SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ?`).get(view.name)
    if (!exists) continue
    try { conn.rawWriteDb.query(`SELECT * FROM "${view.name}" LIMIT 0`).all() }
    catch (err) { throw new Error(`view ${view.name}: its @@sql does not compile against this database — ${err.message}`) }
  }

  const computedFns   = normalizeComputed(await loadComputedFields(computedInput), schema)

  // ── Lock primitive — auto-creates _locks in main db on first use ──────────
  const lockPrimitive = makeLockPrimitive(rawWriteDb)

  // ── Build log map ──────────────────────────────────────────────────────────
  // Scans schema for @log/@@@log attributes — used by makeTable to fire entries.
  const logMap = buildLogMap(schema)

  // ── Retention ──────────────────────────────────────────────────────────────
  // One pass at startup, for each database declaring a policy. **Startup is not
  // a schedule**: a process that stays up never prunes again, which for a
  // long-lived server is every day after the first. `$retain()` below is the
  // same pass on demand, and scheduling it is the app's — the clock belongs to
  // the queue (`FJS-D36`) and this package cannot import it (`FJS-521`).
  const _retentionModels = (dbName) => schema.models.filter(m => {
    const dbAttr = m.attributes.find(a => a.kind === 'db')
    return (dbAttr?.name ?? 'main') === dbName
  })

  function _runRetention({ jsonl = true } = {}) {
    const swept = []
    for (const [dbName, conn] of Object.entries(dbRegistry)) {
      if (!conn.retention && !conn.maxSize) continue

      if (conn.driver === 'sqlite' && conn.retention && conn.rawWriteDb) {
        for (const r of runSqliteRetention(conn.rawWriteDb, _retentionModels(dbName), conn.retention, pluralizeTableNames, now))
          swept.push({ database: dbName, driver: 'sqlite', ...r })
        continue
      }

      // The jsonl half compacts inside `makeJsonlTable`, so the boot pass skips
      // it rather than doing it twice; a later `$retain()` has to do it here,
      // because nothing reopens those tables.
      if (jsonl && (conn.driver === 'jsonl' || conn.driver === 'logger')) {
        for (const model of _retentionModels(dbName)) {
          const filePath = jsonlFilePath(conn.absPath, model.name)
          try {
            const res = compactJsonl(filePath, model, conn.retention, conn.maxSize, now)
            if (res)
              swept.push({ database: dbName, driver: conn.driver, model: model.name, table: filePath, removed: res.removed ?? 0 })
          } catch (err) {
            // Reported, not swallowed. A compaction that throws every pass looks
            // exactly like one that had nothing to do (`FJS-521`).
            console.warn(`[litestone] retention: could not compact "${filePath}" — ${err?.message ?? err}`)
            swept.push({ database: dbName, driver: conn.driver, model: model.name, table: filePath, removed: 0, error: String(err?.message ?? err) })
          }
        }
      }
    }
    return swept
  }

  _runRetention({ jsonl: false })

  // ── $retain ────────────────────────────────────────────────────────────────
  //
  // The startup pass, on demand — and the reason it exists is that startup is
  // not a schedule. A process that stays up prunes once, on the day it booted,
  // which for a long-lived server means a declared `retention 90d` stops being
  // true the day after the deploy (`FJS-521`).
  //
  // Scheduling it is the APP's, and that is a consequence of two rulings rather
  // than a gap: unattended recurring work belongs to the queue (`FJS-D36`), and
  // this package may not import it (Invariant 1). One line in a `*.job.ts`:
  //
  //     export default defineJob('retention', () => db.asSystem().$retain(),
  //                              { cron: '0 4 * * *' })
  //
  // `asSystem()` for raw SQL's reason (`FJS-D52`): it deletes rows through no
  // gate, no row policy and no `@@softDelete`, so the bypass is said at the call
  // site rather than assumed. Answers one row per table it touched.
  function $retain() {
    // Stamped so *is the sweep running at all* is answerable. A retention job
    // that stopped firing removes nothing and reports nothing, which is the
    // same silence `FJS-327` and `FJS-328` were about one realm over.
    // Stamped without changing what this returns: `_runRetention` is
    // synchronous, and wrapping it in a promise makes every caller's result a
    // thenable instead of the summary it has always been.
    const out = _runRetention()
    ctx._logStats.lastRetainAt = new Date().toISOString()
    return out
  }

  function retainRefusal() {
    throw new Error(
      `$retain() — retention deletes rows and applies none of this schema's access rules.\n\n` +
      `@@gate, @@allow/@@deny and @@softDelete are all enforced above SQLite, and a\n` +
      `retention sweep is a DELETE against the base table. Say the bypass:\n\n` +
      `    db.asSystem().$retain()\n`
    )
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
  const effectiveMap         = buildEffectiveMap(schema)
  const commitmentMap        = buildCommitmentMap(schema)
  const boolMap        = buildBoolMap(schema)
  const affinityMap    = buildAffinityMap(schema)
  const bigMap         = buildBigMap(schema)
  const filterKindMap  = buildFilterKindMap(schema)
  const autoIdMap      = buildAutoIdMap(schema)
  // The clock a write is STAMPED with — `@default(now())` and `@updatedAt` —
  // which is `now` unless `$madeAt` answers an instant for the write in
  // progress. A write held on a device and sent hours later was made then, and
  // stamping it when it landed dated a shift's work at the moment the network
  // came back (`FJS-D469`). Predicates, `@@expires` and retention stay on `now`:
  // they ask when the write is GRADED, which is at landing (`FJS-D300`).
  const _madeAt    = { fn: null }
  const stampClock = () => _madeAt.fn?.() ?? (typeof now === 'function' ? now() : new Date())
  const generatedDefaultMap = buildGeneratedDefaultMap(schema, stampClock)
  const authDefaultMap     = buildAuthDefaultMap(schema)
  const literalDefaultMap  = buildLiteralDefaultMap(schema)
  const fieldRefDefaultMap = buildFieldRefDefaultMap(schema)
  const updatedByMap       = buildUpdatedByMap(schema)
  const createdByMap       = buildCreatedByMap(schema)
  const versionMap         = buildVersionMap(schema)
  const syncMap            = buildSyncMap(schema)
  const selfRelationMap    = buildSelfRelationMap(schema)
  const sequenceMap    = buildSequenceMap(schema)
  const enumMap        = buildEnumMap(schema)
  const transitionMap  = buildTransitionMap(schema)
  const sealMap        = buildSealMap(schema, relationMap,
                                      (m) => modelToTableName(schema.models.find(x => x.name === m), pluralizeTableNames))
  const capabilityMap  = capabilityDeclarations(schema)
  const ftsMap        = buildFtsMap(schema)
  const validationMap  = buildValidationMap(schema)
  const cardinalityMap = buildCardinalityMap(schema, pluralizeTableNames)
  const exclusionMap   = buildExclusionMap(schema, pluralizeTableNames)
  const fieldPolicyMap = buildFieldPolicyMap(schema)
  const secretMap      = buildSecretMap(schema)
  const claimSet       = buildClaimSet(schema, claims ?? null)
  const policyMap      = buildPolicyMap(schema, relationMap, claimSet)
  const scopeMap       = buildScopeMap(schema, relationMap, claimSet)
  checkFieldPolicies(schema, relationMap, claimSet)

  // A schema naming claims with nothing to grade them against says so once. The
  // alternative to a notice is a set invented here, which would refuse
  // `auth().isStaff` on every app that has one — and the alternative to saying
  // anything is a check that silently does not run, which is the shape of every
  // defect this one closes.
  if (!claimSet.active) {
    const used = authClaimsUsed(schema)
    // Once per distinct set of names, not once per client: a tenant registry
    // builds one client per tenant over one schema, and a test file builds
    // hundreds. A notice repeated is a notice muted.
    const key  = [...used].sort().join(',')
    if (used.size && !UNGRADED_CLAIMS_SAID.has(key)) {
      UNGRADED_CLAIMS_SAID.add(key)
      console.warn(
        `[litestone] auth().${[...used].sort().join(', auth().')} ` +
        `${used.size > 1 ? 'are' : 'is'} not graded: this schema declares no @@auth model and ` +
        `createClient() was passed no claims. A misspelled claim compiles to NULL, which the ` +
        `SQL half reads as "nobody" and the JS half as "everybody". Mark the principal model ` +
        `@@auth, or declare the ones that are on no row — a top-level \`claim <name>\`.`)
    }
  }
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

  // ── A write announced past this process ───────────────────────────────────
  //
  // `database <name> { announce crossProcess }`. The table and the recorder are
  // built at open, because the WRITE side has to work whether or not anything
  // in THIS process is listening — the subscriber is in another one, which is
  // the whole point (`FJS-642`). The reader is not: it costs a watch and a
  // timer, so it starts with the first `$tapEvents` tap and stops with the last.
  const crossProcessDbs = Object.fromEntries(
    (schema.databases ?? [])
      .filter(d => d.announce === 'crossProcess')
      .map(d => [d.name, dbRegistry[d.name]])
      .filter(([, conn]) => conn?.rawWriteDb))

  // `now` is optional and absent means the wall clock, the same reading
  // `atOneInstant` makes — so a frozen clock in a test reaches the recorded
  // announcement's timestamp, and therefore reaches retention.
  //
  // It is also `db.$now()`, because a deadline a caller MINTS has to come off
  // the clock `@@expires` grades it on. A session written at `Date.now() + ttl`
  // and read at an injected clock agree only while the two are the same clock,
  // which is everywhere but the test that means to move one.
  const nowDate = () => {
    const raw = typeof now === 'function' ? now() : new Date()
    return raw instanceof Date ? raw : new Date(raw)
  }

  const crossProcess = Object.keys(crossProcessDbs).length ? {
    // Which client instance wrote a row, so a process skips its own — it has
    // already announced them in-process, and re-announcing would double every
    // event and re-enter any subscriber that writes.
    origin:    `${process.pid}:${Math.random().toString(36).slice(2, 10)}`,
    recorders: {},
    watchers:  {},
    dbs:       crossProcessDbs,
  } : null

  if (crossProcess) {
    for (const [name, conn] of Object.entries(crossProcessDbs)) {
      ensureEventsTable(conn.rawWriteDb)
      crossProcess.recorders[name] = makeEventRecorder(conn.rawWriteDb, crossProcess.origin, nowDate)
    }
  }

  // Validate encryption key — fail fast if @encrypted fields exist but no key given
  const encKey = normalizeKey(encryptionKey ?? null)
  const prevKeys = (Array.isArray(previousEncryptionKeys) ? previousEncryptionKeys
                   : previousEncryptionKeys ? [previousEncryptionKeys] : [])
    .map((k, i) => {
      const b = normalizeKey(k)
      // Same refusal the current key gets, and for the same reason: a hex string
      // that is not 32 bytes decodes short and would silently never match.
      if (!b || b.length !== 32)
        throw new Error(`previousEncryptionKeys[${i}] must be 32 bytes (got ${b?.length ?? 0}) — it is parsed as hex`)
      return b
    })
  const encRing = encKey ? makeKeyring(encKey, prevKeys) : null
  if (!encKey && prevKeys.length)
    throw new Error('previousEncryptionKeys was given with no encryptionKey — there is nothing to rotate to')
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

  // Enum members by name, for the same validation. A SECOND map rather than
  // entries in the one above: the parser accepts a type and an enum sharing a
  // name, so one lookup could not say which a field meant.
  const enumTypeMap = new Map((schema.enums ?? []).map(e => [e.name, e.values.map(v => v.name)]))

  // Which models are somebody's `@@extensible(declaredBy:)`. Writing one
  // invalidates the cached declaration lists, so a field declared at three
  // o'clock is projected by the next write rather than by the next process.
  const extDeclarers = new Set(schema.models
    .flatMap(m => m.attributes.filter(a => a.kind === 'extensible'))
    .map(a => a.declaredBy))

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
  // A schema declaring no bound builds no ledger, so every write unit in every
  // other app takes the same path it always did.
  const cardinalityLedger = cardinalityMap.any
    ? createCardinalityLedger(cardinalityMap, (conn, rule, key) =>
        conn.query(`SELECT 1 FROM "${rule.parentTable}" WHERE ` +
                   rule.refColumns.map(c => `"${c}" = ?`).join(' AND ') + ' LIMIT 1').get(...key))
    : null
  // Read on the WRITE handle of each member's own file: the grade runs inside
  // the transaction, and a read handle cannot see the rows it is grading. A
  // readonly file's rows still occupy the range, so it is read where it can be.
  const exclusionLedger = exclusionMap.any
    ? createExclusionLedger(exclusionMap, (model) => {
        const conn = dbRegistry[modelDbMap[model] ?? 'main'] ?? dbRegistry.main
        if (conn.driver === 'jsonl' || conn.driver === 'logger') return null
        return conn.rawWriteDb ? conn.writeDb : conn.rawReadDb ? conn.readDb : null
      })
    : null
  // One entry per write CONNECTION a table can reach: a second declaration on
  // main's file is main's entry, and a readonly or `access: false` name has no
  // write handle to hold (`FJS-1459`).
  const txConns = [{ name: 'main', db: writeDb }]
  for (const [name, conn] of Object.entries(dbRegistry)) {
    if (!conn.rawWriteDb || conn.rawWriteDb === rawWriteDb) continue
    if (txConns.some(c => c.raw === conn.rawWriteDb)) continue
    txConns.push({ name, db: conn.writeDb, raw: conn.rawWriteDb })
  }
  const tx = makeTxManager(txConns, txState, cardinalityLedger, exclusionLedger)

  // Normalize global filters: { tableName: whereObject | (ctx) => whereObject }
  const globalFilters = filters ?? {}

  // ── A predicate that can never match is refused HERE, once ────────────────
  //
  // A `@@allow` over an @encrypted column and a global filter over a @computed
  // one both compile to a comparison no row satisfies, so the model reads as
  // empty for every caller, forever, with no error — a policy that silently
  // denies everything looks exactly like a table with no data. Both are decided
  // by the schema alone, so they are answerable once at startup instead of on
  // every query, which is also the only altitude where the fix is a schema edit
  // rather than a caught exception.
  //
  // Static filters only: a function form is given `ctx` and cannot be judged
  // without one. Its keys go through the ordinary per-query check.
  for (const [accessor, f] of Object.entries(globalFilters)) {
    if (typeof f === 'function' || !f) continue
    const model = schema.models.find(m =>
      m.name === accessor || m.name.charAt(0).toLowerCase() + m.name.slice(1) === accessor)
    if (!model?.fields) continue
    const keys = globalFilterKeysFor(model, edgeMap)
    const [bad] = collectWhereKeyProblems(f, keys.filterable, keys.computed, keys.encrypted, [], null, keys.transient)
    if (bad) throw new Error(`createClient: ${globalFilterRefusal(accessor, model.name, bad)}`)
  }

  for (const [modelName, ops] of Object.entries(policyMap)) {
    const model = schema.models.find(m => m.name === modelName)
    if (!model?.fields) continue
    const keys = filterableKeysFor(model)
    // A field node is `{ type: 'field', name }` wherever it sits in the tree.
    const fieldsIn = (node, out = []) => {
      if (!node || typeof node !== 'object') return out
      if (Array.isArray(node)) { for (const n of node) fieldsIn(n, out); return out }
      if (node.type === 'field' && node.name) out.push(node.name)
      for (const v of Object.values(node)) fieldsIn(v, out)
      return out
    }
    // An encoded column MAY appear in a predicate — policy.js encodes the operand
    // the way the column was encoded, the same rewrite a `where` gets. What it
    // cannot do is answer a comparison the encoding does not preserve, so what is
    // judged here is the SHAPE of the comparison rather than the field appearing
    // at all. The three refusals below are the three shapes with no answer.
    const encodingProblem = (node, out = []) => {
      if (!node || typeof node !== 'object') return out
      if (Array.isArray(node)) { for (const n of node) encodingProblem(n, out); return out }

      if (node.type === 'compare') {
        const { left, right } = node
        const fieldNode = left.type === 'field' ? left : right.type === 'field' ? right : null
        if (fieldNode && keys.encryptedAny.has(fieldNode.name)) {
          const name  = fieldNode.name
          const other = fieldNode === left ? right : left
          // `field == null` reads whether the column is set, not what it holds.
          if (other.type === 'literal' && other.value === null) return out
          if (keys.encrypted.has(name)) out.push(
            `"${name}" is @encrypted under a random IV, so the same value stores different bytes on every write and no `
            + `operand can be encoded to match it — declare it @encrypted(deterministic: true) or @hashed to compare it here`)
          else if (node.op !== '==' && node.op !== '!=') out.push(
            `"${name}" holds encoded bytes, which preserve equality and nothing else, so '${node.op}' cannot be answered`)
          else if (other.type === 'field') out.push(
            `"${name}" and "${other.name}" are compared column to column, and an encoded column can only be compared `
            + `against a value the policy can encode`)
          return out
        }
      }

      if (node.type === 'field' && keys.encryptedAny.has(node.name)) {
        out.push(`"${node.name}" holds encoded bytes and stands outside a comparison, where there is nothing to encode`)
        return out
      }

      for (const v of Object.values(node)) encodingProblem(v, out)
      return out
    }

    for (const [op, bucket] of Object.entries(ops)) {
      for (const rule of [...bucket.allows, ...bucket.denies]) {
        const decl = `${modelName}: the @@${bucket.allows.includes(rule) ? 'allow' : 'deny'}('${op}', …) policy`
        for (const name of fieldsIn(rule.expr)) {
          if (keys.transient.has(name)) throw new Error(
            `${decl} compares a value no row can satisfy, so every caller would read this model as empty — ` +
            `"${name}" is @transient, a payload key nothing stores, so it is not a column`)
          if (!keys.computed.has(name)) continue
          throw new Error(
            `${decl} compares a value no row can satisfy, so every caller would read this model as empty — ` +
            `"${name}" is @computed, so it is not a column and the comparison is between string constants`)
        }
        // `create` is evaluated in JS against the data as written, which is
        // plaintext, so every comparison form works there. `post-update` is
        // evaluated in JS too, but against the row read BACK, and an encrypted
        // column is @guarded — stripped from that row, so the comparison is
        // against undefined and denies every write.
        if (op === 'create') {
          // …and what it is written against is the PAYLOAD, so a column the
          // payload can never carry reads `undefined` there and the allow never
          // holds: the model becomes uncreatable by every caller.
          //
          // The two refusals above are the same class reached from the other
          // side — @computed and @transient are not columns, so the READ half
          // is broken too and the sentence is about the read. These three ARE
          // columns, so the read half works perfectly: the row is legible and
          // nothing can make it, which is `FJS-195`'s shape with the two
          // interpreters the other way round. Derived from the FACET — a value
          // SQLite computes from the row — rather than enumerated, or the next
          // virtual kind arrives with the same hole.
          const virtualIn = fieldsIn(rule.expr).find(n =>
            model.fields.find(f => f.name === n)?.attributes
              ?.some(a => a.kind === 'derived' || a.kind === 'generated' || a.kind === 'from'))
          if (virtualIn) {
            const kind = model.fields.find(f => f.name === virtualIn).attributes
              .find(a => a.kind === 'derived' || a.kind === 'generated' || a.kind === 'from').kind
            // The two directions fail opposite ways, so they get different
            // sentences: an allow that never holds refuses everybody, a deny
            // that never fires refuses nobody.
            const consequence = bucket.allows.includes(rule)
              ? `can never hold, so no caller could create this model`
              : `can never fire, so it refuses nothing`
            throw new Error(
              `${decl} ${consequence} — "${virtualIn}" is @${kind}, a value SQLite computes from the row, so it ` +
              `is not in the payload a create policy is evaluated against. Write the predicate over the columns ` +
              `it is computed from; the read policy can keep naming it.`)
          }
          continue
        }
        if (op === 'post-update') {
          const named = fieldsIn(rule.expr).find(n => keys.encryptedAny.has(n))
          if (named) throw new Error(
            `${decl} cannot be answered — "${named}" holds encoded bytes and a post-update check reads the row back ` +
            `through the field policy, which strips it, so every write would be rolled back`)
          continue
        }
        const [problem] = encodingProblem(rule.expr)
        if (problem) throw new Error(
          `${decl} compares a value no row can satisfy, so every caller would read this model as empty — ${problem}`)
      }
    }
  }

  // ── What a check() delegation reaches ─────────────────────────────────────
  //
  // Same altitude and the same argument as the block above: the compiler runs
  // per query and cannot say either of these without saying it on every call.
  // A cycle is refused because it is that block's own subject — a predicate no
  // row can satisfy — and a delegation to protection the compiler cannot see is
  // a warning, because it is a hole rather than an impossibility and the author
  // may have meant the policy tier to be open there (FJS-636).
  {
    const { cycles, gateOnly } = delegationProblems(policyMap, schema, relationMap)

    for (const { edges, back } of cycles) {
      const from = edges.findIndex(e => e.model === back)
      const loop = edges.slice(from < 0 ? 0 : from)
      const trail = loop.map(e => `${e.model}.${e.field} → ${e.target}`).join(', then ')
      const self  = loop.length === 1 && loop[0].model === loop[0].target
      throw new Error(
        `${loop[0].model}: the @@allow/@@deny policies delegate in a circle — ${trail}, which is back at ` +
        `${back}. A delegation that re-enters a model already on the path compiles to a predicate no row ` +
        `satisfies, so the rule admits only rows whose foreign key is NULL and denies every other caller in ` +
        `silence. ` + (self
          ? `A self-relation cannot delegate to itself: SQL has no unbounded recursion here, so "readable if ` +
            `its parent is" is expressible only as a column every row carries — denormalize the answer onto ` +
            `${back} and compare that.`
          : `Point one side at the columns it needs — @@allow('${loop[0].op}', …) over ${back}'s own fields — ` +
            `so the pair has a direction.`))
    }

    for (const { model, op, field, target, targetOp, protectedBy } of gateOnly) {
      console.warn(
        `[litestone] ${model}: @@allow/@@deny('${op}', check(${field})) delegates to ${target}, whose protection for ` +
        `'${targetOp}' is ${protectedBy} and no row policy. Delegation compiles the TARGET'S POLICY only — a ` +
        `gate is enforced a tier above, where no compiled predicate can see it — so this rule places no ` +
        `restriction at all on ${model}. Give ${target} an @@allow('${targetOp}', …), or drop the check() and ` +
        `say what ${model} requires.`)
    }
  }

  // ── Default gate enforcement ──────────────────────────────────────────────
  // A model that declares @@gate gets enforcement even when the app installs
  // no GatePlugin — the declaration is the contract, and a declared gate that
  // silently does nothing is a fail-open security default. The shipped
  // FrontierGateGetLevel resolver is the default; installing your own
  // GatePlugin({ getLevel }) replaces it entirely. Models without @@gate are
  // untouched: no gate declared, no gate enforced.
  //
  // A @@transitions clause carrying @gate(N) needs a level resolver for the
  // same reason, so it triggers the same auto-install — and so does a policy
  // reading `auth().level`, which without one is absent for every caller: an
  // allow on it never holds and a deny on it always fires (`FJS-D296`).
  let effectivePlugins = plugins ?? []
  const _anyGates = schema.models.some(m => m.attributes?.some(a =>
    a.kind === 'gate' ||
    (a.kind === 'transitions' && Object.values(a.transitions).some(t => t.gate != null))
  )) || authClaimsUsed(schema).has('level')
  if (_anyGates && !effectivePlugins.some(p => p instanceof GatePlugin)) {
    effectivePlugins = [...effectivePlugins, new GatePlugin({ getLevel: FrontierGateGetLevel })]
  }

  // ── Capability enforcement ────────────────────────────────────────────────
  // Same argument as the gate one line up: a declared @@capabilities that nothing
  // enforces is fail-open. Unlike the gate this takes no resolver and therefore
  // has nothing to replace — the caller's set is auth().capabilities (`FJS-D151`)
  // — so it is installed whenever a model declares the grid.
  const _anyCapabilities = schema.models.some(m => m.attributes?.some(a => a.kind === 'capabilities'))
  if (_anyCapabilities && !effectivePlugins.some(p => p instanceof CapabilityPlugin)) {
    effectivePlugins = [...effectivePlugins, new CapabilityPlugin()]
  }

  // Plugin runner — orchestrates all installed plugins
  const pluginRunner = new PluginRunner(effectivePlugins)

  // Shared context threaded through include resolution + table ops
  const ctx = {
    now,
    stampClock, _madeAt,
    relationMap, jsonMap, edgeMap, computedSets, fromMap,
    softDeleteMap, softDeleteCascadeMap, hasTemplatesMap, effectiveMap, commitmentMap, ftsMap, boolMap, bigMap, enumMap, filterKindMap, affinityMap, autoIdMap, generatedDefaultMap, authDefaultMap, literalDefaultMap, fieldRefDefaultMap, updatedByMap, createdByMap, versionMap, syncMap, selfRelationMap, sequenceMap, computedFns, tx,
    coFkMap,
    // model → its field → column, for the resolvers that answer for a model
    // that is not the one they were built for: an include, a relation filter
    // and a nested read all write an identifier belonging to the TARGET, and
    // `makeTable`'s own `col()` is the HOST's (`FJS-761`).
    columnMaps: Object.fromEntries(schema.models.map(m => [m.name, columnMapFor(m)])),
    // Which columns bind to a value set, resolved once. Absent for a schema
    // that declares none, so the check is one map lookup per write there.
    valueSetMap: buildValueSetMap(schema),
    // Default: parent values silently overwrite any child-supplied co-FK
    // values during nested writes — this is the safe choice that prevents
    // referential drift like a child line item ending up with a different
    // tenantId than its parent order. Setting allowChildFkOverride:true flips
    // the policy so an explicit child value wins, but a missing one still
    // gets auto-filled.
    allowChildFkOverride: allowChildFkOverride === true,
    transitionMap, sealMap,
    cardinalityMap,
    exclusionMap,
    capabilityMap,
    models:        modelIndex,
    schema,
    hasValidation: validationMap,
    typeMap,
    enumTypeMap,
    extDeclarers,
    // Shared by reference: a scoped client is `{ ...ctx }`, and a cache each
    // copy created for itself was one the declaring table's write never cleared.
    extDecl:       new Map(),
    fieldPolicyMap,
    policyMap,
    hasPolicies:   Object.keys(policyMap).length > 0,
    scopeMap,
    policyDebug,
    // A CELL, not a value. Every derived context — asSystem(), $setAuth(),
    // $scopedBy() — is a spread of this one, and a spread copies a string by
    // value: $rotateKey could update the root and every client already handed
    // out kept decrypting with the old key, silently, because read()'s catch
    // turns a failed GCM tag into `null` (FJS-236). A spread copies this
    // object by REFERENCE, so there is one key and nothing to keep in step.
    // `key` is the CURRENT key and stays a Buffer, because every write uses it
    // and nothing else may. `ring` is what a READ asks, so a value written under
    // a key this client has rotated away from is still readable (`FJS-714`).
    enc:           { key: encKey, ring: encRing },
    // Read by the decrypt path for one question: was this column DECLARED
    // un-rotatable? `@secret(rotate: false)` is an acknowledged loss — the
    // caller said the value stops being readable at the next rotation — so it
    // degrades where every other column raises (`FJS-716`).
    secretMap,
    isSystem:      false,
    // Which columns a caller may not NAME, per model, plus which models can reach
    // one at all. Built once — the relation walk is a fixed point over the graph.
    guardedMap:    buildGuardedMap(schema, relationMap),
    fieldReadMap:  buildFieldReadMap(schema, relationMap),
    hookRunner,
    emitter,
    globalFilters,
    plugins:       pluginRunner,
    auth:          null,
    readDb,
    logMap,
    onLog:        onLog ?? null,
    // Shared by REFERENCE, for the same reason the listener Sets below are: a
    // scoped client is `{ ...ctx }`, so a value assigned to the root after any
    // copy exists is invisible to that copy. Junction installs this at boot and
    // `withLitestoneDb` makes a fresh scoped client per request, but an
    // asSystem() taken at module scope would be a copy made first.
    _logContext:  { fn: logContext ?? null },
    // Shared by reference for the same reason. Read through `$logStats()`.
    _logStats:    { written: 0, dropped: 0, lastError: null, lastWrittenAt: null, lastDroppedAt: null, lastRetainAt: null },
    onQuery:       onQuery ?? null,
    _queryListeners: new Set(),    // runtime taps — shared ref across all scoped ctx copies
    // The cross-process announcement layer, or null. Shared by REFERENCE like
    // the listener sets above and for the same reason: an asSystem() write is
    // the one write nothing else announces, and a per-copy value would leave it
    // recording into a recorder no subscriber ever reads.
    _crossProcess: crossProcess,
    _eventListeners: new Set(),    // $tapEvents taps. Shared by REFERENCE for the same reason
                                   // the query set is: asSystem() and $setAuth() spread this
                                   // object, and a per-copy Set would mean a subscriber
                                   // attached to the root never sees an asSystem() write —
                                   // which is the one write nothing else announces (FJS-010)
    announce:      checkAnnounce(announceDefault, 'createClient') ?? 'collection',
    modelDbMap,
    pluralize:     pluralizeTableNames,   // used by makeTable to derive child SQL table names during cascades
    // Where a trail is written, by database name. TWO kinds, and the entry
    // carries which — `logger` is a directory of append-only jsonl, `sql` is an
    // ordinary table the app declared, which is the one a screen can read.
    loggerDbMap:   Object.fromEntries(
      Object.entries(dbRegistry)
        .filter(([, v]) => v.driver === 'logger' || (v.driver !== 'jsonl' && v.logModel))
        .map(([k, v]) => [k, { logModel: v.logModel, kind: v.driver === 'logger' ? 'logger' : 'sql' }])
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
      const table    = makeJsonlTable(filePath, model, schema, conn.retention, conn.maxSize, now, conn.busyTimeout)
      jsonlTableCache[model.name] = table
      jsonlTables.push(table)
    }
  }

  // Expose jsonlTableCache on ctx so makeTable log hooks can look up log tables by model name
  ctx.jsonlTableCache = jsonlTableCache

  // ── A trail that is an ordinary SQLite table ──────────────────────────────
  // Built on FIRST USE rather than up front, because `buildTableForModel` is
  // declared below this point and an app with no SQL trail must pay nothing.
  // Memoized, and built against a system context for the reason `getLogTable`
  // states: the row is the engine's, not the caller's.
  const _sqlLogTables = new Map()
  ctx.sqlLogTableFor = (modelName) => {
    if (!modelName) return null
    if (_sqlLogTables.has(modelName)) return _sqlLogTables.get(modelName)
    const model = schema.models.find(m => m.name === modelName)
    // The parser refuses a `model` key naming nothing, so this is the
    // in-memory-schema path rather than a reachable authoring mistake.
    const table = model ? buildTableForModel(model, { ...ctx, isSystem: true }) : null
    _sqlLogTables.set(modelName, table)
    return table
  }

  // Per-model database routing. One call per model for the life of the client
  // since `FJS-722` — a flavor gets a wrapper, not a build.
  function buildTableForModel(model, ctx) {
    const dbName    = modelDbMap[model.name] ?? 'main'
    const conn      = dbRegistry[dbName] ?? dbRegistry.main
    const sqlTable  = modelToTableName(model, pluralizeTableNames)

    if (conn.driver === 'jsonl' || conn.driver === 'logger') {
      return withArgValidation(jsonlTableCache[model.name], model, ctx)
    }
    return withArgValidation(makeTable(conn.readDb, conn.writeDb, {
      tableName:         sqlTable,
      modelName:         model.name,
      jsonFields:        jsonMap[model.name],
      generatedFields:   generatedMap[model.name],
      computedFields:    computedSets[model.name],
      softDelete:        softDeleteMap[model.name],
      ftsFields:         ftsMap[model.name],
      boolFields:        boolMap[model.name],
      bigFields:         bigMap[model.name],
      enumFields:        enumMap[model.name],
      fieldKinds:        filterKindMap[model.name],
      softDeleteCascade: softDeleteCascadeMap[model.name],
      fieldPolicy:       fieldPolicyMap[model.name],
      fromFields:        fromMap[model.name],
      columnMap:         columnMapFor(model),
    }, ctx), model, ctx)
  }

  // Every accessor of the shared set, wrapped for one flavor. The eager
  // counterpart of `makeLazyTables`, for the two flavors that are made once and
  // held for the life of the process rather than per request — the root client
  // and `asSystem()`, both of which are read through `ownKeys` by tooling that
  // expects a plain object.
  function makeAllFlavorTables(flavor) {
    const out = {}
    for (const accessor of _tableAccessorNames) {
      const shared = sharedTableFor(accessor)
      if (shared !== undefined) out[accessor] = wrapForFlavor(shared, flavor)
    }
    return out
  }

  function buildTableForView(view, ctx) {
      const dbName = view.db ?? 'main'
      const conn   = dbRegistry[dbName] ?? dbRegistry.main
      if (conn.driver === 'jsonl' || conn.driver === 'logger') return null

      // A view names nothing else: every other key of `shape` defaults to the
      // empty answer, which is what it means for a read-only projection.
      const baseTable = makeTable(conn.readDb, conn.writeDb, {
        tableName: view.name,
        modelName: view.name,
      }, ctx)

      const writeBlocked = () => {
        throw new Error(`"${view.name}" is a view — write operations are not supported`)
      }

      // The WRITES are enumerated and the reads are not, which is the way round
      // that matters.
      //
      // This used to hand-list the ten reads it forwarded, and a read `makeTable`
      // grew after that list was written simply was not on a view — silently, and
      // with no error naming the view. Four were missing: `findManyAndCount`,
      // `cursorFor`, `orderTotal` and `query`. The first of those is what
      // junction's `find` calls, so no service could list a projection and the
      // whole Data realm's read surface stopped at the API boundary
      // (`FJS-997`).
      //
      // Inverting it puts the brittleness where it is cheap: a new READ reaches
      // views for free, and a new WRITE missing from this set is what the test
      // beside it exists to catch. It has to be caught rather than defaulted,
      // because a `@@materialized` view is a real TABLE — a write to one
      // succeeds and is then destroyed by the next refresh, which is worse than
      // a refusal and quieter than one.
      const out = {}
      for (const key of Object.keys(baseTable)) {
        const value = baseTable[key]
        if (typeof value !== 'function') { out[key] = value; continue }
        out[key] = VIEW_REFUSED.has(key) ? writeBlocked : value.bind(baseTable)
      }
      // A write a view must refuse even where `makeTable` never offered it.
      for (const key of VIEW_REFUSED) if (!(key in out)) out[key] = writeBlocked

      // `refresh()` is the other half of `@@materialized` and exists only where
      // the schema declared no `@@refreshOn`: with triggers installed the table
      // is already correct at rest, so a second way to rebuild it would be two
      // owners of one fact.
      //
      // It requires `asSystem()`, and that is derived rather than chosen: the
      // rebuild runs `@@sql` over every source row with no policy applied, so
      // any caller who could ask for it could publish an aggregate of rows they
      // may not read. The view's own `@@gate` grades READING the result and
      // says nothing about that.
      if (view.materialized && !(view.refreshOn ?? []).length) {
        out.refresh = () => {
          if (!ctx.isSystem)
            throw new Error(
              `"${view.name}".refresh() recomputes from every source row and requires asSystem()`
            )
          const sql = view.sql.trim().replace(/;$/, '')
          // A SAVEPOINT rather than a BEGIN: `refresh()` is the shape a job
          // calls inside a `$transaction` that has already taken the write
          // lock, and a nested BEGIN is an error rather than a no-op. Emptied
          // and refilled together, or a reader between the two statements sees
          // a view that exists and holds nothing.
          const sp = `refresh_${view.name}`
          conn.writeDb.run(`SAVEPOINT "${sp}"`)
          try {
            conn.writeDb.run(`DELETE FROM "${view.name}"`)
            conn.writeDb.run(`INSERT INTO "${view.name}" ${sql}`)
            conn.writeDb.run(`RELEASE "${sp}"`)
          } catch (err) {
            conn.writeDb.run(`ROLLBACK TO "${sp}"`)
            conn.writeDb.run(`RELEASE "${sp}"`)
            throw err
          }
        }
      }
      return out
  }

  // ─── The shared build ──────────────────────────────────────────────────────
  //
  // One table object per model, for every flavor of client (`FJS-722`). The ctx
  // it closes over is `ctx` itself by PROTOTYPE — live, because `ctx.tables`,
  // `ctx.jsonlTableCache` and a plugin's own keys are all assigned after this
  // object exists, and a snapshot would miss every one of them — with the four
  // keys a flavor decides shadowed by getters over the call in progress.
  //
  // Reading one outside a call throws rather than falling back to the root
  // (`FLAVOR_REFUSAL`). `configurable: true` so a test can restore the plain
  // value if it ever needs to.
  const sharedCtx = Object.create(ctx)
  // The per-flavor IDENTITY, for the caches that were keyed on the ctx object
  // because the ctx object used to BE per flavor: the gate plugin's level
  // resolver, external-ref's stash, and the hoisted field-read answer. Sharing
  // the ctx made all three share one cache across principals — the gate one
  // silently, which is fourteen tests and would have been every app. Not
  // enumerable: `{ ...ctx }` must keep producing a flavor context and not a
  // second thing claiming to be a flavor.
  Object.defineProperty(sharedCtx, '_flavor', {
    configurable: true,
    enumerable:   false,
    get() {
      const f = _flavor.getStore()
      if (f === undefined) throw new Error(FLAVOR_REFUSAL('ctx._flavor'))
      return f
    },
  })
  for (const key of ['auth', 'isSystem', 'scopedBy', 'tables']) {
    Object.defineProperty(sharedCtx, key, {
      configurable: true,
      enumerable:   true,
      get() {
        const f = _flavor.getStore()
        if (f === undefined) throw new Error(FLAVOR_REFUSAL(`ctx.${key}`))
        return f[key]
      },
    })
  }

  // Each shared table's answer to *these rows of yours were removed by a
  // cascade* — the rows SQLite deletes inside a parent's DELETE, which no
  // plugin and no log would otherwise hear of (FJS-1497). On the shared ctx
  // only and not enumerable, so a flavor's `{ ...ctx }` and the trail's system
  // build never register a second one.
  const _cascadeSinks = new Map()
  Object.defineProperty(sharedCtx, 'registerCascadeSink', {
    configurable: true, enumerable: false,
    value: (modelName, sink) => { _cascadeSinks.set(modelName, sink) },
  })
  Object.defineProperty(sharedCtx, 'cascadeSinkFor', {
    configurable: true, enumerable: false,
    value: (modelName) => {
      if (!_cascadeSinks.has(modelName)) sharedTableFor(modelToAccessor(modelName))
      return _cascadeSinks.get(modelName) ?? null
    },
  })

  // Built once per model, on first use, and never rebuilt.
  const _sharedTables = Object.create(null)
  function sharedTableFor(accessor) {
    const hit = _sharedTables[accessor]
    if (hit !== undefined) return hit
    const build = _tableBuilders.get(accessor)
    if (!build) return undefined
    const t = build(sharedCtx)
    if (t != null) _sharedTables[accessor] = t
    return t
  }

  // A flavor's view of one shared table: the same methods, each entering the
  // flavor's scope. ~29 arrows rather than a 5,900-line closure — measured at
  // 6.6 µs against 261 µs for five models on the 188-model fixture.
  //
  // Own enumerable function properties only: a getter on a table accessor would
  // be EVALUATED by this loop, and a scope wrapper's own keys are added on top
  // of this by `installScopes`, not here.
  function wrapForFlavor(table, flavor) {
    const out = {}
    for (const key of Object.keys(table)) {
      const fn = table[key]
      if (typeof fn !== 'function') { out[key] = fn; continue }
      out[key] = (...args) => _flavor.run(flavor, () => fn.apply(table, args))
    }
    return out
  }

  // Accessor-name → builder lookup, used by the lazy per-auth table proxy.
  // Built once — schema is immutable after createClient.
  const _tableBuilders = new Map()
  for (const model of schema.models) _tableBuilders.set(modelToAccessor(model.name), (ctx) => buildTableForModel(model, ctx))
  // A view's stub is in `schema.models`, so the loop above registered a TABLE
  // over the snake-case name at this same accessor — the view must land on
  // that key to replace it, or a PascalCase view reads a table that does not
  // exist (`FJS-1631`).
  for (const view of (schema.views ?? [])) _tableBuilders.set(modelToAccessor(view.name), (ctx) => buildTableForView(view, ctx))
  const _tableAccessorNames = [..._tableBuilders.keys()]

  // Lazily-constructed tables object for auth-scoped clients. $setAuth used to
  // eagerly rebuild EVERY table (~40 closures per model) per call — ~105µs on a
  // 15-model schema, paid per request since req.user is a fresh object each
  // time. Now a table is built on first access, so $setAuth is O(models touched).
  //
  // Since `FJS-722` the per-model object is SHARED and what a flavor gets is a
  // thin wrapper entering its scope, so this is O(models touched) in ~29 arrows
  // rather than in table builds.
  //
  // `flavor` is the ALS store — `{ auth, isSystem, scopedBy, tables }`. It is
  // handed in half-built: `tables` is assigned by the caller once this proxy
  // exists, because a nested write reaches the flavor's OWN tables through
  // `ctx.tables` and the two are mutually referential.
  function makeLazyTables(flavor) {
    const cache = Object.create(null)
    const get = (prop) => {
      if (cache[prop] !== undefined) return cache[prop]
      const shared = sharedTableFor(prop)
      if (shared === undefined) return undefined
      const t = wrapForFlavor(shared, flavor)
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

  // The root client is a flavor like any other — signed out, not system. It
  // gets a scope for the same reason every other one does: with no scope the
  // shared ctx refuses, and `db.posts.findMany()` on the bare client is a
  // legitimate call rather than an escaped one.
  const rootFlavor = { auth: null, isSystem: false, scopedBy: undefined, tables: null }
  const tables = makeAllFlavorTables(rootFlavor)
  rootFlavor.tables = tables

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
  // Parameterized scopes are NOT supported — write a function that returns a
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
      // a top-level function: that would have meant a parameterized scope, which
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
  // Evaluates a stack of scope definitions against a ctx, materializing
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
  // exposed as-is when no scope stack would change behavior, otherwise throw.
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
        return dedupeKeys(Reflect.ownKeys(target), Object.keys(scopeMap))
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

  // ─── $checkWhere ────────────────────────────────────────────────────────
  //
  // $checkWhere(accessor, where) → [{ key, suggestion, allowed }]
  //
  // Ask before you query. For a boundary that can answer 400 — see
  // collectWhereKeyProblems. Unknown accessor → [] rather than a throw: "I
  // cannot judge this" is not "this is wrong", and a caller using it to reject
  // must not reject what it failed to understand.
  //
  // Defined ONCE here and handed to every proxy below. It lived inline in the
  // root proxy's get trap until 2026-08-06, which meant `$setAuth`, `asSystem`
  // and `$scopedBy` clients did not have it — and because a Litestone proxy
  // THROWS on an unknown property rather than returning undefined, even asking
  // `typeof db.$checkWhere` blew up. Junction puts a `$setAuth` client on
  // `ctx.locals.db`, so its autoFilter hook threw on every list read by a
  // signed-in caller, in every app, with a message about a table nobody named.
  // Which filter keys are valid is a question about the SCHEMA — auth and scope
  // have no bearing on it, so every flavor of client answers it identically.
  function $checkWhere(accessor, where) {
    const model = modelForAccessor(accessor)
    if (!model?.fields) return []
    const keys = filterableKeysFor(model)
    for (const d of Object.values(ctx.edgeMap?.[model.name] ?? {})) keys.filterable.add(d.as)
    return collectWhereKeyProblems(where, keys.filterable, keys.computed, keys.encrypted, [],
                                   new Set(Object.keys(ctx.scopeMap?.[model.name] ?? {})), keys.transient,
                                   { ctx, model: model.name })
      // `p.model` where the key was found through a relation — naming the model
      // it was graded against rather than the one the request addressed, which
      // is the only one a caller can look up.
      .map(p => {
        // The HTTP path: junction's autoFilter answers a 400 built from these.
        const hidden = _guardedNames({ name: p.model ?? model.name }, ctx)
        if (!hidden) return { ...p, message: p.message.replace('%MODEL%', p.model ?? model.name) }
        const allowed = (p.allowed ?? []).filter(n => !hidden.has(n))
        return {
          ...p,
          allowed,
          suggestion: p.suggestion && hidden.has(p.suggestion) ? suggestKey(p.key, new Set(allowed)) : p.suggestion,
          message:    p.message.replace('%MODEL%', p.model ?? model.name),
        }
      })
  }

  // The declared scope names for a model, as source text. The published list
  // `$checkWhere` validates a `$scope` against — asked rather than copied, so a
  // UI offering scopes and the client refusing one cannot disagree. A schema
  // fact, so it is on every flavor of client, like both $check* helpers.
  function $scopes(accessor) {
    const model = modelForAccessor(accessor)
    if (!model) return {}
    const out = {}
    for (const [name, expr] of Object.entries(ctx.scopeMap?.[model.name] ?? {}))
      // A scope a `valueset` minted from its `where` is SQL and is its own
      // source text. It is listed rather than hidden: it is filterable, a
      // caller may name it, and `$checkWhere` already validates against this
      // same set — a scope missing from the published list reads as unknown.
      out[name] = expr.__raw ?? policyExprToString(expr)
    return out
  }

  // `ctx.models` is keyed by MODEL NAME and every caller here passes an
  // ACCESSOR, so the lookup missed every time and each of the six `$` siblings
  // paid a scan of the model list with a name derivation per model. `$readAs`
  // is the one that makes it matter: it runs once per broadcast cohort, so the
  // cost is multiplied by the audience — measured, 17 µs a call on a 188-model
  // schema against 2 µs on a small one (`FJS-723`). Indexed under both spellings
  // because reaching one of these with a model name has always worked.
  const accessorIndex = {}
  for (const m of schema.models) {
    accessorIndex[modelToAccessor(m.name)] = m
    accessorIndex[m.name] = m
  }
  function modelForAccessor(accessor) {
    return accessorIndex[accessor]
  }

  // The tenancy declaration, resolved — null when the schema declares none.
  // A schema fact, so it is on every flavor of client, and memoized because
  // resolving reads env vars and the filesystem's idea of cwd.
  //
  // What it is FOR: everything above the Data realm has to know whether this
  // app is one database or one per tenant, and the answer used to exist only
  // in whichever JS call happened to build the registry. Junction asks it to
  // resolve a request; the CLI asks it to know which files `tenant migrate`
  // walks.
  let _tenancy
  function tenancyInfo() {
    if (_tenancy === undefined)
      _tenancy = resolveTenancy(schema, { schemaPath: schemaFilePath ?? null })
    return _tenancy
  }

  // ─── $checkOrderBy ──────────────────────────────────────────────────────
  //
  // $checkOrderBy(accessor, orderBy, { aggregates }) → [{ key, reason, suggestion, sortable, message }]
  //
  // $checkWhere's sibling, same contract in every respect: ask before you
  // query, unknown accessor answers [] because "I cannot judge this" is not
  // "this is wrong", and every flavor of client answers identically because
  // sortability is a fact about the schema that auth and scope cannot change.
  //
  // It exists for the same reason $checkWhere does. The ORM throws, which is
  // right below the boundary; a boundary that can answer 400 has to ask
  // without running the query, and must not grow a second copy of the rule.
  // `reason` is 'computed', 'opaque' or 'unknown' — a boundary wants to say
  // different sentences for "no such field", "that field is derived in JS" and
  // "that column stores a serialization, so its text is not the value".
  function $checkOrderBy(accessor, orderBy, opts = {}) {
    const model = modelForAccessor(accessor)
    if (!model?.fields) return []

    // The same lift `checkOrderBy` makes, and it has to be made HERE too:
    // junction's `autoSort` asks this before the call is made, so a distance
    // order refused here never reaches the client that would have run it.
    const points = pointFieldsOf(model)
    if (points.size) {
      const { kept, problem } = liftNearOrders(points, orderBy)
      if (problem) return [{ key: problem.key, reason: 'invalid', sortable: [],
                             suggestion: null, message: problem.message }]
      if (!kept.length) return []
      orderBy = Array.isArray(orderBy) ? kept : kept[0]
    }

    const { sortable, relations, computed, transient, opaque } = sortableKeysFor(model)
    // Legality is still the schema's — what narrows is only what the 400 SAYS,
    // which is the half junction puts in front of an unauthenticated caller.
    return collectOrderByKeyProblems(orderBy, sortable, relations, computed, opaque, opts.aggregates === true, transient, [],
                                     _shownSet(sortable, _guardedNames(model, ctx)),
                                     sortHopFor(ctx, model.name))
      .map(p => ({ ...p, message: p.message.replace('%MODEL%', model.name) }))
  }

  // ─── $protectedFields ───────────────────────────────────────────────────
  //
  // $protectedFields(accessor) → { field: 'guarded' | 'encrypted' | 'hashed' }
  //
  // Which columns of a model must never be written down in plain text. The
  // third sibling of $checkWhere/$checkOrderBy and the same contract: an
  // unknown accessor answers {}, and every flavor of client answers
  // identically, because what a schema DECLARES protected is not a question
  // about who is asking.
  //
  // It exists because an application keeps a trail of its own. Litestone
  // redacts these fields in `@@log(audit)` — the repo states that as an
  // invariant — but an app writing "who did what" into its own table has
  // nothing to ask, and the alternative is a hand-copied list of column names
  // that goes stale the first time somebody adds a `@secret`. One reading of
  // the schema, in the package that owns the schema.
  //
  // The value says WHICH protection, because they are not interchangeable:
  // `guarded` is a system-context lock in both directions, `encrypted` hides a
  // value from a non-system reader and stays writable, and `hashed` has no
  // plaintext to reveal at all. A caller that only wants the names takes the
  // keys.
  function $protectedFields(accessor) {
    const model = modelForAccessor(accessor)
    if (!model?.fields) return {}
    const out = {}
    for (const [field, policy] of Object.entries(fieldPolicyMap?.[model.name] ?? {})) {
      if (policy.guarded)        out[field] = 'guarded'
      else if (policy.hashed)    out[field] = 'hashed'
      else if (policy.encrypted) out[field] = 'encrypted'
    }
    return out
  }

  // ─── $primaryKey ────────────────────────────────────────────────────────
  //
  // $primaryKey(accessor) → the key's columns, IN KEY ORDER; [] for an unknown
  // accessor or a model with no declared key.
  //
  // The sixth sibling of $checkWhere/$checkOrderBy/$protectedFields, and the
  // same contract: every flavor of client answers identically, because what a
  // schema declares the key to be is not a question about who is asking.
  //
  // It exists because the layer above has to know whether a row can be named by
  // ONE value. `expandCompositeId` stamps `@id` on every member of an
  // `@@id([a, b])`, so asking the fields answers all of them and in DECLARATION
  // order — and the key's own order, which is what the implicit index is
  // prefix-matched on, is stated only on the model attribute. A caller reading
  // it off the fields gets a plausible wrong answer (`FJS-694`).
  function $primaryKey(accessor) {
    const model = modelForAccessor(accessor)
    if (!model) return []
    const composite = model.attributes?.find(a => a.kind === 'id')
    if (composite?.fields?.length) return [...composite.fields]
    const single = model.fields?.find(f => f.attributes.some(a => a.kind === 'id'))
    return single ? [single.name] : []
  }

  // ─── $readAs ────────────────────────────────────────────────────────────
  //
  // $readAs(accessor, row, principal) → the row as that principal would have
  // read it, or null where they may not read it at all.
  //
  // The fifth sibling of $checkWhere, $checkOrderBy, $protectedFields and
  // $capabilitiesFor, and it takes its subject as an ARGUMENT for
  // $capabilitiesFor's reason: the asker holds one client and is answering
  // about somebody else. Every flavor of client answers identically for the
  // same principal.
  //
  // **It exists because a broadcast is not a SELECT.** `@@allow` compiles into
  // a WHERE, so a row that reaches a caller through a query is filtered by
  // construction and a row that reaches them through a WebSocket frame is not
  // filtered by anything — an anonymous socket received rows the same caller
  // was answered 401 for (`FJS-631`). Junction owns the fan-out and cannot own
  // the rule: the gate, the row policies and the field policies are declared
  // here, and a second implementation of any of them is a second answer to who
  // may read.
  //
  // Three questions in the order every other layer here reads them:
  //
  //   1. the GATE — about the caller alone, so it is asked first and is an
  //      integer comparison. It is the whole answer for a stranger, which is
  //      the case this was built for.
  //   2. the ROW POLICY — `policyVerdict`, the one owner, in JS against the row
  //      in hand. No query: the row is already here.
  //   3. the FIELD policies — what of the row they may see. Safe to apply to a
  //      row that has already been read, because every protection strips for a
  //      NON-system reader and a recipient is never system, so the decrypt
  //      branch cannot run.
  //
  // **It fails closed.** `policyVerdict` throws on an undecidable policy — a
  // `check()` over a relation that is not to-one — and at a boundary an
  // undecidable policy must refuse. Refusing costs a subscriber an update;
  // passing hands them a row the schema says is not theirs.
  //
  // The row is NOT re-read. Hasura re-runs the query per cohort and can, having
  // a database connection per subscription; here the announcement already
  // carries the row and a query per recipient per write is the cost that makes
  // this design unaffordable. What that gives up is a `@from` or a `@computed`
  // value the writer's own read resolved — the recipient gets the writer's, not
  // one derived under their own policies.
  async function $readAs(accessor, row, principal) {
    if (!row) return null
    const model = modelForAccessor(accessor)
    if (!model?.name) return null
    const modelName = model.name

    const readCtx = ctxForPrincipal(principal)

    // 1. The gate. `levelPasses` is the plugin's own comparison and `gateFor`
    // its own map — 8 and 9 are sentinels rather than rungs, so a `>=` spelled
    // here reads LOCKED as a high level and hands a subscriber every row on the
    // most protected model in the schema.
    const required = ctx.gateFor?.(modelName, 'read')
    if (required != null) {
      const level = await readCtx.levelFor?.(modelName, readCtx)
      if (!levelPasses(required, level ?? 0)) return null
    }

    // 2. The row policy.
    let verdict
    try { verdict = policyVerdict(modelName, row, readCtx, readCtx.policyMap ?? {}, readCtx.relationMap, 'read') }
    catch { return null }
    if (!verdict.ok) return null

    // 3. The shape.
    const fp = fieldPolicyMap?.[modelName]
    return fp && Object.keys(fp).length
      ? applyFieldPolicyTo(row, modelName, fp, readCtx, { mode: 'single' })
      : row
  }

  // A context for somebody else, memoized per principal object. `$setAuth`
  // builds lazy tables and installs scopes because it returns a CLIENT; this
  // needs only the context the rules read, which is what makes grading a
  // recipient affordable at all.
  const _gradeCtxs = new WeakMap()
  function ctxForPrincipal(principal) {
    if (principal == null) return { ...ctx, auth: null }
    if (typeof principal !== 'object') return { ...ctx, auth: principal }
    let c = _gradeCtxs.get(principal)
    if (!c) _gradeCtxs.set(principal, c = { ...ctx, auth: principal })
    return c
  }

  // ─── $readGrading ───────────────────────────────────────────────────────
  //
  // $readGrading(accessor) → 'open' | 'graded'
  //
  // Whether $readAs can ever answer anything but the row it was given. A model
  // whose read gate is 0 (or absent) and which declares no read policy and no
  // field policy admits every reader and hides no column, so grading it is pure
  // cost — a catalog is that shape, and a catalog is the busiest channel an
  // app has.
  //
  // Answered from the SCHEMA rather than guessed at by the caller, so a policy
  // added to a model that had none turns its channel from open to graded with
  // nothing to remember.
  // ─── $inWindow ──────────────────────────────────────────────────────────
  //
  // $inWindow(accessor, row, asOf?) → is this row in force.
  //
  // **A broadcast is not a read, and a window is not an access rule** — which
  // is why this is its own seam rather than a fourth question inside `$readAs`.
  // `$readAs` answers *may this principal see this row*; the window answers
  // *does this row count right now*, which is true or false for everybody.
  // Folding it in would also put it behind `$readGrading`'s `open` fast path,
  // where a catalog-shaped model with a window and no gate skips grading
  // entirely.
  //
  // It exists because the two existing exclusions do not need it and this one
  // does. `@@softDelete`'s transition is a WRITE, so it announces itself and a
  // subscriber's store corrects; a window's transition is the CLOCK, and
  // nothing announces. What this closes is the frame that is emitted AFTER the
  // row fell out of the window — a create or an update on a row already dead,
  // and a `withExpired` read that then wrote. What it cannot close is silent
  // expiry, where no write ever happens: that needs a store that re-grades on a
  // tick, which is a different feature (`@frontierjs/toolbelt/match` is where
  // the client half would go).
  //
  // **The caller decides what to do with a `false`, and for `deleted` the
  // answer is send it anyway** — suppressing a removal for a row a subscriber
  // already holds strands it there for ever, which is worse than never having
  // graded at all. Junction's fan-out holds the event name; this does not.
  //
  // The predicate is the same rule `injectEffectiveFilter` compiles into SQL,
  // evaluated here against the row in hand — `policyVerdict`'s shape exactly,
  // and for its reason: there is no query to filter through. Both read
  // `effectiveMap`, so the rule has one origin and two evaluators. A string
  // compare is sound for both kinds: an ISO instant and a `YYYY-MM-DD` day both
  // order lexicographically the way they order in time.
  function $inWindow(accessor, row, asOf) {
    const model = modelForAccessor(accessor)
    const win   = model?.name ? effectiveMap[model.name] : null
    if (!win || !row) return true
    // A frame with no stated moment grades an `@@effective` row the way a read
    // with none does: every row is there, the history a store holds included.
    if (!win.imposed && asOf == null) return true

    const at = asOf != null
      ? (asOf instanceof Date ? asOf.toISOString() : String(asOf))
      : (win.kind === 'day' ? nowISO(now).slice(0, 10) : nowISO(now))

    // A null edge is an open end — `from` null is *always has been*, `to` null
    // is *still in force* — which is the same reading the SQL injects.
    const from = win.from ? row[win.from] : null
    const to   = win.to   ? row[win.to]   : null
    if (from != null && String(from) >  at) return false
    if (to   != null && String(to)   <= at) return false
    return true
  }

  function $readGrading(accessor) {
    const model = modelForAccessor(accessor)
    if (!model?.name) return 'graded'          // unknown: fail closed
    const modelName = model.name
    const gate = ctx.gateFor?.(modelName, 'read')
    if (gate != null && gate > 0) return 'graded'
    const rules = policyMap?.[modelName]
    if (rules?.read?.allows?.length || rules?.read?.denies?.length) return 'graded'
    const fp = fieldPolicyMap?.[modelName]
    if (fp && Object.keys(fp).length) return 'graded'
    return 'open'
  }

  // ─── $levelOf ───────────────────────────────────────────────────────────
  //
  // $levelOf(accessor?, principal?) → 0–8, or null where this client cannot
  // grade anyone.
  //
  // **What level does the app grade this caller at.** The seventh sibling, and
  // the one that exists because the mapping is declared ONCE — in
  // `GatePlugin({ getLevel })` — and every other realm was re-deriving it. A
  // level is a fact about the APP's own standing (a membership row, a role
  // column, a workspace), so a layer that grades with the shipped `gradeStanding`
  // instead answers a different number for the same caller: measured on
  // basecamp, an `admin` of a workspace is ADMINISTRATOR(5) to the Data boundary
  // and CREATOR(3) to a Junction method gate, so a caller the schema admits was
  // refused at the API with a level nothing in the app had written (`FJS-1161`).
  //
  // Per MODEL, because `getLevel(auth, model)` is — an app may grade the same
  // caller differently for two models. An accessor that names no model, and an
  // omitted one, pass `null` as the model, which is what a modelless service
  // asking about its own caller has to mean.
  //
  // The principal is OPTIONAL, which is where it parts company with `$readAs`:
  // the commonest caller holds the asker's own scoped client and is asking about
  // the caller it was scoped to, and answering that off this client's own
  // principal is what picks up the gate's per-request cache. State one to grade
  // somebody else — a broadcast recipient — exactly as `$readAs` does.
  //
  // **`null` is *I cannot grade*, not a level.** A schema declaring no `@@gate`
  // installs no plugin, so there is no mapping to ask and no number that would
  // be honest; the caller decides what to do with that, and inventing a default
  // here is the failure this replaces.
  //
  // Each flavor binds its OWN ctx rather than reading `ctx.auth`, which is a
  // getter over the call in progress (`FJS-722`) and refuses outside a table
  // method — so the omitted-principal form has nothing to read unless the
  // flavor states it.
  function $levelOfAs(ownCtx) {
    return function $levelOf(accessor, ...principal) {
      const modelName = modelForAccessor(accessor)?.name ?? null
      const forCtx    = principal.length ? ctxForPrincipal(principal[0]) : ownCtx
      if (typeof forCtx.levelFor !== 'function') return null
      return forCtx.levelFor(modelName, forCtx)
    }
  }

  // ─── $capabilitiesFor ───────────────────────────────────────────────────
  //
  // $capabilitiesFor(principal) → { held, unknown, byModel }
  //
  // *What can this person do* — `FJS-D148`. The fourth sibling of $checkWhere,
  // $checkOrderBy and $protectedFields, and the same contract: it takes its
  // subject as an ARGUMENT and every flavor of client answers identically for
  // the same one, because what a name GRANTS is a fact about the schema and not
  // about which client is asking. Defaulting to this client's own principal
  // would break exactly that.
  //
  // Takes a principal (anything carrying `capabilities`) or the bare list, since
  // an application computing the union of somebody's roles holds the list before
  // it holds a principal, and the two are told apart without guessing.
  //
  // `unknown` is the half that earns the method. A capability is a reference,
  // so renaming the referent renames the capability and the OLD string is left
  // sitting in every Role row in every tenant's database — which is why D148
  // rules that a rename emits a data migration. This is what shows you the
  // migration that did not run: a name somebody still holds and this schema no
  // longer declares, which grants nothing and looks exactly like a grant.
  //
  // It answers what is HELD and never the complement. *What can Ada not do* is
  // the whole derived set minus this, which on a real application is 150 rows of
  // nothing happening.
  //
  // The other half of D148's question — *what could Ada do in March* — is not
  // answerable here and no argument makes it so: the roles have changed, so it
  // can only come from what the audit trail recorded at the moment of the
  // decision (`IDEAS/compliance-from-the-seed.md`).
  function $capabilitiesFor(principal) {
    const raw = Array.isArray(principal) || principal instanceof Set
      ? principal
      : principal?.capabilities
    const wanted = raw instanceof Set ? [...raw] : Array.isArray(raw) ? raw : []

    const declared = capabilityNames(schema)
    const held = [], unknown = [], byModel = {}

    for (const name of [...new Set(wanted.map(String))].sort()) {
      if (!declared.has(name)) { unknown.push(name); continue }
      held.push(name)
      const cut = name.lastIndexOf('.')
      ;(byModel[name.slice(0, cut)] ??= []).push(name.slice(cut + 1))
    }
    return { held, unknown, byModel }
  }

  // ─── $claimsFor ─────────────────────────────────────────────────────────
  //
  // $claimsFor(principal) → { <claim>: value | null }
  //
  // The claims the schema reads off a row pointing at the caller —
  // `claim employeeId from Employee(userId)`. The subject as an ARGUMENT, like
  // $capabilitiesFor, so every flavor answers the same for the same caller.
  //
  // Read as the SYSTEM: the row decides this caller's access, so it cannot be
  // read through a client already scoped by that access. asSystem() lifts no
  // exclusion, so a soft-deleted or expired role row resolves to nothing — the
  // model's own declaration answers that, and no rule here restates it.
  //
  // A caller with no id gets `{}`: there is nothing to look a row up by. A
  // caller with no row gets null for each claim, which is the statement *holds
  // none*, and reads the same in both policy interpreters (`FJS-668`). One read
  // per (model, subject), however many claims come off that row.
  async function $claimsFor(principal) {
    const sources = Object.entries(schema.claimSources ?? {})
    const id      = principal?.id ?? null
    if (id == null || !sources.length) return {}

    const reads = new Map()
    for (const [name, src] of sources) {
      const key = `${src.model}\0${src.subject}`
      if (!reads.has(key)) reads.set(key, { model: src.model, subject: src.subject, claims: [] })
      const column = src.column ?? $primaryKey(modelToAccessor(src.model))[0]
      reads.get(key).claims.push({ name, column })
    }

    const sys = asSystem()
    const out = {}
    for (const { model, subject, claims } of reads.values()) {
      const select = Object.fromEntries(claims.map(c => [c.column, true]))
      const row    = await sys[modelToAccessor(model)].findFirst({ where: { [subject]: id }, select })
      for (const c of claims) out[c.name] = row?.[c.column] ?? null
    }
    return out
  }

  // ─── $softDelete ────────────────────────────────────────────────────────
  //
  // $softDelete → { ModelName: boolean }
  //
  // Which models hide a removed row rather than destroying it. Keyed by MODEL
  // name, like $enums and $relations; the accessor-keyed siblings are the ones
  // that take an argument.
  //
  // A COPY, and on every flavor of client. The live map is what every read
  // filters against, so handing it out let a caller turn soft delete off for
  // the whole client by assigning to a property they had asked to read. And it
  // answered on the root client alone, so the one flavor an application
  // actually holds — junction scopes `ctx.locals.db` with $setAuth — threw the
  // unknown-property error instead of answering a question about the schema.
  function softDeleteInfo() {
    return { ...softDeleteMap }
  }

  // ─── $commitments ───────────────────────────────────────────────────────
  //
  // Every declared `@@commitment`, one row each: the model, its accessor, and
  // the transition it owes. What a sweep walks — it asks `due()` of each
  // accessor it names — so the sweep derives its set from the schema rather
  // than from a list an app keeps beside it. A fresh array per read and on
  // every flavor, for the reason `$softDelete` gives.
  function commitmentsInfo() {
    return Object.entries(commitmentMap).flatMap(([model, decls]) =>
      (decls ?? []).map(d => ({ model, accessor: modelToAccessor(model), transition: d.name })))
  }

  // ─── $audit ─────────────────────────────────────────────────────────────
  //
  // $audit({ operation, model, records, actorId, meta }) → the written row
  //
  // Record something the audit trail cannot see for itself. `@@log(audit)` is a
  // side effect of a write, so it covers exactly the events that ARE writes —
  // and the ones an app most wants are not. A failed login performs no write, so
  // it left no trace at all; a successful one left `create:session` with
  // `actorId: null`, because the write goes through asSystem() and a system
  // context has no principal to name (`FJS-276`, `FJS-277`).
  //
  // THE ONE OWNER of "put a row in the audit trail". A caller can reach the log
  // model directly — it is an ordinary accessor — and two writers with no shared
  // definition is how a second `operation` vocabulary starts drifting from the
  // first. Everything that records goes through here.
  //
  // It THROWS, where @@log(audit) is fire-and-forget, and that difference is the
  // point: there, logging is a side effect of a write that already succeeded and
  // must not fail it. Here, the record IS what the caller asked for — swallowing
  // the failure would mean a security event silently unrecorded.
  //
  // `meta` is yours and is written as given: nothing redacts it, so do not put a
  // password, a token or a key in it. Field-level redaction protects columns the
  // SCHEMA declared protected, and this has no schema behind it.

  const AUDIT_KEYS = ['operation', 'model', 'field', 'records', 'before', 'after', 'actorId', 'actorType', 'meta']

  async function auditWith(principal, entry, opts = {}) {
    if (typeof entry?.operation !== 'string' || !entry.operation)
      throw new Error(`$audit: 'operation' is required — the name of what happened, e.g. 'login.failed'.`)

    // Refused by name rather than dropped: a misspelled key is a caller that
    // meant to record something, and a silently thinner row is worse than none.
    for (const key of Object.keys(entry))
      if (!AUDIT_KEYS.includes(key))
        throw new Error(
          `$audit: unknown key '${key}'. Anything of your own belongs in 'meta'. ` +
          `Known keys: ${AUDIT_KEYS.join(', ')}.`)

    const loggers = Object.keys(ctx.loggerDbMap ?? {})
    const dbName  = opts.database ?? loggers[0]

    if (!dbName)
      throw new Error(`$audit: no database in this schema declares 'driver logger', so there is nowhere to write.`)
    if (!loggers.includes(dbName))
      throw new Error(`$audit: '${dbName}' is not a logger database. Declared: ${loggers.join(', ') || 'none'}.`)

    const table = jsonlTableCache[ctx.loggerDbMap[dbName].logModel ?? `${dbName}Logs`]
    if (!table) throw new Error(`$audit: the log table for '${dbName}' is not available.`)

    const built = buildLogEntry(entry, { ...ctx, auth: principal ?? ctx.auth }, ctx.onLog)

    // A STATED value wins over onLog's. onLog is a generic enricher that runs
    // over every entry; a $audit caller is naming this one event and knows more
    // about it than the enricher does. Same rule as sessionFields.
    if (entry.actorId   != null) built.actorId   = entry.actorId
    if (entry.actorType != null) built.actorType = entry.actorType
    if (entry.meta      != null) built.meta      = JSON.stringify(entry.meta)

    // An explicit event lines up with an @@anonymous row by clock exactly as a
    // @@log entry does, and the trail is not rolled back with the transaction.
    if (tx.owns()) {
      const other = tx.noteWrite('$audit', false)
      if (other) throw new Error(
        `$audit: refused '${entry.operation}' in a transaction that also wrote ${other}. ${other} is @@anonymous, ` +
        `and an audit event beside it re-attributes the row by the trail's clock. Record the event without naming ` +
        `the respondent, or not at all (FJS-D349)`)
    }

    return await table.create({ data: built })
  }

  // $transaction — wraps async callback in BEGIN IMMEDIATE / COMMIT
  //
  // `asProxy` is which flavor of client the callback is handed, and it is not
  // a detail: every scoped proxy (asSystem, $setAuth, $scopedBy) exposed THIS
  // function directly, so the callback received the ROOT client and the scope
  // was dropped for the whole transaction — silently, in both directions.
  // `db.asSystem().$transaction(tx => tx.account.create(…))` ran as an
  // anonymous caller and was refused by the model's own @@gate; the mirror
  // image, `db.$setAuth(u).$transaction(…)`, ran with `auth()` null, so every
  // @@allow matched nothing and every @createdBy stamped nobody. Both look like
  // the transaction body is wrong. Each proxy now passes itself.
  //
  // A CONCURRENT caller waits; a genuinely nested one takes a SAVEPOINT as it
  // always did. Both used to nest, which meant a second request's writes rode
  // the first request's rollback (`FJS-237`) — see makeTxManager.
  let clientProxy
  async function $transaction(fn, asProxy) {
    return tx.exclusive(() => fn(asProxy ?? clientProxy))
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

  // Statements that are unambiguously reads. Everything else — including WITH,
  // because `WITH x AS (…) DELETE FROM …` is legal SQLite — goes to the write
  // connection, which reads perfectly well. Getting this wrong in the other
  // direction is the expensive one: the read connection is opened `readonly`
  // with `query_only = ON`, so a write sent there fails with SQLITE_READONLY,
  // "attempt to write a readonly database" — a message about the connection
  // that names nothing the caller wrote.
  const _RAW_READ = /^(SELECT|EXPLAIN|VALUES)\b/i

  /** The one raw runner. There were three byte-identical copies of this.
   *  `runCtx` is the calling flavor's, so the event says who ran it. */
  function _runRawSql(strings, values, runCtx = ctx) {
    let query = ''
    for (let i = 0; i < strings.length; i++) {
      query += strings[i]
      if (i < values.length) query += '?'
    }
    query = query.trim()
    // Leading comments are stripped before the test, so `-- why\nDELETE …`
    // still routes as a write rather than as an unrecognized statement.
    const head = query.replace(/^(?:\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, '')
    const conn = _RAW_READ.test(head) ? readDb : writeDb
    if (!queryTapped(runCtx)) return conn.query(query).all(...values)
    const t0 = performance.now()
    const rows = conn.query(query).all(...values)
    emitQuery(runCtx, null, 'main', { operation: 'sql', args: null, sql: query, params: values, duration: performance.now() - t0, rowCount: rows.length })
    return rows
  }

  async function sql(strings, ...values) {
    if (_hasAccessRules) throw rawSqlRefusal('db.sql')
    return _runRawSql(strings, values)
  }


  // ── $rotateKey ─────────────────────────────────────────────────────────────
  // Re-encrypts every key-reversible column using the current key → newKey and
  // then swaps the client's key. One write transaction per affected database.
  //
  // Usage:
  //   const stats = await db.$rotateKey(process.env.NEW_ENCRYPTION_KEY)
  //   // → { users: { rows: 42, fields: 1 }, payments: { rows: 7, fields: 2 } }
  //
  // ── What it carries, and what it refuses to leave behind ───────────────────
  //
  // The key swap at the end is GLOBAL — one client holds one key — so a column
  // this does not rewrite is not "left on the old key", it is UNREADABLE. That
  // was the shape of FJS-253: rotation visited `@secret(rotate: true)` only, and
  // a plain `@encrypted` column beside it read `null` afterwards with nothing
  // thrown at any layer. Every key-reversible column is rotated now.
  //
  // Two kinds cannot be carried, and rotation REFUSES while either is present
  // rather than destroying it:
  //
  //   @hashed                 one-way. There is no plaintext anywhere to re-key,
  //                           so every match silently becomes 0 and no later fix
  //                           can undo it.
  //   @secret(rotate: false)  excluded from re-encryption by declaration.
  //
  // `{ orphan: ['Model.field'] }` is the deliberate opt-in. It is a list of names
  // rather than a boolean so that acknowledging one column cannot silently
  // acknowledge a second one added later.

  // The one answer to "can a key rotation carry this column?", asked by the
  // refusal and by the rotation loop so the two cannot disagree about which
  // columns exist. Every encrypted column is in `fieldPolicyMap` — `@secret`
  // expands to `@encrypted` at parse time — and `secretMap` only says which of
  // them opted out.
  function classifyForRotation() {
    const carry    = {}
    const orphaned = []

    for (const [modelName, fields] of Object.entries(fieldPolicyMap)) {
      for (const [fieldName, policy] of Object.entries(fields)) {
        const key = `${modelName}.${fieldName}`

        if (policy.hashed) {
          orphaned.push({ key, reason: '@hashed — one-way, there is no plaintext to re-key, so every match becomes 0 permanently' })
          continue
        }
        if (!policy.encrypted) continue

        if (secretMap[modelName]?.[fieldName]?.rotate === false) {
          orphaned.push({ key, reason: '@secret(rotate: false) — declared excluded from re-encryption' })
          continue
        }

        ;(carry[modelName] ??= []).push(fieldName)
      }
    }

    return { carry, orphaned }
  }

  async function $rotateKey(rawNewKey, { orphan = [] } = {}) {
    const { carry, orphaned } = classifyForRotation()

    // Nothing encrypted anywhere — no rotation, and no key required to say so.
    if (!Object.keys(carry).length && !orphaned.length) return {}

    // Refuse BEFORE the first write. A rotation that has already rewritten half
    // the database and then complains is a database in two keys with nothing
    // recording which rows are in which.
    const acknowledged = new Set(orphan)
    const unacked      = orphaned.filter(o => !acknowledged.has(o.key))
    if (unacked.length) {
      throw new Error(
        `$rotateKey would leave ${unacked.length} column(s) unreadable and has rotated nothing:\n` +
        unacked.map(o => `  ${o.key} — ${o.reason}`).join('\n') +
        `\nThe key swap is global, so a column this cannot re-encrypt is not carried forward.\n` +
        `This client keeps reading it — the old key stays on its ring — but the next process to\n` +
        `start does not, unless it is given previousEncryptionKeys: ['<the old key>'].\n` +
        `Pass { orphan: [${unacked.map(o => `'${o.key}'`).join(', ')}] } to accept that deliberately.`
      )
    }

    if (!ctx.enc.key)
      throw new Error('$rotateKey requires an encryption key on this client — pass { encryptionKey: process.env.ENCRYPTION_KEY } to createClient()')

    const newKey = normalizeKey(rawNewKey)
    if (!newKey || newKey.length !== 32)
      throw new Error('New encryption key must be 32 bytes (64 hex chars)')

    const results = {}

    // Group rotatable fields by their target database so each DB gets one transaction
    const byDb = {}
    for (const [modelName, rotatableFields] of Object.entries(carry)) {
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
                const plain = decryptField(row[fieldName], ctx.enc.ring ?? ctx.enc.key)
                sets.push(`"${fieldName}" = ?`)
                // Re-encrypt in the mode the field was DECLARED with, not the mode
                // rotation happens to use. Rewriting a deterministic column with a
                // random IV would leave every value readable and every equality
                // filter over it answering nothing, silently, until someone searched.
                const mode = fieldPolicyMap?.[modelName]?.[fieldName]
                vals.push(mode?.encrypted?.deterministic
                  ? encryptDeterministic(plain, newKey)
                  : encryptField(plain, newKey))
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

    // One assignment reaches every client derived from this one, including the
    // memoized asSystem() proxy built before the rotation. That is the whole
    // reason the key lives in a cell.
    //
    // The OLD key stays on the ring, and that is what makes a partial rotation
    // survivable rather than a loss (`FJS-714`). The loop above is one
    // transaction per DATABASE, so a crash between two commits leaves database
    // A on the new key and B on the old — which used to be undetectable and
    // unreadable, with a single global key setting and no way to say which
    // value was under which. Now every value names its key, both keys are held,
    // and running the rotation again finishes it: a row already on the new kid
    // decrypts, re-encrypts to the same kid, and costs a write rather than a
    // wrong answer.
    if (Object.keys(results).length > 0) {
      const previous = ctx.enc.ring?.all ?? (ctx.enc.key ? [ctx.enc.key] : [])
      ctx.enc.key  = newKey
      ctx.enc.ring = makeKeyring(newKey, previous.filter(k => !k.equals(newKey)))
    }

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

  // `only` narrows to named databases. Without it a caller wanting ONE database
  // out of several had to open a client per database — and `createClient({ db })`
  // names MAIN, so each of those clients backed up main under a different
  // database's name. Asking here is the only way to ask truthfully.
  async function $backup(destPath, { vacuum = false, only = null } = {}) {
    const abs   = resolve(destPath)
    const names = only == null ? null : (Array.isArray(only) ? only : [only])

    // SQLite-only — backs up all open SQLite connections.
    // For a full backup including JSONL/logger databases, use: litestone backup
    const sqliteDbs = Object.entries(dbRegistry)
      .filter(([name, conn]) => conn.driver === 'sqlite' && conn.rawWriteDb && (!names || names.includes(name)))

    if (!sqliteDbs.length) {
      const declared = Object.entries(dbRegistry).filter(([, c]) => c.driver === 'sqlite').map(([n]) => n)
      throw new Error(
        names
          ? `$backup: no SQLite database named ${names.join(', ')}. Declared: ${declared.join(', ') || 'none'}`
          : `$backup: this client has no SQLite database to back up`
      )
    }

    const backupOne = (db, dest) => backupSqliteTo(db, dest, { vacuum })

    if (sqliteDbs.length > 1) {
      mkdirSync(abs, { recursive: true })
      const results = {}
      for (const [name, conn] of sqliteDbs) {
        const dest = resolve(abs, `${name}.db`)
        results[name] = { driver: 'sqlite', path: dest, size: await backupOne(conn.rawWriteDb, dest), vacuumed: vacuum }
      }
      return results
    }

    // sqliteDbs[0], not the closure's rawWriteDb — with `only` they differ, and
    // the closure's is always main.
    const size = await backupOne(sqliteDbs[0][1].rawWriteDb, abs)
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
  // Memoized PER SCOPE, keyed by the context it was reached from, so
  // `db.asSystem()` and `db.$setAuth(u).asSystem()` are different proxies and
  // the second one keeps `u`. It used to be one root-level memo handed out by
  // every scoped client, which discarded the principal — so the composition
  // this file documented for audit logging did not work, and a tenant claim
  // could not survive into a system read at all (FJS-519).
  //
  // Identity-free is still the DEFAULT and is still correct: `db.asSystem()`
  // has no principal, which is what a migration, a seed and a job with no
  // caller are.
  const _systemProxies = new WeakMap()
  function makeSystemProxy(baseCtx) {
    const hit = _systemProxies.get(baseCtx)
    if (hit) return hit
    const sysCtx = { ...baseCtx, isSystem: true }
    // The flavor carries `baseCtx`'s principal: `db.$setAuth(u).asSystem()` is
    // the bypass WITH an actor, which is what an audit entry is written from.
    const sysFlavor = { auth: baseCtx.auth ?? null, isSystem: true, scopedBy: baseCtx.scopedBy, tables: null }
    const rawSysTables = makeAllFlavorTables(sysFlavor)
    sysFlavor.tables = rawSysTables
    sysCtx.tables = rawSysTables
    // Apply scopes — system ctx is fixed for the lifetime of asSystem(), so the
    // ctxResolver returns sysCtx directly.
    const sysTables = installScopes(rawSysTables, () => sysCtx)
    // No guard: asSystem() IS the documented bypass, and refusing here would
    // leave no way to run a raw statement at all.
    async function sysSql(strings, ...values) {
      return _runRawSql(strings, values, sysCtx)
    }

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

    const sysOwnProps = ['asSystem', '$close', '$schema', '$checkWhere', '$checkOrderBy', '$protectedFields', '$primaryKey', '$capabilitiesFor', '$claimsFor', '$readAs', '$readGrading', '$inWindow', '$now', '$levelOf', '$softDelete', '$commitments', '$scopes', '$audit', '$enums', '$plugins', '$tenancy', '$retain']
    const proxy = _systemProxies.get(baseCtx) ?? new Proxy({ sql: sysSql, query: sysQuery, $transaction: (fn) => $transaction(fn, proxy), $backup, $walStatus, $rotateKey, $attach, $detach, $db: rawWriteDb, $lock: lockPrimitive, $locks: lockPrimitive.$locks }, {
      get(target, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'then' || prop === 'catch' || prop === 'finally' || prop === 'toJSON') return undefined
        if (prop in target)     return Reflect.get(target, prop)
        if (prop in sysTables)  return sysTables[prop]
        // Idempotent, and it has to be: a caller handed a client cannot tell
        // which flavor it is, so `db.asSystem()` at the top of a function is
        // the normal defensive spelling. Without this it threw
        // `"asSystem" is not a table in this schema` — a message about tables,
        // about a method every other flavor of this client has.
        if (prop === 'asSystem') return () => proxy
        if (prop === '$close')  return () => _closeAll()
        if (prop === '$inTransaction') return txState.depth > 0
        if (prop === '$schema') return schema
        if (prop === '$retain')     return $retain
        if (prop === '$checkWhere') return $checkWhere
        if (prop === '$protectedFields') return $protectedFields
        if (prop === '$primaryKey') return $primaryKey
      if (prop === '$capabilitiesFor') return $capabilitiesFor
      if (prop === '$claimsFor')       return $claimsFor
      if (prop === '$readAs')          return $readAs
      if (prop === '$levelOf')         return $levelOfAs(sysCtx)
      if (prop === '$inWindow')        return $inWindow
      if (prop === '$now')             return nowDate
      if (prop === '$readGrading')     return $readGrading
        if (prop === '$softDelete') return softDeleteInfo()
        if (prop === '$commitments') return commitmentsInfo()
        if (prop === '$scopes') return $scopes
        if (prop === '$checkOrderBy') return $checkOrderBy
        // A system context names no principal, so an actor has to be STATED —
        // which is the whole reason a system write's audit row read null.
        if (prop === '$audit')  return (entry, opts) => auditWith(null, entry, opts)
        if (prop === '$enums')  return Object.fromEntries(schema.enums.map(e => [e.name, [...e.values.map(v => v.name)]]))
        if (prop === '$plugins') return pluginRunner.names
        if (prop === '$tenancy') return tenancyInfo()
        throw new Error(`"${prop}" is not a table in this schema.`)
      },
      // This proxy had a `get` trap and nothing else, which made it lie rather
      // than throw: `'user' in db.asSystem()` was FALSE while
      // `db.asSystem().user` worked, and enumeration listed no tables at all.
      // Same family as `FJS-014` and the quieter half of it — a guard reading
      // `if ('user' in db)` silently skipped the table under a system client.
      ownKeys(target) {
        return dedupeKeys(
          Reflect.ownKeys(target),
          Object.keys(sysTables),
          sysOwnProps,
        )
      },
      has(target, prop) { return sysOwnProps.includes(prop) || prop in target || prop in sysTables },
      getOwnPropertyDescriptor(target, prop) {
        if (prop in sysTables || prop === 'asSystem')
          return { configurable: true, enumerable: true, writable: false }
        return Reflect.getOwnPropertyDescriptor(target, prop)
      },
    })
    _systemProxies.set(baseCtx, proxy)
    return proxy
  }

  function asSystem() { return makeSystemProxy(ctx) }

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
    const authFlavor = { auth: user, isSystem: false, scopedBy: ctx.scopedBy, tables: null }
    const rawAuthTables = makeLazyTables(authFlavor)
    authFlavor.tables = rawAuthTables
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

    // This scope's own system proxy, not the root's. It keeps `user`, which is
    // what carries a tenant claim across the bypass and what an audit actor is
    // read from.
    const authAsSystem = () => makeSystemProxy(authCtx)

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

    const authOwnProps = ['$close', '$schema', '$auth', '$checkWhere', '$checkOrderBy', '$protectedFields', '$primaryKey', '$capabilitiesFor', '$claimsFor', '$readAs', '$readGrading', '$inWindow', '$now', '$levelOf', '$softDelete', '$commitments', '$audit', '$cacheSize', '$enums', '$plugins', '$tenancy', '$retain']
    const authProxy = new Proxy({ sql: authSql, query: authQuery, $transaction: (fn) => $transaction(fn, _authProxyRef), $backup, $walStatus, $rotateKey, $attach, $detach, $db: rawWriteDb, $lock: lockPrimitive, $locks: lockPrimitive.$locks, asSystem: authAsSystem, $setAuth, $scopedBy: (b) => _makeScopedProxy({ scopedBy: b, auth: user }) }, {
      get(target, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'then' || prop === 'catch' || prop === 'finally' || prop === 'toJSON') return undefined
        if (prop in target)             return Reflect.get(target, prop)
        if (prop === '$setAuth')        return $setAuth
        if (prop === 'asSystem')        return authAsSystem
        if (prop in authTables)         return authTables[prop]
        if (prop === '$close')          return () => _closeAll()
        if (prop === '$inTransaction')  return txState.depth > 0
        if (prop === '$schema')         return schema
        if (prop === '$auth')           return user
        if (prop === '$retain')         return retainRefusal
        if (prop === '$checkWhere')     return $checkWhere
        if (prop === '$protectedFields') return $protectedFields
        if (prop === '$primaryKey') return $primaryKey
      if (prop === '$capabilitiesFor') return $capabilitiesFor
      if (prop === '$claimsFor')       return $claimsFor
      if (prop === '$readAs')          return $readAs
      if (prop === '$levelOf')         return $levelOfAs(authCtx)
      if (prop === '$inWindow')        return $inWindow
      if (prop === '$now')             return nowDate
      if (prop === '$readGrading')     return $readGrading
        if (prop === '$softDelete')     return softDeleteInfo()
        if (prop === '$commitments')    return commitmentsInfo()
        if (prop === '$scopes')         return $scopes
        if (prop === '$checkOrderBy')   return $checkOrderBy
        if (prop === '$audit')          return (entry, opts) => auditWith(user, entry, opts)
        if (prop === '$cacheSize')      return _cacheSize()
        if (prop === '$enums')          return Object.fromEntries(schema.enums.map(e => [e.name, [...e.values.map(v => v.name)]]))
        if (prop === '$plugins')        return pluginRunner.names
        if (prop === '$tenancy')        return tenancyInfo()
        throw new Error(`"${prop}" is not a table in this schema. Tables: ${Object.keys(authTables).join(', ')}`)
      },
      ownKeys(target) {
        return dedupeKeys(
          Reflect.ownKeys(target),
          Object.keys(authTables),
          authOwnProps,
        )
      },
      has(target, prop) { return authOwnProps.includes(prop) || prop in target || prop in authTables },
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
    const scopedFlavor = {
      auth:      overrides.auth ?? ctx.auth ?? null,
      isSystem:  overrides.isSystem ?? false,
      scopedBy:  overrides.scopedBy,
      tables:    null,
    }
    const rawTables = makeLazyTables(scopedFlavor)
    scopedFlavor.tables = rawTables
    sCtx.tables = rawTables
    const tables = installScopesLazy(rawTables, () => sCtx)
    const scopedOwnProps = ['$close', '$schema', '$scope', '$auth', '$checkWhere', '$checkOrderBy', '$protectedFields', '$primaryKey', '$capabilitiesFor', '$claimsFor', '$readAs', '$readGrading', '$inWindow', '$now', '$levelOf', '$softDelete', '$commitments', '$scopes', '$audit', '$enums', '$plugins', '$tenancy', '$retain']
    const target = {
      $scopedBy: (b) => _makeScopedProxy({ ...overrides, scopedBy: { ...(overrides.scopedBy ?? {}), ...(b ?? {}) } }),
      $setAuth:  (u) => _makeScopedProxy({ ...overrides, auth: u }),
      // Hands the callback THIS proxy — the dimension bindings and the auth on
      // it are what the body was asking for. See $transaction.
      $transaction: (fn) => $transaction(fn, scopedProxy),
      asSystem, $backup, $walStatus, $rotateKey, $attach, $detach, $db: rawWriteDb,
      $lock: lockPrimitive, $locks: lockPrimitive.$locks,
    }
    const scopedProxy = new Proxy(target, {
      get(t, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'then' || prop === 'catch' || prop === 'finally' || prop === 'toJSON') return undefined
        if (prop in t)          return Reflect.get(t, prop)
        if (prop in tables)     return tables[prop]
        if (prop === '$close')  return () => _closeAll()
        if (prop === '$inTransaction') return txState.depth > 0
        if (prop === '$schema') return schema
        if (prop === '$scope')  return overrides.scopedBy ?? {}
        if (prop === '$auth')   return overrides.auth ?? null
        if (prop === '$retain')     return retainRefusal
        if (prop === '$checkWhere') return $checkWhere
        if (prop === '$protectedFields') return $protectedFields
        if (prop === '$primaryKey') return $primaryKey
      if (prop === '$capabilitiesFor') return $capabilitiesFor
      if (prop === '$claimsFor')       return $claimsFor
      if (prop === '$readAs')          return $readAs
      if (prop === '$levelOf')         return $levelOfAs(sCtx)
      if (prop === '$inWindow')        return $inWindow
      if (prop === '$now')             return nowDate
      if (prop === '$readGrading')     return $readGrading
        if (prop === '$softDelete') return softDeleteInfo()
        if (prop === '$commitments') return commitmentsInfo()
        if (prop === '$scopes') return $scopes
        if (prop === '$checkOrderBy') return $checkOrderBy
        if (prop === '$audit')  return (entry, opts) => auditWith(overrides.auth ?? null, entry, opts)
        if (prop === '$enums')  return Object.fromEntries(schema.enums.map(e => [e.name, [...e.values.map(v => v.name)]]))
        if (prop === '$plugins') return pluginRunner.names
        if (prop === '$tenancy') return tenancyInfo()
        throw new Error(`"${prop}" is not a table in this schema. Tables: ${Object.keys(tables).join(', ')}`)
      },
      ownKeys(t)   { return dedupeKeys(Reflect.ownKeys(t), Object.keys(tables), scopedOwnProps) },
      has(t, prop) { return scopedOwnProps.includes(prop) || prop in t || prop in tables },
    })
    return scopedProxy
  }
  function $scopedBy(bindings) {
    return _makeScopedProxy({ scopedBy: { ...(ctx.scopedBy ?? {}), ...(bindings ?? {}) }, auth: ctx.auth })
  }

  // Close all database connections in the registry + jsonl index dbs
  // ── Reading another process's announcements ───────────────────────────────
  //
  // Every row another process recorded is turned back into the event a local
  // write would have fired and handed to the SAME `$tapEvents` set — so
  // Junction's `announceDataWrites`, and everything above it, needs no change
  // and cannot tell the two apart. That is the whole design: one seam.
  //
  // The row carries an id, so the row itself is re-read HERE through this
  // process's own system client. It costs one read per event and buys three
  // things: no plaintext of an @encrypted column in the table, a row shaped by
  // this process's own read path (plugin hooks, a resolved File reference —
  // `FJS-541`), and a removal that carries what it can rather than a stale copy.
  let foreignChain = Promise.resolve()

  function startCrossProcessWatch() {
    const cp = ctx._crossProcess
    if (!cp) return
    // Grouped by CONNECTION, not by name: two `database` blocks can resolve to
    // one file — a tenant's file holds every sqlite database of the schema — in
    // which case they share a handle and therefore one events table. A watcher
    // per name would read that table twice and deliver every foreign event
    // twice. Keyed by the handle rather than the path because two ':memory:'
    // databases share a path string and are not one database.
    const groups = new Map()
    for (const [name, conn] of Object.entries(cp.dbs)) {
      const g = groups.get(conn.rawWriteDb) ?? { conn, names: [] }
      g.names.push(name)
      groups.set(conn.rawWriteDb, g)
    }
    for (const { conn, names } of groups.values()) {
      const name = names[0]
      if (cp.watchers[name]) continue
      const modelsHere = Object.keys(ctx.models)
        .filter(m => names.includes(ctx.modelDbMap?.[m] ?? 'main'))
      cp.watchers[name] = createEventWatcher({
        db:     conn.rawWriteDb,
        file:   conn.absPath,
        origin: cp.origin,
        now:    nowDate,
        // Serialized, in arrival order. Each delivery re-reads its row, so
        // firing them off in parallel lets a later event's read finish first
        // and a subscriber sees a create after the remove that undid it —
        // measured, and the order is the one thing a live store cannot repair.
        onEvent: (e) => { foreignChain = foreignChain.then(() => deliverForeignEvent(e)).catch(() => {}) },
        // Retention took the rows this subscriber had not read, so what changed
        // cannot be said — only that something did. One `changed` per model in
        // the database, which is the coarse signal every other path avoids and
        // the honest answer when the detail is gone.
        onGap: () => {
          for (const model of modelsHere) dispatchForeign('changed', {
            model, operation: 'changed', result: null, scope: 'collection', count: null,
            schema: ctx.models[model],
          })
        },
      })
    }
  }

  function stopCrossProcessWatch() {
    const cp = ctx._crossProcess
    if (!cp) return
    for (const [name, w] of Object.entries(cp.watchers)) { w.stop(); delete cp.watchers[name] }
  }

  function dispatchForeign(event, eventCtx) {
    const e = { event, ...eventCtx, foreign: true }
    for (const fn of ctx._eventListeners) {
      try { const r = fn(e, ctx); if (r?.catch) r.catch(() => {}) }
      catch (err) { console.warn(`litestone event tap error (${event}, from another process):`, err) }
    }
  }

  async function deliverForeignEvent(e) {
    const sys   = asSystem()
    const table = ctx.models[e.model] ? sys[e.model.charAt(0).toLowerCase() + e.model.slice(1)] : null
    let result = null
    // A removal has nothing to read back, and a collection-scoped event never
    // had a row. Everything else is re-read, and a row that has since gone is
    // announced as what it is rather than guessed at.
    if (table && e.scope === 'row' && e.event !== 'remove' && e.recordId != null) {
      try { result = await table.findFirst({ where: { [idFieldOf(e.model)]: coerceId(e.model, e.recordId) } }) }
      catch { result = null }
    }
    dispatchForeign(e.event, {
      model:  e.model,
      operation: e.event,
      scope:  e.scope,
      count:  e.count,
      ...(e.event === 'transition' ? { ...e.detail, record: result } : { result }),
      ...(e.scope === 'row' ? { recordId: e.recordId } : {}),
      schema: ctx.models[e.model],
    })
  }

  function idFieldOf(model) {
    return ctx.models[model]?.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
  }

  // The table stores the id as TEXT, because one column has to hold every id
  // kind an app declares. An Int key compared against its own string is a miss
  // that reads as *the row is gone*, so the schema decides the type back.
  function coerceId(model, raw) {
    const f = ctx.models[model]?.fields.find(x => x.name === idFieldOf(model))
    // `type` is `{ kind, name, array, optional }`, not a string — comparing it
    // against 'Int' is always false, which leaves an Int key compared against
    // its own decimal string and reads as *the row is gone*.
    const t = f?.type?.name ?? f?.type
    // A `@big` key is the exception and stays text: `Number()` on it is the
    // rounding the attribute exists to prevent, and a filter carrying the
    // rounded value finds a different row or none. A digit string filters an
    // INTEGER column exactly — SQLite applies the column's affinity to the
    // parameter, which is measured and is also what makes the write path work.
    if (f?.attributes?.some(a => a.kind === 'big')) return raw
    return (t === 'Int' || t === 'BigInt' || t === 'Float') ? Number(raw) : raw
  }

  function _closeAll() {
    stopCrossProcessWatch()
    for (const a of _attached) {
      try { rawWriteDb.prepare(`DETACH DATABASE "${a}"`).run() } catch {}
    }
    // Checkpoint WAL on each SQLite write connection before closing.
    // Prevents large WAL files being left behind and speeds up next open.
    //
    // The wrapper's close() comes FIRST and does two things a raw close cannot:
    // it finalizes the cached statements, without which bun's deferred close
    // frees nothing, and it arms the throw — so a caller still holding this
    // client is told so by name rather than being served off a closed handle
    // for whichever queries happen to be cached (`FJS-640`).
    //
    // Two names can share one file and therefore one pair of raw handles, so
    // the checkpoint and the close are asked once per HANDLE. The wrappers are
    // not deduped: each name has its own, and each has to arm its own throw.
    const closedRaw = new Set()
    for (const conn of Object.values(dbRegistry)) {
      try { conn.writeDb?.close?.() } catch {}
      try { conn.readDb?.close?.()  } catch {}
      for (const raw of [conn.rawWriteDb, conn.rawReadDb]) {
        if (!raw || closedRaw.has(raw)) continue
        closedRaw.add(raw)
        if (raw === conn.rawWriteDb) {
          try { raw.run('PRAGMA wal_checkpoint(TRUNCATE)') } catch {}
        }
        try { raw.close() } catch {}
      }
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

  const rootOwnProps = ['$close', '$attached', '$schema', '$relations', '$checkWhere', '$checkOrderBy', '$protectedFields', '$primaryKey', '$capabilitiesFor', '$claimsFor', '$readAs', '$readGrading', '$inWindow', '$now', '$levelOf', '$scopes', '$audit', '$softDelete', '$commitments', '$cacheSize', '$config', '$databases', '$rawDbs', '$tapQuery', '$tapEvents', '$logContext', '$madeAt', '$logStats', '$enums', '$plugins', '$tenancy', '$setAuth', '$scopedBy', '$lock', '$locks', '$db', '$retain', '$inTransaction']
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
      // Is a transaction open on this connection RIGHT NOW?
      //
      // For a caller whose correctness depends on being inside one — a write
      // that is only meaningful if it rolls back with everything else, such as
      // an outbox row recording an effect to deliver. That caller cannot ask
      // the service declaration instead: `transactional:` is a statement about
      // a method, and a hook can run against a method it does not name.
      //
      // A fact about this connection, so it is the same answer on every
      // flavor — a scoped client and the system bypass share one write
      // connection and one depth counter.
      if (prop === '$inTransaction')  return txState.depth > 0
      if (prop === '$attached')       return $attachedDatabases()
      if (prop === '$schema')         return schema
      if (prop === '$relations')      return relationMap
      if (prop === '$retain')     return retainRefusal
      if (prop === '$checkWhere')     return $checkWhere
      if (prop === '$protectedFields') return $protectedFields
      if (prop === '$primaryKey')      return $primaryKey
      if (prop === '$capabilitiesFor') return $capabilitiesFor
      if (prop === '$claimsFor')       return $claimsFor
      if (prop === '$readAs')          return $readAs
      if (prop === '$levelOf')         return $levelOfAs(ctx)
      if (prop === '$inWindow')        return $inWindow
      if (prop === '$now')             return nowDate
      if (prop === '$readGrading')     return $readGrading
      if (prop === '$scopes')         return $scopes
      if (prop === '$checkOrderBy')   return $checkOrderBy
      if (prop === '$audit')          return (entry, opts) => auditWith(ctx.auth ?? null, entry, opts)
      if (prop === '$softDelete')     return softDeleteInfo()
      if (prop === '$commitments')    return commitmentsInfo()
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
      // Subscribe to write events AFTER construction — the half `onEvent` does
      // not have. `onEvent` is fixed at createClient, so a layer handed a
      // finished client (Junction, which announces a mutation) had no way in.
      if (prop === '$tapEvents')      return (fn) => {
        ctx._eventListeners.add(fn)
        // The reader costs a watch and a timer, so it exists only while
        // somebody here is listening — the write side is unconditional because
        // its audience is in another process, and this side's audience is the
        // set this line just joined.
        startCrossProcessWatch()
        return () => {
          ctx._eventListeners.delete(fn)
          if (!ctx._eventListeners.size) stopCrossProcessWatch()
        }
      }
      // ─── $logContext ───────────────────────────────────────────────────
      // WHERE a write came from, for the audit trail: a function answering
      // { correlationId, source, origin, ip, userAgent, tenant } or nothing.
      //
      // A function rather than a value, called when an entry is built rather
      // than read once — the answer changes per request and a client is built
      // once. Same shape as `now`, for the same reason.
      //
      // Installed rather than declared because the caller that HAS a request is
      // the API realm, which sits above this package (Invariant 1): junction
      // hands down a closure over its own request store, and litestone never
      // learns that a request exists. An app with no junction sets it itself or
      // leaves the columns null.
      //
      // Root only. It is one app-wide install at boot, not a per-caller
      // capability — a scoped client refuses the name like any other unknown
      // property, which is a loud failure rather than a silent no-op.
      // ─── $logStats ─────────────────────────────────────────────────────
      // Is the audit trail still being written? A copy, because a live handle
      // would let a caller reset counters that are evidence.
      if (prop === '$logStats')       return () => ({ ...ctx._logStats })
      if (prop === '$logContext')     return (fn) => {
        if (fn != null && typeof fn !== 'function')
          throw new Error(`$logContext(fn): expected a function answering the request's provenance, got ${typeof fn}.`)
        const previous = ctx._logContext.fn
        ctx._logContext.fn = fn ?? null
        return () => { ctx._logContext.fn = previous }
      }
      // ─── $madeAt ───────────────────────────────────────────────────────
      // WHEN the write in progress was made, where that is not now: a function
      // answering an instant or nothing, read by `@default(now())` and
      // `@updatedAt` in place of the clock. Installed by the realm that has a
      // request, for `$logContext`'s reason (Invariant 1). The audit trail keeps
      // the landing time, since what an audit records is when it happened HERE.
      if (prop === '$madeAt')         return (fn) => {
        if (fn != null && typeof fn !== 'function')
          throw new Error(`$madeAt(fn): expected a function answering when the write in progress was made, got ${typeof fn}.`)
        const previous = ctx._madeAt.fn
        ctx._madeAt.fn = fn ?? null
        return () => { ctx._madeAt.fn = previous }
      }
      if (prop === '$lock')           return lockPrimitive
      if (prop === '$locks')          return lockPrimitive.$locks
      if (prop === '$enums')          return Object.fromEntries(schema.enums.map(e => [e.name, [...e.values.map(v => v.name)]]))
      if (prop === '$plugins')        return pluginRunner.names
      if (prop === '$tenancy')        return tenancyInfo()
      throw new Error(`"${prop}" is not a table in this schema. Tables: ${Object.keys(scopedTables).join(', ')}`)
    },
    ownKeys(target) {
      const viewNames = (schema.views ?? []).map(v => modelToAccessor(v.name))
      return dedupeKeys(
        Reflect.ownKeys(target),
        Object.keys(scopedTables),
        viewNames,
        rootOwnProps,
      )
    },
    has(target, prop) {
      return rootOwnProps.includes(prop) || prop in target || prop in scopedTables
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop in scopedTables) return { configurable: true, enumerable: true, writable: false }
      return Reflect.getOwnPropertyDescriptor(target, prop)
    },
  })

  return clientProxy
}
