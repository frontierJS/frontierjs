// client.js — Litestone query client
//
// Key design decisions:
//   Dual connections:  readDb (readonly) + writeDb — WAL mode allows concurrent reads
//   Soft delete:       models with deletedAt field get auto-filtering + soft ops
//   Statement cache:   compiled statements reused across calls via wrapDb()

import { currentEngine } from './engine.js'
import { validateBusyTimeout } from './pragmas.js'
import { resolve, join, dirname, mkdirSync, rmSync, AsyncLocalStorage, processId } from '#host'
import { resolveAnchor } from './db-path.js'
import { modelToTableName, modelToAccessor, updatedAtFields, isStoredField, pointColumns, fieldToColumnName,
         SEARCH_TABLE, searchModels, searchRankExpr } from './ddl.js'
import { buildSealMap } from './seal.js'
import { buildValueSetMap, enforceValueSets } from './valuesets.js'
import { buildEdgeMap, arcCheckExpr, arcDefaultMessage, columnMapFor, mapExprCols,
         pointDefaultMessage } from './ddl.js'
import {
  buildWhere, buildOrderBy, buildRelationOrderBy, buildWindowCols, windowColumnNames, rawClause, isNamedAgg,
  buildNamedAggExpr, extractNamedAggs, parseSelectArg, trimAllToSelect, vectorOrderPlan,
  orderByAfterVector, vectorQueryBytes, deserializeRow, coerceBooleans,
  booleanBind, encodeCursor, decodeCursor, normalizeOrderBy, buildCursorWhere,
  extractCursorValues, cursorOrderSql, filterableKeysFor,
  aggregatableKeysFor, LIKE_SQL, likePattern, ftsWords, identifyingKeysFor, inList, keyIn, tupleOf, tuplesOf, pairsOn, blobKeyClauses,
  sqlFragment, ident, quoteIdent, and, join as sqlJoin, pageSql } from './query.js'
import { scoreByDistance, DISTANCE_FIELD } from './vector.js'
import { validate, hasTransforms, transformValue, buildValidationMap, validateJsonPatch, typeMemberDefault, ValidationError } from './validate.js'
import { createCardinalityLedger, refuseChildlessCreate } from './cardinality.js'
import { createExclusionLedger } from './exclusion.js'
import { PluginRunner, AccessDeniedError } from './plugin.js'
import { GatePlugin, FrontierGateGetLevel, levelPasses, GATE_LIFT, liftsGate } from '../plugins/gate.js'
import { CapabilityPlugin, requireGrantSubset } from '../plugins/capability.js'
import { capabilityDeclarations } from './capabilities.js'
import {
  buildPolicyMap, buildScopeMap, compileScope, compileStatic,
  buildPolicyFilter, checkCreatePolicy, checkPostUpdatePolicy, policyVerdict, evalJs,
  compileFieldPredicate, delegationProblems, buildClaimSet, checkFieldPolicies,
  authClaimsUsed } from './policy.js'
import {
  encryptField, decryptField, encryptDeterministic, normalizeKey,
  comparisonEncoderFor, makeKeyring, legacyForm, opaqueMark } from './encryption.js'
import { backupSqliteTo, readBackupStamp, clearBackupStamp } from './backup.js'
import { makeJsonlTable } from '../drivers/jsonl.js'
import { runSqliteRetention, compactJsonl, RETENTION_BATCH } from './retention.js'
import { ensureEventsTable, makeEventRecorder, createEventWatcher } from './cross-process.js'
import {
  TransitionViolationError, TransitionConflictError, VersionRequiredError,
  VersionConflictError, SyncConflictError,
  TransitionNotFoundError, BulkTransitionError, SoftDeletedUniqueError,
  UniqueConflictError, uniqueConflictColumns, checkViolationExpr, isCheckViolation,
  datatypeMismatch, isDatatypeMismatch, isUniqueConflict, ForeignKeyError, isForeignKeyFailure, CapabilityNotDeclaredError } from './errors.js'
import { threeWay } from './three-way.js'
import { buildCommitmentMap, dueSql, readBy, LATEST_DAY } from './commitment.js'
import { dueAt, offsetSpans, partsIn, plainDateIn } from '@frontierjs/toolbelt/datetime'
import { spread as rankSpread } from '@frontierjs/toolbelt/rank'
import { REDACTED } from '@frontierjs/toolbelt/redact'
import {
  buildAutoIdMap, buildGeneratedDefaultMap, buildAuthDefaultMap, buildLiteralDefaultMap, buildSelfRelationMap,
  buildFieldRefDefaultMap, buildUpdatedByMap, buildVersionMap, buildCreatedByMap, buildSyncMap,
  buildSequenceMap, buildRankMap, schemaDeclaresAccessRules, buildFieldPolicyMap, shapesRead, isProtected, buildSecretMap, viewProtectedRead,
  buildJsonMap, buildGeneratedMap, buildFromMap, buildCardinalityMap, buildExclusionMap, buildComputedSet, buildBoolMap, buildBigMap,
  buildAffinityMap,
  buildFilterKindMap, buildTransitionMap, buildEnumMap, buildSoftDeleteCascadeMap,
  getCascadeTargets, buildRelationMap, buildFieldReadMap, buildGuardedMap,
  buildSoftDeleteMap, buildHasTemplatesMap, buildEffectiveMap, buildCoFkMap, buildFtsMap, nowISO, aggModelsOf } from './schema-maps.js'
import {
  wideDb, mappedDb, narrowedDb, clockedDb, rawHandle, resolveAccessConfig, buildDbRegistry, buildModelDbMap,
  jsonlFilePath } from './databases.js'
import {
  applyGeneratedDefaults, restampClock, noteStamp, stampFromAuth, applyAuthDefaults, ensureSequenceTable,
  applySequences } from './stamps.js'
import {
  suggestKey, globalFilterKeysFor,
  globalFilterRefusal, collectWhereKeyProblems, collectAggKeyProblems, VIEW_REFUSED, withArgValidation } from './args.js'
import { loadComputedFields, normalizeComputed, applyComputed } from './computed.js'
import { makeTxManager, makeReadRouter } from './transaction.js'
import { makeLockPrimitive } from './locks.js'
import { makeIntrospection } from './introspect.js'
import { makeWriteData, writeKeySets } from './write-data.js'
import { makeWhereRewrite } from './where-rewrite.js'
import { makeStateGuards, NOT_VISIBLE } from './state-guards.js'
import { makeExtensible, EXT_SLOTS } from './extensible.js'
import { makeNestedWrites, JOINED } from './nested-writes.js'
import { applyFieldPolicyTo } from './field-policy.js'
import { fromSelectExpr, resolveFromRowRefs, coerceEdgeValue, resolveIncludes } from './include.js'
import { gatedFromFields } from './from-gate.js'
import { refuseUntrustedSchema } from './untrusted.js'
import {
  checkAnnounce, emitQuery, queryTapped, buildHookRunner, installHooks, buildEventEmitter, defer } from './hooks.js'
import { makeLoggerAutoModel, trailModelName, buildLogMap, buildLogEntry, trailRowValues, fireLog, drainPendingLogs } from './audit-log.js'
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


// The operators a Json column takes on its WHOLE value. A `where` on an
// extensible column carrying one of these is comparing the document, not
// reaching into it.
const RECURSIVE_KEYS = ['direction', 'maxDepth', 'nested', 'via']
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


// The seam a test reads a bulk write's plan through: `db.item[PLAN](verb, args)`.
// A symbol, so it is on no completion list and no `Object.keys`; off
// `src/index.js`, so it is on no published surface (`IDEAS/litestone-by-
// construction.md` § 7.2 — a plan stays internal).
export const PLAN = Symbol.for('litestone.plan')
// The two seams `$search` reads a model through (FJS-D970): its EXISTS branch
// under the one MATCH, and the step-2 read that turns a hit's rowid into `id`
// and `sub`. Symbol-keyed so a flavor wrapper runs them under its principal and
// they stay off the enumerable surface.
export const SEARCH_BRANCH  = Symbol.for('litestone.searchBranch')
export const SEARCH_RESOLVE = Symbol.for('litestone.searchResolve')


// Whether any read rule adds to a read of this table for its flavor:
// `tbl[NARROWED]()`. hiddenParents asks it of a PARENT's table, whose rules
// only that table's closure knows.
export const NARROWED = Symbol.for('litestone.narrowed')

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
  const shape = ctx.shapes[modelName]
  return stampFromAuth(applyAuthDefaults(row, shape.authDefaults, ctx.auth), shape.createdBy, ctx.auth)
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
/**
 * What the schema says about one model or view — every facet present, an
 * undeclared one its explicit empty value, the record frozen.
 * @typedef {object} Shape
 * @property {string}  modelName              as declared (`User`)
 * @property {string}  tableName              what SQL names it; a view's is the view's own name
 * @property {boolean} isView
 * @property {import('../index.d.ts').ModelDef} model   the declaration (a view's model stub)
 * @property {string}  db                     the database the rows live in (`main`)
 * @property {Record<string, string>} columnMap   field → column, for the names that differ
 * @property {Set<string>} jsonFields
 * @property {Set<string>} generatedFields
 * @property {Set<string>} computedFields
 * @property {Set<string>} boolFields
 * @property {Set<string>} bigFields
 * @property {Record<string, { values: Set<string>, enumName: string, optional: boolean, array: boolean }>} enumFields
 * @property {Map<string, 'array' | 'json' | 'file' | 'boolean' | 'number' | 'any'>} fieldKinds
 * @property {Record<string, 'NUMERIC' | 'TEXT' | 'BLOB'>} affinity
 * @property {boolean} softDelete
 * @property {boolean} softDeleteCascade
 * @property {string | null} hasTemplates      the `@@hasTemplates` marker column
 * @property {{ from: string | null, to: string | null, kind: 'day' | 'instant', imposed: boolean } | null} effective
 * @property {string[] | null} ftsFields
 * @property {Record<string, import('./field-policy.js').FieldPolicy>} fieldPolicy
 * @property {Record<string, { rotate: boolean }>} secrets
 * @property {Record<string, any>} fromFields   `@from` and `@derived`, by field
 * @property {Record<string, any>} relations    by relation field
 * @property {Record<string, any>} edges        `@edge` storage, by field
 * @property {Record<string, string[]>} coFk    child model → the FK columns a nested write propagates
 * @property {{ field: string, generate: () => string } | null} autoId
 * @property {{ field: string, generate: () => unknown, clock?: boolean }[]} generatedDefaults
 * @property {{ field: string, authField: string, fillsNull: boolean }[]} authDefaults
 * @property {{ field: string, value: unknown }[]} literalDefaults
 * @property {{ field: string, sourceField: string }[]} fieldRefDefaults
 * @property {{ field: string, authField: string }[]} createdBy
 * @property {{ field: string, authField: string }[]} updatedBy
 * @property {string | null} version           the `@version` column
 * @property {string | null} sync              `@@sync`'s policy
 * @property {{ relationField: string, fkField: string, referencedField: string }[]} selfRelations
 * @property {{ field: string, scope: string[] }[]} sequences
 * @property {{ field: string, scope: string[] }[]} ranks   `@rank` columns and the fields each orders within
 * @property {Record<string, any> | null} transitions   by field, where the model declares `@@transitions`
 * @property {{ self: any | null, parents: any[] }} seal
 * @property {{ read: boolean, transitions: Set<string>, columns: Set<string>, transitionFields: Set<string> } | null} capabilities
 * @property {any[] | null} commitments
 * @property {Record<string, { allows: any[], denies: any[] }>} policy   by operation
 * @property {Record<string, any>} scopes       `@@scope` predicates by name
 * @property {boolean} hasValidation
 * @property {{ byParent: any[], byChild: any[], requiresChildren: any[] | null }} cardinality
 * @property {any[]} exclusions                 this model's `@@exclude` memberships, each with its `scope` name
 * @property {any[]} exclusionParents           members whose range `@from`s this model's columns
 * @property {any[]} valueSets                  the `@values` bindings its columns carry
 * @property {Map<string, any[]>} fieldLogs    `@trail` targets by field
 * @property {any[] | null} modelLogs           `@@trail` targets
 * @property {Set<string>} guardedKeys          columns a non-system caller may not name
 * @property {boolean} reachesGuarded           can any argument walk to one, through any relation
 * @property {Set<string>} fieldReadKeys        columns carrying a read predicate
 * @property {boolean} reachesFieldRead
 * @property {Set<string>} policiedAggregates   `@from` aggregates over a target with a read policy
 * @property {{ claim: string, binds: number, ctes: string } | null} tenantShadows   what a tenant read of a `@@tenant` view inlines
 */

// `shape` is a `Shape` (see `shapeFor` in `createClient`): every facet is
// present, so nothing here defaults one. A facet this destructure does not
// name is read as `shape.x` below.
function makeTable(readDb, writeDb, shape, ctx) {
  const {
    tableName,                       // SQL table name ("user" — used in FROM/INTO clauses)
    modelName,                       // Model name as declared ("User")
    jsonFields,
    generatedFields,
    computedFields,
    softDelete,
    ftsFields,
    boolFields,
    enumFields,
    fieldKinds,
    softDeleteCascade,
    fieldPolicy,
    fromFields,
    bigFields,
    columnMap,
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
  // Outermost, so the text it rewrites is the one the table built. A system
  // client with no tenant in scope reads every tenant's projection, as its
  // policy does (FJS-519).
  if (shape.tenantShadows) {
    const { claim } = shape.tenantShadows
    readDb = narrowedDb(readDb, shape.tenantShadows, () => ctx.auth?.[claim] ?? null)
  }
  // The table's name as a fragment, quoted once here rather than at each of the
  // statements below that splice it.
  const T = ident(tableName)

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
  const { computedFns, tx, emitter, globalFilters } = ctx
  const plugins = ctx.plugins   // PluginRunner
  const hasFieldPolicy = shapesRead(fieldPolicy)
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
  //
  // An UPDATE names only the columns it changes, and a unique index (a partial
  // one most of all) can span columns it leaves alone. `reached(cols)` reads
  // those from the row the statement was aimed at, so the values are the row's
  // own after the write rather than `undefined` (FJS-2691).
  function asUniqueConflict(err, data, reached) {
    if (!isUniqueConflict(err) || err instanceof UniqueConflictError) return err
    const cols = uniqueConflictColumns(err)?.map(_fieldOf)
    if (!cols?.length) return err
    let rows = Array.isArray(data) ? data : [data]
    if (reached && rows.length === 1 && rows[0] && typeof rows[0] === 'object'
        && cols.some(c => !(c in rows[0]) || rows[0][c] === undefined)) {
      let held = null
      try { held = reached(cols) } catch { /* the plain answer below stands */ }
      if (held) {
        const merged = { ...held }
        for (const [k, v] of Object.entries(rows[0])) if (v !== undefined) merged[k] = v
        rows = [merged]
      }
    }
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
        const idField = shape.model.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
        return new SoftDeletedUniqueError(modelName, cols, cols.map(c => redactValue(c, row[c])), hit[idField], idField)
      }
    }
    // A live row holds the value, which is the ordinary case and the one that
    // used to escape as a 500 carrying `product_variant.sku`.
    const named = rows.find(r => r && typeof r === 'object' && cols.some(c => r[c] !== undefined))
    return new UniqueConflictError(
      modelName, cols,
      cols.map(c => (named?.[c] === undefined ? undefined : redactValue(c, named[c]))),
      { keys: _parentKeys.flatMap(p => p.fields) })
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

    const model = shape.model
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

    // SQLite reports a CHECK that opens with a column by that column's name
    // alone, not by its text, so a point's refusal arrives as `location` and
    // is found by the field. Without this the refusal is the model-level
    // sentence below -- no column, no rule.
    for (const f of model?.fields ?? []) {
      const pt = f.attributes?.find(a => a.kind === 'point')
      if (!pt || want !== fieldToColumnName(f)) continue
      const out = new ValidationError([{ path: [f.name], message: pointDefaultMessage(pt) }])
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

  // A value of the wrong storage class in a STRICT column (FJS-1609, FJS-D521).
  // SQLite's sentence is true of a physical column and tells nobody what to
  // send, so it becomes the same 422 a validator's refusal is.
  function asDatatypeMismatch(err) {
    if (!isDatatypeMismatch(err) || err instanceof ValidationError) return err
    const m = datatypeMismatch(err)
    if (!m) return err
    const field = _fieldOf(m.column)
    const out = new ValidationError([
      { path: [field], message: `cannot hold a ${m.stored} value — the field is ${m.declared}` },
    ])
    out.model = modelName
    return out
  }

  // One owner for "SQLite refused this write". Every constraint routes through
  // here, because eight call sites each choosing which translator to try is how
  // one of them ends up trying neither.
  function asConstraintError(err, data, reached) {
    if (isCheckViolation(err)) return asCheckViolation(err)
    if (isDatatypeMismatch(err)) return asDatatypeMismatch(err)
    if (isForeignKeyFailure(err)) return asMissingParent(err, data)
    return asUniqueConflict(err, data, reached)
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
      // A single-column key first: when its parent is missing, so is the
      // composite parent that shares the column, and the single one is the cause.
      for (const cols of [...keys.values()].sort((a, b) => a.length - b.length)) {
        const fields = cols.map(c => _fieldOf(c.from))
        const values = fields.map(f => row?.[f])
        if (values.some(v => v == null)) continue
        const hit = readDb.query(
          `SELECT 1 FROM "${cols[0].table}" WHERE ${cols.map(c => `"${c.to}" = ?`).join(' AND ')} LIMIT 1`
        ).get(...values)
        if (hit) continue
        // Two relations may share a leading column (`crew` and `crewDay`), so
        // the whole list is what names one.
        const [relation, rel] = Object.entries(shape.relations)
          .find(([, r]) => r.kind === 'belongsTo' &&
            r.foreignKeys.length === fields.length && r.foreignKeys.every((n, i) => n === fields[i])) ?? []
        return parentRefusal(relation, fields, values, rel?.targetModel ?? cols[0].table)
      }
    } catch { return err }
    return new ForeignKeyError(modelName)
  }

  // The one spelling of *that parent is not there*, for a missing parent and a
  // hidden one alike: a difference between the two answers is the oracle.
  function parentRefusal(relation, fields, values, target, archived = false) {
    const one = fields.length === 1
    const out = new ForeignKeyError(modelName, {
      relation,
      field:  one ? fields[0] : fields,
      value:  one ? redactValue(fields[0], values[0]) : fields.map((f, i) => redactValue(f, values[i])),
      target,
      archived,
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
  const _parentKeys = shape.model.fields.flatMap(f => {
    if (f.type?.kind !== 'relation') return []
    const a = f.attributes.find(x => x.kind === 'relation' && x.fields)
    return a ? [{ relation: f.name, target: f.type.name, fields: [a.fields].flat(), references: [a.references].flat() }] : []
  })

  // ── a key to a row holding a grant is that grant ──────────────────────────
  //
  // The resolver flattens a role row onto whoever holds a key to it, so the
  // column guard alone is walked around: an admin refused writing a role with
  // more than they hold points their own key at the owner's role and takes all
  // of it (FJS-2324). The parent is read past every rule, since a policy
  // stripping the list would grade it as empty. One hop — a key to a row that
  // keys a role is the resolver's to flatten, and nothing here can see it.
  function grantColumnsOf(target) {
    return (ctx.shapes[target]?.model?.fields ?? []).filter(f => f.type?.name === 'Capability').map(f => f.name)
  }

  function parentRows(sink, references, values) {
    return sink.rowsWhere(references, [values])
  }

  function requireParentGrants(target, fields, references, values) {
    if (ctx.isSystem) return
    const grants = grantColumnsOf(target)
    const sink   = grants.length && ctx.cascadeSinkFor?.(target)
    if (!sink) return
    for (const r of parentRows(sink, references, values))
      for (const g of grants) requireGrantSubset(modelName, fields.join(', '), r[g], ctx)
  }

  // A template is a live row the caller may read, not a hidden one: the
  // template filter shapes which rows a statement is ABOUT, and grading a
  // parent by it refused every child added under a template (FJS-2630).
  async function canRead(tbl, where, templates = false, deleted = false) {
    try { return await tbl.exists({ where, ...(templates ? { withTemplates: true } : {}), ...(deleted ? { withDeleted: true } : {}) }) }
    catch (e) { if (e instanceof AccessDeniedError) return false; throw e }
  }

  // A parent unreadable now and readable with `withDeleted` is archived. Any
  // caller may pass that flag, so saying so tells her nothing she could not
  // ask; a parent she could not read either way stays indistinguishable from
  // a missing one.
  async function isArchivedParent(tbl, target, where) {
    return !!ctx.shapes?.[target]?.softDelete &&
      await canRead(tbl, where, ctx.shapes?.[target]?.hasTemplates != null, true)
  }

  // A parent no read rule narrows hides a row from the caller only by the
  // gate refusing the whole model, which needs no query to ask. Without this,
  // every write naming a foreign key paid one exists() per key on a schema
  // with nothing to hide.
  async function hidesNothing(tbl, target) {
    if (tbl[NARROWED]?.() !== false) return false
    try { if (plugins?.hasPlugins) await plugins.beforeRead(target, {}, ctx); return true }
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
  //
  // A key the call names under `system:` is the application's statement, as a
  // stamp is: a hook that copies a parent id from a row it read puts there a
  // parent the caller may not read, and grading it as the caller's guess
  // answered 422 'names no …' for a value the caller never chose (FJS-1953).
  //
  // A refusal names the first hidden relation and carries every one in
  // `hidden`, for the create policy to read as missing: a rule reading a
  // hidden parent's column answers by that column, and the caller chose both
  // the key and the payload it is compared with (FJS-1712).
  //
  // A parent holding a `Capability[]` is graded here too, only once the caller
  // can read it: a hidden one answers as hidden, and naming its list would read it.
  async function hiddenParents(rows, stamped = [], system = null) {
    const out = []
    if (ctx.isSystem || !_parentKeys.length) return out
    const lifted = new Set(system == null ? [] : [system].flat())
    for (const p of _parentKeys) {
      const tbl  = ctx.tables?.[modelToAccessor(p.target)]
      const sink = ctx.cascadeSinkFor?.(p.target)
      if (!tbl || !sink) continue
      const grants = grantColumnsOf(p.target)
      const blind  = await hidesNothing(tbl, p.target)
      if (blind && !grants.length) continue
      const verdict = new Map()
      for (const [i, row] of rows.entries()) {
        if (!row || typeof row !== 'object' || !p.fields.every(f => f in row)) continue
        if (p.fields.every(f => stamped[i]?.has(f) || lifted.has(f))) continue
        const values = p.fields.map(f => row[f])
        if (values.some(v => v == null || typeof v === 'object')) continue
        const key = JSON.stringify(values)
        if (!verdict.has(key)) verdict.set(key, blind ||
          await canRead(tbl, Object.fromEntries(p.references.map((r, j) => [r, values[j]])), ctx.shapes?.[p.target]?.hasTemplates != null) ||
          !parentRows(sink, p.references, values).length)
        if (verdict.get(key)) {
          requireParentGrants(p.target, p.fields, p.references, values)
          continue
        }
        if (out[i]) { out[i].hidden.add(p.relation); continue }
        const archived = await isArchivedParent(tbl, p.target, Object.fromEntries(p.references.map((r, j) => [r, values[j]])))
        out[i] = parentRefusal(p.relation, p.fields, values, p.target, archived)
        Object.defineProperty(out[i], 'hidden', { value: new Set([p.relation]), enumerable: false })
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
  // validation told a missing parent from a hidden one (FJS-1704). `hidden` is
  // hiddenParents' refusal for the row, whose parents the policy reads as missing.
  function checkCreate(row, hidden) {
    const v = checkCreatePolicy(modelName, row, ctx, hidden?.hidden)
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
  function asRestrictedDelete(err, rows, from = modelName) {
    if (!isForeignKeyFailure(err) || err instanceof ForeignKeyError) return err
    try {
      let frontier = [[from, rows]]
      const seen = new Set()
      const blockers = []
      while (frontier.length) {
        const next = []
        for (const [parent, parentRows] of frontier) {
          for (const rel of Object.values(ctx.shapes[parent].relations)) {
            if (rel.kind !== 'hasMany' || rel.onDelete === 'SetNull' || rel.onDelete === 'SetDefault') continue
            const sink = ctx.cascadeSinkFor?.(rel.targetModel)
            if (!sink) continue
            const keys = tuplesOf(parentRows, rel.referencedKeys)
            if (!keys.length) continue
            const found = sink.rowsWhere(rel.foreignKeys, keys)
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

  // A model whose `@@gate` locks delete (9) is append-only, and a parent's
  // Cascade is SQLite removing its rows past the gate. The DELETE is refused as
  // a Restrict child would refuse it, whoever asks, asSystem() included
  // (`FJS-D1281`). The model walk is static and is done once; the row walk runs
  // only when a locked model sits under a Cascade chain from this one.
  let _lockedBelow = null
  function lockedBelowCascade() {
    if (_lockedBelow) return _lockedBelow
    const locked = new Set()
    if (ctx.gateFor) {
      const seen = new Set([modelName])
      const queue = [modelName]
      while (queue.length) {
        for (const rel of Object.values(ctx.shapes[queue.shift()].relations)) {
          if (rel.kind !== 'hasMany' || rel.onDelete !== 'Cascade' || seen.has(rel.targetModel)) continue
          seen.add(rel.targetModel)
          queue.push(rel.targetModel)
          if (ctx.gateFor(rel.targetModel, 'delete') === 9) locked.add(rel.targetModel)
        }
      }
    }
    return (_lockedBelow = locked)
  }

  function refuseLockedCascade(where) {
    if (!lockedBelowCascade().size) return
    const sel = selectWhere(where)
    const rows = readAll(readDb.query(sel.sql).all(...sel.params))
    const blockers = []
    const seen = new Set()
    let frontier = [[modelName, rows]]
    while (frontier.length) {
      const next = []
      for (const [parent, parentRows] of frontier) {
        for (const rel of Object.values(ctx.shapes[parent].relations)) {
          if (rel.kind !== 'hasMany' || rel.onDelete !== 'Cascade') continue
          const sink = ctx.cascadeSinkFor?.(rel.targetModel)
          if (!sink) continue
          const keys = tuplesOf(parentRows, rel.referencedKeys)
          if (!keys.length) continue
          const found = sink.rowsWhere(rel.foreignKeys, keys)
            .filter(r => !seen.has(`${rel.targetModel}\0${r[sink.idField]}`))
          if (!found.length) continue
          for (const r of found) seen.add(`${rel.targetModel}\0${r[sink.idField]}`)
          if (_lockedBelow.has(rel.targetModel)) blockers.push({ model: rel.targetModel, idField: sink.idField, ids: found.map(r => r[sink.idField]) })
          next.push([rel.targetModel, found])
        }
      }
      frontier = next
    }
    if (!blockers.length) return
    const out = new ForeignKeyError(modelName, { child: { model: blockers[0].model, id: blockers[0].ids[0] } })
    Object.defineProperty(out, 'blockers', { value: blockers, enumerable: false })
    throw out
  }

  // The same answer for a statement that deleted this table's rows by a WHERE
  // (deleteMany, a hard remove): the refused DELETE rolled back, so the rows it
  // named are still there to be read.
  function refusedDelete(err, whereSql, params) {
    if (!isForeignKeyFailure(err) || err instanceof ForeignKeyError) return err
    let rows
    try { rows = readAll(writeDb.query(`SELECT * FROM "${tableName}"${whereSql ? ` WHERE ${whereSql}` : ''}`).all(...params)) }
    catch { return err }
    return asRestrictedDelete(err, rows)
  }

  // A `@hardDelete` child removed by a soft delete's cascade. The refusing row
  // sits under the CHILD, so the walk starts from the child rows.
  function refusedChildDelete(err, childModel, childTable, foreignKeys, keys) {
    if (!isForeignKeyFailure(err) || err instanceof ForeignKeyError) return err
    let rows
    const binds = []
    try { rows = writeDb.query(`SELECT * FROM "${childTable}" WHERE ${keyIn(foreignKeys.map(f => `"${f}"`), keys, binds)}`).all(...binds) }
    catch { return err }
    return asRestrictedDelete(err, rows, childModel)
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
  // a field-level @allow(read) is a predicate over a row, and an aggregate has
  // no row to evaluate it against, so it is refused rather than guessed at.
  const _aggKeySets = aggregatableKeysFor(shape.model)

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
    if (p.allow?.read?.length)        return `carries a field-level @allow(read, …), which is decided per row — an aggregate has no ` +
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

  // `_count` is `true` or `{ distinct: 'col' }`. Prisma's `{ _all: true }` and
  // any other object answered a bare number where the caller reads `_count._all`,
  // so the shape is refused by name rather than counted as COUNT(*).
  function refuseCountShape(op, _count) {
    if (!_count || _count === true) return
    const isDistinct = typeof _count === 'object' && !Array.isArray(_count)
      && Object.keys(_count).length === 1 && typeof _count.distinct === 'string'
    if (!isDistinct) throw new ValidationError([{ path: [op, '_count'], message:
      `${op}() _count takes true or { distinct: '<column>' }, got ${JSON.stringify(_count)}. ` +
      `The count is a bare number (_count: true), not an object keyed by column — ` +
      `Prisma's { _all: true } is spelled _count: true here.` }])
    refuseAggregateKeys(op, [_count.distinct], false)
  }

  // The names a `window` spec adds to a row, after the spec is held to the
  // aggregate key check. One owner, since `findMany` and `findManyAndCount`
  // both build the window column and a verb that skipped this would hand a
  // scoped caller the @guarded column the check exists to refuse.
  function windowNamesOf(windowSpec) {
    if (!windowSpec) return null
    const { values, names } = windowColumnNames(windowSpec)
    refuseAggregateKeys('window', values)
    refuseAggregateKeys('window', names, false)
    return new Set(Object.keys(windowSpec))
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

  // ─── one currency per aggregate ─────────────────────────────────────────
  // A @money(field: f) column holds each row's amount in that row's own
  // currency, so SUM over $49, €45 and ¥7,000 answered a bare 16,400 that a
  // dashboard printed as $164.00 (FJS-2171). An amount is aggregated only
  // where the currency is one: a `by` naming f, or a where pinning f to one
  // value. @money(USD) is one by declaration and never reaches this.
  const _perRowCurrency = new Map((shape.model?.fields ?? []).flatMap(f => {
    const m = f.attributes?.find(a => a.kind === 'money')
    return m?.field ? [[f.name, m.field]] : []
  }))

  function pinsOneValue(where, f) {
    if (!where || typeof where !== 'object') return false
    if (f in where) {
      const v = where[f]
      if (v !== null && typeof v !== 'object') return true
      if (Array.isArray(v)) return v.length === 1
      if (v && 'equals' in v && v.equals !== null && typeof v.equals !== 'object') return true
      if (v && Array.isArray(v.in) && v.in.length === 1) return true
    }
    const and = where.AND
    return Array.isArray(and) ? and.some(w => pinsOneValue(w, f)) : pinsOneValue(and, f)
  }

  // `args` is aggregate's or groupBy's; `extra` is the `having`/`orderBy`
  // objects, which name a value aggregate without selecting it.
  function refuseMixedCurrency(op, args, by = [], extra = []) {
    if (!_perRowCurrency.size) return
    const reads = []
    for (const src of [args, ...extra]) {
      if (!src || typeof src !== 'object') continue
      for (const agg of ['_sum', '_avg', '_min', '_max'])
        if (src[agg] && typeof src[agg] === 'object')
          for (const [name, on] of Object.entries(src[agg])) if (on) reads.push(name)
    }
    // A named aggregate's `filter` is a sql`` fragment, which cannot be read
    // for a pin; its currency is pinned by the where or the `by` like any other.
    for (const [, spec] of extractNamedAggs(args)) {
      if (!spec || typeof spec !== 'object') continue
      for (const fn of ['sum', 'avg', 'min', 'max'])
        if (typeof spec[fn] === 'string') reads.push(spec[fn])
    }
    for (const name of reads) {
      const cur = _perRowCurrency.get(name)
      if (!cur || by.includes(cur) || pinsOneValue(args.where, cur)) continue
      throw new ValidationError([{ path: [op, name], message:
        `Cannot ${op} '${name}' on ${modelName} across currencies — it is @money(field: ${cur}), so each row's ` +
        `amount is in that row's ${cur}. Group by: ['${cur}'], or pin where: { ${cur}: '<code>' }` }])
    }
  }

  // SQLite adds integers in int64 and the read hands back a double, so a sum
  // of rows each under 2^53 can land past it and arrive one unit short with
  // nothing raised (`FJS-2172`). A REAL column's sum is a float and is not
  // this: only an integer column is held to the cap.
  const _integerFields = new Set((shape.model?.fields ?? [])
    .filter(f => ['Int', 'BigInt'].includes(f.type?.name ?? f.type)).map(f => f.name))

  function exactSum(op, field, value) {
    if (typeof value !== 'number' || Number.isSafeInteger(value) || !_integerFields.has(field)) return value
    throw new ValidationError([{ path: [op, '_sum', field], message:
      `${op} _sum of '${field}' on ${modelName} is past 2^53 (${Number.MAX_SAFE_INTEGER}), which a JS number cannot ` +
      `hold exactly. Narrow it with a where, or group by something so each sum is smaller` }])
  }

  // @@hasTemplates marker column name, or null if this model doesn't opt in.
  // Read paths inject `<field> = false` by default; `withTemplates` /
  // `onlyTemplates` query args opt out / invert the filter.
  // Whether this model declares any @@scope. Checked before walking a where for
  // `$scope`, so a schema with none pays one boolean per read.
  const _hasScopes = Object.keys(shape.scopes).length > 0

  // Fields declaring @trim/@lower/@upper/@slug, or null when none do — the
  // same one-boolean cost for a where on a model without them.
  const transformedOf = (model) => {
    const fields = (ctx.models?.[model]?.fields ?? []).filter(hasTransforms)
    return fields.length ? new Map(fields.map(f => [f.name, f])) : null
  }
  const _transformed = transformedOf(modelName)

  const hasTemplatesField = shape.hasTemplates
  const hasTemplates      = hasTemplatesField !== null

  // The window, or null if this model declares none. `{ from, to, kind, imposed }`
  // — `from` is null on an `@@expires` model, `kind` is 'instant' or 'day'
  // depending on whether the columns are `DateTime` or `String @date`, and
  // `imposed` is which of the two words declared it.
  const effective = shape.effective

  const _modelForKeys = shape.model
  const _writeKeys = writeKeySets(shape)
  const { _allowedWriteKeys, _immutableWriteKeys, _edgeNamespaces } = _writeKeys
  const _modelRels = shape.relations

  // ── @edge / @scoped write helpers ─────────────────────────────────────────────
  const _edges = shape.edges

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
    if (tn === 'Boolean') {
      const bound = booleanBind(value)
      if (bound === undefined) throw new ValidationError([{ path: [desc.field], message: 'must be a boolean' }])
      return bound
    }
    if (tn === 'Json')    return JSON.stringify(value)
    if (value instanceof Date) return value.toISOString()   // a Date bound raw throws inside bun:sqlite
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
        const bind = desc.auth ? '$setAuth' : `scopedBy({ ${desc.key} })`   // scopedBy never binds a @scoped dimension
        throw new Error(`@edge '${modelName}.${desc.field}': cannot resolve dimension '${desc.key}' — bind it with ${bind}`)
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
      const binds   = []
      const hostIn  = inList(`"${d0.hostCol}"`, hostIds, binds)
      const colList = g.cols.map(c => `"${c.col}"`).join(', ')
      const found   = readDb
        .query(`SELECT "${d0.hostCol}" AS __h, ${colList} FROM "${d0.table}" WHERE ${hostIn} AND "${d0.dimCol}" = ?`)
        .all(...binds, dimId)
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

  function _ecp(v) { return typeof v === 'boolean' ? (v ? 1 : 0) : v instanceof Date ? v.toISOString() : v }

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
    const rowOf = `FROM "${d0.table}" ${alias} WHERE ${alias}."${d0.hostCol}" = ${host} AND ${alias}."${d0.dimCol}" = ?`
    const frags = []
    for (const [field, val] of Object.entries(predicate ?? {})) {
      const desc = cols.find(c => c.field === field)
      if (!desc) continue
      const inner = [], innerParams = []
      // An own-storage edge with no side row READS as its @default, so the filter grades that
      // value too: "unread" is every row this viewer never marked. A decorate edge is
      // membership, so a missing row stays a non-match.
      const own = desc.storage === 'own'
      const sideCol = `${alias}.${quoteIdent(desc.col)}`
      const col = own ? '_ev."v"' : sideCol
      if (val === null) { inner.push(`${col} IS NULL`) }
      else if (typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
        for (const [op, v] of Object.entries(val)) {
          if      (op === 'not') { if (v === null) inner.push(`${col} IS NOT NULL`); else { inner.push(`${col} != ?`); innerParams.push(_ecp(v)) } }
          else if (op === 'gt')  { inner.push(`${col} > ?`);  innerParams.push(_ecp(v)) }
          else if (op === 'gte') { inner.push(`${col} >= ?`); innerParams.push(_ecp(v)) }
          else if (op === 'lt')  { inner.push(`${col} < ?`);  innerParams.push(_ecp(v)) }
          else if (op === 'lte') { inner.push(`${col} <= ?`); innerParams.push(_ecp(v)) }
          else if (op === 'in')  { inner.push(inList(col, v.map(_ecp), innerParams)) }
          else if (op === 'contains') { inner.push(`${col} ${LIKE_SQL}`); innerParams.push(likePattern(op, v)) }
        }
      } else {
        inner.push(`${col} = ?`); innerParams.push(_ecp(val))
      }
      const innerSql = inner.length ? inner.join(' AND ') : '1'
      if (own) {
        params.push(dimId, dimId, edgeDefault(desc) === null ? null : _ecp(edgeDefault(desc)), ...innerParams)
        frags.push(`EXISTS (SELECT 1 FROM (SELECT CASE WHEN EXISTS (SELECT 1 ${rowOf}) THEN (SELECT ${sideCol} ${rowOf}) ELSE ? END AS "v") _ev WHERE ${innerSql})`)
      } else {
        params.push(dimId, ...innerParams)
        frags.push(`EXISTS (SELECT 1 ${rowOf} AND ${innerSql})`)
      }
    }
    if (!frags.length) { params.push(dimId); return `EXISTS (SELECT 1 ${rowOf})` }
    return frags.length === 1 ? frags[0] : `(${frags.join(' AND ')})`
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
    // FK lives on THIS table. hasMany / m2m carry foreignKeys too,
    // but the column is on the OTHER table and would falsely accept typos
    // like `users: { create: ... }` paired with a stray `accountId` on the
    // parent (which has no such column).
    if (rel?.kind === 'belongsTo') for (const fk of rel.foreignKeys) _allowedWriteKeys.add(fk)
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
      _cascadeTargetsCache = getCascadeTargets(modelName, ctx.shapes, _modelToTable)
      _cascadeParents      = new Set(_cascadeTargetsCache.map(t => t.parentModel))
    }
    return _cascadeTargetsCache
  }

  // The columns the cascade reads off a row of `model`: every key a child of
  // it references, which may be more than one column and more than one key.
  // Empty for a leaf.
  function cascadeKeysOf(model) {
    const cols = new Set()
    for (const t of _cascadeTargets()) if (t.parentModel === model) for (const c of t.referencedKeys) cols.add(c)
    return [...cols]
  }

  // Runs `step(target, keys)` for every edge out of every model the cascade
  // reaches, starting at this model's `rootRows`; `keys` are the parents'
  // values of the columns the edge's children reference, one array a parent.
  // `step` returns the child rows it reached, carrying `cascadeKeysOf` the
  // child, or nothing for a leaf. A worklist rather than one pass over the
  // targets, because an edge back into a model already reached (Page → Page, a
  // child two parents share) has new rows to follow each time it lands; one
  // pass stopped a self-relation one level down (`FJS-1723`). A row is
  // followed once per model, which is what ends a cycle in the data.
  function walkCascade(rootRows, step) {
    const targets = _cascadeTargets()
    const rootKey = cascadeKeysOf(modelName)
    const reached = new Map([[modelName, new Set(rootRows.map(r => tupleOf(r, rootKey)))]])
    const queue   = [[modelName, rootRows]]
    while (queue.length) {
      const [parent, parentRows] = queue.shift()
      for (const target of targets) {
        if (target.parentModel !== parent) continue
        const keys = tuplesOf(parentRows, target.referencedKeys)
        if (!keys.length) continue
        const childRows = step(target, keys)
        if (!childRows?.length) continue
        if (!reached.has(target.childModel)) reached.set(target.childModel, new Set())
        const seen  = reached.get(target.childModel)
        const idCols = cascadeKeysOf(target.childModel)
        const fresh = childRows.filter(r => {
          const k = tupleOf(r, idCols)
          return k != null && !seen.has(k) && seen.add(k)
        })
        if (fresh.length) queue.push([target.childModel, fresh])
      }
    }
  }

  // The child rows a cascade step reads back to go on walking: the keys its
  // own children reference, and only when something hangs off it.
  function cascadeChildRows(childModel, childTable, keyClause, binds) {
    if (!_cascadeParents.has(childModel)) return null
    const cols = cascadeKeysOf(childModel).map(c => `"${c}"`).join(', ')
    return readDb.query(`SELECT ${cols} FROM "${childTable}" WHERE ${keyClause}`).all(...binds)
  }

  // The soft-delete cascade remove() and removeMany() share. A @hardDelete
  // child is DELETEd and goes no further; a soft one is stamped with the
  // root's `ts`, and its keys are read back only when something hangs off it.
  function cascadeSoftRemove(rootRows, ts, doomed) {
    walkCascade(rootRows, ({ childModel, childTable, foreignKeys, hardDelete }, keys) => {
      const binds = []
      const under = keyIn(foreignKeys.map(f => `"${f}"`), keys, binds)
      if (hardDelete) {
        const heard = hardChildDoomed(childModel, foreignKeys, keys)
        if (heard) doomed.push(...heard)
        try { writeDb.run(`DELETE FROM "${childTable}" WHERE ${under}`, ...binds) }
        catch (e) { throw refusedChildDelete(e, childModel, childTable, foreignKeys, keys) }
        return null
      }
      writeDb.run(`UPDATE "${childTable}" SET "deletedAt" = ? WHERE ${under} AND "deletedAt" IS NULL`, ts, ...binds)
      return cascadeChildRows(childModel, childTable, under, binds)
    })
  }

  const {
    _tableTransitions, _sealSelf, _sealInsertSql, _selfFreezes,
    _bulkTransitionField, refuseSoftDeleteWrite, refuseOffEntry, checkTransitions, transitionLevel, declaredTransitions,
    sealWhereClause, sealInsertGuard, sealRefusal, throwIfSealed, sealSelfClause, throwIfSealedSelf,
    applyTransitionWhereClause,
  } = makeStateGuards(shape, ctx, {
    readDb, col, _ecp, plugins, _immutableWriteKeys, _modelForKeys,
    // Hoisted function and a const built later: both reached only at call time.
    resolveGlobalFilter:      (...a) => resolveGlobalFilter(...a),
    buildWhereWithEncryption: (...a) => buildWhereWithEncryption(...a),
  })


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
    const record = ctx._crossProcess?.recorders?.[shape.db]
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
    defer(() => {
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
  // The subset that can use a `before` image: a cross-process announcement
  // stores ids and nothing else, so it is no reason to read the row first.
  const hasLocalAudience = () => !!(emitter || ctx._eventListeners.size)

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
    && (shape.cardinality.byParent.length
      + shape.cardinality.byChild.length) > 0
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
    const rules = shape.cardinality.byChild
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
  const _exclMembers = tx.exclusions ? shape.exclusions : []
  // A parent whose column some member's range `@from`s: a Shift's time moves
  // every Assignment under it, and the write names none of them (`FJS-D989`).
  const _exclParents = tx.exclusions ? shape.exclusionParents : []
  const _exclNotes   = _exclMembers.length > 0 || _exclParents.length > 0
  const _exclFields  = new Set([
    ..._exclMembers.flatMap(m => [...m.keyFields, ...m.range, ...m.whereFields, ...m.viaFields]),
    ..._exclParents.flatMap(p => p.fields),
  ])
  // Only a write naming the key, an end of the range, a field of `where:` or
  // the relation a range is read through can move a row into another's range;
  // every other update keeps its fast path.
  const exclTouched = (data) => _exclNotes && data != null && Object.keys(data).some(k => _exclFields.has(k))
  const parentTouched = (p, data) => data == null || p.fields.some(f => Object.hasOwn(data, f))
  function noteExclusion(row) {
    if (!_exclNotes || !row) return
    if (_exclMembers.length) tx.exclusions.note(modelName, row)
    for (const p of _exclParents) if (parentTouched(p, row)) tx.exclusions.noteThrough(p, [row])
  }
  // The key a row holds BEFORE an update: a write that leaves the key alone
  // still moves the range under it, and the payload does not name it. A scope
  // of several fields is moved by a payload naming only one of them (a row to
  // another day), so the key it moves TO is the row's own with the payload laid
  // over it.
  function noteExclusionBySql(whereSql, params, data) {
    if (!_exclNotes) return
    const where = whereSql ? ` WHERE ${whereSql}` : ''
    if (_exclMembers.length) {
      const sel = [...new Map(_exclMembers.flatMap(m => m.keyColumns.map((c, i) => [c, m.keyFields[i]]))).entries()]
        .map(([c, f]) => `"${c}" AS "${f}"`).join(', ')
      for (const row of writeDb.query(`SELECT DISTINCT ${sel} FROM "${tableName}"${where}`).all(...params)) {
        tx.exclusions.note(modelName, row)
        if (data) tx.exclusions.note(modelName, { ...row, ...data })
      }
    }
    for (const p of _exclParents) {
      if (!parentTouched(p, data)) continue
      const sel = p.pairs.map(([, c], i) => `${quoteIdent(c)} AS ${quoteIdent(p.refFields[i])}`).join(', ')
      tx.exclusions.noteThrough(p, writeDb.query(`SELECT DISTINCT ${sel} FROM ${quoteIdent(tableName)}${where}`).all(...params))
    }
  }

  // `before` is the row as it stood ahead of an update, shaped like `result`,
  // for a subscriber that must tell who could read it then from who can now. It
  // is absent where no image was read (a bulk write, a restore, a write that
  // began before anything listened), and absent means unknown, never public.
  function fireRowEvent(event, operation, result, transition = null, before = null) {
    if (!hasAudience()) return
    const tenants = result ? tenantsOf([result]) : null
    fireEvent(event, {
      model: modelName, operation, result, scope: 'row', count: 1,
      ...(transition ? { transition } : {}),
      ...(before ? { before } : {}),
      ...(tenants ? { tenants } : {}),
      schema: shape.model,
    })
  }

  function fireCollectionEvent(event, operation, where, count, tenants) {
    // Nothing matched, so nothing changed. A filter that hit no rows must not
    // send every open tab back to the server.
    if (!count) return
    if (!hasAudience()) return
    fireEvent(event, {
      model: modelName, operation, result: null, scope: 'collection', count, where, schema: shape.model,
      ...(tenants ? { tenants } : {}),
    })
  }

  // ── The tenants a write touched ─────────────────────────────────────────
  //
  // Under row tenancy every event says which tenants its rows belong to. A
  // count names no row, so a subscriber routing per tenant -- Junction's
  // function channel on `agency:<id>` -- had nowhere to send it and sent
  // nothing; and a row of a model scoped through its parent (`@@tenant(via:)`,
  // a Share under a Page) carries no column to route by (`FJS-1741`).
  //
  // A model that carries the column reads it off its rows. One scoped through
  // a parent follows the relation its generated tenancy deny follows, one
  // `SELECT DISTINCT` per hop, from the foreign keys on the rows -- which a
  // delete still has, since the parent outlives the child. Resolved on first
  // use: the schema's tenancy is not settled when the table is built. The
  // commitment sweep reads the same path to fire a row in its own tenant.
  let _tenantPath
  function tenantPath() {
    if (_tenantPath !== undefined) return _tenantPath
    const t = ctx.schema?.tenancy
    if (t?.strategy !== 'row') return _tenantPath = null
    const carries = (m) => !!ctx.shapes[m]?.model.fields.some(f => f.name === t.column)
    const walk = (m, seen) => {
      if (carries(m)) return []
      for (const a of ctx.shapes[m]?.model.attributes ?? []) {
        const ref = a.generated === 'tenancy' && a.expr?.type === 'not' && a.expr.expr?.type === 'check' ? a.expr.expr : null
        const rel = ref && ctx.shapes[m].relations?.[ref.field]
        if (rel?.kind !== 'belongsTo' || seen.has(rel.targetModel)) continue
        const rest = walk(rel.targetModel, new Set([...seen, rel.targetModel]))
        if (rest) return [{ field: ref.field, fks: rel.foreignKeys, target: rel.targetModel, refs: rel.referencedKeys }, ...rest]
      }
      return null
    }
    return _tenantPath = walk(modelName, new Set([modelName]))
  }

  function tenantsOf(rows) {
    const path = tenantPath()
    if (!path || !rows?.length) return null
    const distinct = (vs) => [...new Set(vs.filter(v => v != null))]
    const column = ctx.schema.tenancy.column
    if (!path.length) return distinct(rows.map(r => r?.[column]))
    // Each hop carries a key of one or more columns, as tuples (`FJS-2790`).
    let keys = tuplesOf(rows, path[0].fks)
    try {
      for (let i = 0; i < path.length && keys.length; i++) {
        const hop  = path[i]
        const tmap = ctx.shapes[hop.target]?.columnMap ?? {}
        const out  = i + 1 < path.length ? path[i + 1].fks : [column]
        const as   = out.map((_, k) => `v${k}`)
        const sel  = out.map((c, k) => `${ident(tmap[c] ?? c).sql} AS v${k}`).join(', ')
        const refs = hop.refs.map(c => ident(tmap[c] ?? c).sql)
        const next = []
        for (let j = 0; j < keys.length; j += 500) {
          const binds = []
          const sql = `SELECT DISTINCT ${sel} FROM ${ident(_modelToTable(hop.target)).sql} WHERE ${keyIn(refs, keys.slice(j, j + 500), binds)}`
          next.push(...readDb.query(sql).all(...binds))
        }
        keys = tuplesOf(next, as)
      }
    } catch { return null }   // a parent in another database: the tenant stays unnamed
    return distinct(keys.map(k => k[0]))
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
    const rowsFor = mode === 'rows' || (mode === 'collection' && !!tenantPath())
    return { mode, wantRows: rowsFor && hasAudience() }
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
    fireCollectionEvent(event, operation, where, count, tenantsOf(rows))
  }

  // ── Query event emitter ───────────────────────────────────────────────────
  // Zero-cost when no onQuery configured and no $tapQuery listeners active.
  // Fires both the config-time onQuery hook (production logging) and any
  // runtime $tapQuery taps (Studio REPL, testing). Never throws, never blocks.
  const _dbName = shape.db
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
  const idField = shape.model.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'

  // ── Logging helpers ───────────────────────────────────────────────────────
  //
  // All log configuration is pre-computed once at makeTable() time.
  // Tables with no @trail / @@trail get tableHasLogWork = false — the hot path
  // (findMany, create, update, remove, delete) checks this single boolean and
  // exits immediately with zero allocation cost.
  //
  // Design:
  //   tableFieldLogs  — Map<fieldName, [{db, reads, writes}]> for THIS table only
  //   tableModelLogs  — [{db, reads, writes}] for THIS table only, or null
  //   tableHasLogWork  — pre-computed boolean: skip all log work if false
  //   tableNeedsModel — pre-computed: does any @@trail declaration exist for this table
  //   tableNeedsField — pre-computed: does any @trail declaration exist for this table

  // Both keyed by THIS model in `shapeFor`, by model name: keyed by table name
  // they matched only while the two spellings agreed, and under PascalCase
  // every field-level @trail recorded nothing and said nothing.
  const tableFieldLogs   = shape.fieldLogs
  const tableModelLogs   = shape.modelLogs
  // An @@anonymous table has no log (the parser refuses one) and still takes
  // this path, because its writes are what a logged write in the same
  // transaction is refused against (`FJS-D349`).
  const tableAnonymous   = shape.model.attributes.some(a => a.kind === 'anonymous')
  const tableLogsWrites  = !!tableModelLogs?.some(l => l.writes) || [...tableFieldLogs.values()].some(cs => cs.some(c => c.writes))
  const tableHasLogWork  = tableFieldLogs.size > 0 || (tableModelLogs?.length > 0) || tableAnonymous
  const tableNeedsField  = tableFieldLogs.size > 0
  const tableNeedsModel  = tableModelLogs?.length > 0

  // Pre-resolve log tables at startup so getLogTable() is O(1) on hot paths.
  // Map<dbName, logTable>
  const _logTableCache = new Map()
  function getLogTable(dbName) {
    if (_logTableCache.has(dbName)) return _logTableCache.get(dbName)
    const dbEntry = ctx.trailDbMap?.[dbName]
    // A SQL trail is an ordinary table and is written through a SYSTEM context:
    // the row is the engine's record of what happened, not something the
    // calling principal is asking to insert, so it must not be graded by the
    // trail model's own `@@gate` — which is exactly the gate an app puts there
    // to make the trail append-only and readable by staff alone.
    const table   = !dbEntry ? null
      : dbEntry.kind === 'sql'
        ? (ctx.sqlLogTableFor?.(dbEntry.trailModel) ?? null)
        : (ctx.jsonlTableCache?.[dbEntry.trailModel ?? trailModelName(dbName)] ?? null)
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
  // keeps the caller's select, since an id would make every row distinct.
  function logReadParse(select, include, ps, distinct, windowNames = null) {
    if (!tableHasLogWork || tableAnonymous || !select || select[idField] || distinct === true) return ps
    return parseArgs({ ...select, [idField]: true }, include, windowNames)
  }

  // Emit a log entry fire-and-forget to a trail database.
  function emitLog(dbName, entry) {
    const table = getLogTable(dbName)
    if (!table) return
    const built = buildLogEntry(entry, ctx, ctx.onLog)
    fireLog(table, trailRowValues(built), ctx._logStats)
  }

  // ── Audit redaction ─────────────────────────────────────────────────────
  // A protected field's VALUE must never reach a log entry. The audit trail
  // exists to record THAT a field was written — by whom, to which rows, when —
  // not what it holds. Logging the plaintext would defeat the @encrypted it
  // sits next to: the database row is ciphertext while the JSONL beside it is
  // not, and the log file has none of the column's read protections.
  //
  // This matters most for @secret, which expands to
  // @encrypted + @guarded + @trail(<first trail db>) — so declaring a
  // trail database is on its own enough to start logging every @secret field.
  // Redaction is what makes that expansion safe.
  //
  // null is preserved rather than redacted: it holds nothing to leak, and
  // keeping it means a null → value transition is still visible in the trail.
  //
  // A @hashed digest is redacted too: it is the value every read path refuses
  // to hand back, and a stable keyed identifier, so a digest in a 409 lets a
  // caller ask whose value matches whose (FJS-1250).
  //
  // A @personal value is not a secret, and a reader of the row may see it, but
  // the trail outlives the row: an erased person's email would otherwise stay
  // in every snapshot for the trail's whole retention (FJS-D657). It logs as
  // `[personal]` so the entry still says which kind of value was dropped. A
  // column that is both protected and personal logs as `[redacted]`.
  //
  // An @opaque value is stored sealed by a client, so the trail writes a digest
  // of the stored bytes and not the bytes (FJS-D1158): an edit's entry still
  // says WHICH sealed column moved. A mark that is a function takes the value.
  const logMarks = new Map()
  for (const [f, p] of Object.entries(fieldPolicy)) {
    if (isProtected(p))   logMarks.set(f, REDACTED)
    else if (p.personal)  logMarks.set(f, '[personal]')
    else if (p.opaque)    logMarks.set(f, opaqueMark)
  }
  const markOf = (mark, value) => (typeof mark === 'function' ? mark(value) : mark)
  const hasProtectedLogFields = logMarks.size > 0

  // Field-level entries: the entry IS about this field, so it stays — only the
  // value is replaced.
  function redactValue(field, value) {
    if (value == null) return null
    return markOf(logMarks.get(field) ?? value, value)
  }

  // Model-level entries: before/after are whole rows. Copy on write — these
  // objects are the rows handed back to the caller and must not be mutated.
  function redactSnapshot(row) {
    if (!row || !hasProtectedLogFields || typeof row !== 'object') return row
    let out = null
    for (const [f, mark] of logMarks) {
      if (row[f] == null) continue
      if (!out) out = { ...row }
      out[f] = markOf(mark, row[f])
    }
    return out ?? row
  }

  // The trail's image of a row a write read back. That row is shaped for the
  // CALLER, whose read strips a protected column, so a scoped caller's
  // `system: ['apiKey']` write logged null to null and an image without the
  // column (FJS-2297). Where the stored row holds a value the caller's row
  // lacks, the image carries its mark — never the value.
  function trailImage(raw, shaped) {
    if (!raw || !shaped || !hasProtectedLogFields) return shaped
    let out = null
    for (const [f, mark] of logMarks) {
      if (raw[f] == null || f in shaped) continue
      if (!out) out = { ...shaped }
      out[f] = markOf(mark, raw[f])
    }
    return out ?? shaped
  }

  // Emit field-level and model-level log entries for a completed operation.
  // Called once per operation — extracts ids once, shared by both helpers.
  // operation: 'read' | 'write' | 'create' | 'update' | 'delete'
  function emitLogs(operation, rows, { before: beforeMap, after: afterMap, transition = null, ids: readIds = null, system = null, written = null } = {}) {
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

          // A write of the ROW is a write of this field only where the data
          // named it: otherwise creating an account with no password logs
          // `create · account · saPassword`, and so does an update of its time
          // zone (FJS-2048). The returned row can't say, since read() strips a
          // guarded or hashed field; `written` is the data as it was bound.
          // A path with no `written` logs the field as it always did. One
          // entry per row (upsertMany, createMany) narrows the records to the
          // rows that named it.
          let records = ids
          if (written && (operation === 'create' || operation === 'update')) {
            const names = operation === 'create'
              ? d => d?.[field] != null
              : d => field in d || Object.keys(d).some(k => k.startsWith(`${field}.`))
            const given = written.flatMap((d, i) => names(d) ? [i] : [])
            if (!given.length) continue
            if (given.length < written.length && rows.length === written.length) records = extractIds(given.map(i => rows[i]))
          }

          emitLog(db, {
            operation,
            model:   modelName,
            field,
            transition,
            records,
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
          model:   modelName,
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
    // A tap or an `onEvent` listener is an audience too: an open tab holds the
    // child rows the cascade removed, and a tap arrives after the table is
    // built, so this is asked each time and not stored (`FJS-2255`).
    get hears() { return !!(plugins?.hearsDeletes || plugins?.hearsWrites) || tableHasLogWork || hasAudience() },
    // `fks` are this table's key columns and `keys` arrays aligned with them.
    rowsWhere(fks, keys) {
      const out = []
      const cols = fks.map(f => `"${col(f)}"`)
      for (let i = 0; i < keys.length; i += 500) {
        const chunk = keys.slice(i, i + 500)
        const binds = []
        out.push(...readDb.query(`SELECT * FROM "${tableName}" WHERE ${keyIn(cols, chunk, binds)}`).all(...binds))
      }
      return readAll(out)
    },
    async removed(rows) {
      if (plugins?.hasPlugins) await plugins.afterDelete(modelName, rows, ctx)
      if (tableHasLogWork) emitLogs('delete', rows)
      for (const row of rows) fireRowEvent('remove', 'remove', row)
    },
    // A retention sweep deletes this table's rows raw, so it asks what the
    // cascade takes under them before its DELETE does (FJS-2097).
    doomedUnder: rows => cascadeDoomed(readAll(rows)),
    cascadeRemoved: doomed => cascadeRemoved(doomed),
    cascadeHeard: () => cascadeHeard(),
    // `onDelete: SetNull` is an UPDATE SQLite makes inside the same DELETE: the
    // row stays and its key columns are cleared, every one of a composite key
    // (FJS-1505). One line a row, since each row's before and after are its own.
    async nulled(rows, fks) {
      for (const before of rows) {
        const after = { ...before, ...Object.fromEntries(fks.map(f => [f, null])) }
        if (plugins?.hasPlugins) await plugins.afterWrite(modelName, 'update', after, ctx)
        if (tableHasLogWork) emitLogs('update', [after], { before, after })
        fireRowEvent('update', 'update', after)
      }
    },
  })

  // null when no model the cascade can reach has a plugin or a log to tell,
  // which is every app without one, so the walk costs those nothing. Kept per
  // audience: a tap installed later is a reason to walk that the stored false
  // would hide.
  let _cascadeHeard = null
  let _cascadeAudience = false
  function cascadeHeard(from = modelName) {
    const own = from === modelName
    if (own && _cascadeAudience !== hasAudience()) { _cascadeHeard = null; _cascadeAudience = !_cascadeAudience }
    if (own && _cascadeHeard !== null) return _cascadeHeard
    if (own) _cascadeHeard = false
    if (!ctx.cascadeSinkFor) return false
    const seen = new Set([from])
    const queue = [from]
    while (queue.length) {
      for (const rel of Object.values(ctx.shapes[queue.shift()].relations)) {
        if (rel.kind !== 'hasMany' || (rel.onDelete !== 'Cascade' && rel.onDelete !== 'SetNull') || seen.has(rel.targetModel)) continue
        seen.add(rel.targetModel)
        // A SetNull child stays, so nothing under it is reached through it.
        if (rel.onDelete === 'Cascade') queue.push(rel.targetModel)
        if (ctx.cascadeSinkFor(rel.targetModel)?.hears) return own ? (_cascadeHeard = true) : true
      }
    }
    return false
  }

  // Every row the cascade will remove under `rows`, as [sink, rows] per child
  // model and hop, and every row a SetNull will clear, as [sink, rows, fk].
  // Run BEFORE the DELETE, inside its exclusive unit.
  function cascadeDoomed(rows, from = modelName) {
    if (!rows?.length || !cascadeHeard(from)) return null
    const doomed = []
    const nulled = []
    const seen = new Set()
    let frontier = [[from, rows]]
    while (frontier.length) {
      const next = []
      for (const [parent, parentRows] of frontier) {
        for (const rel of Object.values(ctx.shapes[parent].relations)) {
          const clears = rel.onDelete === 'SetNull'
          if (rel.kind !== 'hasMany' || (rel.onDelete !== 'Cascade' && !clears)) continue
          const sink = ctx.cascadeSinkFor(rel.targetModel)
          if (!sink) continue
          const keys = tuplesOf(parentRows, rel.referencedKeys)
          if (!keys.length) continue
          if (clears) {
            if (sink.hears) nulled.push([sink, sink.rowsWhere(rel.foreignKeys, keys), rel.foreignKeys, rel.targetModel])
            continue
          }
          // A self-relation or a diamond reaches a row twice; SQLite removes it once.
          const found = sink.rowsWhere(rel.foreignKeys, keys).filter(r => {
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
    // A row the same DELETE removes is not also updated.
    if (nulled.length) {
      const gone = new Set(seen)
      const own = ctx.cascadeSinkFor(from)
      for (const r of rows) gone.add(`${from}\0${r[own.idField]}`)
      for (const [sink, found, fk, model] of nulled) {
        const kept = found.filter(r => !gone.has(`${model}\0${r[sink.idField]}`))
        if (kept.length) doomed.push([sink, kept, fk])
      }
    }
    return doomed.length ? doomed : null
  }

  // The rows a soft cascade's @hardDelete child loses, and what those cascade
  // to, as cascadeDoomed answers them. Run BEFORE the child's DELETE.
  function hardChildDoomed(childModel, foreignKeys, keys) {
    const sink = ctx.cascadeSinkFor?.(childModel)
    if (!sink || !(sink.hears || cascadeHeard(childModel))) return null
    const rows = sink.rowsWhere(foreignKeys, keys)
    return rows.length ? [[sink, rows], ...(cascadeDoomed(rows, childModel) ?? [])] : null
  }

  async function cascadeRemoved(doomed) {
    if (doomed) for (const [sink, rows, fk] of doomed) await (fk ? sink.nulled(rows, fk) : sink.removed(rows))
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
    const ext = shape.model.attributes?.find(a => a.kind === 'extensible')
    return ext?.max ? `${ext.column}Slots` : null
  })()
  // Every stage below shapes the row `read`/`readAll` cloned at the top, so a
  // row a caller keeps is never written through.
  const _dropMirror = (r) => {
    if (_extMirror && r && _extMirror in r) delete r[_extMirror]
    return r
  }
  const _hasJson     = jsonFields.size > 0
  const _hasBool     = boolFields.size > 0
  const _hasComputed = computedFields.size > 0

  // ── @from deserialization ─────────────────────────────────────────────────
  // last/first return JSON strings from json_object() → parse to object
  // exists returns 0/1 integer → coerce to boolean
  // `hidden` is gatedFromFields' answer for this read: each is read as null.
  function deserializeFromFields(out, hidden = null) {
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
    if (!_hasFrom || row[idField] == null) return row
    const cols = _fromEntries.map(([n, { subquerySql }]) => `${subquerySql} AS "${n}"`).join(', ')
    const vals = readDb
      .query(`SELECT ${cols} FROM "${tableName}" WHERE "${idField}" = ?`)
      .get(row[idField])
    return vals ? Object.assign(row, vals) : row
  }

  // A hasMany child lands AFTER the parent's INSERT/UPDATE, so the row the unit
  // read back counted none of them: `orderCount` answered 0 where a re-read
  // answers 2, and a @computed over it inherits the stale value. The row is
  // shaped again once the children are in — from the statement's RETURNING, or
  // from the table when the statement carried none (an update answers its
  // prefetched row).
  function rehydrateAfterChildren(outcome) {
    if (!_hasFrom || !outcome.row) return outcome
    const raw = outcome.rows?.[0]
      ?? readDb.query(`SELECT * FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(idField)} = ?`).get(outcome.row[idField])
    return raw ? { ...outcome, row: read(raw, { mode: 'single', hydrateFrom: true }) } : outcome
  }

  // Which computed fields this read should run. `selectedFields` is the
  // caller's select and answers it on every path that has one; `computedFields`
  // is for a path that builds its own SELECT and must not also opt into the
  // field-policy meaning of `selectedFields` (findManyCursor, search).
  function computedWanted(opts) {
    return opts.computedFields ?? opts.selectedFields ?? null
  }

  // The JSON-parse and boolean-coerce pass, shared by read/readAll. It writes
  // into `r`, which the caller has already cloned.
  function shapeScalars(r) {
    if (_hasJson) {
      for (const field of jsonFields) {
        if (field in r && typeof r[field] === 'string') {
          try { r[field] = JSON.parse(r[field]) } catch {}
        }
      }
    }
    if (_hasBool) {
      for (const field of boolFields) {
        if (field in r && r[field] !== null) r[field] = r[field] === 1 || r[field] === true
      }
    }
    return r
  }

  // A row is cloned once, here, and every stage after writes into the clone.
  // A stage that spread its own copy made a plain read 0.17 µs a row and a
  // Json + Boolean + @computed + @omit one 0.40 (`FJS-3001`).
  function read(row, opts = {}) {
    if (!row) return null
    const r = { ...row }
    if (!_hasJson && !_hasBool && !_hasComputed && !hasFieldPolicy && !_hasFrom) return _dropMirror(r)
    if (opts.hydrateFrom) hydrateFromFields(r)
    // Row references resolve before applyComputed below, so a @computed field
    // over `row.lastOrder.amount` still sees a row rather than its id.
    if (_hasJson || _hasBool) shapeScalars(r)
    if (_hasFrom) {
      deserializeFromFields(r, gatedFromFields(_tableFrom, ctx))
      if (_hasRowRef) resolveFromRowRefs(readDb, [r], _tableFrom, ctx)
    }
    if (_hasComputed) applyComputed(r, modelName, computedFns, ctx, computedWanted(opts))
    if (hasFieldPolicy) applyFieldPolicy(r, opts)
    return _dropMirror(r)
  }
  function readAll(rows, opts = {}) {
    // Fast path — no transforms needed, return rows as-is
    if (!_hasJson && !_hasBool && !_hasComputed && !hasFieldPolicy && !_hasFrom) return _extMirror ? rows.map(r => _dropMirror({ ...r })) : rows
    const wanted = computedWanted(opts)
    const hidden = _hasFrom ? gatedFromFields(_tableFrom, ctx) : null
    const shapeRow = (r) => {
      if (_hasComputed) applyComputed(r, modelName, computedFns, ctx, wanted)
      if (hasFieldPolicy) applyFieldPolicy(r, opts)
      return _dropMirror(r)
    }
    // Two passes when a row reference is in play: every row's id is resolved in
    // one query, then the per-row transforms run. One pass would be a query per
    // row, and applyComputed would run before the row it reads exists.
    if (_hasRowRef) {
      const staged = rows.map(r => deserializeFromFields(shapeScalars({ ...r }), hidden))
      resolveFromRowRefs(readDb, staged, _tableFrom, ctx)
      return staged.map(shapeRow)
    }
    return rows.map(row => {
      const r = { ...row }
      if (_hasJson || _hasBool) shapeScalars(r)
      if (_hasFrom) deserializeFromFields(r, hidden)
      return shapeRow(r)
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

  const _fieldsByName = new Map(shape.model.fields.map(f => [f.name, f]))
  const _authDefaultOf = new Map(shape.authDefaults.map(d => [d.field, d.authField]))
  const _authFillsNull = new Set(shape.authDefaults.filter(d => d.fillsNull).map(d => d.field))
  const NUMERIC_TYPES = new Set(['Int', 'Float', 'BigInt', 'Decimal'])

  // On a create: does this value leave the column holding what omitting the key
  // would have? Only a literal default is comparable; anything computed is not.
  function storesWhatOmissionStores(key, value) {
    const field = _fieldsByName.get(key)
    if (!field?.attributes?.some(a => a.kind === 'default')) return value === null
    const def = typeMemberDefault(field)
    return !!def && value === def.value
  }

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
      if (Object.hasOwn(val, MERGE_OP)) {
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

        if (mf.attributes.some(a => a.kind === 'type' && a.array))
          refuseOp(key, `${JSON.stringify(MERGE_OP)} merges into a document and ${key} is Json @type(${mf.attributes.find(a => a.kind === 'type').name}[]), a list that json_patch replaces whole. State the list itself`)

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

  // ── @allow(write, …) on a FIELD, compiled into the SET ─────────────────────
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
      modelName, exprs, 'update', ctx)
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

  const {
    _extensible, _extDeclarations, _extTenantCol, extTenant, extScope,
    allocateExtSlot, mirrorExtSlots, remirrorMovedRow,
  } = makeExtensible(shape, ctx, {
    readDb, writeDb, col,
    // Built later by makeWhereRewrite; reached only at call time.
    buildWhereWithEncryption: (...a) => buildWhereWithEncryption(...a),
  })


  const {
    writeData, refuseSystemEntries, applyFieldRefDefaults, applyRanks, rankOnScopeChange,
    rankScopeTouched, refuseRankBulkMove, _ranks, _rankFields, _rankBind,
  } = makeWriteData(shape, ctx, {
    writeDb, T, col, plugins, computedFns, hasFieldPolicy, _hasEnumFields,
    _extensible, _sealSelf, _tableTransitions, _fieldsByName, _authDefaultOf, _authFillsNull,
    allocateExtSlot, mirrorExtSlots, remirrorMovedRow, pathWriteRefusal, requiredFailure, storesWhatOmissionStores,
    keys: _writeKeys,
  })

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
    const rel = ctx.shapes[owner].relations[relName]
    if (!rel) return undefined   // not a relation → normal column

    // The parent side is the OWNER's column; everything aliased `t` is the
    // target's, so the two take different maps.
    const omap = ctx.shapes[owner].columnMap
    const oc   = owner === modelName ? col : (nm) => omap?.[nm] ?? nm
    const tmap = ctx.shapes[rel.targetModel].columnMap
    const tc   = tmap && Object.keys(tmap).length ? (nm) => tmap[nm] ?? nm : (nm) => nm
    const ownQual = tableAlias ? `${tableAlias}.` : `"${tableName}".`
    const t = depth ? `t${depth}` : 't'
    const j = depth ? `j${depth}` : 'j'
    const targetTable = _modelToTable(rel.targetModel)
    const targetSoft  = ctx.shapes[rel.targetModel].softDelete ? ` AND ${t}."${tc('deletedAt')}" IS NULL` : ''

    // Build the inner WHERE against the target table (aliased `t`, `t1`, … by depth).
    // The target's own write transforms apply here; the outer rewrite only
    // knows this model's fields, so `user: { is: { email } }` on a `@lower`
    // email compared the raw spelling and matched nothing (`FJS-1468`).
    const targetTransformed = transformedOf(rel.targetModel)
    // A target's @from and @derived fields are subqueries, not columns, so the
    // alias this level gave the target is what they correlate on.
    const targetFrom = ctx.shapes[rel.targetModel].fromFields
    const targetExprs = Object.keys(targetFrom).length
      ? Object.fromEntries(Object.entries(targetFrom).map(([n, d]) => [n, d.subquerySqlFor(t)]))
      : null
    const innerOf = (w) => {
      if (!w || (typeof w === 'object' && !Object.keys(w).length)) return ''
      if (targetTransformed) w = rewriteTransformedWhere(w, targetTransformed)
      const p = []
      const sql = buildWhere(w, p, targetExprs, t, null,
        (k, v, pp, al) => relationFilterOn(rel.targetModel, depth + 1, k, v, pp, al), ctx.shapes[rel.targetModel].fieldKinds, tmap)
      return { sql, p }
    }

    // Correlated FROM+WHERE that ties the target back to this parent row.
    let corr
    if (rel.kind === 'hasMany') {
      corr = `FROM "${targetTable}" ${t} WHERE ${pairsOn(rel.foreignKeys, `${t}.`, rel.referencedKeys, ownQual, tc, oc)}${targetSoft}`
    } else if (rel.kind === 'manyToMany') {
      corr = `FROM "${rel.joinTable}" ${j} INNER JOIN "${targetTable}" ${t} ON ${t}."${tc(rel.targetPk ?? 'id')}" = ${j}."${rel.targetKey}" WHERE ${j}."${rel.selfKey}" = ${ownQual}"${oc(rel.selfPk ?? 'id')}"${targetSoft}`
    } else { // belongsTo
      corr = `FROM "${targetTable}" ${t} WHERE ${pairsOn(rel.foreignKeys, ownQual, rel.referencedKeys, `${t}.`, oc, tc)}${targetSoft}`
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
  const _filterCheckKeys = _dynamicGlobalFilter && shape.model
    ? globalFilterKeysFor(shape.model, shape.edges)
    : null

  function resolveGlobalFilter() {
    if (!_dynamicGlobalFilter) return _staticGlobalFilter
    const filter = _dynamicGlobalFilter(ctx)
    if (!filter || !_filterCheckKeys) return filter ?? null
    const [bad] = collectWhereKeyProblems(
      filter, _filterCheckKeys.filterable, _filterCheckKeys.computed, _filterCheckKeys.encrypted,
      [], null, _filterCheckKeys.transient, null, '', 0, _filterCheckKeys.opaque,
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
      for (const f of shape.model.fields)
        if (f.type?.optional) _nullableCache.add(f.name)
    }
    return _nullableCache.has(col)
  }

  // A rank orders by (rank, key), whichever way it runs. Two devices that split
  // one gap at the same moment mint one key, and without the key after it the
  // two rows swap between reads; an ORDER BY that already names the key, or
  // never names a rank, is taken as written.
  function withRankTiebreak(orderBy) {
    if (!_ranks.length || !orderBy) return orderBy
    const items = Array.isArray(orderBy) ? orderBy : [orderBy]
    const named = items.flatMap(i => (i && typeof i === 'object' ? Object.keys(i) : []))
    let dir = null
    for (const i of items) for (const k in i ?? {}) if (_rankFields.has(k)) dir = i[k]
    if (dir == null) return orderBy
    const keys = _keyCols().filter(c => !named.includes(c))
    if (!keys.length) return orderBy
    const d = typeof dir === 'object' ? (dir.dir ?? 'asc') : dir
    return [...items, ...keys.map(c => ({ [c]: d }))]
  }

  function _keyCols() {
    if (_keyColsCache) return _keyColsCache
    const model = shape.model
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
    for (const f of shape.model.fields) {
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
  const _stampCols = updatedAtFields(shape.model).map(f => f.name)

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

  // The columns a move's `@stamps` names, written with the same clock as
  // `@updatedAt` so one event carries one instant.
  function moveStampSets(cols) {
    if (!cols.length) return []
    const _at = nowISO(ctx.stampClock ?? ctx.now).replace(/'/g, "''")
    return cols.map(c => `${ident(col(c)).sql} = '${_at}'`)
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
  const _modelDecl = shape.model
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
      localMap[f.name] = typeAttr.array ? { ...typeDecl, list: true } : typeDecl
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
  const {
    expandScopes, buildWhereWithEncryption, whereFragment,
    rewriteExtensibleWhere, rewriteTransformedWhere, rewriteEncryptedWhere,
  } = makeWhereRewrite(shape, ctx, {
    edgeOrRelFilter, col, _hasScopes, _extensible, _extTenantCol, extTenant, extScope,
    _extDeclarations, _transformed, _fromExprMap, _fromExprMapAliased, _typedJsonMap, _pointMap,
  })


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
  const _baseFrag = sqlFragment(_baseSqlWithFrom)
  // Set of @from field names that return JSON objects (need deserialization)
  const _fromObjectFields = _hasFrom
    ? new Set(_fromEntries.filter(([,{isObject}]) => isObject).map(([n]) => n))
    : null
  const _fromBoolFields = _hasFrom
    ? new Set(_fromEntries.filter(([,{isBool}]) => isBool).map(([n]) => n))
    : null
  // The two fast paths below are one precompiled statement each, so they hold
  // only while no read rule but soft delete adds to the where — their SQL
  // carries that one. Which rules add something is READ_RULES' own `narrows`,
  // asked per call (`readNarrowed`), because a plugin's read filter depends on
  // the caller. A client-wide `hasPolicies`/`hasPlugins` here turned both paths
  // off in every model of an app that gated one.
  //
  // findMany({}) on a soft-delete table.
  const _fastFindManySql = softDelete
    ? `${_baseSqlWithFrom} WHERE "${col('deletedAt')}" IS NULL`
    : null

  // Prepared once here only to learn whether the table exists — an @@external
  // one may not at createClient time. Each call fetches the statement from
  // readDb again: wrapDb's LRU finalizes what it evicts, so a statement held in
  // this closure throws 'Statement has finalized' on every call once 500 other
  // shapes have run.
  let _fastFindMany = false
  if (_fastFindManySql) {
    try { readDb.query(_fastFindManySql); _fastFindMany = true }
    catch {}
  }

  // findUnique({ where: { <pk>: value } }) — lookup by id, the most common
  // read an app makes. Not with a field policy or a @from field, whose read
  // the slow path shapes.
  const _pkField = shape.model.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? null
  const _canFastFindUnique = _pkField && !hasFieldPolicy && !_hasFrom
  const _fastFindUniqueSql = _canFastFindUnique
    ? (softDelete
        ? `SELECT ${_starCols()} FROM "${tableName}" WHERE "${col(_pkField)}" = ? AND "${col('deletedAt')}" IS NULL LIMIT 2`
        : `SELECT ${_starCols()} FROM "${tableName}" WHERE "${col(_pkField)}" = ? LIMIT 2`)
    : null
  // Probed and fetched per call for the reasons _fastFindMany is.
  let _fastFindUnique = false
  if (_fastFindUniqueSql) {
    try { readDb.query(_fastFindUniqueSql); _fastFindUnique = true }
    catch {}
  }

  // `verb` is the fold's name for the caller and `args` its own flags; the
  // rules are folded here, after the fast path, because that path is the one
  // statement whose precondition is the RAW where being empty.
  function buildSQL({ verb = 'findMany', where, args, orderBy, limit, offset, parsedSelect, distinct = false, windowSpec = null, withVectors = false } = {}) {
    orderBy = withRankTiebreak(orderBy)
    // ── Ultra-fast path: no where, no order, no limit, live mode, no policy/filters ──
    // `narrows` speaks for a READ, so a write verb's fold is never skipped here.
    if (_fastFindManySql && VERBS[verb] === 'read' && !readNarrowed('softDelete') && !withVectors && !where && !orderBy && limit == null && offset == null && !parsedSelect && !windowSpec && !distinct && sdMode(args) === 'live') {
      return { sql: _fastFindManySql, params: [] }
    }

    // Row-level policy filter — a fragment ANDed after the where below
    const { where: visWhere, policy: policyFrag } = visibleWhere(verb, where, args)
    let exclWhere = visWhere

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
    const { joinClauses, orderParts } = buildRelationOrderBy(orderBy, modelName, ctx.shapes, _modelToTable, _relOrderParams, _pointMap, _vectorMap, _vectorFn(readDb), columnMap)
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
    // A fragment in the SELECT list, so its bind sits where its placeholder is:
    // before the where's, because the statement is assembled in text order and
    // nothing else decides the positional order.
    const _vecSqlFn = _vecPlan ? _vectorFn(readDb) : null
    const distFrag = _vecSqlFn
      ? sqlJoin([
          sqlFragment(`, ${_vecSqlFn}(${needsAlias ? 't.' : ''}`),
          ident(col(_vecPlan.field)),
          sqlFragment(', ?) AS ', [vectorQueryBytes(_vecPlan.near, _vecPlan.dim, _vecPlan.field)]),
          ident(DISTANCE_FIELD),
        ], '')
      : null

    const whereFrag = whereFragment(exclWhere, whereAlias, needsAlias)
    // When JOINs exist, buildRelationOrderBy returns the full ordered list
    // (flat + relation, flat prefixed with `t.`). Don't double-emit flat parts.
    const flatOrderSql = hasJoins ? '' : buildOrderBy(orderBy, _flatOrderParams, columnMap, _pointMap, _vectorMap, _vectorFn(readDb))
    const orderSql = [flatOrderSql, ...orderParts].filter(Boolean).join(', ')
    const orderFrag = orderSql ? sqlFragment(` ORDER BY ${orderSql}`, hasJoins ? _relOrderParams : _flatOrderParams) : null
    // A JOIN brings a second table with its own `id`, so an aliased read names
    // the table each selected column comes from.
    const sqlCols   = needsAlias && parsedSelect?.dbCols?.length
      ? parsedSelect.dbCols.map(c => `t.${quoteIdent(c)}`).join(', ')
      : parsedSelect?.sqlCols ?? '*'
    const distinctKw = distinct ? 'DISTINCT ' : ''
    // A @from subquery correlates to the outer table by name, so an aliased
    // query needs the aliased variant. Emitting the plain one under `t` fails
    // as `no such column: <table>.<pk>`; emitting neither — which is what
    // `SELECT t.*` did — dropped every @from field to undefined, and any
    // @computed field reading one then computed from undefined in silence.
    const fromExpr = n => needsAlias ? fromFields[n].subquerySqlAliased : fromFields[n].subquerySql
    // The SELECT list's text; `null` means the precomputed base statement.
    let selectCols
    if (sqlCols === '*') {
      const allFromCols = needsAlias && _hasFrom
        ? _fromEntries.map(([n]) => `${fromExpr(n)} AS "${n}"`).join(', ')
        : null
      selectCols = needsAlias
        ? `${_starCols('t.', withVectors)}${allFromCols ? `, ${allFromCols}` : ''}`
        : (distinct || distFrag || withVectors
            ? `${_starCols('', withVectors)}${_hasFrom ? `, ${_fromEntries.map(([n, { subquerySql }]) => `${subquerySql} AS "${n}"`).join(', ')}` : ''}`
            : null)
    } else {
      const fromCols = parsedSelect?.requestedFrom?.size
        ? [...parsedSelect.requestedFrom].map(n => `${fromExpr(n)} AS "${n}"`).join(', ')
        : null
      selectCols = fromCols ? `${sqlCols}, ${fromCols}` : sqlCols
    }
    const head = selectCols === null
      ? _baseFrag
      : sqlJoin([sqlFragment(`SELECT ${distinctKw}${selectCols}`), distFrag, sqlFragment(' FROM '), T, needsAlias ? sqlFragment(' t') : null], '')
    // Relation JOINs sit between FROM and WHERE
    const joinsFrag = hasJoins ? sqlFragment(` ${joinClauses.join(' ')}`) : null
    // The caller's where and the policy, one WHERE — and() parenthesizes each
    // when both are present and emits the one alone otherwise.
    const whereAll    = and(whereFrag, policyFrag)
    const whereClause = whereAll ? sqlFragment(` WHERE ${whereAll.sql}`, whereAll.params) : null
    const pageFrag    = pageSql(limit, offset)

    // ── Window functions ──────────────────────────────────────────────────
    // The window columns lead the SELECT list, so their binds lead the
    // statement. SQL evaluates a window over the filtered rows before ORDER BY
    // and LIMIT, so pagination needs no wrapping subquery — and a wrap would
    // repeat the ORDER BY text without its binds, and with joins with `t.`
    // prefixes that do not resolve against the wrapper.
    if (windowSpec) {
      const winParams  = []
      const windowCols = buildWindowCols(windowSpec, winParams, columnMap)
      if (windowCols.length) {
        const windowExpr = windowCols.join(', ')
        const stmt = sqlJoin([head, joinsFrag, whereClause, orderFrag, pageFrag], '')
        return {
          sql:    stmt.sql.replace(/^SELECT (DISTINCT )?/, (_, d) => `SELECT ${d ?? ''}${windowExpr}, `),
          params: [...winParams, ...stmt.params],
        }
      }
    }

    const stmt = sqlJoin([head, joinsFrag, whereClause, orderFrag, pageFrag], '')
    return { sql: stmt.sql, params: stmt.params }
  }

  function parseArgs(select, include, windowNames = null) {
    return parseSelectArg(select, modelName, ctx.shapes, include, computedFns, windowNames)
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
    const rels = shape.selfRelations
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
  // people were writing raw SQL for. Stated as the verb's own args rather than
  // as a case inside the rule: a hard delete's default IS `withDeleted`.
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
  // it reaches a read: only when `asOf` is stated. `asOf` rides with the flags,
  // or a sweep that states an instant deletes at `now` instead and matches
  // nothing — silently, because a delete that removed no rows answers a count.
  function hardDeleteFlags({ withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf }) {
    return { withDeleted: withDeleted || !onlyDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf }
  }

  // ── The read rules, declared once ──────────────────────────────────────────
  //
  // Every verb that reaches a row applies every rule that guards it, in this
  // order, because positional binds make the order the correctness (`FJS-262`,
  // `FJS-216`). `test/verbs-rules.test.ts` is the oracle and is not derived from
  // this table (`FJS-597`).
  //
  // `gate` is the grid's first row and is not here: GatePlugin refuses the CALL
  // in beforeRead/beforeUpdate/beforeDelete, and a where cannot say no.
  //
  // A rule is one of three shapes. `scope` states a where of its own, the app's
  // (`filters:`) or a plugin's (tenancy), and every scope is ANDed beside the
  // caller's where as ONE node, scopes first. `where` rewrites the where in
  // hand with the mode the verb's own args state; each one delegates to the
  // owner of its rule's meaning, which is where a flag the model cannot honor
  // is refused by name. `policy` is a fragment ANDed after everything else,
  // compiled for the op the verb is.
  //
  // `verbs` names the verbs a rule applies to, or '*'. A set here is the grid
  // made data, and a verb a set leaves out is a hole this file can see:
  //   - the app's and the plugins' scopes narrow a READ and never a write,
  //     which is what the grid asserts today;
  //   - `recursive` is findMany's tree walk, and both scopes reach it at every
  //     level: a hidden row ends the walk, so a visible descendant is never
  //     reached by a hidden path (`FJS-2010`);
  //   - `restore` takes no widening flag, so folding the template and window
  //     rules into it would make a removed template or an expired row
  //     unrestorable with no spelling to ask for it.
  const READ_VERBS = Object.freeze(['findMany', 'findFirst', 'findUnique', 'findManyAndCount', 'count', 'exists', 'aggregate', 'groupBy', 'findManyCursor', 'search'])
  const WALKS = Object.freeze([...READ_VERBS, 'recursive'])
  const NOT_RESTORE = Object.freeze([...WALKS, 'update', 'updateMany', 'remove', 'removeMany', 'delete', 'deleteMany'])
  //
  // `narrows` answers whether the rule can add anything to a READ of this
  // model for this flavor — true when unsure. The fast paths and
  // hiddenParents skip the fold on its answer, so a rule added here without
  // one is refused at load rather than skipped by them.
  const READ_RULES = Object.freeze([
    { name: 'globalFilter',  verbs: WALKS,       narrows: () => !!(_staticGlobalFilter || _dynamicGlobalFilter),
      scope: () => resolveGlobalFilter() },
    { name: 'pluginFilters', verbs: WALKS,       narrows: () => !!plugins?.hasPlugins && plugins.getReadFilters(modelName, ctx).length > 0,
      scope: () => plugins?.hasPlugins ? plugins.getReadFilters(modelName, ctx) : null },
    { name: 'softDelete',    verbs: '*',         narrows: () => !!softDelete,
      where: (where, args) => applySdFilter(where, args) },
    { name: 'templates',     verbs: NOT_RESTORE, narrows: () => !!hasTemplates,
      where: (where, args) => applyHtFilter(where, htMode(args)) },
    { name: 'effective',     verbs: NOT_RESTORE, narrows: () => !!effective,
      where: (where, args) => applyEffFilter(where, args) },
    { name: 'policy',        verbs: '*',         narrows: () => !!(ctx.hasPolicies && shape.policy.read),
      policy: (op) => ctx.hasPolicies ? buildPolicyFilter(modelName, op, ctx) : null },
  ])
  for (const rule of READ_RULES) if (typeof rule.narrows !== 'function')
    throw new Error(`READ_RULES.${rule.name} states no narrows — the fast paths and hiddenParents read it`)

  // Whether any read rule but `except` adds to a read of this model.
  function readNarrowed(except = null) {
    for (const rule of READ_RULES) if (rule.name !== except && rule.narrows()) return true
    return false
  }

  // Every verb the fold may be asked for, and the policy op each one is graded
  // as. `upsert` and `upsertMany` are not here: they build no WHERE to fold
  // into, so they refuse by name where a bulk sibling narrows (the grid's `ref`
  // cells) and `upsertMany` carries the update policy into its DO UPDATE on its
  // own. A verb named by no rule's set and by no '*' rule is refused at load;
  // a fold asked for a verb this table does not name is refused by name.
  const VERBS = Object.freeze({
    findMany: 'read', findFirst: 'read', findUnique: 'read', findManyAndCount: 'read', count: 'read', exists: 'read',
    aggregate: 'read', groupBy: 'read', findManyCursor: 'read', search: 'read', recursive: 'read',
    update: 'update', updateMany: 'update', restore: 'update',
    remove: 'delete', removeMany: 'delete', delete: 'delete', deleteMany: 'delete',
  })
  const RULES_FOR = new Map()
  for (const rule of READ_RULES) {
    if (rule.verbs === '*') continue
    for (const v of rule.verbs) if (!(v in VERBS))
      throw new Error(`READ_RULES.${rule.name} names '${v}', which is not a verb VERBS places`)
  }
  for (const verb of Object.keys(VERBS)) {
    const rules = READ_RULES.filter(r => r.verbs === '*' || r.verbs.includes(verb))
    if (!rules.length) throw new Error(`'${verb}' on ${modelName} is folded by no rule in READ_RULES — place it`)
    RULES_FOR.set(verb, rules)
  }

  // The fold: what `verb` may reach, as the rewritten where and the policy
  // fragment that is ANDed after it. The two leave separately because
  // `buildSQL` puts a guard of its own between them.
  function visibleWhere(verb, where, args) {
    const rules = RULES_FOR.get(verb)
    if (!rules) throw new Error(`'${verb}' on ${modelName} is not a verb READ_RULES places — add it to VERBS and to each rule that guards it`)
    let scopes = null
    let policy = null
    for (const rule of rules) {
      if (rule.scope) {
        const s = rule.scope()
        if (s == null) continue
        if (Array.isArray(s)) { if (s.length) scopes = scopes ? scopes.concat(s) : s }
        else scopes = scopes ? [...scopes, s] : [s]
        continue
      }
      if (scopes) { where = scopedWhere(scopes, where); scopes = null }
      if (rule.where) where = rule.where(where, args)
      else policy = rule.policy(VERBS[verb])
    }
    if (scopes) where = scopedWhere(scopes, where)
    return { where, policy }
  }

  // One AND node, scopes first, then the caller's where.
  function scopedWhere(scopes, where) {
    if (where) return { AND: [...scopes, where] }
    return scopes.length === 1 ? scopes[0] : { AND: scopes }
  }

  const {
    extractNestedWrites, refuseBulkNested, processBelongsToNested, processHasManyNested,
  } = makeNestedWrites(shape, ctx, { writeDb, idField, parentRefusal, requireParentGrants, isArchivedParent })

  // ── Write plans ────────────────────────────────────────────────────────────
  //
  // A bulk verb PLANS and `executeWrite` RUNS the plan (IDEAS/litestone-by-
  // construction.md § Step 5). The verb keeps what is its own meaning — the
  // hooks, the stamps, the value sets, the SQL it assembles — and leaves as a
  // value: every field is a fragment, a flag or a plain object, never a
  // closure, so a plan can be read in a test with no SQLite behind it
  // (`[PLAN]`, `test/write-plans.test.ts`). The executor owns, in this order
  // and nowhere else: the lock, the prefetch, the cardinality and exclusion
  // notes, the statement, the error translation, the count, the post-update
  // policy, the hidden-parent move, the soft cascade, the query event, the
  // plugin `afterDelete`, the trail, the cascade sinks and the announcement.
  //
  //   verb        the method's name — the query event and the announcement
  //   op          what the statement does to a row: 'create' | 'update' |
  //               'delete' (DELETE FROM) | 'remove' (a soft-delete stamp)
  //   statements  [{ sql, params, data, one?, seal?, refusal? }] — one for a
  //               where-shaped verb, one per ROW for a batch; `data` is what
  //               the statement wrote, for naming a refused value
  //   count       the COUNT fragment a write with nothing to set answers with,
  //               and no statements
  //   returning   the statement carries RETURNING *
  //   where       the final WHERE (policy and seal folded in), null for a batch
  //   args        what the query event reports
  //   query       the SQL the query event reports — a batch joins its shapes
  //   prefetch    read the affected rows first, for `afterDelete` and the sinks
  //   moves       a hidden-parent refusal thrown only when a matched row MOVES
  //   exclusion   the payload whose exclusion key is noted, or null
  //   post        grade the post-update policy over the returned rows
  //   softCascade { ts } — stamp the cascade's children with the same clock
  //   batch       errors name the row by index (`asBatchRowError`)
  //   logs/system the trail, and the lift it records
  //   announce    { mode, event, operation, where } for `announceBulk`; for a
  //               row result { event, operation } for `fireRowEvent`; null
  //               for a write with nothing to say (`FJS-368`)
  //   result      null for `{ count }`; `{ select, include }` for the one row
  //               the statement reached, read, hydrated, shaped and handed back
  //   bare        run the unit with no lock: one statement with no transaction
  //               open is its own unit (`FJS-1106`), and a transaction found
  //               open at the statement is the defect `FJS-1107` names
  //   refuse      why a single statement reached no row, asked in order — the
  //               move's conflict, the version, the model's own seal, a parent's
  //               seal — each a value the planner decided applies; null for a
  //               write that answers zero rows with zero
  //   before      an update's row as it was, for the trail's snapshot
  //   transition  the move this write is, carried to the row event, the
  //               transition event and the trail
  //
  // Each verb's own order inside the lock is kept — every step there is a read
  // until the statement runs — and three things the verbs did differently are
  // now the same: a hard `removeMany` notes the parents its rows leave before
  // the DELETE, as `deleteMany` always did; a soft `removeMany` reports a
  // query event and translates a constraint, as every other write does; and
  // the prefetch is read under the lock rather than ahead of it.

  // The words every statement shares, allocated once: a fragment is read, never
  // written, so one `' WHERE '` serves every join. `join` reads `sql` and
  // `params` off whatever it is handed, so a plan's plain `where` joins as is.
  const KW = {
    update: sqlFragment('UPDATE '), del: sqlFragment('DELETE FROM '), select: sqlFragment('SELECT * FROM '),
    count: sqlFragment('SELECT COUNT(*) AS n FROM '), set: sqlFragment(' SET '), where: sqlFragment(' WHERE '),
    returning: sqlFragment(' RETURNING *'),
  }
  // The prefetch SELECT carries every @from: a row result read ahead of a
  // DELETE has no outer row left to correlate to afterwards (`FJS-223`).
  const _selectRow = _hasFrom ? sqlFragment(`SELECT *, ${fromSelectExpr(fromFields)} FROM `) : KW.select
  const _deletedAtSet = softDelete ? `${ident(col('deletedAt')).sql} = ?` : null
  // The INSERT text per column shape, kept across calls: a batch of one shape
  // is the ordinary case and re-quoting its column list per call was a fifth
  // of what createMany cost. Bounded, because a caller's key set is its own.
  const _insertSqlByShape = new Map()

  // What each op does to the parents its rows name: a delete leaves them, an
  // update leaves one and joins another, a create only joins.
  const WRITE_NOTES = {
    create: { before: false, after: 'row'  },
    update: { before: true,  after: 'rows' },
    delete: { before: true,  after: null   },
    remove: { before: true,  after: null   },
    // One statement that creates or updates, and cannot say which: the row it
    // lands names its parents, the row it replaces named the same key.
    upsert: { before: false, after: 'row'  },
  }
  // An upsert is announced and filed as `update`, the collection form's choice
  // (see upsertMany): to a list every row named now exists with new values.
  const LOG_OP = { create: 'create', update: 'update', delete: 'delete', remove: 'delete', upsert: 'update' }
  // The trail's snapshots for a row result, by op: a delete's `before` is the
  // row, a soft remove's is the row with its stamp cleared, an update's is the
  // row the planner read first; a create has none. A remove keeps an `after`
  // (the stamped row) because it is what tells a trash from a purge: both file
  // as `delete`, and only the purge leaves no row behind. A bulk write records
  // which rows and what operation, never their contents.
  const LOG_BEFORE = { create: null, update: 'prefetch', delete: 'row', remove: 'undeleted', upsert: null }
  const LOG_AFTER  = { create: true, update: true, delete: false, remove: true, upsert: true }

  // The refusal a statement's op produces, by op rather than by verb: a DELETE
  // refused by a child is read back by its WHERE, every other refusal names
  // the value it carried.
  function writeRefusal(plan, err, st) {
    return plan.op === 'delete'
      ? refusedDelete(err, plan.where?.sql ?? null, plan.where?.params ?? [])
      : asConstraintError(err, st.data, plan.op === 'update' && plan.where ? reachedRow(plan.where) : null)
  }

  // The first row an UPDATE's WHERE reaches, as the named columns by field name.
  // The statement failed and rolled back, so unwritten columns are still the
  // row's own.
  function reachedRow(where) {
    return (cols) => {
      const q = sqlJoin([
        sqlFragment('SELECT '), sqlJoin(cols.map(c => ident(col(c))), ', '),
        sqlFragment(' FROM '), T, KW.where, where, sqlFragment(' LIMIT 1'),
      ], '')
      const got = readDb.query(q.sql).get(...q.params)
      if (!got) return null
      const out = {}
      for (const c of cols) out[c] = got[col(c)]
      return out
    }
  }

  function selectWhere(where) {
    return sqlJoin([_selectRow, T, where && KW.where, where], '')
  }

  // The sentence the schema authored for the update policy that excluded the
  // row `where` reaches, or undefined when the rule states none or cannot be
  // graded here. A refusal for the author's reason must reach the caller as
  // that reason (FJS-3129).
  function authoredUpdateRefusal(where) {
    try {
      const q = selectWhere(where)
      const raw = readDb.query(q.sql).get(...q.params)
      if (!raw) return undefined
      const v = policyVerdict(modelName, read(raw, { mode: 'single' }), ctx, 'update')
      return v.ok ? undefined : v.message
    } catch { return undefined }
  }

  // Why a single statement reached no row, in the order the WHERE narrowed:
  // the caller's where, the policy, the move's from-state, the version, the
  // seals. Each conjunct only narrows, so the diagnosis is these reads. Every
  // one reads the row UNSCOPED to name why; a row outside the caller's read
  // scope left before the statement (`NOT_VISIBLE`).
  function refuseNoRow(r) {
    if (!r) return
    const readState = (field) => readDb.query(
      sqlJoin([sqlFragment('SELECT '), ident(col(field)), sqlFragment(' AS v FROM '), T, KW.where, r.where], '').sql,
    ).get(...r.where.params)
    const versionMoved = () => {
      if (!r.version) return
      const cur = readState(r.version.field)
      if (cur && cur.v !== r.version.expect)
        throw new VersionConflictError(modelName, r.version.field, r.version.expect, cur.v)
    }
    const sealed = () => {
      if (r.sealSelf?.length) throwIfSealedSelf(r.sealSelf, r.seal.sql, r.seal.params)
      if (r.seal) throwIfSealed(r.seal.sql, r.seal.params, r.seal.op)
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
    if (r.transition) {
      const t = r.transition
      const cur = readState(t.field)
      if (t.policy && cur && cur.v === t.from) throw new AccessDeniedError(
        authoredUpdateRefusal(r.where) ?? `"${modelName}.${t.transitionName}" was refused by an @@allow/@@deny policy on update`,
        { model: modelName, operation: 'update' },
      )
      // Still at `from` means no writer moved it, so the refusal is one of
      // the other conjuncts — and a conflict reading "expected 'sent', the
      // row is at 'sent'" would contradict itself. The seal and the version
      // ride the same WHERE and have their own answers.
      if (cur && cur.v === t.from) { versionMoved(); sealed() }
      throw new TransitionConflictError(tableName, t.field, t.from, t.to,
        { actual: cur ? cur.v : undefined, move: t.transitionName })
    }
    versionMoved()
    sealed()
  }

  // The statement and everything that must sit in the same unit with it,
  // synchronous: this is the body `wrapExclusive` runs. The prefetch is read
  // here rather than ahead of the lock, so the rows `afterDelete` is told
  // about are the rows the statement reached.
  function writeUnit(plan) {
    const { returning, where, batch } = plan
    // A plan that stamped a clock while it was planned reads it again now the
    // lock is held (FJS-2153).
    const statements = plan.restamp ? plan.restamp() : plan.statements
    const total  = statements.length
    // A plan that chose to run without a transaction and finds one open now
    // would join it and go with its rollback, which is the defect `FJS-638`
    // closed — so it says so rather than writing.
    if (plan.bare && total && tx.state.depth !== 0) throw new Error(
      `[litestone] ${plan.verb} on "${modelName}" decided to run as its own statement and a transaction opened ` +
      `before it wrote — something in ${plan.verb}() now yields ahead of the write. This is a defect in litestone (FJS-1107).`)
    // Nothing to run. The precondition a plan states is still asked — a
    // caller naming a stale version is told so whether or not they were
    // writing — and then the rows the where names are answered: a count, or
    // the one row read back through the write's own policy.
    if (!total) {
      refuseNoRow(plan.refuse)
      const got = readDb.query(plan.count.sql).get(...plan.count.params)
      const row = plan.result ? read(got, { mode: 'single', hydrateFrom: true }) : null
      return { rows: [], count: plan.result ? (row ? 1 : 0) : got?.n ?? 0, row, image: trailImage(got, row), doomed: null, affected: [], duration: 0 }
    }
    if (plan.op === 'delete') refuseLockedCascade(where)
    const notes  = WRITE_NOTES[plan.op]
    const wSql   = where?.sql ?? null
    const wBinds = where?.params ?? []
    const _nt = needsTiming()
    const t0 = _nt ? performance.now() : 0
    // Prefetch affected rows before SQL so afterDelete and the cascade sinks
    // get them. Only done when something is listening — avoids the SELECT
    // cost otherwise — or when the prefetch IS the row result, because the
    // statement carries no RETURNING.
    const wantRow = !!plan.result && !returning && plan.prefetch
    // A plugin hears these rows only by answering a delete — the gate is
    // installed on every gated app and answers none (FJS-2293).
    const hearsOwn = !!(plan.prefetch && plugins?.hearsDeletes)
    const hears = hearsOwn || (plan.prefetch && cascadeHeard())
    const sel = hears || wantRow ? selectWhere(where) : null
    const readOwn = hearsOwn || wantRow
    const affectedRaw = sel && readOwn ? readDb.query(sel.sql).all(...sel.params) : []
    const affected = affectedRaw.length ? readAll(affectedRaw) : affectedRaw
    let rows = returning ? [] : null
    let count = 0
    let doomed = null
    // The roots of a soft cascade are read before anything is stamped, and
    // stamped before the cascade: under a self-relation a root can be another
    // root's child, and stamped by the cascade first it would fall out of the
    // count and the trail. They are read through the stamp's own filter,
    // policy included: a row the policy refused keeps its children
    // (`FJS-1728`).
    let rootRows = null
    if (plan.softCascade && softDeleteCascade && _cascadeTargets().length > 0) {
      const live = sqlFragment(`${ident(col('deletedAt')).sql} IS NULL`)
      const w    = where ? sqlJoin([sqlFragment('('), where, sqlFragment(') AND '), live], '') : live
      const q    = sqlJoin([KW.select, T, KW.where, w], '')
      rootRows = readDb.query(q.sql).all(...q.params)
    }
    // The parents these rows name now — a where names rows only the database
    // knows, and only before the statement runs.
    if (notes.before) noteCardinalityBySql(wSql, wBinds)
    if (plan.exclusion) { noteExclusionBySql(wSql, wBinds, plan.exclusion) }
    const moves = plan.moves ? movesOnto(plan.moves, wSql, wBinds) : false
    if (sel && cascadeHeard()) doomed = cascadeDoomed(readOwn ? affected : readAll(readDb.query(sel.sql).all(...sel.params)))

    // The prefetch that is the row result was read under this same lock by
    // the statement's own WHERE, so it is also the statement's count: no row
    // means the statement reaches none and does not run, one row means one.
    // A bulk statement's count is read back, because the count is its answer.
    const settled = wantRow ? affected.length : null
    // A batch of one shape is one prepared statement, looked up once: the
    // cache under `query()` is an LRU and every hit re-links its entry.
    let lastSql = null, stmt = null
    for (let i = 0; i < (settled === 0 ? 0 : total); i++) {
      const st = statements[i]
      // A batch is all-or-nothing: a row refused before its statement is
      // named the same way a row a constraint refused is.
      if (st.refusal) throw batch ? asBatchRowError(st.refusal, i, total, st.data) : st.refusal
      if (st.sql !== lastSql) { stmt = writeDb.query(st.sql); lastSql = st.sql }
      let got = null
      try {
        if (returning) got = stmt.all(...st.params)
        else stmt.run(...st.params)
      } catch (e) {
        const err = writeRefusal(plan, e, st)
        throw batch ? asBatchRowError(err, i, total, st.data) : err
      }
      // A statement that lands one row by construction is not asked; a seal
      // guard turns VALUES into SELECT … WHERE, which may land none.
      const n = got ? got.length : settled ?? (st.one && !st.seal ? 1 : rowsChanged(writeDb))
      if (st.seal && !n) {
        const refusal = sealRefusal(st.seal.parents, 'create')
        if (refusal) throw batch ? asBatchRowError(refusal, i, total, st.data) : refusal
      }
      if (got) for (const r of got) rows.push(r)
      count += n
      if (notes.after === 'row') { noteCardinality(st.data); noteExclusion(st.data) }
    }
    // Thrown only when a row was reached, as SQLite's own refusal is; the unit rolls back.
    if (count && moves) throw plan.moves
    // A row result is read once here — the post-update rule, the notes, the
    // trail and the caller all take the same row. A statement with no
    // RETURNING answers the prefetch, or nothing.
    let row = null, image = null
    if (plan.result) {
      row = rows?.length ? read(rows[0], { mode: 'single', hydrateFrom: true }) : wantRow ? affected[0] ?? null : null
      image = trailImage(rows?.length ? rows[0] : wantRow ? affectedRaw[0] : null, row)
      // The throw is the rollback: the refused write is never visible.
      if (plan.post && row) checkPostUpdatePolicy(modelName, row, ctx)
    }
    // One refused row refuses the batch: the throw rolls the unit back.
    else if (plan.post) for (const r of rows) checkPostUpdatePolicy(modelName, read(r, { mode: 'single', hydrateFrom: true }), ctx)
    if (notes.after === 'rows') {
      if (row) noteCardinality(row)
      else if (rows) for (const r of rows) noteCardinality(read(r))
      else noteCardinalityBySql(wSql, wBinds)
    }
    if (rootRows?.length) { doomed = []; cascadeSoftRemove(rootRows, plan.softCascade.ts, doomed) }
    return { rows, count, row, image, doomed, affected, duration: _nt ? performance.now() - t0 : 0 }
  }

  // The lock (`FJS-638`): a bulk write run bare joins whatever transaction is
  // open and is lost on its rollback. A child that refused the delete is
  // named for the caller once the unit has let go.
  function runWrite(plan) {
    return tx.wrapExclusive(() => writeUnit(plan)).catch(async e => { throw await nameBlockerForCaller(e) })
  }

  // The data each statement bound, for a create or an update — what a field
  // log asks to tell a write of the field from a write of its row. Null where
  // a statement carries none, so the trail over-logs rather than drops.
  function writtenOf(plan) {
    if (plan.op !== 'create' && plan.op !== 'update') return null
    return plan.statements.every(s => s.data) ? plan.statements.map(s => s.data) : null
  }

  // What the write tells the world, after its unit has committed. A row
  // result is shaped here — includes, then the caller's select — and the
  // shaped row is what the event and the plugins get; the trail gets the row.
  // `select: false` still means *do not hand me the row*, and the announcement
  // keeps the row because it HAS one: `null` there means the RETURNING was
  // skipped, which is a different fact.
  async function finishWrite(plan, { rows, count, row, image, doomed, affected, duration }) {
    fireQuery({ operation: plan.verb, args: plan.args, sql: plan.query.sql, params: plan.query.params, duration, rowCount: count })
    if (plan.result) {
      // No row reached is three different things, and the plan says which are
      // worth telling apart; the rest answer null, the documented contract.
      // Asked after the unit has let go: every read in the ladder is a
      // diagnosis of a statement that changed nothing.
      if (!count) { refuseNoRow(plan.refuse); return null }
      const { select, include } = plan.result
      const ps = parseArgs(select === false ? null : select, include)
      // withIncludes writes the relation onto `row`, and with no protected
      // column the trail's image IS that object: a relation read for the
      // caller would land in the audit after-image (FJS-2892).
      if (row && image === row && plan.logs && (ps || include)) image = { ...row }
      if (row && (ps || include)) withIncludes([row], ps, include)
      const final = row ? finalizeOne(row, ps) : null
      if (plan.announce) {
        const name = plan.transition?.transitionName ?? null
        fireRowEvent(plan.announce.event, plan.announce.operation, final, name, plan.heard)
        emitTransitionEvent(plan.transition, row)
        if (plugins?.hasPlugins) await plugins.afterWrite(modelName, LOG_OP[plan.op], final, ctx)
        if (affected.length) await plugins.afterDelete(modelName, affected, ctx)
        // The move by name, and not only for an announced one: an abandon and a
        // cancel write the same before and after, so a SYSTEM-scoped move that
        // is not announced is exactly the one the trail must still tell apart.
        if (plan.logs && row) {
          const b = LOG_BEFORE[plan.op]
          emitLogs(LOG_OP[plan.op], [row], {
            before: b === 'prefetch' ? plan.before : b === 'row' ? image : b === 'undeleted' ? { ...image, deletedAt: null } : null,
            after: LOG_AFTER[plan.op] ? image : null, transition: name, system: plan.system, written: writtenOf(plan),
          })
        }
      }
      if (doomed) await cascadeRemoved(doomed)
      if (select === false || !final) return null
      // The caller's row is resolved like a read (FJS-D1324), on a copy: the
      // event, the plugins and the trail above hold `final`, and a stored ref
      // resolved in place would be the URL they are told.
      if (!plugins?.hasPlugins) return final
      const out = { ...final }
      await plugins.shapeWriteResult(modelName, [out], ctx, { select })
      return out
    }
    if (affected.length) await plugins.afterDelete(modelName, affected, ctx)
    // Row by row, as the single-row verbs are: a copy a plugin derives from
    // these rows goes stale and fails open when a bulk write is not heard
    // (FJS-1725). A delete is heard by afterDelete above.
    if (rows?.length && (plan.op === 'create' || plan.op === 'update' || plan.op === 'remove') && plugins?.hearsWrites) {
      for (const r of rows) await plugins.afterWrite(modelName, LOG_OP[plan.op], read(r, { mode: 'single', hydrateFrom: true }), ctx)
    }
    if (plan.logs && rows?.length) emitLogs(LOG_OP[plan.op], rows, { system: plan.system, written: writtenOf(plan) })
    if (doomed) await cascadeRemoved(doomed)
    if (plan.announce) announceBulk({ ...plan.announce, count, rows })
    return { count }
  }

  function executeWrite(plan) {
    if (plan.bare) return finishWrite(plan, writeUnit(plan))
    return runWrite(plan).then(outcome => finishWrite(plan, outcome))
  }

  const frag = f => f ? { sql: f.sql, params: f.params } : null

  // The INSERT for one column shape, from the cache. The seal guard turns
  // VALUES into SELECT … WHERE, and the predicate is the same for every row of
  // the model, so it belongs in the shared statement. No column at all —
  // every field optional and none supplied, or all stripped by @allow write
  // policies — is DEFAULT VALUES, which takes no guard.
  function insertSql(cols, needRows) {
    // '\x00' as an ESCAPE, never a raw NUL byte in the source: a literal NUL
    // makes grep classify this file as binary and skip it silently, which
    // hides every match in the largest file in the package.
    const key = (needRows ? '\x01' : '') + cols.join('\x00')
    let sql = _insertSqlByShape.get(key)
    if (sql) return sql
    const ph = cols.map(() => '?').join(', ')
    sql = sqlJoin([
      sqlFragment('INSERT INTO '), T,
      cols.length
        ? sqlJoin([
            sqlFragment(' ('), sqlJoin(cols.map(c => ident(col(c))), ', '), sqlFragment(') '),
            _sealInsertSql ? sqlFragment(`SELECT ${ph} WHERE ${_sealInsertSql}`) : sqlFragment(`VALUES (${ph})`),
          ], '')
        : sqlFragment(' DEFAULT VALUES'),
      needRows && KW.returning,
    ], '').sql
    if (_insertSqlByShape.size >= 64) _insertSqlByShape.clear()
    _insertSqlByShape.set(key, sql)
    return sql
  }

  // The one INSERT a create is. `data` is the row as the verb has it once the
  // stamps and the nested split have had their say; the statement's seal
  // guard may land no row, and the hidden-parent refusal is thrown by the
  // executor ahead of the statement, after `writeData` has named any field.
  function createPlan(data, { hasNested, edgeWrites, select, include, system, stamped, refusal, bare }) {
    if (shape.selfRelations.length)
      assertNoParentCycle([data?.[shape.selfRelations[0].referencedField]], data)
    const row  = writeData(data, { requireAll: true, system, stamped, creating: true })
    const cols = Object.keys(row)
    // A hasMany create needs the parent's id, which only RETURNING answers —
    // so skipping it here is not a saving, it is the children going missing.
    // A logged model takes it on every verb: the trail names the row by id.
    const returning = tableHasLogWork || !(select === false && !hasNested && !edgeWrites.length)
    const seal   = cols.length ? sealInsertGuard(row) : null
    const params = new Array(cols.length)
    for (let c = 0; c < cols.length; c++) params[c] = row[cols[c]] ?? null
    if (seal) params.push(...seal.params)
    const sql = insertSql(cols, returning)
    return {
      verb: 'create', op: 'create', statements: [{ sql, params, data: row, one: true, seal, refusal: refusal ?? null }], count: null,
      returning, where: null, args: { data, include, select }, query: { sql, params }, prefetch: false,
      moves: null, exclusion: null, post: false, softCascade: null, batch: false, logs: tableHasLogWork, system,
      announce: { event: 'create', operation: 'create' }, result: { select, include }, bare,
      refuse: null, before: null, transition: null,
    }
  }

  async function planUpdateMany({ where, data, system, announce, withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf } = {}) {
    refuseBulkNested([data], 'updateMany')
    const _umMove = _bulkTransitionField(data, 'updateMany')
    if (_umMove) throw new BulkTransitionError(modelName, _umMove, 'updateMany')
    refuseSoftDeleteWrite(data, 'updateMany')
    refuseRankBulkMove(data, 'updateMany')
    const { mode: _umMode, wantRows: _umWantRows } = announceFor(announce)
    refuseSystemEntries(system, ['update'])
    // After the gate: a caller it refuses is told so, not what the set holds.
    if (plugins?.hasPlugins) await plugins.beforeUpdate(modelName, { where, data, system }, ctx)
    await enforceValueSets(modelName, [data], ctx, { where })
    // Same stamp update() runs. Missing it here was worse than missing it
    // anywhere else: @updatedAt is a SQL trigger, so the timestamp moved while
    // the identity beside it stayed at whoever wrote last through update() —
    // a row reading "just edited by Bob" when Ann edited it.
    const stamped = new Set()
    data = stampFromAuth(data, shape.updatedBy, ctx.auth, stamped)
    const [_umHidden] = await hiddenParents([data], [stamped], system)
    // @version bumps here but is never required: a where clause matching many
    // rows matches many versions, so there is no single value to compare
    // against. Bumping is the part that matters — without it a bulk write
    // would leave every open editor's version looking current.
    const _umVersion = shape.version
    if (_umVersion && data && _umVersion in data) { data = { ...data }; delete data[_umVersion] }
    const { data: _umValues, ops: _umOps } = extractWriteOps(data)
    const row       = writeData(_umValues, { system, fieldWrite: 'sql', stamped, where })
    // The SET list is one fragment and the WHERE another; the statement is
    // their text in order and so are its binds, which is what lets the
    // empty-SET case below be handled where it belongs.
    const _umSetP = []
    const _umSetTexts = [
      ...Object.keys(row).map(c => setFragment(c, row[c], _umSetP)),
      ..._umOps.map(o => setFragmentExpr(o.col, o.expr, o.params, _umSetP)),
    ]
    const _umV    = _umVersion ? ident(col(_umVersion)) : null
    const setFrag = sqlJoin([
      sqlFragment(_umSetTexts.join(', '), _umSetP),
      _umV ? sqlJoin([_umV, sqlFragment(' = '), _umV, sqlFragment(' + 1')], '') : null,
    ], ', ')
    const _umVis      = visibleWhere('updateMany', where, { withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf })
    const _umWhere0   = and(whereFragment(_umVis.where), _umVis.policy)
    const _umSeal     = sealWhereClause(_umWhere0?.sql ?? null, _umWhere0?.params ?? [])
    const _umSelf     = sealSelfClause(data, _umSeal.sql, _umSeal.params)
    const finalWhere  = _umSelf.sql ? { sql: _umSelf.sql, params: _umSelf.params } : null
    const _umWhereClause = finalWhere ? sqlJoin([KW.where, _umSelf], '') : null
    const announceAs = { mode: _umMode, event: 'update', operation: 'updateMany', where }

    // No columns left to set. `UPDATE "t" SET  WHERE …` is a SQL syntax error,
    // and the payload that lands here is an ordinary form post whose fields no
    // longer match the model — stripping unknown keys is the mass-assignment
    // protection doing its job, so this is reachable without any mistake at the
    // call site. `update` answers the unchanged row; the bulk analogue is the
    // count of rows the where matched, having written nothing to them.
    if (!setFrag.sql) {
      const _c = frag(sqlJoin([KW.count, T, _umWhereClause], ''))
      return {
        verb: 'updateMany', op: 'update', statements: [], count: _c, returning: false, where: finalWhere,
        args: { where, data }, query: _c, prefetch: false, moves: null, exclusion: null, post: false,
        softCascade: null, batch: false, logs: tableHasLogWork, system, announce: null,
        result: null, bare: true, refuse: null, before: null, transition: null,
      }
    }
    // Stamped after the empty-payload return above, for the same reason
    // update() stamps only a statement that had something else to say.
    const _umSetAll = sqlJoin([setFrag, ...stampSets(Object.keys(row)).map(t => sqlFragment(t))], ', ')
    // A logged model takes RETURNING so the trail can name the rows it changed.
    // Still one statement — bulk ops record WHICH rows and WHAT operation, never
    // their contents (same shape as createMany; see emitLogs).
    // The WHERE grades each row as it was; the post-update rule reads the row
    // as it is now, which only RETURNING carries (FJS-1713).
    const _umPost = ctx.hasPolicies && !!shape.policy['postUpdate']
    const _umNeedRows = tableHasLogWork || _umWantRows || _umPost || !!plugins?.hearsWrites
    const _umStmt = frag(sqlJoin([KW.update, T, KW.set, _umSetAll, _umWhereClause, _umNeedRows && KW.returning], ''))
    return {
      verb: 'updateMany', op: 'update', statements: [{ ..._umStmt, data: row }], count: null,
      returning: _umNeedRows, where: finalWhere, args: { where, data }, query: _umStmt, prefetch: false,
      moves: _umHidden ?? null, exclusion: exclTouched(data) ? data : null, post: _umPost,
      softCascade: null, batch: false, logs: tableHasLogWork, system, announce: announceAs,
      result: null, bare: false, refuse: null, before: null, transition: null,
    }
  }

  // One plan for a delete by WHERE, whichever verb asked: the prefetch, the
  // sinks and the child-refusal are the statement's, not the verb's. A single
  // verb hands back the row and asks the seal why there was none; a bulk verb
  // answers a count and asks nothing.
  function deletePlan(verb, where, vis, mode, needRows, result = null) {
    const where0 = and(whereFragment(vis.where), vis.policy)
    const sealed = sealWhereClause(where0?.sql ?? null, where0?.params ?? [])
    const final  = sealed.sql ? { sql: sealed.sql, params: sealed.params } : null
    const stmt   = frag(sqlJoin([KW.del, T, final && KW.where, final, needRows && KW.returning], ''))
    return {
      verb, op: 'delete', statements: [{ ...stmt, data: null }], count: null, returning: needRows,
      where: final, args: { where }, query: stmt, prefetch: true, moves: null, exclusion: null, post: false,
      softCascade: null, batch: false, logs: tableHasLogWork, system: null,
      announce: result ? { event: 'remove', operation: verb } : { mode, event: 'remove', operation: verb, where },
      result, bare: false, before: null, transition: null,
      refuse: result ? { where: null, transition: null, version: null, sealSelf: null, seal: { ...frag(where0), op: verb } } : null,
    }
  }

  // Real DELETE FROM — bypasses soft delete. where is optional (deletes all if omitted).
  async function planDeleteMany({ where, announce, withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf } = {}) {
    const { mode, wantRows } = announceFor(announce)
    if (plugins?.hasPlugins) await plugins.beforeDelete(modelName, { where }, ctx)
    const vis = visibleWhere('deleteMany', where, hardDeleteFlags({ withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf }))
    return deletePlan('deleteMany', where, vis, mode, tableHasLogWork || wantRows)
  }

  // Bulk version of remove() — same semantics: soft delete on soft-delete tables,
  // real DELETE FROM on hard-delete tables.
  async function planRemoveMany({ where, announce, withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf } = {}) {
    const { mode, wantRows } = announceFor(announce)
    const needRows = tableHasLogWork || wantRows
    if (plugins?.hasPlugins) await plugins.beforeDelete(modelName, { where }, ctx)
    const vis = visibleWhere('removeMany', where, { withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf })
    if (!softDelete) return deletePlan('removeMany', where, vis, mode, needRows)
    // A soft remove is an UPDATE, so afterDelete never hears it; the stamped
    // rows reach onAfterWrite as remove() does.
    const needStamped = needRows || !!plugins?.hearsWrites

    const where0 = and(whereFragment(vis.where), vis.policy)
    // The where's binds then the policy's, in the order the SQL reads them; the
    // guard is appended last, so its binds go last.
    const sealed = sealWhereClause(where0?.sql ?? null, where0?.params ?? [])
    const final  = sealed.sql ? { sql: sealed.sql, params: sealed.params } : null
    const ts     = nowISO(ctx.now)
    const sets   = sqlJoin([sqlFragment(_deletedAtSet, [ts]), ...stampSets(['deletedAt']).map(t => sqlFragment(t))], ', ')
    const stmt   = frag(sqlJoin([KW.update, T, KW.set, sets, final && KW.where, final, needStamped && KW.returning], ''))
    return {
      verb: 'removeMany', op: 'remove', statements: [{ ...stmt, data: null }], count: null, returning: needStamped,
      where: final, args: { where }, query: stmt, prefetch: false, moves: null, exclusion: null, post: false,
      softCascade: { ts }, batch: false, logs: tableHasLogWork, system: null,
      announce: { mode, event: 'remove', operation: 'removeMany', where },
      result: null, bare: false, refuse: null, before: null, transition: null,
    }
  }

  // The single-row pair. A hard-delete model's `remove` is `delete` under its
  // own name and event; a soft-delete model's is a stamp whose cascade runs in
  // the same unit. Both hand the row back off RETURNING. `delete` reads its row
  // AHEAD of the statement instead, so a @from can still correlate to it.
  async function planRemove({ where, withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf } = {}) {
    if (plugins?.hasPlugins) await plugins.beforeDelete(modelName, { where }, ctx)
    const vis = visibleWhere('remove', where, { withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf })
    const w = whereFragment(vis.where)
    if (!w) throw new Error(`remove on "${tableName}" requires a where clause`)
    const where0 = and(w, vis.policy)
    const result = { select: undefined, include: undefined }
    if (!softDelete) return deletePlan('remove', where, vis, null, true, result)
    // A soft remove is still a removal FROM the document — the row leaves every
    // read of it — so both halves of remove() carry the guard.
    const sealed = sealWhereClause(where0.sql, where0.params)
    const final  = { sql: sealed.sql, params: sealed.params }
    const ts     = nowISO(ctx.now)
    const sets   = sqlJoin([sqlFragment(_deletedAtSet, [ts]), ...stampSets(['deletedAt']).map(t => sqlFragment(t))], ', ')
    const stmt   = frag(sqlJoin([KW.update, T, KW.set, sets, KW.where, final, KW.returning], ''))
    return {
      verb: 'remove', op: 'remove', statements: [{ ...stmt, data: null }], count: null, returning: true,
      where: final, args: { where }, query: stmt, prefetch: false, moves: null, exclusion: null, post: false,
      softCascade: { ts }, batch: false, logs: tableHasLogWork, system: null,
      announce: { event: 'remove', operation: 'remove' }, result, bare: false, before: null, transition: null,
      refuse: { where: null, transition: null, version: null, sealSelf: null, seal: { ...frag(where0), op: 'remove' } },
    }
  }

  // Always a real DELETE FROM — bypasses soft delete on all tables. Requires a
  // where clause to prevent accidental mass deletion.
  async function planDelete({ where, withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf } = {}) {
    if (plugins?.hasPlugins) await plugins.beforeDelete(modelName, { where }, ctx)
    // The guard reads the CALLER's where. The filters below add clauses of
    // their own, and a `delete({})` whose emptiness they papered over would
    // stop being refused.
    if (!buildWhere(where, [], null, null, null, null, fieldKinds, columnMap))
      throw new Error(`delete on "${tableName}" requires a where clause — use deleteMany({}) to delete all rows`)
    // Through `whereFragment` like every other where in the client: a
    // `@encrypted(deterministic: true)` or `@hashed` column stores bytes the
    // caller never sends, so a raw comparison against the plaintext matches
    // nothing — and a DELETE that matches nothing reports a plausible zero
    // (FJS-600). Scope expansion, `@from` and typed JSON ride the same call.
    const vis = visibleWhere('delete', where, hardDeleteFlags({ withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf }))
    return deletePlan('delete', where, vis, null, false, { select: undefined, include: undefined })
  }

  // Everything a batch create decides before its unit opens: the refusals, the
  // hooks, the policy's own parent check. Null for an empty batch.
  async function prepareCreateMany({ data, system, announce } = {}) {
    if (!data?.length) return null
    // Resolved before any work: an unknown value is a caller that meant
    // something, and refusing it after the write has landed helps nobody.
    const { mode, wantRows } = announceFor(announce)
    // Operators are refused on a create-shaped write, and this is where that
    // refusal is made for a bulk one. It used to be reached only by the
    // object-where-a-value-belongs guard in writeData, which cannot see
    // `$merge`: a Json column legitimately takes an object, so the operator
    // was stored as the document — `{"$merge":{"a":1}}`.
    refuseBulkNested(data, 'createMany')
    for (const row of data) extractWriteOps(row, { where: 'createMany' })
    refuseSystemEntries(system, ['create'])
    if (plugins?.hasPlugins) await plugins.beforeCreate(modelName, { data, system }, ctx)
    await enforceValueSets(modelName, data, ctx)
    data = refuseOffEntry(data)
    // The rows as the caller wrote them: every stamp lands later, inside the unit.
    const hidden = await hiddenParents(data, [], system)
    const parent = ctx.hasPolicies ? data.map((row, i) => checkCreate(authStamped(row, modelName, ctx), hidden[i])) : []
    for (const [i, r] of parent.entries()) hidden[i] = firstRefusal(r, hidden[i])
    // A logged model already takes RETURNING, so opting in costs it nothing.
    // A plugin's onAfterWrite is told each row (FJS-1725).
    return { data, system, hidden, mode, needRows: tableHasLogWork || wantRows || !!plugins?.hearsWrites }
  }

  // The rows as they will be written, and one statement per row. Runs INSIDE
  // the batch's unit, because a @sequence stamp bumps its counter in the
  // database: run before the unit it was 2 auto-commit statements per row
  // (~16x slower) and a counter stayed bumped when the batch failed.
  function createManyPlan({ data, system, hidden, mode, needRows }) {
    const _rankMemo       = _ranks.length ? new Map() : null
    const autoId          = shape.autoId
    const genDefaults     = shape.generatedDefaults
    const authDefaults    = shape.authDefaults
    const createdByStamps = shape.createdBy
    const versionField    = shape.version
    const rows = data.map((item, i) => {
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
      d = applyFieldRefDefaults(d, stamped)
      if (versionField) { noteStamp(stamped, d, versionField); d = { ...(d ?? {}), [versionField]: 1 } }
      // Apply @sequence per row — each row gets its own counter increment
      d = applySequences(d, modelName, shape.sequences, writeDb, stamped)
      d = applyRanks(d, stamped, _rankMemo)
      // A validation failure here names the field and, without this, no row.
      // The row itself is NOT passed on: it is the caller's payload before
      // writeData ran, so a @encrypted value in it is still plaintext.
      try { return writeData(d, { requireAll: true, system, stamped, creating: true }) }
      catch (e) { throw asBatchRowError(e, i, data.length, null) }
    })
    // One statement PER ROW SHAPE, not one for the batch. Rows are not
    // required to be uniform: deriving the column list from row 0 made row 0
    // decide what every other row may write, so a wider row silently lost its
    // extra columns and a narrower one bound NULL over a column the caller
    // never mentioned — defeating its DDL DEFAULT. Rows are still inserted in
    // caller order, because an autoincrement id is assigned in insert order
    // and grouping would renumber them.
    const shapes = new Set()
    const sqlFor = (cols) => {
      const sql = insertSql(cols, needRows)
      shapes.add(sql)
      return sql
    }
    const statements = new Array(rows.length)
    for (let i = 0; i < rows.length; i++) {
      const row  = rows[i]
      const cols = Object.keys(row)
      const seal = sealInsertGuard(row)
      const params = new Array(cols.length)
      for (let c = 0; c < cols.length; c++) params[c] = row[cols[c]] ?? null
      if (seal) params.push(...seal.params)
      statements[i] = { sql: sqlFor(cols), params, data: row, one: true, seal, refusal: hidden[i] ?? null }
    }
    return {
      verb: 'createMany', op: 'create', statements, count: null, returning: needRows, where: null,
      args: { data },
      // A mixed batch has no single SQL to report. Uniform — the ordinary
      // case — reports exactly what it did before.
      query: { sql: [...shapes].join('\n'), params: null },
      prefetch: false, moves: null, exclusion: null, post: false, softCascade: null, batch: true,
      logs: tableHasLogWork, system,
      // No `where` on the collection form — a batch names its rows by supplying
      // them, and their ids exist only after SQLite assigns them.
      announce: { mode, event: 'create', operation: 'createMany', where: undefined },
      result: null, bare: false, refuse: null, before: null, transition: null,
    }
  }

  // The seam's view of createMany: planned outside any unit, so on a @sequence
  // model the counters it stamps stay bumped (see `[PLAN]` on the table).
  async function planCreateMany(args) {
    const prepared = await prepareCreateMany(args)
    return prepared && createManyPlan(prepared)
  }

  // Everything a create decides before its unit opens: the refusals, the
  // hooks, the stamps, the policy's own parent check. The row it returns is
  // the caller's payload as stamped; every stamp that WRITES (a @sequence)
  // lands inside the unit.
  async function prepareCreate({ data, include, select, scopedBy, system } = {}) {
    // Before the INSERT and before the transaction: a create of a model whose
    // relation declares a minimum, naming no children, can never satisfy it,
    // and answering that with a COUNT would cost the single-row fast path
    // (`FJS-1106`) for a row that is refused either way.
    const _cardRequires = shape.cardinality.requiresChildren
    if (_cardRequires) { const r = refuseChildlessCreate(_cardRequires, data); if (r) throw r }
    refuseSystemEntries(system, ['create'])
    // The plugins first: a value one writes into the payload is a value the
    // row lands with, and grading before it would pass it ungraded (FJS-1307).
    if (plugins?.hasPlugins) await plugins.beforeCreate(modelName, { data, include, select, system }, ctx)
    await enforceValueSets(modelName, [data], ctx)
    data = refuseOffEntry([data])[0]
    // Auto-generate @id if field uses @default(uuid/ulid/cuid) and not provided
    // What the ENGINE puts in this payload, so the @guarded/@system refusals
    // in writeData can grade the caller's keys alone (FJS-565).
    const stamped = new Set()
    const autoId = shape.autoId
    if (autoId && (data == null || data[autoId.field] == null)) {
      noteStamp(stamped, data, autoId.field)
      data = { ...(data ?? {}), [autoId.field]: autoId.generate() }
    }
    data = applyGeneratedDefaults(data, shape.generatedDefaults, stamped)
    data = applyAuthDefaults(data, shape.authDefaults, ctx.auth, stamped)
    data = stampFromAuth(data, shape.createdBy, ctx.auth, stamped)
    const [_crHid] = await hiddenParents([data], [stamped], system)
    // After the auth stamps, never before — see authStamped (FJS-1402).
    const _crParent = ctx.hasPolicies ? checkCreate(data, _crHid) : undefined
    // A new row is version 1, whatever the payload says. Honouring a supplied
    // version would let a client start a row at 500 and make the first real
    // editor's read look stale.
    if (shape.version) {
      noteStamp(stamped, data, shape.version)
      data = { ...(data ?? {}), [shape.version]: 1 }
    }
    data = applyFieldRefDefaults(data, stamped)
    extractWriteOps(data, { where: 'create' })
    const refusal = firstRefusal(_crParent, _crHid)
    return { data, stamped, refusal, select, include, system, scopedBy }
  }

  // The seam's view of create: the decomposition the unit does, with no unit
  // around it — a @sequence bumps its counter and a belongsTo nested write
  // lands (see `[PLAN]` on the table).
  async function planCreate(args) {
    const c = await prepareCreate(args)
    const data = applyRanks(applySequences(c.data, modelName, shape.sequences, writeDb, c.stamped), c.stamped)
    const { scalar, nested, hasNested } = extractNestedWrites(data)
    const { data: scalarNoEdge, edgeWrites } = extractEdgeWrites(scalar)
    return createPlan({ ...scalarNoEdge, ...(await processBelongsToNested(nested)) }, { ...c, hasNested, edgeWrites, bare: false })
  }

  // Everything an update decides before its unit opens, and the planner its
  // unit runs: `plan(extraFKs)` takes the foreign keys a belongsTo nested
  // write made and answers the plan, or null for a row outside the caller's
  // read scope. Returns the updated row, or null in these cases:
  //   • No row matched the where clause
  //   • A @@allow/@@deny policy blocked the update
  //   • A post-update policy rollback was triggered
  // Callers that need to distinguish can check count() before/after,
  // or enable policyDebug to see which policy blocked.
  async function prepareUpdate({ where, data, include, select, scopedBy, system, _bypassVersion, _move, base,
                                 withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf } = {}) {
    refuseSoftDeleteWrite(data, 'update')
    refuseSystemEntries(system, ['update'])
    if (plugins?.hasPlugins) await plugins.beforeUpdate(modelName, { where, data, include, select, system }, ctx)
    await enforceValueSets(modelName, [data], ctx, { where })
    const stamped = new Set()
    data = stampFromAuth(data, shape.updatedBy, ctx.auth, stamped)
    const [_upHidden] = await hiddenParents([data], [stamped], system)

    // ── @version — take the caller's expected version off the payload ───────
    // It is a precondition, not a value to write: the column is bumped by SQL
    // below, never SET to what arrived. asSystem() may leave it out, since a
    // migration read nothing and has no version to state; one it DOES state is
    // checked, because a job that read the row and wrote back after slow work
    // is a second editor and would otherwise overwrite a save in between
    // (FJS-D659).
    //
    // A named move may leave it out too: it is already a compare-and-swap on
    // the from-state, and a model declaring both would otherwise be a machine
    // only asSystem() could move — a person, the served method and the
    // commitment's clock all refused VersionRequired (FJS-3086).
    const _versionField = shape.version
    let   _expectVersion = null
    if (_versionField) {
      const supplied = data?.[_versionField]
      if (!_bypassVersion && (!(ctx.isSystem || _move) || supplied != null)) {
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
    const syncMode = shape.sync
    if (base !== undefined && syncMode !== 'field') throw new Error(
      `[litestone] update on "${modelName}" was given a base row, and only @@sync(field) reads one. ` +
      `This model declares ${syncMode ? `@@sync(${syncMode})` : 'no @@sync'}. ` +
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
    //
    // Pure — the split reads the payload and nothing else, so it can decide
    // below whether this update needs a transaction at all.
    const { scalar, nested, hasNested } = extractNestedWrites(data)
    const { data: scalarNoEdge, edgeWrites } = extractEdgeWrites(scalar)
    const _postUpdatePolicy = Boolean(ctx.hasPolicies && shape.policy['postUpdate'])
    // One UPDATE with no transaction open is its own unit, as a one-statement
    // create is (`FJS-1106`). What keeps the transaction: a nested or edge
    // write (more statements), a post-update policy (its refusal IS the
    // rollback), and @@transitions (the move is graded across an await, and a
    // transaction could open in that gap). On this path the plan reaches its
    // statement without yielding — the executor's `bare` tripwire is what
    // says so if an edit ever adds an await ahead of it (`FJS-1107`).
    // A hidden parent is thrown only once the UPDATE has reached a row, as
    // SQLite's own refusal is — so it needs a rollback to throw into.
    const ownUnit = !hasNested && !edgeWrites.length && !_postUpdatePolicy && !_upHidden
      && !_tableTransitions && tx.state.depth === 0 && !_cardNotes && !exclTouched(data)
      && !rankScopeTouched(data)

    // The plan: the WHERE and the SET, the before snapshot, the move's grade
    // and compare-and-swap, the version's, the seals — every conjunct that
    // narrows the statement, and the ladder that explains a row it did not
    // reach. Null when the row is outside the caller's read scope.
    const updatePlan = async (extraFKs) => {
      data = { ...scalarNoEdge, ...extraFKs }
      const { where: exclWhere, policy: updatePolicy } =
        visibleWhere('update', where, { withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf })
      const callerWhere = whereFragment(exclWhere)
      if (!callerWhere) throw new Error(`update on "${tableName}" requires a where clause`)
      const { sql: whereSql, params: whereParams } = callerWhere
      const selAll = sqlJoin([KW.select, T, KW.where, callerWhere], '').sql

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
        const _cur = readDb.query(selAll).get(...whereParams)
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

      if (_ranks.length) data = rankOnScopeChange(data, selAll, whereParams, stamped)
      const { data: _upValues, ops: _upOps } = extractWriteOps(data)
      const row       = writeData(_upValues, { system, fieldWrite: 'sql', stamped, where })
      const setParams = []
      const setCols   = [
        ...Object.keys(row).map(c => setFragment(c, row[c], setParams)),
        ..._upOps.map(o => setFragmentExpr(o.col, o.expr, o.params, setParams)),
      ].join(', ')
      if (shape.selfRelations.some(r => r.fkField in (data ?? {}))) {
        const _idf = shape.selfRelations[0].referencedField
        assertNoParentCycle(
          readDb.query(sqlJoin([sqlFragment('SELECT '), ident(_idf), sqlFragment(' AS _id FROM '), T, KW.where, callerWhere], '').sql)
            .all(...whereParams).map(r => r._id),
          data,
        )
      }
      // The caller's where, then the update policy
      const finalWhere = and(callerWhere, updatePolicy)

      // ── Logging + the post-update rule: the before snapshot ──────────────
      // Two snapshots of one row, and the trail needs the READ one. read()
      // parses Json to objects and coerces booleans, which is the row a
      // reviewer compares against the after.
      const heard = hasLocalAudience()
      const beforeRaw = tableHasLogWork || _postUpdatePolicy || heard
        ? readDb.query(selAll).get(...whereParams)
        : null
      const beforeRow = beforeRaw ? trailImage(beforeRaw, read(beforeRaw, { mode: 'single' })) : null
      const heardRow  = heard && beforeRaw ? read(beforeRaw, { mode: 'single', hydrateFrom: true }) : null

      // ── Transition enforcement ────────────────────────────────────────────
      // Check before SQL: validates from-state, throws TransitionViolationError if invalid.
      // Note: uses whereParams (original, no policy filter) for the current-value SELECT.
      const _transResult = _tableTransitions ? await checkTransitions(row, whereParams, whereSql, system, _move) : null
      // Every no-match reader in the ladder reads the row UNSCOPED to name
      // why — the version, the seal, the move's refusal — so a row outside
      // the caller's read scope leaves before any of them can describe it.
      if (_transResult === NOT_VISIBLE) return null
      // A column the move stamps is the engine's: a payload naming it would be
      // a second clock for one event, so it is refused by name, as @system is.
      const _moveStamps = _transResult?.stamps ?? []
      const _namedStamps = _moveStamps.filter(c => c in data)
      if (_namedStamps.length) throw new ValidationError(
        _namedStamps.map(f => ({
          path: [f],
          message: `${f} is stamped by the '${_transResult.transitionName}' move — the engine writes it with the move. ` +
                   `Leave it out of the payload.`,
        })),
        { model: modelName, operation: 'write' }
      )
      // If transitions apply, narrow WHERE to include AND field = currentValue (optimistic lock)
      const { sql: _txWhereSql, params: _txWhereParams } = _transResult
        ? applyTransitionWhereClause(_transResult, finalWhere.sql, finalWhere.params)
        : finalWhere

      // ── @version — the compare half of the swap ─────────────────────────────
      // Same shape as applyTransitionWhereClause above: narrow the WHERE by the
      // value the caller read, so a row that moved simply does not match. The
      // bump rides the SET clause, which also means a versioned update always
      // has a column to write even when `data` was otherwise empty.
      const _vWhereSql0    = _expectVersion == null ? _txWhereSql : `(${_txWhereSql}) AND ${ident(col(_versionField)).sql} = ?`
      const _vWhereParams0 = _expectVersion == null ? _txWhereParams : [..._txWhereParams, _expectVersion]
      // The third link in the same chain: the caller's where, then the policy,
      // then the move's from-state, then the version, then the seal. Each one
      // narrows and none of them reports — the row simply does not match, which
      // is what makes the refusal ladder the whole of the diagnosis.
      const _vSealed = sealWhereClause(_vWhereSql0, _vWhereParams0)
      // …and the model's own columns, where it is one that seals.
      const _vSelf = sealSelfClause(data, _vSealed.sql, _vSealed.params)
      // The bump rides the SET clause — but only where the caller actually
      // wrote something. It used to be appended unconditionally, which meant a
      // versioned update MANUFACTURED a column to write when `data` was
      // otherwise empty, so a patch whose only key was `version` was a real
      // write: the column went up, `@updatedAt` moved with it, and every other
      // open editor of that row was told it was stale for a change nobody made
      // (`FJS-368`). The value is a precondition the client sends back, not a
      // value to write, so a form submitted with nothing edited became a write.
      //
      // A model with no `@version` already answered this correctly — the
      // no-statement plan below reads the row back and issues no statement —
      // so the two spellings disagreed about the same patch, which is the
      // whole finding. Nested and edge writes are a real change to this row's
      // meaning and still earn the bump; only a patch that names nothing at
      // all does not.
      const _touchesRow   = Boolean(setCols) || hasNested || edgeWrites.length > 0
      const _v            = _versionField ? ident(col(_versionField)).sql : null
      const _setColsBase  = !_versionField || !_touchesRow ? setCols
        : [setCols, `${_v} = ${_v} + 1`].filter(Boolean).join(', ')
      // Only a write that had something to say moves the stamp: an update
      // naming no column issues no statement at all below, and the trigger it
      // used to lean on never fired for one either.
      const _setColsV     = _setColsBase
        ? [_setColsBase, ...stampSets(Object.keys(row)), ...moveStampSets(_moveStamps)].join(', ')
        : _setColsBase

      const version = _expectVersion == null ? null : { field: _versionField, expect: _expectVersion }
      const args    = { where, data, include, select }
      const result  = { select, include }

      if (!_setColsV) {
        // No columns to set — read back to return current row.
        //
        // The precondition is still a question, and it is asked for the
        // same reason it is asked on the writing path: the caller is telling
        // this boundary which version they read, and a stale one means their
        // view is wrong whether or not they were writing. Answering a no-op
        // success would confirm a stale screen.
        //
        // Read through the update policy, the WHERE a write would have used.
        // The bare where answered any row the id named, so `data: {}` handed
        // a caller the whole of a row their policy hides, read policy included.
        //
        // A patch that named no column wrote nothing, so there is nothing to
        // announce, nothing for a plugin to observe and nothing to file
        // (`FJS-368`): `announce` is null. A nested or edge write on this
        // path is still a change to the row's meaning, and announces.
        const sel = frag(sqlJoin([KW.select, T, KW.where, finalWhere], ''))
        return {
          verb: 'update', op: 'update', statements: [], count: sel, returning: false, where: frag(finalWhere),
          args, query: sel, prefetch: false, moves: null, exclusion: null, post: false, softCascade: null,
          batch: false, logs: tableHasLogWork, system,
          announce: _touchesRow ? { event: 'update', operation: 'update' } : null, result, bare: ownUnit,
          refuse: { where: callerWhere, transition: null, version, sealSelf: null, seal: null },
          before: beforeRow, heard: heardRow, transition: _transResult,
        }
      }

      // select: false with no reader of the row skips RETURNING. A logged
      // model keeps it — the trail needs the after snapshot — as do the
      // post-update rule and a nested write, which need the row itself.
      const returning = !(select === false && !tableHasLogWork && !_postUpdatePolicy && !hasNested && !edgeWrites.length)
      const stmt = frag(sqlJoin([
        KW.update, T, KW.set, sqlFragment(_setColsV, setParams), KW.where, _vSelf, returning && KW.returning,
      ], ''))
      return {
        verb: 'update', op: 'update', statements: [{ ...stmt, data: row }], count: null, returning,
        where: frag(_vSelf), args, query: stmt, prefetch: false, moves: _upHidden ?? null,
        exclusion: exclTouched(data) ? data : null, post: _postUpdatePolicy, softCascade: null, batch: false,
        logs: tableHasLogWork, system, announce: { event: 'update', operation: 'update' }, result, bare: ownUnit,
        refuse: {
          where: callerWhere,
          transition: _transResult ? { ..._transResult, policy: !!updatePolicy } : null,
          version, sealSelf: _vSelf.frozen,
          seal: { sql: _vWhereSql0, params: _vWhereParams0, op: 'update' },
        },
        before: beforeRow, heard: heardRow, transition: _transResult,
        // The row the statement's own WHERE reaches, so a child written ahead
        // of it is written only for a row the policy, the move and the version
        // let the UPDATE touch.
        reach: () => {
          const q = frag(sqlJoin([KW.select, T, KW.where, _vSelf], ''))
          return readDb.query(q.sql).get(...q.params)
        },
      }
    }

    return { plan: updatePlan, nested, hasNested, edgeWrites, ownUnit, scopedBy }
  }

  // The seam's view of update: a belongsTo nested write lands, with no unit
  // around it (see `[PLAN]` on the table).
  async function planUpdate(args) {
    const u = await prepareUpdate(args)
    return u.plan(u.hasNested ? await processBelongsToNested(u.nested) : {})
  }

  // The single-statement upsert: `INSERT … ON CONFLICT(key) DO UPDATE …
  // RETURNING *`, reached only when nothing listens, polices, logs, seals or
  // stamps (see `upsert`'s fast path). Only the DO UPDATE branch needs the
  // stamp — an INSERT takes the column DEFAULT, which is the same expression.
  // No audience by construction, so it announces nothing; the choice between
  // this statement and the read-then-write path is the verb's.
  function upsertPlan({ where, createData, updateData, insRow, updRow, wKey, insCols, updCols, restamp = null }) {
    const sets = sqlJoin([
      sqlJoin(updCols.map(c => sqlJoin([ident(col(c)), sqlFragment(' = ?', [updRow[c] ?? null])], '')), ', '),
      ...stampSets(updCols).map(t => sqlFragment(t)),
    ], ', ')
    const stmt = frag(sqlJoin([
      sqlFragment('INSERT INTO '), T, sqlFragment(' ('), sqlJoin(insCols.map(c => ident(col(c))), ', '),
      sqlFragment(`) VALUES (${insCols.map(() => '?').join(', ')}) ON CONFLICT(`, insCols.map(c => insRow[c] ?? null)),
      ident(wKey), sqlFragment(') DO UPDATE SET '), sets, KW.returning,
    ], ''))
    return {
      verb: 'upsert', op: 'upsert', statements: [{ ...stmt, data: insRow, one: true }], count: null, returning: true,
      where: null, args: { where, create: createData, update: updateData }, query: stmt, prefetch: false,
      moves: null, exclusion: null, post: false, softCascade: null, batch: false, logs: false, system: null,
      announce: null, result: { select: undefined, include: undefined }, bare: tx.state.depth === 0,
      refuse: null, before: null, transition: null, restamp,
    }
  }

  // Everything an upsert decides before either path, then the one-statement
  // plan when the fast path applies: no hooks, plugins, policies, events,
  // logs, transitions, soft delete, window, global filters, field policies,
  // sequences or nested writes, and a `where` naming exactly one unique
  // column. Null otherwise — the verb then reads, and updates or creates.
  async function planUpsert({ where, create: createData, update: updateData, include, select, system,
                              withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf } = {}) {
    // An operator is refused here rather than passed to the update half. This
    // method has a single-statement fast path whose SET clause reads from
    // `excluded`, and a slow path that calls update() — one would apply the
    // operator and the other could not, which is the drift the refusal exists
    // to prevent.
    extractWriteOps(createData, { where: 'upsert' })
    extractWriteOps(updateData, { where: 'upsert' })
    refuseSoftDeleteWrite(updateData, 'upsert')
    refuseSystemEntries(system, ['create', 'update'])
    // The fast path's two halves; the slow path is create() and update(),
    // which grade their own.
    const _upsHidden = await hiddenParents([createData, updateData], [], system)
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
    const _relator = shape.model.attributes?.find(a => a.kind === 'relator')
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
            `${modelName} declares @@relator([${_relator.fields.join(', ')}], many, by: ${_relator.discriminator}), ` +
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
    // With a plugin installed the fast path is never taken and the slow path's
    // create() and update() each check their own, after the gate: checking here
    // would answer a caller the gate refuses with the set instead.
    if (!plugins?.hasPlugins) {
      await enforceValueSets(modelName, [createData], ctx)
      await enforceValueSets(modelName, [updateData], ctx, { where })
    }
    createData = refuseOffEntry([createData])[0]
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
    if (
      !plugins?.hasPlugins && !emitter && !ctx._eventListeners.size &&
      !ctx.hasPolicies && !tableHasLogWork && !_tableTransitions && !_exclNotes &&
      !softDelete && !hasTemplates && !effective && !hasFieldPolicy && !_rawFilter &&
      !shape.sequences.length &&
      !_ranks.length &&
      !shape.updatedBy.length &&
      !shape.version &&
      include === undefined && select === undefined &&
      where && createData && updateData && Object.keys(updateData).length
    ) {
      const wKeys = Object.keys(where)
      if (wKeys.length !== 1) return null
      const wKey = wKeys[0]
      const wVal = where[wKey]
      const wt = typeof wVal
      if (wVal == null || (wt !== 'string' && wt !== 'number' && wt !== 'bigint' && wt !== 'boolean')) return null
      if (!_upsertUniqueCols().has(wKey)) return null
      // The fast path compiles one INSERT … ON CONFLICT and has nowhere to put
      // a nested write, so it must decline the call rather than take it: read
      // as *no nested writes*, this handed `{ create: [...] }` to the column
      // validator, which refused a legitimate write with `lines: must be an
      // array`.
      if (extractNestedWrites(createData).hasNested) return null
      if (extractNestedWrites(updateData).hasNested) return null

      // Same data massage as create(): auto-@id, auth()/field-ref defaults
      let cData = createData
      const _fpStamped = new Set()
      const _fpAutoId = shape.autoId
      if (_fpAutoId && cData[_fpAutoId.field] == null) {
        noteStamp(_fpStamped, cData, _fpAutoId.field)
        cData = { ...cData, [_fpAutoId.field]: _fpAutoId.generate() }
      }
      cData = applyGeneratedDefaults(cData, shape.generatedDefaults, _fpStamped)
      cData = applyAuthDefaults(cData, shape.authDefaults, ctx.auth, _fpStamped)
      cData = stampFromAuth(cData, shape.createdBy, ctx.auth, _fpStamped)
      cData = applyFieldRefDefaults(cData, _fpStamped)

      // A field write predicate has to read the STORED row, and this branch is
      // one statement with no row in hand — its DO UPDATE would grade the
      // payload, which is exactly the fail-open `FJS-433` describes. The slow
      // path reads then updates, where the CASE in the SET applies.
      if (_hasFieldWrite) return null
      // A move without the blob re-mirrors the stored one, and so has the
      // same need for a row in hand.
      if (_extensible?.scope && _extensible.scope in updateData && !(_extensible.column in updateData)) return null

      // writeData runs transforms + validation on both branches' data
      const insRow = writeData({ ...cData, [wKey]: cData[wKey] ?? wVal }, { requireAll: true, system, stamped: _fpStamped, creating: true })
      const updRow = writeData(updateData, { system })
      if (_upsHidden[0]) throw _upsHidden[0]
      // update() asks whether the key MOVES, which one statement cannot.
      if (_upsHidden[1]) return null
      const insCols = Object.keys(insRow)
      const updCols = Object.keys(updRow).filter(c => c !== wKey)
      if (!insCols.length || !updCols.length) return null
      if (_sealInsertSql) return null
      if (_selfFreezes.length) return null

      // The INSERT's clock columns were read while this was planned; the lock
      // is taken later, in writeUnit, which asks for the statement again then.
      const clocked = shape.generatedDefaults?.some(e => e.clock && _fpStamped.has(e.field))
      const restamp = clocked ? () => {
        const cNow = restampClock(cData, shape.generatedDefaults, _fpStamped)
        const row = writeData({ ...cNow, [wKey]: cNow[wKey] ?? wVal }, { requireAll: true, system, stamped: _fpStamped, creating: true })
        return upsertPlan({ where, createData, updateData, insRow: row, updRow, wKey, insCols: Object.keys(row), updCols }).statements
      } : null

      return upsertPlan({ where, createData, updateData, insRow, updRow, wKey, insCols, updCols, restamp })
    }
    return null
  }

  const PLANNERS = {
    createMany: planCreateMany, updateMany: planUpdateMany, deleteMany: planDeleteMany, removeMany: planRemoveMany,
    remove: planRemove, delete: planDelete, create: planCreate, update: planUpdate, upsert: planUpsert,
  }

  // installHooks wraps this object — see its header. Hooks are the OUTERMOST
  // layer: a before hook sees the arguments as the caller wrote them, ahead of
  // the plugin door and of any stamping this file does.
  return installHooks({

    // The plan a bulk write would run, without running it — the way `$checkWhere`
    // answers a where without querying. A test's view of a verb, keyed by the
    // `PLAN` symbol so it is no method of the table. It plans through the
    // verb's own door (hooks, value sets, stamps), so on a @sequence model it
    // bumps the counters outside any unit: it reads a verb, it is not a dry run.
    async [PLAN](verb, args = {}) {
      const planner = PLANNERS[verb]
      if (!planner) throw new Error(`${modelName}[PLAN](${verb}): not a planned write — one of ${Object.keys(PLANNERS).join(', ')}`)
      return planner(args)
    },

    // This row's membership in a relation changed through a join table, so it
    // announces an update with nothing else written. Read fresh rather than
    // handed over: the caller's own read may have been narrowed by a field policy.
    [NARROWED]() { return readNarrowed() },

    [JOINED](key) {
      if (!hasAudience()) return
      const raw = writeDb.query(`SELECT * FROM ${T.sql} WHERE ${ident(col(idField)).sql} = ?`).get(key)
      if (raw) fireRowEvent('update', 'update', read(raw, { mode: 'single', hydrateFrom: true }))
    },

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

        // The option arrives from a wire as well as from code (`$recursive`), so
        // a key or a value it does not hold is refused by name: a misspelt
        // `maxdepth` otherwise walks to the 1000-level ceiling and answers 200.
        const badRecursive = (key, message) => { throw new ValidationError([{ path: ['recursive', key], message }]) }
        for (const k of Object.keys(rec))
          if (!RECURSIVE_KEYS.includes(k)) badRecursive(k, `recursive takes ${RECURSIVE_KEYS.join(', ')}; '${k}' is not one of them`)
        if (rec.direction !== 'descendants' && rec.direction !== 'ancestors')
          badRecursive('direction', `recursive.direction is 'descendants' or 'ancestors', not ${JSON.stringify(rec.direction)}`)
        if (rec.maxDepth != null && !(Number.isInteger(rec.maxDepth) && rec.maxDepth >= 1))
          badRecursive('maxDepth', `recursive.maxDepth is a whole number of 1 or more, not ${JSON.stringify(rec.maxDepth)}`)
        if (rec.nested != null && typeof rec.nested !== 'boolean')
          badRecursive('nested', `recursive.nested is true or false, not ${JSON.stringify(rec.nested)}`)
        if (rec.via != null && typeof rec.via !== 'string')
          badRecursive('via', `recursive.via names a relation field or its foreign key, not ${JSON.stringify(rec.via)}`)

        const selfRels = shape.selfRelations
        if (!selfRels?.length) {
          const composite = Object.entries(shape.relations)
            .find(([, r]) => r.kind === 'belongsTo' && r.targetModel === modelName && r.foreignKeys.length > 1)
          if (composite)
            throw new Error(`findMany({ recursive }) — '${modelName}.${composite[0]}' relates over (${composite[1].foreignKeys.join(', ')}), and a tree walk follows a single column`)
          throw new Error(`findMany({ recursive }) — model '${tableName}' has no self-referential relation`)
        }

        // The CTE names four columns of its own; a model column of the same
        // name would resolve to the CTE inside the walk and answer nonsense.
        const reserved = ['_id', '_pid', '_depth', '_path']
        for (const f of shape.model.fields)
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
        const maxDepth = rec.maxDepth ?? 1000

        // Built once, bound at every level it appears in: the anchor SELECT and
        // each step of the walk. Folded as `recursive`: its row in READ_RULES
        // says which rules the walk applies, and which it does not.
        const visParams = []
        const { where: visWhere, policy: readPolicy } = visibleWhere('recursive', null, args)
        let   visSql    = visWhere ? buildWhereWithEncryption(visWhere, visParams) : null
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

      // ── Inline fast path: findMany() / findMany({}) ──
      // A plugin's beforeRead may rewrite the args, so the shape is asked again
      // after it, and the slow path is told the hook has run.
      const _plainFindMany = () => !args.where && !args.orderBy && !args.limit && !args.offset && !args.select && !args.include && !args.withDeleted && !args.onlyDeleted && !args.window && !args.distinct && !args.scopedBy
      let _readChecked = false
      if (_fastFindMany && !tableHasLogWork && !_edgeNamespaces.size && _plainFindMany() && !readNarrowed('softDelete')) {
        if (plugins?.hasPlugins) { await plugins.beforeRead(modelName, args, ctx); _readChecked = true }
        if (_plainFindMany()) {
          const _needsTiming = ctx.onQuery || ctx._queryListeners.size
          const _t0 = _needsTiming ? performance.now() : 0
          const rows = readAll(readDb.query(_fastFindManySql).all(), { mode: 'list' })
          if (_needsTiming) fireQuery({ operation: 'findMany', args, sql: _fastFindManySql, params: [], duration: performance.now() - _t0, rowCount: rows.length })
          if (plugins?.hasPlugins) await plugins.afterRead(modelName, rows, ctx, {})
          return rows
        }
      }
      if (plugins?.hasPlugins && !_readChecked) await plugins.beforeRead(modelName, args, ctx)
      const { where, include, orderBy, limit, offset, select, distinct, scopedBy } = args
      _scopedByForBuild = scopedBy ?? null
      const windowSpec      = args.window ?? null
      const windowNames     = windowNamesOf(windowSpec)
      const ps             = parseArgs(select, include, windowNames)
      const psLog           = logReadParse(select, include, ps, distinct, windowNames)

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
        const psScan = select ? parseArgs({ ...select, ...(psLog !== ps && { [idField]: true }), [_jsVec.field]: true }, include, windowNames) : ps

        // The same guard the compiled path ANDs on, stated here because the
        // ordering it is derived from has been taken out of this query.
        const scanWhere = { AND: [...(where ? [where] : []), { [_jsVec.field]: { not: null } }] }

        ;({ sql, params } = buildSQL({
          where: scanWhere, orderBy: orderByAfterVector(orderBy, _jsVec.field),
          parsedSelect: psScan, args, distinct: distinct === true, windowSpec,
          withVectors: true,
        }))
        rawRows = scoreByDistance(readDb.query(sql).all(...params), _jsVec.near, {
          column: col(_jsVec.field), dim: _jsVec.dim, dir: _jsVec.dir,
          take: limit  == null ? Infinity : Number(limit),
          skip: offset == null ? 0        : Number(offset),
        })
      } else {
        ;({ sql, params } = buildSQL({ where, args, orderBy, limit, offset, parsedSelect: psLog, distinct: distinct === true, windowSpec }))
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
      const ps              = parseArgs(select, include)
      const psLog           = logReadParse(select, include, ps)
      const { sql, params } = buildSQL({ verb: 'findFirst', where, args, orderBy, limit: 1, parsedSelect: psLog })
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
      // The args are asked again after beforeRead for the reason findMany's are.
      const _pkValue = () => {
        const w = args.where
        if (!w || args.include || args.select || args.withDeleted || args.onlyDeleted || args.scopedBy) return undefined
        const keys = Object.keys(w)
        if (keys.length !== 1 || keys[0] !== _pkField) return undefined
        const v = w[_pkField]
        return v !== null && (typeof v !== 'object' || v instanceof Date) ? v : undefined
      }
      let _readChecked = false
      if (_fastFindUnique && !_edgeNamespaces.size && _pkValue() !== undefined && !readNarrowed('softDelete')) {
        if (plugins?.hasPlugins) { await plugins.beforeRead(modelName, args, ctx); _readChecked = true }
        const v = _pkValue()
        if (v !== undefined) {
          const _nt = needsTiming()
          const _t0 = _nt ? performance.now() : 0
          const rows = readAll(readDb.query(_fastFindUniqueSql).all(v), { mode: 'single' })
          if (_nt) fireQuery({ operation: 'findUnique', args, sql: _fastFindUniqueSql, params: [v], duration: _nt ? performance.now() - _t0 : 0, rowCount: rows.length })
          if (rows.length > 1) throw new Error(`findUnique on "${tableName}" returned more than one row`)
          const row = rows[0] ?? null
          if (plugins?.hasPlugins && row) await plugins.afterRead(modelName, [row], ctx, {})
          if (tableHasLogWork && row) emitLogs('read', [row])
          return row
        }
      }

      if (plugins?.hasPlugins && !_readChecked) await plugins.beforeRead(modelName, args, ctx)
      const { where, include, select, scopedBy } = args
      _scopedByForBuild = scopedBy ?? null
      const ps              = parseArgs(select, include)
      const psLog           = logReadParse(select, include, ps)
      const { sql, params } = buildSQL({ verb: 'findUnique', where, args, limit: 2, parsedSelect: psLog })
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
      //   · a `@@trail` model recorded reads through every path but this one.
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
      const vis       = visibleWhere('count', where, args)
      const whereAll  = and(whereFragment(vis.where), vis.policy)
      const sql       = `SELECT COUNT(*) as n FROM "${tableName}"` + (whereAll ? ` WHERE ${whereAll.sql}` : '')
      const params    = whereAll?.params ?? []
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
      const vis       = visibleWhere('exists', where, args)
      const whereAll  = and(whereFragment(vis.where), vis.policy)
      const sql       = `SELECT 1 as _e FROM "${tableName}"` + (whereAll ? ` WHERE ${whereAll.sql}` : '') + ` LIMIT 1`
      const params    = whereAll?.params ?? []
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
      const windowSpec  = args.window ?? null
      const windowNames = windowNamesOf(windowSpec)
      const ps   = parseArgs(select, include, windowNames)
      const psLog = logReadParse(select, include, ps, distinct, windowNames)

      // ── rows query (with limit/offset) ──────────────────────────────────
      // The window is the rows' alone: the total counts the filtered set, and a
      // window column is not a filter.
      const { sql, params } = buildSQL({ verb: 'findManyAndCount', where, args, orderBy, limit, offset, parsedSelect: psLog, distinct: distinct === true, windowSpec })
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
      const vis      = visibleWhere('findManyAndCount', where, args)
      const whereAll = and(whereFragment(vis.where), vis.policy)
      const countSql = `SELECT COUNT(*) as n FROM "${tableName}"` + (whereAll ? ` WHERE ${whereAll.sql}` : '')
      const total    = readDb.query(countSql).get(...(whereAll?.params ?? [])).n

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
      refuseCountShape('aggregate', _count)
      refuseMixedCurrency('aggregate', args)
      const params = []
      // A SELECT-list value (a _stringAgg separator, a named aggregate's
      // filter) is bound before the WHERE's, because it comes first in the
      // statement. Pushed onto one array they bound in the wrong order: a
      // separator compared against the where's column and the where's value
      // joined the strings, so _stringAgg beside any where answered [].
      const selectParams = []

      // The flags ride in `args`, not a hardcoded 'live'/'instances'. Both were
      // pinned here, so `aggregate({ _count: true, onlyDeleted: true })` counted
      // the LIVE rows and `onlyTemplates` counted the instances — the opposite
      // answer to the question asked, from the method whose whole output is one
      // number nothing can cross-check (FJS-263).
      const { where: exclWhere, policy: policyResult } = visibleWhere('aggregate', where, args)
      const whereSql = buildWhereWithEncryption(exclWhere, params)

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
          if (agg === '_sum') exactSum('aggregate', field, result[agg][field])
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
      const { by, where, having, limit, offset, _count, _sum, _avg, _min, _max, _stringAgg, fillGaps, timeZone, weekStart = 'monday' } = args
      // findMany takes an array of terms, and a total order over two group keys
      // needs one. Flattened to [key, dir] pairs because two `_sum` terms would
      // collapse into one key in an object.
      const orderTerms = []
      if (Array.isArray(args.orderBy)) {
        args.orderBy.forEach((item, i) => {
          if (!item || typeof item !== 'object' || Array.isArray(item))
            throw new ValidationError([{ path: ['orderBy', i], message:
              `orderBy[${i}] on ${modelName}.groupBy must be an object such as { ${by?.[0] ?? 'field'}: 'asc' }` }])
          orderTerms.push(...Object.entries(item))
        })
      } else if (args.orderBy && typeof args.orderBy === 'object') {
        orderTerms.push(...Object.entries(args.orderBy))
      }
      const orderBy = orderTerms.length ? orderTerms : null
      const interval = args.interval   // { fieldName: 'unit' }
      // A week is named by its first day, and which day that is belongs to the
      // business: a Sunday-start tenant read Monday-cut buckets as wrong weeks.
      // Refused beside any other unit, where it would be quietly ignored.
      if (!['monday', 'sunday'].includes(weekStart))
        throw new ValidationError([{ path: ['weekStart'], message: `groupBy() weekStart '${weekStart}' is not a week start — use 'monday' or 'sunday'` }])
      if ('weekStart' in args && Object.values(interval ?? {})[0] !== 'week')
        throw new ValidationError([{ path: ['weekStart'], message: `groupBy() weekStart cuts a week — pass interval: { <DateTime field>: 'week' } beside it` }])
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
      refuseCountShape('groupBy', _count)
      refuseMixedCurrency('groupBy', args, by, [having, ...orderTerms.map(([k, v]) => ({ [k]: v }))])

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
        const modelDef = shape.model
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
      if (orderBy) {
        const groupKeys = new Set(by)
        if (intervalField) groupKeys.add(intervalField)
        const names = []
        for (const [key, val] of orderBy) {
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

      // Days since the week began, from %w (Sunday is 0).
      const weekday = expr => weekStart === 'sunday'
        ? `CAST(STRFTIME('%w', ${expr}) AS INTEGER)`
        : `((CAST(STRFTIME('%w', ${expr}) AS INTEGER) + 6) % 7)`

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
          // The week's first date, so a week crossing New Year is one bucket.
          case 'week':    return `DATE(${expr}, '-' || ${weekday(expr)} || ' days')`
          case 'day':    return `STRFTIME('%Y-%m-%d', ${expr})`
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
          case 'week':    return '%Y-%m-%d'
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

      // WHERE clause — the flags ride in `args`, as aggregate (FJS-263).
      const { where: exclWhere, policy: policyResult } = visibleWhere('groupBy', where, args)
      const whereSql = buildWhereWithEncryption(exclWhere, params)

      // ── The zone, as SQL ─────────────────────────────────────────────────
      // SQLite has no zone database and bun:sqlite can register no function,
      // so the zone is stated as the fixed offsets it keeps over the rows this
      // call reads (toolbelt's offsetSpans) and a CASE picks each row's:
      // DATETIME(t, '+32400 seconds') is Tokyo's wall clock for t. Everything
      // inlined is a number this code computed; nothing the caller sent.
      // One extra read over the same WHERE names the UTC years holding rows,
      // and the spans cover those years only: a MIN/MAX range read the zone
      // across every empty year between, so one 9999-12-31 "never" date cost
      // eight thousand years of reads per call (FJS-2184). A gap between two
      // years holds no row, so whichever arm covers it picks nothing.
      if (timeZone != null) {
        const rawCol = `"${tableName}"."${col(intervalField)}"`
        const parts = [whereSql, policyResult?.sql].filter(Boolean)
        const years = readDb.query(
          `SELECT DISTINCT CAST(strftime('%Y', ${rawCol}) AS INTEGER) AS y FROM "${tableName}"` +
          ` WHERE ${[`${rawCol} IS NOT NULL`, ...parts].map(p => `(${p})`).join(' AND ')} ORDER BY y`,
        ).all(...params, ...(policyResult?.params ?? [])).map(r => r.y).filter(y => y != null)
        // Date.UTC reads a year below 100 as 19xx; setUTCFullYear does not.
        const yearStart = y => new Date(0).setUTCFullYear(y, 0, 1)
        const spans = []
        for (const y of years) {
          for (const sp of offsetSpans(yearStart(y), yearStart(y + 1), timeZone)) {
            if (spans.at(-1)?.offset !== sp.offset) spans.push(sp)
          }
        }
        if (!spans.length) spans.push({ offset: 0 })
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
        // A bound written as a date IS a calendar date, and is that date in any
        // zone. Read as an instant it was UTC midnight, which is the evening
        // before west of Greenwich, so `start: '2026-01-01'` in Chicago filled
        // from December.
        if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))
          return intervalUnit === 'hour' ? `${v} 00:00:00` : v
        // An hour bucket walks a wall clock to the hour, everything else a date.
        if (intervalUnit === 'hour') {
          if (!timeZone) return new Date(ms).toISOString().slice(0, 13).replace('T', ' ') + ':00:00'
          const p = partsIn(ms, timeZone)
          const two = n => String(n).padStart(2, '0')
          return `${String(p.year).padStart(4, '0')}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:00:00`
        }
        return timeZone ? plainDateIn(ms, timeZone) : new Date(ms).toISOString().slice(0, 10)
      }
      // The CTE steps from a bucket's FIRST day. Stepped from the bound's own
      // day, '+1 month' from 31 January is 3 March and February never filled,
      // and a start later in its month than the end (the 15th, then the 10th)
      // stopped one bucket short. A week starts on its Monday or Sunday, which
      // is the label the data rows carry.
      const bucketStart = (d) => {
        if (intervalUnit === 'week') {
          const t = new Date(`${d}T00:00:00Z`)
          const back = (t.getUTCDay() + (weekStart === 'sunday' ? 0 : 6)) % 7
          return new Date(t.getTime() - back * 864e5).toISOString().slice(0, 10)
        }
        if (intervalUnit === 'month')   return `${d.slice(0, 7)}-01`
        if (intervalUnit === 'year')    return `${d.slice(0, 4)}-01-01`
        if (intervalUnit === 'quarter') return `${d.slice(0, 4)}-${String(Math.floor((Number(d.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0')}-01`
        return d
      }
      if (gapStart && gapEnd) {
        gapStart = bucketStart(gapDate(gapStart, 'start'))
        gapEnd   = bucketStart(gapDate(gapEnd, 'end'))
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
SELECT DISTINCT ${gapCols.join(', ')}
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
        for (const [key, val] of orderBy) {
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
      } else if (gapStart && gapEnd && intervalField) {
        // The gap rows and the data rows are two halves of a UNION ALL, so
        // unordered the series answers every filled bucket before any real one.
        sql += ` ORDER BY ${quoteIdent(intervalField)} ASC`
      }

      const page = pageSql(limit, offset)
      if (page) { sql += page.sql; params.push(...page.params) }

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
            if (agg === '_sum') exactSum('groupBy', field, out[agg][field])
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
    async create(args = {}) {
      const _cr = await prepareCreate(args)
      let { data } = _cr
      const { stamped, select, include, system, scopedBy } = _cr

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
      // The plan and its unit, synchronously: no await may sit between the
      // decision below and the statement, or a transaction can open in the gap
      // and the insert joins it.
      let plan
      const insertRow = (hasNested, edgeWrites, bare) => {
        plan = createPlan(data, { hasNested, edgeWrites, select, include, system, stamped, refusal: _cr.refusal, bare })
        return writeUnit(plan)
      }

      // One INSERT with no transaction open on this connection is already its
      // own unit — SQLite's autocommit — and nothing can open one before it
      // runs, because nothing between here and the statement yields. Taking the
      // lock, the async scope and a BEGIN/COMMIT for it cost a single-row create
      // 82% (`FJS-1106`). A @sequence bump, a nested write and an edge write are
      // further statements, so they keep the transaction.
      let _crOut
      const _crSplit = shape.sequences.length || _ranks.length ? null : extractNestedWrites(data)
      const _crEdges = _crSplit && !_crSplit.hasNested ? extractEdgeWrites(_crSplit.scalar) : null
      // A write that moves a count has to reach `commit`, which is where the
      // count is graded — the autocommit path never opens a transaction, so a
      // child inserted through it is never graded at all (`FJS-969`'s shape one
      // realm over: the fast paths are the ones a rule misses). Asked of the
      // MODEL, so a schema declaring no bound keeps the path (`FJS-1106`).
      if (_crEdges && !_crEdges.edgeWrites.length && tx.state.depth === 0 && !_cardNotes && !_exclNotes) {
        data   = _crEdges.data
        _crOut = insertRow(false, _crEdges.edgeWrites, true)
      } else {
        _crOut = await tx.exclusive(async () => {
          // The clock is read again now the lock is held: the stamp from
          // prepareCreate predates the wait (FJS-2153).
          data = restampClock(data, shape.generatedDefaults, stamped)
          // Apply @sequence fields — inject per-scope auto-incremented values.
          // Ahead of the split, because the split is what the INSERT is built
          // from: injecting a sequence into `data` after it has been taken apart
          // writes the row without the column.
          data = applySequences(data, modelName, shape.sequences, writeDb, stamped)
          data = applyRanks(data, stamped)
          // Split nested write ops from scalar fields
          const { scalar, nested, hasNested } = extractNestedWrites(data)
          const { data: _scalarNoEdge, edgeWrites } = extractEdgeWrites(scalar)
          // belongsTo ops first — injects FK values before insert
          const extraFKs = await processBelongsToNested(nested)
          data = { ..._scalarNoEdge, ...extraFKs }

          const inserted = insertRow(hasNested, edgeWrites, false)
          // `select: false` with nothing nested skips the RETURNING, so there is
          // no row to hang children on — and none were asked for.
          if (!inserted.row) return inserted
          const created = inserted.row
          // hasMany ops after — children need parent PK + parent row (for co-FK propagation)
          const pkField = shape.model.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
          await processHasManyNested(nested, created[pkField], created)
          applyEdgeWrites(edgeWrites, created[pkField], scopedBy)
          return hasNested || edgeWrites.length ? rehydrateAfterChildren(inserted) : inserted
        })
      }
      // ── Committed from here ──────────────────────────────────────────────
      return finishWrite(plan, _crOut)
    },

    // ── createMany ──────────────────────────────────────────────────────────
    async createMany(args = {}) {
      const prepared = await prepareCreateMany(args)
      if (!prepared) return { count: 0 }
      // The plan is built under the executor's own lock, because a @sequence
      // stamp is a write (see createManyPlan): the one verb that takes the
      // lock itself, and it runs the same unit the executor would.
      let plan
      const outcome = await tx.wrapExclusive(() => { plan = createManyPlan(prepared); return writeUnit(plan) })
      return finishWrite(plan, outcome)
    },

    // The rows the engine owns, written with no await anywhere: a SQL trail's
    // entries when the process is ending, where a `create`'s microtasks never
    // run and the row is lost (`FJS-3101`). No plugin, hook or value-set sees
    // them, and nothing is announced; the defaults, stamps and column
    // encoding are createMany's.
    appendSync(rows) {
      if (!rows?.length) return
      const plan = createManyPlan({ data: rows, system: true, hidden: rows.map(() => null), mode: 'collection', needRows: false })
      tx.wrap(() => writeUnit(plan))
    },

    // ── update ──────────────────────────────────────────────────────────────
    async update(args = {}) {
      const u = await prepareUpdate(args)
      let plan = null
      // The plan is built inside the unit — the before snapshot, the move's
      // grade and the sync merge are reads the statement must agree with —
      // and the hasMany and edge writes follow the row it reached.
      const body = async () => {
        plan = await u.plan(u.hasNested ? await processBelongsToNested(u.nested) : {})
        if (!plan) return null
        const pkField = shape.model.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
        // A model that seals is written children first: its own UPDATE may be
        // the move that seals them, and a child written after it is refused,
        // rolling the move back. A child still refused here is refused because
        // the document was ALREADY sealed.
        let childrenDone = false
        if (_sealSelf && u.hasNested && plan.reach) {
          const raw = plan.reach()
          if (raw) {
            await processHasManyNested(u.nested, raw[pkField], read(raw, { mode: 'single' }))
            childrenDone = true
          }
        }
        const outcome = writeUnit(plan)
        if (!outcome.row) return outcome
        if (!childrenDone) await processHasManyNested(u.nested, outcome.row[pkField], outcome.row)
        applyEdgeWrites(u.edgeWrites, outcome.row[pkField], u.scopedBy)
        return u.hasNested || u.edgeWrites.length ? rehydrateAfterChildren(outcome) : outcome
      }
      const out = u.ownUnit ? await body() : await tx.exclusive(body)
      // ── Committed from here ──────────────────────────────────────────────
      if (!out) return null
      return finishWrite(plan, out)
    },

    // ── updateMany ──────────────────────────────────────────────────────────
    async updateMany(args = {}) {
      return executeWrite(await planUpdateMany(args))
    },

    // ── upsert ──────────────────────────────────────────────────────────────
    async upsert(args = {}) {
      const { where, create: createData, update: updateData, include, select, system,
              withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf } = args
      const plan = await planUpsert(args)
      if (plan) {
        try {
          return await executeWrite(plan)
        } catch (e) {
          // A unique conflict on a DIFFERENT column than the ON CONFLICT target
          // can't be handled by this statement — fall through to the
          // read-then-write path, which preserves the original semantics. The
          // executor has already translated it, and `isUniqueConflict` answers
          // for the translated error too.
          if (!isUniqueConflict(e)) throw e
        }
      }
      // Threaded through to both halves: the lookup has to SEE the row the
      // update would write, or an upsert against an excluded row reads as
      // absent and tries to INSERT one that is already there.
      const _upFlags = { withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf }
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
          // A race leaves a row at `where`. No row there means the conflict is
          // on a column the where does not name, and the update would match
          // nothing and answer `null` having written nothing (FJS-2029).
          if (!await this.findFirst({ where, ..._upFlags })) throw e
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
      // No `update:` list sets every key the rows carry on a conflict.
      refuseSoftDeleteWrite(updateFields == null ? data?.find(d => d?.deletedAt !== undefined) : [updateFields].flat(), 'upsertMany')
      if (!data?.length) return { count: 0 }
      // Under row tenancy a `@unique` was built as (tenant, field) (`FJS-D310`),
      // so a target naming the field alone matches no index and SQLite refuses
      // it without naming the model or the column (`FJS-1918`). The target is
      // widened only when that scoped constraint exists, so a target the caller
      // already led with the tenant column, or one of a `@unique(global)`, is
      // taken as written.
      const target = (() => {
        const named = conflictTarget
          ? (Array.isArray(conflictTarget) ? conflictTarget : [conflictTarget])
          : [idField]
        const t = ctx.schema?.tenancy
        if (t?.strategy !== 'row' || named.includes(t.column)) return named
        const scoped = shape.model.attributes?.some(a =>
          (a.kind === 'uniqueIndex' || a.kind === 'partialUnique') && a.generated === 'tenancy' &&
          a.fields.length === named.length + 1 && a.fields[0] === t.column &&
          named.every((c, i) => a.fields[i + 1] === c))
        return scoped ? [t.column, ...named] : named
      })()
      refuseBulkNested(data, 'upsertMany')
      for (const row of data) extractWriteOps(row, { where: 'upsertMany' })
      refuseSystemEntries(system, ['create', 'update'])
      const { mode: _usMode, wantRows: _usWantRows } = announceFor(announce)
      // The create/update split costs one SELECT per row and is what a logged
      // model already pays for its trail. At the `rows` tier it is worth paying
      // again: the caller asked for precision, and knowing which half a row fell
      // in is the difference between announcing `create` and announcing `update`
      // — the compromise the collection form has to make and this one does not.
      // The conflict half's post-update rule reads the row as it is now, which
      // only RETURNING carries — updateMany's reason (FJS-1730).
      const _usPost = ctx.hasPolicies && !!shape.policy['postUpdate']
      const _usNeedRows = tableHasLogWork || _usWantRows || _usPost || !!plugins?.hearsWrites
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
              .filter(k => !target.includes(k))
        await plugins.beforeUpdate(modelName, { data: Object.fromEntries(_usKeys.map(k => [k, undefined])), system }, ctx)
      }
      await enforceValueSets(modelName, data, ctx)
      data = refuseOffEntry(data)
      const _usHidden = await hiddenParents(data, [], system)

      const autoId       = shape.autoId
      const genDefaults  = shape.generatedDefaults
      const authDefaults = shape.authDefaults
      const createdBys   = shape.createdBy
      const updatedBys   = shape.updatedBy
      const usVersion    = shape.version

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
      // What each logged row was given, aligned with the two lists above: the
      // bound row for an insert, the columns ON CONFLICT set for an update.
      let _usCreatedW = null, _usUpdatedW = null
      const _nt = needsTiming()
      const _usT0 = _nt ? performance.now() : 0
      // Whole batch (incl. @sequence bumps) inside one transaction — see createMany.
      // A key minted for the insert half is not the caller's, so a row that
      // conflicts keeps its own unless the conflict moves it to another scope.
      const _usRankMemo = _ranks.length ? new Map() : null
      const _usMinted   = []
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
          d = applyFieldRefDefaults(d, stamped)
          if (usVersion) { noteStamp(stamped, d, usVersion); d = { ...(d ?? {}), [usVersion]: 1 } }
          d = applySequences(d, modelName, shape.sequences, writeDb, stamped)
          d = applyRanks(d, stamped, _usRankMemo)
          _usMinted[i] = _ranks.filter(r => stamped.has(r.field))
          try { return writeData(d, { requireAll: true, system, stamped, creating: true }) }
          catch (e) { throw asBatchRowError(e, i, data.length, null) }
        })

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
          if (_usNeedRows) { _usCreated = []; _usUpdated = []; _usCreatedW = []; _usUpdatedW = [] }
        }

        // The INSERT half, refused whole like `createMany`'s — a batch is one
        // call, and half of it landing is a worse answer than none of it.
        if (ctx.hasPolicies) {
          for (const [i, row] of rows.entries()) {
            if (present.has(keyOf(row))) continue
            try { _usHidden[i] = firstRefusal(checkCreate(authStamped(data[i], modelName, ctx), _usHidden[i]), _usHidden[i]) }
            catch (e) { throw asBatchRowError(e, i, rows.length, data[i]) }
          }
        }

        // The UPDATE half rides SQLite's own `DO UPDATE … WHERE`, where an
        // unqualified column is the EXISTING row — which is exactly the row the
        // update policy is about, and the same predicate `updateMany` puts in
        // its WHERE. A row the policy excludes is skipped rather than refused,
        // for `updateMany`'s reason: a bulk write narrows, it does not throw.
        const _usUpdPolicy = ctx.hasPolicies
          ? buildPolicyFilter(modelName, 'update', ctx)
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
        const stmtFor = (cols, minted = []) => {
          const key = cols.join(' ') + (minted.length ? ' | ' + minted.map(r => r.field).join(' ') : '')
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

          // The SET speaks columns, as the INSERT above does: a field name on a
          // @map model is `no such column: excluded.<field>`.
          const _qt = quoteIdent(tableName)
          const _qc = (/** @type {string} */ c) => quoteIdent(col(c))
          const _mintedRank = c => minted.find(r => r.field === c)
          const _rankSet = (r) => {
            const same = r.scope.map(f => `${_qt}.${_qc(f)} IS excluded.${_qc(f)}`).join(' AND ')
            return `${_qc(r.field)} = CASE WHEN ${same} THEN ${_qt}.${_qc(r.field)} ELSE excluded.${_qc(r.field)} END`
          }
          // @version rides the INSERT at 1 and is BUMPED on conflict, never taken
          // from `excluded` — that would reset an existing row to 1 and make every
          // stale editor's version look current again.
          const setPairs = updateCols
            .filter(c => c !== usVersion)
            .map(c => _mintedRank(c) ? _rankSet(_mintedRank(c)) : `${_qc(c)} = excluded.${_qc(c)}`)
          if (usVersion) setPairs.push(`${_qc(usVersion)} = ${_qt}.${_qc(usVersion)} + 1`)
          // A conflict is an update, so it stamps. `setPairs.length` is what
          // decides whether this row updates at all, so the stamp is added
          // after that test and never turns a DO NOTHING into a DO UPDATE.
          if (setPairs.length) setPairs.push(...stampSets(updateCols))

          if (setPairs.length) {
            const conflictSql = target.map(_qc).join(', ')
            s += ` ON CONFLICT(${conflictSql}) DO UPDATE SET ${setPairs.join(', ')}`
            if (_usGuardSql) s += ` WHERE ${_usGuardSql}`
          } else {
            s += ` ON CONFLICT DO NOTHING`
          }

          // RETURNING on a logged model, so the entry names rows by their real id —
          // see createMany. ON CONFLICT DO NOTHING returns nothing for a skipped row.
          if (_usNeedRows) s += ` RETURNING *`
          entry = { cols, updateCols, sql: s, stmt: writeDb.prepare(s) }
          stmts.set(key, entry)
          return entry
        }

        for (const [_i, row] of rows.entries()) {
          if (_usHidden[_i]) throw asBatchRowError(_usHidden[_i], _i, rows.length, row)
          const { cols, updateCols, stmt } = stmtFor(Object.keys(row), _usMinted[_i])
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
              const _usUpd  = written && present.has(keyOf(row))
              if (written) {
                (_usUpd ? _usUpdated : _usCreated).push(written)
                ;(_usUpd ? _usUpdatedW : _usCreatedW).push(_usUpd ? Object.fromEntries(updateCols.map(c => [c, true])) : row)
              }
              else if (_usSeal || _usGuardSql) _usWrote = false
              // A later row repeating this key conflicts with the row just written.
              if (written) present.add(keyOf(row))
              // One refused row refuses the batch: the throw rolls the unit back.
              if (_usUpd && _usPost)
                checkPostUpdatePolicy(modelName, read(written, { mode: 'single', hydrateFrom: true }), ctx)
            } else {
              stmt.run(...args)
              if (_usSeal || _usGuardSql) _usWrote = rowsChanged(writeDb) > 0
            }
          } catch (e) { throw asBatchRowError(asConstraintError(e, row), _i, rows.length, row) }
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
            if (refusal) throw asBatchRowError(refusal, _i, rows.length, row)
          }
          if (_usWrote) { noteExclusion(row); count++ }
        }
        sql = [...stmts.values()].map(e => e.sql).join('\n')
      })
      fireQuery({ operation: 'upsertMany', args: { data, conflictTarget, update: updateFields }, sql, params: null, duration: _nt ? performance.now() - _usT0 : 0, rowCount: count })
      if (tableHasLogWork) {
        if (_usCreated?.length) emitLogs('create', _usCreated, { system, written: _usCreatedW })
        if (_usUpdated?.length) emitLogs('update', _usUpdated, { system, written: _usUpdatedW })
      }
      if (plugins?.hearsWrites && _usCreated) {
        for (const r of _usCreated) await plugins.afterWrite(modelName, 'create', read(r, { mode: 'single', hydrateFrom: true }), ctx)
        for (const r of _usUpdated) await plugins.afterWrite(modelName, 'update', read(r, { mode: 'single', hydrateFrom: true }), ctx)
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
        announceBulk({ mode: _usMode, event: 'update', operation: 'upsertMany', count, rows: _usCreated ? [..._usCreated, ..._usUpdated] : null })
      }
      return { count }
    },

    // ── remove ─────────────────────────────────────────────────────────────
    // The default removal operation — always does the right thing:
    //   soft-delete tables  → sets deletedAt = now() (+ cascades under @@softDelete(cascade))
    //   hard-delete tables  → real DELETE FROM
    // Use delete() only when you explicitly need to bypass soft delete.
    async remove(args = {}) {
      return executeWrite(await planRemove(args))
    },

    // ── removeMany ─────────────────────────────────────────────────────────
    async removeMany(args = {}) {
      return executeWrite(await planRemoveMany(args))
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
      const ext = shape.model.attributes?.find(a => a.kind === 'extensible')
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
      // Restore targets deleted rows: `onlyDeleted` is the verb's own mode,
      // not a caller flag.
      const { where: exclWhere, policy: restorePolicy } = visibleWhere('restore', where, { onlyDeleted: true })
      const baseWhereSql = buildWhereWithEncryption(exclWhere, params)
      if (!baseWhereSql) throw new Error(`restore on "${tableName}" requires a where clause`)
      const whereSql = restorePolicy ? `(${baseWhereSql}) AND (${restorePolicy.sql})` : baseWhereSql
      if (restorePolicy) params.push(...restorePolicy.params)
      // The children and the parent come back together, or neither does — the
      // walk below is many statements and used to be that many auto-commits
      // (`FJS-638`).
      let restored, trashed = null
      await tx.wrapExclusive(() => {
      // The stamp the restore clears is the one fact the trail's `before` needs
      // and RETURNING cannot carry.
      if (tableHasLogWork) trashed = readDb.query(`SELECT * FROM ${ident(tableName).sql} WHERE ${whereSql}`).all(...params)
      // If cascading, restore child tables too (reverse of delete cascade).
      // Only the children holding the ROOT'S stamp: remove() stamps every live
      // child with its own timestamp and leaves an already-deleted child with
      // an older one, so matching the stamp is what separates what this
      // cascade removed from what somebody deleted on its own (`FJS-1583`).
      // One walk per stamp, because `where` can match roots removed apart.
      // The roots come back before the walk: under a self-relation a root can
      // be another root's child, and restored by the walk first it would be
      // missing from the rows returned, logged and announced.
      const byStamp = new Map()
      if (softDeleteCascade && _cascadeTargets().length > 0) {
        for (const r of readDb.query(`SELECT * FROM "${tableName}" WHERE ${whereSql}`).all(...params)) {
          const stamp = r[col('deletedAt')]
          byStamp.set(stamp, [...(byStamp.get(stamp) ?? []), r])
        }
      }

      const _rsSets = [`"${col('deletedAt')}" = NULL`, ...stampSets(['deletedAt'])].join(', ')
      const _rsSql = `UPDATE "${tableName}" SET ${_rsSets} WHERE ${whereSql} RETURNING *`
      const _nt = needsTiming()
      const _rsT0 = _nt ? performance.now() : 0
      restored = writeDb.query(_rsSql).all(...params)
      for (const r of restored) { noteCardinality(read(r)); noteExclusion(read(r)) }
      fireQuery({ operation: 'restore', args: { where }, sql: _rsSql, params, duration: _nt ? performance.now() - _rsT0 : 0, rowCount: restored.length })

      for (const [stamp, rootRows] of byStamp) {
        walkCascade(rootRows, ({ childModel, childTable, foreignKeys, hardDelete }, keys) => {
          if (hardDelete) return null  // hard-deleted children are gone — cannot restore
          const binds = []
          const under = `${keyIn(foreignKeys.map(f => `"${f}"`), keys, binds)} AND "deletedAt" = ?`
          binds.push(stamp)
          // Read before the write: after it, the stamp that names them is gone.
          const childRows = cascadeChildRows(childModel, childTable, under, binds)
          writeDb.run(`UPDATE "${childTable}" SET "deletedAt" = NULL WHERE ${under}`, ...binds)
          return childRows
        })
      }
      })
      // Un-deleting is a write and belongs in the trail. It logs as 'update' —
      // the entry vocabulary is create|update|delete|read, and a restored row is
      // a row that changed state, not one that was created. One row carries its
      // images like any single-row write; many name their ids.
      if (tableHasLogWork && restored.length) {
        const written = [Object.fromEntries(['deletedAt', ..._stampCols].map(c => [c, null]))]
        const one = restored.length === 1 && trashed?.length === 1
        emitLogs('update', restored, one
          ? {
              before: trailImage(trashed[0], read(trashed[0], { mode: 'single' })),
              after:  trailImage(restored[0], read(restored[0], { mode: 'single' })),
              written,
            }
          : { written })
      }
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
      if (plugins?.hearsWrites) for (const r of restoredRows) await plugins.afterWrite(modelName, 'update', r, ctx)
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
      } = args

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

      const { where: htWhere, policy: policyResult } = visibleWhere('findManyCursor', where, args)
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
    //   query      the words to find — every one required, a "quoted phrase"
    //              kept whole; never FTS5 syntax (`ftsWords`, FJS-1440). Under
    //              trigram a word under three characters is found by a scan,
    //              unranked: a text of only such words has `_rank` null and
    //              comes back in row order (FJS-2332)
    //   prefix    the last word also matches as the start of a word
    //   raw        `query` is an FTS5 query, passed to MATCH as written
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
      raw         = false,
      prefix      = false,
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
      if (typeof query !== 'string') {
        throw new TypeError(`${modelName}.search(query) takes the words to find as a string, got ${query === null ? 'null' : typeof query}`)
      }
      if (raw && prefix) {
        throw new Error(`${modelName}.search(): prefix widens the last WORD, and a raw query is FTS5's own syntax — write its * instead`)
      }
      // Nothing left to find once the punctuation is gone — a lone `"` — answers
      // no rows; FTS5 would refuse the empty MATCH as a syntax error.
      const trigram = shape.model.attributes.find(a => a.kind === 'fts')?.tokenize === 'trigram'
      const words   = raw ? { match: query, scan: [] } : ftsWords(query, { prefix, trigram })
      if (words == null) return []

      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, { where, limit, offset }, ctx)

      const ftsTable = `${tableName}_fts`

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

      // The index mirrors the table, so soft-deleted, template and where-excluded
      // rows are in it and would otherwise spend slots the LIMIT below then
      // throws away — a search asking for 20 answering 13, with nothing to say
      // why. Narrowing here rather than after also makes `offset` mean pages of
      // matching rows rather than pages of index entries.
      //
      // The global filter, the plugin read filters and the row policy are part
      // of that narrowing, and were part of neither step: `findMany` answered
      // one row where `search` answered every row in the table, another owner's
      // and another tenant's included (FJS-262). Folded ONCE here and used by
      // both steps, so the two cannot drift.
      const { where: searchWhere, policy: searchPolicy } = visibleWhere('search', where,
        { withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf })

      const filterParams = []
      let   filterSql    = buildWhereWithEncryption(searchWhere, filterParams)
      if (searchPolicy) {
        filterSql = filterSql && filterSql !== '1=1'
          ? `(${filterSql}) AND (${searchPolicy.sql})`
          : searchPolicy.sql
        filterParams.push(...searchPolicy.params)
      }
      const filtered = !!filterSql && filterSql !== '1=1'

      // A word too short for a trigram is a GLOB over every indexed column
      // (`ftsWords`), required like any other word. The content table holds the
      // same columns under the same names, so a GLOB reads either.
      const globsOver  = (/** @type {string} */ table) => words.scan.map(() =>
        '(' + ftsFields.map(f => `${quoteIdent(table)}.${quoteIdent(col(f))} GLOB ?`).join(' OR ') + ')')
      const globParams = words.scan.flatMap(glob => ftsFields.map(() => glob))

      if (words.match != null) {
        ftsSql += ` FROM "${ftsTable}" WHERE ` + [`"${ftsTable}" MATCH ?`, ...globsOver(ftsTable)].join(' AND ')
        ftsParams.push(words.match, ...globParams)
        // Correlated on the hit's rowid, so the filter runs once per MATCH. As
        // `rowid IN (SELECT rowid FROM t WHERE …)` SQLite built the list of every
        // readable row and re-read it under the FTS scan: 300-800 ms for a
        // two-hop policy over 12k rows that matched one or eight (FJS-1692).
        if (filtered) {
          ftsSql += ` AND EXISTS (SELECT 1 FROM "${tableName}" WHERE "${tableName}".rowid = "${ftsTable}".rowid AND (${filterSql}))`
          ftsParams.push(...filterParams)
        }
      } else {
        // With no MATCH the GLOB is a scan, and the opposite holds: driven from
        // the index, every one of 113k entries ran the correlated filter to keep
        // an account's 4k (420 ms); driven from the table, the filter's own index
        // goes first (80 ms).
        const narrow = [...globsOver(tableName), ...(filtered ? [`(${filterSql})`] : [])].join(' AND ')
        ftsSql += ` FROM ${quoteIdent(ftsTable)} WHERE rowid IN (SELECT rowid FROM ${quoteIdent(tableName)} WHERE ${narrow})`
        ftsParams.push(...globParams, ...(filtered ? filterParams : []))
      }

      // A caller's order is applied in step 2, so this pass has to hand it the
      // WHOLE match set — a LIMIT here would page by relevance and then sort
      // the page, which is a different query and looks like a working one.
      const ordered = orderBy != null

      // Without a MATCH there is no BM25 and every rank is NULL, so the rowid is
      // what keeps a page from repeating or skipping a row.
      ftsSql += words.match != null ? ` ORDER BY rank` : ` ORDER BY rowid`

      if (!ordered) {
        const page = pageSql(limit, offset)
        if (page) { ftsSql += page.sql; ftsParams.push(...page.params) }
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

      // Build base query — the same fold as step 1, bound again
      const baseParams   = []
      let whereSql = buildWhereWithEncryption(searchWhere, baseParams)
      // The index is keyed on the source rowid, not `id` (a String id cannot be
      // an FTS5 rowid), so the hits are rejoined on rowid.
      const rowidBinds = []
      const rowidSql   = inList('rowid', rowids, rowidBinds)
      whereSql = whereSql && whereSql !== '1=1' ? `${rowidSql} AND (${whereSql})` : rowidSql
      baseParams.unshift(...rowidBinds)
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
        const orderSql = buildOrderBy(withRankTiebreak(orderBy), baseParams, columnMap, _pointMap, _vectorMap, _vectorFn(readDb))
        if (orderSql) baseSql += ` ORDER BY ${orderSql}`
        const page = pageSql(limit, offset)
        if (page) { baseSql += page.sql; baseParams.push(...page.params) }
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

    // ── the shared index's view of this model (FJS-D970) ───────────────────
    // The grade `$search` applies to a hit of this model: the same fold the
    // per-model search() runs, as a correlated EXISTS on `_search.rid`, so the
    // two cannot drift. Null when nothing narrows a read of this model.
    async [SEARCH_BRANCH]({ limit, offset } = {}) {
      if (!ftsFields) {
        throw new CapabilityNotDeclaredError(modelName, '$search', '@@fts',
          `Add @@fts([field1, field2]) and @@label(field) to ${modelName} to put it in the shared index.`)
      }
      if (plugins?.hasPlugins) await plugins.beforeRead(modelName, { limit, offset }, ctx)
      const { where: w, policy } = visibleWhere('search', undefined, {})
      const params = []
      let   filter = buildWhereWithEncryption(w, params)
      if (policy) {
        filter = filter && filter !== '1=1' ? `(${filter}) AND (${policy.sql})` : policy.sql
        params.push(...policy.params)
      }
      if (!filter || filter === '1=1') return { sql: null, params: [] }
      return {
        sql: `EXISTS (SELECT 1 FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(tableName)}.rowid = ${quoteIdent(SEARCH_TABLE)}.rid AND (${filter}))`,
        params,
      }
    },

    // The hits' rows, by rowid, graded again: step 1 already narrowed them, and
    // this is the half that returns values, so it must not be the one dropped.
    async [SEARCH_RESOLVE](rids) {
      const { where: w, policy } = visibleWhere('search', undefined, {})
      const params = []
      let   whereSql = buildWhereWithEncryption(w, params)
      const binds    = []
      const inSql    = inList('rowid', rids, binds)
      whereSql = whereSql && whereSql !== '1=1' ? `${inSql} AND (${whereSql})` : inSql
      params.unshift(...binds)
      if (policy) { whereSql = `(${whereSql}) AND (${policy.sql})`; params.push(...policy.params) }
      // Announced like any read: a telemetry count of one `$search` per
      // keystroke is otherwise one statement short per model hit.
      const sql  = `SELECT rowid AS __rid, * FROM ${quoteIdent(tableName)} WHERE ${whereSql}`
      const _nt  = needsTiming()
      const t0   = _nt ? performance.now() : 0
      const raw  = readDb.query(sql).all(...params)
      fireQuery({ operation: '$search', args: { rids }, sql, params, duration: _nt ? performance.now() - t0 : 0, rowCount: raw.length })
      const rows = readAll(raw)
      const pk       = shape.model.attributes.find(a => a.kind === 'id')?.fields
                    ?? [shape.model.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id']
      const identify = identifyingKeysFor(shape.model, ctx.schema)
      const out = new Map()
      for (const row of rows) {
        const rid = row.__rid
        delete row.__rid
        const id  = pk.length === 1 ? row[pk[0]] : Object.fromEntries(pk.map(k => [k, row[k]]))
        const sub = identify.map(k => row[k]).find(v => v != null) ?? null
        out.set(rid, { id, sub })
      }
      return out
    },

    // ── delete ──────────────────────────────────────────────────────────────
    async delete(args = {}) {
      return executeWrite(await planDelete(args))
    },

    // ── deleteMany ──────────────────────────────────────────────────────────
    async deleteMany(args = {}) {
      return executeWrite(await planDeleteMany(args))
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
      // A declared machine's move is named for its target, so the name IS the
      // value; whether the row's scope declares it is update()'s to answer.
      const declared = targetField ? null : Object.entries(_tableTransitions).find(([, s]) => s.declaredBy)
      if (declared) { targetField = declared[0]; targetValue = transitionName }
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

    // ── rebalance ───────────────────────────────────────────────────────────
    // Rewrite a @rank column's keys, evenly and all one width, keeping the
    // order: every drag into one gap adds about a fifth of a digit, so a spot
    // dropped onto a few hundred times outgrows any @length (`FJS-D366`).
    //
    // It is a read and one update per row the order changes, through this
    // accessor: the caller's policy decides which rows it reaches, each row is
    // announced as its own update, and @version bumps — a device holding the
    // old key loses its next drag of THAT row, which is the truth. `where`
    // may span scopes; each is spread on its own.
    async rebalance({ where, field } = {}) {
      if (!_ranks.length) throw new CapabilityNotDeclaredError(modelName, 'rebalance()', '@rank',
        'No field on this model declares @rank, so there is no order to rewrite.')
      const rank = field
        ? _ranks.find(r => r.field === field)
        : _ranks.length === 1 ? _ranks[0] : null
      if (!rank) throw new Error(field
        ? `${modelName}.rebalance: '${field}' is not a @rank field — this model ranks ${_ranks.map(r => `'${r.field}'`).join(', ')}`
        : `${modelName}.rebalance: this model ranks ${_ranks.map(r => `'${r.field}'`).join(' and ')} — name one: rebalance({ where, field })`)
      const keyCols = _keyCols()
      const rows = await this.findMany({
        where,
        select:  Object.fromEntries([...keyCols, ...rank.scope, rank.field].map(c => [c, true])),
        orderBy: [{ [rank.field]: 'asc' }],
      })
      const scopes = new Map()
      for (const row of rows) {
        const key = JSON.stringify(rank.scope.map(f => _rankBind(row[f])))
        if (!scopes.has(key)) scopes.set(key, [])
        scopes.get(key).push(row)
      }
      let count = 0
      await tx.exclusive(async () => {
        for (const list of scopes.values()) {
          const keys = rankSpread(list.length)
          for (const [i, row] of list.entries()) {
            if (row[rank.field] === keys[i]) continue
            await this.update({
              where: Object.fromEntries(keyCols.map(c => [c, row[c]])),
              data:  { [rank.field]: keys[i] },
              select: false,
              _bypassVersion: true,
            })
            count++
          }
        }
      })
      return { count }
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
      const decls = shape.commitments
      if (!decls) throw new CapabilityNotDeclaredError(modelName, 'due()', '@@commitment',
        'Nothing on this model is owed at a time, so no row can be due.')
      const chosen = transition == null ? decls : decls.filter(d => d.name === transition)
      if (!chosen.length) throw new ValidationError([{ path: ['transition'], message:
        `${modelName} owes no commitment named '${transition}' — declared: ${decls.map(d => d.name).join(', ')}` }])

      const at = by ?? nowISO(ctx.now)
      // Under row tenancy every tenant's rows share this table, so the sweep
      // has no tenant to fire in but the row's own; without it the fire's
      // principal holds no claim and the tenancy deny hides the row it moves.
      // A model scoped through its parent carries no column; its tenant is the
      // parent's, read along the relation its generated tenancy deny follows.
      const t = ctx.schema?.tenancy
      const tenantRel = tenantPath()?.map(hop => hop.field) ?? null
      const nest = (path) => path.length
        ? { [path[0]]: { select: nest(path.slice(1)) } }
        : { [t.column]: true }
      const graft = (into, from) => {
        for (const [k, v] of Object.entries(from)) {
          into[k] = into[k] && typeof v === 'object' && typeof into[k] === 'object'
            ? { select: graft({ ...into[k].select }, v.select) }
            : v
        }
        return into
      }
      const out = []
      for (const d of chosen) {
        const limit = readBy(d.kind, at, d.zone ? LATEST_DAY : timeZone)
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
          const w = compileStatic(d.while, modelName, ctx.schema, ctx.shapes)
          cond.push({ $raw: rawClause(w.sql, w.params) })
        }
        if (where) cond.push(where)
        const targetId = d.via
          ? ctx.models[d.target]?.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
          : idField
        const keep = [idField, d.on, ...(d.offset?.field ? [d.offset.field] : [])]
        const select = Object.fromEntries(keep.map(k => [k, true]))
        if (d.via) select[d.via] = { select: { [targetId]: true } }
        if (tenantRel) graft(select, nest(tenantRel))
        if (d.zone) graft(select, d.zone.length === 1
          ? { [d.zone[0]]: true }
          : { [d.zone[0]]: { select: { [d.zone[1]]: true } } })
        const rows = await this.findMany({ where: { AND: cond }, select })
        for (const row of rows) {
          // A row with no zone of its own is read in the call's.
          if (d.zone && dueAt(d, row) > readBy(d.kind, at, d.zone.reduce((v, k) => v?.[k], row) ?? timeZone)) continue
          out.push({
            transition: d.name,
            id:         row[idField],
            dueAt:      dueAt(d, row),
            ...(tenantRel ? { tenant: [...tenantRel, t.column].reduce((v, k) => v?.[k], row) ?? null } : {}),
            target:     { model: d.target, accessor: modelToAccessor(d.target), transition: d.transition,
                          id: d.via ? row[d.via][targetId] : row[idField] },
          })
        }
      }
      // Oldest due first, ties by transition then id: a sweep dispatches in
      // this order, and the query alone answers in whatever order the planner
      // walks. A day kind's `YYYY-MM-DD` sorts before any instant of that day.
      const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
      return out.sort((a, b) => cmp(String(a.dueAt), String(b.dueAt))
        || cmp(a.transition, b.transition) || cmp(a.id, b.id))
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
      const policies = ctx.hasPolicies ? shape.policy : null
      const admits   = (op, r) => {
        if (!policies?.[op]) return true
        try { return policyVerdict(modelName, r, ctx, op).ok }
        catch { return true }
      }

      let updateOk = null
      const postOk = new Map()

      const out = []
      for (const [fieldName, spec] of Object.entries(_tableTransitions)) {
        const currentValue = row[fieldName]
        if (currentValue == null) continue
        let moves = Object.entries(spec.transitions)
        if (spec.declaredBy) {
          const scopeValue = spec.scope in row ? row[spec.scope]
            : (await this.findUnique({ where: { [idField]: row[idField] }, select: { [spec.scope]: true } }))?.[spec.scope]
          moves = declaredTransitions(fieldName, scopeValue).filter(m => m.from != null)
            .map(m => [m.to, { from: [m.from], to: m.to, gate: m.gate, system: false }])
        }
        for (const [name, { from, to, gate, system }] of moves) {
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
            if (!postOk.has(to)) postOk.set(to, admits('postUpdate', { ...row, [fieldName]: to }))
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
export const CLIENT_OPTIONS = [
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
const FILE_WITHOUT_STORAGE_SAID = new Set()

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

  // Loaded only when there is something to parse: the browser worker is always
  // handed a parse, and the parser is the largest module it would otherwise
  // download on every page load (`FJS-2318`, graded in test/engine-seam.test.ts).
  const { parse, parseFile } = schemaPreParsed ? {} : await import('./parser.js')
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

  if (parseResult.files && !untrusted)
    await (await import('./watch.js')).watchSchemaFiles(parseResult.files)

  if (!parseResult.valid)
    throw new Error(`schema.lite has errors:\n${parseResult.errors.join('\n')}`)
  if (untrusted) refuseUntrustedSchema(parseResult.schema)

  // ── Build working schema ──────────────────────────────────────────────────
  // Start from the parsed schema, then augment with:
  //   • auto trail models (<dbName>Trail) for driver:trail databases in auto mode
  //   • view-as-model stubs so ctx.models[viewName] works inside makeTable
  const rawSchema     = parseResult.schema
  const autoLogModels = rawSchema.databases
    .filter(db => db.driver === 'trail' && !db.trailModel)
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
  if (!schema.databases.length && !dbPath && dbOverrides !== ':memory:') {
    throw new Error(
      `createClient() requires either:\n` +
      `  • database blocks in your schema.lite file, OR\n` +
      `  • a db path: createClient({ path: './schema.lite', db: './app.db' }), OR\n` +
      `  • databases: ':memory:'`
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
    if (conn.driver === 'jsonl' || conn.driver === 'trail') continue
    if (!conn.readDb || !conn.rawWriteDb) continue
    // Under the router, so the write handle a transaction reads through is
    // stamped too. `nowDate` is a later const and is called only at a statement.
    if (now) {
      conn.readDb  = clockedDb(conn.readDb,  () => nowDate())
      conn.writeDb = clockedDb(conn.writeDb, () => nowDate())
    }
    conn.readDb = makeReadRouter(conn.readDb, conn.writeDb, txState)
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
        // One transaction, as tenants.create() builds a file: autocommit is a
        // commit per statement, and a statement that throws would leave the
        // tables before it for the next boot to take as built.
        conn.rawWriteDb.run('BEGIN IMMEDIATE')
        try {
          for (const stmt of ddlMods.splitStatements(ddl)) {
            if (!stmt.startsWith('PRAGMA')) conn.rawWriteDb.run(stmt)
          }
          conn.rawWriteDb.run('COMMIT')
        } catch (err) {
          try { conn.rawWriteDb.run('ROLLBACK') } catch {}
          throw err
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
  //
  // The same loop refuses a view whose @@sql reads a protected column (FJS-D1047):
  // it runs for whoever the view's gate admits, and its columns take no attribute
  // to restate the protection on.
  for (const view of schema.views ?? []) {
    const read = viewProtectedRead(schema, view, pluralizeTableNames)
    if (read) throw new Error(
      `view ${view.name}: its @@sql ${read.star ? `selects * from '${read.table}', which holds` : 'names'} the protected column '${read.table}.${read.column}' ` +
      `(@guarded, @secret, @hashed or @encrypted), which a view's reader would get in plaintext or as ciphertext. ` +
      `Reading it is asSystem()'s: leave it out of the @@sql${read.star ? ', and name the columns instead of *' : ''}`)
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
  // Scans schema for @trail/@@trail attributes — used by makeTable to fire entries.
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

  // A swept row is a deleted row, and the plugins hear it the way they hear an
  // ORM delete: FileStorage releases the objects a File column held, which a
  // raw DELETE leaves in the store for ever (FJS-1921).
  // Rows are read only for a model whose deletes something hears — a plugin
  // that answers onAfterDelete, or a cascade child with a listener of its own.
  let _retentionStopped = false
  let _retentionDrain   = null
  const _retentionHears = model => pluginRunner.hearsDeletes || !!sharedCtx.cascadeSinkFor(model)?.cascadeHeard()
  async function _retentionRemoved(model, rows, doomed) {
    if (pluginRunner.hearsDeletes) await pluginRunner.afterDelete(model, rows, ctx)
    await sharedCtx.cascadeSinkFor(model)?.cascadeRemoved(doomed)
  }

  async function _runRetention({ jsonl = true, batches = Infinity } = {}) {
    const swept = []
    for (const [dbName, conn] of Object.entries(dbRegistry)) {
      if (!conn.retention && !conn.maxSize) continue

      if (conn.driver === 'sqlite' && conn.retention && conn.rawWriteDb) {
        const opts = {
          pluralize: pluralizeTableNames, now, batches,
          hears:       _retentionHears,
          onRemoved:   _retentionRemoved,
          doomedUnder: (model, rows) => sharedCtx.cascadeSinkFor(model)?.doomedUnder(rows),
          stopped:     () => _retentionStopped,
        }
        for (const r of await runSqliteRetention(conn.rawWriteDb, _retentionModels(dbName), conn.retention, opts))
          swept.push({ database: dbName, driver: 'sqlite', ...r })
        continue
      }

      // The jsonl half compacts inside `makeJsonlTable`, so the boot pass skips
      // it rather than doing it twice; a later `$retain()` has to do it here,
      // because nothing reopens those tables.
      if (jsonl && (conn.driver === 'jsonl' || conn.driver === 'trail')) {
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
  //     export default defineJob({
  //       cron: '0 4 * * *',
  //       handler: () => db.asSystem().$retain(),
  //     })
  //
  // `asSystem()` for raw SQL's reason (`FJS-D52`): it deletes rows through no
  // gate, no row policy and no `@@softDelete`, so the bypass is said at the call
  // site rather than assumed. Resolves to one row per table it touched, once
  // the plugins have released what the swept rows held.
  async function $retain() {
    // Stamped so *is the sweep running at all* is answerable. A retention job
    // that stopped firing removes nothing and reports nothing, which is the
    // same silence `FJS-327` and `FJS-328` were about one realm over.
    if (_retentionDrain) await _retentionDrain
    const out = await _runRetention()
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
  const rankMap        = buildRankMap(schema)
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
  const guardedMap     = buildGuardedMap(schema, relationMap)
  const fieldReadMap   = buildFieldReadMap(schema, relationMap)
  const valueSetMap    = buildValueSetMap(schema)

  // ── Shape: a model's facts in one record ──────────────────────────────────
  //
  // Every map above answers one question for every model, and a reader used to
  // ask it as `ctx.xMap?.[modelName]`: an entry the builder never wrote read as
  // *this model declares no such rule*, which is the silent direction — a
  // `@trail` keyed under a table name recorded nothing and said nothing. Here the
  // answers are gathered once per model into a frozen record with EVERY facet
  // present, so a reader asks `shape.x` with nothing optional-chained and
  // nothing defaulted at the read. A builder that answers for every model and
  // missed one, or wrote under a name that is not a model, is refused here,
  // before the client exists, rather than at a read nobody has made yet.
  //
  // `shape` is what the SCHEMA says about one model: built once, identical for
  // every flavor. What a flavor adds (`auth`, `isSystem`, the scope stack) and
  // what is schema-WIDE (`schema`, `typeMap`, the connections) stay on `ctx`.
  const modelNames = new Set(schema.models.map(m => m.name))
  const viewNames  = new Set((schema.views ?? []).map(v => v.name))
  // A map its builder fills for EVERY model — an absent entry is the builder's
  // defect, not an empty answer.
  const every = (map, name, facet) => {
    if (!Object.hasOwn(map, name)) throw new Error(`${name}: the schema pass behind '${facet}' answered nothing for this model`)
    return map[name]
  }
  // A map its builder fills only where the model declares something.
  const declared = (map, name, empty) => (Object.hasOwn(map, name) ? map[name] : empty)
  // Every key a builder wrote names a model, or it wrote under a spelling no
  // reader asks by and the declaration is silently inert.
  const keyedByModel = (map, facet, keyOf = (k) => k) => {
    for (const key of Object.keys(map)) {
      const name = keyOf(key)
      if (!modelNames.has(name)) throw new Error(`'${facet}' names '${name}', which is not a model of this schema`)
    }
  }
  for (const [facet, map] of Object.entries({
    jsonMap, generatedMap, computedSets, fromMap, relationMap, edgeMap, coFkMap, softDeleteMap, softDeleteCascadeMap,
    hasTemplatesMap, effectiveMap, commitmentMap, boolMap, affinityMap, bigMap, filterKindMap, autoIdMap,
    generatedDefaultMap, authDefaultMap, literalDefaultMap, fieldRefDefaultMap, updatedByMap, createdByMap,
    versionMap, syncMap, selfRelationMap, sequenceMap, rankMap, enumMap, transitionMap, sealMap, capabilityMap, ftsMap,
    validationMap, fieldPolicyMap, secretMap, policyMap, scopeMap, modelDbMap, valueSetMap,
    'cardinalityMap.byParent': cardinalityMap.byParent, 'cardinalityMap.byChild': cardinalityMap.byChild,
    'cardinalityMap.requiresChildren': cardinalityMap.requiresChildren, 'exclusionMap.byModel': exclusionMap.byModel,
    'logMap.models': logMap.models, 'guardedMap.own': guardedMap.own, 'fieldReadMap.own': fieldReadMap.own,
  })) keyedByModel(map, facet)
  keyedByModel(logMap.fields, 'logMap.fields', (k) => k.slice(0, k.indexOf('.')))

  // What a tenant read of a `@@tenant` view inlines (`FJS-D1149`): each
  // row-tenanted table on the view's database shadowed by the reader's rows,
  // then the view as `@@sql` over them. A table scoped through a parent keeps
  // the rows whose parent is in the parent's shadow; one naming no parent is
  // kept, so a shadow is never narrower than the tenancy deny under it, which
  // stays on the view as the backstop. A `@@materialized` view is a table, and
  // its rows were computed when it was refreshed.
  function tenantShadowsFor(name) {
    const view  = schema.views.find(v => v.name === name)
    const claim = view.attributes.find(a => a.kind === 'deny' && a.generated === 'tenancy')?.claim
    if (!claim || view.materialized) return null
    const dbOf  = (m) => modelDbMap[m] ?? 'main'
    const table = (m) => quoteIdent(modelToTableName(schema.models.find(x => x.name === m), pluralizeTableNames))
    const ctes  = []
    let binds   = 0
    const shadowed = new Set()
    const tables   = schema.models.filter(m => !viewNames.has(m.name) && dbOf(m.name) === (view.db ?? 'main'))
    for (const m of tables) {
      const deny = m.attributes.find(a => a.kind === 'deny' && a.generated === 'tenancy' && a.column)
      if (!deny) continue
      const col = columnMapFor(m)[deny.column] ?? deny.column
      ctes.push(`${table(m.name)} AS (SELECT * FROM main.${table(m.name)} WHERE ${quoteIdent(col)} = ?)`)
      binds++
      shadowed.add(m.name)
    }
    // Parent before child, since a CTE names only the ones before it.
    for (let grew = true; grew;) {
      grew = false
      for (const m of tables) {
        if (shadowed.has(m.name)) continue
        const hops = m.attributes
          .filter(a => a.generated === 'tenancy' && a.expr?.type === 'not' && a.expr.expr?.type === 'check')
          .map(a => relationMap[m.name]?.[a.expr.expr.field])
        if (!hops.length || !hops.every(r => r?.kind === 'belongsTo' && shadowed.has(r.targetModel))) continue
        const own  = columnMapFor(m), at = (r) => columnMapFor(schema.models.find(x => x.name === r.targetModel))
        const keep = hops.map(r =>
          `(${r.foreignKeys.map(k => `"__t".${quoteIdent(own[k] ?? k)} IS NULL`).join(' OR ')} OR EXISTS (SELECT 1 FROM ${table(r.targetModel)} AS "__p" WHERE ` +
          `${r.foreignKeys.map((k, i) => `"__p".${quoteIdent(at(r)[r.referencedKeys[i]] ?? r.referencedKeys[i])} = "__t".${quoteIdent(own[k] ?? k)}`).join(' AND ')}))`)
        ctes.push(`${table(m.name)} AS (SELECT "__t".* FROM main.${table(m.name)} AS "__t" WHERE ${keep.join(' AND ')})`)
        shadowed.add(m.name)
        grew = true
      }
    }
    if (!binds) return null
    ctes.push(`${quoteIdent(name)} AS (SELECT * FROM (${view.sql.trim().replace(/;$/, '')}))`)
    return Object.freeze({ claim, binds, ctes: ctes.join(', ') })
  }

  /** @returns {Shape} */
  function shapeFor(model) {
    const name = model.name
    const isView = viewNames.has(name)
    const fieldLogs = new Map()
    for (const [key, targets] of Object.entries(logMap.fields))
      if (key.startsWith(`${name}.`)) fieldLogs.set(key.slice(name.length + 1), targets)
    const policiedAggregates = new Set()
    for (const [field, def] of Object.entries(declared(fromMap, name, {})))
      if (aggModelsOf(def).some(m => policyMap[m]?.read)) policiedAggregates.add(field)
    return Object.freeze({
      modelName:         name,
      tableName:         isView ? name : modelToTableName(model, pluralizeTableNames),
      isView,
      model,
      db:                every(modelDbMap, name, 'modelDbMap'),
      columnMap:         columnMapFor(model),
      jsonFields:        every(jsonMap, name, 'jsonMap'),
      generatedFields:   every(generatedMap, name, 'generatedMap'),
      computedFields:    every(computedSets, name, 'computedSets'),
      boolFields:        every(boolMap, name, 'boolMap'),
      bigFields:         declared(bigMap, name, new Set()),
      enumFields:        every(enumMap, name, 'enumMap'),
      fieldKinds:        every(filterKindMap, name, 'filterKindMap'),
      affinity:          every(affinityMap, name, 'affinityMap'),
      softDelete:        every(softDeleteMap, name, 'softDeleteMap'),
      softDeleteCascade: every(softDeleteCascadeMap, name, 'softDeleteCascadeMap'),
      hasTemplates:      every(hasTemplatesMap, name, 'hasTemplatesMap'),
      effective:         every(effectiveMap, name, 'effectiveMap'),
      ftsFields:         every(ftsMap, name, 'ftsMap'),
      fieldPolicy:       every(fieldPolicyMap, name, 'fieldPolicyMap'),
      secrets:           declared(secretMap, name, {}),
      fromFields:        declared(fromMap, name, {}),
      relations:         every(relationMap, name, 'relationMap'),
      edges:             declared(edgeMap, name, {}),
      coFk:              declared(coFkMap, name, {}),
      autoId:            declared(autoIdMap, name, null),
      generatedDefaults: declared(generatedDefaultMap, name, []),
      authDefaults:      declared(authDefaultMap, name, []),
      literalDefaults:   declared(literalDefaultMap, name, []),
      fieldRefDefaults:  declared(fieldRefDefaultMap, name, []),
      createdBy:         declared(createdByMap, name, []),
      updatedBy:         declared(updatedByMap, name, []),
      version:           declared(versionMap, name, null),
      sync:              declared(syncMap, name, null),
      selfRelations:     declared(selfRelationMap, name, []),
      sequences:         declared(sequenceMap, name, []),
      ranks:             declared(rankMap, name, []),
      transitions:       declared(transitionMap, name, null),
      seal:              declared(sealMap, name, { self: null, parents: [] }),
      capabilities:      declared(capabilityMap, name, null),
      commitments:       every(commitmentMap, name, 'commitmentMap'),
      policy:            declared(policyMap, name, {}),
      scopes:            declared(scopeMap, name, {}),
      hasValidation:     every(validationMap, name, 'validationMap'),
      cardinality:       { byParent:         declared(cardinalityMap.byParent, name, []),
                           byChild:          declared(cardinalityMap.byChild, name, []),
                           requiresChildren: declared(cardinalityMap.requiresChildren, name, null) },
      exclusions:        declared(exclusionMap.byModel, name, []).flatMap(scope =>
                           exclusionMap.scopes[scope].members.filter(m => m.model === name).map(m => ({ scope, ...m }))),
      exclusionParents:  declared(exclusionMap.byParent, name, []),
      valueSets:         declared(valueSetMap, name, []),
      fieldLogs,
      modelLogs:         declared(logMap.models, name, null),
      guardedKeys:       every(guardedMap.own, name, 'guardedMap'),
      reachesGuarded:    guardedMap.reaches.has(name),
      fieldReadKeys:     every(fieldReadMap.own, name, 'fieldReadMap'),
      reachesFieldRead:  fieldReadMap.reaches.has(name),
      policiedAggregates,
      tenantShadows:     isView ? tenantShadowsFor(name) : null,
    })
  }
  /** @type {Record<string, Shape>} */
  const shapes = Object.freeze(Object.fromEntries(schema.models.map(m => [m.name, shapeFor(m)])))

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
    writer:    `${processId()}:${Math.random().toString(36).slice(2, 10)}`,
    recorders: {},
    watchers:  {},
    dbs:       crossProcessDbs,
  } : null

  if (crossProcess) {
    for (const [name, conn] of Object.entries(crossProcessDbs)) {
      ensureEventsTable(conn.rawWriteDb)
      crossProcess.recorders[name] = makeEventRecorder(conn.rawWriteDb, crossProcess.writer, nowDate)
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
  const poolDbs = new Set(schema.models
    .flatMap(m => m.attributes.filter(a => a.kind === 'extensible' && a.max))
    .map(a => modelDbMap[a.declaredBy] ?? 'main'))
  for (const dbName of poolDbs)
    dbRegistry[dbName]?.rawWriteDb?.run(`CREATE TABLE IF NOT EXISTS ${EXT_SLOTS} (
      model TEXT NOT NULL,
      tenant TEXT NOT NULL,
      scope TEXT NOT NULL,
      slot TEXT NOT NULL,
      PRIMARY KEY (model, tenant, scope, slot)
    )`)

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
        if (conn.driver === 'jsonl' || conn.driver === 'trail') return null
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
  //
  // A key is looked up by the accessor a model is read through (`post`), so one
  // that is no model's accessor — the plural, the PascalCase name, a typo — is
  // never looked up at all and the model it meant reads unfiltered.
  for (const [accessor, f] of Object.entries(globalFilters)) {
    const model = schema.models.find(m => modelToAccessor(m.name) === accessor)
    if (!model) {
      const near = schema.models.map(m => modelToAccessor(m.name)).find(a =>
        a.toLowerCase() === accessor.toLowerCase() || a.toLowerCase() + 's' === accessor.toLowerCase())
      throw new Error(
        `createClient: filters['${accessor}'] names no model — a global filter is keyed by the accessor ` +
        `a model is read through, so it would be ignored and every read of the model unfiltered` +
        (near ? `. Did you mean '${near}'?` : `. Accessors: ${schema.models.map(m => modelToAccessor(m.name)).sort().join(', ')}`))
    }
    if (typeof f === 'function' || !f || !model.fields) continue
    const keys = globalFilterKeysFor(model, shapes[model.name].edges)
    const [bad] = collectWhereKeyProblems(f, keys.filterable, keys.computed, keys.encrypted, [], null, keys.transient,
                                          null, '', 0, keys.opaque)
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
        if (op === 'postUpdate') {
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
          : `Point one side at the columns it needs — @@allow(${loop[0].op}, …) over ${back}'s own fields — ` +
            `so the pair has a direction.`))
    }

    for (const { model, op, field, target, targetOp, protectedBy } of gateOnly) {
      console.warn(
        `[litestone] ${model}: @@allow/@@deny(${op}, check(${field})) delegates to ${target}, whose protection for ` +
        `'${targetOp}' is ${protectedBy} and no row policy. Delegation compiles the TARGET'S POLICY only — a ` +
        `gate is enforced a tier above, where no compiled predicate can see it — so this rule places no ` +
        `restriction at all on ${model}. Give ${target} an @@allow(${targetOp}, …), or drop the check() and ` +
        `say what ${model} requires.`)
    }
  }

  // ── Default gate enforcement ──────────────────────────────────────────────
  // A model that declares @@gate gets enforcement even when the app installs
  // no GatePlugin — the declaration is the contract, and a declared gate that
  // silently does nothing is a fail-open security default. The shipped
  // FrontierGateGetLevel resolver is the default; installing your own
  // GatePlugin({ getLevel }) replaces it entirely. Once a schema declares any
  // access rule, a model with no @@gate and no policy is SYSTEM-only
  // (`FJS-D1206`), so any access declaration installs it too.
  //
  // A @@transitions clause carrying @gate(N) needs a level resolver for the
  // same reason, so it triggers the same auto-install — and so does a policy
  // reading `auth().level`, which without one is absent for every caller: an
  // allow on it never holds and a deny on it always fires (`FJS-D296`).
  let effectivePlugins = plugins ?? []
  const _anyGates = schema.models.some(m => m.attributes?.some(a =>
    a.kind === 'gate' ||
    (a.kind === 'transitions' && Object.values(a.transitions).some(t => t.gate != null))
  )) || authClaimsUsed(schema).has('level') || schemaDeclaresAccessRules(schema)
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

  // A File column with nothing to store it fails at the first upload
  // (`refuseFileWithoutStorage`); advise reads the schema alone and cannot know
  // the plugins, so the client is the first place both are in hand. A read-only
  // client never uploads, and a tenant registry builds one client per tenant,
  // so the notice is once per distinct set of columns (`FJS-2908`).
  if (!pluginRunner.handles('File') && !readOnly) {
    const unstored = schema.models.flatMap(m =>
      m.fields.filter(f => f.type?.name === 'File').map(f => `${m.name}.${f.name}`))
    const key = unstored.join(',')
    if (unstored.length && !FILE_WITHOUT_STORAGE_SAID.has(key)) {
      FILE_WITHOUT_STORAGE_SAID.add(key)
      console.warn(
        `[litestone] ${unstored.join(', ')} ${unstored.length > 1 ? 'are' : 'is a'} File column${unstored.length > 1 ? 's' : ''}, ` +
        `and this client installs no FileStorage, so the first upload is refused. ` +
        `Add FileStorage({ provider }) to createClient's plugins.`)
    }
  }

  // Shared context threaded through include resolution + table ops
  const ctx = {
    now,
    stampClock, _madeAt,
    // What the SCHEMA says about each model, one frozen record per model and
    // view (`shapeFor` above). A host-model fact is `shape.x` inside
    // `makeTable`; a resolver answering for ANOTHER model — an include, a
    // relation filter, a nested write — reads `ctx.shapes[target].x`, because
    // the identifier it writes belongs to the target (`FJS-761`).
    shapes,
    computedFns, tx,
    // Default: parent values silently overwrite any child-supplied co-FK
    // values during nested writes — this is the safe choice that prevents
    // referential drift like a child line item ending up with a different
    // tenantId than its parent order. Setting allowChildFkOverride:true flips
    // the policy so an explicit child value wins, but a missing one still
    // gets auto-filled.
    allowChildFkOverride: allowChildFkOverride === true,
    models:        modelIndex,
    schema,
    typeMap,
    enumTypeMap,
    extDeclarers,
    // Shared by reference: a scoped client is `{ ...ctx }`, and a cache each
    // copy created for itself was one the declaring table's write never cleared.
    extDecl:       new Map(),
    hasPolicies:   Object.keys(policyMap).length > 0,
    // Every verb's argument check reads it; scanned there, it is linear in the
    // model count per call. Shapes are frozen, so once is enough.
    hasPoliciedAggregates: Object.values(shapes).some(s => s.policiedAggregates.size > 0),
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
    isSystem:      false,
    hookRunner,
    emitter,
    globalFilters,
    plugins:       pluginRunner,
    auth:          null,
    readDb,
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
    pluralize:     pluralizeTableNames,   // used by makeTable to derive child SQL table names during cascades
    // Where a trail is written, by database name. TWO kinds, and the entry
    // carries which — `jsonl` is a directory of append-only jsonl, `sql` is an
    // ordinary table the app declared, which is the one a screen can read.
    trailDbMap:   Object.fromEntries(
      Object.entries(dbRegistry)
        .filter(([, v]) => v.driver === 'trail' || (v.driver !== 'jsonl' && v.trailModel))
        .map(([k, v]) => [k, { trailModel: v.trailModel, kind: v.driver === 'trail' ? 'jsonl' : 'sql' }])
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
    const dbName = shapes[model.name].db
    const conn   = dbRegistry[dbName] ?? dbRegistry.main
    if (conn.driver === 'jsonl' || conn.driver === 'trail') {
      const filePath = jsonlFilePath(conn.absPath, model.name)
      const table    = makeJsonlTable(filePath, model, schema, conn.retention, conn.maxSize, now, conn.busyTimeout, stampClock, conn.relative)
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

  // The jsonl table is one object shared by every flavor and by the trail's own
  // writes, so it grades nobody itself. A caller reaching a TRAIL through an
  // accessor is graded here as `makeTable` grades one, or the trail's `@@gate`
  // admits every caller to every tenant's before- and after-images (FJS-2139).
  // A `driver jsonl` model is refused a gate by the parser (FJS-1920) and is
  // left alone. The trail's writes take `ctx.jsonlTableCache` and never pass this.
  function withTrailPlugins(table, modelName, ctx) {
    if (!pluginRunner.hasPlugins) return table
    const out = { ...table }
    for (const key of ['findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow', 'count', 'findManyCursor'])
      out[key] = async (args = {}) => { await pluginRunner.beforeRead(modelName, args, ctx); return table[key](args) }
    for (const key of ['create', 'createMany'])
      out[key] = async (args = {}) => { await pluginRunner.beforeCreate(modelName, args, ctx); return table[key](args) }
    return out
  }

  // Per-model database routing. One call per model for the life of the client
  // since `FJS-722` — a flavor gets a wrapper, not a build.
  function buildTableForModel(model, ctx) {
    const conn      = dbRegistry[shapes[model.name].db] ?? dbRegistry.main

    if (conn.driver === 'jsonl' || conn.driver === 'trail') {
      const table = jsonlTableCache[model.name]
      return withArgValidation(conn.driver === 'trail' ? withTrailPlugins(table, model.name, ctx) : table, model, ctx)
    }
    return withArgValidation(makeTable(conn.readDb, conn.writeDb, shapes[model.name], ctx), model, ctx)
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
      if (conn.driver === 'jsonl' || conn.driver === 'trail') return null

      // A view's shape comes from the same builder as a model's, through the
      // view-as-model stub: every facet a projection cannot declare is its
      // empty value there, and a row policy on the view is real.
      const baseTable = makeTable(conn.readDb, conn.writeDb, shapes[view.name], ctx)

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
    // A symbol-keyed seam (`PLAN`) runs under the flavor too, or a `$setAuth`
    // client would plan as nobody; it stays off the enumerable keys.
    for (const sym of Object.getOwnPropertySymbols(table)) {
      const fn = table[sym]
      Object.defineProperty(out, sym, { value: typeof fn === 'function' ? (...args) => _flavor.run(flavor, () => fn.apply(table, args)) : fn, enumerable: false })
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

  // The boot pass waits for the plugins, since a swept row's files are theirs,
  // and for the tables: the cascade sinks it reads children through are theirs.
  // It takes one batch a table and drains a backlog after the client resolves,
  // since the first boot after a window is declared over a year of rows took
  // 22.8 minutes to listen, and a health-checked deploy rolls back long before
  // (FJS-2288).
  const _booted = await _runRetention({ jsonl: false, batches: 1 })
  if (_booted.some(r => r.removed >= RETENTION_BATCH))
    _retentionDrain = _runRetention({ jsonl: false })
      .catch(err => console.warn(`[litestone] retention: the sweep after startup stopped — ${err?.message ?? err}`))
      .finally(() => { _retentionDrain = null })

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

  // The `$`-introspection surface — one build over the root ctx, handed to every
  // proxy below. `$levelOfAs`/`$checkWriteAs` take the flavor's own ctx there.
  const {
    $checkWhere, $scopes, $checkOrderBy, $protectedFields, $primaryKey, $mirrorKey,
    $declaresAccessRules, $readAs, $inWindow, $readGrading, $readReach, $readColumns,
    $fromReach, $levelOfAs, $checkWriteAs, $capabilitiesFor, $claimsFor,
    accessorIndex, tenancyInfo,
  } = makeIntrospection(ctx, { schemaFilePath, asSystem })

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
  // actually holds — junction scopes `$.db` with $setAuth — threw the
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
  // Record something the audit trail cannot see for itself. `@@trail(audit)` is a
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
  // It THROWS, where @@trail(audit) is fire-and-forget, and that difference is the
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
    // The trail's `model` column is NOT NULL. Left to the row write, the refusal
    // reads as a validation failure on a column, and a caller that reports its
    // own audit failures as warnings (auth, mcp) loses a security event to noise.
    if (typeof entry.model !== 'string' || !entry.model)
      throw new Error(`$audit: 'model' is required — what '${entry.operation}' is about, e.g. 'User'. With no row, pass records: [].`)

    // Refused by name rather than dropped: a misspelled key is a caller that
    // meant to record something, and a silently thinner row is worse than none.
    for (const key of Object.keys(entry))
      if (!AUDIT_KEYS.includes(key))
        throw new Error(
          `$audit: unknown key '${key}'. Anything of your own belongs in 'meta'. ` +
          `Known keys: ${AUDIT_KEYS.join(', ')}.`)

    const loggers = Object.keys(ctx.trailDbMap ?? {})
    const dbName  = opts.database ?? loggers[0]

    if (!dbName)
      throw new Error(`$audit: no database in this schema declares an audit trail, so there is nowhere to write.`)
    if (!loggers.includes(dbName))
      throw new Error(`$audit: '${dbName}' is not a trail database. Declared: ${loggers.join(', ') || 'none'}.`)

    const target = ctx.trailDbMap[dbName]
    const table  = target.kind === 'sql'
      ? ctx.sqlLogTableFor(target.trailModel)
      : jsonlTableCache[target.trailModel ?? trailModelName(dbName)]
    if (!table) throw new Error(`$audit: the log table for '${dbName}' is not available.`)

    // The column holds the MODEL name for a @@trail write, so an event naming
    // the same model by its accessor or its table must land under it, or one
    // `where: { model }` matches half the trail and reads as *not logged*
    // (FJS-2380). A name that is no model (an extract's dataset) is kept.
    let model = entry.model
    if (typeof model === 'string' && !ctx.shapes[model]) {
      const named = Object.keys(ctx.shapes).find(n => modelToAccessor(n) === model || ctx.shapes[n].tableName === model)
      if (named) model = named
    }

    const built = buildLogEntry({ ...entry, model }, { ...ctx, auth: principal ?? ctx.auth }, ctx.onLog)

    // A STATED value wins over onLog's. onLog is a generic enricher that runs
    // over every entry; a $audit caller is naming this one event and knows more
    // about it than the enricher does. Same rule as sessionFields.
    if (entry.actorId   != null) built.actorId   = entry.actorId
    if (entry.actorType != null) built.actorType = entry.actorType
    if (entry.meta      != null) built.meta      = JSON.stringify(entry.meta)

    // An explicit event lines up with an @@anonymous row by clock exactly as a
    // @@trail entry does, and the trail is not rolled back with the transaction.
    if (tx.owns()) {
      const other = tx.noteWrite('$audit', false)
      if (other) throw new Error(
        `$audit: refused '${entry.operation}' in a transaction that also wrote ${other}. ${other} is @@anonymous, ` +
        `and an audit event beside it re-attributes the row by the trail's clock. Record the event without naming ` +
        `the respondent, or not at all (FJS-D349)`)
    }

    return await table.create({ data: trailRowValues(built) })
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
  // to bypass, so `db.sql` there is unchanged. The synthesized trail's gate is
  // not one: its rows are a jsonl file no SQL statement reaches.
  const _hasAccessRules = schemaDeclaresAccessRules({ models: schema.models.filter(m => !autoLogModels.includes(m)) })

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
    const query = _templateText(strings, values)
    // Leading comments are stripped before the test, so `-- why\nDELETE …`
    // still routes as a write rather than as an unrecognized statement.
    const head = query.replace(/^(?:\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, '')
    return _execRaw(query, values, runCtx, _RAW_READ.test(head) ? readDb : writeDb)
  }

  function _templateText(strings, values) {
    let query = ''
    for (let i = 0; i < strings.length; i++) {
      query += strings[i]
      if (i < values.length) query += '?'
    }
    return query.trim()
  }

  function _execRaw(query, values, runCtx, conn) {
    if (!queryTapped(runCtx)) return conn.query(query).all(...values)
    const t0 = performance.now()
    const rows = conn.query(query).all(...values)
    emitQuery(runCtx, null, 'main', { operation: 'sql', args: null, sql: query, params: values, duration: performance.now() - t0, rowCount: rows.length })
    return rows
  }

  // `sql.read`: the statement may not write, whatever its first word is. It runs
  // on the write connection with `query_only` ON, because the read connection is
  // the write one for `:memory:` and inside a transaction (which has to see its
  // own uncommitted rows), so "use the reader" would refuse nothing there. The
  // pragma is set and restored inside one synchronous call, so no other caller
  // can run while it is on. Takes a tagged template or `(text, params[])`.
  function _runRawRead(first, rest, runCtx) {
    const [query, values] = typeof first === 'string'
      ? [first.trim(), rest[0] ?? []]
      : [_templateText(first, rest), rest]
    writeDb.run('PRAGMA query_only = ON')
    try {
      return _execRaw(query, values, runCtx, writeDb)
    } catch (err) {
      if (/readonly/i.test(`${err?.code ?? ''} ${err?.message ?? ''}`))
        throw new Error('sql.read: this statement writes, and sql.read refuses a write. Use sql for a statement that changes data.', { cause: err })
      throw err
    } finally {
      writeDb.run('PRAGMA query_only = OFF')
    }
  }

  // `sql.read` is refused wherever `sql` is: it is raw SQL, so it applies no
  // access rule either. `surface` names the refusing entry point.
  function _withRead(fn, surface, runCtx = ctx) {
    fn.read = async (first, ...rest) => {
      if (surface && _hasAccessRules) throw rawSqlRefusal(`${surface}.read`)
      return _runRawRead(first, rest, runCtx)
    }
    return fn
  }

  async function sql(strings, ...values) {
    if (_hasAccessRules) throw rawSqlRefusal('db.sql')
    return _runRawSql(strings, values)
  }
  _withRead(sql, 'db.sql')


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

  // Is every SQLite connection this client holds answering? True or a throw --
  // a probe reads the throw as unwell, and a closed client says so in its own
  // words rather than as a false with no cause. The write handle is asked, since
  // a read handle can outlive a file the writer lost.
  function $ping() {
    for (const conn of Object.values(dbRegistry)) {
      if (conn.rawWriteDb) conn.rawWriteDb.query('SELECT 1').get()
    }
    return true
  }

  // The declared tables and columns the opened database does not hold -- a
  // model with no table, a table missing the model's columns. A client over the
  // wrong file starts and answers, and the first read of the model is the first
  // anyone hears (`FJS-1796`). Presence only; `migrate check` owns the rest.
  async function $schemaGaps() {
    const { schemaGaps } = await import('./schema-gaps.js')
    return schemaGaps({ schema }, dbRegistry, { pluralize: pluralizeTableNames })
  }

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

  // `{ takenAt }` when a database this client opened came out of a backup
  // (`FJS-D665`), otherwise null. A restore rewinds every row written after
  // `takenAt`, so a row older than it that records an unfinished handoff to
  // the outside world may already have been handed off. The latest stamp
  // across the client's databases answers, since a restore puts back the set.
  function $backupStamp() {
    let latest = null
    for (const conn of Object.values(dbRegistry)) {
      if (conn.driver !== 'sqlite' || !conn.rawWriteDb) continue
      const stamp = readBackupStamp(conn.rawWriteDb)
      if (stamp && (!latest || stamp.takenAt > latest.takenAt)) latest = stamp
    }
    return latest
  }

  // The operator has settled what the stamp was holding: the database is
  // nobody's backup any more, and a row older than the stamp is ordinary.
  function $clearBackupStamp() {
    for (const conn of Object.values(dbRegistry)) {
      if (conn.driver === 'sqlite' && conn.rawWriteDb) clearBackupStamp(conn.rawWriteDb)
    }
  }

  // `only` narrows to named databases. Without it a caller wanting ONE database
  // out of several had to open a client per database — and `createClient({ db })`
  // names MAIN, so each of those clients backed up main under a different
  // database's name. Asking here is the only way to ask truthfully.
  async function $backup(destPath, { vacuum = false, only = null } = {}) {
    const abs   = resolve(destPath)
    const names = only == null ? null : (Array.isArray(only) ? only : [only])

    // SQLite-only — backs up all open SQLite connections.
    // For a full backup including JSONL/trail databases, use: litestone backup
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
    // Attach on both connections so reads and writes can both access it. An
    // in-memory client has one connection for both, and a second ATTACH on it
    // fails with "database is already in use".
    rawWriteDb.prepare(`ATTACH DATABASE ? AS "${alias}"`).run(abs)
    if (rawReadDb !== rawWriteDb) rawReadDb.prepare(`ATTACH DATABASE ? AS "${alias}"`).run(abs)
    _attached.add(alias)
    return clientProxy  // chainable: await db.$attach('a.db', 'a').$attach('b.db', 'b')
  }

  function $detach(alias) {
    if (!_attached.has(alias)) {
      throw new Error(`alias "${alias}" is not attached`)
    }
    rawWriteDb.prepare(`DETACH DATABASE "${alias}"`).run()
    if (rawReadDb !== rawWriteDb) rawReadDb.prepare(`DETACH DATABASE "${alias}"`).run()
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
  // this file documented for the audit trail did not work, and a tenant claim
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
    _withRead(sysSql, null, sysCtx)

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

    const sysOwnProps = ['asSystem', '$close', '$schema', '$search', '$checkWhere', '$checkOrderBy', '$protectedFields', '$primaryKey', '$mirrorKey', '$declaresAccessRules', '$capabilitiesFor', '$claimsFor', '$readAs', '$checkWrite', '$readGrading', '$readReach', '$readColumns', '$inWindow', '$now', '$levelOf', '$softDelete', '$commitments', '$scopes', '$audit', '$enums', '$plugins', '$tenancy', '$retain']
    const proxy = _systemProxies.get(baseCtx) ?? new Proxy({ sql: sysSql, query: sysQuery, $transaction: (fn) => $transaction(fn, proxy), $search: (q, opts) => $searchWith(sysTables, q, opts), $backup, $walStatus, $backupStamp, $clearBackupStamp, $ping, $schemaGaps, $rotateKey, $attach, $detach, $db: rawWriteDb, $lock: lockPrimitive, $locks: lockPrimitive.$locks }, {
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
        if (prop === '$mirrorKey')  return $mirrorKey
        if (prop === '$declaresAccessRules') return $declaresAccessRules
      if (prop === '$capabilitiesFor') return $capabilitiesFor
      if (prop === '$claimsFor')       return $claimsFor
      if (prop === '$readAs')          return $readAs
      if (prop === '$levelOf')         return $levelOfAs(sysCtx)
      if (prop === '$checkWrite')      return $checkWriteAs(sysCtx)
      if (prop === '$inWindow')        return $inWindow
      if (prop === '$now')             return nowDate
      if (prop === '$readGrading')     return $readGrading
      if (prop === '$readReach')       return $readReach
      if (prop === '$readColumns')     return $readColumns
      if (prop === '$fromReach')       return $fromReach
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
    _withRead(authSql, 'db.$setAuth(user).sql', authCtx)

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

    const authOwnProps = ['$close', '$schema', '$auth', '$search', '$checkWhere', '$checkOrderBy', '$protectedFields', '$primaryKey', '$mirrorKey', '$declaresAccessRules', '$capabilitiesFor', '$claimsFor', '$readAs', '$checkWrite', '$readGrading', '$readReach', '$readColumns', '$inWindow', '$now', '$levelOf', '$softDelete', '$commitments', '$audit', '$cacheSize', '$enums', '$plugins', '$tenancy', '$retain']
    const authProxy = new Proxy({ sql: authSql, query: authQuery, $transaction: (fn) => $transaction(fn, _authProxyRef), $search: (q, opts) => $searchWith(authTables, q, opts), $backup, $walStatus, $backupStamp, $clearBackupStamp, $ping, $schemaGaps, $rotateKey, $attach, $detach, $db: rawWriteDb, $lock: lockPrimitive, $locks: lockPrimitive.$locks, asSystem: authAsSystem, $setAuth, $scopedBy: (b) => _makeScopedProxy({ scopedBy: b, auth: user }) }, {
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
        if (prop === '$mirrorKey')  return $mirrorKey
        if (prop === '$declaresAccessRules') return $declaresAccessRules
      if (prop === '$capabilitiesFor') return $capabilitiesFor
      if (prop === '$claimsFor')       return $claimsFor
      if (prop === '$readAs')          return $readAs
      if (prop === '$levelOf')         return $levelOfAs(authCtx)
      if (prop === '$checkWrite')      return $checkWriteAs(authCtx)
      if (prop === '$inWindow')        return $inWindow
      if (prop === '$now')             return nowDate
      if (prop === '$readGrading')     return $readGrading
      if (prop === '$readReach')       return $readReach
      if (prop === '$readColumns')     return $readColumns
      if (prop === '$fromReach')       return $fromReach
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

  // ── $search — one index across models, graded per model (FJS-D970) ────────
  //
  // One SQL over `_search`: MATCH, then a branch per model — `model = ?` AND
  // the model's own fold as an EXISTS — composed with OR before the LIMIT, so
  // the limit is spent only on rows the caller may read, and bm25 ranks every
  // model on one scale. Per-model indexes could do neither: the same text
  // scored differently on each, a ranked UNION leaked and rank-then-grade
  // starved (linear's Q4). `tablesOf` is the flavor's accessors, so the
  // branches are graded as the client the call was made on.
  const _searchAccessors = searchModels(schema).map(m => modelToAccessor(m.name))
  async function $searchWith(tablesOf, q, { models, limit = 20, offset = 0, prefix = false } = {}) {
    if (typeof q !== 'string') {
      throw new TypeError(`$search(query) takes the words to find as a string, got ${q === null ? 'null' : typeof q}`)
    }
    let chosen = _searchAccessors
    if (models != null) {
      if (!Array.isArray(models)) throw new TypeError(`$search: models names accessors as an array, got ${typeof models}`)
      for (const m of models) {
        if (!accessorIndex[m]) {
          throw new Error(`$search: '${m}' is not a model in this schema. Models in the shared index: ${_searchAccessors.join(', ') || '(none)'}`)
        }
      }
      chosen = [...new Set(models)]
    }
    if (!chosen.length) return []
    // Every model's words go through the index's own tokenizer: trigram, so a
    // word under three characters is a scan over title and body (FJS-2332).
    const words = ftsWords(q, { prefix, trigram: true })
    if (words == null) return []

    // A model whose gate or capability refuses the caller holds no hit for
    // them, as a row its policy hides holds none: refusing the whole call
    // would hide the models they may read too. Refused everywhere, the first
    // refusal stands, so a caller who may read nothing is told so by name.
    const branches = [], params = [], read = []
    let refused = null
    for (const acc of chosen) {
      let b
      try { b = await tablesOf[acc][SEARCH_BRANCH]({ limit, offset }) }
      catch (e) {
        if (!(e instanceof AccessDeniedError)) throw e
        refused ??= e
        continue
      }
      branches.push(b.sql ? `(model = ? AND ${b.sql})` : `model = ?`)
      params.push(acc, ...b.params)
      read.push(acc)
    }
    if (!branches.length) throw refused
    const globs      = words.scan.map(() => `(${quoteIdent(SEARCH_TABLE)}.title GLOB ? OR ${quoteIdent(SEARCH_TABLE)}.body GLOB ?)`)
    const globParams = words.scan.flatMap(g => [g, g])

    // The words are held to title and body, or a model's name would be a hit
    // on every one of its rows. The models read are narrowed inside the MATCH
    // too, so a small model skips the large ones' postings (FJS-2845). Under
    // trigram that narrowing is a substring test (`post` matches `postComment`)
    // and a name under three characters matches nothing, so `model = ?` in each
    // branch stays the exact test and a short name leaves the MATCH unnarrowed.
    const narrow   = read.length < _searchAccessors.length && read.every(a => [...a].length >= 3)
      ? `{model} : (${read.map(a => '"' + a + '"').join(' OR ')})` : null
    const terms    = words.match != null ? `{title body} : (${words.match})` : null
    const match    = [narrow, terms].filter(Boolean).join(' AND ') || null
    const matchSql = match ? ` ${quoteIdent(SEARCH_TABLE)} MATCH ?` : null

    const page = pageSql(limit, offset)
    let sql, binds
    if (terms != null) {
      sql = `SELECT model, rid, title, ${searchRankExpr()} AS rank, snippet(${quoteIdent(SEARCH_TABLE)}, 3, '<mark>', '</mark>', '…', 15) AS _snippet` +
            ` FROM ${quoteIdent(SEARCH_TABLE)} WHERE${matchSql}` +
            globs.map(g => ` AND ${g}`).join('') +
            ` AND (${branches.join(' OR ')}) ORDER BY rank, model, rid` + (page?.sql ?? '')
      binds = [match, ...globParams, ...params, ...(page?.params ?? [])]
    } else {
      // No words to rank, so no bm25: every rank is null and the hits come in
      // index order, after any ranked list a caller merges them with.
      sql = `SELECT model, rid, title, NULL AS rank, NULL AS _snippet FROM ${quoteIdent(SEARCH_TABLE)}` +
            ` WHERE${matchSql ? matchSql + ' AND' : ''} ${globs.join(' AND ')} AND (${branches.join(' OR ')}) ORDER BY model, rid` + (page?.sql ?? '')
      binds = [...(match ? [match] : []), ...globParams, ...params, ...(page?.params ?? [])]
    }

    const _nt = !!(ctx.onQuery || ctx._queryListeners.size)
    const t0  = _nt ? performance.now() : 0
    const hits = rawReadDb.query(sql).all(...binds)
    emitQuery(ctx, SEARCH_TABLE, 'main', { operation: '$search', args: { query: q, models: chosen, limit, offset }, sql, params: binds, duration: _nt ? performance.now() - t0 : 0, rowCount: hits.length })
    if (!hits.length) return []

    const byModel = new Map()
    for (const h of hits) (byModel.get(h.model) ?? byModel.set(h.model, []).get(h.model)).push(h.rid)
    const resolved = new Map()
    for (const [acc, rids] of byModel) resolved.set(acc, await tablesOf[acc][SEARCH_RESOLVE](rids))

    const out = []
    for (const h of hits) {
      const r = resolved.get(h.model)?.get(h.rid)
      if (!r) continue
      out.push({ model: h.model, id: r.id, title: h.title, sub: r.sub, _rank: h.rank, _snippet: h._snippet })
    }
    return out
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
    const scopedOwnProps = ['$close', '$schema', '$scope', '$auth', '$search', '$checkWhere', '$checkOrderBy', '$protectedFields', '$primaryKey', '$mirrorKey', '$declaresAccessRules', '$capabilitiesFor', '$claimsFor', '$readAs', '$checkWrite', '$readGrading', '$readReach', '$readColumns', '$inWindow', '$now', '$levelOf', '$softDelete', '$commitments', '$scopes', '$audit', '$enums', '$plugins', '$tenancy', '$retain']
    const target = {
      $scopedBy: (b) => _makeScopedProxy({ ...overrides, scopedBy: { ...(overrides.scopedBy ?? {}), ...(b ?? {}) } }),
      $setAuth:  (u) => _makeScopedProxy({ ...overrides, auth: u }),
      // Hands the callback THIS proxy — the dimension bindings and the auth on
      // it are what the body was asking for. See $transaction.
      $transaction: (fn) => $transaction(fn, scopedProxy),
      $search: (q, opts) => $searchWith(tables, q, opts),
      asSystem, $backup, $walStatus, $backupStamp, $clearBackupStamp, $ping, $schemaGaps, $rotateKey, $attach, $detach, $db: rawWriteDb,
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
        if (prop === '$mirrorKey')  return $mirrorKey
        if (prop === '$declaresAccessRules') return $declaresAccessRules
      if (prop === '$capabilitiesFor') return $capabilitiesFor
      if (prop === '$claimsFor')       return $claimsFor
      if (prop === '$readAs')          return $readAs
      if (prop === '$levelOf')         return $levelOfAs(sCtx)
      if (prop === '$checkWrite')      return $checkWriteAs(sCtx)
      if (prop === '$inWindow')        return $inWindow
      if (prop === '$now')             return nowDate
      if (prop === '$readGrading')     return $readGrading
      if (prop === '$readReach')       return $readReach
      if (prop === '$readColumns')     return $readColumns
      if (prop === '$fromReach')       return $fromReach
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
        .filter(m => names.includes(shapes[m].db))
      cp.watchers[name] = createEventWatcher({
        db:     conn.rawWriteDb,
        file:   conn.absPath,
        writer: cp.writer,
        now:    nowDate,
        // Serialized, in arrival order. Each delivery re-reads its row, so
        // firing them off in parallel lets a later event's read finish first
        // and a subscriber sees a create after the remove that undid it —
        // measured, and the order is the one thing a tether cannot repair.
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

  // Synchronous unless a trail write is still in flight: a SQL trail's INSERT
  // runs through the table pipeline and lands microtasks after it starts, so
  // closing first would arm the closed-client throw under it (`FJS-2914`). Then
  // it returns a promise a caller may await.
  function _closeAll() {
    _retentionStopped = true
    const draining = drainPendingLogs()   // a queued audit line lands before its table closes
    return draining ? draining.then(_teardown) : _teardown()
  }

  function _teardown() {
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
    // After the tables: an open appender or index db would be writing into it.
    for (const conn of Object.values(dbRegistry)) {
      if (conn.ownedDir) try { rmSync(conn.absPath, { recursive: true, force: true }) } catch {}
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

  const rootOwnProps = ['$close', '$attached', '$schema', '$search', '$relations', '$checkWhere', '$checkOrderBy', '$protectedFields', '$primaryKey', '$mirrorKey', '$declaresAccessRules', '$capabilitiesFor', '$claimsFor', '$readAs', '$checkWrite', '$readGrading', '$readReach', '$readColumns', '$inWindow', '$now', '$levelOf', '$scopes', '$audit', '$softDelete', '$commitments', '$cacheSize', '$config', '$databases', '$rawDbs', '$tapQuery', '$tapEvents', '$logContext', '$madeAt', '$logStats', '$enums', '$plugins', '$tenancy', '$setAuth', '$scopedBy', '$lock', '$locks', '$db', '$retain', '$inTransaction']
  clientProxy = new Proxy({ sql, query, $transaction, $search: (q, opts) => $searchWith(scopedTables, q, opts), $backup, $walStatus, $backupStamp, $clearBackupStamp, $ping, $schemaGaps, $rotateKey, $attach, $detach, $db: rawWriteDb, asSystem, $setAuth }, {
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
      if (prop === '$mirrorKey')      return $mirrorKey
      if (prop === '$declaresAccessRules') return $declaresAccessRules
      if (prop === '$capabilitiesFor') return $capabilitiesFor
      if (prop === '$claimsFor')       return $claimsFor
      if (prop === '$readAs')          return $readAs
      if (prop === '$levelOf')         return $levelOfAs(ctx)
      if (prop === '$checkWrite')      return $checkWriteAs(ctx)
      if (prop === '$inWindow')        return $inWindow
      if (prop === '$now')             return nowDate
      if (prop === '$readGrading')     return $readGrading
      if (prop === '$readReach')       return $readReach
      if (prop === '$readColumns')     return $readColumns
      if (prop === '$fromReach')       return $fromReach
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
      if (prop === '$databases')      return Object.fromEntries(Object.entries(dbRegistry).map(([k, v]) => [k, { driver: v.driver, access: v.access, path: v.absPath, trailModel: v.trailModel }]))
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
